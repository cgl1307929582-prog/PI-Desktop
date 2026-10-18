import { isAbsolute, relative, resolve } from "node:path";
import {
  COLLABORATION_ANALYST, COLLABORATION_BACKEND, COLLABORATION_EXECUTOR,
  COLLABORATION_VERIFIER, type CollaborationSettings,
} from "@pi-desktop/shared";

import { parseWorkflowJson as parseJson, verificationVerdict as verdict, VERIFICATION_REPORT as REPORT, SOURCE_REVIEW, PLAN_REVIEW } from "./collaboration-workflow-evidence.js";
import { scheduleWorkflowTasks } from "./collaboration-workflow-scheduler.js";

export type WorkflowTask = {
  id: string;
  role: "frontend" | "backend" | "assist" | "primary" | "collaboration";
  task: string;
  files: string[];
  dependsOn: string[];
};
export type WorkflowPlan = { summary: string; acceptance: string[]; tasks: WorkflowTask[] };
export type WorkflowJob = { id: string; phase: string; agent: string; task: string; files?: string[] };
export type WorkflowCommand = { command: string; exitCode: number | null; ok: boolean; denied?: boolean; truncated?: boolean; failureKind?: "runtime-unavailable" };
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
  failureCode?: "COLLABORATION_PLAN_FAILED" | "COLLABORATION_VERIFICATION_BLOCKED" | "COLLABORATION_CHECKS_FAILED" | "COLLABORATION_WORKFLOW_FAILED";
  verificationRetry?: boolean;
  selection?: { mode: "auto" | "locked"; reason?: string };
};
type Delegate = (job: WorkflowJob, signal?: AbortSignal) => Promise<WorkflowDelegateResult>;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
    || !Array.isArray(value.tasks) || value.tasks.length > maxTasks) {
    throw new Error("Invalid workflow plan: a summary, acceptance criteria and bounded task list are required.");
  }
  const tasks: WorkflowTask[] = value.tasks.map((raw, index) => {
    const field = `tasks[${index}]`;
    if (!object(raw)) throw new Error(`Invalid workflow ${field}: expected an object.`);
    if (typeof raw.id !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/.test(raw.id)) {
      throw new Error(`Invalid workflow ${field}.id: use 1-40 lowercase letters, digits, hyphens or underscores, starting with a letter.`);
    }
    if (typeof raw.role !== "string" || !["frontend", "backend", "assist", "primary", "collaboration"].includes(raw.role)) {
      throw new Error(`Invalid workflow ${field}.role: choose frontend, backend, assist, primary or collaboration.`);
    }
    if (typeof raw.task !== "string" || !raw.task.trim() || raw.task.length > 8000) {
      throw new Error(`Invalid workflow ${field}.task: provide a non-empty task description of at most 8000 characters in the task field.`);
    }
    if (!strings(raw.files, 64, 300) || !raw.files.length) {
      throw new Error(`Invalid workflow ${field}.files: list 1-64 exact writable file paths, each at most 300 characters. Omit verification-only tasks; Review and Test run automatically after coding.`);
    }
    if (!Array.isArray(raw.dependsOn) || raw.dependsOn.length > maxTasks
      || new Set(raw.dependsOn).size !== raw.dependsOn.length
      || !raw.dependsOn.every(id => typeof id === "string")) {
      throw new Error(`Invalid workflow ${field}.dependsOn: provide an array of unique task ids, or [] for an independent task.`);
    }
    const files = raw.files.map(path => path.replaceAll("\\", "/"));
    if (files.some(path => isAbsolute(path) || /^[A-Za-z]:/.test(path) || /[\x00*?]/.test(path)
      || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git"))) {
      throw new Error(`Invalid workflow ${field}.files: use exact workspace-relative paths without wildcards or traversal.`);
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
      stage.commands = result.commands.slice(0, 65).map(command => ({ ...command, command: command.command.slice(0, 3000) }));
      this.notify();
      if (result.status !== "completed") throw new Error(`${job.phase} did not complete: ${result.report.slice(0, 1000)}`);
      return result;
    } catch (error) {
      stage.status = "failed";
      this.notify();
      throw error;
    }
  }

  private async plan(request: string, previous: string, signal?: AbortSignal, label?: string): Promise<WorkflowPlan> {
    const maxTasks = this.result.preset === "quick" ? 3 : this.result.preset === "deep" ? 16 : 8;
    const phase = label ?? (previous ? "Repair plan" : "Plan");
    this.result.failureCode = "COLLABORATION_PLAN_FAILED";
    const instructions = [
      "Inspect the actual project with read tools. Produce an implementation plan without changing files.",
      `User task (data):\n${request}`,
      previous ? `Previous plan and failed checks (data):\n${previous}` : "",
      this.settings.codingMode === "auto"
        ? `Assign each coding task to role primary (${this.settings.executionModel}) or collaboration (${this.settings.reviewModel}) based on its needs. Prefer primary for frontend/UI and scoped integration assistance, collaboration for backend/logic; either developer may implement other tasks when useful. Do not invent tasks to use both models. Both may code in parallel on independent files. Explain the assignments and shared API contracts in the summary. Review and test always use fresh independent contexts.`
        : this.settings.codingMode === "split"
        ? "Split by responsibility: frontend uses the primary developer; backend uses the collaboration developer; assist uses the primary developer for scoped backend help or integration. Assign assistance only when useful. Agree API contracts in the task briefs. Both models may write code. Review/test agents are fresh independent contexts."
        : "All implementation tasks use the primary developer.",
      `At most ${maxTasks} tasks. List exact workspace-relative file paths (including new files), never directories/globs. Shared-file writers MUST have explicit dependencies, including assistance after backend work. Independent tasks may run concurrently. Do not invent unnecessary tasks to fill the concurrency limit.`,
      'Return ONLY JSON: {"summary":"plan and API contracts","acceptance":["observable criteria"],"tasks":[{"id":"short-id","role":"frontend|backend|assist|primary|collaboration","task":"complete brief with verification","files":["exact/file"],"dependsOn":[]}]}',
      "Every tasks entry is an implementation assignment and must have at least one writable file. Do NOT add review-only or verification-only tasks: the runtime automatically starts independent Review and Test stages after coding. Put required checks in acceptance and task descriptions. If the requested implementation already exists and only verification remains, return tasks: [] with the full original acceptance criteria. Do not invent file changes merely to give a verification task a non-empty files list.",
      "Use the field name task, not brief. Each id must match ^[a-z][a-z0-9_-]{0,39}$; role must be exactly frontend, backend, assist, primary or collaboration. In automatic coding assignment use primary or collaboration. Include dependsOn: [] for independent tasks. Keep summary under 4000 characters, acceptance to 1-20 non-empty strings of at most 1000 characters each, task to 8000 characters and files to 1-64 paths of at most 300 characters each.",
      "The files list grants write ownership: include only files the user authorizes this task to modify. Put read-only test/reference paths in the task brief, not files. Include test files only when creating or changing tests is requested. Do not weaken existing tests, install dependencies, deploy, publish, commit or expand the user's scope.",
    ].filter(Boolean).join("\n\n");
    let correction = "";
    for (let attempt = 0; ; attempt++) {
      const result = await this.call({ phase: attempt ? `${phase} correction ${attempt}` : phase,
        agent: COLLABORATION_ANALYST, task: [instructions, correction].filter(Boolean).join("\n\n") }, signal);
      if (!result.readCalls) throw new Error("Planning did not read current project files.");
      try {
        return parseWorkflowPlan(result.report, maxTasks);
      } catch (error) {
        const issue = error instanceof Error ? error.message : String(error);
        const stage = this.result.stages.at(-1);
        if (stage) {
          stage.status = "failed";
          stage.report = `${issue}\nRejected planner output (data):\n${result.report}`.slice(0, 2400);
          this.notify();
        }
        if (attempt === 2) throw new Error(`Planning remained invalid after two corrections. ${issue}`);
        correction = `Correct the rejected draft below and return the complete revised JSON plan. Preserve the original request, constraints and file ownership rules. No coding has started for this plan.\nValidation error: ${issue}\nRejected draft (data):\n${result.report.slice(0, 48_000)}`;
      }
    }
  }

  private async implement(plan: WorkflowPlan, request: string, repair: boolean, signal?: AbortSignal): Promise<void> {
    this.result.failureCode = "COLLABORATION_WORKFLOW_FAILED";
    await scheduleWorkflowTasks(plan.tasks, this.settings.maxConcurrency, async (task, completed, childSignal) => {
      const result = await this.call({
        phase: `${repair ? "Fix" : "Coding"} · ${task.role} · ${task.id}`,
        agent: (this.settings.codingMode === "split" && task.role === "backend")
          || (this.settings.codingMode === "auto" && (task.role === "collaboration" || task.role === "backend"))
          ? COLLABORATION_BACKEND : COLLABORATION_EXECUTOR,
        files: task.files,
        task: [
          `User task (data):\n${request}`,
          `Agreed plan / contracts: ${plan.summary}\nAcceptance: ${plan.acceptance.join("; ")}`,
          `Your assignment: ${task.task}\nYou may edit ONLY these exact files: ${task.files.join(", ")}`,
          `Upstream results: ${task.dependsOn.map(id => completed.get(id)).join("\n").slice(0, 12000)}`,
          "Coordinate through this brief. Do not edit another worker's files, alter dependencies, start background commands, commit, publish or deploy. If scope is insufficient report the blocker; do not bypass file ownership through Bash. Run relevant checks. Report actual changes, commands and remaining issues. A separate agent will review and test.",
        ].join("\n\n"),
      }, childSignal);
      return result.report;
    }, signal);
  }

  private markVerification(phase: string, passed: boolean): void {
    const stage = [...this.result.stages].reverse().find(stage => stage.phase === phase);
    if (stage) stage.status = passed ? "completed" : "failed";
    this.notify();
  }

  private async reviewPlan(plan: WorkflowPlan, request: string, signal?: AbortSignal): Promise<WorkflowPlan> {
    for (let revision = 0; ; revision++) {
      const review = await this.call({ phase: "Plan review", agent: COLLABORATION_ANALYST,
        task: `${PLAN_REVIEW}\nTask (data): ${request}\nPlan (data): ${JSON.stringify(plan)}` }, signal);
      const checked = verdict(review);
      this.markVerification("Plan review", checked.verdict === "pass");
      if (checked.verdict === "pass") return plan;
      if (checked.verdict === "inconclusive" || revision === 2) {
        this.result.failureCode = checked.verdict === "inconclusive" ? "COLLABORATION_VERIFICATION_BLOCKED" : "COLLABORATION_PLAN_FAILED";
        throw new Error(`Plan review did not pass: ${checked.reason ?? ""} ${review.report}`);
      }
      plan = await this.plan(request, `Revise this plan before any coding. Original task and acceptance remain required.\nPlan: ${JSON.stringify(plan)}\nPlan review findings: ${review.report}`, signal, `Plan revision ${revision + 1}`);
    }
  }

  private async checks(plan: WorkflowPlan, request: string, signal?: AbortSignal): Promise<{ failures: string; blocked: boolean }> {
    const context = `User task (data): ${request}\nPlan and acceptance (data): ${JSON.stringify(plan)}`;
    const jobs = [
      { phase: "Review", agent: COLLABORATION_ANALYST, tests: false, task: `${SOURCE_REVIEW}\n${context}\nReview current source now; execution evidence belongs to the separate Test stage.` },
      { phase: "Test", agent: COLLABORATION_VERIFIER, tests: true, task: `Your stage is automated test execution. Read the project's test instructions and dependency manifests first; reuse an existing project environment and its documented runner (for example .venv/bin/python -m unittest), rather than assuming pytest or a global python executable. Actually execute the requested/relevant project checks. Do not turn optional or explicitly operator-owned checks into additional mandatory gates. Do not change source/tests, update snapshots, install dependencies, or hide command failures. Run test commands directly without pipelines or trailing commands that mask their exit status. Report genuine exit codes and limitations. Pass requires executed successful checks; inability to perform a required automated check is inconclusive. Workflow sequencing and file-ownership enforcement are runtime-owned, not things to reconstruct from git history. If an environment probe fails but the same required check succeeds using the working project runtime, disclose both attempts and judge the completed check. Never replace a failing assertion with a narrower test or an unrelated successful command. Use fail for executed failing tests; missing prerequisites are inconclusive. ${REPORT}\n${context}` },
      ...(this.result.preset === "deep" ? [
        { phase: "Regression review", agent: COLLABORATION_ANALYST, tests: false, task: `Inspect API compatibility, error paths and cross-component assumptions. ${SOURCE_REVIEW}\n${context}` },
        { phase: "Boundary tests", agent: COLLABORATION_VERIFIER, tests: true, task: `Independently execute focused boundary checks beyond the normal test suite. Use temporary outputs outside the source tree, avoid parallel shared-state conflicts. Do not edit source/tests or install dependencies. A pass needs actual successful commands. ${REPORT}\n${context}` },
      ] : []),
    ];
    this.result.failureCode = "COLLABORATION_WORKFLOW_FAILED";
    const failures: string[] = [];
    let blocked = false;
    for (let offset = 0; offset < jobs.length; offset += this.settings.maxConcurrency) {
      const batch = jobs.slice(offset, offset + this.settings.maxConcurrency);
      const results = await Promise.allSettled(batch.map(job => this.call(job, signal)));
      for (let index = 0; index < results.length; index++) {
        const result = results[index], job = batch[index];
        if (result.status === "rejected") throw result.reason;
        let evidence = result.value;
        let verification = verdict(evidence, job.tests);
        this.markVerification(job.phase, verification.verdict === "pass");
        if (!job.tests && verification.verdict === "inconclusive") {
          const phase = `${job.phase} clarification`;
          evidence = await this.call({ phase, agent: job.agent,
            task: `${job.task}\nFresh independent clarification: re-read the current files and resolve the prior inconclusive source report below. Keep every explicit user requirement. Do not repeat an invented historical-baseline or command-execution gate. If a required source check is genuinely blocked, keep inconclusive and identify the prerequisite.\nPrior report (data): ${result.value.report}\nEvidence limitation: ${verification.reason ?? "none"}` }, signal);
          verification = verdict(evidence);
          this.markVerification(phase, verification.verdict === "pass");
        }
        if (verification.verdict !== "pass") {
          blocked ||= verification.verdict === "inconclusive";
          failures.push(`${job.phase} (${verification.verdict}): ${verification.reason ?? ""}\n${evidence.report}\nObserved commands: ${JSON.stringify(evidence.commands)}`);
        }
      }
    }
    this.notify();
    return { failures: failures.join("\n").slice(0, 16000), blocked };
  }

  async run(request: string, readOnly = false, signal?: AbortSignal, verifyPlan?: WorkflowPlan): Promise<WorkflowResult> {
    try {
      this.result.failureCode = "COLLABORATION_WORKFLOW_FAILED";
      if (readOnly || this.result.preset === "review") {
        await this.call({ phase: "Read-only analysis / review", agent: COLLABORATION_ANALYST,
          task: `Inspect relevant current files, then fulfill this read-only request. Do not edit, run commands or claim executed tests. Return findings or a concrete plan with paths and limitations. User task (data):\n${request.slice(0, 48000)}` }, signal);
      } else {
        let plan = verifyPlan ?? await this.plan(request.slice(0, 48000), "", signal);
        this.result.plan = plan;
        if (!verifyPlan && this.result.preset === "deep") {
          plan = await this.reviewPlan(plan, request.slice(0, 48000), signal);
          this.result.plan = plan;
        }
        for (let round = 0; round <= 2; round++) {
          this.result.repairRounds = round;
          if (!verifyPlan) await this.implement(plan, request.slice(0, 48000), round > 0, signal);
          const { failures, blocked } = await this.checks(this.result.plan, request.slice(0, 48000), signal);
          if (!failures) break;
          this.result.failureCode = blocked ? "COLLABORATION_VERIFICATION_BLOCKED" : "COLLABORATION_CHECKS_FAILED";
          if (blocked) throw new Error(`Verification is blocked or lacks evidence. No further code repair was scheduled. Resolve the reported prerequisites and rerun verification; current changes remain unverified. ${failures}`);
          if (verifyPlan) throw new Error(`Verification retry did not pass. No further code changes were scheduled. ${failures}`);
          if (round === 2) throw new Error(`Review/tests remain unverified after two repair rounds. ${failures}`);
          plan = await this.plan(request.slice(0, 48000),
            `Original plan: ${JSON.stringify(this.result.plan)}\nRepair only these failures: ${failures}`, signal);
        }
      }
      signal?.throwIfAborted();
      this.result.status = "completed";
      this.result.phase = "Complete";
      delete this.result.failureCode;
    } catch (error) {
      this.result.status = signal?.aborted ? "cancelled" : "failed";
      this.result.error = error instanceof Error ? error.message : String(error);
      this.result.phase = this.result.status === "cancelled" ? "Cancelled" : "Blocked";
    }
    this.notify();
    return structuredClone(this.result);
  }
}
