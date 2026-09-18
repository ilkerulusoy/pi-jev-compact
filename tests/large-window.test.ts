import assert from "node:assert/strict";
import { test } from "node:test";
import { collectLiveWindow } from "../src/core/live-window";
import { collectToolCalls } from "../src/core/tool-calls";
import { StateTooLargeError, fitState } from "../src/core/state";
import { planCompaction } from "../src/commands/jev-compact";
import { validatePlan } from "../src/core/replay";
import { DEFAULT_SETTINGS } from "../src/types";
import type { JevAsker } from "../src/types";

/**
 * Sessions with thousands of tool calls, which is where the state budget runs
 * out. Reproduces the reported failure at ~61k tokens and covers the slicing
 * path that answers it.
 */

const callHeavyBranch = (n: number, resultChars = 500) => {
  const entries: any[] = [
    { id: "e0", type: "message", message: { role: "user", content: [{ type: "text", text: "run the suite" }] } },
  ];
  for (let i = 1; i <= n; i++) {
    entries.push({
      id: `a${i}`,
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: `tc_${i}`, name: "bash", arguments: { command: `npm test -- case ${i}` } }],
      },
    });
    entries.push({
      id: `r${i}`,
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: `tc_${i}`,
        toolName: "bash",
        content: [{ type: "text", text: "y".repeat(resultChars) }],
        isError: false,
      },
    });
  }
  return entries;
};

/** Answers every call the same way, whatever its short id. */
const uniformJev = (keepCall: number, keepResult: number): JevAsker => ({
  async ask(_state, questions) {
    const answers: Record<string, { noul: number }> = {};
    for (const name of Object.keys(questions)) {
      answers[name] = { noul: name.startsWith("call_") ? keepCall : keepResult };
    }
    return { model: "fake", answers };
  },
});

const fit = (entries: any[], maxStateTokens = DEFAULT_SETTINGS.maxStateTokens) => {
  const window = collectLiveWindow(entries);
  const calls = collectToolCalls(window.messages, DEFAULT_SETTINGS.preserveRecentMessages);
  return fitState(window.messages, calls, {
    maxStateTokens,
    preserveRecentMessages: DEFAULT_SETTINGS.preserveRecentMessages,
    goal: "run the suite",
  });
};

test("merging call runs is what makes a 900-call window fit", () => {
  const fitted = fit(callHeavyBranch(900));
  assert.equal(fitted.stage, "old calls merged");
  assert.ok(fitted.tokens <= DEFAULT_SETTINGS.maxStateTokens, `tokens ${fitted.tokens}`);
});

test("a 3000-call window still overflows, and says so with numbers", () => {
  // This is the reported failure: ~61k tokens against a 25k limit.
  try {
    fit(callHeavyBranch(3000));
    assert.fail("expected the state to overflow");
  } catch (error) {
    assert.ok(error instanceof StateTooLargeError);
    assert.equal(error.limit, DEFAULT_SETTINGS.maxStateTokens);
    assert.ok(error.tokens > 50_000, `tokens ${error.tokens}`);
  }
});

test("an overflowing window is scored in slices instead of failing", async () => {
  const outcome = await planCompaction(callHeavyBranch(3000), uniformJev(0.1, 0.1), DEFAULT_SETTINGS);

  assert.equal(outcome.status, "ok", outcome.message);
  assert.ok(outcome.plan);
  assert.ok(outcome.stats!.scopedTo, "the outcome records that it worked on a slice");
  assert.ok(
    outcome.stats!.scopedTo! < outcome.stats!.totalMessages!,
    `slice ${outcome.stats!.scopedTo} of ${outcome.stats!.totalMessages}`,
  );
  assert.ok(outcome.stats!.calls < outcome.stats!.totalCalls!, "fewer calls scored than exist");
  assert.match(outcome.message, /run again for the rest/);
  assert.deepEqual(validatePlan(outcome.plan!), [], "a sliced plan is still consistent");
});

test("slicing leaves the newer calls untouched", async () => {
  const branch = callHeavyBranch(3000);
  const outcome = await planCompaction(branch, uniformJev(0.1, 0.1), DEFAULT_SETTINGS);
  assert.equal(outcome.status, "ok");

  const survivingCallIds = new Set(
    outcome
      .plan!.filter((m: any) => m.role === "assistant" && Array.isArray(m.content))
      .flatMap((m: any) => m.content.filter((c: any) => c.type === "toolCall").map((c: any) => c.id)),
  );
  // The newest call is outside the slice and must still be present.
  assert.ok(survivingCallIds.has("tc_3000"), "the newest call was not scored, so it stays");
  // Something from the oldest region was dropped, or the run achieved nothing.
  assert.ok(!survivingCallIds.has("tc_2"), "an old call was dropped");
});

test("running again after a sliced pass makes further progress", async () => {
  const jev = uniformJev(0.1, 0.1);
  const first = await planCompaction(callHeavyBranch(3000), jev, DEFAULT_SETTINGS);
  assert.equal(first.status, "ok");

  // Feed the result back in as the new branch, the way a second /jev-compact would.
  const secondBranch = first.plan!.map((message: any, i: number) => ({
    id: `p${i}`,
    type: "message",
    message,
  }));
  const second = await planCompaction(secondBranch, jev, DEFAULT_SETTINGS);

  assert.ok(["ok", "below_threshold", "nothing_to_do"].includes(second.status), second.status);
  if (second.status === "ok") {
    assert.ok(second.stats!.charsAfter < first.stats!.charsAfter, "the second pass shrinks further");
    assert.deepEqual(validatePlan(second.plan!), []);
  }
});

test("a window that cannot be sliced down reports an error rather than writing", async () => {
  // One enormous pinned message: nothing to slice away, nothing to score.
  const entries = [
    { id: "e0", type: "message", message: { role: "user", content: [{ type: "text", text: "goal" }] } },
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "word ".repeat(5000) }] },
    })),
  ];
  const outcome = await planCompaction(entries, uniformJev(0.1, 0.1), DEFAULT_SETTINGS);
  assert.equal(outcome.status, "nothing_to_do");
  assert.equal(outcome.plan, undefined);
});
