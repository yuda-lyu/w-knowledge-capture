// unit-capture-fix.test.mjs — 無效文章處置與原文保存(失敗分流、同一內容比對、原文另存與回溯、終態回收)
//   失敗分流(CS3):adapter 暫時性失敗重試、407、mayBeNetFailure;跨輪 curl 前置＋瀏覽器全環境失敗＝環境;暫存檔寫入失敗＝環境;
//     feed 可用(長度＋閘;CS1c)才放棄延後;彙整貼文決定性失敗一輪終態;暫時性失敗退避;判死一級欄位
//   同一內容比對(CS10):錨須已取得內容;落盤比對自身網址之代稱;slug 限同主機;存量群只處置與留存者直接相連者
//   原文保存與回溯(CS13):落 raw 即另存取得物;內容類判死另存依據;另存完整性;依版重判內容類 dead(CS1a);回溯之形狀驗證、版本、重試、
//     清無原文標記、另存之 textFrom 標明取得方式;feed 與 grid 之原長
//   終態回收:清當前類別欄、留歷史、新篩選
// 執行:自套件根 node <mocha> --timeout 180000 test/unit-capture-fix.test.mjs(暫存 test/_tmp/capture-fix-<pid>,測完即刪)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import W from 'w-data-pipeline/src/WDataPipeline.mjs'
import { memStore } from './tools/memStore.mjs'
import { deepMerge, settingsOf } from './tools/captureTestKit.mjs'
import { recLog, silentLog } from './tools/testKit.mjs'
import { genClockTZ } from '../src/core/runnerPackage.mjs'
import { classifyFetch, mayBeNetFailure } from '../src/stores/fetchPolicy.mjs'
import { runBrowserLadder } from '../src/fetchers/browserLadder.mjs'
import { runBrowserCli, createBrowserFetcher } from '../src/fetchers/browserFetcher.mjs'
import { stageDetailFetch, feedUsableOf } from '../src/stages/detailFetchStage.mjs'
import { stageDocMaintain } from '../src/stages/docMaintainStage.mjs'
import { buildIndex, isContentAnchor, paraKeysOf, contentIndexOf } from '../src/stores/contentIndex.mjs'
import { contentKeysOfUrl } from '../src/standards/docStandards.mjs'
import { dupPlanOf } from '../src/ops/docStockFix.mjs'
import { packText, archiveDocText, archiveIntact, docTextOf, docArchiveOf } from '../src/core/stores/docTexts.mjs'
import { slimTerminalDocs, backoffUntil } from '../src/core/stores/docPolicy.mjs'
import { createHealthGates, planDeadRecheck, planHealthRecheck } from '../src/stores/healthRecheck.mjs'
import { parseArxivFeed, refetchMethodOf, refetchSources, REFETCH_LEDGER_FILE } from '../src/ops/refetchSources.mjs'
import { reviveDeadDocs, deadMatcher } from '../src/ops/reviveDocs.mjs'
import { ingestFeedItems } from '../src/stores/ingestGate.mjs'
import { defaultToRecord } from '../src/core/util/records.mjs'

const clock = genClockTZ('Asia/Taipei')
const NOW = '2026-10-05T18:00:00+08:00'
const TMP = path.resolve(`test/_tmp/capture-fix-${process.pid}`)
const LONG = (s) => `${s}。本段說明研究設計、樣本期間、交易成本假設與穩健性檢驗之結果。`.repeat(12)
const PARA = (s) => `${s}之量化研究段落內容說明，`.repeat(6)
/** U+FFFD(Unicode 取代字元;亂碼之特徵字元) */
const FFFD = '�'

describe('unit-capture-fix', function() {

    before(() => fs.mkdirSync(TMP, { recursive: true }))
    after(() => fs.rmSync(TMP, { recursive: true, force: true }))

    describe('失敗分流與環境失敗(CS3)', () => {

        it('adapter 之暫時性失敗(5xx／429／逾時／連線／抓取函數拋錯)→ 重試(不轉瀏覽器);adapter 之其他失敗仍終態;407 → 重試', () => {
            const c = (o) => classifyFetch({ ok: false, fetcherId: 'article', ...o })
            // adapter 之 API 暫時性失敗不得一輪即 dead:重試
            assert.deepEqual([c({ reason: 'http-error', httpCode: 503, adapterId: 'msn' }).action, c({ reason: 'http-error', httpCode: 503, adapterId: 'msn' }).cls], ['retry', 'adapter-transient'])
            for (const reason of ['timeout', 'curl-error', 'fetcher-error']) assert.equal(c({ reason, adapterId: 'msn' }).action, 'retry', reason)
            assert.equal(c({ reason: 'http-error', httpCode: 429, adapterId: 'msn' }).action, 'retry')
            // 決定性者終態(HTTP 決定性碼先判;adapter 收攤之內容問題)
            assert.deepEqual([c({ reason: 'http-error', httpCode: 410, adapterId: 'msn' }).cls, c({ reason: 'empty-content', adapterId: 'msn' }).cls], ['http-final', 'adapter'])
            // 407 屬本機連線環境(代理驗證),不是文章之決定性失敗
            assert.deepEqual([c({ reason: 'http-error', httpCode: 407 }).action, c({ reason: 'http-error', httpCode: 407 }).cls], ['retry', 'http-transient'])
        })

        it('mayBeNetFailure:無 HTTP 回應者(連線、逾時、瀏覽器錯)須先確認網路;有 HTTP 狀態(407 除外)或內容判定者不必', () => {
            for (const f of [{ reason: 'curl-error' }, { reason: 'timeout' }, { reason: 'playwright-error' }, { reason: 'cli-timeout' }, { reason: 'fetch-error' }, { reason: 'http-error', httpCode: 407 }]) assert.equal(mayBeNetFailure(f), true, JSON.stringify(f))
            for (const f of [{ reason: 'http-error', httpCode: 503 }, { reason: 'paywall' }, { reason: 'too-short' }, { reason: 'pdf' }, { reason: 'mojibake' }, { reason: 'redirect' }]) assert.equal(mayBeNetFailure(f), false, JSON.stringify(f))
        })

        it('跨輪階梯:前置 curl 失敗而瀏覽器階全為環境失敗 → browser-env(不計 tries);只有 curl 一階者照常回 curl 之失敗', async () => {
            const gate = { assess: () => ({ ok: true }) }
            const fetchWeb = async (u, o) => {
                if (o.method === 'curl') return { status: 'error', reason: 'http-error', message: 'HTTP 403' }
                if (o.method === 'playwright') return { status: 'error', reason: 'playwright-error', message: "browserType.launch: Executable doesn't exist" }
                return { status: 'error', reason: 'camofox-not-found', message: 'not installed' }
            }
            const r = await runBrowserLadder('https://x.test/a', ['curl', 'camofox', 'playwright'], { fetchWeb, gate })
            // 前置 curl 失敗而瀏覽器階全為環境失敗 → browser-env(不回 curl 之 http-error 而使瀏覽器佇列件計次)
            assert.deepEqual([r.reason, r.final], ['browser-env', false])
            assert.match(r.message, /前置 curl：http-error/)
            assert.deepEqual(r.envBroken.sort(), ['camofox', 'playwright'])
            const r1 = await runBrowserLadder('https://x.test/a', ['curl'], { fetchWeb, gate })
            assert.equal(r1.reason, 'http-error', '只 curl 一階(瀏覽器方法皆被排除)→ 照常計')
        })

        it('瀏覽器階之終態閘(付費牆等)回傳判定所依之正文(evidence;供另存判定依據,CS13)', async () => {
            const gate = { assess: () => ({ ok: false, kind: 'paywall', hit: '訂閱' }) }
            const r = await runBrowserLadder('https://x.test/p', ['playwright'], { fetchWeb: async () => ({ status: 'success', content: '付費預告之頁面正文', title: 'T', method: 'playwright-headless' }), gate })
            assert.deepEqual([r.final, r.reason, r.evidence.text, r.evidence.method], [true, 'paywall', '付費預告之頁面正文', 'playwright-headless'])
        })

        it('瀏覽器暫存檔寫入失敗 → browser-env(本機環境,不計 tries;不得在 try 之外拋出)', async () => {
            const blocker = path.join(TMP, 'not-a-dir')
            fs.writeFileSync(blocker, 'x', 'utf8')
            const r = await runBrowserCli('https://x.test/a', ['playwright'], { capture: {}, tmpDir: blocker, tag: 'd1', runCli: async () => ({ status: 'success', content: 'x' }) })
            assert.deepEqual([r.status, r.reason], ['error', 'browser-env'])
            assert.match(r.message, /瀏覽器暫存檔寫入失敗/)
        })

        it('feedUsableOf(CS1c;第二參數為 settings.capture.standards):長度足而未過健全閘(亂碼)→ 不可作退路;長度與閘皆過 → 可;退路門檻取 standards.minFallbackChars(與正文門檻 minTextChars 各自獨立)', () => {
            const standards = { minFallbackChars: 300, minTextChars: 300, maxSaneChars: 300000, placeholderPatterns: [], paywallPatterns: [] }
            const bad = feedUsableOf({ feedText: `${'正文內容'.repeat(80)}${FFFD.repeat(30)}`, title: 'T' }, standards)
            assert.deepEqual([bad.long, bad.usable, bad.gate.kind], [true, false, 'mojibake'])
            assert.equal(feedUsableOf({ feedText: LONG('可用之摘要'), title: 'T' }, standards).usable, true)
            assert.deepEqual([feedUsableOf({ feedText: '短' }, standards).long, feedUsableOf({ feedText: '短' }, standards).usable], [false, false])
            // 取自完整設定之 capture.standards:門檻 minFallbackChars 調高 → 同一份 feed 不再足長
            const feed = { feedText: LONG('可用之摘要').slice(0, 400), title: 'T' }
            assert.equal(feedUsableOf(feed, settingsOf().capture.standards).usable, true, '預設 300')
            assert.deepEqual([feedUsableOf(feed, settingsOf({ standards: { minFallbackChars: 500 } }).capture.standards).long, feedUsableOf(feed, settingsOf({ standards: { minFallbackChars: 500 } }).capture.standards).usable], [false, false], '門檻 500 > 400 字')
        })
    })

    // ── 補全文子階段(替身抓取器;不發網路)──
    // 本組測試之基準設定(capture 之巢狀形狀;各案以 opt.cap 遞迴覆寫);標題預篩樣式(例行週報)取自 capture.articles.skipTitlePatterns
    const CAP = {
        articles: { perRun: 10, maxTries: 3, maxTextChars: 20000, aggregatorLinksPerDoc: 12, timeoutMs: 1000, retryBackoffHours: 6, skipTitlePatterns: [/^週報/] },
        standards: { minFallbackChars: 300, minTextChars: 300, placeholderPatterns: [], paywallPatterns: [{ p: '訂閱後閱讀全文', f: 'i' }] },
        browser: { perRun: 1, maxMs: 600000, navTimeoutMs: 20000, camofox: { enabled: true, port: 19417 } },
    }
    const doc = (id, extra = {}) => ({ id, status: 'new', title: `文章 ${id}`, url: `https://site.example/${id}`, fetchTries: 0, sourceTier: 2, collectedAt: `2026-09-0${id.length}`, ...extra })
    /**
     * 環境:article 抓取器依 id 回傳預設結果;links 抓取器(彙整貼文)依 id;browser 以注入之 runCli
     * @param {Array} rows 輸入文件
     * @param {Object} outcomes 輸入 id → article 結果
     * @param {Object} [opt={}] 輸入 { cli, links, cap, netGuard, extraRows }
     * @returns {Object} 回傳環境
     */
    function env(rows, outcomes, opt = {}) {
        const docs = memStore(rows)
        const docTexts = memStore([])
        const cliCalls = []
        const runCli = async (o) => {
            const opts = JSON.parse(fs.readFileSync(o.args[1], 'utf8'))
            cliCalls.push({ url: o.args[0], steps: opts.steps })
            return (opt.cli || (() => ({ status: 'success', content: LONG('瀏覽器取得之正文'), title: 'B', method: 'playwright-headless', envBroken: [], steps: [{ step: opts.steps[0], ok: true }] })))(o.args[0], opts)
        }
        const article = { id: 'article', retries: 0, retryDelayMs: 0, timeoutMs: 1000, fetch: async (d) => outcomes[d.id] || { ok: true, text: LONG('正常正文') } }
        const links = { id: 'links', retries: 0, retryDelayMs: 0, timeoutMs: 1000, fetch: async (d) => (opt.links || {})[d.id] || { ok: true, links: [] } }
        const browser = createBrowserFetcher({ runCli })
        const registry = { resolve: (role, d) => (d.fetcher === 'browser' ? browser : (d.fetcher === 'links' ? links : article)), label: () => 'x' }
        const seen = { idOf: (u) => (String(u).includes('/dup-target') ? 'dupT' : 'zz-unknown') }
        const deps = { stores: { docs, docTexts }, registry, seen, settings: settingsOf(deepMerge(CAP, opt.cap)), clock, dirs: { tmp: TMP }, ...(opt.netGuard ? { netGuard: opt.netGuard } : {}) }
        const logger = recLog()
        return { docs, docTexts, cliCalls, deps, logger, run: () => stageDetailFetch({ runCli }).run({ deps, log: logger }) }
    }

    describe('補全文子階段(失敗分流、退避、判死、另存)', () => {

        it('feed 長度足而未過閘、瀏覽器環境不可用 → 延後至瀏覽器佇列(不計 tries);不因 feed 只驗長度而放棄延後、落庫計次(CS1c)', async () => {
            const feedText = `${'正文內容'.repeat(80)}${FFFD.repeat(30)}`
            const e = env([doc('fx', { feedText })], { fx: { ok: false, reason: 'http-error', message: 'HTTP 403', extra: { httpCode: 403 } } }, { cli: () => ({ status: 'error', reason: 'browser-env', message: '無 Chrome', envBroken: ['camofox', 'playwright'], steps: [] }) })
            await e.run()
            const d = await e.docs.get('fx')
            assert.deepEqual([d.status, d.fetchTries, d.fetcher, d.deferrals], ['new', 0, 'browser', 1])
        })

        it('彙整貼文(links)失敗:HTTP 決定性(404)→ 一輪終態;暫時性(503)→ 重試並退避(retryAt)', async () => {
            const e = env([doc('w1', { title: '週報 第 1 期' }), doc('w22', { title: '週報 第 2 期' })], {}, {
                links: { w1: { ok: false, reason: 'http-error', message: 'HTTP 404' }, w22: { ok: false, reason: 'http-error', message: 'HTTP 503' } },
            })
            await e.run()
            const a = await e.docs.get('w1')
            const b = await e.docs.get('w22')
            assert.deepEqual([a.status, a.deadClass, a.httpCode, a.deadBy], ['dead', 'http-final', 404, 'links'], '一輪終態、判死一級欄位')
            assert.deepEqual([b.status, b.fetchTries], ['new', 1])
            assert.ok(Date.parse(b.retryAt) > Date.now(), '暫時性失敗退避')
        })

        it('暫時性失敗之退避:retryAt 未到者本輪不取(不丟);到期即回佇列;第 n 次失敗 6×4^(n-1) 小時', async () => {
            const e = env([doc('r1', { fetchTries: 1, retryAt: '2999-01-01T00:00:00Z' }), doc('r22', { fetchTries: 1, retryAt: '2000-01-01T00:00:00Z' })], {
                r22: { ok: false, reason: 'http-error', message: 'HTTP 503', extra: { httpCode: 503 } },
            })
            const r = await e.run()
            assert.equal(r.detail.queuedBackoff, 1, '退避中者不取')
            assert.equal((await e.docs.get('r1')).fetchTries, 1, '退避中者原狀')
            const b = await e.docs.get('r22')
            assert.equal(b.fetchTries, 2)
            const h = (Date.parse(b.retryAt) - Date.now()) / 3_600_000
            assert.ok(h > 23 && h <= 24.1, `第 2 次失敗退避約 24 小時(實得 ${h.toFixed(2)})`)
            assert.equal(backoffUntil(Date.parse('2026-10-05T00:00:00Z'), 1, 6), '2026-10-05T06:00:00.000Z')
            assert.equal(backoffUntil(Date.now(), 1, 0), '', '0＝不退避')
        })

        it('判死一級欄位;內容類判死(付費牆)記閘版本並另存判定依據(取得物;CS13)', async () => {
            const pw = `${'這是付費文章之預告段落，'.repeat(30)}訂閱後閱讀全文`
            const e = env([doc('pw'), doc('n4')], {
                pw: { ok: true, text: pw, title: 'x' },
                n4: { ok: false, reason: 'http-error', message: 'HTTP 404', extra: { httpCode: 404 } },
            })
            await e.run()
            const d = await e.docs.get('pw')
            assert.deepEqual([d.status, d.deadClass, d.deadBy, d.lastReason], ['dead', 'paywall', 'article', 'paywall'])
            assert.ok(d.healthV, '閘判之內容類終態記閘版本(閘改版後依版重判)')
            const a = await docArchiveOf({ docTexts: e.docTexts }, 'pw')
            assert.equal(a.status, 'dead')
            assert.ok(a.text.includes('訂閱後閱讀全文'), '判定依據已另存')
            const n = await e.docs.get('n4')
            assert.deepEqual([n.deadClass, n.httpCode, n.healthV], ['http-final', 404, undefined], 'HTTP 終態無判定正文 → 不記閘版本')
        })

        it('落 raw 即另存(CS13):庫內形態(去重＋截斷)與去重截斷前之取得物(rawGz);相同者不另存 rawGz;瘦身時保留同一次取得之 rawGz', async () => {
            const P1 = PARA('甲')
            const dup = [P1, P1, PARA('乙'), PARA('丙')].join('\n') // 重複段落 → 去重移除
            const e = env([doc('d1'), doc('d22')], { d1: { ok: true, text: dup, title: 'x' }, d22: { ok: true, text: LONG('不重複之正文'), title: 'x' } }, { cap: { articles: { maxTextChars: 200 } } })
            const r = await e.run()
            assert.equal(r.detail.archivedNow, 2)
            const a1 = await docArchiveOf({ docTexts: e.docTexts }, 'd1')
            const d1 = await e.docs.get('d1')
            assert.equal(a1.text, d1.text, '庫內形態＝docs.text(下游材料讀它)')
            assert.equal(a1.raw, dup, '取得物＝去重與截斷前之全文')
            assert.equal(a1.rawFrom, 'article')
            // 瘦身(noted):同一次取得 → 不重寫、rawGz 保留
            await e.docs.patch('d1', { status: 'noted' })
            const s = await slimTerminalDocs(e.docs, { terminalStatuses: ['noted'], archive: e.docTexts, nowIso: NOW })
            assert.deepEqual([s.slimmed, s.archived], [1, 0], '同一份 → 不重寫')
            assert.equal((await docArchiveOf({ docTexts: e.docTexts }, 'd1')).raw, dup, 'rawGz 保留')
            assert.equal((await docTextOf({ docs: e.docs, docTexts: e.docTexts }, 'd1')).text, d1.text)
        })
    })

    describe('同一內容比對(CS10 錨)', () => {

        it('isContentAnchor 與索引:new／dead／重複 skip 不當錨;狀態可增量更新;段落鍵可取代與清除', () => {
            assert.deepEqual([isContentAnchor({ status: 'noted' }), isContentAnchor({ status: 'raw' }), isContentAnchor({ status: 'skip', skipKind: 'triage' }), isContentAnchor({ status: 'new' }), isContentAnchor({ status: 'dead' }), isContentAnchor({ status: 'skip', skipKind: 'duplicate' })], [true, true, true, false, false, false])
            const keys = paraKeysOf([PARA('甲'), PARA('乙'), PARA('丙')].join('\n'))
            const idx = buildIndex([
                { id: 'pdf', url: 'https://arxiv.org/pdf/2401.01234', status: 'dead' },
                { id: 'n', url: 'https://x.test/a', status: 'new' },
                { id: 'k', url: 'https://k.test/a', status: 'noted', paraKeys: keys },
            ])
            assert.equal(idx.matchUrl('https://arxiv.org/abs/2401.01234', 'abs'), null, '錨已死 → 不判同一內容(/abs/ 不因死件而被判重複)')
            idx.add({ id: 'pdf', status: 'raw' })
            assert.equal(idx.matchUrl('https://arxiv.org/abs/2401.01234', 'abs')?.id, 'pdf', '狀態更新後成錨')
            assert.equal(idx.matchParas(keys, 'z')?.id, 'k')
            idx.add({ id: 'k', status: 'dead', paraKeys: null })
            assert.equal(idx.matchParas(keys, 'z'), null, '存量重判判死、清段落鍵 → 不再當錨')
            // 同一代稱之多份:取第一個合格者
            const idx2 = buildIndex([{ id: 'd', url: 'https://arxiv.org/abs/2402.00001', status: 'dead' }, { id: 'ok', url: 'https://arxiv.org/abs/2402.00001v2', status: 'noted' }])
            assert.equal(idx2.matchUrl('https://arxiv.org/pdf/2402.00001', 'q')?.id, 'ok')
        })

        it('落盤:轉址指向舊死件 → 救回之正文照常 raw(不判重複而丟棄);自身網址之代稱與已取得內容之錨相同 → skip 並記 dupOf', async () => {
            const e = env([
                { id: 'dupT', status: 'dead', url: 'https://pub.example/dup-target', title: '舊死件' },
                doc('gn', { url: 'https://news.google.com/rss/articles/abc' }),
                { id: 'anc', status: 'noted', url: 'https://arxiv.org/abs/2403.00001', title: '已摘要' },
                doc('v2', { url: 'https://arxiv.org/abs/2403.00001v2' }),
            ], {
                gn: { ok: true, text: LONG('轉址後之正文'), title: 'x', extra: { finalUrl: 'https://pub.example/dup-target' } },
                v2: { ok: true, text: LONG('新版本之正文'), title: 'x' },
            })
            await e.run()
            const g = await e.docs.get('gn')
            assert.equal(g.status, 'raw', '錨為 dead → 不判重複')
            const v = await e.docs.get('v2')
            assert.deepEqual([v.status, v.skipKind, v.dupOf], ['skip', 'duplicate', 'anc'], '自身網址代稱比對')
        })

        it('slug 代稱限同主機:跨站同 slug 不同內容不判;同站之 www／m／amp 視為同一', () => {
            const slug = 'how-to-build-a-momentum-trading-strategy-in-python'
            const a = contentKeysOfUrl(`https://a.example/blog/${slug}`)
            const b = contentKeysOfUrl(`https://b.example/posts/${slug}`)
            assert.notDeepEqual(a, b, '跨站不同鍵(同鍵會使入庫即判重複)')
            assert.deepEqual(contentKeysOfUrl(`https://www.a.example/blog/${slug}`), a)
            assert.deepEqual(contentKeysOfUrl(`https://m.a.example/blog/${slug}`), a)
        })

        it('CS10 存量處置:只處置與留存者直接相連者;不相連者 deferred(非傳遞重疊之錯刪防護)', () => {
            const docOf = (id) => ({ id, notedAt: `2026-0${id === 'A' ? 1 : 2}-01` })
            const noteOfDoc = (id) => ({ id: `n${id}`, ...(id === 'A' ? { extractedAt: '2026-03-01' } : {}) })
            const p = dupPlanOf(['A', 'B', 'C'], { docOf, noteOfDoc, edges: [['A', 'B'], ['B', 'C']] })
            assert.deepEqual([p.keeper, p.others.map((o) => o.doc), p.deferred], ['A', ['B'], ['C']], '留 A(已消化);C 與 A 無直接重疊 → 不刪')
            const q = dupPlanOf(['A', 'B', 'C'], { docOf, noteOfDoc })
            assert.deepEqual([q.others.length, q.deferred], [2, []], '未給 edges 時全群視為互連')
        })

        it('文件維護同步本行程已建之索引:存量重判判死並清段落鍵 → 不再當錨;補算段落鍵 → 即可被比對(索引為行程內快取,須與存量處置同步)', async () => {
            const keysR = paraKeysOf([PARA('子'), PARA('丑'), PARA('寅')].join('\n'))
            const textN = [PARA('卯'), PARA('辰'), PARA('巳')].join('\n')
            const docs = memStore([
                // 庫內正文為付費牆預告(存量重判判 final → dead、清 paraKeys);段落鍵為先前落盤時以全文算者
                { id: 'r', status: 'raw', textFrom: 'article', text: `${'預告'.repeat(40)}訂閱後閱讀全文`, healthV: 'old', rawAt: '2026-10-01', title: 'T', url: 'https://x.test/r', paraKeys: keysR },
                // 已摘要而無段落鍵(補算對象)
                { id: 'n', status: 'noted', text: textN, notedAt: '2026-10-01', title: 'N', url: 'https://y.test/n' },
            ])
            const idx = await contentIndexOf(docs) // 本行程先建索引(同輪之落盤會建)
            assert.equal(idx.matchParas(keysR, 'z')?.id, 'r', '前提:r 為 raw 錨')
            assert.equal(idx.matchParas(paraKeysOf(textN), 'z'), null, '前提:n 尚無段落鍵')
            await stageDocMaintain({ terminalStatuses: [] }).run({ deps: { stores: { docs, docTexts: memStore([]) }, settings: settingsOf({ standards: { minTextChars: 50, paywallPatterns: [{ p: '訂閱後閱讀全文', f: 'i' }] } }), clock: { iso8: () => NOW } }, log: silentLog })
            assert.equal((await docs.get('r')).status, 'dead')
            assert.equal(idx.matchParas(keysR, 'z'), null, '判死且清鍵已同步索引(快取若仍當錨,後到之同內容會被判重複而丟)')
            assert.equal(idx.matchParas(paraKeysOf(textN), 'z')?.id, 'n', '補算之段落鍵已同步索引')
        })
    })

    describe('原文保存與回溯(CS13)', () => {

        it('另存完整性:壞壓縮 → docTextOf 視同無原文;同雜湊而內容壞 → 重寫;給新取得物 → 取代;未給而庫內形態變 → 清 rawGz', async () => {
            const docTexts = memStore([{ id: 'bad', gz: 'not-gzip-base64!!', feedGz: '', sha1: 'h' }])
            assert.equal(archiveIntact(await docTexts.get('bad')), false)
            assert.equal(await docTextOf({ docs: memStore([]), docTexts }, 'bad'), null, '壞檔視同無(回溯才會重取)')
            const r = await archiveDocText(docTexts, { id: 'bad', text: '正文', status: 'noted' }, NOW)
            assert.equal(r.ok, true)
            assert.equal((await docTextOf({ docs: memStore([]), docTexts }, 'bad')).text, '正文', '壞檔被重寫')
            await archiveDocText(docTexts, { id: 'r', text: '庫內', status: 'raw' }, NOW, { raw: '庫內與更多原文', rawFrom: 'article' })
            assert.equal((await docArchiveOf({ docTexts }, 'r')).raw, '庫內與更多原文')
            // 內容雜湊＝SHA-1 十六進位(庫內形態取「正文＋\u0000＋feed」、取得物取其原文;以 node crypto 獨立算之):既有之另存不因雜湊函數之搬移而被判不同
            const sha = (s) => crypto.createHash('sha1').update(s).digest('hex')
            const rec = await docTexts.get('r')
            assert.deepEqual([rec.sha1, rec.rawSha1], [sha('庫內\u0000'), sha('庫內與更多原文')])
            assert.equal((await archiveDocText(docTexts, { id: 'r', text: '庫內', status: 'noted' }, NOW)).same, true, '瘦身:同一份不重寫')
            await archiveDocText(docTexts, { id: 'r', text: '重抓之新庫內', status: 'raw' }, NOW)
            assert.equal((await docArchiveOf({ docTexts }, 'r')).raw, '', '庫內形態已變而未給取得物 → 清掉舊取得物(屬另一次取得)')
            assert.equal(packText(''), '')
        })

        it('內容類 dead 依版重判(CS1a):現版已不違規 → 回待抓(tries 上限−1、清類別欄、留歷史);仍違規 → 記現版;無依據 → 未能判定', async () => {
            const gates = createHealthGates({ minTextChars: 50, paywallPatterns: [{ p: '舊樣式之付費字樣', f: 'i' }] })
            const ok = planDeadRecheck({ deadClass: 'paywall', healthV: 'old', lastError: '健全閘：x' }, LONG('完整之正文'), gates, { nowIso: NOW, maxFetchTries: 3 })
            assert.deepEqual([ok.status, ok.patch.status, ok.patch.fetchTries, ok.patch.deadClass, ok.patch.revivedFromClass], ['pass', 'new', 2, '', 'paywall'])
            const bad = planDeadRecheck({ deadClass: 'paywall', healthV: 'old' }, `${'預告'.repeat(30)}舊樣式之付費字樣`, gates, { nowIso: NOW })
            assert.deepEqual([bad.status, bad.patch.healthV], ['violation', gates.version])
            assert.equal(planDeadRecheck({ deadClass: 'paywall' }, null, gates).status, 'undetermined')
            // 子階段:dead(閘版本不同)且依據已另存 → 回待抓
            const docs = memStore([{ id: 'dd', status: 'dead', deadClass: 'paywall', healthV: 'old', title: 'T', url: 'https://x.test/dd', deadAt: '2026-10-01', fetchTries: 3 }])
            const docTexts = memStore([])
            await archiveDocText(docTexts, { id: 'dd', text: LONG('完整之正文'), status: 'dead' }, NOW)
            const r = await stageDocMaintain({ terminalStatuses: [] }).run({ deps: { stores: { docs, docTexts }, settings: settingsOf({ standards: { minTextChars: 50 } }), clock: { iso8: () => NOW } }, log: silentLog })
            const d = await docs.get('dd')
            assert.deepEqual([d.status, d.fetchTries, d.deadClass, d.revives, r.detail.health.dead.revived], ['new', 2, '', 1, 1])
        })

        it('存量重判判 dead:判死欄位(deadClass／deadBy health)＋改狀態前另存庫內正文(dead 不在瘦身另存範圍)', async () => {
            const gates = createHealthGates({ minTextChars: 50, paywallPatterns: [{ p: '訂閱後閱讀全文', f: 'i' }] })
            const p = planHealthRecheck({ id: 'r', textFrom: 'article', text: `${'預告'.repeat(40)}訂閱後閱讀全文`, healthV: 'old' }, gates, { nowIso: NOW })
            assert.deepEqual([p.route.action, p.patch.status, p.patch.deadClass, p.patch.deadBy, p.patch.healthV], ['final', 'dead', 'paywall', 'health', gates.version])
            const docs = memStore([{ id: 'r', status: 'raw', textFrom: 'article', text: `${'預告'.repeat(40)}訂閱後閱讀全文`, healthV: 'old', rawAt: '2026-10-01', title: 'T', url: 'https://x.test/r' }])
            const docTexts = memStore([])
            await stageDocMaintain({ terminalStatuses: [] }).run({ deps: { stores: { docs, docTexts }, settings: settingsOf({ standards: { minTextChars: 50, paywallPatterns: [{ p: '訂閱後閱讀全文', f: 'i' }] } }), clock: { iso8: () => NOW } }, log: silentLog })
            assert.equal((await docs.get('r')).status, 'dead')
            assert.ok((await docTextOf({ docs: memStore([]), docTexts }, 'r')).text.includes('訂閱後閱讀全文'), '判定依據已另存')
        })

        it('回溯:arXiv 回應須為 Atom feed(否則端點錯誤)、帶版本與去版本兩鍵皆可查;原網址帶版本者保留版本', () => {
            const m = parseArxivFeed('<feed><entry><id>http://arxiv.org/abs/2401.01234v2</id><title>T</title><summary>S</summary></entry></feed>')
            assert.deepEqual([m.get('2401.01234v2').title, m.get('2401.01234').title], ['T', 'T'])
            assert.throws(() => parseArxivFeed('<html>rate limited</html>'), /非 Atom feed/, '不得當成「查無」')
            assert.equal(refetchMethodOf({ textFrom: 'abstract', url: 'https://arxiv.org/abs/2401.01234v3' }).key, '2401.01234v3')
            assert.equal(refetchMethodOf({ textFrom: 'abstract', url: 'https://arxiv.org/abs/2401.01234' }).key, '2401.01234')
        })

        it('回溯:retry 只重試 fetch-failed、retry all 連同內容判定;另存成功清 paraKeysNoText', async () => {
            const state = path.join(TMP, 'refetch-state')
            fs.mkdirSync(state, { recursive: true })
            fs.writeFileSync(path.join(state, REFETCH_LEDGER_FILE), [
                JSON.stringify({ id: 'f1', outcome: 'fetch-failed' }),
                JSON.stringify({ id: 'm1', outcome: 'identity-mismatch' }),
            ].join('\n') + '\n', 'utf8')
            const docs = memStore([
                { id: 'f1', status: 'noted', textFrom: 'article', url: 'https://x.test/f1', title: '台股動量因子之回測研究', paraKeysNoText: '2026-10-01' },
                { id: 'm1', status: 'noted', textFrom: 'article', url: 'https://x.test/m1', title: '台股動量因子之回測研究' },
            ])
            const notes = memStore([{ id: 'n1', docId: 'f1' }, { id: 'n2', docId: 'm1' }])
            const docTexts = memStore([])
            const refetch = { article: async () => ({ ok: true, content: LONG('台股動量因子之回測研究內容'), title: '台股動量因子之回測研究' }) }
            const deps = { stores: { docs, notes, docTexts }, dirs: { state }, clock, log: silentLog, settings: settingsOf({ standards: { minTextChars: 50 }, articles: { maxTextChars: 20000 } }), refetch }
            assert.equal((await refetchSources(deps, {})).candidates, 0, '帳上已有結論者預設略過')
            assert.equal((await refetchSources(deps, { retry: true })).candidates, 1, 'retry:只 fetch-failed')
            assert.equal((await refetchSources(deps, { retry: 'all' })).candidates, 2, "retry 'all':連同內容判定")
            const r = await refetchSources(deps, { retry: true, apply: true })
            assert.deepEqual(r.outcomes, { archived: 1 })
            assert.equal((await docs.get('f1')).paraKeysNoText, null, '清「無原文」標記(段落鍵補算才會重選)')
        })

        it('回溯另存之 textFrom 標明取得方式:API 依編號／題名取得者為 refetch:arxiv／refetch:openalex、網頁(現在之頁面)為 refetch:article——下游據此區分「網頁今日之頁面」(不能證明為當時之材料)與「API 取得之同一記錄」', async () => {
            const at = '2026-09-01T00:00:00+08:00'
            const ABS = 'We study graph neural networks for molecular property prediction and report consistent gains over baselines. '.repeat(4).trim()
            const docs = memStore([
                { id: 'x1', status: 'noted', textFrom: 'abstract', url: 'https://arxiv.org/abs/2401.00001', title: 'Graph Networks for Molecules', notedAt: at },
                { id: 'x2', status: 'noted', textFrom: 'abstract', url: 'https://doi.org/10.1/abc', title: 'Message Passing Revisited', notedAt: at },
                { id: 'x3', status: 'noted', textFrom: 'abstract', url: 'http://hdl.handle.net/1/z', title: 'Attention Is Not Explanation', notedAt: at },
                { id: 'x4', status: 'noted', textFrom: 'article', url: 'https://e.com/x4', title: '注意力機制之實證研究', notedAt: at },
            ])
            const docTexts = memStore([])
            const refetch = {
                arxiv: async () => new Map([['2401.00001', { title: 'Graph networks for molecules', abstract: ABS }]]),
                openalexDoi: async () => new Map([['https://doi.org/10.1/abc', { title: 'Message passing revisited', abstract: ABS }]]),
                openalexTitle: async () => [{ title: 'Attention is not explanation', abstract: ABS, url: 'http://hdl.handle.net/1/z' }],
                article: async () => ({ ok: true, title: 'x', content: LONG('注意力機制之實證研究') }),
            }
            const deps = { stores: { docs, docTexts }, dirs: { state: path.join(TMP, 'refetch-textfrom') }, clock, log: silentLog, settings: settingsOf({ standards: { minTextChars: 50 }, articles: { maxTextChars: 20000 } }), refetch }
            const r = await refetchSources(deps, { apply: true })
            assert.deepEqual(r.outcomes, { archived: 4 })
            const tf = async (id) => (await docTextOf({ docs, docTexts }, id)).textFrom
            assert.deepEqual([await tf('x1'), await tf('x2'), await tf('x3'), await tf('x4')], ['refetch:arxiv', 'refetch:openalex', 'refetch:openalex', 'refetch:article'])
        })

        it('feed 原長:契約層不截,記錄層截 capture.articles.maxTextChars 並記 feedFullLength(CS1c);grid 記截 4,000 前之原長(CS1d)', async () => {
            const docs = memStore([])
            const seen = W.createSeenStore({ collection: docs, identity: W.createIdentity({ keyOf: 'raw' }), log: silentLog })
            const ctx = { deps: { settings: settingsOf({ sources: { itemsPerSource: 8 }, articles: { maxTextChars: 100 } }), seen, clock: { iso8: () => NOW }, stores: { docs } }, log: silentLog }
            await ingestFeedItems([{ url: 'https://feed.example/long', title: '長 feed', content: 'x'.repeat(250) }], { source: { id: 's', name: 'S', kind: 'rss', tier: 2 }, fetcherId: 'rss', ctx })
            const d = (await docs.select())[0]
            assert.deepEqual([d.feedText.length, d.feedFullLength], [100, 250])
            const rec = defaultToRecord({ settings: settingsOf({ articles: { maxTextChars: 20000 } }), clock: { iso8: () => NOW } })({ url: 'https://doi.org/10.1/x', text: 'a'.repeat(4000), extra: { fullLength: 5200 } }, { source: { id: 'g', name: 'G', kind: 'grid' } })
            assert.deepEqual([rec.status, rec.fullLength], ['raw', 5200])
        })
    })

    describe('終態回收', () => {

        it('reviveDeadDocs:清當前類別欄、留歷史(revivedFrom／revivedFromClass／revives)、tries 由呼叫端定、limit 依 deadAt 先後;deadMatcher 之 cls／untriedBrowser', async () => {
            const docs = memStore([
                { id: 'a', status: 'dead', url: 'https://s.example/a', deadClass: 'http-blocked', lastClass: '', lastReason: 'http-error', lastError: 'HTTP 403', deadAt: '2026-09-01', httpCode: 403, deadBy: 'article', refetchSkip: ['curl'] },
                { id: 'b', status: 'dead', url: 'https://s.example/b', deadClass: 'http-blocked', lastClass: 'http-blocked', curlReason: 'http-error', lastError: 'camofox', deadAt: '2026-09-02', deadBy: 'browser' },
                { id: 'c', status: 'dead', url: 'https://s.example/c', deadClass: 'http-final', lastError: 'HTTP 404', deadAt: '2026-08-01' },
            ])
            const m = deadMatcher({ cls: 'http-blocked', untriedBrowser: true })
            assert.deepEqual([m(await docs.get('a')), m(await docs.get('b')), m(await docs.get('c'))], [true, false, false], '從未經瀏覽器嘗試之 http-blocked')
            assert.equal(deadMatcher({})({ url: 'https://x' }), false, '無條件不誤配整批')
            const dry = await reviveDeadDocs({ docs }, { match: deadMatcher({ cls: 'http-blocked,http-final' }), nowIso: NOW, dryRun: true, limit: 2 })
            assert.deepEqual([dry.matched, dry.picked, dry.revived, dry.byClass], [3, 2, 0, { 'http-final': 1, 'http-blocked': 1 }], 'limit 依 deadAt 先後(c、a)')
            await reviveDeadDocs({ docs }, { match: m, nowIso: NOW, fetchTries: 2, patchOf: () => ({ fetcher: 'browser', lastClass: 'http-blocked' }) })
            const a = await docs.get('a')
            assert.deepEqual([a.status, a.fetchTries, a.fetcher, a.lastClass, a.deadClass, a.deadAt, a.httpCode, a.refetchSkip, a.lastError], ['new', 2, 'browser', 'http-blocked', '', '', 0, null, ''])
            assert.deepEqual([a.revivedFrom, a.revivedFromClass, a.revives], ['HTTP 403', 'http-blocked', 1])
        })

        it('reviveDeadDocs 依現行分流自動路由(cfg.capture):瀏覽器類且瀏覽器佇列開啟 → 直入瀏覽器佇列(欄位經 browserQueueFields,與此前呼叫端自組者逐欄相同);非瀏覽器類、瀏覽器佇列停用、未給 capture → 回補全文;patchOf 併於其後', async () => {
            const rows = () => [
                { id: 'a', status: 'dead', url: 'https://s.example/a', deadClass: 'http-blocked', fetcher: 'browser', deadAt: '2026-09-01' },
                { id: 'b', status: 'dead', url: 'https://s.example/b', deadClass: 'timeout', deadAt: '2026-09-02' },
                { id: 'c', status: 'dead', url: 'https://s.example/c', deadClass: 'http-final', deadAt: '2026-09-03' },
            ]
            const ON = { browser: { perRun: 12 } }
            const pick = (d) => [d.status, d.fetcher, d.lastClass, d.deferredAt ?? null]
            const run = async (cfg) => {
                const docs = memStore(rows())
                await reviveDeadDocs({ docs }, { match: () => true, nowIso: NOW, fetchTries: 2, ...cfg })
                return Object.fromEntries((await docs.select()).map((d) => [d.id, pick(d)]))
            }
            const auto = await run({ capture: ON })
            assert.deepEqual(auto, { a: ['new', 'browser', 'http-blocked', NOW], b: ['new', 'browser', 'timeout', NOW], c: ['new', '', '', null] }, '判死前已在瀏覽器佇列者(a)亦以本次回收時刻進佇列')
            // 與此前專案工具(src/tools/revive-dead.mjs)自組之 patchOf 逐欄相同
            const legacy = await run({ patchOf: (d) => (ON.browser.perRun > 0 && ['http-blocked', 'timeout'].includes(d.deadClass) ? { fetcher: 'browser', lastClass: d.deadClass, deferredAt: NOW } : null) })
            assert.deepEqual(auto, legacy)
            assert.deepEqual(await run({ capture: { browser: { perRun: 0 } } }), { a: ['new', '', '', null], b: ['new', '', '', null], c: ['new', '', '', null] }, '瀏覽器佇列停用 → 不入(永遠不被消化)')
            assert.deepEqual(await run({}), { a: ['new', '', '', null], b: ['new', '', '', null], c: ['new', '', '', null] }, '未給 capture → 不自動路由')
            assert.deepEqual((await run({ capture: ON, patchOf: () => ({ fetcher: '' }) })).a, ['new', '', 'http-blocked', NOW], 'patchOf 併於自動路由之後')
        })
    })
})
