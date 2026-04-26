#!/usr/bin/env bun
/**
 * Round-2 probe: approval routing + thread/loaded/list.
 *
 * Tests:
 *   T1  thread/loaded/list before/after thread/start — does it surface
 *       a freshly-created thread that thread/list misses?
 *   T2  A creates thread, both A and B resume it. A sends a prompt
 *       that forces bash (sandbox=read-only + approvalPolicy=on-request
 *       so that any write/exec triggers approval).
 *       Question: who receives the serverRequest? A only? Both?
 *   T3  Whoever does NOT trigger the turn tries to respond first.
 *       Question: does codex accept it?
 *   T4  After respond, who receives serverRequest/resolved?
 *   T5  Two clients respond to the SAME serverRequest id with different
 *       decisions. Who wins / what error?
 */

import { spawn } from "bun";

const PORT = Number(process.env.WS_PORT ?? 9878);
const URL = `ws://127.0.0.1:${PORT}`;

const srv = spawn({
  cmd: ["codex", "app-server", "--listen", `ws://127.0.0.1:${PORT}`],
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
      const sock = await Bun.connect({ hostname: "127.0.0.1", port: PORT, socket: { data() {}, close() {}, error() {}, open() {} } });
      sock.end();
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
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    if (typeof m.id === "number" && (m.result !== undefined || m.error !== undefined) && !m.method) {
      const p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
      return;
    }
    if (typeof m.id === "number" && typeof m.method === "string") {
      console.log(`[${this.tag}] <REQ ${m.method} id=${m.id}> ${truncate(JSON.stringify(m.params), 200)}`);
      this.serverRequests.push({ id: m.id, method: m.method, params: m.params, ts: Date.now() });
      return;
    }
    if (typeof m.method === "string") {
      console.log(`[${this.tag}] <NTF ${m.method}> ${truncate(JSON.stringify(m.params), 160)}`);
      this.events.push({ method: m.method, params: m.params, ts: Date.now() });
    }
  }
  request<T = any>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      console.log(`[${this.tag}] >REQ ${method} id=${id}`);
      this.ws.send(JSON.stringify({ method, params: params ?? null, id }));
    });
  }
  notify(method: string, params: unknown) {
    console.log(`[${this.tag}] >NTF ${method}`);
    this.ws.send(JSON.stringify({ method, params: params ?? null }));
  }
  respond(id: number, result: unknown) {
    console.log(`[${this.tag}] >RES id=${id} ${truncate(JSON.stringify(result), 80)}`);
    this.ws.send(JSON.stringify({ id, result }));
  }
  respondError(id: number, code: number, message: string) {
    console.log(`[${this.tag}] >RES_ERR id=${id} ${message}`);
    this.ws.send(JSON.stringify({ id, error: { code, message } }));
  }
  hasEvent(method: string, since = 0) { return this.events.some((e) => e.method === method && e.ts >= since); }
  countEvents(method: string, since = 0) { return this.events.filter((e) => e.method === method && e.ts >= since).length; }
  clear() { this.events = []; this.serverRequests = []; }
}

function truncate(s: string, n: number) { return s.length > n ? s.slice(0, n) + "…" : s; }
function section(t: string) {
  console.log("\n" + "═".repeat(72));
  console.log("  " + t);
  console.log("═".repeat(72));
}

let A: WsClient;
let B: WsClient;
let threadId = "";
try {
  // setup
  section("setup");
  A = new WsClient("A");
  B = new WsClient("B");
  await Promise.all([A.ready(), B.ready()]);
  for (const c of [A, B]) {
    await c.request("initialize", {
      clientInfo: { name: `probe2_${c.tag}`, title: `Probe2 ${c.tag}`, version: "0.0.1" },
      capabilities: { experimentalApi: true },
    });
    c.notify("initialized", null);
  }

  // ──────────  T1: thread/loaded/list  ──────────
  section("T1: thread/loaded/list before vs after thread/start");
  const aLoaded0: any = await A.request("thread/loaded/list", {}).catch((e) => ({ error: e.message }));
  console.log(`[T1] thread/loaded/list pre-create: ${truncate(JSON.stringify(aLoaded0), 200)}`);

  const startRes: any = await A.request("thread/start", {
    cwd: process.cwd(),
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "readOnly" }, // readOnly forces approval for any write/exec
  });
  threadId = startRes.thread.id;
  console.log(`[probe] threadId=${threadId}`);
  await Bun.sleep(500);

  const aLoaded1: any = await A.request("thread/loaded/list", {});
  const bLoaded1: any = await B.request("thread/loaded/list", {});
  const aListAfter: any = await A.request("thread/list", {});
  console.log(`[T1] A thread/loaded/list post-create: ${truncate(JSON.stringify(aLoaded1), 300)}`);
  console.log(`[T1] B thread/loaded/list post-create: ${truncate(JSON.stringify(bLoaded1), 300)}`);
  console.log(`[T1] A thread/list post-create: count=${(aListAfter.threads ?? []).length} contains=${(aListAfter.threads ?? []).some((t: any) => t.id === threadId)}`);

  // ──────────  T1.5: warm up the rollout with a no-tool turn  ──────────
  section("T1.5: warm up rollout (B can't resume a brand-new thread until rollout exists)");
  {
    const sentinel = Date.now();
    A.clear();
    await A.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Reply with one word: ready" }],
    });
    const start = Date.now();
    while (!A.hasEvent("turn/completed", sentinel) && Date.now() - start < 60000) {
      await Bun.sleep(100);
    }
    console.log(`[T1.5] warmup turn completed: ${A.hasEvent("turn/completed", sentinel)}`);
  }

  // ──────────  T2: both resume, A triggers a turn that needs bash  ──────────
  section("T2: both resume, A asks for a bash command (forces approval)");
  try {
    const r = await B.request("thread/resume", { threadId });
    console.log(`[T2] B resume ok`);
  } catch (err: any) {
    console.log(`[T2] B resume STILL failed: ${err.message}`);
  }
  // Send a prompt that forces a tool call
  const t2Sentinel = Date.now();
  A.clear();
  B.clear();
  await A.request("turn/start", {
    threadId,
    input: [{
      type: "text",
      text: "Use the shell tool to run exactly: `echo probe-marker-XYZ`. Do not just say it; you must call the tool.",
    }],
  });

  // wait up to 60s for any approval request to land OR turn to complete
  const t2Start = Date.now();
  while (Date.now() - t2Start < 60000) {
    const anyApproval = A.serverRequests.length > 0 || B.serverRequests.length > 0;
    const turnDone = A.hasEvent("turn/completed", t2Sentinel) || B.hasEvent("turn/completed", t2Sentinel);
    if (anyApproval) break;
    if (turnDone) break;
    await Bun.sleep(100);
  }
  console.log(`[T2] A serverRequests received: ${A.serverRequests.length}`);
  console.log(`[T2] B serverRequests received: ${B.serverRequests.length}`);
  for (const sr of [...A.serverRequests, ...B.serverRequests]) {
    console.log(`     method=${sr.method} id=${sr.id} params.threadId=${sr.params?.threadId}`);
  }

  // ──────────  T3: B (non-creator) tries to respond first  ──────────
  section("T3: B responds to the approval first");
  // Pick the shared approval if any. Both lists may have the same id.
  const approval = B.serverRequests[0] ?? A.serverRequests[0];
  if (!approval) {
    console.log("[T3] no approval arrived — skipping T3-T5");
  } else {
    console.log(`[T3] approval id=${approval.id} method=${approval.method}`);
    const t3Sentinel = Date.now();
    B.respond(approval.id, { decision: "accept" });

    // Watch for serverRequest/resolved + subsequent events
    const waitStart = Date.now();
    while (Date.now() - waitStart < 30000) {
      if (A.hasEvent("serverRequest/resolved", t3Sentinel) || B.hasEvent("serverRequest/resolved", t3Sentinel)) break;
      if (A.hasEvent("turn/completed", t3Sentinel) || B.hasEvent("turn/completed", t3Sentinel)) break;
      await Bun.sleep(100);
    }
    console.log(`[T3/T4] A got serverRequest/resolved: ${A.hasEvent("serverRequest/resolved", t3Sentinel)}`);
    console.log(`[T3/T4] B got serverRequest/resolved: ${B.hasEvent("serverRequest/resolved", t3Sentinel)}`);
    console.log(`[T3] A item/commandExecution/outputDelta count: ${A.countEvents("item/commandExecution/outputDelta", t3Sentinel)}`);
    console.log(`[T3] B item/commandExecution/outputDelta count: ${B.countEvents("item/commandExecution/outputDelta", t3Sentinel)}`);

    // wait for turn to fully finish
    const turnEnd = Date.now();
    while (Date.now() - turnEnd < 30000) {
      if (A.hasEvent("turn/completed", t3Sentinel) || B.hasEvent("turn/completed", t3Sentinel)) break;
      await Bun.sleep(100);
    }
    console.log(`[T3] turn ended on A=${A.hasEvent("turn/completed", t3Sentinel)} B=${B.hasEvent("turn/completed", t3Sentinel)}`);
  }

  // ──────────  T5: race two responses to a NEW approval  ──────────
  section("T5: trigger another approval, A and B respond simultaneously with different decisions");
  const t5Sentinel = Date.now();
  A.clear();
  B.clear();
  await A.request("turn/start", {
    threadId,
    input: [{
      type: "text",
      text: "Run exactly: `echo race-test`. Use the shell tool, do not just print.",
    }],
  });
  // wait for approval
  const t5Start = Date.now();
  while (Date.now() - t5Start < 60000) {
    if (A.serverRequests.length > 0 || B.serverRequests.length > 0) break;
    if (A.hasEvent("turn/completed", t5Sentinel)) break;
    await Bun.sleep(100);
  }
  const a5 = A.serverRequests[0];
  const b5 = B.serverRequests[0];
  if (a5 && b5 && a5.id === b5.id) {
    console.log(`[T5] both saw same approval id=${a5.id}; firing accept(B) and decline(A) ~simultaneously`);
    A.respond(a5.id, { decision: "decline" });
    B.respond(b5.id, { decision: "accept" });
    // observe outcome
    await Bun.sleep(5000);
    console.log(`[T5] A serverRequest/resolved: ${A.hasEvent("serverRequest/resolved", t5Sentinel)}`);
    console.log(`[T5] B serverRequest/resolved: ${B.hasEvent("serverRequest/resolved", t5Sentinel)}`);
    console.log(`[T5] A command outputDelta count: ${A.countEvents("item/commandExecution/outputDelta", t5Sentinel)}`);
    console.log(`[T5] B command outputDelta count: ${B.countEvents("item/commandExecution/outputDelta", t5Sentinel)}`);
    // command status will appear in item/completed
    const aCmd = A.events.find((e) => e.method === "item/completed" && e.params?.item?.type === "commandExecution");
    if (aCmd) console.log(`[T5] command final status (A view): ${aCmd.params?.item?.status}`);
  } else {
    console.log(`[T5] approvals: A=${a5?.id} B=${b5?.id} — race not setup; skipping`);
  }
} catch (err) {
  console.error("[probe] FATAL", err);
} finally {
  try { A?.ws.close(); } catch {}
  try { B?.ws.close(); } catch {}
  await Bun.sleep(500);
  srv.kill();
  await Promise.race([srv.exited, Bun.sleep(2000)]);
  process.exit(0);
}
