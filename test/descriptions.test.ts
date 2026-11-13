/**
 * Catalog contract: Code Mode truncates a tool description with an ellipsis
 * around 119 characters, so anything past that never reaches the model. Keep
 * every description inside the budget, with the load-bearing sentence first.
 */

import { describe, expect, test } from "bun:test";
import * as notes from "../notes.js";
import { NOTES_NAMESPACE } from "../notes.js";

const BUDGET = 110;
const MAX_PARAM_WORDS = 6;

interface ToolLike {
  name: string;
  description: string;
  input: { shape: Record<string, { description?: string }> };
}

const tools = (Object.values(notes) as unknown[]).filter(
  (value): value is ToolLike =>
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "description" in value &&
    "input" in value,
);

describe("catalog descriptions", () => {
  test("every tool and the namespace fit the budget", () => {
    expect(NOTES_NAMESPACE.description.length).toBeLessThanOrEqual(BUDGET);
    for (const tool of tools) {
      expect(tool.description.length, tool.name).toBeLessThanOrEqual(BUDGET);
    }
  });

  test("keeps the load-bearing rules in the visible part", () => {
    const byName = new Map(tools.map((tool) => [tool.name, tool.description]));
    expect(byName.get("add")).toContain("Symptom");
    expect(byName.get("search")).toContain("retracted");
    expect(byName.get("pin")).toContain("notes-context");
  });

  test("keeps every parameter description short enough for the catalog", () => {
    for (const tool of tools) {
      for (const [name, property] of Object.entries(tool.input.shape)) {
        const description = property.description ?? "";
        expect(description.length, `${tool.name}.${name}`).toBeGreaterThan(0);
        expect(
          description.split(/\s+/).filter(Boolean).length,
          `${tool.name}.${name}`,
        ).toBeLessThanOrEqual(MAX_PARAM_WORDS);
      }
    }
  });
});
