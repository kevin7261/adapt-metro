import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { serveDataDir } from './vite/serveDataDir.js'
import { cityStatus } from './vite/cityStatus.js'
import { serveSlides } from './vite/serveSlides.js'
import { serveSkills } from './vite/serveSkills.js'
import { llmAlignTrigger, llmGridTrigger, llmEvalTrigger, llmCompareTrigger, llmShapeTrigger } from './vite/llmTriggers.js'
import { hcCellsPersist } from './vite/hcCellsPersist.js'
import { metroRecompute } from './vite/metroRecompute.js'
import { copyStaticAssets } from './vite/copyStaticAssets.js'

// GitHub Pages project site: https://kevin7261.github.io/adapt-metro/
const pages = process.env.GITHUB_PAGES === '1'

export default defineConfig({
  base: pages ? '/adapt-metro/' : '/',
  plugins: [
    vue(),
    cityStatus(), // 必須在 serveDataDir 之前攔截 /data/metro/city_status.json
    serveDataDir(),
    serveSkills(),
    serveSlides(),
    llmAlignTrigger(),
    llmGridTrigger(),
    llmEvalTrigger(),
    llmCompareTrigger(),
    llmShapeTrigger(),
    hcCellsPersist(),
    metroRecompute(),
    copyStaticAssets(),
  ],
  server: {
    port: 5173,
  },
})
