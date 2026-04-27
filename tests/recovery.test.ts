// Integration test: codex-rc Session can restart against a long-running
// `codex app-server` and recover its thread list + items.
//
//   bun test tests/recovery.test.ts
//
// Spawns a real app-server on a private port, talks to it via the
// WsCodexTransport. No browser, no Bun.serve — exercises the
// session.ts recovery path directly.

import { describe, it, expect } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { Session } from "../server/session";
import { WsCodexTransport } from "../server/codex/transports/ws";
import { getFreePort, waitListen } from "./_helpers";

function makeSession(port: number) {
  const transport = new WsCodexTransport({ url: `ws://127.0.0.1:${port}` });
  return new Session({
    defaultCwd: process.cwd(),
    defaultModel: null,
    transport,
  });
}

describe("Session recovery", () => {
  let server: Subprocess | null = null;

  it("recovers threads created by a previous Session", async () => {
    const port = await getFreePort();
    // stdout/stderr ignored so a chatty app-server can't fill its
    // pipe buffers and stall under load.
    server = spawn({
      cmd: ["codex", "app-server", "--listen", `ws://127.0.0.1:${port}`],
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    try {
      await waitListen("127.0.0.1", port);

      // ── pass 1: create a thread + run a turn so a rollout is written
      const s1 = makeSession(port);
      await s1.ready();
      let createdId = "";
      const captured: any[] = [];
      const unsub = s1.subscribe((m) => captured.push(m));
      await s1.handleClientMsg({ type: "create_thread" }, () => {});
      // wait for thread_created broadcast
      const startedAt = Date.now();
      while (Date.now() - startedAt < 5000) {
        const ev = captured.find((m) => m.type === "thread_created");
        if (ev) { createdId = ev.thread.id; break; }
        await Bun.sleep(50);
      }
      expect(createdId).not.toBe("");

      // run a turn so rollout is persisted
      await s1.handleClientMsg(
        { type: "send_text", threadId: createdId, text: "Reply 'ok'." },
        () => {},
      );
      // wait for turn/completed (status returns to idle)
      const turnStart = Date.now();
      while (Date.now() - turnStart < 60000) {
        const t = (s1.snapshot() as any).threads.find((x: any) => x.id === createdId);
        if (t && t.status === "idle" && t.preview) break;
        await Bun.sleep(100);
      }
      unsub();

      // ── pass 2: brand-new Session against same app-server should
      //         recover this thread.
      const s2 = makeSession(port);
      await s2.ready();
      const snap: any = s2.snapshot();
      const recovered = snap.threads.find((x: any) => x.id === createdId);
      expect(recovered).toBeDefined();
      expect(recovered.id).toBe(createdId);

      // open_thread should populate items via thread/read
      const replyMsgs: any[] = [];
      await s2.handleClientMsg(
        { type: "open_thread", threadId: createdId },
        (m) => replyMsgs.push(m),
      );
      const history = replyMsgs.find((m) => m.type === "thread_history");
      expect(history).toBeDefined();
      expect(Array.isArray(history.items)).toBe(true);
      expect(history.items.length).toBeGreaterThan(0);
      // should have at least one user + one agent item
      expect(history.items.some((it: any) => it.kind === "user")).toBe(true);
      expect(history.items.some((it: any) => it.kind === "agent")).toBe(true);
    } finally {
      server?.kill();
      await Promise.race([server?.exited ?? Promise.resolve(), Bun.sleep(2000)]);
    }
  }, 120_000);

  it("rejects send_text when a turn is already in flight", async () => {
    const port = await getFreePort();
    server = spawn({
      cmd: ["codex", "app-server", "--listen", `ws://127.0.0.1:${port}`],
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    try {
      await waitListen("127.0.0.1", port);
      const s = makeSession(port);
      await s.ready();
      let createdId = "";
      const captured: any[] = [];
      s.subscribe((m) => captured.push(m));
      await s.handleClientMsg({ type: "create_thread" }, () => {});
      const startedAt = Date.now();
      while (Date.now() - startedAt < 5000) {
        const ev = captured.find((m) => m.type === "thread_created");
        if (ev) { createdId = ev.thread.id; break; }
        await Bun.sleep(50);
      }
      expect(createdId).not.toBe("");

      // First turn — long-running so we can race a second one.
      const reply1: any[] = [];
      await s.handleClientMsg(
        { type: "send_text", threadId: createdId, text: "Count slowly from 1 to 30, one per line." },
        (m) => reply1.push(m),
      );
      // Second turn must be rejected with an error reply.
      // Wait briefly for activeTurnId to be set via turn/started notification.
      await Bun.sleep(800);
      const reply2: any[] = [];
      await s.handleClientMsg(
        { type: "send_text", threadId: createdId, text: "Hi" },
        (m) => reply2.push(m),
      );
      const err = reply2.find((m) => m.type === "error");
      expect(err).toBeDefined();
      expect(String(err.message)).toContain("busy");

      // Tidy: interrupt the running turn so server doesn't burn quota.
      const summary = (s.snapshot() as any).threads.find((x: any) => x.id === createdId);
      if (summary?.status === "active") {
        await s.handleClientMsg({ type: "interrupt", threadId: createdId }, () => {});
      }
    } finally {
      server?.kill();
      await Promise.race([server?.exited ?? Promise.resolve(), Bun.sleep(2000)]);
    }
  }, 120_000);
});
