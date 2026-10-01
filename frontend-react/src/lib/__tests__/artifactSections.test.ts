import { describe, it, expect } from 'vitest';
import { sectionsOf } from '../artifactSections';

const PLAN = `# Tokyo, 5 days

A short trip.

## Day 1
![Shibuya](https://example.com/shibuya.jpg)
Arrive and walk.

## Day 2
\`\`\`
## not a heading
\`\`\`
Temples.

## Budget
| a | b |`;

describe('sectionsOf', () => {
  it('cuts Markdown at ## and keeps the words before the first one as Overview', () => {
    const s = sectionsOf('markdown', PLAN);
    expect(s.map((x) => x.title)).toEqual(['Overview', 'Day 1', 'Day 2', 'Budget']);
    expect(s[0].body).toBe('A short trip.');
  });

  it('takes the first https picture out of the section text', () => {
    const day1 = sectionsOf('markdown', PLAN)[1];
    expect(day1.image).toBe('https://example.com/shibuya.jpg');
    expect(day1.body).toBe('Arrive and walk.');
  });

  it('does not cut at a ## inside a code fence', () => {
    expect(sectionsOf('markdown', PLAN)[2].body).toContain('## not a heading');
  });

  it('ignores a picture that is not https', () => {
    const s = sectionsOf('markdown', '## A\n![x](http://example.com/a.png)\ntext');
    expect(s[0].image).toBeUndefined();
  });

  it('cuts an HTML document at h2 and finds its picture', () => {
    const s = sectionsOf('document', '<h1>T</h1><h2>One</h2><p>Hello</p><img src="https://example.com/a.jpg"><h2>Two</h2><p>Bye</p>');
    expect(s).toEqual([
      { title: 'One', body: 'Hello', image: 'https://example.com/a.jpg' },
      { title: 'Two', body: 'Bye' },
    ]);
  });

  it('gives nothing for a kind that is not text prose', () => {
    expect(sectionsOf('app', '<h2>x</h2>')).toEqual([]);
  });
});
