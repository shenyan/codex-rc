// State hub: holds threads + chat items + pending approvals; translates
// codex notifications into our wire protocol; broadcasts to WS clients.

import { CodexClient } from "./codex-client";
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

  constructor(defaultCwd: string, defaultModel: string | null) {
    this.defaultCwd = defaultCwd;
    this.defaultModel = defaultModel;
    this.codex = new CodexClient({
      onEvent: (msg) => this.handleNotification(msg),
      onRequest: (id, method, params) => this.handleServerRequest(id, method, params),
    });
  }

  ready() { return this.codex.ready(); }

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
        const t = this.threads.get(msg.threadId);
        if (t) reply({ type: "thread_history", threadId: t.summary.id, items: t.items });
        break;
      }
      case "send_text":
        await this.sendText(msg.threadId, msg.text);
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

  private async sendText(threadId: string, text: string) {
    const t = this.threads.get(threadId);
    if (!t) throw new Error("unknown thread " + threadId);
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
      case "thread/started":
        // already handled in createThread
        break;

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
        if (t) t.activeTurnId = null;
        this.updateSummary(t!, { status: "idle", lastActiveAt: Date.now() });
        break;

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

function summarizeFileChange(item: any): string {
  if (item.summary) return item.summary;
  const changes = item.changes ?? item.files ?? [];
  if (Array.isArray(changes) && changes.length) {
    return changes.map((c: any) => c.path ?? c.file).filter(Boolean).join(", ");
  }
  return "file change";
}
