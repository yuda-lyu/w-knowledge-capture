// sourcePolicy.mjs — 來源管理的泛用機制：種子同步、輪抓挑選、成敗計數、品質淘汰與產出率回饋
//
// 【機制入套件，數字與判準留執行端】「連續失敗幾次停用」「零產出怎麼判定」是品質政策，
//   各知識庫不同——故門檻走 config、產出判定走注入函數；本檔只保證機制正確：
//   計數歸零時機（成功即歸零，否則跨月累積間歇性失敗會讓健康來源莫名被停用）、
//   停用可逆、宣告欄位與執行期統計分離。
// 【產出率回饋輪抓配額】下游 AI 判定（noted／skip）是來源品質的唯一事實來源；若只用它做「零產出淘汰」，
//   產出率極低但不為零的來源會與高產出來源同等競爭名額。故每輪把各來源的
//   judged／yielded 落在來源記錄上（同一次文件掃描，不另加成本），輪抓挑選時把「樣本足量且產出率
//   低於門檻」者排到同層級之末——降序不停用，記錄與名額都不丟。

import isarr from 'wsemi/src/isarr.mjs'
import isobj from 'wsemi/src/isobj.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import isnum from 'wsemi/src/isnum.mjs'
import isp0int from 'wsemi/src/isp0int.mjs'
import cdbl from 'wsemi/src/cdbl.mjs'
import cint from 'wsemi/src/cint.mjs'

/**
 * 把種子來源補進集合（已存在者不動統計），並同步宣告欄位。
 *
 * 【宣告欄位要跟著種子檔更新】種子檔是 tier／name 等欄位的唯一真理來源；
 *   不同步的話，改了種子宣告，庫裡舊記錄永遠停在建立當時的值。
 *   執行期統計（lastFetchAt／okCount／failCount／enabled）不可覆寫。
 *
 * @param {Object} sources 輸入來源集合（w-data-pipeline openCollection 介面），需具 insertNew／select／patch 方法
 * @param {Array} seeds 輸入已含 id 之種子記錄陣列（id 由執行端算好——它是去重鍵）
 * @param {Array} [declaredFields=['tier','name','lang','query']] 輸入要同步的宣告欄位字串陣列，非陣列則用預設
 * @returns {Promise} 回傳 Promise，resolve 回傳 { addCount, dupCount, synced }
 * @throws {Error} sources 缺 insertNew／select／patch 方法，或 seeds 非陣列時拋出
 * @example
 * const rows = new Map()
 * const sources = {
 *     insertNew: async (items) => {
 *         const fresh = items.filter((it) => !rows.has(it.id))
 *         fresh.forEach((it) => rows.set(it.id, { ...it }))
 *         return { addCount: fresh.length, dupCount: items.length - fresh.length }
 *     },
 *     select: async () => [...rows.values()],
 *     patch: async (id, fields) => { Object.assign(rows.get(id), fields) },
 * }
 * console.log(await ensureSeedSources(sources, [{ id: 's1', name: '天文快訊', tier: 1 }]))
 * // => { addCount: 1, dupCount: 0, synced: 0 }
 * console.log(await ensureSeedSources(sources, [{ id: 's1', name: '天文快訊', tier: 2 }]))
 * // => { addCount: 0, dupCount: 1, synced: 1 }
 * console.log(rows.get('s1').tier)
 * // => 2
 */
export async function ensureSeedSources(sources, seeds, declaredFields = ['tier', 'name', 'lang', 'query']) {

    //check
    if (!isfun(sources?.insertNew) || !isfun(sources?.select) || !isfun(sources?.patch)) {
        throw new Error('ensureSeedSources 需要 sources 集合（具 insertNew/select/patch 方法）')
    }
    if (!isarr(seeds)) {
        throw new Error('ensureSeedSources 需要 seeds（種子記錄陣列）')
    }
    if (!isarr(declaredFields)) {
        declaredFields = ['tier', 'name', 'lang', 'query']
    }

    const r = await sources.insertNew(seeds)
    const existing = new Map((await sources.select()).map((s) => [s.id, s]))
    let synced = 0
    for (const s of seeds) {
        const cur = existing.get(s.id)
        if (!cur) continue
        const patch = {}
        for (const f of declaredFields) {
            if (s[f] !== undefined && cur[f] !== s[f]) patch[f] = s[f]
        }
        if (Object.keys(patch).length) {
            await sources.patch(s.id, patch); synced++
        }
    }
    return { addCount: r.addCount, dupCount: r.dupCount, synced }
}

/**
 * 低產出判定：樣本足量（judged ≥ minJudged）且產出率低於 lowYieldRate；統計缺席者不判
 *
 * @param {Object} src 輸入來源記錄，需含 judged／yielded 統計欄位（缺席視為 0）
 * @param {Object} [opt={}] 輸入設定物件，非物件則回退為 {}
 * @param {Number} [opt.lowYieldRate] 輸入產出率門檻（0～1），未給或非正數即不判定為低產出
 * @param {Integer} [opt.minJudged=6] 輸入樣本足量之最少已判定篇數
 * @returns {Boolean} 回傳是否為低產出來源
 * @example
 * console.log(isLowYield({ judged: 10, yielded: 1 }, { lowYieldRate: 0.3, minJudged: 6 }))
 * // => true
 *
 * console.log(isLowYield({ judged: 2, yielded: 0 }, { lowYieldRate: 0.3, minJudged: 6 }))
 * // => false
 */
export function isLowYield(src, opt = {}) {

    //check
    if (!isobj(opt)) {
        opt = {}
    }
    const { lowYieldRate, minJudged } = opt

    const rate = Number(lowYieldRate)
    if (!(rate > 0)) return false
    const judged = Number(src?.judged) || 0
    if (judged < (minJudged ?? 6)) return false
    return (Number(src?.yielded) || 0) / judged < rate
}

/**
 * 挑出本輪要抓的來源：先 tier，同層級內低產出者排末，再 lastFetchAt（最舊優先）；且需超過最短重抓間隔。
 *
 * @param {Object} sources 輸入來源集合，需具 select 方法
 * @param {Object} [opt={}] 輸入設定物件，非物件則回退為 {}
 * @param {Integer} [opt.limit] 輸入本輪最多取幾筆，非非負整數(含未給)即不限（全取語意，與 frontierPolicy 之 pickClues 同一規則）
 * @param {Integer} [opt.minIntervalMs=0] 輸入最短重抓間隔毫秒數，非數值(含未給)視為 0（不設間隔，已抓過者亦到期）
 * @param {Number} [opt.lowYieldRate] 輸入產出率門檻，未給或 0 即不降序
 * @param {Integer} [opt.minJudged] 輸入樣本足量之最少已判定篇數
 * @param {Function} [opt.filter] 輸入額外篩選 (src)=>Boolean(如只挑 grid 或排除 grid;grid 與 rss 分名額挑選用)
 * @returns {Promise} 回傳 Promise，resolve 回傳到期來源陣列（依優先序排序後取前 limit 筆）；已停用(enabled false)或暫停(paused true)者不列
 * @throws {Error} sources 缺 select 方法時拋出
 * @example
 * const sources = {
 *     select: async () => [
 *         { id: 'a', tier: 2, lastFetchAt: '2026-08-01T00:00:00Z' },
 *         { id: 'b', tier: 1, lastFetchAt: '2026-08-02T00:00:00Z' },
 *         { id: 'c', tier: 1, enabled: false },
 *         { id: 'd', tier: 1, judged: 10, yielded: 0 },
 *     ],
 * }
 * console.log((await pickDueSources(sources, { lowYieldRate: 0.3 })).map((s) => s.id))
 * // => [ 'b', 'd', 'a' ]
 * console.log((await pickDueSources(sources, { lowYieldRate: 0.3, limit: 2 })).map((s) => s.id))
 * // => [ 'b', 'd' ]
 */
export async function pickDueSources(sources, opt = {}) {

    //check
    if (!isfun(sources?.select)) {
        throw new Error('pickDueSources 需要 sources 集合（具 select 方法）')
    }
    if (!isobj(opt)) {
        opt = {}
    }
    const { limit, lowYieldRate, minJudged } = opt
    // 未給 minIntervalMs 時須視為 0:否則 `now - t >= undefined` 恆為 false,已抓過之來源永不到期(只剩從未抓過者);
    // 管線內呼叫端一律帶 settings.capture.sources.minIntervalMs,故只影響直接呼叫本函數者
    let minIntervalMs = opt.minIntervalMs
    if (!isnum(minIntervalMs)) {
        minIntervalMs = 0
    }
    minIntervalMs = cdbl(minIntervalMs)

    const all = await sources.select()
    const now = Date.now()
    const extra = typeof opt.filter === 'function' ? opt.filter : null
    const due = all.filter((s) => {
        // enabled 歸品質政策(連敗／連空／零產出)單一擁有;paused 歸種子與領域同步單一擁有(領域暫停／退役、種子檔已移除)——
        //   兩欄各有其寫入者,互不覆寫(領域暫停若寫 enabled 即成第三個寫入者,恢復時會把品質政策停掉的打開)
        if (s.enabled === false || s.paused === true) return false
        if (extra && !extra(s)) return false
        if (!s.lastFetchAt) return true
        const t = Date.parse(s.lastFetchAt)
        return !Number.isFinite(t) || now - t >= minIntervalMs
    })
    const demoted = (s) => (isLowYield(s, { lowYieldRate, minJudged }) ? 1 : 0)
    due.sort((a, b) => ((a.tier || 2) - (b.tier || 2)) ||
    (demoted(a) - demoted(b)) ||
    String(a.lastFetchAt || '').localeCompare(String(b.lastFetchAt || '')))
    if (!isp0int(limit)) {
        return due
    }
    return due.slice(0, cint(limit))
}

/**
 * 記錄單一來源本輪成敗並套用停用規則。
 *
 * 【failCount 成功即歸零】停用門檻的本意是「連續」失敗 N 次；不歸零會跨月累積
 *   間歇性失敗，健康的種子來源終有一天被莫名停用且極難歸因。
 * 【空回計數只針對自動衍生來源】種子來源一時無新文不停用（人工驗證過的來源
 *   值得長期監看）；自動衍生的查詢來源連續全空即停用，否則永久佔用輪抓名額。
 *
 * @param {Object} sources 輸入來源集合，需具 patch 方法
 * @param {Object} src 輸入來源記錄
 * @param {Object} outcome 輸入本輪結果物件，需含 ok（Boolean），可含 itemCount(Number)、error(String)
 * @param {Object} [cfg={}] 輸入設定物件，非物件則回退為 {}
 * @param {String} [cfg.nowIso] 輸入現在時刻 ISO 字串
 * @param {Integer} [cfg.maxConsecFails=8] 輸入連續失敗幾次即停用(0＝永不因連敗停用)
 * @param {Integer} [cfg.maxConsecEmpty=5] 輸入自動衍生來源連續空回幾次即停用
 * @param {Function} [cfg.isAutoSource] 輸入判斷是否為自動衍生來源之函數，簽名 (src)=>Boolean
 * @param {Object} [cfg.extraPatch] 輸入成功時一併寫入之額外欄位物件(逐來源狀態推進,如 grid 翻頁;失敗時不套用)
 * @returns {Promise} 回傳 Promise，resolve 回傳 { disabled:Boolean, reason:String }
 * @throws {Error} sources 缺 patch 方法，或 outcome 非物件時拋出
 * @example
 * const rows = new Map([['s1', { id: 's1', failCount: 7 }], ['s2', { id: 's2', failCount: 3 }]])
 * const sources = { patch: async (id, fields) => { Object.assign(rows.get(id), fields) } }
 * const r1 = await recordSourceOutcome(sources, rows.get('s1'), { ok: false, error: '逾時' }, { nowIso: '2026-09-01T00:00:00Z', maxConsecFails: 8 })
 * console.log(r1, rows.get('s1').enabled)
 * // => { disabled: true, reason: '連續失敗 8 次' } false
 * const r2 = await recordSourceOutcome(sources, rows.get('s2'), { ok: true, itemCount: 5 }, { nowIso: '2026-09-01T00:00:00Z' })
 * console.log(r2, rows.get('s2').failCount)
 * // => { disabled: false, reason: '' } 0
 */
export async function recordSourceOutcome(sources, src, outcome, cfg = {}) {

    //check
    if (!isfun(sources?.patch)) {
        throw new Error('recordSourceOutcome 需要 sources 集合（具 patch 方法）')
    }
    if (!isobj(outcome)) {
        throw new Error('recordSourceOutcome 需要 outcome 物件（{ ok, itemCount?, error? }）')
    }
    if (!isobj(cfg)) {
        cfg = {}
    }

    const nowIso = cfg.nowIso
    // 停用時記時刻與原因(冷卻重探之起點,reprobeSources);停用條件以本輪計數後之記錄交 sourceStopReasonOf(與符合度掃描 CS5 同一判定)
    const disabledPatch = (reason) => ({ enabled: false, disabledAt: nowIso || '', disableReason: reason })
    if (outcome.ok) {
        const emptyCount = (outcome.itemCount || 0) === 0 ? (src.emptyCount || 0) + 1 : 0
        const reason = sourceStopReasonOf({ ...src, failCount: 0, emptyCount }, cfg)
        await sources.patch(src.id, {
            lastFetchAt: nowIso,
            okCount: (src.okCount || 0) + 1,
            failCount: 0,
            lastError: '',
            emptyCount,
            ...(reason ? disabledPatch(reason) : { enabled: true }),
            ...(cfg.extraPatch || {}),
        })
        return { disabled: !!reason, reason }
    }
    // 失敗不套 extraPatch:它是「成功後之逐來源狀態推進」(如 grid 翻頁 cursor),失敗時推進即漏頁
    const failCount = (src.failCount || 0) + 1
    const reason = sourceStopReasonOf({ ...src, failCount }, cfg)
    await sources.patch(src.id, {
        lastFetchAt: nowIso,
        failCount,
        lastError: String(outcome.error || '').slice(0, 200),
        ...(reason ? disabledPatch(reason) : { enabled: true }),
    })
    return { disabled: !!reason, reason }
}

/**
 * 來源依已記計數是否已達停用條件(CS5 之單一判定:recordSourceOutcome 之停用與符合度掃描同用):
 *   連敗(failCount ≥ maxConsecFails;0＝永不因連敗停用)、自動衍生來源連空(emptyCount ≥ maxConsecEmpty;isAutoSource 判定)。
 *   零產出另由 cullZeroYieldSources 以文件統計判(本函數不判)
 *
 * @param {Object} src 輸入來源記錄(讀 failCount、emptyCount)
 * @param {Object} [cfg={}] 輸入 { maxConsecFails=8, maxConsecEmpty=5, isAutoSource }
 * @returns {String} 回傳停用原因;未達條件回 ''
 * @example
 * console.log(sourceStopReasonOf({ failCount: 8 }, { maxConsecFails: 8 }))
 * // => 連續失敗 8 次
 *
 * console.log(sourceStopReasonOf({ failCount: 8 }, { maxConsecFails: 0 }))
 * // =>
 */
export function sourceStopReasonOf(src, cfg = {}) {
    if (!isobj(cfg)) cfg = {}
    const failCount = Number(src?.failCount) || 0
    // maxConsecFails 0＝永不因連敗停用(零件庫用法:來源由使用端管理)
    const maxFails = cfg.maxConsecFails ?? 8
    if (maxFails > 0 && failCount >= maxFails) return `連續失敗 ${failCount} 次`
    // 空回計數只針對自動衍生來源(種子來源一時無新文不停用)
    const emptyCount = Number(src?.emptyCount) || 0
    const maxEmpty = cfg.maxConsecEmpty ?? 5
    if (maxEmpty > 0 && emptyCount >= maxEmpty && !!cfg.isAutoSource?.(src)) return `連續 ${emptyCount} 次無資料`
    return ''
}

/** 來源記錄之時刻欄(ISO 字串)與計數欄(非負整數):給了即須合形狀(符合度掃描 CS5 之記錄形狀判定) */
const SOURCE_TIME_FIELDS = Object.freeze(['lastFetchAt', 'disabledAt', 'windowFrom', 'reprobedAt'])
const SOURCE_COUNT_FIELDS = Object.freeze(['okCount', 'failCount', 'emptyCount', 'judged', 'yielded', 'reprobes', 'chainFails'])

/**
 * 來源記錄之執行期欄位形狀問題(CS5 存量掃描:本套件寫入之欄位給了即須合形狀;未給者不判——手動停用可無原因,舊記錄可缺時刻):
 *   時刻欄須為可解析之 ISO 字串、計數欄須為非負整數、enabled／paused 為布林、disableReason／lastError 為字串
 *
 * @param {Object} src 輸入來源記錄
 * @returns {Array} 回傳問題字串陣列(無問題回 [])
 * @example
 * console.log(sourceRecordProblems({ id: 'a', enabled: false, disabledAt: '2026-01-01T00:00:00Z', failCount: 8 }))
 * // => []
 *
 * console.log(sourceRecordProblems({ id: 'a', disabledAt: 'yesterday' }))
 * // => [ 'disabledAt 非時刻字串' ]
 */
export function sourceRecordProblems(src) {
    if (!isobj(src)) return ['記錄非物件']
    const given = (v) => v !== undefined && v !== null && v !== ''
    const p = []
    for (const k of SOURCE_TIME_FIELDS) if (given(src[k]) && (typeof src[k] !== 'string' || !Number.isFinite(Date.parse(src[k])))) p.push(`${k} 非時刻字串`)
    for (const k of SOURCE_COUNT_FIELDS) if (given(src[k]) && !(Number.isInteger(src[k]) && src[k] >= 0)) p.push(`${k} 非非負整數`)
    for (const k of ['enabled', 'paused']) if (src[k] !== undefined && src[k] !== null && typeof src[k] !== 'boolean') p.push(`${k} 非布林`)
    for (const k of ['disableReason', 'lastError']) if (src[k] !== undefined && src[k] !== null && typeof src[k] !== 'string') p.push(`${k} 非字串`)
    return p
}

/**
 * 逐來源鏈異常之落帳(程式／環境問題,與抓取失敗分帳):記 chainFails 與 lastError、更新 lastFetchAt(排到最舊優先之隊尾,
 *   不擋隊頭),**不加 failCount、不停用**——若與抓取失敗共用 failCount,連 8 次即停用並進 30 天冷卻,程式修好後也要等冷卻
 *
 * @param {Object} sources 輸入來源集合，需具 patch 方法
 * @param {Object} src 輸入來源記錄
 * @param {Object} [cfg={}] 輸入 { nowIso, error }
 * @param {String} [cfg.nowIso] 輸入現在時刻 ISO 字串(記為 lastFetchAt)
 * @param {String} [cfg.error] 輸入異常說明(記為 lastError,至多 200 字)
 * @returns {Promise} 回傳 Promise，resolve 回傳 { chainFails:Integer }
 * @throws {Error} sources 缺 patch 方法時拋出
 * @example
 * const rows = new Map([['s1', { id: 's1', chainFails: 1 }]])
 * const sources = { patch: async (id, fields) => { Object.assign(rows.get(id), fields) } }
 * const r = await recordSourceChainFail(sources, rows.get('s1'), { nowIso: '2026-09-01T00:00:00Z', error: '解析鏈拋錯' })
 * console.log(r)
 * // => { chainFails: 2 }
 * console.log(rows.get('s1').lastError)
 * // => 解析鏈拋錯
 */
export async function recordSourceChainFail(sources, src, cfg = {}) {
    if (!isfun(sources?.patch)) throw new Error('recordSourceChainFail 需要 sources 集合（具 patch 方法）')
    if (!isobj(cfg)) cfg = {}
    const chainFails = (Number(src?.chainFails) || 0) + 1
    await sources.patch(src.id, { lastFetchAt: cfg.nowIso, chainFails, lastError: String(cfg.error || '').slice(0, 200) })
    return { chainFails }
}

/**
 * 零產出來源淘汰＋產出統計落帳：已判定樣本夠多且產出掛零者停用；每來源之 judged／yielded 有變即寫回
 * 來源記錄（供輪抓挑選之產出率回饋與巡檢／工具檢視）。
 *
 * 【判準：產出掛零，而非丟棄率高】混合型來源有真產出，以丟棄率淘汰就是誤殺；
 *   判定數據由注入的 judge 提供（通常自文件集統計 AI 已做過的逐篇分類），
 *   不引入新的猜測。停用可逆：手動 enable 後若產出首篇即不再觸發。
 *
 * @param {Object} sources 輸入來源集合，需具 select／patch 方法
 * @param {Function} judgeOf 輸入每來源的判定統計函數，簽名 (src)=>{judged:Number, yielded:Number}|null
 * @param {Object} [cfg={}] 輸入設定物件，非物件則回退為 {}
 * @param {Integer} [cfg.minJudged=6] 輸入樣本足量之最少已判定篇數
 * @param {String} [cfg.nowIso=''] 輸入現在時刻(停用時刻,冷卻重探之起點)
 * @param {Object} [cfg.log] 輸入 logger 物件（用 warn 記錄自動停用）
 * @returns {Promise} 回傳 Promise，resolve 回傳 { culled:Integer, synced:Integer }
 * @throws {Error} sources 缺 select／patch 方法，或 judgeOf 非函數時拋出
 * @example
 * const rows = new Map([['s1', { id: 's1', name: '示範站', enabled: true }], ['s2', { id: 's2', name: '產出站', enabled: true }]])
 * const sources = {
 *     select: async () => [...rows.values()].map((r) => ({ ...r })),
 *     patch: async (id, fields) => { Object.assign(rows.get(id), fields) },
 * }
 * const judgeOf = (s) => (s.id === 's1' ? { judged: 8, yielded: 0 } : { judged: 8, yielded: 3 })
 * console.log(await cullZeroYieldSources(sources, judgeOf, { nowIso: '2026-09-01T00:00:00Z' }))
 * // => { culled: 1, synced: 2 }
 * console.log(rows.get('s1').enabled, rows.get('s1').disableReason)
 * // => false 已判定 8 篇產出 0，自動停用
 */
export async function cullZeroYieldSources(sources, judgeOf, cfg = {}) {

    //check
    if (!isfun(sources?.select) || !isfun(sources?.patch)) {
        throw new Error('cullZeroYieldSources 需要 sources 集合（具 select/patch 方法）')
    }
    if (!isfun(judgeOf)) {
        throw new Error('cullZeroYieldSources 需要 judgeOf 函數')
    }
    if (!isobj(cfg)) {
        cfg = {}
    }

    const minJudged = cfg.minJudged ?? 6
    let culled = 0
    let synced = 0
    for (const s of await sources.select()) {
        const j = judgeOf(s)
        if (j && ((s.judged || 0) !== j.judged || (s.yielded || 0) !== j.yielded)) {
            await sources.patch(s.id, { judged: j.judged, yielded: j.yielded })
            synced++
        }
        if (s.enabled === false) continue
        if (!j || j.yielded > 0 || j.judged < minJudged) continue
        const reason = `已判定 ${j.judged} 篇產出 0，自動停用`
        await sources.patch(s.id, { enabled: false, lastError: reason, disabledAt: cfg.nowIso || '', disableReason: reason })
        cfg.log?.warn?.(`來源[${s.name}] 已判定 ${j.judged} 篇、產出 0，自動停用`)
        culled++
    }
    return { culled, synced }
}

/** 冷卻倍增之上限倍數(重探 n 次後之冷卻＝reprobeDays × min(2^n, 本值)) */
export const REPROBE_MAX_BACKOFF = 8

/**
 * 冷卻是否已滿(來源停用與自動領域暫停之重探共用同一判定):起點 + reprobeDays × min(2^重探次數, REPROBE_MAX_BACKOFF) 天 ≤ 現在
 *
 * @param {String} sinceIso 輸入冷卻起點(停用或暫停之時刻)
 * @param {Integer} tries 輸入已重探次數
 * @param {Number} nowMs 輸入現在時刻毫秒
 * @param {Number} reprobeDays 輸入基本冷卻天數(≤0 即不重探)
 * @returns {Boolean} 回傳是否已滿
 * @example
 * console.log(reprobeDue('2020-01-01T00:00:00Z', 0, Date.parse('2020-02-01T00:00:00Z'), 30))
 * // => true
 *
 * console.log(reprobeDue('2020-01-01T00:00:00Z', 1, Date.parse('2020-02-01T00:00:00Z'), 30))
 * // => false
 */
export function reprobeDue(sinceIso, tries, nowMs, reprobeDays) {
    const t = Date.parse(sinceIso || '')
    if (!(reprobeDays > 0) || !Number.isFinite(t) || !Number.isFinite(nowMs)) return false
    return nowMs - t >= reprobeDays * Math.min(2 ** (Number(tries) || 0), REPROBE_MAX_BACKOFF) * 86400_000
}

/**
 * 新觀察窗之欄位(重探、手動恢復共用):連敗、連空、產出統計與新件率自本刻起算
 *
 * @param {String} [nowIso] 輸入新觀察窗起點之 ISO 時刻字串(未給記為空字串)
 * @returns {Object} 回傳要寫回來源記錄之欄位 { windowFrom, failCount:0, emptyCount:0, lastError:'', judged:0, yielded:0, freshHist:[] }
 * @example
 * console.log(freshWindowPatch('2026-09-01T00:00:00Z'))
 * // => {
 * //   windowFrom: '2026-09-01T00:00:00Z',
 * //   failCount: 0,
 * //   emptyCount: 0,
 * //   lastError: '',
 * //   judged: 0,
 * //   yielded: 0,
 * //   freshHist: []
 * // }
 */
export const freshWindowPatch = (nowIso) => ({ windowFrom: nowIso || '', failCount: 0, emptyCount: 0, lastError: '', judged: 0, yielded: 0, freshHist: [] })

/**
 * 冷卻重探(CS5):被品質政策停用(enabled false)之來源,冷卻期滿即重新啟用並開新觀察窗——
 *   試抓:新窗內再達停用條件(連敗、連空、零產出;產出統計只計窗內之判定,judgeFromDocs 之 since)即再停用,冷卻依重探次數倍增。
 *   每輪至多 reprobePerRun 個(停用最久者先),以免一次湧入大量待判文件(進料不得超過下游處理容量)。
 *   停用時刻未記者(由他處寫入 enabled false)以首次觀察為冷卻起點(記 disabledAt,本輪不重探)
 *
 * @param {Object} sources 輸入來源集合，需具 select／patch 方法
 * @param {Object} [cfg={}] 輸入設定物件
 * @param {String} cfg.nowIso 輸入現在時刻
 * @param {Number} [cfg.reprobeDays=0] 輸入基本冷卻天數(0＝不重探)
 * @param {Integer} [cfg.reprobePerRun=0] 輸入每輪至多重探數(0＝不重探)
 * @param {Object} [cfg.log] 輸入 logger 物件(info 記錄重探)
 * @returns {Promise} 回傳 Promise，resolve 回傳 { reprobed:Array(來源 id), stamped:Integer(補記停用時刻數), due:Integer(冷卻已滿數) }
 * @throws {Error} sources 缺 select／patch 方法時拋出
 * @example
 * const rows = new Map([['s1', { id: 's1', name: '示範站', enabled: false, disabledAt: '2026-01-01T00:00:00Z', reprobes: 0 }]])
 * const sources = {
 *     select: async () => [...rows.values()].map((r) => ({ ...r })),
 *     patch: async (id, fields) => { Object.assign(rows.get(id), fields) },
 * }
 * console.log(await reprobeSources(sources, { nowIso: '2026-03-01T00:00:00Z', reprobeDays: 30, reprobePerRun: 2 }))
 * // => { reprobed: [ 's1' ], stamped: 0, due: 1 }
 * console.log(rows.get('s1').enabled, rows.get('s1').reprobes)
 * // => true 1
 */
export async function reprobeSources(sources, cfg = {}) {

    //check
    if (!isfun(sources?.select) || !isfun(sources?.patch)) {
        throw new Error('reprobeSources 需要 sources 集合（具 select/patch 方法）')
    }
    if (!isobj(cfg)) {
        cfg = {}
    }

    const out = { reprobed: [], stamped: 0, due: 0 }
    const days = Number(cfg.reprobeDays) || 0
    const perRun = Number(cfg.reprobePerRun) || 0
    const nowMs = Date.parse(cfg.nowIso || '')
    if (!(days > 0) || !(perRun > 0) || !Number.isFinite(nowMs)) return out
    const due = []
    for (const s of await sources.select()) {
        if (s.enabled !== false) continue
        if (!Number.isFinite(Date.parse(s.disabledAt || ''))) {
            await sources.patch(s.id, { disabledAt: cfg.nowIso })
            out.stamped++
            continue
        }
        if (reprobeDue(s.disabledAt, s.reprobes, nowMs, days)) due.push(s)
    }
    out.due = due.length
    due.sort((a, b) => String(a.disabledAt).localeCompare(String(b.disabledAt)) || String(a.id).localeCompare(String(b.id)))
    for (const s of due.slice(0, perRun)) {
        await sources.patch(s.id, { enabled: true, ...freshWindowPatch(cfg.nowIso), reprobes: (Number(s.reprobes) || 0) + 1, reprobedAt: cfg.nowIso })
        out.reprobed.push(s.id)
        cfg.log?.info?.(`來源[${s.name || s.id}] 冷卻期滿重探（第 ${(Number(s.reprobes) || 0) + 1} 次；原停用：${String(s.disableReason || s.lastError || '').slice(0, 60)}），新觀察窗自本刻起算`)
    }
    return out
}

export default { ensureSeedSources, isLowYield, pickDueSources, recordSourceOutcome, sourceStopReasonOf, sourceRecordProblems, recordSourceChainFail, cullZeroYieldSources, reprobeDue, freshWindowPatch, reprobeSources, REPROBE_MAX_BACKOFF }
