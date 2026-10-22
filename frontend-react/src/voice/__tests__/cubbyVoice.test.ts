import { describe, it, expect } from 'vitest';
import { resolveVoiceUrl, type VoiceManifest } from '../cubbyVoice';

const entry = { text: 'Hi.', model: 'eleven_v3', voice: 'v', file: 'onboarding.welcome.mp3' };
const files = { '../assets/voice/onboarding.welcome.mp3': '/assets/welcome-abc.mp3' };

describe('resolveVoiceUrl', () => {
  it('gives the file when the audio was made from these exact words', () => {
    const m: VoiceManifest = { 'onboarding.welcome': entry };
    expect(resolveVoiceUrl('onboarding.welcome', 'Hi.', m, files)).toBe('/assets/welcome-abc.mp3');
  });

  it('gives nothing when the words changed after the audio was made', () => {
    const m: VoiceManifest = { 'onboarding.welcome': entry };
    expect(resolveVoiceUrl('onboarding.welcome', 'Hello.', m, files)).toBeNull();
  });

  it('gives nothing when the line has no audio yet', () => {
    expect(resolveVoiceUrl('onboarding.welcome', 'Hi.', {}, files)).toBeNull();
  });

  it('gives nothing when the manifest names a file that is not in the app', () => {
    const m: VoiceManifest = { 'onboarding.welcome': entry };
    expect(resolveVoiceUrl('onboarding.welcome', 'Hi.', m, {})).toBeNull();
  });
});
