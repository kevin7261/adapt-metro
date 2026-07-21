import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { serveDataDir } from './vite/serveDataDir.js'
import { serveSlides } from './vite/serveSlides.js'
import { serveSkills } from './vite/serveSkills.js'
import { llmAlignTrigger, llmGridTrigger, llmEvalTrigger, llmCompareTrigger } from './vite/llmTriggers.js'
import { copyStaticAssets } from './vite/copyStaticAssets.js'

// GitHub Pages project site: https://kevin7261.github.io/adapt-metro/
const pages = process.env.GITHUB_PAGES === '1'

export default defineConfig({
  base: pages ? '/adapt-metro/' : '/',
  plugins: [
    vue(),
    serveDataDir(),
    serveSkills(),
    serveSlides(),
    llmAlignTrigger(),
    llmGridTrigger(),
    llmEvalTrigger(),
    llmCompareTrigger(),
    copyStaticAssets(),
  ],
  server: {
    port: 5173,
  },
})
