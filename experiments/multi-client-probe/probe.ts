#!/usr/bin/env bun
/**
 * Probe codex app-server's WebSocket multi-client semantics.
 *
 * Spawns:   codex app-server --listen ws://127.0.0.1:9877
 * Connects: client A + client B as separate WebSocket clients.
 *
 * Tests, in order:
 *   T1  both initialize + thread/list — do they see the same world?
 *   T2  A creates thread X. Does B receive any notification automatically,
 *       or must B call thread/list again to see X?
 *   T3  A turn/start on X. Does B receive the streaming deltas
 *       *without* having called thread/resume?
 *   T4  B calls thread/resume(X). Does B now receive subsequent events?
 *   T5  After T4, A sends another turn/start on X. Who receives
 *       serverRequest for tool approval (if codex picks one)?
 *   T6  Both subscribed to X. A turn/start in flight. B sends turn/start
 *       on the same X — error or queue?
 *
 * Each event is tagged with [A] or [B] in the log so it's easy to
 * eyeball who got what.
 */

import { spawn } from "bun";

const PORT = Number(process.env.WS_PORT ?? 9877);
const URL = `ws://127.0.0.1:${PORT}`;

// ────────────────────────────────────────────────────────────────────────────
// Spawn app-server
// ────────────────────────────────────────────────────────────────────────────
console.log(`[probe] starting codex app-server on ${URL}`);
const srv = spawn({
  cmd: ["codex", "app-server", "--listen", `ws://127.0.0.1:${PORT}`],
  stdout: "pipe",
  stderr: "pipe",
});

const srvErr = (async () => {
  const r = srv.stderr.getReader();
  const dec = new TextDecoder();
  while (true) {
    const { value, done } = await r.read();
    if (done) break;
    const t = dec.decode(value).trimEnd();
    if (t) console.log(`[srv stderr] ${t}`);
  }
})();
const srvOut = (async () => {
  const r = srv.stdout.getReader();
  const dec = new TextDecoder();
  while (true) {
    const { value, done } = await r.read();
    if (done) break;
    const t = dec.decode(value).trimEnd();
    if (t) console.log(`[srv stdout] ${t}`);
  }
})();

// Wait for the WS listener to come up
async function waitListen() {
  for (let i = 0; i < 60; i++) {
    try {
      const sock = await Bun.connect({ hostname: "127.0.0.1", port: PORT, socket: { data() {}, close() {}, error() {}, open() {} } });
      sock.end();
      return;
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error("app-server did not start listening in time");
}
await waitListen();
console.log("[probe] app-server listening");

// ────────────────────────────────────────────────────────────────────────────
// Tiny JSON-RPC client over WS
// ────────────────────────────────────────────────────────────────────────────
class WsClient {
  ws: WebSocket;
  tag: string;
  nextId = 0;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  events: { method: string; params: any; ts: number }[] = [];
  serverRequests: { id: number; method: string; params: any }[] = [];

  constructor(tag: string) {
    this.tag = tag;
    this.ws = new WebSocket(URL);
    this.ws.addEventListener("message", (e) => this.onMessage(e.data as string));
    this.ws.addEventListener("close", () => console.log(`[${tag}] CLOSE`));
    this.ws.addEventListener("error", (e) => console.log(`[${tag}] ERROR`, e));
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
    // response
    if (typeof m.id === "number" && (m.result !== undefined || m.error !== undefined) && !m.method) {
      const p = this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error)));
        else p.resolve(m.result);
      }
      return;
    }
    // server-initiated request
    if (typeof m.id === "number" && typeof m.method === "string") {
      console.log(`[${this.tag}] <REQ ${m.method} id=${m.id}> ${truncate(JSON.stringify(m.params), 160)}`);
      this.serverRequests.push({ id: m.id, method: m.method, params: m.params });
      return;
    }
    // notification
    if (typeof m.method === "string") {
      console.log(`[${this.tag}] <NTF ${m.method}> ${truncate(JSON.stringify(m.params), 160)}`);
      this.events.push({ method: m.method, params: m.params, ts: Date.now() });
    }
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const frame = JSON.stringify({ method, params: params ?? null, id });
      console.log(`[${this.tag}] >REQ ${method} id=${id}`);
      this.ws.send(frame);
    });
  }

  notify(method: string, params: unknown) {
    const frame = JSON.stringify({ method, params: params ?? null });
    console.log(`[${this.tag}] >NTF ${method}`);
    this.ws.send(frame);
  }

  respond(id: number, result: unknown) {
    const frame = JSON.stringify({ id, result });
    console.log(`[${this.tag}] >RES id=${id}`);
    this.ws.send(frame);
  }

  countEvents(method: string, sinceTs = 0): number {
    return this.events.filter((e) => e.method === method && e.ts >= sinceTs).length;
  }

  hasEvent(method: string, sinceTs = 0): boolean {
    return this.countEvents(method, sinceTs) > 0;
  }

  clearEvents() {
    this.events = [];
    this.serverRequests = [];
  }
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ────────────────────────────────────────────────────────────────────────────
// Test runner
// ────────────────────────────────────────────────────────────────────────────
async function section(title: string) {
  console.log("\n" + "═".repeat(72));
  console.log("  " + title);
  console.log("═".repeat(72));
}

async function pause(ms: number, why: string) {
  console.log(`[probe] sleeping ${ms}ms (${why})`);
  await Bun.sleep(ms);
}

let A: WsClient;
let B: WsClient;
let threadId = "";

try {
  // ──────────  setup  ──────────
  await section("setup: connect A and B, initialize both");
  A = new WsClient("A");
  B = new WsClient("B");
  await Promise.all([A.ready(), B.ready()]);

  for (const c of [A, B]) {
    const initRes = await c.request("initialize", {
      clientInfo: { name: `probe_${c.tag}`, title: `Probe ${c.tag}`, version: "0.0.1" },
      capabilities: { experimentalApi: true },
    });
    console.log(`[${c.tag}] init userAgent=${initRes.userAgent}`);
    c.notify("initialized", null);
  }

  // ──────────  T1: thread/list parity  ──────────
  await section("T1: both call thread/list, do they see the same world?");
  const aList: any = await A.request("thread/list", {});
  const bList: any = await B.request("thread/list", {});
  const aIds = (aList.threads ?? []).map((t: any) => t.id).sort();
  const bIds = (bList.threads ?? []).map((t: any) => t.id).sort();
  console.log(`[A] threads: ${aIds.length}`);
  console.log(`[B] threads: ${bIds.length}`);
  console.log(`[T1] same set of ids? ${JSON.stringify(aIds) === JSON.stringify(bIds)}`);

  // ──────────  T2: A creates thread, does B get notified?  ──────────
  await section("T2: A creates a thread. Does B receive thread/started without resume?");
  const t2Sentinel = Date.now();
  A.clearEvents();
  B.clearEvents();
  const startRes: any = await A.request("thread/start", {
    cwd: process.cwd(),
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "workspaceWrite" },
  });
  threadId = startRes.thread.id;
  console.log(`[probe] new threadId = ${threadId}`);

  await pause(2000, "let any push notifications arrive");
  const aGotStarted = A.hasEvent("thread/started", t2Sentinel);
  const bGotStarted = B.hasEvent("thread/started", t2Sentinel);
  console.log(`[T2] A received thread/started: ${aGotStarted}`);
  console.log(`[T2] B received thread/started: ${bGotStarted}  ← key question`);
  // also re-list from B to confirm visibility
  const bList2: any = await B.request("thread/list", {});
  const bSeesNew = (bList2.threads ?? []).some((t: any) => t.id === threadId);
  console.log(`[T2] B's thread/list now contains new id: ${bSeesNew}`);

  // ──────────  T3: A turn/start. Does B receive deltas?  ──────────
  await section("T3: A starts a turn on its own thread. Does B see deltas without resume?");
  const t3Sentinel = Date.now();
  A.clearEvents();
  B.clearEvents();
  const turnRes: any = await A.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Reply with exactly the word: hello" }],
  });
  console.log(`[probe] turnId = ${turnRes.turn?.id}`);

  // wait for turn to complete on A side, then check B
  const t3Start = Date.now();
  while (!A.hasEvent("turn/completed", t3Sentinel) && Date.now() - t3Start < 60000) {
    await Bun.sleep(100);
  }
  console.log(`[T3] A turn/completed seen: ${A.hasEvent("turn/completed", t3Sentinel)}`);
  console.log(`[T3] A item/agentMessage/delta count: ${A.countEvents("item/agentMessage/delta", t3Sentinel)}`);
  console.log(`[T3] B turn/started count: ${B.countEvents("turn/started", t3Sentinel)}  ← key`);
  console.log(`[T3] B item/agentMessage/delta count: ${B.countEvents("item/agentMessage/delta", t3Sentinel)}  ← key`);
  console.log(`[T3] B turn/completed count: ${B.countEvents("turn/completed", t3Sentinel)}`);

  // ──────────  T4: B resumes the same thread  ──────────
  await section("T4: B calls thread/resume on the same threadId");
  let resumeRes: any = null;
  let resumeErr: string | null = null;
  try {
    resumeRes = await B.request("thread/resume", { threadId });
  } catch (err: any) {
    resumeErr = err.message;
  }
  if (resumeErr) {
    console.log(`[T4] B thread/resume FAILED: ${resumeErr}`);
    // try alternate APIs
    try {
      const r: any = await B.request("thread/read", { threadId });
      console.log(`[T4] B thread/read ok, turns=${(r.turns ?? r.thread?.turns ?? []).length}`);
    } catch (err: any) {
      console.log(`[T4] B thread/read FAILED: ${err.message}`);
    }
  } else {
    console.log(`[T4] B thread/resume ok keys=${Object.keys(resumeRes).join(",")}`);
  }

  // ──────────  T5: After T4, A sends another turn. Does B see it?  ──────────
  await section("T5: A sends another turn on X. With B resumed, does B see deltas?");
  const t5Sentinel = Date.now();
  A.clearEvents();
  B.clearEvents();
  await A.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Now reply with exactly the word: world" }],
  });
  const t5Start = Date.now();
  while (!A.hasEvent("turn/completed", t5Sentinel) && Date.now() - t5Start < 60000) {
    await Bun.sleep(100);
  }
  console.log(`[T5] A item/agentMessage/delta: ${A.countEvents("item/agentMessage/delta", t5Sentinel)}`);
  console.log(`[T5] B item/agentMessage/delta: ${B.countEvents("item/agentMessage/delta", t5Sentinel)}  ← key`);
  console.log(`[T5] B turn/started: ${B.countEvents("turn/started", t5Sentinel)}`);
  console.log(`[T5] B turn/completed: ${B.countEvents("turn/completed", t5Sentinel)}`);

  // ──────────  T6: simultaneous turn/start race  ──────────
  await section("T6: while a turn is in flight, the other client also calls turn/start");
  A.clearEvents();
  B.clearEvents();
  // long-running prompt so we have time to race
  const aPromise = A.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Count slowly from 1 to 30, one per line." }],
  });
  // brief delay to ensure A's turn is in flight server-side
  await Bun.sleep(300);
  let bResult: any = null;
  let bError: string | null = null;
  try {
    bResult = await B.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Interrupt: just say 'INTERRUPTED'." }],
    });
  } catch (err: any) {
    bError = err.message;
  }
  console.log(`[T6] B turn/start result: ${bResult ? "OK " + JSON.stringify(bResult).slice(0, 120) : "ERROR " + bError}`);
  // interrupt A so we don't wait 60s
  try {
    const aTurn: any = await aPromise;
    await A.request("turn/interrupt", { threadId, turnId: aTurn.turn?.id });
  } catch {}

  // ──────────  done  ──────────
  await section("done");
  console.log("[probe] all tests complete");
} catch (err) {
  console.error("[probe] FATAL", err);
} finally {
  // best-effort cleanup
  try { A?.ws.close(); } catch {}
  try { B?.ws.close(); } catch {}
  await Bun.sleep(500);
  srv.kill();
  await Promise.race([srv.exited, Bun.sleep(2000)]);
  process.exit(0);
}
