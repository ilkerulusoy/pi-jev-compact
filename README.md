# pi-jev-compact

Selective, verbatim context compaction for [Pi](https://pi.dev) using TypeSafe's
Jev model. Jev scores every tool call and its result; calls that are no longer
needed are dropped, the rest stays verbatim. No LLM writes a summary of your
conversation.

**Status: implemented, 71 tests passing, never run against a live Jev.** Every
test uses a fake Jev or a stubbed transport, so the request shape and the
decision logic are exercised but no real model judgment has been observed. The
first live run is still ahead.

Independent project. Not affiliated with TypeSafe AI or the Pi authors.

## Why

Pi's built-in compaction asks an LLM to summarize old turns. A summary is lossy:
an exact error string, a file path, a command, or a constraint can disappear
right when it becomes relevant again.

This extension never rewrites your messages. It asks Jev, per tool call, whether
the call and whether its output still matter, then deletes what is no longer
needed. User and assistant text is never removed or rephrased.

Prior art this design is taken from, with thanks:

- [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (MIT) —
  the two-noul-per-call question design, the state fitting ladder, and the
  decision-to-transcript mapping. Built for Claude Code.
- [pi-vcc](https://github.com/sting8k/pi-vcc) (MIT) — the verified Pi
  `session_before_compact` integration, live-window collection with orphan
  recovery, and cutting away from `toolResult` boundaries.

## How it will work

```
/jev-compact
      │
      ▼
ctx.sessionManager.buildContextEntries()
      │
      ▼
live window: entries after the last compaction (orphan recovery included)
      │
      ▼
pair tool_use with tool_result by id; pin the first and newest N messages
      │
      ▼
build Jev state: whole window, tool outputs replaced by "ok, 4213 chars (omitted)"
fit into maxStateTokens through a staged ladder
      │
      ▼
Jev: two nouls per non-pinned call
      call_tN   — knowing this call was made still matters
      result_tN — its full output still needs to stay verbatim
      │
      ▼
decide per call, against keepThreshold
      keepResult >= t  →  keep call and result
      keepCall   >= t  →  keep call, truncate result to a head plus a note
      neither          →  drop the call together with its result
      │
      ▼
ctx.newSession({ parentSession, setup }) and replay the survivors
      │
      ▼
new session file, selectively pruned, persisted
the previous session file is never modified
```

### Selective removal, and why it needs a new session

Pi's `session_before_compact` hook accepts `{ summary, firstKeptEntryId }`. That
is a single cut point: everything before the cut is replaced by a summary string,
everything after it is kept verbatim. It cannot express "drop this old call but
keep that older one".

```
What a single cut point can express:

  m0  m1  m2  m3  m4 │ m5  m6  m7
  └── summarized ────┘└── verbatim ──┘

What selective removal needs:

  m0  m1  m2  m3  m4  m5  m6  m7
  ▓▓  ✗   ✓   ✗   ◐   ✗   ✓   ▓▓
```

Verified: extensions receive `ReadonlySessionManager`, which declares no
`append*` methods, so the hook cannot persist an edited message list. The full
`SessionManager`, which has `appendMessage`, is handed to the `setup` callback of
`ctx.newSession()` on `ExtensionCommandContext`. `withSession` does not provide
it; `ReplacedSessionContext` only adds `sendMessage` and `sendUserMessage`.

Consequence, stated plainly: selective removal is available from a user-invoked
command, not from automatic compaction, and it produces a new session file with a
new identity rather than editing the current one.

## Planned commands and settings

Manual only. There is no `session_before_compact` hook, no threshold handling,
and no automatic path. Pi's own compaction stays exactly as it is until you type
the command.

| Command | Effect |
| --- | --- |
| `/jev-compact` | Score the live window, then write a pruned new session |
| `/jev-compact report` | Score and report only; write nothing |

| Setting | Default | Description |
| --- | --- | --- |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched; the first is always kept |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one question batch |
| `truncateHeadChars` | `300` | Characters of a dropped result retained before its note |
| `minReductionRatio` | `0.25` | Below this estimated saving, nothing is written |

`TYPESAFE_API_KEY` is read from the environment. A key stored by `/typesafe
login` may also be usable through `pi-typesafe`; that integration is not decided
yet.

## What is verified, and what is not

Established by running code against the installed Pi 0.85.1 in a throwaway
session directory:

- `appendMessage` accepts a realistic `user`, `assistant` with a `toolCall`, and
  `toolResult` sequence, so live-window messages replay without conversion.
- A written session reloads through `loadEntriesFromFile`,
  `migrateSessionEntries`, and `sessionEntryToContextMessages` with roles in
  order and `toolCall.id` still matching `toolResult.toolCallId`.
- A prior summary is reproduced with `appendCompaction`, which survives reload
  with its `firstKeptEntryId` and `fromHook` intact.
- `appendMessage` does **not** refuse `compactionSummary` or `branchSummary`
  roles, despite its own doc comment saying it does. They are written as
  ordinary `message` entries, which is the wrong shape. The replay code has to
  reject those roles itself.

Established by reading source only:

- `SessionBeforeCompactResult` accepts only `cancel` and `compaction`, and
  `CompactionResult.summary` is a string.
- Extensions receive `ReadonlySessionManager`, which declares no writers.
- Exactly four entry kinds project into context: `message`, `custom_message`,
  `branch_summary`, `compaction`.
- `appendMessage` performs no pairing, ordering, or content validation.
- `convertToLlm` is an elementwise type mapper with no pairing logic.

Covered by the test suite (71 tests, `npm test`):

- Live-window collection, including orphan recovery when `firstKeptEntryId` is
  empty or missing, and skipping entry kinds that do not reach context.
- Pairing by tool call id, pinning, and the rule that a call without a result is
  never a candidate.
- The state shrink ladder, that tool output never reaches the request, and that
  an unfittable window raises rather than sending a truncated state.
- The three threshold actions, that a probability exactly at the threshold keeps,
  and that pinned calls are decided without any request.
- Selective removal end to end: a middle call dropped while an older one stays,
  assistant text preserved when a sibling call is dropped, and no result ever
  left without its call.
- A real `SessionManager` round-trip: write, reopen from disk, rebuild context,
  and confirm `toolCall.id` still matches `toolResult.toolCallId`.
- Refusal paths: HTTP failure, malformed answers, declined confirmation, report
  mode, a cancelled session, and a missing key. Each writes nothing.
- Session replacement: post-write reporting happens through the `withSession`
  context, and a test fails if the captured command `ctx` is touched after the
  session has been replaced.

## Checking what a run actually did

Every run writes a self-contained HTML report and puts its path in the
notification. Pi's `ExtensionUIContext` has no `log` method, so per-call detail
cannot go to the transcript; the report is where it lives. A failed run gets one
too, which is when the request body matters most.

The report contains:

- **Every request and response verbatim**, with URL, status, duration, and bytes
  sent. This is how you confirm a request went out at all. The API key travels
  in a header and is never recorded.
- **One row per call**: tool, arguments, result size, characters freed, both
  probabilities drawn against the threshold, the outcome, and a preview of the
  result being dropped. Rows are red for removed, yellow for truncated, green
  for kept, with a filter box.
- **The goal** Jev judged against, and a sample of the `history` it received.
- **Run statistics** and the highest and lowest scoring calls.

A sample row reads:

```
t1  bash  command=npm test -- auth  3,024  −2,724
    keepCall  ██████████████████·· 0.88
    keepResult ██·················· 0.11   → result truncated
    preview: output line for call 1: xxxxxxxxxx…
```

The orange tick in each bar marks the threshold, so a decision that only just
went one way is visible at a glance.

The notification itself is short, and states how many requests were sent:

```
pi-jev-compact: 83% smaller; 34 kept, 34 results truncated, 169 calls dropped,
0 pinned; state ~21201 tok (full) in 4 request(s). 4 request(s) sent.
Report: /tmp/pi-jev-compact/report-2026-02-14T09-31-07-412Z.html
```

The same figures are in the report's header cards. Where each comes from:

Where each number comes from:

| Line | Source |
| --- | --- |
| requests, questions | Counted locally before sending |
| model | The `model` field of the response. `(not reported)` when absent |
| tokens | The `usage` field of the response. `0` when the API omits it, never estimated |
| time | Measured around each request. Batches run concurrently, so total is not the sum |
| state sent | The local estimate that drove the fitting decision, plus which stage was reached |
| keepResult spread | The returned probabilities, bucketed |
| chars | Counted on the transcript before and after planning |
| per-call lines | Both probabilities behind each decision |

The state token figure is an estimate from character counts, not a tokenizer, so
compare it against the reported input tokens rather than trusting it directly.

A run where nothing scored at or above 0.70 adds an explicit note. That is worth
reading: it usually means the goal line did not describe the work well, so check
what was sent before accepting that none of the output was worth keeping.

`/jev-compact report` produces the full report and writes nothing to the session.

Reports are written to `$TMPDIR/pi-jev-compact/` with mode 0600, because they
contain a sample of your transcript. They are not cleaned up automatically.

## Sessions too large to describe in one request

Jev has to see the whole window to judge any single call, so a very long session
can exceed `maxStateTokens` even after every shrink stage. Measured with the
default 25k budget and small results:

| Tool calls | Outcome |
| --- | --- |
| 900 | Fits at the `old calls merged` stage, ~18k tokens |
| 1500 | Overflows at ~30k |
| 3000 | Overflows at ~61k |

Rather than refusing, the command scores the oldest slice that does fit and
leaves the newer calls alone, so each run makes progress and can be repeated.
The slice boundary is a message index, so a call and its result always travel
together. On a 3000-call session this converges in four runs:

```
pass 1  25% smaller   749 calls dropped   oldest 1500/6001 messages
pass 2  50% smaller  1125 calls dropped   oldest 2251/4503 messages
pass 3 100% smaller  1123 calls dropped   whole window fits
pass 4  nothing left to do
```

The message says which slice was used and that another run is worthwhile. The
`minReductionRatio` check is measured against the slice, not the whole window,
so a useful sliced pass is not rejected for looking small overall.

Still open:

1. No live Jev call has been made. Decision quality is unmeasured; only the
   request shape and the code paths are tested.
2. Whether any provider adapter repairs unpaired tool calls. A correctly written
   pair survives; a deliberately broken one has not been pushed through a
   provider, which is why `validatePlan` refuses to write instead of relying on
   downstream repair.
3. `ctx.newSession({ setup })` is exercised only through a stub. Its real
   prompting behavior, and what `cancelled` means for a partially seeded
   session, are untested.
4. Whether `ctx.fork(entryId, { withSession })` is a better seam.
5. `thinking` parts, `bashExecution` messages, and image content in replay.
6. Whether to depend on `pi-typesafe` for request validation and byte limits.
7. The token estimator is inherited from fast-jev-compaction and has not been
   calibrated against Jev's own reported counts here.

## Safety rules

Nothing is written unless every check passes.

```
Jev error, missing key, or state that will not fit  →  write nothing
estimated saving below minReductionRatio            →  write nothing
any tool result left without its call               →  abort the write
the previous session file                           →  never modified
```

A Jev probability is a judgment, not proof that a result is safe to delete. The
assistant can re-run a tool or re-read a file. Pi's own automatic compaction is
untouched by this extension.

## Development

```bash
npm install
npm test        # 71 tests, fake Jev, no network
npm run typecheck
```

Layout:

```
index.ts                      registration
src/types.ts                  shared types and defaults
src/commands/jev-compact.ts   the only entry point, plus planCompaction
src/core/live-window.ts       live window, orphan recovery
src/core/tool-calls.ts        call/result pairing, pinning
src/core/state.ts             state fitting ladder, token estimate
src/core/jev.ts               POST /v1/systemone, response validation
src/core/decide.ts            questions, batching, thresholds
src/core/replay.ts            plan, truncation, and the pairing guard
src/core/trace.ts             records requests and responses verbatim
src/core/report.ts            the HTML report
tests/core.test.ts            pure logic
tests/session.test.ts         real SessionManager round-trip
tests/command.test.ts         planCompaction outcomes
tests/e2e.test.ts             the registered command, stubbed transport
tests/large-window.test.ts    overflow and slicing on call-heavy sessions
tests/evidence.test.ts        reported tokens, timings, model, score spread
tests/report.test.ts          HTML report contents, escaping, file permissions
```

`planCompaction` is exported so the decision path can be driven without a Pi
session. It never writes; the command does that after confirmation.

## License

MIT
