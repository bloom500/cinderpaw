import { describe, it, expect, vi } from 'vitest';

vi.mock('../useSpeechPlayer', () => ({ useSpeechPlayer: () => ({}) }));
vi.mock('../useSendMessage', () => ({ saveVoiceBlobToDisk: vi.fn(), transcribeVoiceBlob: vi.fn() }));

describe("Cinder's reply, cut for the ear", () => {
  it('drops the markdown and keeps a couple of sentences', async () => {
    const { spokenReply } = await import('../useJevCallSession');
    expect(spokenReply('**Done.** I deleted the email from *Jefe Junior*.')).toBe('Done. I deleted the email from Jefe Junior.');
    const long = `${'The first sentence is here and it is long enough. '.repeat(8)}`;
    const cut = spokenReply(long);
    expect(cut.length).toBeLessThanOrEqual(241);
    expect(cut.endsWith('.')).toBe(true);
  });
});

describe('the tone of a result', () => {
  it('an action done is ok, a reason why not is a failure', async () => {
    const { toneFor } = await import('../useJevCallSession');
    // The word boundary in this pattern was once a backspace character, and
    // every "Opening..." chimed as a failure (21 Sep).
    expect(toneFor('Opening youtube in your browser.')).toBe('ok');
    expect(toneFor('Searching for jazz.')).toBe('ok');
    expect(toneFor('Switching to Brave.')).toBe('ok');
    expect(toneFor('')).toBe('ok');
    expect(toneFor('3 matches for pricing.')).toBe('ok');
    expect(toneFor('Nothing on this page says pricing.')).toBe('fail');
    expect(toneFor('I could not find the like button in the window in front.')).toBe('fail');
    expect(toneFor('Openingly wrong')).toBe('fail');
  });
});
