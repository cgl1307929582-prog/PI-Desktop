import { describe, expect, it } from "vitest";
import { newSessionCollaboration, collaborationDefinitions, collaborationPrompt, collaborationSettings, isCollaborationSettings } from "./collaboration.js";

const enabled = { mode: "auto" as const, executionModel: "claude/opus", reviewModel: "pro/gpt", maxConcurrency: 8 };
describe("collaboration settings", () => {
  it("preserves independent behavior for old settings", () => {
    expect(collaborationSettings(undefined).mode).toBe("off");
    expect(collaborationDefinitions(collaborationSettings(undefined))).toEqual([]);
    expect(collaborationPrompt(collaborationSettings(undefined))).toBe("");
  });
  it.each([0, 11, 1.5, "8", null])("rejects invalid concurrency %s", (maxConcurrency) => {
    expect(isCollaborationSettings({ ...enabled, maxConcurrency })).toBe(false);
  });
  it.each(["", "missing-separator", "/model", "provider/", " pro/gpt"])("rejects invalid enabled binding %s", (reviewModel) => {
    expect(isCollaborationSettings({ ...enabled, reviewModel })).toBe(false);
  });
  it("requires distinct pinned models and permits configuring while off", () => {
    expect(isCollaborationSettings(enabled)).toBe(true);
    expect(isCollaborationSettings({ ...enabled, reviewModel: enabled.executionModel })).toBe(false);
    expect(isCollaborationSettings({ ...enabled, mode: "off", reviewModel: "" })).toBe(true);
  });
  it("pins role models without fallback and keeps the analyst read-only", () => {
    const roles = collaborationDefinitions(enabled);
    expect(roles.map((role) => role.model?.providerId)).toEqual(["claude", "pro", "pro"]);
    expect(roles.every((role) => role.fallbackModels?.length === 0 && role.permission === "inherit")).toBe(true);
    expect(roles[1].tools).toEqual(["Read", "Glob", "Grep"]);
    expect(roles[2].tools).not.toContain("Write");
  });
  it("validates workflow presets and coding assignments while preserving old settings", () => {
    for (const workflow of ["auto", "adaptive", "quick", "standard", "deep", "review"]) {
      expect(isCollaborationSettings({ ...enabled, workflow, codingMode: "split" })).toBe(true);
    }
    for (const workflow of ["unknown", null, 1]) expect(isCollaborationSettings({ ...enabled, workflow })).toBe(false);
    expect(isCollaborationSettings({ ...enabled, codingMode: "any-model" })).toBe(false);
  });
  it("adds a writable collaboration-model backend without giving reviewers write access", () => {
    const settings = { ...enabled, workflow: "standard" as const, codingMode: "split" as const };
    const roles = collaborationDefinitions(settings);
    const backend = roles.find(role => role.name === "collaboration-backend");
    expect(backend?.model).toEqual({ providerId: "pro", modelId: "gpt" });
    expect(backend?.tools).toContain("Write");
    expect(roles.find(role => role.name === "collaboration-analyst")?.tools).not.toContain("Write");
    expect(collaborationPrompt(settings)).toContain("CollaborationWorkflow");
    expect(collaborationPrompt(settings)).toContain("readOnly=true");
  });
});

it("exposes both pinned developers for automatic assignment and explains workflow locks", () => {
  const automatic = { ...enabled, workflow: "auto" as const, codingMode: "auto" as const };
  expect(isCollaborationSettings(automatic)).toBe(true);
  expect(collaborationDefinitions(automatic).map(role => role.name)).toContain("collaboration-backend");
  expect(collaborationPrompt(automatic)).toContain("Pass the selected preset and a short concrete reason");
  expect(collaborationPrompt({ ...automatic, workflow: "quick" })).toContain("locked the collaboration workflow to quick");
});

it("new conversations default to automatic selection without broadening explicit read-only or single-writer intent", () => {
  expect(newSessionCollaboration({ ...enabled, workflow: "quick", codingMode: "split" })).toMatchObject({ workflow: "auto", codingMode: "auto", reviewModel: "pro/gpt" });
  expect(newSessionCollaboration({ ...enabled, workflow: "review", codingMode: "primary" })).toMatchObject({ workflow: "review", codingMode: "primary" });
});
