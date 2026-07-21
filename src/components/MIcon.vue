<script setup>
// Google Material Symbols icon (ligature font, loaded in index.html).
// Drop-in replacement for the old lucide components: <MIcon name="close" :size="14" />
defineProps({
  name: { type: String, default: '' },
  size: { type: Number, default: 16 },
  fill: { type: Boolean, default: false },
})
</script>

<template>
  <span
    class="material-symbols-outlined m-icon"
    :style="{
      fontSize: size + 'px',
      fontVariationSettings: `'FILL' ${fill ? 1 : 0}, 'wght' 300, 'GRAD' 0, 'opsz' 20`,
    }"
    aria-hidden="true"
  >{{ name }}</span>
</template>

<style scoped>
.m-icon {
  display: inline-block;
  width: 1em;
  height: 1em;
  line-height: 1;
  flex-shrink: 0;
  overflow: hidden;
  vertical-align: middle;
  user-select: none;
  font-family: 'Material Symbols Outlined';
  font-style: normal;
  font-weight: normal;
  letter-spacing: normal;
  text-transform: none;
  white-space: nowrap;
  word-wrap: normal;
  direction: ltr;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
  font-feature-settings: 'liga';
}
</style>
