/**
 * Test support for the Host link: a scripted relay end, manual timers, and a
 * phone `RacpClient` whose transport rides the fake relay. Not exported from
 * the package entry point.
 */
import { RACP_HOSTLINK_PROTOCOL, parseHostLinkHostFrame, type HostLinkHostFrame } from "@pi-desktop/shared";

import { DeviceTokenAuthenticator, MemoryCredentialStore } from "./auth.js";
import { RacpClient, type ClientTransport } from "./client.js";
import { HostLinkCore, type HostLinkSocket, type HostLinkTimers } from "./hostlink.js";
import { RacpServer } from "./server.js";
import { buildHost, fakeOperations } from "./test-harness.js";

export class ManualTimers implements HostLinkTimers {
  now = 0;
  private next = 1;
  private readonly tasks = new Map<number, { at: number; callback: () => void }>();
  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.next++;
    this.tasks.set(id, { at: this.now + ms, callback });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }
  pending(): number[] {
    return [...this.tasks.values()].map((task) => task.at - this.now).sort((a, b) => a - b);
  }
  /** Advance the clock, running due tasks in order (tasks may schedule more). */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let dueId: number | undefined;
      let due: { at: number; callback: () => void } | undefined;
      for (const [id, task] of this.tasks) {
        if (task.at <= target && (!due || task.at < due.at)) {
          dueId = id;
          due = task;
        }
      }
      if (!due || dueId === undefined) break;
      this.tasks.delete(dueId);
      this.now = due.at;
      due.callback();
    }
    this.now = target;
  }
}

/** One relay-side socket: what the relay would hold for the desktop's link. */
export class FakeRelaySocket implements HostLinkSocket {
  readonly sent: HostLinkHostFrame[] = [];
  readonly raw: string[] = [];
  open = true;
  private messageHandler?: (frame: string) => void;
  private closeHandler?: (info: { code: number; reason: string }) => void;
  private readonly clientHandlers = new Map<string, { message?: (frame: string) => void; close?: (info: { code: number; reason: string }) => void }>();
  closedWith?: { code?: number; reason?: string };

  send(frame: string): void {
    if (!this.open) throw new Error("socket closed");
    this.raw.push(frame);
    const parsed = parseHostLinkHostFrame(frame);
    if (!parsed) throw new Error(`host sent an invalid frame: ${frame}`);
    this.sent.push(parsed);
    if (parsed.type === "host.message") {
      const handlers = this.clientHandlers.get(parsed.clientConnectionId);
      queueMicrotask(() => handlers?.message?.(parsed.message));
    } else if (parsed.type === "host.close") {
      const handlers = this.clientHandlers.get(parsed.clientConnectionId);
      this.clientHandlers.delete(parsed.clientConnectionId);
      queueMicrotask(() => handlers?.close?.({ code: 4000, reason: parsed.code }));
    }
  }
  /** The desktop closed the link; like the real relay, every phone socket closes with 1012. */
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.open = false;
    const handlers = [...this.clientHandlers.values()];
    this.clientHandlers.clear();
    queueMicrotask(() => {
      for (const handler of handlers) handler.close?.({ code: 1012, reason: "link closed" });
    });
  }
  onMessage(handler: (frame: string) => void): void {
    this.messageHandler = handler;
  }
  onClose(handler: (info: { code: number; reason: string }) => void): void {
    this.closeHandler = handler;
  }

  /** Relay → host. */
  deliver(frame: Record<string, unknown>): void {
    this.messageHandler?.(JSON.stringify({ link: RACP_HOSTLINK_PROTOCOL, ...frame }));
  }
  /** The relay dropped the link (network loss). */
  drop(): void {
    if (!this.open) return;
    this.open = false;
    this.closeHandler?.({ code: 1006, reason: "dropped" });
    for (const handlers of this.clientHandlers.values()) handlers.close?.({ code: 1012, reason: "link lost" });
    this.clientHandlers.clear();
  }

  framesOfType<T extends HostLinkHostFrame["type"]>(type: T): Extract<HostLinkHostFrame, { type: T }>[] {
    return this.sent.filter((frame): frame is Extract<HostLinkHostFrame, { type: T }> => frame.type === type);
  }

  /** A phone-side transport for one logical connection relayed through this socket. */
  phoneTransport(clientConnectionId: string, token: string, hostId: string): ClientTransport {
    const handlers: { message?: (frame: string) => void; close?: (info: { code: number; reason: string }) => void } = {};
    this.clientHandlers.set(clientConnectionId, handlers);
    this.deliver({
      type: "client.open",
      clientConnectionId,
      routeContext: { hostId, clientConnectionId, presentedToken: token, remoteAddress: "203.0.113.9", openedAt: "2026-10-17T00:00:00.000Z" },
    });
    return {
      send: (frame) => this.deliver({ type: "client.message", clientConnectionId, message: frame }),
      close: () => {
        this.clientHandlers.delete(clientConnectionId);
        this.deliver({ type: "client.close", clientConnectionId, reason: "phone closed" });
        queueMicrotask(() => handlers.close?.({ code: 1000, reason: "closed" }));
      },
      onMessage: (handler) => {
        handlers.message = handler;
      },
      onClose: (handler) => {
        handlers.close = handler;
      },
      onError: () => undefined,
    };
  }
}

export type HostLinkFixture = Awaited<ReturnType<typeof hostLinkFixture>>;

export async function hostLinkFixture(options: { failConnects?: number } = {}) {
  const { host, runtime, sessions, approvals } = buildHost();
  const store = new MemoryCredentialStore();
  const authenticator = new DeviceTokenAuthenticator(store);
  const pushRegistrations: Array<{ deviceId: string; apnsToken: string }> = [];
  const operations = {
    ...fakeOperations(sessions),
    registerPush: async (deviceId: string, input: { apnsToken: string }) => {
      pushRegistrations.push({ deviceId, apnsToken: input.apnsToken });
    },
  };
  const server = new RacpServer({
    agentHost: host,
    operations,
    authenticator,
    hostId: "host_desk",
    serverName: "pi-desktop",
    serverVersion: "0.21.0",
    log: () => undefined,
    initializeTimeoutMs: 60_000,
  });
  const timers = new ManualTimers();
  const sockets: FakeRelaySocket[] = [];
  let failures = options.failConnects ?? 0;
  let connects = 0;
  const states: string[] = [];
  const core = new HostLinkCore({
    hostId: "host_desk",
    server,
    authenticator,
    timers,
    random: () => 0.5,
    connect: async () => {
      connects += 1;
      if (failures > 0) {
        failures -= 1;
        throw Object.assign(new Error("refused"), { errorCode: "REMOTE_CONNECTION_FAILED" });
      }
      const socket = new FakeRelaySocket();
      sockets.push(socket);
      return socket;
    },
    onStateChange: (state) => states.push(state),
    log: () => undefined,
  });
  let phoneCounter = 0;
  return {
    host,
    runtime,
    sessions,
    approvals,
    store,
    authenticator,
    server,
    core,
    timers,
    sockets,
    states,
    pushRegistrations,
    connects: () => connects,
    socket: () => sockets[sockets.length - 1]!,
    /** Open a phone through the current link; reconnect is disabled (the app owns it). */
    async phone(token: string, overrides: Partial<ConstructorParameters<typeof RacpClient>[0]> = {}) {
      phoneCounter += 1;
      const id = `phone_${phoneCounter}`;
      const events: unknown[] = [];
      const client = new RacpClient({
        transport: async () => sockets[sockets.length - 1]!.phoneTransport(id, token, "host_desk"),
        client: { name: "pi-mobile-ios", version: "1.0.0" },
        onEvent: (envelope) => events.push(envelope),
        requestTimeoutMs: 2_000,
        reconnect: { enabled: false },
        ...overrides,
      });
      await client.connect();
      return { client, id, events };
    },
  };
}

export async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Pair a phone through the link and return its device token. */
export async function pairPhone(f: HostLinkFixture, label = "iPhone") {
  const issued = await f.authenticator.issuePairingToken(5 * 60_000, { profile: "mobile" });
  await settle();
  const pairing = await f.phone(issued.token);
  const paired = await pairing.client.request<{ deviceId: string; deviceToken: string; roles: string[] }>("connection/pair", { label });
  await pairing.client.close();
  await settle();
  return { ...paired, pairingToken: issued.token };
}
