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
	args := os.Args[1:]
	for _, a := range args {
		if a == "--plain" {
			plain = true
		}
	}

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

	if _, err := api.FetchStatus(baseURL, token); err != nil {
		fmt.Fprintf(os.Stderr, "feral: could not fetch runtime status (%v)\n", err)
		os.Exit(1)
	}

	if plain {
		runPlain(baseURL, token)
		return
	}

	runTUI(baseURL, token)
}

// runTUI launches the full Bubble Tea TUI with alternate screen.
func runTUI(baseURL, token string) {
	status, err := api.FetchStatus(baseURL, token)
	if err != nil {
		fmt.Fprintf(os.Stderr, "feral: could not fetch runtime status (%v)\n", err)
		os.Exit(1)
	}
	m := app.New(baseURL, token, status)
	p := tea.NewProgram(m, tea.WithAltScreen(), tea.WithMouseCellMotion())
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
