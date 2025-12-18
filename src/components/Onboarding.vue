<script setup lang="ts">
import { computed, ref } from "vue";

const emit = defineEmits<{ (e: "done"): void }>();

const slides = [
    { title: "Import any EPUB", text: "Add books from your device. Everything stays local." },
    { title: "Tap for pop-ups", text: "Footnotes/glossary open as a popup. Fallback dictionary is available too." },
    { title: "Search + Study Mode", text: "Full-text search, themes, fonts, and a distraction-free study mode." },
    { title: "Read aloud + Analytics", text: "Text-to-speech and reading stats per book." },
];

const i = ref(0);
const last = computed(() => i.value === slides.length - 1);

function next() {
    if (last.value) emit("done");
    else i.value += 1;
}
</script>

<template>
    <div class="fixed inset-0 bg-base-100 flex items-center justify-center p-6">
    <div class="max-w-md w-full">
        <div class="card bg-base-200 shadow-xl">
        <div class="card-body">
            <div class="text-xl font-semibold">{{ slides[i]?.title }}</div>
            <div class="opacity-80 mt-2">{{ slides[i]?.text }}</div>

            <div class="mt-6 flex items-center justify-between">
            <button class="btn btn-ghost" @click="emit('done')">Skip</button>
            <button class="btn btn-primary" @click="next()">
                {{ last ? "Start reading" : "Next" }}
            </button>
            </div>

            <div class="mt-4 flex gap-2 justify-center">
            <div v-for="(s, idx) in slides" :key="s.title" class="w-2 h-2 rounded-full"
                :class="idx === i ? 'bg-primary' : 'bg-base-300'"></div>
            </div>
        </div>
        </div>
        <div class="text-xs opacity-60 mt-3 text-center">
        Tip: “Install” from your browser menu for an app-like experience.
        </div>
    </div>
    </div>
</template>

    