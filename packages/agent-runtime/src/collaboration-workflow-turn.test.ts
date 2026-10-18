import { expect, it } from "vitest";
import type { CollaborationSettings } from "@pi-desktop/shared";
import { CollaborationWorkflowTurn } from "./collaboration-workflow-turn.js";
import { verificationVerdict, workflowCommandEvidence } from "./collaboration-workflow-evidence.js";
import type { WorkflowDelegateResult, WorkflowJob } from "./collaboration-workflow.js";

const settings: CollaborationSettings = { mode: "auto", workflow: "standard", codingMode: "auto",
  executionModel: "claude/model", reviewModel: "pro/model", maxConcurrency: 2 };
const plan = JSON.stringify({ summary: "Current implementation", acceptance: ["The complete API passes its tests"], tasks: [] });
const pass = JSON.stringify({ status: "completed", verdict: "pass", summary: "Verified original requirements." });
const blocked = JSON.stringify({ verdict: "inconclusive", summary: "Required service is unavailable." });
const command = { command: "node --test", exitCode: 0, ok: true };
const evidence = (report = pass, commands: WorkflowDelegateResult["commands"] = [command]): WorkflowDelegateResult => ({ status: "completed", report, commands, toolCalls: 1, readCalls: 1 });

it("reserves the turn while binding and freezes the workspace across verification retries", async () => {
  const turn = new CollaborationWorkflowTurn();
  let release!: (root: string) => void;
  const binding = new Promise<string>(resolve => { release = resolve; });
  const jobs: WorkflowJob[] = [];
  const delegate = async (job: WorkflowJob) => { jobs.push(job); return evidence(job.phase === "Plan" ? plan : blocked); };
  const first = turn.execute(settings, { task: "Verify" }, "W=/repo/target", delegate, () => {}, undefined, () => binding);
  await expect(turn.execute(settings, { task: "Competing" }, "", delegate, () => {})).rejects.toThrow("already running");
  release("/repo/target");
  expect((await first).workspaceRoot).toBe("/repo/target");
  expect(jobs.every(job => job.workspaceRoot === "/repo/target")).toBe(true);
  await expect(turn.execute(settings, { task: "Retry", retry: "verify", retryReason: "Ready", workspace: "/repo/main" }, "", delegate, () => {})).rejects.toThrow("workspace");
});

it("fails binding before starting any child and does not silently fall back to the parent", async () => {
  const turn = new CollaborationWorkflowTurn();
  let started = false;
  const output = await turn.execute(settings, { task: "Implement", workspace: "/gone" }, "", async () => { started = true; return evidence(); }, () => {}, undefined,
    async () => { throw new Error("Target worktree disappeared"); });
  expect(started).toBe(false);
  expect(output.failureCode).toBe("COLLABORATION_WORKSPACE_BLOCKED");
  expect(output.error).toContain("/gone");
  expect(output.error).toContain("disappeared");
  expect(turn.running).toBe(false);
});

it("runs a real bounded verification retry with frozen requirements, settings and repair budget", async () => {
  const turn = new CollaborationWorkflowTurn();
  const jobs: WorkflowJob[] = [];
  let restored = false;
  const delegate = async (job: WorkflowJob) => {
    jobs.push(job);
    return evidence(job.phase === "Plan" ? plan : job.phase === "Test" && !restored ? blocked : pass);
  };
  const first = await turn.execute(settings, { task: "Verify the complete API" }, "Do not edit files", delegate, () => {});
  expect(first.status).toBe("failed");
  const count = jobs.length;
  expect((await turn.execute(settings, { task: "Different narrow task" }, "", delegate, () => {})).status).toBe("failed");
  expect(jobs).toHaveLength(count);
  restored = true;
  const final = await turn.execute({ ...settings, workflow: "quick", reviewModel: "wrong/channel" },
    { task: "This must not replace the original task", retry: "verify", retryReason: "The required service is ready" }, "Changed user request", delegate, () => {});
  expect(final.status).toBe("completed");
  expect(final.preset).toBe("standard");
  expect(final.plan?.acceptance).toEqual(["The complete API passes its tests"]);
  expect(final.repairRounds).toBe(first.repairRounds);
  expect(final.stages.map(stage => stage.id).length).toBe(new Set(final.stages.map(stage => stage.id)).size);
  expect(jobs.slice(count).map(job => job.phase)).toEqual(["Review", "Test"]);
  expect(jobs.slice(count).every(job => job.task.includes("Do not edit files") && !job.task.includes("This must not replace"))).toBe(true);
  expect(final.stages.find(stage => stage.phase === "Test")?.status).toBe("failed");
});

it("rejects preset/read-only overrides and a second verification retry without starting work", async () => {
  const turn = new CollaborationWorkflowTurn();
  const jobs: string[] = [];
  const delegate = async (job: WorkflowJob) => { jobs.push(job.phase); return evidence(job.phase === "Plan" ? plan : job.phase === "Test" ? blocked : pass); };
  await turn.execute(settings, { task: "Verify" }, "Full scope", delegate, () => {});
  for (const override of [{ preset: "quick" }, { readOnly: true }, { retryReason: "" }]) {
    const count = jobs.length;
    await expect(turn.execute(settings, { task: "Verify", retry: "verify", retryReason: "Service restored", ...override }, "", delegate, () => {})).rejects.toThrow();
    expect(jobs).toHaveLength(count);
  }
  await turn.execute(settings, { task: "Verify", retry: "verify", retryReason: "Service restored" }, "", delegate, () => {});
  const count = jobs.length;
  await expect(turn.execute(settings, { task: "Verify", retry: "verify", retryReason: "Again" }, "", delegate, () => {})).rejects.toThrow("already used");
  expect(jobs).toHaveLength(count);
});

it("never uses verification retry to bypass a rejected plan or cancelled run", async () => {
  const turn = new CollaborationWorkflowTurn();
  const delegate = async () => evidence("invalid plan");
  await turn.execute(settings, { task: "Implement" }, "Full scope", delegate, () => {});
  await expect(turn.execute(settings, { task: "Verify", retry: "verify", retryReason: "Skip planning" }, "", delegate, () => {})).rejects.toThrow("settled, failed verification");
});

it("does not erase a genuine test failure with pwd, narrower flags, another cwd or explicit fail", () => {
  const failure = { command: "cd backend && go test -tags unit ./...", exitCode: 1, ok: false };
  for (const replacement of ["pwd", "cd backend && go test ./...", "cd other && go test -tags unit ./..."]) {
    expect(verificationVerdict(evidence(pass, [failure, { ...command, command: replacement }]), true).verdict).toBe("fail");
  }
  expect(verificationVerdict(evidence('{"verdict":"fail","summary":"Assertion is still failing."}',
    [failure, { ...failure, exitCode: 0, ok: true }]), true).verdict).toBe("fail");
});

it("retains missing, denied, truncated and complex-shell evidence as blockers", () => {
  for (const failed of [{ ...command, exitCode: null }, { ...command, ok: false }]) {
    expect(verificationVerdict(evidence(pass, [failed, command]), true).verdict).toBe("inconclusive");
  }
  const commands = [
    { command: "GOTOOLCHAIN=local go test './...'", exitCode: 1, ok: false },
    { command: "go test './...'", exitCode: 0, ok: true },
  ];
  expect(verificationVerdict(evidence(pass, commands), true).verdict).toBe("fail");
});

it("allows the same Python module and arguments under an existing interpreter, but never a different runner", () => {
  const first = { command: "cd bridge && python -m unittest test_bridge.py", exitCode: 127, ok: false };
  expect(verificationVerdict(evidence(pass, [first,
    { ...command, command: "cd bridge && .venv/bin/python3 -m unittest test_bridge.py" }]), true).verdict).toBe("pass");
  expect(verificationVerdict(evidence(pass, [first,
    { ...command, command: "cd bridge && python3 -m pytest test_bridge.py" }]), true).verdict).toBe("inconclusive");
});


it("cannot clear a real Python-version or Go-toolchain failure with another runtime", () => {
  for (const [first, second] of [
    ["python3.13 -m unittest test_parser.py", "python3.9 -m unittest test_parser.py"],
    ["GOTOOLCHAIN=local go test ./...", "go test ./..."],
  ]) {
    const failed = workflowCommandEvidence(first, { exitCode: 1, stderr: "Assertion failed" }, false);
    const passed = workflowCommandEvidence(second, { exitCode: 0 }, true);
    expect(verificationVerdict(evidence(pass, [failed, passed]), true).verdict).toBe("fail");
  }
});

it("command truncation cannot merge distinct tests with the same long prefix", () => {
  const prefix = "node --test " + "a".repeat(3000);
  const failed = workflowCommandEvidence(prefix + "-failing.mjs", { exitCode: 1 }, true);
  const passed = workflowCommandEvidence(prefix + "-passing.mjs", { exitCode: 0 }, true);
  expect(failed.command).toBe(passed.command);
  expect(failed.truncated).toBe(true);
  expect(verificationVerdict(evidence(pass, [failed, passed]), true).verdict).toBe("inconclusive");
});


it("cannot skip a failed repair plan or failed repair writer using old verification history", async () => {
  for (const repairFailure of ["plan", "writer"]) {
    const turn = new CollaborationWorkflowTurn();
    const jobs: WorkflowJob[] = [];
    const writablePlan = JSON.stringify({ summary: "Fix", acceptance: ["Original requirements"], tasks: [
      { id: "fix", role: "primary", task: "Fix app.txt", files: ["app.txt"], dependsOn: [] },
    ] });
    const delegate = async (job: WorkflowJob) => {
      jobs.push(job);
      if (job.phase === "Plan") return evidence(writablePlan);
      if (job.phase.startsWith("Repair plan")) return evidence(repairFailure === "plan" ? "invalid" : writablePlan);
      if (job.phase.startsWith("Fix")) throw new Error("Repair writer failed");
      return evidence(job.phase === "Test" ? '{"verdict":"fail","summary":"Required behavior is still broken."}' : pass);
    };
    const result = await turn.execute(settings, { task: "Fix" }, "Original task", delegate, () => {});
    expect(result.status).toBe("failed");
    expect(result.stages.some(stage => stage.phase === "Test")).toBe(true);
    const count = jobs.length;
    await expect(turn.execute(settings, { task: "Verify", retry: "verify", retryReason: "Skip repair failure" }, "", delegate, () => {})).rejects.toThrow("Planning or coding failures");
    expect(jobs).toHaveLength(count);
  }
});
