import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { BrandLogo } from '../brandLogos';

const SVG = import.meta.glob('/src/assets/brands/*.svg', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
// What the app gets for each file: a path, or the file itself inlined as data: when small.
const URL_OF = import.meta.glob('/src/assets/brands/*.svg', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
const bundled = (stem: string) => URL_OF[`/src/assets/brands/${stem}.svg`];

describe('brand logos', () => {
  it('draws a file bundled with the app, never a URL off the internet', () => {
    const { container } = render(<BrandLogo id="slack" name="Slack" />);
    const src = container.querySelector('img')?.getAttribute('src') ?? '';
    expect(src).toBe(bundled('slack'));
    expect(src).not.toMatch(/^https?:/);
  });

  it("swaps in the brand's own dark version with the theme", () => {
    const imgs = render(<BrandLogo id="github" name="GitHub" />).container.querySelectorAll('img');
    expect([...imgs].map((i) => i.getAttribute('src'))).toEqual([bundled('github'), bundled('github.dark')]);
    expect(imgs[0].className).toContain('dark:hidden');
    expect(imgs[1].className).toContain('dark:block');
  });

  it('a second id for the same company gets the same logo', () => {
    const src = render(<BrandLogo id="zalouser" name="Zalo Personal" />).container.querySelector('img')?.getAttribute('src');
    expect(src).toBe(bundled('zalo'));
  });

  it('a name with no logo gets its initial, never a broken image', () => {
    const { container } = render(<BrandLogo id="my-own-server" name="my own server" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('M');
  });

  it('every file is a plain drawing: no scripts, no pictures inside, nothing fetched', () => {
    expect(Object.keys(SVG).length).toBeGreaterThan(30);
    for (const [path, svg] of Object.entries(SVG)) {
      expect(svg, path).not.toMatch(/<script|<image|<foreignObject|\son\w+=|href="https?:|url\(https?:|base64/i);
    }
  });
});
