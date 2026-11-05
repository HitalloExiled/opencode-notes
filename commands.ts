/** Slash commands owned by the notes layer. Each expands into a prompt that drives the `notes.*` tools. */

import { Plugin } from "@opencode/plugin";

type Definition = Parameters<typeof Plugin.define>[0];
type PluginContext = Parameters<Definition["setup"]>[0];

interface CommandDefinition {
  name: string;
  description: string;
  /** Receives the raw arguments typed after the command. */
  prompt: (args: string) => string;
}

const COMMANDS: CommandDefinition[] = [
  {
    name: "pin",
    description: 'Pin a note so it is injected at the start of every session ("/pin <note_id>")',
    prompt: (args) => {
      const id = args.trim();
      if (!id) {
        return "Usage: /pin <note_id> — e.g. /pin 5. Call notes.search to see note ids.";
      }
      return [
        `The user wants to pin note #${id}. Call notes.pin with id=${id}.`,
        "Then reply with exactly one line: 'Pinned #${id}.' — nothing else.",
      ].join("\n");
    },
  },
  {
    name: "unpin",
    description: 'Unpin a note so it is no longer injected at session start ("/unpin <note_id>")',
    prompt: (args) => {
      const id = args.trim();
      if (!id) {
        return "Usage: /unpin <note_id> — e.g. /unpin 3. Call notes.search to see note ids.";
      }
      return [
        `The user wants to unpin note #${id}. Call notes.unpin with id=${id}.`,
        "Then reply with exactly one line: 'Unpinned #${id}.' — nothing else.",
      ].join("\n");
    },
  },
];

export async function registerCommands(ctx: PluginContext) {
  return ctx.command.transform((editor) => {
    for (const command of COMMANDS) {
      editor.add({
        name: command.name,
        description: command.description,
        async execute({ sessionID, prompt, delivery }) {
          const args = (prompt.text ?? "").trim();
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: command.prompt(args),
            delivery,
          } as never);
        },
      });
    }
  });
}
