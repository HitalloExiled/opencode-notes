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
  noteMatchesScope,
  pruneSelection,
  scopeLabel,
  scopeKeysOf,
  scopeOf,
  sortPinnedFirst,
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
    projects: [],
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
/* scopeOf / scopeKeysOf / noteMatchesScope / scopeLabel                */
/* ------------------------------------------------------------------ */

describe("scopeOf (first filter key)", () => {
  test("no scope / 'all' -> 'all'", () => {
    expect(scopeOf(note({ scope: undefined }))).toBe("all");
    expect(scopeOf(note({ scope: "all" }))).toBe("all");
  });

  test("'machine' -> 'machine'", () => {
    expect(scopeOf(note({ scope: "machine" }))).toBe("machine");
  });

  test("'project' with paths -> the first path is its key", () => {
    expect(scopeOf(note({ scope: "project", projects: ["/a/b/c", "/x/y"] }))).toBe("/a/b/c");
  });

  test("'project' without paths -> 'project' fallback", () => {
    expect(scopeOf(note({ scope: "project", projects: [] }))).toBe("project");
  });
});

describe("scopeKeysOf (every filter key; multi-project aware)", () => {
  test("non-project scopes -> a single key", () => {
    expect(scopeKeysOf(note({ scope: undefined }))).toEqual(["all"]);
    expect(scopeKeysOf(note({ scope: "all" }))).toEqual(["all"]);
    expect(scopeKeysOf(note({ scope: "machine" }))).toEqual(["machine"]);
  });

  test("'project' with paths -> one key per project path", () => {
    expect(scopeKeysOf(note({ scope: "project", projects: ["/a/b/c", "/x/y"] }))).toEqual(["/a/b/c", "/x/y"]);
  });

  test("'project' without paths -> the 'project' fallback key", () => {
    expect(scopeKeysOf(note({ scope: "project", projects: [] }))).toEqual(["project"]);
  });
});

describe("noteMatchesScope (a note matches an option iff the option is one of its keys)", () => {
  test("a multi-project note matches each of its projects — and nothing else", () => {
    const n = note({ scope: "project", projects: ["/a/b/c", "/x/y"] });
    expect(noteMatchesScope(n, "/a/b/c")).toBe(true);
    expect(noteMatchesScope(n, "/x/y")).toBe(true);
    expect(noteMatchesScope(n, "/nope")).toBe(false);
    expect(noteMatchesScope(n, "all")).toBe(false);
    expect(noteMatchesScope(n, "machine")).toBe(false);
    expect(noteMatchesScope(n, "project")).toBe(false);
  });

  test("single-key notes match only their own option", () => {
    expect(noteMatchesScope(note({ scope: "machine" }), "machine")).toBe(true);
    expect(noteMatchesScope(note({ scope: "machine" }), "all")).toBe(false);
    expect(noteMatchesScope(note({ scope: "project", projects: [] }), "project")).toBe(true);
    expect(noteMatchesScope(note({ scope: "project", projects: [] }), "/a/b/c")).toBe(false);
  });
});

describe("scopeLabel", () => {
  test("'all' / no scope -> no chip (empty label)", () => {
    expect(scopeLabel(note({ scope: undefined }))).toBe("");
    expect(scopeLabel(note({ scope: "all" }))).toBe("");
  });

  test("'machine' -> 'machine'", () => {
    expect(scopeLabel(note({ scope: "machine" }))).toBe("machine");
  });

  test("'project' -> basename of the path", () => {
    expect(scopeLabel(note({ scope: "project", projects: ["/home/user/dev/app"] }))).toBe("app");
    expect(scopeLabel(note({ scope: "project", projects: ["/a/b"] }))).toBe("b");
  });

  test("'project' with several paths -> basenames joined", () => {
    expect(scopeLabel(note({ scope: "project", projects: ["/home/user/dev/app", "/srv/apps/b"] }))).toBe(
      "app · b",
    );
  });

  test("'project' without a path -> 'project'", () => {
    expect(scopeLabel(note({ scope: "project", projects: [] }))).toBe("project");
  });
});

/* ------------------------------------------------------------------ */
/* applyFilters — scope / tag / category                               */
/* ------------------------------------------------------------------ */

// Scope keys in the fixture:
//   1,3 -> "/home/user/dev/agentic-dev-infra"  (same project, two notes)
//   2   -> "/srv/apps/opencode-tools"
//   4   -> "machine"
//   5   -> "all"
//   6   -> undefined -> "all"
//   7   -> "project" without a path -> "project"
const INFRA = "/home/user/dev/agentic-dev-infra";
const TOOLS = "/srv/apps/opencode-tools";

const base: Note[] = [
  note({
    id: 1,
    scope: "project",
    projects: [INFRA],
    tags: "x y",
    category: "problem",
  }),
  note({
    id: 2,
    scope: "project",
    projects: [TOOLS],
    tags: "z",
    category: "decision",
  }),
  note({
    id: 3,
    pinned: true,
    scope: "project",
    projects: [INFRA],
    tags: "y z3",
    category: "config",
  }),
  note({ id: 4, scope: "machine", tags: "w", category: "problem" }),
  note({ id: 5, scope: "all", tags: "e", category: "snippet" }),
  note({ id: 6, scope: undefined, tags: "n", category: "problem" }),
  note({ id: 7, scope: "project", tags: "p", category: "problem" }),
];

const ALL = base.map((n) => n.id); // [1..7]

// ids returned when filtering `notes` by the given chips (retracted hidden,
// the default main-list state). Defaults to the single-project `base`;
// pass a fixture explicitly for the multi-project section below. Keeps
// assertions flat and readable.
function idsOf(
  p: {
    scope?: string[];
    tag?: string[];
    category?: string[];
    projectOnly?: boolean;
    projectPath?: string;
  },
  notes: Note[] = base,
) {
  return applyFilters(notes, {
    scope: p.scope ?? [],
    tag: p.tag ?? [],
    category: p.category ?? [],
    showRetracted: false,
    projectOnly: p.projectOnly ?? false,
    projectPath: p.projectPath ?? "",
  }).map((n) => n.id);
}

describe("applyFilters (scope / tag / category)", () => {
  test("no chips selected -> every note, in order", () => {
    expect(idsOf({})).toEqual(ALL);
  });

  test("scope: empty -> all, specific -> matching only", () => {
    expect(idsOf({ scope: [] })).toEqual(ALL);
    expect(idsOf({ scope: ["machine"] })).toEqual([4]);
    expect(idsOf({ scope: ["all"] })).toEqual([5, 6]);
    // two notes in the same project group under one option
    expect(idsOf({ scope: [INFRA] })).toEqual([1, 3]);
    expect(idsOf({ scope: [TOOLS] })).toEqual([2]);
    // multi-select: union
    expect(idsOf({ scope: [INFRA, "machine", "all"] })).toEqual([1, 3, 4, 5, 6]);
    // the 'project'-without-path fallback is its own option
    expect(idsOf({ scope: ["project"] })).toEqual([7]);
    // an unknown key matches nothing for that value, keeps the rest
    expect(idsOf({ scope: [INFRA, "nonexistent"] })).toEqual([1, 3]);
  });

  test("tag: empty -> all, specific -> notes carrying any of them", () => {
    expect(idsOf({ tag: [] })).toEqual(ALL);
    expect(idsOf({ tag: ["y"] })).toEqual([1, 3]);
    // multi-select: union of the tags, in base order
    expect(idsOf({ tag: ["w", "z"] })).toEqual([2, 4]);
  });

  test("scope + tag combine (AND)", () => {
    expect(idsOf({ scope: [INFRA], tag: ["y"] })).toEqual([1, 3]);
    expect(idsOf({ scope: [INFRA], tag: ["x"] })).toEqual([1]);
    expect(idsOf({ scope: [INFRA], tag: ["z3"] })).toEqual([3]);
  });

  test("deselecting a scope (selection -> []) returns the full list", () => {
    expect(idsOf({ scope: [INFRA] })).toEqual([1, 3]); // narrows while selected
    expect(idsOf({ scope: [] })).toEqual(ALL); // back to full when deselected
  });

  test("deselecting a tag (selection -> []) returns the full list", () => {
    expect(idsOf({ tag: ["y"] })).toEqual([1, 3]);
    expect(idsOf({ tag: [] })).toEqual(ALL);
  });

  test("category: empty -> all, specific -> matching only", () => {
    expect(idsOf({ category: [] })).toEqual(ALL);
    expect(idsOf({ category: ["problem"] })).toEqual([1, 4, 6, 7]);
    expect(idsOf({ category: ["decision", "config"] })).toEqual([2, 3]);
    // an unknown category matches nothing for that value, keeps the rest
    expect(idsOf({ category: ["decision", "nonexistent"] })).toEqual([2]);
  });

  test("category + scope combine (AND)", () => {
    expect(idsOf({ scope: [INFRA], category: ["problem"] })).toEqual([1]);
    expect(idsOf({ scope: [INFRA], category: ["config"] })).toEqual([3]);
    expect(idsOf({ scope: ["machine"], category: ["problem"] })).toEqual([4]);
    // all three combine (AND)
    expect(idsOf({ scope: [INFRA], tag: ["x"], category: ["problem"] })).toEqual([1]);
  });

  test("deselecting a category (selection -> []) returns the full list", () => {
    expect(idsOf({ category: ["problem"] })).toEqual([1, 4, 6, 7]);
    expect(idsOf({ category: [] })).toEqual(ALL);
  });

  test("order is preserved (stable filter)", () => {
    expect(idsOf({ scope: [TOOLS, "machine", "all"] })).toEqual([2, 4, 5, 6]);
  });

  test("projectOnly: false -> all, true -> notes from the given project only", () => {
    expect(idsOf({ projectOnly: false })).toEqual(ALL);
    // two notes share the INFRA project
    expect(idsOf({ projectOnly: true, projectPath: INFRA })).toEqual([1, 3]);
    expect(idsOf({ projectOnly: true, projectPath: TOOLS })).toEqual([2]);
    // a path with no notes -> nothing
    expect(idsOf({ projectOnly: true, projectPath: "/other/project" })).toEqual([]);
    // no current project (empty path) -> nothing
    expect(idsOf({ projectOnly: true, projectPath: "" })).toEqual([]);
    // AND with the other filters
    expect(idsOf({ projectOnly: true, projectPath: INFRA, tag: ["x"] })).toEqual([1]);
    expect(idsOf({ projectOnly: true, projectPath: INFRA, tag: ["z3"] })).toEqual([3]);
    expect(idsOf({ projectOnly: true, projectPath: INFRA, category: ["config"] })).toEqual([3]);
    expect(idsOf({ projectOnly: true, projectPath: INFRA, category: ["decision"] })).toEqual([]);
    // combined with a conflicting scope selection (AND)
    expect(idsOf({ projectOnly: true, projectPath: INFRA, scope: [TOOLS] })).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* applyFilters — multi-project (a note can hold several projects)      */
/* ------------------------------------------------------------------ */

// Note 8 belongs to BOTH projects at once: it must appear in *each* of their
// filters, exactly once, in fixture order.
const multiBase: Note[] = [
  ...base,
  note({
    id: 8,
    scope: "project",
    projects: [INFRA, TOOLS],
    tags: "m",
    category: "decision",
  }),
];

describe("applyFilters (multi-project)", () => {
  test("a multi-project note shows up under each project's projectOnly filter", () => {
    expect(idsOf({ projectOnly: true, projectPath: INFRA }, multiBase)).toEqual([1, 3, 8]);
    expect(idsOf({ projectOnly: true, projectPath: TOOLS }, multiBase)).toEqual([2, 8]);
  });

  test("a scope option matches every note that carries it as a key", () => {
    expect(idsOf({ scope: [TOOLS] }, multiBase)).toEqual([2, 8]);
    expect(idsOf({ scope: [INFRA] }, multiBase)).toEqual([1, 3, 8]);
    // multi-select: union; the multi-project note appears once, in base order
    // (note 2 is TOOLS, before note 3, so the order is 1, 2, 3, 8)
    expect(idsOf({ scope: [INFRA, TOOLS] }, multiBase)).toEqual([1, 2, 3, 8]);
    // adding "machine" + "all" brings in notes 4, 5, 6 — which sit before
    // note 8 in base order (note 8 is appended last to multiBase)
    expect(idsOf({ scope: [INFRA, TOOLS, "machine", "all"] }, multiBase)).toEqual([1, 2, 3, 4, 5, 6, 8]);
  });

  test("a multi-project note is invisible to non-project filters", () => {
    expect(idsOf({ scope: ["machine", "all"] }, multiBase)).toEqual([4, 5, 6]);
    expect(idsOf({ projectOnly: false }, multiBase)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

/* ------------------------------------------------------------------ */
/* applyFilters — retracted (separate fixture so it never muddies the
 * scope/tag "all notes" expectations)                                */
/* ------------------------------------------------------------------ */

const withRetracted: Note[] = [
  note({ id: 1, scope: "all", tags: "a" }),
  note({ id: 2, scope: "machine", tags: "b", retractedAt: "2020-01-01T00:00:00Z" }),
];

describe("applyFilters (retracted)", () => {
  test("showRetracted=false hides retracted notes", () => {
    const r = applyFilters(withRetracted, { scope: [], tag: [], category: [], showRetracted: false, projectOnly: false, projectPath: "" });
    expect(r.map((n) => n.id)).toEqual([1]);
  });

  test("showRetracted=true shows only the retracted notes", () => {
    const r = applyFilters(withRetracted, { scope: [], tag: [], category: [], showRetracted: true, projectOnly: false, projectPath: "" });
    expect(r.map((n) => n.id)).toEqual([2]);
  });

  test("retracted notes drop out of tag matches when hidden", () => {
    const hidden = applyFilters(withRetracted, { scope: [], tag: ["b"], category: [], showRetracted: false, projectOnly: false, projectPath: "" });
    expect(hidden.map((n) => n.id)).toEqual([]); // "b" only hits the retracted note
    const shown = applyFilters(withRetracted, { scope: [], tag: ["b"], category: [], showRetracted: true, projectOnly: false, projectPath: "" });
    expect(shown.map((n) => n.id)).toEqual([2]); // same tag while Retiradas is on
  });
});

/* ------------------------------------------------------------------ */
/* sortPinnedFirst                                                      */
/* ------------------------------------------------------------------ */

describe("sortPinnedFirst", () => {
  test("empty -> empty", () => {
    expect(sortPinnedFirst([])).toEqual([]);
  });

  test("pinned notes move first, relative order preserved inside each group", () => {
    const notes = [
      note({ id: 1 }),
      note({ id: 2, pinned: true }),
      note({ id: 3 }),
      note({ id: 4, pinned: true }),
      note({ id: 5 }),
    ];
    expect(sortPinnedFirst(notes).map((n) => n.id)).toEqual([2, 4, 1, 3, 5]);
  });

  test("all pinned / all unpinned -> unchanged order", () => {
    const pinned = [
      note({ id: 1, pinned: true }),
      note({ id: 2, pinned: true }),
    ];
    expect(sortPinnedFirst(pinned).map((n) => n.id)).toEqual([1, 2]);
    const plain = [note({ id: 1 }), note({ id: 2 })];
    expect(sortPinnedFirst(plain).map((n) => n.id)).toEqual([1, 2]);
  });

  test("does not mutate the input", () => {
    const notes = [note({ id: 1 }), note({ id: 2, pinned: true })];
    sortPinnedFirst(notes);
    expect(notes.map((n) => n.id)).toEqual([1, 2]);
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
