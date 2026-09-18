import type { CallDecision, LiveMessage, Settings, TextDecision, ToolCall } from "../types";
import { textOf } from "./live-window";
import type { TraceEntry } from "./trace";

export interface ReportInput {
  decisions: readonly CallDecision[];
  calls: readonly ToolCall[];
  messages: readonly LiveMessage[];
  trace: readonly TraceEntry[];
  goal: string;
  settings: Settings;
  stats: Record<string, unknown>;
  stateSample: string;
  written: boolean;
  /** Prose decisions, empty unless assistant text was scored. */
  textDecisions?: readonly TextDecision[];
}

const escape = (value: unknown): string =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const ACTION_LABEL: Record<CallDecision["action"], string> = {
  keep: "kept",
  drop_result: "result truncated",
  drop_call: "removed",
};

/** A bar showing where a probability sits against the threshold. */
function bar(value: number, threshold: number): string {
  const filled = Math.round(value * 20);
  const mark = Math.round(threshold * 20);
  let out = "";
  for (let i = 0; i < 20; i++) {
    if (i === mark) out += `<i class="mark">${i < filled ? "█" : "·"}</i>`;
    else out += i < filled ? "█" : "·";
  }
  return out;
}

function argumentsPreview(args: Record<string, unknown>, limit = 160): string {
  const text = Object.entries(args)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** First line of the tool result, so a removal can be recognised at a glance. */
function resultPreview(messages: readonly LiveMessage[], call: ToolCall, limit = 200): string {
  const message = messages[call.resultIndex]?.message;
  const text = textOf(message?.content).replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * A self-contained HTML report: what was removed, what each probability was, and
 * the exact request and response bodies. No external assets, no scripts beyond a
 * filter, so it opens straight from disk.
 */
export function renderHtmlReport(input: ReportInput): string {
  const { decisions, calls, messages, trace, goal, settings, stats } = input;
  const byId = new Map(calls.map((call) => [call.id, call]));
  const scored = decisions.filter((d) => d.reason !== "pinned");

  const rows = decisions
    .map((decision) => {
      const call = byId.get(decision.id);
      if (!call) return "";
      const charsSaved =
        decision.action === "drop_call"
          ? call.resultChars
          : decision.action === "drop_result"
            ? Math.max(0, call.resultChars - settings.truncateHeadChars)
            : 0;
      return `<tr class="${decision.action}">
<td class="id">${escape(decision.id)}</td>
<td>${escape(decision.tool)}</td>
<td class="args" title="${escape(argumentsPreview(call.arguments, 600))}">${escape(argumentsPreview(call.arguments))}</td>
<td class="num">${call.resultChars.toLocaleString()}</td>
<td class="num saved">${charsSaved ? `−${charsSaved.toLocaleString()}` : "—"}</td>
<td class="prob"><span class="bar">${bar(decision.keepCall, settings.keepThreshold)}</span> ${decision.keepCall.toFixed(2)}</td>
<td class="prob"><span class="bar">${bar(decision.keepResult, settings.keepThreshold)}</span> ${decision.keepResult.toFixed(2)}</td>
<td class="action">${escape(ACTION_LABEL[decision.action])}${decision.reason === "pinned" ? " <em>(pinned)</em>" : ""}</td>
<td class="preview">${escape(resultPreview(messages, call))}</td>
</tr>`;
    })
    .join("\n");

  const textRows = (input.textDecisions ?? [])
    .map((decision) => {
      const message = messages[decision.messageIndex]?.message;
      const preview = textOf(message?.content).replace(/\s+/g, " ").trim().slice(0, 200);
      const saved = decision.action === "drop_text" ? decision.chars : 0;
      return `<tr class="${decision.action === "drop_text" ? "drop_call" : "keep"}">
<td class="id">${escape(decision.id)}</td>
<td class="num">${decision.messageIndex}</td>
<td class="num">${decision.chars.toLocaleString()}</td>
<td class="num saved">${saved ? `−${saved.toLocaleString()}` : "—"}</td>
<td class="prob"><span class="bar">${bar(decision.keepText, settings.textKeepThreshold)}</span> ${decision.keepText.toFixed(2)}</td>
<td class="action">${decision.action === "drop_text" ? "prose removed" : "kept"}${decision.reason === "pinned" ? " <em>(pinned)</em>" : ""}</td>
<td class="preview">${escape(preview)}</td>
</tr>`;
    })
    .join("\n");

  const requests = trace
    .map(
      (entry) => `<details class="req ${entry.ok ? "ok" : "bad"}">
<summary>#${entry.index} POST ${escape(entry.url)} — ${entry.ok ? `HTTP ${entry.status ?? 200}` : "FAILED"} · ${entry.elapsedMs} ms · ${(entry.requestBytes / 1024).toFixed(1)} KiB sent · ${escape(entry.startedAt)}</summary>
${entry.error ? `<p class="err">${escape(entry.error)}</p>` : ""}
<h4>Request body</h4>
<pre>${escape(entry.requestBody)}</pre>
<h4>Response body</h4>
<pre>${escape(entry.responseBody ?? "(none: the request failed)")}</pre>
</details>`,
    )
    .join("\n");

  const statRows = Object.entries(stats)
    .map(([key, value]) => `<tr><th>${escape(key)}</th><td>${escape(JSON.stringify(value))}</td></tr>`)
    .join("\n");

  const droppedChars = decisions.reduce((sum, d) => {
    const call = byId.get(d.id);
    if (!call) return sum;
    if (d.action === "drop_call") return sum + call.resultChars;
    if (d.action === "drop_result") return sum + Math.max(0, call.resultChars - settings.truncateHeadChars);
    return sum;
  }, 0);

  const highest = [...scored].sort((a, b) => b.keepResult - a.keepResult).slice(0, 5);
  const lowest = [...scored].sort((a, b) => a.keepResult - b.keepResult).slice(0, 5);
  const extremes = (list: CallDecision[]) =>
    list
      .map((d) => `<li><code>${escape(d.id)}</code> ${escape(d.tool)} — ${d.keepResult.toFixed(2)}</li>`)
      .join("");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>pi-jev-compact report</title>
<style>
 :root { color-scheme: light dark; }
 body { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; padding: 24px; max-width: 1400px; }
 h1 { font-size: 18px; margin: 0 0 4px; }
 h2 { font-size: 15px; margin: 28px 0 8px; border-bottom: 1px solid #8884; padding-bottom: 4px; }
 h4 { font-size: 12px; margin: 12px 0 4px; opacity: .7; }
 .sub { opacity: .65; margin: 0 0 20px; }
 .banner { padding: 8px 12px; border-left: 3px solid; margin: 0 0 20px; }
 .banner.written { border-color: #3a7; background: #3a71a; }
 .banner.dry { border-color: #999; background: #9991a; }
 .cards { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
 .card { border: 1px solid #8884; padding: 10px 14px; min-width: 130px; }
 .card b { display: block; font-size: 20px; }
 .card span { opacity: .65; font-size: 11px; }
 table { border-collapse: collapse; width: 100%; font-size: 12px; }
 th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #8883; vertical-align: top; }
 th { position: sticky; top: 0; background: Canvas; }
 .num { text-align: right; white-space: nowrap; }
 .saved { color: #c33; }
 .id { opacity: .6; }
 .args, .preview { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
 .preview { opacity: .6; }
 .bar { letter-spacing: -1px; opacity: .55; }
 .mark { font-style: normal; color: #e81; }
 tr.drop_call { background: #c3312; }
 tr.drop_result { background: #e913; }
 tr.keep { background: #3a712; }
 .action { white-space: nowrap; }
 pre { background: #8881; padding: 10px; overflow: auto; max-height: 420px; font-size: 11px; }
 details.req { border: 1px solid #8884; margin-bottom: 8px; padding: 6px 10px; }
 details.req.bad { border-color: #c33; }
 summary { cursor: pointer; }
 .err { color: #c33; }
 .goal { background: #8881; padding: 10px; white-space: pre-wrap; }
 .lists { display: flex; gap: 32px; flex-wrap: wrap; }
 ul { margin: 4px 0; padding-left: 20px; }
 input[type=search] { padding: 4px 8px; margin-bottom: 8px; width: 260px; }
</style></head><body>

<h1>pi-jev-compact report</h1>
<p class="sub">${escape(new Date().toISOString())} · threshold ${settings.keepThreshold} · ${input.written ? "changes were written to a new session" : "nothing was written"}</p>

<div class="banner ${input.written ? "written" : "dry"}">
${
  input.written
    ? "A new session file was written. The previous session file was not modified."
    : "Report only. No session file was created or modified."
}
</div>

<div class="cards">
<div class="card"><b>${trace.length}</b><span>requests sent</span></div>
<div class="card"><b>${stats.inputTokens ?? 0}</b><span>input tokens</span></div>
<div class="card"><b>${stats.outputTokens ?? 0}</b><span>output tokens</span></div>
<div class="card"><b>${stats.elapsedMs ?? 0} ms</b><span>scoring time</span></div>
<div class="card"><b>${scored.length}</b><span>calls scored</span></div>
<div class="card"><b>${droppedChars.toLocaleString()}</b><span>chars removed</span></div>
</div>

<h2>Request and response bodies</h2>
<p class="sub">Exactly what was sent and received. The API key travels in a header and is not recorded here. Tool output is replaced by a note before sending, so the bodies below are what Jev actually saw.</p>
${requests || "<p>No request was sent.</p>"}

<h2>Goal sent to Jev</h2>
<div class="goal">${escape(goal || "(empty — Jev had no task description to judge against)")}</div>

<h2>State sample</h2>
<p class="sub">The first part of the <code>history</code> Jev received, after fitting.</p>
<pre>${escape(input.stateSample)}</pre>

<h2>Decisions</h2>
<p class="sub">Orange tick marks the ${settings.keepThreshold} threshold. Rows are red when the call and its result were removed, yellow when only the result was truncated, green when both were kept.</p>
<input type="search" id="f" placeholder="filter by tool or argument…">
<table id="t"><thead><tr>
<th>id</th><th>tool</th><th>arguments</th><th>result chars</th><th>saved</th>
<th>keepCall</th><th>keepResult</th><th>outcome</th><th>result preview</th>
</tr></thead><tbody>
${rows || "<tr><td colspan=9>No calls were scored.</td></tr>"}
</tbody></table>

${textRows ? `<h2>Assistant prose</h2>
<p class="sub">Prose is opt-in and uses a stricter threshold (${settings.textKeepThreshold}) than tool calls (${settings.keepThreshold}), because a dropped tool result can be recovered by running the tool again and dropped reasoning cannot.</p>
<table><thead><tr><th>id</th><th>message</th><th>chars</th><th>saved</th><th>keepText</th><th>outcome</th><th>preview</th></tr></thead><tbody>
${textRows}
</tbody></table>` : ""}

<h2>Extremes</h2>
<div class="lists">
<div><h4>Most worth keeping</h4><ul>${extremes(highest) || "<li>none</li>"}</ul></div>
<div><h4>Least worth keeping</h4><ul>${extremes(lowest) || "<li>none</li>"}</ul></div>
</div>

<h2>Run statistics</h2>
<table>${statRows}</table>

<script>
const f = document.getElementById("f");
f.addEventListener("input", () => {
  const q = f.value.toLowerCase();
  for (const row of document.querySelectorAll("#t tbody tr")) {
    row.style.display = row.textContent.toLowerCase().includes(q) ? "" : "none";
  }
});
</script>
</body></html>`;
}
