/**
 * Mobile access (D663 / ADR 0331): the desktop as Agent Host for phones that
 * reach it through the user's self-hosted relay.
 *
 * Composition only — the RACP server runs over the existing Agent Host module
 * (no second execution path), `HostLinkCore` owns the outbound link, and the
 * push notifier observes durable events. Off by default: while disabled or
 * not enrolled, nothing connects anywhere.
 */
import type { AgentHost } from "@pi-desktop/agent-host";
import type { HostRpc } from "@pi-desktop/host-runtime";
import {
  DeviceTokenAuthenticator,
  HostLinkCore,
  RacpServer,
  createPushNotifier,
  wsHostLinkConnector,
  type HostLinkConnector,
  type HostLinkState,
  type HostLinkTimers,
} from "@pi-desktop/racp";
import {
  RACP_HOSTLINK_LIMITS,
  buildMobilePairingPayload,
  type MobileAccessEnrollRequest,
  type MobileAccessLinkState,
  type MobileAccessPairing,
  type MobileAccessStatus,
  type MobileDeviceSummary,
} from "@pi-desktop/shared";

import type { EncryptionPort } from "../remote/remote-host-registry.js";
import { enrollWithRelay, type EnrollmentFetch } from "./mobile-enrollment.js";
import { createMobileHostOperations } from "./mobile-host-operations.js";
import { MobileAccessStore } from "./mobile-access-store.js";

type Log = (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;

export type MobileAccessServiceDeps = {
  dataDir: string;
  encryption: EncryptionPort;
  agentHost: AgentHost;
  getHost: () => HostRpc | null;
  appVersion: string;
  defaultHostLabel: string;
  emitStatus: (status: MobileAccessStatus) => void;
  onSessionsChanged: () => void;
  log: Log;
  /** Test seams; production uses `wsHostLinkConnector`, global fetch, and real timers. */
  connector?: (input: { relayOrigin: string; credential: () => Promise<string | null> }) => HostLinkConnector;
  fetch?: EnrollmentFetch;
  timers?: HostLinkTimers;
  random?: () => number;
};

export interface MobileAccessService {
  start(): Promise<void>;
  status(): Promise<MobileAccessStatus>;
  enroll(request: MobileAccessEnrollRequest): Promise<MobileAccessStatus>;
  unenroll(): Promise<MobileAccessStatus>;
  setEnabled(enabled: boolean): Promise<MobileAccessStatus>;
  createPairing(): Promise<MobileAccessPairing>;
  listDevices(): Promise<MobileDeviceSummary[]>;
  revokeDevice(deviceId: string): Promise<boolean>;
  dispose(): Promise<void>;
}

function serviceError(message: string, errorCode: string): Error & { errorCode: string } {
  return Object.assign(new Error(message), { errorCode });
}

function linkStateOf(enrolled: boolean, enabled: boolean, core: HostLinkCore | null): MobileAccessLinkState {
  if (!enrolled) return "not-enrolled";
  if (!enabled || !core) return "disabled";
  const state: HostLinkState = core.state;
  if (state === "connected") return "connected";
  if (state === "reconnecting") return core.errorCode === "REMOTE_AUTH_FAILED" ? "error" : "reconnecting";
  return "connecting";
}

export function createMobileAccessService(deps: MobileAccessServiceDeps): MobileAccessService {
  const store = new MobileAccessStore(deps.dataDir, deps.encryption, (level, message, data) => deps.log(level, message, data));
  const authenticator = new DeviceTokenAuthenticator(store);
  const pushDevices = new Set<string>();
  let core: HostLinkCore | null = null;
  let disposed = false;
  let chain: Promise<unknown> = Promise.resolve();
  let hostId = "";

  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const run = chain.then(() => {
      if (disposed) throw serviceError("mobile access is shut down", "AGENT_UNAVAILABLE");
      return action();
    });
    chain = run.catch(() => undefined);
    return run;
  };

  const operations = createMobileHostOperations({
    getHost: deps.getHost,
    onSessionsChanged: deps.onSessionsChanged,
    registerPush: async (deviceId, input) => {
      await store.setPush(deviceId, { environment: input.environment, registeredAt: new Date().toISOString() });
      pushDevices.add(deviceId);
      // The relay keeps the APNs token; the desktop keeps only the fact that push is on.
      core?.registerPush(deviceId, input.apnsToken, input.environment);
      void emit();
    },
  });

  let server: RacpServer | null = null;
  const requireServer = (): RacpServer => {
    if (!server) throw serviceError("mobile access is not started", "AGENT_UNAVAILABLE");
    return server;
  };

  const notifier = createPushNotifier({
    get hostId() {
      return hostId;
    },
    pushDevices: () => [...pushDevices],
    isDeviceSubscribed: (deviceId, sessionId) => server?.deviceSubscribedTo(deviceId, sessionId) ?? false,
    sessionTitle: async (sessionId) => {
      const host = deps.getHost();
      if (!host) return undefined;
      const result = await host.call<{ session?: { title?: string } | null }>("session.get", { id: sessionId, messageLimit: 1 });
      return result.session?.title;
    },
    send: (deviceIds, notification) => core?.sendPush(deviceIds, notification) ?? false,
    log: deps.log,
  });
  const stopObserving = deps.agentHost.hub.observe((envelope) => {
    if (!core || pushDevices.size === 0) return;
    notifier.handle(envelope).catch((error: unknown) => deps.log("warn", "mobile push failed", { error: String(error) }));
  });

  async function status(): Promise<MobileAccessStatus> {
    const config = await store.config();
    return {
      enabled: config.enabled,
      enrolled: config.enrolled,
      ...(config.relayOrigin ? { relayOrigin: config.relayOrigin } : {}),
      hostId: config.hostId,
      hostLabel: config.hostLabel ?? deps.defaultHostLabel,
      linkState: linkStateOf(config.enrolled, config.enabled, core),
      ...(core?.errorCode ? { lastErrorCode: core.errorCode } : {}),
      connectedPhones: server?.connectedDeviceIds().length ?? 0,
      encryptionAvailable: store.encryptionAvailable(),
    };
  }

  async function emit(): Promise<void> {
    if (disposed) return;
    try {
      deps.emitStatus(await status());
    } catch (error) {
      deps.log("warn", "mobile access status emit failed", { error: String(error) });
    }
  }

  function stopLink(): void {
    if (!core) return;
    core.dispose();
    core = null;
  }

  async function startLinkIfReady(): Promise<void> {
    const config = await store.config();
    if (!config.enabled || !config.enrolled || !config.relayOrigin || core) return;
    const relayOrigin = config.relayOrigin;
    const credential = () => store.credential();
    const connect = deps.connector ? deps.connector({ relayOrigin, credential }) : wsHostLinkConnector({ relayOrigin, credential });
    core = new HostLinkCore({
      hostId: config.hostId,
      server: requireServer(),
      authenticator,
      connect,
      ...(deps.timers ? { timers: deps.timers } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      onStateChange: (state, errorCode) => {
        deps.log(state === "connected" ? "info" : "warn", "mobile relay link state", { state, ...(errorCode ? { errorCode } : {}) });
        void emit();
      },
      onConnectionsChanged: () => void emit(),
      onPushResult: (deviceId, result) => {
        if (result !== "invalid-token") return;
        pushDevices.delete(deviceId);
        void store.setPush(deviceId, null).catch((error: unknown) => deps.log("warn", "push registration cleanup failed", { error: String(error) }));
      },
      log: deps.log,
    });
    core.start();
  }

  return {
    async start() {
      await serial(async () => {
        const config = await store.config();
        hostId = config.hostId;
        server = new RacpServer({
          agentHost: deps.agentHost,
          operations,
          authenticator,
          hostId,
          serverName: "pi-desktop",
          serverVersion: deps.appVersion,
          limits: { maxConnectedClients: RACP_HOSTLINK_LIMITS.maxPhoneConnectionsPerHost },
          log: deps.log,
        });
        for (const deviceId of Object.keys(await store.pushDevices())) pushDevices.add(deviceId);
        await startLinkIfReady();
      });
      await emit();
    },
    status,
    async enroll(request) {
      const result = await serial(async () => {
        if (!store.encryptionAvailable()) {
          throw serviceError("secure storage is unavailable on this system", "ENCRYPTION_UNAVAILABLE");
        }
        const config = await store.config();
        const hostLabel = (request.hostLabel ?? "").trim().slice(0, 80) || config.hostLabel || deps.defaultHostLabel;
        const enrolled = await enrollWithRelay({
          relayOrigin: request.relayOrigin,
          enrollmentCode: request.enrollmentCode,
          hostId: config.hostId,
          hostLabel,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        });
        // A new relay means a new trust root: forget phones paired through the old one.
        stopLink();
        if (config.enrolled) await store.clearEnrollment();
        await store.setEnrollment({ relayOrigin: enrolled.relayOrigin, relayId: enrolled.relayId, credential: enrolled.credential, hostLabel });
        pushDevices.clear();
        await store.setEnabled(true);
        await startLinkIfReady();
        return status();
      });
      await emit();
      return result;
    },
    async unenroll() {
      const result = await serial(async () => {
        stopLink();
        for (const deviceId of requireServer().connectedDeviceIds()) requireServer().closeDevice(deviceId);
        await store.clearEnrollment();
        pushDevices.clear();
        return status();
      });
      await emit();
      return result;
    },
    async setEnabled(enabled) {
      const result = await serial(async () => {
        const config = await store.config();
        if (enabled && !config.enrolled) throw serviceError("enroll with a relay first", "INVALID_ARGUMENT");
        await store.setEnabled(enabled);
        if (enabled) await startLinkIfReady();
        else stopLink();
        return status();
      });
      await emit();
      return result;
    },
    async createPairing() {
      return serial(async () => {
        const config = await store.config();
        if (!config.enrolled || !config.relayOrigin) throw serviceError("enroll with a relay first", "INVALID_ARGUMENT");
        if (!config.enabled) throw serviceError("turn mobile access on first", "INVALID_ARGUMENT");
        const issued = await authenticator.issuePairingToken(RACP_HOSTLINK_LIMITS.pairingTokenLifetimeMs, { profile: "mobile" });
        return {
          payload: buildMobilePairingPayload({
            relay: config.relayOrigin,
            hostId: config.hostId,
            pairingToken: issued.token,
            hostLabel: config.hostLabel ?? deps.defaultHostLabel,
          }),
          expiresAt: issued.expiresAt,
        };
      });
    },
    async listDevices() {
      const connected = new Set(server?.connectedDeviceIds() ?? []);
      const push = await store.pushDevices();
      return (await store.listDevices())
        .filter((device) => device.profile === "mobile" && !device.revokedAt)
        .map((device) => ({
          deviceId: device.deviceId,
          label: device.label,
          createdAt: device.createdAt,
          ...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {}),
          connected: connected.has(device.deviceId),
          pushEnabled: Boolean(push[device.deviceId]),
        }));
    },
    async revokeDevice(deviceId) {
      const revoked = await serial(async () => {
        const result = core ? await core.revokeDevice(deviceId) : await authenticator.revoke(deviceId);
        requireServer().closeDevice(deviceId);
        if (pushDevices.delete(deviceId)) core?.unregisterPush(deviceId);
        return result;
      });
      await emit();
      return revoked;
    },
    async dispose() {
      if (disposed) return;
      await chain.catch(() => undefined);
      disposed = true;
      stopObserving();
      stopLink();
      server?.close();
      server = null;
    },
  };
}
