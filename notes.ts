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

const ID_DESC = "Note id, shown as #NN by notes.search.";

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
    .describe("Note category. Use 'problem' for a solved problem."),
  title: z
    .string()
    .describe("Short, specific title. For 'problem', describe the symptom."),
  content: z
    .string()
    .describe(
      "Content written for someone who did not see the conversation. If category=problem: " +
        "Symptom: ... | Cause: <root> | Solution: <reproducible> | Files: ...",
    ),
  tags: z
    .string()
    .optional()
    .describe("Space-separated keywords, without '#' (e.g. 'selinux module')."),
  scope: z
    .string()
    .optional()
    .describe(
      "Scope type: 'all'/'global' (machine-independent, the default), " +
        "'machine', or 'project'.",
    ),
  projects: z
    .array(z.string().min(1, "each project path must be non-empty"))
    .optional()
    .describe(
      "One or more absolute project paths (no spaces). Required when scope is " +
        "'project' (pass an array with at least one path). " +
        "The legacy 'project:<name>' value in `scope` is no longer accepted.",
    ),
  author: z
    .string()
    .optional()
    .describe(
      "Who registered the note (attribution): your agent name when acting as an agent, " +
        "or the human's name when a person registers it from a terminal. Shown as " +
        "'(by <author>)' in search/list/view.",
    ),
});
type AddArgs = z.infer<typeof addInput>;

export const add = {
  name: "add",
  description:
    "Save a note to long-term memory (notes). Use for decisions, non-obvious " +
    "configuration, snippets and — above all — solved problems. " +
    "Rule: if category=problem, content MUST contain Symptom, Cause and Solution " +
    "(the tool refuses to save if one is missing). Before saving, search with " +
    "notes.search to avoid duplicates. Write notes in English.",
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
  title: z.string().optional().describe("New title, only if the current one is wrong."),
  content: z.string().optional().describe("New content that replaces the wrong content."),
  tags: z
    .string()
    .optional()
    .describe("New space-separated keywords (empty string clears them)."),
  category: z
    .enum(CATEGORIES)
    .optional()
    .describe("New category, only if the note was filed wrongly."),
  scope: z
    .string()
    .optional()
    .describe(
      "New scope type: 'all'/'global', 'machine', or 'project'. " +
        "(empty string clears it.)",
    ),
  projects: z
    .array(z.string().min(1, "each project path must be non-empty"))
    .optional()
    .describe(
      "New absolute project paths (no spaces). Set it to change the set of " +
        "project-scoped paths; required when scope is 'project' (pass an array " +
        "with at least one path). To drop project scope, set scope to 'all'/'global'. " +
        "The legacy 'project:<name>' value in `scope` is no longer accepted.",
    ),
});
type UpdateArgs = z.infer<typeof updateInput>;

export const update = {
  name: "update",
  description:
    "LAST RESORT: correct an existing note whose content is now known to be wrong " +
    "or conflicts with verified information. Do NOT use it to append new facts, " +
    "reword for style, or erase history — save a new note instead. Only the fields " +
    "you pass change; the timestamp is set to now, so the corrected note moves to " +
    "the top. If the resulting note is category=problem, it still needs " +
    "Symptom, Cause and Solution. Rewriting a note from evidence also marks it " +
    "verified and clears any dispute/retraction (the old warnings no longer apply). " +
    "Nothing is lost: the previous version is snapshotted and readable with " +
    "notes.history, and can be brought back with notes.restore.",
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
    .describe("Search term(s). Omit or leave empty to list the latest notes."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max notes to return (default: 10)."),
  includeRetracted: z
    .boolean()
    .optional()
    .describe(
      "Also show retracted notes (🚫), normally hidden. Use to audit/revive, not for normal recall.",
    ),
});
type SearchArgs = z.infer<typeof searchInput>;

export const search = {
  name: "search",
  description:
    "Search the curated note store by keyword. Without 'query', lists the most " +
    "recent notes. Multi-word queries first require ALL words (AND) and only fall " +
    "back to ANY (OR) when nothing matches, so results stay precise. Disputed notes " +
    "are still shown but listed last, with a ⚠ badge; retracted notes are hidden " +
    "unless includeRetracted=true.",
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
    "Mark a note as re-verified: it still holds as of now. This is the positive " +
    "signal — use it after you relied on a note and independently confirmed it is " +
    "correct. Clears any dispute/retraction on the note (brings a retracted note " +
    "back into normal search). Prefer this over a new note when nothing changed.",
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
    .describe("Concrete reason it looks wrong (what you saw that contradicts it). Mandatory."),
});
type DisputeArgs = z.infer<typeof disputeInput>;

export const dispute = {
  name: "dispute",
  description:
    "Flag a note as suspect WITHOUT rewriting it (dispute). Use when you believe " +
    "the note is wrong or outdated but do not yet have the correction: the next " +
    "reader sees a ⚠ warning and the note sinks to the bottom of results. 'why' is " +
    "mandatory. Once you have the fix, use notes.update instead — that resolves the " +
    "dispute and re-verifies the note.",
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
    .describe("Short reason it is being retracted (stored, shown with the 🚫 badge)."),
});
type RetractArgs = z.infer<typeof retractInput>;

export const retract = {
  name: "retract",
  description:
    "Retract a note: hides it from normal search/list (junk, a test/probe leftover, " +
    "superseded noise) without deleting anything. Reversible — notes.confirm or " +
    "notes.update brings it back, and includeRetracted=true still shows it with a " +
    "🚫 badge. This is the noise-control tool; deletion stays a human-only action.",
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
    .describe("Max earlier versions to show, newest first (default: all)."),
});
type HistoryArgs = z.infer<typeof historyInput>;

export const history = {
  name: "history",
  description:
    "Show a note's version history: the current state plus every earlier version " +
    "kept by notes.update / notes.restore (each snapshotted before it was rewritten). " +
    "Use when a note looks wrong or you need the exact previous wording — the old " +
    "content is never discarded. Each prior version is labelled rev #N.",
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
    .describe("Revision id (rev #N) to restore, from notes.history."),
});
type RestoreArgs = z.infer<typeof restoreInput>;

export const restore = {
  name: "restore",
  description:
    "Bring back the content of an earlier version (rev #N from notes.history). This " +
    "is itself an update: the current version is snapshotted first, so restoring " +
    "never loses anything — you can always restore again. Use it to undo an earlier " +
    "notes.update that turned out wrong. Only content/title/tags/category come back; " +
    "the note is re-verified (dispute/retraction cleared).",
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
    "Show one note by id, in full, whatever its trust state — retracted notes " +
    "included, with the 🚫 badge. Use it when you already have an id from " +
    "notes.search, or to inspect a note that no longer appears in search before " +
    "deciding to notes.confirm or notes.update it.",
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
    "Memory subsystem diagnosis: runtime/sqlite, FTS5 availability (full-text " +
    "search; when absent the tools degrade to LIKE), database schema path and " +
    "version, note count and index sync. Use when a search/save fails or to " +
    "check whether the machine is ready.",
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
    "Pin a note: it is injected at the start of every session in the " +
    "<notes-context> block (up to the NOTES_INJECT quota). Global, machine and " +
    "current-project notes are eligible; a project-scoped note appears only in " +
    "sessions of that project. Unpin when it is no longer relevant.",
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
    "Unpin a note: it will no longer be injected at session start (but remains " +
    "searchable via notes.search). Use this when a pinned note is no longer " +
    "relevant to the current work.",
  input: pinInput,
  async execute(args: PinArgs): Promise<ToolResult> {
    const { db } = await requireStore();
    const result = unpinNote(db, args.id);
    if (!result.ok) return fail(result.error);
    return { content: renderUnpin(result), metadata: { id: args.id, exit: 0 } };
  },
};
