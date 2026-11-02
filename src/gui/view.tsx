/**
 * Notes side panel — SolidJS UI, aligned with the app design system.
 *
 * Renders the plugin's own `ctx.ui` components (buttons, text fields,
 * loader, icons) and the app's CSS tokens (`--v2-*`, `--font-*`), so the
 * panel follows the user's theme (light/dark), fonts and language. UI copy
 * is pt-BR; code stays in English.
 *
 * Data: reads notes over the GUI IPC (`ctx.main(NotesApi)`), full CRUD —
 * add / edit / confirm / dispute / retract / pin / unpin / restore —
 * FTS search with LIKE fallback, a pinned filter, and revision history.
 */

import { createEffect, createMemo, createSignal } from "solid-js"
import type { Accessor } from "solid-js"
import { Show } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import { NotesApi } from "./contract"
import type { Note, NoteDetail, NoteResult, Revision } from "./contract"
import {
  applyFilters,
  filterByQuery,
  pruneSelection,
  tagsOf,
} from "./filters"

const CATEGORIES = [
  { value: "problem", label: "problem" },
  { value: "decision", label: "decision" },
  { value: "config", label: "config" },
  { value: "snippet", label: "snippet" },
  { value: "architecture", label: "architecture" },
  { value: "user", label: "user" },
  { value: "general", label: "general" },
]

type FormState = {
  mode: "add" | "edit"
  id?: number
  category: string
  title: string
  content: string
  tags: string
  author: string
  scope: string
}

const defaultForm: FormState = {
  mode: "add",
  category: "problem",
  title: "",
  content: "",
  tags: "",
  author: "",
  scope: "",
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
  which: "scope" | "tag"
  onOpenChange: () => void
}

function MultiSelect(props: MultiSelectProps) {
  const { label, placeholder, options, value, onValueChange, openFilter, which, onOpenChange } = props
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
  const visibleOptions = createMemo(() => filterByQuery(options, search()))

  return (
    <div class="filter-cell">
      <div class="filter-btn-row">
        <button
          class="filter-btn"
          type="button"
          aria-expanded={open()}
          aria-label={label}
          onClick={onOpenChange}
        >
          <div class="filter-btn-content">
            <Show when={value().length === 0}>
              <span class="filter-btn-label is-placeholder">{placeholder}</span>
            </Show>
            <Show when={value().length > 0}>
              <span class="tags">
                {value().slice(0, 3).map((opt) => (
                  <span class="tag">{opt}</span>
                ))}
                {value().length > 3 && (
                  <span class="tag tag-more">+{value().length - 3}</span>
                )}
              </span>
            </Show>
          </div>
          <span class="filter-btn-caret" aria-hidden="true" />
        </button>
        <Show when={value().length > 0}>
          <button
            class="filter-clear"
            type="button"
            aria-label={`Limpar ${label}`}
            onClick={clear}
          >
            <span class="filter-clear-x" aria-hidden="true">×</span>
          </button>
        </Show>
      </div>

      <div
        class={open() ? "filter-panel" : "filter-panel is-hidden"}
        aria-hidden={!open()}
      >
        <div class="filter-panel-head">
          <span class="filter-panel-title">{label}</span>
          <Show when={value().length > 0}>
            <button class="btn-app is-ghost" type="button" onClick={clear}>
              Limpar
            </button>
          </Show>
        </div>
        <div class="filter-panel-search">
          <input
            type="text"
            class="filter-panel-search-input"
            placeholder="Filtrar…"
            aria-label={`Filtrar ${label.toLowerCase()}`}
            value={search()}
            onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="filter-panel-list">
          <Show when={search().trim() !== "" && visibleOptions().length === 0}>
            <div class="filter-empty">nada</div>
          </Show>
          {visibleOptions().map((opt) => (
            <label class="filter-option">
              <input
                type="checkbox"
                checked={value().includes(opt)}
                onChange={(e) => toggle(opt, e.target.checked)}
              />
              <span>{opt}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}

const PAGE_SIZE = 25

// Keeps each attached note's composer id unique, so attaching the same note
// twice adds two independent chips instead of colliding on the same id.
let attachSeq = 0

export function NotesView() {
  const ctx = usePlugin()
  const api = ctx.main(NotesApi)

  /* ---------- state ---------- */
  const [query, setQuery] = createSignal("")
  const [showRetracted, setShowRetracted] = createSignal(false)
  const [pinnedOnly, setPinnedOnly] = createSignal(false)
  const [scopeFilter, setScopeFilter] = createSignal<string[]>([])
  const [tagFilter, setTagFilter] = createSignal<string[]>([])
  // Only one combo can be open at a time; the single signal drives both the
  // "Escopo" and "Tag" buttons (each combo's `open` is derived from here).
  const [openFilter, setOpenFilter] = createSignal<string | null>(null)
  const [selectedId, setSelectedId] = createSignal<number | null>(null)
  const [detail, setDetail] = createSignal<NoteDetail | null>(null)
  const [revisionsOpen, setRevisionsOpen] = createSignal(false)
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [formOpen, setFormOpen] = createSignal(false)
  const [form, setForm] = createSignal(defaultForm)
  // Unfiltered snapshot behind the scope/tag dropdowns: the options must not
  // shrink to whatever the active filter currently matches.
  const [allNotes, setAllNotes] = createSignal<Note[]>([])
  // Fetched, unfiltered results for the list view (all when there is no query,
  // the search result when there is). Filters (retracted/pinned/scope/tag) are
  // applied reactively below, so deselecting an option re-filters instantly.
  const [resNotes, setResNotes] = createSignal<Note[]>([])
  const [page, setPage] = createSignal(0)

  const locale = () => ctx.locale.locale()

  // Toggle a combo open/closed (switching to another simply re-targets the
  // single `openFilter`, so only one panel is ever visible).
  const toggleFilter = (which: "scope" | "tag") =>
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
      const nextScope = scope.filter((s) => all.some((n) => (n.scope ?? "") === s))
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
    setPage(0)
    void loadNotes()
  })

  // Keep the multi-select filters pointing only at values that still exist,
  // so deleting a note can't leave a phantom selection. Cheap: no fetch.
  createEffect(() => {
    const existsScope = (s: string) => allNotes().some((n) => (n.scope ?? "") === s)
    const existsTag = (t: string) => allNotes().some((n) => tagsOf(n).includes(t))
    const nextScope = pruneSelection(scopeFilter(), existsScope)
    const nextTag = pruneSelection(tagFilter(), existsTag)
    if (nextScope !== scopeFilter()) setScopeFilter(nextScope)
    if (nextTag !== tagFilter()) setTagFilter(nextTag)
  })

  // Keep the current page valid when the filtered result shrinks.
  createEffect(() => {
    const maxPage = Math.max(0, Math.ceil(filteredNotes().length / PAGE_SIZE) - 1)
    if (page() > maxPage) setPage(maxPage)
  })

  // Filter choices come from the unfiltered snapshot, so picking one scope or
  // tag never removes the others from the dropdown.
  const scopeOptions = createMemo(() =>
    [...new Set(allNotes().map((n) => n.scope ?? "").filter(Boolean))].sort((a, b) =>
      a.localeCompare(b)
    )
  )
  const tagOptions = createMemo(() =>
    [...new Set(allNotes().flatMap(tagsOf))].sort((a, b) => a.localeCompare(b))
  )

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
        const message = res.error ?? "ação falhou"
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
      setError("Título e conteúdo são obrigatórios.")
      return
    }
    const content = f.content.trim()
    const scope = f.scope.trim() || undefined
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
              scope,
            })
          : await api.update({
              id: f.id as number,
              title: f.title.trim(),
              content,
              tags: f.tags.trim() || undefined,
              category: f.category,
              // An explicit empty string clears the scope.
              scope: f.scope.trim(),
            })
      if (res.ok) {
        setFormOpen(false)
        setForm(defaultForm)
        void reloadSelected(res.note?.id ?? null)
      } else {
        setError(res.error ?? "falha ao salvar")
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
      void loadNotes()
    }
  }

  const openAdd = () => {
    setForm({ ...defaultForm })
    setFormOpen(true)
  }

  const openEdit = (n: Note) => {
    setForm({
      mode: "edit",
      id: n.id,
      category: (n.category ?? "problem").replace(/^#/, ""),
      title: n.title,
      content: n.content,
      tags: n.tags || "",
      author: n.author || "",
      scope: n.scope ?? "",
    })
    setFormOpen(true)
  }

  // A getter, not `selectedId()`: the actions are built once, when the view
  // mounts, so a plain read would freeze the selection at `null` and every
  // button would return early.
  const id = () => selectedId()
  const confirm = () => {
    const current = id()
    if (current !== null) void doAction(api.confirm, current, "Nota confirmada")
  }
  const dispute = async () => {
    const current = id()
    if (current === null) return
    const why = await ctx.dialogs.prompt({
      title: "Questionar nota",
      description: "Descreva por que a nota parece incorreta.",
      placeholder: "ex.: desatualizada, contradiz a nota #123",
      submit: "Questionar",
    })
    if (why && why.trim()) {
      void doAction(api.dispute, { id: current, reason: why.trim() }, "Nota questionada")
    }
  }
  const retract = async () => {
    const current = id()
    if (current === null) return
    const why = await ctx.dialogs.prompt({
      title: "Retirar nota",
      description: "A nota passa a ser desconsiderada; pode ser restaurada depois.",
      placeholder: "motivo (opcional)",
      submit: "Retirar",
    })
    if (why === undefined) return
    void doAction(
      api.retract,
      { id: current, reason: why.trim() || undefined },
      "Nota retirada"
    )
  }
  const pin = () => {
    const current = id()
    if (current !== null) void doAction(api.pin, current, "Nota fixada")
  }
  const unpin = () => {
    const current = id()
    if (current !== null) void doAction(api.unpin, current, "Nota desfixada")
  }
  const remove = async () => {
    const current = id()
    if (current === null) return
    const ok = await ctx.dialogs.confirm({
      title: "Excluir nota",
      description: `Excluir permanentemente a nota #${current} e todas as suas versões. Não há como recuperar.`,
      confirm: "Excluir",
      danger: true,
    })
    if (ok) {
      void doAction(api.delete, { id: current }, "Nota excluída")
    }
  }
  const restore = async (rev: Revision) => {
    const current = id()
    if (current === null) return
    const ok = await ctx.dialogs.confirm({
      title: "Restaurar revisão",
      description: `A nota será restaurada para a revisão #${rev.id}. A versão atual passa a ser uma revisão anterior.`,
      confirm: "Restaurar",
      danger: true,
    })
    if (ok) {
      void doAction(api.restore, { id: current, revisionId: rev.id }, "Revisão restaurada")
    }
  }

  /* ---------- derived ---------- */
  // Reactive filter application: retracted/pinned/scope/tag are applied here,
  // so deselecting an option re-filters instantly with no re-fetch (and no
  // stale read from an async load). All the predicate logic lives in
  // `applyFilters` (src/gui/filters.ts) and is unit-tested.
  const filteredNotes = createMemo(() =>
    applyFilters(resNotes(), {
      scope: scopeFilter(),
      tag: tagFilter(),
      pinnedOnly: pinnedOnly(),
      showRetracted: showRetracted(),
    })
  )
  const count = createMemo(() => filteredNotes().length)
  const pageCount = createMemo(() => Math.max(1, Math.ceil(filteredNotes().length / PAGE_SIZE)))
  const pagedNotes = createMemo(() => {
    const start = page() * PAGE_SIZE
    return filteredNotes().slice(start, start + PAGE_SIZE)
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
      String(n.category).replace(/^#/, ""),
      n.scope ? `scope: ${n.scope}` : "",
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
        title: "Nenhuma sessão aberta",
        description: "Abra uma sessão para adicionar notas ao contexto.",
        variant: "error",
      })
      return
    }
    if (!screen.composer.quotable()) {
      ctx.toast.show({
        title: "Contexto indisponível agora",
        description: "O compositor desta sessão não aceita anexos neste momento.",
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
      title: `Nota #${n.id} adicionada ao contexto`,
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
        <span class="tags">
          {shown.map((t) => (
            <span class="tag">{t}</span>
          ))}
          <Show when={max !== undefined && tags.length > shown.length}>
            <span class="tag tag-more">+{tags.length - shown.length}</span>
          </Show>
        </span>
      </Show>
    )
  }

  // A note counts as confirmed only while it is not disputed or retracted:
  // both states can be resolved by confirming it again.
  const isConfirmed = (n: Note): boolean =>
    n.verifiedAt !== undefined && n.disputedAt === undefined && n.retractedAt === undefined

  const trustBadges = (n: Note) => (
    <span class="badges">
      <Show when={n.pinned}>
        <span class="badge badge-pinned">fixada</span>
      </Show>
      <Show when={n.retractedAt !== undefined}>
        <span class="badge badge-retracted">retirada</span>
      </Show>
      <Show when={n.disputedAt !== undefined}>
        <span class="badge badge-disputed">questionada</span>
      </Show>
      <Show when={n.verifiedAt !== undefined && !n.disputedAt && !n.retractedAt}>
        <span class="badge badge-verified">verificada</span>
      </Show>
    </span>
  )

  const card = (n: Note) => (
    <section
      class={`note ${n.pinned ? "pinned" : ""} ${
        n.retractedAt !== undefined ? "retracted" : ""
      } ${selectedId() === n.id ? "selected" : ""}`}
    >
      <div class="note-row">
        <button class="note-head" onClick={() => toggleNote(n.id)}>
          <span class="note-id">#{n.id}</span>
          <span class="note-cat">{String(n.category).replace(/^#/, "")}</span>
          <span class="note-title" title={n.title}>
            {n.title}
          </span>
          {tagChips(n, 2)}
          <Show when={n.scope}>
            <span class="tag tag-scope" title={`Escopo: ${n.scope}`}>
              {n.scope}
            </span>
          </Show>
          {trustBadges(n)}
          <ctx.ui.Icon name="chevron-right" size="small" class="chevron" />
        </button>
        <ctx.ui.Tooltip value="Adicionar ao contexto">
          <ctx.ui.IconButton
            class="note-attach"
            icon="plus"
            label={`Adicionar nota #${n.id} ao contexto`}
            size="small"
            onClick={() => addToContext(n)}
          />
        </ctx.ui.Tooltip>
      </div>
      <Show when={selectedId() === n.id}>
        <div class="note-body">
          <div class="meta">
            <span>{formatTime(n.timestamp)}</span>
            <Show when={n.author}>
              <span>por {n.author}</span>
            </Show>
            <Show when={n.scope}>
              <span class="tag tag-scope">escopo: {n.scope}</span>
            </Show>
            {tagChips(n)}
          </div>
          <pre class="note-content">{n.content}</pre>
          <div class="actions">
            <button class="btn-app" onClick={() => openEdit(n)}>
              <ctx.ui.Icon name="edit" size="small" />
              Editar
            </button>
            <Show when={!isConfirmed(n)}>
              <button class="btn-app" onClick={confirm}>
                <ctx.ui.Icon name="circle-check" size="small" />
                Confirmar
              </button>
            </Show>
            <button class="btn-app" onClick={dispute}>
              <ctx.ui.Icon name="outline-hexagonal-warning" size="small" />
              Questionar
            </button>
            <button class="btn-app is-danger" onClick={retract}>
              <ctx.ui.Icon name="trash" size="small" />
              Retirar
            </button>
            <button class="btn-app" onClick={n.pinned ? unpin : pin}>
              <ctx.ui.Icon name={n.pinned ? "close-small" : "lock"} size="small" />
              {n.pinned ? "Desfixar" : "Fixar"}
            </button>
            <button class="btn-app is-danger" onClick={remove}>
              <ctx.ui.Icon name="trash" size="small" />
              Excluir
            </button>
          </div>
          <div class="revisions">
            <button class="btn-app" onClick={() => setRevisionsOpen(!revisionsOpen())}>
              <ctx.ui.Icon name="outline-rotate-clockwise" size="small" />
              Revisões{revs().length > 0 ? ` · ${revs().length}` : ""}
            </button>
            <Show when={revisionsOpen()}>
              <div class="rev-list">
                <Show when={revs().length === 0}>
                  <div class="muted">Sem versões anteriores.</div>
                </Show>
                {revs().map((r) => (
                  <div class="rev">
                    <div class="rev-head">
                      Revisão #{r.id} · {formatTime(r.revisedAt)} · válida desde{" "}
                      {formatTime(r.timestamp)}
                    </div>
                    <pre class="note-content small">{r.content}</pre>
                    <button class="btn-app" onClick={() => restore(r)}>
                      <ctx.ui.Icon name="arrow-undo-down" size="small" />
                      Restaurar
                    </button>
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
          padding: 8px 12px 6px;
        }
        .notes-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
        .notes-title { display: flex; align-items: center; gap: 6px; font-weight: 550; }
        .notes-count { font-size: 12px; color: var(--v2-text-text-muted); }
        .spacer { flex: 1; }
        .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
        .filter-row { display: flex; gap: 8px; margin-bottom: 8px; align-items: flex-start; }
        /* Each combo is its own column; the dropdown hangs from the button. */
        .filter-cell { position: relative; flex: 1; min-width: 0; }
        .filter-btn-row { display: flex; gap: 4px; align-items: stretch; }
        .filter-btn {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          flex: 1;
          width: auto;
          min-width: 0;
          min-height: 32px;
          padding: 4px 8px;
          border: 1px solid var(--v2-border-border-muted);
          border-radius: 4px;
          background: var(--v2-background-bg-layer-02);
          color: var(--v2-text-text-base);
          font: inherit;
          cursor: pointer;
          user-select: none;
          text-align: left;
        }
        .filter-btn:hover { border-color: var(--v2-border-border-strong); }
        .filter-btn:focus-visible { outline: 2px solid var(--v2-border-border-focus); outline-offset: 0; }
        .filter-btn-label {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .filter-btn-label.is-placeholder { color: var(--v2-text-text-faint); font-style: italic; }
        /* Groups the placeholder/chips on the left; the caret sits at the end. */
        .filter-btn-content { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: flex-start; gap: 4px; }
        /* Combo button: the note-row .tag/.tags pill uses bg-layer-02 — the
           SAME token as this button's background — so it reads as invisible.
           Re-skin it here as a higher-contrast filled pill that works in
           light + dark, and never truncate the text (the button has room). */
        .filter-btn-content .tags { max-width: none; overflow: visible; }
        .filter-btn-content .tag {
          background: var(--v2-overlay-simple-overlay-pressed);
          border: 1px solid var(--v2-border-border-muted);
          color: var(--v2-text-text-base);
          font-weight: 500;
          max-width: none;
          overflow: visible;
          text-overflow: clip;
        }
        .filter-btn-content .tag-more {
          background: transparent;
          border: 0;
          color: var(--v2-text-text-muted);
        }
        .filter-btn-caret {
          flex: 0 0 auto;
          width: 8px;
          height: 8px;
          border-left: 1.5px solid currentColor;
          border-bottom: 1.5px solid currentColor;
          transform: rotate(45deg);
          transition: transform 0.12s ease;
        }
        /* Small "clear" button next to the combo when there is a selection. */
        .filter-clear {
          flex: 0 0 auto;
          min-height: 32px;
          align-self: stretch;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0 7px;
          border: 1px solid var(--v2-border-border-muted);
          border-radius: 4px;
          background: var(--v2-background-bg-layer-02);
          color: var(--v2-text-text-base);
          font: inherit;
          cursor: pointer;
          user-select: none;
        }
        .filter-clear:hover { border-color: var(--v2-border-border-strong); }
        .filter-clear:focus-visible { outline: 2px solid var(--v2-border-border-focus); outline-offset: 0; }
        .filter-clear-x { font-size: 16px; line-height: 1; }
        .filter-panel {
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
        .filter-panel.is-hidden { display: none; }
        .filter-panel-head {
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
        .filter-panel-list { display: flex; flex-direction: column; gap: 2px; padding: 4px; }
        /* Free-text option filter, shown between the head and the list. */
        .filter-panel-search { padding: 4px 8px; }
        .filter-panel-search-input {
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
        .filter-panel-search-input:focus {
          outline: 2px solid var(--v2-border-border-focus);
          outline-offset: 0;
        }
        .filter-empty { padding: 12px 8px; font-size: 12.5px; color: var(--v2-text-text-faint); }
        .filter-option {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 4px 4px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12.5px;
          color: var(--v2-text-text-base);
        }
        .filter-option:hover { background: var(--v2-overlay-simple-overlay-pressed); }
        .filter-option input[type="checkbox"] {
          margin: 0;
          flex: 0 0 auto;
          accent-color: var(--v2-state-fg-success);
        }
        .filter-option span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .filter-panel-head .btn-app { font-size: 11px; padding: 2px 8px; color: var(--v2-text-text-muted); }
        .filter-panel-head .btn-app:hover { color: var(--v2-text-text-base); }
        .notes { display: flex; flex-direction: column; gap: 6px; overflow-y: auto; flex: 1; min-height: 0; }
        .note {
          border: 1px solid var(--v2-border-border-muted);
          border-radius: 4px;
          background: transparent;
          overflow: hidden;
          flex: 0 0 auto;
        }
        .note.retracted { opacity: 0.55; }
        .note.selected { border-color: var(--v2-border-border-focus); }
        .note-row { display: flex; align-items: center; min-width: 0; }
        .note-attach { flex: 0 0 auto; margin-right: 6px; }
        .note-head {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 1;
          min-width: 0;
          text-align: left;
          background: transparent;
          border: 0;
          font: inherit;
          color: inherit;
          cursor: pointer;
          box-sizing: border-box;
          min-height: 32px;
          padding: 5px 8px 5px 12px;
        }
        .note-head:hover { background: var(--v2-overlay-simple-overlay-hover); }
        .note-head:focus-visible { outline: 2px solid var(--v2-border-border-focus); outline-offset: -2px; }
        .note-id { font-weight: 550; color: var(--v2-text-text-muted); }
        .note-cat { font-size: 11px; color: var(--v2-text-text-faint); }
        .note-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tags {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          flex: 0 1 auto;
          min-width: 0;
          max-width: 45%;
          overflow: hidden;
        }
        .tag {
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
        .tag-more { color: var(--v2-text-text-faint); }
        /* Scope reads as hierarchy, not as a free-form tag. */
        .tag-scope { color: var(--v2-text-text-base); border: 1px solid var(--v2-border-border-muted); }
        .badges { display: flex; gap: 4px; flex: 0 0 auto; }        .badge { font-size: 11px; line-height: 1.4; border-radius: 999px; padding: 0 7px; }
        .badge-pinned { border: 1px solid var(--v2-border-border-muted); color: var(--v2-icon-icon-base); }
        .badge-verified { border: 1px solid var(--v2-state-border-success); color: var(--v2-state-fg-success); }
        .badge-retracted { border: 1px solid var(--v2-state-border-danger); color: var(--v2-state-fg-danger); }
        .badge-disputed { border: 1px solid var(--v2-state-border-warning); color: var(--v2-state-fg-warning); }
        .note-body { padding: 8px 12px 12px; border-top: 1px solid var(--v2-border-border-muted); }
        .meta {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          font-size: 11.5px;
          color: var(--v2-text-text-faint);
          margin-bottom: 6px;
        }
        .meta .tags { max-width: none; flex-wrap: wrap; }
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
        .actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 8px; }
        .revisions { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
        .rev { border: 1px solid var(--v2-border-border-muted); border-radius: 4px; padding: 8px; }
        .rev-head { font-size: 11.5px; font-weight: 550; color: var(--v2-text-text-faint); margin-bottom: 4px; }
        .rev-list { display: flex; flex-direction: column; gap: 8px; }
        .empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 28px 8px; color: var(--v2-text-text-faint); text-align: center; }
        .empty-icon { opacity: 0.55; margin-bottom: 4px; }
        .muted { font-size: 11.5px; color: var(--v2-text-text-faint); text-align: center; }
        .err {
          border: 1px solid var(--v2-state-border-danger);
          border-radius: 4px;
          padding: 8px 10px;
          margin-bottom: 4px;
          font-size: 12.5px;
          color: var(--v2-state-fg-danger);
        }
        .form {
          display: flex;
          flex-direction: column;
          gap: 10px;
          background: var(--v2-background-bg-base);
          border: 1px solid var(--v2-border-border-muted);
          border-radius: 4px;
          padding: 12px;
          margin-bottom: 6px;
        }
        .form > label {
          display: flex;
          flex-direction: column;
          gap: 3px;
          font-size: 12px;
          font-weight: 550;
          color: var(--v2-text-text-muted);
        }
        .form textarea {
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
        .form select {
          border: 1px solid var(--v2-border-border-muted);
          border-radius: 4px;
          background: var(--v2-background-bg-layer-02);
          color: var(--v2-text-text-base);
          font: inherit;
          padding: 4px 6px;
        }
        /* The native dropdown paints its own white surface on Linux, so the
           options must carry the theme colors or their text washes out. */
        .form select option {
          background: var(--v2-background-bg-layer-02);
          color: var(--v2-text-text-base);
        }
        .form textarea:focus,
        .form select:focus {
          outline: 2px solid var(--v2-border-border-focus);
          outline-offset: 0;
          background: var(--v2-background-bg-layer-02);
        }
        .form-actions { display: flex; justify-content: flex-end; gap: 8px; }
        .pager { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 2px 4px 6px; }
        .page-label { font-size: 11.5px; color: var(--v2-text-text-faint); }

        /* Borderless app-style button (no border), using the theme tokens. */
        .btn-app {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          border: 0;
          border-radius: 6px;
          font: inherit;
          font-size: 13px;
          line-height: 1.4;
          padding: 2px 10px;
          cursor: pointer;
          user-select: none;
          background: transparent;
          color: var(--v2-text-text-faint);
        }
        .btn-app:hover {
          background: var(--v2-overlay-simple-overlay-hover);
          color: var(--v2-text-text-base);
        }
        .btn-app.is-danger:hover {
          background: var(--v2-state-bg-danger);
          color: var(--v2-state-fg-danger);
        }
        .btn-app:focus-visible {
          outline: 2px solid var(--v2-border-border-focus);
          outline-offset: 0;
        }
        /* "Nova nota" CTA: subtle resting pill, like the app's New session. */
        .btn-app.is-pill {
          background: var(--v2-background-bg-layer-02);
          color: var(--v2-text-text-muted);
        }
        .btn-app.is-pill:hover {
          background: var(--v2-overlay-simple-overlay-pressed);
          color: var(--v2-text-text-base);
        }
        /* Active filter chip: subtle filled state, no border. */
        .btn-app.is-active {
          background: var(--v2-background-bg-layer-02);
          color: var(--v2-text-text-base);
          font-weight: 550;
        }
        .btn-app.is-active:hover {
          background: var(--v2-overlay-simple-overlay-pressed);
          color: var(--v2-text-text-base);
        }
      `}</style>

      <header class="notes-head">
        <span class="notes-title">
          <ctx.ui.Icon name="file-document" size="small" />
          Notas
        </span>
        <span class="notes-count">{count()} notas</span>
        <span class="spacer" />
        <button class="btn-app is-pill" onClick={openAdd}>
          <ctx.ui.Icon name="plus" size="small" />
          Nova nota
        </button>
      </header>

      <div class="search-row">
        <ctx.ui.TextInput
          type="search"
          label="Buscar notas"
          placeholder="Buscar na memória…"
          value={query()}
          onInput={setQuery}
        />
      </div>

      <div class="chips">
        <button
          class={`btn-app ${pinnedOnly() ? "is-active" : ""}`}
          onClick={() => setPinnedOnly(!pinnedOnly())}
        >
          Fixadas
        </button>
        <button
          class={`btn-app ${showRetracted() ? "is-active" : ""}`}
          onClick={() => setShowRetracted(!showRetracted())}
        >
          Retiradas
        </button>
      </div>

                  <Show when={scopeOptions().length > 0 || tagOptions().length > 0}>
        <div class="filter-row">
          <Show when={scopeOptions().length > 0}>
            <MultiSelect
              label="Escopo"
              placeholder="Todos os escopos"
              options={scopeOptions()}
              value={scopeFilter}
              onValueChange={setScopeFilter}
              openFilter={openFilter}
              which="scope"
              onOpenChange={() => toggleFilter("scope")}
            />
          </Show>
          <Show when={tagOptions().length > 0}>
            <MultiSelect
              label="Tag"
              placeholder="Todas as tags"
              options={tagOptions()}
              value={tagFilter}
              onValueChange={setTagFilter}
              openFilter={openFilter}
              which="tag"
              onOpenChange={() => toggleFilter("tag")}
            />
          </Show>
        </div>
      </Show>

      <Show when={loading()}>
        <div class="loader-row">
          <ctx.ui.Loader size="small" />
          <span>Carregando…</span>
        </div>
      </Show>
      <Show when={error() !== ""}>
        <div class="err">{error()}</div>
      </Show>

      <Show when={formOpen()}>
        <form class="form" onSubmit={(e) => { e.preventDefault(); void handleAddOrEdit() }}>
          <label>
            Categoria
            <select
              value={form().category}
              onChange={(e) => setForm((s) => ({ ...s, category: e.currentTarget.value }))}
            >
              {CATEGORIES.map((c) => (
                <option value={c.value}>{c.label}</option>
              ))}
            </select>
          </label>
          <label>
            Título
            <ctx.ui.TextInput
              label="Título"
              value={form().title}
              onInput={(v) => setForm((s) => ({ ...s, title: v }))}
              onSubmit={handleAddOrEdit}
            />
          </label>
          <label>
            Conteúdo
            <textarea
              value={form().content}
              onInput={(e) => setForm((s) => ({ ...s, content: e.currentTarget.value }))}
              placeholder="Registre aqui o que precisa lembrar…"
            />
          </label>
          <label>
            Tags
            <ctx.ui.TextInput
              label="Tags"
              placeholder="palavras-chave separadas por espaço"
              value={form().tags}
              onInput={(v) => setForm((s) => ({ ...s, tags: v }))}
            />
          </label>
          <label>
            Escopo
            <ctx.ui.TextInput
              label="Escopo"
              placeholder="global, project:<nome> ou machine:<nome>"
              value={form().scope}
              onInput={(v) => setForm((s) => ({ ...s, scope: v }))}
            />
          </label>
          <label>
            Autor
            <ctx.ui.TextInput
              label="Autor"
              placeholder="quem registrou (opcional)"
              value={form().author}
              onInput={(v) => setForm((s) => ({ ...s, author: v }))}
            />
          </label>
          <div class="form-actions">
            <ctx.ui.Button variant="ghost" onClick={() => setFormOpen(false)}>
              Cancelar
            </ctx.ui.Button>
            <ctx.ui.Button
              variant="contrast"
              type="submit"
              busy={saving()}
              disabled={!form().title.trim() || !form().content.trim()}
            >
              {form().mode === "add" ? "Adicionar nota" : "Salvar alterações"}
            </ctx.ui.Button>
          </div>
        </form>
      </Show>

      <div class="notes">
        <Show when={filteredNotes().length === 0 && !loading()}>
          <div class="empty">
            <ctx.ui.Icon name="file-document" size="large" class="empty-icon" />
            <div>
              <Show when={query().trim()}>
                Nenhuma nota corresponde a "{query().trim()}".
              </Show>
              <Show when={!query().trim() && showRetracted()}>
                Nenhuma nota retirada.
              </Show>
              <Show when={!query().trim() && !showRetracted()}>
                Nenhuma nota ainda.
              </Show>
            </div>
            <div class="muted">
              <Show when={query().trim()}>
                Ajuste a busca ou os filtros.
              </Show>
              <Show when={!query().trim() && showRetracted()}>
                Desative o filtro "Retiradas" para ver as demais.
              </Show>
              <Show when={!query().trim() && !showRetracted()}>
                Registre a primeira com "Nova nota".
              </Show>
            </div>
          </div>
        </Show>
        {pagedNotes().map((n) => card(n))}
      </div>

      <Show when={pageCount() > 1}>
        <div class="pager">
          <ctx.ui.Button
            size="small"
            variant="ghost-muted"
            icon="outline-arrow-left"
            disabled={page() === 0}
            onClick={() => setPage(page() - 1)}
          >
            Anterior
          </ctx.ui.Button>
          <span class="page-label">Página {page() + 1} de {pageCount()}</span>
          <ctx.ui.Button
            size="small"
            variant="ghost-muted"
            icon="outline-arrow-right"
            disabled={page() >= pageCount() - 1}
            onClick={() => setPage(page() + 1)}
          >
            Próxima
          </ctx.ui.Button>
        </div>
      </Show>
    </div>
  )
}
