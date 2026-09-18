import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { planCompaction } from "../src/commands/jev-compact";
import { renderHtmlReport } from "../src/core/report";
import { TracingAsker, writeOwnerOnly } from "../src/core/trace";
import { DEFAULT_SETTINGS } from "../src/types";
import type { JevAsker } from "../src/types";

/**
 * Pi's ExtensionUIContext has no log method, so per-call detail is written to an
 * HTML report instead. These tests check that the report actually shows what was
 * removed and what went over the wire, and that it carries no key material.
 */

const u = (id: string, text: string) => ({
  id,
  type: "message",
  message: { role: "user", content: [{ type: "text", text }] },
});
const c = (id: string, callId: string, tool: string, args: Record<string, unknown>) => ({
  id,
  type: "message",
  message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: tool, arguments: args }] },
});
const r = (id: string, callId: string, body: string) => ({
  id,
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: callId,
    toolName: "read",
    content: [{ type: "text", text: body }],
    isError: false,
  },
});

const branch = () => {
  const entries: any[] = [u("e0", "fix the login redirect bug")];
  for (let i = 1; i <= 30; i++) {
    entries.push(
      c(`a${i}`, `tc_${i}`, i % 2 ? "read" : "bash", i % 2 ? { path: `src/f${i}.ts` } : { command: `npm test ${i}` }),
      r(`r${i}`, `tc_${i}`, `output for call ${i}: ${"x".repeat(3000)}`),
    );
  }
  entries.push(u("e1", "now run the tests"));
  return entries;
};

/** Keeps every fifth call, drops the rest: a mixed report. */
const mixedJev = (): JevAsker => ({
  async ask(_state, questions) {
    const answers: Record<string, { noul: number }> = {};
    let i = 0;
    for (const name of Object.keys(questions)) answers[name] = { noul: i++ % 5 === 0 ? 0.88 : 0.11 };
    return { model: "jev-1.13.0", answers, usage: { input_tokens: 1820, output_tokens: 268 } };
  },
});

const buildReport = async (asker: JevAsker, entries = branch(), written = false) => {
  const tracer = new TracingAsker(asker, "https://api.typesafe.ai/v1/systemone");
  let outcome;
  try {
    outcome = await planCompaction(entries, tracer, DEFAULT_SETTINGS);
  } catch (error) {
    outcome = { status: "error" as const, message: (error as Error).message };
  }
  const html = renderHtmlReport({
    decisions: outcome.decisions ?? [],
    calls: outcome.scoredCalls ?? [],
    messages: outcome.window ?? [],
    trace: tracer.entries,
    goal: outcome.goal ?? "",
    settings: DEFAULT_SETTINGS,
    stats: (outcome.stats ?? {}) as Record<string, unknown>,
    stateSample: outcome.stateSample ?? "",
    written,
  });
  return { outcome, html, tracer };
};

test("the report shows one row per call with both probabilities and the saving", async () => {
  const { outcome, html } = await buildReport(mixedJev());
  assert.equal(outcome.status, "ok");

  const rows = [...html.matchAll(/<tr class="(keep|drop_result|drop_call)">/g)].map((m) => m[1]);
  assert.equal(rows.length, outcome.decisions!.length, "every decision is a row");
  assert.ok(rows.includes("drop_call"), "removals are visible");
  assert.ok(rows.includes("keep"), "kept calls are visible");

  // The saving column is what answers "what did it actually delete".
  assert.match(html, /−[\d,]+/, "a removal reports the characters it freed");
  assert.match(html, /keepCall/);
  assert.match(html, /keepResult/);
  assert.match(html, /command=npm test/, "tool arguments identify the call");
  assert.match(html, /output for call/, "a result preview shows what is being dropped");
});

test("the report contains the exact request and response bodies", async () => {
  const { html, tracer } = await buildReport(mixedJev());
  assert.ok(tracer.entries.length >= 1, "at least one request was captured");

  const entry = tracer.entries[0]!;
  assert.ok(entry.requestBody.includes("\"questions\""), "the request body was recorded");
  assert.ok(entry.requestBody.includes("\"history\""), "including the state");
  assert.ok(entry.responseBody!.includes("jev-1.13.0"), "the response body was recorded");

  assert.match(html, /POST https:\/\/api\.typesafe\.ai\/v1\/systemone/);
  assert.match(html, /HTTP 200/);
  assert.match(html, /KiB sent/);
  assert.ok(html.includes("&quot;questions&quot;"), "the body is embedded, escaped");
});

test("tool output never reaches the recorded request", async () => {
  const { tracer } = await buildReport(mixedJev());
  const body = tracer.entries[0]!.requestBody;
  assert.ok(!body.includes("x".repeat(100)), "the 3000-char results are not in the request");
  assert.match(body, /chars \(omitted\)/, "they are represented by a note instead");
});

test("a failed request is still recorded, with the error and no response", async () => {
  const failing: JevAsker = {
    async ask() {
      throw new Error("Jev request failed (503)");
    },
  };
  const { outcome, html, tracer } = await buildReport(failing);
  assert.equal(outcome.status, "error");
  assert.equal(tracer.entries.length, 1, "the attempt was captured");
  assert.equal(tracer.entries[0]!.ok, false);
  assert.match(tracer.entries[0]!.error!, /503/);

  assert.match(html, /FAILED/);
  assert.match(html, /the request failed/);
  assert.ok(tracer.entries[0]!.requestBody.includes("\"questions\""), "what was attempted is visible");
});

test("the report records whether anything was written", async () => {
  const dry = await buildReport(mixedJev(), branch(), false);
  assert.match(dry.html, /No session file was created or modified/);

  const wrote = await buildReport(mixedJev(), branch(), true);
  assert.match(wrote.html, /A new session file was written/);
  assert.match(wrote.html, /previous session file was not modified/);
});

test("the goal and the state sample are in the report", async () => {
  const { html } = await buildReport(mixedJev());
  assert.match(html, /fix the login redirect bug/, "the goal Jev judged against");
  assert.match(html, /State sample/);
});

test("the report file is owner-only and carries no key material", async () => {
  const { html } = await buildReport(mixedJev());
  const path = writeOwnerOnly("test-report.html", html);

  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600, `mode ${mode.toString(8)}`);

  const written = readFileSync(path, "utf8");
  assert.ok(!/Bearer/i.test(written), "the Authorization header is never recorded");
  assert.ok(!written.includes("TYPESAFE_API_KEY"));
});

test("an empty goal is called out rather than left blank", async () => {
  const noPrompts: any[] = [];
  for (let i = 1; i <= 12; i++) {
    noPrompts.push(
      c(`a${i}`, `tc_${i}`, "read", { path: `f${i}.ts` }),
      r(`r${i}`, `tc_${i}`, "y".repeat(2000)),
    );
  }
  const { html } = await buildReport(mixedJev(), noPrompts);
  assert.match(html, /Jev had no task description to judge against/);
});

test("report HTML escapes transcript content", async () => {
  const hostile = [
    u("e0", "<script>alert('x')</script>"),
    ...Array.from({ length: 12 }, (_, i) => [
      c(`a${i}`, `tc_${i}`, "bash", { command: "echo \"<img onerror=1>\"" }),
      r(`r${i}`, `tc_${i}`, "</pre><script>bad()</script>" + "z".repeat(2000)),
    ]).flat(),
    u("e1", "done"),
  ];
  const { html } = await buildReport(mixedJev(), hostile);
  assert.ok(!html.includes("<script>alert"), "user text is escaped");
  assert.ok(!html.includes("<script>bad()"), "tool output is escaped");
  assert.ok(html.includes("&lt;script&gt;"), "escaped form is present");
});
