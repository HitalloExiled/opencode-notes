/**
 * Notes store — the single data layer behind both the GUI panel and the
 * `notes.*` server tools.
 *
 * It reads AND writes `notes.db` directly (no external CLI): the schema, FTS5
 * index and migrations are applied on first open (idempotent, gated by
 * `PRAGMA user_version`), and every mutation is plain SQL. The FTS index is
 * external-content (`content='notes'`) and kept in sync by triggers on
 * `notes`, so writes re-index automatically.
 *
 * SQLite access goes through the runtime's built-in `node:sqlite`
 * (`DatabaseSync`): in-process, synchronous and FTS5-enabled. Bun, the
 * Electron main process and plain Node all ship it, so there is a single
 * backend everywhere — no CLI, no subprocess and no native addon.
 */

import { mkdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/* ------------------------------------------------------------------ */
/* DB path                                                             */
/* ------------------------------------------------------------------ */

function expanduser(p: string): string {
  return p.startsWith("~") ? p.replace("~", homedir()) : p
}

export function notesDbPath(): string {
  const override = process.env.NOTES_DB
  if (override) return expanduser(override)
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(dataHome, "opencode", "memory", "notes.db")
}

/* ------------------------------------------------------------------ */
/* Minimal synchronous DB interface (node:sqlite / bun:sqlite shaped)   */
/* ------------------------------------------------------------------ */

export type DbStatement = {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): { changes: number; lastInsertRowid: number }
}

export type Db = {
  prepare(sql: string): DbStatement
  close?(): void
}

/* ------------------------------------------------------------------ */
/* Backend: native node:sqlite (DatabaseSync)                          */
/* ------------------------------------------------------------------ */

type NativeStatement = {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
}

type NativeDatabase = {
  prepare(sql: string): NativeStatement
  exec(sql: string): void
  close(): void
}

type NativeModule = {
  DatabaseSync?: new (path: string, options?: { timeout?: number }) => NativeDatabase
  default?: { DatabaseSync?: new (path: string, options?: { timeout?: number }) => NativeDatabase }
}

/**
 * Open the database through the runtime's built-in `node:sqlite`.
 *
 * `node:sqlite` is synchronous and in-process, and Bun, the Electron main
 * process and plain Node all expose it, so the GUI and the tools share one
 * implementation. `timeout` makes concurrent access wait instead of failing
 * with `SQLITE_BUSY`.
 */
async function nativeDb(path: string): Promise<Db> {
  const mod = (await import("node:sqlite")) as NativeModule
  const Database = mod.DatabaseSync ?? mod.default?.DatabaseSync
  if (typeof Database !== "function") {
    throw new Error("node:sqlite não expõe DatabaseSync")
  }

  const db = new Database(path, { timeout: 5000 })

  return {
    prepare(sql: string) {
      const statement = db.prepare(sql)
      return {
        get(...params: unknown[]) {
          return statement.get(...params) ?? undefined
        },
        all(...params: unknown[]) {
          return statement.all(...params)
        },
        run(...params: unknown[]) {
          const r = statement.run(...params)
          return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
        },
      } satisfies DbStatement
    },
    close() {
      db.close()
    },
  }
}

/* ------------------------------------------------------------------ */
/* Schema DDL (embedded; all idempotent via IF NOT EXISTS)             */
/* ------------------------------------------------------------------ */

const BASE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    category TEXT NOT NULL,
    tags TEXT,
    title TEXT NOT NULL,
    content TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_timestamp ON notes(timestamp DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_category ON notes(category)`,
]

const MIGRATION_002 = [
  `ALTER TABLE notes ADD COLUMN verified_at TEXT`,
  `ALTER TABLE notes ADD COLUMN disputed_at TEXT`,
  `ALTER TABLE notes ADD COLUMN retracted_at TEXT`,
  `ALTER TABLE notes ADD COLUMN status_reason TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_notes_disputed ON notes(disputed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_notes_retracted ON notes(retracted_at)`,
]

const MIGRATION_003 = [
  `CREATE TABLE IF NOT EXISTS note_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL,
    revised_at TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    category TEXT NOT NULL,
    tags TEXT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    verified_at TEXT,
    disputed_at TEXT,
    retracted_at TEXT,
    status_reason TEXT
)`,
  `CREATE INDEX IF NOT EXISTS idx_revisions_note ON note_revisions(note_id, id DESC)`,
]

const MIGRATION_004 = [`ALTER TABLE notes ADD COLUMN author TEXT`]

const MIGRATION_005 = [
  `ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS idx_notes_pinned ON notes(pinned, timestamp DESC)`,
]

// Scope moved out of the body convention into its own column. The backfill
// below lifts existing `Scope: …` lines into the column and strips them from
// the body, so there is a single source of truth going forward.
const MIGRATION_006 = [
  `ALTER TABLE notes ADD COLUMN scope TEXT`,
  `ALTER TABLE note_revisions ADD COLUMN scope TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_notes_scope ON notes(scope)`,
]

// Legacy `#` prefix on categories (e.g. "#problem") is dropped: categories are
// plain tokens going forward (see normalizeCategory). Runs once on upgrade and
// strips the prefix from existing rows in both tables; the notes FTS index
// follows through its AFTER UPDATE trigger.
const MIGRATION_007 = [
  `UPDATE notes SET category = substr(category, 2) WHERE category LIKE '#%'`,
  `UPDATE note_revisions SET category = substr(category, 2) WHERE category LIKE '#%'`,
]

const FTS_SCHEMA = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title, content, tags, category,
    content='notes', content_rowid='id'
)`,
  `CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, content, tags, category)
    VALUES (new.id, new.title, new.content, new.tags, new.category);
  END`,
  `CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content, tags, category)
    VALUES ('delete', old.id, old.title, old.content, old.tags, old.category);
  END`,
  `CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content, tags, category)
    VALUES ('delete', old.id, old.title, old.content, old.tags, old.category);
    INSERT INTO notes_fts(rowid, title, content, tags, category)
    VALUES (new.id, new.title, new.content, new.tags, new.category);
  END`,
]

export const SCHEMA_VERSION = 7

/* ------------------------------------------------------------------ */
/* Schema init / migrations                                            */
/* ------------------------------------------------------------------ */

function ftsSupported(db: Db): boolean {
  try {
    db.prepare("CREATE VIRTUAL TABLE IF NOT EXISTS __fts_probe USING fts5(x)").run()
    db.prepare("DROP TABLE IF EXISTS __fts_probe").run()
    return true
  } catch {
    return false
  }
}

function apply(db: Db, statements: readonly string[]): void {
  for (const sql of statements) db.prepare(sql).run()
}

/* ------------------------------------------------------------------ */
/* Scope                                                               */
/* ------------------------------------------------------------------ */

const SCOPE_LINE = /^\s*Scope:\s*(\S+)\s*$/

/** Normalizes a scope to a single token: `global`, `project:<name>`, `machine:<name>`. */
export function normalizeScope(value?: string | null): string | null {
  const token = (value ?? "").trim().split(/\s+/)[0] ?? ""
  return token || null
}

/** The scope declared in the body by the old convention, if any. */
export function scopeFromContent(content: string): string | null {
  const match = content.match(/^\s*Scope:\s*(\S+)/m)
  return match?.[1] ? normalizeScope(match[1]) : null
}

/** Removes the legacy `Scope: …` line from a body. */
export function stripScopeLine(content: string): string {
  return content
    .split("\n")
    .filter((line) => !SCOPE_LINE.test(line))
    .join("\n")
    .trimEnd()
}

/** Lifts the body convention into the new `scope` column, once. */
function backfillScopeColumn(db: Db): void {
  for (const table of ["notes", "note_revisions"] as const) {
    const rows = db
      .prepare(`SELECT id, content FROM ${table} WHERE scope IS NULL`)
      .all() as Array<{ id: number; content: string }>
    if (rows.length === 0) continue
    const update = db.prepare(`UPDATE ${table} SET scope = ?, content = ? WHERE id = ?`)
    for (const row of rows) {
      const scope = scopeFromContent(row.content)
      if (!scope) continue
      update.run(scope, stripScopeLine(row.content), row.id)
    }
  }
}

export function initSchema(db: Db): void {
  apply(db, BASE_SCHEMA)
  if (ftsSupported(db)) apply(db, FTS_SCHEMA)
  const row = db.prepare("PRAGMA user_version").get() as number | { user_version?: number } | null
  const raw = typeof row === "number" ? row : (row?.user_version ?? 0)
  const current = Math.max(raw, 1)
  if (current < 2) apply(db, MIGRATION_002)
  if (current < 3) apply(db, MIGRATION_003)
  if (current < 4) apply(db, MIGRATION_004)
  if (current < 5) apply(db, MIGRATION_005)
  if (current < 6) apply(db, MIGRATION_006)
  if (current < 7) apply(db, MIGRATION_007)
  // Unconditional: every note written before the column existed is lifted
  // from its legacy `Scope:` body line on first boot after the update.
  backfillScopeColumn(db)
  db.prepare(`PRAGMA user_version = ${SCHEMA_VERSION}`).run()
}

export function hasFts(db: Db): boolean {
  try {
    const rows = db
      .prepare(
        "SELECT COUNT(*) AS c FROM sqlite_master WHERE type IN ('table','view') AND name = 'notes_fts'"
      )
      .all()
    return ((rows[0] as { c?: number })?.c ?? 0) > 0
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* Connection (memoized)                                               */
/* ------------------------------------------------------------------ */

export type Store = { db: Db; fts: boolean; driver: "native" }

let storePromise: Promise<{ store: Store | null; reason: string }> | null = null

function openDbPath(): string {
  const path = notesDbPath()
  const parent = path.slice(0, path.lastIndexOf("/"))
  if (parent) mkdirSync(parent, { recursive: true })
  return path
}

function describeRuntime(): string {
  const g = globalThis as any
  const parts: string[] = []
  if (typeof process !== "undefined" && process.version) parts.push("node=" + process.version)
  if (typeof g.bun !== "undefined" && g.bun?.version) parts.push("bun=" + g.bun.version)
  return parts.length ? parts.join(" ") : "unknown"
}

async function openStore(): Promise<{ store: Store | null; reason: string }> {
  try {
    const db = await nativeDb(openDbPath())
    initSchema(db)
    return { store: { db, fts: hasFts(db), driver: "native" }, reason: "" }
  } catch (err) {
    return {
      store: null,
      reason:
        `sqlite indisponível (${describeRuntime()}; node:sqlite): ` +
        (err instanceof Error ? err.message : String(err)),
    }
  }
}

export function getStore(): Promise<{ store: Store | null; reason: string }> {
  if (storePromise === null) storePromise = openStore()
  return storePromise
}

export async function requireStore(): Promise<Store> {
  const { store, reason } = await getStore()
  if (store === null) throw new Error(reason)
  return store
}

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

export type NoteRow = {
  id: number
  timestamp: string
  category: string
  tags: string | null
  scope: string | null
  title: string
  content: string
  author: string | null
  verified_at: string | null
  disputed_at: string | null
  retracted_at: string | null
  status_reason: string | null
  pinned: number | boolean
}

export type RevisionRow = {
  id: number
  revised_at: string
  timestamp: string
  category: string
  tags: string | null
  scope: string | null
  title: string
  content: string
  verified_at: string | null
  disputed_at: string | null
  retracted_at: string | null
  status_reason: string | null
}

export const NOTE_FIELDS = [
  "id", "timestamp", "category", "tags", "scope", "title", "content",
  "author", "verified_at", "disputed_at", "retracted_at", "status_reason", "pinned",
] as const

export const noteColumns = (prefix?: string): string =>
  NOTE_FIELDS.map((f) => (prefix ? `${prefix}.${f}` : f)).join(", ")

const isPinned = (v: number | boolean): boolean => v === 1 || v === true

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function normalizeCategory(category: string): string {
  const token = category.trim().replace(/^#+/, "")
  return token ? token : "general"
}

export function nowTimestamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}

/** Sections required in a #problem note (accent/case insensitive). */
export function missingProblemSections(content: string): string[] {
  const text = content
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
  return ["Symptom", "Cause", "Solution"].filter((label) => !text.includes(label.toLowerCase()))
}

function noteExists(db: Db, id: number): boolean {
  return db.prepare("SELECT 1 FROM notes WHERE id = ?").get(id) != null
}

function loadNote(db: Db, id: number): NoteRow | null {
  return (db.prepare(`SELECT ${noteColumns()} FROM notes WHERE id = ?`).get(id) as NoteRow | null) ?? null
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export type ListOptions = { limit?: number | undefined; all?: boolean | undefined }

export function listNotes(db: Db, opts: ListOptions = {}): NoteRow[] {
  const limit = opts.limit ?? 50
  const sql = `SELECT ${noteColumns()} FROM notes${opts.all ? "" : " WHERE retracted_at IS NULL"}`
  const ordered = sql + " ORDER BY (disputed_at IS NOT NULL), timestamp DESC LIMIT ?"
  return db.prepare(ordered).all(limit) as NoteRow[]
}

export function viewNote(db: Db, id: number): NoteRow | undefined {
  return loadNote(db, id) ?? undefined
}

export type SearchOptions = { limit?: number | undefined; all?: boolean | undefined }

const quoteWord = (w: string): string => `"${w.replace(/"/g, '""')}"`

export function searchNotes(db: Db, query: string, opts: SearchOptions = {}): NoteRow[] {
  const limit = opts.limit ?? 20
  const all = opts.all ?? false
  const words = query.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return listNotes(db, { limit, all })

  if (hasFts(db)) {
    for (const joiner of ["AND", "OR"]) {
      const match = words.map(quoteWord).join(` ${joiner} `)
      const sql =
        `SELECT ${noteColumns("n")} FROM notes n JOIN notes_fts f ON n.id = f.rowid ` +
        `WHERE notes_fts MATCH ?${all ? "" : " AND n.retracted_at IS NULL"} ` +
        "ORDER BY (n.disputed_at IS NOT NULL), bm25(notes_fts), n.timestamp DESC LIMIT ?"
      try {
        const rows = db.prepare(sql).all(match, limit)
        if (Array.isArray(rows) && rows.length > 0) return rows as NoteRow[]
      } catch {
        break
      }
    }
  }

  const groups: string[] = []
  const params: unknown[] = []
  for (const w of words) {
    const like = `%${w}%`
    groups.push("(title LIKE ? OR content LIKE ? OR tags LIKE ? OR category LIKE ?)")
    params.push(like, like, like, like)
  }
  for (const joiner of ["AND", "OR"]) {
    const sql =
      `SELECT ${noteColumns()} FROM notes WHERE (${groups.join(` ${joiner} `)})` +
      `${all ? "" : " AND retracted_at IS NULL"}` +
      " ORDER BY (disputed_at IS NOT NULL), timestamp DESC LIMIT ?"
    const rows = db.prepare(sql).all(...params, limit)
    if (Array.isArray(rows) && rows.length > 0) return rows as NoteRow[]
  }
  return []
}

export type History = { note: NoteRow; revisions: RevisionRow[]; total: number }

export function noteHistory(db: Db, id: number, limit?: number): History | undefined {
  const note = loadNote(db, id)
  if (!note) return undefined
  let sql =
    "SELECT id, revised_at, timestamp, category, tags, scope, title, content," +
    " verified_at, disputed_at, retracted_at, status_reason" +
    " FROM note_revisions WHERE note_id = ? ORDER BY id DESC"
  const params: unknown[] = [id]
  if (limit) {
    sql += " LIMIT ?"
    params.push(limit)
  }
  const revisions = db.prepare(sql).all(...params) as RevisionRow[]
  const total = (db.prepare("SELECT COUNT(*) AS c FROM note_revisions WHERE note_id = ?").get(id) as { c: number }).c
  return { note, revisions, total }
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

export type WriteError = { ok: false; error: string }
export type AddOk = { ok: true; note: NoteRow }
export type UpdateOk = {
  ok: true
  note: NoteRow
  revisionId: number
  oldTimestamp: string
  timestamp: string
}
export type RestoreOk = UpdateOk & { revisionIdFrom: number; revisedAt: string }
export type FlagOk = { ok: true; note: NoteRow; timestamp: string }
export type DeleteOk = { ok: true; note: NoteRow }

export type AddInput = {
  category: string
  title: string
  content: string
  tags?: string | undefined
  author?: string | undefined
  scope?: string | undefined
}

export function addNote(db: Db, input: AddInput): AddOk | WriteError {
  const category = normalizeCategory(input.category)
  const title = input.title
  const scope = normalizeScope(input.scope)
  const content = input.content ?? ""
  if (!title.trim()) return { ok: false, error: "título vazio: a nota ficaria sem identificação." }
  if (category === "problem") {
    const missing = missingProblemSections(content)
    if (missing.length) return { ok: false, error: `problem sem ${missing.join(", ")}.` }
  }
  const timestamp = nowTimestamp()
  const info = db
    .prepare(
      "INSERT INTO notes (timestamp, category, tags, scope, title, content, author) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      timestamp,
      category,
      input.tags ?? "",
      scope,
      title,
      content,
      input.author && input.author.trim() ? input.author.trim() : null
    )
  const note = loadNote(db, Number(info.lastInsertRowid))
  if (!note) return { ok: false, error: "nota não encontrada após inserção." }
  return { ok: true, note }
}

export type UpdateInput = {
  id: number
  title?: string | undefined
  tags?: string | undefined
  content?: string | undefined
  category?: string | undefined
  scope?: string | undefined
}

export function updateNote(db: Db, input: UpdateInput): UpdateOk | WriteError {
  if (
    input.title === undefined &&
    input.tags === undefined &&
    input.content === undefined &&
    input.category === undefined &&
    input.scope === undefined
  ) {
    return { ok: false, error: "update requer ao menos um campo" }
  }
  const old = loadNote(db, input.id)
  if (!old) return { ok: false, error: `nota ${input.id} não encontrada` }

  const newCategory = input.category !== undefined ? normalizeCategory(input.category) : old.category
  const newTags = input.tags !== undefined ? input.tags : old.tags
  const newTitle = input.title !== undefined ? input.title : old.title
  const newContent = input.content !== undefined ? input.content : old.content
  const newScope = input.scope !== undefined ? normalizeScope(input.scope) : old.scope

  if (!newTitle.trim()) return { ok: false, error: "título vazio: a nota ficaria sem identificação." }
  if (newCategory === "#problem") {
    const missing = missingProblemSections(newContent)
    if (missing.length) return { ok: false, error: `#problem sem ${missing.join(", ")}.` }
  }

  const timestamp = nowTimestamp()
  // Correção sem perda: snapshot do estado anterior ANTES de sobrescrever.
  const rev = db
    .prepare(
      "INSERT INTO note_revisions (note_id, revised_at, timestamp, category, tags, scope, title, content," +
        " verified_at, disputed_at, retracted_at, status_reason) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      input.id,
      timestamp,
      old.timestamp,
      old.category,
      old.tags,
      old.scope,
      old.title,
      old.content,
      old.verified_at,
      old.disputed_at,
      old.retracted_at,
      old.status_reason
    )
  db.prepare(
    "UPDATE notes SET timestamp = ?, category = ?, tags = ?, scope = ?, title = ?, content = ?," +
      " verified_at = ?, disputed_at = NULL, retracted_at = NULL, status_reason = NULL WHERE id = ?"
  ).run(timestamp, newCategory, newTags, newScope, newTitle, newContent, timestamp, input.id)

  const note = loadNote(db, input.id)
  if (!note) return { ok: false, error: `nota ${input.id} não encontrada após atualização` }
  return {
    ok: true,
    note,
    revisionId: Number(rev.lastInsertRowid),
    oldTimestamp: old.timestamp,
    timestamp,
  }
}

export function restoreNote(db: Db, id: number, revisionId: number): RestoreOk | WriteError {
  const rev = db
    .prepare(
      "SELECT revised_at, category, tags, scope, title, content FROM note_revisions WHERE id = ? AND note_id = ?"
    )
    .get(revisionId, id) as
    | { revised_at: string; category: string; tags: string | null; scope: string | null; title: string; content: string }
    | null
  if (!rev) {
    return { ok: false, error: `revisão #${revisionId} não encontrada para a nota ${id}.` }
  }
  // Restaurar é um update: o conteúdo atual vira revisão e a nota é reescrita.
  const result = updateNote(db, {
    id,
    title: rev.title,
    tags: rev.tags ?? "",
    content: rev.content,
    category: rev.category,
    scope: rev.scope ?? "",
  })
  if (!result.ok) return result
  return { ...result, revisionIdFrom: revisionId, revisedAt: rev.revised_at }
}

export function confirmNote(db: Db, id: number): FlagOk | WriteError {
  if (!noteExists(db, id)) return { ok: false, error: `nota ${id} não encontrada` }
  const timestamp = nowTimestamp()
  db.prepare(
    "UPDATE notes SET verified_at = ?, disputed_at = NULL, retracted_at = NULL, status_reason = NULL WHERE id = ?"
  ).run(timestamp, id)
  const note = loadNote(db, id)
  if (!note) return { ok: false, error: `nota ${id} não encontrada` }
  return { ok: true, note, timestamp }
}

export function disputeNote(db: Db, id: number, reason: string): FlagOk | WriteError {
  if (!noteExists(db, id)) return { ok: false, error: `nota ${id} não encontrada` }
  const why = (reason ?? "").trim()
  if (!why) return { ok: false, error: '"dispute" requer um motivo.' }
  const timestamp = nowTimestamp()
  db.prepare(
    "UPDATE notes SET disputed_at = ?, status_reason = ?, retracted_at = NULL WHERE id = ?"
  ).run(timestamp, why, id)
  const note = loadNote(db, id)
  if (!note) return { ok: false, error: `nota ${id} não encontrada` }
  return { ok: true, note, timestamp }
}

export function retractNote(db: Db, id: number, reason?: string): FlagOk | WriteError {
  if (!noteExists(db, id)) return { ok: false, error: `nota ${id} não encontrada` }
  const why = (reason ?? "").trim() || "retracted"
  const timestamp = nowTimestamp()
  db.prepare(
    "UPDATE notes SET retracted_at = ?, status_reason = ?, disputed_at = NULL WHERE id = ?"
  ).run(timestamp, why, id)
  const note = loadNote(db, id)
  if (!note) return { ok: false, error: `nota ${id} não encontrada` }
  return { ok: true, note, timestamp }
}

export function pinNote(db: Db, id: number): FlagOk | WriteError {
  if (!noteExists(db, id)) return { ok: false, error: `nota ${id} não encontrada` }
  db.prepare("UPDATE notes SET pinned = 1 WHERE id = ? AND pinned = 0").run(id)
  const note = loadNote(db, id)
  if (!note) return { ok: false, error: `nota ${id} não encontrada` }
  return { ok: true, note, timestamp: note.timestamp }
}

export function unpinNote(db: Db, id: number): FlagOk | WriteError {
  if (!noteExists(db, id)) return { ok: false, error: `nota ${id} não encontrada` }
  db.prepare("UPDATE notes SET pinned = 0 WHERE id = ? AND pinned = 1").run(id)
  const note = loadNote(db, id)
  if (!note) return { ok: false, error: `nota ${id} não encontrada` }
  return { ok: true, note, timestamp: note.timestamp }
}

/**
 * Hard delete: removes the note and every version, permanently.
 *
 * Unlike retract (which only flags the row so it stops being listed), this
 * drops the rows themselves. The `notes_ad` trigger strips the note from the
 * FTS index on delete; the revisions are orphaned only via `note_id`, so they
 * are removed in the same transaction. The row is captured before the drop so
 * the caller can confirm what was removed.
 */
export function deleteNote(db: Db, id: number): DeleteOk | WriteError {
  if (!noteExists(db, id)) return { ok: false, error: `nota ${id} não encontrada` }
  const note = loadNote(db, id)
  if (!note) return { ok: false, error: `nota ${id} não encontrada` }
  try {
    db.prepare("BEGIN").run()
    // Drop the note first: the AFTER DELETE trigger removes it from notes_fts.
    db.prepare("DELETE FROM notes WHERE id = ?").run(id)
    db.prepare("DELETE FROM note_revisions WHERE note_id = ?").run(id)
    db.prepare("COMMIT").run()
  } catch {
    try {
      db.prepare("ROLLBACK").run()
    } catch {
      /* best effort */
    }
    return { ok: false, error: `não foi possível remover a nota ${id} de forma atômica` }
  }
  return { ok: true, note }
}

/* ------------------------------------------------------------------ */
/* Text rendering (the CLI-style output the tools return)              */
/* ------------------------------------------------------------------ */

const RULE = "=".repeat(50)
const DASH = "-".repeat(50)

function flagsOf(row: {
  verified_at: string | null
  disputed_at: string | null
  retracted_at: string | null
  status_reason: string | null
  pinned?: number | boolean
}): string[] {
  const flags: string[] = []
  if (row.retracted_at) {
    flags.push(`🚫 retracted ${row.retracted_at}` + (row.status_reason ? `: ${row.status_reason}` : ""))
  } else if (row.disputed_at) {
    flags.push(`⚠ disputed ${row.disputed_at}` + (row.status_reason ? `: ${row.status_reason}` : ""))
  }
  if (row.verified_at) flags.push(`✔ verified ${row.verified_at}`)
  if (row.pinned !== undefined && isPinned(row.pinned)) flags.push("📌 pinned")
  return flags
}

export function renderRows(header: string, rows: NoteRow[]): string {
  const out = [header, RULE]
  for (const r of rows) {
    const by = r.author ? ` (by ${r.author})` : ""
    out.push(`#${r.id} [${r.timestamp}] (${r.category}) **${r.title}**${by}`)
    const flags = flagsOf(r)
    if (flags.length) out.push("   " + flags.join(" · "))
    if (r.tags) out.push(`Tags: ${r.tags}`)
    if (r.scope) out.push(`Scope: ${r.scope}`)
    out.push(`Conteúdo:\n${r.content}\n${DASH}`)
  }
  return out.join("\n")
}

export function renderRevision(rev: RevisionRow): string {
  const out = [
    RULE,
    `rev #${rev.id} — substituída em ${rev.revised_at} (valia desde ${rev.timestamp}) (${rev.category}) **${rev.title}**`,
  ]
  const flags = flagsOf(rev)
  if (flags.length) out.push("   " + flags.join(" · "))
  if (rev.tags) out.push(`Tags: ${rev.tags}`)
  if (rev.scope) out.push(`Scope: ${rev.scope}`)
  out.push(`Conteúdo:\n${rev.content}`)
  return out.join("\n")
}

export function renderHistory(history: History, limit?: number): string {
  const { note, revisions, total } = history
  const out = [renderRows(`📍 Nota #${note.id} — versão atual`, [note])]
  if (revisions.length === 0) {
    out.push(`🕓 Sem revisões: esta nota nunca foi corrigida (total: ${total}).`)
    return out.join("\n")
  }
  const shown = limit && revisions.length < total ? `${revisions.length} de ${total}` : String(total)
  out.push(`🕓 Histórico de #${note.id}: ${shown} revisão(ões), mais recente primeiro`)
  for (const rev of revisions) out.push(renderRevision(rev))
  out.push(DASH)
  out.push(`↩️  restaurar uma versão: notes restore ${note.id} <rev>`)
  return out.join("\n")
}

export type DoctorInfo = {
  runtime: string
  driver: "native"
  dbPath: string
  size: number
  fts: boolean
  version: number
  tables: string[]
  triggers: string[]
  notes: number
  indexed: number
  verified: number
  disputed: number
  retracted: number
  revisions: number
  revisedNotes: number
}

export function doctorInfo(store: Store): DoctorInfo {
  const { db, fts, driver } = store
  const one = (sql: string): number => {
    const row = db.prepare(sql).get() as Record<string, unknown> | undefined
    return Number(Object.values(row ?? {})[0] ?? 0)
  }
  const names = (type: string): string[] =>
    (db.prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name").all(type) as {
      name: string
    }[]).map((r) => r.name)

  const flags = db
    .prepare(
      "SELECT SUM(verified_at IS NOT NULL) AS v, SUM(disputed_at IS NOT NULL) AS d," +
        " SUM(retracted_at IS NOT NULL) AS r FROM notes"
    )
    .get() as { v: number | null; d: number | null; r: number | null }
  const rev = db
    .prepare("SELECT COUNT(*) AS c, COUNT(DISTINCT note_id) AS n FROM note_revisions")
    .get() as { c: number; n: number }

  let size = 0
  try {
    size = statSync(notesDbPath()).size
  } catch {
    /* ignore */
  }

  return {
    runtime: describeRuntime(),
    driver,
    dbPath: notesDbPath(),
    size,
    fts,
    version: one("PRAGMA user_version"),
    tables: names("table"),
    triggers: names("trigger"),
    notes: one("SELECT COUNT(*) FROM notes"),
    indexed: fts ? one("SELECT COUNT(*) FROM notes_fts") : 0,
    verified: Number(flags?.v ?? 0),
    disputed: Number(flags?.d ?? 0),
    retracted: Number(flags?.r ?? 0),
    revisions: Number(rev?.c ?? 0),
    revisedNotes: Number(rev?.n ?? 0),
  }
}

export function renderDoctor(info: DoctorInfo): string {
  const out = ["🩺 notes — diagnostico", RULE]
  out.push(`runtime     : ${info.runtime}`)
  out.push("sqlite      : nativo (node:sqlite)")
  out.push(`db          : ${info.dbPath}`)
  out.push(
    info.fts ? "fts5        : ✅ disponivel" : "fts5        : ⚠️  indisponivel — buscando via LIKE"
  )
  out.push(`tamanho     : ${info.size} bytes`)
  out.push(`user_version: ${info.version} (esperado ${SCHEMA_VERSION})`)
  if (info.version !== SCHEMA_VERSION) out.push("❌ versao de schema divergente")
  out.push(`tabelas     : ${info.tables.join(", ")}`)
  out.push(`triggers    : ${info.triggers.join(", ") || "(nenhum)"}`)
  out.push(`notas       : ${info.notes}`)
  if (info.fts) {
    out.push(`indice fts  : ${info.indexed} linha(s)`)
    if (info.indexed !== info.notes) out.push("⚠️  indice fora de sincronia — rode reindex")
  } else {
    out.push("indice fts  : (ausente — busca LIKE)")
  }
  out.push(
    `confianca   : ${info.verified} verificada(s), ${info.disputed} disputada(s), ${info.retracted} retratada(s)`
  )
  out.push(`histórico   : ${info.revisions} revisão(ões) em ${info.revisedNotes} nota(s) corrigida(s)`)
  return out.join("\n")
}

/* ------------------------------------------------------------------ */
/* Tool-facing helpers                                                 */
/* ------------------------------------------------------------------ */

export function renderAdd(r: AddOk): string {
  return `✅ Nota ${r.note.id} salva em ${r.note.timestamp} [${r.note.category}]`
}

export function renderUpdate(r: UpdateOk): string {
  return [
    `✏️  Nota ${r.note.id} atualizada em ${r.timestamp} [${r.note.category}]`,
    `   timestamp: ${r.oldTimestamp} → ${r.timestamp}`,
    `   🕓 versão anterior guardada como rev #${r.revisionId} — veja \`notes history ${r.note.id}\``,
    "   ✔ marcada como verificada; disputa/retração limpas (se havia)",
  ].join("\n")
}

export function renderRestore(r: RestoreOk): string {
  return [
    `↩️  Restaurando #${r.note.id} para a rev #${r.revisionIdFrom} (versão de ${r.revisedAt}):`,
    renderUpdate(r),
  ].join("\n")
}

export function renderConfirm(r: FlagOk): string {
  return [
    `✔ Nota ${r.note.id} verificada em ${r.timestamp}`,
    "   disputa/retração limpas (se havia): a nota volta a aparecer normalmente",
  ].join("\n")
}

export function renderDispute(r: FlagOk): string {
  return `⚠ Nota ${r.note.id} disputada em ${r.timestamp}: ${r.note.status_reason ?? ""}`
}

export function renderRetract(r: FlagOk): string {
  return [
    `🚫 Nota ${r.note.id} retratada em ${r.timestamp}: ${r.note.status_reason ?? ""}`,
    "   fora do search/list por padrão; `confirm`/`update` a trazem de volta, `--all` mostra",
  ].join("\n")
}

export function renderPin(r: FlagOk): string {
  return `📌 Nota ${r.note.id} fixada.`
}

export function renderUnpin(r: FlagOk): string {
  return `📎 Nota ${r.note.id} desfixada.`
}
