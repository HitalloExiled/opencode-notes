/**
 * Notes side panel — SolidJS UI.
 *
 * Reads the notes over the GUI IPC (`ctx.main(NotesApi)`) and offers full
 * CRUD: add / edit / confirm / dispute / retract / pin / unpin / restore,
 * search (FTS with LIKE fallback), a pinned filter, and revision history.
 */

import { createEffect, createMemo, createSignal } from "solid-js"
import { Show } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import { NotesApi } from "./contract"

const CATEGORIES = [
  { value: "problem", label: "#problem" },
  { value: "decision", label: "#decision" },
  { value: "config", label: "#config" },
  { value: "snippet", label: "#snippet" },
  { value: "architecture", label: "#architecture" },
  { value: "user", label: "#user" },
  { value: "general", label: "#general" },
]

type Note = {
  id: number
  timestamp: string
  category: string
  title: string
  content: string
  pinned?: boolean
  verifiedAt?: string | undefined
  disputedAt?: string | undefined
  retractedAt?: string | undefined
  statusReason?: string | undefined
  tags?: string | undefined
  author?: string | undefined
}

type Revision = {
  id: number
  revisedAt: string
  timestamp: string
  category: string
  title: string
  content: string
  tags?: string | undefined
}

type NoteDetail = {
  note: Note
  revisions: Revision[]
}

type FormState = {
  mode: "add" | "edit"
  id?: number
  category: string
  title: string
  content: string
  tags: string
  author: string
}

const defaultForm: FormState = {
  mode: "add",
  category: "problem",
  title: "",
  content: "",
  tags: "",
  author: "",
}

export function NotesView() {
  const ctx = usePlugin()
  const api = ctx.main(NotesApi)

  /* ---------- state ---------- */
  const [query, setQuery] = createSignal("")
  const [showRetracted, setShowRetracted] = createSignal(false)
  const [pinnedOnly, setPinnedOnly] = createSignal(false)
  const [selectedId, setSelectedId] = createSignal<number | null>(null)
  const [detail, setDetail] = createSignal<NoteDetail | null>(null)
  const [revisionsOpen, setRevisionsOpen] = createSignal(false)
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [formOpen, setFormOpen] = createSignal(false)
  const [form, setForm] = createSignal(defaultForm)
  const [notes, setNotes] = createSignal<Note[]>([])

  /* ---------- loading ---------- */
  const loadNotes = async () => {
    const q = query().trim()
    setLoading(true)
    setError("")
    try {
      const res = q
        ? await api.search({ query: q, all: showRetracted() })
        : await api.list({ all: showRetracted(), limit: 500 })
      let out = res as unknown as Note[]
      if (pinnedOnly()) out = out.filter((n) => n.pinned)
      setNotes(out)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  // Re-runs when query / filters change (those signals are read inside loadNotes).
  createEffect(() => {
    void loadNotes()
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
  const doAction = async (
    fn: (a: any) => Promise<{ ok: boolean; error?: string | undefined; note?: Note | null }>,
    arg: any
  ): Promise<void> => {
    try {
      const res = await fn(arg)
      if (res.ok) {
        setSelectedId(null)
      } else {
        setError(res.error ?? "action failed")
      }
    } catch (e) {
      setError(String(e))
    } finally {
      void loadNotes()
    }
  }

  const handleAddOrEdit = async () => {
    const f = form()
    if (f.title.trim().length === 0 || f.content.trim().length === 0) {
      setError("Title and content are required.")
      return
    }
    try {
      const res =
        f.mode === "add"
          ? await api.add({
              category: f.category,
              title: f.title.trim(),
              content: f.content.trim(),
              tags: f.tags.trim() || undefined,
              author: f.author.trim() || undefined,
            })
          : await api.update({
              id: f.id as number,
              title: f.title.trim(),
              content: f.content.trim(),
              tags: f.tags.trim() || undefined,
              category: f.category,
            })
      if (res.ok) {
        setFormOpen(false)
        setForm(defaultForm)
        void reloadSelected(res.note?.id ?? null)
      } else {
        setError(res.error ?? "save failed")
      }
    } catch (e) {
      setError(String(e))
    } finally {
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
    })
    setFormOpen(true)
  }

  const id = selectedId()
  const confirm = () => id !== null && void doAction(api.confirm, id)
  const dispute = () => {
    if (id === null) return
    const why = prompt("Reason for disputing (why it looks wrong):")
    if (why && why.trim()) void doAction(api.dispute, { id, reason: why.trim() })
  }
  const retract = () => {
    if (id === null) return
    const why = prompt("Reason for retracting (optional):")
    void doAction(api.retract, { id, reason: why ? why.trim() : undefined })
  }
  const pin = () => id !== null && void doAction(api.pin, id)
  const unpin = () => id !== null && void doAction(api.unpin, id)
  const restore = (rev: Revision) =>
    id !== null && void doAction(api.restore, { id, revisionId: rev.id })

  /* ---------- derived ---------- */
  const count = createMemo(() => notes().length)
  const revs = createMemo(() => detail()?.revisions ?? [])

  /* ---------- render helpers ---------- */
  const trustBadges = (n: Note) => (
    <span class="badges">
      <Show when={n.pinned}>
        <span class="badge pinned">📌 pinned</span>
      </Show>
      <Show when={n.retractedAt !== undefined}>
        <span class="badge retracted">🚫 retracted</span>
      </Show>
      <Show when={n.disputedAt !== undefined}>
        <span class="badge disputed">
          ⚠ disputed{n.statusReason ?? ""}
        </span>
      </Show>
      <Show when={n.verifiedAt !== undefined && n.retractedAt === undefined}>
        <span class="badge verified">✔ verified</span>
      </Show>
    </span>
  )

  const card = (n: Note) => (
    <section
      class={`note ${n.pinned ? "pinned" : ""} ${
        n.retractedAt !== undefined ? "retracted" : ""
      } ${selectedId() === n.id ? "selected" : ""}`}
    >
      <button class="note-head" onClick={() => toggleNote(n.id)}>
        <span class="note-id">#{n.id}</span>
        <span class="note-cat">({n.category})</span>
        <span class="note-title">{n.title}</span>
        {trustBadges(n)}
        <span class="chevron">▸</span>
      </button>
      <Show when={selectedId() === n.id}>
        <div class="note-body">
          <div class="meta">
            <span>{n.timestamp}</span>
            <Show when={n.author}>
              <span>by {n.author}</span>
            </Show>
            <Show when={n.tags}>
              <span>· {n.tags}</span>
            </Show>
          </div>
          <pre class="note-content">{n.content}</pre>
          <div class="actions">
            <button class="btn" onClick={() => openEdit(n)}>✏ Edit</button>
            <button class="btn" onClick={confirm}>✔ Confirm</button>
            <button class="btn" onClick={dispute}>⚠ Dispute</button>
            <button class="btn" onClick={retract}>🗑 Retract</button>
            <button class="btn" onClick={pin}>📌 Pin</button>
            <button class="btn" onClick={unpin}>📎 Unpin</button>
          </div>
          <div class="revisions">
            <button class="btn" onClick={() => setRevisionsOpen(!revisionsOpen())}>
              {"Revisions"}{revs().length > 0 ? ` (${revs().length})` : ""}
            </button>
            <Show when={revisionsOpen()}>
              <div class="rev-list">
                <Show when={revs().length === 0}>
                  <div class="muted">No previous versions.</div>
                </Show>
                {revs().map((r) => (
                  <div class="rev">
                    <div>
                      <b>rev #{r.id}</b> — {r.revisedAt} (valia desde {r.timestamp})
                    </div>
                    <pre class="note-content small">{r.content}</pre>
                    <button class="btn small" onClick={() => restore(r)}>
                      ↩ Restore
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
        .notes-root { font-size: 13px; line-height: 1.45; padding: 8px; display: flex; flex-direction: column; gap: 10px; height: 100%; }
        .notes-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .notes-title { font-weight: 600; }
        .notes-count { opacity: .6; font-size: 12px; }
        .btn { background: transparent; border: 1px solid currentColor; border-radius: 6px; padding: 4px 8px; font: inherit; color: inherit; cursor: pointer; opacity: .85; }
        .btn:hover { opacity: 1; }
        .btn:disabled { opacity: .4; cursor: default; }
        .btn.small { padding: 2px 6px; font-size: 11px; }
        .search-row { display: flex; gap: 8px; align-items: center; }
        .search-box { flex: 1; border: 1px solid currentColor; border-radius: 6px; background: transparent; color: inherit; font: inherit; padding: 4px 8px; }
        .chips { display: flex; gap: 6px; flex-wrap: wrap; }
        .chip { border: 1px solid currentColor; border-radius: 18px; padding: 2px 10px; background: transparent; color: inherit; font: inherit; cursor: pointer; opacity: .7; }
        .chip.active { opacity: 1; font-weight: 600; }
        .notes { display: flex; flex-direction: column; gap: 6px; overflow-y: auto; flex: 1; min-height: 0; }
        .note { border: 1px solid currentColor; border-radius: 8px; background: transparent; overflow: hidden; }
        .note.retracted { opacity: .5; }
        .note.selected { box-shadow: inset 0 0 0 2px currentColor; }
        .note-head { display: flex; align-items: baseline; gap: 6px; width: 100%; text-align: left; background: transparent; border: none; font: inherit; color: inherit; cursor: pointer; padding: 8px 10px; }
        .note-head:hover { background: rgba(128,128,128,.08); }
        .note-id { opacity: .7; font-weight: 600; }
        .note-cat { opacity: .55; font-size: 11px; }
        .note-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .badges { display: flex; gap: 4px; }
        .badge { font-size: 10px; border: 1px solid currentColor; border-radius: 999px; padding: 0 6px; opacity: .8; }
        .chevron { opacity: .6; }
        .note-body { padding: 6px 10px; border-top: 1px solid currentColor; }
        .meta { font-size: 11px; opacity: .65; display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
        .note-content { margin: 0; white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 12px; max-height: 320px; overflow-y: auto; }
        .note-content.small { max-height: 160px; font-size: 11px; }
        .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
        .actions .btn { opacity: .8; }
        .revisions { margin-top: 8px; }
        .rev-list { margin-top: 6px; display: flex; flex-direction: column; gap: 8px; }
        .rev { border: 1px solid currentColor; border-radius: 6px; padding: 6px 8px; }
        .rev b { font-size: 11px; }
        .muted { opacity: .5; font-size: 11px; }
        .err { border: 1px solid currentColor; border-radius: 6px; padding: 6px 8px; font-size: 12px; opacity: .9; }
        .empty { opacity: .5; text-align: center; padding: 20px; }
        .form { border: 1px solid currentColor; border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
        .form label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; opacity: .8; }
        .form input, .form select, .form textarea { border: 1px solid currentColor; border-radius: 6px; background: transparent; color: inherit; font: inherit; padding: 4px 6px; }
        .form textarea { resize: vertical; min-height: 90px; }
        .loading { opacity: .5; font-size: 12px; }
      `}</style>

      <header class="notes-head">
        <span class="notes-title">📚 Notes</span>
        <span class="notes-count">{count()}</span>
        <span style={{ flex: 1 }} />
        <button class="btn" onClick={openAdd}>+ New note</button>
      </header>

      <div class="search-row">
        <input
          class="search-box"
          placeholder="Search memory…"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === "Escape") setQuery("")
          }}
        />
      </div>

      <div class="chips">
        <button class={`chip ${!pinnedOnly() ? "active" : ""}`} onClick={() => setPinnedOnly(false)}>
          All
        </button>
        <button class={`chip ${pinnedOnly() ? "active" : ""}`} onClick={() => setPinnedOnly(!pinnedOnly())}>
          Pinned
        </button>
        <button class={`chip ${showRetracted() ? "active" : ""}`} onClick={() => setShowRetracted(!showRetracted())}>
          Retracted
        </button>
      </div>

      <Show when={loading()}>
        <div class="loading">loading…</div>
      </Show>
      <Show when={error() !== ""}>
        <div class="err">{error()}</div>
      </Show>

      <Show when={formOpen()}>
        <form
          class="form"
          onSubmit={(e) => { e.preventDefault(); void handleAddOrEdit() }}
        >
          <label>
            Category
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
            Title
            <input
              value={form().title}
              onInput={(e) => setForm((s) => ({ ...s, title: e.currentTarget.value }))}
            />
          </label>
          <label>
            Content
            <textarea
              value={form().content}
              onInput={(e) => setForm((s) => ({ ...s, content: e.currentTarget.value }))}
            />
          </label>
          <label>
            Tags
            <input
              value={form().tags}
              placeholder="space-separated keywords"
              onInput={(e) => setForm((s) => ({ ...s, tags: e.currentTarget.value }))}
            />
          </label>
          <label>
            Author
            <input
              value={form().author}
              placeholder="who registered this (optional)"
              onInput={(e) => setForm((s) => ({ ...s, author: e.currentTarget.value }))}
            />
          </label>
          <div class="form-actions">
            <button class="btn" onClick={() => setFormOpen(false)}>
              Cancel
            </button>
            <button
              class="btn"
              type="submit"
              disabled={!form().title.trim() || !form().content.trim()}
            >
              {form().mode === "add" ? "Add note" : "Save changes"}
            </button>
          </div>
        </form>
      </Show>

      <div class="notes">
        <Show when={notes().length === 0 && !loading()}>
          <div class="empty">
            No notes{query().trim() ? ` matching “${query()}”` : ""} yet.
          </div>
        </Show>
        {notes().map((n) => card(n))}
      </div>
    </div>
  )
}
