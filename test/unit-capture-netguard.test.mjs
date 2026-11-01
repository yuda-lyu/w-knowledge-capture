// unit-capture-netguard.test.mjs — 本機網路判斷與「不是對象的問題就不算在對象頭上」(CS3 失敗分流:本機網路不通不計次)
//   netGuard:任一端點連得上即通(不等其餘逾時)、全部不通才不通、開工前快取、計次前強制重探(限頻)、並發共用一次探測
//   開工前不通 → 補全文／輪抓／擴充略過、領域只略過發現;計次前確認不通 → 不計該對象、本段停止
//   AI 調度層:整條遞補鏈皆敗且確認斷網 → skipped(不記 tries)
//   線索:端點全敗而網路通 → 端點故障(不加 tries、退避),同輪連 2 篇停探關鍵詞;領域發現失敗不作廢窗口;failed 線索冷卻重探
// 不發任何外網請求:探測以替身注入;AI 與線索端點指向本機未監聽之固定埠(8830;連線即被拒)。
// 執行:自套件根 node <mocha> --timeout 180000 test/unit-capture-netguard.test.mjs(暫存 test/_tmp/capture-netguard-<pid>,測完即刪)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { memStore } from './tools/memStore.mjs'
import { genClockTZ } from '../src/core/runnerPackage.mjs'
import { createNetGuard, netProbeUrlsOf, probeFailText } from '../src/core/util/netGuard.mjs'
import { createCaptureObject } from '../src/captureObject.mjs'
import { stageDetailFetch } from '../src/stages/detailFetchStage.mjs'
import { stageListFetch } from '../src/stages/listFetchStage.mjs'
import { stageExpand, mwSettleClue, probeSearchEndpoints } from '../src/stages/expandStage.mjs'
import { stageAreas } from '../src/stages/areaStage.mjs'
import { AREA_META_ID } from '../src/stores/areaPolicy.mjs'
import { settleClue, reprobeFailedClues, pickClues } from '../src/core/stores/frontierPolicy.mjs'
import { defineMw } from '../src/core/kernel.mjs'
import { createAiAdapter } from '../src/core/ai/adapter.mjs'
import { settingsOf as S } from './tools/captureTestKit.mjs'
import { recLog } from './tools/testKit.mjs'

const clock = genClockTZ('Asia/Taipei')
const NOW = '2026-10-05T18:00:00+08:00'
const NOW_MS = Date.parse(NOW)
const TMP = path.resolve(`test/_tmp/capture-netguard-${process.pid}`)
/** 本機未監聽之固定埠(≥8000;全套件測試無任何行程監聽;連線即被拒,不發外網請求) */
const DEAD_BASE = 'http://127.0.0.1:8830'
const LONG = (s) => `${s}。本段說明研究設計、樣本期間、交易成本假設與穩健性檢驗之結果。`.repeat(12)
/** netGuard 替身:開工前之判斷與計次前之確認各自指定 */
const guard = ({ up = true, confirm = false } = {}) => {
    let down = !up
    return {
        check: async () => ({ up, at: 1, detail: [] }),
        confirmDown: async () => {
            if (confirm) down = true
            return confirm
        },
        isDown: () => down,
        describe: () => 'api.test：不通（連線失敗）',
        state: () => ({}),
        probes: () => 0,
    }
}

describe('unit-capture-netguard', function() {

    before(() => fs.mkdirSync(TMP, { recursive: true }))
    after(() => fs.rmSync(TMP, { recursive: true, force: true }))

    describe('createNetGuard／netProbeUrlsOf', () => {

        it('任一端點連得上即判通(不等其餘端點);全部不通才判不通;describe 列各端點之狀態', async () => {
            const never = new Promise(() => {})
            const g = createNetGuard({ urls: ['https://a.test', 'https://b.test'], probe: (u) => (u.includes('a.') ? Promise.resolve({ reachable: true, httpCode: 404 }) : never) })
            assert.equal((await g.check()).up, true, '收到 HTTP 狀態(含 404)即通;另一端點掛住也不等')
            const d = createNetGuard({ urls: ['https://a.test', 'https://b.test'], probe: async (u) => ({ reachable: false, message: `${u} 連線失敗` }) })
            assert.equal(await d.confirmDown(), true)
            assert.match(d.describe(), /a\.test：不通（https:\/\/a\.test 連線失敗）；b\.test：不通/)
            assert.equal((await createNetGuard({ urls: [] }).check()).up, true, '未設端點＝不判斷(恆通)')
        })

        it('check 快取 ttlMs;confirmDown 距上次探測逾 confirmMinMs 即強制重探(不沿用「通」之快取)、未逾則用最近結果;並發詢問共用一次探測', async () => {
            let t = 0
            let up = true
            let n = 0
            const g = createNetGuard({ urls: ['https://a.test'], ttlMs: 60_000, confirmMinMs: 15_000, now: () => t, probe: async () => {
                n++
                return { reachable: up }
            } })
            await g.check()
            t = 10_000
            await g.check()
            assert.equal(n, 1, 'ttl 內不重探')
            up = false
            assert.equal(await g.confirmDown(), false, '15 秒內沿用最近結果(限頻)')
            t = 30_000
            assert.equal(await g.confirmDown(), true, '逾 15 秒強制重探 → 剛斷網即被發現(不沿用 60 秒快取之「通」而照樣計次)')
            assert.equal(g.isDown(), true)
            t = 100_000
            await Promise.all([g.check(), g.check(), g.confirmDown()])
            assert.equal(n, 3, '並發共用一次探測')
        })

        it('探測失敗之說明為一行可讀原因:不夾 curl 指令字串與換行(否則 WARN 斷成兩行且看不出原因);真探測器對本機未監聽埠亦然', async () => {
            const curlMsg = 'Command failed: curl -s -L --compressed --max-time 3 --write-out \n%{http_code}\n%{url_effective} http://127.0.0.1:8830\n'
            assert.equal(probeFailText({ status: 'error', reason: 'curl-error', message: curlMsg }), '連線失敗（curl-error）')
            assert.equal(probeFailText({ status: 'error', reason: 'timeout', message: curlMsg }), '逾時（timeout）')
            assert.equal(probeFailText({ status: 'error', httpCode: 407, message: curlMsg }), 'HTTP 407')
            assert.equal(probeFailText({}), '連線失敗')
            const g = createNetGuard({ urls: ['https://a.test'], probe: async () => ({ reachable: false, message: '第一行\n第二行' }) })
            await g.check()
            assert.equal(g.describe(), 'a.test：不通（第一行 第二行）', '替身回多行訊息亦壓成一行')
            const real = createNetGuard({ urls: [DEAD_BASE], timeoutMs: 3000 })
            assert.equal((await real.check()).up, false)
            assert.equal(real.describe(), '127.0.0.1：不通（連線失敗（curl-error））')
        })

        it('netProbeUrlsOf(傳 settings.capture):capture.network.probeUrls 為 null 時預設取 capture.services 三個端點基底之原點(去重;本系統本就使用);明給者照用(去重);[]＝不判斷', () => {
            assert.deepEqual(netProbeUrlsOf({ services: { bingNews: { base: 'https://www.bing.com' }, openAlex: { base: 'https://api.openalex.org/works' }, arxiv: { base: 'https://export.arxiv.org' } } }), ['https://www.bing.com', 'https://api.openalex.org', 'https://export.arxiv.org'])
            assert.deepEqual(netProbeUrlsOf({ network: { probeUrls: ['https://x.test', 'https://x.test'] } }), ['https://x.test'])
            assert.deepEqual(netProbeUrlsOf({ network: { probeUrls: [] }, services: { openAlex: { base: 'https://api.openalex.org' } } }), [])
            assert.deepEqual(netProbeUrlsOf({ network: { probeUrls: null }, services: { openAlex: { base: 'https://a.test/x' }, arxiv: { base: 'https://a.test/y' } } }), ['https://a.test'], '同原點去重')
            assert.deepEqual(netProbeUrlsOf(S().capture), ['https://www.bing.com', 'https://api.openalex.org', 'https://export.arxiv.org'], '預設設定')
            assert.deepEqual(netProbeUrlsOf(S({ network: { probeUrls: ['https://z.test'] } }).capture), ['https://z.test'])
            assert.deepEqual(netProbeUrlsOf({}), [])
            assert.deepEqual(netProbeUrlsOf(undefined), [])
        })
    })

    describe('抓取段摘要契約', () => {
        it('三個網路子階段皆因不通而略過時,抓取段固定格式摘要之數字欄皆為數字(補全文略過之 detail 若缺 aggregated,摘要會印出「轉錄 undefined」)', async () => {
            const deps = { stores: { docs: memStore([]), sources: memStore([]), frontier: memStore([]) }, registry: { resolve: () => null, label: () => 'x' }, settings: S({ articles: { perRun: 1 }, browser: { perRun: 0 } }), clock, dirs: { tmp: TMP }, netGuard: guard({ up: false }) }
            const log = recLog()
            const reps = {}
            for (const st of [stageListFetch({}), stageDetailFetch({}), stageExpand({})]) reps[st.name] = await st.run({ deps, log })
            for (const [k, r] of Object.entries(reps)) assert.equal(r.detail.netDown, true, `${k} 略過`)
            const obj = createCaptureObject({ stages: Object.entries(reps).map(([name, r]) => ({ name, run: async () => r })) })
            const out = await obj.run({ deps, log })
            assert.equal(out.summary, '來源 0 個、新文件 0、素材 0、轉錄 0、放棄 0｜線索消化 0、新來源 0', out.summary)
        })
    })

    describe('補全文(本機網路不通)', () => {
        const CAP = {
            articles: { perRun: 10, maxTries: 3, maxTextChars: 20000, aggregatorLinksPerDoc: 12, timeoutMs: 1000, retryBackoffHours: 6, skipTitlePatterns: [] },
            standards: { minFallbackChars: 300, minTextChars: 300 },
            browser: { perRun: 0, maxMs: 600000, navTimeoutMs: 20000, camofox: { enabled: true, port: 19417 } },
        }
        const env = (rows, outcomes, netGuard) => {
            const docs = memStore(rows)
            const calls = []
            const article = { id: 'article', retries: 0, retryDelayMs: 0, timeoutMs: 1000, fetch: async (d) => {
                calls.push(d.id)
                return outcomes[d.id] || { ok: true, text: LONG('正常正文') }
            } }
            const deps = { stores: { docs }, registry: { resolve: () => article, label: () => 'x' }, seen: { idOf: () => 'zz' }, settings: S(CAP), clock, dirs: { tmp: TMP }, netGuard }
            const log = recLog()
            return { docs, calls, log, run: () => stageDetailFetch({}).run({ deps, log }) }
        }

        it('開工前本機網路不通 → 本段略過:不發請求、不改任何文件;WARN「本機網路不通」(巡檢必看)', async () => {
            const e = env([{ id: 'a', status: 'new', url: 'https://s.test/a', fetchTries: 0 }], {}, guard({ up: false }))
            const r = await e.run()
            assert.deepEqual([r.detail.netDown, e.calls.length, (await e.docs.get('a')).fetchTries], [true, 0, 0])
            assert.ok(e.log.lines.some((l) => /^WARN 補全文：本機網路不通（api\.test：不通（連線失敗））/.test(l)), e.log.lines.join('\n'))
        })

        it('執行中失敗而確認本機網路不通 → 該篇不計 tries、不改狀態;本段停止(後續不發請求);網路通則照常計', async () => {
            const rows = [{ id: 'a', status: 'new', url: 'https://s.test/a', fetchTries: 0, collectedAt: '2026-09-01' }, { id: 'b', status: 'new', url: 'https://s.test/b', fetchTries: 0, collectedAt: '2026-09-02' }]
            const out = { a: { ok: false, reason: 'curl-error', message: 'Could not resolve host' } }
            const e = env(rows, out, guard({ up: true, confirm: true }))
            const r = await e.run()
            const a = await e.docs.get('a')
            assert.deepEqual([a.status, a.fetchTries, a.lastError, a.retryAt], ['new', 0, undefined, undefined], '不計、原狀待抓')
            assert.deepEqual([e.calls, r.detail.netDeferred], [['a'], 1], '後續不再發請求')
            assert.ok(e.log.lines.some((l) => /^WARN 補全文：本機網路不通.*1 篇之失敗不計 tries，本段提前停止/.test(l)))
            const u = env(rows, out, guard({ up: true, confirm: false }))
            await u.run()
            assert.equal((await u.docs.get('a')).fetchTries, 1, '網路通 → 照常計(capture.browser.perRun 0 時 net 類照舊 curl 重試)')
            // HTTP 狀態碼之失敗不問網路(收到回應即網路通)
            const h = env(rows, { a: { ok: false, reason: 'http-error', message: 'HTTP 503', extra: { httpCode: 503 } } }, guard({ up: true, confirm: true }))
            await h.run()
            assert.equal((await h.docs.get('a')).fetchTries, 1)
        })
    })

    describe('輪抓(本機網路不通)', () => {
        const env = (fetchImpl, netGuard, src = {}) => {
            const sources = memStore([{ id: 's1', name: 'S1', kind: 'rss', url: 'https://s1.test/feed', tier: 1, lastFetchAt: '', failCount: 0, ...src }])
            const fetcher = { id: 'rss', retries: 0, retryDelayMs: 0, timeoutMs: 1000, fetch: fetchImpl }
            const deps = { stores: { sources, docs: memStore([]) }, registry: { resolve: () => fetcher, label: () => 'rss' }, settings: S({ sources: { perRun: 5, minIntervalMs: 0, itemsPerSource: 8, maxConsecFails: 8 }, articles: { maxTextChars: 20000 } }), clock, netGuard }
            const log = recLog()
            return { sources, log, run: () => stageListFetch({}).run({ deps, log }) }
        }

        it('開工前不通 → 略過、不計任何來源;抓取失敗而確認不通 → 不計帳(failCount、lastFetchAt 皆不動,下輪仍到期);網路通 → 照常計', async () => {
            const boom = async () => {
                throw new Error('curl: (6) Could not resolve host')
            }
            const s0 = env(boom, guard({ up: false }))
            const r0 = await s0.run()
            assert.deepEqual([r0.detail.netDown, (await s0.sources.get('s1')).lastFetchAt], [true, ''])
            const s1 = env(boom, guard({ up: true, confirm: true }))
            const r1 = await s1.run()
            const a = await s1.sources.get('s1')
            assert.deepEqual([a.failCount, a.lastFetchAt, r1.detail.netDeferred], [0, '', 1])
            const s2 = env(boom, guard({ up: true, confirm: false }))
            await s2.run()
            assert.equal((await s2.sources.get('s1')).failCount, 1)
            // HTTP 狀態之失敗(收到回應)不問網路
            const s3 = env(async () => {
                throw new Error('HTTP 404 Not Found')
            }, guard({ up: true, confirm: true }))
            await s3.run()
            assert.equal((await s3.sources.get('s1')).failCount, 1)
        })
    })

    describe('線索(端點故障與失敗重探)', () => {

        it('端點全敗而網路通 → 端點故障:不加 tries、退避;同輪連 2 篇即停探關鍵詞(其餘原狀);確認不通 → 不計、本段停止', async () => {
            const frontier = memStore([1, 2, 3].map((i) => ({ id: `c${i}`, type: 'keyword', value: `kw${i}`, hits: 10 - i, status: 'pending', tries: 0, addedAt: '2026-01-01' })))
            // 探測替身:本輪端點已斷者回 skipped(同 probeSearchEndpoints 之守門),否則端點全敗
            const probe = defineMw({ name: 'probe', handle: async (m, ctx, next) => {
                m.data._outcome = m.data._probeRound?.keywordBroken ? { ok: false, skipped: true, error: '略過' } : { ok: false, endpointFail: true, error: '探測端點皆失敗：Bing：HTTP 429' }
                return next(m)
            } })
            const deps = { stores: { frontier }, settings: S({ articles: { retryBackoffHours: 6 }, expand: { perRun: 5, maxPending: 0 } }), clock, netGuard: guard({ up: true, confirm: false }) }
            const log = recLog()
            const r = await stageExpand({ chain: [probe, mwSettleClue({})] }).run({ deps, log })
            const [c1, c2, c3] = await Promise.all(['c1', 'c2', 'c3'].map((id) => frontier.get(id)))
            assert.deepEqual([c1.tries, c1.status, c2.tries, c2.deferrals], [0, 'pending', 0, 1], '端點故障不計線索之失敗')
            assert.ok(Date.parse(c1.retryAt) > Date.now(), '退避')
            assert.deepEqual([c3.tries, c3.retryAt, c3.deferrals], [0, undefined, undefined], '第 3 篇:本輪已停探 → 原狀')
            assert.deepEqual([r.detail.endpointDeferred, r.detail.skipped], [2, 1])
            // 確認不通 → 不計、本段停止
            const fr2 = memStore([{ id: 'x', type: 'site', value: 'https://x.test', hits: 5, status: 'pending', tries: 0, addedAt: '2026-01-01' }, { id: 'y', type: 'site', value: 'https://y.test', hits: 1, status: 'pending', tries: 0, addedAt: '2026-01-02' }])
            let probed = 0
            const p2 = defineMw({ name: 'probe', handle: async (m, ctx, next) => {
                probed++
                m.data._outcome = { ok: false, mayNet: true, error: '首頁抓取失敗:連線失敗' }
                return next(m)
            } })
            const r2 = await stageExpand({ chain: [p2, mwSettleClue({})] }).run({ deps: { ...deps, stores: { frontier: fr2 }, netGuard: guard({ up: true, confirm: true }) }, log })
            assert.deepEqual([(await fr2.get('x')).tries, (await fr2.get('x')).retryAt, probed, r2.detail.netDeferred], [0, undefined, 1, 1])
        })

        it('probeSearchEndpoints:本輪端點已斷之線索直接略過(不發請求)', async () => {
            const r = await probeSearchEndpoints({ type: 'keyword', value: 'momentum', _probeRound: { keywordBroken: true } }, { deps: { settings: S({ services: { bingNews: { base: DEAD_BASE }, arxiv: { base: DEAD_BASE } } }) } })
            assert.deepEqual([r.ok, r.skipped], [false, true])
        })

        it('線索失敗(線索本身之問題)照計 tries 並退避;達上限轉 failed 並記 failedAt;退避中者不被挑', async () => {
            const frontier = memStore([{ id: 'c', type: 'site', value: 'https://x.test', hits: 3, status: 'pending', tries: 0 }])
            await settleClue(frontier, await frontier.get('c'), { ok: false, error: '未找到可用 feed' }, { nowIso: NOW, maxTries: 2, backoffHours: 6 })
            const c = await frontier.get('c')
            assert.deepEqual([c.status, c.tries, c.retryAt], ['pending', 1, new Date(NOW_MS + 6 * 3_600_000).toISOString()])
            assert.equal((await pickClues(frontier, 5, { nowMs: NOW_MS })).length, 0, '退避中不挑')
            assert.equal((await pickClues(frontier, 5, { nowMs: NOW_MS + 7 * 3_600_000 })).length, 1, '到期即回')
            await settleClue(frontier, await frontier.get('c'), { ok: false, error: '未找到可用 feed' }, { nowIso: NOW, maxTries: 2, backoffHours: 6 })
            const f = await frontier.get('c')
            assert.deepEqual([f.status, f.failedAt, f.retryAt], ['failed', NOW, ''])
        })

        it('failed 線索冷卻重探:冷卻 reprobeDays×2^已重探次數(上限 ×8)、每輪上限、依優先序;未記 failedAt 者先補記不重探;未設即不重探', async () => {
            const old = new Date(NOW_MS - 40 * 86_400_000).toISOString()
            const frontier = memStore([
                { id: 'a', type: 'site', value: 'https://a.test', hits: 9, status: 'failed', tries: 2, failedAt: old },
                { id: 'b', type: 'site', value: 'https://b.test', hits: 1, status: 'failed', tries: 2, failedAt: old },
                { id: 'c', type: 'site', value: 'https://c.test', hits: 5, status: 'failed', tries: 2, failedAt: old, reprobes: 1 },
                { id: 'd', type: 'site', value: 'https://d.test', hits: 5, status: 'failed', tries: 2 },
            ])
            const r = await reprobeFailedClues(frontier, { nowMs: NOW_MS, nowIso: NOW, reprobeDays: 30, perRun: 1 })
            assert.deepEqual([r.reprobed.map((x) => x.id), r.stamped], [['a'], 1], 'a(hits 高)先;c 已重探 1 次 → 冷卻 60 天未到;d 補記 failedAt')
            const a = await frontier.get('a')
            assert.deepEqual([a.status, a.tries, a.reprobes], ['pending', 0, 1])
            assert.equal((await frontier.get('d')).failedAt, NOW)
            assert.deepEqual((await reprobeFailedClues(frontier, { nowMs: NOW_MS, reprobeDays: 0, perRun: 5 })).reprobed, [], '未設即不重探')
        })
    })

    describe('領域發現(失敗不作廢窗口;本機網路不通)', () => {
        const env = (opt = {}) => {
            const day = (d) => new Date(NOW_MS - d * 86400_000).toISOString()
            const notes = memStore(Array.from({ length: 25 }, (_, i) => ({ id: `n${i}`, title: `T${i}`, concepts: ['市場情緒'], createdAt: day(3), docId: `d${i}` })))
            const docs = memStore(Array.from({ length: 25 }, (_, i) => ({ id: `d${i}`, status: 'noted', sourceId: 'rss1' })))
            const areas = memStore(opt.areas || [])
            const cap = {
                services: { openAlex: { base: 'http://oa.test' } },
                areas: { openAlexFields: '', maxActive: 60, minFreshRate: 0.2 },
                discover: { everyHours: 24, windowDays: 30, minSupport: 20, minClueDocs: 3, candidatesPerCall: 8, minHits: 200, newPerDay: 2, rejectCooldownDays: 30 },
                sources: { itemsPerSource: 8, lowYieldRate: 0.1, cullMinJudged: 6 },
            }
            const calls = { ai: 0 }
            const deps = {
                stores: { notes, docs, areas, sources: memStore([]), frontier: memStore([]) },
                settings: S(cap),
                clock: { iso8: () => NOW },
                dirs: { knowledge: TMP },
                seen: { idOf: (u) => `id:${u}` },
                data: { vocab: null },
                ...(opt.netGuard ? { netGuard: opt.netGuard } : {}),
            }
            const st = stageAreas({ now: () => opt.nowMs || NOW_MS, callAI: async () => {
                calls.ai++
                return { ok: false, error: '供應商皆失敗' }
            }, fetchWebByCurl: async () => ({ status: 'success', html: '{"meta":{"count":0},"results":[]}' }) })
            return { deps, st, calls, areas }
        }

        it('AI 失敗 → lastDiscoverAt 不推進、記 discoverFailAt;3 小時內不再試,過後再試(失敗若寫 lastDiscoverAt 會作廢整個 24 小時窗口)', async () => {
            const e = env()
            const r = await e.st.run({ deps: e.deps, log: recLog() })
            const meta = await e.areas.get(AREA_META_ID)
            assert.deepEqual([r.detail.discovered, Boolean(r.detail.error), meta.lastDiscoverAt, meta.discoverFailAt], [true, true, undefined, NOW])
            const r2 = await e.st.run({ deps: e.deps, log: recLog() })
            assert.deepEqual([r2.detail.skipped, e.calls.ai], ['上次發現失敗，未到重試間隔', 1])
            const later = env({ areas: [{ id: AREA_META_ID, discoverFailAt: NOW }], nowMs: NOW_MS + 3 * 3_600_000 + 1 })
            const r3 = await later.st.run({ deps: later.deps, log: recLog() })
            assert.deepEqual([r3.detail.discovered, later.calls.ai], [true, 1], '逾重試間隔再試')
        })

        it('本機網路不通 → 只略過發現(品質回饋、重探、來源同步、投影照跑)', async () => {
            const e = env({ netGuard: guard({ up: false }) })
            const log = recLog()
            const r = await e.st.run({ deps: e.deps, log })
            assert.deepEqual([r.detail.skipped, e.calls.ai], ['本機網路不通', 0])
            assert.ok(fs.existsSync(path.join(TMP, 'areas.md')), '投影照跑')
            assert.ok(log.lines.some((l) => /^WARN 領域發現：本機網路不通/.test(l)))
        })
    })

    describe('AI 調度層', () => {

        it('整條遞補鏈皆敗且確認本機網路不通 → skipped(不記 tries;error 標「本機網路不通」);網路通 → 照常為失敗', async () => {
            const mk = (down) => {
                const dir = path.join(TMP, `ai-${down}`)
                fs.mkdirSync(dir, { recursive: true })
                return createAiAdapter({
                    // 逾時給 60 秒(單次逾時低於上游門檻 20 秒者,調度層以逾時為門檻——見 adapter 檔頭【單次嘗試之開工門檻】);連線被拒仍是瞬間失敗
                    ai: { extraProviders: [{ id: 'rest:dead', model: 'm', kind: 'api-openai-compat', baseURL: `${DEAD_BASE}/v1`, envVar: 'NG_KEY' }], providerTimeouts: { 'rest:dead': 60_000 }, cooldownMs: 1_000, maxRetries: 0 },
                    env: { NG_KEY: 'k' },
                    workspace: dir,
                    clock,
                    isNetDown: async () => down,
                })
            }
            const r = await mk(true).callJson('x', () => true, { spec: { use: 'rest:dead' } })
            assert.deepEqual([r.ok, r.skipped], [false, true])
            assert.match(r.error, /^本機網路不通（不計此次之失敗）/)
            const r2 = await mk(false).callJson('x', () => true, { spec: { use: 'rest:dead' } })
            assert.deepEqual([r2.ok, r2.skipped], [false, false])
        })
    })
})
