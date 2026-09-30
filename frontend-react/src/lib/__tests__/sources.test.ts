import { describe, it, expect } from 'vitest';
import { citedSources, normalizeUrl, siteName, sourcesOf } from '../sources';
import { finishActivity, startActivity } from '@/hooks/useLiveToolActivity';

const hit = (url: string, title = '') => ({ title, url, host: new URL(url).hostname, snippet: '', crumbs: '' });

describe('sources', () => {
  it('treats the same page as the same, however the address was written', () => {
    expect(normalizeUrl('https://www.Electrek.co/best/#top')).toBe(normalizeUrl('https://electrek.co/best'));
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
  });

  it('lists what the answer cited, in order, once each; other links are not sources', () => {
    const map = new Map([[normalizeUrl('https://electrek.co/best')!, hit('https://electrek.co/best', 'Best')],
      [normalizeUrl('https://www.bicycling.com/a')!, hit('https://www.bicycling.com/a', 'A')]]);
    const text = 'See [Bicycling](https://bicycling.com/a), then https://electrek.co/best/. Also [mine](https://example.org) and <https://www.bicycling.com/a>.';
    expect(citedSources(text, map).map((h) => h.title)).toEqual(['A', 'Best']);
  });

  it("collects every search result of the turn and names the site", () => {
    const search = { ...startActivity('web_search', { query: 'x' }), hits: [hit('https://www.bicycling.com/a')] };
    expect([...sourcesOf([search, finishActivity(startActivity('recall', {}), { ok: true })]).keys()]).toEqual(['bicycling.com/a']);
    expect(siteName(hit('https://www.bicycling.com/a'))).toBe('bicycling.com');
  });
});
