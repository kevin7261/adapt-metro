<script setup>
import { useMapStore } from '../../stores/mapStore'
import MIcon from '../MIcon.vue'

const emit = defineEmits(['close'])
const store = useMapStore()
</script>

<template>
  <!-- About -->
  <div class="dialog about">
    <div class="dialog-header">
      <h2 class="dialog-title">關於</h2>
      <button class="btn-icon" @click="emit('close')"><MIcon name="close" :size="15" /></button>
    </div>
    <div class="dialog-body about-body">
      <MIcon name="map" :size="40" class="about-logo" />
      <h3>Adapt-Metro</h3>
      <p class="muted">UI prototype v0.1.0 — layout inspired by GeoLibre</p>
      <p class="muted">Vue 3 · Vite · MapLibre GL JS</p>
      <div class="about-links">
        <button class="btn-outline" @click="store.fake('Website')"><MIcon name="language" :size="13" /> Website</button>
        <button class="btn-outline" @click="store.fake('GitHub')"><MIcon name="code" :size="13" /> GitHub</button>
      </div>
    </div>
  </div>
</template>
