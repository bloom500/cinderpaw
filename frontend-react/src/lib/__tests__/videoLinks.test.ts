import { describe, it, expect } from 'vitest';
import { isVideoLink, youtubeThumb } from '../videoLinks';

describe('a link that is a video', () => {
  it('is known by its address, on every site the card serves', () => {
    for (const href of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://youtube.com/shorts/abcDEF12345',
      'https://www.instagram.com/reel/C1a2b3c4d5/',
      'https://x.com/herdrdev/status/2115841099575222765',
      'https://twitter.com/a/status/1',
      'https://www.tiktok.com/@someone/video/7300000000000000000',
      'https://vimeo.com/123456',
    ]) expect(isVideoLink(href), href).toBe(true);
  });

  it('a page that is not a video stays a plain chip', () => {
    for (const href of ['https://github.com/a/b', 'https://x.com/herdrdev', 'https://www.youtube.com/@channel', 'not a url'])
      expect(isVideoLink(href), href).toBe(false);
  });

  it('a YouTube link has its picture before any tool is installed', () => {
    expect(youtubeThumb('https://youtu.be/dQw4w9WgXcQ')).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    expect(youtubeThumb('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10')).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    expect(youtubeThumb('https://x.com/a/status/1')).toBeNull();
  });
});
