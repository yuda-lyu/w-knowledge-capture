// stockLedger.mjs — 存量處置帳(JSONL)之讀寫協定(唯一一份;四工作之存量處置與宿主之連鎖處置寫同一本帳)
//
// 【一本帳】帳檔為 dirs.state 下之 STOCK_LEDGER_FILE(呼叫端可明給路徑);每列 { at, object, id, stds, before, … }(其餘欄位屬寫列之工作);
//   回退列 { at, rollbackOf:被回退列之 at, object, id }——讀帳據以排除已回退者(鍵 `at|object|id`)。各工作只讀「本工作之列」(keep 判定)。
// 【先寫入、即記帳、再回驗】寫列於每件寫入後立即附寫(中途中止亦留已寫者——回退依帳還原);目錄於首次寫入時建立(無列即不建)。
//   未給帳檔(空字串)者照收列於記憶體、不落檔(帳為選用之處置)。
// 【壞行即拒(fail-closed)】讀帳回報無法解析或非物件之列(行號與原因;含檔尾截斷——截斷之列其處置前之值已失,略過即無從還原、亦無人知道)。
//   各工作之讀帳(stockLedgerRowsOf)遇壞行即拋,呼叫端確認後明給 allowBad 才略過。
// 【時刻】since 以時刻比較(時區表示可不同;任一無法解析時依字面);at 取某次套用之列(字面相等:同一次套用之列 at 相同)。
// 【逐件錯誤列】預演、套用、回退逐件隔離,失敗之件記 { id, object, error } 而續處置他件——列之形狀與訊息之上限只在 stockErrorOf
//   (四工作與宿主同用;原各寫一份)。
// 【回退＝撤銷該次處置之效果(回退防護;rollbackPlanOf)】值列記該次處置所動之單位之處置前(before)與處置後(after)——處置前不存在之單位
//   不列於 before、處置後不存在者不列於 after(回退時刪除而非寫 null)。回退逐單位比現值:＝before → 已回到處置前(冪等);＝after → 寫回 before;
//   皆不是 → 其後被改動(衝突:不覆寫、不記回退列,該列仍列於帳;使用者明示「接受現值」者記取代列 { accepted:'current' }——appendRollbackRow 之 extra)。
//   記錄已不在者亦為衝突(不復活)。缺 after 之值列即拋(無從判定其後是否被改動)。待判之登錄列與結案列另見 core/stores/holds(登錄身分)。
// 【先記後寫之作廢列與 seq】先記帳列再寫入之工作(整份狀態之值列),寫入失敗即附寫作廢列(appendRollbackRow 之 extra { voided })使該列不再列於帳——同一次套用
//   (同 at)對同一物件可有多列(先記之列與其作廢、待判列與核心列),故寫列器可開 seq(opt.seq:true,每列 { at, seq, … }),回退列與作廢列帶
//   rollbackOfSeq 精確對應那一列;未開 seq 之工作維持 { at, object, id } 對應(列形狀不變)。

import path from 'path'
import isobj from 'wsemi/src/isobj.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import { strOf as s, sameValue } from '../util/values.mjs'
import { readJsonlRows, appendJsonlRow } from '../util/jsonl.mjs'

/**
 * 存量處置帳之檔名(dirs.state 下;四工作與宿主同一本帳)
 *
 * @type {String}
 */
export const STOCK_LEDGER_FILE = 'stock-fix.jsonl'

/**
 * 處置帳之路徑:opt.ledgerFile 優先,其次 deps.dirs.state 下之 STOCK_LEDGER_FILE
 *
 * @param {Object} deps 輸入依賴物件(讀 dirs.state)
 * @param {Object} opt 輸入設定物件(讀 ledgerFile)
 * @param {String} where 輸入呼叫處之名稱(錯誤訊息用)
 * @returns {String} 回傳處置帳路徑
 * @throws {Error} 兩者皆未給時拋出(寫入須可回退與稽核)
 * @example
 * console.log(stockLedgerFileOf({ dirs: { state: '/kb/state' } }, {}, 'apply').replace(/\\/g, '/'))
 * // => /kb/state/stock-fix.jsonl
 */
export function stockLedgerFileOf(deps, opt, where) {
    if (isestr(opt?.ledgerFile)) return opt.ledgerFile
    if (isestr(deps?.dirs?.state)) return path.join(deps.dirs.state, STOCK_LEDGER_FILE)
    throw new Error(`${where} 需要處置帳之路徑（opt.ledgerFile 或 deps.dirs.state）——寫入須記帳，否則無從回退與稽核`)
}

/**
 * 處置之時刻:opt.at 優先,其次 deps.clock.iso8(),再無則現在
 *
 * @param {Object} deps 輸入依賴物件(讀 clock.iso8)
 * @param {Object} opt 輸入設定物件(讀 at)
 * @returns {String} 回傳 ISO 時刻
 * @example
 * console.log(stockAtOf({}, { at: '2026-09-01T00:00:00Z' }), stockAtOf({ clock: { iso8: () => '2026-09-02T08:00:00+08:00' } }, {}))
 * // => 2026-09-01T00:00:00Z 2026-09-02T08:00:00+08:00
 */
export function stockAtOf(deps, opt) {
    return isestr(opt?.at) ? opt.at : (deps?.clock?.iso8?.() || new Date().toISOString())
}

/**
 * 兩個時刻之先後(以時刻比較;任一無法解析時依字面比較)
 *
 * @param {String} a 輸入時刻
 * @param {String} b 輸入時刻
 * @returns {Boolean} 回傳 a 是否不早於 b
 */
function notBefore(a, b) {
    const ta = Date.parse(a)
    const tb = Date.parse(b)
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta >= tb
    return a >= b
}

/**
 * 解析處置帳:未回退之處置列(回退列與已被回退者不列;keep 判定本工作之列;since／at 之篩選)與無法解析之列
 *
 * @param {String} file 輸入處置帳絕對路徑(不存在或非字串 → 無列)
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Function} [opt.keep] 輸入 (列) => Boolean,只留本工作之列(未給＝全部)
 * @param {String} [opt.since] 輸入只取此時刻起之列(以時刻比較)
 * @param {String} [opt.at] 輸入只取此時刻之列(某次套用;字面相等)
 * @returns {Object} 回傳 { rows:Array(依檔內順序), bad:[{ line:行號(1 起), error }] }
 * @example
 * import fs from 'fs'
 * let file = './state/demo-ledger.jsonl'
 * fs.rmSync(file, { force: true }) //先清掉舊檔,範例可重複執行
 * let { log } = stockLedgerWriter(file, '2026-09-01T00:00:00Z')
 * log({ object: 'doc', id: 'd1' })
 * log({ object: 'edge', id: 'e1' })
 * fs.appendFileSync(file, '{壞行\n')
 * let { rows, bad } = parseStockLedger(file, { keep: (r) => r.object === 'doc' })
 * console.log(rows, bad.map((b) => b.line))
 * // => [ { at: '2026-09-01T00:00:00Z', object: 'doc', id: 'd1' } ] [ 3 ]
 */
export function parseStockLedger(file, opt = {}) {
    if (!isobj(opt)) opt = {}
    if (!isestr(file)) return { rows: [], bad: [] }
    // 讀法為 JSONL 共用件(缺檔空、壞行逐行回報;讀取失敗拋)——壞行之處置(拒或略過)在本層
    const bad = []
    const all = readJsonlRows(file, { onBad: (b) => bad.push(b) })
    // 回退列(含作廢列、取代列)之對應:帶 rollbackOfSeq 者精確對應該 at 之第 seq 列;否則對應該 at 之同物件同 id 之列(檔頭【seq】)
    const undone = new Set(all.filter((r) => r.rollbackOf).map((r) => (Number.isInteger(r.rollbackOfSeq) ? `${r.rollbackOf}|#${r.rollbackOfSeq}` : `${r.rollbackOf}|${r.object}|${r.id}`)))
    const isUndone = (r) => undone.has(`${r.at}|${r.object}|${r.id}`) || (Number.isInteger(r.seq) && undone.has(`${r.at}|#${r.seq}`))
    const keep = isfun(opt.keep) ? opt.keep : () => true
    const rows = all.filter((r) => !r.rollbackOf && !isUndone(r) && keep(r) &&
        (!isestr(opt.since) || notBefore(s(r.at), opt.since)) && (!isestr(opt.at) || s(r.at) === opt.at))
    return { rows, bad }
}

/**
 * 處置帳有無法解析之列時所拋錯誤之 code(呼叫端據以提示其略過之開關;訊息另列行號)
 *
 * @type {String}
 */
export const STOCK_LEDGER_BAD_LINES = 'STOCK_LEDGER_BAD_LINES'

/**
 * 讀處置帳之列(parseStockLedger 之列);有無法解析之列即拋(fail-closed),opt.allowBad 為 true 才略過
 *
 * @param {String} file 輸入處置帳絕對路徑
 * @param {Object} [opt={}] 輸入設定物件(同 parseStockLedger 再加 allowBad)
 * @param {Function} [opt.keep] 輸入 (列) => Boolean,只留本工作之列(未給＝全部)
 * @param {String} [opt.since] 輸入只取此時刻起之列(以時刻比較)
 * @param {String} [opt.at] 輸入只取此時刻之列(某次套用;字面相等)
 * @param {Boolean} [opt.allowBad=false] 輸入是否略過無法解析之列(true 才略過;否則遇壞行即拋)
 * @returns {Array} 回傳列陣列(依檔內順序)
 * @throws {Error} 有無法解析之列而未給 allowBad 時拋出(訊息列行號;code 為 STOCK_LEDGER_BAD_LINES、bad 為無法解析之列)
 * @example
 * import fs from 'fs'
 * let file = './state/demo-ledger.jsonl'
 * fs.rmSync(file, { force: true }) //先清掉舊檔,範例可重複執行
 * let { log } = stockLedgerWriter(file, '2026-09-01T00:00:00Z')
 * log({ object: 'doc', id: 'd1' })
 * fs.appendFileSync(file, '{壞行\n')
 * try {
 *     stockLedgerRowsOf(file)
 * }
 * catch (e) {
 *     console.log(e.code, e.bad.length)
 * }
 * console.log(stockLedgerRowsOf(file, { allowBad: true }))
 * // => STOCK_LEDGER_BAD_LINES 1
 * // => [ { at: '2026-09-01T00:00:00Z', object: 'doc', id: 'd1' } ]
 */
export function stockLedgerRowsOf(file, opt = {}) {
    const { rows, bad } = parseStockLedger(file, opt)
    if (bad.length && opt?.allowBad !== true) {
        const e = new Error(`處置帳 ${file} 有 ${bad.length} 行無法解析（${bad.slice(0, 5).map((b) => `第 ${b.line} 行：${b.error}`).join('；')}）——截斷或手改之列其處置前之值不可得，回退與連鎖斷言須先處理（確認後以 allowBad 略過）`)
        e.code = STOCK_LEDGER_BAD_LINES
        e.bad = bad
        throw e
    }
    return rows
}

/**
 * 寫列器:每列 { at, ...列 } 立即附寫(首次寫入時建目錄);未給帳檔者只收於記憶體;opt.seq 開啟時每列另帶 seq(本次之序號,0 起——先記後寫之作廢列據以精確對應)
 *
 * @param {String} file 輸入處置帳絕對路徑(空字串＝不落檔)
 * @param {String} at 輸入本次處置之時刻
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Function} [opt.onRow] 輸入 (列)=>void,每寫一列即呼叫
 * @param {Boolean} [opt.seq=false] 輸入是否每列帶 seq(本次之序號,0 起)
 * @returns {Object} 回傳 { log:(列)=>列, rows:Array(本次寫之列) }
 * @example
 * let { log, rows } = stockLedgerWriter('', '2026-09-01T00:00:00Z', { seq: true })
 * log({ object: 'doc', id: 'd1' })
 * log({ object: 'doc', id: 'd2' })
 * console.log(rows)
 * // => [
 * // =>   { at: '2026-09-01T00:00:00Z', seq: 0, object: 'doc', id: 'd1' },
 * // =>   { at: '2026-09-01T00:00:00Z', seq: 1, object: 'doc', id: 'd2' }
 * // => ]
 */
export function stockLedgerWriter(file, at, opt = {}) {
    const rows = []
    let n = 0
    const log = (row) => {
        const r = opt?.seq === true ? { at, seq: n++, ...row } : { at, ...row }
        if (isestr(file)) appendJsonlRow(file, r)
        rows.push(r)
        if (isfun(opt?.onRow)) opt.onRow(r)
        return r
    }
    return { log, rows }
}

/**
 * 附寫回退列 { at, rollbackOf:被回退列之 at, rollbackOfSeq?(被回退列帶 seq 時), object, id, ...extra }(未給帳檔者不寫);extra 如接受現值之取代列
 *   { accepted:'current', units }、先記後寫之作廢列 { voided:'write-failed' }(檔頭【回退＝撤銷】【seq】)
 *
 * @param {String} file 輸入處置帳絕對路徑(空字串＝不寫)
 * @param {Object} r 輸入被回退之帳列
 * @param {String} at 輸入回退之時刻
 * @param {Object} [extra] 輸入附帶欄位(不覆寫 at、rollbackOf、rollbackOfSeq、object、id)
 * @returns {undefined} 無回傳值(未給帳檔者不寫)
 * @example
 * import fs from 'fs'
 * let file = './state/demo-ledger.jsonl'
 * fs.rmSync(file, { force: true }) //先清掉舊檔,範例可重複執行
 * let { log } = stockLedgerWriter(file, '2026-09-01T00:00:00Z')
 * let row = log({ object: 'doc', id: 'd1', stds: ['S1'], before: { status: 'noted' }, after: { status: 'skip' } })
 * console.log(stockLedgerRowsOf(file).length)
 * appendRollbackRow(file, row, '2026-09-02T00:00:00Z')
 * console.log(stockLedgerRowsOf(file).length)
 * // => 1
 * // => 0
 */
export function appendRollbackRow(file, r, at, extra) {
    if (!isestr(file)) return
    appendJsonlRow(file, { ...(isobj(extra) ? extra : {}), at, rollbackOf: r.at, ...(Number.isInteger(r.seq) ? { rollbackOfSeq: r.seq } : {}), object: r.object, id: r.id })
}

/**
 * 回退防護之逐單位計畫(檔頭【回退＝撤銷該次處置之效果】):帳列之 before／after 之聯集為該次處置所動之單位,逐單位比現值——
 *   ＝before(含「處置前不存在」而現亦不存在)→ done;＝after → restore;皆不是 → conflict(其後被改動)。值之比較為正規化比較(sameValue)
 *
 * @param {Object|null} cur 輸入現值(以單位為鍵之物件;null＝記錄不在——各單位依其 before 判)
 * @param {Object} row 輸入帳列(取 before、after;皆以單位為鍵)
 * @returns {Object} 回傳 { restore:Array(單位), done:Array, conflict:Array }
 * @throws {Error} 帳列缺 after(非物件)時拋出——無從判定其後是否被改動
 * @example
 * const row = { before: { status: 'noted' }, after: { status: 'skip', dupOf: 'd1' } }
 * console.log(rollbackPlanOf({ status: 'skip', dupOf: 'd1' }, row), rollbackPlanOf({ status: 'noted' }, row).done, rollbackPlanOf({ status: 'gone', dupOf: 'd1' }, row).conflict)
 * // => { restore: [ 'status', 'dupOf' ], done: [], conflict: [] } [ 'status', 'dupOf' ] [ 'status' ]
 */
export function rollbackPlanOf(cur, row) {
    if (!isobj(row?.after)) throw new Error('帳列缺 after（處置後之值），無從判定其後是否被改動')
    const before = isobj(row.before) ? row.before : {}
    const after = row.after
    const has = (o, k) => isobj(o) && Object.hasOwn(o, k) && o[k] !== undefined
    const same = (a, b, k) => has(a, k) === has(b, k) && (!has(a, k) || sameValue(a[k], b[k]))
    const out = { restore: [], done: [], conflict: [] }
    for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])]) {
        if (same(cur, before, k)) out.done.push(k)
        else if (same(cur, after, k)) out.restore.push(k)
        else out.conflict.push(k)
    }
    return out
}

/**
 * 回退之寫回(扁平記錄):給定之單位寫回 before;處置前不存在者列 unset(刪除——而非寫 null)
 *
 * @param {Object} row 輸入帳列(取 before)
 * @param {Array} units 輸入要寫回之單位(rollbackPlanOf 之 restore)
 * @returns {Object} 回傳 { patch:Object(單位 → before 之值), unset:Array(處置前不存在之單位) }
 * @example
 * console.log(rollbackWriteOf({ before: { status: 'noted' }, after: { status: 'skip', dupOf: 'd1' } }, ['status', 'dupOf']))
 * // => { patch: { status: 'noted' }, unset: [ 'dupOf' ] }
 */
export function rollbackWriteOf(row, units) {
    const before = isobj(row?.before) ? row.before : {}
    const patch = {}
    const unset = []
    for (const k of Array.isArray(units) ? units : []) {
        if (Object.hasOwn(before, k) && before[k] !== undefined) patch[k] = before[k]
        else unset.push(k)
    }
    return { patch, unset }
}

/** 逐件錯誤列之訊息上限(字元;前綴不計) */
const STOCK_ERROR_MAX = 200

/**
 * 存量處置之逐件錯誤列(預演、套用、回退之 errors 同形;見檔頭【逐件錯誤列】)
 *
 * @param {*} id 輸入物件 id(轉字串)
 * @param {*} object 輸入物件種類(轉字串)
 * @param {*} e 輸入所拋之錯誤(取其 message;非錯誤物件者訊息為空)
 * @param {String} [prefix=''] 輸入訊息之前綴(如出錯之回呼名;不計入上限)
 * @returns {Object} 回傳 { id, object, error(前綴＋訊息之前 200 字) }
 * @example
 * console.log(stockErrorOf('d1', 'doc', new Error('寫入失敗')), stockErrorOf(null, 'edge', new Error('x'), 'onEdgeFixed：').error)
 * // => { id: 'd1', object: 'doc', error: '寫入失敗' } onEdgeFixed：x
 */
export function stockErrorOf(id, object, e, prefix = '') {
    return { id: s(id), object: s(object), error: `${s(prefix)}${s(e?.message).slice(0, STOCK_ERROR_MAX)}` }
}

/**
 * 回退之寫入(扁平記錄;集合之 patch／replace):無須刪鍵者 patch(單次原子寫入);須刪鍵者以 replace 寫整筆(集合之 patch 為深合併、刪不了鍵;
 *   replace 之原子性屬集合之實作)
 *
 * @param {Object} store 輸入集合(具 patch、replace)
 * @param {Object} cur 輸入現值記錄(含 id)
 * @param {Object} w 輸入 rollbackWriteOf 之產物
 * @param {Object} w.patch 輸入要寫回之欄位值(單位 → before 之值)
 * @param {Array} w.unset 輸入要刪除之欄位名(處置前不存在者)
 * @returns {Promise} 回傳 Promise，resolve 無回傳值(patch 與 unset 皆空則不寫)
 * @example
 * let calls = []
 * let store = { patch: async (id, p) => { calls.push(['patch', id, p]) }, replace: async (r) => { calls.push(['replace', r]) } }
 * let cur = { id: 'd1', status: 'skip', dupOf: 'd0' }
 * await writeRollback(store, cur, { patch: { status: 'noted' }, unset: ['dupOf'] })
 * await writeRollback(store, cur, { patch: { status: 'noted' }, unset: [] })
 * console.log(calls)
 * // => [
 * // =>   [ 'replace', { id: 'd1', status: 'noted' } ],
 * // =>   [ 'patch', 'd1', { status: 'noted' } ]
 * // => ]
 */
export async function writeRollback(store, cur, w) {
    if (w.unset.length) await store.replace(Object.fromEntries(Object.entries({ ...cur, ...w.patch }).filter(([k]) => !w.unset.includes(k))))
    else if (Object.keys(w.patch).length) await store.patch(cur.id, w.patch)
}

export default { STOCK_LEDGER_FILE, STOCK_LEDGER_BAD_LINES, stockLedgerFileOf, stockAtOf, parseStockLedger, stockLedgerRowsOf, stockLedgerWriter, appendRollbackRow, rollbackPlanOf, rollbackWriteOf, writeRollback, stockErrorOf }
