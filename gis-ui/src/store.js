import { reactive } from 'vue'

// Non-reactive handle to the MapLibre instance (proxying it would break maplibre)
export const mapHandle = { map: null }

let toastTimer = null

export const store = reactive({
  dark: true,
  accent: 'blue',
  projectName: 'adapt-metro.geolibre.json',

  ui: {
    layerPanelOpen: true,
    stylePanelOpen: true,
    attributeTable: false,
    commandPalette: false,
    dialog: null, // 'add-data' | 'settings' | 'about' | 'shortcuts' | 'new-project'
    toast: null,
  },

  layerPanelWidth: 300,
  stylePanelWidth: 320,
  attributeTableHeight: 260,

  map: {
    lng: null,
    lat: null,
    zoom: 11,
    bearing: 0,
    pitch: 0,
    bounds: null,
  },

  selectedLayerId: 'stations',

  groups: [
    { id: 'overlays', name: 'Metro network', open: true },
    { id: 'analysis', name: 'Analysis', open: true },
    { id: 'basemap', name: 'Basemaps', open: true },
  ],

  layers: [
    {
      id: 'stations', group: 'overlays', name: 'metro_stations', type: 'point',
      visible: true, opacity: 1, color: '#f59e0b', strokeColor: '#ffffff',
      strokeWidth: 1.5, radius: 5, symbology: 'single', featureCount: 8,
    },
    {
      id: 'lines', group: 'overlays', name: 'metro_lines', type: 'line',
      visible: true, opacity: 1, color: '#d90023', strokeColor: '#d90023',
      strokeWidth: 3, symbology: 'categorized', featureCount: 2,
    },
    {
      id: 'catchment', group: 'analysis', name: 'station_catchment_800m', type: 'polygon',
      visible: true, opacity: 0.35, color: '#3b82f6', strokeColor: '#2563eb',
      strokeWidth: 1, symbology: 'single', featureCount: 8,
    },
    {
      id: 'flood', group: 'analysis', name: 'flood_risk_zones', type: 'polygon',
      visible: false, opacity: 0.4, color: '#06b6d4', strokeColor: '#0891b2',
      strokeWidth: 1, symbology: 'graduated', featureCount: 14,
    },
    {
      id: 'basemap', group: 'basemap', name: 'OpenFreeMap Liberty', type: 'raster',
      visible: true, opacity: 1, symbology: null, featureCount: null, isBasemap: true,
    },
  ],

  toast(message) {
    this.ui.toast = message
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { this.ui.toast = null }, 2600)
  },

  fake(name) {
    this.toast(`「${name}」為 UI 原型 — 功能尚未實作`)
  },

  selectedLayer() {
    return this.layers.find((l) => l.id === this.selectedLayerId) ?? null
  },
})

// ---- Demo GeoJSON (Taipei metro-ish, fake data) ----
export const demoData = {
  stations: {
    type: 'FeatureCollection',
    features: [
      { name: 'Taipei Main Station', line: 'R / BL', ridership: 292041, coords: [121.5170, 25.0478] },
      { name: 'Ximen', line: 'BL / G', ridership: 121870, coords: [121.5081, 25.0421] },
      { name: 'Zhongxiao Fuxing', line: 'BL / BR', ridership: 134005, coords: [121.5445, 25.0416] },
      { name: 'Taipei 101 / WTC', line: 'R', ridership: 63214, coords: [121.5637, 25.0330] },
      { name: 'Shilin', line: 'R', ridership: 74102, coords: [121.5262, 25.0935] },
      { name: 'Gongguan', line: 'G', ridership: 58330, coords: [121.5325, 25.0148] },
      { name: 'Nangang Exhibition Center', line: 'BL / BR', ridership: 41220, coords: [121.6175, 25.0553] },
      { name: 'Songshan', line: 'G', ridership: 52108, coords: [121.5779, 25.0499] },
    ].map((s, i) => ({
      type: 'Feature',
      id: i,
      properties: { fid: i + 1, name: s.name, line: s.line, ridership: s.ridership, status: 'operating' },
      geometry: { type: 'Point', coordinates: s.coords },
    })),
  },

  lines: {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: 'Tamsui–Xinyi Line', code: 'R', color: '#d90023' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [121.5262, 25.0935], [121.5205, 25.0713], [121.5170, 25.0478],
            [121.5180, 25.0329], [121.5279, 25.0264], [121.5433, 25.0329],
            [121.5539, 25.0330], [121.5637, 25.0330],
          ],
        },
      },
      {
        type: 'Feature',
        properties: { name: 'Bannan Line', code: 'BL', color: '#0070bd' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [121.4590, 25.0119], [121.4800, 25.0250], [121.5081, 25.0421],
            [121.5170, 25.0478], [121.5325, 25.0410], [121.5445, 25.0416],
            [121.5769, 25.0412], [121.6175, 25.0553],
          ],
        },
      },
    ],
  },

  catchment: {
    type: 'FeatureCollection',
    features: [
      [121.5170, 25.0478], [121.5081, 25.0421], [121.5445, 25.0416],
      [121.5637, 25.0330], [121.5262, 25.0935], [121.5325, 25.0148],
      [121.6175, 25.0553], [121.5779, 25.0499],
    ].map((c) => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [circle(c, 0.008)] },
    })),
  },

  flood: {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { risk: 'high' },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [121.44, 25.02], [121.48, 25.04], [121.50, 25.08],
            [121.46, 25.09], [121.43, 25.06], [121.44, 25.02],
          ]],
        },
      },
      {
        type: 'Feature',
        properties: { risk: 'medium' },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [121.58, 25.05], [121.63, 25.05], [121.64, 25.08],
            [121.59, 25.09], [121.58, 25.05],
          ]],
        },
      },
    ],
  },
}

function circle(center, r, steps = 24) {
  const pts = []
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2
    pts.push([center[0] + Math.cos(a) * r, center[1] + Math.sin(a) * r * 0.92])
  }
  return pts
}
