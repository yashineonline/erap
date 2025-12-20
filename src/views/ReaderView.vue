<script setup lang="ts">
    import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
    import { useRouter } from "vue-router";
    import ePub from "epubjs";
    
    import Modal from "../components/Modal.vue";
    
    import type { BookMeta, BookProfile } from "../lib/types";
    import { loadBooks, saveBooks, loadBookFile, loadPrefs, savePrefs } from "../lib/storage";
    import { DEFAULT_PREFS } from "../lib/storage";
    import { extractInlineFootnotes, isNoterefAnchor } from "../lib/glossary";
    import { defineWordFallback } from "../lib/dictionary";
    import { detectProfileFromMetadata } from "../lib/profiles";
    import { buildQuoteText } from "../lib/quote";
    import { ensureIndex, search as doSearch } from "../lib/search.ts";
    import { startSession, endSession, totals } from "../lib/analytics";
    import { safeText } from "../lib/epub";
    
    const props = defineProps<{ id: string }>();
    const router = useRouter();
    
    const viewer = ref<HTMLDivElement|null>(null);
    const chrome = ref(true);
    
    const bookMeta = ref<BookMeta|null>(null);
    const profile = ref<BookProfile>("default");
    
      const prefs = ref(DEFAULT_PREFS);
  
    // const prefs = ref(await loadPrefs(props.id).catch(() => DEFAULT_PREFS));
    
    const indexing = ref(false);
    const q = ref("");
    const results = ref<{ href: string; snippet: string }[]>([]);
    let idx: any = null;
    let hrefText: Record<string, string> = {};
    
    const modalOpen = ref(false);
    const modalTitle = ref("");
    const modalHtml = ref("");
    const modalLoading = ref(false);
    
    let book: any = null;
    let rendition: any = null;
    let glossary: Record<string, any> = {};
    let sessionId: string | null = null;
    
    const topPad = computed(() => (chrome.value && !prefs.value.studyMode) ? "pt-24" : "pt-0");
    const botPad = computed(() => (chrome.value && !prefs.value.studyMode) ? "pb-32" : "pb-0");
    
    function openModal(title: string, html: string) {
      modalTitle.value = title;
      modalHtml.value = html;
      modalOpen.value = true;
    }
    function closeModal() { modalOpen.value = false; }
    
    async function back() {
      if (sessionId) await endSession(props.id, sessionId);
      router.push("/");
    }
    
    function applyTheme() {
      if (!rendition) return;
    
      rendition.themes.register("user", {
        body: {
          background: prefs.value.bg,
          color: prefs.value.fg,
          "font-family": prefs.value.font,
          "line-height": String(prefs.value.lineHeight),
          margin: `${prefs.value.marginEm}em`,
          "text-align": `${prefs.value.textAlign} !important`,
        },
        a: { color: prefs.value.fg, "text-decoration": "underline" },
        p: { "text-align": `${prefs.value.textAlign} !important` },
      });
      rendition.themes.select("user");
      rendition.themes.fontSize(`${prefs.value.fontSizePct}%`);
    }
    
    function toggleChrome() {
      // don’t toggle when clicking controls
      chrome.value = !chrome.value;
    }

    function normalizePath(p: string) {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function resolveSpineHref(baseHref: string | undefined, targetFile: string) {
  const t = targetFile.replace(/^\/+/, ""); // remove leading slashes
  if (!baseHref) return t;

  const base = baseHref.replace(/^\/+/, "");
  const dir = base.includes("/") ? base.slice(0, base.lastIndexOf("/") + 1) : "";
  return normalizePath(dir + t);
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

    //   books[i] = { ...books[i], ...patch };
    //   await saveBooks(books);
    //   bookMeta.value = books[i];
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

    function normalizeTerm(s: string) {
  return (s || "")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/^[']+/, "")                // drop leading apostrophes
    .replace(/[^a-z0-9\s'-]+/g, " ")     // keep simple chars
    .replace(/\s+/g, " ")
    .trim();
}

function extractDlGlossary(doc: Document) {
  // Map normalized term -> { label, html }
  const out: Record<string, { label: string; html: string }> = {};
  const dls = Array.from(doc.querySelectorAll("dl"));

  for (const dl of dls) {
    const kids = Array.from(dl.children) as HTMLElement[];
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      if (!el || el.tagName.toLowerCase() !== "dt") continue;

      const dd = kids[i + 1];
      if (!dd || dd.tagName.toLowerCase() !== "dd") continue;

      const rawLabel = (el.textContent || "").trim();
      const defHtml = (dd.innerHTML || "").trim();
      if (!rawLabel || !defHtml) continue;

      // dt can contain multiple names: "'abd, 'abid"
      const names = rawLabel.split(/[;,]/).map(x => x.trim()).filter(Boolean);
      for (const name of names) {
        const key = normalizeTerm(name);
        if (key) out[key] = { label: name, html: defHtml };
      }
    }
  }
  return out;
}

async function handleNoterefClick(a: HTMLAnchorElement, currentDoc: Document) {
  const href0 = a.getAttribute("href") || "";
  const [filePartRaw, fragRaw] = href0.split("#");
  const frag = fragRaw ? decodeURIComponent(fragRaw).trim() : "";
  if (!frag) return;

  modalLoading.value = true;
  modalOpen.value = true;
  modalTitle.value = "Loading…";
  modalHtml.value = "";

  try {
    // Decide which document to search
    let doc = currentDoc;

    // If link points to another file, load it (folder-aware)
    const filePart = (filePartRaw || "").trim();
    if (filePart) {
      const baseHref =
        rendition?.location?.start?.href ||
        bookMeta.value?.lastHref ||
        "";

      const resolved = resolveSpineHref(baseHref, filePart);

      const raw = await Promise.race([
        book.load(resolved),
        new Promise((_, rej) => setTimeout(() => rej(new Error("book.load timeout")), 2000)),
      ]);

      doc = new DOMParser().parseFromString(String(raw), "text/html");
    }

    // 1) Calibre-style: target by fragment id (#fn-nafs)
    const target = doc.getElementById(frag) as HTMLElement | null;
    if (target) {
      const clone = target.cloneNode(true) as HTMLElement;
      // remove screen-reader-only label blocks (we use them as title)
      const srStrong = clone.querySelector(".sr-only strong")?.textContent?.trim();
      clone.querySelectorAll(".sr-only").forEach(n => n.remove());

      const fallbackTitle =
        (a.textContent || "").trim() ||
        frag.replace(/^fn-/, "").replace(/^note-/, "");

      modalTitle.value = srStrong || fallbackTitle || frag;
      modalHtml.value = `<div class="space-y-2 leading-relaxed">${clone.innerHTML}</div>`;
      return;
    }

    // 2) fallback: try your extractor map (optional)
    glossary = { ...glossary, ...extractInlineFootnotes(doc) };
    const key1 = frag;
    const key2 = frag.replace(/^fn-/, "");
    const entry = glossary[key1] || glossary[key2] || glossary[`fn-${key2}`];
    if (entry) {
      modalTitle.value = entry.label ?? key2;
      modalHtml.value = `<div class="space-y-2 leading-relaxed">${entry.html}</div>`;
      return;
    }

    // 3) final fallback: dictionary
    const dictKey = frag.replace(/^fn-/, "").replace(/^note-/, "");
    const def = await defineWordFallback(dictKey);
    modalTitle.value = dictKey;
    modalHtml.value = def
      ? `<pre class="whitespace-pre-wrap">${escapeHtml(def)}</pre>`
      : `<p>No definition found.</p>`;
  } finally {
    modalLoading.value = false;
  }
}


// async function handleNoterefClick(a: HTMLAnchorElement, currentDoc: Document) {
//   const href = a.getAttribute("href") || "";
//   const { file, fnKey } = parseFnHref(href);
//   if (!fnKey) return;

//   modalLoading.value = true;
//   modalOpen.value = true;
//   modalTitle.value = "Loading…";
//   modalHtml.value = "";

//   try {
//     // Always ingest from current loaded chapter first (in case it contains inline notes)
//     glossary = { ...glossary, ...extractInlineFootnotes(currentDoc) };

//     // 1) try direct key matches from extracted notes
//     let entry = glossary[fnKey] || glossary[`fn-${fnKey}`];
//     if (entry) {
//       modalTitle.value = entry.label ?? fnKey;
//       modalHtml.value = `<div class="space-y-2 leading-relaxed">${entry.html}</div>`;
//       return;
//     }

//     // 2) load referenced file (folder-aware) and parse it
//     if (file) {
//       const baseHref = rendition?.location?.start?.href || bookMeta.value?.lastHref || "";
//       const resolved = resolveSpineHref(baseHref, file);

//       const raw = await Promise.race([
//         book.load(resolved),
//         new Promise((_, rej) => setTimeout(() => rej(new Error("book.load timeout")), 2000)),
//       ]);

//       const doc2 = new DOMParser().parseFromString(String(raw), "text/html");

//       // 2a) inline footnotes / id-based notes in that file
//       glossary = { ...glossary, ...extractInlineFootnotes(doc2) };
//       entry = glossary[fnKey] || glossary[`fn-${fnKey}`];
//       if (entry) {
//         modalTitle.value = entry.label ?? fnKey;
//         modalHtml.value = `<div class="space-y-2 leading-relaxed">${entry.html}</div>`;
//         return;
//       }

//       // 2b) DL glossary lookup by term (your ch006.xhtml structure)
//       const dlMap = extractDlGlossary(doc2);
//       const key = normalizeTerm(fnKey);
//       const hit = dlMap[key];
//       if (hit) {
//         modalTitle.value = hit.label || fnKey;
//         modalHtml.value = `<div class="space-y-2 leading-relaxed">${hit.html}</div>`;
//         return;
//       }

//       // Sometimes link text is better than fnKey (e.g. fnKey is short/normalized)
//       const linkTextKey = normalizeTerm(a.textContent || "");
//       const hit2 = dlMap[linkTextKey];
//       if (hit2) {
//         modalTitle.value = hit2.label || (a.textContent || fnKey);
//         modalHtml.value = `<div class="space-y-2 leading-relaxed">${hit2.html}</div>`;
//         return;
//       }
//     }

//     // 3) fallback: dictionary
//     const def = await defineWordFallback(fnKey);
//     modalTitle.value = fnKey;
//     modalHtml.value = def
//       ? `<pre class="whitespace-pre-wrap">${escapeHtml(def)}</pre>`
//       : `<p>No definition found.</p>`;
//   } finally {
//     modalLoading.value = false;
//   }
// }

    
//     async function handleNoterefClick(a: HTMLAnchorElement, currentDoc: Document) {
//       const href = a.getAttribute("href") || "";
//       const { file, fnKey } = parseFnHref(href);
//       if (!fnKey) return;
    
//       modalLoading.value = true;
//       modalOpen.value = true;
//       modalTitle.value = "Loading…";
//       modalHtml.value = "";
    
//       try {

// // 1) Always parse from the current loaded chapter first (fast + reliable)
// glossary = { ...glossary, ...extractInlineFootnotes(currentDoc) };
// let entry = glossary[fnKey];

// // 2) If not found, only then try to load the referenced file (with a timeout)
// if (!entry && file) {
// const baseHref = rendition?.location?.start?.href || bookMeta.value?.lastHref || "";
// const resolved = resolveSpineHref(baseHref, file);

//   const raw = await Promise.race([
//     book.load(resolved),
//     new Promise((_, rej) => setTimeout(() => rej(new Error("book.load timeout")), 1500)),
//   ]);
//   const doc2 = new DOMParser().parseFromString(String(raw), "text/html");
//   glossary = { ...glossary, ...extractInlineFootnotes(doc2) };
//   entry = glossary[fnKey];
// }

// if (entry) {
//   modalTitle.value = entry.label ?? fnKey;
//   modalHtml.value = `<div class="space-y-2 leading-relaxed">${entry.html}</div>`;

//   return;
// }
    
    //     // fallback: dictionary for the key
    //     const def = await defineWordFallback(fnKey);
    //     modalTitle.value = fnKey;
    //     modalHtml.value = def ? `<pre class="whitespace-pre-wrap">${escapeHtml(def)}</pre>` : `<p>No definition found.</p>`;
    //   } finally {
    //     modalLoading.value = false;
    //   }
    // }
    
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
        //   const root = document.querySelector(".modal .card-body") as HTMLElement | null;
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
    
          if (isNoterefAnchor(a)) {
            ev.preventDefault();
            ev.stopPropagation();
            await handleNoterefClick(a, doc);
            return;
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
    
    watch(prefs, async () => {
      await savePrefs(props.id, prefs.value);
      applyTheme();
    }, { deep: true });
    
    onMounted(async () => {
  prefs.value = await loadPrefs(props.id).catch(() => DEFAULT_PREFS);
  await open();
});

    
    onBeforeUnmount(async () => {
      if (sessionId) await endSession(props.id, sessionId);
    });
    </script>
    
    <template>
      <div class="h-full bg-base-100">
        <!-- Top chrome -->
        <div v-if="chrome && !prefs.studyMode" class="fixed top-0 left-0 right-0 z-30 bg-base-200/95 backdrop-blur border-b border-base-300">
          <div class="navbar">
            <div class="flex-1 min-w-0">
              <button class="btn btn-ghost btn-sm" @click="back">← Library</button>
              <div class="ml-2 truncate font-semibold">{{ bookMeta?.title }}</div>
            </div>
            <div class="flex-none gap-2">
              <button class="btn btn-sm btn-outline" @click="showStats">Stats</button>
            </div>
          </div>
    
          <div class="px-3 pb-3">
            <input class="input input-bordered w-full" placeholder="Search in book…" v-model="q" />
            <div v-if="indexing" class="text-xs opacity-60 mt-1">Indexing… first time can take a bit.</div>
            <div v-if="results.length" class="mt-2 max-h-56 overflow-auto bg-base-100 rounded-xl border border-base-300">
              <div v-for="r in results" :key="r.href" class="p-2 hover:bg-base-200 cursor-pointer" @click="jump(r.href)">
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
        <div v-if="chrome && !prefs.studyMode" class="fixed bottom-0 left-0 right-0 z-30 bg-base-200/95 backdrop-blur border-t border-base-300" @click.stop>
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
              <div class="label"><span class="label-text">Study mode</span></div>
              <label class="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" class="toggle" v-model="prefs.studyMode" />
                <span class="text-sm opacity-70">Hide UI (tap screen to show/hide)</span>
              </label>
            </label>
          </div>
        </div>
    
        <Modal :open="modalOpen" :title="modalTitle" @close="closeModal">
          <div v-if="modalLoading" class="opacity-70">Loading…</div>
          <div v-else v-html="modalHtml"></div>
        </Modal>
      </div>
    </template>
    