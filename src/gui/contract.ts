/**
 * Notes GUI — IPC contract.
 *
 * Types (used by the window + main for shaping data) are declared next to the
 * runtime Effect schemas (used by the IPC bridge to encode/decode). The two
 * are kept in lockstep: every `type` has a matching schema and vice versa.
 *
 * Only the app-provided modules are importable here: `effect` (top-level
 * `Schema`, `Schema.optional(...)`) and `@opencode/plugin/gui` (`Ipc`).
 */

import { Ipc } from "@opencode/plugin/gui"
import { Schema } from "effect"

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type Note = {
  id: number
  timestamp: string
  category: string
  tags?: string | undefined
  title: string
  content: string
  author?: string | undefined
  verifiedAt?: string | undefined
  disputedAt?: string | undefined
  retractedAt?: string | undefined
  statusReason?: string | undefined
  pinned: boolean
}

export type Revision = {
  id: number
  revisedAt: string
  timestamp: string
  category: string
  tags?: string | undefined
  title: string
  content: string
}

export type NoteDetail = {
  note: Note
  revisions: Revision[]
}

export type NoteResult = {
  ok: boolean
  error?: string | undefined
  note?: Note | undefined
}

export type Driver = "sqlite" | "none"

export type Status = {
  driver: Driver
  hasFts: boolean
  dbPath: string
}

export type ListOptions = {
  limit?: number | undefined
  all?: boolean | undefined
}

export type SearchInput = {
  query: string
  limit?: number | undefined
  all?: boolean | undefined
}

export type AddInput = {
  category: string
  title: string
  content: string
  tags?: string | undefined
  author?: string | undefined
}

export type UpdateInput = {
  id: number
  title?: string | undefined
  content?: string | undefined
  tags?: string | undefined
  category?: string | undefined
}

export type DisputeInput = {
  id: number
  reason: string
}

export type RetractInput = {
  id: number
  reason?: string | undefined
}

export type RestoreInput = {
  id: number
  revisionId: number
}

/* ------------------------------------------------------------------ */
/* Schemas (runtime — mirror the types above)                          */
/* ------------------------------------------------------------------ */

const optString = Schema.optional(Schema.String)
const optNum = Schema.optional(Schema.Number)
const optBool = Schema.optional(Schema.Boolean)

export const noteSchema = Schema.Struct({
  id: Schema.Number,
  timestamp: Schema.String,
  category: Schema.String,
  tags: optString,
  title: Schema.String,
  content: Schema.String,
  author: optString,
  verifiedAt: optString,
  disputedAt: optString,
  retractedAt: optString,
  statusReason: optString,
  pinned: Schema.Boolean,
})

export const revisionSchema = Schema.Struct({
  id: Schema.Number,
  revisedAt: Schema.String,
  timestamp: Schema.String,
  category: Schema.String,
  tags: optString,
  title: Schema.String,
  content: Schema.String,
})

export const noteDetailSchema = Schema.Struct({
  note: noteSchema,
  revisions: Schema.Array(revisionSchema),
})

export const noteResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  error: optString,
  note: Schema.optional(noteSchema),
})

export const driverSchema = Schema.Union([
  Schema.Literal("sqlite"),
  Schema.Literal("none"),
])

export const statusSchema = Schema.Struct({
  driver: driverSchema,
  hasFts: Schema.Boolean,
  dbPath: Schema.String,
})

export const listOptionsSchema = Schema.Struct({
  limit: optNum,
  all: optBool,
})

export const searchInputSchema = Schema.Struct({
  query: Schema.String,
  limit: optNum,
  all: optBool,
})

export const addInputSchema = Schema.Struct({
  category: Schema.String,
  title: Schema.String,
  content: Schema.String,
  tags: optString,
  author: optString,
})

export const updateInputSchema = Schema.Struct({
  id: Schema.Number,
  title: optString,
  content: optString,
  tags: optString,
  category: optString,
})

export const disputeInputSchema = Schema.Struct({
  id: Schema.Number,
  reason: Schema.String,
})

export const retractInputSchema = Schema.Struct({
  id: Schema.Number,
  reason: optString,
})

export const restoreInputSchema = Schema.Struct({
  id: Schema.Number,
  revisionId: Schema.Number,
})

/* ------------------------------------------------------------------ */
/* The Ipc                                                             */
/* ------------------------------------------------------------------ */

export const NotesApi = Ipc.define({
  id: "notes",
  methods: {
    status: { output: statusSchema },
    list: { input: listOptionsSchema, output: Schema.Array(noteSchema) },
    view: { input: Schema.Number, output: Schema.optional(noteSchema) },
    detail: { input: Schema.Number, output: Schema.optional(noteDetailSchema) },
    search: { input: searchInputSchema, output: Schema.Array(noteSchema) },
    add: { input: addInputSchema, output: noteResultSchema },
    update: { input: updateInputSchema, output: noteResultSchema },
    confirm: { input: Schema.Number, output: noteResultSchema },
    dispute: { input: disputeInputSchema, output: noteResultSchema },
    retract: { input: retractInputSchema, output: noteResultSchema },
    pin: { input: Schema.Number, output: noteResultSchema },
    unpin: { input: Schema.Number, output: noteResultSchema },
    restore: { input: restoreInputSchema, output: noteResultSchema },
  },
})
