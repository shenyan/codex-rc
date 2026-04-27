// Renders agent text as Markdown. react-markdown + remark-gfm together
// are ~80 KB un-gzipped, so this component is lazy-loaded by Chat.tsx
// (React.lazy + Suspense) and ships in its own chunk that only
// downloads the first time you open a chat detail.

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
