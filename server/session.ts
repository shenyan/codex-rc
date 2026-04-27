// State hub: holds threads + chat items + pending approvals; translates
// codex notifications into our wire protocol; broadcasts to WS clients.

import { CodexClient } from "./codex/client";
import type { CodexTransport } from "./codex/transports/types";
import type {
  ApprovalPending,
  ChatItem,
  ClientMsg,
  ServerMsg,
  ThreadStatus,
  ThreadSummary,
} from "../shared/protocol";

type Subscriber = (msg: ServerMsg) => void;

interface ThreadState {
  summary: ThreadSummary;
  items: ChatItem[];
  activeTurnId: string | null;
}

export class Session {
  private codex: CodexClient;
  private threads = new Map<string, ThreadState>();
  private approvals = new Map<string, ApprovalPending & { codexRequestId: number }>();
  private subscribers = new Set<Subscriber>();
  readonly defaultCwd: string;
  readonly defaultModel: string | null;

  constructor(opts: { defaultCwd: string; defaultModel: string | null; transport: CodexTransport }) {
    this.defaultCwd = opts.defaultCwd;
    this.defaultModel = opts.defaultModel;
    this.codex = new CodexClient({
      transport: opts.transport,
      onEvent: (msg) => this.handleNotification(msg),
      onRequest: (id, method, params) => this.handleServerRequest(id, method, params),
    });
  }

  async ready() {
    await this.codex.ready();
    await this.recoverThreads();
  }

  /**
   * On startup, hydrate `this.threads` from whatever the app-server
   * already knows about, and resume each so we receive live
   * turn/item events. Tolerant of every API failing — empty state
   * is a fine fallback.
   */
  private async recoverThreads() {
    const loaded: any = await this.codex.request("thread/loaded/list", {}).catch(() => ({ data: [] }));
    const persisted: any = await this.codex.request("thread/list", {
      limit: 50,
      sortKey: "updatedAt",
      sortDirection: "desc",
    }).catch(() => ({ data: [] }));

    const seen = new Set<string>();
    for (const thread of (persisted.data ?? [])) {
      if (!thread?.id || seen.has(thread.id)) continue;
      seen.add(thread.id);
      this.hydrateFromThread(thread);
    }
    for (const id of (loaded.data ?? [])) {
      if (typeof id !== "string" || seen.has(id)) continue;
      seen.add(id);
      try {
        const r: any = await this.codex.request("thread/read", { threadId: id });
        if (r?.thread) this.hydrateFromThread(r.thread);
      } catch {
        // unreadable (likely no rollout yet) — skip; we'll learn about
        // it via thread/started later.
      }
    }
    // Resume so future turn/item events flow to us. Failures
    // ("no rollout found") are expected for brand-new threads;
    // they'll get auto-resumed once their first turn writes a rollout
    // (handled in turn/completed below).
    for (const id of seen) {
      this.codex.request("thread/resume", { threadId: id }).catch(() => {});
    }
    if (seen.size > 0) {
      console.log(`[codex-rc] recovered ${seen.size} thread(s) from app-server`);
    }
  }

  private hydrateFromThread(thread: any) {
    if (!thread?.id) return;
    if (this.threads.has(thread.id)) return;
    const ts = (thread.updatedAt ?? thread.createdAt ?? Math.floor(Date.now() / 1000));
    const summary: ThreadSummary = {
      id: thread.id,
      title: thread.name ?? firstUserMessage(thread)?.slice(0, 40) ?? null,
      cwd: thread.cwd ?? this.defaultCwd,
      status: "idle",
      lastActiveAt: ts * 1000,
      preview: thread.preview ?? lastAgentMessage(thread)?.slice(0, 80) ?? "",
    };
    const items: ChatItem[] = [];
    for (const turn of (thread.turns ?? [])) {
      for (const item of (turn.items ?? [])) {
        const ci = mapItem(item, true);
        if (ci) items.push(ci);
      }
    }
    this.threads.set(thread.id, { summary, items, activeTurnId: null });
  }

  subscribe(s: Subscriber): () => void {
    this.subscribers.add(s);
    return () => this.subscribers.delete(s);
  }

  private broadcast(msg: ServerMsg) {
    for (const s of this.subscribers) {
      try { s(msg); } catch (err) { console.error("subscriber error", err); }
    }
  }

  // ────────────────  client commands  ────────────────
  async handleClientMsg(msg: ClientMsg, reply: Subscriber): Promise<void> {
    switch (msg.type) {
      case "hello":
        reply(this.snapshot());
        break;
      case "create_thread":
        await this.createThread(msg.cwd ?? this.defaultCwd);
        break;
      case "open_thread": {
        await this.openThread(msg.threadId, reply);
        break;
      }
      case "send_text":
        await this.sendText(msg.threadId, msg.text, reply);
        break;
      case "approve":
        this.respondApproval(msg.requestId, msg.decision);
        break;
      case "interrupt": {
        const t = this.threads.get(msg.threadId);
        if (t?.activeTurnId) {
          await this.codex.request("turn/interrupt", { threadId: msg.threadId, turnId: t.activeTurnId }).catch((e) =>
            reply({ type: "error", message: String(e) }),
          );
        }
        break;
      }
      case "delete_thread":
        this.threads.delete(msg.threadId);
        this.broadcast({ type: "thread_deleted", threadId: msg.threadId });
        break;
    }
  }

  snapshot(): ServerMsg {
    return {
      type: "snapshot",
      threads: [...this.threads.values()].map((t) => t.summary),
      pendingApprovals: [...this.approvals.values()].map(({ codexRequestId, ...rest }) => rest),
      defaultCwd: this.defaultCwd,
    };
  }

  private async createThread(cwd: string) {
    const params: any = {
      cwd,
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite" },
    };
    if (this.defaultModel) params.model = this.defaultModel;
    const res: any = await this.codex.request("thread/start", params);
    const id: string = res.thread.id;
    const summary: ThreadSummary = {
      id,
      title: null,
      cwd: res.cwd ?? cwd,
      status: "idle",
      lastActiveAt: Date.now(),
      preview: "",
    };
    this.threads.set(id, { summary, items: [], activeTurnId: null });
    this.broadcast({ type: "thread_created", thread: summary });
  }

  private async openThread(threadId: string, reply: Subscriber): Promise<void> {
    let t = this.threads.get(threadId);
    // Lazy-hydrate items from rollout the first time we open a thread.
    // (Empty `items` in memory is the trigger; on subsequent opens we
    // just return what's there.)
    if (t && t.items.length === 0) {
      try {
        const r: any = await this.codex.request("thread/read", { threadId, includeTurns: true });
        const turns = r?.thread?.turns ?? [];
        for (const turn of turns) {
          for (const item of (turn.items ?? [])) {
            const ci = mapItem(item, true);
            if (ci) t.items.push(ci);
          }
        }
      } catch {
        // no rollout yet (brand-new thread) — that's fine, items stays empty.
      }
    }
    // Thread might exist on the app-server but not in our map (e.g. created by
    // another client between recoverThreads and now). Try a one-shot recovery.
    if (!t) {
      try {
        const r: any = await this.codex.request("thread/read", { threadId, includeTurns: true });
        if (r?.thread) {
          this.hydrateFromThread(r.thread);
          this.codex.request("thread/resume", { threadId }).catch(() => {});
          t = this.threads.get(threadId);
          if (t) this.broadcast({ type: "thread_created", thread: t.summary });
        }
      } catch {
        // not found — ignore
      }
    }
    if (t) reply({ type: "thread_history", threadId: t.summary.id, items: t.items });
  }

  private async sendText(threadId: string, text: string, reply: Subscriber): Promise<void> {
    const t = this.threads.get(threadId);
    if (!t) {
      reply({ type: "error", message: "unknown thread " + threadId });
      return;
    }
    if (t.activeTurnId !== null) {
      reply({ type: "error", message: "thread is busy; interrupt the running turn first" });
      return;
    }
    await this.codex.request("turn/start", {
      threadId,
      input: [{ type: "text", text }],
    });
  }

  // ────────────────  codex notifications  ────────────────
  private handleNotification(msg: any) {
    const m = msg.method as string;
    const p = msg.params ?? {};
    const threadId: string | undefined = p.threadId;
    const t = threadId ? this.threads.get(threadId) : undefined;

    switch (m) {
      case "thread/started": {
        const tt = p.thread;
        if (!tt?.id) break;
        if (this.threads.has(tt.id)) break; // we created it
        // Another client (e.g. terminal TUI) just created this thread.
        this.hydrateFromThread(tt);
        const local = this.threads.get(tt.id);
        if (local) this.broadcast({ type: "thread_created", thread: local.summary });
        // Resume eventually — first attempt will likely fail because
        // there's no rollout yet, so retry once turn/completed fires.
        this.codex.request("thread/resume", { threadId: tt.id }).catch(() => {});
        break;
      }

      case "thread/status/changed": {
        if (!t) break;
        const s = p.status?.type;
        const status: ThreadStatus =
          s === "idle" ? "idle" : s === "active" ? "active" : t.summary.status;
        this.updateSummary(t, { status });
        break;
      }

      case "turn/started":
        if (t) t.activeTurnId = p.turn?.id ?? null;
        break;

      case "turn/completed":
        if (!t) break;
        t.activeTurnId = null;
        this.updateSummary(t, { status: "idle", lastActiveAt: Date.now() });
        // First turn writes the rollout; if our earlier thread/resume
        // for this thread failed ("no rollout found"), try again now.
        // Cheap to call repeatedly — codex idempotently re-subscribes.
        if (threadId) this.codex.request("thread/resume", { threadId }).catch(() => {});
        break;

      case "serverRequest/resolved": {
        // Fired when the app-server retires a serverRequest — either
        // because we responded, or because another client of the same
        // shared app-server (e.g. terminal TUI) responded first.
        // Either way, drop the pending approval and tell the UI.
        const requestId = p.requestId !== undefined ? String(p.requestId) : "";
        if (requestId && this.approvals.delete(requestId)) {
          this.broadcast({ type: "approval_resolved", requestId });
        }
        break;
      }

      case "item/started":
      case "item/completed": {
        if (!t) break;
        const ci = mapItem(p.item, m === "item/completed");
        if (!ci) break;
        const existing = t.items.findIndex((x) => x.id === ci.id);
        if (existing >= 0) {
          t.items[existing] = ci;
          this.broadcast({ type: "item_updated", threadId: t.summary.id, item: ci });
        } else {
          t.items.push(ci);
          this.broadcast({ type: "item_appended", threadId: t.summary.id, item: ci });
        }
        if (ci.kind === "user" || ci.kind === "agent") {
          this.updateSummary(t, {
            preview: ci.kind === "agent" && (ci as any).text ? (ci as any).text.slice(0, 80) : t.summary.preview,
            title: t.summary.title ?? (ci.kind === "user" ? (ci as any).text.slice(0, 40) : null),
            lastActiveAt: Date.now(),
          });
        }
        break;
      }

      case "item/agentMessage/delta": {
        if (!t) break;
        const itemId = p.itemId as string;
        const delta = p.delta as string;
        const idx = t.items.findIndex((x) => x.id === itemId);
        if (idx >= 0 && t.items[idx].kind === "agent") {
          (t.items[idx] as any).text += delta;
          (t.items[idx] as any).streaming = true;
          this.broadcast({ type: "item_updated", threadId: t.summary.id, item: t.items[idx] });
        } else {
          const item: ChatItem = { kind: "agent", id: itemId, text: delta, createdAt: Date.now(), streaming: true };
          t.items.push(item);
          this.broadcast({ type: "item_appended", threadId: t.summary.id, item });
        }
        break;
      }

      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        if (!t) break;
        const itemId = p.itemId as string;
        const delta = p.delta as string;
        const idx = t.items.findIndex((x) => x.id === itemId);
        if (idx >= 0 && t.items[idx].kind === "reasoning") {
          (t.items[idx] as any).text += delta;
          (t.items[idx] as any).streaming = true;
          this.broadcast({ type: "item_updated", threadId: t.summary.id, item: t.items[idx] });
        } else {
          const item: ChatItem = { kind: "reasoning", id: itemId, text: delta, createdAt: Date.now(), streaming: true };
          t.items.push(item);
          this.broadcast({ type: "item_appended", threadId: t.summary.id, item });
        }
        break;
      }

      case "item/commandExecution/outputDelta": {
        if (!t) break;
        const itemId = p.itemId as string;
        const stream: string = p.stream ?? "stdout";
        const text = p.deltaBase64 ? new TextDecoder().decode(Buffer.from(p.deltaBase64, "base64")) : (p.delta ?? "");
        const idx = t.items.findIndex((x) => x.id === itemId);
        if (idx >= 0 && t.items[idx].kind === "command") {
          (t.items[idx] as any).output += `[${stream}] ${text}`;
          this.broadcast({ type: "item_updated", threadId: t.summary.id, item: t.items[idx] });
        }
        break;
      }

      default:
        // ignore others for now (token usage, rate limits, etc.)
        break;
    }
  }

  private updateSummary(t: ThreadState, patch: Partial<ThreadSummary>) {
    t.summary = { ...t.summary, ...patch };
    this.broadcast({ type: "thread_updated", thread: t.summary });
  }

  // ────────────────  codex server-initiated requests (approvals)  ────────────────
  private handleServerRequest(codexId: number, method: string, params: any) {
    const requestId = `${codexId}`;
    const threadId: string = params?.threadId;
    let kind: ApprovalPending["kind"] = "command";
    if (method.includes("fileChange")) kind = "fileChange";
    else if (method.includes("permissions")) kind = "permissions";
    const pending: ApprovalPending = {
      requestId,
      threadId,
      itemId: params?.itemId,
      kind,
      command: params?.command,
      cwd: params?.cwd,
      reason: params?.reason,
      createdAt: Date.now(),
    };
    this.approvals.set(requestId, { ...pending, codexRequestId: codexId });
    const t = this.threads.get(threadId);
    if (t) this.updateSummary(t, { status: "awaitingApproval" });
    this.broadcast({ type: "approval_request", approval: pending });
  }

  private respondApproval(requestId: string, decision: string) {
    const p = this.approvals.get(requestId);
    if (!p) return;
    this.approvals.delete(requestId);
    this.codex.respond(p.codexRequestId, { decision });
    this.broadcast({ type: "approval_resolved", requestId });
  }
}

// ────────────────  helpers  ────────────────

function mapItem(item: any, completed: boolean): ChatItem | null {
  if (!item) return null;
  switch (item.type) {
    case "userMessage": {
      const text = (item.content ?? []).map((c: any) => c.text).join("");
      return { kind: "user", id: item.id, text, createdAt: Date.now() };
    }
    case "agentMessage":
      return {
        kind: "agent",
        id: item.id,
        text: item.text ?? "",
        createdAt: Date.now(),
        streaming: !completed,
      };
    case "reasoning":
      return {
        kind: "reasoning",
        id: item.id,
        text: item.text ?? "",
        createdAt: Date.now(),
        streaming: !completed,
      };
    case "commandExecution":
      return {
        kind: "command",
        id: item.id,
        command: item.command ?? "",
        cwd: item.cwd,
        output: item.output ?? "",
        status: completed ? (item.status ?? "completed") : "running",
        createdAt: Date.now(),
      };
    case "fileChange":
      return {
        kind: "fileChange",
        id: item.id,
        summary: summarizeFileChange(item),
        status: completed ? (item.status ?? "completed") : "pending",
        createdAt: Date.now(),
      };
    default:
      return null;
  }
}

function firstUserMessage(thread: any): string | null {
  for (const turn of (thread.turns ?? [])) {
    for (const item of (turn.items ?? [])) {
      if (item?.type === "userMessage") {
        const text = (item.content ?? []).map((c: any) => c.text).filter(Boolean).join(" ").trim();
        if (text) return text;
      }
    }
  }
  return null;
}

function lastAgentMessage(thread: any): string | null {
  let last: string | null = null;
  for (const turn of (thread.turns ?? [])) {
    for (const item of (turn.items ?? [])) {
      if (item?.type === "agentMessage" && item.text) last = item.text;
    }
  }
  return last;
}

function summarizeFileChange(item: any): string {
  if (item.summary) return item.summary;
  const changes = item.changes ?? item.files ?? [];
  if (Array.isArray(changes) && changes.length) {
    return changes.map((c: any) => c.path ?? c.file).filter(Boolean).join(", ");
  }
  return "file change";
}
