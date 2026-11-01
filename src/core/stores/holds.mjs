// holds.mjs — 待判登錄(檢定標準之「未能判定」與「不納入、待條件成立後重送」者;四工作同一機制)
//
// 【為何要登錄】未能判定不得算合格(達檢定標準才能納入);不納入之物件若無紀錄,就是靜默遺失。
//   登錄＝待辦:每筆寫明原因、下一步、負責者(管線自動 pipeline｜使用者 user)、期限;逾期者巡檢必看(overdueHolds)。
// 【鍵】`<物件>:<id>:<標準>`(holdKey)——同一物件同一標準只一筆。再登錄同鍵:未結案 → tries＋1、更新原因／下一步／條件;已結案 → 重開。
//   符合度掃描以同一鍵認使用者之豁免,登錄與掃描同取本函數。
// 【結案】resolveHold(條件成立後處置完成,記處置方式);waiveHold(豁免:須記裁示者、裁示內容與日期——只用於使用者明示之裁決)。
// 【重試】requestRetry 只記「使用者要求重試」之時刻;實際重試由登錄之段於下輪執行——該段以 retryRequestedOf(要求晚於登錄之最後更新)
//   或 pipelineDueOf(負責者為管線,或使用者要求了重試)判定,一律以時刻比較(各段不另寫比較式)。
// 【期限】holdDeadlineOf(登錄時刻, 天數):機制一份,天數屬各工作之政策常數。
// 【存量處置之待判】holdStockUnfixable(修不了者登錄使用者待判;已未結或已豁免者不重登;先記帳列再寫登錄——登錄失敗亦有帳可查:連鎖斷言報「未登錄」、
//   回退對無登錄者為空操作)、closeStockHold(已不再違反之未結登錄結案;先記結案列再結案)、
//   rollbackStockHold(回退登錄列:只動同一登錄——未結且登錄時刻＝帳列之時刻;有登錄前之記錄者寫回、無者結案;其後之裁示、他次登錄或已結案者不動)、
//   reopenStockHold(回退結案列:仍為該次所結者復原為結案前之登錄)、stockHoldProblems(連鎖斷言:登錄列已登錄、結案列已結案且登錄在)——
//   各工作之存量處置同用;帳列由呼叫端之寫帳函數記(登錄列 { object:'hold', id:鍵, stds, before:{ hold:登錄前之記錄｜null }, hold:鍵 }——
//   登錄身分為帳列之時刻〔登錄或重開之 since＝該時刻〕;結案列 { object:'hold-resolved', id:鍵, stds, before:{ hold:結案前之登錄 }, hold:鍵 })。
// 【形狀】{ id, object, oid, std, status:'open'|'resolved'|'waived', reason, next, owner, deadline, since, at, tries, ctx(登錄當時之版本等),
//   retryRequestedAt?, resolvedAt?, how?, waivedAt?, waivedBy?, ruling? };值皆字串／整數(集合 patch 為深合併,不放陣列)。

import isobj from 'wsemi/src/isobj.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import { strOf as s } from '../util/values.mjs'

/**
 * 登錄狀態之全集:open 未結案、resolved 已結案(條件成立後處置完成)、waived 已豁免(使用者裁示)
 *
 * @type {Array}
 */
export const HOLD_STATUSES = ['open', 'resolved', 'waived']
/**
 * 負責者之全集:pipeline 管線自動處理、user 待使用者處理
 *
 * @type {Array}
 */
export const HOLD_OWNERS = ['pipeline', 'user']

/** 一日之毫秒數 */
const DAY_MS = 86400000

const need = (store) => {
    if (!isfun(store?.get) || !isfun(store?.replace) || !isfun(store?.select)) throw new Error('待判登錄需要 holds 集合(具 get／replace／select 方法)')
}

/**
 * 登錄之鍵
 *
 * @param {String} object 輸入物件種類(docs／notes／edges／cores…)
 * @param {String} oid 輸入物件 id
 * @param {String} std 輸入標準 ID
 * @returns {String} 回傳 `<物件>:<id>:<標準>`
 * @example
 * console.log(holdKey('note', 'n1', 'SS4'))
 * // => note:n1:SS4
 */
export function holdKey(object, oid, std) {
    return `${s(object)}:${s(oid)}:${s(std)}`
}

/**
 * 登錄(或更新)一筆待判:同鍵(物件:id:標準)未結案 → tries＋1、更新原因與下一步;無此登錄或已結案者 → 新登(重開),前一段之處置存入 history
 *
 * @param {Object} store 輸入 holds 集合(需具 get／replace／select 方法)
 * @param {Object} h 輸入待判設定物件
 * @param {String} h.object 輸入物件種類(docs／notes／edges／cores…)
 * @param {String} h.oid 輸入物件 id
 * @param {String} h.std 輸入標準 ID
 * @param {String} h.reason 輸入原因
 * @param {String} h.next 輸入下一步
 * @param {String} [h.owner='pipeline'] 輸入負責者,'pipeline'(管線自動)或 'user'(使用者)
 * @param {String} [h.deadline] 輸入期限(ISO 字串)
 * @param {Object} [h.ctx] 輸入登錄當時之版本等(值轉為字串)
 * @param {String} nowIso 輸入時刻(記入 since／at)
 * @returns {Promise} 回傳 Promise，resolve 回傳登錄後之記錄
 * @throws {Error} 欄位不全或負責者不在清單時拋出
 * @example
 * let rows = new Map()
 * let store = { get: async (id) => rows.get(id) ?? null, replace: async (r) => { rows.set(r.id, r) }, select: async () => [...rows.values()] }
 * let h = { object: 'doc', oid: 'd1', std: 'S1', reason: '原文不可得', next: '來源恢復後重送', owner: 'user' }
 * let a = await putHold(store, h, '2026-09-01T00:00:00Z')
 * let b = await putHold(store, h, '2026-09-02T00:00:00Z')
 * console.log(a.id, a.status, a.tries, b.tries, b.since)
 * // => doc:d1:S1 open 0 1 2026-09-01T00:00:00Z
 */
export async function putHold(store, h, nowIso) {
    need(store)
    if (!isobj(h) || !isestr(h.object) || !isestr(h.oid) || !isestr(h.std)) throw new Error('putHold 需要 object、oid、std')
    if (!isestr(h.reason) || !isestr(h.next)) throw new Error(`putHold 需要原因與下一步：${holdKey(h.object, h.oid, h.std)}`)
    const owner = h.owner || 'pipeline'
    if (!HOLD_OWNERS.includes(owner)) throw new Error(`putHold 之負責者「${owner}」不在清單（${HOLD_OWNERS.join('、')}）`)
    const id = holdKey(h.object, h.oid, h.std)
    const cur = await store.get(id)
    const reopen = !cur || cur.status !== 'open'
    const ctx = isobj(h.ctx) ? Object.fromEntries(Object.entries(h.ctx).map(([k, v]) => [k, s(v)])) : {}
    // 重開已結案／已豁免之登錄:前一段之處置(結案方式、豁免之裁示者與內容)存入 history,不被新登錄抹除(裁示須可追溯)
    const closed = cur && cur.status !== 'open'
        ? { status: cur.status, since: s(cur.since), at: s(cur.at), reason: s(cur.reason), ...(cur.resolvedAt ? { resolvedAt: s(cur.resolvedAt), how: s(cur.how) } : {}), ...(cur.waivedAt ? { waivedAt: s(cur.waivedAt), waivedBy: s(cur.waivedBy), ruling: s(cur.ruling) } : {}) }
        : null
    const history = [...(Array.isArray(cur?.history) ? cur.history : []), ...(closed ? [closed] : [])]
    const rec = {
        id, object: h.object, oid: h.oid, std: h.std, status: 'open',
        reason: h.reason, next: h.next, owner, deadline: s(h.deadline),
        since: reopen ? s(nowIso) : s(cur.since), at: s(nowIso),
        tries: reopen ? 0 : (Number(cur.tries) || 0) + 1, ctx,
        ...(history.length ? { history } : {}),
    }
    await store.replace(rec)
    return rec
}

/**
 * 結案(條件成立後已處置)
 *
 * @param {Object} store 輸入 holds 集合(需具 get／replace／select 方法)
 * @param {String} id 輸入登錄鍵(holdKey 之結果)
 * @param {Object} [o={}] 輸入設定物件
 * @param {String} [o.how] 輸入處置方式
 * @param {String} [o.at] 輸入結案時刻
 * @returns {Promise} 回傳 Promise，resolve 回傳結案後之記錄;無此登錄回 null
 * @example
 * let rows = new Map()
 * let store = { get: async (id) => rows.get(id) ?? null, replace: async (r) => { rows.set(r.id, r) }, select: async () => [...rows.values()] }
 * await putHold(store, { object: 'doc', oid: 'd1', std: 'S1', reason: '原文不可得', next: '來源恢復後重送' }, '2026-09-01T00:00:00Z')
 * let r = await resolveHold(store, 'doc:d1:S1', { at: '2026-09-02T00:00:00Z', how: '重送後已處理' })
 * console.log(r.status, r.how, await resolveHold(store, 'doc:x:S1'))
 * // => resolved 重送後已處理 null
 */
export async function resolveHold(store, id, o = {}) {
    need(store)
    const cur = await store.get(id)
    if (!cur) return null
    const rec = { ...cur, status: 'resolved', resolvedAt: s(o.at), how: s(o.how) }
    await store.replace(rec)
    return rec
}

/**
 * 豁免(使用者裁示):須記裁示者與裁示內容
 *
 * @param {Object} store 輸入 holds 集合(需具 get／replace／select 方法)
 * @param {String} id 輸入登錄鍵(holdKey 之結果)
 * @param {Object} o 輸入設定物件
 * @param {String} o.by 輸入裁示者
 * @param {String} o.ruling 輸入裁示內容
 * @param {String} [o.at] 輸入裁示時刻
 * @returns {Promise} 回傳 Promise，resolve 回傳豁免後之記錄
 * @throws {Error} 缺裁示者或裁示內容、無此登錄時拋出
 * @example
 * let rows = new Map()
 * let store = { get: async (id) => rows.get(id) ?? null, replace: async (r) => { rows.set(r.id, r) }, select: async () => [...rows.values()] }
 * await putHold(store, { object: 'doc', oid: 'd1', std: 'S1', reason: '原文不可得', next: '來源恢復後重送' }, '2026-09-01T00:00:00Z')
 * let r = await waiveHold(store, 'doc:d1:S1', { by: '使用者甲', ruling: '此件不納入', at: '2026-09-02T00:00:00Z' })
 * console.log(r.status, r.waivedBy, r.ruling)
 * // => waived 使用者甲 此件不納入
 */
export async function waiveHold(store, id, o = {}) {
    need(store)
    if (!isestr(o.by) || !isestr(o.ruling)) throw new Error('豁免須記裁示者與裁示內容(by、ruling)')
    const cur = await store.get(id)
    if (!cur) throw new Error(`無此待判登錄：${id}`)
    const rec = { ...cur, status: 'waived', waivedAt: s(o.at), waivedBy: o.by, ruling: o.ruling }
    await store.replace(rec)
    return rec
}

/**
 * 記「使用者要求重試」(實際重試由負責之段於下輪執行)
 *
 * @param {Object} store 輸入 holds 集合(需具 get／replace／select 方法)
 * @param {String} id 輸入登錄鍵(holdKey 之結果)
 * @param {Object} [o={}] 輸入設定物件
 * @param {String} [o.at] 輸入要求重試之時刻(記入 retryRequestedAt)
 * @returns {Promise} 回傳 Promise，resolve 回傳更新後之記錄
 * @throws {Error} 無此登錄、或非未結案時拋出
 * @example
 * let rows = new Map()
 * let store = { get: async (id) => rows.get(id) ?? null, replace: async (r) => { rows.set(r.id, r) }, select: async () => [...rows.values()] }
 * await putHold(store, { object: 'doc', oid: 'd1', std: 'S1', reason: '原文不可得', next: '來源恢復後重送', owner: 'user' }, '2026-09-01T00:00:00Z')
 * let r = await requestRetry(store, 'doc:d1:S1', { at: '2026-09-02T00:00:00Z' })
 * console.log(r.retryRequestedAt, retryRequestedOf(r))
 * // => 2026-09-02T00:00:00Z true
 */
export async function requestRetry(store, id, o = {}) {
    need(store)
    const cur = await store.get(id)
    if (!cur) throw new Error(`無此待判登錄：${id}`)
    if (cur.status !== 'open') throw new Error(`待判登錄 ${id} 已結案（${cur.status}），不可重試`)
    const rec = { ...cur, retryRequestedAt: s(o.at) }
    await store.replace(rec)
    return rec
}

/**
 * 列出登錄(依 since 升冪、id)
 *
 * @param {Object} store 輸入 holds 集合(需具 get／replace／select 方法)
 * @param {Object} [f={}] 輸入篩選條件物件(未給者不篩)
 * @param {String} [f.status] 輸入狀態,'open'｜'resolved'｜'waived'
 * @param {String} [f.object] 輸入物件種類
 * @param {String} [f.std] 輸入標準 ID
 * @param {String} [f.owner] 輸入負責者,'pipeline'｜'user'
 * @returns {Promise} 回傳 Promise，resolve 回傳記錄陣列(依 since 升冪、id 排序)
 * @example
 * let rows = new Map()
 * let store = { get: async (id) => rows.get(id) ?? null, replace: async (r) => { rows.set(r.id, r) }, select: async () => [...rows.values()] }
 * let h = { object: 'doc', oid: 'd1', std: 'S1', reason: '原文不可得', next: '來源恢復後重送' }
 * await putHold(store, { ...h, owner: 'user' }, '2026-09-02T00:00:00Z')
 * await putHold(store, { ...h, oid: 'd2' }, '2026-09-01T00:00:00Z')
 * console.log((await listHolds(store)).map((r) => r.id), (await listHolds(store, { owner: 'user' })).map((r) => r.id))
 * // => [ 'doc:d2:S1', 'doc:d1:S1' ] [ 'doc:d1:S1' ]
 */
export async function listHolds(store, f = {}) {
    need(store)
    const rows = await store.select()
    return rows
        .filter((r) => ['status', 'object', 'std', 'owner'].every((k) => !isestr(f[k]) || r[k] === f[k]))
        .sort((a, b) => (s(a.since) < s(b.since) ? -1 : s(a.since) > s(b.since) ? 1 : s(a.id) < s(b.id) ? -1 : 1))
}

/**
 * 兩個時刻之先後(以時刻比較;任一無法解析時依字面比較——非 ISO 之代號時刻)
 *
 * @param {String} a 輸入時刻
 * @param {String} b 輸入時刻
 * @returns {Boolean} 回傳 a 是否晚於 b
 */
function later(a, b) {
    const ta = Date.parse(a)
    const tb = Date.parse(b)
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta > tb
    return a > b
}

/**
 * 逾期之未結案登錄(巡檢必看)
 *
 * 【以時刻比較,不以字串比較】期限與現在時刻之時區表示可不同(期限常以 UTC 之 ...Z 寫入,現在時刻常帶 +08:00):
 *   字串比較會把同一時刻判成不同先後(+08:00 之字面比 UTC 早 8 小時之字面大),逾期即提早 8 小時被列出。無法解析之期限不列。
 *
 * @param {Array} holds 輸入登錄陣列
 * @param {String} nowIso 輸入時刻(任一 ISO 8601 時區表示)
 * @returns {Array} 回傳逾期者(deadline 非空、可解析且早於 nowIso)
 * @example
 * console.log(overdueHolds([{ status: 'open', deadline: '2026-11-05T16:00:00.000Z' }], '2026-11-06T00:30:00+08:00').length)
 * // => 1
 */
export function overdueHolds(holds, nowIso) {
    const now = Date.parse(s(nowIso))
    if (!Number.isFinite(now)) return []
    return (Array.isArray(holds) ? holds : []).filter((h) => {
        if (h?.status !== 'open' || !isestr(h.deadline)) return false
        const due = Date.parse(h.deadline)
        return Number.isFinite(due) && due < now
    })
}

/**
 * 使用者是否要求了重試:requestRetry 之時刻晚於登錄之最後更新時刻(at)。以時刻比較(時區表示可不同;任一無法解析時依字面比較)
 *
 * @param {Object} h 輸入登錄記錄
 * @returns {Boolean} 回傳是否要求了重試(未要求、非物件為 false;登錄無 at 而有要求者為 true)
 * @example
 * console.log(retryRequestedOf({ at: '2026-10-01T00:00:00Z', retryRequestedAt: '2026-10-01T09:00:00+08:00' }))
 * // => true
 */
export function retryRequestedOf(h) {
    if (!isobj(h) || !isestr(h.retryRequestedAt)) return false
    if (!isestr(h.at)) return true
    return later(h.retryRequestedAt, h.at)
}

/**
 * 管線本輪應處理之待判:負責者為管線,或使用者要求了重試(retryRequestedOf);未結與否由呼叫端篩
 *
 * @param {Object} h 輸入登錄記錄
 * @returns {Boolean} 回傳是否應處理
 * @example
 * console.log([pipelineDueOf({ owner: 'pipeline' }), pipelineDueOf({ owner: 'user' })])
 * // => [ true, false ]
 */
export function pipelineDueOf(h) {
    return isobj(h) && (h.owner === 'pipeline' || retryRequestedOf(h))
}

/**
 * 待判之期限:登錄時刻起若干天(機制一份;天數屬各工作之政策常數)
 *
 * @param {String} nowIso 輸入登錄時刻(任一 ISO 8601 時區表示)
 * @param {Number} days 輸入天數(正數)
 * @returns {String} 回傳期限之 ISO(UTC)
 * @throws {RangeError} 時刻無法解析或天數非正數時拋出
 * @example
 * console.log(holdDeadlineOf('2026-10-01T08:00:00+08:00', 30))
 * // => 2026-10-31T00:00:00.000Z
 */
export function holdDeadlineOf(nowIso, days) {
    const t = Date.parse(s(nowIso))
    if (!Number.isFinite(t)) throw new RangeError(`holdDeadlineOf 之時刻無法解析：${s(nowIso)}`)
    if (!(Number.isFinite(days) && days > 0)) throw new RangeError(`holdDeadlineOf 之天數須為正數，收到 ${JSON.stringify(days)}`)
    return new Date(t + days * DAY_MS).toISOString()
}

/**
 * 存量處置:修不了者登錄使用者待判——已有未結或已豁免者不重登(使用者之裁示不被改寫);登錄成功即以 o.log 記帳列
 *   { object:'hold', id:鍵, stds:[標準], before:{ hold:登錄前之記錄(已結案者)｜null }, hold:鍵 }(回退時依之復原或結案——rollbackStockHold;
 *   連鎖斷言依之驗已登錄)。逐件呼叫,隔離由呼叫端之迴圈負責。原因未給者以 detail 組成「存量修不了（標準）：說明」(說明至多 300 字;各工作同一格式)
 *
 * @param {Object} store 輸入 holds 集合(缺 → 拋錯,不靜默)
 * @param {Object} h 輸入待判設定物件
 * @param {String} h.object 輸入物件種類
 * @param {String} h.oid 輸入物件 id
 * @param {String} h.std 輸入標準 ID
 * @param {String} [h.reason] 輸入原因(未給以 detail 組成)
 * @param {String} [h.detail] 輸入說明(未給 reason 時組成原因,至多 300 字)
 * @param {String} h.next 輸入下一步
 * @param {String} [h.owner='user'] 輸入負責者,'pipeline'｜'user'
 * @param {String} [h.deadline] 輸入期限(ISO 字串)
 * @param {Object} [h.ctx] 輸入登錄當時之版本等(值轉為字串)
 * @param {Object} [o={}] 輸入設定物件
 * @param {String} [o.at] 輸入登錄時刻
 * @param {Function} [o.log] 輸入記帳函數 (帳列)=>void,登錄前呼叫一次(未給則不記帳)
 * @returns {Promise} 回傳 Promise，resolve 回傳 { key, held:Boolean(本次新登錄;false＝已有未結或已豁免) }
 * @throws {Error} 未開 holds 集合、或登錄之欄位不全時拋出
 * @example
 * let rows = new Map()
 * let store = { get: async (id) => rows.get(id) ?? null, replace: async (r) => { rows.set(r.id, r) }, select: async () => [...rows.values()] }
 * let ledger = []
 * let h = { object: 'doc', oid: 'd1', std: 'S1', detail: '原文不可得', next: '來源恢復後重送', deadline: '2026-10-01T00:00:00.000Z' }
 * let r = await holdStockUnfixable(store, h, { at: '2026-09-01T00:00:00Z', log: (row) => ledger.push(row) })
 * console.log(r, (await store.get(r.key)).reason, ledger.length)
 * console.log(await holdStockUnfixable(store, h, { at: '2026-09-02T00:00:00Z' }))
 * // => { key: 'doc:d1:S1', held: true } 存量修不了（S1）：原文不可得 1
 * // => { key: 'doc:d1:S1', held: false }
 */
export async function holdStockUnfixable(store, h, o = {}) {
    if (!isfun(store?.get)) throw new Error('未開 holds 集合，修不了之存量未登錄待判')
    const key = holdKey(h?.object, h?.oid, h?.std)
    const cur = await store.get(key)
    if (cur?.status === 'open' || cur?.status === 'waived') return { key, held: false }
    const { detail, ...rest } = h
    const reason = isestr(h.reason) ? h.reason : `存量修不了（${s(h.std)}）：${s(detail).slice(0, 300)}`
    // 先記後寫(檔頭【存量處置之待判】):帳列先於登錄
    if (isfun(o.log)) o.log({ object: 'hold', id: key, stds: [s(h.std)], before: { hold: cur ? JSON.parse(JSON.stringify(cur)) : null }, hold: key })
    await putHold(store, { owner: 'user', ...rest, reason }, o.at)
    return { key, held: true }
}

/**
 * 存量處置:已不再違反之未結登錄結案(重掃已無此違反;非未結者不動)——結案即以 o.log 記結案列
 *   { object:'hold-resolved', id:鍵, stds:[標準], before:{ hold:結案前之登錄 }, hold:鍵 }(回退時依之復原)
 *
 * @param {Object} store 輸入 holds 集合(缺 → 拋錯)
 * @param {String} key 輸入登錄鍵(holdKey 之結果)
 * @param {String} std 輸入標準(帳列之 stds)
 * @param {Object} [o={}] 輸入設定物件
 * @param {String} [o.at] 輸入結案時刻
 * @param {Function} [o.log] 輸入記帳函數 (帳列)=>void,結案前呼叫一次(未給則不記帳)
 * @returns {Promise} 回傳 Promise，resolve 回傳是否結案(非未結者回 false)
 * @throws {Error} 未開 holds 集合時拋出
 * @example
 * let rows = new Map()
 * let store = { get: async (id) => rows.get(id) ?? null, replace: async (r) => { rows.set(r.id, r) }, select: async () => [...rows.values()] }
 * await putHold(store, { object: 'doc', oid: 'd1', std: 'S1', reason: '原文不可得', next: '來源恢復後重送' }, '2026-09-01T00:00:00Z')
 * let ledger = []
 * let ok = await closeStockHold(store, 'doc:d1:S1', 'S1', { at: '2026-09-02T00:00:00Z', log: (row) => ledger.push(row) })
 * console.log(ok, (await store.get('doc:d1:S1')).status, ledger[0].object, await closeStockHold(store, 'doc:d1:S1', 'S1'))
 * // => true resolved hold-resolved false
 */
export async function closeStockHold(store, key, std, o = {}) {
    if (!isfun(store?.get)) throw new Error('未開 holds 集合，已不再違反之待判未結案')
    const cur = await store.get(key)
    if (cur?.status !== 'open') return false
    // 先記後寫:結案列先於結案
    if (isfun(o.log)) o.log({ object: 'hold-resolved', id: key, stds: [s(std)], before: { hold: cur }, hold: key })
    await resolveHold(store, key, { at: o.at, how: '存量處置重掃已無此違反' })
    return true
}

/**
 * 存量處置之回退(登錄列;回退＝撤銷該次登錄):只動同一登錄——未結且登錄時刻(since)＝帳列之時刻;有登錄前之記錄(帳列 before.hold;
 *   該次登錄重開了已結案者)→ 寫回之,無 → 結案(存量處置回退)。其後之裁示(豁免)、他次登錄(since 不同)或已結案者不動(不是該次登錄之效果)
 *
 * @param {Object} store 輸入 holds 集合(缺 → 拋錯)
 * @param {Object} r 輸入登錄列
 * @param {String} r.at 輸入登錄列之時刻(須等於登錄之 since)
 * @param {String} r.id 輸入登錄鍵(未給 r.hold 時取之)
 * @param {String} [r.hold] 輸入登錄鍵
 * @param {Object} [r.before] 輸入處置前之狀態,r.before.hold 為登錄前之記錄(無則省略或 null)
 * @param {String} at 輸入回退時刻(結案時刻)
 * @returns {Promise} 回傳 Promise，resolve 回傳是否動了登錄(非同一登錄回 false)
 * @throws {Error} 未開 holds 集合時拋出
 * @example
 * let rows = new Map()
 * let store = { get: async (id) => rows.get(id) ?? null, replace: async (r) => { rows.set(r.id, r) }, select: async () => [...rows.values()] }
 * let a = await putHold(store, { object: 'doc', oid: 'd1', std: 'S1', reason: '原文不可得', next: '來源恢復後重送' }, '2026-09-01T00:00:00Z')
 * let row = { at: '2026-09-01T00:00:00Z', object: 'hold', id: a.id, hold: a.id, before: { hold: null } }
 * console.log(await rollbackStockHold(store, row, '2026-09-02T00:00:00Z'), (await store.get(a.id)).status, await rollbackStockHold(store, row, '2026-09-03T00:00:00Z'))
 * // => true resolved false
 */
export async function rollbackStockHold(store, r, at) {
    if (!isfun(store?.get) || !isfun(store?.replace)) throw new Error('未開 holds 集合，待判未結案')
    const key = s(r?.hold || r?.id)
    const cur = await store.get(key)
    if (cur?.status !== 'open' || s(cur.since) !== s(r?.at)) return false
    if (isobj(r?.before?.hold)) await store.replace(JSON.parse(JSON.stringify(r.before.hold)))
    else await resolveHold(store, key, { at, how: '存量處置回退' })
    return true
}

/**
 * 存量處置之回退(結案列):登錄仍為該次所結者(已結案且結案時刻＝帳列之 at)復原為結案前之登錄;其後已被重開或豁免者不動
 *
 * @param {Object} store 輸入 holds 集合(缺 → 拋錯)
 * @param {Object} r 輸入結案列
 * @param {String} r.at 輸入結案列之時刻(須等於登錄之 resolvedAt)
 * @param {String} r.id 輸入登錄鍵(未給 r.hold 時取之)
 * @param {String} [r.hold] 輸入登錄鍵
 * @param {Object} r.before 輸入結案前之狀態,r.before.hold 為結案前之登錄記錄
 * @returns {Promise} 回傳 Promise，resolve 回傳是否復原
 * @throws {Error} 未開 holds 集合時拋出
 * @example
 * let rows = new Map()
 * let store = { get: async (id) => rows.get(id) ?? null, replace: async (r) => { rows.set(r.id, r) }, select: async () => [...rows.values()] }
 * await putHold(store, { object: 'doc', oid: 'd1', std: 'S1', reason: '原文不可得', next: '來源恢復後重送' }, '2026-09-01T00:00:00Z')
 * let ledger = []
 * await closeStockHold(store, 'doc:d1:S1', 'S1', { at: '2026-09-02T00:00:00Z', log: (row) => ledger.push({ at: '2026-09-02T00:00:00Z', ...row }) })
 * console.log(await reopenStockHold(store, ledger[0]), (await store.get('doc:d1:S1')).status, await reopenStockHold(store, ledger[0]))
 * // => true open false
 */
export async function reopenStockHold(store, r) {
    if (!isfun(store?.get) || !isfun(store?.replace)) throw new Error('未開 holds 集合，待判未處置')
    const key = s(r?.hold || r?.id)
    const cur = await store.get(key)
    if (cur?.status !== 'resolved' || cur.resolvedAt !== r?.at || !isobj(r?.before?.hold)) return false
    await store.replace(JSON.parse(JSON.stringify(r.before.hold)))
    return true
}

/**
 * 存量處置之連鎖斷言:登錄列(object 'hold')已登錄;結案列(object 'hold-resolved')之登錄在且已結案
 *
 * @param {Object} store 輸入 holds 集合(可缺;缺則回報無從驗證)
 * @param {Object} r 輸入帳列(取 object、hold 或 id)
 * @returns {Promise} 回傳 Promise，resolve 回傳問題說明陣列(字串陣列;無問題為空陣列)
 * @example
 * let rows = new Map()
 * let store = { get: async (id) => rows.get(id) ?? null, replace: async (r) => { rows.set(r.id, r) }, select: async () => [...rows.values()] }
 * await putHold(store, { object: 'doc', oid: 'd1', std: 'S1', reason: '原文不可得', next: '來源恢復後重送' }, '2026-09-01T00:00:00Z')
 * console.log(await stockHoldProblems(store, { object: 'hold', hold: 'doc:d1:S1' }), await stockHoldProblems(store, { object: 'hold-resolved', hold: 'doc:d1:S1' }))
 * // => [] [ '待判 doc:d1:S1：未結案' ]
 */
export async function stockHoldProblems(store, r) {
    const key = s(r?.hold || r?.id)
    if (!isfun(store?.get)) return [`待判 ${key}：未開 holds 集合，無從驗證`]
    const h = await store.get(key)
    if (r?.object === 'hold-resolved') return !h ? [`待判 ${key}：不在（結案列之登錄須在）`] : h.status === 'open' ? [`待判 ${key}：未結案`] : []
    return h ? [] : [`待判 ${key}：未登錄`]
}

export default {
    HOLD_STATUSES, HOLD_OWNERS, holdKey, putHold, resolveHold, waiveHold, requestRetry, listHolds, overdueHolds,
    retryRequestedOf, pipelineDueOf, holdDeadlineOf, holdStockUnfixable, closeStockHold, rollbackStockHold, reopenStockHold, stockHoldProblems,
}
