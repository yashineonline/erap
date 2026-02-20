<template>
    <div class="card bg-base-200 shadow m-4">
      <div class="card-body">
        <div class="flex items-start justify-between gap-3">
          <div class="text-lg font-semibold">Daily Quote</div>
          <div class="badge badge-outline">{{ todayLabel }}</div>
        </div>
  
        <div v-if="books.length > 1" class="mt-2 flex items-center gap-2">
  <span class="text-sm opacity-70">Book:</span>
  <select class="select select-bordered select-sm w-full max-w-xs"
          v-model="selectedBookId"
          @change="onBookChange">
          <option :value="RANDOM_BOOK_ID">Random (any book)</option>
    <option v-for="b in books" :key="b.id" :value="b.id">
      {{ (b.title || "Untitled") + (b.author ? " — " + b.author : "") }}
    </option>
  </select>
</div>


        <div v-if="loading" class="opacity-70">Loading daily quote…</div>
  
        <div v-else-if="error" class="alert alert-error">
          <span>{{ error }}</span>
        </div>
  
        <div v-else-if="quote">
          <blockquote class="text-lg italic leading-relaxed text-center">
            “{{ quote.text }}”
          </blockquote>
  
          <!-- Quran only: Sura line must be between quote and citation -->
          <p v-if="quote.profile === 'quran' && quote.suraLine" class="mt-3 text-base font-semibold text-center">
            {{ quote.suraLine }}
          </p>
  
          <p class="text-right font-semibold mt-3 opacity-90">
            — {{ quote.citation }}
          </p>
  
          <div class="mt-4 flex flex-wrap gap-2 justify-end">
            <button class="btn btn-sm btn-outline" @click="copyQuote">Copy</button>
            <button class="btn btn-sm" @click="refreshQuote" title="Generate a new quote (and cache it for today)">
              New for today
            </button>
          </div>
  
          <div class="mt-2 text-xs opacity-60 text-right" v-if="quote.bookTitle">
            Source: {{ quote.bookTitle }}
          </div>
        </div>
  
        <div v-else class="opacity-70">
          Import a Quran EPUB (or any EPUB) to enable daily quotes.
        </div>
      </div>
    </div>
  </template>
  
  <script setup lang="ts">
  import { computed, onMounted, ref } from "vue";
  import ePub from "epubjs";
  import { loadBooks, loadBookFile } from "../lib/storage";
  import type { BookMeta } from "../lib/types";
  import { detectProfileFromMetadata, type BookProfile } from "../lib/profiles";
  
  type DailyQuote = {
    dateISO: string;
    bookId: string;
    bookTitle?: string;
    profile: BookProfile;
    text: string;
    citation: string;
    suraLine?: string;
  };
  
  type SpineItemLike = {
    href?: string;
    properties?: string | string[];
    linear?: string;
  };
  
  const DEBUG_DQ = true;
  
  const loading = ref(true);
  const error = ref("");
  const quote = ref<DailyQuote | null>(null);
    const books = ref<BookMeta[]>([]);
const selectedBookId = ref<string>("");

const DQ_SELECTED_BOOK_KEY = "dailyQuote:selectedBookId:v2";
const RANDOM_BOOK_ID = "__RANDOM__";

  
  const todayISO = () => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  };
  
  const todayLabel = computed(() =>
    new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
  );
  
  function cacheKey(bookId: string) {
    // v5: stored quote now uses Quran formatting with Sura line + translator-only citation
    return `dailyQuote:v11:${bookId}`;
  }
  
  function safeText(s: unknown) {
    return String(s ?? "").replace(/\s+/g, " ").trim();
  }
  
  function mulberry32(seed: number) {
    return function () {
      let t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  
  function seedFromString(s: string) {
    // FNV-1a 32-bit
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  
  function toDocument(raw: unknown): Document {
    if (raw && typeof raw === "object" && "nodeType" in raw) {
      const nt = (raw as { nodeType?: unknown }).nodeType;
      if (nt === 9) return raw as Document;
    }
    return new DOMParser().parseFromString(String(raw ?? ""), "text/html");
  }
  
  type VerseCandidate = { text: string; fragment?: string; suraLine?: string };
  
  /**
   * Structural TOC bypass:
   * - skip anything inside nav/doc-toc/navigation
   * - skip any p/li containing links (TOC entries are typically links)
   *
   * Verse-like paragraph filter:
   * - starts with 1. / 1) / 1 <space> ... OR 2:255
   *
   * Sura extraction from chapter HTML (NO TOC needed):
   * - scan DOM order and remember the most recent heading text that starts with "Sura"
   */
  function extractVerseCandidates(doc: Document): 
  VerseCandidate[] {
    const out: VerseCandidate[] = [];
    let totalPL = 0;
    let skippedNav = 0;
    let skippedLink = 0;
    let skippedRegex = 0;
    let kept = 0;


  
    const isInNav = (el: Element) =>
      Boolean(el.closest("nav,[epub\\:type='toc'],[role='doc-toc'],[role='navigation']"));
      const hasLink = (el: Element) => {
  // Only treat as "TOC-like" if link text is most of the element’s text.
  const links = el.querySelectorAll("a[href]");
  if (!links.length) return el.tagName.toLowerCase() === "a";

  const fullText = safeText(el.textContent);
  const fullLen = fullText.length;

  let linkLen = 0;
  links.forEach((a) => {
    linkLen += safeText(a.textContent).length;
  });

  // Skip only when the element is mostly just links (typical TOC)
  return fullLen > 0 && linkLen >= Math.max(10, 0.6 * fullLen);
};

  
    const verseRe = /^\s*(?:\d{1,4}(?:[.)]\s+|\s+)\S|\d{1,3}\s*:\s*\d{1,3}\b)/;
  
    let currentSura: string | undefined;
    let suraHeadingCount = 0;
  
    // DOM-order scan: headings + verse-bearing blocks
    const nodes = Array.from(doc.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading'],p,li"));
    for (const el of nodes) {
  const tag = el.tagName.toLowerCase();

  if (tag === "p" || tag === "li") totalPL++;

  if (isInNav(el)) { skippedNav++; continue; }

  const t = safeText(el.textContent);
  if (!t) continue;

  const isHeading =
    /^h[1-6]$/.test(tag) || el.getAttribute("role") === "heading";

  if (isHeading) {
    if (/^Sura\b/i.test(t)) {
      currentSura = t;
      suraHeadingCount++;
    }
    continue;
  }

  // Do NOT drop verses just because they contain links; only skip if it's mostly-links (TOC-like)
  if (hasLink(el)) { skippedLink++; continue; }

  if (!verseRe.test(t)) { skippedRegex++; continue; }

  kept++;

  const id = safeText((el as HTMLElement).id);
  out.push({
    text: t,
    fragment: id ? `#${id}` : undefined,
    suraLine: currentSura,
  });
}

  
    if (DEBUG_DQ) {
      console.log("[DailyQuote] extractVerseCandidates:", {
        totalNodes: nodes.length,
        suraHeadingCount,
        candidates: out.length,
        firstCandidate: out[0]?.text?.slice(0, 120) ?? null,
        firstCandidateSura: out[0]?.suraLine ?? null,
      });
    }
  
    // Fallback if no paragraph candidates matched
    if (!out.length) {
  const raw = String((doc.body ?? doc.documentElement)?.textContent ?? "");

  // Pull verse-like lines directly (even if the chapter has only single newlines or no <p>)
  const lines: string[] = [];
  const reA = /^\s*\d{1,4}(?:[.)]\s+|\s+)\S.*$/gm;      // 10. ...  or 10) ... or 10 ...
  const reB = /^\s*\d{1,3}\s*:\s*\d{1,3}\b.*$/gm;      // 2:255 ...

  for (const m of raw.matchAll(reA)) {
    const s = safeText(m[0]);
    if (s) lines.push(s);
  }
  for (const m of raw.matchAll(reB)) {
    const s = safeText(m[0]);
    if (s) lines.push(s);
  }

  // de-dupe while preserving order
  const seen = new Set<string>();
  for (const s of lines) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push({ text: s }); // no fragment/sura context in this fallback
  }

  if (DEBUG_DQ) {
    console.warn("[DailyQuote] fallback-to-text regex used:", {
      candidates: out.length,
      sample: out[0]?.text?.slice(0, 120) ?? null,
    });
  }
}
console.log("[DailyQuote] PL stats:", { totalPL, skippedNav, skippedLink, skippedRegex, kept });

  
    return out;
  }

  function extractSentenceCandidates(doc: Document): VerseCandidate[] {
    const out: VerseCandidate[] = [];

    const isInNav = (el: Element) =>
      Boolean(el.closest("nav,[epub\\:type='toc'],[role='doc-toc'],[role='navigation']"));

    const isMostlyLinks = (el: Element) => {
      const links = el.querySelectorAll("a[href]");
      if (!links.length) return el.tagName.toLowerCase() === "a";

      const fullText = safeText(el.textContent);
      const fullLen = fullText.length;

      let linkLen = 0;
      links.forEach((a) => {
        linkLen += safeText(a.textContent).length;
      });

      return fullLen > 0 && linkLen >= Math.max(10, 0.6 * fullLen);
    };

    const splitSentences = (raw: string) => {
      const clean = safeText(raw).replace(/\s+/g, " ").trim();
      if (!clean) return [];
      // sentence-ish chunks ending in . ! ? (keeps last chunk if no punctuation)
      const parts = clean.match(/[^.!?]+[.!?]+(?:["”’']?)(?=\s|$)|[^.!?]+$/g) ?? [];
      return parts
        .map((s) => safeText(s))
        .filter((s) => s.length >= 40); // drop tiny fragments
    };

    const pushFromElement = (el: Element) => {
      if (isInNav(el)) return;
      if (isMostlyLinks(el)) return;

      const t = safeText(el.textContent);
      if (!t) return;

      const id = safeText((el as HTMLElement).id);
      const frag = id ? `#${id}` : undefined;

      for (const s of splitSentences(t)) {
        // avoid extremely short/long “sentences”
        if (s.length < 50) continue;
        if (s.length > 260) continue;
        out.push({ text: s, fragment: frag });
      }
    };

    for (const el of Array.from(doc.querySelectorAll("p,li,blockquote"))) {
      pushFromElement(el);
      if (out.length > 5000) break; // safety cap
    }

    // fallback: whole-document text
    if (!out.length) {
      const raw = String((doc.body ?? doc.documentElement)?.textContent ?? "");
      for (const s of splitSentences(raw)) {
        if (s.length < 50) continue;
        if (s.length > 260) continue;
        out.push({ text: s });
      }
    }

    return out;
  }



  
  function formatQuranCitation(author: string, title: string): string {
    const a = safeText(author);
    const t = safeText(title);
    return a ? `Translated by ${a}. ${t}.` : `${t}.`;
  }
  
  function formatNonQuranCitation(author: string, title: string): string {
    const a = safeText(author);
    const t = safeText(title);
    return a ? `${a}. ${t}.` : `${t}.`;
  }
  
  async function generateDailyQuote(meta: BookMeta, forceNew: boolean): Promise<DailyQuote> {

  // async function generateDailyQuote(meta: BookMeta, forceNew: boolean) {
    const iso = todayISO();
    const k = cacheKey(meta.id);
  
    if (!forceNew) {
      const cached = localStorage.getItem(k);
      if (cached) {
        const parsed = JSON.parse(cached) as DailyQuote;
        if (parsed?.dateISO === iso) {
          quote.value = parsed;
          if (DEBUG_DQ) console.log("[DailyQuote] loaded from cache", { bookId: meta.id, iso });
          return parsed;
        }
      }
    }
  
    const blob = await loadBookFile(meta.id);
    if (!blob) throw new Error("Book file not found.");
  
    const ab = await blob.arrayBuffer();
    const book = ePub(ab);
    await book.ready;
    if (DEBUG_DQ) console.log("[DailyQuote] book.ready OK");
  
    // Remove scripts
    book.spine.hooks.serialize.register((output: string) =>
      output.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    );
  
    const md = await book.loaded.metadata;
    const title = safeText(md?.title) || meta.title || "Untitled";
    const author = safeText(md?.creator) || meta.author || "";
    // const authorIsTaner = safeText(author).toLowerCase() === "taner";

  
    // Profile detection sample
    let sampleText = "";
    try {
      const first = (book.spine?.items?.[0] as SpineItemLike | undefined)?.href;
      if (first) {
        const raw = await book.load(first);
        const doc = toDocument(raw);
        sampleText = safeText(doc.body?.textContent ?? "").slice(0, 6000);
      }
    } catch {
      // ignore
    }
    const detected = detectProfileFromMetadata(title, author, sampleText);
    let looksQuranFromHtml = false;

    // Trust meta.profile if set; otherwise infer Quran from HTML if we detect Sura headings
    // const effectiveProfile: BookProfile =
    // meta.profile === "quran" ? "quran" : (looksQuranFromHtml ? "quran" : detected);

    // const quranByMeta = meta.profile === "quran" || detected === "quran";
    const quranByMeta = meta.profile === "quran" || detected === "quran";
    // || authorIsTaner;

    if (DEBUG_DQ) console.log("[DailyQuote] profiles (pre-scan):", {
      metaProfile: meta.profile,
      detectedProfile: detected,
      looksQuranFromHtml,
      quranByMeta,
    });


    // if (DEBUG_DQ) console.log("[DailyQuote] profiles:", {
    // metaProfile: meta.profile,
    // detectedProfile: detected,
    // looksQuranFromHtml,
    
    // });


    // if (DEBUG_DQ) console.log("[DailyQuote] profile:", { title, author, profile });
  
    // const spineItems = (book.spine?.items ?? []) as SpineItemLike[];
  
    // // Structural spine filtering (no punctuation heuristics)
    // const items = spineItems
    //   .filter((it) => typeof it.href === "string" && it.href.length > 0)
    //   .filter((it) => {
    //     const href = String(it.href).toLowerCase();
    //     const propsRaw = it.properties;
    //     const props = Array.isArray(propsRaw) ? propsRaw.join(" ") : String(propsRaw ?? "");
  
    //     if (/\bnav\b/i.test(props)) return false;
    //     if (String(it.linear ?? "").toLowerCase() === "no") return false;
  
    //     if (/(^|\/)(nav|toc|contents?|content|title|cover)([-_]\w+)?\.x?html?$/.test(href)) return false;
    //     return true;
    //   });
  
    // if (!items.length) throw new Error("No readable spine items found.");

    const spineItems = (book.spine?.items ?? []) as SpineItemLike[];

    // Structural spine filtering (robust to #fragments and ?queries)
    const itemsAll = spineItems
    .filter((it) => typeof it.href === "string" && it.href.length > 0)
    .filter((it) => {
        const hrefRaw = String(it.href);
        const hrefLower = hrefRaw.toLowerCase();

        // IMPORTANT: strip fragments + queries before filename tests
        const hrefPath = hrefLower.split("#")[0]!.split("?")[0]!;
        const base = hrefPath.split("/").pop() || hrefPath;

        const propsRaw = it.properties;
        const props = Array.isArray(propsRaw) ? propsRaw.join(" ") : String(propsRaw ?? "");

        // epub nav item
        if (/\bnav\b/i.test(props)) return false;

        // non-linear spine items
        if (String(it.linear ?? "").toLowerCase() === "no") return false;

        // block obvious non-content files
        if (/(^|\/)(nav|toc|contents?|content|title|cover)([-_]\w+)?\.x?html?$/.test(hrefPath)) return false;

        // extra hardening: if basename is nav/toc even with odd paths
        if (/^(nav|toc|contents?|content|title|cover)([-_]\w+)?\.x?html?$/.test(base)) return false;

        return true;
    });

    // FORCE: only pick from ch004.xhtml (never TOC/nav/index/ch005/etc.)
// working code below
//     const targetOnly = itemsAll.filter((it) => {
//   const hrefPath = String(it.href).toLowerCase().split("#")[0]!.split("?")[0]!;
//   const base = hrefPath.split("/").pop() || hrefPath;

//   // accept ch004.xhtml or ch004.html
//   return base === "ch004.xhtml" || base === "ch004.html";
// });

// const items = targetOnly;

// if (!items.length) throw new Error("Target chapter not found in spine: ch004.xhtml");

const chapterOnly = itemsAll.filter((it) => {
  const hrefPath = String(it.href).toLowerCase().split("#")[0]!.split("?")[0]!;
  const base = hrefPath.split("/").pop() || hrefPath;
  return /^ch\d{3}\.x?html?$/.test(base);
});

const targetOnly = itemsAll.filter((it) => {
  const hrefPath = String(it.href).toLowerCase().split("#")[0]!.split("?")[0]!;
  const base = hrefPath.split("/").pop() || hrefPath;
  return base === "ch004.xhtml" || base === "ch004.html";
});

// Lock ONLY when Quran AND author is exactly "Taner" (case-insensitive)
// const authorIsTaner = safeText(author).toLowerCase() === "taner";
// const isQuranBook = meta.profile === "quran" || detected === "quran";
// const lockToCh004 = quranByMeta && authorIsTaner;

// const items = lockToCh004
//   ? targetOnly
//   : (chapterOnly.length ? chapterOnly : itemsAll);

// if (!items.length) throw new Error("No readable spine items found.");
// if (lockToCh004 && !targetOnly.length) {
//   throw new Error('Shaykh Taner - The Quran detected, but appropriate file not found in spine.');
// }


//     const chapterOnly = itemsAll.filter((it) => {
//   const hrefPath = String(it.href).toLowerCase().split("#")[0]!.split("?")[0]!;
//   const base = hrefPath.split("/").pop() || hrefPath;
//   return /^ch\d{3}\.x?html?$/.test(base);
// });

// // Use chapter-only if available; otherwise fall back to itemsAll
// const items = chapterOnly.length ? chapterOnly : itemsAll;

// Lock to ch004.xhtml ONLY when ch004 itself looks like Quran content
let lockToCh004 = false;

if (targetOnly.length) {
  try {
    const href0 = String(targetOnly[0]!.href);
    const raw0 = await book.load(href0);
    const doc0 = toDocument(raw0);

    const v0 = extractVerseCandidates(doc0);
    const heading0 = safeText(doc0.querySelector("h1,h2,h3,h4,h5,h6")?.textContent);

    // Quran signal: Sura headings OR verse candidates that captured a suraLine
    const hasSuraSignal =
      /^Sura\b/i.test(heading0) || v0.some((c) => !!safeText(c.suraLine));

    // Your ch004 has tons of verses; use a threshold so other books with ch004 won't lock.
    lockToCh004 = hasSuraSignal && v0.length >= 50;

    if (lockToCh004) {
      looksQuranFromHtml = true; // ensures verse rule downstream
    }

    if (DEBUG_DQ) {
      console.log("[DailyQuote] ch004 verification:", {
        href: href0,
        verseCandidates: v0.length,
        hasSuraSignal,
        lockToCh004,
      });
    }
  } catch (e: unknown) {
    if (DEBUG_DQ) console.warn("[DailyQuote] ch004 verification failed", e);
  }
}

const items = lockToCh004
  ? targetOnly
  : (chapterOnly.length ? chapterOnly : itemsAll);

if (!items.length) throw new Error("No readable spine items found.");


    

    // deterministic per-day unless forceNew; forceNew bypasses cache AND changes seed
    const seed = forceNew ? `${meta.id}::${iso}::${Date.now()}` : `${meta.id}::${iso}`;
    const rng = mulberry32(seedFromString(seed));
  
    let chosenText = "";
    let chosenHref = "";
    let chosenSuraFromDoc: string | undefined;


  
    const maxAttempts = Math.min(25, items.length);
    
for (let attempt = 0; attempt < maxAttempts; attempt++) {
  const idx = Math.floor(rng() * items.length);
  const item = items[idx];
  const href = item?.href ? String(item.href) : "";
  if (!href) continue;

  if (DEBUG_DQ) console.log("[DailyQuote] try spine href:", { attempt: attempt + 1, href });

  try {
    const raw = await book.load(href);
    const doc = toDocument(raw);

    // const candidates = extractVerseCandidates(doc);
    // if (!candidates.length) continue;

    // // Quran detection hint from actual content
    // if (!looksQuranFromHtml) {
    //   const headingText = safeText(doc.querySelector("h1,h2,h3,h4,h5,h6")?.textContent);
    //   if (/^Sura\b/i.test(headingText)) looksQuranFromHtml = true;
    //   if (candidates.some((c) => !!safeText(c.suraLine))) looksQuranFromHtml = true;
    // }

        // Detect Quran from content headings before choosing extraction strategy
    //     if (!looksQuranFromHtml) {
    //   const headingText = safeText(doc.querySelector("h1,h2,h3,h4,h5,h6")?.textContent);
    //   if (/^Sura\b/i.test(headingText)) looksQuranFromHtml = true;
    // }

    const headingText = safeText(doc.querySelector("h1,h2,h3,h4,h5,h6")?.textContent);

// Always compute verse candidates (cheap + needed to detect Quran reliably)
const verseCandidates = extractVerseCandidates(doc);

// Update Quran-likeness from actual HTML
if (!looksQuranFromHtml) {
  if (/^Sura\b/i.test(headingText)) looksQuranFromHtml = true;
  if (verseCandidates.some((c) => !!safeText(c.suraLine))) looksQuranFromHtml = true;
}

// CRITICAL: if Quran-by-meta OR Quran-by-html -> USE verse rule (never sentences)
const useVerseRule = quranByMeta || looksQuranFromHtml;

const candidates = useVerseRule
  ? verseCandidates
  : extractSentenceCandidates(doc);

if (!candidates.length) continue;


    // const treatAsQuran =
      // meta.profile === "quran" || detected === "quran" || looksQuranFromHtml;

    // const candidates = treatAsQuran
    //   ? extractVerseCandidates(doc)
    //   : extractSentenceCandidates(doc);

    // if (!candidates.length) continue;

    // if (treatAsQuran && !looksQuranFromHtml) {
    //   if (candidates.some((c) => !!safeText(c.suraLine))) looksQuranFromHtml = true;
    // }


    const pickIdx = Math.floor(rng() * candidates.length);
    const pick = candidates[pickIdx];
    if (!pick) continue;

    chosenText = pick.text;
    chosenHref = href + (pick.fragment ?? "");
    chosenSuraFromDoc = safeText(pick.suraLine) || undefined;

    if (DEBUG_DQ) {
      console.log("[DailyQuote] PICKED:", {
        chosenHref,
        textPreview: safeText(chosenText).slice(0, 90),
        suraFromDoc: chosenSuraFromDoc ?? null,
      });
    }

    break;
  } catch (e: unknown) {
    if (DEBUG_DQ) console.warn("[DailyQuote] book.load failed for href", { href, err: e instanceof Error ? e.message : e });
    continue;
  }
}

  // const idx = Math.floor(rng() * items.length);

//   const item = items[0]!;
// const href = item?.href ? String(item.href) : "";
// if (!href) throw new Error("Target chapter href missing: ch004.xhtml");

// if (DEBUG_DQ) console.log("[DailyQuote] try spine href:", { attempt: 1, href });

// const raw = await book.load(href);
// const doc = toDocument(raw);

// const candidates = extractVerseCandidates(doc);
// if (!candidates.length) throw new Error("No verse-like paragraphs found in ch004.xhtml.");

// if (!looksQuranFromHtml) {
//   const headingText = safeText(doc.querySelector("h1,h2,h3,h4,h5,h6")?.textContent);
//   if (/^Sura\b/i.test(headingText)) looksQuranFromHtml = true;
//   if (candidates.some((c) => !!safeText(c.suraLine))) looksQuranFromHtml = true;
// }

// const pickIdx = Math.floor(rng() * candidates.length);
// const pick = candidates[pickIdx]!;
// chosenText = pick.text;
// chosenHref = href + (pick.fragment ?? "");
// chosenSuraFromDoc = safeText(pick.suraLine) || undefined;

// //   const item = items[idx];

// //       const href = item?.href ? String(item.href) : "";
// //       if (!href) continue;
  
// //       if (DEBUG_DQ) console.log("[DailyQuote] try spine href:", { attempt: attempt + 1, href });
  
// //       try {
// //         const raw = await book.load(href);
// //         const doc = toDocument(raw);
  
// //         const candidates = extractVerseCandidates(doc);
// //         if (!candidates.length) continue;

// //         // If this XHTML contains many "Sura ..." headings, it is Quran-like even if metadata detection fails
// // // (we count by checking whether any candidate captured a suraLine, or the doc contains "Sura" headings)
// //         if (!looksQuranFromHtml) {
// //         const headingText = safeText(doc.querySelector("h1,h2,h3,h4,h5,h6")?.textContent);
// //         if (/^Sura\b/i.test(headingText)) looksQuranFromHtml = true;
// //         // also: if any candidate already has a suraLine, it’s definitely Quran-like
// //         if (candidates.some((c) => !!safeText(c.suraLine))) looksQuranFromHtml = true;
// //         }

  
// //         const pickIdx = Math.floor(rng() * candidates.length);
// //         const pick = candidates[pickIdx];
// //         if (!pick) continue;
  
// //         chosenText = pick.text;
// //         chosenHref = href + (pick.fragment ?? "");
// //         chosenSuraFromDoc = safeText(pick.suraLine) || undefined;
  
//         if (DEBUG_DQ) {
//           console.log("[DailyQuote] PICKED:", {
//             chosenHref,
//             textPreview: chosenText.slice(0, 140),
//             suraFromDoc: chosenSuraFromDoc ?? null,
//           });
//         }
  
//         break;
      // } catch (e: unknown) {
      //   if (DEBUG_DQ) console.warn("[DailyQuote] book.load failed for href", { href, err: e instanceof Error ? e.message : e });
      //   continue;
      // }
    // }

    const effectiveProfile: BookProfile =
    (quranByMeta || looksQuranFromHtml) ? "quran" : detected;

      // (meta.profile === "quran" || detected === "quran" || looksQuranFromHtml) ? "quran" : detected;

    if (DEBUG_DQ) console.log("[DailyQuote] profiles (final):", {
      metaProfile: meta.profile,
      detectedProfile: detected,
      looksQuranFromHtml,
      effectiveProfile,
    });

    if (!chosenText) {
      if (effectiveProfile === "quran") {
        throw new Error("No verse-like paragraphs found.");
      }
      throw new Error("No sentence candidates found in this book.");
    }

    // if (!chosenText) {
    //   throw new Error("No verse-like paragraphs found.");
    // }
    // const effectiveProfile: BookProfile =
  // meta.profile === "quran" || looksQuranFromHtml ? "quran" : detected;
  // const effectiveProfile: BookProfile =
  // (meta.profile === "quran" || looksQuranFromHtml || detected === "quran") ? "quran" : detected;

  
    // Quran: Sura line must be between quote + citation.
    // We derive it from chapter HTML headings above the verse (no TOC needed).
    // const suraLine = profile === "quran" ? chosenSuraFromDoc : undefined;
    const suraLine = effectiveProfile === "quran" ? chosenSuraFromDoc : undefined;

  
    // const citation =
    //   profile === "quran" ? formatQuranCitation(author, title) : formatNonQuranCitation(author, title);
      const citation =
  effectiveProfile === "quran" ? formatQuranCitation(author, title) : formatNonQuranCitation(author, title);

  
    const q: DailyQuote = {
      dateISO: iso,
      bookId: meta.id,
      bookTitle: title,
      profile: effectiveProfile,
      text: safeText(chosenText),
      citation,
      suraLine,
    };
  
    localStorage.setItem(k, JSON.stringify(q));
    quote.value = q;
  
    if (DEBUG_DQ) console.log("[DailyQuote] saved:", { iso, bookId: meta.id, chosenHref, suraLine: suraLine ?? null });
    return q;
  }

  async function init(forceNew: boolean) {
  loading.value = true;
  error.value = "";
  quote.value = null;

  const all = await loadBooks();
  books.value = all;

  if (!all.length) {
    loading.value = false;
    return;
  }

  // const stored = safeText(localStorage.getItem(DQ_SELECTED_BOOK_KEY));
  // let chosenId = selectedBookId.value || stored;

  // if (!chosenId || !all.some((b) => b.id === chosenId)) {
  //   const preferred = all.find((b) => b.profile === "quran") ?? all[0]!;
  //   chosenId = preferred.id;
  // }

  // selectedBookId.value = chosenId;
  // localStorage.setItem(DQ_SELECTED_BOOK_KEY, chosenId);

  // const chosen = all.find((b) => b.id === chosenId) ?? all[0]!;
  // try {
  //   await generateDailyQuote(chosen, forceNew);
  // } catch (e: unknown) {
  //   error.value = e instanceof Error ? e.message : "Failed to generate daily quote.";
  // } finally {
  //   loading.value = false;
  // }

  const stored = safeText(localStorage.getItem(DQ_SELECTED_BOOK_KEY));
let chosenId = selectedBookId.value || stored;

// Validate selection (Random is allowed even though it's not a real book id)
if (
  !chosenId ||
  (chosenId !== RANDOM_BOOK_ID && !all.some((b) => b.id === chosenId))
) {
  const preferred = all.find((b) => b.profile === "quran") ?? all[0]!;
  chosenId = preferred.id;
}

selectedBookId.value = chosenId;
localStorage.setItem(DQ_SELECTED_BOOK_KEY, chosenId);

try {
  if (chosenId === RANDOM_BOOK_ID) {
    const iso = todayISO();
    const rk = cacheKey(RANDOM_BOOK_ID);

    // If we already picked a random-book quote today, reuse it (unless forceNew)
    if (!forceNew) {
      const cached = localStorage.getItem(rk);
      if (cached) {
        const parsed = JSON.parse(cached) as DailyQuote;
        if (parsed?.dateISO === iso) {
          quote.value = parsed;
          loading.value = false;
          return;
        }
      }
    }

    // Deterministic “random book” per day; forceNew makes it truly new
    const ids = all.map((b) => b.id).slice().sort().join(",");
    const seed = forceNew ? `${iso}::${Date.now()}::${ids}` : `${iso}::${ids}`;
    const rng = mulberry32(seedFromString(seed));
    const pickIdx = Math.floor(rng() * all.length);
    const picked = all[pickIdx] ?? all[0]!;

    const q = await generateDailyQuote(picked, forceNew);
    localStorage.setItem(rk, JSON.stringify(q));
  } else {
    const chosen = all.find((b) => b.id === chosenId) ?? all[0]!;
    await generateDailyQuote(chosen, forceNew);
  }
} catch (e: unknown) {
  error.value = e instanceof Error ? e.message : "Failed to generate daily quote.";
} finally {
  loading.value = false;
}


}

  
  // async function init(forceNew: boolean) {
  //   loading.value = true;
  //   error.value = "";
  //   quote.value = null;
  
  //   const books = await loadBooks();
  //   if (!books.length) {
  //     loading.value = false;
  //     return;
  //   }
  
  //   // Prefer Quran profile if available
  //   const preferred = books.find((b) => b.profile === "quran") ?? books[0]!;
  //   try {
  //     await generateDailyQuote(preferred, forceNew);
  //   } catch (e: unknown) {
  //     error.value = e instanceof Error ? e.message : "Failed to generate daily quote.";
  //   } finally {
  //     loading.value = false;
  //   }
  // }
  
  async function copyQuote() {
    if (!quote.value) return;
  
    const isQuran = quote.value.profile === "quran";
    const sura = safeText(quote.value.suraLine);
  
    const s =
      isQuran && sura
        ? `“${quote.value.text}”\n${sura}\n\n— ${quote.value.citation}`
        : `“${quote.value.text}”\n\n— ${quote.value.citation}`;
  
    await navigator.clipboard.writeText(s);
    
  }
  
  async function onBookChange() {
  const id = safeText(selectedBookId.value);
  if (!id) return;
  localStorage.setItem(DQ_SELECTED_BOOK_KEY, id);
  await init(false);
}


  async function refreshQuote() {
    // MUST bypass cache
    await init(true);
  }
  
  onMounted(() => {
    init(false);
  });

  
  </script>
  