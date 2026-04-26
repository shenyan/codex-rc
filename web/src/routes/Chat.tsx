import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { send, useStore } from "../lib/store";
import type { ChatItem } from "../../../shared/protocol";

const EMPTY_ITEMS: ChatItem[] = [];

export default function Chat({ threadId }: { threadId: string }) {
  const thread = useStore((s) => s.threads.find((t) => t.id === threadId));
  const items = useStore((s) => s.itemsByThread[threadId] ?? EMPTY_ITEMS);
  const allPending = useStore((s) => s.pendingApprovals);
  const pending = useMemo(() => allPending.filter((p) => p.threadId === threadId), [allPending, threadId]);
  const connected = useStore((s) => s.connected);
  const [text, setText] = useState("");

  useEffect(() => {
    if (!connected) return;
    send({ type: "open_thread", threadId });
  }, [threadId, connected]);

  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [items.length, items[items.length - 1] && (items[items.length - 1] as any).text?.length]);

  function submit() {
    const t = text.trim();
    if (!t) return;
    send({ type: "send_text", threadId, text: t });
    setText("");
  }

  return (
    <div className="h-full flex flex-col">
      <header className="px-4 pt-[max(env(safe-area-inset-top),12px)] pb-3 border-b border-border flex items-center gap-3">
        <Link to="/" className="md:hidden text-emerald-400 text-sm" data-testid="back-btn">
          ← Back
        </Link>
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate">{thread?.title ?? "New chat"}</div>
          <div className="text-xs text-muted truncate">{thread?.cwd}</div>
        </div>
        {thread?.status === "active" && (
          <button
            className="text-xs bg-red-500/20 text-red-300 rounded px-2 py-1"
            onClick={() => send({ type: "interrupt", threadId })}
          >
            Interrupt
          </button>
        )}
      </header>

      {pending.length > 0 && (
        <div className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-3" data-testid="approval-banner">
          {pending.map((p) => (
            <div key={p.requestId} className="flex items-start justify-between gap-3 text-sm">
              <div className="min-w-0">
                <div className="font-medium text-amber-200">
                  Approve {p.kind === "command" ? "command" : p.kind}?
                </div>
                {p.command && <code className="text-xs text-amber-100/90 break-all">{p.command}</code>}
                {p.reason && <div className="text-xs text-muted mt-1">{p.reason}</div>}
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  data-testid="approve-deny"
                  onClick={() => send({ type: "approve", requestId: p.requestId, decision: "decline" })}
                  className="bg-zinc-700 text-zinc-100 rounded px-2 py-1 text-xs"
                >
                  Deny
                </button>
                <button
                  data-testid="approve-accept"
                  onClick={() => send({ type: "approve", requestId: p.requestId, decision: "accept" })}
                  className="bg-emerald-600 text-white rounded px-2 py-1 text-xs"
                >
                  Allow
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 space-y-4" data-testid="messages">
        {items.map((item) => <ItemView key={item.id} item={item} />)}
        {items.length === 0 && <div className="text-muted text-sm">No messages yet.</div>}
        {thread?.status === "active" && <TypingDots />}
      </div>

      <form
        className="border-t border-border p-3 pb-[max(env(safe-area-inset-bottom),12px)] flex gap-2"
        onSubmit={(e) => { e.preventDefault(); submit(); }}
      >
        <textarea
          data-testid="composer"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          placeholder="Send message…"
          className="flex-1 bg-panel rounded-lg px-3 py-2 text-base resize-none border border-border focus:outline-none focus:border-emerald-500/50 max-h-40"
        />
        <button
          data-testid="send-btn"
          type="submit"
          disabled={!text.trim()}
          className="bg-emerald-600 disabled:bg-zinc-700 text-white rounded-lg px-4 text-sm"
        >
          Send
        </button>
      </form>
    </div>
  );
}

function TypingDots() {
  return (
    <div className="flex" data-testid="typing">
      <div className="bg-panel border border-border rounded-2xl px-3 py-2 flex gap-1">
        <span className="h-2 w-2 rounded-full bg-muted animate-bounce [animation-delay:-0.3s]" />
        <span className="h-2 w-2 rounded-full bg-muted animate-bounce [animation-delay:-0.15s]" />
        <span className="h-2 w-2 rounded-full bg-muted animate-bounce" />
      </div>
    </div>
  );
}

function ItemView({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex justify-end" data-testid="msg-user">
          <div className="bg-emerald-600 text-white rounded-2xl px-3 py-2 max-w-[85%] whitespace-pre-wrap [overflow-wrap:anywhere]">
            {item.text}
          </div>
        </div>
      );
    case "agent":
      return (
        <div className="flex" data-testid="msg-agent">
          <div className="bg-panel border border-border rounded-2xl px-3 py-2 max-w-[85%] whitespace-pre-wrap [overflow-wrap:anywhere]">
            {item.text}
            {item.streaming && <span className="opacity-50 animate-pulse">▌</span>}
          </div>
        </div>
      );
    case "reasoning":
      return (
        <details className="text-xs text-muted" data-testid="msg-reasoning">
          <summary className="cursor-pointer">reasoning</summary>
          <div className="mt-1 whitespace-pre-wrap">{item.text}</div>
        </details>
      );
    case "command":
      return (
        <div className="font-mono text-xs bg-black/40 border border-border rounded-lg p-2" data-testid="msg-command">
          <div className="text-emerald-300">$ {item.command}</div>
          {item.output && <pre className="text-zinc-300 whitespace-pre-wrap mt-1">{item.output}</pre>}
          <div className="text-[10px] text-muted mt-1">{item.status}</div>
        </div>
      );
    case "fileChange":
      return (
        <div className="text-xs text-muted border border-border rounded-lg p-2" data-testid="msg-file">
          📝 {item.summary} <span className="opacity-60">({item.status})</span>
        </div>
      );
    default:
      return <div className="text-xs text-muted">{(item as any).text}</div>;
  }
}
