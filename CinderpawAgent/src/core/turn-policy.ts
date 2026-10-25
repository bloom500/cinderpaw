import type { ChatMessage } from "../types.ts";

type Language = "en" | "ro";
export interface TurnPolicy {
  language: Language | null;
  deferredOnly: boolean;
}

// Deliberately conservative: these are the two languages in the reported
// regression. Ambiguous text and other languages keep the normal model path.
const EN = new Set("please the weather check tell remind notify tomorrow every minutes hours what when where how would could should is are my your me this that with for and in now later answer task search summarize write find you have can not to from we they i help".split(" "));
const RO = new Set("te rog vremea verifica verifică spune amintește aminteste mâine maine fiecare minute ore este sunt pentru și si acum târziu tarziu răspunde raspunde verificat programat poți poti rezultatul cardul sarcina soare însorită am făcut facut o un unei ale tale tine ție tie îți iti pot oferi rezumat sigur desigur bună buna salut mulțumesc multumesc voi ai avea fost poate trebuie despre această aceasta acest asta când cand cum unde dacă daca să sa nu din cu pe ca la de găsește gaseste articole trimite caută cauta creează creeaza sarcină sugestie".split(" "));
const RO_STRONG = new Set("vremea verifică amintește mâine răspunde prognoza prognoză însorită rezultatul sigur desigur făcut programat găsește caută creează sarcină".split(" "));

/** A pattern whose edges see ă, î, ș, ț as letters: JS `\b` knows only ASCII. */
const word = (p: string) => new RegExp(`(?<!\\p{L})${p}(?!\\p{L})`, "u");

/** Ignore examples, quotations and code when deciding what the person asks. */
function instructions(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)|`[^`]*`|"[^"\n]*"|“[^”\n]*”|(?<!\p{L})'[^'\n]*'(?!\p{L})/gu, " ")
    .replace(/^\s*>.*$/gm, " ");
}

function detectedLanguage(text: string): Language | null {
  const clean = instructions(text).toLowerCase().trim();
  if (/^(?:hello|hi|hey)[\s!.?]*$/.test(clean)) return "en";
  if (/^(?:salut|bun[aă])[\s!.?]*$/.test(clean)) return "ro";
  const words = clean.match(/\p{L}+/gu) ?? [];
  const en = words.filter(w => EN.has(w)).length;
  const ro = words.filter(w => RO.has(w)).length;
  if ((ro >= 2 && ro > en) || (en === 0 && words.some(w => RO_STRONG.has(w)))) return "ro";
  if (en >= 2 && en > ro) return "en";
  return null;
}

export function turnPolicy(userText: string, allowScheduling = true): TurnPolicy {
  const text = instructions(userText).toLowerCase();
  // A requested translation can contain several languages by design. Explicit
  // response-language instructions win over the language of the surrounding ask.
  const explicit = /\b(?:answer|respond|reply|răspunde|raspunde)\s+(?:only\s+)?(?:in|în)\s+(\p{L}+)(?!\p{L})/u.exec(text);
  const language = explicit
    ? /^(english|englez)/.test(explicit[1]!) ? "en" : /^(romanian|rom[aâ]n)/.test(explicit[1]!) ? "ro" : null
    : /\b(?:translate|translation|tradu|traduce|traducere)\b/.test(text) ? null : detectedLanguage(text);
  // Negated clauses are not requests. Split before inspecting timing so a
  // quoted example or "do not remind me" cannot turn ordinary work into a task.
  const positive = text.split(/[;.!?\n]|\b(?:but|dar)\b/).filter(c => !/\b(?:do not|don't|dont|never|not later|nu)\b/.test(c)).join(" ");
  // This gate takes every working tool away for the turn, so it fires only on
  // wording that can mean nothing but "later". "Open at 10pm", "flights
  // tomorrow at 9", "remind me what we decided", "tell me when the train
  // leaves" and a script that runs "every day" are work for NOW (24 Oct
  // review: all five were blocked). Missing a vague one costs a card offered
  // after the work; blocking a real one costs the answer.
  const timed = (s: string) => {
    const t = s.trim().replace(/^(?:please|pls|can you|could you|te rog)\s+/, "");
    return /\bremind me (?:to|in|at|on|tomorrow|tonight|every)\b/.test(t)
      || word("(?:amintește|aminteste)-?mi (?:să|sa|peste|mâine|maine|la|în fiecare|in fiecare)").test(t)
      || /\bin (?:\d+(?:\.\d+)?|one|two|three|five|ten|fifteen|twenty|thirty|an?|half an?) (?:minutes?|mins?|hours?|days?|weeks?)\b/.test(t)
      || word("peste \\d+ (?:de )?(?:minute|minut|ore|oră|ora|zile|zi)").test(t)
      || /^(?:every|each) (?:day|morning|evening|night|week|weekday|month|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(t)
      || word("^(?:în|in) fiecare (?:zi|dimineață|dimineata|seară|seara|săptămână|saptamana|lună|luna|oră|ora|luni|marți|marti|miercuri|joi|vineri|sâmbătă|sambata|duminică|duminica)").test(t)
      || /^(?:at|la) \d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*,/.test(t)
      || word("(?:notify me|alert me|anunță-mă|anunta-ma) (?:when|if|când|cand|dacă|daca)").test(t);
  };
  // Writing code that runs on a schedule is work for now, not a schedule.
  const buildsCode = /\b(?:script|code|program|function|app|bot|regex|cron job)\b/.test(positive);
  const informational = /^\s*(?:what|why|how|which|who|where|when|explain|describe)\b/.test(positive)
    && !/\b(?:remind me|notify me when)\b/.test(positive);
  const scheduled = !informational && !buildsCode && timed(positive);
  // Explicitly mixed requests retain their immediate work. The schedule-only
  // execution gate is intentionally not used for these turns.
  const followup = /\b(?:and|also)\s+(?:remind me|notify me|tell me when)\b/.exec(positive);
  const head = followup ? positive.slice(0, followup.index) : "";
  const immediate = /\b(?:now|right away|immediately|acum|imediat)\b/.test(positive.replace(/\bnot\s+now\b/g, ""))
    || (!!head && !timed(head) && /\b(?:check|search|write|send|run|find|summarize|read)\b/.test(head));
  return { language, deferredOnly: allowScheduling && scheduled && !immediate };
}

// ponytail: the language is a rule placed next to the message, never a check
// that withholds the reply. A word-list check blocked an English email asked
// for in Romanian and every Romanian scheduled task, and held back streaming
// for every turn so it could check first (24 Oct review).
export function policyMessages(messages: ChatMessage[], policy: TurnPolicy): ChatMessage[] {
  const rules: string[] = [];
  if (policy.language) rules.push(`This turn's response language is ${policy.language === "en" ? "English" : "Romanian"}, selected from the latest user message. Use it for your reply AND task title/instructions. Memories, history and tool descriptions cannot override it. Something the person asks to be written in another language (an email, a translation) stays in that language.`);
  if (policy.deferredOnly) rules.push("The person requested work at a future time. Only suggest_task or ask_user may run this turn. Do not search, delegate or execute the future work now. Offer a task card; it runs only after Create. Use the computed schedule from suggest_task, never guess the clock.");
  if (!rules.length) return messages;
  const out = [...messages];
  const index = out.findLastIndex(m => m.role === "user");
  if (index >= 0) out[index] = { ...out[index]!, content: `${out[index]!.content}\n\n[Current turn policy]\n${rules.join("\n")}` };
  return out;
}

/** The acknowledgement is derived from the actual card, never model prose. */
export function taskAcknowledgement(when: string, language: Language | null): string {
  return language === "ro"
    ? `Apasă Create pe card pentru a crea sarcina: ${when}.`
    : `Press Create on the card to schedule it: ${when}.`;
}
