import { stripThinking } from "./strip-thinking.ts";

/**
 * The first message after a model is connected, written by that model from
 * the names of the apps on this computer (Darius, 14 Nov: "the app should
 * personalise", no fixed list of kinds of people). The window sends the
 * names; nothing else about the machine is read.
 *
 * The last line is ours, not the model's, so what it says about where the
 * list went is always true.
 */

export interface WelcomeInput {
  agentName: string;
  userName: string;
  apps: string[];
  /** True when the model runs on this computer: then the list never left it. */
  local: boolean;
  /** One model call: system + user in, text out. */
  complete: (system: string, user: string) => Promise<string>;
}

/** Shown when the model cannot answer: still warm, still useful, no guess. */
export function fallbackWelcome(agentName: string, userName: string): string {
  const hi = userName.trim() ? `Hi ${userName.trim()}!` : "Hi!";
  return [
    `${hi} I'm ${agentName.trim() || "Cinderpaw"}, and I'm ready to help. 👋`,
    "",
    "You know those small things that keep slipping your mind? That's where I'm good. For example:",
    "",
    '- **"Remind me to call the dentist tomorrow at 10."** I will, right on time.',
    '- **"Tell me when tickets go on sale on this page."** I check it for you and only speak up when it happens.',
    '- **"Help me answer this email."** Paste it here and we write it together.',
    "",
    "What's one thing on your mind today?",
  ].join("\n");
}

export function welcomePrompt(input: Pick<WelcomeInput, "agentName" | "userName" | "apps">): { system: string; user: string } {
  const agent = input.agentName.trim() || "Cinderpaw";
  const hi = input.userName.trim() ? `Hi ${input.userName.trim()}!` : "Hi!";
  const system = [
    `You are ${agent}, a helpful assistant that lives on this person's computer. You are writing your very first message to them, before they have said anything.`,
    "Goal: in a few seconds they should feel you already get what their days look like, and want to answer.",
    "",
    "Rules:",
    "- Guess what they do from the apps (work, hobbies, study). Apps nearly everyone has say nothing about a person: ignore them.",
    "- NEVER name, quote or hint at a specific app, brand or tool from the list. Talk about what they do, not what they installed.",
    "- If the apps say nothing clear, do not guess: write for anyone.",
    '- Give exactly 3 examples of things they could ask you, in their own voice, each as a bullet: **"the request in quotes."** then one short sentence of what you do.',
    "- Only offer things you can really do: reminders at a time, checking a public web page and telling them when some text appears there, and writing, explaining, planning or answering with them in this chat.",
    "- Never offer to read their files, email, calendar or accounts in this message.",
    `- Start with "${hi} I'm ${agent}" and end with one short question that invites a reply.`,
    "- Warm, simple English a 12-year-old understands. At most 90 words. No headings, no sign-off, no em dashes.",
  ].join("\n");
  const user = input.apps.length
    ? `The apps on this computer:\n${input.apps.slice(0, 200).join("\n")}`
    : "The list of apps could not be read. Write for anyone.";
  return { system, user };
}

const SOURCE_LOCAL = "_I wrote this from the names of the apps on this computer. They stayed here._";
const SOURCE_CLOUD = "_I read the names of the apps on this computer to write this. The list went only to the AI you connected._";

export async function writeWelcome(input: WelcomeInput): Promise<string> {
  const { system, user } = welcomePrompt(input);
  let text = "";
  try {
    text = stripThinking(await input.complete(system, user)).trim();
  } catch {
    text = "";
  }
  // A reply that is empty or runs away is not a welcome.
  if (text.length < 20 || text.length > 1500) return fallbackWelcome(input.agentName, input.userName);
  return input.apps.length ? `${text}\n\n${input.local ? SOURCE_LOCAL : SOURCE_CLOUD}` : text;
}
