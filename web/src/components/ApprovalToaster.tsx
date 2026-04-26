import { useNavigate } from "react-router-dom";
import { useStore } from "../lib/store";

// Tiny global notice when an approval lands and you're not on that chat.
export default function ApprovalToaster() {
  const pending = useStore((s) => s.pendingApprovals);
  const nav = useNavigate();
  if (pending.length === 0) return null;

  return (
    <div
      className="fixed top-2 right-2 z-50 flex flex-col gap-2 max-w-[80vw]"
      data-testid="approval-toaster"
    >
      {pending.slice(-3).map((p) => (
        <button
          key={p.requestId}
          className="bg-amber-500/90 text-black rounded-lg px-3 py-2 text-xs shadow-lg text-left"
          onClick={() => nav(`/c/${p.threadId}`)}
        >
          ⚠ Approval needed{p.command ? `: ${p.command.slice(0, 40)}` : ""}
        </button>
      ))}
    </div>
  );
}
