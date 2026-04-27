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
import { getFreePort, waitListen } from "./_helpers";

function makeClient(transport: any) {
  return new CodexClient({
    transport,
    onEvent: () => {},
    onRequest: () => {},
  });
}

describe("StdioCodexTransport", () => {
  it("initializes and answers thread/list", async () => {
    const t = new StdioCodexTransport();
    const client = makeClient(t);
    await client.ready();
    const res: any = await client.request("thread/list", {});
    expect(res).toBeDefined();
    expect(typeof res).toBe("object");
    await client.close();
  }, 30000);
});

describe("WsCodexTransport", () => {
  let server: Subprocess | null = null;

  it("initializes against a real codex app-server --listen ws://", async () => {
    const port = await getFreePort();
    // stdout/stderr "ignore" so a chatty app-server can't fill a pipe
    // buffer and stall the child mid-test.
    server = spawn({
      cmd: ["codex", "app-server", "--listen", `ws://127.0.0.1:${port}`],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await waitListen("127.0.0.1", port);
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
