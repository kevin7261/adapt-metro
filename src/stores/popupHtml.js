// 共用 hover popup HTML（使用者規則：hover 內容＝物件 tab 顯示，且**地圖與 D3 視圖必須同一份**）。
// LayerTab（MapLibre popup）與 D3Tab（.ma-tip tooltip）都從這裡組 HTML——改物件 tab 顯示時
// 同步這裡即可，地圖與 D3 hover by construction 同一份；屬性表僅物件 tab、不進 hover。
// 純函式；props 可能是 MapLibre 序列化過的字串（巢狀值 JSON 字串），一律先 J() 正規化。

const J = (v, fb) => {
  if (typeof v !== 'string') return v ?? fb
  try { return JSON.parse(v) } catch { return fb }
}

// 小元件（樣式對齊 StylePanel 的 .line-swatch/.line-ref/.obj-route-count/.obj-pass-tag/.obj-title）
const H = {
  swatch: (c) => `<span style="width:14px;height:6px;border-radius:3px;background:${c || '#e11d48'};margin-right:8px;flex:none"></span>`,
  ref: (t) => t ? `<span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.5;padding:1px 5px;border-radius:4px;background:rgba(127,127,140,.22);color:rgba(155,163,175,1);margin-right:8px;flex:none;min-width:34px;text-align:center;box-sizing:border-box">${t}</span>` : '',
  refC: (t, c) => t ? `<span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.5;padding:1px 5px;border-radius:4px;background:${c || 'rgba(127,127,140,.35)'};color:#fff;margin-right:4px;flex:none;min-width:34px;text-align:center;box-sizing:border-box">${t}</span>` : '',
  dim: (t) => `<span style="margin-left:auto;padding-left:12px;font-weight:400;font-size:11px;color:rgba(155,163,175,1);flex:none">${t}</span>`,
  row: (inner) => `<div style="display:flex;align-items:center;gap:0;margin-top:4px;white-space:nowrap">${inner}</div>`,
  title: (name, en) => `<div style="font-weight:700;font-size:15px;line-height:1.3">${name}</div>` +
    (en ? `<div style="margin-top:1px;font-size:12px;font-weight:400;color:rgba(155,163,175,1)">${en}</div>` : ''),
  passTag: () => '<span style="margin-left:auto;padding:0 7px;font-size:10.5px;font-weight:600;color:rgba(155,163,175,1);border:1px solid rgba(127,127,140,.45);border-radius:999px;flex:none">pass</span>',
}

// 屬性表**只在物件 tab**（使用者 2026-07：屬性內容不要跑到 hover 上）——hover 僅結構區塊：
// 標題（中/英）、共站站名、停靠/行經路線、線的段站序（官方碼＋pass）。

/** Hover 資料索引（LayerTab / D3Tab 共用；per dataset 建一次）：
 *  refColor: Map<ref|route_name, colour>（名鍵——同 ref 支線異色，如小碧潭）、
 *  segs: Map<seg_id, 原始 feature>（事件 feature 幾何被 tile 裁切，一律回原始資料查）、
 *  stByCoord: Map<'lng,lat', 車站 props>。 */
export function buildPopupIndex(data) {
  const refColor = new Map(), segs = new Map(), stByCoord = new Map()
  for (const f of data.features) {
    if (f.geometry.type === 'Point') {
      stByCoord.set(f.geometry.coordinates.join(','), f.properties)
      continue
    }
    if (f.properties?.seg_id != null) segs.set(f.properties.seg_id, f)
    for (const r of f.properties.routes ?? []) {
      if (r.route_ref && !refColor.has(r.route_ref)) refColor.set(r.route_ref, r.route_color)
      if (r.route_name && !refColor.has(r.route_name)) refColor.set(r.route_name, r.route_color)
    }
  }
  return { refColor, segs, stByCoord }
}

/** 該路段上的車站（原始幾何頂點序、連續去重）——線壓在站上，快車 pass 頂點也是
 *  站座標，停靠與通過站都會列出。seg 可為 null（回空列）。 */
export function stationsAlongSeg(seg, stByCoord) {
  const out = []
  if (!seg) return out
  for (const line of seg.geometry.coordinates) {
    for (const c of line) {
      const st = stByCoord.get(c.join(','))
      if (st && (!out.length || out[out.length - 1].station_id !== st.station_id)) out.push(st)
    }
  }
  return out
}

/** 車站 hover（含黃色路線交叉點——props 只有 station_id/station_name 也能渲染）。
 *  refColor: Map<ref, colour>（由路段 routes meta 建）。 */
export function stationPopupHtml(p, refColor) {
  const mn = J(p.merged_names, null)
  const hasMerged = Array.isArray(mn) && mn.length > 1
  // 標題與物件 tab 同構（StylePanel joinTitle）：共站異名以 " / " 併（汐留 / 新橋、
  // 日比谷 / 有楽町…），英文取代表站。之前 hover 只顯示代表名一個，與物件 tab 不一致。
  const titleName = hasMerged ? [...new Set(mn.map((m) => m.station_name))].join(' / ') : (p.station_name ?? '—')
  const en = p.station_name_en && p.station_name_en !== p.station_name ? p.station_name_en : null
  let html = H.title(titleName, en)
  if (hasMerged) {
    html += `<div style="opacity:.65;font-size:10px;margin-top:4px">共站（各線）</div>`
    for (const m of mn) {
      const chips = (m.lines || []).map((ref) => H.refC(ref, refColor?.get(ref))).join('')
      html += H.row(`<span style="margin-right:6px">${m.station_name}</span>${chips}`)
    }
  }
  const rts = J(p.routes, []) ?? []
  const routeRow = (r) => {
    // 車站 routes 自帶 route_color（個別線色）——優先用；退回 refColor 查表（舊資料相容）。
    // trunk 合併後路段 ref 是幹線值（"1/2/3"），refColor 查不到車站個別 ref，故必須直接帶色。
    const c = r.route_color ?? refColor?.get(r.name) ?? refColor?.get(r.ref) // 名優先（同 ref 支線異色，如小碧潭）——與物件 tab 同
    return H.row(H.swatch(c) + H.ref(r.ref, c) +
      `<strong style="font-size:12px">${r.name ?? r.ref ?? '—'}</strong>` + (r.pass ? H.passTag() : ''))
  }
  const stops = rts.filter((r) => !r.pass), passes = rts.filter((r) => r.pass)
  if (stops.length) html += `<div style="opacity:.65;font-size:10px;margin-top:4px">停靠路線</div>` + stops.map(routeRow).join('')
  if (passes.length) html += `<div style="opacity:.65;font-size:10px;margin-top:4px">行經（不停靠）</div>` + passes.map(routeRow).join('')
  return html
}

/** 路段 hover。onSeg = 該段依幾何序的車站 props 列（可空：只出線列與表）。 */
export function linePopupHtml(p, onSeg = []) {
  let routes = J(p.routes, []) ?? []
  if (!Array.isArray(routes)) routes = []
  const names = [...new Set(routes.map((r) => r.route_name ?? '—'))].join(' / ')
  const ens = [...new Set(routes.map((r) => r.route_name_en ?? r.route_name ?? '—'))].join(' / ')
  let html = H.title(names || '—', ens !== names ? ens : null)
  const seenRow = new Set() // 同官方名分支在共用段列一次就好
  for (const r of routes) {
    const passIds = new Set((r.stations ?? []).filter((s) => s.pass).map((s) => s.station_id))
    // 「停靠 N 站」＝**全線**唯一停靠站數（與物件 tab 的 uniqueCount 同語意——曾是本段
    // 站數，與物件 tab 數字不一致，使用者 2026-07 回報「很多城市沒統一」）。
    const stops = new Set((r.stations ?? []).filter((s) => !s.pass).map((s) => s.station_id)).size || null
    const k = `${r.route_ref ?? ''}|${r.route_name ?? ''}|${stops}`
    if (seenRow.has(k)) continue
    seenRow.add(k)
    html += H.row(H.swatch(r.route_color) + H.ref(r.route_ref, r.route_color) +
      `<strong style="font-size:12px">${r.route_name ?? '—'}</strong>` +
      (stops != null ? H.dim(`停靠 ${stops} 站`) : ''))
    // 段站序（與物件 tab 同構）：本段依幾何序列站、各線官方碼＋pass 灰字標記
    if (onSeg.length) {
      const codeOf = new Map((r.stations ?? []).map((s) => [s.station_id, s.code]))
      html += onSeg.map((st, i) => {
        const isPass = passIds.has(st.station_id)
        const code = codeOf.get(st.station_id)
        return `<div style="display:flex;align-items:center;margin:2px 0 0 22px;font-size:11.5px${isPass ? ';color:rgba(155,163,175,1)' : ''}">` +
          `<span style="opacity:.55;min-width:16px;text-align:right;margin-right:6px">${i + 1}.</span>` +
          (code ? `<span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9.5px;padding:0 4px;border-radius:3px;background:rgba(127,127,140,.22);margin-right:6px">${code}</span>` : '') +
          `<span>${st.station_name}</span>` + (isPass ? H.passTag() : '') + `</div>`
      }).join('')
    }
  }
  return html
}

/** 地標 hover（河流骨架線／皇居・公園面域，data/metro/landmarks）。
 *  與物件 tab 同構：標題（中/英）＋ 類別、長度(河)／面積(面)。 */
const LANDMARK_KIND_ZH = {
  'river-centerline': '河流', river: '河流', palace: '宮殿／皇居', park: '公園',
}
export function landmarkPopupHtml(p) {
  const en = p.name_en && p.name_en !== p.name ? p.name_en : null
  let html = H.title(p.name ?? '—', en)
  const bits = [LANDMARK_KIND_ZH[p.kind] ?? p.kind]
  if (p.length_km != null) bits.push(`${(+p.length_km).toFixed(1)} km`)
  if (p.area_km2 != null) bits.push(`${(+p.area_km2).toFixed(2)} km²`)
  html += H.row(`<span style="font-size:11px;color:rgba(155,163,175,1)">${bits.filter(Boolean).join(' · ')}</span>`)
  return html
}
