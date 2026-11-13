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
  NOTES_NAMESPACE,
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
import { buildPinnedInfo, createRuntime, onContext } from "./src/inject.js";
import { registerCommands } from "./commands.js";

export default Plugin.define({
  id: "notes",
  async setup(ctx) {
    // `pinned` + `notify` let the context hook notice when a pin/unpin changes
    // what this session injects and tell the agent about it. The synthetic
    // message mirrors the plans plugin: `resume: false` never wakes an idle
    // session, so the notice is delivered on its next turn.
    const runtime = createRuntime(undefined, {
      pinned: buildPinnedInfo,
      notify: async ({ sessionID, text, description }) => {
        await ctx.session.synthetic({
          sessionID: sessionID as never,
          text,
          description,
          resume: false,
          metadata: { source: "notes" },
        });
      },
    });
    const registration = await ctx.tool.transform((editor) => {
      // editor.namespace() only labels the catalog group; the per-tool
      // options.namespace below is what actually prefixes the qualified
      // name (tools.notes.*) in Code Mode.
      editor.namespace(NOTES_NAMESPACE);
      // `pinned` keeps the entry points (add/search) and the pin controls in the
      // Code Mode catalog even when its per-namespace budget is exhausted (the
      // summary lists the cheapest signatures first, so pin/unpin would
      // otherwise drop out of the visible catalog).
      editor.add({ ...add, options: { namespace: "notes", pinned: true } });
      editor.add({ ...update, options: { namespace: "notes" } });
      editor.add({ ...search, options: { namespace: "notes", pinned: true } });
      editor.add({ ...confirm, options: { namespace: "notes" } });
      editor.add({ ...dispute, options: { namespace: "notes" } });
      editor.add({ ...retract, options: { namespace: "notes" } });
      editor.add({ ...history, options: { namespace: "notes" } });
      editor.add({ ...restore, options: { namespace: "notes" } });
      editor.add({ ...view, options: { namespace: "notes" } });
      editor.add({ ...pin, options: { namespace: "notes", pinned: true } });
      editor.add({ ...unpin, options: { namespace: "notes", pinned: true } });
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
