import { defineStore } from 'pinia'

let toastTimer = null

export const useMapStore = defineStore('map', {
  state: () => ({
    dark: true,
    accent: 'blue',
    projectName: 'adapt-metro.geolibre.json',

    ui: {
      layerPanelOpen: true,
      attributeTable: false,
      commandPalette: false,
      dialog: null, // 'import-metro' | 'add-data' | 'settings' | 'about' | 'shortcuts' | 'new-project'
      toast: null,
    },

    layerPanelWidth: 300,
    attributeTableHeight: 260,

    // Layer of the active editor tab (mirrors the dockview active panel).
    selectedLayerId: null,

    // Properties of the last-clicked map feature, per layer id (null = nothing
    // selected). The map tab writes it on click; the Object tab reads it.
    selectedFeatures: {},

    // Flat list — every layer opens as its own editor tab.
    // Populated by importing metro systems (Import Metro Map).
    layers: [],
  }),

  getters: {
    selectedLayer(state) {
      return state.layers.find((l) => l.id === state.selectedLayerId) ?? null
    },
    allLayersVisible(state) {
      return state.layers.every((l) => l.visible)
    },
  },

  actions: {
    toast(message) {
      this.ui.toast = message
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => { this.ui.toast = null }, 2600)
    },
    fake(name) {
      this.toast(`「${name}」為 UI 原型 — 功能尚未實作`)
    },

    // props = the clicked feature's properties object, or null to clear.
    setSelectedFeature(layerId, props) {
      this.selectedFeatures[layerId] = props ?? null
    },

    // sys = an entry of data/metro/index.json `systems`
    // (file, continent, country, city, line_count, station_count, …)
    importMetroSystem(sys) {
      // 'systems/asia/taiwan/asia-taiwan-taipei.geojson' → 'asia-taiwan-taipei'
      const id = sys.file.split('/').pop().replace(/\.geojson$/, '')
      let layer = this.layers.find((l) => l.id === id)
      if (!layer) {
        layer = {
          id,
          name: `metro_map_${sys.city.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
          type: 'metro',
          file: `/data/metro/${sys.file}`,
          continent: sys.continent,
          country: sys.country,
          city: sys.city,
          visible: true,
          opacity: 1,
          strokeWidth: 2.5,
          radius: 4,
          symbology: 'categorized',
          lineCount: sys.line_count ?? 0,
          stationCount: sys.station_count ?? 0,
          featureCount: (sys.line_count ?? 0) + (sys.station_count ?? 0),
        }
        this.layers.push(layer)
      }
      this.selectedLayerId = layer.id
      return layer
    },
  },
})
