// unit-fetchers.test.mjs — 內建抓取器與端點:grid 雙供應商容錯(OpenAlex 非 JSON 亦遞補 arXiv)、領域過濾由設定注入、抓取器合併
// 執行:自套件根 node <mocha> --timeout 180000 test/unit-fetchers.test.mjs(不發網路:grid 之 curl 以 createDefaultFetchers({ fetchWebByCurl }) 注入替身)

import assert from 'node:assert/strict'
import { createDefaultFetchers, mergeFetchers } from '../src/fetchers/defaultFetchers.mjs'
import { arxivSearchUrl, bingNewsSearchUrl, gridSourceUrl } from '../src/fetchers/endpoints.mjs'

// OpenAlex 之摘要為 inverted index;60 個詞還原後約 400 字,過 250 字門檻
const words = Array.from({ length: 60 }, (_, i) => `word${i}`)
const inv = Object.fromEntries(words.map((w, i) => [w, [i]]))
const openAlexJson = JSON.stringify({ results: [{ title: 'T &amp; U', publication_year: 2024, doi: 'https://doi.org/10.1/x', abstract_inverted_index: inv }] })
const arxivXml = `<feed><entry><id>http://arxiv.org/abs/2401.00001v2</id><title>Arxiv  Title</title><summary>${'s '.repeat(200)}</summary><published>2024-01-02T00:00:00Z</published></entry></feed>`
const gridOf = (stub, extra = {}) => createDefaultFetchers({ fetchWebByCurl: stub, ...extra }).find((f) => f.id === 'grid')

describe('unit-fetchers', function() {

    it('grid:OpenAlex 成功即用之(不打 arXiv);預設不帶領域過濾(通用套件),給 openAlexFields 才帶 filter', async () => {
        const urls = []
        const stub = async (u) => {
            urls.push(u); return { status: 'success', html: openAlexJson }
        }
        const items = await gridOf(stub).fetch({ query: 'memory', cursor: 2 })
        assert.equal(items.length, 1)
        assert.deepEqual([items[0].url, items[0].title, items[0].time], ['https://doi.org/10.1/x', 'T & U', '2024'])
        assert.equal(urls.length, 1, 'OpenAlex 成功即不遞補')
        assert.match(urls[0], /page=2/, 'cursor 即頁碼')
        assert.doesNotMatch(urls[0], /filter=/, '預設不限領域')
        urls.length = 0
        await gridOf(stub, { openAlexFields: '17|26' }).fetch({ query: 'memory' })
        assert.match(urls[0], /filter=primary_topic\.field\.id%3A17%7C26/)
    })

    it('grid:OpenAlex 回 200 但非 JSON(錯誤頁/維護頁)→ 視同失敗而遞補 arXiv(不直接拋錯);arXiv 類別過濾由 arxivCategories 給', async () => {
        const urls = []
        const stub = async (u) => {
            urls.push(u)
            return u.includes('openalex') ? { status: 'success', html: '<html>maintenance</html>' } : { status: 'success', html: arxivXml }
        }
        const items = await gridOf(stub, { arxivCategories: ['cs.LG', 'stat.ML'] }).fetch({ query: 'memory' })
        assert.equal(urls.length, 2)
        assert.match(urls[1], /^https:\/\/export\.arxiv\.org\//)
        assert.match(decodeURIComponent(urls[1]), /search_query=all:memory AND \(cat:cs\.LG OR cat:stat\.ML\)/)
        assert.equal(items.length, 1)
        assert.deepEqual([items[0].url, items[0].title, items[0].time], ['https://arxiv.org/abs/2401.00001', 'Arxiv Title', '2024-01-02'], 'http→https、去版本號、壓平空白')
    })

    it('grid:雙供應商皆失敗 → 拋錯並帶兩邊原因;未給類別時 arXiv 查詢不帶 cat 過濾', async () => {
        const urls = []
        const stub = async (u) => {
            urls.push(u)
            return u.includes('openalex') ? { status: 'error', message: 'HTTP 429' } : { status: 'error', message: 'timeout' }
        }
        await assert.rejects(() => gridOf(stub).fetch({ query: 'memory' }), /網格雙供應商皆失敗：OpenAlex HTTP 429；arXiv timeout/)
        assert.doesNotMatch(decodeURIComponent(urls[1]), /cat:/)
        const stub2 = async (u) => (u.includes('openalex') ? { status: 'success', html: 'not json' } : { status: 'error', message: 'timeout' })
        await assert.rejects(() => gridOf(stub2).fetch({ query: 'memory' }), /OpenAlex 回應非 JSON；arXiv timeout/)
    })

    it('arxivSearchUrl:預設不限類別;categories 以 OR 列出;多字關鍵字用片語並去引號;categories 非陣列視為不限', () => {
        assert.equal(arxivSearchUrl('transformer'), 'https://export.arxiv.org/api/query?search_query=all%3Atransformer&sortBy=submittedDate&sortOrder=descending&max_results=15')
        assert.match(decodeURIComponent(arxivSearchUrl('a "b" c', { categories: ['cs.LG', 'stat.ML'] })), /search_query=all:"a b c" AND \(cat:cs\.LG OR cat:stat\.ML\)&/)
        assert.equal(arxivSearchUrl('x', { categories: 'cs.LG' }), arxivSearchUrl('x'))
        assert.equal(arxivSearchUrl('x', 'bad-opt'), arxivSearchUrl('x'))
    })

    it('bingNewsSearchUrl/gridSourceUrl:關鍵字 URL 編碼', () => {
        assert.equal(bingNewsSearchUrl('a b'), 'https://www.bing.com/news/search?q=a%20b&format=rss')
        assert.equal(gridSourceUrl('deep learning'), 'grid://openalex/deep%20learning')
    })

    it('mergeFetchers:同 id 置換、新 id 追加;cfg.fetchers 非陣列或含非物件 → 拋錯(單一物件誤傳不得以 not iterable 崩潰)', () => {
        const merged = mergeFetchers([{ id: 'rss' }, { id: 'grid' }], [{ id: 'rss', mine: true }, { id: 'pdf' }])
        assert.deepEqual(merged.map((f) => `${f.id}${f.mine ? '*' : ''}`), ['rss*', 'grid', 'pdf'])
        assert.deepEqual(mergeFetchers([{ id: 'a' }]).map((f) => f.id), ['a'])
        assert.deepEqual(mergeFetchers([{ id: 'a' }], null).map((f) => f.id), ['a'])
        assert.throws(() => mergeFetchers([{ id: 'a' }], { id: 'rss' }), /cfg\.fetchers 須為抓取器陣列/)
        assert.throws(() => mergeFetchers([{ id: 'a' }], ['x']), /cfg\.fetchers\[0\] 須為抓取器物件/)
        assert.throws(() => mergeFetchers(null, []), /defaults 須為抓取器陣列/)
    })

    it('createDefaultFetchers:依序 rss/grid/article/links/browser;articleTimeoutMs 無效回退 30000(正文抓取器逾時＝其＋60000);browser 只供指名且管線逾時大於子行程硬逾時;opt 非物件視為 {}', () => {
        const list = createDefaultFetchers({ articleTimeoutMs: 'x' })
        assert.deepEqual(list.map((f) => f.id), ['rss', 'grid', 'article', 'links', 'browser'])
        assert.equal(list.find((f) => f.id === 'article').timeoutMs, 90_000)
        assert.equal(createDefaultFetchers({ articleTimeoutMs: 5000 }).find((f) => f.id === 'links').timeoutMs, 65_000)
        const br = list.find((f) => f.id === 'browser')
        assert.deepEqual(br.kinds, ['__named-only__'], '瀏覽器抓取器只供指名(doc.fetcher=browser),不參與自動比對')
        assert.ok(br.timeoutMs >= 600_000, '管線層逾時須大於子行程硬逾時(由子行程自己收攤並樹狀殺)')
        assert.equal(createDefaultFetchers('bad').length, 5)
    })

})
