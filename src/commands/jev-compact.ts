import { collectLiveWindow, goalFrom } from "../core/live-window";
import { collectToolCalls } from "../core/tool-calls";
import { scoreCalls } from "../core/decide";
import { fitState } from "../core/state";
import { planReplay, reductionRatio, validatePlan } from "../core/replay";
import { JevClient, resolveApiKey } from "../core/jev";
import { DEFAULT_SETTINGS } from "../types";
import type { CallDecision, JevAsker, Settings } from "../types";

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
  };
  plan?: any[];
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
  if (candidates.length === 0) {
    return {
      status: "nothing_to_do",
      message: `pi-jev-compact: no unpinned tool calls in ${window.messages.length} live messages.`,
    };
  }

  let fitted;
  try {
    fitted = fitState(window.messages, calls, {
      maxStateTokens: settings.maxStateTokens,
      preserveRecentMessages: settings.preserveRecentMessages,
      goal: goalFrom(window.messages),
    });
  } catch (error) {
    return { status: "error", message: `pi-jev-compact: ${(error as Error).message}` };
  }

  let scored;
  try {
    scored = await scoreCalls(calls, fitted.state, fitted.tokens, asker, settings);
  } catch (error) {
    return { status: "error", message: `pi-jev-compact: ${(error as Error).message}` };
  }

  const plan = planReplay(window.messages, calls, scored.decisions, settings);
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
  const stats = {
    calls: calls.length,
    kept: count(scored.decisions, "kept"),
    resultsDropped: count(scored.decisions, "result_dropped"),
    callsDropped: count(scored.decisions, "call_dropped"),
    pinned: count(scored.decisions, "pinned"),
    charsBefore: plan.charsBefore,
    charsAfter: plan.charsAfter,
    reduction,
    stateTokens: fitted.tokens,
    stateStage: fitted.stage,
    requests: scored.requests,
  };
  const summary = `${percent(reduction)} smaller; ${stats.kept} kept, ${stats.resultsDropped} results truncated, ${stats.callsDropped} calls dropped, ${stats.pinned} pinned; state ~${stats.stateTokens} tok (${stats.stateStage}) in ${stats.requests} request(s)`;

  if (reduction < settings.minReductionRatio) {
    return {
      status: "below_threshold",
      message: `pi-jev-compact: not worth it, ${summary}. Nothing written.`,
      decisions: scored.decisions,
      stats,
    };
  }

  return {
    status: "ok",
    message: `pi-jev-compact: ${summary}.`,
    decisions: scored.decisions,
    stats,
    plan: plan.messages,
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

export function registerJevCompactCommand(pi: any): void {
  pi.registerCommand("jev-compact", {
    description: "Compact this session with Jev: drop stale tool calls, keep everything else verbatim",
    handler: async (args: string, ctx: any) => {
      const report = args?.trim() === "report";
      const settings: Settings = { ...DEFAULT_SETTINGS };

      const apiKey = resolveApiKey();
      if (!apiKey) {
        ctx.ui.notify(
          "pi-jev-compact: TYPESAFE_API_KEY is not set. Nothing was sent or written.",
          "warning",
        );
        return;
      }

      const branchEntries = ctx.sessionManager.buildContextEntries();
      const outcome = await planCompaction(
        branchEntries,
        new JevClient({ apiKey, model: settings.model }),
        settings,
      );

      if (outcome.decisions?.length) {
        for (const line of decisionLines(outcome.decisions)) ctx.ui.log?.(line);
      }

      if (outcome.status !== "ok") {
        ctx.ui.notify(outcome.message, outcome.status === "error" || outcome.status === "unsafe" ? "error" : "info");
        return;
      }

      if (report) {
        ctx.ui.notify(`${outcome.message} Report only, nothing written.`, "info");
        return;
      }

      const plan = outcome.plan!;
      const confirmed = await ctx.ui.confirm(
        "Write a compacted copy of this session?",
        `${outcome.message}\n\nA new session file is created with ${plan.length} messages. The current session file is not modified. Dropped tool results are gone from the new session; the assistant can re-run those tools.`,
      );
      if (!confirmed) {
        ctx.ui.notify("pi-jev-compact: cancelled, nothing written.", "info");
        return;
      }

      const { cancelled } = await ctx.newSession({
        setup: async (sessionManager: any) => {
          for (const message of plan) sessionManager.appendMessage(message);
        },
      });
      ctx.ui.notify(
        cancelled
          ? "pi-jev-compact: new session was cancelled."
          : `pi-jev-compact: wrote a compacted session with ${plan.length} messages. ${outcome.message}`,
        cancelled ? "warning" : "info",
      );
    },
  });
}
