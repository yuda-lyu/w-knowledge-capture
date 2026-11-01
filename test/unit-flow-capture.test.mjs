// unit-flow-capture.test.mjs — 抓取流程整合測試:以總組裝 createKnowledgeCapture 跑完整抓取物件
//   (hygiene → seedSync → listFetch → detailFetch → docMaintain → expand → areas;孤兒瀏覽器回收於測試組裝一律關閉),
//   網路以本機假站台(固定埠 8826;127.0.0.1 與 127.0.0.2 兩個主機名)取代:rss 抓取器、curl、Readability 正文解析、連結轉錄、feed 探測、
//   **瀏覽器階梯(子行程 CLI＋真系統 Chrome 無頭)**皆為真實路徑,不連外網、不呼叫 AI。
//
// 案號即本檔規格之編號(無 A10):
//   A1  seedSync:種子來源入 sources(id＝sourceId(kind,url)、tier 照種子、enabled)
//   A2  listFetch:真 rss 抓取器經 curl 讀本機 RSS,5 項入庫為 new(id 去重);同來源在 capture.sources.minIntervalMs 內不重抓
//   A3  detailFetch 正文:a1／a2 經 curl＋Readability 成 raw(textFrom article、textLength>0、rawAt、fetchTries 1)
//   A4  detailFetch 標題預篩:預設樣式「^Recent … Links」命中 → 走 links 抓取器轉錄外部連結(同站、短文字、學術索引網域之連結濾除)
//       → 母件 aggregated、子件 new(fromDocId、來源名帶「（轉錄）」)
//   A5  detailFetch feed 退路:全文 404 而 feedText ≥ minFallbackChars(300)→ raw(textFrom feed)
//   A6  detailFetch 決定性失敗:全文 404 且 feedText 太短 → 一輪即 dead(fetchTries＝capture.articles.maxTries、deadAt、lastReason;不進瀏覽器)
//   A7  expand:frontier 之 site 線索 → 真 discoverFeed 讀首頁 <link rel=alternate> 之 feed 並確認為 feed → 登錄 tier 3 來源
//       (origin frontier:site:…)、線索 done;下輪該來源被輪抓,其文章入庫並補全文
//   A8  報告契約:抓取段 summary「來源 N 個、新文件 N、素材 N、轉錄 N、放棄 N｜線索消化 N、新來源 N[｜瀏覽器 N 試 N 成、延後 N]」;
//       各子階段 report.ok 非 false;run.json 落地
//   A9  瀏覽器救回:JS 渲染頁 → curl 只見空殼 → 分流 render → 子行程 CLI 以真 Chrome 無頭渲染 → raw、textFrom browser:playwright-headless
//   A12 健全閘 placeholder:curl 見「Please enable JavaScript…」佔位文(≥300 字)→ 轉瀏覽器 → 渲染後之正文 → raw
//   A13 健全閘 paywall:訂閱牆預告 → 一輪即 dead(lastReason paywall),不進瀏覽器
//   A14 健全閘 mojibake:ISO-8859-1 頁被 curl 以 UTF-8 解碼成亂碼 → 轉瀏覽器 → Chrome 依 charset 正確解碼 → raw
//   A11 兩佇列:capture.browser.perRun 1、兩篇可救 → 一篇瀏覽、一篇延後(fetcher=browser、fetchTries 不變)、同輪新件照常;下一輪延後件經瀏覽器佇列
//       (跨輪階梯前置 curl)救回
//   A15 格式雜訊:文章連結回 API 之 JSON 原文 → 健全閘 format-noise → 轉瀏覽器仍為 JSON → 不落 raw
//   A16 長 feed:契約層不截、記錄層截並記 feed 原長;feed 退路 raw 之 fullLength＝原長;落 raw 即另存
//   A17 本機網路不通:真 netGuard 探測不可達端點 → 網路子階段略過、文件／來源／線索之計次皆不變、WARN「本機網路不通」
//   A8b 執行摘要(run.json)與開工標記(run.start.json)之結構化內容(createKnowledgeCapture 之收尾契約)
//   A8c 日誌契約:真實日誌檔(本流程用套件之真日誌器)之段落完成行與積壓行,以 logContract 之 CAPTURE_LOG_PARSE 解析＝run 報告之數字
//   X1  被擋(HTTP 403):curl 被拒 → 分流 http-blocked → 轉瀏覽器(Camofox 關閉)→ 真 Chrome 救回 → raw
//   X2  暫時性失敗(HTTP 503):重試類(不轉瀏覽器)、計 tries、記時間退避;退避中之下一輪不取、不發請求
//   X3  轉址:別名網址 301 至原文、內容相同 → 同一內容只入庫一次(另一篇記 skip duplicate)
//   X4  feed 格式:Atom(content／summary)與 RSS 之 content:encoded——內文欄優先序、去 HTML 標籤、時間轉 UTC+8
// 前提:本機須安裝 Google Chrome(w-fetch-web 之 Playwright 階以 channel:'chrome' 啟動系統 Chrome);未安裝時 A9／A11／A12／A14／A15／X1 明確失敗並說明。
// 執行:在套件根 npx mocha test/unit-flow-capture.test.mjs(暫存 test/_tmp/flow-*-<pid>,測完即刪)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import { sourceId } from '../src/core/util/records.mjs'
import { clueKey } from '../src/core/stores/frontierPolicy.mjs'
import { normalizeUrl } from '../src/core/util/web.mjs'
import { readRunSummary, readRunStart } from '../src/core/ops/runSummary.mjs'
import { createLogger } from '../src/core/runnerPackage.mjs'
import { docArchiveOf } from '../src/core/stores/docTexts.mjs'
import { CAPTURE_LOG_PARSE } from '../src/logContract.mjs'
import { tmpRoot, removeRoots, resetConceptFold, buildTestCapture, quiet, recLog, subReport, assertSubStagesOk, withStores, byUrl, docAtOf, assertChromeInstalled } from './tools/captureTestKit.mjs'
import { createFakeSite, flowPages, HUGE_FEED, FEED_TAGS, ARTICLE_PHRASE, LATIN1_WORD } from './tools/fakeSite.mjs'

const PORT = 8826 // 固定埠(≥8000、不隨機)
const DEAD_PORT = 8830 // 無行程監聽之埠(A17 之網路探測目標;連線即被拒)
const H1 = `http://127.0.0.1:${PORT}`
const H2 = `http://127.0.0.2:${PORT}` // 轉錄連結須為「外部」主機(同站連結會被濾除),以另一個迴路位址充當

/** 埠上無行程監聽(連線即被拒)才算死埠 */
const portIsDead = (port) => new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' })
    s.once('connect', () => {
        s.destroy()
        resolve(false)
    })
    s.once('error', () => resolve(true))
})

describe('unit-flow-capture', function() {

    const site = createFakeSite({ port: PORT, pages: flowPages({ H1, H2 }) })
    const hits = site.hits
    const roots = []
    const rootOf = (name) => {
        const r = tmpRoot(name)
        roots.push(r)
        return r
    }
    const docAt = docAtOf(H1)
    const feedSeed = (name, feed) => ({ kind: 'rss', tier: 1, name, url: `${H1}/${feed}`, lang: '' })

    before(async () => {
        await site.start()
    })
    after(async () => {
        await site.stop()
        removeRoots(roots)
        resetConceptFold()
    })

    // ── 主流程:兩輪(種子 → 輪抓 → 補全文 → 轉錄 → 探測)──
    describe('主流程(兩輪)', () => {
        const seed = feedSeed('測試科學站', 'feed.xml')
        let root = ''
        let flow = null
        let ai = null
        let rep1 = null

        before(async () => {
            root = rootOf('flow-a')
            // 日誌用套件之真日誌器(每輪一檔、不同步輸出 stdout):A8c 讀真實日誌檔(測試組裝預設為靜音日誌,不落檔)
            ;({ flow, ai } = buildTestCapture(root, { data: { seedSources: [seed] }, logFactory: () => createLogger('run', { dir: flow.info().dirs.log, clock: flow.info().clock, echo: false }) }))
            // 預放一筆 site 線索(A7 之探測對象)
            await withStores(flow, async (stores) => {
                const r = await stores.frontier.insertNew([{ id: clueKey('site', `${H1}/site`), type: 'site', value: `${H1}/site`, why: '測試探測', status: 'pending', hits: 2, addedAt: '2026-09-01T00:00:00+08:00', fromRef: '' }])
                assert.equal(r.addCount, 1)
            })
            const cap = flow.info().settings.capture
            // 規則:套件預設 capture.articles.maxTries 3(core/settingsDefault);A6 之 fetchTries 依此
            assert.equal(cap.articles.maxTries, 3, '本檔 A6 依套件預設 capture.articles.maxTries 3')
            // 規則:測試組裝一律關閉孤兒回收(它掃整台機器之行程;captureTestKit.buildTestCapture)
            assert.equal(cap.browser.hygiene, false, '測試組裝一律關閉孤兒回收')
            rep1 = await flow.run()
        })

        it('A8 報告契約:管線成功、各子階段 ok、抓取段 summary 固定格式、run.json 落地、執行鎖已釋放、不呼叫 AI', () => {
            assertSubStagesOk(rep1, assert)
            // 規則:createKnowledgeCapture 之管線只放抓取物件(stages:[captureObject]),不另附掛其他段
            assert.deepEqual(rep1.stages.map((s) => s.name), ['抓取'])
            const s = rep1.stages[0].result.summary
            // 規則:captureObject.captureSummaryOf 之固定格式為對外契約;放棄(dead,含一輪即終態之 404)計入 stats.fail,summaryOf 於句尾附「｜失敗 N」
            assert.match(s, /^來源 1 個、新文件 5、素材 3、轉錄 2、放棄 1｜線索消化 1、新來源 1｜失敗 1$/, `抓取段 summary 契約：${s}`)
            // 規則:createKnowledgeCapture.run 於管線結束後寫 run.json;執行鎖於管線結束釋放
            assert.ok(rep1.summaryFile && fs.existsSync(rep1.summaryFile), 'run.json 須落地')
            assert.ok(!fs.existsSync(`${root}/tmp/run.lock`), '執行鎖須已釋放')
            // 規則:抓取除領域發現外不得呼叫 AI(本流程無領域候選)
            assert.equal(ai.calls.length, 0, `抓取不得呼叫 AI：${JSON.stringify(ai.calls.map((c) => c.prompt.slice(0, 40)))}`)
        })

        it('A8c 日誌契約(logContract):真實日誌檔之段落完成行與積壓行,以 CAPTURE_LOG_PARSE 解析所得＝run 報告之 newDocs／queued／queuedOldestDays(外部巡檢於 run.json 缺時之退路)', () => {
            const text = fs.readFileSync(rep1.summaryFile.replace(/-run\.json$/, '-run.log'), 'utf8')
            const num = (re) => {
                const m = text.match(re)
                return m ? Number(m[1]) : null
            }
            const lf = subReport(rep1, '抓取', 'listFetch').detail
            const df = subReport(rep1, '抓取', 'detailFetch').detail
            assert.deepEqual([num(CAPTURE_LOG_PARSE.newDocs), num(CAPTURE_LOG_PARSE.queued), num(CAPTURE_LOG_PARSE.queuedDays)], [lf.newDocs, df.queued, df.queuedOldestDays], text.split('\n').filter((l) => /抓取 完成|待抓內文/.test(l)).join('\n'))
        })

        it('A8b run.json 與開工標記:摘要結構化落地(名稱、段、子階段對照、AI 實績)、開工標記先宣告本輪上限且與摘要同一時間戳', () => {
            const sum = readRunSummary(rep1.summaryFile)
            // 規則:core/ops/runSummary 之 readRunSummary 於版本相符時回物件
            assert.ok(sum, 'run.json 須可被 readRunSummary 讀回')
            assert.equal(sum.name, '知識抓取')
            assert.deepEqual(sum.stages.map((x) => x.name), ['抓取'])
            // 規則:摘要之 summary 與 report 同源(buildRunSummary 取 stage.result.summary)
            assert.equal(sum.stages[0].summary, rep1.stages[0].result.summary)
            // 規則:物件 report 之 detail 即各子階段 report 之對照表,摘要之 sub 據此落地(captureObject.objectReport)
            assert.deepEqual(Object.keys(sum.stages[0].sub), ['hygiene', 'seedSync', 'listFetch', 'detailFetch', 'docMaintain', 'expand', 'areas'])
            // 規則:AI 實績為「取走並歸零」,輪末由 buildRunSummary 取一次(替身無呼叫)
            assert.equal(sum.ai.callStats, '無呼叫')
            // 規則:settings.capture.standards.scanEachRun 預設 false——不掃描、摘要不含 standards
            assert.equal(sum.standards, undefined, '預設不做符合度掃描')
            const start = readRunStart(rep1.summaryFile.replace(/-run\.json$/, '-run.start.json'))
            // 規則:每輪開工先寫 run.start.json(createKnowledgeCapture 檔頭【開工標記】),被砍之輪次沒有 run.json 時外部巡檢靠它判界
            assert.ok(start, '開工標記須存在且可讀回')
            assert.deepEqual([start.pid, start.stamp], [process.pid, sum.stamp])
            assert.ok(Number.isFinite(start.deadlineMs) && start.deadlineMs > 0, `開工標記須宣告本輪時間預算：${JSON.stringify(start)}`)
        })

        it('A1 seedSync:種子來源入 sources(id＝sourceId(kind,url)、tier 1、enabled)', async () => {
            await withStores(flow, async (stores) => {
                const src = await stores.sources.get(sourceId('rss', seed.url))
                // 規則:stages/seedSyncStage 之 syncSeeds 以 sourceId(kind,url) 為來源 id 補入種子
                assert.ok(src, '種子來源須以 sourceId(kind,url) 為 id 入庫')
                assert.equal(src.tier, 1)
                assert.equal(src.enabled, true)
                assert.ok(src.lastFetchAt, '輪抓後 lastFetchAt 已記')
                assert.equal(src.okCount, 1)
            })
        })

        it('A2 listFetch:真 rss 抓取器讀本機 RSS,5 項入庫;A3 正文:a1／a2 成 raw(article、有字數、rawAt)', async () => {
            const lf = subReport(rep1, '抓取', 'listFetch')
            // 規則:stages/listFetchStage 之 admitPersist 去重入庫(seen.admit);RSS 共 5 項
            assert.equal(lf.detail.newDocs, 5, `listFetch 新文件 5：${JSON.stringify(lf.detail)}`)
            await withStores(flow, async (stores) => {
                const d = await byUrl(stores)
                for (const p of ['/a1', '/a2']) {
                    const doc = d[normalizeUrl(`${H1}${p}`)]
                    assert.ok(doc, `${p} 須入庫`)
                    // 規則:stages/detailFetchStage 之 persistOutcome 成功落 raw,textFrom＝article(經 Readability 之正文)
                    assert.equal(doc.status, 'raw', `${p} 須為 raw：${doc.status} ${doc.lastError || ''}`)
                    assert.equal(doc.textFrom, 'article')
                    assert.ok(doc.textLength > 500 && doc.text.includes(ARTICLE_PHRASE), `${p} 正文須經 Readability 取得（${doc.textLength} 字）`)
                    assert.equal(doc.fullLength, doc.textLength, '截斷前原長已記（未截斷者相等）')
                    assert.ok(doc.rawAt, 'rawAt 已記')
                    assert.equal(doc.fetchTries, 1)
                }
                assert.ok(hits.includes('/feed.xml') && hits.includes('/a1'), `假站台須被實際請求：${[...new Set(hits)].join(' ')}`)
            })
        })

        it('A4 標題預篩＋連結轉錄:Recent Science Links 母件 aggregated、兩條外部連結成新文件(同站／短文字／學術索引濾除)', async () => {
            const df = subReport(rep1, '抓取', 'detailFetch')
            // 規則:stages/detailFetchStage 之 transcodeLinks 逐連結入庫並計 aggregated;合格連結恰 2 條
            assert.equal(df.detail.aggregated, 2, `轉錄計數：${JSON.stringify(df.detail)}`)
            await withStores(flow, async (stores) => {
                const d = await byUrl(stores)
                const mother = d[normalizeUrl(`${H1}/links`)]
                assert.equal(mother.status, 'aggregated', `母件須為 aggregated：${mother.status}`)
                const kids = (await stores.docs.select()).filter((x) => x.fromDocId === mother.id)
                assert.deepEqual(kids.map((k) => k.url).sort(), [normalizeUrl(`${H2}/x1`), normalizeUrl(`${H2}/x2`)], '只轉錄兩條合格之外部連結')
                for (const k of kids) {
                    assert.equal(k.status, 'new', '子件入庫為 new（下輪補全文）')
                    // 規則:core/util/records.defaultToLinkedRecord 之來源名帶「（轉錄）」
                    assert.match(k.sourceName, /（轉錄）$/)
                    assert.ok(k.title.length >= 20, '連結文字成為子件標題')
                }
                // 規則:fetchers/articleParse.extractLinks 濾除同站連結與學術索引網域
                assert.ok(!d[normalizeUrl(`${H1}/about`)], '同站連結不轉錄')
                assert.ok(!Object.keys(d).some((u) => /scholar\.google/.test(u)), '學術索引網域不轉錄')
            })
        })

        it('A5 feed 退路:全文 404 但 feedText ≥ 300 字且過健全閘 → raw(textFrom feed)', async () => {
            await withStores(flow, async (stores) => {
                const doc = await docAt('/feedonly')(stores)
                // 規則:stages/detailFetchStage 之 feedFallback(feedText 達 minFallbackChars 且過同一健全閘)
                assert.equal(doc.status, 'raw', `feed 退路須成 raw：${doc.status} ${doc.lastError || ''}`)
                assert.equal(doc.textFrom, 'feed')
                assert.ok(doc.textLength >= 300)
            })
        })

        it('A6 決定性失敗:死連結(HTTP 404、feed 太短)一輪即 dead(fetchTries＝3、deadAt、lastReason);不進瀏覽器', async () => {
            const df = subReport(rep1, '抓取', 'detailFetch')
            // 規則:stores/fetchPolicy 之 classifyFetch 判 404 為決定性終態(final),persistOutcome 將 tries 補至 capture.articles.maxTries
            assert.equal(df.detail.finalDead, 1, JSON.stringify(df.detail))
            assert.equal(df.detail.browserTried, 0, '404 不轉瀏覽器')
            await withStores(flow, async (stores) => {
                const dead = await docAt('/dead')(stores)
                assert.deepEqual([dead.status, dead.fetchTries, dead.lastReason], ['dead', 3, 'http-error'])
                assert.ok(dead.deadAt, 'deadAt 已記')
                assert.match(dead.lastError, /HTTP 404/)
            })
        })

        it('A7 expand:site 線索經真 discoverFeed 登錄 tier 3 來源、線索 done', async () => {
            const xp = subReport(rep1, '抓取', 'expand')
            // 規則:stages/expandStage 之 probeSiteFeed(fetchers/articleParse.discoverFeed 讀 <link rel=alternate> 並確認為 feed 才登錄)
            assert.equal(xp.detail.newSources, 1, `探測須登錄 1 個新來源：${JSON.stringify(xp.detail)}`)
            await withStores(flow, async (stores) => {
                const src = await stores.sources.get(sourceId('rss', `${H1}/feed2.xml`))
                assert.ok(src, '探測到之 feed 須登錄為來源')
                assert.equal(src.tier, 3)
                assert.equal(src.origin, `frontier:site:${H1}/site`)
                const clue = await stores.frontier.get(clueKey('site', `${H1}/site`))
                assert.equal(clue.status, 'done', `線索須記為 done：${JSON.stringify(clue)}`)
                assert.ok(hits.includes('/site') && hits.includes('/feed2.xml'), '探測須實際讀首頁與 feed')
            })
        })

        it('第二輪:轉錄子件與探測來源之文章補全文成 raw;種子來源在間隔內不重抓;記錄總數與狀態', async () => {
            const n0 = hits.filter((p) => p === '/feed.xml').length
            const rep2 = await flow.run()
            assertSubStagesOk(rep2, assert)
            // 規則:stores/sourcePolicy 之 pickDueSources 依 capture.sources.minIntervalMs(預設 6 小時)挑到期來源
            assert.equal(hits.filter((p) => p === '/feed.xml').length, n0, '同來源 6 小時內不重抓（capture.sources.minIntervalMs）')
            assert.equal(subReport(rep2, '抓取', 'listFetch').detail.newDocs, 1, '探測來源之 a3 入庫')
            await withStores(flow, async (stores) => {
                const d = await byUrl(stores)
                for (const u of [`${H2}/x1`, `${H2}/x2`, `${H1}/a3`]) {
                    const doc = d[normalizeUrl(u)]
                    assert.equal(doc?.status, 'raw', `${u} 第二輪須補全文成 raw：${doc?.status} ${doc?.lastError || ''}`)
                    assert.equal(doc.textFrom, 'article')
                }
                const all = await stores.docs.select()
                assert.equal(all.filter((x) => x.status === 'raw').length, 6, `兩輪後 raw 共 6 篇（a1、a2、feedonly、x1、x2、a3）：${JSON.stringify(Object.fromEntries(all.map((x) => [x.url, x.status])))}`)
                // 規則:去重身分(identity keyOf raw)使同一網址不重複入庫
                assert.equal(all.length, 8, '記錄總數 8（5 項＋2 轉錄＋1 探測），去重後不重複')
            })
        })
    })

    // ── 瀏覽器分流(真 Chrome 無頭;Camofox 關閉以求確定性)──
    describe('瀏覽器分流(A9／A12／A13／A14)', () => {
        let flow = null
        let rep = null

        before(async () => {
            assertChromeInstalled()
            ;({ flow } = buildTestCapture(rootOf('flow-b'), {
                data: { seedSources: [feedSeed('瀏覽器測試站', 'feed-b.xml')] },
                capture: { browser: { perRun: 12 } }, // Camofox 由測試組裝預設關閉(capture.browser.camofox.enabled false)
            }))
            rep = await flow.run()
        })

        it('A9／A12／A13／A14 第一輪:瀏覽器統計(3 試 3 成)、健全閘計數(paywall 1、mojibake 1)、摘要尾附瀏覽器統計', () => {
            assertSubStagesOk(rep, assert)
            const df = subReport(rep, '抓取', 'detailFetch').detail
            const s = rep.stages[0].result.summary
            // 規則:captureObject.captureSummaryOf 之瀏覽器段只在 >0 時附;付費牆 dead 計入失敗
            assert.match(s, /｜瀏覽器 3 試 3 成、延後 0｜失敗 1$/, `摘要尾附瀏覽器統計（只 >0 時；付費牆 dead 計入失敗）：${s}`)
            assert.deepEqual([df.browserTried, df.browserOk, df.gate.paywall, df.gate.mojibake], [3, 3, 1, 1], `${JSON.stringify(df)}（若 browserOk 為 0 而有環境失敗：本機須安裝 Google Chrome）`)
        })

        it('A9 JS 渲染頁:curl 只見空殼 → 真 Chrome 無頭渲染 → raw、textFrom browser:playwright-headless', async () => {
            await withStores(flow, async (stores) => {
                const d = await docAt('/js1')(stores)
                // 規則:stages/detailFetchStage 之 browserRetry(同輪升級)＋persistOutcome(textFrom browser:<方法>、fetcher 清空)
                assert.deepEqual([d.status, d.textFrom, d.fetcher, d.fetchTries], ['raw', 'browser:playwright-headless', '', 1], d.lastError || '')
                assert.ok(d.text.includes('木衛二冰殼下海洋之瀏覽器渲染正文') && d.textLength > 300, `渲染後之正文：${d.text.slice(0, 80)}`)
            })
        })

        it('A12 健全閘 placeholder:curl 見佔位文(≥300 字)→ 轉瀏覽器 → 渲染後之正文 → raw', async () => {
            await withStores(flow, async (stores) => {
                const d = await docAt('/ph')(stores)
                // 規則:stores/contentGate 之佔位樣式(短正文)判 placeholder,fetchPolicy 分流為 browser/render
                assert.deepEqual([d.status, d.textFrom], ['raw', 'browser:playwright-headless'], d.lastError || '')
                assert.ok(d.text.includes('火星地質研究之瀏覽器渲染正文') && !d.text.includes('Please enable JavaScript'))
            })
        })

        it('A13 健全閘 paywall:訂閱牆預告 → 一輪即 dead(lastReason paywall),不進瀏覽器', async () => {
            await withStores(flow, async (stores) => {
                const d = await docAt('/pw')(stores)
                // 規則:付費牆為終態(瀏覽器無帳號救不回;fetchPolicy.classifyFetch paywall → final),tries 補至 capture.articles.maxTries
                assert.deepEqual([d.status, d.lastReason, d.fetchTries], ['dead', 'paywall', 3])
            })
        })

        it('A14 健全閘 mojibake:ISO-8859-1 頁被 curl 解成亂碼 → 轉瀏覽器 → Chrome 依 charset 正確解碼 → raw', async () => {
            await withStores(flow, async (stores) => {
                const d = await docAt('/mj')(stores)
                // 規則:stores/contentGate 之亂碼判準(U+FFFD 個數與每千字)→ 分流 charset → 瀏覽器依 meta charset 解碼
                assert.deepEqual([d.status, d.textFrom], ['raw', 'browser:playwright-headless'], d.lastError || '')
                assert.ok(d.text.includes(LATIN1_WORD) && !d.text.includes('�'), `正確解碼：${d.text.slice(0, 80)}`)
            })
        })
    })

    // ── 兩佇列(capture.browser.perRun 1)──
    describe('兩佇列(A11)', () => {
        let flow = null
        let r1 = null
        let deferredUrl = ''

        before(async () => {
            assertChromeInstalled()
            ;({ flow } = buildTestCapture(rootOf('flow-c'), {
                data: { seedSources: [feedSeed('配額測試站', 'feed-c.xml')] },
                capture: { browser: { perRun: 1 } },
            }))
            r1 = await flow.run()
        })

        it('A11 第一輪:配額 1、兩篇可救 → 一篇瀏覽、一篇延後(fetcher=browser、tries 不變)、同輪新件照常', async () => {
            assertSubStagesOk(r1, assert)
            const df1 = subReport(r1, '抓取', 'detailFetch').detail
            // 規則:fetchers/browserFetcher.createBrowserRound 之配額;配額用盡之可救件延後至瀏覽器佇列(不計 tries)
            assert.deepEqual([df1.browserTried, df1.browserOk, df1.browserDeferred], [1, 1, 1], JSON.stringify(df1))
            await withStores(flow, async (stores) => {
                const js2 = await docAt('/js2')(stores)
                const js3 = await docAt('/js3')(stores)
                const ok4 = await docAt('/ok4')(stores)
                const [done, deferred] = js2.status === 'raw' ? [js2, js3] : [js3, js2]
                assert.equal(done.status, 'raw')
                assert.deepEqual([deferred.status, deferred.fetcher, deferred.fetchTries, deferred.lastClass, deferred.deferrals], ['new', 'browser', 0, 'render', 1], '延後:不計 tries、標瀏覽器佇列')
                assert.deepEqual([ok4.status, ok4.textFrom], ['raw', 'article'], '同輪新件照常補全文（不被延後件擋）')
                deferredUrl = deferred.url
            })
        })

        it('A11 下一輪:延後件經瀏覽器佇列(跨輪階梯前置 curl)救回', async () => {
            const r2 = await flow.run()
            assertSubStagesOk(r2, assert)
            const df2 = subReport(r2, '抓取', 'detailFetch').detail
            // 規則:stages/detailFetchStage 先補全文再以剩餘配額消化瀏覽器佇列(browserQueued)
            assert.deepEqual([df2.browserTried, df2.browserOk, df2.browserQueued], [1, 1, 1], JSON.stringify(df2))
            await withStores(flow, async (stores) => {
                const d = (await byUrl(stores))[deferredUrl]
                assert.deepEqual([d.status, d.textFrom, d.fetcher], ['raw', 'browser:playwright-headless', ''], d.lastError || '')
            })
        })
    })

    // ── 格式雜訊 ──
    describe('格式雜訊(A15)', () => {
        it('A15 文章連結回 JSON 原文 → 健全閘 format-noise → 轉瀏覽器仍為 JSON → 不落 raw(留瀏覽器佇列或終態),不交下游', async () => {
            assertChromeInstalled()
            const { flow } = buildTestCapture(rootOf('flow-d'), {
                data: { seedSources: [feedSeed('格式雜訊測試站', 'feed-d.xml')] },
                capture: { browser: { perRun: 2 } },
            })
            const r = await flow.run()
            const df = subReport(r, '抓取', 'detailFetch').detail
            // 規則:stores/contentGate 之格式雜訊判準(JSON 原文鍵值密度)——格式未處理乾淨之素材不得被當文章落 raw
            assert.ok((df.gate?.['format-noise'] || 0) >= 1, `健全閘攔下 format-noise：${JSON.stringify(df.gate)}`)
            await withStores(flow, async (stores) => {
                const d = (await byUrl(stores))[normalizeUrl(`${H1}/api.json`)]
                assert.ok(d && d.status !== 'raw' && !d.text, `JSON 原文不得當文章落 raw：${d?.status}／${d?.lastReason}／${String(d?.text || '').slice(0, 60)}`)
            })
        })
    })

    // ── 長 feed ──
    describe('長 feed(A16)', () => {
        it('A16 契約層不截、記錄層截 capture.articles.maxTextChars 並記 feed 原長;全文 404 → feed 退路 raw,fullLength＝原長;落 raw 即另存', async () => {
            const { flow } = buildTestCapture(rootOf('flow-e'), {
                data: { seedSources: [feedSeed('長 feed 測試站', 'feed-e.xml')] },
                capture: { browser: { perRun: 0 } },
            })
            const r = await flow.run()
            assertSubStagesOk(r, assert)
            const max = flow.info().settings.capture.articles.maxTextChars
            assert.ok(HUGE_FEED.length > max, `測試前提：feed 長於 maxTextChars（${HUGE_FEED.length} > ${max}）`)
            await withStores(flow, async (stores) => {
                const d = await docAt('/gone-e')(stores)
                assert.deepEqual([d.status, d.textFrom], ['raw', 'feed'], `${d.status} ${d.lastError || ''}`)
                // 規則:core/util/records.docRecord 記錄層截 feedText 於 capture.articles.maxTextChars,並於被截時記 feedFullLength(契約層 maxTextChars 0 不先截)
                assert.equal(d.feedFullLength, HUGE_FEED.length, 'feed 原長已記(入庫時)')
                // 規則:stages/detailFetchStage 之 feedFallback 以 feedFullLength 為 fullLength
                assert.equal(d.fullLength, HUGE_FEED.length, 'feed 退路之 fullLength＝feed 原長')
                assert.ok(d.feedText.length <= max && d.text.length <= max, '庫內形態仍截 maxTextChars')
                assert.equal(d.feedText.length, max, '被截者恰為 maxTextChars')
                // 規則:落 raw 即另存(core/stores/docTexts.archiveDocText;庫內形態)
                const a = await docArchiveOf(stores, d.id)
                assert.ok(a && a.text === d.text, '落 raw 即另存(庫內形態)')
            })
        })
    })

    // ── 被擋(403)轉瀏覽器與暫時性失敗(503)之退避 ──
    describe('被擋與暫時性失敗(X1／X2)', () => {
        let flow = null
        let rep1 = null

        before(async () => {
            assertChromeInstalled()
            ;({ flow } = buildTestCapture(rootOf('flow-g'), {
                data: { seedSources: [feedSeed('擋與忙測試站', 'feed-g.xml')] },
                capture: { browser: { perRun: 4 } },
            }))
            // w-fetch-web 對 503 之重試訊息直接印到 stdout,不屬受測輸出
            rep1 = await quiet(() => flow.run())
        })

        it('X1 被擋(HTTP 403):curl 被拒 → 分流 http-blocked → 轉瀏覽器(Camofox 關閉,故階梯只有 Playwright)→ 真 Chrome 救回 → raw、textFrom browser:playwright-headless', async () => {
            assertSubStagesOk(rep1, assert)
            const df = subReport(rep1, '抓取', 'detailFetch').detail
            // 規則:stores/fetchPolicy.classifyFetch——401／403 為轉瀏覽器類(http-blocked);ladderFor 於 capture.browser.camofox.enabled=false 時只剩 playwright
            assert.deepEqual([df.browserTried, df.browserOk], [1, 1], `${JSON.stringify(df)}（若 browserOk 為 0 而有環境失敗：本機須安裝 Google Chrome）`)
            await withStores(flow, async (stores) => {
                const d = await docAt('/blocked-page')(stores)
                assert.deepEqual([d.status, d.textFrom, d.fetcher, d.fetchTries], ['raw', 'browser:playwright-headless', '', 1], d.lastError || '')
                assert.ok(d.text.includes('行星環粒徑分布之被擋頁正文'), d.text.slice(0, 80))
            })
            // 規則:captureObject.captureSummaryOf——瀏覽器段與素材計數;暫時性失敗之重試件不計放棄
            assert.match(rep1.stages[0].result.summary, /^來源 1 個、新文件 2、素材 1、轉錄 0、放棄 0｜線索消化 0、新來源 0｜瀏覽器 1 試 1 成、延後 0$/, rep1.stages[0].result.summary)
        })

        it('X2 暫時性失敗(HTTP 503):重試類(不轉瀏覽器)、計一次 tries、仍為 new、記時間退避 retryAt(約 6 小時);退避中之下一輪不取、不發請求、不計次', async () => {
            await withStores(flow, async (stores) => {
                const d = await docAt('/flaky')(stores)
                assert.deepEqual([d.status, d.fetchTries, d.fetcher, d.lastReason], ['new', 1, '', 'http-error'], d.lastError || '')
                // 規則:core/stores/docPolicy.backoffUntil——第 n 次失敗後 capture.articles.retryBackoffHours×4^(n−1) 小時(預設 6 → 6 小時)
                const ms = Date.parse(d.retryAt) - Date.now()
                assert.ok(ms > 5.9 * 3_600_000 && ms < 6.1 * 3_600_000, `retryAt 約 6 小時後：${d.retryAt}`)
            })
            const n0 = hits.filter((p) => p === '/flaky').length
            assert.ok(n0 >= 1, '第一輪須實際請求過')
            const r2 = await quiet(() => flow.run())
            assertSubStagesOk(r2, assert)
            // 規則:stages/detailFetchStage——retryAt 未到者本輪不取(queuedBackoff),到期即回佇列
            assert.equal(subReport(r2, '抓取', 'detailFetch').detail.queuedBackoff, 1)
            assert.equal(hits.filter((p) => p === '/flaky').length, n0, '退避中不發請求')
            await withStores(flow, async (stores) => assert.equal((await docAt('/flaky')(stores)).fetchTries, 1, '退避中不計次'))
        })
    })

    // ── 轉址 ──
    describe('轉址(X3)', () => {
        it('X3 別名網址 301 至原文、內容相同:兩者之一落 raw、另一篇記 skip(duplicate、dupOf 指向對方);不重複入庫', async () => {
            const { flow } = buildTestCapture(rootOf('flow-r'), {
                data: { seedSources: [feedSeed('轉址測試站', 'feed-r.xml')] },
                capture: { browser: { perRun: 0 } },
            })
            const r = await flow.run()
            assertSubStagesOk(r, assert)
            await withStores(flow, async (stores) => {
                const docs = [await docAt('/orig-page')(stores), await docAt('/alias-page')(stores)]
                const raw = docs.filter((d) => d.status === 'raw')
                const skip = docs.filter((d) => d.status === 'skip')
                // 規則:stages/detailFetchStage.persistOutcome(轉址後內容已是既有文件)與 stores/contentIndex(段落重疊)——同一內容只入庫一次(不論處理先後)
                assert.deepEqual([raw.length, skip.length], [1, 1], JSON.stringify(docs.map((d) => [d.url, d.status, d.skipKind, d.lastError])))
                assert.deepEqual([skip[0].skipKind, skip[0].dupOf], ['duplicate', raw[0].id])
                assert.ok(raw[0].text.includes('原文頁之主題句'))
            })
        })
    })

    // ── feed 格式 ──
    describe('feed 格式(X4)', () => {
        it('X4 Atom(content 為跳脫之 HTML／僅 summary)與 RSS 之 content:encoded:全文連結 404 時內文取自 feed(content:encoded > content > summary、去 HTML 標籤),時間轉為 UTC+8', async () => {
            const { flow } = buildTestCapture(rootOf('flow-x'), {
                data: { seedSources: [feedSeed('Atom 測試站', 'feed-atom.xml'), feedSeed('WP 測試站', 'feed-wp.xml')] },
                capture: { browser: { perRun: 0 } },
            })
            const r = await flow.run()
            assertSubStagesOk(r, assert)
            // 規則:feed 內文之取用(w-dwdata-hub fetchRSS withContent)→ docRecord.feedText → stages/detailFetchStage.feedFallback 落 raw
            assert.match(r.stages[0].result.summary, /^來源 2 個、新文件 3、素材 3、轉錄 0、放棄 0｜線索消化 0、新來源 0$/, r.stages[0].result.summary)
            await withStores(flow, async (stores) => {
                const atom1 = await docAt('/gone-atom1')(stores)
                const atom2 = await docAt('/gone-atom2')(stores)
                const wp = await docAt('/gone-wp')(stores)
                for (const d of [atom1, atom2, wp]) {
                    assert.deepEqual([d.status, d.textFrom], ['raw', 'feed'], `${d.url}：${d.status} ${d.lastError || ''}`)
                    assert.ok(!/[<>]/.test(d.text), `內文不得殘留 HTML 標籤：${d.text.slice(0, 60)}`)
                }
                assert.ok(atom1.text.includes(FEED_TAGS.atomContent) && !atom1.text.includes('摘要短'), 'Atom：content 優先於 summary')
                assert.ok(atom2.text.includes(FEED_TAGS.atomSummary), 'Atom：無 content 時取 summary')
                assert.ok(wp.text.includes(FEED_TAGS.wpEncoded) && !wp.text.includes('短描述'), 'RSS：content:encoded 優先於 description')
                // 規則:w-dwdata-hub toDatetimeUTC8——時間一律轉為 UTC+8 之 'YYYY-MM-DD HH:mm:ss'
                assert.deepEqual([atom1.title, atom1.publishedAt, wp.publishedAt], ['Atom 來源之行星大氣文章', '2026-09-27 09:02:03', '2026-09-28 16:00:00'])
            })
        })
    })

    // ── 本機網路不通 ──
    describe('本機網路不通(A17)', () => {
        it('A17 開工探測不通 → 輪抓／補全文／擴充略過(不發請求、來源與文件與線索之計次皆不變)、WARN「本機網路不通」;維護子階段照跑', async () => {
            assert.equal(await portIsDead(DEAD_PORT), true, `測試前提：埠 ${DEAD_PORT} 須無行程監聽`)
            const seed = feedSeed('測試科學站', 'feed.xml')
            const log = recLog()
            // 規則:netGuard 給 undefined 即由套件依 capture.network.probeUrls 建真探測器(測試組裝預設為 null)
            const { flow, ai } = buildTestCapture(rootOf('flow-f'), {
                data: { seedSources: [seed] },
                capture: { network: { probeUrls: [`http://127.0.0.1:${DEAD_PORT}`], probeTimeoutMs: 3000 } },
                netGuard: undefined,
                log,
            })
            await withStores(flow, async (stores) => {
                await stores.docs.insertNew([{ id: 'pre1', url: `${H1}/a1`, status: 'new', fetchTries: 1, collectedAt: '2026-09-01T00:00:00+08:00', title: '預放之待抓件' }])
                await stores.frontier.insertNew([{ id: clueKey('site', `${H1}/site`), type: 'site', value: `${H1}/site`, why: '測試', status: 'pending', hits: 2, tries: 0, addedAt: '2026-09-01T00:00:00+08:00' }])
            })
            const n0 = hits.length
            const r = await flow.run()
            assert.equal(hits.length, n0, '不發任何請求')
            // 規則:各抓取子階段開工前詢問 netGuard(core/util/netGuard.netDownAtStart),不通即略過並於 detail 標 netDown
            for (const sub of ['listFetch', 'detailFetch', 'expand']) assert.equal(subReport(r, '抓取', sub).detail.netDown, true, `${sub} 略過`)
            // 規則:略過時之 detail 仍帶齊固定格式摘要所讀之計數(assertSubStagesOk 亦驗摘要不含 undefined)
            assertSubStagesOk(r, assert)
            assert.match(r.stages[0].result.summary, /^來源 0 個、新文件 0、素材 0、轉錄 0、放棄 0｜線索消化 0、新來源 0/, r.stages[0].result.summary)
            // 規則:WARN 為單行且原因可讀(netGuard.probeFailText 不取 curl 之整串指令)
            assert.ok(log.lines.some((l) => /^WARN 輪抓：本機網路不通（127\.0\.0\.1：不通（連線失敗（curl-error））），本段略過（不計任何對象之失敗）$/.test(l)), log.lines.join('\n'))
            // 規則:網路問題不算在對象頭上——文件、來源、線索之計次皆不變
            await withStores(flow, async (stores) => {
                const d = await stores.docs.get('pre1')
                assert.deepEqual([d.status, d.fetchTries, d.lastError], ['new', 1, undefined], '文件計次不變')
                const src = await stores.sources.get(sourceId('rss', seed.url))
                assert.deepEqual([src.failCount || 0, src.lastFetchAt || ''], [0, ''], '來源計次不變、下輪仍到期')
                const c = await stores.frontier.get(clueKey('site', `${H1}/site`))
                assert.deepEqual([c.status, c.tries], ['pending', 0], '線索計次不變')
            })
            assert.equal(ai.calls.length, 0, '網路不通時亦不呼叫 AI')
        })
    })
})
