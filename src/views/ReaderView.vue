<script setup lang="ts">
// v2 wrapper: keeps old import paths working while moving the implementation to ReaderView_v2.vue
import ReaderViewV2 from "./ReaderView_v2.vue";

defineProps<{ id: string }>();
</script>

<template>
  <ReaderViewV2 :id="id" />
</template>
