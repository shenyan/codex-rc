#!/usr/bin/env bun
/**
 * Approval routing probe — focused. Uses approvalPolicy: "untrusted"
 * which forces approval on (almost) every shell command.
 *
 * T2  who receives serverRequest? A (creator), B (other resumed), both?
 * T3  B (non-creator) responds first — accepted?
 * T4  serverRequest/resolved fanout
 * T5  race: A and B respond simultaneously with different decisions
 */

import { spawn } from "bun";

const PORT = Number(process.env.WS_PORT ?? 9879);
const URL = `ws://127.0.0.1:${PORT}`;

const srv = spawn({
  cmd: [
    "codex", "app-server",
    "-c", 'approval_policy="untrusted"',
    "-c", 'sandbox_mode="read-only"',
    "--listen", `ws://127.0.0.1:${PORT}`,
  ],
  stdout: "pipe",
  stderr: "pipe",
});
(async () => {
  const r = srv.stderr.getReader(); const dec = new TextDecoder();
  while (true) { const { value, done } = await r.read(); if (done) break;
    const t = dec.decode(value).trimEnd(); if (t) console.log(`[srv stderr] ${t}`); }
})();

async function waitListen() {
  for (let i = 0; i < 60; i++) {
    try { const s = await Bun.connect({ hostname: "127.0.0.1", port: PORT, socket: { data() {}, close() {}, error() {}, open() {} } }); s.end(); return; } catch {}
    await Bun.sleep(250);
  }
  throw new Error("listen timeout");
}
await waitListen();
console.log("[probe] app-server listening");

class WsClient {
  ws: WebSocket; tag: string; nextId = 0;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  events: { method: string; params: any; ts: number }[] = [];
  serverRequests: { id: number; method: string; params: any; ts: number }[] = [];
  constructor(tag: string) {
    this.tag = tag;
    this.ws = new WebSocket(URL);
    this.ws.addEventListener("message", (e) => this.onMessage(e.data as string));
  }
  ready() { return new Promise<void>((res, rej) => {
    this.ws.addEventListener("open", () => res(), { once: true });
    this.ws.addEventListener("error", (e) => rej(new Error(String(e))), { once: true });
  }); }
  onMessage(raw: string) {
    let m: any; try { m = JSON.parse(raw); } catch { return; }
    if (typeof m.id === "number" && (m.result !== undefined || m.error !== undefined) && !m.method) {
      const p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
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
  notify(m: string, p: unknown) { console.log(`[${this.tag}] >NTF ${m}`); this.ws.send(JSON.stringify({ method: m, params: p ?? null })); }
  respond(id: number, r: unknown) { console.log(`[${this.tag}] >RES id=${id} ${trunc(JSON.stringify(r), 80)}`); this.ws.send(JSON.stringify({ id, result: r })); }
  hasEvent(m: string, since = 0) { return this.events.some((e) => e.method === m && e.ts >= since); }
  countEvents(m: string, since = 0) { return this.events.filter((e) => e.method === m && e.ts >= since).length; }
  clear() { this.events = []; this.serverRequests = []; }
}
function trunc(s: string, n: number) { return s.length > n ? s.slice(0, n) + "…" : s; }
function section(t: string) { console.log("\n" + "═".repeat(72)); console.log("  " + t); console.log("═".repeat(72)); }

async function waitForApproval(clients: WsClient[], timeout = 60000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (clients.some((c) => c.serverRequests.length > 0)) return;
    if (clients.some((c) => c.hasEvent("turn/completed", start))) return;
    await Bun.sleep(80);
  }
}

let A: WsClient; let B: WsClient; let threadId = "";

try {
  A = new WsClient("A"); B = new WsClient("B");
  await Promise.all([A.ready(), B.ready()]);
  for (const c of [A, B]) {
    await c.request("initialize", {
      clientInfo: { name: `probev2_${c.tag}`, title: c.tag, version: "0.0.1" },
      capabilities: { experimentalApi: true },
    });
    c.notify("initialized", null);
  }

  // create + warm up
  section("create + warm-up turn so rollout exists");
  const startRes: any = await A.request("thread/start", {
    cwd: process.cwd(),
    approvalPolicy: "untrusted",
    sandboxPolicy: { type: "readOnly" },
  });
  threadId = startRes.thread.id;
  console.log("threadId =", threadId);
  console.log("approvalPolicy returned =", startRes.approvalPolicy);
  console.log("sandbox returned =", JSON.stringify(startRes.sandbox));

  // warm up
  {
    const sentinel = Date.now();
    A.clear();
    await A.request("turn/start", { threadId, input: [{ type: "text", text: "Reply 'ok'." }] });
    while (!A.hasEvent("turn/completed", sentinel)) await Bun.sleep(100);
  }

  // B resume
  section("B resume");
  await B.request("thread/resume", { threadId });
  console.log("B resume ok");

  // ──────────  T2  ──────────
  section("T2: A turn that needs bash → who gets the serverRequest?");
  A.clear(); B.clear();
  const t2 = Date.now();
  await A.request("turn/start", {
    threadId,
    input: [{
      type: "text",
      text: "Use the shell tool to run exactly: `echo probe-XYZ`. It must be a tool call, not just text.",
    }],
  });
  await waitForApproval([A, B]);
  console.log(`[T2] A serverRequests: ${A.serverRequests.length}`);
  console.log(`[T2] B serverRequests: ${B.serverRequests.length}`);
  for (const sr of A.serverRequests) console.log(`     [A] ${sr.method} id=${sr.id}`);
  for (const sr of B.serverRequests) console.log(`     [B] ${sr.method} id=${sr.id}`);

  if (A.serverRequests.length === 0 && B.serverRequests.length === 0) {
    console.log("[T2] no serverRequest arrived — codex is auto-approving. dumping last few events:");
    for (const e of A.events.slice(-10)) console.log(`     A: ${e.method}`);
    throw new Error("could not reproduce approval — try a different prompt or policy");
  }

  // ──────────  T3+T4: B responds first  ──────────
  const approval = (B.serverRequests[0] ?? A.serverRequests[0])!;
  console.log(`\n[T3] approval is on ${A.serverRequests.length > 0 ? "A" : ""}${B.serverRequests.length > 0 ? "B" : ""} — using id=${approval.id}, having B accept it`);
  const t3 = Date.now();
  // figure out who actually has it
  const onA = A.serverRequests.find((s) => s.id === approval.id);
  const onB = B.serverRequests.find((s) => s.id === approval.id);
  console.log(`[T3] approval visible to: A=${!!onA} B=${!!onB}`);

  // ALWAYS try B respond first
  B.respond(approval.id, { decision: "accept" });
  // wait for serverRequest/resolved or turn/completed
  const t3Start = Date.now();
  while (Date.now() - t3Start < 30000) {
    if (A.hasEvent("serverRequest/resolved", t3) || B.hasEvent("serverRequest/resolved", t3)) break;
    if (A.hasEvent("turn/completed", t3) || B.hasEvent("turn/completed", t3)) break;
    await Bun.sleep(100);
  }
  console.log(`[T3] A serverRequest/resolved: ${A.hasEvent("serverRequest/resolved", t3)}`);
  console.log(`[T3] B serverRequest/resolved: ${B.hasEvent("serverRequest/resolved", t3)}`);
  console.log(`[T3] A item/commandExecution outputDelta count: ${A.countEvents("item/commandExecution/outputDelta", t3)}`);
  console.log(`[T3] B item/commandExecution outputDelta count: ${B.countEvents("item/commandExecution/outputDelta", t3)}`);
  // wait for turn end
  while (!A.hasEvent("turn/completed", t3) && !B.hasEvent("turn/completed", t3)) await Bun.sleep(100);

  // ──────────  T5: race  ──────────
  section("T5: race — A and B respond simultaneously, different decisions");
  A.clear(); B.clear();
  const t5 = Date.now();
  await A.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Use the shell tool to run: `echo race-test`. Tool call only." }],
  });
  await waitForApproval([A, B]);
  const a5 = A.serverRequests[0]; const b5 = B.serverRequests[0];
  console.log(`[T5] approval seen by A=${!!a5} B=${!!b5}`);
  if (a5 || b5) {
    const id = (a5 ?? b5)!.id;
    // fire both responses back-to-back
    console.log(`[T5] firing A.decline + B.accept on id=${id}`);
    A.respond(id, { decision: "decline" });
    B.respond(id, { decision: "accept" });
    await Bun.sleep(8000);
    const aResolved = A.hasEvent("serverRequest/resolved", t5);
    const bResolved = B.hasEvent("serverRequest/resolved", t5);
    const cmdEvent = A.events.find((e) => e.method === "item/completed" && e.params?.item?.type === "commandExecution");
    const cmdStatus = cmdEvent?.params?.item?.status;
    const errors = [...A.events, ...B.events].filter((e) => e.method === "warning" || e.method === "configWarning");
    console.log(`[T5] A serverRequest/resolved: ${aResolved}`);
    console.log(`[T5] B serverRequest/resolved: ${bResolved}`);
    console.log(`[T5] command final status: ${cmdStatus}`);
    if (errors.length) console.log(`[T5] warnings: ${JSON.stringify(errors)}`);
  } else {
    console.log("[T5] no approval — skipping race");
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
