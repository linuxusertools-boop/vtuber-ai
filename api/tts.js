// Proxy tipis → kev-tts (Vercel Serverless Function). GET /api/tts?text=...
// Hasilnya di-cache di edge Vercel & browser, jadi kalimat yang sama berikutnya instan.
const UPSTREAM = process.env.TTS_API_URL || "https://kev-tts.vercel.app/animemoe";
const MAX_BYTES = 4 * 1024 * 1024; // batas respons fungsi Vercel ±4,5 MB

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ status: false, error: "Method not allowed" });
  }

  const raw = req.query?.text;
  const text = (Array.isArray(raw) ? raw[0] : raw) || "";
  if (!text.trim() || text.length > 300) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(400).json({ status: false, error: "Invalid text" });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const up = await fetch(`${UPSTREAM}?text=${encodeURIComponent(text)}`, { signal: ctrl.signal });
    const type = up.headers.get("content-type") || "";
    if (!up.ok || !/audio|octet-stream/i.test(type)) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(502).json({ status: false, error: "Upstream error" });
    }
    const buf = Buffer.from(await up.arrayBuffer());
    if (buf.length < 200 || buf.length > MAX_BYTES) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(502).json({ status: false, error: "Bad audio" });
    }
    res.setHeader("Content-Type", type.split(";")[0] || "audio/mpeg");
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
