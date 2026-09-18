import { textOf } from "./live-window";
import type { CompactionState, FittedState, HistoryEntry, LiveMessage, ToolCall } from "../types";

export const STATE_CONTEXT =
  "A coding assistant conversation is being compacted to free context. `history` is the whole conversation so far, oldest first; tool outputs are replaced by a short `result` note and long texts may be abridged. Each question asks whether one tool call, or the full output of that call, still needs to stay in the history verbatim. Whatever is not kept is deleted permanently, but the assistant can always re-run a tool or re-read a file.";

/** Successive caps on the serialized tool arguments included per call. */
const INPUT_CHARS = [1000, 200, 60] as const;
const TEXT_HEAD = 400;
const TEXT_TAIL = 150;

const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g;

/**
 * Estimate tokens without a tokenizer: one token per six letters, half a token
 * per digit, nine tenths for any other symbol. Taken from fast-jev-compaction,
 * whose comment reports it lands 2-18% above the count Jev returns, while a
 * flat chars-per-token ratio undercounts JSON-heavy states by up to 40%.
 *
 * Not calibrated independently here. Treat it as a bound, not a measurement.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const [piece] of text.matchAll(TOKEN_PIECES)) {
    const first = piece.charCodeAt(0);
    if (first >= 48 && first <= 57) tokens += piece.length / 2;
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6);
    } else tokens += 0.9;
  }
  return Math.ceil(tokens);
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function abridge(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 40) return text;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n[… ${omitted} chars omitted …]\n${text.slice(-tail)}`;
}

function argumentsText(args: Record<string, unknown>, limit: number): string {
  let json: string;
  try {
    json = JSON.stringify(args);
  } catch {
    json = "[unserializable arguments]";
  }
  return truncate(json, limit);
}

/** The result note that stands in for the output Jev never sees. */
function resultNote(call: ToolCall): string {
  return `${call.isError ? "error" : "ok"}, ${call.resultChars} chars (omitted)`;
}

/** One call on a single line, for when the structured form costs too much. */
function compactCall(call: ToolCall): string {
  const args = Object.entries(call.arguments)
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : argumentsText({ [key]: value }, 200);
      return `${key}=${text.replace(/\s+/g, " ")}`;
    })
    .join(" ");
  return `${call.id} ${call.tool} ${truncate(args, INPUT_CHARS[2])} → ${
    call.isError ? "error" : "ok"
  } ${call.resultChars}ch`;
}

function roleOf(message: any): string {
  return typeof message?.role === "string" ? message.role : "unknown";
}

function displayText(message: any): string {
  if (typeof message?.summary === "string") return message.summary;
  return textOf(message?.content);
}

function callsByMessage(calls: readonly ToolCall[]): Map<number, ToolCall[]> {
  const byMessage = new Map<number, ToolCall[]>();
  for (const call of calls) {
    const list = byMessage.get(call.callIndex) ?? [];
    list.push(call);
    byMessage.set(call.callIndex, list);
  }
  return byMessage;
}

function historyEntries(
  messages: readonly LiveMessage[],
  calls: readonly ToolCall[],
  inputChars: number,
): HistoryEntry[] {
  const byMessage = callsByMessage(calls);
  const entries: HistoryEntry[] = [];
  messages.forEach(({ message }, i) => {
    const own = (byMessage.get(i) ?? []).map((call) => ({
      id: call.id,
      tool: call.tool,
      input: argumentsText(call.arguments, inputChars),
      result: resultNote(call),
    }));
    const text = displayText(message);
    // A toolResult carries only output, which is represented by its call's note.
    if (roleOf(message) === "toolResult") return;
    if (text.trim().length === 0 && own.length === 0) return;
    const entry: HistoryEntry = { i, role: roleOf(message), text };
    if (own.length > 0) entry.tool_calls = own;
    entries.push(entry);
  });
  return entries;
}

export interface FitOptions {
  maxStateTokens: number;
  preserveRecentMessages: number;
  goal: string;
}

/**
 * Build the Jev state and shrink it in stages until it fits, each stage applied
 * only when the previous one was not enough. Throws when even the last stage is
 * too large; the caller decides what to do about that.
 */
export function fitState(
  messages: readonly LiveMessage[],
  calls: readonly ToolCall[],
  options: FitOptions,
): FittedState {
  const stateOf = (history: HistoryEntry[]): CompactionState => ({
    context: STATE_CONTEXT,
    goal: options.goal,
    history,
  });
  const entryTokens = (entry: HistoryEntry): number => estimateTokens(JSON.stringify(entry)) + 1;
  const baseTokens = estimateTokens(JSON.stringify(stateOf([])));
  const fitted = (history: HistoryEntry[], tokens: number, stage: string): FittedState => ({
    state: stateOf(history),
    tokens,
    stage,
  });

  let history: HistoryEntry[] = [];
  let perEntry: number[] = [];
  let tokens = 0;
  const rebuild = (inputChars: number): void => {
    history = historyEntries(messages, calls, inputChars);
    perEntry = history.map(entryTokens);
    tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0);
  };
  const fits = (): boolean => tokens <= options.maxStateTokens;
  const shrink = (index: number, change: (entry: HistoryEntry) => void): void => {
    const entry = history[index];
    if (!entry) return;
    change(entry);
    const now = entryTokens(entry);
    tokens += now - (perEntry[index] ?? 0);
    perEntry[index] = now;
  };

  rebuild(INPUT_CHARS[0]);
  if (fits()) return fitted(history, tokens, "full");

  for (const limit of INPUT_CHARS.slice(1)) {
    rebuild(limit);
    if (fits()) return fitted(history, tokens, `inputs<=${limit}`);
  }

  const pinned = (entry: HistoryEntry): boolean =>
    isPinnedIndex(entry.i, messages.length, options.preserveRecentMessages);
  const indices = history.map((_, index) => index);
  const order = [
    ...indices.filter((index) => !pinned(history[index]!)),
    ...indices.filter((index) => pinned(history[index]!)),
  ];

  for (const index of order) {
    const entry = history[index]!;
    if (entry.text.length <= TEXT_HEAD + TEXT_TAIL + 40) continue;
    shrink(index, (e) => {
      e.text = abridge(e.text, TEXT_HEAD, TEXT_TAIL);
    });
    if (fits()) return fitted(history, tokens, "texts abridged");
  }

  for (const index of order) {
    const entry = history[index]!;
    if (pinned(entry) || entry.text.length === 0) continue;
    const original = displayText(messages[entry.i]?.message).length || entry.text.length;
    shrink(index, (e) => {
      e.text = `[… ${original} chars omitted …]`;
    });
    if (fits()) return fitted(history, tokens, "old messages collapsed");
  }

  const byMessage = callsByMessage(calls);
  for (const index of order) {
    const entry = history[index]!;
    const own = byMessage.get(entry.i);
    if (pinned(entry) || !own) continue;
    shrink(index, (e) => {
      e.tool_calls = own.map(compactCall);
    });
    if (fits()) return fitted(history, tokens, "old calls compacted");
  }

  const dropped = new Set<number>();
  for (const index of order) {
    const entry = history[index]!;
    if (pinned(entry) || entry.tool_calls) continue;
    dropped.add(index);
    tokens -= perEntry[index] ?? 0;
    if (fits()) {
      return fitted(
        history.filter((_, i) => !dropped.has(i)),
        tokens,
        "old messages left out",
      );
    }
  }

  throw new Error(
    `live window too large for Jev (~${tokens} tokens after shrinking, limit ${options.maxStateTokens})`,
  );
}

function isPinnedIndex(index: number, total: number, preserveRecent: number): boolean {
  return index === 0 || index >= total - preserveRecent;
}
