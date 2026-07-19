// RWD 模擬用的版面尺寸（類似 Illustrator artboard 預設）。
// id='auto'＝跟目前面板一樣大；其餘用固定寬高當畫線座標系，SVG letterbox 置中。
export const RWD_FRAMES = [
  { id: 'auto', label: '目前版面', w: null, h: null },
  // 網頁
  { id: 'web-1920', group: '網頁', label: 'Desktop HD · 1920×1080', w: 1920, h: 1080 },
  { id: 'web-1440', group: '網頁', label: 'Desktop · 1440×900', w: 1440, h: 900 },
  { id: 'web-1366', group: '網頁', label: 'Laptop · 1366×768', w: 1366, h: 768 },
  { id: 'web-1280', group: '網頁', label: 'Desktop · 1280×800', w: 1280, h: 800 },
  { id: 'web-1024', group: '網頁', label: 'Tablet 橫 · 1024×768', w: 1024, h: 768 },
  // 手機／平板
  { id: 'phone-390', group: '手機', label: 'iPhone · 390×844', w: 390, h: 844 },
  { id: 'phone-375', group: '手機', label: 'iPhone SE · 375×667', w: 375, h: 667 },
  { id: 'phone-430', group: '手機', label: 'iPhone Max · 430×932', w: 430, h: 932 },
  { id: 'phone-360', group: '手機', label: 'Android · 360×800', w: 360, h: 800 },
  { id: 'pad-768', group: '手機', label: 'iPad · 768×1024', w: 768, h: 1024 },
  { id: 'pad-834', group: '手機', label: 'iPad Pro · 834×1194', w: 834, h: 1194 },
  // IG／社群
  { id: 'ig-square', group: 'IG', label: '貼文正方 · 1080×1080', w: 1080, h: 1080 },
  { id: 'ig-story', group: 'IG', label: '限時動態 · 1080×1920', w: 1080, h: 1920 },
  { id: 'ig-portrait', group: 'IG', label: '直式貼文 · 1080×1350', w: 1080, h: 1350 },
  { id: 'ig-landscape', group: 'IG', label: '橫式 · 1080×566', w: 1080, h: 566 },
]

export function resolveRwdFrame(id, hostW, hostH) {
  const f = RWD_FRAMES.find((x) => x.id === id) ?? RWD_FRAMES[0]
  if (!f.w || !f.h) return { id: 'auto', w: hostW, h: hostH, label: f.label }
  return { id: f.id, w: f.w, h: f.h, label: f.label }
}

/** 下拉用：依 group 分組（auto 單獨一項） */
export function rwdFrameGroups() {
  const groups = []
  let cur = null
  for (const f of RWD_FRAMES) {
    if (!f.group) {
      groups.push({ group: null, items: [f] })
      cur = null
      continue
    }
    if (!cur || cur.group !== f.group) {
      cur = { group: f.group, items: [] }
      groups.push(cur)
    }
    cur.items.push(f)
  }
  return groups
}
