import type { CollaborationSettings, CollaborationWorkflowPreset } from "@pi-desktop/shared";

const PRESETS = ["quick", "standard", "deep", "review"] as const;
export type SelectedWorkflow = {
  settings: CollaborationSettings;
  selection: { mode: "auto" | "locked"; reason?: string };
};

/** Model routing is bounded by the user's saved choice, never a settings write. */
export function selectCollaborationWorkflow(
  settings: CollaborationSettings,
  input: { preset?: unknown; reason?: unknown; readOnly?: unknown },
): SelectedWorkflow {
  const automatic = settings.workflow === "auto";
  if (input.preset !== undefined && !PRESETS.includes(input.preset as typeof PRESETS[number])) {
    throw new Error("Choose quick, standard, deep or review as the workflow preset.");
  }
  if (automatic && (input.preset === undefined || typeof input.reason !== "string"
    || !input.reason.trim() || input.reason.length > 500)) {
    throw new Error("Automatic workflow selection requires a preset and a concrete reason of 1-500 characters.");
  }
  if (!automatic && input.preset !== undefined && input.preset !== settings.workflow) {
    throw new Error(`This session is locked to ${settings.workflow}; the model cannot change that workflow.`);
  }
  const preset = input.readOnly === true ? "review" : automatic
    ? input.preset as CollaborationWorkflowPreset : settings.workflow;
  return {
    settings: { ...settings, workflow: preset },
    selection: { mode: automatic ? "auto" : "locked", ...(automatic ? { reason: (input.reason as string).trim() } : {}) },
  };
}
