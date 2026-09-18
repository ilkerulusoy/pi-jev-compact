import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionLines, planCompaction } from "../src/commands/jev-compact";
import { DEFAULT_SETTINGS } from "../src/types";
import type { JevAsker } from "../src/types";

const user = (id: string, text: string) => ({
  id,
  type: "message",
  message: { role: "user", content: [{ type: "text", text }] },
});
const assistant = (id: string, text: string, callId: string) => ({
  id,
  type: "message",
  message: {
    role: "assistant",
    content: [
      { type: "text", text },
      { type: "toolCall", id: callId, name: "read", arguments: { path: "a.ts" } },
    ],
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

/** Three calls, each with a 2000-char result, plus surrounding text. */
const branch = () => [
  user("e1", "fix the failing test"),
  assistant("e2", "step 1", "tc_1"),
  result("e3", "tc_1", "A".repeat(2000)),
  assistant("e4", "step 2", "tc_2"),
  result("e5", "tc_2", "B".repeat(2000)),
  assistant("e6", "step 3", "tc_3"),
  result("e7", "tc_3", "C".repeat(2000)),
  user("e8", "now what"),
];

const jev = (table: Record<string, [number, number]>): JevAsker => ({
  async ask(_state, questions) {
    const answers: Record<string, { noul: number }> = {};
    for (const name of Object.keys(questions)) {
      const [kind, short] = name.split("_");
      const pair = table[short!]!;
      answers[name] = { noul: kind === "call" ? pair[0] : pair[1] };
    }
    return { model: "fake", answers };
  },
});

const failing = (message: string): JevAsker => ({
  async ask() {
    throw new Error(message);
  },
});

const settings = { ...DEFAULT_SETTINGS, preserveRecentMessages: 0 };

test("a useful compaction reports ok and returns a plan", async () => {
  const outcome = await planCompaction(
    branch(),
    jev({ t1: [0.9, 0.9], t2: [0.1, 0.1], t3: [0.9, 0.1] }),
    settings,
  );
  assert.equal(outcome.status, "ok");
  assert.ok(outcome.plan);
  assert.equal(outcome.stats!.kept, 1);
  assert.equal(outcome.stats!.callsDropped, 1);
  assert.equal(outcome.stats!.resultsDropped, 1);
  assert.ok(outcome.stats!.reduction >= settings.minReductionRatio);
  assert.match(outcome.message, /smaller/);
});

test("a compaction that saves too little is refused without a plan", async () => {
  const outcome = await planCompaction(
    branch(),
    jev({ t1: [0.9, 0.9], t2: [0.9, 0.9], t3: [0.9, 0.8] }),
    settings,
  );
  assert.equal(outcome.status, "below_threshold");
  assert.equal(outcome.plan, undefined, "no plan means nothing can be written");
  assert.match(outcome.message, /Nothing written/);
});

test("a Jev failure produces an error outcome and no plan", async () => {
  const outcome = await planCompaction(branch(), failing("Jev request failed (503)"), settings);
  assert.equal(outcome.status, "error");
  assert.equal(outcome.plan, undefined);
  assert.match(outcome.message, /503/);
});

test("a malformed Jev answer is an error, not a silent keep", async () => {
  const bad: JevAsker = {
    async ask(_state, questions) {
      const answers: Record<string, any> = {};
      for (const name of Object.keys(questions)) answers[name] = { noul: "high" };
      return { model: "fake", answers };
    },
  };
  const outcome = await planCompaction(branch(), bad, settings);
  assert.equal(outcome.status, "error");
  assert.match(outcome.message, /invalid Jev answer/);
});

test("a short session is left alone", async () => {
  const outcome = await planCompaction([user("e1", "hi"), user("e2", "there")], jev({}), settings);
  assert.equal(outcome.status, "nothing_to_do");
  assert.equal(outcome.plan, undefined);
});

test("a window whose calls are all pinned asks nothing and writes nothing", async () => {
  const outcome = await planCompaction(branch(), jev({}), {
    ...DEFAULT_SETTINGS,
    preserveRecentMessages: 99,
  });
  assert.equal(outcome.status, "nothing_to_do");
  assert.match(outcome.message, /no unpinned tool calls/);
});

test("a state that cannot be fitted is an error outcome", async () => {
  const outcome = await planCompaction(branch(), jev({ t1: [1, 1], t2: [1, 1], t3: [1, 1] }), {
    ...settings,
    maxStateTokens: 20,
  });
  assert.equal(outcome.status, "error");
  assert.match(outcome.message, /too large for Jev/);
});

test("decision lines name the call, action, and both probabilities", () => {
  const lines = decisionLines([
    { id: "t1", tool: "read", action: "keep", reason: "kept", keepCall: 0.91, keepResult: 0.88 },
    { id: "t2", tool: "bash", action: "drop_call", reason: "call_dropped", keepCall: 0.08, keepResult: 0.04 },
    { id: "t3", tool: "read", action: "keep", reason: "pinned", keepCall: 1, keepResult: 1 },
  ]);
  assert.deepEqual(lines, [
    "t1 read keep call=0.91 result=0.88",
    "t2 bash drop_call call=0.08 result=0.04",
  ]);
});
