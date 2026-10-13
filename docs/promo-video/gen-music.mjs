// An original 30-second track, synthesised sample by sample (no samples, no third-party audio): 120 BPM, A minor,
// Am - F - C - G. Four-on-the-floor kick, side-chained pad, bass and arpeggio, claps, hats, a riser into the drop at 4 s,
// a second drop at 24 s and a ringing last chord at 28 s. The video's cuts sit on this beat grid (one beat = 0.5 s).
//   node gen-music.mjs   ->  work/music.wav
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const SR = 44100,
  DUR = 30,
  N = SR * DUR,
  BEAT = 0.5,
  BAR = 2.0;
const L = new Float32Array(N),
  R = new Float32Array(N);
const SEND = { L: new Float32Array(N), R: new Float32Array(N) }; // reverb send
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const add = (t0, buf, gL, gR, send = 0) => {
  // mix a rendered sound into the stereo bus
  const s0 = Math.round(t0 * SR);
  for (let i = 0; i < buf.length && s0 + i < N; i++) {
    const v = buf[i];
    L[s0 + i] += v * gL;
    R[s0 + i] += v * gR;
    if (send) {
      SEND.L[s0 + i] += v * gL * send;
      SEND.R[s0 + i] += v * gR * send;
    }
  }
};
const polyblep = (t, dt) =>
  t < dt
    ? ((t /= dt), t + t - t * t - 1)
    : t > 1 - dt
      ? ((t = (t - 1) / dt), t * t + t + t + 1)
      : 0;
const sawOsc = (ph, dt) => 2 * ph - 1 - polyblep(ph, dt);
function lowpass(buf, fcFn) {
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    const fc = fcFn(i / SR);
    const a = 1 - Math.exp((-2 * Math.PI * fc) / SR);
    y += a * (buf[i] - y);
    buf[i] = y;
  }
  return buf;
}
function highpass(buf, fc) {
  const a = Math.exp((-2 * Math.PI * fc) / SR);
  let px = 0,
    py = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    py = a * (py + x - px);
    px = x;
    buf[i] = py;
  }
  return buf;
}
const bar = (t) => Math.floor(t / BAR);
const CH = [
  // chord per bar: root (midi), tones (semitones above root)
  { root: 33, tones: [0, 3, 7] },
  { root: 29, tones: [0, 4, 7] },
  { root: 36, tones: [0, 4, 7] },
  { root: 31, tones: [0, 4, 7] },
];
const chordAt = (t) => CH[bar(t) % 4];
const kickAt = []; // times of kicks, for the side-chain
const DROPS = [[4, 28]]; // the groove plays in 4..28
const inGroove = (t) => t >= 4 && t < 28;

// ---- kick: four on the floor in the groove; a single hit on the last chord
function kick(t0, amp = 1) {
  const len = Math.round(0.4 * SR),
    b = new Float32Array(len);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const f = 44 + 120 * Math.exp(-t * 32);
    ph += (2 * Math.PI * f) / SR;
    b[i] =
      (Math.sin(ph) * Math.exp(-t * 8.5) +
        0.35 * Math.sin(ph * 2) * Math.exp(-t * 30) +
        (i < 90 ? rnd() * 0.25 * (1 - i / 90) : 0)) *
      amp;
  }
  add(t0, b, 0.95, 0.95);
  kickAt.push(t0);
}
for (let t = 4; t < 28; t += BEAT) kick(t, 1);
kick(28, 1.1);
// ---- clap on beats 2 and 4, hats on the 8ths, open hat on the off-beats
function clap(t0, amp = 0.5) {
  const len = Math.round(0.28 * SR),
    b = new Float32Array(len);
  for (let k = 0; k < 3; k++) {
    const o = Math.round(k * 0.011 * SR);
    for (let i = 0; i + o < len; i++) {
      const t = i / SR;
      b[i + o] += rnd() * Math.exp(-t * (k === 2 ? 22 : 70)) * (k === 2 ? 1 : 0.6);
    }
  }
  highpass(b, 900);
  lowpass(b, () => 6500);
  add(
    t0,
    b.map((x) => x * amp),
    0.8,
    0.8,
    0.35,
  );
}
function hat(t0, amp, open = false, pan = 0) {
  const len = Math.round((open ? 0.22 : 0.06) * SR),
    b = new Float32Array(len);
  for (let i = 0; i < len; i++) b[i] = rnd() * Math.exp((-i / SR) * (open ? 16 : 70));
  highpass(b, 7000);
  add(
    t0,
    b.map((x) => x * amp),
    0.7 - pan,
    0.7 + pan,
    open ? 0.12 : 0.04,
  );
}
for (let t = 4; t < 28; t += BAR) {
  clap(t + BEAT, 0.5);
  clap(t + 3 * BEAT, 0.5);
}
for (let t = 4; t < 28; t += BEAT) {
  hat(t, 0.16, false, -0.15);
  hat(t + BEAT / 2, 0.1, true, 0.15);
}
for (let t = 4; t < 28; t += BEAT / 4)
  if (((t - 4) / (BEAT / 4)) % 2 === 1) hat(t, 0.05, false, 0.2); // soft 16ths
// ---- riser: noise sweep + snare roll into the drop; a reverse-style swell into the second drop
function riser(t0, dur, amp) {
  const len = Math.round(dur * SR),
    b = new Float32Array(len);
  for (let i = 0; i < len; i++) b[i] = rnd();
  const out = new Float32Array(len);
  let y = 0,
    y2 = 0;
  for (let i = 0; i < len; i++) {
    const x = i / len;
    const fc = 300 + 9000 * x * x;
    const a = 1 - Math.exp((-2 * Math.PI * fc) / SR);
    y += a * (b[i] - y);
    y2 += a * (y - y2);
    out[i] = (b[i] - y2) * (0.05 + 0.95 * x * x) * amp;
  }
  add(t0, out, 0.9, 0.9, 0.2);
}
riser(0.0, 4.0, 0.2);
riser(22.0, 2.0, 0.24);
function snare(t0, amp) {
  const len = Math.round(0.2 * SR),
    b = new Float32Array(len);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (190 - 60 * t)) / SR;
    b[i] = (rnd() * 0.8 * Math.exp(-t * 28) + Math.sin(ph) * 0.5 * Math.exp(-t * 36)) * amp;
  }
  highpass(b, 220);
  add(t0, b, 0.85, 0.85, 0.2);
}
for (let i = 0; i < 16; i++) snare(3.0 + i * (1.0 / 16), 0.12 + 0.5 * (i / 16)); // roll in the last beat-pair before the drop
for (let i = 0; i < 8; i++) snare(23.0 + i * (1.0 / 8), 0.12 + 0.4 * (i / 8));
// crash on the drops and the end
function crash(t0, amp, dur = 1.8) {
  const len = Math.round(dur * SR),
    b = new Float32Array(len);
  for (let i = 0; i < len; i++) b[i] = rnd() * Math.exp((-i / SR) * 2.4);
  highpass(b, 4500);
  add(
    t0,
    b.map((x) => x * amp),
    0.75,
    0.75,
    0.3,
  );
}
crash(4.0, 0.34);
crash(24.0, 0.3);
crash(28.0, 0.34, 2.0);
// ---- side-chain curve from the kicks
const duck = new Float32Array(N).fill(1);
for (const t0 of kickAt) {
  const s0 = Math.round(t0 * SR);
  for (let i = 0; i < SR * 0.4 && s0 + i < N; i++)
    duck[s0 + i] = Math.min(duck[s0 + i], 1 - 0.78 * Math.exp((-i / SR) * 11));
}
const bus = (buf) => {
  for (let i = 0; i < buf.length; i++) buf[i] *= duck[i];
  return buf;
};
// ---- bass: an 8th-note pulse on the root with a lowpass that opens on the second drop
function bass(t0, midi, dur, amp, open) {
  const len = Math.round(dur * SR),
    b = new Float32Array(len);
  const f = mtof(midi),
    dt = f / SR;
  let ph = 0;
  for (let i = 0; i < len; i++) {
    ph = (ph + dt) % 1;
    const t = i / SR;
    b[i] =
      (sawOsc(ph, dt) * 0.6 + Math.sin(2 * Math.PI * f * t) * 0.7) *
      Math.exp(-t * 3.2) *
      Math.min(1, t * 400) *
      amp;
  }
  lowpass(b, (t) => (open ? 520 : 340) * (0.55 + Math.exp(-t * 9)));
  return b;
}
for (let t = 4; t < 28; t += BEAT) {
  const c = chordAt(t);
  const oct = ((t - 4) / BEAT) % 2 === 1;
  const bb = bass(0, c.root + (oct ? 12 : 0), BEAT * 0.95, oct ? 0.28 : 0.4, t >= 24);
  const s0 = Math.round(t * SR);
  for (let i = 0; i < bb.length && s0 + i < N; i++) {
    const v = bb[i] * duck[s0 + i];
    L[s0 + i] += v * 0.8;
    R[s0 + i] += v * 0.8;
  }
}
// ---- pad: detuned saws on the chord, soft, side-chained, with a slow swell in the intro
function pad(t0, dur, root, tones, amp) {
  const len = Math.round(dur * SR),
    b = new Float32Array(len);
  const ph = tones.flatMap((tn) => [0.0, 0.3, 0.6].map((o) => o));
  const freqs = [];
  for (const tn of tones)
    for (const o of [-12 + 12, 0, 12])
      for (const det of [-0.12, 0.12]) freqs.push([mtof(root + tn + o + 12) * (1 + det * 0.01)]);
  const phs = freqs.map(() => 0);
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let k = 0; k < freqs.length; k++) {
      const dt = freqs[k][0] / SR;
      phs[k] = (phs[k] + dt) % 1;
      s += sawOsc(phs[k], dt);
    }
    const t = i / SR;
    b[i] = ((s * Math.min(1, t * 2.5) * Math.min(1, (dur - t) * 4) * amp) / freqs.length) * 3;
  }
  lowpass(b, (t) => 900 + 500 * Math.sin(t * 0.6));
  return b;
}
for (let t = 0; t < 30; t += BAR) {
  const c = chordAt(t);
  const intro = t < 4;
  const last = t >= 28;
  const pb = pad(0, last ? 2.0 : BAR, c.root, c.tones, intro ? 0.16 : last ? 0.5 : 0.38);
  const s0 = Math.round(t * SR);
  for (let i = 0; i < pb.length && s0 + i < N; i++) {
    const d = inGroove(t + i / SR) ? duck[s0 + i] : 1;
    L[s0 + i] += pb[i] * d * 0.85;
    R[s0 + i] += pb[i] * d * 0.85;
    SEND.L[s0 + i] += pb[i] * d * 0.3;
    SEND.R[s0 + i] += pb[i] * d * 0.3;
  }
}
// ---- arpeggio: plucked saw, 16ths, ping-pong delay; an octave up in the second drop
function pluck(t0, midi, amp, pan, bright) {
  const len = Math.round(0.34 * SR),
    b = new Float32Array(len);
  const f = mtof(midi),
    dt = f / SR;
  let ph = 0,
    ph2 = 0.37;
  for (let i = 0; i < len; i++) {
    ph = (ph + dt) % 1;
    ph2 = (ph2 + dt * 1.004) % 1;
    const t = i / SR;
    b[i] =
      (sawOsc(ph, dt) + sawOsc(ph2, dt * 1.004)) *
      0.5 *
      Math.exp(-t * 11) *
      Math.min(1, t * 600) *
      amp;
  }
  lowpass(b, (t) => 700 + bright * Math.exp(-t * 14));
  return { b, pan };
}
const ARP = [0, 1, 2, 1, 2, 1, 0, 1, 2, 1, 0, 2, 1, 2, 1, 0];
const arpOut = [new Float32Array(N), new Float32Array(N)];
for (let t = 4; t < 28; t += BEAT / 4) {
  const step = Math.round((t - 4) / (BEAT / 4));
  const c = chordAt(t);
  const tone = c.tones[ARP[step % 16] % 3];
  const up = (step % 8 >= 4 ? 12 : 0) + (t >= 24 ? 12 : 0);
  const amp = (t >= 8 ? 0.2 : 0.13) * (step % 4 === 0 ? 1.25 : 1);
  const { b } = pluck(0, c.root + 24 + tone + up, amp, 0, 4200 + (t >= 24 ? 2500 : 0));
  const pan = Math.sin(step * 0.9) * 0.4;
  const s0 = Math.round(t * SR);
  for (let i = 0; i < b.length && s0 + i < N; i++) {
    const v = b[i] * duck[s0 + i];
    arpOut[0][s0 + i] += v * (0.7 - pan * 0.5);
    arpOut[1][s0 + i] += v * (0.7 + pan * 0.5);
  }
}
{
  // ping-pong delay (3/16 note) and a send to the reverb
  const dl = Math.round(0.375 * SR);
  for (let i = 0; i < N; i++) {
    const iL = i - dl >= 0 ? arpOut[1][i - dl] * 0.38 : 0;
    const iR = i - dl >= 0 ? arpOut[0][i - dl] * 0.38 : 0;
    arpOut[0][i] += iL;
    arpOut[1][i] += iR;
  }
  for (let i = 0; i < N; i++) {
    L[i] += arpOut[0][i];
    R[i] += arpOut[1][i];
    SEND.L[i] += arpOut[0][i] * 0.25;
    SEND.R[i] += arpOut[1][i] * 0.25;
  }
}
// ---- stabs: the last chord at 28 s rings out
for (const [k, tn] of [
  [0, 0],
  [1, 7],
  [2, 12],
  [3, 16],
  [4, 19],
]) {
  const f = mtof(45 + tn),
    dt = f / SR;
  const len = Math.round(2.0 * SR);
  const b = new Float32Array(len);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    ph = (ph + dt) % 1;
    const t = i / SR;
    b[i] = sawOsc(ph, dt) * Math.exp(-t * 2.2) * 0.2 * Math.min(1, t * 500);
  }
  lowpass(b, (t) => 2200 * Math.exp(-t * 1.2) + 500);
  add(28, b, 0.5 + k * 0.07, 0.85 - k * 0.07, 0.35);
}
// ---- reverb: a small Schroeder network on the send bus
function reverb(inp) {
  const combs = [1557, 1617, 1491, 1422, 1277, 1356].map((d) => ({
    d,
    buf: new Float32Array(d),
    i: 0,
    fb: 0.82,
    lp: 0,
  }));
  const aps = [225, 556, 441].map((d) => ({ d, buf: new Float32Array(d), i: 0 }));
  const out = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    let s = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.lp += 0.35 * (y - c.lp);
      c.buf[c.i] = inp[n] + c.lp * c.fb;
      c.i = (c.i + 1) % c.d;
      s += y;
    }
    s /= combs.length;
    for (const a of aps) {
      const y = a.buf[a.i];
      const x = s + y * 0.5;
      a.buf[a.i] = x;
      a.i = (a.i + 1) % a.d;
      s = y - x * 0.5;
    }
    out[n] = s;
  }
  return out;
}
const rvL = reverb(SEND.L),
  rvR = reverb(SEND.R.map((v, i) => v)); // the right network is the same size: decorrelated by the stereo send itself
for (let i = 0; i < N; i++) {
  L[i] += rvL[i] * 0.8;
  R[i] += rvR[i] * 0.8;
}
// ---- master: gentle glue, high-pass, fade the last 0.3 s, normalise
highpass(L, 28);
highpass(R, 28);
let peak = 0;
for (let i = 0; i < N; i++) {
  L[i] = Math.tanh(L[i] * 1.15);
  R[i] = Math.tanh(R[i] * 1.15);
  const f = i > N - 0.3 * SR ? (N - i) / (0.3 * SR) : 1;
  L[i] *= f;
  R[i] *= f;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const g = 0.66 / peak; // about -14 LUFS integrated, the usual level for social video
const pcm = Buffer.alloc(N * 4);
let clip = 0;
for (let i = 0; i < N; i++) {
  const l = Math.max(-1, Math.min(1, L[i] * g)),
    r = Math.max(-1, Math.min(1, R[i] * g));
  if (Math.abs(L[i] * g) >= 1) clip++;
  pcm.writeInt16LE(Math.round(l * 32767), i * 4);
  pcm.writeInt16LE(Math.round(r * 32767), i * 4 + 2);
}
const hdr = Buffer.alloc(44);
hdr.write("RIFF", 0);
hdr.writeUInt32LE(36 + pcm.length, 4);
hdr.write("WAVEfmt ", 8);
hdr.writeUInt32LE(16, 16);
hdr.writeUInt16LE(1, 20);
hdr.writeUInt16LE(2, 22);
hdr.writeUInt32LE(SR, 24);
hdr.writeUInt32LE(SR * 4, 28);
hdr.writeUInt16LE(4, 32);
hdr.writeUInt16LE(16, 34);
hdr.write("data", 36);
hdr.writeUInt32LE(pcm.length, 40);
mkdirSync(join(here, "work"), { recursive: true });
writeFileSync(join(here, "work", "music.wav"), Buffer.concat([hdr, pcm]));
console.log(
  `music.wav: ${DUR} s, peak before normalise ${peak.toFixed(2)}, gain ${g.toFixed(2)}, clipped samples ${clip}`,
);
