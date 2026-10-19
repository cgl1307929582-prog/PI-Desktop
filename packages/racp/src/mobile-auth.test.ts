import { describe, expect, it } from "vitest";
import { effectiveRemotePermissionMode, RACP_DEFAULT_POLICY } from "@pi-desktop/shared";

import { DeviceTokenAuthenticator, MemoryCredentialStore, hashToken } from "./auth.js";
import { MOBILE_FORBIDDEN_OPERATIONS, profileAllowsOperation } from "./mobile-policy.js";
import { hostLinkFixture, pairPhone, settle } from "./hostlink-test-support.js";
import { harness } from "./test-harness.js";

const context = (requestId: string) => ({ requestId });

describe("mobile pairing (profile §5)", () => {
  it("mints controller + approver, never owner, with the spec label field", async () => {
    const f = await hostLinkFixture();
    f.core.start();
    await settle();
    const paired = await pairPhone(f, "Li's iPhone");
    expect(paired.roles).toEqual(["controller", "approver"]);
    const device = (await f.store.listDevices()).find((record) => record.deviceId === paired.deviceId);
    expect(device).toMatchObject({ label: "Li's iPhone", roles: ["controller", "approver"], profile: "mobile", tokenHash: hashToken(paired.deviceToken) });
    const phone = await f.phone(paired.deviceToken);
    expect(phone.client.initialized?.principal).toEqual({ subject: paired.deviceId, roles: ["controller", "approver"] });
    expect(phone.client.initialized?.capabilities.notifications).toBe(true);
  });

  it("is single-use, expires after its lifetime, and survives a concurrent double exchange once", async () => {
    let now = Date.parse("2026-10-17T00:00:00.000Z");
    const store = new MemoryCredentialStore();
    const auth = new DeviceTokenAuthenticator(store, () => now);
    const issued = await auth.issuePairingToken(5 * 60_000, { profile: "mobile" });
    const tokenHash = hashToken(issued.token);
    const results = await Promise.allSettled([auth.pair(tokenHash, "a", ["owner"]), auth.pair(tokenHash, "b", ["owner"])]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await store.listDevices())).toHaveLength(1);

    const late = await auth.issuePairingToken(5 * 60_000, { profile: "mobile" });
    now += 5 * 60_000 + 1;
    expect(await auth.authenticate({ authorization: `Bearer ${late.token}`, urlHasToken: false, connectionId: "c", profile: "mobile" })).toBeNull();
    await expect(auth.pair(hashToken(late.token), "c", ["owner"])).rejects.toMatchObject({ errorCode: "PAIRING_TOKEN_EXPIRED" });
  });

  it("binds every credential to its access path", async () => {
    const store = new MemoryCredentialStore();
    const auth = new DeviceTokenAuthenticator(store);
    const mobilePairing = await auth.issuePairingToken(60_000, { profile: "mobile" });
    const sshPairing = await auth.issuePairingToken(60_000);
    const bearer = (token: string) => `Bearer ${token}`;
    // A phone pairing token is useless on the loopback listener, and vice versa.
    expect(await auth.authenticate({ authorization: bearer(mobilePairing.token), urlHasToken: false, connectionId: "c" })).toBeNull();
    expect(await auth.authenticate({ authorization: bearer(sshPairing.token), urlHasToken: false, connectionId: "c", profile: "mobile" })).toBeNull();
    const phone = await auth.pair(hashToken(mobilePairing.token), "phone", ["owner"]);
    const desktop = await auth.pair(hashToken(sshPairing.token), "desktop", ["owner"]);
    expect(desktop.roles).toEqual(["owner"]);
    expect(await auth.authenticate({ authorization: bearer(phone.token), urlHasToken: false, connectionId: "c" })).toBeNull();
    expect(await auth.authenticate({ authorization: bearer(desktop.token), urlHasToken: false, connectionId: "c", profile: "mobile" })).toBeNull();
    const phoneAuth = await auth.authenticate({ authorization: bearer(phone.token), urlHasToken: false, connectionId: "c", profile: "mobile" });
    expect(phoneAuth?.principal).toMatchObject({ pairedDevice: false, mobile: true, roles: ["controller", "approver"] });
    const desktopAuth = await auth.authenticate({ authorization: bearer(desktop.token), urlHasToken: false, connectionId: "c" });
    expect(desktopAuth?.principal).toMatchObject({ pairedDevice: true, roles: ["owner"] });
    expect(desktopAuth?.principal.mobile).toBeUndefined();
  });

  it("reports only active mobile hashes to the relay mirror", async () => {
    let now = 1_000_000;
    const store = new MemoryCredentialStore();
    const auth = new DeviceTokenAuthenticator(store, () => now);
    const changes: number[] = [];
    auth.onCredentialsChanged(() => changes.push(now));
    const live = await auth.issuePairingToken(60_000, { profile: "mobile" });
    const used = await auth.issuePairingToken(60_000, { profile: "mobile" });
    await auth.issuePairingToken(60_000); // SSH profile: never mirrored
    const phone = await auth.pair(hashToken(used.token), "p", []);
    let hashes = await auth.activeHashes("mobile");
    expect(hashes.pairingHashes).toEqual([hashToken(live.token)]);
    expect(hashes.tokenHashes).toEqual([hashToken(phone.token)]);
    expect(await auth.revoke(phone.deviceId)).toBe(true);
    expect(await auth.revoke(phone.deviceId)).toBe(false);
    now += 61_000;
    hashes = await auth.activeHashes("mobile");
    expect(hashes).toEqual({ tokenHashes: [], pairingHashes: [] });
    expect(changes.length).toBe(5);
  });
});

describe("phone permissions (profile §6)", () => {
  it("always runs phone turns under the remote ceiling", () => {
    expect(effectiveRemotePermissionMode({ sessionMode: "auto", policy: RACP_DEFAULT_POLICY, pairedDevice: false, approverOverride: false })).toBe("ask");
  });

  it("refuses forbidden operations and keeps the pairing connection pair-only", async () => {
    const f = await hostLinkFixture();
    f.core.start();
    await settle();
    const issued = await f.authenticator.issuePairingToken(60_000, { profile: "mobile" });
    await settle();
    const pairing = await f.phone(issued.token);
    await expect(pairing.client.request("connection/ping")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(pairing.client.request("session/list")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const paired = await pairing.client.request<{ deviceToken: string }>("connection/pair", { label: "p" });
    const phone = await f.phone(paired.deviceToken);
    for (const [method, params] of [
      ["session/archive", { sessionId: "s1" }],
      ["session/delete", { sessionId: "s1" }],
      ["session/configure", { sessionId: "s1", permissionMode: "auto" }],
      ["terminal/open", { sessionId: "s1" }],
      ["tools/advertise", {}],
      ["project/register", { path: "/tmp" }],
      ["workspace/toolShell", {}],
      ["session/revoke", { deviceId: "x" }],
    ] as const) {
      await expect(phone.client.request(method, params), method).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    // Allowed: read and control.
    expect((await phone.client.request<{ sessions: unknown[] }>("session/list")).sessions).toHaveLength(1);
    const started = await phone.client.request<{ turn: { effectivePermissionMode: string } }>("turn/start", {
      sessionId: "s1",
      input: { text: "hello from the phone" },
      context: context("r1"),
    });
    expect(started.turn.effectivePermissionMode).toBe("ask");
    expect(f.runtime.prompts[0]?.effectivePermissionMode).toBe("ask");
  });

  it("applies the ceiling even when the session runs in auto", async () => {
    const f = await hostLinkFixture();
    f.sessions.set("s1", { ...f.sessions.get("s1")!, permissionMode: "auto" });
    f.core.start();
    await settle();
    const paired = await pairPhone(f);
    const phone = await f.phone(paired.deviceToken);
    const started = await phone.client.request<{ turn: { effectivePermissionMode: string } }>("turn/start", {
      sessionId: "s1",
      input: { text: "x" },
      context: context("r2"),
    });
    expect(started.turn.effectivePermissionMode).toBe("ask");
  });

  it("refuses allow-session and contract approval from a phone but accepts allow-once and reject", async () => {
    const f = await hostLinkFixture();
    f.core.start();
    await settle();
    const paired = await pairPhone(f);
    const phone = await f.phone(paired.deviceToken);
    const tool = f.host.approvals.fromToolPermission(
      { requestId: "perm_1", sessionId: "s1", toolCallId: "call_1", toolName: "Bash", argsPreview: null, reason: "run tests", risk: "high" },
      { turnId: "t1", revision: 1, lifetimeMs: 60_000, allowSession: true },
    );
    await expect(phone.client.request("approval/respond", { approvalId: tool.id, decision: "allow-session", context: context("a1") })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await phone.client.request("approval/respond", { approvalId: tool.id, decision: "allow-once", context: context("a2") });
    expect(f.approvals.tool).toEqual([{ requestId: "perm_1", decision: "allow-once" }]);

    const plan = f.host.approvals.fromPlanningState(
      { sessionId: "s1", state: "awaiting_approval", proposalId: "plan_1", kind: "plan", title: "Refactor" },
      { turnId: "t1", revision: 2, lifetimeMs: 60_000 },
    );
    expect(plan).not.toBeNull();
    await expect(
      phone.client.request("approval/respond", { approvalId: "plan_1", decision: "approve", permissionMode: "auto", context: context("a3") }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const rejected = await phone.client.request<{ status: string }>("approval/respond", { approvalId: "plan_1", decision: "reject", context: context("a4") });
    expect(rejected.status).toBe("resolved");
  });

  it("binds push/register to the authenticated phone", async () => {
    const f = await hostLinkFixture();
    f.core.start();
    await settle();
    const paired = await pairPhone(f);
    const phone = await f.phone(paired.deviceToken);
    await phone.client.request("push/register", { apnsToken: "ab".repeat(32), environment: "sandbox" });
    expect(f.pushRegistrations).toEqual([{ deviceId: paired.deviceId, apnsToken: "ab".repeat(32) }]);
    await expect(phone.client.request("push/register", { apnsToken: "zz", environment: "sandbox" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("keeps the SSH owner pairing and loopback devices unaffected by the mobile policy", async () => {
    const h = await harness();
    const issued = await h.authenticator.issuePairingToken(60_000);
    const pairing = await h.connect(issued.token);
    const paired = await pairing.client.request<{ roles: string[]; deviceToken: string }>("connection/pair", { deviceLabel: "laptop" });
    expect(paired.roles).toEqual(["owner"]);
    const device = await h.connect(paired.deviceToken);
    await expect(device.client.request("session/delete", { sessionId: "s1" })).resolves.toEqual({ ok: true });
    for (const operation of MOBILE_FORBIDDEN_OPERATIONS) {
      expect(profileAllowsOperation({ kind: "pairing", tokenHash: "x", principal: { subject: "p", roles: [] } }, operation)).toBe(true);
    }
  });
});
