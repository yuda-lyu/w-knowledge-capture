// table.mjs — 表格輸出之跳脫(CSV 與 Markdown;剔除清單與評分報表共用同一份)
//
// 【為何一份】CSV 之 RFC 4180 跳脫與 Markdown 表格之儲存格跳脫各寫一份時,規則即分歧(如一份處理單獨之 \r、反斜線緊鄰「|」,另一份不處理)——
//   模型產出之文字與網址照錄於表,跳脫不全即打壞表格。剔除清單(rejects)與評分報表(bench/report)皆取本檔,評分核心不依賴剔除清單之模組。
// 【CSV】含 BOM(試算表軟體以 BOM 判 UTF-8,無 BOM 時中文成亂碼)、列間 CRLF、結尾 CRLF;含逗號、雙引號、換行者以雙引號包起,內含之雙引號加倍。

import { strOf } from './values.mjs'

/** UTF-8 BOM(CSV 開頭) */
const BOM = '﻿'

/**
 * CSV 欄位跳脫(RFC 4180):含逗號、雙引號、換行者以雙引號包起,內含之雙引號加倍
 *
 * @param {*} v 輸入欄位值(null／undefined 為空字串)
 * @returns {String} 回傳 CSV 欄位字串
 * @example
 * console.log(csvCell('a,"b"'))
 * // => "a,""b"""
 */
export function csvCell(v) {
    const s = strOf(v)
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * 組 CSV 字串(檔頭【CSV】)
 *
 * @param {Array} header 輸入表頭(欄名陣列)
 * @param {Array} rows 輸入各列(各為值陣列;非陣列之列視為空列)
 * @returns {String} 回傳 CSV 字串(BOM 開頭、CRLF 分列與結尾)
 * @example
 * console.log(JSON.stringify(toCsv(['a', 'b'], [[1, 'x,y']])))
 * // => "﻿a,b\r\n1,\"x,y\"\r\n"
 */
export function toCsv(header, rows) {
    const list = [header, ...(Array.isArray(rows) ? rows : [])].map((r) => (Array.isArray(r) ? r : []))
    return `${BOM}${list.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`
}

/**
 * Markdown 表格儲存格跳脫:換行(\r\n、\r、\n)壓成空白(表格列不得斷行);每個「|」前之反斜線連續段加倍後再加一個反斜線——
 *   表格以成對之反斜線為跳脫字元,「|」前須恆為奇數個反斜線才是跳脫之「|」(偶數個即成欄界而打壞表格);加倍使原文之反斜線照樣顯示
 *
 * @param {*} v 輸入欄位值(null／undefined 為空字串)
 * @returns {String} 回傳可安全放入表格欄位之字串
 * @example
 * console.log(mdCell('a|b\nc'), mdCell('c\\|d'))
 * // => a\|b c c\\\|d
 */
export function mdCell(v) {
    return strOf(v).replace(/\r\n|\r|\n/g, ' ').replace(/(\\*)\|/g, (m, bs) => `${bs}${bs}\\|`)
}

export default { csvCell, toCsv, mdCell }
