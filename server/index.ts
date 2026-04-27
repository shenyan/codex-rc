// codex-rc entrypoint: open a CodexTransport, serve static + WS.
//
// URL: http://<host>:<port>/?t=<token> on first connect (sets cookie).
// Token is generated on first run and cached at ~/.arche/codex-rc.token.

import { Session } from "./session";
import type { CodexTransport } from "./codex/transports/types";
import { StdioCodexTransport } from "./codex/transports/stdio";
import { WsCodexTransport } from "./codex/transports/ws";
import { ensureAppServer } from "./codex/lifecycle";
import type { ClientMsg, ServerMsg } from "../shared/protocol";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

// ────────────────  config  ────────────────
const INSTANCE = (process.env.CODEX_RC_INSTANCE ?? "").trim();
// Instance name appears in the token filename and the auth cookie so
// you can run multiple codex-rc processes on the same host (e.g. one
// stdio + one ws) without their auth state colliding. Empty = "default"
// shape used by Phase 1 deployments — preserved for backwards compat.
const INSTANCE_SUFFIX = INSTANCE ? `-${INSTANCE.replace(/[^A-Za-z0-9_-]/g, "_")}` : "";

const PORT = Number(process.env.CODEX_RC_PORT ?? 9876);
const HOST = process.env.CODEX_RC_HOST ?? "0.0.0.0";
const DEFAULT_CWD = process.env.CODEX_RC_CWD ?? process.cwd();
const DEFAULT_MODEL = process.env.CODEX_RC_MODEL ?? "gpt-5.5";
// Defaults to YOLO ("never" + "dangerFullAccess") — see session.ts
// rationale. Override with these env vars when you want it stricter.
// Validated against a closed set so a typo in the env file fails
// fast at boot instead of throwing a confusing JSON-RPC error on
// the first thread/start later.
const APPROVAL_POLICIES = ["never", "on-request", "untrusted", "unless-trusted"] as const;
const SANDBOX_MODES = ["dangerFullAccess", "workspaceWrite", "readOnly"] as const;
function pickEnum<T extends string>(envName: string, raw: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  console.error(
    `[codex-rc] invalid ${envName}=${JSON.stringify(raw)}. ` +
    `Expected one of: ${allowed.join(", ")}.`,
  );
  process.exit(1);
}
const DEFAULT_APPROVAL_POLICY = pickEnum(
  "CODEX_RC_APPROVAL_POLICY",
  process.env.CODEX_RC_APPROVAL_POLICY ?? "never",
  APPROVAL_POLICIES,
);
const DEFAULT_SANDBOX_MODE = pickEnum(
  "CODEX_RC_SANDBOX_MODE",
  process.env.CODEX_RC_SANDBOX_MODE ?? "dangerFullAccess",
  SANDBOX_MODES,
);
const CODEX_TRANSPORT = (process.env.CODEX_RC_CODEX_TRANSPORT ?? "stdio").toLowerCase();
const CODEX_WS_URL = process.env.CODEX_RC_CODEX_WS_URL ?? "";
const CODEX_WS_AUTH_TOKEN = process.env.CODEX_RC_CODEX_WS_AUTH_TOKEN ?? "";
const CODEX_WS_AUTOSPAWN = (process.env.CODEX_RC_CODEX_WS_AUTOSPAWN ?? "1") !== "0";
const DIST_DIR = fileURLToPath(new URL("../dist/", import.meta.url));
const TOKEN_DIR = join(homedir(), ".arche");
const TOKEN_FILE = join(TOKEN_DIR, `codex-rc${INSTANCE_SUFFIX}.token`);

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
// Cookie name is also instance-scoped so two codex-rc instances on the
// same hostname (e.g. :9876 stdio + :9886 ws) don't fight over a single
// cookie — browsers don't isolate cookies by port.
const COOKIE_NAME = `codex_rc_token${INSTANCE_SUFFIX}`;

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

// ────────────────  transport + session  ────────────────
async function buildTransport(): Promise<CodexTransport> {
  switch (CODEX_TRANSPORT) {
    case "stdio":
      return new StdioCodexTransport();
    case "ws": {
      if (!CODEX_WS_URL) {
        throw new Error("CODEX_RC_CODEX_TRANSPORT=ws requires CODEX_RC_CODEX_WS_URL (e.g. ws://127.0.0.1:9877)");
      }
      if (CODEX_WS_AUTOSPAWN) {
        const r = await ensureAppServer({ url: CODEX_WS_URL });
        if (r.kind === "spawned") {
          console.log(`[codex-rc] spawned codex app-server (pid=${r.pid}, log=${r.logFile})`);
        } else {
          console.log("[codex-rc] codex app-server already listening");
        }
      }
      return new WsCodexTransport({
        url: CODEX_WS_URL,
        authToken: CODEX_WS_AUTH_TOKEN || undefined,
      });
    }
    default:
      throw new Error(`unknown CODEX_RC_CODEX_TRANSPORT=${CODEX_TRANSPORT}; expected "stdio" or "ws"`);
  }
}

const transport = await buildTransport();
const session = new Session({
  defaultCwd: DEFAULT_CWD,
  defaultModel: DEFAULT_MODEL || null,
  defaultApprovalPolicy: DEFAULT_APPROVAL_POLICY,
  defaultSandboxMode: DEFAULT_SANDBOX_MODE,
  transport,
});
await session.ready();
console.log(`[codex-rc] codex app-server ready (transport=${CODEX_TRANSPORT}${CODEX_TRANSPORT === "ws" ? `, url=${CODEX_WS_URL}` : ""})`);

// ────────────────  server  ────────────────
type WsData = { send: (m: ServerMsg) => void; unsubscribe: () => void };

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
      const unsubscribe = session.subscribe(send);
      ws.data = { send, unsubscribe };
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
    close(ws) {
      ws.data?.unsubscribe?.();
    },
  },
});

// ────────────────  banner  ────────────────
const tailscaleHost = await detectTailscaleHost();
const url = `http://${tailscaleHost ?? "localhost"}:${PORT}/?t=${TOKEN}`;
const label = INSTANCE ? `codex-rc[${INSTANCE}]` : "codex-rc";
console.log("");
console.log("┌──────────────────────────────────────────────");
console.log(`│  ${label} listening`);
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
