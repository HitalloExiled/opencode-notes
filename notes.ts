/**
 * notes — long-term memory tools (tool definitions only; registration lives
 * in ./index.ts under the "notes" namespace, memory.* pattern).
 *
 * In Code Mode these are callable as tools.notes.add / tools.notes.search /
 * ...; in regular sessions the definitions keep the underscored names
 * (notes_add, notes_search, ...) exactly as before the namespacing.
 *
 * The tools talk to `notes.db` directly through `./src/store.ts` (the same
 * data layer as the side-panel GUI). There is no external CLI. The wrapper
 * exposes NO destructive operation: add / update / confirm / dispute /
 * retract / history / restore / pin / unpin / view / search / doctor.
 * `update` and the trust flags change an existing note; `retract` only hides
 * it (reversible); `restore` brings back an old revision. Nothing is deleted,
 * and every `update`/`restore` keeps the previous version readable via
 * `history`.
 *
 * Safety:
 *  - values are bound as SQL parameters (no string interpolation) => note
 *    content is never interpreted; quotes, `;`, `$(...)`, emoji and newlines
 *    stay literal;
 *  - the `#problem` guardrail refuses to save without Symptom/Cause/Solution,
 *    turning the skill's convention into something the tool *guarantees*.
 */

import { z } from "zod";
import {
  addNote,
  confirmNote,
  disputeNote,
  doctorInfo,
  listNotes,
  noteHistory,
  pinNote,
  renderAdd,
  renderConfirm,
  renderDispute,
  renderDoctor,
  renderHistory,
  renderPin,
  renderRestore,
  renderRetract,
  renderRows,
  renderUnpin,
  renderUpdate,
  requireStore,
  restoreNote,
  retractNote,
  searchNotes,
  unpinNote,
  updateNote,
  viewNote,
  parseScope,
} from "./src/store.js";

const CATEGORIES = [
  "problem",
  "decision",
  "config",
  "snippet",
  "architecture",
  "user",
  "general",
] as const;

/** Catalog group label. Code Mode truncates this at ~119 characters. */
export const NOTES_NAMESPACE = {
  name: "notes",
  description:
    "Curated long-term memory: decisions, solved problems, config, snippets. Nothing is deleted.",
} as const;

type ToolResult = { content: string; metadata?: Record<string, unknown> };

/**
 * A project-scoped note must carry at least one real project path. The legacy
 * `project:<name>` free-form in `scope` is no longer accepted by the tools —
 * paths live in their own `projects` array (absolute, no spaces, one or more
 * entries). Returns a rejected result when the rule is violated, otherwise
 * `null`.
 */
function requireProjects(args: {
  scope?: string | undefined;
  projects?: string[] | undefined;
}): ToolResult | null {
  const type = args.scope ? parseScope(args.scope)?.type : undefined;
  if (type !== "project") return null;
  const projects = (args.projects ?? [])
    .map((p) => p.trim())
    .filter(Boolean);
  if (projects.length === 0) {
    return {
      content:
        "❌ scope='project' requires at least one project path in the " +
        "`projects` array (absolute, no spaces).\n" +
        "Use scope: 'project' and projects: ['/abs/path/to/project'] " +
        "(one or more paths).",
      metadata: { rejected: true },
    };
  }
  return null;
}

const ID_DESC = "Note id (as shown by notes.search).";

/** Normalize for comparison: strip accents, lowercase. */
function norm(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Required sections missing from a #problem note. */
function missingProblemSections(content: string): string[] {
  const text = norm(content);
  const required: Array<[string, string]> = [
    ["Symptom", "symptom"],
    ["Cause", "cause"],
    ["Solution", "solution"],
  ];
  return required.filter(([, needle]) => !text.includes(needle)).map(([label]) => label);
}

/** Run a store mutation, turning a failure into the tool's error text. */
function fail(error: string): ToolResult {
  return { content: `❌ ${error}`, metadata: { exit: 1, rejected: true } };
}

const addInput = z.object({
  category: z
    .enum(CATEGORIES)
    .describe("Note category (problem for solved problems)."),
  title: z
    .string()
    .describe("Short title; for problem, the symptom."),
  content: z
    .string()
    .describe("Body; problem needs Symptom, Cause, Solution."),
  tags: z
    .string()
    .optional()
    .describe("Space-separated keywords, no '#'."),
  scope: z
    .string()
    .optional()
    .describe("'all'/'global' (default), 'machine' or 'project'."),
  projects: z
    .array(z.string().min(1, "each project path must be non-empty"))
    .optional()
    .describe("Absolute project paths; required for scope=project."),
  author: z
    .string()
    .optional()
    .describe("Attribution: agent or human name."),
});
type AddArgs = z.infer<typeof addInput>;

export const add = {
  name: "add",
  description:
    "Save a note. If category=problem, content needs Symptom, Cause and Solution. " +
    "Search first for duplicates.",
  input: addInput,
  async execute(args: AddArgs): Promise<ToolResult> {
    const category = args.category;
    const content = args.content ?? "";
    const tags = args.tags ?? "";
    const author = args.author?.trim() || undefined;
    const projects = (args.projects ?? [])
      .map((p) => p.trim())
      .filter(Boolean);

    const projErr = requireProjects({ scope: args.scope, projects: args.projects });
    if (projErr) return projErr;

    if (category === "problem") {
      const missing = missingProblemSections(content);
      if (missing.length > 0) {
        return {
          content:
            `❌ Note NOT saved. Missing from content: ${missing.join(", ")}.\n\n` +
            "The convention requires a root cause and a reproducible solution, not a restated symptom.\n" +
            "Rewrite the content in this format and call again:\n" +
            "Symptom: <what was observed / error message> | " +
            "Cause: <root cause> | Solution: <exact command or steps> | " +
            "Files: <paths touched, optional>",
          metadata: { rejected: true, missing },
        };
      }
    }

    if (!args.title.trim()) {
      return { content: "❌ empty title.", metadata: { rejected: true } };
    }

    const { db } = await requireStore();
    const result = addNote(db, { category, title: args.title, content, tags, author, scope: args.scope, projects });
    if (!result.ok) return fail(result.error);
    return { content: renderAdd(result), metadata: { category, author, exit: 0 } };
  },
};

const updateInput = z.object({
  id: z.number().int().positive().describe(ID_DESC),
  title: z.string().optional().describe("New title, only if wrong."),
  content: z.string().optional().describe("Replacement content for a wrong note."),
  tags: z
    .string()
    .optional()
    .describe("New keywords; empty string clears them."),
  category: z
    .enum(CATEGORIES)
    .optional()
    .describe("New category, only if filed wrongly."),
  scope: z
    .string()
    .optional()
    .describe("New scope; empty clears it."),
  projects: z
    .array(z.string().min(1, "each project path must be non-empty"))
    .optional()
    .describe("Absolute project paths; required for scope=project."),
});
type UpdateArgs = z.infer<typeof updateInput>;

export const update = {
  name: "update",
  description:
    "Correct a wrong note (last resort), never append facts. Old version stays in notes.history.",
  input: updateInput,
  async execute(args: UpdateArgs): Promise<ToolResult> {
    if (
      args.title === undefined &&
      args.content === undefined &&
      args.tags === undefined &&
      args.category === undefined &&
      args.scope === undefined &&
      args.projects === undefined
    ) {
      return {
        content:
          "❌ Nothing to update. Pass at least one of " +
          "title/content/tags/category/scope/projects.\n" +
          "If the goal is to record new information, use notes.add instead.",
        metadata: { rejected: true },
      };
    }

    const projErr = requireProjects({ scope: args.scope, projects: args.projects });
    if (projErr) return projErr;

    if (args.title !== undefined && !args.title.trim()) {
      return { content: "❌ empty title.", metadata: { rejected: true } };
    }
    if (args.content !== undefined && !args.content.trim()) {
      return { content: "❌ empty content.", metadata: { rejected: true } };
    }
    if (args.category === "problem" && args.content !== undefined) {
      const missing = missingProblemSections(args.content);
      if (missing.length > 0) {
        return {
          content:
            `❌ Note NOT updated. Missing from content: ${missing.join(", ")}.\n` +
            "A #problem note needs a root cause and a reproducible solution.\n" +
            "Format: Symptom: ... | Cause: ... | Solution: ... | Files: ... (optional)",
          metadata: { rejected: true, missing },
        };
      }
    }

    const { db } = await requireStore();
    const result = updateNote(db, {
      id: args.id,
      title: args.title,
      tags: args.tags,
      content: args.content,
      category: args.category,
      scope: args.scope,
      projects:
        args.projects !== undefined
          ? (args.projects ?? []).map((p) => p.trim()).filter(Boolean)
          : undefined,
    });
    if (!result.ok) return fail(result.error);
    return { content: renderUpdate(result), metadata: { id: args.id, exit: 0 } };
  },
};

const searchInput = z.object({
  query: z
    .string()
    .optional()
    .describe("Keywords; empty lists the latest notes."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max notes to return (default: 10)."),
  includeRetracted: z
    .boolean()
    .optional()
    .describe("Include retracted notes, normally hidden."),
});
type SearchArgs = z.infer<typeof searchInput>;

export const search = {
  name: "search",
  description:
    "Search notes by keyword; empty query lists latest. Disputed last, retracted hidden.",
  input: searchInput,
  async execute(args: SearchArgs): Promise<ToolResult> {
    const query = (args.query ?? "").trim();
    const limit = args.limit ?? 10;
    const all = args.includeRetracted === true;
    const { db } = await requireStore();

    if (!query) {
      const rows = listNotes(db, { limit, all });
      const content =
        rows.length === 0
          ? "📭 Nenhuma nota registrada ainda."
          : renderRows(`📋 Últimas ${rows.length} nota(s):`, rows);
      return { content, metadata: { query, limit, exit: 0 } };
    }

    const rows = searchNotes(db, query, { limit, all });
    if (rows.length === 0) {
      const extra = all ? "" : " (notas retratadas ficam fora; use --all para vê-las)";
      return {
        content: `❌ Nenhuma nota encontrada para '${query}'.${extra}`,
        metadata: { query, limit, exit: 0 },
      };
    }
    return {
      content: renderRows(`🔍 Encontradas ${rows.length} nota(s) para '${query}':`, rows),
      metadata: { query, limit, exit: 0 },
    };
  },
};

const confirmInput = z.object({
  id: z.number().int().positive().describe(ID_DESC),
});
type ConfirmArgs = z.infer<typeof confirmInput>;

export const confirm = {
  name: "confirm",
  description:
    "Re-verify a note that still holds; clears dispute/retraction. Prefer over a new note.",
  input: confirmInput,
  async execute(args: ConfirmArgs): Promise<ToolResult> {
    const { db } = await requireStore();
    const result = confirmNote(db, args.id);
    if (!result.ok) return fail(result.error);
    return { content: renderConfirm(result), metadata: { id: args.id, exit: 0 } };
  },
};

const disputeInput = z.object({
  id: z.number().int().positive().describe(ID_DESC),
  why: z
    .string()
    .describe("Concrete reason it looks wrong; mandatory."),
});
type DisputeArgs = z.infer<typeof disputeInput>;

export const dispute = {
  name: "dispute",
  description:
    "Flag a note as suspect without editing it; why is mandatory. Later fix with notes.update.",
  input: disputeInput,
  async execute(args: DisputeArgs): Promise<ToolResult> {
    if (!args.why.trim()) {
      return {
        content: "❌ 'why' is mandatory — a dispute without a reason is not actionable.",
        metadata: { rejected: true },
      };
    }
    const { db } = await requireStore();
    const result = disputeNote(db, args.id, args.why);
    if (!result.ok) return fail(result.error);
    return { content: renderDispute(result), metadata: { id: args.id, exit: 0 } };
  },
};

const retractInput = z.object({
  id: z.number().int().positive().describe(ID_DESC),
  why: z
    .string()
    .optional()
    .describe("Short reason; shown in the badge."),
});
type RetractArgs = z.infer<typeof retractInput>;

export const retract = {
  name: "retract",
  description:
    "Hide a junk or superseded note from search without deleting. Reversible via confirm/update.",
  input: retractInput,
  async execute(args: RetractArgs): Promise<ToolResult> {
    const { db } = await requireStore();
    const result = retractNote(db, args.id, args.why);
    if (!result.ok) return fail(result.error);
    return { content: renderRetract(result), metadata: { id: args.id, exit: 0 } };
  },
};

const historyInput = z.object({
  id: z.number().int().positive().describe(ID_DESC),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max revisions (default all)."),
});
type HistoryArgs = z.infer<typeof historyInput>;

export const history = {
  name: "history",
  description:
    "Show a note's current text plus earlier revisions (rev #N) kept by update/restore.",
  input: historyInput,
  async execute(args: HistoryArgs): Promise<ToolResult> {
    const { db } = await requireStore();
    const found = noteHistory(db, args.id, args.limit);
    if (!found) return fail(`nota ${args.id} não encontrada`);
    return {
      content: renderHistory(found, args.limit),
      metadata: { id: args.id, exit: 0 },
    };
  },
};

const restoreInput = z.object({
  id: z.number().int().positive().describe(ID_DESC),
  rev: z
    .number()
    .int()
    .positive()
    .describe("Revision id (rev #N) to restore."),
});
type RestoreArgs = z.infer<typeof restoreInput>;

export const restore = {
  name: "restore",
  description:
    "Restore an earlier revision (rev #N); the current version is snapshotted first.",
  input: restoreInput,
  async execute(args: RestoreArgs): Promise<ToolResult> {
    const { db } = await requireStore();
    const result = restoreNote(db, args.id, args.rev);
    if (!result.ok) {
      return {
        content:
          `❌ ${result.error}\n` + `   veja os ids válidos com \`notes history ${args.id}\`.`,
        metadata: { id: args.id, rev: args.rev, exit: 1, rejected: true },
      };
    }
    return {
      content: renderRestore(result),
      metadata: { id: args.id, rev: args.rev, exit: 0 },
    };
  },
};

const viewInput = z.object({
  id: z.number().int().positive().describe(ID_DESC),
});
type ViewArgs = z.infer<typeof viewInput>;

export const view = {
  name: "view",
  description:
    "Show one note by id in full, including retracted ones.",
  input: viewInput,
  async execute(args: ViewArgs): Promise<ToolResult> {
    const { db } = await requireStore();
    const note = viewNote(db, args.id);
    if (!note) return fail(`nota ${args.id} não encontrada`);
    return {
      content: renderRows(`📄 Nota #${args.id}`, [note]),
      metadata: { id: args.id, exit: 0 },
    };
  },
};

const doctorInput = z.object({});
type DoctorArgs = z.infer<typeof doctorInput>;

export const doctor = {
  name: "doctor",
  description:
    "Diagnose the notes store: schema, FTS5, counts, index sync.",
  input: doctorInput,
  async execute(_args: DoctorArgs): Promise<ToolResult> {
    const store = await requireStore();
    return { content: renderDoctor(doctorInfo(store)), metadata: { exit: 0 } };
  },
};

const pinInput = z.object({
  id: z.number().int().positive().describe(ID_DESC),
});
type PinArgs = z.infer<typeof pinInput>;

export const pin = {
  name: "pin",
  description:
    "Pin a note into <notes-context> (injected every session, subject to quota). Unpin when stale.",
  input: pinInput,
  async execute(args: PinArgs): Promise<ToolResult> {
    const { db } = await requireStore();
    const result = pinNote(db, args.id);
    if (!result.ok) return fail(result.error);
    return { content: renderPin(result), metadata: { id: args.id, exit: 0 } };
  },
};

export const unpin = {
  name: "unpin",
  description:
    "Unpin a note: stops injecting it in <notes-context>; still searchable.",
  input: pinInput,
  async execute(args: PinArgs): Promise<ToolResult> {
    const { db } = await requireStore();
    const result = unpinNote(db, args.id);
    if (!result.ok) return fail(result.error);
    return { content: renderUnpin(result), metadata: { id: args.id, exit: 0 } };
  },
};
