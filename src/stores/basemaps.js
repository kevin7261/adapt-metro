// Free basemap catalog + OpenRailwayMap overlay for the map tabs.
// A basemap is either a vector style URL (`style`) or a raster tile set (`raster`).

const carto = (name) => [
  `https://a.basemaps.cartocdn.com/${name}/{z}/{x}/{y}.png`,
  `https://b.basemaps.cartocdn.com/${name}/{z}/{x}/{y}.png`,
  `https://c.basemaps.cartocdn.com/${name}/{z}/{x}/{y}.png`,
  `https://d.basemaps.cartocdn.com/${name}/{z}/{x}/{y}.png`,
]
const google = (lyrs) => [
  `https://mt0.google.com/vt/lyrs=${lyrs}&x={x}&y={y}&z={z}`,
  `https://mt1.google.com/vt/lyrs=${lyrs}&x={x}&y={y}&z={z}`,
  `https://mt2.google.com/vt/lyrs=${lyrs}&x={x}&y={y}&z={z}`,
  `https://mt3.google.com/vt/lyrs=${lyrs}&x={x}&y={y}&z={z}`,
]
const nlsc = (layer) =>
  [`https://wmts.nlsc.gov.tw/wmts/${layer}/default/GoogleMapsCompatible/{z}/{y}/{x}`]

// Mapbox needs a (free) access token: set VITE_MAPBOX_TOKEN in a .env file.
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || ''
const mapbox = (styleId) => [
  `https://api.mapbox.com/styles/v1/mapbox/${styleId}/tiles/256/{z}/{x}/{y}?access_token=${MAPBOX_TOKEN}`,
]

const OSM_ATTR = '© OpenStreetMap contributors'
const CARTO_ATTR = '© OpenStreetMap contributors © CARTO'
const NLSC_ATTR = '© 內政部國土測繪中心 (NLSC)'

export const BASEMAPS = [
  { id: 'openfreemap-liberty', group: 'OpenStreetMap', label: 'OpenFreeMap Liberty',
    style: 'https://tiles.openfreemap.org/styles/liberty' },
  { id: 'openfreemap-positron', group: 'OpenStreetMap', label: 'OpenFreeMap Positron',
    style: 'https://tiles.openfreemap.org/styles/positron' },
  { id: 'osm', group: 'OpenStreetMap', label: 'OSM Standard',
    raster: { tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], attribution: OSM_ATTR } },

  { id: 'carto-voyager', group: 'CARTO', label: 'Voyager',
    raster: { tiles: carto('rastertiles/voyager'), attribution: CARTO_ATTR } },
  { id: 'carto-positron', group: 'CARTO', label: 'Positron (light)',
    raster: { tiles: carto('light_all'), attribution: CARTO_ATTR } },
  { id: 'carto-dark', group: 'CARTO', label: 'Dark Matter',
    raster: { tiles: carto('dark_all'), attribution: CARTO_ATTR } },

  { id: 'google-roadmap', group: 'Google', label: 'Roadmap',
    raster: { tiles: google('m'), attribution: '© Google' } },
  { id: 'google-satellite', group: 'Google', label: 'Satellite',
    raster: { tiles: google('s'), attribution: '© Google' } },
  { id: 'google-hybrid', group: 'Google', label: 'Hybrid',
    raster: { tiles: google('y'), attribution: '© Google' } },
  { id: 'google-terrain', group: 'Google', label: 'Terrain',
    raster: { tiles: google('p'), attribution: '© Google' } },

  { id: 'nlsc-emap', group: '台灣 國土測繪中心', label: '電子地圖 EMAP',
    raster: { tiles: nlsc('EMAP'), attribution: NLSC_ATTR } },
  { id: 'nlsc-emap-gray', group: '台灣 國土測繪中心', label: '電子地圖（灰階）',
    raster: { tiles: nlsc('EMAP6'), attribution: NLSC_ATTR } },
  { id: 'nlsc-photo', group: '台灣 國土測繪中心', label: '正射影像 PHOTO',
    raster: { tiles: nlsc('PHOTO2'), attribution: NLSC_ATTR } },

  { id: 'mapbox-streets', group: 'Mapbox', label: 'Streets', needsToken: true,
    raster: { tiles: mapbox('streets-v12'), attribution: '© Mapbox © OpenStreetMap' } },
  { id: 'mapbox-satellite', group: 'Mapbox', label: 'Satellite Streets', needsToken: true,
    raster: { tiles: mapbox('satellite-streets-v12'), attribution: '© Mapbox © OpenStreetMap' } },
]

export const MAPBOX_ENABLED = !!MAPBOX_TOKEN
export const DEFAULT_BASEMAP = 'openfreemap-positron'

// OpenRailwayMap — a transparent overlay drawn on top of the basemap.
export const RAILWAY_OVERLAY = {
  tiles: [
    'https://a.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png',
    'https://b.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png',
    'https://c.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png',
  ],
  attribution: '© OpenRailwayMap contributors',
}

// A plain solid-color background (no tiles) — a clean canvas behind the metro data.
export function solidStyle(color) {
  return {
    version: 8,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': color } }],
  }
}

// Build a MapLibre style spec (or return the vector style URL string) for a basemap.
export function styleFor(basemap) {
  if (basemap.background) return solidStyle(basemap.background)
  if (basemap.style) return basemap.style
  return {
    version: 8,
    sources: {
      basemap: { type: 'raster', tiles: basemap.raster.tiles, tileSize: 256,
        attribution: basemap.raster.attribution || '' },
    },
    layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
  }
}

export function basemapById(id) {
  return BASEMAPS.find((b) => b.id === id) || BASEMAPS[0]
}

// Basemaps grouped for the picker UI.
export function basemapGroups() {
  const out = []
  for (const b of BASEMAPS) {
    let g = out.find((x) => x.group === b.group)
    if (!g) { g = { group: b.group, items: [] }; out.push(g) }
    g.items.push(b)
  }
  return out
}
