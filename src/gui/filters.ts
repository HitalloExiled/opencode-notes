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
  /** Restrict to notes touching any of these project paths. `[]` means all. */
  projects?: readonly string[]
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
  { scope, tag, category, showRetracted, projectOnly, projectPath, projects = [] }: Filters
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
  // Project multiselect: a note matches when any of its paths is selected, so
  // a multi-project note shows up under each selected project.
  if (projects.length)
    out = out.filter((n) => n.projects.some((p) => projects.includes(p)))
  if (scope.length) out = out.filter((n) => scope.some((s) => noteMatchesScope(n, s)))
  if (tag.length) out = out.filter((n) => tagsOf(n).some((t) => tag.includes(t)))
  if (category.length) out = out.filter((n) => category.includes(n.category ?? ""))
  return out
}

/** A section of the notes list. */
export type NoteGroup = {
  /** Stable key: "pinned", a project path, or "others". */
  key: string
  kind: "pinned" | "project" | "others"
  /** The project path, for `kind: "project"`. */
  project?: string
  notes: Note[]
}

/**
 * Group filtered notes for display: pinned first (lifted out of their project),
 * then one section per project in label order, then the global/machine notes.
 * A multi-project note belongs to its first path only, so no note repeats.
 *
 * `label` resolves a project path to the name shown in the header; it also
 * orders the project sections (locale compare).
 */
export function groupNotes(
  notes: Note[],
  label: (path: string) => string = (path) => path
): NoteGroup[] {
  const pinned: Note[] = []
  const byProject = new Map<string, Note[]>()
  const others: Note[] = []
  for (const note of notes) {
    if (note.pinned) {
      pinned.push(note)
      continue
    }
    const project = note.scope === "project" ? note.projects[0] : undefined
    if (!project) {
      others.push(note)
      continue
    }
    const list = byProject.get(project)
    if (list) list.push(note)
    else byProject.set(project, [note])
  }

  const groups: NoteGroup[] = []
  if (pinned.length) groups.push({ key: "pinned", kind: "pinned", notes: pinned })
  const projects = [...byProject.keys()].sort((a, b) => label(a).localeCompare(label(b)))
  for (const project of projects) {
    groups.push({ key: project, kind: "project", project, notes: byProject.get(project) ?? [] })
  }
  if (others.length) groups.push({ key: "others", kind: "others", notes: others })
  return groups
}

/**
 * Short project name for a section header: the basename, disambiguated with
 * the parent folder when two paths share it.
 */
export function projectLabel(path: string, paths: readonly string[] = []): string {
  const parts = path.split("/").filter(Boolean)
  const base = parts.at(-1) ?? path
  const sameBase = paths.filter((item) => (item.split("/").filter(Boolean).at(-1) ?? item) === base)
  if (sameBase.length <= 1) return base
  const parent = parts.at(-2)
  return parent ? `${parent}/${base}` : base
}

/**
 * The filter keys a note belongs to, one per project for a project-scoped
 * note (falling back to "project" when the set is empty); a non-project note
 * has a single key (its scope type). A multi-project note therefore matches
 * several options at once.
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
