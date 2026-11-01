/**
 * Notes GUI — the `./gui-experimental` entry.
 *
 * `main` runs in the desktop main process (Electron): it serves the IPC over
 * the notes DB + the `notes` CLI. `setup` runs in the renderer: it registers
 * the "Notes" side-panel tab, the command palette / keybind entry and the
 * "+ / New tab" menu entry.
 */

import { Plugin } from "@opencode/plugin/gui"
import { main } from "./gui/main"
import { setup } from "./gui/setup"

const definition = Plugin.define({
  stores: {},
  main,
  setup,
})

export default definition
export type Definition = typeof definition
