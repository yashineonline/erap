<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from "vue";
import { useRouter } from "vue-router";
import ePub from "epubjs";

import Modal from "../components/Modal.vue";

import type { BookMeta, BookProfile, ReaderPrefs } from "../lib/types";
import {
  DEFAULT_PREFS,
  loadBooks,
  saveBooks,
  loadBookFile,
  loadPrefs,
  savePrefs,
} from "../lib/storage";
import { isNoterefAnchor } from "../lib/glossary";
import { defineWordFallback } from "../lib/dictionary";
import { detectProfileFromMetadata } from "../lib/profiles";
import { buildQuoteText } from "../lib/quote";
import { ensureIndex, search as doSearch } from "../lib/search";
import { startSession, endSession, totals } from "../lib/analytics";
import { safeText } from "../lib/epub";

// --------------------
// props + router
// --------------------
const props = defineProps<{ id: string }>();
const router = useRouter();

// --------------------
// UI state
// --------------------
const viewer = ref<HTMLDivElement | null>(null);
const chrome = ref(true);
const topChromeEl = ref<HTMLElement | null>(null);
const bottomChromeEl = ref<HTMLElement | null>(null);
const topPadPx = ref(0);
const bottomPadPx = ref(0);
const iframeBottomPadPx = ref(24);

const viewerPadStyle = computed(() => ({
  paddingTop: chrome.value ? `${topPadPx.value}px` : "0px",
  paddingBottom: chrome.value ? `${bottomPadPx.value}px` : "0px",
}));

// modals
const modalOpen = ref(false);
const modalTitle = ref("");
const modalHtml = ref<string>("");
const modalLoading = ref(false);
const modalBaseHref = ref<string | null>(null);

const tocOpen = ref(false);

const searchOpen = ref(false);
const searchInputEl = ref<HTMLInputElement | null>(null);

function openModal(title: string, html: string) {
  modalTitle.value = title;
  modalHtml.value = html;
  modalOpen.value = true;
}
function closeModal() {
  modalOpen.value = false;
}

function openSearchModal() {
  searchOpen.value = true;
  nextTick(() => searchInputEl.value?.focus());
}
function closeSearchModal() {
  searchOpen.value = false;
}

function openToc() {
  tocOpen.value = true;
}
function closeToc() {
  tocOpen.value = false;
}

// --------------------
// book + reader state
// --------------------
const prefs = ref<ReaderPrefs>(DEFAULT_PREFS);
const bookMeta = ref<BookMeta | null>(null);
const profile = ref<BookProfile>("default");

// ------------------------------------------------------------------
// v2 features stored in prefs, but accessed via typed wrappers.
// This prevents type-checking errors if your local ReaderPrefs type
// hasn't been updated yet (fields missing).
// ------------------------------------------------------------------
const realBookFeel = computed<boolean>({
  get: () => Boolean((prefs.value as any)?.realBookFeel ?? false),
  set: (v) => {
    (prefs.value as any).realBookFeel = v;
    void savePrefsNow();
  },
});

const readAloud = computed<boolean>({
  get: () => Boolean((prefs.value as any)?.readAloud ?? false),
  set: (v) => {
    (prefs.value as any).readAloud = v;
    if (!v) stopReadAloud();
    void savePrefsNow();
  },
});

const ttsRate = computed<number>({
  get: () => Number((prefs.value as any)?.ttsRate ?? 1.0),
  set: (v) => {
    (prefs.value as any).ttsRate = v;
    void savePrefsNow();
  },
});

const ttsVoiceURI = computed<string>({
  get: () => String((prefs.value as any)?.ttsVoiceURI ?? ""),
  set: (v) => {
    (prefs.value as any).ttsVoiceURI = v;
    void savePrefsNow();
  },
});

let book: any = null;
let rendition: any = null;
let sessionId: string | null = null;

// --------------------
// helpers
// --------------------
function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c] as string));
}


function normalizePath(p: string) {
  const cleaned = (p || "")
    .replace(/\\/g, "/")
    .replace(/\/+/, "/")
    .replace(/^\/+/, "");
  const parts: string[] = [];
  for (const seg of cleaned.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function safeDecodeURIComponent(s?: string | null): string {
  const v = s ?? "";
  try {
    return decodeURIComponent(v);
  } catch {
    return v; // return raw if malformed
  }
}

function canonHref(href?: string | null) {
  return normalizePath(safeDecodeURIComponent(href).replace(/#.*$/, ""));
}



function cssEscapeId(id: string) {
  const CSS_ = (window as any).CSS;
  if (CSS_?.escape) return CSS_.escape(id);
  return id.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
}

function parseXhtml(raw: any): Document {
  if (raw && typeof raw === "object" && (raw as any).nodeType === 9) return raw as Document;
  const s = typeof raw === "string" ? raw : String(raw ?? "");
  let d = new DOMParser().parseFromString(s, "application/xhtml+xml");
  if (d.getElementsByTagName("parsererror").length) {
    d = new DOMParser().parseFromString(s, "text/html");
  }
  return d;
}

function findById(doc: Document, id: string) {
  return (doc.getElementById(id) as HTMLElement | null) ??
    (doc.querySelector(`#${cssEscapeId(id)}`) as HTMLElement | null) ??
    null;
}

function idKeys(id: string) {
  const base = decodeURIComponent(id || "").replace(/^#/, "").trim();
  const noFn = base.replace(/^fn-/, "");
  const variants = new Set<string>([
    base,
    noFn,
    `fn-${noFn}`,
    base.replace(/_/g, "-"),
    base.replace(/-/g, "_"),
    noFn.replace(/_/g, "-"),
    noFn.replace(/-/g, "_"),
    `fn-${noFn.replace(/_/g, "-")}`,
    `fn-${noFn.replace(/-/g, "_")}`,
  ]);
  for (const v of Array.from(variants)) variants.add(v.toLowerCase());
  return [...variants].filter(Boolean);
}

async function updateMetaPatch(patch: Partial<Omit<BookMeta, "id" | "addedAt">>) {
  const books = await loadBooks();
  const i = books.findIndex((b) => b.id === props.id);
  if (i < 0) return;
  const current = books[i];
  if (!current) return;
  books[i] = { ...current, ...patch };
  await saveBooks(books);
  bookMeta.value = books[i] ?? null;
}

// --------------------
// padding + theme
// --------------------
async function updateViewerPads() {
  await nextTick();
  const topH = chrome.value && topChromeEl.value ? topChromeEl.value.offsetHeight : 0;
  const botH = chrome.value && bottomChromeEl.value ? bottomChromeEl.value.offsetHeight : 0;
  topPadPx.value = topH;
  bottomPadPx.value = botH;
  iframeBottomPadPx.value = Math.max(24, botH + 24);
  applyTheme();
}

watch(chrome, updateViewerPads);

onMounted(() => {
  updateViewerPads();
  window.addEventListener("resize", updateViewerPads);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", updateViewerPads);
});

function applyTheme() {
  if (!rendition) return;

  const noterefDeco = prefs.value.noterefUnderline ? "underline" : "none";

  rendition.themes.register("user", {
    body: {
      background: prefs.value.bg,
      color: prefs.value.fg,
      "font-family": prefs.value.font,
      "line-height": String(prefs.value.lineHeight),
      margin: `${prefs.value.marginEm}em`,
      "text-align": `${prefs.value.textAlign} !important`,
      "padding-bottom": `${iframeBottomPadPx.value}px`,
    },
    p: { "text-align": `${prefs.value.textAlign} !important` },

    // only style glossary/noteref links
    "a.noteref, a[role='doc-noteref'], a[rel~='footnote'], a[epub\\:type~='noteref']": {
      color: prefs.value.noterefColor,
      "text-decoration": `${noterefDeco} !important`,
    },

    // v2: search highlight
    ".reader-search-hit": {
      "background": "rgba(250, 204, 21, 0.45)",
      "border-radius": "0.15em",
      "padding": "0 0.08em",
    },
  });

  rendition.themes.select("user");
  rendition.themes.fontSize(`${prefs.value.fontSizePct}%`);
}

async function savePrefsNow() {
  await savePrefs(props.id, prefs.value);
  applyTheme();
}

watch(
  prefs,
  async () => {
    await savePrefs(props.id, prefs.value);
    applyTheme();
  },
  { deep: true }
);

// --------------------
// TOC
// --------------------
type TocItem = { href: string; label: string; subitems?: TocItem[] };
const tocItems = ref<TocItem[]>([]);

type TocFlat = { href: string; label: string; depth: number };
const tocFlat = computed<TocFlat[]>(() => {
  const out: TocFlat[] = [];
  const walk = (items: TocItem[] | undefined, depth: number) => {
    for (const it of items ?? []) {
      if (it?.href) out.push({ href: it.href, label: it.label || it.href, depth });
      if (it?.subitems?.length) walk(it.subitems, depth + 1);
    }
  };
  walk(tocItems.value, 0);
  return out;
});

async function goToc(item: { href: string }) {
  closeToc();
  chrome.value = true;
  await jump(item.href);
}

// keyboard
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    chrome.value = true;
    tocOpen.value = false;
    searchOpen.value = false;
    modalOpen.value = false;
  }
  if ((e.key === "t" || e.key === "T") && chrome.value) {
    tocOpen.value = !tocOpen.value;
  }
}

// --------------------
// navigation
// --------------------
const lastChromeToggleAt = ref(0);

async function back() {
  if (sessionId) await endSession(props.id, sessionId);
  router.push("/");
}

async function jump(href: string) {
  closeModal();
  chrome.value = true;
  await rendition?.display?.(href);
}

const pageAnim = ref<"next" | "prev" | null>(null);

async function turnNext() {
  if (!rendition) return;
  pageAnim.value = realBookFeel.value ? "next" : null;
  try {
    await rendition.next();
  } finally {
    if (pageAnim.value) window.setTimeout(() => (pageAnim.value = null), 220);
  }
}

async function turnPrev() {
  if (!rendition) return;
  pageAnim.value = realBookFeel.value ? "prev" : null;
  try {
    await rendition.prev();
  } finally {
    if (pageAnim.value) window.setTimeout(() => (pageAnim.value = null), 220);
  }
}

// --------------------
// search (v2)
// --------------------
const indexing = ref(false);
const idxReady = ref(false);
const indexDone = ref(0);
const indexTotal = ref(0);
const indexFromCache = ref(false);

const q = ref("");

type SearchChapterHit = { hrefKey: string; hrefCanon: string; snippet: string; count: number };
const results = ref<SearchChapterHit[]>([]);

let idx: any = null;
const hrefText = ref<Record<string, string>>({});
const canonToKey = ref<Record<string, string>>({});
const spineOrderCanon = ref<string[]>([]);

const hasIframeSelection = ref(false);

const hitCountByHref = computed(() => {
  const m = new Map<string, number>();
  for (const r of results.value) {
    if (r.hrefCanon) m.set(r.hrefCanon, r.count || 0);
  }
  return m;
});

const hitHrefsOrdered = computed(() => {
  const counts = hitCountByHref.value;
  const keys = new Set(Object.keys(hrefText.value).map(canonHref));
  const order = spineOrderCanon.value.length ? spineOrderCanon.value : [...keys];
  return order.filter((h) => h && keys.has(h) && counts.has(h));
});

const hitTotal = computed(() => {
  const counts = hitCountByHref.value;
  return hitHrefsOrdered.value.reduce((a, h) => a + (counts.get(h) ?? 0), 0);
});

function locateGlobalMatch(globalIndex: number) {
  const counts = hitCountByHref.value;
  const hrefs = hitHrefsOrdered.value;

  let cum = 0;
  for (const h of hrefs) {
    const c = counts.get(h) ?? 0;
    if (globalIndex < cum + c) return { hrefCanon: h, occ: globalIndex - cum };
    cum += c;
  }
  return { hrefCanon: hrefs[0]!, occ: 0 };
}

function currentHrefCanon() {
  return canonHref(String(rendition?.location?.start?.href || ""));
}

function contentsForCanon(hrefCanon: string) {
  const arr = (rendition?.getContents?.() ?? []) as any[];
  return (
    arr.find((c) => canonHref(String(c?.section?.href || c?.href || "")) === hrefCanon) ?? arr[0]
  );
}

function clearHighlights(doc: Document) {
  const nodes = Array.from(doc.querySelectorAll("span.reader-search-hit")) as HTMLElement[];
  for (const el of nodes) {
    const parent = el.parentNode;
    if (!parent) continue;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    (parent as HTMLElement).normalize?.();
  }
}

function highlightRange(doc: Document, range: Range) {
  clearHighlights(doc);
  const span = doc.createElement("span");
  span.className = "reader-search-hit";
  try {
    range.surroundContents(span);
  } catch {
    // ignore highlight failures
  }
}

function findRangeForQuery(doc: Document, query: string, occurrence: number) {
  const needle = query.trim();
  if (!needle) return { range: null as Range | null, total: 0 };

  const qLower = needle.toLowerCase();

  const isSkippable = (t: Text) => {
    const el = t.parentElement;
    if (!el) return false;
    return !!el.closest(
      "nav, aside, [role='doc-footnote'], [epub\\:type~='footnote'], .footnote, .endnote, #inline-footnotes, script, style"
    );
  };

  let total = 0;
  let chosen: Range | null = null;
  let last: Range | null = null;

  // 4 = NodeFilter.SHOW_TEXT (avoid NodeFilter typing issues)
  const walker = doc.createTreeWalker(doc.body, 4);
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    if (!t.data || !t.data.trim()) continue;
    if (isSkippable(t)) continue;

    const s = t.data;
    const sLower = s.toLowerCase();

    let from = 0;
    while (true) {
      const i = sLower.indexOf(qLower, from);
      if (i < 0) break;

      const r = doc.createRange();
      r.setStart(t, i);
      r.setEnd(t, i + needle.length);

      if (total === occurrence) chosen = r;
      last = r;
      total++;
      from = i + Math.max(1, qLower.length);
    }
  }

  if (!total) return { range: null as Range | null, total: 0 };
  return { range: chosen ?? last, total };
}

async function scrollToQueryInRendered(contents: any, query: string, occurrence: number) {
  const doc = contents?.document as Document | undefined;
  if (!doc?.body) return { total: 0 };

  const { range, total } = findRangeForQuery(doc, query, occurrence);
  if (!range) return { total };

  const win = contents.window as Window;
  const el = (range.startContainer as any)?.parentElement as HTMLElement | null;
  if (el?.scrollIntoView) {
    el.scrollIntoView({ block: "center", behavior: "instant" as any });
    win.scrollBy({ top: -Math.round(win.innerHeight * 0.12), behavior: "instant" as any });
  }

  highlightRange(doc, range);
  return { total };
}

const pendingSearch = ref<{ hrefCanon: string; query: string; occurrence: number } | null>(null);
const activeSearch = ref<{ query: string; global: number; total: number } | null>(null);

async function gotoMatch(delta: number) {
  const query = q.value.trim();
  if (!query) return;
  if (!idxReady.value || !idx) return;
  if (hasIframeSelection.value) return;

  const total = hitTotal.value;
  if (!total) return;

  if (!activeSearch.value || activeSearch.value.query !== query) {
    activeSearch.value = { query, global: delta > 0 ? -1 : 0, total };
  }

  const nextGlobal = (activeSearch.value.global + delta + total) % total;
  activeSearch.value.global = nextGlobal;
  activeSearch.value.total = total;

  const { hrefCanon: targetCanon, occ } = locateGlobalMatch(nextGlobal);
  const locCanon = currentHrefCanon();

  const targetKey = canonToKey.value[targetCanon] ?? targetCanon;

  if (locCanon && locCanon === targetCanon) {
    const contents = contentsForCanon(targetCanon);
    if (contents) await scrollToQueryInRendered(contents, query, occ);
    return;
  }

  pendingSearch.value = { hrefCanon: targetCanon, query, occurrence: occ };
  await rendition.display(targetKey);
}

async function initSearch() {
  if (!book) return;

  indexing.value = true;
  idxReady.value = false;

  try {
    const res = await ensureIndex(props.id, book, (done, total, fromCache) => {
      indexDone.value = done;
      indexTotal.value = total;
      indexFromCache.value = fromCache;
    });

    idx = res.idx;
    hrefText.value = res.hrefText;

    // map canon -> original key
    const map: Record<string, string> = {};
    for (const k of Object.keys(res.hrefText)) map[canonHref(k)] = k;
    canonToKey.value = map;

    spineOrderCanon.value = (book?.spine?.items ?? [])
      .map((it: any) => canonHref(String(it?.href || "")))
      .filter(Boolean);

    idxReady.value = true;
    results.value = q.value.trim() ? chapterSearch(q.value.trim()) : [];
  } catch (e) {
    console.error("[search] init failed", e);
  } finally {
    indexing.value = false;
  }
}

function chapterSearch(query: string): SearchChapterHit[] {
  const raw = doSearch(idx, hrefText.value, query);
  return raw.map((r) => ({
    hrefKey: r.href,
    hrefCanon: canonHref(r.href),
    snippet: r.snippet,
    count: r.count,
  }));
}

let searchTimer: number | null = null;
watch(q, () => {
  if (searchTimer) window.clearTimeout(searchTimer);

  const qq = q.value.trim();
  if (!qq || !idxReady.value || !idx) {
    results.value = [];
    activeSearch.value = null;
    return;
  }

  searchTimer = window.setTimeout(() => {
    results.value = chapterSearch(qq);
    // keep global pointer but clamp
    if (activeSearch.value?.query === qq) {
      activeSearch.value.total = hitTotal.value;
      activeSearch.value.global = Math.min(activeSearch.value.global, Math.max(-1, activeSearch.value.total - 1));
    }
  }, 180);
});

async function jumpToChapterFirstHit(r: SearchChapterHit) {
  const qq = q.value.trim();
  if (!qq) return;

  activeSearch.value = {
    query: qq,
    global: -1,
    total: hitTotal.value,
  };

  pendingSearch.value = { hrefCanon: r.hrefCanon, query: qq, occurrence: 0 };
  await rendition.display(r.hrefKey);
}

// --------------------
// read aloud (Web Speech API)
// --------------------
const ttsSupported = computed(() => typeof window !== "undefined" && "speechSynthesis" in window);
// Keep permissive typing (some TS setups don't include SpeechSynthesisVoice).
const ttsVoices = ref<any[]>([]);
const ttsSpeaking = ref(false);
const ttsPaused = ref(false);

function refreshVoices() {
  if (!ttsSupported.value) return;
  try {
    ttsVoices.value = window.speechSynthesis.getVoices() || [];
  } catch {
    ttsVoices.value = [];
  }
}

function pickVoiceByURI(uri: string | undefined) {
  if (!uri) return undefined;
  return ttsVoices.value.find((v) => v?.voiceURI === uri);
}

function splitTextForTTS(text: string, maxLen = 240) {
  const cleaned = (text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];

  const parts: string[] = [];
  let cur = "";
  // Avoid regex lookbehind for broader compatibility.
  const pieces = cleaned.split(/[\.!?]\s+/).filter(Boolean);
  for (const piece of pieces) {
    if ((cur + " " + piece).trim().length > maxLen && cur.trim()) {
      parts.push(cur.trim());
      cur = piece;
    } else {
      cur = (cur + " " + piece).trim();
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function getReadableTextFromCurrentContents() {
  const c = (rendition?.getContents?.() ?? [])[0];
  const doc = c?.document as Document | undefined;
  if (!doc?.body) return "";

  // remove nav/footnotes blocks
  const clone = doc.body.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("nav, aside, #inline-footnotes, .footnote, .endnote, script, style").forEach((n) => n.remove());
  return (clone.innerText || clone.textContent || "").trim();
}

function toggleReadAloud() {
  readAloud.value = !readAloud.value;
}

function stopReadAloud() {
  if (!ttsSupported.value) return;
  try {
    window.speechSynthesis.cancel();
  } catch {}
  ttsSpeaking.value = false;
  ttsPaused.value = false;
}

function pauseReadAloud() {
  if (!ttsSupported.value) return;
  try {
    window.speechSynthesis.pause();
    ttsPaused.value = true;
  } catch {}
}

function resumeReadAloud() {
  if (!ttsSupported.value) return;
  try {
    window.speechSynthesis.resume();
    ttsPaused.value = false;
  } catch {}
}

async function startReadAloud() {
  if (!ttsSupported.value) return;

  stopReadAloud();
  refreshVoices();

  const text = getReadableTextFromCurrentContents();
  if (!text) {
    openModal("Read aloud", "<p class='opacity-70'>No readable text found on this page.</p>");
    return;
  }

  const chunks = splitTextForTTS(text.slice(0, 12000));
  if (!chunks.length) return;

  const voice = pickVoiceByURI(ttsVoiceURI.value);

  ttsSpeaking.value = true;
  ttsPaused.value = false;

  let i = 0;
  const speakNext = () => {
    if (!ttsSpeaking.value) return;
    if (i >= chunks.length) {
      ttsSpeaking.value = false;
      ttsPaused.value = false;
      return;
    }

    const u = new (window as any).SpeechSynthesisUtterance(chunks[i]!);
    if (voice) u.voice = voice;
    u.rate = Math.min(1.4, Math.max(0.6, ttsRate.value || 1));

    u.onend = () => {
      i++;
      speakNext();
    };
    u.onerror = () => {
      ttsSpeaking.value = false;
      ttsPaused.value = false;
    };

    window.speechSynthesis.speak(u);
  };

  speakNext();
}

// --------------------
// footnotes / glossary popup
// --------------------
function looksLikeNoterefHref(href: string) {
  return !!href && href.includes("#") && /#(fn[-_]?|footnote|note|endnote)/i.test(href);
}

async function loadDocForHref(filePart: string, currentDoc: Document | null, baseHrefHint: string) {
  const baseHref = baseHrefHint || rendition?.location?.start?.href || bookMeta.value?.lastHref || "";

  if (!filePart) {
    if (currentDoc) return { doc: currentDoc, hrefUsed: baseHref };
    if (!baseHref) return { doc: document.implementation.createHTMLDocument(""), hrefUsed: "" };

    const raw = await Promise.race([
      book.load(baseHref),
      new Promise((_, rej) => setTimeout(() => rej(new Error("book.load timeout")), 2500)),
    ]);
    return { doc: parseXhtml(raw), hrefUsed: baseHref };
  }

  const fp = normalizePath(safeDecodeURIComponent(filePart || "").trim());
  const base = normalizePath(safeDecodeURIComponent(baseHref || "").trim());
  const dir = base.includes("/") ? base.slice(0, base.lastIndexOf("/") + 1) : "";

  const cands = new Set<string>();
  if (fp) cands.add(normalizePath(dir ? `${dir}/${fp}` : fp));
  if (fp) cands.add(fp);

  const pool: string[] = [];
  for (const it of (book?.spine?.items ?? [])) {
    const h = it?.href;
    if (h) pool.push(normalizePath(h));
  }
  const manifest = book?.packaging?.manifest ?? book?.manifest;
  if (manifest && typeof manifest === "object") {
    for (const k of Object.keys(manifest)) {
      const it = (manifest as any)[k];
      const h = it?.href;
      const type = it?.type || it?.media_type || it?.mediaType;
      if (h && (!type || /x?html/i.test(type))) pool.push(normalizePath(h));
    }
  }

  const tail = fp.split("/").pop() || fp;
  for (const h of pool) {
    if (!h) continue;
    if (h === fp || h.endsWith("/" + fp) || h.endsWith("/" + tail) || h === tail) cands.add(h);
  }

  let lastErr: any = null;
  for (const href of cands) {
    try {
      const raw = await Promise.race([
        book.load(href),
        new Promise((_, rej) => setTimeout(() => rej(new Error("book.load timeout")), 2500)),
      ]);
      return { doc: parseXhtml(raw), hrefUsed: href };
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr ?? new Error("Could not load referenced file");
}

async function handleNoterefHref(href0: string, clicked: string, baseHrefHint: string) {
  const [filePartRaw, fragRaw] = href0.split("#");
  const filePart = (filePartRaw || "").trim();
  const frag = (fragRaw || "").trim();
  if (!frag) return;

  const fragDecoded = safeDecodeURIComponent(frag).replace(/^#/, "");

  modalLoading.value = true;
  modalOpen.value = true;
  modalTitle.value = "Loading…";
  modalHtml.value = "";

  try {
    const { doc, hrefUsed } = await loadDocForHref(filePart, null, baseHrefHint);

    for (const id of idKeys(fragDecoded)) {
      const el = findById(doc, id);
      if (!el) continue;

      const clone = el.cloneNode(true) as HTMLElement;
      const title =
        clone.querySelector(".sr-only strong")?.textContent?.trim() ||
        clone.querySelector(".sr-only")?.textContent?.trim() ||
        clicked ||
        fragDecoded;

      clone.querySelectorAll(".sr-only").forEach((n) => n.remove());
      clone.querySelectorAll("script, iframe, object, embed").forEach((n) => n.remove());

      modalTitle.value = title;
      modalHtml.value = `<div class="space-y-2 leading-relaxed">${clone.innerHTML}</div>`;
      modalBaseHref.value = hrefUsed || baseHrefHint;
      return;
    }

    const dictKey = fragDecoded.replace(/^fn-/, "");
    const def = await defineWordFallback(dictKey);
    modalTitle.value = clicked || dictKey;
    modalHtml.value = def
      ? `<pre class="whitespace-pre-wrap">${escapeHtml(def)}</pre>`
      : `<p>No definition found.</p>`;
  } finally {
    modalLoading.value = false;
  }
}

function onModalClick(ev: MouseEvent) {
  const target = ev.target as Element | null;
  const a = (target?.closest?.("a") as HTMLAnchorElement | null) ?? null;
  if (!a) return;

  const href = a.getAttribute("href") || "";
  if (!href) return;

  if (looksLikeNoterefHref(href) || isNoterefAnchor(a)) {
    ev.preventDefault();
    const baseHref = modalBaseHref.value || rendition?.location?.start?.href || bookMeta.value?.lastHref || "";
    handleNoterefHref(href, (a.textContent || "").trim(), baseHref);
    return;
  }

  if (!/^(https?:|mailto:|tel:)/i.test(href)) {
    ev.preventDefault();
    jump(href);
  }
}

// --------------------
// selection actions
// --------------------
async function handleSelection(cfiRange: string) {
  try {
    const range = await book.getRange(cfiRange);
    const selectedText = safeText(range?.toString());
    if (!selectedText) return;

    const quote = buildQuoteText({
      profile: profile.value,
      selectedText,
      title: bookMeta.value?.title || "Untitled",
      author: bookMeta.value?.author,
      section: await currentChapterLabel(),
      chapter: await currentChapterLabel(),
    });

    openModal(
      "Selection",
      `
        <p class="opacity-70">${escapeHtml(selectedText)}</p>
        <div class="mt-3 flex flex-wrap gap-2">
          <button id="btn-quote" class="btn btn-primary btn-sm">Copy quote</button>
          <button id="btn-define" class="btn btn-outline btn-sm">Define first word</button>
        </div>
      `
    );

    setTimeout(() => {
      const bq = document.getElementById("btn-quote");
      const bd = document.getElementById("btn-define");

      bq?.addEventListener("click", async () => {
        await navigator.clipboard.writeText(quote);
        openModal("Copied", `<p>Quote copied with citation.</p>`);
      });

      bd?.addEventListener("click", async () => {
        const first = selectedText.split(/\s+/)[0] || "";
        const def = await defineWordFallback(first);
        openModal(
          `Define: ${escapeHtml(first)}`,
          def ? `<pre class="whitespace-pre-wrap">${escapeHtml(def)}</pre>` : `<p>No definition found.</p>`
        );
      });
    }, 0);
  } catch {
    // ignore
  }
}

async function currentChapterLabel(): Promise<string | undefined> {
  try {
    const href = rendition?.location?.start?.href;
    const toc = book?.navigation?.toc ?? [];
    const hit = toc.find((x: any) => x.href && href && x.href.split("#")[0] === href.split("#")[0]);
    return hit?.label ?? undefined;
  } catch {
    return undefined;
  }
}

// --------------------
// open / (re)create rendition
// --------------------
function destroyRendition() {
  try {
    rendition?.destroy?.();
  } catch {}
  rendition = null;
}

function attachRenditionHandlers() {
  if (!rendition) return;

  // Search: when a section renders, apply pending search scroll/highlight
  rendition.on("rendered", async (section: any, contents: any) => {
    const p = pendingSearch.value;
    if (!p) return;

    const sh = canonHref(section?.href || "");
    if (!sh || sh !== p.hrefCanon) return;

    pendingSearch.value = null;
    await scrollToQueryInRendered(contents, p.query, p.occurrence);
  });

  // Selection
  rendition.on("selected", (cfiRange: string) => handleSelection(cfiRange));

  // Track location for resume
  rendition.on("relocated", async (loc: any) => {
    const cfi = loc?.start?.cfi;
    const href = loc?.start?.href;
    const pct = loc?.start?.percentage;
    await updateMetaPatch({ lastCfi: cfi, lastHref: href, lastProgress: pct });

    // If user navigates, stop read-aloud unless user explicitly keeps it on
    if (readAloud.value && ttsSpeaking.value) {
      stopReadAloud();
    }
  });

  // Inject per-chapter hooks
  rendition.hooks.content.register((contents: any) => {
    const doc = contents.document as Document;

    // v2: hide inline footnotes (we show via popup)
    try {
      contents.addStylesheetRules({
        "#inline-footnotes": { display: "none !important" },
        ".sr-only": { display: "none !important" },
      });
    } catch {
      // ignore
    }

    // Track selection state (to avoid fighting the user while highlighting)
    const updateSel = () => {
      const sel = doc.getSelection?.();
      hasIframeSelection.value = !!sel && !!sel.toString().trim();
    };
    doc.addEventListener("selectionchange", updateSel);
    doc.addEventListener("pointerup", updateSel as any, { passive: true } as any);
    doc.addEventListener(
      "pointerdown",
      () => {
        hasIframeSelection.value = false;
      },
      { passive: true } as any
    );

    // Remove any inline scripts
    doc.querySelectorAll("script").forEach((s) => s.remove());

    // Noteref popup + study mode (tap-to-toggle controls)
    doc.addEventListener(
      "click",
      async (ev: MouseEvent) => {
        const target = ev.target as Element | null;
        const a = (target?.closest?.("a") as HTMLAnchorElement | null) ?? null;

        // Footnote/glossary popup
        if (a && isNoterefAnchor(a)) {
          ev.preventDefault();
          ev.stopPropagation();
          await handleNoterefHref(
            a.getAttribute("href") || "",
            (a.textContent || "").trim(),
            contents?.section?.href || rendition?.location?.start?.href || bookMeta.value?.lastHref || ""
          );
          return;
        }

        // Study mode: tap anywhere (non-link) toggles UI
        if (prefs.value.studyMode && !a) {
          if (searchOpen.value || tocOpen.value || modalOpen.value) return;

          const sel = doc.getSelection?.();
          if (sel && sel.toString().trim()) return;

          const now = Date.now();
          if (now - lastChromeToggleAt.value < 250) return;
          lastChromeToggleAt.value = now;

          chrome.value = !chrome.value;
          ev.preventDefault();
          ev.stopPropagation();
        }
      },
      true
    );

    // v2: swipe page turns in Real Book Feel
    if (realBookFeel.value) {
      let sx = 0;
      let sy = 0;
      let st = 0;

      doc.addEventListener(
        "pointerdown",
        (e: PointerEvent) => {
          if (e.pointerType === "mouse") return;
          sx = e.clientX;
          sy = e.clientY;
          st = Date.now();
        },
        { passive: true } as any
      );

      doc.addEventListener(
        "pointerup",
        (e: PointerEvent) => {
          if (e.pointerType === "mouse") return;
          const dx = e.clientX - sx;
          const dy = e.clientY - sy;
          const dt = Date.now() - st;

          // avoid conflict with vertical scroll
          if (Math.abs(dx) < 70) return;
          if (Math.abs(dy) > 55) return;
          if (dt > 650) return;

          const sel = doc.getSelection?.();
          if (sel && sel.toString().trim()) return;

          if (dx < 0) void turnNext();
          else void turnPrev();
        },
        { passive: true } as any
      );
    }
  });
}

async function createRenditionAndDisplay(initialCfi?: string) {
  if (!viewer.value) return;

  const opts = realBookFeel.value
    ? {
        width: "100%",
        height: "100%",
        spread: "none",
        manager: "default",
        flow: "paginated",
      }
    : {
        width: "100%",
        height: "100%",
        spread: "none",
        manager: "continuous",
        flow: "scrolled-doc",
      };

  rendition = book.renderTo(viewer.value, opts);
  attachRenditionHandlers();

  await rendition.display(initialCfi || bookMeta.value?.lastCfi || undefined);
  applyTheme();
}

const recreating = ref(false);
async function recreateRendition() {
  if (!book || !viewer.value) return;
  if (recreating.value) return;
  recreating.value = true;

  try {
    const cfi = rendition?.location?.start?.cfi || bookMeta.value?.lastCfi;
    destroyRendition();
    await createRenditionAndDisplay(cfi);
    await updateViewerPads();
  } finally {
    recreating.value = false;
  }
}

watch(realBookFeel, async (v, oldV) => {
  if (v === oldV) return;
  if (!book) return;
  await recreateRendition();
});

async function openBook() {
  const books = await loadBooks();
  const meta = books.find((b) => b.id === props.id) || null;
  bookMeta.value = meta;
  if (!meta) {
    router.push("/");
    return;
  }

  const blob = await loadBookFile(props.id);
  if (!blob) {
    router.push("/");
    return;
  }

  book = ePub(await blob.arrayBuffer());
  await book.ready;

  // Protect against inline script surprises
  try {
    book.spine.hooks.serialize.register((output: string) => {
      return output.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "");
    });
  } catch {
    // ignore
  }

  // metadata
  const md = await book.loaded.metadata;
  const title = safeText(md?.title) || meta.title;
  const author = safeText(md?.creator) || meta.author || "";

  // detect profile
  let sampleText = "";
  try {
    const firstHref = book.spine.items?.[0]?.href;
    const raw = await book.load(firstHref);
    const doc = new DOMParser().parseFromString(String(raw), "text/html");
    sampleText = (doc.body?.textContent || "").slice(0, 6000);
  } catch {
    // ignore
  }

  profile.value = detectProfileFromMetadata(title, author, sampleText);
  await updateMetaPatch({ title, author, profile: profile.value });

  tocItems.value = (book.navigation?.toc ?? []) as TocItem[];

  await createRenditionAndDisplay(meta.lastCfi || undefined);

  const s = await startSession(props.id);
  sessionId = s.id;

  // Search index build (cached per book)
  void initSearch();
}

async function showStats() {
  const t = await totals(props.id);
  const mins = Math.round(t.totalSeconds / 60);
  openModal(
    "Reading analytics",
    `<p>Total: <b>${mins}</b> minutes across <b>${t.totalSessions}</b> sessions.</p>`
  );
}

// --------------------
// lifecycle
// --------------------
onMounted(async () => {
  window.addEventListener("keydown", onKeydown);

  if (ttsSupported.value) {
    refreshVoices();
    try {
      // some browsers populate voices asynchronously
      window.speechSynthesis.onvoiceschanged = () => refreshVoices();
    } catch {
      // ignore
    }
  }

  prefs.value = await loadPrefs(props.id).catch(() => DEFAULT_PREFS);
  await openBook();
});

onBeforeUnmount(async () => {
  window.removeEventListener("keydown", onKeydown);

  try {
    destroyRendition();
  } catch {}

  try {
    book?.destroy?.();
  } catch {}

  book = null;

  stopReadAloud();

  if (sessionId) {
    try {
      await endSession(props.id, sessionId);
    } catch {
      // ignore
    }
  }
});
</script>

<template>
  <div class="h-full bg-base-100">
    <!-- Top chrome -->
    <div
      v-if="chrome"
      ref="topChromeEl"
      class="fixed top-0 left-0 right-0 z-30 bg-base-200/95 backdrop-blur border-b border-base-300"
    >
      <div class="navbar">
        <div class="flex-1 min-w-0">
          <button class="btn btn-ghost btn-sm" @click="back">
            <i class="fa-solid fa-arrow-left mr-2"></i>
            Library
          </button>
          <div class="ml-2 truncate font-semibold">{{ bookMeta?.title }}</div>
        </div>

        <div class="flex-none gap-2">
          <button class="btn btn-sm" @click="openToc">
            <i class="fa-solid fa-list mr-2"></i>
            TOC
          </button>

          <button class="btn btn-sm" @click.stop="openSearchModal">
            <i class="fa-solid fa-magnifying-glass mr-2"></i>
            Search
          </button>

          <div class="join hidden sm:inline-flex">
            <button class="btn btn-sm join-item" :disabled="!realBookFeel" @click="turnPrev" title="Prev page">‹</button>
            <button class="btn btn-sm join-item" :disabled="!realBookFeel" @click="turnNext" title="Next page">›</button>
          </div>

          <button class="btn btn-sm btn-outline" @click="showStats">
            <i class="fa-solid fa-chart-column mr-2"></i>
            Stats
          </button>

          <div v-if="ttsSupported" class="join">
            <button
              class="btn btn-sm join-item"
              :class="readAloud ? 'btn-primary' : ''"
              @click="toggleReadAloud"
              title="Enable Read Aloud"
            >
              <i class="fa-solid fa-headphones"></i>
            </button>

            <button
              class="btn btn-sm join-item"
              :disabled="!readAloud"
              @click="ttsSpeaking ? (ttsPaused ? resumeReadAloud() : pauseReadAloud()) : startReadAloud()"
              title="Play / Pause"
            >
              <i :class="ttsSpeaking && !ttsPaused ? 'fa-solid fa-pause' : 'fa-solid fa-play'"></i>
            </button>

            <button
              class="btn btn-sm join-item"
              :disabled="!readAloud"
              @click="stopReadAloud"
              title="Stop"
            >
              <i class="fa-solid fa-stop"></i>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Reader surface -->
    <div class="h-full w-full" :style="viewerPadStyle">
      <div
        ref="viewer"
        class="h-full w-full"
        :class="{
          'page-flip-next': pageAnim === 'next',
          'page-flip-prev': pageAnim === 'prev',
        }"
      ></div>
    </div>

    <!-- Bottom chrome -->
    <div
      v-if="chrome"
      ref="bottomChromeEl"
      class="fixed bottom-0 left-0 right-0 z-30 bg-base-200/95 backdrop-blur border-t border-base-300"
      @click.stop
    >
      <div class="p-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <label class="form-control">
          <div class="label"><span class="label-text">Font size</span></div>
          <input type="range" min="80" max="180" step="5" v-model.number="prefs.fontSizePct" class="range range-sm" />
        </label>

        <label class="form-control">
          <div class="label"><span class="label-text">Line height</span></div>
          <input type="range" min="1.2" max="2.2" step="0.05" v-model.number="prefs.lineHeight" class="range range-sm" />
        </label>

        <label class="form-control">
          <div class="label"><span class="label-text">Background</span></div>
          <input type="color" v-model="prefs.bg" class="input input-bordered h-10 p-1" />
        </label>

        <label class="form-control">
          <div class="label"><span class="label-text">Text</span></div>
          <input type="color" v-model="prefs.fg" class="input input-bordered h-10 p-1" />
        </label>

        <label class="form-control col-span-2">
          <div class="label"><span class="label-text">Font</span></div>
          <select class="select select-bordered" v-model="prefs.font">
            <option :value='`ui-serif, Georgia, "Times New Roman", Times, serif`'>Serif</option>
            <option :value='`ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif`'>Sans</option>
            <option :value='`ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace`'>Mono</option>
          </select>
        </label>

        <label class="form-control col-span-2">
          <div class="label"><span class="label-text">Alignment</span></div>
          <select class="select select-bordered" v-model="prefs.textAlign">
            <option value="left">Left</option>
            <option value="justify">Justify</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </label>

        <div class="col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label class="form-control">
            <span class="label-text">Link color</span>
            <input type="color" class="input input-bordered h-10" v-model="prefs.noterefColor" @change="savePrefsNow" />
          </label>

          <label class="form-control">
            <span class="label-text">Underline links</span>
            <input type="checkbox" class="toggle" v-model="prefs.noterefUnderline" @change="savePrefsNow" />
          </label>

          <div class="form-control sm:col-span-2">
            <label class="label cursor-pointer justify-start gap-3">
              <input type="checkbox" class="toggle" v-model="prefs.studyMode" @change="savePrefsNow" />
              <span class="label-text">Study mode</span>
            </label>
          </div>

          <div class="form-control sm:col-span-2">
            <label class="label cursor-pointer justify-start gap-3">
              <input type="checkbox" class="toggle" v-model="realBookFeel" />
              <span class="label-text">Real Book Feel (paginated + swipe)</span>
            </label>
          </div>

          <div v-if="readAloud && ttsSupported" class="form-control sm:col-span-2">
            <div class="label"><span class="label-text">Read aloud rate</span></div>
            <input type="range" min="0.6" max="1.4" step="0.05" v-model.number="ttsRate" class="range range-sm" />

            <div class="mt-2">
              <select class="select select-bordered w-full" v-model="ttsVoiceURI">
                <option value="">Default voice</option>
                <option v-for="v in ttsVoices" :key="v.voiceURI" :value="v.voiceURI">
                  {{ v.name }} ({{ v.lang }})
                </option>
              </select>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Floating controls when chrome hidden -->
    <button
      v-if="!chrome"
      class="fixed z-50 btn btn-sm btn-circle"
      style="top: calc(env(safe-area-inset-top) + 0.75rem); right: 3.25rem;"
      @click.stop="openSearchModal"
      aria-label="Search"
    >
      <i class="fa-solid fa-magnifying-glass"></i>
    </button>

    <button
      v-if="!chrome"
      class="fixed z-50 btn btn-sm opacity-80 hover:opacity-100"
      style="top: calc(env(safe-area-inset-top) + 0.75rem); right: 0.75rem;"
      @click="chrome = true"
      aria-label="Show controls"
    >
      Show controls
    </button>

    <!-- TOC modal -->
    <div v-if="tocOpen" class="modal modal-open">
      <div class="modal-box max-w-2xl">
        <div class="flex items-center justify-between gap-3">
          <h3 class="font-bold text-lg">Table of contents</h3>
          <button class="btn btn-sm" @click="closeToc">Close</button>
        </div>

        <div class="mt-4 max-h-[70vh] overflow-auto space-y-1">
          <button
            v-for="(it, i) in tocFlat"
            :key="i"
            class="btn btn-ghost btn-sm w-full justify-start text-left"
            :style="{ paddingLeft: `${it.depth * 0.75}rem` }"
            @click="goToc(it)"
          >
            {{ it.label }}
          </button>
        </div>
      </div>
      <div class="modal-backdrop" @click="closeToc"></div>
    </div>

    <!-- Search modal -->
    <Modal :open="searchOpen" title="Search" @close="closeSearchModal">
      <div class="mt-3">
        <div class="join w-full">
          <input
            ref="searchInputEl"
            class="input input-bordered join-item w-full"
            placeholder="Search…"
            v-model="q"
            @click.stop
          />
          <button
            class="btn btn-outline join-item"
            :disabled="!q.trim() || indexing || !idxReady || hitTotal === 0 || hasIframeSelection"
            @click.stop="gotoMatch(-1)"
            aria-label="Previous match"
          >
            ‹
          </button>
          <button
            class="btn btn-outline join-item"
            :disabled="!q.trim() || indexing || !idxReady || hitTotal === 0 || hasIframeSelection"
            @click.stop="gotoMatch(1)"
            aria-label="Next match"
          >
            ›
          </button>
        </div>

        <div class="mt-1 text-xs opacity-70 flex items-center justify-between gap-3">
          <span v-if="indexing">Indexing… {{ indexDone }}/{{ indexTotal }}</span>
          <span v-else>
            Search ready ({{ Object.keys(hrefText).length }} chapters{{ indexFromCache ? ", cached" : "" }})
          </span>
          <span v-if="q.trim() && hitTotal > 0">
            Match {{ (activeSearch?.global ?? -1) + 1 }} / {{ hitTotal }}
          </span>
        </div>
      </div>

      <div v-if="q.trim() && !indexing && results.length" class="mt-4">
        <div class="text-xs uppercase tracking-wide opacity-60 mb-2">Chapters with matches</div>
        <div class="max-h-72 overflow-auto space-y-2">
          <button
            v-for="r in results.slice(0, 30)"
            :key="r.hrefKey"
            class="w-full text-left p-3 rounded-xl bg-base-200 hover:bg-base-300"
            @click="jumpToChapterFirstHit(r)"
          >
            <div class="flex items-center justify-between gap-3">
              <div class="text-sm font-semibold">{{ r.count }} hit(s)</div>
              <div class="text-xs opacity-70 truncate">{{ r.hrefKey }}</div>
            </div>
            <div class="mt-1 text-sm opacity-80 line-clamp-3">{{ r.snippet }}</div>
          </button>
        </div>
      </div>

      <div v-if="q.trim() && !indexing && !results.length" class="mt-3 text-sm opacity-70">
        No matches.
      </div>
    </Modal>

    <!-- General modal -->
    <Modal :open="modalOpen" :title="modalTitle" @close="closeModal">
      <div v-if="modalLoading" class="opacity-70">Loading…</div>
      <div v-else class="space-y-2" @click="onModalClick" v-html="modalHtml"></div>
    </Modal>
  </div>
</template>

<style scoped>
.page-flip-next {
  animation: flipNext 220ms ease-out;
}
.page-flip-prev {
  animation: flipPrev 220ms ease-out;
}
@keyframes flipNext {
  0% { transform: perspective(900px) rotateY(0deg) translateX(0); }
  35% { transform: perspective(900px) rotateY(-5deg) translateX(-8px); }
  100% { transform: perspective(900px) rotateY(0deg) translateX(0); }
}
@keyframes flipPrev {
  0% { transform: perspective(900px) rotateY(0deg) translateX(0); }
  35% { transform: perspective(900px) rotateY(5deg) translateX(8px); }
  100% { transform: perspective(900px) rotateY(0deg) translateX(0); }
}
</style>
