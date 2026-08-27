package main

import (
	"io"
	"os"
	"strings"
	"testing"

	"cinderpaw-tui/api"
)

func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	tmp := os.Stdout
	os.Stdout = w
	defer func() { os.Stdout = tmp }()

	fn()
	w.Close()
	out, _ := io.ReadAll(r)
	return string(out)
}

func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	tmp := os.Stderr
	os.Stderr = w
	defer func() { os.Stderr = tmp }()

	fn()
	w.Close()
	out, _ := io.ReadAll(r)
	return string(out)
}

func TestStreamPlainPrintsContent(t *testing.T) {
	sig := make(chan os.Signal, 1)
	mock := func(baseURL, token, content, sessionID string, chunks chan<- api.Chunk, done chan<- error) {
		chunks <- api.Chunk{Content: "Hello, "}
		chunks <- api.Chunk{Content: "world!"}
		done <- nil
	}

	out := captureStdout(t, func() {
		err := streamPlain("", "", "hi", sig, mock)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})
	if !strings.Contains(out, "Hello, world!") {
		t.Fatalf("expected 'Hello, world!' in output, got %q", out)
	}
}

func TestStreamPlainPrintsThinkingBeforeReasoning(t *testing.T) {
	sig := make(chan os.Signal, 1)
	mock := func(baseURL, token, content, sessionID string, chunks chan<- api.Chunk, done chan<- error) {
		chunks <- api.Chunk{Reasoning: "let me think..."}
		chunks <- api.Chunk{Content: "Here's the answer."}
		done <- nil
	}

	out := captureStdout(t, func() {
		err := streamPlain("", "", "q", sig, mock)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})
	if !strings.Contains(out, "thinking...") {
		t.Fatalf("expected 'thinking...' in output, got %q", out)
	}
	if !strings.Contains(out, "Here's the answer.") {
		t.Fatalf("expected answer in output, got %q", out)
	}
}

func TestStreamPlainPrintsError(t *testing.T) {
	sig := make(chan os.Signal, 1)
	mock := func(baseURL, token, content, sessionID string, chunks chan<- api.Chunk, done chan<- error) {
		chunks <- api.Chunk{Error: "rate limited"}
		done <- nil
	}

	var errOut string
	captureStdout(t, func() {
		errOut = captureStderr(t, func() {
			err := streamPlain("", "", "q", sig, mock)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	})
	if !strings.Contains(errOut, "error: rate limited") {
		t.Fatalf("expected 'error: rate limited' in stderr, got %q", errOut)
	}
}

func TestStreamPlainInterrupt(t *testing.T) {
	sig := make(chan os.Signal, 1)
	mock := func(baseURL, token, content, sessionID string, chunks chan<- api.Chunk, done chan<- error) {
		// Never send chunks or done — simulate a stuck model.
	}

	go func() {
		sig <- os.Interrupt
	}()

	err := streamPlain("", "", "q", sig, mock)
	if err != errInterrupted {
		t.Fatalf("expected errInterrupted, got %v", err)
	}
}

func withStdin(t *testing.T, content string, fn func()) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w.Write([]byte(content))
	w.Close()
	tmp := os.Stdin
	os.Stdin = r
	defer func() { os.Stdin = tmp }()
	fn()
}

func TestRunPlainExitsOnExitCommand(t *testing.T) {
	var out string
	withStdin(t, "/exit\n", func() {
		out = captureStdout(t, func() { runPlain("", "") })
	})
	if !strings.Contains(out, "cinderpaw") {
		t.Fatalf("expected banner in output, got %q", out)
	}
}

func TestRunPlainExitOnEOF(t *testing.T) {
	var out string
	withStdin(t, "", func() {
		out = captureStdout(t, func() { runPlain("", "") })
	})
	if out == "" {
		t.Fatal("expected banner output")
	}
}

func TestMainFlagParsing(t *testing.T) {
	plain := false
	for _, a := range []string{"--plain"} {
		if a == "--plain" {
			plain = true
		}
	}
	if !plain {
		t.Fatal("expected --plain flag to be detected")
	}

	plain = false
	for _, a := range []string{"chat"} {
		if a == "--plain" {
			plain = true
		}
	}
	if plain {
		t.Fatal("expected no --plain flag")
	}
}
