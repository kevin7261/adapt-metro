/** Resolve a site-root path against Vite's `base` (e.g. `/adapt-metro/` on GitHub Pages). */
export function assetUrl(path) {
  const base = import.meta.env.BASE_URL || '/'
  const cleaned = String(path || '').replace(/^\/+/, '')
  return `${base}${cleaned}`
}
