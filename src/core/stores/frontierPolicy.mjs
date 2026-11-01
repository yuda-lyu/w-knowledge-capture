// frontierPolicy.mjs — 待探索線索（frontier）的泛用機制：去重累加、優先挑選、上限淘汰、消化紀錄
//
// 【hits 累加是訊號不是雜訊】同一線索被多篇文件各自提到，代表它在該領域確實重要。
//   線索產生速度遠高於消化速度，純 FIFO 會讓最該追的題目排在幾百筆冷門線索後面，
//   故重複時累加 hits、消化時依 hits 優先。
// 【去重鍵須折疊字形，hits 才有效】只做 lowercase 時「Transformer 架構」「transformer架構」「Ｔransformer 架構」
//   「Transformer 架构」各成一筆。keyword/topic 之鍵走 normalizeClue（NFKC、去空白與括號、小寫、線索折疊）；
//   site 型以 normalizeUrl 折疊。折疊合併之比例不高，線索的問題本質是產生量遠大於消化量，故另設上限（下）。
// 【線索鍵與概念分群鍵脫鉤】分群政策（折疊方向、改名、別名）可調，線索鍵若跟著變，既有線索記錄會全部換鍵（去重失效、
//   hits 歸零）。線索鍵走 normalizeClue：只用固定之線索折疊，不套改名與別名（見 util/text）。
// 【上限與淘汰（可復活）】pending 超過 maxPending 即淘汰優先序最低者（hits 低、來自 skip 文件、最舊）：
//   狀態 evicted、記錄保留（去重憑證）；日後再被提及即累加 hits 並復活為 pending——
//   淘汰的是「至今只被提過一次的冷門線索」，不是資訊本身。

import isobj from 'wsemi/src/isobj.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import isp0int from 'wsemi/src/isp0int.mjs'
import cint from 'wsemi/src/cint.mjs'
import { sha1, normalizeClue } from '../util/text.mjs'
import { normalizeUrl } from '../util/web.mjs'
import { scriptOf } from '../locale.mjs'
import { backoffUntil, inBackoff } from './docPolicy.mjs'

/**
 * 線索去重鍵（折疊後）：keyword/topic 走 normalizeClue（固定之線索折疊，與概念分群脫鉤），site 走 normalizeUrl
 *
 * @param {String} type 輸入線索型別，'keyword'／'topic'／'site'
 * @param {String} value 輸入線索原始值
 * @returns {String} 回傳去重鍵（sha1 十六進位）
 * @example
 * console.log(clueKey('keyword', 'Transformer 架構') === clueKey('keyword', 'transformer架構'))
 * // => true
 */
export function clueKey(type, value) {
    const v = type === 'site' ? normalizeUrl(String(value || '')).toLowerCase() : normalizeClue(value)
    return sha1(`${type}|${v}`)
}

/**
 * 來自被略過文件之線索（fromRef 'skip:<docId>'）：優先序低於來自知識文件者
 *
 * @param {Object} c 輸入線索記錄，取 fromRef 欄位
 * @returns {Integer} 回傳 1(來自 skip 文件)或 0
 */
const skipDerived = (c) => (/^skip:/.test(String(c?.fromRef || '')) ? 1 : 0)

/** 線索之來源文件留痕上限(refs 只留最近者;distinctDocs 照實累計) */
const CLUE_REFS_MAX = 10

/**
 * 線索優先序（高 → 低）：hits 降冪 → 來自知識文件者先 → 先來後到；挑選與淘汰共用同一份
 *
 * @param {Object} a 輸入線索記錄 a
 * @param {Object} b 輸入線索記錄 b
 * @returns {Number} 回傳比較結果，供 Array.prototype.sort 使用
 * @example
 * let list = [{ hits: 1, addedAt: '2026-09-01' }, { hits: 5, addedAt: '2026-09-02' }]
 * console.log(list.sort(cluePriority).map((c) => c.hits))
 * // => [ 5, 1 ]
 */
export function cluePriority(a, b) {
    return (b.hits || 1) - (a.hits || 1) ||
    skipDerived(a) - skipDerived(b) ||
    String(a.addedAt || '').localeCompare(String(b.addedAt || ''))
}

/**
 * 線索格式之判定規則(寫入 saveClues 與符合度掃描 CS9 同一份;取 cfg 之 types／maxValueLen／groundText)
 *
 * @param {Object} [cfg={}] 輸入設定物件(同 saveClues 之 cfg)，非物件則回退為 {}
 * @returns {Object} 回傳 { types:Array, maxLen:Integer, siteGrounded:(url)=>Boolean(材料未給 → 恆真) }
 * @example
 * console.log(clueRulesOf({}).maxLen)
 * // => 120
 */
export function clueRulesOf(cfg = {}) {
    if (!isobj(cfg)) {
        cfg = {}
    }
    const ground = typeof cfg.groundText === 'string' ? cfg.groundText.toLowerCase() : null
    return {
        types: cfg.types || ['keyword', 'topic', 'site'],
        maxLen: cfg.maxValueLen ?? 120,
        // 網址或其主機(去 www.)見於材料;材料未給 → 不檢
        siteGrounded: (url) => {
            if (ground === null) return true
            let host = ''
            try {
                host = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
            }
            catch {
                return false
            }
            return ground.includes(url.toLowerCase()) || (!!host && ground.includes(host))
        },
    }
}

/**
 * 一筆線索之格式判定(檢定標準 CS9／CS11;純函數——寫入與符合度掃描同一判定,掃描不必逐筆走寫入之整條路徑)
 *
 * @param {Object} e 輸入線索 { type, value }
 * @param {Object} rules 輸入 clueRulesOf 之產物
 * @returns {Object} 回傳 { drop:'type'|'empty'|'long'|'site'|'ungrounded'|null(合格), type(正規化後), raw(去頭尾空白之值) }
 * @example
 * console.log(clueDropOf({ type: 'site', value: 'example.com' }, clueRulesOf({})).drop)
 * // => site
 */
export function clueDropOf(e, rules) {
    const type = String(e?.type || '').trim().toLowerCase()
    const raw = String(e?.value || '').trim()
    let drop = null
    if (!rules.types.includes(type)) drop = 'type'
    else if (!raw) drop = 'empty'
    else if (raw.length > rules.maxLen) drop = 'long'
    else if (type === 'site' && !/^https?:\/\//i.test(raw)) drop = 'site'
    else if (type === 'site' && !rules.siteGrounded(raw)) drop = 'ungrounded'
    return { drop, type, raw }
}

/**
 * 寫入一批線索（去重後入庫；重複者 hits+1，已淘汰者復活）。
 *
 * @param {Object} frontier 輸入 frontier 集合，需具 get／patch／insertNew 方法
 * @param {Array} clues 輸入線索陣列 [{type, value, why}]；type 白名單由 cfg.types 決定
 * @param {Object} [cfg={}] 輸入設定物件，非物件則回退為 {}
 * @param {Array} [cfg.types=['keyword','topic','site']] 輸入合法型別白名單字串陣列
 * @param {String} [cfg.fromRef] 輸入本批線索之來源標記（如 'skip:<docId>'）
 * @param {String} [cfg.nowIso] 輸入現在時刻 ISO 字串
 * @param {Integer} [cfg.maxValueLen=120] 輸入線索值最大長度，超過即略過
 * @param {String} [cfg.groundText] 輸入送給 AI 之材料(給了即檢 CS11:site 線索之網址或其主機須見於材料,否則不入庫——防模型自編網址)
 * @param {Object} [cfg.locale] 輸入語言設定或字形政策(core/locale;CS12 之值轉正體依之——非繁體中文之語言不轉;未給＝臺灣正體)
 * @returns {Promise} 回傳 Promise，resolve 回傳 { addCount:Integer, merged:Integer, revived:Integer,
 *   dropped:{ type, empty, long, site, ungrounded }(未入庫者,逐因計數;檢定標準 CS9／CS11), toTw:Integer(值轉正體者;CS12) }
 * @throws {Error} frontier 缺 get／patch／insertNew 方法、或 cfg.locale 不合時拋出
 * @example
 * let rows = new Map()
 * let frontier = {
 *     get: async (id) => rows.get(id) ?? null,
 *     insertNew: async (list) => { list.forEach((r) => rows.set(r.id, r)) },
 *     patch: async (id, p) => { Object.assign(rows.get(id), p) },
 * }
 * let clues = [{ type: 'keyword', value: '黑洞光譜' }, { type: 'keyword', value: '黑洞 光譜' }, { type: 'site', value: 'example.com' }]
 * let r = await saveClues(frontier, clues, { nowIso: '2026-09-01T00:00:00Z' })
 * console.log(r.addCount, r.merged, r.dropped.site, [...rows.values()].map((c) => c.hits))
 * // => 1 1 1 [ 2 ]
 */
export async function saveClues(frontier, clues, cfg = {}) {

    //check
    if (!isfun(frontier?.get) || !isfun(frontier?.patch) || !isfun(frontier?.insertNew)) {
        throw new Error('saveClues 需要 frontier 集合（具 get/patch/insertNew 方法）')
    }
    if (!isobj(cfg)) {
        cfg = {}
    }
    const script = scriptOf(cfg.locale, 'saveClues 之 cfg.locale')

    let addCount = 0
    let merged = 0
    let revived = 0
    let tw = 0
    const dropped = { type: 0, empty: 0, long: 0, site: 0, ungrounded: 0 }
    const rules = clueRulesOf(cfg)
    for (const e of clues || []) {
        const { drop, type, raw } = clueDropOf(e, rules)
        if (drop) {
            dropped[drop]++
            continue
        }
        // 檢定標準 CS12:關鍵詞／主題之值以正體入庫(只改違規處;網址不轉;字形政策依語言設定)。鍵(clueKey)本已折疊,轉換不改 id
        const value = type === 'site' ? raw : script.fix(raw)
        if (value !== raw) tw++
        const id = clueKey(type, value)
        const cur = await frontier.get(id)
        const ref = String(cfg.fromRef || '')
        if (cur) {
            // 來源文件留痕(有上限之 refs＋相異文件數):只在首次寫入記 fromRef 則合併時不記——同一題目被多少篇不同文件帶出
            //   (領域發現之重要性訊號)無從得知。done 者再被提及仍累計(不復活)
            const prevRefs = Array.isArray(cur.refs) ? cur.refs : (cur.fromRef ? [cur.fromRef] : [])
            const isNewRef = ref && !prevRefs.includes(ref)
            const patch = { hits: (cur.hits || 1) + 1, lastSeenAt: cfg.nowIso }
            if (isNewRef) Object.assign(patch, { refs: [...prevRefs, ref].slice(-CLUE_REFS_MAX), distinctDocs: (cur.distinctDocs || prevRefs.length) + 1 })
            if (cur.status === 'evicted') {
                Object.assign(patch, { status: 'pending', revivedAt: cfg.nowIso }); revived++
            }
            await frontier.patch(cur.id, patch)
            merged++
        }
        else {
            await frontier.insertNew([{
                id,
                type,
                value,
                why: String(e?.why || '').slice(0, 200),
                fromRef: ref,
                refs: ref ? [ref] : [],
                distinctDocs: ref ? 1 : 0,
                addedAt: cfg.nowIso,
                lastSeenAt: cfg.nowIso,
                status: 'pending', // pending → done（已消化）／failed（探測不到內容）／evicted（逾上限淘汰，可復活）
                tries: 0,
                hits: 1,
            }])
            addCount++
        }
    }
    return { addCount, merged, revived, dropped, toTw: tw }
}

/**
 * 挑本輪要消化的線索（優先序見 cluePriority）;退避中者(retryAt 晚於現在)不取——線索依 hits 排序而不看 tries,
 *   失敗之高 hits 線索若不退避,下一輪必再被挑中,兩輪即轉 failed
 *
 * @param {Object} frontier 輸入 frontier 集合，需具 select 方法
 * @param {Integer} [limit] 輸入本輪最多取幾筆，非非負整數則不限（取全部待消化線索）
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Number} [opt.nowMs=Date.now()] 輸入現在時刻(毫秒;退避判斷)
 * @returns {Promise} 回傳 Promise，resolve 回傳依優先序排序後之線索陣列
 * @throws {Error} frontier 缺 select 方法時拋出
 * @example
 * let rows = [
 *     { id: 'c1', value: '黑洞光譜', status: 'pending', hits: 1, addedAt: '2026-09-01' },
 *     { id: 'c2', value: '脈衝星計時', status: 'pending', hits: 3, addedAt: '2026-09-02' },
 *     { id: 'c3', value: '暗物質', status: 'done', hits: 9, addedAt: '2026-09-03' },
 * ]
 * let frontier = { select: async (f) => rows.filter((r) => r.status === f.status) }
 * console.log((await pickClues(frontier, 1)).map((c) => c.value), (await pickClues(frontier)).map((c) => c.value))
 * // => [ '脈衝星計時' ] [ '脈衝星計時', '黑洞光譜' ]
 */
export async function pickClues(frontier, limit, opt = {}) {

    //check
    if (!isfun(frontier?.select)) {
        throw new Error('pickClues 需要 frontier 集合（具 select 方法）')
    }
    const nowMs = Number.isFinite(opt?.nowMs) ? opt.nowMs : Date.now()

    const pending = (await frontier.select({ status: 'pending' })).filter((c) => !inBackoff(c, nowMs)).sort(cluePriority)
    if (!isp0int(limit)) {
        return pending
    }
    return pending.slice(0, cint(limit))
}

/**
 * 線索之「不計次延後」:本機網路不通、探測端點本身故障、逐線索鏈異常(程式／環境)——都不是線索的問題,不加 tries、不轉 failed,
 *   只記 retryAt 退避與原因(與 tries 分帳)
 *
 * @param {Object} frontier 輸入 frontier 集合，需具 patch 方法
 * @param {Object} clue 輸入線索記錄(取 id、chainFails、deferrals)
 * @param {Object} [cfg={}] 輸入設定物件，非物件則回退為 {}
 * @param {String} [cfg.nowIso] 輸入現在時刻 ISO 字串(退避期限之起點)
 * @param {String} [cfg.error] 輸入延後原因(記入 lastError，至多 150 字)
 * @param {String} [cfg.kind='endpoint'] 輸入延後種類，'chain'(逐線索鏈異常，累計 chainFails)／'endpoint'(探測端點故障)／'net'(本機網路不通)，後兩者累計 deferrals
 * @param {Number} [cfg.backoffHours=6] 輸入首次退避小時(第 n 次延後 backoffHours×4^(n-1) 小時)
 * @returns {Promise} 回傳 Promise，resolve 回傳 { retryAt:String(退避期限 ISO), chainFails:Integer(延後後之鏈異常累計次數) }
 * @throws {Error} frontier 缺 patch 方法時拋出
 * @example
 * let frontier = { patch: async () => {} }
 * let cfg = { nowIso: '2026-09-01T00:00:00Z', kind: 'net', error: '網路不通' }
 * console.log(await deferClue(frontier, { id: 'c1' }, cfg), await deferClue(frontier, { id: 'c1', deferrals: 1 }, cfg))
 * // => { retryAt: '2026-09-01T06:00:00.000Z', chainFails: 0 } { retryAt: '2026-09-02T00:00:00.000Z', chainFails: 0 }
 */
export async function deferClue(frontier, clue, cfg = {}) {
    if (!isfun(frontier?.patch)) throw new Error('deferClue 需要 frontier 集合（具 patch 方法）')
    if (!isobj(cfg)) cfg = {}
    const kind = cfg.kind || 'endpoint'
    const n = kind === 'chain' ? (Number(clue.chainFails) || 0) + 1 : (Number(clue.deferrals) || 0) + 1
    const retryAt = backoffUntil(Date.parse(cfg.nowIso || ''), n, cfg.backoffHours ?? 6)
    const patch = { retryAt, lastError: String(cfg.error || '').slice(0, 150), ...(kind === 'chain' ? { chainFails: n } : { deferrals: n }) }
    await frontier.patch(clue.id, patch)
    return { retryAt, chainFails: kind === 'chain' ? n : Number(clue.chainFails) || 0 }
}

/**
 * failed 線索之冷卻重探(與來源停用之冷卻重探同一組參數 capture.sources.reprobeDays／reprobePerRun;冷卻 reprobeDays×2^已重探次數,上限 ×8):
 *   failed 若無任何回收路徑,因斷網或端點故障轉 failed 者即永久遺失;failedAt 未記者以首次觀察為起點(先補時刻)
 *
 * @param {Object} frontier 輸入 frontier 集合，需具 select／patch 方法
 * @param {Object} [cfg={}] 輸入設定物件，非物件則回退為 {}
 * @param {Number} [cfg.nowMs=Date.now()] 輸入現在時刻(毫秒;冷卻判斷)
 * @param {String} [cfg.nowIso] 輸入現在時刻 ISO 字串(記入 failedAt、reprobedAt)
 * @param {Number} [cfg.reprobeDays=0] 輸入基本冷卻天數，≤ 0 即不重探
 * @param {Integer} [cfg.perRun=0] 輸入本輪最多重探幾筆，≤ 0 即不重探
 * @returns {Promise} 回傳 Promise，resolve 回傳 { reprobed:Array(重探之線索，為重探前之記錄；已改回 pending、tries 歸零), stamped:Integer(補記 failedAt 者) }
 * @throws {Error} frontier 缺 select／patch 方法時拋出
 * @example
 * let rows = new Map([['c1', { id: 'c1', status: 'failed', failedAt: '2026-08-01T00:00:00Z' }], ['c2', { id: 'c2', status: 'failed' }]])
 * let frontier = {
 *     select: async (f) => [...rows.values()].filter((r) => r.status === f.status),
 *     patch: async (id, p) => { Object.assign(rows.get(id), p) },
 * }
 * let cfg = { nowMs: Date.parse('2026-09-01T00:00:00Z'), nowIso: '2026-09-01T00:00:00Z', reprobeDays: 7, perRun: 5 }
 * let r = await reprobeFailedClues(frontier, cfg)
 * console.log(r.reprobed.map((c) => c.id), r.stamped, rows.get('c1').status, rows.get('c2').failedAt)
 * // => [ 'c1' ] 1 pending 2026-09-01T00:00:00Z
 */
export async function reprobeFailedClues(frontier, cfg = {}) {
    if (!isfun(frontier?.select) || !isfun(frontier?.patch)) throw new Error('reprobeFailedClues 需要 frontier 集合（具 select/patch 方法）')
    if (!isobj(cfg)) cfg = {}
    const days = Number(cfg.reprobeDays) || 0
    const perRun = Number.isInteger(cfg.perRun) ? cfg.perRun : 0
    if (days <= 0 || perRun <= 0) return { reprobed: [], stamped: 0 }
    const nowMs = Number.isFinite(cfg.nowMs) ? cfg.nowMs : Date.now()
    const failed = await frontier.select({ status: 'failed' })
    let stamped = 0
    const due = []
    for (const c of failed) {
        const t = Date.parse(String(c.failedAt || ''))
        if (!Number.isFinite(t)) {
            await frontier.patch(c.id, { failedAt: cfg.nowIso })
            stamped++
            continue
        }
        const mult = 2 ** Math.min(Number(c.reprobes) || 0, 3)
        if (nowMs - t >= days * 86_400_000 * mult) due.push(c)
    }
    const picks = due.sort(cluePriority).slice(0, perRun)
    for (const c of picks) await frontier.patch(c.id, { status: 'pending', tries: 0, retryAt: '', reprobes: (Number(c.reprobes) || 0) + 1, reprobedAt: cfg.nowIso })
    return { reprobed: picks, stamped }
}

/**
 * 上限淘汰：pending 超過 maxPending 時把優先序最低者標 evicted（記錄保留；再被提及即復活）。
 *
 * @param {Object} frontier 輸入 frontier 集合，需具 select／patch 方法
 * @param {Object} cfg 輸入設定物件
 * @param {Integer} cfg.maxPending 輸入 pending 數量上限，≤ 0 即不設限
 * @param {String} [cfg.nowIso] 輸入現在時刻 ISO 字串(記入 evictedAt)
 * @returns {Promise} 回傳 Promise，resolve 回傳 {pending:Integer(淘汰後之 pending 數), evicted:Integer(本輪淘汰數)}
 * @throws {Error} frontier 缺 select／patch 方法時拋出
 * @example
 * let rows = new Map([
 *     ['c1', { id: 'c1', status: 'pending', hits: 1, addedAt: '2026-09-01' }],
 *     ['c2', { id: 'c2', status: 'pending', hits: 3, addedAt: '2026-09-02' }],
 *     ['c3', { id: 'c3', status: 'pending', hits: 2, addedAt: '2026-09-03' }],
 * ])
 * let frontier = {
 *     select: async (f) => [...rows.values()].filter((r) => r.status === f.status),
 *     patch: async (id, p) => { Object.assign(rows.get(id), p) },
 * }
 * console.log(await enforceFrontierCap(frontier, { maxPending: 2, nowIso: '2026-09-04T00:00:00Z' }), rows.get('c1').status)
 * // => { pending: 2, evicted: 1 } evicted
 */
export async function enforceFrontierCap(frontier, cfg) {

    //check
    if (!isfun(frontier?.select) || !isfun(frontier?.patch)) {
        throw new Error('enforceFrontierCap 需要 frontier 集合（具 select/patch 方法）')
    }

    const max = Number(cfg?.maxPending) || 0
    const pending = await frontier.select({ status: 'pending' })
    if (max <= 0 || pending.length <= max) return { pending: pending.length, evicted: 0 }
    const victims = pending.slice().sort(cluePriority).slice(max)
    for (const c of victims) await frontier.patch(c.id, { status: 'evicted', evictedAt: cfg.nowIso })
    return { pending: max, evicted: victims.length }
}

/**
 * 記錄單一線索的消化結果（成功 done；失敗記 tries，達上限轉 failed 否則留 pending）
 *
 * @param {Object} frontier 輸入 frontier 集合，需具 patch 方法
 * @param {Object} clue 輸入線索記錄(取 id、tries、retryAt)
 * @param {Object} outcome 輸入本輪消化結果物件，需含 ok（Boolean），可含 resolved(String)、yieldDocs(Number)、error(String)
 * @param {Object} [cfg={}] 輸入設定物件，非物件則回退為 {}
 * @param {String} [cfg.nowIso] 輸入現在時刻 ISO 字串
 * @param {Integer} [cfg.maxTries=2] 輸入最多重試幾次，達上限轉 failed
 * @param {Number} [cfg.backoffHours=0] 輸入失敗後之退避小時(retryAt;第 n 次失敗 backoffHours×4^(n-1);0＝不退避)
 * @returns {Promise} 回傳 Promise，resolve 回傳 { status:String('done'｜'failed'｜'pending') }
 * @throws {Error} frontier 缺 patch 方法，或 outcome 非物件時拋出
 * @example
 * let rows = new Map([['c1', { id: 'c1', status: 'pending', tries: 0 }]])
 * let frontier = { patch: async (id, p) => { Object.assign(rows.get(id), p) } }
 * let fail = { ok: false, error: '探測不到內容' }
 * console.log(await settleClue(frontier, { id: 'c1', tries: 0 }, fail), await settleClue(frontier, { id: 'c1', tries: 1 }, fail))
 * console.log(await settleClue(frontier, { id: 'c1', tries: 1 }, { ok: true, resolved: 'doc:d2', yieldDocs: 2 }), rows.get('c1').status)
 * // => { status: 'pending' } { status: 'failed' }
 * // => { status: 'done' } done
 */
export async function settleClue(frontier, clue, outcome, cfg = {}) {

    //check
    if (!isfun(frontier?.patch)) {
        throw new Error('settleClue 需要 frontier 集合（具 patch 方法）')
    }
    if (!isobj(outcome)) {
        throw new Error('settleClue 需要 outcome 物件（{ ok, resolved?, yieldDocs?, error? }）')
    }
    if (!isobj(cfg)) {
        cfg = {}
    }

    const tries = (clue.tries || 0) + 1
    if (outcome.ok) {
        await frontier.patch(clue.id, { status: 'done', tries, resolvedAt: cfg.nowIso, resolved: outcome.resolved || '', yieldDocs: outcome.yieldDocs ?? 0, ...(clue.retryAt ? { retryAt: '' } : {}) })
        return { status: 'done' }
    }
    const status = tries >= (cfg.maxTries ?? 2) ? 'failed' : 'pending'
    // 未達上限者退避(不在下一輪立即再試);轉 failed 者記 failedAt(冷卻重探之起點,reprobeFailedClues)
    const retryAt = status === 'pending' ? backoffUntil(Date.parse(String(cfg.nowIso || '')), tries, cfg.backoffHours || 0) : ''
    await frontier.patch(clue.id, { status, tries, lastError: String(outcome.error || '').slice(0, 150), ...(status === 'failed' ? { failedAt: cfg.nowIso, retryAt: '' } : (retryAt ? { retryAt } : {})) })
    return { status }
}

export default { clueKey, cluePriority, saveClues, pickClues, deferClue, reprobeFailedClues, enforceFrontierCap, settleClue }
