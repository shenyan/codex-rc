# codex-rc — Technical Report

> A field report on building a remote-control web UI for the codex
> CLI agent. Covers the JSON-RPC protocol (stdio + WebSocket transport),
> the architecture we converged on, every protocol gotcha we tripped
> over (and there were many), the empirical findings about
> multi-client semantics that aren't documented anywhere upstream,
> and a forward look at what changes when we replace the web UI with
> a native mobile app.
>
> Current status: Phase 1 + 2A–2I shipped. ~11 commits on `main`,
> dual-instance deployment (stdio + ws) running over Tailscale.
>
> Audience: anyone trying to do this again, anyone reviewing the
> codebase, future-us.

## 1. Goal and motivation

The brief was simple: drive a `codex` agent running on a workstation
from a phone, without modifying codex itself. The agent does code
work — runs shell commands, edits files, calls models — and we want
to watch and steer it from anywhere we have a phone.

Constraints baked in from the start:

- **No fork of codex.** We use only the documented public CLI.
- **Phone can be far from the workstation** (in our case: Tailscale
  mesh, no public exposure of the workstation port).
- **One instance per machine should be the simple default**, but
  the architecture should support multiple instances and shared
  agents between codex-rc and a terminal `codex` session.
- **Be honest about reach** — phone reach, not arbitrary internet
  reach, was the actual product need.

The non-goals matter equally:

- Not a hosted service. No customer, no SSO, no multitenancy.
- Not a replacement for the codex TUI. Coexistence is fine.
- Not a research vehicle for an arbitrary LLM agent — just codex.

## 2. The codex JSON-RPC protocol — the part you need before anything else

Codex 0.121 onwards exposes a JSON-RPC interface via a single
`codex app-server` subprocess. It speaks JSON-RPC 2.0 with the
explicit `"jsonrpc":"2.0"` field omitted (so frames are just
`{ id, method, params }` or `{ id, result, error }`).

### 2.1 Three message kinds, one channel

The wire interleaves three message kinds:

| Kind | Has `id` | Has `method` | Has `result`/`error` |
|---|---|---|---|
| **client → server request** | yes | yes | no |
| **server → client response** | yes (matching) | no | yes |
| **server → client request** (e.g. tool approval) | yes | yes | no |
| **client → server response** (matching id) | yes | no | yes |
| **notification** (either direction) | no | yes | no |

A server-initiated request is exactly an inbound frame with **both**
`id` and `method`. The client must reply with `{ id, result }` or
`{ id, error }` matching that id. We learned the hard way that this
shape collision means the dispatcher needs to check `id`+`method`
*before* `id`+`result` or you'll mis-route approvals as responses.

### 2.2 Two transports

`codex app-server --listen` accepts:

- `stdio://` (default): newline-delimited JSON over stdin/stdout.
  Spawn the binary, pipe in/out, parse line by line.
- `ws://IP:PORT`: WebSocket over TCP loopback. One JSON-RPC message
  per text frame. **Marked experimental** in the help text but
  effectively stable.
- `unix://[PATH]`: WebSocket over a Unix domain socket. Used by the
  codex VS Code extension. We considered it for codex-rc, decided
  against (see §6.4).
- `off`: server doesn't listen.

**Both stdio and ws speak the same JSON-RPC dialect.** The only
difference is framing and connection model:

| | stdio | ws |
|---|---|---|
| Connection model | 1 client, exclusive | N clients, shared app-server |
| Framing | newline-delimited | one msg per WS frame |
| Lifecycle | child of codex-rc | independent process |
| Survives codex-rc restart | no | yes |
| Visible to terminal `codex --remote` | no | yes |
| Auth | filesystem isolation (only parent reads pipes) | none on loopback (anyone with port access can drive) |

### 2.3 Required handshake

Every connection must do this dance before any other request:

```text
→ { method: "initialize", id: 0, params: {
    clientInfo: { name, title, version },
    capabilities: { experimentalApi: true,
                    optOutNotificationMethods?: [...] }}}
← { id: 0, result: { codexHome, platformOs, userAgent, ... } }
→ { method: "initialized", params: null }
```

After `initialized` the connection is live and you can call any of
`thread/start`, `thread/list`, `thread/resume`, etc. Calling those
before the handshake gets you `"Not initialized"`.

`optOutNotificationMethods` is the only knob for trimming firehose
events — pass an array of method names you don't want, and the
server skips fanning them out. Useful for backend-only consumers
that don't render token usage updates, etc.

### 2.4 Thread / turn / item — the data model

Three nested concepts you'll see everywhere:

```
Thread          ── persistent conversation, identified by UUID
  Turn          ── one round-trip from a user message to turn/completed
    Item        ── a single payload: userMessage, agentMessage,
                   reasoning, commandExecution, fileChange, mcpToolCall,
                   plan, webSearch, imageView/Generation, ...
```

A `Turn` is the unit you fire with `turn/start`. An `Item` is what
gets streamed as the model produces output. Items have a `type`
discriminator (camelCase: `userMessage`, `agentMessage`,
`commandExecution`, `fileChange`, etc.) and stream their content
either as a final blob in `item/completed` or as deltas via
`item/agentMessage/delta`, `item/commandExecution/outputDelta`,
`item/reasoning/textDelta`, etc.

### 2.5 Notifications you'll see in practice

After `turn/start`, expect roughly this stream:

```
turn/started          ← turn metadata, status="inProgress"
item/started          ← user message item begins
item/completed        ← user message item ends
mcpServer/startupStatus/updated   ← MCP tools warming up (if any)
item/started          ← agent message item begins (text streaming starts)
item/agentMessage/delta × N
item/completed        ← agent message ends
item/started          ← commandExecution item, status="running"
item/commandExecution/outputDelta × N
item/completed        ← command status="completed"|"failed"
[ reasoning / file change items inline as needed ]
thread/tokenUsage/updated
thread/status/changed ← back to "idle"
turn/completed
```

Plus housekeeping that fires regardless of turn state:
`account/rateLimits/updated`, `configWarning`, `account/login/...`.

### 2.6 The list APIs are *not* equivalent

This caught us hard. Two methods that sound interchangeable are not:

- **`thread/list`** — paginated cursor-based list of *persisted*
  threads from `~/.codex/sessions/*.jsonl` rollouts. Returns
  `{ data: Thread[], nextCursor, backwardsCursor }`. Threads
  appear here only after their *first* turn writes a rollout.
- **`thread/loaded/list`** — list of *in-memory* thread IDs that
  the running app-server has touched. Returns
  `{ data: string[], nextCursor }` (just IDs, not Thread objects).
  A brand-new thread shows up here immediately on `thread/start`,
  long before it makes it to the persisted list.

For our recovery flow (§6.6) we have to consult **both** and merge.
Just using `thread/list` would miss recently-created threads;
just using `thread/loaded/list` misses persisted history.

### 2.7 `thread/resume` is required for turn events

The biggest finding from our multi-client probing, and not
documented anywhere: **a fresh WebSocket connection is automatically
subscribed to thread-level events but NOT turn-level events.**

Concretely, on connect you receive without further action:

- `thread/started`, `thread/status/changed`, `thread/closed`
- `thread/name/updated`, `thread/archived` / `unarchived`
- `account/*`, `configWarning`, `warning`

But you do **not** receive any of:

- `turn/started`, `turn/completed`
- `item/started`, `item/completed`
- `item/*/delta` (any kind)
- `serverRequest/*` (approvals)
- `turn/diff/updated`, `turn/plan/updated`

…unless you've called `thread/resume({ threadId })` for the thread
you want to follow.

> The natural mental model: a connection has a set of "subscribed
> threads". `thread/start` auto-adds the new thread. `thread/resume`
> manually adds an existing one.

Once *all* connected clients have resumed a given thread, every
event for that thread fans out to all of them in identical shape
(byte-for-byte, including JSON-RPC ids on approval requests).

There is no first-responder semantics: if two clients respond to
the same approval id, both responses are accepted with no error
and the resolution is non-deterministic at the wire layer (in our
test, `B.accept` won the race against `A.decline` even though A's
respond was sent first — the command executed).

### 2.8 The `thread/resume` chicken-and-egg

A brand-new thread (created via `thread/start`, no turns yet)
**cannot be resumed by another client** — you get
`{ code: -32600, message: "no rollout found for thread id ..." }`.

Codex only writes a rollout file after the first `turn/completed`.
So the second client has to either:

1. Wait for the first turn to land, then resume.
2. Skip resuming empty threads — they have no content to display
   anyway, and once the user sends a prompt the rollout will
   exist.

We took option 2 in `Session.recoverThreads()`. The wrinkle is
that for genuinely shared sessions (terminal TUI created the
thread, codex-rc wants to follow), codex-rc misses the *first*
turn's deltas because it can't resume in time. We trigger a
delayed `thread/resume` on `turn/completed` and pull history via
`thread/read({ includeTurns: true })` to fill the gap.

## 3. Architecture

### 3.1 Final shape

```
┌──────────────────┐                ┌──────────────────────────────┐
│  Phone / browser │  ─── HTTPS ──▶ │  Bun.serve (codex-rc) :9876  │ ◀── stdio child ─── codex app-server
│  React SPA       │  ◀── WSS ──── │  • token cookie auth          │       (private)
│  (Vite build)    │                │  • ServerMsg envelope ↔ JSON-RPC
└──────────────────┘                │  • thread/turn/item state hub
                                    └──────────────────────────────┘
                                                   │ (alternate transport)
                                                   ▼
                                    ┌──────────────────────────────┐
                                    │  codex app-server :9877      │ ◀── second client ─── terminal
                                    │  ws:// loopback, shared      │       `codex --remote ws://...`
                                    │  thread state                │
                                    └──────────────────────────────┘
```

We run **two codex-rc instances** in parallel:

- **stdio instance on `:9876`** — Phase-1 behavior. codex-rc spawns
  its own `codex app-server --listen stdio://` child, owns its
  lifecycle, single tenant.
- **ws instance on `:9886`** — attaches to a long-running
  `codex app-server --listen ws://127.0.0.1:9877`. Survives
  codex-rc restarts. Can be shared with terminal `codex --remote`.

Same React SPA, different cookie names (`codex_rc_token` vs
`codex_rc_token-ws`), different token files
(`~/.arche/codex-rc.token` vs `~/.arche/codex-rc-ws.token`). Both
URLs work simultaneously from the same phone (cookies don't bleed
because the cookie name is instance-suffixed — browsers don't
isolate cookies by port).

### 3.2 Why a bridge process at all

A natural question: why doesn't the phone connect directly to
`codex app-server`?

- **Origin header rejection.** Browsers send `Origin` on WebSocket
  upgrade. Codex's app-server rejects any request with an `Origin`
  set, by design (CSRF defense). Native apps without an Origin
  header could, in principle, connect direct.
- **Auth.** codex's ws transport has a `--ws-auth capability-token`
  flag but we want phone-side auth (HTTP cookies, OAuth in the
  future) on top of network-level reach (Tailscale). The bridge
  is a natural place to do that.
- **Wire format translation.** Codex emits a firehose of detailed
  events (`thread/tokenUsage/updated`, rate-limit pings,
  per-delta updates). We don't want to push all of that to a
  phone WebSocket — the bridge filters and aggregates into a
  smaller `ServerMsg` envelope.
- **State hub.** The bridge maintains in-memory thread state
  (items per thread, pending approvals, active turn id) so
  phone reconnects don't need to re-replay from scratch.

### 3.3 Wire envelope (codex-rc ↔ browser)

We don't expose codex's JSON-RPC to the browser. The bridge
translates in both directions to a small typed envelope defined
in `shared/protocol.ts`. Phone-side messages:

```ts
type ClientMsg =
  | { type: "hello" }
  | { type: "create_thread"; cwd?: string }
  | { type: "open_thread"; threadId: string }
  | { type: "send_text"; threadId: string; text: string }
  | { type: "approve"; requestId: string;
      decision: "accept" | "acceptForSession" | "decline" | "cancel" }
  | { type: "interrupt"; threadId: string }
  | { type: "delete_thread"; threadId: string };

type ServerMsg =
  | { type: "snapshot"; threads, pendingApprovals, defaultCwd }
  | { type: "thread_created" | "thread_updated" | "thread_deleted"; ... }
  | { type: "thread_history"; threadId; items: ChatItem[] }
  | { type: "item_appended" | "item_updated"; threadId; item: ChatItem }
  | { type: "approval_request"; approval }
  | { type: "approval_resolved"; requestId }
  | { type: "error"; message };
```

`ChatItem` is a discriminated union for the browser's render layer,
not a literal copy of codex's `Item` type. We map across in
`session.ts:mapItem()`. This indirection earned its keep multiple
times: when codex changed field names (`output` →
`aggregatedOutput`), the browser code never noticed.

### 3.4 Auth: token cookies over Tailscale

Two-layer model:

1. **Network reach** = Tailscale. The Bun server binds to `0.0.0.0`
   but the listening port is unreachable except over the user's
   tailnet (and from localhost). No public TLS terminator, no
   external internet exposure.
2. **App-level auth** = a randomly-generated bearer in a cookie.
   The token is created on first run, cached at
   `~/.arche/codex-rc${INSTANCE}.token`. The first-load URL carries
   it as `?t=<token>`; the server matches, sets `codex_rc_token`
   as an `HttpOnly + SameSite=Lax` cookie, then 302s to the same
   URL minus the query.

A wrinkle worth mentioning: **the cookie is not `Secure`**. We
don't terminate TLS — connections to Bun.serve are plain HTTP.
The encryption is provided by Tailscale's WireGuard mesh below
the HTTP layer. If you put a TLS terminator in front (Tailscale
Serve, caddy) you'd want to also flip the `Secure` attribute on,
but we haven't wired that up because the codex-rc process never
sees `https`.

Token-from-query always wins over cookie. This is deliberate for
rotation: if the token in `~/.arche/codex-rc.token` changes
between runs (deletion, env override), an old cookie shouldn't
lock the user out. Visit a fresh `?t=<new>` URL and the new
cookie replaces the stale one.

## 4. The web UI

Vite + React + Tailwind, single SPA, lazy-loaded chunks for
expensive parts. Total first-paint cost: ~177 KB JS / 57 KB gzip.

### 4.1 Responsive layout

Two breakpoints via Tailwind `md:` (768 px):

- **Mobile** — single screen at a time. Routes are `/` (chat list)
  and `/c/:threadId` (chat detail). The detail view shows a
  "← Back" link. Switching is a real route change with browser
  history.
- **Desktop / iPad** — split view. List pinned at 320 px on the
  left, detail fills the rest. No back link (it'd be redundant).

The mobile-first part: composer textarea is 16 px (`text-base`),
not 14 px, because iOS Safari auto-zooms when focusing an input
< 16 px font size — and that zoom never undoes itself, leaving the
send button half-clipped off-screen. The whole-screen container
is `h-[100dvh]` rather than `h-full` so the keyboard pop doesn't
shrink the chat area below the visible viewport.

Long unbreakable strings (URLs, paths, threadIds) blow flex
containers wide if you're not careful. Two pieces:

```
.flex-main { min-w-0; }              /* allow flex child to shrink */
.bubble    { [overflow-wrap:anywhere]; } /* break long atoms */
.scroll    { overflow-x-hidden; }    /* belt-and-suspenders */
```

### 4.2 Streaming render

Three rendering strategies for items:

- **Plain text bubbles** — `userMessage`. Whitespace preserved
  with `whitespace-pre-wrap`.
- **Markdown** — `agentMessage`. Lazy-loaded `react-markdown +
  remark-gfm + remark-breaks`. The `remark-breaks` plugin matters:
  CommonMark renders single newlines as a space, but codex
  routinely emits "step 1\nstep 2\nstep 3" patterns — without
  remark-breaks they'd collapse to one line. We also override
  the `<img>` component to render as a text chip rather than
  fetching remote URLs (privacy: don't leak Tailscale-side IP/UA
  to whichever host the model picks).
- **xterm.js terminal** — `commandExecution`. Lazy-loaded. Tracks
  written-byte-length-so-far so streaming `delta`s only write the
  new tail (preserves ANSI cursor positioning + colors).
  ResizeObserver on the container so phone rotation triggers
  `fit()`.

Both lazy chunks (`MarkdownText.js`, `CommandTerminal.js`) are
fetched only when you open a chat detail. The chat list page is
~57 KB gz with neither of them.

### 4.3 State management

`useSyncExternalStore` over a tiny shared store (`web/src/lib/store.ts`).
No Redux, no Zustand. The whole store is one closure:

```ts
let state: State = { ... };
const listeners = new Set<() => void>();
function set(patch) { state = { ...state, ...patch }; for (const l of listeners) l(); }

export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => sel(state),
    () => sel(state),
  );
}
```

Pitfall: selectors that materialize a fresh array each call (like
`s.itemsByThread[id] ?? []`) cause `useSyncExternalStore` to bail
into infinite re-render mode because each snapshot is `!==` the
previous. We hit this on Day 1. Fix: define a module-level
`EMPTY_ITEMS = []` and reuse it.

### 4.4 The approval banner

When codex sends a `serverRequest` (e.g.
`item/commandExecution/requestApproval`), we surface it three
ways:

1. **Local map** in `Session.approvals` keyed by the codex
   request id, so we know how to call `respond` later.
2. **Per-chat banner** at the top of the detail panel, with three
   buttons: Deny / Allow once / Allow this session.
3. **Global toaster** in the top-right — visible regardless of
   which chat the user is on. Tapping the toast routes to that
   chat.

Plus a subtle UI hint: when `thread.status === "awaitingApproval"`
(derived from codex's `activeFlags: ["waitingOnApproval"]`), the
typing dots disappear and a small amber "Waiting for approval —
scroll up to allow / deny" line shows at the end of the message
stream.

## 5. Multi-client semantics — the empirical findings

These were not documented upstream and we had to probe for them.
Probes are in `experiments/multi-client-probe/`. Findings shape
several of our design choices.

### 5.1 Setup: two clients, A and B, both `initialize`

Both connections work independently. The app-server has no
notion of a "primary" client. If you want N consumers driving
one agent, this just works.

### 5.2 What gets broadcast vs what's connection-specific

| Event | Broadcast to all connected? | Notes |
|---|---|---|
| `thread/started`, `thread/status/changed`, `thread/closed` | yes | thread-level lifecycle |
| `account/*`, `configWarning` | yes | global housekeeping |
| `mcpServer/startupStatus/updated` | only the connection that triggered it | observed: only A got it after `thread/start` |
| `turn/*` | only resumed clients | see §2.7 |
| `item/*` | only resumed clients | including `item/agentMessage/delta`, `commandExecution/outputDelta`, etc. |
| `serverRequest/*` (approvals) | all resumed clients, **same `id`** | confirmed in approval-probe-v3 |
| `serverRequest/resolved` | all resumed clients | regardless of who responded |

### 5.3 Approvals and the multi-respond race

Critical empirical result, since it affects UX correctness:

```
A.send turn that triggers approval
→ both A and B receive serverRequest id=1
A.respond(id=1, decline)
B.respond(id=1, accept)        // race
→ both A and B receive serverRequest/resolved
→ command actually executes (B's accept won)
→ neither client gets an error
```

**There is no first-respond-wins enforcement.** The decision that
takes effect is the *last* one the server processes (or
non-deterministic at the wire level). Implications:

- Don't double-respond from the same client (we hide the banner
  on local resolve to enforce this).
- A second user on a second device tapping a different button is
  legal; whichever arrives second wins. UX needs to communicate
  "you can't rely on first-clicker semantics".
- Without listening for `serverRequest/resolved`, a client whose
  response lost would still show the banner forever ("ghost
  approval"). We listen and clear — see §6.6.

### 5.4 Concurrent turn/start corrupts state

Don't try this at home. With both clients resumed on thread X,
both calling `turn/start` while a turn is running:

```
A.turn/start → response: { turnId: T_A, status: inProgress }
B.turn/start → response: { turnId: T_B, status: inProgress }   ← no error!
```

But the codex stderr starts emitting:
```
ERROR codex_core::session: failed to record rollout items: thread X not found
```

Internal codex state goes inconsistent. We treat this as a hard
"don't do" boundary — `Session.sendText` checks `t.activeTurnId`
and rejects with a busy error before forwarding. UI side, the
send button is disabled while `thread.status === "active"`.

### 5.5 The trusted-commands allowlist

`approvalPolicy: "untrusted" + sandboxPolicy: { type: "readOnly" }`
in our params **does not** make every shell call ask for
approval. `echo`, `pwd`, `ls`, `cat` (and probably more) are
hardcoded as trusted. To force an approval reliably you need a
command that actually escapes the sandbox: `mkdir
/private/tmp/...` (write outside cwd), `curl https://...` (network
denied), `apply_patch` outside writable roots.

This bit us during testing: we couldn't trigger an approval banner
with `ls` for fifteen minutes before realizing `ls` was on the
allowlist.

## 6. Pitfalls — every protocol gotcha we hit, in roughly chronological order

### 6.1 Field-name mistakes (cost: a day of phone testing)

Two fields we read wrong, leading to silent empty UI:

- `commandExecution` items expose stdout/stderr in
  **`aggregatedOutput`**, not `output`. Reading `item.output` gave
  `undefined` and the xterm rendered an empty box.
- `item/commandExecution/outputDelta` notifications carry the
  delta as a plain string in **`p.delta`**. There's a *different*
  notification, `CommandExecOutputDeltaNotification`, with
  `p.deltaBase64 + p.stream` — that one's used by `command/exec`
  (which is for streaming exec outside a thread). We were reading
  the wrong notification's fields.

How they snuck in: we wrote our handler from a sketch of the
protocol before reading the actual Rust types. Fix in PR #7.
Lesson: when the data layer says the field is empty, suspect
field-name drift before suspecting your stream-merge logic.

### 6.2 UTF-8 streaming corruption

`TextDecoder.decode(value)` without `{ stream: true }` corrupts
multi-byte UTF-8 split across read chunks — the decoder treats
each chunk as a complete sequence and emits replacement
characters at the boundary. Two bugs from this:

- Stdio JSON parse fails intermittently on Chinese / emoji /
  any 3-4 byte UTF-8 because the line that crossed a chunk
  boundary becomes un-parseable.
- Stderr forwarding shows `<?>` instead of real characters.

Fix: always pass `{ stream: true }` for incremental decoding,
and call `decoder.decode()` (no arg) once at EOF to flush any
half-character left in the buffer. Caught in PR #8 review.

### 6.3 WebSocket close races

The first WS transport's `close()` was:

```ts
async close() {
  this.closed = true;
  try { this.ws.close(1000, "client closing"); } catch {}
}
```

That returns immediately. A test that calls `close()` and
proceeds to spawn a fresh app-server on the same port often saw
"address in use" — the OS hadn't released the socket yet because
the close handshake hadn't completed.

Fix: await the `close` event with a 2s safety timeout. If the
timer wins (server unresponsive), log a warning and resolve
anyway, after detaching the listener so we don't leak a stale
resolve. PR #8 + PR #10.

### 6.4 `ready()` hangs on pre-open server-side close

The original `ready()` only awaited the ws `open` and `error`
events. When the server closed the connection without sending an
`error` (e.g. immediate disconnect after handshake), the open
promise hung until the configured open-timeout (10s). Fix: also
listen for `close` before `open` and reject promptly. PR #8.

### 6.5 Pending requests leaked on client close

`CodexClient.close()` set `closed = true` then called
`transport.close()`. The transport's onClose fires through to
`handleTransportClose`, which checked `closed` and bailed *without
rejecting in-flight pending requests*. Callers of `request()`
hung forever, pending map leaked.

Fix: extract a `rejectPending(err)` helper, call from both
`close()` and `handleTransportClose()`. PR #8.

### 6.6 `canConnect()` timeout was a no-op

```ts
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), timeoutMs);
const sock = await Bun.connect({ ... });   // ← AbortController never used
```

`Bun.connect` doesn't take an `AbortSignal`. The AbortController
was never wired in, so the timeout had **no effect** — the connect
just hung until OS-level SYN timeout (~75s on macOS by default).
Plus the timer leaked. Fix: `Promise.race(connect, sleep)`. PR #8.

### 6.7 Probe `0.0.0.0` doesn't connect

`parseWsUrl("ws://0.0.0.0:9877")` returned host=`0.0.0.0`, which
is a bind-any address, not a valid connect target. `canConnect`
always failed → `ensureAppServer` always thought the server was
down → re-spawned a redundant app-server even when one was
listening on "any". Fix: normalize `0.0.0.0`/`::`/`[::]` to
`127.0.0.1` for probing. PR #8.

### 6.8 Cookie isolation by port (false assumption)

**Browsers don't isolate cookies by port.** A cookie set by
`http://host:9876` is visible to `http://host:9886` if both have
the same hostname. When we tried running stdio + ws instances
side by side on the same Tailscale FQDN, the ws instance's
cookie clobbered the stdio one and vice versa.

Fix: scope cookie name + token file by `CODEX_RC_INSTANCE`. The
ws instance gets `codex_rc_token-ws` and
`~/.arche/codex-rc-ws.token`; the stdio default keeps its
unsuffixed names. PR #5.

### 6.9 Stacked PRs vs base-branch deletion

Operationally, not a code bug: when squash-merging the first PR
in a stack, GitHub deletes the head branch (per `--delete-branch`).
If a downstream PR's *base* was that just-deleted branch,
GitHub **auto-closes** the downstream PR rather than retargeting
it. Worse, you can't reopen it (the base branch is gone).

Lessons:
- Retarget all stacked PRs to `main` *before* merging the first.
- Or do what we eventually did: collapse the stack into 8
  sequential squash merges locally, push, post merge-sha
  references on each closed PR.

Either way, GitHub's PR-stacking story is not what you want for
deeply nested chains.

### 6.10 `bash -c '...; kill %1'` job control silently fails

The naive `start:both` script used `bash -c '<cmd1> & <cmd2>; kill %1'`.
In non-interactive bash, job control is off by default, so `%1`
doesn't resolve. Ctrl-C kills the foreground process but leaves
the background one running.

Workaround for now: leave it as is. Real fix: write a small bun
script that traps SIGINT/SIGTERM and explicitly kills both
children. Deferred.

### 6.11 Markdown rendering surprises

Two from CommonMark behavior:

- **Single newlines collapse to spaces.** `step 1\nstep 2\nstep 3`
  renders as one line. Fixed with `remark-breaks` plugin.
- **`<img>` fetches remote URLs.** Models occasionally emit
  `![](http://attacker.com/track.gif)`; without intervention the
  browser silently GETs that URL, leaking the Tailscale-side
  IP and User-Agent. Fix: override the `img` component to render
  the alt text as a small chip. The model could in theory inline
  data URLs for legitimate purposes — those still render fine.

### 6.12 Tests were chronically port-flaky

Hard-coding ports (9881/9882/9883) in integration tests works on
a clean dev machine and fails one weekday in five when something
else has the port. Fix: `getFreePort()` helper that binds 0,
reads back the assigned port, releases, returns it. Tiny
race-condition window between release and codex spawning, but in
practice fine because tests run sequentially.

Plus: `spawn(codex app-server, { stdout: "pipe", stderr: "pipe" })`
where you never read the streams will hang the child once
the pipe buffers fill. Use `"ignore"` if you don't need the
output, drain in a background loop if you do.

### 6.13 Tools that mostly work — but not entirely

- **Playwright requires Node 18.19+ for ESM**, even if Bun is
  the runtime. `bunx playwright` trips the version check despite
  Bun being current. We use `npx playwright test`. Documented.
- **Playwright `testMatch` defaults pick up everything in `testDir`** —
  including our `*.test.ts` files that import `bun:test`. Set
  `testMatch: /.*\.spec\.ts$/` so playwright stays out of bun's
  business and vice versa.

## 7. The implementation, phase by phase

For posterity, since the commit history compresses this:

- **Phase 0** — single-client probe (`experiments/probe/probe.ts`)
  to confirm protocol shapes. ~1 hour. Outputs that bun was a
  workable Bun runtime for this kind of stdio plumbing.
- **Phase 1** (#1) — codex-rc skeleton: stdio child, Bun.serve,
  React SPA, Tailscale-detected URL, token cookie, mobile-first
  responsive layout, streaming agent text + typing dots. ~3
  days. The core product.
- **Phase 2A** (#2) — split `codex-client.ts` into `CodexClient`
  (JSON-RPC) + `CodexTransport` interface + `StdioCodexTransport`
  + `WsCodexTransport`. Half a day. Pure refactor, no new UX.
- **Phase 2B** (#3) — recovery flow, turn lock,
  `serverRequest/resolved` listener. Half a day. Makes ws mode
  usable by surviving codex-rc restarts.
- **Phase 2C** (#4) — on-demand app-server spawn (detached so
  it survives codex-rc), `experiments/multi-client-probe/approval-probe-v3.ts`
  finally triggers a real approval (with `mkdir
  /private/tmp/...`), settles the multi-client semantics
  questions. Half a day.
- **Phase 2D** (#5) — `CODEX_RC_INSTANCE` knob → run stdio +
  ws side by side without cookie collisions. ~30 min.
- **Phase 2E** (#6) — `acceptForSession` button,
  `waitingOnApproval` UI state, xterm.js for command output
  (lazy chunk), launchd plist for codex-rc-ws. Half a day.
- **Phase 2F** (#7) — fix command output empty bug
  (`aggregatedOutput`), markdown agent rendering
  (react-markdown), YOLO defaults for approval/sandbox. ~2
  hours.
- **Phase 2G** (#8) — review fixes: WS close races, UTF-8
  streaming, pending-leak, canConnect timeout, parseWsUrl
  normalization, openThread error reply, ephemeral test ports.
  ~2 hours.
- **Phase 2H** (#9) — design choices: remark-breaks, img
  blocking, completed-output trust, env validation. ~30 min.
- **Phase 2I** (#10) — tiny followups for #8 / #9. ~15 min.

Total elapsed: roughly a week of evenings, with most of the time
spent on protocol exploration and fighting subtle bugs rather
than feature work.

## 8. Future: what changes for a native mobile app

Today's stack is tightly coupled to "the phone is a browser
inside the user's tailnet". Most of that has to change for a
native iOS / Android app distributed through stores. Here's the
delta, in roughly the order I'd implement it:

### 8.1 Network reach: replace Tailscale with a relay

Tailscale solved both NAT traversal and authentication for the
web prototype. A native app distributed through the App Store
can't realistically require users to set up Tailscale (and they
shouldn't have to). The natural replacement is a **relay
service**:

```
Native app ──── WSS ──▶ relay ──── WSS ──▶ codex-rc daemon
                          (auth + presence)         (laptop)
```

The relay runs on our infra (Cloud Run, Fly.io, …). Daemon
connects out to relay over WSS — no inbound connection on the
laptop, works behind any NAT. App connects out to relay
similarly. Relay matches the app to the daemon and forwards
frames.

Open design questions:

- **Pairing UX.** First-run device pairing: show a QR on the
  laptop containing a relay-issued code, app scans it. Or
  Apple-style sign-in-on-website + magic link. Anthropic's own
  Claude Code remote-control uses the latter (pasted into a
  webpage that issues a session ingress token).
- **End-to-end encryption.** If we don't trust the relay
  operator (us), the app and daemon should encrypt frames
  inside the WSS tunnel using a pairing-derived key. WebRTC
  data channels via the relay are one option; libsodium-style
  framing inside a normal WS is simpler and what we'd start
  with.
- **Multiple devices.** One user, multiple phones, one laptop
  daemon: relay needs to fan-out frames within a session.
  Today's codex-rc bridge already does this internally for
  multiple browser tabs; the relay just extends it across
  network.
- **Daemon discovery.** App needs to know which laptops the
  user has running. Relay tracks presence; app shows a list.

### 8.2 Auth: real OAuth, real device tokens

Token-in-cookie was fine for "the cookie never leaves my
phone over Tailscale". For a relay-mediated app:

- App ↔ relay: short-lived bearer tokens issued via OAuth or
  magic link. Refresh flow.
- Daemon ↔ relay: device-specific signing key. Pair with the
  user account at first run, never leaves the laptop. Use to
  sign authentication challenges from the relay.
- Daemon ↔ codex app-server: unchanged — it's still loopback.

This is roughly the same shape as Anthropic's CCR v2:
short-lived JWT issued by the cloud, refreshed every poll.

### 8.3 Push notifications

The biggest UX gap today: when the phone is locked and codex
pauses for an approval, the user doesn't know. Tailscale doesn't
help — the phone has to be *in* the app for the WebSocket to be
alive.

Native solution: APNs (iOS) / FCM (Android). The relay tracks
"this device wants notifications" and pushes a silent or visible
notification when the daemon reports `awaitingApproval`. Tapping
the notification deep-links into the app and opens the relevant
chat.

For the web prototype today, ntfy.sh is a reasonable stopgap:
the daemon HTTP-POSTs to a personal ntfy topic, the user's phone
shows a notification via the ntfy app. ~30 lines of code,
zero infra.

### 8.4 Offline message queue

Web today: if the WS drops, messages typed before reconnect are
lost (the `WebSocket.send` on a closed socket silently fails in
our `send()` helper). Native app: queue typed-but-unsent
messages locally, replay on reconnect with idempotency tokens.
Mark with a "sending…" state in the UI.

The daemon side needs a corresponding "received-but-not-yet-acked"
buffer so the app can replay without producing duplicate codex
turns. JSON-RPC ids + a small client-supplied dedup token would
be enough.

### 8.5 Voice and dictation

Codex already exposes experimental `thread/realtime/*` methods
for streaming audio. A native app on iOS / Android has direct
mic access; the app could speak realtime audio frames into the
relay → daemon → codex. Output as both text *and* synthesized
voice would make the "talk to your laptop while walking"
scenario actually work.

Bundle size doesn't matter on native, so a heavier client-side
audio stack (VAD, push-to-talk UI, waveform display) is fine.

### 8.6 Image and file attachments

Codex's `turn/start` already accepts `{ type: "localImage", path }`
and `{ type: "image", url }`. The web doesn't expose this. A
native app should let the user attach photos from camera roll
or live camera — useful for "look at this whiteboard, write the
code from it". Daemon-side: receive the image bytes over WS,
write to a temp file, pass `localImage: <path>` to codex.

### 8.7 Better diff renderer for `fileChange` items

Today these render as a one-line summary because we never wired
up a real diff component. `react-diff-viewer-continued` works
fine but adds bundle weight; we'd lazy-load it like xterm.

For native, this is more important — code review on a phone
needs side-by-side or inline-with-syntax-highlighting to be
usable.

### 8.8 acceptForSession trail

When the user picks "Allow this session" for `mkdir
/private/tmp/x`, codex remembers it, but the UI doesn't show
*what's been allowed*. Future iterations should display "this
session has approved: [list]" so the user can audit and revoke.

### 8.9 Multi-thread tabs on tablet/desktop

Right now split-view shows one chat at a time. iPad in landscape
could comfortably show 2-3 chats side by side, especially useful
for "agent A is doing X while agent B is doing Y" workflows.
Pure UI work.

### 8.10 Search

Once you've used codex-rc for a couple weeks and have 50+
threads in the sidebar, finding "the chat where I refactored the
auth middleware" is currently scroll-and-eyeball. Need
full-text search over thread titles + first user message + any
notes. Codex emits enough to build this server-side; relay-side
search index would scale better but is more infra.

## 9. Operational notes

A few lessons from a week of running this:

- **Keep the running app-server detached from codex-rc.** Phase
  2C does this with `Bun.spawn({ detached: true }).unref()`, so
  killing codex-rc doesn't kill the agent's working state.
  Restart codex-rc, recover via `thread/list` +
  `thread/loaded/list`, you're back where you were.
- **The launchd plist lives in `launchd/com.user.codex-rc-ws.plist`**
  and `bin/install-launchd.sh install` renders + loads it. We
  intentionally only auto-start the ws instance via launchd; the
  stdio instance is the "I'll start it when I want it" mode.
- **The detached app-server's logs** end up at
  `~/.codex/logs/codex-rc-app-server.log`. It's useful to tail
  this when something looks weird — codex emits its own internal
  state errors (`failed to record rollout items: thread X not
  found`) here when the protocol is being abused.
- **YOLO defaults** mean codex never asks before writing or
  running. We set this because phone-driven codex-rc is annoying
  if it interrupts every two minutes. Override per-instance:

  ```bash
  CODEX_RC_APPROVAL_POLICY=untrusted CODEX_RC_SANDBOX_MODE=readOnly bun run start
  ```

  Both are validated against closed enums at boot — typo exits
  immediately with a clear message.

## 10. Summary recommendations for someone building this again

1. **Read the codex protocol Rust source first**, not the README.
   Field names there are camelCased automatically; the README's
   examples sometimes use the snake_case form which doesn't match
   the wire.
2. **Start with stdio**, then add ws when you need shared
   sessions. Don't unify too early — the transport interface
   (`CodexTransport` in our code) is a 30-line file.
3. **Probe multi-client semantics on a real app-server.** Do
   not trust your reading. The connection-level subscription
   model and the lack of first-respond-wins were both
   surprising.
4. **Stream bytes, not lines.** UTF-8 multi-byte sequences will
   bite you at chunk boundaries.
5. **Build the wire envelope between your server and your
   client decoupled from codex's protocol.** When codex renames
   a field (and they will), you only patch one mapper.
6. **Don't trust the WebSocket close handshake to be quick.**
   Await with timeout, not just-fire-and-forget.
7. **Mobile = 16 px composer font, `100dvh`, `min-w-0`,
   `[overflow-wrap:anywhere]`.** Anything else and you're
   playing whack-a-mole with iOS.
8. **For stacked PRs** (we ran 9 deep), retarget to `main`
   *before* the first squash-merge, or you'll end up
   collapsing the stack manually like we did. GitHub's
   stacked-PR story is bad.
9. **Plan for the relay** from day one even if you don't build
   it yet. Tailscale-only is a fine start, but make sure your
   wire envelope and auth model don't bake in "the network is
   trusted" assumptions you'll need to undo.

## Appendix A — protocol cheat sheet

The methods we actually use (`*` = client-initiated, `←` =
server notification, `?→` = server-initiated request):

```
* initialize { clientInfo, capabilities }
                → { codexHome, platformOs, userAgent, ... }
notification: initialized { } (client → server)

* thread/list { cursor?, limit?, sortKey?, sortDirection?, ... }
                → { data: Thread[], nextCursor, backwardsCursor }

* thread/loaded/list { cursor?, limit? }
                → { data: string[] (ids), nextCursor }

* thread/start { cwd?, model?, approvalPolicy?, sandboxPolicy?, ... }
                → { thread, model, modelProvider, sandbox, ... }

* thread/resume { threadId, history?, model?, approvalPolicy?, ... }
                → { thread, model, sandbox, ... } | error "no rollout found"

* thread/read { threadId, includeTurns? }
                → { thread } (with .turns populated when requested)

* thread/turns/list { threadId, cursor?, limit?, sortDirection? }
                → { data: Turn[], nextCursor, backwardsCursor }

* turn/start { threadId, input: ContentItem[], cwd?, model?, ... }
                → { turn: { id, status, items, ... } }

* turn/interrupt { threadId, turnId } → {}
* turn/steer { threadId, expectedTurnId, input: ContentItem[] } → { turnId }

← thread/started { thread }
← thread/status/changed { threadId, status: { type, activeFlags? } }
← thread/closed { threadId }
← thread/tokenUsage/updated { threadId, turnId?, tokenUsage }
← turn/started { threadId, turn }
← turn/completed { threadId, turn }
← turn/diff/updated { threadId, turnId, diff }
← turn/plan/updated { threadId, turnId, plan }
← item/started { item, threadId, turnId }
← item/completed { item, threadId, turnId }
← item/agentMessage/delta { threadId, turnId, itemId, delta }
← item/reasoning/textDelta { threadId, turnId, itemId, contentIndex, delta }
← item/reasoning/summaryTextDelta { threadId, turnId, itemId, summaryIndex, delta }
← item/commandExecution/outputDelta { threadId, turnId, itemId, delta }
← item/fileChange/outputDelta { threadId, turnId, itemId, delta }
← serverRequest/resolved { threadId, requestId }
← account/rateLimits/updated { rateLimits }
← mcpServer/startupStatus/updated { name, status, error }

?→ item/commandExecution/requestApproval { threadId, turnId, itemId, command, cwd, commandActions, reason }
?→ item/fileChange/requestApproval { threadId, turnId, itemId, reason }
?→ item/permissions/requestApproval { ... }
                client responds with: { id, result: { decision: "accept" | "acceptForSession" | "decline" | "cancel" } }
```

Item types we render (discriminator: `type`):
`userMessage`, `agentMessage`, `reasoning`, `commandExecution`,
`fileChange`. Codex emits more (`mcpToolCall`, `dynamicToolCall`,
`webSearch`, `imageView`, `imageGeneration`, …); we map the rest
to a generic fallback.

## Appendix B — file map

```
server/
├── index.ts                    Bun.serve, env config, transport pick
├── session.ts                  Thread/turn/item state, codex ↔ envelope
└── codex/
    ├── client.ts               JSON-RPC layer (id alloc, pending map)
    ├── lifecycle.ts            On-demand app-server spawn for ws mode
    └── transports/
        ├── types.ts            CodexTransport interface
        ├── stdio.ts            Spawn child + NDJSON
        └── ws.ts               Connect to ws app-server

shared/
└── protocol.ts                 Wire envelope between server and web

web/src/
├── App.tsx                     Routes + responsive split layout
├── main.tsx                    Entry
├── styles.css                  Tailwind + markdown prose-lite
├── lib/
│   └── store.ts                useSyncExternalStore + WS reconnect
├── routes/
│   ├── ChatList.tsx
│   └── Chat.tsx
└── components/
    ├── ApprovalToaster.tsx
    ├── CommandTerminal.tsx     xterm wrapper (lazy)
    └── MarkdownText.tsx        react-markdown wrapper (lazy)

experiments/                    Protocol probes (kept for reference)
├── probe/probe.ts              Phase 0 single-client stdio
└── multi-client-probe/         Phase 2 ws multi-client
    ├── probe.ts                Round 1: subscription model
    ├── approval-probe.ts       Round 2: thread/loaded/list
    ├── approval-probe-v2.ts    Round 2: -c policy override (still echo)
    └── approval-probe-v3.ts    Round 3: forced approval, race semantics

tests/
├── _helpers.ts                 getFreePort, waitListen
├── transport.test.ts           bun:test, both transports
├── recovery.test.ts            bun:test, restart + turn-lock
└── layout.spec.ts              playwright, responsive + round-trip

launchd/
└── com.user.codex-rc-ws.plist  LaunchAgent template

bin/
└── install-launchd.sh          Render plist + launchctl load

docs/
├── app-server-transport-plan.md           Codex's original proposal
├── shared-app-server-research.md          Empirical findings ledger
└── technical-report.md                    This document
```
