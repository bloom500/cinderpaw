/**
 * Which links are videos, for the video card (VideoLinkCard). Matched by the
 * address alone, so the card shows before anything is fetched. A video site
 * missing here still works for the agent (watch_video takes any link); it just
 * shows as a plain chip.
 */
const VIDEO_LINK = [
  /(^|\.)youtube\.com\/(watch|shorts\/|live\/)/,
  /(^|\.)youtu\.be\/[\w-]+/,
  /(^|\.)instagram\.com\/(reels?|p|tv)\/[\w-]+/,
  /(^|\.)(x|twitter)\.com\/[^/]+\/status\/\d+/,
  /(^|\.)tiktok\.com\/@[^/]+\/video\/\d+/,
  /(^|\.)vimeo\.com\/\d+/,
  /(^|\.)facebook\.com\/(.+\/videos\/|reel\/|watch)/,
  /(^|\.)fb\.watch\//,
];

export function isVideoLink(href: string): boolean {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  const s = `${u.hostname.replace(/^www\.|^m\./, '')}${u.pathname}${u.search}`;
  return VIDEO_LINK.some((re) => re.test(s));
}

/** A YouTube link's picture, known from its id with no fetch and no tools. */
export function youtubeThumb(href: string): string | null {
  try {
    const u = new URL(href);
    const host = u.hostname.replace(/^www\.|^m\./, '');
    const id =
      host === 'youtu.be' ? u.pathname.slice(1)
      : host === 'youtube.com' ? (u.searchParams.get('v') ?? u.pathname.match(/^\/(?:shorts|live)\/([\w-]+)/)?.[1])
      : null;
    return id && /^[\w-]{6,}$/.test(id) ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
  } catch {
    return null;
  }
}
