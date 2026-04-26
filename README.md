# codex-rc

Tiny remote-control web UI for `codex`. Spawns one `codex app-server` over
stdio, streams events to a Bun-served React SPA. Built to be reached over
Tailscale from a phone.

```
phone/desktop ──https──▶ Bun.serve (port 9876) ──stdio──▶ codex app-server
                            │
                            └── serves dist/ (Vite build) + WS /ws
```

## Quick start

```bash
bun install
bun run build              # builds web/ → dist/
bun run start              # spawns codex + serves on :9876
```

The first run prints a token-bearing URL like:

```
http://your-mac.tail-xxx.ts.net:9876/?t=<token>
```

Open it on phone (over Tailscale) — server sets a long-lived cookie on
first hit, then strips the token from the URL.

The token is generated once and cached at `~/.arche/codex-rc.token`.

## Dev mode

```bash
bun run dev:server    # terminal 1: server on :9876
bun run dev:web       # terminal 2: Vite on :5173 (proxies /ws → server)
```

Open `http://localhost:5173/?t=<token>` (token in `~/.arche/codex-rc.token`).

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
| `CODEX_RC_PORT` | `9876` | server port |
| `CODEX_RC_HOST` | `0.0.0.0` | bind host |
| `CODEX_RC_CWD` | cwd | default cwd for new threads |
| `CODEX_RC_TOKEN` | random, cached at `~/.arche/codex-rc.token` | auth token |

## What's not in Phase 1

- No persistence — restart the server, threads are gone (codex itself
  rolls them out to `~/.codex/sessions/`, but we don't surface them).
- No xterm / no diff viewer — bash output and file changes show as
  plain text.
- One `codex app-server` process — many threads inside it. Multi-process
  is a future toggle if you want hard cwd isolation.
- Approvals: only `accept` / `decline` from the UI. `acceptForSession`
  exists in the wire protocol but no button yet.
