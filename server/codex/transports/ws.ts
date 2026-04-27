// Connects to an existing `codex app-server --listen ws://...`.
// One JSON-RPC message per WebSocket text frame.
//
// Reconnect policy: if the upstream closes unexpectedly, we surface
// onClose immediately (CodexClient decides whether to abandon or
// rebuild). We don't auto-reconnect inside the transport because
// JSON-RPC state (pending request ids, in-flight requests) lives in
// CodexClient and would have to be reset together.

import type { CloseHandler, CodexTransport, FrameHandler } from "./types";

export interface WsTransportOptions {
  url: string;
  /** Optional bearer for ws auth (only used if app-server has --ws-auth). */
  authToken?: string;
  /** Open timeout (default 10s). */
  openTimeoutMs?: number;
}

export class WsCodexTransport implements CodexTransport {
  private ws: WebSocket;
  private frameHandlers: FrameHandler[] = [];
  private closeHandlers: CloseHandler[] = [];
  private opened: Promise<void>;
  private closed = false;
  private fired = false;

  constructor(opts: WsTransportOptions) {
    const headers: Record<string, string> = {};
    if (opts.authToken) headers["Authorization"] = `Bearer ${opts.authToken}`;

    // Bun's WebSocket constructor accepts a second arg for headers via
    // the protocols overload; we pass via the options-style signature.
    this.ws = headers.Authorization
      ? new WebSocket(opts.url, { headers } as any)
      : new WebSocket(opts.url);

    this.opened = new Promise<void>((resolve, reject) => {
      const t = opts.openTimeoutMs ?? 10000;
      const timer = setTimeout(() => reject(new Error(`ws open timeout after ${t}ms (url=${opts.url})`)), t);
      this.ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener("error", (e) => { clearTimeout(timer); reject(new Error("ws error before open: " + String((e as any).message ?? e))); }, { once: true });
    });

    this.ws.addEventListener("message", (e) => this.handleFrame(e.data));
    this.ws.addEventListener("close", (e) => this.handleClose((e as CloseEvent).reason ? new Error((e as CloseEvent).reason) : undefined));
    this.ws.addEventListener("error", (e) => {
      // Only surface as close if open() resolved; pre-open errors go via opened.reject.
      if (!this.fired) this.handleClose(new Error("ws error: " + String((e as any).message ?? e)));
    });
  }

  ready(): Promise<void> { return this.opened; }

  send(frame: unknown): void {
    if (this.closed) return;
    this.ws.send(JSON.stringify(frame));
  }

  onFrame(cb: FrameHandler): void { this.frameHandlers.push(cb); }
  onClose(cb: CloseHandler): void { this.closeHandlers.push(cb); }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { this.ws.close(1000, "client closing"); } catch {}
  }

  private handleFrame(raw: string | Buffer | ArrayBuffer | Blob) {
    let text: string;
    if (typeof raw === "string") text = raw;
    else if (raw instanceof ArrayBuffer) text = new TextDecoder().decode(raw);
    else if (raw instanceof Buffer) text = raw.toString("utf-8");
    else { console.error("[codex ws] unsupported frame type"); return; }

    let frame: unknown;
    try { frame = JSON.parse(text); }
    catch { console.error("[codex ws] bad JSON:", text); return; }
    for (const h of this.frameHandlers) {
      try { h(frame); } catch (err) { console.error("[codex ws] frame handler:", err); }
    }
  }

  private handleClose(err?: Error) {
    if (this.fired) return;
    this.fired = true;
    this.closed = true;
    for (const h of this.closeHandlers) {
      try { h(err); } catch {}
    }
  }
}
