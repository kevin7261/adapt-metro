<script setup>
import { viewLabels, hcViewLabels, rwdViewLabels } from '../stores/viewGeometry'
import GalleryTile from './GalleryTile.vue'
import CityViewGrid from './CityViewGrid.vue'

// 視圖畫廊的一張城市卡：城市標題列＋（勾選的）各種地圖區段——Raw Maps 縮圖
// （GalleryTile bare）與 Map Adjust / Straighten / RWD Maps 預算視圖
// （CityViewGrid bare、無標題列；order＝該類「勾選的」視圖清單，逐一開關）。
// 點任何一格都 emit('pick', kind, entry, viewId) 交給 AllGallery 建整組管線
// 圖層並開對應 tab。
const props = defineProps({
  entry: { type: Object, required: true },     // views/index.json 的一筆 system
  sections: { type: Array, required: true },   // [{ id: raw|adjust|straighten|rwd, order: [viewId…] }]
})
const emit = defineEmits(['pick'])

const SECTIONS = {
  raw: { label: 'Metro Maps' },
  adjust: { label: 'Map Adjust', dataDir: 'views', labelsForTilt: viewLabels },
  straighten: { label: 'Straighten', dataDir: 'hcviews', labelsForTilt: hcViewLabels },
  rwd: { label: 'RWD Maps', dataDir: 'rwdviews', labelsForTilt: rwdViewLabels },
}
// 所有區段用固定欄數 → 卡片內每一張縮圖同寬同高（使用者：城市裡每個圖一樣大）。
const COLS = 2
</script>

<template>
  <div class="all-card">
    <button
      class="all-head"
      :title="`匯入 ${entry.cityZh ?? entry.city}（整組管線圖層）`"
      @click="emit('pick', 'raw', entry)"
    >
      <span class="ah-name">
        <span class="ah-zh">{{ entry.cityZh ?? entry.city }} · {{ entry.countryZh ?? entry.country }}</span>
        <span class="ah-en">{{ entry.city }} · {{ entry.country }}</span>
      </span>
      <span class="ah-stats">{{ entry.line_count }} 線 · {{ entry.station_count }} 站</span>
      <span class="ah-open">匯入 ›</span>
    </button>

    <template v-for="sec in sections" :key="sec.id">
      <div class="sec-label">{{ SECTIONS[sec.id].label }}</div>
      <!-- Raw 縮圖也放進固定欄數的網格，佔一個 cell → 與其他圖同大小 -->
      <div v-if="sec.id === 'raw'" class="raw-grid" :style="{ gridTemplateColumns: `repeat(${COLS}, 1fr)` }">
        <GalleryTile :system="entry" bare @pick="(sys) => emit('pick', 'raw', sys)" />
      </div>
      <CityViewGrid
        v-else
        :entry="entry"
        :data-dir="SECTIONS[sec.id].dataDir"
        :order="sec.order"
        :labels-for-tilt="SECTIONS[sec.id].labelsForTilt"
        :columns="COLS"
        :cta-label="SECTIONS[sec.id].label"
        :head="false"
        bare
        @pick="(e, viewId) => emit('pick', sec.id, e, viewId)"
      />
    </template>
    <div v-if="!sections.length" class="all-empty">上方勾選要顯示的地圖</div>
  </div>
</template>

<style scoped>
.all-card {
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  overflow: hidden;
  background: hsl(var(--card));
  display: flex;
  flex-direction: column;
}
.all-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  text-align: left;
  background: hsl(var(--muted) / 0.35);
  border-bottom: 1px solid hsl(var(--border));
  cursor: pointer;
}
.ah-name { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.ah-zh { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.all-head:hover .ah-zh { color: hsl(var(--primary)); }
.ah-en { font-size: 10.5px; color: hsl(var(--muted-foreground) / 0.85); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ah-stats { font-size: 10.5px; color: hsl(var(--muted-foreground) / 0.85); white-space: nowrap; }
.ah-open { margin-left: auto; font-size: 10.5px; color: hsl(var(--primary)); opacity: 0; transition: opacity 0.12s; white-space: nowrap; }
.all-head:hover .ah-open { opacity: 1; }

/* 區段標籤：Raw Maps / Map Adjust / Straighten / RWD Maps */
.sec-label {
  padding: 4px 12px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: hsl(var(--muted-foreground));
  background: hsl(var(--muted) / 0.2);
  border-bottom: 1px solid hsl(var(--border));
}
.sec-label:not(:first-of-type) { border-top: 1px solid hsl(var(--border)); }
/* Raw 縮圖網格：與 CityViewGrid 的 .sgrid 一致（1px 分隔線當格線） */
.raw-grid { display: grid; gap: 1px; background: hsl(var(--border)); }
.all-empty {
  padding: 18px 12px;
  font-size: 12px;
  color: hsl(var(--muted-foreground));
  text-align: center;
}
</style>
