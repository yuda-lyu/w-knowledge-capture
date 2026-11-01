// vocabKit.mjs — 詞彙表解析之共用件(唯一一份):抓取與下游各工作及編排層之詞彙表解析、子集擷取、guide 之合併與改名鏈之檢核
//   同一套機制(本套件與下游套件共用)
//
// 【頭之政策】vocabHeadOf:非物件＝全用預設;不認得之鍵拋錯(checkKeys 之格式;值為 undefined 之鍵亦檢——打錯之鍵名不因當下無值而放過,
//   正名鍵會維持預設而無人察覺);認得之鍵之值為 undefined 者視為未給(剔除——與子集擷取同一判準,各工作不再分歧);null 依各工作之逐鍵宣告
//   (nullAs:'unset'＝視為未給、'empty'＝空對照或空清單〔依預設值之型別〕);未宣告之鍵之 null 照收,交該鍵之形狀檢核判(必填之清單即拋、
//   有意義之 null——如下游之推定詞「不推定」——照用)。
// 【子集】pickVocabKeys:他工作與本工作共用一份詞彙表時,取本工作所讀之鍵(值為 undefined 者不列;guide 只留本工作之段)——鍵集由各工作宣告。
// 【guide】mergeGuideFields:欄位表 { 段: { 欄: 型別名 } }、預設值與安裝方之 guide;逐欄回退預設(undefined／null 皆沿用預設;段與欄位之名同頭之
//   政策——值為 undefined 者亦檢;空字串照填與否依型別);型別處理內建 string(字串,空字串照填)、estr(非空字串——插入句中之詞,空字串會使提示詞成為殘句)、array(非空字串陣列),
//   其餘由呼叫端注入(如摘要之證據等級對照 levelMap)。不認得之段與欄位一律 checkKeys 之格式。
// 【改名鏈】renameChainProblems:分類法／型別改名之宣告 { 舊名: 新名 } 之形狀與目標——舊名須已自現行清單移除、新名循對照須到達現行清單、
//   不得成環(連續改名 A→B→C 以對照鏈宣告)。下游各工作之改名宣告同用,問題一次列全。

import isobj from 'wsemi/src/isobj.mjs'
import isarr from 'wsemi/src/isarr.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import { given, checkKeys } from '../util/values.mjs'

/**
 * 詞彙表之頭:非物件視為 {};不認得之鍵拋錯(值為 undefined 之鍵亦檢);認得之鍵之值為 undefined 者剔除(視為未給);null 依 o.nullAs 之逐鍵宣告
 *   ('unset' 剔除、'empty' 換成空對照或空清單——依 o.defaults 該鍵之型別,陣列者 [],其餘 {})
 *
 * @param {*} override 輸入安裝方之詞彙覆寫
 * @param {Array} keys 輸入可用鍵
 * @param {Object} [o={}] 輸入 { nullAs?:{ 鍵: 'unset'|'empty' }, defaults?:Object(預設詞彙表;'empty' 依其型別), name?:String(訊息之稱呼,預設 'vocab') }
 * @returns {Object} 回傳新物件(只含給了之鍵;null 已依宣告處置)
 * @throws {Error} 含不認得之鍵時拋出(「vocab 含不認得之鍵：k（可用：…）」)
 * @example
 * console.log(vocabHeadOf({ domain: '天文學', kbLabel: undefined, renames: null }, ['domain', 'kbLabel', 'renames'], { nullAs: { renames: 'empty' } }))
 * // => { domain: '天文學', renames: {} }
 */
export function vocabHeadOf(override, keys, o = {}) {
    const src = isobj(override) ? override : {}
    checkKeys(src, isarr(keys) ? keys : [], isestr(o?.name) ? o.name : 'vocab')
    const nullAs = isobj(o?.nullAs) ? o.nullAs : {}
    const defaults = isobj(o?.defaults) ? o.defaults : {}
    const out = {}
    for (const [k, v] of Object.entries(src)) {
        if (v === undefined) continue
        if (v === null && nullAs[k] === 'unset') continue
        out[k] = v === null && nullAs[k] === 'empty' ? (isarr(defaults[k]) ? [] : {}) : v
    }
    return out
}

/**
 * 自任意詞彙表取指定之鍵(值為 undefined 者不列);給了 o.guideSections 時 guide(為物件者)只留其段中已給者
 *
 * @param {*} vocab 輸入詞彙表(可含他工作之鍵)，非物件視為{}
 * @param {Array} keys 輸入所讀之鍵
 * @param {Object} [o={}] 輸入 { guideSections?:Array(本工作之 guide 段) }
 * @returns {Object} 回傳新物件
 * @example
 * console.log(pickVocabKeys({ domain: '天文學', categories: ['觀測'], guide: { relate: {}, summarize: { target: '知識' } } }, ['domain', 'guide'], { guideSections: ['summarize'] }))
 * // => { domain: '天文學', guide: { summarize: { target: '知識' } } }
 */
export function pickVocabKeys(vocab, keys, o = {}) {
    const v = isobj(vocab) ? vocab : {}
    const out = Object.fromEntries((isarr(keys) ? keys : []).filter((k) => v[k] !== undefined).map((k) => [k, v[k]]))
    if (isarr(o?.guideSections) && isobj(out.guide)) {
        out.guide = Object.fromEntries(o.guideSections.filter((s) => out.guide[s] !== undefined).map((s) => [s, out.guide[s]]))
    }
    return out
}

/** guide 欄位之內建型別處理(型別名 → (值, 設定路徑) => 合併後之值;不合即拋) */
const GUIDE_TYPES = Object.freeze({
    string: (v, name) => {
        if (typeof v !== 'string') throw new Error(`${name} 須為字串`)
        return v
    },
    estr: (v, name) => {
        if (!isestr(v) || !v.trim()) throw new Error(`${name} 須為非空字串`)
        return v
    },
    array: (v, name) => {
        if (!isarr(v) || v.length === 0 || !v.every(isestr)) throw new Error(`${name} 須為字串陣列(至少一項、每項非空字串)`)
        return [...v]
    },
})

/**
 * guide 之驗證與合併(逐欄回退預設):安裝方給的欄位依型別驗後覆寫預設,未給(undefined 或 null)者沿用預設;段給 null 視為未給
 *
 * @param {Object} fields 輸入欄位表 { 段: { 欄: 型別名 } }(型別名:string／estr／array 或 o.types 之鍵)
 * @param {Object} defaults 輸入預設 guide { 段: { 欄: 值 } }
 * @param {*} user 輸入安裝方之 guide，未給(undefined 或 null)代表全用預設
 * @param {Object} [o={}] 輸入 { types?:{ 型別名: (值, 設定路徑, 預設值) => 值 }(呼叫端之型別處理,如摘要之 levelMap), name?:String(預設 'vocab.guide') }
 * @returns {Object} 回傳合併後之完整 guide(欄位表之全部段與欄)
 * @throws {Error} guide 非物件、含不認得之段或欄位(checkKeys 之格式)、段非物件、欄位不合其型別、或欄位表引用未知之型別時拋出
 * @example
 * const F = { relate: { vagueReason: 'string', implementationCase: 'estr' } }
 * const D = { relate: { vagueReason: '都與某主題有關', implementationCase: '實作' } }
 * console.log(mergeGuideFields(F, D, { relate: { vagueReason: '' } }).relate)
 * // => { vagueReason: '', implementationCase: '實作' }
 */
export function mergeGuideFields(fields, defaults, user, o = {}) {
    const name = isestr(o?.name) ? o.name : 'vocab.guide'
    const table = isobj(fields) ? fields : {}
    const secs = Object.keys(table)
    if (given(user) && !isobj(user)) throw new Error(`${name} 須為物件 { ${secs.join(', ')} }`)
    // 段與欄位之名同頭之政策:值為 undefined 者亦檢(打錯之名不因當下無值而放過);其值為 undefined／null 者沿用預設
    const u = isobj(user) ? user : {}
    checkKeys(u, secs, name)
    for (const sec of secs) {
        if (given(u[sec]) && !isobj(u[sec])) throw new Error(`${name}.${sec} 須為物件`)
    }
    const types = { ...GUIDE_TYPES, ...(isobj(o?.types) ? o.types : {}) }
    const out = {}
    for (const [sec, fs] of Object.entries(table)) {
        const us = isobj(u[sec]) ? u[sec] : {}
        checkKeys(us, Object.keys(fs), `${name}.${sec}`)
        out[sec] = {}
        for (const [k, type] of Object.entries(fs)) {
            const d = defaults?.[sec]?.[k]
            if (!given(us[k])) {
                out[sec][k] = d
                continue
            }
            const fn = types[type]
            if (!isfun(fn)) throw new Error(`mergeGuideFields 之欄位表引用未知之型別「${type}」（${name}.${sec}.${k}）`)
            out[sec][k] = fn(us[k], `${name}.${sec}.${k}`, d)
        }
    }
    return out
}

/**
 * 改名之宣告 { 舊名: 新名 } 之問題(一次列全):非物件、鍵或值非非空字串、舊名仍在現行清單、新名循對照不可達現行清單(或成環)
 *
 * @param {*} map 輸入改名對照(null 之處置屬呼叫端之宣告;此處只判已處置之值)
 * @param {Array} list 輸入現行清單
 * @param {String} name 輸入設定路徑(如 'vocab.categoryRenames')
 * @returns {Array} 回傳問題說明陣列(無問題為空陣列)
 * @example
 * console.log(renameChainProblems({ 甲: '乙', 乙: '丙' }, ['丙', '丁'], 'vocab.categoryRenames'))
 * // => []
 *
 * console.log(renameChainProblems({ 丙: '戊' }, ['丙', '丁'], 'vocab.categoryRenames'))
 * // => [ 'vocab.categoryRenames 之「丙」仍在現行清單（改名之舊名須已自清單移除）', 'vocab.categoryRenames.丙 之新名「戊」不在現行清單（丙、丁）' ]
 */
export function renameChainProblems(map, list, name) {
    if (!isobj(map)) return [`${name} 須為物件 { 舊名: 新名 }`]
    const cur = isarr(list) ? list : []
    const out = []
    for (const [from, to] of Object.entries(map)) {
        if (!isestr(from) || !isestr(to)) {
            out.push(`${name} 之鍵與值須為非空字串`)
            continue
        }
        if (cur.includes(from)) out.push(`${name} 之「${from}」仍在現行清單（改名之舊名須已自清單移除）`)
        // 連續改名(A→B 後 B→C)允許以對照鏈宣告:終點須在現行清單、不得成環
        let end = to
        const seen = new Set([from])
        while (!cur.includes(end) && Object.hasOwn(map, end) && !seen.has(end)) {
            seen.add(end)
            end = map[end]
        }
        if (!cur.includes(end)) out.push(`${name}.${from} 之新名「${to}」不在現行清單（${cur.join('、')}）${seen.has(end) ? '，且對照成環' : ''}`)
    }
    return [...new Set(out)]
}

export default { vocabHeadOf, pickVocabKeys, mergeGuideFields, renameChainProblems }
