import assert from "node:assert/strict";
import { test } from "node:test";
import { evidenceLines, planCompaction } from "../src/commands/jev-compact";
import { DEFAULT_SETTINGS } from "../src/types";
import type { JevAsker } from "../src/types";

/**
 * The run has to be auditable: did a request actually go out, what did it cost,
 * how long did it take, and on what basis were the decisions made. These tests
 * check that the reported numbers come from the response rather than being
 * asserted by the code.
 */

const user = (id: string, text: string) => ({
  id,
  type: "message",
  message: { role: "user", content: [{ type: "text", text }] },
});
const call = (id: string, callId: string) => ({
  id,
  type: "message",
  message: {
    role: "assistant",
    content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: `${callId}.ts` } }],
  },
});
const result = (id: string, callId: string, body: string) => ({
  id,
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: callId,
    toolName: "read",
    content: [{ type: "text", text: body }],
    isError: false,
  },
});

const branch = () => [
  user("e1", "fix the login redirect"),
  call("a1", "tc_1"),
  result("r1", "tc_1", "A".repeat(4000)),
  call("a2", "tc_2"),
  result("r2", "tc_2", "B".repeat(4000)),
  user("e2", "and add a test"),
  ...Array.from({ length: 6 }, (_, i) => user(`f${i}`, `later ${i}`)),
];

const settings = { ...DEFAULT_SETTINGS };

/** Reports usage and a model name, the way the real API does. */
const accountingJev = (
  scores: Record<string, [number, number]>,
  usage: { input_tokens: number; output_tokens: number },
  model = "jev-1.13.0",
  delayMs = 0,
): JevAsker => ({
  async ask(_state, questions) {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const answers: Record<string, { noul: number }> = {};
    for (const name of Object.keys(questions)) {
      const [kind, short] = name.split("_");
      const pair = scores[short!]!;
      answers[name] = { noul: kind === "call" ? pair[0] : pair[1] };
    }
    return { model, answers, usage };
  },
});

test("token counts and model name are taken from the response", async () => {
  const outcome = await planCompaction(
    branch(),
    accountingJev({ t1: [0.9, 0.9], t2: [0.1, 0.1] }, { input_tokens: 1074, output_tokens: 274 }),
    settings,
  );
  assert.equal(outcome.status, "ok", outcome.message);
  assert.deepEqual(outcome.stats!.models, ["jev-1.13.0"]);
  assert.equal(outcome.stats!.inputTokens, 1074);
  assert.equal(outcome.stats!.outputTokens, 274);
  assert.equal(outcome.stats!.requests, 1);
  assert.equal(outcome.stats!.questionsAsked, 4, "two calls, two questions each");
});

test("usage is summed across concurrent batches", async () => {
  // A tiny request budget forces one batch per call.
  const outcome = await planCompaction(
    branch(),
    accountingJev({ t1: [0.9, 0.9], t2: [0.1, 0.1] }, { input_tokens: 500, output_tokens: 100 }),
    { ...settings, maxRequestTokens: 700 },
  );
  assert.equal(outcome.status, "ok", outcome.message);
  assert.equal(outcome.stats!.requests, 2);
  assert.equal(outcome.stats!.inputTokens, 1000, "500 per request, summed");
  assert.equal(outcome.stats!.outputTokens, 200);
});

test("elapsed time is measured, not assumed", async () => {
  const outcome = await planCompaction(
    branch(),
    accountingJev({ t1: [0.9, 0.9], t2: [0.1, 0.1] }, { input_tokens: 10, output_tokens: 0 }, "jev-1.13.0", 40),
    settings,
  );
  assert.equal(outcome.status, "ok");
  assert.ok(outcome.stats!.slowestRequestMs >= 35, `slowest ${outcome.stats!.slowestRequestMs} ms`);
  assert.ok(outcome.stats!.elapsedMs >= outcome.stats!.slowestRequestMs);
});

test("a response without usage reports zero rather than an estimate", async () => {
  const noUsage: JevAsker = {
    async ask(_state, questions) {
      const answers: Record<string, { noul: number }> = {};
      for (const name of Object.keys(questions)) answers[name] = { noul: 0.1 };
      return { answers };
    },
  };
  const outcome = await planCompaction(branch(), noUsage, settings);
  assert.equal(outcome.status, "ok", outcome.message);
  assert.equal(outcome.stats!.inputTokens, 0);
  assert.deepEqual(outcome.stats!.models, [], "no model reported means no model claimed");

  const lines = evidenceLines(outcome, settings);
  assert.ok(lines.some((l) => l.includes("usage not reported by the API")));
  assert.ok(lines.some((l) => l.includes("model (not reported)")));
});

test("the goal that was sent is available for inspection", async () => {
  const outcome = await planCompaction(
    branch(),
    accountingJev({ t1: [0.9, 0.9], t2: [0.1, 0.1] }, { input_tokens: 1, output_tokens: 0 }),
    settings,
  );
  // Both ends are sent: the original task and where the work is now.
  assert.ok(outcome.goal!.includes("fix the login redirect"), "the original task survives");
  assert.ok(outcome.goal!.includes("later 5"), "the newest prompts are included");
  assert.match(outcome.goal!, /intermediate request\(s\) omitted/);
});

test("the score spread is reported so a one-sided run is visible", async () => {
  const outcome = await planCompaction(
    branch(),
    accountingJev({ t1: [0.05, 0.02], t2: [0.05, 0.02] }, { input_tokens: 1, output_tokens: 0 }),
    settings,
  );
  assert.equal(outcome.status, "ok");
  assert.deepEqual(outcome.stats!.scoreBuckets, { low: 2, mid: 0, high: 0 });

  const lines = evidenceLines(outcome, settings);
  assert.ok(lines.some((l) => l.includes("keepResult spread: 2 below 0.30")));
  assert.ok(
    lines.some((l) => l.startsWith("note: no result scored at or above 0.70")),
    "a run where nothing was kept should say so",
  );
});

test("a mixed run does not raise the one-sided note", async () => {
  const outcome = await planCompaction(
    branch(),
    accountingJev({ t1: [0.95, 0.91], t2: [0.05, 0.02] }, { input_tokens: 1, output_tokens: 0 }),
    settings,
  );
  assert.deepEqual(outcome.stats!.scoreBuckets, { low: 1, mid: 0, high: 1 });
  const lines = evidenceLines(outcome, settings);
  assert.ok(!lines.some((l) => l.startsWith("note: no result scored")));
});

test("evidence states plainly when no request was sent", async () => {
  const outcome = await planCompaction(branch(), accountingJev({}, { input_tokens: 0, output_tokens: 0 }), {
    ...settings,
    preserveRecentMessages: 99,
  });
  assert.equal(outcome.status, "nothing_to_do");
  assert.deepEqual(evidenceLines(outcome, settings), ["pi-jev-compact: nothing was sent to Jev."]);
});

test("evidence reports the slice when the window was too large", async () => {
  const entries: any[] = [user("e0", "run the suite")];
  for (let i = 1; i <= 3000; i++) {
    entries.push(call(`a${i}`, `tc_${i}`), result(`r${i}`, `tc_${i}`, "y".repeat(500)));
  }
  const jev: JevAsker = {
    async ask(_state, questions) {
      const answers: Record<string, { noul: number }> = {};
      for (const name of Object.keys(questions)) answers[name] = { noul: 0.1 };
      return { model: "jev-1.13.0", answers, usage: { input_tokens: 2000, output_tokens: 300 } };
    },
  };
  const outcome = await planCompaction(entries, jev, settings);
  assert.equal(outcome.status, "ok", outcome.message);

  const lines = evidenceLines(outcome, settings);
  const scope = lines.find((l) => l.startsWith("scope:"));
  assert.ok(scope, "a sliced run must report its scope");
  assert.match(scope!, /oldest \d+ of 6001 messages/);
  assert.match(scope!, /\d+ of 3000 calls scored/);
  assert.ok(outcome.stats!.inputTokens > 2000, "usage accumulated across many batches");
});
