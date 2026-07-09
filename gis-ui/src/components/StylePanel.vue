<script setup>
import { ref, computed } from 'vue'
import { store } from '../store'
import { PanelRightClose, PanelRightOpen, SlidersHorizontal } from 'lucide-vue-next'

const layer = computed(() => store.selectedLayer())
const editable = computed(() => layer.value && !layer.value.isBasemap)

/* ---- resize ---- */
const dragging = ref(false)
function startResize(e) {
  dragging.value = true
  const startX = e.clientX
  const startW = store.stylePanelWidth
  const move = (ev) => {
    store.stylePanelWidth = Math.min(560, Math.max(180, startW - (ev.clientX - startX)))
  }
  const up = () => {
    dragging.value = false
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}
</script>

<template>
  <!-- Collapsed rail -->
  <aside v-if="!store.ui.stylePanelOpen" class="rail" aria-label="Style (collapsed)">
    <button class="btn-icon" title="Expand style panel" @click="store.ui.stylePanelOpen = true">
      <PanelRightOpen :size="15" />
    </button>
    <SlidersHorizontal :size="14" class="rail-icon" />
    <span class="rail-label">Style</span>
  </aside>

  <template v-else>
    <div
      class="resize-x"
      :class="{ dragging }"
      role="separator"
      aria-orientation="vertical"
      @pointerdown="startResize"
    />

    <aside class="style-panel" aria-label="Layer style" :style="{ width: store.stylePanelWidth + 'px' }">
      <div class="panel-header">
        <span class="panel-title">Style</span>
        <button class="btn-icon" title="Collapse panel" @click="store.ui.stylePanelOpen = false">
          <PanelRightClose :size="14" />
        </button>
      </div>

      <div v-if="!layer" class="empty">Select a layer to edit its style.</div>

      <div v-else class="style-body">
        <div class="layer-heading">
          <span class="layer-name">{{ layer.name }}</span>
          <span class="layer-type">{{ layer.type }}</span>
        </div>

        <template v-if="editable">
          <div class="field">
            <label class="field-label">Symbology</label>
            <select v-model="layer.symbology" class="select">
              <option value="single">Single symbol</option>
              <option value="categorized">Categorized</option>
              <option value="graduated">Graduated</option>
              <option value="rule-based">Rule-based</option>
              <option value="expression">Expression</option>
            </select>
          </div>

          <div class="field-row">
            <div class="field">
              <label class="field-label">{{ layer.type === 'line' ? 'Line color' : 'Fill color' }}</label>
              <input v-model="layer.color" type="color" class="color-input" />
            </div>
            <div v-if="layer.type !== 'line'" class="field">
              <label class="field-label">Stroke color</label>
              <input v-model="layer.strokeColor" type="color" class="color-input" />
            </div>
          </div>

          <div class="field">
            <label class="field-label">
              {{ layer.type === 'line' ? 'Line width' : 'Stroke width' }} — {{ layer.strokeWidth }} px
            </label>
            <input v-model.number="layer.strokeWidth" type="range" min="0" max="10" step="0.5" class="slider" />
          </div>

          <div v-if="layer.type === 'point'" class="field">
            <label class="field-label">Circle radius — {{ layer.radius }} px</label>
            <input v-model.number="layer.radius" type="range" min="1" max="20" step="1" class="slider" />
          </div>
        </template>

        <div class="field">
          <label class="field-label">Opacity — {{ Math.round(layer.opacity * 100) }}%</label>
          <input v-model.number="layer.opacity" type="range" min="0" max="1" step="0.05" class="slider" />
        </div>

        <template v-if="editable">
          <div class="section-title">Visibility by zoom</div>
          <div class="field-row">
            <div class="field">
              <label class="field-label">Min zoom</label>
              <input class="input" type="number" value="0" min="0" max="24" @change="store.fake('Min zoom')" />
            </div>
            <div class="field">
              <label class="field-label">Max zoom</label>
              <input class="input" type="number" value="24" min="0" max="24" @change="store.fake('Max zoom')" />
            </div>
          </div>

          <div class="section-title">Labels</div>
          <div class="field">
            <label class="field-label">Label field</label>
            <select class="select" @change="store.fake('Labels')">
              <option>— none —</option>
              <option>name</option>
              <option>line</option>
              <option>ridership</option>
            </select>
          </div>
        </template>
      </div>
    </aside>
  </template>
</template>

<style scoped>
.style-panel {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  min-height: 0;
  background: hsl(var(--card));
  border-left: 1px solid hsl(var(--border));
}
.rail {
  width: 44px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding-top: 8px;
  background: hsl(var(--card));
  border-left: 1px solid hsl(var(--border));
}
.rail-icon { color: hsl(var(--muted-foreground)); }
.rail-label {
  writing-mode: vertical-rl;
  font-size: 11px;
  color: hsl(var(--muted-foreground));
}
.empty {
  padding: 24px 16px;
  font-size: 12.5px;
  color: hsl(var(--muted-foreground));
  text-align: center;
}
.style-body { flex: 1; overflow-y: auto; padding: 12px; }
.layer-heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 12px;
  min-width: 0;
}
.layer-name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.layer-type {
  font-size: 10.5px;
  color: hsl(var(--muted-foreground));
  text-transform: uppercase;
  letter-spacing: 0.04em;
  flex-shrink: 0;
}
.field { margin-bottom: 12px; flex: 1; min-width: 0; }
.field-row { display: flex; gap: 10px; }
.color-input {
  width: 100%;
  height: 30px;
  padding: 2px;
  border: 1px solid hsl(var(--input));
  border-radius: calc(var(--radius) - 2px);
  background: transparent;
  cursor: pointer;
}
.section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: hsl(var(--muted-foreground));
  border-top: 1px solid hsl(var(--border));
  padding-top: 12px;
  margin: 4px 0 10px;
}
@media (max-width: 768px) {
  .style-panel { position: absolute; z-index: 50; top: 0; bottom: 0; right: 0; }
}
</style>
