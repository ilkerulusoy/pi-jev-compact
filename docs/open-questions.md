# Open questions

Each item records the answer, how it was established, and where.

"Executed" means code was run against the installed
`@earendil-works/pi-coding-agent` (0.85.1) in a throwaway session directory under
`/tmp/agent-builds/`. "Source-read" means the file was read but not run.

## Q1 — AgentMessage to Message conversion — ANSWERED

Executed. `SessionManager.create(cwd, sessionDir)` accepted all three of:

- `{ role: "user", content: [{ type: "text", ... }] }`
- `{ role: "assistant", content: [{ type: "text" }, { type: "toolCall", id, name, arguments }] }`
- `{ role: "toolResult", toolCallId, toolName, content, isError }`

So a live-window message with a tool call and its result can be replayed through
`appendMessage` without conversion.

Still untested: `thinking` content parts, `bashExecution` messages, and image
content parts.

## Q1b — appendMessage guard — ANSWERED, CONTRADICTS THE DOC

Executed. The doc comment on `appendMessage` says it does not allow
`CompactionSummaryMessage` and `BranchSummaryMessage`. In practice both were
accepted with no error, written to the file, and reloaded as
`compactionSummary` and `branchSummary` messages inside `message` entries.

Consequence: the guard cannot be relied on to catch a replay mistake. Writing
those roles through `appendMessage` produces entries of type `message`, not
top-level `compaction` or `branch_summary` entries, which is the wrong shape.
`src/core/replay.ts` must refuse these roles itself.

## Q2 — Reload fidelity — ANSWERED

Executed. Wrote user, assistant-with-toolCall, and toolResult; reloaded with
`loadEntriesFromFile`, `migrateSessionEntries`, and
`sessionEntryToContextMessages`.

Roles came back in order: `user -> assistant -> toolResult`.
Pairing survived: the `toolCall.id` still equalled the `toolResult.toolCallId`.

## Q3 — Existing compaction in the live window — ANSWERED

Executed. Seeded a session with two user messages, then
`appendCompaction(summary, keepId, tokensBefore, details, fromHook)`, then one
more message.

After reload, `buildContextEntries` returned `compaction -> message -> message`
and the effective roles were `compactionSummary -> user -> assistant`. The
`firstKeptEntryId` still matched the intended entry and `fromHook` was preserved.

So a prior summary is reproduced with `appendCompaction`, not `appendMessage`, and
`firstKeptEntryId` must point at an entry id **in the new session**, which means
the survivors it refers to have to be appended before the compaction entry that
cites them, or the id has to be captured as it is written.

## Q4 — Pairing enforcement below the extension — OPEN

`appendMessage` does no pairing check (source-read), and `convertToLlm` has none
(source-read). Provider serialization lives in a separate package that has not
been inspected.

Q2 shows a correctly written pair survives. It does not show what happens to an
incorrectly written one. This extension must guarantee pairing itself and refuse
to write when it cannot.

## Q5 — newSession behavior — OPEN

Needed: whether `ctx.newSession()` prompts the user, what `cancelled: true` means
for a session whose `setup` already appended entries, and whether
`parentSession` affects listing or resuming.

Note: the probes used `SessionManager.create` directly, which is not the path the
extension will take. `ctx.newSession({ setup })` remains untested.

## Q6 — newSession versus fork — OPEN

`SessionManager` also exposes static `inMemory`, `forkFrom`, `open`,
`continueRecent`, `list`, and `listAll`. `inMemory` is useful for tests.
`forkFrom` copies full history across project directories, which is not what is
wanted here. No recommendation yet between `ctx.newSession({ setup })` and
`ctx.fork(entryId, { withSession })`.

## Q7 — Automatic compaction scope — CLOSED BY USER

Manual only. `/jev-compact` performs the compaction. No
`session_before_compact` hook, no threshold handling, no tail-cut fallback.
`src/hooks/` is dropped from the plan.

## Q8 — Key source — OPEN

`TYPESAFE_API_KEY` from the environment is the simple path. Depending on
`pi-typesafe` would add request validation, byte-limit enforcement, and stronger
response checking than a hand-rolled client, at the cost of a dependency.
