// cli.mjs — 命令列之共用小工具:是否為直接執行(isDirectRun)
//
// 【為何一份】「被 import 時不執行、直接執行(node <檔> …)時才跑」之判定各命令列各寫一份時,語意即悄悄分歧(有的 Windows 路徑不分大小寫、
//   有的分;有的一律轉小寫;有的解符號連結、有的不解)——路徑寫法不一致即誤判為被 import 而不執行。本套件與下游套件之命令列(評分、抓取器、
//   工具)一律取本檔。
// 【比對實際檔案】兩端皆取實際路徑(realpath:解符號連結／junction、Windows 之大小寫與短檔名)後比對——經連結執行時 process.argv[1] 為連結之路徑,
//   import.meta.url 卻是解連結後之實際路徑;取不到實際路徑(檔不存在)者退回 path.resolve。Windows 另不分大小寫。

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

/**
 * 路徑之比對形式:實際路徑(取不到者退回 path.resolve);Windows 轉小寫
 *
 * @param {String} p 輸入路徑
 * @returns {String} 回傳比對形式
 */
function canonOf(p) {
    let r
    try {
        r = fs.realpathSync.native(p)
    }
    catch {
        r = path.resolve(p)
    }
    return process.platform === 'win32' ? r.toLowerCase() : r
}

/**
 * 是否為直接執行(node <該檔> …;被 import 時為 false):比對 process.argv[1] 與呼叫端之模組路徑之實際檔案(解符號連結;Windows 不分大小寫)
 *
 * @param {String} metaUrl 輸入呼叫端之 import.meta.url
 * @returns {Boolean} 回傳是否直接執行(argv[1] 未給、metaUrl 非 file URL 皆為 false)
 * @example
 * if (isDirectRun(import.meta.url)) main()
 */
export function isDirectRun(metaUrl) {
    if (!process.argv[1] || typeof metaUrl !== 'string') return false
    let self
    try {
        self = fileURLToPath(metaUrl)
    }
    catch {
        return false
    }
    return canonOf(process.argv[1]) === canonOf(self)
}

export default { isDirectRun }
