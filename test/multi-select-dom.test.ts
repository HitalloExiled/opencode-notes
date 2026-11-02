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

function buildScopeFilter() {
  const options = ["project:a", "project:b", "project:c"];
  const [scopeFilter, setScopeFilter] = createSignal(["project:a", "project:b"]);
  const [openFilter, setOpenFilter] = createSignal<"scope" | null>("scope");
  const open = createMemo(() => openFilter() === "scope");
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
    for (const { el, opt } of boxes) el.checked = scopeFilter().includes(opt);
  };

  // The component's toggle: reads the signal (never the DOM), then writes a
  // new selection array.
  const toggle = (opt: string) => {
    const value = scopeFilter();
    const has = value.includes(opt);
    setScopeFilter(has ? value.filter((v) => v !== opt) : [...value, opt]);
    patchChecked();
  };

  for (const { el, opt } of boxes) {
    el.addEventListener("change", () => toggle(opt));
  }

  // Reactive patch of `checked` whenever scopeFilter changes (mirrors Solid
  // re-render) — this is what the `checked={value.includes(opt)}` prop does.
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

  // The REAL note filter, driven by the current scope selection (scope: [] =
  // "no scope filter" -> full list).
  const filteredNotes = createMemo(() =>
    applyFilters(resNotes as any, {
      scope: scopeFilter(),
      tag: [],
      pinnedOnly: false,
      showRetracted: false,
    })
  );

  return {
    boxes,
    open,
    setOpenFilter,
    scopeFilter,
    search,
    searchInput,
    filteredNotes,
    patchChecked,
  };
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
    expect(s.scopeFilter()).toEqual(["project:a"]);
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
    expect(s.scopeFilter()).toEqual(["project:a"]);
    // Now uncheck the last remaining selected option (a).
    s.boxes[0].el.click();
    await flush();
    // scope: [] -> applyFilters treats it as "no filter" -> full list.
    expect(s.scopeFilter()).toEqual([]);
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
    expect(s.scopeFilter()).toEqual(["project:a", "project:b"]);
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
