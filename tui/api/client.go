package api

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const DefaultPort = 11435

type Settings struct {
	APIPort int    `json:"api_port"`
	Version string `json:"version,omitempty"`
}

func LoadSettings() (*Settings, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(home, ".feral", "settings.json"))
	if err != nil {
		return &Settings{APIPort: DefaultPort}, nil
	}
	var s Settings
	if err := json.Unmarshal(data, &s); err != nil {
		return &Settings{APIPort: DefaultPort}, nil
	}
	if s.APIPort == 0 {
		s.APIPort = DefaultPort
	}
	return &s, nil
}

type StatusSnapshot struct {
	Model       string `json:"model,omitempty"`
	Backend     string `json:"backend,omitempty"`
	Online      bool   `json:"sidecar_alive,omitempty"`
	LoRA        string `json:"lora,omitempty"`
	// Provider is the sidecar's current provider id — "openai_compatible",
	// "anthropic", or a BYOK alias like "nvidia" / "minimax". Shown in the
	// welcome row so the user can tell at a glance whether they're hitting
	// the local engine or a cloud endpoint.
	Provider string `json:"provider,omitempty"`
	// ByokProvider is the configured BYOK provider id when the gateway
	// was started with FERAL_BYOK_PROVIDER set (e.g. "nvidia", "minimax").
	// Empty for a vanilla local boot.
	ByokProvider string `json:"byok_provider,omitempty"`
	// AgentModel is the model id the sidecar actually infers with — for
	// local sessions this matches Model.Name, for cloud sessions it's
	// the cloud model id ("stepfun-ai/step-3.7-flash", "MiniMax-M3", …).
	AgentModel string `json:"agent_model,omitempty"`
}

type Chunk struct {
	// Answer-text fragments (OpenAI-style `data:` chunks).
	Content      string `json:"content"`
	Reasoning    string `json:"reasoning_content,omitempty"`
	FinishReason string `json:"finish_reason,omitempty"`
	Error        string `json:"error,omitempty"`
	Prompt       int    `json:"prompt_tokens,omitempty"`
	Completion   int    `json:"completion_tokens,omitempty"`

	// Tool lifecycle events — exactly one of these is populated when the
	// host forwards a typed `event: tool_*` SSE frame. Empty strings mean
	// "not a tool event"; zero `ID` is invalid for a tool event.
	ToolStart    ToolStart    `json:"-"`
	ToolDone     ToolDone     `json:"-"`
	ToolProgress ToolProgress `json:"-"`
}

// ToolStart is the start of one tool call — the sidecar emits a matching
// `tool_done` later with the same `id`. `Args` is a free-form object (the
// tool's input schema); we keep it as `json.RawMessage` so callers don't
// have to round-trip every well-known tool's schema.
type ToolStart struct {
	ID   string          `json:"id"`
	Name string          `json:"tool"`
	Args json.RawMessage `json:"args"`
}

// ToolProgress is a status note from a long-running tool — e.g. a retry
// counter or "fetching page 2/5". Optional; not every tool emits any.
type ToolProgress struct {
	ID      string  `json:"id"`
	Tool    string  `json:"tool"`
	Message string  `json:"message"`
	Stage   string  `json:"stage,omitempty"`
	Progress *float64 `json:"progress,omitempty"`
}

// ToolDone is the terminal frame of a tool call. The host serialises the
// tool's structured result as `json.RawMessage` so each consumer can decode
// it against its own schema (we just show a string preview in the TUI).
type ToolDone struct {
	ID     string          `json:"id"`
	Tool   string          `json:"tool"`
	Result json.RawMessage `json:"result"`
	// `ok=false` means the tool errored; `error` carries the human message.
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// SessionSummary is one row in `/runtime/sessions` — the welcome screen
// renders the most-recent N of these. Mirrors the shape stored in
// `~/.feral/conversations/index.json` (see frontend-react/src/stores/conversations.ts).
type SessionSummary struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	UpdatedAt string `json:"updated_at"`
	AgentID   string `json:"agent_id,omitempty"`
}

// rawChunk is the JSON shape of an OpenAI-style `data:` SSE frame — it does
// NOT cover the typed `event: tool_*` frames, which are parsed separately in
// `StreamChat`.
type rawChunk struct {
	ID      string `json:"id"`
	Error   string `json:"error,omitempty"`
	Choices []struct {
		Delta struct {
			Content          string `json:"content,omitempty"`
			ReasoningContent string `json:"reasoning_content,omitempty"`
		} `json:"delta"`
		FinishReason string `json:"finish_reason,omitempty"`
	} `json:"choices,omitempty"`
	Usage *struct {
		Prompt     int `json:"prompt_tokens"`
		Completion int `json:"completion_tokens"`
	} `json:"usage,omitempty"`
}

type rawStatus struct {
	AgentModel   string `json:"agent_model,omitempty"`
	Model        *struct {
		Name string `json:"name,omitempty"`
	} `json:"model,omitempty"`
	Backend      string `json:"backend,omitempty"`
	SidecarAlive bool   `json:"sidecar_alive,omitempty"`
	LoRA         string `json:"lora,omitempty"`
	// New fields (2026-07-04): provider + byok_provider distinguish a
	// cloud session from a local one. `provider` is the sidecar's view
	// ("openai_compatible" / "anthropic"); `byok_provider` is the
	// human-friendly alias the user picked in byok.json ("nvidia" /
	// "minimax" / …).
	Provider     string `json:"provider,omitempty"`
	ByokProvider string `json:"byok_provider,omitempty"`
}

func ReadToken() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(filepath.Join(home, ".feral", "api-token"))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

func PortInUse(port int) bool {
	conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

func FetchStatus(baseURL, token string) (*StatusSnapshot, error) {
	req, _ := http.NewRequest("GET", baseURL+"/runtime/status", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var raw rawStatus
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}
	s := &StatusSnapshot{
		Backend:     raw.Backend,
		Online:      raw.SidecarAlive,
		LoRA:        raw.LoRA,
		Provider:    raw.Provider,
		ByokProvider: raw.ByokProvider,
		AgentModel:  raw.AgentModel,
	}
	if raw.AgentModel != "" {
		s.Model = raw.AgentModel
	} else if raw.Model != nil {
		s.Model = raw.Model.Name
	}
	if s.Backend == "" {
		s.Backend = "—"
	}
	return s, nil
}

// ListModels returns the ids of every model installed on disk, plus which
// one (if any) is currently loaded.
func ListModels(baseURL, token string) (ids []string, active string, err error) {
	req, _ := http.NewRequest("GET", baseURL+"/runtime/models", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	var raw struct {
		Models []string `json:"models"`
		Active string   `json:"active"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, "", err
	}
	return raw.Models, raw.Active, nil
}

// SetModel swaps the loaded model for the one matching id/name. Returns the
// server's error message (not just the HTTP status) so the caller can show
// the user why the switch failed — e.g. "no installed model matches …".
func SetModel(baseURL, token, id string) (active string, err error) {
	body, _ := json.Marshal(map[string]string{"id": id})
	req, _ := http.NewRequest("POST", baseURL+"/runtime/model", strings.NewReader(string(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s", strings.TrimSpace(string(data)))
	}
	var raw struct {
		Active string `json:"active"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return "", err
	}
	return raw.Active, nil
}

// ProviderInfo is one entry in GET /runtime/manifest's providers list.
type ProviderInfo struct {
	ID     string `json:"id"`
	Online bool   `json:"online"`
	Model  string `json:"model,omitempty"`
}

// FetchProviders returns the provider list and the default provider id from
// /runtime/manifest. Falls back to a single entry from /runtime/status when
// the manifest endpoint is unavailable.
func FetchProviders(baseURL, token string) ([]ProviderInfo, string, error) {
	req, _ := http.NewRequest("GET", baseURL+"/runtime/manifest", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	var raw struct {
		Providers []ProviderInfo `json:"providers,omitempty"`
		Default   string         `json:"default_provider,omitempty"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, "", err
	}
	return raw.Providers, raw.Default, nil
}

// FetchLoraStatus returns the active LoRA adapter name from /runtime/lora.
func FetchLoraStatus(baseURL, token string) (string, error) {
	req, _ := http.NewRequest("GET", baseURL+"/runtime/lora", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var raw struct {
		Active string `json:"active,omitempty"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return "", err
	}
	return raw.Active, nil
}

// ReloadConnectors pokes the gateway to reconcile connectors from disk.
func ReloadConnectors(baseURL, token string) error {
	req, _ := http.NewRequest("POST", baseURL+"/runtime/connectors/reload", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// TriggerDream sends a dream-cycle trigger to the gateway.
func TriggerDream(baseURL, token string) error {
	req, _ := http.NewRequest("POST", baseURL+"/runtime/dream", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// FetchSessions returns the most-recent conversations (default 5) so the
// welcome screen can render a "recent" list. The host endpoint reads the
// `~/.feral/conversations/index.json` written by the desktop app.
func FetchSessions(baseURL, token string, limit int) ([]SessionSummary, error) {
	if limit <= 0 {
		limit = 5
	}
	url := fmt.Sprintf("%s/runtime/sessions?limit=%d", baseURL, limit)
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	var raw struct {
		Sessions []SessionSummary `json:"sessions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}
	return raw.Sessions, nil
}

func StreamChat(baseURL, token, content, sessionID string, chunks chan<- Chunk, done chan<- error) {
	body, _ := json.Marshal(map[string]string{
		"content":    content,
		"session_id": sessionID,
	})
	req, _ := http.NewRequest("POST", baseURL+"/runtime/chat", strings.NewReader(string(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		done <- err
		return
	}
	defer resp.Body.Close()

	tagBuffer := ""
	inThink := false
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 65536), 65536)
	// SSE records are separated by a blank line. We track the current
	// event-name across the lines of one record so typed events
	// (`event: tool_start`) attach to the next `data:` line correctly.
	var currentEvent string
	for scanner.Scan() {
		line := scanner.Text()
		// Blank line = end of one SSE record; reset event-name so the next
		// `data:` defaults back to the OpenAI "message" type.
		if strings.TrimSpace(line) == "" {
			currentEvent = ""
			continue
		}
		switch {
		case strings.HasPrefix(line, "event: "):
			currentEvent = strings.TrimSpace(line[len("event: "):])
		case strings.HasPrefix(line, "data:"):
			data := strings.TrimSpace(line[len("data:"):])
		if data == "[DONE]" {
			if leftover := flushTag(&tagBuffer, &inThink); leftover != "" {
				chunks <- Chunk{Content: leftover}
			}
			done <- nil
			return
		}
			// Typed tool frames — host emits these with `event: tool_*`
			// headers and the raw sidecar line as the data body.
			if isToolEvent(currentEvent) {
				if c, ok := parseToolFrame(currentEvent, data); ok {
					chunks <- c
				}
				continue
			}
			var raw rawChunk
			if err := json.Unmarshal([]byte(data), &raw); err != nil {
				continue
			}
			if raw.Error != "" {
				chunks <- Chunk{Error: raw.Error}
				continue
			}
			if len(raw.Choices) == 0 {
				continue
			}
			delta := raw.Choices[0].Delta
			finish := raw.Choices[0].FinishReason
			if delta.ReasoningContent != "" {
				chunks <- Chunk{Reasoning: delta.ReasoningContent}
			}
			if delta.Content != "" {
				answer := feedTag(&tagBuffer, &inThink, delta.Content)
				if answer != "" {
					chunks <- Chunk{Content: answer}
				}
			}
			if finish == "stop" || finish == "error" {
				if leftover := flushTag(&tagBuffer, &inThink); leftover != "" {
					chunks <- Chunk{Content: leftover}
				}
				done <- nil
				return
			}
			if raw.Usage != nil {
				chunks <- Chunk{
					Prompt:     raw.Usage.Prompt,
					Completion: raw.Usage.Completion,
				}
			}
		}
	}
	if err := scanner.Err(); err != nil && err != io.EOF {
		done <- err
		return
	}
	done <- nil
}

// isToolEvent reports whether `ev` is one of the typed SSE event names the
// host re-emits for tool lifecycle frames.
func isToolEvent(ev string) bool {
	switch ev {
	case "tool_start", "tool_progress", "tool_done":
		return true
	}
	return false
}

// parseToolFrame decodes one typed tool frame into the matching Chunk
// variant. The body is the original sidecar JSON line (the host
// serialises the raw `Value` so all sidecar fields — including extra
// tool-specific ones — round-trip).
func parseToolFrame(ev, body string) (Chunk, bool) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &raw); err != nil {
		return Chunk{}, false
	}
	id := jsonStr(raw["id"])
	tool := jsonStr(raw["tool"])
	switch ev {
	case "tool_start":
		return Chunk{ToolStart: ToolStart{ID: id, Name: tool, Args: raw["args"]}}, true
	case "tool_progress":
		var msg, stage string
		var prog *float64
		if m, ok := raw["message"]; ok {
			msg = jsonStr(m)
		}
		if s, ok := raw["stage"]; ok {
			stage = jsonStr(s)
		}
		if p, ok := raw["progress"]; ok && len(p) > 0 && string(p) != "null" {
			var f float64
			if err := json.Unmarshal(p, &f); err == nil {
				prog = &f
			}
		}
		return Chunk{ToolProgress: ToolProgress{
			ID: id, Tool: tool, Message: msg, Stage: stage, Progress: prog,
		}}, true
	case "tool_done":
		ok := true
		if v, has := raw["ok"]; has {
			ok = string(v) == "true"
		}
		return Chunk{ToolDone: ToolDone{
			ID: id, Tool: tool, Result: raw["result"], OK: ok,
			Error: jsonStr(raw["error"]),
		}}, true
	}
	return Chunk{}, false
}

// jsonStr is a tiny helper that returns the decoded string for a JSON
// fragment, or "" if the fragment is missing/not-a-string.
func jsonStr(b json.RawMessage) string {
	if len(b) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return ""
	}
	return s
}

func feedTag(buf *string, inThink *bool, piece string) string {
	*buf += piece
	var out string
	for {
		marker := "<think>"
		if *inThink {
			marker = "</think>"
		}
		idx := strings.Index(*buf, marker)
		if idx < 0 {
			break
		}
		before := (*buf)[:idx]
		if !*inThink {
			out += before
		}
		*buf = (*buf)[idx+len(marker):]
		*inThink = !*inThink
	}
	openIdx := strings.LastIndex(*buf, "<")
	closeIdx := strings.LastIndex(*buf, ">")
	var reserve int
	if openIdx > closeIdx {
		reserve = len(*buf) - openIdx
	} else if strings.HasSuffix(*buf, "</") || strings.HasSuffix(*buf, "<") {
		reserve = 1
	}
	if reserve > 0 {
		safe := len(*buf) - reserve
		if safe > 0 {
			out += (*buf)[:safe]
			*buf = (*buf)[safe:]
		}
	} else if !*inThink {
		out += *buf
		*buf = ""
	}
	return out
}

// RuntimeEvent is one event from GET /events. The SSE data is:
//
//	event: runtime
//	data: {"event":"feral://agent-output","data":{"data":"<json>"}}
//
// where the inner `<json>` string has a `type` field. We flatten to
// Kind (the type) and Message (the rendered form) here; the formatter
// map in the app layer picks the exact `◦ line text.
type RuntimeEvent struct {
	Kind     string `json:"type"`
	Message  string `json:"message,omitempty"`
	Stage    string `json:"stage,omitempty"`
	Detail   string `json:"detail,omitempty"`
	Provider string `json:"provider,omitempty"`
	Model    string `json:"model,omitempty"`
}

// parseRuntimeEventSSE decodes one SSE data line from /events into a
// RuntimeEvent. Returns (zero, false) when the line doesn't match the
// expected wrapping format or the inner JSON is malformed.
func parseRuntimeEventSSE(sseData string) (RuntimeEvent, bool) {
	var outer struct {
		Event string          `json:"event"`
		Data  json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal([]byte(sseData), &outer); err != nil {
		return RuntimeEvent{}, false
	}
	var innerWrap struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal(outer.Data, &innerWrap); err != nil {
		return RuntimeEvent{}, false
	}
	var ev RuntimeEvent
	if err := json.Unmarshal([]byte(innerWrap.Data), &ev); err != nil {
		return RuntimeEvent{}, false
	}
	return ev, true
}

// StreamEvents reads the unified observability SSE at GET /events and
// pushes parsed RuntimeEvent values onto `events`. On connection error
// or when the stream ends, `done` receives nil (EOF) or an error.
func StreamEvents(baseURL, token string, events chan<- RuntimeEvent, done chan<- error) {
	req, err := http.NewRequest("GET", baseURL+"/events", nil)
	if err != nil {
		done <- err
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		done <- err
		return
	}
	defer resp.Body.Close()

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 65536), 65536)
	for scanner.Scan() {
		line := scanner.Text()
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(line[len("data:"):])
		ev, ok := parseRuntimeEventSSE(data)
		if ok {
			events <- ev
		}
	}
	if err := scanner.Err(); err != nil {
		done <- err
		return
	}
	done <- nil
}

func flushTag(buf *string, inThink *bool) string {
	leftover := *buf
	*buf = ""
	if *inThink {
		*inThink = false
		return ""
	}
	return leftover
}
