// Proxy tipis → API TTS (Vercel Serverless Function). GET /api/tts?text=...&src=<template>
// - src (opsional) = template URL dari config.json, mis. https://kev-tts.vercel.app/animemoe?text={text}
//   Hanya https dan host publik yang diterima. Tanpa src → env TTS_API_URL → default kev-tts.
// - Hasil di-cache di edge Vercel & browser, jadi kalimat yang sama berikutnya instan.
const DEFAULT_SRC = process.env.TTS_API_URL || "https://kev-tts.vercel.app/animemoe?text={text}";
const MAX_BYTES = 4 * 1024 * 1024; // batas respons fungsi Vercel ±4,5 MB

function build(template, text) {
  const enc = encodeURIComponent(text);
  if (template.includes("{text}")) return template.replace(/\{text\}/g, () => enc);
  return `${template}${template.includes("?") ? "&" : "?"}text=${enc}`;
}

function safeTemplate(src) {
  if (!src) return DEFAULT_SRC;
  try {
    const u = new URL(src.replace(/\{text\}/g, "x"));
    const h = u.hostname.toLowerCase();
    const bad =
      u.protocol !== "https:" ||
      h === "localhost" ||
      h.endsWith(".local") ||
      h.endsWith(".internal") ||
      h.includes(":") ||
      /^\d+\.\d+\.\d+\.\d+$/.test(h);
    return bad ? DEFAULT_SRC : src;
  } catch {
    return DEFAULT_SRC;
  }
}

const first = (v) => (Array.isArray(v) ? v[0] : v) || "";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ status: false, error: "Method not allowed" });
  }

  const text = String(first(req.query?.text));
  if (!text.trim() || text.length > 400) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(400).json({ status: false, error: "Invalid text" });
  }

  const upstream = build(safeTemplate(String(first(req.query?.src))), text);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const up = await fetch(upstream, { signal: ctrl.signal });
    const type = (up.headers.get("content-type") || "").toLowerCase();
    if (!up.ok) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(502).json({ status: false, error: "Upstream error" });
    }
    let buf = Buffer.from(await up.arrayBuffer());
    let outType = type.split(";")[0] || "audio/mpeg";

    // Beberapa API membalas JSON berisi link audio → ikuti satu kali.
    if (/json|text\//.test(type)) {
      let link = "";
      try {
        const walk = (o, d = 0) => {
          if (typeof o === "string") return /^https:\/\//i.test(o.trim()) ? o.trim() : "";
          if (!o || typeof o !== "object" || d > 3) return "";
          for (const v of Object.values(o)) { const f = walk(v, d + 1); if (f) return f; }
          return "";
        };
        link = walk(JSON.parse(buf.toString("utf8")));
      } catch { /* bukan JSON valid */ }
      if (!link) {
        res.setHeader("Cache-Control", "no-store");
        return res.status(502).json({ status: false, error: "Upstream returned no audio" });
      }
      const up2 = await fetch(link, { signal: ctrl.signal });
      if (!up2.ok) {
        res.setHeader("Cache-Control", "no-store");
        return res.status(502).json({ status: false, error: "Upstream error" });
      }
      buf = Buffer.from(await up2.arrayBuffer());
      outType = (up2.headers.get("content-type") || "").split(";")[0] || "audio/mpeg";
    }

    if (buf.length < 256 || buf.length > MAX_BYTES) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(502).json({ status: false, error: "Bad audio" });
    }
    if (!/^audio\//i.test(outType)) outType = "audio/mpeg";
    res.setHeader("Content-Type", outType);
    res.setHeader("Content-Length", String(buf.length));
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400");
    return res.status(200).send(buf);
  } catch {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ status: false, error: "Upstream unavailable" });
  } finally {
    clearTimeout(timer);
  }
}
