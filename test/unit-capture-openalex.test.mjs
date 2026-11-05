// unit-capture-openalex.test.mjs — OpenAlex API 金鑰與 429(CAP-16):金鑰自 capture.services.openAlex.apiKeyEnv 所指之變數由金鑰檔讀入(不入設定),
//   網格來源／領域發現驗證／原文回溯(DOI 批次、題名搜尋)四處請求帶 api_key(未設則不帶,請求與加入前逐字相同),netGuard 探測不帶;
//   金鑰不入日誌、處置帳、事件、拋出之錯誤、stderr(含失敗路徑);429 為固定訊息、原文回溯連續 3 次即停(未處理者不入處置帳,可續跑),
//   非連續之 429 不停;網格 429 切 arXiv 且事件寫明。
// 網路:本機假站台(固定埠 8836 假 OpenAlex／arXiv;8837 學術 API 替身供整條 flow;8830 無人監聽之死埠),真 curl;不連外網。
//
// 案號即本檔規格之編號:
//   OA1  設定:apiKeyEnv 預設 OPENALEX_API_KEY(變數名,非金鑰值);非法值啟動期拋錯;'' 為明確不使用
//   OA2  金鑰讀取:變數名自設定、值自金鑰檔(不污染 process.env);無檔／無變數／空值／變數名空 → 不帶金鑰
//   OA3  金鑰載體:JSON／util.inspect／展開／字串化皆不含金鑰值;sign／mask(含編碼形式)
//   OA4  請求包裝 openAlexGet:無金鑰逐字沿用舊呼叫;有金鑰 maxRetries:0 自行重試(5xx／429／curl 錯誤)、訊息遮罩、429 固定訊息
//   OA5  四處請求站點帶金鑰、未設時不帶(網格、領域驗證、回溯 DOI 批次、回溯題名);未設時之請求網址與修前逐字相同;netGuard 探測不帶
//   OA6  整條接線:envFile → createCaptureRuntime → 抓取器／每輪依賴;整條 flow.run() 之網格請求帶金鑰,輸出(report、info、日誌檔)不含金鑰
//   OA7  金鑰不外洩(失敗路徑):五種失敗 × 四處站點,拋出之錯誤、日誌、處置帳、結果、stderr 皆不含金鑰(原形與 URL 編碼形)
//   OA8  429 固定訊息:網格(切 arXiv、事件、_oaQuota、gridOaQuota 計數)、領域驗證、回溯(單次 429)
//   OA9  原文回溯連續 429:連續 3 次即停(DOI 批次、題名、跨二者)、未處理篇數正確、未入處置帳、續跑接上;非連續不停;arXiv／網頁照常
//   (多把金鑰:apiKeyEnv 之值為逗號分隔多把、429 換把、401／403 標記無效 → OA10～OA15 見 unit-capture-openalex-keys.test.mjs;本檔之金鑰皆以單把陣列〔[KEY]〕傳入)
// 執行:自套件根 node <mocha> --timeout 180000 test/unit-capture-openalex.test.mjs(暫存 test/_tmp/openalex-*-<pid>,測完即刪)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import util from 'node:util'
import W from 'w-data-pipeline/src/WDataPipeline.mjs'
import fetchWebByCurl from 'w-fetch-web/src/fetchWebByCurl.mjs'
import { memStore } from './tools/memStore.mjs'
import { settingsOf, tmpRoot, removeRoots, recLog, buildTestCapture, resetConceptFold } from './tools/captureTestKit.mjs'
import { createScholarSite } from './tools/fakeSite.mjs'
import { genClockTZ } from '../src/core/runnerPackage.mjs'
import { resolveSettings } from '../src/core/settingsDefault.mjs'
import { createDefaultFetchers } from '../src/fetchers/defaultFetchers.mjs'
import {
    OPENALEX_QUOTA_MESSAGE, OPENALEX_QUOTA_STOP_AFTER, OPENALEX_KEY_ENV_DEFAULT, openAlexApiKeyOf, createOpenAlexAuth, openAlexAuthOf, NO_OPENALEX_AUTH,
    OpenAlexQuotaError, isOpenAlexQuota, openAlexGet,
} from '../src/fetchers/openAlexNet.mjs'
import { validateAreaQuery } from '../src/stages/areaStage.mjs'
import { mwFetchList, stageListFetch } from '../src/stages/listFetchStage.mjs'
import { composeChain, makeMsg } from '../src/core/kernel.mjs'
import { createCaptureRuntime } from '../src/captureRuntime.mjs'
import { netProbeUrlsOf, createNetGuard } from '../src/core/util/netGuard.mjs'
import { refetchSources, REFETCH_LEDGER_FILE } from '../src/ops/refetchSources.mjs'

const PORT = 8836 // 假 OpenAlex／arXiv(本檔專屬;固定埠 ≥8000、不隨機)
const PORT_SITE = 8837 // 學術 API 替身(整條 flow;本檔專屬)
const DEAD = 'http://127.0.0.1:8830' // 無人監聽之死埠(連線即被拒;他檔亦只連不聽)
// 含需 URL 編碼之字元(+ / =):編碼形式與原形都不得出現在任何輸出
const KEY = 'oaTest+Key/9f3c=XyZ-secret-1'
const KEY_ENC = encodeURIComponent(KEY)
const clock = genClockTZ('Asia/Taipei')
const AT = '2026-09-01T00:00:00+08:00'
const ABS = 'Tidal heating of icy satellites is estimated from orbital resonance and measured libration amplitudes across repeated observations. '.repeat(4).trim()
const BODY = (title) => `${title}\n\n${'動量策略之實證研究顯示，買進過去贏家並放空過去輸家之組合，於樣本期間內有顯著之超額報酬，且於控制規模與價值因子後仍然存在。'.repeat(8)}`
const pad = (n) => String(n).padStart(3, '0')
const words = (n, tag) => Array.from({ length: n }, (_, k) => `${tag}word${k}`)
const inv = (ws) => Object.fromEntries(ws.map((w, k) => [w, [k]]))
const json = (o, status = 200) => ({ status, type: 'application/json', body: JSON.stringify(o) })
const atom = (n = 2) => ({ status: 200, type: 'application/atom+xml', body: `<feed xmlns="http://www.w3.org/2005/Atom">${Array.from({ length: n }, (_, i) => `<entry><id>http://arxiv.org/abs/2401.0000${i}v1</id><title>Arx ${i}</title><summary>${ABS}</summary><published>2024-01-0${i + 1}T00:00:00Z</published></entry>`).join('')}</feed>` })

/** 假站台的標題→網址對照(題名搜尋之回應用) */
const TITLE_URL = new Map()

/** 預設路由:healthy OpenAlex(works:DOI 篩選／領域驗證／網格／題名搜尋)與 arXiv(/api/query) */
function okRoute(u, base) {
    if (u.pathname === '/works') {
        const filter = u.searchParams.get('filter') || ''
        const search = u.searchParams.get('search') || ''
        if (filter.startsWith('doi:')) {
            const dois = filter.slice(4).split('|')
            return json({ meta: { count: dois.length }, results: dois.map((d, i) => ({ title: `T ${d}`, doi: d, abstract_inverted_index: inv(words(60, `d${i}`)), primary_location: {} })) })
        }
        if ((u.searchParams.get('select') || '').startsWith('id,doi')) {
            return json({ meta: { count: 1500 }, results: Array.from({ length: 8 }, (_, i) => ({ id: `W${i}`, doi: `${base}/paper/v${i}`, primary_location: { landing_page_url: `${base}/paper/v${i}` }, abstract_inverted_index: inv(words(60, `v${i}`)) })) })
        }
        if (u.searchParams.has('page')) {
            return json({ meta: { count: 100 }, results: Array.from({ length: 8 }, (_, i) => ({ title: `Paper g${i} on surface processes`, publication_year: 2025, doi: `${base}/paper/g${i}`, abstract_inverted_index: inv(words(60, `g${i}`)), primary_location: { landing_page_url: `${base}/paper/g${i}` } })) })
        }
        return json({ meta: { count: 1 }, results: [{ title: search, doi: null, abstract_inverted_index: inv(words(60, 't')), primary_location: { landing_page_url: TITLE_URL.get(search) || '' } }] })
    }
    if (u.pathname === '/api/query') return atom(2)
    return { status: 404, type: 'text/html', body: '<html><body>not found</body></html>' }
}

/** 啟動假站台:oa.route(u, req) 可覆寫(回 undefined 則走 okRoute);oa.reqs 記每個請求之路徑、查詢、Authorization 標頭 */
function startOa(port) {
    const base = `http://127.0.0.1:${port}`
    const oa = { base, reqs: [], route: null }
    const server = http.createServer((req, res) => {
        const u = new URL(req.url, base)
        oa.reqs.push({ path: u.pathname, search: u.search, params: u.searchParams, authorization: req.headers.authorization })
        const r = (oa.route && oa.route(u, req)) || okRoute(u, base)
        res.writeHead(r.status || 200, { 'Content-Type': r.type || 'application/json' })
        res.end(r.body ?? '')
    })
    oa.close = () => new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
    })
    return new Promise((resolve, reject) => {
        server.once('error', (e) => reject(new Error(`假站台無法監聽固定埠 ${port}（${e.code || e.message}）`)))
        server.listen(port, '127.0.0.1', () => resolve(oa))
    })
}

/** 吞下 fn 期間所有 stderr 輸出並回傳(w-fetch-web 之重試行寫在 stderr;金鑰不得出現其中) */
async function withStderr(fn) {
    const errs = []
    const orig = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk) => {
        errs.push(String(chunk))
        return true
    }
    try {
        return { value: await fn(), stderr: errs.join('') }
    }
    finally {
        process.stderr.write = orig
    }
}

const noKey = (text) => !String(text).includes(KEY) && !String(text).includes(KEY_ENC)

describe('unit-capture-openalex', function() {

    const roots = []
    const rootOf = (name) => {
        const r = tmpRoot(name)
        roots.push(r)
        return r
    }
    let TMP = ''
    let KEYS = '' // 含金鑰之金鑰檔
    let NOKEY = '' // 無該變數之金鑰檔
    let oa = null
    let site = null

    before(async () => {
        TMP = rootOf('openalex')
        KEYS = `${TMP}/keys.env`
        NOKEY = `${TMP}/nokey.env`
        fs.writeFileSync(KEYS, `# 測試用金鑰檔\nOTHER_VAR=1\nOPENALEX_API_KEY="${KEY}"\nMY_OA_KEY=  other-name-key  \nEMPTY_KEY=\n`)
        fs.writeFileSync(NOKEY, 'OTHER_VAR=1\n')
        oa = await startOa(PORT)
        site = createScholarSite({ port: PORT_SITE })
        await site.start()
    })
    after(async () => {
        await oa.close()
        await site.stop()
        removeRoots(roots)
        resetConceptFold()
    })
    beforeEach(() => {
        oa.reqs.length = 0
        oa.route = null
    })

    // ══════════════════════════ OA1 設定 ══════════════════════════
    describe('OA1 設定', function() {
        it('apiKeyEnv 預設為 OPENALEX_API_KEY(變數名);改名、設空字串皆可;非字串或含非法字元於啟動期拋錯;組內其餘鍵(base、mailto)不受影響', () => {
            const d = resolveSettings({}).capture.services.openAlex
            assert.deepEqual(d, { base: 'https://api.openalex.org', mailto: '', apiKeyEnv: 'OPENALEX_API_KEY' })
            assert.equal(OPENALEX_KEY_ENV_DEFAULT, 'OPENALEX_API_KEY')
            const o = (v) => resolveSettings({ capture: { services: { openAlex: { apiKeyEnv: v } } } }).capture.services.openAlex
            assert.equal(o('MY_OA_KEY').apiKeyEnv, 'MY_OA_KEY')
            assert.equal(o('').apiKeyEnv, '', "'' 為明確不使用")
            assert.equal(o('MY_OA_KEY').base, 'https://api.openalex.org', '只給 apiKeyEnv 時 base 沿用預設')
            for (const bad of ['A-B', 'has space', 'a.b', 5, ['X'], {}]) assert.throws(() => o(bad), /apiKeyEnv/, `apiKeyEnv=${JSON.stringify(bad)}`)
            // 把金鑰「值」誤貼進變數名欄(最可能的錯誤):錯誤訊息不得回顯該值(診斷輸出與遮罩規格 D3)
            assert.throws(() => o(KEY), (e) => /apiKeyEnv/.test(e.message) && noKey(e.message) && !e.message.includes('oaTest'), '訊息不回顯所收到之值')
        })
    })

    // ══════════════════════════ OA2 金鑰讀取 ══════════════════════════
    describe('OA2 金鑰讀取', function() {
        const cap = (name) => ({ services: { openAlex: { apiKeyEnv: name } } })
        it('依 apiKeyEnv 自金鑰檔讀值(去引號與空白)回金鑰陣列;不污染 process.env;無檔、無變數、空值、變數名空、金鑰檔未給 → 空陣列(不帶金鑰)', () => {
            const before = process.env.OPENALEX_API_KEY
            assert.deepEqual(openAlexApiKeyOf(cap('OPENALEX_API_KEY'), KEYS), [KEY], '成對引號剝除,值內之 + / = 保留;單把長度 1')
            assert.deepEqual(openAlexApiKeyOf(cap('MY_OA_KEY'), KEYS), ['other-name-key'], '依設定之變數名取;值修剪空白')
            assert.equal(process.env.OPENALEX_API_KEY, before, '不寫 process.env')
            assert.deepEqual(openAlexApiKeyOf(cap('OPENALEX_API_KEY'), NOKEY), [], '檔內無此變數')
            assert.deepEqual(openAlexApiKeyOf(cap('EMPTY_KEY'), KEYS), [], '值為空')
            assert.deepEqual(openAlexApiKeyOf(cap('OPENALEX_API_KEY'), `${TMP}/not-exist.env`), [], '檔不存在')
            assert.deepEqual(openAlexApiKeyOf(cap(''), KEYS), [], "apiKeyEnv '' 即使檔內有 OPENALEX_API_KEY 亦不用")
            assert.deepEqual(openAlexApiKeyOf(cap('OPENALEX_API_KEY'), undefined), [], '未給金鑰檔')
            assert.deepEqual(openAlexApiKeyOf({}, KEYS), [], 'capture 缺 services')
        })
    })

    // ══════════════════════════ OA3 金鑰載體 ══════════════════════════
    describe('OA3 金鑰載體', function() {
        it('金鑰只在閉包:JSON.stringify／util.inspect／展開／String／Object.values 皆不含金鑰值(原形與編碼形)', () => {
            const a = createOpenAlexAuth([KEY])
            const dumps = [JSON.stringify(a), util.inspect(a, { depth: 5, showHidden: true }), JSON.stringify({ ...a }), String(a), JSON.stringify(Object.values(a).filter((v) => typeof v !== 'function')), JSON.stringify(Object.getOwnPropertyNames(a))]
            for (const d of dumps) assert.ok(noKey(d), `載體輸出不含金鑰：${d}`)
            assert.equal(a.enabled, true)
            assert.equal(JSON.stringify(a), '{"enabled":true}')
        })
        it('sign:附 api_key(值 URL 編碼);網址已有查詢用 &、無查詢用 ?;mask:原形、URL 編碼形、表單編碼形、JSON 內皆遮;無金鑰載體 sign／mask 原樣', () => {
            const a = createOpenAlexAuth([KEY])
            assert.equal(a.sign('https://x.test/works?search=a'), `https://x.test/works?search=a&api_key=${KEY_ENC}`)
            assert.equal(a.sign('https://x.test/works'), `https://x.test/works?api_key=${KEY_ENC}`)
            const text = `curl failed https://x.test/works?api_key=${KEY_ENC} raw ${KEY} form ${KEY_ENC.replace(/%20/g, '+')} json ${JSON.stringify({ k: KEY })}`
            assert.ok(noKey(a.mask(text)), a.mask(text))
            assert.match(a.mask(`?api_key=${KEY_ENC}`), /api_key=\*\*\*/)
            assert.equal(a.mask('不含金鑰之訊息'), '不含金鑰之訊息', '無關文字不動')
            assert.equal(NO_OPENALEX_AUTH.enabled, false)
            assert.equal(NO_OPENALEX_AUTH.sign('https://x.test/works?a=1'), 'https://x.test/works?a=1')
            assert.equal(NO_OPENALEX_AUTH.mask('abc'), 'abc')
            for (const v of [[], [''], ['   ', ''], [null, 5, undefined], null, undefined]) assert.equal(createOpenAlexAuth(v).enabled, false, `金鑰=${JSON.stringify(v)} → 不帶`)
            assert.equal(openAlexAuthOf({ enabled: true }), NO_OPENALEX_AUTH, '形狀不合者視同未給')
            assert.equal(openAlexAuthOf(a), a)
        })
    })

    // ══════════════════════════ OA4 請求包裝 ══════════════════════════
    describe('OA4 openAlexGet', function() {
        const mk = (results) => {
            const calls = []
            let i = 0
            const f = async (u, o) => {
                calls.push([u, o])
                return typeof results === 'function' ? results(u, o, i++) : results[Math.min(i++, results.length - 1)]
            }
            return { f, calls }
        }
        const ok = { status: 'success', html: '{"results":[]}', httpCode: 200 }
        const fail = (httpCode, extra = {}) => ({ status: 'error', httpCode, reason: 'http-error', message: `HTTP ${httpCode}`, ...extra })

        it('無金鑰:以 (url, { timeoutMs, maxRetries }) 呼叫抓取函數一次、網址不動(與加入金鑰前逐字相同);成功結果原樣回傳(同一物件)', async () => {
            const { f, calls } = mk([ok])
            const r = await openAlexGet(f, 'https://x.test/works?search=a', { timeoutMs: 1234, maxRetries: 1 })
            assert.equal(r, ok)
            assert.deepEqual(calls, [['https://x.test/works?search=a', { timeoutMs: 1234, maxRetries: 1 }]])
        })
        it('有金鑰:網址附 api_key、抓取函數一律 maxRetries:0(不經 w-fetch-web 之重試輸出);5xx／429／curl 錯誤重試至多 maxRetries 次;4xx／內容過短不重試;成功即止', async () => {
            const auth = createOpenAlexAuth([KEY], { retryWaitMs: 1 })
            for (const [first, retried] of [[fail(503), true], [fail(429), true], [{ status: 'error', reason: 'curl-error', message: 'x' }, true], [fail(404), false], [{ status: 'error', reason: 'empty-response', message: 'short', httpCode: 200 }, false], [{ status: 'error', httpCode: 0, message: 'HTTP 502' }, true]]) {
                const { f, calls } = mk([first, ok])
                const r = await openAlexGet(f, 'https://x.test/works?search=a', { auth, timeoutMs: 10, maxRetries: 1 })
                assert.equal(calls.length, retried ? 2 : 1, `${first.reason || first.message}：重試與否`)
                assert.equal(r.status, retried ? 'success' : 'error')
                for (const [u, o] of calls) assert.deepEqual([u.endsWith(`&api_key=${KEY_ENC}`), o.maxRetries, o.timeoutMs], [true, 0, 10])
            }
            const { f, calls } = mk([fail(500)])
            const r = await openAlexGet(f, 'https://x.test/works', { auth, maxRetries: 2 })
            assert.deepEqual([calls.length, r.status], [3, 'error'], 'maxRetries:2 → 共 3 次後放棄')
        })
        it('失敗結果:message／reason／url／finalUrl 遮罩金鑰;429 之 message 換固定字樣並標 quota:true(其餘失敗不標);非 429 之訊息逐字保留', async () => {
            const auth = createOpenAlexAuth([KEY])
            const leak = `Command failed: curl -s https://x.test/works?api_key=${KEY_ENC}`
            const r1 = await openAlexGet(mk([{ status: 'error', reason: 'curl-error', message: leak, url: `https://x.test/works?api_key=${KEY_ENC}`, finalUrl: leak }]).f, 'https://x.test/works', { auth, maxRetries: 0 })
            assert.ok(noKey(JSON.stringify(r1)), JSON.stringify(r1))
            assert.deepEqual([r1.reason, r1.quota], ['curl-error', undefined])
            assert.match(r1.message, /^Command failed: curl -s https:\/\/x\.test\/works\?api_key=\*\*\*/)
            const r2 = await openAlexGet(mk([fail(429, { message: `HTTP 429 https://x.test/works?api_key=${KEY_ENC}` })]).f, 'https://x.test/works', { auth, maxRetries: 0 })
            assert.deepEqual([r2.message, r2.quota, r2.httpCode], [OPENALEX_QUOTA_MESSAGE, true, 429])
            const r3 = await openAlexGet(mk([{ status: 'error', message: 'HTTP 429' }]).f, 'https://x.test/works', { maxRetries: 0 })
            assert.deepEqual([r3.message, r3.quota], [OPENALEX_QUOTA_MESSAGE, true], '無金鑰、只有訊息「HTTP 429」(無 httpCode 欄)亦判 429')
            const r4 = await openAlexGet(mk([fail(503)]).f, 'https://x.test/works', { maxRetries: 0 })
            assert.deepEqual([r4.message, r4.quota], ['HTTP 503', undefined], '非 429 之訊息逐字保留')
            assert.equal(isOpenAlexQuota(r2), true)
            assert.equal(isOpenAlexQuota(r4), false)
            assert.match(OPENALEX_QUOTA_MESSAGE, /^OpenAlex HTTP 429：.*每日額度.*每秒.*UTC 00:00/, '兩因並列(官方:每日額度或每秒上限)與重置時間')
        })
        it('抓取函數自身拋錯(自訂注入者):有金鑰者以遮罩後之訊息重拋;無金鑰者原錯誤透傳', async () => {
            const auth = createOpenAlexAuth([KEY])
            await assert.rejects(() => openAlexGet(async (u) => { throw new Error(`boom ${u}`) }, 'https://x.test/works', { auth }), (e) => noKey(e.message) && /boom https:\/\/x\.test\/works\?api_key=\*\*\*/.test(e.message))
            const boom = new Error('boom')
            await assert.rejects(() => openAlexGet(async () => { throw boom }, 'https://x.test/works', {}), (e) => e === boom)
        })
        it('OpenAlexQuotaError:固定訊息、quota:true;isOpenAlexQuota 認錯誤與結果', () => {
            const e = new OpenAlexQuotaError()
            assert.deepEqual([e.message, e.quota, e instanceof Error, isOpenAlexQuota(e)], [OPENALEX_QUOTA_MESSAGE, true, true, true])
            assert.equal(isOpenAlexQuota(new Error('x')), false)
            assert.equal(isOpenAlexQuota(null), false)
        })
    })

    // ══════════════════════════ OA5 四處請求站點 ══════════════════════════
    describe('OA5 四處請求帶金鑰、未設時不帶', function() {
        const MAILTO = 'kc@example.org'
        const gridOf = (auth, extra = {}) => createDefaultFetchers({ openAlexBase: oa.base, arxivApiBase: oa.base, openAlexMailto: MAILTO, ...(auth ? { openAlexAuth: auth } : {}), ...extra }).find((f) => f.id === 'grid')
        const areaCtx = (auth) => ({
            deps: {
                settings: settingsOf({ services: { openAlex: { base: oa.base, mailto: MAILTO } }, discover: { minHits: 30 } }),
                stores: { docs: { get: async () => null } },
                seen: { idOf: (u) => u },
                ...(auth ? { openAlexAuth: auth } : {}),
            },
        })
        /** 回溯環境:DOI 文件 nDoi 篇、題名文件 nTitle 篇 */
        const refetchEnv = (name, { nDoi = 0, nTitle = 0, deps = {}, capture = {} } = {}) => {
            const dir = `${rootOf(`openalex-${name}`)}`
            const rows = []
            for (let i = 0; i < nDoi; i++) rows.push({ id: `d${pad(i)}`, status: 'noted', textFrom: 'abstract', url: `https://doi.org/10.1000/t${pad(i)}`, title: `DOI paper ${pad(i)}`, notedAt: AT })
            for (let i = 0; i < nTitle; i++) {
                const t = `Title paper ${pad(i)} on surface processes`
                TITLE_URL.set(t, `http://hdl.handle.net/1/t${pad(i)}`)
                rows.push({ id: `t${pad(i)}`, status: 'noted', textFrom: 'abstract', url: `http://hdl.handle.net/1/t${pad(i)}`, title: t, notedAt: AT })
            }
            const log = recLog()
            const docs = memStore(rows)
            const docTexts = memStore([])
            const settings = settingsOf({ services: { openAlex: { base: oa.base, mailto: MAILTO }, arxiv: { base: oa.base } }, standards: { minTextChars: 300 }, articles: { maxTextChars: 20000 }, ...capture })
            const state = `${dir}/state`
            const base = { stores: { docs, docTexts }, dirs: { state }, clock, log, settings, ...deps }
            const ledger = () => (fs.existsSync(`${state}/${REFETCH_LEDGER_FILE}`) ? fs.readFileSync(`${state}/${REFETCH_LEDGER_FILE}`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
            return { base, log, ledger, docs, docTexts, state }
        }

        it('網格來源:有金鑰 → 請求帶 api_key(query)與 mailto,不帶 Authorization 標頭;無金鑰 → 不帶 api_key;兩者其餘查詢字串相同', async () => {
            const keyed = await gridOf(createOpenAlexAuth([KEY])).fetch({ query: 'planetary science', name: 'g', cursor: 1 }, {})
            assert.equal(keyed.length, 8)
            const q = oa.reqs[0]
            assert.equal(q.path, '/works')
            assert.deepEqual([q.params.get('api_key'), q.params.get('mailto'), q.params.get('search'), q.authorization], [KEY, MAILTO, 'planetary science', undefined])
            oa.reqs.length = 0
            await gridOf().fetch({ query: 'planetary science', name: 'g', cursor: 1 }, {})
            const plain = oa.reqs[0]
            assert.equal(plain.params.has('api_key'), false, '未設金鑰 → 不帶')
            assert.equal(plain.search, q.search.replace(`&api_key=${KEY_ENC}`, ''), '除 api_key 外查詢字串逐字相同')
            // 修前格式(逐字釘住):未設金鑰時之網格請求網址
            assert.equal(plain.search, `?search=planetary%20science&per-page=8&page=1&select=title,publication_year,doi,abstract_inverted_index,primary_location&mailto=${encodeURIComponent(MAILTO)}`)
        })

        it('領域發現驗證:有金鑰(ctx.deps.openAlexAuth 或 opt.openAlexAuth)→ 帶 api_key;無金鑰 → 不帶;修前網址逐字', async () => {
            const a = createOpenAlexAuth([KEY])
            const r1 = await validateAreaQuery('black hole spectra', areaCtx(a))
            assert.deepEqual([r1.ok, r1.count, oa.reqs[0].params.get('api_key'), oa.reqs[0].authorization], [true, 1500, KEY, undefined])
            oa.reqs.length = 0
            await validateAreaQuery('black hole spectra', areaCtx(), { openAlexAuth: a })
            assert.equal(oa.reqs[0].params.get('api_key'), KEY, 'opt.openAlexAuth 亦可')
            oa.reqs.length = 0
            const r3 = await validateAreaQuery('black hole spectra', areaCtx())
            assert.equal(r3.ok, true)
            assert.equal(oa.reqs[0].params.has('api_key'), false, '未設 → 不帶')
            assert.equal(oa.reqs[0].search, `?search=black%20hole%20spectra&per-page=8&select=id,doi,primary_location,abstract_inverted_index&mailto=${encodeURIComponent(MAILTO)}`)
        })

        it('原文回溯 DOI 批次與題名搜尋:deps.envFile(金鑰檔)有該變數 → 兩種請求皆帶 api_key;金鑰檔無該變數／未給 envFile → 皆不帶;修前網址逐字', async () => {
            const env = refetchEnv('refetch-keyed', { nDoi: 2, nTitle: 1, deps: { envFile: KEYS } })
            const r = await refetchSources(env.base, { apply: true })
            assert.deepEqual(r.outcomes, { archived: 3 })
            assert.equal(oa.reqs.length, 2, 'DOI 一批(2 篇)＋題名一次')
            for (const q of oa.reqs) assert.deepEqual([q.params.get('api_key'), q.params.get('mailto'), q.authorization], [KEY, MAILTO, undefined], `${q.search}`)
            const types = oa.reqs.map((q) => (q.params.has('filter') ? 'doi' : 'title')).sort()
            assert.deepEqual(types, ['doi', 'title'])
            for (const envFile of [NOKEY, undefined]) {
                oa.reqs.length = 0
                const e2 = refetchEnv(`refetch-plain-${envFile ? 'nokey' : 'noenv'}`, { nDoi: 2, nTitle: 1, deps: { envFile } })
                await refetchSources(e2.base, { apply: true })
                assert.equal(oa.reqs.length, 2)
                for (const q of oa.reqs) assert.equal(q.params.has('api_key'), false, `envFile=${envFile ? 'nokey' : '未給'} → 不帶`)
                const doi = oa.reqs.find((q) => q.params.has('filter'))
                assert.equal(doi.search, `?filter=${encodeURIComponent('doi:https://doi.org/10.1000/t000|https://doi.org/10.1000/t001')}&per-page=2&select=title,doi,abstract_inverted_index,primary_location&mailto=${encodeURIComponent(MAILTO)}`)
            }
            // deps.openAlexAuth 優先於 envFile;apiKeyEnv '' 即使金鑰檔有也不帶
            oa.reqs.length = 0
            const e3 = refetchEnv('refetch-auth', { nDoi: 1, deps: { openAlexAuth: createOpenAlexAuth(['direct-key']), envFile: NOKEY } })
            await refetchSources(e3.base, { apply: true })
            assert.equal(oa.reqs[0].params.get('api_key'), 'direct-key')
            oa.reqs.length = 0
            const e4 = refetchEnv('refetch-off', { nDoi: 1, deps: { envFile: KEYS }, capture: { services: { openAlex: { base: oa.base, apiKeyEnv: '' }, arxiv: { base: oa.base } } } })
            await refetchSources(e4.base, { apply: true })
            assert.equal(oa.reqs[0].params.has('api_key'), false, "apiKeyEnv '' → 不使用")
        })

        it('netGuard 探測不帶金鑰:探測端點為各 base 之原點(無路徑、無查詢);實際探測之請求無 api_key', async () => {
            const urls = netProbeUrlsOf(settingsOf({ services: { openAlex: { base: `${oa.base}/works?x=1` }, arxiv: { base: oa.base }, bingNews: { base: oa.base } } }).capture)
            assert.deepEqual(urls, [oa.base], '原點、去重')
            const g = createNetGuard({ urls, timeoutMs: 3000 })
            assert.equal((await g.check()).up, true, '探測之回應(404)算可達')
            assert.ok(oa.reqs.length >= 1)
            for (const q of oa.reqs) assert.deepEqual([q.search, q.authorization], ['', undefined])
        })

        it('金鑰載體不洩漏:createCaptureRuntime 回傳之 rt、rt.deps()、抓取器物件經 JSON／util.inspect 傾印皆不含金鑰', () => {
            const rt = createCaptureRuntime({ data: {} }, settingsOf({ services: { openAlex: { base: oa.base }, arxiv: { base: oa.base } } }), { envFile: KEYS })
            assert.equal(rt.openAlexAuth.enabled, true)
            const d = rt.deps({ docs: memStore([]) }, recLog())
            assert.equal(d.openAlexAuth, rt.openAlexAuth, '每輪依賴與抓取器共用同一載體')
            for (const v of [rt.openAlexAuth, d.openAlexAuth]) assert.ok(noKey(util.inspect(v, { depth: 6, showHidden: true })) && noKey(JSON.stringify(v)))
            assert.ok(noKey(util.inspect(rt.fetchers.map((f) => ({ id: f.id })), { depth: 4 })))
        })
    })

    // ══════════════════════════ OA6 整條接線 ══════════════════════════
    describe('OA6 整條接線(envFile → 執行期 → 抓取器)', function() {
        const rtOf = (envFile, capture = {}) => createCaptureRuntime({ data: {} }, settingsOf({ services: { openAlex: { base: oa.base, ...(capture.apiKeyEnv !== undefined ? { apiKeyEnv: capture.apiKeyEnv } : {}) }, arxiv: { base: oa.base } } }), { envFile })

        it('createCaptureRuntime:envFile 有該變數 → 網格抓取器帶金鑰;無該變數、envFile 未給、apiKeyEnv:"" → 不帶金鑰(enabled:false)', async () => {
            const grid = (rt) => rt.fetchers.find((f) => f.id === 'grid')
            const rtK = rtOf(KEYS)
            await grid(rtK).fetch({ query: 'planetary science', cursor: 1 }, {})
            assert.equal(oa.reqs[0].params.get('api_key'), KEY)
            for (const [label, rt] of [['無該變數', rtOf(NOKEY)], ['未給 envFile', rtOf(undefined)], ["apiKeyEnv ''", rtOf(KEYS, { apiKeyEnv: '' })]]) {
                oa.reqs.length = 0
                assert.equal(rt.openAlexAuth.enabled, false, label)
                assert.equal('openAlexAuth' in rt.deps({ docs: memStore([]) }, recLog()), false, `${label}：每輪依賴之欄集與加入金鑰支援前相同(僅帶金鑰時才有 openAlexAuth)`)
                await grid(rt).fetch({ query: 'planetary science', cursor: 1 }, {})
                assert.equal(oa.reqs[0].params.has('api_key'), false, label)
            }
        })

        it('flow.run():cfg.envFile(相對 workDir)之金鑰隨網格請求送出;report、info()、日誌與執行摘要檔皆不含金鑰', async () => {
            const root = rootOf('openalex-flow')
            fs.writeFileSync(`${root}/keys.env`, `OPENALEX_API_KEY=${KEY}\n`)
            const log = recLog()
            const { flow } = buildTestCapture(root, {
                log,
                envFile: 'keys.env',
                data: { gridTopics: [['行星科學', 'planetary science']] },
                capture: { services: { openAlex: { base: site.base }, arxiv: { base: site.base }, bingNews: { base: site.base } }, sources: { minIntervalMs: 0 }, areas: { perRun: 4 }, browser: { perRun: 0 } },
            })
            const rep = await flow.run()
            const grid = site.hits.filter((h) => h.startsWith('/works?search=planetary%20science&per-page=8&page=1'))
            assert.ok(grid.length >= 1, `網格請求打到本機：${site.hits.join(' | ')}`)
            assert.ok(grid.every((h) => h.includes(`&api_key=${KEY_ENC}`)), `網格請求帶金鑰：${grid[0]}`)
            const dumps = [JSON.stringify(rep), util.inspect(flow.info(), { depth: 6, maxArrayLength: null, maxStringLength: null }), log.lines.join('\n')]
            const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]))
            for (const f of walk(root).filter((p) => !/keys\.env$/.test(p) && !/[\\/]db[\\/]/.test(p))) dumps.push(fs.readFileSync(f, 'utf8'))
            for (const d of dumps) assert.ok(noKey(d), '輸出(含日誌檔、執行摘要檔)不含金鑰')
            assert.ok(dumps.length > 4, `有掃到落檔：${dumps.length}`)
        })
    })

    // ══════════════════════════ OA7 金鑰不外洩(失敗路徑) ══════════════════════════
    describe('OA7 金鑰不外洩(失敗路徑)', function() {
        const MODES = {
            // arXiv 一律回 404(4xx 不重試:不必空等 w-fetch-web 之 3 秒重試,也使 stderr 的重試行只可能出自 OpenAlex 之請求)
            http503: { works: () => ({ status: 503, type: 'text/plain', body: 'service unavailable' }), arxiv: 404 },
            http429: { works: () => json({ error: 'rate limit' }, 429), arxiv: 404 },
            nonjson: { works: () => ({ status: 200, type: 'text/html', body: `<html><body>${'maintenance '.repeat(30)}</body></html>` }), arxiv: 404 },
            // 錯誤 JSON 內回顯 api_key(置於最前使其落在「回應缺 results」之摘錄窗內)——防禦性:站方若回顯,遮罩須擋
            echo: { works: (u) => json({ error: 'echo', api_key: u.searchParams.get('api_key'), pad: 'x'.repeat(50) }), arxiv: 404 },
            refused: { dead: true },
        }
        for (const [mode, spec] of Object.entries(MODES)) {
            it(`${mode}:網格(雙供應商皆失敗)、領域驗證、回溯 DOI 批次與題名 → 拋出之錯誤、日誌、處置帳、結果、stderr 皆不含金鑰(原形與編碼形)`, async () => {
                oa.route = spec.dead ? null : (u) => (u.pathname === '/works' ? spec.works(u) : { status: spec.arxiv, type: 'text/plain', body: 'arxiv down' })
                const base = spec.dead ? DEAD : oa.base
                const auth = createOpenAlexAuth([KEY], { retryWaitMs: 5 })
                const texts = []
                const { stderr } = await withStderr(async () => {
                    // ① 網格:OpenAlex 與 arXiv 皆失敗 → 拋錯
                    const glog = recLog()
                    const grid = createDefaultFetchers({ openAlexBase: base, arxivApiBase: base, openAlexAuth: auth }).find((f) => f.id === 'grid')
                    await assert.rejects(() => grid.fetch({ query: 'planetary science', name: 'g', cursor: 1 }, { log: glog }), (e) => {
                        texts.push(e.message)
                        return true
                    })
                    texts.push(...glog.lines)
                    // ② 領域驗證
                    const ctx = { deps: { settings: settingsOf({ services: { openAlex: { base } }, discover: { minHits: 30 } }), stores: { docs: { get: async () => null } }, seen: { idOf: (u) => u }, openAlexAuth: auth } }
                    texts.push(JSON.stringify(await validateAreaQuery('black hole spectra', ctx)))
                    // ③④ 回溯 DOI 批次與題名搜尋
                    const env = (() => {
                        const dir = rootOf(`openalex-leak-${mode}`)
                        const rows = [
                            { id: 'd000', status: 'noted', textFrom: 'abstract', url: 'https://doi.org/10.1000/t000', title: 'DOI paper 000', notedAt: AT },
                            { id: 't000', status: 'noted', textFrom: 'abstract', url: 'http://hdl.handle.net/1/t000', title: 'Title paper 000 on surface processes', notedAt: AT },
                        ]
                        const log = recLog()
                        return { dir, log, deps: { stores: { docs: memStore(rows), docTexts: memStore([]) }, dirs: { state: `${dir}/state` }, clock, log, settings: settingsOf({ services: { openAlex: { base }, arxiv: { base } } }), openAlexAuth: auth } }
                    })()
                    const out = await refetchSources(env.deps, { apply: true })
                    texts.push(JSON.stringify(out), ...env.log.lines, fs.readFileSync(`${env.dir}/state/${REFETCH_LEDGER_FILE}`, 'utf8'))
                })
                const all = texts.join('\n')
                assert.ok(noKey(all), `輸出含金鑰：${all.slice(0, 600)}`)
                assert.ok(noKey(stderr), `stderr 含金鑰：${stderr}`)
                assert.ok(!/\/works/.test(stderr), `有金鑰之 OpenAlex 請求不經 w-fetch-web 之重試輸出(其重試行含網址)：${stderr}`)
                assert.ok(all.length > 200, '非空洞:各站點確有訊息可驗')
                if (mode === 'refused') assert.match(all, /api_key=\*\*\*/, 'curl 失敗訊息含網址(原含金鑰)→ 已遮罩而非被丟棄')
                if (mode === 'echo') assert.match(all, /回應缺 results.*\*\*\*/, '站方回顯金鑰時,錯誤摘錄已遮罩')
                if (mode === 'http429') assert.match(all, /OpenAlex HTTP 429/, '429 為固定訊息')
            })
        }
    })

    // ══════════════════════════ OA8 429 固定訊息 ══════════════════════════
    describe('OA8 429 固定訊息', function() {
        // 未設金鑰時走 w-fetch-web 內建重試(等 3 秒);測試以包裝強制 maxRetries:0 避免空等(僅縮短等待,不改任何其他行為)
        const fastCurl = (u, o) => fetchWebByCurl(u, { ...o, maxRetries: 0 })
        const route429 = () => {
            oa.route = (u) => (u.pathname === '/works' ? json({ error: 'rate limit' }, 429) : null)
        }

        for (const keyed of [false, true]) {
            const label = keyed ? '有金鑰' : '未設金鑰'
            const auth = () => (keyed ? createOpenAlexAuth([KEY], { retryWaitMs: 5 }) : undefined)

            it(`網格(${label}):OpenAlex 429 → 切 arXiv 取得項目;來源標 _fetchedVia:arxiv、_oaQuota:true;警告事件為固定字樣(額度非站台故障);其他失敗(404)無此標記與事件`, async () => {
                route429()
                const grid = createDefaultFetchers({ openAlexBase: oa.base, arxivApiBase: oa.base, ...(keyed ? { openAlexAuth: auth() } : { fetchWebByCurl: fastCurl }) }).find((f) => f.id === 'grid')
                const src = { query: 'planetary science', name: '行星科學', cursor: 3 }
                const log = recLog()
                const items = await grid.fetch(src, { log })
                assert.equal(items.length, 2, 'arXiv 遞補之項目')
                assert.deepEqual([src._fetchedVia, src._oaQuota], ['arxiv', true])
                const warn = log.lines.filter((l) => l.startsWith('WARN'))
                assert.equal(warn.length, 1)
                assert.ok(warn[0].includes(OPENALEX_QUOTA_MESSAGE) && /改走 arXiv/.test(warn[0]), warn[0])
                // 其他失敗:無 _oaQuota、無額度事件(行為同修前)
                oa.route = (u) => (u.pathname === '/works' ? { status: 404, type: 'text/plain', body: 'nope' } : null)
                const src2 = { query: 'planetary science', name: '行星科學', cursor: 3 }
                const log2 = recLog()
                await grid.fetch(src2, { log: log2 })
                assert.deepEqual([src2._fetchedVia, src2._oaQuota], ['arxiv', false])
                assert.ok(!log2.lines.some((l) => l.includes('429')), log2.lines.join('|'))
            })

            it(`網格(${label}):OpenAlex 429 且 arXiv 亦失敗 → 拋錯,訊息含固定字樣一次(不重複「OpenAlex OpenAlex」)與 arXiv 原因`, async () => {
                oa.route = (u) => (u.pathname === '/works' ? json({ error: 'rate limit' }, 429) : { status: 404, type: 'text/plain', body: 'arxiv down' })
                const grid = createDefaultFetchers({ openAlexBase: oa.base, arxivApiBase: oa.base, ...(keyed ? { openAlexAuth: auth() } : { fetchWebByCurl: fastCurl }) }).find((f) => f.id === 'grid')
                await assert.rejects(() => grid.fetch({ query: 'q', name: 'n' }, {}), (e) => {
                    assert.ok(e.message.startsWith(`網格雙供應商皆失敗：${OPENALEX_QUOTA_MESSAGE}；arXiv `), e.message)
                    return true
                })
            })

            it(`領域驗證(${label}):429 → reason 為固定字樣、quota:true、仍 transient(不冷卻);其他失敗之 reason 格式不變`, async () => {
                route429()
                const ctx = { deps: { settings: settingsOf({ services: { openAlex: { base: oa.base } }, discover: { minHits: 30 } }), stores: { docs: { get: async () => null } }, seen: { idOf: (u) => u }, ...(keyed ? { openAlexAuth: auth() } : {}) } }
                const r = await validateAreaQuery('black hole spectra', ctx, keyed ? {} : { fetchWebByCurl: fastCurl })
                assert.deepEqual(r, { ok: false, count: 0, abstracts: 0, overlap: 0, reason: OPENALEX_QUOTA_MESSAGE, transient: true, quota: true })
                oa.route = (u) => (u.pathname === '/works' ? { status: 404, type: 'text/plain', body: 'nope' } : null)
                const r2 = await validateAreaQuery('black hole spectra', ctx, keyed ? {} : { fetchWebByCurl: fastCurl })
                assert.deepEqual([r2.ok, r2.transient, r2.quota, r2.reason], [false, true, undefined, 'OpenAlex 驗證失敗：HTTP 404'])
            })
        }

        it('listFetch:來源物件標 _oaQuota:true → report 計 gridOaQuota:1;未標或 false → 無此計數', async () => {
            const run = async (flag) => {
                const f = W.defineFetcher({ id: 'grid', kinds: ['grid'], fetch: async (src) => {
                    src._oaQuota = flag
                    return []
                } })
                const ctx = { deps: { settings: settingsOf({}) }, log: recLog() }
                return (await composeChain([mwFetchList()])(makeMsg('source', { name: 'g', url: 'grid://openalex/q', _fetcher: f }), ctx)).msg.stats
            }
            assert.equal((await run(true)).gridOaQuota, 1)
            assert.equal((await run(false)).gridOaQuota, undefined)
            assert.equal((await run(undefined)).gridOaQuota, undefined)
        })

        it('stageListFetch:抓取器標 _oaQuota:true 之來源 → report detail.gridOaQuota 計其數;未發生時 detail 無此欄(欄集平時不變)', async () => {
            const runStage = async (flag) => {
                const log = recLog()
                const sources = memStore([{ id: 's1', name: 'S1', kind: 'rss', url: 'https://s1.example/feed', tier: 1, lastFetchAt: '', failCount: 0 }])
                const docs = memStore([])
                const fetcher = W.defineFetcher({
                    id: 'rss', kinds: ['rss'],
                    fetch: async (src) => {
                        src._oaQuota = flag
                        return [{ url: 'https://e.com/keep', title: 'K' }]
                    },
                })
                const seen = W.createSeenStore({ collection: docs, identity: W.createIdentity({ keyOf: 'raw' }), log })
                const deps = { stores: { sources, docs }, registry: { resolve: () => fetcher, label: () => 'rss' }, seen, settings: settingsOf({ sources: { perRun: 5, minIntervalMs: 0, itemsPerSource: 8, maxConsecFails: 8 }, articles: { maxTextChars: 100 } }), clock: { iso8: () => AT } }
                return (await stageListFetch({}).run({ deps, log })).detail
            }
            assert.equal((await runStage(true)).gridOaQuota, 1)
            assert.equal('gridOaQuota' in (await runStage(false)), false)
            assert.equal('gridOaQuota' in (await runStage(undefined)), false)
        })
    })

    // ══════════════════════════ OA9 原文回溯連續 429 ══════════════════════════
    describe('OA9 原文回溯:連續 429 即停、未處理不入帳、可續跑', function() {
        const fastCurl = (u, o) => fetchWebByCurl(u, { ...o, maxRetries: 0 })
        const envOf = (name, o) => {
            const dir = rootOf(`openalex-${name}`)
            const rows = []
            for (let i = 0; i < (o.nDoi || 0); i++) rows.push({ id: `d${pad(i)}`, status: 'noted', textFrom: 'abstract', url: `https://doi.org/10.1000/t${pad(i)}`, title: `DOI paper ${pad(i)}`, notedAt: AT })
            for (let i = 0; i < (o.nTitle || 0); i++) {
                const t = `Title paper ${pad(i)} on surface processes`
                TITLE_URL.set(t, `http://hdl.handle.net/1/t${pad(i)}`)
                rows.push({ id: `t${pad(i)}`, status: 'noted', textFrom: 'abstract', url: `http://hdl.handle.net/1/t${pad(i)}`, title: t, notedAt: AT })
            }
            for (let i = 0; i < (o.nArxiv || 0); i++) rows.push({ id: `a${pad(i)}`, status: 'noted', textFrom: 'abstract', url: `https://arxiv.org/abs/2301.0000${i}`, title: `Arx paper ${i}`, notedAt: AT })
            for (let i = 0; i < (o.nArticle || 0); i++) rows.push({ id: `w${pad(i)}`, status: 'noted', textFrom: 'article', url: `https://e.com/w${i}`, title: i === 0 ? '台股動量策略之長期實證研究' : '台股價值因子之長期實證研究', notedAt: AT })
            const log = recLog()
            const docs = memStore(rows)
            const docTexts = memStore([])
            const state = `${dir}/state`
            const deps = { stores: { docs, docTexts }, dirs: { state }, clock, log, settings: settingsOf({ services: { openAlex: { base: oa.base }, arxiv: { base: oa.base } }, standards: { minTextChars: 300 }, articles: { maxTextChars: 20000 } }), ...(o.deps || {}) }
            const ledger = () => (fs.existsSync(`${state}/${REFETCH_LEDGER_FILE}`) ? fs.readFileSync(`${state}/${REFETCH_LEDGER_FILE}`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
            return { deps, log, ledger, docs, docTexts, state }
        }
        const doiBatchIndex = (u) => {
            const first = (u.searchParams.get('filter') || '').slice(4).split('|')[0]
            return Math.floor(Number(first.match(/t(\d+)$/)?.[1]) / 50)
        }
        const isWorks = (u) => u.pathname === '/works'
        const q429 = { status: 429, type: 'application/json', body: '{"error":"rate limit"}' }
        // 發出之邏輯請求數(同一請求之自行重試／w-fetch-web 重試不重複計):以查詢參數值去重,未帶該參數者不計
        const distinct = (key) => new Set(oa.reqs.filter((r) => r.path === '/works').map((r) => r.params.get(key)).filter(Boolean)).size

        for (const keyed of [true, false]) {
            const label = keyed ? '有金鑰' : '未設金鑰'
            const depsOf = () => (keyed ? { openAlexAuth: createOpenAlexAuth([KEY], { retryWaitMs: 5 }) } : { fetchWebByCurl: fastCurl })

            it(`DOI 批次(${label}):200 篇 4 批,全部 429 → 連續 3 批即停(第 4 批不發請求);quotaStop 列原因與未處理 200 篇;無任何處置帳列、無另存;額度恢復後不加 retry 直接續跑 → 200 篇全數 archived`, async () => {
                const env = envOf(`s1-${keyed ? 'k' : 'n'}`, { nDoi: 200, deps: depsOf() })
                oa.route = (u) => (isWorks(u) ? q429 : null)
                const r = await refetchSources(env.deps, { apply: true })
                assert.equal(distinct('filter'), OPENALEX_QUOTA_STOP_AFTER, '只發出 3 批(第 4 批未發)')
                assert.deepEqual([r.processed, r.outcomes], [0, {}])
                assert.deepEqual([r.quotaStop.after, r.quotaStop.unprocessed, r.quotaStop.byMethod], [3, 200, { 'openalex-doi': 200 }])
                assert.match(r.quotaStop.message, /連續 3 次 429.*每日額度用盡.*UTC 00:00.*未處理 200 篇.*未入處置帳/)
                assert.deepEqual(env.ledger(), [], '遭 429 之批與未發出者皆不入處置帳')
                assert.ok(env.log.lines.some((l) => l.startsWith('WARN') && l.includes(r.quotaStop.message)), '停止事件寫入日誌')
                assert.ok(env.log.lines.some((l) => l.startsWith('INFO') && /OpenAlex 額度用盡而停止，未處理 200 篇/.test(l)), '摘要行列明')
                assert.equal((await env.docTexts.select()).length, 0)
                // 續跑:額度恢復;不加 retry——未入帳者本就是候選
                oa.route = null
                oa.reqs.length = 0
                const again = await refetchSources(env.deps, { apply: true })
                assert.deepEqual([again.candidates, again.processed, again.outcomes, again.quotaStop], [200, 200, { archived: 200 }, undefined])
                assert.equal(env.ledger().length, 200)
            })

            it(`非連續之 429(${label}):批 0、2 為 429、批 1、3 成功 → 不停止(4 批皆發出);429 兩批記 fetch-failed(why 為固定字樣,可 retry),其餘 archived;無 quotaStop`, async () => {
                const env = envOf(`s2-${keyed ? 'k' : 'n'}`, { nDoi: 200, deps: depsOf() })
                oa.route = (u) => (isWorks(u) && [0, 2].includes(doiBatchIndex(u)) ? q429 : null)
                const r = await refetchSources(env.deps, { apply: true })
                assert.equal(distinct('filter'), 4, '4 批皆發出')
                assert.equal(r.quotaStop, undefined)
                assert.deepEqual(r.outcomes, { 'fetch-failed': 100, archived: 100 })
                const led = env.ledger()
                assert.equal(led.length, 200)
                const failed = led.filter((x) => x.outcome === 'fetch-failed')
                assert.ok(failed.every((x) => x.why === OPENALEX_QUOTA_MESSAGE))
                assert.deepEqual([...new Set(failed.map((x) => Math.floor(Number(x.id.slice(1)) / 50)))].sort(), [0, 2], '遭 429 的是批 0、批 2 之文件')
                // retry 只重試 fetch-failed → 額度恢復後補齊
                oa.route = null
                const re = await refetchSources(env.deps, { apply: true, retry: true })
                assert.deepEqual([re.candidates, re.outcomes], [100, { archived: 100 }])
            })

            it(`連續 2 次 429 後成功(${label}):批 0、1 為 429、批 2、3 成功 → 不停止;批 0、1 記 fetch-failed`, async () => {
                const env = envOf(`s3-${keyed ? 'k' : 'n'}`, { nDoi: 200, deps: depsOf() })
                oa.route = (u) => (isWorks(u) && [0, 1].includes(doiBatchIndex(u)) ? q429 : null)
                const r = await refetchSources(env.deps, { apply: true })
                assert.equal(r.quotaStop, undefined)
                assert.deepEqual(r.outcomes, { 'fetch-failed': 100, archived: 100 })
                assert.ok(env.ledger().filter((x) => x.outcome === 'fetch-failed').every((x) => x.why === OPENALEX_QUOTA_MESSAGE))
            })

            it(`DOI 與題名跨段連續(${label}):DOI 2 批 + 題名 4 篇,全部 429 → 第 3 次(題名第 1 篇)即停;未處理 = DOI 100 + 題名 4 = 104,不入帳`, async () => {
                const env = envOf(`s4-${keyed ? 'k' : 'n'}`, { nDoi: 100, nTitle: 4, deps: depsOf() })
                oa.route = (u) => (isWorks(u) ? q429 : null)
                const r = await refetchSources(env.deps, { apply: true })
                assert.equal(distinct('filter'), 2)
                assert.equal(distinct('search'), 1, '題名搜尋只發出第 1 篇(第 3 次連續 429 即停,其餘 3 篇未發)')
                assert.deepEqual([r.processed, r.quotaStop.unprocessed, r.quotaStop.byMethod], [0, 104, { 'openalex-doi': 100, 'openalex-title': 4 }])
                assert.deepEqual(env.ledger(), [])
            })
        }

        // ── 以替身網路層驗計數規則(確定性、不發請求)──
        const stubNet = (script) => {
            const calls = { arxiv: 0, doi: 0, title: [], article: [] }
            return {
                calls,
                net: {
                    arxiv: async (ids) => {
                        calls.arxiv++
                        return new Map(ids.map((id) => [id, { title: 'Arx paper 0', abstract: ABS }]))
                    },
                    openalexDoi: async () => {
                        const s = script.doi?.(calls.doi++)
                        if (s === 'quota') throw new OpenAlexQuotaError()
                        return new Map()
                    },
                    openalexTitle: async (title) => {
                        const s = script.title?.(calls.title.length)
                        calls.title.push(title)
                        if (s === 'quota') throw new OpenAlexQuotaError()
                        if (s === 'boom') throw new Error('HTTP 失敗：HTTP 500')
                        const url = TITLE_URL.get(title) || ''
                        return [{ title, abstract: ABS, url }]
                    },
                    article: async (url) => {
                        calls.article.push(url)
                        return { ok: true, title: 'x', content: BODY(url.endsWith('w0') ? '台股動量策略之長期實證研究' : '台股價值因子之長期實證研究') }
                    },
                },
            }
        }

        it('停止只及 OpenAlex:DOI 1 批 429 + 題名連續 429 → 第 3 次即停(題名只發 2 篇);arXiv 與網頁照常處理;未處理 = DOI 1 + 題名 5 = 6', async () => {
            const { net, calls } = stubNet({ doi: () => 'quota', title: () => 'quota' })
            const env = envOf('s5', { nDoi: 1, nTitle: 5, nArxiv: 1, nArticle: 2, deps: { refetch: net } })
            const r = await refetchSources(env.deps, { apply: true })
            assert.deepEqual([calls.arxiv, calls.doi, calls.title.length, calls.article.length], [1, 1, 2, 2], 'arXiv 先行;DOI 1 次、題名 2 次(連續第 2、3 次)後停;網頁照常')
            assert.deepEqual([r.quotaStop.unprocessed, r.quotaStop.byMethod], [6, { 'openalex-doi': 1, 'openalex-title': 5 }])
            assert.deepEqual(r.outcomes, { archived: 3 }, 'arXiv 1 + 網頁 2')
            const ids = env.ledger().map((x) => x.id).sort()
            assert.deepEqual(ids, ['a000', 'w000', 'w001'], '處置帳只有已處理者')
        })

        it('連續計數被其他結果打斷:題名序列 429,429,500,429,429,成功 → 不停止;打斷前之 2 筆 429 與打斷者各記 fetch-failed(429 者 why 為固定字樣),結尾之 2 筆 429 殘餘亦記 fetch-failed', async () => {
            const seq = ['quota', 'quota', 'boom', 'quota', 'quota', 'ok']
            const { net, calls } = stubNet({ title: (i) => seq[i] })
            const env = envOf('s6', { nTitle: 6, deps: { refetch: net } })
            const r = await refetchSources(env.deps, { apply: true })
            assert.equal(calls.title.length, 6, '6 篇皆發出,未誤停')
            assert.equal(r.quotaStop, undefined)
            const by = Object.fromEntries(env.ledger().map((x) => [x.id, x]))
            assert.deepEqual(Object.keys(by).sort(), ['t000', 't001', 't002', 't003', 't004', 't005'])
            for (const id of ['t000', 't001', 't003', 't004']) assert.deepEqual([by[id].outcome, by[id].why], ['fetch-failed', OPENALEX_QUOTA_MESSAGE], id)
            assert.deepEqual([by.t002.outcome, by.t002.why], ['fetch-failed', 'HTTP 失敗：HTTP 500'])
            assert.equal(by.t005.outcome, 'archived')
        })

        it('結尾之連續 429 未達門檻(題名 2 次 429 即結束)→ 不停止、2 筆各記 fetch-failed(固定字樣);恰達 3 次 → 停止且 3 筆不入帳', async () => {
            const two = stubNet({ title: () => 'quota' })
            const e2 = envOf('s7a', { nTitle: 2, deps: { refetch: two.net } })
            const r2 = await refetchSources(e2.deps, { apply: true })
            assert.equal(r2.quotaStop, undefined)
            assert.deepEqual(e2.ledger().map((x) => [x.outcome, x.why]), [['fetch-failed', OPENALEX_QUOTA_MESSAGE], ['fetch-failed', OPENALEX_QUOTA_MESSAGE]])
            const three = stubNet({ title: () => 'quota' })
            const e3 = envOf('s7b', { nTitle: 3, deps: { refetch: three.net } })
            const r3 = await refetchSources(e3.deps, { apply: true })
            assert.deepEqual([r3.quotaStop.unprocessed, three.calls.title.length, e3.ledger()], [3, 3, []])
        })

        it('預演(不給 apply)不發請求、無 quotaStop;既有 outcomes 形狀不變', async () => {
            const { net, calls } = stubNet({ title: () => 'quota' })
            const env = envOf('s8', { nTitle: 4, deps: { refetch: net } })
            const r = await refetchSources(env.deps, {})
            assert.deepEqual([r.candidates, r.processed, r.quotaStop, calls.title.length], [4, 0, undefined, 0])
        })
    })
})
