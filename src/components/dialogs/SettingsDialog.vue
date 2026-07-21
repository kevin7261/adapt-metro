<script setup>
import { useMapStore } from '../../stores/mapStore'
import MIcon from '../MIcon.vue'

const emit = defineEmits(['close'])
const store = useMapStore()

/* Settings */
const accents = ['blue', 'violet', 'emerald', 'rose', 'amber']
const accentColors = {
  blue: '#2563eb', violet: '#7c3aed', emerald: '#16a34a', rose: '#e11d48', amber: '#f97316',
}
</script>

<template>
  <!-- Settings -->
  <div class="dialog">
    <div class="dialog-header">
      <h2 class="dialog-title">設定</h2>
      <button class="btn-icon" @click="emit('close')"><MIcon name="close" :size="15" /></button>
    </div>
    <div class="dialog-body">
      <div class="settings-section">Appearance</div>
      <div class="settings-row">
        <span>Theme</span>
        <select class="select settings-select" :value="store.dark ? 'dark' : 'light'"
          @change="store.dark = $event.target.value === 'dark'">
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </div>
      <div class="settings-row">
        <span>Accent color</span>
        <div class="swatches">
          <button
            v-for="a in accents"
            :key="a"
            class="swatch"
            :class="{ active: store.accent === a }"
            :style="{ background: accentColors[a] }"
            :title="a"
            @click="store.accent = a"
          />
        </div>
      </div>
      <div class="settings-section">Layout</div>
      <label class="settings-row check">
        <span>Layers panel</span>
        <input v-model="store.ui.layerPanelOpen" type="checkbox" />
      </label>
      <label class="settings-row check">
        <span>Attribute table（作用中圖層）</span>
        <input
          type="checkbox"
          :checked="!!store.ui.attributeTableOpen[store.selectedLayerId]"
          @change="store.toggleAttributeTable(store.selectedLayerId)"
        />
      </label>
    </div>
    <div class="dialog-footer">
      <button class="btn-primary" @click="emit('close')">Done</button>
    </div>
  </div>
</template>
