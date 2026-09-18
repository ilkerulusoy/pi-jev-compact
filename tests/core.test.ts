import assert from "node:assert/strict";
import { test } from "node:test";
import { collectLiveWindow, goalFrom } from "../src/core/live-window";
import { collectToolCalls, isPinned } from "../src/core/tool-calls";
import { batchCalls, decideCall, noulOf, questionsFor, scoreCalls } from "../src/core/decide";
import { fitState } from "../src/core/state";
import { planReplay, reductionRatio, validatePlan } from "../src/core/replay";
import { parseResponse } from "../src/core/jev";
import { DEFAULT_SETTINGS } from "../src/types";
import type { CallAnswer, JevAsker, LiveMessage, ToolCall } from "../src/types";

const user = (id: string, text: string) => ({
  id,
  type: "message",
  message: { role: "user", content: [{ type: "text", text }] },
});

const assistant = (id: string, text: string, calls: { id: string; name: string; args?: any }[] = []) => ({
  id,
  type: "message",
  message: {
    role: "assistant",
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args ?? {} })),
    ],
  },
});

const toolResult = (id: string, callId: string, name: string, text: string, isError = false) => ({
  id,
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: callId,
    toolName: name,
    content: [{ type: "text", text }],
    isError,
  },
});

/** A Jev that answers from a fixed table; never touches the network. */
const fakeJev = (table: Record<string, CallAnswer>, spy?: { requests: number }): JevAsker => ({
  async ask(_state, questions) {
    if (spy) spy.requests++;
    const answers: Record<string, { noul: number }> = {};
    for (const name of Object.keys(questions)) {
      const [kind, short] = name.split("_");
      const entry = table[short!];
      if (!entry) throw new Error(`fake Jev has no answer for ${name}`);
      answers[name] = { noul: kind === "call" ? entry.keepCall : entry.keepResult };
    }
    return { model: "fake", answers, usage: { input_tokens: 0, output_tokens: 0 } };
  },
});

// ── live window ────────────────────────────────────────────────────────────

test("live window is the whole branch when there is no compaction", () => {
  const entries = [user("e1", "goal"), assistant("e2", "ok"), user("e3", "next")];
  const window = collectLiveWindow(entries);
  assert.deepEqual(window.messages.map((m) => m.entryId), ["e1", "e2", "e3"]);
  assert.equal(window.orphanRecovery, false);
  assert.equal(window.priorCompaction, undefined);
});

test("live window starts at firstKeptEntryId and reports the prior compaction", () => {
  const entries = [
    user("e1", "old"),
    { id: "e2", type: "compaction", summary: "PRIOR", firstKeptEntryId: "e3", tokensBefore: 99 },
    user("e3", "kept"),
    assistant("e4", "after"),
  ];
  const window = collectLiveWindow(entries);
  assert.deepEqual(window.messages.map((m) => m.entryId), ["e3", "e4"]);
  assert.equal(window.priorCompaction?.summary, "PRIOR");
  assert.equal(window.priorCompaction?.tokensBefore, 99);
  assert.equal(window.orphanRecovery, false);
});

test("orphan recovery triggers when firstKeptEntryId cannot be resolved", () => {
  for (const keptId of ["", "gone"]) {
    const entries = [
      user("e1", "old"),
      { id: "e2", type: "compaction", summary: "P", firstKeptEntryId: keptId, tokensBefore: 1 },
      user("e3", "after"),
    ];
    const window = collectLiveWindow(entries);
    assert.equal(window.orphanRecovery, true, `keptId=${JSON.stringify(keptId)}`);
    assert.deepEqual(window.messages.map((m) => m.entryId), ["e3"]);
  }
});

test("live window keeps custom_message and branch_summary, drops non-context entries", () => {
  const entries = [
    user("e1", "goal"),
    { id: "e2", type: "custom_message", customType: "x", content: "note", display: true },
    { id: "e3", type: "branch_summary", summary: "B", fromId: "z" },
    { id: "e4", type: "model_change", provider: "p", modelId: "m" },
    { id: "e5", type: "label", targetId: "e1", label: "L" },
  ];
  const window = collectLiveWindow(entries);
  assert.deepEqual(window.messages.map((m) => m.message.role), [
    "user",
    "custom",
    "branchSummary",
  ]);
});

test("goal uses the last user prompts only", () => {
  const window = collectLiveWindow([
    user("e1", "first"),
    assistant("e2", "noise"),
    user("e3", "second"),
    user("e4", "third"),
  ]);
  assert.equal(goalFrom(window.messages, 2), "second\nthird");
});

// ── pairing and pinning ────────────────────────────────────────────────────

test("pinning covers the first message and the newest N", () => {
  assert.equal(isPinned(0, 10, 3), true);
  assert.equal(isPinned(6, 10, 3), false);
  assert.equal(isPinned(7, 10, 3), true);
  assert.equal(isPinned(9, 10, 3), true);
});

test("calls pair with results by tool call id, and unmatched calls are skipped", () => {
  const window = collectLiveWindow([
    user("e1", "goal"),
    assistant("e2", "reading", [{ id: "tc_1", name: "read", args: { path: "a.ts" } }]),
    toolResult("e3", "tc_1", "read", "body"),
    assistant("e4", "no result yet", [{ id: "tc_2", name: "bash" }]),
    user("e5", "more"),
    assistant("e6", "again", [{ id: "tc_3", name: "read" }]),
    toolResult("e7", "tc_3", "read", "second"),
  ]);
  const calls = collectToolCalls(window.messages, 0);
  assert.deepEqual(calls.map((c) => c.toolCallId), ["tc_1", "tc_3"]);
  assert.deepEqual(calls.map((c) => c.id), ["t1", "t2"]);
  assert.equal(calls[0]!.resultChars, "body".length);
  assert.equal(calls[0]!.tool, "read");
});

test("a call is pinned when either its call or its result sits in a pinned message", () => {
  const window = collectLiveWindow([
    user("e1", "goal"),
    assistant("e2", "x", [{ id: "tc_1", name: "read" }]),
    toolResult("e3", "tc_1", "read", "r1"),
    assistant("e4", "y", [{ id: "tc_2", name: "read" }]),
    toolResult("e5", "tc_2", "read", "r2"),
  ]);
  const calls = collectToolCalls(window.messages, 2);
  assert.equal(calls.find((c) => c.toolCallId === "tc_1")!.pinned, false);
  assert.equal(calls.find((c) => c.toolCallId === "tc_2")!.pinned, true);
});

test("an error result is reported as an error", () => {
  const window = collectLiveWindow([
    user("e1", "goal"),
    assistant("e2", "x", [{ id: "tc_1", name: "bash" }]),
    toolResult("e3", "tc_1", "bash", "boom", true),
  ]);
  assert.equal(collectToolCalls(window.messages, 0)[0]!.isError, true);
});

// ── state fitting ──────────────────────────────────────────────────────────

test("state omits tool output, keeps a note, and reports the full stage", () => {
  const window = collectLiveWindow([
    user("e1", "fix the test"),
    assistant("e2", "reading", [{ id: "tc_1", name: "read", args: { path: "a.ts" } }]),
    toolResult("e3", "tc_1", "read", "X".repeat(4213)),
  ]);
  const calls = collectToolCalls(window.messages, 0);
  const fitted = fitState(window.messages, calls, {
    maxStateTokens: 25_000,
    preserveRecentMessages: 0,
    goal: "fix the test",
  });
  assert.equal(fitted.stage, "full");
  const json = JSON.stringify(fitted.state);
  assert.ok(json.includes("ok, 4213 chars (omitted)"));
  assert.ok(!json.includes("X".repeat(50)), "tool output must not be sent");
  // A toolResult contributes no history entry of its own.
  assert.deepEqual(fitted.state.history.map((h) => h.role), ["user", "assistant"]);
});

test("state shrinks through stages and throws when it cannot fit", () => {
  const entries: any[] = [user("e0", "goal")];
  for (let i = 1; i <= 40; i++) {
    entries.push(assistant(`a${i}`, "Z".repeat(2000), [
      { id: `tc_${i}`, name: "read", args: { path: "p".repeat(900) } },
    ]));
    entries.push(toolResult(`r${i}`, `tc_${i}`, "read", "out"));
  }
  const window = collectLiveWindow(entries);
  const calls = collectToolCalls(window.messages, 0);
  const opts = { preserveRecentMessages: 2, goal: "goal" };

  const shrunk = fitState(window.messages, calls, { ...opts, maxStateTokens: 3_000 });
  assert.notEqual(shrunk.stage, "full");
  assert.ok(shrunk.tokens <= 3_000, `tokens ${shrunk.tokens}`);

  assert.throws(
    () => fitState(window.messages, calls, { ...opts, maxStateTokens: 50 }),
    /too large for Jev/,
  );
});

// ── questions, batching, decisions ─────────────────────────────────────────

test("each call gets exactly two noul questions", () => {
  const call = { id: "t1", tool: "read", resultChars: 10 } as ToolCall;
  const questions = questionsFor(call);
  assert.deepEqual(Object.keys(questions), ["call_t1", "result_t1"]);
  assert.equal(questions.call_t1!.type, "noul");
  assert.equal(questions.result_t1!.type, "noul");
});

test("batching respects the request budget and refuses an impossible one", () => {
  const calls = Array.from({ length: 12 }, (_, i) => ({
    id: `t${i + 1}`,
    tool: "read",
    resultChars: 100,
  })) as ToolCall[];
  assert.equal(batchCalls(calls, 100, 30_000).length, 1);
  assert.ok(batchCalls(calls, 100, 400).length > 1);
  assert.throws(() => batchCalls(calls, 999, 1_000), /no room for questions/);
});

test("thresholds map to the three actions, and pinned always wins", () => {
  const t = DEFAULT_SETTINGS.keepThreshold;
  const call = { id: "t1", tool: "read", pinned: false } as ToolCall;
  assert.equal(decideCall(call, { keepCall: 0.9, keepResult: 0.9 }, t).action, "keep");
  assert.equal(decideCall(call, { keepCall: 0.9, keepResult: 0.2 }, t).action, "drop_result");
  assert.equal(decideCall(call, { keepCall: 0.1, keepResult: 0.1 }, t).action, "drop_call");
  // Exactly at the threshold counts as keep.
  assert.equal(decideCall(call, { keepCall: 0, keepResult: t }, t).action, "keep");
  const pinnedDecision = decideCall({ ...call, pinned: true }, { keepCall: 0, keepResult: 0 }, t);
  assert.equal(pinnedDecision.action, "keep");
  assert.equal(pinnedDecision.reason, "pinned");
});

test("noulOf rejects out-of-range, missing, and non-numeric answers", () => {
  assert.equal(noulOf({ a: { noul: 0.5 } }, "a"), 0.5);
  for (const bad of [{ a: { noul: 1.5 } }, { a: { noul: -0.1 } }, { a: {} }, {}]) {
    assert.throws(() => noulOf(bad as any, "a"), /invalid Jev answer/);
  }
});

test("pinned calls are decided without asking Jev", async () => {
  const window = collectLiveWindow([
    user("e1", "goal"),
    assistant("e2", "x", [{ id: "tc_1", name: "read" }]),
    toolResult("e3", "tc_1", "read", "r"),
  ]);
  const calls = collectToolCalls(window.messages, 6); // everything pinned
  const spy = { requests: 0 };
  const result = await scoreCalls(calls, { context: "", goal: "", history: [] }, 10, fakeJev({}, spy), DEFAULT_SETTINGS);
  assert.equal(spy.requests, 0);
  assert.ok(result.decisions.every((d) => d.reason === "pinned"));
});

// ── replay planning ────────────────────────────────────────────────────────

const threeCallWindow = (): { messages: LiveMessage[]; calls: ToolCall[] } => {
  const window = collectLiveWindow([
    user("e1", "goal"),
    assistant("e2", "first", [{ id: "tc_1", name: "read" }]),
    toolResult("e3", "tc_1", "read", "A".repeat(2000)),
    assistant("e4", "second", [{ id: "tc_2", name: "read" }]),
    toolResult("e5", "tc_2", "read", "B".repeat(2000)),
    assistant("e6", "third", [{ id: "tc_3", name: "read" }]),
    toolResult("e7", "tc_3", "read", "C".repeat(2000)),
    user("e8", "next"),
  ]);
  return { messages: window.messages, calls: collectToolCalls(window.messages, 0) };
};

test("selective removal drops a middle call while keeping an older one", async () => {
  const { messages, calls } = threeCallWindow();
  const { decisions } = await scoreCalls(
    calls,
    { context: "", goal: "", history: [] },
    10,
    fakeJev({
      t1: { keepCall: 0.9, keepResult: 0.9 }, // keep
      t2: { keepCall: 0.1, keepResult: 0.1 }, // drop_call
      t3: { keepCall: 0.9, keepResult: 0.1 }, // drop_result
    }),
    DEFAULT_SETTINGS,
  );
  assert.deepEqual(decisions.map((d) => d.action), ["keep", "drop_call", "drop_result"]);

  const plan = planReplay(messages, calls, decisions, DEFAULT_SETTINGS);
  assert.deepEqual(validatePlan(plan.messages), []);

  const callIds = plan.messages
    .filter((m) => m.role === "assistant")
    .flatMap((m: any) => m.content.filter((c: any) => c.type === "toolCall").map((c: any) => c.id));
  assert.deepEqual(callIds, ["tc_1", "tc_3"], "the middle call is gone, the older one stays");

  const resultIds = plan.messages.filter((m) => m.role === "toolResult").map((m: any) => m.toolCallId);
  assert.deepEqual(resultIds, ["tc_1", "tc_3"], "no result survives without its call");

  const kept = plan.messages.find((m: any) => m.toolCallId === "tc_1");
  assert.equal(kept.content[0].text.length, 2000, "a kept result is untouched");

  const truncated = plan.messages.find((m: any) => m.toolCallId === "tc_3");
  assert.ok(truncated.content[0].text.startsWith("C".repeat(DEFAULT_SETTINGS.truncateHeadChars)));
  assert.ok(truncated.content[0].text.includes("re-run the tool if needed"));
  assert.ok(plan.charsAfter < plan.charsBefore);
  assert.ok(reductionRatio(plan) > 0);
});

test("an assistant message whose only content was a dropped call is left out", async () => {
  const window = collectLiveWindow([
    user("e1", "goal"),
    assistant("e2", "", [{ id: "tc_1", name: "read" }]),
    toolResult("e3", "tc_1", "read", "out"),
    user("e4", "next"),
  ]);
  const calls = collectToolCalls(window.messages, 0);
  const { decisions } = await scoreCalls(
    calls,
    { context: "", goal: "", history: [] },
    10,
    fakeJev({ t1: { keepCall: 0.1, keepResult: 0.1 } }),
    DEFAULT_SETTINGS,
  );
  const plan = planReplay(window.messages, calls, decisions, DEFAULT_SETTINGS);
  assert.deepEqual(plan.messages.map((m) => m.role), ["user", "user"]);
  assert.deepEqual(validatePlan(plan.messages), []);
});

test("assistant text is preserved when a sibling call is dropped", async () => {
  const window = collectLiveWindow([
    user("e1", "goal"),
    assistant("e2", "keep this sentence", [
      { id: "tc_1", name: "read" },
      { id: "tc_2", name: "read" },
    ]),
    toolResult("e3", "tc_1", "read", "a"),
    toolResult("e4", "tc_2", "read", "b"),
    user("e5", "next"),
  ]);
  const calls = collectToolCalls(window.messages, 0);
  const { decisions } = await scoreCalls(
    calls,
    { context: "", goal: "", history: [] },
    10,
    fakeJev({
      t1: { keepCall: 0.1, keepResult: 0.1 },
      t2: { keepCall: 0.9, keepResult: 0.9 },
    }),
    DEFAULT_SETTINGS,
  );
  const plan = planReplay(window.messages, calls, decisions, DEFAULT_SETTINGS);
  const asst: any = plan.messages.find((m) => m.role === "assistant");
  assert.equal(asst.content.find((c: any) => c.type === "text").text, "keep this sentence");
  assert.deepEqual(asst.content.filter((c: any) => c.type === "toolCall").map((c: any) => c.id), ["tc_2"]);
  assert.deepEqual(validatePlan(plan.messages), []);
});

test("user and assistant text is never removed", async () => {
  const { messages, calls } = threeCallWindow();
  const { decisions } = await scoreCalls(
    calls,
    { context: "", goal: "", history: [] },
    10,
    fakeJev({
      t1: { keepCall: 0, keepResult: 0 },
      t2: { keepCall: 0, keepResult: 0 },
      t3: { keepCall: 0, keepResult: 0 },
    }),
    DEFAULT_SETTINGS,
  );
  const plan = planReplay(messages, calls, decisions, DEFAULT_SETTINGS);
  const texts = plan.messages.flatMap((m: any) =>
    Array.isArray(m.content)
      ? m.content.filter((c: any) => c.type === "text").map((c: any) => c.text)
      : [],
  );
  assert.deepEqual(texts, ["goal", "first", "second", "third", "next"]);
});

// ── the safety net ─────────────────────────────────────────────────────────

test("validatePlan catches a result without its call", () => {
  const problems = validatePlan([
    { role: "user", content: [{ type: "text", text: "x" }] },
    { role: "toolResult", toolCallId: "tc_missing", content: [] },
  ]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.kind, "result_without_call");
});

test("validatePlan refuses compactionSummary and branchSummary roles", () => {
  // appendMessage accepts these despite its doc comment, so this guard is ours.
  const problems = validatePlan([
    { role: "compactionSummary", summary: "s" },
    { role: "branchSummary", summary: "b" },
  ]);
  assert.deepEqual(problems.map((p) => p.kind), ["refused_role", "refused_role"]);
});

test("validatePlan accepts a call and result in order", () => {
  assert.deepEqual(
    validatePlan([
      { role: "assistant", content: [{ type: "toolCall", id: "tc_1", name: "read", arguments: {} }] },
      { role: "toolResult", toolCallId: "tc_1", content: [] },
    ]),
    [],
  );
});

// ── response validation ────────────────────────────────────────────────────

test("parseResponse requires a finite probability for every asked question", () => {
  const questions = questionsFor({ id: "t1", tool: "read", resultChars: 1 } as ToolCall);
  const good = JSON.stringify({ model: "m", answers: { call_t1: { noul: 0.4 }, result_t1: { noul: 0.6 } } });
  assert.equal(parseResponse(200, true, good, questions).answers.call_t1!.noul, 0.4);

  assert.throws(() => parseResponse(500, false, "server text", questions), /failed \(500\)/);
  assert.throws(() => parseResponse(200, true, "not json", questions), /malformed JSON/);
  assert.throws(() => parseResponse(200, true, JSON.stringify({ x: 1 }), questions), /missing answers/);
  // A missing second answer must not pass.
  assert.throws(
    () => parseResponse(200, true, JSON.stringify({ answers: { call_t1: { noul: 0.4 } } }), questions),
    /unexpected answer shape/,
  );
});

test("an error message never contains the response body", () => {
  const questions = questionsFor({ id: "t1", tool: "read", resultChars: 1 } as ToolCall);
  try {
    parseResponse(400, false, "SECRET-TRANSCRIPT-CONTENT", questions);
    assert.fail("should have thrown");
  } catch (error) {
    assert.ok(!String((error as Error).message).includes("SECRET"));
  }
});
