// codex-rc entrypoint: spawn codex app-server, serve static + WS.
//
// URL: http://<host>:<port>/?t=<token> on first connect (sets cookie).
// Token is generated on first run and cached at ~/.arche/codex-rc.token.

import { Session } from "./session";
import type { ClientMsg, ServerMsg } from "../shared/protocol";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// ────────────────  config  ────────────────
const PORT = Number(process.env.CODEX_RC_PORT ?? 9876);
const HOST = process.env.CODEX_RC_HOST ?? "0.0.0.0";
const DEFAULT_CWD = process.env.CODEX_RC_CWD ?? process.cwd();
const DEFAULT_MODEL = process.env.CODEX_RC_MODEL ?? "gpt-5.5";
const DIST_DIR = new URL("../dist/", import.meta.url).pathname;
const TOKEN_DIR = join(homedir(), ".arche");
const TOKEN_FILE = join(TOKEN_DIR, "codex-rc.token");

function loadOrCreateToken(): string {
  if (!existsSync(TOKEN_DIR)) mkdirSync(TOKEN_DIR, { recursive: true });
  if (existsSync(TOKEN_FILE)) {
    const t = readFileSync(TOKEN_FILE, "utf8").trim();
    if (t) return t;
  }
  const t = randomBytes(24).toString("base64url");
  writeFileSync(TOKEN_FILE, t + "\n", { mode: 0o600 });
  return t;
}

const TOKEN = process.env.CODEX_RC_TOKEN ?? loadOrCreateToken();
const COOKIE_NAME = "codex_rc_token";

function isAuthed(req: Request): boolean {
  // Try the query token first — a fresh token-bearing URL must always win
  // over a stale cookie (e.g. from a previous run with a different token).
  const url = new URL(req.url);
  const q = url.searchParams.get("t");
  if (q && q === TOKEN) return true;
  const cookie = req.headers.get("cookie") ?? "";
  for (const part of cookie.split(/;\s*/)) {
    const [k, v] = part.split("=");
    if (k === COOKIE_NAME && decodeURIComponent(v ?? "") === TOKEN) return true;
  }
  return false;
}

// ────────────────  session  ────────────────
const session = new Session(DEFAULT_CWD, DEFAULT_MODEL || null);
await session.ready();
console.log("[codex-rc] codex app-server ready");

// ────────────────  server  ────────────────
type WsData = { send: (m: ServerMsg) => void };

const server = Bun.serve<WsData, never>({
  port: PORT,
  hostname: HOST,
  development: false,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") return new Response("ok");

    // WS upgrade
    if (url.pathname === "/ws") {
      if (!isAuthed(req)) return new Response("unauthorized", { status: 401 });
      const ok = server.upgrade(req, { data: {} as WsData });
      return ok ? undefined : new Response("upgrade failed", { status: 500 });
    }

    // Token-bearing URL → set cookie + redirect
    if (url.searchParams.has("t")) {
      if (!isAuthed(req)) return new Response("unauthorized", { status: 401 });
      const cleaned = new URL(url);
      cleaned.searchParams.delete("t");
      const headers = new Headers({ Location: cleaned.pathname + cleaned.search });
      headers.append(
        "Set-Cookie",
        `${COOKIE_NAME}=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`,
      );
      return new Response(null, { status: 302, headers });
    }

    // Static files
    if (!isAuthed(req)) return new Response("unauthorized", { status: 401 });

    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(DIST_DIR + path.replace(/^\//, ""));
    if (await file.exists()) return new Response(file);

    // SPA fallback
    const fallback = Bun.file(DIST_DIR + "index.html");
    if (await fallback.exists()) return new Response(fallback, { headers: { "content-type": "text/html" } });

    return new Response("not found (run `bun run build`)", { status: 404 });
  },

  websocket: {
    open(ws) {
      const send = (m: ServerMsg) => ws.send(JSON.stringify(m));
      ws.data = { send };
      session.subscribe(send);
      send(session.snapshot());
    },
    async message(ws, raw) {
      let msg: ClientMsg;
      try { msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); }
      catch { return; }
      try {
        await session.handleClientMsg(msg, ws.data.send);
      } catch (err) {
        ws.data.send({ type: "error", message: String(err) });
      }
    },
    close() {
      // Subscriber unsub happens via stored function; we leak the closure
      // until the broadcast loop fails. For Phase 1 this is fine — server
      // restart clears it.
    },
  },
});

// ────────────────  banner  ────────────────
const tailscaleHost = await detectTailscaleHost();
const url = `http://${tailscaleHost ?? "localhost"}:${PORT}/?t=${TOKEN}`;
console.log("");
console.log("┌──────────────────────────────────────────────");
console.log("│  codex-rc listening");
console.log("│  open on phone/desktop:");
console.log("│  " + url);
console.log("│  cwd: " + DEFAULT_CWD);
console.log("└──────────────────────────────────────────────");

async function detectTailscaleHost(): Promise<string | null> {
  try {
    const proc = Bun.spawn({ cmd: ["tailscale", "status", "--json"], stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const j = JSON.parse(out);
    const fqdn: string | undefined = j?.Self?.DNSName;
    if (fqdn) return fqdn.replace(/\.$/, "");
  } catch {}
  return null;
}
