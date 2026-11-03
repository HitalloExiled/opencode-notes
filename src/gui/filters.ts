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
  /** When true, only pinned notes. */
  pinnedOnly: boolean
  /**
   * When true, show *only* the retracted notes (the "Retiradas" filter).
   * When false, retracted notes are hidden from the main list.
   */
  showRetracted: boolean
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
  { scope, tag, category, pinnedOnly, showRetracted }: Filters
): Note[] {
  let out = res
  out = out.filter(
    (n) =>
      showRetracted
        ? n.retractedAt !== undefined
        : n.retractedAt === undefined
  )
  if (pinnedOnly) out = out.filter((n) => n.pinned)
  if (scope.length) out = out.filter((n) => scope.includes(n.scope ?? ""))
  if (tag.length) out = out.filter((n) => tagsOf(n).some((t) => tag.includes(t)))
  if (category.length) out = out.filter((n) => category.includes(n.category ?? ""))
  return out
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
