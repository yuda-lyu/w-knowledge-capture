// locale.mjs — 語言設定之單一實作(cfg.lang):輸出語言之稱呼、字形政策、分群折疊方向、slug 字元政策——四工作之總組裝、執行期件、domain 工廠與標準同讀此處
//
// 【為何需要】提示詞之輸出語言句、正體標準(CS12／SS3／RS3／ES3)、入庫前之字形修正(toTw)、概念鍵之繁簡折疊、slug 之字元類別都綁定繁體中文;
//   泛用套件須由安裝參數決定——語言設定一處解析,各處只讀其產物,不各自判斷語言。
// 【字形政策(script)】只有繁體中文(臺灣正體:zh-TW、zh-Hant、zh-Hant-TW)有可判定之字形標準(core/standards/textForms);其餘語言為恆等政策
//   SCRIPT_NONE(不改字、不報問題)。各標準以 appliesTo:['zh-Hant-TW'] 宣告適用之字形政策,符合度掃描於不適用時逐件列「不適用」(非 0、非合格)。
// 【預設逐字不變】未給 cfg.lang 即 zh-TW:稱呼「繁體中文」、字形政策 zh-Hant-TW、中文折疊、slug 收漢字與拉丁——與語言設定出現前之行為位元組相同。
// 【純函數之取法】純函數(納入閘、標準、存量處置)收 opt.locale(resolveLocale 之產物或字形政策物件;未給＝預設正體),經 scriptOf 取字形政策;
//   執行期件把 resolveLocale(cfg.lang) 放入每輪依賴 deps.locale,子階段再交給純函數。

import isobj from 'wsemi/src/isobj.mjs'
import isarr from 'wsemi/src/isarr.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import { scriptProblems, toTw, toTwKeepLinks } from './standards/textForms.mjs'

/** 預設語言(未給 cfg.lang 時;繁體中文) */
export const DEFAULT_LANG = 'zh-TW'

/** 正體標準於語言設定非繁體中文時之判定說明(四工作同一字樣) */
export const SCRIPT_NA_DETAIL = '語言設定非繁體中文，正體標準不適用'

/**
 * 字形政策:臺灣正體(core/standards/textForms 之判定與修正;正體標準 appliesTo 所指之 id)
 *
 * @type {Object}
 */
export const SCRIPT_ZH_HANT_TW = Object.freeze({
    id: 'zh-Hant-TW',
    problems: (text) => scriptProblems(text),
    fix: (text) => toTw(text),
    fixKeepLinks: (text) => toTwKeepLinks(text),
})

/**
 * 字形政策:恆等(非繁體中文之語言——不改字、不報問題;正體標準列不適用)
 *
 * @type {Object}
 */
export const SCRIPT_NONE = Object.freeze({
    id: 'none',
    problems: () => ({ count: 0, only: [], practical: [], phrases: [] }),
    fix: (text) => String(text ?? ''),
    fixKeepLinks: (text) => String(text ?? ''),
})

/** 語言代碼(小寫)→ 提示詞所用之稱呼(以繁體中文書寫——內建提示詞為繁體中文,只換輸出語言句);表外者取 Intl 之顯示名 */
const LABELS = Object.freeze({
    zh: '中文', en: '英文', ja: '日文', ko: '韓文', de: '德文', fr: '法文', es: '西班牙文', pt: '葡萄牙文', it: '義大利文', ru: '俄文',
    ar: '阿拉伯文', vi: '越南文', th: '泰文', id: '印尼文', ms: '馬來文', nl: '荷蘭文', tr: '土耳其文', pl: '波蘭文', hi: '印地文',
})

/** 走臺灣正體字形政策之語言代碼(小寫) */
const TW_SCRIPT_CODES = new Set(['zh-tw', 'zh-hant', 'zh-hant-tw'])

/**
 * 中文之稱呼:依文字或地區子標籤分繁簡(無子標籤為「中文」)
 *
 * @param {String} low 輸入小寫之語言代碼
 * @returns {String} 回傳稱呼
 */
function zhLabelOf(low) {
    if (/-(hant|tw|hk|mo)(-|$)/.test(low)) return '繁體中文'
    if (/-(hans|cn|sg|my)(-|$)/.test(low)) return '簡體中文'
    return LABELS.zh
}

/**
 * 語言設定之形狀問題(已解析之語言設定物件;注入 domain 所帶之 locale 亦以此驗)
 *
 * @param {*} x 輸入待驗之值
 * @returns {String} 回傳問題說明(合格回 '')
 * @example
 * console.log(localeProblem(resolveLocale('en')), localeProblem({ code: 'en' }))
 * // =>  缺 label、han、script、slug
 */
export function localeProblem(x) {
    if (!isobj(x)) return '須為 resolveLocale 之產物'
    const missing = ['code', 'label', 'han', 'script', 'slug'].filter((k) => x[k] === undefined)
    if (missing.length) return `缺 ${missing.join('、')}`
    if (!isestr(x.code) || !isestr(x.label)) return 'code、label 須為非空字串'
    if (typeof x.han !== 'boolean') return 'han 須為布林值'
    if (scriptProblem(x.script)) return `script ${scriptProblem(x.script)}`
    if (x.slug !== 'han-latin' && x.slug !== 'unicode') return 'slug 須為 han-latin 或 unicode'
    return ''
}

/**
 * 字形政策之形狀問題
 *
 * @param {*} s 輸入待驗之值
 * @returns {String} 回傳問題說明(合格回 '')
 */
function scriptProblem(s) {
    if (!isobj(s) || !isestr(s.id)) return '須為 { id, problems, fix, fixKeepLinks }'
    const bad = ['problems', 'fix', 'fixKeepLinks'].filter((k) => !isfun(s[k]))
    return bad.length ? `缺函數 ${bad.join('、')}` : ''
}

/**
 * 解析語言設定(cfg.lang):語言代碼 → { code(正規化之 BCP 47 代碼), label(提示詞之輸出語言稱呼), han(主語言是否為中文:概念鍵之繁簡折疊、
 *   概念標籤跨文字系統註記之保留方向依之), script(字形政策:zh-TW／zh-Hant／zh-Hant-TW 為 SCRIPT_ZH_HANT_TW,其餘 SCRIPT_NONE),
 *   slug('han-latin':只收漢字與拉丁;'unicode':任何文字之字母與數字——中文以外之語言) };未給即預設 zh-TW;已解析之產物原樣回傳
 *
 * @param {*} lang 輸入語言代碼字串、resolveLocale 之產物,或未給
 * @param {String} [name='cfg.lang'] 輸入設定鍵之名稱(錯誤訊息用)
 * @returns {Object} 回傳語言設定物件(凍結)
 * @throws {Error} 非字串非物件、空字串、不合 BCP 47 之代碼,或物件不合形狀時拋出
 * @example
 * const L = resolveLocale()
 * console.log(L.code, L.label, L.han, L.script.id, L.slug)
 * // => zh-TW 繁體中文 true zh-Hant-TW han-latin
 *
 * const E = resolveLocale('en')
 * console.log(E.code, E.label, E.han, E.script.id, E.slug)
 * // => en 英文 false none unicode
 */
export function resolveLocale(lang, name = 'cfg.lang') {
    if (lang === undefined || lang === null) lang = DEFAULT_LANG
    if (isobj(lang)) {
        const p = localeProblem(lang)
        if (p) throw new Error(`${name} 須為語言代碼字串或 resolveLocale 之產物（${p}）`)
        return lang
    }
    if (!isestr(lang)) throw new Error(`${name} 須為語言代碼字串（BCP 47，如 'zh-TW'、'en'）`)
    let code
    try {
        code = Intl.getCanonicalLocales(lang.trim())[0]
    }
    catch {
        throw new Error(`${name} 不是合法之語言代碼：${lang}`)
    }
    const low = code.toLowerCase()
    const primary = low.split('-')[0]
    const han = primary === 'zh'
    let label = han ? zhLabelOf(low) : LABELS[primary]
    if (!label) {
        try {
            label = new Intl.DisplayNames(['zh-TW'], { type: 'language', fallback: 'code' }).of(code)
        }
        catch {
            label = code
        }
    }
    return Object.freeze({
        code,
        label: String(label || code),
        han,
        script: TW_SCRIPT_CODES.has(low) ? SCRIPT_ZH_HANT_TW : SCRIPT_NONE,
        slug: han ? 'han-latin' : 'unicode',
    })
}

/**
 * 純函數之字形政策取法:未給 → 預設正體(行為與語言設定出現前相同);語言代碼或 resolveLocale 之產物 → 其 script;字形政策物件 → 原樣
 *
 * @param {*} x 輸入 opt.locale(未給、語言代碼、語言設定物件或字形政策物件)
 * @param {String} [name='locale'] 輸入選項之名稱(錯誤訊息用)
 * @returns {Object} 回傳字形政策 { id, problems, fix, fixKeepLinks }
 * @throws {Error} 給了而非上述任一者時拋出
 * @example
 * console.log(scriptOf().id, scriptOf('en').id, scriptOf(resolveLocale('zh-TW')).id, scriptOf(SCRIPT_NONE).id)
 * // => zh-Hant-TW none zh-Hant-TW none
 */
export function scriptOf(x, name = 'locale') {
    if (x === undefined || x === null) return SCRIPT_ZH_HANT_TW
    if (isestr(x)) return resolveLocale(x, name).script
    if (isobj(x) && isobj(x.script)) return scriptOf(x.script, name)
    const p = scriptProblem(x)
    if (p) throw new Error(`${name} 須為語言代碼、resolveLocale 之產物或字形政策物件（${p}）`)
    return x
}

/**
 * 標準是否適用於字形政策(標準列之 appliesTo:未宣告＝一律適用;宣告者須含該字形政策之 id)
 *
 * @param {Object} std 輸入標準列 { id, appliesTo? }
 * @param {Object} script 輸入字形政策
 * @returns {Boolean} 回傳是否適用
 * @example
 * console.log(scriptApplies({ id: 'X', appliesTo: ['zh-Hant-TW'] }, SCRIPT_ZH_HANT_TW), scriptApplies({ id: 'X', appliesTo: ['zh-Hant-TW'] }, SCRIPT_NONE), scriptApplies({ id: 'Y' }, SCRIPT_NONE))
 * // => true false true
 */
export function scriptApplies(std, script) {
    return !isarr(std?.appliesTo) || std.appliesTo.includes(script?.id)
}

export default { DEFAULT_LANG, SCRIPT_NA_DETAIL, SCRIPT_ZH_HANT_TW, SCRIPT_NONE, localeProblem, resolveLocale, scriptOf, scriptApplies }
