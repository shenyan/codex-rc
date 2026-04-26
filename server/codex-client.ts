// Thin JSON-RPC client over `codex app-server --listen stdio://`.
// Spawns one child process; speaks NDJSON.

import { spawn, type Subprocess } from "bun";

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
};

export type CodexEventHandler = (msg: any) => void;
export type CodexRequestHandler = (id: number, method: string, params: any) => void;

export class CodexClient {
  private proc: Subprocess<"pipe", "pipe", "pipe">;
  private buf = "";
  private dec = new TextDecoder();
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private onEvent: CodexEventHandler;
  private onRequest: CodexRequestHandler;
  private starting: Promise<void>;

  constructor(opts: { onEvent: CodexEventHandler; onRequest: CodexRequestHandler }) {
    this.onEvent = opts.onEvent;
    this.onRequest = opts.onRequest;
    this.proc = spawn({
      cmd: ["codex", "app-server", "--listen", "stdio://"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.starting = this.bootstrap();
    this.pumpStderr();
  }

  ready(): Promise<void> {
    return this.starting;
  }

  private async bootstrap() {
    this.pumpStdout();
    await this.request("initialize", {
      clientInfo: { name: "codex_rc", title: "Codex Remote Control", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", null);
  }

  private async pumpStdout() {
    const reader = this.proc.stdout.getReader();
    (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        this.buf += this.dec.decode(value);
        let nl: number;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (!line) continue;
          this.handleFrame(line);
        }
      }
    })();
  }

  private async pumpStderr() {
    const reader = this.proc.stderr.getReader();
    const dec = new TextDecoder();
    (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        process.stderr.write("[codex] " + dec.decode(value));
      }
    })();
  }

  private handleFrame(line: string) {
    let msg: any;
    try { msg = JSON.parse(line); } catch (err) {
      console.error("[codex-client] bad JSON:", line);
      return;
    }
    // Response to one of our requests
    if (typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      return;
    }
    // Server-initiated request (has both id and method)
    if (typeof msg.id === "number" && typeof msg.method === "string") {
      this.onRequest(msg.id, msg.method, msg.params);
      return;
    }
    // Notification
    if (typeof msg.method === "string") {
      this.onEvent(msg);
    }
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ method, params: params ?? null, id });
    });
  }

  notify(method: string, params: unknown) {
    this.write({ method, params: params ?? null });
  }

  respond(id: number, result: unknown) {
    this.write({ id, result });
  }

  respondError(id: number, code: number, message: string) {
    this.write({ id, error: { code, message } });
  }

  private write(frame: unknown) {
    const line = JSON.stringify(frame) + "\n";
    this.proc.stdin.write(line);
    this.proc.stdin.flush?.();
  }

  async close() {
    try { this.proc.stdin.end(); } catch {}
    await Promise.race([this.proc.exited, Bun.sleep(2000)]);
  }
}
