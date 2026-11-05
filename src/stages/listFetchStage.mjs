// listFetchStage.mjs — 抓取物件子階段 a2:來源輪抓入庫(逐來源動作鏈)
//
// hook 錨點:capture.listFetch.{fetchList, normalizeItems, filterItems, admitPersist, accountSource}
// 逐來源一條 msg(topic:'source')流過五環;來源失敗記於 _outcome、續走 accountSource 計帳。
// 契約檢查／業務過濾／去重入庫三環是 stores/ingestGate 三步的可掛載投影(探測入庫走同一閘門);
// 抓取嘗試復用 w-data-pipeline 內件(attemptFetch)——行為與 runListFetch 一致,但每一環都可掛載/置換。

import isobj from 'wsemi/src/isobj.mjs'
import { attemptFetch } from 'w-data-pipeline/src/fetch/attemptFetch.mjs'
import { isTimeoutError, ContractError } from 'w-data-pipeline/src/core/errors.mjs'
import { defineMw, applyTaps, makeMsg, count, runChainOverMsgs, stdReport, stageFields } from '../core/kernel.mjs'
import { oneline } from '../core/runnerPackage.mjs'
import { stageReserveFnOf, stageReserveGateOf, stageStepMsOf, fetchStepMsOf, reserveNoteOf } from '../core/util/stageReserve.mjs'
import { pickDueSources, recordSourceOutcome, recordSourceChainFail } from '../stores/sourcePolicy.mjs'
import { normalizeFeedItems, filterFeedItems, admitFeedItems } from '../stores/ingestGate.mjs'
import { httpCodeOf } from '../stores/fetchPolicy.mjs'
import { netDownAtStart, netDownNow } from '../core/util/netGuard.mjs'

/**
 * 來源抓取失敗是否可能出自本機網路:抓取／逾時類且訊息不含 HTTP 狀態(407 除外);契約不符(抓取器實作錯誤)不是
 *
 * @param {Object} outcome 輸入本輪結果 { ok, reason, error }
 * @returns {Boolean} 回傳是否須先確認網路
 */
function sourceMayBeNetFailure(outcome) {
    if (outcome?.ok || outcome?.reason === 'contract-error') return false
    const code = httpCodeOf({ message: outcome?.error })
    return code === 0 || code === 407
}

/**
 * mw 錨點 capture.listFetch.fetchList:執行抓取(含 fetcher 自宣告之 timeout/重試);失敗記 _outcome 不短路——計帳環仍要走
 *
 * 讀 msg.data._fetcher／msg.data(來源記錄);成功寫 msg.data._raw,失敗寫 msg.data._outcome 並 count(msg,'srcFail')。不短路。
 * 抓取器自行略過之項目(抓取器於來源訊息上標 _dropped:{ 原因: 數 },如 grid 摘要過短／亂碼／無網址)逐因計入 count(msg,'dropped_<原因>')
 * (靜默剔除改計數,使「這輪沒新資料」可歸因)。無 opt 參數。
 *
 * @returns {Object} 回傳 defineMw 產物
 * @example
 * // W 為 w-data-pipeline 之預設匯出(import W from 'w-data-pipeline/src/WDataPipeline.mjs')
 * let fetcher = W.defineFetcher({ id: 'rss', kinds: ['rss'], fetch: async () => [{ url: 'https://example.com/post/1', title: '黑洞光譜' }] })
 * let ctx = { deps: { settings: { capture: { sources: {} } } }, log: { info() {}, warn() {} } }
 * let run = composeChain([mwFetchList()])
 * let { msg } = await run(makeMsg('source', { name: '天文新聞', url: 'https://example.com/feed', _fetcher: fetcher }), ctx)
 * console.log(msg.data._raw, msg.data._outcome)
 * // => [ { url: 'https://example.com/post/1', title: '黑洞光譜' } ] undefined
 *
 * // 抓取拋錯:記 _outcome 並計 srcFail,但不短路(計帳環仍要走)
 * let bad = W.defineFetcher({ id: 'rss', kinds: ['rss'], fetch: async () => { throw new Error('HTTP 503') } })
 * let r2 = await run(makeMsg('source', { name: '天文新聞', url: 'https://example.com/feed', _fetcher: bad }), ctx)
 * console.log(r2.msg.data._outcome, r2.msg.stats, JSON.stringify(r2.halted))
 * // => { ok: false, reason: 'fetch-error', error: 'HTTP 503' } { srcFail: 1 } ""
 */
export const mwFetchList = () => defineMw({
    name: 'fetchList',
    handle: async (msg, ctx, next) => {
        const src = msg.data
        try {
            // 逾時:抓取器自宣告者優先,未宣告者用 settings.capture.sources.listTimeoutMs(與 detail 之 capture.articles.timeoutMs 退路對稱;兩者皆無才為 0＝無逾時)
            msg.data._raw = await attemptFetch(src._fetcher, src, ctx, src._fetcher.timeoutMs || ctx.deps.settings?.capture?.sources?.listTimeoutMs || 0)
            for (const [k, n] of Object.entries(isobj(src._dropped) ? src._dropped : {})) if (Number(n) > 0) count(msg, `dropped_${k}`, Number(n))
            // grid 因 OpenAlex 429(額度用盡或每秒超限)而改走 arXiv:計入 gridOaQuota(使「這輪改走 arXiv」可歸因於額度而非站台故障)
            if (src._oaQuota === true) count(msg, 'gridOaQuota')
        }
        catch (e) {
            msg.data._outcome = { ok: false, reason: isTimeoutError(e) ? 'timeout' : 'fetch-error', error: oneline(e?.message, 300) }
            count(msg, 'srcFail')
            ctx.log.warn(`來源[${src.name || src.url}] 抓取失敗（${msg.data._outcome.reason}）：${msg.data._outcome.error.slice(0, 200)}`)
        }
        return next(msg)
    },
})

/**
 * mw 錨點 capture.listFetch.normalizeItems:契約檢查(抓取未失敗——msg.data._outcome 未設——時執行;抓取器回 undefined 亦進此環而判為不合契約)。
 *
 * 非法項目略過並留痕(靜默丟棄會讓「這輪沒新資料」無從歸因);
 * 每來源取用上限(itemsPerSource)在此截斷——進料須與每輪處理量同量級,否則佇列無上限累積、
 * 舊料被餓死(未截斷時單來源一輪可新增上百篇,待抓佇列隨之積壓)。
 * 抓取器回傳不合契約(非陣列,含 undefined)屬實作錯誤,但仍記 _outcome 走完計帳環——否則該來源
 * lastFetchAt 永不更新、永遠排在「最舊優先」隊頭且不會因連敗停用(runListFetch 拋錯時同樣呼叫 onSource)。
 * 故 when 以「_outcome 未設」判而非 `_raw !== undefined`:後者會讓回 undefined 者跳過契約檢查、被計帳環記成「未執行抓取」且不計 srcFail。
 *
 * 讀 msg.data._raw／msg.data._fetcher;成功寫 msg.data._items,失敗寫 msg.data._outcome 並 count(msg,'srcFail')。不短路。
 *
 * @param {Object} [opt={}] 輸入子階段 opts,非物件則回退為 {}
 * @param {Integer} [opt.itemsPerSource] 輸入每來源取用上限,未給則用 settings.capture.sources.itemsPerSource
 * @returns {Object} 回傳 defineMw 產物
 * @example
 * let msg = makeMsg('source', {
 *     name: '天文新聞',
 *     _fetcher: { id: 'rss' },
 *     _raw: [{ url: 'https://example.com/post/1', title: '黑洞光譜' }, { url: 'https://example.com/post/2', title: '脈衝星' }, { title: '缺網址' }],
 * })
 * let ctx = { deps: {}, log: { info() {}, warn() {} } }
 * let { msg: out } = await composeChain([mwNormalizeItems({ itemsPerSource: 5 })])(msg, ctx)
 * console.log(out.data._items.map((x) => x.url), out.stats)
 * // => [ 'https://example.com/post/1', 'https://example.com/post/2' ] { itemsInvalid: 1 }
 */
export const mwNormalizeItems = (opt = {}) => {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    return defineMw({
        name: 'normalizeItems',
        when: (m) => !m.data._outcome,
        handle: async (msg, ctx, next) => {
            const src = msg.data
            let r
            try {
                r = normalizeFeedItems(src._raw, { source: src, fetcherId: src._fetcher.id, ctx, itemsPerSource: opt.itemsPerSource })
            }
            catch (e) {
                msg.data._outcome = { ok: false, reason: 'contract-error', error: oneline(e?.message, 300) }
                count(msg, 'srcFail')
                ctx.log.warn(`來源[${src.name || src.url}] 抓取回傳不合契約：${oneline(e?.message, 200)}`)
                return next(msg)
            }
            if (r.invalid.length) {
                count(msg, 'itemsInvalid', r.invalid.length)
                ctx.log.warn(`來源[${src.name}] 有 ${r.invalid.length} 項不符格式而略過：${oneline(r.invalid.map((x) => x.reason).join('；'), 200)}`)
            }
            msg.data._items = r.items
            return next(msg)
        },
    })
}

/**
 * mw 錨點 capture.listFetch.filterItems:業務過濾接縫(僅 msg.data._items 為陣列時執行,預設放行)。
 *
 * 黑名單/日期窗這類「否決」政策掛這裡——必須在占位入庫之前。讀寫 msg.data._items。不短路。
 *
 * @param {Object} [opt={}] 輸入子階段 opts,非物件則回退為 {}
 * @param {Function} [opt.filter] 輸入業務過濾函數 (items,{source,ctx})=>Promise<Array>|Array,未給即不過濾
 * @returns {Object} 回傳 defineMw 產物
 * @throws {TypeError} opt.filter 回傳非陣列時拋出(於鏈上執行時)
 * @example
 * let items = [{ url: 'https://example.com/post/1', title: '黑洞光譜' }, { url: 'https://example.com/ad', title: '廣告' }]
 * let mw = mwFilterItems({ filter: (list) => list.filter((x) => !x.title.includes('廣告')) })
 * let ctx = { deps: {}, log: { info() {}, warn() {} } }
 * let { msg } = await composeChain([mw])(makeMsg('source', { name: '天文新聞', _items: items }), ctx)
 * console.log(msg.data._items.length, msg.stats)
 * // => 1 { itemsFiltered: 1 }
 */
export const mwFilterItems = (opt = {}) => {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    return defineMw({
        name: 'filterItems',
        when: (m) => Array.isArray(m.data._items),
        handle: async (msg, ctx, next) => {
            const { kept, dropped } = await filterFeedItems(msg.data._items, { source: msg.data, ctx, filter: opt.filter })
            if (dropped > 0) {
                count(msg, 'itemsFiltered', dropped)
                ctx.log.info(`來源[${msg.data.name}] 業務過濾剔除 ${dropped} 項`)
            }
            msg.data._items = kept
            return next(msg)
        },
    })
}

/**
 * mw 錨點 capture.listFetch.admitPersist:去重占位＋入庫(seen.admit＝insertNew,僅 msg.data._items 為陣列時執行)。
 *
 * 沒抓過才放行,越下游每步越貴。讀 msg.data._items,寫 msg.data._fresh 與
 * msg.data._outcome={ok:true,itemCount},並 count(msg,'newDocs')。不短路。
 *
 * @param {Object} [opt={}] 輸入子階段 opts,非物件則回退為 {}
 * @param {Function} [opt.toRecord] 輸入項目→doc 記錄轉換函數,未給用預設 toRecord
 * @param {Function} [opt.onAdmitted] 輸入新入庫回呼 async (fresh, { source, ctx }) => void:每來源入庫後以本次新增之記錄(含同一內容改判 skip 者,
 *   其 status 為 skip)呼叫——零件庫用法之「列表完即知新件」;拋錯＝該來源之逐來源鏈異常(onFail 落帳)
 * @returns {Object} 回傳 defineMw 產物
 * @example
 * // seen 以替身代之(實際為 w-data-pipeline 之 createSeenStore 產物):admit 回傳 { fresh, dup, invalid }
 * let seen = { admit: async (items) => ({ fresh: items.map((x, i) => ({ id: `d${i}`, url: x.url })), dup: 0, invalid: [] }) }
 * let msg = makeMsg('source', { name: '天文新聞', _fetcher: { id: 'rss' }, _items: [{ url: 'https://example.com/post/1', title: '黑洞光譜' }] })
 * let ctx = { deps: { seen }, log: { info() {}, warn() {} } }
 * let { msg: out } = await composeChain([mwAdmitPersist()])(msg, ctx)
 * console.log(out.data._outcome, out.stats)
 * // => { ok: true, itemCount: 1, freshCount: 1 } { newDocs: 1 }
 */
export const mwAdmitPersist = (opt = {}) => {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    return defineMw({
        name: 'admitPersist',
        when: (m) => Array.isArray(m.data._items),
        handle: async (msg, ctx, next) => {
            const src = msg.data
            const r = await admitFeedItems(src._items, { source: src, fetcher: src._fetcher, ctx, toRecord: opt.toRecord })
            msg.data._fresh = r.fresh
            msg.data._outcome = { ok: true, itemCount: src._items.length, freshCount: r.fresh.length }
            count(msg, 'newDocs', r.fresh.length)
            if (r.sameContent) count(msg, 'sameContent', r.sameContent)
            ctx.log.info(`來源[${src.name}] 取得 ${src._items.length} 項，新增 ${r.fresh.length} 篇${r.dup ? `（已抓過 ${r.dup}）` : ''}${r.sameContent ? `（其中 ${r.sameContent} 篇與既有文件同一內容，記 skip）` : ''}`)
            if (typeof opt.onAdmitted === 'function') await opt.onAdmitted(r.fresh, { source: src, ctx })
            return next(msg)
        },
    })
}

/**
 * 來源計帳之單一實作(計帳環與逐來源鏈異常落帳共用,規則不手寫兩份)
 *
 * @param {Object} ctx 輸入管道脈絡(需 ctx.deps.stores/settings/clock 與 ctx.log)
 * @param {Object} src 輸入來源訊息之 data(來源記錄＋執行期欄位)
 * @param {Object} outcome 輸入本輪結果 { ok, itemCount, error }
 * @param {Object} [opt={}] 輸入子階段 opts(取 sourcePolicy 覆寫:逐鍵蓋上 settings.capture.sources),非物件則回退為 {}
 * @returns {Promise} 回傳 Promise，resolve 回傳 recordSourceOutcome 之結果 { disabled, reason }
 */
async function accountSourceOutcome(ctx, src, outcome, opt = {}) {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    const { stores, settings, clock } = ctx.deps
    const p = { ...settings.capture.sources, ...(opt.sourcePolicy || {}) }
    // 新件率(本次新入庫÷取得,近 5 次):itemCount 為去重前之數,查詢與既有來源高度重疊者 itemCount 照樣滿而新件近零——
    //   產出率判定(judged)永遠到不了樣本門檻,唯有新件率看得出冗餘(自動領域之冗餘暫停讀它)
    const fresh = outcome.ok && outcome.itemCount > 0 ? { freshHist: [...(Array.isArray(src.freshHist) ? src.freshHist : []), Math.round((outcome.freshCount || 0) / outcome.itemCount * 100) / 100].slice(-5) } : {}
    const rec = await recordSourceOutcome(stores.sources, src, outcome, {
        nowIso: clock.iso8(),
        maxConsecFails: p.maxConsecFails,
        maxConsecEmpty: p.maxConsecEmpty,
        isAutoSource: p.isAutoSource,
        extraPatch: { ...fresh, ...(p.extraPatchOf?.(src, { ok: outcome.ok, items: src._items || [] }) || {}) },
    })
    if (rec.disabled) ctx.log.warn(`來源[${src.name}] ${rec.reason}，停用`)
    return rec
}

/**
 * mw 錨點 capture.listFetch.accountSource:來源計帳:成敗/連敗停用/空回計數/逐來源 extraPatch(grid cursor 前進走這裡)
 *
 * 讀 msg.data._outcome(缺席視為 { ok:false, error:'未執行抓取' }),寫回 ctx.deps.stores.sources。不短路。
 *
 * @param {Object} [opt={}] 輸入子階段 opts,非物件則回退為 {}
 * @param {Object} [opt.sourcePolicy] 輸入來源政策覆寫(逐鍵蓋上 settings.capture.sources,如 maxConsecFails、maxConsecEmpty、isAutoSource、extraPatchOf)
 * @returns {Object} 回傳 defineMw 產物
 * @example
 * let rows = [{ id: 's1', name: '天文新聞', okCount: 0, failCount: 0 }]
 * let sources = { patch: async (id, p) => Object.assign(rows.find((r) => r.id === id), p) }
 * let ctx = {
 *     deps: { stores: { sources }, settings: { capture: { sources: { maxConsecFails: 8 } } }, clock: { iso8: () => '2026-09-01T00:00:00+08:00' } },
 *     log: { info() {}, warn() {} },
 * }
 * let run = composeChain([mwAccountSource()])
 * await run(makeMsg('source', { ...rows[0], _outcome: { ok: true, itemCount: 3, freshCount: 2 } }), ctx)
 * console.log(rows[0].okCount, rows[0].failCount, rows[0].freshHist)
 * // => 1 0 [ 0.67 ]
 *
 * await run(makeMsg('source', { ...rows[0], _outcome: { ok: false, error: 'HTTP 503' } }), ctx)
 * console.log(rows[0].okCount, rows[0].failCount, rows[0].lastError)
 * // => 1 1 HTTP 503
 */
export const mwAccountSource = (opt = {}) => {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    return defineMw({
        name: 'accountSource',
        handle: async (msg, ctx, next) => {
            const src = msg.data
            const outcome = src._outcome || { ok: false, error: '未執行抓取' }
            // 網路問題不算在來源頭上:失敗可能出自本機網路者,計帳前強制重探;不通 → 不計帳(lastFetchAt 不動,下輪仍到期)、本段停止
            if (!outcome.ok && src._outcome && sourceMayBeNetFailure(outcome) && await netDownNow(ctx)) {
                count(msg, 'netDeferred')
                ctx.log.info(`來源[${src.name || src.url}] 失敗時本機網路不通，不計失敗`)
                return next(msg)
            }
            await accountSourceOutcome(ctx, src, outcome, opt)
            return next(msg)
        },
    })
}

/**
 * 來源輪抓子階段工廠:逐來源一條 msg 依序流過 fetchList → normalizeItems → filterItems → admitPersist → accountSource 五環(可 tap／chain 掛載)
 *
 * run(ctx) 先確認 ctx.deps.registry(缺則拋 ContractError)與本機網路,再挑到期來源、依時間預算逐來源跑鏈,回傳統一 report
 * (detail 含 sourcesTried、newDocs、left、netDeferred、chainFailed、dropped、invalid、filtered、sameContent;opt.collectIds 為 true 時另有 newIds)。
 *
 * @param {Object} [opt={}] 輸入子階段設定,非物件則回退為 {};可含 chain, tap, filter, toRecord, sourcePolicy(逐鍵蓋上 settings.capture.sources),
 *   sourcesPerRun(預設 capture.sources.perRun), gridPerRun(預設 capture.areas.perRun), minSourceIntervalMs(預設 capture.sources.minIntervalMs), itemsPerSource,
 *   onAdmitted(新入庫回呼,見 mwAdmitPersist), collectIds(true → report.detail.newIds 列本輪新入庫之文件 id;零件庫用法之回傳清單),
 *   concurrency(同時輪抓之來源數,預設 capture.sources.concurrency;0／1 即串行);階段契約欄位 enabled／when 等見 core/kernel stageFields
 * @param {Number|Function} [opt.reserveMs] 輸入保留給後段之毫秒數(非負)，或 (ctx) => 毫秒數(每輪求值):> 0 時開工前與每次取件前須「整輪剩餘 − 保留 ≥ 一次抓取之估計
 *   (各到期來源抓取之最壞耗時之最大者:抓取器逾時 × 嘗試次數 ＋ 重試等待)」才開工,不足即少抓、未取件之來源原樣留下輪(detail.reserveDeferred 記件數);由組裝者注入(如後段工作之最低時間),
 *   本段不讀他工作之設定。未給(或 null)則取每輪依賴之 ctx.deps.reserveMs,皆未給為 0(只守整輪逾期,行為不變);明給 0 優先於依賴
 * @returns {Object} 回傳階段物件 { name:'listFetch', run(ctx) }
 * @throws {ContractError} run 時 ctx.deps.registry 缺席，或有到期來源無可用抓取器時拋出
 * @throws {Error} opt.reserveMs 非非負毫秒數亦非函數時拋出(deps.reserveMs 不合、函數回傳不合者於該輪開工時拋出)
 * @example
 * // W 為 w-data-pipeline 之預設匯出(import W from 'w-data-pipeline/src/WDataPipeline.mjs')
 * let rows = [{ id: 's1', name: '天文新聞', kind: 'rss', url: 'https://example.com/feed', tier: 1, lastFetchAt: '', failCount: 0 }]
 * let sources = {
 *     select: async (f) => rows.filter((r) => !f || Object.entries(f).every(([k, v]) => r[k] === v)),
 *     patch: async (id, p) => Object.assign(rows.find((r) => r.id === id), p),
 * }
 * let fetcher = W.defineFetcher({ id: 'rss', kinds: ['rss'], fetch: async () => [{ url: 'https://example.com/post/1', title: '黑洞光譜' }] })
 * let registry = { resolve: () => fetcher, label: () => 'rss' }
 * let seen = { admit: async (items) => ({ fresh: items.map((x, i) => ({ id: `d${i}`, url: x.url })), dup: 0, invalid: [] }) }
 * let ctx = {
 *     deps: { stores: { sources }, registry, seen, settings: resolveSettings({}), clock: { iso8: () => '2026-09-01T00:00:00+08:00' } },
 *     log: { info() {}, warn() {} },
 * }
 * let stage = stageListFetch()
 * let r = await stage.run(ctx)
 * console.log(stage.name, r.ok, r.detail.sourcesTried, r.detail.newDocs, rows[0].lastFetchAt)
 * // => listFetch true 1 1 2026-09-01T00:00:00+08:00
 */
export function stageListFetch(opt = {}) {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    // 保留時間:opt 明給者優先(建構即檢核);未給者每輪取 ctx.deps.reserveMs(組裝者之依賴);取值規則各段同一份(core/util/stageReserve)
    const reserveFn = stageReserveFnOf(opt, 'stageListFetch')
    const chain = opt.chain || applyTaps(
        [mwFetchList(opt), mwNormalizeItems(opt), mwFilterItems(opt), mwAdmitPersist(opt), mwAccountSource(opt)],
        opt.tap, { chainName: 'capture.listFetch' },
    )
    return {
        ...stageFields(opt, { name: 'listFetch' }),
        run: async (ctx) => {
            const keepMs = reserveFn(ctx) // 本輪之保留(不合法即於此拋出,不先動任何來源)
            const { stores, registry, settings } = ctx.deps
            if (!registry) throw new ContractError('listFetch 需要抓取器登錄（cfg.fetchers 或內建預設）')
            // 本機網路不通:本段略過(不發請求、不計任何來源之失敗;core/util/netGuard)
            if (await netDownAtStart(ctx, '輪抓')) return stdReport({ detail: { netDown: true, sourcesTried: 0, newDocs: 0 } })
            const sp = { ...settings.capture.sources, ...(opt.sourcePolicy || {}) }
            const base = {
                minIntervalMs: opt.minSourceIntervalMs ?? settings.capture.sources.minIntervalMs,
                // 產出率回饋(來源品質政策,stores/sourcePolicy):樣本足量且產出率低者排同層級之末;judged/yielded 由 seedSync 之 cullSources 每輪落帳
                lowYieldRate: sp.lowYieldRate,
                minJudged: sp.cullMinJudged,
            }
            // grid(領域查詢)與其餘來源分名額挑:同池時 tier 先排,領域一增加即擠掉 tier-3 自動來源(site 線索擴充之成果);
            //   grid 摘要直入 raw,其上界＝capture.areas.perRun×capture.sources.itemsPerSource,已納入容量檢核
            //   未經 resolveSettings 之裸設定(無 capture.areas.perRun)維持單池挑選,不讓 grid 靜默停抓
            const gridPerRun = opt.gridPerRun ?? settings.capture.areas?.perRun
            const sourcesPerRun = opt.sourcesPerRun ?? settings.capture.sources.perRun
            const due = gridPerRun === undefined
                ? await pickDueSources(stores.sources, { ...base, limit: sourcesPerRun })
                : [
                    ...await pickDueSources(stores.sources, { ...base, limit: sourcesPerRun, filter: (s) => s.kind !== 'grid' }),
                    ...await pickDueSources(stores.sources, { ...base, limit: gridPerRun, filter: (s) => s.kind === 'grid' }),
                ]
            ctx.log.info(`本輪來源 ${due.length} 個：${due.map((s) => s.name).join('、') || '（無到期來源）'}`)

            // 抓取器解析前置:設定錯誤(kind 沒對到/指名不存在)開工前整批 fail loud,
            // 不攤平成單來源失敗——理由同 runListFetch(靜默會顯示成「這輪沒新資料」)
            const resolved = due.map((src) => ({ src, fetcher: registry.resolve('list', src, ctx) }))
            const unhandled = resolved.filter((x) => !x.fetcher)
            if (unhandled.length) {
                throw new ContractError(`有 ${unhandled.length} 個來源無可用抓取器：${unhandled.map((x) => x.src?.name || x.src?.url).join('、')}（已註冊：${registry.label()}）`)
            }

            const msgs = resolved.map(({ src, fetcher }) => makeMsg('source', { ...src, _fetcher: fetcher }, { stage: 'listFetch' }))
            // 時間預算守門與 detailFetch 對稱(同一執行器 runChainOverMsgs);未取件之來源 lastFetchAt 不動,下輪仍為最舊優先;本機網路轉不通亦停
            // 例外仍落帳:逐來源鏈於計帳環之前拋錯(安裝方 filter 回非陣列、toRecord 拋錯、入庫失敗…)——記 chainFails、更新 lastFetchAt
            // (排隊尾、不擋隊頭)、每次 WARN,**不加 failCount、不停用**(程式／環境問題,與來源本身之失敗分帳:
            // 否則連續異常即達停用門檻,修好後仍須等冷卻期)
            // 扣保留(core/util/stageReserve):保留 > 0 時每次取件(並行時每波)前須「整輪剩餘 − 保留 ≥ 一次抓取之估計」;一次抓取之估計＝各到期來源
            //   抓取之最壞耗時(抓取器自宣告之逾時優先,否則 capture.sources.listTimeoutMs;× 嘗試次數 ＋ 重試等待)之最大者。保留為 0 時只守整輪逾期(同現版)
            const gate = stageReserveGateOf(ctx, keepMs)
            const stepMs = stageStepMsOf(...resolved.map(({ fetcher }) => fetchStepMsOf(fetcher, settings.capture.sources.listTimeoutMs)))
            let reserveCut = false // 本段是否因保留而停(最後一次 shouldStop 為真之成因;runChainOverMsgs 一旦為真即停止取件)
            // 並行輪抓(capture.sources.concurrency 或 opt.concurrency;>1 才並行,以波次跑、落帳與統計同串行)
            const conc = opt.concurrency ?? settings.capture.sources.concurrency
            const r = await runChainOverMsgs({
                chain,
                ctx,
                msgs,
                chainName: 'capture.listFetch',
                ...(Number.isInteger(conc) && conc > 1 ? { concurrency: conc } : {}),
                shouldStop: () => {
                    if (gate.expired() || ctx.deps.netGuard?.isDown?.() === true) return true
                    if (gate.cut(stepMs)) {
                        reserveCut = true
                        return true
                    }
                    return false
                },
                onFail: async (m, e) => {
                    const { chainFails } = await recordSourceChainFail(stores.sources, m.data, { nowIso: ctx.deps.clock.iso8(), error: `逐來源鏈異常：${oneline(e?.message, 180)}` })
                    ctx.log.warn(`來源[${m.data.name || m.data.url}] 逐來源鏈異常（第 ${chainFails} 次；程式或環境問題，不計失敗、不停用，修復後重抓）：${oneline(e?.message, 160)}`)
                },
            })
            for (const e of r.errors) ctx.log.warn(`listFetch 逐來源異常：${e}`)
            // 因保留而延後:INFO 寫明(不是逾整輪預算,不印「逾時間預算」之 WARN);來源原樣留佇列(lastFetchAt 不動,下輪仍為最舊優先)
            const reserveDeferred = reserveCut ? r.left : 0
            if (reserveDeferred > 0) ctx.log.info(`輪抓：${reserveNoteOf(gate, stepMs)}，${r.left} 個來源未取件留下輪`)
            else if (r.left > 0) ctx.log.warn(`輪抓：逾時間預算，${r.left} 個來源未取件留下輪`)
            if (r.stats.netDeferred) ctx.log.warn(`輪抓：本機網路不通（${ctx.deps.netGuard?.describe?.() || '-'}），${r.stats.netDeferred} 個來源之失敗不計，本段提前停止`)
            // 剔除計數(靜默剔除改計數,皆入 report detail):抓取器自行略過(逐因)、契約不符、業務過濾、同一內容(CS10)
            const dropped = {}
            for (const [k, v] of Object.entries(r.stats)) if (k.startsWith('dropped_')) dropped[k.slice(8)] = v
            // 新入庫之 id 清單(opt.collectIds):各來源訊息之 _fresh(admitPersist 寫入;同一內容改判 skip 者亦在內,其 status 為 skip)
            const newIds = opt.collectIds === true ? msgs.flatMap((m) => (Array.isArray(m.data._fresh) ? m.data._fresh : []).map((d) => d.id)) : null
            return stdReport({
                stats: { in: due.length - r.left, out: r.stats.newDocs || 0, fail: (r.stats.srcFail || 0) + r.fails },
                detail: {
                    sourcesTried: due.length - r.left,
                    newDocs: r.stats.newDocs || 0,
                    left: r.left,
                    // 因保留給後段之時間而留下輪之來源數(僅確因保留延後時才有此欄,report 欄集於平時不變)
                    ...(reserveDeferred > 0 ? { reserveDeferred } : {}),
                    netDeferred: r.stats.netDeferred || 0, // 失敗時本機網路不通而不計之來源
                    chainFailed: r.fails || 0, // 逐來源鏈異常(不計失敗、不停用)
                    dropped,
                    invalid: r.stats.itemsInvalid || 0,
                    filtered: r.stats.itemsFiltered || 0,
                    sameContent: r.stats.sameContent || 0,
                    // 網格因 OpenAlex 429(額度用盡或每秒超限)而改走 arXiv 之來源數(僅發生時才有此欄,report 欄集於平時不變)
                    ...(r.stats.gridOaQuota ? { gridOaQuota: r.stats.gridOaQuota } : {}),
                    ...(newIds ? { newIds } : {}),
                },
            })
        },
    }
}

export default stageListFetch
