import type { CompactionState, JevAsker, JevQuestions, JevResponse } from "../types";

export const SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";

export interface JevClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** The HTTP request body for one Jev call, exposed so tests can inspect it. */
export function buildRequestBody(
  state: CompactionState,
  questions: JevQuestions,
  model: string,
): string {
  return JSON.stringify({ model, state, questions });
}

/**
 * Validate a response body. Checks that every asked question came back with a
 * finite probability, which is stricter than checking `answers` is an object.
 */
export function parseResponse(
  status: number,
  ok: boolean,
  text: string,
  questions: JevQuestions,
): JevResponse {
  if (!ok) throw new Error(`Jev request failed (${status})`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Jev returned malformed JSON");
  }
  const answers = (parsed as JevResponse | null)?.answers;
  if (!answers || typeof answers !== "object") throw new Error("Jev response is missing answers");
  for (const name of Object.keys(questions)) {
    const value = answers[name]?.noul;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error("Jev response has an unexpected answer shape");
    }
  }
  return parsed as JevResponse;
}

/**
 * Asks Jev over HTTP. Error messages never include the response body, so a
 * provider message cannot leak transcript content back into the UI.
 */
export class JevClient implements JevAsker {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: JevClientOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "jev-latest";
    this.baseUrl = options.baseUrl ?? SYSTEM_ONE_URL;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async ask(state: CompactionState, questions: JevQuestions): Promise<JevResponse> {
    if (!this.apiKey) throw new Error("TYPESAFE_API_KEY is not configured");
    const response = await this.fetcher(this.baseUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: buildRequestBody(state, questions, this.model),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return parseResponse(response.status, response.ok, await response.text(), questions);
  }
}

export function resolveApiKey(): string | undefined {
  const key = process.env.TYPESAFE_API_KEY?.trim();
  return key ? key : undefined;
}
