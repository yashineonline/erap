<script setup lang="ts">
    defineProps<{
      open: boolean;
      title: string;
    }>();
    defineEmits<{ (e: "close"): void }>();
    </script>
    
    <template>
      <div v-if="open" class="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-3" @click.self="$emit('close')">
        <div class="card bg-base-100 shadow-xl w-full sm:max-w-xl max-h-[80vh] overflow-auto">
          <div class="card-body">
            <div class="flex items-center justify-between gap-3">
              <div class="font-semibold truncate">{{ title }}</div>
              <button class="btn btn-ghost btn-sm" @click="$emit('close')">Close</button>
            </div>
            <div class="divider my-2"></div>
            <slot />
          </div>
        </div>
      </div>
    </template>
    