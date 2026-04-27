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
  private didOpen = false;     // ws.onopen fired
  private closed = false;      // close() was called or ws closed
  private fired = false;       // onClose handlers already invoked

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
      const timer = setTimeout(
        () => reject(new Error(`ws open timeout after ${t}ms (url=${opts.url})`)),
        t,
      );
      const cleanup = () => clearTimeout(timer);
      this.ws.addEventListener("open", () => {
        cleanup();
        this.didOpen = true;
        resolve();
      }, { once: true });
      this.ws.addEventListener("error", (e) => {
        cleanup();
        // Only reject `opened` if we never made it open; post-open errors
        // are handled by the close handler below.
        if (!this.didOpen) reject(new Error("ws error before open: " + String((e as any).message ?? e)));
      }, { once: true });
      // If the server slams the connection shut before sending a frame,
      // browsers fire `close` without `error`. Without listening here
      // `ready()` would hang until the open-timeout. Fail fast.
      this.ws.addEventListener("close", () => {
        cleanup();
        if (!this.didOpen) reject(new Error("ws closed before open"));
      }, { once: true });
    });

    this.ws.addEventListener("message", (e) => this.handleFrame(e.data));
    this.ws.addEventListener("close", (e) => {
      // Don't surface onClose to subscribers until after `ready()` settled.
      // Pre-open closes are reported via the opened promise rejection.
      if (this.didOpen) {
        this.handleClose((e as CloseEvent).reason ? new Error((e as CloseEvent).reason) : undefined);
      } else {
        this.closed = true;
      }
    });
    this.ws.addEventListener("error", (e) => {
      if (this.didOpen && !this.fired) {
        this.handleClose(new Error("ws error: " + String((e as any).message ?? e)));
      }
    });
  }

  ready(): Promise<void> { return this.opened; }

  send(frame: unknown): void {
    if (this.closed) return;
    this.ws.send(JSON.stringify(frame));
  }

  onFrame(cb: FrameHandler): void { this.frameHandlers.push(cb); }
  onClose(cb: CloseHandler): void { this.closeHandlers.push(cb); }

  /**
   * Initiate a graceful WebSocket close and wait until the underlying
   * channel reports CLOSED, with a 2 s safety timeout. Resolves either
   * way; if the timer wins the underlying socket may not actually be
   * closed yet, in which case we log a warning so the caller can see
   * it in the server log instead of silently shipping past it.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ws.readyState === WebSocket.CLOSED) return;

    await new Promise<void>((resolve) => {
      const onClose = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        // Detach the listener — the close event might still fire later
        // and we don't want a stale `resolve` floating around.
        this.ws.removeEventListener("close", onClose);
        if (this.ws.readyState !== WebSocket.CLOSED) {
          console.warn(
            `[codex ws] close() timed out after 2s (readyState=${this.ws.readyState}); ` +
            `socket may still be open`,
          );
        }
        resolve();
      }, 2000);
      this.ws.addEventListener("close", onClose, { once: true });
      try {
        this.ws.close(1000, "client closing");
      } catch {
        clearTimeout(timer);
        this.ws.removeEventListener("close", onClose);
        resolve();
      }
    });
  }

  private handleFrame(raw: string | ArrayBuffer | Buffer) {
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
