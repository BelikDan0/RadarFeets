const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // GET: пинг шлюза
  if (req.method === "GET") {
    const action = (req.query && req.query.action) || "ping";
    if (action === "ping") {
      return res.status(200).json({
        ok: true,
        service: "KnowledgeRadar Vercel Gateway",
        ts: Date.now(),
      });
    }
    return res.status(400).json({ ok: false, error: "Unknown GET action" });
  }

  // POST: прокси к Gemini API (совместимо с форматом GAS-шлюза в приложении)
  if (req.method === "POST") {
    try {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const expectedSecret = (process.env.APP_SECRET || "").trim();

      if (expectedSecret && body.appSecret !== expectedSecret) {
        return res.status(403).json({ ok: false, status: 403, error: "Unauthorized appSecret" });
      }

      const userKey = (body.userApiKey || "").trim();
      const apiKey = userKey || (process.env.GEMINI_API_KEY || "").trim();
      if (!apiKey) {
        return res.status(400).json({ ok: false, status: 400, error: "No Gemini API key configured" });
      }

      if (body.action === "listModels") {
        const resp = await fetch(`${GEMINI_BASE}/models?key=${encodeURIComponent(apiKey)}&pageSize=100`);
        const text = await resp.text();
        return res.status(200).json({
          ok: resp.ok,
          status: resp.status,
          data: safeJson(text),
        });
      }

      if (body.action === "generateContent") {
        const model = body.model || "gemini-3.1-flash-lite";
        const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body.payload || {}),
        });
        const text = await resp.text();
        return res.status(200).json({
          ok: resp.ok,
          status: resp.status,
          data: safeJson(text),
        });
      }

      return res.status(400).json({ ok: false, status: 400, error: "Unknown POST action" });
    } catch (err) {
      return res.status(500).json({ ok: false, status: 500, error: String(err) });
    }
  }

  return res.status(405).json({ ok: false, error: "Method not allowed" });
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
