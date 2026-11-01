// areaDomain.mjs — 領域發現(area)的內建領域預設:候選 → AI 判覆蓋並產生領域標籤與學術查詢、輸出驗證、查詢淨化
//
// 【一次呼叫判一批】候選(筆記主概念／文章線索)連同既有領域一次送出,模型逐一判「既有領域是否已語意涵蓋」並為未涵蓋者
//   給出領域標籤(繁中)與 OpenAlex 英文查詢;每次發現至多一次呼叫(由發現子階段控管頻率與時間預算)。
// 【領域中立】主題範圍經 vocab.domain／kbLabel 注入;本檔不綁任何領域詞彙。可經 deps.domains.area(或發現子階段之 opt.domain)整組置換。
// 【提示詞可覆寫】createAreaDomain 之 opt.buildPrompt(candidates, areas, ctx) 取代內建提示詞(ctx 為 { kbLabel, domain, contract, defaultPrompt });
//   輸出之驗證與查詢淨化不隨之改變,覆寫者須依 ctx.contract 要求模型輸出,否則其輸出會被驗證擋下。
// 【查詢淨化】OpenAlex search 與 arXiv 遞補(all:<query>)直接拼接查詢字串;去除引號、括號、布林運算子與特殊字元。
// 【輸出契約單一來源(檢定標準 CS8)】標籤字數、查詢詞數與字元、覆蓋判斷與理由必填——提示詞與驗證同讀 AREA_CONTRACT,
//   使提示詞所述與程式所收一致。

import isarr from 'wsemi/src/isarr.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import isobj from 'wsemi/src/isobj.mjs'
import { resolveVocab, kbLabelOf } from '../core/vocab/vocabDefault.mjs'
import { promptSigText } from '../core/prompts.mjs'
import { resolveLocale } from '../core/locale.mjs'

/** 領域發現之輸出契約(提示詞與驗證之單一來源;凍結,覆寫提示詞者只能讀) */
export const AREA_CONTRACT = Object.freeze({ labelMin: 2, labelMax: 16, queryMinWords: 2, queryMaxWords: 6, queryMaxChars: 80 })

/**
 * 提示詞覆寫之鍵與覆寫函數之形式(唯一一份;總組裝之 cfg.prompts 與本工廠之 opt.buildPrompt 同讀——core/prompts 之 SIGS 形狀):
 *   area＝領域發現之提示詞;末參數 ctx 為 { kbLabel, domain, contract, defaultPrompt }
 *
 * @type {Object}
 */
export const AREA_PROMPT_SIGS = Object.freeze({ area: Object.freeze({ params: '(candidates, areas, ctx)' }) })

/**
 * 淨化學術查詢字串:去引號／括號／布林運算子／特殊字元,壓空白;須為英文(ASCII 字母、數字、連字號)、詞數與字元數合 AREA_CONTRACT 才合格
 *
 * @param {*} q 輸入查詢
 * @returns {String} 回傳淨化後查詢，不合格回''
 * @example
 * console.log(sanitizeAreaQuery('"graph neural networks" AND (survey)'))
 * // => graph neural networks survey
 */
export function sanitizeAreaQuery(q) {
    const s = String(q ?? '')
        .replace(/["'`()[\]{}|&:;*?\\/]/g, ' ')
        .replace(/\b(AND|OR|NOT)\b/g, ' ')
        .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    const words = s.split(' ').filter(Boolean)
    if (words.length < AREA_CONTRACT.queryMinWords || words.length > AREA_CONTRACT.queryMaxWords || s.length > AREA_CONTRACT.queryMaxChars) return ''
    if (!/^[A-Za-z0-9 -]+$/.test(s) || !/[A-Za-z]/.test(s)) return '' // OpenAlex 英文查詢
    return s
}

/**
 * 建立領域發現之領域物件(內建預設；提示詞可覆寫)
 *
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Object} [opt.vocab=null] 輸入詞彙表覆寫物件(見 resolveVocab；取 domain、kbLabel)
 * @param {String|Object} [opt.locale='zh-TW'] 輸入語言設定(語言代碼或 core/locale 之 resolveLocale 產物;提示詞之領域標籤語言句取其稱呼)
 * @param {Function} [opt.buildPrompt] 輸入提示詞覆寫函數 (candidates, areas, ctx) => String，ctx 為 { kbLabel, domain, contract:AREA_CONTRACT,
 *   defaultPrompt:(candidates, areas) => 內建提示詞 }；給了即用之(須回傳非空字串，否則 buildPrompt 拋錯)，未給則用內建預設
 * @returns {Object} 回傳 domain 物件 { vocab, buildPrompt(candidates, areas), isValidItem(it, count), sanitizeQuery, contract }
 * @throws {Error} opt.buildPrompt 給了但非函數、或 opt.locale 不合時拋出
 * @example
 * const d = createAreaDomain({ vocab: { domain: '機器學習' } })
 * console.log(d.buildPrompt([{ label: 'X', kind: 'concept', support: 30, growth: 1.2, samples: [] }], []).includes('「機器學習」知識庫'))
 * // => true
 *
 * const d2 = createAreaDomain({ buildPrompt: (candidates, areas, ctx) => `${ctx.kbLabel}：${candidates.length} 個候選` })
 * console.log(d2.buildPrompt([{ label: 'X' }], []))
 * // => 知識庫：1 個候選
 */
export function createAreaDomain(opt = {}) {
    if (!isobj(opt)) opt = {}
    if (opt.buildPrompt !== undefined && opt.buildPrompt !== null && !isfun(opt.buildPrompt)) {
        throw new Error(`createAreaDomain 之 opt.buildPrompt 須為函數 ${promptSigText(AREA_PROMPT_SIGS.area)}`)
    }
    const customPrompt = isfun(opt.buildPrompt) ? opt.buildPrompt : null
    const vocab = resolveVocab(opt.vocab)
    const kb = kbLabelOf(vocab)
    const L = resolveLocale(opt.locale, 'createAreaDomain 之 opt.locale').label // 輸出語言之稱呼(預設「繁體中文」,提示詞逐字不變)
    const scope = vocab.domain ? `本知識庫之主題範圍為「${vocab.domain}」；與此範圍無關之候選一律 covered 給 true（why 寫「範圍外」）。\n` : ''

    /**
     * 組 prompt:有覆寫者交覆寫函數(ctx 另帶 defaultPrompt＝內建提示詞函數,覆寫者可包裝之),否則用內建
     *
     * @param {Array} candidates 輸入候選陣列(pickAreaCandidates 之產出)
     * @param {Array} areas 輸入既有領域(active／paused)
     * @returns {String} 回傳 prompt
     * @throws {Error} 覆寫之 buildPrompt 未回傳非空字串時拋出
     */
    function buildPrompt(candidates, areas) {
        if (!isarr(candidates)) candidates = []
        if (!isarr(areas)) areas = []
        if (customPrompt) {
            const text = customPrompt(candidates, areas, { kbLabel: kb, domain: vocab.domain, contract: AREA_CONTRACT, defaultPrompt: builtinPrompt })
            if (typeof text !== 'string' || !text.trim()) throw new Error('opt.buildPrompt 須回傳非空字串')
            return text
        }
        return builtinPrompt(candidates, areas)
    }

    /**
     * 內建提示詞
     *
     * @param {Array} candidates 輸入候選陣列
     * @param {Array} areas 輸入既有領域
     * @returns {String} 回傳 prompt
     */
    function builtinPrompt(candidates, areas) {
        if (!isarr(candidates)) candidates = []
        if (!isarr(areas)) areas = []
        const cands = candidates.map((c, i) => {
            const ev = c.kind === 'clue'
                ? `文章線索，被 ${c.clueDocs} 篇相異文件帶出`
                : `筆記主概念，近期 ${c.support} 篇（成長 ${c.growth} 倍）${c.samples?.length ? `；例：${c.samples.slice(0, 3).map((s) => `「${s.title}」`).join('、')}` : ''}`
            return `${i + 1}. 【${c.label}】（${ev}）`
        }).join('\n')
        const exist = areas.length ? areas.map((a) => `- ${a.label}（${a.query}）`).join('\n') : '（尚無）'
        return `你是${kb}的抓取領域規劃員。下列「候選題目」來自近期知識筆記之主概念或文章帶出之線索；「既有領域」是目前用來抓取學術文獻之領域清單（標籤與英文查詢）。
${scope}請逐一判斷每個候選：
1. covered：既有領域是否已涵蓋此候選之抓取範圍——判的是**語意涵蓋**（同義、上下位、查詢結果會大幅重疊），不是字面相同；候選是某既有領域之下位概念者即屬涵蓋。
2. 過於寬泛（如只是學科總稱）或過於狹窄（單一論文專屬之模型名、產品名）者，covered 也給 true，並於 why 說明。不得自行把候選改寫成較窄、較寬或另一個題目來新增——新領域只能是候選本身；更具體的方向會由後續之筆記與線索另成候選。
3. covered 為 false 者，給出新領域：label（${L}領域名，${AREA_CONTRACT.labelMin}～${AREA_CONTRACT.labelMax} 字）、query（OpenAlex 學術搜尋用之英文關鍵字 ${AREA_CONTRACT.queryMinWords}～${AREA_CONTRACT.queryMaxWords} 個詞，不用引號、括號與 AND／OR）、why（一句話理由：此領域值得持續抓取之處）。
4. 每一項都要給 why（covered 為 true 者寫明被哪個既有領域涵蓋、或為何過寬／過窄／範圍外）。

只回覆 JSON 陣列，不要其他文字，格式：
[{"index":1,"covered":false,"label":"…","query":"…","why":"…"}]

候選題目：
${cands}

既有領域：
${exist}`
    }

    /**
     * 驗證單一項目
     *
     * @param {Object} it 輸入 AI 回傳項目
     * @param {Integer} count 輸入候選數
     * @returns {Boolean} 回傳是否合格
     */
    function isValidItem(it, count) {
        if (!it || typeof it !== 'object') return false
        if (!Number.isInteger(it.index) || it.index < 1 || it.index > count) return false
        if (typeof it.covered !== 'boolean') return false
        if (!String(it.why ?? '').trim()) return false // 覆蓋判斷之理由必填(CS8)
        if (it.covered) return true
        const label = String(it.label || '').trim()
        return [...label].length >= AREA_CONTRACT.labelMin && [...label].length <= AREA_CONTRACT.labelMax && sanitizeAreaQuery(it.query) !== ''
    }

    return { vocab, buildPrompt, isValidItem, sanitizeQuery: sanitizeAreaQuery, contract: AREA_CONTRACT }
}

export default createAreaDomain
