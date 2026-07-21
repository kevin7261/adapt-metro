<script setup>
import MIcon from '../MIcon.vue'

// 面板的階段 chips：這一步執行的工作（lastStage）會亮起。
const STEP_STAGES = [
  { k: 'endp', label: '端點移動' }, { k: 'line', label: '直線縮減' },
  { k: 'gather', label: '網格合併' },
]

defineProps({
  panelLayer: { type: Object, default: null },
  stepInfo: { type: Object, default: null },
})

const emit = defineEmits(['prev', 'next', 'reset'])
</script>

<template>
  <div class="step-panel">
    <button class="step-btn back" :disabled="!panelLayer || !stepInfo?.hist" @click="emit('prev', false)"><MIcon name="arrow_back" :size="13" /> 上一步</button>
    <button class="step-btn" :disabled="!panelLayer || stepInfo?.done" @click="emit('next')">下一步 <MIcon name="arrow_forward" :size="13" /></button>
    <button class="step-btn back sub" :disabled="!panelLayer || !stepInfo?.hist" @click="emit('prev', true)"><MIcon name="chevron_left" :size="13" /> 上一小步</button>
    <button class="step-btn sub" :disabled="!panelLayer || stepInfo?.done" @click="emit('next', 1)">下一小步 <MIcon name="chevron_right" :size="13" /></button>
    <button class="step-btn ghost" :disabled="!panelLayer" @click="emit('reset')">重設</button>
    <span class="step-count" v-if="stepInfo">第 {{ stepInfo.steps }} 步</span>
    <!-- 這一步是哪一個工作：執行到的階段亮起 -->
    <span class="step-stages" v-if="stepInfo">
      <template v-for="(s, i) in STEP_STAGES" :key="s.k">
        <MIcon v-if="i" name="arrow_right_alt" :size="12" class="step-arrow" />
        <span class="step-chip" :class="{ active: stepInfo.lastStage === s.k }">{{ s.label }}</span>
      </template>
    </span>
    <span class="step-msg" v-if="stepInfo" :class="{ done: stepInfo.done }">{{ stepInfo.info }}</span>
  </div>
</template>

<style scoped>
/* 逐步驗證 浮動控制列（左上）：下一步／重設＋這一步做了什麼。 */
.step-panel {
  position: absolute;
  top: 10px;
  left: 10px;
  right: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  background: hsl(var(--card) / 0.92);
  backdrop-filter: blur(4px);
  font-size: 12px;
  z-index: 5;
  pointer-events: auto;
}
.step-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  font-size: 12.5px;
  font-weight: 600;
  border: none;
  border-radius: calc(var(--radius) - 2px);
  background: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
  cursor: pointer;
}
.step-btn:hover:not(:disabled) { opacity: 0.9; }
.step-btn:disabled { opacity: 0.4; cursor: default; }
.step-btn.sub {
  background: hsl(var(--primary) / 0.12);
  color: hsl(var(--primary));
}
.step-btn.back {
  background: transparent;
  border: 1px solid hsl(var(--primary) / 0.45);
  color: hsl(var(--primary));
  font-weight: 500;
}
.step-btn.back.sub { border-style: dashed; }
.step-btn.ghost {
  background: transparent;
  border: 1px solid hsl(var(--border));
  color: hsl(var(--muted-foreground));
  font-weight: 500;
}
.step-count {
  flex-shrink: 0;
  font-weight: 600;
  color: hsl(var(--primary));
}
.step-msg {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: hsl(var(--muted-foreground));
}
.step-msg.done { color: hsl(142 70% 40%); font-weight: 600; }
/* 階段 chips：這一步執行的工作亮起。 */
.step-stages {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.step-chip {
  padding: 2px 7px;
  font-size: 11px;
  border-radius: 999px;
  border: 1px solid hsl(var(--border));
  color: hsl(var(--muted-foreground));
  white-space: nowrap;
}
.step-chip.active {
  background: hsl(var(--primary));
  border-color: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
  font-weight: 600;
}
.step-arrow { color: hsl(var(--muted-foreground) / 0.5); }
</style>
