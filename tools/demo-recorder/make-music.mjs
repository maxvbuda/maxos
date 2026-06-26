// Generates an original, royalty-free background-music bed (music.wav) for the
// demo video — a calm I–V–vi–IV (C–G–Am–F) loop with a soft pad, gentle bass and
// a light arpeggio. Pure synthesis (sine waves), so there are zero licensing
// concerns. Written as 16-bit mono PCM WAV; CI muxes it under the video.
import fs from 'fs';

const SR = 44100;       // sample rate
const DUR = 54;         // seconds (a touch longer than the video; muxed with -shortest)
const N = SR * DUR;
const BAR = 3.0;        // seconds per chord (~80 BPM, 4 beats/bar)

const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Four-chord loop. Triads voiced close together; bass two octaves below the root.
// MIDI: C4=60 E4=64 G4=67  G4=67 B4=71 D5=74  A4=69 C5=72 E5=76  F4=65 A4=69 C5=72
const prog = [
  { chord: [60, 64, 67], bass: 36 }, // C  (bass C2)
  { chord: [67, 71, 74], bass: 31 }, // G  (bass G2)
  { chord: [69, 72, 76], bass: 33 }, // Am (bass A2)
  { chord: [65, 69, 72], bass: 29 }, // F  (bass F2)
];
const arpPattern = [0, 1, 2, 1]; // gentle: one note per beat

const out = Buffer.alloc(44 + N * 2);
// ── WAV header ────────────────────────────────────────────────────────────────
out.write('RIFF', 0); out.writeUInt32LE(36 + N * 2, 4); out.write('WAVE', 8);
out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); // PCM
out.writeUInt16LE(1, 22);          // mono
out.writeUInt32LE(SR, 24); out.writeUInt32LE(SR * 2, 28);
out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
out.write('data', 36); out.writeUInt32LE(N * 2, 40);

for (let i = 0; i < N; i++) {
  const t = i / SR;
  const bar = Math.floor(t / BAR) % prog.length;
  const tib = t - Math.floor(t / BAR) * BAR; // time within the current bar
  const c = prog[bar];

  let s = 0;
  // soft sustained pad (the chord)
  for (const m of c.chord) s += 0.085 * Math.sin(2 * Math.PI * midiToFreq(m) * t);
  const padSwell = Math.min(1, tib / 0.5) * Math.min(1, (BAR - tib) / 0.5);
  s *= 0.55 + 0.45 * padSwell;
  // gentle bass on the downbeat
  s += 0.17 * Math.sin(2 * Math.PI * midiToFreq(c.bass) * t) * Math.min(1, (BAR - tib) / 0.3);
  // light arpeggio (one plucked note per beat, octave up), quick decay
  const step = BAR / arpPattern.length;
  const ai = Math.floor(tib / step);
  const arpMidi = c.chord[arpPattern[ai]] + 12;
  const tin = tib - ai * step;
  s += 0.13 * Math.sin(2 * Math.PI * midiToFreq(arpMidi) * t) * Math.exp(-tin * 5);

  // master: fade in/out + soft clip
  let g = 1;
  if (t < 1.2) g = t / 1.2;
  if (t > DUR - 2.5) g = Math.max(0, (DUR - t) / 2.5);
  const v = Math.tanh(s * 0.9) * g * 0.85;
  out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2);
}

fs.writeFileSync('music.wav', out);
console.log(`wrote music.wav (${DUR}s, ${SR}Hz mono)`);
