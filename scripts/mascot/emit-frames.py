"""Exporta corpul canonic din Aseprite in frames.ts. NU deseneaza nimic.

Desenul traieste in scripts/mascot/cinderpaw-96.aseprite. Aseprite scrie
grid-96.txt (dump-grid.lua). Scriptul de fata serializeaza grila in
frontend-react/src/components/chat/mascot/frames.ts si verifica pe drum:
96x96, doar litere din paleta, numar de pixeli neschimbat fata de grila.

  python scripts/mascot/emit-frames.py
"""

import os

HERE = os.path.dirname(os.path.abspath(__file__))
# Marimea bazei live: 32 arta la 2x = 64 personajul. Masterul ramane 96.
SIZE = 32
GRID = os.path.join(HERE, "grid-%d.txt" % SIZE)
BLINK = os.path.join(HERE, "grid-%d-blink.txt" % SIZE)
LOOKL = os.path.join(HERE, "grid-%d-lookl.txt" % SIZE)
LOOKR = os.path.join(HERE, "grid-%d-lookr.txt" % SIZE)
OUT = os.path.join(HERE, "..", "..", "frontend-react", "src",
                   "components", "chat", "mascot", "frames.ts")

STATES = ["idle", "typing", "thinking", "calling", "done", "running",
          "wave", "sleep", "surprised", "curious", "celebrate",
          "reading", "searching", "building", "writing",
          "stretching", "gaming", "love", "cool", "error", "excited",
          "spawning", "meditating"]

HEADER = """export type MascotState =
  | 'idle' | 'typing' | 'thinking' | 'calling' | 'done' | 'running'
  | 'wave' | 'sleep' | 'surprised' | 'curious' | 'celebrate'
  | 'reading' | 'searching' | 'building' | 'writing'
  | 'stretching' | 'gaming' | 'love' | 'cool' | 'error' | 'excited'
  | 'spawning' | 'meditating';

// Baza live 32x32 la 2x = 64 personajul (din masterul 96, treimi exacte).
// Toate starile arata acelasi corp: ce face agentul se citeste din bulele
// de tool-call de deaspora, nu din redesenarea animalului.
export const FRAME_W = 32;
export const FRAME_H = 32;

// Paleta masurata din originalul gemini-96.png. Culori plate, fara rampa:
// k blana, o fata si burta, h coarne, e ochi/gura/labe, w sparkle.
export const PALETTE: Record<string, string | null> = {
  '.': null,
  k: '#1a1a1a', o: '#f28c28', h: '#ffb15e', e: '#000000', w: '#ffffff',
};

// `o` ramane caracterul de corp, iar rampa e plata pe culoarea fetei, ca
// randarea din CinderpawMascot sa mearga neschimbata pe arta plata.
export const BODY_CHAR = 'o';
export const BODY_SHADE: string[] = Array.from(
  { length: FRAME_H }, () => '#f28c28');

export type Frame = string[];

"""


def read_grid(path):
    with open(path, encoding="utf-8") as f:
        rows = f.read().splitlines()
    assert len(rows) == SIZE, "grila nu e %d de randuri: %d" % (SIZE, len(rows))
    assert all(len(r) == SIZE for r in rows), "rand cu latime gresita"
    allowed = set(".kohew")
    bad = sum(1 for r in rows for ch in r if ch not in allowed)
    assert bad == 0, "%d caractere in afara paletei" % bad
    return rows


def const(name, rows):
    return ["const %s: Frame = [" % name] + ["  %r," % r for r in rows] + ["];", ""]


def main():
    rows = read_grid(GRID)
    blink = read_grid(BLINK)
    lookl = read_grid(LOOKL)
    lookr = read_grid(LOOKR)
    opaque = sum(1 for r in rows for ch in r if ch != ".")
    print("pixeli plini: %d" % opaque)
    for name, g in (("clipit", blink), ("stanga", lookl), ("dreapta", lookr)):
        changed = sum(1 for a, b in zip("\n".join(rows), "\n".join(g)) if a != b)
        print("pixeli schimbati (%s): %d" % (name, changed))
        assert changed > 0, "%s e identic cu repausul" % name

    consts = [("CANON", rows), ("BLINK", blink),
              ("LOOK_L", lookl), ("LOOK_R", lookr)]
    body = []
    for name, grid in consts:
        body += ["const %s_%d: Frame = [" % (name, SIZE)]
        body += ["  %r," % r for r in grid]
        body += ["];", ""]
    # Bucla idle: repaus ~2s, clipit, repaus ~1s, privit stanga, repaus ~1s,
    # privit dreapta. Aceleasi referinte repetate, nu copii.
    tag = str(SIZE)
    loop = (["CANON_" + tag] * 12 + ["BLINK_" + tag] + ["CANON_" + tag] * 6
            + ["LOOK_L_" + tag] * 3 + ["CANON_" + tag] * 6 + ["LOOK_R_" + tag] * 3)
    holds = ", ".join(loop)
    body += ["export const VARIANTS: Record<MascotState, Frame[][]> = {"]
    body += ["  idle: [[%s]]," % holds]
    body += ["  %s: [[CANON_%s]]," % (s, tag) for s in STATES if s != "idle"]
    body += ["};", ""]
    body += ["export const FRAMES: Record<MascotState, Frame[]> = {"]
    body += ["  idle: [%s]," % holds]
    body += ["  %s: [CANON_%s]," % (s, tag) for s in STATES if s != "idle"]
    body += ["};", ""]
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(HEADER + "\n".join(body))
    print("scris: " + OUT)


if __name__ == "__main__":
    main()
