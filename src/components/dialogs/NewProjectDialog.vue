<script setup>
import { useMapStore } from '../../stores/mapStore'
import MIcon from '../MIcon.vue'

const emit = defineEmits(['close'])
const store = useMapStore()
</script>

<template>
  <!-- New project -->
  <div class="dialog">
    <div class="dialog-header">
      <h2 class="dialog-title">新增專案</h2>
      <button class="btn-icon" @click="emit('close')"><MIcon name="close" :size="15" /></button>
    </div>
    <div class="dialog-body">
      <p>Start a new project? Unsaved changes to the current project will be lost.</p>
    </div>
    <div class="dialog-footer">
      <button class="btn-outline" @click="emit('close')">Cancel</button>
      <button class="btn-primary" @click="store.fake('New project'); emit('close')">Create</button>
    </div>
  </div>
</template>
