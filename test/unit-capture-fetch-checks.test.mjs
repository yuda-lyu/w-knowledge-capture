// unit-capture-fetch-checks.test.mjs — 抓取器件(fetchers/)之輸入檢查與端點展開(不發網路):
//   articleParse(url 非有效字串不發請求、不拋錯,回失敗結果)、endpoints(識別網址與查詢網址之組法、種子展開)、
//   siteAdapters(自帶清單與注入者之合併)、defaultFetchers 之 grid 遞補(arXiv 類別只依 opt.arxivCategories;與線索探測之類別各自獨立)
//   抓取器之主要行為(內建抓取器、站台 adapter、瀏覽器階梯)另見 unit-fetchers、unit-siteAdapters、unit-capture-browser;
//   總組裝下網格遞補類別(capture.areas.arxivCategories)與線索探測類別(capture.expand.arxivCategories)之獨立接線見 unit-flow-areas(AR14)
// 執行:自套件根 npx mocha test/unit-capture-fetch-checks.test.mjs(全程不發網路:網路層以替身注入)

import assert from 'node:assert/strict'
import { sourceId } from '../src/core/util/records.mjs'
import { fetchArticle, fetchArticleLinks, discoverFeed } from '../src/fetchers/articleParse.mjs'
import { gridSourceUrl, bingNewsSearchUrl, arxivSearchUrl, expandSeeds, checkSeedSources, checkGridTopics } from '../src/fetchers/endpoints.mjs'
import { mergeSiteAdapters, DEFAULT_SITE_ADAPTERS } from '../src/fetchers/siteAdapters.mjs'
import { createDefaultFetchers } from '../src/fetchers/defaultFetchers.mjs'

describe('unit-capture-fetch-checks', function() {

    // ══════════════════════════ articleParse(僅測無效輸入路徑,不發網路) ══════════════════════════
    describe('articleParse', function() {

        it('fetchArticle：url 非有效字串回 {ok:false, reason:"invalid-url"}，不發網路；options 非物件視為{}', async () => {
            const r1 = await fetchArticle(undefined)
            assert.equal(r1.ok, false)
            assert.equal(r1.reason, 'invalid-url')
            const r2 = await fetchArticle(123, 'bad-options')
            assert.equal(r2.ok, false)
            assert.equal(r2.reason, 'invalid-url')
            const r3 = await fetchArticle('')
            assert.equal(r3.ok, false)
            assert.equal(r3.reason, 'invalid-url')
        })

        it('fetchArticleLinks：url 非有效字串回 {ok:false, reason:"invalid-url"}，不發網路', async () => {
            const r = await fetchArticleLinks(null)
            assert.equal(r.ok, false)
            assert.equal(r.reason, 'invalid-url')
        })

        it('discoverFeed：siteUrl 非有效字串回 {ok:false, message}，不發網路', async () => {
            const r = await discoverFeed(NaN)
            assert.equal(r.ok, false)
            assert.equal(typeof r.message, 'string')
        })
    })

    // ══════════════════════════ endpoints ══════════════════════════
    describe('endpoints', function() {

        it('gridSourceUrl：query 非有效字串拋錯(識別網址直接進來源 id 之雜湊,不採 fail-safe);有效字串組出識別 URL', () => {
            assert.throws(() => gridSourceUrl(undefined), /gridSourceUrl 需要 query/)
            assert.throws(() => gridSourceUrl(123), /gridSourceUrl 需要 query/)
            assert.equal(gridSourceUrl('deep learning'), 'grid://openalex/deep%20learning')
        })

        it('bingNewsSearchUrl：keyword 非字串 fail-safe 轉字串,不拋錯；有效字串組出查詢 URL;端點基底可注入(去尾斜線)', () => {
            assert.doesNotThrow(() => bingNewsSearchUrl(undefined))
            assert.equal(bingNewsSearchUrl(undefined), 'https://www.bing.com/news/search?q=&format=rss')
            assert.equal(bingNewsSearchUrl('a b'), 'https://www.bing.com/news/search?q=a%20b&format=rss')
            assert.equal(bingNewsSearchUrl('x', 'http://127.0.0.1:8824/'), 'http://127.0.0.1:8824/news/search?q=x&format=rss')
        })

        it('arxivSearchUrl：多字關鍵字以片語查詢(去引號)、單字不加引號;給類別時以 OR 逐一列出,未給即不限類別(通用套件預設)', () => {
            const dec = (u) => decodeURIComponent(u)
            assert.match(dec(arxivSearchUrl('transformer')), /search_query=all:transformer&sortBy=submittedDate/)
            assert.match(dec(arxivSearchUrl('deep "learning"')), /search_query=all:"deep learning"&/)
            assert.match(dec(arxivSearchUrl('transformer', { categories: ['cs.LG', 'stat.ML'] })), /all:transformer AND \(cat:cs\.LG OR cat:stat\.ML\)/)
            assert.doesNotMatch(dec(arxivSearchUrl('transformer', { categories: 'cs.LG' })), /cat:/, '類別非陣列視為不限')
            assert.doesNotMatch(dec(arxivSearchUrl('transformer', 'bad')), /cat:/, 'opt 非物件視為{}')
            assert.ok(arxivSearchUrl('x', { base: 'http://127.0.0.1:8825/' }).startsWith('http://127.0.0.1:8825/api/query?'), '端點基底可注入')
        })

        it('expandSeeds：data／opt 非物件視為{}；seedSources／gridTopics 非陣列視為[]；有效輸入展開正確', () => {
            assert.deepEqual(expandSeeds('bad', 'bad'), [])
            assert.deepEqual(expandSeeds({ seedSources: 'bad', gridTopics: 'bad' }), [])
            const seeds = expandSeeds({ seedSources: [{ kind: 'rss', url: 'https://e.com/feed', tier: 1, name: 'S' }], gridTopics: [['模型評估', 'model evaluation']] }, { nowIso: '2026-09-23T00:00:00+08:00' })
            assert.deepEqual(seeds.map((s) => s.kind), ['rss', 'grid'])
            assert.equal(seeds[1].url, 'grid://openalex/model%20evaluation')
            assert.equal(seeds[1].id, sourceId('grid', 'grid://openalex/model%20evaluation'))
            assert.equal(seeds[1].addedAt, '2026-09-23T00:00:00+08:00')
            assert.deepEqual([seeds[0].origin, seeds[0].enabled, seeds[0].okCount, seeds[0].failCount, seeds[0].lastFetchAt], ['seed', true, 0, 0, ''], '展開時補上執行期欄位')
            assert.deepEqual([seeds[1].tier, seeds[1].name, seeds[1].lang, seeds[1].query], [2, '網格：模型評估', 'en', 'model evaluation'])
        })

        it('expandSeeds：gridTopics 項目不合 [標籤,查詢] 字串對即拋錯,訊息含索引', () => {
            assert.throws(() => expandSeeds({ gridTopics: [['ok', 'ok'], ['bad-only-one']] }), /cfg\.data\.gridTopics\[1\] 須為 \[標籤, 查詢\] 字串對/)
            assert.throws(() => expandSeeds({ gridTopics: [{}] }), /cfg\.data\.gridTopics\[0\] 須為 \[標籤, 查詢\] 字串對/)
            assert.throws(() => expandSeeds({ gridTopics: [['', 'q']] }), /cfg\.data\.gridTopics\[0\]/)
            assert.throws(() => expandSeeds({ gridTopics: ['model evaluation'] }), /cfg\.data\.gridTopics\[0\] 須為 \[標籤, 查詢\] 字串對/, '字串項不得被拆成字元')
            assert.throws(() => expandSeeds({ gridTopics: [{ label: '模型評估', query: 'model evaluation' }] }), /cfg\.data\.gridTopics\[0\]/, '物件形不是合法形狀')
        })

        it('expandSeeds：seedSources 項目缺 kind、或 url 與 name 皆缺(或非物件)即拋錯,訊息含索引;判準與建構期同一函數(checkSeedSources)', () => {
            // 規則(fetchers/endpoints.checkSeedSources):須含 kind;url 可省,省時 name 必給(虛擬來源以名稱為身分)
            assert.throws(() => expandSeeds({ seedSources: [{ kind: 'rss', url: 'https://e.com/feed' }, { kind: 'rss' }] }), /cfg\.data\.seedSources\[1\] 須為含 kind 之物件.*url 可省，省時 name 必給/)
            assert.throws(() => expandSeeds({ seedSources: ['https://e.com/feed'] }), /cfg\.data\.seedSources\[0\] 須為含 kind 之物件/)
            assert.throws(() => expandSeeds({ seedSources: [{ kind: '', url: 'https://e.com/feed' }] }), /cfg\.data\.seedSources\[0\]/)
            assert.throws(() => expandSeeds({ seedSources: [{ name: '有名無種類' }] }), /cfg\.data\.seedSources\[0\] 須為含 kind 之物件/, '缺 kind 即拋(有 name 亦不放行:輪抓時找不到抓取器)')
            assert.throws(() => expandSeeds({ seedSources: [{ kind: 'my-api', name: '' }] }), /cfg\.data\.seedSources\[0\]/, 'name 空字串視同缺')
            assert.doesNotThrow(() => checkSeedSources(undefined), '非陣列視為[]')
        })

        it('expandSeeds：虛擬來源(無 url、有 name;自訂抓取器之 API 來源)——id 由 kind|name:<名稱> 雜湊、url 為 \'\';同 kind 同 name 即同 id,與有 url 者不撞', () => {
            // 規則(fetchers/endpoints 檔頭與 expandSeeds):來源 id 為去重鍵——無 url 者以名稱為身分
            const [v, w, u] = expandSeeds({ seedSources: [{ kind: 'my-api', name: '聚合器' }, { kind: 'my-api', name: '聚合器', tier: 3 }, { kind: 'my-api', name: '聚合器', url: 'https://api.example/x' }] }, { nowIso: '2026-09-23T00:00:00+08:00' })
            assert.equal(v.id, sourceId('my-api', 'name:聚合器'))
            assert.deepEqual([v.url, v.name, v.kind, v.enabled, v.origin, v.addedAt], ['', '聚合器', 'my-api', true, 'seed', '2026-09-23T00:00:00+08:00'])
            assert.equal(w.id, v.id, '同 kind 同 name 即同一來源')
            assert.notEqual(u.id, v.id, '有 url 者仍以 kind|url 為身分')
            assert.notEqual(sourceId('my-api', 'name:x'), sourceId('my-api', 'x'), '名稱身分帶 name: 前綴,不與同字之網址撞')
            assert.doesNotThrow(() => checkGridTopics(null), '非陣列視為[]')
        })
    })

    // ══════════════════════════ siteAdapters ══════════════════════════
    describe('siteAdapters', function() {

        it('mergeSiteAdapters：defaults 非陣列時回退 DEFAULT_SITE_ADAPTERS；有效輸入合併行為不變(注入者排前、同 id 置換自帶者)', () => {
            const mine = { id: 'x', match: /x\.com/, parse: () => ({ success: false }) }
            assert.deepEqual(DEFAULT_SITE_ADAPTERS, [], '套件自帶清單預設為空(站台知識能推回上游就不留在套件)')
            assert.deepEqual(mergeSiteAdapters('bad', [mine]).map((a) => a.id), ['x'], 'defaults 非陣列時回退為 DEFAULT_SITE_ADAPTERS(空)')
            assert.deepEqual(mergeSiteAdapters(undefined, [mine]).map((a) => a.id), ['x'])
            const own = { id: 'y', match: /y\.com/, parse: () => ({ success: false }) }
            assert.deepEqual(mergeSiteAdapters([own], [mine]).map((a) => a.id), ['x', 'y'], '有效 defaults 之合併行為不變')
            const replace = { id: 'y', match: /y2\.com/, parse: () => ({ success: false }) }
            assert.deepEqual(mergeSiteAdapters([own], [replace]), [replace], '同 id 者置換自帶者')
        })

        it('mergeSiteAdapters：injected 給了但非陣列(單一 adapter 物件)或內含不合契約者於啟動期拋錯(不讓「註冊了卻沒反應」拖到跑輪次才發現)', () => {
            assert.throws(() => mergeSiteAdapters([], { id: 'x', match: /x/, parse: () => ({}) }), /cfg\.siteAdapters 須為站台 adapter 陣列/)
            assert.throws(() => mergeSiteAdapters([], [{ id: 'x' }]), /cfg\.siteAdapters\[0\]\(id=x\) 不合 w-fetch-web adapter 契約/)
            assert.deepEqual(mergeSiteAdapters([], null), [], 'null 視為未注入')
        })
    })

    // ══════════════════════════ defaultFetchers 之 grid 遞補 ══════════════════════════
    describe('defaultFetchers(grid 遞補之 arXiv 類別)', function() {

        // 網路層替身:OpenAlex 端點回失敗(觸發遞補),arXiv 端點回空 feed;記下被請求之網址
        const mkStub = (urls) => async (u) => {
            urls.push(u)
            return u.includes('openalex') ? { status: 'error', message: 'HTTP 429' } : { status: 'success', html: '<feed></feed>' }
        }
        const dec = (u) => decodeURIComponent(u)

        it('grid 遞補 arXiv:類別只取 opt.arxivCategories(總組裝傳 capture.areas.arxivCategories;線索探測之類別另在 capture.expand.arxivCategories,各自獨立);空陣列或未給＝不限類別;opt 內其他名稱之類別鍵不生效', async () => {
            const urls = []
            const gridOf = (extra) => createDefaultFetchers({ fetchWebByCurl: mkStub(urls), ...extra }).find((f) => f.id === 'grid')
            await gridOf({ arxivCategories: ['stat.ML', 'math.OC'] }).fetch({ query: 'q' })
            assert.match(dec(urls[1]), /all:q AND \(cat:stat\.ML OR cat:math\.OC\)/, 'grid 用 arxivCategories')
            await gridOf({ arxivCategories: [] }).fetch({ query: 'q' })
            assert.doesNotMatch(dec(urls[3]), /cat:/, '空陣列＝不限類別')
            await gridOf({ arxivCategories: [], gridArxivCategories: ['x.Y'] }).fetch({ query: 'q' })
            assert.doesNotMatch(dec(urls[5]), /cat:/, '網格遞補之類別只有 arxivCategories 一鍵:其他名稱之鍵(如 gridArxivCategories)給了不生效')
            await gridOf({}).fetch({ query: 'q' })
            assert.doesNotMatch(dec(urls[7]), /cat:/, '未給＝不限類別')
        })

        it('領域中立:未給任何類別與領域過濾時,OpenAlex 與 arXiv 請求皆不帶領域限定(主題範圍由安裝方以設定給)', async () => {
            const urls = []
            const grid = createDefaultFetchers({ fetchWebByCurl: mkStub(urls) }).find((f) => f.id === 'grid')
            await grid.fetch({ query: 'q' })
            assert.doesNotMatch(dec(urls[0]), /filter=/, 'OpenAlex 預設不限領域')
            assert.doesNotMatch(dec(urls[1]), /cat:/, 'arXiv 預設不限類別')
            const urls2 = []
            const g2 = createDefaultFetchers({ fetchWebByCurl: mkStub(urls2), openAlexFields: '17|26' }).find((f) => f.id === 'grid')
            await g2.fetch({ query: 'q' })
            assert.match(dec(urls2[0]), /filter=primary_topic\.field\.id:17\|26/, '安裝方給領域過濾即帶入')
        })
    })
})
