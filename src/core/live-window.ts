import type { LiveMessage } from "../types";

/**
 * Entry types that project into LLM context, verified against
 * `sessionEntryToContextMessages` in pi 0.85.1: message, custom_message,
 * branch_summary, compaction. A `compaction` entry is deliberately excluded
 * here because the live window is what comes *after* the newest one.
 */
const contextEntryTypes = new Set(["message", "custom_message", "branch_summary"]);

/** Convert a context-bearing entry into the message shape used downstream. */
function toLiveMessage(entry: any): any | null {
  if (entry.type === "message" && entry.message) return entry.message;
  if (entry.type === "custom_message") {
    return {
      role: "custom",
      customType: entry.customType,
      content: entry.content,
      display: entry.display,
      details: entry.details,
    };
  }
  if (entry.type === "branch_summary") {
    return { role: "branchSummary", summary: entry.summary, fromId: entry.fromId };
  }
  return null;
}

export interface LiveWindow {
  messages: LiveMessage[];
  /** The newest compaction entry on the branch, when there is one. */
  priorCompaction?: { summary: string; tokensBefore: number; details?: unknown };
  /** True when the previous compaction's kept boundary could not be resolved. */
  orphanRecovery: boolean;
}

/**
 * Collect the messages that currently participate in context: everything from
 * the newest compaction's `firstKeptEntryId` onward, or the whole branch when
 * there has been no compaction.
 *
 * Orphan recovery, borrowed from pi-vcc: when a prior compaction exists but its
 * `firstKeptEntryId` is empty or no longer present on the branch, collection
 * starts right after that compaction entry instead of silently returning
 * everything.
 */
export function collectLiveWindow(branchEntries: readonly any[]): LiveWindow {
  let compactionIndex = -1;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i]?.type === "compaction") {
      compactionIndex = i;
      break;
    }
  }

  const compaction = compactionIndex >= 0 ? branchEntries[compactionIndex] : undefined;
  const keptId: string | undefined = compaction?.firstKeptEntryId;
  const keptIdResolves = !!keptId && branchEntries.some((entry) => entry?.id === keptId);
  const orphanRecovery = compactionIndex >= 0 && !keptIdResolves;

  const messages: LiveMessage[] = [];
  const startIndex = orphanRecovery ? compactionIndex + 1 : 0;
  let collecting = orphanRecovery || !keptId;

  for (let i = startIndex; i < branchEntries.length; i++) {
    const entry = branchEntries[i];
    if (!entry) continue;
    if (!collecting && entry.id === keptId) collecting = true;
    if (!collecting) continue;
    if (!contextEntryTypes.has(entry.type)) continue;
    const message = toLiveMessage(entry);
    if (message) messages.push({ entryId: entry.id, message });
  }

  const window: LiveWindow = { messages, orphanRecovery };
  if (compaction) {
    window.priorCompaction = {
      summary: compaction.summary,
      tokensBefore: compaction.tokensBefore ?? 0,
      details: compaction.details,
    };
  }
  return window;
}

/** The last few user prompts, used as the `goal` field of the Jev state. */
export function goalFrom(messages: readonly LiveMessage[], limit = 3): string {
  const prompts: string[] = [];
  for (const { message } of messages) {
    if (message?.role !== "user") continue;
    const text = textOf(message.content).trim();
    if (text) prompts.push(text.slice(0, 500));
  }
  return prompts.slice(-limit).join("\n");
}

/** Text of a message content field, which may be a string or a content array. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
}
