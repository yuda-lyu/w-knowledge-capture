// seedSyncStage.mjs — 抓取物件子階段 a1:種子同步＋品質淘汰
//
// hook 錨點:capture.seedSync.syncSeeds / capture.seedSync.cullSources
// 單一 maintenance 訊息流過兩環;各環可 before/after/replace 掛載。

import isobj from 'wsemi/src/isobj.mjs'
import { defineMw, applyTaps, makeMsg, count, runChainOverMsgs, stdReport, stageFields } from '../core/kernel.mjs'
import { ensureSeedSources, cullZeroYieldSources, reprobeSources } from '../stores/sourcePolicy.mjs'
import { syncSeedAreas, syncAreaSources } from '../stores/areaPolicy.mjs'
import { judgeFromDocs } from './collectHelpers.mjs'
import { expandSeeds } from '../fetchers/endpoints.mjs'

/**
 * mw 錨點 capture.seedSync.syncSeeds:種子同步:cfg.data 之靜態種子＋主題網格展開 → 補入/宣告欄位同步
 *
 * 讀 opt.seeds(未給則以 ctx.deps.data 展開);寫入 ctx.deps.stores.sources、msg.stats.seedAdd。不短路。
 *
 * @param {Object} [opt={}] 輸入子階段 opts,非物件則回退為 {}
 * @param {Array} [opt.seeds] 輸入覆寫用種子陣列,未給則由 ctx.deps.data 展開(expandSeeds)
 * @returns {Object} 回傳 defineMw 產物
 * @example
 * let rows = []
 * let sources = {
 *     select: async () => rows,
 *     patch: async (id, p) => Object.assign(rows.find((r) => r.id === id), p),
 *     insertNew: async (items) => {
 *         rows.push(...items)
 *         return { addCount: items.length, dupCount: 0 }
 *     },
 * }
 * let mw = mwSyncSeeds({ seeds: [{ id: 's1', tier: 1, name: '天文新聞', kind: 'rss', url: 'https://example.com/feed' }] })
 * let ctx = { deps: { stores: { sources }, data: {}, clock: { iso8: () => '2026-09-01T00:00:00+08:00' } }, log: { info() {}, warn() {} } }
 * let { msg } = await composeChain([mw])(makeMsg('maintenance', {}), ctx)
 * console.log(mw.name, msg.stats, rows.map((r) => r.name))
 * // => syncSeeds { seedAdd: 1 } [ '天文新聞' ]
 */
export const mwSyncSeeds = (opt = {}) => {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    return defineMw({
        name: 'syncSeeds',
        handle: async (msg, ctx, next) => {
            const { stores, data, clock } = ctx.deps
            const nowIso = clock.iso8()
            if (opt.seeds) {
                const r = await ensureSeedSources(stores.sources, opt.seeds)
                count(msg, 'seedAdd', r.addCount)
                return next(msg)
            }
            // 有領域集合:主題網格先成為領域(stores/areaPolicy),grid 來源由「啟用中之領域」派生(來源 id 公式不變,既有 cursor 與統計保留);
            //   無領域集合(自組 stores 未開 areas)時:網格直接展開為來源
            const useAreas = !!stores.areas
            const seeds = expandSeeds(useAreas ? { seedSources: data.seedSources } : data, { nowIso })
            const r = await ensureSeedSources(stores.sources, seeds)
            if (r.addCount > 0) ctx.log.info(`種子來源補入 ${r.addCount} 筆（既有 ${r.dupCount} 筆）`)
            count(msg, 'seedAdd', r.addCount)
            if (useAreas) {
                const a = await syncSeedAreas(stores.areas, data.gridTopics || [], { nowIso })
                if (a.added || a.revived || a.retired || a.relabeled) ctx.log.info(`種子領域同步：新增 ${a.added}、恢復 ${a.revived}、退役 ${a.retired}、改名 ${a.relabeled}`)
                const s = await syncAreaSources(stores.sources, stores.areas, { nowIso, ensure: ensureSeedSources })
                count(msg, 'seedAdd', s.added)
                count(msg, 'areaSeedAdd', a.added)
            }
            // 種子檔移除之 rss 種子 → 暫停(paused;可逆:重新列入即恢復);否則移除種子不會有任何效果、舊來源照抓
            const seedIds = new Set(seeds.map((s) => s.id))
            for (const src of await stores.sources.select()) {
                if (src.origin !== 'seed' || src.kind === 'grid') continue
                const removed = !seedIds.has(src.id)
                if (removed && src.paused !== true) await stores.sources.patch(src.id, { paused: true, pauseReason: '種子檔已移除' })
                else if (!removed && src.paused === true && /^種子檔已移除/.test(src.pauseReason || '')) await stores.sources.patch(src.id, { paused: false, pauseReason: '' })
            }
            return next(msg)
        },
    })
}

/**
 * mw 錨點 capture.seedSync.cullSources:零產出淘汰:統計直接從文件算(計數器有競態),樣本足量且產出掛零者停用;
 *   產出統計只計各來源觀察窗(windowFrom)內之判定、非對內容之判定之 skip(重複類、例行貼文)不計(judgeFromDocs);其後冷卻期滿之停用來源重探(reprobeSources)
 *
 * 讀 ctx.deps.stores.docs 全表統計;寫入 ctx.deps.stores.sources(停用、重探)、msg.stats.reprobed。不讀寫 msg.data;不短路。
 *
 * @param {Object} [opt={}] 輸入子階段 opts,非物件則回退為 {}
 * @param {Integer} [opt.cullMinJudged] 輸入樣本足量之最少已判定篇數,未給則用 settings.capture.sources.cullMinJudged
 * @returns {Object} 回傳 defineMw 產物
 * @example
 * let mw = mwCullSources()
 * let ctx = {
 *     deps: {
 *         stores: { sources: { select: async () => [], patch: async () => {} }, docs: { select: async () => [] } },
 *         settings: { capture: { sources: { cullMinJudged: 8, reprobeDays: 30, reprobePerRun: 3 } } },
 *         clock: { iso8: () => '2026-09-01T00:00:00+08:00' },
 *     },
 *     log: { info() {}, warn() {} },
 * }
 * let { msg } = await composeChain([mw])(makeMsg('maintenance', {}), ctx)
 * console.log(mw.name, msg.stats)
 * // => cullSources { reprobed: 0 }
 */
export const mwCullSources = (opt = {}) => {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    return defineMw({
        name: 'cullSources',
        handle: async (msg, ctx, next) => {
            const { stores, settings, clock } = ctx.deps
            const sp = settings.capture.sources
            const nowIso = clock.iso8()
            const since = new Map((await stores.sources.select()).filter((s) => s.windowFrom).map((s) => [s.id, s.windowFrom]))
            const judged = judgeFromDocs(await stores.docs.select(), { since })
            await cullZeroYieldSources(stores.sources, (s) => judged[s.id], {
                minJudged: opt.cullMinJudged ?? sp.cullMinJudged,
                nowIso,
                log: ctx.log,
            })
            const r = await reprobeSources(stores.sources, { nowIso, reprobeDays: sp.reprobeDays, reprobePerRun: sp.reprobePerRun, log: ctx.log })
            count(msg, 'reprobed', r.reprobed.length)
            if (r.due > r.reprobed.length) ctx.log.info(`來源冷卻重探：期滿 ${r.due} 個，本輪重探 ${r.reprobed.length} 個（每輪上限 ${sp.reprobePerRun}），其餘下輪`)
            return next(msg)
        },
    })
}

/**
 * 種子同步子階段工廠:單一 maintenance 訊息依序流過 syncSeeds → cullSources 兩環(可 tap／chain 掛載)
 *
 * run(ctx) 回傳統一 report:stats { in:1, out:1, fail } 並展開鏈統計(seedAdd、reprobed 等),detail 為鏈統計。
 *
 * @param {Object} [opt={}] 輸入子階段設定,非物件則回退為 {};可含 chain(整鏈重排), tap(認名掛載), seeds, cullMinJudged;階段契約欄位 enabled／when 等(core/kernel stageFields)
 * @returns {Object} 回傳階段物件 { name:'seedSync', run(ctx) }
 * @example
 * let rows = []
 * let sources = {
 *     select: async () => rows,
 *     patch: async (id, p) => Object.assign(rows.find((r) => r.id === id), p),
 *     insertNew: async (items) => {
 *         rows.push(...items)
 *         return { addCount: items.length, dupCount: 0 }
 *     },
 * }
 * let stage = stageSeedSync({ seeds: [{ id: 's1', tier: 1, name: '天文新聞' }] })
 * let ctx = {
 *     deps: { stores: { sources, docs: { select: async () => [] } }, data: {}, settings: resolveSettings({}), clock: { iso8: () => '2026-09-01T00:00:00+08:00' } },
 *     log: { info() {}, warn() {} },
 * }
 * let r = await stage.run(ctx)
 * console.log(stage.name, r.ok, r.detail)
 * // => seedSync true { seedAdd: 1, reprobed: 0 }
 */
export function stageSeedSync(opt = {}) {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    const chain = opt.chain || applyTaps([mwSyncSeeds(opt), mwCullSources(opt)], opt.tap, { chainName: 'capture.seedSync' })
    return {
        ...stageFields(opt, { name: 'seedSync' }),
        run: async (ctx) => {
            const r = await runChainOverMsgs({ chain, ctx, msgs: [makeMsg('maintenance', {})], chainName: 'capture.seedSync' })
            return stdReport({ ok: r.fails === 0, stats: { in: 1, out: 1, fail: r.fails, ...r.stats }, detail: r.stats })
        },
    }
}

export default stageSeedSync
