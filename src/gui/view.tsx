/**
 * Notes side panel — SolidJS UI, aligned with the app design system.
 *
 * Renders the plugin's own `ctx.ui` components (buttons, text fields,
 * loader, icons) and the app's CSS tokens (`--v2-*`, `--font-*`), so the
 * panel follows the user's theme (light/dark), fonts and language. UI copy is
 * localized (pt-br or en-us, following the Opencode locale; en-us is the fallback).
 * Code stays in English.
 *
 * Data: reads notes over the GUI IPC (`ctx.main(NotesApi)`), full CRUD —
 * add / edit / confirm / dispute / retract / pin / unpin / restore —
 * FTS search with LIKE fallback, pinned notes grouped at the top, and
 * revision history.
 */

import { createEffect, createMemo, createSignal } from "solid-js"
import type { Accessor } from "solid-js"
import { Show } from "solid-js"
import { usePanel, usePlugin } from "@opencode/plugin/gui"
import { SHARED_CSS, ScrollNav, createScrollNav, EmptyState, ErrorBanner, LoadingRow } from "opencode-shared/gui"
import { scopeChipLabel, useT } from "./i18n"
import { NotesApi } from "./contract"
import type { Note, NoteDetail, NoteResult, Revision } from "./contract"
import {
  applyFilters,
  filterByQuery,
  noteMatchesScope,
  pruneSelection,
  scopeKeysOf,
  scopeOf,
  sortPinnedFirst,
  tagsOf,
} from "./filters"

// `value` stays in English (it is the data written to the DB and read by the
// notes tools). Display text lives in the i18n tables (`category.<value>`);
// `CATEGORIES` only enumerates the known values.
const CATEGORIES = [
  { value: "problem" },
  { value: "decision" },
  { value: "config" },
  { value: "snippet" },
  { value: "architecture" },
  { value: "user" },
  { value: "general" },
] as const

type FormState = {
  mode: "add" | "edit"
  id?: number
  category: string
  title: string
  content: string
  tags: string
  author: string
  scope: "all" | "machine" | "project"
  /**
   * Absolute project paths; used only when `scope` is `"project"`. One or
   * more for multi-project notes.
   */
  projects: string[]
}

const defaultForm: FormState = {
  mode: "add",
  category: "problem",
  title: "",
  content: "",
  tags: "",
  author: "",
  scope: "all",
  projects: [],
}

/* ------------------------------------------------------------------ */
/* Multi-select (combo)                                                */
/* ------------------------------------------------------------------ */
/*
 * A combo multi-select: a compact button that opens a checkbox-list
 * dropdown. Selections are an array of option values. Opening/closing is
 * controlled by the parent, which also owns the shared "click outside any
 * combo to close it + Escape" handler — so this component needs no refs or
 * per-combo listeners (this solid-js build does not expose `createRef`).
 */
type MultiSelectProps = {
  label: string
  placeholder: string
  options: string[]
  // Optional display mapping (e.g. category value -> pt-BR label). Selections
  // always store the raw option values; `display` only affects what is shown.
  display?: (opt: string) => string
  // Optional native tooltip (HTML `title`) per item, to reveal data that the
  // display label shortens (the full project path behind its basename). Return
  // `undefined` to suppress the hint for that item.
  optionTitle?: (opt: string) => string | undefined
  // Live selection as a reactive accessor (not a snapshot array): this makes
  // checked={value().includes(opt)} a tracked getter that re-syncs the DOM
  // whenever the selection changes, instead of going stale.
  value: Accessor<string[]>
  onValueChange: (v: string[]) => void
  // Reactive "is this combo open" source: the shared `openFilter` accessor
  // plus which combo this is. We memo it inside and CALL it at the <Show>
  // (`when={open()}`). Passing the memo uncalled would hand <Show> the
  // function (always truthy) instead of its boolean, so the panel would be
  // stuck open.
  openFilter: Accessor<string | null>
  which: "scope" | "tag" | "category" | "project"
  onOpenChange: () => void
}

function MultiSelect(props: MultiSelectProps) {
  const { label, placeholder, options, value, onValueChange, openFilter, which, onOpenChange } = props
  const ctx = usePlugin()
  const t = useT()
  const show = (opt: string) => props.display?.(opt) ?? opt
  // Reactive open state (memo => a signal <Show> can track), driven by the
  // shared `openFilter` so only one combo is open at a time.
  const open = createMemo(() => openFilter() === which)

  // Derive the next selection from the checkbox's actual post-click state
  // (e.target.checked), not from a render-time snapshot. This ties the note
  // filter directly to what the user sees in the dropdown: if they uncheck,
  // the DOM `checked` is false -> we drop the option -> the filter narrows /
  // clears, even in the worst case.
  const toggle = (opt: string, checked: boolean) => {
    const current = value()
    if (checked) onValueChange(current.includes(opt) ? current : [...current, opt])
    else onValueChange(current.filter((v) => v !== opt))
  }
  const clear = () => onValueChange([])

  // Free-text search that narrows the options shown in the dropdown. Reset on
  // close so stale text never carries into the next open; the *selection*
  // (value) is intentionally untouched by the search, so checked options survive
  // both the filter and clearing it.
  const [search, setSearch] = createSignal("")
  createEffect(() => {
    if (!open()) setSearch("")
  })
  // Search matches both the raw value and the display text, so a translated
  // label ("Problema") and its stored value ("problem") are both findable.
  const visibleOptions = createMemo(() => {
    const q = search().trim()
    if (!q) return options
    return options.filter(
      (opt) =>
        filterByQuery([opt], q).length > 0 ||
        filterByQuery([show(opt)], q).length > 0,
    )
  })

  return (
    <div class="notes-filter-cell">
      <div class="notes-filter-btn-row">
        <button
          class="notes-filter-btn"
          type="button"
          aria-expanded={open()}
          aria-label={label}
          onClick={onOpenChange}
        >
          <div class="notes-filter-btn-content">
            <Show when={value().length === 0}>
              <span class="notes-filter-btn-label is-placeholder">{placeholder}</span>
            </Show>
            <Show when={value().length > 0}>
              <span class="notes-tags">
                {value().slice(0, 2).map((opt) => (
                  <span class="notes-tag">{show(opt)}</span>
                ))}
                {value().length > 2 && (
                  <span class="notes-tag notes-tag-more">+{value().length - 2}</span>
                )}
              </span>
            </Show>
          </div>
          <Show when={value().length === 0}>
            <span class="notes-filter-btn-caret" aria-hidden="true" />
          </Show>
          <Show when={value().length > 0}>
            <span
              class="notes-filter-btn-x"
              role="button"
              aria-label={t("filter.clearLabel", label)}
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); clear(); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  clear();
                }
              }}
            >
              <span class="notes-filter-clear-x" aria-hidden="true">×</span>
            </span>
          </Show>
        </button>
      </div>

      <div
        class={open() ? "notes-filter-panel" : "notes-filter-panel is-hidden"}
        aria-hidden={!open()}
      >
        <div class="notes-filter-panel-head">
          <span class="notes-filter-panel-title">{label}</span>
          <Show when={value().length > 0}>
            <ctx.ui.Button size="small" variant="ghost" onClick={clear}>
              {t("filter.clear")}
            </ctx.ui.Button>
          </Show>
        </div>
        <div class="notes-filter-panel-search">
          <input
            type="text"
            class="notes-filter-panel-search-input"
            placeholder="Filtrar…"
            aria-label={`Filtrar ${label.toLowerCase()}`}
            value={search()}
            onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="notes-filter-panel-list">
          <Show when={search().trim() !== "" && visibleOptions().length === 0}>
            <div class="notes-filter-empty">{t("filter.none")}</div>
          </Show>
          {visibleOptions().map((opt) => (
            <label class="notes-filter-option" title={props.optionTitle?.(opt)}>
              <input
                type="checkbox"
                checked={value().includes(opt)}
                onChange={(e) => toggle(opt, e.target.checked)}
              />
              <span>{show(opt)}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}

const CHUNK_SIZE = 20

// Keeps each attached note's composer id unique, so attaching the same note
// twice adds two independent chips instead of colliding on the same id.
let attachSeq = 0

export function NotesView() {
  const ctx = usePlugin()
  const panel = usePanel()
  const api = ctx.main(NotesApi)
  // Localized strings for the active Opencode locale (pt-br or en-us,
  // everything else falls back to en-us).
  const t = useT()

  // Display label for a stored category value (data stays in English;
  // falls back to the raw value for categories outside the known list).
  const categoryLabel = (v: string): string => t(`category.${v}`, v)

  // Short scope chip: localized type names; the project data is never
  // translated.
  const noteScopeLabel = (n: Note): string => scopeChipLabel(t, n.scope, n.projects)

  // Scope filter option label: same idea as the chip, driven by the raw
  // option value ("all" / "machine" / "project" / a project path). Type
  // names are localized; project paths are data and shown by their basename.
  const scopeOptionLabel = (opt: string): string => {
    if (opt === "all") return t("scopeAll")
    if (opt === "machine") return t("scopeMachine")
    if (opt === "project") return t("scopeProject")
    return opt.split("/").pop() ?? opt
  }

  /* ---------- state ---------- */
  const [query, setQuery] = createSignal("")
  const [showRetracted, setShowRetracted] = createSignal(false)
  const [projectOnly, setProjectOnly] = createSignal(false)
  const [scopeFilter, setScopeFilter] = createSignal<string[]>([])
  const [tagFilter, setTagFilter] = createSignal<string[]>([])
  const [categoryFilter, setCategoryFilter] = createSignal<string[]>([])
  // Only one combo can be open at a time; the single signal drives the
  // "Escopo", "Tag" and "Categoria" buttons (each combo's `open` is derived
  // from here).
  const [openFilter, setOpenFilter] = createSignal<string | null>(null)
  const [selectedId, setSelectedId] = createSignal<number | null>(null)
  const [detail, setDetail] = createSignal<NoteDetail | null>(null)
  const [revisionsOpen, setRevisionsOpen] = createSignal(false)
  // Independent open-state for the form's project combo (the main filter
  // combos share `openFilter`, but the floating form shouldn't fight them).
  const [formProjectOpen, setFormProjectOpen] = createSignal<string | null>(null)
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [formOpen, setFormOpen] = createSignal(false)
  const [form, setForm] = createSignal(defaultForm)
  // Escape closes the floating create/edit dialog (backdrop click also works).
  createEffect(() => {
    if (!formOpen()) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFormOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })
  // Unfiltered snapshot behind the scope/tag dropdowns: the options must not
  // shrink to whatever the active filter currently matches.
  const [allNotes, setAllNotes] = createSignal<Note[]>([])
  // Fetched, unfiltered results for the list view (all when there is no query,
  // the search result when there is). Filters (retracted/pinned/scope/tag/
  // category) are applied reactively below, so deselecting an option re-filters
  // instantly.
  const [resNotes, setResNotes] = createSignal<Note[]>([])
  const [visible, setVisible] = createSignal(CHUNK_SIZE)

  // OS user for the read-only "Autor" field: resolved once via IPC and
  // pre-filled when a new note is created.
  const [whoami, setWhoami] = createSignal("")
  createEffect(() => {
    if (whoami()) return
    void api
      .whoami()
      .then((u) => {
        if (!whoami()) setWhoami(u)
      })
      .catch(() => {
        /* leave empty; the form still works with a blank author */
      })
  })

  // The current session's project path, used to auto-fill the form's
  // "Projeto" field when the scope is `project`.
  const currentProjectPath = (): string => {
    const session = ctx.sessions.current()
    return session?.project?.worktree ?? session?.directory ?? ""
  }

  const locale = () => ctx.locale.locale()

  // Toggle a combo open/closed (switching to another simply re-targets the
  // single `openFilter`, so only one panel is ever visible).
  const toggleFilter = (which: "scope" | "tag" | "category") =>
    setOpenFilter((v) => (v === which ? null : which))

  // Close any open combo when the pointer lands outside a `.filter-cell`, or on
  // Escape. `closest` needs no refs: every combo's button + panel live inside its
  // own `.filter-cell`, so a click inside one never closes it, and a click
  // anywhere else closes whatever is open.
  createEffect(() => {
    if (!openFilter()) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element
      if (t.closest(".filter-cell")) return
      setOpenFilter(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenFilter(null)
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  })

  /* ---------- loading ---------- */
  const loadNotes = async () => {
    const q = query().trim()
    const scope = scopeFilter()
    const tag = tagFilter()
    setLoading(true)
    setError("")
    try {
      const all = (await api.list({ all: true, limit: 5000 })) as unknown as Note[]
      setAllNotes(all)
      // Filters are multi-selects: drop only the values that no longer exist,
      // keep the rest, so picking several never collapses the whole selection.
      // Only write when the selection actually changes — otherwise the effect
      // reading these signals would re-run `loadNotes` and loop forever.
      const arraysSame = (a: readonly string[], b: readonly string[]): boolean =>
        a.length === b.length && a.every((v, i) => v === b[i])
      const nextScope = scope.filter((s) => all.some((n) => noteMatchesScope(n, s)))
      const nextTag = tag.filter((t) => all.some((n) => tagsOf(n).includes(t)))
      if (!arraysSame(scope, nextScope)) setScopeFilter(nextScope)
      if (!arraysSame(tag, nextTag)) setTagFilter(nextTag)
      // Store the unfiltered result; scope/tag/retracted/pinned are applied
      // reactively in `filteredNotes`, so changing a filter never needs a
      // re-fetch.
      const res = q
        ? ((await api.search({ query: q, all: true })) as unknown as Note[])
        : all
      setResNotes(res)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  // Re-runs only when the query changes (and on mount), because the fetch is
  // the only thing the filters no longer drive — they re-filter in
  // `filteredNotes` above. Read `query()` explicitly so the fetch does not
  // also re-run on filter changes.
  createEffect(() => {
    const _q = query()
    setVisible(CHUNK_SIZE)
    void loadNotes()
  })

  // Keep the multi-select filters pointing only at values that still exist,
  // so deleting a note can't leave a phantom selection. Cheap: no fetch.
  createEffect(() => {
    const existsScope = (s: string) => allNotes().some((n) => noteMatchesScope(n, s))
    const existsTag = (t: string) => allNotes().some((n) => tagsOf(n).includes(t))
    const nextScope = pruneSelection(scopeFilter(), existsScope)
    const nextTag = pruneSelection(tagFilter(), existsTag)
    if (nextScope !== scopeFilter()) setScopeFilter(nextScope)
    if (nextTag !== tagFilter()) setTagFilter(nextTag)
  })

  // Projects come from opencode itself: the server's project list (every
  // project we've ever worked on, fetched over the official `client.project.list()`
  // API). Re-runs when the open-tab set changes — a project row is created the
  // first time a session opens there. Falls back to [] when the API is
  // unavailable, so the dropdown still shows the note/current projects below.
  const [opencodeProjects, setOpencodeProjects] = createSignal<string[]>([])
  let opencodeProjectsGen = 0
  createEffect(() => {
    ctx.sessions.list() // reactive source: re-fetch when the tab set changes
    const gen = ++opencodeProjectsGen
    ctx.client.project.list().then(
      (projects) => {
        if (gen !== opencodeProjectsGen) return
        setOpencodeProjects(
          projects
            .map((p) => p.canonical)
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b)),
        )
      },
      (e) => {
        if (gen !== opencodeProjectsGen) return
        console.error("[notes] client.project.list() failed:", e)
        setOpencodeProjects([])
      },
    )
  })

  // Filter choices come from the unfiltered snapshot, so picking one scope or
  // tag never removes the others from the dropdown. A project-scoped note
  // contributes one key per project path, so all its projects appear as
  // distinct options.
  const scopeOptions = createMemo(() =>
    [...new Set(allNotes().flatMap((n) => scopeKeysOf(n)))].sort((a, b) => a.localeCompare(b))
  )
  const tagOptions = createMemo(() =>
    [...new Set(allNotes().flatMap(tagsOf))].sort((a, b) => a.localeCompare(b))
  )
  // Options for the form's project multi-select: the union of opencode's
  // projects (every project we work on), the projects the notes reference
  // (so a project whose notes outlive it stays selectable), and the current
  // session's project — so the auto-filled value is always selectable.
  const projectOptions = createMemo(() => {
    const paths = new Set<string>([
      ...opencodeProjects(),
      ...allNotes().filter((n) => n.scope === "project").flatMap((n) => n.projects),
    ])
    const current = currentProjectPath()
    if (current.trim()) paths.add(current.trim())
    return [...paths].sort((a, b) => a.localeCompare(b))
  })

  const reloadSelected = async (id: number | null) => {
    if (id === null) {
      setDetail(null)
      return
    }
    const res = await api.detail(id)
    setDetail(res as unknown as NoteDetail | null)
  }

  const toggleNote = (id: number) => {
    const current = selectedId()
    if (current === id) {
      setSelectedId(null)
      return
    }
    setSelectedId(id)
    setRevisionsOpen(false)
    void reloadSelected(id)
  }

  /* ---------- actions ---------- */
  // Runs a write, refreshes the list and the open note, then reports the
  // outcome. The refresh clears `error` on purpose, so the message is set
  // after it — otherwise a failure would be erased before it renders.
  const doAction = async (
    fn: (a: any) => Promise<NoteResult>,
    arg: any,
    done: string
  ): Promise<void> => {
    try {
      const res = await fn(arg)
      await loadNotes()
      if (!res.ok) {
        const message = res.error ?? t("toast.actionError")
        setError(message)
        ctx.toast.show({ title: done, description: message, variant: "error" })
        return
      }
      await reloadSelected(selectedId())
      ctx.toast.show({ title: done, variant: "success" })
    } catch (e) {
      const message = String(e)
      await loadNotes()
      setError(message)
      ctx.toast.show({ title: done, description: message, variant: "error" })
    }
  }

  const handleAddOrEdit = async () => {
    const f = form()
    if (f.title.trim().length === 0 || f.content.trim().length === 0) {
      setError(t("form.required"))
      return
    }
    const content = f.content.trim()
    // (scope, projects) are a pair: the project set only travels with project
    // scope; for other scopes it is omitted so the store clears it.
    const projects = f.scope === "project" ? f.projects : undefined
    setSaving(true)
    try {
      const res =
        f.mode === "add"
          ? await api.add({
              category: f.category,
              title: f.title.trim(),
              content,
              tags: f.tags.trim() || undefined,
              author: f.author.trim() || undefined,
              scope: f.scope,
              projects,
            })
          : await api.update({
              id: f.id as number,
              title: f.title.trim(),
              content,
              tags: f.tags.trim() || undefined,
              category: f.category,
              scope: f.scope,
              projects,
            })
      if (res.ok) {
        setFormOpen(false)
        setForm(defaultForm)
        void reloadSelected(res.note?.id ?? null)
      } else {
        setError(res.error ?? t("form.saveError"))
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
      void loadNotes()
    }
  }

  // Resolves the OS user (cached from the signal above, fetched if still
  // pending) and opens the form with it as the read-only author.
  const openAdd = async () => {
    let author = whoami()
    if (!author) {
      try {
        author = await api.whoami()
      } catch {
        author = ""
      }
      setWhoami(author)
    }
    setForm({
      ...defaultForm,
      author,
      projects: currentProjectPath().trim() ? [currentProjectPath().trim()] : [],
    })
    setFormOpen(true)
  }

  const openEdit = (n: Note) => {
    setForm({
      mode: "edit",
      id: n.id,
      category: n.category ?? "problem",
      title: n.title,
      content: n.content,
      tags: n.tags || "",
      author: n.author || "",
      scope: n.scope ? (n.scope as FormState["scope"]) : "all",
      projects: n.projects ? [...n.projects] : [],
    })
    setFormOpen(true)
  }

  // A getter, not `selectedId()`: the actions are built once, when the view
  // mounts, so a plain read would freeze the selection at `null` and every
  // button would return early.
  const id = () => selectedId()
  const confirm = () => {
    const current = id()
    if (current !== null) void doAction(api.confirm, current, t("toast.confirm"))
  }
  const dispute = async () => {
    const current = id()
    if (current === null) return
    const why = await ctx.dialogs.prompt({
      title: t("prompt.dispute.title"),
      description: t("prompt.dispute.desc"),
      placeholder: t("prompt.dispute.placeholder"),
      submit: t("prompt.dispute.submit"),
    })
    if (why && why.trim()) {
      void doAction(api.dispute, { id: current, reason: why.trim() }, t("toast.dispute"))
    }
  }
  const retract = async () => {
    const current = id()
    if (current === null) return
    const why = await ctx.dialogs.prompt({
      title: t("prompt.retract.title"),
      description: t("prompt.retract.desc"),
      placeholder: t("prompt.retract.placeholder"),
      submit: t("prompt.retract.submit"),
    })
    if (why === undefined) return
    void doAction(
      api.retract,
      { id: current, reason: why.trim() || undefined },
      t("toast.retract")
    )
  }
  const pin = () => {
    const current = id()
    if (current !== null) void doAction(api.pin, current, t("toast.pin"))
  }
  const unpin = () => {
    const current = id()
    if (current !== null) void doAction(api.unpin, current, t("toast.unpin"))
  }
  const remove = async () => {
    const current = id()
    if (current === null) return
    const ok = await ctx.dialogs.confirm({
      title: t("prompt.delete.title"),
      description: t("prompt.delete.desc", current),
      confirm: t("prompt.delete.confirm"),
      danger: true,
    })
    if (ok) {
      void doAction(api.delete, { id: current }, t("toast.remove"))
    }
  }
  const restore = async (rev: Revision) => {
    const current = id()
    if (current === null) return
    const ok = await ctx.dialogs.confirm({
      title: t("prompt.restore.title"),
      description: t("prompt.restore.desc", rev.id),
      confirm: t("prompt.restore.confirm"),
      danger: true,
    })
    if (ok) {
      void doAction(api.restore, { id: current, revisionId: rev.id }, t("toast.restore"))
    }
  }

  /* ---------- derived ---------- */
  // Reactive filter application: retracted/scope/tag/category/project are
  // applied here, so deselecting an option re-filters instantly with no
  // re-fetch (and no stale read from an async load). All the predicate logic
  // lives in `applyFilters` (src/gui/filters.ts) and is unit-tested.
  const filteredNotes = createMemo(() =>
    applyFilters(resNotes(), {
      scope: scopeFilter(),
      tag: tagFilter(),
      category: categoryFilter(),
      showRetracted: showRetracted(),
      projectOnly: projectOnly(),
      projectPath: currentProjectPath(),
    })
  )
  // Pinned notes are lifted to the top as a stable partition, after filtering
  // and before pagination — so they always occupy the first pages even while a
  // search/filter narrows the list.
  const sortedNotes = createMemo(() => sortPinnedFirst(filteredNotes()))
  // Only label an "others" section when there actually is a pinned section to
  // contrast with; a list of purely unpinned notes needs no second header.
  const hasPinned = createMemo(() => sortedNotes().some((n) => n.pinned))
  const count = createMemo(() => filteredNotes().length)
  const emptyTitle = () =>
    query().trim()
      ? t("empty.search", query().trim())
      : showRetracted()
        ? t("empty.retracted")
        : projectOnly()
          ? t("empty.project")
          : t("empty.none")
  const emptyHint = () =>
    query().trim()
      ? t("empty.hint.search")
      : showRetracted()
        ? t("empty.hint.retracted")
        : projectOnly()
          ? t("empty.hint.project")
          : t("empty.hint.none")
  const visibleNotes = createMemo(() => sortedNotes().slice(0, visible()))
  const nav = createScrollNav({
    hasMore: () => visible() < sortedNotes().length,
    loadingMore: () => false,
    loadMore: () => setVisible((value) => value + CHUNK_SIZE),
    visible: () => panel.visible(),
    items: () => sortedNotes().length,
  })
  // A new query or filter starts from the top of the list.
  createEffect(() => {
    query()
    showRetracted()
    projectOnly()
    scopeFilter()
    categoryFilter()
    tagFilter()
    setVisible(CHUNK_SIZE)
    nav.reset()
  })
  const revs = createMemo(() => detail()?.revisions ?? [])

  const formatTime = (s: string) => {
    const d = new Date(s)
    if (Number.isNaN(d.getTime())) return s
    return new Intl.DateTimeFormat(locale(), { dateStyle: "short", timeStyle: "short" }).format(d)
  }

  /* ---------- composer context ---------- */
  // Quotes the note into the routed session's next prompt, so the agent reads
  // the stored memory as part of the user's context.
  const noteAsQuote = (n: Note): string => {
    const state = n.retractedAt
      ? "retracted"
      : n.disputedAt
        ? "disputed"
        : n.verifiedAt
          ? "verified"
          : ""
    const meta = [
      String(n.category),
      n.scope && n.scope !== "all"
        ? `scope: ${n.scope}${n.projects.length ? ` (${n.projects.join(", ")})` : ""}`
        : "",
      n.tags ? `tags: ${n.tags}` : "",
      n.author ? `author: ${n.author}` : "",
      formatTime(n.timestamp),
      state,
    ]
      .filter(Boolean)
      .join(" · ")
    return `#${n.id} — ${n.title}\n${meta}\n\n${n.content}`
  }

  const addToContext = (n: Note) => {
    const screen = ctx.screen.current()
    if (!screen) {
      ctx.toast.show({
        title: t("toast.noSession"),
        description: t("toast.noSessionHint"),
        variant: "error",
      })
      return
    }
    if (!screen.composer.quotable()) {
      ctx.toast.show({
        title: t("toast.contextUnavailable"),
        description: t("toast.contextUnavailableHint"),
        variant: "error",
      })
      return
    }
    screen.composer.attach({
      type: "quote",
      commentID: `note-${n.id}-${++attachSeq}`,
      text: noteAsQuote(n),
      source: {
        label: `#${n.id} ${n.title}`,
        icon: "file-document",
        subject: `the note #${n.id} from the notes panel`,
      },
    })
    ctx.toast.show({
      title: t("toast.attach", n.id),
      variant: "success",
    })
  }

  /* ---------- render helpers ---------- */
  // Tags are stored as a single space-separated string; render them as chips
  // so they read as metadata instead of blending into the title.
  const tagChips = (n: Note, max?: number) => {
    const tags = tagsOf(n)
    const shown = max === undefined ? tags : tags.slice(0, max)
    return (
      <Show when={tags.length > 0}>
        <span class="notes-tags">
          {shown.map((t) => (
            <span class="notes-tag">{t}</span>
          ))}
          <Show when={max !== undefined && tags.length > shown.length}>
            <span class="notes-tag notes-tag-more">+{tags.length - shown.length}</span>
          </Show>
        </span>
      </Show>
    )
  }

  // A note counts as confirmed only while it is not disputed or retracted:
  // both states can be resolved by confirming it again.
  const isConfirmed = (n: Note): boolean =>
    n.verifiedAt !== undefined && n.disputedAt === undefined && n.retractedAt === undefined

  // Alert states (retracted / disputed) stay in the title row, where they read
  // as the note's current status; verified moves to the pills row.
  const alertBadges = (n: Note) => (
    <span class="notes-badges">
      <Show when={n.retractedAt !== undefined}>
        <span class="notes-badge notes-badge-retracted">{t("badge.retracted")}</span>
      </Show>
      <Show when={n.disputedAt !== undefined}>
        <span class="notes-badge notes-badge-disputed">{t("badge.disputed")}</span>
      </Show>
    </span>
  )

  // Order in the pills row: verified, then scope, then tags. Pinned notes are
  // signalled by their position (top section) instead of a pill.
  const pillBadges = (n: Note) => (
    <>
      <Show when={n.verifiedAt !== undefined && !n.disputedAt && !n.retractedAt}>
        <span class="notes-badge notes-badge-verified">{t("badge.verified")}</span>
      </Show>
    </>
  )

  const card = (n: Note) => (
    <section
      class={`note ${n.pinned ? "pinned" : ""} ${
        n.retractedAt !== undefined ? "retracted" : ""
      } ${selectedId() === n.id ? "selected" : ""}`}
    >
      <div
        class="note-header"
        role="button"
        tabIndex={0}
        aria-expanded={selectedId() === n.id}
        onClick={() => toggleNote(n.id)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          toggleNote(n.id)
        }}
      >
        <div class="note-row">
          <div class="note-head">
            <span class="note-id">#{n.id}</span>
            <span class="note-cat" title={n.category}>{categoryLabel(n.category)}</span>
            <span class="note-title">{n.title}</span>
            {alertBadges(n)}
          </div>
          <ctx.ui.Button
            class="note-attach"
            size="small"
            variant="ghost-muted"
            icon="plus"
            onClick={(event) => {
              event.stopPropagation()
              void addToContext(n)
            }}
          >
            {t("actions.attachTooltip")}
          </ctx.ui.Button>
        </div>
        <Show when={tagsOf(n).length > 0 || noteScopeLabel(n)}>
          <div class="note-pills">
            {pillBadges(n)}
            <Show when={noteScopeLabel(n)}>
              <span
                class="notes-tag notes-tag-scope"
                title={
                  n.scope === "project"
                    ? n.projects.length
                      ? n.projects.join(", ")
                      : t("scopeProject")
                    : noteScopeLabel(n)
                }
              >
                {noteScopeLabel(n)}
              </span>
            </Show>
            {tagChips(n, 2)}
          </div>
        </Show>
      </div>
      <Show when={selectedId() === n.id}>
        <div class="note-body">
          <div class="notes-meta">
            <span>{formatTime(n.timestamp)}</span>
            <Show when={n.author}>
              <span>{t("meta.author", n.author)}</span>
            </Show>
          </div>
          <pre class="note-content">{n.content}</pre>
          <div class="notes-actions">
            <ctx.ui.Tooltip value={n.pinned ? t("actions.unpin") : t("actions.pin")}>
              <ctx.ui.IconButton
                icon={n.pinned ? "close-small" : "lock"}
                label={n.pinned ? t("actions.unpin") : t("actions.pin")}
                variant="ghost-muted"
                size="small"
                pressed={n.pinned}
                onClick={n.pinned ? unpin : pin}
              />
            </ctx.ui.Tooltip>
            <Show when={!isConfirmed(n)}>
              <ctx.ui.Tooltip value={t("actions.confirm")}>
                <ctx.ui.IconButton
                  icon="circle-check"
                  label={t("actions.confirm")}
                  variant="ghost-muted"
                  size="small"
                  onClick={confirm}
                />
              </ctx.ui.Tooltip>
            </Show>
            <ctx.ui.Tooltip value={t("actions.dispute")}>
              <ctx.ui.IconButton
                icon="outline-hexagonal-warning"
                label={t("actions.dispute")}
                variant="ghost-muted"
                size="small"
                onClick={dispute}
              />
            </ctx.ui.Tooltip>
            <ctx.ui.Tooltip value={t("actions.retract")}>
              <ctx.ui.IconButton
                icon="archive"
                label={t("actions.retract")}
                variant="ghost-muted"
                size="small"
                class="is-danger"
                onClick={retract}
              />
            </ctx.ui.Tooltip>
            <span class="notes-actions-spacer" />
            <ctx.ui.Tooltip value={t("actions.edit")}>
              <ctx.ui.IconButton
                icon="edit"
                label={t("actions.edit")}
                variant="ghost-muted"
                size="small"
                onClick={() => openEdit(n)}
              />
            </ctx.ui.Tooltip>
            <ctx.ui.Tooltip value={t("actions.remove")}>
              <ctx.ui.IconButton
                icon="trash"
                label={t("actions.remove")}
                variant="ghost-muted"
                size="small"
                class="is-danger"
                onClick={remove}
              />
            </ctx.ui.Tooltip>
          </div>
          <div class="notes-revisions">
            <ctx.ui.Button
              size="small"
              variant="ghost"
              icon="outline-rotate-clockwise"
              onClick={() => setRevisionsOpen(!revisionsOpen())}
            >
              {t("revisions.label")}
              {revs().length > 0 ? ` · ${revs().length}` : ""}
            </ctx.ui.Button>
            <Show when={revisionsOpen()}>
              <div class="notes-rev-list">
                <Show when={revs().length === 0}>
                  <div class="notes-muted">{t("revisions.empty")}</div>
                </Show>
                {revs().map((r) => (
                  <div class="notes-rev">
                    <div class="notes-rev-head">
                      {t("revisions.head", r.id, formatTime(r.revisedAt), formatTime(r.timestamp))}
                    </div>
                    <pre class="note-content small">{r.content}</pre>
                    <ctx.ui.Tooltip value={t("prompt.restore.confirm")}>
                      <ctx.ui.IconButton
                        icon="arrow-undo-down"
                        label={t("prompt.restore.confirm")}
                        variant="ghost-muted"
                        size="small"
                        onClick={() => restore(r)}
                      />
                    </ctx.ui.Tooltip>
                  </div>
                ))}
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </section>
  )

  /* ---------- main render ---------- */
  return (
    <div class="notes-root">
      <style>{`
        .notes-root {
          font-family: var(--font-family-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
          font-size: 13px;
          line-height: 1.5;
          color: var(--v2-text-text-base);
          display: flex;
          flex-direction: column;
          height: 100%;
          box-sizing: border-box;
          padding: 12px;
          /* Anchor for the create/edit form overlay. */
          position: relative;
        }
        .notes-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
        .notes-title { display: flex; align-items: center; gap: 6px; margin: 0; font-weight: 600; font-size: 13px; }
        .notes-count { font-size: 12px; color: var(--v2-text-text-muted); }
        .notes-spacer { flex: 1; }
        .notes-search-row { margin-bottom: 6px; }
        .notes-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
        .notes-filter-row {
          display: flex;
          flex-wrap: wrap;
          gap: 6px 12px;
          margin-bottom: 10px;
          align-items: flex-start;
        }
        /* Each combo is its own column; the dropdown hangs from the button.
           Cells have a minimum width so the third control (Categoria) wraps
           to its own line instead of being crushed on narrow panels. */
        .notes-filter-cell { position: relative; flex: 1; min-width: 118px; }
        .notes-filter-btn-row { display: flex; gap: 4px; align-items: stretch; }
        .notes-filter-btn {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          flex: 1;
          width: auto;
          min-width: 0;
          min-height: 34px;
          padding: 5px 10px;
          border: 1px solid var(--v2-border-border-muted);
          border-radius: 4px;
          background: var(--v2-background-bg-layer-02);
          color: var(--v2-text-text-base);
          font: inherit;
          cursor: pointer;
          user-select: none;
          text-align: left;
        }
        .notes-filter-btn:hover { border-color: var(--v2-border-border-strong); }
        .notes-filter-btn:focus-visible { outline: 2px solid var(--v2-border-border-focus); outline-offset: 0; }
        .notes-filter-btn-label {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .notes-filter-btn-label.is-placeholder { color: var(--v2-text-text-faint); font-style: italic; }
        /* Groups the placeholder/chips on the left; the caret sits at the end. */
        .notes-filter-btn-content { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: flex-start; gap: 6px; }
        /* Combo button: the note-row .notes-tag/.notes-tags pill uses bg-layer-02 — the
           SAME token as this button's background — so it reads as invisible.
           Re-skin it here as a higher-contrast filled pill that works in
           light + dark, and never truncate the text (the button has room). */
        .notes-filter-btn-content .notes-tags { max-width: none; overflow: visible; gap: 6px; }
        .notes-filter-btn-content .notes-tag {
          background: var(--v2-overlay-simple-overlay-pressed);
          border: 1px solid var(--v2-border-border-muted);
          color: var(--v2-text-text-base);
          font-weight: 500;
          max-width: none;
          overflow: visible;
          text-overflow: clip;
        }
        .notes-filter-btn-content .notes-tag-more {
          background: transparent;
          border: 0;
          color: var(--v2-text-text-muted);
        }
        .notes-filter-btn-caret {
          flex: 0 0 auto;
          width: 8px;
          height: 8px;
          border-left: 1.5px solid currentColor;
          border-bottom: 1.5px solid currentColor;
          transform: rotate(45deg);
          transition: transform 0.12s ease;
        }
        /* "Clear" control sits inside the combo, exactly where the chevron
        .notes-filter-btn-x:hover {
          background: var(--v2-overlay-simple-overlay-hover);
          color: var(--v2-text-text-base);
        }
        .notes-filter-btn-x:focus-visible {
          outline: 2px solid var(--v2-border-border-focus);
          outline-offset: 0;
        }
        .notes-filter-clear-x { font-size: 15px; line-height: 1; }
        .notes-filter-panel {
          position: absolute;
          top: calc(100% + 4px);
          left: 0;
          right: 0;
          z-index: 1000;
          max-height: 280px;
          overflow-y: auto;
          background: var(--v2-background-bg-base);
          border: 1px solid var(--v2-border-border-muted);
          border-radius: 6px;
          box-shadow: 0 12px 28px rgb(0 0 0 / 0.35);
        }
        /* Always mounted (checkboxes keep state); closed = hidden, not unmounted,
           so selected options never disappear on close/reopen. */
        .notes-filter-panel.is-hidden { display: none; }
        .notes-filter-panel-head {
          position: sticky;
          top: 0;
          z-index: 1;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 6px 8px;
          font-size: 11px;
          font-weight: 550;
          color: var(--v2-text-text-muted);
          border-bottom: 1px solid var(--v2-border-border-muted);
          background: var(--v2-background-bg-base);
        }
        .notes-filter-panel-list { display: flex; flex-direction: column; gap: 2px; padding: 4px; }
        /* Free-text option filter, shown between the head and the list. */
        .notes-filter-panel-search { padding: 4px 8px; }
        .notes-filter-panel-search-input {
          width: 100%;
          box-sizing: border-box;
          padding: 3px 6px;
          border: 1px solid var(--v2-border-border-muted);
          border-radius: 4px;
          background: var(--v2-background-bg-layer-02);
          color: var(--v2-text-text-base);
          font: inherit;
          font-size: 12.5px;
        }
        .notes-filter-panel-search-input:focus {
          outline: 2px solid var(--v2-border-border-focus);
          outline-offset: 0;
        }
        .notes-filter-empty { padding: 12px 8px; font-size: 12.5px; color: var(--v2-text-text-faint); }
        .notes-filter-option {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 4px 4px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12.5px;
          color: var(--v2-text-text-base);
        }
        .notes-filter-option:hover { background: var(--v2-overlay-simple-overlay-pressed); }
        .notes-filter-option input[type="checkbox"] {
          margin: 0;
          flex: 0 0 auto;
          accent-color: var(--v2-state-fg-success);
        }
        .notes-filter-option span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .notes-body { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
        .notes { overflow-y: auto; flex: 1; min-height: 0; }
        /* Notes open in labelled sections (pinned first, then the rest); the
           group headers replace the old "pinned" pill and divider. */
        .note-group-head {
          font-size: 10.5px;
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--v2-text-text-muted);
          padding: 2px 2px 0;
        }
        .note-group-head:not(:first-child) { margin-top: 4px; }
        /* Filled surface: the list reads as stacked cards on the panel background,
           with a slight border lift on hover (same treatment as the memory list). */
        .note {
          border: 1px solid var(--v2-border-border-muted);
          border-radius: 8px;
          background: var(--v2-background-bg-layer-02);
          overflow: hidden;
          flex: 0 0 auto;
        }
        .note:hover { border-color: var(--v2-border-border-strong); }
        .note.pinned { border-color: var(--v2-border-border-strong); }
        .note.retracted { opacity: 0.55; }
        .note.selected { border-color: var(--v2-border-border-focus); }
        /* Tags use the same bg-layer-02 token as the card, which would make them
           invisible; re-skin them slightly brighter inside the card. */
        .note .notes-tag { background: var(--v2-overlay-simple-overlay-pressed); }
        .note-row { display: flex; align-items: center; min-width: 0; }
        .note-attach { flex: 0 0 auto; margin-right: 6px; }
        .note-header { cursor: pointer; }
        /* The header is the click target: only it gets the hover surface. */
        .note-header:hover {
          background-image: linear-gradient(var(--v2-overlay-simple-overlay-hover), var(--v2-overlay-simple-overlay-hover));
        }
        .note-header:focus-visible { outline: 2px solid var(--v2-border-border-focus); outline-offset: -2px; }
        .note-head {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 1;
          min-width: 0;
          box-sizing: border-box;
          min-height: 34px;
          padding: 6px 10px 6px 12px;
        }
        .note-id { font-weight: 550; color: var(--v2-text-text-muted); }
        .note-cat { font-size: 11px; color: var(--v2-text-text-faint); }
        .note-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .notes-tags {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          flex: 0 1 auto;
          min-width: 0;
          max-width: 45%;
          overflow: hidden;
        }
        .notes-tag {
          font-size: 10.5px;
          line-height: 1.6;
          border-radius: 999px;
          padding: 0 6px;
          background: var(--v2-background-bg-layer-02);
          color: var(--v2-text-text-muted);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 110px;
        }
        .notes-tag-more { color: var(--v2-text-text-faint); }
        /* Scope reads as hierarchy, not as a free-form tag. */
        .notes-tag-scope { color: var(--v2-text-text-base); border: 1px solid var(--v2-border-border-muted); }
        /* Pills (tags + scope) live on their own line directly under the title. */
        .note-pills {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 6px;
          min-width: 0;
          padding: 4px 12px 6px;
        }
        .note-pills .notes-tags { max-width: none; flex-wrap: wrap; }
        .notes-badges { display: flex; gap: 4px; flex: 0 0 auto; }        .notes-badge { font-size: 11px; line-height: 1.4; border-radius: 999px; padding: 0 7px; }
        .notes-badge-verified { border: 1px solid var(--v2-state-border-success); color: var(--v2-state-fg-success); }
        .notes-badge-retracted { border: 1px solid var(--v2-state-border-danger); color: var(--v2-state-fg-danger); }
        .notes-badge-disputed { border: 1px solid var(--v2-state-border-warning); color: var(--v2-state-fg-warning); }
        .note-body {
          background: var(--v2-background-bg-layer-01);
          padding: 8px 12px 12px;
          border-top: 1px solid var(--v2-border-border-muted);
        }
        .notes-meta {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          font-size: 11.5px;
          color: var(--v2-text-text-faint);
          margin-bottom: 6px;
        }
        .notes-meta .notes-tags { max-width: none; flex-wrap: wrap; }
        .note-content {
          margin: 0;
          white-space: pre-wrap;
          font-family: var(--font-family-code);
          font-size: 12.5px;
          line-height: 1.5;
          color: var(--v2-text-text-muted);
          max-height: 280px;
          overflow-y: auto;
        }
        .note-content.small { max-height: 120px; font-size: 11.5px; }
        .notes-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 8px; }
        .notes-actions-spacer { flex: 1 1 0; min-width: 0; }
        .notes-revisions { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
        .notes-rev { border: 1px solid var(--v2-border-border-muted); border-radius: 4px; padding: 8px; }
        .notes-rev-head { font-size: 11.5px; font-weight: 550; color: var(--v2-text-text-faint); margin-bottom: 4px; }
        .notes-rev-list { display: flex; flex-direction: column; gap: 8px; }
        .notes-muted { font-size: 11.5px; color: var(--v2-text-text-faint); text-align: center; }
        .notes-form {
          display: flex;
          flex-direction: column;
          gap: 10px;
          background: var(--v2-background-bg-base);
          border: 1px solid var(--v2-border-border-muted);
          border-radius: 4px;
          padding: 12px;
          width: 100%;
          max-width: 620px;
          max-height: calc(100% - 28px);
          overflow-y: auto;
        }
        /* Floating dialog: the create/edit form no longer pushes the list
           down — it overlays it (dimmed backdrop) while the list keeps its
           scroll and position behind. */
        .notes-form-overlay {
          position: absolute;
          inset: 0;
          z-index: 5;
          display: flex;
          align-items: flex-start;
          justify-content: center;
          padding: 14px;
          overflow-y: auto;
          background: color-mix(in srgb, rgb(0 0 0) 40%, transparent);
          backdrop-filter: blur(2px);
        }
        .notes-form-overlay .notes-form {
          box-shadow: 0 12px 44px rgb(0 0 0 / 0.5);
        }
        .notes-form > label {
          display: flex;
          flex-direction: column;
          gap: 3px;
          font-size: 12px;
          font-weight: 550;
          color: var(--v2-text-text-muted);
        }
        .notes-form textarea {
          resize: vertical;
          min-height: 90px;
          border: 1px solid var(--v2-border-border-muted);
          border-radius: 4px;
          background: transparent;
          color: var(--v2-text-text-base);
          font-family: var(--font-family-code);
          font-size: 12.5px;
          line-height: 1.5;
          padding: 6px 8px;
          white-space: pre-wrap;
        }
        .notes-form select {
          border: 1px solid var(--v2-border-border-muted);
          border-radius: 4px;
          background: var(--v2-background-bg-layer-02);
          color: var(--v2-text-text-base);
          font: inherit;
          padding: 4px 6px;
        }
        /* The native dropdown paints its own white surface on Linux, so the
           options must carry the theme colors or their text washes out. */
        .notes-form select option {
          background: var(--v2-background-bg-layer-02);
          color: var(--v2-text-text-base);
        }
        .notes-form textarea:focus,
        .notes-form select:focus {
          outline: 2px solid var(--v2-border-border-focus);
          outline-offset: 0;
          background: var(--v2-background-bg-layer-02);
        }
        /* Side-by-side row: categoria + escopo. */
        .notes-form-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
        }
        .notes-form-grid > label {
          display: flex;
          flex-direction: column;
          gap: 3px;
          font-size: 12px;
          font-weight: 550;
          color: var(--v2-text-text-muted);
        }
        /* Read-only author field: styled like the other inputs, auto-filled
           from the OS user (whoami) and not editable. */
        .notes-form-author {
          border: 1px solid var(--v2-border-border-muted);
          border-radius: 4px;
          background: var(--v2-background-bg-layer-02);
          color: var(--v2-text-text-faint);
          font: inherit;
          padding: 4px 6px;
          cursor: default;
          user-select: all;
        }
        .notes-form-actions { display: flex; justify-content: flex-end; gap: 8px; }

        /* Filter toggle (segmented control): the host button has no pressed state. */
        .notes-toggle {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 0;
          border-radius: 6px;
          font: inherit;
          font-size: 11.5px;
          line-height: 1.4;
          padding: 3px 9px;
          cursor: pointer;
          user-select: none;
          background: transparent;
          color: var(--v2-text-text-muted);
        }
        .notes-toggle:hover {
          background: var(--v2-overlay-simple-overlay-hover);
          color: var(--v2-text-text-base);
        }
        .notes-toggle:focus-visible {
          outline: 2px solid var(--v2-border-border-focus);
          outline-offset: 0;
        }
        .notes-toggle.is-active {
          background: var(--v2-background-bg-layer-02);
          color: var(--v2-text-text-base);
          font-weight: 600;
        }
        .notes-toggle.is-active:hover { background: var(--v2-overlay-simple-overlay-pressed); }

        /* Destructive icon buttons (delete/retract) in a row of ghost buttons. */
        .notes-actions .is-danger:hover { color: var(--v2-state-fg-danger); }
      `}</style>
      <style>{SHARED_CSS}</style>

      <header class="notes-head">
        <h2 class="notes-title">
          <ctx.ui.Icon name="file-document" size="small" />
          {t("notesTitle")}
        </h2>
        <span class="notes-count">{t("notesCount", count())}</span>
        <span class="notes-spacer" />
        <ctx.ui.Button size="small" variant="ghost" icon="plus" onClick={openAdd}>
          {t("newNote")}
        </ctx.ui.Button>
      </header>

      <div class="notes-search-row">
        <ctx.ui.TextInput
          type="search"
          label={t("searchLabel")}
          placeholder={t("searchPlaceholder")}
          value={query()}
          onInput={setQuery}
        />
      </div>

      <div class="notes-chips">
        <button
          type="button"
          class={`notes-toggle ${showRetracted() ? "is-active" : ""}`}
          onClick={() => setShowRetracted(!showRetracted())}
        >
          {t("filterRetracted")}
        </button>
        <button
          type="button"
          class={`notes-toggle ${projectOnly() ? "is-active" : ""}`}
          onClick={() => setProjectOnly(!projectOnly())}
        >
          {t("filterProject")}
        </button>
      </div>

        <div class="notes-filter-row">
          <Show when={scopeOptions().length > 0}>
            <MultiSelect
              label={t("filter.scope.label")}
              placeholder={t("filter.scope.placeholder")}
              options={scopeOptions()}
              display={scopeOptionLabel}
              value={scopeFilter}
              onValueChange={setScopeFilter}
              openFilter={openFilter}
              which="scope"
              onOpenChange={() => toggleFilter("scope")}
              optionTitle={(opt) => (opt.startsWith("/") ? opt : undefined)}
            />
          </Show>
          <MultiSelect
            label={t("filter.category.label")}
            placeholder={t("filter.category.placeholder")}
            options={CATEGORIES.map((c) => c.value)}
            display={categoryLabel}
            value={categoryFilter}
            onValueChange={setCategoryFilter}
            openFilter={openFilter}
            which="category"
            onOpenChange={() => toggleFilter("category")}
          />
          <Show when={tagOptions().length > 0}>
            <MultiSelect
              label={t("filter.tag.label")}
              placeholder={t("filter.tag.placeholder")}
              options={tagOptions()}
              value={tagFilter}
              onValueChange={setTagFilter}
              openFilter={openFilter}
              which="tag"
              onOpenChange={() => toggleFilter("tag")}
            />
          </Show>
        </div>

      <Show when={loading()}>
        <LoadingRow label={t("loading")} />
      </Show>
      <Show when={error() !== ""}>
        <ErrorBanner message={error()} />
      </Show>

      <Show when={formOpen()}>
        <section
          class="notes-form-overlay"
          aria-label={form().mode === "add" ? t("form.overlay.add") : t("form.overlay.edit")}
          onClick={(e) => {
            // Click on the dimmed backdrop (not the form itself) closes it.
            if (e.target === e.currentTarget) setFormOpen(false)
          }}
        >
        <form class="notes-form" onSubmit={(e) => { e.preventDefault(); void handleAddOrEdit() }}>
          <label>
            {t("form.title.label")}
            <ctx.ui.TextInput
              label={t("form.title.label")}
              value={form().title}
              onInput={(v) => setForm((s) => ({ ...s, title: v }))}
              onSubmit={handleAddOrEdit}
            />
          </label>
          <label>
            {t("form.content.label")}
            <textarea
              value={form().content}
              onInput={(e) => setForm((s) => ({ ...s, content: e.currentTarget.value }))}
              placeholder={t("form.content.placeholder")}
            />
          </label>
          <label>
            {t("form.author.label")}
            <input
              type="text"
              class="notes-form-author"
              readOnly
              value={form().author}
              placeholder={t("form.author.placeholder")}
            />
          </label>
          <div class="notes-form-grid">
            <label>
              {t("form.category.label")}
              <select
                value={form().category}
                onChange={(e) => setForm((s) => ({ ...s, category: e.currentTarget.value }))}
              >
                {CATEGORIES.map((c) => (
                  <option value={c.value}>{categoryLabel(c.value)}</option>
                ))}
              </select>
            </label>
            <label>
              {t("form.scope.label")}
              <select
                value={form().scope}
                onChange={(e) => {
                  const scope = e.currentTarget.value as FormState["scope"]
                  // When switching to `project`, seed the current session's
                  // path if no project is selected yet.
                  setForm((s) => ({
                    ...s,
                    scope,
                    projects:
                      scope === "project" && s.projects.length === 0
                        ? [currentProjectPath()].filter(Boolean)
                        : s.projects,
                  }))
                }}
              >
                <option value="all">{t("scopeAll")}</option>
                <option value="machine">{t("scopeMachine")}</option>
                <option value="project">{t("scopeProject")}</option>
              </select>
            </label>
          </div>
          <Show when={form().scope === "project"}>
            <MultiSelect
              label={t("form.project.label")}
              placeholder={t("form.project.placeholder")}
              options={projectOptions()}
              display={scopeOptionLabel}
              value={() => form().projects}
              onValueChange={(v) => setForm((s) => ({ ...s, projects: v }))}
              openFilter={formProjectOpen}
              which="project"
              onOpenChange={() =>
                setFormProjectOpen((v) => (v === "project" ? null : "project"))
              }
              optionTitle={(opt) => opt}
            />
          </Show>
          <label>
            {t("form.tags.label")}
            <ctx.ui.TextInput
              label={t("form.tags.label")}
              placeholder={t("form.tags.placeholder")}
              value={form().tags}
              onInput={(v) => setForm((s) => ({ ...s, tags: v }))}
            />
          </label>
          <div class="notes-form-actions">
            <ctx.ui.Button variant="ghost" onClick={() => setFormOpen(false)}>
              {t("form.cancel")}
            </ctx.ui.Button>
            <ctx.ui.Button
              variant="contrast"
              type="submit"
              busy={saving()}
              disabled={!form().title.trim() || !form().content.trim()}
            >
              {form().mode === "add" ? t("form.add") : t("form.save")}
            </ctx.ui.Button>
          </div>
        </form>
        </section>
      </Show>

      <div class="notes-body">
        <div
          class="notes os-scroll os-list"
          ref={nav.ref}
          onKeyDown={nav.onKeyDown}
          tabIndex={nav.scrollable() ? 0 : undefined}
          role="region"
          aria-label={t("scroll.region")}
        >
        <Show when={filteredNotes().length === 0 && !loading()}>
          <EmptyState icon="file-document" title={emptyTitle()} hint={emptyHint()} />
        </Show>
        {visibleNotes().map((n, i, arr) => (
          <>
            {/* Each section opens with its own header. */}
            <Show when={n.pinned && (i === 0 || !arr[i - 1]?.pinned)}>
              <div class="note-group-head">{t("group.pinned")}</div>
            </Show>
            <Show
              when={
                !n.pinned &&
                hasPinned() &&
                (i > 0 ? arr[i - 1]?.pinned : false)
              }
            >
              <div class="note-group-head">{t("group.others")}</div>
            </Show>
            {card(n)}
          </>
        ))}
        </div>
        <ScrollNav nav={nav} topLabel={t("scroll.top")} bottomLabel={t("scroll.bottom")} />
      </div>
    </div>
  )
}
