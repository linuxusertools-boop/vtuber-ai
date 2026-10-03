// Proxy tipis ke API AI (Vercel Serverless Function).
// Menghindari masalah CORS dari browser dan tidak menaruh panggilan upstream di sisi klien.
// Klien tetap punya fallback langsung ke API jika /api/chat tidak tersedia (mis. hosting statis).
const UPSTREAM = process.env.AI_API_URL || "https://api.nexray.eu.cc/ai/gemini";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (!text || text.length > 12000) {
    return res.status(400).json({ error: "Invalid text" });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const up = await fetch(`${UPSTREAM}?text=${encodeURIComponent(text)}`, { signal: ctrl.signal });
    const body = await up.text();
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", up.headers.get("content-type") || "application/json");
    return res.status(up.status).send(body);
  } catch {
    return res.status(502).json({ error: "Upstream unavailable" });
  } finally {
    clearTimeout(timer);
  }
}
