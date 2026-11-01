// values.mjs — 值之共用小工具:有無給值(given)、任意值之字串(strOf)、文字值(textValueOf)、只收字串之文字值(strictTextOf)、文字值之清單(textListOf)、
//   去重(uniq)、JSON 深複本(jsonClone)、碼元序比較(cmp)、物件之鍵集檢核(unknownKeysProblem／checkKeys)、值之正規化比較(canonOf／sameValue)
//
// 【為何一份】同一判準各模組各寫一行時,語意即悄悄分歧(如「未給」是否含空字串、null 是否轉成 'null';「不認得之鍵」之訊息各寫各的格式);
//   core/ 之各模組(總組裝共用件、提示詞覆寫之驗證、詞彙表之解析、AI 調度層、表格輸出)與套件根之模組一律取本檔。本檔不依賴任何執行期件
//   (LMDB 等),domain 檔與詞彙檔可直接取用。

import isobj from 'wsemi/src/isobj.mjs'
import isarr from 'wsemi/src/isarr.mjs'

/**
 * 是否給了值(undefined／null 視為未給;0、false、空字串皆為給了)
 *
 * @param {*} v 輸入任意值
 * @returns {Boolean} 回傳是否給了值
 * @example
 * console.log(given(0), given(false), given(''), given(null), given(undefined))
 * // => true true true false false
 */
export function given(v) {
    return v !== undefined && v !== null
}

/**
 * 任意值之字串(null／undefined 為空字串;其餘以 String 轉)
 *
 * @param {*} v 輸入任意值
 * @returns {String} 回傳字串
 * @example
 * console.log(JSON.stringify([strOf(null), strOf(undefined), strOf(0), strOf('a')]))
 * // => ["","","0","a"]
 */
export function strOf(v) {
    return String(v ?? '')
}

/**
 * 文字值(字串去頭尾空白、數字轉字串,其餘——含 null、物件、陣列——為空字串):AI 回覆與資料欄位之「取其文字」(物件不得被轉成「[object Object]」)
 *
 * @param {*} v 輸入任意值
 * @returns {String} 回傳文字
 * @example
 * console.log(JSON.stringify([textValueOf('  甲 '), textValueOf(3), textValueOf(null), textValueOf({ a: 1 }), textValueOf(['x'])]))
 * // => ["甲","3","","",""]
 */
export function textValueOf(v) {
    if (typeof v === 'string') return v.trim()
    if (typeof v === 'number') return String(v)
    return ''
}

/**
 * 只收字串之文字值(字串去頭尾空白;其餘——含數字、null、物件、陣列——為空字串):資料欄位之「取其字串」(數字不視為文字,與 textValueOf 之差)
 *
 * @param {*} v 輸入任意值
 * @returns {String} 回傳文字
 * @example
 * console.log(JSON.stringify([strictTextOf('  甲 '), strictTextOf(3), strictTextOf(null), strictTextOf({ a: 1 })]))
 * // => ["甲","","",""]
 */
export function strictTextOf(v) {
    return typeof v === 'string' ? v.trim() : ''
}

/**
 * 文字值之清單(陣列逐項取 textValueOf、去空;非陣列者取其單值之 textValueOf,空即空陣列):AI 回覆與資料欄位之「取其文字清單」
 *   (模型常把單值寫成字串而非陣列)
 *
 * @param {*} v 輸入任意值
 * @returns {Array} 回傳文字陣列(不去重,保序)
 * @example
 * console.log(JSON.stringify([textListOf([' 甲 ', 3, null, '', { a: 1 }]), textListOf(' 乙 '), textListOf(null)]))
 * // => [["甲","3"],["乙"],[]]
 */
export function textListOf(v) {
    if (isarr(v)) return v.map((x) => textValueOf(x)).filter(Boolean)
    const t = textValueOf(v)
    return t ? [t] : []
}

/**
 * 去重(保留首次出現之序;以 Set 之同值判定)
 *
 * @param {Array} arr 輸入陣列(或任何可迭代者)
 * @returns {Array} 回傳去重後之新陣列
 * @example
 * console.log(uniq(['b', 'a', 'b', 1, 1]))
 * // => [ 'b', 'a', 1 ]
 */
export function uniq(arr) {
    return [...new Set(arr)]
}

/**
 * JSON 深複本(JSON.parse(JSON.stringify(v));JSON 可表示之值——狀態、操作、設定之複本;函數與 undefined 之鍵略過、Date 成字串)
 *
 * @param {*} v 輸入 JSON 可表示之值(undefined 會拋:JSON.stringify(undefined) 非 JSON 文字)
 * @returns {*} 回傳與輸入同內容而不共用參照之值
 * @example
 * let a = { x: [1, { y: 2 }] }
 * let b = jsonClone(a)
 * b.x[1].y = 3
 * console.log(a.x[1].y, b.x[1].y)
 * // => 2 3
 */
export function jsonClone(v) {
    return JSON.parse(JSON.stringify(v))
}

/**
 * 碼元序比較(排序用;不用 localeCompare:其結果隨地區與 ICU 版本而異,輸出須在各機器一致)
 *
 * @param {*} a 輸入值
 * @param {*} b 輸入值
 * @returns {Integer} 回傳 -1、0 或 1
 * @example
 * console.log(['b', 'a', 'B'].sort(cmp), [3, 10, 2].sort(cmp))
 * // => [ 'B', 'a', 'b' ] [ 2, 3, 10 ]
 */
export function cmp(a, b) {
    return a < b ? -1 : (a > b ? 1 : 0)
}

/**
 * 物件之不認得之鍵之問題(不拋錯之版本;checkKeys 之判準與字樣——「不認得之鍵」之訊息只此一種格式):物件之鍵(含值為 undefined 者)須在可用鍵內
 *
 * @param {*} obj 輸入物件，非物件時不檢核(回 '')
 * @param {Array} keys 輸入可用鍵陣列，非陣列時視為[]
 * @param {String} [name] 輸入設定名(訊息之主詞,如 'cfg.dirs';未給或空字串者訊息不帶主詞——由呼叫端接在其句中,如席位之問題)
 * @returns {String} 回傳「<設定名> 含不認得之鍵：<鍵>（可用：<可用鍵>）」(無問題回 '')
 * @example
 * console.log(unknownKeysProblem({ use: 'x', timeout: 1 }, ['use', 'fallback']))
 * // => 含不認得之鍵：timeout（可用：use、fallback）
 */
export function unknownKeysProblem(obj, keys, name) {
    if (!isobj(obj)) return ''
    const known = isarr(keys) ? keys : []
    const unknown = Object.keys(obj).filter((k) => !known.includes(k))
    if (!unknown.length) return ''
    return `${typeof name === 'string' && name ? `${name} ` : ''}含不認得之鍵：${unknown.join('、')}（可用：${known.join('、')}）`
}

/**
 * 物件之鍵須在可用鍵內,否則拋錯並列出可用鍵(打錯之鍵若靜默接受,正名鍵會維持預設而無人察覺)——「不認得之鍵」之訊息只此一種格式
 *   (unknownKeysProblem;不拋錯之呼叫端取之)
 *
 * @param {Object} obj 輸入物件，非物件時不檢核
 * @param {Array} keys 輸入可用鍵陣列，非陣列時視為[]
 * @param {String} name 輸入設定名(錯誤訊息用，如 'cfg'、'cfg.lmdb'、'vocab.guide')
 * @returns {undefined} 無回傳值
 * @throws {Error} 含不認得之鍵時拋出，訊息為「<設定名> 含不認得之鍵：<鍵>（可用：<可用鍵>）」
 * @example
 * try {
 *     checkKeys({ db: 'x', dbb: 'y' }, ['db', 'log'], 'cfg.dirs')
 * }
 * catch (e) {
 *     console.log(e.message)
 * }
 * // => cfg.dirs 含不認得之鍵：dbb（可用：db、log）
 */
export function checkKeys(obj, keys, name) {
    const p = unknownKeysProblem(obj, keys, name)
    if (p) throw new Error(p)
}

/**
 * 值之正規化字串(物件之鍵排序、陣列保序、值為 undefined 之鍵略過;比對用——JSON.stringify 受鍵序影響,同一內容之兩份記錄可因寫入序不同而字串不同)
 *
 * @param {*} v 輸入任意值(JSON 可表示者)
 * @returns {String} 回傳正規化字串
 * @example
 * console.log(canonOf({ b: [2, 1], a: 'x', c: undefined }))
 * // => {"a":"x","b":[2,1]}
 */
export function canonOf(v) {
    if (isarr(v)) return `[${v.map(canonOf).join(',')}]`
    if (isobj(v)) return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonOf(v[k])}`).join(',')}}`
    return JSON.stringify(v)
}

/**
 * 兩值是否相同(正規化比較;canonOf)
 *
 * @param {*} a 輸入值
 * @param {*} b 輸入值
 * @returns {Boolean} 回傳是否相同
 * @example
 * console.log(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 }), sameValue([1, 2], [2, 1]))
 * // => true false
 */
export function sameValue(a, b) {
    return canonOf(a) === canonOf(b)
}

export default { given, strOf, textValueOf, strictTextOf, textListOf, uniq, jsonClone, cmp, unknownKeysProblem, checkKeys, canonOf, sameValue }
