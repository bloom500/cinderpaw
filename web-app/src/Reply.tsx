import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * The agent's words, as Markdown. Shown raw they read as **stars** and
 * `ticks` (seen live 25 Sep). react-markdown drops raw HTML, so nothing the
 * model writes can put a script or a form on this page.
 */
export function Reply(props: { text: string }) {
  return (
    <div className="text md">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{ a: (a) => <a href={a.href} target="_blank" rel="noopener noreferrer">{a.children}</a> }}
      >
        {props.text}
      </Markdown>
    </div>
  );
}
