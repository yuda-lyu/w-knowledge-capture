// rejects.mjs — 剔除清單與待辦總表(唯讀匯出):逐筆列出被剔除／停用／失敗之對象、原因、時間,並彙整尚未處理之數量
//
// 【為何在套件根】跨讀文件、來源、線索、領域與原文回溯帳五類物件(各取 stores／ops 之純函數),不屬任一子階段;
//   執行端之 CLI 只是薄殼(開庫、解參數、寫檔)。
// 【只讀結構化欄位】類別(class)取自各記錄之結構化欄位——文件 dead 之 deadClass／lastClass、skip 之 skipKind、status;來源之 enabled／paused;
//   線索與領域之 status;回溯帳之 outcome。不解析 lastError／skipReason 等訊息文字;缺欄之記錄歸 'unclassified'(未分類),不猜——
//   猜錯之類別會讓「為何被剔除」之統計失真。
// 【列與計數】一個對象一列 { object, id, url, label, status, class, reason, detail, at, extra };counts 以 `物件:狀態:類別` 為鍵,
//   計全部符合篩選者(不受 limit 影響,limit 只截斷 rows);待辦總表(pending)不受篩選影響,只依所選物件決定要算哪些。
//   列依決定時刻(at)新到舊排序,無 at 者排後;同時刻依物件順序、id 定序(輸出可重現)。
// 【純讀】只呼叫集合之 select 與讀回溯帳檔;不呼叫 patch／insertNew／replace／del,不寫任何檔案(含不建立回溯帳)。
// 【能證明／不能證明】
//   能證明:各物件「此刻」落地之剔除狀態,與當時記下之原因及決定時刻;待辦之積壓量與最舊天數(以 nowMs 為基準)。
//   不能證明:原因之真偽(原因為當時之管線所記,缺欄之記錄無從得知);無決定時刻(at 空)之記錄(彙整貼文、摘要失敗、暫停之來源等)
//   不參與 since 篩選(給 since 即排除);回溯帳為 append-only,同一文件只取最後一行(歷次嘗試不列);無網址之物件(領域、關鍵詞線索)
//   不參與 host 篩選(給 host 即排除)。

import isarr from 'wsemi/src/isarr.mjs'
import isobj from 'wsemi/src/isobj.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import { queueAge } from './core/util/queueAge.mjs'
import { strOf as str, cmp } from './core/util/values.mjs'
import { readJsonlRows } from './core/util/jsonl.mjs'
import { toCsv, mdCell } from './core/util/table.mjs'
import { inBackoff, docQueueStatsOf } from './core/stores/docPolicy.mjs'
import { browserQueueOn } from './stores/fetchPolicy.mjs'
import { deadMatcher } from './ops/reviveDocs.mjs'
import { AREA_META_ID } from './stores/areaPolicy.mjs'

/** 可匯出之物件:docs(文件)、sources(來源)、clues(待探索線索;集合名 frontier)、areas(領域)、refetch(原文回溯帳之未成功者) */
export const REJECT_OBJECTS = Object.freeze(['docs', 'sources', 'clues', 'areas', 'refetch'])

/** 待辦表:線索之已知狀態(缺者以 0 列出——待辦表不得因「沒有這一行」而被讀成沒有此狀態) */
const CLUE_STATUSES = ['pending', 'done', 'failed', 'evicted']

/** 逐列欄位(CSV 欄序) */
const COLS = ['object', 'id', 'url', 'label', 'status', 'class', 'reason', 'detail', 'at', 'extra']

/**
 * 逗號字串或陣列 → 去空白、去空項之字串陣列(無有效項回 null,即「不篩選」)
 *
 * @param {*} v 輸入陣列或逗號分隔字串
 * @returns {Array|null} 回傳字串陣列或 null
 */
function listOf(v) {
    const a = isarr(v) ? v : (isestr(v) ? v.split(',') : [])
    const out = a.map((x) => str(x).trim()).filter(Boolean)
    return out.length ? out : null
}

/**
 * 取來源物件之指定欄(略過 undefined、null、空字串;0 與 false 是有意義之值,保留)
 *
 * @param {Object} src 輸入來源物件
 * @param {Array} keys 輸入欄名陣列
 * @returns {Object} 回傳新物件
 */
function extraOf(src, keys) {
    const out = {}
    for (const k of keys) {
        const v = src[k]
        if (v !== undefined && v !== null && v !== '') out[k] = v
    }
    return out
}

/**
 * 記錄之剔除類別(只讀結構化欄位,不解析 lastError／skipReason 等訊息文字;不屬剔除者回空字串)
 *
 * 各物件之類別:
 *   docs:dead → deadClass(有則用)→ lastClass → 'unclassified'(未分類);skip → skipKind → 'unclassified';
 *     aggregated → 'aggregated';summarize-failed → 'summarize-failed';其餘狀態(new／raw／noted)不屬剔除
 *   sources:enabled 為 false → 'source-disabled';paused 為 true → 'source-paused'(兩者並存取前者)
 *   clues:status failed／evicted → 'clue-failed'／'clue-evicted'
 *   areas:status rejected／paused／retired → 'area-rejected'／'area-paused'／'area-retired'
 *   refetch(回溯帳某文件之最後一行):'refetch-' + outcome(archived 為成功,不屬剔除)
 *
 * @param {Object} row 輸入記錄(集合之一筆,或回溯帳之一行)
 * @param {String} object 輸入物件種類,REJECT_OBJECTS 之一
 * @returns {String} 回傳類別字串;記錄不屬剔除者回空字串
 * @throws {Error} object 不在 REJECT_OBJECTS 時拋出
 * @example
 * console.log(rejectClassOf({ status: 'dead', deadClass: 'http-final', lastClass: 'render' }, 'docs'))
 * // => http-final
 *
 * console.log(rejectClassOf({ status: 'dead' }, 'docs'))
 * // => unclassified
 *
 * console.log(rejectClassOf({ outcome: 'archived' }, 'refetch') === '')
 * // => true
 */
export function rejectClassOf(row, object) {

    //check
    if (!REJECT_OBJECTS.includes(object)) {
        throw new Error(`rejectClassOf 未知物件「${str(object)}」（可用：${REJECT_OBJECTS.join('、')}）`)
    }
    if (!isobj(row)) {
        return ''
    }

    if (object === 'docs') {
        if (row.status === 'dead') {
            if (isestr(row.deadClass)) return row.deadClass
            return isestr(row.lastClass) ? row.lastClass : 'unclassified'
        }
        if (row.status === 'skip') return isestr(row.skipKind) ? row.skipKind : 'unclassified'
        if (row.status === 'aggregated') return 'aggregated'
        if (row.status === 'summarize-failed') return 'summarize-failed'
        return ''
    }
    if (object === 'sources') {
        if (row.enabled === false) return 'source-disabled'
        return row.paused === true ? 'source-paused' : ''
    }
    if (object === 'clues') {
        return row.status === 'failed' || row.status === 'evicted' ? `clue-${row.status}` : ''
    }
    if (object === 'areas') {
        return ['rejected', 'paused', 'retired'].includes(row.status) ? `area-${row.status}` : ''
    }
    // refetch
    return isestr(row.outcome) && row.outcome !== 'archived' ? `refetch-${row.outcome}` : ''
}

/**
 * 文件 → 剔除列(不屬剔除者回 null)
 *
 * @param {Object} d 輸入文件記錄
 * @param {Function} statusOfDoc 輸入 (docId) => 該文件之狀態字串,查無回 'missing'(重複件帶出錨之狀態)
 * @returns {Object|null} 回傳剔除列或 null
 */
function docRowOf(d, statusOfDoc) {
    const cls = rejectClassOf(d, 'docs')
    if (!cls) return null
    const base = { object: 'docs', id: str(d.id), url: str(d.url), label: str(d.title), status: str(d.status), class: cls }
    if (d.status === 'dead') {
        return { ...base, reason: str(d.lastReason), detail: str(d.lastError), at: str(d.deadAt), extra: extraOf(d, ['httpCode', 'deadBy', 'fetchTries', 'fetchChainFails', 'sourceName']) }
    }
    if (d.status === 'skip') {
        const extra = isestr(d.dupOf) ? { dupOf: d.dupOf, dupOfStatus: statusOfDoc(d.dupOf) } : {}
        return { ...base, reason: str(d.skipReason), detail: '', at: str(d.notedAt), extra }
    }
    if (d.status === 'aggregated') {
        return { ...base, reason: '彙整貼文（已轉錄連結）', detail: '', at: '', extra: extraOf(d, ['linkCount']) }
    }
    // summarize-failed
    return { ...base, reason: '', detail: str(d.lastError), at: '', extra: {} }
}

/**
 * 來源 → 剔除列(不屬剔除者回 null)。停用與暫停並存者列為停用(extra.paused 註記)
 *
 * @param {Object} s 輸入來源記錄
 * @returns {Object|null} 回傳剔除列或 null
 */
function sourceRowOf(s) {
    const cls = rejectClassOf(s, 'sources')
    if (!cls) return null
    const disabled = s.enabled === false
    return {
        object: 'sources',
        id: str(s.id),
        url: str(s.url),
        label: str(s.name),
        status: disabled ? 'disabled' : 'paused',
        class: cls,
        // 暫停之原因取記錄之 pauseReason(種子同步／領域暫停所寫);未記者以固定字樣
        reason: disabled ? str(s.disableReason) : (str(s.pauseReason) || '領域暫停／種子移除'),
        detail: str(s.lastError),
        at: str(s.disabledAt),
        extra: { ...extraOf(s, ['failCount', 'chainFails', 'kind']), ...(disabled && s.paused === true ? { paused: true } : {}) },
    }
}

/**
 * 待探索線索 → 剔除列(不屬剔除者回 null)。淘汰者之原因為上限淘汰(曾有之 lastError 屬更早之失敗,記於 detail,不當作淘汰之原因)
 *
 * @param {Object} c 輸入線索記錄
 * @returns {Object|null} 回傳剔除列或 null
 */
function clueRowOf(c) {
    const cls = rejectClassOf(c, 'clues')
    if (!cls) return null
    const failed = c.status === 'failed'
    return {
        object: 'clues',
        id: str(c.id),
        url: c.type === 'site' ? str(c.value) : '',
        label: `${str(c.type)}:${str(c.value)}`,
        status: str(c.status),
        class: cls,
        reason: failed ? str(c.lastError) : '逾待探索上限而淘汰（再被提及即復活）',
        detail: failed ? '' : str(c.lastError),
        at: str(failed ? c.failedAt : c.evictedAt),
        extra: extraOf(c, ['tries', 'chainFails', 'hits']),
    }
}

/**
 * 領域 → 剔除列(中繼記錄與不屬剔除者回 null)
 *
 * @param {Object} a 輸入領域記錄
 * @returns {Object|null} 回傳剔除列或 null
 */
function areaRowOf(a) {
    if (str(a?.id).startsWith(AREA_META_ID)) return null
    const cls = rejectClassOf(a, 'areas')
    if (!cls) return null
    return {
        object: 'areas',
        id: str(a.id),
        url: '',
        label: str(a.label),
        status: str(a.status),
        class: cls,
        reason: str(a.reason),
        detail: '',
        at: str(a.status === 'paused' ? (a.pausedAt || a.updatedAt) : a.updatedAt),
        extra: extraOf(a, ['query', 'statusBy']),
    }
}

/**
 * 回溯帳之最後結論 → 剔除列(archived 與無結論者回 null)
 *
 * @param {Object} r 輸入回溯帳之一行(同一文件之最後一行)
 * @param {Object} [doc] 輸入該文件之記錄(帶出網址與標題;查無則留空)
 * @returns {Object|null} 回傳剔除列或 null
 */
function refetchRowOf(r, doc) {
    const cls = rejectClassOf(r, 'refetch')
    if (!cls) return null
    return { object: 'refetch', id: str(r.id), url: str(doc?.url), label: str(doc?.title), status: str(r.outcome), class: cls, reason: str(r.outcome), detail: str(r.why), at: str(r.at), extra: extraOf(r, ['method']) }
}

/**
 * 讀回溯帳(JSONL;append-only):同一 id 取最後一行,壞行(非 JSON、非物件、無 id)略過;檔案不存在回空表
 *
 * @param {String} file 輸入回溯帳絕對路徑
 * @returns {Map} 回傳 id → 最後一行之物件
 */
function readLedgerLast(file) {
    const last = new Map()
    if (!isestr(file)) return last
    for (const r of readJsonlRows(file)) if (isestr(r.id)) last.set(r.id, r)
    return last
}

/**
 * 主機篩選輸入之正規化(小寫;去協定、路徑、前導「*.」或「.」)
 *
 * @param {*} h 輸入主機名或網址
 * @returns {String} 回傳主機名(無效回空字串)
 */
function hostOf(h) {
    let s = str(h).trim().toLowerCase()
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
        try {
            s = new URL(s).hostname
        }
        catch { /* 維持原樣,下面再清 */ }
    }
    return s.replace(/\/.*$/, '').replace(/^\*?\.+/, '')
}

/**
 * 待辦:文件(new 之組成、raw、摘要失敗、段落鍵無原文)
 *
 * @param {Array} docs 輸入全部文件
 * @param {Number} nowMs 輸入現在時刻毫秒(退避判斷與最舊天數之基準)
 * @param {Boolean} browserOn 輸入瀏覽器佇列是否開啟(停用時指名瀏覽器之件併回補全文佇列計)
 * @returns {Object} 回傳 { new:{ total, browser, backoff, untried, retry }, raw, summarizeFailed:{ count }, paraKeysNoText:{ count } };
 *   各 { count, oldestDays }——new 之組成取 core/stores/docPolicy 之 docQueueStatsOf(補全文段與外部巡檢同一分法);raw 以 rawAt 計最舊天數
 */
function pendingDocsOf(docs, nowMs, browserOn) {
    const qs = docQueueStatsOf(docs, { nowMs, browserOn })
    return {
        new: { total: qs.total, browser: qs.browser, backoff: qs.backoff, untried: qs.untried, retry: qs.retry },
        raw: queueAge(docs.filter((d) => d.status === 'raw'), 'rawAt', nowMs),
        summarizeFailed: { count: docs.filter((d) => d.status === 'summarize-failed').length },
        paraKeysNoText: { count: docs.filter((d) => d.status === 'noted' && d.paraKeysNoText).length },
    }
}

/**
 * 待辦:線索(各 status 計數;pending 中退避中者)
 *
 * @param {Array} clues 輸入全部線索
 * @param {Number} nowMs 輸入現在時刻毫秒
 * @returns {Object} 回傳 { total, byStatus:{ pending, done, failed, evicted, …其他出現之狀態 }, backoff }
 */
function pendingCluesOf(clues, nowMs) {
    const byStatus = Object.fromEntries(CLUE_STATUSES.map((k) => [k, 0]))
    for (const c of clues) {
        const k = str(c.status) || '(空)'
        byStatus[k] = (byStatus[k] || 0) + 1
    }
    const backoff = clues.filter((c) => c.status === 'pending' && inBackoff(c, nowMs)).length
    return { total: clues.length, byStatus, backoff }
}

/**
 * 待辦:來源(啟用、停用、暫停;三者各依旗標獨立計,停用且暫停者兩邊皆計)
 *
 * @param {Array} sources 輸入全部來源
 * @returns {Object} 回傳 { total, enabled, disabled, paused }
 */
function pendingSourcesOf(sources) {
    return {
        total: sources.length,
        enabled: sources.filter((s) => s.enabled !== false).length,
        disabled: sources.filter((s) => s.enabled === false).length,
        paused: sources.filter((s) => s.paused === true).length,
    }
}

/**
 * 依 key 函數計數
 *
 * @param {Array} list 輸入陣列
 * @param {Function} keyOf 輸入 (x) => 鍵字串
 * @returns {Object} 回傳 { 鍵: 數量 }
 */
function countBy(list, keyOf) {
    const out = {}
    for (const x of list) {
        const k = keyOf(x)
        out[k] = (out[k] || 0) + 1
    }
    return out
}

/** 剔除列之計數鍵 `物件:狀態:類別` */
const countKeyOf = (row) => `${row.object}:${row.status}:${row.class}`

/**
 * 剔除清單與待辦總表(唯讀;檔頭)
 *
 * @param {Object} stores 輸入集合 { docs, sources, frontier, areas }(各具 select(find?);只依 opt.objects 所需者必備)
 * @param {Object} [opt={}] 輸入設定
 * @param {Array} [opt.objects] 輸入要列之物件(REJECT_OBJECTS 之子集;預設全部;空陣列視同未給)
 * @param {Array} [opt.status] 輸入只列這些狀態(列之 status:文件之 status、來源 disabled／paused、線索與領域之 status、回溯之 outcome;空陣列視同未給)
 * @param {Array} [opt.class] 輸入只列這些類別(rejectClassOf 之值;空陣列視同未給)
 * @param {String} [opt.host] 輸入主機名,含子網域(example.com 亦配 a.example.com;無網址之列不符)
 * @param {String} [opt.since] 輸入 ISO 時刻,只列決定時刻(at)不早於此者(無 at 者排除;無效值拋錯,不靜默放寬)
 * @param {Integer} [opt.limit] 輸入 rows 上限(正整數;counts 與 pending 不受影響)
 * @param {Number} [opt.nowMs=Date.now()] 輸入現在時刻毫秒(待辦之退避判斷與最舊天數)
 * @param {Object} [opt.capture] 輸入抓取設定(settings.capture;待辦之佇列分法依其瀏覽器佇列開關——停用時指名瀏覽器之件併回補全文佇列,
 *   與補全文段同一分法;未給視同開啟)
 * @param {String} [opt.ledgerFile] 輸入回溯帳(JSONL)絕對路徑;不存在即略過(refetch 無資料)
 * @returns {Promise} 回傳 Promise，resolve 回傳 { rows:Array(剔除列,新到舊), counts:{ '物件:狀態:類別': 筆數 }(全部符合篩選者),
 *   pending:{ docs?, clues?, sources?, areas?, refetch? }(待辦總表,不受篩選影響) }
 * @throws {Error} 未知物件、所需集合缺 select、since 無法解析、host 無效時拋出
 * @example
 * need test in nodejs.
 *
 * let r = await rejectListOf({ docs, sources, frontier, areas }, { objects: ['docs'], class: ['http-final'], limit: 20, ledgerFile: './state/refetch-sources.jsonl' })
 * console.log(r.rows.length, r.counts, r.pending.docs.new.total)
 */
export async function rejectListOf(stores, opt = {}) {

    //check
    if (!isobj(stores)) {
        throw new Error('rejectListOf 需要 stores 物件（docs、sources、frontier、areas）')
    }
    if (!isobj(opt)) {
        opt = {}
    }
    const objs = [...new Set(listOf(opt.objects) || REJECT_OBJECTS)]
    for (const o of objs) {
        if (!REJECT_OBJECTS.includes(o)) throw new Error(`rejectListOf 未知物件「${o}」（可用：${REJECT_OBJECTS.join('、')}）`)
    }
    const need = (name, why) => {
        if (!isfun(stores[name]?.select)) throw new Error(`rejectListOf 需要 stores.${name}（具 select 方法；${why}）`)
        return stores[name]
    }
    const statusList = listOf(opt.status)
    const classList = listOf(opt.class)
    const statusSet = statusList ? new Set(statusList) : null
    const classSet = classList ? new Set(classList) : null
    let sinceMs = null
    if (str(opt.since).trim()) {
        sinceMs = Date.parse(str(opt.since).trim())
        if (!Number.isFinite(sinceMs)) throw new Error(`rejectListOf 之 since 須為可解析之日期時間字串，收到「${str(opt.since)}」`)
    }
    let hostMatch = null
    if (str(opt.host).trim()) {
        const host = hostOf(opt.host)
        if (!host) throw new Error(`rejectListOf 之 host 須為主機名，收到「${str(opt.host)}」`)
        const m = deadMatcher({ host })
        hostMatch = (url) => m({ url })
    }
    const limit = Number.isInteger(opt.limit) && opt.limit > 0 ? opt.limit : Infinity
    const nowMs = Number.isFinite(opt.nowMs) ? opt.nowMs : Date.now()

    // ── 讀(只 select;全部讀完才算,中途不寫任何東西)──
    const wantDocs = objs.includes('docs')
    // 回溯列帶出網址與標題須查文件;只列回溯而無 docs 集合者照列(網址與標題留空)
    const docs = wantDocs ? await need('docs', '物件 docs').select() : (objs.includes('refetch') && isfun(stores.docs?.select) ? await stores.docs.select() : [])
    const sources = objs.includes('sources') ? await need('sources', '物件 sources').select() : []
    const clues = objs.includes('clues') ? await need('frontier', '物件 clues').select() : []
    const areas = objs.includes('areas') ? (await need('areas', '物件 areas').select()).filter((a) => !str(a?.id).startsWith(AREA_META_ID)) : []
    const ledger = objs.includes('refetch') ? readLedgerLast(opt.ledgerFile) : new Map()
    const docById = new Map(docs.map((d) => [str(d.id), d]))
    // 重複件之錨:查無回 'missing'(錨已被刪或尚未入庫)
    const statusOfDoc = (id) => (docById.has(id) ? (str(docById.get(id).status) || '(空)') : 'missing')

    // ── 列(全部剔除者,未篩)──
    const all = []
    if (wantDocs) for (const d of docs) all.push(docRowOf(d, statusOfDoc))
    for (const s of sources) all.push(sourceRowOf(s))
    for (const c of clues) all.push(clueRowOf(c))
    for (const a of areas) all.push(areaRowOf(a))
    for (const [id, r] of ledger) all.push(refetchRowOf(r, docById.get(id)))

    // ── 篩選 → 計數(不受 limit)→ 排序 → 截斷 ──
    const kept = []
    for (const row of all) {
        if (!row) continue
        if (statusSet && !statusSet.has(row.status)) continue
        if (classSet && !classSet.has(row.class)) continue
        if (hostMatch && !hostMatch(row.url)) continue
        const ms = Date.parse(row.at)
        // 無 at 或 at 無法解析者:給 since 即排除(決定時刻不明,不能證明在期間內)
        if (sinceMs !== null && !(ms >= sinceMs)) continue
        kept.push({ row, ms: Number.isFinite(ms) ? ms : -Infinity })
    }
    const counts = countBy(kept, (x) => countKeyOf(x.row))
    const order = (o) => REJECT_OBJECTS.indexOf(o)
    kept.sort((a, b) => (a.ms === b.ms ? 0 : (a.ms > b.ms ? -1 : 1)) || order(a.row.object) - order(b.row.object) || cmp(a.row.id, b.row.id))
    const rows = kept.slice(0, limit).map((x) => x.row)

    // ── 待辦總表(不受篩選影響)──
    const pending = {}
    if (wantDocs) pending.docs = pendingDocsOf(docs, nowMs, isobj(opt.capture) ? browserQueueOn(opt.capture) : true)
    if (objs.includes('clues')) pending.clues = pendingCluesOf(clues, nowMs)
    if (objs.includes('sources')) pending.sources = pendingSourcesOf(sources)
    if (objs.includes('areas')) pending.areas = { total: areas.length, byStatus: countBy(areas, (a) => str(a.status) || '(空)') }
    if (objs.includes('refetch')) pending.refetch = { total: ledger.size, byOutcome: countBy([...ledger.values()], (r) => str(r.outcome) || '(空)') }

    return { rows, counts: Object.fromEntries(Object.entries(counts).sort(([x], [y]) => cmp(x, y))), pending }
}

/**
 * 剔除列 → CSV 字串(UTF-8 BOM 開頭,Excel 直接開啟不亂碼;RFC 4180 跳脫,列間以 CRLF——core/util/table 之 toCsv;extra 以 JSON 字串占一欄,無資料為 {})
 *
 * @param {Array} rows 輸入 rejectListOf 之 rows(非陣列視為空)
 * @returns {String} 回傳 CSV 字串(首列為欄名 object,id,url,label,status,class,reason,detail,at,extra)
 * @example
 * let csv = rowsToCsv([{ object: 'docs', id: 'd1', url: '', label: 'a,b', status: 'dead', class: 'unclassified', reason: '', detail: '', at: '', extra: { httpCode: 404 } }])
 * console.log(csv.split('\r\n')[1])
 * // => docs,d1,,"a,b",dead,unclassified,,,,"{""httpCode"":404}"
 */
export function rowsToCsv(rows) {
    const list = isarr(rows) ? rows : []
    return toCsv(COLS, list.map((r) => COLS.map((c) => (c === 'extra' ? JSON.stringify(isobj(r?.extra) ? r.extra : {}) : r?.[c]))))
}

/**
 * Markdown 表格(儲存格之跳脫取 core/util/table 之 mdCell)
 *
 * @param {Array} head 輸入欄名(固定字樣,不含「|」)
 * @param {Array} align 輸入對齊,'r' 靠右,其餘靠左
 * @param {Array} lines 輸入各列(各為欄位值陣列)
 * @returns {String} 回傳表格字串
 */
function mdTable(head, align, lines) {
    return [
        `| ${head.join(' | ')} |`,
        `|${align.map((a) => (a === 'r' ? '---:' : '---')).join('|')}|`,
        ...lines.map((l) => `| ${l.map(mdCell).join(' | ')} |`),
    ].join('\n')
}

/**
 * 待辦總表 → 表格列 [物件, 項目, 數量, 最舊天數](只列 pending 內有之物件)
 *
 * @param {Object} p 輸入 rejectListOf 之 pending
 * @returns {Array} 回傳列陣列
 */
function pendingLinesOf(p) {
    const out = []
    const cnt = (x) => (x ? x.count : '')
    const old = (x) => (x && x.oldestDays !== null && x.oldestDays !== undefined ? x.oldestDays : '')
    const d = p?.docs
    if (d) {
        out.push(['docs', '待補全文合計（new，含瀏覽器佇列）', d.new.total, ''])
        out.push(['docs', '　瀏覽器佇列（fetcher=browser）', cnt(d.new.browser), old(d.new.browser)])
        out.push(['docs', '　補全文退避中（retryAt 未到）', cnt(d.new.backoff), old(d.new.backoff)])
        out.push(['docs', '　補全文未試（fetchTries 為 0）', cnt(d.new.untried), old(d.new.untried)])
        out.push(['docs', '　補全文重試', cnt(d.new.retry), old(d.new.retry)])
        out.push(['docs', '待摘要（raw）', cnt(d.raw), old(d.raw)])
        out.push(['docs', '摘要失敗（summarize-failed）', cnt(d.summarizeFailed), ''])
        out.push(['docs', '已摘要而段落鍵無原文（noted）', cnt(d.paraKeysNoText), ''])
    }
    const c = p?.clues
    if (c) {
        out.push(['clues', '線索合計', c.total, ''])
        for (const [k, n] of Object.entries(c.byStatus || {})) out.push(['clues', `　${k}`, n, ''])
        out.push(['clues', '　pending 中退避中（retryAt 未到）', c.backoff, ''])
    }
    const s = p?.sources
    if (s) {
        out.push(['sources', '來源合計', s.total, ''])
        out.push(['sources', '　啟用', s.enabled, ''])
        out.push(['sources', '　停用（enabled=false）', s.disabled, ''])
        out.push(['sources', '　暫停（paused=true）', s.paused, ''])
    }
    const a = p?.areas
    if (a) {
        out.push(['areas', '領域合計（不含中繼記錄）', a.total, ''])
        for (const [k, n] of Object.entries(a.byStatus || {})) out.push(['areas', `　${k}`, n, ''])
    }
    const r = p?.refetch
    if (r) {
        out.push(['refetch', '回溯帳之文件數（各取最後結論）', r.total, ''])
        for (const [k, n] of Object.entries(r.byOutcome || {})) out.push(['refetch', `　${k}`, n, ''])
    }
    return out
}

/**
 * 剔除列 → Markdown 報告:先待辦總表、再計數表、再逐列表(表格內之「|」與換行已跳脫)
 *
 * @param {Array} rows 輸入 rejectListOf 之 rows(非陣列視為空)
 * @param {Object} [opt={}] 輸入設定
 * @param {Object} [opt.counts] 輸入 rejectListOf 之 counts(未給則由 rows 計——此時為 rows 內之計數,非全部符合者)
 * @param {Object} [opt.pending] 輸入 rejectListOf 之 pending(未給則不列待辦總表)
 * @param {String} [opt.title] 輸入標題(預設「剔除清單與待辦總表」)
 * @param {String} [opt.note] 輸入標題下之說明文字(如產出時刻與篩選條件)
 * @param {Boolean} [opt.list=true] 輸入是否列逐列表;false 只出待辦總表與計數表
 * @returns {String} 回傳 Markdown 字串
 * @example
 * let md = rowsToMd([{ object: 'docs', id: 'd1', url: '', label: 'a|b', status: 'dead', class: 'unclassified', reason: '', detail: '', at: '', extra: {} }])
 * console.log(md.includes('a\\|b'))
 * // => true
 */
export function rowsToMd(rows, opt = {}) {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    const list = isarr(rows) ? rows : []
    const counts = isobj(opt.counts) ? opt.counts : countBy(list, countKeyOf)
    const out = [`# ${str(opt.title) || '剔除清單與待辦總表'}`]
    if (isestr(opt.note)) out.push(opt.note)
    if (isobj(opt.pending)) {
        out.push('## 待辦總表', mdTable(['物件', '項目', '數量', '最舊（天）'], ['l', 'l', 'r', 'r'], pendingLinesOf(opt.pending)))
    }
    // 計數鍵為 `物件:狀態:類別`(類別可含冒號,故只切前兩個)
    const countLines = Object.entries(counts)
        .map(([k, n]) => {
            const i = k.indexOf(':')
            const j = k.indexOf(':', i + 1)
            return [k.slice(0, i), k.slice(i + 1, j), k.slice(j + 1), n]
        })
        .sort((a, b) => b[3] - a[3] || cmp(a[0], b[0]) || cmp(a[1], b[1]) || cmp(a[2], b[2]))
    const total = Object.values(counts).reduce((s, n) => s + n, 0)
    out.push(`## 計數（物件／狀態／類別；共 ${total} 筆）`, mdTable(['物件', '狀態', '類別', '筆數'], ['l', 'l', 'l', 'r'], countLines))
    if (opt.list !== false) {
        const cut = total > list.length ? `；符合 ${total} 列，已截斷` : ''
        const extraText = (x) => Object.entries(isobj(x) ? x : {}).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join('；')
        out.push(
            `## 清單（${list.length} 列${cut}）`,
            mdTable(['物件', 'id', '狀態', '類別', '標的', '原因', '說明', '時間', '網址', '附註'], ['l', 'l', 'l', 'l', 'l', 'l', 'l', 'l', 'l', 'l'],
                list.map((r) => [r?.object, r?.id, r?.status, r?.class, r?.label, r?.reason, r?.detail, r?.at, r?.url, extraText(r?.extra)])),
        )
    }
    return `${out.join('\n\n')}\n`
}

export default { REJECT_OBJECTS, rejectClassOf, rejectListOf, rowsToCsv, rowsToMd }
