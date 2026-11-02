---
name: Notes
description: Curated, portable knowledge base in SQLite (FTS5) via the tools `notes.add`/`notes.update`/`notes.confirm`/`notes.dispute`/`notes.retract`/`notes.history`/`notes.restore`/`notes.view`/`notes.pin`/`notes.unpin`/`notes.search`/`notes.doctor` (effective names `notes_add`, `notes_search`, ... in regular sessions) and the desktop side panel. Stores distilled facts at any scope (global, project, machine) — decisions, resolved problems with symptom/cause/solution, configuration, snippets — with a trust lifecycle (`notes.confirm`/`notes.dispute` set the trust signal on a note; `notes.retract` hides noise without deleting) and full revision history. `notes.update` is a last resort, only to fix a note now known to be wrong or conflicting, and keeps the previous version readable via `notes.history`/`notes.restore`. Use when a fact must stay true across sessions and machines, or before acting on a project with documented history. Not a conversation log: it holds distilled knowledge, not what was said in a session.
metadata:
  audience: any
  opencode/slash: "true"
---

## What it is

Long-term memory system based on SQLite (+ FTS5 index when available), exposed
through the `notes.*` tools and a desktop side panel. The database lives at
`~/.local/share/opencode/memory/notes.db` (or at the path in `$NOTES_DB`) and —
together with the schema — is created on demand: a fresh machine needs no
manual steps at all. There is **no external CLI**: the tools read and write the
database directly (the same store the side panel uses).

## Scope

**Curated, distilled knowledge at any scope — not a conversation log.**

- **What notes is for:** distilled facts that must stay true *after* the conversation ends — decisions (and their why), resolved problems with root cause, configuration, reusable snippets. At any scope: **global** (machine-independent), **project**-specific, or **machine**-specific. Every note carries a trust signal and a revision history.
- **What notes is not for:** journaling what was said or done in a session. Do not copy conversation content or "what happened" narratives into notes — register the distilled fact instead.
- **The test (distillation):** is this a claim with a cause/evidence, or a report of what happened? If it is a distilled fact, register it — its scope is then *classified* (the `Scope:` field below), never used as a reason to skip the registration.

## How to use

**Always use the tools** (typed, shell-free, with validation):

| Tool | For |
|---|---|
| `notes.search` | search / list recent notes (without `query` = list). Disputed notes show ⚠ and sort last; retracted ones are hidden unless `includeRetracted` |
| `notes.add` | record a new note (validates the `#problem` format) |
| `notes.update` | **last resort**: fix a note that is wrong or conflicts (moves its timestamp, re-verifies it, snapshots the old version) |
| `notes.confirm` | ✔ re-verified a note read as-is: it still holds (clears dispute/retraction) |
| `notes.dispute` | ⚠ flag a note as suspect **without** rewriting it (needs `why`) |
| `notes.retract` | 🚫 hide junk/obsolete noise from search/list (reversible, nothing is deleted) |
| `notes.history` | read a note's current state + every earlier version (rev #N) |
| `notes.restore` | bring back the content of an earlier rev #N (keeps the current one too) |
| `notes.view` | show one note by id in full, whatever its state (retracted included, with 🚫) |
| `notes.pin` | 📌 make a note part of the `<memory-context>` injected at the start of every session (up to 12 / 3000 chars) |
| `notes.unpin` | 📎 stop injecting a note at session start (it remains searchable) |
| `notes.doctor` | diagnose memory/schema/FTS5 when something fails |

Humans can do the same from the desktop app's **Notes** panel (a side tab you
can close and reopen from "+ / New tab" or `mod+shift+n`: list, search,
filters, full note detail, revisions, and the same actions).

## Pinning: the notes that travel with every session

A pinned note is injected at the start of every session as the **Pinned notes**
section of the `<memory-context>` block. Injection is scoped: the note must
name the session's project or this machine, must not be retracted, and the
set is capped (12 notes, 3000 chars; `MEMORY_NOTES_INJECT`).

- **Pin** a note when it is a durable fact the agent needs *in context at
  every session* — environment quirks (paths, binaries, versions, permissions),
  project invariants, or the current task's key constraints. Pinning is
  part of the work: when you establish such a fact, add the note and pin it
  in the same turn.
- **Unpin** when it is no longer relevant. Keep the pinned set lean — it
  shares a fixed budget with the handoff and should only hold what you need
  across sessions.
- **Everything else stays searchable**: unpinned notes are never injected,
  but they are one `notes.search` away. Do not pin to avoid a search.

## When to use

- **Starting work** on a project with relevant history: run `notes.search` before acting (documented facts, not conversation recall).
- **Resolving a non-trivial problem**: register symptom → cause → solution (section below). This is the most important rule of the skill.
- **Making important decisions** (architecture, trade-offs, non-obvious configuration): record with category `#decision`.
- **Learning a durable fact about the user** (name, how to address them, preferences, standing context, goals): register a `#user` note scoped `machine`, and pin it when it should carry into every session — the agent decides against the 12-pin budget.
- **Generating reusable snippets/configurations**: `#snippet` / `#config`.
- **Never delete or overwrite the memory database.** If the user asks to clear the history, direct them to handle it manually in their own terminal — do not do it yourself. `notes.update` edits one note in place and snapshots the previous version (recoverable via `notes.history`/`notes.restore`); it is not a wipe.

## Registering solved problems (mandatory)

Whenever you solve a **non-trivial** problem — bug, configuration error, unexpected behavior, dependency failure, regression — record a `#problem` note **before closing the task**. The next session must not re-live the same problem: your note is the shortcut.

**Required content: Symptom, Cause, Solution.** The `notes.add` tool **refuses** to record a `#problem` note that lacks the three sections.

```
Symptom: <what was observed / error message>
Cause: <root cause, not the symptom>
Solution: <what fixed it, reproducible>
Files: <paths touched, optional>
Scope: <global | project:<name> | machine:<name>, optional>
```

Rules:

- **Root cause, not symptom.** "Missing `exec` on `/tmp` mount" is a cause; "the command failed" is a symptom.
- **Reproducible solution:** the exact command or steps that fix it, not "I tweaked the config".
- **Do not register trivial matters** (your typo, a syntax doubt, a command you mistyped). The criterion: if another agent could fall into the same problem, record it.
- **Before recording, search.** `notes.search` with the symptom. If the same problem is already documented with the same solution, do not duplicate.
- Multiple problems solved in one session = several notes, one per problem.

## Correcting a note (`notes.update`) — last resort

A wrong note is worse than a missing one: the next agent trusts it. Use
`notes.update` **only** when a saved note is now known to be factually wrong,
or when two notes contradict each other and one must be corrected.

- **Only for conflicts/wrong facts.** New information, a changed decision,
  extra detail, style — those are new notes, not edits. If the old note is
  merely incomplete or outdated but not wrong, add a new note and let both
  stand with their dates.
- **Correct, do not rewrite history.** Change only the fields that are wrong;
  leave the rest. The previous version is snapshotted automatically (read it
  with `notes.history`, bring it back with `notes.restore`), but the point of
  `update` is to record a *correction*, not to "clean up" notes you disagree
  with — for suspicion without a fix, `dispute` is the right move.
- **The timestamp moves to now.** After an update the note is stamped with the
  edit time (with seconds) and jumps to the top of `notes.search`/list. That
  is intentional: it shows the correction is newer than the notes it
  contradicts.
- **#problem stays complete.** If the resulting note is `#problem`, it still
  needs Symptom, Cause and Solution; the tool refuses otherwise.
- **Say what changed.** When the correction is not obvious, start the new
  content with `Correction: <old claim> → <verified fact>` so a later reader
  understands why the note changed.

### History: nothing is overwritten away

Every `update` (and therefore `restore`) stores the note's previous state in
`note_revisions` *before* rewriting it. Correction is therefore deletion-free:

- `notes.history` shows the live note and each prior version labelled `rev #N`,
  with the moment it was superseded and the flags it carried then.
- `notes.restore` is just another update: it snapshots the current version
  first, so restoring can never lose anything — you can always restore again.
- Only content, title, tags and category come back; the note is re-verified
  (dispute/retraction cleared), like any `update`.
- `update` is still **not** for rewording or for appending facts — history is a
  safety net, not a licence to churn. If nothing is wrong, add a note or
  `confirm`.

## Trust: confirm, dispute, retract

A note carries a trust signal. Three operations set it, none of them deletes:

| You want to… | Do | Effect |
|---|---|---|
| say "this still holds" after using it | `notes.confirm` | ✔ verified now; clears dispute/retraction |
| warn others it looks wrong, **no fix yet** | `notes.dispute` (with `why`) | ⚠ shown, sorted **last**, reason mandatory |
| silence junk/obsolete/a test leftover | `notes.retract` (optional `why`) | 🚫 hidden from search/list (reversible) |
| fix what is actually wrong | `notes.update` | rewrites the note, re-verifies, clears flags |

Choosing the right one:

- **Wrong and you have the fix** → `update`. **Wrong but no fix yet** → `dispute`
  (never leave a suspected-wrong note unflagged).
- **Right, and you just relied on it** → `confirm`. This is the cheap, positive
  signal; confirming costs one call and tells the next agent the note survived
  real use. Prefer it over writing a duplicate "still works" note.
- **Noise** (a probe/test note, a superseded duplicate, a scratch entry) →
  `retract`, not silence and never deletion. `includeRetracted: true` still
  shows it, and `confirm`/`update` revive it.
- `dispute` and `retract` are mutually exclusive: disputing a retracted note
  makes it visible again (warning), retracting a disputed one hides it.

Display and ordering: search/list print `✔ verified <ts>`, `⚠ disputed <ts>` or
`🚫 retracted <ts>` under each note. Disputed notes always sort **after** clean
ones, so a conflict never outranks a trustworthy note. `includeRetracted: true`
reveals retracted notes for auditing.

Closing ritual: before you finish, the notes you *relied on* get a `confirm`
(if verified) or a `dispute` (if suspect), and any notes you created as scratch
get `retract`. `update` stays reserved for genuine corrections.

## Conventions

- **Categories**: `#problem`, `#decision`, `#config`, `#snippet`, `#architecture`, `#user`, `#general`.
- **User notes (`#user`)**: facts about the user (name, how to address them, preferences, standing context, goals, projects, working style). Always scope `machine` (matches every machine, so it is injectable when pinned) — never `global`, which is excluded from injection. The agent pins only the ones that matter across sessions, against the fixed 12-pin budget; unpinned user notes stay searchable via `notes.search`.
- **Scope**: how far the fact applies — `global` (machine-independent; the default, may be omitted), `project:<name>`, or `machine:<name>`. Scope is orthogonal to category and tags: it tells a reader on another machine *where* the fact applies, not whether it should have been registered at all.
- **Tags**: keywords separated by space, without `#` (e.g.: `selinux module`).
- **Title**: short and specific — for problems, describe the symptom (e.g. "sandbox TUI fails without exec on /tmp").
- **Author**: who registered the note (`author` on `notes.add`). Agents pass their own name; humans registering from the panel pass theirs. Set at creation, never changed by `update`; shown as `(by <author>)` in search/list/view.
- **Content**: the fact/decision + the why + relevant commands or paths. Write for someone who hasn't seen the conversation.

## Backup and transport

The database is local state, not versioned. To carry memory between machines
(or keep a copy), copy the SQLite file while the app is closed:

```bash
cp ~/.local/share/opencode/memory/notes.db ~/notes-backup.db
```

The FTS5 index is rebuilt by the triggers, so the copy is self-contained
(`notes.history` still works — revisions live in the same file).

## Quick check

Use `notes.doctor`: it reports the runtime, the SQLite backend (native
`node:sqlite`), FTS5 availability, schema version, note count and index sync.

If the tools report that SQLite is unavailable, the runtime has no
`node:sqlite` builtin: the plugin needs Node >= 22 (Bun and the desktop app's
Electron already ship it). Rerun `./setup.sh` in the opencode-tools repo root
to re-link the plugin and refresh dependencies.

## Writing notes in English

**Notes must be written in English** to keep the memory usable across agents and sessions. Existing Portuguese notes remain in the database as legacy; new notes go in English following the Symptom / Cause / Solution format above.
