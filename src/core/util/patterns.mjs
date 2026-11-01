// patterns.mjs — 樣式設定之正規化(安裝方以 JSON 可寫之 { p, f } 給正則;各處共用同一份驗證)
//
// 【為何在 core】健全閘(stores/contentGate)等處皆收安裝方追加之樣式,樣式設定之驗證是共用規則,
//   不內嵌於單一模組。

import isobj from 'wsemi/src/isobj.mjs'
import isarr from 'wsemi/src/isarr.mjs'
import isestr from 'wsemi/src/isestr.mjs'

/**
 * 樣式設定正規化:接受 RegExp 或 { p, f }(JSON 可寫);其餘形狀拋錯(錯誤樣式會靜默放行或誤殺)
 *
 * @param {Array} list 輸入樣式陣列，非陣列視為[]
 * @param {String} name 輸入設定名(錯誤訊息用)
 * @returns {Array} 回傳 RegExp 陣列
 * @throws {Error} 任一項非 RegExp 亦非 { p:非空字串, f?:字串 }，或樣式字串不合法時拋出
 * @example
 * console.log(toPatterns([{ p: 'abc', f: 'i' }], 'x')[0].test('ABC'))
 * // => true
 */
export function toPatterns(list, name = 'patterns') {
    if (!isarr(list)) return []
    return list.map((x, i) => {
        if (x instanceof RegExp) return x
        if (isobj(x) && isestr(x.p) && (x.f === undefined || typeof x.f === 'string')) {
            try {
                return new RegExp(x.p, x.f || '')
            }
            catch (e) {
                throw new Error(`${name}[${i}] 樣式不合法：${e.message}`)
            }
        }
        throw new Error(`${name}[${i}] 須為 RegExp 或 { p: 樣式字串, f?: 旗標 }，收到：${JSON.stringify(x)}`)
    })
}

export default { toPatterns }
