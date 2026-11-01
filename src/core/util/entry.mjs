// entry.mjs — 套件主入口之預設匯出物件之合成(各套件之主入口同一規則;本套件與下游套件共用)
//
// 【規則】各公開模組之命名空間逐一併入一個物件:略過 default 鍵;同名而不同實體即拋(export * 會靜默剔除該名,以具名匯入取用時才爆,故載入時即檢查)。
//   具名匯出與預設物件由同一組命名空間合成,不另手寫名稱清單——各入口只列模組清單。

import isarr from 'wsemi/src/isarr.mjs'
import isestr from 'wsemi/src/isestr.mjs'

/**
 * 合成主入口之預設匯出物件(檔頭【規則】)
 *
 * @param {String} name 輸入入口名(錯誤訊息用,如 'WKnowledgeCapture')
 * @param {Array} namespaces 輸入各公開模組之命名空間物件(import * as …)
 * @returns {Object} 回傳合成之物件(各命名空間之具名匯出;不含 default)
 * @throws {Error} name 非非空字串、namespaces 非陣列、或兩個模組匯出同名而不同實體時拋出
 * @example
 * let a = { x: 1, default: 'd' }
 * let b = { y: 2, x: 1 }
 * console.log(composeNamespaces('W', [a, b]))
 * // => { x: 1, y: 2 }
 */
export function composeNamespaces(name, namespaces) {
    if (!isestr(name)) throw new Error('composeNamespaces 需要入口名（字串）')
    if (!isarr(namespaces)) throw new Error(`composeNamespaces 需要 ${name} 之命名空間陣列`)
    const out = {}
    for (const ns of namespaces) {
        for (const [k, v] of Object.entries(ns || {})) {
            if (k === 'default') continue
            if (Object.prototype.hasOwnProperty.call(out, k) && out[k] !== v) {
                throw new Error(`${name} 之匯出名衝突：${k}(兩個公開模組匯出同名而不同實體;export * 會靜默剔除此名)`)
            }
            out[k] = v
        }
    }
    return out
}

export default { composeNamespaces }
