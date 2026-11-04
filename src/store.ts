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

/*
 * v8 — the meaning of `scope` changes: it becomes a type (`all`, `machine`,
 * `project`) and the new `project` column carries the absolute project path
 * (used only for project-scope notes). Legacy rows are rewritten in place:
 *
 *   null / `global`            -> scope = 'all'
 *   `machine` / `machine:X`    -> scope = 'machine'   (X is dropped)
 *   `project:X`                -> scope = 'project', project = X
 *
 * Order matters: the project path is copied from the legacy `project:X`
 * values *before* the type column is rewritten. Runs in a single transaction
 * (see initSchema) so the database never ends up half-migrated.
 */
const MIGRATION_008 = [
  `ALTER TABLE notes ADD COLUMN project TEXT`,
  `ALTER TABLE note_revisions ADD COLUMN project TEXT`,
  `UPDATE notes SET project = substr(scope, 9) WHERE scope LIKE 'project:%'`,
  `UPDATE note_revisions SET project = substr(scope, 9) WHERE scope LIKE 'project:%'`,
  `UPDATE notes SET project = NULL, scope = 'machine' WHERE scope = 'machine' OR scope LIKE 'machine:%'`,
  `UPDATE note_revisions SET project = NULL, scope = 'machine' WHERE scope = 'machine' OR scope LIKE 'machine:%'`,
  `UPDATE notes SET scope = 'project' WHERE scope = 'project' OR scope LIKE 'project:%'`,
  `UPDATE note_revisions SET scope = 'project' WHERE scope = 'project' OR scope LIKE 'project:%'`,
  `UPDATE notes SET scope = 'all' WHERE scope IS NULL OR scope = 'global'`,
  `UPDATE note_revisions SET scope = 'all' WHERE scope IS NULL OR scope = 'global'`,
  `CREATE INDEX IF NOT EXISTS idx_notes_scope_project ON notes(scope, project)`,
  `DROP INDEX IF EXISTS idx_notes_scope`,
]

/*
 * v9 — multi-project: the single `project` column becomes a *set* of project
 * paths, moved into join tables `note_projects` and `note_revision_projects`
 * (one row per (note, project) / (revision, project)). The `project` column is
 * dropped from `notes`/`note_revisions`.
 *
 * Order matters (and must be exact, see node:sqlite build quirks):
 *   1. `DROP INDEX idx_notes_scope_project` — the composite index references the
 *      column about to be dropped; `ALTER TABLE … DROP COLUMN` fails otherwise.
 *   2. Create the join tables with *plain* foreign keys (NO `ON DELETE CASCADE`):
 *      the app deletes join rows before the parent, and in this build `foreign_keys`
 *      is ON by default, so a cascade would corrupt the rename path below.
 *   3. Backfill from the legacy `project` column.
 *   4. Drop the `project` columns (rowid/FKs/FTS triggers survive — they don't
 *      reference the dropped column; FTS content = title/content/tags/category
 *      is unchanged, so the FTS index stays in sync and needs no rebuild).
 *   5. Restore a scope-only index.
 */
const MIGRATION_009 = [
  `DROP INDEX IF EXISTS idx_notes_scope_project`,
  `CREATE TABLE IF NOT EXISTS note_projects (
    note_id INTEGER NOT NULL,
    project TEXT NOT NULL,
    PRIMARY KEY (note_id, project),
    FOREIGN KEY (note_id) REFERENCES notes(id)
  )`,
  `CREATE TABLE IF NOT EXISTS note_revision_projects (
    revision_id INTEGER NOT NULL,
    project TEXT NOT NULL,
    PRIMARY KEY (revision_id, project),
    FOREIGN KEY (revision_id) REFERENCES note_revisions(id)
  )`,
  `INSERT OR IGNORE INTO note_projects (note_id, project)
     SELECT id, project FROM notes WHERE project IS NOT NULL AND project != ''`,
  `INSERT OR IGNORE INTO note_revision_projects (revision_id, project)
     SELECT id, project FROM note_revisions WHERE project IS NOT NULL AND project != ''`,
  `ALTER TABLE notes DROP COLUMN project`,
  `ALTER TABLE note_revisions DROP COLUMN project`,
  `CREATE INDEX IF NOT EXISTS idx_notes_scope ON notes(scope)`,
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

export const SCHEMA_VERSION = 9

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

export type ScopeType = "all" | "machine" | "project"

const SCOPE_LINE = /^\s*Scope:\s*(\S+)\s*$/

const SCOPE_TYPE_ALIASES: Record<string, ScopeType> = {
  all: "all",
  global: "all",
  none: "all",
  machine: "machine",
  project: "project",
}

/**
 * Parses a free-form scope value into its type and, when the type is
 * `project`, the project value that follows `<name>` (legacy `project:X`).
 * `global`/`all`/`none` -> type `all`; `machine:X` -> type `machine` (X is
 * dropped); `project:X` -> type `project` with project `X`. Unknown tokens
 * yield `null`.
 */
export function parseScope(
  value?: string | null
): { type: ScopeType; project: string | null } | null {
  const token = (value ?? "").trim().split(/\s+/)[0] ?? ""
  if (!token) return null
  const [typeRaw, ...rest] = token.split(":")
  const type = SCOPE_TYPE_ALIASES[typeRaw?.toLowerCase() ?? ""]
  if (!type) return null
  if (type !== "project") return { type, project: null }
  const project = rest.length ? rest.join(":").trim() : ""
  return { type, project: project || null }
}

/** Normalizes a scope to its type column value: `all`/`machine`/`project` (null when absent). */
export function normalizeScope(value?: string | null): ScopeType | null {
  return parseScope(value)?.type ?? null
}

/** The raw value declared in the body by the legacy `Scope:` convention, if any. */
export function scopeFromContent(content: string): string | null {
  const match = content.match(/^\s*Scope:\s*(\S+)/m)
  return match?.[1] ?? null
}

/** Removes the legacy `Scope: …` line from a body. */
export function stripScopeLine(content: string): string {
  return content
    .split("\n")
    .filter((line) => !SCOPE_LINE.test(line))
    .join("\n")
    .trimEnd()
}

/**
 * Lifts the body convention into the new scope columns, once.
 *
 * v9-safe: after migration 009 the `project` column is gone, so any project
 * path is stored in the appropriate join table (`note_projects` /
 * `note_revision_projects`). Migration 008 already normalizes every scope to a
 * non-null value, so in practice this is a no-op; it only matters for the
 * superseded `scope IS NULL` + legacy `Scope:` body-line combination.
 */
function backfillScopeColumn(db: Db): void {
  for (const [table, projTable] of [
    ["notes", "note_projects"],
    ["note_revisions", "note_revision_projects"],
  ] as const) {
    const rows = db
      .prepare(`SELECT id, content FROM ${table} WHERE scope IS NULL`)
      .all() as Array<{ id: number; content: string }>
    if (rows.length === 0) continue
    const update = db.prepare(`UPDATE ${table} SET scope = ?, content = ? WHERE id = ?`)
    const ins = db.prepare(
      `INSERT OR IGNORE INTO ${projTable} (${table === "note_revisions" ? "revision_id" : "note_id"}, project) VALUES (?, ?)`,
    )
    for (const row of rows) {
      const parsed = parseScope(scopeFromContent(row.content))
      if (!parsed) continue
      update.run(parsed.type, stripScopeLine(row.content), row.id)
      if (parsed.type === "project" && parsed.project) {
        ins.run(row.id, parsed.project)
      }
    }
  }
}

/** Returns true when `table` has a column named `column` (used to decide whether
 * a migration that touches that column still needs to run). */
function hasColumn(db: Db, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>
  return rows.some((r) => r.name === column)
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
  // v8 rewrites the meaning of `scope` and adds `project`; run as one
  // transaction so a failure never leaves the database half-migrated.
  if (current < 8) {
    try {
      db.prepare("BEGIN").run()
      apply(db, MIGRATION_008)
      db.prepare("COMMIT").run()
    } catch (err) {
      try {
        db.prepare("ROLLBACK").run()
      } catch {
        /* best effort */
      }
      throw err
    }
  }
  // v9 multi-project: move the single `project` column into join tables and
  // drop the columns. Same transactional care as 008 so a failure never leaves
  // the database half-migrated.
  //
  // The migration is only run while the legacy `project` column still exists.
  // A database already upgraded to the v9 structure (join tables present, `project`
  // column already dropped) is left alone: re-running 009 would reference a
  // column that no longer exists ("no such column: project"). Bumping
  // `user_version` to SCHEMA_VERSION below is then all that remains.
  if (current < 9 && hasColumn(db, "notes", "project")) {
    try {
      db.prepare("BEGIN").run()
      apply(db, MIGRATION_009)
      db.prepare("COMMIT").run()
    } catch (err) {
      try {
        db.prepare("ROLLBACK").run()
      } catch {
        /* best effort */
      }
      throw err
    }
  }
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
  /**
   * Multi-project: the set of absolute project paths the note belongs to.
   * Non-empty only for project-scope notes; stored in the `note_projects`
   * join table (one row per project). Empty array for `all`/`machine` scopes.
   */
  projects: string[]
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
  /** Multi-project paths (from `note_revision_projects`); empty for non-project scopes. */
  projects: string[]
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

/**
 * The delimiter used by `group_concat(np.project, char(31))` in the correlated
 * subqueries that aggregate a note's/revision's projects into one column. ASCII
 * unit separator (U+001F) is never present in an absolute path, so splitting on
 * it is unambiguous.
 */
const PROJECT_DELIM = "\u001f"

/**
 * Splits a `group_concat`-aggregated project list back into a sorted array.
 * The join tables are a *set* (composite key `(note_id, project)`), so the
 * read order is the B-tree index order — i.e. lexicographic by `project`.
 * Sorting here makes the in-memory array explicitly deterministic for every
 * caller (loadNote / listNotes / searchNotes / noteHistory / restoreNote),
 * independent of insertion order.
 */
function splitProjects(concat: string): string[] {
  return concat.split(PROJECT_DELIM).filter((p) => p.length > 0).sort()
}

/**
 * Trims, filters empty/whitespace-only entries and deduplicates a project list
 * (insertion-order preserving) before writing to the join table. The join
 * table's `PRIMARY KEY (note_id, project)` also keeps the stored set unique.
 * Reads always come back *sorted* (see `splitProjects`), so this function's
 * insertion order is only an internal detail, not a read contract. Accepts a
 * `readonly string[]` so IPC/Effect-inferred inputs (which are readonly) can
 * be passed through without conversion.
 */
function normalizeProjects(list?: readonly string[]): string[] {
  return [...new Set((list ?? []).map((p) => p.trim()).filter((p) => p.length > 0))]
}

/**
 * Maps raw SELECT rows (note/revision columns + a `projects_concat` aggregate
 * from a `group_concat(np.project, char(31))` correlated subquery) to rows with
 * the `projects` array populated. The `projects_concat` column is discarded.
 *
 * Generic over the row shape so it works for both `NoteRow` and
 * `RevisionRow`; the caller already casts the rows, and the resulting `projects`
 * field is overwritten here (the cast's placeholder `projects` is not present
 * at runtime and would be meaningless otherwise).
 */
function withProjects<T extends { id: number }>(
  rows: (T & { projects_concat?: string | null })[],
): (T & { projects: string[] })[] {
  return rows.map(({ projects_concat, ...rest }) =>
    ({ ...rest, projects: projects_concat ? splitProjects(projects_concat) : [] }) as T & { projects: string[] },
  )
}

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

/**
 * Loads a single note plus its project set. The projects are aggregated via a
 * correlated `group_concat(np.project, char(31))` over `note_projects`, which
 * is split back (order-preserving, `splitProjects`) into the `projects` array.
 */
function loadNote(db: Db, id: number): NoteRow | null {
  const sql =
    `SELECT ${noteColumns("n")}, ` +
    `(SELECT group_concat(np.project, char(31)) FROM note_projects np WHERE np.note_id = n.id) AS projects_concat ` +
    `FROM notes n WHERE n.id = ?`
  const row = db
    .prepare(sql)
    .get(id) as (NoteRow & { projects_concat?: string | null }) | undefined
  if (!row) return null
  const { projects_concat, ...note } = row
  return { ...note, projects: projects_concat ? splitProjects(projects_concat) : [] }
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export type ListOptions = { limit?: number | undefined; all?: boolean | undefined }

export function listNotes(db: Db, opts: ListOptions = {}): NoteRow[] {
  const limit = opts.limit ?? 50
  const sql =
    `SELECT ${noteColumns("n")}, ` +
    `(SELECT group_concat(np.project, char(31)) FROM note_projects np WHERE np.note_id = n.id) AS projects_concat ` +
    `FROM notes n${opts.all ? "" : " WHERE retracted_at IS NULL"} ` +
    `ORDER BY (n.disputed_at IS NOT NULL), n.timestamp DESC LIMIT ?`
  const rows = db.prepare(sql).all(limit) as (NoteRow & { projects_concat?: string | null })[]
  return withProjects(rows)
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
        `SELECT ${noteColumns("n")}, ` +
        `(SELECT group_concat(np.project, char(31)) FROM note_projects np WHERE np.note_id = n.id) AS projects_concat ` +
        `FROM notes n JOIN notes_fts f ON n.id = f.rowid ` +
        `WHERE notes_fts MATCH ?${all ? "" : " AND n.retracted_at IS NULL"} ` +
        "ORDER BY (n.disputed_at IS NOT NULL), bm25(notes_fts), n.timestamp DESC LIMIT ?"
      try {
        const rows = db.prepare(sql).all(match, limit)
        if (Array.isArray(rows) && rows.length > 0) {
          return withProjects(rows as (NoteRow & { projects_concat?: string | null })[])
        }
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
      `SELECT ${noteColumns()}, ` +
      `(SELECT group_concat(np.project, char(31)) FROM note_projects np WHERE np.note_id = notes.id) AS projects_concat ` +
      `FROM notes WHERE (${groups.join(` ${joiner} `)})` +
      `${all ? "" : " AND retracted_at IS NULL"}` +
      " ORDER BY (disputed_at IS NOT NULL), timestamp DESC LIMIT ?"
    const rows = db.prepare(sql).all(...params, limit)
    if (Array.isArray(rows) && rows.length > 0) {
      return withProjects(rows as (NoteRow & { projects_concat?: string | null })[])
    }
  }
  return []
}

export type History = { note: NoteRow; revisions: RevisionRow[]; total: number }

export function noteHistory(db: Db, id: number, limit?: number): History | undefined {
  const note = loadNote(db, id)
  if (!note) return undefined
  let sql =
    "SELECT r.id, r.revised_at, r.timestamp, r.category, r.tags, r.scope, r.title, r.content," +
    " r.verified_at, r.disputed_at, r.retracted_at, r.status_reason," +
    "(SELECT group_concat(np.project, char(31)) FROM note_revision_projects np WHERE np.revision_id = r.id) AS projects_concat" +
    " FROM note_revisions r WHERE r.note_id = ? ORDER BY r.id DESC"
  const params: unknown[] = [id]
  if (limit) {
    sql += " LIMIT ?"
    params.push(limit)
  }
  const revisions = withProjects(
    db.prepare(sql).all(...params) as (RevisionRow & { projects_concat?: string | null })[],
  )
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
  projects?: readonly string[]
}

export function addNote(db: Db, input: AddInput): AddOk | WriteError {
  const category = normalizeCategory(input.category)
  const title = input.title
  const parsed = parseScope(input.scope)
  // No default scope: the GUI always picks one of all/machine/project;
  // free callers fall back to "applies everywhere".
  const scope = parsed?.type ?? "all"
  const projects = scope === "project" ? normalizeProjects(input.projects) : []
  if (scope === "project" && projects.length === 0) {
    return { ok: false, error: "scope 'project' exige pelo menos um caminho de projeto no array `projects`." }
  }
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
  const noteId = Number(info.lastInsertRowid)
  if (projects.length) {
    const ins = db.prepare("INSERT OR IGNORE INTO note_projects (note_id, project) VALUES (?, ?)")
    for (const p of projects) ins.run(noteId, p)
  }
  const note = loadNote(db, noteId)
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
  projects?: readonly string[]
}

export function updateNote(db: Db, input: UpdateInput): UpdateOk | WriteError {
  if (
    input.title === undefined &&
    input.tags === undefined &&
    input.content === undefined &&
    input.category === undefined &&
    input.scope === undefined &&
    input.projects === undefined
  ) {
    return { ok: false, error: "update requer ao menos um campo" }
  }
  const old = loadNote(db, input.id)
  if (!old) return { ok: false, error: `nota ${input.id} não encontrada` }

  const newCategory = input.category !== undefined ? normalizeCategory(input.category) : old.category
  const newTags = input.tags !== undefined ? input.tags : old.tags
  const newTitle = input.title !== undefined ? input.title : old.title
  const newContent = input.content !== undefined ? input.content : old.content

  // (scope, projects) are a pair: a change to either re-resolves both. The
  // project set is only meaningful for project scope and is never copied over
  // to another type.
  const parsed = parseScope(input.scope)
  const newScope = input.scope !== undefined ? (parsed?.type ?? old.scope) : old.scope
  const hasScopeOrProjects = input.scope !== undefined || input.projects !== undefined
  const newProjects = hasScopeOrProjects
    ? newScope === "project"
      ? normalizeProjects(input.projects)
      : []
    : old.projects
  if (newScope === "project" && newProjects.length === 0) {
    return { ok: false, error: "scope 'project' exige pelo menos um caminho de projeto no array `projects`." }
  }

  if (!newTitle.trim()) return { ok: false, error: "título vazio: a nota ficaria sem identificação." }
  if (newCategory === "problem") {
    const missing = missingProblemSections(newContent)
    if (missing.length) return { ok: false, error: `problem sem ${missing.join(", ")}.` }
  }

  const timestamp = nowTimestamp()
  try {
    db.prepare("BEGIN").run()
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
    // Snapshot the revision's project set too (from the old note).
    if (old.projects.length) {
      const ins = db.prepare("INSERT OR IGNORE INTO note_revision_projects (revision_id, project) VALUES (?, ?)")
      for (const p of old.projects) ins.run(Number(rev.lastInsertRowid), p)
    }
    // Rewrite the note: overwrite the row, then replace its project set
    // (children are dropped before any parent delete would matter; the FK is
    // enforced, so we delete the join rows and re-insert the new ones).
    db.prepare(
      "UPDATE notes SET timestamp = ?, category = ?, tags = ?, scope = ?, title = ?, content = ?," +
        " verified_at = ?, disputed_at = NULL, retracted_at = NULL, status_reason = NULL WHERE id = ?"
    ).run(timestamp, newCategory, newTags, newScope, newTitle, newContent, timestamp, input.id)
    db.prepare("DELETE FROM note_projects WHERE note_id = ?").run(input.id)
    const ins = db.prepare("INSERT OR IGNORE INTO note_projects (note_id, project) VALUES (?, ?)")
    for (const p of newProjects) ins.run(input.id, p)
    db.prepare("COMMIT").run()

    const note = loadNote(db, input.id)
    if (!note) return { ok: false, error: `nota ${input.id} não encontrada após atualização` }
    return {
      ok: true,
      note,
      revisionId: Number(rev.lastInsertRowid),
      oldTimestamp: old.timestamp,
      timestamp,
    }
  } catch (err) {
    try {
      db.prepare("ROLLBACK").run()
    } catch {
      /* best effort */
    }
    return { ok: false, error: `não foi possível atualizar a nota ${input.id}` }
  }
}

export function restoreNote(db: Db, id: number, revisionId: number): RestoreOk | WriteError {
  const rev = db
    .prepare(
      "SELECT r.revised_at, r.category, r.tags, r.scope, r.title, r.content, " +
      "(SELECT group_concat(np.project, char(31)) FROM note_revision_projects np WHERE np.revision_id = r.id) AS projects_concat " +
      "FROM note_revisions r WHERE r.id = ? AND r.note_id = ?"
    )
    .get(revisionId, id) as
    | {
        revised_at: string
        category: string
        tags: string | null
        scope: string | null
        projects_concat: string | null
        title: string
        content: string
      }
    | null
  if (!rev) {
    return { ok: false, error: `revisão #${revisionId} não encontrada para a nota ${id}.` }
  }
  // Multi-project: the revision's project set comes from the join table via the
  // correlated aggregate, then is re-applied through `updateNote` only when the
  // restored scope is `project`.
  const revProjects = rev.scope && rev.scope === "project"
    ? rev.projects_concat
      ? splitProjects(rev.projects_concat)
      : []
    : undefined
  // Restaurar é um update: o conteúdo atual vira revisão e a nota é reescrita.
  const result = updateNote(db, {
    id,
    title: rev.title,
    tags: rev.tags ?? "",
    content: rev.content,
    category: rev.category,
    scope: rev.scope ?? "",
    ...(revProjects !== undefined ? { projects: revProjects } : {}),
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
    // Delete children before their parents: FKs are enforced by default in this
    // build (`foreign_keys` defaults ON), so the order must respect referential
    // integrity. The AFTER DELETE trigger on `notes` strips it from notes_fts.
    db.prepare("DELETE FROM note_projects WHERE note_id = ?").run(id)
    // `note_revisions` rows hold snapshots; their `note_revision_projects`
    // children must go first.
    db.prepare("DELETE FROM note_revision_projects WHERE revision_id IN (SELECT id FROM note_revisions WHERE note_id = ?)").run(id)
    db.prepare("DELETE FROM note_revisions WHERE note_id = ?").run(id)
    db.prepare("DELETE FROM notes WHERE id = ?").run(id)
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
    if (r.scope && r.scope !== "all") {
      out.push(`Scope: ${r.scope}${r.projects.length ? ` (${r.projects.join(", ")})` : ""}`)
    }
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
  if (rev.scope && rev.scope !== "all") {
    out.push(`Scope: ${rev.scope}${rev.projects.length ? ` (${rev.projects.join(", ")})` : ""}`)
  }
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
