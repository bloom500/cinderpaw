/**
 * #20: minimal i18n layer for the RO/EN audience.
 *
 * Not a framework — a typed dictionary + a hook. The `language` preference
 * already exists in the UI store (Settings → General); this finally makes it
 * do something. Migration is incremental: components move to `useT()` as
 * they're touched, with the chat surface (highest visibility) first.
 *
 * To add a string: add the key to BOTH `en` and `ro` below — the `Strings`
 * type makes a missing `ro` key a compile error.
 */

import { useCallback } from 'react';
import { useUI } from '@/stores/ui';

const en = {
  // Chat input
  'chat.placeholder': 'Ask anything…',
  'chat.placeholder.agent': 'Ask Feral…',
  'chat.placeholder.noModel': 'Load a model or add a cloud key to start chatting',
  'chat.noModelHint': 'No model loaded. Open Models to download one, or add a cloud key in Settings.',
  'chat.stop': 'Stop',
  'chat.send': 'Send',
  // Empty states
  'empty.noModel.title': 'No model selected',
  'empty.noModel.body': 'Load a local model or configure a cloud key to start chatting.',
  'empty.noModel.openModels': 'Open Models',
  'empty.noModel.cloudKeys': 'Cloud Keys',
  'empty.greeting.1': 'What can I help you with?',
  'empty.greeting.2': "What's on your mind?",
  'empty.greeting.3': 'How can I assist you today?',
  'empty.greeting.4': 'What would you like to explore?',
  'empty.greeting.5': 'What can I help you build?',
  // Truncated-response banner
  'chat.truncated.title': 'Response truncated.',
  'chat.truncated.body': 'The model hit its token limit before finishing',
  'chat.truncated.hint.pre': 'Increase',
  'chat.truncated.hint.post': 'in Settings for longer replies.',
  // Voice messages
  'voice.permissionDenied': 'Microphone access denied. Enable it to record voice messages.',
  'voice.unsupported': 'Voice recording is not available on this device.',
  'voice.modelDownloading': 'Downloading the voice model — try again in a moment.',
  'voice.emptyTranscript': "Couldn't understand the recording. Try again.",
  'voice.transcribing': 'Transcribing…',
  'voice.cloudFailed': 'Cloud transcription failed — check your connection or key.',
  'voice.keySaveFailed': "Couldn't save the API key. Try again.",
  'voice.provider.title': 'Choose voice transcription',
  'voice.provider.subtitle': 'How should your voice messages be turned into text? You can change this later (long-press the mic).',
  'voice.provider.local.title': 'On your device (Whisper)',
  'voice.provider.local.desc': 'Private · 100% offline · free. Uses ~0.5 GB RAM and is less accurate, especially for non-English.',
  'voice.provider.cloud.title': 'Cloud (Groq · whisper-large-v3)',
  'voice.provider.cloud.desc': 'Much more accurate · free tier. ⚠️ Your audio leaves your device.',
  'voice.provider.cloud.keyPlaceholder': 'Paste your Groq API key',
  'voice.provider.cloud.getKey': 'Get a free Groq key →',
  'voice.provider.cloud.keySet': '✓ Groq key saved.',
  'voice.provider.confirm': 'Use this',
} as const;

type Strings = Record<keyof typeof en, string>;

const ro: Strings = {
  'chat.placeholder': 'Întreabă orice…',
  'chat.placeholder.agent': 'Întreabă Feral…',
  'chat.placeholder.noModel': 'Încarcă un model sau adaugă o cheie cloud ca să începi',
  'chat.noModelHint': 'Niciun model încărcat. Deschide Models ca să descarci unul, sau adaugă o cheie cloud în Settings.',
  'chat.stop': 'Oprește',
  'chat.send': 'Trimite',
  'empty.noModel.title': 'Niciun model selectat',
  'empty.noModel.body': 'Încarcă un model local sau configurează o cheie cloud ca să începi conversația.',
  'empty.noModel.openModels': 'Deschide Models',
  'empty.noModel.cloudKeys': 'Chei cloud',
  'empty.greeting.1': 'Cu ce te pot ajuta?',
  'empty.greeting.2': 'La ce te gândești?',
  'empty.greeting.3': 'Cum te pot ajuta azi?',
  'empty.greeting.4': 'Ce ai vrea să explorezi?',
  'empty.greeting.5': 'Ce construim împreună?',
  'chat.truncated.title': 'Răspuns trunchiat.',
  'chat.truncated.body': 'Modelul a atins limita de tokeni înainte să termine',
  'chat.truncated.hint.pre': 'Mărește',
  'chat.truncated.hint.post': 'în Settings pentru răspunsuri mai lungi.',
  'voice.permissionDenied': 'Acces la microfon refuzat. Activează-l ca să înregistrezi mesaje vocale.',
  'voice.unsupported': 'Înregistrarea vocală nu este disponibilă pe acest dispozitiv.',
  'voice.modelDownloading': 'Se descarcă modelul vocal — încearcă din nou într-o clipă.',
  'voice.emptyTranscript': 'Nu am putut înțelege înregistrarea. Mai încearcă o dată.',
  'voice.transcribing': 'Transcriere…',
  'voice.cloudFailed': 'Transcrierea în cloud a eșuat — verifică conexiunea sau cheia.',
  'voice.keySaveFailed': 'Nu am putut salva cheia API. Mai încearcă.',
  'voice.provider.title': 'Alege transcrierea vocală',
  'voice.provider.subtitle': 'Cum transformăm mesajele tale vocale în text? Poți schimba mai târziu (ține apăsat pe microfon).',
  'voice.provider.local.title': 'Pe dispozitivul tău (Whisper)',
  'voice.provider.local.desc': 'Privat · 100% offline · gratis. Folosește ~0.5 GB RAM și e mai puțin precis, mai ales non-engleză.',
  'voice.provider.cloud.title': 'Cloud (Groq · whisper-large-v3)',
  'voice.provider.cloud.desc': 'Mult mai precis · free tier. ⚠️ Audio-ul tău părăsește dispozitivul.',
  'voice.provider.cloud.keyPlaceholder': 'Lipește cheia ta API Groq',
  'voice.provider.cloud.getKey': 'Ia o cheie Groq gratis →',
  'voice.provider.cloud.keySet': '✓ Cheia Groq salvată.',
  'voice.provider.confirm': 'Folosește asta',
};

const DICTS = { en, ro } as const;

export type StringKey = keyof typeof en;

/** Non-reactive lookup for code outside React (stores, callbacks). */
export function t(key: StringKey): string {
  const lang = useUI.getState().language;
  return DICTS[lang]?.[key] ?? en[key];
}

/** Reactive hook — re-renders the component when the language changes. */
export function useT(): (key: StringKey) => string {
  const lang = useUI((s) => s.language);
  return useCallback((key: StringKey) => DICTS[lang]?.[key] ?? en[key], [lang]);
}
