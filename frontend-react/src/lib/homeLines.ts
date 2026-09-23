/**
 * The big line on the home screen, one per visit instead of the same "What can
 * I help you with?" every time. Picked from the moment you open it: the hour,
 * the weekday, the season and a few days of the year.
 *
 * Kept short on purpose (a test holds every line to MAX_LEN) because the line
 * is set at 30 px and must stay on one row above the composer. Warm, never
 * cute: one cringe line undoes twenty good ones, so this list grows by
 * editing, not by volume.
 */

export type Lang = 'en' | 'ro';
type Pool = { en: string[]; ro: string[] };

export const MAX_LEN = 42;

const ANY: Pool = {
  en: [
    'What can I help you with?',
    "What's on your mind?",
    'Where should we start?',
    'What are we making today?',
    "What's the plan?",
    'What should we figure out?',
    'Got something for me?',
    'What are you curious about?',
    "Pick a thread, I'll follow.",
    'What needs doing?',
    "What's the next step?",
    'What are you working on?',
    'What would make today easier?',
    "Let's make something good.",
    "What's worth solving today?",
    'Ask me anything.',
    "What's been on your list?",
    'What should I look into?',
    'Need a second pair of eyes?',
    "What's the idea?",
    "Let's think it through together.",
    'What are you building?',
    'Something to write, read or fix?',
    'What can I take off your plate?',
    "Start anywhere. I'll keep up.",
    "What's the question?",
    'Big task or small one?',
    'What do you want to learn?',
    "Let's get into it.",
    'What are we untangling today?',
  ],
  ro: [
    'Cu ce te pot ajuta?',
    'La ce te gândești?',
    'De unde începem?',
    'Ce facem azi?',
    'Care e planul?',
    'Ce lămurim azi?',
    'Ai ceva pentru mine?',
    'Ce te intrigă?',
    'Alege un fir, eu te urmez.',
    'Ce e de făcut?',
    'Care e următorul pas?',
    'La ce lucrezi?',
    'Ce ți-ar ușura ziua?',
    'Hai să facem ceva bun.',
    'Ce merită rezolvat azi?',
    'Întreabă-mă orice.',
    'Ce ai pe listă de ceva vreme?',
    'Ce să caut pentru tine?',
    'Îți trebuie o a doua părere?',
    'Care e ideea?',
    'Hai să ne gândim împreună.',
    'Ce construiești?',
    'Ceva de scris, citit sau reparat?',
    'Ce pot să preiau de la tine?',
    'Începe de oriunde, țin pasul.',
    'Care e întrebarea?',
    'Treabă mare sau mică?',
    'Ce vrei să înveți?',
    'Hai să ne apucăm.',
    'Ce descâlcim azi?',
  ],
};

const MORNING: Pool = {
  en: [
    'Coffee first, then what?',
    "What's first on today's list?",
    'Fresh start. Where to?',
    'What should today look like?',
    "Let's plan the day.",
    'Early start? What are we doing?',
    "What's the first win today?",
    'Easing in or diving in?',
    'What would make this a good day?',
    'What are we tackling this morning?',
  ],
  ro: [
    'Întâi cafeaua, apoi ce?',
    'Ce e primul pe lista de azi?',
    'Început curat. Încotro?',
    'Cum vrei să arate ziua de azi?',
    'Hai să planificăm ziua.',
    'Ai început devreme? Ce facem?',
    'Care e prima reușită de azi?',
    'Pornim ușor sau direct în forță?',
    'Ce ar face din azi o zi bună?',
    'Cu ce ne luptăm în dimineața asta?',
  ],
};

const AFTERNOON: Pool = {
  en: [
    "How's the day going?",
    "Afternoon slump? I've got you.",
    "What's left on today's list?",
    "Halfway through. What's next?",
    "What's still open today?",
    "Let's clear something off the list.",
    'Second wind. What are we doing?',
    'Need a hand this afternoon?',
  ],
  ro: [
    'Cum merge ziua?',
    'Te-a prins moleșeala? Te ajut.',
    'Ce a mai rămas pe lista de azi?',
    'Suntem la jumătate. Ce urmează?',
    'Ce mai e deschis azi?',
    'Hai să tăiem ceva de pe listă.',
    'Al doilea suflu. Ce facem?',
    'Îți trebuie o mână de ajutor?',
  ],
};

const EVENING: Pool = {
  en: [
    'Winding down or just starting?',
    'How did today go?',
    'One more thing before you rest?',
    'Evening plans or evening projects?',
    "What's on your mind tonight?",
    'Anything to wrap up today?',
    "Quiet evening. What's up?",
    "Let's close out the day.",
  ],
  ro: [
    'Te relaxezi sau abia începi?',
    'Cum a fost azi?',
    'Încă un lucru înainte de odihnă?',
    'Planuri de seară sau proiecte?',
    'La ce te gândești în seara asta?',
    'Ceva de încheiat azi?',
    'Seară liniștită. Ce facem?',
    'Hai să închidem ziua frumos.',
  ],
};

const NIGHT: Pool = {
  en: [
    "Can't sleep? Let's talk.",
    'Late-night ideas are the best ones.',
    "The house is quiet. What's up?",
    'Burning the midnight oil?',
    "What's keeping you up?",
    'Night shift. What are we doing?',
    'A short one, then sleep?',
    'Still here? So am I.',
  ],
  ro: [
    'Nu poți dormi? Hai să vorbim.',
    'Ideile de noapte sunt cele mai bune.',
    'E liniște în casă. Ce facem?',
    'Lucrezi până târziu?',
    'Ce te ține treaz?',
    'Tura de noapte. Ce facem?',
    'Una scurtă, apoi la somn?',
    'Tot aici? Și eu.',
  ],
};

const WEEKEND: Pool = {
  en: [
    'Weekend project?',
    "No rush today. What's up?",
    'Something fun this weekend?',
    "Weekend mode. What's the plan?",
    'Slow weekend or busy one?',
    'What would you like to explore?',
  ],
  ro: [
    'Proiect de weekend?',
    'Nicio grabă azi. Ce facem?',
    'Ceva distractiv în weekend?',
    'Mod weekend. Care e planul?',
    'Weekend liniștit sau plin?',
    'Ce ai vrea să explorezi?',
  ],
};

const MONDAY: Pool = {
  en: ['New week. Where do we start?', "Monday again. What's first?", "Let's set up the week.", 'Fresh week, fresh list.'],
  ro: ['Săptămână nouă. De unde începem?', 'Iar luni. Ce e primul?', 'Hai să pregătim săptămâna.', 'Săptămână nouă, listă nouă.'],
};

const FRIDAY: Pool = {
  en: ["Almost weekend. What's left?", "Friday. Let's finish strong.", 'One last push before the weekend?', 'What should we wrap up this week?'],
  ro: ['Aproape weekend. Ce a rămas?', 'Vineri. Hai să terminăm în forță.', 'Un ultim efort înainte de weekend?', 'Ce încheiem săptămâna asta?'],
};

const SEASON: Record<'winter' | 'spring' | 'summer' | 'autumn', Pool> = {
  winter: {
    en: ['Cold out there. What are we making?', 'Warm drink, good question?', 'A cozy day for deep work.', 'Short days, big ideas.'],
    ro: ['E frig afară. Ce facem?', 'O băutură caldă și o întrebare?', 'O zi numai bună de lucru în liniște.', 'Zile scurte, idei mari.'],
  },
  spring: {
    en: ['Spring cleaning your to-do list?', 'Something new this spring?', 'Windows open, ideas flowing.', "What's growing this season?"],
    ro: ['Curățenie de primăvară pe listă?', 'Ceva nou în primăvara asta?', 'Geamuri deschise, idei proaspete.', 'Ce crește sezonul ăsta?'],
  },
  summer: {
    en: ["Too hot to think? I'll help.", 'Summer plans or summer projects?', "Long days. What's on yours?", "Beach later? Let's be quick."],
    ro: ['Prea cald să gândești? Te ajut.', 'Planuri de vară sau proiecte?', 'Zile lungi. Ce ai pe a ta?', 'Plajă mai târziu? Hai repede.'],
  },
  autumn: {
    en: ["Tea weather. What's up?", 'Back-to-work season. Where to?', 'Rainy day project?', 'Leaves falling, ideas landing.'],
    ro: ['Vreme de ceai. Ce facem?', 'Sezonul de revenire. Încotro?', 'Proiect de zi ploioasă?', 'Cad frunzele, vin ideile.'],
  },
};

/** Days that get their own line and nothing else. Month is 1-based. */
const SPECIAL: { month: number; days: number[]; pool: Pool }[] = [
  { month: 1, days: [1], pool: { en: ["New year. What's first?"], ro: ['An nou. Ce e primul?'] } },
  { month: 10, days: [31], pool: { en: ['Spooky season. What are we making?'], ro: ['Noapte de Halloween. Ce facem?'] } },
  { month: 12, days: [24, 25, 26], pool: { en: ['Merry Christmas. Need a hand?'], ro: ['Crăciun fericit! Te pot ajuta?'] } },
  { month: 12, days: [31], pool: { en: ['Last day of the year. Anything to wrap?'], ro: ['Ultima zi din an. Ceva de încheiat?'] } },
];

/**
 * ponytail: the hemisphere is read from the time zone name, which is right for
 * the southern places people actually live and wrong for nobody in the north.
 * A location lookup would be exact and is not worth a permission prompt.
 */
const SOUTH = /^(Australia|Antarctica)\/|^Pacific\/(Auckland|Chatham|Fiji)|^America\/(Argentina|Santiago|Sao_Paulo|Montevideo|Asuncion|La_Paz|Lima)|^Africa\/(Johannesburg|Maputo|Windhoek|Harare|Lusaka)|^Indian\/(Mauritius|Reunion)/;

function season(month: number, timeZone: string) {
  const north = month === 12 || month <= 2 ? 'winter' : month <= 5 ? 'spring' : month <= 8 ? 'summer' : 'autumn';
  if (!SOUTH.test(timeZone)) return north;
  return ({ winter: 'summer', spring: 'autumn', summer: 'winter', autumn: 'spring' } as const)[north];
}

/** Every line that fits this moment. Contextual lines are listed twice so they
 *  come up more often than the general ones. */
export function linesFor(now: Date, lang: Lang, timeZone: string): string[] {
  const month = now.getMonth() + 1;
  const special = SPECIAL.find((s) => s.month === month && s.days.includes(now.getDate()));
  if (special) return special.pool[lang];

  const hour = now.getHours();
  const dow = now.getDay();
  const part = hour >= 23 || hour < 5 ? NIGHT : hour < 12 ? MORNING : hour < 18 ? AFTERNOON : EVENING;
  const day = dow === 0 || dow === 6 ? WEEKEND : dow === 1 ? MONDAY : dow === 5 ? FRIDAY : null;
  const context = [...part[lang], ...(day?.[lang] ?? []), ...SEASON[season(month, timeZone)][lang]];
  return [...context, ...context, ...ANY[lang]];
}

/** One line for this visit, never the one shown last time. */
export function pickHomeLine(
  now: Date,
  lang: Lang,
  timeZone: string,
  last: string | null,
  random: () => number = Math.random,
): string {
  const lines = linesFor(now, lang, timeZone);
  const fresh = lines.filter((l) => l !== last);
  const pool = fresh.length > 0 ? fresh : lines;
  return pool[Math.floor(random() * pool.length)];
}

/** Every line, for the length test. */
export function allLines(): string[] {
  const pools = [ANY, MORNING, AFTERNOON, EVENING, NIGHT, WEEKEND, MONDAY, FRIDAY, ...Object.values(SEASON), ...SPECIAL.map((s) => s.pool)];
  return pools.flatMap((p) => [...p.en, ...p.ro]);
}
