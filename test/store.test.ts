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

describe("parseScope / normalizeScope (scope type; legacy 'project:X' still parses)", () => {
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
  test("legacy '#'-prefixed rows are stripped on upgrade (v6 -> v9)", async () => {
    const db = emptyDb();
    initSchema(db); // full schema, v9

    // Rewind to the legacy state a v6 DB would have: v9 differs from v6 by
    // migrations 007 (category rewrite), 008 (scope type + index) and 009
    // (join tables). Only the two join tables are schema-level, so dropping
    // them lands exactly on v6 (006's `idx_notes_scope` survives both).
    db.prepare("DROP TABLE IF EXISTS note_projects").run();
    db.prepare("DROP TABLE IF EXISTS note_revision_projects").run();
    db.prepare("PRAGMA user_version = 6").run();
    db.prepare(
      "INSERT INTO notes (timestamp, category, tags, scope, title, content, author) VALUES (?, ?, ?, ?, ?, ?, NULL)"
    ).run("2020-01-01 00:00:00", "#problem", "x", "global", "t", "c");
    db.prepare(
      "INSERT INTO note_revisions (note_id, revised_at, timestamp, category, tags, title, content) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(1, "2020-01-02 00:00:00", "2020-01-01 00:00:00", "#config", "", "t", "c");

    // Re-open (upgrade): migrations 007, 008 and 009 run; 007 must strip the
    // prefix in place.
    initSchema(db);

    expect((db.prepare("SELECT category FROM notes WHERE id = 1").get() as { category?: string }).category).toBe(
      "problem",
    );
    expect(
      (db.prepare("SELECT category FROM note_revisions WHERE id = 1").get() as { category?: string }).category,
    ).toBe("config");
    // A v6 database upgrades through 007, 008 and 009 in one open -> v9.
    expect((db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version).toBe(9);
    // 008 also rewrites the seeded scopes (global -> all, etc.).
    expect((db.prepare("SELECT scope FROM notes WHERE id = 1").get() as { scope?: string }).scope).toBe("all");
  });

  test("plain categories and plain writes survive untouched", async () => {
    const db = emptyDb();
    initSchema(db);
    initSchema(db); // idempotent, already at v9

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
/* migration 008 (scope type + project paths) and 009 (join tables)     */
/* ------------------------------------------------------------------ */

// Builds a database that looks like a pre-v8 (v7) one: the full schema
// minus the v8 additions (project column, its index), user_version 7,
// then seeds the legacy `scope` values a v6-era app would have written.
function legacyV7Db(): any {
  const db = emptyDb();
  initSchema(db); // v9 schema
  // Rewind to the shape a v7 database has. v9 differs from v7 only by the two
  // join tables (009 created them); the v8 `project` column is absent in both
  // v7 and v9, and `idx_notes_scope` is present in both.
  db.prepare("DROP TABLE IF EXISTS note_projects").run();
  db.prepare("DROP TABLE IF EXISTS note_revision_projects").run();
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

describe("MIGRATION_008 + 009 (scope type, project column -> join tables)", () => {
  test("legacy scope values are rewritten on upgrade (v7 -> v9)", async () => {
    const db = legacyV7Db();

    // Re-open (upgrade): 008 rewrites scopes and fills the legacy `project`
    // column; 009 backfills it into the join tables, drops the column, and
    // lands on v9.
    initSchema(db);

    const row = (id: number) =>
      db.prepare("SELECT scope FROM notes WHERE id = ?").get(id) as { scope?: string };
    const join = (table: string, fk: string, key: number): string[] =>
      (
        db
          .prepare(`SELECT project FROM ${table} WHERE ${fk} = ? ORDER BY project`)
          .all(key)
      )
        .map((r: { project: string }) => r.project);

    expect(row(1).scope).toBe("all"); // NULL -> all
    expect(join("note_projects", "note_id", 1)).toEqual([]);
    expect(row(2).scope).toBe("all"); // global -> all
    expect(row(3).scope).toBe("machine");
    expect(row(4).scope).toBe("machine"); // machine:rafael -> machine (name dropped)
    expect(row(5).scope).toBe("project");
    expect(join("note_projects", "note_id", 5)).toEqual(["agentic-dev-infra"]);
    expect(row(6).scope).toBe("project");
    expect(join("note_projects", "note_id", 6)).toEqual(["Age"]);

    const rev = join("note_revision_projects", "revision_id", 1);
    expect(rev).toEqual(["opencode-tools"]);

    expect((db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version).toBe(9);

    // 009 dropped the composite index and restored the scope-only one.
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notes'")
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_notes_scope");
    expect(names).not.toContain("idx_notes_scope_project");
  });

  test("re-opening an already-v9 database is idempotent", async () => {
    const db = legacyV7Db();
    initSchema(db);
    initSchema(db);
    expect((db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version).toBe(9);
  });

  test("v9-structure DB with a stale user_version=8 re-opens cleanly (009 no-op)", async () => {
    // Regression for the live crash:
    //   sqlite indisponível: no such column: project
    // A DB already upgraded to v9 (join tables present, `project` column
    // dropped) can be left with a *stale* user_version (< 9) if an older
    // (SCHEMA_VERSION = 8) process wrote it last. The previous code then
    // re-ran migration 009, which references the already-dropped `project`
    // column and crashed. With the `hasColumn` guard, 009 is skipped and the
    // trailing `PRAGMA user_version = SCHEMA_VERSION` stamps it correctly.
    const db = emptyDb();
    initSchema(db); // v9 structure (no `project` col, join tables), user_version 9

    // Seed a project-scope note so the join table carries real data; a
    // properly migrated v9 DB has data here, so we assert it survives (lossless).
    addNote(db, {
      category: "decision",
      title: "v9-seed",
      content: "seed",
      scope: "project",
      projects: ["/abs/v9-project"],
    });

    // Simulate the stale stamp: a previous v8-scoped process reset it to 8.
    db.prepare("PRAGMA user_version = 8").run();

    // Re-open (upgrade). Before the guard this threw "no such column: project".
    expect(() => initSchema(db)).not.toThrow();

    // 009 was a no-op: the `project` column is still absent.
    const cols = (
      db.prepare("PRAGMA table_info(notes)")
        .all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).not.toContain("project");

    // Join-table data survived the re-open (lossless).
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM note_projects").get() as { c: number }).c
    ).toBe(1);

    // Version stamped to the latest (9).
    expect((db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version).toBe(
      9,
    );
  });
});

/* ------------------------------------------------------------------ */
/* addNote / updateNote (scope + projects)                               */
/* ------------------------------------------------------------------ */

describe("addNote (scope + projects)", () => {
  test("project scope stores the project paths (multi-project set)", async () => {
    const db = legacyV7Db();
    initSchema(db);
    const res = addNote(db, {
      category: "decision",
      title: "t",
      content: "ok",
      scope: "project",
      projects: ["/abs/path"],
    });
    expect(res.ok).toBe(true);
    expect(res.note!.scope).toBe("project");
    expect(res.note!.projects).toEqual(["/abs/path"]);

    // several paths -> all stored (order-preserving, deduplicated)
    const res2 = addNote(db, {
      category: "decision",
      title: "t2",
      content: "ok",
      scope: "project",
      projects: ["/b", "/a", "/b"],
    });
    // Read order is deterministic (sorted), independent of insertion order.
    expect(res2.note!.projects).toEqual(["/a", "/b"]);
  });

  test("'global'/'all'/'none' -> 'all'; 'machine' discards any projects", async () => {
    const db = legacyV7Db();
    initSchema(db);

    const g = addNote(db, { category: "decision", title: "t", content: "ok", scope: "global", projects: ["/x"] });
    expect(g.note!.scope).toBe("all");
    expect(g.note!.projects).toEqual([]);

    const m = addNote(db, { category: "decision", title: "t", content: "ok", scope: "machine", projects: ["/y"] });
    expect(m.note!.scope).toBe("machine");
    expect(m.note!.projects).toEqual([]);
  });

  test("project scope with no projects is rejected (v9 no longer fills paths from legacy 'project:X')", async () => {
    const db = legacyV7Db();
    initSchema(db);
    const res = addNote(db, {
      category: "decision",
      title: "t",
      content: "ok",
      scope: "project:age",
    });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("exige pelo menos um caminho de projeto");
  });

  test("no scope -> 'all'", async () => {
    const db = legacyV7Db();
    initSchema(db);
    const res = addNote(db, { category: "decision", title: "t", content: "ok" });
    expect(res.note!.scope).toBe("all");
    expect(res.note!.projects).toEqual([]);
  });
});

describe("updateNote (scope + projects)", () => {
  test("switching scope to 'machine' clears the project paths", async () => {
    const db = legacyV7Db();
    initSchema(db);
    const created = addNote(db, {
      category: "decision",
      title: "t",
      content: "ok",
      scope: "project",
      projects: ["/abs/path"],
    });
    expect(created.ok).toBe(true);
    const id = created.note!.id;

    const res = updateNote(db, { id, scope: "machine" });
    expect(res.ok).toBe(true);
    expect(res.note!.scope).toBe("machine");
    expect(res.note!.projects).toEqual([]);
  });

  test("updating the project paths works, and project -> project keeps the type", async () => {
    const db = legacyV7Db();
    initSchema(db);
    const created = addNote(db, {
      category: "decision",
      title: "t",
      content: "ok",
      scope: "project",
      projects: ["/old/path"],
    });
    const id = created.note!.id;

    // no scope passed: existing project scope is preserved, set replaced
    const res = updateNote(db, { id, projects: ["/new/path"] });
    expect(res.ok).toBe(true);
    expect(res.note!.scope).toBe("project");
    expect(res.note!.projects).toEqual(["/new/path"]);

    const res2 = updateNote(db, { id, projects: ["/b", "/a", "/b"] });
    expect(res2.ok).toBe(true);
    // Read order is deterministic (sorted), independent of insertion order.
    expect(res2.note!.projects).toEqual(["/a", "/b"]);
  });

  test("switching to 'all' clears paths; the revision snapshot keeps the old set", async () => {
    const db = legacyV7Db();
    initSchema(db);
    const created = addNote(db, {
      category: "decision",
      title: "t",
      content: "ok",
      scope: "project",
      projects: ["/old/path", "/other/path"],
    });
    const id = created.note!.id;

    const res = updateNote(db, { id, scope: "all" });
    expect(res.ok).toBe(true);
    expect(res.note!.scope).toBe("all");
    expect(res.note!.projects).toEqual([]);

    const history = noteHistory(db, id);
    expect(history?.revisions.length).toBeGreaterThan(0);
    expect(history?.revisions[0].scope).toBe("project");
    expect(history?.revisions[0].projects).toEqual(["/old/path", "/other/path"]);
  });
});
