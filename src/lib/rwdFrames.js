// RWD 模擬用的版面尺寸（類似 Illustrator artboard 預設）。
// id='auto'＝跟目前面板一樣大；其餘用固定寬高當畫線座標系，SVG letterbox 置中。
export const RWD_FRAMES = [
  { id: 'auto', label: '目前版面', w: null, h: null },
  // 網頁 橫（landscape，網頁的預設方向）
  { id: 'web-1920', group: '網頁橫', label: 'Desktop HD · 1920×1080', w: 1920, h: 1080 },
  { id: 'web-1440', group: '網頁橫', label: 'Desktop · 1440×900', w: 1440, h: 900 },
  { id: 'web-1366', group: '網頁橫', label: 'Laptop · 1366×768', w: 1366, h: 768 },
  { id: 'web-1280', group: '網頁橫', label: 'Desktop · 1280×800', w: 1280, h: 800 },
  { id: 'web-1024', group: '網頁橫', label: 'Tablet · 1024×768', w: 1024, h: 768 },
  // 網頁 直（portrait，寬高對調）
  { id: 'web-1920-v', group: '網頁直', label: 'Desktop HD · 1080×1920', w: 1080, h: 1920 },
  { id: 'web-1440-v', group: '網頁直', label: 'Desktop · 900×1440', w: 900, h: 1440 },
  { id: 'web-1366-v', group: '網頁直', label: 'Laptop · 768×1366', w: 768, h: 1366 },
  { id: 'web-1280-v', group: '網頁直', label: 'Desktop · 800×1280', w: 800, h: 1280 },
  { id: 'web-1024-v', group: '網頁直', label: 'Tablet · 768×1024', w: 768, h: 1024 },
  // 手機 直（portrait，手機的預設方向）
  { id: 'phone-390', group: '手機直', label: 'iPhone · 390×844', w: 390, h: 844 },
  { id: 'phone-375', group: '手機直', label: 'iPhone SE · 375×667', w: 375, h: 667 },
  { id: 'phone-430', group: '手機直', label: 'iPhone Max · 430×932', w: 430, h: 932 },
  { id: 'phone-360', group: '手機直', label: 'Android · 360×800', w: 360, h: 800 },
  { id: 'pad-768', group: '手機直', label: 'iPad · 768×1024', w: 768, h: 1024 },
  { id: 'pad-834', group: '手機直', label: 'iPad Pro · 834×1194', w: 834, h: 1194 },
  // 手機 橫（landscape，寬高對調）
  { id: 'phone-390-h', group: '手機橫', label: 'iPhone · 844×390', w: 844, h: 390 },
  { id: 'phone-375-h', group: '手機橫', label: 'iPhone SE · 667×375', w: 667, h: 375 },
  { id: 'phone-430-h', group: '手機橫', label: 'iPhone Max · 932×430', w: 932, h: 430 },
  { id: 'phone-360-h', group: '手機橫', label: 'Android · 800×360', w: 800, h: 360 },
  { id: 'pad-768-h', group: '手機橫', label: 'iPad · 1024×768', w: 1024, h: 768 },
  { id: 'pad-834-h', group: '手機橫', label: 'iPad Pro · 1194×834', w: 1194, h: 834 },
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
