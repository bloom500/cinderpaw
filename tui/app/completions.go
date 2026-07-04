package app

// KnownCommands is the static registry the autocomplete popup filters from.
// The `Text` field is what shows in the popup; `Insert` is what lands in the
// textarea when the user accepts (Tab/Enter). For sub-commands like
// `/model list` we keep the `<id>` placeholder visible so the user can type
// the model name after accepting — the popup is filter-by-prefix on `Text`.
//
// When you add a new slash command to handleSlash, mirror it here in the
// same commit so the popup and the dispatcher stay in sync.
var KnownCommands = []CompletionItem{
	{Text: "/help", Desc: "show this overlay", Insert: "/help"},
	{Text: "/?", Desc: "alias for /help", Insert: "/?"},
	{Text: "/tools", Desc: "browse tool calls + their results", Insert: "/tools"},
	{Text: "/new", Desc: "archive session and start fresh", Insert: "/new"},
	{Text: "/reset", Desc: "reset current session in place", Insert: "/reset"},
	{Text: "/sessions", Desc: "list recent sessions from disk", Insert: "/sessions"},
	{Text: "/history", Desc: "alias for /sessions", Insert: "/history"},
	{Text: "/status", Desc: "show model, provider, uptime, tokens", Insert: "/status"},
	{Text: "/whoami", Desc: "show session key and gateway info", Insert: "/whoami"},
	{Text: "/reasoning", Desc: "toggle reasoning visibility (on/off)", Insert: "/reasoning "},
	{Text: "/usage", Desc: "show token count and cost for this session", Insert: "/usage"},
	{Text: "/doctor", Desc: "run gateway health checks", Insert: "/doctor"},
	{Text: "/providers", Desc: "list providers with health status", Insert: "/providers"},
	{Text: "/connectors", Desc: "list connectors; /connectors reload", Insert: "/connectors "},
	{Text: "/memory", Desc: "memory stats; /memory search <q>", Insert: "/memory "},
	{Text: "/dream", Desc: "show dream summary; /dream now triggers one", Insert: "/dream "},
	{Text: "/lora", Desc: "show LoRA training status", Insert: "/lora"},
	{Text: "/compact", Desc: "summarize and truncate session context", Insert: "/compact"},
	{Text: "/clear", Desc: "clear the conversation history", Insert: "/clear"},
	{Text: "/cls", Desc: "alias for /clear", Insert: "/cls"},
	{Text: "/model", Desc: "open model picker overlay", Insert: "/model"},
	{Text: "/model list", Desc: "list installed + cloud models", Insert: "/model list"},
	{Text: "/model status", Desc: "show model details (ctx window, provider)", Insert: "/model status"},
	{Text: "/model <id>", Desc: "switch the loaded model", Insert: "/model "},
	{Text: "/stop", Desc: "abort the current streaming run", Insert: "/stop"},
	{Text: "/context", Desc: "explain how context is assembled", Insert: "/context"},
	{Text: "/tasks", Desc: "list background tool tasks", Insert: "/tasks"},
	{Text: "/setup", Desc: "re-enter the setup wizard", Insert: "/setup"},
	{Text: "/genome", Desc: "current genome layers + fitness", Insert: "/genome"},
	{Text: "/meta", Desc: "meta-evolution epoch status", Insert: "/meta"},
	{Text: "/exit", Desc: "quit the TUI", Insert: "/exit"},
	{Text: "/quit", Desc: "alias for /exit", Insert: "/quit"},
}

// computeCompletions returns the KnownCommands that start with `prefix`
// (case-sensitive — slash commands are exact), preserving the registry
// order so a stable subset appears at the top.
//
// An empty prefix returns the full list so `/` alone shows every option.
// A prefix that matches nothing returns nil — the caller hides the popup.
func computeCompletions(prefix string) []CompletionItem {
	if prefix == "" {
		out := make([]CompletionItem, len(KnownCommands))
		copy(out, KnownCommands)
		return out
	}
	var out []CompletionItem
	for _, c := range KnownCommands {
		if hasPrefix(c.Text, prefix) {
			out = append(out, c)
		}
	}
	return out
}

// hasPrefix is `strings.HasPrefix` minus the import (kept local so this
// file stays one-glance-readable).
func hasPrefix(s, prefix string) bool {
	if len(prefix) > len(s) {
		return false
	}
	return s[:len(prefix)] == prefix
}