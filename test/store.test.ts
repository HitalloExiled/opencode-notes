/**
 * Store tests — the data layer's pure helpers and schema migrations.
 *
 * Runs against an in-memory `node:sqlite` database (same backend as
 * production, `:memory:` path), so migrations are exercised exactly as they
 * run on first open of a real `notes.db`.
 */

import { describe, expect, test } from "bun:test";

const { DatabaseSync } = (await import("node:sqlite")) as any;

import {
  addNote,
  initSchema,
  normalizeCategory,
  normalizeScope,
  noteHistory,
  parseScope,
  updateNote,
} from "../src/store";

const emptyDb = () => new DatabaseSync(":memory:");

/* ------------------------------------------------------------------ */
/* normalizeCategory                                                     */
/* ------------------------------------------------------------------ */

describe("normalizeCategory", () => {
  test("plain token -> unchanged", () => {
    expect(normalizeCategory("problem")).toBe("problem");
    expect(normalizeCategory("decision")).toBe("decision");
  });

  test("legacy '#'-prefixed tokens -> stripped", () => {
    expect(normalizeCategory("#problem")).toBe("problem");
    expect(normalizeCategory("###general")).toBe("general");
  });

  test("whitespace is trimmed", () => {
    expect(normalizeCategory("  problem  ")).toBe("problem");
    expect(normalizeCategory(" #decision ")).toBe("decision");
  });

  test("empty / whitespace-only -> 'general'", () => {
    expect(normalizeCategory("")).toBe("general");
    expect(normalizeCategory("   ")).toBe("general");
  });
});

/* ------------------------------------------------------------------ */
/* parseScope / normalizeScope                                           */
/* ------------------------------------------------------------------ */

describe("parseScope / normalizeScope (v8 model: all/machine/project + project path)", () => {
  test("empty / null / whitespace -> null", () => {
    expect(parseScope(undefined)).toBeNull();
    expect(parseScope(null)).toBeNull();
    expect(parseScope("")).toBeNull();
    expect(parseScope("   ")).toBeNull();
    expect(normalizeScope(undefined)).toBeNull();
    expect(normalizeScope("")).toBeNull();
  });

  test("'global'/'all'/'none' -> type 'all' (case-insensitive)", () => {
    for (const v of ["global", "all", "none", " Global "] as const) {
      expect(parseScope(v)).toEqual({ type: "all", project: null });
      expect(normalizeScope(v)).toBe("all");
    }
  });

  test("'machine' and 'machine:X' -> type 'machine', no project", () => {
    expect(parseScope("machine")).toEqual({ type: "machine", project: null });
    expect(parseScope("machine:rafael")).toEqual({ type: "machine", project: null });
    expect(parseScope("machine:/some/path")).toEqual({ type: "machine", project: null });
  });

  test("'project' -> type 'project' without a path; 'project:X' -> project X", () => {
    expect(parseScope("project")).toEqual({ type: "project", project: null });
    expect(parseScope("project:age")).toEqual({ type: "project", project: "age" });
    expect(parseScope("project:opencode-tools")).toEqual({
      type: "project",
      project: "opencode-tools",
    });
  });

  test("project paths with colons are preserved", () => {
    expect(parseScope("project:/srv/apps:ci")).toEqual({
      type: "project",
      project: "/srv/apps:ci",
    });
  });

  test("unknown tokens -> null", () => {
    expect(parseScope("whatever")).toBeNull();
    expect(parseScope("whatever:x")).toBeNull();
    expect(normalizeScope("whatever")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* migration 007 (remove legacy '#' prefix from stored categories)      */
/* ------------------------------------------------------------------ */

describe("MIGRATION_007 (categories without '#')", () => {
  test("legacy '#'-prefixed rows are stripped on upgrade (v6 -> v8)", async () => {
    const db = emptyDb();
    initSchema(db); // full schema, v8

    // Rewind to the legacy state a v6 DB would have: drop the v8 additions
    // (so the v7 -> v8 upgrade adds `project` again), then seed '#'-prefixed
    // categories written by the old normalizeCategory.
    db.prepare("DROP INDEX IF EXISTS idx_notes_scope_project").run();
    db.prepare("ALTER TABLE notes DROP COLUMN project").run();
    db.prepare("ALTER TABLE note_revisions DROP COLUMN project").run();
    db.prepare("PRAGMA user_version = 6").run();
    db.prepare(
      "INSERT INTO notes (timestamp, category, tags, scope, title, content, author) VALUES (?, ?, ?, ?, ?, ?, NULL)"
    ).run("2020-01-01 00:00:00", "#problem", "x", "global", "t", "c");
    db.prepare(
      "INSERT INTO note_revisions (note_id, revised_at, timestamp, category, tags, title, content) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(1, "2020-01-02 00:00:00", "2020-01-01 00:00:00", "#config", "", "t", "c");

    // Re-open (upgrade): migration 007 must strip the prefix in place.
    initSchema(db);

    expect((db.prepare("SELECT category FROM notes WHERE id = 1").get() as { category?: string }).category).toBe(
      "problem",
    );
    expect(
      (db.prepare("SELECT category FROM note_revisions WHERE id = 1").get() as { category?: string }).category,
    ).toBe("config");
    // A v6 database upgrades through 007 and 008 in one open -> v8.
    expect((db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version).toBe(8);
    // 008 also rewrites the seeded scopes (global -> all, etc.).
    expect((db.prepare("SELECT scope FROM notes WHERE id = 1").get() as { scope?: string }).scope).toBe("all");
  });

  test("plain categories and plain writes survive untouched", async () => {
    const db = emptyDb();
    initSchema(db);
    initSchema(db); // idempotent, already at v8

    const res = addNote(db, {
      category: "problem",
      title: "t",
      content: "Symptom: x. Cause: y. Solution: z.",
    });
    expect(res.ok).toBe(true);
    expect(res.note!.category).toBe("problem");
  });
});

/* ------------------------------------------------------------------ */
/* migration 008 (scope type + project path column)                     */
/* ------------------------------------------------------------------ */

// Builds a database that looks like a pre-v8 (v7) one: the full schema
// minus the v8 additions (project column, its index), user_version 7,
// then seeds the legacy `scope` values a v6-era app would have written.
function legacyV7Db(): any {
  const db = emptyDb();
  initSchema(db); // v8 schema
  // Rewind to the shape a v7 database has.
  db.prepare("DROP INDEX IF EXISTS idx_notes_scope_project").run();
  db.prepare("ALTER TABLE notes DROP COLUMN project").run();
  db.prepare("ALTER TABLE note_revisions DROP COLUMN project").run();
  db.prepare("PRAGMA user_version = 7").run();
  db.prepare(
    "INSERT INTO notes (timestamp, category, tags, scope, title, content) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("2020-01-01 00:00:00", "problem", "", null, "t1", "c1");
  db.prepare("INSERT INTO notes (timestamp, category, tags, scope, title, content) VALUES (?, ?, ?, ?, ?, ?)").run(
    "2020-01-02 00:00:00",
    "problem",
    "",
    "global",
    "t2",
    "c2",
  );
  db.prepare("INSERT INTO notes (timestamp, category, tags, scope, title, content) VALUES (?, ?, ?, ?, ?, ?)").run(
    "2020-01-03 00:00:00",
    "problem",
    "",
    "machine",
    "t3",
    "c3",
  );
  db.prepare("INSERT INTO notes (timestamp, category, tags, scope, title, content) VALUES (?, ?, ?, ?, ?, ?)").run(
    "2020-01-04 00:00:00",
    "problem",
    "",
    "machine:rafael",
    "t4",
    "c4",
  );
  db.prepare("INSERT INTO notes (timestamp, category, tags, scope, title, content) VALUES (?, ?, ?, ?, ?, ?)").run(
    "2020-01-05 00:00:00",
    "problem",
    "",
    "project:agentic-dev-infra",
    "t5",
    "c5",
  );
  db.prepare("INSERT INTO notes (timestamp, category, tags, scope, title, content) VALUES (?, ?, ?, ?, ?, ?)").run(
    "2020-01-06 00:00:00",
    "problem",
    "",
    "project:Age",
    "t6",
    "c6",
  );
  db.prepare(
    "INSERT INTO note_revisions (note_id, revised_at, timestamp, category, tags, scope, title, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(1, "2020-01-07 00:00:00", "2020-01-06 00:00:00", "problem", "", "project:opencode-tools", "c", "c");
  return db;
}

describe("MIGRATION_008 (scope type + project path)", () => {
  test("legacy scope values are rewritten on upgrade (v7 -> v8)", async () => {
    const db = legacyV7Db();

    // Re-open (upgrade): migration 008 must rewrite scopes, fill
    // `project`, swap indexes, and bump to v8.
    initSchema(db);

    const row = (id: number) =>
      db.prepare("SELECT scope, project FROM notes WHERE id = ?").get(id) as {
        scope?: string;
        project?: string | null;
      };

    expect(row(1).scope).toBe("all"); // NULL -> all
    expect(row(1).project).toBeNull();
    expect(row(2).scope).toBe("all"); // global -> all
    expect(row(3).scope).toBe("machine");
    expect(row(4).scope).toBe("machine"); // machine:rafael -> machine (name dropped)
    expect(row(4).project).toBeNull();
    expect(row(5).scope).toBe("project");
    expect(row(5).project).toBe("agentic-dev-infra");
    expect(row(6).scope).toBe("project");
    expect(row(6).project).toBe("Age");

    const rev = db
      .prepare("SELECT scope, project FROM note_revisions WHERE id = 1")
      .get() as { scope?: string; project?: string | null };
    expect(rev.scope).toBe("project");
    expect(rev.project).toBe("opencode-tools");

    expect((db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version).toBe(8);

    // New composite index present, old one dropped.
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notes'")
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_notes_scope_project");
    expect(names).not.toContain("idx_notes_scope");
  });

  test("re-opening an already-v8 database is idempotent", async () => {
    const db = legacyV7Db();
    initSchema(db);
    initSchema(db);
    expect((db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version).toBe(8);
  });
});

/* ------------------------------------------------------------------ */
/* addNote / updateNote (scope + project)                               */
/* ------------------------------------------------------------------ */

describe("addNote (scope + project)", () => {
  test("project scope stores the absolute path", async () => {
    const db = legacyV7Db();
    initSchema(db);
    const res = addNote(db, {
      category: "decision",
      title: "t",
      content: "ok",
      scope: "project",
      project: "/abs/path",
    });
    expect(res.ok).toBe(true);
    expect(res.note!.scope).toBe("project");
    expect(res.note!.project).toBe("/abs/path");
  });

  test("'global'/'all'/'none' -> 'all'; 'machine' discards any project", async () => {
    const db = legacyV7Db();
    initSchema(db);

    const g = addNote(db, { category: "decision", title: "t", content: "ok", scope: "global", project: "/x" });
    expect(g.note!.scope).toBe("all");
    expect(g.note!.project).toBeNull();

    const m = addNote(db, { category: "decision", title: "t", content: "ok", scope: "machine", project: "/y" });
    expect(m.note!.scope).toBe("machine");
    expect(m.note!.project).toBeNull();
  });

  test("legacy free-form 'project:X' fills the project column from the name", async () => {
    const db = legacyV7Db();
    initSchema(db);
    const res = addNote(db, {
      category: "decision",
      title: "t",
      content: "ok",
      scope: "project:age",
    });
    expect(res.note!.scope).toBe("project");
    expect(res.note!.project).toBe("age");
  });

  test("no scope -> 'all'", async () => {
    const db = legacyV7Db();
    initSchema(db);
    const res = addNote(db, { category: "decision", title: "t", content: "ok" });
    expect(res.note!.scope).toBe("all");
    expect(res.note!.project).toBeNull();
  });
});

describe("updateNote (scope + project)", () => {
  test("switching project -> machine clears the project path", async () => {
    const db = legacyV7Db();
    initSchema(db);
    const created = addNote(db, {
      category: "decision",
      title: "t",
      content: "ok",
      scope: "project",
      project: "/abs/path",
    });
    expect(created.ok).toBe(true);
    const id = created.note!.id;

    const res = updateNote(db, { id, scope: "machine" });
    expect(res.ok).toBe(true);
    expect(res.note!.scope).toBe("machine");
    expect(res.note!.project).toBeNull();
  });

  test("updating the project path works, and project -> project keeps it", async () => {
    const db = legacyV7Db();
    initSchema(db);
    const created = addNote(db, {
      category: "decision",
      title: "t",
      content: "ok",
      scope: "project",
      project: "/old/path",
    });
    const id = created.note!.id;

    const res = updateNote(db, { id, project: "/new/path" });
    expect(res.ok).toBe(true);
    expect(res.note!.scope).toBe("project");
    expect(res.note!.project).toBe("/new/path");
  });

  test("a revision snapshot keeps the previous (scope, project) pair", async () => {
    const db = legacyV7Db();
    initSchema(db);
    const created = addNote(db, {
      category: "decision",
      title: "t",
      content: "ok",
      scope: "project",
      project: "/old/path",
    });
    const id = created.note!.id;

    const res = updateNote(db, { id, scope: "all" });
    expect(res.ok).toBe(true);
    expect(res.note!.scope).toBe("all");
    expect(res.note!.project).toBeNull();

    const history = noteHistory(db, id);
    expect(history?.revisions.length).toBeGreaterThan(0);
    expect(history?.revisions[0].scope).toBe("project");
    expect(history?.revisions[0].project).toBe("/old/path");
  });
});
