"""Cinderpaw UI sounds synthesised from scratch: clean sines, bubble pops and FM glass,
the way Messenger/WhatsApp/iOS cues are built. No samples, no network, no credits.

  python frontend-react/scripts/ui-synth.py            # writes output/sound-suite/synth + audition page
  python frontend-react/scripts/ui-synth.py --install  # also copies the pack into src/assets/sounds
  python frontend-react/scripts/ui-synth.py check    # measures the files, exit 1 on a fault

Reuses the mastering, measuring and audition page from sound-suite.py.
"""
import importlib.util
import json
import hashlib
import sys
from pathlib import Path

import numpy as np

spec = importlib.util.spec_from_file_location('suite', Path(__file__).with_name('sound-suite.py'))
S = importlib.util.module_from_spec(spec)
spec.loader.exec_module(S)
RATE = S.RATE
S.BUILD = S.WORK / 'synth'


def hz(midi):
    return 440 * 2 ** ((midi - 69) / 12)


def env(n, attack, tau):
    t = np.arange(n) / RATE
    return np.minimum(1, t / max(attack, 1e-4)) * np.exp(-t / tau)


def phase(freq):
    return 2 * np.pi * np.cumsum(freq) / RATE


def tone(midi, timbre, tau=.12, vel=.8, attack=.002):
    """One note. bubble: a pure sine that drops a touch into pitch, like a drop.
    wood: a sine with marimba-like partials (4x, 9.9x) that fade fast, Tri-Tone style."""
    f = hz(midi)
    n = int((attack + tau * 6) * RATE)
    t = np.arange(n) / RATE
    if timbre == 'bubble':
        y = np.sin(phase(f * (1 + .06 * np.exp(-t / .012)))) + .06 * np.sin(phase(2 * f * np.ones(n)))
    else:  # wood
        y = np.sin(2 * np.pi * f * t) + .35 * np.sin(2 * np.pi * 4 * f * t) * np.exp(-t / .02) + .1 * np.sin(2 * np.pi * 9.9 * f * t) * np.exp(-t / .006)
    y = y * env(n, attack, tau) * vel ** 1.3
    return np.column_stack([y, y])


def pop(start_hz, peak_hz, end_hz, length=.09, vel=.8):
    """The chat-app bubble: a sine that leaps up then settles, gone in under 100 ms."""
    n = int(length * RATE)
    t = np.arange(n) / RATE
    rise = np.minimum(1, t / (length * .35))
    f = np.where(t < length * .35, start_hz * (peak_hz / start_hz) ** rise, peak_hz * (end_hz / peak_hz) ** ((t - length * .35) / (length * .65)))
    y = np.sin(phase(f)) * env(n, .0015, length / 3.5) * vel
    return np.column_stack([y, y])


def tick(freq=2600, length=.03, vel=.8):
    """A tiny tap: a 4 ms band of noise and a short high sine, felt more than heard."""
    rng = np.random.default_rng(3)
    n = int(length * RATE)
    t = np.arange(n) / RATE
    noise = S.signal.sosfilt(S.signal.butter(2, [freq * .6, freq * 1.6], 'band', fs=RATE, output='sos'), rng.standard_normal(n)) * np.exp(-t / .004)
    y = .6 * noise / np.abs(noise).max() + np.sin(2 * np.pi * freq * t) * np.exp(-t / .008)
    return np.column_stack([y, y]) * vel


def swoosh(up=True, length=.14):
    rng = np.random.default_rng(5)
    n = int(length * RATE)
    x = rng.standard_normal((n, 2)) * np.sin(np.pi * np.arange(n) / n)[:, None] ** 2
    x = S.narrow(x / np.abs(x).max(), .3)
    return S.sweep(x, 900, 6000) if up else S.sweep(x, 6000, 900)


# A major pentatonic, one octave up from the sample suite: A5 81, B5 83, C#6 85, E6 88, A6 93.
FLAVORS = {'wood': 'Lemn moale (stil Tri-Tone)'}  # Darius's pick, 9 Oct 2026, over FM glass and pure bubble
APP = Path(__file__).resolve().parents[1] / 'src'


def voice(take, tail_db=-55):
    """Cubby's own ElevenLabs voice (raw take from sound-suite.py fetch), no words."""
    return S.fade(S.trim_tail(S.load(S.RAW / f'{take}.wav')[S.onset(S.load(S.RAW / f'{take}.wav')):], tail_db), 1, 40)


def cues(T):
    return [
        ('tap', 'Buton principal', -31, .0, lambda: S.place([(0, tick(), 1, 0)])),
        ('toggle-on', 'Comutator pornit', -31, .0, lambda: S.place([(0, pop(700, 1150, 1050, .06), 1, 0)])),
        ('toggle-off', 'Comutator oprit', -32, .0, lambda: S.place([(0, pop(1050, 1100, 700, .06), 1, 0)])),
        ('panel-open', 'Panou deschis', -34, .03, lambda: S.place([(0, swoosh(True), 1, 0)])),
        ('panel-close', 'Panou închis', -36, .03, lambda: S.place([(0, swoosh(False, .12), 1, 0)])),
        ('message-send', 'Mesaj trimis', -27, .04, lambda: S.place([(0, pop(420, 1250, 950, .1), 1, 0)])),
        ('tool-approved', 'Tool aprobat', -26, .05, lambda: S.place([(0, tone(81, T, .07, .6), 1, -.05), (.06, tone(88, T, .12, .8), 1, .05)])),
        ('task-done', 'Sarcină terminată', -23, .07, lambda: S.place([(0, tone(81, T, .07, .55), 1, -.1), (.07, tone(85, T, .08, .65), 1, 0), (.14, tone(88, T, .22, .85), 1, .1)])),
        ('error', 'Eroare', -25, .04, lambda: S.place([(0, tone(76, 'bubble', .07, .7), 1, 0), (.11, tone(73, 'bubble', .1, .7), 1, 0)])),
        ('notification', 'Notificare', -21, .08, lambda: S.place([(0, tone(81, T, .14, .85, .003), 1, -.08), (.13, tone(88, T, .3, .8, .003), 1, .08)])),
        ('cubby-wake', 'Cubby se trezește', -26, .05, lambda: S.place([(0, voice('cubby-wake-0'), 1, 0)])),
        ('cubby-sleep', 'Cubby adoarme', -30, .08, lambda: S.place([(0, voice('cubby-sleep-0'), 1, 0)])),
        ('audio-logo', 'Semnătura Cinderpaw', -19, .12, lambda: S.place([(0, tone(81, T, .1, .8), 1, -.1), (.12, tone(88, T, .12, .85), 1, .1), (.36, tone(85, T, .45, .9), 1, 0), (.36, tone(69, 'bubble', .5, .5), .6, 0), (.37, tone(76, 'bubble', .45, .35), .4, 0)])),
    ]


def build():
    S.INSTRUMENTS = FLAVORS
    manifest = []
    for flavor in FLAVORS:
        (S.BUILD / flavor).mkdir(parents=True, exist_ok=True)
        S.CUES = cues(flavor)
        for cue, label, target, wet, recipe in S.CUES:
            x = S.master(recipe(), target, wet, hp=250)
            path = S.BUILD / flavor / f'{cue}.wav'
            S.write(path, x)
            manifest.append(dict(flavor=flavor, id=cue, label=label, durationMs=round(len(x) / RATE * 1000),
                                 level=round(S.loudness(x), 1), target=target, sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
    (S.BUILD / 'manifest.json').write_text(json.dumps(dict(cues=manifest), indent=2, ensure_ascii=False), encoding='utf-8')
    (S.BUILD / 'index.html').write_text(S.page(), encoding='utf-8')
    print('Audition page:', S.BUILD / 'index.html')
    if '--install' in sys.argv:  # the app ships these; no key or network at runtime
        out = APP / 'assets' / 'sounds'
        out.mkdir(parents=True, exist_ok=True)
        for c in manifest:
            (out / f"{c['id']}.wav").write_bytes((S.BUILD / c['flavor'] / f"{c['id']}.wav").read_bytes())
        (APP / 'voice' / 'ui-sounds.json').write_text(json.dumps([{k: c[k] for k in ('id', 'durationMs', 'sha256')} for c in manifest], indent=2) + '\n')
        print(f'Installed {len(manifest)} sounds into', out)


if __name__ == '__main__':
    S.check() if 'check' in sys.argv else build()
