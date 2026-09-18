import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompactionState, JevAsker, JevQuestions, JevResponse } from "../types";

/** One request/response pair, captured for inspection. */
export interface TraceEntry {
  index: number;
  url: string;
  startedAt: string;
  elapsedMs: number;
  status?: number;
  ok: boolean;
  requestBytes: number;
  /** The exact JSON body sent, minus the Authorization header. */
  requestBody: string;
  /** The exact response text received, or the error that replaced it. */
  responseBody?: string;
  error?: string;
}

/**
 * Wraps a JevAsker and records every request and response verbatim.
 *
 * The recorded body is the transcript sample that left the machine, so the file
 * it is written to is owner-only. The API key is never part of the body: it
 * travels in the Authorization header, which is not captured.
 */
export class TracingAsker implements JevAsker {
  readonly entries: TraceEntry[] = [];
  private readonly inner: JevAsker;
  private readonly url: string;

  constructor(inner: JevAsker, url: string) {
    this.inner = inner;
    this.url = url;
  }

  async ask(state: CompactionState, questions: JevQuestions): Promise<JevResponse> {
    const index = this.entries.length + 1;
    const requestBody = JSON.stringify({ state, questions }, null, 2);
    const startedAt = new Date().toISOString();
    const started = Date.now();
    try {
      const response = await this.inner.ask(state, questions);
      this.entries.push({
        index,
        url: this.url,
        startedAt,
        elapsedMs: Date.now() - started,
        status: 200,
        ok: true,
        requestBytes: Buffer.byteLength(requestBody, "utf8"),
        requestBody,
        responseBody: JSON.stringify(response, null, 2),
      });
      return response;
    } catch (error) {
      this.entries.push({
        index,
        url: this.url,
        startedAt,
        elapsedMs: Date.now() - started,
        ok: false,
        requestBytes: Buffer.byteLength(requestBody, "utf8"),
        requestBody,
        error: (error as Error).message,
      });
      throw error;
    }
  }
}

/** Create an owner-only directory for reports, under the OS temp dir. */
export function reportDir(): string {
  const dir = join(tmpdir(), "pi-jev-compact");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Write a file readable only by its owner; returns the path. */
export function writeOwnerOnly(name: string, content: string): string {
  const path = join(reportDir(), name);
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
  return path;
}

export function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
