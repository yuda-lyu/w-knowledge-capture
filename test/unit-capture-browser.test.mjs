// unit-capture-browser.test.mjs — 多種網站格式之抓取:分流規則(CS3)、正文健全閘(CS1a)、瀏覽器階梯、子行程執行與一輪狀態、補全文子階段之兩佇列
// 不啟動真瀏覽器(fetchWeb／子行程執行器皆注入替身);真瀏覽器之整合驗證屬整合測試
// 執行:自套件根 node <mocha> --timeout 180000 test/unit-capture-browser.test.mjs(暫存 test/_tmp/capture-browser-<pid>,測完即刪)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import merge from 'lodash-es/merge.js'
import W from 'w-data-pipeline/src/WDataPipeline.mjs'
import { memStore } from './tools/memStore.mjs'
import { deepMerge } from './tools/captureTestKit.mjs'
import { recLog } from './tools/testKit.mjs'
import { genClockTZ } from '../src/core/runnerPackage.mjs'
import { classifyFetch, ladderFor, httpCodeOf, isEnvFailure, FINAL_HTTP_CODES, isPdfUrl, browserQueueOn, captureCapacityOf, browserQueueFields, refetchSkipOf, refetchRequestOf } from '../src/stores/fetchPolicy.mjs'
import { createContentGate, mojibakeOf, toPatterns, isSoft404, CONSENT_MARKERS_DEFAULT, isMojibakeText, formatNoiseOf, dedupeText, CONTENT_GATE_V, gateVersionOf, gridAbstractCheck, GATE_DETECTORS_DEFAULT } from '../src/stores/contentGate.mjs'
import { GATE_KINDS, gateDetectorProblems, gateDetectorSpecsOf, adapterSpecsOf, specToUrl, importGateDetectors, importAdapters } from '../src/core/util/injectables.mjs'
import { createCaptureRuntime } from '../src/captureRuntime.mjs'
import { docRecord } from '../src/core/util/records.mjs'
import { runBrowserLadder } from '../src/fetchers/browserLadder.mjs'
import { runBrowserCli, createBrowserRound, ladderTimeoutMs, createBrowserFetcher, BROWSER_CLI } from '../src/fetchers/browserFetcher.mjs'
import { extractLinks } from '../src/fetchers/articleParse.mjs'
import { stageDetailFetch } from '../src/stages/detailFetchStage.mjs'
import { stageDocMaintain } from '../src/stages/docMaintainStage.mjs'
import { judgeFromDocs } from '../src/stages/collectHelpers.mjs'
import { deadMatcher } from '../src/ops/reviveDocs.mjs'
import { paraKeysOf } from '../src/stores/contentIndex.mjs'
import { createHealthGates, planHealthRecheck } from '../src/stores/healthRecheck.mjs'
import { resolveSettings } from '../src/core/settingsDefault.mjs'

const clock = genClockTZ('Asia/Taipei')
const NOW = '2026-10-05T18:00:00+08:00'
const TMP = path.resolve(`test/_tmp/capture-browser-${process.pid}`)
const LONG = (s) => `${s}。本段說明研究設計、樣本期間、交易成本假設與穩健性檢驗之結果。`.repeat(12)
/** U+FFFD(Unicode 取代字元;亂碼之特徵字元) */
const FFFD = '�'
/** UTF-8 之「é」被當 Latin-1 解碼之亂碼(U+00C3 U+00A9) */
const LATIN1_MOJI = 'Ã©'
/** 段落(≥ 60 字)產生器:段落雜湊測試用 */
const PARA = (s) => `${s}之量化研究段落內容說明，`.repeat(6)
/**
 * 深合併語意之集合替身:與正式集合(w-data-pipeline openCollection.patch → w-orm-lmdb save 之 lodash merge)同一語意——陣列逐位置合併
 * (memStore 之 patch 為 Object.assign 整欄取代,測不出殘留舊尾)
 *
 * @param {Array} rows 輸入初始記錄
 * @returns {Object} 回傳集合
 */
function mergeStore(rows = []) {
    const s = memStore(rows)
    s.patch = async (id, fields) => {
        const cur = await s.get(id)
        if (cur) await s.replace(merge({}, cur, fields))
    }
    return s
}

describe('unit-capture-browser', function() {

    before(() => fs.mkdirSync(TMP, { recursive: true }))
    after(() => fs.rmSync(TMP, { recursive: true, force: true }))

    // ── 分流規則 ──
    describe('fetchPolicy(CS3 失敗分流;CS14 PDF)', () => {

        it('classifyFetch:決定性 HTTP／無效網址／付費牆／軟 404／adapter 收攤 → final;429／408／5xx／非內建抓取器／未知 → retry', () => {
            const c = (f) => classifyFetch({ fetcherId: 'article', ...f })
            for (const code of [400, 404, 410, 451]) assert.equal(c({ reason: 'http-error', httpCode: code }).action, 'final', `HTTP ${code}`)
            assert.equal(c({ reason: 'invalid-url' }).action, 'final')
            assert.equal(c({ reason: 'internal-address' }).action, 'final')
            assert.equal(c({ reason: 'paywall' }).action, 'final')
            assert.equal(c({ reason: 'soft-404' }).action, 'final')
            assert.deepEqual(c({ reason: 'empty-content', adapterId: 'msn' }).action, 'final', 'adapter 收攤:瀏覽器階一樣先跑同一 adapter')
            for (const code of [408, 429, 500, 503]) assert.equal(c({ reason: 'http-error', httpCode: code }).action, 'retry', `HTTP ${code}`)
            assert.equal(classifyFetch({ fetcherId: 'myFetcher', reason: 'empty' }).action, 'retry', '自訂抓取器不轉瀏覽器')
            assert.equal(c({ reason: 'weird-new-reason' }).cls, 'unknown')
            assert.equal(c({ reason: 'adapter-error' }).action, 'retry')
            assert.equal(classifyFetch({ ok: true }).action, 'ok')
        })

        it('classifyFetch:401／403、逾時、curl-error、挑戰、轉址、空殼類、亂碼 → browser,各帶類別', () => {
            const c = (f) => classifyFetch({ fetcherId: 'article', ...f })
            assert.deepEqual([c({ reason: 'http-error', httpCode: 403 }).action, c({ reason: 'http-error', httpCode: 403 }).cls], ['browser', 'http-blocked'])
            assert.equal(c({ reason: 'http-error', httpCode: 401 }).cls, 'http-blocked')
            assert.equal(c({ reason: 'timeout' }).cls, 'timeout')
            assert.equal(c({ reason: 'curl-error' }).cls, 'net')
            assert.equal(c({ reason: 'captcha' }).cls, 'challenge')
            assert.equal(c({ reason: 'verify' }).cls, 'challenge')
            assert.equal(c({ reason: 'redirect' }).cls, 'redirect')
            for (const r of ['empty', 'empty-content', 'empty-response', 'parse-error', 'too-short', 'placeholder']) assert.equal(c({ reason: r }).cls, 'render', r)
            assert.equal(c({ reason: 'mojibake' }).cls, 'charset')
            assert.equal(c({ reason: 'http-error', httpCode: 418 }).action, 'final', '其他 4xx 終態')
            assert.ok(FINAL_HTTP_CODES.includes(404))
        })

        it('ladderFor:各類首階依實測(403／逾時 Camofox 先);camofoxEnabled=false 去掉 camofox;跨輪件前置 curl;未知類別回 []', () => {
            assert.deepEqual(ladderFor('http-blocked'), ['camofox', 'playwright'])
            assert.deepEqual(ladderFor('render'), ['playwright', 'camofox'])
            assert.deepEqual(ladderFor('redirect'), ['playwright-redirect', 'camofox'])
            assert.deepEqual(ladderFor('timeout', { camofoxEnabled: false }), ['playwright'])
            assert.deepEqual(ladderFor('render', { crossRound: true }), ['curl', 'playwright', 'camofox'])
            assert.deepEqual(ladderFor('nope', { crossRound: true }), [])
        })

        it('httpCodeOf:數字欄優先;否則自訊息「HTTP 404」或 attempts 末筆取;取不到 0', () => {
            assert.equal(httpCodeOf({ httpCode: 503 }), 503)
            assert.equal(httpCodeOf({ message: 'HTTP 404' }), 404)
            assert.equal(httpCodeOf({ message: 'x', attempts: [{ message: 'HTTP 410' }] }), 410)
            assert.equal(httpCodeOf({ message: 'curl error' }), 0)
        })

        it('isEnvFailure:Camofox 未安裝、Chrome 無法啟動、Camofox server 起不來 → 環境;頁面導航失敗、HTTP → 非環境', () => {
            assert.equal(isEnvFailure({ reason: 'camofox-not-found' }), true)
            assert.equal(isEnvFailure({ reason: 'playwright-error', message: "browserType.launch: Chromium distribution 'chrome' is not found" }), true)
            assert.equal(isEnvFailure({ reason: 'camofox-error', message: 'camofox server failed to start within 30s' }), true)
            assert.equal(isEnvFailure({ reason: 'playwright-error', message: 'page.goto: net::ERR_NAME_NOT_RESOLVED' }), false)
            assert.equal(isEnvFailure({ reason: 'http-error', message: 'HTTP 403' }), false)
        })

        it('瀏覽器佇列之路由(唯一寫法):browserQueueOn 依 capture.browser.perRun > 0;browserQueueFields 進佇列記進佇列時刻,已在佇列者(status new 且 fetcher browser)保留原時刻', () => {
            assert.deepEqual([browserQueueOn({ browser: { perRun: 12 } }), browserQueueOn({ browser: { perRun: 0 } }), browserQueueOn({}), browserQueueOn(null)], [true, false, false, false])
            assert.deepEqual(browserQueueFields({ status: 'raw' }, 'render', NOW), { fetcher: 'browser', lastClass: 'render', deferredAt: NOW })
            assert.deepEqual(browserQueueFields({ status: 'new', fetcher: '' }, 'timeout', NOW), { fetcher: 'browser', lastClass: 'timeout', deferredAt: NOW }, '同輪升級失敗者此刻才進佇列')
            assert.deepEqual(browserQueueFields({ status: 'new', fetcher: 'browser', deferredAt: 'T0' }, 'timeout', NOW), { fetcher: 'browser', lastClass: 'timeout' }, '已在佇列:不重設進佇列時刻')
            assert.deepEqual(browserQueueFields({ status: 'dead', fetcher: 'browser' }, 'http-blocked', NOW), { fetcher: 'browser', lastClass: 'http-blocked', deferredAt: NOW }, '回收之 dead 為新進佇列')
            assert.deepEqual(browserQueueFields(null, undefined, undefined), { fetcher: 'browser', lastClass: '', deferredAt: '' })
        })

        it('captureCapacityOf(抓取之每輪產能與 raw 進料上界之唯一推導):瀏覽器名額計入 raw 進料上界(兩佇列之成者皆入 raw);分流停用時瀏覽器名額為 0 且開關與 browserQueueOn 同一判準;說明文字列出各項', () => {
            const cap = (browser) => ({ articles: { perRun: 90 }, browser: { perRun: browser }, areas: { perRun: 4 }, sources: { itemsPerSource: 8 } })
            const on = captureCapacityOf(cap(12))
            assert.deepEqual([on.articles, on.browser, on.browserOn, on.gridInflowMax, on.rawInflowMax], [90, 12, true, 32, 134], '本專案設定:90＋12＋32')
            assert.equal(on.rawInflowDesc, 'capture.articles.perRun 90＋瀏覽器名額 capture.browser.perRun 12＋grid 直入上界 32＝capture.areas.perRun×capture.sources.itemsPerSource')
            const off = captureCapacityOf(cap(0))
            assert.deepEqual([off.browser, off.browserOn, off.rawInflowMax], [0, false, 122], '停用:瀏覽器名額 0、不計入')
            for (const c of [cap(12), cap(0), cap(3)]) assert.equal(captureCapacityOf(c).browserOn, browserQueueOn(c), '開關即 browserQueueOn')
            assert.deepEqual(captureCapacityOf(null), { articles: 0, browser: 0, browserOn: false, gridInflowMax: 0, rawInflowMax: 0, rawInflowDesc: 'capture.articles.perRun 0＋瀏覽器名額 capture.browser.perRun 0＋grid 直入上界 0＝capture.areas.perRun×capture.sources.itemsPerSource' })
        })

        it('refetchSkipOf(依取得方式排除之方法):article → [curl]、browser:<方法> → [該方法];grid 摘要／feed／adapter／自訂抓取器／未知 → null(不換法重抓)', () => {
            assert.deepEqual(refetchSkipOf({ textFrom: 'article' }), ['curl'])
            assert.deepEqual(refetchSkipOf({ textFrom: 'browser:playwright-headless' }), ['playwright'])
            assert.deepEqual(refetchSkipOf({ textFrom: 'browser:playwright' }), ['playwright'])
            assert.deepEqual(refetchSkipOf({ textFrom: 'browser:camofox' }), ['camofox'])
            assert.deepEqual(refetchSkipOf({ textFrom: 'browser:curl' }), ['curl'])
            for (const textFrom of ['abstract', 'feed', 'adapter:msn', '', 'weird']) assert.equal(refetchSkipOf({ textFrom }), null, textFrom)
            assert.equal(refetchSkipOf({ textFrom: 'article', fetcher: 'myFetcher' }), null, '安裝方指名之自訂抓取器')
            assert.equal(refetchSkipOf(null), null)
        })

        it('refetchRequestOf(下游回報素材壞了之退回):回待抓、進瀏覽器佇列(render)、排除產生素材之方法、lastReason material;瀏覽器佇列停用或不可換法者回 null', () => {
            const o = { capture: { browser: { perRun: 3 } }, nowIso: NOW, note: '摘要回報素材問題（亂碼）：x' }
            assert.deepEqual(refetchRequestOf({ status: 'raw', textFrom: 'article', fetchTries: 2 }, o), {
                status: 'new', fetcher: 'browser', lastClass: 'render', deferredAt: NOW, refetchSkip: ['curl'], lastReason: 'material', lastError: '摘要回報素材問題（亂碼）：x',
            })
            assert.equal(refetchRequestOf({ status: 'raw', textFrom: 'article' }, { ...o, capture: { browser: { perRun: 0 } } }), null, '瀏覽器佇列停用')
            assert.equal(refetchRequestOf({ status: 'raw', textFrom: 'article' }, { nowIso: NOW }), null, '未給抓取設定')
            assert.equal(refetchRequestOf({ status: 'raw', textFrom: 'abstract' }, o), null, '不可換法')
            assert.equal(refetchRequestOf({ status: 'raw', textFrom: 'article' }, 'bad'), null, 'o 非物件視為 {}')
        })
    })

    // ── 正文健全閘 ──
    describe('contentGate(CS1a 正文健全閘)', () => {

        it('過短、U+FFFD 亂碼、UTF-8 被當 Latin-1 之亂碼 → 判出;正常長文 → ok', () => {
            const g = createContentGate({ minTextChars: 300 })
            assert.equal(g.assess({ text: '短文' }).kind, 'too-short')
            assert.equal(g.assess({ text: `${FFFD.repeat(40)}${'a'.repeat(400)}` }).kind, 'mojibake')
            assert.equal(g.assess({ text: `${LATIN1_MOJI.repeat(30)}${'b'.repeat(400)}` }).kind, 'mojibake')
            assert.equal(g.assess({ text: LONG('動量因子回測') }).ok, true)
            assert.equal(mojibakeOf(`ab${FFFD}cd`).count, 1)
        })

        it('佔位樣式只在短正文套用(內容量閘門):短頁「Please enable JavaScript」→ placeholder;長文提到同字樣 → ok', () => {
            const g = createContentGate({ minTextChars: 50 })
            assert.equal(g.assess({ text: `Please enable JavaScript to view this page. ${'x '.repeat(40)}` }).kind, 'placeholder')
            const long = `${LONG('本文討論網頁開發').repeat(3)} 文中提到 please enable JavaScript 之提示語設計。${LONG('並分析其可用性').repeat(3)}`
            assert.ok(long.length > 1500, `${long.length}`)
            assert.equal(g.assess({ text: long }).ok, true, '長文不受弱樣式影響')
        })

        it('付費牆 → paywall;佔位與付費牆皆命中之短頁先判 placeholder(交瀏覽器渲染後再判);adapter 內容豁免樣式(只檢過短與亂碼;CS1b)', () => {
            const g = createContentGate({ minTextChars: 50 })
            assert.equal(g.assess({ text: `This article is for subscribers only. Subscribe now to continue reading. ${'y '.repeat(60)}` }).kind, 'paywall')
            assert.equal(g.assess({ text: `Please enable JavaScript. Subscribe to continue reading. ${'z '.repeat(60)}` }).kind, 'placeholder')
            assert.equal(g.assess({ text: `Please enable JavaScript. ${'z '.repeat(60)}`, adapterId: 'msn' }).ok, true)
            assert.equal(g.assess({ text: '短', adapterId: 'msn' }).kind, 'too-short')
        })

        it('頁面自述找不到(強證據,不受內容量閘門;只看標題與開頭 1,200 字)→ not-found:實測 forbes 404 頁 12,086 字、idahostatesman 之句在第 ~520 字(Camofox 不檢 HTTP 狀態);中文維護頁 → placeholder', () => {
            const g = createContentGate({ minTextChars: 300 })
            const forbes = `Forbes Logo We can't find the page that you are looking for... The URL may be incorrect or the page might have been moved. ${LONG('Trending: other articles').repeat(5)}`
            assert.ok(forbes.length > 3000)
            assert.equal(g.assess({ text: forbes }).kind, 'not-found')
            const idaho = `Log In | ${'menu: menuitem : '.repeat(30)} Oops... Unfortunately, we are unable to locate the page you requested. ${'x '.repeat(200)}`
            assert.ok(idaho.indexOf('unable to locate') > 500)
            assert.equal(g.assess({ text: idaho }).kind, 'not-found')
            assert.equal(g.assess({ text: LONG('正文'), title: '404 Not Found' }).kind, 'not-found')
            const later = `${LONG('本文討論錯誤頁設計').repeat(4)} 文末提到 we can't find the page 之寫法。`
            assert.ok(later.indexOf("we can't") > 1200 && later.length > 1500)
            assert.equal(g.assess({ text: later }).ok, true, '開頭窗之後才出現者不判')
            assert.equal(g.assess({ text: `内容正在升级改造，请稍后再试！ 更多 投资学院 财道社区 名家直播 量化精选 期货大赛 下载APP ${'正文 '.repeat(120)}` }).kind, 'placeholder')
            assert.equal(classifyFetch({ fetcherId: 'article', reason: 'not-found' }).action, 'final')
        })

        it('機器人牆(實際牆頁文字):bloomberg「unusual activity…not a robot」552 字、usnews Akamai「flagged…automated behavior」412 字、nytimes「checking your access」預覽殼 → placeholder;長文提及同字樣不判', () => {
            const g = createContentGate({ minTextChars: 300 })
            const bbg = "Bloomberg We've detected unusual activity from your computer network To continue, please click the box below to let us know you're not a robot. Why did this happen? Please make sure your browser supports JavaScript and cookies and that you are not blocking them from loading. For more information you can review our and . Need Help? For inquiries related to this message please and provide the reference ID below. Block reference ID: 3f2a"
            assert.equal(g.assess({ text: bbg }).kind, 'placeholder')
            const akamai = "Our company keeps high security standards and one of our security tools has flagged this request as exhibiting automated behavior. To protect our platform's integrity, we restrict programmatic access from unauthorized commercial tools. separator If you believe this is an error, please contact Helpdesk or use this . Please provide the URL you were trying, your and this error code: 0.1e29af8b.1791049619.a56382a"
            assert.equal(g.assess({ text: akamai, title: 'Our company keeps high security standards' }).kind, 'placeholder')
            const nyt = `article: Advertisement iframe You have a preview view of this article while we are checking your access. When we have confirmed access, the full article content will load. ${'Share. Save. '.repeat(25)}`
            assert.equal(g.assess({ text: nyt }).kind, 'placeholder')
            const essay = `${LONG('本文討論驗證碼與機器人偵測之設計').repeat(3)} 文中引用 "I'm not a robot" 勾選框與 unusual traffic 偵測之演進。${LONG('並比較各家方案').repeat(3)}`
            assert.ok(essay.length > 1500)
            assert.equal(g.assess({ text: essay }).ok, true, '長文提及同字樣不受弱樣式影響')
        })

        it('同意聲明樣板(cookie／IAB TCF)佔據開頭 → placeholder,不受內容量閘門(實際列印頁 811,911 字);相異標記不足 3 種之正常文章不判', () => {
            const g = createContentGate({ minTextChars: 300 })
            const tcf = `Vendors who are part of the IAB TCF1029Reject allAccept all Branch Metrics, Inc.Legitimate InterestPurposes (Consent): Store and/or access information on a deviceUse limited data to select advertisingCreate profiles for personalised advertisingUse profiles to select personalised advertisingMeasure advertising performance (Data Retention Period: 90 days) ${'Vendor list entry. '.repeat(3000)}`
            assert.ok(tcf.length > 50000)
            const r = g.assess({ text: tcf })
            assert.equal(r.kind, 'placeholder')
            assert.match(r.hit, /^同意聲明樣板/)
            const article = `We use cookies; see our cookie settings or click Accept all. ${LONG('Momentum strategies earn premia across asset classes').repeat(4)}`
            assert.equal(g.assess({ text: article }).ok, true, '只有 2 種標記(Accept all、cookie settings)之正常文章不判')
            assert.equal(CONSENT_MARKERS_DEFAULT.length >= 7, true)
        })

        it('軟 404(轉址至同站首頁)屬健全閘之一類(單一擁有者):須給 url 與 finalUrl;跨站或有路徑／查詢者不判', () => {
            const g = createContentGate({ minTextChars: 300 })
            const text = LONG('首頁新聞列表')
            assert.equal(g.assess({ text, url: 'https://www.ttv.com.tw/finance/view/012/587', finalUrl: 'https://www.ttv.com.tw/' }).kind, 'soft-404')
            assert.equal(g.assess({ text, url: 'https://e.com/a/b', finalUrl: 'https://www.e.com' }).kind, 'soft-404', 'www 與否同站')
            assert.equal(g.assess({ text, url: 'https://e.com/a/b', finalUrl: 'https://other.com/' }).ok, true, '跨站(如包裝頁轉至發布站首頁)不判')
            assert.equal(g.assess({ text, url: 'https://e.com/a/b', finalUrl: 'https://e.com/a/b2' }).ok, true)
            assert.equal(g.assess({ text, url: 'https://e.com/a/b', finalUrl: 'https://e.com/?p=12' }).ok, true, '帶查詢字串者可能是文章')
            assert.equal(g.assess({ text, url: 'https://e.com/', finalUrl: 'https://e.com/' }).ok, true, '原網址即首頁')
            assert.equal(g.assess({ text }).ok, true, '未給 url／finalUrl 不判')
            assert.equal(isSoft404('https://e.com/x', ''), false)
            assert.equal(classifyFetch({ fetcherId: 'browser', reason: 'soft-404' }).action, 'final')
        })

        it('格式雜訊:XML／RSS 原文、JSON 原文、字面標籤密度(feed 雙重跳脫)、逾合理上限 → format-noise;程式碼／公式／表格多之正常頁不判;adapter 內容亦判且分流 final', () => {
            const g = createContentGate({ minTextChars: 300 })
            const rss = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Feed</title>${'<item><title>Momentum strategy notes</title><link>https://e.com/a</link><description>Backtest of momentum with costs</description></item>'.repeat(8)}</channel></rss>`
            assert.equal(g.assess({ text: rss }).kind, 'format-noise')
            const json = `{"data":[${Array.from({ length: 30 }, (_, i) => `{"id":${i},"title":"Factor ${i}","score":0.${i},"tags":["a","b"]}`).join(',')}],"meta":{"count":30,"page":1}}`
            assert.equal(g.assess({ text: json }).kind, 'format-noise')
            const escaped = `${'<p>Momentum portfolios earn premia across markets &amp; asset classes, but crash in rebounds.</p> '.repeat(12)}`
            assert.equal(g.assess({ text: escaped }).kind, 'format-noise', 'feed 雙重跳脫之字面標籤')
            assert.equal(createContentGate({ minTextChars: 10, maxSaneChars: 100 }).assess({ text: LONG('長文') }).kind, 'format-noise', '逾合理上限')
            const code = `${LONG('本文以 Python 實作動量策略')}\n\`\`\`python\ndef momentum(px, lb=252):\n    r = px.pct_change(lb)\n    w = {k: v for k, v in r.items() if v > 0}\n    return w\n\`\`\`\n${LONG('並討論 σ² 與 E[R] 之估計、|t|>2 之顯著性與表格 | 年份 | 報酬 |')}`
            assert.equal(g.assess({ text: code }).ok, true, '程式碼／公式／表格多之正常頁不判')
            const html = `${LONG('網頁抓取之資料處理')} 文中提到 <div> 與 <span> 標籤之差異。${LONG('其餘討論資料清洗')}`
            assert.equal(g.assess({ text: html }).ok, true, '正文偶爾提及標籤不判')
            const ad = g.assess({ text: json, adapterId: 'msn' })
            assert.equal(ad.kind, 'format-noise')
            assert.equal(classifyFetch({ fetcherId: 'article', reason: 'format-noise', adapterId: 'msn' }).action, 'final', 'adapter 回原文結構:站方改版訊號,不換法重抓')
            assert.deepEqual([classifyFetch({ fetcherId: 'article', reason: 'format-noise' }).action, classifyFetch({ fetcherId: 'article', reason: 'format-noise' }).cls], ['browser', 'render'])
            assert.equal(formatNoiseOf('').noisy, false)
        })

        it('dedupeText:完全相同之段落／行(≥40 字)只留首次;短行不動;單行長牆以句去重;非重複內容一字不動', () => {
            const para = '動量因子在十二減一月之形成期下有顯著之超額報酬，但於市場反轉時會出現劇烈回撤，須以波動度縮放控制風險。'
            assert.ok(para.length >= 40)
            const r = dedupeText([para, '短行', '短行', para, '其他不重複之段落內容足夠長，用以確認其一字不動地被保留下來。'].join('\n'))
            assert.equal(r.text, [para, '短行', '短行', '其他不重複之段落內容足夠長，用以確認其一字不動地被保留下來。'].join('\n'))
            assert.equal(r.removed, para.length + 1)
            const sent = 'The momentum factor earns a premium in most markets over long samples. '
            const wall = `${sent}${'Unique sentence number one about volatility scaling and turnover costs. '}${sent}${'x'.repeat(2000)}`
            const w = dedupeText(wall)
            assert.equal(w.text.split(sent).length - 1, 1, '單行長牆:重複句只留首次')
            assert.ok(w.text.includes('Unique sentence number one'))
            assert.deepEqual(dedupeText('無重複').removed, 0)
        })

        it('isMojibakeText 與閘同門檻(個數 ≥10 且每千字 ≥5);isPdfUrl:.pdf 結尾與 arXiv /pdf/<id>,其餘不判(CS14);classifyFetch pdf → final', () => {
            assert.equal(isMojibakeText(`${FFFD.repeat(10)}${'a'.repeat(100)}`), true)
            assert.equal(isMojibakeText(`${FFFD.repeat(9)}${'a'.repeat(100)}`), false, '個數未達 10')
            assert.equal(isMojibakeText(`${FFFD.repeat(10)}${'a'.repeat(5000)}`), false, '每千字未達 5')
            assert.deepEqual(['https://arxiv.org/pdf/2401.12345', 'https://e.com/files/report.PDF?dl=1', 'https://e.com/pdf-guide', 'https://e.com/pdf/landing', 'not a url'].map(isPdfUrl), [true, true, false, false, false])
            assert.deepEqual([classifyFetch({ fetcherId: 'article', reason: 'pdf' }).action, classifyFetch({ fetcherId: 'article', reason: 'pdf' }).cls], ['final', 'pdf'])
            const big = docRecord({ url: 'https://e.com/a', feedText: 'f'.repeat(30) }, { id: 's', name: 'S' }, { maxTextChars: 10 })
            assert.deepEqual([big.feedText.length, big.feedFullLength], [10, 30], 'feed 被截時記原長')
            assert.equal(docRecord({ url: 'https://e.com/a', feedText: 'short' }, { id: 's', name: 'S' }).feedFullLength, undefined)
        })

        it('安裝方追加樣式({p,f} 或 RegExp)接在內建之後;樣式形狀或語法錯誤於建構期拋錯', () => {
            const g = createContentGate({ minTextChars: 10, placeholderPatterns: [{ p: '本站維護中', f: '' }] })
            assert.equal(g.assess({ text: '本站維護中，請稍後再來。'.repeat(3) }).kind, 'placeholder')
            assert.throws(() => toPatterns([{ p: '(' }], 'x'), /x\[0\] 樣式不合法/)
            assert.throws(() => createContentGate({ paywallPatterns: ['abc'] }), /capture\.standards\.paywallPatterns\[0\] 須為 RegExp/)
            assert.throws(() => createContentGate({ placeholderPatterns: [{ p: '(' }] }), /capture\.standards\.placeholderPatterns\[0\] 樣式不合法/)
        })

        it('長度條件用 fullLength(存量之庫內正文已去重、截斷):過短、佔位／付費牆之內容量閘門、逾合理上限皆以原長判;未給 fullLength 即正文長度(即時閘行為不變)', () => {
            const g = createContentGate({ minTextChars: 300 })
            const short = LONG('動量').slice(0, 250)
            // 規則:過短以原長判——去重後 250 字而原長 900 → 不判過短;未給原長 → 照正文判過短
            assert.equal(g.assess({ text: short }).kind, 'too-short')
            assert.equal(g.assess({ text: short, fullLength: 900 }).ok, true)
            // 規則:逾合理上限(300,000)以原長判——庫內截至 20,000 字而原長 400,000 → format-noise
            const r = g.assess({ text: LONG('正常長文'), fullLength: 400_000 })
            assert.deepEqual([r.kind, r.hit], ['format-noise', '原長 400000 字逾合理上限 300000'])
            assert.equal(formatNoiseOf(LONG('x'), { fullLength: 400_000 }).noisy, true)
            // 規則:佔位／付費牆樣式只在正文(原長)< 內容量閘門時套用——原長 5,000 之長文其截斷片段含提示語不判
            const js = `Please enable JavaScript to view this page. ${'x '.repeat(300)}`
            assert.equal(g.assess({ text: js }).kind, 'placeholder')
            assert.equal(g.assess({ text: js, fullLength: 5000 }).ok, true)
            const pw = `Subscribe now to continue reading. ${'y '.repeat(300)}`
            assert.equal(g.assess({ text: pw, fullLength: 2000 }).kind, 'paywall', '原長 2,000 < 3,000 → 照判付費牆')
            assert.equal(g.assess({ text: pw, fullLength: 4000 }).ok, true)
            // 邊界:原長短於正文(不應發生)→ 以正文長度判,不因壞值放寬
            assert.equal(g.assess({ text: short, fullLength: 10 }).kind, 'too-short')
        })

        it('閘之版本 gateVersionOf(CS1a;落 raw 記 healthV):程式版號＋有效參數簽章——同設定同版本;改 minTextChars、minFallbackChars、maxSaneChars 或追加樣式即換版;未給之鍵與給預設值同版', () => {
            const base = { minTextChars: 300, minFallbackChars: 300 }
            const v = gateVersionOf(base)
            assert.match(v, new RegExp(`^${CONTENT_GATE_V}:[0-9a-f]{8}$`))
            assert.equal(gateVersionOf({ ...base }), v)
            assert.equal(gateVersionOf({}), v, '未給之鍵＝預設值(300／300／300,000)')
            assert.notEqual(gateVersionOf({ ...base, minTextChars: 500 }), v)
            assert.notEqual(gateVersionOf({ ...base, minFallbackChars: 200 }), v, 'feed 退路之門檻亦屬閘')
            assert.notEqual(gateVersionOf({ ...base, maxSaneChars: 100_000 }), v)
            assert.notEqual(gateVersionOf({ ...base, placeholderPatterns: [{ p: '本站維護中', f: '' }] }), v)
            assert.equal(gateVersionOf({ ...base, healthRecheckPerRun: 9, paraKeysPerRun: 1, scanEachRun: true }), v, '與閘無關之設定(capture.standards 內之存量工作名額、掃描開關)不換版')
            // 規則:總組裝傳 settings.capture.standards——簽章值不受設定組重組影響(存量不因設定改版而被整批重判)
            assert.equal(gateVersionOf(resolveSettings({}).capture.standards), v, '預設設定之閘版本＝預設參數之閘版本')
        })

        it('偵測器陣列(可注入;整組取代、含順序):內建 GATE_DETECTORS_DEFAULT 之順序與類別固定;給自訂陣列即整組取代;追加＝[...內建, 自訂];換掉某一個＝以 id 篩掉;adapter 未標 true 者對站台 adapter 之正文不套;自訂 hit 缺值以 id 為 hit', () => {
            // 規則:contentGate 檔頭【偵測器陣列(可注入)】、core/util/injectables 檔頭【注入語意】
            assert.deepEqual(GATE_DETECTORS_DEFAULT.map((d) => `${d.id}:${d.kind}`), ['soft-404:soft-404', 'mojibake:mojibake', 'format-noise:format-noise', 'not-found:not-found', 'too-short:too-short', 'consent:placeholder', 'placeholder:placeholder', 'paywall:paywall'])
            assert.ok(GATE_DETECTORS_DEFAULT.every((d) => d.builtin === true && GATE_KINDS.includes(d.kind) && typeof d.test === 'function'))
            assert.deepEqual(createContentGate({}).detectors.map((d) => d.id), GATE_DETECTORS_DEFAULT.map((d) => d.id), '未給＝內建')
            // 整組取代:只給一個付費牆偵測器 → 過短之文不再判 too-short,付費牆短頁照判
            const only = createContentGate({ minTextChars: 300, detectors: [{ id: 'pw', kind: 'paywall', test: (c, env) => (/subscribe/i.test(env.head) ? { hit: 'subscribe' } : null) }] })
            assert.equal(only.assess({ text: 'short' }).ok, true)
            assert.deepEqual(only.assess({ text: 'Subscribe now to continue reading.' }), { ok: false, kind: 'paywall', hit: 'subscribe' })
            // 追加:內建之後加一個牆頁偵測器(env 帶該篇之 text／head／len／lead 與正規化門檻)
            const wall = { id: 'my-wall', kind: 'placeholder', test: (c, env) => (env.len < env.opt.placeholderMaxChars && /本站偵測到異常流量/.test(env.lead(200)) ? { hit: '異常流量牆' } : null) }
            const ext = createContentGate({ minTextChars: 10, detectors: [...GATE_DETECTORS_DEFAULT, wall] })
            assert.deepEqual(ext.assess({ text: '本站偵測到異常流量，完成驗證後繼續瀏覽。'.repeat(2) }), { ok: false, kind: 'placeholder', hit: '異常流量牆' }, '內建樣式皆不命中之牆頁文字由追加之偵測器判')
            assert.equal(ext.assess({ text: LONG('正常') }).ok, true)
            assert.equal(ext.assess({ text: 'short' }).kind, 'too-short', '內建仍在且順序在前')
            // 換掉某一個:以 id 篩掉內建 paywall,放自己的;同一篇由自訂者判
            const swap = createContentGate({ minTextChars: 10, detectors: [...GATE_DETECTORS_DEFAULT.filter((d) => d.id !== 'paywall'), { id: 'paywall2', kind: 'paywall', test: (c, env) => (/會員限定/.test(env.head) ? { hit: '會員限定' } : null) }] })
            assert.equal(swap.assess({ text: 'Subscribe now to continue reading.'.repeat(2) }).ok, true, '內建付費牆樣式已不在')
            assert.deepEqual(swap.assess({ text: '本文為會員限定內容。'.repeat(2) }), { ok: false, kind: 'paywall', hit: '會員限定' })
            // adapter 之正文:未標 adapter:true 者不套;標 true 者套
            const forAdapter = createContentGate({ minTextChars: 10, detectors: [{ id: 'a', kind: 'placeholder', test: () => ({ hit: 'x' }) }, { id: 'b', kind: 'paywall', adapter: true, test: () => ({}) }] })
            assert.deepEqual(forAdapter.assess({ text: 'abc', adapterId: 'site' }), { ok: false, kind: 'paywall', hit: 'b' }, 'adapter 內容跳過 a、由 b 判;hit 缺值以 id 為 hit')
            assert.deepEqual(forAdapter.assess({ text: 'abc' }).kind, 'placeholder')
        })

        it('偵測器契約(core/util/injectables.gateDetectorProblems):非陣列、空陣列、缺 id、id 重複、kind 不在健全閘類別、缺 test 於建構期拋錯;requireModule 時自訂者須帶 module(內建免);閘之簽章只在給自訂陣列時含偵測器之 id 與 sig(改 sig 即換版;只用內建與未給同版)', () => {
            const ok = { id: 'x', kind: 'paywall', test: () => null }
            assert.deepEqual(gateDetectorProblems([ok]), [])
            assert.match(gateDetectorProblems('x')[0], /須為偵測器陣列/)
            assert.match(gateDetectorProblems([])[0], /不可為空/)
            assert.match(gateDetectorProblems([{ kind: 'paywall', test: () => null }])[0], /缺 id/)
            assert.match(gateDetectorProblems([ok, { ...ok }])[0], /重複/)
            assert.match(gateDetectorProblems([{ ...ok, kind: 'wall' }])[0], /不在健全閘類別/)
            assert.match(gateDetectorProblems([{ id: 'x', kind: 'paywall' }])[0], /缺 test 函數/)
            assert.match(gateDetectorProblems([ok], { requireModule: true })[0], /須帶 module/)
            assert.deepEqual(gateDetectorProblems([...GATE_DETECTORS_DEFAULT, { ...ok, module: 'file:///x/y.mjs' }], { requireModule: true }), [], '內建免 module、自訂帶 module 即合')
            assert.throws(() => createContentGate({ detectors: [] }), /capture\.standards\.detectors 不合契約：.*不可為空/)
            assert.throws(() => createContentGate({ detectors: [{ ...ok, kind: 'wall' }] }), /不在健全閘類別/)
            // 簽章與閘版本:未給＝內建＝逐字同版;自訂陣列入 id 與 sig
            const base = { minTextChars: 300, minFallbackChars: 300 }
            const v = gateVersionOf(base)
            assert.equal(gateVersionOf({ ...base, detectors: null }), v)
            assert.equal(createContentGate(base).signature, createContentGate({ ...base, detectors: null }).signature)
            const custom = { ...base, detectors: [...GATE_DETECTORS_DEFAULT, { ...ok, sig: 'v1' }] }
            assert.notEqual(gateVersionOf(custom), v)
            assert.notEqual(gateVersionOf({ ...custom, detectors: [...GATE_DETECTORS_DEFAULT, { ...ok, sig: 'v2' }] }), gateVersionOf(custom), 'sig 改了即換版')
            assert.equal(gateVersionOf({ ...custom, detectors: [...GATE_DETECTORS_DEFAULT, { ...ok, sig: 'v1', test: () => ({ hit: 'other' }) }] }), gateVersionOf(custom), '函數本體不入簽章(以 sig 宣告判準之版本)')
            assert.equal(gateVersionOf({ ...base, detectors: [...GATE_DETECTORS_DEFAULT] }), gateVersionOf({ ...base, detectors: [...GATE_DETECTORS_DEFAULT] }))
        })

        it('跨行程規格與子行程重建(瀏覽器階梯於子行程執行):gateDetectorSpecsOf 內建記 id、自訂記 module／export、null → null;importGateDetectors 依規格重建同一順序(內建以 id 取、自訂 import,匯出為物件或陣列皆可);adapterSpecsOf 只取帶 module 者;載入失敗、匯出缺、id 不符、內建 id 不存在皆拋錯指出哪一件', async () => {
            const modFile = path.join(TMP, 'my-detectors.mjs')
            fs.writeFileSync(modFile, [
                "export default [{ id: 'wall-a', kind: 'placeholder', test: () => ({ hit: 'A' }) }, { id: 'wall-b', kind: 'paywall', test: () => null }]",
                "export const single = { id: 'wall-c', kind: 'paywall', test: () => ({ hit: 'C' }) }",
                "export const adapter = { id: 'site-x', match: /x\\.example/, parse: () => ({ success: false }) }",
            ].join('\n'), 'utf8')
            const modUrl = specToUrl(modFile)
            assert.equal(specToUrl('file:///c:/x/y.mjs'), 'file:///c:/x/y.mjs')
            assert.equal(specToUrl('w-knowledge-capture/src/x.mjs'), 'w-knowledge-capture/src/x.mjs', '套件指定詞原樣')
            assert.ok(modUrl.startsWith('file:///'), '絕對路徑轉 file URL')
            const list = [...GATE_DETECTORS_DEFAULT, { id: 'wall-a', kind: 'placeholder', module: modFile, test: () => null }, { id: 'wall-c', kind: 'paywall', module: modFile, export: 'single', test: () => null }]
            const specs = gateDetectorSpecsOf(list)
            assert.deepEqual(specs.slice(0, 2), [{ id: 'soft-404', builtin: true }, { id: 'mojibake', builtin: true }])
            assert.deepEqual(specs.slice(-2), [{ id: 'wall-a', module: modFile }, { id: 'wall-c', module: modFile, export: 'single' }])
            assert.equal(gateDetectorSpecsOf(null), null)
            const rebuilt = await importGateDetectors(specs, GATE_DETECTORS_DEFAULT)
            assert.deepEqual(rebuilt.map((d) => d.id), list.map((d) => d.id), '順序同規格')
            assert.equal(rebuilt[0], GATE_DETECTORS_DEFAULT[0], '內建以 id 取同一實體')
            assert.deepEqual(rebuilt.at(-2).test(), { hit: 'A' }, '陣列匯出以 id 取')
            assert.deepEqual(rebuilt.at(-1).test(), { hit: 'C' }, '具名匯出之單一物件')
            assert.equal(createContentGate({ minTextChars: 1, detectors: rebuilt }).assess({ text: 'x' }).hit, 'A', '重建之閘可用')
            await assert.rejects(() => importGateDetectors([{ id: 'nope', builtin: true }], GATE_DETECTORS_DEFAULT), /內建偵測器「nope」不存在/)
            await assert.rejects(() => importGateDetectors([{ id: 'wall-z', module: modFile }], GATE_DETECTORS_DEFAULT), /無此 id 之件/)
            await assert.rejects(() => importGateDetectors([{ id: 'wall-c', module: modFile, export: 'nope' }], GATE_DETECTORS_DEFAULT), /無匯出「nope」/)
            await assert.rejects(() => importGateDetectors([{ id: 'wall-a', module: modFile, export: 'single' }], GATE_DETECTORS_DEFAULT), /之 id 為「wall-c」/)
            await assert.rejects(() => importGateDetectors([{ id: 'wall-a', module: path.join(TMP, 'missing.mjs') }], GATE_DETECTORS_DEFAULT), /模組載入失敗/)
            // 站台 adapter:只取帶 module 者;子行程依規格載入
            const adapters = [{ id: 'in-proc', match: /a/, parse: () => ({}) }, { id: 'site-x', match: /x/, parse: () => ({}), module: modFile, export: 'adapter' }]
            assert.deepEqual(adapterSpecsOf(adapters), [{ id: 'site-x', module: modFile, export: 'adapter' }])
            const loaded = await importAdapters(adapterSpecsOf(adapters))
            assert.deepEqual([loaded.length, loaded[0].id, typeof loaded[0].parse], [1, 'site-x', 'function'])
            await assert.rejects(() => importAdapters([{ id: 'site-y', module: modFile, export: 'adapter' }]), /站台 adapter「site-y」/)
        })

        it('總組裝 createCaptureRuntime:自訂偵測器無 module 於啟動期拋錯(子行程載不到 → 兩層之閘不一致);帶 module 者通過且 deps 帶 siteAdapterSpecs(只含帶 module 之 adapter);runBrowserCli 之設定檔帶偵測器規格與 adapter 規格', async () => {
            const det = { id: 'my-wall', kind: 'placeholder', test: () => null }
            assert.throws(() => createCaptureRuntime({ data: { seedSources: [] } }, resolveSettings({ capture: { standards: { detectors: [...GATE_DETECTORS_DEFAULT, det] } } })), /settings\.capture\.standards\.detectors：.*（my-wall）自訂偵測器須帶 module/)
            const settings = resolveSettings({ capture: { standards: { detectors: [...GATE_DETECTORS_DEFAULT, { ...det, module: 'file:///x/my.mjs' }] } } })
            const rt = createCaptureRuntime({ data: { seedSources: [] }, siteAdapters: [{ id: 'p', match: /p/, parse: () => ({}) }, { id: 'q', match: /q/, parse: () => ({}), module: 'file:///x/q.mjs' }] }, settings)
            assert.deepEqual(rt.siteAdapterSpecs, [{ id: 'q', module: 'file:///x/q.mjs' }])
            assert.deepEqual(rt.deps({ docs: memStore([]) }, recLog()).siteAdapterSpecs, [{ id: 'q', module: 'file:///x/q.mjs' }])
            let seen = null
            await runBrowserCli('https://e.com/a', ['playwright'], { capture: settings.capture, tmpDir: TMP, tag: 'doc2', adapterSpecs: rt.siteAdapterSpecs, runCli: async (o) => {
                seen = JSON.parse(fs.readFileSync(o.args[1], 'utf8'))
                return { status: 'error', reason: 'browser-env', message: 'x', final: false, envBroken: [], steps: [] }
            } })
            assert.deepEqual(seen.gate.detectorSpecs.at(-1), { id: 'my-wall', module: 'file:///x/my.mjs' })
            assert.equal(seen.gate.detectorSpecs.length, GATE_DETECTORS_DEFAULT.length + 1)
            assert.deepEqual(seen.adapterSpecs, [{ id: 'q', module: 'file:///x/q.mjs' }])
        })

        it('grid 摘要判準 gridAbstractCheck(CS1d;readGrid 入庫前與存量重判同一函數):< 250 字 → too-short;亂碼 → mojibake;佔位樣式不套(論文摘要只會誤殺)', () => {
            const ab = 'Momentum strategies earn excess returns across asset classes and survive transaction costs. '.repeat(4)
            assert.deepEqual(gridAbstractCheck(ab), { ok: true, kind: '', hit: '' })
            assert.equal(gridAbstractCheck(ab.slice(0, 249)).kind, 'too-short')
            assert.equal(gridAbstractCheck(ab.slice(0, 250)).ok, true, '恰 250 字合格(邊界)')
            assert.equal(gridAbstractCheck(`${FFFD.repeat(20)}${ab}`).kind, 'mojibake')
            assert.equal(gridAbstractCheck(`Please enable JavaScript. ${ab}`).ok, true)
        })
    })

    // ── 檢定標準 CS1a:存量 raw 依閘版本重驗(判定與分流之單一實作 stores/healthRecheck)──
    describe('healthRecheck(CS1a 存量依閘版本重驗)', () => {
        const cap = { minTextChars: 300, minFallbackChars: 200 } // capture.standards 之閘參數
        const gates = createHealthGates(cap)
        const OK = LONG('動量因子之回測研究')
        const plan = (d) => planHealthRecheck({ id: 'x', title: '動量因子之回測研究', url: 'https://site.example/a/b', fetchTries: 1, ...d }, gates, { nowIso: NOW, maxFetchTries: 3 })
        const BOT = "Bloomberg We've detected unusual activity from your computer network To continue, please click the box below to let us know you're not a robot. Why did this happen? Please make sure your browser supports JavaScript and cookies and that you are not blocking them from loading. For more information you can review our and . Need Help? For inquiries related to this message please and provide the reference ID below. Block reference ID: 3f2a"

        it('article／browser:完整閘(含軟 404);合格 → 只記現版;過短 → 瀏覽器佇列(render);軟 404 → 終態;逾合理上限以原長判;瀏覽器所得之牆頁 → 沿原類別留瀏覽器佇列;付費牆 → 終態', () => {
            assert.deepEqual(plan({ textFrom: 'article', text: OK }), { status: 'pass', entry: 'article', patch: { healthV: gates.version } })
            // 規則:不合格依既有分流(fetchPolicy.classifyFetch)——too-short → browser／render;改分流者不動 fetchTries、清 paraKeys
            const ts = plan({ textFrom: 'article', text: 'Loading…', fullLength: 8, paraKeys: ['p'] })
            assert.deepEqual([ts.status, ts.kind, ts.route.action, ts.route.cls], ['violation', 'too-short', 'browser', 'render'])
            assert.deepEqual(ts.patch, { lastReason: 'too-short', lastError: `健全閘重判（版本 ${gates.version}）：正文 8 字，低於 300`, paraKeys: null, healthRecheckedAt: NOW, status: 'new', fetcher: 'browser', lastClass: 'render', deferredAt: NOW })
            // 規則:長度條件用 fullLength——去重後 250 字而原長 900 者合格
            assert.equal(plan({ textFrom: 'article', text: OK.slice(0, 250), fullLength: 900 }).status, 'pass')
            // 規則:軟 404(url＋finalUrl)→ 終態;fetchTries 補至 maxFetchTries
            const s404 = plan({ textFrom: 'article', text: OK, finalUrl: 'https://site.example/' })
            assert.deepEqual([s404.kind, s404.route.action, s404.patch.status, s404.patch.fetchTries, s404.patch.deadAt], ['soft-404', 'final', 'dead', 3, NOW])
            assert.equal(plan({ textFrom: 'article', text: OK, fullLength: 400_000 }).kind, 'format-noise')
            const wall = plan({ textFrom: 'browser:camofox', text: BOT, lastClass: 'http-blocked' })
            assert.deepEqual([wall.kind, wall.route.action, wall.patch.status, wall.patch.fetcher, wall.patch.lastClass], ['placeholder', 'browser', 'new', 'browser', 'http-blocked'])
            const pay = plan({ textFrom: 'browser:playwright-headless', text: `Subscribe now to continue reading. ${'q '.repeat(300)}` })
            assert.deepEqual([pay.kind, pay.route.action, pay.patch.status], ['paywall', 'final', 'dead'])
        })

        it('adapter(CS1b):豁免佔位／付費牆樣式(只檢過短、亂碼、格式雜訊),不合格 → 終態(adapter 收攤);feed(CS1c):門檻 minFallbackChars,不合格 → 交回補全文佇列重抓;grid(CS1d):只擋過短與亂碼', () => {
            assert.equal(plan({ textFrom: 'adapter:msn', text: `Please enable JavaScript. ${'z '.repeat(200)}` }).status, 'pass', 'adapter 內容豁免樣式')
            const ad = plan({ textFrom: 'adapter:msn', text: '短' })
            assert.deepEqual([ad.kind, ad.route.action, ad.route.cls, ad.patch.status], ['too-short', 'final', 'adapter', 'dead'])
            // 規則:feed 之門檻＝minFallbackChars(200)——250 字於正文閘(300)不合格、於 feed 合格
            assert.equal(plan({ textFrom: 'feed', text: OK.slice(0, 250), fullLength: 250 }).status, 'pass')
            assert.equal(plan({ textFrom: 'article', text: OK.slice(0, 250), fullLength: 250 }).kind, 'too-short')
            const fd = plan({ textFrom: 'feed', text: BOT, fetcher: '' })
            assert.deepEqual([fd.kind, fd.route.action, fd.patch.status, fd.patch.fetcher], ['placeholder', 'refetch', 'new', ''])
            const ab = 'Momentum strategies earn excess returns across asset classes and survive transaction costs. '.repeat(4)
            assert.equal(plan({ textFrom: 'abstract', text: `Please enable JavaScript. ${ab}` }).status, 'pass', 'grid 不套佔位樣式')
            const gs = plan({ textFrom: 'abstract', text: ab.slice(0, 200) })
            assert.deepEqual([gs.kind, gs.route.action, gs.route.cls], ['too-short', 'browser', 'render'])
            assert.deepEqual([plan({ textFrom: 'abstract', text: `${FFFD.repeat(30)}${ab}` }).route.cls], ['charset'])
        })

        it('抓取器明示豁免 → 不適用(只記現版);自訂抓取器之正文不合格 → 重試(沿原路由,fetcher 不動;CS1e);入口不明、庫內無原文 → 未能判定(不動,無 patch)', () => {
            assert.deepEqual(plan({ textFrom: 'article', text: 'x', gateExempt: true }), { status: 'na', entry: 'exempt', why: '抓取器明示豁免健全閘（gateExempt）', patch: { healthV: gates.version } })
            const cu = plan({ textFrom: 'article', text: 'Loading…', fetcher: 'mysite' })
            assert.deepEqual([cu.route.action, cu.patch.status, 'fetcher' in cu.patch, 'fetchTries' in cu.patch], ['retry', 'new', false, false])
            const unk = plan({ textFrom: '', text: OK })
            assert.deepEqual([unk.status, unk.why, unk.patch], ['undetermined', '入口不明（textFrom「」）', undefined])
            const nt = plan({ textFrom: 'article', text: '   ' })
            assert.deepEqual([nt.status, nt.why, nt.patch], ['undetermined', '庫內無原文', undefined])
            assert.throws(() => planHealthRecheck({}, null), /需要 gates/)
        })

        it('抓取維護 docMaintain.recheckHealth:raw 之 healthV 不同於現版者依 rawAt 先後重判並寫回;現版者不重判;未能判定者記入報告(附 id)不動、不佔名額;每輪寫入上限;日誌彙總一行＋改分流逐篇一行', async () => {
            const settings = resolveSettings({ capture: { standards: { minTextChars: 300, minFallbackChars: 300 } } })
            const cur = gateVersionOf(settings.capture.standards)
            const docs = memStore([
                { id: 'ok', status: 'raw', textFrom: 'article', text: LONG('正文'), rawAt: '2026-10-01', title: 'A', url: 'https://s.example/a/1' },
                { id: 'bad', status: 'raw', textFrom: 'article', text: 'Loading…', fullLength: 8, rawAt: '2026-10-02', fetchTries: 1, title: 'B', url: 'https://s.example/a/2', paraKeys: ['p'] },
                { id: 'cur', status: 'raw', textFrom: 'article', text: 'x', healthV: cur, rawAt: '2026-09-01' },
                { id: 'nt', status: 'raw', textFrom: 'article', text: '', rawAt: '2026-09-02' },
                { id: 'old', status: 'raw', textFrom: 'article', text: LONG('舊'), healthV: '0:deadbeef', rawAt: '2026-10-03', title: 'C', url: 'https://s.example/a/3' },
            ])
            const log = recLog()
            const deps = { stores: { docs, docTexts: memStore() }, settings, clock: { iso8: () => NOW } }
            const r = await stageDocMaintain({ healthRecheckPerRun: 2, terminalStatuses: [] }).run({ deps, log })
            // 規則:合格 → 記現版;不合格 → 既有分流;現版者(即使內容不合格)不重判;無原文 → 未能判定、不動
            assert.equal((await docs.get('ok')).healthV, cur)
            const bad = await docs.get('bad')
            assert.deepEqual([bad.status, bad.fetcher, bad.lastClass, bad.fetchTries, bad.paraKeys, bad.lastReason], ['new', 'browser', 'render', 1, null, 'too-short'])
            assert.deepEqual([(await docs.get('cur')).status, (await docs.get('nt')).status, (await docs.get('nt')).healthV], ['raw', 'raw', undefined])
            // 規則:每輪寫入上限 2(未能判定者不佔名額)→ old 留下輪
            assert.equal((await docs.get('old')).healthV, '0:deadbeef')
            // dead:內容類 dead 依版重判(本案無此類 dead)
            assert.deepEqual(r.detail.health, { version: cur, due: 4, passed: 1, na: 0, routed: { final: 0, browser: 1, refetch: 0, retry: 0 }, dead: { due: 0, revived: 0, kept: 0 }, undetermined: 1, undeterminedIds: [{ id: 'nt', why: '庫內無原文' }], left: 1 })
            assert.ok(log.lines.some((l) => l === `INFO 健全閘存量重判（版本 ${cur}）：應重判 4、合格 1、不適用 0、改分流 1（終態 0、瀏覽器佇列 1、補全文佇列 0）、未能判定 1（nt：庫內無原文）、留下輪 1`), log.lines.join('\n'))
            assert.ok(log.lines.some((l) => /^INFO 內文\[B\] 健全閘重判（版本 .+）判 too-short（正文 8 字，低於 300）→ 瀏覽器佇列$/.test(l)), log.lines.join('\n'))
            // 下一輪:留下者續判;未能判定者照列(直到處置)
            const r2 = await stageDocMaintain({ healthRecheckPerRun: 2, terminalStatuses: [] }).run({ deps, log })
            assert.deepEqual([r2.detail.health.due, r2.detail.health.passed, r2.detail.health.undetermined, r2.detail.health.left], [2, 1, 1, 0])
            assert.equal((await docs.get('old')).healthV, cur)
        })

        it('抓取維護之每輪名額取自設定 capture.standards.healthRecheckPerRun(子階段 opt 優先於設定);重判之判死門檻取 capture.articles.maxTries', async () => {
            const mk = (rows) => memStore(rows.map((i) => ({ id: `h${i}`, status: 'raw', textFrom: 'article', text: 'Loading…', fullLength: 8, rawAt: `2026-10-0${i}`, title: `T${i}`, url: `https://s.example/a/${i}`, fetchTries: 1 })))
            // 設定 healthRecheckPerRun 1 → 本輪只寫入 1 篇、其餘留下輪
            const docs = mk([1, 2, 3])
            const settings = resolveSettings({ capture: { standards: { healthRecheckPerRun: 1 } } })
            const r = await stageDocMaintain({ terminalStatuses: [] }).run({ deps: { stores: { docs, docTexts: memStore() }, settings, clock: { iso8: () => NOW } }, log: recLog() })
            assert.deepEqual([r.detail.health.due, r.detail.health.left], [3, 2])
            // 子階段 opt 優先於設定
            const docs2 = mk([1, 2, 3])
            const r2 = await stageDocMaintain({ healthRecheckPerRun: 2, terminalStatuses: [] }).run({ deps: { stores: { docs: docs2, docTexts: memStore() }, settings, clock: { iso8: () => NOW } }, log: recLog() })
            assert.deepEqual([r2.detail.health.due, r2.detail.health.left], [3, 1])
            // 軟 404 終態之 fetchTries 補至 capture.articles.maxTries
            const docs3 = memStore([{ id: 's', status: 'raw', textFrom: 'article', text: LONG('正文'), finalUrl: 'https://s.example/', rawAt: '2026-10-01', title: 'T', url: 'https://s.example/a/1', fetchTries: 1 }])
            await stageDocMaintain({ terminalStatuses: [] }).run({ deps: { stores: { docs: docs3, docTexts: memStore() }, settings: resolveSettings({ capture: { articles: { maxTries: 5 } } }), clock: { iso8: () => NOW } }, log: recLog() })
            const s = await docs3.get('s')
            assert.deepEqual([s.status, s.fetchTries], ['dead', 5])
        })

        it('時間預算截止(整輪軟性截止已到)→ 重判與段落雜湊補算皆不寫入、全數留下輪(不腰斬於半途、不漏記 left)', async () => {
            const docs = memStore([
                { id: 'r1', status: 'raw', textFrom: 'article', text: 'Loading…', rawAt: '2026-10-01' },
                { id: 'n1', status: 'noted', notedAt: '2026-10-01', text: LONG('正文') },
            ])
            const deps = { stores: { docs, docTexts: memStore() }, settings: resolveSettings({ capture: { standards: cap } }), clock: { iso8: () => NOW } }
            const r = await stageDocMaintain({ terminalStatuses: [] }).run({ deps, log: recLog(), remainingMs: () => 0, expired: () => true })
            assert.deepEqual([r.detail.health.due, r.detail.health.left, r.detail.paraKeys.due, r.detail.paraKeys.left], [1, 1, 1, 1])
            assert.deepEqual([(await docs.get('r1')).status, (await docs.get('n1')).paraKeys], ['raw', undefined])
        })
    })

    // ── 瀏覽器階梯(fetchWeb 替身) ──
    describe('runBrowserLadder(CS3 瀏覽器階梯)', () => {
        const gate = createContentGate({ minTextChars: 100 })
        const ok = (method, text = LONG('救回之正文')) => ({ status: 'success', method, content: text, title: 'T' })
        const fail = (reason, message = '') => ({ status: 'error', reason, message })

        it('任一階成功即停;每階一律 maxRetries:0;camofox 帶專屬埠;playwright-redirect 帶 waitForRedirect', async () => {
            const calls = []
            const fetchWeb = async (url, o) => {
                calls.push(o)
                return o.method === 'playwright' ? ok('playwright-headless') : fail('camofox-empty')
            }
            const r = await runBrowserLadder('https://e.com/a', ['camofox', 'playwright-redirect', 'curl'], { fetchWeb, gate, stepOpts: { camofoxPort: 19417, navigationTimeoutMs: 20000 } })
            assert.equal(r.status, 'success')
            assert.equal(r.method, 'playwright-headless')
            assert.deepEqual(calls.map((o) => o.method), ['camofox', 'playwright'], '成功後不再跑 curl')
            assert.ok(calls.every((o) => o.maxRetries === 0))
            assert.equal(calls[0].port, 19417)
            assert.equal(calls[1].waitForRedirect, true)
        })

        it('成功但未過健全閘(生產門檻 300 字下之 268 字封鎖樣板)→ 視同該階失敗續走;付費牆即停(final);決定性 HTTP 即停(final)', async () => {
            const seq = [ok('camofox', 'x'.repeat(268)), ok('playwright-headless')]
            const r = await runBrowserLadder('https://e.com/a', ['camofox', 'playwright'], { fetchWeb: async () => seq.shift(), gate: createContentGate({ minTextChars: 300 }) })
            assert.equal(r.status, 'success')
            assert.equal(r.steps[0].gate, 'too-short')
            const pw = await runBrowserLadder('https://e.com/b', ['playwright', 'camofox'], { fetchWeb: async () => ok('playwright-headless', `Subscribe now to continue reading. ${'q '.repeat(80)}`), gate })
            assert.deepEqual([pw.status, pw.reason, pw.final, pw.steps.length], ['error', 'paywall', true, 1])
            const nf = await runBrowserLadder('https://e.com/c', ['playwright', 'camofox'], { fetchWeb: async () => fail('http-error', 'HTTP 404'), gate })
            assert.deepEqual([nf.final, nf.httpCode, nf.steps.length], [true, 404, 1])
            // 轉址至同站首頁(軟 404;例如 ttv.com.tw 經 playwright-redirect 得首頁新聞列表 4,118 字)→ 即停(final),不換階
            const home = await runBrowserLadder('https://www.ttv.com.tw/finance/view/012/587', ['playwright-redirect', 'camofox'], {
                fetchWeb: async () => ({ ...ok('playwright-headless'), finalUrl: 'https://www.ttv.com.tw/' }),
                gate,
            })
            assert.deepEqual([home.status, home.reason, home.final, home.steps.length], ['error', 'soft-404', true, 1])
        })

        it('環境失敗只斷該方法並續走下一階(不算頁面失敗);全部階皆斷 → reason browser-env;已斷之方法直接略過', async () => {
            const r = await runBrowserLadder('https://e.com/a', ['camofox', 'playwright'], {
                fetchWeb: async (u, o) => (o.method === 'camofox' ? fail('camofox-not-found') : ok('playwright-headless')),
                gate,
            })
            assert.deepEqual([r.status, r.envBroken], ['success', ['camofox']])
            const all = await runBrowserLadder('https://e.com/a', ['camofox', 'playwright'], {
                fetchWeb: async (u, o) => (o.method === 'camofox' ? fail('camofox-not-found') : fail('playwright-error', 'browserType.launch: Executable doesn\'t exist')),
                gate,
            })
            assert.deepEqual([all.reason, all.envBroken.sort()], ['browser-env', ['camofox', 'playwright']])
            let n = 0
            const sk = await runBrowserLadder('https://e.com/a', ['playwright'], { fetchWeb: async () => { n++; return ok('x') }, gate, skip: ['playwright'] })
            assert.deepEqual([sk.reason, n], ['browser-env', 0])
        })

        it('頁面失敗走完階梯 → 回最後一階之歸因(非 final);fetchWeb 拋錯視為 fetcher-error', async () => {
            const r = await runBrowserLadder('https://e.com/a', ['playwright', 'camofox'], {
                fetchWeb: async (u, o) => {
                    if (o.method === 'playwright') throw new Error('boom')
                    return fail('camofox-empty', 'camofox snapshot empty (12 chars)')
                },
                gate,
            })
            assert.deepEqual([r.status, r.reason, r.final], ['error', 'camofox-empty', false])
            assert.equal(r.steps[0].reason, 'fetcher-error')
            await assert.rejects(() => runBrowserLadder('u', [], {}), /需要 opt\.fetchWeb 與 opt\.gate/)
        })
    })

    // ── 子行程執行與一輪狀態 ──
    describe('runBrowserCli／createBrowserRound(CS3 環境失敗不計次)', () => {
        // settings.capture:瀏覽器組(導航逾時、Camofox 埠、每輪篇數與時間)與正文閘之參數(standards)
        const cap = resolveSettings({ capture: { browser: { navTimeoutMs: 20000, perRun: 2, maxMs: 60000, camofox: { port: 19417 } }, standards: { minTextChars: 300 } } }).capture

        it('runBrowserCli:以 process.execPath 執行本套件 CLI,設定檔帶階梯與健全閘(取自 capture.standards);結果原樣回傳;暫存檔讀回即刪', async () => {
            let seen = null
            const r = await runBrowserCli('https://e.com/a', ['playwright'], {
                capture: cap,
                tmpDir: TMP,
                tag: 'doc1',
                runCli: async (o) => {
                    seen = { ...o, opts: JSON.parse(fs.readFileSync(o.args[1], 'utf8')) }
                    return { status: 'success', content: LONG('x'), title: 'T', method: 'playwright-headless', envBroken: [], steps: [{ step: 'playwright', ok: true }] }
                },
            })
            assert.equal(r.status, 'success')
            assert.equal(seen.exe, process.execPath)
            assert.equal(seen.script, BROWSER_CLI)
            assert.equal(seen.args[0], 'https://e.com/a')
            assert.deepEqual(seen.opts.steps, ['playwright'])
            assert.deepEqual(seen.opts.gate, { minTextChars: 300, placeholderPatterns: [], paywallPatterns: [], maxSaneChars: 300_000, detectorSpecs: null }, '子行程之閘與管線內同一組參數(capture.standards 之四鍵)＋偵測器規格(null＝內建)')
            assert.deepEqual(seen.opts.adapterSpecs, [], '未注入帶 module 之站台 adapter 即空')
            assert.equal(seen.opts.stepOpts.camofoxPort, 19417, 'capture.browser.camofox.port')
            assert.equal(seen.opts.stepOpts.navigationTimeoutMs, 20000, 'capture.browser.navTimeoutMs')
            assert.equal(seen.timeoutMs, ladderTimeoutMs(['playwright'], cap))
            assert.deepEqual(fs.readdirSync(path.join(TMP, 'browser')), [], '暫存檔已刪')
        })

        it('runBrowserCli:子行程逾時 → cli-timeout(頁面失敗);其餘子行程層失敗(找不到 node、CLI 拋錯)→ browser-env(環境失敗)', async () => {
            const t = await runBrowserCli('https://e.com/a', ['camofox'], { capture: cap, tmpDir: TMP, runCli: async () => ({ status: 'error', message: 'TIMEOUT after 130s' }) })
            assert.equal(t.reason, 'cli-timeout')
            const e = await runBrowserCli('https://e.com/a', ['camofox'], { capture: cap, tmpDir: TMP, runCli: async () => ({ status: 'error', message: 'ENOENT: spawn node' }) })
            assert.equal(e.reason, 'browser-env')
            const x = await runBrowserCli('https://e.com/a', ['camofox'], { capture: cap, tmpDir: TMP, runCli: async () => { throw new Error('boom') } })
            assert.equal(x.reason, 'browser-env')
        })

        it('ladderTimeoutMs:隨階數遞增,camofox 階最重(涵蓋 server 啟動＋快照＋關 tab)', () => {
            const a = ladderTimeoutMs(['playwright'], cap)
            const b = ladderTimeoutMs(['playwright', 'camofox'], cap)
            const c = ladderTimeoutMs(['curl', 'playwright', 'camofox'], cap)
            assert.ok(a < b && b < c, `${a} ${b} ${c}`)
            assert.ok(b - a > 60_000, 'camofox 階最壞逾 60 秒')
        })

        it('createBrowserRound:配額、軟性時間上限、方法斷路、整輪剩餘不足皆不可開工;account 依結果記斷路與統計', () => {
            let now = 0
            let remaining = 10_000_000
            const round = createBrowserRound(cap, { now: () => now, remainingMs: () => remaining })
            assert.equal(round.canStart(['playwright']), true)
            round.take()
            round.account({ status: 'error', reason: 'browser-env', envBroken: ['playwright'] })
            assert.equal(round.canStart(['playwright']), false, 'playwright 已斷路')
            assert.equal(round.canStart(['curl', 'playwright']), false, '只剩 curl 不算可走瀏覽器')
            assert.equal(round.canStart(['camofox']), true)
            round.take()
            assert.equal(round.canStart(['camofox']), false, '配額 2 已用完')
            const r2 = createBrowserRound(cap, { now: () => now, remainingMs: () => remaining })
            now = 60_000
            assert.equal(r2.timeUp(), true)
            assert.equal(r2.canStart(['playwright']), false, '逾軟性時間上限')
            const r3 = createBrowserRound(cap, { now: () => 0, remainingMs: () => 30_000 })
            assert.equal(r3.canStart(['playwright']), false, '整輪剩餘不足本篇硬逾時＋60 秒')
            assert.deepEqual(round.stats, { tried: 2, ok: 0, envFail: 1, final: 0, pageFail: 0 })
        })
    })

    // ── 補全文子階段:兩佇列、分流、延後、環境斷路 ──
    describe('stageDetailFetch(CS3 瀏覽器分流)', () => {
        // 本組測試之基準設定(capture 之巢狀形狀;各案以 opt.cap 遞迴覆寫)
        const CAP = {
            articles: { perRun: 10, maxTries: 3, maxTextChars: 20000, aggregatorLinksPerDoc: 12, timeoutMs: 1000, skipTitlePatterns: [] },
            standards: { minFallbackChars: 300, minTextChars: 300 },
            browser: { perRun: 1, maxMs: 600000, navTimeoutMs: 20000, camofox: { enabled: true, port: 19417 } },
        }
        const doc = (id, extra = {}) => ({ id, status: 'new', title: `文章 ${id}`, url: `https://site.example/${id}`, fetchTries: 0, sourceTier: 2, collectedAt: `2026-09-0${id.length}`, ...extra })
        /** 環境:article 抓取器依網址回傳預設之結果;browser 抓取器以注入之 runCli 執行;opt.store 可換集合替身(如深合併語意) */
        function env(rows, outcomes, opt = {}) {
            const docs = (opt.store || memStore)(rows)
            const cliCalls = []
            const runCli = async (o) => {
                const url = o.args[0]
                const opts = JSON.parse(fs.readFileSync(o.args[1], 'utf8'))
                cliCalls.push({ url, steps: opts.steps })
                return (opt.cli || (() => ({ status: 'success', content: LONG('瀏覽器取得之正文'), title: 'B', method: 'playwright-headless', envBroken: [], steps: [{ step: opts.steps[0], ok: true }] })))(url, opts)
            }
            const article = { id: 'article', retries: 0, retryDelayMs: 0, timeoutMs: 1000, fetch: async (d) => outcomes[d.id] || { ok: true, text: LONG('正常正文') } }
            const browser = createBrowserFetcher({ runCli })
            const registry = { resolve: (role, d) => (d.fetcher === 'browser' ? browser : article), label: () => 'x' }
            const seen = { idOf: (u) => (String(u).includes('/dup-target') ? 'dupT' : 'zz-unknown') }
            const deps = { stores: { docs }, registry, seen, settings: resolveSettings({ capture: deepMerge(CAP, opt.cap) }), clock, dirs: { tmp: TMP } }
            const logger = recLog()
            return { docs, cliCalls, deps, logger, run: () => stageDetailFetch({ runCli }).run({ deps, log: logger }) }
        }

        it('404 → 一輪即 dead(final,不進瀏覽器);429 → 重試(tries+1、仍 new、非瀏覽器佇列);adapter 收攤 → dead', async () => {
            const e = env([doc('a'), doc('bb'), doc('ccc')], {
                a: { ok: false, reason: 'http-error', message: 'HTTP 404', extra: { httpCode: 404 } },
                bb: { ok: false, reason: 'http-error', message: 'HTTP 429', extra: { httpCode: 429 } },
                ccc: { ok: false, reason: 'empty-content', message: 'msn 410', extra: { adapterId: 'msn' } },
            })
            const r = await e.run()
            const a = await e.docs.get('a')
            assert.deepEqual([a.status, a.fetchTries, a.lastReason], ['dead', 3, 'http-error'])
            const b = await e.docs.get('bb')
            assert.deepEqual([b.status, b.fetchTries, b.fetcher], ['new', 1, ''])
            assert.equal((await e.docs.get('ccc')).status, 'dead')
            assert.equal(e.cliCalls.length, 0, '三者皆不進瀏覽器')
            assert.equal(r.detail.finalDead, 2)
        })

        it('空殼頁(正文過短)→ 健全閘 too-short → 同輪升級瀏覽器(不加 curl 前置)→ raw、textFrom browser:<方法>、fetcher 清空', async () => {
            const e = env([doc('js')], { js: { ok: true, text: 'Loading…', title: 'x' } })
            const r = await e.run()
            const d = await e.docs.get('js')
            assert.deepEqual([d.status, d.textFrom, d.fetcher, d.fetchTries], ['raw', 'browser:playwright-headless', '', 1])
            assert.ok(d.text.includes('瀏覽器取得之正文'))
            assert.deepEqual(e.cliCalls[0].steps, ['playwright', 'camofox'], '同輪升級:render 類階梯,無 curl 前置')
            assert.deepEqual([r.detail.browserTried, r.detail.browserOk, r.detail.gate['too-short']], [1, 1, 1])
        })

        it('檢定標準 CS2 錯頁(記錄標題之詞皆不見於正文):正文抓取器 → 同輪升級瀏覽器(render);瀏覽器救回之正文相符 → raw;仍不符 → 終態 dead(lastReason title-mismatch,可以 revive --error 回收);標題詞不足或文字系統不同 → 不判', async () => {
            const OFF = '這是一篇講述烘焙麵包與咖啡沖煮技巧的生活文章，內容涵蓋發酵溫度與研磨粗細的經驗分享。'.repeat(12)
            const ON = '台股動量因子之回測結果顯示，扣除交易成本後仍有超額報酬，持有期間與形成期為關鍵參數。'.repeat(12)
            const t = { title: '台股動量因子之回測' }
            // 瀏覽器救回之正文相符 → raw
            const ok = env([doc('m1', t)], { m1: { ok: true, text: OFF, title: 'x' } }, { cli: () => ({ status: 'success', content: ON, title: 'B', method: 'playwright-headless', envBroken: [], steps: [{ step: 'playwright', ok: true }] }) })
            const r1 = await ok.run()
            const d1 = await ok.docs.get('m1')
            assert.deepEqual([d1.status, d1.textFrom], ['raw', 'browser:playwright-headless'])
            assert.deepEqual(ok.cliCalls[0].steps, ['playwright', 'camofox'], '錯頁走 render 類階梯')
            assert.equal(r1.detail.gate['title-mismatch'], 1)
            // 瀏覽器亦不符 → 終態
            const bad = env([doc('m2', t)], { m2: { ok: true, text: OFF, title: 'x' } }, { cli: () => ({ status: 'success', content: OFF, title: 'B', method: 'playwright-headless', envBroken: [], steps: [{ step: 'playwright', ok: true }] }) })
            await bad.run()
            const d2 = await bad.docs.get('m2')
            assert.deepEqual([d2.status, d2.lastReason], ['dead', 'title-mismatch'])
            assert.match(d2.lastError, /^標題與正文不符（標題詞 \d+ 個皆不見於正文）/)
            assert.ok(deadMatcher({ error: '標題與正文不符' })(d2), 'revive --error 可回收')
            // 標題詞不足 → 不判(照常 raw)
            const na = env([doc('m3', { title: '動量' })], { m3: { ok: true, text: OFF, title: 'x' } })
            await na.run()
            assert.equal((await na.docs.get('m3')).status, 'raw')
            // capture.standards.titleMismatch:false(零件庫用法)→ CS2 不判:錯頁照常 raw、不進瀏覽器
            const off = env([doc('m4', t)], { m4: { ok: true, text: OFF, title: 'x' } }, { cap: { standards: { titleMismatch: false } } })
            const r4 = await off.run()
            assert.deepEqual([(await off.docs.get('m4')).status, off.cliCalls.length, r4.detail.gate?.['title-mismatch']], ['raw', 0, undefined])
            assert.deepEqual([classifyFetch({ ok: false, reason: 'title-mismatch', fetcherId: 'article' }).action, classifyFetch({ ok: false, reason: 'title-mismatch', fetcherId: 'browser' }).cls], ['browser', 'title-mismatch'])
        })

        it('檢定標準 CS10 落盤:正文段落與既有文件重疊(≥3 段且 ≥ 半數)→ skip(duplicate,記重疊段數與文件);轉址後網址之正準代稱同既有 → skip;不重疊者 raw 並記 paraKeys', async () => {
            const P = (s) => `${s}之量化研究段落內容說明，`.repeat(6)
            const text = [P('甲'), P('乙'), P('丙'), P('丁')].join('\n')
            const old = { id: 'old', status: 'noted', url: 'https://orig.example/a', paraKeys: paraKeysOf(text), title: '原文' }
            const e = env([old, doc('cp'), doc('rd'), doc('nw')], {
                cp: { ok: true, text, title: 'x' },
                rd: { ok: true, text: [P('戊'), P('己'), P('庚'), P('辛')].join('\n'), title: 'x', extra: { finalUrl: 'https://arxiv.org/abs/2401.05555' } },
                nw: { ok: true, text: [P('子'), P('丑'), P('寅'), P('卯')].join('\n'), title: 'x' },
            })
            await e.docs.insertNew([{ id: 'ax', status: 'noted', url: 'https://arxiv.org/pdf/2401.05555' }])
            const r = await e.run()
            const cp = await e.docs.get('cp')
            assert.deepEqual([cp.status, cp.skipKind], ['skip', 'duplicate'])
            assert.match(cp.skipReason, /^與既有文件同一內容（段落重疊 4／4，文件 old）（未進 AI）/)
            const rd = await e.docs.get('rd')
            assert.match(rd.skipReason, /arxiv:2401\.05555，文件 ax/)
            const nw = await e.docs.get('nw')
            assert.deepEqual([nw.status, nw.paraKeys.length], ['raw', 4])
            assert.equal(r.detail.sameContent, 2)
        })

        it('檢定標準 CS10 feed 退路(全部入口之一):feed 內文與既有文件段落重疊(≥3 段且 ≥ 半數;與正文落盤同一判定)→ skip(duplicate,理由同正文落盤,未進 AI);不重疊者 raw 並記 paraKeys;report sameContent 計入', async () => {
            const text = [PARA('甲'), PARA('乙'), PARA('丙'), PARA('丁')].join('\n')
            const old = { id: 'old', status: 'noted', url: 'https://orig.example/a', paraKeys: paraKeysOf(text) }
            const f404 = { ok: false, reason: 'http-error', message: 'HTTP 404', extra: { httpCode: 404 } }
            const e = env([old, doc('fd', { feedText: text }), doc('fn', { feedText: [PARA('子'), PARA('丑'), PARA('寅'), PARA('卯')].join('\n') })], { fd: f404, fn: f404 })
            const r = await e.run()
            const fd = await e.docs.get('fd')
            // 規則:重疊 → skip(skipKind duplicate),理由格式同正文落盤
            assert.deepEqual([fd.status, fd.skipKind, fd.text], ['skip', 'duplicate', undefined])
            assert.match(fd.skipReason, /^與既有文件同一內容（段落重疊 4／4，文件 old）（未進 AI）$/)
            const fn = await e.docs.get('fn')
            assert.deepEqual([fn.status, fn.textFrom, fn.paraKeys.length], ['raw', 'feed', 4])
            assert.deepEqual([r.detail.sameContent, r.detail.filled], [1, 1])
            assert.ok(e.logger.lines.some((l) => /^INFO 全文\[文章 fd\] feed 內文與既有文件同一內容（段落重疊 4／4，文件 old），記 skip（未進 AI）$/.test(l)), e.logger.lines.join('\n'))
        })

        it('落盤寫段落雜湊前清除既有陣列(集合之 patch 為深合併——因素材問題而重抓之文件帶有前次 paraKeys,新陣列較短時殘留舊尾,會使同一內容索引誤配)', async () => {
            // 對照:深合併集合不先清即殘留舊尾(證明替身確為正式集合之語意)
            const s = mergeStore([{ id: 'z', paraKeys: ['a', 'b', 'c'] }])
            await s.patch('z', { paraKeys: ['x'] })
            assert.deepEqual((await s.get('z')).paraKeys, ['x', 'b', 'c'])
            const oldText = Array.from({ length: 6 }, (_, i) => PARA(`舊${i}`)).join('\n')
            const newText = [PARA('新一'), PARA('新二'), PARA('新三'), PARA('新四')].join('\n') // 4 段(過 300 字之閘)< 舊 6 段
            const feedText = [PARA('另一'), PARA('另二'), PARA('另三'), PARA('另四')].join('\n') // 與 newText 不重疊(否則依 CS10 判同一內容)
            const e = env([doc('rf', { paraKeys: paraKeysOf(oldText) }), doc('rg', { paraKeys: paraKeysOf(oldText.replace(/舊/g, '昔')), feedText })], {
                rf: { ok: true, text: newText },
                rg: { ok: false, reason: 'http-error', message: 'HTTP 404', extra: { httpCode: 404 } },
            }, { store: mergeStore })
            await e.run()
            assert.deepEqual((await e.docs.get('rf')).paraKeys, paraKeysOf(newText), '正文落盤:新陣列不殘留舊尾')
            assert.deepEqual([(await e.docs.get('rg')).status, (await e.docs.get('rg')).paraKeys], ['raw', paraKeysOf(feedText)], 'feed 退路:同上')
        })

        it('檢定標準 CS1a 新進與存量同一把尺:落 raw 之兩入口(正文落盤、feed 退路)記 healthV＝現版(gateVersionOf);同輪之抓取維護不再重判;feed 退路之閘長度條件以 feed 原長(feedFullLength)判', async () => {
            const f404 = { ok: false, reason: 'http-error', message: 'HTTP 404', extra: { httpCode: 404 } }
            const e = env([doc('h1'), doc('h22', { feedText: 'f'.repeat(400) }), doc('h333', { feedText: LONG('摘要').slice(0, 400), feedFullLength: 400_000 })], { h22: f404, h333: f404 })
            const r = await e.run()
            const cur = gateVersionOf(e.deps.settings.capture.standards)
            assert.deepEqual([(await e.docs.get('h1')).textFrom, (await e.docs.get('h1')).healthV], ['article', cur])
            assert.deepEqual([(await e.docs.get('h22')).textFrom, (await e.docs.get('h22')).healthV], ['feed', cur])
            // 規則:feed 原長 400,000 逾合理上限 → feed 內文未過閘、不作退路(以 feed 原長判,不以截斷後之 feedText 判)
            const h3 = await e.docs.get('h333')
            assert.deepEqual([h3.status, h3.lastReason], ['dead', 'http-error'])
            assert.equal(r.detail.gate['feed-format-noise'], 1)
            // 規則:新進以現版閘判過者,同輪抓取維護不重判
            const m = await stageDocMaintain({ terminalStatuses: [] }).run({ deps: e.deps, log: recLog() })
            assert.deepEqual([m.detail.health.version, m.detail.health.due], [cur, 0])
        })

        it('檢定標準 CS1e:安裝方自訂之正文抓取器同過正文健全閘(不合格 → 重試,不轉瀏覽器);定義明示 contract.gateExempt 者豁免', async () => {
            const e = env([doc('c1', { fetcher: 'mysite' }), doc('c22', { fetcher: 'exempt' })], {})
            const mk = (id, contract) => ({ id, role: 'detail', retries: 0, retryDelayMs: 0, timeoutMs: 1000, contract, fetch: async () => ({ ok: true, text: 'Please enable JavaScript', title: 'x' }) })
            const custom = { mysite: mk('mysite', {}), exempt: mk('exempt', { gateExempt: true }) }
            const base = e.deps.registry
            e.deps.registry = { ...base, resolve: (role, d) => custom[d.fetcher] || base.resolve(role, d) }
            const r = await e.run()
            const c1 = await e.docs.get('c1')
            assert.deepEqual([c1.status, c1.fetchTries, c1.lastReason], ['new', 1, 'too-short'], '自訂抓取器之空殼頁 → 健全閘判出、重試')
            assert.equal(e.cliCalls.length, 0, '自訂抓取器不轉瀏覽器')
            assert.equal((await e.docs.get('c22')).status, 'raw', '明示豁免者照收')
            assert.equal(r.detail.gate['too-short'], 1)
        })

        it('配額 1、兩篇可救 → 一篇瀏覽、一篇延後(fetcher=browser、tries 不變、lastClass);新件不被延後件擋(兩佇列分選)', async () => {
            const e = env([doc('p1'), doc('p22'), doc('n333')], {
                p1: { ok: false, reason: 'empty', message: 'empty shell' },
                p22: { ok: false, reason: 'captcha', message: 'challenge' },
            })
            await e.run()
            const p22 = await e.docs.get('p22')
            assert.deepEqual([p22.status, p22.fetcher, p22.fetchTries, p22.lastClass, p22.deferrals], ['new', 'browser', 0, 'challenge', 1])
            assert.equal((await e.docs.get('p1')).status, 'raw')
            assert.equal((await e.docs.get('n333')).status, 'raw', '同輪之新件照常補全文')
            // 下一輪:延後件走瀏覽器佇列(跨輪:前置 curl),不佔補全文名額
            e.cliCalls.length = 0
            await e.docs.insertNew([doc('n4444')])
            const r2 = await e.run()
            assert.deepEqual(e.cliCalls.map((c) => [c.url.split('/').pop(), c.steps]), [['p22', ['curl', 'playwright', 'camofox']]])
            assert.equal((await e.docs.get('p22')).status, 'raw')
            assert.equal((await e.docs.get('n4444')).status, 'raw')
            assert.equal(r2.detail.browserQueued, 1)
        })

        it('瀏覽器環境失敗 → 延後不計 tries、方法斷路、WARN;feed 足量者不延後而走 feed 退路', async () => {
            const e = env([doc('e1'), doc('e22', { feedText: 'f'.repeat(400) })], {
                e1: { ok: false, reason: 'empty', message: 'shell' },
                e22: { ok: false, reason: 'empty', message: 'shell' },
            }, { cap: { browser: { perRun: 5 } }, cli: () => ({ status: 'error', reason: 'browser-env', message: 'Chrome 無法啟動', envBroken: ['playwright', 'camofox'], steps: [] }) })
            const r = await e.run()
            const e1 = await e.docs.get('e1')
            assert.deepEqual([e1.status, e1.fetchTries, e1.fetcher], ['new', 0, 'browser'])
            assert.ok(e1.deferredAt, '首次延後記進佇列時刻')
            const e22 = await e.docs.get('e22')
            assert.deepEqual([e22.status, e22.textFrom], ['raw', 'feed'])
            assert.equal(e.cliCalls.length, 1, '第一篇環境失敗後兩方法皆斷路,第二篇不再開瀏覽器')
            assert.ok(e.logger.lines.some((l) => /^WARN 內文\[文章 e1\] 瀏覽器環境不可用/.test(l)), e.logger.lines.join('\n'))
            assert.deepEqual(r.detail.browserBroken.sort(), ['camofox', 'playwright'])
        })

        it('瀏覽器佇列件之環境失敗 → 延後(不計 tries)且保留原進佇列時刻(此前每次延後皆重設,環境連續斷路時佇列最舊天數被低報)', async () => {
            const T0 = '2026-09-01T00:00:00+08:00'
            const e = env([doc('q1', { fetcher: 'browser', lastClass: 'render', deferredAt: T0, deferrals: 1 })], {}, { cap: { browser: { perRun: 5 } }, cli: () => ({ status: 'error', reason: 'browser-env', message: 'Chrome 無法啟動', envBroken: ['playwright', 'camofox'], steps: [] }) })
            await e.run()
            const q1 = await e.docs.get('q1')
            assert.deepEqual([q1.status, q1.fetchTries, q1.fetcher, q1.lastClass, q1.deferredAt, q1.deferrals], ['new', 0, 'browser', 'render', T0, 2])
        })

        it('瀏覽器頁面失敗 → tries+1、留瀏覽器佇列(fetcher=browser、lastClass);達 capture.articles.maxTries 標 dead', async () => {
            const e = env([doc('f1')], { f1: { ok: false, reason: 'http-error', message: 'HTTP 403', extra: { httpCode: 403 } } }, {
                cap: { browser: { perRun: 3 } },
                cli: () => ({ status: 'error', reason: 'camofox-empty', message: 'snapshot empty', final: false, envBroken: [], steps: [{ step: 'camofox', ok: false, reason: 'camofox-empty' }] }),
            })
            await e.run()
            let f1 = await e.docs.get('f1')
            assert.deepEqual([f1.status, f1.fetchTries, f1.fetcher, f1.lastClass], ['new', 1, 'browser', 'http-blocked'])
            assert.deepEqual(e.cliCalls[0].steps, ['camofox', 'playwright'], '403:camofox 先')
            await e.run()
            await e.run()
            f1 = await e.docs.get('f1')
            assert.deepEqual([f1.status, f1.fetchTries], ['dead', 3])
            assert.deepEqual(e.cliCalls[1].steps, ['curl', 'camofox', 'playwright'], '跨輪:前置 curl')
        })

        it('瀏覽器分流停用(capture.browser.perRun 0):可救件照舊 curl 重試(計 tries,不延後);既有指名瀏覽器之件改走 article', async () => {
            const e = env([doc('s1'), doc('s22', { fetcher: 'browser', lastClass: 'render' })], { s1: { ok: false, reason: 'empty', message: 'shell' } }, { cap: { browser: { perRun: 0 } } })
            await e.run()
            const s1 = await e.docs.get('s1')
            assert.deepEqual([s1.status, s1.fetchTries, s1.fetcher], ['new', 1, ''])
            const s22 = await e.docs.get('s22')
            assert.deepEqual([s22.status, s22.textFrom], ['raw', 'article'])
            assert.equal(e.cliCalls.length, 0)
        })

        it('PDF 網址(CS14)→ 不發請求、一輪即 dead(lastReason pdf、lastError 含 PDF);feed 足量者照走 feed 退路', async () => {
            const e = env([doc('pdf1', { url: 'https://arxiv.org/pdf/2401.12345' }), doc('pdf22', { url: 'https://e.com/r.pdf', feedText: 'f'.repeat(400) })], {}, { cap: { browser: { perRun: 3 } } })
            let called = 0
            e.deps.registry = { resolve: () => ({ id: 'article', retries: 0, retryDelayMs: 0, timeoutMs: 1000, fetch: async () => { called++; return { ok: true, text: LONG('x') } } }), label: () => 'x' }
            await e.run()
            const p1 = await e.docs.get('pdf1')
            assert.deepEqual([p1.status, p1.lastReason, p1.fetchTries], ['dead', 'pdf', 3])
            assert.match(p1.lastError, /PDF/)
            assert.deepEqual([(await e.docs.get('pdf22')).status, (await e.docs.get('pdf22')).textFrom], ['raw', 'feed'])
            assert.equal(called, 0, '未呼叫抓取器')
            assert.equal(e.cliCalls.length, 0, '不佔瀏覽器名額')
        })

        it('格式雜訊(JSON 原文)→ 同輪升級瀏覽器;去重在截斷之前:落庫正文已去重、記 dedupedChars、fullLength 為原長', async () => {
            const json = `{"data":[${Array.from({ length: 30 }, (_, i) => `{"id":${i},"title":"Factor ${i}"}`).join(',')}]}`
            const para = '動量因子在十二減一月之形成期下有顯著之超額報酬，但於市場反轉時會出現劇烈回撤，須以波動度縮放控制風險。'
            const dupPage = `${LONG('獨有內容甲')}\n${Array(30).fill(para).join('\n')}\n${LONG('獨有內容乙')}`
            const e = env([doc('fn'), doc('dp')], { fn: { ok: true, text: json }, dp: { ok: true, text: dupPage } }, { cap: { browser: { perRun: 3 }, articles: { maxTextChars: 2000 } } })
            const r = await e.run()
            const fn = await e.docs.get('fn')
            assert.deepEqual([fn.status, fn.textFrom], ['raw', 'browser:playwright-headless'])
            assert.equal(r.detail.gate['format-noise'], 1)
            const dp = await e.docs.get('dp')
            assert.equal(dp.fullLength, dupPage.length, '原長為去重前')
            assert.equal(dp.dedupedChars, (para.length + 1) * 29)
            assert.ok(dp.text.includes('獨有內容乙') || dp.textLength === 2000, '去重後才截斷:乙段得以進入 2,000 字窗(或已達上限)')
            assert.equal(dp.text.split(para).length - 1, 1)
        })

        it('重抓後無重複段落 → dedupedChars 寫回 0(不留前次之去重量;集合 patch 只合併不刪鍵,條件式省鍵會殘留)', async () => {
            const e = env([doc('re', { dedupedChars: 600, fullLength: 9000 })], { re: { ok: true, text: LONG('全新且無重複之正文') } })
            await e.run()
            const re = await e.docs.get('re')
            assert.equal(re.status, 'raw')
            assert.equal(re.dedupedChars, 0, '前次之 600 不殘留(下游以 fullLength − dedupedChars 估原長)')
        })

        it('refetchSkip(下游回報素材問題而重抓者):排除產生素材之方法、含 curl 不前置;全排除 → 終態 no-alt-method(不開子行程);成功清除 refetchSkip', async () => {
            const e = env([
                doc('r1', { fetcher: 'browser', lastClass: 'render', refetchSkip: ['curl'] }),
                doc('r22', { fetcher: 'browser', lastClass: 'render', refetchSkip: ['playwright'] }),
            ], {}, { cap: { browser: { perRun: 5 } } })
            await e.run()
            assert.deepEqual(e.cliCalls.map((c) => [c.url.split('/').pop(), c.steps]), [['r1', ['playwright', 'camofox']], ['r22', ['curl', 'camofox']]])
            const r1 = await e.docs.get('r1')
            assert.deepEqual([r1.status, r1.refetchSkip, r1.fetcher], ['raw', null, ''])
            const e2 = env([doc('r333', { fetcher: 'browser', lastClass: 'render', refetchSkip: ['curl', 'playwright', 'camofox'] })], {}, { cap: { browser: { perRun: 5 } } })
            await e2.run()
            const r3 = await e2.docs.get('r333')
            assert.deepEqual([r3.status, r3.lastReason], ['dead', 'no-alt-method'])
            assert.equal(e2.cliCalls.length, 0)
        })

        it('轉址至既有文件 → skip(重複,未進 AI;CS4);轉址至同站首頁 → 軟 404 終態;亂碼正文 → mojibake → 瀏覽器', async () => {
            const rows = [doc('d1'), doc('s404'), doc('mj'), { id: 'dupT', status: 'noted', url: 'https://site.example/dup-target' }]
            const e = env(rows, {
                d1: { ok: true, text: LONG('正文'), extra: { finalUrl: 'https://site.example/dup-target' } },
                s404: { ok: true, text: LONG('首頁'), extra: { finalUrl: 'https://site.example/' } },
                mj: { ok: true, text: `${FFFD.repeat(50)}${'a'.repeat(500)}` },
            }, { cap: { browser: { perRun: 3 } } })
            const r = await e.run()
            const d1 = await e.docs.get('d1')
            assert.equal(d1.status, 'skip')
            assert.match(d1.skipReason, /與既有文件重複（轉址至 https:\/\/site\.example\/dup-target/)
            const s = await e.docs.get('s404')
            assert.deepEqual([s.status, s.lastReason], ['dead', 'soft-404'])
            const mj = await e.docs.get('mj')
            assert.deepEqual([mj.status, mj.textFrom], ['raw', 'browser:playwright-headless'])
            assert.deepEqual(e.cliCalls.map((c) => c.steps[0]), ['playwright'], '只有亂碼件進瀏覽器')
            assert.deepEqual([r.detail.duplicate, r.detail.gate.mojibake], [1, 1])
        })
    })

    // ── 彙整貼文轉錄:CS5 例行貼文之 skip 分計、連結濾除計數 ──
    describe('彙整貼文轉錄(transcodeLinks／extractLinks)', () => {

        it('extractLinks(濾除逐因計數,不靜默剔除):無效網址、非 http、同站、分享按鈕、學術索引／平台工具、連結文字過短逐因計數;合格者保留', () => {
            const html = [
                '<a href="https://ext.example/paper">A sufficiently long anchor text one</a>',
                '<a href="/about">Internal navigation link text here</a>',
                '<a href="https://www.agg.example/p2">Same site with www prefix text</a>',
                '<a href="mailto:x@y.z">Mail us at this address please</a>',
                '<a href="javascript:void(0)">Do something with javascript</a>',
                '<a href="https://twitter.com/share">Share this on twitter now please</a>',
                '<a href="https://scholar.google.com/x">Google Scholar search results</a>',
                '<a href="https://ext2.example/b">More</a>',
                '<a href="http://[::1">Broken bracket url text long</a>',
            ].join('\n')
            const r = extractLinks(html, 'https://agg.example/post')
            assert.deepEqual(r.links, [{ url: 'https://ext.example/paper', text: 'A sufficiently long anchor text one' }])
            assert.deepEqual(r.filtered, { invalid: 1, nonHttp: 2, sameSite: 2, share: 1, denyHost: 1, shortText: 1 })
            assert.deepEqual(extractLinks('', 'https://agg.example/post'), { links: [], filtered: { invalid: 0, nonHttp: 0, sameSite: 0, share: 0, denyHost: 0, shortText: 0 } })
        })

        it('轉錄:濾除之連結(抓取器 extra.linkFiltered)與逾每篇上限而未轉錄者逐因計入 report detail.linkFiltered 並見於日誌;例行貼文無可轉錄連結 → skip 帶 skipKind routine 與判定時刻,來源產出統計不計入已判定(CS5)', async () => {
            const docs = memStore([
                { id: 'w1', status: 'new', title: 'Weekly Roundup #1', url: 'https://agg.example/w1', fetchTries: 0, sourceId: 'src1', collectedAt: '2026-09-01' },
                { id: 'w2', status: 'new', title: 'Weekly Roundup #2', url: 'https://agg.example/w2', fetchTries: 0, sourceId: 'src1', collectedAt: '2026-09-02' },
            ])
            const lg = recLog()
            const seen = W.createSeenStore({ collection: docs, identity: W.createIdentity({ keyOf: 'raw' }), log: lg })
            const out = {
                w1: { ok: true, links: [1, 2, 3].map((i) => ({ url: `https://ext.example/a${i}`, text: `External article number ${i} title text` })), extra: { linkFiltered: { sameSite: 3, shortText: 2, denyHost: 0 } } },
                w2: { ok: true, links: [], extra: { linkFiltered: { denyHost: 4 } } },
            }
            const links = { id: 'links', role: 'detail', retries: 0, retryDelayMs: 0, timeoutMs: 1000, fetch: async (d) => out[d.id] }
            const deps = {
                stores: { docs }, registry: { resolve: () => links, label: () => 'links' }, seen, clock: { iso8: () => NOW },
                // 標題預篩樣式取自 capture.articles.skipTitlePatterns(JSON 形 { p, f };編譯於使用處)
                settings: resolveSettings({ capture: { articles: { perRun: 5, maxTries: 3, maxTextChars: 20000, aggregatorLinksPerDoc: 2, timeoutMs: 1000, skipTitlePatterns: [{ p: '^Weekly', f: 'i' }] }, standards: { minFallbackChars: 300 }, browser: { perRun: 0 } } }),
            }
            const r = await stageDetailFetch().run({ deps, log: lg })
            // 規則:濾除與逾上限皆計數(不靜默)——3 條連結、上限 2 → 逾上限 1;w2 之學術索引 4
            assert.deepEqual(r.detail.linkFiltered, { sameSite: 3, shortText: 2, capped: 1, denyHost: 4 })
            assert.deepEqual([(await docs.get('w1')).status, r.detail.aggregated], ['aggregated', 2])
            assert.ok(lg.lines.includes('INFO 彙整[Weekly Roundup #1] 連結 3 條，轉錄 2 條，新增 2 篇；濾除 同站 3、連結文字過短 2、逾每篇上限 1'), lg.lines.join('\n'))
            assert.ok(lg.lines.includes('INFO 彙整[Weekly Roundup #2] 無可轉錄之連結，略過（未進 AI）；濾除 學術索引／平台工具 4'), lg.lines.join('\n'))
            // 規則:例行貼文之 skip 帶 skipKind routine 與判定時刻(notedAt;觀察窗據此計)
            const w2 = await docs.get('w2')
            assert.deepEqual([w2.status, w2.skipKind, w2.notedAt], ['skip', 'routine', NOW])
            // 規則:來源產出統計不把例行貼文計入已判定(與重複類同一處理)
            assert.deepEqual(judgeFromDocs(await docs.select()).src1, { judged: 0, yielded: 0, dup: 0, routine: 1, material: 0 })
        })
    })
})
