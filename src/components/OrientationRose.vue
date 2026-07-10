<script setup>
import { computed } from 'vue'

// A polar histogram (rose diagram) of line orientations — one wedge per bin,
// radius ∝ that bin's share. Bins are compass bearings (0 = north, clockwise).
const props = defineProps({
  bins: { type: Array, required: true },   // normalised weights, sum ≈ 1
  size: { type: Number, default: 200 },
})

const R = computed(() => props.size / 2 - 14) // leave room for cardinal labels
const cx = computed(() => props.size / 2)
const cy = computed(() => props.size / 2)
const half = computed(() => 180 / props.bins.length) // half a bin, in degrees
const maxBin = computed(() => Math.max(...props.bins, 1e-9))

// Point on the compass circle: angle in degrees from north, clockwise.
function pt(angleDeg, r) {
  const a = (angleDeg * Math.PI) / 180
  return [cx.value + r * Math.sin(a), cy.value - r * Math.cos(a)]
}

const wedges = computed(() =>
  props.bins.map((w, i) => {
    const center = i * (360 / props.bins.length)
    const r = R.value * Math.sqrt(w / maxBin.value) // area-proportional radius
    const [x1, y1] = pt(center - half.value, r)
    const [x2, y2] = pt(center + half.value, r)
    return `M ${cx.value} ${cy.value} L ${x1.toFixed(2)} ${y1.toFixed(2)} `
      + `A ${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`
  }),
)

// Concentric guide circles at 1/3, 2/3, full radius.
const rings = computed(() => [R.value / 3, (R.value * 2) / 3, R.value])
const cardinals = computed(() => [
  { label: 'N', a: 0 }, { label: 'E', a: 90 },
  { label: 'S', a: 180 }, { label: 'W', a: 270 },
].map((c) => ({ ...c, p: pt(c.a, R.value + 9) })))
</script>

<template>
  <svg :viewBox="`0 0 ${size} ${size}`" class="rose" :width="size" :height="size">
    <g class="rose-grid">
      <circle v-for="(r, i) in rings" :key="i" :cx="cx" :cy="cy" :r="r" />
      <line :x1="cx" :y1="cy - R" :x2="cx" :y2="cy + R" />
      <line :x1="cx - R" :y1="cy" :x2="cx + R" :y2="cy" />
    </g>
    <path v-for="(d, i) in wedges" :key="i" :d="d" class="rose-wedge" />
    <text
      v-for="c in cardinals"
      :key="c.label"
      :x="c.p[0]"
      :y="c.p[1]"
      class="rose-label"
      text-anchor="middle"
      dominant-baseline="central"
    >{{ c.label }}</text>
  </svg>
</template>

<style scoped>
.rose { display: block; margin: 0 auto; }
.rose-grid circle,
.rose-grid line {
  fill: none;
  stroke: hsl(var(--border));
  stroke-width: 1;
}
.rose-wedge {
  fill: hsl(var(--primary) / 0.7);
  stroke: hsl(var(--primary));
  stroke-width: 0.5;
  stroke-linejoin: round;
}
.rose-label {
  fill: hsl(var(--muted-foreground));
  font-size: 10px;
  font-weight: 600;
}
</style>
