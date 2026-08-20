package app

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"feral-tui/ui"
)

// WhatsApp QR pairing surface. The sidecar mirrors each fresh Baileys pairing
// QR to ~/.feral/whatsapp-qr.json ({ts, qr, ascii}, rewritten on every ~20s
// rotation, deleted once linked) — see CinderpawAgent/src/transports/connectors.ts.
// The TUI reads that file directly (same machine, loopback-only gateway) so a
// terminal user can pair without hunting for the gateway's stderr.

// waQRFile mirrors the on-disk JSON written by the sidecar.
type waQRFile struct {
	Ts    float64 `json:"ts"`
	QR    string  `json:"qr"`
	Ascii string  `json:"ascii"`
}

// waQRTTL is how long one Baileys pairing code stays scannable.
const waQRTTL = 20 * time.Second

// readWhatsAppQR returns the pending pairing QR (terminal ASCII art) and its
// remaining validity in seconds. ok is false when no fresh code is on disk —
// either pairing isn't running, or the sidecar died and the file went stale.
func readWhatsAppQR() (ascii string, secondsLeft int, ok bool) {
	raw, err := os.ReadFile(filepath.Join(feralHomeDir(), "whatsapp-qr.json"))
	if err != nil {
		return "", 0, false
	}
	var f waQRFile
	if json.Unmarshal(raw, &f) != nil || f.Ascii == "" {
		return "", 0, false
	}
	age := time.Since(time.UnixMilli(int64(f.Ts)))
	if age > 2*time.Minute {
		return "", 0, false
	}
	left := int((waQRTTL - age).Seconds())
	if left < 0 {
		left = 0
	}
	return f.Ascii, left, true
}

// whatsappLinked reports whether Baileys has a persisted session — the same
// heuristic the desktop backend uses (src-tauri/src/connectors.rs).
func whatsappLinked() bool {
	_, err := os.Stat(filepath.Join(feralHomeDir(), "whatsapp-auth", "creds.json"))
	return err == nil
}

// whatsappQRLines renders the transcript block for `/connectors qr`.
func whatsappQRLines() []string {
	if whatsappLinked() {
		return []string{"whatsapp · linked " + ui.G.OK}
	}
	ascii, left, ok := readWhatsAppQR()
	if !ok {
		return []string{
			"whatsapp · no pairing code yet",
			"turn it on first: /connectors add whatsapp",
		}
	}
	lines := []string{"scan with WhatsApp → Settings → Linked devices:", ""}
	lines = append(lines, strings.Split(ascii, "\n")...)
	lines = append(lines,
		fmt.Sprintf("this code expires in ~%ds — run /connectors qr for a fresh one", left),
		"use a SECONDARY number — automation can get a number banned",
	)
	return lines
}
