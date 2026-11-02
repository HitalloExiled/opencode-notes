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
import { Show } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import { NotesApi } from "./contract"
import type { Note, NoteDetail, NoteResult, Revision } from "./contract"

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
}

const defaultForm: FormState = {
  mode: "add",
  category: "problem",
  title: "",
  content: "",
  tags: "",
  author: "",
}

const PAGE_SIZE = 25

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
  const [saving, setSaving] = createSignal(false)
  const [formOpen, setFormOpen] = createSignal(false)
  const [form, setForm] = createSignal(defaultForm)
  const [notes, setNotes] = createSignal<Note[]>([])
  const [page, setPage] = createSignal(0)

  const locale = () => ctx.locale.locale()

  /* ---------- loading ---------- */
  const loadNotes = async () => {
    const q = query().trim()
    const pinned = pinnedOnly()
    const all = showRetracted()
    setLoading(true)
    setError("")
    try {
      const res = q
        ? await api.search({ query: q, all })
        : await api.list({ all, limit: 500 })
      let out = res as unknown as Note[]
      if (pinned) out = out.filter((n) => n.pinned)
      setNotes(out)
      // Keep the current page valid after a write or a filter change.
      const maxPage = Math.max(0, Math.ceil(out.length / PAGE_SIZE) - 1)
      if (page() > maxPage) setPage(maxPage)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  // Re-runs when query / filters change (those signals are read inside loadNotes).
  createEffect(() => {
    // A new query or filter always starts at the first page.
    setPage(0)
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
    fn: (a: any) => Promise<NoteResult>,
    arg: any
  ): Promise<void> => {
    try {
      const res = await fn(arg)
      if (res.ok) {
        setSelectedId(null)
      } else {
        setError(res.error ?? "ação falhou")
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
      setError("Título e conteúdo são obrigatórios.")
      return
    }
    setSaving(true)
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
    })
    setFormOpen(true)
  }

  const id = selectedId()
  const confirm = () => id !== null && void doAction(api.confirm, id)
  const dispute = async () => {
    if (id === null) return
    const why = await ctx.dialogs.prompt({
      title: "Questionar nota",
      description: "Descreva por que a nota parece incorreta.",
      placeholder: "ex.: desatualizada, contradiz a nota #123",
      submit: "Questionar",
    })
    if (why && why.trim()) void doAction(api.dispute, { id, reason: why.trim() })
  }
  const retract = async () => {
    if (id === null) return
    const why = await ctx.dialogs.prompt({
      title: "Retirar nota",
      description: "A nota passa a ser desconsiderada; pode ser restaurada depois.",
      placeholder: "motivo (opcional)",
      submit: "Retirar",
    })
    void doAction(api.retract, { id, reason: why ? why.trim() : undefined })
  }
  const pin = () => id !== null && void doAction(api.pin, id)
  const unpin = () => id !== null && void doAction(api.unpin, id)
  const restore = async (rev: Revision) => {
    if (id === null) return
    const ok = await ctx.dialogs.confirm({
      title: "Restaurar revisão",
      description: `A nota será restaurada para a revisão #${rev.id}. A versão atual passa a ser uma revisão anterior.`,
      confirm: "Restaurar",
      danger: true,
    })
    if (ok) void doAction(api.restore, { id, revisionId: rev.id })
  }

  /* ---------- derived ---------- */
  const count = createMemo(() => notes().length)
  const pageCount = createMemo(() => Math.max(1, Math.ceil(notes().length / PAGE_SIZE)))
  const pagedNotes = createMemo(() => {
    const start = page() * PAGE_SIZE
    return notes().slice(start, start + PAGE_SIZE)
  })
  const revs = createMemo(() => detail()?.revisions ?? [])

  const formatTime = (s: string) => {
    const d = new Date(s)
    if (Number.isNaN(d.getTime())) return s
    return new Intl.DateTimeFormat(locale(), { dateStyle: "short", timeStyle: "short" }).format(d)
  }

  /* ---------- render helpers ---------- */
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
      <Show when={n.verifiedAt !== undefined && n.retractedAt === undefined}>
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
      <button class="note-head" onClick={() => toggleNote(n.id)}>
        <span class="note-id">#{n.id}</span>
        <span class="note-cat">{String(n.category).replace(/^#/, "")}</span>
        <span class="note-title" title={n.title}>
          {n.title}
        </span>
        {trustBadges(n)}
        <ctx.ui.Icon name="chevron-right" size="small" class="chevron" />
      </button>
      <Show when={selectedId() === n.id}>
        <div class="note-body">
          <div class="meta">
            <span>{formatTime(n.timestamp)}</span>
            <Show when={n.author}>
              <span>por {n.author}</span>
            </Show>
            <Show when={n.tags}>
              <span>· {n.tags}</span>
            </Show>
          </div>
          <pre class="note-content">{n.content}</pre>
          <div class="actions">
            <ctx.ui.Button size="small" icon="edit" onClick={() => openEdit(n)}>
              Editar
            </ctx.ui.Button>
            <ctx.ui.Button size="small" icon="circle-check" onClick={confirm}>
              Confirmar
            </ctx.ui.Button>
            <ctx.ui.Button size="small" icon="outline-hexagonal-warning" onClick={dispute}>
              Questionar
            </ctx.ui.Button>
            <ctx.ui.Button size="small" variant="danger" icon="trash" onClick={retract}>
              Retirar
            </ctx.ui.Button>
            <ctx.ui.Button size="small" onClick={pin}>
              {n.pinned ? "Desfixar" : "Fixar"}
            </ctx.ui.Button>
          </div>
          <div class="revisions">
            <ctx.ui.Button size="small" variant="ghost-muted" icon="outline-rotate-clockwise" onClick={() => setRevisionsOpen(!revisionsOpen())}>
              Revisões{revs().length > 0 ? ` · ${revs().length}` : ""}
            </ctx.ui.Button>
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
                    <ctx.ui.Button
                      size="small"
                      variant="ghost-muted"
                      icon="arrow-undo-down"
                      onClick={() => restore(r)}
                    >
                      Restaurar
                    </ctx.ui.Button>
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
        .note-head {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          text-align: left;
          background: transparent;
          border: 0;
          font: inherit;
          color: inherit;
          cursor: pointer;
          box-sizing: border-box;
          min-height: 32px;
          padding: 5px 12px;
        }
        .note-head:hover { background: var(--v2-overlay-simple-overlay-hover); }
        .note-head:focus-visible { outline: 2px solid var(--v2-border-border-focus); outline-offset: -2px; }
        .note-id { font-weight: 550; color: var(--v2-text-text-muted); }
        .note-cat { font-size: 11px; color: var(--v2-text-text-faint); }
        .note-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .badges { display: flex; gap: 4px; flex: 0 0 auto; }
        .badge { font-size: 11px; line-height: 1.4; border-radius: 999px; padding: 0 7px; }
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
          background: transparent;
          color: var(--v2-text-text-base);
          font: inherit;
          padding: 4px 6px;
        }
        .form textarea:focus,
        .form select:focus {
          outline: 2px solid var(--v2-border-border-focus);
          outline-offset: 0;
          background: transparent;
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
        <Show when={notes().length === 0 && !loading()}>
          <div class="empty">
            <ctx.ui.Icon name="file-document" size="large" class="empty-icon" />
            <div>
              <Show when={query().trim()}>
                Nenhuma nota corresponde a "{query().trim()}".
              </Show>
              <Show when={!query().trim()}>
                Nenhuma nota ainda.
              </Show>
            </div>
            <div class="muted">
              <Show when={query().trim()}>
                Ajuste a busca ou os filtros.
              </Show>
              <Show when={!query().trim()}>
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
