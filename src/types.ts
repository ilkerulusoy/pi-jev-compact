/** A tool call paired with its result, located in the live window. */
export interface ToolCall {
  /** Short id used in the Jev state and question names: t1, t2, ... */
  id: string;
  /** The provider-level tool call id that ties call and result together. */
  toolCallId: string;
  tool: string;
  arguments: Record<string, unknown>;
  /** Index in the live window of the assistant message holding the call. */
  callIndex: number;
  /** Index in the live window of the toolResult message. */
  resultIndex: number;
  resultChars: number;
  isError: boolean;
  /** In the first or newest preserved messages; never a candidate. */
  pinned: boolean;
}

export type CallAction = "keep" | "drop_result" | "drop_call";

export interface CallAnswer {
  /** Probability that the call itself still matters. */
  keepCall: number;
  /** Probability that the full result still needs to stay verbatim. */
  keepResult: number;
}

export interface CallDecision extends CallAnswer {
  id: string;
  tool: string;
  action: CallAction;
  reason: "pinned" | "kept" | "result_dropped" | "call_dropped";
}

/** A candidate assistant prose block, addressed by its position in the window. */
export interface TextBlock {
  /** Short id used in the state and question names: x1, x2, ... */
  id: string;
  /** Index in the live window. */
  messageIndex: number;
  chars: number;
  pinned: boolean;
}

export interface TextDecision {
  id: string;
  messageIndex: number;
  chars: number;
  keepText: number;
  action: "keep" | "drop_text";
  reason: "pinned" | "kept" | "text_dropped";
}

/** One entry of the live window: the session entry id plus its context message. */
export interface LiveMessage {
  entryId: string;
  message: any;
}

export interface HistoryToolCall {
  id: string;
  tool: string;
  input: string;
  result: string;
}

export interface HistoryEntry {
  i: number;
  role: string;
  text: string;
  tool_calls?: HistoryToolCall[] | string[];
}

export interface CompactionState {
  context: string;
  goal: string;
  history: HistoryEntry[];
}

export interface FittedState {
  state: CompactionState;
  tokens: number;
  /** Which fitting stage produced this state, for diagnostics. */
  stage: string;
}

export interface JevNoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export type JevQuestions = Record<string, JevNoulQuestion>;

export interface JevResponse {
  model?: string;
  answers: Record<string, { noul?: number } & Record<string, unknown>>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Anything that can answer Jev questions: the HTTP client, or a fake in tests. */
export interface JevAsker {
  ask(state: CompactionState, questions: JevQuestions): Promise<JevResponse>;
}

export interface Settings {
  keepThreshold: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  truncateHeadChars: number;
  minReductionRatio: number;
  model: string;
  /**
   * Ask Jev whether assistant prose still matters, and remove it when it does
   * not. Off by default: a dropped tool result can be recovered by running the
   * tool again, but dropped reasoning cannot be recovered at all.
   */
  scoreAssistantText: boolean;
  /**
   * Keep threshold for assistant prose, separate from and higher than the one
   * for tool calls, because the mistake is irreversible.
   */
  textKeepThreshold: number;
  /** Assistant messages shorter than this are never candidates. */
  textMinChars: number;
}

export const DEFAULT_SETTINGS: Settings = {
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
  minReductionRatio: 0.25,
  model: "jev-latest",
  scoreAssistantText: false,
  textKeepThreshold: 0.3,
  textMinChars: 400,
};
