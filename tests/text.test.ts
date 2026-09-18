import assert from "node:assert/strict";
import { test } from "node:test";
import { collectLiveWindow } from "../src/core/live-window";
import { collectTextBlocks, collectToolCalls, messageChars } from "../src/core/tool-calls";
import { decideText, scoreTextBlocks, textQuestionFor } from "../src/core/decide";
import { planCompaction } from "../src/commands/jev-compact";
import { validatePlan } from "../src/core/replay";
import { DEFAULT_SETTINGS } from "../src/types";
import type { JevAsker, TextBlock } from "../src/types";

/**
 * Assistant prose is the largest part of a long session, so it is a candidate
 * too. It is opt-in and held to a stricter threshold, because a dropped tool
 * result can be recovered by running the tool again and dropped reasoning
 * cannot be recovered at all.
 */

const u = (id: string, text: string) => ({
  id,
  type: "message",
  message: { role: "user", content: [{ type: "text", text }] },
});
const a = (id: string, text: string, callId?: string) => ({
  id,
  type: "message",
  message: {
    role: "assistant",
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...(callId ? [{ type: "toolCall", id: callId, name: "read", arguments: { path: "a.ts" } }] : []),
    ],
  },
});
const r = (id: string, callId: string, chars: number) => ({
  id,
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: callId,
    toolName: "read",
    content: [{ type: "text", text: "x".repeat(chars) }],
    isError: false,
  },
});

const longText = (label: string) => `${label}: ` + "some reasoning here ".repeat(40);

/** A window with prose and tool calls, long enough that nothing is pinned. */
const proseBranch = () => {
  const entries: any[] = [u("e0", "build the feature")];
  for (let i = 1; i <= 40; i++) {
    entries.push(u(`u${i}`, "next step"), a(`a${i}`, longText(`step ${i}`), `tc_${i}`), r(`r${i}`, `tc_${i}`, 1200));
  }
  return entries;
};

/** Answers text questions from a table, and everything else with keep. */
const textJev = (textScores: Record<string, number>, callScore = 0.9): JevAsker => ({
  async ask(_state, questions) {
    const answers: Record<string, { noul: number }> = {};
    for (const name of Object.keys(questions)) {
      if (name.startsWith("text_")) {
        const id = name.slice(5);
        answers[name] = { noul: textScores[id] ?? 0.9 };
      } else {
        answers[name] = { noul: callScore };
      }
    }
    return { model: "jev-1.13.0", answers, usage: { input_tokens: 100, output_tokens: 20 } };
  },
});

const uniform = (noul: number): JevAsker => ({
  async ask(_state, questions) {
    const answers: Record<string, { noul: number }> = {};
    for (const name of Object.keys(questions)) answers[name] = { noul };
    return { model: "jev-1.13.0", answers, usage: { input_tokens: 100, output_tokens: 20 } };
  },
});

// ── candidate selection ────────────────────────────────────────────────────

test("only assistant prose is a candidate, and only when long enough", () => {
  const window = collectLiveWindow([
    u("e1", "a user message long enough to pass the threshold ".repeat(20)),
    a("a1", longText("long")),
    a("a2", "short"),
    r("r1", "tc_x", 5000),
  ]);
  const blocks = collectTextBlocks(window.messages, 0, DEFAULT_SETTINGS.textMinChars);
  assert.equal(blocks.length, 1, "user text and short prose are not candidates");
  assert.equal(blocks[0]!.messageIndex, 1);
  assert.equal(blocks[0]!.id, "x1");
});

test("prose in pinned messages is never a candidate", () => {
  const window = collectLiveWindow([
    a("a1", longText("first")),
    a("a2", longText("middle")),
    a("a3", longText("newest")),
  ]);
  const blocks = collectTextBlocks(window.messages, 1, DEFAULT_SETTINGS.textMinChars);
  const unpinned = blocks.filter((b) => !b.pinned);
  assert.deepEqual(unpinned.map((b) => b.messageIndex), [1], "first and newest are pinned");
});

// ── the question and the threshold ─────────────────────────────────────────

test("the prose question asks whether it is superseded, not merely interesting", () => {
  const block: TextBlock = { id: "x1", messageIndex: 3, chars: 900, pinned: false };
  const question = textQuestionFor(block).text_x1!;
  assert.match(question.instructions, /decision, a constraint, a finding/);
  assert.match(question.criteria!.false!, /restatement of a later message/);
  assert.match(question.criteria!.true!, /later messages rely on/);
});

test("prose uses its own stricter threshold", () => {
  const block: TextBlock = { id: "x1", messageIndex: 2, chars: 900, pinned: false };
  // 0.35 keeps prose at 0.3 but would have dropped a tool result at 0.5.
  assert.equal(decideText(block, 0.35, DEFAULT_SETTINGS.textKeepThreshold).action, "keep");
  assert.equal(decideText(block, 0.2, DEFAULT_SETTINGS.textKeepThreshold).action, "drop_text");
  assert.ok(
    DEFAULT_SETTINGS.textKeepThreshold < DEFAULT_SETTINGS.keepThreshold,
    "prose must be harder to remove than a tool result",
  );
});

test("a pinned block is kept whatever the score", () => {
  const block: TextBlock = { id: "x1", messageIndex: 0, chars: 900, pinned: true };
  const decision = decideText(block, 0, DEFAULT_SETTINGS.textKeepThreshold);
  assert.equal(decision.action, "keep");
  assert.equal(decision.reason, "pinned");
});

test("pinned blocks are not sent to Jev", async () => {
  const blocks: TextBlock[] = [{ id: "x1", messageIndex: 0, chars: 900, pinned: true }];
  let asked = 0;
  const spy: JevAsker = {
    async ask() {
      asked++;
      return { answers: {} };
    },
  };
  const result = await scoreTextBlocks(blocks, { context: "", goal: "", history: [] }, 10, spy, DEFAULT_SETTINGS);
  assert.equal(asked, 0);
  assert.equal(result.requests, 0);
  assert.equal(result.decisions[0]!.reason, "pinned");
});

// ── what removal does to the transcript ────────────────────────────────────

test("off by default: prose survives untouched", async () => {
  const outcome = await planCompaction(proseBranch(), uniform(0.1), DEFAULT_SETTINGS);
  assert.equal(outcome.status, "ok");
  assert.equal(outcome.stats!.textBlocks ?? 0, 0, "no prose question was asked");
  const proseChars = outcome
    .plan!.filter((m: any) => m.role === "assistant")
    .reduce((sum: number, m: any) => sum + messageChars(m), 0);
  assert.ok(proseChars > 0, "assistant prose is still there");
});

test("with text scoring, superseded prose is removed and the rest stays", async () => {
  // Drop x1 and x3, keep the others.
  const outcome = await planCompaction(proseBranch(), textJev({ x1: 0.05, x3: 0.05 }), {
    ...DEFAULT_SETTINGS,
    scoreAssistantText: true,
    minReductionRatio: 0, // this test is about the plan, not the worth-it gate
  });
  assert.equal(outcome.status, "ok", outcome.message);
  assert.equal(outcome.stats!.textDropped, 2);

  const texts = outcome
    .plan!.filter((m: any) => m.role === "assistant" && Array.isArray(m.content))
    .flatMap((m: any) => m.content.filter((c: any) => c.type === "text").map((c: any) => c.text));
  assert.ok(!texts.some((t) => t.startsWith("step 1:")), "the dropped block is gone");
  assert.ok(!texts.some((t) => t.startsWith("step 3:")), "the other dropped block is gone");
  assert.ok(texts.some((t) => t.startsWith("step 2:")), "a kept block survives");
  assert.deepEqual(validatePlan(outcome.plan!), []);
});

test("removing prose never removes the tool call beside it", async () => {
  const outcome = await planCompaction(proseBranch(), textJev({ x1: 0.05 }, 0.9), {
    ...DEFAULT_SETTINGS,
    scoreAssistantText: true,
    minReductionRatio: 0,
  });
  assert.equal(outcome.status, "ok");

  // tc_1's call was kept by the call scorer; only x1's text was dropped.
  const calls = outcome
    .plan!.filter((m: any) => m.role === "assistant" && Array.isArray(m.content))
    .flatMap((m: any) => m.content.filter((c: any) => c.type === "toolCall").map((c: any) => c.id));
  assert.ok(calls.includes("tc_1"), "the call survived its message losing its text");
  assert.deepEqual(validatePlan(outcome.plan!), [], "and its result still has a call");
});

test("user text is never removed, whatever Jev says", async () => {
  const outcome = await planCompaction(proseBranch(), uniform(0.01), {
    ...DEFAULT_SETTINGS,
    scoreAssistantText: true,
  });
  assert.equal(outcome.status, "ok");
  const userChars = outcome
    .plan!.filter((m: any) => m.role === "user")
    .reduce((sum: number, m: any) => sum + messageChars(m), 0);
  assert.ok(userChars > 0, "the record of what was asked is not a candidate");
});

test("a message reduced to nothing is left out entirely", async () => {
  const entries = [
    u("e0", "goal"),
    ...Array.from({ length: 12 }, (_, i) => a(`a${i}`, longText(`block ${i}`))),
    u("e1", "done"),
  ];
  const outcome = await planCompaction(entries, uniform(0.01), {
    ...DEFAULT_SETTINGS,
    scoreAssistantText: true,
    minReductionRatio: 0,
  });
  assert.equal(outcome.status, "ok", outcome.message);
  // Prose-only assistant messages that lose their text have no content left.
  assert.ok(
    outcome.plan!.every((m: any) => m.role !== "assistant" || (m.content?.length ?? 0) > 0),
    "no empty message is written",
  );
});

test("scoring prose costs extra requests and reports them", async () => {
  const without = await planCompaction(proseBranch(), uniform(0.1), DEFAULT_SETTINGS);
  const with_ = await planCompaction(proseBranch(), uniform(0.1), {
    ...DEFAULT_SETTINGS,
    scoreAssistantText: true,
  });
  assert.ok(
    with_.stats!.requests > without.stats!.requests,
    `${with_.stats!.requests} vs ${without.stats!.requests}`,
  );
  assert.ok(with_.stats!.questionsAsked > without.stats!.questionsAsked);
  assert.ok(with_.stats!.inputTokens > without.stats!.inputTokens, "token cost is reported too");
});

test("scoring prose removes materially more than tool calls alone", async () => {
  const measure = async (scoreAssistantText: boolean) => {
    const branch = proseBranch();
    const window = collectLiveWindow(branch);
    const before = window.messages.reduce((sum, m) => sum + messageChars(m.message), 0);
    const outcome = await planCompaction(branch, uniform(0.1), {
      ...DEFAULT_SETTINGS,
      scoreAssistantText,
    });
    const after = outcome.plan!.reduce((sum: number, m: any) => sum + messageChars(m), 0);
    return 1 - after / before;
  };
  const callsOnly = await measure(false);
  const withProse = await measure(true);
  assert.ok(withProse > callsOnly * 1.5, `${(callsOnly * 100).toFixed(1)}% vs ${(withProse * 100).toFixed(1)}%`);
});

test("a prose scoring failure fails the run rather than writing a partial result", async () => {
  const failing: JevAsker = {
    async ask(_state, questions) {
      if (Object.keys(questions).some((n) => n.startsWith("text_"))) {
        throw new Error("Jev request failed (503)");
      }
      const answers: Record<string, { noul: number }> = {};
      for (const name of Object.keys(questions)) answers[name] = { noul: 0.1 };
      return { answers };
    },
  };
  const outcome = await planCompaction(proseBranch(), failing, {
    ...DEFAULT_SETTINGS,
    scoreAssistantText: true,
  });
  assert.equal(outcome.status, "error");
  assert.match(outcome.message, /prose scoring failed/);
  assert.equal(outcome.plan, undefined, "nothing can be written");
});
