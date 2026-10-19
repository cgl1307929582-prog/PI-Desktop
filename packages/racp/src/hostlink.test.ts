import { describe, expect, it } from "vitest";
import { RACP_HOSTLINK_LIMITS } from "@pi-desktop/shared";

import { hashToken } from "./auth.js";
import { hostLinkBackoffMs } from "./hostlink.js";
import { hostLinkFixture, pairPhone, settle } from "./hostlink-test-support.js";

const context = (requestId: string, idempotencyKey?: string) => ({ requestId, ...(idempotencyKey ? { idempotencyKey } : {}) });

describe("HostLinkCore link lifecycle", () => {
  it("connects, publishes the device mirror, and refreshes it after pairing and revocation", async () => {
    const f = await hostLinkFixture();
    f.core.start();
    await settle();
    expect(f.core.state).toBe("connected");
    expect(f.socket().framesOfType("host.devices")[0]).toMatchObject({ tokenHashes: [], pairingHashes: [] });
    const paired = await pairPhone(f);
    const mirrors = f.socket().framesOfType("host.devices");
    expect(mirrors.at(-1)).toEqual(expect.objectContaining({ tokenHashes: [hashToken(paired.deviceToken)], pairingHashes: [] }));
    expect(mirrors.some((frame) => frame.pairingHashes.includes(hashToken(paired.pairingToken)))).toBe(true);
    await f.core.revokeDevice(paired.deviceId);
    await settle();
    expect(f.socket().framesOfType("host.devices").at(-1)).toMatchObject({ tokenHashes: [], pairingHashes: [] });
  });

  it("sends only schema-valid frames to the relay", async () => {
    const f = await hostLinkFixture();
    f.core.start();
    await settle();
    const paired = await pairPhone(f);
    const phone = await f.phone(paired.deviceToken);
    await phone.client.request("session/list");
    // FakeRelaySocket.send throws on an invalid frame; reaching here means every frame parsed.
    expect(f.socket().raw.length).toBeGreaterThan(3);
  });

  it("pings every 30 s and drops the link after two missed pongs", async () => {
    const f = await hostLinkFixture();
    f.core.start();
    await settle();
    const first = f.socket();
    f.timers.advance(RACP_HOSTLINK_LIMITS.pingIntervalMs);
    expect(first.framesOfType("link.ping")).toHaveLength(1);
    first.deliver({ type: "link.pong" });
    f.timers.advance(RACP_HOSTLINK_LIMITS.pingIntervalMs);
    f.timers.advance(RACP_HOSTLINK_LIMITS.pingIntervalMs);
    expect(first.framesOfType("link.ping")).toHaveLength(3);
    expect(f.core.state).toBe("connected");
    f.timers.advance(RACP_HOSTLINK_LIMITS.pingIntervalMs);
    expect(f.core.state).toBe("reconnecting");
    expect(first.closedWith?.code).toBe(4000);
  });

  it("reconnects with 1 s → 60 s jittered backoff and resets after success", async () => {
    expect(hostLinkBackoffMs(0, () => 0)).toBe(500);
    expect(hostLinkBackoffMs(0, () => 0.999999)).toBe(1000);
    expect(hostLinkBackoffMs(3, () => 0.5)).toBe(6000);
    expect(hostLinkBackoffMs(30, () => 0.999999)).toBe(60_000);
    expect(hostLinkBackoffMs(30, () => 0)).toBe(30_000);

    const f = await hostLinkFixture({ failConnects: 3 });
    f.core.start();
    await settle();
    expect(f.core.state).toBe("reconnecting");
    expect(f.core.errorCode).toBe("REMOTE_CONNECTION_FAILED");
    expect(f.timers.pending()).toEqual([750]);
    f.timers.advance(750);
    await settle();
    expect(f.timers.pending()).toEqual([1500]);
    f.timers.advance(1500);
    await settle();
    expect(f.timers.pending()).toEqual([3000]);
    f.timers.advance(3000);
    await settle();
    expect(f.core.state).toBe("connected");
    expect(f.core.errorCode).toBeUndefined();
    expect(f.connects()).toBe(4);
    f.socket().drop();
    await settle();
    expect(f.timers.pending()[0]).toBe(750);
  });

  it("stop() closes the socket, every logical connection and every timer; a late upgrade is discarded", async () => {
    const f = await hostLinkFixture();
    f.core.start();
    await settle();
    const paired = await pairPhone(f);
    const phone = await f.phone(paired.deviceToken);
    expect(f.server.connectionCount()).toBe(1);
    f.core.stop();
    await settle();
    expect(f.core.state).toBe("stopped");
    expect(f.server.connectionCount()).toBe(0);
    expect(f.timers.pending()).toEqual([]);
    expect(f.socket().closedWith?.code).toBe(1000);
    expect(phone.client.state).not.toBe("connected");
  });
});

describe("HostLinkCore logical connections", () => {
  it("refuses an unknown bearer, a foreign host id, and a duplicate connection id", async () => {
    const f = await hostLinkFixture();
    f.core.start();
    await settle();
    const socket = f.socket();
    socket.deliver({
      type: "client.open",
      clientConnectionId: "x1",
      routeContext: { hostId: "host_desk", clientConnectionId: "x1", presentedToken: "pdt1.unknown", remoteAddress: "", openedAt: "t" },
    });
    socket.deliver({
      type: "client.open",
      clientConnectionId: "x2",
      routeContext: { hostId: "other_host", clientConnectionId: "x2", presentedToken: "pdt1.unknown", remoteAddress: "", openedAt: "t" },
    });
    await settle();
    expect(socket.framesOfType("host.close").map((frame) => [frame.clientConnectionId, frame.code])).toEqual([
      ["x2", "REMOTE_AUTH_FAILED"],
      ["x1", "REMOTE_AUTH_FAILED"],
    ]);
    const paired = await pairPhone(f);
    const phone = await f.phone(paired.deviceToken);
    socket.deliver({
      type: "client.open",
      clientConnectionId: phone.id,
      routeContext: { hostId: "host_desk", clientConnectionId: phone.id, presentedToken: paired.deviceToken, remoteAddress: "", openedAt: "t" },
    });
    await settle();
    expect(socket.framesOfType("host.close").at(-1)).toMatchObject({ clientConnectionId: phone.id, code: "CONFLICT" });
    expect(f.server.connectionCount()).toBe(1);
  });

  it("isolates subscriptions and server requests per logical connection", async () => {
    const f = await hostLinkFixture();
    f.core.start();
    await settle();
    const paired = await pairPhone(f);
    const a = await f.phone(paired.deviceToken);
    const requestsB: string[] = [];
    const b = await f.phone(paired.deviceToken, {
      onServerRequest: async (method) => {
        requestsB.push(method);
        return {};
      },
    });
    await a.client.request("events/subscribe", { scope: "session", sessionId: "s1" });
    await a.client.request("turn/start", { sessionId: "s1", input: { text: "go" }, context: context("r1") });
    f.host.ingest({ sessionId: "s1", turnId: "rt_1", ts: Date.parse("2026-10-17T00:00:01.000Z"), event: { type: "agent_start" } });
    f.host.ingest({ sessionId: "s1", turnId: "rt_1", ts: Date.parse("2026-10-17T00:00:02.000Z"), event: { type: "agent_end", messageIds: [] } });
    await settle();
    expect(a.events.length).toBeGreaterThan(0);
    expect(b.events).toEqual([]);
    expect(requestsB).toEqual([]);
    expect(f.core.logicalConnectionCount()).toBe(2);
  });

  it("revocation closes every live connection of that phone only", async () => {
    const f = await hostLinkFixture();
    f.core.start();
    await settle();
    const first = await pairPhone(f, "first");
    const second = await pairPhone(f, "second");
    const a1 = await f.phone(first.deviceToken);
    const a2 = await f.phone(first.deviceToken);
    const b = await f.phone(second.deviceToken);
    expect(f.server.connectionCount()).toBe(3);
    await f.core.revokeDevice(first.deviceId);
    await settle();
    expect(f.server.connectionCount()).toBe(1);
    expect(f.socket().framesOfType("host.close").filter((frame) => frame.code === "REVOKED").map((frame) => frame.clientConnectionId).sort()).toEqual([a1.id, a2.id].sort());
    expect((await b.client.request<{ sessions: unknown[] }>("session/list")).sessions).toHaveLength(1);
    await expect(f.phone(first.deviceToken)).rejects.toBeTruthy();
  });

  it("link loss closes logical connections without touching the running turn, and a retry after reconnect is not executed twice", async () => {
    const f = await hostLinkFixture();
    f.core.start();
    await settle();
    const paired = await pairPhone(f);
    const phone = await f.phone(paired.deviceToken);
    const started = await phone.client.request<{ turn: { id: string; status: string } }>("turn/start", {
      sessionId: "s1",
      input: { text: "long task" },
      context: context("r1", "idem-1"),
    });
    expect(f.runtime.prompts).toHaveLength(1);
    f.socket().drop();
    await settle();
    expect(f.server.connectionCount()).toBe(0);
    expect(f.core.state).toBe("reconnecting");
    expect(f.runtime.stops).toEqual([]);
    expect(f.runtime.aborts).toEqual([]);
    expect(f.host.getTurn(started.turn.id).status).not.toBe("canceled");

    f.timers.advance(750);
    await settle();
    expect(f.core.state).toBe("connected");
    const again = await f.phone(paired.deviceToken);
    const retried = await again.client.request<{ turn: { id: string } }>("turn/start", {
      sessionId: "s1",
      input: { text: "long task" },
      context: context("r2", "idem-1"),
    });
    expect(retried.turn.id).toBe(started.turn.id);
    expect(f.runtime.prompts).toHaveLength(1);
  });

  it("buffers frames that arrive while the credential is checked and drops them for a refused connection", async () => {
    const f = await hostLinkFixture();
    f.core.start();
    await settle();
    const socket = f.socket();
    socket.deliver({
      type: "client.open",
      clientConnectionId: "slow",
      routeContext: { hostId: "host_desk", clientConnectionId: "slow", presentedToken: "pdt1.bad", remoteAddress: "", openedAt: "t" },
    });
    socket.deliver({ type: "client.message", clientConnectionId: "slow", message: '{"jsonrpc":"2.0","id":1,"method":"session/list"}' });
    await settle();
    expect(socket.framesOfType("host.message").filter((frame) => frame.clientConnectionId === "slow")).toEqual([]);
    expect(socket.framesOfType("host.close").at(-1)).toMatchObject({ clientConnectionId: "slow", code: "REMOTE_AUTH_FAILED" });
  });
});
