/**
 * Window-side registration for the Notes side panel.
 *
 * Registers:
 *  - a removable "Notes" tab in the session's side region (`Panel`),
 *  - a command palette / keybind / slash entry (`Command`),
 *  - a "+ / New tab" menu entry (`MenuItem`).
 */

import { createMemo } from "solid-js"
import type {
  Panel as PanelType,
  PanelTab,
  SessionPanelMenuItem,
  SetupContext,
} from "@opencode/plugin/gui"
import { Command, MenuItem, Panel } from "@opencode/plugin/gui"
import { NotesView } from "./view"

export const openNotesId = "notes"

export function setup(ctx: SetupContext<never>): void {
  const text = (pt: string, en: string): string =>
    (ctx.locale.locale() ?? "").toLowerCase().startsWith("pt") ? pt : en

  // The host reads the label per session switch; the memo follows the locale.
  const notesTab = createMemo<PanelTab>(() => ({
    id: openNotesId,
    title: text("Notas", "Notes"),
  }))

  // Explicit `PanelType` annotation: stops string literals (`region`) from
  // widening to `string` during inferred return-type checking.
  const notesPanel: PanelType = {
    id: openNotesId,
    region: "side",
    list: () => [notesTab()],
    render: () => <NotesView />,
  }
  ctx.add(Panel, () => notesPanel)

  ctx.add(Command, () => ({
    id: "open",
    title: text("Abrir Notas", "Open Notes"),
    description: text(
      "Abre a aba de Notas no painel lateral",
      "Opens the Notes tab in the side panel"
    ),
    bind: "mod+shift+n",
    group: "general",
    run: () => {
      const session = ctx.sessions.current()
      if (session) {
        ctx.layout.open(`${ctx.id}:${openNotesId}`, session)
      }
    },
  }))

  ctx.add(MenuItem, (): SessionPanelMenuItem => ({
    menu: "session.panel",
    id: "notes",
    // Native panel actions use orders 10-30; plugin tabs go after them.
    order: 41,
    title: text("Notas", "Notes"),
    icon: "file-document",
    run: () => {
      const session = ctx.sessions.current()
      if (session) {
        ctx.layout.open(`${ctx.id}:${openNotesId}`, session)
      }
    },
  }))
}
