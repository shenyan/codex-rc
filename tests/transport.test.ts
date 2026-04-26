// Smoke tests for the codex transport layer. Spawns a real
// `codex app-server` for each transport and verifies the
// JSON-RPC handshake completes.
//
// Run with: bun test tests/transport.test.ts

import { describe, it, expect } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { CodexClient } from "../server/codex/client";
import { StdioCodexTransport } from "../server/codex/transports/stdio";
import { WsCodexTransport } from "../server/codex/transports/ws";

const events: any[] = [];
const reqs: { id: number; method: string; params: any }[] = [];

function makeClient(transport: any) {
  return new CodexClient({
    transport,
    onEvent: (msg) => events.push(msg),
    onRequest: (id, method, params) => reqs.push({ id, method, params }),
  });
}

async function waitListen(port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const s = await Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: { data() {}, close() {}, error() {}, open() {} },
      });
      s.end();
      return;
    } catch {}
    await Bun.sleep(150);
  }
  throw new Error(`port ${port} did not open in ${timeoutMs}ms`);
}

describe("StdioCodexTransport", () => {
  it("initializes and answers thread/list", async () => {
    const t = new StdioCodexTransport();
    const client = makeClient(t);
    await client.ready();
    const res: any = await client.request("thread/list", {});
    expect(res).toBeDefined();
    // thread/list shape: paginated `{ data: [...], nextCursor }` per probes.
    // Just confirm we got a structured result, not the exact key name.
    expect(typeof res).toBe("object");
    await client.close();
  }, 30000);
});

describe("WsCodexTransport", () => {
  let server: Subprocess<"ignore", "pipe", "pipe"> | null = null;
  const port = 9881;

  it("initializes against a real codex app-server --listen ws://", async () => {
    server = spawn({
      cmd: ["codex", "app-server", "--listen", `ws://127.0.0.1:${port}`],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await waitListen(port);
      const t = new WsCodexTransport({ url: `ws://127.0.0.1:${port}` });
      const client = makeClient(t);
      await client.ready();
      const res: any = await client.request("thread/list", {});
      expect(res).toBeDefined();
      expect(typeof res).toBe("object");
      await client.close();
    } finally {
      server?.kill();
      await Promise.race([server?.exited ?? Promise.resolve(), Bun.sleep(2000)]);
    }
  }, 30000);
});
