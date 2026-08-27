package api

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const DefaultPort = 11435

type Settings struct {
	APIPort int    `json:"api_port"`
	Version string `json:"version,omitempty"`
}

func LoadSettings() (*Settings, error) {
	home, err := Home()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(home, "settings.json"))
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
	// was started with CINDERPAW_BYOK_PROVIDER set (e.g. "nvidia", "minimax").
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

	// ask_user — the agent is waiting on the user's answer. Non-nil when the
	// host forwards a typed `event: ask_user` frame; answer it with
	// AskRespond. AskUserCancelled carries the request id of a question the
	// sidecar withdrew (timeout/shutdown).
	AskUser          *AskUserRequest `json:"-"`
	AskUserCancelled string          `json:"-"`
}

// AskUserRequest mirrors the sidecar's `ask_user` outbound event.
type AskUserRequest struct {
	ID        string        `json:"id"`
	SessionID string        `json:"sessionId"`
	Questions []AskQuestion `json:"questions"`
}

// AskQuestion is one multiple-choice question (2-4 options).
type AskQuestion struct {
	Question    string      `json:"question"`
	Options     []AskOption `json:"options"`
	MultiSelect bool        `json:"multiSelect,omitempty"`
}

// AskOption is one selectable choice.
type AskOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
	Recommended bool   `json:"recommended,omitempty"`
}

// AskAnswer mirrors the sidecar's expected `ask_user_response` answer shape.
type AskAnswer struct {
	Question   string   `json:"question"`
	Selected   []string `json:"selected"`
	CustomText string   `json:"customText,omitempty"`
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
	home, err := Home()
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(filepath.Join(home, "api-token"))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

// EnsureToken returns the existing API token at `~/.feral/api-token` or, on
// first run, generates a fresh 32-byte URL-safe random token, writes it
// 0600-permissioned, and returns it. This is the Sprint 2 first-run
// bootstrap (audit C-3) — a new user who runs `feral chat` with no prior
// install used to hit a cryptic exit; now they get a fresh token and the
// wizard opens automatically (audit J2.3).
//
// `seed` is exposed for tests so a deterministic fixture can be used; pass
// `nil` to use crypto/rand. The byte count is fixed at 32; tokens of that
// length are 43 base64url characters — comfortable entropy headroom for a
// loopback-only bearer.
func EnsureToken(seed []byte) (string, error) {
	if existing, err := ReadToken(); err == nil && existing != "" {
		return existing, nil
	}
	dir, err := Home()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "api-token")
	var raw []byte
	if len(seed) > 0 {
		raw = make([]byte, 32)
		copy(raw, seed)
	} else {
		buf := make([]byte, 32)
		if _, err := rand.Read(buf); err != nil {
			return "", err
		}
		raw = buf
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	// O_EXCL, not WriteFile. Two processes can reach this at the same moment on
	// a first run — the TUI and the gateway both find no token and both mint
	// one — and a plain write means last-writer-wins: the sidecar authenticates
	// with one value while the TUI sends the other, and every request 401s
	// until something restarts. Creating exclusively makes exactly one of them
	// the writer; the loser reads back what the winner wrote.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		if os.IsExist(err) {
			if existing, rerr := ReadToken(); rerr == nil && existing != "" {
				return existing, nil
			}
		}
		return "", err
	}
	_, werr := f.WriteString(token + "\n")
	if cerr := f.Close(); werr == nil && cerr != nil {
		werr = cerr
	}
	if werr != nil {
		return "", werr
	}
	return token, nil
}

// StartGateway attempts to start the feral gateway process. It looks for
// the gateway binary next to the TUI binary, then in PATH, and finally at
// common install locations. Returns the process handle on success.
func StartGateway(port int) (*os.Process, error) {
	gatewayPath, err := findGateway()
	if err != nil {
		return nil, err
	}
	proc, err := os.StartProcess(gatewayPath, []string{gatewayPath, "gateway", "start", "--port", fmt.Sprintf("%d", port)},
		&os.ProcAttr{
			Files: []*os.File{nil, nil, os.Stderr},
			Env:   os.Environ(),
		})
	if err != nil {
		return nil, fmt.Errorf("starting gateway: %w", err)
	}
	return proc, nil
}

// findGateway looks for the host binary next to the TUI binary, in PATH,
// and at common install locations.
//
// The old names are still tried: someone who installed before the rename has a
// feral binary on disk, and a TUI that cannot find it would report "not found"
// on a machine where it is plainly installed.
func findGateway() (string, error) {
	// Look next to the TUI binary first.
	exe, err := os.Executable()
	if err == nil {
		dir := filepath.Dir(exe)
		candidates := []string{
			filepath.Join(dir, "cinderpaw.exe"),
			filepath.Join(dir, "cinderpaw-gateway.exe"),
			filepath.Join(dir, "cinderpaw"),
			filepath.Join(dir, "feral.exe"),
			filepath.Join(dir, "feral-gateway.exe"),
			filepath.Join(dir, "feral"),
		}
		for _, c := range candidates {
			if _, err := os.Stat(c); err == nil {
				return c, nil
			}
		}
	}
	// Fall back to PATH.
	for _, look := range []string{"cinderpaw", "feral"} {
		if _, err := os.Stat(look); err == nil {
			return look, nil
		}
	}
	return "", fmt.Errorf("cinderpaw binary not found — run `cinderpaw gateway start` manually")
}

// A gateway that accepts the connection and then never answers used to freeze
// the whole TUI: `http.DefaultClient` has no timeout at all, so sixteen calls —
// status, model list, connector reload, every one of them on the UI's path —
// could block until the user found Ctrl-C. These two clients replace it.
//
// ponytail: one flat ceiling instead of a per-endpoint budget. 120s is above
// any healthy call (a cold model load is the slow one) and far below "forever".
// If a legitimate endpoint ever needs longer, give that call its own client
// rather than raising this.
var httpClient = &http.Client{Timeout: 120 * time.Second}

// Streams (chat tokens, runtime events) must NOT have a whole-request deadline:
// a healthy stream is open for as long as the user keeps talking. The header
// timeout still covers the failure this is here for — a gateway that takes the
// connection and never replies.
var streamClient = &http.Client{
	Transport: &http.Transport{ResponseHeaderTimeout: 60 * time.Second},
}

// Send a request, refusing a nil one instead of dereferencing it.
//
// Every call site built its request with `req, _ := http.NewRequest(...)`,
// discarding the error — and on an invalid base URL (a typo in the flag, a
// config with a stray character) `http.NewRequest` returns nil, so the very
// next line panicked inside a goroutine and took the TUI down with no message.
// Routing all of them through here turns that into an error the caller can
// report, without touching twenty-one call sites.
func doRequest(client *http.Client, req *http.Request) (*http.Response, error) {
	if req == nil {
		return nil, fmt.Errorf("could not build the request — check the gateway URL")
	}
	return client.Do(req)
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
	resp, err := doRequest(httpClient, req)
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
	resp, err := doRequest(httpClient, req)
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
	resp, err := doRequest(httpClient, req)
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
	resp, err := doRequest(httpClient, req)
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
	resp, err := doRequest(httpClient, req)
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
	resp, err := doRequest(httpClient, req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// The gateway answers 503 with a human-readable body when the
		// sidecar is down — surface it instead of a false "reloaded".
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		return fmt.Errorf("%s", strings.TrimSpace(string(body)))
	}
	return nil
}

// ConnectorView is the redacted per-connector state from
// GET /runtime/connectors (mirrors feral-core's ConnectorRedactedView).
type ConnectorView struct {
	ID        string   `json:"id"`
	Enabled   bool     `json:"enabled"`
	Filled    []string `json:"filled"`
	Allowlist []string `json:"allowlist"`
	Channels  []string `json:"channels"`
	Mode      string   `json:"mode"`
}

// FetchConnectors lists the persisted connectors with secrets redacted.
func FetchConnectors(baseURL, token string) ([]ConnectorView, error) {
	req, _ := http.NewRequest("GET", baseURL+"/runtime/connectors", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := doRequest(httpClient, req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("gateway returned %s", resp.Status)
	}
	var views []ConnectorView
	if err := json.NewDecoder(resp.Body).Decode(&views); err != nil {
		return nil, err
	}
	return views, nil
}

// SetupCandidate is one rung of the guided-setup detection ladder
// (GET /runtime/setup/detect). Raw is the untouched JSON the gateway sent —
// POST /runtime/setup/verify wants the candidate echoed back verbatim, so
// we never round-trip through a lossy struct.
type SetupCandidate struct {
	Kind          string
	Label         string
	Detail        string
	Recommended   bool
	ProviderID    string
	Model         string
	DownloadRepo  string
	DownloadFile  string
	DownloadLabel string
	DownloadSize  string
	Raw           json.RawMessage
}

// SetupDetectResult is the parsed detect response the guided screen needs.
type SetupDetectResult struct {
	Acked      bool
	Candidates []SetupCandidate
}

// SetupDetect runs the server-side detection ladder (existing config →
// local GGUFs → hardware download → env keys → Ollama → OpenClaw import).
func SetupDetect(baseURL, token string) (*SetupDetectResult, error) {
	req, _ := http.NewRequest("GET", baseURL+"/runtime/setup/detect", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := doRequest(httpClient, req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("gateway %d", resp.StatusCode)
	}
	var wire struct {
		SecurityAcknowledgedAt *string           `json:"security_acknowledged_at"`
		Candidates             []json.RawMessage `json:"candidates"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&wire); err != nil {
		return nil, err
	}
	out := &SetupDetectResult{Acked: wire.SecurityAcknowledgedAt != nil}
	for _, raw := range wire.Candidates {
		var f struct {
			Kind        string `json:"kind"`
			Label       string `json:"label"`
			Detail      string `json:"detail"`
			Recommended bool   `json:"recommended"`
			ProviderID  string `json:"provider_id"`
			Model       string `json:"model"`
			Download    struct {
				RepoID     string `json:"repo_id"`
				Filename   string `json:"filename"`
				Label      string `json:"label"`
				ApproxSize string `json:"approx_size"`
			} `json:"download"`
		}
		if err := json.Unmarshal(raw, &f); err != nil {
			continue
		}
		out.Candidates = append(out.Candidates, SetupCandidate{
			Kind: f.Kind, Label: f.Label, Detail: f.Detail, Recommended: f.Recommended,
			ProviderID: f.ProviderID, Model: f.Model,
			DownloadRepo: f.Download.RepoID, DownloadFile: f.Download.Filename,
			DownloadLabel: f.Download.Label, DownloadSize: f.Download.ApproxSize,
			Raw: raw,
		})
	}
	return out, nil
}

// SetupAck persists the one-time security acknowledgement (idempotent).
func SetupAck(baseURL, token string) error {
	req, _ := http.NewRequest("POST", baseURL+"/runtime/setup/ack", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := doRequest(httpClient, req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// SetupVerify runs the real-completion test on one candidate and — on
// success — persists it as the default route (persist lives server-side;
// verify-then-persist is the invariant). apiKey rides along only for the
// manual paste-a-key path. The server caps the test at 90s.
func SetupVerify(baseURL, token string, candidate json.RawMessage, apiKey string) (bool, string, error) {
	payload := map[string]interface{}{"candidate": candidate, "persist": true}
	if apiKey != "" {
		payload["api_key"] = apiKey
	}
	body, _ := json.Marshal(payload)
	req, _ := http.NewRequest("POST", baseURL+"/runtime/setup/verify", strings.NewReader(string(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return false, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return false, "", fmt.Errorf("gateway %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	var out struct {
		OK      bool   `json:"ok"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return false, "", err
	}
	return out.OK, out.Message, nil
}

// CompactSession asks the agent loop to summarize the older portion of one
// session's transcript now (/compact, OpenClaw slash parity). The summarizer
// is a real LLM completion — the gateway holds the request up to 120s, so
// the client timeout is wider than the default. Returns the human result
// ("compacted" / "not needed").
func CompactSession(baseURL, token, sessionID string) (string, error) {
	body := strings.NewReader(fmt.Sprintf(`{"session_id":%q}`, sessionID))
	req, _ := http.NewRequest("POST", baseURL+"/runtime/session/compact", body)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 150 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return "", fmt.Errorf("gateway %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	var out struct {
		OK     bool   `json:"ok"`
		Result string `json:"result"`
		Error  string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if !out.OK {
		return "", fmt.Errorf("%s", out.Error)
	}
	return out.Result, nil
}

// ShutdownGateway asks the running gateway to drain and exit (/restart).
func ShutdownGateway(baseURL, token string) error {
	req, _ := http.NewRequest("POST", baseURL+"/runtime/shutdown", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := doRequest(httpClient, req)
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
	resp, err := doRequest(httpClient, req)
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
	resp, err := doRequest(httpClient, req)
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

// LastTask is the Sprint 1.6 payload returned by `/runtime/resume`. Every
// field is the zero value on first launch. Mirrors the Rust `LastTaskView`
// wire shape (snake_case JSON, no rename).
type LastTask struct {
	Title         string `json:"title"`
	TS            int64  `json:"ts"`              // unix ms; 0 if absent
	WorkspaceID   string `json:"workspace_id"`    // empty if absent
}

type ResumeView struct {
	Task          *LastTask `json:"task"`           // nil on first launch
	WorkspaceID   string    `json:"workspace_id"`   // empty if no workspace
	WorkspaceName string    `json:"workspace_name"` // empty if no workspace
	LastActiveAt  int64     `json:"last_active_at"` // unix ms; 0 if absent
}

// FetchResume hits `/runtime/resume` (Sprint 1.6 gateway route) and returns
// the persisted `current_task` + active workspace + last-active timestamp.
// The gateway forwards to the sidecar — TUI is a *reader* of memory state,
// never a writer (see `docs/agents-memory/project_memory_roadmap.md`).
//
// Errors are swallowed by the caller and treated as "no prior task" so a
// flaky first boot never blocks the welcome screen.
func FetchResume(baseURL, token string) (*ResumeView, error) {
	req, _ := http.NewRequest("GET", baseURL+"/runtime/resume", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := doRequest(httpClient, req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	var raw ResumeView
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}
	return &raw, nil
}

// SystemInfo is the Sprint 2 / audit C-1 hardware probe. Mirrors the Rust
// `crates/feral-core/src/sysinfo_mod.rs::SystemInfo` JSON wire shape (snake_case).
type SystemInfo struct {
	OS              string `json:"os"`
	CPU             string `json:"cpu"`
	Cores           int    `json:"cores"`
	RamTotalMB      int64  `json:"ram_total_mb"`
	RamUsedMB       int64  `json:"ram_used_mb"`
	GpuName         string `json:"gpu_name"`
	VramTotalMB     int64  `json:"vram_total_mb"`
	VramUsedMB      int64  `json:"vram_used_mb"`
	SupportsVulkan  bool   `json:"supports_vulkan"`
}

// FetchSystemInfo hits `/system_info` (audit C-1). Returns the probed GPU /
// VRAM / RAM on every machine — replaces the previous wizard "rtx 4070"
// hard-coded mock. Used by the Setup Wizard's first screen.
func FetchSystemInfo(baseURL, token string) (*SystemInfo, error) {
	req, _ := http.NewRequest("GET", baseURL+"/system_info", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	// Probe can take a few seconds (sysinfo_mod::detect waits on platform
	// probes). 8s ceiling is comfortable for the gateway hop.
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	var raw SystemInfo
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}
	return &raw, nil
}

// TestProviderKey posts a key to `/providers/test` (audit C-2). Mirrors the
// Tauri command `test_byok_provider`. Returns a friendly error string on
// non-2xx (the body is the real provider message — "401 Unauthorized",
// "Invalid API key", etc. — surfaced verbatim in the wizard so the user
// can act on it).
func TestProviderKey(baseURL, token, providerID, apiKey, baseURLOpt string) (string, error) {
	payload := map[string]string{
		"provider_id": providerID,
		"api_key":     apiKey,
	}
	if baseURLOpt != "" {
		payload["base_url"] = baseURLOpt
	}
	body, _ := json.Marshal(payload)
	req, _ := http.NewRequest("POST", baseURL+"/providers/test", strings.NewReader(string(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 12 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Trim and surface the real provider message. Better than a generic
		// "key invalid" so the user knows whether it's a typo, an expired
		// key, or a billing issue.
		return "", fmt.Errorf("%s", strings.TrimSpace(string(respBody)))
	}
	return strings.TrimSpace(string(respBody)), nil
}

// SaveByokKeyResult is the parsed response from POST /runtime/byok/save.
// Used by `saveCloudProvider` (tui/app/update.go) to surface typed
// failures to the wizard's "✗ Connection failed" line.
type SaveByokKeyResult struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error,omitempty"`
	Message string `json:"message,omitempty"`
	Hint    string `json:"hint,omitempty"`
}

// SaveByokKey posts the provider's API key + metadata to
// `/runtime/byok/save` (Phase 0b, 2026-07-07). The Rust gateway writes the
// key to the OS keychain (Windows Credential Manager / macOS Keychain /
// Linux Secret Service) and the metadata to `byok.json`. This closes the
// "silent key-drop" bug where a fresh-install wizard completion saved
// only metadata and the next launch couldn't find the key.
//
// Arguments:
//   - providerID: lowercase a-z0-9_- identifier (validated server-side)
//   - apiKey: the plaintext key the user pasted. NEVER written to disk
//     or logs by this function or the receiving gateway; the key chain
//     goes straight from here to the OS keychain on the server.
//     `apiKey == ""` means "leave the keychain entry untouched" — used
//     for metadata-only updates (e.g. changing `default_model`).
//   - baseURL, defaultModel: optional metadata; pass `*string` so empty
//     values are distinguishable from "set to literal empty string".
//
// The function never logs `apiKey` and never includes it in returned
// error messages. On failure, the message is server-provided and
// category-typed (keyring_unavailable / invalid_provider_id / etc.)
// so the wizard can show an actionable hint.
func SaveByokKey(baseURL, token, providerID, apiKey string, baseURLOpt, defaultModelOpt *string) (*SaveByokKeyResult, error) {
	payload := map[string]interface{}{
		"provider_id": providerID,
		"enabled":     true,
		"api_key":     apiKey, // sent over loopback HTTPS-equivalent (bearer + 127.0.0.1)
	}
	if baseURLOpt != nil {
		payload["base_url"] = *baseURLOpt
	}
	if defaultModelOpt != nil {
		payload["default_model"] = *defaultModelOpt
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequest("POST", baseURL+"/runtime/byok/save", strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	// 12s matches the rest of the wizard's HTTP budget. The keyring write
	// on the server is normally sub-second; anything longer usually means
	// D-Bus / credential-manager daemon is stuck.
	client := &http.Client{Timeout: 12 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Best-effort parse so callers can read `error` + `hint` for the
		// wizard's failure surface. Falls back to the raw body if the
		// server's response wasn't JSON.
		var parsed SaveByokKeyResult
		if jerr := json.Unmarshal(respBody, &parsed); jerr == nil && parsed.Error != "" {
			return &parsed, nil
		}
		return &SaveByokKeyResult{
			OK:      false,
			Error:   "byok_save_failed",
			Message: strings.TrimSpace(string(respBody)),
		}, nil
	}
	var parsed SaveByokKeyResult
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return nil, fmt.Errorf("malformed /runtime/byok/save response: %w", err)
	}
	return &parsed, nil
}

// ── Phase 1 catalog types (2026-07-07) ──────────────────────────────────────
//
// Mirror types for the canonical catalogs served by the gateway at
// /runtime/providers/catalog and /runtime/connectors/catalog. The TUI
// wizard fetches these at boot and caches them for the wizard lifetime;
// `tui/app/wizard.go` keeps the original local slices as offline
// fallbacks (Decision C).

// ProviderCatalogEntry is one row of the canonical provider catalog.
// Mirrors `crates/feral-core/src/byok.rs::ProviderCatalogEntry`.
type ProviderCatalogEntry struct {
	ID                     string  `json:"id"`
	Name                   string  `json:"name"`
	Provider               string  `json:"provider"` // serialized Provider enum
	DefaultBaseURL         string  `json:"default_base_url"`
	DefaultModel           string  `json:"default_model"`
	ConsoleURL             *string `json:"console_url,omitempty"`
	KeyFormat              *string `json:"key_format,omitempty"`
	KeyFormatHint          *string `json:"key_format_hint,omitempty"`
	FreeTierNote           *string `json:"free_tier_note,omitempty"`
	SupportsCustomBaseURL  bool    `json:"supports_custom_base_url"`
	AuthStyle              string  `json:"auth_style"` // "bearer" | "x_api_key"
}

// ConnectorPairingFieldDef is one secret field a connector requires.
// Mirrors `crates/feral-core/src/connectors.rs::PairingFieldDef`.
type ConnectorPairingFieldDef struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Secret bool   `json:"secret"`
}

// ConnectorCatalogEntry is one row of the canonical connector catalog.
// Mirrors `crates/feral-core/src/connectors.rs::ConnectorCatalogEntry`.
//
// v2 (2026-07-07) — added QRSetupEndpoint. QR-paired connectors (only
// WhatsApp today) carry the gateway endpoint the wizard POSTs to in
// order to obtain a fresh QR payload to render on screen. The refresh
// cycle (default 60s) re-hits the same endpoint until `linked` flips
// to true on the user's phone scan.
type ConnectorCatalogEntry struct {
	ID                  string                    `json:"id"`
	Name                string                    `json:"name"`
	Description         string                    `json:"description"`
	Icon                string                    `json:"icon"`
	LogoURL             *string                   `json:"logo_url,omitempty"`
	PairingFields       []ConnectorPairingFieldDef `json:"pairing_fields"`
	PairingMethod       string                    `json:"pairing_method"` // "bot_token" | "oauth" | "qr"
	ComingSoon          bool                      `json:"coming_soon"`
	ConsoleURL          *string                   `json:"console_url,omitempty"`
	FreeTierNote        *string                   `json:"free_tier_note,omitempty"`
	ValidateEndpoint    *string                   `json:"validate_endpoint,omitempty"`
	OAuthScopes         []string                  `json:"oauth_scopes,omitempty"`
	OAuthClientIDSource *string                   `json:"oauth_client_id_source,omitempty"`
	QRSetupEndpoint     *string                   `json:"qr_setup_endpoint,omitempty"`
}

// ProviderCatalogVersionExpected pins the version this client expects
// for `/runtime/providers/catalog`. Bumped in lockstep with
// `byok::CATALOG_VERSION` on the Rust side. Today `1` (no schema
// change yet on the byok side).
const ProviderCatalogVersionExpected = 1

// ConnectorCatalogVersionExpected pins the version this client expects
// for `/runtime/connectors/catalog`. Bumped in lockstep with
// `connectors::CONNECTORS_CATALOG_VERSION` on the Rust side.
//
// v2 (2026-07-07) — bumped from 1 to 2. QRSetupEndpoint added to
// `ConnectorCatalogEntry`; `PairingMethod::Qr` connectors now carry
// the gateway endpoint the wizard POSTs to for a fresh QR payload.
// The shared CatalogVersionExpected constant was split because the
// two catalogs track independent schema versions (a byok-side bump
// does NOT also require a connector-side bump and vice versa).
const ConnectorCatalogVersionExpected = 3

// fetchCatalog is the shared GET-with-version-header helper for the
// two catalog endpoints. On a non-2xx it returns a typed
// `CatalogResult` with the parsed body, even on a known drift status
// (the body is still useful as a fallback).
func fetchCatalog(baseURL, token, path string, expectedVersion int) (*CatalogResult, error) {
	req, err := http.NewRequest("GET", baseURL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &CatalogResult{
			OK:           false,
			Error:        fmt.Sprintf("http_%d", resp.StatusCode),
			HTTPBodyHint: strings.TrimSpace(string(body)),
		}, nil
	}
	version := 0
	if v := resp.Header.Get("X-Cinderpaw-Catalog-Version"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			version = n
		}
	}
	return &CatalogResult{
		OK:                true,
		Body:              body,
		Version:           version,
		VersionMatchesExpected: version == expectedVersion,
	}, nil
}

// CatalogResult is the parsed response of one catalog endpoint.
// Version pin: clients treat Version != expected as drift (use the
// bundled fallback slice and surface a banner).
type CatalogResult struct {
	OK                      bool
	Body                    []byte
	Version                 int
	VersionMatchesExpected  bool
	Error                   string // when OK is false
	HTTPBodyHint            string // when OK is false — server-supplied hint, never the key
}

// FetchProviderCatalog calls GET /runtime/providers/catalog.
// The body is the raw JSON — callers decode it via json.Unmarshal into
// `[]ProviderCatalogEntry`.
func FetchProviderCatalog(baseURL, token string) (*CatalogResult, error) {
	return fetchCatalog(baseURL, token, "/runtime/providers/catalog", ProviderCatalogVersionExpected)
}

// FetchConnectorCatalog calls GET /runtime/connectors/catalog.
func FetchConnectorCatalog(baseURL, token string) (*CatalogResult, error) {
	return fetchCatalog(baseURL, token, "/runtime/connectors/catalog", ConnectorCatalogVersionExpected)
}

// ConnectorFileConfig is the on-disk format of `~/.feral/connectors.json`.
// Mirrors the Rust `ConnectorConfigFile` shape in src-tauri/src/connectors.rs.
type ConnectorFileConfig struct {
	Connectors []ConnectorFileEntry `json:"connectors"`
}

// ConnectorFileEntry is one connector row in connectors.json.
type ConnectorFileEntry struct {
	ID        string            `json:"id"`
	Enabled   bool              `json:"enabled"`
	Secrets   map[string]string `json:"secrets"`
	Allowlist []string          `json:"allowlist"`
	Channels  []string          `json:"channels"`
}

// SaveConnectorConfig persists a connector's secrets and enabled flag to
// `~/.feral/connectors.json`, then pokes the gateway to reload. F4
// chat-platform connector counterpart to the cloud-provider keychain path
// (SaveByokKey + /runtime/byok/save). Phase 2 of the terminal-onboarding
// slice replaces this file-only writer with a keychain-backed endpoint
// (`/runtime/connectors/:id/save`) per the locked plan, so this function
// will be deleted then; the file-shape type and the reload call survive
// in a narrower form.
func SaveConnectorConfig(id string, secrets map[string]string, enable bool) error {
	dir, err := Home()
	if err != nil {
		return fmt.Errorf("cannot find home directory: %w", err)
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("cannot create %s: %w", dir, err)
	}
	path := filepath.Join(dir, "connectors.json")

	cfg := ConnectorFileConfig{}
	if data, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(data, &cfg)
	}

	found := false
	for i := range cfg.Connectors {
		if cfg.Connectors[i].ID == id {
			cfg.Connectors[i].Enabled = enable
			if cfg.Connectors[i].Secrets == nil {
				cfg.Connectors[i].Secrets = map[string]string{}
			}
			for k, v := range secrets {
				cfg.Connectors[i].Secrets[k] = v
			}
			found = true
			break
		}
	}
	if !found {
		entry := ConnectorFileEntry{
			ID:        id,
			Enabled:   enable,
			Secrets:   secrets,
			Allowlist: []string{},
			Channels:  []string{},
		}
		if entry.Secrets == nil {
			entry.Secrets = map[string]string{}
		}
		cfg.Connectors = append(cfg.Connectors, entry)
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}

// InstallModel posts to `/runtime/models/install` (Sprint 2 / audit C-5)
// and returns the in-flight download id. The download runs on the gateway
// in a background task; the wizard polls `DownloadModel` for progress.
func InstallModel(baseURL, token, repoID, filename string) (string, error) {
	payload := map[string]string{
		"repo_id":  repoID,
		"filename": filename,
	}
	body, _ := json.Marshal(payload)
	req, _ := http.NewRequest("POST", baseURL+"/runtime/models/install", strings.NewReader(string(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	// The install endpoint returns immediately after spawning the
	// background task; the actual download may run for many minutes. So
	// 10s is comfortable — we are not waiting on the download itself.
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("install: %s", strings.TrimSpace(string(respBody)))
	}
	var raw struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return "", err
	}
	if raw.ID == "" {
		return "", fmt.Errorf("install: empty id in response")
	}
	return raw.ID, nil
}

// ModelDownload is the polled snapshot returned by
// `/runtime/models/download/:id`. Mirrors the Rust `runtime::ModelDownload`
// shape (snake_case JSON). Progress is 0..1, status is one of
// "downloading" | "complete" | "failed" | "cancelled".
type ModelDownload struct {
	ID       string  `json:"id"`
	RepoID   string  `json:"repo_id"`
	Filename string  `json:"filename"`
	Progress float64 `json:"progress"`
	Status   string  `json:"status"`
	Error    string  `json:"error,omitempty"`
}

// DownloadModel fetches the latest snapshot of an in-flight model
// download. The TUI wizard polls this every 500ms until Status reaches
// a terminal value ("complete" | "failed" | "cancelled"). A 404 means
// the gateway restarted and forgot the in-flight download — the caller
// should treat that as "failed" and surface a Retry CTA.
// ErrDownloadGone means the gateway no longer knows about this download id
// (it restarted and forgot the in-flight transfer). Terminal — the caller
// should stop polling and show a Retry CTA rather than looping forever.
var ErrDownloadGone = errors.New("download id not found")

func DownloadModel(baseURL, token, id string) (*ModelDownload, error) {
	req, _ := http.NewRequest("GET", baseURL+"/runtime/models/download/"+id, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 4 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return nil, fmt.Errorf("gateway restarted and forgot the download: %w", ErrDownloadGone)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("download poll: %s", strings.TrimSpace(string(respBody)))
	}
	var raw ModelDownload
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}
	return &raw, nil
}

func StreamChat(baseURL, token, content, sessionID string, chunks chan<- Chunk, done chan<- error) {
	body, _ := json.Marshal(map[string]string{
		"content":    content,
		"session_id": sessionID,
	})
	req, _ := http.NewRequest("POST", baseURL+"/runtime/chat", strings.NewReader(string(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := doRequest(streamClient, req)
	if err != nil {
		done <- err
		return
	}
	defer resp.Body.Close()

	tagBuffer := ""
	inThink := false
	scanner := bufio.NewScanner(resp.Body)
	// A single SSE `data:` line can be far larger than 64 KB — a grep with
	// many hits, a directory listing, any big tool result. At the old size
	// the scanner returned `token too long` and the stream ended mid-answer,
	// with nothing on screen to say why. 8 MB is past any real tool result.
	scanner.Buffer(make([]byte, 0, 65536), 8*1024*1024)
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
			// ask_user frames — the agent is blocked on the user's answer.
			if currentEvent == "ask_user" || currentEvent == "ask_user_cancelled" {
				if c, ok := parseAskFrame(currentEvent, data); ok {
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

// parseAskFrame decodes one typed ask_user / ask_user_cancelled frame.
func parseAskFrame(ev, body string) (Chunk, bool) {
	switch ev {
	case "ask_user":
		var req AskUserRequest
		if err := json.Unmarshal([]byte(body), &req); err != nil || req.ID == "" || len(req.Questions) == 0 {
			return Chunk{}, false
		}
		return Chunk{AskUser: &req}, true
	case "ask_user_cancelled":
		var raw map[string]json.RawMessage
		if err := json.Unmarshal([]byte(body), &raw); err != nil {
			return Chunk{}, false
		}
		id := jsonStr(raw["id"])
		if id == "" {
			return Chunk{}, false
		}
		return Chunk{AskUserCancelled: id}, true
	}
	return Chunk{}, false
}

// AskRespond answers a pending ask_user question (POST /runtime/ask/respond).
// Fire-and-forget on the host side — the agent turn resumes on its original
// SSE stream once the sidecar's bridge resolves.
func AskRespond(baseURL, token, requestID string, answers []AskAnswer) error {
	body, _ := json.Marshal(map[string]any{"requestId": requestID, "answers": answers})
	req, _ := http.NewRequest("POST", baseURL+"/runtime/ask/respond", strings.NewReader(string(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := doRequest(httpClient, req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("ask respond: %s: %s", resp.Status, strings.TrimSpace(string(b)))
	}
	return nil
}

// ParseAskReply maps a typed reply line to answers for `questions`. Per
// question token (comma-separated when there are several questions): a
// number picks that option ("2 3" / "2+3" multi-pick), an exact label match
// (case-insensitive) picks it, anything else is free-form custom text.
// Missing tokens fall back to the recommended (or first) option. Mirrors
// the sidecar's channel parser (src/core/ask-user-channel.ts).
func ParseAskReply(questions []AskQuestion, reply string) []AskAnswer {
	var tokens []string
	if len(questions) > 1 {
		for _, t := range strings.FieldsFunc(reply, func(r rune) bool { return r == ',' || r == '\n' }) {
			tokens = append(tokens, strings.TrimSpace(t))
		}
	} else {
		tokens = []string{strings.TrimSpace(reply)}
	}
	out := make([]AskAnswer, 0, len(questions))
	for i, q := range questions {
		token := ""
		if i < len(tokens) {
			token = tokens[i]
		}
		if token == "" {
			label := ""
			for _, o := range q.Options {
				if o.Recommended {
					label = o.Label
					break
				}
			}
			if label == "" && len(q.Options) > 0 {
				label = q.Options[0].Label
			}
			ans := AskAnswer{Question: q.Question, Selected: []string{}}
			if label != "" {
				ans.Selected = []string{label}
			}
			out = append(out, ans)
			continue
		}
		parts := strings.FieldsFunc(token, func(r rune) bool { return r == ' ' || r == '+' })
		numeric := len(parts) > 0
		for _, p := range parts {
			if _, err := strconv.Atoi(p); err != nil {
				numeric = false
				break
			}
		}
		if numeric {
			var picked []string
			for _, p := range parts {
				n, _ := strconv.Atoi(p)
				if n >= 1 && n <= len(q.Options) {
					picked = append(picked, q.Options[n-1].Label)
				}
			}
			if len(picked) > 0 {
				if !q.MultiSelect {
					picked = picked[:1]
				}
				out = append(out, AskAnswer{Question: q.Question, Selected: picked})
				continue
			}
		}
		matched := false
		for _, o := range q.Options {
			if strings.EqualFold(o.Label, token) {
				out = append(out, AskAnswer{Question: q.Question, Selected: []string{o.Label}})
				matched = true
				break
			}
		}
		if !matched {
			out = append(out, AskAnswer{Question: q.Question, Selected: []string{}, CustomText: token})
		}
	}
	return out
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
			// While inside a <think> block this text is reasoning — drop it,
			// never surface it as answer. The flush used to be unconditional,
			// so a </think> arriving split across tokens (its leading "<"
			// triggers the reserve) leaked the whole reasoning buffer into the
			// visible answer.
			if !*inThink {
				out += (*buf)[:safe]
			}
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
//	data: {"event":"cinderpaw://agent-output","data":{"data":"<json>"}}
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
	resp, err := doRequest(streamClient, req)
	if err != nil {
		done <- err
		return
	}
	defer resp.Body.Close()

	scanner := bufio.NewScanner(resp.Body)
	// A single SSE `data:` line can be far larger than 64 KB — a grep with
	// many hits, a directory listing, any big tool result. At the old size
	// the scanner returned `token too long` and the stream ended mid-answer,
	// with nothing on screen to say why. 8 MB is past any real tool result.
	scanner.Buffer(make([]byte, 0, 65536), 8*1024*1024)
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
