import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { IPC, parseMobilePairingPayload, parseHostLinkHostFrame } = await import("@pi-desktop/shared");
const { RacpClient } = await import("@pi-desktop/racp");
const { buildHost } = await import("@pi-desktop/racp/test-harness");
const { createMobileAccessService } = await import("../electron/main/mobile/mobile-access-service.ts");
const { registerMobileAccessIpc } = await import("../electron/main/ipc/mobile-access-ipc.ts");

const LINK = "racp-hostlink.v1";

function encryption(available = true) {
  return {
    isAvailable: () => available,
    encryptString: (plain) => Buffer.from(Buffer.from(plain).toString("base64").split("").reverse().join("")),
    decryptString: (buffer) => Buffer.from(buffer.toString().split("").reverse().join(""), "base64").toString(),
  };
}

const settle = async () => {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** The relay end of the desktop's Host link, scripted by the test. */
class RelaySocket {
  constructor() {
    this.frames = [];
    this.open = true;
    this.phones = new Map();
  }
  send(raw) {
    const frame = parseHostLinkHostFrame(raw);
    assert.ok(frame, `desktop sent an invalid frame: ${raw}`);
    this.frames.push(frame);
    if (frame.type === "host.message") queueMicrotask(() => this.phones.get(frame.clientConnectionId)?.message?.(frame.message));
    if (frame.type === "host.close") {
      const phone = this.phones.get(frame.clientConnectionId);
      this.phones.delete(frame.clientConnectionId);
      queueMicrotask(() => phone?.close?.({ code: 4000, reason: frame.code }));
    }
  }
  close(code) {
    this.closedWith = code;
    this.open = false;
    for (const phone of this.phones.values()) queueMicrotask(() => phone.close?.({ code: 1012, reason: "link closed" }));
    this.phones.clear();
  }
  onMessage(handler) {
    this.deliver = (frame) => handler(JSON.stringify({ link: LINK, ...frame }));
  }
  onClose(handler) {
    this.dropped = handler;
  }
  ofType(type) {
    return this.frames.filter((frame) => frame.type === type);
  }
  phoneTransport(id, token, hostId) {
    const handlers = {};
    this.phones.set(id, handlers);
    this.deliver({ type: "client.open", clientConnectionId: id, routeContext: { hostId, clientConnectionId: id, presentedToken: token, remoteAddress: "198.51.100.2", openedAt: new Date().toISOString() } });
    return {
      send: (frame) => this.deliver({ type: "client.message", clientConnectionId: id, message: frame }),
      close: () => {
        this.phones.delete(id);
        this.deliver({ type: "client.close", clientConnectionId: id, reason: "closed" });
        queueMicrotask(() => handlers.close?.({ code: 1000, reason: "closed" }));
      },
      onMessage: (handler) => (handlers.message = handler),
      onClose: (handler) => (handlers.close = handler),
      onError: () => undefined,
    };
  }
}

function okFetch(calls, body = { credential: "prh1.secret-link-credential", relayId: "relay_1" }) {
  return async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

async function fixture(options = {}) {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "mobile-access-")));
  const { host, runtime } = buildHost();
  const sockets = [];
  const connects = [];
  const statuses = [];
  const fetchCalls = [];
  const service = createMobileAccessService({
    dataDir: dir,
    encryption: options.encryption ?? encryption(),
    agentHost: host,
    getHost: () => null,
    appVersion: "0.21.0",
    defaultHostLabel: "Test Mac",
    emitStatus: (status) => statuses.push(status),
    onSessionsChanged: () => undefined,
    log: () => undefined,
    fetch: options.fetch ?? okFetch(fetchCalls),
    connector: ({ relayOrigin, credential }) => async () => {
      connects.push({ relayOrigin, credential: await credential() });
      const socket = new RelaySocket();
      sockets.push(socket);
      return socket;
    },
    random: () => 0.5,
  });
  await service.start();
  return {
    dir,
    host,
    runtime,
    service,
    sockets,
    connects,
    statuses,
    fetchCalls,
    socket: () => sockets.at(-1),
    async phone(token) {
      const status = await service.status();
      const client = new RacpClient({
        transport: async () => sockets.at(-1).phoneTransport(`p_${Math.random().toString(36).slice(2)}`, token, status.hostId),
        client: { name: "pi-mobile-ios", version: "1.0.0" },
        requestTimeoutMs: 2_000,
        reconnect: { enabled: false },
      });
      await client.connect();
      return client;
    },
    cleanup: async () => {
      await service.dispose();
      if (!options.dir) await rm(dir, { recursive: true, force: true });
    },
  };
}

test("mobile access is off by default and opens no outbound connection", async () => {
  const f = await fixture();
  try {
    const status = await f.service.status();
    assert.equal(status.enabled, false);
    assert.equal(status.enrolled, false);
    assert.equal(status.linkState, "not-enrolled");
    assert.equal(f.connects.length, 0);
    await assert.rejects(f.service.setEnabled(true), { errorCode: "INVALID_ARGUMENT" });
    await assert.rejects(f.service.createPairing(), { errorCode: "INVALID_ARGUMENT" });
    assert.equal(f.connects.length, 0);
    assert.equal(f.fetchCalls.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("enrollment refuses plain http, foreign paths, redirects, foreign origins, bad codes, and missing secure storage", async () => {
  const redirect = async () => new Response(null, { status: 302, headers: { location: "https://evil.example.com/v1/hosts/enroll" } });
  const foreign = async () => {
    const response = new Response(JSON.stringify({ credential: "prh1.x", relayId: "r" }), { status: 200 });
    Object.defineProperty(response, "url", { value: "https://evil.example.com/v1/hosts/enroll" });
    return response;
  };
  const badBody = async () => new Response(JSON.stringify({ credential: "pdt1.not-a-link-credential", relayId: "r" }), { status: 200 });
  const rejected = async () => new Response("{}", { status: 410 });
  const cases = [
    [{ relayOrigin: "http://relay.example.com", enrollmentCode: "pre1.abc" }, undefined, "INVALID_ARGUMENT"],
    [{ relayOrigin: "https://relay.example.com/admin", enrollmentCode: "pre1.abc" }, undefined, "INVALID_ARGUMENT"],
    [{ relayOrigin: "https://relay.example.com", enrollmentCode: "prh1.abc" }, undefined, "INVALID_ARGUMENT"],
    [{ relayOrigin: "https://relay.example.com", enrollmentCode: "pre1.abc" }, redirect, "REMOTE_CONNECTION_FAILED"],
    [{ relayOrigin: "https://relay.example.com", enrollmentCode: "pre1.abc" }, foreign, "REMOTE_CONNECTION_FAILED"],
    [{ relayOrigin: "https://relay.example.com", enrollmentCode: "pre1.abc" }, badBody, "REMOTE_CONNECTION_FAILED"],
    [{ relayOrigin: "https://relay.example.com", enrollmentCode: "pre1.abc" }, rejected, "PAIRING_FAILED"],
  ];
  for (const [request, fetchImpl, code] of cases) {
    const f = await fixture(fetchImpl ? { fetch: fetchImpl } : {});
    try {
      await assert.rejects(f.service.enroll(request), (error) => error.errorCode === code, JSON.stringify(request));
      assert.equal(f.connects.length, 0);
      assert.equal((await f.service.status()).enrolled, false);
    } finally {
      await f.cleanup();
    }
  }
  const noKeychain = await fixture({ encryption: encryption(false) });
  try {
    await assert.rejects(noKeychain.service.enroll({ relayOrigin: "https://relay.example.com", enrollmentCode: "pre1.abc" }), { errorCode: "ENCRYPTION_UNAVAILABLE" });
    assert.equal(noKeychain.fetchCalls.length, 0);
  } finally {
    await noKeychain.cleanup();
  }
});

test("enrollment stores the credential only encrypted, connects, and survives a restart; disabling closes the link", async () => {
  const f = await fixture();
  try {
    const status = await f.service.enroll({ relayOrigin: "https://relay.example.com/", enrollmentCode: " pre1.code-123 ", hostLabel: "Studio" });
    await settle();
    assert.equal(f.fetchCalls[0].url, "https://relay.example.com/v1/hosts/enroll");
    assert.equal(f.fetchCalls[0].init.redirect, "manual");
    assert.deepEqual(JSON.parse(f.fetchCalls[0].init.body), { code: "pre1.code-123", hostId: status.hostId, label: "Studio" });
    assert.equal(status.enabled, true);
    assert.equal(status.relayOrigin, "https://relay.example.com");
    assert.deepEqual(f.connects, [{ relayOrigin: "https://relay.example.com", credential: "prh1.secret-link-credential" }]);
    assert.equal((await f.service.status()).linkState, "connected");
    const onDisk = await readFile(join(f.dir, "mobile-access.json"), "utf8");
    assert.doesNotMatch(onDisk, /prh1\.|secret-link-credential/);
    assert.ok(f.statuses.some((entry) => entry.linkState === "connected"));

    await f.service.setEnabled(false);
    assert.equal(f.socket().closedWith, 1000);
    assert.equal((await f.service.status()).linkState, "disabled");
    await f.service.dispose();

    const restarted = await fixture({ dir: f.dir });
    try {
      assert.equal((await restarted.service.status()).enrolled, true);
      assert.equal(restarted.connects.length, 0, "a disabled service never connects after restart");
      await restarted.service.setEnabled(true);
      await settle();
      assert.equal(restarted.connects.length, 1);
      assert.equal(restarted.connects[0].credential, "prh1.secret-link-credential");
    } finally {
      await restarted.service.dispose();
    }
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("a phone pairs from the QR payload, runs under the ceiling, registers push, and is revoked", async () => {
  const f = await fixture();
  try {
    await f.service.enroll({ relayOrigin: "https://relay.example.com", enrollmentCode: "pre1.code" });
    await settle();
    const pairing = await f.service.createPairing();
    const payload = parseMobilePairingPayload(pairing.payload);
    assert.ok(payload);
    assert.equal(payload.relay, "https://relay.example.com");
    assert.equal(payload.hostLabel, "Test Mac");
    assert.ok(Date.parse(pairing.expiresAt) - Date.now() <= 5 * 60_000);
    await settle();
    assert.ok(f.socket().ofType("host.devices").some((frame) => frame.pairingHashes.length === 1));

    const pairingClient = await f.phone(payload.pairingToken);
    const paired = await pairingClient.request("connection/pair", { label: "iPhone 17" });
    assert.deepEqual(paired.roles, ["controller", "approver"]);
    await pairingClient.close();

    const phone = await f.phone(paired.deviceToken);
    const devices = await f.service.listDevices();
    assert.equal(devices.length, 1);
    assert.equal(devices[0].label, "iPhone 17");
    assert.equal(devices[0].connected, true);
    assert.equal(JSON.stringify(devices).includes(paired.deviceToken), false);

    const started = await phone.request("turn/start", { sessionId: "s1", input: { text: "from phone" }, context: { requestId: "r1" } });
    assert.equal(started.turn.effectivePermissionMode, "ask");
    await phone.request("push/register", { apnsToken: "a1".repeat(32), environment: "sandbox" });
    assert.deepEqual(f.socket().ofType("push.register").map((frame) => frame.deviceId), [paired.deviceId]);
    assert.equal((await f.service.listDevices())[0].pushEnabled, true);

    // A durable event while the phone is not watching the session becomes a redacted push.
    f.host.hub.publish({ scope: "session", sessionId: "s1", kind: "turn.completed", payload: { output: "secret answer" }, revision: 3 });
    await settle();
    const pushes = f.socket().ofType("push.notify");
    assert.equal(pushes.length, 1);
    assert.deepEqual(Object.keys(pushes[0].notification).sort(), ["hostId", "kind", "sessionId", "title"]);

    assert.equal(await f.service.revokeDevice(paired.deviceId), true);
    await settle();
    assert.equal((await f.service.listDevices()).length, 0);
    assert.ok(f.socket().ofType("host.close").some((frame) => frame.code === "REVOKED"));
    assert.deepEqual(f.socket().ofType("push.unregister").map((frame) => frame.deviceId), [paired.deviceId]);
    assert.deepEqual(f.socket().ofType("host.devices").at(-1).tokenHashes, []);
    await assert.rejects(f.phone(paired.deviceToken));
  } finally {
    await f.cleanup();
  }
});

test("unenroll forgets the relay, the phones, and closes the link", async () => {
  const f = await fixture();
  try {
    await f.service.enroll({ relayOrigin: "https://relay.example.com", enrollmentCode: "pre1.code" });
    await settle();
    const payload = parseMobilePairingPayload((await f.service.createPairing()).payload);
    await settle();
    const client = await f.phone(payload.pairingToken);
    await client.request("connection/pair", { label: "p" });
    const status = await f.service.unenroll();
    assert.equal(status.enrolled, false);
    assert.equal(status.enabled, false);
    assert.equal(f.socket().closedWith, 1000);
    assert.deepEqual(await f.service.listDevices(), []);
    assert.doesNotMatch(await readFile(join(f.dir, "mobile-access.json"), "utf8"), /credential/);
  } finally {
    await f.cleanup();
  }
});

test("mobile access IPC validates input and never returns a secret from status", async () => {
  const handlers = new Map();
  const calls = [];
  const fake = {
    status: async () => ({ enabled: false, enrolled: false, hostId: "h", hostLabel: "Mac", linkState: "not-enrolled", connectedPhones: 0, encryptionAvailable: true }),
    enroll: async (request) => {
      calls.push(request);
      return fake.status();
    },
    setEnabled: async (enabled) => {
      calls.push({ enabled });
      return fake.status();
    },
    revokeDevice: async (deviceId) => {
      calls.push({ deviceId });
      return true;
    },
    listDevices: async () => [],
  };
  registerMobileAccessIpc({ registrar: { handle: (channel, handler) => handlers.set(channel, handler) }, getService: () => fake });
  for (const channel of ["mobileAccessStatus", "mobileAccessEnroll", "mobileAccessUnenroll", "mobileAccessSetEnabled", "mobileAccessCreatePairing", "mobileAccessListDevices", "mobileAccessRevokeDevice"]) {
    assert.ok(handlers.has(IPC.invoke[channel]), channel);
  }
  await assert.rejects(handlers.get(IPC.invoke.mobileAccessEnroll)({ relayOrigin: "", enrollmentCode: "pre1.x" }), { errorCode: "INVALID_ARGUMENT" });
  await assert.rejects(handlers.get(IPC.invoke.mobileAccessSetEnabled)({ enabled: "yes" }), { errorCode: "INVALID_ARGUMENT" });
  await assert.rejects(handlers.get(IPC.invoke.mobileAccessRevokeDevice)({}), { errorCode: "INVALID_ARGUMENT" });
  await handlers.get(IPC.invoke.mobileAccessEnroll)({ relayOrigin: " https://r.example.com ", enrollmentCode: " pre1.x ", hostLabel: "Mac" });
  assert.deepEqual(calls.at(-1), { relayOrigin: "https://r.example.com", enrollmentCode: "pre1.x", hostLabel: "Mac" });
  assert.deepEqual(await handlers.get(IPC.invoke.mobileAccessRevokeDevice)({ deviceId: "dev_1" }), { revoked: true });
  const status = await handlers.get(IPC.invoke.mobileAccessStatus)();
  assert.equal(JSON.stringify(status).match(/prh1|pdt1|ppt1/), null);
  registerMobileAccessIpc({ registrar: { handle: (channel, handler) => handlers.set(channel, handler) }, getService: () => null });
  await assert.rejects(handlers.get(IPC.invoke.mobileAccessStatus)(), { errorCode: "AGENT_UNAVAILABLE" });
});
