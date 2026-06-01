export const ONBOARDING_KEY = 'feral_agents_onboarding';

export const DEFAULT_SCRATCH_PROMPT =
  'You are a helpful AI assistant. Answer questions clearly and concisely. Ask for clarification when needed.';

export const TOOL_LABELS: Record<string, { label: string; description: string }> = {
  WebSearch:   { label: 'Web Search',    description: 'Search the web using DuckDuckGo' },
  FileRead:    { label: 'File Read',     description: 'Read files from your computer' },
  FileWrite:   { label: 'File Write',    description: 'Write files to your computer' },
  CodeExecute: { label: 'Run Code',      description: 'Execute Python code snippets' },
  HttpRequest: { label: 'HTTP Request',  description: 'Make GET / POST web requests' },
};

export const PRESET_DESCRIPTIONS: Record<string, string> = {
  'Research Assistant': 'Searches the web and browses pages to answer questions.',
  'Code Helper':        'Reads and writes files, runs code snippets to verify output.',
  'File Organizer':     'Reads and renames files based on their content.',
  'Web Scraper':        'Fetches and summarises content from web pages.',
};
