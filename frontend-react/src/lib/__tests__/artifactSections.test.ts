import { describe, it, expect } from 'vitest';
import { digest, plainText, sectionsOf, statusOf, subtitleOf } from '../artifactSections';

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


describe('the card header', () => {
  it('takes the short line under the # title as the subtitle', () => {
    expect(subtitleOf('markdown', '# Trip Planning\n\n_Kyoto · 7-day itinerary_\n\n## Day 1')).toBe('Kyoto · 7-day itinerary');
  });

  it('gives no subtitle when the title is followed by a list, a section or a long paragraph', () => {
    expect(subtitleOf('markdown', '# T\n- a point')).toBe('');
    expect(subtitleOf('markdown', '# T\n## Day 1')).toBe('');
    expect(subtitleOf('markdown', `# T\n${'word '.repeat(30)}`)).toBe('');
  });

  it("reads a page's meta description", () => {
    expect(subtitleOf('app', '<meta name="description" content="Monthly metrics"><canvas>')).toBe('Monthly metrics');
  });

  it('says Generated for a first version and how long ago for a later one', () => {
    expect(statusOf(1, 0)).toBe('Generated');
    expect(statusOf(3, 1_000_000 - 2 * 3_600_000, 1_000_000)).toBe('Updated 2h ago');
    expect(statusOf(2, 1_000_000 - 20_000, 1_000_000)).toBe('Updated just now');
  });
});

describe('digest', () => {
  it('keeps the first paragraph and up to three points, as plain words', () => {
    const d = digest('Focus on **high-value** segments.\n\n- Early-stage B2B\n- [Product-led](https://x) orgs\n- US & EU\n- Fourth');
    expect(d.lead).toBe('Focus on high-value segments.');
    expect(d.points).toEqual(['Early-stage B2B', 'Product-led orgs', 'US & EU']);
  });

  it('a section that is only a list has no lead', () => {
    expect(digest('- a\n- b').lead).toBe('');
    expect(plainText('![x](https://a) _b_')).toBe('b');
  });
});
