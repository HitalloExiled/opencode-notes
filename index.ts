/**
 * notes plugin — long-term memory tools under the "notes" namespace
 * (same pattern as the memory plugin: memory.* / notes.*).
 *
 * - In Code Mode the tools are callable as tools.notes.add /
 *   tools.notes.search / ... (one "notes" group in the catalog).
 * - In regular sessions the definitions keep the underscored names
 *   (notes_add, notes_search, ...) exactly as before, so the existing
 *   permission rules (resource: "notes_add", ...) keep matching.
 *
 * The tools talk to the notes database directly through the shared store
 * (`./src/store.ts`, the same data layer as the side-panel GUI). There is no
 * external CLI. Nothing is ever deleted: `retract` only hides a note and
 * `restore` brings back old revisions.
 */

import { Plugin } from "@opencode/plugin";
import {
  add,
  confirm,
  dispute,
  doctor,
  history,
  pin,
  restore,
  retract,
  search,
  unpin,
  update,
  view,
} from "./notes.js";
import { createRuntime, onContext } from "./src/inject.js";
import { registerCommands } from "./commands.js";

export default Plugin.define({
  id: "notes",
  async setup(ctx) {
    const runtime = createRuntime();
    const registration = await ctx.tool.transform((editor) => {
      // editor.namespace() only labels the catalog group; the per-tool
      // options.namespace below is what actually prefixes the qualified
      // name (tools.notes.*) in Code Mode.
      editor.namespace({
        name: "notes",
        description:
          "Curated long-term memory: decisions, solved problems, configuration and snippets, with a trust lifecycle (confirm/dispute/retract), full version history, and pinning into session context (pinned notes are injected at session start in the <notes-context> block). Nothing is ever deleted: retract hides, restore revives.",
      });
      // `pinned` keeps the two entry points in the Code Mode catalog even when
      // its per-namespace budget is exhausted (the summary lists the cheapest
      // signatures first, which otherwise surfaces only doctor/pin/unpin).
      editor.add({ ...add, options: { namespace: "notes", pinned: true } });
      editor.add({ ...update, options: { namespace: "notes" } });
      editor.add({ ...search, options: { namespace: "notes", pinned: true } });
      editor.add({ ...confirm, options: { namespace: "notes" } });
      editor.add({ ...dispute, options: { namespace: "notes" } });
      editor.add({ ...retract, options: { namespace: "notes" } });
      editor.add({ ...history, options: { namespace: "notes" } });
      editor.add({ ...restore, options: { namespace: "notes" } });
      editor.add({ ...view, options: { namespace: "notes" } });
      editor.add({ ...pin, options: { namespace: "notes" } });
      editor.add({ ...unpin, options: { namespace: "notes" } });
      editor.add({ ...doctor, options: { namespace: "notes" } });
    });

    // The notes layer injects its own context block + routing rule; it never
    // depends on, and is never read by, the memory plugin.
    const contextHook = await ctx.session.hook("context", (event) => onContext(ctx, runtime, event));
    const commands = await registerCommands(ctx);

    return async () => {
      await commands.dispose().catch(() => undefined);
      await contextHook.dispose().catch(() => undefined);
      await registration.dispose().catch(() => undefined);
    };
  },
});
