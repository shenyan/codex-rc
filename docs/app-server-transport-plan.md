# Shared Codex App Server Transport Plan

This document compares two ways for `codex-rc` to stop owning a private
`codex app-server --listen stdio://` process and instead connect to a shared
Codex app-server that can also be used by local Codex clients.

The target outcome is:

```text
phone/browser web UI
  -> codex-rc Bun server
      -> shared codex app-server

local terminal TUI
  -> same shared codex app-server
```

## Current Model

Today `codex-rc` starts its own app-server process:

```text
codex-rc Bun server
  -> spawn codex app-server --listen stdio://
```

`server/codex-client.ts` owns both concerns:

- spawning the app-server child process
- speaking JSON-RPC over newline-delimited stdio

That makes the app-server private to `codex-rc`. A local terminal TUI cannot
attach to the same stdio stream.

## Important Codex App Server Facts

From the Codex source in `../codex`:

- `codex app-server` supports `stdio://`, `ws://IP:PORT`, `unix://`, and
  `unix://PATH`.
- WebSocket transport sends one JSON-RPC message per text frame.
- Unix socket transport is WebSocket over a Unix domain socket using the normal
  HTTP Upgrade handshake.
- `codex app-server proxy --sock PATH` connects to the Unix control socket and
  proxies bytes between the socket and stdin/stdout.
- The app-server supports multiple client connections.
- A single app-server can have multiple `thread`s loaded.
- Connecting to the same app-server is not enough to enter the same chat. A
  client still needs to `thread/resume` or otherwise subscribe to the intended
  `threadId`.
- Useful recovery APIs exist: `thread/list`, `thread/loaded/list`,
  `thread/read`, `thread/turns/list`, and `thread/resume`.

## Option A: WebSocket App Server

### Shape

Run a shared TCP WebSocket app-server:

```bash
codex app-server --listen ws://127.0.0.1:9877
```

Then connect both clients to it:

```text
codex-rc Bun server
  -> ws://127.0.0.1:9877

codex TUI
  -> codex --remote ws://127.0.0.1:9877
```

The browser should not connect directly to Codex app-server. Browsers send an
`Origin` header, and Codex app-server rejects requests with `Origin`. The
browser should continue to connect only to `codex-rc`.

### Configuration

Add environment variables:

```bash
CODEX_RC_CODEX_TRANSPORT=ws
CODEX_RC_CODEX_WS_URL=ws://127.0.0.1:9877
CODEX_RC_CODEX_WS_AUTH_TOKEN_FILE=/absolute/path/to/token
CODEX_RC_CODEX_WS_AUTH_TOKEN=...
```

The auth token is only needed if the app-server was started with WebSocket auth:

```bash
codex app-server \
  --listen ws://127.0.0.1:9877 \
  --ws-auth capability-token \
  --ws-token-file /absolute/path/to/token
```

Clients present the token as:

```text
Authorization: Bearer <token>
```

For the first version, prefer loopback only:

```text
ws://127.0.0.1:9877
```

Do not expose Codex app-server directly on Tailscale. Keep Tailscale exposure
limited to the `codex-rc` Bun server and its existing token/cookie auth.

### Implementation Plan

Split the current client into JSON-RPC and transport layers:

```text
server/codex-client.ts
server/transports/stdio.ts
server/transports/ws.ts
server/transports/proxy.ts
```

Use an interface like:

```ts
export interface CodexTransport {
  ready(): Promise<void>;
  send(frame: unknown): void;
  close(): Promise<void>;
  onFrame(cb: (frame: unknown) => void): void;
  onClose(cb: (err?: Error) => void): void;
}
```

`CodexClient` should keep only:

- request id allocation
- pending request map
- response dispatch
- notification dispatch
- server-initiated request dispatch
- `initialize` / `initialized` handshake

`WsCodexTransport` should:

- open a WebSocket to `CODEX_RC_CODEX_WS_URL`
- add `Authorization: Bearer <token>` when configured and supported
- encode each outgoing JSON-RPC message as one text frame
- parse each incoming text frame as one JSON-RPC message
- report close/error to `CodexClient`

### Startup Scripts

Add scripts like:

```json
{
  "codex:app-server:ws": "codex app-server --listen ws://127.0.0.1:9877",
  "start:ws": "CODEX_RC_CODEX_TRANSPORT=ws CODEX_RC_CODEX_WS_URL=ws://127.0.0.1:9877 bun server/index.ts",
  "dev:server:ws": "CODEX_RC_CODEX_TRANSPORT=ws CODEX_RC_CODEX_WS_URL=ws://127.0.0.1:9877 bun --hot server/index.ts"
}
```

Typical tmux layout:

```bash
tmux new -s codex-shared

# pane 1
codex app-server --listen ws://127.0.0.1:9877

# pane 2
CODEX_RC_CODEX_TRANSPORT=ws \
CODEX_RC_CODEX_WS_URL=ws://127.0.0.1:9877 \
bun run start
```

Local TUI:

```bash
codex --remote ws://127.0.0.1:9877
```

### State and Thread Handling

`codex-rc` must not assume that every thread was created by its own Web UI.

On connect:

1. `initialize`
2. `initialized`
3. `thread/loaded/list`
4. `thread/list` for persisted sessions
5. build the local sidebar from returned thread metadata

On opening a thread:

1. call `thread/read` with turns if only viewing history
2. call `thread/resume` if the Web UI should actively continue the thread
3. subscribe/mirror subsequent turn and item events

When receiving events for unknown threads:

- create a local `ThreadState` stub
- upsert item data by id
- update title/status/preview from notifications and read results

Approval state must be idempotent. If another client resolves an approval,
`codex-rc` should handle `serverRequest/resolved` and remove the pending item
from the Web UI.

### Strengths

- Directly matches `codex --remote ws://...`.
- Easy for humans to inspect and test with normal TCP tools.
- No helper proxy process is needed for `codex-rc`.
- Good fit if the local TUI must connect without changing Codex CLI.

### Weaknesses

- Uses a TCP port.
- Needs careful auth if ever bound to non-loopback.
- Browser cannot connect directly because of `Origin` rejection.
- Still needs a thread handoff mechanism so TUI enters the same `threadId` as
  the Web UI.

## Option B: Unix Socket App Server

### Shape

Run a shared Unix socket app-server:

```bash
codex app-server --listen unix://
```

Default socket:

```text
$CODEX_HOME/app-server-control/app-server-control.sock
```

Or use an explicit path:

```bash
codex app-server --listen unix:///tmp/codex-app-server.sock
```

`codex-rc` connects locally through the Unix control socket.

```text
codex-rc Bun server
  -> Unix socket
      -> shared codex app-server
```

### Recommended First Implementation: Proxy Mode

The simplest path is to use Codex's built-in proxy:

```bash
codex app-server proxy --sock "$CODEX_HOME/app-server-control/app-server-control.sock"
```

Then `codex-rc` can treat the proxy like its existing stdio transport.

Current:

```bash
codex app-server --listen stdio://
```

Shared Unix proxy:

```bash
codex app-server proxy --sock /absolute/path/to/app-server-control.sock
```

This avoids implementing WebSocket-over-Unix framing in Bun.

### Configuration

Add environment variables:

```bash
CODEX_RC_CODEX_TRANSPORT=unix-proxy
CODEX_RC_CODEX_UNIX_SOCKET=/absolute/path/to/app-server-control.sock
```

If `CODEX_RC_CODEX_UNIX_SOCKET` is omitted, resolve the default:

```text
$CODEX_HOME/app-server-control/app-server-control.sock
```

If `CODEX_HOME` is unset, use Codex's default home resolution if practical, or
fall back to:

```text
~/.codex/app-server-control/app-server-control.sock
```

### Implementation Plan

Add a proxy transport:

```text
server/transports/unix-proxy.ts
```

It should spawn:

```ts
["codex", "app-server", "proxy", "--sock", socketPath]
```

The rest of the behavior should match the existing stdio client:

- read newline-delimited JSON from stdout
- write newline-delimited JSON to stdin
- forward stderr to the server log
- perform the same `initialize` / `initialized` handshake

This mode still needs `CodexClient` transport extraction, but it can reuse most
of the current stdio implementation.

### Direct Unix Socket Mode

A later implementation can connect directly from Bun to the Unix socket:

```text
codex-rc
  -> Unix socket HTTP Upgrade
  -> WebSocket frames
  -> JSON-RPC text messages
```

This removes the proxy helper process, but it requires implementing or reusing
a WebSocket client that supports Unix domain sockets. That is extra complexity
and is not needed for the first version.

### Local TUI Compatibility

Current CLI help says `codex --remote` accepts:

```text
ws://host:port
wss://host:port
```

So the TUI may not be able to connect directly to `unix://`.

That means Unix socket is excellent for:

```text
codex-rc -> shared local app-server
```

but may not fully solve:

```text
local TUI -> same shared app-server
```

unless one of these is added:

- Codex CLI supports `--remote unix://...`
- Codex CLI supports `--remote-proxy` or equivalent
- a local TCP WebSocket bridge is also run for the TUI

### Startup Scripts

Add scripts like:

```json
{
  "codex:app-server:unix": "codex app-server --listen unix://",
  "start:unix": "CODEX_RC_CODEX_TRANSPORT=unix-proxy bun server/index.ts",
  "dev:server:unix": "CODEX_RC_CODEX_TRANSPORT=unix-proxy bun --hot server/index.ts"
}
```

Typical tmux layout:

```bash
tmux new -s codex-shared

# pane 1
codex app-server --listen unix://

# pane 2
CODEX_RC_CODEX_TRANSPORT=unix-proxy \
bun run start
```

### Strengths

- No TCP port.
- Good local security boundary through filesystem permissions.
- Avoids non-loopback WebSocket auth concerns.
- Best fit for a local long-running app-server controlled from tmux or launchd.
- Proxy mode is low-risk because it preserves the current stdio JSONL shape.

### Weaknesses

- TUI remote support appears to be TCP WebSocket only today.
- Direct Bun Unix WebSocket support may require custom transport work.
- The proxy helper adds another child process.
- Still needs thread handoff if a terminal TUI is expected to join the current
  Web UI thread.

## Thread Handoff Risk

Both options share the same product risk: app-server sharing is server-level,
not chat-level.

This is valid:

```text
one app-server
  thread A: web UI
  thread B: local TUI
  thread C: another web session
```

To "take over" the current Web UI chat, the terminal must resume the exact
`threadId` that the Web UI is showing.

A complete handoff needs:

```text
app-server endpoint + threadId
```

For WebSocket:

```bash
codex resume <threadId> --remote ws://127.0.0.1:9877
```

This command form must be verified. If Codex CLI does not support remote resume
by explicit thread id, add it upstream or provide a wrapper/picker workflow.

For Unix socket:

```bash
codex resume <threadId> --remote unix://...
```

This likely requires Codex CLI support that may not exist yet.

Until this is solved, `codex-rc` and local TUI can share an app-server but may
still land in different threads.

## Recommended Path

Implement in this order:

1. Extract `CodexClient` from the current stdio process transport.
2. Add `unix-proxy` transport first.
3. Use `codex app-server --listen unix://` in tmux and connect `codex-rc`
   through `codex app-server proxy`.
4. Add startup docs and scripts for the Unix path.
5. Add `ws` transport second for compatibility with `codex --remote`.
6. Update `Session` to build/mirror state from `thread/list`, `thread/read`,
   `thread/resume`, and external thread notifications.
7. Investigate or add explicit remote resume by `threadId` in Codex CLI.

The Unix proxy path is the safest first step because it changes the fewest
moving pieces in `codex-rc`. The WebSocket path is still needed if the local TUI
must attach to the same shared app-server without changing Codex CLI.

## Verification Checklist

Unix proxy:

- Start `codex app-server --listen unix://`.
- Start `codex-rc` with `CODEX_RC_CODEX_TRANSPORT=unix-proxy`.
- Open Web UI.
- Create a thread.
- Send a prompt and receive streaming output.
- Trigger a command approval and resolve it from Web UI.
- Restart `codex-rc` and verify `thread/list` / `thread/read` restore visible
  state as expected.

WebSocket:

- Start `codex app-server --listen ws://127.0.0.1:9877`.
- Start `codex-rc` with `CODEX_RC_CODEX_TRANSPORT=ws`.
- Open Web UI.
- Create or resume a thread.
- Start `codex --remote ws://127.0.0.1:9877`.
- Verify whether TUI can resume the Web UI thread.
- Verify approvals resolve correctly when handled from either side.
- Verify `serverRequest/resolved` removes stale approval UI.

