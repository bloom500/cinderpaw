export interface SplitResult {
  thinking: string | null;
  answer: string;
  thinkingComplete: boolean;
}

export function splitThinking(raw: string): SplitResult {
  const openIdx = raw.indexOf('<think>');
  if (openIdx === -1) {
    return { thinking: null, answer: raw, thinkingComplete: true };
  }
  const closeIdx = raw.indexOf('</think>', openIdx);
  if (closeIdx === -1) {
    return { thinking: raw.slice(openIdx + 7), answer: '', thinkingComplete: false };
  }
  return {
    thinking: raw.slice(openIdx + 7, closeIdx),
    answer: raw.slice(closeIdx + 8).trimStart(),
    thinkingComplete: true,
  };
}
