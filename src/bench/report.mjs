// report.mjs — AI 能力評分之報表(角色化):runBench 之結果＋角色定義 → CSV(含 BOM)、Markdown、JSON,與落檔;累積之評比表
//
// 【兩份 CSV】逐模型分數(一模型一列)與逐案明細(一模型一案一列,各回之類別、角色欄位、合契約、耗時、錯誤並排);
//   含 BOM:試算表軟體以 BOM 判 UTF-8,無 BOM 時中文成亂碼。欄位含逗號、引號、換行者依 RFC 4180 加引號跳脫(模型產出之文字照錄)。
// 【角色欄位】逐案明細之案欄與每回欄、Markdown 逐案表之案欄由角色定義之 report.caseColumns／runColumns 給(以鍵取結果之案與各回紀錄);
//   Markdown 之標題與判準說明、各回儲存格之補充顯示(detailOf)亦取自角色——同一份報表程式出各角色之報表。
// 【Markdown】逐模型分數表、逐案明細、未通過原因;表格儲存格內之 | 與換行跳脫,模型產出之文字不得打壞表格。
// 【排序】分數表依通過數(多→少)、合契約率(高→低)、平均耗時(短→長);明細依受測順序。
// 【評比表(累積)】mergeBenchBoard:一角色一模型一列,本次結果覆蓋同角色同模型之舊列、其餘保留(他角色之列不動)——跨次、跨角色評比之
//   現況總表(如套件根之 模型評比.csv)。停測或有未呼叫回合之模型不寫入(分數不完整;額度用盡之一輪不得蓋掉先前之完整分數)。
//   既有檔之表頭與本版不同即拋錯(不覆寫他人手改或舊版之表)。AI 工作目錄一併記錄:CLI 型模型會讀該目錄上層之指示檔,
//   同一模型在不同目錄下之分數可不同。
// 【只讀結果物件與角色定義】不 import 執行器與角色定義之模組(執行器 benchKit 轉出本檔之函數;反向 import 會成循環):
//   角色須為 benchKit 之 defineBenchRole 之產物,本檔只驗所用之欄位。

import fs from 'fs'
import path from 'path'
import isobj from 'wsemi/src/isobj.mjs'
import isarr from 'wsemi/src/isarr.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import isfun from 'wsemi/src/isfun.mjs'
// CSV 與 Markdown 儲存格之跳脫取核心之一份(與剔除清單同一規則;評分核心不依賴剔除清單之模組)
import { toCsv, mdCell } from '../core/util/table.mjs'
// 評比表之排序取核心之碼元序比較(跨機一致;不用 localeCompare——隨 ICU 版本而異)、寫檔取原子寫(累積之總表中途中斷不留半份)
import { cmp } from '../core/util/values.mjs'
import { writeFileAtomic } from '../core/util/fileIo.mjs'

/**
 * 呼叫失敗類別之欄名(鍵與 benchKit 之 BENCH_FAIL_KINDS 同一組;逐模型 CSV 依此順序各列一欄)
 *
 * @type {Array}
 */
export const BENCH_FAIL_COLUMNS = Object.freeze([['timeout', '逾時'], ['limit', '限流'], ['reply', '回覆非JSON'], ['error', '執行錯誤'], ['skipped', '略過']].map((x) => Object.freeze(x)))

/**
 * 比率之顯示(百分比一位小數;null 為 '-')
 *
 * @param {Number|null} r 輸入 0～1 之比率
 * @returns {String} 回傳顯示字串
 */
const pct = (r) => (Number.isFinite(r) ? `${(r * 100).toFixed(1)}%` : '-')

/**
 * 毫秒 → 秒(一位小數;null 為空字串)
 *
 * @param {Number|null} ms 輸入毫秒數
 * @returns {String} 回傳秒數字串
 */
const sec = (ms) => (Number.isFinite(ms) ? (ms / 1000).toFixed(1) : '')

/**
 * 報表所用之角色欄位之檢核(角色須為 defineBenchRole 之產物;本檔不 import 角色定義之模組,只驗所用之欄位)
 *
 * @param {*} role 輸入角色
 * @param {String} where 輸入呼叫處(錯誤訊息用)
 * @returns {Object} 回傳同一角色
 * @throws {Error} 缺所用之欄位時拋出
 */
function reportRoleOf(role, where) {
    const ok = isobj(role) && isestr(role.id) && isestr(role.name) && isestr(role.title) && isestr(role.runnerName) && isfun(role.detailOf) &&
        isobj(role.report) && isarr(role.report.criteria) && isarr(role.report.caseColumns) && isarr(role.report.runColumns)
    if (!ok) throw new Error(`${where} 需要角色定義（benchKit 之 defineBenchRole 之產物）`)
    return role
}

/**
 * 一回之補充顯示(角色之 detailOf;拋錯或非字串為空字串——顯示用之掛點不得中斷報表)
 *
 * @param {Object} role 輸入角色
 * @param {Object} x 輸入該回紀錄
 * @returns {String} 回傳補充顯示
 */
function detailOf(role, x) {
    try {
        const s = role.detailOf(x)
        return typeof s === 'string' ? s : ''
    }
    catch {
        return ''
    }
}

/**
 * 一回之顯示:未呼叫／呼叫失敗／無裁決／類別(＋角色之補充顯示)
 *
 * @param {Object} role 輸入角色
 * @param {Object} x 輸入該回紀錄
 * @returns {String} 回傳顯示字串
 */
function runText(role, x) {
    if (!x) return '-'
    if (x.notRun) return '未呼叫'
    if (x.callFail) return `失敗:${x.failKind}`
    if (x.cls === null) return '無裁決'
    return `${x.cls}${detailOf(role, x)}`
}

/**
 * 結果物件之檢核
 *
 * @param {*} result 輸入 runBench 之結果
 * @param {String} runner 輸入執行器名(錯誤訊息用;角色之 runnerName)
 * @throws {Error} 非 { meta, models:[] } 形狀時拋出
 */
function checkResult(result, runner) {
    if (!isobj(result) || !isobj(result.meta) || !isarr(result.models)) throw new Error(`報表需要 ${runner} 之結果 { meta, models }`)
}

/**
 * 分數表之排序:通過數多→少、合契約率高→低、平均耗時短→長
 *
 * @param {Array} models 輸入模型結果陣列
 * @returns {Array} 回傳排序後之淺拷貝
 */
function ranked(models) {
    const num = (v, dflt) => (Number.isFinite(v) ? v : dflt)
    return [...models].sort((a, b) => (b.score.pass - a.score.pass) ||
        (num(b.contract.rate, -1) - num(a.contract.rate, -1)) ||
        (num(a.avgMs, Infinity) - num(b.avgMs, Infinity)))
}

/**
 * 逐模型分數之 CSV(一模型一列;含 BOM)
 *
 * @param {Object} result 輸入 runBench 之結果
 * @param {Object} [role] 輸入角色(只取 runnerName 供錯誤訊息;分數欄與角色無關)
 * @returns {String} 回傳 CSV 字串
 * @throws {Error} 角色給了而不合，或 result 形狀不合時拋出
 * @example
 * let role = defineBenchRole({
 *     id: 'topic',
 *     name: '題目分類(topic)',
 *     expectOf: (c) => c.expect.label,
 *     domainOf: () => ({}),
 *     promptOf: (cases) => cases.map((c, i) => `${i + 1}. ${c.input.text}`).join('；'),
 *     verdictOf: (data) => ({ cls: data?.label ?? null, valid: true, problem: '', fields: {} }),
 * })
 * // 以替身調度層(不呼叫真實 AI)產生一份結果
 * let ai = { callJson: async () => ({ ok: true, data: { label: 'astro' }, error: '', providerId: 'stub', attempts: 1, skipped: false, errors: [] }) }
 * let cases = [{ id: 't1', input: { text: '黑洞光譜' }, expect: { label: 'astro' }, why: '天文題' }]
 * let result = await runBench(role, { models: ['m1'], cases, runs: 1, aiAdapter: ai })
 * console.log(benchModelsCsv(result, role).split('\n')[1].split(',').slice(0, 4))
 * // => [ 'm1', '1', '1', '100.0%' ]
 */
export function benchModelsCsv(result, role) {
    checkResult(result, role === undefined || role === null ? 'runBench' : reportRoleOf(role, 'benchModelsCsv').runnerName)
    const m = result.meta
    const header = ['模型', '通過', '案數', '通過率', '一般案通過', '一般案數', '保留案通過', '保留案數', '合契約', '取得回覆', '合契約率',
        '平均耗時秒', '平均耗時秒(含失敗)', '送出呼叫', '呼叫失敗', ...BENCH_FAIL_COLUMNS.map(([, n]) => n), '未呼叫', '停測', '題組', '每案回數', '提示詞指紋', '評比開始', '評比結束']
    const rows = ranked(result.models).map((x) => [
        x.model, x.score.pass, x.score.total, pct(x.score.rate), x.general.pass, x.general.total, x.holdout.pass, x.holdout.total,
        x.contract.valid, x.contract.total, pct(x.contract.rate), sec(x.avgMs), sec(x.avgMsAll), x.calls.sent, x.calls.failed,
        ...BENCH_FAIL_COLUMNS.map(([k]) => x.calls.byKind?.[k] || 0), x.calls.notRun, x.stopped || '',
        `${m.std || '-'} v${m.v ?? '-'}`, m.runs, m.promptFp, m.startedAt, m.endedAt,
    ])
    return toCsv(header, rows)
}

/**
 * 逐案明細之 CSV(一模型一案一列;各回之欄位並排;含 BOM)。案欄與每回欄由角色之 report.caseColumns／runColumns 給
 *
 * @param {Object} result 輸入 runBench 之結果
 * @param {Object} role 輸入角色(defineBenchRole 之產物)
 * @returns {String} 回傳 CSV 字串
 * @throws {Error} 角色不合或 result 形狀不合時拋出
 * @example
 * let role = defineBenchRole({
 *     id: 'topic',
 *     name: '題目分類(topic)',
 *     expectOf: (c) => c.expect.label,
 *     domainOf: () => ({}),
 *     promptOf: (cases) => cases.map((c, i) => `${i + 1}. ${c.input.text}`).join('；'),
 *     verdictOf: (data) => ({ cls: data?.label ?? null, valid: true, problem: '', fields: {} }),
 * })
 * // 以替身調度層(不呼叫真實 AI)產生一份結果
 * let ai = { callJson: async () => ({ ok: true, data: { label: 'astro' }, error: '', providerId: 'stub', attempts: 1, skipped: false, errors: [] }) }
 * let cases = [{ id: 't1', input: { text: '黑洞光譜' }, expect: { label: 'astro' }, why: '天文題' }]
 * let result = await runBench(role, { models: ['m1'], cases, runs: 1, aiAdapter: ai })
 * let row = benchCasesCsv(result, role).split('\n')[1].split(',')
 * console.log(row[0], row[1], row[4], row[5])
 * // => m1 t1 astro astro
 */
export function benchCasesCsv(result, role) {
    role = reportRoleOf(role, 'benchCasesCsv')
    checkResult(result, role.runnerName)
    const runs = Number.isInteger(result.meta.runs) && result.meta.runs > 0 ? result.meta.runs : 0
    const caseCols = role.report.caseColumns
    const runCols = role.report.runColumns
    const perRun = []
    for (let k = 1; k <= runs; k++) perRun.push(`第${k}回類別`, ...runCols.map((col) => `第${k}回${col.name}`), `第${k}回合契約`, `第${k}回耗時秒`, `第${k}回錯誤`)
    const header = ['模型', '案', '題型', '保留', ...caseCols.map((col) => col.name), '應然', ...perRun, '通過', '各回一致', '未通過原因', '應然依據']
    const rows = []
    for (const x of result.models) {
        for (const c of x.cases) {
            const cols = []
            for (let k = 0; k < runs; k++) {
                const r = c.runs[k]
                if (!r) {
                    cols.push('', ...runCols.map(() => ''), '', '', '')
                    continue
                }
                const cls = r.notRun ? '未呼叫' : r.callFail ? `失敗:${r.failKind}` : (r.cls || '無裁決')
                const err = r.notRun || r.callFail ? r.error : (r.cls === null ? `${r.problem}${r.reply ? `；回覆：${r.reply}` : ''}` : '')
                cols.push(cls, ...runCols.map((col) => r[col.key]), r.notRun || r.callFail ? '' : (r.valid ? '是' : '否'), r.notRun ? '' : sec(r.ms), err)
            }
            rows.push([x.model, c.id, c.type, c.holdout ? '是' : '否', ...caseCols.map((col) => c[col.key]), c.expect, ...cols, c.pass ? '是' : '否', c.consistent ? '是' : '否', c.note, c.why])
        }
    }
    return toCsv(header, rows)
}

/**
 * Markdown 報表(逐模型分數表＋逐案明細＋未通過原因);標題、判準說明與逐案表之案欄取自角色
 *
 * @param {Object} result 輸入 runBench 之結果
 * @param {Object} role 輸入角色(defineBenchRole 之產物)
 * @returns {String} 回傳 Markdown 字串
 * @throws {Error} 角色不合或 result 形狀不合時拋出
 * @example
 * let role = defineBenchRole({
 *     id: 'topic',
 *     name: '題目分類(topic)',
 *     expectOf: (c) => c.expect.label,
 *     domainOf: () => ({}),
 *     promptOf: (cases) => cases.map((c, i) => `${i + 1}. ${c.input.text}`).join('；'),
 *     verdictOf: (data) => ({ cls: data?.label ?? null, valid: true, problem: '', fields: {} }),
 * })
 * // 以替身調度層(不呼叫真實 AI)產生一份結果
 * let ai = { callJson: async () => ({ ok: true, data: { label: 'astro' }, error: '', providerId: 'stub', attempts: 1, skipped: false, errors: [] }) }
 * let cases = [{ id: 't1', input: { text: '黑洞光譜' }, expect: { label: 'astro' }, why: '天文題' }]
 * let result = await runBench(role, { models: ['m1'], cases, runs: 1, aiAdapter: ai })
 * let md = benchMarkdown(result, role)
 * console.log(md.split('\n')[0], md.includes('（全數通過）'))
 * // => # 題目分類(topic) AI 能力評分 true
 */
export function benchMarkdown(result, role) {
    role = reportRoleOf(role, 'benchMarkdown')
    checkResult(result, role.runnerName)
    const m = result.meta
    const runs = Number.isInteger(m.runs) && m.runs > 0 ? m.runs : 0
    const mdCols = role.report.caseColumns.filter((col) => col.md === true)
    const lines = []
    lines.push(`# ${role.title}`, '')
    lines.push(`- 評比時間：${m.startedAt || '-'} ～ ${m.endedAt || '-'}`)
    lines.push(`- 題組：${m.std || '-'} v${m.v ?? '-'}，${m.cases} 案（一般 ${m.cases - m.holdout}、保留 ${m.holdout}）；每案 ${runs} 回；提示詞指紋 ${m.promptFp}`)
    lines.push(`- 受測模型：${(m.models || []).join('、')}${m.timeoutMs ? `；單回逾時 ${m.timeoutMs} ms` : ''}；同時受測至多 ${m.concurrency} 個模型；同一模型連續 ${m.stopAfterFails} 回服務面失敗(逾時、執行錯誤)或判為限流即停測`)
    for (const line of role.report.criteria) lines.push(`- ${line}`)
    lines.push('')

    lines.push('## 逐模型分數', '')
    lines.push('| 模型 | 通過 | 一般案 | 保留案 | 合契約率 | 平均耗時(秒) | 呼叫失敗 | 停測 |')
    lines.push('|---|---|---|---|---|---|---|---|')
    for (const x of ranked(result.models)) {
        const kinds = BENCH_FAIL_COLUMNS.filter(([k]) => x.calls.byKind?.[k]).map(([k, n]) => `${n} ${x.calls.byKind[k]}`).join('、')
        lines.push(`| ${mdCell(x.model)} | ${x.score.pass}/${x.score.total} | ${x.general.pass}/${x.general.total} | ${x.holdout.pass}/${x.holdout.total} | ${x.contract.valid}/${x.contract.total}（${pct(x.contract.rate)}） | ${sec(x.avgMs) || '-'} | ${x.calls.failed}${kinds ? `（${kinds}）` : ''}${x.calls.notRun ? `；未呼叫 ${x.calls.notRun}` : ''} | ${mdCell(x.stopped || '-')} |`)
    }
    lines.push('')

    lines.push('## 逐案明細', '')
    const runHead = Array.from({ length: runs }, (_, k) => `第 ${k + 1} 回`)
    for (const x of result.models) {
        lines.push(`### ${x.model}`, '')
        lines.push(`| 案 | 題型 | 保留 | ${mdCols.map((col) => `${mdCell(col.name)} | `).join('')}應然 | ${runHead.join(' | ')} | 通過 |`)
        lines.push(`|---|---|---|${mdCols.map(() => '---|').join('')}---|${runHead.map(() => '---|').join('')}---|`)
        for (const c of x.cases) {
            const cells = Array.from({ length: runs }, (_, k) => mdCell(runText(role, c.runs[k])))
            lines.push(`| ${mdCell(c.id)} | ${mdCell(c.type || '-')} | ${c.holdout ? '是' : ''} | ${mdCols.map((col) => `${mdCell(c[col.key])} | `).join('')}${c.expect} | ${cells.join(' | ')} | ${c.pass ? '✓' : '✗'} |`)
        }
        lines.push('')
    }

    lines.push('## 未通過原因', '')
    let any = false
    for (const x of result.models) {
        const bad = x.cases.filter((c) => !c.pass)
        if (!bad.length) continue
        any = true
        lines.push(`### ${x.model}`, '')
        for (const c of bad) lines.push(`- ${c.id}${c.holdout ? '（保留）' : ''}〔應然 ${c.expect}；依據：${String(c.why || '').replace(/\r?\n/g, ' ')}〕：${String(c.note || '').replace(/\r?\n/g, ' ')}`)
        lines.push('')
    }
    if (!any) lines.push('（全數通過）', '')
    return lines.join('\n')
}

/**
 * 報表落檔:逐模型 CSV、逐案 CSV、Markdown 與原始結果 JSON;寫後回驗檔案存在
 *
 * @param {Object} result 輸入 runBench 之結果
 * @param {String} outDir 輸入輸出目錄(相對路徑以當下 cwd 解析;不存在即建立)
 * @param {Object} opt 輸入設定物件
 * @param {Object} opt.role 輸入角色(defineBenchRole 之產物)
 * @param {String} [opt.name] 輸入檔名主幹，未給為 <角色 id>-bench-<結果之時間戳>
 * @returns {Object} 回傳 { dir, files:{ modelsCsv, casesCsv, md, json } }(皆為絕對路徑)
 * @throws {Error} 角色不合、result 形狀不合、outDir 非字串，或寫入後檔案不存在時拋出
 * @example
 * let role = defineBenchRole({
 *     id: 'topic',
 *     name: '題目分類(topic)',
 *     expectOf: (c) => c.expect.label,
 *     domainOf: () => ({}),
 *     promptOf: (cases) => cases.map((c, i) => `${i + 1}. ${c.input.text}`).join('；'),
 *     verdictOf: (data) => ({ cls: data?.label ?? null, valid: true, problem: '', fields: {} }),
 * })
 * // 以替身調度層(不呼叫真實 AI)產生一份結果
 * let ai = { callJson: async () => ({ ok: true, data: { label: 'astro' }, error: '', providerId: 'stub', attempts: 1, skipped: false, errors: [] }) }
 * let cases = [{ id: 't1', input: { text: '黑洞光譜' }, expect: { label: 'astro' }, why: '天文題' }]
 * let result = await runBench(role, { models: ['m1'], cases, runs: 1, aiAdapter: ai })
 * let r = writeBenchReport(result, './bench-out', { role, name: 'demo' })
 * console.log(Object.keys(r.files), r.files.md.endsWith('demo.md'))
 * // => [ 'modelsCsv', 'casesCsv', 'md', 'json' ] true
 */
export function writeBenchReport(result, outDir, opt = {}) {
    if (!isobj(opt)) opt = {}
    const role = reportRoleOf(opt.role, 'writeBenchReport 之 opt.role')
    checkResult(result, role.runnerName)
    if (!isestr(outDir)) throw new Error('writeBenchReport 需要輸出目錄路徑字串')
    const dir = path.resolve(outDir)
    fs.mkdirSync(dir, { recursive: true })
    const base = isestr(opt.name) ? opt.name : `${role.id}-bench-${result.meta.stamp || 'result'}`
    const files = {
        modelsCsv: path.join(dir, `${base}-models.csv`),
        casesCsv: path.join(dir, `${base}-cases.csv`),
        md: path.join(dir, `${base}.md`),
        json: path.join(dir, `${base}.json`),
    }
    fs.writeFileSync(files.modelsCsv, benchModelsCsv(result, role), 'utf8')
    fs.writeFileSync(files.casesCsv, benchCasesCsv(result, role), 'utf8')
    fs.writeFileSync(files.md, benchMarkdown(result, role), 'utf8')
    fs.writeFileSync(files.json, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    for (const f of Object.values(files)) {
        if (!fs.existsSync(f)) throw new Error(`報表寫入後不存在：${f}`)
    }
    return { dir, files }
}

/** 評比表之表頭(版本以表頭本身為準:欄位變動即與舊表不相容;各角色同一表頭) */
export const BENCH_BOARD_HEADER = Object.freeze(['角色', '模型', '通過', '案數', '通過率', '一般案', '保留案', '合契約率', '平均耗時秒', '呼叫失敗',
    '失分案', 'AI 工作目錄', '題組', '每案回數', '提示詞指紋', '評比時間'])

/**
 * 解析 CSV(RFC 4180:引號包住之欄位可含逗號、引號、換行;去 BOM)
 *
 * @param {String} text 輸入 CSV 字串
 * @returns {Array} 回傳列陣列(各列為字串陣列;空行略過)
 */
function parseCsv(text) {
    const raw = String(text ?? '')
    const s = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw // 去 BOM
    const rows = []
    let row = []
    let cell = ''
    let quoted = false
    for (let i = 0; i < s.length; i++) {
        const ch = s[i]
        if (quoted) {
            if (ch === '"' && s[i + 1] === '"') {
                cell += '"'
                i++
            }
            else if (ch === '"') quoted = false
            else cell += ch
            continue
        }
        if (ch === '"') quoted = true
        else if (ch === ',') {
            row.push(cell)
            cell = ''
        }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && s[i + 1] === '\n') i++
            row.push(cell)
            if (row.some((c) => c !== '')) rows.push(row)
            row = []
            cell = ''
        }
        else cell += ch
    }
    row.push(cell)
    if (row.some((c) => c !== '')) rows.push(row)
    return rows
}

/**
 * 評比表「AI 工作目錄」欄之值:絕對路徑不入表(評比表隨套件發布,不得帶機器之磁碟機與使用者路徑)——在當下 cwd 之內者記相對路徑(正斜線),
 *   之外者記固定標示;相對路徑與空字串原樣
 *
 * @param {*} workspace 輸入本次 CLI 子行程之工作目錄
 * @returns {String} 回傳欄值
 * @example
 * console.log(boardWorkspaceOf(''), boardWorkspaceOf('out/ws'))
 * // =>  out/ws
 */
export function boardWorkspaceOf(workspace) {
    if (!isestr(workspace)) return ''
    if (!path.isAbsolute(workspace)) return workspace
    const rel = path.relative(process.cwd(), workspace)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/')
    return '（專案外之工作目錄）'
}

/**
 * 評比表:本次結果併入累積之評比表(一角色一模型一列;同角色同模型以本次覆蓋,其餘——含他角色之列——保留;停測或未完整者不寫)。
 *   列序:角色(碼元序)→ 通過數(多→少)→ 合契約率(高→低)→ 平均耗時(短→長)→ 模型(碼元序);寫檔為原子寫
 *
 * @param {String} file 輸入評比表路徑(相對路徑以當下 cwd 解析;不存在即新建)
 * @param {Object} result 輸入 runBench 之結果
 * @param {Object} opt 輸入設定物件
 * @param {Object|String} opt.role 輸入本結果之角色(defineBenchRole 之產物，或其顯示名字串)；「角色」欄取其 name
 * @param {String} [opt.workspace=''] 輸入本次 CLI 子行程之工作目錄(記入「AI 工作目錄」欄,經 boardWorkspaceOf:絕對路徑不入表;注入之調度層不知時給空字串)
 * @returns {Object} 回傳 { file(絕對路徑), written:Array(寫入之模型), replaced:Array(覆蓋舊列之模型), skipped:Array({ model, reason }), rows:Integer(表內總列數) }
 * @throws {Error} 角色未給或不合、result 形狀不合、file 非字串、既有檔之表頭與本版不同,或寫入後檔案不存在時拋出
 * @example
 * need test in nodejs.
 *
 * let r = mergeBenchBoard('./模型評比.csv', result, { role, workspace: './bench-out/ai-workspace' })
 * console.log(r.written, r.skipped)
 */
export function mergeBenchBoard(file, result, opt = {}) {
    if (!isobj(opt)) opt = {}
    const byName = isestr(opt.role)
    const role = opt.role === undefined || opt.role === null || byName ? null : reportRoleOf(opt.role, 'mergeBenchBoard 之 opt.role')
    checkResult(result, role ? role.runnerName : 'runBench')
    if (!isestr(file)) throw new Error('mergeBenchBoard 需要評比表路徑字串')
    const roleName = role ? role.name : (byName ? opt.role.trim() : '')
    if (!roleName) throw new Error('mergeBenchBoard 需要 opt.role（角色定義或其顯示名;評比表之「角色」欄）')
    const abs = path.resolve(file)
    const header = [...BENCH_BOARD_HEADER]
    let old = []
    if (fs.existsSync(abs)) {
        const [head, ...rest] = parseCsv(fs.readFileSync(abs, 'utf8'))
        if (!head || head.join(',') !== header.join(',')) {
            throw new Error(`評比表之表頭與本版不同，不覆寫：${abs}（本版：${header.join(',')}）`)
        }
        old = rest
    }
    const m = result.meta
    const skipped = []
    const fresh = []
    for (const x of result.models) {
        if (x.stopped || x.calls?.notRun > 0) {
            skipped.push({ model: x.model, reason: x.stopped || `未呼叫 ${x.calls.notRun} 回` })
            continue
        }
        fresh.push([roleName, x.model, x.score.pass, x.score.total, pct(x.score.rate), `${x.general.pass}/${x.general.total}`, `${x.holdout.pass}/${x.holdout.total}`,
            pct(x.contract.rate), sec(x.avgMs), x.calls.failed, x.cases.filter((c) => !c.pass).map((c) => c.id).join('、'),
            boardWorkspaceOf(opt.workspace), `${m.std || '-'} v${m.v ?? '-'}`, m.runs, m.promptFp, m.startedAt])
    }
    const key = (r) => `${r[0]}\t${r[1]}`
    const freshKeys = new Set(fresh.map(key))
    const replaced = old.filter((r) => freshKeys.has(key(r))).map((r) => r[1])
    const num = (v, dflt) => (Number.isFinite(Number.parseFloat(v)) ? Number.parseFloat(v) : dflt)
    const rows = [...old.filter((r) => !freshKeys.has(key(r))), ...fresh].sort((a, b) => cmp(String(a[0]), String(b[0])) ||
        (num(b[2], -1) - num(a[2], -1)) || (num(b[7], -1) - num(a[7], -1)) || (num(a[8], Infinity) - num(b[8], Infinity)) || cmp(String(a[1]), String(b[1])))
    writeFileAtomic(abs, toCsv(header, rows))
    if (!fs.existsSync(abs)) throw new Error(`評比表寫入後不存在：${abs}`)
    return { file: abs, written: fresh.map((r) => r[1]), replaced, skipped, rows: rows.length }
}

export default { benchModelsCsv, benchCasesCsv, benchMarkdown, writeBenchReport, mergeBenchBoard, BENCH_BOARD_HEADER, BENCH_FAIL_COLUMNS }
