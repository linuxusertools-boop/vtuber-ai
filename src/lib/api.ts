// ─────────────────────────────────────────────────────────────────────────────
// Lapisan jaringan + parsing. Aturan utama: tidak ada fungsi di sini yang boleh
// membuat UI macet. Semua punya timeout, semua bisa dibatalkan (AbortSignal),
// semua kegagalan berakhir sebagai nilai yang aman (bukan exception liar).
// ─────────────────────────────────────────────────────────────────────────────

type YukiConfig = { aiName?: string; prompt?: string; api?: { text?: string; textFallback?: string; voice?: string; voiceFallback?: string }; limits?: { requestTimeoutMs?: number; historyMessages?: number } };
let configCache: YukiConfig | null = null;
export async function getYukiConfig(): Promise<YukiConfig> {
  if (configCache) return configCache;
  try { const r = await fetch("/config.json", { cache: "no-cache" }); if (r.ok) configCache = await r.json() as YukiConfig; } catch { /* safe defaults below */ }
  return configCache || (configCache = { aiName: "YUKI", prompt: "Kamu adalah YUKI, assistant yang ramah dan membantu.", api: { text: "/api/chat", textFallback: "https://kev-ai.vercel.app/ai", voice: "/api/tts", voiceFallback: "https://kev-tts.vercel.app/animemoe" } });
}
export const AI_URL = "https://kev-ai.vercel.app/ai";
export const TTS_URL = "https://kev-tts.vercel.app/animemoe";

export const EXPRESSIONS = [
  "Senang", "Sedih", "Malu", "Tsundere", "Marah", "Kaget", "Bingung", "Serius",
] as const;
export type Expression = (typeof EXPRESSIONS)[number];

export interface Parsed {
  expression: Expression;
  text1: string;
  text2: string;
}

export interface TTSResult {
  url: string;
  direct: boolean; // true = URL langsung ke kev-tts (tanpa blob), dimuat oleh elemen <audio>
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
  const textEndpoint = cfg.api?.text || "/api/chat";
  const fallbackEndpoint = cfg.api?.textFallback || AI_URL;
  const timeout = Math.max(5000, Math.min(60000, cfg.limits?.requestTimeoutMs || 22000));
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
    .replace(/^\s*(huohuo|assistant)\s*:\s*/i, "")
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
export function ttsClean(s: string): string {
  return (s ?? "")
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u200d]/gu, "")
    .replace(/[♡♪♥❤～〜~*_`#<>{}[\]\\|^]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

const cache = new Map<string, string>(); // teks → blob URL (LRU sederhana)
const CACHE_MAX = 24;

function remember(key: string, url: string) {
  cache.set(key, url);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const u = cache.get(oldest);
    cache.delete(oldest);
    if (u) URL.revokeObjectURL(u);
  }
}

const looksLikeAudio = (type: string) => /audio|octet-stream|mpeg|mp3/i.test(type);

/**
 * Menyiapkan suara untuk satu kalimat. Urutan: proxy Vercel (/api/tts) → fetch
 * langsung ke kev-tts → URL langsung (dimuat elemen <audio>, tidak butuh CORS).
 * Mengembalikan null hanya bila teks kosong. Melempar AbortedError jika dibatalkan.
 */
export async function prepareTTS(text: string, signal: AbortSignal): Promise<TTSResult | null> {
  const clean = ttsClean(text);
  if (!clean) return null;

  const hit = cache.get(clean);
  if (hit) {
    cache.delete(clean);
    cache.set(clean, hit);
    return { url: hit, direct: false };
  }

  const q = encodeURIComponent(clean);
  const cfg = await getYukiConfig();
  const voiceEndpoint = cfg.api?.voice || "/api/tts";
  const direct = `${cfg.api?.voiceFallback || TTS_URL}?text=${q}`;
  const tries = [
    { url: `${voiceEndpoint}?text=${q}`, ms: 10000 },
    { url: direct, ms: 9000 },
  ];
  for (const t of tries) {
    try {
      const r = await request(t.url, {}, t.ms, signal, "blob");
      if (r.ok && r.blob && r.blob.size > 200 && looksLikeAudio(r.type || r.blob.type)) {
        const url = URL.createObjectURL(r.blob);
        remember(clean, url);
        return { url, direct: false };
      }
    } catch (e) {
      if (isAbort(e)) throw e;
    }
  }
  return { url: direct, direct: true };
}
