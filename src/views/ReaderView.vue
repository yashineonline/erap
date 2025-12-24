<script setup lang="ts">
    import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
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
    import { ensureIndex, search as doSearch } from "../lib/search";
    import { startSession, endSession, totals } from "../lib/analytics";
    import { safeText } from "../lib/epub";
    import type { ReaderPrefs } from "../lib/types";
    
    const prefs = ref<ReaderPrefs>(DEFAULT_PREFS);
    const props = defineProps<{ id: string }>();
    const router = useRouter();
    
    const viewer = ref<HTMLDivElement|null>(null);
    const chrome = ref(true);
    
    const bookMeta = ref<BookMeta|null>(null);
    const profile = ref<BookProfile>("default");
    
    let lastChromeToggleAt = 0;


    const indexing = ref(false);
    const q = ref("");
    const results = ref<{ href: string; snippet: string }[]>([]);

    const pendingSearch = ref<{ href: string; query: string } | null>(null);

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
  }
  if ((e.key === "t" || e.key === "T") && chrome.value) {
    tocOpen.value = !tocOpen.value;
  }
}




function findRangeForQuery(doc: Document, query: string): Range | null {
  const q = query.trim();
  if (!q) return null;

  const nodes: Text[] = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    if (t.data && t.data.trim()) nodes.push(t);
  }

  const full = nodes.map(n => n.data).join("");
  const idx = full.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return null;

  const endIdx = idx + q.length;
  let startNode: Text | null = null, endNode: Text | null = null;
  let startOffset = 0, endOffset = 0;

  let cum = 0;
  for (const n of nodes) {
    const len = n.data.length;

    if (!startNode && idx < cum + len) {
      startNode = n;
      startOffset = idx - cum;
    }
    if (!endNode && endIdx <= cum + len) {
      endNode = n;
      endOffset = endIdx - cum;
      break;
    }
    cum += len;
  }

  if (!startNode) return null;
  if (!endNode) { endNode = startNode; endOffset = Math.min(startNode.data.length, startOffset + q.length); }

  const r = doc.createRange();
  r.setStart(startNode, Math.max(0, startOffset));
  r.setEnd(endNode, Math.max(0, endOffset));
  return r;
}

async function scrollToQueryInRendered(contents: any, query: string) {
  const doc = contents?.document as Document | undefined;
  if (!doc?.body) return;

  const range = findRangeForQuery(doc, query);
  if (!range) return;

  // Compute CFI then display to scroll exactly
  try {
    const cfi = contents.cfiFromRange(range);
    if (cfi) await rendition.display(cfi);
  } catch {}

  // Fallback (still helps in some engines)
  try {
    const el = (range.startContainer as any)?.parentElement as HTMLElement | null;
    el?.scrollIntoView?.({ block: "center" });
  } catch {}
}

async function jumpToSearch(r: { href: string }) {
  const query = q.value.trim();
  closeModal();
  chrome.value = true;

  if (!query) {
    await rendition.display(r.href);
    return;
  }

  pendingSearch.value = { href: r.href, query };
  await rendition.display(r.href);
}



    let idx: any = null;
    let hrefText: Record<string, string> = {};
    


    const modalOpen = ref(false);
    const modalTitle = ref("");
    const modalHtml = ref<string>("");
const modalBaseHref = ref<string | null>(null);

    const modalLoading = ref(false);
    
    let book: any = null;
    let rendition: any = null;
    // let glossary: Record<string, any> = {};
    let sessionId: string | null = null;
    
    const topPad = computed(() => chrome.value ? "pt-24" : "pt-0");
const botPad = computed(() => chrome.value ? "pb-32" : "pb-0");

    // const topPad = computed(() => (chrome.value && !prefs.value.studyMode) ? "pt-24" : "pt-0");
    // const botPad = computed(() => (chrome.value && !prefs.value.studyMode) ? "pb-32" : "pb-0");
    
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

// function parseXhtml(raw: any): Document {
//   const s = String(raw ?? "");
//   let d = new DOMParser().parseFromString(s, "application/xhtml+xml");
//   if (d.getElementsByTagName("parsererror").length) {
//     d = new DOMParser().parseFromString(s, "text/html");
//   }
//   return d;
// }

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

    
    function toggleChrome() {
      // don’t toggle when clicking controls
      chrome.value = !chrome.value;
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




    
    async function updateMetaPatch(patch: Partial<Omit<BookMeta, "id" | "addedAt">>) {
    // async function updateMetaPatch(patch: Partial<BookMeta>) {
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
      if (!book) return;
      indexing.value = true;
      try {
        const res = await ensureIndex(props.id, book);
        idx = res.idx;
        hrefText = res.hrefText;
      } finally {
        indexing.value = false;
      }
    }
    
    watch(q, () => {
      if (!idx) return;
      results.value = q.value.trim() ? doSearch(idx, hrefText, q.value.trim()) : [];
    });
    
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
    
        const chapterLabel = await currentChapterLabel();
        const quote = buildQuoteText({
            profile:profile.value,
          selectedText,
          title: bookMeta.value?.title || "Untitled",
          author: bookMeta.value?.author,
          chapter: chapterLabel,
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
  await scrollToQueryInRendered(contents, p.query);
});

    
      rendition.hooks.content.register((contents: any) => {
        const doc = contents.document as Document;
        doc.querySelectorAll("script").forEach(s => s.remove());

    
        // hide inline footnotes block in page (we show them via popup)
        try {
          contents.addStylesheetRules({
            "#inline-footnotes": { display: "none !important" },
            ".sr-only": { display: "none !important" },
          });
        } catch {}
    
        // intercept noterefs
        doc.addEventListener("click", async (ev: MouseEvent) => {
          const target = ev.target as Element | null;
          const a = target?.closest?.("a") as HTMLAnchorElement | null;
          if (!a) return;
    
          // Footnote/glossary popup
  if (a && isNoterefAnchor(a)) {
          // if (isNoterefAnchor(a)) {
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
        }, true);
      });
    
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
      await initSearch();
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
        <div v-if="chrome" class="fixed top-0 left-0 right-0 z-30 bg-base-200/95 backdrop-blur border-b border-base-300">
          <div class="navbar">
            <div class="flex-1 min-w-0">
              <button class="btn btn-ghost btn-sm" @click="back">← Library</button>
              <div class="ml-2 truncate font-semibold">{{ bookMeta?.title }}</div>
            </div>
            <div class="flex-none gap-2">
              <button class="btn btn-sm" @click="openToc">TOC</button>
              <button class="btn btn-sm btn-outline" @click="showStats">Stats</button>
            </div>
          </div>
    
          <div class="px-3 pb-3">
            <input class="input input-bordered w-full" placeholder="Search in book…" v-model="q" />
            <div v-if="indexing" class="text-xs opacity-60 mt-1">Indexing… first time can take a bit.</div>
            <div v-if="results.length" class="mt-2 max-h-56 overflow-auto bg-base-100 rounded-xl border border-base-300">
              <div v-for="r in results" :key="r.href" class="p-2 hover:bg-base-200 cursor-pointer" @click="jumpToSearch(r)"              >
                <div class="text-xs opacity-60">{{ r.href }}</div>
                <div class="text-sm">{{ r.snippet }}</div>
              </div>
            </div>
          </div>
        </div>
    
        <!-- Reader surface -->
        <div :class="[topPad, botPad]" class="h-full" @click="toggleChrome">
          <div ref="viewer" class="h-full w-full"></div>
        </div>
    
        <!-- Bottom chrome -->
        <div v-if="chrome" class="fixed bottom-0 left-0 right-0 z-30 bg-base-200/95 backdrop-blur border-t border-base-300" @click.stop>
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


            <label class="form-control col-span-2">

              <label class="form-control">
  <div class="label"><span class="label-text">Glossary link color</span></div>
  <input type="color" v-model="prefs.noterefColor" class="input input-bordered h-10 p-1" />
</label>

<label class="form-control">
  <div class="label"><span class="label-text">Underline glossary links</span></div>
  <label class="flex items-center gap-2 cursor-pointer">
    <input type="checkbox" class="toggle" v-model="prefs.noterefUnderline" />
    <span class="text-sm opacity-70">Toggle</span>
  </label>
</label>





              <div class="label"><span class="label-text">Study mode</span></div>
              <label class="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" class="toggle" v-model="prefs.studyMode" />
                <span class="text-sm opacity-70">Hide UI (tap screen to show/hide)</span>
              </label>
            </label>
          </div>
        </div>

        <button
  v-if="!chrome"
  class="fixed z-50 btn btn-sm opacity-80 hover:opacity-100"
  style="top: calc(env(safe-area-inset-top) + 0.75rem); right: 0.75rem;"
  @click="chrome = true"
  aria-label="Show controls"
>
  Show controls
</button>

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

    
        <Modal :open="modalOpen" :title="modalTitle" @close="closeModal">
          <div v-if="modalLoading" class="opacity-70">Loading…</div>
          <div v-else class="space-y-2" @click="onModalClick" v-html="modalHtml"></div>
        </Modal>
      </div>
    </template>
    