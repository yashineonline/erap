<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { getAllBooks, putBook, deleteBook, getMeta, setMeta } from "../lib/db";
import Onboarding from "../components/Onboarding.vue";

const router = useRouter();
const books = ref(await getAllBooks());
const showOnboarding = ref(false);

onMounted(async () => {
  showOnboarding.value = !(await getMeta("didOnboarding", false));
});

async function refresh() {
  books.value = await getAllBooks();
}

async function importEpub(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  const title = file.name.replace(/\.epub$/i, "");
  await putBook({ id, title, addedAt: Date.now(), blob: file });

  input.value = "";
  await refresh();
}

async function openBook(id: string) {
  await router.push(`/read/${encodeURIComponent(id)}`);
}

async function removeBook(id: string) {
  await deleteBook(id);
  await refresh();
}

async function doneOnboarding() {
  await setMeta("didOnboarding", true);
  showOnboarding.value = false;
}
</script>

<template>
  <div class="min-h-full bg-base-100">
    <div class="navbar bg-base-200">
      <div class="flex-1 px-2 text-lg font-semibold">Universal Reader</div>
      <div class="flex-none">
        <label class="btn btn-primary btn-sm">
          Import EPUB
          <input type="file" accept=".epub" class="hidden" @change="importEpub" />
        </label>
      </div>
    </div>

    <div class="p-4 max-w-3xl mx-auto">
      <div v-if="books.length === 0" class="opacity-70">
        Import an EPUB to start.
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div v-for="b in books" :key="b.id" class="card bg-base-200 shadow">
          <div class="card-body">
            <div class="text-base font-semibold">{{ b.title }}</div>
            <div class="text-xs opacity-60">Added: {{ new Date(b.addedAt).toLocaleString() }}</div>
            <div class="card-actions justify-end mt-3">
              <button class="btn btn-ghost btn-sm" @click="removeBook(b.id)">Remove</button>
              <button class="btn btn-primary btn-sm" @click="openBook(b.id)">Open</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <Onboarding v-if="showOnboarding" @done="doneOnboarding" />
  </div>
</template>
