// injectables.mjs — 可注入件之契約與跨行程規格(健全閘偵測器、站台 adapter):主行程驗契約、化為 specs;子行程依 specs 重建
//
// 【為何在 core】設定 schema(core/settingsDefault)須驗偵測器陣列之形狀,閘之實作(stores/contentGate)與瀏覽器子行程(fetchers/fetch_web_cli)
//   須依同一契約重建——三處同用此一份,不各寫各的。
// 【偵測器契約】{ id:非空字串(陣列內唯一), kind:GATE_KINDS 之一(分流依 kind,見 stores/fetchPolicy;自訂偵測器只能沿用既有類別——
//   新類別須先有分流與終態判準), adapter?:Boolean(預設 false:站台 adapter 之正文不套;true 亦套), test(c, env) → null|{ hit:String },
//   module?:字串(子行程載入之模組規格:file:// URL、絕對路徑或套件名;自訂者必填,通常寫 import.meta.url), export?:字串(模組之具名匯出,預設 default;
//   該匯出為偵測器物件或偵測器陣列——陣列者以 id 取), sig?:字串(判準簽章:樣式或門檻改了即改閘版本 → 存量依新版重判;未給以 id 計) }。
//   內建偵測器帶 builtin:true(子行程自帶,不經 module 載入)。
// 【注入語意】settings.capture.standards.detectors 給了即整組取代(含順序);null＝內建。追加＝[...GATE_DETECTORS_DEFAULT, mine]、
//   換掉某一個＝以 id 篩掉再放自己的、外部獨立使用＝import 內建陣列自行組合。注入的是陣列,不是單一偵測器。
// 【為何自訂者須有 module】瀏覽器階梯於子行程執行,函數無法序列化;無 module 之自訂偵測器子行程載不到,curl 層與瀏覽器層之閘即不一致——
//   於啟動期拋錯(createCaptureRuntime),不讓它拖到跑輪次才發現。站台 adapter 同法:有 module 者子行程亦載入,無 module 者只作用於主行程之 curl 層
//   (既有用法,README 已知限制載明)。

import path from 'path'
import { pathToFileURL } from 'url'
import isarr from 'wsemi/src/isarr.mjs'
import isobj from 'wsemi/src/isobj.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import isfun from 'wsemi/src/isfun.mjs'

/** 健全閘之類別全集(分流 stores/fetchPolicy 認得之 reason;自訂偵測器之 kind 須在此列) */
export const GATE_KINDS = Object.freeze(['soft-404', 'mojibake', 'format-noise', 'not-found', 'too-short', 'placeholder', 'paywall'])

/**
 * 偵測器陣列之契約問題(無問題回 [])
 *
 * @param {*} list 輸入偵測器陣列
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Boolean} [opt.requireModule=false] 輸入是否要求自訂(非 builtin)偵測器帶 module(主行程組裝時 true;單元測試之閘可給函數偵測器)
 * @returns {Array} 回傳問題字串陣列
 * @example
 * console.log(gateDetectorProblems([{ id: 'a', kind: 'paywall', test: () => null }]))
 * // => []
 *
 * console.log(gateDetectorProblems([{ id: 'a', kind: 'wall', test: () => null }]).length > 0)
 * // => true
 */
export function gateDetectorProblems(list, opt = {}) {
    const o = isobj(opt) ? opt : {}
    if (!isarr(list)) return ['須為偵測器陣列（單一偵測器亦須包成陣列；null＝內建）']
    if (!list.length) return ['偵測器陣列不可為空（整組取代之語意；要用內建請給 null）']
    const problems = []
    const ids = new Set()
    list.forEach((d, i) => {
        const at = `第 ${i + 1} 項`
        if (!isobj(d)) {
            problems.push(`${at}非物件`)
            return
        }
        if (!isestr(d.id)) problems.push(`${at}缺 id`)
        else if (ids.has(d.id)) problems.push(`${at}id「${d.id}」重複`)
        else ids.add(d.id)
        if (!GATE_KINDS.includes(d.kind)) problems.push(`${at}（${d.id || '?'}）kind「${d.kind}」不在健全閘類別（${GATE_KINDS.join('、')}）`)
        if (!isfun(d.test)) problems.push(`${at}（${d.id || '?'}）缺 test 函數`)
        if (d.module !== undefined && !isestr(d.module)) problems.push(`${at}（${d.id || '?'}）module 須為非空字串`)
        if (d.export !== undefined && !isestr(d.export)) problems.push(`${at}（${d.id || '?'}）export 須為非空字串`)
        if (d.sig !== undefined && typeof d.sig !== 'string') problems.push(`${at}（${d.id || '?'}）sig 須為字串`)
        if (o.requireModule && d.builtin !== true && !isestr(d.module)) problems.push(`${at}（${d.id || '?'}）自訂偵測器須帶 module（子行程之瀏覽器階梯據以載入；通常寫 import.meta.url）`)
    })
    return problems
}

/**
 * 偵測器陣列之跨行程規格(內建者記 id、自訂者記 module／export;順序即陣列順序)
 *
 * @param {*} list 輸入偵測器陣列(null／undefined 回 null＝子行程用內建)
 * @returns {Array|null} 回傳 specs 陣列或 null
 * @example
 * console.log(gateDetectorSpecsOf(null))
 * // => null
 */
export function gateDetectorSpecsOf(list) {
    if (!isarr(list)) return null
    return list.map((d) => (d?.builtin === true ? { id: d.id, builtin: true } : { id: d.id, module: d.module, ...(isestr(d.export) ? { export: d.export } : {}) }))
}

/**
 * 站台 adapter 之跨行程規格:只取帶 module 者(無 module 者只作用於主行程之 curl 層)
 *
 * @param {*} list 輸入合併後之 adapter 陣列
 * @returns {Array} 回傳 specs 陣列 [{ id, module, export? }]
 * @example
 * console.log(adapterSpecsOf([{ id: 'x', match: /x/, parse: () => ({}) }]))
 * // => []
 */
export function adapterSpecsOf(list) {
    if (!isarr(list)) return []
    return list.filter((a) => isobj(a) && isestr(a.module)).map((a) => ({ id: a.id, module: a.module, ...(isestr(a.export) ? { export: a.export } : {}) }))
}

/**
 * 模組規格 → import 可用之 URL／指定詞:file:／http: 等 URL 原樣;絕對路徑轉 file URL;其餘視為套件指定詞
 *
 * @param {String} spec 輸入模組規格
 * @returns {String} 回傳 import 之引數
 * @example
 * console.log(specToUrl('file:///c:/x/y.mjs'))
 * // => file:///c:/x/y.mjs
 */
export function specToUrl(spec) {
    const s = String(spec || '')
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[a-z]:[\\/]/i.test(s)) return s
    if (path.isAbsolute(s)) return pathToFileURL(s).href
    return s
}

/**
 * 依規格自模組取一件(匯出為物件即該物件;為陣列即以 id 取)
 *
 * @param {Object} spec 輸入 { id, module, export? }
 * @param {String} what 輸入件名(錯誤訊息用)
 * @returns {Promise} 回傳 Promise，resolve 回傳該件
 * @throws {Error} 載入失敗、匯出不存在、陣列內無該 id、或件之 id 不符時拋出
 */
async function importOne(spec, what) {
    if (!isobj(spec) || !isestr(spec.id) || !isestr(spec.module)) throw new Error(`${what}規格不合：${JSON.stringify(spec)}`)
    let m
    try {
        m = await import(specToUrl(spec.module))
    }
    catch (e) {
        throw new Error(`${what}「${spec.id}」之模組載入失敗（${spec.module}）：${e?.message || e}`)
    }
    const name = isestr(spec.export) ? spec.export : 'default'
    const x = m?.[name]
    if (x === undefined) throw new Error(`${what}「${spec.id}」之模組（${spec.module}）無匯出「${name}」`)
    const item = isarr(x) ? x.find((d) => d?.id === spec.id) : x
    if (!isobj(item)) throw new Error(`${what}「${spec.id}」：模組（${spec.module}）之匯出「${name}」無此 id 之件`)
    if (item.id !== spec.id) throw new Error(`${what}「${spec.id}」：模組（${spec.module}）之匯出「${name}」之 id 為「${item.id}」`)
    return item
}

/**
 * 依規格重建偵測器陣列(子行程用):內建者自 builtins 以 id 取,自訂者 import
 *
 * @param {Array} specs 輸入 gateDetectorSpecsOf 之產物
 * @param {Array} builtins 輸入內建偵測器陣列(stores/contentGate 之 GATE_DETECTORS_DEFAULT)
 * @returns {Promise} 回傳 Promise，resolve 回傳偵測器陣列(順序同 specs)
 * @throws {Error} specs 非陣列、內建 id 不存在、模組載入失敗時拋出
 * @example
 * let builtins = [{ id: 'a', kind: 'paywall', test: () => null }]
 * let dets = await importGateDetectors([{ id: 'a', builtin: true }], builtins)
 * console.log(dets.map((d) => d.id))
 * // => [ 'a' ]
 */
export async function importGateDetectors(specs, builtins) {
    if (!isarr(specs)) throw new Error('importGateDetectors 需要 specs 陣列')
    const byId = new Map((isarr(builtins) ? builtins : []).map((d) => [d.id, d]))
    const out = []
    for (const s of specs) {
        if (s?.builtin === true) {
            if (!byId.has(s.id)) throw new Error(`內建偵測器「${s.id}」不存在（子行程之套件版本與主行程不同？）`)
            out.push(byId.get(s.id))
        }
        else out.push(await importOne(s, '健全閘偵測器'))
    }
    return out
}

/**
 * 依規格載入站台 adapter 陣列(子行程用)
 *
 * @param {Array} specs 輸入 adapterSpecsOf 之產物
 * @returns {Promise} 回傳 Promise，resolve 回傳 adapter 陣列(順序同 specs)
 * @throws {Error} specs 非陣列或模組載入失敗時拋出
 * @example
 * // module 可為 file:// URL、絕對路徑或套件名；此處以內嵌 data: 模組示意
 * let adapters = await importAdapters([{ id: 'demo', module: 'data:text/javascript,export default { id: "demo" }' }])
 * console.log(adapters)
 * // => [ { id: 'demo' } ]
 */
export async function importAdapters(specs) {
    if (!isarr(specs)) throw new Error('importAdapters 需要 specs 陣列')
    const out = []
    for (const s of specs) out.push(await importOne(s, '站台 adapter'))
    return out
}

export default { GATE_KINDS, gateDetectorProblems, gateDetectorSpecsOf, adapterSpecsOf, specToUrl, importGateDetectors, importAdapters }
