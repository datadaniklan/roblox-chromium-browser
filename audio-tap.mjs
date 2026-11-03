// Injected into every page: routes <video>/<audio> through a Web Audio analyser and reports
// the loudest frequency in each of BANDS log-spaced bands, RATE times a second. Roblox can't
// play raw samples, so the game rebuilds the sound from these with pitch-shifted sine tones.
export const BANDS = 40;
export const FRAME_BYTES = BANDS * 3; // per band: u8 level, u16 frequency (Hz)
export const AUDIO_RATE = 50; // frames per second; the Roblox client plays them back at this rate

export const AUDIO_TAP_JS = `(() => {
  if (window.top !== window || window.__rbxAudioTap) return;
  window.__rbxAudioTap = true;
  const BANDS = ${BANDS}, MIN_HZ = 60, MAX_HZ = 8000, RATE = ${AUDIO_RATE}, FLOOR_DB = -100;
  // Bands this far below the loudest one are dropped: faint partials only add warble and hiss
  const GATE_DB = 40;
  let ctx, analyser, data, silentFrames = 0;
  const tapped = new WeakSet();

  function ensure() {
    if (ctx) return;
    ctx = new AudioContext();
    analyser = ctx.createAnalyser();
    // ~43 ms window: reacts twice as fast as 4096 while still resolving low notes
    analyser.fftSize = 2048;
    // A little temporal smoothing keeps tones from flickering on and off between frames
    analyser.smoothingTimeConstant = 0.3;
    analyser.connect(ctx.destination);
    data = new Float32Array(analyser.frequencyBinCount);
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

  function sample() {
    if (ctx.state === "suspended") ctx.resume();
    analyser.getFloatFrequencyData(data);
    const binHz = ctx.sampleRate / analyser.fftSize;
    const out = new Uint8Array(BANDS * 3);
    const usedBins = new Set();
    const levels = new Float32Array(BANDS);
    const pitches = new Float32Array(BANDS);
    let maxDb = FLOOR_DB;
    for (let b = 0; b < BANDS; b++) {
      const lo = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, b / BANDS);
      const hi = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, (b + 1) / BANDS);
      const i0 = Math.max(1, Math.floor(lo / binHz));
      const i1 = Math.max(i0, Math.min(data.length - 2, Math.ceil(hi / binHz) - 1));
      // Only a true spectral peak counts; a band that just catches the skirt of a neighbour's
      // tone stays silent, otherwise every note would also sound at the band edges
      let best = -Infinity, bi = -1;
      for (let i = i0; i <= i1; i++) {
        const v = data[i];
        if (v > data[i - 1] && v >= data[i + 1] && v > best) { best = v; bi = i; }
      }
      let hz = Math.sqrt(lo * hi), db = FLOOR_DB;
      // Neighbouring low bands can share bins; each peak may only drive one tone
      if (bi > 0 && usedBins.has(bi)) bi = -1;
      if (bi > 0) {
        usedBins.add(bi);
        // Parabolic interpolation around the peak bin for a more exact pitch
        const a = data[bi - 1], c = data[bi + 1];
        const d = a - 2 * best + c;
        const offset = d < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / d)) : 0;
        hz = (bi + offset) * binHz;
        db = best;
      }
      levels[b] = db;
      pitches[b] = Math.round(Math.max(20, Math.min(20000, hz)));
      if (db > maxDb) maxDb = db;
    }
    const loud = maxDb > -75;
    for (let b = 0; b < BANDS; b++) {
      const db = levels[b] < maxDb - GATE_DB ? FLOOR_DB : levels[b];
      const hz = pitches[b];
      out[b * 3] = Math.max(0, Math.min(255, Math.round((db - FLOOR_DB) * 2.55)));
      out[b * 3 + 1] = hz & 255;
      out[b * 3 + 2] = (hz >> 8) & 255;
    }
    // Keep sending a few silent frames so the game fades out instead of holding the last tone
    silentFrames = loud ? 0 : silentFrames + 1;
    if (silentFrames > 5) return;
    let s = "";
    for (let i = 0; i < out.length; i++) s += String.fromCharCode(out[i]);
    window.__rbxAudio(btoa(s));
  }
})();`;

// Test page with a short melody, used to check the audio path end to end
export const TONE_HTML = `<!doctype html><meta charset="utf-8"><title>Sound test</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#202124;color:#e8eaed;font:20px system-ui">
<div style="text-align:center"><p>Sound test</p><button id="b" style="font-size:22px;padding:14px 28px">Play melody</button>
<audio id="a" src="/tone.wav" loop></audio></div>
<script>document.getElementById("b").onclick = () => document.getElementById("a").play();</script>`;

// C major arpeggio as a 16-bit mono WAV
export function toneWav() {
  const rate = 22050, notes = [261.63, 329.63, 392.0, 523.25], noteLen = 0.4;
  const n = Math.floor(rate * noteLen * notes.length);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f = notes[Math.floor(t / noteLen)];
    const env = Math.min(1, (t % noteLen) * 40, (noteLen - (t % noteLen)) * 40);
    buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * f * t) * 12000 * env), 44 + i * 2);
  }
  return buf;
}
