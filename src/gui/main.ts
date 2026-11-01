/**
 * Notes GUI — main-process data layer.
 *
 * Reads:  direct, read-only access to `notes.db` via the `node:sqlite` builtin,
 *         replicating the CLI's SQL (list/view/detail + FTS search with a LIKE
 *         fallback). Fast, structured, and always up to date with the file.
 * Writes: spawn the `notes` CLI (so the #problem guardrail, FTS reindex and
 *         migrations live in exactly one place). After a successful write the
 *         note is re-read from the DB.
 *
 * The whole thing degrades gracefully: if `node:sqlite` is unavailable on the
 * desktop main process, reads fall back to the CLI.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { existsSync } from "node:fs"
import { spawn } from "node:child_process"
import type { MainContext } from "@opencode/plugin/gui/main"
import { NotesApi } from "./contract"
import type {
  AddInput,
  DisputeInput,
  Driver,
  ListOptions,
  Note,
  NoteDetail,
  NoteResult,
  RetractInput,
  RestoreInput,
  SearchInput,
  Status,
  UpdateInput,
} from "./contract"

/* ------------------------------------------------------------------ */
/* DB path — mirrors memory/notes.py::db_path()                         */
/* ------------------------------------------------------------------ */

function expanduser(p: string): string {
  return p.startsWith("~") ? p.replace("~", homedir()) : p
}

function notesDbPath(): string {
  const override = process.env.NOTES_DB
  if (override) return expanduser(override)
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(dataHome, "opencode", "memory", "notes.db")
}

/* ------------------------------------------------------------------ */
/* Read-only node:sqlite (dynamic import: a missing builtin must not     */
/* crash the whole main entry).                                         */
/* ------------------------------------------------------------------ */

type Db = {
  prepare(sql: string): DbStatement
}

type DbStatement = {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

let dbPromise: Promise<Db | null> | null = null

function openDb(): Promise<Db | null> {
  if (dbPromise === null) {
    dbPromise = (async () => {
      try {
        const mod = await import("node:sqlite")
        // Node 24 exposes `DatabaseSync`; older/preview builds used `Database`.
        const Database =
          (mod as any).DatabaseSync ??
          (mod as any).Database ??
          (mod as any).default?.DatabaseSync ??
          (mod as any).default?.Database
        if (typeof Database === "undefined") return null
        const d: Db = new (Database as any)(notesDbPath(), { readOnly: true })
        d.prepare("SELECT 1").get()
        return d
      } catch {
        return null
      }
    })()
  }
  return dbPromise
}

const hasFts = (d: Db): boolean => {
  try {
    const rows = d.prepare(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'notes_fts'"
    ).all()
    return ((rows[0] as { c?: number })?.c ?? 0) > 0
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* Row mapping (DB snake_case -> IPC camelCase)                         */
/* ------------------------------------------------------------------ */

type NoteRow = {
  id: number
  timestamp: string
  category: string
  tags: string | null
  title: string
  content: string
  author: string | null
  verified_at: string | null
  disputed_at: string | null
  retracted_at: string | null
  status_reason: string | null
  pinned: number | boolean
}

type RevisionRow = {
  id: number
  revised_at: string
  timestamp: string
  category: string
  tags: string | null
  title: string
  content: string
}

const columns = (prefix: string): string =>
  [
    "id",
    "timestamp",
    "category",
    "tags",
    "title",
    "content",
    "author",
    "verified_at",
    "disputed_at",
    "retracted_at",
    "status_reason",
    "pinned",
  ].map((f) => (prefix ? `${prefix}.${f}` : f)).join(", ")

const toNote = (r: NoteRow): Note => ({
  id: r.id,
  timestamp: r.timestamp,
  category: r.category,
  title: r.title,
  content: r.content,
  tags: r.tags ?? undefined,
  author: r.author ?? undefined,
  verifiedAt: r.verified_at ?? undefined,
  disputedAt: r.disputed_at ?? undefined,
  retractedAt: r.retracted_at ?? undefined,
  statusReason: r.status_reason ?? undefined,
  pinned: r.pinned === 1 || r.pinned === true,
})

const toRevision = (r: RevisionRow): NoteDetail["revisions"][number] => ({
  id: r.id,
  revisedAt: r.revised_at,
  timestamp: r.timestamp,
  category: r.category,
  tags: r.tags ?? undefined,
  title: r.title,
  content: r.content,
})

/* ------------------------------------------------------------------ */
/* Read-only SQL helpers (mirror memory/notes.py)                       */
/* ------------------------------------------------------------------ */

const listNotes = (d: Db, opts: ListOptions): Note[] => {
  const limit = opts.limit ?? 50
  const sql = `SELECT ${columns("")} FROM notes${
    opts.all ? "" : " WHERE retracted_at IS NULL"
  } ORDER BY (disputed_at IS NOT NULL), timestamp DESC LIMIT ?`
  return (d.prepare(sql).all(limit) as NoteRow[]).map(toNote)
}

const viewNote = (d: Db, id: number): Note | undefined => {
  const row = d
    .prepare(`SELECT ${columns("")} FROM notes WHERE id = ?`)
    .get(id) as NoteRow | null
  return row ? toNote(row) : undefined
}

const detailNote = (d: Db, id: number): NoteDetail | undefined => {
  const row = d
    .prepare(`SELECT ${columns("")} FROM notes WHERE id = ?`)
    .get(id) as NoteRow | null
  if (row === undefined || row === null) return undefined
  const revisions = (
    d.prepare(
      "SELECT id, revised_at, timestamp, category, tags, title, content " +
        "FROM note_revisions WHERE note_id = ? ORDER BY id DESC"
    ).all(id) as RevisionRow[]
  ).map(toRevision)
  return { note: toNote(row), revisions }
}

const quoteWord = (w: string): string => `"${w.replace(/"/g, '""')}"`

const searchNotes = (d: Db, query: string, opts: SearchInput): Note[] => {
  const limit = opts.limit ?? 20
  const all = opts.all ?? false
  const words = query.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return listNotes(d, { limit, all })
  const fts = hasFts(d)

  if (fts) {
    for (const joiner of ["AND", "OR"]) {
      const match = words.map(quoteWord).join(` ${joiner} `.trim())
      const sql =
        `SELECT ${columns("n")} FROM notes n JOIN notes_fts f ON n.id = f.rowid ` +
        `WHERE notes_fts MATCH ?${all ? "" : " AND n.retracted_at IS NULL"} ` +
        `ORDER BY (n.disputed_at IS NOT NULL), bm25(notes_fts), n.timestamp DESC LIMIT ?`
      try {
        const rows = d.prepare(sql).all(match, limit)
        if (Array.isArray(rows) && rows.length > 0) return (rows as NoteRow[]).map(toNote)
        if (!Array.isArray(rows)) break
      } catch {
        break
      }
    }
  }

  const likeGroups: string[] = []
  const likeParams: unknown[] = []
  for (const w of words) {
    likeGroups.push("(title LIKE ? OR content LIKE ? OR tags LIKE ? OR category LIKE ?)")
    const like = `%${w}%`
    likeParams.push(like, like, like, like)
  }
  for (const joiner of ["AND", "OR"]) {
    const sql =
      `SELECT ${columns("")} FROM notes WHERE (${likeGroups.join(joiner)})${
        all ? "" : " AND retracted_at IS NULL"
      } ORDER BY (disputed_at IS NOT NULL), timestamp DESC LIMIT ?`
    const rows = d.prepare(sql).all([...likeParams, limit])
    if (Array.isArray(rows) && rows.length > 0) return (rows as NoteRow[]).map(toNote)
  }
  return []
}

/* ------------------------------------------------------------------ */
/* CLI (writes). argv array, no shell, so note content is never parsed. */
/* ------------------------------------------------------------------ */

type Run = { code: number; stdout: string; stderr: string }

function nbCommand(): string {
  if (process.env.NOTES_BIN) return process.env.NOTES_BIN
  const local = join(homedir(), ".local", "bin", "notes")
  return existsSync(local) ? local : "notes"
}

function runCli(args: string[], timeoutMs = 15000): Promise<Run> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (run: Run) => {
      if (settled) return
      settled = true
      resolve(run)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(nbCommand(), args, { stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs })
    } catch (err) {
      finish({
        code: 127,
        stdout: "",
        stderr: `could not run '${nbCommand()}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      })
      return
    }
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (c: Buffer) => (stdout += String(c)))
    child.stderr?.on("data", (c: Buffer) => (stderr += String(c)))
    child.on("error", (err) => {
      stderr += `\n${err instanceof Error ? err.message : String(err)}`
      // A spawn failure (e.g. ENOENT) may never emit `close`; settle so the
      // IPC call cannot hang the panel.
      finish({ code: 127, stdout, stderr })
    })
    child.on("close", (code) => finish({ code: code ?? -1, stdout, stderr }))
  })
}

function toError(run: Run): NoteResult {
  const body =
    [run.stdout?.trim(), run.stderr?.trim()].filter(Boolean).join("\n") || `exit ${run.code}`
  return { ok: false, error: body }
}

const readAfterWrite = async (id: number): Promise<NoteResult> => {
  const d = await openDb()
  const note = d ? viewNote(d, id) : undefined
  return { ok: true, note }
}

/* ------------------------------------------------------------------ */
/* IPC provider                                                        */
/* ------------------------------------------------------------------ */

export function main(ctx: MainContext): void {
  ctx.provide(NotesApi, {
    status: async (): Promise<Status> => {
      const d = await openDb()
      return {
        driver: (d ? "sqlite" : "cli") as Driver,
        hasFts: d ? hasFts(d) : true,
        dbPath: notesDbPath(),
      }
    },

    list: async (opts: ListOptions): Promise<Note[]> => {
      const d = await openDb()
      if (d) return listNotes(d, opts)
      return fallbackList(opts.limit ?? 50, opts.all ?? false)
    },

    view: async (id: number): Promise<Note | undefined> => {
      const d = await openDb()
      return d ? viewNote(d, id) : fallbackView(id)
    },

    detail: async (id: number): Promise<NoteDetail | undefined> => {
      const d = await openDb()
      return d ? detailNote(d, id) : fallbackDetail(id)
    },

    search: async (input: SearchInput): Promise<Note[]> => {
      const d = await openDb()
      if (d) return searchNotes(d, input.query, input)
      return fallbackSearch(input.query, input.limit ?? 20, input.all ?? false)
    },

    add: async (input: AddInput): Promise<NoteResult> => {
      const argv = ["add", `#${input.category}`, input.title, input.tags ?? "", input.content]
      if (input.author) argv.push("--author", input.author)
      const run = await runCli(argv)
      if (run.code !== 0) return toError(run)
      const d = await openDb()
      if (d === null) return { ok: true, note: undefined }
      const line = run.stdout.split("\n").find((l) => l.includes("salva"))
      const idM = line ? line.match(/#(\d+)/) : null
      const note = idM ? viewNote(d, Number(idM[1])) : undefined
      return { ok: true, note }
    },

    update: async (input: UpdateInput): Promise<NoteResult> => {
      const argv = ["update", String(input.id)]
      if (input.title !== undefined) argv.push("--title", input.title)
      if (input.tags !== undefined) argv.push("--tags", input.tags)
      if (input.content !== undefined) argv.push("--content", input.content)
      if (input.category !== undefined) argv.push("--category", `#${input.category}`)
      const run = await runCli(argv)
      if (run.code !== 0) return toError(run)
      return readAfterWrite(input.id)
    },

    confirm: async (id: number): Promise<NoteResult> => {
      const run = await runCli(["confirm", String(id)])
      if (run.code !== 0) return toError(run)
      return readAfterWrite(id)
    },

    dispute: async (input: DisputeInput): Promise<NoteResult> => {
      const run = await runCli(["dispute", String(input.id), "--why", input.reason])
      if (run.code !== 0) return toError(run)
      return readAfterWrite(input.id)
    },

    retract: async (input: RetractInput): Promise<NoteResult> => {
      const argv = ["retract", String(input.id)]
      if (input.reason) argv.push("--why", input.reason)
      const run = await runCli(argv)
      if (run.code !== 0) return toError(run)
      return readAfterWrite(input.id)
    },

    pin: async (id: number): Promise<NoteResult> => {
      const run = await runCli(["pin", String(id)])
      if (run.code !== 0) return toError(run)
      return readAfterWrite(id)
    },

    unpin: async (id: number): Promise<NoteResult> => {
      const run = await runCli(["unpin", String(id)])
      if (run.code !== 0) return toError(run)
      return readAfterWrite(id)
    },

    restore: async (input: RestoreInput): Promise<NoteResult> => {
      const run = await runCli(["restore", String(input.id), String(input.revisionId)])
      if (run.code !== 0) return toError(run)
      return readAfterWrite(input.id)
    },
  })
}

/* ------------------------------------------------------------------ */
/* CLI-only read fallbacks (reached only when node:sqlite is missing)   */
/* ------------------------------------------------------------------ */

const fallbackList = async (limit: number, all: boolean): Promise<Note[]> => {
  const argv = ["list", String(limit)]
  if (all) argv.push("--all")
  const run = await runCli(argv)
  const ids = parseIds(run.stdout)
  const d = await openDb()
  if (d) return ids.map((id) => viewNote(d, id)).filter(Boolean) as Note[]
  const out: Note[] = []
  for (const id of ids) {
    const note = await fallbackView(id)
    if (note) out.push(note)
  }
  return out
}

const fallbackView = async (id: number): Promise<Note | undefined> => {
  const d = await openDb()
  return d ? viewNote(d, id) : undefined
}

const fallbackDetail = async (id: number): Promise<NoteDetail | undefined> => {
  const note = await fallbackView(id)
  if (note === undefined) return undefined
  const d = await openDb()
  if (d) return detailNote(d, id)
  return { note, revisions: [] }
}

const fallbackSearch = async (
  query: string,
  limit: number,
  all: boolean
): Promise<Note[]> => {
  const argv = ["search", query, String(limit)]
  if (all) argv.push("--all")
  const run = await runCli(argv)
  const ids = parseIds(run.stdout)
  const d = await openDb()
  if (d) return ids.map((id) => viewNote(d, id)).filter(Boolean) as Note[]
  const out: Note[] = []
  for (const id of ids) {
    const note = await fallbackView(id)
    if (note) out.push(note)
  }
  return out
}

/** Extract "#NN" ids from a CLI block of output. */
function parseIds(text: string): number[] {
  const out: number[] = []
  // `String.prototype.match` with a global regex never advances `lastIndex`,
  // so a `while (text.match(re))` loop would spin forever. `matchAll` is
  // anchored to the input and yields every match once.
  for (const m of text.matchAll(/#\s*(\d+)/g)) {
    const id = Number(m[1])
    if (id > 0 && !out.includes(id)) out.push(id)
  }
  return out
}
