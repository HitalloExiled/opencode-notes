# AGENTS.md — working on `opencode-notes`

Agent-facing operating notes: how to build, typecheck, test, and how the running
OpenCode service hot-reloads the plugin. Read `README.md` for product docs and
`skills/notes/SKILL.md` for the notes data model. This file is about *working in
the repo*.

## What this is

`opencode-notes` is a self-contained OpenCode (V2) plugin:

- **Tools** — curated long-term memory under the `notes` namespace
  (`notes.add`, `notes.search`, `notes.confirm`, …). Defined in `notes.ts`,
  registered in `index.ts`.
- **GUI** — a SolidJS side panel (`./gui-experimental`), registered in the
  desktop app. Entry `src/gui.tsx`.
- **Skill** — `skills/notes/SKILL.md` (optional; teaches agents when/how to
  record notes).

Everything reads/writes a single SQLite DB **directly** via `node:sqlite`
(in-process, synchronous, FTS5). There is **no external CLI**.

## Repo layout

```
index.ts                 registers the notes.* tools (Plugin.define + ctx.tool.transform),
                         the <notes-context> hook and the /pin, /unpin commands
notes.ts                 tool definitions (add/update/search/confirm/dispute/retract/
                         history/restore/view/pin/unpin/doctor)
commands.ts              /pin and /unpin slash commands (notes-only)
src/inject.ts            <notes-context> session injection, NOTES_ROUTING_RULE,
                         and the pinned-change notice (session.synthetic)
src/store.ts             SHARED data layer: node:sqlite, schema v9, migrations, FTS5.
                         Used by BOTH the tools and the GUI. DB path + all SQL live here.
src/gui.tsx              ./gui-experimental entry → { main, setup }
src/gui/main.ts          main-process IPC provider (NotesApi); maps DB rows → IPC shapes
src/gui/contract.ts      NotesApi IPC contract + zod schemas (the GUI↔main boundary)
src/gui/setup.tsx        renderer: registers the Notes tab, command, "+ / New tab" menu
src/gui/view.tsx         the SolidJS UI (all inline CSS + markup live here)
src/gui/filters.ts       pure filter/display logic (deterministic, unit-tested)
src/gui/i18n.ts          PT-BR / EN-US copy (follows the Opencode locale)
test/                    bun tests (see "Tests")
dist/gui-experimental.cjs  BUILT GUI artifact (gitignored). This is what the service loads.
```

## Hard rules (do not violate)

These are standing constraints, not suggestions:

- **UI copy is PT-BR; code is English.** Localized strings go through `t()` in
  `src/gui/i18n.ts`.
- **Every user-facing message — UI copy, toasts and synthetic/session
  messages — must exist in PT-BR and EN-US, with EN-US as the fallback.** Code
  and identifiers stay English. Never hardcode a UI or synthetic string in a
  single language.
- **Never read OpenCode's `opencode.db` directly.** The GUI must source app
  data (projects, sessions) from the official `ctx.client.*` APIs only — raw DB
  reads are unreliable. (e.g. project list = `ctx.client.project.list()`.)
- **Do not write data inside the repo.** All DB writes go to `notes.db` (see
  "Live paths").
- **Multi-project model:** plain-FK join tables (`note_projects`,
  `note_revision_projects`), **no `ON DELETE CASCADE`**. On delete, drop the
  join children **before** the parent (in this build `foreign_keys` defaults ON).
- **Scope invariant:** when `scope !== "project"`, the note's project refs are
  cleared (revision snapshots keep their historical set).
- **Schema is v9.** Migrations are idempotent and run inside a transaction
  (a failure never leaves the DB half-migrated). `PRAGMA user_version` tracks
  the version. Never hand-edit `notes.db` schema; add a new `MIGRATION_0NN`
  and bump `SCHEMA_VERSION`.

## GUI guideline (shared kit)

The visual and behavioral contract for the side panels is
[docs/gui-guideline.md](https://github.com/HitalloExiled/opencode-tools/blob/main/docs/gui-guideline.md).
GUI code used by more than one plugin lives in
`opencode-shared/gui` (the parent's `shared/` submodule, linked
into `node_modules` by `setup.sh`) — never copy it into this repo.

Non-negotiables:

- only theme tokens (`--v2-*`); status via `--v2-state-*`; no raw hex.
- controls from `ctx.ui.*`; never a text action in a raw `<button>`.
- one scroll container per panel with the shared `ScrollNav` (infinite scroll,
  to-top/to-bottom, Home/End/PageUp/PageDown).
- every visible string in `src/gui/i18n.ts` (PT-BR + EN-US).
- shared `EmptyState`, `ErrorBanner`, `LoadingRow`, `EndMarker` and
  `StatusChip` instead of local copies.

## Build

Run from the plugin directory (`plugins/notes/`):

```bash
bun run gui:build      # vite build → dist/gui-experimental.cjs  (this is the only build step)
```

Install once (the repo is self-contained; deps come from its own package.json):

```bash
npm install --legacy-peer-deps   # --legacy-peer-deps: @opencode/plugin wants vite>=6, build uses vite 5
```

There is no separate "server" build — the tools (`index.ts`/`notes.ts`/
`src/store.ts`) are consumed as TypeScript directly by the Bun runtime.

## Typecheck

Two independent typechecks, both should be clean before committing:

```bash
bun run typecheck:gui   # tsc -p tsconfig.gui.json  → src/** (the GUI, Solid JSX)
bun run typecheck       # tsc --noEmit             → index.ts + notes.ts (the tools)
```

From the **parent** `opencode-tools/` root, `bun run typecheck` typechecks
`plugins/**/*.ts` — the `.ts` files only (tools, store, and the non-JSX GUI
modules like `contract`/`main`/`filters`/`i18n`), for both plugins at once.
The `.tsx` GUI (`view.tsx` etc.) is covered by the plugin's own
`typecheck:gui`.

## Tests

Tests are **run from the parent `opencode-tools/` directory** (the parent's
`package.json` owns the `test` script and `@types/bun`); the notes plugin has
no test script of its own.

```bash
# from opencode-tools/
bun test plugins/notes/test                 # just the notes plugin
bun test plugins/memory/test plugins/notes/test   # what the parent `test` script runs
```

Uses `bun test` (Bun's built-in runner). 4 files, ~90 tests:

- `test/store.test.ts` — the data layer (CRUD, schema, migrations, FK order).
- `test/filters.test.ts` — pure `src/gui/filters.ts` logic.
- `test/notes.test.ts` — the tool layer.
- `test/multi-select-dom.test.ts` — **DOM test** of the real MultiSelect
  component (happy-dom + the same Solid browser build Vite uses). This is the
  closest thing to UI coverage.

No e2e. Keep new UI logic in pure, testable functions (`src/gui/filters.ts`
pattern); the DOM test should stay the only DOM-level test.

## Hot reload (the dev loop)

The **running OpenCode service watches this plugin**. There is no process to
kill: rebuilding triggers a full reload (backend + GUI) automatically.

```
edit src/gui/**  →  bun run typecheck:gui  →  bun run gui:build  →  service reloads
```

- The reload is triggered by the change to `dist/gui-experimental.cjs` (and the
  entrypoint). No restart needed.
- **Confirm it worked** in `~/.local/share/opencode/log/opencode.log`:
  - `"loading plugin" ... plugins/notes` = reloaded OK.
  - Any `level=ERROR`/`WARN` after the rebuild = something broke — read it.
- To verify the new code is actually in the deployed bundle, grep
  `dist/gui-experimental.cjs` for a symbol/label you just added.

Typical GUI change flow:

```bash
cd plugins/notes
bun run typecheck:gui && bun run gui:build
grep -iE "loading plugin.*notes|level=(ERROR|WARN)" ~/.local/share/opencode/log/opencode.log | tail
```

## GUI context API (cheatsheet for `src/gui/view.tsx`)

`usePlugin()` returns `ctx`; `ctx.main(NotesApi)` is the IPC client to the
main-process provider (`src/gui/main.ts`). Useful `ctx` members:

- `ctx.client.project.list()` → `Promise<Project[]>`, each with `.canonical`
  (absolute project root). This is the source of the "Projeto" dropdown.
- `ctx.sessions.list()` → reactive; use as the trigger to re-fetch app data.
- `ctx.locale.locale()` → current locale (drives PT-BR vs EN-US).
- `ctx.ui.*` → app design-system components (`Button`, `IconButton`, `Icon`,
  `Tooltip`, `TextField`, …). Prefer these over raw elements.
- `ctx.toast.show`, `ctx.dialogs.*`, `ctx.screen.current()` for feedback/forms.

The GUI talks to the DB **only** through `ctx.main(NotesApi)` (IPC) — never
open the DB from the renderer.

## Git workflow (two-part)

`plugins/notes` is a **git submodule** (its own repo, `opencode-notes`); the
parent `opencode-tools` tracks the pointer.

1. Commit + push the **submodule first** (`plugins/notes`, origin
   `opencode-notes`).
2. Then `git add plugins/notes`, commit + push the **parent** pointer bump.

Stable milestones are tagged as `v0.*.*` (annotated, pushed to `opencode-notes`):
`v0.1.0` first GUI, `v0.2.0` scope model (schema v8), `v0.3.0` multi-project
(schema v9). See `git tag -l`.

## Live paths (debugging)

| Thing | Path |
|---|---|
| Notes DB | `~/.local/share/opencode/memory/notes.db` (override: `$NOTES_DB`) |
| OpenCode DB (sessions/projects) | `~/.local/share/opencode/opencode.db` — **context only, do NOT read directly** |
| OpenCode log | `~/.local/share/opencode/log/opencode.log` |
| Plugin install (symlink) | `~/.config/opencode/plugins/notes` → this repo |
| Skill symlink | `~/.config/opencode/skills/notes/SKILL.md` |

Point `$NOTES_DB` at a throwaway file to exercise the DB without touching the
real one.

## Quick checklist for a change

1. Edit the code (keep UI strings in `src/gui/i18n.ts`; keep logic testable).
2. `bun run typecheck:gui` (and `bun run typecheck` if you touched tools/store).
3. `bun run gui:build` if you touched the GUI.
4. Confirm a clean reload in the opencode log.
5. Run `bun test plugins/notes/test` from the parent if logic/DB changed.
6. Commit + push the submodule, then bump + push the parent pointer.
