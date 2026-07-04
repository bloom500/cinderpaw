package main

import (
	"fmt"
	"os"
	"time"

	"feral-tui/api"
	"feral-tui/app"

	tea "github.com/charmbracelet/bubbletea"
)

func main() {
	settings, err := api.LoadSettings()
	if err != nil {
		fmt.Fprintf(os.Stderr, "feral: could not load settings (%v)\n", err)
		os.Exit(1)
	}
	port := settings.APIPort

	token, err := api.ReadToken()
	if err != nil {
		fmt.Fprintf(os.Stderr, "feral: no API token found at ~/.feral/api-token\n")
		os.Exit(1)
	}
	baseURL := fmt.Sprintf("http://127.0.0.1:%d", port)

	if !api.PortInUse(port) {
		// Gateway might still be starting — retry for up to ~4s
		waited := false
		for i := 0; i < 20; i++ {
			time.Sleep(200 * time.Millisecond)
			waited = true
			if api.PortInUse(port) {
				break
			}
		}
		if !api.PortInUse(port) {
			why := ""
			if waited {
				why = " (waited 4s)"
			}
			fmt.Fprintf(os.Stderr, "feral: runtime is not running on port %d%s\n", port, why)
			fmt.Fprintf(os.Stderr, "       run `feral gateway start` first\n")
			os.Exit(1)
		}
	}

	status, err := api.FetchStatus(baseURL, token)
	if err != nil {
		fmt.Fprintf(os.Stderr, "feral: could not fetch runtime status (%v)\n", err)
		os.Exit(1)
	}

	m := app.New(baseURL, token, status)
	p := tea.NewProgram(m, tea.WithAltScreen(), tea.WithMouseCellMotion())
	m.Prog = p

	run(p)
}

// run isolates p.Run() behind a recover so an in-process panic (a bug in
// Update/View, not an OS-level SIGSEGV — Go cannot recover from an actual
// segfault) always restores the terminal before the process exits (spec
// §2 J9, §34.9). Bubble Tea's own Run() already restores raw-mode/alt-
// screen on a normal return or on tea.Quit; this only covers the panic
// path, which today would otherwise print a mid-panic stack trace over a
// still-alternate-screen, corrupted-cooked-mode terminal.
func run(p *tea.Program) {
	defer func() {
		if r := recover(); r != nil {
			p.ReleaseTerminal()
			fmt.Fprintf(os.Stderr, "feral: crashed: %v\n", r)
			os.Exit(1)
		}
	}()
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "feral: error: %v\n", err)
		os.Exit(1)
	}
}
