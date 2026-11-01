/**
 * Window-side registration for the notes side panel.
 *
 * Runs in the renderer. Registers:
 *  - a pinned "Notes" tab in the session's side region (`Panel`),
 *  - a command palette / keybind / slash entry (`Command`),
 *  - a "+ / New tab" menu entry (`MenuItem`).
 */

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
  // Stable (pinned, constant) tab object: the host reads the label once per
  // session switch and does not re-render it on every routing event.
  const notesTab: PanelTab = {
    id: openNotesId,
    title: "Notas",
    pinned: true,
    closable: false,
  }

  // Explicit `PanelType` annotation: stops string literals (`region`) from
  // widening to `string` during inferred return-type checking.
  const notesPanel: PanelType = {
    id: openNotesId,
    region: "side",
    list: () => [notesTab],
    render: () => <NotesView />,
  }
  ctx.add(Panel, () => notesPanel)

  ctx.add(Command, () => ({
    id: "open",
    title: "Abrir Notas",
    description: "Abre a aba de Notas no painel lateral",
    bind: "mod+shift+n",
    group: "general",
    run: () => {
      const session = ctx.sessions.current()
      if (session) {
        ctx.layout.open(`${ctx.id}:${openNotesId}`, session)
      }
    },
  }))

  // Explicit `SessionPanelMenuItem` annotation: keeps `menu` as the literal
  // "session.panel" instead of widening to `string`.
  const notesMenu: SessionPanelMenuItem = {
    menu: "session.panel",
    id: "notes",
    title: "Notas",
    icon: "file-document",
    run: () => {
      const session = ctx.sessions.current()
      if (session) {
        ctx.layout.open(`${ctx.id}:${openNotesId}`, session)
      }
    },
  }
  ctx.add(MenuItem, () => notesMenu)
}
