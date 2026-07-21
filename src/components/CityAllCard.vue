<script setup>
import { viewLabels, hcViewLabels, rwdViewLabels } from '../stores/viewGeometry'
import GalleryTile from './GalleryTile.vue'
import OfficialMapTile from './OfficialMapTile.vue'
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
// 四個區段（Metro Maps｜Map Adjust｜Straighten｜RWD Maps）橫向並排成一列，
// 每個區段內的縮圖上下排（單欄垂直堆疊）——使用者指定的版面。
const COLS = 1
</script>

<template>
  <div class="all-card" :data-city="entry.id">
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
    </button>

    <div v-if="sections.length" class="sec-row">
      <div v-for="sec in sections" :key="sec.id" class="sec-col">
        <div class="sec-label">{{ SECTIONS[sec.id].label }}</div>
        <!-- Raw：OSM路網縮圖／官方路線圖（依左側清單勾選，上下排） -->
        <div v-if="sec.id === 'raw'" class="raw-grid">
          <GalleryTile
            v-if="sec.order.includes('thumb')"
            :system="entry"
            bare
            label="OSM路網"
            @pick="(sys) => emit('pick', 'raw', sys)"
          />
          <OfficialMapTile v-if="sec.order.includes('official')" :system="entry" bare label="官方路線圖" />
        </div>
        <CityViewGrid
          v-else
          :entry="entry"
          :data-dir="SECTIONS[sec.id].dataDir"
          :order="sec.order"
          :labels-for-tilt="SECTIONS[sec.id].labelsForTilt"
          :columns="COLS"
          :max-rows="3"
          :cta-label="SECTIONS[sec.id].label"
          :head="false"
          bare
          @pick="(e, viewId) => emit('pick', sec.id, e, viewId)"
        />
      </div>
    </div>
    <div v-else class="all-empty">上方勾選要顯示的地圖</div>
  </div>
</template>

<style scoped>
.all-card {
  --gv-h: 180px;      /* 每個小視圖固定高度；寬度不限（依網路長寬比，raw-grid 與 CityViewGrid 共用） */
  max-width: 100%;
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
.ah-stats { margin-left: auto; font-size: 10.5px; color: hsl(var(--muted-foreground) / 0.85); white-space: nowrap; }

/* 四區段（Metro Maps｜Map Adjust｜Straighten｜RWD Maps）橫向並排，各區段內縮圖
   從上往下排、最多 4 個換行往右加欄。城市視圖太寬時，水平捲動只發生在「這張卡片
   內部」——頁面本身不出現水平捲軸。 */
.sec-row { display: flex; align-items: flex-start; overflow-x: auto; }
.sec-col {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
}
.sec-col:not(:first-child) { border-left: 1px solid hsl(var(--border)); }
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
/* Raw 縮圖網格：與 CityViewGrid 的 .sgrid 一致——從上往下排、最多 3 個換行（往右加欄） */
.raw-grid {
  display: grid;
  grid-auto-flow: column;
  grid-template-rows: repeat(3, auto);
  grid-auto-columns: max-content;   /* 縮圖寬不限＝取內容寬 */
  gap: 1px;
  background: hsl(var(--border));
}
.all-empty {
  padding: 18px 12px;
  font-size: 12px;
  color: hsl(var(--muted-foreground));
  text-align: center;
}
</style>
