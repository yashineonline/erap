// src/lib/search.ts
import FlexSearch from "flexsearch";
// import type ePub from "epubjs";
import { loadSearchCache, saveSearchCache  } from "./storage";

// type IndexHit = { href: string; score?: number };

export type SearchIndexResult = {
  idx: any;
  hrefText: Record<string, string>;
  fromCache: boolean;
};

export type SearchHit = { href: string; snippet: string; count: number };


const SEARCH_CACHE_VERSION = 3;


export function makeIndex() {
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

function rawToPlainText(raw: any) {
  // epub.js may return a Document
  if (raw && typeof raw === "object" && (raw as any).nodeType === 9) {
    const d = raw as Document;
    return normalize(d.body?.textContent || d.documentElement?.textContent || "");
  }

  const s = typeof raw === "string" ? raw : String(raw ?? "");
  const parser = new DOMParser();

  let d = parser.parseFromString(s, "application/xhtml+xml");
  if (d.getElementsByTagName("parsererror").length) {
    d = parser.parseFromString(s, "text/html");
  }
  return normalize(d.body?.textContent || d.documentElement?.textContent || "");
}

export async function ensureIndex(
  bookId: string,
  book: any,
  onProgress?: (done: number, total: number, fromCache: boolean) => void
): Promise<SearchIndexResult> {
  const idx = makeIndex();

  const cached = await loadSearchCache(bookId);
  let hrefText: Record<string, string> = (cached?.hrefText as Record<string, string>) ?? {};

  // Invalidate old/bad caches
  const cachedVersion = (cached as any)?.v;
  const totalChars = Object.values(hrefText).reduce((a, t) => a + (t?.length || 0), 0);
  if (cachedVersion !== SEARCH_CACHE_VERSION || totalChars < 500) {
    hrefText = {};
  }

  // Fast path: rebuild index from cached plain text
  const cachedHrefs = Object.keys(hrefText);
  if (cachedHrefs.length > 0) {
    for (const href of cachedHrefs) {
      const t = hrefText[href];
      if (t) idx.add(href, t.toLowerCase());
    }
    onProgress?.(cachedHrefs.length, cachedHrefs.length, true);
    return { idx, hrefText, fromCache: true };
  }

  // Build from spine
  const items = book?.spine?.items ?? [];
  const total = items.length;
  for (let i = 0; i < items.length; i++) {
    const href = items[i]?.href;
    if (!href) {
      onProgress?.(i + 1, total, false);
      continue;
    }

    try {
      const raw = await book.load(href);
      const text = rawToPlainText(raw);
      if (text) {
        hrefText[href] = text;
        idx.add(href, text.toLowerCase());
      }
    } catch {
      // ignore per-chapter load failures
    }

    onProgress?.(i + 1, total, false);
    if (i % 3 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  await saveSearchCache(bookId, { v: SEARCH_CACHE_VERSION, hrefText, updatedAt: Date.now() });
  return { idx, hrefText, fromCache: false };
}

// export async function ensureIndex(
//   bookId: string,
//   book: any,
//   onProgress?: (done: number, total: number, fromCache: boolean) => void
// ): Promise<SearchIndexResult> {
//   const cached = await loadSearchCache(bookId);

//   // Cache only extracted plain text per href.
//   // FlexSearch export/import is multi-part and unreliable across versions,
//   // but rebuilding from cached text is fast and stable.
//   let hrefText: Record<string, string> =
//     (cached?.hrefText as Record<string, string>) ?? {};

//     const cachedVersion = (cached as any)?.v;
//     const totalChars = Object.values(hrefText).reduce((a, t) => a + (t?.length || 0), 0);
//     if (cachedVersion !== SEARCH_CACHE_VERSION || totalChars < 200) {
//       hrefText = {};
//     }

//   const idx = makeIndex();

//   // If cached text exists, rebuild index immediately
//   const cachedHrefs = Object.keys(hrefText);
//   if (cachedHrefs.length > 0) {
//     for (const href of cachedHrefs) idx.add(href, hrefText[href].toLowerCase());
//     onProgress?.(cachedHrefs.length, cachedHrefs.length, true);
//     return { idx, hrefText, fromCache: true };
//   }
  

//     return { idx, hrefText, fromCache: true };
//   }
  
//   // const parser = new DOMParser();
//   const items = book?.spine?.items ?? [];

//   // const total = items.length;
// for (let i = 0; i < items.length; i++) {
//   const item = items[i];
//   const href = item?.href;
//   if (!href) continue;

//   try {
//     const raw = await book.load(href);
//     const text = rawToPlainText(raw);

//     if (text) {
//       hrefText[href] = text;
//       idx.add(href, text.toLowerCase());   // index lower-case
//     }
//   } catch (e) {
//     console.error("[search] failed", e);
//     return { idx: makeIndex(), hrefText: {}, fromCache: false };
//   }
  

//   // onProgress?.(i + 1, total, false);
//   if (i % 3 === 0) await new Promise(r => setTimeout(r, 0));
// }
// await saveSearchCache(bookId, { v: SEARCH_CACHE_VERSION, hrefText, updatedAt: Date.now() });

// return { idx, hrefText, fromCache: false };

//   }

//   await saveSearchCache(bookId, { hrefText, updatedAt: Date.now() });
//   return { idx, hrefText, fromCache: false };
// }


// export function search(idx: any, hrefText: Record<string, string>, q: string) {
//   const query = q.trim();
//   if (!query) return [];
//   const hits = idx.search(query.toLowerCase(), 30) as (string | IndexHit)[];

//   // const hits = idx.search(query, 30) as (string | IndexHit)[];
//   const hrefs = hits.map((h) => (typeof h === "string" ? h : h.href)).filter(Boolean) as string[];

//   return hrefs.map((href) => ({
//     href,
//     snippet: snippetFromText(hrefText[href] || "", query),
//   }));
// }

function countAndFirstPos(hay: string, needle: string) {
  let count = 0;
  let first = -1;
  let from = 0;
  while (true) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    if (first < 0) first = i;
    count++;
    from = i + Math.max(1, needle.length);
  }
  return { count, first };
}

export function search(_idx: any, hrefText: Record<string, string>, q: string): SearchHit[] {
  const query = normalize(q);
  if (!query) return [];

  const needle = query.toLowerCase();
  const out: SearchHit[] = [];

  for (const href of Object.keys(hrefText)) {
    const t = normalize(hrefText[href] || "");
    if (!t) continue;

    const hay = t.toLowerCase();
    const { count, first } = countAndFirstPos(hay, needle);
    if (count <= 0 || first < 0) continue;

    out.push({
      href,
      count,
      snippet: snippetFromText(t, query), // uses first occurrence already
    });
  }

  // Sort by most matches first (helps when there are many)
  out.sort((a, b) => b.count - a.count);
  return out;
}
