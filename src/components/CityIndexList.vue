<script setup>
import { reactive, computed } from 'vue'
import { continentZh, prettyContinent } from '../stores/metroCatalog'
import MIcon from './MIcon.vue'

// 共用「城市索引清單」——視圖畫廊右側索引與加入 modal 的快速選擇／依數量排序共用同一份
// 呈現（使用者：加入 modal 要跟視圖 right view 一樣）。兩種模式：
//   grouped=true  → 洲別 → 國家 → 城市，可收合（預設全縮）；城市列＝中文主名＋英文副名。
//   grouped=false → 平面清單（依排序），可選頂端 sort icon；列＝中文·國名／英文·國名／metric。
// 點城市 emit('pick', item)。分組依 items 的出現順序（呼叫端先排好），洲別/國家一變就開新群組。
const props = defineProps({
  items: { type: Array, default: () => [] },
  grouped: { type: Boolean, default: false },
  sortable: { type: Boolean, default: false },  // flat 模式頂端顯示 sort icon
  sortDir: { type: String, default: 'desc' },   // 'desc' | 'asc'
  countNoun: { type: String, default: '城市' },  // sort 列右側「N 城市／系統」
  // 每列的中／英主名、國名、metric（不同資料集可覆寫；預設為 metro）。
  primaryZh: { type: Function, default: (t) => t.cityZh ?? t.city ?? t.countryZh ?? t.country },
  primaryEn: { type: Function, default: (t) => t.city ?? t.country ?? '' },
  countryZhOf: { type: Function, default: (t) => t.countryZh ?? t.country },
  countryEnOf: { type: Function, default: (t) => t.country },
  metricOf: { type: Function, default: (t) => `${t.line_count ?? 0} 線 · ${t.station_count ?? 0} 站` },
  keyOf: { type: Function, default: (t) => t.id ?? t.file },
  // 與地圖等外部視圖連動：目前反白的城市 key（hover/選取），null＝無。
  activeId: { type: [String, Number], default: null },
})
const emit = defineEmits(['pick', 'update:sortDir', 'hover'])

// 收合狀態（預設全縮：洲別收起；展開洲別後國家也預設收起）。
const expandedCont = reactive({})
const expandedCountry = reactive({})
const toggleCont = (k) => { expandedCont[k] = !expandedCont[k] }
const toggleCountry = (k) => { expandedCountry[k] = !expandedCountry[k] }

// 依 items 出現順序分組：洲別 → 國家 → 城市。
const indexGroups = computed(() => {
  const groups = []
  let g = null, c = null
  for (const t of props.items) {
    if (!g || g.continent !== t.continent) {
      g = { continent: t.continent, contLabel: continentZh(t.continent), contLabelEn: prettyContinent(t.continent), countries: [] }
      groups.push(g); c = null
    }
    if (!c || c.country !== t.country) {
      c = { country: t.country, countryLabel: props.countryZhOf(t), countryLabelEn: props.countryEnOf(t), cities: [] }
      g.countries.push(c)
    }
    c.cities.push(t)
  }
  return groups
})
const toggleSort = () => emit('update:sortDir', props.sortDir === 'desc' ? 'asc' : 'desc')
</script>

<template>
  <div class="ci-list">
    <!-- 頂端一排：sort icon（可排序時）＋數量。數量固定寫在這裡（排序 icon 旁）。
         flat（可排序）時吸頂；分組時不吸頂（讓洲別標題吸頂，避免兩層打架）。 -->
    <div class="gi-toolbar" :class="{ sticky: sortable }">
      <button
        v-if="sortable"
        class="gi-sort-btn"
        :title="sortDir === 'desc' ? '多到少（點擊切換）' : '少到多（點擊切換）'"
        @click="toggleSort"
      >
        <MIcon :name="sortDir === 'desc' ? 'arrow_downward' : 'arrow_upward'" :size="15" />
      </button>
      <span class="gi-toolbar-count">{{ items.length }} {{ countNoun }}</span>
    </div>

    <!-- 分組模式：洲別 → 國家 → 城市 -->
    <template v-if="grouped">
      <template v-for="g in indexGroups" :key="g.continent">
        <button class="gi-cont" @click="toggleCont(g.continent)">
          <MIcon :name="expandedCont[g.continent] ? 'expand_more' : 'chevron_right'" :size="14" class="gi-chev" />
          <span class="gi-lbl-wrap">
            <span class="gi-lbl">{{ g.contLabel }}</span>
            <span v-if="g.contLabelEn && g.contLabelEn !== g.contLabel" class="gi-lbl-en">{{ g.contLabelEn }}</span>
          </span>
          <span class="gi-count">{{ g.countries.length }}</span>
        </button>
        <template v-if="expandedCont[g.continent]">
          <template v-for="c in g.countries" :key="c.country">
            <button class="gi-country" @click="toggleCountry(g.continent + '|' + c.country)">
              <MIcon :name="expandedCountry[g.continent + '|' + c.country] ? 'expand_more' : 'chevron_right'" :size="12" class="gi-chev" />
              <span class="gi-lbl-wrap">
                <span class="gi-lbl">{{ c.countryLabel }}</span>
                <span v-if="c.countryLabelEn && c.countryLabelEn !== c.countryLabel" class="gi-lbl-en">{{ c.countryLabelEn }}</span>
              </span>
              <span class="gi-count">{{ c.cities.length }}</span>
            </button>
            <template v-if="expandedCountry[g.continent + '|' + c.country]">
              <button
                v-for="t in c.cities"
                :key="keyOf(t)"
                class="gi-item"
                :class="{ active: keyOf(t) === activeId }"
                :data-city-id="keyOf(t)"
                :title="`${primaryZh(t)} · ${countryZhOf(t)}`"
                @click="emit('pick', t)"
                @mouseenter="emit('hover', keyOf(t))"
                @mouseleave="emit('hover', null)"
              >
                <span class="gi-name">{{ primaryZh(t) }}</span>
                <span v-if="primaryEn(t) && primaryEn(t) !== primaryZh(t)" class="gi-en">{{ primaryEn(t) }}</span>
              </button>
            </template>
          </template>
        </template>
      </template>
    </template>

    <!-- 平面清單（依排序）：中文·國名／英文·國名／metric -->
    <template v-else>
      <button
        v-for="t in items"
        :key="keyOf(t)"
        class="gi-item flat"
        :class="{ active: keyOf(t) === activeId }"
        :data-city-id="keyOf(t)"
        :title="`${primaryZh(t)} · ${countryZhOf(t)} · ${metricOf(t)}`"
        @click="emit('pick', t)"
        @mouseenter="emit('hover', keyOf(t))"
        @mouseleave="emit('hover', null)"
      >
        <span class="gi-name">{{ primaryZh(t) }} · {{ countryZhOf(t) }}</span>
        <span class="gi-en">{{ primaryEn(t) }} · {{ countryEnOf(t) }}</span>
        <span class="gi-meta">{{ metricOf(t) }}</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.ci-list { display: block; }
/* 頂端一排（sort icon＋數量）。sortable 時吸頂，分組時不吸頂。 */
.gi-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: hsl(var(--card));
  border-bottom: 1px solid hsl(var(--border));
}
.gi-toolbar.sticky { position: sticky; top: 0; z-index: 2; }
/* 與標準按鈕（.bar-btn／.side-all）同高，畫廊左右兩側按鈕大小一致 */
.gi-sort-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  color: hsl(var(--muted-foreground));
  background: hsl(var(--background));
}
.gi-sort-btn:hover { color: hsl(var(--primary)); border-color: hsl(var(--primary) / 0.5); }
.gi-toolbar-count { font-size: 12px; color: hsl(var(--muted-foreground)); white-space: nowrap; }

/* 洲別標題（可點收合、置頂） */
.gi-cont {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 3px;
  width: 100%;
  padding: 7px 10px 6px;
  font-size: 13px;
  font-weight: 700;
  text-align: left;
  color: hsl(var(--foreground));
  background: hsl(var(--muted) / 0.5);
  border-bottom: 1px solid hsl(var(--border));
  backdrop-filter: blur(2px);
}
.gi-cont:hover { color: hsl(var(--primary)); }
/* 國家標題（可點收合） */
.gi-country {
  display: flex;
  align-items: center;
  gap: 3px;
  width: 100%;
  padding: 5px 10px 3px 16px;
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  color: hsl(var(--muted-foreground));
}
.gi-country:hover { color: hsl(var(--primary)); }
.gi-chev { flex-shrink: 0; opacity: 0.55; }
/* 標題：中文主名一行、英文副名一行 */
.gi-lbl-wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
  flex: 1;
  line-height: 1.25;
}
.gi-lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.gi-lbl-en {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
  font-size: 11px;
  font-weight: 400;
  color: hsl(var(--muted-foreground));
}
/* 標題右側的選項數（洲別＝國家數、國家＝城市數） */
.gi-count {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 10.5px;
  font-weight: 600;
  color: hsl(var(--muted-foreground) / 0.8);
  font-variant-numeric: tabular-nums;
}
/* 城市列——中文＋英文＋metric */
.gi-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0;
  width: 100%;
  padding: 4px 10px 4px 34px;
  font-size: 13px;
  line-height: 1.35;
  text-align: left;
  color: hsl(var(--foreground) / 0.82);
}
.gi-item.flat { padding: 5px 12px; }
.gi-name,
.gi-en,
.gi-meta {
  display: block;
  width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gi-en,
.gi-meta {
  font-size: 11px;
  color: hsl(var(--muted-foreground));
}
.gi-item:hover { background: hsl(var(--accent)); color: hsl(var(--primary)); }
.gi-item:hover .gi-en,
.gi-item:hover .gi-meta { color: hsl(var(--primary) / 0.75); }
/* 與地圖連動反白（地圖 hover 到某點時，對應清單列亮起） */
.gi-item.active {
  background: hsl(var(--primary) / 0.14);
  color: hsl(var(--primary));
  box-shadow: inset 2px 0 0 hsl(var(--primary));
}
.gi-item.active .gi-en,
.gi-item.active .gi-meta { color: hsl(var(--primary) / 0.75); }
</style>
