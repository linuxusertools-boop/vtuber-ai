// ─────────────────────────────────────────────────────────────────────────────
// Lapisan jaringan + parsing. Aturan utama: tidak ada fungsi di sini yang boleh
// membuat UI macet. Semua punya timeout, semua bisa dibatalkan (AbortSignal),
// semua kegagalan berakhir sebagai nilai yang aman (bukan exception liar).
// ─────────────────────────────────────────────────────────────────────────────

export const AI_URL = "https://kev-ai.vercel.app/ai";
export const TTS_URL = "https://kev-tts.vercel.app/animemoe";
/** Template endpoint suara. {text} diganti teks yang sudah di-encode. */
export const TTS_TEMPLATE = `${TTS_URL}?text={text}`;

export interface YukiConfig {
  aiName?: string;
  prompt?: string;
  api: {
    text: string;
    textFallback: string;
    /** URL API suara, contoh: https://kev-tts.vercel.app/animemoe?text={text} */
    voice: string;
    /** Proxy serverless (mengatasi CORS). Kosongkan "" untuk mematikan. */
    voiceProxy: string;
  };
  tts: {
    enabled: boolean;
    /** total waktu maksimum menyiapkan suara (ms) */
    timeoutMs: number;
    /** batas waktu per percobaan unduh (ms) */
    attemptTimeoutMs: number;
    /** jumlah putaran ulang seluruh strategi jika gagal */
    retries: number;
    maxChars: number;
  };
  limits: { requestTimeoutMs: number; historyMessages: number };
  // bagian lain (appearance, features, poweredBy, ...) dibiarkan apa adanya
  [k: string]: unknown;
}

const DEFAULT_CONFIG: YukiConfig = {
  aiName: "YUKI",
  prompt: "Kamu adalah YUKI, assistant yang ramah dan membantu.",
  api: { text: "/api/chat", textFallback: AI_URL, voice: TTS_TEMPLATE, voiceProxy: "/api/tts" },
  tts: { enabled: true, timeoutMs: 20000, attemptTimeoutMs: 10000, retries: 1, maxChars: 240 },
  limits: { requestTimeoutMs: 22000, historyMessages: 8 },
};

const str = (v: unknown, d: string): string => (typeof v === "string" ? v.trim() : d);
const num = (v: unknown, d: number, min: number, max: number): number =>
  typeof v === "number" && isFinite(v) ? Math.max(min, Math.min(max, v)) : d;

/** Menggabungkan config.json dengan default. Apa pun isi file-nya, hasilnya selalu valid. */
export function normalizeConfig(raw: unknown): YukiConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const api = (r.api && typeof r.api === "object" ? r.api : {}) as Record<string, unknown>;
  const tts = (r.tts && typeof r.tts === "object" ? r.tts : {}) as Record<string, unknown>;
  const lim = (r.limits && typeof r.limits === "object" ? r.limits : {}) as Record<string, unknown>;
  const D = DEFAULT_CONFIG;

  // Kompatibel dengan format lama: voice:"/api/tts" + voiceFallback:"https://..."
  let voice = str(api.voice, D.api.voice);
  let voiceProxy = typeof api.voiceProxy === "string" ? api.voiceProxy.trim() : D.api.voiceProxy;
  if (voice.startsWith("/")) {
    if (typeof api.voiceProxy !== "string") voiceProxy = voice;
    voice = str(api.voiceFallback, D.api.voice);
  }
  if (!/^https?:\/\//i.test(voice)) voice = D.api.voice;

  return {
    ...r,
    aiName: str(r.aiName, D.aiName as string) || (D.aiName as string),
    prompt: str(r.prompt, D.prompt as string) || (D.prompt as string),
    api: {
      text: str(api.text, D.api.text) || D.api.text,
      textFallback: str(api.textFallback, D.api.textFallback) || D.api.textFallback,
      voice,
      voiceProxy,
    },
    tts: {
      enabled: tts.enabled !== false,
      timeoutMs: num(tts.timeoutMs, D.tts.timeoutMs, 4000, 60000),
      attemptTimeoutMs: num(tts.attemptTimeoutMs, D.tts.attemptTimeoutMs, 3000, 30000),
      retries: Math.round(num(tts.retries, D.tts.retries, 0, 3)),
      maxChars: Math.round(num(tts.maxChars, D.tts.maxChars, 20, 300)),
    },
    limits: {
      requestTimeoutMs: num(lim.requestTimeoutMs, D.limits.requestTimeoutMs, 5000, 60000),
      historyMessages: Math.round(num(lim.historyMessages, D.limits.historyMessages, 0, 30)),
    },
  };
}

let configCache: YukiConfig | null = null;
export async function getYukiConfig(): Promise<YukiConfig> {
  if (configCache) return configCache;
  let raw: unknown = null;
  try {
    const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL || "/";
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const r = await fetch(`${base}config.json`, { cache: "no-cache", signal: ctrl.signal });
      if (r.ok) raw = await r.json();
    } finally {
      clearTimeout(t);
    }
  } catch {
    /* config rusak / tidak ada → pakai default */
  }
  return (configCache = normalizeConfig(raw));
}

export const EXPRESSIONS = [
  "Senang", "Sedih", "Malu", "Tsundere", "Marah", "Kaget", "Bingung", "Serius",
] as const;
export type Expression = (typeof EXPRESSIONS)[number];

export interface Parsed {
  expression: Expression;
  text1: string;
  text2: string;
}

export class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedError";
  }
}
export const isAbort = (e: unknown): boolean =>
  e instanceof AbortedError || (e as { name?: string } | null)?.name === "AbortError";

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError());
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortedError());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ─── request: fetch + timeout + abort, termasuk membaca body ──────────────────
interface Res {
  ok: boolean;
  status: number;
  type: string;
  text: string;
  blob: Blob | null;
}

async function request(
  url: string,
  init: RequestInit,
  ms: number,
  outer: AbortSignal | undefined,
  kind: "text" | "blob",
): Promise<Res> {
  if (outer?.aborted) throw new AbortedError();
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, ms);
  const onAbort = () => ctrl.abort();
  outer?.addEventListener("abort", onAbort, { once: true });
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    const type = r.headers.get("content-type") || "";
    if (kind === "blob") {
      const blob = r.ok ? await r.blob() : null;
      return { ok: r.ok, status: r.status, type, text: "", blob };
    }
    return { ok: r.ok, status: r.status, type, text: await r.text(), blob: null };
  } catch {
    if (outer?.aborted) throw new AbortedError();
    throw new Error(timedOut ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  }
}

// ─── AI ───────────────────────────────────────────────────────────────────────
// Respons kev-ai: {"status":true,"creator":"Kev","result":"...","sessionId":"..."}
// Parser dibuat toleran: kalau bentuknya berubah, tetap mencoba mengambil teks.
export function extractAnswer(body: string): string {
  const raw = (body ?? "").trim();
  if (!raw) return "";
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return raw.startsWith("<") ? "" : raw; // HTML = halaman error, bukan jawaban
  }
  if (typeof data === "string") return data.trim();
  if (!data || typeof data !== "object") return "";
  if ((data as { status?: unknown }).status === false) return "";

  const KEYS = ["result", "response", "text", "answer", "message", "reply", "output", "content", "data"];
  const pick = (o: unknown, depth = 0): string => {
    if (typeof o === "string") return o.trim();
    if (!o || typeof o !== "object" || depth > 3) return "";
    for (const k of KEYS) {
      const v = (o as Record<string, unknown>)[k];
      const found = pick(v, depth + 1);
      if (found) return found;
    }
    return "";
  };
  return pick(data);
}

export function buildPrompt(
  system: string,
  history: { role: "user" | "assistant"; text: string }[],
  user: string,
  maxChars = 3600,
): string {
  const lines = history.map((h) => `${h.role === "user" ? "User" : "Yuki"}: ${h.text.slice(0, 240)}`);
  const build = () =>
    `${system}\n\n${lines.length ? `Riwayat percakapan:\n${lines.join("\n")}\n\n` : ""}User: ${user}`;
  let p = build();
  while (p.length > maxChars && lines.length) {
    lines.shift(); // buang riwayat tertua dulu; pesan terbaru selalu utuh
    p = build();
  }
  return p;
}

export async function askAI(prompt: string, signal: AbortSignal): Promise<string> {
  const cfg = await getYukiConfig();
  const textEndpoint = cfg.api.text;
  const fallbackEndpoint = cfg.api.textFallback;
  const timeout = cfg.limits.requestTimeoutMs;
  const attempts: { url: string; ms: number; proxy: boolean }[] = [
    { url: textEndpoint, ms: timeout, proxy: textEndpoint.startsWith("/") },
    { url: fallbackEndpoint, ms: Math.min(timeout, 16000), proxy: false },
  ];
  for (const a of attempts) {
    try {
      const r = a.proxy
        ? await request(a.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: prompt }) }, a.ms, signal, "text")
        : await request(`${a.url}?text=${encodeURIComponent(prompt)}`, {}, a.ms, signal, "text");
      if (r.ok) {
        const ans = extractAnswer(r.text);
        if (ans) return ans;
      }
    } catch (e) {
      if (isAbort(e)) throw e;
    }
    if (signal.aborted) throw new AbortedError();
  }
  throw new Error("ai-failed");
}

// ─── Parsing balasan AI → {ekspresi, kalimat1, kalimat2} ──────────────────────
const MAX_LINE = 220;

function stripMarkdown(s: string): string {
  return s
    .replace(/```[a-zA-Z]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/\r/g, "")
    .replace(/^\s*(yuki|assistant)\s*:\s*/i, "")
    .trim();
}

function clampLine(s: string, max = MAX_LINE): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const i = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf(","));
  return (i > max * 0.5 ? cut.slice(0, i) : cut).trim() + "…";
}

function sentences(t: string): string[] {
  const m = t.match(/[^.!?。！？…\n]+(?:[.!?。！？…]+|$)\s*/g);
  return (m ?? [t]).map((s) => s.trim()).filter(Boolean);
}

function toTwoLines(text: string): [string, string] {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return ["", ""];
  if (t.length <= 90) return [t, ""];
  const sents = sentences(t);
  if (sents.length < 2) {
    const mid = t.lastIndexOf(" ", Math.floor(t.length / 2));
    return mid > 20 ? [t.slice(0, mid), t.slice(mid + 1)] : [t, ""];
  }
  let best = 1;
  let bestDiff = Infinity;
  for (let i = 1; i < sents.length; i++) {
    const a = sents.slice(0, i).join(" ").length;
    const diff = Math.abs(t.length / 2 - a);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return [sents.slice(0, best).join(" "), sents.slice(best).join(" ")];
}

function matchExpression(s?: string): Expression | null {
  if (!s) return null;
  const k = s.replace(/[{}[\]()"'*:]/g, "").trim().toLowerCase();
  return EXPRESSIONS.find((e) => e.toLowerCase() === k) ?? null;
}

function finish(expression: Expression, a: string, b: string): Parsed {
  const text1 = clampLine(a);
  const text2 = clampLine(b);
  if (!text1) return { expression: "Bingung", text1: "Eh... aku lagi blank nih...", text2: "Coba tanya lagi ya~" };
  return { expression, text1, text2 };
}

export function parseAI(raw: string): Parsed {
  const t = stripMarkdown(raw ?? "");
  const parts = t.split("|").map((p) => p.trim());
  const exp = matchExpression(parts[0]);
  if (exp && parts.length >= 2) {
    const rest = parts.slice(1).filter(Boolean);
    if (rest.length >= 2) return finish(exp, rest[0], rest.slice(1).join(" "));
    if (rest.length === 1) {
      const [a, b] = toTwoLines(rest[0]);
      return finish(exp, a, b);
    }
  }
  const [a, b] = toTwoLines(t.replace(/\|/g, " "));
  return finish(exp ?? "Senang", a, b);
}

// ─── TTS ──────────────────────────────────────────────────────────────────────
export function ttsClean(s: string, max = 240): string {
  return (s ?? "")
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u200d]/gu, "")
    .replace(/[♡♪♥❤～〜~*_`#<>{}[\]\\|^]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

/** Isi template {text}; kalau template tidak punya {text}, tambahkan ?text= otomatis. */
export function buildVoiceUrl(template: string, text: string): string {
  const enc = encodeURIComponent(text);
  if (template.includes("{text}")) return template.replace(/\{text\}/g, () => enc);
  return `${template}${template.includes("?") ? "&" : "?"}text=${enc}`;
}

export interface VoiceClip {
  src: string; // blob: URL (sudah terunduh penuh) atau URL langsung (streaming)
  preloaded: boolean;
  /** perkiraan durasi (detik) bila metadata audio tidak tersedia */
  estSec: number;
  release: () => void;
}

// Cache kecil: kalimat yang sama (mis. sapaan) berikutnya instan.
const clipCache = new Map<string, Blob>();
function cachePut(key: string, blob: Blob) {
  clipCache.delete(key);
  clipCache.set(key, blob);
  while (clipCache.size > 16) {
    const first = clipCache.keys().next().value;
    if (first === undefined) break;
    clipCache.delete(first);
  }
}

async function sniffType(blob: Blob): Promise<string> {
  const t = (blob.type || "").toLowerCase();
  if (t.startsWith("audio/")) return t;
  try {
    const head = await blob.slice(0, 4).text();
    if (head === "RIFF") return "audio/wav";
    if (head === "OggS") return "audio/ogg";
  } catch {
    /* abaikan */
  }
  return "audio/mpeg";
}

function findUrl(body: string): string {
  try {
    const walk = (o: unknown, d = 0): string => {
      if (typeof o === "string") return /^https?:\/\//i.test(o.trim()) ? o.trim() : "";
      if (!o || typeof o !== "object" || d > 3) return "";
      for (const v of Object.values(o as Record<string, unknown>)) {
        const f = walk(v, d + 1);
        if (f) return f;
      }
      return "";
    };
    return walk(JSON.parse(body));
  } catch {
    return "";
  }
}

/** Unduh audio sebagai Blob yang sudah divalidasi. null = gagal (tidak pernah melempar kecuali abort). */
async function downloadClip(url: string, ms: number, signal: AbortSignal, depth = 0): Promise<Blob | null> {
  try {
    const r = await request(url, {}, ms, signal, "blob");
    if (!r.ok || !r.blob) return null;
    const type = (r.type || r.blob.type || "").toLowerCase();
    if (type.includes("json") || type.startsWith("text/")) {
      // beberapa API mengembalikan JSON berisi link audio
      const link = depth === 0 ? findUrl(await r.blob.text()) : "";
      return link ? downloadClip(link, ms, signal, 1) : null;
    }
    if (r.blob.size < 256) return null;
    return new Blob([r.blob], { type: await sniffType(r.blob) });
  } catch (e) {
    if (isAbort(e)) throw e;
    return null;
  }
}

function clipFromBlob(blob: Blob, estSec: number): VoiceClip {
  const src = URL.createObjectURL(blob);
  return { src, preloaded: true, estSec, release: () => { try { URL.revokeObjectURL(src); } catch { /* abaikan */ } } };
}

/**
 * Menyiapkan suara dari API TTS di config.json (api.voice).
 * Urutan strategi — semuanya memakai API yang sama, tanpa suara pengganti:
 *   1. unduh langsung ke browser (bila API mengizinkan CORS)
 *   2. lewat proxy /api/tts (selalu lolos CORS)
 *   3. URL langsung ke elemen <audio> (streaming, tanpa CORS)
 * Sehingga teks baru dimunculkan tepat ketika suara siap diputar → sinkron 100%.
 * Mengembalikan null hanya bila tidak ada teks yang bisa diucapkan.
 */
export async function loadVoice(text: string, signal: AbortSignal): Promise<VoiceClip | null> {
  if (signal.aborted) throw new AbortedError();
  const cfg = await getYukiConfig();
  const clean = ttsClean(text, cfg.tts.maxChars);
  if (!clean) return null;
  const estSec = Math.max(1.2, clean.length * 0.075);

  const cached = clipCache.get(clean);
  if (cached) return clipFromBlob(cached, estSec);

  const direct = buildVoiceUrl(cfg.api.voice, clean);
  const proxy = cfg.api.voiceProxy
    ? `${cfg.api.voiceProxy}${cfg.api.voiceProxy.includes("?") ? "&" : "?"}text=${encodeURIComponent(clean)}&src=${encodeURIComponent(cfg.api.voice)}`
    : "";
  const urls = [direct, proxy].filter(Boolean);

  const deadline = Date.now() + cfg.tts.timeoutMs;
  for (let round = 0; round <= cfg.tts.retries; round++) {
    for (const u of urls) {
      const left = deadline - Date.now();
      if (left < 1500) break;
      const blob = await downloadClip(u, Math.min(left, cfg.tts.attemptTimeoutMs), signal);
      if (signal.aborted) throw new AbortedError();
      if (blob) {
        cachePut(clean, blob);
        return clipFromBlob(blob, estSec);
      }
    }
    if (deadline - Date.now() < 1500) break;
    if (round < cfg.tts.retries) await sleep(300, signal);
  }
  // Strategi 3: serahkan ke elemen <audio> (tidak terikat CORS).
  return { src: direct, preloaded: false, estSec, release: () => undefined };
}
