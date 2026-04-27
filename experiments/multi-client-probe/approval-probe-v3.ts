#!/usr/bin/env bun
/**
 * Round-3 approval probe — uses commands that should genuinely require
 * approval to settle research §2.8 open questions.
 *
 * Tries multiple forcing prompts in order until one triggers a
 * serverRequest. Then runs:
 *
 *   T1  who receives the serverRequest? originator only? both?
 *   T2  does serverRequest/resolved fan out to both clients after a respond?
 *   T3  if both clients respond simultaneously, what happens to the loser?
 */

import { spawn } from "bun";

const PORT = Number(process.env.WS_PORT ?? 9883);
const URL = `ws://127.0.0.1:${PORT}`;

const srv = spawn({
  cmd: [
    "codex", "app-server",
    // belt-and-suspenders policy override
    "-c", 'approval_policy="untrusted"',
    "-c", 'sandbox_mode="read-only"',
    "--listen", `ws://127.0.0.1:${PORT}`,
  ],
  stdout: "pipe",
  stderr: "pipe",
});

(async () => {
  const r = srv.stderr.getReader();
  const dec = new TextDecoder();
  while (true) {
    const { value, done } = await r.read();
    if (done) break;
    const t = dec.decode(value).trimEnd();
    if (t) console.log(`[srv stderr] ${t}`);
  }
})();

async function waitListen() {
  for (let i = 0; i < 60; i++) {
    try {
      const s = await Bun.connect({ hostname: "127.0.0.1", port: PORT, socket: { data() {}, close() {}, error() {}, open() {} } });
      s.end();
      return;
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error("listen timeout");
}
await waitListen();
console.log("[probe] app-server listening");

class WsClient {
  ws: WebSocket;
  tag: string;
  nextId = 0;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  events: { method: string; params: any; ts: number }[] = [];
  serverRequests: { id: number; method: string; params: any; ts: number }[] = [];
  responses: { id: number; ok: boolean; payload: any; ts: number }[] = [];

  constructor(tag: string) {
    this.tag = tag;
    this.ws = new WebSocket(URL);
    this.ws.addEventListener("message", (e) => this.onMessage(e.data as string));
  }
  ready(): Promise<void> {
    return new Promise((res, rej) => {
      this.ws.addEventListener("open", () => res(), { once: true });
      this.ws.addEventListener("error", (e) => rej(new Error(String(e))), { once: true });
    });
  }
  onMessage(raw: string) {
    let m: any; try { m = JSON.parse(raw); } catch { return; }
    if (typeof m.id === "number" && (m.result !== undefined || m.error !== undefined) && !m.method) {
      const p = this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
      return;
    }
    if (typeof m.id === "number" && typeof m.method === "string") {
      console.log(`[${this.tag}] <REQ ${m.method} id=${m.id}> ${trunc(JSON.stringify(m.params), 220)}`);
      this.serverRequests.push({ id: m.id, method: m.method, params: m.params, ts: Date.now() });
      return;
    }
    if (typeof m.method === "string") {
      console.log(`[${this.tag}] <NTF ${m.method}> ${trunc(JSON.stringify(m.params), 140)}`);
      this.events.push({ method: m.method, params: m.params, ts: Date.now() });
    }
  }
  request<T = any>(m: string, p: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      console.log(`[${this.tag}] >REQ ${m} id=${id}`);
      this.ws.send(JSON.stringify({ method: m, params: p ?? null, id }));
    });
  }
  notify(m: string, p: unknown) {
    console.log(`[${this.tag}] >NTF ${m}`);
    this.ws.send(JSON.stringify({ method: m, params: p ?? null }));
  }
  // For server-initiated requests we craft a raw response. Track whether
  // the app-server then sends us an error (e.g. "request not found" for
  // late respondents).
  respondRaw(id: number, result: unknown) {
    console.log(`[${this.tag}] >RES id=${id} ${trunc(JSON.stringify(result), 80)}`);
    this.ws.send(JSON.stringify({ id, result }));
  }
  hasEvent(m: string, since = 0) { return this.events.some((e) => e.method === m && e.ts >= since); }
  countEvents(m: string, since = 0) { return this.events.filter((e) => e.method === m && e.ts >= since).length; }
  clear() { this.events = []; this.serverRequests = []; this.responses = []; }
}
function trunc(s: string, n: number) { return s.length > n ? s.slice(0, n) + "…" : s; }
function section(t: string) {
  console.log("\n" + "═".repeat(72));
  console.log("  " + t);
  console.log("═".repeat(72));
}

const FORCING_PROMPTS = [
  // Each tries to do something the read-only sandbox should block.
  "Use the shell tool to run: `mkdir -p /private/tmp/codex-probe-marker-$RANDOM`. It must be a tool call, not just text.",
  "Use the shell tool to run: `touch /private/tmp/codex-probe-$(date +%s).txt`. Tool call only.",
  "Use the shell tool to run: `curl -s -o /dev/null https://example.com`. Tool call only.",
  "Use the shell tool to write to a file outside the workspace via: `echo hi > /private/tmp/codex-probe.txt`. Tool call only.",
];

async function waitFor(cond: () => boolean, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await Bun.sleep(80);
  }
  return false;
}

let A: WsClient; let B: WsClient; let threadId = "";
try {
  A = new WsClient("A");
  B = new WsClient("B");
  await Promise.all([A.ready(), B.ready()]);
  for (const c of [A, B]) {
    await c.request("initialize", {
      clientInfo: { name: `probev3_${c.tag}`, title: c.tag, version: "0.0.1" },
      capabilities: { experimentalApi: true },
    });
    c.notify("initialized", null);
  }

  section("create + warm up");
  const start: any = await A.request("thread/start", {
    cwd: process.cwd(),
    approvalPolicy: "untrusted",
    sandboxPolicy: { type: "readOnly" },
  });
  threadId = start.thread.id;
  console.log("threadId =", threadId);
  console.log("policy =", start.approvalPolicy, "sandbox =", JSON.stringify(start.sandbox));

  // warm-up turn
  {
    A.clear();
    const t = Date.now();
    await A.request("turn/start", { threadId, input: [{ type: "text", text: "Reply 'ok'." }] });
    await waitFor(() => A.hasEvent("turn/completed", t));
  }
  await B.request("thread/resume", { threadId });
  console.log("B resumed.");

  // ──────────  T1: try to force an approval  ──────────
  section("T1: forcing prompts until approval fires");
  let approval: { id: number; method: string; params: any; ts: number } | null = null;
  let usedPrompt = "";
  for (const prompt of FORCING_PROMPTS) {
    A.clear(); B.clear();
    const t = Date.now();
    try {
      await A.request("turn/start", { threadId, input: [{ type: "text", text: prompt }] });
    } catch (err: any) {
      console.log(`[T1] turn/start rejected: ${err.message} — trying next prompt`);
      continue;
    }
    await waitFor(() => A.serverRequests.length > 0 || B.serverRequests.length > 0 || A.hasEvent("turn/completed", t) || B.hasEvent("turn/completed", t), 60000);
    if (A.serverRequests.length > 0 || B.serverRequests.length > 0) {
      approval = (B.serverRequests[0] ?? A.serverRequests[0])!;
      usedPrompt = prompt;
      break;
    }
    console.log(`[T1] prompt completed without approval — trying next`);
  }

  if (!approval) {
    console.log("[T1] never triggered an approval after trying all prompts. Dumping last A events:");
    for (const e of A.events.slice(-15)) console.log(`     A: ${e.method}`);
    throw new Error("could not force an approval — investigate sandbox/policy semantics");
  }
  console.log(`[T1] approval fired with prompt: ${usedPrompt.slice(0, 80)}…`);
  console.log(`[T1] approval seen by A=${A.serverRequests.length > 0} B=${B.serverRequests.length > 0}`);
  console.log(`[T1] approval method=${approval.method} id=${approval.id}`);
  console.log(`[T1] params=${trunc(JSON.stringify(approval.params), 300)}`);
  // Decision A:
  //   - if BOTH got it → confirms broadcast model
  //   - if only A got it (originator) → confirms originator-only routing
  //   - if only B got it → surprising, requires investigation

  // ──────────  T2: declarative respond, watch fan-out  ──────────
  section("T2: B responds; does serverRequest/resolved fan out to both?");
  const t2 = Date.now();
  B.respondRaw(approval.id, { decision: "decline" });  // decline so it doesn't actually run
  await waitFor(() =>
    A.hasEvent("serverRequest/resolved", t2) ||
    B.hasEvent("serverRequest/resolved", t2) ||
    A.hasEvent("turn/completed", t2) ||
    B.hasEvent("turn/completed", t2),
    30000);
  console.log(`[T2] A got serverRequest/resolved: ${A.hasEvent("serverRequest/resolved", t2)}`);
  console.log(`[T2] B got serverRequest/resolved: ${B.hasEvent("serverRequest/resolved", t2)}`);

  // wait turn end
  await waitFor(() => A.hasEvent("turn/completed", t2) || B.hasEvent("turn/completed", t2), 60000);

  // ──────────  T3: race two responses  ──────────
  section("T3: trigger another approval, race A.decline and B.accept");
  let approval2: typeof approval | null = null;
  for (const prompt of [usedPrompt, ...FORCING_PROMPTS]) {
    A.clear(); B.clear();
    const t = Date.now();
    try {
      await A.request("turn/start", { threadId, input: [{ type: "text", text: prompt }] });
    } catch (err: any) { continue; }
    await waitFor(() => A.serverRequests.length > 0 || B.serverRequests.length > 0 || A.hasEvent("turn/completed", t), 60000);
    if (A.serverRequests.length > 0 || B.serverRequests.length > 0) {
      approval2 = (A.serverRequests[0] ?? B.serverRequests[0])!;
      break;
    }
  }
  if (!approval2) {
    console.log("[T3] couldn't trigger second approval — skipping race");
  } else {
    const id = approval2.id;
    const t3 = Date.now();
    console.log(`[T3] firing A.respond(decline) and B.respond(accept) on id=${id}`);
    A.respondRaw(id, { decision: "decline" });
    B.respondRaw(id, { decision: "accept" });
    await Bun.sleep(8000);
    console.log(`[T3] A serverRequest/resolved: ${A.hasEvent("serverRequest/resolved", t3)}`);
    console.log(`[T3] B serverRequest/resolved: ${B.hasEvent("serverRequest/resolved", t3)}`);
    // look for any error responses or warnings from server
    const warns = [...A.events, ...B.events].filter((e) => e.method === "warning" || e.method === "configWarning");
    console.log(`[T3] warnings: ${JSON.stringify(warns.map((w) => w.params))}`);
    // command final status (was it run or declined?)
    const cmdEv = A.events.find((e) => e.method === "item/completed" && e.params?.item?.type === "commandExecution");
    if (cmdEv) console.log(`[T3] command final status: ${cmdEv.params.item.status}`);
    // turn end
    await waitFor(() => A.hasEvent("turn/completed", t3) || B.hasEvent("turn/completed", t3), 60000);
  }
} catch (err) {
  console.error("[probe] error:", err);
} finally {
  try { A?.ws.close(); } catch {}
  try { B?.ws.close(); } catch {}
  await Bun.sleep(500);
  srv.kill();
  await Promise.race([srv.exited, Bun.sleep(2000)]);
  process.exit(0);
}
