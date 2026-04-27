// Wire protocol between codex-rc server and web client.
// Codex-side JSON-RPC stays in server/codex/client.ts.

export type ThreadStatus = "idle" | "active" | "awaitingApproval" | "errored";

export interface ThreadSummary {
  id: string;
  title: string | null;
  cwd: string;
  status: ThreadStatus;
  lastActiveAt: number;
  preview: string;
}

export type ChatItem =
  | { kind: "user"; id: string; text: string; createdAt: number }
  | { kind: "agent"; id: string; text: string; createdAt: number; streaming?: boolean }
  | { kind: "reasoning"; id: string; text: string; createdAt: number; streaming?: boolean }
  | { kind: "command"; id: string; command: string; cwd?: string; output: string; status: "running" | "completed" | "declined" | "failed"; createdAt: number }
  | { kind: "fileChange"; id: string; summary: string; status: "pending" | "completed" | "declined" | "failed"; createdAt: number }
  | { kind: "system"; id: string; text: string; createdAt: number };

export interface ApprovalPending {
  requestId: string;
  threadId: string;
  itemId?: string;
  kind: "command" | "fileChange" | "permissions";
  command?: string;
  cwd?: string;
  reason?: string;
  createdAt: number;
}

// ────────────────  client → server  ────────────────
export type ClientMsg =
  | { type: "hello" }
  | { type: "create_thread"; cwd?: string }
  | { type: "open_thread"; threadId: string }
  | { type: "send_text"; threadId: string; text: string }
  | { type: "approve"; requestId: string; decision: "accept" | "acceptForSession" | "decline" | "cancel" }
  | { type: "interrupt"; threadId: string }
  | { type: "delete_thread"; threadId: string };

// ────────────────  server → client  ────────────────
export type ServerMsg =
  | { type: "snapshot"; threads: ThreadSummary[]; pendingApprovals: ApprovalPending[]; defaultCwd: string }
  | { type: "thread_created"; thread: ThreadSummary }
  | { type: "thread_updated"; thread: ThreadSummary }
  | { type: "thread_deleted"; threadId: string }
  | { type: "thread_history"; threadId: string; items: ChatItem[] }
  | { type: "item_appended"; threadId: string; item: ChatItem }
  | { type: "item_updated"; threadId: string; item: ChatItem }
  | { type: "approval_request"; approval: ApprovalPending }
  | { type: "approval_resolved"; requestId: string }
  | { type: "error"; message: string };
