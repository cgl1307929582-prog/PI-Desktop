import { expect, it } from "vitest";
import { CollaborationWorkflowRunner, type WorkflowDelegateResult } from "./collaboration-workflow.js";

const settings = { mode: "auto", workflow: "standard", codingMode: "split", executionModel: "claude/model", reviewModel: "pro/model", maxConcurrency: 2 } as const;
const result = (report: string): WorkflowDelegateResult => ({ status: "completed", report, readCalls: 1, toolCalls: 1, commands: [] });

it.each([
  '{"status":"blocked","summary":"Assigned scope excludes the requested worktree."}',
  '{"status":"failed","summary":"Implementation could not finish."}',
  'The write was denied; no source files changed.',
])("stops dependencies and verification when coding reports %s", async report => {
  const started: string[] = [];
  let cancelled = false;
  const runner = new CollaborationWorkflowRunner(settings, async (job, signal) => {
    started.push(job.phase);
    if (job.phase === "Plan") return result(JSON.stringify({ summary: "Work", acceptance: ["Works"], tasks: [
      { id: "first", role: "backend", task: "Implement", files: ["first.ts"], dependsOn: [] },
      { id: "parallel", role: "frontend", task: "Implement", files: ["parallel.ts"], dependsOn: [] },
      { id: "dependent", role: "assist", task: "Integrate", files: ["dependent.ts"], dependsOn: ["first"] },
    ] }));
    if (job.phase.endsWith("parallel")) {
      await new Promise<void>(resolve => { signal!.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }); });
      return result('{"status":"completed","summary":"Stopped"}');
    }
    return result(report);
  }, () => {});
  const output = await runner.run("Implement in the selected worktree");
  expect(output.failureCode).toBe("COLLABORATION_IMPLEMENTATION_BLOCKED");
  expect(output.error).toContain("first");
  expect(output.error).toContain("not started");
  expect(cancelled).toBe(true);
  expect(started).toEqual(["Plan", "Coding · backend · first", "Coding · frontend · parallel"]);
  expect(output.repairRounds).toBe(0);
});
