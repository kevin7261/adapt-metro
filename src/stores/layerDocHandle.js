import { reactive } from 'vue'

// Which layer-doc is shown in the LayerDocViewer modal. `key` picks the doc
// content; `title` is the EXACT name of the layer/section the user clicked (so
// the modal heading matches what they clicked — 使用者要求「標題跟該圖層同名」).
// A tiny shared reactive so both the Map Adjust view tree (D3Tab section
// headers) and the data-layer panel (LayerPanel rows) open the same modal,
// rendered once by a single mounted <LayerDocViewer>.
export const layerDoc = reactive({ key: null, title: null })

export function openLayerDoc(key, title = null) {
  layerDoc.key = key
  layerDoc.title = title
}
export function closeLayerDoc() {
  layerDoc.key = null
  layerDoc.title = null
}
