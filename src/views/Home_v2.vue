<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import { useRouter } from "vue-router";
import Modal from "../components/Modal.vue";
import DailyQuoteCard from "../components/DailyQuoteCard.vue";
import Onboarding from "../components/Onboarding.vue";

import { APP_VERSION, BUILD_DATE_ISO } from "../generated/buildInfo";
import {
  isOnboarded,
  setOnboarded,
  loadBooks,
  saveBooks,
  saveBookFile,
  deleteBook,
  loadUiPrefs,
  saveUiPrefs,
} from "../lib/storage";
import type { BookMeta } from "../lib/types";

// --- state
const router = useRouter();
const books = ref<BookMeta[]>([]);
const showTour = ref(false);

const aboutOpen = ref(false);
const bgOpen = ref(false);

const uiBgDataUrl = ref<string>("");
const uiBgUseCustom = ref(false);

const builtLocal = computed(() =>
  new Date(BUILD_DATE_ISO).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  })
);

const bookshelfStyle = computed(() => {
  const url = uiBgUseCustom.value && uiBgDataUrl.value
    ? uiBgDataUrl.value
    : new URL("../assets/bookshelf_bg_modern_v2.png", import.meta.url).toString();

  return {
    backgroundImage: `url('${url}')`,
    backgroundSize: "contain",
    backgroundRepeat: "no-repeat",
    // backgroundSize: "cover",
    backgroundPosition: "center",
  } as Record<string, string>;
});

const NUM_SHELVES = 5;
const BOOKS_PER_SHELF = 8;

const shelfRows = computed(() => {
  const rows: BookMeta[][] = Array.from({ length: NUM_SHELVES }, () => []);
  books.value.forEach((b, i) => rows[Math.floor(i / BOOKS_PER_SHELF)]?.push(b));
  return rows.filter(r => r.length);
});



const TOUR_STEPS = [
  { title: "Import an EPUB", body: "Tap “Import EPUB” to add a book from your device." },
  { title: "Bookshelf", body: "Your books appear as spines on a shelf. Tap a spine to open." },
  { title: "Search", body: "Inside a book, Search jumps to matches and highlights them." },
  { title: "Real Book Feel", body: "Enable “Real Book Feel” for paginated reading + swipe to turn pages." },
  { title: "Read Aloud", body: "Use Read Aloud for device-based audio (Web Speech API)." },
] as const;

const tourOpen = ref(false);
const tourStep = ref(0);
const tourCurrent = computed(() => TOUR_STEPS[tourStep.value] ?? TOUR_STEPS[0]);

function startTour() {
  tourStep.value = 0;
  tourOpen.value = true;
}
function nextTour() {
  if (tourStep.value < TOUR_STEPS.length - 1) tourStep.value++;
}
function prevTour() {
  if (tourStep.value > 0) tourStep.value--;
}
function closeTour() {
  tourOpen.value = false;
}

onMounted(async () => {
  books.value = await loadBooks();
  showTour.value = !(await isOnboarded());

  const ui = await loadUiPrefs();
  uiBgUseCustom.value = Boolean(ui.bookshelfUseCustom);
  uiBgDataUrl.value = ui.bookshelfBgDataUrl || "";
});

async function importEpub(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  const meta: BookMeta = {
    id,
    title: file.name.replace(/\.epub$/i, ""),
    addedAt: Date.now(),
  };

  await saveBookFile(id, file);
  books.value = [meta, ...books.value];
  await saveBooks(books.value);
  input.value = "";

  router.push(`/read/${encodeURIComponent(id)}`);
}

async function openBook(id: string) {
  router.push(`/read/${encodeURIComponent(id)}`);
}

async function removeBook(id: string) {
  await deleteBook(id);
  books.value = await loadBooks();
}

async function finishTour() {
  await setOnboarded();
  showTour.value = false;
}

function spineColor(id: string) {
  // deterministic, dark-but-vivid palette from ID hash
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 55% 32%)`;
}

function spineAccent(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 131 + id.charCodeAt(i)) >>> 0;
  const hue = (h + 40) % 360;
  return `hsl(${hue} 70% 55%)`;
}

async function onPickBg(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });

  uiBgDataUrl.value = dataUrl;
  uiBgUseCustom.value = true;
  await saveUiPrefs({ bookshelfBgDataUrl: dataUrl, bookshelfUseCustom: true });

  input.value = "";
}

async function toggleUseCustom(v: boolean) {
  uiBgUseCustom.value = v;
  await saveUiPrefs({ bookshelfUseCustom: v });
}

function onToggleUseCustom(ev: Event) {
  const input = ev.target as HTMLInputElement | null;
  void toggleUseCustom(Boolean(input?.checked));
}

async function clearCustomBg() {
  uiBgDataUrl.value = "";
  uiBgUseCustom.value = false;
  await saveUiPrefs({ bookshelfBgDataUrl: "", bookshelfUseCustom: false });
}
</script>

<template>
    <div class="navbar bg-base-200/90 backdrop-blur shadow-sm">
      <div class="flex-1 px-2 text-lg font-semibold">
        <span class="mr-2"><i class="fa-solid fa-book"></i></span>
        ERAP Reader
      </div>

      <div class="flex-none gap-2">
        <button class="btn btn-ghost btn-sm" @click="startTour" aria-label="Tour">
          <i class="fa-solid fa-circle-question"></i>
        </button>

        <button class="btn btn-ghost btn-sm" @click="bgOpen = true" aria-label="Bookshelf background">
          <i class="fa-solid fa-image"></i>
        </button>

        <label class="btn btn-primary btn-sm">
          <i class="fa-solid fa-file-import mr-2"></i>
          Import EPUB
          <input type="file" accept=".epub" class="hidden" @change="importEpub" />
        </label>

        <button class="btn btn-ghost btn-sm" @click="aboutOpen = true" aria-label="About">
          <i class="fa-solid fa-circle-info"></i>
        </button>
      </div>
    </div>

    <div class="p-4">
      <DailyQuoteCard />
    </div>

    <div class="px-4 pb-10">
      <div v-if="books.length === 0" class="max-w-3xl mx-auto">
        <div class="alert alert-info bg-base-200/90 backdrop-blur">
          <div>
            <div class="font-semibold">Your bookshelf is empty</div>
            <div class="text-sm opacity-80">Import an EPUB to start.</div>
          </div>
        </div>
      </div>

      <!-- Bookshelf grid: each item is a spine sitting on a shelf -->
      <div v-else class="max-w-6xl mx-auto">
  <div class="shelfStage" :style="bookshelfStyle">
    <div class="shelfOverlay" style="--offx: 260px; --offy: 120px;">
      <div
        v-for="(row, ri) in shelfRows"
        :key="ri"
        class="shelfRow"
      >
        <button
          v-for="b in row"
          :key="b.id"
          class="spine"
          @click="openBook(b.id)"
          :title="b.title"
          :style="{ background: spineColor(b.id) }"
        >
          <div class="spineAccent" :style="{ background: spineAccent(b.id) }"></div>

          <div class="spineTitle">{{ b.title }}</div>

          <button
            class="spineTrash"
            @click.stop="removeBook(b.id)"
            aria-label="Remove"
            title="Remove"
          >
            <i class="fa-solid fa-trash"></i>
          </button>
        </button>
      </div>
    </div>
  </div>
</div>


    <Onboarding v-if="showTour" @done="finishTour" />

    <Modal :open="aboutOpen" title="About ERAP" @close="aboutOpen = false">
      <div class="text-sm space-y-2">
        <div><span class="font-semibold">Version:</span> {{ APP_VERSION }}</div>
        <div><span class="font-semibold">Built:</span> {{ builtLocal }}</div>
      </div>
    </Modal>

    <Modal :open="bgOpen" title="Bookshelf Background" @close="bgOpen = false">
      <div class="space-y-3 text-sm">
        <div class="form-control">
          <label class="label cursor-pointer justify-start gap-3">
            <input
              type="checkbox"
              class="toggle"
              :checked="uiBgUseCustom"
              @change="onToggleUseCustom"
            />
            <span class="label-text">Use my background image</span>
          </label>
        </div>

        <div class="flex flex-wrap gap-2 items-center">
          <label class="btn btn-sm">
            <i class="fa-solid fa-upload mr-2"></i>
            Pick image
            <input type="file" accept="image/*" class="hidden" @change="onPickBg" />
          </label>
          <button class="btn btn-sm btn-ghost" @click="clearCustomBg" :disabled="!uiBgDataUrl">
            <i class="fa-solid fa-eraser mr-2"></i>
            Reset
          </button>
        </div>

        <div class="opacity-75">
          Tip: use a wide image (landscape). The default background is a built-in bookshelf SVG.
        </div>
      </div>
    </Modal>

    <Modal :open="tourOpen" :title="tourCurrent.title" @close="closeTour">
      <div class="space-y-4">
        <p class="text-sm leading-relaxed">{{ tourCurrent.body }}</p>

        <div class="flex items-center justify-between">
          <button class="btn btn-sm" :disabled="tourStep === 0" @click="prevTour">Back</button>

          <div class="text-xs opacity-70">{{ tourStep + 1 }} / {{ TOUR_STEPS.length }}</div>

          <button
            class="btn btn-sm btn-primary"
            @click="tourStep === TOUR_STEPS.length - 1 ? closeTour() : nextTour()"
          >
            {{ tourStep === TOUR_STEPS.length - 1 ? "Done" : "Next" }}
          </button>
        </div>
      </div>
    </Modal>
  </div>
</template>
