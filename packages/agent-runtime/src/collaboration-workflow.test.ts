import { expect, it } from "vitest";
import { CollaborationWorkflowRunner, parseWorkflowPlan, assertWorkflowWritePath,
  type WorkflowTask, type WorkflowDelegateResult, type WorkflowJob } from "./collaboration-workflow.js";
import type { CollaborationSettings } from "@pi-desktop/shared";

const settings: CollaborationSettings = { mode: "auto", workflow: "standard", codingMode: "split",
  executionModel: "claude/model", reviewModel: "pro/model", maxConcurrency: 2 };
const task = (id: string, role: WorkflowTask["role"] = "frontend", files = [id + ".txt"], dependsOn: string[] = []): WorkflowTask =>
  ({ id, role, files, dependsOn, task: "Implement " + id });
const plan = (tasks: WorkflowTask[]) => JSON.stringify({ summary: "Agreed API", acceptance: ["Behavior works"], tasks });
const result = (report: string, commands: WorkflowDelegateResult["commands"] = []): WorkflowDelegateResult =>
  ({ status: "completed", report, commands, toolCalls: 1, readCalls: 1 });
const pass = JSON.stringify({ verdict: "pass", summary: "Inspected the relevant implementation." });
const testCommand = { command: "node --test", exitCode: 0, ok: true };

it("rejects unknown dependencies, cycles, unordered writers and unsafe file scopes before coding", () => {
  expect(() => parseWorkflowPlan(plan([task("one", "frontend", ["a"], ["missing"])]))).toThrow("unknown");
  expect(() => parseWorkflowPlan(plan([task("one", "frontend", ["a"], ["two"]), task("two", "backend", ["b"], ["one"])]))).toThrow("cycle");
  expect(() => parseWorkflowPlan(plan([task("one", "frontend", ["A"]), task("two", "backend", ["a"])]))).toThrow("Overlapping");
  for (const path of ["../a", "/a", "C:\\a", ".git/config", "src/*"]) {
    expect(() => parseWorkflowPlan(plan([task("one", "frontend", [path])]))).toThrow("workspace-relative");
  }
  expect(parseWorkflowPlan(plan([task("one", "backend", ["api.js"]), task("help", "assist", ["api.js"], ["one"])]))).toBeTruthy();
});

it("guards writes to a task's assigned files, including absolute paths", () => {
  expect(() => assertWorkflowWritePath(["src/api.ts"], "/repo/src/api.ts", "/repo")).not.toThrow();
  expect(() => assertWorkflowWritePath(["src/api.ts"], "../secret", "/repo")).toThrow("assigned files");
  expect(() => assertWorkflowWritePath(["src/api.ts"], "src/web.ts", "/repo")).toThrow("assigned files");
});

it("identifies the verification-only task's empty files without misnaming task as brief", () => {
  const invalid = plan([task("api", "backend"), task("independent-verification", "assist", [], ["api"])]);
  expect(() => parseWorkflowPlan(invalid)).toThrow(/tasks\[1\]\.files.*Review and Test/);
});

it("names the invalid task field instead of suggesting a different schema", () => {
  for (const [field, value] of [["id", "Not A Valid ID"], ["role", "reviewer"], ["task", ""], ["dependsOn", null]]) {
    const invalid = JSON.stringify({ summary: "Fix", acceptance: ["Works"], tasks: [{ ...task("api"), [field as string]: value }] });
    expect(() => parseWorkflowPlan(invalid)).toThrow(`tasks[0].${field}`);
  }
});

it("corrects a rejected plan before starting coding, then performs fresh review and tests", async () => {
  const jobs: WorkflowJob[] = [];
  let plans = 0;
  const runner = new CollaborationWorkflowRunner(settings, async job => {
    jobs.push(job);
    if (job.phase.startsWith("Plan")) {
      if (++plans === 1) return result(plan([task("api", "backend"), task("verify", "assist", [], ["api"])]));
      expect(job.task).toContain("tasks[1].files");
      expect(jobs.some(item => item.phase.startsWith("Coding"))).toBe(false);
      return result(plan([task("api", "backend")]));
    }
    return result(pass, job.phase === "Test" ? [testCommand] : []);
  }, () => {});
  const output = await runner.run("Fix the API and independently verify it.");
  expect(output.status).toBe("completed");
  expect(output.stages.map(stage => stage.phase)).toEqual(["Plan", "Plan correction 1", "Coding · backend · api", "Review", "Test"]);
  expect(output.stages[0].status).toBe("failed");
  expect(output.stages[0].report).toContain("tasks[1].files");
  expect(output.repairRounds).toBe(0);
});

it("corrects a repair plan without skipping checks or consuming another code repair round", async () => {
  let tests = 0;
  const runner = new CollaborationWorkflowRunner(settings, async job => {
    if (job.phase === "Repair plan") return result(plan([task("verify", "assist", [])]));
    if (job.phase === "Plan" || job.phase === "Repair plan correction 1") return result(plan([task("api", "backend")]));
    if (job.phase === "Test") return result(pass, [{ ...testCommand, exitCode: ++tests === 1 ? 1 : 0 }]);
    return result(pass);
  }, () => {});
  const output = await runner.run("Fix the API.");
  expect(output.status).toBe("completed");
  expect(output.repairRounds).toBe(1);
  expect(output.stages.filter(stage => stage.phase.startsWith("Fix"))).toHaveLength(1);
  expect(output.stages.filter(stage => stage.phase === "Review")).toHaveLength(2);
  expect(tests).toBe(2);
});

it("does not retry provider failures or planning without source reads as a format correction", async () => {
  for (const response of [{ ...result("Provider failed."), status: "failed" }, { ...result(plan([task("api")])), readCalls: 0 }]) {
    const runner = new CollaborationWorkflowRunner(settings, async () => response, () => {});
    const output = await runner.run("Fix the API.");
    expect(output.status).toBe("failed");
    expect(output.stages).toHaveLength(1);
  }
});

it("Stop during a correction prevents coding and any further planner retry", async () => {
  const abort = new AbortController();
  const runner = new CollaborationWorkflowRunner(settings, async job => {
    if (job.phase === "Plan") return result(plan([task("verify", "assist", [])]));
    abort.abort();
    return result(plan([task("api", "backend")]));
  }, () => {});
  const output = await runner.run("Fix the API.", false, abort.signal);
  expect(output.status).toBe("cancelled");
  expect(output.stages.map(stage => stage.phase)).toEqual(["Plan", "Plan correction 1"]);
});

it("runs Claude frontend and assistance, GPT backend, with dependencies and fresh GPT checks", async () => {
  const jobs: WorkflowJob[] = [];
  const finished = new Set<string>();
  let active = 0, peak = 0;
  let release!: () => void;
  const together = new Promise<void>(resolve => { release = resolve; });
  const runner = new CollaborationWorkflowRunner(settings, async job => {
    jobs.push(job);
    if (job.phase === "Plan") return result(plan([task("web"), task("api", "backend"), task("help", "assist", ["api.txt"], ["api"])]));
    if (job.phase.startsWith("Coding")) {
      active++; peak = Math.max(peak, active);
      if (job.phase.endsWith("help")) expect(finished.has("api")).toBe(true);
      else { if (active === 2) release(); await together; }
      if (job.phase.endsWith("api")) finished.add("api");
      active--;
      return result("Implemented assigned files.");
    }
    return result(pass, job.phase === "Test" ? [testCommand] : []);
  }, () => {});
  const output = await runner.run("Implement the UI and API.");
  expect(output.status).toBe("completed");
  expect(peak).toBe(2);
  expect(jobs.find(job => job.phase.endsWith("api"))?.agent).toBe("collaboration-backend");
  expect(jobs.find(job => job.phase.endsWith("help"))?.agent).toBe("collaboration-executor");
  expect(jobs.find(job => job.phase === "Review")?.agent).toBe("collaboration-analyst");
  expect(jobs.find(job => job.phase === "Test")?.agent).toBe("collaboration-verifier");
});

it("requires observed successful commands and stops after two unsuccessful repair rounds", async () => {
  const runner = new CollaborationWorkflowRunner(settings, async job =>
    result(job.phase.includes("plan") || job.phase === "Plan" ? plan([task("web")]) : pass), () => {});
  const output = await runner.run("Fix the UI.");
  expect(output.status).toBe("failed");
  expect(output.repairRounds).toBe(2);
  expect(output.stages.filter(stage => stage.phase === "Test")).toHaveLength(3);
});

it("failed tests trigger a fresh repair and both checks before completion", async () => {
  let tests = 0;
  const runner = new CollaborationWorkflowRunner(settings, async job => {
    if (job.phase.includes("plan") || job.phase === "Plan") return result(plan([task("api", "backend")]));
    if (job.phase === "Test") return result(pass, [{ ...testCommand, exitCode: ++tests === 1 ? 1 : 0 }]);
    return result(pass);
  }, () => {});
  const output = await runner.run("Fix the API.");
  expect(output.status).toBe("completed");
  expect(output.repairRounds).toBe(1);
  expect(output.stages.filter(stage => stage.phase === "Review")).toHaveLength(2);
});

it("does not accept a source-review verdict that only listed filenames", async () => {
  const runner = new CollaborationWorkflowRunner(settings, async job => {
    if (job.phase.includes("plan") || job.phase === "Plan") return result(plan([task("api", "backend")]));
    if (job.phase === "Review") return { ...result(pass), readCalls: 0 };
    return result(pass, job.phase === "Test" ? [testCommand] : []);
  }, () => {});
  const output = await runner.run("Fix the API.");
  expect(output.status).toBe("failed");
  expect(output.repairRounds).toBe(2);
  expect(output.stages.filter(stage => stage.phase === "Review").every(stage => stage.status === "failed")).toBe(true);
});

it("read-only requests never start writers or shell-capable verifiers", async () => {
  const roles: string[] = [];
  const runner = new CollaborationWorkflowRunner(settings, async job => {
    roles.push(job.agent); return result("Read-only plan with file references.");
  }, () => {});
  expect((await runner.run("Analyze this.", true)).status).toBe("completed");
  expect(roles).toEqual(["collaboration-analyst"]);
});

it("deep development reviews the plan and runs additional regression and boundary checks", async () => {
  const phases: string[] = [];
  const runner = new CollaborationWorkflowRunner({ ...settings, workflow: "deep" }, async job => {
    phases.push(job.phase);
    if (job.phase === "Plan") return result(plan([task("web")]));
    return result(pass, ["Test", "Boundary tests"].includes(job.phase) ? [testCommand] : []);
  }, () => {});
  expect((await runner.run("Implement and verify.")).status).toBe("completed");
  expect(phases).toEqual(["Plan", "Plan review", "Coding · frontend · web", "Review", "Test", "Regression review", "Boundary tests"]);
});

it("quick development rejects an oversized plan before coding", async () => {
  const runner = new CollaborationWorkflowRunner({ ...settings, workflow: "quick" }, async () =>
    result(plan([task("a"), task("b"), task("c"), task("d")])), () => {});
  const output = await runner.run("Fix a small issue.");
  expect(output.status).toBe("failed");
  expect(output.stages).toHaveLength(3);
  expect(output.stages.every(stage => stage.agent === "collaboration-analyst" && stage.status === "failed")).toBe(true);
  expect(output.error).toContain("after two corrections");
});

it("the review preset remains read-only even when an implementation task is sent", async () => {
  const agents: string[] = [];
  const runner = new CollaborationWorkflowRunner({ ...settings, workflow: "review" }, async job => {
    agents.push(job.agent); return result("Read-only findings with paths.");
  }, () => {});
  expect((await runner.run("Implement this change.")).status).toBe("completed");
  expect(agents).toEqual(["collaboration-analyst"]);
});

it("cancellation during planning prevents every later stage", async () => {
  const abort = new AbortController();
  const roles: string[] = [];
  const runner = new CollaborationWorkflowRunner(settings, async job => {
    roles.push(job.agent); abort.abort(); return result(plan([task("web")]));
  }, () => {});
  expect((await runner.run("Implement.", false, abort.signal)).status).toBe("cancelled");
  expect(roles).toHaveLength(1);
});
