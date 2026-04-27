// xterm.js wrapper for displaying commandExecution output. We track
// the previously-written byte length so streaming updates write only
// the delta — that keeps ANSI cursor positioning + colors intact.

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const DARK_THEME = {
  background: "#0b0d10",
  foreground: "#d8dee9",
  cursor: "#d8dee9",
  black: "#1f242c",
  red: "#bf616a",
  green: "#a3be8c",
  yellow: "#ebcb8b",
  blue: "#81a1c1",
  magenta: "#b48ead",
  cyan: "#88c0d0",
  white: "#e5e9f0",
};

interface Props {
  output: string;
  /** Bounded height in px (default 220). Container scrolls inside xterm. */
  maxHeight?: number;
}

export default function CommandTerminal({ output, maxHeight = 220 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenRef = useRef(0);

  // Mount once.
  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      convertEol: true,            // \n becomes \r\n; codex emits unix line endings
      cursorBlink: false,
      cursorStyle: "underline",
      disableStdin: true,           // read-only
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.15,
      scrollback: 5000,
      theme: DARK_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    try { fit.fit(); } catch {}
    termRef.current = term;
    fitRef.current = fit;

    // Refit on container resize so the terminal width tracks the layout
    // (e.g. the user rotating their phone or expanding the message panel).
    const ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      writtenRef.current = 0;
    };
  }, []);

  // Stream output deltas.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (output.length === writtenRef.current) return;
    if (output.length < writtenRef.current) {
      // Output replaced/shrunk (rare — happens if mapItem rebuilds it on
      // item/completed). Just clear and rewrite from the top.
      term.clear();
      term.write(output);
    } else {
      const delta = output.slice(writtenRef.current);
      term.write(delta);
    }
    writtenRef.current = output.length;
  }, [output]);

  return (
    <div
      ref={containerRef}
      className="rounded border border-border bg-bg overflow-hidden"
      style={{ height: maxHeight }}
      data-testid="command-terminal"
    />
  );
}
