// unit-capture-areas.test.mjs — 領域清單與自動擴充(領域發現、品質回饋、冷卻重探、來源同步、投影)＋孤兒瀏覽器回收＋線索留痕＋grid 分頁／名額
// 不發網路、不呼叫真 AI:curl 與 AI 皆注入替身;另以本機假 OpenAI 相容伺服器(固定埠 8821)走真 adapter 一次(stageAreas × 真 AI 調度層)
// 執行:自套件根 node <mocha> --timeout 180000 test/unit-capture-areas.test.mjs(暫存 test/_tmp/capture-areas-<pid>,測完即刪)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import W from 'w-data-pipeline/src/WDataPipeline.mjs'
import { memStore } from './tools/memStore.mjs'
import { deepMerge } from './tools/captureTestKit.mjs'
import { recLog } from './tools/testKit.mjs'
import { startServer, rest, mkAdapter } from './tools/fakeRest.mjs'
import { stageListFetch } from '../src/stages/listFetchStage.mjs'
import { setConceptFold } from '../src/core/util/text.mjs'
import { findOrphans, sweepOrphanBrowsers } from '../src/core/ops/browserHygiene.mjs'
import { stageHygiene } from '../src/stages/hygieneStage.mjs'
import { saveClues, clueKey } from '../src/core/stores/frontierPolicy.mjs'
import { areaIdOf, gridSourceOf, syncSeedAreas, syncAreaSources, coveringArea, pickAreaCandidates, areaQualityCfgOf, reviewAutoAreas, reprobeAutoAreas, renderAreasMd, setAreaStatus, AREA_META_ID, areaCountsOf, activeAreaCount } from '../src/stores/areaPolicy.mjs'
import { ensureSeedSources, pickDueSources, cullZeroYieldSources } from '../src/stores/sourcePolicy.mjs'
import { judgeFromDocs } from '../src/stages/collectHelpers.mjs'
import { createAreaDomain, sanitizeAreaQuery, AREA_CONTRACT } from '../src/domain/areaDomain.mjs'
import { stageAreas, AREA_AI_BUDGET_MS, writeAreasProjection } from '../src/stages/areaStage.mjs'
import { stageSeedSync } from '../src/stages/seedSyncStage.mjs'
import { createDefaultFetchers } from '../src/fetchers/defaultFetchers.mjs'
import { CAPTURE_DEFAULT, resolveSettings } from '../src/core/settingsDefault.mjs'
import { docRecord, sourceId } from '../src/core/util/records.mjs'
import { expandSeeds, gridSourceUrl } from '../src/fetchers/endpoints.mjs'

const NOW = '2026-10-04T08:00:00+08:00'
const NOW_MS = Date.parse(NOW)
const TMP = path.resolve(`test/_tmp/capture-areas-${process.pid}`)
/** U+FFFD(Unicode 取代字元;亂碼之特徵字元) */
const FFFD = '\uFFFD'
const ts = (iso) => Date.parse(iso)
/** 抓取預設之 extraPatchOf(grid 翻頁;capture.sources 之函數葉) */
const { extraPatchOf } = CAPTURE_DEFAULT.sources

describe('unit-capture-areas', function() {

    before(() => {
        setConceptFold(null)
        fs.mkdirSync(TMP, { recursive: true })
    })
    after(() => {
        setConceptFold(null)
        fs.rmSync(TMP, { recursive: true, force: true })
    })

    // ── 孤兒瀏覽器回收 ──
    describe('browserHygiene', () => {
        const P = (name, pid, ppid, created, cmd = '') => ({ name, pid, ppid, createdMs: ts(created), cmd })
        const procs = [
            P('explorer.exe', 100, 4, '2026-10-01T00:00:00Z'),
            P('node.exe', 200, 100, '2026-10-04T00:00:00Z', 'node C:\\app\\run.mjs'),
            // 系統 Chrome＋Playwright 標記＋父死 → 殺
            P('chrome.exe', 300, 999, '2026-10-03T00:00:00Z', '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir=C:\\Users\\u\\AppData\\Local\\Temp\\playwright_chromiumdev_profile-AbC --remote-debugging-pipe'),
            P('chrome.exe', 301, 300, '2026-10-03T00:00:01Z', '"C:\\...\\chrome.exe" --type=renderer --user-data-dir=C:\\...\\playwright_chromiumdev_profile-AbC'),
            // 使用者自己的 Chrome(無標記;父死亦不殺)
            P('chrome.exe', 400, 998, '2026-09-24T00:00:00Z', '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"'),
            // Camofox server(反斜線路徑)＋父死 → 殺;父存活者不殺
            P('node.exe', 500, 997, '2026-10-03T00:00:00Z', 'node C:\\app\\node_modules\\@askjo\\camofox-browser\\server.js'),
            P('node.exe', 501, 200, '2026-10-04T00:00:01Z', 'node C:\\app\\node_modules\\@askjo\\camofox-browser\\server.js'),
            // camoufox 內容行程(ExecutablePath 讀不到,以命令列辨識)＋父死 → 殺
            P('camoufox.exe', 600, 996, '2026-09-25T00:00:00Z', '"C:\\Users\\u\\AppData\\Local\\camoufox\\camoufox\\Cache\\camoufox.exe" -contentproc'),
            // PID 重用:父 PID 存在但其建立晚於子 → 視為父死 → 殺
            P('node.exe', 700, 800, '2026-10-02T00:00:00Z', 'node C:\\app\\node_modules\\w-knowledge-capture\\fetchers\\fetch_web_cli.mjs https://e.com/a'),
            P('svchost.exe', 800, 4, '2026-10-03T12:00:00Z'),
            // 本套件 CLI,父(node 200)存活 → 不殺
            P('node.exe', 702, 200, '2026-10-04T00:00:02Z', 'node C:\\app\\node_modules\\w-knowledge-capture\\fetchers\\fetch_web_cli.mjs https://e.com/b'),
            // 父為非目標映像(python)且存活 → 不殺
            P('python.exe', 900, 100, '2026-10-04T00:00:00Z'),
            P('chrome.exe', 901, 900, '2026-10-04T00:00:01Z', '--user-data-dir=C:\\T\\playwright_chromiumdev_profile-X'),
        ]

        it('findOrphans:系統 Chrome 以 Playwright 標記辨識、使用者 Chrome 不入列;反斜線 Camofox 路徑;camoufox 命令列;PID 重用視為父死;只列根', () => {
            const o = findOrphans(procs)
            assert.deepEqual(o.map((x) => [x.pid, x.target]).sort((a, b) => a[0] - b[0]), [[300, 'playwright-chrome'], [500, 'camofox-server'], [600, 'camoufox'], [700, 'fetch-cli']])
        })

        it('sweepOrphanBrowsers:殺根並重列回驗;仍存在者列 failed;dryRun 只列不殺', async () => {
            const killed = []
            let alive = procs.map((p) => p.pid)
            const list = async () => procs.filter((p) => alive.includes(p.pid))
            const kill = async (pid) => {
                killed.push(pid)
                if (pid !== 600) alive = alive.filter((x) => x !== pid && procs.find((p) => p.pid === x)?.ppid !== pid) // 600 模擬殺不掉
            }
            const r = await sweepOrphanBrowsers({ listProcesses: list, killTree: kill })
            assert.deepEqual(killed.sort((a, b) => a - b), [300, 500, 600, 700])
            assert.deepEqual(r.killed.map((x) => x.pid).sort((a, b) => a - b), [300, 500, 700])
            assert.deepEqual(r.failed.map((x) => x.pid), [600])
            const dry = await sweepOrphanBrowsers({ listProcesses: async () => procs, killTree: async () => assert.fail('dryRun 不可殺'), dryRun: true })
            assert.equal(dry.orphans.length, 4)
            // filter:只回收指定時窗內誕生者(實網測試收拾自己留下之孤兒,不動之前即存在者)
            const since = ts('2026-10-02T12:00:00Z')
            const win = await sweepOrphanBrowsers({ listProcesses: async () => procs, killTree: async () => assert.fail('dryRun 不可殺'), dryRun: true, filter: (o) => o.createdMs >= since })
            assert.deepEqual(win.orphans.map((x) => x.pid).sort((a, b) => a - b), [300, 500])
        })

        it('孤兒 Chrome 之暫存 profile:只刪已回驗殺除者之 --user-data-dir(暫存目錄直屬子目錄＋Playwright 前綴);存活者、暫存目錄外、殺不掉者皆不動', async () => {
            const tmp = path.join(TMP, 'os-tmp')
            const mk = (name) => {
                const d = path.join(tmp, name)
                fs.mkdirSync(path.join(d, 'Default'), { recursive: true })
                fs.writeFileSync(path.join(d, 'Default', 'Preferences'), '{}')
                return d
            }
            const dead1 = mk('playwright_chromiumdev_profile-K1') // 孤兒、可殺 → 刪
            const dead2 = mk('playwright_chromiumdev_profile-K2') // 孤兒、殺不掉 → 不刪
            const live = mk('playwright_chromiumdev_profile-L1') // 父存活 → 不刪
            const outside = path.join(TMP, 'elsewhere', 'playwright_chromiumdev_profile-O1') // 暫存目錄外 → 不刪
            fs.mkdirSync(outside, { recursive: true })
            const ps = [
                P('explorer.exe', 100, 4, '2026-10-01T00:00:00Z'),
                P('chrome.exe', 310, 990, '2026-10-03T00:00:00Z', `"C:\\chrome.exe" --no-first-run --user-data-dir="${dead1}" --remote-debugging-pipe`),
                P('chrome.exe', 311, 991, '2026-10-03T00:00:00Z', `"C:\\chrome.exe" --user-data-dir=${dead2}`),
                P('chrome.exe', 312, 100, '2026-10-03T00:00:00Z', `"C:\\chrome.exe" --user-data-dir=${live}`),
                P('chrome.exe', 313, 992, '2026-10-03T00:00:00Z', `"C:\\chrome.exe" --user-data-dir=${outside}`),
            ]
            let alive = ps.map((p) => p.pid)
            const r = await sweepOrphanBrowsers({
                listProcesses: async () => ps.filter((p) => alive.includes(p.pid)),
                killTree: async (pid) => { if (pid !== 311) alive = alive.filter((x) => x !== pid) },
                tmpDir: tmp,
            })
            assert.deepEqual(r.killed.map((x) => x.pid).sort(), [310, 313])
            assert.deepEqual(r.profiles.removed, [path.resolve(dead1)], '只刪已殺孤兒於暫存目錄內之 profile(引號包住之路徑亦可解析)')
            assert.equal(fs.existsSync(dead1), false)
            assert.ok(fs.existsSync(dead2) && fs.existsSync(live) && fs.existsSync(outside), '殺不掉者、存活者、暫存目錄外者皆保留')
        })

        it('stageHygiene:預設依 settings.capture.browser.hygiene(未開即不掃);開啟時回報殺除數;殺不掉者 report.ok=false 並 WARN', async () => {
            const log = recLog()
            const off = await stageHygiene({ listProcesses: async () => assert.fail('不可掃') }).run({ deps: { settings: { capture: {} } }, log })
            assert.equal(off.detail.disabled, true)
            const off2 = await stageHygiene({ listProcesses: async () => assert.fail('不可掃') }).run({ deps: { settings: resolveSettings({}) }, log })
            assert.equal(off2.detail.disabled, true, '套件預設 capture.browser.hygiene 為 false')
            const r = await stageHygiene({ listProcesses: async () => procs.slice(0, 5), killTree: async () => {} }).run({ deps: { settings: { capture: { browser: { hygiene: true } } } }, log })
            assert.equal(r.ok, false, '殺後重列仍在(替身清單不變)→ 失敗揭露')
            assert.ok(log.lines.some((l) => /^WARN 孤兒瀏覽器回收：殺除後仍存在 playwright-chrome pid 300/.test(l)), log.lines.join('\n'))
        })
    })

    // ── 線索留痕 ──
    describe('saveClues(來源文件留痕)', () => {
        it('合併時累積 refs(上限)與 distinctDocs;同文件重做不重複計;done 者再被提及不復活但照計', async () => {
            const f = memStore()
            await saveClues(f, [{ type: 'keyword', value: 'momentum crash' }], { fromRef: 'doc:a', nowIso: NOW })
            await saveClues(f, [{ type: 'keyword', value: 'momentum crash' }], { fromRef: 'doc:b', nowIso: NOW })
            await saveClues(f, [{ type: 'keyword', value: 'momentum crash' }], { fromRef: 'doc:b', nowIso: NOW })
            let c = (await f.select())[0]
            assert.deepEqual([c.hits, c.distinctDocs, c.refs], [3, 2, ['doc:a', 'doc:b']])
            await f.patch(c.id, { status: 'done' })
            await saveClues(f, [{ type: 'keyword', value: 'momentum crash' }], { fromRef: 'skip:c', nowIso: NOW })
            c = (await f.select())[0]
            assert.deepEqual([c.status, c.distinctDocs, c.lastSeenAt], ['done', 3, NOW])
        })

        it('檢定標準 CS9／CS11／CS12:格式不合逐因計數(型別、值空、過長、網址格式、網址不見於材料);site 須見於材料(網址或主機,去 www.);關鍵詞／主題值轉正體(id 不變);未給材料不檢 CS11', async () => {
            const f = memStore()
            const r = await saveClues(f, [
                { type: 'bogus', value: 'x' },
                { type: 'keyword', value: '' },
                { type: 'topic', value: 'x'.repeat(121) },
                { type: 'site', value: 'example.com/blog' },
                { type: 'site', value: 'https://www.quant-blog.example/posts' },
                { type: 'site', value: 'https://made-up.example/' },
                { type: 'keyword', value: 'GJR-GARCH杠杆效應' },
            ], { fromRef: 'doc:a', nowIso: NOW, groundText: '本文參考 quant-blog.example 之系列文章' })
            assert.deepEqual(r.dropped, { type: 1, empty: 1, long: 1, site: 1, ungrounded: 1 })
            assert.deepEqual([r.addCount, r.toTw], [2, 1])
            const vals = (await f.select()).map((x) => x.value).sort()
            assert.deepEqual(vals, ['GJR-GARCH槓桿效應', 'https://www.quant-blog.example/posts'])
            assert.equal((await f.select()).find((x) => x.type === 'keyword').id, clueKey('keyword', 'GJR-GARCH槓桿效應'), 'id 由入庫之正體值算出(正式組裝另有 cn→tw 鍵折疊,簡繁同鍵)')
            const r2 = await saveClues(memStore(), [{ type: 'site', value: 'https://made-up.example/' }], { nowIso: NOW })
            assert.deepEqual([r2.addCount, r2.dropped.ungrounded], [1, 0], '未給材料 → 不檢')
        })
    })

    // ── grid:耗盡轉追新、結構驗證、遞補分頁、名額、新件率 ──
    describe('grid 分頁與名額', () => {
        const gridOf = (stub) => createDefaultFetchers({ fetchWebByCurl: stub, openAlexBase: 'http://oa.test', arxivApiBase: 'http://ax.test' }).find((f) => f.id === 'grid')
        const work = (i) => ({ title: `W${i}`, publication_year: 2025, doi: `https://doi.org/10.1/${i}`, abstract_inverted_index: Object.fromEntries('a b c d e f g h i j k l m n o p q r s t u v w x y z alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega one two three four five six seven eight nine ten'.split(' ').map((w, k) => [`${w}${i}`, [k]])) })

        it('回補模式:端點基底可注入;空頁(page>1)或達總數 → 標 _exhausted;extraPatchOf 轉 fresh 模式、不再前進 cursor', async () => {
            const urls = []
            const g = gridOf(async (u) => {
                urls.push(u)
                return { status: 'success', html: JSON.stringify({ meta: { count: 100 }, results: [] }) }
            })
            const src = { kind: 'grid', query: 'pairs trading', cursor: 5 }
            const items = await g.fetch(src)
            assert.deepEqual(items, [])
            assert.ok(urls[0].startsWith('http://oa.test/works?search=pairs%20trading&per-page=8&page=5'))
            assert.equal(src._exhausted, true)
            assert.deepEqual(Object.keys(extraPatchOf(src, { ok: true })).sort(), ['cursor', 'exhaustedAt', 'mode'])
            assert.equal(extraPatchOf(src, { ok: true }).mode, 'fresh')
            const fr = { kind: 'grid', query: 'pairs trading', mode: 'fresh', _fetchedVia: 'openalex' }
            assert.deepEqual(extraPatchOf(fr, { ok: true }), {}, 'fresh 模式不前進 cursor')
            const ok = { kind: 'grid', cursor: 2, _fetchedVia: 'openalex' }
            assert.deepEqual(extraPatchOf(ok, { ok: true }), { cursor: 3 })
        })

        it('fresh 模式:依出版日由新到舊取第 1 頁;回應缺 results 之 JSON 不得判耗盡,改走 arXiv 遞補(遞補依 cursor 分頁)', async () => {
            const urls = []
            const g = gridOf(async (u) => {
                urls.push(u)
                if (u.startsWith('http://oa.test')) return { status: 'success', html: JSON.stringify({ error: 'rate limited' }) }
                return { status: 'success', html: '<feed></feed>' }
            })
            const src = { kind: 'grid', query: 'q x', cursor: 3 }
            await g.fetch(src)
            assert.equal(src._exhausted, undefined, '錯誤 JSON 不判耗盡')
            assert.equal(src._fetchedVia, 'arxiv')
            assert.match(urls[1], /^http:\/\/ax\.test\/api\/query\?.*&start=16&max_results=8$/)
            const g2 = gridOf(async (u) => {
                urls.push(u)
                return { status: 'success', html: JSON.stringify({ meta: { count: 5 }, results: [work(1)] }) }
            })
            const items = await g2.fetch({ kind: 'grid', query: 'q x', mode: 'fresh', cursor: 9 })
            assert.equal(items.length, 1)
            assert.match(urls[urls.length - 1], /&page=1&sort=publication_date:desc/)
        })

        it('檢定標準 CS1d／CS10:grid 摘要之略過逐因計數(短於 250 字、亂碼、無網址;OpenAlex 與 arXiv 兩路同一判準 gridAbstractCheck)於來源訊息 _dropped 並記日誌(不靜默剔除);listFetch 計入 report detail.dropped;入庫之 grid 摘要直入 raw 並記 paraKeys(CS10 全部入口)', async () => {
            const lg = recLog()
            const short = { doi: 'https://doi.org/10.1/s', abstract_inverted_index: { too: [0], short: [1] } }
            const moji = { doi: 'https://doi.org/10.1/m', abstract_inverted_index: { ...work(2).abstract_inverted_index, [FFFD.repeat(20)]: [60] } }
            const noUrl = { doi: '', primary_location: { landing_page_url: 'ftp://x.example/a' }, abstract_inverted_index: work(3).abstract_inverted_index }
            const g = gridOf(async () => ({ status: 'success', html: JSON.stringify({ meta: { count: 100 }, results: [work(1), short, moji, noUrl] }) }))
            const src = { kind: 'grid', name: '網格甲', query: 'q', cursor: 1 }
            const items = await g.fetch(src, { log: lg })
            assert.deepEqual(items.map((x) => x.url), ['https://doi.org/10.1/1'])
            // 規則:略過逐因計數(不靜默)並見於日誌
            assert.deepEqual(src._dropped, { short: 1, mojibake: 1, noUrl: 1 })
            assert.ok(lg.lines.includes('INFO 網格[網格甲] OpenAlex 略過 3 篇（摘要短於 250 字 1、亂碼 1、無網址 1）'), lg.lines.join('\n'))
            // arXiv 遞補路:同一判準與計數(無 id 者記無網址)
            const SUM = 'Momentum strategies earn excess returns across asset classes and survive transaction costs. '.repeat(4)
            const entry = (id, sum) => `<entry>${id ? `<id>http://arxiv.org/abs/${id}v1</id>` : ''}<title>T</title><summary>${sum}</summary><published>2024-01-01T00:00:00Z</published></entry>`
            const ax = gridOf(async (u) => (u.startsWith('http://oa.test') ? { status: 'error', message: 'HTTP 429' } : { status: 'success', html: `<feed>${entry('2401.00001', SUM)}${entry('', SUM)}${entry('2401.00002', 'short summary')}</feed>` }))
            const src2 = { kind: 'grid', name: '網格乙', query: 'q2' }
            assert.equal((await ax.fetch(src2, { log: lg })).length, 1)
            assert.deepEqual([src2._fetchedVia, src2._dropped], ['arxiv', { short: 1, mojibake: 0, noUrl: 1 }])
            assert.ok(lg.lines.includes('INFO 網格[網格乙] arXiv 略過 2 篇（摘要短於 250 字 1、亂碼 0、無網址 1）'), lg.lines.join('\n'))
            // listFetch:略過計數入 report detail;入庫之 grid 摘要直入 raw(textFrom abstract)並記段落雜湊
            const docs = memStore()
            const sources = memStore([{ id: 'g1', kind: 'grid', name: '網格甲', query: 'q', tier: 2, lastFetchAt: '', failCount: 0 }])
            const seen = W.createSeenStore({ collection: docs, identity: W.createIdentity({ keyOf: 'raw' }), log: lg })
            const deps = { stores: { sources, docs }, registry: { resolve: () => g, label: () => 'grid' }, seen, clock: { iso8: () => NOW }, settings: resolveSettings({ capture: { sources: { perRun: 5, minIntervalMs: 0, itemsPerSource: 8, maxConsecFails: 8 }, areas: { perRun: 3 }, articles: { maxTextChars: 20000 } } }) }
            const r = await stageListFetch().run({ deps, log: lg })
            assert.deepEqual([r.detail.dropped, r.detail.newDocs, r.detail.invalid, r.detail.filtered, r.detail.sameContent], [{ short: 1, mojibake: 1, noUrl: 1 }, 1, 0, 0, 0])
            const d = (await docs.select())[0]
            assert.deepEqual([d.status, d.textFrom, Array.isArray(d.paraKeys)], ['raw', 'abstract', true])
        })

        it('pickDueSources:paused 一律不挑(與 enabled 分屬不同擁有者);filter 分池;listFetch 之 grid 名額與 rss 分開', async () => {
            const s = memStore([
                { id: 'r1', kind: 'rss', tier: 1, lastFetchAt: '' },
                { id: 'r2', kind: 'rss', tier: 3, lastFetchAt: '' },
                { id: 'g1', kind: 'grid', tier: 2, lastFetchAt: '' },
                { id: 'g2', kind: 'grid', tier: 2, lastFetchAt: '', paused: true },
            ])
            assert.deepEqual((await pickDueSources(s, { minIntervalMs: 0 })).map((x) => x.id), ['r1', 'g1', 'r2'])
            assert.deepEqual((await pickDueSources(s, { minIntervalMs: 0, limit: 1, filter: (x) => x.kind !== 'grid' })).map((x) => x.id), ['r1'])
            assert.deepEqual((await pickDueSources(s, { minIntervalMs: 0, filter: (x) => x.kind === 'grid' })).map((x) => x.id), ['g1'])
        })
    })

    // ── 領域清單 ──
    describe('areaPolicy', () => {
        const TOPICS = [['已實現波動率預測', 'realized volatility forecasting'], ['配對交易與統計套利', 'pairs trading statistical arbitrage']]

        it('areaIdOf＝其 grid 來源 id(既有網格來源之 cursor 與統計原樣保留);gridSourceOf 與 expandSeeds 之 grid 段同形', () => {
            const seeds = expandSeeds({ gridTopics: TOPICS }, { nowIso: NOW })
            const a = { id: areaIdOf(TOPICS[0][1]), label: TOPICS[0][0], query: TOPICS[0][1], origin: 'seed' }
            const g = gridSourceOf(a, { nowIso: NOW })
            assert.equal(a.id, seeds[0].id)
            for (const k of ['id', 'kind', 'tier', 'name', 'url', 'query', 'lang', 'origin']) assert.deepEqual(g[k], seeds[0][k], k)
            assert.equal(a.id, sourceId('grid', gridSourceUrl(TOPICS[0][1])))
        })

        it('syncSeedAreas:冪等新增;種子檔移除 → retired(可逆);改名同步;manual 狀態不覆寫(CS7)', async () => {
            const areas = memStore()
            let r = await syncSeedAreas(areas, TOPICS, { nowIso: NOW })
            assert.equal(r.added, 2)
            r = await syncSeedAreas(areas, TOPICS, { nowIso: NOW })
            assert.deepEqual(r, { added: 0, revived: 0, retired: 0, relabeled: 0 })
            r = await syncSeedAreas(areas, [TOPICS[0]], { nowIso: NOW })
            assert.equal(r.retired, 1)
            const id2 = areaIdOf(TOPICS[1][1])
            assert.equal((await areas.get(id2)).status, 'retired')
            r = await syncSeedAreas(areas, [['波動率預測（改名）', TOPICS[0][1]], TOPICS[1]], { nowIso: NOW })
            assert.deepEqual([r.revived, r.relabeled], [1, 1])
            await areas.patch(id2, { status: 'paused', statusBy: 'manual' })
            await syncSeedAreas(areas, [TOPICS[0]], { nowIso: NOW })
            assert.equal((await areas.get(id2)).status, 'paused', 'manual 不被種子同步覆寫')
        })

        it('syncSeedAreas:網格主題形狀錯(字串項、缺查詢、物件形)即拋錯,且先於任何寫入——不建垃圾領域,既有種子領域不因「不在清單」而被退役', async () => {
            const areas = memStore()
            await syncSeedAreas(areas, TOPICS, { nowIso: NOW })
            const before = JSON.stringify(await areas.select())
            for (const bad of [['volatility forecasting'], [['只有標籤']], [{ label: '甲', query: 'alpha beta' }], [TOPICS[0], 'x']]) {
                await assert.rejects(() => syncSeedAreas(areas, bad, { nowIso: NOW }), /cfg\.data\.gridTopics\[\d\] 須為 \[標籤, 查詢\] 字串對/, JSON.stringify(bad))
            }
            assert.equal(JSON.stringify(await areas.select()), before, '拋錯前無任何寫入')
        })

        it('syncAreaSources:active 補入來源;非 active → 來源 paused(只寫 paused,不碰 enabled);恢復清除', async () => {
            const areas = memStore()
            const sources = memStore([{ id: areaIdOf(TOPICS[1][1]), kind: 'grid', enabled: false, query: TOPICS[1][1] }])
            await syncSeedAreas(areas, TOPICS, { nowIso: NOW })
            let r = await syncAreaSources(sources, areas, { nowIso: NOW, ensure: ensureSeedSources })
            assert.equal(r.added, 1)
            await areas.patch(areaIdOf(TOPICS[0][1]), { status: 'paused' })
            r = await syncAreaSources(sources, areas, { nowIso: NOW, ensure: ensureSeedSources })
            assert.equal(r.paused, 1)
            const s0 = await sources.get(areaIdOf(TOPICS[0][1]))
            assert.deepEqual([s0.paused, s0.enabled], [true, true])
            assert.equal((await sources.get(areaIdOf(TOPICS[1][1]))).enabled, false, '品質政策停用者不被領域同步改寫')
            await areas.patch(areaIdOf(TOPICS[0][1]), { status: 'active' })
            r = await syncAreaSources(sources, areas, { nowIso: NOW, ensure: ensureSeedSources })
            assert.equal(r.resumed, 1)
        })

        it('coveringArea:複合種子標籤以正規化互含判覆蓋;英文線索比對查詢;retired／rejected 不算', () => {
            const areas = [{ label: '已實現波動率預測', query: 'realized volatility forecasting', status: 'active' }, { label: '退役', query: 'tail risk hedging', status: 'retired' }]
            assert.ok(coveringArea('波動率', areas))
            assert.ok(coveringArea('realized volatility', areas))
            assert.equal(coveringArea('tail risk', areas), null)
            assert.equal(coveringArea('市場情緒', areas), null)
        })

        it('pickAreaCandidates:主概念支持數(窗內、扣除既有領域 grid 文件)與成長;線索以相異文件數;覆蓋與冷卻中已拒者排除;兩類各取半', () => {
            const day = (d) => new Date(NOW_MS - d * 86400_000).toISOString()
            const mk = (i, concept, d, docId = `d${i}`) => ({ id: `n${i}`, title: `T${i}`, concepts: [concept, '次概念'], createdAt: day(d), docId })
            const notes = [
                ...Array.from({ length: 25 }, (_, i) => mk(i, '市場情緒', 5)),
                ...Array.from({ length: 10 }, (_, i) => mk(100 + i, '市場情緒', 40)),
                ...Array.from({ length: 30 }, (_, i) => mk(200 + i, '波動率', 3)), // 已被種子領域涵蓋
                ...Array.from({ length: 25 }, (_, i) => mk(300 + i, '利率期限結構', 2, `g${i}`)), // 全來自既有領域 grid 文件
                ...Array.from({ length: 22 }, (_, i) => mk(400 + i, '市場效率', 1)),
            ]
            const gridId = areaIdOf('realized volatility forecasting')
            const areas = [
                { id: gridId, label: '已實現波動率預測', query: 'realized volatility forecasting', status: 'active' },
                { id: 'rj', label: '市場效率', status: 'rejected', cooldownUntil: new Date(NOW_MS + 86400_000).toISOString() },
            ]
            const clues = [
                { type: 'keyword', value: 'order book imbalance', distinctDocs: 4, status: 'done' },
                { type: 'keyword', value: 'one-off', hits: 1, status: 'pending' },
                { type: 'site', value: 'https://x.com', hits: 9 },
            ]
            const c = pickAreaCandidates({ notes, docSourceOf: (id) => (/^g/.test(id) ? gridId : 'rss1'), clues, areas }, { nowMs: NOW_MS, windowDays: 30, minSupport: 20, minClueDocs: 3, limit: 8 })
            assert.deepEqual(c.map((x) => [x.label, x.kind]), [['市場情緒', 'concept'], ['order book imbalance', 'clue']])
            assert.equal(c[0].support, 25)
            assert.equal(c[0].growth, 2.5)
        })

        it('areaQualityCfgOf:品質門檻自 settings.capture.sources(lowYieldRate、cullMinJudged)與 settings.capture.areas(minFreshRate)取,與來源政策同一組;缺組不拋(各值 undefined)', () => {
            const s = resolveSettings({ capture: { sources: { lowYieldRate: 0.25, cullMinJudged: 9 }, areas: { minFreshRate: 0.4 } } })
            assert.deepEqual(areaQualityCfgOf(s), { lowYieldRate: 0.25, minJudged: 9, minFreshRate: 0.4 })
            const d = areaQualityCfgOf(resolveSettings({}))
            assert.deepEqual(d, { lowYieldRate: CAPTURE_DEFAULT.sources.lowYieldRate, minJudged: CAPTURE_DEFAULT.sources.cullMinJudged, minFreshRate: CAPTURE_DEFAULT.areas.minFreshRate })
            assert.deepEqual(areaQualityCfgOf({}), { lowYieldRate: undefined, minJudged: undefined, minFreshRate: undefined })
            assert.deepEqual(areaQualityCfgOf(undefined), { lowYieldRate: undefined, minJudged: undefined, minFreshRate: undefined })
            assert.deepEqual(areaQualityCfgOf({ capture: { sources: 'x' } }), { lowYieldRate: undefined, minJudged: undefined, minFreshRate: undefined }, '非物件之組視為缺')
        })

        it('reviewAutoAreas:低產出(沿用來源政策 capture.sources 之門檻)或冗餘(近 5 次新件率均值低)→ 暫停;種子領域與已停用來源不動', () => {
            const areas = [
                { id: 'a1', origin: 'auto', status: 'active' },
                { id: 'a2', origin: 'auto', status: 'active' },
                { id: 'a3', origin: 'seed', status: 'active' },
                { id: 'a4', origin: 'auto', status: 'active' },
            ]
            const src = new Map([
                ['a1', { judged: 50, yielded: 1 }],
                ['a2', { judged: 2, yielded: 1, freshHist: [0, 0.1, 0, 0.1, 0] }],
                ['a3', { judged: 50, yielded: 0 }],
                ['a4', { enabled: false, judged: 50, yielded: 0 }],
            ])
            assert.deepEqual(reviewAutoAreas(areas, src, { lowYieldRate: 0.1, minJudged: 6, minFreshRate: 0.2 }).map((x) => x.id), ['a1', 'a2'])
        })

        it('setAreaStatus(維運):manual 暫停／恢復同步來源 paused;恢復時重新啟用被品質政策停用之來源', async () => {
            const id = areaIdOf('q one')
            const stores = { areas: memStore([{ id, label: '甲', query: 'q one', status: 'active', origin: 'auto' }]), sources: memStore([{ id, enabled: false, failCount: 8 }]) }
            let r = await setAreaStatus(stores, '甲', 'paused', { reason: '測試', nowIso: NOW })
            assert.equal(r.ok, true)
            assert.deepEqual([(await stores.areas.get(id)).statusBy, (await stores.sources.get(id)).paused], ['manual', true])
            r = await setAreaStatus(stores, id, 'active', { nowIso: NOW })
            const s = await stores.sources.get(id)
            assert.deepEqual([s.paused, s.enabled, s.failCount], [false, true, 0])
            assert.equal((await setAreaStatus(stores, 'nope', 'paused')).ok, false)
        })

        it('CS7 手動恢復開新觀察窗:恢復前之舊判定不再讓品質回饋立刻暫停;新窗內樣本足量而仍低產出才再暫停(試抓)', async () => {
            const id = areaIdOf('q two')
            const stores = {
                areas: memStore([{ id, label: '乙', query: 'q two', status: 'paused', statusBy: 'auto', origin: 'auto', reason: '低產出' }]),
                sources: memStore([{ id, kind: 'grid', enabled: true, paused: true, judged: 50, yielded: 1, freshHist: [0, 0, 0, 0, 0] }]),
            }
            const old = Array.from({ length: 50 }, (_, i) => ({ id: `o${i}`, sourceId: id, status: i ? 'skip' : 'noted', notedAt: '2026-09-20T00:00:00+08:00' }))
            await setAreaStatus(stores, id, 'active', { nowIso: NOW })
            const s0 = await stores.sources.get(id)
            assert.deepEqual([s0.windowFrom, s0.judged, s0.yielded, s0.freshHist, (await stores.areas.get(id)).windowFrom], [NOW, 0, 0, [], NOW])
            // 下一輪:產出統計只計窗內(cullSources 之同一算法)→ 舊判定不計 → 品質回饋不暫停
            const round = async (docs) => {
                const since = new Map((await stores.sources.select()).filter((s) => s.windowFrom).map((s) => [s.id, s.windowFrom]))
                const j = judgeFromDocs(docs, { since })
                await cullZeroYieldSources(stores.sources, (s) => j[s.id], { minJudged: 6, nowIso: NOW })
                const src = new Map((await stores.sources.select()).map((s) => [s.id, s]))
                return reviewAutoAreas(await stores.areas.select(), src, { lowYieldRate: 0.1, minJudged: 6, minFreshRate: 0.2 }).map((x) => x.id)
            }
            assert.deepEqual(await round(old), [], '恢復前之 50 篇舊判定不再計入')
            // 新窗內 7 篇皆無產出 → 樣本足量而低產出 → 照常暫停(恢復不豁免品質政策)
            const fresh = Array.from({ length: 7 }, (_, i) => ({ id: `n${i}`, sourceId: id, status: 'skip', notedAt: '2026-10-05T00:00:00+08:00' }))
            assert.deepEqual(await round([...old, ...fresh.slice(0, 5)]), [], '窗內 5 篇未達 minJudged')
            const s1 = await stores.sources.get(id)
            assert.deepEqual([s1.judged, s1.yielded], [5, 0])
            assert.deepEqual(await round([...old, ...fresh]), [], '零產出淘汰先把來源停用(enabled false):已停用來源之領域不在此暫停,交來源重探')
            assert.equal((await stores.sources.get(id)).enabled, false)
        })

        it('領域冷卻重探(對稱於 CS5 之來源冷卻重探,同一冷卻判定;CS7:手動暫停、種子不在此列;每輪上限、最久者先):被品質回饋暫停之自動領域冷卻期滿重探;stageAreas 轉 active、來源開新窗', async () => {
            const at = (d) => new Date(NOW_MS - d * 86400_000).toISOString()
            const areas = [
                { id: 'p1', origin: 'auto', status: 'paused', statusBy: 'auto', pausedAt: at(31) },
                { id: 'p0', origin: 'auto', status: 'paused', statusBy: 'auto', pausedAt: at(45) },
                { id: 'p2', origin: 'auto', status: 'paused', statusBy: 'auto', pausedAt: at(31), reprobes: 1 },
                { id: 'm', origin: 'auto', status: 'paused', statusBy: 'manual', pausedAt: at(90) },
                { id: 's', origin: 'seed', status: 'paused', statusBy: 'auto', pausedAt: at(90) },
            ]
            assert.deepEqual(reprobeAutoAreas(areas, { nowMs: NOW_MS, reprobeDays: 30, reprobePerRun: 1 }).map((a) => a.id), ['p0'])
            assert.deepEqual(reprobeAutoAreas(areas, { nowMs: NOW_MS, reprobeDays: 30, reprobePerRun: 5 }).map((a) => a.id), ['p0', 'p1'])
            assert.deepEqual(reprobeAutoAreas(areas, { nowMs: NOW_MS, reprobeDays: 30, reprobePerRun: 0 }), [])
            // stageAreas ①′:轉 active、來源開新窗;暫停時刻未記者先補記
            const id = areaIdOf('q three')
            const id2 = areaIdOf('q four')
            const deps = {
                stores: {
                    areas: memStore([{ id, label: '丙', query: 'q three', origin: 'auto', status: 'paused', statusBy: 'auto', reason: '冗餘', pausedAt: at(31) }, { id: id2, label: '丁', query: 'q four', origin: 'auto', status: 'paused', statusBy: 'auto' }]),
                    sources: memStore([{ id, kind: 'grid', enabled: true, paused: true, judged: 40, yielded: 2, freshHist: [0, 0, 0, 0, 0] }]),
                    notes: memStore(), docs: memStore(), frontier: memStore(),
                },
                settings: resolveSettings({ capture: { discover: { everyHours: 0, newPerDay: 0 }, areas: { maxActive: 60, minFreshRate: 0.2 }, sources: { lowYieldRate: 0.1, cullMinJudged: 6, reprobeDays: 30, reprobePerRun: 3 } } }),
                clock: { iso8: () => NOW }, dirs: { knowledge: TMP }, data: { vocab: null },
            }
            const log = recLog()
            const r = await stageAreas({ now: () => NOW_MS }).run({ deps, log })
            assert.equal(r.detail.reprobed, 1)
            const a = await deps.stores.areas.get(id)
            assert.deepEqual([a.status, a.statusBy, a.reprobes, a.windowFrom, a.reason], ['active', 'auto', 1, NOW, ''])
            const s = await deps.stores.sources.get(id)
            assert.deepEqual([s.paused, s.enabled, s.windowFrom, s.judged, s.freshHist], [false, true, NOW, 0, []], '來源隨領域恢復(paused 由同步清除)且開新窗')
            assert.equal((await deps.stores.areas.get(id2)).pausedAt, NOW, '暫停時刻未記者以首次觀察為起點')
            assert.ok(log.lines.some((l) => /自動領域 丙 暫停冷卻期滿，重探（第 1 次；原因：冗餘）/.test(l)))
        })

        it('renderAreasMd:列狀態、模式、產出率、新件率;已拒候選另列', () => {
            const id = areaIdOf('q')
            const md = renderAreasMd([{ id, label: '甲', query: 'q', origin: 'auto', status: 'active', evidence: { kind: 'concept', candidate: '甲概念' } }, { id: 'r', label: '乙', status: 'rejected' }],
                new Map([[id, { judged: 10, yielded: 4, freshHist: [0.5, 0.7], mode: 'fresh' }]]), { nowIso: NOW })
            assert.match(md, /\| 甲 \| q \| 自動 \| active \| 追新 \| 10 \| 0\.40 \| 0\.60 \| 主概念「甲概念」 \|/)
            assert.match(md, /冷卻中之已拒候選 1 個：乙/)
        })

        it('writeAreasProjection(領域子階段每輪末與維運工具同一寫法):讀領域(中繼記錄不列)與 grid 來源,寫 <dirs.knowledge>/areas.md(內容＝renderAreasMd);回傳絕對路徑與所讀之列', async () => {
            const id = areaIdOf('q')
            const areas = memStore([{ id: AREA_META_ID, lastDiscoverAt: NOW }, { id, label: '甲', query: 'q', origin: 'auto', status: 'active' }])
            const sources = memStore([{ id, kind: 'grid', judged: 10, yielded: 4, freshHist: [], mode: '' }, { id: 'rss1', kind: 'rss' }])
            const dirs = { knowledge: path.join(TMP, 'projection', 'knowledge') }
            const r = await writeAreasProjection({ areas, sources }, dirs, { nowIso: NOW })
            assert.equal(r.file, path.resolve(dirs.knowledge, 'areas.md'))
            assert.deepEqual(r.areas.map((a) => a.id), [id], '中繼記錄不列')
            assert.deepEqual([...r.sourcesById.keys()], [id], '只取 grid 來源')
            assert.equal(fs.readFileSync(r.file, 'utf8'), renderAreasMd(r.areas, r.sourcesById, { nowIso: NOW }))
        })

        it('areaCountsOf(外部巡檢與維運同用之領域統計):啟用依來歷、暫停／退役／已拒、啟用而來源已停用(與 activeAreaCount 同一判準)、追新之 grid 來源數、種子產出監測(給門檻才判);中繼記錄不計', () => {
            const areas = [
                { id: AREA_META_ID, lastDiscoverAt: NOW },
                { id: 's1', origin: 'seed', status: 'active', label: '低產出種子' },
                { id: 's2', origin: 'seed', status: 'active', label: '來源停用種子' },
                { id: 'a1', origin: 'auto', status: 'active', label: '自動' },
                { id: 'a2', origin: 'auto', status: 'paused' },
                { id: 's3', origin: 'seed', status: 'retired' },
                { id: 'c1', origin: 'auto', status: 'rejected' },
            ]
            const src = new Map([
                ['s1', { id: 's1', enabled: true, judged: 10, yielded: 0, mode: 'fresh' }],
                ['s2', { id: 's2', enabled: false }],
                ['a1', { id: 'a1', enabled: true, judged: 10, yielded: 5 }],
            ])
            const q = { lowYieldRate: 0.1, minJudged: 6, minFreshRate: 0.2 }
            assert.deepEqual(areaCountsOf(areas, src, { areaQuality: q }), { seed: 2, auto: 1, paused: 1, retired: 1, rejected: 1, sourceDisabled: 1, fresh: 1, seedWatch: [{ id: 's1', label: '低產出種子', reason: '低產出（已判定 10、產出 0）' }] })
            assert.deepEqual(areaCountsOf(areas, src).seedWatch, [], '未給門檻不判')
            assert.equal(areaCountsOf(areas, src).seed + areaCountsOf(areas, src).auto - areaCountsOf(areas, src).sourceDisabled, activeAreaCount(areas, src), '啟用上限之計數與本統計同一判準')
            assert.deepEqual(areaCountsOf(null, null, 'bad'), { seed: 0, auto: 0, paused: 0, retired: 0, rejected: 0, sourceDisabled: 0, fresh: 0, seedWatch: [] })
        })
    })

    describe('areaDomain', () => {
        it('sanitizeAreaQuery:去引號／括號／布林運算子;英文 2～6 詞(檢定標準 CS8:契約單一來源 AREA_CONTRACT)', () => {
            assert.equal(sanitizeAreaQuery('"market sentiment" AND (stock returns)'), 'market sentiment stock returns')
            assert.equal(sanitizeAreaQuery('single'), '')
            assert.equal(sanitizeAreaQuery('a b c d e f g'), '', '逾 6 詞')
            assert.equal(sanitizeAreaQuery('a b c d e f'), 'a b c d e f')
            assert.equal(sanitizeAreaQuery('市場 情緒'), '', '非英文')
            assert.equal(sanitizeAreaQuery('GJR-GARCH volatility 2008'), 'GJR-GARCH volatility 2008')
            assert.deepEqual(AREA_CONTRACT, { labelMin: 2, labelMax: 16, queryMinWords: 2, queryMaxWords: 6, queryMaxChars: 80 })
        })
        it('buildPrompt 含候選證據與既有領域、契約數字取自 AREA_CONTRACT;isValidItem 驗 index／covered／why(必填,含 covered:true)／label 字數／query(CS8)', () => {
            const d = createAreaDomain({ vocab: { domain: '機器學習' } })
            const p = d.buildPrompt([{ label: '市場情緒', kind: 'concept', support: 25, growth: 2.5, samples: [{ title: '情緒指標' }] }], [{ label: '甲', query: 'q' }])
            assert.ok(p.includes('「機器學習」知識庫') && p.includes('【市場情緒】') && p.includes('- 甲（q）'))
            assert.ok(p.includes('label（繁體中文領域名，2～16 字）') && p.includes('英文關鍵字 2～6 個詞') && p.includes('每一項都要給 why'))
            assert.equal(d.isValidItem({ index: 1, covered: true, why: '已由甲涵蓋' }, 1), true)
            assert.equal(d.isValidItem({ index: 1, covered: true }, 1), false, 'covered:true 亦須理由')
            assert.equal(d.isValidItem({ index: 1, covered: false, label: '市場情緒與報酬', query: 'investor sentiment returns', why: '高支持' }, 1), true)
            assert.equal(d.isValidItem({ index: 1, covered: false, label: '市場情緒與報酬', query: 'investor sentiment returns' }, 1), false, '缺理由')
            assert.equal(d.isValidItem({ index: 1, covered: false, label: '一二三四五六七八九十一二三四五六七', query: 'investor sentiment returns', why: 'x' }, 1), false, '標籤逾 16 字')
            assert.equal(d.isValidItem({ index: 1, covered: false, label: '市場情緒', query: 'x', why: 'x' }, 1), false)
            assert.equal(d.isValidItem({ index: 2, covered: true, why: 'x' }, 1), false)
        })
        it('提示詞可覆寫:createAreaDomain({ buildPrompt }) 取代內建提示詞(收到候選、既有領域與 { kbLabel, domain, contract });輸出驗證與查詢淨化不隨之改變;非函數或未回非空字串即拋;AREA_CONTRACT 凍結(CS8)', () => {
            let seen = null
            const d = createAreaDomain({
                vocab: { domain: '機器學習' },
                buildPrompt: (candidates, areas, ctx) => {
                    seen = { candidates, areas, ctx }
                    return `自訂：${candidates.length}／${areas.length}`
                },
            })
            assert.equal(d.buildPrompt([{ label: 'X' }], [{ label: 'A', query: 'a b' }]), '自訂：1／1')
            assert.deepEqual([seen.ctx.kbLabel, seen.ctx.domain], ['「機器學習」知識庫', '機器學習'])
            assert.equal(seen.ctx.contract, AREA_CONTRACT)
            // 輸出驗證不隨覆寫改變(契約單一來源;覆寫者須依 ctx.contract 要求模型輸出)
            assert.equal(d.isValidItem({ index: 1, covered: true, why: '已涵蓋' }, 1), true)
            assert.equal(d.isValidItem({ index: 1, covered: false, label: '市場情緒與報酬', query: 'investor sentiment returns' }, 1), false, '缺理由仍被擋')
            assert.equal(d.sanitizeQuery('"a b" AND (c)'), 'a b c')
            assert.throws(() => createAreaDomain({ buildPrompt: 'x' }), /opt\.buildPrompt 須為函數/)
            assert.throws(() => createAreaDomain({ buildPrompt: () => '  ' }).buildPrompt([], []), /須回傳非空字串/)
            assert.ok(createAreaDomain({ buildPrompt: null }).buildPrompt([], []).includes('抓取領域規劃員'), 'null 視為未給')
            // ctx.defaultPrompt＝內建提示詞函數:覆寫者可包裝(前後加句)而不必重寫全文;包裝結果之內建部分與未覆寫者逐字同
            const plain = createAreaDomain({ vocab: { domain: '機器學習' } })
            const wrapped = createAreaDomain({ vocab: { domain: '機器學習' }, buildPrompt: (c, a, ctx) => `前言\n${ctx.defaultPrompt(c, a)}` })
            const cands = [{ label: 'X', kind: 'concept', support: 30, growth: 1.2, samples: [] }]
            assert.equal(wrapped.buildPrompt(cands, []), `前言\n${plain.buildPrompt(cands, [])}`)
            assert.equal(typeof seen.ctx.defaultPrompt, 'function')
            // 契約凍結:覆寫者只能讀
            assert.equal(Object.isFrozen(AREA_CONTRACT), true)
            assert.throws(() => { AREA_CONTRACT.labelMax = 99 }, TypeError)
            assert.equal(AREA_CONTRACT.labelMax, 16)
        })
        it('預設(無 vocab)不限主題:提示詞無主題範圍句、稱呼為「知識庫」;vocab.kbLabel 優先於由 domain 推導之稱呼;vocab 含不認得之鍵拋錯(不靜默)', () => {
            const cand = [{ label: '圖神經網路', kind: 'concept', support: 25, growth: 2.5, samples: [{ title: 'T' }] }]
            const p0 = createAreaDomain().buildPrompt(cand, [])
            assert.ok(p0.includes('你是知識庫的抓取領域規劃員') && !p0.includes('主題範圍'))
            const p1 = createAreaDomain({ vocab: { domain: '天文學', kbLabel: '星空知識庫' } }).buildPrompt(cand, [])
            assert.ok(p1.includes('你是星空知識庫的抓取領域規劃員') && p1.includes('本知識庫之主題範圍為「天文學」'))
            assert.throws(() => createAreaDomain({ vocab: { kbLable: 'x' } }), /vocab 含不認得之鍵：kbLable/)
        })
    })

    describe('stageAreas(發現與回饋)', () => {
        /**
         * 領域子階段之測試環境(curl 與 AI 皆注入替身)
         *
         * @param {Object} [opt={}] 輸入 { areas, sources, clues(初始線索), cap(遞迴覆寫 settings.capture;形狀同 cfg.capture), ai(prompt → AI 回傳資料), oa(OpenAlex 回應本體),
         *   noNotes(不開 stores.notes), noCallAI(不注入 callAI,走 ctx.deps.ai.callJson), stageOpt(追加之子階段 opt) }
         * @returns {Object} 回傳 { deps, st, calls:{ ai, curl, urls, opts, prompt }, areas, sources, frontier, log }(deps.settings 為 resolveSettings 之完整設定)
         */
        const env = (opt = {}) => {
            const day = (d) => new Date(NOW_MS - d * 86400_000).toISOString()
            const notes = memStore(Array.from({ length: 25 }, (_, i) => ({ id: `n${i}`, title: `T${i}`, concepts: ['市場情緒'], createdAt: day(3), docId: `d${i}` })))
            const docs = memStore([...Array.from({ length: 25 }, (_, i) => ({ id: `d${i}`, status: 'noted', sourceId: 'rss1' })), { id: 'known', status: 'noted' }])
            const areas = memStore(opt.areas || [])
            const sources = memStore(opt.sources || [])
            const frontier = memStore(opt.clues || [])
            const cap = {
                services: { openAlex: { base: 'http://oa.test' } },
                areas: { openAlexFields: '', maxActive: 60, minFreshRate: 0.2 },
                discover: { everyHours: 24, windowDays: 30, minSupport: 20, minClueDocs: 3, candidatesPerCall: 8, minHits: 200, newPerDay: 2, rejectCooldownDays: 30 },
                sources: { itemsPerSource: 8, lowYieldRate: 0.1, cullMinJudged: 6 },
            }
            const results = Array.from({ length: 8 }, (_, i) => ({ doi: `https://doi.org/10.9/${i}`, abstract_inverted_index: Object.fromEntries(Array.from({ length: 30 }, (_, k) => [`w${k}`, [k]])) }))
            const calls = { ai: 0, curl: 0, urls: [], opts: null, prompt: '' }
            const stores = { notes, docs, areas, sources, frontier }
            if (opt.noNotes) delete stores.notes
            const deps = {
                stores,
                settings: resolveSettings({ capture: deepMerge(cap, opt.cap) }),
                clock: { iso8: () => NOW },
                dirs: { knowledge: TMP },
                seen: { idOf: (u) => (u.endsWith('/0') ? 'known' : `id:${u}`) },
                data: { vocab: null },
            }
            const st = stageAreas({
                now: () => NOW_MS,
                ...(opt.noCallAI ? {} : {
                    callAI: async (p, check, x) => {
                        calls.ai++
                        calls.opts = x
                        calls.prompt = p
                        const data = opt.ai ? opt.ai(p) : [{ index: 1, covered: false, label: '市場情緒與報酬', query: 'investor sentiment stock returns', why: '主概念高支持且未涵蓋' }]
                        return check(data) ? { ok: true, data } : { ok: false, error: 'check failed' }
                    },
                }),
                fetchWebByCurl: async (u) => {
                    calls.curl++
                    calls.urls.push(u)
                    return { status: 'success', html: JSON.stringify(opt.oa || { meta: { count: 1200 }, results }) }
                },
                ...(opt.stageOpt || {}),
            })
            return { deps, st, calls, areas, sources, frontier, log: recLog() }
        }

        it('到期 → 候選 → AI 判覆蓋與查詢 → OpenAlex 驗證通過 → 新增 auto 領域＋grid 來源、投影 areas.md;24 小時內不重發現(_meta 持久化)', async () => {
            const e = env()
            const ctx = { deps: e.deps, log: e.log }
            const r = await e.st.run(ctx)
            assert.deepEqual([r.detail.discovered, r.detail.candidates, r.detail.added, e.calls.ai], [true, 1, 1, 1])
            const id = areaIdOf('investor sentiment stock returns')
            const a = await e.areas.get(id)
            assert.deepEqual([a.origin, a.status, a.statusBy, a.evidence.candidate, a.validation.count], ['auto', 'active', 'auto', '市場情緒', 1200])
            const src = await e.sources.get(id)
            assert.deepEqual([src.kind, src.tier, src.origin, src.query], ['grid', 2, 'area:auto', 'investor sentiment stock returns'])
            assert.ok(fs.readFileSync(path.join(TMP, 'areas.md'), 'utf8').includes('市場情緒與報酬'))
            const meta = await e.areas.get(AREA_META_ID)
            assert.deepEqual([meta.addedToday, meta.lastDiscoverAt], [1, NOW])
            const r2 = await e.st.run(ctx)
            assert.deepEqual([r2.detail.discovered, r2.detail.skipped, e.calls.ai], [false, '未到發現間隔', 1])
        })

        it('驗證未過(計數不足／首頁已在庫過半)→ 記已拒＋冷卻、不建來源;AI 判已涵蓋者亦冷卻;AI 失敗 → 不新增、下一窗口再試(無關鍵詞退路)', async () => {
            const low = env({ oa: { meta: { count: 50 }, results: [] } })
            const r = await low.st.run({ deps: low.deps, log: low.log })
            assert.deepEqual([r.detail.added, r.detail.rejected], [0, 1])
            const rej = (await low.areas.select()).find((x) => x.status === 'rejected')
            assert.match(rej.reason, /驗證未過：計數 50 < 200/)
            assert.ok(Date.parse(rej.cooldownUntil) > NOW_MS)
            assert.equal((await low.sources.select()).length, 0)
            const cov = env({ ai: () => [{ index: 1, covered: true, why: '與既有重疊' }] })
            const rc = await cov.st.run({ deps: cov.deps, log: cov.log })
            assert.deepEqual([rc.detail.added, rc.detail.rejected], [0, 1])
            const bad = env({ ai: () => 'not json' })
            const rb = await bad.st.run({ deps: bad.deps, log: bad.log })
            assert.deepEqual([rb.detail.added, rb.detail.rejected, bad.calls.curl], [0, 0, 0])
            assert.ok(bad.log.lines.some((l) => /^WARN 領域發現：AI 判定失敗/.test(l)))
        })

        it('CS6 已拒查詢冷卻期滿 → 同查詢再被提出即重驗:通過轉 active(同 id、清冷卻)、未過延長冷卻;冷卻中者不重驗(不打 OpenAlex)', async () => {
            const id = areaIdOf('investor sentiment stock returns')
            const rejected = (cooldownUntil, candidate = '市場情緒') => ({ id, label: '市場情緒與報酬', query: 'investor sentiment stock returns', candidate, origin: 'auto', status: 'rejected', statusBy: 'auto', reason: '驗證未過：計數 50 < 200', cooldownUntil, createdAt: '2026-08-01T00:00:00.000Z' })
            const past = new Date(NOW_MS - 86400_000).toISOString()
            // 冷卻期滿＋驗證通過 → 同一筆轉 active(建立時刻保留、冷卻清空)、補建 grid 來源
            const ok = env({ areas: [rejected(past)] })
            const r = await ok.st.run({ deps: ok.deps, log: ok.log })
            assert.deepEqual([r.detail.added, r.detail.rejected, ok.calls.curl], [1, 0, 1])
            const a = await ok.areas.get(id)
            assert.deepEqual([a.status, a.statusBy, a.cooldownUntil, a.createdAt, a.validation.count], ['active', 'auto', '', '2026-08-01T00:00:00.000Z', 1200])
            assert.equal((await ok.sources.get(id))?.kind, 'grid')
            assert.ok(ok.log.lines.some((l) => /冷卻期滿重驗通過，啟用自動領域「市場情緒與報酬」/.test(l)))
            // 冷卻期滿＋驗證仍不過 → 仍為已拒、冷卻延長
            const again = env({ areas: [rejected(past)], oa: { meta: { count: 50 }, results: [] } })
            const r2 = await again.st.run({ deps: again.deps, log: again.log })
            assert.deepEqual([r2.detail.added, r2.detail.rejected], [0, 1])
            const b = await again.areas.get(id)
            assert.equal(b.status, 'rejected')
            assert.ok(Date.parse(b.cooldownUntil) > NOW_MS)
            // 冷卻中(他概念提出同一查詢)→ 視為已存在、不重驗
            const cool = env({ areas: [rejected(new Date(NOW_MS + 86400_000).toISOString(), '別的概念')] })
            const r3 = await cool.st.run({ deps: cool.deps, log: cool.log })
            assert.deepEqual([r3.detail.added, r3.detail.proposed, cool.calls.curl], [0, 1, 0])
            assert.equal((await cool.areas.get(id)).status, 'rejected')
        })

        it('守門:每日上限、啟用上限、整輪剩餘不足皆略過發現(不呼叫 AI);自動領域品質回饋每輪照做', async () => {
            const id = areaIdOf('old auto query')
            const e = env({
                cap: { areas: { maxActive: 1 } },
                areas: [{ id, label: '舊自動', query: 'old auto query', origin: 'auto', status: 'active', statusBy: 'auto' }],
                sources: [{ id, kind: 'grid', judged: 50, yielded: 1 }],
            })
            const r = await e.st.run({ deps: e.deps, log: e.log })
            assert.equal(r.detail.paused, 1, '低產出自動領域暫停')
            assert.equal((await e.areas.get(id)).status, 'paused')
            assert.equal((await e.sources.get(id)).paused, true, '其來源同步暫停')
            const e2 = env({ cap: { discover: { newPerDay: 0 } } })
            const r2 = await e2.st.run({ deps: e2.deps, log: e2.log })
            assert.deepEqual([r2.detail.skipped, e2.calls.ai], ['自動發現停用', 0])
            // 整輪剩餘不足 25 分 → 略過、不呼叫 AI
            const e3 = env()
            const r3 = await e3.st.run({ deps: e3.deps, log: e3.log, remainingMs: () => 24 * 60_000 })
            assert.deepEqual([r3.detail.skipped, e3.calls.ai], ['整輪剩餘時間不足', 0])
        })

        it('零件庫用法:capture.discover.ai 為 null → 發現略過(INFO 一行、不呼叫 AI、不驗證),品質回饋與來源同步照跑;opt.validate 注入驗證器(取代 OpenAlex:不打 curl)——未過者記已拒附其 reason、過者啟用', async () => {
            // 規則:stages/areaStage.stageAreas 之 JSDoc(opt.validate)與發現步之守門(無席位);core/settingsDefault discover.ai 之 seatOrNull
            const none = env({ cap: { discover: { ai: null } } })
            const r0 = await none.st.run({ deps: none.deps, log: none.log })
            assert.deepEqual([r0.detail.skipped, none.calls.ai, none.calls.curl, r0.detail.sourcesAdded], ['未設領域發現席位（capture.discover.ai 為 null）', 0, 0, 0])
            assert.ok(none.log.lines.some((l) => /^INFO 領域發現略過：未設領域發現席位（capture\.discover\.ai 為 null）/.test(l)), none.log.lines.join('\n'))
            const seen = []
            const no = env({ stageOpt: { validate: async (query, ctx, o) => {
                seen.push([query, typeof ctx.deps, typeof o.validate])
                return { ok: false, reason: '宿主自驗：目錄查無' }
            } } })
            const r1 = await no.st.run({ deps: no.deps, log: no.log })
            assert.deepEqual([r1.detail.added, r1.detail.rejected, no.calls.curl, no.calls.ai], [0, 1, 0, 1])
            assert.deepEqual(seen, [['investor sentiment stock returns', 'object', 'function']], '驗證器收 (query, ctx, opt)')
            assert.match((await no.areas.select()).find((x) => x.status === 'rejected').reason, /^驗證未過：宿主自驗：目錄查無$/)
            const yes = env({ stageOpt: { validate: async () => ({ ok: true, count: 7 }) } })
            const r2 = await yes.st.run({ deps: yes.deps, log: yes.log })
            assert.deepEqual([r2.detail.added, yes.calls.curl], [1, 0])
            assert.deepEqual((await yes.areas.get(areaIdOf('investor sentiment stock returns'))).validation, { count: 7, abstracts: undefined, overlap: undefined })
        })

        it('OpenAlex 驗證之設定接線:禮貌池信箱取自 settings.capture.services.openAlex.mailto(與網格抓取器、原文回溯同一個;areas 子階段 opt 無信箱鍵),端點基底取自 services.openAlex.base,領域過濾取自 areas.openAlexFields;未給信箱不帶', async () => {
            const a = env({ cap: { services: { openAlex: { mailto: 'me@example.com' } }, areas: { openAlexFields: '17|26' } } })
            await a.st.run({ deps: a.deps, log: a.log })
            assert.equal(a.calls.curl, 1)
            assert.ok(a.calls.urls[0].startsWith('http://oa.test/works?search=investor%20sentiment%20stock%20returns&per-page=8'), a.calls.urls[0])
            assert.ok(a.calls.urls[0].includes(`&filter=${encodeURIComponent('primary_topic.field.id:17|26')}`), '領域過濾取自 capture.areas.openAlexFields')
            assert.ok(a.calls.urls[0].endsWith('&mailto=me%40example.com'), a.calls.urls[0])
            const b = env()
            await b.st.run({ deps: b.deps, log: b.log })
            assert.equal(b.calls.urls[0].includes('mailto'), false, '未給信箱不帶')
            assert.equal(b.calls.urls[0].includes('filter='), false, '領域過濾預設不限')
        })

        it('AI 預算容得下一次遞補(上限只等於首家逾時時,首家逾時即預算用盡、遞補鏈開不了工):剩餘充裕 → 2×5 分;近保留界線 → 至多吃進保留 5 分', async () => {
            const min = 60_000
            const e = env()
            await e.st.run({ deps: e.deps, log: e.log, remainingMs: () => 40 * min })
            assert.equal(e.calls.opts.budgetMs, 2 * AREA_AI_BUDGET_MS, '剩餘 40 分 → 10 分(首家逾時 5 分後仍有 5 分給遞補)')
            const e2 = env()
            await e2.st.run({ deps: e2.deps, log: e2.log, remainingMs: () => 26 * min })
            assert.equal(e2.calls.opts.budgetMs, 6 * min, '剩餘 26 分 → 26－25＋5＝6 分(保護後段之界線不變)')
            assert.equal(typeof e2.calls.opts.shouldStop, 'function')
        })

        it('筆記集合(stores.notes)為選配:未開時候選只取線索(相異文件數達門檻者),不拋錯;其餘流程(AI 判定、OpenAlex 驗證、新增領域)照常', async () => {
            const clues = [
                { id: 'k1', type: 'keyword', value: 'order book imbalance', distinctDocs: 4, status: 'done' },
                { id: 'k2', type: 'keyword', value: 'one-off', hits: 1, status: 'pending' },
            ]
            const e = env({ noNotes: true, clues })
            assert.equal('notes' in e.deps.stores, false)
            const r = await e.st.run({ deps: e.deps, log: e.log })
            assert.deepEqual([r.detail.discovered, r.detail.candidates, r.detail.added, e.calls.ai], [true, 1, 1, 1])
            assert.ok(e.calls.prompt.includes('【order book imbalance】（文章線索，被 4 篇相異文件帶出）'), '候選只有線索一項')
            assert.equal(e.calls.prompt.includes('筆記主概念'), false, '無主概念候選')
            const a = await e.areas.get(areaIdOf('investor sentiment stock returns'))
            assert.deepEqual([a.status, a.evidence.kind, a.evidence.candidate], ['active', 'clue', 'order book imbalance'])
            // 對照:有筆記集合時,主概念(25 篇)與線索同為候選
            const w = env({ clues })
            await w.st.run({ deps: w.deps, log: w.log })
            assert.ok(w.calls.prompt.includes('【市場情緒】（筆記主概念，近期 25 篇') && w.calls.prompt.includes('【order book imbalance】'))
            // 筆記與線索皆無 → 無候選、不呼叫 AI(不拋錯)
            const none = env({ noNotes: true })
            const rn = await none.st.run({ deps: none.deps, log: none.log })
            assert.deepEqual([rn.detail.candidates, none.calls.ai], [0, 0])
        })

        it('領域物件之取用順序與提示詞覆寫:opt.domain > ctx.deps.domains.area > 依 data.vocab 建立之預設;覆寫之提示詞原樣送出,輸出驗證仍依 AREA_CONTRACT', async () => {
            const make = (label) => createAreaDomain({ buildPrompt: () => `自訂提示詞：${label}` })
            // 預設:依 deps.data.vocab 建立(稱呼與主題範圍注入)
            const d0 = env()
            d0.deps.data.vocab = { domain: '機器學習' }
            await d0.st.run({ deps: d0.deps, log: d0.log })
            assert.ok(d0.calls.prompt.includes('「機器學習」知識庫') && d0.calls.prompt.includes('本知識庫之主題範圍為「機器學習」'))
            // deps.domains.area 取代預設
            const d1 = env()
            d1.deps.domains = { area: make('deps') }
            await d1.st.run({ deps: d1.deps, log: d1.log })
            assert.equal(d1.calls.prompt, '自訂提示詞：deps')
            // opt.domain 最優先
            const d2 = env({ stageOpt: { domain: make('opt') } })
            d2.deps.domains = { area: make('deps') }
            await d2.st.run({ deps: d2.deps, log: d2.log })
            assert.equal(d2.calls.prompt, '自訂提示詞：opt')
            // 覆寫之提示詞不改輸出驗證:AI 回標籤逾 16 字者仍被擋(不新增)
            const bad = env({ stageOpt: { domain: make('opt') }, ai: () => [{ index: 1, covered: false, label: '一二三四五六七八九十一二三四五六七', query: 'investor sentiment stock returns', why: 'x' }] })
            const rb = await bad.st.run({ deps: bad.deps, log: bad.log })
            assert.deepEqual([rb.detail.added, bad.calls.curl], [0, 0])
        })

        it('AI 席位:未注入 callAI 時以 ctx.deps.ai.callJson 呼叫 settings.capture.discover.ai 席位(整組席位物件原樣交付,帶 shouldStop 與 budgetMs);呼叫失敗 → 不新增、記 discoverFailAt', async () => {
            const seat = { use: 'x:primary', fallback: ['x:second'], timeoutMs: 12_345 }
            const e = env({ noCallAI: true })
            e.deps.settings.capture.discover.ai = seat
            const seen = []
            e.deps.ai = {
                callJson: async (prompt, check, o) => {
                    seen.push({ prompt, o })
                    const data = [{ index: 1, covered: false, label: '市場情緒與報酬', query: 'investor sentiment stock returns', why: '主概念高支持且未涵蓋' }]
                    return check(data) ? { ok: true, data, error: '', providerId: 'x:primary', attempts: 1, skipped: false, errors: [] } : { ok: false, data: null, error: 'check failed', providerId: '', attempts: 1, skipped: false, errors: [] }
                },
            }
            const r = await e.st.run({ deps: e.deps, log: e.log })
            assert.equal(seen.length, 1)
            assert.equal(seen[0].o.spec, seat, '席位取 settings.capture.discover.ai(同一物件,不另組)')
            assert.equal(typeof seen[0].o.shouldStop, 'function')
            assert.ok(Number.isFinite(seen[0].o.budgetMs) && seen[0].o.budgetMs > 0)
            assert.deepEqual([r.detail.added, r.stats.aiCalls], [1, 1])
            // 呼叫失敗:不新增,記 discoverFailAt(不作廢窗口)
            const f = env({ noCallAI: true })
            f.deps.ai = { callJson: async () => ({ ok: false, data: null, error: '供應商皆失敗', providerId: '', attempts: 2, skipped: false, errors: [] }) }
            const rf = await f.st.run({ deps: f.deps, log: f.log })
            assert.deepEqual([rf.detail.added, Boolean(rf.detail.error)], [0, true])
            assert.ok(f.log.lines.some((l) => /^WARN 領域發現：AI 判定失敗（供應商皆失敗）/.test(l)), f.log.lines.join('\n'))
            const meta = await f.areas.get(AREA_META_ID)
            assert.deepEqual([meta.lastDiscoverAt, meta.discoverFailAt], [undefined, NOW])
        })

        describe('× 真 AI 調度層(本機假 OpenAI 相容伺服器,固定埠 8821;不呼叫任何真實 AI)', () => {
            /**
             * 以真 adapter(真 w-dispatch-ai)取代 ctx.deps.ai 並指定席位
             *
             * @param {Array} entries 輸入 ai.extraProviders 條目(fakeRest 之 rest())
             * @param {Object} seat 輸入 settings.capture.discover.ai 席位
             * @returns {Object} 回傳 env 之產物
             */
            const real = (entries, seat) => {
                const e = env({ noCallAI: true })
                e.deps.ai = mkAdapter(TMP, entries).ai
                e.deps.settings.capture.discover.ai = seat
                return e
            }
            let srv = null

            before(async () => {
                srv = await startServer({ port: 8821 })
            })
            after(async () => {
                await srv.close()
            })
            beforeEach(() => {
                srv.hits.length = 0
            })

            it('settings.capture.discover.ai 席位經真 adapter／真 w-dispatch-ai 走 REST:首選回純文字被驗證拒絕 → 遞補第二家;回覆經寬鬆 JSON 解析與契約驗證 → 新增領域', async () => {
                const e = real([rest(srv.base, 'plain'), rest(srv.base, 'area')], { use: 'rest:plain', fallback: ['rest:area'] })
                const r = await e.st.run({ deps: e.deps, log: e.log })
                assert.deepEqual([r.detail.discovered, r.detail.added, r.stats.aiCalls], [true, 1, 1])
                assert.deepEqual(srv.hits.map((h) => h.model), ['plain', 'area'], '首選回純文字 → 驗證不過 → 遞補第二家')
                assert.ok(srv.hits.every((h) => h.key === 'k1' && h.len > 0), '請求帶金鑰與非空提示詞')
                const a = await e.areas.get(areaIdOf('machine learning fairness'))
                assert.deepEqual([a.label, a.origin, a.status], ['機器學習公平性', 'auto', 'active'])
            })

            it('整條遞補鏈之回覆皆不合契約 → 不新增、記 discoverFailAt、不作廢窗口(lastDiscoverAt 不推進);AI 判已涵蓋 → 記已拒並冷卻', async () => {
                const bad = real([rest(srv.base, 'plain'), rest(srv.base, 'arr')], { use: 'rest:plain', fallback: ['rest:arr'] })
                const rb = await bad.st.run({ deps: bad.deps, log: bad.log })
                assert.deepEqual([rb.detail.added, Boolean(rb.detail.error), srv.hits.length], [0, true, 2])
                const meta = await bad.areas.get(AREA_META_ID)
                assert.deepEqual([meta.lastDiscoverAt, meta.discoverFailAt], [undefined, NOW])
                assert.ok(bad.log.lines.some((l) => /^WARN 領域發現：AI 判定失敗/.test(l)), bad.log.lines.join('\n'))
                const cov = real([rest(srv.base, 'covered')], { use: 'rest:covered' })
                const rc = await cov.st.run({ deps: cov.deps, log: cov.log })
                assert.deepEqual([rc.detail.added, rc.detail.rejected], [0, 1])
                const rej = (await cov.areas.select()).find((x) => x.status === 'rejected')
                assert.match(rej.reason, /^已涵蓋或不宜：已由既有領域涵蓋/)
                assert.ok(Date.parse(rej.cooldownUntil) > NOW_MS)
            })
        })
    })

    describe('stageSeedSync(領域化)', () => {
        it('有 areas 集合:網格主題成為種子領域、grid 來源由領域派生(id 不變);rss 種子自種子檔移除 → paused,重新列入即恢復', async () => {
            const rss = { kind: 'rss', tier: 1, name: 'R', url: 'https://r.example/feed', lang: '' }
            const old = { kind: 'rss', tier: 1, name: 'Old', url: 'https://old.example/feed', lang: '' }
            const sources = memStore()
            const areas = memStore()
            const docs = memStore()
            const mk = (seedSources) => ({ deps: { stores: { sources, areas, docs }, data: { seedSources, gridTopics: [['甲', 'alpha beta']] }, clock: { iso8: () => NOW }, settings: resolveSettings({ capture: { sources: { cullMinJudged: 6 } } }) }, log: recLog() })
            await stageSeedSync().run(mk([rss, old]))
            const gid = areaIdOf('alpha beta')
            assert.equal((await areas.get(gid)).status, 'active')
            assert.equal((await sources.get(gid)).kind, 'grid')
            await stageSeedSync().run(mk([rss]))
            const oldId = sourceId('rss', old.url)
            assert.deepEqual([(await sources.get(oldId)).paused, (await sources.get(oldId)).pauseReason], [true, '種子檔已移除'])
            await stageSeedSync().run(mk([rss, old]))
            assert.equal((await sources.get(oldId)).paused, false)
        })
    })

    describe('docRecord(指名路由)', () => {
        it('項目宣告之 kind／fetcher 隨入庫保留(非空才寫);未宣告者不出現該欄', () => {
            const r = docRecord({ url: 'https://e.com/a', fetcher: 'myDetail', kind: 'pdf' }, { id: 's', name: 'S' }, { nowIso: NOW })
            assert.deepEqual([r.fetcher, r.kind], ['myDetail', 'pdf'])
            const r2 = docRecord({ url: 'https://e.com/b' }, { id: 's', name: 'S' })
            assert.equal('fetcher' in r2, false)
        })
    })
})
