import type { Project } from '@/lib/tauri';

/** Same cap as the engine's PROJECT_INSTRUCTIONS_MAX. */
const MAX = 8_000;

/**
 * The project block for a Chat mode system prompt (spec 9): the same words the
 * engine adds in Agent mode (CinderpawAgent/src/projects.ts), so a chat reads
 * its project the same way in both modes. Empty for a chat in no project, or
 * in one with nothing set.
 */
export function projectPrompt(p: Project | undefined): string {
  if (!p) return '';
  const instructions = (p.instructions ?? '').trim().slice(0, MAX);
  const files = p.files ?? [];
  if (!instructions && files.length === 0) return '';
  const lines = [`## Project: ${p.name}`, 'This chat is part of a project the person set up.'];
  if (instructions) lines.push('', 'Their instructions for every chat in this project:', instructions);
  if (files.length > 0) {
    lines.push(
      '',
      "The project's files. Open one with your file tools when it matters to the question; do not guess what is in it:",
      ...files.map((f) => `- ${f.name}: ${f.path}`),
    );
  }
  return lines.join('\n');
}
