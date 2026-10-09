// What Cubby says when someone presses Listen: spoken versions of the screens,
// same meaning, warmer words. Words in [brackets] are delivery cues for the
// voice model, not spoken. Audio for each line is made once with ElevenLabs by
// `bun run voice:render` (scripts/render-cubby-voice.ts) and shipped in
// src/assets/voice/. Change a line and its Listen button hides until the audio
// is made again; `bun run voice:check` lists which.
export const CUBBY_LINES = {
  'onboarding.welcome':
    "[happy] Oh! Hi there. I'm Cubby. Welcome to Cinderpaw. I'm a little wild, and I still have a lot to learn, but I love to help. I can use smart models, real tools, and a memory for what matters to you. And yes, we can even talk out loud.",
  'onboarding.names':
    "So... what should I call you? Tell me your name, and pick one for me too, if you like. I'll use them every time we talk. You can change yours later, in Settings. [giggles] No pressure.",
  'onboarding.provider':
    "Now let's pick my brain. [giggles] Hmm, that sounds funny. It's the model I think with. It can live in the cloud, come from Hugging Face, or run right here on your computer. Pick what feels right. You can change it anytime, in Models.",
  'onboarding.connect':
    'Want me to help with your other apps? Connect them here, and I can search, make things, and get stuff done. But only with your okay. I only reach what you approve, and you can remove a connection anytime, in Settings, under Accounts.',
  'onboarding.workspace':
    'This is our place. Everything in one calm spot. We can chat, browse the web, build things together, pick models, and keep track of tasks. Nothing loud, nothing messy. [happy] I like it here.',
  'onboarding.done':
    "[happy] That's it, we're all set! Say hello, ask me to build something, or let me help with research, writing, or boring chores. I'm right here. Let's go explore.",
} as const;

export type CubbyLineId = keyof typeof CUBBY_LINES;
