import { describe, expect, it } from "vitest";
import type { PushNotification, RacpEventEnvelope } from "@pi-desktop/shared";

import { buildPushNotification, createPushNotifier } from "./hostlink-push.js";
import { hostLinkFixture, pairPhone, settle } from "./hostlink-test-support.js";

function event(kind: RacpEventEnvelope["kind"], payload: unknown, extra: Partial<RacpEventEnvelope> = {}): RacpEventEnvelope {
  return {
    eventId: "evt_1",
    scope: "session",
    sessionId: "s1",
    turnId: "t1",
    epoch: "ep",
    sequence: 4,
    revision: 1,
    kind,
    occurredAt: "2026-10-17T00:00:00.000Z",
    payload,
    ...extra,
  };
}

describe("push payload construction (profile §7)", () => {
  it("rebuilds only whitelisted fields from the four durable kinds", () => {
    const secretTool = { id: "ap_1", kind: "tool", toolName: "Bash", summary: "Bash: rm -rf ~/secret", args: { command: "cat ~/.ssh/id_rsa" } };
    const approval = buildPushNotification("host_1", event("approval.requested", secretTool), "Fix the build");
    expect(approval).toEqual({
      kind: "approval.requested",
      hostId: "host_1",
      sessionId: "s1",
      turnId: "t1",
      requestId: "ap_1",
      title: "Fix the build",
      category: "APPROVAL",
    });
    expect(JSON.stringify(approval)).not.toMatch(/Bash|secret|ssh|rm -rf/);

    const plan = buildPushNotification("host_1", event("approval.requested", { id: "plan_1", kind: "plan", artifact: "secret plan" }), "t");
    expect(plan).not.toHaveProperty("category");
    expect(buildPushNotification("host_1", event("input.requested", { id: "in_1", questions: [{ text: "password?" }] }), "t")).toMatchObject({ requestId: "in_1" });
    expect(buildPushNotification("host_1", event("turn.completed", { turn: { id: "t1", output: "model said private things" } }), "t")).toEqual({
      kind: "turn.completed", hostId: "host_1", sessionId: "s1", turnId: "t1", title: "t",
    });
    expect(buildPushNotification("host_1", event("turn.failed", {}), undefined)?.title).toBe("");
  });

  it("ignores other kinds, host scope, and ephemeral envelopes", () => {
    expect(buildPushNotification("h", event("item.delta", {}), "t")).toBeNull();
    expect(buildPushNotification("h", event("turn.completed", {}, { scope: "host", sessionId: undefined }), "t")).toBeNull();
    expect(buildPushNotification("h", event("turn.completed", {}, { sequence: undefined, afterSequence: 3 }), "t")).toBeNull();
  });

  it("truncates the title to 80 characters", () => {
    const notification = buildPushNotification("h", event("turn.completed", {}), "x".repeat(200));
    expect(Array.from(notification!.title)).toHaveLength(80);
  });
});

describe("push notifier", () => {
  it("skips devices subscribed to the session and reports a down link", async () => {
    const sent: Array<{ deviceIds: string[]; notification: PushNotification }> = [];
    const logs: string[] = [];
    let linkUp = true;
    const notifier = createPushNotifier({
      hostId: "h",
      pushDevices: () => ["dev_a", "dev_b"],
      isDeviceSubscribed: (deviceId) => deviceId === "dev_a",
      sessionTitle: async () => "Session",
      send: (deviceIds, notification) => {
        if (!linkUp) return false;
        sent.push({ deviceIds, notification });
        return true;
      },
      log: (_level, message) => logs.push(message),
    });
    await notifier.handle(event("turn.completed", {}));
    expect(sent).toEqual([{ deviceIds: ["dev_b"], notification: expect.objectContaining({ kind: "turn.completed" }) }]);
    await notifier.handle(event("item.completed", {}));
    expect(sent).toHaveLength(1);
    linkUp = false;
    await notifier.handle(event("turn.failed", {}));
    expect(logs).toContain("push skipped: host link is down");
  });

  it("emits push.notify on the link for a real Agent Host event and nothing while the phone watches", async () => {
    const f = await hostLinkFixture();
    f.core.start();
    await settle();
    const paired = await pairPhone(f);
    const registered = new Set<string>([paired.deviceId]);
    const notifier = createPushNotifier({
      hostId: "host_desk",
      pushDevices: () => [...registered],
      isDeviceSubscribed: (deviceId, sessionId) => f.server.deviceSubscribedTo(deviceId, sessionId),
      sessionTitle: async (sessionId) => f.sessions.get(sessionId)?.title,
      send: (deviceIds, notification) => f.core.sendPush(deviceIds, notification),
      log: () => undefined,
    });
    const stop = f.host.hub.observe((envelope) => void notifier.handle(envelope));
    f.host.approvals.fromToolPermission(
      { requestId: "perm_1", sessionId: "s1", toolCallId: "call_1", toolName: "Bash", argsPreview: null, reason: "secret", risk: "high" },
      { turnId: "t1", revision: 1, lifetimeMs: 60_000, allowSession: false },
    );
    f.host.hub.publish({ scope: "session", sessionId: "s1", kind: "approval.requested", payload: { id: "perm_1", kind: "tool", toolName: "Bash" }, revision: 1 });
    await settle();
    const pushes = f.socket().framesOfType("push.notify");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ deviceIds: [paired.deviceId], notification: { kind: "approval.requested", requestId: "perm_1", title: "Session s1", category: "APPROVAL" } });

    const phone = await f.phone(paired.deviceToken);
    await phone.client.request("events/subscribe", { scope: "session", sessionId: "s1" });
    f.host.hub.publish({ scope: "session", sessionId: "s1", kind: "turn.completed", payload: {}, revision: 2 });
    await settle();
    expect(f.socket().framesOfType("push.notify")).toHaveLength(1);
    stop();
  });
});
