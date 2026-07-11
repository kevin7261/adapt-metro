<script setup>
import { computed } from 'vue'

// A polar histogram (rose diagram) of line orientations — one wedge per bin,
// radius ∝ that bin's share. Bins are compass bearings (0 = north, clockwise).
const props = defineProps({
  bins: { type: Array, required: true },   // normalised weights, sum ≈ 1
  size: { type: Number, default: 220 },
  tilt: { type: Number, default: 0 },      // dominant-axis deviation from cardinal (deg)
  strength: { type: Number, default: 0 },  // 0–1 grid-likeness (fades the overlay)
})

const R = computed(() => props.size / 2 - 34) // leave a ring outside for the rotation arc
const RARC = computed(() => R.value + 16)     // radius of the rotation arc (outside the rose)
const cx = computed(() => props.size / 2)
const cy = computed(() => props.size / 2)
const half = computed(() => 180 / props.bins.length) // half a bin, in degrees
const maxBin = computed(() => Math.max(...props.bins, 1e-9))

// Highlight the wedges the suggested rotation turns onto a cardinal axis — the
// directions at bearing ≈ tilt (and its +90/+180/+270 partners), i.e. the ones
// that become horizontal/vertical. Threshold = half a bin.
const foldDev = (deg) => {
  const d = (((deg - props.tilt) % 90) + 90) % 90
  return Math.min(d, 90 - d)
}
const isAligned = (i) => foldDev(i * (360 / props.bins.length)) <= half.value

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

// Suggested rotation drawn OUTSIDE the circle as an arc from the dominant axis
// (bearing = tilt) back to North (0°) — i.e. "rotate the network by this much to
// bring its main axis to N and square it up". The arrowhead sits at N (the target).
const hasTilt = computed(() => Math.abs(props.tilt) >= 0.5)
const rotationArc = computed(() => {
  if (!hasTilt.value) return null
  const r = RARC.value
  const [xs, ys] = pt(props.tilt, r) // start: current (tilted) orientation
  const [xe, ye] = pt(0, r)          // end: North (square)
  const sweep = props.tilt > 0 ? 0 : 1 // sweep back toward 0°
  return `M ${xs.toFixed(2)} ${ys.toFixed(2)} A ${r} ${r} 0 0 ${sweep} ${xe.toFixed(2)} ${ye.toFixed(2)}`
})
// Arrowhead at North (the arc's end), pointing along the direction of travel.
const arcArrow = computed(() => {
  if (!hasTilt.value) return null
  const [x, y] = pt(0, RARC.value)
  const s = props.tilt > 0 ? -1 : 1 // travelling toward decreasing/increasing angle
  const tx = s, ty = 0              // tangent at θ=0
  const rx = 0, ry = -1            // outward radial at North
  const back = 9, wing = 5
  const bx = x - tx * back, by = y - ty * back
  return `${x.toFixed(2)},${y.toFixed(2)} `
    + `${(bx + rx * wing).toFixed(2)},${(by + ry * wing).toFixed(2)} `
    + `${(bx - rx * wing).toFixed(2)},${(by - ry * wing).toFixed(2)}`
})
// Small tick at the start (the current tilted orientation).
const startTick = computed(() => {
  if (!hasTilt.value) return null
  const [x1, y1] = pt(props.tilt, R.value + 8)
  const [x2, y2] = pt(props.tilt, RARC.value + 6)
  return { x1, y1, x2, y2 }
})
// Degree label near the middle of the arc.
const arcLabel = computed(() => {
  if (!hasTilt.value) return null
  const [x, y] = pt(props.tilt / 2, RARC.value + 14)
  return { x, y, text: `${Math.abs(props.tilt).toFixed(0)}°` }
})
// Fade the overlay when the network isn't grid-like (weak suggestion).
const overlayOpacity = computed(() => Math.max(0.4, Math.min(1, props.strength * 2)))

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
    <path
      v-for="(d, i) in wedges"
      :key="i"
      :d="d"
      class="rose-wedge"
      :class="{ 'is-aligned': isAligned(i) }"
    />

    <!-- Suggested rotation: a red arc outside the circle, from N by `tilt`. -->
    <g v-if="rotationArc" class="rose-rot" :style="{ opacity: overlayOpacity }">
      <line
        :x1="startTick.x1" :y1="startTick.y1" :x2="startTick.x2" :y2="startTick.y2"
        class="rot-start"
      />
      <path :d="rotationArc" class="rot-arc" />
      <polygon :points="arcArrow" class="rot-arrow" />
      <text
        :x="arcLabel.x" :y="arcLabel.y"
        class="rot-label"
        text-anchor="middle"
        dominant-baseline="central"
      >{{ arcLabel.text }}</text>
    </g>

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
/* directions the rotation squares up (→ cardinal) — highlighted red */
.rose-wedge.is-aligned {
  fill: #e11d48;
  stroke: #9f1239;
  stroke-width: 0.75;
}
.rose-label {
  fill: hsl(var(--muted-foreground));
  font-size: 10px;
  font-weight: 600;
}
/* suggested-rotation arc (red, outside the circle) */
.rot-arc { fill: none; stroke: #e11d48; stroke-width: 2; stroke-linecap: round; }
.rot-arrow { fill: #e11d48; }
.rot-start { stroke: #e11d48; stroke-width: 1.5; }
.rot-label { fill: #e11d48; font-size: 11px; font-weight: 700; }
</style>
