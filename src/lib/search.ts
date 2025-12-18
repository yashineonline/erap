import FlexSearch from "flexsearch";
// import type ePub from "epubjs";
import { loadSearchCache, saveSearchCache } from "./storage";

type IndexHit = { href: string; score?: number };

function makeIndex() {
  return new (FlexSearch as any).Index({
    tokenize: "forward",
    resolution: 9,
    cache: 100,
  });
}

function normalize(t: string) {
  return (t || "").replace(/\s+/g, " ").trim();
}

function snippetFromText(text: string, q: string) {
  const t = normalize(text);
  const i = t.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return t.slice(0, 180) + (t.length > 180 ? "…" : "");
  const a = Math.max(0, i - 60);
  const b = Math.min(t.length, i + q.length + 100);
  return (a > 0 ? "…" : "") + t.slice(a, b) + (b < t.length ? "…" : "");
}

export async function ensureIndex(bookId: string, book: any) {
  const cached = await loadSearchCache(bookId);
  if (cached?.exported && cached?.hrefText) {
    const idx = makeIndex();
    await new Promise<void>((resolve) => idx.import(cached.exported, resolve));
    return { idx, hrefText: cached.hrefText as Record<string, string>, fromCache: true };
  }

  const idx = makeIndex();
  const hrefText: Record<string, string> = {};

  for (let i = 0; i < book.spine.items.length; i++) {
    const item = book.spine.items[i];
    const href = item.href;
    try {
      const raw = await book.load(href);
      const doc = new DOMParser().parseFromString(String(raw), "text/html");
      const text = normalize(doc.body?.textContent ?? "");
      if (text) {
        hrefText[href] = text;
        idx.add(href, text);
      }
    } catch {}

    if (i % 3 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  const exported = await new Promise<any>((resolve) => idx.export(resolve));
  await saveSearchCache(bookId, { exported, hrefText, updatedAt: Date.now() });

  return { idx, hrefText, fromCache: false };
}

export function search(idx: any, hrefText: Record<string, string>, q: string) {
  const query = q.trim();
  if (!query) return [];
  const hits = idx.search(query, 30) as (string | IndexHit)[];
  const hrefs = hits.map((h) => (typeof h === "string" ? h : h.href)).filter(Boolean) as string[];

  return hrefs.map((href) => ({
    href,
    snippet: snippetFromText(hrefText[href] || "", query),
  }));
}
