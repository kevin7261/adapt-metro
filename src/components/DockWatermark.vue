<script setup>
import MIcon from './MIcon.vue'
</script>

<template>
  <div class="watermark">
    <MIcon name="layers" :size="28" class="wm-icon" />
    <p>按左側 Layers「Metro Maps」的 + 匯入城市地鐵圖層</p>
    <p class="hint">匯入後點選圖層開啟分頁 — 分頁可拖曳併排、堆疊</p>
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
