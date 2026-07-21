<script setup>
import { ref, watch } from 'vue'
import { marked } from 'marked'
import { assetUrl } from '../../lib/assetUrl'
import { LLM_MODEL_OPTIONS } from '../../lib/llmModels'
import { fmtElapsed, toBullets } from '../../lib/llmFormat'
import { METHOD_NOTES } from '../../lib/llmMethodNotes'
import './style-panel.css'

const props = defineProps({
  kind: { type: String, required: true },
  llmRecord: { type: Object, default: null },
  llmRunning: { type: Boolean, default: false },
  llmCanRun: { type: Boolean, default: false },
  llmText: { type: String, default: '' },
  llmMsg: { type: String, default: null },
  llmError: { type: String, default: '' },
  llmApplied: { type: Boolean, default: false },
  promptRecord: { type: Object, default: null },
  promptRunning: { type: Boolean, default: false },
  promptText: { type: String, default: '' },
  promptMsg: { type: String, default: null },
  promptError: { type: String, default: '' },
  promptApplied: { type: Boolean, default: false },
  gridRecord: { type: Object, default: null },
  gridRunning: { type: Boolean, default: false },
  gridCanRun: { type: Boolean, default: false },
  gridText: { type: String, default: '' },
  gridMsg: { type: String, default: null },
  gridError: { type: String, default: '' },
  gridApplied: { type: Boolean, default: false },
  evalRecord: { type: Object, default: null },
  evalRunning: { type: Boolean, default: false },
  evalCanRun: { type: Boolean, default: false },
  evalText: { type: String, default: '' },
  evalMsg: { type: String, default: null },
  evalError: { type: String, default: '' },
  evalApplied: { type: Boolean, default: false },
  compareRecord: { type: Object, default: null },
  compareRunning: { type: Boolean, default: false },
  compareCanRun: { type: Boolean, default: false },
  compareText: { type: String, default: '' },
  compareMsg: { type: String, default: null },
  compareError: { type: String, default: '' },
  llmModel: { type: String, default: 'opus' },
})
const emit = defineEmits(['run-llm', 'run-prompt', 'run-grid', 'run-eval', 'run-compare', 'toggle-eval-exec', 'toggle-grid-exec', 'toggle-llm-exec', 'toggle-prompt-exec', 'update:llm-model'])

const llmUserPrompt = ref('')
const gridUserPrompt = ref('')

function compareLabel(record, id) {
  return record?.candidates?.find((x) => x.id === id)?.label ?? id
}
function compareBadges(record, c) {
  const tags = []
  if (c.id === record.winner) tags.push({ kind: 'all', label: '全部最佳' })
  if (c.id === record.winnerOrig) tags.push({ kind: 'orig', label: '原始最佳' })
  if (c.id === record.winnerRot) tags.push({ kind: 'rot', label: '旋轉最佳' })
  return tags
}

const llmSkillHtml = ref('')
const gridSkillHtml = ref('')
const evalSkillHtml = ref('')
const compareSkillHtml = ref('')
const fetchSkillHtml = async (id, target) => {
  try {
    const res = await fetch(assetUrl(`skills/${id}.md`))
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const md = (await res.text()).replace(/^---\n[\s\S]*?\n---\n/, '')
    target.value = marked.parse(md)
  } catch (err) {
    target.value = `<p>SKILL.md 載入失敗：${err}</p>`
  }
}
watch(() => props.kind, (t) => {
  if (t === 'llm' && !llmSkillHtml.value) fetchSkillHtml('route-llm-align', llmSkillHtml)
  if (t === 'grid' && !gridSkillHtml.value) fetchSkillHtml('route-llm-grid', gridSkillHtml)
  if (t === 'eval' && !evalSkillHtml.value) fetchSkillHtml('route-llm-eval', evalSkillHtml)
  if (t === 'compare' && !compareSkillHtml.value) fetchSkillHtml('route-llm-compare', compareSkillHtml)
}, { immediate: true })

const evalStreamEl = ref(null)
watch(() => props.evalText, () => {
  requestAnimationFrame(() => {
    if (evalStreamEl.value) evalStreamEl.value.scrollTop = evalStreamEl.value.scrollHeight
  })
})
const gridStreamEl = ref(null)
watch(() => props.gridText, () => {
  requestAnimationFrame(() => {
    if (gridStreamEl.value) gridStreamEl.value.scrollTop = gridStreamEl.value.scrollHeight
  })
})
const llmStreamEl = ref(null)
watch(() => props.llmText, () => {
  requestAnimationFrame(() => {
    if (llmStreamEl.value) llmStreamEl.value.scrollTop = llmStreamEl.value.scrollHeight
  })
})
const promptStreamEl = ref(null)
watch(() => props.promptText, () => {
  requestAnimationFrame(() => {
    if (promptStreamEl.value) promptStreamEl.value.scrollTop = promptStreamEl.value.scrollHeight
  })
})
</script>

<template>
        <template v-if="kind === 'grid'">
          <div class="weight-panel">
            <p class="weight-hint">
              用一句話改網格大小：模型推理**每個 X 欄／Y 列區間**在畫面上該佔多大（顯示權重，
              1=原尺寸、&gt;1 放大、&lt;1 壓縮），不搬任何站的格座標。跑完先回傳要怎麼改、
              **不自動套用**——按「執行調整」才把權重正規化進固定外框、在新像素座標重畫
              H/V/45°，「恢復原佈局」切回。與「權重」tab 的流量比例是同一種變形、不同的權重來源。
            </p>
            <template v-if="gridCanRun">
              <textarea
                v-model="gridUserPrompt"
                class="llm-prompt-box"
                rows="3"
                :disabled="gridRunning"
                placeholder="例：把市中心那幾欄拉開；中間幾列拉高；東側壓縮一點、把空間讓給核心…"
              />
              <label class="llm-model-pick">
                模型
                <select :value="llmModel" :disabled="gridRunning"
                  @change="emit('update:llm-model', $event.target.value)">
                  <option v-for="m in LLM_MODEL_OPTIONS" :key="m.key" :value="m.key">{{ m.label }}</option>
                </select>
              </label>
              <button
                class="llm-run-btn"
                :disabled="gridRunning || !gridUserPrompt.trim()"
                @click="emit('run-grid', gridUserPrompt.trim())"
              >{{ gridRunning ? '互動中…' : (gridRecord ? '重新 LLM 互動' : '開始 LLM 互動') }}</button>
              <p class="llm-run-hint">按下會啟動本機 headless Claude Code 依 route-llm-grid skill 推理權重並存檔——跑完不自動套用，用下面的「執行調整」才會改 RWD 路網。放大會明顯（核心 3–5 倍）且由核心向外漸近。</p>
            </template>
            <p v-else class="llm-run-hint">匯入資料沒有城市 id，無法對應結果檔——請用目錄裡的城市。</p>
            <template v-if="gridRunning">
              <h4 class="llm-h">LLM 回傳（即時串流）</h4>
              <pre ref="gridStreamEl" class="llm-pre eval-stream">{{ gridText || '等待模型回應…' }}</pre>
            </template>
            <p v-if="gridError" class="llm-run-hint eval-err">執行失敗：{{ gridError }}</p>

            <template v-if="gridRecord">
              <div class="info-rows">
                <div class="info-row"><span class="info-key">模型</span><span>{{ gridRecord.model ?? '—' }}</span></div>
                <div class="info-row"><span class="info-key">執行時間</span><span>{{ fmtElapsed(gridRecord.elapsedMs) || '—' }}</span></div>
                <div class="info-row"><span class="info-key">網格</span><span>{{ gridRecord.cols }} 欄 × {{ gridRecord.rows }} 列</span></div>
                <div class="info-row">
                  <span class="info-key">最大倍率</span>
                  <span>{{ Math.max(...gridRecord.colW, ...gridRecord.rowW).toFixed(1) }}</span>
                </div>
              </div>
              <p v-if="gridRecord.userPrompt" class="llm-run-hint">上次指示：{{ gridRecord.userPrompt }}</p>
              <h4 class="llm-h">模型的思路</h4>
              <div class="llm-note">{{ gridRecord.note ?? '（無說明）' }}</div>
              <h4 class="llm-h">欄權重（西 → 東）</h4>
              <pre class="llm-pre">{{ gridRecord.colW.map((w) => (+w).toFixed(1)).join(' ') }}</pre>
              <h4 class="llm-h">列權重（北 → 南）</h4>
              <pre class="llm-pre">{{ gridRecord.rowW.map((w) => (+w).toFixed(1)).join(' ') }}</pre>
              <template v-if="gridRecord.finalOutput">
                <h4 class="llm-h">最終輸出</h4>
                <pre class="llm-pre">{{ gridRecord.finalOutput }}</pre>
              </template>

              <!-- 執行調整：跑完的區間權重存在結果檔，這顆按鈕只切換顯示
                   （套用 intervalAxes ⇄ 恢復），不再跑 LLM，可來回比較前後 -->
              <h4 class="llm-h">套用到 RWD 路網</h4>
              <button
                class="llm-run-btn"
                @click="emit('toggle-grid-exec')"
              >{{ gridApplied ? '恢復原佈局' : '執行調整' }}</button>
              <p class="llm-run-hint">這顆按鈕只是切換顯示（不跑 LLM、即時）——「執行調整」用模型推理的欄寬列高重畫 RWD 路網，「恢復原佈局」切回原本的均勻/流量網格，可來回比較。</p>
            </template>
            <p v-else-if="!gridRunning" class="llm-note">{{ gridMsg ?? '尚未產生結果——在上面輸入一句話執行。' }}</p>

            <h4 class="llm-h">使用的 skill：route-llm-grid</h4>
            <details class="llm-skill">
              <summary>展開 SKILL.md 全文（模型執行時遵循的協定）</summary>
              <div class="skill-md llm-skill-md" v-html="gridSkillHtml || '<p>載入中…</p>'"></div>
            </details>

            <h4 class="llm-h">做法說明</h4>
            <ul class="llm-method">
              <li><b>LLM 判斷：</b>{{ METHOD_NOTES.grid.llm }}</li>
              <li><b>程式負責：</b>{{ METHOD_NOTES.grid.code }}</li>
            </ul>
            <p class="llm-method-sum">{{ METHOD_NOTES.grid.sum }}</p>
          </div>
        </template>

        <!-- ============ LLM評價（RWD Maps）: AI 評路網佈局（skill route-llm-eval）============ -->
        <template v-if="kind === 'eval'">
          <div class="weight-panel">
            <p class="weight-hint">
              讓模型評這個路網的佈局：哪些線可以調整讓直線與水平線更多、整體更方正、
              哪條線彎折太多可以更直……只評價、不修改——不會動任何座標，回傳的只是結果文字。
            </p>
            <template v-if="evalCanRun">
              <label class="llm-model-pick">
                模型
                <select :value="llmModel" :disabled="evalRunning"
                  @change="emit('update:llm-model', $event.target.value)">
                  <option v-for="m in LLM_MODEL_OPTIONS" :key="m.key" :value="m.key">{{ m.label }}</option>
                </select>
              </label>
              <button
                class="llm-run-btn"
                :disabled="evalRunning"
                @click="emit('run-eval', '')"
              >{{ evalRunning ? '評價中…' : (evalRecord ? '重新 LLM 評價' : 'LLM 評價') }}</button>
              <p class="llm-run-hint">按下會啟動本機 headless Claude Code 依 route-llm-eval skill 讀佈局幾何（逐線段方向、彎折數）寫評價並存檔，完成後顯示在下面。</p>
            </template>
            <p v-else class="llm-run-hint">匯入資料沒有城市 id，無法對應結果檔——請用目錄裡的城市。</p>
            <template v-if="evalRunning">
              <h4 class="llm-h">LLM 回傳（即時串流）</h4>
              <pre ref="evalStreamEl" class="llm-pre eval-stream">{{ evalText || '等待模型回應…' }}</pre>
            </template>
            <p v-if="evalError" class="llm-run-hint eval-err">執行失敗：{{ evalError }}</p>

            <template v-if="evalRecord">
              <div class="info-rows">
                <div class="info-row"><span class="info-key">模型</span><span>{{ evalRecord.model ?? '—' }}</span></div>
                <div class="info-row"><span class="info-key">執行時間</span><span>{{ fmtElapsed(evalRecord.elapsedMs) || '—' }}</span></div>
                <div class="info-row"><span class="info-key">網格</span><span>{{ evalRecord.stats.cols }} 欄 × {{ evalRecord.stats.rows }} 列</span></div>
                <div class="info-row">
                  <span class="info-key">直段</span>
                  <span>H/V {{ evalRecord.stats.hv }}＋45° {{ evalRecord.stats.d45 }}／{{ evalRecord.stats.segs }} 段</span>
                </div>
              </div>
              <p v-if="evalRecord.userPrompt" class="llm-run-hint">關注點：{{ evalRecord.userPrompt }}</p>
              <h4 class="llm-h">總評</h4>
              <div class="llm-note">{{ evalRecord.summary }}</div>
              <template v-if="(evalRecord.scores ?? []).length">
                <h4 class="llm-h">面向評分</h4>
                <div v-for="(s, i) in evalRecord.scores" :key="i" class="eval-score">
                  <div class="eval-score-head"><span>{{ s.aspect }}</span><b>{{ s.score }}/10</b></div>
                  <div v-if="s.comment" class="llm-note">{{ s.comment }}</div>
                </div>
              </template>
              <template v-if="(evalRecord.lines ?? []).length">
                <h4 class="llm-h">逐線評語</h4>
                <div v-for="(l, i) in evalRecord.lines" :key="i" class="eval-line">
                  <div class="eval-line-name">{{ l.name }}</div>
                  <div class="llm-note">{{ l.comment }}</div>
                </div>
              </template>
              <template v-if="(evalRecord.suggestions ?? []).length">
                <h4 class="llm-h">調整建議（僅建議、不執行）</h4>
                <ol class="eval-suggestions">
                  <li v-for="(s, i) in evalRecord.suggestions" :key="i">{{ s }}</li>
                </ol>
              </template>
              <template v-if="evalRecord.finalOutput">
                <h4 class="llm-h">最終輸出</h4>
                <pre class="llm-pre">{{ evalRecord.finalOutput }}</pre>
              </template>

              <!-- 執行調整：評價時已把 moves 過硬規則、算好調整後佈局存進 exec——
                   這裡只切換顯示（套用 ⇄ 恢復），不再跑 LLM，可來回比較前後差別 -->
              <template v-if="evalRecord.exec">
                <h4 class="llm-h">記錄的調整（評價時已算好）</h4>
                <div class="info-rows">
                  <div class="info-row">
                    <span class="info-key">水平垂直</span>
                    <span>{{ evalRecord.exec.hvBefore }} → {{ evalRecord.exec.hvAfter }}／{{ evalRecord.stats.segs }} 段</span>
                  </div>
                  <div class="info-row">
                    <span class="info-key">移動</span>
                    <span>{{ evalRecord.exec.moved }} 點／提案 {{ evalRecord.exec.proposed }}<template v-if="(evalRecord.exec.rejected ?? []).length">（{{ evalRecord.exec.rejected.length }} 被硬規則拒絕）</template></span>
                  </div>
                </div>
                <button
                  class="llm-run-btn"
                  @click="emit('toggle-eval-exec')"
                >{{ evalApplied ? '恢復原佈局' : '執行調整' }}</button>
                <p class="llm-run-hint">評價時已把建議轉成具體移動、經硬規則驗證並存檔——這顆按鈕只是切換顯示（不跑 LLM、即時），可來回切換比較調整前後的差別。</p>
                <div v-if="(evalRecord.exec.rejected ?? []).length" class="llm-note">被拒絕的提案：{{ evalRecord.exec.rejected.map((x) => `${x.name}→(${x.want[0]},${x.want[1]})`).join('、') }}</div>
              </template>
              <p v-else class="llm-run-hint">此評價沒有記錄具體移動——按「重新 LLM 評價」重新產生即可（新版評價會一併記錄怎麼移動、供一鍵執行）。</p>
            </template>
            <p v-else-if="!evalRunning" class="llm-note">{{ evalMsg ?? '尚未產生評價——按上面的按鈕執行。' }}</p>

            <h4 class="llm-h">使用的 skill：route-llm-eval</h4>
            <details class="llm-skill">
              <summary>展開 SKILL.md 全文（模型執行時遵循的協定）</summary>
              <div class="skill-md llm-skill-md" v-html="evalSkillHtml || '<p>載入中…</p>'"></div>
            </details>

            <h4 class="llm-h">做法說明</h4>
            <ul class="llm-method">
              <li><b>LLM 判斷：</b>{{ METHOD_NOTES.eval.llm }}</li>
              <li><b>程式負責：</b>{{ METHOD_NOTES.eval.code }}</li>
            </ul>
            <p class="llm-method-sum">{{ METHOD_NOTES.eval.sum }}</p>
          </div>
        </template>

        <!-- ============ LLM全部評價：原始＋旋轉最多 8 候選 ============ -->
        <template v-if="kind === 'compare'">
          <div class="weight-panel">
            <h4 class="llm-h">八結果比較</h4>
            <p class="weight-hint">一次比較原始與旋轉的論文①〜⑧八條鏈與可用的 LLM 對齊（最多 18 個），依路網方正、直線多、轉折少與畫面平衡選出全部最佳、原始最佳與旋轉最佳。此功能只評審與說明，不會修改任一候選圖。</p>
            <template v-if="compareCanRun">
              <label class="llm-model-pick">
                模型
                <select :value="llmModel" :disabled="compareRunning"
                  @change="emit('update:llm-model', $event.target.value)">
                  <option v-for="m in LLM_MODEL_OPTIONS" :key="m.key" :value="m.key">{{ m.label }}</option>
                </select>
              </label>
              <button class="llm-run-btn" :disabled="compareRunning"
                @click="emit('run-compare')"
              >{{ compareRunning ? '全部評價中…' : (compareRecord ? '重新 LLM 全部評價' : 'LLM 全部評價') }}</button>
            </template>
            <template v-if="compareRunning">
              <h4 class="llm-h">LLM 回傳（即時串流）</h4>
              <pre class="llm-pre eval-stream">{{ compareText || '等待模型回應…' }}</pre>
            </template>
            <p v-if="compareError" class="llm-run-hint eval-err">執行失敗：{{ compareError }}</p>
            <template v-if="compareRecord">
              <div class="info-rows">
                <div class="info-row"><span class="info-key">模型</span><span>{{ compareRecord.model }}</span></div>
                <div class="info-row"><span class="info-key">執行時間</span><span>{{ fmtElapsed(compareRecord.elapsedMs) || '—' }}</span></div>
                <div class="info-row"><span class="info-key">全部最佳</span><b>{{ compareLabel(compareRecord, compareRecord.winner) }}</b></div>
                <div class="info-row"><span class="info-key">原始最佳</span><b>{{ compareLabel(compareRecord, compareRecord.winnerOrig) }}</b></div>
                <div class="info-row"><span class="info-key">旋轉最佳</span><b>{{ compareLabel(compareRecord, compareRecord.winnerRot) }}</b></div>
              </div>
              <h4 class="llm-h">選擇結論</h4>
              <div class="compare-verdict">
                <div class="compare-verdict-block">
                  <div class="compare-verdict-head">全部最佳 · {{ compareLabel(compareRecord, compareRecord.winner) }}</div>
                  <ul class="eval-bullets">
                    <template v-for="pts in [toBullets(compareRecord.winnerReason)]" :key="'wr'">
                      <li v-for="(t, i) in pts" :key="'w'+i">{{ t }}</li>
                      <li v-if="!pts.length">—</li>
                    </template>
                  </ul>
                </div>
                <div class="compare-verdict-block">
                  <div class="compare-verdict-head">原始最佳 · {{ compareLabel(compareRecord, compareRecord.winnerOrig) }}</div>
                  <ul class="eval-bullets">
                    <template v-for="pts in [toBullets(compareRecord.winnerOrigReason)]" :key="'wor'">
                      <li v-for="(t, i) in pts" :key="'wo'+i">{{ t }}</li>
                      <li v-if="!pts.length">—</li>
                    </template>
                  </ul>
                </div>
                <div class="compare-verdict-block">
                  <div class="compare-verdict-head">旋轉最佳 · {{ compareLabel(compareRecord, compareRecord.winnerRot) }}</div>
                  <ul class="eval-bullets">
                    <template v-for="pts in [toBullets(compareRecord.winnerRotReason)]" :key="'wrr'">
                      <li v-for="(t, i) in pts" :key="'wr'+i">{{ t }}</li>
                      <li v-if="!pts.length">—</li>
                    </template>
                  </ul>
                </div>
                <div v-for="sum in [toBullets(compareRecord.summary)]" :key="'sum'">
                  <div v-if="sum.length" class="compare-verdict-block">
                    <div class="compare-verdict-head">總結</div>
                    <ul class="eval-bullets">
                      <li v-for="(t, i) in sum" :key="'s'+i">{{ t }}</li>
                    </ul>
                  </div>
                </div>
              </div>
              <h4 class="llm-h">各候選優缺點</h4>
              <div v-for="c in compareRecord.candidates" :key="c.id" class="eval-line">
                <div class="eval-line-name">
                  {{ c.label }}
                  <template v-for="tag in compareBadges(compareRecord, c)" :key="tag.kind">
                    <span class="compare-badge" :class="'compare-badge--' + tag.kind">{{ tag.label }}</span>
                  </template>
                </div>
                <ul class="eval-bullets">
                  <li>直線 {{ c.geometry.straight }}/{{ c.geometry.segments }}（{{ (c.geometry.straightness * 100).toFixed(1) }}%）</li>
                  <li>轉折 {{ c.geometry.bends }}（單折 {{ c.geometry.singleBend }}／雙折 {{ c.geometry.doubleBend }}／多折 {{ c.geometry.multiBend }}）</li>
                  <li>平衡 {{ (c.geometry.balance * 100).toFixed(0) }}% · forced {{ c.geometry.forced }} · fallback {{ c.geometry.fallback }}</li>
                </ul>
                <template v-for="a in [compareRecord.analyses.find((x) => x.id === c.id)]" :key="c.id + '-a'">
                  <div class="eval-subh">優點</div>
                  <ul class="eval-bullets">
                    <template v-for="pros in [toBullets(a?.strengths)]" :key="c.id+'-ps'">
                      <li v-for="(t, i) in pros" :key="'ps'+i">{{ t }}</li>
                      <li v-if="!pros.length">—</li>
                    </template>
                  </ul>
                  <div class="eval-subh">缺點</div>
                  <ul class="eval-bullets">
                    <template v-for="cons in [toBullets(a?.weaknesses)]" :key="c.id+'-pw'">
                      <li v-for="(t, i) in cons" :key="'pw'+i">{{ t }}</li>
                      <li v-if="!cons.length">—</li>
                    </template>
                  </ul>
                </template>
              </div>
            </template>
            <p v-else-if="!compareRunning" class="llm-note">{{ compareMsg }}</p>
            <h4 class="llm-h">使用的 skill：route-llm-compare</h4>
            <details class="llm-skill">
              <summary>展開 SKILL.md 全文</summary>
              <div class="skill-md llm-skill-md" v-html="compareSkillHtml || '<p>載入中…</p>'"></div>
            </details>
          </div>
        </template>

        <!-- ============ LLM自動對齊（skill route-llm-align，寫 .json，餵下游）======
             跟 LLM評價/互動 同一套唯讀＋切換 UX：跑完不自動套用，按「執行調整」才
             套用到 LLM 對齊主視圖。與「指定對齊」完全獨立、互不影響。 -->
        <template v-if="kind === 'llm'">
          <div class="weight-panel">
            <p class="weight-hint">
              讓模型**自動對齊**這個路網：短距離移動彩色點、把線盡量拉成水平／垂直
              （最大化 H/V），不需要你下指示。**以主視圖目前顯示的佈局為起點**——按
              「執行調整」把結果套到主視圖，「恢復原佈局」切回。下游的「LLM對齊端點
              移動…」等鏈會**跟著目前顯示的佈局重算**。
            </p>
            <template v-if="llmCanRun">
              <label class="llm-model-pick">
                模型
                <select :value="llmModel" :disabled="llmRunning"
                  @change="emit('update:llm-model', $event.target.value)">
                  <option v-for="m in LLM_MODEL_OPTIONS" :key="m.key" :value="m.key">{{ m.label }}</option>
                </select>
              </label>
              <button
                class="llm-run-btn"
                :disabled="llmRunning"
                @click="emit('run-llm', '')"
              >{{ llmRunning ? '對齊中…' : (llmRecord ? '重新 LLM 自動對齊' : '開始 LLM 自動對齊') }}</button>
              <p class="llm-run-hint">按下會啟動本機 headless Claude Code 依 route-llm-align skill 逐輪最佳化並存檔（跑完不自動套用）。</p>
            </template>
            <p v-else class="llm-run-hint">匯入資料沒有城市 id，無法對應結果檔——請用目錄裡的城市。</p>

            <template v-if="llmRunning">
              <h4 class="llm-h">LLM 回傳（即時串流）</h4>
              <pre ref="llmStreamEl" class="llm-pre eval-stream">{{ llmText || '等待模型回應…' }}</pre>
            </template>
            <p v-if="llmError" class="llm-run-hint eval-err">執行失敗：{{ llmError }}</p>

            <template v-if="llmRecord">
              <div class="info-rows">
                <div class="info-row"><span class="info-key">模型</span><span>{{ llmRecord.model ?? '—' }}</span></div>
                <div class="info-row"><span class="info-key">執行時間</span><span>{{ fmtElapsed(llmRecord.elapsedMs) || '—' }}</span></div>
                <div class="info-row"><span class="info-key">輪數</span><span>{{ llmRecord.rounds }}</span></div>
                <div class="info-row">
                  <span class="info-key">水平垂直</span>
                  <span>{{ llmRecord.hvBefore }} → {{ llmRecord.hvAfter }}／{{ llmRecord.segs }} 段</span>
                </div>
                <div class="info-row"><span class="info-key">移動</span><span>{{ llmRecord.moved }} 站</span></div>
              </div>
              <template v-if="(llmRecord.transcript ?? []).length">
                <h4 class="llm-h">LLM 回傳（逐輪）</h4>
                <div v-for="(t, i) in llmRecord.transcript" :key="i" class="llm-round">
                  <div class="llm-round-head">
                    {{ t.round ? `第 ${t.round} 輪` : '附註' }} · 提案 {{ t.proposed }} 點
                    · HV {{ t.hv }}<template v-if="t.rejected"> · 硬規則拒絕 {{ t.rejected }}</template>
                  </div>
                  <div class="llm-note">{{ t.note ?? '（無說明）' }}</div>
                </div>
              </template>
              <template v-if="llmRecord.finalOutput">
                <h4 class="llm-h">最終輸出</h4>
                <pre class="llm-pre">{{ llmRecord.finalOutput }}</pre>
              </template>

              <h4 class="llm-h">套用到 LLM 對齊主視圖</h4>
              <button class="llm-run-btn" @click="emit('toggle-llm-exec')">{{ llmApplied ? '恢復原佈局' : '執行調整' }}</button>
              <p class="llm-run-hint">切換顯示（不跑 LLM、即時）——「執行調整」用自動對齊的座標重畫主視圖並讓下游各鏈以它重算，「恢復原佈局」切回。與「指定對齊」在主視圖互斥。RWD 'llm' 版面固定以自動對齊為基準。</p>
            </template>
            <p v-else-if="!llmRunning" class="llm-note">{{ llmMsg ?? '尚未產生自動對齊——按上面的按鈕執行。' }}</p>

            <h4 class="llm-h">使用的 skill：route-llm-align</h4>
            <details class="llm-skill">
              <summary>展開 SKILL.md 全文（模型執行時遵循的協定）</summary>
              <div class="skill-md llm-skill-md" v-html="llmSkillHtml || '<p>載入中…</p>'"></div>
            </details>

            <h4 class="llm-h">做法說明</h4>
            <ul class="llm-method">
              <li><b>LLM 判斷：</b>{{ METHOD_NOTES.autoAlign.llm }}</li>
              <li><b>程式負責：</b>{{ METHOD_NOTES.autoAlign.code }}</li>
            </ul>
            <p class="llm-method-sum">{{ METHOD_NOTES.autoAlign.sum }}</p>
          </div>
        </template>

        <!-- ============ LLM指定對齊（skill route-llm-align，寫 .prompt.json）=========
             自己的結果檔、run/串流/結果/toggle（與自動對齊獨立、UI 互不影響）。以主
             視圖目前顯示的佈局為起點；與自動對齊在主視圖互斥（套一個會取消另一個）。 -->
        <template v-if="kind === 'llm-prompt'">
          <div class="weight-panel">
            <p class="weight-hint">
              用**一句話指定**要怎麼對齊：例「優先把紅線拉成水平」「讓東側幾條線對齊
              同一欄」。**以主視圖目前顯示的佈局為起點**（若正顯示自動對齊，就從自動
              對齊結果往下做）。跑完先回傳、**不自動套用**——按「執行調整」才套到主視圖
              （與自動對齊互斥），下游各鏈跟著顯示重算。結果另存、與自動對齊 UI 互不影響。
            </p>
            <template v-if="llmCanRun">
              <label class="llm-model-pick">
                模型
                <select :value="llmModel" :disabled="promptRunning"
                  @change="emit('update:llm-model', $event.target.value)">
                  <option v-for="m in LLM_MODEL_OPTIONS" :key="m.key" :value="m.key">{{ m.label }}</option>
                </select>
              </label>
              <p v-if="promptRecord?.userPrompt" class="llm-run-hint">上次指示：{{ promptRecord.userPrompt }}</p>
              <textarea
                v-model="llmUserPrompt"
                class="llm-prompt-box"
                rows="3"
                :disabled="promptRunning"
                placeholder="例：優先把紅線拉成水平；讓東側幾條線對齊同一欄；把環狀線盡量收成矩形…"
              />
              <button
                class="llm-run-btn"
                :disabled="promptRunning || !llmUserPrompt.trim()"
                @click="emit('run-prompt', llmUserPrompt.trim())"
              >{{ promptRunning ? '對齊中…' : (promptRecord ? '重新指定對齊' : '開始指定對齊') }}</button>
              <p class="llm-run-hint">你的指示會併入 route-llm-align、引導模型「移動哪些點、往哪對齊」，存到獨立的結果檔（跑完不自動套用）。</p>
            </template>
            <p v-else class="llm-run-hint">匯入資料沒有城市 id，無法對應結果檔——請用目錄裡的城市。</p>

            <template v-if="promptRunning">
              <h4 class="llm-h">LLM 回傳（即時串流）</h4>
              <pre ref="promptStreamEl" class="llm-pre eval-stream">{{ promptText || '等待模型回應…' }}</pre>
            </template>
            <p v-if="promptError" class="llm-run-hint eval-err">執行失敗：{{ promptError }}</p>

            <template v-if="promptRecord">
              <div class="info-rows">
                <div class="info-row"><span class="info-key">模型</span><span>{{ promptRecord.model ?? '—' }}</span></div>
                <div class="info-row"><span class="info-key">執行時間</span><span>{{ fmtElapsed(promptRecord.elapsedMs) || '—' }}</span></div>
                <div class="info-row"><span class="info-key">輪數</span><span>{{ promptRecord.rounds }}</span></div>
                <div class="info-row">
                  <span class="info-key">水平垂直</span>
                  <span>{{ promptRecord.hvBefore }} → {{ promptRecord.hvAfter }}／{{ promptRecord.segs }} 段</span>
                </div>
                <div class="info-row"><span class="info-key">移動</span><span>{{ promptRecord.moved }} 站</span></div>
              </div>
              <template v-if="(promptRecord.transcript ?? []).length">
                <h4 class="llm-h">LLM 回傳（逐輪）</h4>
                <div v-for="(t, i) in promptRecord.transcript" :key="i" class="llm-round">
                  <div class="llm-round-head">
                    {{ t.round ? `第 ${t.round} 輪` : '附註' }} · 提案 {{ t.proposed }} 點
                    · HV {{ t.hv }}<template v-if="t.rejected"> · 硬規則拒絕 {{ t.rejected }}</template>
                  </div>
                  <div class="llm-note">{{ t.note ?? '（無說明）' }}</div>
                </div>
              </template>
              <template v-if="promptRecord.finalOutput">
                <h4 class="llm-h">最終輸出</h4>
                <pre class="llm-pre">{{ promptRecord.finalOutput }}</pre>
              </template>

              <h4 class="llm-h">套用到 LLM 對齊主視圖</h4>
              <button class="llm-run-btn" @click="emit('toggle-prompt-exec')">{{ promptApplied ? '恢復原佈局' : '執行調整' }}</button>
              <p class="llm-run-hint">切換顯示（不跑 LLM、即時）——「執行調整」用指定對齊的座標重畫主視圖並讓下游各鏈以它重算（會取消自動對齊的套用），「恢復原佈局」切回。RWD 'llm' 版面固定以自動對齊為基準、不受此切換影響。</p>
            </template>
            <p v-else-if="!promptRunning" class="llm-note">{{ promptMsg ?? '尚未產生指定對齊——在上面輸入一句話執行。' }}</p>

            <h4 class="llm-h">使用的 skill：route-llm-align</h4>
            <details class="llm-skill">
              <summary>展開 SKILL.md 全文（模型執行時遵循的協定）</summary>
              <div class="skill-md llm-skill-md" v-html="llmSkillHtml || '<p>載入中…</p>'"></div>
            </details>

            <h4 class="llm-h">做法說明</h4>
            <ul class="llm-method">
              <li><b>LLM 判斷：</b>{{ METHOD_NOTES.promptAlign.llm }}</li>
              <li><b>程式負責：</b>{{ METHOD_NOTES.promptAlign.code }}</li>
            </ul>
            <p class="llm-method-sum">{{ METHOD_NOTES.promptAlign.sum }}</p>
          </div>
        </template>
</template>
