import { expect, it } from "vitest";
import { CollaborationReview } from "./collaboration-review.js";

const pass = { status: "completed", toolCalls: 1, report: '{"verdict":"pass","summary":"Inspected app.ts:1 and its callers."}' };
it("invalidates an old review when another tool can change the workspace", () => {
  const review = new CollaborationReview();
  review.noteTool("Read", { path: "app.ts" });
  expect(review.pending).toBe(false);
  review.noteTool("Write", { path: "app.ts" });
  const first = review.begin("/work", "fix the bug");
  review.noteTool("Bash", { command: "python patch.py" });
  expect(review.finish(first.revision, pass)).toBe(false);
  expect(review.needsReview).toBe(true);
  const second = review.begin("/work", "fix the bug");
  expect(review.finish(second.revision, pass)).toBe(true);
  expect(review.pending).toBe(false);
});
it.each([
  { ...pass, toolCalls: 0 }, { ...pass, status: "failed" },
  { ...pass, report: "PASS" }, { ...pass, report: '{"verdict":"pass","summary":""}' },
  { ...pass, report: '{"verdict":"inconclusive","summary":"missing files"}' },
])("refuses an unsupported success claim %#", (result) => {
  const review = new CollaborationReview(); review.noteTool("Edit", { path: "app.ts" });
  expect(review.finish(review.begin("/work", "fix").revision, result)).toBe(false);
  expect(review.pending).toBe(true);
  expect(review.needsReview).toBe(false);
});
it("bounds repair/review attempts", () => {
  const review = new CollaborationReview();
  for (let i = 0; i < 3; i++) { review.noteTool("Write", {}); review.begin("/work", "fix"); }
  expect(() => review.begin("/work", "fix")).toThrow("COLLABORATION_REVIEW_EXHAUSTED");
});
