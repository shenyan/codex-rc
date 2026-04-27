// Spawns `codex app-server --listen stdio://` as a child process and
// frames JSON-RPC over its stdin/stdout as newline-delimited JSON.

import { spawn, type Subprocess } from "bun";
import type { CloseHandler, CodexTransport, FrameHandler } from "./types";

export interface StdioTransportOptions {
  /** Override the codex executable path (default: "codex" from PATH). */
  bin?: string;
  /** Extra args to pass before `app-server`. e.g. ["-c", 'foo="bar"']. */
  preArgs?: string[];
}

export class StdioCodexTransport implements CodexTransport {
  private proc: Subprocess<"pipe", "pipe", "pipe">;
  private buf = "";
  private dec = new TextDecoder();
  private frameHandlers: FrameHandler[] = [];
  private closeHandlers: CloseHandler[] = [];
  private closed = false;
  private startedAt = Promise.resolve();

  constructor(opts: StdioTransportOptions = {}) {
    const bin = opts.bin ?? "codex";
    const cmd = [bin, ...(opts.preArgs ?? []), "app-server", "--listen", "stdio://"];
    this.proc = spawn({
      cmd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.pumpStdout();
    this.pumpStderr();
    this.watchExit();
  }

  ready(): Promise<void> {
    return this.startedAt;
  }

  send(frame: unknown): void {
    if (this.closed) return;
    const line = JSON.stringify(frame) + "\n";
    this.proc.stdin.write(line);
    this.proc.stdin.flush?.();
  }

  onFrame(cb: FrameHandler): void {
    this.frameHandlers.push(cb);
  }

  onClose(cb: CloseHandler): void {
    this.closeHandlers.push(cb);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { this.proc.stdin.end(); } catch {}
    await Promise.race([this.proc.exited, Bun.sleep(2000)]);
  }

  // ────────────────  internals  ────────────────

  private async pumpStdout() {
    const reader = this.proc.stdout.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          // Flush so a trailing multi-byte UTF-8 sequence isn't dropped.
          this.buf += this.dec.decode();
          if (this.buf.trim().length) this.dispatchLine(this.buf.trim());
          this.buf = "";
          break;
        }
        // stream:true preserves multi-byte UTF-8 boundaries across chunks.
        this.buf += this.dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (line) this.dispatchLine(line);
        }
      }
    } catch (err) {
      // reader rejected — usually means proc exited; watchExit will fire close.
    }
  }

  private dispatchLine(line: string) {
    let frame: unknown;
    try { frame = JSON.parse(line); }
    catch { console.error("[codex stdio] bad JSON:", line); return; }
    for (const h of this.frameHandlers) {
      try { h(frame); } catch (err) { console.error("[codex stdio] frame handler:", err); }
    }
  }

  private async pumpStderr() {
    const reader = this.proc.stderr.getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          const tail = dec.decode();
          if (tail) process.stderr.write("[codex] " + tail);
          break;
        }
        process.stderr.write("[codex] " + dec.decode(value, { stream: true }));
      }
    } catch {}
  }

  private async watchExit() {
    const code = await this.proc.exited;
    if (this.closed) return;
    this.closed = true;
    const err = code === 0 ? undefined : new Error(`codex app-server exited with code ${code}`);
    for (const h of this.closeHandlers) {
      try { h(err); } catch {}
    }
  }
}
