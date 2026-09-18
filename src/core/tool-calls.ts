import { textOf } from "./live-window";
import type { LiveMessage, ToolCall } from "../types";

/** The first message and the newest `preserveRecentMessages` are never touched. */
export function isPinned(index: number, total: number, preserveRecent: number): boolean {
  return index === 0 || index >= total - preserveRecent;
}

/**
 * Pair every assistant `toolCall` with its `toolResult` by tool call id.
 *
 * A call without a result is not a candidate: there is nothing to drop yet, and
 * removing the call alone would leave the transcript inconsistent.
 */
export function collectToolCalls(
  messages: readonly LiveMessage[],
  preserveRecent: number,
): ToolCall[] {
  const results = new Map<string, { index: number; message: any }>();
  messages.forEach(({ message }, index) => {
    if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
      results.set(message.toolCallId, { index, message });
    }
  });

  const calls: ToolCall[] = [];
  messages.forEach(({ message }, callIndex) => {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
    for (const part of message.content) {
      if (part?.type !== "toolCall" || typeof part.id !== "string") continue;
      const found = results.get(part.id);
      if (!found) continue;
      const resultText = textOf(found.message.content);
      calls.push({
        id: `t${calls.length + 1}`,
        toolCallId: part.id,
        tool: part.name ?? "unknown",
        arguments: (part.arguments ?? {}) as Record<string, unknown>,
        callIndex,
        resultIndex: found.index,
        resultChars: resultText.length,
        isError: found.message.isError === true,
        pinned:
          isPinned(callIndex, messages.length, preserveRecent) ||
          isPinned(found.index, messages.length, preserveRecent),
      });
    }
  });
  return calls;
}

/** Characters of text, tool arguments, and tool output one message holds. */
export function messageChars(message: any): number {
  if (!message) return 0;
  let total = textOf(message.content).length;
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part?.type === "toolCall") {
        try {
          total += JSON.stringify(part.arguments ?? {}).length;
        } catch {
          total += 20;
        }
      }
    }
  }
  if (typeof message.summary === "string") total += message.summary.length;
  return total;
}
