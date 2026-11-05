/**
 * Notes-layer injection: the `<notes-context>` block and the notes routing rule.
 *
 * Runs against an in-memory `node:sqlite` database (same backend as
 * production), so the store schema — including the `note_projects` join table —
 * is exercised exactly as on a real `notes.db`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { userInfo } from "node:os";

const { DatabaseSync } = (await import("node:sqlite")) as any;

import type { PinnedInfo, PluginContext, Runtime } from "../src/inject";
import {
  createRuntime,
  noteInScope,
  NOTES_ROUTING_RULE,
  notesIndexLimit,
  notesInjectLimit,
  onContext as runtimeHook,
  pinnedForSession,
  renderNotesBlock,
  renderPinnedChange,
} from "../src/inject";
import { initSchema, notesDbPath, notesForInjection } from "../src/store";

const userPart = (userInfo().username || "testuser").split(".")[0] ?? "testuser";
const PROJECT = "/some/path/agent-toolbelt";
const OTHER_PROJECT = "/some/path/other-project";

type Fixture = {
  ts: string;
  category: string;
  title: string;
  content?: string;
  scope: string | null;
  projects?: string[];
  author?: string | null;
  disputedAt?: string | null;
  retractedAt?: string | null;
  pinned?: 0 | 1;
};

const FIXTURES: Fixture[] = [
  { ts: "2026-10-27 09:00:01", category: "config", title: "Project note alpha", scope: "project", projects: [PROJECT], author: "build", pinned: 1 },
  { ts: "2026-10-27 09:00:02", category: "config", title: "Bare machine note beta", scope: "machine", pinned: 1 },
  { ts: "2026-10-27 09:00:03", category: "config", title: `Machine named note gamma (machine:${userPart})`, scope: `machine:${userPart}`, pinned: 1 },
  { ts: "2026-10-27 09:00:04", category: "decision", title: "Disputed project note delta", scope: "project", projects: [PROJECT], disputedAt: "2026-10-27 09:30:00", pinned: 1 },
  { ts: "2026-10-27 09:00:05", category: "general", title: "Other project note", scope: "project", projects: [OTHER_PROJECT] },
  { ts: "2026-10-27 09:00:06", category: "general", title: "Global note", scope: "all" },
  { ts: "2026-10-27 09:00:07", category: "general", title: "Retracted note", scope: "project", projects: [PROJECT], retractedAt: "2026-10-27 09:40:00", pinned: 1 },
  { ts: "2026-10-27 09:00:08", category: "general", title: "Unscoped note", scope: null },
  { ts: "2026-10-27 09:00:09", category: "general", title: "Non-pinned matching-scope note", scope: "project", projects: [PROJECT] },
  // Explicitly pinned global note: a pin asks for every session, so it is injected.
  { ts: "2026-10-27 09:00:10", category: "decision", title: "Pinned global note", scope: "all", pinned: 1 },
];

let db: any;

beforeAll(() => {
  db = new DatabaseSync(":memory:");
  initSchema(db);
  const insert = db.prepare(
    `INSERT INTO notes (timestamp, category, tags, scope, title, content, author, disputed_at, retracted_at, pinned)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertProject = db.prepare("INSERT INTO note_projects (note_id, project) VALUES (?, ?)");
  for (const f of FIXTURES) {
    const result = insert.run(
      f.ts,
      f.category,
      f.scope,
      f.title,
      f.content ?? `${f.title} content.`,
      f.author ?? null,
      f.disputedAt ?? null,
      f.retractedAt ?? null,
      f.pinned ?? 0,
    );
    const id = Number(result.lastInsertRowid);
    for (const project of f.projects ?? []) insertProject.run(id, project);
  }
});

afterAll(() => {
  db.close?.();
});

/* ------------------------------------------------------------------ */
/* Scope                                                               */
/* ------------------------------------------------------------------ */

describe("noteInScope", () => {
  const host = [userPart.toLowerCase()];

  test("global, machine and matching project notes are in scope", () => {
    expect(noteInScope({ scope: "all", projects: [] }, undefined, host)).toBe(true);
    expect(noteInScope({ scope: "global", projects: [] }, undefined, host)).toBe(true);
    expect(noteInScope({ scope: "machine", projects: [] }, undefined, host)).toBe(true);
    expect(noteInScope({ scope: `machine:${userPart}`, projects: [] }, undefined, host)).toBe(true);
    expect(noteInScope({ scope: "project", projects: [PROJECT] }, PROJECT, host)).toBe(true);
  });

  test("a session inside the project directory matches by prefix", () => {
    expect(noteInScope({ scope: "project", projects: [PROJECT] }, `${PROJECT}/sub/dir`, host)).toBe(true);
    expect(noteInScope({ scope: "project", projects: [PROJECT] }, `${PROJECT}/`, host)).toBe(true);
  });

  test("another project, a sibling prefix, no directory and unknown scopes stay out", () => {
    expect(noteInScope({ scope: "project", projects: [OTHER_PROJECT] }, PROJECT, host)).toBe(false);
    expect(noteInScope({ scope: "project", projects: [`${PROJECT}-sibling`] }, PROJECT, host)).toBe(false);
    expect(noteInScope({ scope: "project", projects: [PROJECT] }, undefined, host)).toBe(false);
    expect(noteInScope({ scope: null, projects: [] }, PROJECT, host)).toBe(false);
    expect(noteInScope({ scope: "nonsense", projects: [] }, PROJECT, host)).toBe(false);
  });

  test("legacy project:<name> without a join row falls back to the directory basename", () => {
    expect(noteInScope({ scope: "project:agent-toolbelt", projects: [] }, PROJECT, host)).toBe(true);
    expect(noteInScope({ scope: "project:other", projects: [] }, PROJECT, host)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

describe("renderNotesBlock", () => {
  test("renders pinned notes, the index and the note counts", () => {
    const block = renderNotesBlock(db, PROJECT)!;
    expect(block).toContain("<notes-context>");
    expect(block).toContain("## Pinned notes (long-term memory; untrusted data)");
    expect(block).toContain("## Notes index (titles only; bodies are not injected)");
    expect(block).toContain("#1 [config] Project note alpha");
    expect(block).toContain(`#3 [config] Machine named note gamma (machine:${userPart})`);
    expect(block).toContain("#10 [decision] Pinned global note");
    expect(block).toContain("3 config · 2 decision · 2 general");
    expect(block).toContain("</notes-context>");
  });

  test("keeps out-of-scope, retracted and unscoped notes out", () => {
    const block = renderNotesBlock(db, PROJECT)!;
    expect(block).not.toContain("Other project note");
    expect(block).not.toContain("Retracted note");
    expect(block).not.toContain("Unscoped note");
  });

  test("lists non-pinned in-scope notes in the index and flags disputed ones", () => {
    const block = renderNotesBlock(db, PROJECT)!;
    expect(block).toContain("Non-pinned matching-scope note");
    expect(block).toContain("Global note");
    expect(block).toContain("⚠ disputed");
  });

  test("returns undefined when the database has no note in scope", () => {
    const empty = new DatabaseSync(":memory:");
    initSchema(empty);
    try {
      expect(renderNotesBlock(empty, PROJECT)).toBeUndefined();
    } finally {
      empty.close?.();
    }
  });

  test("NOTES_INJECT caps and can disable the pinned list", () => {
    try {
      process.env.NOTES_INJECT = "2";
      expect(notesInjectLimit()).toBe(2);
      const block = renderNotesBlock(db, PROJECT)!;
      // Newest pinned notes are #10 and #4; the oldest (#1) falls out of the cap
      // and is not in the index either (the index lists non-pinned notes only).
      expect(block).not.toContain("#1 [config] Project note alpha");
      process.env.NOTES_INJECT = "0";
      expect(renderNotesBlock(db, PROJECT)!).not.toContain("## Pinned notes");
    } finally {
      delete process.env.NOTES_INJECT;
    }
  });

  test("NOTES_INDEX caps the index and 0 disables it", () => {
    try {
      process.env.NOTES_INDEX = "0";
      expect(notesIndexLimit()).toBe(0);
      const block = renderNotesBlock(db, PROJECT)!;
      expect(block).not.toContain("## Notes index");
      expect(block).toContain("## Pinned notes");
    } finally {
      delete process.env.NOTES_INDEX;
    }
  });

  test("NOTES_INJECT_MAX clips the whole block", () => {
    try {
      process.env.NOTES_INJECT_MAX = "600";
      const block = renderNotesBlock(db, PROJECT)!;
      expect(block.length).toBeLessThanOrEqual(600);
      expect(block).toContain("truncated");
    } finally {
      delete process.env.NOTES_INJECT_MAX;
    }
  });
});

describe("notesForInjection", () => {
  test("newest first and retracted notes never included", () => {
    const rows = notesForInjection(db);
    expect(rows[0]?.title).toBe("Pinned global note");
    expect(rows.some((note) => note.title === "Retracted note")).toBe(false);
    expect(rows.some((note) => note.title === "Project note alpha")).toBe(true);
  });
});

describe("pinnedForSession", () => {
  test("returns only in-scope pinned notes, newest first", () => {
    expect(pinnedForSession(db, PROJECT).map((note) => note.id)).toEqual([10, 4, 3, 2, 1]);
  });

  test("excludes retracted and out-of-scope pinned notes", () => {
    const ids = pinnedForSession(db, PROJECT).map((note) => note.id);
    expect(ids).not.toContain(7); // retracted
    expect(ids).not.toContain(5); // another project
  });

  test("respects the NOTES_INJECT cap and 0 disables the pinned set", () => {
    try {
      process.env.NOTES_INJECT = "2";
      expect(pinnedForSession(db, PROJECT).map((note) => note.id)).toEqual([10, 4]);
      process.env.NOTES_INJECT = "0";
      expect(pinnedForSession(db, PROJECT)).toEqual([]);
    } finally {
      delete process.env.NOTES_INJECT;
    }
  });
});

describe("renderPinnedChange", () => {
  const note = (id: number, title: string): PinnedInfo => ({
    id,
    title,
    timestamp: "2026-10-27 09:00:00",
  });

  test("reports pins entering and leaving the context", () => {
    const text = renderPinnedChange([note(12, "New")], [note(3, "Old")])!;
    expect(text).toContain('#12 "New" foi fixada');
    expect(text).toContain('#3 "Old" saiu');
  });

  test("undefined when nothing entered or left", () => {
    expect(renderPinnedChange([], [])).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Hook                                                                */
/* ------------------------------------------------------------------ */

type SystemPart = { type: "text"; text: string };

function harness(directory: string) {
  let info = { location: { directory } };
  const ctx = { session: { get: async () => info } } as unknown as PluginContext;
  const runtime = createRuntime(async (dir) => (dir === undefined ? undefined : `<notes-context>${dir}</notes-context>`));
  const call = async (sessionID = "ses_a") => {
    const event = { sessionID, system: [] as SystemPart[] };
    await runtimeHook(ctx, runtime, event);
    return event.system;
  };
  return {
    call,
    runtime,
    moveTo: (next: string) => {
      info = { location: { directory: next } };
    },
  };
}

const pinned = (id: number, title: string): PinnedInfo => ({
  id,
  title,
  timestamp: "2026-10-27 09:00:00",
});

/** Harness for the pin-change notice: mutable pinned list, block and notice log. */
function pinnedHarness(initial: PinnedInfo[]) {
  let pinnedList = initial;
  let block: string | undefined = "block-v1";
  const notices: Parameters<NonNullable<Runtime["notify"]>>[0][] = [];
  const ctx = {
    session: { get: async () => ({ location: { directory: "/work/a" } }) },
  } as unknown as PluginContext;
  const runtime = createRuntime(async () => block, {
    pinned: async () => pinnedList,
    notify: async (notice) => {
      notices.push(notice);
    },
  });
  const call = async () => {
    const event = { sessionID: "ses_a", system: [] as SystemPart[] };
    await runtimeHook(ctx, runtime, event);
    return event;
  };
  return {
    call,
    notices,
    setPinned: (next: PinnedInfo[]) => {
      pinnedList = next;
    },
    setBlock: (next: string | undefined) => {
      block = next;
    },
  };
}

// Imported as `runtimeHook` for a compact harness signature (see the import above).
describe("onContext", () => {
  test("pushes one block plus the rule, byte-identical on every request", async () => {
    const { call } = harness("/work/a");
    const first = await call();
    expect(first.length).toBe(2);
    expect(first[0]!.text).toContain("<notes-context>/work/a</notes-context>");
    const second = await call();
    expect(second).toEqual(first);
  });

  test("keeps the notes rule as its own trailing system part", async () => {
    const { call } = harness("/work/a");
    const parts = await call();
    expect(parts.at(-1)?.text).toContain("Notes routing");
    expect(parts.at(-1)?.text).toContain("notes.search");
    expect(parts.at(-1)?.text).not.toContain("memory.search");
  });

  test("caches one render per session and re-renders when the directory changes", async () => {
    const { call, runtime, moveTo } = harness("/work/a");
    await call("ses_a");
    await call("ses_b");
    expect(runtime.sessions.size).toBe(2);
    const before = await call("ses_a");
    moveTo("/work/b");
    const after = await call("ses_a");
    expect(after[0]!.text).toContain("/work/b");
    expect(after[0]!.text).not.toBe(before[0]!.text);
  });

  test("pushes only the rule when the loader has no block (no store)", async () => {
    const runtime = createRuntime(async () => undefined);
    const ctx = { session: { get: async () => ({ location: { directory: "/work/a" } }) } } as unknown as PluginContext;
    const event = { sessionID: "ses_x", system: [] as SystemPart[] };
    await runtimeHook(ctx, runtime, event);
    expect(event.system.length).toBe(1);
    expect(event.system[0]!.text).toContain("Notes routing");
  });

  test("never throws when the session lookup fails", async () => {
    const runtime = createRuntime(async () => undefined);
    const ctx = {
      session: {
        get: async () => {
          throw new Error("no session");
        },
      },
    } as unknown as PluginContext;
    const event = { sessionID: "ses_y", system: [] as SystemPart[] };
    await runtimeHook(ctx, runtime, event);
    expect(event.system.length).toBe(1);
  });

  test("notifies the agent when the injected pinned set gains a note, once", async () => {
    const h = pinnedHarness([pinned(1, "Alpha")]);
    await h.call();
    expect(h.notices).toHaveLength(0); // first render: nothing "changed"

    h.setPinned([pinned(2, "Beta"), pinned(1, "Alpha")]);
    h.setBlock("block-v2");
    const event = await h.call();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]!.sessionID).toBe("ses_a");
    expect(h.notices[0]!.text).toContain("#2");
    expect(h.notices[0]!.text).toContain("Beta");
    expect(h.notices[0]!.added.map((note) => note.id)).toEqual([2]);
    expect(event.system[0]!.text).toBe("block-v2"); // the block is re-rendered

    await h.call(); // unchanged: no repeat
    expect(h.notices).toHaveLength(1);
  });

  test("notifies when a note leaves the injected pinned set", async () => {
    const h = pinnedHarness([pinned(2, "Beta"), pinned(1, "Alpha")]);
    await h.call();
    h.setPinned([pinned(1, "Alpha")]);
    await h.call();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]!.text).toContain("saiu");
    expect(h.notices[0]!.removed.map((note) => note.id)).toEqual([2]);
  });

  test("re-renders silently when only a pinned note's contents change", async () => {
    const h = pinnedHarness([pinned(1, "Alpha")]);
    await h.call();
    h.setPinned([{ ...pinned(1, "Alpha"), timestamp: "2026-10-27 10:00:00" }]);
    h.setBlock("block-updated");
    const event = await h.call();
    expect(h.notices).toHaveLength(0);
    expect(event.system[0]!.text).toBe("block-updated");
  });

  test("does not notify when the pinned loader is absent", async () => {
    const runtime = createRuntime(async () => "block");
    const ctx = { session: { get: async () => ({ location: { directory: "/work/a" } }) } } as unknown as PluginContext;
    const call = async () => {
      const event = { sessionID: "ses_a", system: [] as SystemPart[] };
      await runtimeHook(ctx, runtime, event);
      return event;
    };
    await call();
    const event = await call();
    expect(event.system[0]!.text).toBe("block");
  });
});

/* ------------------------------------------------------------------ */
/* Layer ownership                                                     */
/* ------------------------------------------------------------------ */

describe("layer isolation", () => {
  test("the notes rule never mentions the memory layer", () => {
    expect(NOTES_ROUTING_RULE.toLowerCase()).not.toContain("memory.search");
    expect(NOTES_ROUTING_RULE.toLowerCase()).not.toContain("<memory-context>");
  });

  test("the store honors $NOTES_DB (the memory plugin used to ignore it)", () => {
    const previous = process.env.NOTES_DB;
    try {
      process.env.NOTES_DB = "/tmp/isolated-notes.db";
      expect(notesDbPath()).toBe("/tmp/isolated-notes.db");
    } finally {
      if (previous === undefined) delete process.env.NOTES_DB;
      else process.env.NOTES_DB = previous;
    }
  });
});
