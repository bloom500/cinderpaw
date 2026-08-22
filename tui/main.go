package main

import (
	"bufio"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"time"

	"feral-tui/api"
	"feral-tui/app"

	tea "github.com/charmbracelet/bubbletea"
)

func main() {
	plain := false
	forceWizard := false
	args := os.Args[1:]
	for _, a := range args {
		if a == "--plain" {
			plain = true
		}
		if a == "--wizard" {
			forceWizard = true
		}
	}

	settings, err := api.LoadSettings()
	if err != nil {
		fmt.Fprintf(os.Stderr, "feral: could not load settings (%v)\n", err)
		os.Exit(1)
	}
	port := settings.APIPort

	token, err := api.EnsureToken(nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "feral: could not read or create API token at ~/.feral/api-token (%v)\n", err)
		os.Exit(1)
	}
	baseURL := fmt.Sprintf("http://127.0.0.1:%d", port)

	if !api.PortInUse(port) {
		// Auto-start the gateway (spec §2 J2.2).
		fmt.Fprintf(os.Stderr, "feral: starting gateway on port %d…\n", port)
		proc, err := api.StartGateway(port)
		if err != nil {
			fmt.Fprintf(os.Stderr, "feral: could not start gateway (%v)\n", err)
			fmt.Fprintf(os.Stderr, "       start it manually: cinderpaw gateway start\n")
			os.Exit(1)
		}
		defer proc.Release()
		// Wait for the gateway to come online.
		for i := 0; i < 40; i++ {
			time.Sleep(250 * time.Millisecond)
			if api.PortInUse(port) {
				break
			}
		}
		if !api.PortInUse(port) {
			fmt.Fprintf(os.Stderr, "feral: gateway started but not responding after 10s\n")
			proc.Kill()
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "feral: gateway ready\n")
	}

	if _, err := api.FetchStatus(baseURL, token); err != nil {
		fmt.Fprintf(os.Stderr, "feral: could not fetch runtime status (%v)\n", err)
		os.Exit(1)
	}

	if forceWizard {
		// Remove the wizard-done marker so the TUI shows the wizard on
		// next launch (including this one). The user can complete it or
		// Ctrl+C — either way the marker is rewritten on completion.
		home, _ := os.UserHomeDir()
		marker := home + "\\.feral\\.wizard-done"
		os.Remove(marker)
	}

	if plain {
		runPlain(baseURL, token)
		return
	}

	runTUI(baseURL, token, forceWizard)
}

// runTUI launches the full Bubble Tea TUI with alternate screen.
// forceClassic (--wizard, the `feral setup --classic` path) opens the
// classic step-by-step wizard instead of the default guided flow.
func runTUI(baseURL, token string, forceClassic bool) {
	status, err := api.FetchStatus(baseURL, token)
	if err != nil {
		fmt.Fprintf(os.Stderr, "feral: could not fetch runtime status (%v)\n", err)
		os.Exit(1)
	}
	m := app.New(baseURL, token, status)
	m.ForceClassicWizard = forceClassic
	p := tea.NewProgram(m, tea.WithAltScreen(), tea.WithMouseCellMotion())
	m.Prog = p
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
	fmt.Fprintln(os.Stderr, "session saved · resume with: cinderpaw chat")
}

// runPlain runs the simplified stdout REPL for screen-reader / low-vision
// access (§18). No alternate screen, no cursor tricks, no spinner — just
// "thinking..." printed once while waiting, then the full response.
func runPlain(baseURL, token string) {
	fmt.Println()
	fmt.Println("feral — plain mode")
	fmt.Println("Ctrl+C or /exit to quit")
	fmt.Println()

	scanner := bufio.NewScanner(os.Stdin)
	sig := make(chan os.Signal, 1)

	for {
		fmt.Fprint(os.Stdout, "> ")
		if !scanner.Scan() {
			break
		}
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		if line == "/exit" || line == "/quit" {
			break
		}

		if err := streamPlain(baseURL, token, line, sig, api.StreamChat); err != nil {
			fmt.Fprintf(os.Stderr, "\ninterrupted\n")
		}
	}
}

// streamPlain calls StreamChat and prints the response to stdout. "thinking..."
// is printed once on first reasoning or when a content chunk is delayed.
// Returns nil on normal completion, errInterrupted on Ctrl+C.
var errInterrupted = fmt.Errorf("interrupted")

// streamChatFunc matches api.StreamChat's signature for test injection.
type streamChatFunc func(baseURL, token, content, sessionID string, chunks chan<- api.Chunk, done chan<- error)

func streamPlain(baseURL, token, content string, sig chan os.Signal, stream streamChatFunc) error {
	chunks := make(chan api.Chunk, 64)
	done := make(chan error, 1)
	printedThinking := false

	go stream(baseURL, token, content, "plain", chunks, done)

	signal.Notify(sig, os.Interrupt)
	defer signal.Stop(sig)

	for {
		select {
		case c, ok := <-chunks:
			if !ok {
				chunks = nil
				continue
			}
			if c.Error != "" {
				fmt.Fprintf(os.Stderr, "\nerror: %s\n", c.Error)
				return nil
			}
			if c.Reasoning != "" && !printedThinking {
				fmt.Print("\nthinking...")
				printedThinking = true
			}
			if c.Content != "" {
				fmt.Print(c.Content)
			}
		case <-sig:
			return errInterrupted
		case err := <-done:
			// Drain any remaining chunks that were buffered before
			// the goroutine sent on done → select race (GH#2).
			for {
				select {
				case c, ok := <-chunks:
					if !ok {
						goto done
					}
					if c.Error != "" {
						fmt.Fprintf(os.Stderr, "\nerror: %s\n", c.Error)
						goto done
					}
					if c.Reasoning != "" && !printedThinking {
						fmt.Print("\nthinking...")
						printedThinking = true
					}
					if c.Content != "" {
						fmt.Print(c.Content)
					}
				default:
					goto done
				}
			}
		done:
			fmt.Println()
			if err != nil {
				fmt.Fprintf(os.Stderr, "error: %v\n", err)
			}
			return nil
		}
	}
}
