import { estimateTokens } from "./state";
import type {
  CallAnswer,
  CallDecision,
  CompactionState,
  JevAsker,
  JevQuestions,
  Settings,
  ToolCall,
  TextBlock,
  TextDecision,
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

export interface BatchOutcome {
  answers: Map<string, CallAnswer>;
  /** What the model reported for this request, when it reported anything. */
  model?: string;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  questions: number;
}

async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
): Promise<BatchOutcome> {
  const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor));
  const started = Date.now();
  const response = await asker.ask(state, questions);
  const elapsedMs = Date.now() - started;
  const answers = new Map(
    batch.map((call) => [
      call.id,
      {
        keepCall: noulOf(response.answers, `call_${call.id}`),
        keepResult: noulOf(response.answers, `result_${call.id}`),
      },
    ]),
  );
  return {
    answers,
    ...(response.model ? { model: response.model } : {}),
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    elapsedMs,
    questions: Object.keys(questions).length,
  };
}

export interface ScoreResult {
  decisions: CallDecision[];
  requests: number;
  /** Distinct model names that answered, as reported by the API. */
  models: string[];
  inputTokens: number;
  outputTokens: number;
  questionsAsked: number;
  /** Wall clock for the whole scoring step; batches run concurrently. */
  elapsedMs: number;
  /** Slowest single request, which is closer to the per-judgment latency. */
  slowestRequestMs: number;
}

/**
 * Score every call. Pinned calls are decided locally and never sent. A failure
 * from Jev propagates: the caller must write nothing in that case.
 *
 * Token counts and timings come back with the decisions so the caller can show
 * what the run actually cost rather than asserting that it worked.
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
  const models = new Set<string>();
  let requests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let questionsAsked = 0;
  let slowestRequestMs = 0;
  const started = Date.now();

  if (candidates.length > 0) {
    const batches = batchCalls(candidates, stateTokens, settings.maxRequestTokens);
    requests = batches.length;
    const outcomes = await Promise.all(batches.map((batch) => askBatch(asker, state, batch)));
    for (const outcome of outcomes) {
      for (const [id, answer] of outcome.answers) answers.set(id, answer);
      if (outcome.model) models.add(outcome.model);
      inputTokens += outcome.inputTokens;
      outputTokens += outcome.outputTokens;
      questionsAsked += outcome.questions;
      slowestRequestMs = Math.max(slowestRequestMs, outcome.elapsedMs);
    }
  }

  const decisions = calls.map((call) =>
    decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, settings.keepThreshold),
  );
  return {
    decisions,
    requests,
    models: [...models],
    inputTokens,
    outputTokens,
    questionsAsked,
    elapsedMs: Date.now() - started,
    slowestRequestMs,
  };
}

/**
 * The question asked about one assistant prose block.
 *
 * Deliberately narrower than the tool-call questions. Removing prose destroys
 * the only record of that reasoning, so the question asks whether it is
 * *superseded*, not merely whether it is still interesting.
 */
export function textQuestionFor(block: TextBlock): JevQuestions {
  return {
    [`text_${block.id}`]: {
      type: "noul",
      instructions: `Message ${block.messageIndex} in the history is assistant prose of ${block.chars} characters. It should stay in the history verbatim: it records a decision, a constraint, a finding, or an explanation that still bears on the goal and is not restated by later messages`,
      criteria: {
        true: "It carries a decision, constraint, finding, correction, or explanation that later messages rely on and do not repeat.",
        false: "It is narration of work already visible in the tool calls, a restatement of a later message, or commentary with no bearing on the goal.",
      },
    },
  };
}

export function decideText(
  block: TextBlock,
  keepText: number,
  textKeepThreshold: number,
): TextDecision {
  const base = { id: block.id, messageIndex: block.messageIndex, chars: block.chars, keepText };
  if (block.pinned) return { ...base, action: "keep", reason: "pinned" };
  if (keepText >= textKeepThreshold) return { ...base, action: "keep", reason: "kept" };
  return { ...base, action: "drop_text", reason: "text_dropped" };
}

/**
 * Score assistant prose. Runs as its own set of requests rather than riding on
 * the tool-call batches, so the state budget is computed once and the two
 * question kinds cannot crowd each other out.
 */
export async function scoreTextBlocks(
  blocks: readonly TextBlock[],
  state: CompactionState,
  stateTokens: number,
  asker: JevAsker,
  settings: Pick<Settings, "textKeepThreshold" | "maxRequestTokens">,
): Promise<{ decisions: TextDecision[]; requests: number; inputTokens: number; outputTokens: number; questionsAsked: number }> {
  const candidates = blocks.filter((block) => !block.pinned);
  const scores = new Map<string, number>();
  let requests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let questionsAsked = 0;

  if (candidates.length > 0) {
    const budget = settings.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
    const batches: TextBlock[][] = [];
    let current: TextBlock[] = [];
    let currentTokens = 0;
    for (const block of candidates) {
      const tokens = estimateTokens(JSON.stringify(textQuestionFor(block)));
      if (current.length > 0 && currentTokens + tokens > budget) {
        batches.push(current);
        current = [];
        currentTokens = 0;
      }
      if (current.length === 0 && tokens > budget) {
        throw new Error(
          `state leaves no room for text questions (~${stateTokens} of ${settings.maxRequestTokens} tokens)`,
        );
      }
      current.push(block);
      currentTokens += tokens;
    }
    if (current.length > 0) batches.push(current);
    requests = batches.length;

    const outcomes = await Promise.all(
      batches.map(async (batch) => {
        const questions: JevQuestions = Object.assign({}, ...batch.map(textQuestionFor));
        const response = await asker.ask(state, questions);
        return { batch, response, questions: Object.keys(questions).length };
      }),
    );
    for (const { batch, response, questions } of outcomes) {
      for (const block of batch) scores.set(block.id, noulOf(response.answers, `text_${block.id}`));
      inputTokens += response.usage?.input_tokens ?? 0;
      outputTokens += response.usage?.output_tokens ?? 0;
      questionsAsked += questions;
    }
  }

  const decisions = blocks.map((block) =>
    decideText(block, scores.get(block.id) ?? 1, settings.textKeepThreshold),
  );
  return { decisions, requests, inputTokens, outputTokens, questionsAsked };
}
