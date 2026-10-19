import { describe, expect, it } from "vitest";
import type { AskToolResolution, RacpEventEnvelope } from "@pi-desktop/shared";

import { AgentHost } from "./agent-host.js";
import type { ApprovalPort } from "./approvals.js";
import type { Principal, RuntimePort, SessionPort, SessionSummary } from "./ports.js";

const runtime: RuntimePort = {
  async prompt() {
    return { turnId: "rt_1" };
  },
  async stop() {
    return { requested: true };
  },
  async abort() {},
  async respondInput(_resolution: AskToolResolution) {},
};

const session: SessionSummary = {
  id: "s1",
  title: "Session",
  mode: "plan",
  permissionMode: "auto",
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:00:00.000Z",
};

function build() {
  const contracts: string[] = [];
  const tools: string[] = [];
  const sessions: SessionPort = {
    async get() {
      return session;
    },
    async history() {
      return { items: [], hasMore: false };
    },
  };
  const approvals: ApprovalPort = {
    async resolveTool(_requestId, decision) {
      tools.push(decision);
    },
    async resolveContract(input) {
      contracts.push(input.action);
    },
    async listPendingTools() {
      return [];
    },
  };
  return { host: new AgentHost({ runtime, sessions, approvals }), contracts, tools };
}

const phone: Principal = { subject: "dev_phone", roles: ["controller", "approver"], pairedDevice: false, mobile: true };
const desktop: Principal = { subject: "desktop", roles: ["owner"], pairedDevice: true };
const context = { requestId: "r" };

describe("mobile principal policy in the Agent Host", () => {
  it("runs a phone turn under the ask ceiling even when the session is auto", async () => {
    const { host } = build();
    const started = await host.startTurn(phone, { sessionId: "s1", input: { text: "go" }, context });
    expect(started.turn.effectivePermissionMode).toBe("ask");
    const own = await host.startTurn(desktop, { sessionId: "s1", admission: "queue", input: { text: "go" }, context: { requestId: "r2" } });
    expect(own.turn.effectivePermissionMode).toBe("auto");
  });

  it("refuses a phone's contract approval and allow-session, but not its rejection or allow-once", async () => {
    const { host, contracts, tools } = build();
    host.approvals.fromPlanningState(
      { sessionId: "s1", state: "awaiting_approval", proposalId: "plan_1", kind: "plan", title: "Plan" },
      { turnId: "t1", revision: 1, lifetimeMs: 60_000 },
    );
    await expect(host.respondApproval(phone, { approvalId: "plan_1", decision: "approve", permissionMode: "ask", context })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await host.respondApproval(phone, { approvalId: "plan_1", decision: "reject", context });
    expect(contracts).toEqual(["reject"]);

    host.approvals.fromToolPermission(
      { requestId: "perm_1", sessionId: "s1", toolCallId: "call_1", toolName: "Bash", argsPreview: null, reason: "x", risk: "high" },
      { turnId: "t1", revision: 2, lifetimeMs: 60_000, allowSession: true },
    );
    await expect(host.respondApproval(phone, { approvalId: "perm_1", decision: "allow-session", context })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await host.respondApproval(phone, { approvalId: "perm_1", decision: "allow-once", context });
    expect(tools).toEqual(["allow-once"]);
  });

  it("lets an observer see every published envelope and stop observing", () => {
    const { host } = build();
    const seen: RacpEventEnvelope[] = [];
    const stop = host.hub.observe((envelope) => seen.push(envelope));
    host.hub.observe(() => {
      throw new Error("a failing observer must not break delivery");
    });
    host.hub.publish({ scope: "session", sessionId: "s1", kind: "turn.completed", payload: {}, revision: 1 });
    stop();
    host.hub.publish({ scope: "session", sessionId: "s1", kind: "turn.failed", payload: {}, revision: 2 });
    expect(seen.map((envelope) => envelope.kind)).toEqual(["turn.completed"]);
  });
});
