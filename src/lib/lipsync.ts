// Analisis audio TTS secara offline → envelope amplitudo + "kecerahan" (≈ vokal) per 20 ms.
// Tidak memakai MediaElementSource (yang bisa membisukan audio bila AudioContext tertahan autoplay):
// audio tetap diputar polos oleh <audio>, mulut membaca envelope menurut currentTime.
export interface Envelope {
  step: number; // detik per frame
  amp: Float32Array; // 0..1 ternormalisasi
  bright: Float32Array; // 0..1 (rendah ≈ u/o, tinggi ≈ i/e)
  duration: number;
}

export function envelopeFromPCM(data: Float32Array, sampleRate: number, stepSec = 0.02): Envelope | null {
  if (!data || !data.length || !(sampleRate > 0)) return null;
  const hop = Math.max(1, Math.round(sampleRate * stepSec));
  const n = Math.floor(data.length / hop);
  if (n < 3) return null;
  const amp = new Float32Array(n);
  const bright = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let z = 0;
    let prev = data[i * hop];
    for (let j = 0; j < hop; j++) {
      const v = data[i * hop + j];
      s += v * v;
      if ((v >= 0) !== (prev >= 0)) z++;
      prev = v;
    }
    amp[i] = Math.sqrt(s / hop);
    bright[i] = z / hop; // zero-crossing rate
  }
  const sorted = Float32Array.from(amp).sort();
  const p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))] || 1e-4;
  const zs = Float32Array.from(bright).sort();
  const zlo = zs[Math.floor(n * 0.2)];
  const zhi = zs[Math.min(n - 1, Math.floor(n * 0.9))] || zlo + 1e-3;
  for (let i = 0; i < n; i++) {
    const a = Math.min(1, amp[i] / (p95 * 1.05));
    amp[i] = a < 0.06 ? 0 : a; // gerbang derau
    bright[i] = Math.max(0, Math.min(1, (bright[i] - zlo) / Math.max(1e-4, zhi - zlo)));
  }
  return { step: hop / sampleRate, amp, bright, duration: data.length / sampleRate };
}

export function sampleEnvelope(env: Envelope, t: number): { amp: number; bright: number } {
  const x = t / env.step;
  const i = Math.floor(x);
  if (!(x >= 0) || i >= env.amp.length - 1) return { amp: 0, bright: 0.5 };
  const f = x - i;
  return {
    amp: env.amp[i] * (1 - f) + env.amp[i + 1] * f,
    bright: env.bright[i] * (1 - f) + env.bright[i + 1] * f,
  };
}

export async function analyzeBlob(blob: Blob, timeoutMs = 2500): Promise<Envelope | null> {
  try {
    const w = window as unknown as Record<string, any>;
    const Ctx = w.OfflineAudioContext || w.webkitOfflineAudioContext;
    if (!Ctx) return null;
    const buf = await blob.arrayBuffer();
    const work = (async () => {
      const ctx = new Ctx(1, 1, 22050);
      const audio: AudioBuffer = await new Promise((res, rej) => {
        const p = ctx.decodeAudioData(buf, res, rej); // gaya callback untuk Safari lama
        if (p && typeof p.then === "function") p.then(res, rej);
      });
      const ch0 = audio.getChannelData(0);
      return envelopeFromPCM(ch0, audio.sampleRate);
    })();
    return await Promise.race([work, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
  } catch {
    return null;
  }
}
