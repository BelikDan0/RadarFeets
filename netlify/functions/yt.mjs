const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

const YT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
  "Cookie":
    "CONSENT=YES+cb.20210328-17-p0.en+FX+417; SOCS=CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: CORS_HEADERS });
}

function decodeHtmlEntities(str) {
  return (str || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function collectVideos(node, out, seen) {
  if (!node || typeof node !== "object" || out.length >= 10) return;

  if (node.videoRenderer && node.videoRenderer.videoId) {
    const v = node.videoRenderer;
    if (!seen.has(v.videoId)) {
      seen.add(v.videoId);
      const title =
        v.title?.runs?.map((r) => r.text).join("") ||
        v.title?.simpleText ||
        "";
      const channelName =
        v.ownerText?.runs?.[0]?.text ||
        v.longBylineText?.runs?.[0]?.text ||
        "";
      const duration = v.lengthText?.simpleText || "";
      const views = v.viewCountText?.simpleText || "";
      const published = v.publishedTimeText?.simpleText || "";
      out.push({
        videoId: v.videoId,
        title,
        channelName,
        duration,
        views,
        published,
        thumbnailUrl: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
        videoUrl: `https://www.youtube.com/watch?v=${v.videoId}`,
      });
    }
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectVideos(item, out, seen);
      if (out.length >= 10) return;
    }
  } else {
    for (const key of Object.keys(node)) {
      collectVideos(node[key], out, seen);
      if (out.length >= 10) return;
    }
  }
}

function findFirstString(node, predicate) {
  if (!node || typeof node !== "object") return "";
  for (const key of Object.keys(node)) {
    const val = node[key];
    const hit = predicate(key, val);
    if (hit) return hit;
    if (val && typeof val === "object") {
      const nested = findFirstString(val, predicate);
      if (nested) return nested;
    }
  }
  return "";
}

async function handleSearch(query, sp) {
  const payload = {
    context: {
      client: {
        clientName: "WEB",
        clientVersion: "2.20250501.00.00",
        hl: "ru",
        gl: "RU",
      },
    },
    query,
  };
  if (sp) payload.params = sp;

  const resp = await fetch("https://www.youtube.com/youtubei/v1/search?prettyPrint=false", {
    method: "POST",
    headers: {
      ...YT_HEADERS,
      "Content-Type": "application/json",
      "Origin": "https://www.youtube.com",
      "Referer": "https://www.youtube.com/",
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  const videos = [];
  collectVideos(data, videos, new Set());
  return videos;
}

async function fetchNextMetadata(videoId) {
  try {
    const resp = await fetch("https://www.youtube.com/youtubei/v1/next?prettyPrint=false", {
      method: "POST",
      headers: {
        ...YT_HEADERS,
        "Content-Type": "application/json",
        "Origin": "https://www.youtube.com",
        "Referer": `https://www.youtube.com/watch?v=${videoId}`,
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "WEB",
            clientVersion: "2.20250501.00.00",
            hl: "ru",
            gl: "RU",
          },
        },
        videoId,
      }),
    });
    if (!resp.ok) return { description: "", transcriptParams: "" };
    const data = await resp.json();

    const description = findFirstString(data, (k, v) => {
      if (k === "attributedDescription" && v && typeof v.content === "string" && v.content.length > 20) {
        return v.content;
      }
      if (k === "description" && v && typeof v.simpleText === "string" && v.simpleText.length > 20) {
        return v.simpleText;
      }
      if (k === "attributedDescriptionBodyText" && v && typeof v.content === "string" && v.content.length > 20) {
        return v.content;
      }
      return "";
    });

    const transcriptParams = findFirstString(data, (k, v) => {
      if (k === "getTranscriptEndpoint" && v && typeof v.params === "string") {
        return v.params;
      }
      return "";
    });

    return { description: description.slice(0, 4000), transcriptParams };
  } catch {
    return { description: "", transcriptParams: "" };
  }
}

async function fetchTranscriptViaNextEndpoint(params) {
  if (!params) return "";
  try {
    const resp = await fetch(
      "https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false",
      {
        method: "POST",
        headers: {
          ...YT_HEADERS,
          "Content-Type": "application/json",
          "Origin": "https://www.youtube.com",
          "Referer": "https://www.youtube.com/",
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: "WEB",
              clientVersion: "2.20250501.00.00",
              hl: "ru",
              gl: "RU",
            },
          },
          params,
        }),
      }
    );
    if (!resp.ok) return "";
    const data = await resp.json();
    const lines = [];
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (node.transcriptSegmentRenderer?.snippet?.runs) {
        const text = node.transcriptSegmentRenderer.snippet.runs
          .map((r) => r.text || "")
          .join("")
          .trim();
        if (text) lines.push(text);
        return;
      }
      if (Array.isArray(node)) node.forEach(walk);
      else Object.values(node).forEach(walk);
    };
    walk(data);
    return decodeHtmlEntities(lines.join(" ")).slice(0, 15000);
  } catch {
    return "";
  }
}

async function fetchOembed(videoId) {
  try {
    const resp = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`
    );
    if (resp.ok) return await resp.json();
  } catch {
    // ignore
  }
  return null;
}

async function handleTranscript(videoId) {
  const [nextMeta, oembed] = await Promise.all([
    fetchNextMetadata(videoId),
    fetchOembed(videoId),
  ]);

  const title = oembed?.title || "";
  const channelName = oembed?.author_name || "";
  const description = nextMeta.description || "";
  const transcriptText = await fetchTranscriptViaNextEndpoint(nextMeta.transcriptParams);

  return {
    ok: Boolean(title || description || transcriptText),
    videoId,
    title,
    channelName,
    description,
    transcriptLanguage: transcriptText ? "auto" : "",
    transcriptText,
  };
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "GET") {
    return json({ ok: false, error: "Only GET is supported" }, 405);
  }

  const urlObj = new URL(req.url);
  const action = urlObj.searchParams.get("action") || "ping";

  try {
    if (action === "ping") {
      return json({ ok: true, service: "KnowledgeRadar YouTube Proxy", ts: Date.now() });
    }
    if (action === "search") {
      const q = (urlObj.searchParams.get("q") || "").trim();
      if (!q) return json({ ok: false, error: "Missing q parameter" }, 400);
      const sp = urlObj.searchParams.get("sp") || "";
      const videos = await handleSearch(q, sp);
      return json({ ok: true, count: videos.length, videos });
    }
    if (action === "transcript") {
      const videoId = (urlObj.searchParams.get("videoId") || "").trim();
      if (!videoId) return json({ ok: false, error: "Missing videoId parameter" }, 400);
      const data = await handleTranscript(videoId);
      return json(data, data.ok ? 200 : 404);
    }
    return json({ ok: false, error: "Unknown action" }, 400);
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
};

export const config = {
  path: "/api/yt",
};
