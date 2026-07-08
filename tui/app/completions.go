package app

// KnownCommands is the autocomplete popup's source list, derived from the
// single command Registry (commands.go) so the popup, the dispatcher, and
// the help overlay can never drift (P0.8 / C8). Hidden commands (genome,
// meta) are excluded.
var KnownCommands = registryCompletions()

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