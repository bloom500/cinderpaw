/**
 * The UI's strings, English only this release.
 *
 * A typed dictionary + a hook, kept on purpose: the next release adds ~70
 * languages here, and every component that already calls `useT()` will pick
 * them up without being touched. Until then new UI text is plain English and
 * does not need a key.
 */

const en = {
  // Chat input
  'chat.placeholder': 'Ask anything…',
  'chat.placeholder.agent': 'Ask Cinderpaw…',
  'chat.placeholder.noModel': 'Load a model or add a cloud key to start chatting',
  'chat.noModelHint': 'No model loaded. Open Models to download one, or add a cloud key in Models, Cloud tab.',
  // Spoken by the product, not the model — there is no model to speak. See
  // ChatInput.noModelReply.
  'chat.noModel.reply':
    "I need a model before I can do that. I can run a small one locally on this machine, which works offline, or use an API key if you already have one.",
  'chat.noModel.download': 'Download a model',
  // Model picker trigger when nothing is pinned. Choosing by hand is an
  // override now, not a prerequisite — Brain routes per turn.
  'model.automatic': 'Automatic',
  'model.add': 'Add a model',
  'chat.noModel.addKey': 'Add a key',
  // Shown when automatic model selection failed and the default was used.
  // A fallback is allowed; a hidden one is not.
  'chat.routed.fallback': 'I used your default model. Automatic model choice was unavailable.',
  'chat.routed.why': 'Why?',
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
  // Home: the time of day, then the one question. Fixed, not rotating — a
  // greeting that changes every four seconds is a screensaver, not a greeting.
  'home.morning': 'Good morning',
  'home.afternoon': 'Good afternoon',
  'home.evening': 'Good evening',
  'home.night.1': 'Hello, night owl',
  'home.night.2': 'Staying up late again, night owl?',
  'home.ask': 'What can I help you with?',
  // The four intents. A statement about what the product is, so they are fixed
  // and in this order — they are not suggestions and they are not shuffled.
  'home.intent.research': 'Research',
  'home.intent.create': 'Create',
  'home.intent.analyze': 'Analyze',
  'home.intent.automate': 'Automate',
  // Truncated-response banner
  'chat.truncated.title': 'Response truncated.',
  'chat.truncated.body': 'The model hit its token limit before finishing',
  'chat.truncated.hint.pre': 'Increase',
  'chat.truncated.hint.post': 'in Settings for longer replies.',
  // Voice messages
  'voice.permissionDenied': 'Microphone access denied. Enable it to record voice messages.',
  'voice.unsupported': 'Voice recording is not available on this device.',
  'voice.modelDownloading': 'Downloading the voice model. Try again in a moment.',
  'voice.emptyTranscript': "Couldn't understand the recording. Try again.",
  'voice.transcribing': 'Transcribing…',
  'voice.cloudFailed': 'Cloud transcription failed. Check your connection or key.',
  'voice.keySaveFailed': "Couldn't save the API key. Try again.",
  'voice.provider.title': 'Choose voice transcription',
  'voice.provider.subtitle': 'How should your voice messages be turned into text? You can change this later (long-press the mic).',
  // The engine is deliberately not named. It differs per build, and this row
  // said "Whisper" for a year in builds that had no whisper in them at all.
  'voice.provider.local.title': 'On your device',
  'voice.provider.local.desc': 'Private · 100% offline · free. Needs a one-time model download, and is less accurate than the cloud option.',
  'voice.provider.cloud.title': 'Cloud (Groq · whisper-large-v3)',
  'voice.provider.cloud.desc': 'Much more accurate · free tier. ⚠️ Your audio leaves your device.',
  'voice.provider.cloud.keyPlaceholder': 'Paste your Groq API key',
  'voice.provider.cloud.getKey': 'Get a free Groq key →',
  'voice.provider.cloud.keySet': '✓ Groq key saved.',
  'voice.provider.openrouter.title': 'Cloud (OpenRouter · Fish transcribe-1)',
  'voice.provider.openrouter.desc': 'Automatic language detection · billed per second on your OpenRouter account. ⚠️ Your audio leaves your device.',
  'voice.provider.openrouter.keyPlaceholder': 'Paste your OpenRouter API key',
  'voice.provider.openrouter.getKey': 'Get an OpenRouter key →',
  'voice.provider.openrouter.keySet': '✓ Using your OpenRouter key (the same one as chat).',
  'voice.provider.confirm': 'Use this',
  // Voice call
  'call.aria': 'Start a voice call',
  'call.title': 'Voice call',
  'call.disclosure': 'Before the microphone opens, this is what will handle the call:',
  // These name the ENGINE, not the hardware. "Your voice → Groq" read as if Groq
  // were the microphone; the direction of the conversion is what makes it clear.
  'call.stt': 'Speech → text',
  'call.tts': 'Text → speech',
  'call.mic': 'Microphone',
  'call.tools': 'Tools',
  'call.toolsOff': 'none in this call, it answers from what it knows',
  'call.micDefault': 'System default',
  'call.onDevice': 'on device',
  'call.leavesDevice': 'leaves device',
  'call.answer': 'Call',
  'call.setUpVoice': 'Choose a voice',
  // Said BEFORE the button is pressed. The old path booted Node, a LiveKit
  // server and an npm install first, then failed with advice about checking
  // the network — on a machine whose network was fine.
  'call.noEngine':
    'Cinderpaw has no voice to speak with yet. This version needs one you choose: a voice that runs on your machine, or a cloud voice with a key. Pick one and the call will work.',
  'call.listening': 'Listening…',
  'call.thinking': 'Thinking…',
  'call.speaking': 'Speaking…',
  'call.interrupt': 'Interrupt',
  'call.hangUp': 'Hang up',
  'call.turnFailed': "That turn didn't go through. Still listening.",
  'call.prompt': "What's on your mind?",
  'call.voice': 'Voice',
  'call.voiceDefault': "Vendor's default voice",
  'call.voicesLoading': 'Loading voices…',
  // Not "paste a voice id". A person who came to make a phone call has no
  // idea what a voice id is, and no way to find one: the list that would have
  // told them is the thing that just failed. Say what will be used instead,
  // and say it as a fact rather than as a problem they have to solve.
  'call.voicesUsingDefault': 'Voice list unavailable, using',
  'call.voicesNeedKey': 'Add this engine’s key to choose a voice.',
  'call.voiceIdPlaceholder': 'Voice id',
  'call.voicesAvailable': 'available',
  'call.voiceMore': 'Showing the most relevant. Paste any voice id to use another:',
  'call.tooShort': 'That was too short to transcribe. Say a bit more.',
  'call.micSilent': 'No microphone signal detected. Check your input device or mute setting.',
  'call.noReply': 'Nothing came back to say. Is a model selected?',
  'call.replyFailed': 'The reply failed. Open the chat panel to see why.',
  'call.replyTimeout': 'It went quiet for a minute. Still listening.',
  // Spoken aloud, not shown — the line the call says while the model works.
  // Deliberately says nothing about what it is doing: it fires on every slow
  // turn, and a promise to "look that up" would be a lie on most of them.
  'call.thinkingAloud': 'One moment.',
  // Said at twelve-second intervals while a turn runs long. Deliberately vaguer
  // as they go: by the third one, promising it is nearly done would be a lie,
  // and the honest version is the one that keeps the line trustworthy.
  'call.stillWorking': 'Still working on it.',
  'call.stillWorkingLong': "This one's taking a while, still going.",
  'call.almostThere': "Still here, still on it.",
  'call.replyStopped': 'That reply was cut off. Say it again.',
  'call.voiceMissing': 'This engine has no voice downloaded yet. Get one from “Change voice engine”.',
  'call.keyNeeded': 'This voice engine needs an API key. It goes straight to your OS keychain.',
  // Names the vendor, because the field used to say Google whichever vendor was
  // picked, and a key pasted under the wrong name is worse than one refused.
  'call.keyNeededFor': 'No {provider} key stored. Paste one below and it goes straight to your OS keychain.',
  'call.keyPlaceholder': 'Paste the API key',
  'call.keySave': 'Save',
  'call.chat': 'Chat',
  'call.chatClose': 'Close chat',
  'call.chatPlaceholder': 'Type instead of speaking…',
  // Speech to speech — one model hears you and answers in its own voice, so
  // none of the pipeline's three engines is involved.
  'call.mode': 'Call mode',
  'call.modePipeline': 'Transcribe → answer → speak',
  'call.modeLive': 'Speech to speech (previous)',
  'call.modeLiveKit': 'Speech to speech',
  'call.provider': 'Voice provider',
  'call.settings': 'Call settings',
  'call.settingsDone': 'Done',
  'call.model': 'Model',
  'call.key': 'API key',
  'call.keyStored': 'A key is stored. Paste another to replace it.',
  'call.providerNoKey': 'no key',
  'call.engineUnset': 'not chosen yet',
  'call.providerNoneShort': 'Echo (no key)',
  'call.groupPipeline': 'Transcribe, answer, speak',
  'call.groupS2s': 'Speech to speech',
  'call.providerNone': '{provider} has no key stored, so this call will echo you back instead of answering. Add one in Models → Cloud.',
  'call.liveEngine': 'Gemini Live',
  'call.liveNoKey': 'No Google API key stored. The same AI Studio key the chat side uses. Paste it below.',
  'call.liveClosed': 'Disconnected. Press call to reconnect.',
  'call.liveConnecting': 'Connecting…',
  // The three stages of getting into a call, named rather than hidden behind
  // one spinner: fifteen seconds of "connecting" is indistinguishable from a
  // hang, and these are the waits that are actually happening.
  'call.stage.starting': 'Starting the voice engine…',
  'call.stage.joining': 'Joining the call…',
  'call.stage.mic': 'Opening the microphone…',
  'call.reconnecting': 'Connection lost. Reconnecting…',
  // The work panel — what Cinderpaw is doing while the call waits.
  'call.toolSearching': 'searching…',
  'call.toolDone': 'done',
  'call.toolFailed': 'failed',
  'call.toolsRunning': 'tasks running',
  'call.artifacts': 'Sources',
  'call.artifactsClose': 'Close sources',
  'call.artifactsClear': 'Clear',
  'call.artifactsEmpty': 'Nothing looked up yet. Searches, files and memory lookups land here, with their links.',
  // Voice engine picker (first call)
  'engine.title': 'Choose the voice that answers you',
  'engine.subtitle': 'On-device engines keep every spoken reply on this machine. Hosted ones need your own key. You can change this later.',
  'engine.soon': 'not in this build yet',
  'engine.keySaved': 'Key saved, type a new one to replace it',
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
  // Conversation list headings. Deliberately the same words every other app
  // uses — this is a list someone scans, not a place to be inventive.
  // The name a conversation is SAVED under when nobody has said anything in
  // it yet. Stored, not just rendered, so it has to be in the reader's own
  // language at the moment of saving.
  'chats.untitled': 'New chat',
  'chats.group.today': 'Today',
  'chats.group.yesterday': 'Yesterday',
  'chats.group.last7': 'Previous 7 days',
  'chats.group.last30': 'Previous 30 days',
  // For conversations saved before a timestamp was recorded. Says what is
  // true — we do not know when — rather than guessing a date for them.
  'chats.group.undated': 'Older',
} as const;

export type StringKey = keyof typeof en;

/** Non-reactive lookup for code outside React (stores, callbacks). */
export function t(key: StringKey): string {
  return en[key];
}

/** Same lookup as a hook, so components keep one call site for next release. */
export function useT(): (key: StringKey) => string {
  return t;
}
