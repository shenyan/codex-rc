# codex-rc

Tiny remote-control web UI for `codex`. Spawns one `codex app-server` over
stdio, streams events to a Bun-served React SPA. Built to be reached over
Tailscale from a phone.

```
phone/desktop ──http──▶ Bun.serve (port 9876) ──stdio──▶ codex app-server
                          │
                          └── serves dist/ (Vite build) + WS /ws
```

The hop from phone to Bun.serve is plain HTTP. The wire is encrypted
end-to-end by Tailscale's WireGuard mesh, so the deployment assumption
is **"reach codex-rc only via your tailnet"** — the listening port is
not safe to expose on the public internet without your own TLS
terminator (Tailscale Serve, caddy, etc.). If you do put a TLS
terminator in front, the auth cookie should also pick up `Secure` —
that change is not yet wired up because today there is no scenario
where the server itself sees `https`.

## Quick start

```bash
bun install
bun run build              # builds web/ → dist/
bun run start              # default stdio instance on :9876
```

The first run prints a token-bearing URL like:

```
http://your-mac.tail-xxx.ts.net:9876/?t=<token>
```

Open it on phone (over Tailscale) — server sets a long-lived cookie on
first hit, then strips the token from the URL.

The token is generated once and cached at `~/.arche/codex-rc.token`.

### Two flavors at once: stdio + ws

You can run the original stdio-backed instance and the new
ws-backed (shared app-server) instance side by side, on different
ports, so the same phone has two URLs to choose from.

```bash
bun run start:both
```

…starts both:

| URL | Backend | What |
|---|---|---|
| `http://...:9876/?t=...` | stdio child (private) | original Phase-1 behavior, one app-server per codex-rc |
| `http://...:9886/?t=...` | ws → `127.0.0.1:9877` (shared) | attaches to a long-running app-server (auto-spawned the first time); a terminal `codex --remote ws://127.0.0.1:9877` can join the same agent |

Each instance has its own token (`~/.arche/codex-rc.token` and
`codex-rc-ws.token`) and its own cookie name
(`codex_rc_token` vs `codex_rc_token-ws`) so they don't collide
when the browser sees both URLs on the same hostname.

You can also run just the ws version: `bun run start:ws`.

## Dev mode

```bash
bun run dev:server    # terminal 1: server on :9876
bun run dev:web       # terminal 2: Vite on :5173 (proxies /ws → server)
```

Auth is set by the Bun server, not by Vite — Vite only proxies `/ws`
and `/healthz`, so visiting `http://localhost:5173/?t=...` first will
404 the cookie set. Set the cookie once:

```
1. Open http://localhost:9876/?t=<token>   ← Bun server sets cookie
2. Open http://localhost:5173/             ← Vite UI uses it
```

(Token lives in `~/.arche/codex-rc.token`.)

## Layout

- **Phone** (`< md`, < 768 px) — single screen; chat list and chat detail
  live on different routes (`/` and `/c/:threadId`). The chat detail
  shows a **Back** button to return to the list.
- **Tablet / desktop** (`≥ md`) — split view: list on the left
  (320 px), detail fills the rest.

Routes are managed by `react-router-dom`; the responsive layout uses
Tailwind `md:` breakpoint.

## Tests

Browser tests live in `tests/`. Server must be running on :9876.

```bash
bun run start &                       # leave running
CODEX_RC_TOKEN=testtoken npx playwright test
```

(Why `npx`? Playwright's loader requires Node 18.19+ for ESM; bunx
shims that and trips the version check. Plain `node` via npx works.)

Projects: `iphone`, `ipad`, `desktop`. Screenshots are saved to
`tests/__screenshots__/`.

## Files

| Path | Purpose |
|---|---|
| `server/index.ts` | entry, Bun.serve, token + cookie auth, static + WS |
| `server/codex-client.ts` | thin JSON-RPC client over codex stdio |
| `server/session.ts` | translates codex events ↔ wire envelope, broadcasts to WS |
| `shared/protocol.ts` | wire types (client ↔ server envelope) |
| `web/src/App.tsx` | routes + responsive split layout |
| `web/src/routes/ChatList.tsx` | sidebar/list view |
| `web/src/routes/Chat.tsx` | detail view, composer, approval bar |
| `web/src/components/ApprovalToaster.tsx` | global "approval needed" toast |
| `web/src/lib/store.ts` | tiny WS-backed store |
| `experiments/probe/probe.ts` | Phase-0 protocol probe |

## Knobs

| Env | Default | What |
|---|---|---|
| `CODEX_RC_INSTANCE` | _(empty)_ | optional name (e.g. `ws`) — scopes the token file (`codex-rc-${name}.token`) and cookie name (`codex_rc_token-${name}`) so multiple codex-rc instances on the same host don't collide. Banner also prints `codex-rc[${name}]`. Characters outside `[A-Za-z0-9_-]` get replaced with `_`. |
| `CODEX_RC_PORT` | `9876` | server port |
| `CODEX_RC_HOST` | `0.0.0.0` | bind host |
| `CODEX_RC_CWD` | cwd | default cwd for new threads |
| `CODEX_RC_TOKEN` | random, cached at `~/.arche/codex-rc.token` | auth token |
| `CODEX_RC_MODEL` | `gpt-5.5` | default model for new threads (empty = let app-server choose) |
| `CODEX_RC_CODEX_TRANSPORT` | `stdio` | how to talk to `codex app-server` — `stdio` (spawn child) or `ws` (attach) |
| `CODEX_RC_CODEX_WS_URL` | — | required when `CODEX_RC_CODEX_TRANSPORT=ws`, e.g. `ws://127.0.0.1:9877` |
| `CODEX_RC_CODEX_WS_AUTH_TOKEN` | — | optional bearer for ws if app-server is behind `--ws-auth` |
| `CODEX_RC_CODEX_WS_AUTOSPAWN` | `1` | in ws mode, auto-spawn `codex app-server` (detached) if URL unreachable. Set `0` to require manual control. |

### Sharing one app-server (`CODEX_RC_CODEX_TRANSPORT=ws`)

Default mode (`stdio`) spawns a private `codex app-server` and owns
its lifecycle — same as Phase 1.

In `ws` mode codex-rc attaches to a long-running app-server. By
default the app-server is **auto-spawned detached** if it isn't
listening yet, so it survives codex-rc restarts. Combined with
the recovery flow (`thread/loaded/list` + `thread/list` +
`thread/read` on `Session.ready()`), restarting codex-rc no
longer loses your conversation state, and a terminal `codex
--remote ws://127.0.0.1:9877` can attach to the same agent for
shared sessions.

```bash
# default: auto-spawn if not running, then attach
CODEX_RC_CODEX_TRANSPORT=ws \
CODEX_RC_CODEX_WS_URL=ws://127.0.0.1:9877 \
bun run start
```

```bash
# manual: you start the app-server yourself, codex-rc only attaches
codex app-server --listen ws://127.0.0.1:9877  &
CODEX_RC_CODEX_TRANSPORT=ws \
CODEX_RC_CODEX_WS_URL=ws://127.0.0.1:9877 \
CODEX_RC_CODEX_WS_AUTOSPAWN=0 \
bun run start
```

Auto-spawned app-server logs go to
`~/.codex/logs/codex-rc-app-server.log`.

## Known limitations

- No file-diff viewer — `fileChange` items render as a one-line summary
  rather than a real diff. Coming next.
- One `codex app-server` per instance — N threads inside one process
  is fine for daily use, but if you want hard cwd isolation between
  concurrent threads you'd want N processes.
- No push notifications when the phone is backgrounded — if the agent
  pauses for an approval while you're not looking at the app, you
  won't be nudged. ntfy.sh integration is the planned path.

## Run codex-rc-ws on boot (launchd)

For the always-on, share-with-the-TUI flavor: install a LaunchAgent
that starts the ws instance on login and respawns it on crash.

```bash
bin/install-launchd.sh install     # render plist + launchctl load
bin/install-launchd.sh status      # show launchctl entry + tail logs
bin/install-launchd.sh uninstall   # unload + remove plist
```

The agent is named `com.user.codex-rc-ws` and runs `bun server/index.ts`
with the same env vars as `bun run start:ws`. Logs:
`~/.codex/logs/codex-rc-ws.{log,err.log}`.

The stdio instance is intentionally not in the LaunchAgent — that's
the "I'll start it when I want it" mode. Use `bun run start` for
that one.

## Phase 2 research

Notes for the next phase (sharing one `codex app-server` between
codex-rc and the local terminal codex) live in
`docs/shared-app-server-research.md`. Empirical probes are in
`experiments/multi-client-probe/`.
