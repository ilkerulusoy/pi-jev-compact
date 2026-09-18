import { estimateTokens } from "./state";
import type {
  CallAnswer,
  CallDecision,
  CompactionState,
  JevAsker,
  JevQuestions,
  Settings,
  ToolCall,
} from "../types";

/** Tokens the request envelope adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

/** The two questions asked about one call: keep the call, keep its result. */
export function questionsFor(call: ToolCall): JevQuestions {
  return {
    [`call_${call.id}`]: {
      type: "noul",
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: "noul",
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  };
}

/**
 * Split candidate calls into batches whose questions, together with the always
 * complete state, fit one request.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  maxRequestTokens: number,
): ToolCall[][] {
  const budget = maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Read one noul probability, refusing anything that is not a finite 0..1 number. */
export function noulOf(
  answers: Record<string, { noul?: number } & Record<string, unknown>>,
  name: string,
): number {
  const value = answers?.[name]?.noul;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`invalid Jev answer for ${name}`);
  }
  return value;
}

export function decideCall(
  call: Pick<ToolCall, "id" | "tool" | "pinned">,
  answer: CallAnswer,
  keepThreshold: number,
): CallDecision {
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: "keep", reason: "pinned" };
  if (answer.keepResult >= keepThreshold) return { ...base, action: "keep", reason: "kept" };
  if (answer.keepCall >= keepThreshold) {
    return { ...base, action: "drop_result", reason: "result_dropped" };
  }
  return { ...base, action: "drop_call", reason: "call_dropped" };
}

async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
): Promise<Map<string, CallAnswer>> {
  const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor));
  const { answers } = await asker.ask(state, questions);
  return new Map(
    batch.map((call) => [
      call.id,
      {
        keepCall: noulOf(answers, `call_${call.id}`),
        keepResult: noulOf(answers, `result_${call.id}`),
      },
    ]),
  );
}

export interface ScoreResult {
  decisions: CallDecision[];
  requests: number;
}

/**
 * Score every call. Pinned calls are decided locally and never sent. A failure
 * from Jev propagates: the caller must write nothing in that case.
 */
export async function scoreCalls(
  calls: readonly ToolCall[],
  state: CompactionState,
  stateTokens: number,
  asker: JevAsker,
  settings: Pick<Settings, "keepThreshold" | "maxRequestTokens">,
): Promise<ScoreResult> {
  const candidates = calls.filter((call) => !call.pinned);
  const answers = new Map<string, CallAnswer>();
  let requests = 0;

  if (candidates.length > 0) {
    const batches = batchCalls(candidates, stateTokens, settings.maxRequestTokens);
    requests = batches.length;
    const answered = await Promise.all(batches.map((batch) => askBatch(asker, state, batch)));
    for (const map of answered) for (const [id, answer] of map) answers.set(id, answer);
  }

  const decisions = calls.map((call) =>
    decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, settings.keepThreshold),
  );
  return { decisions, requests };
}
