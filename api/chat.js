// Proxy tipis → kev-ai (Vercel Serverless Function).
// Alasan ada: menghindari masalah CORS dari browser. Klien tetap punya fallback langsung ke kev-ai.
const UPSTREAM = process.env.AI_API_URL || "https://kev-ai.vercel.app/ai";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ status: false, error: "Method not allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const text = typeof body?.text === "string" ? body.text : "";
  if (!text.trim() || text.length > 12000) {
    return res.status(400).json({ status: false, error: "Invalid text" });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const up = await fetch(`${UPSTREAM}?text=${encodeURIComponent(text)}`, { signal: ctrl.signal });
    const out = await up.text();
    res.setHeader("Content-Type", up.headers.get("content-type") || "application/json; charset=utf-8");
    return res.status(up.status).send(out);
  } catch {
    return res.status(502).json({ status: false, error: "Upstream unavailable" });
  } finally {
    clearTimeout(timer);
  }
}
