<script setup>
import { computed } from 'vue'
import { recomputeOverlay } from '../stores/recomputeOverlay'
import MIcon from './MIcon.vue'

const pct = computed(() => {
  const p = recomputeOverlay.progress
  if (!p?.total) return 0
  return Math.min(100, Math.round((100 * p.current) / p.total))
})

const frac = computed(() => {
  const p = recomputeOverlay.progress
  if (!p?.total) return ''
  return `${p.current} / ${p.total}`
})

async function togglePause() {
  if (recomputeOverlay.mode === 'city') return // 單城不提供暫停
  const path = recomputeOverlay.paused ? '/metro-recompute/resume' : '/metro-recompute/pause'
  try {
    const res = await fetch(path, { method: 'POST' })
    if (!res.ok) return
    const j = await res.json()
    recomputeOverlay.paused = !!j.paused
    if (j.step) recomputeOverlay.step = j.step
  } catch { /* ignore */ }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="recomputeOverlay.open"
      class="rc-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rc-title"
    >
      <div class="rc-card">
        <div class="rc-spinner" :class="{ paused: recomputeOverlay.paused }" />
        <div id="rc-title" class="rc-title">{{ recomputeOverlay.title }}</div>
        <div v-if="recomputeOverlay.phase" class="rc-phase">{{ recomputeOverlay.phase }}</div>
        <div class="rc-step">{{ recomputeOverlay.step || '進行中…' }}</div>
        <div v-if="frac" class="rc-frac">{{ frac }}</div>
        <div v-if="recomputeOverlay.progress?.total" class="rc-bar">
          <div
            class="rc-bar-fill"
            :class="{ paused: recomputeOverlay.paused }"
            :style="{ width: pct + '%' }"
          />
        </div>
        <div v-if="recomputeOverlay.progress?.item" class="rc-item">{{ recomputeOverlay.progress.item }}</div>
        <div v-if="recomputeOverlay.error" class="rc-error">{{ recomputeOverlay.error }}</div>
        <button
          v-if="recomputeOverlay.mode !== 'city'"
          type="button"
          class="rc-pause"
          @click="togglePause"
        >
          <MIcon :name="recomputeOverlay.paused ? 'play_arrow' : 'pause'" :size="14" />
          {{ recomputeOverlay.paused ? '繼續' : '暫停（這城算完後停）' }}
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.rc-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: hsl(var(--background) / 0.62);
  backdrop-filter: blur(2px);
}
.rc-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  min-width: min(420px, 88vw);
  max-width: min(520px, 92vw);
  padding: 28px 32px;
  text-align: center;
  background: hsl(var(--card) / 0.98);
  border: 1px solid hsl(var(--primary) / 0.4);
  border-radius: var(--radius);
  box-shadow: 0 16px 48px rgb(0 0 0 / 0.32);
}
.rc-spinner {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 3px solid hsl(var(--primary) / 0.2);
  border-top-color: hsl(var(--primary));
  animation: rc-spin 0.8s linear infinite;
}
.rc-spinner.paused {
  animation: none;
  border-top-color: hsl(var(--muted-foreground));
  opacity: 0.7;
}
@keyframes rc-spin { to { transform: rotate(360deg); } }
.rc-title {
  font-size: 15px;
  font-weight: 700;
  color: hsl(var(--foreground));
}
.rc-phase {
  font-size: 11px;
  font-weight: 600;
  color: hsl(var(--primary));
  letter-spacing: 0.02em;
}
.rc-step {
  font-size: 12.5px;
  line-height: 1.5;
  color: hsl(var(--foreground));
  word-break: break-word;
  max-width: 100%;
}
.rc-frac {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: hsl(var(--muted-foreground));
}
.rc-bar {
  width: 100%;
  height: 6px;
  border-radius: 999px;
  background: hsl(var(--muted) / 0.55);
  overflow: hidden;
}
.rc-bar-fill {
  height: 100%;
  background: hsl(var(--primary));
  transition: width 0.25s ease;
}
.rc-bar-fill.paused { background: hsl(var(--muted-foreground)); }
.rc-item {
  font-size: 11px;
  color: hsl(var(--muted-foreground));
  word-break: break-all;
}
.rc-error {
  font-size: 12px;
  color: hsl(var(--destructive));
}
.rc-pause {
  margin-top: 4px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  font-size: 12px;
  border-radius: var(--radius);
  border: 1px solid hsl(var(--border));
  background: hsl(var(--background));
  color: hsl(var(--foreground));
  cursor: pointer;
}
.rc-pause:hover { background: hsl(var(--muted) / 0.45); }
</style>
