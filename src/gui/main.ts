/**
 * Notes GUI — main-process data layer (the `notes` IPC provider).
 *
 * All database work lives in `../store.ts`, shared with the `notes.*` server
 * tools. This module only maps rows to the IPC shapes declared in
 * `./contract.ts` and exposes them through `ctx.provide`.
 */

import type { MainContext } from "@opencode/plugin/gui/main"
import { execFileSync } from "node:child_process"
import { NotesApi } from "./contract"
import type {
  AddInput,
  DisputeInput,
  ListOptions,
  Note,
  NoteDetail,
  NoteResult,
  RestoreInput,
  RetractInput,
  SearchInput,
  Status,
  UpdateInput,
  DeleteInput,
} from "./contract"
import {
  addNote,
  confirmNote,
  disputeNote,
  getStore,
  listNotes,
  noteHistory,
  notesDbPath,
  pinNote,
  requireStore,
  restoreNote,
  retractNote,
  searchNotes,
  unpinNote,
  updateNote,
  viewNote,
  deleteNote,
  type NoteRow,
  type RevisionRow,
} from "../store.js"

/* ------------------------------------------------------------------ */
/* Row mapping (DB snake_case -> IPC camelCase)                        */
/* ------------------------------------------------------------------ */

const toNote = (r: NoteRow): Note => ({
  id: r.id,
  timestamp: r.timestamp,
  category: r.category,
  title: r.title,
  content: r.content,
  tags: r.tags ?? undefined,
  scope: r.scope ?? undefined,
  project: r.project ?? undefined,
  author: r.author ?? undefined,
  verifiedAt: r.verified_at ?? undefined,
  disputedAt: r.disputed_at ?? undefined,
  retractedAt: r.retracted_at ?? undefined,
  statusReason: r.status_reason ?? undefined,
  pinned: r.pinned === 1 || r.pinned === true,
})

const toRevision = (r: RevisionRow): NoteDetail["revisions"][number] => ({
  id: r.id,
  revisedAt: r.revised_at,
  timestamp: r.timestamp,
  category: r.category,
  tags: r.tags ?? undefined,
  scope: r.scope ?? undefined,
  project: r.project ?? undefined,
  title: r.title,
  content: r.content,
})

/*
 * The OS user that auto-fills the form's "Autor" field. Resolved in the
 * main process (Node/Electron), where env vars and `whoami` are available.
 */
function osUser(): string {
  const envUser =
    process.env.USER || process.env.LOGNAME || process.env.USERNAME
  if (envUser && envUser.trim()) return envUser.trim()
  try {
    return execFileSync("whoami", {
      encoding: "utf8",
      timeout: 2000,
    }).trim()
  } catch {
    return ""
  }
}

const failure = (error: string): NoteResult => ({ ok: false, error })

const fromWrite = (r: { ok: true; note: NoteRow } | { ok: false; error: string }): NoteResult =>
  r.ok ? { ok: true, note: toNote(r.note) } : failure(r.error)

/* ------------------------------------------------------------------ */
/* IPC provider                                                        */
/* ------------------------------------------------------------------ */

export function main(ctx: MainContext): void {
  ctx.provide(NotesApi, {
    whoami: async (): Promise<string> => osUser(),
    status: async (): Promise<Status> => {
      const { store } = await getStore()
      return {
        driver: store ? "sqlite" : "none",
        hasFts: store?.fts ?? false,
        dbPath: notesDbPath(),
      }
    },

    list: async (opts: ListOptions): Promise<Note[]> => {
      const { db } = await requireStore()
      return listNotes(db, opts).map(toNote)
    },

    view: async (id: number): Promise<Note | undefined> => {
      const { db } = await requireStore()
      const row = viewNote(db, id)
      return row ? toNote(row) : undefined
    },

    detail: async (id: number): Promise<NoteDetail | undefined> => {
      const { db } = await requireStore()
      const history = noteHistory(db, id)
      if (!history) return undefined
      return { note: toNote(history.note), revisions: history.revisions.map(toRevision) }
    },

    search: async (input: SearchInput): Promise<Note[]> => {
      const { db } = await requireStore()
      return searchNotes(db, input.query, input).map(toNote)
    },

    add: async (input: AddInput): Promise<NoteResult> => {
      const { db } = await requireStore()
      return fromWrite(addNote(db, input))
    },

    update: async (input: UpdateInput): Promise<NoteResult> => {
      const { db } = await requireStore()
      return fromWrite(updateNote(db, input))
    },

    confirm: async (id: number): Promise<NoteResult> => {
      const { db } = await requireStore()
      return fromWrite(confirmNote(db, id))
    },

    dispute: async (input: DisputeInput): Promise<NoteResult> => {
      const { db } = await requireStore()
      return fromWrite(disputeNote(db, input.id, input.reason))
    },

    retract: async (input: RetractInput): Promise<NoteResult> => {
      const { db } = await requireStore()
      return fromWrite(retractNote(db, input.id, input.reason))
    },

    pin: async (id: number): Promise<NoteResult> => {
      const { db } = await requireStore()
      return fromWrite(pinNote(db, id))
    },

    unpin: async (id: number): Promise<NoteResult> => {
      const { db } = await requireStore()
      return fromWrite(unpinNote(db, id))
    },

    restore: async (input: RestoreInput): Promise<NoteResult> => {
      const { db } = await requireStore()
      return fromWrite(restoreNote(db, input.id, input.revisionId))
    },

    delete: async (input: DeleteInput): Promise<NoteResult> => {
      const { db } = await requireStore()
      return fromWrite(deleteNote(db, input.id))
    },
  })
}
