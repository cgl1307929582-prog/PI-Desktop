import {
  RACP_HOSTLINK_LIMITS,
  RACP_HOSTLINK_PROTOCOL,
  parseHostLinkRelayFrame,
  type HostLinkHostFrame,
  type PushEnvironment,
  type PushNotification,
  type RelayRouteContext,
} from "@pi-desktop/shared";

import type { DeviceTokenAuthenticator } from "./auth.js";
import type { RacpServer, ServerConnectionTransport } from "./server.js";

/**
 * One open Host link socket: what `ws` (or a test pair) provides once the
 * authenticated upgrade to `/v1/hostlink` succeeded.
 */
export interface HostLinkSocket {
  send(frame: string): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (frame: string) => void): void;
  onClose(handler: (info: { code: number; reason: string }) => void): void;
}

/** Opens the Host link; rejects with an error carrying `errorCode` when it cannot. */
export type HostLinkConnector = () => Promise<HostLinkSocket>;

export interface HostLinkTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type HostLinkState = "stopped" | "connecting" | "connected" | "reconnecting";

export type HostLinkCoreOptions = {
  hostId: string;
  server: RacpServer;
  authenticator: DeviceTokenAuthenticator;
  connect: HostLinkConnector;
  timers?: HostLinkTimers;
  /** Uniform in [0, 1); injected for deterministic jitter in tests. */
  random?: () => number;
  onStateChange?: (state: HostLinkState, errorCode?: string) => void;
  onPushResult?: (deviceId: string, status: "sent" | "invalid-token" | "failed") => void;
  /** Logical phone connections opened or closed. */
  onConnectionsChanged?: () => void;
  log: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
};

const systemTimers: HostLinkTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Frames buffered for a logical connection while its credential is being checked. */
const MAX_PENDING_FRAMES = 64;

/** Exponential backoff from 1 s to 60 s with "equal jitter" (profile §4 rule 6). */
export function hostLinkBackoffMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(
    RACP_HOSTLINK_LIMITS.reconnectMaxDelayMs,
    RACP_HOSTLINK_LIMITS.reconnectBaseDelayMs * 2 ** Math.min(attempt, 16),
  );
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

type LogicalConnection = {
  id: string;
  generation: number;
  state: "authenticating" | "open" | "closed";
  pending: string[];
  deviceId?: string;
  messageHandler?: (frame: string, byteLength: number) => void;
  closeHandler?: () => void;
};

function errorCodeOf(error: unknown): string {
  const code = (error as { errorCode?: unknown })?.errorCode;
  return typeof code === "string" && code ? code : "REMOTE_CONNECTION_FAILED";
}

/**
 * The desktop side of `racp-hostlink.v1` (D663, profile §4). It keeps one
 * outbound link to the user's relay alive and turns every relayed phone
 * connection into an ordinary `RacpServer` connection over an in-memory
 * logical transport, so session, turn, approval, and replay semantics are the
 * same as on the SSH tunnel. Authentication is the Host's: the presented
 * bearer is resolved by the device-token authenticator on the mobile profile.
 *
 * Loss of the link closes every logical connection (the server releases
 * their subscriptions) and never touches a running turn; the client resumes
 * from its durable cursor after the link returns.
 */
export class HostLinkCore {
  private stateValue: HostLinkState = "stopped";
  private socket: HostLinkSocket | null = null;
  private generation = 0;
  private attempt = 0;
  private reconnectTimer: unknown = null;
  private pingTimer: unknown = null;
  private missedPongs = 0;
  private lastErrorCode: string | undefined;
  private devicesDirty = false;
  private readonly logical = new Map<string, LogicalConnection>();
  private readonly timers: HostLinkTimers;
  private readonly random: () => number;
  private readonly unsubscribeCredentials: () => void;

  constructor(private readonly options: HostLinkCoreOptions) {
    this.timers = options.timers ?? systemTimers;
    this.random = options.random ?? Math.random;
    this.unsubscribeCredentials = options.authenticator.onCredentialsChanged(() => this.scheduleDevicesPublish());
  }

  get state(): HostLinkState {
    return this.stateValue;
  }

  get errorCode(): string | undefined {
    return this.lastErrorCode;
  }

  logicalConnectionCount(): number {
    let count = 0;
    for (const connection of this.logical.values()) if (connection.state === "open") count += 1;
    return count;
  }

  /** Begin (or keep) the link. Idempotent. */
  start(): void {
    if (this.stateValue !== "stopped") return;
    this.attempt = 0;
    void this.open();
  }

  /** Close the link and every logical connection; cancel every timer. */
  stop(): void {
    this.generation += 1;
    this.clearTimers();
    this.closeAllLogical();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close(1000, "host stopping");
      } catch (error) {
        this.options.log("warn", "host link close failed", { error: String(error) });
      }
    }
    this.setState("stopped");
  }

  /** Permanently release the credential observer. */
  dispose(): void {
    this.stop();
    this.unsubscribeCredentials();
  }

  /** Revoke a phone: credential, live connections, and the relay mirror. */
  async revokeDevice(deviceId: string): Promise<boolean> {
    const revoked = await this.options.authenticator.revoke(deviceId);
    this.options.server.closeDevice(deviceId);
    this.options.onConnectionsChanged?.();
    return revoked;
  }

  /** Send a redacted push to the relay; false when the link is down. */
  sendPush(deviceIds: string[], notification: PushNotification): boolean {
    if (deviceIds.length === 0) return false;
    return this.sendFrame({ link: RACP_HOSTLINK_PROTOCOL, type: "push.notify", deviceIds, notification });
  }

  registerPush(deviceId: string, apnsToken: string, environment: PushEnvironment): boolean {
    return this.sendFrame({ link: RACP_HOSTLINK_PROTOCOL, type: "push.register", deviceId, apnsToken, environment });
  }

  unregisterPush(deviceId: string): boolean {
    return this.sendFrame({ link: RACP_HOSTLINK_PROTOCOL, type: "push.unregister", deviceId });
  }

  /** Push the active credential hashes now (profile §4 rule 2). */
  async publishDevices(): Promise<void> {
    if (this.stateValue !== "connected") return;
    const generation = this.generation;
    const hashes = await this.options.authenticator.activeHashes("mobile");
    if (generation !== this.generation) return;
    this.sendFrame({ link: RACP_HOSTLINK_PROTOCOL, type: "host.devices", ...hashes });
  }

  private scheduleDevicesPublish(): void {
    if (this.devicesDirty) return;
    this.devicesDirty = true;
    queueMicrotask(() => {
      this.devicesDirty = false;
      void this.publishDevices().catch((error: unknown) => {
        this.options.log("warn", "host link device mirror failed", { error: String(error) });
      });
    });
  }

  private setState(state: HostLinkState, errorCode?: string): void {
    if (errorCode !== undefined) this.lastErrorCode = errorCode;
    if (state === "connected") this.lastErrorCode = undefined;
    if (this.stateValue === state && errorCode === undefined) return;
    this.stateValue = state;
    this.options.onStateChange?.(state, this.lastErrorCode);
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer);
    if (this.pingTimer !== null) this.timers.clearTimeout(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
  }

  private async open(): Promise<void> {
    const generation = ++this.generation;
    this.setState(this.attempt === 0 ? "connecting" : "reconnecting");
    let socket: HostLinkSocket;
    try {
      socket = await this.options.connect();
    } catch (error) {
      if (generation !== this.generation) return;
      const code = errorCodeOf(error);
      this.options.log("warn", "host link connect failed", { errorCode: code, attempt: this.attempt });
      this.scheduleReconnect(code);
      return;
    }
    if (generation !== this.generation) {
      // Stopped (or restarted) while the upgrade was in flight.
      socket.close(1000, "superseded");
      return;
    }
    this.socket = socket;
    this.attempt = 0;
    this.missedPongs = 0;
    socket.onMessage((frame) => {
      if (generation === this.generation) this.handleFrame(frame, generation);
    });
    socket.onClose((info) => {
      if (generation !== this.generation) return;
      this.handleLinkLoss(`closed ${info.code}`);
    });
    this.setState("connected");
    this.options.log("info", "host link connected", { hostId: this.options.hostId });
    this.schedulePing(generation);
    await this.publishDevices().catch((error: unknown) => {
      this.options.log("warn", "host link device mirror failed", { error: String(error) });
    });
  }

  private scheduleReconnect(errorCode: string): void {
    const delay = hostLinkBackoffMs(this.attempt, this.random);
    this.attempt += 1;
    this.setState("reconnecting", errorCode);
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      void this.open();
    }, delay);
  }

  private handleLinkLoss(reason: string): void {
    this.generation += 1;
    this.clearTimers();
    this.closeAllLogical();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close(4000, "link lost");
      } catch {
        // The socket is already gone; nothing else owns it.
      }
    }
    this.options.log("warn", "host link lost", { reason });
    this.scheduleReconnect("HOST_DISCONNECTED");
  }

  private schedulePing(generation: number): void {
    this.pingTimer = this.timers.setTimeout(() => {
      this.pingTimer = null;
      if (generation !== this.generation) return;
      if (this.missedPongs >= RACP_HOSTLINK_LIMITS.maxMissedPongs) {
        this.handleLinkLoss("ping timeout");
        return;
      }
      this.missedPongs += 1;
      this.sendFrame({ link: RACP_HOSTLINK_PROTOCOL, type: "link.ping", at: Date.now() });
      this.schedulePing(generation);
    }, RACP_HOSTLINK_LIMITS.pingIntervalMs);
  }

  private sendFrame(frame: HostLinkHostFrame): boolean {
    const socket = this.socket;
    if (!socket || this.stateValue !== "connected") return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch (error) {
      this.options.log("warn", "host link send failed", { type: frame.type, error: String(error) });
      return false;
    }
  }

  private handleFrame(raw: string, generation: number): void {
    const frame = parseHostLinkRelayFrame(raw);
    if (!frame) {
      this.options.log("warn", "host link frame refused", { bytes: raw.length });
      return;
    }
    switch (frame.type) {
      case "link.pong":
        this.missedPongs = 0;
        return;
      case "client.open":
        void this.openLogical(frame.clientConnectionId, frame.routeContext, generation);
        return;
      case "client.message": {
        const connection = this.logical.get(frame.clientConnectionId);
        if (!connection || connection.state === "closed") return;
        if (connection.state === "authenticating") {
          if (connection.pending.length >= MAX_PENDING_FRAMES) {
            this.closeLogical(connection, "CLIENT_TOO_SLOW", true);
            return;
          }
          connection.pending.push(frame.message);
          return;
        }
        connection.messageHandler?.(frame.message, Buffer.byteLength(frame.message, "utf8"));
        return;
      }
      case "client.close": {
        const connection = this.logical.get(frame.clientConnectionId);
        if (connection) this.closeLogical(connection, "closed", false);
        return;
      }
      case "push.result":
        this.options.onPushResult?.(frame.deviceId, frame.status);
        return;
    }
  }

  private async openLogical(id: string, route: RelayRouteContext, generation: number): Promise<void> {
    if (this.logical.has(id)) {
      this.sendFrame({ link: RACP_HOSTLINK_PROTOCOL, type: "host.close", clientConnectionId: id, code: "CONFLICT" });
      return;
    }
    const connection: LogicalConnection = { id, generation, state: "authenticating", pending: [] };
    this.logical.set(id, connection);
    if (route.hostId !== this.options.hostId || route.clientConnectionId !== id) {
      this.closeLogical(connection, "REMOTE_AUTH_FAILED", true);
      return;
    }
    let auth: Awaited<ReturnType<DeviceTokenAuthenticator["authenticate"]>>;
    try {
      auth = await this.options.authenticator.authenticate({
        authorization: `Bearer ${route.presentedToken}`,
        urlHasToken: false,
        connectionId: id,
        profile: "mobile",
      });
    } catch (error) {
      this.options.log("error", "host link authentication failed", { error: String(error) });
      auth = null;
    }
    // The link may have dropped, or the relay closed the phone, while we checked.
    if (generation !== this.generation || connection.state === "closed") return;
    if (!auth) {
      this.options.log("warn", "relayed connection refused", { clientConnectionId: id });
      this.closeLogical(connection, "REMOTE_AUTH_FAILED", true);
      return;
    }
    const transport: ServerConnectionTransport = {
      send: (frame) => {
        if (connection.state !== "open" || generation !== this.generation) throw new Error("logical connection closed");
        this.sendFrame({ link: RACP_HOSTLINK_PROTOCOL, type: "host.message", clientConnectionId: id, message: frame });
      },
      close: (code, reason) => {
        if (connection.state === "closed") return;
        this.closeLogical(connection, reason || String(code), true);
      },
      onMessage: (handler) => {
        connection.messageHandler = handler;
      },
      onClose: (handler) => {
        connection.closeHandler = handler;
      },
    };
    connection.state = "open";
    if (auth.kind === "device") connection.deviceId = auth.device.deviceId;
    const accepted = this.options.server.accept(auth, transport);
    if (!accepted) {
      // The server already closed the transport (client limit or closing).
      return;
    }
    for (const frame of connection.pending.splice(0)) {
      connection.messageHandler?.(frame, Buffer.byteLength(frame, "utf8"));
    }
    this.options.onConnectionsChanged?.();
  }

  /**
   * End one logical connection. `notifyRelay` sends `host.close` so the relay
   * closes the phone socket; a relay-initiated close does not echo.
   */
  private closeLogical(connection: LogicalConnection, code: string, notifyRelay: boolean): void {
    if (connection.state === "closed") return;
    const wasOpen = connection.state === "open";
    connection.state = "closed";
    connection.pending.length = 0;
    this.logical.delete(connection.id);
    if (notifyRelay && connection.generation === this.generation) {
      this.sendFrame({ link: RACP_HOSTLINK_PROTOCOL, type: "host.close", clientConnectionId: connection.id, code: code.slice(0, 64) });
    }
    connection.closeHandler?.();
    if (wasOpen) this.options.onConnectionsChanged?.();
  }

  private closeAllLogical(): void {
    for (const connection of [...this.logical.values()]) this.closeLogical(connection, "HOST_DISCONNECTED", false);
  }
}
