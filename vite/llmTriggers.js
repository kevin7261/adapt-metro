import { claudeSkillTrigger } from './claudeSkillTrigger.js'
import { COMPACT_KINDS } from './compactKinds.js'

export function llmAlignTrigger() {
  return claudeSkillTrigger({
    name: 'llm-align-trigger',
    prefix: '/llm-align',
    cmdEnv: 'LLM_ALIGN_CMD',
    validate(b) {
      if (!/^[\w-]+$/.test(b.city ?? '') || !['orig', 'rot'].includes(b.variant)) return null
      // kind: 'auto'＝自動對齊（純最大化 H/V，寫 .json，餵下游）；'prompt'＝指定
      // 對齊（依使用者一句話，寫 .prompt.json，只在主視圖比較用）。兩者結果檔、
      // job key 完全分開，互不覆蓋、互不影響。
      const kind = b.kind === 'prompt' ? 'prompt' : 'auto'
      const suffix = kind === 'prompt' ? '.prompt' : ''
      const outFile = `data/metro/llmviews/${b.city}.${b.variant}${suffix}.json`
      // base＝「LLM 對齊主視圖目前顯示的佈局」（hc/auto/prompt）。每次執行都以它為
      // 起點（使用者裁決「以目前顯示的為主」）——handler 在 spawn 前把顯示的那份檔
      // seed 進 outFile：base=auto/prompt → 複製該檔；base=hc → 清掉 outFile 從 HC 起。
      // base 就是本 kind 自己（顯示的正是自己）→ 不動、接著自己 refine。
      const base = ['auto', 'prompt', 'hc'].includes(b.base) ? b.base : 'hc'
      const baseFile = base === 'auto' ? `data/metro/llmviews/${b.city}.${b.variant}.json`
        : base === 'prompt' ? `data/metro/llmviews/${b.city}.${b.variant}.prompt.json` : null
      const seedFrom = (baseFile && baseFile !== outFile) ? baseFile : null
      const resetOut = base === 'hc'
      // Optional user steering: a free-text instruction typed in the panel that
      // biases which coordinates the model moves (e.g.「優先把紅線拉成水平」).
      // 2000: LLM評價的「執行評價結果」會把建議＋逐線評語整段餵進來（>1000 字）。
      const userPrompt = typeof b.userPrompt === 'string' ? b.userPrompt.trim().slice(0, 2000) : ''
      // 注意：key 不可依賴 userPrompt——status 輪詢的 GET 不帶 userPrompt，若這裡
      // 因空 prompt 回 null 會導致指定對齊的狀態查不到 job。空指示的防護交給前端
      // （按鈕在 !prompt 時 disable），這裡只負責產出穩定的 key/outFile。
      return {
        key: `${b.city}.${b.variant}.${kind}`,
        outFile,
        seedFrom,   // handler 在 spawn 前把這份檔複製進 outFile（起點＝目前顯示）
        resetOut,   // base=hc → spawn 前清掉 outFile，從 Hill Climbing 重新起
        userPrompt,
        prompt: `使用 route-llm-align skill：幫城市 ${b.city}（變體 ${b.variant}）產生或更新`
          + (kind === 'prompt'
            ? `「指定對齊」結果——export／apply 一律加 --prompt 旗標，寫到 ${b.city}.${b.variant}.prompt.json（不要動 .json 的自動對齊結果）。`
            : '「自動對齊」結果（寫 .json）。')
          + '起點佈局已由系統 seed 好（＝主視圖目前顯示的佈局）——直接 export 讀現有 outFile 內容當起點、接著往下 refine 即可，不要自己重設起點。'
          + '反覆 export → 分析 → apply 迭代到收斂（上限 10 輪）；每輪 moves.json 都要含 model 與 note（本輪思路），'
          + '第一輪另附 prompt 欄位記錄本段指示。完成後只輸出最終的 水平垂直 before → after 數字與一句總結。'
          + (userPrompt ? `\n\n使用者的指示（請據此決定要移動哪些座標、往哪對齊）：${userPrompt}` : ''),
      }
    },
  })
}

export function llmGridTrigger() {
  return claudeSkillTrigger({
    name: 'llm-grid-trigger',
    prefix: '/llm-grid',
    cmdEnv: 'LLM_GRID_CMD',
    validate(b) {
      if (!/^[\w-]+$/.test(b.city ?? '') || !['orig', 'rot'].includes(b.variant)) return null
      const compact = COMPACT_KINDS.includes(b.compact) ? b.compact : 'hc'
      const userPrompt = (typeof b.userPrompt === 'string' && b.userPrompt.trim())
        ? b.userPrompt.trim().slice(0, 1000)
        : '把路網最密集的核心區域拉開（放大），外圍相對壓縮'
      return {
        key: `${b.city}.${b.variant}.${compact}`,
        outFile: `data/metro/llmgrids/${b.city}.${b.variant}.${compact}.json`,
        userPrompt,
        prompt: `使用 route-llm-grid skill：幫城市 ${b.city}（變體 ${b.variant}，縮減 ${compact}）依使用者的一句話`
          + '推理路網網格每個 X 欄與 Y 列區間的顯示權重（export → 推理 → apply 存檔）。'
          + '權重要明顯（核心 3–5 倍、至少一組 ≥3）、由核心向外漸近、給出全部區間。'
          + '完成後只輸出一句總結（放大了哪一帶、最大倍率）。'
          + `\n\n使用者的指示：${userPrompt}`,
      }
    },
  })
}

export function llmEvalTrigger() {
  return claudeSkillTrigger({
    name: 'llm-eval-trigger',
    prefix: '/llm-eval',
    cmdEnv: 'LLM_EVAL_CMD',
    validate(b) {
      if (!/^[\w-]+$/.test(b.city ?? '') || !['orig', 'rot'].includes(b.variant)) return null
      const compact = COMPACT_KINDS.includes(b.compact) ? b.compact : 'hc'
      const userPrompt = typeof b.userPrompt === 'string' ? b.userPrompt.trim().slice(0, 1000) : ''
      return {
        key: `${b.city}.${b.variant}.${compact}`,
        outFile: `data/metro/llmevals/${b.city}.${b.variant}.${compact}.json`,
        userPrompt,
        prompt: `使用 route-llm-eval skill：幫城市 ${b.city}（變體 ${b.variant}，縮減 ${compact}）產生或更新 LLM 評價`
          + '（export 讀佈局幾何 → 寫評價＋moves → apply 存檔）。評價不修改佈局；'
          + '評語要用站名與數字落地（哪條線哪一段可以更直/更水平、彎在哪、怎麼更方正），'
          + '並把每條建議轉成具體 moves（export 的 verts 索引 → 目標格），apply 會過硬規則、'
          + '把調整後佈局存進結果檔供網頁「執行調整」一鍵切換。'
          + '完成後只輸出一句總結（總評第一句＋執行調整的 H/V 前後數字）。'
          + (userPrompt ? `\n\n使用者的關注點：${userPrompt}` : ''),
      }
    },
  })
}

export function llmCompareTrigger() {
  return claudeSkillTrigger({
    name: 'llm-compare-trigger',
    prefix: '/llm-compare',
    cmdEnv: 'LLM_COMPARE_CMD',
    validate(b) {
      if (!/^[\w-]+$/.test(b.city ?? '')) return null
      return {
        key: b.city,
        outFile: `data/metro/llmcompares/${b.city}.json`,
        prompt: `使用 route-llm-compare skill：一次比較城市 ${b.city} 的原始＋旋轉 RWD Maps 候選（最多 18 個：①筆畫法／②直角爬山／③MILP規劃／④力導向／⑤最小平方／⑥八向格網／⑦路徑簡化／⑧SAT規劃／若存在則 LLM對齊 × 原始／旋轉）。先執行 llmCompare.mjs export，依方正、路線直、轉折少、畫面平衡及 forced/fallback 缺陷做判斷；summary／winnerReason／winnerOrigReason／winnerRotReason／每個候選的 strengths／weaknesses 一律用字串陣列條列（每點一句短話）；必須選出 winner（全體最佳）、winnerOrig（原始最佳）、winnerRot（旋轉最佳），id 形如 orig.rect／rot.milp。用 llmCompare.mjs apply 存檔，絕不修改任何候選佈局。`,
      }
    },
  })
}
