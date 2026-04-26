#!/usr/bin/env bun
/**
 * Phase 0 probe: spawn `codex app-server --listen stdio://`, run a minimal
 * conversation, log every JSON-RPC frame in/out so we can confirm field names.
 *
 * Usage:
 *   bun experiments/probe/probe.ts "your prompt here"
 */

import { spawn } from "bun";

const userPrompt = process.argv[2] ?? "Say hi in one sentence, no tools.";
const cwd = process.argv[3] ?? process.cwd();

const proc = spawn({
  cmd: ["codex", "app-server", "--listen", "stdio://"],
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

const stderrPump = (async () => {
  const reader = proc.stderr.getReader();
  const dec = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    process.stderr.write("[codex stderr] " + dec.decode(value));
  }
})();

let nextId = 0;
const pending = new Map<number, (msg: any) => void>();

function send(method: string, params: unknown, id?: number) {
  const frame: any = { method, params: params ?? null };
  if (id !== undefined) frame.id = id;
  const line = JSON.stringify(frame) + "\n";
  console.log(`>> ${line.trimEnd()}`);
  proc.stdin.write(line);
  proc.stdin.flush?.();
}

function request<T = any>(method: string, params: unknown): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, (msg) => {
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result as T);
    });
    send(method, params, id);
  });
}

function notify(method: string, params: unknown) {
  send(method, params);
}

function respond(id: number, result: unknown) {
  const line = JSON.stringify({ id, result }) + "\n";
  console.log(`>> ${line.trimEnd()}`);
  proc.stdin.write(line);
  proc.stdin.flush?.();
}

let buf = "";
const dec = new TextDecoder();

let turnDone = false;
let currentThreadId: string | null = null;
let currentTurnId: string | null = null;

const stdoutPump = (async () => {
  const reader = proc.stdout.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      console.log(`<< ${line}`);
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      handle(msg);
    }
  }
})();

function handle(msg: any) {
  // Response to one of our requests
  if (typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
    const cb = pending.get(msg.id);
    if (cb) { pending.delete(msg.id); cb(msg); }
    return;
  }
  // Server request → auto-approve everything
  if (typeof msg.id === "number" && msg.method && msg.method.includes("requestApproval")) {
    console.log(`[auto-approve] ${msg.method} id=${msg.id}`);
    respond(msg.id, { decision: "accept" });
    return;
  }
  // Notifications
  if (msg.method === "turn/started") currentTurnId = msg.params?.turn?.id ?? currentTurnId;
  if (msg.method === "turn/completed") {
    console.log(`[turn ${msg.params?.turn?.id} → ${msg.params?.turn?.status}]`);
    turnDone = true;
  }
}

// --- main flow ---
try {
  const initRes = await request("initialize", {
    clientInfo: { name: "codex_rc_probe", title: "Codex-RC Probe", version: "0.0.1" },
    capabilities: { experimentalApi: true },
  });
  console.log("[init]", initRes);

  notify("initialized", null);

  const threadRes: any = await request("thread/start", { cwd });
  currentThreadId = threadRes.thread.id;
  console.log("[thread]", currentThreadId);

  const turnRes: any = await request("turn/start", {
    threadId: currentThreadId,
    input: [{ type: "text", text: userPrompt }],
  });
  console.log("[turn started]", turnRes.turn?.id);

  // Wait for turn/completed
  const start = Date.now();
  while (!turnDone && Date.now() - start < 60_000) {
    await Bun.sleep(50);
  }
  if (!turnDone) console.error("[probe] timeout waiting for turn/completed");
} catch (err) {
  console.error("[probe] error:", err);
} finally {
  proc.stdin.end();
  await Promise.race([proc.exited, Bun.sleep(2000)]);
  process.exit(0);
}
