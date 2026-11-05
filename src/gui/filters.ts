/**
 * Notes GUI — pure, framework-agnostic filter/display logic.
 *
 * These functions carry every bit of the "which notes show" and "what does a
 * combo display" decision. Keeping them pure (no signals, no DOM, no IPC) lets
 * them be tested in isolation and means the reactive `view.tsx` only wires the
 * current signal values through here — so deselecting an option or flipping a
 * chip re-filters via the reactive memo with no refetch.
 */

import type { Note } from "./contract"

/**
 * Split a note's space-separated tag string into a deduplicated, order-stable
 * list of tags. `undefined`/empty input yields `[]`.
 */
export function tagsOf(note: Note): string[] {
  const raw = (note.tags ?? "").trim()
  if (!raw) return []
  return [...new Set(raw.split(/\s+/).filter(Boolean))]
}

export type Filters = {
  /** Restrict to these scopes. `[]` means "no scope filter" (all). */
  scope: readonly string[]
  /** Restrict to notes carrying any of these tags. `[]` means all. */
  tag: readonly string[]
  /** Restrict to notes with any of these categories. `[]` means all. */
  category: readonly string[]
  /**
   * When true, show *only* the retracted notes (the "Retiradas" filter).
   * When false, retracted notes are hidden from the main list.
   */
  showRetracted: boolean
  /**
   * When true, restrict to notes from the *current project*: project-scoped
   * notes whose `scopeOf` key equals `projectPath`.
   */
  projectOnly: boolean
  /** The current project path to match against when `projectOnly` is true. */
  projectPath: string
}

/**
 * Apply the reactive note filters to an already-fetched, *unfiltered* result.
 *
 * This is the exact predicate the `filteredNotes` memo in `view.tsx` runs —
 * keeping the logic here (and testing it) is what makes a filter change
 * re-filter the list deterministically and instantly.
 */
export function applyFilters(
  res: Note[],
  { scope, tag, category, showRetracted, projectOnly, projectPath }: Filters
): Note[] {
  let out = res
  out = out.filter(
    (n) =>
      showRetracted
        ? n.retractedAt !== undefined
        : n.retractedAt === undefined
  )
  // Multi-project: a note belongs to the current project when *any* of its
  // project paths equals the path.
  if (projectOnly)
    out = out.filter((n) => n.scope === "project" && n.projects.includes(projectPath))
  if (scope.length) out = out.filter((n) => scope.some((s) => noteMatchesScope(n, s)))
  if (tag.length) out = out.filter((n) => tagsOf(n).some((t) => tag.includes(t)))
  if (category.length) out = out.filter((n) => category.includes(n.category ?? ""))
  return out
}

/**
 * Stable partition: pinned notes first, everything else after. The relative
 * order inside each group is preserved (the store already returns them by
 * timestamp, so the list keeps its recency order within each section).
 *
 * The GUI applies this *after* the filters, so the pinned section is built from
 * whatever the search/filters currently match — and before pagination, so
 * pinned notes always land on the first pages.
 */
export function sortPinnedFirst(notes: Note[]): Note[] {
  const pinned: Note[] = []
  const rest: Note[] = []
  for (const n of notes) (n.pinned ? pinned : rest).push(n)
  return [...pinned, ...rest]
}

/**
 * The filter keys a note belongs to. A non-project note has a single key (its
 * scope type: `"all"` or `"machine"`); a project-scoped note has one key per
 * project path (falling back to `"project"` when the set is empty). A note
 * with multiple projects therefore matches several options at once.
 */
export function scopeKeysOf(note: Note): readonly string[] {
  const s = note.scope
  if (s === "project") return note.projects.length ? note.projects : ["project"]
  return [s ?? "all"]
}

/**
 * Does a note match a single scope *option*? True when the option is any of
 * the note's keys — this is what makes a multi-project note show up under
 * *each* of its projects in the scope filter, and under the `projectOnly`
 * check when any of its paths equals the target.
 */
export function noteMatchesScope(note: Note, opt: string): boolean {
  return scopeKeysOf(note).includes(opt)
}

/**
 * The filter key a note belongs to (its first key). Two notes in the same
 * project compare equal on the key, which is what makes the multi-select scope
 * filter group by project.
 */
export function scopeOf(note: Note): string {
  return scopeKeysOf(note)[0] ?? "all"
}

/**
 * Short display label for a note's scope chip. Returns `""` for the default
 * `"all"` scope (so no chip is rendered). For `"project"`, the basename of the
 * absolute path (the full path stays available via the `title`). `"machine"`
 * renders as `"machine"`.
 */
export function scopeLabel(note: Note): string {
  const s = note.scope
  if (!s || s === "all") return ""
  if (s === "machine") return "machine"
  const paths = note.projects
  if (paths.length === 0) return "project"
  // Multi-project: one basename per path, joined so every project is visible.
  return paths.map((p) => p.split("/").pop() ?? p).join(" · ")
}

/** Structural equality for two string arrays (order-sensitive). */
export function arraysSame(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/**
 * Drop any selection value that no longer exists in the note set, so a deleted
 * note can't leave a phantom filter. Returns the *same* array reference when
 * nothing changed — critical in `view.tsx`, where writing back an unchanged
 * selection would re-trigger the self-healing effect and loop.
 */
export function pruneSelection(
  selection: string[],
  exists: (v: string) => boolean
): string[] {
  const next = selection.filter(exists)
  return arraysSame(selection, next) ? selection : next
}

/**
 * Compact text shown on a combo button when it has a selection.
 *
 *  - empty -> the placeholder
 *  - one value -> that value
 *  - two -> "a, b"
 *  - more -> "a, b +N" (N = values beyond the first two)
 *
 * Pure so the chip text can be tested and shared between the two combos.
 */
export function displayOf(values: readonly string[], placeholder: string): string {
  const n = values.length
  if (n === 0) return placeholder
  const firstTwo = values.slice(0, 2).join(", ")
  // One or two values fit as a plain list; more than two collapse to "a, b +N".
  if (n <= 2) return firstTwo
  return `${firstTwo} +${n - 2}`
}

/**
 * Narrow a combo's option list by a free-text search term (the input shown at
 * the top of the dropdown). Matching is case-insensitive substring; an empty/
 * whitespace-only term returns every option unchanged (same reference, so no
 * re-render work). Order is preserved.
 *
 * Pure so the combo can test exactly which options are visible for a query
 * without a DOM. The reactive view only passes `query()` through here — the
 * *selection* state (`value`) is never touched by a search, so unchecking/
 * re-checking survives the text filter.
 */
export function filterByQuery(
  options: readonly string[],
  q: string
): readonly string[] {
  const term = q.trim().toLowerCase()
  if (!term) return options
  return options.filter((o) => o.toLowerCase().includes(term))
}
