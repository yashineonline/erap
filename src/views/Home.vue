<script setup lang="ts">
    import { onMounted, ref } from "vue";
    import { useRouter } from "vue-router";
    import Onboarding from "../components/Onboarding.vue";
    import { isOnboarded, setOnboarded, loadBooks, saveBooks, saveBookFile, deleteBook } from "../lib/storage";
    import type { BookMeta } from "../lib/types";
    
    const router = useRouter();
    const books = ref<BookMeta[]>([]);
    const showTour = ref(false);
    
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
          <div class="flex-1 px-2 text-lg font-semibold">OpenLeaf (Web)</div>
          <div class="flex-none">
            <label class="btn btn-primary btn-sm">
              Import EPUB
              <input type="file" accept=".epub" class="hidden" @change="importEpub" />
            </label>
          </div>
        </div>
    
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
      </div>
    </template>
    