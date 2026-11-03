/**
 * Store tests — the data layer's pure helpers and schema migrations.
 *
 * Runs against an in-memory `node:sqlite` database (same backend as
 * production, `:memory:` path), so migrations are exercised exactly as they
 * run on first open of a real `notes.db`.
 */

import { describe, expect, test } from "bun:test";

const { DatabaseSync } = (await import("node:sqlite")) as any;

import { addNote, initSchema, normalizeCategory } from "../src/store";

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
/* migration 007 (remove legacy '#' prefix from stored categories)      */
/* ------------------------------------------------------------------ */

describe("MIGRATION_007 (categories without '#')", () => {
  test("legacy '#'-prefixed rows are stripped on upgrade (v6 -> v7)", async () => {
    const db = emptyDb();
    initSchema(db); // opens a pre-v7 DB, schema in place (user_version = 7 now)

    // Rewind to the legacy state a v6 DB would have: schema v6 +
    // '#'-prefixed categories written by the old normalizeCategory.
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
    expect((db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version).toBe(7);
  });

  test("plain categories and plain writes survive untouched", async () => {
    const db = emptyDb();
    initSchema(db);
    initSchema(db); // idempotent, already at v7

    const res = addNote(db, {
      category: "problem",
      title: "t",
      content: "Symptom: x. Cause: y. Solution: z.",
    });
    expect(res.ok).toBe(true);
    expect(res.note!.category).toBe("problem");

    // A plain value must not gain a '#' prefix (legacy behavior is gone).
    const db2 = emptyDb();
    initSchema(db2);
    const res2 = addNote(db2, {
      category: "#decision",
      title: "t2",
      content: "ok",
    });
    expect(res2.ok).toBe(true);
    expect(res2.note!.category).toBe("decision");
  });

  test("addNote rejects incomplete #problem notes with the new message", async () => {
    const db = emptyDb();
    initSchema(db);
    const res = addNote(db, { category: "problem", title: "t", content: "just a note" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("problem sem Symptom, Cause, Solution.");
  });
});
