import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { collaborationDefinitions, type AgentEventEnvelope, type CollaborationSettings } from "@pi-desktop/shared";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";

type Call = { name: string; arguments: Record<string, unknown> };
type Reply = string | Call[];
type Request = { model: string; messages: unknown[] };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const settings: CollaborationSettings = { mode: "auto", executionModel: "claude/implement", reviewModel: "pro/review", maxConcurrency: 8 };
const delegate = (extra: Record<string, unknown> = {}): Call[] => [{ name: "Task", arguments: { agent: "collaboration-executor", task: "Fix app.txt in the workspace. Write fixed and report.", ...extra } }];
const write = (content = "fixed"): Call[] => [{ name: "Write", arguments: { path: "app.txt", content } }];
const read: Call[] = [{ name: "Read", arguments: { path: "app.txt" } }];
const pass = '{"verdict":"pass","summary":"Read app.txt:1; it contains the requested fix."}';
const fail = '{"verdict":"fail","summary":"app.txt:1 still contains the old behavior; repair it."}';

async function fixture(replies: Record<string, Reply[]> | ((request: Request) => Reply), collaboration = settings, beforeReview?: () => Promise<void>, isolated = false,
  bashResult = { exitCode: 0, stdout: "Fixture checks passed.", stderr: "" }, beforeHost?: (method: string, input: unknown) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "pi-collaboration-"));
  await writeFile(join(workspace, "app.txt"), "old");
  const requests: Request[] = [];
  const events: AgentEventEnvelope[] = [];
  const executed: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString()) as Request;
    requests.push(payload);
    if (payload.model === "review") await beforeReview?.();
    if (res.destroyed) return;
    const reply = typeof replies === "function" ? replies(payload) : replies[payload.model]?.shift() ?? "Finished.";
    const delta = typeof reply === "string" ? { role: "assistant", content: reply }
      : { role: "assistant", tool_calls: reply.map((call, index) => ({ index, id: randomUUID(), type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: typeof reply === "string" ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const provider = (id: string, modelId: string): RuntimeProviderConfig => ({
    id, name: id, modelId, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", authKind: "none",
    apiStyle: "openai-chat", supportsReasoning: false, supportedThinkingLevels: ["off"],
  });
  const runtime = new DesktopAgentRuntime({
    sessionId: "collaboration-fixture", mode: "agent", provider: provider("parent", "parent"),
    thinkingLevel: "off", projectPath: workspace, collaboration,
    ...(isolated ? { workspaceRoot: workspace } : {}),
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    subagents: collaborationDefinitions(collaboration),
    subagentProviders: { "claude/implement": provider("claude", "implement"), "pro/review": provider("pro", "review") },
    onEvent: (event) => events.push(event),
    host: { call: async <T>(method: string, input?: unknown): Promise<T> => {
      await beforeHost?.(method, input);
      if (method === "project.instructions.resolve") return undefined as T;
      if (method === "worktree.delegate.settle") return { settlement: { result: "noChanges" } } as T;
      if (method === "tools.execute") {
        const call = input as { toolName: string; args: { path: string; content?: string } };
        executed.push(call.toolName);
        if (call.toolName === "Write") await writeFile(join(workspace, call.args.path), call.args.content ?? "");
        const content = call.toolName === "Read" ? await readFile(join(workspace, call.args.path), "utf8")
          : call.toolName === "Bash" ? bashResult : "success";
        return { ok: call.toolName !== "Bash" || bashResult.exitCode === 0,
          ...(call.toolName === "Bash" && bashResult.exitCode !== 0 ? { isError: true, errorCode: "TOOL_FAILED" } : {}), content } as T;
      }
      return {} as T;
    } },
  });
  cleanups.push(async () => {
    await runtime.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workspace, { recursive: true, force: true });
  });
  return { runtime, requests, events, executed, workspace };
}

it("ordinary task runs the pinned executor and automatic reviewer inside the parent before final completion", async () => {
  const f = await fixture({ parent: [delegate(), "Done after independent review."], implement: [write(), "Implemented."], review: [read, pass] });
  await f.runtime.prompt("Please fix app.txt.");
  expect(await readFile(join(f.workspace, "app.txt"), "utf8"), JSON.stringify(f.events.filter(({ event }) => event.type === "tool_end" || event.type === "error"))).toBe("fixed");
  expect(f.requests.map((request) => request.model)).toEqual(["parent", "implement", "implement", "review", "review", "parent"]);
  expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain("Independent review: passed");
  expect(f.events.filter(({ event }) => event.type === "error")).toEqual([]);
  const children = f.events.filter((event) => event.agentName);
  expect(children.length).toBeGreaterThan(0);
  expect(children.every((event) => !!event.parentToolCallId && event.sessionId === "collaboration-fixture")).toBe(true);
}, 15_000);

it("off preserves direct execution without a reviewer", async () => {
  const f = await fixture({ parent: [write(), "Done."] }, { ...settings, mode: "off" });
  await f.runtime.prompt("Please fix app.txt.");
  expect(f.executed).toEqual(["Write"]);
  expect(f.requests.every((request) => request.model === "parent")).toBe(true);
});

it("blocks parent writes and rejects a different model for the execution role", async () => {
  const f = await fixture({ parent: [write(), delegate({ model: "pro/review" }), "Unable to execute."] }, { ...settings, mode: "deep" });
  await f.runtime.prompt("Please fix app.txt.");
  expect(f.executed).toEqual([]);
  expect(f.requests.every((request) => request.model === "parent")).toBe(true);
  expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain("must use their configured model");
});

it.each([undefined, "adaptive", "quick", "standard", "deep"] as const)("auto handles a small edit and check directly with preset %s", async (workflow) => {
  const f = await fixture({ parent: [read, write(), [{ name: "Bash", arguments: { command: "node --test" } }], "Fixed and checked."] }, { ...settings, workflow });
  await f.runtime.prompt("Correct this one typo in app.txt and run its existing check.");
  expect(await readFile(join(f.workspace, "app.txt"), "utf8")).toBe("fixed");
  expect(f.executed).toEqual(["Read", "Write", "Bash"]);
  expect(f.requests.every(request => request.model === "parent")).toBe(true);
  expect(f.events.some(event => event.agentName)).toBe(false);
  expect(f.events.filter(({ event }) => event.type === "error")).toEqual([]);
});

it("auto does not engage collaboration after an invalid delegation", async () => {
  const f = await fixture({ parent: [delegate({ model: "pro/review" }), write(), "Fixed directly."] });
  await f.runtime.prompt("Fix app.txt.");
  expect(f.executed).toEqual(["Write"]);
  expect(f.events.some(event => event.agentName)).toBe(false);
});

it("auto reviews earlier parent edits after escalating and returns to direct work on the next turn", async () => {
  const f = await fixture({ parent: [write("partial"), delegate(), write("unreviewed"), "Done.", write("next turn"), "Done directly."], implement: [write(), "Implemented."], review: [read, pass] });
  await f.runtime.prompt("Fix app.txt, delegating if the change grows.");
  expect(await readFile(join(f.workspace, "app.txt"), "utf8")).toBe("fixed");
  expect(f.requests.some(request => request.model === "review" && JSON.stringify(request.messages).includes("app.txt"))).toBe(true);
  expect(f.events.filter(({ event }) => event.type === "error")).toEqual([]);
  const previousRequests = f.requests.length;
  await f.runtime.prompt("Now make one small follow-up edit.");
  expect(await readFile(join(f.workspace, "app.txt"), "utf8")).toBe("next turn");
  expect(f.requests.slice(previousRequests).every(request => request.model === "parent")).toBe(true);
}, 15_000);

it("the review preset remains read-only even when auto chooses direct analysis", async () => {
  const f = await fixture({ parent: [read, write(), [{ name: "Bash", arguments: { command: "touch forbidden" } }], "Analysis only."] }, { ...settings, workflow: "review" });
  await f.runtime.prompt("Review app.txt without changing anything.");
  expect(f.executed).toEqual(["Read"]);
  expect(await readFile(join(f.workspace, "app.txt"), "utf8")).toBe("old");
  expect(f.events.some(event => event.agentName)).toBe(false);
});

it("reports an unpassed review as a failed completion", async () => {
  const f = await fixture({ parent: [delegate(), "Done."], implement: [write(), "Implemented."], review: [read, fail] });
  await f.runtime.prompt("Please fix app.txt.");
  expect(f.requests.filter((request) => request.model === "review")).toHaveLength(2);
  expect(f.events.some(({ event }) => event.type === "error" && event.error.code === "COLLABORATION_REVIEW_FAILED")).toBe(true);
});

it("reviews the repaired files again instead of reusing the old result", async () => {
  const f = await fixture({ parent: [delegate(), delegate(), "Done."], implement: [write("first"), "Implemented.", write("fixed"), "Repaired."], review: [read, fail, read, pass] });
  await f.runtime.prompt("Please fix app.txt.");
  expect(f.requests.filter((request) => request.model === "review")).toHaveLength(4);
  expect(f.events.filter(({ event }) => event.type === "error")).toEqual([]);
  expect(await readFile(join(f.workspace, "app.txt"), "utf8")).toBe("fixed");
}, 15_000);

it("Stop cancels the automatic reviewer and does not resume the parent", async () => {
  let started!: () => void;
  let release!: () => void;
  const reviewing = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture({ parent: [delegate(), "Done."], implement: [write(), "Implemented."], review: [read, pass] }, settings,
    async () => { started(); await blocked; });
  const prompt = f.runtime.prompt("Please fix app.txt.");
  await reviewing;
  await f.runtime.abort();
  release();
  await prompt;
  expect(f.requests.filter((request) => request.model === "parent")).toHaveLength(1);
}, 15_000);

it("simple questions complete without creating or reviewing delegates", async () => {
  const f = await fixture({ parent: ["Hello."] });
  await f.runtime.prompt("Hi.");
  expect(f.requests.map(request => request.model)).toEqual(["parent"]);
  expect(f.events.some(event => event.agentName)).toBe(false);
});

it("counts worktree preparation toward the configured concurrency cap", async () => {
  const tasks = Array.from({ length: 9 }, () => delegate()[0]);
  const f = await fixture({ parent: [tasks, "Done."], implement: Array(8).fill("Read-only inspection complete.") }, settings, undefined, true);
  await f.runtime.prompt("Inspect nine independent aspects.");
  expect(f.requests.filter(request => request.model === "implement")).toHaveLength(8);
  expect(f.events.filter(({ event }) => event.type === "tool_end" && JSON.stringify(event.result).includes("8 subagents are already running"))).toHaveLength(1);
});

const workflowSettings: CollaborationSettings = { ...settings, workflow: "standard", codingMode: "split", maxConcurrency: 2 };
const workflowPlan = JSON.stringify({ summary: "Separate UI and API files.", acceptance: ["Both files fixed."], tasks: [
  { id: "web", role: "frontend", task: "Fix app.txt", files: ["app.txt"], dependsOn: [] },
  { id: "api", role: "backend", task: "Create api.txt", files: ["api.txt"], dependsOn: [] },
] });
function workflowReply(request: Request, options: { fakeTests?: boolean; fakeReview?: boolean; outsideScope?: boolean } = {}): Reply {
  const context = JSON.stringify(request.messages);
  const hasTool = request.messages.some(value => !!value && typeof value === "object" && "role" in value && value.role === "tool");
  if (request.model === "parent") return hasTool ? "The workflow is finished." : [
    { name: "CollaborationWorkflow", arguments: { task: "Fix the frontend and backend files." } },
  ];
  if (context.includes("Produce an implementation plan")) return hasTool ? workflowPlan : read;
  if (context.includes("Your assignment:")) return hasTool ? "Implemented." : [
    { name: "Write", arguments: { path: options.outsideScope ? "forbidden.txt" : request.model === "implement" ? "app.txt" : "api.txt", content: "fixed" } },
  ];
  if (context.includes("Your stage is automated test execution")) return hasTool || options.fakeTests ? pass : [
    { name: "Bash", arguments: { command: "node --test" } },
  ];
  if (context.includes("Your stage is source review only") && options.fakeReview) return hasTool ? pass : [
    { name: "Glob", arguments: { pattern: "**/*" } },
  ];
  return hasTool ? pass : read;
}

it("workflow runs GPT planning and backend coding, Claude frontend, and fresh GPT checks as native children", async () => {
  const f = await fixture(request => workflowReply(request), workflowSettings);
  await f.runtime.prompt("Fix the frontend and backend.");
  expect(await readFile(join(f.workspace, "app.txt"), "utf8")).toBe("fixed");
  expect(await readFile(join(f.workspace, "api.txt"), "utf8")).toBe("fixed");
  expect(f.executed).toContain("Bash");
  const children = f.events.filter(event => event.agentName);
  expect(new Set(children.map(event => event.agentName))).toEqual(new Set([
    "collaboration-analyst", "collaboration-executor", "collaboration-backend", "collaboration-verifier",
  ]));
  expect(children.every(event => event.sessionId === "collaboration-fixture" && !!event.parentToolCallId)).toBe(true);
  expect(f.events.filter(({ event }) => event.type === "error")).toEqual([]);
  expect(JSON.stringify(f.events)).toContain('"exitCode":0');
}, 20_000);

it("auto can escalate to a workflow, blocks unreviewed parent edits afterward, and reassesses next turn", async () => {
  const parent: Reply[] = [write("partial"), [{ name: "CollaborationWorkflow", arguments: { task: "Complete both files, including the partial parent edit in app.txt." } }], write("unreviewed"), "Workflow finished.", write("follow-up"), "Small follow-up done."];
  const f = await fixture(request => request.model === "parent" ? parent.shift() ?? "Done." : workflowReply(request), workflowSettings);
  await f.runtime.prompt("Fix both frontend and backend, collaborating if needed.");
  expect(await readFile(join(f.workspace, "app.txt"), "utf8")).toBe("fixed");
  expect(await readFile(join(f.workspace, "api.txt"), "utf8")).toBe("fixed");
  expect(f.executed.filter(name => name === "Write")).toHaveLength(3);
  expect(f.events.filter(({ event }) => event.type === "error")).toEqual([]);
  const previousRequests = f.requests.length;
  await f.runtime.prompt("Make one small follow-up edit.");
  expect(await readFile(join(f.workspace, "app.txt"), "utf8")).toBe("follow-up");
  expect(f.requests.slice(previousRequests).every(request => request.model === "parent")).toBe(true);
}, 20_000);

it("workflow recovers a planner's verification-only task before any native writer starts", async () => {
  const invalidPlan = JSON.parse(workflowPlan);
  invalidPlan.tasks.push({ id: "verify", role: "assist", task: "Independently verify.", files: [], dependsOn: ["web", "api"] });
  const f = await fixture(request => {
    const context = JSON.stringify(request.messages);
    if (context.includes("Produce an implementation plan") && !context.includes("Correct the rejected draft")) {
      return context.includes('"role":"tool"') ? JSON.stringify(invalidPlan) : read;
    }
    return workflowReply(request);
  }, workflowSettings);
  await f.runtime.prompt("Fix both files and independently verify.");
  expect(await readFile(join(f.workspace, "app.txt"), "utf8")).toBe("fixed");
  expect(await readFile(join(f.workspace, "api.txt"), "utf8")).toBe("fixed");
  const correction = f.requests.findIndex(request => JSON.stringify(request.messages).includes("Correct the rejected draft"));
  const coding = f.requests.findIndex(request => JSON.stringify(request.messages).includes("Your assignment:"));
  expect(correction).toBeGreaterThan(-1);
  expect(coding).toBeGreaterThan(correction);
  expect(JSON.stringify(f.requests[correction].messages)).toContain("tasks[2].files");
  expect(f.executed.filter(name => name === "Write")).toHaveLength(2);
  expect(f.executed).toContain("Bash");
  expect(f.events.filter(({ event }) => event.type === "error")).toEqual([]);
  expect(f.events.filter(event => event.agentName).every(event => event.sessionId === "collaboration-fixture" && !!event.parentToolCallId)).toBe(true);
}, 20_000);

it("workflow stops after bounded invalid-plan corrections without giving any child write access", async () => {
  const invalidPlan = JSON.parse(workflowPlan);
  invalidPlan.tasks[0].files = [];
  const f = await fixture(request => {
    if (request.model === "review") return JSON.stringify(request.messages).includes('"role":"tool"') ? JSON.stringify(invalidPlan) : read;
    return workflowReply(request);
  }, workflowSettings);
  await f.runtime.prompt("Fix both files.");
  expect(await readFile(join(f.workspace, "app.txt"), "utf8")).toBe("old");
  expect(f.executed).toEqual(["Read", "Read", "Read"]);
  expect(f.events.some(({ event }) => event.type === "error" && event.error.code === "COLLABORATION_PLAN_FAILED")).toBe(true);
  expect(JSON.stringify(f.events)).toContain("Planning remained invalid after two corrections");
}, 20_000);

it("workflow blocks direct Task bypass and out-of-scope file edits", async () => {
  const direct = await fixture({ parent: [delegate(), "Cannot bypass workflow."] }, workflowSettings);
  await direct.runtime.prompt("Fix files.");
  expect(direct.executed).toEqual([]);
  const scoped = await fixture(request => workflowReply(request, { outsideScope: true }), workflowSettings);
  await scoped.runtime.prompt("Fix files.");
  await expect(readFile(join(scoped.workspace, "forbidden.txt"))).rejects.toThrow();
  expect(scoped.executed).not.toContain("Write");
  expect(JSON.stringify(scoped.events)).toContain("assigned files");
}, 20_000);

it("workflow rejects a test pass claimed without any shell execution", async () => {
  const f = await fixture(request => workflowReply(request, { fakeTests: true }), workflowSettings);
  await f.runtime.prompt("Fix and test the project.");
  expect(f.executed).not.toContain("Bash");
  expect(f.events.some(({ event }) => event.type === "error" && event.error.code === "COLLABORATION_VERIFICATION_BLOCKED")).toBe(true);
}, 20_000);

it("workflow preserves a missing-dependency blocker and command evidence without repeating native writers", async () => {
  const f = await fixture(request => {
    const context = JSON.stringify(request.messages);
    if (context.includes("Your stage is automated test execution")) return context.includes('"role":"tool"')
      ? '{"verdict":"inconclusive","summary":"Bridge tests did not run because requests is missing. Prepare the documented environment and rerun unittest."}'
      : [{ name: "Bash", arguments: { command: "python3 -m unittest test_bridge.py" } }];
    return workflowReply(request);
  }, workflowSettings, undefined, false, { exitCode: 1, stdout: "", stderr: "ModuleNotFoundError: No module named 'requests'" });
  await f.runtime.prompt("Fix and test the project.");
  expect(f.executed.filter(name => name === "Write")).toHaveLength(2);
  expect(f.requests.some(request => JSON.stringify(request.messages).includes("Repair only these failures"))).toBe(false);
  const failure = f.events.find(({ event }) => event.type === "error" && event.error.code === "COLLABORATION_VERIFICATION_BLOCKED");
  expect(JSON.stringify(failure)).toContain("Verification is blocked");
  expect(JSON.stringify(failure)).toContain("requests is missing");
  expect(JSON.stringify(failure)).toContain("python3 -m unittest test_bridge.py");
  expect(JSON.stringify(f.events)).toContain('"repairRounds":0');
  expect(f.events.filter(event => event.agentName).every(event => event.sessionId === "collaboration-fixture" && !!event.parentToolCallId)).toBe(true);
}, 20_000);

it("workflow requires an observed source read even when a reviewer claims success after Glob", async () => {
  const f = await fixture(request => workflowReply(request, { fakeReview: true }), workflowSettings);
  await f.runtime.prompt("Fix and review the project.");
  expect(f.executed).toContain("Glob");
  expect(f.events.some(({ event }) => event.type === "error" && event.error.code === "COLLABORATION_VERIFICATION_BLOCKED")).toBe(true);
}, 20_000);

it("Stop during workflow planning prevents coding and parent continuation", async () => {
  let started!: () => void, release!: () => void;
  const planning = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(request => workflowReply(request), workflowSettings, async () => { started(); await blocked; });
  const prompt = f.runtime.prompt("Fix and test the project.");
  await planning;
  await f.runtime.abort();
  release();
  await prompt;
  expect(f.executed).not.toContain("Write");
  expect(f.requests.filter(request => request.model === "parent")).toHaveLength(1);
}, 15_000);

it("automatic workflows change per turn in one conversation while preserving model pins and solo follow-up", async () => {
  const choice = (preset: string): Call[] => [{ name: "CollaborationWorkflow", arguments: {
    task: "Implement the scoped frontend and backend request, or review without changes.", preset,
    reason: `This turn needs ${preset} because of its requested scope.`,
  } }];
  const replies: Reply[] = [choice("quick"), "Done.", choice("standard"), "Done.", choice("review"), "Reviewed.", write("follow-up"), "Done."];
  const automaticPlan = JSON.parse(workflowPlan);
  automaticPlan.tasks[0].role = "primary";
  automaticPlan.tasks[1].role = "collaboration";
  const f = await fixture(request => {
    if (request.model === "parent") return replies.shift() ?? "Done.";
    const context = JSON.stringify(request.messages);
    if (context.includes("Produce an implementation plan") && context.includes('"role":"tool"')) return JSON.stringify(automaticPlan);
    return workflowReply(request);
  }, { ...workflowSettings, workflow: "auto", codingMode: "auto" });
  await f.runtime.prompt("Repair the two scoped defects.");
  await f.runtime.prompt("Implement the next frontend and backend feature.");
  const writes = f.executed.filter(name => name === "Write").length;
  expect(writes).toBe(4);
  await f.runtime.prompt("Independently review current code without changes.");
  expect(f.executed.filter(name => name === "Write")).toHaveLength(writes);
  const previous = f.requests.length;
  await f.runtime.prompt("Make a small follow-up directly.");
  expect(f.requests.slice(previous).every(request => request.model === "parent")).toBe(true);
  expect(await readFile(join(f.workspace, "app.txt"), "utf8")).toBe("follow-up");
  const evidence = JSON.stringify(f.events);
  for (const preset of ["quick", "standard", "review"]) {
    expect(evidence).toContain(`This turn needs ${preset}`);
    expect(evidence).toContain(`"preset":"${preset}"`);
  }
  expect(evidence).toContain("collaboration-backend");
  expect(evidence).toContain("collaboration-executor");
  expect(f.events.filter(({ event }) => event.type === "error")).toEqual([]);
}, 30_000);

it("rejects a missing automatic routing reason without starting children or locking direct work", async () => {
  const f = await fixture({ parent: [[{ name: "CollaborationWorkflow", arguments: { task: "Fix app.txt", preset: "quick" } }], write(), "Done."] },
    { ...workflowSettings, workflow: "auto" });
  await f.runtime.prompt("Fix a small typo.");
  expect(f.requests.every(request => request.model === "parent")).toBe(true);
  expect(f.executed).toEqual(["Write"]);
  expect(JSON.stringify(f.events)).toContain("concrete reason");
});

it("a manually locked workflow refuses a model override before running the selected recipe", async () => {
  const replies: Reply[] = [
    [{ name: "CollaborationWorkflow", arguments: { task: "Fix both files", preset: "deep", reason: "Prefer more checks" } }],
    [{ name: "CollaborationWorkflow", arguments: { task: "Fix both files" } }], "Done.",
  ];
  const f = await fixture(request => request.model === "parent" ? replies.shift() ?? "Done." : workflowReply(request), workflowSettings);
  await f.runtime.prompt("Implement this feature.");
  expect(JSON.stringify(f.events)).toContain("locked to standard");
  expect(f.requests.some(request => JSON.stringify(request.messages).includes("check this plan against the task"))).toBe(false);
  expect(f.executed.filter(name => name === "Write")).toHaveLength(2);
  expect(f.events.filter(({ event }) => event.type === "error")).toEqual([]);
}, 20_000);


it("retries failed native verification in the same turn without cached failure, extra writers or new sessions", async () => {
  let reviews = 0;
  const parent: Reply[] = [
    [{ name: "CollaborationWorkflow", arguments: { task: "Fix both files and verify the full scope" } }],
    [{ name: "CollaborationWorkflow", arguments: { task: "Repeated ordinary invocation" } }],
    [{ name: "CollaborationWorkflow", arguments: { task: "Reverify", retry: "verify", retryReason: "Review requested an unrequired historical baseline; inspect current source against the original task" } }],
    "Completed after fresh verification.",
  ];
  const f = await fixture(request => {
    if (request.model === "parent") return parent.shift() ?? "Done.";
    const context = JSON.stringify(request.messages);
    if (context.includes("Your stage is source review only") && context.includes('"role":"tool"')) {
      return ++reviews <= 2 ? '{"verdict":"inconclusive","summary":"No source defect; no historical dirty baseline."}' : pass;
    }
    return workflowReply(request);
  }, workflowSettings);
  await f.runtime.prompt("Fix both files and verify the original requirements.");
  expect(reviews).toBe(3);
  expect(f.executed.filter(name => name === "Write")).toHaveLength(2);
  expect(f.executed.filter(name => name === "Bash")).toHaveLength(2);
  expect(f.events.filter(({ event }) => event.type === "error")).toEqual([]);
  expect(f.events.filter(event => event.agentName).every(event => event.sessionId === "collaboration-fixture" && !!event.parentToolCallId)).toBe(true);
  expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain('verificationRetry');
}, 20_000);

it("Stop during native workflow tool execution waits for host abort acknowledgement before ending", async () => {
  let started!: () => void, aborted!: () => void, release!: () => void;
  const startedTool = new Promise<void>(resolve => { started = resolve; });
  const abortRequested = new Promise<void>(resolve => { aborted = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(request => {
    if (JSON.stringify(request.messages).includes("Your assignment:")) {
      return request.messages.some(value => !!value && typeof value === "object" && "role" in value && value.role === "tool")
        ? "Stopped" : [{ name: "Bash", arguments: { command: "node --test" } }];
    }
    return workflowReply(request);
  }, { ...workflowSettings, maxConcurrency: 1 }, undefined, false, undefined, async (method, input) => {
    if (method === "tools.execute" && (input as { toolName?: string })?.toolName === "Bash") { started(); await held; }
    if (method === "tools.abort") { aborted(); await held; }
  });
  let settled = false;
  const prompt = f.runtime.prompt("Fix both files.").finally(() => { settled = true; });
  await startedTool;
  const stopping = f.runtime.abort();
  await abortRequested;
  expect(settled).toBe(false);
  expect(f.requests.some(request => JSON.stringify(request.messages).includes("Your stage is source review only"))).toBe(false);
  release();
  await stopping;
  await prompt;
  expect(f.requests.filter(request => JSON.stringify(request.messages).includes("Your assignment:") && request.model === "review")).toHaveLength(0);
  expect(f.requests.filter(request => request.model === "parent")).toHaveLength(1);
}, 15_000);

it("Stop during workflow worktree preparation never sends a late coding request", async () => {
  let preparing!: () => void, release!: () => void;
  const prepared = new Promise<void>(resolve => { preparing = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(request => workflowReply(request), { ...workflowSettings, maxConcurrency: 1 }, undefined, true, undefined,
    async method => { if (method === "worktree.delegate.create") { preparing(); await held; } });
  const prompt = f.runtime.prompt("Implement both files in isolation.");
  await prepared;
  const stopping = f.runtime.abort();
  release();
  await stopping;
  await prompt;
  expect(f.requests.some(request => JSON.stringify(request.messages).includes("Your assignment:"))).toBe(false);
  expect(f.executed).not.toContain("Write");
}, 15_000);


it("a real host TOOL_FAILED exit 1 triggers bounded code repair rather than an environment blocker", async () => {
  const f = await fixture(request => {
    const context = JSON.stringify(request.messages);
    if (context.includes("Your stage is automated test execution") && context.includes('"role":"tool"')) return fail;
    return workflowReply(request);
  }, workflowSettings, undefined, false, { exitCode: 1, stdout: "", stderr: "AssertionError: expected fixed" });
  await f.runtime.prompt("Fix both files and pass their tests.");
  expect(f.executed.filter(name => name === "Write")).toHaveLength(6);
  expect(f.executed.filter(name => name === "Bash")).toHaveLength(3);
  expect(f.events.some(({ event }) => event.type === "error" && event.error.code === "COLLABORATION_CHECKS_FAILED")).toBe(true);
}, 20_000);
