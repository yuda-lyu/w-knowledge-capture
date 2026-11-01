// unit-capture-stages.test.mjs — 抓取各子階段之動作鏈與落帳(以記憶體集合替身驗證;不發網路、不開瀏覽器):
//   seedSync(種子同步＋品質淘汰)、listFetch(來源輪抓入庫)、detailFetch(逐篇補全文)、docMaintain(終態瘦身與存量回補)、
//   expand(待探索線索之探測與消化)
//   各案例之應然取自各子階段檔頭之契約:逐項隔離(單項拋錯不中斷整段)、例外仍落帳而不計入對象之失敗次數、
//   記錄永不刪除、沒有時間型過期、靜默剔除改計數入 report detail
// 執行:自套件根 npx mocha test/unit-capture-stages.test.mjs

import assert from 'node:assert/strict'
import W from 'w-data-pipeline/src/WDataPipeline.mjs'
import { memStore } from './tools/memStore.mjs'
import { nullLogger } from './tools/nullLogger.mjs'
import { genClockTZ } from '../src/core/runnerPackage.mjs'
import { defineMw, composeChain, makeMsg, MwContractError } from '../src/core/kernel.mjs'
import { byRetryTierFifo, DOC_TERMINAL_STATUSES } from '../src/core/stores/docPolicy.mjs'
import { packText } from '../src/core/stores/docTexts.mjs'
import { settingsOf as S } from './tools/captureTestKit.mjs'
import { recLog } from './tools/testKit.mjs'
import { paraKeysOf } from '../src/stores/contentIndex.mjs'
import { probeSiteFeed, probeSearchEndpoints, mwProbe, mwSettleClue, stageExpand } from '../src/stages/expandStage.mjs'
import { mwSyncSeeds, mwCullSources, stageSeedSync } from '../src/stages/seedSyncStage.mjs'
import { mwFetchList, mwNormalizeItems, mwFilterItems, mwAdmitPersist, mwAccountSource, stageListFetch } from '../src/stages/listFetchStage.mjs'
import { mwTitleSkip, mwRouteFetcher, mwFetchDetail, mwTranscodeLinks, mwFeedFallback, mwPersistOutcome, stageDetailFetch } from '../src/stages/detailFetchStage.mjs'
import { mwSlim, mwRecheckHealth, mwFillParaKeys, stageDocMaintain } from '../src/stages/docMaintainStage.mjs'

const log = nullLogger()
const clock = genClockTZ('Asia/Taipei')
const NOW = '2026-09-23T12:00:00+08:00'

/** 逐項鏈拋錯之 mw(測「例外仍落帳」) */
const boom = (why) => defineMw({
    name: 'boom',
    handle: async () => {
        throw new Error(why)
    }
})

describe('unit-capture-stages', function() {

    // ══════════════════════════ seedSync ══════════════════════════
    describe('seedSyncStage', function() {

        it('mwSyncSeeds／mwCullSources／stageSeedSync：工廠 opt 非物件不拋錯，回退為 {}', () => {
            assert.equal(mwSyncSeeds(null).name, 'syncSeeds')
            assert.equal(mwCullSources('not-object').name, 'cullSources')
            assert.equal(stageSeedSync(123).name, 'seedSync')
        })

        it('stageSeedSync：有效輸入端到端跑通（種子同步補入宣告欄位＋零產出淘汰停用）', async () => {
            const sources = memStore()
            const docs = memStore([{ id: 'd1', sourceId: 's1', status: 'noted' }])
            const ctx = {
                deps: {
                    stores: { sources, docs },
                    data: {},
                    clock: { iso8: () => NOW },
                    settings: S({ sources: { cullMinJudged: 1 } }),
                },
                log,
            }
            const stage = stageSeedSync({ seeds: [{ id: 's1', tier: 1, name: 'S1' }] })
            const r = await stage.run(ctx)
            assert.equal(r.ok, true)
            assert.equal((await sources.get('s1')).name, 'S1', '種子同步生效')
        })
    })

    // ══════════════════════════ listFetch ══════════════════════════
    describe('listFetchStage', function() {

        it('mwNormalizeItems／mwFilterItems／mwAdmitPersist／mwAccountSource／stageListFetch：工廠 opt 非物件不拋錯，回退為 {}', () => {
            assert.equal(mwNormalizeItems(null).name, 'normalizeItems')
            assert.equal(mwFilterItems(undefined).name, 'filterItems')
            assert.equal(mwAdmitPersist('x').name, 'admitPersist')
            assert.equal(mwAccountSource(0).name, 'accountSource')
            assert.equal(stageListFetch(null).name, 'listFetch')
            assert.equal(typeof mwFetchList(), 'object', 'mwFetchList 無 opt 參數，工廠呼叫不受影響')
        })

        it('mwNormalizeItems：opt 非物件回退為 {}，itemsPerSource 改用 settings.capture.sources.itemsPerSource（不短路，仍走 next）', async () => {
            const mw = mwNormalizeItems(null)
            const msg = makeMsg('source', {
                name: 'S',
                url: 'https://s.example',
                _fetcher: { id: 'rss' },
                _raw: [{ url: 'https://e.com/1', title: 't1' }, { url: 'https://e.com/2', title: 't2' }],
            })
            const ctx = { deps: { settings: S({ sources: { itemsPerSource: 1 }, articles: { maxTextChars: 100 } }), seen: null }, log }
            const { halted } = await composeChain([mw])(msg, ctx)
            assert.equal(halted, '')
            assert.equal(msg.data._items.length, 1, 'opt 非物件回退為 {}，itemsPerSource 改用 settings.capture.sources.itemsPerSource')
        })

        it('mwFilterItems：opt 非物件回退為 {}，等同無 filter（全數放行）', async () => {
            const mw = mwFilterItems(null)
            const msg = makeMsg('source', { name: 'S', _items: [{ id: 1 }, { id: 2 }] })
            await composeChain([mw])(msg, { deps: {}, log })
            assert.equal(msg.data._items.length, 2, 'opt 非物件回退為 {}，filter 未給即放行')
        })

        it('輪抓契約層：itemsPerSource 截斷生效；抓取器回傳非陣列 → 記 _outcome 失敗、不短路（計帳環仍走）', async () => {
            const mk = () => makeMsg('source', { name: 'S', url: 'https://s.example', _fetcher: { id: 'rss' } })
            const ctx = { deps: { settings: S({ sources: { itemsPerSource: 3 }, articles: { maxTextChars: 100 } }), seen: null }, log }
            const run = composeChain([mwNormalizeItems()])
            const m1 = mk()
            m1.data._raw = Array.from({ length: 10 }, (_, i) => ({ url: `https://e.com/${i}`, title: `t${i}` }))
            await run(m1, ctx)
            assert.equal(m1.data._items.length, 3, '每來源取用上限須截斷（進料與處理量對齊；未截斷時單來源一輪可新增上百篇，待抓佇列隨之積壓）')
            const m2 = mk()
            m2.data._raw = { not: 'array' }
            const { halted } = await run(m2, ctx)
            assert.equal(halted, '', '不短路：下游 accountSource 才能記失敗、更新 lastFetchAt')
            assert.equal(m2.data._outcome?.ok, false)
            assert.equal(m2.data._outcome.reason, 'contract-error')
            assert.equal(m2.stats.srcFail, 1)
        })

        it('stageListFetch：有效輸入端到端跑通（fetch→normalize→filter→admit→account）', async () => {
            const sources = memStore([{ id: 's1', name: 'S1', kind: 'rss', url: 'https://s1.example/feed', tier: 1, lastFetchAt: '', failCount: 0 }])
            const docs = memStore()
            const seen = W.createSeenStore({ collection: docs, identity: W.createIdentity({ keyOf: 'raw' }), log })
            const fetcher = W.defineFetcher({ id: 'rss', kinds: ['rss'], fetch: async () => [{ url: 'https://e.com/1', title: 'T1' }] })
            const registry = { resolve: () => fetcher, label: () => 'rss' }
            const ctx = {
                deps: {
                    stores: { sources },
                    registry,
                    seen,
                    settings: S({ sources: { perRun: 5, minIntervalMs: 0, itemsPerSource: 8, maxConsecFails: 8 }, articles: { maxTextChars: 100 } }),
                    clock: { iso8: () => NOW },
                },
                log,
            }
            const stage = stageListFetch()
            const r = await stage.run(ctx)
            assert.equal(r.ok, true)
            assert.equal(r.detail.newDocs, 1, '有效輸入端到端行為不變')
            assert.ok((await sources.get('s1')).lastFetchAt, '來源計帳生效')
        })

        it('stageListFetch(靜默剔除改計數,皆入 report detail):契約不符、業務過濾、抓取器自行略過(src._dropped 逐因)、同一內容(CS10)皆計入 detail', async () => {
            const sources = memStore([{ id: 's1', name: 'S1', kind: 'rss', url: 'https://s1.example/feed', tier: 1, lastFetchAt: '', failCount: 0 }])
            const docs = memStore([{ id: 'old', status: 'noted', url: 'https://arxiv.org/abs/2401.01234' }])
            const seen = W.createSeenStore({ collection: docs, identity: W.createIdentity({ keyOf: 'raw' }), log })
            const fetcher = W.defineFetcher({
                id: 'rss', kinds: ['rss'],
                fetch: async (src) => {
                    src._dropped = { short: 2, noUrl: 0 } // 抓取器自行略過者(逐因;0 不計)
                    return [{ title: '缺網址' }, { url: 'https://e.com/keep', title: 'K' }, { url: 'https://e.com/drop', title: 'D' }, { url: 'https://arxiv.org/pdf/2401.01234', title: '同一內容' }]
                },
            })
            const deps = { stores: { sources, docs }, registry: { resolve: () => fetcher, label: () => 'rss' }, seen, settings: S({ sources: { perRun: 5, minIntervalMs: 0, itemsPerSource: 8, maxConsecFails: 8 }, articles: { maxTextChars: 100 } }), clock: { iso8: () => NOW } }
            const r = await stageListFetch({ filter: (items) => items.filter((x) => x.title !== 'D') }).run({ deps, log })
            assert.deepEqual([r.detail.invalid, r.detail.filtered, r.detail.dropped, r.detail.sameContent, r.detail.newDocs], [1, 1, { short: 2 }, 1, 2])
            // capture.standards.sameContent:false → 同一內容不判(CS10 關閉;零件庫用法),該篇照常為新件
            const docs2 = memStore([{ id: 'old', status: 'noted', url: 'https://arxiv.org/abs/2401.01234' }])
            const seen2 = W.createSeenStore({ collection: docs2, identity: W.createIdentity({ keyOf: 'raw' }), log })
            const off = { ...deps, stores: { sources: memStore([{ id: 's1', name: 'S1', kind: 'rss', url: 'https://s1.example/feed', tier: 1, lastFetchAt: '', failCount: 0 }]), docs: docs2 }, seen: seen2, settings: S({ sources: { perRun: 5, minIntervalMs: 0, itemsPerSource: 8, maxConsecFails: 8 }, articles: { maxTextChars: 100 }, standards: { sameContent: false } }) }
            const r2 = await stageListFetch({ filter: (items) => items.filter((x) => x.title !== 'D') }).run({ deps: off, log })
            assert.deepEqual([r2.detail.sameContent, r2.detail.newDocs], [0, 2], 'sameContent:false → 不判、不改 skip(新件數同:同一內容者本就計入 fresh)')
            assert.equal((await docs2.select()).filter((d) => d.status === 'new').length, 2, '同一內容者亦為 new(未改判 skip)')
        })

        it('零件庫用法(列表完即知新件):opt.onAdmitted(fresh, { source, ctx }) 於每來源入庫後呼叫(含改判 skip 者);opt.collectIds:true → report.detail.newIds 列本輪新入庫之 id;未給者 report 無 newIds、不呼叫', async () => {
            // 規則:stages/listFetchStage.mwAdmitPersist／stageListFetch 之 JSDoc
            const mk = () => {
                const sources = memStore([{ id: 's1', name: 'S1', kind: 'rss', url: 'https://s1.example/feed', tier: 1, lastFetchAt: '', failCount: 0 }, { id: 's2', name: 'S2', kind: 'rss', url: 'https://s2.example/feed', tier: 1, lastFetchAt: '', failCount: 0 }])
                const docs = memStore()
                const seen = W.createSeenStore({ collection: docs, identity: W.createIdentity({ keyOf: 'raw' }), log })
                const fetcher = W.defineFetcher({ id: 'rss', kinds: ['rss'], fetch: async (src) => [{ url: `https://e.com/${src.id}/1`, title: 'A' }, { url: `https://e.com/${src.id}/2`, title: 'B' }] })
                return { docs, deps: { stores: { sources, docs }, registry: { resolve: () => fetcher, label: () => 'rss' }, seen, settings: S({ sources: { perRun: 5, minIntervalMs: 0, itemsPerSource: 8, maxConsecFails: 8 }, articles: { maxTextChars: 100 } }), clock: { iso8: () => NOW } } }
            }
            const got = []
            const a = mk()
            const r = await stageListFetch({ collectIds: true, onAdmitted: async (fresh, x) => got.push([x.source.id, fresh.map((d) => d.id), typeof x.ctx.deps]) }).run({ deps: a.deps, log })
            const ids = (await a.docs.select()).map((d) => d.id).sort()
            assert.equal(ids.length, 4)
            assert.deepEqual([...r.detail.newIds].sort(), ids, 'newIds＝本輪新入庫之全部 id')
            assert.deepEqual(got.map((g) => g[0]).sort(), ['s1', 's2'], '每來源呼叫一次')
            assert.deepEqual(got.flatMap((g) => g[1]).sort(), ids, '回呼收到之 fresh 即入庫記錄')
            assert.ok(got.every((g) => g[2] === 'object'), '回呼可取 ctx')
            const b = mk()
            const r2 = await stageListFetch().run({ deps: b.deps, log })
            assert.equal('newIds' in r2.detail, false, '未給 collectIds 不收集(預設 report 不變)')
            assert.equal(r2.detail.newDocs, 4)
            // 回呼拋錯＝該來源之逐來源鏈異常(onFail 落帳:chainFails、不停用),其餘來源照常
            const c = mk()
            const r3 = await stageListFetch({ onAdmitted: async (fresh, x) => {
                if (x.source.id === 's1') throw new Error('宿主回呼壞了')
            } }).run({ deps: c.deps, log })
            assert.deepEqual([r3.detail.chainFailed, r3.stats.fail], [1, 1])
            assert.deepEqual([(await c.deps.stores.sources.get('s1')).chainFails, (await c.deps.stores.sources.get('s1')).enabled], [1, undefined])
        })

        it('輪抓並行:capture.sources.concurrency(或 opt.concurrency)>1 時以波次同時輪抓多個來源;預設 1 串行(來源逐個跑);落庫與報告數字同串行', async () => {
            // 規則:core/kernel.runChainOverMsgs 之 opt.concurrency(波次並行)、stageListFetch 傳入
            const mk = (settings) => {
                const sources = memStore(['s1', 's2', 's3', 's4'].map((id) => ({ id, name: id.toUpperCase(), kind: 'rss', url: `https://${id}.example/feed`, tier: 1, lastFetchAt: '', failCount: 0 })))
                const docs = memStore()
                const seen = W.createSeenStore({ collection: docs, identity: W.createIdentity({ keyOf: 'raw' }), log })
                let active = 0
                let peak = 0
                const fetcher = W.defineFetcher({ id: 'rss', kinds: ['rss'], retries: 0, retryDelayMs: 0, timeoutMs: 0, fetch: async (src) => {
                    active++
                    peak = Math.max(peak, active)
                    await new Promise((resolve) => setTimeout(resolve, 40))
                    active--
                    return [{ url: `https://e.com/${src.id}`, title: src.id }]
                } })
                return { peakOf: () => peak, deps: { stores: { sources, docs }, registry: { resolve: () => fetcher, label: () => 'rss' }, seen, settings, clock: { iso8: () => NOW } } }
            }
            const base = { sources: { perRun: 5, minIntervalMs: 0, itemsPerSource: 8, maxConsecFails: 8 }, articles: { maxTextChars: 100 } }
            const serial = mk(S(base))
            const r1 = await stageListFetch().run({ deps: serial.deps, log })
            assert.deepEqual([serial.peakOf(), r1.detail.sourcesTried, r1.detail.newDocs], [1, 4, 4], '預設串行')
            const par = mk(S({ ...base, sources: { ...base.sources, concurrency: 3 } }))
            const r2 = await stageListFetch().run({ deps: par.deps, log })
            assert.deepEqual([par.peakOf(), r2.detail.sourcesTried, r2.detail.newDocs], [3, 4, 4], '每波至多 3 個同時')
            assert.equal((await par.deps.stores.docs.select()).length, 4)
            assert.ok((await par.deps.stores.sources.select()).every((s) => s.lastFetchAt), '每個來源皆落帳')
            const viaOpt = mk(S(base))
            const r3 = await stageListFetch({ concurrency: 2 }).run({ deps: viaOpt.deps, log })
            assert.deepEqual([viaOpt.peakOf(), r3.detail.newDocs], [2, 4], 'opt.concurrency 優先於設定')
            assert.equal(S({ sources: { concurrency: 0 } }).capture.sources.concurrency, 0, '0 可給(視同串行)')
            const zero = mk(S({ ...base, sources: { ...base.sources, concurrency: 0 } }))
            await stageListFetch().run({ deps: zero.deps, log })
            assert.equal(zero.peakOf(), 1)
        })

        it('輪抓逐來源鏈異常(計帳環之前拋錯):onFail 落帳——lastFetchAt 更新(排隊尾)、chainFails+1,不加 failCount、不停用', async () => {
            const sources = memStore([{ id: 's1', name: 'S1', kind: 'rss', url: 'https://s1.example/feed', tier: 1, lastFetchAt: '', failCount: 7 }])
            const registry = { resolve: () => ({ id: 'rss', timeoutMs: 0 }), label: () => 'rss' }
            const deps = { stores: { sources }, registry, settings: S({ sources: { perRun: 5, minIntervalMs: 0, maxConsecFails: 8 } }), clock }
            const r = await stageListFetch({ chain: [boom('filter 必須回傳陣列')] }).run({ deps, log })
            const s = await sources.get('s1')
            assert.ok(s.lastFetchAt, 'lastFetchAt 須更新')
            assert.deepEqual([s.failCount, s.chainFails, s.enabled], [7, 1, undefined], '連續失敗不加、不因鏈異常停用(原 failCount 7、門檻 8)')
            assert.match(s.lastError, /逐來源鏈異常：filter 必須回傳陣列/)
            assert.equal(r.stats.fail, 1)
            assert.equal(r.detail.chainFailed, 1)
        })

        it('輪抓：抓取器回 undefined → 不合契約(srcFail、failCount+1、WARN),非「未執行抓取」;未自宣告 timeoutMs 者以 settings.capture.sources.listTimeoutMs 逾時', async () => {
            const sources = memStore([{ id: 's1', name: 'S1', kind: 'rss', url: 'https://s1.example/feed', tier: 1, lastFetchAt: '', failCount: 0 }])
            const mkDeps = (fetcher) => ({ stores: { sources }, registry: { resolve: () => fetcher, label: () => 'rss' }, settings: S({ sources: { perRun: 5, minIntervalMs: 0, itemsPerSource: 8, listTimeoutMs: 100, maxConsecFails: 8 }, articles: { maxTextChars: 100 } }), clock })
            const logger = recLog()
            const r = await stageListFetch().run({ deps: mkDeps({ id: 'rss', timeoutMs: 0, retries: 0, retryDelayMs: 0, fetch: async () => undefined }), log: logger })
            assert.equal(r.stats.fail, 1)
            const s = await sources.get('s1')
            assert.equal(s.failCount, 1)
            assert.match(s.lastError, /必須回傳陣列，實得 undefined/)
            assert.ok(logger.lines.some((l) => /^WARN 來源\[S1\] 抓取回傳不合契約/.test(l)), logger.lines.join('\n'))
            const logger2 = recLog()
            const slow = { id: 'rss', timeoutMs: 0, retries: 0, retryDelayMs: 0, fetch: () => new Promise((resolve) => setTimeout(() => resolve([]), 400)) }
            const r2 = await stageListFetch().run({ deps: mkDeps(slow), log: logger2 })
            assert.equal(r2.stats.fail, 1)
            assert.equal((await sources.get('s1')).failCount, 2)
            assert.ok(logger2.lines.some((l) => /^WARN 來源\[S1\] 抓取失敗（timeout）/.test(l)), '以全域 listTimeoutMs 逾時(若以 || 0 即無逾時,整段卡到被砍)')
        })

        it('輪抓名額與間隔取自設定:非 grid 來源取 capture.sources.perRun、grid 來源取 capture.areas.perRun(兩池分開挑),重抓間隔取 capture.sources.minIntervalMs;子階段 opt(sourcesPerRun／gridPerRun／minSourceIntervalMs)優先於設定', async () => {
            const rows = () => [
                { id: 'r1', name: 'R1', kind: 'rss', url: 'https://r1.example/feed', tier: 1, lastFetchAt: '', failCount: 0 },
                { id: 'r2', name: 'R2', kind: 'rss', url: 'https://r2.example/feed', tier: 1, lastFetchAt: '', failCount: 0 },
                { id: 'g1', name: 'G1', kind: 'grid', query: 'a b', url: 'https://g1.example', tier: 2, lastFetchAt: '', failCount: 0 },
                { id: 'g2', name: 'G2', kind: 'grid', query: 'c d', url: 'https://g2.example', tier: 2, lastFetchAt: '', failCount: 0 },
            ]
            const picked = async (settings, opt = {}, srcRows = rows()) => {
                const sources = memStore(srcRows)
                const docs = memStore()
                const seen = W.createSeenStore({ collection: docs, identity: W.createIdentity({ keyOf: 'raw' }), log })
                const got = []
                const fetcher = { id: 'x', retries: 0, retryDelayMs: 0, timeoutMs: 0, fetch: async (src) => {
                    got.push(src.id)
                    return []
                } }
                await stageListFetch(opt).run({ deps: { stores: { sources, docs }, registry: { resolve: () => fetcher, label: () => 'x' }, seen, settings, clock: { iso8: () => NOW } }, log })
                return got.sort()
            }
            assert.deepEqual(await picked(S({ sources: { perRun: 1, minIntervalMs: 0 }, areas: { perRun: 1 } })), ['g1', 'r1'], '各池各取 1')
            assert.deepEqual(await picked(S({ sources: { perRun: 2, minIntervalMs: 0 }, areas: { perRun: 0 } })), ['r1', 'r2'], 'areas.perRun 0 → grid 不抓')
            assert.deepEqual(await picked(S({ sources: { perRun: 0, minIntervalMs: 0 }, areas: { perRun: 2 } })), ['g1', 'g2'], 'sources.perRun 0 → 非 grid 不抓')
            assert.deepEqual(await picked(S({ sources: { perRun: 1, minIntervalMs: 0 }, areas: { perRun: 1 } }), { sourcesPerRun: 2, gridPerRun: 2 }), ['g1', 'g2', 'r1', 'r2'], '子階段 opt 優先於設定')
            // 重抓間隔:剛抓過(lastFetchAt 為此刻;pickDueSources 以系統時刻判到期)者於 minIntervalMs 內不到期;間隔 0 則到期
            const justNow = new Date().toISOString()
            const fresh = rows().map((r) => ({ ...r, lastFetchAt: justNow }))
            assert.deepEqual(await picked(S({ sources: { perRun: 5, minIntervalMs: 3_600_000 }, areas: { perRun: 5 } }), {}, fresh), [], '間隔內不到期')
            assert.deepEqual(await picked(S({ sources: { perRun: 5, minIntervalMs: 3_600_000 }, areas: { perRun: 5 } }), { minSourceIntervalMs: 0 }, fresh), ['g1', 'g2', 'r1', 'r2'], 'opt.minSourceIntervalMs 0 → 到期')
            // 未經 resolveSettings 之裸設定(無 capture.areas.perRun):維持單池挑選,不讓 grid 靜默停抓
            const bare = { capture: { sources: { perRun: 3, minIntervalMs: 0 } } }
            assert.deepEqual(await picked(bare), ['g1', 'r1', 'r2'], '單池依 tier 先排:r1、r2(tier 1)＋g1(tier 2)')
        })
    })

    // ══════════════════════════ detailFetch ══════════════════════════
    describe('detailFetchStage', function() {

        it('mwTitleSkip／mwTranscodeLinks／stageDetailFetch：工廠 opt 非物件不拋錯，回退為 {}', () => {
            assert.equal(mwTitleSkip(null).name, 'titleSkip')
            assert.equal(mwTranscodeLinks('x').name, 'transcodeLinks')
            assert.equal(stageDetailFetch(0).name, 'detailFetch')
            assert.equal(typeof mwRouteFetcher(), 'object', 'mwRouteFetcher 無 opt 參數，工廠呼叫不受影響')
            assert.equal(typeof mwFetchDetail(), 'object', 'mwFetchDetail 無 opt 參數，工廠呼叫不受影響')
            assert.equal(typeof mwFeedFallback(), 'object', 'mwFeedFallback 無 opt 參數，工廠呼叫不受影響')
            assert.equal(typeof mwPersistOutcome(), 'object', 'mwPersistOutcome 無 opt 參數，工廠呼叫不受影響')
        })

        it('mwTitleSkip：opt 非物件回退為 {}，patterns 取自 settings.capture.articles.skipTitlePatterns(RegExp 或 { p, f } 皆可,以 toPatterns 編譯);opt.patterns 優先於設定;ctx.deps.data 內之同名鍵不被讀', async () => {
            const mw = mwTitleSkip(null)
            const ctx = { deps: { settings: S({ articles: { skipTitlePatterns: [/精選彙整/, { p: '^digest', f: 'i' }] } }), data: { skipTitlePatterns: [/不應被讀/] } }, log }
            const run = async (title, m = mw) => {
                const msg = makeMsg('doc', { title })
                await composeChain([m])(msg, ctx)
                return msg.data._titleSkip
            }
            assert.equal(await run('每週精選彙整'), true, 'RegExp 形')
            assert.equal(await run('Digest #3'), true, '{ p, f } 形(編譯為 RegExp,旗標 i)')
            assert.equal(await run('一般文章'), false)
            assert.equal(await run('不應被讀'), false, '樣式只來自設定或 opt.patterns:deps.data 內之同名鍵不被讀取')
            assert.equal(await run('每週精選彙整', mwTitleSkip({ patterns: [/^只有這個/] })), false, 'opt.patterns 取代設定')
            assert.equal(await run('只有這個', mwTitleSkip({ patterns: [/^只有這個/] })), true)
        })

        it('mwTitleSkip：設定之樣式形狀不合(非 RegExp 亦非 { p, f })時拋錯(逐篇鏈異常由 onFail 落帳,不靜默放行或誤殺);預設設定之通用彙整頁樣式命中例行貼文', async () => {
            const bad = { deps: { settings: { capture: { articles: { skipTitlePatterns: ['^abc'] } } } }, log }
            await assert.rejects(() => composeChain([mwTitleSkip()])(makeMsg('doc', { title: 'abc' }), bad), /capture\.articles\.skipTitlePatterns\[0\] 須為 RegExp 或 \{ p: 樣式字串, f\?: 旗標 \}/)
            const def = { deps: { settings: S() }, log }
            const msg = makeMsg('doc', { title: 'Weekly Roundup #12' })
            await composeChain([mwTitleSkip()])(msg, def)
            assert.equal(msg.data._titleSkip, true, '預設樣式(capture.articles.skipTitlePatterns 之預設)命中')
        })

        it('子階段 tap 錨點不存在 → 定義期拋錯(不是跑到一半才發現掛空);chain 可整鏈重排(自寫 mw 單元)', () => {
            assert.throws(() => stageDetailFetch({ tap: { nope: { replace: defineMw({ name: 'x', handle: (m, c, n) => n(m) }) } } }), MwContractError)
            const st = stageDetailFetch({ chain: [defineMw({ name: 'only', handle: (m, c, n) => n(m) })] })
            assert.equal(st.name, 'detailFetch')
            assert.equal(typeof st.run, 'function')
        })

        it('補全文選取：tries 升冪→tier 升冪→同層級 FIFO；失敗件排隊末不佔重試名額；非 new 不選', async () => {
            const seen = []
            const record = defineMw({
                name: 'record',
                handle: async (msg, ctx, next) => {
                    seen.push(msg.data.id); return next(msg)
                }
            })
            const docs = memStore([
                // 失敗過的最舊 tier-1 件:若只按 collectedAt 排,失敗件保留原 collectedAt 會黏在隊頭、每輪重耗名額 → 應排到最末
                { id: 't1-tried', status: 'new', sourceTier: 1, fetchTries: 2, collectedAt: '2026-06-01T00:00:00+08:00' },
                { id: 't3-newest', status: 'new', sourceTier: 3, collectedAt: '2026-09-01T00:00:00+08:00' },
                { id: 't3-oldest', status: 'new', sourceTier: 3, collectedAt: '2026-07-01T00:00:00+08:00' },
                { id: 't2-old', status: 'new', sourceTier: 2, collectedAt: '2026-08-01T00:00:00+08:00' },
                { id: 't3-mid', status: 'new', sourceTier: 3, collectedAt: '2026-08-15T00:00:00+08:00' },
                { id: 'already-raw', status: 'raw', sourceTier: 1, collectedAt: '2026-06-01T00:00:00+08:00' },
            ])
            const stage = stageDetailFetch({ chain: [record], articlesPerRun: 3 })
            await stage.run({ deps: { stores: { docs }, settings: S({ articles: { perRun: 3 } }) }, log })
            assert.deepEqual(seen, ['t2-old', 't3-oldest', 't3-mid'],
                '未試過者先抓：tier 先、同層級最舊先。若為最新優先,沒搶到名額者每輪被更新者擠掉直到過期')
            assert.ok(!seen.includes('t1-tried'), '失敗件排隊末：即使 tier 最高、collectedAt 最舊也不得插隊佔用名額')
            assert.ok(!seen.includes('t3-newest'), '名額只有 3，最新者本輪排隊，不插隊')
            assert.ok(!seen.includes('already-raw'), '已有素材者不重抓')

            // 未試件抓完後，失敗件仍會被撿起（保留不丟；記錄永不刪除）
            const seen2 = []
            const record2 = defineMw({
                name: 'record2',
                handle: async (msg, ctx, next) => {
                    seen2.push(msg.data.id); return next(msg)
                }
            })
            const docs2 = memStore([
                { id: 't1-tried', status: 'new', sourceTier: 1, fetchTries: 2, collectedAt: '2026-06-01T00:00:00+08:00' },
                { id: 't3-tried-more', status: 'new', sourceTier: 3, fetchTries: 1, collectedAt: '2026-07-01T00:00:00+08:00' },
            ])
            await stageDetailFetch({ chain: [record2], articlesPerRun: 3 })
                .run({ deps: { stores: { docs: docs2 }, settings: S({ articles: { perRun: 3 } }) }, log })
            assert.deepEqual(seen2, ['t3-tried-more', 't1-tried'], '無未試件時仍重試失敗件，且試較少次者先')
        })

        it('補全文每輪名額取自 settings.capture.articles.perRun;子階段 opt.articlesPerRun 優先', async () => {
            const picked = async (settings, opt = {}) => {
                const seen = []
                const record = defineMw({ name: 'record', handle: async (msg, ctx, next) => {
                    seen.push(msg.data.id)
                    return next(msg)
                } })
                const docs = memStore([1, 2, 3, 4].map((i) => ({ id: `d${i}`, status: 'new', sourceTier: 2, collectedAt: `2026-06-0${i}T00:00:00+08:00` })))
                await stageDetailFetch({ chain: [record], ...opt }).run({ deps: { stores: { docs }, settings }, log })
                return seen
            }
            assert.deepEqual(await picked(S({ articles: { perRun: 2 } })), ['d1', 'd2'], '設定 2 篇')
            assert.deepEqual(await picked(S({ articles: { perRun: 2 } }), { articlesPerRun: 3 }), ['d1', 'd2', 'd3'], 'opt 優先')
        })

        it('零件庫用法(選完才抓):opt.pick(candidates, { ctx, quota, queues }) 決定本輪取件——候選為依現行排序之全部待抓件,回傳截至 quota、只認候選之成員(去重);回非陣列即拋(逐篇鏈不開工);未給者取前 quota', async () => {
            // 規則:stages/detailFetchStage.stageDetailFetch 之 JSDoc(pick)
            const run = async (opt) => {
                const seen = []
                const record = defineMw({ name: 'record', handle: async (msg, ctx, next) => {
                    seen.push(msg.data.id)
                    return next(msg)
                } })
                const docs = memStore([1, 2, 3, 4].map((i) => ({ id: `d${i}`, status: 'new', sourceTier: 2, collectedAt: `2026-06-0${i}T00:00:00+08:00` })))
                const r = await stageDetailFetch({ chain: [record], ...opt }).run({ deps: { stores: { docs }, settings: S({ articles: { perRun: 2 } }) }, log })
                return { seen, r }
            }
            const args = []
            const { seen } = await run({ pick: async (cands, x) => {
                args.push([cands.map((d) => d.id), x.quota, typeof x.ctx, typeof x.queues])
                return [cands[3], cands[3], { id: 'not-a-candidate' }, cands[1], cands[0]]
            } })
            assert.deepEqual(args, [[['d1', 'd2', 'd3', 'd4'], 2, 'object', 'object']], '候選為全部待抓件(現行排序)、附配額與佇列')
            assert.deepEqual(seen, ['d4', 'd2'], '依回傳序、去重、剔除非候選、截至 quota')
            assert.deepEqual((await run({})).seen, ['d1', 'd2'], '未給 pick:現行取前 quota')
            await assert.rejects(() => run({ pick: () => 'x' }), /detailFetch 之 opt\.pick 須回傳文件陣列（候選之子集）/)
            assert.deepEqual((await run({ pick: () => [] })).seen, [], '回空陣列即本輪不抓')
        })

        it('零件庫用法(逐篇逾時):opt.timeoutMsOf(doc, { remainingMs, left, index }) 回正整數即為該篇逾時(逾時 → 退回 new、tries+1);回非正整數用抓取器或 capture.articles.timeoutMs;未給者行為不變', async () => {
            // 規則:stages/detailFetchStage.mwFetchDetail 之 JSDoc(timeoutMsOf);逾時分流為重試類(stores/fetchPolicy)
            const HEALTHY = '這是一段用於測試之正常內容，描述研究方法、實驗設計與結果之分析。'.repeat(20)
            const mk = (opt) => {
                const docs = memStore([{ id: 'a', status: 'new', title: '文章 a', url: 'https://site.example/a', fetchTries: 0, sourceTier: 2, collectedAt: '2026-06-01' }, { id: 'b', status: 'new', title: '文章 b', url: 'https://site.example/b', fetchTries: 0, sourceTier: 2, collectedAt: '2026-06-02' }])
                const slow = { id: 'article', retries: 0, retryDelayMs: 0, timeoutMs: 0, fetch: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, text: HEALTHY }), 150)) }
                // 瀏覽器分流關閉(browser.perRun 0):逾時本屬可轉瀏覽器之類,關閉即退回重試;本案不開真瀏覽器
                const deps = { stores: { docs }, registry: { resolve: () => slow, label: () => 'article' }, seen: { idOf: () => 'zz-unknown' }, settings: S({ articles: { perRun: 5, maxTries: 3, timeoutMs: 5000 }, browser: { perRun: 0 } }), clock }
                return { docs, run: () => stageDetailFetch(opt).run({ deps, log }) }
            }
            const seen = []
            const e = mk({ timeoutMsOf: (doc, x) => {
                seen.push([doc.id, typeof x.remainingMs, x.left, x.index])
                return doc.id === 'a' ? 30 : 0
            } })
            await e.run()
            assert.deepEqual(seen, [['a', 'number', 1, 0], ['b', 'number', 0, 1]], '逐篇以本輪取件之序與其後篇數呼叫')
            const a = await e.docs.get('a')
            assert.deepEqual([a.status, a.fetchTries, a.lastReason], ['new', 1, 'timeout'], '30ms 逾時 → 逾時類(瀏覽器關閉即退回重試)')
            assert.equal((await e.docs.get('b')).status, 'raw', '回 0 → 用設定之 5000ms,抓成')
            const plain = mk({})
            await plain.run()
            assert.deepEqual([(await plain.docs.get('a')).status, (await plain.docs.get('b')).status], ['raw', 'raw'], '未給者行為不變')
        })

        it('補全文落庫：未達上限退回 new（排隊末重試）；達 capture.articles.maxTries 標 dead 並移出待抓清單', async () => {
            const docs = memStore([
                { id: 'a', status: 'new', fetchTries: 1 },
                { id: 'b', status: 'new', fetchTries: 2 },
            ])
            const deps = { stores: { docs }, settings: S({ articles: { maxTries: 3, maxTextChars: 100 } }), clock: genClockTZ('Asia/Taipei') }
            const run = async (id, tries) => {
                const msg = makeMsg('doc', { id, _tries: tries, _fetched: { ok: false, message: 'HTTP 403' } }, { stage: 'detailFetch' })
                await composeChain([mwPersistOutcome()], { chainName: 'x' })(msg, { deps, log })
                return docs.get(id)
            }
            const a = await run('a', 2)
            assert.equal(a.status, 'new', '第 2 次失敗：退回 new 等重試（排隊末）')
            assert.equal(a.fetchTries, 2)
            assert.equal(a.deadAt, undefined, '未放棄者不記 deadAt')
            const b = await run('b', 3)
            assert.equal(b.status, 'dead', '第 3 次（capture.articles.maxTries）失敗：標為無效資料，移出待抓清單')
            assert.match(b.lastError, /HTTP 403/, '保留最後錯誤供稽核')
            assert.ok(b.deadAt, '記下放棄時刻')
            assert.ok(await docs.get('b'), '記錄永不刪除——它是去重憑證，刪了同一 url 會被重新收錄')
        })

        it('stageDetailFetch：有效輸入端到端跑通（含 onFail：逐篇鏈異常另記 fetchChainFails、不入判死次數、永不標 dead——程式／環境問題修好即可重抓）', async () => {
            const docs = memStore([{ id: 'a', status: 'new', fetchTries: 2 }])
            const deps = { stores: { docs }, settings: S({ articles: { perRun: 5, maxTries: 3 } }), clock: { iso8: () => NOW } }
            const r = await stageDetailFetch({ chain: [boom('逐篇鏈異常')] }).run({ deps, log })
            assert.equal(r.stats.fail, 1)
            const a = await docs.get('a')
            assert.deepEqual([a.status, a.fetchTries, a.fetchChainFails, a.deadAt], ['new', 2, 1, undefined], 'onFail 記 fetchChainFails(排序加計、排隊尾),fetchTries 不動、不標 dead(鏈異常與抓取失敗分帳)')
        })

        it('補全文逐篇鏈異常:onFail 記 fetchChainFails(不入判死次數 fetchTries;排序加計、排隊尾)、每次 WARN,永不標 dead——程式／環境問題修好即可重抓', async () => {
            const docs = memStore([
                { id: 'a', status: 'new', fetchTries: 0, collectedAt: '2026-06-01' },
                { id: 'b', status: 'new', fetchTries: 2, collectedAt: '2026-06-02' },
            ])
            const deps = { stores: { docs }, settings: S({ articles: { perRun: 5, maxTries: 3 } }), clock }
            const r = await stageDetailFetch({ chain: [boom('無可用內文抓取器')] }).run({ deps, log })
            assert.equal(r.stats.fail, 2)
            const a = await docs.get('a')
            const b = await docs.get('b')
            assert.deepEqual([a.status, a.fetchTries, a.fetchChainFails], ['new', 0, 1], '判死次數不動、鏈異常另計')
            assert.deepEqual([b.status, b.fetchTries, b.fetchChainFails, b.deadAt], ['new', 2, 1, undefined], '異常 k 次之件其後仍有完整之真抓取次數;永不標 dead')
            assert.match(b.lastError, /逐篇鏈異常：無可用內文抓取器/)
            // 排序:tries＋鏈異常次數(a:0＋1=1 排在無異常之新件之後)
            const order = byRetryTierFifo('fetchTries', { plus: 'fetchChainFails' })
            const rows = [{ id: 'x', fetchTries: 0, fetchChainFails: 1, collectedAt: '2026-01-01' }, { id: 'y', fetchTries: 0, collectedAt: '2026-06-01' }].sort(order)
            assert.deepEqual(rows.map((x) => x.id), ['y', 'x'], '鏈異常者排隊尾(不擋隊頭)')
        })

        it('標題預篩命中之彙整貼文,抓取 ok 但零連結或內容契約判 too-short → 首次即 skip(不送 AI、不走 feed 退路);網路失敗 → 退回 new 重試(不走 feed)', async () => {
            const docs = memStore([
                { id: 'w1', status: 'new', title: 'Weekly Roundup #3', url: 'https://e.com/w1', fetchTries: 0, feedText: 'x'.repeat(400), collectedAt: '2026-06-01' },
                { id: 'w2', status: 'new', title: 'Weekly Roundup #4', url: 'https://e.com/w2', fetchTries: 0, feedText: 'x'.repeat(400), collectedAt: '2026-06-02' },
                { id: 'w3', status: 'new', title: 'Weekly Roundup #5', url: 'https://e.com/w3', fetchTries: 0, feedText: 'x'.repeat(400), collectedAt: '2026-06-03' },
            ])
            const fetchers = {
                w1: { id: 'links', retries: 0, retryDelayMs: 0, fetch: async () => ({ ok: true, links: [] }) }, // 抓到但零連結
                w2: { id: 'links', retries: 0, retryDelayMs: 0, fetch: async () => ({ ok: false, reason: 'too-short', message: '正文 0 字' }) }, // 內容契約
                w3: { id: 'links', retries: 0, retryDelayMs: 0, fetch: async () => {
                    throw new Error('ECONNRESET')
                } },
            }
            const registry = { resolve: (role, d) => fetchers[d.id], label: () => 'links' }
            const deps = { stores: { docs }, registry, settings: S({ articles: { perRun: 5, maxTries: 3, maxTextChars: 10000, aggregatorLinksPerDoc: 12, timeoutMs: 1000, skipTitlePatterns: [/^Weekly/i] }, standards: { minFallbackChars: 300 } }), clock }
            const logger = recLog()
            const r = await stageDetailFetch().run({ deps, log: logger })
            assert.equal(r.detail.titleSkipped, 2)
            for (const id of ['w1', 'w2']) {
                const d = await docs.get(id)
                assert.equal(d.status, 'skip', `${id} 零連結之彙整貼文首次即 skip`)
                assert.match(d.skipReason, /無可轉錄之連結（未進 AI）/)
                assert.equal(d.text, undefined, '不走 feed 退路(feedText 達門檻亦不送 AI)')
            }
            const w3 = await docs.get('w3')
            assert.deepEqual([w3.status, w3.fetchTries], ['new', 1], '網路失敗:退回 new 重試,不走 feed')
            assert.ok(logger.lines.some((l) => /^INFO 彙整\[Weekly Roundup #3\] 無可轉錄之連結，略過（未進 AI）/.test(l)), logger.lines.join('\n'))
        })
    })

    // ══════════════════════════ docMaintain ══════════════════════════
    describe('docMaintainStage', function() {

        it('mwSlim／mwRecheckHealth／mwFillParaKeys／stageDocMaintain：工廠 opt 非物件不拋錯，回退為 {}', () => {
            assert.equal(mwSlim(null).name, 'slim')
            assert.equal(mwRecheckHealth('x').name, 'recheckHealth')
            assert.equal(mwFillParaKeys(0).name, 'fillParaKeys')
            assert.equal(stageDocMaintain('x').name, 'docMaintain')
        })

        it('stageDocMaintain：有效輸入端到端跑通（終態瘦身；設 docTexts 時先另存再清）', async () => {
            const docs = memStore([{ id: '1', status: 'noted', text: 'AAAA', feedText: 'BB' }])
            const docTexts = memStore()
            const stage = stageDocMaintain({ terminalStatuses: ['noted'] })
            const r = await stage.run({ deps: { stores: { docs, docTexts }, settings: S() }, log })
            assert.equal(r.ok, true)
            assert.equal((await docs.get('1')).text, '', '有效輸入瘦身行為不變')
            assert.ok(await docTexts.get('1'), '原文已另存')
            assert.deepEqual([r.detail.slimmed, r.detail.archived, r.detail.noArchive], [1, 1, 0])
        })

        it('stageDocMaintain(原文不得在無另存時被清除):未設 docTexts → noted 不清、WARN 一次、report noArchive;有效輸入不拋錯', async () => {
            const docs = memStore([{ id: '1', status: 'noted', text: 'AAAA', feedText: 'BB' }])
            const lines = []
            const wlog = { info: () => {}, warn: (m) => lines.push(m), error: () => {} }
            const r = await stageDocMaintain({ terminalStatuses: ['noted'] }).run({ deps: { stores: { docs }, settings: S() }, log: wlog })
            assert.equal(r.ok, true)
            assert.equal((await docs.get('1')).text, 'AAAA', '無另存集合 → 原文不清')
            assert.equal(lines.filter((l) => /未設原文另存集合（docTexts）/.test(l)).length, 1, 'WARN 一次')
            assert.equal(r.detail.noArchive, 1)
        })

        it('capture.articles.archiveText:false(零件庫用法,不回溯原文):設了 docTexts 亦不另存、須另存之終態不清正文(INFO 不 WARN;report noArchive);不須另存之終態照常瘦身;補全文落 raw 亦不另存', async () => {
            // 規則:core/settingsDefault articles.archiveText;stages/docMaintainStage.mwSlim 與 detailFetchStage.archiveNow 同讀此鍵
            const docs = memStore([{ id: 'n', status: 'noted', text: '正文甲' }, { id: 'd', status: 'dead', text: '殘文' }])
            const docTexts = memStore()
            const lines = []
            const wlog = { info: (m) => lines.push(`INFO ${m}`), warn: (m) => lines.push(`WARN ${m}`), error: () => {} }
            const r = await stageDocMaintain().run({ deps: { stores: { docs, docTexts }, settings: S({ articles: { archiveText: false } }), clock: { iso8: () => NOW } }, log: wlog })
            assert.deepEqual([(await docs.get('n')).text, (await docs.get('d')).text], ['正文甲', ''])
            assert.deepEqual([(await docTexts.select()).length, r.detail.archived, r.detail.noArchive, r.detail.slimmed], [0, 0, 1, 1])
            assert.ok(lines.some((l) => /^INFO 終態文件瘦身：原文另存停用（capture\.articles\.archiveText:false）/.test(l)), lines.join('\n'))
            assert.ok(!lines.some((l) => /^WARN/.test(l)), '停用是設定,不是警告')
            // 補全文落 raw:不另存
            const HEALTHY = '這是一段用於測試之正常內容，描述研究方法、實驗設計與結果之分析。'.repeat(20)
            const docs2 = memStore([{ id: 'a', status: 'new', title: '文章 a', url: 'https://site.example/a', fetchTries: 0, sourceTier: 2, collectedAt: '2026-06-01' }])
            const docTexts2 = memStore()
            const fetcher = { id: 'article', retries: 0, retryDelayMs: 0, timeoutMs: 1000, fetch: async () => ({ ok: true, text: HEALTHY }) }
            const deps2 = { stores: { docs: docs2, docTexts: docTexts2 }, registry: { resolve: () => fetcher, label: () => 'article' }, seen: { idOf: () => 'zz-unknown' }, settings: S({ articles: { perRun: 5, maxTries: 3, archiveText: false }, browser: { perRun: 0 } }), clock }
            await stageDetailFetch().run({ deps: deps2, log })
            assert.deepEqual([(await docs2.get('a')).status, (await docTexts2.select()).length], ['raw', 0])
            const deps3 = { ...deps2, stores: { docs: memStore([{ id: 'a', status: 'new', title: '文章 a', url: 'https://site.example/a', fetchTries: 0, sourceTier: 2, collectedAt: '2026-06-01' }]), docTexts: memStore() }, settings: S({ articles: { perRun: 5, maxTries: 3 }, browser: { perRun: 0 } }) }
            await stageDetailFetch().run({ deps: deps3, log })
            assert.equal((await deps3.stores.docTexts.select()).length, 1, '預設(true)落 raw 即另存')
        })

        it('終態瘦身(原文不得在無另存時被清除):未設 docTexts → 須另存之終態(noted／skip／summarize-failed)不清、WARN 一次;dead／aggregated 照常瘦身(不另存之終態);設 docTexts 時照常先存後清', async () => {
            const rows = () => [
                { id: 'n', status: 'noted', text: '正文甲' },
                { id: 's', status: 'skip', text: '正文乙' },
                { id: 'f', status: 'summarize-failed', text: '正文丙' },
                { id: 'd', status: 'dead', text: '殘文' },
                { id: 'a', status: 'aggregated', feedText: '彙整摘要' },
            ]
            // 終態集合為常數 DOC_TERMINAL_STATUSES(非設定;子階段 opt.terminalStatuses 可另給)
            const terminal = ['noted', 'skip', 'dead', 'aggregated', 'summarize-failed']
            assert.deepEqual([...DOC_TERMINAL_STATUSES], terminal)
            const docs = memStore(rows())
            const warns = []
            const wlog = { info: () => {}, warn: (m) => warns.push(m), error: () => {} }
            const r = await stageDocMaintain().run({ deps: { stores: { docs }, settings: S(), clock: { iso8: () => NOW } }, log: wlog })
            // 規格:無另存 → 須另存之終態原文保留
            assert.deepEqual(await Promise.all(['n', 's', 'f'].map(async (id) => (await docs.get(id)).text)), ['正文甲', '正文乙', '正文丙'])
            // 規格:不需另存之終態(dead、aggregated)照常清
            assert.deepEqual([(await docs.get('d')).text, (await docs.get('a')).feedText], ['', ''])
            assert.equal(warns.length, 1, 'WARN 一次(每輪一行,不逐篇)')
            assert.match(warns[0], /未設原文另存集合（docTexts），noted／skip／summarize-failed 之原文本輪不清/)
            assert.deepEqual([r.detail.slimmed, r.detail.noArchive], [2, 1])
            // 規格:設 docTexts 時照常先存後清(另存 3 篇)
            const docs2 = memStore(rows())
            const docTexts = memStore()
            const r2 = await stageDocMaintain().run({ deps: { stores: { docs: docs2, docTexts }, settings: S(), clock: { iso8: () => NOW } }, log: wlog })
            assert.deepEqual([r2.detail.slimmed, r2.detail.archived, r2.detail.noArchive], [5, 3, 0])
            assert.equal(warns.length, 1, '有另存集合不 WARN')
        })

        it('docMaintain 沒有時間型過期：不論多舊、抓過幾次，new 件經維護後仍是 new；瘦身照常', async () => {
            const day = 86400_000
            const ago = (d) => new Date(Date.now() - d * day).toISOString()
            const docs = memStore([
                { id: 'never-old', status: 'new', fetchTries: 0, collectedAt: ago(400) }, // 沒輪到 400 天：不丟
                { id: 'tried-old', status: 'new', fetchTries: 2, collectedAt: ago(400) }, // 抓過 2 次、400 天：不丟（下輪 FIFO 再試）
                { id: 'noted-old', status: 'noted', text: 'AAAA', feedText: 'BB', collectedAt: ago(400) },
            ])
            const stage = stageDocMaintain({ terminalStatuses: ['noted'] })
            // 瘦身前原文須先另存(docTexts;無另存集合即不清)
            const docTexts = memStore([])
            const r = await stage.run({ deps: { stores: { docs, docTexts }, settings: S() }, log })
            assert.equal(r.ok, true)
            assert.equal((await docs.get('never-old')).status, 'new', '知識庫沒有逾期：從未輪到者不丟')
            assert.equal((await docs.get('tried-old')).status, 'new', '抓過失敗者由 detailFetch 試滿 capture.articles.maxTries 標 dead，不因時間丟')
            assert.equal((await docs.get('noted-old')).text, '', '終態瘦身照常(原文已另存)')
            assert.equal(r.detail.expired, undefined, '鏈上沒有 expire 環')
        })

        it('檢定標準 CS10 存量段落雜湊補算(docMaintain.fillParaKeys):noted 無 paraKeys 者以 docs 之原文(未瘦身)或 docTexts 之另存原文補算並寫回;兩處皆無 → 記 paraKeysNoText(不再每輪重試);已有 paraKeys 者不動;每輪上限、依 notedAt 先後;冪等(再跑不重寫)', async () => {
            const P = (s) => `${s}之研究段落內容說明，`.repeat(7)
            const text = [P('甲'), P('乙'), P('丙')].join('\n')
            const docs = memStore([
                { id: 'live', status: 'noted', notedAt: '2026-10-01', text },
                { id: 'arch', status: 'noted', notedAt: '2026-10-02', text: '' },
                { id: 'gone', status: 'noted', notedAt: '2026-10-03', text: '' },
                { id: 'done', status: 'noted', notedAt: '2026-09-01', paraKeys: ['x'] },
                { id: 'later', status: 'noted', notedAt: '2026-10-04', text },
                { id: 'raw1', status: 'raw', text },
            ])
            const docTexts = memStore([{ id: 'arch', gz: packText(text), feedGz: '', sha1: 'h' }])
            const lines = []
            const ilog = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: () => {} }
            const deps = { stores: { docs, docTexts }, settings: S(), clock: { iso8: () => NOW } }
            const r = await stageDocMaintain({ paraKeysPerRun: 3, terminalStatuses: [] }).run({ deps, log: ilog })
            // 規格:docs 有原文者以之補算;另存原文者以 docTexts 補算;皆無 → 記無原文(不寫空陣列——空陣列表示「已算而無足長段落」)
            assert.deepEqual((await docs.get('live')).paraKeys, paraKeysOf(text))
            assert.deepEqual((await docs.get('arch')).paraKeys, paraKeysOf(text))
            const gone = await docs.get('gone')
            assert.deepEqual([gone.paraKeys, gone.paraKeysNoText], [undefined, NOW])
            // 規格:每輪上限 3、依 notedAt 先後 → 最晚之 later 留下輪;已有者與非 noted 者不動
            assert.equal((await docs.get('later')).paraKeys, undefined)
            assert.deepEqual((await docs.get('done')).paraKeys, ['x'])
            assert.equal((await docs.get('raw1')).paraKeys, undefined)
            assert.deepEqual(r.detail.paraKeys, { due: 4, filled: 2, noText: 1, left: 1 })
            assert.ok(lines.some((l) => /^段落雜湊補算（CS10 存量）：待補 4、本輪補 2、無原文 1.*留下輪 1/.test(l)), lines.join('\n'))
            // 規格:冪等——再跑只補剩下者,已補／已記無原文者不再選
            const r2 = await stageDocMaintain({ paraKeysPerRun: 3, terminalStatuses: [] }).run({ deps, log: ilog })
            assert.deepEqual(r2.detail.paraKeys, { due: 1, filled: 1, noText: 0, left: 0 })
            const r3 = await stageDocMaintain({ paraKeysPerRun: 3, terminalStatuses: [] }).run({ deps, log: ilog })
            assert.deepEqual(r3.detail.paraKeys, { due: 0, filled: 0, noText: 0, left: 0 })
        })

        it('段落雜湊補算之每輪名額取自 settings.capture.standards.paraKeysPerRun;子階段 opt.paraKeysPerRun 優先', async () => {
            const P = (s) => `${s}之研究段落內容說明，`.repeat(7)
            const text = [P('甲'), P('乙'), P('丙')].join('\n')
            const mk = () => memStore([1, 2, 3].map((i) => ({ id: `n${i}`, status: 'noted', notedAt: `2026-10-0${i}`, text })))
            const run = async (settings, opt = {}) => (await stageDocMaintain({ terminalStatuses: [], ...opt }).run({ deps: { stores: { docs: mk(), docTexts: memStore() }, settings, clock: { iso8: () => NOW } }, log })).detail.paraKeys
            assert.deepEqual(await run(S({ standards: { paraKeysPerRun: 2 } })), { due: 3, filled: 2, noText: 0, left: 1 })
            assert.deepEqual(await run(S({ standards: { paraKeysPerRun: 2 } }), { paraKeysPerRun: 3 }), { due: 3, filled: 3, noText: 0, left: 0 })
        })
    })

    // ══════════════════════════ expand ══════════════════════════
    describe('expandStage', function() {

        it('probeSiteFeed:clue 非物件 → null;有效物件(非 site)沿既有邏輯回 null,不觸碰 ctx.deps', async () => {
            assert.equal(await probeSiteFeed(null, {}), null)
            assert.equal(await probeSiteFeed('x', {}), null)
            assert.equal(await probeSiteFeed(123, {}), null)
            // 有效物件但非 site 線索:走既有 `clue.type !== 'site'` 判斷回 null;ctx={} 若被誤觸碰 ctx.deps 會直接拋錯
            assert.equal(await probeSiteFeed({ type: 'topic', value: 'k' }, {}), null)
        })

        it('probeSearchEndpoints:clue 非物件 → null;opt 非物件視為{}且不拋錯(以非 keyword/topic 線索避開真實網路請求)', async () => {
            assert.equal(await probeSearchEndpoints(null, {}, {}), null)
            assert.equal(await probeSearchEndpoints('x', {}, {}), null)
            // 有效 clue 物件(非 keyword/topic)＋opt 給非物件:opt 應被靜默視為{}而不拋錯,並沿既有邏輯回 null
            assert.equal(await probeSearchEndpoints({ type: 'site', value: 'k' }, {}, 'not-object'), null)
            assert.equal(await probeSearchEndpoints({ type: 'site', value: 'k' }, {}, 123), null)
        })

        it('mwProbe:opt 非物件視為{};回傳 first 錨點 mw(name=probe、2 候選),有效 opt 亦同', () => {
            const bad = mwProbe('not-object')
            assert.equal(bad.name, 'probe')
            assert.equal(bad.mode, 'first')
            assert.equal(bad.candidates.length, 2)
            const good = mwProbe({ arxivCategories: ['cs.LG'] })
            assert.equal(good.name, 'probe')
            assert.equal(good.candidates.map((c) => c.name).join(','), 'site-feed,search-endpoints')
        })

        it('mwSettleClue:opt 非物件視為{},建構不拋錯;有效輸入結算成功線索落帳 newSources/docsAdded 並更新 frontier', async () => {
            const bad = mwSettleClue('not-object')
            assert.equal(bad.name, 'settleClue')

            const frontier = memStore([{ id: 'c1', type: 'site', value: 'https://e.example', status: 'pending', tries: 0, hits: 1, addedAt: '2026-01-01' }])
            const mw = mwSettleClue({ maxTries: 2 })
            const msg = makeMsg('clue', { id: 'c1', type: 'site', value: 'https://e.example', tries: 0, _outcome: { ok: true, newSources: 2, yieldDocs: 3 } })
            const ctx = { deps: { stores: { frontier }, clock }, log }
            const { halted } = await composeChain([mw])(msg, ctx)
            assert.equal(halted, '', '不短路:恆呼叫 next')
            assert.equal(msg.stats.newSources, 2)
            assert.equal(msg.stats.docsAdded, 3)
            assert.equal((await frontier.get('c1')).status, 'done')
        })

        it('stageExpand:opt 非物件視為{},不拋錯;有效輸入(無待探索線索)行為不變', async () => {
            const bad = stageExpand('not-object')
            assert.equal(typeof bad.run, 'function')

            const frontier = memStore([])
            const stage = stageExpand({})
            const r = await stage.run({ deps: { stores: { frontier }, settings: S({ expand: { perRun: 5, maxPending: 0 } }), clock }, log })
            assert.equal(r.ok, true)
            assert.equal(r.detail.picked, 0)
        })

        it('stageExpand 之名額與上限取自設定:每輪取用筆數＝settings.capture.expand.perRun、待探索上限＝expand.maxPending(超過者淘汰最低優先);子階段 opt(perRun／maxPending)優先', async () => {
            const clues = () => memStore([1, 2, 3, 4].map((i) => ({ id: `c${i}`, type: 'keyword', value: `k${i}`, hits: 10 - i, status: 'pending', tries: 0, addedAt: '2026-01-01' })))
            const picked = async (settings, opt = {}) => {
                const seen = []
                const record = defineMw({ name: 'record', handle: async (msg, ctx, next) => {
                    seen.push(msg.data.id)
                    msg.data._outcome = { ok: true, resolved: 'x', yieldDocs: 0, newSources: 0 }
                    return next(msg)
                } })
                const frontier = clues()
                const r = await stageExpand({ chain: [record, mwSettleClue()], ...opt }).run({ deps: { stores: { frontier }, settings, clock: { iso8: () => NOW } }, log })
                return { seen, evicted: r.detail.evicted }
            }
            assert.deepEqual(await picked(S({ expand: { perRun: 2, maxPending: 0 } })), { seen: ['c1', 'c2'], evicted: 0 }, 'perRun 2,依 hits 高者先')
            assert.deepEqual(await picked(S({ expand: { perRun: 2, maxPending: 0 } }), { perRun: 3 }), { seen: ['c1', 'c2', 'c3'], evicted: 0 }, 'opt.perRun 優先')
            assert.deepEqual(await picked(S({ expand: { perRun: 5, maxPending: 3 } })), { seen: ['c1', 'c2', 'c3'], evicted: 1 }, 'maxPending 3:淘汰優先序最低之 1 筆(hits 最低者),其餘皆取')
            assert.deepEqual(await picked(S({ expand: { perRun: 5, maxPending: 3 } }), { maxPending: 0 }), { seen: ['c1', 'c2', 'c3', 'c4'], evicted: 0 }, 'opt.maxPending 0＝不設限')
        })

        it('stageExpand(靜默剔除改計數):探測入庫之契約不符、業務過濾、同一內容(CS10)筆數經結算環計入 report detail', async () => {
            const frontier = memStore([{ id: 'c1', type: 'keyword', value: 'gradient', status: 'pending', hits: 3, tries: 0, firstSeenAt: NOW }])
            const probe = { __kind: 'mw', name: 'probe', handle: async (msg, ctx, next) => {
                msg.data._outcome = { ok: true, resolved: 'search:gradient', yieldDocs: 1, newSources: 0, invalid: 2, filtered: 1, sameContent: 1 }
                return next(msg)
            } }
            const deps = { stores: { frontier }, settings: S({ expand: { perRun: 5, maxPending: 0 } }), clock: { iso8: () => NOW } }
            const r = await stageExpand({ chain: [probe, mwSettleClue()] }).run({ deps, log })
            assert.deepEqual([r.detail.picked, r.detail.docsAdded, r.detail.invalid, r.detail.filtered, r.detail.sameContent], [1, 1, 2, 1, 1])
        })

        it('擴充逐線索鏈異常:onFail 記 chainFails 並退避(retryAt),不加 tries、不轉 failed;退避中之線索不再被挑', async () => {
            const frontier = memStore([{ id: 'c1', type: 'keyword', value: 'k', hits: 9, status: 'pending', tries: 0, addedAt: '2026-01-01' }])
            const deps = { stores: { frontier }, settings: S({ expand: { perRun: 5, maxPending: 0 } }), clock }
            const stage = stageExpand({ chain: [boom('入庫失敗')], maxTries: 2 })
            await stage.run({ deps, log })
            let c = await frontier.get('c1')
            assert.deepEqual([c.status, c.tries, c.chainFails], ['pending', 0, 1])
            assert.ok(Date.parse(c.retryAt) > Date.now(), '退避(retryAt 在未來)')
            assert.match(c.lastError, /逐線索鏈異常：入庫失敗/)
            const r2 = await stage.run({ deps, log })
            c = await frontier.get('c1')
            assert.deepEqual([c.status, c.tries, c.chainFails, r2.detail.picked], ['pending', 0, 1, 0], '退避中不被挑;永不轉 failed')
        })
    })
})
