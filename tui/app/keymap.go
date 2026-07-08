package app

import "github.com/charmbracelet/bubbles/key"

// KeyMap defines all keyboard bindings for the TUI (spec §16). This is the
// single source of truth — both the dispatcher in Update and the help
// overlay render from this map, so keys and help can never drift.
type KeyMap struct {
	Send        key.Binding
	Newline     key.Binding
	Interrupt   key.Binding
	EscDismiss  key.Binding
	ClearInput  key.Binding
	Quit        key.Binding
	QuitEmpty   key.Binding
	Help        key.Binding
	Thinking    key.Binding
	ClearScreen key.Binding
	ScrollUp    key.Binding
	ScrollDown  key.Binding
	ScrollTop   key.Binding
	ScrollBot   key.Binding
	Up          key.Binding
	Down        key.Binding
	Tab         key.Binding
	Confirm     key.Binding
	Decline     key.Binding
	Retry       key.Binding
	VimUp       key.Binding
	VimDown     key.Binding
}

var Keys = KeyMap{
	Send: key.NewBinding(
		key.WithKeys("enter"),
		key.WithHelp("enter", "send message / accept"),
	),
	Newline: key.NewBinding(
		key.WithKeys("shift+enter", "ctrl+j"),
		key.WithHelp("⇧↵", "newline"),
	),
	Interrupt: key.NewBinding(
		key.WithKeys("esc"),
		key.WithHelp("esc", "interrupt / close overlay / clear input"),
	),
	EscDismiss: key.NewBinding(
		key.WithKeys("esc"),
		key.WithHelp("esc", "dismiss overlay"),
	),
	ClearInput: key.NewBinding(
		key.WithKeys("ctrl+c"),
		key.WithHelp("^C", "clear input / quit"),
	),
	Quit: key.NewBinding(
		key.WithKeys("ctrl+c", "ctrl+d"),
		key.WithHelp("^C/^D", "quit (press twice)"),
	),
	QuitEmpty: key.NewBinding(
		key.WithKeys("ctrl+d"),
		key.WithHelp("^D", "quit on empty input"),
	),
	Help: key.NewBinding(
		key.WithKeys("f1"),
		key.WithHelp("F1", "help overlay"),
	),
	Thinking: key.NewBinding(
		key.WithKeys("ctrl+r"),
		key.WithHelp("^R", "toggle thinking pane"),
	),
	ClearScreen: key.NewBinding(
		key.WithKeys("ctrl+l"),
		key.WithHelp("^L", "clear screen"),
	),
	ScrollUp: key.NewBinding(
		key.WithKeys("pgup"),
		key.WithHelp("PgUp", "scroll up"),
	),
	ScrollDown: key.NewBinding(
		key.WithKeys("pgdown"),
		key.WithHelp("PgDn", "scroll down"),
	),
	ScrollTop: key.NewBinding(
		key.WithKeys("ctrl+home"),
		key.WithHelp("^Home", "scroll to top"),
	),
	ScrollBot: key.NewBinding(
		key.WithKeys("ctrl+end"),
		key.WithHelp("^End", "scroll to bottom"),
	),
	Up: key.NewBinding(
		key.WithKeys("up"),
		key.WithHelp("up", "move up / history"),
	),
	Down: key.NewBinding(
		key.WithKeys("down"),
		key.WithHelp("dn", "move down / history"),
	),
	Tab: key.NewBinding(
		key.WithKeys("tab"),
		key.WithHelp("tab", "cycle completion"),
	),
	Confirm: key.NewBinding(
		key.WithKeys("y"),
		key.WithHelp("y", "confirm"),
	),
	Decline: key.NewBinding(
		key.WithKeys("n"),
		key.WithHelp("n", "decline"),
	),
	Retry: key.NewBinding(
		key.WithKeys("r"),
		key.WithHelp("r", "retry on error"),
	),
	VimUp: key.NewBinding(
		key.WithKeys("k"),
		key.WithHelp("k", "vim up (overlays)"),
	),
	VimDown: key.NewBinding(
		key.WithKeys("j"),
		key.WithHelp("j", "vim down (overlays)"),
	),
}

// HelpEntries returns all key bindings as a flat list for the help overlay.
func (km KeyMap) HelpEntries() []key.Binding {
	return []key.Binding{
		km.Send, km.Newline, km.Interrupt, km.ClearInput,
		km.Help, km.Thinking, km.ClearScreen,
		km.ScrollUp, km.ScrollDown, km.ScrollTop, km.ScrollBot,
		km.Up, km.Down, km.Tab, km.Confirm, km.Decline, km.Retry,
	}
}
