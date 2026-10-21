import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { buildTranscriptEntries } = await import("../src/lib/assistant-turns.ts");
const { currentWork } = await import("../src/features/chat/transcript/current-work.ts");
const message = (id, role, content, extra = {}) => ({ id, role, content, createdAt: "2026-10-21T04:00:00Z", ...extra });
const tool = (id, name, extra = {}) => message(id, "tool", "", { toolName: name, toolCallId: id, toolStatus: "success", ...extra });
const entry = (messages) => buildTranscriptEntries(messages).entries.findLast((item) => item.kind === "assistant-turn");

test("current work follows the active tool, never private reasoning or completed commands", () => {
  const turn = entry([
    message("user", "user", "修复"),
    message("progress", "assistant", "通信层已完成，正在验证断线恢复。", { thinking: "private analysis" }),
    tool("read", "Read", { toolCompletedAt: "2026-10-21T04:00:02Z" }),
    tool("write", "Write", { toolStatus: "running", toolArgs: { path: "/workspace/ios/Sync.swift" } }),
  ]);
  const result = currentWork({ entry: turn, running: true });
  assert.equal(result.label, "chat.toolWriting");
  assert.equal(result.target, "Sync.swift");
  assert.equal(result.completedTools, 1);
  assert.equal(result.lastToolAt, Date.parse("2026-10-21T04:00:02Z"));
  assert.equal(result.progress, "通信层已完成，正在验证断线恢复。");
  assert(!JSON.stringify(result).includes("private analysis"));
});

test("approval overrides runtime wait and reading an older window cannot fabricate current work", () => {
  const activity = { phase: "waiting-model", since: 1000 };
  assert.equal(currentWork({ running: true, activity, awaiting: "permission" }).label, "chat.execution.waitingPermission");
  const result = currentWork({ running: true, activity });
  assert.equal(result.label, undefined);
  assert.equal(result.phaseStartedAt, 1000);
  assert.equal(result.progress, "");
  assert.deepEqual(result.agents, []);
});

test("parallel assignments use actual model and lifecycle settlement, not Task call duration", () => {
  const first = tool("task-a", "Task", {
    toolArgs: { agent: "frontend", description: "实现手机聊天界面" }, toolDurationMs: 4,
    toolResult: { details: { delegationId: "a", status: "running", startedAt: 1000, modelId: "claude-opus" } },
  });
  const second = tool("task-b", "Task", {
    toolArgs: { agent: "backend", description: "检查消息同步" },
    toolResult: { details: { delegationId: "b", status: "running", startedAt: 2000, modelId: "pro/gpt" } },
  });
  const wait = tool("wait", "TaskWait", { toolResult: { details: { delegations: [
    { delegationId: "a", status: "completed", startedAt: 1000, completedAt: 91000 },
    { delegationId: "b", status: "running", startedAt: 2000 },
  ] } } });
  let result = currentWork({ entry: entry([first, second, wait]), running: true });
  assert.equal(result.agents.length, 2);
  assert.deepEqual(result.agents.map((item) => [item.name, item.model, item.status]), [
    ["frontend", "claude-opus", "completed"], ["backend", "pro/gpt", "running"],
  ]);
  assert.equal(result.agents[0].completedAt - result.agents[0].startedAt, 90000);
  result = currentWork({ entry: entry([first, second, wait]), running: false });
  assert.equal(result.agents[1].status, "aborted");
});

test("terminal Task snapshot wins over old running snapshot and exposes the real blocker", () => {
  const task = tool("task", "Task", {
    toolArgs: { agent: "review", task: "审查当前修改" },
    toolResult: { details: { delegationId: "a", status: "failed", error: { code: "MISSING_TOOL", message: "Test runtime unavailable" } } },
  });
  const wait = tool("wait", "TaskWait", { toolResult: { details: { delegations: [{ delegationId: "a", status: "running" }] } } });
  const result = currentWork({ entry: entry([task, wait]), running: true });
  assert.equal(result.agents[0].status, "failed");
  assert.equal(result.agents[0].failure.code, "MISSING_TOOL");
  assert.equal(result.agents[0].model, "");
});
