import { expect, it } from "vitest";
import { boundMergedInstructions } from "./project-instructions.js";

it("bounds merged task instruction chains without starving project rules or hiding truncation", () => {
  const entries = [ { source: "~/.pi/agent/AGENTS.md", content: "global".repeat(10_000) },
    ...Array.from({ length: 64 }, (_, i) => ({ source: `src/${i}/AGENTS.md`, content: "规则".repeat(10_000) })) ];
  const result = boundMergedInstructions([...entries, entries[0]]);
  expect(result.entries.some(entry => entry.source === "src/0/AGENTS.md")).toBe(true);
  expect(result.entries.filter(entry => entry.source === "~/.pi/agent/AGENTS.md")).toHaveLength(1);
  expect(Buffer.byteLength(result.entries.map(entry => entry.content).join(""), "utf8")).toBeLessThan(65_536);
  expect(JSON.stringify(result)).toContain("truncated");
  expect(JSON.stringify(result)).toContain("First omitted source: src/1/AGENTS.md");
});
