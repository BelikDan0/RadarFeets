import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import feedparser
import requests
from bs4 import BeautifulSoup

API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
MODELS = ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"]
OUTPUT_DIR = Path("docs/feeds")
MAX_ITEMS_PER_TOPIC = 30
NEW_ARTICLES_PER_RUN = 6

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; KnowledgeRadarBot/1.0)"
}

TOPICS: dict[str, dict[str, Any]] = {
    "it": {
        "title": "IT и ИИ",
        "categories": [
            "ai_models", "ai_agents", "ai_howto",
            "tech_emerging", "tech_business",
            "dev_languages", "dev_frameworks", "dev_bugs", "dev_arch",
        ],
        "prompt_addon": "Фокус: суть технологии, практическая польза для разработчика, примеры стека/подходов, без воды.",
        "feeds": [
            ("Habr Разработка", "https://habr.com/ru/rss/hubs/programming/articles/?fl=ru"),
            ("Habr ИИ", "https://habr.com/ru/rss/hubs/artificial_intelligence/articles/?fl=ru"),
            ("Dev.to", "https://dev.to/feed"),
            ("Android Developers", "https://android-developers.googleblog.com/feeds/posts/default?alt=rss"),
            ("Hacker News", "https://hnrss.org/frontpage"),
        ],
    },
    "economy": {
        "title": "Экономика и бизнес",
        "categories": ["eco_macro", "eco_startups", "eco_marketing", "eco_industries"],
        "prompt_addon": "Фокус: ключевые цифры, причины и следствия для рынка и практические выводы для бизнеса.",
        "feeds": [
            ("VC.ru", "https://vc.ru/rss/all"),
            ("РБК Экономика", "https://rssexport.rbc.ru/rbcnews/news/20/full.rss"),
            ("Коммерсантъ Экономика", "https://www.kommersant.ru/RSS/section-economics.xml"),
        ],
    },
    "finance_crypto": {
        "title": "Финансы, акции и крипта",
        "categories": ["fin_ru_market", "fin_global", "fin_crypto", "fin_personal"],
        "prompt_addon": "Фокус: тикеры/активы, драйверы движения и риски. Без прямых инвестиционных рекомендаций.",
        "feeds": [
            ("ForkLog", "https://forklog.com/feed"),
            ("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"),
            ("Smart-Lab", "https://smart-lab.ru/rss/flow/"),
        ],
    },
    "law": {
        "title": "Юриспруденция и право",
        "categories": ["law_new", "law_tax_ip", "law_digital", "law_courts"],
        "prompt_addon": "Фокус: номер закона/статьи (если есть), что именно изменилось, кого касается и сроки вступления.",
        "feeds": [
            ("Право.ру", "https://pravo.ru/rss/"),
            ("Клерк.ру", "https://www.klerk.ru/export/news.rss"),
            ("Гарант.ру", "https://www.garant.ru/rss/news/"),
        ],
    },
    "politics": {
        "title": "Политика и мир",
        "categories": ["pol_ru", "pol_world", "pol_geo", "pol_gov"],
        "prompt_addon": "Фокус: максимально нейтральная фактология, позиции сторон и последствия, без кликбейта.",
        "feeds": [
            ("Коммерсантъ Политика", "https://www.kommersant.ru/RSS/section-politics.xml"),
            ("ТАСС", "https://tass.ru/rss/v2.xml"),
            ("BBC World", "https://feeds.bbci.co.uk/news/world/rss.xml"),
        ],
    },
    "history": {
        "title": "История",
        "categories": ["hist_ancient", "hist_modern", "hist_russia", "hist_myths"],
        "prompt_addon": "Фокус: историческая эпоха, точные даты, причинно-следственные связи и источники.",
        "feeds": [
            ("N+1", "https://nplus1.ru/rss"),
            ("ПостНаука", "https://postnauka.org/feed"),
            ("Smithsonian History", "https://www.smithsonianmag.com/rss/history/"),
        ],
    },
}


def extract_og_image(url: str) -> str | None:
    try:
        r = requests.get(url, headers=HEADERS, timeout=6)
        if r.status_code != 200:
            return None
        soup = BeautifulSoup(r.text[:60000], "html.parser")
        for attr in ({"property": "og:image"}, {"name": "twitter:image"}):
            tag = soup.find("meta", attrs=attr)
            if tag and tag.get("content", "").startswith("http"):
                return tag["content"].strip()
    except Exception:
        return None
    return None


def fetch_candidates(topic_cfg: dict[str, Any], known_urls: set[str]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for source_name, feed_url in topic_cfg["feeds"]:
        try:
            resp = requests.get(feed_url, headers=HEADERS, timeout=10)
            parsed = feedparser.parse(resp.content)
            for entry in parsed.entries[:6]:
                link = (entry.get("link") or "").strip()
                if not link or link in known_urls:
                    continue
                summary_raw = entry.get("summary") or entry.get("description") or ""
                summary_clean = BeautifulSoup(summary_raw, "html.parser").get_text(" ", strip=True)[:600]
                img = None
                for enc in entry.get("enclosures", []):
                    if "image" in (enc.get("type") or ""):
                        img = enc.get("href")
                        break
                if not img and entry.get("media_content"):
                    img = entry["media_content"][0].get("url")
                candidates.append({
                    "sourceName": source_name,
                    "sourceUrl": link,
                    "title": (entry.get("title") or "").strip(),
                    "snippet": summary_clean,
                    "imageUrl": img,
                    "published": entry.get("published") or "",
                })
        except Exception as exc:
            print(f"  [WARN] Feed failed ({source_name}): {exc}")
    # Ограничиваем пакет для экономии токенов и скорости
    return candidates[: NEW_ARTICLES_PER_RUN * 2]


def call_gemini(prompt: str) -> list[dict[str, Any]]:
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0.3,
        },
    }
    for model in MODELS:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={API_KEY}"
        for attempt in range(2):
            try:
                resp = requests.post(url, json=payload, timeout=45)
                if resp.status_code == 200:
                    text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
                    data = json.loads(text)
                    if isinstance(data, dict) and isinstance(data.get("items"), list):
                        return data["items"]
                    if isinstance(data, list):
                        return data
                elif resp.status_code == 503:
                    print(f"  [503] {model} busy, retrying...")
                    time.sleep(3)
                    continue
                else:
                    print(f"  [ERR] {model} HTTP {resp.status_code}: {resp.text[:200]}")
                    break
            except Exception as exc:
                print(f"  [ERR] {model}: {exc}")
                time.sleep(2)
    return []


def process_topic(topic_id: str, topic_cfg: dict[str, Any]) -> int:
    out_file = OUTPUT_DIR / f"{topic_id}.json"
    existing: list[dict[str, Any]] = []
    if out_file.exists():
        try:
            existing = json.loads(out_file.read_text(encoding="utf-8"))
        except Exception:
            existing = []

    known_urls = {item.get("sourceUrl", "") for item in existing}
    candidates = fetch_candidates(topic_cfg, known_urls)
    if not candidates:
        print(f"[{topic_id}] No new candidates.")
        return 0

    prompt = f"""Ты редактор новостного и образовательного приложения.
Тема: {topic_cfg['title']} (domainId: "{topic_id}").
Допустимые categoryId: {json.dumps(topic_cfg['categories'], ensure_ascii=False)}.
{topic_cfg['prompt_addon']}

Выбери до {NEW_ARTICLES_PER_RUN} самых интересных и полезных материалов из списка ниже.
Обязательно переведи англоязычные материалы на естественный русский язык (сохраняя термины).
Верни строго JSON-объект вида {{"items": [...]}}, где каждый элемент имеет поля:
- categoryId (строго из допустимых)
- contentType ("NEWS" | "ARTICLE" | "GUIDE" | "BUG_CASE" | "BOOK")
- title (на русском)
- summaryShort (2-3 ёмких предложения на русском)
- keyTakeaways (массив из 3-4 коротких тезисов на русском)
- fullContentMarkdown (структурированный конспект в Markdown на русском, 3-5 абзацев)
- sourceName (как в исходнике)
- sourceUrl (точно как в исходнике)
- imageUrl (если было в исходнике, иначе пустая строка)
- tags (массив 2-4 коротких тегов)
- difficulty ("BEGINNER" | "MIDDLE" | "ADVANCED" | "GENERAL")
- importanceScore (целое от 1 до 10)

Список кандидатов:
{json.dumps(candidates, ensure_ascii=False)}
"""

    new_items = call_gemini(prompt)
    now_ms = int(time.time() * 1000)
    added = 0
    for item in new_items:
        url = (item.get("sourceUrl") or "").strip()
        if not url or url in known_urls:
            continue
        if not item.get("imageUrl"):
            item["imageUrl"] = extract_og_image(url) or ""
        item["domainId"] = topic_id
        item["downloadedAt"] = now_ms
        existing.insert(0, item)
        known_urls.add(url)
        added += 1

    existing = existing[:MAX_ITEMS_PER_TOPIC]
    out_file.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[{topic_id}] Added {added} new items (total: {len(existing)}).")
    return added


def main() -> None:
    if not API_KEY:
        raise SystemExit("GEMINI_API_KEY is not set")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    summary = {
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "topics": {},
    }
    for topic_id, cfg in TOPICS.items():
        process_topic(topic_id, cfg)
        out_file = OUTPUT_DIR / f"{topic_id}.json"
        count = len(json.loads(out_file.read_text(encoding="utf-8"))) if out_file.exists() else 0
        summary["topics"][topic_id] = {
            "title": cfg["title"],
            "file": f"{topic_id}.json",
            "count": count,
        }
        time.sleep(2)

    (OUTPUT_DIR / "index.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
