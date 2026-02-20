<script setup lang="ts">
    import { onMounted, ref, computed } from "vue";
    import { useRouter } from "vue-router";
    import Modal from "../components/Modal.vue";
    import DailyQuoteCard from "../components/DailyQuoteCard.vue";
    import { APP_VERSION, BUILD_DATE_ISO } from "../generated/buildInfo";
    import Onboarding from "../components/Onboarding.vue";
    import { isOnboarded, setOnboarded, loadBooks, saveBooks, saveBookFile, deleteBook } from "../lib/storage";
    import type { BookMeta } from "../lib/types";
    
    const aboutOpen = ref(false);
    const builtLocal = computed(() =>
  new Date(BUILD_DATE_ISO).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  })
);

// const builtLocal = computed(() => new Date(BUILD_DATE_ISO).toLocaleString());
    const router = useRouter();
    const books = ref<BookMeta[]>([]);
    const showTour = ref(false);
    
    const tourOpen = ref(false);
const tourStep = ref(0);



const TOUR_STEPS = [
  { title: "Import an EPUB", body: "Tap “Import EPUB” to add a book from your device." },
  { title: "Open a book", body: "Tap a book cover/title to enter the reader." },
  { title: "Glossary popups", body: "Tap underlined glossary/footnote links to see the definition popup." },
  { title: "Search", body: "Use search to find text and jump directly to the match." },
  { title: "Study mode", body: "Enable Study Mode, then tap once on the page to show/hide controls." },
] as const;

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
    </script>
    
    <template>
      <div class="min-h-full bg-base-100">
        <div class="navbar bg-base-200 shadow-sm">
          <div class="flex-1 px-2 text-lg font-semibold">Ebook Reader Ansari Publications</div>

          <div class="alert alert-info rounded-none flex items-center justify-between">
  <div class="flex items-center gap-2">
    <span class="font-semibold">Onboarding Tour</span>
    <span class="text-sm opacity-80 hidden sm:inline">Quick guide to get started.</span>
  </div>
  <button class="btn btn-sm" @click="startTour">Start</button>
</div>


          <div class="flex-none">
            <label class="btn btn-primary btn-sm">
              Import EPUB
              <input type="file" accept=".epub" class="hidden" @change="importEpub" />
            </label>
            <button class="btn btn-ghost btn-sm" @click="aboutOpen = true" aria-label="About">
  <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <circle cx="12" cy="12" r="9"></circle>
    <path d="M12 10v7"></path>
    <path d="M12 7h.01"></path>
  </svg>
</button>

          </div>
        </div>
    
        <DailyQuoteCard />
        
        <div class="p-4 max-w-4xl mx-auto">
          <div v-if="books.length===0" class="opacity-70">
            Import an EPUB to start.
          </div>
    
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div v-for="b in books" :key="b.id" class="card bg-base-200 shadow">
              <div class="card-body">
                <div class="font-semibold truncate">{{ b.title }}</div>
                <div class="text-xs opacity-60">{{ new Date(b.addedAt).toLocaleString() }}</div>
                <div class="card-actions justify-end mt-3">
                  <button class="btn btn-ghost btn-sm" @click="removeBook(b.id)">Remove</button>
                  <button class="btn btn-primary btn-sm" @click="openBook(b.id)">Open</button>
                </div>
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

<Modal 
:open="tourOpen" :title="tourCurrent.title" @close="closeTour"
>
<div class="space-y-4">
  <p class="text-sm leading-relaxed">{{ tourCurrent.body }}</p>


    <div class="flex items-center justify-between">
      <button class="btn btn-sm" :disabled="tourStep === 0" @click="prevTour">Back</button>

      <div class="text-xs opacity-70">
        {{ tourStep + 1 }} / {{ TOUR_STEPS.length }}
      </div>

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
    