// jsonl.mjs — append-only JSONL 帳之讀寫(唯一一份;本套件與下游各套件之帳——存量處置帳、回溯帳、稽核帳、事件帳、影響帳——皆經此)
//
// 【缺檔與壞行分流】缺檔＝空帳;壞行(無法解析或非物件之列——append 中途被砍之半行、手改)略過並逐行回報行號與原因(呼叫端決定略過或拒),
//   不把壞行當空帳、也不整檔作廢。讀取本身失敗(權限、路徑為目錄等)即拋錯:寫入大概率同樣失敗,不假裝成空帳。
// 【append 先補尾換行】前次 append 中途被砍留下之半行若無換行,直接續寫會與本列黏成一行——兩列一起變壞行;故檔尾非換行時先補一個換行,
//   壞的只有那半行、本列完好。目錄於首次寫入時建立。

import fs from 'fs'
import path from 'path'
import isarr from 'wsemi/src/isarr.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import isobj from 'wsemi/src/isobj.mjs'

/**
 * 讀 append-only JSONL 帳:缺檔 []、壞行略過並回報、讀取失敗拋
 *
 * @param {String} file 輸入檔案路徑
 * @param {Object} [opt={}] 輸入 { onBad:({ line:行號(1 起), error })=>void(每一壞行呼叫;未給即靜默略過) }
 * @returns {Array} 回傳依寫入序之列(皆為物件)
 * @throws {Error} 讀取失敗(非缺檔)時拋出
 * @example
 * need test in nodejs.
 *
 * const bad = []
 * const rows = readJsonlRows('/kb/state/relate-retired.jsonl', { onBad: (b) => bad.push(b) })
 * console.log(rows.length, bad)
 * // => 3 [ { line: 2, error: '不是物件' } ]
 */
export function readJsonlRows(file, opt = {}) {
    let text
    try {
        text = fs.readFileSync(file, 'utf8')
    }
    catch (e) {
        if (e?.code === 'ENOENT') return []
        throw new Error(`JSONL 帳讀取失敗（${path.basename(String(file))}）：${e?.message || e}`)
    }
    const onBad = isobj(opt) && isfun(opt.onBad) ? opt.onBad : null
    const out = []
    text.split('\n').forEach((line, i) => {
        if (!line.trim()) return
        try {
            const r = JSON.parse(line)
            if (isobj(r)) out.push(r)
            else if (onBad) onBad({ line: i + 1, error: '不是物件' })
        }
        catch (e) {
            if (onBad) onBad({ line: i + 1, error: String(e?.message || '').slice(0, 120) })
        }
    })
    return out
}

/**
 * 附寫多列(建目錄;檔尾非換行先補一個換行——見檔頭【append 先補尾換行】);空陣列不寫、不建目錄
 *
 * @param {String} file 輸入檔案路徑
 * @param {Array} rows 輸入列(物件)陣列
 * @returns {Array} 回傳寫入之列
 * @example
 * need test in nodejs.
 *
 * appendJsonlRows('/kb/state/extract-impact.jsonl', [{ at: 'T', action: 'none' }, { at: 'T', action: 'recheck' }])
 */
export function appendJsonlRows(file, rows) {
    const list = isarr(rows) ? rows : []
    if (!list.length) return list
    fs.mkdirSync(path.dirname(file), { recursive: true })
    let prefix = ''
    try {
        const size = fs.statSync(file).size
        if (size > 0) {
            const fd = fs.openSync(file, 'r')
            try {
                const b = Buffer.alloc(1)
                fs.readSync(fd, b, 0, 1, size - 1)
                if (b[0] !== 0x0a) prefix = '\n'
            }
            finally {
                fs.closeSync(fd)
            }
        }
    }
    catch (e) {
        if (e?.code !== 'ENOENT') throw e
    }
    fs.appendFileSync(file, `${prefix}${list.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
    return list
}

/**
 * 附寫一列(appendJsonlRows 之單列形)
 *
 * @param {String} file 輸入檔案路徑
 * @param {Object} row 輸入列
 * @returns {Object} 回傳寫入之列
 * @example
 * need test in nodejs.
 *
 * appendJsonlRow('/kb/state/relate-retired.jsonl', { at: 'T', reason: 'std-retire', edge: { id: 'e1' } })
 */
export function appendJsonlRow(file, row) {
    appendJsonlRows(file, [row])
    return row
}

export default { readJsonlRows, appendJsonlRows, appendJsonlRow }
