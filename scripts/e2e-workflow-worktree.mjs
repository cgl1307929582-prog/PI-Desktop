/** Real host/tool routing with deterministic model replies and throwaway Git worktrees. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { DesktopAgentRuntime, loadInstructionChain } from "../packages/agent-runtime/dist/index.js";
import { collaborationDefinitions } from "../packages/shared/dist/index.js";

const temp = realpathSync(mkdtempSync(join(tmpdir(), "pi-workflow-binding-")));
const main = join(temp, "main"), target = join(temp, "target"), other = join(temp, "other");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
mkdirSync(main); mkdirSync(other);
for (const root of [main, other]) {
  git(root, "init", "-qb", "main"); git(root, "config", "user.name", "PI workflow fixture"); git(root, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "AGENTS.md"), "MAIN_ONLY_INSTRUCTION: do not edit this checkout.\n");
  writeFileSync(join(root, "app.txt"), "old\n"); writeFileSync(join(root, "api.txt"), "old\n");
  git(root, "add", "AGENTS.md", "app.txt", "api.txt"); git(root, "commit", "-qm", "Fixture");
}
git(main, "worktree", "add", "-qb", "target", target);
writeFileSync(join(target, "AGENTS.md"), "TARGET_ONLY_INSTRUCTION: only app.txt and api.txt may be edited.\n");
const host = new Host(resolveHostBinary(), join(temp, "data"), { quiet: true });
const settings = { mode: "auto", workflow: "standard", codingMode: "split", executionModel: "claude/implement", reviewModel: "pro/review", maxConcurrency: 2 };
const pass = JSON.stringify({ verdict: "pass", summary: "Read both target files; independently checked the requested changes." });
const done = JSON.stringify({ status: "completed", summary: "Changed only the assigned file in the bound target worktree." });
const calls = [], requests = [], events = [];
let blocked = false;
const plan = JSON.stringify({ summary: "Two independent file changes", acceptance: ["app.txt and api.txt contain fixed; main is unchanged"], tasks: [
  { id: "web", role: "frontend", task: "Change app.txt to fixed", files: ["app.txt"], dependsOn: [] },
  { id: "api", role: "backend", task: "Change api.txt to fixed", files: ["api.txt"], dependsOn: ["web"] },
] });
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString()); requests.push(payload);
  const context = JSON.stringify(payload.messages), toolCount = payload.messages.filter(message => message.role === "tool").length;
  let reply;
  if (payload.model === "parent") reply = payload.messages.slice(payload.messages.findLastIndex(message => message.role === "user")).some(message => message.role === "tool") ? "Workflow finished." : [{ name: "CollaborationWorkflow", arguments: { task: "Change only app.txt and api.txt to fixed; preserve the main checkout." } }];
  else if (context.includes("Produce an implementation plan")) reply = toolCount ? plan : [{ name: "Read", arguments: { path: "app.txt" } }];
  else if (context.includes("Your assignment:")) {
    assert.ok(context.includes("TARGET_ONLY_INSTRUCTION")); assert.ok(!context.includes("MAIN_ONLY_INSTRUCTION"));
    reply = toolCount ? done : [{ name: payload.model === "implement" ? "Write" : "Edit", arguments: payload.model === "implement"
      ? { path: blocked ? join(main, "app.txt") : join(target, "app.txt"), content: "fixed\n" }
      : { path: "api.txt", old_string: "old", new_string: "fixed" } }];
  } else if (context.includes("Your stage is automated test execution")) reply = toolCount ? pass : [{ name: "Bash", arguments: {
    command: `test "$PWD" = '${target}' && test "$(cat app.txt)" = fixed && test "$(cat api.txt)" = fixed`,
  } }];
  else reply = toolCount ? pass : [
    { name: "Read", arguments: { path: "app.txt" } },
    { name: "Glob", arguments: { pattern: "*.txt" } },
    { name: "Grep", arguments: { pattern: "fixed", path: "api.txt" } },
  ];
  const delta = typeof reply === "string" ? { role: "assistant", content: reply } : { role: "assistant", tool_calls: reply.map((call, index) => ({ index, id: randomUUID(), type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: typeof reply === "string" ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
});
let runtime;
try {
  await host.start(); await host.call("settings.set", { defaultPermissionMode: "auto" });
  const { session } = await host.call("session.create", { title: "Workflow worktree fixture", projectPath: main, mode: "agent" });
  assert.equal((await host.call("worktree.workflow.resolve", { sessionId: session.id, request: `Implement\nW=${target}` })).workspaceRoot, target);
  await assert.rejects(host.call("worktree.workflow.resolve", { sessionId: session.id, workspace: other }), /registered worktree/);
  await assert.rejects(host.call("worktree.workflow.resolve", { sessionId: session.id, workspace: join(temp, "gone") }), /missing/);
  await assert.rejects(host.call("tools.execute", { sessionId: session.id, toolCallId: randomUUID(), toolName: "Write", mode: "agent", workflowWorkspace: other, args: { path: "unapproved.txt", content: "bad" } }), /registered worktree/);
  assert.equal(existsSync(join(other, "unapproved.txt")), false);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const provider = (id, modelId) => ({ id, name: id, modelId, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiStyle: "openai-chat", authKind: "none", apiKey: "", supportsReasoning: false, supportedThinkingLevels: ["off"] });
  runtime = new DesktopAgentRuntime({ sessionId: session.id, mode: "agent", projectPath: main, provider: provider("parent", "parent"), thinkingLevel: "off",
    collaboration: settings, subagents: collaborationDefinitions(settings), subagentProviders: { "claude/implement": provider("claude", "implement"), "pro/review": provider("pro", "review") },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true }, onEvent: event => events.push(event),
    host: { call: async (method, params) => {
      if (method === "project.instructions.resolve") {
        const { workspaceRoot } = await host.call("worktree.workflow.resolve", { sessionId: session.id, workspace: params.workflowWorkspace, delegationId: params.delegationId });
        return loadInstructionChain(workspaceRoot, params.path);
      }
      const result = await host.call(method, params);
      if (method === "tools.execute") calls.push({ params, result });
      return result;
    } },
  });
  const prompt = `Implement the two file changes and independently review/test them.\nW=${target}`;
  await runtime.prompt(prompt);
  assert.equal(events.some(({ event }) => event.type === "error"), false, JSON.stringify(events.filter(({ event }) => event.type === "error")));
  for (const file of ["app.txt", "api.txt"]) { assert.equal(readFileSync(join(target, file), "utf8"), "fixed\n"); assert.equal(readFileSync(join(main, file), "utf8"), "old\n"); }
  assert.equal(git(main, "status", "--porcelain"), "");
  assert.ok(calls.some(({ params, result }) => params.toolName === "Bash" && result.ok && result.content.exitCode === 0));
  assert.ok(calls.every(({ params }) => params.workflowWorkspace === target));
  for (const tool of ["Read", "Write", "Edit", "Grep", "Glob", "Bash"]) assert.ok(calls.some(({ params }) => params.toolName === tool), tool);
  blocked = true; const before = requests.length, beforeCalls = calls.length;
  await runtime.prompt(prompt);
  const failure = events.findLast(({ event }) => event.type === "error");
  assert.equal(failure?.event.error.code, "COLLABORATION_IMPLEMENTATION_BLOCKED");
  assert.ok(!requests.slice(before).some(request => JSON.stringify(request.messages).includes("Your stage is source review only")));
  assert.ok(!calls.slice(beforeCalls).some(({ params }) => ["Write", "Edit", "Bash"].includes(params.toolName)));
  assert.equal(git(main, "status", "--porcelain"), "");
  assert.equal((await host.call("session.list")).sessions.length, 1);
  console.log("PASS: real host worktree routing, target instructions, all six tools, unchanged main, unrelated/missing roots rejected, blocked coding stops dependencies and checks, one parent conversation.");
} finally {
  await runtime?.dispose(); server.closeAllConnections(); server.close(); await host.stop();
  rmSync(temp, { recursive: true, force: true });
}
