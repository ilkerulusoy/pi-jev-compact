import assert from "node:assert/strict";
import { test } from "node:test";
import { registerJevCompactCommand } from "../src/commands/jev-compact";

/**
 * Drives the registered command end to end with a stub UI, a stub session, and a
 * stub transport. No network, no real session file, no writes to disk.
 */

const user = (id: string, text: string) => ({
  id,
  type: "message",
  message: { role: "user", content: [{ type: "text", text }] },
});
const assistant = (id: string, text: string, callId: string) => ({
  id,
  type: "message",
  message: {
    role: "assistant",
    content: [
      { type: "text", text },
      { type: "toolCall", id: callId, name: "read", arguments: { path: "a.ts" } },
    ],
  },
});
const result = (id: string, callId: string, body: string) => ({
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

/**
 * A branch long enough that the three scored calls sit outside the default
 * `preserveRecentMessages` window of 6. The trailing filler is what keeps tc_1,
 * tc_2, and tc_3 unpinned, exactly as in a real session.
 */
const branch = () => [
  user("e1", "fix the failing test"),
  assistant("e2", "step 1", "tc_1"),
  result("e3", "tc_1", "A".repeat(3000)),
  assistant("e4", "step 2", "tc_2"),
  result("e5", "tc_2", "B".repeat(3000)),
  assistant("e6", "step 3", "tc_3"),
  result("e7", "tc_3", "C".repeat(3000)),
  user("e8", "now what"),
  ...Array.from({ length: 6 }, (_, i) => user(`f${i}`, `later turn ${i}`)),
];

interface Harness {
  notes: string[];
  logs: string[];
  confirmations: { title: string; body: string }[];
  appended: any[][];
  newSessionCalls: number;
  run: (args?: string) => Promise<void>;
}

const harness = (options: {
  answers: Record<string, [number, number]>;
  confirm?: boolean;
  branchEntries?: any[];
  cancelled?: boolean;
  httpStatus?: number;
}): Harness => {
  const registered: any[] = [];
  registerJevCompactCommand({
    registerCommand: (name: string, def: any) => registered.push({ name, ...def }),
  });

  const h: Harness = {
    notes: [],
    logs: [],
    confirmations: [],
    appended: [],
    newSessionCalls: 0,
    run: async (args = "") => {
      await registered[0].handler(args, {
        ui: {
          notify: (m: string, level: string) => h.notes.push(`[${level}] ${m}`),
          log: (m: string) => h.logs.push(m),
          confirm: async (title: string, body: string) => {
            h.confirmations.push({ title, body });
            return options.confirm !== false;
          },
        },
        sessionManager: {
          buildContextEntries: () => options.branchEntries ?? branch(),
        },
        newSession: async ({ setup }: any) => {
          h.newSessionCalls++;
          const written: any[] = [];
          await setup({ appendMessage: (m: any) => written.push(m) });
          h.appended.push(written);
          return { cancelled: options.cancelled === true };
        },
      });
    },
  };

  // Stub the transport so the real JevClient code path runs without network.
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    const answers: Record<string, { noul: number }> = {};
    for (const name of Object.keys(body.questions)) {
      const [kind, short] = name.split("_");
      const pair = options.answers[short!]!;
      answers[name] = { noul: kind === "call" ? pair[0] : pair[1] };
    }
    const status = options.httpStatus ?? 200;
    return {
      status,
      ok: status < 400,
      text: async () => JSON.stringify({ model: "jev-test", answers }),
    };
  }) as any;

  return h;
};

const withKey = async (fn: () => Promise<void>) => {
  const saved = process.env.TYPESAFE_API_KEY;
  const savedFetch = globalThis.fetch;
  process.env.TYPESAFE_API_KEY = "test-key";
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = saved;
    globalThis.fetch = savedFetch;
  }
};

test("the full command path writes a pruned session after confirmation", async () => {
  await withKey(async () => {
    const h = harness({ answers: { t1: [0.9, 0.9], t2: [0.1, 0.1], t3: [0.9, 0.1] } });
    await h.run();

    assert.equal(h.confirmations.length, 1, "the user is asked before anything is written");
    assert.match(h.confirmations[0]!.body, /current session file is not modified/);
    assert.equal(h.newSessionCalls, 1);

    const written = h.appended[0]!;
    const callIds = written
      .filter((m) => m.role === "assistant")
      .flatMap((m: any) => m.content.filter((c: any) => c.type === "toolCall").map((c: any) => c.id));
    const resultIds = written.filter((m) => m.role === "toolResult").map((m: any) => m.toolCallId);
    assert.deepEqual(callIds, ["tc_1", "tc_3"], "selective removal reached the session writer");
    assert.deepEqual(resultIds, ["tc_1", "tc_3"]);

    // Pi's ExtensionUIContext has no log method, so the per-call detail goes to an
    // HTML report and the notification carries its path.
    assert.ok(h.notes.some((n) => n.includes("wrote a compacted session")));
    assert.ok(
      h.notes.some((n) => n.includes("Report:") && n.includes(".html")),
      "the report path is shown so the decisions can be inspected",
    );
    assert.ok(h.notes.some((n) => n.includes("request(s) sent")), "request count is stated");
  });
});

test("declining the confirmation writes nothing", async () => {
  await withKey(async () => {
    const h = harness({ answers: { t1: [0.9, 0.9], t2: [0.1, 0.1], t3: [0.9, 0.1] }, confirm: false });
    await h.run();
    assert.equal(h.newSessionCalls, 0);
    assert.ok(h.notes.some((n) => n.includes("cancelled, nothing written")));
  });
});

test("report mode never asks and never writes", async () => {
  await withKey(async () => {
    const h = harness({ answers: { t1: [0.9, 0.9], t2: [0.1, 0.1], t3: [0.9, 0.1] } });
    await h.run("report");
    assert.equal(h.confirmations.length, 0);
    assert.equal(h.newSessionCalls, 0);
    assert.ok(h.notes.some((n) => n.includes("Nothing written")));
    assert.ok(
      h.notes.some((n) => n.includes("Report:") && n.includes(".html")),
      "report mode still produces an inspectable report",
    );
  });
});

test("an HTTP failure reports an error and writes nothing", async () => {
  await withKey(async () => {
    const h = harness({ answers: { t1: [1, 1], t2: [1, 1], t3: [1, 1] }, httpStatus: 503 });
    await h.run();
    assert.equal(h.newSessionCalls, 0);
    assert.ok(h.notes.some((n) => n.includes("[error]") && n.includes("503")));
  });
});

test("a cancelled new session is reported as such", async () => {
  await withKey(async () => {
    const h = harness({
      answers: { t1: [0.9, 0.9], t2: [0.1, 0.1], t3: [0.9, 0.1] },
      cancelled: true,
    });
    await h.run();
    assert.equal(h.newSessionCalls, 1);
    assert.ok(h.notes.some((n) => n.includes("[warning]") && n.includes("cancelled")));
  });
});

test("without a key nothing is sent and nothing is written", async () => {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const h = harness({ answers: {} });
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error("must not be called");
    }) as any;
    await h.run();
    assert.equal(fetched, false);
    assert.equal(h.newSessionCalls, 0);
    assert.ok(h.notes.some((n) => n.includes("TYPESAFE_API_KEY is not set")));
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  }
});
