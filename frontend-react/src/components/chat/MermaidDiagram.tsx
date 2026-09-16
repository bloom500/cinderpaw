import { useEffect, useRef, useState } from 'react';

/**
 * A ```mermaid fence, drawn.
 *
 * Mermaid is the diagram-as-text format GitHub, GitLab, Notion and Obsidian all
 * render inside Markdown, so it is what a model writes when it is asked for a
 * flow, a sequence or a state machine. Until now the app printed that text as
 * code and the user read the diagram in their head.
 *
 * Three things this component has to survive, in the order they bite:
 *  - A diagram that is still arriving. Half a fence is not valid Mermaid, so
 *    the source is shown until it parses, and swapped for the picture when it
 *    does. No error flashes while the model types.
 *  - A diagram that is simply wrong. The model invented syntax; that is not a
 *    crash, it is a code block, which is what the user sees.
 *  - A diagram that is hostile. The text comes from a model, and a model quotes
 *    whatever the web told it, so `securityLevel: 'strict'` stays: no click
 *    handlers, no raw HTML in labels. Do not relax it for prettier labels.
 *
 * Mermaid is ~500 KB and most replies contain no diagram, so it is imported on
 * first use rather than with the app.
 */
export function MermaidDiagram({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const idRef = useRef(`mermaid-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        // The app's theme lives on the root element (see globals.css), and a
        // dark diagram on a light page is the kind of detail that reads as a
        // widget bolted on from somewhere else.
        const dark = !document.documentElement.matches('[data-theme="light"]')
          && (document.documentElement.matches('[data-theme="dark"]')
            || window.matchMedia('(prefers-color-scheme: dark)').matches);
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: dark ? 'dark' : 'default',
          fontFamily: 'inherit',
        });
        await mermaid.parse(code); // throws while the fence is still arriving
        const { svg: rendered } = await mermaid.render(idRef.current, code);
        if (alive) setSvg(rendered);
      } catch {
        if (alive) setSvg(null); // stay on the source: it is still readable
      }
    })();
    return () => { alive = false; };
  }, [code]);

  if (!svg) return <code className="language-mermaid">{code}</code>;

  return (
    <div
      className="not-prose flex justify-center overflow-x-auto py-2"
      // The SVG is Mermaid's own output from source it parsed under
      // securityLevel 'strict', which is where the sanitising happens.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
