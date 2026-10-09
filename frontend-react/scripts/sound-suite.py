"""Cinderpaw's sound suite, made like a studio session: ElevenLabs records the raw
material once, this script tunes, mixes and masters every cue locally.

  python frontend-react/scripts/sound-suite.py fetch   # needs the ElevenLabs key, about 1,600 credits
  python frontend-react/scripts/sound-suite.py build   # no key, no network
  python frontend-react/scripts/sound-suite.py check   # measures the built files, exit 1 on a fault

Run `fetch` from a PowerShell window of your own, never through Claude Code. The key
comes from ELEVENLABS_API_KEY or Windows Credential Manager and is never printed or written. Raw takes land in
output/sound-suite/raw and are never fetched twice. Needs numpy and scipy.

Identity: every tonal cue is built from one motif, A4 E5 C#5 ("Cin-der-paw"), in
A major pentatonic, so cues that overlap stay consonant. Three instruments play the
same notes; the person picks the material, not eleven unrelated sounds.
"""
import hashlib
import html
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from fractions import Fraction
from pathlib import Path

import numpy as np
from scipy import signal
from scipy.io import wavfile

RATE = 48000
ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / 'output' / 'sound-suite'
RAW, BUILD = WORK / 'raw', WORK / 'build'
CUBBY_VOICE = 'C9MXee9tu78kuWq66zMt'  # same voice as the onboarding lines (render-cubby-voice.ts)

TAIL = 'Close-miked, dry studio, high-quality professional recording. One note only, then silence.'
SFX = {  # name: (prompt, seconds, takes)
    'kalimba-high': (f'Single kalimba note in a high register, one-shot. Warm metal tine softened with felt, gentle thumb pluck, clear stable pitch, natural ringing decay. {TAIL}', 1.2, 3),
    'kalimba-mid': (f'Single kalimba note in the middle register, one-shot. Warm metal tine softened with felt, gentle thumb pluck, clear stable pitch, natural ringing decay. {TAIL}', 1.2, 3),
    'marimba-high': (f'Single rosewood marimba note in a high register, one-shot, struck softly with yarn mallets. Round warm wooden tone, clear stable pitch, natural decay. {TAIL}', 1.2, 3),
    'marimba-mid': (f'Single rosewood marimba note in the middle register, one-shot, struck softly with yarn mallets. Round warm wooden tone, clear stable pitch, natural decay. {TAIL}', 1.2, 3),
    'felt-high': (f'Single felt piano note in a high register, one-shot, played very gently. Soft hammer muffled by felt, warm intimate tone, clear stable pitch, natural decay. {TAIL}', 1.2, 3),
    'felt-mid': (f'Single felt piano note in the middle register, one-shot, played very gently. Soft hammer muffled by felt, warm intimate tone, clear stable pitch, natural decay. {TAIL}', 1.2, 3),
    'tap': ('One soft fingertip tap on a small felt-covered wooden block, one-shot. Short warm muted knock, intimate. Close-miked dry studio foley, high-quality recording. A single tap, then silence.', .5, 4),
    'latch': ('One small wooden latch clicking into place, one-shot. Crisp but cushioned tick with a light warm body, very short. Close-miked dry studio foley, high-quality recording. A single click, then silence.', .5, 4),
    'swish': ('One soft swish of thick paper sliding across linen, one-shot. Short smooth airy movement, gentle and close. Dry studio foley, high-quality recording. A single swish, then silence.', .7, 4),
    'embers': ('Tiny embers crackling softly in a quiet fireplace. A few sparse delicate pops and ticks, no flame roar, no wind, no music. Close-miked, dry, high-quality field recording.', 2.0, 3),
}
VOICE = {  # name: (text, takes); Cubby's own voice, no words that would wear out
    'wake': ('[curious] Hm?', 2),
    'wake-b': ('[inhales deeply] [curious] Mm-hm?', 2),
    'sleep': ('[exhales] Mmm... [sighs]', 2),
    'sleep-b': ('[sighs] Mm. [exhales] Hmm...', 2),
}
INSTRUMENTS = {'kalimba': 'Kalimba cu fetru', 'marimba': 'Marimba din lemn', 'felt': 'Pian cu fetru'}


# ---------- fetch: the only part that talks to ElevenLabs ----------

def post(url, body, key):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={'xi-api-key': key, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=180) as r:
        if not r.headers.get('Content-Type', '').startswith('audio/'):
            raise RuntimeError('expected audio, got ' + r.headers.get('Content-Type', '?'))
        return r.read()


def api_key():
    """ELEVENLABS_API_KEY, else the 'cinderpaw-elevenlabs' entry in Windows Credential
    Manager, so nobody has to paste the key anywhere. Never printed."""
    key = os.environ.get('ELEVENLABS_API_KEY', '').strip()
    if key or os.name != 'nt':
        return key
    import ctypes
    import ctypes.wintypes as w

    class Credential(ctypes.Structure):
        _fields_ = [('Flags', w.DWORD), ('Type', w.DWORD), ('TargetName', w.LPWSTR), ('Comment', w.LPWSTR),
                    ('LastWritten', w.FILETIME), ('BlobSize', w.DWORD), ('Blob', ctypes.POINTER(ctypes.c_ubyte)),
                    ('Persist', w.DWORD), ('AttributeCount', w.DWORD), ('Attributes', ctypes.c_void_p),
                    ('TargetAlias', w.LPWSTR), ('UserName', w.LPWSTR)]
    advapi = ctypes.WinDLL('advapi32')
    found = ctypes.POINTER(Credential)()
    if not advapi.CredReadW('cinderpaw-elevenlabs', 1, 0, ctypes.byref(found)):
        return ''
    blob = bytes(found.contents.Blob[:found.contents.BlobSize])
    advapi.CredFree(found)
    return (blob.decode('utf-16-le') if blob[1:2] == b'\0' else blob.decode()).strip()


def fetch():
    key = api_key()
    if not key:
        sys.exit('No ElevenLabs key: set ELEVENLABS_API_KEY in this window, or add a generic credential\n'
                 "named 'cinderpaw-elevenlabs' in Windows Credential Manager, then run again.")
    RAW.mkdir(parents=True, exist_ok=True)
    assert all(len(p) <= 450 for p, _, _ in SFX.values())
    jobs = [(f'{n}-{i}', 'sfx', n, p, s) for n, (p, s, k) in SFX.items() for i in range(k)]
    jobs += [(f'cubby-{n}-{i}', 'voice', n, t, i + 1) for n, (t, k) in VOICE.items() for i in range(k)]
    failed = []
    for take, kind, name, text, arg in jobs:
        path = RAW / f'{take}.wav'
        if path.exists():
            continue
        try:
            if kind == 'sfx':
                body = dict(text=text, duration_seconds=arg, prompt_influence=.7, model_id='eleven_text_to_sound_v2', loop=False)
                data = post('https://api.elevenlabs.io/v1/sound-generation?output_format=pcm_48000', body, key)
                # The docs say S16LE but not the channel count, so the length decides.
                channels = round(len(data) / 2 / RATE / arg)
                if channels not in (1, 2) or abs(len(data) / 2 / channels / RATE - arg) > .15:
                    raise RuntimeError(f'unexpected PCM size {len(data)} for {arg}s')
                pcm = np.frombuffer(data, '<i2').reshape(-1, channels)
                wavfile.write(path, RATE, pcm)
            else:
                body = dict(text=text, model_id='eleven_v4', seed=arg)
                path.write_bytes(post(f'https://api.elevenlabs.io/v1/text-to-speech/{CUBBY_VOICE}?output_format=wav_48000', body, key))
            (RAW / f'{take}.json').write_text(json.dumps(dict(kind=kind, request=body, fetched=time.strftime('%Y-%m-%d %H:%M')), indent=2))
            print('ok  ', take, flush=True)
        except urllib.error.HTTPError as e:
            if e.code == 401:
                sys.exit('ElevenLabs refused the key (401). If it was rotated, update the key, then run again.')
            failed.append(f'{take}: HTTP {e.code} {e.read().decode(errors="replace")[:200]}')
            print('FAIL', failed[-1], flush=True)
        except (RuntimeError, urllib.error.URLError) as e:
            failed.append(f'{take}: {e}')
            print('FAIL', failed[-1], flush=True)
    print(f'\n{len(jobs) - len(failed)}/{len(jobs)} takes on disk in {RAW}')
    if failed:
        sys.exit(1)


# ---------- analysis ----------

def load(path):
    rate, data = wavfile.read(path)
    if rate != RATE:
        data = signal.resample_poly(data.astype(np.float64), RATE, rate, axis=0)
    x = data.astype(np.float64) / (32768 if data.dtype == np.int16 else 1)
    x = x if x.ndim == 2 else np.column_stack([x, x])
    x -= x.mean(0)
    return x / max(1e-9, np.abs(x).max())


def env(x, ms=3):
    w = max(1, int(ms / 1000 * RATE))
    return np.sqrt(np.convolve((x * x).mean(1), np.ones(w) / w, 'same'))


def onset(x):
    e = env(x)
    return max(0, int(np.argmax(e > e.max() * .05)) - int(.002 * RATE))


def events(x):
    e = env(x, 10)
    return len(signal.find_peaks(e, height=e.max() * .2, prominence=e.max() * .15, distance=int(.08 * RATE))[0])


def trim_tail(x, db=-60):
    e = env(x)
    last = np.flatnonzero(e > e.max() * 10 ** (db / 20))
    return x[:last[-1] + int(.01 * RATE)] if len(last) else x


def fade(x, in_ms=.5, out_ms=12):
    x = x.copy()
    a, r = min(len(x) // 2, int(in_ms / 1000 * RATE)), min(len(x) // 2, int(out_ms / 1000 * RATE))
    if a:
        x[:a] *= (np.sin(np.linspace(0, np.pi / 2, a)) ** 2)[:, None]
    if r:
        x[-r:] *= (np.cos(np.linspace(0, np.pi / 2, r)) ** 2)[:, None]
    return x


def spectrum(x):
    m = x.mean(1)
    s = np.abs(np.fft.rfft(m * np.hanning(len(m)), 1 << 16))
    return np.fft.rfftfreq(1 << 16, 1 / RATE), s


def centroid(x):
    f, s = spectrum(x)
    band = (f > 50) & (f < 16000)
    return float((f[band] * s[band]).sum() / max(1e-12, s[band].sum()))


def pitch(x):
    """Lowest strong spectral peak after the attack, and how much energy sits on its harmonics."""
    seg = x[int(.02 * RATE):int(.22 * RATE)]
    f, s = spectrum(seg)
    band = (f > 120) & (f < 3000)
    top = s[band].max()
    peaks = signal.find_peaks(np.where(band, s, 0), height=top * .25, prominence=top * .1)[0]
    if not len(peaks):
        return None, 0.0
    k = peaks[0]
    a, b, c = np.log(s[k - 1:k + 2] + 1e-12)
    f0 = (k + .5 * (a - c) / (a - 2 * b + c)) * RATE / (1 << 16)
    wide = (f > 100) & (f < 10000)
    harm = sum(np.sum(s[(f > n * f0 * .985) & (f < n * f0 * 1.015)] ** 2) for n in range(1, 9))
    return float(f0), float(harm / max(1e-12, np.sum(s[wide] ** 2)))


def takes(name):
    paths = sorted(RAW.glob(f'{name}-[0-9].wav'))
    if not paths:
        sys.exit(f'No raw takes for {name} in {RAW}. Run `fetch` first.')
    return {p.stem: (lambda x: x[onset(x):])(load(p)) for p in paths}


# ---------- instruments and layers ----------

def shift(x, ratio):
    """Pitch by resampling, like a sampler: ratio 2 is an octave up and half as long."""
    r = Fraction(1 / ratio).limit_denominator(1000)
    return signal.resample_poly(x, r.numerator, r.denominator, axis=0)


class Instrument:
    def __init__(self, name, report):
        self.samples = []
        for take, x in {**takes(f'{name}-high'), **takes(f'{name}-mid')}.items():
            f0, tonal = pitch(x)
            ok = f0 is not None and events(x) == 1 and tonal > .25
            report[take] = dict(f0=round(f0 or 0, 1), tonality=round(tonal, 2), events=events(x), used=ok)
            if ok:
                self.samples.append((f0, x / np.abs(x).max()))
        if not self.samples:
            sys.exit(f'No clean single-note take for {name}; fetch more takes.')

    def note(self, midi, vel=.7, damp=None, attack=0):
        target = 440 * 2 ** ((midi - 69) / 12)
        f0, x = min(self.samples, key=lambda s: abs(math.log2(target / s[0])))  # nearest sample, least stretch
        y = shift(x, target / f0)
        y = signal.sosfilt(signal.butter(1, 1500 + 11000 * vel ** 2, 'low', fs=RATE, output='sos'), y, axis=0) * vel ** 1.4
        if damp:  # a felt hand on the note: rings briefly, then stops
            t = np.arange(len(y)) / RATE
            y = (y * np.where(t < .015, 1, np.exp(-(t - .015) / damp))[:, None])[:int((.015 + damp * 7) * RATE)]
        return fade(trim_tail(y, -70), attack, 10)  # attack > 0 is a breath in, not a pluck


def narrow(x, width=.25):
    """Keep the gesture in the centre so it survives a mono speaker; the room adds the width."""
    mid, side = x.mean(1, keepdims=True), (x[:, :1] - x[:, 1:]) / 2
    return np.hstack([mid + width * side, mid - width * side])


def pick_contact(name, picks):
    pool = {k: narrow(v) for k, v in takes(name).items()}
    if name in picks:
        return pool[f'{name}-{picks[name]}']
    clean = {k: v for k, v in pool.items() if events(v) <= (2 if name == 'swish' else 1)} or pool
    ranked = sorted(clean.items(), key=lambda kv: centroid(kv[1]))
    return ranked[len(ranked) // 2][1]  # median brightness: not harsh, not muddy


def ember_pops():
    found = []
    for x in takes('embers').values():
        e = env(x, 1)
        peaks, props = signal.find_peaks(e, prominence=e.max() * .15, distance=int(.03 * RATE))
        for p, prom in zip(peaks, props['prominences']):
            s = p - int(.003 * RATE)
            if s < 0 or p + int(.05 * RATE) > len(x):
                continue
            clip = fade(x[s:s + int(.05 * RATE)], .3, 30)
            found.append((prom, narrow(clip) / np.abs(clip).max()))
    strongest = [c for _, c in sorted(found, key=lambda t: -t[0])[:16]]
    return sorted(strongest, key=centroid)[:8] or sys.exit('No ember pops found')  # the warmest of the clean ones


def sweep(x, start_hz, end_hz):
    """A lowpass that opens (or closes) across the sound: brighter means arriving."""
    out = []
    for ch in x.T:
        f, t, z = signal.stft(ch, RATE, nperseg=512)
        cut = np.exp(np.linspace(np.log(start_hz), np.log(end_hz), len(t)))
        z *= 1 / np.sqrt(1 + (f[:, None] / cut[None, :]) ** 4)
        out.append(signal.istft(z, RATE, nperseg=512)[1][:len(ch)])
    return np.column_stack(out)


def place(parts):
    """parts: (seconds, audio, gain, pan). Balance pan, -1 left .. 1 right."""
    end = max(int(t * RATE) + len(y) for t, y, _, _ in parts)
    out = np.zeros((end, 2))
    for t, y, g, p in parts:
        s = int(t * RATE)
        out[s:s + len(y)] += y * g * np.array([min(1, 1 - p), min(1, 1 + p)])
    return out


def room():
    """A small warm room: decorrelated noise, darker as it decays, 0.55 s RT60."""
    rng = np.random.default_rng(7)
    n = int(.9 * RATE)
    t = np.arange(n)[:, None] / RATE
    noise = rng.standard_normal((n, 2))
    bright = signal.sosfilt(signal.butter(2, 6000, 'low', fs=RATE, output='sos'), noise, axis=0)
    dark = signal.sosfilt(signal.butter(2, 1600, 'low', fs=RATE, output='sos'), noise, axis=0)
    w = np.exp(-t / .15)
    ir = (bright * w + dark * (1 - w)) * 10 ** (-3 * t / .55)
    ir = np.vstack([np.zeros((int(.008 * RATE), 2)), ir])
    return ir / np.sqrt((ir ** 2).sum(0))


K_WEIGHT = np.array([[1.53512485958697, -2.69169618940638, 1.19839281085285, 1, -1.69065929318241, 0.73248077421585],
                     [1, -2, 1, 1, -1.99004745483398, 0.99007225036621]])  # ITU-R BS.1770 at 48 kHz


def loudness(x):
    """BS.1770 K-weighted level over the audible part only. A 400 ms gate would
    average a 60 ms click with silence, so this is a cue-sized reading, not LUFS-I."""
    e = env(x, 10)
    z = signal.sosfilt(K_WEIGHT, x, axis=0)[e > e.max() * .1]
    return -0.691 + 10 * math.log10(max(1e-12, (z ** 2).mean(0).sum()))


def peak_eq(hz, db, q=1.0):
    a, w = 10 ** (db / 40), 2 * math.pi * hz / RATE
    al, c = math.sin(w) / (2 * q), math.cos(w)
    b0, a0 = 1 + al * a, 1 + al / a
    return np.array([[b0 / a0, -2 * c / a0, (1 - al * a) / a0, 1, -2 * c / a0, (1 - al / a) / a0]])


def master(x, target, wet, hp=170):
    # Laptop speakers give little below ~400 Hz and turn 2.5-5 kHz brittle.
    x = signal.sosfilt(signal.butter(2, hp, 'high', fs=RATE, output='sos'), x, axis=0)
    x = signal.sosfilt(peak_eq(3500, -2.5), x, axis=0)
    if wet:
        ir = ROOM
        x = np.vstack([x, np.zeros((len(ir), 2))])
        x = x + wet * np.column_stack([signal.fftconvolve(x[:, c], ir[:, c])[:len(x)] for c in (0, 1)])
    x = signal.sosfilt(signal.butter(2, 12000, 'low', fs=RATE, output='sos'), x, axis=0)
    x = fade(trim_tail(x), .5, 12)  # before the level: a 0.5 ms fade can take 1 dB off a sharp tap
    x *= 10 ** ((target - loudness(x)) / 20)
    ceiling = 10 ** (-3 / 20)
    return x * min(1, ceiling / np.abs(x).max())  # gain, never a limiter: transients stay intact


def write(path, x):
    rng = np.random.default_rng(int(hashlib.sha256(path.name.encode()).hexdigest()[:8], 16))
    tpdf = (rng.random(x.shape) - rng.random(x.shape)) / 32768  # dither keeps quiet tails smooth
    wavfile.write(path, RATE, np.clip(np.rint((x + tpdf) * 32767), -32768, 32767).astype(np.int16))


# ---------- the suite ----------
# MIDI: A3 57, E4 64, A4 69, B4 71, C#5 73, E5 76. The key sits where ElevenLabs
# actually played the notes (~370-500 Hz), so no note is stretched more than ~5 semitones.
# Levels are cue-sized K-weighted dB,
# set by role: frequent gestures quiet, things you must notice louder, the logo loudest;
# an 18 dB spread, inside the 15-20 dB that earcon guidelines allow.

CUES = [  # id, label, target, wet, recipe(instrument, layers)
    ('tap', 'Buton principal', -31, .03, lambda I, L: place([(0, L['tap'][:int(.14 * RATE)], 1, 0)])),
    ('toggle-on', 'Comutator pornit', -31, .03, lambda I, L: place([(0, shift(L['latch'][:int(.12 * RATE)], 2 ** (2 / 12)), 1, 0)])),
    ('toggle-off', 'Comutator oprit', -32, .03, lambda I, L: place([(0, signal.sosfilt(signal.butter(1, 4500, 'low', fs=RATE, output='sos'), shift(L['latch'][:int(.12 * RATE)], 2 ** (-2 / 12)), axis=0), 1, 0)])),
    ('panel-open', 'Panou deschis', -33, .06, lambda I, L: place([(0, fade(sweep(L['swish'][:int(.24 * RATE)], 1200, 9000), 2, 60), 1, 0)])),
    ('panel-close', 'Panou închis', -35, .05, lambda I, L: place([(0, fade(sweep(L['swish'][:int(.19 * RATE)], 9000, 1200), 2, 50), 1, 0)])),
    ('message-send', 'Mesaj trimis', -28, .07, lambda I, L: place([(0, fade(sweep(L['swish'][:int(.15 * RATE)], 2000, 12000), 2, 40), 1, -.1), (.07, I.note(73, .35, .09), .5, .15)])),
    ('tool-approved', 'Tool aprobat', -26, .08, lambda I, L: place([(0, L['tap'][:int(.1 * RATE)], .22, 0), (0, I.note(69, .55, .11), 1, -.08), (.055, I.note(73, .7, .16), 1, .08)])),
    ('task-done', 'Sarcină terminată', -23, .14, lambda I, L: place([(0, I.note(64, .5), 1, -.12), (.07, I.note(69, .6), 1, 0), (.14, I.note(73, .8, .3), 1, .12), (.14, I.note(57, .35, .3), .8, 0), (.30, L['pops'][0], .09, .4), (.42, L['pops'][1], .06, -.3)])),
    ('error', 'Eroare', -24, .06, lambda I, L: place([(0, L['tap'][:int(.1 * RATE)], .2, 0), (0, I.note(73, .6, .07), 1, 0), (.12, L['tap'][:int(.1 * RATE)], .2, 0), (.12, I.note(71, .65, .1), 1, 0)])),
    ('notification', 'Notificare', -21, .12, lambda I, L: place([(0, I.note(57, .3, .25, 6), .7, 0), (0, I.note(69, .8, .25, 6), 1, -.1), (.15, I.note(76, .8, .35), 1, .1), (.5, L['pops'][2], .07, .35)])),
    ('cubby-wake', 'Cubby se trezește', -25, .1, lambda I, L: place([(0, L['wake'], 1, 0), (.05, I.note(69, .3), .35, -.2), (.17, I.note(73, .35), .35, .2)])),
    ('cubby-sleep', 'Cubby adoarme', -27, .16, lambda I, L: place([(0, L['sleep'], 1, 0), (.1, I.note(76, .25), .3, .2), (.4, I.note(73, .22), .3, 0), (.7, I.note(69, .2), .3, -.2)])),
    ('audio-logo', 'Semnătura Cinderpaw', -19, .2, lambda I, L: place([
        (0, fade(sweep(L['swish'][:int(.2 * RATE)], 800, 7000), 30, 40), .16, 0),
        (.1, I.note(69, .7), 1, -.1), (.23, I.note(76, .8), 1, .1), (.5, I.note(73, .9), 1, 0),
        (.5, I.note(57, .45), .9, 0), (.52, I.note(64, .35), .8, 0),
        (.72, L['pops'][0], .1, .4), (.88, L['pops'][3], .08, -.35), (1.05, L['pops'][4], .06, .25), (1.3, L['pops'][5], .04, -.2)])),
]


def voice_take(name, picks):
    pool = {**takes(f'cubby-{name}'), **takes(f'cubby-{name}-b')}
    chosen = picks.get(f'cubby-{name}') or sorted(pool)[0]
    return fade(trim_tail(pool[chosen], -55), 1, 30), sorted(pool), chosen


def build():
    picks = json.loads((WORK / 'picks.json').read_text()) if (WORK / 'picks.json').exists() else {}
    report = {}
    layers = {n: pick_contact(n, picks) for n in ('tap', 'latch', 'swish')}
    layers['pops'] = ember_pops()
    for n in ('wake', 'sleep'):
        layers[n], options, chosen = voice_take(n, picks)
        report[f'cubby-{n}'] = dict(options=options, chosen=chosen)
        out = BUILD / 'cubby-takes'
        out.mkdir(parents=True, exist_ok=True)
        pool = {**takes(f'cubby-{n}'), **takes(f'cubby-{n}-b')}
        for take in options:
            write(out / f'{take}.wav', master(place([(0, fade(trim_tail(pool[take], -55), 1, 30), 1, 0)]), -24, .1))
    manifest = []
    for flavor in INSTRUMENTS:
        inst = Instrument(flavor, report.setdefault(flavor, {}))
        (BUILD / flavor).mkdir(parents=True, exist_ok=True)
        for cue, label, target, wet, recipe in CUES:
            x = master(recipe(inst, layers), target, wet)
            path = BUILD / flavor / f'{cue}.wav'
            write(path, x)
            manifest.append(dict(flavor=flavor, id=cue, label=label, durationMs=round(len(x) / RATE * 1000),
                                 level=round(loudness(x), 1), target=target, sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
        print(f'{flavor}: {len(CUES)} cues', flush=True)
    (BUILD / 'manifest.json').write_text(json.dumps(dict(picks=picks, analysis=report, cues=manifest), indent=2, ensure_ascii=False), encoding='utf-8')
    (BUILD / 'index.html').write_text(page(), encoding='utf-8')
    print('Audition page:', BUILD / 'index.html')


def check():
    faults = []
    manifest = json.loads((BUILD / 'manifest.json').read_text(encoding='utf-8'))
    for c in manifest['cues']:
        rate, data = wavfile.read(BUILD / c['flavor'] / f"{c['id']}.wav")
        x = data.astype(np.float64) / 32768
        name = f"{c['flavor']}/{c['id']}"
        peak = 20 * math.log10(np.abs(x).max())
        mono = loudness(np.repeat(x.mean(1, keepdims=True), 2, 1)) - loudness(x)
        start = onset(x) / RATE * 1000
        end = 20 * math.log10(max(1e-9, np.abs(x[-int(.002 * RATE):]).max()))
        problems = [p for p, bad in [
            ('not 48 kHz stereo 16-bit', rate != RATE or x.ndim != 2 or data.dtype != np.int16),
            (f'peak {peak:.1f} dBFS', peak > -2.9),
            (f'level {loudness(x):.1f} vs {c["target"]}', abs(loudness(x) - c['target']) > 1),
            (f'mono sum {mono:+.1f} dB', mono < -3),
            (f'starts {start:.0f} ms late', start > 25 and not c['id'].startswith('audio-logo') and not c['id'].startswith('cubby')),
            (f'ends at {end:.0f} dBFS, a click', end > -60),
        ] if bad]
        faults += [f'{name}: {p}' for p in problems]
        print(f"{name:28} {c['durationMs']:5} ms  {loudness(x):6.1f}  peak {peak:5.1f}  mono {mono:+.1f}  {'OK' if not problems else ', '.join(problems)}")
    print(f'\n{len(manifest["cues"])} files, {len(faults)} faults')
    sys.exit(1 if faults else 0)


def page():
    cues = [(c[0], c[1]) for c in CUES]
    flavors = json.dumps(list(INSTRUMENTS))
    cards = ''.join(f'<article><h3>{html.escape(label)}</h3><button data-seq="{f}">Ascultă identitatea</button>'
                    f'<div class="row">' + ''.join(f'<button class="s" data-f="{f}" data-id="{c}">{html.escape(l)}</button>' for c, l in cues) + '</div></article>'
                    for f, label in INSTRUMENTS.items())
    voices = ''.join(f'<button class="s" data-src="cubby-takes/{p.stem}.wav">{p.stem}</button>' for p in sorted((BUILD / 'cubby-takes').glob('*.wav')))
    return f'''<!doctype html><html lang="ro"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cinderpaw · sunete</title><style>
:root{{--bg:#FAF6F0;--card:#fffdf9;--ink:#2a221b;--muted:#6f6254;--line:#e6dccb;--brand:#C4843A}}
@media (prefers-color-scheme:dark){{:root{{--bg:#1C1814;--card:#26201a;--ink:#EDE4D3;--muted:#b5a893;--line:#3a3128}}}}
body{{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,sans-serif}}main{{max-width:980px;margin:0 auto;padding:40px 16px}}
h1{{font-size:28px;letter-spacing:-.5px;margin:0 0 6px}}h2{{font-size:18px;margin:36px 0 8px}}h3{{font-size:16px;margin:0 0 10px}}p{{color:var(--muted);max-width:680px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}}article,.mock{{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px}}
button{{font:inherit;border:1px solid var(--line);background:transparent;color:var(--ink);border-radius:999px;padding:7px 14px;cursor:pointer}}
button:focus-visible{{outline:2px solid var(--brand);outline-offset:2px}}[data-seq],.primary{{background:var(--brand);border-color:var(--brand);color:#fff}}
.row{{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}}.s{{font-size:13px;padding:4px 11px}}.mock{{display:grid;gap:14px}}.line{{display:flex;flex-wrap:wrap;gap:8px;align-items:center}}
input[type=text]{{font:inherit;flex:1;min-width:160px;padding:8px 12px;border-radius:12px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}}
.panel{{display:none;border:1px dashed var(--line);border-radius:12px;padding:12px}}.panel.open{{display:block}}label{{display:inline-flex;gap:6px;align-items:center}}
</style><main>
<h1>Cinderpaw · suita de sunete</h1>
<p>Toate sunetele tonale vin din același motiv de trei note, Cin-der-paw, în La major pentatonic. Același motiv, trei materiale. Alegi materialul, nu sunete separate.</p>
<h2>1. Alege materialul</h2><p>„Ascultă identitatea” cântă semnătura, notificarea, sarcina terminată și eroarea, una după alta.</p>
<div class="grid">{cards}</div>
<h2>2. Ascultă în context</h2><p>Folosește controalele ca în aplicație. Volumul sistemului la nivel obișnuit, apoi încet; pe difuzoarele laptopului și în căști.</p>
<div class="mock"><div class="line">Material: {''.join(f'<label><input type="radio" name="f" value="{f}"{" checked" if i == 0 else ""}> {html.escape(l)}</label>' for i, (f, l) in enumerate(INSTRUMENTS.items()))}</div>
<div class="line"><button class="primary" data-c="tap">Continuă</button><label><input type="checkbox" id="tg"> Comutator</label><button id="pn">Deschide panoul</button></div>
<div class="panel" id="panel">Un panou. <button id="pc">Închide</button></div>
<div class="line"><input type="text" id="msg" placeholder="Scrie un mesaj și apasă Enter"><button class="primary" id="send">Trimite</button></div>
<div class="line"><button data-c="tool-approved">Aprobă tool-ul</button><button data-c="notification">Cubby are nevoie de tine</button><button data-c="error">Ceva n-a mers</button><button data-c="task-done">Sarcină terminată</button></div>
<div class="line"><button id="sleep">Cubby adoarme</button><button data-c="audio-logo">Semnătura</button></div></div>
<h2>3. Vocea lui Cubby</h2><p>Variantele brute, fără note. Spune-mi care sună cel mai mult a Cubby.</p><div class="row">{voices}</div>
</main><script>
const flavors={flavors},cache={{}};
const flavor=()=>document.querySelector('input[name=f]:checked').value;
function audio(src){{return cache[src]??=Object.assign(new Audio(src),{{preload:'auto'}})}}
function play(src){{const a=audio(src).cloneNode();a.play();return a}}
const cue=(id,f=flavor())=>play(`${{f}}/${{id}}.wav`);
document.addEventListener('click',e=>{{const b=e.target.closest('button');if(!b)return;
 if(b.dataset.c)cue(b.dataset.c);if(b.dataset.id)cue(b.dataset.id,b.dataset.f);if(b.dataset.src)play(b.dataset.src);
 if(b.dataset.seq)(async()=>{{for(const id of ['audio-logo','notification','task-done','error']){{const a=cue(id,b.dataset.seq);await new Promise(r=>a.onended=r);await new Promise(r=>setTimeout(r,700))}}}})()}});
document.getElementById('tg').onchange=e=>cue(e.target.checked?'toggle-on':'toggle-off');
document.getElementById('pn').onclick=()=>{{document.getElementById('panel').classList.add('open');cue('panel-open')}};
document.getElementById('pc').onclick=()=>{{document.getElementById('panel').classList.remove('open');cue('panel-close')}};
let asleep=false;document.getElementById('sleep').onclick=e=>{{asleep=!asleep;cue(asleep?'cubby-sleep':'cubby-wake');e.target.textContent=asleep?'Trezește-l pe Cubby':'Cubby adoarme'}};
function send(){{const m=document.getElementById('msg');if(!m.value.trim())return;m.value='';cue('message-send');setTimeout(()=>cue('task-done'),1800)}}
document.getElementById('send').onclick=send;document.getElementById('msg').onkeydown=e=>{{if(e.key==='Enter')send()}};
flavors.forEach(f=>['tap','toggle-on','toggle-off','panel-open','message-send'].forEach(id=>audio(`${{f}}/${{id}}.wav`)));
</script></html>'''


ROOM = room()

if __name__ == '__main__':
    command = sys.argv[1] if len(sys.argv) > 1 else ''
    {'fetch': fetch, 'build': build, 'check': check}.get(command, lambda: sys.exit(__doc__))()
