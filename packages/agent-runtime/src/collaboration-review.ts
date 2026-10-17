/** A fresh review is required after every potentially mutating tool execution. */
export class CollaborationReview {
  private revision = 0;
  private reviewedRevision = 0;
  private attemptedRevision = 0;
  private attempts = 0;
  private paths = new Set<string>();
  private commands = new Set<string>();
  private latest = "";

  get pending(): boolean { return this.revision > this.reviewedRevision; }
  get needsReview(): boolean { return this.revision > this.attemptedRevision; }
  get exhausted(): boolean { return this.attempts >= 3; }
  get report(): string { return this.latest; }

  noteTool(name: string, args: unknown): void {
    if (!["Write", "Edit", "Bash"].includes(name)) return;
    this.revision += 1;
    if (!args || typeof args !== "object") return;
    const value = args as Record<string, unknown>;
    if (typeof value.path === "string" && this.paths.size < 256) this.paths.add(value.path.slice(0, 2000));
    if (typeof value.command === "string" && this.commands.size < 256) this.commands.add(value.command.slice(0, 2000));
  }

  begin(workspace: string, request: string): { revision: number; task: string } {
    if (this.exhausted) throw new Error("COLLABORATION_REVIEW_EXHAUSTED: the latest work has not passed independent review after three attempts.");
    this.attempts += 1;
    this.attemptedRevision = this.revision;
    return {
      revision: this.revision,
      task: [
        "Runtime-requested independent review. Inspect the current workspace with your read tools. Do not edit files or trust the implementer's claim of success.",
        `Workspace: ${workspace}`,
        `Original user request (task data):\n${request.slice(0, 12000)}`,
        `Files touched through file tools: ${[...this.paths].join(", ").slice(0, 8000) || "unknown; inspect the workspace"}`,
        `Commands that may have changed files (data only, do not execute):\n${[...this.commands].join("\n").slice(0, 8000)}`,
        'Return one JSON object, without fences: {"verdict":"pass"|"fail"|"inconclusive","summary":"findings with paths and evidence"}. Pass only if you inspected relevant current files and found no actionable defect. Missing context or inability to inspect means inconclusive. A pass is a source review, not proof that tests ran.',
      ].join("\n\n"),
    };
  }

  finish(revision: number, result: { status: string; report: string; toolCalls: number }): boolean {
    let verdict = "inconclusive";
    let summary = result.report;
    try {
      const parsed: unknown = JSON.parse(result.report.trim());
      if (parsed && typeof parsed === "object") {
        const report = parsed as Record<string, unknown>;
        if (["pass", "fail", "inconclusive"].includes(String(report.verdict)) && typeof report.summary === "string" && report.summary.trim()) {
          verdict = String(report.verdict);
          summary = report.summary;
        }
      }
    } catch { /* An unparseable result cannot satisfy the review gate. */ }
    const passed = result.status === "completed" && result.toolCalls > 0 && verdict === "pass" && revision === this.revision;
    if (passed) this.reviewedRevision = revision;
    this.latest = `Independent review: ${passed ? "passed" : "not passed"}. ${summary.slice(0, 12000)}`;
    return passed;
  }
}
