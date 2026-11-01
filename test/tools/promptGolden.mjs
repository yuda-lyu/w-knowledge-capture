// promptGolden.mjs — 預設提示詞標準檔之比對與重產(各套件之 test/tools/genPromptGolden.mjs 以之執行;不帶 .test. 中綴)
//
// 【為何一份】標準檔是提示詞之逐字契約:比對(逐鍵列出不同者)與重產(--write)之規則各套件同一份——各套件只給標準檔之路徑與其產生函數。
//   抓取套件之測試直接取本檔,摘要、關聯之產生器經各自之 test/tools/captureForTest.mjs 取用。

import fs from 'node:fs'
import path from 'node:path'

/**
 * 現行輸出與標準檔之逐鍵差異
 *
 * @param {Object} now 輸入現行輸出 { 變體: { 鍵: 文字 } }
 * @param {Object} old 輸入標準檔之內容(同形;缺者視為空)
 * @returns {Array} 回傳不同之鍵(「變體.鍵」;標準檔多出者附「(標準檔多出)」)
 * @example
 * console.log(goldenDiffOf({ a: { x: '1', y: '2' } }, { a: { x: '1', z: '3' } }))
 * // => [ 'a.y', 'a.z(標準檔多出)' ]
 */
export function goldenDiffOf(now, old) {
    const diff = []
    for (const [v, items] of Object.entries(now || {})) {
        for (const [k, text] of Object.entries(items)) if (old?.[v]?.[k] !== text) diff.push(`${v}.${k}`)
        for (const k of Object.keys(old?.[v] || {})) if (!(k in items)) diff.push(`${v}.${k}(標準檔多出)`)
    }
    return diff
}

/**
 * 產生器之執行:未帶 --write 只比對現行輸出與標準檔,逐鍵列出不同者(不寫檔;離開碼 0＝全同);帶 --write 重產標準檔(重產前須確認差異皆為
 *   刻意變更並取得同意)
 *
 * @param {Object} o 輸入 { file:標準檔之絕對路徑, render:() => 現行輸出 { 變體: { 鍵: 文字 } }, argv:命令列參數(取 --write) }
 * @returns {Array} 回傳不同之鍵(--write 時為空陣列)
 */
export function runPromptGolden({ file, render, argv = [] }) {
    const now = render()
    if (argv.includes('--write')) {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, `${JSON.stringify(now, null, 2)}\n`, 'utf8')
        console.log(`已寫入 ${path.resolve(file)}(${Object.keys(now).map((v) => `${v} ${Object.keys(now[v]).length} 項`).join('、')})`)
        return []
    }
    const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
    const diff = goldenDiffOf(now, old)
    console.log(diff.length ? `與標準檔不同 ${diff.length} 項:${diff.join('、')}` : '與標準檔逐字相同')
    process.exitCode = diff.length ? 1 : 0
    return diff
}

export default { goldenDiffOf, runPromptGolden }
