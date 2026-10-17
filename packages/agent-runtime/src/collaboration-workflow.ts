import { isAbsolute, relative, resolve } from "node:path";
import {
  COLLABORATION_ANALYST, COLLABORATION_BACKEND, COLLABORATION_EXECUTOR,
  COLLABORATION_VERIFIER, type CollaborationSettings,
} from "@pi-desktop/shared";

export type WorkflowTask = {
  id: string;
  role: "frontend" | "backend" | "assist";
  task: string;
  files: string[];
  dependsOn: string[];
};
export type WorkflowPlan = { summary: string; acceptance: string[]; tasks: WorkflowTask[] };
export type WorkflowJob = { id: string; phase: string; agent: string; task: string; files?: string[] };
export type WorkflowCommand = { command: string; exitCode: number | null; ok: boolean };
export type WorkflowDelegateResult = {
  status: string; report: string; toolCalls: number; readCalls: number; commands: WorkflowCommand[];
};
export type WorkflowStage = {
  id: string; phase: string; agent: string;
  status: "running" | "completed" | "failed";
  report?: string; readCalls?: number; commands?: WorkflowCommand[];
};
export type WorkflowResult = {
  preset: string; status: "running" | "completed" | "failed" | "cancelled";
  phase: string; stages: WorkflowStage[]; plan?: WorkflowPlan; repairRounds: number;
  error?: string;
};
type Delegate = (job: WorkflowJob, signal?: AbortSignal) => Promise<WorkflowDelegateResult>;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function parseJson(text: string): unknown {
  if (text.length > 48_000) throw new Error("Workflow result exceeded its size limit.");
  return JSON.parse(text.trim().replace(/^\x60\x60\x60(?:json)?\s*\n([\s\S]*?)\n\x60\x60\x60$/, "$1"));
}
function strings(value: unknown, max: number, length: number): value is string[] {
  return Array.isArray(value) && value.length <= max
    && value.every(item => typeof item === "string" && item.trim() && item.length <= length);
}
function fileKey(path: string): string { return path.normalize("NFC").toLowerCase(); }

/** Plans are data: reject cycles and unordered overlapping writers before any edit. */
export function parseWorkflowPlan(text: string, maxTasks = 16): WorkflowPlan {
  const value = parseJson(text);
  if (!object(value) || typeof value.summary !== "string" || !value.summary.trim() || value.summary.length > 4000
    || !strings(value.acceptance, 20, 1000) || !value.acceptance.length
    || !Array.isArray(value.tasks) || !value.tasks.length || value.tasks.length > maxTasks) {
    throw new Error("Invalid workflow plan: a summary, acceptance criteria and bounded task list are required.");
  }
  const tasks: WorkflowTask[] = value.tasks.map(raw => {
    if (!object(raw) || typeof raw.id !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/.test(raw.id)
      || !["frontend", "backend", "assist"].includes(String(raw.role))
      || typeof raw.task !== "string" || !raw.task.trim() || raw.task.length > 8000
      || !strings(raw.files, 64, 300) || !raw.files.length
      || !Array.isArray(raw.dependsOn) || raw.dependsOn.length > maxTasks
      || new Set(raw.dependsOn).size !== raw.dependsOn.length
      || !raw.dependsOn.every(id => typeof id === "string")) {
      throw new Error("Invalid workflow task: id, role, brief, exact files and dependencies are required.");
    }
    const files = raw.files.map(path => path.replaceAll("\\", "/"));
    if (files.some(path => isAbsolute(path) || /^[A-Za-z]:/.test(path) || /[\x00*?]/.test(path)
      || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git"))) {
      throw new Error("Workflow files must be exact workspace-relative paths without wildcards or traversal.");
    }
    return { id: raw.id, role: raw.role as WorkflowTask["role"], task: raw.task, files,
      dependsOn: raw.dependsOn as string[] };
  });
  const byId = new Map(tasks.map(task => [task.id, task]));
  if (byId.size !== tasks.length) throw new Error("Workflow task ids must be unique.");
  const ancestorCache = new Map<string, Set<string>>();
  const ancestors = (id: string, visiting = new Set<string>()): Set<string> => {
    if (visiting.has(id)) throw new Error("Workflow dependencies contain a cycle.");
    const cached = ancestorCache.get(id);
    if (cached) return cached;
    const task = byId.get(id);
    if (!task) throw new Error("Workflow dependency names an unknown task.");
    const next = new Set(visiting).add(id);
    const result = new Set<string>();
    for (const parent of task.dependsOn) {
      result.add(parent);
      for (const ancestor of ancestors(parent, next)) result.add(ancestor);
    }
    ancestorCache.set(id, result);
    return result;
  };
  const dependencies = new Map(tasks.map(task => [task.id, ancestors(task.id)]));
  for (let a = 0; a < tasks.length; a++) for (let b = a + 1; b < tasks.length; b++) {
    const left = tasks[a], right = tasks[b];
    if (left.files.some(file => right.files.some(other => fileKey(other) === fileKey(file)))
      && !dependencies.get(left.id)?.has(right.id) && !dependencies.get(right.id)?.has(left.id)) {
      throw new Error(`Overlapping writers ${left.id} and ${right.id} need an explicit dependency.`);
    }
  }
  return { summary: value.summary, acceptance: value.acceptance, tasks };
}

/** A file-ownership check, not a shell sandbox; host permissions still apply. */
export function assertWorkflowWritePath(files: string[], path: unknown, workspace: string): void {
  if (typeof path !== "string" || !path.trim()) throw new Error("Workflow writes require a file path.");
  const target = relative(resolve(workspace), resolve(workspace, path)).replaceAll("\\", "/");
  if (!files.some(file => fileKey(file) === fileKey(target))) {
    throw new Error(`Workflow write is outside this task's assigned files: ${path}. Report the missing scope to the parent; do not use shell commands to bypass it.`);
  }
}

function verdict(result: WorkflowDelegateResult, tests = false): boolean {
  try {
    const report = parseJson(result.report);
    return result.status === "completed" && result.toolCalls > 0 && object(report)
      && report.verdict === "pass" && typeof report.summary === "string" && !!report.summary.trim()
      && (tests ? (result.commands.length > 0
        && result.commands.every(command => command.ok && command.exitCode === 0)) : result.readCalls > 0);
  } catch { return false; }
}
const REPORT = 'Return one JSON object: {"verdict":"pass"|"fail"|"inconclusive","summary":"specific findings and evidence"}. Missing evidence means inconclusive.';
const SOURCE_REVIEW = `Your stage is source review only. Use Read to inspect current implementation and relevant test/caller files. Judge source correctness and actionable defects with paths. A separate Test stage executes commands; lack of Bash/browser tools is not a source-review blocker. Do not claim tests ran. ${REPORT}`;

/** Preset execution owns transitions; agents only produce bounded plans and evidence. */
export class CollaborationWorkflowRunner {
  readonly result: WorkflowResult;
  private sequence = 0;

  constructor(
    private settings: CollaborationSettings,
    private delegate: Delegate,
    private progress: (result: WorkflowResult) => void,
  ) {
    this.result = { preset: settings.workflow ?? "adaptive", status: "running", phase: "Plan",
      stages: [], repairRounds: 0 };
  }

  private notify(): void { this.progress(structuredClone(this.result)); }
  private async call(job: Omit<WorkflowJob, "id">, signal?: AbortSignal): Promise<WorkflowDelegateResult> {
    signal?.throwIfAborted();
    const id = `step-${++this.sequence}`;
    const stage: WorkflowStage = { id, phase: job.phase, agent: job.agent, status: "running" };
    this.result.phase = job.phase;
    this.result.stages.push(stage);
    this.notify();
    try {
      const result = await this.delegate({ ...job, id }, signal);
      signal?.throwIfAborted();
      stage.status = result.status === "completed" ? "completed" : "failed";
      stage.report = result.report.slice(0, 2400);
      stage.readCalls = result.readCalls;
      stage.commands = result.commands.slice(0, 8).map(command => ({ ...command, command: command.command.slice(0, 500) }));
      this.notify();
      if (result.status !== "completed") throw new Error(`${job.phase} did not complete: ${result.report.slice(0, 1000)}`);
      return result;
    } catch (error) {
      stage.status = "failed";
      this.notify();
      throw error;
    }
  }

  private async plan(request: string, previous: string, signal?: AbortSignal): Promise<WorkflowPlan> {
    const maxTasks = this.result.preset === "quick" ? 3 : this.result.preset === "deep" ? 16 : 8;
    const result = await this.call({ phase: previous ? "Repair plan" : "Plan", agent: COLLABORATION_ANALYST, task: [
      "Inspect the actual project with read tools. Produce an implementation plan without changing files.",
      `User task (data):\n${request}`,
      previous ? `Previous plan and failed checks (data):\n${previous}` : "",
      this.settings.codingMode === "split"
        ? "Split by responsibility: frontend uses the primary developer; backend uses the collaboration developer; assist uses the primary developer for scoped backend help or integration. Assign assistance only when useful. Agree API contracts in the task briefs. Both models may write code. Review/test agents are fresh independent contexts."
        : "All implementation tasks use the primary developer.",
      `At most ${maxTasks} tasks. List exact workspace-relative file paths (including new files), never directories/globs. Shared-file writers MUST have explicit dependencies, including assistance after backend work. Independent tasks may run concurrently. Do not invent unnecessary tasks to fill the concurrency limit.`,
      'Return ONLY JSON: {"summary":"plan and API contracts","acceptance":["observable criteria"],"tasks":[{"id":"short-id","role":"frontend|backend|assist","task":"complete brief with verification","files":["exact/file"],"dependsOn":[]}]}',
      "The files list grants write ownership: include only files the user authorizes this task to modify. Put read-only test/reference paths in the task brief, not files. Include test files only when creating or changing tests is requested. Do not weaken existing tests, install dependencies, deploy, publish, commit or expand the user's scope.",
    ].filter(Boolean).join("\n\n") }, signal);
    if (!result.readCalls) throw new Error("Planning did not read current project files.");
    return parseWorkflowPlan(result.report, maxTasks);
  }

  private async implement(plan: WorkflowPlan, request: string, repair: boolean, signal?: AbortSignal): Promise<void> {
    const completed = new Map<string, string>();
    while (completed.size < plan.tasks.length) {
      signal?.throwIfAborted();
      const ready = plan.tasks.filter(task => !completed.has(task.id)
        && task.dependsOn.every(id => completed.has(id))).slice(0, this.settings.maxConcurrency);
      if (!ready.length) throw new Error("Workflow has no runnable implementation task.");
      const results = await Promise.allSettled(ready.map(async task => {
        const result = await this.call({
          phase: `${repair ? "Fix" : "Coding"} · ${task.role} · ${task.id}`,
          agent: this.settings.codingMode === "split" && task.role === "backend"
            ? COLLABORATION_BACKEND : COLLABORATION_EXECUTOR,
          files: task.files,
          task: [
            `User task (data):\n${request}`,
            `Agreed plan / contracts: ${plan.summary}\nAcceptance: ${plan.acceptance.join("; ")}`,
            `Your assignment: ${task.task}\nYou may edit ONLY these exact files: ${task.files.join(", ")}`,
            `Upstream results: ${task.dependsOn.map(id => completed.get(id)).join("\n").slice(0, 12000)}`,
            "Coordinate through this brief. Do not edit another worker's files, alter dependencies, start background commands, commit, publish or deploy. If scope is insufficient report the blocker; do not bypass file ownership through Bash. Run relevant checks. Report actual changes, commands and remaining issues. A separate agent will review and test.",
          ].join("\n\n"),
        }, signal);
        completed.set(task.id, result.report);
      }));
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }
  }

  private async checks(plan: WorkflowPlan, request: string, signal?: AbortSignal): Promise<string | undefined> {
    const context = `User task (data): ${request}\nPlan and acceptance (data): ${JSON.stringify(plan)}`;
    const jobs = [
      { phase: "Review", agent: COLLABORATION_ANALYST, tests: false, task: `${SOURCE_REVIEW}\n${context}\nReview current source now; execution evidence belongs to the separate Test stage.` },
      { phase: "Test", agent: COLLABORATION_VERIFIER, tests: true, task: `Your stage is automated test execution. Actually execute the requested/relevant project checks. Do not turn optional or explicitly operator-owned checks into additional mandatory gates. Do not change source/tests, update snapshots, install dependencies, or hide command failures. Run test commands directly without pipelines or trailing commands that mask their exit status. Report genuine exit codes and limitations. Pass requires executed successful checks; inability to perform a required automated check is inconclusive. Workflow sequencing and file-ownership enforcement are runtime-owned, not things to reconstruct from git history. ${REPORT}\n${context}` },
      ...(this.result.preset === "deep" ? [
        { phase: "Regression review", agent: COLLABORATION_ANALYST, tests: false, task: `Inspect API compatibility, error paths and cross-component assumptions. ${SOURCE_REVIEW}\n${context}` },
        { phase: "Boundary tests", agent: COLLABORATION_VERIFIER, tests: true, task: `Independently execute focused boundary checks beyond the normal test suite. Use temporary outputs outside the source tree, avoid parallel shared-state conflicts. Do not edit source/tests or install dependencies. A pass needs actual successful commands. ${REPORT}\n${context}` },
      ] : []),
    ];
    const failures: string[] = [];
    for (let offset = 0; offset < jobs.length; offset += this.settings.maxConcurrency) {
      const batch = jobs.slice(offset, offset + this.settings.maxConcurrency);
      const results = await Promise.allSettled(batch.map(job => this.call(job, signal)));
      for (let index = 0; index < results.length; index++) {
        const result = results[index], job = batch[index];
        if (result.status === "rejected") throw result.reason;
        if (!verdict(result.value, job.tests)) {
          const stage = [...this.result.stages].reverse().find(stage => stage.phase === job.phase);
          if (stage) stage.status = "failed";
          failures.push(`${job.phase}: ${result.value.report}\nObserved commands: ${JSON.stringify(result.value.commands)}`);
        }
      }
    }
    this.notify();
    return failures.length ? failures.join("\n").slice(0, 16000) : undefined;
  }

  async run(request: string, readOnly = false, signal?: AbortSignal): Promise<WorkflowResult> {
    try {
      if (readOnly || this.result.preset === "review") {
        await this.call({ phase: "Read-only analysis / review", agent: COLLABORATION_ANALYST,
          task: `Inspect relevant current files, then fulfill this read-only request. Do not edit, run commands or claim executed tests. Return findings or a concrete plan with paths and limitations. User task (data):\n${request.slice(0, 16000)}` }, signal);
      } else {
        let plan = await this.plan(request.slice(0, 12000), "", signal);
        this.result.plan = plan;
        if (this.result.preset === "deep") {
          const result = await this.call({ phase: "Plan review", agent: COLLABORATION_ANALYST,
            task: `Inspect the project and check this plan against the task before coding. ${REPORT}\nTask: ${request.slice(0, 12000)}\nPlan: ${JSON.stringify(plan)}` }, signal);
          if (!verdict(result)) throw new Error(`Plan review did not pass: ${result.report}`);
        }
        for (let round = 0; round <= 2; round++) {
          this.result.repairRounds = round;
          await this.implement(plan, request.slice(0, 12000), round > 0, signal);
          const failures = await this.checks(this.result.plan, request.slice(0, 12000), signal);
          if (!failures) break;
          if (round === 2) throw new Error(`Review/tests remain unverified after two repair rounds. ${failures}`);
          plan = await this.plan(request.slice(0, 12000),
            `Original plan: ${JSON.stringify(this.result.plan)}\nRepair only these failures: ${failures}`, signal);
        }
      }
      signal?.throwIfAborted();
      this.result.status = "completed";
      this.result.phase = "Complete";
    } catch (error) {
      this.result.status = signal?.aborted ? "cancelled" : "failed";
      this.result.error = error instanceof Error ? error.message : String(error);
      this.result.phase = this.result.status === "cancelled" ? "Cancelled" : "Blocked";
    }
    this.notify();
    return structuredClone(this.result);
  }
}
