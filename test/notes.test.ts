/**
 * Tool-path regression tests for the `notes` wrapper (notes.ts).
 *
 * These drive the REAL `add.execute` / `update.execute` functions and assert
 * what actually lands in the DB — the exact class of bug that produced note
 * #102, where the tool's add/update schemas had no `project` field, so `zod`
 * stripped it and only `scope` reached the store (a `scope='project'` row
 * with a blank `project` column).
 *
 * The tool's `requireStore()` opens a memoized DB at `notesDbPath()`, which
 * honours `process.env.NOTES_DB`; it is created lazily on first call. We
 * point it at a throwaway file below, so no test ever touches the live DB.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

// Throwaway DB. Must be set before the first `requireStore()` call in this
// process (only this file calls it — see no other test/ file opens the store),
// which happens inside `beforeAll`.
const dbPath = join(tmpdir(), `notes-tool-${randomUUID()}.db`);
process.env.NOTES_DB = dbPath;

import { add, update } from "../notes";
import { requireStore } from "../src/store";

let db: any;

beforeAll(async () => {
  db = (await requireStore()).db;
});

afterAll(() => {
  // best-effort cleanup of a throwaway file
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* ignore */
  }
});

type NoteRow = {
  id: number;
  scope: string | null;
  project: string | null;
  title: string;
  category: string;
};

/** The stored row for a note, keyed by its (unique) title. */
function byTitle(title: string): NoteRow | undefined {
  return (
    db
      .prepare("SELECT id, scope, project, title, category FROM notes WHERE title = ?")
      .get(title)
  ) as NoteRow | undefined;
}

describe("notes tool: project scope (regression for note #102)", () => {
  test("add: scope='project' + project persists the absolute path", async () => {
    const res = await add.execute({
      category: "decision",
      title: "T1 add-project",
      content: "A decision note.",
      scope: "project",
      project: "/abs/project/x",
    });
    expect(res.metadata?.exit).toBe(0);
    expect(res.metadata?.rejected).toBeUndefined();
    const row = byTitle("T1 add-project");
    expect(row, `note '${row?.title}' not found`).not.toBeUndefined();
    expect(row?.scope).toBe("project");
    expect(row?.project).toBe("/abs/project/x");
  });

  test("add: scope='project' without project is rejected and not persisted", async () => {
    const res = await add.execute({
      category: "decision",
      title: "T2 missing-project",
      content: "A decision note.",
      scope: "project",
      // no explicit project
    });
    expect(res.metadata?.rejected).toBe(true);
    expect(res.content).toContain("non-empty 'project' path");
    expect(byTitle("T2 missing-project")).toBeUndefined();
  });

  test("add: legacy scope='project:<name>' without an explicit project is rejected", async () => {
    const res = await add.execute({
      category: "decision",
      title: "T3 legacy-scope",
      content: "A decision note.",
      scope: "project:legacyname",
      // legacy format in scope, no explicit project field -> rejected
    });
    expect(res.metadata?.rejected).toBe(true);
    expect(res.content).toContain("non-empty 'project' path");
    expect(byTitle("T3 legacy-scope")).toBeUndefined();
  });

  test("update: sets the project for a project-scope note", async () => {
    await add.execute({
      category: "decision",
      title: "T4 update-project",
      content: "Body.",
      scope: "project",
      project: "/abs/orig",
    });
    const id = byTitle("T4 update-project")?.id;
    expect(id).not.toBeUndefined();
    const res = await update.execute({
      id: id!,
      title: "T4 update-project",
      content: "Body2.",
      scope: "project",
      project: "/abs/new",
    });
    expect(res.metadata?.exit).toBe(0);
    expect(res.metadata?.rejected).toBeUndefined();
    const row = byTitle("T4 update-project");
    expect(row?.scope).toBe("project");
    expect(row?.project).toBe("/abs/new");
  });

  test("update: scope='project' without project is rejected (project unchanged)", async () => {
    await add.execute({
      category: "decision",
      title: "T5 update-missing",
      content: "Body.",
      scope: "project",
      project: "/abs/orig",
    });
    const id = byTitle("T5 update-missing")?.id;
    expect(id).not.toBeUndefined();
    const res = await update.execute({
      id: id!,
      title: "T5 update-missing",
      content: "Body2.",
      scope: "project",
      // no project
    });
    expect(res.metadata?.rejected).toBe(true);
    // project must be untouched when the update is rejected
    expect(byTitle("T5 update-missing")?.project).toBe("/abs/orig");
  });

  test("update: switching scope to 'all' clears the project path", async () => {
    await add.execute({
      category: "decision",
      title: "T6 clear-project",
      content: "Body.",
      scope: "project",
      project: "/abs/orig",
    });
    const id = byTitle("T6 clear-project")?.id;
    expect(id).not.toBeUndefined();
    const res = await update.execute({
      id: id!,
      title: "T6 clear-project",
      content: "Body2.",
      scope: "all",
      // moving off project scope drops the path
    });
    expect(res.metadata?.exit).toBe(0);
    expect(res.metadata?.rejected).toBeUndefined();
    const row = byTitle("T6 clear-project");
    expect(row?.scope).toBe("all");
    expect(row?.project).toBeNull();
  });

  test("add: project is dropped when scope is not 'project'", async () => {
    const res = await add.execute({
      category: "decision",
      title: "T7 project-ignored",
      content: "Body.",
      scope: "all",
      project: "/abs/ignored", // not project scope -> path has no meaning, is not stored
    });
    expect(res.metadata?.exit).toBe(0);
    expect(res.metadata?.rejected).toBeUndefined();
    expect(byTitle("T7 project-ignored")?.project).toBeNull();
  });
});
