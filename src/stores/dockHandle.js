// Plain (non-reactive) handle to the live Dockview API.
// Kept outside Pinia/Vue reactivity on purpose (same reason as mapHandle).
export const dockHandle = { api: null }

// Open the tab for a layer, or focus it if it is already open.
export function openLayerTab(layer) {
  const api = dockHandle.api
  if (!api || !layer) return
  const existing = api.getPanel(layer.id)
  if (existing) {
    existing.api.setActive()
    return
  }
  api.addPanel({
    id: layer.id,
    component: layer.type === 'd3' ? 'd3-tab' : 'layer-tab',
    title: layer.name,
    params: { layerId: layer.id },
    // Keep hidden tabs mounted so each tab's map keeps its view state.
    renderer: 'always',
  })
}
