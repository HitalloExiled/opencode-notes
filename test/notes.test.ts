/**
 * Tool-path regression tests for the `notes` wrapper (notes.ts).
 *
 * These drive the REAL `add.execute` / `update.execute` functions and assert
 * what actually lands in the DB — the exact class of bug that produced note
 * #102, where the tool's add/update schemas had no project field, so `zod`
 * stripped it and only `scope` reached the store (a `scope='project'` row
 * with a blank project). Since v9 the project set lives in the join table
 * `note_projects` (multi-project), so these tests read the join table.
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
  title: string;
  category: string;
};

/** The stored row for a note, keyed by its (unique) title. */
function byTitle(title: string): NoteRow | undefined {
  return (
    db
      .prepare("SELECT id, scope, title, category FROM notes WHERE title = ?")
      .get(title)
  ) as NoteRow | undefined;
}

/** The note's project paths, read from the join table (ordered). */
function projectsOf(noteId: number): string[] {
  return db
    .prepare("SELECT project FROM note_projects WHERE note_id = ? ORDER BY project")
    .all(noteId)
    .map((r: { project: string }) => r.project);
}

describe("notes tool: project scope (regression for note #102)", () => {
  test("add: scope='project' + projects persists the absolute path(s)", async () => {
    const res = await add.execute({
      category: "decision",
      title: "T1 add-project",
      content: "A decision note.",
      scope: "project",
      projects: ["/abs/project/x"],
    });
    expect(res.metadata?.exit).toBe(0);
    expect(res.metadata?.rejected).toBeUndefined();
    const row = byTitle("T1 add-project");
    expect(row, `note '${row?.title}' not found`).not.toBeUndefined();
    expect(row?.scope).toBe("project");
    expect(projectsOf(row!.id)).toEqual(["/abs/project/x"]);
  });

  test("add: several project paths persist all of them (multi-project)", async () => {
    const res = await add.execute({
      category: "decision",
      title: "T1b add-multi-project",
      content: "A decision note.",
      scope: "project",
      projects: ["/abs/b", "/abs/a", "/abs/b", "  /abs/a  ", ""],
    });
    expect(res.metadata?.exit).toBe(0);
    const row = byTitle("T1b add-multi-project");
    expect(row, `note '${row?.title}' not found`).not.toBeUndefined();
    // trim + dedupe, stored via the join table
    expect(projectsOf(row!.id)).toEqual(["/abs/a", "/abs/b"]);
  });

  test("add: scope='project' without projects is rejected and not persisted", async () => {
    const res = await add.execute({
      category: "decision",
      title: "T2 missing-projects",
      content: "A decision note.",
      scope: "project",
      // no explicit projects array
    });
    expect(res.metadata?.rejected).toBe(true);
    expect(res.content).toContain("at least one project path");
    expect(byTitle("T2 missing-projects")).toBeUndefined();
  });

  test("add: legacy scope='project:<name>' without explicit projects is rejected", async () => {
    const res = await add.execute({
      category: "decision",
      title: "T3 legacy-scope",
      content: "A decision note.",
      scope: "project:legacyname",
      // legacy format in scope, no projects array -> rejected
    });
    expect(res.metadata?.rejected).toBe(true);
    expect(res.content).toContain("at least one project path");
    expect(byTitle("T3 legacy-scope")).toBeUndefined();
  });

  test("update: sets the project paths for a project-scope note", async () => {
    await add.execute({
      category: "decision",
      title: "T4 update-project",
      content: "Body.",
      scope: "project",
      projects: ["/abs/orig"],
    });
    const id = byTitle("T4 update-project")?.id;
    expect(id).not.toBeUndefined();
    const res = await update.execute({
      id: id!,
      title: "T4 update-project",
      content: "Body2.",
      scope: "project",
      projects: ["/abs/new"],
    });
    expect(res.metadata?.exit).toBe(0);
    expect(res.metadata?.rejected).toBeUndefined();
    expect(projectsOf(id!)).toEqual(["/abs/new"]);
    const row = byTitle("T4 update-project");
    expect(row?.scope).toBe("project");
  });

  test("update: multi-project set is fully replaced", async () => {
    await add.execute({
      category: "decision",
      title: "T4b replace-projects",
      content: "Body.",
      scope: "project",
      projects: ["/abs/orig", "/abs/extra"],
    });
    const id = byTitle("T4b replace-projects")?.id;
    expect(id).not.toBeUndefined();
    await update.execute({
      id: id!,
      title: "T4b replace-projects",
      content: "Body2.",
      projects: ["/abs/new"],
    });
    expect(projectsOf(id!)).toEqual(["/abs/new"]);
  });

  test("update: scope='project' without projects is rejected (projects unchanged)", async () => {
    await add.execute({
      category: "decision",
      title: "T5 update-missing",
      content: "Body.",
      scope: "project",
      projects: ["/abs/orig"],
    });
    const id = byTitle("T5 update-missing")?.id;
    expect(id).not.toBeUndefined();
    const res = await update.execute({
      id: id!,
      title: "T5 update-missing",
      content: "Body2.",
      scope: "project",
      // no projects
    });
    expect(res.metadata?.rejected).toBe(true);
    // projects must be untouched when the update is rejected
    expect(projectsOf(id!)).toEqual(["/abs/orig"]);
  });

  test("update: switching scope to 'all' clears the project paths", async () => {
    await add.execute({
      category: "decision",
      title: "T6 clear-projects",
      content: "Body.",
      scope: "project",
      projects: ["/abs/orig"],
    });
    const id = byTitle("T6 clear-projects")?.id;
    expect(id).not.toBeUndefined();
    const res = await update.execute({
      id: id!,
      title: "T6 clear-projects",
      content: "Body2.",
      scope: "all",
      // moving off project scope drops the paths
    });
    expect(res.metadata?.exit).toBe(0);
    expect(res.metadata?.rejected).toBeUndefined();
    const row = byTitle("T6 clear-projects");
    expect(row?.scope).toBe("all");
    expect(projectsOf(id!)).toEqual([]);
  });

  test("add: projects are dropped when scope is not 'project'", async () => {
    const res = await add.execute({
      category: "decision",
      title: "T7 projects-ignored",
      content: "Body.",
      scope: "all",
      projects: ["/abs/ignored"], // not project scope -> paths have no meaning, are not stored
    });
    expect(res.metadata?.exit).toBe(0);
    expect(res.metadata?.rejected).toBeUndefined();
    const row = byTitle("T7 projects-ignored");
    expect(row?.scope).toBe("all");
    expect(projectsOf(row!.id)).toEqual([]);
  });
});
