// Injected into every page: routes <video>/<audio> through a Web Audio analyser and describes
// the sound RATE times a second in two parts, because Roblox can't play raw samples:
// - tones: the clear, standout peak in each of BANDS log-spaced bands (pitch + level), which the
//   game rebuilds with pitch-shifted sine tones (music, sung notes, vowels);
// - noise: the noisy energy in each of NOISE_BANDS fixed bands, which the game rebuilds by
//   setting the volume of band-pass-filtered white noise (speech consonants, breaths, effects).
export const BANDS = 40;
export const NOISE_BANDS = 16;
// Per tone band: u8 level, u16 frequency (Hz); then per noise band: u8 level
export const FRAME_BYTES = BANDS * 3 + NOISE_BANDS;
export const AUDIO_RATE = 50; // frames per second; the Roblox client plays them back at this rate

export const AUDIO_TAP_JS = `(() => {
  if (window.top !== window || window.__rbxAudioTap) return;
  window.__rbxAudioTap = true;
  const BANDS = ${BANDS}, NOISE_BANDS = ${NOISE_BANDS}, RATE = ${AUDIO_RATE};
  const MIN_HZ = 60, MAX_HZ = 8000, NOISE_MIN_HZ = 100, NOISE_MAX_HZ = 8000, FLOOR_DB = -100;
  // Anything this far below the loudest sound is dropped: faint partials only add warble and hiss
  const GATE_DB = 45, NOISE_GATE_DB = 30;
  // A peak must stand this far above the spectrum around it to count as a tone; weaker "peaks"
  // are just ripples in noise and would come out as random beeps
  const PROMINENCE_DB = 9;
  // Each semitone away from last frame's pitch costs this much, so bands follow one note
  const STICKY_DB = 3;
  let ctx, analyser, data, power, silentFrames = 0;
  const lastHz = new Float32Array(BANDS);
  const tapped = new WeakSet();

  function ensure() {
    if (ctx) return;
    // Headless Chrome defaults to a 176.4 kHz context, which would make every FFT bin 4x wider
    // (86 Hz at 2048 points: low notes and voices blur together). Pin a normal rate.
    ctx = new AudioContext({ sampleRate: 48000 });
    analyser = ctx.createAnalyser();
    // ~43 ms window: reacts quickly while still resolving low notes
    analyser.fftSize = 2048;
    // A little temporal smoothing keeps tones from flickering on and off between frames
    analyser.smoothingTimeConstant = 0.3;
    analyser.connect(ctx.destination);
    data = new Float32Array(analyser.frequencyBinCount);
    power = new Float64Array(analyser.frequencyBinCount);
    setInterval(sample, 1000 / RATE);
  }

  function tap(el) {
    if (tapped.has(el)) return;
    tapped.add(el);
    try {
      ensure();
      ctx.createMediaElementSource(el).connect(analyser);
    } catch (e) {}
    if (ctx && ctx.state === "suspended") ctx.resume();
  }
  document.addEventListener("play", (e) => { if (e.target instanceof HTMLMediaElement) tap(e.target); }, true);

  const toDb = (p) => (p > 1e-12 ? 10 * Math.log10(p) : FLOOR_DB);
  const encode = (db) => Math.max(0, Math.min(255, Math.round((db - FLOOR_DB) * 2.55)));

  // Mean power around bin i, skipping the peak and its window skirt (the analyser's window
  // spreads a pure tone over about +-3 bins): the "floor" a tone has to stand out from. Kept
  // narrow because a low note's overtones are only ~11 bins apart at this FFT size.
  function localFloor(i) {
    let sum = 0, n = 0;
    for (let k = i - 8; k <= i + 8; k++) {
      if (k < 1 || k >= power.length || Math.abs(k - i) <= 3) continue;
      sum += power[k];
      n++;
    }
    return toDb(n ? sum / n : 0);
  }

  function sample() {
    if (ctx.state === "suspended") ctx.resume();
    analyser.getFloatFrequencyData(data);
    for (let i = 0; i < data.length; i++) power[i] = Math.pow(10, data[i] / 10);
    const residual = Float64Array.from(power);
    const binHz = ctx.sampleRate / analyser.fftSize;
    const out = new Uint8Array(${FRAME_BYTES});
    const usedBins = new Set();
    const levels = new Float32Array(BANDS);
    const pitches = new Float32Array(BANDS);
    let maxDb = FLOOR_DB;

    // Tones
    for (let b = 0; b < BANDS; b++) {
      const lo = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, b / BANDS);
      const hi = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, (b + 1) / BANDS);
      const i0 = Math.max(1, Math.floor(lo / binHz));
      const i1 = Math.max(i0, Math.min(data.length - 2, Math.ceil(hi / binHz) - 1));
      let best = -Infinity, bestScore = -Infinity, bi = -1;
      const prevBin = lastHz[b] > 0 ? lastHz[b] / binHz : -1;
      for (let i = i0; i <= i1; i++) {
        const v = data[i];
        if (!(v > data[i - 1] && v >= data[i + 1])) continue;
        if (v - localFloor(i) < PROMINENCE_DB) continue;
        const semis = prevBin > 0 ? Math.abs(12 * Math.log2(i / prevBin)) : 0;
        const score = v - STICKY_DB * semis;
        if (score > bestScore) { bestScore = score; best = v; bi = i; }
      }
      let hz = Math.sqrt(lo * hi), db = FLOOR_DB;
      // Neighbouring low bands can share bins; each peak may only drive one tone
      if (bi > 0 && usedBins.has(bi)) bi = -1;
      if (bi > 0) {
        usedBins.add(bi);
        // The tone path covers this peak; take it out of what the noise path measures
        const floor = Math.pow(10, localFloor(bi) / 10);
        for (let k = Math.max(1, bi - 3); k <= Math.min(residual.length - 1, bi + 3); k++) residual[k] = Math.min(residual[k], floor);
        // Parabolic interpolation around the peak bin for a more exact pitch
        const a = data[bi - 1], c = data[bi + 1];
        const d = a - 2 * best + c;
        const offset = d < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / d)) : 0;
        hz = (bi + offset) * binHz;
        db = best;
      }
      levels[b] = db;
      pitches[b] = Math.round(Math.max(20, Math.min(20000, hz)));
      lastHz[b] = db > FLOOR_DB ? pitches[b] : 0;
      if (db > maxDb) maxDb = db;
    }

    // Noise: band power weighted by how noise-like the band is (spectral flatness, 0..1).
    // Tonal bands score near 0 and are left to the tones; noisy bands go here.
    const noise = new Float32Array(NOISE_BANDS);
    for (let b = 0; b < NOISE_BANDS; b++) {
      const lo = NOISE_MIN_HZ * Math.pow(NOISE_MAX_HZ / NOISE_MIN_HZ, b / NOISE_BANDS);
      const hi = NOISE_MIN_HZ * Math.pow(NOISE_MAX_HZ / NOISE_MIN_HZ, (b + 1) / NOISE_BANDS);
      const i0 = Math.max(1, Math.floor(lo / binHz));
      const i1 = Math.max(i0, Math.min(data.length - 1, Math.ceil(hi / binHz) - 1));
      let sum = 0, logSum = 0, n = 0;
      for (let i = i0; i <= i1; i++) {
        sum += residual[i];
        logSum += Math.log(Math.max(residual[i], 1e-20));
        n++;
      }
      const mean = sum / n;
      const flatness = mean > 0 ? Math.exp(logSum / n) / mean : 0;
      // Mean per-bin power keeps levels comparable to a tone's peak bin; flatness^2 keeps
      // tonal bands (flatness ~0.1-0.3) mostly out of the noise path
      noise[b] = toDb(mean * flatness * flatness);
      if (noise[b] > maxDb) maxDb = noise[b];
    }

    const loud = maxDb > -75;
    for (let b = 0; b < BANDS; b++) {
      const db = levels[b] < maxDb - GATE_DB ? FLOOR_DB : levels[b];
      const hz = pitches[b];
      out[b * 3] = encode(db);
      out[b * 3 + 1] = hz & 255;
      out[b * 3 + 2] = (hz >> 8) & 255;
    }
    for (let b = 0; b < NOISE_BANDS; b++) {
      // Tighter gate than tones: faint window leakage around clean notes would otherwise hiss
      out[BANDS * 3 + b] = encode(noise[b] < maxDb - NOISE_GATE_DB ? FLOOR_DB : noise[b]);
    }
    // Keep sending a few silent frames so the game fades out instead of holding the last sound
    silentFrames = loud ? 0 : silentFrames + 1;
    if (silentFrames > 5) return;
    let s = "";
    for (let i = 0; i < out.length; i++) s += String.fromCharCode(out[i]);
    window.__rbxAudio(btoa(s));
  }
})();`;

// Test page: a melody (tones path) and noise bursts (noise path) to check the audio end to end
export const TONE_HTML = `<!doctype html><meta charset="utf-8"><title>Sound test</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#202124;color:#e8eaed;font:20px system-ui">
<div style="text-align:center"><p>Sound test</p>
<button id="b" style="font-size:22px;padding:14px 28px">Play melody</button>
<button id="n" style="font-size:22px;padding:14px 28px;margin-left:12px">Play noise</button>
<audio id="a" src="/tone.wav" loop></audio><audio id="z" src="/noise.wav" loop></audio></div>
<script>
  const a = document.getElementById("a"), z = document.getElementById("z");
  document.getElementById("b").onclick = () => { z.pause(); a.play(); };
  document.getElementById("n").onclick = () => { a.pause(); z.play(); };
</script>`;

function wav(rate, n, sampleAt) {
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sampleAt(i / rate))) * 32767), 44 + i * 2);
  return buf;
}

// C major arpeggio with overtones and a little vibrato, like a real instrument
export function toneWav() {
  const rate = 22050, notes = [261.63, 329.63, 392.0, 523.25], noteLen = 0.4;
  return wav(rate, Math.floor(rate * noteLen * notes.length), (t) => {
    const f = notes[Math.floor(t / noteLen)];
    const env = Math.min(1, (t % noteLen) * 40, (noteLen - (t % noteLen)) * 40);
    const phase = 2 * Math.PI * f * (t + 0.0008 * Math.sin(2 * Math.PI * 5 * t));
    const s = Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.3 * Math.sin(3 * phase) + 0.15 * Math.sin(4 * phase);
    return s * 0.21 * env;
  });
}

// "Shh" bursts of white noise, half a second on, half off
export function noiseWav() {
  const rate = 22050;
  let seed = 1;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  return wav(rate, rate * 2, (t) => {
    const on = t % 1 < 0.5;
    const env = Math.min(1, (t % 0.5) * 40, (0.5 - (t % 0.5)) * 40);
    return on ? rand() * 0.25 * env : 0;
  });
}
