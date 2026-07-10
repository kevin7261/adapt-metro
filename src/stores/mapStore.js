import { defineStore } from 'pinia'

let toastTimer = null

export const useMapStore = defineStore('map', {
  state: () => ({
    dark: true,
    accent: 'blue',
    projectName: 'adapt-metro.geolibre.json',

    ui: {
      layerPanelOpen: true,
      // Attribute table open/closed is independent per layer (layerId -> bool);
      // each layer tab controls its own.
      attributeTableOpen: {},
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
    // Toggle (or force) a single layer's attribute table — independent per layer.
    toggleAttributeTable(layerId, force) {
      if (!layerId) return
      const open = force === undefined ? !this.ui.attributeTableOpen[layerId] : force
      this.ui.attributeTableOpen = { ...this.ui.attributeTableOpen, [layerId]: open }
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
          // Default layer name = the geojson filename (without extension).
          name: id,
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

    // Drop a layer from the list and clear any state keyed to it. Callers are
    // responsible for closing its editor tab and freeing its loaded GeoJSON.
    removeLayer(id) {
      const i = this.layers.findIndex((l) => l.id === id)
      if (i === -1) return
      this.layers.splice(i, 1)
      delete this.selectedFeatures[id]
      delete this.ui.attributeTableOpen[id]
      if (this.selectedLayerId === id) {
        this.selectedLayerId = this.layers[0]?.id ?? null
      }
    },
  },
})
