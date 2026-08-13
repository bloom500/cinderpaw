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
  'empty.welcomeBack': 'Welcome back to',
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
  'voice.spoken.title': 'The language you speak (not the interface language)',
  'voice.spoken.auto': 'Detect',
  // Voice call
  'call.aria': 'Start a voice call',
  'call.title': 'Voice call',
  'call.disclosure': 'Before the microphone opens — this is what will handle the call:',
  // These name the ENGINE, not the hardware. "Your voice → Groq" read as if Groq
  // were the microphone; the direction of the conversion is what makes it clear.
  'call.stt': 'Speech → text',
  'call.tts': 'Text → speech',
  'call.mic': 'Microphone',
  'call.micDefault': 'System default',
  'call.onDevice': 'on device',
  'call.leavesDevice': 'leaves device',
  'call.answer': 'Call',
  'call.listening': 'Listening…',
  'call.thinking': 'Thinking…',
  'call.speaking': 'Speaking…',
  'call.interrupt': 'Interrupt',
  'call.hangUp': 'Hang up',
  'call.turnFailed': "That turn didn't go through — still listening.",
  'call.prompt': "What's on your mind?",
  'call.voice': 'Voice',
  'call.voiceDefault': "Vendor's default voice",
  'call.voicesLoading': 'Loading voices…',
  'call.voicesFailed': "Couldn't list voices — paste a voice id",
  'call.voiceIdPlaceholder': 'Voice id',
  'call.voicesAvailable': 'available',
  'call.voiceMore': 'Showing the most relevant. Paste any voice id to use another:',
  'call.tooShort': 'That was too short to transcribe — say a bit more.',
  'call.noReply': 'Nothing came back to say — is a model selected?',
  'call.replyFailed': 'The reply failed. Open the chat panel to see why.',
  'call.replyTimeout': 'It went quiet for a minute — still listening.',
  // Spoken aloud, not shown — the line the call says while the model works.
  // Deliberately says nothing about what it is doing: it fires on every slow
  // turn, and a promise to "look that up" would be a lie on most of them.
  'call.thinkingAloud': 'One moment.',
  'call.replyStopped': 'That reply was cut off. Say it again.',
  'call.voiceMissing': 'This engine has no voice downloaded yet — get one from “Change voice engine”.',
  'call.keyNeeded': 'This voice engine needs an API key. It goes straight to your OS keychain.',
  'call.keyPlaceholder': 'Paste the API key',
  'call.keySave': 'Save',
  'call.chat': 'Chat',
  'call.chatClose': 'Close chat',
  'call.chatPlaceholder': 'Type instead of speaking…',
  // Speech to speech — one model hears you and answers in its own voice, so
  // none of the pipeline's three engines is involved.
  'call.mode': 'Call mode',
  'call.modePipeline': 'Transcribe → answer → speak',
  'call.modeLive': 'Speech to speech',
  'call.liveEngine': 'Gemini Live',
  'call.liveNote': 'One model hears you and answers in its own voice. It decides when your turn ended, so it can be interrupted mid-sentence — and the call is not saved to the chat.',
  'call.liveNoKey': 'No Google API key stored. The same AI Studio key the chat side uses — paste it below.',
  'call.liveClosed': 'The call was dropped. Press call to reconnect.',
  'call.liveConnecting': 'Connecting…',
  // Voice engine picker (first call)
  'engine.title': 'Choose the voice that answers you',
  'engine.subtitle': 'On-device engines keep every spoken reply on this machine. Hosted ones need your own key. You can change this later.',
  'engine.soon': 'not in this build yet',
  'engine.keySaved': 'Key saved — type a new one to replace it',
  'engine.baseUrlPlaceholder': 'Base URL (Azure: https://<region>.tts.speech.microsoft.com)',
  'engine.modelPlaceholder': 'Model or voice name (optional)',
  'engine.getKey': 'Get a key →',
  'engine.change': 'Change voice engine',
  'engine.keyPresent': '✓ A key is already saved for this engine',
  'engine.keyRequired': 'This engine needs a key before it can speak',
  'engine.keyForget': 'Remove it',
  'engine.save': 'Save',
  'engine.cancel': 'Cancel',
  'engine.voicePlaceholder': 'Voice',
  'engine.downloadVoice': 'Download voice (~60 MB)',
  'engine.downloading': 'Downloading the voice…',
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
  'empty.welcomeBack': 'Bine ai revenit la',
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
  'voice.spoken.title': 'Limba în care vorbești (nu limba interfeței)',
  'voice.spoken.auto': 'Detectează',
  'call.aria': 'Începe un apel vocal',
  'call.title': 'Apel vocal',
  'call.disclosure': 'Înainte să se deschidă microfonul — astea se ocupă de apel:',
  'call.stt': 'Vorbire → text',
  'call.tts': 'Text → vorbire',
  'call.mic': 'Microfon',
  'call.micDefault': 'Implicit din sistem',
  'call.onDevice': 'pe dispozitiv',
  'call.leavesDevice': 'pleacă de pe dispozitiv',
  'call.answer': 'Sună',
  'call.listening': 'Ascult…',
  'call.thinking': 'Mă gândesc…',
  'call.speaking': 'Vorbesc…',
  'call.interrupt': 'Întrerupe',
  'call.hangUp': 'Închide',
  'call.turnFailed': 'Tura asta nu a mers — încă ascult.',
  'call.prompt': 'La ce te gândești?',
  'call.voice': 'Voce',
  'call.voiceDefault': 'Vocea implicită a furnizorului',
  'call.voicesLoading': 'Se încarcă vocile…',
  'call.voicesFailed': 'Nu am putut lista vocile — lipește un id de voce',
  'call.voiceIdPlaceholder': 'Id de voce',
  'call.voicesAvailable': 'disponibile',
  'call.voiceMore': 'Arăt cele mai relevante. Lipește orice id de voce pentru altele:',
  'call.tooShort': 'A fost prea scurt ca să pot transcrie — mai zi un pic.',
  'call.noReply': 'N-a venit nimic de spus — ai un model selectat?',
  'call.replyFailed': 'Răspunsul a eșuat. Deschide panoul de chat ca să vezi de ce.',
  'call.replyTimeout': 'A rămas mut un minut — încă ascult.',
  'call.thinkingAloud': 'O secundă.',
  'call.replyStopped': 'Răspunsul a fost întrerupt. Mai zi o dată.',
  'call.voiceMissing': 'Motorul ăsta n-are încă nicio voce descărcată — ia una din „Schimbă motorul de voce”.',
  'call.keyNeeded': 'Motorul ăsta de voce are nevoie de o cheie API. Merge direct în keychain-ul sistemului.',
  'call.keyPlaceholder': 'Lipește cheia API',
  'call.keySave': 'Salvează',
  'call.chat': 'Chat',
  'call.chatClose': 'Închide chatul',
  'call.chatPlaceholder': 'Scrie în loc să vorbești…',
  'call.mode': 'Tipul apelului',
  'call.modePipeline': 'Transcrie → răspunde → vorbește',
  'call.modeLive': 'Vorbire la vorbire',
  'call.liveEngine': 'Gemini Live',
  'call.liveNote': 'Un singur model te aude și îți răspunde cu vocea lui. El decide când ai terminat de vorbit, deci poate fi întrerupt la mijlocul frazei — iar apelul nu se salvează în chat.',
  'call.liveNoKey': 'Nu e salvată nicio cheie Google. E aceeași cheie AI Studio pe care o folosește și chatul — lipește-o mai jos.',
  'call.liveClosed': 'Apelul a căzut. Apasă pe apel ca să reconectezi.',
  'call.liveConnecting': 'Se conectează…',
  'engine.title': 'Alege vocea care îți răspunde',
  'engine.subtitle': 'Motoarele locale țin fiecare replică pe mașina asta. Cele hostate cer cheia ta. Poți schimba mai târziu.',
  'engine.soon': 'încă nu e în build',
  'engine.keySaved': 'Cheie salvată — scrie una nouă ca s-o înlocuiești',
  'engine.baseUrlPlaceholder': 'Base URL (Azure: https://<regiune>.tts.speech.microsoft.com)',
  'engine.modelPlaceholder': 'Nume de model sau voce (opțional)',
  'engine.getKey': 'Ia o cheie →',
  'engine.change': 'Schimbă motorul de voce',
  'engine.keyPresent': '✓ Există deja o cheie salvată pentru motorul ăsta',
  'engine.keyRequired': 'Motorul ăsta are nevoie de o cheie ca să poată vorbi',
  'engine.keyForget': 'Șterge-o',
  'engine.save': 'Salvează',
  'engine.cancel': 'Anulează',
  'engine.voicePlaceholder': 'Voce',
  'engine.downloadVoice': 'Descarcă vocea (~60 MB)',
  'engine.downloading': 'Se descarcă vocea…',
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
