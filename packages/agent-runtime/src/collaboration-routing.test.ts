import { expect, it } from "vitest";
import { selectCollaborationWorkflow } from "./collaboration-routing.js";
import type { CollaborationSettings } from "@pi-desktop/shared";

const settings: CollaborationSettings = {
  mode: "auto", workflow: "auto", codingMode: "auto",
  executionModel: "claude/opus", reviewModel: "pro/gpt", maxConcurrency: 8,
};

it.each(["quick", "standard", "deep", "review"])("routes %s without mutating the session preference", preset => {
  const routed = selectCollaborationWorkflow(settings, { preset, reason: "Task scope fits this workflow." });
  expect(routed.settings).toEqual({ ...settings, workflow: preset });
  expect(routed.selection).toEqual({ mode: "auto", reason: "Task scope fits this workflow." });
  expect(settings.workflow).toBe("auto");
});

it.each([{}, { preset: "standard" }, { preset: "deep", reason: " " }, { preset: "arbitrary", reason: "test" }])(
  "rejects incomplete or unknown automatic choices before delegation: %j", input => {
    expect(() => selectCollaborationWorkflow(settings, input)).toThrow();
  },
);

it("enforces manual locks while preserving read-only requests", () => {
  const locked = { ...settings, workflow: "quick" as const };
  expect(() => selectCollaborationWorkflow(locked, { preset: "deep", reason: "I prefer deep" })).toThrow("locked");
  expect(selectCollaborationWorkflow(locked, {}).settings.workflow).toBe("quick");
  expect(selectCollaborationWorkflow(locked, { readOnly: true }).settings.workflow).toBe("review");
  expect(locked.workflow).toBe("quick");
});
