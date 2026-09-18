import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { collectLiveWindow } from "../src/core/live-window";
import { collectToolCalls } from "../src/core/tool-calls";
import { scoreCalls } from "../src/core/decide";
import { planReplay, validatePlan } from "../src/core/replay";
import { DEFAULT_SETTINGS } from "../src/types";
import type { JevAsker } from "../src/types";

/**
 * These tests drive the real SessionManager from the installed pi package: they
 * write a session, replay a pruned plan into a new one, reload it from disk, and
 * check the effective context. Nothing here contacts TypeSafe.
 *
 * Skipped when pi is not resolvable, so the suite still runs standalone.
 */
let sm: any;
try {
  sm = await import("@earendil-works/pi-coding-agent");
} catch {
  sm = undefined;
}

const dirs: string[] = [];
const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pi-jev-compact-"));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const fakeJev = (table: Record<string, { keepCall: number; keepResult: number }>): JevAsker => ({
  async ask(_state, questions) {
    const answers: Record<string, { noul: number }> = {};
    for (const name of Object.keys(questions)) {
      const [kind, short] = name.split("_");
      const entry = table[short!]!;
      answers[name] = { noul: kind === "call" ? entry.keepCall : entry.keepResult };
    }
    return { model: "fake", answers };
  },
});

const readBack = (file: string) => {
  // Reopen from disk so the assertions run against persisted bytes, not memory.
  const reopened = sm.SessionManager.open(file);
  const withType = reopened.getEntries().filter((e: any) => e.type !== undefined);
  const contextEntries = sm.buildContextEntries(withType);
  const messages = contextEntries.flatMap((e: any) => sm.sessionEntryToContextMessages(e));
  return { entries: withType, contextEntries, messages };
};

test("a replayed plan round-trips through a real session with pairing intact", { skip: !sm }, async () => {
  const source = sm.SessionManager.create(process.cwd(), freshDir());
  source.appendMessage({ role: "user", content: [{ type: "text", text: "fix the failing test" }] });
  for (const [i, body] of [["1", "A"], ["2", "B"], ["3", "C"]].entries()) {
    source.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: `step ${body[0]}` },
        { type: "toolCall", id: `tc_${body[0]}`, name: "read", arguments: { path: `f${i}.ts` } },
      ],
    });
    source.appendMessage({
      role: "toolResult",
      toolCallId: `tc_${body[0]}`,
      toolName: "read",
      content: [{ type: "text", text: body[1]!.repeat(2000) }],
      isError: false,
    });
  }
  source.appendMessage({ role: "user", content: [{ type: "text", text: "now what" }] });

  const branch = readBack(source.getSessionFile()).contextEntries;
  const window = collectLiveWindow(branch);
  const calls = collectToolCalls(window.messages, 0);
  assert.equal(calls.length, 3);

  const { decisions } = await scoreCalls(
    calls,
    { context: "", goal: "", history: [] },
    10,
    fakeJev({
      t1: { keepCall: 0.9, keepResult: 0.9 },
      t2: { keepCall: 0.1, keepResult: 0.1 },
      t3: { keepCall: 0.9, keepResult: 0.1 },
    }),
    DEFAULT_SETTINGS,
  );
  const plan = planReplay(window.messages, calls, decisions, DEFAULT_SETTINGS);
  assert.deepEqual(validatePlan(plan.messages), []);

  // Replay into a brand new session, which is the only write path available.
  const target = sm.SessionManager.create(process.cwd(), freshDir());
  for (const message of plan.messages) target.appendMessage(message);

  const reloaded = readBack(target.getSessionFile());
  const calledIds = reloaded.messages
    .filter((m: any) => m.role === "assistant")
    .flatMap((m: any) => m.content.filter((c: any) => c.type === "toolCall").map((c: any) => c.id));
  const resultIds = reloaded.messages
    .filter((m: any) => m.role === "toolResult")
    .map((m: any) => m.toolCallId);

  assert.deepEqual(calledIds, ["tc_1", "tc_3"], "the middle call stayed dropped after reload");
  assert.deepEqual(resultIds, ["tc_1", "tc_3"], "pairing survived the write and the reload");
  assert.deepEqual(validatePlan(reloaded.messages), [], "reloaded context is still consistent");

  const texts = reloaded.messages.flatMap((m: any) =>
    Array.isArray(m.content) ? m.content.filter((c: any) => c.type === "text").map((c: any) => c.text) : [],
  );
  assert.ok(texts.includes("fix the failing test"));
  assert.ok(texts.includes("step 2"), "assistant text survives even when its call is dropped");
  assert.ok(texts.includes("now what"));

  const truncated = reloaded.messages.find((m: any) => m.toolCallId === "tc_3");
  assert.ok(truncated.content[0].text.includes("re-run the tool if needed"));
  const kept = reloaded.messages.find((m: any) => m.toolCallId === "tc_1");
  assert.equal(kept.content[0].text.length, 2000, "a kept result is byte-identical");
});

test("a prior compaction is reproduced with appendCompaction, not appendMessage", { skip: !sm }, () => {
  const s = sm.SessionManager.create(process.cwd(), freshDir());
  s.appendMessage({ role: "user", content: [{ type: "text", text: "old" }] });
  const keptId = s.appendMessage({ role: "user", content: [{ type: "text", text: "kept" }] });
  s.appendCompaction("PRIOR SUMMARY", keptId, 1234, { compactor: "pi-jev-compact" }, true);
  s.appendMessage({ role: "assistant", content: [{ type: "text", text: "after" }] });

  const { entries, contextEntries, messages } = readBack(s.getSessionFile());
  assert.deepEqual(contextEntries.map((e: any) => e.type), ["compaction", "message", "message"]);
  assert.deepEqual(messages.map((m: any) => m.role), ["compactionSummary", "user", "assistant"]);

  const compaction = entries.find((e: any) => e.type === "compaction");
  assert.equal(compaction.firstKeptEntryId, keptId);
  assert.equal(compaction.fromHook, true);

  // The live window is what follows that compaction, and it reports the summary.
  const window = collectLiveWindow(contextEntries);
  assert.equal(window.priorCompaction?.summary, "PRIOR SUMMARY");
  assert.deepEqual(window.messages.map((m: any) => m.message.role), ["user", "assistant"]);
});

test("appendMessage does not refuse summary roles, so validatePlan must", { skip: !sm }, () => {
  const s = sm.SessionManager.create(process.cwd(), freshDir());
  // The doc comment on appendMessage says these roles are not allowed. On 0.85.1
  // the call is accepted and stored as an ordinary `message` entry, which is the
  // wrong shape for a summary. Pinned here so a future guard surfaces as a failure.
  const id = s.appendMessage({ role: "compactionSummary", summary: "x", tokensBefore: 1 } as any);
  assert.equal(typeof id, "string", "accepted rather than refused");

  const written = s.getEntries().filter((e: any) => e.type !== undefined);
  assert.deepEqual(written.map((e: any) => e.type), ["message"], "stored with the wrong shape");
  assert.equal(written[0].message.role, "compactionSummary");

  // Which is why the guard has to live in our own validation step.
  assert.equal(validatePlan([{ role: "compactionSummary", summary: "x" }]).length, 1);
});
