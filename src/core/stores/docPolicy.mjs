// docPolicy.mjs — 文件生命週期的泛用機制：終態瘦身
//
// 【狀態機約定（終態集合＝DOC_TERMINAL_STATUSES；文件維護子階段之 opt.terminalStatuses 可另給，機制不變）】
//   new → raw（有素材，待下游處理）→ noted／skip（下游已處理）
//   new → dead（全文試滿 capture.articles.maxTries，確定抓不到）；raw → summarize-failed（下游連續失敗出隊）
//   aggregated（彙整貼文，已轉錄連結）
//
// 【沒有時間型過期】知識庫的文章價值與新舊無關；丟棄只能發生在「AI 判定非知識（skip）」或
//   「確定抓不到（dead）」之後，不存在「逾期」。時間型過期是新聞爬蟲假設：FIFO 下抓過失敗者下輪必再輪到，
//   時間型過期唯一會觸發的情境是高層級洪水餓死低層級——而那是容量告警不是丟棄理由。
//
// 【記錄永不刪除】終態文件只清素材欄位不刪記錄——記錄本身就是去重憑證
//   （w-data-pipeline seen store 的設計前提），刪了同一 url 會被重新收錄。

import isarr from 'wsemi/src/isarr.mjs'
import isobj from 'wsemi/src/isobj.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import { queueAge } from '../util/queueAge.mjs'
import { DOC_TEXT_STATUSES, archiveDocText } from './docTexts.mjs'

/**
 * 文件狀態之值(單一宣告;跨套件之資料契約:下游讀寫文件狀態一律取此常數,不另寫字面):new 待補全文、raw 有素材待下游處理、
 *   noted 下游已成產物、skip 下游已判定無產物、dead 確定抓不到、aggregated 彙整貼文已轉錄、summarizeFailed 下游連續失敗出隊
 *
 * @type {Object}
 */
export const DOC_STATUS = Object.freeze({ new: 'new', raw: 'raw', noted: 'noted', skip: 'skip', dead: 'dead', aggregated: 'aggregated', summarizeFailed: 'summarize-failed' })

/**
 * 文件之終態(不再被管線處理者;待處理之兩態見 DOC_PENDING_STATUSES)
 *
 * @type {Array}
 */
export const DOC_TERMINAL_STATUSES = Object.freeze([DOC_STATUS.noted, DOC_STATUS.skip, DOC_STATUS.dead, DOC_STATUS.aggregated, DOC_STATUS.summarizeFailed])

/**
 * 文件之待處理兩態:new(待補全文)、raw(有素材,待下游處理)
 *
 * @type {Array}
 */
export const DOC_PENDING_STATUSES = Object.freeze([DOC_STATUS.new, DOC_STATUS.raw])

/**
 * 文件狀態機之全集(待處理兩態＋終態)。外部巡檢以之判「未定義狀態」——多出來的狀態即「未判定即丟棄」類機制被重新引入之訊號;
 *   巡檢一律取此常數,不自列(本套件增減狀態時兩端同動)
 *
 * @type {Array}
 */
export const DOC_STATUSES = Object.freeze([...DOC_PENDING_STATUSES, ...DOC_TERMINAL_STATUSES])

/**
 * 終態文件瘦身：清掉 docs 中不再會被讀到的原文素材。
 * 全表 select 的成本隨總位元組線性成長——現在清成本近零，事後補救要停機整理。
 * 【先另存再清】檢定標準調整時，下游產物（如依原文產出之摘要）須以原文重檢其數字紮根、忠實性、相關性，故給了 cfg.archive(docTexts 集合)時,
 *   cfg.archiveStatuses 內之終態先另存原文(core/stores/docTexts),回讀一致才清;另存失敗者本輪不清(不丟材料)。
 *
 * @param {Object} docs 輸入文件集合，需具 select／patch 方法
 * @param {Object} [cfg={}] 輸入設定物件，非物件則回退為 {}
 * @param {Array} cfg.terminalStatuses 輸入終態狀態字串陣列（必填；非陣列即拋錯）
 * @param {Array} [cfg.textFields=['text','feedText']] 輸入要清空的素材欄位字串陣列，非陣列則用預設
 * @param {Object} [cfg.archive] 輸入原文另存集合(docTexts;需 get／replace);未給則不另存(只清)
 * @param {Array} [cfg.archiveStatuses=DOC_TEXT_STATUSES] 輸入須另存原文之終態
 * @param {String} [cfg.nowIso=''] 輸入另存時刻
 * @returns {Promise} 回傳 Promise，resolve 回傳 { slimmed:Integer(已清空素材之文件數), freedBytes:Integer(釋放之字元數), archived:Integer(本輪新寫入另存者),
 *   archiveFailed:Integer(另存失敗而本輪未清者) }
 * @throws {Error} docs 缺 select／patch 方法，或 cfg.terminalStatuses 非陣列時拋出
 * @example
 * let rows = [{ id: 'd1', status: 'noted', text: '黑洞光譜', feedText: '' }, { id: 'd2', status: 'new', text: '待補全文' }]
 * let docs = {
 *     select: async (f) => rows.filter((r) => r.status === f.status),
 *     patch: async (id, p) => Object.assign(rows.find((r) => r.id === id), p),
 * }
 * let saved = new Map()
 * let archive = { get: async (id) => saved.get(id) ?? null, replace: async (rec) => { saved.set(rec.id, rec) } }
 * let r = await slimTerminalDocs(docs, { terminalStatuses: ['noted', 'dead'], archive, nowIso: '2026-09-01T00:00:00Z' })
 * console.log(r, rows[0].text === '', rows[0].textLength, saved.has('d1'))
 * // => { slimmed: 1, freedBytes: 4, archived: 1, archiveFailed: 0 } true 4 true
 */
export async function slimTerminalDocs(docs, cfg = {}) {

    //check
    if (!isfun(docs?.select) || !isfun(docs?.patch)) {
        throw new Error('slimTerminalDocs 需要 docs 集合（具 select/patch 方法）')
    }
    if (!isobj(cfg)) {
        cfg = {}
    }
    if (!isarr(cfg.terminalStatuses)) {
        throw new Error('slimTerminalDocs 需要 cfg.terminalStatuses（狀態陣列）')
    }
    let textFields = cfg.textFields
    if (!isarr(textFields)) {
        textFields = ['text', 'feedText']
    }

    const terminal = cfg.terminalStatuses
    const fields = textFields
    const archive = isobj(cfg.archive) ? cfg.archive : null
    const archiveStatuses = isarr(cfg.archiveStatuses) ? cfg.archiveStatuses : DOC_TEXT_STATUSES
    let slimmed = 0
    let freed = 0
    let archived = 0
    let archiveFailed = 0
    for (const st of terminal) {
        for (const d of await docs.select({ status: st })) {
            const n = fields.reduce((a, f) => a + String(d[f] || '').length, 0)
            if (n === 0) continue
            if (archive && archiveStatuses.includes(st)) {
                const r = await archiveDocText(archive, d, cfg.nowIso)
                if (!r.ok) {
                    archiveFailed++
                    continue
                }
                if (!r.same) archived++
            }
            const patch = { textLength: d.textLength || n }
            for (const f of fields) patch[f] = ''
            await docs.patch(d.id, patch)
            slimmed++
            freed += n
        }
    }
    return { slimmed, freedBytes: freed, archived, archiveFailed }
}

/**
 * 待處理佇列的選取順序(補全文與下游處理共用):tries 升冪 → tier 升冪 → collectedAt 升冪。
 *
 * 【tries 擺第一:失敗件排隊末(隊頭防阻塞)】失敗者退回佇列時保留原 collectedAt,若只按 collectedAt 排
 *   就永遠黏在隊頭、每輪重耗名額直到試滿——隊頭被已知會失敗之件(如包裝頁、401／403)占滿,每輪只剩少數名額給其餘件;
 *   下游處理側同一批壞批永遠排隊頭則整條線被擋死。
 * 【tier 次之】來源品質優先;層內 FIFO(先收先處理)。若改為 collectedAt 降冪(最新優先):同層級沒搶到名額者
 *   每輪被更新者擠掉直到過期——對新聞合理,對知識庫是丟棄機制。
 * 【一份比較器】補全文與下游處理共用同一份三段比較:規則若各寫一份,改一處另一處必漂移。
 *
 * 【鏈異常另計而同樣排隊尾】程式／環境之逐項鏈異常記於另一欄(如 fetchChainFails),不入判死次數;
 *   排序以兩欄之和(opt.plus),鏈異常者仍排隊尾、不擋隊頭。
 *
 * @param {String} [triesField='fetchTries'] 輸入排序依據欄位名字串(如 'fetchTries')，非有效字串則用預設
 * @param {Object} [opt={}] 輸入設定物件
 * @param {String} [opt.plus] 輸入排序時一併加計之欄位名(鏈異常次數)
 * @returns {Function} 回傳比較器函數 (a:Object, b:Object)=>Number，供 Array.prototype.sort 使用
 * @example
 * let rows = [{ fetchTries: 1, sourceTier: 1, collectedAt: '2026-09-01' }, { fetchTries: 0, sourceTier: 2, collectedAt: '2026-09-02' }]
 * console.log(rows.sort(byRetryTierFifo('fetchTries')).map((r) => r.fetchTries))
 * // => [ 0, 1 ]
 */
export function byRetryTierFifo(triesField = 'fetchTries', opt = {}) {

    //check
    if (!isestr(triesField)) {
        triesField = 'fetchTries'
    }
    const plus = isestr(opt?.plus) ? opt.plus : ''

    const n = (r) => (r[triesField] || 0) + (plus ? (r[plus] || 0) : 0)
    return (a, b) => n(a) - n(b) ||
    (a.sourceTier || 2) - (b.sourceTier || 2) ||
    String(a.collectedAt || '').localeCompare(String(b.collectedAt || ''))
}

/**
 * 暫時性失敗之退避期限:第 n 次失敗後 hours×4^(n-1) 小時(6 時、24 時、96 時…);hours ≤ 0 不退避
 *
 * @param {Number} nowMs 輸入現在時刻(毫秒)
 * @param {Integer} n 輸入累計失敗次數(≥1)
 * @param {Number} hours 輸入首次退避小時(settings.capture.articles.retryBackoffHours)
 * @returns {String} 回傳退避期限 ISO 字串(不退避回 '')
 * @example
 * console.log(backoffUntil(Date.parse('2026-10-05T00:00:00Z'), 2, 6))
 * // => 2026-10-06T00:00:00.000Z
 */
export function backoffUntil(nowMs, n, hours) {
    const h = Number(hours) || 0
    if (!(h > 0) || !Number.isFinite(nowMs)) return ''
    const k = Math.max(1, Math.floor(Number(n) || 1))
    return new Date(nowMs + h * 3_600_000 * 4 ** (k - 1)).toISOString()
}

/**
 * 是否仍在退避期內(retryAt 晚於現在)
 *
 * @param {Object} row 輸入記錄(取 retryAt)
 * @param {Number} nowMs 輸入現在時刻(毫秒)
 * @returns {Boolean} 回傳是否退避中
 * @example
 * console.log(inBackoff({ retryAt: '2999-01-01T00:00:00Z' }, Date.now()), inBackoff({}, Date.now()))
 * // => true false
 */
export function inBackoff(row, nowMs) {
    const t = Date.parse(String(row?.retryAt || ''))
    return Number.isFinite(t) && t > nowMs
}

/**
 * 待抓佇列之分法(唯一規則;補全文段之取件、剔除清單之待辦、外部巡檢同用——三處各寫一份即分歧):
 *   status new 之文件分補全文佇列(main)與瀏覽器佇列(browser:指名瀏覽器 fetcher 'browser');瀏覽器佇列停用(browserOn 為假;
 *   見 stores/fetchPolicy 之 browserQueueOn)時指名瀏覽器者併回補全文佇列(否則永遠卡在一個不被消化之佇列)。
 *   補全文佇列再分退避中(backoff:retryAt 未到,本輪不取,inBackoff)與可取(ready);可取者分未試(untried:fetchTries 0)與重試(retry)
 *
 * @param {Array} docs 輸入文件陣列(只取 status new 者;非陣列視為空)
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Number} [opt.nowMs=Date.now()] 輸入現在時刻毫秒(退避判斷)
 * @param {Boolean} [opt.browserOn=true] 輸入瀏覽器佇列是否開啟
 * @returns {Object} 回傳 { news, main, ready, backoff, untried, retry, browser }(各為文件陣列;main＝ready＋backoff,ready＝untried＋retry)
 * @example
 * const q = docQueuesOf([{ status: 'new' }, { status: 'new', fetcher: 'browser' }, { status: 'new', fetchTries: 1 }, { status: 'raw' }])
 * console.log(q.news.length, q.untried.length, q.retry.length, q.browser.length)
 * // => 3 1 1 1
 */
export function docQueuesOf(docs, opt = {}) {
    if (!isobj(opt)) opt = {}
    const nowMs = Number.isFinite(opt.nowMs) ? opt.nowMs : Date.now()
    const browserOn = opt.browserOn !== false
    const news = (isarr(docs) ? docs : []).filter((d) => d?.status === 'new')
    const browser = browserOn ? news.filter((d) => d.fetcher === 'browser') : []
    const main = browserOn ? news.filter((d) => d.fetcher !== 'browser') : news
    const backoff = main.filter((d) => inBackoff(d, nowMs))
    const ready = main.filter((d) => !inBackoff(d, nowMs))
    const tried = (d) => Number(d.fetchTries) > 0
    return { news, main, ready, backoff, untried: ready.filter((d) => !tried(d)), retry: ready.filter(tried), browser }
}

/**
 * 待抓佇列之計數與最舊天數(docQueuesOf 之同一分法;剔除清單之待辦、外部巡檢、補全文段之日誌同用):各佇列之等待依其進佇列時刻——
 *   補全文各組以 collectedAt(收錄時刻)、瀏覽器佇列以 deferredAt(進佇列時刻;缺則 collectedAt——回收之舊件 collectedAt 已數十天,
 *   用它量會把剛進佇列者誤判為久候)
 *
 * @param {Array} docs 輸入文件陣列
 * @param {Object} [opt={}] 輸入 { nowMs, browserOn }(同 docQueuesOf)
 * @returns {Object} 回傳 { total(new 總數), news(全部 new,依收錄時刻), main, backoff, untried, retry, browser }(total 以外各 { count, oldestDays })
 * @example
 * const now = Date.parse('2026-10-06T00:00:00Z')
 * console.log(docQueueStatsOf([{ status: 'new', collectedAt: '2026-10-01T00:00:00Z' }], { nowMs: now }).main)
 * // => { count: 1, oldestDays: 5 }
 */
export function docQueueStatsOf(docs, opt = {}) {
    if (!isobj(opt)) opt = {}
    const nowMs = Number.isFinite(opt.nowMs) ? opt.nowMs : Date.now()
    const q = docQueuesOf(docs, { ...opt, nowMs })
    const age = (rows) => queueAge(rows, 'collectedAt', nowMs)
    return {
        total: q.news.length,
        news: age(q.news),
        main: age(q.main),
        backoff: age(q.backoff),
        untried: age(q.untried),
        retry: age(q.retry),
        browser: queueAge(q.browser.map((d) => ({ at: d.deferredAt || d.collectedAt })), 'at', nowMs),
    }
}

export default { DOC_STATUS, DOC_TERMINAL_STATUSES, DOC_PENDING_STATUSES, DOC_STATUSES, slimTerminalDocs, byRetryTierFifo, backoffUntil, inBackoff, docQueuesOf, docQueueStatsOf }
