import { existsSync, cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { listSkills } from './serveSkills.js'

export function copyStaticAssets() {
  return {
    name: 'copy-static-assets',
    closeBundle() {
      const dist = resolve(process.cwd(), 'dist')
      const metroSrc = resolve(process.cwd(), 'data/metro')
      const metroDest = join(dist, 'data', 'metro')
      if (existsSync(metroSrc)) {
        mkdirSync(join(dist, 'data'), { recursive: true })
        cpSync(metroSrc, metroDest, {
          recursive: true,
          filter: (src) => !src.split(/[/\\]/).includes('_cache'),
        })
      }
      // Highway networks (data/highway) mirror the metro layout — copy them too.
      const highwaySrc = resolve(process.cwd(), 'data/highway')
      if (existsSync(highwaySrc)) {
        mkdirSync(join(dist, 'data'), { recursive: true })
        cpSync(highwaySrc, join(dist, 'data', 'highway'), {
          recursive: true,
          filter: (src) => !src.split(/[/\\]/).includes('_cache'),
        })
      }

      const skillsRoot = resolve(process.cwd(), '.claude/skills')
      const skillsDest = join(dist, 'skills')
      mkdirSync(skillsDest, { recursive: true })
      const skills = listSkills(skillsRoot)
      writeFileSync(join(skillsDest, 'index.json'), JSON.stringify(skills))
      for (const { id } of skills) {
        cpSync(join(skillsRoot, id, 'SKILL.md'), join(skillsDest, `${id}.md`))
      }

      // 系統介紹（/slides）：純靜態頁，不需要 Vite 打包，直接照抄進 dist。
      const slidesSrc = resolve(process.cwd(), 'slides')
      if (existsSync(slidesSrc)) cpSync(slidesSrc, join(dist, 'slides'), { recursive: true })
    },
  }
}
