// LLM 對齊（/llm-align）、LLM 調整（/llm-grid）與 LLM 評價（/llm-eval）共用的
// run/poll 機構：POST 觸發 vite plugin spawn 的 headless Claude Code、2.5s 輪詢
// status、streamed transcript 自動捲到底、409（已在跑）視為接上。三者的差異——
// endpoint、額外參數（grid 多帶 compact）、啟動時的快取清理/動畫快照/自動切 tab、
// 重畫守門（llmMode vs 評價/互動的唯讀）、完成後的快取清理——全部由 config 注入。
// cityId/model 是 getter（呼叫端的 computed/ref）、render 是呼叫端的重畫函式。
export function makeHeadlessRun({ base, params, run, tail, text, logEl, shouldRender, onStart, onDone, cityId, model, render }) {
  let timer = null
  // Claude Code's stream-json error contains a very large init payload before
  // the actual 429 message. Never surface that raw transcript in the panel.
  const readableFailure = (raw) => {
    const s = String(raw || '')
    if (/rate_limit|session limit|api_error.*429|hit your session limit/i.test(s)) {
      const reset = s.match(/resets?\s+([^"\n}]+?)(?:["}\n]|$)/i)?.[1]?.trim()
      return `Claude Code 使用額度已達上限${reset ? `；${reset} 後再試` : '；請在額度重設後再試'}。`
    }
    const result = s.match(/"result"\s*:\s*"([^"]+)"/)?.[1]
    return result || s.split('\n').filter(Boolean).at(-1)?.slice(0, 400) || 'LLM 執行失敗'
  }
  async function start(userPrompt = '') {
    const cid = cityId()
    if (!cid || run.value === 'running') return
    // 先擷取 params（含 align 的 base＝目前顯示佈局）——必須在 onStart 清掉 toggle
    // 狀態「之前」算好，否則 base 會被 onStart 洗掉（re-run 自動對齊誤判成 hc）。
    const runParams = params()
    run.value = 'running'
    tail.value = ''
    text.value = ''
    // 清掉舊結果——執行中畫布留白、蓋上執行中 overlay，跑完再重新載入新結果
    // （做好之後才再出現）。面板/按鈕的狀態保留（顯示執行中）。
    onStart()
    if (shouldRender()) render()
    try {
      const res = await fetch(`${base}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          city: cid, ...runParams,
          userPrompt: typeof userPrompt === 'string' ? userPrompt : '',
          model: model(), // 面板下拉選的模型（'default' → 不帶 --model）
        }),
      })
      if (!res.ok && res.status !== 409) throw new Error(`HTTP ${res.status}`)
      poll()
    } catch {
      run.value = 'error'
      tail.value = '無法觸發——需要本機 npm run dev（vite）＋已安裝 Claude Code CLI'
    }
  }
  function poll() {
    clearTimeout(timer)
    timer = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({ city: cityId(), ...params() })
        const res = await fetch(`${base}/status?${qs}`)
        const s = await res.json()
        tail.value = s.tail ?? ''
        if (s.text != null) {
          text.value = s.text
          // stick to the bottom so the newest reply is always visible
          requestAnimationFrame(() => {
            if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
          })
        }
        if (s.running) {
          // still running — keep the map blank + overlay up, just refresh the log
          poll()
        } else if (s.exit === 0) {
          onDone(true) // reload the finished result
          run.value = null
          render()
        } else {
          onDone(false)
          run.value = 'error'
          tail.value = readableFailure(`${tail.value}\n${text.value}`)
          if (shouldRender()) render() // fall to the 開始 retry state
        }
      } catch {
        run.value = 'error'
        tail.value = '狀態輪詢失敗'
      }
    }, 2500)
  }
  return { start, stop: () => clearTimeout(timer) }
}
