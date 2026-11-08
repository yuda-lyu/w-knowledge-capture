// promptFp.mjs — 提示詞指紋之輪次快取(產出鏈 produced.promptFp / steps[].promptFp 之取值)
//
// ════════════════ 為何有這個檔 ════════════════
// 產出鏈(core/ops/provenance)要記「這次產出用的是哪一版提示詞」。提示詞指紋以評比機制已有之算法為準:
//   對該角色之評比題組(角色內建題組),以現行設定(詞彙)組出各頁提示詞,取 benchPromptFpOf(bench/benchKit)——
//   即 planBench(role, { vocab }) 之 promptFp,評比報表「提示詞指紋」欄之同一個值。本檔不另發明算法。
// 規格:跨套件之產出鏈規格(提示詞指紋 §1、共用件 §5.5);落地條目見 sgud/rule/rulebook_core.md 之產出鏈條。
//
// ════════════════ 取用形狀 ════════════════
// 一個快取實例＝一輪:每輪(下游之 buildDeps 每輪呼叫一次處)建一個 createPromptFpCache(),
// 取其 promptFpOf(role, { vocab, roleOpt }),同一角色同一詞彙每輪只組一次提示詞、只算一次;下一輪新實例重算
// (現行設定若已變,指紋跟著變)。
// 【成本】planBench 不呼叫 AI:讀角色之內建題組檔、驗題組、逐頁組提示詞、取雜湊——實測內建與下游共 10 個角色
//   (15～16 案)各約 3～27 ms(再次 1～12 ms),每輪每角色一次,相對 AI 呼叫可忽略。
// 【無題組者回 null】角色未宣告內建題組(casesFile)者無從算起,回 null,呼叫端省略 promptFp 欄(makeProduced 視 null 為未給)。
// 【算不出者回 null】題組檔讀不到、題組不合格、提示詞組不出等:回 null 並經 onFail 告知一次,同輪不重試——指紋是附記,
//   不得因它算不出而拖垮寫入;但不靜默(呼叫端應把 onFail 接到日誌)。
// 【dist(UMD)下】內建題組檔(src/bench/cases/*.json)不在打包產物旁,角色之 casesFile 指向 dist 旁不存在之路徑:
//   經 UMD 取用時內建角色之指紋回 null(onFail 告知題組檔讀取失敗);要有指紋須由 src 取用(深層路徑),或角色之題組檔隨自身套件發布。
// 【同一份套件】角色須由同一份本套件之 defineBenchRole 產生:已定義之角色只被定義它的那份模組認得,
//   另一份副本(如巢狀 node_modules 內之舊版)會把它當未定義之定義物件重驗而拒收(promptFpOf 拋 invalid role)。
// 【快取鍵】角色物件(defineBenchRole 之產物須為常駐物件才命中;傳入尚未定義之角色定義物件時每次皆重算)＋詞彙與角色參數之穩定序列化
//   (鍵序無關;undefined 值視同無此鍵)。含函數、符號、BigInt、非有限數或非一般物件之值,無法序列化成鍵,該次不快取(每次重算,但仍正確)。

import isobj from 'wsemi/src/isobj.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import { planBench, defineBenchRole } from './benchKit.mjs'

/**
 * 穩定序列化(物件鍵排序;undefined 值視同無此鍵)
 *
 * @param {*} v 輸入值
 * @returns {String|null} 回傳序列化字串;含無法表達之值(函數、符號、BigInt、非有限數、非一般物件)回 null
 */
function stableKeyOf(v) {
    if (v === null) return 'null'
    switch (typeof v) {
    case 'string':
        return JSON.stringify(v)
    case 'boolean':
        return String(v)
    case 'number':
        return Number.isFinite(v) ? String(v) : null
    case 'object': {
        if (Array.isArray(v)) {
            const xs = v.map((x) => (x === undefined ? 'null' : stableKeyOf(x)))
            return xs.includes(null) ? null : `[${xs.join(',')}]`
        }
        const proto = Object.getPrototypeOf(v)
        if (proto !== Object.prototype && proto !== null) return null
        const parts = []
        for (const k of Object.keys(v).sort()) {
            if (v[k] === undefined) continue
            const s = stableKeyOf(v[k])
            if (s === null) return null
            parts.push(`${JSON.stringify(k)}:${s}`)
        }
        return `{${parts.join(',')}}`
    }
    default:
        return null
    }
}

/**
 * 建一個提示詞指紋之快取(一個實例＝一輪),回傳其 promptFpOf
 *
 * promptFpOf(role, opt):
 * - role:評比角色(defineBenchRole 之產物;定義物件亦可但每次重算)——必須參數,無效即拋
 * - opt.vocab:現行詞彙(物件;給了以角色之 domainOf(vocab) 建 domain 組提示詞,與正式管線同源);非物件視為未給
 * - opt.roleOpt:角色參數(物件;交角色之 promptOf 的 ctx.roleOpt);非物件視為未給
 * - 其餘鍵不轉傳(指紋只依「題組＋詞彙＋角色參數」)
 * - 回傳:16 碼十六進位字串;無內建題組者、算不出者回 null
 *
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Function} [opt.onFail] 輸入算不出時之回呼 (roleId, error) => void;每輪每角色(每組參數)至多一次,拋錯不外洩;無內建題組不算失敗,不呼叫
 * @returns {Object} 回傳 { promptFpOf(role, opt) => String|null }(函數不依賴 this,可解構取用)
 * @example
 * let role = defineBenchRole({
 *     id: 'topic',
 *     name: '題目分類(topic)',
 *     pageSize: 2,
 *     expectOf: (c) => c.expect.label,
 *     domainOf: (vocab) => ({ kb: vocab?.kbLabel || '知識庫' }),
 *     promptOf: (cases, d) => `${d.kb}：${cases.map((c, i) => `${i + 1}. ${c.input.text}`).join('；')}`,
 *     verdictOf: (data) => ({ cls: data?.label ?? null, valid: true, problem: '', fields: {} }),
 * })
 * let { promptFpOf } = createPromptFpCache()
 * console.log(promptFpOf(role)) //角色無內建題組(casesFile)
 * // => null
 *
 * let { promptFpOf: areaFpOf } = createPromptFpCache({ onFail: (id, e) => console.log(id, e.message) })
 * console.log(areaFpOf(areaBenchRole) === planBench(areaBenchRole).promptFp)
 * // => true
 */
export function createPromptFpCache(opt = {}) {

    //check
    if (!isobj(opt)) {
        opt = {}
    }
    const onFail = isfun(opt.onFail) ? opt.onFail : null

    /** 角色物件 → Map(參數鍵 → 指紋或 null) */
    const byRole = new WeakMap()

    const promptFpOf = (role, o) => {

        //check
        let r
        try {
            r = defineBenchRole(role)
        }
        catch {
            throw new Error('invalid role: must be a bench role (defineBenchRole product or definition)')
        }
        if (!isobj(o)) {
            o = {}
        }
        const vocab = isobj(o.vocab) ? o.vocab : undefined
        const roleOpt = isobj(o.roleOpt) ? o.roleOpt : undefined

        // 無內建題組:無從算起(常態,非失敗)
        if (!r.casesFile) return null

        const key = stableKeyOf({ vocab: vocab ?? null, roleOpt: roleOpt ?? null })
        let memo = byRole.get(r)
        if (key !== null && memo?.has(key)) return memo.get(key)

        let fp = null
        try {
            fp = planBench(r, { ...(vocab ? { vocab } : {}), ...(roleOpt ? { roleOpt } : {}) }).promptFp
        }
        catch (e) {
            fp = null
            if (onFail) {
                try {
                    onFail(r.id, e)
                }
                catch { /* 回呼自身之錯不外洩:指紋是附記 */ }
            }
        }
        if (key !== null) {
            if (!memo) {
                memo = new Map()
                byRole.set(r, memo)
            }
            memo.set(key, fp)
        }
        return fp
    }

    return { promptFpOf }
}
