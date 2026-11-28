"""Small DSP toolkit for the Tiny Tiny Zombies miniature sound pipeline.

All audio is float32 stereo, shape (n, 2), at SR. Decoding / encoding / rubberband go through ffmpeg.
Nothing here synthesises source sounds: it only edits recorded material (trim, resample, EQ, room, mix).
The small-room impulse response is a generated decaying noise burst, i.e. a reverb processor.
"""
import os, subprocess, tempfile
import numpy as np
from scipy import signal

SR = 48000
RNG = np.random.default_rng(1234)


def seed(s):
    global RNG
    RNG = np.random.default_rng(s)


# ---------------------------------------------------------------- io
_CACHE = {}


def load(path, start=None, dur=None):
    key = (path, start, dur)
    if key not in _CACHE:
        _CACHE[key] = _load(path, start, dur)
    return _CACHE[key].copy()


def _load(path, start=None, dur=None):
    cmd = ["ffmpeg", "-v", "error"]
    if start is not None: cmd += ["-ss", str(start)]
    if dur is not None: cmd += ["-t", str(dur)]
    cmd += ["-i", path, "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"]
    raw = subprocess.run(cmd, check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).copy()


def save(x, path, fmt=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fmt = fmt or os.path.splitext(path)[1][1:]
    codec = {"mp3": ["-c:a", "libmp3lame", "-b:a", "128k"],
             "ogg": ["-c:a", "libvorbis", "-q:a", "4"],
             "wav": ["-c:a", "pcm_s16le"]}[fmt]
    sr_out = 44100 if fmt == "mp3" else SR
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "-",
                    "-ar", str(sr_out)] + codec + [path], input=np.clip(x, -1, 1).astype(np.float32).tobytes(), check=True)


def ffilter(x, af):
    """Run an ffmpeg audio filter chain on x (used for rubberband pitch/tempo)."""
    with tempfile.TemporaryDirectory() as d:
        i, o = os.path.join(d, "i.f32"), os.path.join(d, "o.f32")
        x.astype(np.float32).tofile(i)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", i,
                        "-af", af, "-f", "f32le", "-ar", str(SR), "-ac", "2", o], check=True)
        return np.fromfile(o, np.float32).reshape(-1, 2).copy()


# ---------------------------------------------------------------- editing
def db(v): return 10 ** (v / 20)


def silence(sec): return np.zeros((int(sec * SR), 2), np.float32)


def movavg(p, n):
    c = np.concatenate([[0.0], np.cumsum(p, dtype=np.float64)])
    out = (c[n:] - c[:-n]) / n
    pad = n // 2
    return np.concatenate([np.full(pad, out[0]), out, np.full(len(p) - len(out) - pad, out[-1])])


def env_db(x, win=0.01):
    m = np.abs(x).max(1)
    n = max(1, min(int(win * SR), len(m)))
    e = np.sqrt(movavg(m ** 2, n) + 1e-12)
    return 20 * np.log10(e + 1e-9)


def autotrim(x, thresh=-45, pre=0.004, post=0.03):
    e = env_db(x)
    on = np.where(e > e.max() + thresh)[0]
    if len(on) == 0: return x
    a = max(0, on[0] - int(pre * SR)); b = min(len(x), on[-1] + int(post * SR))
    return x[a:b]


def events(x, thresh=-30, gap=0.12, minlen=0.03):
    """Split a recording into separate events (e.g. single shots in a take)."""
    e = env_db(x, 0.005)
    act = e > e.max() + thresh
    segs, i, n, g = [], 0, len(x), int(gap * SR)
    idx = np.where(act)[0]
    if len(idx) == 0: return [x]
    start = prev = idx[0]
    for k in idx[1:]:
        if k - prev > g:
            segs.append((start, prev)); start = k
        prev = k
    segs.append((start, prev))
    out = []
    for a, b in segs:
        if (b - a) / SR >= minlen:
            out.append(autotrim(x[max(0, a - int(0.003 * SR)):min(n, b + int(gap * 0.8 * SR))], -60))
    return out or [x]


def cut(x, dur, fade=0.05):
    x = x[:int(dur * SR)].copy()
    return fadeout(x, fade)


def fadeout(x, sec):
    n = min(len(x), int(sec * SR))
    if n > 0: x[-n:] *= np.linspace(1, 0, n)[:, None] ** 2
    return x


def fadein(x, sec):
    n = min(len(x), int(sec * SR))
    if n > 0: x[:n] *= np.linspace(0, 1, n)[:, None]
    return x


def tape(x, k):
    """Play back k times faster: pitch AND speed up together (like a sped-up tape)."""
    from fractions import Fraction
    f = Fraction(1 / k).limit_denominator(64)
    return signal.resample_poly(x, f.numerator, f.denominator, axis=0).astype(np.float32)


def pitch(x, ratio, tempo=1.0, formant=False):
    """Independent pitch / tempo (rubberband). formant=True keeps formants (less chipmunk)."""
    fm = ":formant=preserved" if formant else ""
    return ffilter(x, f"rubberband=pitch={ratio}:tempo={tempo}:transients=crisp{fm}")


def _sos(kind, f, order=2):
    return signal.butter(order, f, kind, fs=SR, output="sos")


def hp(x, f, order=2): return signal.sosfilt(_sos("highpass", f, order), x, axis=0).astype(np.float32)


def lp(x, f, order=2): return signal.sosfilt(_sos("lowpass", f, order), x, axis=0).astype(np.float32)


def peq(x, f, gain_db, q=1.0):
    A = 10 ** (gain_db / 40); w = 2 * np.pi * f / SR; al = np.sin(w) / (2 * q)
    b = [1 + al * A, -2 * np.cos(w), 1 - al * A]; a = [1 + al / A, -2 * np.cos(w), 1 - al / A]
    return signal.lfilter(np.array(b) / a[0], np.array(a) / a[0], x, axis=0).astype(np.float32)


def shelf_lo(x, f, gain_db):
    """Low shelf via parallel lowpass (simple, phase-safe enough for SFX)."""
    return (x + (db(gain_db) - 1) * lp(x, f)).astype(np.float32)


def room(x, rt=0.08, wet=0.18, pre=0.002, size=1.0):
    """Tight tabletop room: early reflections 2-11 ms + short exponential noise tail."""
    n = int((rt * 1.6 + 0.02) * SR)
    t = np.arange(n) / SR
    ir = np.zeros((n, 2), np.float32)
    for d, g in [(0.0023, .55), (0.0041, .42), (0.0063, .33), (0.0087, .25), (0.0112, .18)]:
        for c in (0, 1):
            k = int((pre + d * size * (1 + 0.07 * c)) * SR)
            if k < n: ir[k, c] += g * (1 if RNG.random() > .3 else -1)
    tail = RNG.standard_normal((n, 2)).astype(np.float32) * np.exp(-6.9 * t / rt)[:, None] * 0.22
    tail[:int((pre + 0.004) * SR)] = 0
    ir += hp(lp(tail, 7000), 250)
    dry = np.concatenate([x, np.zeros((n, 2), np.float32)])
    w = np.zeros_like(dry)
    c = signal.fftconvolve(x, ir, axes=0)[:len(dry)]
    w[:len(c)] = c
    return autotrim(dry + wet * w, -70, 0, 0.01)


def width(x, w):
    m = (x[:, 0] + x[:, 1]) / 2; s = (x[:, 0] - x[:, 1]) / 2 * w
    return np.stack([m + s, m - s], 1).astype(np.float32)


def mono(x): return width(x, 0)


def pan(x, p):
    """p in [-1,1], constant power."""
    a = (p + 1) * np.pi / 4
    m = x.mean(1)
    return np.stack([m * np.cos(a), m * np.sin(a)], 1).astype(np.float32) * 1.41


def mix(parts, length=None):
    """parts: list of (x, offset_sec, gain_db)."""
    end = max(int(o * SR) + len(x) for x, o, g in parts)
    L = int(length * SR) if length else end
    out = np.zeros((max(L, 1), 2), np.float32)
    for x, o, g in parts:
        a = int(o * SR)
        if a >= L: continue
        seg = x[:L - a]
        out[a:a + len(seg)] += seg * db(g)
    return out


def concat(parts, gap=0.0):
    out = []
    for p in parts:
        out += [p, silence(gap)]
    return np.concatenate(out[:-1] if gap else out)


def loopify(x, xf=1.0):
    """Make a seamless loop by crossfading the tail into the head."""
    n = int(xf * SR)
    head, body, tail = x[:n], x[n:-n] if len(x) > 3 * n else x[n:], x[-n:]
    r = np.linspace(0, 1, n)[:, None]
    blended = tail * np.sqrt(1 - r) + head * np.sqrt(r)
    return np.concatenate([body[:len(body) - 0], blended]) if len(x) > 3 * n else x


def tremolo(x, rate, depth):
    t = np.arange(len(x)) / SR
    m = 1 - depth * (0.5 + 0.5 * np.sin(2 * np.pi * rate * t + RNG.random() * 6))
    return (x * m[:, None]).astype(np.float32)


def stretch_loop(x, dur):
    """Tile a sound to `dur` seconds with crossfades (for loops from short material)."""
    out = x
    while len(out) < dur * SR + SR:
        out = xfade_cat(out, x, min(0.3, len(x) / SR / 3))
    return out[:int(dur * SR)]


def xfade_cat(a, b, xf):
    n = int(xf * SR)
    r = np.linspace(0, 1, n)[:, None]
    return np.concatenate([a[:-n], a[-n:] * np.sqrt(1 - r) + b[:n] * np.sqrt(r), b[n:]]).astype(np.float32)


# ---------------------------------------------------------------- loudness
def _kweight(x):
    y = hp(x, 60, 2)
    return peq(y, 3000, 4, 0.5)


def loudness_max(x, win=0.4):
    """Max momentary loudness (LUFS-like, K-weighted approximation, 400 ms)."""
    y = _kweight(x)
    p = (y ** 2).sum(1)
    n = int(win * SR)
    if len(p) < n: p = np.pad(p, (0, n - len(p)))
    c = np.concatenate([[0.0], np.cumsum(p, dtype=np.float64)])
    c = (c[n:] - c[:-n]) / n
    return -0.691 + 10 * np.log10(c.max() + 1e-12)


def loudness_int(x):
    y = _kweight(x); p = (y ** 2).sum(1)
    return -0.691 + 10 * np.log10(p.mean() + 1e-12)


def limit(x, ceil_db=-3.0):
    c = db(ceil_db)
    pk = np.abs(x).max()
    if pk <= c * 0.7: return x
    # soft knee above 70 % of ceiling
    k = c * 0.7
    s = np.sign(x); a = np.abs(x)
    over = a > k
    a[over] = k + (c - k) * np.tanh((a[over] - k) / (c - k))
    return (s * a).astype(np.float32)


def normalize(x, target, mode="max"):
    x = lp(x, 16000, 4)  # avoids encoder ringing overs on very bright transients
    cur = loudness_max(x) if mode == "max" else loudness_int(x)
    return limit(x * db(target - cur))
