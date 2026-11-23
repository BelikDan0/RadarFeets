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

function extractJsonObject(html, markers) {
  for (const marker of markers) {
    const idx = html.indexOf(marker);
    if (idx === -1) continue;
    const start = html.indexOf("{", idx + marker.length);
    if (start === -1) continue;
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = start; i < html.length; i++) {
      const ch = html[i];
      if (inStr) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === '"') inStr = false;
      } else {
        if (ch === '"') inStr = true;
        else if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            try {
              return JSON.parse(html.slice(start, i + 1));
            } catch {
              break;
            }
          }
        }
      }
    }
  }
  return null;
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

async function searchViaInnertube(query, sp) {
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

async function searchViaHtml(query, sp) {
  let url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=ru`;
  if (sp) url += `&sp=${encodeURIComponent(sp)}`;

  const resp = await fetch(url, { headers: YT_HEADERS });
  const html = await resp.text();
  const data = extractJsonObject(html, [
    "var ytInitialData =",
    'window["ytInitialData"] =',
    "ytInitialData =",
  ]);
  if (!data) return [];
  const videos = [];
  collectVideos(data, videos, new Set());
  return videos;
}

async function handleSearch(query, sp) {
  try {
    const videos = await searchViaInnertube(query, sp);
    if (videos.length > 0) return videos;
  } catch {
    // fallback below
  }
  return await searchViaHtml(query, sp);
}

async function fetchPlayerData(videoId) {
  try {
    const resp = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: {
        ...YT_HEADERS,
        "Content-Type": "application/json",
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
    if (resp.ok) {
      const data = await resp.json();
      if (data?.videoDetails?.title) return data;
    }
  } catch {
    // fallback below
  }

  const htmlResp = await fetch(
    `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=ru`,
    { headers: YT_HEADERS }
  );
  const html = await htmlResp.text();
  return extractJsonObject(html, [
    "var ytInitialPlayerResponse =",
    'window["ytInitialPlayerResponse"] =',
  ]);
}

async function handleTranscript(videoId) {
  const player = await fetchPlayerData(videoId);
  if (!player) {
    return { ok: false, error: "Could not parse YouTube video page" };
  }

  const title = player?.videoDetails?.title || "";
  const channelName = player?.videoDetails?.author || "";
  const description = (player?.videoDetails?.shortDescription || "").slice(0, 3000);
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

  const chosen =
    tracks.find((t) => (t.languageCode || "").startsWith("ru")) ||
    tracks.find((t) => (t.languageCode || "").startsWith("en")) ||
    tracks[0];

  let transcriptText = "";
  const transcriptLanguage = chosen?.languageCode || "";

  if (chosen && chosen.baseUrl) {
    try {
      const capResp = await fetch(chosen.baseUrl, { headers: YT_HEADERS });
      const xml = await capResp.text();
      const parts = [];
      const regex = /<text[^>]*>([\s\S]*?)<\/text>/g;
      let match;
      while ((match = regex.exec(xml)) !== null) {
        const cleaned = decodeHtmlEntities(match[1]);
        if (cleaned) parts.push(cleaned);
      }
      transcriptText = parts.join(" ").slice(0, 15000);
    } catch {
      transcriptText = "";
    }
  }

  return {
    ok: true,
    videoId,
    title,
    channelName,
    description,
    transcriptLanguage,
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
