// Renders agent text as Markdown. Lazy candidate (react-markdown +
// remark-gfm together are ~80 KB un-gzipped) — but they're loaded on
// the chat detail route which already bundles xterm separately, so
// the marginal cost is fine to keep eager.

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  text: string;
  /** show a blinking cursor at the end while still streaming */
  streaming?: boolean;
}

export default function MarkdownText({ text, streaming }: Props) {
  return (
    <div className="markdown" data-testid="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Keep links from being clickable to the wrong place by
          // forcing target=_blank + rel.
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
      {streaming && <span className="opacity-50 animate-pulse">▌</span>}
    </div>
  );
}
