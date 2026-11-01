// testKit.mjs — 各套件測試之共用件(位置無關;不帶 .test. 中綴):日誌之替身(靜音、記錄型、無等級之記錄型、每輪一個、落檔之真日誌)、
//   暫存根(依套件根之工廠)、概念折疊之還原、子階段 report 之取用與其斷言、集合之開關、日誌目錄之檔、讀 JSON、固定時鐘、拋錯之訊息、延遲、
//   可控截止之 ctx、AI 調度層之替身(callJson;各套件依其提示詞之角色作答者以之組成)、手寫替身之 check 包裝(withCheck)、設定覆寫之深層合併(deepMerge)、
//   CSV 之極簡解析(parseCsv)
//
// 【為何一份】四套件之測試各帶一份同名件時,語意即悄悄分歧(靜音日誌之欄位、記錄型日誌之欄位、取子階段 report 之參數序、拋錯之訊息於未拋時
//   回 null 或空字串)。抓取套件之測試直接取本檔;摘要、關聯、提煉之測試與專案之測試經各自之 test/tools/captureForTest.mjs 取用(依賴方向
//   只許上層取下層;test/unit-core-copies 守「只定義於本檔」)。
// 【綁套件位置者以工廠】套件根(pkgRootOf)與暫存根(tmpRootsOf)依呼叫端之套件給出——各套件之測試共用層各實例化一次,不各寫一份。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setConceptFold } from '../../src/core/util/text.mjs'
import { createLogger } from '../../src/core/runnerPackage.mjs'

/**
 * 套件根(呼叫端須為 <套件根>/test/tools/ 下之檔;與 cwd 無關;正斜線)
 *
 * @param {String} metaUrl 輸入呼叫端之 import.meta.url
 * @returns {String} 回傳套件根之絕對路徑
 * @example
 * // srcRelate/test/tools/relateTestKit.mjs 內
 * export const PKG_ROOT = pkgRootOf(import.meta.url)
 */
export function pkgRootOf(metaUrl) {
    return path.resolve(path.dirname(fileURLToPath(metaUrl)), '..', '..').replace(/\\/g, '/')
}

/**
 * 刪除暫存根並回驗(rm 可能因鎖定靜默失敗;殘留者只警示不拋——清理失敗不該讓測試結果翻轉)
 *
 * @param {Array} roots 輸入暫存根陣列
 * @returns {Array} 回傳仍殘留之路徑陣列
 */
export function removeRoots(roots) {
    const left = []
    for (const r of roots) {
        try {
            fs.rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        }
        catch { /* 回驗處理 */ }
        if (fs.existsSync(r)) left.push(r)
    }
    if (left.length) console.warn(`暫存根未能刪除（請人工清理）：${left.join('、')}`)
    return left
}

/**
 * 暫存根之工廠:tmpRoot(name) 建專用暫存根(<套件根>/test/_tmp/<name>-<pid>;已存在者清掉重建;帶 pid 使並行互不干擾)、removeRoots 同上
 *
 * @param {String} pkgRoot 輸入套件根(pkgRootOf 之產物)
 * @returns {Object} 回傳 { tmpRoot(name):String(絕對路徑,正斜線), removeRoots(roots):Array }
 */
export function tmpRootsOf(pkgRoot) {
    return {
        tmpRoot: (name) => {
            const root = `${pkgRoot}/test/_tmp/${name}-${process.pid}`
            fs.rmSync(root, { recursive: true, force: true })
            fs.mkdirSync(root, { recursive: true })
            return root
        },
        removeRoots,
    }
}

/** 靜音日誌(結構同執行殼之 createLogger 之產物;凍結——各測試共用同一實體) */
export const silentLog = Object.freeze({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, file: '', now: '', elapsed: () => '0.0', cliFail: () => '' })

/**
 * 記錄型日誌(斷言日誌字樣用;結構同 createLogger 之產物)
 *
 * @returns {Object} 回傳日誌物件，lines 為 'INFO …'／'WARN …'／'ERROR …' 字串陣列
 */
export function recLog() {
    const lines = []
    const f = (lv) => (m) => lines.push(`${lv} ${m}`)
    return { lines, info: f('INFO'), warn: f('WARN'), error: f('ERROR'), debug: () => {}, file: '', now: '', elapsed: () => '0.0', cliFail: () => '' }
}

/**
 * 記錄型日誌之無等級版(行為原訊息字串;命令列之 info／error 輸出之斷言用)
 *
 * @returns {Object} 回傳 { lines:Array(訊息字串), info, error }
 */
export function plainLog() {
    const lines = []
    return { lines, info: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) }
}

/**
 * 每輪一個記錄型日誌之工廠(runs[i] 為第 i 輪之日誌)
 *
 * @returns {Object} 回傳 { runs:Array, factory:() => logger, lines():Array(全部輪之行) }
 */
export function logsOf() {
    const runs = []
    return {
        runs,
        factory: () => {
            const l = recLog()
            runs.push(l)
            return l
        },
        lines: () => runs.flatMap((r) => r.lines),
    }
}

/**
 * 落檔之真日誌工廠(執行殼之 createLogger;不同步輸出 stdout):日誌檔與開工標記、執行摘要同一時間戳
 *
 * @param {Function} flowOf 輸入 () => flow(建構後才取得之總組裝;取其 info().dirs.log 與時鐘)
 * @returns {Function} 回傳 () => logger
 */
export function fileLogFactory(flowOf) {
    return () => createLogger('run', { dir: flowOf().info().dirs.log, clock: flowOf().info().clock, echo: false })
}

/**
 * 還原概念折疊之模組級狀態:各總組裝於建構時設定之(同行程多實例以最後建構者為準),同一行程後續執行之測試不應承受之
 */
export function resetConceptFold() {
    setConceptFold(null)
}

/**
 * 取某段之子階段 report(report.stages[].result.detail[sub])
 *
 * @param {Object} rep 輸入 flow.run() 之 report
 * @param {String} stageName 輸入段名(各物件之預設名:抓取／摘要／關聯／提煉)
 * @param {String} sub 輸入子階段名
 * @returns {Object|null} 回傳子階段 report,無則 null
 */
export function subReport(rep, stageName, sub) {
    const st = (rep?.stages || []).find((s) => s.name === stageName)
    return st?.result?.detail?.[sub] || null
}

/**
 * 管線整體成功、各子階段 report.ok 皆非 false、各段摘要不含 undefined 與失敗字樣
 * (段狀態 ok 只代表物件沒拋錯,子階段失敗會被 onError:'continue' 吸收;摘要之固定格式缺計數時會印出 undefined)
 *
 * @param {Object} rep 輸入 flow.run() 之 report
 * @param {Object} assert 輸入 node:assert/strict
 */
export function assertSubStagesOk(rep, assert) {
    assert.equal(rep.ok, true, '管線整體須成功')
    assert.ok(Array.isArray(rep.stages) && rep.stages.length >= 1, 'report 須含至少一段')
    for (const st of rep.stages) {
        const sub = st.result?.detail
        if (!sub || typeof sub !== 'object') continue
        for (const [name, r] of Object.entries(sub)) {
            if (r && typeof r === 'object' && 'ok' in r) assert.notEqual(r.ok, false, `子階段[${st.name}.${name}] 失敗:${r.summary || ''}`)
        }
        assert.doesNotMatch(String(st.result?.summary || ''), /undefined|失敗：/, `段[${st.name}] 摘要不得含 undefined 或失敗字樣:${st.result?.summary}`)
    }
}

/**
 * 開集合、執行 fn、一律關閉(LMDB 檔案鎖不可跨執行持有)
 *
 * @param {Object} flow 輸入總組裝(具 openStores／closeStores)
 * @param {Function} fn 輸入 async (stores) => 任意值
 * @returns {Promise} 回傳 fn 之回傳值
 */
export async function withStores(flow, fn) {
    const s = flow.openStores()
    try {
        return await fn(s)
    }
    finally {
        await flow.closeStores(s)
    }
}

/**
 * 找出目錄下(含一層日期子目錄)以 suffix 結尾之檔
 *
 * @param {String} dir 輸入 log 根目錄
 * @param {String} suffix 輸入檔名尾碼
 * @returns {Array} 回傳檔案路徑陣列(依檔名排序)
 */
export function findFiles(dir, suffix) {
    const out = []
    if (!fs.existsSync(dir)) return out
    for (const day of fs.readdirSync(dir)) {
        const p = path.join(dir, day)
        if (fs.statSync(p).isDirectory()) for (const f of fs.readdirSync(p)) if (f.endsWith(suffix)) out.push(path.join(p, f))
    }
    return out.sort()
}

/**
 * 讀 JSON 檔
 *
 * @param {String} f 輸入檔案路徑
 * @returns {*} 回傳解析後之值
 */
export const readJsonFile = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))

/** 固定時鐘(Asia/Taipei):檔名之時間戳與各時刻皆可預期(只用於不比較先後之案) */
export const FIXED_CLOCK = Object.freeze({ timeZone: 'Asia/Taipei', iso8: () => '2026-01-02T03:04:05+08:00', stamp8: () => '20260102030405', date8: () => '2026-01-02', day8: () => '20260102' })

/**
 * 同步函數拋出之錯誤訊息
 *
 * @param {Function} fn 輸入函數
 * @returns {String|null} 回傳錯誤訊息,未拋回 null
 */
export function msgOf(fn) {
    try {
        fn()
    }
    catch (e) {
        return String(e?.message)
    }
    return null
}

/**
 * 延遲
 *
 * @param {Number} ms 輸入毫秒數
 * @returns {Promise} 回傳 ms 毫秒後 resolve 之 Promise
 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 可控截止之 ctx(仿 w-data-pipeline 之 createContext:整數毫秒)——時間預算邊界之實跑用
 *
 * @param {Number} budgetMs 輸入自現在起之預算毫秒數
 * @returns {Object} 回傳 { deadlineAt, remainingMs(), expired() }
 */
export function mkCtx(budgetMs) {
    const deadlineAt = Date.now() + budgetMs
    return { deadlineAt, remainingMs: () => Math.max(0, deadlineAt - Date.now()), expired: () => Date.now() >= deadlineAt }
}

/**
 * 手寫 AI 替身之包裝:注入之 callAI(prompt, check, callOpt) 須自驗呼叫端傳入之正式 check(各套件之 AI 呼叫契約);fn 回 ok 者其 data 經 check,
 *   不合即回失敗(字樣同 stubAdapter),其餘原樣——各段測試之手寫替身以之包住,不各自漏驗
 *
 * @param {Function} fn 輸入 async (prompt, check, callOpt) => 調度層之回傳形狀
 * @returns {Function} 回傳同簽名之函數
 * @example
 * const callAI = withCheck(async (prompt) => ({ ok: true, data: [{ index: 1 }], error: '', skipped: false, attempts: 1 }))
 * const r = await callAI('p', (d) => (Array.isArray(d) ? true : '須為陣列'))
 * console.log(r.ok)
 * // => true
 */
export function withCheck(fn) {
    return async (prompt, check, callOpt) => {
        const r = await fn(prompt, check, callOpt)
        if (r?.ok === true && typeof check === 'function' && check(r.data) !== true) return { ...r, ok: false, data: null, error: 'OUTPUT_VALIDATION_FAILED（替身形狀不合）' }
        return r
    }
}

/**
 * 設定覆寫之深層合併:純物件(非陣列)逐鍵遞迴、陣列與葉原樣取代;b 之 undefined 視為未給(沿用 a)——覆寫物件「沒寫」即沿用,
 *   lodash merge 會逐位置合併陣列、把 undefined 寫入,皆不合設定覆寫之語意,故自寫(各套件之測試同一份)
 *
 * @param {*} a 輸入基底
 * @param {*} [b] 輸入覆寫(undefined 視為無)
 * @returns {*} 回傳合併後之新值(不改動輸入)
 * @example
 * console.log(JSON.stringify(deepMerge({ a: { x: 1, y: [1] }, k: 2 }, { a: { y: [2], z: undefined }, k: undefined })))
 * // => {"a":{"x":1,"y":[2]},"k":2}
 */
export function deepMerge(a, b) {
    const plain = (x) => !!x && typeof x === 'object' && !Array.isArray(x)
    if (!plain(a) || !plain(b)) return b === undefined ? a : b
    const o = { ...a }
    for (const [k, v] of Object.entries(b)) o[k] = deepMerge(a[k], v)
    return o
}

/**
 * 極簡 CSV 解析(RFC 4180 引號跳脫;BOM 有則去;CRLF 與 LF;全空之列略過)——評比表、剔除清單之讀回斷言用,各套件同一份
 *
 * @param {String} text 輸入 CSV 字串
 * @returns {Array} 回傳列陣列(各列為欄位字串陣列)
 * @example
 * console.log(JSON.stringify(parseCsv('﻿a,b\r\n1,"x,""y"""\n\n')))
 * // => [["a","b"],["1","x,\"y\""]]
 */
export function parseCsv(text) {
    const t = String(text ?? '')
    const s = t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t
    const rows = []
    let row = []
    let cell = ''
    let q = false
    for (let i = 0; i < s.length; i++) {
        const ch = s[i]
        if (q) {
            if (ch === '"' && s[i + 1] === '"') {
                cell += '"'
                i++
            }
            else if (ch === '"') q = false
            else cell += ch
        }
        else if (ch === '"') q = true
        else if (ch === ',') {
            row.push(cell)
            cell = ''
        }
        else if (ch === '\n') {
            row.push(cell)
            if (row.some((x) => x !== '')) rows.push(row)
            row = []
            cell = ''
        }
        else if (ch !== '\r') cell += ch
    }
    if (cell || row.length) {
        row.push(cell)
        if (row.some((x) => x !== '')) rows.push(row)
    }
    return rows
}

/**
 * AI 調度層之替身(整組置換 cfg.aiAdapter):介面同套件調度層之 callJson(prompt, check, { spec, … });回覆經呼叫端傳入之 check 驗證
 *   (與生產同一驗證函數;回 true 才合格),使「覆寫之提示詞不得破壞輸出契約」之行為可測。providerId 取席位之 use(未給席位者 'stub')。
 *   各套件依其提示詞之角色作答之替身(摘要、關聯之 scriptedAi)以本件組成——角色表、本批之解析與預設作答留各套件
 *
 * @param {Function} answer 輸入 (prompt, callOpt, role) => 作答之 JSON｜'fail'(失敗)｜'skip'(額度／時間用盡:skipped);拋錯視為失敗。
 *   role 為 opt.roleOf 之判定(未給 roleOf 者 undefined)
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Function} [opt.roleOf] 輸入 (prompt) => 角色(給了即記入 calls 之 role 並交 answer)
 * @param {Number} [opt.delayMs=0] 輸入每次作答前之延遲(時間預算之案用)
 * @param {Boolean} [opt.validateSeats=false] 輸入是否具備 validateSeats(啟動期席位檢核;記錄於 seatChecks)
 * @returns {Object} 回傳替身 { calls:Array({ role?, prompt, spec, opt }), seatChecks:Array, callJson, drainStats, aiUsageToday, validateSeats? }
 */
export function stubAdapter(answer, opt = {}) {
    const calls = []
    const seatChecks = []
    const result = (ok, data, error, spec, skipped = false) => ({ ok, data, error, providerId: ok ? String(spec?.use || 'stub') : '', attempts: skipped ? 0 : 1, skipped })
    const ad = {
        calls,
        seatChecks,
        callJson: async (prompt, check, callOpt) => {
            const role = typeof opt.roleOf === 'function' ? opt.roleOf(prompt) : undefined
            calls.push({ ...(role === undefined ? {} : { role }), prompt, spec: callOpt?.spec, opt: callOpt })
            if (opt.delayMs > 0) await sleep(opt.delayMs)
            let data
            try {
                data = await answer(prompt, callOpt, role)
            }
            catch (e) {
                return result(false, null, `替身拋錯：${e.message}`, callOpt?.spec)
            }
            if (data === 'skip') return result(false, null, '額度用盡（替身）', callOpt?.spec, true)
            if (data === 'fail') return result(false, null, 'stub 失敗', callOpt?.spec)
            if (typeof check === 'function' && check(data) !== true) return result(false, null, 'OUTPUT_VALIDATION_FAILED（替身形狀不合）', callOpt?.spec)
            return result(true, data, '', callOpt?.spec)
        },
        drainStats: () => '無呼叫',
        aiUsageToday: () => ({ today: '', used: 0, byKey: {} }),
    }
    if (opt.validateSeats) {
        ad.validateSeats = (seats) => {
            seatChecks.push(seats)
            return { ok: true, warnings: [] }
        }
    }
    return ad
}

export default {
    pkgRootOf, removeRoots, tmpRootsOf, silentLog, recLog, plainLog, logsOf, fileLogFactory, resetConceptFold, subReport, assertSubStagesOk, withStores, findFiles,
    readJsonFile, FIXED_CLOCK, msgOf, sleep, mkCtx, stubAdapter,
}
