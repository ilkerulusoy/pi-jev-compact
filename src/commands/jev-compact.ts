import { collectLiveWindow, goalFrom } from "../core/live-window";
import { collectTextBlocks, collectToolCalls, messageChars } from "../core/tool-calls";
import { scoreCalls, scoreTextBlocks } from "../core/decide";
import { fitState, StateTooLargeError } from "../core/state";
import { planReplay, reductionRatio, validatePlan } from "../core/replay";
import { JevClient, SYSTEM_ONE_URL, resolveApiKey } from "../core/jev";
import { TracingAsker, stamp, writeOwnerOnly } from "../core/trace";
import { renderHtmlReport } from "../core/report";
import { DEFAULT_SETTINGS } from "../types";
import type { CallDecision, JevAsker, LiveMessage, Settings, TextDecision, ToolCall } from "../types";

export interface RunOutcome {
  status: "ok" | "nothing_to_do" | "below_threshold" | "unsafe" | "error";
  message: string;
  decisions?: CallDecision[];
  stats?: {
    calls: number;
    kept: number;
    resultsDropped: number;
    callsDropped: number;
    pinned: number;
    charsBefore: number;
    charsAfter: number;
    reduction: number;
    stateTokens: number;
    stateStage: string;
    requests: number;
    /** Model names the API reported. Empty means nothing was asked. */
    models: string[];
    inputTokens: number;
    outputTokens: number;
    questionsAsked: number;
    textBlocks?: number;
    textDropped?: number;
    elapsedMs: number;
    slowestRequestMs: number;
    /** Distribution of keepResult, to show what the scores looked like. */
    scoreBuckets: { low: number; mid: number; high: number };
    scopedTo?: number;
    totalCalls?: number;
    totalMessages?: number;
  };
  plan?: any[];
  /** The goal line that was sent as part of the state, for inspection. */
  goal?: string;
  /** Calls actually scored, parallel to `decisions`, for the report. */
  scoredCalls?: ToolCall[];
  /** The live window the decisions were made against. */
  window?: LiveMessage[];
  /** First part of the fitted history, so the report can show what Jev saw. */
  stateSample?: string;
  /** Prose decisions, empty unless scoreAssistantText is on. */
  textDecisions?: TextDecision[];
}

const count = (decisions: readonly CallDecision[], reason: CallDecision["reason"]): number =>
  decisions.filter((d) => d.reason === reason).length;

const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`;

/**
 * Score the live window and produce a replay plan. Never writes anything; the
 * caller decides what to do with the outcome. Every failure path returns an
 * outcome rather than throwing, so the command can report and stop.
 */
export async function planCompaction(
  branchEntries: readonly any[],
  asker: JevAsker,
  settings: Settings,
): Promise<RunOutcome> {
  const window = collectLiveWindow(branchEntries);
  if (window.messages.length <= 2) {
    return { status: "nothing_to_do", message: "pi-jev-compact: too few live messages to compact." };
  }

  const calls = collectToolCalls(window.messages, settings.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  // With prose scoring on, a window of pure conversation is still worth scoring,
  // so the absence of tool calls is not on its own a reason to stop.
  const textCandidates = settings.scoreAssistantText
    ? collectTextBlocks(window.messages, settings.preserveRecentMessages, settings.textMinChars).filter(
        (block) => !block.pinned,
      ).length
    : 0;
  if (candidates.length === 0 && textCandidates === 0) {
    return {
      status: "nothing_to_do",
      message: settings.scoreAssistantText
        ? `pi-jev-compact: nothing to score in ${window.messages.length} live messages.`
        : `pi-jev-compact: no unpinned tool calls in ${window.messages.length} live messages.`,
    };
  }

  // A window can be too large to describe to Jev even after every shrink stage,
  // which happens on sessions with thousands of tool calls. Rather than giving up,
  // score the oldest slice that does fit: the oldest calls are both the most
  // likely to be stale and the ones a later run would reach last. The newer calls
  // stay untouched this time, so the command can be run again.
  //
  // The slice boundary is a message index, so a call and its result always travel
  // together and pinning still applies to the original window.
  let fitted;
  let scoped = window.messages;
  let scopedCalls = calls;
  let slicedFrom: number | undefined;
  const goal = goalFrom(window.messages);

  for (;;) {
    try {
      fitted = fitState(scoped, scopedCalls, {
        maxStateTokens: settings.maxStateTokens,
        preserveRecentMessages: scoped === window.messages ? settings.preserveRecentMessages : 0,
        goal,
      });
      break;
    } catch (error) {
      if (!(error instanceof StateTooLargeError)) {
        return { status: "error", message: `pi-jev-compact: ${(error as Error).message}` };
      }
      // Halve the slice, keeping the oldest half, and stop if it cannot shrink.
      const nextLength = Math.floor(scoped.length / 2);
      if (nextLength < 4) {
        return {
          status: "error",
          message: `pi-jev-compact: ${error.message}. Even the oldest slice does not fit.`,
        };
      }
      slicedFrom = nextLength;
      scoped = window.messages.slice(0, nextLength);
      scopedCalls = collectToolCalls(scoped, 0).filter((call) =>
        calls.some((original) => original.toolCallId === call.toolCallId && !original.pinned),
      );
      if (scopedCalls.length === 0) {
        return {
          status: "error",
          message: `pi-jev-compact: ${error.message}. No unpinned calls survive slicing.`,
        };
      }
    }
  }

  // A readable slice of the history Jev received, for the report.
  const stateSample = JSON.stringify(fitted.state.history.slice(0, 12), null, 2).slice(0, 4000);

  let scored;
  try {
    scored = await scoreCalls(scopedCalls, fitted.state, fitted.tokens, asker, settings);
  } catch (error) {
    return { status: "error", message: `pi-jev-compact: ${(error as Error).message}` };
  }

  // Assistant prose, scored separately and only when asked for. Text indices are
  // relative to the scored window, which is what planReplay walks.
  let textDecisions: TextDecision[] = [];
  let textScoring = { requests: 0, inputTokens: 0, outputTokens: 0, questionsAsked: 0 };
  if (settings.scoreAssistantText) {
    const blocks = collectTextBlocks(
      scoped,
      scoped === window.messages ? settings.preserveRecentMessages : 0,
      settings.textMinChars,
    );
    if (blocks.some((block) => !block.pinned)) {
      try {
        const result = await scoreTextBlocks(blocks, fitted.state, fitted.tokens, asker, settings);
        textDecisions = result.decisions;
        textScoring = {
          requests: result.requests,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          questionsAsked: result.questionsAsked,
        };
      } catch (error) {
        // Prose scoring is additive. If it fails, keep the tool-call result rather
        // than losing the whole run, and say so.
        textDecisions = [];
        return {
          status: "error",
          message: `pi-jev-compact: tool calls were scored but prose scoring failed: ${(error as Error).message}`,
        };
      }
    }
  }

  // The plan must cover the WHOLE window: messages outside the scored slice are
  // carried over untouched, and dropping them here would lose them. Call
  // decisions address messages by tool call id, so they are slice-independent,
  // but text decisions carry indices into `scoped`, which shares its prefix with
  // the full window, so the indices line up.
  const plan = planReplay(window.messages, scopedCalls, scored.decisions, settings, textDecisions);
  const problems = validatePlan(plan.messages);
  if (problems.length > 0) {
    return {
      status: "unsafe",
      message: `pi-jev-compact: refusing to write, ${problems.length} consistency problem(s): ${problems
        .map((p) => p.kind)
        .join(", ")}.`,
      decisions: scored.decisions,
    };
  }

  const reduction = reductionRatio(plan);
  const scored_ = scored.decisions.filter((d) => d.reason !== "pinned");
  const scoreBuckets = {
    low: scored_.filter((d) => d.keepResult < 0.3).length,
    mid: scored_.filter((d) => d.keepResult >= 0.3 && d.keepResult < 0.7).length,
    high: scored_.filter((d) => d.keepResult >= 0.7).length,
  };
  const stats = {
    calls: scopedCalls.length,
    kept: count(scored.decisions, "kept"),
    resultsDropped: count(scored.decisions, "result_dropped"),
    callsDropped: count(scored.decisions, "call_dropped"),
    pinned: count(scored.decisions, "pinned"),
    charsBefore: plan.charsBefore,
    charsAfter: plan.charsAfter,
    reduction,
    stateTokens: fitted.tokens,
    stateStage: fitted.stage,
    requests: scored.requests + textScoring.requests,
    models: scored.models,
    inputTokens: scored.inputTokens + textScoring.inputTokens,
    outputTokens: scored.outputTokens + textScoring.outputTokens,
    questionsAsked: scored.questionsAsked + textScoring.questionsAsked,
    textBlocks: textDecisions.length,
    textDropped: textDecisions.filter((d) => d.action === "drop_text").length,
    elapsedMs: scored.elapsedMs,
    slowestRequestMs: scored.slowestRequestMs,
    scoreBuckets,
    ...(slicedFrom === undefined
      ? {}
      : { scopedTo: slicedFrom, totalCalls: calls.length, totalMessages: window.messages.length }),
  };
  const scopeNote =
    slicedFrom === undefined
      ? ""
      : ` (oldest ${slicedFrom}/${window.messages.length} messages only: the full window does not fit, run again for the rest)`;
  const summary = `${percent(reduction)} smaller; ${stats.kept} kept, ${stats.resultsDropped} results truncated, ${stats.callsDropped} calls dropped, ${stats.pinned} pinned; state ~${stats.stateTokens} tok (${stats.stateStage}) in ${stats.requests} request(s)${scopeNote}`;

  // The threshold asks whether the work was worth doing. On a sliced run the
  // saving is measured against the whole window, but only the slice was scored,
  // so compare against the part that could actually change.
  const scopedBefore =
    slicedFrom === undefined
      ? plan.charsBefore
      : scoped.reduce((sum, { message }) => sum + messageChars(message), 0);
  const effectiveReduction =
    scopedBefore === 0 ? 0 : (plan.charsBefore - plan.charsAfter) / scopedBefore;

  if (effectiveReduction < settings.minReductionRatio) {
    return {
      status: "below_threshold",
      message: `pi-jev-compact: not worth it, ${summary}. Nothing written.`,
      decisions: scored.decisions,
      stats,
      goal,
      scoredCalls: scopedCalls,
      window: scoped,
      stateSample,
      textDecisions,
    };
  }

  return {
    status: "ok",
    message: `pi-jev-compact: ${summary}.`,
    decisions: scored.decisions,
    stats,
    plan: plan.messages,
    goal,
    scoredCalls: scopedCalls,
    window: scoped,
    stateSample,
    textDecisions,
  };
}

export function decisionLines(decisions: readonly CallDecision[]): string[] {
  return decisions
    .filter((d) => d.reason !== "pinned")
    .map(
      (d) =>
        `${d.id} ${d.tool} ${d.action} call=${d.keepCall.toFixed(2)} result=${d.keepResult.toFixed(2)}`,
    );
}

/**
 * The evidence that a run actually happened and what it cost. Reports measured
 * values only: token counts and the model name come from the API response, and
 * an absent `usage` shows as 0 rather than an estimate.
 */
export function evidenceLines(outcome: RunOutcome, settings: Settings): string[] {
  const s = outcome.stats;
  if (!s) return ["pi-jev-compact: nothing was sent to Jev."];

  const lines: string[] = [];
  if (s.requests === 0) {
    lines.push("jev: no request sent (every call was pinned or the window was too small)");
  } else {
    const model = s.models.length ? s.models.join(", ") : "(not reported)";
    lines.push(
      `jev: ${s.requests} request(s), ${s.questionsAsked} questions, model ${model}`,
    );
    lines.push(
      `tokens: ${s.inputTokens} in, ${s.outputTokens} out${
        s.inputTokens === 0 ? " (usage not reported by the API)" : ""
      }`,
    );
    lines.push(
      `time: ${s.elapsedMs} ms total, slowest request ${s.slowestRequestMs} ms (batches run concurrently)`,
    );
    lines.push(
      `state sent: ~${s.stateTokens} estimated tokens at stage '${s.stateStage}', tool output replaced by notes`,
    );
    lines.push(
      `keepResult spread: ${s.scoreBuckets.low} below 0.30, ${s.scoreBuckets.mid} between, ${s.scoreBuckets.high} at or above 0.70 (threshold ${settings.keepThreshold})`,
    );
  }
  lines.push(
    `chars: ${s.charsBefore} before, ${s.charsAfter} after, ${percent(s.reduction)} smaller`,
  );
  if (s.scopedTo !== undefined) {
    lines.push(
      `scope: oldest ${s.scopedTo} of ${s.totalMessages} messages, ${s.calls} of ${s.totalCalls} calls scored`,
    );
  }
  if (s.requests > 0 && s.scoreBuckets.high === 0 && s.scoreBuckets.low > 0) {
    lines.push(
      "note: no result scored at or above 0.70, so Jev judged none of them worth keeping verbatim. Check the goal line above if that looks wrong.",
    );
  }
  return lines;
}

export function registerJevCompactCommand(pi: any): void {
  pi.registerCommand("jev-compact", {
    description:
      "Compact this session with Jev. Args: 'report' to inspect without writing, 'text' to also score assistant prose",
    handler: async (args: string, ctx: any) => {
      const words = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const report = words.includes("report");
      // Opt-in per run: removing prose cannot be undone by re-running a tool.
      const withText = words.includes("text");
      const settings: Settings = { ...DEFAULT_SETTINGS, scoreAssistantText: withText };

      const apiKey = resolveApiKey();
      if (!apiKey) {
        ctx.ui.notify(
          "pi-jev-compact: TYPESAFE_API_KEY is not set. Nothing was sent or written.",
          "warning",
        );
        return;
      }

      const branchEntries = ctx.sessionManager.buildContextEntries();
      // Record every request and response so the run can be inspected afterwards.
      const tracer = new TracingAsker(
        new JevClient({ apiKey, model: settings.model }),
        SYSTEM_ONE_URL,
      );

      let outcome: RunOutcome;
      try {
        outcome = await planCompaction(branchEntries, tracer, settings);
      } catch (error) {
        outcome = { status: "error", message: `pi-jev-compact: ${(error as Error).message}` };
      }

      // Pi's ExtensionUIContext has no log method, so the evidence goes to a file
      // and the path is shown. A failed run still gets a report: that is when the
      // request and response bodies matter most.
      const html = renderHtmlReport({
        decisions: outcome.decisions ?? [],
        calls: outcome.scoredCalls ?? [],
        messages: outcome.window ?? [],
        trace: tracer.entries,
        goal: outcome.goal ?? "",
        settings,
        stats: (outcome.stats ?? {}) as Record<string, unknown>,
        stateSample: outcome.stateSample ?? "(no state was built)",
        written: false,
      });
      let reportPath: string | undefined;
      try {
        reportPath = writeOwnerOnly(`report-${stamp()}.html`, html);
      } catch {
        reportPath = undefined;
      }

      const where = reportPath ? `\nReport: ${reportPath}` : "";
      const sent = `${tracer.entries.length} request(s) sent`;

      if (outcome.status !== "ok") {
        ctx.ui.notify(
          `${outcome.message} ${sent}.${where}`,
          outcome.status === "error" || outcome.status === "unsafe" ? "error" : "info",
        );
        return;
      }

      if (report) {
        ctx.ui.notify(`${outcome.message} ${sent}. Nothing written.${where}`, "info");
        return;
      }

      const plan = outcome.plan!;
      const confirmed = await ctx.ui.confirm(
        "Write a compacted copy of this session?",
        `${outcome.message}\n\nA new session file is created with ${plan.length} messages. The current session file is not modified. Dropped tool results are gone from the new session; the assistant can re-run those tools.${where}`,
      );
      if (!confirmed) {
        ctx.ui.notify(`pi-jev-compact: cancelled, nothing written.${where}`, "info");
        return;
      }

      const written = `pi-jev-compact: wrote a compacted session with ${plan.length} messages. ${outcome.message} ${sent}.${where}`;

      // Everything after the session is replaced must use the ctx handed to
      // withSession. The captured command ctx is stale from newSession onward,
      // and touching it raises "stale after session replacement or reload".
      const { cancelled } = await ctx.newSession({
        setup: async (sessionManager: any) => {
          for (const message of plan) sessionManager.appendMessage(message);
        },
        withSession: async (fresh: any) => {
          if (reportPath) {
            // Rewrite the report now that the write is known to have happened.
            try {
              writeOwnerOnly(
                reportPath.split("/").pop()!,
                renderHtmlReport({
                  decisions: outcome.decisions ?? [],
                  calls: outcome.scoredCalls ?? [],
                  messages: outcome.window ?? [],
                  trace: tracer.entries,
                  goal: outcome.goal ?? "",
                  settings,
                  stats: (outcome.stats ?? {}) as Record<string, unknown>,
                  stateSample: outcome.stateSample ?? "",
                  written: true,
                  textDecisions: outcome.textDecisions ?? [],
                }),
              );
            } catch {
              // The report is a convenience; a failure must not affect the session.
            }
          }
          fresh.ui.notify(written, "info");
        },
      });

      // Only the cancelled branch is safe to report on the original ctx: the
      // session was not replaced, so this ctx is still the live one.
      if (cancelled) {
        ctx.ui.notify(`pi-jev-compact: new session was cancelled.${where}`, "warning");
      }
    },
  });
}
