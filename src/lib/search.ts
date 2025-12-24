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

  // Cache only extracted plain text per href.
  // FlexSearch export/import is multi-part and unreliable across versions,
  // but rebuilding from cached text is fast and stable.
  const hrefText: Record<string, string> =
    (cached?.hrefText as Record<string, string>) ?? {};

  const idx = makeIndex();

  // If cached text exists, rebuild index immediately
  const cachedHrefs = Object.keys(hrefText);
  if (cachedHrefs.length > 0) {
    for (const href of cachedHrefs) {
      idx.add(href, hrefText[href]);
    }
    return { idx, hrefText, fromCache: true };
  }

  const parser = new DOMParser();
  const items = book?.spine?.items ?? [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const href = item?.href;
    if (!href) continue;

    try {
      const raw = await book.load(href);
      const doc = parser.parseFromString(raw, "text/html");
      const text = normalize(doc.body?.textContent || "");

      if (text) {
        hrefText[href] = text;
        idx.add(href, text);
      }
    } catch {
      // ignore
    }

    if (i % 3 === 0) await new Promise(r => setTimeout(r, 0));
  }

  await saveSearchCache(bookId, { hrefText, updatedAt: Date.now() });
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
