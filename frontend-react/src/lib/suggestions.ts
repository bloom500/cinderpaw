const PROMPTS = [
  'Explain this code to me',
  'Write a unit test for this function',
  'Debug: why is this returning undefined?',
  'Refactor this for readability',
  'Translate this to Python',
  'Summarize this in 3 bullet points',
  'Write a regex that matches emails',
  'What are the trade-offs between X and Y?',
  'Draft a commit message for these changes',
  'How do I reverse a linked list?',
  'Explain async/await vs promises',
  'Write a SQL query to find duplicates',
  'How do I center a div in CSS?',
  'Give me a shell one-liner to find large files',
  'What does this error mean?',
];

export function getRandomSuggestions(n: number): string[] {
  const shuffled = [...PROMPTS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}
