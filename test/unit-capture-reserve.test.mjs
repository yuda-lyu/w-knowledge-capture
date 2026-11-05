// unit-capture-reserve.test.mjs — 抓取各耗時子階段扣「保留給後段之時間」(opt.reserveMs 或每輪依賴 deps.reserveMs):
//   listFetch(輪抓)、detailFetch(補全文與瀏覽器佇列)、expand(線索擴充)、docMaintain(文件維護)、areas(領域發現)
// 規則(出自各子階段檔頭與規則帳本 CAP-17):
//   ①保留 > 0 時,開工前與每次取件前須「整輪剩餘 − 保留 ≥ 一次作業之估計」才開工;不足即少做、未處理者原樣留佇列待下輪(不記次、不退避)
//   ②保留未給(或 0)時行為與無此機制前完全相同:只守整輪是否逾期;report 欄集不變(新欄 reserveDeferred 只在確因保留而延後時才有)
//   ③整輪已逾期、沒有待處理者、做完最後一件後才不足者,皆不算「因保留而延後」
//   ④保留值之取法:opt.reserveMs 明給者優先(含 0;建構即檢核)、未給取 ctx.deps.reserveMs、皆未給為 0;不合法於建構或該輪開工時拋出
// 時間以注入之虛擬時鐘推進(替身抓取器／探測器／集合寫入各自把時鐘推進一個固定量),不用真實等待
// 執行:自套件根 npx mocha test/unit-capture-reserve.test.mjs(暫存 test/_tmp/capture-reserve-<pid>,測完即刪)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import W from 'w-data-pipeline/src/WDataPipeline.mjs'
import { memStore } from './tools/memStore.mjs'
import { deepMerge, settingsOf as S } from './tools/captureTestKit.mjs'
import { recLog } from './tools/testKit.mjs'
import { defineMw } from '../src/core/kernel.mjs'
import { resolveSettings } from '../src/core/settingsDefault.mjs'
import { stageListFetch } from '../src/stages/listFetchStage.mjs'
import { stageDetailFetch } from '../src/stages/detailFetchStage.mjs'
import { stageExpand } from '../src/stages/expandStage.mjs'
import { stageDocMaintain } from '../src/stages/docMaintainStage.mjs'
import { stageAreas } from '../src/stages/areaStage.mjs'
import { createBrowserFetcher, ladderTimeoutMs } from '../src/fetchers/browserFetcher.mjs'
import { areaIdOf } from '../src/stores/areaPolicy.mjs'
import { createCaptureObject } from '../src/captureObject.mjs'

const NOW = '2026-10-05T18:00:00+08:00'
const NOW_MS = Date.parse(NOW)
const SEC = 1000
const MIN = 60 * SEC
const TMP = path.resolve(`test/_tmp/capture-reserve-${process.pid}`)
const LONG = (s) => `${s}。本段說明研究設計、樣本期間、交易成本假設與穩健性檢驗之結果。`.repeat(12)

/**
 * 虛擬時鐘:整輪預算 totalMs;各替身作業以 advance 推進;ctx 之 remainingMs／expired 自此取(同 w-data-pipeline 之 ctx 形狀)
 *
 * @param {Number} totalMs 輸入整輪預算毫秒數(Infinity＝無截止)
 * @returns {Object} 回傳 { advance, now, bits:{ remainingMs, expired } }
 */
function vclock(totalMs) {
    let t = 0
    return {
        advance: (ms) => {
            t += ms
        },
        now: () => t,
        bits: { remainingMs: () => Math.max(0, totalMs - t), expired: () => t >= totalMs },
    }
}

/** 報告之 detail 是否帶「因保留而延後」之欄(未延後時不得有此欄:report 欄集於平時不變) */
const hasDeferKey = (r) => Object.hasOwn(r.detail, 'reserveDeferred')

describe('unit-capture-reserve', function() {

    before(() => {
        fs.mkdirSync(TMP, { recursive: true })
    })
    after(() => {
        fs.rmSync(TMP, { recursive: true, force: true })
    })

    // ══════════════════════════ 物件之接線 ══════════════════════════
    describe('物件(createCaptureObject)之 opt.<子階段>.reserveMs 接線', function() {
        it('五個耗時段之 opt.reserveMs 皆經物件傳入各子階段工廠:不合法者於建構即拋(訊息含該段函數名);合法者建構成功;不判時間之 hygiene、seedSync 照常建構', () => {
            const names = { listFetch: 'stageListFetch', detailFetch: 'stageDetailFetch', expand: 'stageExpand', docMaintain: 'stageDocMaintain', areas: 'stageAreas' }
            for (const [key, fn] of Object.entries(names)) {
                assert.throws(() => createCaptureObject({ [key]: { reserveMs: -1 } }), new RegExp(`${fn} 之 opt\\.reserveMs`), key)
                assert.equal(createCaptureObject({ [key]: { reserveMs: 600000 } }).name, '抓取', key)
            }
            assert.equal(createCaptureObject({ hygiene: {}, seedSync: {} }).name, '抓取')
        })
    })

    // ══════════════════════════ listFetch ══════════════════════════
    describe('listFetch(輪抓)', function() {
        /**
         * 環境:n 個到期來源;每次抓取把虛擬時鐘推進 consumeMs;一次作業估計＝列表抓取逾時(settings.capture.sources.listTimeoutMs 預設 2 分)
         *
         * @param {Object} o 輸入 { n, totalMs, reserveMs(deps), consumeMs, stageOpt, cap }
         * @returns {Object} 回傳 { vt, sources, calls, run, log, ctx }
         */
        function env(o = {}) {
            const vt = vclock(o.totalMs ?? Infinity)
            const rows = Array.from({ length: o.n ?? 5 }, (_, i) => ({ id: `s${i + 1}`, name: `S${i + 1}`, kind: 'rss', url: `https://ex.example/f${i + 1}`, tier: 1, lastFetchAt: '', failCount: 0 }))
            const sources = memStore(rows)
            const calls = []
            const fetcher = W.defineFetcher({
                id: 'rss',
                kinds: ['rss'],
                ...(o.fetcherOpt || {}),
                fetch: async (src) => {
                    calls.push(src.id)
                    vt.advance(o.consumeMs ?? 0)
                    return [{ url: `https://ex.example/post/${src.id}`, title: `黑洞光譜 ${src.id}` }]
                },
            })
            const registry = { resolve: () => fetcher, label: () => 'rss' }
            const seen = { admit: async (items) => ({ fresh: items.map((x, i) => ({ id: `${x.url}#${i}`, url: x.url })), dup: 0, invalid: [] }) }
            const log = recLog()
            const deps = {
                stores: { sources },
                registry,
                seen,
                settings: S(deepMerge({ sources: { perRun: 10, minIntervalMs: 0 } }, o.cap)),
                clock: { iso8: () => NOW },
                ...(o.reserveMs !== undefined ? { reserveMs: o.reserveMs } : {}),
            }
            const ctx = { deps, log, ...vt.bits }
            return { vt, sources, calls, log, ctx, stage: () => stageListFetch(o.stageOpt), run: () => stageListFetch(o.stageOpt).run(ctx) }
        }
        const untouched = async (e) => (await e.sources.select()).filter((s) => s.lastFetchAt === '').length

        it('開工前:扣保留後剩餘不足一次作業 → 不開工(0 次抓取)、來源原樣留佇列(lastFetchAt 不動)、detail.reserveDeferred＝留下輪來源數、日誌寫明', async () => {
            // 剩餘 20 分、保留 19 分 → 可用 1 分 < 一次作業估計 2 分
            const e = env({ n: 5, totalMs: 20 * MIN, reserveMs: 19 * MIN, consumeMs: 10 * SEC })
            const r = await e.run()
            assert.deepEqual(e.calls, [], '不得發出任何抓取')
            assert.equal(await untouched(e), 5, '5 個來源皆原樣留佇列(lastFetchAt 不動,下輪仍為最舊優先)')
            assert.deepEqual([r.detail.sourcesTried, r.detail.left, r.detail.reserveDeferred], [0, 5, 5])
            assert.ok(e.log.lines.some((l) => /^INFO .*保留/.test(l) && l.includes('5')), `須有說明因保留而延後之 INFO 日誌:${e.log.lines.join(' | ')}`)
            assert.equal(e.log.lines.some((l) => l.includes('逾時間預算')), false, '不是逾整輪預算,不得印「逾時間預算」')
        })

        it('每次取件前判:做完第 1 個後剩餘可用(1 分)不足一次作業(2 分) → 第 2 個不開工;其餘 4 個留佇列', async () => {
            // 剩餘 30 分、保留 25 分 → 可用 5 分;每次抓取耗 4 分:第 1 個前 5 ≥ 2 → 開;後 1 < 2 → 停
            const e = env({ n: 5, totalMs: 30 * MIN, reserveMs: 25 * MIN, consumeMs: 4 * MIN })
            const r = await e.run()
            assert.deepEqual(e.calls, ['s1'])
            assert.equal(await untouched(e), 4)
            assert.deepEqual([r.detail.sourcesTried, r.detail.left, r.detail.reserveDeferred], [1, 4, 4])
        })

        it('保留未給:行為與現版相同——全部來源照抓、無 reserveDeferred 欄(report 欄集不變)', async () => {
            const e = env({ n: 5, totalMs: 30 * MIN, consumeMs: 4 * MIN })
            const r = await e.run()
            assert.deepEqual(e.calls, ['s1', 's2', 's3', 's4', 's5'])
            assert.deepEqual([r.detail.sourcesTried, r.detail.left], [5, 0])
            assert.equal(hasDeferKey(r), false)
            // 保留明給 0 亦同
            const z = env({ n: 5, totalMs: 30 * MIN, consumeMs: 4 * MIN, stageOpt: { reserveMs: 0 } })
            const rz = await z.run()
            assert.deepEqual([rz.detail.sourcesTried, hasDeferKey(rz)], [5, false])
        })

        it('保留未給:整輪預算耗盡才停(與現版同:逾整輪預算之 WARN、無 reserveDeferred)', async () => {
            const e = env({ n: 5, totalMs: 10 * MIN, consumeMs: 4 * MIN })
            const r = await e.run()
            assert.deepEqual(e.calls, ['s1', 's2', 's3'], '第 3 個開工時剩 2 分,抓完耗盡 → 其後不取')
            assert.deepEqual([r.detail.sourcesTried, r.detail.left], [3, 2])
            assert.equal(hasDeferKey(r), false)
            assert.ok(e.log.lines.some((l) => l.startsWith('WARN') && l.includes('逾時間預算')))
        })

        it('邊界:可用剩餘恰等於一次作業 → 開工;少 1 毫秒 → 不開工', async () => {
            const at = env({ n: 1, totalMs: 10 * MIN, reserveMs: 10 * MIN - 2 * MIN, consumeMs: 0 })
            await at.run()
            assert.deepEqual(at.calls, ['s1'], '可用 2 分＝估計 2 分 → 開工')
            const lt = env({ n: 1, totalMs: 10 * MIN, reserveMs: 10 * MIN - 2 * MIN + 1, consumeMs: 0 })
            const r = await lt.run()
            assert.deepEqual(lt.calls, [], '可用 2 分少 1 毫秒 → 不開工')
            assert.equal(r.detail.reserveDeferred, 1)
        })

        it('一次作業估計取該輪各來源抓取逾時之最大者(抓取器自宣告者優先於 capture.sources.listTimeoutMs):逾時 90 秒 → 可用 100 秒即開工', async () => {
            const e = env({ n: 2, totalMs: 20 * MIN, reserveMs: 20 * MIN - 100 * SEC, cap: { sources: { listTimeoutMs: 90 * SEC } }, consumeMs: 0 })
            await e.run()
            assert.deepEqual(e.calls, ['s1', 's2'], '估計 90 秒 ≤ 可用 100 秒(耗時 0)')
            const f = env({ n: 2, totalMs: 20 * MIN, reserveMs: 20 * MIN - 100 * SEC, cap: { sources: { listTimeoutMs: 110 * SEC } }, consumeMs: 0 })
            const r = await f.run()
            assert.deepEqual(f.calls, [], '估計 110 秒 > 可用 100 秒')
            assert.equal(r.detail.reserveDeferred, 2)
        })

        it('估計含重試:抓取器逾時 60 秒、retries 1、retryDelayMs 1 秒 → 最壞 121 秒(2 次嘗試 ＋ 1 次等待);可用恰等於 → 開工,少 1 毫秒 → 不開', async () => {
            const fo = { timeoutMs: 60 * SEC, retries: 1, retryDelayMs: SEC }
            const at = env({ n: 1, totalMs: 20 * MIN, reserveMs: 20 * MIN - 121 * SEC, fetcherOpt: fo })
            await at.run()
            assert.deepEqual(at.calls, ['s1'])
            const lt = env({ n: 1, totalMs: 20 * MIN, reserveMs: 20 * MIN - 121 * SEC + 1, fetcherOpt: fo })
            const r = await lt.run()
            assert.deepEqual([lt.calls, r.detail.reserveDeferred], [[], 1])
        })

        it('整輪已逾期:不抓、不誤報為因保留而延後(走既有之逾時間預算 WARN)', async () => {
            const e = env({ n: 3, totalMs: 0, reserveMs: 15 * MIN })
            const r = await e.run()
            assert.deepEqual([e.calls.length, r.detail.left], [0, 3])
            assert.equal(hasDeferKey(r), false)
            assert.ok(e.log.lines.some((l) => l.startsWith('WARN') && l.includes('逾時間預算')))
        })

        it('沒有待處理者:不誤報(大保留亦然);做完最後一個後可用才不足 → 無來源可留,亦不誤報', async () => {
            const none = env({ n: 0, totalMs: 20 * MIN, reserveMs: 19 * MIN })
            const r0 = await none.run()
            assert.deepEqual([r0.detail.sourcesTried, r0.detail.left, hasDeferKey(r0)], [0, 0, false])
            // 2 個來源、可用 5 分、每次耗 4 分:第 2 個開工時可用 1 分 < 2 分 → 第 2 個被留下(此為延後,非本案);改以 1 個來源驗「做完最後一個」
            const last = env({ n: 1, totalMs: 30 * MIN, reserveMs: 25 * MIN, consumeMs: 4 * MIN })
            const r1 = await last.run()
            assert.deepEqual([last.calls, r1.detail.left, hasDeferKey(r1)], [['s1'], 0, false])
        })

        it('保留值之來源:opt.reserveMs 明給者優先於 deps.reserveMs(含明給 0);函數形式 (ctx) => 毫秒 每輪求值;皆未給為 0', async () => {
            // deps 保留 19 分(會延後),opt 明給 0 → 不保留、照抓
            const a = env({ n: 2, totalMs: 20 * MIN, reserveMs: 19 * MIN, stageOpt: { reserveMs: 0 } })
            await a.run()
            assert.deepEqual(a.calls, ['s1', 's2'])
            // opt 給大保留,deps 給 0 → 以 opt 為準而延後
            const b = env({ n: 2, totalMs: 20 * MIN, reserveMs: 0, stageOpt: { reserveMs: 19 * MIN } })
            const rb = await b.run()
            assert.deepEqual([b.calls, rb.detail.reserveDeferred], [[], 2])
            // 函數形式
            let seenCtx = null
            const c = env({
                n: 2,
                totalMs: 20 * MIN,
                stageOpt: {
                    reserveMs: (ctx) => {
                        seenCtx = ctx; return 19 * MIN
                    }
                }
            })
            const rc = await c.run()
            assert.deepEqual([c.calls, rc.detail.reserveDeferred, seenCtx === c.ctx], [[], 2, true])
        })

        it('reserveMs 不合法:opt 給了負數／字串／NaN → 建構即拋;deps 給了不合法值或函數回傳不合法 → 該輪開工時拋(不先動任何來源)', async () => {
            for (const bad of [-1, 'x', NaN, Infinity, true, {}]) assert.throws(() => stageListFetch({ reserveMs: bad }), /reserveMs/, `opt.reserveMs=${String(bad)}`)
            for (const bad of [-1, 'x', NaN, true]) {
                const e = env({ n: 2, totalMs: 20 * MIN, reserveMs: bad })
                await assert.rejects(e.run(), /deps\.reserveMs/, `deps.reserveMs=${String(bad)}`)
                assert.deepEqual(e.calls, [])
            }
            const f = env({ n: 2, totalMs: 20 * MIN, stageOpt: { reserveMs: () => -5 } })
            await assert.rejects(f.run(), /reserveMs/)
            assert.deepEqual(f.calls, [])
        })

        it('並行輪抓(concurrency):波次前判;一波(2 個)耗 4 分後可用 1 分 < 2 分 → 下一波不開', async () => {
            const e = env({ n: 5, totalMs: 30 * MIN, reserveMs: 25 * MIN, consumeMs: 4 * MIN, cap: { sources: { concurrency: 2 } } })
            const r = await e.run()
            assert.equal(e.calls.length, 2, '第一波 2 個來源')
            assert.deepEqual([r.detail.left, r.detail.reserveDeferred], [3, 3])
        })
    })

    // ══════════════════════════ detailFetch ══════════════════════════
    describe('detailFetch(補全文與瀏覽器佇列)', function() {
        const CAP = {
            articles: { perRun: 10, maxTries: 3, maxTextChars: 20000, aggregatorLinksPerDoc: 12, timeoutMs: 30 * SEC, skipTitlePatterns: [] },
            standards: { minFallbackChars: 300, minTextChars: 300 },
            browser: { perRun: 2, maxMs: 600000, navTimeoutMs: 20000, camofox: { enabled: true, port: 19417 } },
        }
        const doc = (id, extra = {}) => ({ id, status: 'new', kind: 'web', title: `文章 ${id}`, url: `https://site.example/${id}`, fetchTries: 0, sourceTier: 2, collectedAt: `2026-09-0${id.length}`, ...extra })
        /**
         * 環境:article 抓取器與 browser 抓取器(子行程執行器注入)每次作業把虛擬時鐘推進 consumeMs
         *
         * @param {Object} o 輸入 { rows, totalMs, reserveMs(deps), consumeMs, cliConsumeMs, stageOpt }
         * @returns {Object} 回傳 { vt, docs, articleCalls, cliCalls, run, log, settings }
         */
        function env(o = {}) {
            const vt = vclock(o.totalMs ?? Infinity)
            const docs = memStore(o.rows || [])
            const articleCalls = []
            const cliCalls = []
            const runCli = async (x) => {
                cliCalls.push(x.args[0])
                vt.advance(o.cliConsumeMs ?? 1000)
                const opts = JSON.parse(fs.readFileSync(x.args[1], 'utf8'))
                return { status: 'success', content: LONG('瀏覽器取得之正文'), title: 'B', method: 'playwright-headless', envBroken: [], steps: [{ step: opts.steps[0], ok: true }] }
            }
            const article = {
                id: 'article',
                retries: 0,
                retryDelayMs: 0,
                ...(o.articleOpt || {}),
                fetch: async (d) => {
                    articleCalls.push(d.id)
                    vt.advance(o.consumeMs ?? 0)
                    return o.outcomes?.[d.id] || { ok: true, text: LONG('正常正文') }
                }
            }
            const browser = createBrowserFetcher({ runCli })
            const registry = o.registry || { resolve: (role, d) => (d.fetcher === 'browser' ? browser : article), label: () => 'x' }
            const seen = { idOf: () => 'zz-unknown' }
            const settings = resolveSettings({ capture: deepMerge(CAP, o.cap) })
            const log = recLog()
            const deps = { stores: { docs }, registry, seen, settings, clock: { iso8: () => NOW }, dirs: { tmp: TMP }, ...(o.reserveMs !== undefined ? { reserveMs: o.reserveMs } : {}) }
            const ctx = { deps, log, ...vt.bits }
            return { vt, docs, articleCalls, cliCalls, log, settings, ctx, run: () => stageDetailFetch({ runCli, ...(o.stageOpt || {}) }).run(ctx) }
        }
        const stillNew = async (e) => (await e.docs.select({ status: 'new' })).length

        it('補全文佇列開工前:可用 20 秒 < 一次作業估計(capture.articles.timeoutMs 30 秒) → 0 次抓取、文件仍為 new 且 fetchTries 不動、reserveDeferred＝留下輪篇數', async () => {
            const e = env({ rows: [doc('a'), doc('bb'), doc('ccc')], totalMs: 10 * MIN, reserveMs: 10 * MIN - 20 * SEC, consumeMs: 10 * SEC })
            const r = await e.run()
            assert.deepEqual(e.articleCalls, [])
            assert.equal(await stillNew(e), 3)
            assert.deepEqual((await e.docs.select()).map((d) => d.fetchTries), [0, 0, 0], '不記次')
            assert.deepEqual([r.detail.filled, r.detail.left, r.detail.reserveDeferred], [0, 3, 3])
            assert.ok(e.log.lines.some((l) => /^INFO .*保留/.test(l)), `須有說明因保留而延後之 INFO 日誌:${e.log.lines.join(' | ')}`)
            assert.equal(e.log.lines.some((l) => l.includes('逾時間預算')), false)
        })

        it('補全文佇列每次取件前判:做完第 1 篇(耗 40 秒)後可用 20 秒 < 30 秒 → 第 2、3 篇不開工、留 new', async () => {
            const e = env({ rows: [doc('a'), doc('bb'), doc('ccc')], totalMs: 10 * MIN, reserveMs: 10 * MIN - 60 * SEC, consumeMs: 40 * SEC })
            const r = await e.run()
            assert.deepEqual(e.articleCalls, ['a'])
            assert.equal(await stillNew(e), 2)
            assert.deepEqual([r.detail.filled, r.detail.left, r.detail.reserveDeferred], [1, 2, 2])
        })

        it('估計取各待抓文件所解析之抓取器之最壞耗時(抓取器自宣告逾時優先於 capture.articles.timeoutMs,含重試):逾時 90 秒 → 可用 89.999 秒不開、90 秒開;逾時 30 秒＋retries 1＋等待 2 秒 → 62 秒', async () => {
            const own = { timeoutMs: 90 * SEC }
            const at = env({ rows: [doc('a')], totalMs: 10 * MIN, reserveMs: 10 * MIN - 90 * SEC, articleOpt: own })
            await at.run()
            assert.deepEqual(at.articleCalls, ['a'], '可用恰等於 90 秒 → 開工')
            const lt = env({ rows: [doc('a')], totalMs: 10 * MIN, reserveMs: 10 * MIN - 90 * SEC + 1, articleOpt: own })
            const r = await lt.run()
            assert.deepEqual([lt.articleCalls, r.detail.reserveDeferred], [[], 1], '少 1 毫秒 → 不開(取抓取器之 90 秒,不取設定之 30 秒)')
            const rt = { timeoutMs: 30 * SEC, retries: 1, retryDelayMs: 2 * SEC }
            const a2 = env({ rows: [doc('a')], totalMs: 10 * MIN, reserveMs: 10 * MIN - 62 * SEC, articleOpt: rt })
            await a2.run()
            assert.equal(a2.articleCalls.length, 1)
            const l2 = env({ rows: [doc('a')], totalMs: 10 * MIN, reserveMs: 10 * MIN - 62 * SEC + 1, articleOpt: rt })
            assert.equal((await l2.run()).detail.reserveDeferred, 1)
            // 抓取器只宣告重試而無自宣告逾時:取設定逾時 30 秒 × 2 次嘗試 ＋ 等待 1 秒 ＝ 61 秒
            const ro = { retries: 1, retryDelayMs: SEC }
            const a3 = env({ rows: [doc('a')], totalMs: 10 * MIN, reserveMs: 10 * MIN - 61 * SEC, articleOpt: ro })
            await a3.run()
            assert.equal(a3.articleCalls.length, 1)
            const l3 = env({ rows: [doc('a')], totalMs: 10 * MIN, reserveMs: 10 * MIN - 61 * SEC + 1, articleOpt: ro })
            assert.equal((await l3.run()).detail.reserveDeferred, 1, '無自宣告逾時者以設定逾時計,仍乘嘗試次數')
            // 抓取器解析不到者(逐篇鏈會拋而記鏈異常):不影響估計,仍以設定逾時(30 秒)為下限——可用 20 秒 < 30 秒 → 不開工(不落鏈異常)
            const bad = {
                resolve: () => {
                    throw new Error('無可用內文抓取器')
                },
                label: () => 'x',
            }
            const u = env({ rows: [doc('a')], totalMs: 10 * MIN, reserveMs: 10 * MIN - 20 * SEC, registry: bad })
            const ru = await u.run()
            assert.deepEqual([ru.detail.reserveDeferred, (await u.docs.get('a')).fetchChainFails], [1, undefined], '未開工:不記鏈異常')
            // 保留未給:不解析抓取器、行為同現版(可用不足 90 秒亦照抓)
            const off = env({ rows: [doc('a')], totalMs: 60 * SEC, articleOpt: own })
            await off.run()
            assert.equal(off.articleCalls.length, 1)
        })

        it('自訂取件 opt.pick:保留 > 0 且可用已不足一次抓取 → 略過 pick(不白耗 AI 額度與時間)、文件留 new、日誌寫明;可用足夠 → 照常呼叫並取其回傳;保留未給 → 照常呼叫', async () => {
            const rows = [doc('a'), doc('bb'), doc('ccc')]
            let picks = 0
            const pick = (cands) => {
                picks++
                return [cands[cands.length - 1]]
            }
            const cut = env({ rows, totalMs: 10 * MIN, reserveMs: 10 * MIN - 20 * SEC, stageOpt: { pick } })
            const r = await cut.run()
            assert.deepEqual([picks, cut.articleCalls, await stillNew(cut), r.detail.reserveDeferred], [0, [], 3, 3])
            assert.ok(cut.log.lines.some((l) => /^INFO .*保留.*略過自訂取件/.test(l)), cut.log.lines.join(' | '))
            const okRun = env({ rows, totalMs: 10 * MIN, reserveMs: 5 * MIN, stageOpt: { pick } })
            await okRun.run()
            assert.deepEqual([picks, okRun.articleCalls], [1, ['ccc']], '可用足夠:呼叫 pick,只抓其回傳者')
            const off = env({ rows, totalMs: 10 * MIN, stageOpt: { pick } })
            await off.run()
            assert.deepEqual([picks, off.articleCalls], [2, ['ccc']], '保留未給:同現版')
        })

        it('保留未給:行為與現版相同——三篇全抓、無 reserveDeferred 欄;整輪逾期才停且不標延後', async () => {
            const e = env({ rows: [doc('a'), doc('bb'), doc('ccc')], totalMs: 10 * MIN, consumeMs: 40 * SEC })
            const r = await e.run()
            assert.deepEqual([e.articleCalls.length, r.detail.filled, r.detail.left, hasDeferKey(r)], [3, 3, 0, false])
            const x = env({ rows: [doc('a'), doc('bb'), doc('ccc')], totalMs: 90 * SEC, reserveMs: undefined, consumeMs: 40 * SEC })
            const rx = await x.run()
            assert.deepEqual([x.articleCalls.length, rx.detail.left, hasDeferKey(rx)], [3, 0, false], '耗 40 秒 × 3 ＝ 120 秒,第 3 篇開工時剩 10 秒仍未逾期(現版只守逾期)')
            const y = env({ rows: [doc('a'), doc('bb'), doc('ccc')], totalMs: 60 * SEC, consumeMs: 40 * SEC })
            const ry = await y.run()
            assert.deepEqual([y.articleCalls.length, ry.detail.left, hasDeferKey(ry)], [2, 1, false], '第 2 篇後耗盡 → 第 3 篇不取;逾期,非保留')
            assert.ok(y.log.lines.some((l) => l.startsWith('WARN') && l.includes('逾時間預算')))
        })

        it('邊界:可用恰等於一次作業(30 秒) → 開工;少 1 毫秒 → 不開工', async () => {
            const at = env({ rows: [doc('a')], totalMs: 10 * MIN, reserveMs: 10 * MIN - 30 * SEC })
            await at.run()
            assert.deepEqual(at.articleCalls, ['a'])
            const lt = env({ rows: [doc('a')], totalMs: 10 * MIN, reserveMs: 10 * MIN - 30 * SEC + 1 })
            const r = await lt.run()
            assert.deepEqual([lt.articleCalls, r.detail.reserveDeferred], [[], 1])
        })

        it('整輪已逾期:不誤報為因保留而延後;沒有待抓者:不誤報;做完最後一篇後才不足:不誤報', async () => {
            const exp = env({ rows: [doc('a'), doc('bb')], totalMs: 0, reserveMs: 5 * MIN })
            const r = await exp.run()
            assert.deepEqual([exp.articleCalls.length, r.detail.left, hasDeferKey(r)], [0, 2, false])
            const none = env({ rows: [], totalMs: 10 * MIN, reserveMs: 10 * MIN - 1 })
            assert.equal(hasDeferKey(await none.run()), false)
            const last = env({ rows: [doc('a')], totalMs: 10 * MIN, reserveMs: 10 * MIN - 60 * SEC, consumeMs: 40 * SEC })
            const rl = await last.run()
            assert.deepEqual([last.articleCalls, rl.detail.left, hasDeferKey(rl)], [['a'], 0, false])
        })

        it('瀏覽器佇列:開工須「整輪剩餘 − 保留 ≥ 最長階梯逾時＋60 秒」;保留使可用差 1 毫秒 → 一篇都不開(留佇列、不記次);保留恰足 → 開;做完第 1 篇後不足 → 第 2 篇留佇列', async () => {
            const probe = env({ rows: [] })
            const worst = ladderTimeoutMs(['curl', 'camofox', 'playwright'], probe.settings.capture) + 60 * SEC
            const rows = [doc('a', { fetcher: 'browser' }), doc('bb', { fetcher: 'browser' })]
            const total = worst + 10 * MIN
            // 保留使可用 = worst − 1 → 不開
            const lt = env({ rows, totalMs: total, reserveMs: 10 * MIN + 1 })
            const r = await lt.run()
            assert.deepEqual(lt.cliCalls, [])
            assert.deepEqual((await lt.docs.select()).map((d) => [d.status, d.fetchTries]), [['new', 0], ['new', 0]])
            assert.equal(r.detail.reserveDeferred, 2)
            // 保留恰使可用 = worst → 開第 1 篇;耗 1 秒後可用 = worst − 1 秒 → 第 2 篇不開
            const at = env({ rows, totalMs: total, reserveMs: 10 * MIN, cliConsumeMs: 1000 })
            const r2 = await at.run()
            assert.equal(at.cliCalls.length, 1)
            assert.equal(r2.detail.reserveDeferred, 1)
            assert.equal((await at.docs.select({ status: 'new' })).length, 1, '第 2 篇仍為 new')
            // 保留未給:兩篇皆開(現版只比整輪剩餘),無 reserveDeferred
            const off = env({ rows, totalMs: total, cliConsumeMs: 1000 })
            const r3 = await off.run()
            assert.deepEqual([off.cliCalls.length, hasDeferKey(r3)], [2, false])
        })

        it('瀏覽器佇列:整輪剩餘本身即不足(未扣保留已 < 階梯門檻)而停者,不歸因於保留(與無保留時同停)', async () => {
            const probe = env({ rows: [] })
            const worst = ladderTimeoutMs(['curl', 'camofox', 'playwright'], probe.settings.capture) + 60 * SEC
            const rows = [doc('a', { fetcher: 'browser' }), doc('bb', { fetcher: 'browser' })]
            const e = env({ rows, totalMs: worst - 1, reserveMs: 1000 })
            const r = await e.run()
            assert.deepEqual(e.cliCalls, [])
            assert.equal((await e.docs.select({ status: 'new' })).length, 2)
            assert.equal(hasDeferKey(r), false, '整輪剩餘本身不足門檻:一般截止,非因保留')
            const off = env({ rows, totalMs: worst - 1 })
            assert.deepEqual([(await off.run()).detail.browserTried, off.cliCalls.length], [0, 0], '無保留時同樣不開(現版行為)')
        })

        it('同輪瀏覽器升級(空殼頁 → 瀏覽器救回)亦扣保留:可用恰等於階梯門檻 → 同輪救回;少 1 毫秒 → 延後(fetcher 標 browser、不記 tries、不開子行程);保留未給 → 同輪救回', async () => {
            const probe = env({ rows: [] })
            const need = ladderTimeoutMs(['playwright', 'camofox'], probe.settings.capture) + 60 * SEC
            const rows = [doc('js')]
            const outcomes = { js: { ok: true, text: 'Loading…', title: 'x' } }
            const at = env({ rows, outcomes, totalMs: need + 5 * MIN, reserveMs: 5 * MIN })
            const r = await at.run()
            assert.equal(at.cliCalls.length, 1, '可用恰等於門檻 → 同輪升級')
            assert.equal((await at.docs.get('js')).status, 'raw')
            assert.equal(hasDeferKey(r), false)
            const lt = env({ rows, outcomes, totalMs: need + 5 * MIN, reserveMs: 5 * MIN + 1 })
            const r2 = await lt.run()
            assert.equal(lt.cliCalls.length, 0, '少 1 毫秒 → 不開子行程(吃進保留)')
            const d = await lt.docs.get('js')
            assert.deepEqual([d.status, d.fetcher, d.fetchTries], ['new', 'browser', 0], '延後:標 browser、不記 tries,下輪由瀏覽器佇列接手')
            assert.equal(r2.detail.browserDeferred, 1)
            const off = env({ rows, outcomes, totalMs: need + 5 * MIN })
            await off.run()
            assert.equal(off.cliCalls.length, 1, '保留未給 → 同現版同輪升級')
        })

        it('逐篇逾時 timeoutMsOf 收到之 remainingMs 為「扣保留後」之剩餘(保留未給時為整輪剩餘)', async () => {
            const seen = []
            const e = env({
                rows: [doc('a')],
                totalMs: 10 * MIN,
                reserveMs: 4 * MIN,
                stageOpt: {
                    timeoutMsOf: (d, x) => {
                        seen.push(x.remainingMs); return 0
                    }
                }
            })
            await e.run()
            assert.equal(seen.length, 1)
            assert.equal(seen[0], 6 * MIN, '10 分 − 保留 4 分')
            const f = env({
                rows: [doc('a')],
                totalMs: 10 * MIN,
                stageOpt: {
                    timeoutMsOf: (d, x) => {
                        seen.push(x.remainingMs); return 0
                    }
                }
            })
            await f.run()
            assert.equal(seen[1], 10 * MIN)
        })

        it('reserveMs 不合法:opt 建構即拋;deps 不合法於該輪開工時拋(不先動任何文件)', async () => {
            assert.throws(() => stageDetailFetch({ reserveMs: -1 }), /reserveMs/)
            const e = env({ rows: [doc('a')], totalMs: 10 * MIN, reserveMs: 'x' })
            await assert.rejects(e.run(), /deps\.reserveMs/)
            assert.deepEqual(e.articleCalls, [])
        })
    })

    // ══════════════════════════ expand ══════════════════════════
    describe('expand(線索擴充)', function() {
        /**
         * 環境:n 條待探索線索;替身探測器每次把虛擬時鐘推進 consumeMs;一次作業估計＝一條線索之探測最壞耗時:
         *   keyword／topic＝2 個端點 × 一次請求(2 次嘗試 × 12 秒 ＋ 3 秒退避＝27 秒)＝54 秒;site＝首頁＋8 個候選 feed ＝ 9 × 27 ＝ 243 秒
         *
         * @param {Object} o 輸入 { n, type('keyword' 預設／'site'), totalMs, reserveMs(deps), consumeMs, stageOpt }
         * @returns {Object} 回傳 { vt, frontier, probed, run, log, ctx }
         */
        function env(o = {}) {
            const vt = vclock(o.totalMs ?? Infinity)
            const rows = Array.from({ length: o.n ?? 5 }, (_, i) => ({ id: `c${i + 1}`, type: o.types ? o.types[i] : (o.type || 'keyword'), value: `黑洞光譜${i + 1}`, status: 'pending', tries: 0, hits: 10 - i }))
            const frontier = memStore(rows)
            const probed = []
            const fakeProbe = defineMw({
                name: 'fakeProbe',
                handle: async (msg, ctx, next) => {
                    probed.push(msg.data.id)
                    vt.advance(o.consumeMs ?? 0)
                    msg.data._outcome = { ok: true, resolved: `search:${msg.data.value}`, yieldDocs: 0, newSources: 0 }
                    return next(msg)
                },
            })
            const log = recLog()
            const deps = { stores: { frontier }, settings: S({ expand: { perRun: 10 } }), clock: { iso8: () => NOW }, ...(o.reserveMs !== undefined ? { reserveMs: o.reserveMs } : {}) }
            const ctx = { deps, log, ...vt.bits }
            return { vt, frontier, probed, log, ctx, run: () => stageExpand({ tap: { probe: { replace: fakeProbe } }, ...(o.stageOpt || {}) }).run(ctx) }
        }
        const pendingN = async (e) => (await e.frontier.select({ status: 'pending' })).length

        it('開工前:可用 20 秒 < 一條線索之估計(keyword 54 秒) → 不探測、線索仍 pending、reserveDeferred＝留下輪線索數、日誌寫明', async () => {
            const e = env({ n: 5, totalMs: 10 * MIN, reserveMs: 10 * MIN - 20 * SEC, consumeMs: 5 * SEC })
            const r = await e.run()
            assert.deepEqual(e.probed, [])
            assert.equal(await pendingN(e), 5)
            assert.deepEqual([r.detail.picked, r.detail.left, r.detail.reserveDeferred], [0, 5, 5])
            assert.ok(e.log.lines.some((l) => /^INFO .*保留/.test(l)), e.log.lines.join(' | '))
            assert.equal(e.log.lines.some((l) => l.includes('逾時間預算')), false)
        })

        it('每次取件前判:可用 60 秒 ≥ 54 秒 → 開工;做完第 1 條(耗 40 秒)後可用 20 秒 < 54 秒 → 其餘 4 條留 pending', async () => {
            const e = env({ n: 5, totalMs: 10 * MIN, reserveMs: 10 * MIN - 60 * SEC, consumeMs: 40 * SEC })
            const r = await e.run()
            assert.equal(e.probed.length, 1)
            assert.equal(await pendingN(e), 4, '已探測者轉 done,其餘仍 pending')
            assert.deepEqual([r.detail.picked, r.detail.left, r.detail.reserveDeferred], [1, 4, 4])
        })

        it('保留未給:行為與現版相同——全部探測、無 reserveDeferred 欄;整輪逾期才停且不標延後', async () => {
            const e = env({ n: 5, totalMs: 10 * MIN, consumeMs: 40 * SEC })
            const r = await e.run()
            assert.deepEqual([e.probed.length, r.detail.left, hasDeferKey(r)], [5, 0, false])
            const x = env({ n: 5, totalMs: 100 * SEC, consumeMs: 40 * SEC })
            const rx = await x.run()
            assert.deepEqual([x.probed.length, rx.detail.left, hasDeferKey(rx)], [3, 2, false])
        })

        it('估計依線索型別:site 線索(首頁＋至多 8 個候選 feed,各一次請求 27 秒)＝243 秒;同輪混有 site 與 keyword 者取最大者', async () => {
            const at = env({ n: 1, type: 'site', totalMs: 20 * MIN, reserveMs: 20 * MIN - 243 * SEC })
            await at.run()
            assert.equal(at.probed.length, 1, '可用恰等於 243 秒 → 開工')
            const lt = env({ n: 1, type: 'site', totalMs: 20 * MIN, reserveMs: 20 * MIN - 243 * SEC + 1 })
            const r = await lt.run()
            assert.deepEqual([lt.probed.length, r.detail.reserveDeferred], [0, 1], '少 1 毫秒 → 不開工')
            // keyword 線索同樣之可用(243 秒)遠超 54 秒 → 開工
            const kw = env({ n: 1, type: 'keyword', totalMs: 20 * MIN, reserveMs: 20 * MIN - 243 * SEC + 1 })
            await kw.run()
            assert.equal(kw.probed.length, 1)
            // 混合:keyword 排前、site 排後,可用差 1 毫秒不及 site 之 243 秒 → 估計取最大者,連排前之 keyword 亦不開(兩條皆留 pending)
            const mix = env({ n: 2, types: ['keyword', 'site'], totalMs: 20 * MIN, reserveMs: 20 * MIN - 243 * SEC + 1 })
            const rm = await mix.run()
            assert.deepEqual([mix.probed.length, rm.detail.reserveDeferred, await pendingN(mix)], [0, 2, 2])
        })

        it('邊界:可用恰等於 54 秒 → 開工;少 1 毫秒 → 不開;整輪已逾期與無待探索者皆不誤報', async () => {
            const at = env({ n: 1, totalMs: 10 * MIN, reserveMs: 10 * MIN - 54 * SEC })
            await at.run()
            assert.equal(at.probed.length, 1)
            const lt = env({ n: 1, totalMs: 10 * MIN, reserveMs: 10 * MIN - 54 * SEC + 1 })
            const r = await lt.run()
            assert.deepEqual([lt.probed.length, r.detail.reserveDeferred], [0, 1])
            const exp = env({ n: 2, totalMs: 0, reserveMs: 5 * MIN })
            assert.equal(hasDeferKey(await exp.run()), false)
            const none = env({ n: 0, totalMs: 10 * MIN, reserveMs: 10 * MIN - 1 })
            assert.equal(hasDeferKey(await none.run()), false)
        })

        it('reserveMs 不合法:opt 建構即拋;deps 不合法於該輪開工時拋', async () => {
            assert.throws(() => stageExpand({ reserveMs: -1 }), /reserveMs/)
            const e = env({ n: 2, totalMs: 10 * MIN, reserveMs: NaN })
            await assert.rejects(e.run(), /deps\.reserveMs/)
            assert.deepEqual(e.probed, [])
        })
    })

    // ══════════════════════════ docMaintain ══════════════════════════
    describe('docMaintain(文件維護:本機逐項作業,一次作業估計 1 秒)', function() {
        const TEXT = '黑洞光譜的觀測記錄包含吸積盤與噴流的詳細描述。'.repeat(4)
        /**
         * 環境:每次寫入(patch)把虛擬時鐘推進 consumeMs
         *
         * @param {Object} o 輸入 { rows, totalMs, reserveMs(deps), consumeMs, stageOpt }
         * @returns {Object} 回傳 { vt, docs, run, log, ctx, patched }
         */
        function env(o = {}) {
            const vt = vclock(o.totalMs ?? Infinity)
            const docs = memStore(o.rows || [])
            const patched = []
            const rawPatch = docs.patch.bind(docs)
            docs.patch = async (id, p) => {
                patched.push(id)
                vt.advance(o.consumeMs ?? 0)
                return rawPatch(id, p)
            }
            const log = recLog()
            const deps = { stores: { docs }, settings: resolveSettings({}), clock: { iso8: () => NOW }, ...(o.reserveMs !== undefined ? { reserveMs: o.reserveMs } : {}) }
            const ctx = { deps, log, ...vt.bits }
            return { vt, docs, patched, log, ctx, run: () => stageDocMaintain({ terminalStatuses: [], ...(o.stageOpt || {}) }).run(ctx) }
        }
        const noted = (n) => Array.from({ length: n }, (_, i) => ({ id: `n${i + 1}`, status: 'noted', text: TEXT, notedAt: `2026-09-0${i + 1}` }))
        const raws = (n) => Array.from({ length: n }, (_, i) => ({ id: `r${i + 1}`, status: 'raw', healthV: 'old', textFrom: 'article', text: LONG('舊閘版之正文'), fullLength: LONG('舊閘版之正文').length, title: '黑洞光譜', rawAt: `2026-08-0${i + 1}` }))

        it('段落雜湊補算:可用 0.5 秒 < 1 秒 → 不補;可用 3 秒、每件耗 1 秒 → 補 3 件(第 3 件開工時可用恰 1 秒)後停,其餘 2 件留待下輪;reserveDeferred＝2', async () => {
            const a = env({ rows: noted(5), totalMs: 10 * SEC, reserveMs: 10 * SEC - 500, consumeMs: 1000 })
            const ra = await a.run()
            assert.deepEqual(a.patched, [])
            assert.deepEqual([ra.detail.paraKeys.filled, ra.detail.paraKeys.left, ra.detail.reserveDeferred], [0, 5, 5])
            const b = env({ rows: noted(5), totalMs: 10 * SEC, reserveMs: 7 * SEC, consumeMs: 1000 })
            const rb = await b.run()
            assert.deepEqual([rb.detail.paraKeys.filled, rb.detail.paraKeys.left, rb.detail.reserveDeferred], [3, 2, 2])
            assert.equal((await b.docs.select()).filter((d) => !Array.isArray(d.paraKeys)).length, 2, '未補者原樣(無 paraKeys)')
            assert.ok(b.log.lines.some((l) => /^INFO .*保留/.test(l)), b.log.lines.join(' | '))
        })

        it('健全閘存量重判:同判準——可用不足 1 秒不重判;每件耗 1 秒、可用 3 秒 → 重判 3 件、其餘留下輪;reserveDeferred 計入', async () => {
            const a = env({ rows: raws(5), totalMs: 10 * SEC, reserveMs: 10 * SEC - 500, consumeMs: 1000 })
            const ra = await a.run()
            assert.deepEqual([a.patched, ra.detail.health.left, ra.detail.reserveDeferred], [[], 5, 5])
            const b = env({ rows: raws(5), totalMs: 10 * SEC, reserveMs: 7 * SEC, consumeMs: 1000 })
            const rb = await b.run()
            assert.deepEqual([rb.detail.health.passed, rb.detail.health.left, rb.detail.reserveDeferred], [3, 2, 2])
        })

        it('內容類 dead 依版重判(第二個迴圈):同判準——可用 3 秒、每件耗 1 秒 → 重判 3 件(回待抓)、其餘 2 件留下輪、reserveDeferred＝2;健全閘重判已先耗盡時,此迴圈之件全數留下輪', async () => {
            const deads = (n) => Array.from({ length: n }, (_, i) => ({ id: `x${i + 1}`, status: 'dead', deadClass: 'paywall', healthV: 'old', text: LONG('另存之判定依據'), fullLength: LONG('另存之判定依據').length, title: '黑洞光譜', deadAt: `2026-08-0${i + 1}` }))
            const a = env({ rows: deads(5), totalMs: 10 * SEC, reserveMs: 7 * SEC, consumeMs: 1000 })
            const ra = await a.run()
            assert.deepEqual([ra.detail.health.dead.revived, ra.detail.health.left, ra.detail.reserveDeferred], [3, 2, 2])
            // 先有 raw 重判(3 件耗盡可用) → 其後之 dead 重判 2 件全數留下輪:兩個迴圈之留下輪皆計入 reserveDeferred(raw 剩 0、dead 2)
            const mixed = [...raws(3), ...deads(2)]
            const b = env({ rows: mixed, totalMs: 10 * SEC, reserveMs: 7 * SEC, consumeMs: 1000 })
            const rb = await b.run()
            assert.deepEqual([rb.detail.health.passed, rb.detail.health.dead.revived, rb.detail.health.left, rb.detail.reserveDeferred], [3, 0, 2, 2])
        })

        it('reserveDeferred 只計本輪名額(每輪上限 per)內因保留而未做者:超出 per 者縱無保留亦本輪不做,不計入(left 仍為全部未處理數)', async () => {
            // 6 件待補、名額 4;可用 2 秒、每件耗 1 秒 → 做 2 件後停:left＝4,名額內未做＝2
            const a = env({ rows: noted(6), totalMs: 10 * SEC, reserveMs: 8 * SEC, consumeMs: 1000, stageOpt: { paraKeysPerRun: 4 } })
            const ra = await a.run()
            assert.deepEqual([ra.detail.paraKeys.filled, ra.detail.paraKeys.left, ra.detail.reserveDeferred], [2, 4, 2])
            const b = env({ rows: raws(6), totalMs: 10 * SEC, reserveMs: 8 * SEC, consumeMs: 1000, stageOpt: { healthRecheckPerRun: 4 } })
            const rb = await b.run()
            assert.deepEqual([rb.detail.health.passed, rb.detail.health.left, rb.detail.reserveDeferred], [2, 4, 2])
            // 內容類 dead 重判之迴圈同:5 件、名額 3;可用 2 秒、每件耗 1 秒 → 回待抓 2 件後停,left＝3,名額內未做＝1
            const deads = Array.from({ length: 5 }, (_, i) => ({ id: `x${i + 1}`, status: 'dead', deadClass: 'paywall', healthV: 'old', text: LONG('另存之判定依據'), fullLength: LONG('另存之判定依據').length, title: '黑洞光譜', deadAt: `2026-08-0${i + 1}` }))
            const c = env({ rows: deads, totalMs: 10 * SEC, reserveMs: 8 * SEC, consumeMs: 1000, stageOpt: { healthRecheckPerRun: 3 } })
            const rc = await c.run()
            assert.deepEqual([rc.detail.health.dead.revived, rc.detail.health.left, rc.detail.reserveDeferred], [2, 3, 1])
        })

        it('保留未給:行為與現版相同——全部處理、無 reserveDeferred 欄;整輪逾期才停且不標延後', async () => {
            const a = env({ rows: noted(5), totalMs: 10 * SEC, consumeMs: 1000 })
            const ra = await a.run()
            assert.deepEqual([ra.detail.paraKeys.filled, ra.detail.paraKeys.left, hasDeferKey(ra)], [5, 0, false])
            const b = env({ rows: noted(5), totalMs: 3 * SEC, consumeMs: 1000 })
            const rb = await b.run()
            assert.deepEqual([rb.detail.paraKeys.filled, rb.detail.paraKeys.left, hasDeferKey(rb)], [3, 2, false])
        })

        it('邊界與誤報:可用恰等於 1 秒 → 做;少 1 毫秒 → 不做;整輪已逾期不誤報;無待處理者不誤報', async () => {
            const at = env({ rows: noted(1), totalMs: 10 * SEC, reserveMs: 9 * SEC, consumeMs: 0 })
            assert.equal((await at.run()).detail.paraKeys.filled, 1)
            const lt = env({ rows: noted(1), totalMs: 10 * SEC, reserveMs: 9 * SEC + 1, consumeMs: 0 })
            const r = await lt.run()
            assert.deepEqual([r.detail.paraKeys.filled, r.detail.reserveDeferred], [0, 1])
            const exp = env({ rows: noted(2), totalMs: 0, reserveMs: 5 * SEC })
            assert.equal(hasDeferKey(await exp.run()), false)
            const none = env({ rows: [], totalMs: 10 * SEC, reserveMs: 10 * SEC - 1 })
            assert.equal(hasDeferKey(await none.run()), false)
        })

        it('reserveMs 不合法:opt 建構即拋;deps 不合法於該輪開工時拋(不先動任何文件;不被逐項隔離吞成失敗計數)', async () => {
            assert.throws(() => stageDocMaintain({ reserveMs: -1 }), /reserveMs/)
            const e = env({ rows: noted(2), totalMs: 10 * SEC, reserveMs: 'x' })
            await assert.rejects(e.run(), /deps\.reserveMs/)
            assert.deepEqual(e.patched, [])
        })
    })

    // ══════════════════════════ areas ══════════════════════════
    describe('areas(領域發現:既有 25 分鐘下限不動,另扣保留)', function() {
        /**
         * 環境(同領域發現之既有測試之形狀):AI 與 OpenAlex 皆替身;席位首家逾時 2 分(一次呼叫之估計)
         *
         * @param {Object} o 輸入 { remainingMs(整輪剩餘), reserveMs(deps), stageOpt, seat }
         * @returns {Object} 回傳 { st, deps, calls, areas, log, ctx }
         */
        function env(o = {}) {
            const day = (d) => new Date(NOW_MS - d * 86400_000).toISOString()
            // twoConcepts:另備第二個主概念(25 篇),使候選有 2 個(驗證迴圈之測試用)
            const nConcept = o.twoConcepts ? 2 : 1
            const notes = memStore(Array.from({ length: 25 * nConcept }, (_, i) => ({ id: `n${i}`, title: `T${i}`, concepts: [i < 25 ? '市場情緒' : '動量因子'], createdAt: day(3), docId: `d${i}` })))
            const docs = memStore([...Array.from({ length: 25 * nConcept }, (_, i) => ({ id: `d${i}`, status: 'noted', sourceId: 'rss1' })), { id: 'known', status: 'noted' }])
            const areas = memStore([])
            const sources = memStore([])
            const frontier = memStore([])
            const cap = {
                services: { openAlex: { base: 'http://oa.test' } },
                areas: { openAlexFields: '', maxActive: 60, minFreshRate: 0.2 },
                discover: { everyHours: 24, windowDays: 30, minSupport: 20, minClueDocs: 3, candidatesPerCall: 8, minHits: 200, newPerDay: 2, rejectCooldownDays: 30, ai: o.seat || { use: 'x:a', fallback: [], timeoutMs: 2 * MIN } },
                sources: { itemsPerSource: 8, lowYieldRate: 0.1, cullMinJudged: 6 },
            }
            const results = Array.from({ length: 8 }, (_, i) => ({ doi: `https://doi.org/10.9/${i}`, abstract_inverted_index: Object.fromEntries(Array.from({ length: 30 }, (_, k) => [`w${k}`, [k]])) }))
            const calls = { ai: 0, opts: null }
            const deps = {
                stores: { notes, docs, areas, sources, frontier },
                settings: resolveSettings({ capture: cap }),
                clock: { iso8: () => NOW },
                dirs: { knowledge: TMP },
                seen: { idOf: (u) => (u.endsWith('/0') ? 'known' : `id:${u}`) },
                data: { vocab: null },
                ...(o.reserveMs !== undefined ? { reserveMs: o.reserveMs } : {}),
            }
            const st = stageAreas({
                now: () => NOW_MS,
                callAI: async (p, check, x) => {
                    calls.ai++
                    calls.opts = x
                    o.vt?.advance(o.aiMs ?? 0)
                    const data = [
                        { index: 1, covered: false, label: '市場情緒與報酬', query: 'investor sentiment stock returns', why: '主概念高支持且未涵蓋' },
                        ...(o.twoConcepts ? [{ index: 2, covered: false, label: '動量因子', query: 'momentum factor stock returns', why: '主概念高支持且未涵蓋' }] : []),
                    ]
                    return check(data) ? { ok: true, data } : { ok: false, error: 'check failed' }
                },
                fetchWebByCurl: async () => ({ status: 'success', html: JSON.stringify({ meta: { count: 1200 }, results }) }),
                ...(o.stageOpt || {}),
            })
            const log = recLog()
            const ctx = { deps, log, ...(o.vt ? o.vt.bits : (o.remainingMs !== undefined ? { remainingMs: () => o.remainingMs, expired: () => o.remainingMs <= 0 } : {})) }
            return { st, deps, calls, areas, log, ctx, run: () => st.run(ctx) }
        }

        it('發現開工前:整輪剩餘 30 分(過 25 分下限)、保留 29 分 → 可用 1 分 < 席位首家逾時 2 分 → 不呼叫 AI、不推進發現窗口、skipped 寫明、reserveDeferred:true', async () => {
            const e = env({ remainingMs: 30 * MIN, reserveMs: 29 * MIN })
            const r = await e.run()
            assert.equal(e.calls.ai, 0)
            assert.equal(r.detail.discovered, false)
            assert.equal(r.detail.reserveDeferred, true)
            assert.match(r.detail.skipped, /保留/)
            assert.equal((await e.areas.select()).length, 0, '不寫 _meta(窗口不推進,下輪仍到期)')
            assert.ok(e.log.lines.some((l) => /^INFO .*領域發現略過.*保留/.test(l)), e.log.lines.join(' | '))
        })

        it('邊界:可用恰等於首家逾時(2 分) → 開工;少 1 毫秒 → 不開工', async () => {
            const at = env({ remainingMs: 30 * MIN, reserveMs: 28 * MIN })
            const r = await at.run()
            assert.deepEqual([r.detail.discovered, at.calls.ai], [true, 1])
            const lt = env({ remainingMs: 30 * MIN, reserveMs: 28 * MIN + 1 })
            const r2 = await lt.run()
            assert.deepEqual([r2.detail.discovered, lt.calls.ai, r2.detail.reserveDeferred], [false, 0, true])
        })

        it('AI 呼叫預算以「剩餘 − 保留」再封頂:剩餘 30 分、保留 27 分 → 3 分(原式 min(10, 30−25+5)＝10 分);保留小於界線者不改變原式(剩餘 40 分、保留 5 分 → 仍 10 分)', async () => {
            const e = env({ remainingMs: 30 * MIN, reserveMs: 27 * MIN })
            await e.run()
            assert.equal(e.calls.opts.budgetMs, 3 * MIN)
            const f = env({ remainingMs: 40 * MIN, reserveMs: 5 * MIN })
            await f.run()
            assert.equal(f.calls.opts.budgetMs, 2 * AREA_AI_BUDGET_MS_LOCAL, '40 分、保留 5 分:原式 10 分,可用 35 分,不封')
            assert.equal(typeof f.calls.opts.shouldStop, 'function')
        })

        it('25 分鐘下限不動:整輪剩餘 24 分 → 略過並歸因整輪剩餘時間不足(不論保留多少,不標 reserveDeferred)', async () => {
            const a = env({ remainingMs: 24 * MIN })
            const ra = await a.run()
            assert.deepEqual([ra.detail.skipped, hasDeferKey(ra)], ['整輪剩餘時間不足', false])
            const b = env({ remainingMs: 24 * MIN, reserveMs: 5 * MIN })
            const rb = await b.run()
            assert.deepEqual([rb.detail.skipped, hasDeferKey(rb), b.calls.ai], ['整輪剩餘時間不足', false, 0])
        })

        it('保留未給:行為與現版相同(剩餘 40 分 → 預算 10 分;剩餘 26 分 → 6 分;無 reserveDeferred 欄);整輪無截止(ctx 無 remainingMs)照常發現', async () => {
            const a = env({ remainingMs: 40 * MIN })
            const ra = await a.run()
            assert.deepEqual([a.calls.opts.budgetMs, ra.detail.discovered, hasDeferKey(ra)], [10 * MIN, true, false])
            const b = env({ remainingMs: 26 * MIN })
            await b.run()
            assert.equal(b.calls.opts.budgetMs, 6 * MIN)
            const c = env({})
            const rc = await c.run()
            assert.deepEqual([rc.detail.discovered, hasDeferKey(rc)], [true, false])
            // 無截止 + 有保留:剩餘為無限 → 不延後
            const d = env({ reserveMs: 29 * MIN })
            assert.equal((await d.run()).detail.discovered, true)
        })

        it('保留值之來源:opt.reserveMs 明給者優先(含 0);不合法 → 建構即拋,deps 不合法於該輪開工時拋', async () => {
            const a = env({ remainingMs: 30 * MIN, reserveMs: 29 * MIN, stageOpt: { reserveMs: 0 } })
            assert.equal((await a.run()).detail.discovered, true)
            const b = env({ remainingMs: 30 * MIN, reserveMs: 0, stageOpt: { reserveMs: 29 * MIN } })
            assert.equal((await b.run()).detail.reserveDeferred, true)
            assert.throws(() => stageAreas({ reserveMs: -1 }), /reserveMs/)
            const c = env({ remainingMs: 30 * MIN, reserveMs: 'x' })
            await assert.rejects(c.run(), /deps\.reserveMs/)
            assert.equal(c.calls.ai, 0)
        })

        it('驗證迴圈(AI 判定後逐候選之 OpenAlex 驗證,每候選至多約 35 秒):保留 > 0 時每個候選前判——做完第 1 個後可用不足 → 停止驗證、其餘候選不入帳(不新增、不入已拒)、reserveDeferred:true;保留未給 → 兩個候選皆驗(此迴圈本無時間判斷)', async () => {
            const mk = (reserveMs) => {
                const vt = vclock(30 * MIN)
                const validated = []
                const validate = async (q) => {
                    validated.push(q)
                    vt.advance(100 * SEC)
                    return { ok: true, count: 1200 }
                }
                return { validated, e: env({ vt, twoConcepts: true, aiMs: MIN, ...(reserveMs !== undefined ? { reserveMs } : {}), stageOpt: { validate } }) }
            }
            // 保留 27 分:可用 3 分(≥ 席位首家逾時 2 分 → 開工);AI 耗 1 分 → 可用 2 分;第 1 個驗證前 120 秒 ≥ 35 秒 → 驗,耗 100 秒 → 可用 20 秒 < 35 秒 → 停
            const a = mk(27 * MIN)
            const r = await a.e.run()
            assert.deepEqual(a.validated, ['investor sentiment stock returns'])
            assert.deepEqual([r.detail.discovered, r.detail.proposed, r.detail.added, r.detail.reserveDeferred], [true, 2, 1, true])
            assert.equal(await a.e.areas.get(areaIdOf('momentum factor stock returns')), null, '未驗證之候選不入帳(不新增、不入已拒)')
            assert.ok(a.e.log.lines.some((l) => /^INFO .*領域發現.*保留.*其餘候選/.test(l)), a.e.log.lines.join(' | '))
            // 保留未給:同時間線,兩個候選皆驗、無 reserveDeferred
            const b = mk()
            const rb = await b.e.run()
            assert.deepEqual([b.validated.length, rb.detail.added, hasDeferKey(rb)], [2, 2, false])
            // 整輪於驗證途中逾期:保留未給 → 此迴圈本無時間判斷,兩個候選皆驗(同現版);保留 > 0(1 分,未使可用不足)→ 逾期即停、但不歸因於保留
            const expiring = (reserveMs) => {
                const vt = vclock(26 * MIN)
                const validated = []
                const validate = async (q) => {
                    validated.push(q)
                    vt.advance(30 * MIN)
                    return { ok: true, count: 1200 }
                }
                return { validated, e: env({ vt, twoConcepts: true, aiMs: MIN, ...(reserveMs !== undefined ? { reserveMs } : {}), stageOpt: { validate } }) }
            }
            const c = expiring()
            const rc = await c.e.run()
            assert.deepEqual([c.validated.length, hasDeferKey(rc)], [2, false], '保留未給:逾期後仍驗第 2 個(現版行為不變)')
            const d = expiring(MIN)
            const rd = await d.e.run()
            assert.deepEqual([d.validated.length, hasDeferKey(rd)], [1, false], '保留 > 0:逾期即停,但逾期不是因保留')
        })

        it('一次呼叫估計取發現席位之逾時鏈:席位 timeoutMs → ai.providerTimeouts[席位 use] → ai.timeoutMs(預設 5 分)', async () => {
            // 席位無 timeoutMs、providerTimeouts 給 3 分:可用 2.5 分 → 不開;可用 3 分 → 開
            const mk = (reserveMs) => {
                const e = env({ remainingMs: 30 * MIN, reserveMs, seat: { use: 'x:a', fallback: [] } })
                e.deps.settings = resolveSettings({ capture: e.deps.settings.capture, ai: { providerTimeouts: { 'x:a': 3 * MIN } } })
                return e
            }
            const lt = mk(30 * MIN - 150 * SEC)
            const r = await lt.run()
            assert.deepEqual([lt.calls.ai, r.detail.reserveDeferred], [0, true])
            const at = mk(30 * MIN - 3 * MIN)
            assert.equal((await at.run()).detail.discovered, true)
        })
    })
})

/** 領域發現之一次嘗試上限(同 areaStage 之 AREA_AI_BUDGET_MS＝5 分;測試自持一份以斷言「原式不變」) */
const AREA_AI_BUDGET_MS_LOCAL = 5 * MIN
