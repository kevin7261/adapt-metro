<script setup>
import { Layers } from 'lucide-vue-next'
</script>

<template>
  <div class="watermark">
    <Layers :size="28" class="wm-icon" />
    <p>從左側 Layers 面板點選圖層來開啟分頁</p>
    <p class="hint">分頁可拖曳併排、堆疊，像 IDE 一樣自由排版</p>
  </div>
</template>

<style scoped>
.watermark {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: hsl(var(--muted-foreground));
  font-size: 13px;
  user-select: none;
}
.wm-icon { opacity: 0.5; }
p { margin: 0; }
.hint { font-size: 11.5px; opacity: 0.7; }
</style>
