// Optional helper: when transport=ws and the URL isn't already
// listening, spawn `codex app-server --listen <url>` ourselves and
// wait for it to come up.
//
// The spawned process is **detached** and unref'd — it survives this
// codex-rc process exiting. Combined with Phase-2B's startup recovery,
// that means the agent's working state persists across codex-rc
// restarts. A user who wants strict ownership ("kill app-server when
// codex-rc dies") should disable on-demand spawn via
// CODEX_RC_CODEX_WS_AUTOSPAWN=0 and start the app-server themselves.

import { spawn } from "bun";
import { mkdirSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface EnsureAppServerOpts {
  url: string;
  /** Connect timeout to consider "already up" (default 1500ms). */
  reachableTimeoutMs?: number;
  /** Wait timeout for a freshly-spawned server to listen (default 15000ms). */
  spawnTimeoutMs?: number;
  /** Override the codex binary (default "codex" from PATH). */
  bin?: string;
}

export type EnsureResult =
  | { kind: "alreadyUp" }
  | { kind: "spawned"; pid: number; logFile: string };

export async function ensureAppServer(opts: EnsureAppServerOpts): Promise<EnsureResult> {
  const { host, port } = parseWsUrl(opts.url);
  if (await canConnect(host, port, opts.reachableTimeoutMs ?? 1500)) {
    return { kind: "alreadyUp" };
  }

  const logDir = join(homedir(), ".codex", "logs");
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, "codex-rc-app-server.log");
  const fd = openSync(logFile, "a");

  const proc = spawn({
    cmd: [opts.bin ?? "codex", "app-server", "--listen", opts.url],
    stdin: "ignore",
    stdout: fd,
    stderr: fd,
    // Detach so the child survives codex-rc exit. Required for
    // Phase-2B recovery to actually save state across restarts.
    // (Bun: pass options via the type-asserted "any"; the runtime
    // accepts these even if the .d.ts may not yet expose them.)
    ...({ detached: true } as any),
  });
  // Unref so we don't keep the event loop alive waiting on it.
  ((proc as any).unref?.());

  const ok = await waitListen(host, port, opts.spawnTimeoutMs ?? 15000);
  if (!ok) throw new Error(`spawned codex app-server but it did not listen on ${opts.url} in time; see ${logFile}`);

  return { kind: "spawned", pid: proc.pid, logFile };
}

function parseWsUrl(url: string): { host: string; port: number } {
  const u = new URL(url);
  const port = Number(u.port || (u.protocol === "wss:" ? 443 : 80));
  return { host: u.hostname || "127.0.0.1", port };
}

async function canConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const sock = await Bun.connect({
      hostname: host,
      port,
      socket: { data() {}, close() {}, error() {}, open() {} },
    });
    clearTimeout(timer);
    sock.end();
    return true;
  } catch {
    return false;
  }
}

async function waitListen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await canConnect(host, port, 1000)) return true;
    await Bun.sleep(200);
  }
  return false;
}
