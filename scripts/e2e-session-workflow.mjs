/** Real host RPC: conversation isolation, restart, forks and configuration locks. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const dataDir = mkdtempSync(join(tmpdir(), "pi-session-workflow-"));
const host = new Host(resolveHostBinary(), dataDir);
const automatic = {
  mode: "auto", workflow: "auto", codingMode: "auto", maxConcurrency: 8,
  executionModel: "claude/opus", reviewModel: "pro/gpt",
};
const locked = { ...automatic, workflow: "deep" };
const get = async sessionId => (await host.call("session.workflow.get", { sessionId })).settings;
const set = (sessionId, settings) => host.call("session.workflow.set", { sessionId, settings });
const blocked = sessionId => assert.rejects(set(sessionId, automatic), error => error.errorCode === "PLAN_CONFIGURATION_BLOCKED");
try {
  await host.start();
  await host.call("settings.set", { collaboration: { ...locked, workflow: "review", codingMode: "primary" } });
  const original = await host.call("settings.get");
  const a = (await host.call("session.create", { mode: "agent", title: "Automatic", collaboration: automatic })).session.id;
  const b = (await host.call("session.create", { mode: "agent", title: "Legacy review" })).session.id;
  assert.deepEqual(await get(a), automatic);
  assert.equal((await get(b)).workflow, "review");
  assert.equal((await get(b)).codingMode, "primary");
  await set(a, locked);
  await assert.rejects(set(a, { ...automatic, workflow: "invalid" }), error => error.errorCode === "INVALID_PARAMS");
  await assert.rejects(get("missing"), error => error.errorCode === "NOT_FOUND");
  assert.deepEqual(await get(a), locked);
  const turn = await host.call("session.beginTurn", { sessionId: a });
  await blocked(a);
  await host.call("session.appendMessage", { sessionId: a, turnId: turn.turnId, message: {
    id: randomUUID(), role: "user", content: "Retain this transcript", createdAt: new Date().toISOString(), status: "complete",
  } });
  await host.call("session.endTurn", { turnId: turn.turnId, status: "completed", createNotification: false });
  const fork = (await host.call("session.fork", { sessionId: a, title: "Fork" })).session;
  assert.deepEqual(await get(fork.id), locked);
  assert.equal(fork.messages[0].content, "Retain this transcript");
  await set(a, automatic);
  assert.deepEqual(await get(fork.id), locked);
  await host.restart();
  assert.deepEqual(await get(a), automatic);
  assert.deepEqual(await get(fork.id), locked);
  assert.equal((await get(b)).workflow, "review");
  assert.deepEqual(await host.call("settings.get"), original);
  console.log("PASS E2E-session-workflow-isolation-restart-fork: choices persist independently; history and global preferences preserved");

  const plan = (await host.call("session.create", { mode: "plan", projectPath: dataDir, collaboration: locked })).session.id;
  const planTurn = await host.call("session.beginTurn", { sessionId: plan });
  const proposal = (await host.call("plans.submit", {
    sessionId: plan, turnId: planTurn.turnId, toolCallId: "submit", title: "Guard test", markdown: "# Plan\n- Check configuration locks", question: "Proceed?",
  })).proposal;
  await host.call("session.endTurn", { turnId: planTurn.turnId, status: "completed", createNotification: false });
  await blocked(plan);
  const resolved = await host.call("plans.resolve", {
    proposalId: proposal.id, sessionId: plan, turnId: planTurn.turnId, toolCallId: "submit", version: proposal.version, action: "approve", targetPermissionMode: "auto",
  });
  await blocked(plan);
  await host.call("plans.claimExecution", { executionId: resolved.execution.id });
  await blocked(plan);
  await host.call("plans.finishExecution", { executionId: resolved.execution.id, status: "completed" });
  await set(plan, automatic);
  await host.call("session.delete", { id: a });
  await assert.rejects(get(a), error => error.errorCode === "NOT_FOUND");
  assert.deepEqual(await get(fork.id), locked);
  console.log("PASS E2E-session-workflow-busy-validation-delete: running turns, pending plans and queued/running execution block changes; other sessions survive deletion");
} finally {
  await host.stop();
  rmSync(dataDir, { recursive: true, force: true });
}
