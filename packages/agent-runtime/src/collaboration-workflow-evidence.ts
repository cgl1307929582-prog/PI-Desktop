import type { WorkflowCommand, WorkflowDelegateResult } from "./collaboration-workflow.js";

export function parseWorkflowJson(text: string): unknown {
  if (text.length > 48_000) throw new Error("Workflow result exceeded its size limit.");
  return JSON.parse(text.trim().replace(/^\x60\x60\x60(?:json)?\s*\n([\s\S]*?)\n\x60\x60\x60$/, "$1"));
}

export type Verification = { verdict: "pass" | "fail" | "inconclusive"; reason?: string };

/** Only normalize simple commands and runtime selectors, never test selectors or cwd. */
function checkIdentity(command: string, runtimeSelection = false): string {
  if (/[\n\r'"`$;|<>\\()]/.test(command) || command.replaceAll("&&", "").includes("&")) return command;
  return command.split("&&").map(part => {
    const words = part.trim().split(/\s+/);
    let executable = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[executable] ?? "")) executable++;
    const prefix = words.slice(0, executable);
    const args = words.slice(executable);
    if (runtimeSelection && args[0] === "go") {
      return [...prefix.filter(word => !/^GOTOOLCHAIN=(local|auto)$/.test(word)), ...args].join(" ");
    }
    // Interpreter selection may change; the module, arguments and environment cannot.
    if (runtimeSelection && /^(?:[^\s]+\/)?python(?:3(?:\.\d+)?)?$/.test(args[0] ?? "") && args[1] === "-m") args[0] = "python";
    return [...prefix, ...args].join(" ");
  }).join(" && ");
}

/** Only a recognized launcher error can excuse a cross-runtime retry of exit 1. */
export function workflowCommandEvidence(command: string, content: unknown, ok: boolean, denied = false): WorkflowCommand {
  const data = content && typeof content === "object" ? content as Record<string, unknown> : {};
  const exitCode = typeof data.exitCode === "number" ? data.exitCode : null;
  const stderr = typeof data.stderr === "string" ? data.stderr.trim() : "";
  const unavailable = exitCode === 1 && /^go: go\.mod requires go >= [\d.]+ \(running go [\d.]+; GOTOOLCHAIN=local\)$/.test(stderr);
  return { command: command.slice(0, 3000), exitCode, ok, ...(denied ? { denied: true } : {}),
    ...(command.length > 3000 ? { truncated: true } : {}),
    ...(unavailable ? { failureKind: "runtime-unavailable" as const } : {}) };
}

function canReplace(failed: WorkflowCommand, later: WorkflowCommand): boolean {
  if (later.exitCode !== 0 || !later.ok) return false;
  if (checkIdentity(failed.command) === checkIdentity(later.command)) return true;
  const unavailable = failed.failureKind === "runtime-unavailable" || failed.exitCode === 126 || failed.exitCode === 127;
  // An explicitly versioned Python check must still run under that version.
  if (!unavailable || /(?:^|\s)(?:[^\s]+\/)?python3\.\d+\s+-m/.test(failed.command)) return false;
  return checkIdentity(failed.command, true) === checkIdentity(later.command, true);
}

export function verificationVerdict(result: WorkflowDelegateResult, tests = false): Verification {
  try {
    const report = parseWorkflowJson(result.report);
    if (result.status !== "completed" || !report || typeof report !== "object" || Array.isArray(report)
      || !("verdict" in report) || !["pass", "fail", "inconclusive"].includes(String(report.verdict))
      || typeof report.verdict !== "string" || !("summary" in report)
      || typeof report.summary !== "string" || !report.summary.trim()) {
      return { verdict: "inconclusive", reason: "A completed, structured verification report is required." };
    }
    if (report.verdict === "inconclusive") return { verdict: "inconclusive" };
    if (!result.toolCalls || (tests ? !result.commands.length : !result.readCalls)) {
      return { verdict: "inconclusive", reason: tests
        ? "No executed test commands were observed." : "No successful source Read was observed." };
    }
    // Missing/truncated evidence and denied tools cannot be erased by a later success.
    if (tests && result.commands.some(command => command.exitCode === null || command.denied || (command.exitCode === 0 && !command.ok) || command.truncated)) {
      return { verdict: "inconclusive", reason: "A command lacks complete execution evidence or permission." };
    }
    const unresolved = result.commands.filter((command, index) => command.exitCode !== 0
      && !result.commands.slice(index + 1).some(later => canReplace(command, later)));
    if (tests && unresolved.some(command => command.exitCode === 126 || command.exitCode === 127 || command.failureKind === "runtime-unavailable")) {
      return { verdict: "inconclusive", reason: "A required command could not execute." };
    }
    return { verdict: report.verdict === "fail"
      || (tests && unresolved.length > 0) ? "fail" : "pass" };
  } catch { return { verdict: "inconclusive", reason: "The verification report is not valid JSON." }; }
}

export const VERIFICATION_REPORT = 'Return one JSON object: {"verdict":"pass"|"fail"|"inconclusive","summary":"specific findings and evidence"}. Missing required evidence, dependencies, tools, permissions or services means inconclusive, not a code defect. For inconclusive, name the blocker, checks not run and the concrete prerequisite needed to retry; do not claim verification passed.';
export const SOURCE_REVIEW = `Your stage is source review only. Use Read to inspect current implementation and relevant test/caller files against the original requirements. Use fail for actionable defects within this scope, including pre-existing defects the task requires fixing. Use pass when this source inspection finds no actionable defect. A separate Test stage executes commands; lack of Bash/browser tools is not a source-review blocker. Do not claim tests ran. Do not invent a requirement for a clean git tree, a pre-change dirty-workspace snapshot, or historical diff attribution unless the user explicitly requires that audit. State those limits separately; inspect the current files. Never waive an explicit user requirement. ${VERIFICATION_REPORT}`;
export const PLAN_REVIEW = `Your stage is plan review before implementation. Use Read to check whether the proposed plan covers the original requirements, known defects, file ownership, dependencies and acceptance criteria. Existing bugs are expected before coding: fail only when the PLAN omits or mishandles them, not because implementation has not happened yet. Do not require executed tests or completed code at this stage. ${VERIFICATION_REPORT}`;
