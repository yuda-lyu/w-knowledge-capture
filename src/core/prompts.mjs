// prompts.mjs — 提示詞覆寫之驗證與套用(各工作之 domain 工廠、執行期件與總組裝之 cfg 層同一份;本套件與下游套件共用)
//
// 【SIGS 之形狀】每鍵 { params:覆寫函數之參數之說明, returns?:回傳之說明(未給為「提示詞字串」) }——唯一來源為各 domain 檔(該 domain 之可覆寫
//   提示詞與其函數形式);三層(cfg.prompts、執行期件之 opt.prompts、domain 工廠之 opt.prompts)同讀一份,錯誤訊息同形「須為函數 (參數) => 回傳」。
// 【覆寫之套用一份】覆寫函數之末參數 ctx(promptCtxOf:{ kbLabel, domain, vocab, defaultPrompt })與「有覆寫交覆寫、否則內建」之分派
//   (overridablePrompt:覆寫者收經正規化之原參數＋ctx、回傳經檢查)只在本檔——各 domain 檔以之組可覆寫之成員,不各寫一份。
// 【提示詞之鍵 → domain】執行期件以 promptDomainOf 由各 domain 之 SIGS 推導歸屬表、以 promptsForDomain 取某 domain 之覆寫子集交其工廠。
// 【為何獨立成檔】domain 檔亦取用之:不為一個驗證函數載入總組裝共用件(其載入 LMDB 等執行期依賴)。總組裝共用件之 resolvePromptsCfg 讀本檔。

import isobj from 'wsemi/src/isobj.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import { given, checkKeys } from './util/values.mjs'

/** 提示詞覆寫之回傳之預設說明(SIGS 之 returns 未給時) */
const PROMPT_RETURNS_DEFAULT = '提示詞字串'

/**
 * 提示詞覆寫之一鍵之函數形式之說明(錯誤訊息用;各層同一字樣)
 *
 * @param {Object} sig 輸入 SIGS 之一鍵 { params, returns? }
 * @returns {String} 回傳「(參數) => 回傳」
 * @example
 * console.log(promptSigText({ params: '(docs, ctx)' }))
 * // => (docs, ctx) => 提示詞字串
 *
 * console.log(promptSigText({ params: '(ctx)', returns: '規則物件或 null' }))
 * // => (ctx) => 規則物件或 null
 */
export function promptSigText(sig) {
    return `${isestr(sig?.params) ? sig.params : '(…)'} => ${isestr(sig?.returns) ? sig.returns : PROMPT_RETURNS_DEFAULT}`
}

/**
 * SIGS 之形狀之問題(合格回 ''):非空物件,每鍵為 { params:非空字串, returns?:非空字串 }
 *
 * @param {*} sigs 輸入 SIGS
 * @returns {String} 回傳問題說明
 * @example
 * console.log(promptSigsProblem({ a: { params: '(x, ctx)' } }) === '', promptSigsProblem({ a: '(x, ctx)' }))
 * // => true 之鍵 a 須為 { params:非空字串, returns?:非空字串 }
 */
export function promptSigsProblem(sigs) {
    if (!isobj(sigs) || Object.keys(sigs).length === 0) return '須為非空物件 { 鍵: { params, returns? } }'
    const bad = Object.entries(sigs).filter(([, s]) => !isobj(s) || !isestr(s.params) || (s.returns !== undefined && !isestr(s.returns))).map(([k]) => k)
    return bad.length ? `之鍵 ${bad.join('、')} 須為 { params:非空字串, returns?:非空字串 }` : ''
}

/**
 * 提示詞覆寫之驗證(domain 工廠與執行期件之 opt.prompts):未給(undefined／null)＝全用內建;給了須為物件、只含 sigs 所列之鍵,
 *   值為函數(undefined／null＝該項用內建)
 *
 * @param {*} prompts 輸入 opt.prompts
 * @param {Object} sigs 輸入 SIGS { 鍵: { params, returns? } }(該 domain 檔之唯一來源)
 * @param {String} owner 輸入函數名(錯誤訊息用,如 'createTriageDomain')
 * @returns {Object} 回傳 { <鍵>: Function|null }(鍵為 sigs 之全部鍵;null＝用內建)
 * @throws {Error} sigs 不合形狀、prompts 給了而非物件、含不認得之鍵(附可用鍵)、或值非函數時拋出
 * @example
 * console.log(promptOverridesOf(null, { triage: { params: '(docs, ctx)' } }, 'createTriageDomain'))
 * // => { triage: null }
 */
export function promptOverridesOf(prompts, sigs, owner) {
    const sp = promptSigsProblem(sigs)
    if (sp) throw new Error(`promptOverridesOf 需要 sigs（{ 鍵: { params, returns? } }）：sigs ${sp}`)
    const keys = Object.keys(sigs)
    const out = Object.fromEntries(keys.map((k) => [k, null]))
    if (!given(prompts)) return out
    if (!isobj(prompts)) throw new Error(`${owner} 之 opt.prompts 須為物件 { ${keys.join(', ')} }（各為覆寫提示詞之函數）`)
    checkKeys(prompts, keys, `${owner} 之 opt.prompts`)
    for (const k of keys) {
        const f = prompts[k]
        if (!given(f)) continue
        if (!isfun(f)) throw new Error(`${owner} 之 opt.prompts.${k} 須為函數 ${promptSigText(sigs[k])}`)
        out[k] = f
    }
    return out
}

/**
 * 覆寫之提示詞函數之回傳檢查(呼叫期):須為非空字串
 *
 * @param {*} text 輸入覆寫函數之回傳值
 * @param {String} key 輸入提示詞之鍵(錯誤訊息用)
 * @returns {String} 回傳同一字串
 * @throws {Error} 非字串或只有空白時拋出
 * @example
 * console.log(promptTextOf('提示詞', 'triage'))
 * // => 提示詞
 */
export function promptTextOf(text, key) {
    if (typeof text !== 'string' || !text.trim()) throw new Error(`opt.prompts.${key} 須回傳非空字串`)
    return text
}

/**
 * 覆寫函數之末參數 ctx(檔頭【覆寫之套用一份】):知識庫稱呼、主題範圍、詞彙表與該成員之內建函數
 *
 * @param {Object} vocab 輸入詞彙表(該 domain 解析後之產物)
 * @param {String} kbLabel 輸入知識庫稱呼(kbLabelOf 之產物)
 * @param {Function} defaultPrompt 輸入該成員之內建函數
 * @returns {Object} 回傳 { kbLabel, domain, vocab, defaultPrompt }
 * @example
 * let ctx = promptCtxOf({ domain: '天文學', relationTypes: [] }, '「天文學」知識庫', () => 'p')
 * console.log(ctx.kbLabel, ctx.domain, typeof ctx.defaultPrompt)
 * // => 「天文學」知識庫 天文學 function
 */
export function promptCtxOf(vocab, kbLabel, defaultPrompt) {
    return { kbLabel, domain: vocab?.domain, vocab, defaultPrompt }
}

/**
 * 可覆寫之 domain 成員(檔頭【覆寫之套用一份】):未覆寫即內建函數本身;覆寫者收原參數(經與內建同一之正規化 norm)＋末參數 ctx(o.ctxOf(builtin)),
 *   回傳經 o.check(值, 鍵) 檢查(未給為 promptTextOf:須為非空字串)
 *
 * @param {Object} custom 輸入 promptOverridesOf 之產物 { 鍵: Function|null }
 * @param {String} key 輸入該成員之鍵(opt.prompts 之鍵)
 * @param {Function} builtin 輸入內建函數
 * @param {Object} [o={}] 輸入 { check?:(值, 鍵) => 值, norm?:(...原參數) => 參數陣列, ctxOf?:(builtin) => ctx }
 * @returns {Function} 回傳與內建同參數之函數
 * @throws {Error} builtin 非函數時拋出
 * @example
 * let f = overridablePrompt({ a: (x, ctx) => `${ctx.defaultPrompt(x)}!` }, 'a', (x) => `p:${x}`, { ctxOf: (b) => ({ defaultPrompt: b }) })
 * console.log(f('v'), overridablePrompt({ a: null }, 'a', (x) => `p:${x}`)('v'))
 * // => p:v! p:v
 */
export function overridablePrompt(custom, key, builtin, o = {}) {
    if (!isfun(builtin)) throw new Error(`overridablePrompt 需要內建函數（${key}）`)
    const f = isobj(custom) ? custom[key] : null
    if (!isfun(f)) return builtin
    const check = isfun(o?.check) ? o.check : promptTextOf
    const norm = isfun(o?.norm) ? o.norm : (...a) => a
    const ctxOf = isfun(o?.ctxOf) ? o.ctxOf : () => undefined
    return (...args) => check(f(...norm(...args), ctxOf(builtin)), key)
}

/**
 * 提示詞之鍵 → 所屬 domain(檔頭【提示詞之鍵 → domain】;由各 domain 之 SIGS 推導,執行期件交 promptDomainConflicts 與 promptsForDomain)
 *
 * @param {Object} sigsByDomain 輸入 { domain 之鍵: 該 domain 之 SIGS }
 * @returns {Object} 回傳凍結之 { 提示詞之鍵: domain 之鍵 }
 * @throws {Error} 非物件、或同一提示詞之鍵屬兩個 domain 時拋出
 * @example
 * console.log(promptDomainOf({ triage: { triage: { params: '(docs, ctx)' } }, summarize: { summarize: { params: '(docs, ctx)' }, faith: { params: '(input, ctx)' } } }))
 * // => { triage: 'triage', summarize: 'summarize', faith: 'summarize' }
 */
export function promptDomainOf(sigsByDomain) {
    if (!isobj(sigsByDomain)) throw new Error('promptDomainOf 需要 { domain 之鍵: SIGS }')
    const out = {}
    for (const [d, sigs] of Object.entries(sigsByDomain)) {
        for (const k of Object.keys(isobj(sigs) ? sigs : {})) {
            if (Object.hasOwn(out, k)) throw new Error(`promptDomainOf：提示詞之鍵 ${k} 同時屬 ${out[k]} 與 ${d}`)
            out[k] = d
        }
    }
    return Object.freeze(out)
}

/**
 * 某 domain 之提示詞覆寫子集(只含給了者;交該 domain 之工廠之 opt.prompts)
 *
 * @param {Object} prompts 輸入 promptOverridesOf 之產物 { 鍵: Function|null }(非物件視為無覆寫)
 * @param {Object} ownerOf 輸入 promptDomainOf 之產物
 * @param {String} owner 輸入 domain 之鍵
 * @returns {Object} 回傳 { 鍵: Function }
 * @example
 * let f = () => 'p'
 * console.log(Object.keys(promptsForDomain({ triage: f, summarize: null, faith: f }, { triage: 'triage', summarize: 'summarize', faith: 'summarize' }, 'summarize')))
 * // => [ 'faith' ]
 */
export function promptsForDomain(prompts, ownerOf, owner) {
    if (!isobj(prompts)) return {}
    return Object.fromEntries(Object.entries(prompts).filter(([p, f]) => isobj(ownerOf) && ownerOf[p] === owner && given(f)))
}

export default { promptSigText, promptSigsProblem, promptOverridesOf, promptTextOf, promptCtxOf, overridablePrompt, promptDomainOf, promptsForDomain }
