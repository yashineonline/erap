<script setup lang="ts">
    import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from "vue";
    import { useRouter } from "vue-router";
    import ePub from "epubjs";
    
    import Modal from "../components/Modal.vue";
    
    import type { BookMeta, BookProfile } from "../lib/types";
    import { loadBooks, saveBooks, loadBookFile, loadPrefs, savePrefs } from "../lib/storage";
    import { DEFAULT_PREFS } from "../lib/storage";
    import { isNoterefAnchor } from "../lib/glossary";
    import { defineWordFallback } from "../lib/dictionary";
    import { detectProfileFromMetadata } from "../lib/profiles";
    import { buildQuoteText } from "../lib/quote";
    import { makeIndex , ensureIndex, search as doSearch } from "../lib/search";
    import { startSession, endSession, totals } from "../lib/analytics";
    import { safeText } from "../lib/epub";
    import type { ReaderPrefs } from "../lib/types";
    
    const prefs = ref<ReaderPrefs>(DEFAULT_PREFS);
    const props = defineProps<{ id: string }>();
    const router = useRouter();
    
    const searchOpen = ref(false);
const searchInputEl = ref<HTMLInputElement | null>(null);

  const bottomChromeEl = ref<HTMLElement | null>(null);
    const topChromeEl = ref<HTMLElement | null>(null);

const topPadPx = ref(0);
const bottomPadPx = ref(0);

const viewerPadStyle = computed(() => ({
  paddingTop: chrome.value ? `${topPadPx.value}px` : "0px",
  paddingBottom: chrome.value ? `${bottomPadPx.value}px` : "0px",
}));

const iframeBottomPadPx = ref(24);


function openSearchModal() {
  searchOpen.value = true;
  nextTick(() => searchInputEl.value?.focus());
}
function closeSearchModal() {
  searchOpen.value = false;
}

async function savePrefsNow() {
  // Some controls use explicit @change; we also keep the deep watcher below.
  await savePrefs(props.id, prefs.value);
  applyTheme();
}


    const viewer = ref<HTMLDivElement|null>(null);
    const chrome = ref(true);
    
    const bookMeta = ref<BookMeta|null>(null);
    const profile = ref<BookProfile>("default");
    
    let lastChromeToggleAt = 0;


    const indexing = ref(false);
    const q = ref("");
    const results = ref<{ href: string; snippet: string; count: number }[]>([]);
    const resultsDockOpen = ref(true);

    let idx: any = null;
    let hrefText: Record<string, string> = {};
    const idxReady = ref(false);
const indexDone = ref(0);
const indexTotal = ref(0);
const indexFromCache = ref(false);

const spineOrder = ref<string[]>([]);
const hasIframeSelection = ref(false);

const hitCountByHref = computed(() => {
  const m = new Map<string, number>();
  for (const r of results.value) {
    const h = normalizePath(String(r.href || "").split("#")[0]);
    if (h) m.set(h, r.count || 0);
  }
  return m;
});

const hitHrefsOrdered = computed(() => {
  const counts = hitCountByHref.value;
  const keys = new Set(Object.keys(hrefText).map(h => normalizePath(h)));
  const order = spineOrder.value.length ? spineOrder.value : [...keys];
  return order
    .map(h => normalizePath(h))
    .filter(h => h && keys.has(h) && counts.has(h));
});

const hitTotal = computed(() => {
  const counts = hitCountByHref.value;
  return hitHrefsOrdered.value.reduce((a, h) => a + (counts.get(h) ?? 0), 0);
});

function currentHref() {
  return normalizePath(String(rendition?.location?.start?.href || "").split("#")[0]);
}

function contentsForHref(href: string) {
  const target = normalizePath(String(href).split("#")[0]);
  const arr = (rendition?.getContents?.() ?? []) as any[];
  return (
    arr.find(c => normalizePath(String(c?.section?.href || c?.href || "")).split("#")[0] === target) ??
    arr[0]
  );
}

function locateGlobalMatch(globalIndex: number) {
  const counts = hitCountByHref.value;
  const hrefs = hitHrefsOrdered.value;

  let cum = 0;
  for (const h of hrefs) {
    const c = counts.get(h) ?? 0;
    if (globalIndex < cum + c) return { href: h, occ: globalIndex - cum };
    cum += c;
  }
  // fallback
  return { href: hrefs[0]!, occ: 0 };
}

    const pendingSearch = ref<{ href: string; query: string; occurrence: number } | null>(null);
const activeSearch = ref<{ href: string; query: string; occurrence: number; total: number } | null>(null);


    
    type TocItem = { href: string; label: string; subitems?: TocItem[] };

const tocOpen = ref(false);
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


function openToc() { tocOpen.value = true; }
function closeToc() { tocOpen.value = false; }

async function goToc(item: { href: string }) {
  closeToc();
  chrome.value = true;
  await jump(item.href);
}

// Escape study mode + quick TOC hotkey
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    chrome.value = true;
    tocOpen.value = false;
    searchOpen.value = false;
  }
  if ((e.key === "t" || e.key === "T") && chrome.value) {
    tocOpen.value = !tocOpen.value;
  }
}

function findRangeForQuery(doc: Document, query: string, occurrence: number) {
  const q = query.trim();
  if (!q) return { range: null as Range | null, total: 0 };

  const qLower = q.toLowerCase();

  const isSkippable = (t: Text) => {
    const el = t.parentElement;
    if (!el) return false;
    // Skip TOC/nav and footnote containers (prevents “jumping to nowhere”)
    return !!el.closest(
      "nav, aside, [role='doc-footnote'], [epub\\:type~='footnote'], .footnote, .endnote, #inline-footnotes, script, style"
    );
  };

  let total = 0;
  let chosen: Range | null = null;
  let last: Range | null = null;

  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
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
      r.setEnd(t, i + q.length);

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

  const rect = range.getBoundingClientRect();
  const win = contents.window as Window;

  // Prefer element scrollIntoView (more stable than rect math in iframes)
  const el = (range.startContainer as any)?.parentElement as HTMLElement | null;
  if (el?.scrollIntoView) {
    el.scrollIntoView({ block: "center", behavior: "instant" as any });
    // small nudge upward so it doesn't sit under top chrome when visible
    win.scrollBy({ top: -Math.round(win.innerHeight * 0.12), behavior: "instant" as any });
  } else {
    const rect = range.getBoundingClientRect();
    const targetY = win.scrollY + rect.top - win.innerHeight * 0.33;
    win.scrollTo({ top: Math.max(0, targetY), behavior: "instant" as any });
  }

  return { total };
}

async function gotoMatch(delta: number) {
  const query = q.value.trim();
  if (!query) return;
  if (!idxReady.value || !idx) return;
  if (hasIframeSelection.value) return;

  const total = hitTotal.value;
  if (!total) return;

  // Initialize if needed
  if (!activeSearch.value || activeSearch.value.query !== query) {
    // start “PDF-like”: pressing Next goes to 1st match; Prev goes to last match
    activeSearch.value = {
      href: "",
      query,
      occurrence: 0,
      total: total, // using your existing shape; we’ll use total as global total
      // store global in occurrence temporarily via negative/large trick? no — we’ll compute below
    };
    // we’ll stash the global index on the object (TS is fine at runtime)
    (activeSearch.value as any).global = delta > 0 ? -1 : 0;
  }

  const a: any = activeSearch.value;
  const nextGlobal = (a.global + delta + total) % total;
  a.global = nextGlobal;

  const { href, occ } = locateGlobalMatch(nextGlobal);

  const loc = currentHref();
  const target = normalizePath(href);

  // keep these for UI / pendingSearch
  activeSearch.value!.href = target;
  activeSearch.value!.occurrence = occ;
  activeSearch.value!.total = total;

  if (loc && loc === target) {
    const contents = contentsForHref(target);
    if (contents) await scrollToQueryInRendered(contents, query, occ);
    return;
  }

  pendingSearch.value = { href: target, query, occurrence: occ };
  await rendition.display(target);
}

    


    const modalOpen = ref(false);
    const modalTitle = ref("");
    const modalHtml = ref<string>("");
const modalBaseHref = ref<string | null>(null);

    const modalLoading = ref(false);
    
    let book: any = null;
    let rendition: any = null;
    let sessionId: string | null = null;
        
    let footnoteIndex: Record<string, { title?: string; html: string; href?: string }> = {};



let footnoteIndexed = false;

function idKeys(id: string) {
  const base = decodeURIComponent(id || "").replace(/^#/, "").trim();
  const noFn = base.replace(/^fn-/, "");
  const variants = new Set<string>([
    base, noFn, `fn-${noFn}`,
    base.replace(/_/g, "-"),
    base.replace(/-/g, "_"),
    noFn.replace(/_/g, "-"),
    noFn.replace(/-/g, "_"),
    `fn-${noFn.replace(/_/g, "-")}`,
    `fn-${noFn.replace(/-/g, "_")}`,
  ]);
  // add lowercase variants too
  for (const v of Array.from(variants)) variants.add(v.toLowerCase());

  return [...variants].filter(Boolean);
}

function parseXhtml(raw: any): Document {
  // epub.js often returns a Document already
  if (raw && typeof raw === "object" && (raw as any).nodeType === 9) return raw as Document;

  const s = typeof raw === "string" ? raw : String(raw ?? "");
  let d = new DOMParser().parseFromString(s, "application/xhtml+xml");
  if (d.getElementsByTagName("parsererror").length) {
    d = new DOMParser().parseFromString(s, "text/html");
  }
  return d;
}

function cssEscapeId(id: string) {
  const CSS_ = (window as any).CSS;
  if (CSS_?.escape) return CSS_.escape(id);
  return id.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
}

function findById(doc: Document, id: string) {
  return (doc.getElementById(id) as HTMLElement | null) ??
    (doc.querySelector(`#${cssEscapeId(id)}`) as HTMLElement | null) ??
    null;
}


async function ensureFootnoteIndex() {
  if (footnoteIndexed || !book) return;
  footnoteIndexed = true;

  const hrefs = new Set<string>();

  for (const it of (book.spine?.items ?? [])) {
    if (it?.href) hrefs.add(normalizePath(it.href));
  }

  const manifest = book?.packaging?.manifest ?? book?.manifest;
  if (manifest && typeof manifest === "object") {
    for (const k of Object.keys(manifest)) {
      const it = (manifest as any)[k];
      const href = it?.href;
      const type = it?.type || it?.media_type || it?.mediaType;
      if (href && (!type || /x?html/i.test(type))) hrefs.add(normalizePath(href));
    }
  }

  for (const href of hrefs) {
    let raw: any;
    try {
      raw = await Promise.race([
        book.load(href),
        new Promise((_, rej) => setTimeout(() => rej(new Error("book.load timeout")), 2500)),
      ]);
    } catch {
      continue;
    }

    const doc = parseXhtml(raw);

    const candidates = new Set<HTMLElement>();
    doc.querySelectorAll<HTMLElement>("#inline-footnotes [id]").forEach(el => candidates.add(el));
    doc.querySelectorAll<HTMLElement>(".footnote[id]").forEach(el => candidates.add(el));
    doc.querySelectorAll<HTMLElement>('[role="doc-footnote"][id]').forEach(el => candidates.add(el));
    doc.querySelectorAll<HTMLElement>('[epub\\:type~="footnote"][id]').forEach(el => candidates.add(el));

    for (const el of candidates) {
      const id = el.getAttribute("id") || "";
      if (!id) continue;

      const clone = el.cloneNode(true) as HTMLElement;

      const title =
        clone.querySelector(".sr-only strong")?.textContent?.trim() ||
        clone.querySelector(".sr-only")?.textContent?.trim() ||
        undefined;

      clone.querySelectorAll(".sr-only").forEach(n => n.remove());
      clone.querySelectorAll("script, iframe, object, embed").forEach(n => n.remove());

      const html = `<div class="space-y-2 leading-relaxed">${clone.innerHTML}</div>`;

      for (const k of idKeys(id)) {
        footnoteIndex[k] = { title, html, href };
      }
    }
  }
}


    function openModal(title: string, html: string) {
      modalTitle.value = title;
      modalHtml.value = html;
      modalOpen.value = true;
    }
    function closeModal() { modalOpen.value = false; }
    
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

async function handleNoterefHref(href0: string, clicked: string, baseHrefHint: string) {
  const [filePartRaw, fragRaw] = href0.split("#");
  const filePart = (filePartRaw || "").trim();
  const frag = (fragRaw || "").trim();
  if (!frag) return;

  const fragDecoded = safeDecodeURIComponent(frag).replace(/^#/, "");

  modalLoading.value = true;
  modalTitle.value = "Loading…";
  modalHtml.value = "";

  try {
    const { doc, hrefUsed } = await loadDocForHref(filePart, null, baseHrefHint);

    for (const id of idKeys(fragDecoded)) {
      const el = findById(doc, id);

      if (el) {
        const clone = el.cloneNode(true) as HTMLElement;
        const title =
          clone.querySelector(".sr-only strong")?.textContent?.trim() ||
          clone.querySelector(".sr-only")?.textContent?.trim() ||
          clicked ||
          fragDecoded;

        clone.querySelectorAll(".sr-only").forEach(n => n.remove());
        clone.querySelectorAll("script, iframe, object, embed").forEach(n => n.remove());

        modalTitle.value = title;
        modalHtml.value = `<div class="space-y-2 leading-relaxed">${clone.innerHTML}</div>`;
        modalBaseHref.value = hrefUsed || baseHrefHint;
        return;
      }
    }

    await ensureFootnoteIndex();
    for (const k of idKeys(fragDecoded)) {
      const hit = footnoteIndex[k];
      if (hit) {
        modalTitle.value = hit.title || clicked || fragDecoded;
        modalHtml.value = hit.html;
        modalBaseHref.value = hit.href || baseHrefHint;
        return;
      }
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


    async function back() {
      if (sessionId) await endSession(props.id, sessionId);
      router.push("/");
    }
    
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

    // Do NOT force underline/color on all links. Only style glossary/noteref links:
    'a.noteref, a[role="doc-noteref"], a[rel~="footnote"], a[epub\\:type~="noteref"]': {
      color: prefs.value.noterefColor,
      "text-decoration": `${noterefDeco} !important`,
    },
  });

  rendition.themes.select("user");
  rendition.themes.fontSize(`${prefs.value.fontSizePct}%`);
}

    function safeDecodeURIComponent(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function normalizePath(p: string) {
  const cleaned = (p || "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/g, "");
  const parts: string[] = [];
  for (const seg of cleaned.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function joinPath(dir: string, file: string) {
  const d = (dir || "").replace(/\/+/g, "/").replace(/\/+$/g, "");
  const f = (file || "").replace(/\/+/g, "/").replace(/^\/+/g, "");
  return normalizePath(d ? `${d}/${f}` : f);
}

function looksLikeNoterefHref(href: string) {
  return !!href && href.includes("#") && /#(fn[-_]?|footnote|note|endnote)/i.test(href);
}

async function updateViewerPads() {
  await nextTick();

  const topH = chrome.value && topChromeEl.value ? topChromeEl.value.offsetHeight : 0;
  const botH = chrome.value && bottomChromeEl.value ? bottomChromeEl.value.offsetHeight : 0;

  topPadPx.value = topH;
  bottomPadPx.value = botH;

  // keeps text above bottom controls inside iframe
  iframeBottomPadPx.value = Math.max(24, botH + 24);
  applyTheme();
}

watch(chrome, updateViewerPads);

onMounted(() => {
  updateViewerPads();
  window.addEventListener("resize", updateViewerPads);
});
onBeforeUnmount(() => window.removeEventListener("resize", updateViewerPads));



    
    async function updateMetaPatch(patch: Partial<Omit<BookMeta, "id" | "addedAt">>) {
      const books = await loadBooks();
      const i = books.findIndex(b => b.id === props.id);
      if (i < 0) return;
      const current = books[i];
if (!current) return;
books[i] = { ...current, ...patch };
await saveBooks(books);
bookMeta.value = books[i] ?? null;
    }
    
    async function initSearch() {
      if (!book) return { idx: makeIndex(), hrefText: {}, fromCache: false };

  indexing.value = true;
  idxReady.value = false;

  try {
    console.info("[search] init", { spine: book.spine?.items?.length ?? 0 });

    const res = await ensureIndex(props.id, book, (done, total, fromCache) => {
      indexDone.value = done;
      indexTotal.value = total;
      indexFromCache.value = fromCache;
    });

    idx = res.idx;
    hrefText = res.hrefText;

    spineOrder.value = (book?.spine?.items ?? [])
  .map((it: any) => normalizePath(String(it?.href || "")))
  .filter((h: string) => !!h && !!hrefText[h]);


    const total = Object.values(hrefText).reduce((a, t) => a + (t?.length || 0), 0);
const first = Object.entries(hrefText)[0];
console.info("[search] text", { totalChars: total, firstHref: first?.[0], firstSample: first?.[1]?.slice(0, 120) });



    idxReady.value = true;

    results.value = q.value.trim() ? doSearch(idx, hrefText, q.value.trim()) : [];


    console.info("[search] ready", {
      chapters: Object.keys(hrefText).length,
      fromCache: res.fromCache,
    });

    (window as any).__readerDebug = {
      status: () => ({
        ready: idxReady.value,
        done: indexDone.value,
        total: indexTotal.value,
        fromCache: indexFromCache.value,
        chapters: Object.keys(hrefText).length,
      }),
      search: (qq: string) => (idx ? doSearch(idx, hrefText, qq) : []),
    };
  } catch (e) {
    console.error("[search] failed", e);
  } finally {
    indexing.value = false;
  }
}
    
let searchTimer: number | null = null;

watch(q, () => {
  if (searchTimer) window.clearTimeout(searchTimer);

  const qq = q.value.trim();
  if (!qq || !idxReady.value || !idx) {
    results.value = [];
    return;
  }

  searchTimer = window.setTimeout(() => {
    results.value = doSearch(idx, hrefText, qq);
  }, 200);
});

watch(chrome, () => applyTheme());
    
    async function jump(href: string) {
      closeModal();
      chrome.value = true;
      await rendition.display(href);
    }
    
    async function showStats() {
      const t = await totals(props.id);
      const mins = Math.round(t.totalSeconds / 60);
      openModal("Reading analytics", `<p>Total: <b>${mins}</b> minutes across <b>${t.totalSessions}</b> sessions.</p>`);
    }


function candidateHrefs(baseHref: string, filePart: string, book: any) {
  const fpRaw = safeDecodeURIComponent(filePart || "").trim();
  const baseRaw = safeDecodeURIComponent(baseHref || "").trim();

  const fp = normalizePath(fpRaw);
  const base = normalizePath(baseRaw);

  const dir = base.includes("/") ? base.slice(0, base.lastIndexOf("/") + 1) : "";

  const cands = new Set<string>();

  // Spec-correct: resolve relative to current chapter folder
  if (fp) cands.add(joinPath(dir, fp));
  // Also try as-is
  if (fp) cands.add(fp);

  // Fallback pool: spine + manifest XHTML items
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

  return [...cands];
}

async function loadDocForHref(filePart: string, currentDoc: Document | null, baseHrefHint: string) {
  const baseHref = baseHrefHint || rendition?.location?.start?.href || bookMeta.value?.lastHref || "";

  // Same-file reference: use currentDoc if provided, otherwise load base file
  if (!filePart) {
    if (currentDoc) return { doc: currentDoc, hrefUsed: baseHref };
    if (!baseHref) return { doc: document.implementation.createHTMLDocument(""), hrefUsed: "" };

    const raw = await Promise.race([
      book.load(baseHref),
      new Promise((_, rej) => setTimeout(() => rej(new Error("book.load timeout")), 2500)),
    ]);
    return { doc: parseXhtml(raw), hrefUsed: baseHref };
  }

  const cands = candidateHrefs(baseHref, filePart, book);

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

async function handleNoterefClick(a: HTMLAnchorElement, currentDoc: Document, baseHrefHint: string) {
  const href0 = a.getAttribute("href") || "";
  const clicked = (a.textContent || "").trim();
  if (!href0) return;

  if (/^(https?:|mailto:|tel:)/i.test(href0)) return;

  const [filePartRaw, fragRaw] = href0.split("#");
  const filePart = (filePartRaw || "").trim();
  const frag = (fragRaw || "").trim();
  if (!frag) return;

  const fragDecoded = safeDecodeURIComponent(frag).replace(/^#/, "");

  modalLoading.value = true;
  modalOpen.value = true;
  modalTitle.value = "Loading…";
  modalHtml.value = "";
  modalBaseHref.value = null;

  const showFromElement = (el: HTMLElement, titleHint: string | undefined, hrefForModal: string) => {
    const clone = el.cloneNode(true) as HTMLElement;
    const title =
      titleHint ||
      clone.querySelector(".sr-only strong")?.textContent?.trim() ||
      clone.querySelector(".sr-only")?.textContent?.trim() ||
      clicked ||
      fragDecoded;

    clone.querySelectorAll(".sr-only").forEach(n => n.remove());
    clone.querySelectorAll("script, iframe, object, embed").forEach(n => n.remove());

    modalTitle.value = title;
    modalHtml.value = `<div class="space-y-2 leading-relaxed">${clone.innerHTML}</div>`;
    modalBaseHref.value = hrefForModal;
  };

  try {
    // 1) Same-document fast path
    for (const id of idKeys(fragDecoded)) {
      const el = findById(currentDoc, id);

      if (el) {
        showFromElement(el, undefined, baseHrefHint || rendition?.location?.start?.href || bookMeta.value?.lastHref || "");
        return;
      }
    }

    // 2) Load referenced XHTML (handles OEBPS/EPUB/ subfolders)
    try {
      const { doc, hrefUsed } = await loadDocForHref(filePart, filePart ? null : currentDoc, baseHrefHint);
      for (const id of idKeys(fragDecoded)) {
        const el2 = findById(doc, id);

        if (el2) {
          showFromElement(el2, undefined, hrefUsed || baseHrefHint);
          return;
        }
      }
    } catch {}

    // 3) Global scan spine+manifest (still EPUB content!)
    await ensureFootnoteIndex();
    for (const k of idKeys(fragDecoded)) {
      const hit = footnoteIndex[k];
      if (hit) {
        modalTitle.value = hit.title || clicked || fragDecoded;
        modalHtml.value = hit.html;
        modalBaseHref.value = hit.href || baseHrefHint;
        return;
      }
    }

    // 4) Only now: dictionary fallback
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
   
    function escapeHtml(s: string) {
      return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
    }
    
    async function handleSelection(cfiRange: string) {
      // epub.js gives a CFI range; we can pull text via book.getRange
      try {
        const range = await book.getRange(cfiRange);
        const selectedText = safeText(range?.toString());
        if (!selectedText) return;
    
        const sectionLabel =
  currentTocLabelForRange(range) ?? (await currentChapterLabel());

  const suraLabel =
  profile.value === "quran"
    ? (currentTocLabelForRange(range, (s) => /^sura\b/i.test(s)) ?? undefined)
    : undefined;

const place = suraLabel ?? sectionLabel;

        const quote = buildQuoteText({
            profile:profile.value,
          selectedText,
          title: bookMeta.value?.title || "Untitled",
          author: bookMeta.value?.author,
          section: place,
  chapter: place, // keep if your buildQuoteText still expects chapter
        });
    
        // quick action modal
        openModal("Selection", `
          <p class="opacity-70">${escapeHtml(selectedText)}</p>
          <div class="mt-3 flex flex-wrap gap-2">
            <button id="btn-quote" class="btn btn-primary btn-sm">Copy quote</button>
            <button id="btn-define" class="btn btn-outline btn-sm">Define first word</button>
          </div>
        `);
    
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
            openModal(`Define: ${escapeHtml(first)}`, def ? `<pre class="whitespace-pre-wrap">${escapeHtml(def)}</pre>` : `<p>No definition found.</p>`);
          });
        }, 0);
    
      } catch {}
    }
    
    function currentTocLabelForRange(
  range: Range,
  prefer?: (label: string) => boolean
): string | undefined {
  const href = rendition?.location?.start?.href || bookMeta.value?.lastHref;
  if (!href) return undefined;

  const file = href.split("#")[0];
  const matches = tocFlat.value.filter(it => (it.href || "").split("#")[0] === file);
  if (!matches.length) return undefined;

  const doc = range.startContainer?.ownerDocument;

  // 1) Try fragment-aware “nearest above selection”
  if (doc) {
    let best: TocFlat | null = null;

    for (const it of matches) {
      if (prefer && !prefer(it.label)) continue;

      const frag = (it.href || "").split("#")[1];
      if (!frag) continue;

      const el = doc.getElementById(frag);
      if (!el) continue;

      try {
        const r = doc.createRange();
        r.selectNode(el);

        if (r.compareBoundaryPoints(Range.START_TO_START, range) <= 0) {
          if (!best || it.depth > best.depth) best = it;
          else if (best && it.depth === best.depth) best = it; // later wins
        }
      } catch {}
    }

    if (best) return best.label;
  }

  // 2) Fallback: deepest item in the file that matches predicate (or deepest overall)
  const pool = prefer ? matches.filter(it => prefer(it.label)) : matches;
  if (!pool.length) return undefined;

  let best = pool[0]!;
  for (const it of pool) {
    if (it.depth > best.depth) best = it;
    else if (it.depth === best.depth) best = it; // later wins
  }
  return best.label;
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
    
    async function open() {
      const books = await loadBooks();
      const meta = books.find(b => b.id === props.id) || null;
      bookMeta.value = meta;
      if (!meta) { router.push("/"); return; }
    
      const blob = await loadBookFile(props.id);
      if (!blob) { router.push("/"); return; }
    
      // Create epub.js Book
      book = ePub(await blob.arrayBuffer());
      await book.ready;
      tocItems.value = (book.navigation?.toc ?? []) as TocItem[];


      book.spine.hooks.serialize.register((output: string) => {
  return output.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "");
});

    
      // metadata
      const md = await book.loaded.metadata;
      const title = safeText(md?.title) || meta.title;
      const author = safeText(md?.creator) || meta.author || "";
    
      // detect profile (Quran vs default) from sample
      let sampleText = "";
      try {
        const firstHref = book.spine.items?.[0]?.href;
        const raw = await book.load(firstHref);
        const doc = new DOMParser().parseFromString(String(raw), "text/html");
        sampleText = (doc.body?.textContent || "").slice(0, 6000);
      } catch {}
      profile.value = detectProfileFromMetadata(title, author, sampleText);
    
      await updateMetaPatch({ title, author, profile: profile.value });


    
      // Render
      rendition = book.renderTo(viewer.value!, { width: "100%", height: "100%", spread: "none",  manager: "continuous",
      flow: "scrolled-doc" });

      rendition.on("rendered", async (section: any, contents: any) => {
  const p = pendingSearch.value;
  if (!p) return;

  const sh = (section?.href || "").split("#")[0];
  const th = (p.href || "").split("#")[0];
  if (!sh || sh !== th) return;

  pendingSearch.value = null;
  const res = await scrollToQueryInRendered(contents, p.query, p.occurrence);

  if (activeSearch.value && activeSearch.value.href.split("#")[0] === th) {
  // Don’t overwrite the global total; only clamp occurrence for this chapter if needed
  if (res.total > 0) {
    activeSearch.value.occurrence = Math.min(activeSearch.value.occurrence, Math.max(0, res.total - 1));
  }
}

});

rendition.hooks.content.register((contents: any) => {
  const doc = contents.document as Document;

  const updateSel = () => {
    const sel = doc.getSelection?.();
    hasIframeSelection.value = !!sel && !!sel.toString().trim();
  };

  doc.addEventListener("selectionchange", updateSel);
  doc.addEventListener("pointerup", updateSel as any, { passive: true } as any);
  doc.addEventListener("pointerdown", () => { hasIframeSelection.value = false; }, { passive: true } as any);

  doc.querySelectorAll("script").forEach(s => s.remove());
    
        // hide inline footnotes block in page (we show them via popup)
        try {
          contents.addStylesheetRules({
            "#inline-footnotes": { display: "none !important" },
            ".sr-only": { display: "none !important" },
          });
        } catch {}
    
        // intercept noterefs
        doc.addEventListener(
  "click",
  async (ev: MouseEvent) => {
    const target = ev.target as Element | null;
    const a = (target?.closest?.("a") as HTMLAnchorElement | null) ?? null;

    // Footnote/glossary popup
    if (a && isNoterefAnchor(a)) {
      ev.preventDefault();
      ev.stopPropagation();
      await handleNoterefClick(
        a,
        doc,
        contents?.section?.href || rendition?.location?.start?.href || bookMeta.value?.lastHref || ""
      );
      return;
    }

    // Study mode: tap anywhere (non-link) toggles UI
    if (prefs.value.studyMode && !a) {
      const sel = doc.getSelection?.();
      if (sel && sel.toString().trim()) return;

      const now = Date.now();
      if (now - lastChromeToggleAt < 250) return; // avoid double-fire on mobile
      lastChromeToggleAt = now;

      chrome.value = !chrome.value;
      ev.preventDefault();
      ev.stopPropagation();
    }
  },
  true
);
    
      rendition.on("selected", (cfiRange: string) => handleSelection(cfiRange));
    
      rendition.on("relocated", async (loc: any) => {
        const cfi = loc?.start?.cfi;
        const href = loc?.start?.href;
        const pct = loc?.start?.percentage;
        await updateMetaPatch({ lastCfi: cfi, lastHref: href, lastProgress: pct });
      });
    
      await rendition.display(meta.lastCfi || undefined);
      applyTheme();
    
      // analytics session
      const s = await startSession(props.id);
      sessionId = s.id;
    
      // search index (first open might take a bit)
      initSearch();
    }

    watch(() => prefs.value.studyMode, (v) => {
  if (v) chrome.value = false;
  else chrome.value = true;
});

    
    watch(prefs, async () => {
      await savePrefs(props.id, prefs.value);
      applyTheme();
    }, { deep: true });
    
    onMounted(async () => {
      window.addEventListener("keydown", onKeydown);
  prefs.value = await loadPrefs(props.id).catch(() => DEFAULT_PREFS);
  await open();
});

onBeforeUnmount(async () => {
  window.removeEventListener("keydown", onKeydown);
  try {
    if (rendition) rendition.destroy();
  } catch {}

  try {
    if (book) book.destroy?.();
  } catch {}

  rendition = null;
  book = null;

  if (sessionId) {
    try {
      await endSession(props.id, sessionId);
    } catch {}
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
              <button class="btn btn-ghost btn-sm" @click="back">← Library</button>
              <div class="ml-2 truncate font-semibold">{{ bookMeta?.title }}</div>
            </div>
            <div class="flex-none gap-2">
              <button class="btn btn-sm" @click="openToc">TOC</button>
              <button class="btn btn-sm" @click.stop="openSearchModal">Search</button>
              <button class="btn btn-sm btn-outline" @click="showStats">Stats</button>
            </div>
          </div>
        </div>
    
        <!-- Reader surface -->
        <div class="h-full w-full" :style="viewerPadStyle">
          <div ref="viewer" class="h-full w-full"></div>
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
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="7"></circle>
            <path d="M21 21l-4.3-4.3"></path>
          </svg>
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
              >‹</button>
              <button
                class="btn btn-outline join-item"
                :disabled="!q.trim() || indexing || !idxReady || hitTotal === 0 || hasIframeSelection"
                @click.stop="gotoMatch(1)"
                aria-label="Next match"
              >›</button>
            </div>
    
            <div class="mt-1 text-xs opacity-70 flex items-center justify-between gap-3">
              <span v-if="indexing">Indexing…</span>
              <span v-else>Search ready ({{ Object.keys(hrefText).length }} chapters{{ indexFromCache ? ", cached" : "" }})</span>
              <span v-if="q.trim() && hitTotal > 0">Match {{ ((activeSearch as any)?.global ?? -1) + 1 }} / {{ hitTotal }}</span>
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
        