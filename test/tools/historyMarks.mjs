// historyMarks.mjs — 舊名與沿革、面向使用者之字樣之判準與掃描(四套件之守門同一份;不帶 .test. 中綴)
//
// 【為何一份】套件只寫現行之規則與理由,沿革在版本紀錄(git 歷史);各套件之守門各寫一份判準時,範圍與嚴寬即悄悄分歧(有的只掃兩層、有的不掃日期、
//   有的把範例資料之日期誤判)。抓取套件之測試直接取本檔,摘要、關聯、提煉之測試經各自之 test/tools/captureForTest.mjs 取用;各套件只給
//   自身之舊名(old)與自身較嚴之加項(extra——如不以「終審」為工作流棒名之套件另禁裸寫之「終審」),判準不放寬。
// 【兩類】①HISTORY_MARKS:原始碼(含註解)、README、package.json 之逐行——暫存路徑、帶日期之沿革、帳本與審查之代號、「此前」敘事;
//   ②USER_TEXT_MARKS:面向使用者之字樣(原始碼之字串字面與 README)——規則帳本之代號;各套件另給其執行端之指令名(cli)與他工作之名(otherJobs)。
// 【執行端之指令】HOST_CLI＝宿主(安裝端)之命令列與工具之名:套件之字樣一律指本套件之 API 與選項,不指宿主之指令(四套件同一份;各套件另加
//   自己之子命令與旗標)。
// 【具名例外】allow:[{ file, mark, token, why }]——該檔之行(或字串)含 token,且去掉 token 後該類即不再命中,才免該類(同行之他類照判);
//   未用到之例外列為違反(例外過時即須移除)。
// 【資料契約之名】contractNames(如 md 版型之章名):原始碼行中以引號整個包住之名先去掉再判、字串字面整串相等者不判——名本身是資料契約,
//   不是指稱他工作。
// 【題組檔】bench/cases/*.json 只掃說明文字(頂層 note 與各案之 why;benchCaseNotesOf):材料(input)與應然(expect)是題材,可含任何字
//   (「程式碼審查」「SHA-256」),沿革只會寫在說明。

import isarr from 'wsemi/src/isarr.mjs'

/**
 * 宿主(安裝端)之命令列與工具之名(面向使用者之字樣不得指向;四套件同一份)
 *
 * @type {RegExp}
 */
export const HOST_CLI = /src\/tools|npm run|standards\s+(?:audit|holds|fix|retry|waive)|--with-holds|notes\s*工具/

/** 帳本之代號(沿革與面向使用者之字樣共用;代號後接數字即命中) */
const LEDGER_CODE = /\b(?:GEN|CORE|CAP|CAPX|AI|SUM|REL|EXT|STD|OPS)-\d|規則帳本/

/**
 * 沿革之指標(逐行;範例資料之日期與時刻、工作目錄下之 tmp、測試暫存之 _tmp、ISO 時刻不誤判)
 *
 * @type {Array}
 */
export const HISTORY_MARKS = Object.freeze([
    ['暫存路徑', /(?<![\w/.:$}-])tmp\//],
    ['日期', /(?<!['"`\w-])20\d\d-\d\d-\d\d(?![\dT])/],
    ['帳本／審查代號', new RegExp(`${LEDGER_CODE.source}|三審|審查|盤查|終審\\.md|CLAUDE_|\\bopus[AB]?\\b|主代理|方案 v\\d`)],
    ['此前敘事', /此前/],
])

/**
 * 面向使用者之字樣中不得出現之帳本代號(各套件之 cli、otherJobs 另給)
 *
 * @type {Array}
 */
export const USER_TEXT_MARKS = Object.freeze([
    ['規則帳本代號', LEDGER_CODE],
])

/**
 * 去掉原始碼行中以引號整個包住之資料契約之名
 *
 * @param {String} line 輸入一行
 * @param {Array} names 輸入資料契約之名
 * @returns {String} 回傳去掉後之行
 */
function withoutContractNames(line, names) {
    let l = line
    for (const n of isarr(names) ? names : []) for (const q of ["'", '"', '`']) l = l.split(`${q}${n}${q}`).join(' ')
    return l
}

/**
 * 一行之舊名與沿革之命中
 *
 * @param {String} line 輸入一行
 * @param {Object} [o={}] 輸入 { old:RegExp(本套件之舊名;未給不判), extra:Array([名, RegExp];本套件較嚴之加項), contractNames:Array(資料契約之名) }
 * @returns {Array} 回傳命中之類名(依「舊名」、HISTORY_MARKS、extra 之序;不重複)
 * @example
 * console.log(historyHitsOf('(2026-10-06 抓取邊界盤查 C1)'), historyHitsOf("collectedAt: '2026-09-01'"))
 * // => [ '日期', '帳本／審查代號' ] []
 */
export function historyHitsOf(line, o = {}) {
    const l = withoutContractNames(String(line ?? ''), o.contractNames)
    const out = []
    if (o.old instanceof RegExp && o.old.test(l)) out.push('舊名')
    for (const [name, re] of [...HISTORY_MARKS, ...(isarr(o.extra) ? o.extra : [])]) if (re.test(l) && !out.includes(name)) out.push(name)
    return out
}

/**
 * 一則面向使用者之字樣之命中
 *
 * @param {String} text 輸入字樣(字串字面或 README)
 * @param {Object} [o={}] 輸入 { cli:RegExp(本套件之執行端之指令名), otherJobs:RegExp(他工作之名;未給不判), extra:Array([名, RegExp];本套件較嚴之加項),
 *   contractNames:Array(資料契約之名;整串相等者不判) }
 * @returns {Array} 回傳命中之類名
 * @example
 * console.log(userTextHitsOf('見 STD-06 與 notes 工具', { cli: HOST_CLI }), userTextHitsOf('關聯', { otherJobs: /關聯/, contractNames: ['關聯'] }))
 * // => [ '執行端之指令', '規則帳本代號' ] []
 */
export function userTextHitsOf(text, o = {}) {
    const s = String(text ?? '')
    if (isarr(o.contractNames) && o.contractNames.includes(s)) return []
    const out = []
    if (o.cli instanceof RegExp && o.cli.test(s)) out.push('執行端之指令')
    if (o.otherJobs instanceof RegExp && o.otherJobs.test(s)) out.push('他工作')
    for (const [name, re] of [...USER_TEXT_MARKS, ...(isarr(o.extra) ? o.extra : [])]) if (re.test(s) && !out.includes(name)) out.push(name)
    return out
}

/**
 * 套用具名例外:該檔之文字含 token、且去掉 token 後該類不再命中者免該類(記下用到之例外)
 *
 * @param {String} file 輸入檔名
 * @param {String} text 輸入一行或一則字樣
 * @param {Array} hits 輸入命中之類名
 * @param {Array} allow 輸入具名例外
 * @param {Set} used 輸入用到之例外之序(就地加入)
 * @param {Function} hitsOf 輸入 (文字) => 命中之類名
 * @returns {Array} 回傳免去後之類名
 */
function keepHits(file, text, hits, allow, used, hitsOf) {
    let rest = hits
    allow.forEach((a, i) => {
        if (a.file !== file || !rest.includes(a.mark) || !text.includes(a.token)) return
        if (hitsOf(text.split(a.token).join(' ')).includes(a.mark)) return
        rest = rest.filter((n) => n !== a.mark)
        used.add(i)
    })
    return rest
}

/**
 * 未用到之具名例外(過時即須移除)
 *
 * @param {Array} allow 輸入具名例外
 * @param {Set} used 輸入用到之例外之序
 * @returns {Array} 回傳違反之說明
 */
function unusedAllowOf(allow, used) {
    return allow.filter((_, i) => !used.has(i)).map((a) => `具名例外未用到(過時即須移除):${a.file}〔${a.mark}〕${a.token}`)
}

/**
 * 多份文字之舊名與沿革之逐行掃描
 *
 * @param {Array} files 輸入 [{ file, text }]
 * @param {Object} [o={}] 輸入同 historyHitsOf,另 allow:Array(具名例外 { file, mark, token, why })
 * @returns {Array} 回傳違反「檔:行〔類名、…〕該行」之陣列(含未用到之具名例外)
 */
export function historyScanOf(files, o = {}) {
    const allow = isarr(o.allow) ? o.allow : []
    const used = new Set()
    const hitsOf = (t) => historyHitsOf(t, o)
    const bad = []
    for (const { file, text } of files) {
        String(text ?? '').split('\n').forEach((l, i) => {
            const h = keepHits(file, l, hitsOf(l), allow, used, hitsOf)
            if (h.length) bad.push(`${file}:${i + 1}〔${h.join('、')}〕${l.trim().slice(0, 100)}`)
        })
    }
    return [...bad, ...unusedAllowOf(allow, used)]
}

/**
 * 題組檔之說明文字(交 historyScanOf 逐行掃):頂層 note 與各案之 why——材料與應然不在內;非 JSON 或非題組形狀者回空(形狀由各角色之
 *   validateBenchCases 另驗)
 *
 * @param {String} file 輸入題組檔之相對路徑
 * @param {String} text 輸入 JSON 原文
 * @returns {Array} 回傳 [{ file:`<檔>#note`|`<檔>#<案 id>.why`, text }]
 * @example
 * console.log(benchCaseNotesOf('bench/cases/x.json', '{"note":"說明","cases":[{"id":"a","why":"理由","input":{"text":"此前"}}]}'))
 * // => [ { file: 'bench/cases/x.json#note', text: '說明' }, { file: 'bench/cases/x.json#a.why', text: '理由' } ]
 */
export function benchCaseNotesOf(file, text) {
    let j = null
    try {
        j = JSON.parse(String(text ?? ''))
    }
    catch {
        return []
    }
    const set = isarr(j) ? { cases: j } : j
    if (!set || typeof set !== 'object') return []
    const out = []
    if (typeof set.note === 'string') out.push({ file: `${file}#note`, text: set.note })
    for (const c of isarr(set.cases) ? set.cases : []) if (c && typeof c.why === 'string') out.push({ file: `${file}#${String(c.id ?? '?')}.why`, text: c.why })
    return out
}

/**
 * 多份面向使用者之字樣之掃描
 *
 * @param {Array} docs 輸入 [{ file, strings:Array(該檔之字串字面;README 給全文一則) }]
 * @param {Object} [o={}] 輸入同 userTextHitsOf,另 allow:Array(具名例外 { file, mark, token, why })
 * @returns {Array} 回傳違反「檔〔類名、…〕字樣」之陣列(含未用到之具名例外)
 */
export function userTextScanOf(docs, o = {}) {
    const allow = isarr(o.allow) ? o.allow : []
    const used = new Set()
    const hitsOf = (t) => userTextHitsOf(t, o)
    const bad = []
    for (const { file, strings } of docs) {
        for (const s of isarr(strings) ? strings : []) {
            const h = keepHits(file, String(s ?? ''), hitsOf(s), allow, used, hitsOf)
            if (h.length) bad.push(`${file}〔${h.join('、')}〕${String(s).replace(/\u0000/g, '…').replace(/\s+/g, ' ').slice(0, 90)}`)
        }
    }
    return [...bad, ...unusedAllowOf(allow, used)]
}

export default { HOST_CLI, HISTORY_MARKS, USER_TEXT_MARKS, historyHitsOf, userTextHitsOf, historyScanOf, userTextScanOf, benchCaseNotesOf }
