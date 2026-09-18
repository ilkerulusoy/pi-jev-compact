import { messageChars } from "./tool-calls";
import type { CallDecision, LiveMessage, Settings, ToolCall } from "../types";

/**
 * Roles that must never go through `appendMessage`.
 *
 * Verified by execution on pi 0.85.1: `appendMessage` accepts them despite its
 * own doc comment saying it refuses them, and writes them as ordinary `message`
 * entries, which is the wrong shape. A prior summary belongs in
 * `appendCompaction`, so this guard lives here instead.
 */
const REFUSED_ROLES = new Set(["compactionSummary", "branchSummary"]);

export function isRefusedRole(message: any): boolean {
  return REFUSED_ROLES.has(message?.role);
}

/** The note that replaces a dropped result, keeping a bounded head. */
export function truncatedResultContent(
  content: unknown,
  isError: boolean,
  headChars: number,
): { type: "text"; text: string }[] {
  const text = Array.isArray(content)
    ? content
        .filter((part: any) => part?.type === "text")
        .map((part: any) => part.text ?? "")
        .join("\n")
    : typeof content === "string"
      ? content
      : "";
  if (text.length <= headChars + 120) return [{ type: "text", text }];
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : "";
  return [
    {
      type: "text",
      text: `${head}[pi-jev-compact truncated ${text.length - headChars} chars of this tool result${
        isError ? " (error)" : ""
      }; re-run the tool if needed]`,
    },
  ];
}

export interface PlanResult {
  /** Messages to replay, in order. */
  messages: any[];
  charsBefore: number;
  charsAfter: number;
}

/**
 * Build the surviving message list from the decisions.
 *
 * A dropped call loses its `toolCall` part and its `toolResult` message
 * together. An assistant message that ends up with no content at all is left
 * out. A dropped result keeps a bounded head and a note.
 */
export function planReplay(
  messages: readonly LiveMessage[],
  calls: readonly ToolCall[],
  decisions: readonly CallDecision[],
  settings: Pick<Settings, "truncateHeadChars">,
): PlanResult {
  const byShortId = new Map(calls.map((call) => [call.id, call]));
  const actionByToolCallId = new Map<string, CallDecision["action"]>();
  for (const decision of decisions) {
    const call = byShortId.get(decision.id);
    if (call && decision.action !== "keep") actionByToolCallId.set(call.toolCallId, decision.action);
  }

  const charsBefore = messages.reduce((sum, { message }) => sum + messageChars(message), 0);
  const survivors: any[] = [];

  for (const { message } of messages) {
    if (!message) continue;

    if (message.role === "toolResult") {
      const action = actionByToolCallId.get(message.toolCallId);
      if (action === "drop_call") continue;
      if (action === "drop_result") {
        survivors.push({
          ...message,
          content: truncatedResultContent(
            message.content,
            message.isError === true,
            settings.truncateHeadChars,
          ),
        });
        continue;
      }
      survivors.push(message);
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.content)) {
      const content = message.content.filter(
        (part: any) =>
          !(part?.type === "toolCall" && actionByToolCallId.get(part.id) === "drop_call"),
      );
      if (content.length === message.content.length) {
        survivors.push(message);
        continue;
      }
      if (content.length === 0) continue;
      survivors.push({ ...message, content });
      continue;
    }

    survivors.push(message);
  }

  return {
    messages: survivors,
    charsBefore,
    charsAfter: survivors.reduce((sum, message) => sum + messageChars(message), 0),
  };
}

export interface PairingProblem {
  kind: "result_without_call" | "refused_role";
  detail: string;
}

/**
 * Verify the plan before anything is written.
 *
 * `appendMessage` performs no pairing, ordering, or content validation, and no
 * provider-level repair has been established, so this is the only guarantee
 * that exists. A non-empty result means: write nothing.
 */
export function validatePlan(messages: readonly any[]): PairingProblem[] {
  const problems: PairingProblem[] = [];
  const seenCallIds = new Set<string>();

  for (const message of messages) {
    if (isRefusedRole(message)) {
      problems.push({ kind: "refused_role", detail: String(message.role) });
      continue;
    }
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === "toolCall" && typeof part.id === "string") seenCallIds.add(part.id);
      }
    }
    if (message?.role === "toolResult") {
      const id = message.toolCallId;
      if (typeof id !== "string" || !seenCallIds.has(id)) {
        problems.push({ kind: "result_without_call", detail: String(id) });
      }
    }
  }
  return problems;
}

export function reductionRatio(plan: Pick<PlanResult, "charsBefore" | "charsAfter">): number {
  if (plan.charsBefore === 0) return 0;
  return (plan.charsBefore - plan.charsAfter) / plan.charsBefore;
}
