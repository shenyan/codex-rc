// Test utilities shared by the bun:test integration suites.

/**
 * Ask the OS for an unused TCP port by binding 0 and reading
 * back what was assigned. There's a tiny race window between
 * the close and the next bind; in practice fine because tests
 * spawn codex immediately afterward.
 */
export async function getFreePort(): Promise<number> {
  const srv = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = srv.port;
  await srv.stop();
  return port;
}

export async function waitListen(host: string, port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const s = await Bun.connect({
        hostname: host,
        port,
        socket: { data() {}, close() {}, error() {}, open() {} },
      });
      s.end();
      return;
    } catch {}
    await Bun.sleep(150);
  }
  throw new Error(`${host}:${port} did not open in ${timeoutMs}ms`);
}
