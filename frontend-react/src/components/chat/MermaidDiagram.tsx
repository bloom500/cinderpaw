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
/** `a` mixed into `b` by `t` (0-1). Mermaid needs plain hex: it derives its own shades from them. */
function mix(a: string, b: string, t: number): string {
  const hex = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const [x, y] = [hex(a), hex(b)];
  return `#${x.map((c, i) => Math.round(c * t + y[i] * (1 - t)).toString(16).padStart(2, '0')).join('')}`;
}

/** The app's colours as Mermaid theme variables, read from the root so a theme change follows. */
function warmTheme(dark: boolean): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => {
    const v = css.getPropertyValue(name).trim();
    return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
  };
  // The surface tokens are translucent glass, so the paper colour is fixed per theme.
  const paper = dark ? '#36302B' : '#FBF7F1';
  const brand = token('--brand', '#B15129');
  const text = token('--text-primary', dark ? '#F6EFE6' : '#2F2A26');
  const muted = token('--text-muted', dark ? '#CDBFB2' : '#6F5747');
  return {
    background: paper,
    primaryColor: mix(brand, paper, 0.12),
    primaryBorderColor: mix(brand, paper, 0.45),
    primaryTextColor: text,
    secondaryColor: mix(brand, paper, 0.06),
    tertiaryColor: paper,
    lineColor: muted,
    textColor: text,
    edgeLabelBackground: paper,
    clusterBkg: mix(brand, paper, 0.05),
    clusterBorder: mix(brand, paper, 0.3),
  };
}

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
          // `base` is the one theme Mermaid lets us recolour: the boards' warm
          // nodes and brand lines (System Diagram, 1 Oct), not its default lilac.
          theme: 'base',
          themeVariables: warmTheme(dark),
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
