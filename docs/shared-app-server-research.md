# Shared Codex App-Server: Research, Findings, and Phase 2 Plan

> Companion to `docs/app-server-transport-plan.md` (the original codex-written
> proposal). This document captures the empirical findings from two rounds
> of WebSocket multi-client probes, settles open questions where it can,
> flags the questions that remain, and lays out a concrete, ordered
> implementation plan for moving `codex-rc` off its private stdio child
> process and onto a shared, long-running `codex app-server`.

## 0. Recap of where we are today

### 0.1 Phase 1 (shipped)

`codex-rc` today is a single Bun process that:

1. Spawns a private `codex app-server --listen stdio://` child.
2. Speaks JSON-RPC over NDJSON across that child's stdin/stdout
   (`server/codex-client.ts`, `server/session.ts`).
3. Translates codex notifications into a small `ServerMsg` envelope
   (`shared/protocol.ts`).
4. Serves a Vite-built React SPA over WS on port 9876 with token-cookie
   auth (`server/index.ts`), reachable from the phone via Tailscale.

There is exactly one client per app-server, exactly one app-server per
codex-rc process, and exactly one codex-rc process per machine. Threads
live in the codex-rc process's memory; `~/.codex/sessions/*.jsonl`
rollout files exist on disk but are not surfaced.

### 0.2 What we want to add

The phone-side UX is already fine. What we want is to share the
underlying `codex app-server` between codex-rc and a local terminal
(currently the user's `codex` TUI), so that:

- The same threads are visible from both surfaces.
- Restarting codex-rc does not kill the agent's working state.
- A future second consumer (mobile native app, scripts) can attach to
  the same agent without inventing a new transport.

The codex CLI's `codex --remote` accepts only `ws://` and `wss://`
URLs. **Modifying codex CLI is off the table.** That eliminates the
unix-socket-as-primary-transport option for end-to-end TUI sharing,
because the TUI cannot connect over a unix socket today.

This forces the choice: **the shared transport is WebSocket over TCP
on loopback.**

## 1. Methodology

We ran two empirical probes against `codex 0.121.0` / `0.125.0`
(version drifted mid-investigation, no behavior differences observed)
on macOS 14.6.1.

| Probe | Path | Purpose |
|---|---|---|
| `experiments/probe/probe.ts` | `experiments/probe/probe.ts` | Phase-0 single-client protocol confirmation over stdio |
| `experiments/multi-client-probe/probe.ts` | round-1 multi-client | event fan-out, list visibility, race semantics |
| `experiments/multi-client-probe/approval-probe.ts` | round-2 attempt 1 | `thread/loaded/list`, approval routing |
| `experiments/multi-client-probe/approval-probe-v2.ts` | round-2 attempt 2 | tried `-c approval_policy="untrusted"` to force approval |

All raw transcripts are in `/tmp/multi-probe.log`,
`/tmp/approval-probe.log`, `/tmp/approval-probe-v3.log`. Where this
document quotes specific event flows, those are the sources.

### 1.1 Wire format reminder

- `ws://IP:PORT` framing: one JSON-RPC message per WebSocket text frame.
- Stdio framing (the current codex-rc child): newline-delimited JSON.
- No `"jsonrpc":"2.0"` header on the wire.
- All three message kinds — request, response, notification, plus
  server-initiated request — share one channel.
- A "server-initiated request" is exactly an inbound message that has
  *both* `id` and `method`. The client is expected to reply with
  `{ id, result }` or `{ id, error }` matching that id.

## 2. Findings

This section is the empirical core. Every claim cites the test that
established it.

### 2.1 Multi-client basics — confirmed

**Two WebSocket clients can connect to one app-server simultaneously.**

Both clients independently send `initialize` (with their own
`clientInfo`) and `initialized`. The app-server identifies them
separately in subsequent fan-out. There is no client registry / no
"primary" / no "owner" client at the protocol level — just N attached
WebSockets.

> Verified in `multi-client-probe/probe.ts` setup section. Both A and
> B init, both work normally afterward.

### 2.2 Connection-level subscription model — important

This is the single most important finding for the architecture, and it
is **not** documented anywhere in the codex repo I could find.

> A new WebSocket connection is automatically subscribed to
> **thread-level lifecycle events** for every thread in the app-server,
> but is **not** subscribed to **turn-level / item-level events** for
> any thread. To receive turn/item events for a specific thread, a
> client must call `thread/resume(threadId)` on that thread.

Concretely, on a brand-new connection without any `thread/resume`
calls, the client *will* receive:

- `thread/started`
- `thread/status/changed`
- `thread/closed` (presumably; not directly observed)
- `thread/archived` / `thread/unarchived`
- `thread/name/updated`
- `thread/tokenUsage/updated` (only after the connection has resumed
  the relevant thread; see §2.4 — there is some inconsistency here
  worth re-checking)
- `mcpServer/startupStatus/updated` *only* on the connection that
  triggered the startup (i.e. the connection that called
  `thread/start`); other connections did not receive it
- `account/rateLimits/updated` (broadcast to all connections currently
  receiving turn events; not always to passive listeners)
- `configWarning`, `warning`, `account/updated`, `account/login/...`
  (presumably global; not isolated in tests)

But the same connection will *not* receive any of:

- `turn/started` / `turn/completed`
- `item/started` / `item/completed`
- `item/agentMessage/delta`
- `item/reasoning/textDelta` / `item/reasoning/summaryTextDelta`
- `item/commandExecution/outputDelta`
- `item/fileChange/outputDelta`
- `turn/diff/updated`
- `turn/plan/updated`
- `model/rerouted`
- approval requests (`item/commandExecution/requestApproval`, etc.)
  *most likely* — this was not directly tested with two passive
  clients, but follows the pattern

…unless that connection has explicitly called `thread/resume` for the
thread in question.

> Verified in `probe.ts` T2 vs T3:
> - T2: A creates thread, B receives `thread/started`. ✅
> - T3: A starts a turn, B receives **0** turn/started, **0** deltas,
>   **0** turn/completed. ❌
> - T4: B calls `thread/resume(threadId)`.
> - T5: A starts another turn, B receives **all** turn/started,
>   deltas, item events, turn/completed. ✅

This means the implementation has to **actively resume** every thread
it wants to track. The natural pattern: on connect, call
`thread/loaded/list` (and/or `thread/list`), then `thread/resume` each
returned id.

### 2.3 Once both clients are resumed, fan-out is byte-symmetric

After both clients have resumed the same thread, every event from a
new turn appears on both, in the same order, with identical params.
This includes streaming `item/agentMessage/delta`, full
`commandExecution` start/complete pairs, `item/started` /
`item/completed` for every item type, and `turn/started` /
`turn/completed`.

> Verified in `probe.ts` T5: agent message delta count A=1 B=1 with
> identical itemId; turn/started, turn/completed both present on both
> sides; user-message item/started+item/completed both present on
> both.

There is no apparent backpressure / ack scheme on the WebSocket.
Slow-consumer behavior was not tested.

### 2.4 `thread/loaded/list` vs `thread/list` — separate worlds

After A creates a thread (no turns yet):

- `A.thread/list({})` returns `count=0`, the new id is **not** present.
- `A.thread/loaded/list({})` returns `data=[<new id>]`.
- `B.thread/loaded/list({})` returns the same `data=[<new id>]`.

> Verified in `approval-probe.ts` T1.

Interpretation:

- `thread/loaded/list` returns app-server's in-memory active threads.
  This is the right API for "what is happening right now."
- `thread/list` returns persisted/rolled-out threads from disk
  (`~/.codex/sessions/<date>/rollout-*.jsonl`). Only appears after a
  rollout has been written, which apparently does not happen until
  the first turn is recorded. This is the right API for "history,
  paginated."

Implementation implication: codex-rc's startup recovery flow needs
**both** sources, deduplicated by id:

```
loaded = thread/loaded/list()
recent = thread/list({ pageSize: N })
threads = unique([...loaded, ...recent])
```

### 2.5 `thread/resume` requires a rollout to exist

A brand-new thread (created via `thread/start`, no turns yet) cannot
be resumed by another client:

```
[B] >REQ thread/resume id=2
[B]  → error: { code: -32600,
                message: "no rollout found for thread id <id>" }
```

> Verified in `approval-probe.ts` first attempt (before T1.5 was
> added).

After A runs at least one `turn/start` and gets `turn/completed`, the
rollout file is written and `thread/resume` succeeds.

> Verified in `approval-probe.ts` T1.5 (warmup turn) → T2 (B resume
> succeeded after warmup).

**The hard implication for shared mode:** if codex-rc connects to a
running app-server and there is a thread in `thread/loaded/list` that
has not yet had a turn, codex-rc cannot subscribe to it via resume. It
would have to:

1. Wait for the *first* `turn/started` event (which it does receive
   without resuming), record the threadId, and then keep retrying
   `thread/resume` until it succeeds (typically after the first
   `turn/completed`).
2. Or simply skip empty threads in the recovery list — they have no
   content to display anyway, and as soon as the user sends the first
   prompt the rollout will exist.

Option (2) is simpler and matches the UX: "empty threads are
ephemeral until you say something." Use it.

### 2.6 `thread/resume` response shape

```json
{
  "thread": { ... full Thread object ... },
  "model": "gpt-5.5",
  "modelProvider": "openai",
  "serviceTier": null,
  "cwd": "/Users/.../codex-rc",
  "instructionSources": [...],
  "approvalPolicy": "untrusted",
  "approvalsReviewer": "user",
  "sandbox": {
    "type": "workspaceWrite",
    "writableRoots": [".../.codex/memories"],
    "readOnlyAccess": { "type": "fullAccess" },
    "networkAccess": false,
    ...
  },
  "permissionProfile": null,
  "reasoningEffort": null
}
```

This is enough to populate codex-rc's per-thread state without
synthesizing it from prior `thread/start` parameters. Notable:

- `model` is the resolved model the thread is actually running under,
  not whatever default was configured at startup.
- `sandbox` includes the realized policy with all default fields
  filled in.

### 2.7 Concurrent `turn/start` is **not** mutex'd

When A is mid-turn on thread X and B sends `turn/start` on the same
thread X, B's request **succeeds**:

- B's response contains a fresh `turnId` (different from A's).
- No error returned to either client.
- No queueing visible at the protocol level.

> Verified in `probe.ts` T6.

Subsequent server-side stderr observation:

```
ERROR codex_core::session: failed to record rollout items:
  thread <id> not found
```

This indicates *internal codex state goes inconsistent* under that
race. We should treat this as a hard "do not do this" boundary.

**Implementation implication:** codex-rc must enforce at-most-one
in-flight turn per thread *in its own layer*. Concretely, in
`session.ts`:

```ts
interface ThreadState {
  ...
  activeTurnId: string | null;   // already present
}
```

When handling a `send_text` envelope from a UI client:

```ts
if (t.activeTurnId !== null) {
  reply({ type: "error", message: "thread is busy; interrupt first" });
  return;
}
```

Plus the UI side:

- Disable the send button (and the "interrupt" affordance becomes
  primary) while `thread.status === "active"`.
- This is already partially in place; just needs to be enforced
  consistently.

A further wrinkle: in shared mode the *terminal TUI* could fire its
own `turn/start` while codex-rc thinks the thread is idle (because the
TUI is a separate ws client and codex-rc does not know about its
intent until it sees `turn/started` on the wire). codex-rc cannot
prevent this — but it can:

1. Treat `turn/started` notifications from any source as authoritative
   and update `activeTurnId` accordingly.
2. Require `activeTurnId === null` at *codex-rc's local request entry
   point*, accepting that two simultaneous non-coordinated humans on
   different surfaces is a UX problem the protocol cannot solve.

### 2.8 Approval routing — partially observed, mostly inferred

**Open question that could not be settled with `echo`-based prompts.**

We attempted to force an approval request by:

- `approvalPolicy: "untrusted"` (returned by server as `"untrusted"`,
  confirmed accepted)
- `sandboxPolicy: { type: "readOnly" }` in `thread/start` params —
  silently overridden by server, which returned
  `sandbox: { type: "workspaceWrite", ... }`
- `-c approval_policy="untrusted" -c sandbox_mode="read-only"` at
  `codex app-server` spawn time

In all configurations, the model running `echo probe-XYZ` produced a
`commandExecution` item that **completed successfully without any
`serverRequest/*` arriving on either client**. Both A and B saw
identical `item/started` + `item/completed` for the command, with
`output` containing the literal string output.

The likely explanation is a **trusted-commands allowlist** inside
codex that pre-approves "obviously safe" read-only utilities (`echo`,
`pwd`, `ls`, etc.) regardless of approval policy. A definitive forced
approval would need a command outside that allowlist — `mkdir
/private/tmp/...` (write outside cwd), `curl https://...` (network
access denied by default), or an `apply_patch` to a file outside
writableRoots.

We declined to keep iterating on this because:

1. Even if approval *does* fan out only to the originator, codex-rc
   can correct for that in its own layer (re-broadcast incoming
   approvals to all phone clients via its own ServerMsg envelope).
2. Even if approval fans out to all resumed clients, the same UI code
   on the codex-rc side handles it.
3. The `serverRequest/resolved` cleanup notification has the same
   property — codex-rc can fan it out itself.

**What we believe but did not verify:**

- Pattern guess: an approval `serverRequest` is sent to the
  *connection that triggered the turn*, and `serverRequest/resolved`
  is broadcast to all resumed connections after any one of them
  responds. This matches every other event-shape we observed (item
  events fan out to all resumed; lifecycle events fan out to all
  connected; new things tied to a specific in-flight RPC stay tied
  to that RPC's connection).
- If two clients attempt `respond(id, ...)` on the same approval id,
  the first respond wins and the second gets a JSON-RPC error like
  `id not found` or similar. **Untested.**

**What codex-rc must do regardless of which guess is right:**

1. When codex-rc receives any approval `serverRequest`, also push it
   to *all* connected UI clients (phone/desktop browsers). Phone
   clients may approve.
2. When codex-rc has called `respond` on an approval, broadcast its
   own `approval_resolved` ServerMsg to all UI clients. (Already
   done in `session.ts:respondApproval`.)
3. **Add a new listener:** when codex broadcasts `serverRequest/resolved`
   (because some *other* client of the shared app-server resolved an
   approval first), codex-rc must clean up its `approvals` map and
   broadcast `approval_resolved` to its UI clients. **This is missing
   from current `session.ts`.** It will manifest as a "ghost approval
   banner that never goes away" the first time a TUI handles an
   approval that the phone also has open.

### 2.9 A cosmetic codex bug worth noting

After the probe processes exit, `codex app-server` consistently logs:

```
ERROR codex_core::session: failed to record rollout items:
  thread <id> not found
```

This appears even in the happy path (no race). Best guess: the
session-cleanup task tries to flush rollout items after the thread
state has already been removed during shutdown. Not blocking for us.

### 2.10 Sandbox policy params from `thread/start` are silently
overridden

Sending `sandboxPolicy: { type: "readOnly" }` in `thread/start` did
not stick — the response showed `sandbox: { type: "workspaceWrite",
... }`. Either the param shape is different from what we sent, or the
server is using its own default and ignoring our request, or the
config-toml-level setting always wins over the per-thread param.

Since we never need to override sandbox from codex-rc (the user's
existing config-level settings are correct), this is a non-issue. But
worth knowing if we ever do want a "phone-only safer-defaults" mode.

## 3. Architectural decisions

### 3.1 Layered transport

Today `server/codex-client.ts` mixes two concerns: spawn the child and
speak NDJSON over its pipes. Split into:

```
server/
  codex/
    client.ts           # JSON-RPC layer: ids, pending map, dispatch,
                        # initialize handshake, request/notify/respond
    transports/
      stdio.ts          # spawn + NDJSON over child stdin/stdout
      ws.ts             # connect + JSON-RPC over WS frames
      types.ts          # CodexTransport interface
```

The `CodexClient` only depends on `CodexTransport`, never on a
particular transport. Switching transports is an env-driven choice in
`server/index.ts`.

```ts
interface CodexTransport {
  ready(): Promise<void>;
  send(frame: unknown): void;
  close(): Promise<void>;
  onFrame(cb: (frame: unknown) => void): void;
  onClose(cb: (err?: Error) => void): void;
}
```

Initial spawn-vs-attach choice in `index.ts`:

```ts
const transport =
  process.env.CODEX_RC_CODEX_TRANSPORT === "ws"
    ? new WsCodexTransport(process.env.CODEX_RC_CODEX_WS_URL!)
    : new StdioCodexTransport();
```

Default stays stdio so existing single-tenant deployments don't break.

### 3.2 Topology in shared mode

```
phone/desktop  ──https──▶  codex-rc Bun server (:9876, token cookie)
                                │ ws://127.0.0.1:9877  (loopback only)
                                ▼
                       codex app-server          ◀── another ws ──  TUI / scripts
                                │ stdio? unix?
                                ▼
                          openai backend
```

- **codex-rc → codex app-server**: WebSocket on loopback. No auth
  needed (kernel-enforced loopback isolation). Origin header is *not*
  set by Bun's WebSocket client, so codex's origin-rejection guard
  does not trigger.
- **browser → codex-rc**: unchanged. Same token cookie, same Tailscale
  exposure.
- **TUI → codex app-server**: `codex --remote ws://127.0.0.1:9877`
  (untouched codex CLI path).

### 3.3 Long-running app-server lifecycle

For the user's daily flow, the app-server should be running before
codex-rc tries to connect. Three options, in increasing ambition:

1. **Manual tmux** (simplest, matches the `app-server-transport-plan.md`
   sketch). User starts a tmux session that runs
   `codex app-server --listen ws://127.0.0.1:9877`. They reattach to
   inspect logs. Survives codex-rc restarts and TUI restarts. Does
   not survive laptop reboot / lid-close + crash.
2. **launchd plist** managed by codex-rc. Adds a small `codex-rc
   install-launchd` command that writes `~/Library/LaunchAgents/...`
   and `launchctl load`s it. Survives reboot. Logs to
   `~/.codex/logs/`. Highest reliability, but a chunk of new infra.
3. **codex-rc spawns it on demand if no app-server is reachable.**
   `codex-rc start` checks `ws://127.0.0.1:9877/healthz`; if not
   responding, it spawns codex app-server itself in a backgrounded
   process. That blurs the "shared" boundary (whoever started
   codex-rc owns the app-server's lifecycle), but it's the path with
   zero new ops burden.

Recommendation: **(3) for v1, (2) when we feel pain.** Keep (1)
documented as the "I want to control this myself" mode.

### 3.4 Recovery flow on connect

```
1. Open WebSocket, perform JSON-RPC `initialize`.
2. Send `initialized` notification.
3. `thread/loaded/list({})` → in-memory active threads.
4. `thread/list({ pageSize: 50 })` → recent persisted threads.
5. Merge by id, drop duplicates, sort by lastActiveAt desc.
6. For each thread with at least one prior turn:
   a. `thread/resume({ threadId })` to subscribe.
   b. `thread/read({ threadId })` to fetch items for the UI.
7. For each thread without a rollout (loaded but zero turns):
   a. Skip resume. Carry only the summary in state.
   b. When `thread/started` notifications continue to flow, they're
      already broadcast to all connections, so we'll see status
      updates even without a resume.
   c. As soon as the first `turn/completed` for that thread arrives,
      schedule a delayed `thread/resume` (small backoff to let the
      rollout flush) and `thread/read`.
```

This whole flow runs after every codex-rc restart, and on every WS
reconnect to the codex app-server (with backoff, exponential up to
15 s).

### 3.5 Race protection (from §2.7)

In `session.ts`, gate every UI-driven `turn/start`:

```ts
async function sendText(threadId: string, text: string, replyToUI: …) {
  const t = threads.get(threadId);
  if (!t) throw new Error("unknown thread");
  if (t.activeTurnId !== null) {
    replyToUI({ type: "error", message: "thread is busy; interrupt first" });
    return;
  }
  await codex.request("turn/start", { threadId, input: [{ type: "text", text }] });
  // activeTurnId will be set when we receive the turn/started notification
}
```

Update `activeTurnId` from notifications, not from request results
(because in shared mode the turn might be started by another client
and we only learn via the broadcast):

```ts
case "turn/started":
  if (t) t.activeTurnId = p.turn?.id ?? null;
  break;
case "turn/completed":
  if (t) t.activeTurnId = null;
  break;
```

UI side: `thread.status === "active"` is already wired to disable the
send button and show typing dots. No new code needed there.

### 3.6 The missing `serverRequest/resolved` listener (§2.8)

Add a handler to `Session.handleNotification`:

```ts
case "serverRequest/resolved": {
  const requestId = String(p.requestId);
  if (this.approvals.delete(requestId)) {
    this.broadcast({ type: "approval_resolved", requestId });
    // also flip the thread back from awaitingApproval → previous status
    // (simplest: do nothing here; the next thread/status/changed will
    // restore it).
  }
  break;
}
```

This makes codex-rc tolerate "another client (TUI, scripts) resolved
the approval first" without a stuck red banner. Even before shared
mode is rolled out, this fix is correct and worth landing.

### 3.7 What we are *not* changing

- The browser-facing wire envelope (`shared/protocol.ts`) is
  unchanged. Phones don't know whether codex-rc is talking to a
  spawned-stdio child or a shared ws app-server.
- Token cookie auth is unchanged.
- Tailscale exposure pattern is unchanged.
- The Phase-1 UI code (`web/src/...`) is unchanged.
- The unix-socket transport idea is **dropped**. It does not solve
  the TUI-sharing case (CLI doesn't take `--remote unix://`), and
  for the codex-rc → app-server hop, ws over loopback is just as
  fast and considerably simpler than HTTP-Upgrade-over-UDS.

## 4. Implementation plan

Two PR-sized increments. The first is mechanical and can ship before
the long-running app-server topology is ready.

### Phase 2A — Transport abstraction + WebSocket transport

**Goal:** `CODEX_RC_CODEX_TRANSPORT=ws CODEX_RC_CODEX_WS_URL=ws://127.0.0.1:9877`
makes codex-rc connect to a pre-running app-server. Default
(`stdio`) still spawns a child as today. No behavior change in
default mode.

**Changes:**

1. New files:
   - `server/codex/transports/types.ts` — `CodexTransport` interface
     and `TransportEvent` types.
   - `server/codex/transports/stdio.ts` — moves the spawn/child
     pumping logic out of `server/codex-client.ts`. Same NDJSON
     framing.
   - `server/codex/transports/ws.ts` — connects with Bun's native
     `WebSocket`; emits one frame per text message; reconnect with
     backoff on `close` if the upstream is supposed to be persistent.
   - `server/codex/client.ts` — replaces today's
     `server/codex-client.ts`. Owns ids, pending map, handshake.
2. Edit `server/index.ts`:
   - Read `CODEX_RC_CODEX_TRANSPORT` (`stdio` default, `ws` switch).
   - Construct the right transport, pass to `CodexClient`.
3. Edit `server/session.ts` only at the import line. No behavior
   change.
4. Tests:
   - `tests/transport-stdio.spec.ts` — exercises a happy-path
     init+start+turn against a real `codex app-server` over stdio.
     Mostly proves the refactor didn't break anything.
   - `tests/transport-ws.spec.ts` — same, but spawns
     `codex app-server --listen ws://127.0.0.1:PORT` in `beforeAll`
     and points codex-rc at it.

**Acceptance:**

- All Phase-1 Playwright tests pass under both `CODEX_RC_CODEX_TRANSPORT=stdio`
  and `=ws`.
- Manually: kill the codex-rc Bun process, leave the app-server
  running, restart codex-rc, observe phone reconnects and threads
  are still there (well, *will be* once 2B lands; in 2A threads are
  still in-memory in codex-rc so this is just connection liveness).

**Estimated effort:** half a day.

### Phase 2B — Recovery, dedup, race lock, resolved-listener

**Goal:** codex-rc can be restarted (or freshly started against an
already-running app-server) and recovers thread list + history from
the app-server, rather than the empty-memory it has today.

**Changes:**

1. `server/session.ts`:
   - On startup (`Session.ready()` returning), call
     `thread/loaded/list` + `thread/list`, dedupe, hydrate
     `this.threads` map.
   - For each thread with `turns.length > 0` (per `thread/list`
     metadata) call `thread/resume`. Skip empty ones; queue them to
     be resumed when their first `turn/completed` fires.
   - On `thread/resume` response: also call `thread/read({
     threadId, includeTurns: true })` (or whatever the actual API is
     — look up the param name) to fetch items, then push them into
     `t.items`.
   - Add `case "serverRequest/resolved"` handler (see §3.6).
   - Tighten `sendText` to refuse when `t.activeTurnId !== null`.
   - Track `activeTurnId` strictly from notifications, not from
     request results.
2. `web/src/lib/store.ts`:
   - On reconnect, the snapshot already brings everything; but also
     re-issue `open_thread` if a thread is currently selected (this
     is already done per §2.4 of `web/src/routes/Chat.tsx`).
3. New "soft lock UI": when the user has a thread selected and
   `thread.status === "active"`, the composer disables the send
   button and the interrupt button is the primary action (already
   the case for status-driven dots; needs to also clamp send).
4. Tests:
   - Restart-recovery integration test: app-server running with two
     threads from a previous session → start codex-rc → verify the
     UI sidebar shows both, with their last preview/title intact.
   - Concurrency test: two simultaneous WS clients into codex-rc
     each sending `send_text` on the same thread; second one gets a
     `{type:"error"}` reply, only one turn fires server-side.
   - Approval resolved cleanup: after the response goes back, the
     ServerMsg `approval_resolved` arrives and the UI dialog
     dismisses.

**Acceptance:**

- Full Playwright pass.
- Manual flow:
  1. Start `codex app-server --listen ws://127.0.0.1:9877`.
  2. Start codex-rc with `CODEX_RC_CODEX_TRANSPORT=ws`.
  3. Open phone, create thread A, send a prompt, get a response.
  4. Close codex-rc. Don't touch app-server.
  5. Restart codex-rc. Open phone. Thread A is still in the sidebar
     with its preview. Click in. Last conversation is still there.

**Estimated effort:** one day.

### Phase 2C — Long-running app-server lifecycle (optional v1)

The simplest version (option 3 from §3.3): when codex-rc starts and
`CODEX_RC_CODEX_TRANSPORT=ws`, it pings the configured ws URL
(actually, the matching `http://.../healthz`); if no answer in 1 s, it
spawns:

```bash
codex app-server --listen ws://<host>:<port>
```

and double-forks it so it survives codex-rc death. On healthy
reconnect, codex-rc just attaches.

This is small (~50 LOC) and entirely reversible.

The launchd plist version can come whenever.

**Estimated effort:** half a day.

## 5. Open questions / future probes

Things we could not settle empirically and would either re-test
during 2B implementation or accept as guesses:

| # | Question | Why it didn't get answered | When to revisit |
|---|---|---|---|
| Q1 | Does an approval `serverRequest` go to all resumed clients or only the turn originator? | `echo` is on a trusted-commands allowlist; we never triggered an approval. | Phase 2B integration test using `mkdir /private/tmp/x` or `curl https://example.com -o /tmp/x` to force it. |
| Q2 | If two clients respond to the same approval id, what happens to the second? | Same. | Same. |
| Q3 | Does `serverRequest/resolved` arrive on all resumed clients or only the responder? | Same. | Same. |
| Q4 | What does the app-server do when it has zero clients and an outstanding approval? Hold the turn? Time out? | Out of scope of probes so far. | Add "kill all clients while approval pending" test. |
| Q5 | What's the exact `thread/read` parameter shape — does it stream items via notifications or return them in the response? | Skipped to keep probes focused. | While implementing recovery in 2B, read codex source under `codex-rs/app-server-protocol/`. |
| Q6 | Are there any thread-level events that *only* the originating connection sees, beyond `mcpServer/startupStatus/updated`? | Saw the one example, didn't enumerate. | If anything looks "missing" on a non-origin client during 2B testing. |
| Q7 | What happens to in-flight turns and pending approvals when the app-server is killed? | Out of scope. | Crash-recovery story for production. |
| Q8 | Behavior under WS slow-consumer / backpressure: does the app-server drop frames? Buffer unboundedly? | Not tested. | If we see jankiness on slow phone connections. |
| Q9 | Param shape that actually overrides sandbox at `thread/start` (we sent `{type:"readOnly"}` and got `workspaceWrite` back). | Tried, gave up; not on critical path. | Only if we ever need per-phone-thread sandbox different from config.toml. |
| Q10 | Is there a way for codex-rc to tell the app-server "I'm gone, drop my subscriptions" cleanly, vs just closing the WS? | Not investigated. | Production hardening. |

## 6. Decisions log (i.e. things to *not* relitigate)

For posterity, so we don't go around the same tree later:

- **Unix-socket transport for codex-rc → app-server: dropped.** Adds
  a transport without solving the TUI-sharing case. No daemon-only
  win that ws-loopback doesn't already provide.
- **Codex CLI modifications: dropped.** User has explicitly rejected
  this path. Anything that requires changes to `codex --remote`
  (e.g. `codex resume <threadId> --remote ws://...`) is unavailable.
- **Browser-direct connection to codex app-server: never on the
  table.** Browser sends `Origin`, codex rejects. Even if it didn't,
  putting raw JSON-RPC through Tailscale is a worse security boundary
  than codex-rc's token-cookie auth.
- **stdio transport is not removed.** It stays as the default and as
  the fallback for "user has no app-server running and doesn't want
  to manage one." Simpler installs continue to work.
- **The wire envelope between codex-rc and the browser is frozen.**
  No web-side changes are needed for shared mode.
- **Thread handoff between phone and TUI is the user's job.** TUI
  user types `codex resume <id> --remote ws://127.0.0.1:9877`
  manually, copying the id from the phone. No automation. (Could be
  added later as a clipboard helper or QR code, but not v1.)

## 7. References

- Original codex proposal: `docs/app-server-transport-plan.md`
- Phase-0 protocol cheat sheet: live in this conversation's history
  and embodied in `experiments/probe/probe.ts`
- Round-1 multi-client probe: `experiments/multi-client-probe/probe.ts`
- Round-2 approval probe (incomplete due to allowlist): `experiments/multi-client-probe/approval-probe.ts`,
  `experiments/multi-client-probe/approval-probe-v2.ts`
- Phase-1 server: `server/codex-client.ts`, `server/session.ts`,
  `server/index.ts`
- Phase-1 wire envelope: `shared/protocol.ts`
- codex source (read locally for protocol shapes):
  `/Users/shengquanyan/work/dev/codex/codex-rs/app-server/`
