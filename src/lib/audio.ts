// ─────────────────────────────────────────────────────────────────────────────
// Pemutar suara + fallback. Satu elemen <audio> dipakai ulang selamanya
// (syarat iOS Safari: elemen harus "dibuka" sekali lewat gestur pengguna).
// ─────────────────────────────────────────────────────────────────────────────
import { ttsClean } from "./api";

export const HAS_SPEECH = typeof window !== "undefined" && "speechSynthesis" in window;

export type PlayResult = "done" | "blocked" | "failed" | "aborted";
export interface Hooks {
  onStart: () => void;
  onProgress: (ratio: number) => void; // 0..1
}

const SILENT_WAV = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

let el: HTMLAudioElement | null = null;
let unlocked = false;

function audio(): HTMLAudioElement {
  if (!el) {
    el = new Audio();
    el.preload = "auto";
    el.setAttribute("playsinline", "");
  }
  return el;
}

/** Panggil SINKRON di dalam handler klik/enter, sebelum `await` apa pun. */
export function unlockAudio(): void {
  if (unlocked) return;
  try {
    const a = audio();
    // Sedang memutar = sudah pasti terbuka; jangan ganggu audio yang berjalan.
    if (!a.paused && !a.ended) {
      unlocked = true;
      return;
    }
    // iOS Safari: yang "dibuka" harus elemen yang sama dengan yang nanti memutar suara TTS.
    // Klip senyap hanya 1 sampel, selesai jauh sebelum balasan AI datang.
    a.src = SILENT_WAV;
    const p = a.play();
    if (p && typeof p.then === "function") {
      p.then(() => {
        unlocked = true;
      }).catch(() => {
        // Browser tertentu tetap meminta gestur pengguna saat pertama kali.
      });
    }
  } catch {
    /* abaikan */
  }
}

export function stopAudio(): void {
  try {
    el?.pause();
  } catch {
    /* abaikan */
  }
}

export function stopSpeech(): void {
  try {
    if (HAS_SPEECH) window.speechSynthesis.cancel();
  } catch {
    /* abaikan */
  }
}

/**
 * Memutar URL audio. Teks dan suara disinkronkan lewat hooks:
 *  - onStart dipanggil tepat saat suara benar-benar mulai terdengar,
 *  - onProgress dipanggil tiap frame dengan rasio currentTime/duration.
 * Tidak pernah reject; hasilnya selalu salah satu dari PlayResult.
 */
export function playUrl(url: string, signal: AbortSignal, h: Hooks, estSec = 0, startTimeoutMs = 12000): Promise<PlayResult> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve("aborted");
    const a = audio();
    let settled = false;
    let started = false;
    let raf = 0;
    const timers: number[] = [];

    const cleanup = () => {
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
      a.removeEventListener("ended", onEnd);
      a.removeEventListener("error", onErr);
      a.removeEventListener("canplay", onCanPlay);
      a.removeEventListener("playing", onPlaying);
      a.removeEventListener("pause", onPause);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (r: PlayResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        a.pause();
      } catch {
        /* abaikan */
      }
      resolve(r);
    };

    const onEnd = () => {
      h.onProgress(1);
      finish("done");
    };
    const onErr = () => finish("failed");
    const onAbort = () => finish("aborted");
    // dijeda dari luar (tombol suara dimatikan / telepon masuk) → anggap selesai, teks ditampilkan penuh
    const onPause = () => {
      if (started && !a.ended) finish("done");
    };
    const tick = () => {
      const d = a.duration;
      if (isFinite(d) && d > 0) h.onProgress(Math.min(1, a.currentTime / d));
      else if (estSec > 0) h.onProgress(Math.min(0.97, a.currentTime / estSec)); // metadata belum ada → perkiraan
      raf = requestAnimationFrame(tick);
    };
    const markStarted = () => {
      if (settled || started) return;
      started = true;
      a.addEventListener("pause", onPause);
      h.onStart();
      raf = requestAnimationFrame(tick);
      const d = a.duration;
      // pengaman: jika 'ended' tak pernah datang, jangan biarkan UI menggantung
      timers.push(window.setTimeout(() => finish("done"), (isFinite(d) && d > 0 ? d * 1000 : Math.max(estSec, 6) * 2000) + 4000));
    };
    const onPlaying = () => markStarted();
    const onCanPlay = async () => {
      if (settled || started) return;
      try {
        // play() dipanggil segera setelah data media tersedia. Audio senyap
        // sudah di-unlock saat aksi pengguna, sehingga browser mobile lebih
        // mungkin mengizinkan playback asinkron setelah respons AI.
        await a.play();
        if (!settled) markStarted();
      } catch (e) {
        return finish((e as { name?: string })?.name === "NotAllowedError" ? "blocked" : "failed");
      }
    };

    signal.addEventListener("abort", onAbort, { once: true });
    a.addEventListener("ended", onEnd);
    a.addEventListener("error", onErr);
    a.addEventListener("canplay", onCanPlay);
    a.addEventListener("playing", onPlaying);
    timers.push(window.setTimeout(() => !started && finish("failed"), startTimeoutMs)); // API lambat/gagal memuat
    try {
      a.pause();
      a.src = url;
      a.load();
    } catch {
      finish("failed");
    }
  });
}

// ─── Fallback 1: suara bawaan browser ─────────────────────────────────────────
function pickVoice(): SpeechSynthesisVoice | null {
  try {
    const voices = window.speechSynthesis.getVoices();
    const prefer = (lang: string) =>
      voices.find((v) => v.lang.startsWith(lang) && /female|woman|zira|hana|sakura/i.test(v.name)) ||
      voices.find((v) => v.lang.startsWith(lang));
    return prefer("id") || prefer("ja") || prefer("en") || voices[0] || null;
  } catch {
    return null;
  }
}

export function speakBrowser(text: string, signal: AbortSignal, h: Hooks): Promise<"done" | "failed" | "aborted"> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve("aborted");
    const clean = ttsClean(text);
    if (!HAS_SPEECH || !clean) return resolve("failed");
    const synth = window.speechSynthesis;
    let settled = false;
    let started = false;
    let raf = 0;
    let t0 = 0;
    let sawBoundary = false;
    let boundary = 0;
    const timers: number[] = [];
    const est = Math.max(1200, clean.length * 80);

    const finish = (r: "done" | "failed" | "aborted") => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
      signal.removeEventListener("abort", onAbort);
      try {
        synth.cancel();
      } catch {
        /* abaikan */
      }
      resolve(r);
    };
    const onAbort = () => finish("aborted");
    signal.addEventListener("abort", onAbort, { once: true });

    const tick = () => {
      h.onProgress(sawBoundary ? boundary : Math.min(0.97, (performance.now() - t0) / est));
      raf = requestAnimationFrame(tick);
    };

    try {
      synth.cancel();
      timers.push(
        window.setTimeout(() => {
          if (settled) return;
          const u = new SpeechSynthesisUtterance(clean);
          const v = pickVoice();
          if (v) {
            u.voice = v;
            u.lang = v.lang;
          } else u.lang = "id-ID";
          u.rate = 1.05;
          u.pitch = 1.35;
          u.volume = 1;
          u.onstart = () => {
            if (started) return;
            started = true;
            t0 = performance.now();
            h.onStart();
            raf = requestAnimationFrame(tick);
          };
          u.onboundary = (e) => {
            sawBoundary = true;
            boundary = Math.min(1, (e.charIndex + (e.charLength || 4)) / clean.length);
          };
          u.onend = () => {
            h.onProgress(1);
            finish("done");
          };
          u.onerror = (e) => finish(e.error === "canceled" || e.error === "interrupted" ? "done" : "failed");
          synth.speak(u);
        }, 40), // jeda kecil: iOS Safari butuh ini setelah cancel()
      );
      timers.push(window.setTimeout(() => !started && finish("failed"), 3500));
      timers.push(window.setTimeout(() => finish("done"), est * 2 + 6000));
    } catch {
      finish("failed");
    }
  });
}

// ─── Fallback 2: tanpa suara, teks diketik biasa ──────────────────────────────
export function typeText(
  text: string,
  set: (s: string) => void,
  signal: AbortSignal,
  perChar = 34,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || !text) return resolve();
    let i = 0;
    const done = () => {
      clearInterval(id);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const id = window.setInterval(() => {
      i += 1;
      set(text.slice(0, i));
      if (i >= text.length) done();
    }, perChar);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Posisi putar audio TTS (detik) — dipakai lip-sync agar mulut mengikuti suara yang benar-benar terdengar. */
export function audioTime(): number {
  try {
    return el && !el.paused ? el.currentTime : 0;
  } catch {
    return 0;
  }
}
