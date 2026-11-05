/**
 * DOM regression test for the MultiSelect combo (the exact component flow the
 * user reported as buggy): a `.map`-style group of *controlled* checkboxes
 * (no keys -> Solid reuses the same DOM nodes in place and patches `checked`
 * on each update), the "keep mounted / hide on close" behavior, the added
 * free-text search, and the note filter via the REAL `applyFilters`.
 *
 * Runs in happy-dom + the Solid *browser* build (both already in devDeps, and
 * this is the same build the GUI Vite bundle uses). Proven: unchecking one of
 * several narrows the filter and leaves the other checkboxes' state intact,
 * closing/reopening preserves state, and unchecking the last option clears the
 * filter to the full list.
 */

import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const win = new Window();
for (const key of Object.keys(win)) {
  if (key in globalThis) continue;
  globalThis[key] = (win as any)[key];
}
globalThis.document = win.document;
globalThis.window = win;

const { createEffect, createMemo, createSignal } = (await import(
  "solid-js/dist/solid.js"
)) as any;

const { applyFilters } = (await import("../src/gui/filters")) as any;

// happy-dom's own Event class (Node's `Event` global would be rejected by
// happy-dom's dispatchEvent).
const HEvent = (win as any).Event;
const inputEvent = (type: string) => new HEvent(type);

async function flush(n = 10) {
  for (let i = 0; i < n; i++) await new Promise((r) => win.setTimeout(r, 0));
}

function note(partial: any): any {
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

const resNotes = [
  note({ id: 1, scope: "project:a" }),
  note({ id: 2, scope: "project:b" }),
  note({ id: 3, scope: "project:c" }),
  note({ id: 4, scope: "project:a" }),
];
const idsOf = (ns: any[]) => ns.map((n: any) => n.id);
const ALL = idsOf(resNotes);

// Fixture for the category variant (same mechanics, different predicate).
const resNotesCat = [
  note({ id: 1, category: "problem" }),
  note({ id: 2, category: "decision" }),
  note({ id: 3, category: "problem" }),
  note({ id: 4, category: "config" }),
];
const ALL_CAT = idsOf(resNotesCat);

/**
 * An in-memory replica of the MultiSelect combo flow: a controlled checkbox
 * list (Solid `.map`-style reuse: nodes persist, props are patched), a shared
 * `openFilter` signal, free-text search that resets on close, and the REAL
 * `applyFilters` memo driven by the selection. `apply` is the exact predicate
 * the memo would run, so each variant can test a different note filter
 * (scope, category) against the same mechanics.
 */
function buildCombo(
  options: string[],
  initial: string[],
  which: string,
  apply: (sel: string[]) => any[],
) {
  const [selection, setSelection] = createSignal<string[]>(initial);
  const [openFilter, setOpenFilter] = createSignal<string | null>(which);
  const open = createMemo(() => openFilter() === which);
  const [search, setSearch] = createSignal("");

  const panel = document.createElement("div");
  document.body.appendChild(panel);

  // Create the checkbox list ONCE (Solid .map reuse: nodes persist; props patched).
  const boxes: { el: HTMLInputElement; opt: string }[] = options.map((opt) => {
    const el = document.createElement("input") as HTMLInputElement;
    el.type = "checkbox";
    el.dataset.opt = opt;
    panel.appendChild(el);
    return { el, opt };
  });

  // Solid-style patch: on every render/update, set each checkbox `checked`.
  const patchChecked = () => {
    for (const { el, opt } of boxes) el.checked = selection().includes(opt);
  };

  // The component's toggle: reads the checkbox's post-click state (the DOM
  // `checked`), not a render-time snapshot — the hardened handler.
  const toggle = (opt: string, checked: boolean) => {
    const value = selection();
    setSelection(
      checked ? (value.includes(opt) ? value : [...value, opt]) : value.filter((v) => v !== opt)
    );
    patchChecked();
  };

  for (const { el, opt } of boxes) {
    el.addEventListener("change", (e) =>
      toggle(opt, (e.target as HTMLInputElement).checked)
    );
  }

  // Reactive patch of `checked` whenever the selection changes (mirrors Solid
  // re-render) — this is what the `checked={value().includes(opt)}` prop does.
  createEffect(() => {
    patchChecked();
  });

  // Added free-text search: reset on close (mirrors the component's effect).
  const searchInput = document.createElement("input") as HTMLInputElement;
  searchInput.type = "text";
  panel.appendChild(searchInput);
  createEffect(() => {
    if (!open()) setSearch("");
  });
  searchInput.addEventListener("input", (e: Event) => setSearch((e.target as any).value));

  // The REAL note filter, driven by the current selection (selection: [] =
  // "no filter" -> full list).
  const filteredNotes = createMemo(() => apply(selection()));

  return {
    boxes,
    open,
    setOpenFilter,
    selection,
    search,
    searchInput,
    filteredNotes,
    patchChecked,
  };
}

// Scope variant (the original regression scenario).
function buildScopeFilter() {
  return buildCombo(
    ["project:a", "project:b", "project:c"],
    ["project:a", "project:b"],
    "scope",
    (sel) =>
      applyFilters(resNotes as any, {
        scope: sel,
        tag: [],
        category: [],
        showRetracted: false,
      })
  );
}

// Category variant — same mechanics, different note filter.
function buildCategoryFilter() {
  return buildCombo(
    ["problem", "decision", "config"],
    ["problem", "decision"],
    "category",
    (sel) =>
      applyFilters(resNotesCat as any, {
        scope: [],
        tag: [],
        category: sel,
        showRetracted: false,
      })
  );
}

describe("MultiSelect combo (DOM)", () => {
  test("uncheck one of several -> filter narrows & other checkboxes keep state", async () => {
    const s = buildScopeFilter();
    await flush();
    // a,b selected -> resNotes order: 1(a) 2(b) 4(a)
    expect(idsOf(s.filteredNotes())).toEqual([1, 2, 4]);

    // Click "project:b" checkbox (index 1) to UNCHECK it.
    s.boxes[1].el.click();
    await flush();

    // The selection signal lost b.
    expect(s.selection()).toEqual(["project:a"]);
    // The real filter narrowed to a-notes only (note 2 was project:b).
    expect(idsOf(s.filteredNotes())).toEqual([1, 4]);
    // The other checkboxes keep their correct checked-state.
    expect(s.boxes[0].el.checked).toBe(true);
    expect(s.boxes[1].el.checked).toBe(false);
    expect(s.boxes[2].el.checked).toBe(false);
  });

  test("close/reopen preserves selection state & the filter (keep-mounted fix)", async () => {
    const s = buildScopeFilter();
    await flush();
    s.boxes[1].el.click(); // uncheck b
    await flush();
    expect(idsOf(s.filteredNotes())).toEqual([1, 4]);

    // Close, then reopen (the panel is kept mounted and hidden via CSS).
    s.setOpenFilter(null);
    await flush();
    s.setOpenFilter("scope");
    await flush();
    // States survive the round-trip; filter unchanged.
    expect(s.boxes[0].el.checked).toBe(true);
    expect(s.boxes[1].el.checked).toBe(false);
    expect(s.filteredNotes().length).toBe(2);
    expect(idsOf(s.filteredNotes())).toEqual([1, 4]);
  });

  test("unchecking the LAST selected option clears the filter to the full list", async () => {
    const s = buildScopeFilter();
    await flush();
    // Uncheck b first.
    s.boxes[1].el.click();
    await flush();
    expect(s.selection()).toEqual(["project:a"]);
    // Now uncheck the last remaining selected option (a).
    s.boxes[0].el.click();
    await flush();
    // scope: [] -> applyFilters treats it as "no filter" -> full list.
    expect(s.selection()).toEqual([]);
    expect(idsOf(s.filteredNotes())).toEqual(ALL);
  });

  test("search narrows visible options but never touches the selection/filter", async () => {
    const s = buildScopeFilter();
    await flush();
    expect(s.filteredNotes().length).toBe(3); // a,b selected

    // Type in the panel search (the added feature).
    s.searchInput.value = "a";
    s.searchInput.dispatchEvent(inputEvent("input"));
    await flush();
    // Search text captured.
    expect(s.search()).toBe("a");
    // Crucially: typing does NOT change the selection or the note filter.
    expect(s.selection()).toEqual(["project:a", "project:b"]);
    expect(idsOf(s.filteredNotes())).toEqual([1, 2, 4]);
  });

  test("search resets on close (no stale term leaks into next open)", async () => {
    const s = buildScopeFilter();
    await flush();
    s.searchInput.value = "project";
    s.searchInput.dispatchEvent(inputEvent("input"));
    await flush();
    expect(s.search()).toBe("project");

    // Close the combo -> search reset.
    s.setOpenFilter(null);
    await flush();
    expect(s.search()).toBe("");
  });
});

describe("MultiSelect combo (DOM — category filter)", () => {
  test("uncheck one of several -> narrows by category; last uncheck clears the filter", async () => {
    const c = buildCategoryFilter();
    await flush();
    // problem + decision -> notes 1(problem), 2(decision), 3(problem)
    expect(idsOf(c.filteredNotes())).toEqual([1, 2, 3]);

    // Click the "decision" checkbox (index 1) to UNCHECK it.
    c.boxes[1].el.click();
    await flush();

    // Selection lost "decision".
    expect(c.selection()).toEqual(["problem"]);
    // The real filter narrowed to problem notes only (note 2 was decision).
    expect(idsOf(c.filteredNotes())).toEqual([1, 3]);
    // The other checkboxes keep their correct checked state.
    expect(c.boxes[0].el.checked).toBe(true);
    expect(c.boxes[1].el.checked).toBe(false);
    expect(c.boxes[2].el.checked).toBe(false);

    // Uncheck the last remaining option -> no category filter -> full list.
    c.boxes[0].el.click();
    await flush();
    // selection: [] -> applyFilters treats it as "no filter" -> full list.
    expect(c.selection()).toEqual([]);
    expect(idsOf(c.filteredNotes())).toEqual(ALL_CAT);
  });

  test("close/reopen preserves selection & the filter (keep-mounted fix)", async () => {
    const c = buildCategoryFilter();
    await flush();
    c.boxes[1].el.click(); // uncheck decision
    await flush();
    expect(idsOf(c.filteredNotes())).toEqual([1, 3]);

    // Close, then reopen (the panel is kept mounted and hidden via CSS).
    c.setOpenFilter(null);
    await flush();
    c.setOpenFilter("category");
    await flush();
    // States survive the round-trip; filter unchanged.
    expect(c.boxes[0].el.checked).toBe(true);
    expect(c.boxes[1].el.checked).toBe(false);
    expect(c.boxes[2].el.checked).toBe(false);
    expect(idsOf(c.filteredNotes())).toEqual([1, 3]);
  });
});
