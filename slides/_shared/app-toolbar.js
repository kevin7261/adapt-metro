/* 靜態頁共用 header——與首頁 TopToolbar 連結順序／RWD 一致（不含「重新計算」）。
 *
 * AdaptMetroToolbar.mount(el|selector, { base, active })
 *   base   = 從本頁到網站根目錄的相對路徑
 *   active = 'thesis' | 'paper' | 'improve' | 'slides' | 'architecture' | ''
 * AdaptMetroToolbar.setActive(id)
 */
(function () {
  var RELATED = [
    { label: 'Metro systems (Wikipedia)', href: 'https://en.wikipedia.org/wiki/List_of_metro_systems' },
    { label: 'UrbanRail.net', href: 'https://www.urbanrail.net/' },
  ]
  var NAV = [
    { id: 'thesis', label: '論文內容', path: 'slides/thesis/' },
    { id: 'paper', label: '論文本文', path: 'slides/thesis/paper/' },
    { id: 'improve', label: '改善建議', path: 'slides/thesis/paper/?doc=improve' },
    { id: 'slides', label: '系統介紹', path: 'slides/' },
    { id: 'architecture', label: '系統架構', path: 'slides/architecture/' },
  ]

  var rootEl = null
  var currentActive = ''

  function join(base, path) {
    if (!path) return base || './'
    if (/^https?:/i.test(path)) return path
    var b = base || ''
    if (b && !b.endsWith('/')) b += '/'
    return b + path
  }

  function icon(name, size) {
    return '<span class="material-symbols-outlined m-icon" style="font-size:' + size + 'px">' + name + '</span>'
  }

  function navLinksHtml(active, base) {
    return NAV.map(function (n) {
      var cls = 'btn-ghost' + (n.id === active ? ' active' : '')
      return '<a class="' + cls + '" data-nav="' + n.id + '" href="' + join(base, n.path) + '">' + n.label + '</a>'
    }).join('')
  }

  function relatedItemsHtml() {
    return RELATED.map(function (r) {
      return '<a class="menu-item" href="' + r.href + '" target="_blank" rel="noopener noreferrer">' +
        icon('open_in_new', 14) + ' ' + r.label + '</a>'
    }).join('')
  }

  function moreNavHtml(active, base) {
    return NAV.map(function (n) {
      var cls = 'menu-item' + (n.id === active ? ' active' : '')
      return '<a class="' + cls + '" data-nav="' + n.id + '" href="' + join(base, n.path) + '">' + n.label + '</a>'
    }).join('')
  }

  function render(el, base, active) {
    currentActive = active || ''
    el.innerHTML =
      '<a class="brand" href="' + join(base, '') + '" title="Adapt-Metro">' +
        icon('map', 16) +
        '<span class="brand-name">Adapt-Metro</span>' +
      '</a>' +
      '<div class="toolbar-end">' +
        '<a class="btn-ghost skills-link" href="' + join(base, '') + '" title="Skills">' +
          '<span class="material-symbols-outlined m-icon skills-ico" style="font-size:16px">auto_awesome</span>' +
          '<span class="lbl">Skills</span></a>' +
        '<div class="nav-wide">' +
          navLinksHtml(currentActive, base) +
          '<div class="info-wrap">' +
            '<button class="btn-ghost" id="relBtn" type="button">相關連結</button>' +
            '<div class="menu-pop" id="relMenu" hidden>' +
              '<div class="menu-label">相關連結</div>' +
              relatedItemsHtml() +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="more-wrap nav-narrow">' +
          '<button class="btn-ghost more-btn" id="moreBtn" type="button" title="更多" aria-label="更多">' +
            icon('menu', 18) + '<span class="lbl">更多</span>' +
          '</button>' +
          '<div class="menu-pop" id="moreMenu" hidden>' +
            '<div class="menu-label">文件與介紹</div>' +
            moreNavHtml(currentActive, base) +
            '<div class="menu-sep"></div>' +
            '<div class="menu-label">相關連結</div>' +
            relatedItemsHtml() +
          '</div>' +
        '</div>' +
      '</div>'
  }

  function bindMenus(el) {
    function wire(btnId, menuId) {
      var btn = el.querySelector('#' + btnId)
      var menu = el.querySelector('#' + menuId)
      if (!btn || !menu) return
      btn.addEventListener('click', function (e) {
        e.stopPropagation()
        var open = menu.hidden
        el.querySelectorAll('.menu-pop').forEach(function (m) { m.hidden = true })
        btn.classList.toggle('active', open)
        el.querySelectorAll('.more-btn, #relBtn').forEach(function (b) {
          if (b !== btn) b.classList.remove('active')
        })
        menu.hidden = !open
        if (!open) btn.classList.remove('active')
      })
    }
    wire('relBtn', 'relMenu')
    wire('moreBtn', 'moreMenu')
    document.addEventListener('mousedown', function (e) {
      if (!el.contains(e.target)) {
        el.querySelectorAll('.menu-pop').forEach(function (m) { m.hidden = true })
        el.querySelectorAll('.more-btn, #relBtn').forEach(function (b) { b.classList.remove('active') })
      }
    })
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        el.querySelectorAll('.menu-pop').forEach(function (m) { m.hidden = true })
        el.querySelectorAll('.more-btn, #relBtn').forEach(function (b) { b.classList.remove('active') })
      }
    })
  }

  function setActive(id) {
    currentActive = id || ''
    if (!rootEl) return
    rootEl.querySelectorAll('[data-nav]').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-nav') === currentActive)
    })
  }

  function mount(target, opts) {
    opts = opts || {}
    var el = typeof target === 'string' ? document.querySelector(target) : target
    if (!el) return
    rootEl = el
    el.classList.add('app-toolbar')
    render(el, opts.base || '', opts.active || '')
    bindMenus(el)
  }

  window.AdaptMetroToolbar = { mount: mount, setActive: setActive }
})()
