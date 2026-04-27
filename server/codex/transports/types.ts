// CodexTransport — a thin abstraction over the byte channel between
// codex-rc and a `codex app-server`. The JSON-RPC layer (CodexClient)
// uses one of these without caring whether bytes flow over stdio
// pipes, a WebSocket, or anything else.

export type FrameHandler = (frame: unknown) => void;
export type CloseHandler = (err?: Error) => void;

export interface CodexTransport {
  /** Resolves once the transport is ready to send frames. */
  ready(): Promise<void>;

  /** Send one JSON-RPC frame (will be JSON-stringified by the transport). */
  send(frame: unknown): void;

  /** Subscribe to incoming frames. Each line/message → one call. */
  onFrame(cb: FrameHandler): void;

  /** Subscribe to transport close. `err` is undefined on graceful close. */
  onClose(cb: CloseHandler): void;

  /** Initiate shutdown. Resolves once the underlying channel is gone. */
  close(): Promise<void>;
}
