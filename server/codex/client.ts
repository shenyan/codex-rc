// JSON-RPC client over a CodexTransport. Owns id allocation, the
// pending-request map, the initialize/initialized handshake, and the
// dispatch of incoming frames into one of three callback buckets:
//   - response       → resolves a pending request promise
//   - server request → onRequest(id, method, params)
//   - notification   → onEvent(msg)

import type { CodexTransport } from "./transports/types";

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
};

export type CodexEventHandler = (msg: any) => void;
export type CodexRequestHandler = (id: number, method: string, params: any) => void;

export interface CodexClientOptions {
  transport: CodexTransport;
  onEvent: CodexEventHandler;
  onRequest: CodexRequestHandler;
  /** Override clientInfo for `initialize`. */
  clientInfo?: { name: string; title: string; version: string };
  /** Capabilities to declare; defaults to { experimentalApi: true }. */
  capabilities?: Record<string, unknown>;
}

export class CodexClient {
  private transport: CodexTransport;
  private onEvent: CodexEventHandler;
  private onRequest: CodexRequestHandler;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private starting: Promise<void>;
  private closed = false;

  constructor(opts: CodexClientOptions) {
    this.transport = opts.transport;
    this.onEvent = opts.onEvent;
    this.onRequest = opts.onRequest;
    this.transport.onFrame((f) => this.handleFrame(f));
    this.transport.onClose((err) => this.handleTransportClose(err));
    this.starting = this.bootstrap(opts);
  }

  ready(): Promise<void> { return this.starting; }

  private async bootstrap(opts: CodexClientOptions) {
    await this.transport.ready();
    await this.request("initialize", {
      clientInfo: opts.clientInfo ?? { name: "codex_rc", title: "Codex Remote Control", version: "0.1.0" },
      capabilities: opts.capabilities ?? { experimentalApi: true },
    });
    this.notify("initialized", null);
  }

  private handleFrame(msg: any) {
    if (!msg || typeof msg !== "object") return;
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

  private handleTransportClose(err?: Error) {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(err ?? new Error("codex transport closed"));
  }

  private rejectPending(err: Error) {
    for (const [, p] of this.pending) {
      try { p.reject(err); } catch {}
    }
    this.pending.clear();
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.send({ method, params: params ?? null, id });
    });
  }

  notify(method: string, params: unknown) {
    this.transport.send({ method, params: params ?? null });
  }

  respond(id: number, result: unknown) {
    this.transport.send({ id, result });
  }

  respondError(id: number, code: number, message: string) {
    this.transport.send({ id, error: { code, message } });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    // Reject in-flight requests up front so callers don't hang. We can't
    // rely on the transport's onClose firing through to handleTransportClose
    // — handleTransportClose checks `closed` and bails, which is correct
    // (we don't want double-reject) but means we own the cleanup here.
    this.rejectPending(new Error("codex client closing"));
    await this.transport.close();
  }
}
