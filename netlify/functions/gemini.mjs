const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: CORS_HEADERS });
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const urlObj = new URL(req.url);

  if (req.method === "GET") {
    const action = urlObj.searchParams.get("action") || "ping";
    if (action === "ping") {
      return json({ ok: true, service: "KnowledgeRadar Netlify Gateway", ts: Date.now() });
    }
    return json({ ok: false, error: "Unknown GET action" }, 400);
  }

  if (req.method === "POST") {
    try {
      const body = await req.json().catch(() => ({}));
      const expectedSecret = (process.env.APP_SECRET || "").trim();

      if (expectedSecret && body.appSecret !== expectedSecret) {
        return json({ ok: false, status: 403, error: "Unauthorized appSecret" }, 403);
      }

      const userKey = (body.userApiKey || "").trim();
      const apiKey = userKey || (process.env.GEMINI_API_KEY || "").trim();
      if (!apiKey) {
        return json({ ok: false, status: 400, error: "No Gemini API key configured" }, 400);
      }

      if (body.action === "listModels") {
        const resp = await fetch(`${GEMINI_BASE}/models?key=${encodeURIComponent(apiKey)}&pageSize=100`);
        const text = await resp.text();
        return json({ ok: resp.ok, status: resp.status, data: safeJson(text) });
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
        return json({ ok: resp.ok, status: resp.status, data: safeJson(text) });
      }

      return json({ ok: false, status: 400, error: "Unknown POST action" }, 400);
    } catch (err) {
      return json({ ok: false, status: 500, error: String(err) }, 500);
    }
  }

  return json({ ok: false, error: "Method not allowed" }, 405);
};

export const config = {
  path: "/api/gemini",
};
