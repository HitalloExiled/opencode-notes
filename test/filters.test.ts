/**
 * Unit tests for the Notes GUI filter/display logic (src/gui/filters.ts).
 *
 * These are pure, deterministic tests — no DOM, no IPC, no signals — so they
 * guard the *logic* of the combo dropdowns and the reactive note filter exactly
 * as the production `view.tsx` runs it. This is the class of test that would
 * have caught a wrong filter predicate, a broken chip label, or a selection
 * that "sticks" after an option no longer exists.
 */

import { describe, expect, test } from "bun:test";
import type { Note } from "../src/gui/contract";
import {
  arraysSame,
  applyFilters,
  displayOf,
  filterByQuery,
  pruneSelection,
  tagsOf,
} from "../src/gui/filters";

function note(partial: Partial<Note> = {}): Note {
  return {
    id: 1,
    timestamp: "1970-01-01T00:00:00Z",
    category: "problem",
    title: "t",
    content: "c",
    pinned: false,
    ...partial,
  };
}

/* ------------------------------------------------------------------ */
/* tagsOf                                                               */
/* ------------------------------------------------------------------ */

describe("tagsOf", () => {
  test("empty / undefined / whitespace tags -> []", () => {
    expect(tagsOf(note())).toEqual([]);
    expect(tagsOf(note({ tags: "" }))).toEqual([]);
    expect(tagsOf(note({ tags: "   " }))).toEqual([]);
  });

  test("splits on runs of whitespace and trims", () => {
    expect(tagsOf(note({ tags: " a   b  c " }))).toEqual(["a", "b", "c"]);
  });

  test("deduplicates in first-seen order", () => {
    expect(tagsOf(note({ tags: "b a a c b" }))).toEqual(["b", "a", "c"]);
  });
});

/* ------------------------------------------------------------------ */
/* applyFilters — scope / tag / pinned (all notes non-retracted)        */
/* ------------------------------------------------------------------ */

// Categories are distributed across the fixture so the category predicate can
// be exercised against the same notes scope/tag tests use.
const base: Note[] = [
  note({ id: 1, scope: "project:a", tags: "x y", category: "problem" }),
  note({ id: 2, scope: "project:b", tags: "z", category: "decision" }),
  note({ id: 3, pinned: true, scope: "project:a", tags: "y", category: "config" }),
  note({ id: 4, scope: "global", tags: "w", category: "problem" }),
];

const ALL = base.map((n) => n.id); // [1, 2, 3, 4]

// ids returned when filtering `base` by the given chips (retracted hidden,
// the default main-list state). Keeps assertions flat and readable.
function idsOf(p: { scope?: string[]; tag?: string[]; category?: string[]; pinnedOnly?: boolean }) {
  return applyFilters(base, {
    scope: p.scope ?? [],
    tag: p.tag ?? [],
    category: p.category ?? [],
    pinnedOnly: p.pinnedOnly ?? false,
    showRetracted: false,
  }).map((n) => n.id);
}

describe("applyFilters (scope / tag / category / pinned)", () => {
  test("no chips selected -> every note, in order", () => {
    expect(idsOf({})).toEqual(ALL);
  });

  test("scope: empty -> all, specific -> matching only", () => {
    expect(idsOf({ scope: [] })).toEqual(ALL);
    expect(idsOf({ scope: ["project:a"] })).toEqual([1, 3]);
    expect(idsOf({ scope: ["global"] })).toEqual([4]);
    // multi-select: union
    expect(idsOf({ scope: ["project:a", "global"] })).toEqual([1, 3, 4]);
    // an unknown scope matches nothing for that value, keeps the rest
    expect(idsOf({ scope: ["project:a", "nonexistent"] })).toEqual([1, 3]);
  });

  test("tag: empty -> all, specific -> notes carrying any of them", () => {
    expect(idsOf({ tag: [] })).toEqual(ALL);
    expect(idsOf({ tag: ["y"] })).toEqual([1, 3]);
    // multi-select: union of the tags, in base order
    expect(idsOf({ tag: ["w", "z"] })).toEqual([2, 4]);
  });

  test("pinnedOnly: true -> only pinned; false -> all", () => {
    expect(idsOf({ pinnedOnly: true })).toEqual([3]);
    expect(idsOf({ pinnedOnly: false })).toEqual(ALL);
  });

  test("scope + tag combine (AND)", () => {
    expect(idsOf({ scope: ["project:a"], tag: ["y"] })).toEqual([1, 3]);
    expect(idsOf({ scope: ["project:a"], tag: ["x"] })).toEqual([1]);
  });

  test("deselecting a scope (selection -> []) returns the full list", () => {
    expect(idsOf({ scope: ["project:a"] })).toEqual([1, 3]); // narrows while selected
    expect(idsOf({ scope: [] })).toEqual(ALL); // back to full when deselected
  });

  test("deselecting a tag (selection -> []) returns the full list", () => {
    expect(idsOf({ tag: ["y"] })).toEqual([1, 3]);
    expect(idsOf({ tag: [] })).toEqual(ALL);
  });

  test("category: empty -> all, specific -> matching only", () => {
    expect(idsOf({ category: [] })).toEqual(ALL);
    expect(idsOf({ category: ["problem"] })).toEqual([1, 4]);
    expect(idsOf({ category: ["decision", "config"] })).toEqual([2, 3]);
    // an unknown category matches nothing for that value, keeps the rest
    expect(idsOf({ category: ["decision", "nonexistent"] })).toEqual([2]);
  });

  test("category + scope combine (AND)", () => {
    expect(idsOf({ scope: ["project:a"], category: ["problem"] })).toEqual([1]);
    expect(idsOf({ scope: ["project:a"], category: ["config"] })).toEqual([3]);
    expect(idsOf({ scope: ["global"], category: ["problem"] })).toEqual([4]);
    // all three combine (AND)
    expect(idsOf({ scope: ["project:a"], tag: ["x"], category: ["problem"] })).toEqual([1]);
  });

  test("deselecting a category (selection -> []) returns the full list", () => {
    expect(idsOf({ category: ["problem"] })).toEqual([1, 4]); // narrows while selected
    expect(idsOf({ category: [] })).toEqual(ALL); // back to full when deselected
  });

  test("order is preserved (stable filter)", () => {
    expect(idsOf({ scope: ["project:a", "global"] })).toEqual([1, 3, 4]);
  });
});

/* ------------------------------------------------------------------ */
/* applyFilters — retracted (separate fixture so it never muddies the
 * scope/tag/pinned "all notes" expectations)                          */
/* ------------------------------------------------------------------ */

const withRetracted: Note[] = [
  note({ id: 1, scope: "global", tags: "a" }),
  note({ id: 2, scope: "global", tags: "b", retractedAt: "2020-01-01T00:00:00Z" }),
];

describe("applyFilters (retracted)", () => {
  test("showRetracted=false hides retracted notes", () => {
    const r = applyFilters(withRetracted, { scope: [], tag: [], category: [], pinnedOnly: false, showRetracted: false });
    expect(r.map((n) => n.id)).toEqual([1]);
  });

  test("showRetracted=true shows only the retracted notes", () => {
    const r = applyFilters(withRetracted, { scope: [], tag: [], category: [], pinnedOnly: false, showRetracted: true });
    expect(r.map((n) => n.id)).toEqual([2]);
  });

  test("retracted notes drop out of tag matches when hidden", () => {
    const hidden = applyFilters(withRetracted, { scope: [], tag: ["b"], category: [], pinnedOnly: false, showRetracted: false });
    expect(hidden.map((n) => n.id)).toEqual([]); // "b" only hits the retracted note
    const shown = applyFilters(withRetracted, { scope: [], tag: ["b"], category: [], pinnedOnly: false, showRetracted: true });
    expect(shown.map((n) => n.id)).toEqual([2]); // same tag while Retiradas is on
  });
});

/* ------------------------------------------------------------------ */
/* arraysSame                                                           */
/* ------------------------------------------------------------------ */

describe("arraysSame", () => {
  test("equal arrays (order-sensitive) -> true", () => {
    expect(arraysSame(["a", "b"], ["a", "b"])).toBe(true);
    expect(arraysSame([], [])).toBe(true);
  });

  test("different value / length / order -> false", () => {
    expect(arraysSame(["a", "b"], ["a", "c"])).toBe(false);
    expect(arraysSame(["a", "b"], ["a"])).toBe(false);
    expect(arraysSame(["a", "b"], ["b", "a"])).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* pruneSelection                                                       */
/* ------------------------------------------------------------------ */

describe("pruneSelection", () => {
  test("keeps a selection unchanged (same reference) when all values exist", () => {
    const sel = ["a", "b"];
    const result = pruneSelection(sel, (v) => ["a", "b"].includes(v));
    expect(result).toBe(sel);
    expect(result).toEqual(["a", "b"]);
  });

  test("drops values that no longer exist", () => {
    expect(pruneSelection(["a", "b", "c"], (v) => v === "a")).toEqual(["a"]);
  });

  test("drops everything when none exist", () => {
    expect(pruneSelection(["a", "b"], (v) => false)).toEqual([]);
  });

  test("returns a new array (not the original) when it must change", () => {
    const sel = ["a", "b"];
    const result = pruneSelection(sel, (v) => v === "a");
    expect(result).not.toBe(sel);
    expect(result).toEqual(["a"]);
  });
});

/* ------------------------------------------------------------------ */
/* displayOf                                                            */
/* ------------------------------------------------------------------ */

describe("displayOf", () => {
  test("empty selection -> placeholder", () => {
    expect(displayOf([], "Todos os escopos")).toBe("Todos os escopos");
  });

  test("single value -> the value", () => {
    expect(displayOf(["a"], "Todos")).toBe("a");
  });

  test("two values -> comma list, no count", () => {
    expect(displayOf(["a", "b"], "Todos")).toBe("a, b");
  });

  test("three values -> first two + '+1'", () => {
    expect(displayOf(["a", "b", "c"], "Todos")).toBe("a, b +1");
  });

  test("four values -> first two + '+2'", () => {
    expect(displayOf(["a", "b", "c", "d"], "Todos")).toBe("a, b +2");
  });

  test("long selection stays bounded", () => {
    expect(displayOf(["a", "b", "c", "d", "e"], "Todos")).toBe("a, b +3");
  });
});

/* ------------------------------------------------------------------ */
/* filterByQuery — the combo's free-text option filter                   */
/* ------------------------------------------------------------------ */

describe("filterByQuery", () => {
  const opts = ["alpha", "beta", "gamma", "Gamma2", "DELTA"];

  test("empty / whitespace term -> every option, same reference", () => {
    expect(filterByQuery(opts, "")).toBe(opts);
    expect(filterByQuery(opts, "   ")).toBe(opts);
    expect(filterByQuery(opts, "")).toEqual(opts);
  });

  test("term matches by case-insensitive substring", () => {
    expect(filterByQuery(opts, "gamma")).toEqual(["gamma", "Gamma2"]);
    expect(filterByQuery(opts, "GAMMA")).toEqual(["gamma", "Gamma2"]);
    // ("beta" also contains "a" -> every option matches)
    expect(filterByQuery(opts, "a")).toEqual(["alpha", "beta", "gamma", "Gamma2", "DELTA"]);
  });

  test("prefix/partial match", () => {
    expect(filterByQuery(opts, "de")).toEqual(["DELTA"]);
  });

  test("no match -> empty list (order preserved, not mutated)", () => {
    const empty = filterByQuery(opts, "zzz");
    expect(empty).toEqual([]);
    expect(opts).toEqual(["alpha", "beta", "gamma", "Gamma2", "DELTA"]);
  });

  test("order of the original list is preserved", () => {
    const r = filterByQuery(opts, "");
    expect(r).toEqual(opts);
  });
});
