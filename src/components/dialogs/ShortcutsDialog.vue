<script setup>
import MIcon from '../MIcon.vue'

const emit = defineEmits(['close'])

const shortcuts = [
  ['⌘K', 'Command palette'],
  ['?', 'Keyboard shortcuts'],
  ['⌘N', 'New project'],
  ['⌘S', 'Save project'],
  ['⇧⌘S', 'Save project as…'],
  ['N', 'North up'],
  ['U', 'Top-down view'],
  ['R', 'Reset view'],
  ['+ / −', 'Zoom in / out'],
]
</script>

<template>
  <!-- Keyboard shortcuts -->
  <div class="dialog">
    <div class="dialog-header">
      <h2 class="dialog-title">鍵盤快捷鍵</h2>
      <button class="btn-icon" @click="emit('close')"><MIcon name="close" :size="15" /></button>
    </div>
    <div class="dialog-body">
      <div v-for="[key, label] in shortcuts" :key="key" class="shortcut-row">
        <span>{{ label }}</span>
        <kbd>{{ key }}</kbd>
      </div>
    </div>
  </div>
</template>
