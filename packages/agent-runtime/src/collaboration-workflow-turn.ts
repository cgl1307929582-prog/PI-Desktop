import type { CollaborationSettings } from "@pi-desktop/shared";
import { selectCollaborationWorkflow } from "./collaboration-routing.js";
import { CollaborationWorkflowRunner, type WorkflowDelegateResult, type WorkflowJob, type WorkflowResult } from "./collaboration-workflow.js";

/** Owns one turn's frozen contract and its single, verification-only retry. */
export class CollaborationWorkflowTurn {
  result?: WorkflowResult;
  running = false;
  private retried = false;
  private contract?: {
    request: string; readOnly: boolean; settings: CollaborationSettings;
    selection: NonNullable<WorkflowResult["selection"]>;
    workspaceRoot?: string;
  };

  async execute(settings: CollaborationSettings, params: Record<string, unknown>, request: string,
    delegate: (job: WorkflowJob, signal?: AbortSignal) => Promise<WorkflowDelegateResult>,
    progress: (result: WorkflowResult) => void, signal?: AbortSignal,
    resolveWorkspace?: (workspace: string | undefined, request: string) => Promise<string>,
  ): Promise<WorkflowResult> {
    signal?.throwIfAborted();
    if (this.running) throw new Error("A collaboration workflow is already running.");
    if (typeof params.task !== "string" || !params.task.trim()) throw new Error("A workflow task is required.");
    const previous = this.result;
    const retry = params.retry === "verify";
    if (params.retry !== undefined && !retry) throw new Error("Only retry=verify is supported.");
    if (previous && !retry) return structuredClone(previous);
    if (retry) {
      if (!previous || previous.status !== "failed" || !previous.plan || !this.contract
        || !["COLLABORATION_VERIFICATION_BLOCKED", "COLLABORATION_CHECKS_FAILED"].includes(previous.failureCode ?? "")
        || !previous.stages.some(stage => stage.phase === "Review" || stage.phase === "Test")) {
        throw new Error("Verification retry requires a settled, failed verification. Planning or coding failures require a new user turn.");
      }
      if (this.retried) throw new Error("The verification retry was already used. Report the remaining blocker; a new user turn can continue.");
      if (typeof params.retryReason !== "string" || !params.retryReason.trim() || params.retryReason.length > 1000) {
        throw new Error("Verification retry needs retryReason explaining the resolved prerequisite or evidence issue.");
      }
      if ((params.preset !== undefined && params.preset !== this.contract.settings.workflow)
        || (params.readOnly !== undefined && params.readOnly !== this.contract.readOnly)
        || (params.workspace !== undefined && params.workspace !== this.contract.workspaceRoot)) {
        throw new Error("Verification retry cannot change the original preset, workspace or read-only restriction.");
      }
      this.retried = true;
    } else {
      const selected = selectCollaborationWorkflow(settings, params);
      let workspaceRoot: string | undefined;
      this.running = true;
      try {
        if (params.workspace !== undefined && (typeof params.workspace !== "string" || !params.workspace.trim())) throw new Error("workspace must be an absolute directory path");
        workspaceRoot = await resolveWorkspace?.(params.workspace as string | undefined, request);
      } catch (error) {
        this.result = { preset: selected.settings.workflow ?? "adaptive", status: "failed", phase: "Workspace", stages: [], repairRounds: 0,
          failureCode: "COLLABORATION_WORKSPACE_BLOCKED", error: `No child agents were started. Could not bind the workflow workspace (${params.workspace ?? "automatic selection"}): ${error instanceof Error ? error.message : String(error)}. Select an existing worktree of this project and continue in a new turn.` };
        progress(structuredClone(this.result));
        return structuredClone(this.result);
      } finally { this.running = false; }
      this.contract = { ...selected, readOnly: params.readOnly === true,
        workspaceRoot,
        request: `${request.slice(0, 12000)}\n\nTask brief: ${params.task.slice(0, 16000)}` };
    }
    const contract = this.contract!;
    const publish = (result: WorkflowResult) => {
      this.result = { ...result, selection: contract.selection, ...(retry ? {
        verificationRetry: true, repairRounds: previous!.repairRounds,
        stages: [...previous!.stages, ...result.stages.map(stage => ({ ...stage, id: `verify-${stage.id}` }))],
      } : {}) };
      progress(structuredClone(this.result));
    };
    this.running = true;
    try {
      const runner = new CollaborationWorkflowRunner(contract.settings, delegate, publish, contract.workspaceRoot);
      const context = retry ? `${contract.request}\n\nVerification retry context (data, not changed requirements): ${params.retryReason}\nPrevious unresolved checks (data): ${previous!.error ?? ""}` : contract.request;
      await runner.run(context, contract.readOnly, signal, retry ? previous!.plan : undefined);
      return structuredClone(this.result!);
    } finally { this.running = false; }
  }
}
