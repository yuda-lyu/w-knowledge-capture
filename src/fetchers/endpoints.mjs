// endpoints.mjs — 查詢端點模板與種子展開(內建預設;供應商知識集中於此檔便於演進)
//
// 【端點取捨(皆實測)】新聞面用 Bing News 不用 Google News:Google News RSS 之連結為
// 不透明 ID、文章頁是 c-wiz JS 殼,curl 不可讀;Bing 的 apiclick 連結把真實網址帶在
// url= 參數(由 util/web 之 unwrapNewsUrl 解開)。arXiv 之類別萬用字元(如 `cat:xx.*`)不被支援
// (整查詢回 0 筆),必須逐一 OR 列出;多字關鍵字用片語,單字不加引號。
// 【領域中立】arXiv 類別過濾由呼叫端給(線索探測用 settings.capture.expand.arxivCategories、網格遞補用 settings.capture.areas.arxivCategories);未給即不限類別。

import isarr from 'wsemi/src/isarr.mjs'
import isobj from 'wsemi/src/isobj.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import { sourceId } from '../core/util/records.mjs'
import { normalizeUrl } from '../core/util/web.mjs'

/**
 * 主題網格的穩定識別 URL(僅作為來源 id 的錨,實際請求 URL 由 query+cursor 組出)
 *
 * 此 URL 直接進 sourceId 當雜湊來源(見 expandSeeds),query 非有效字串會讓不同網格主題撞出同一個
 * 失真識別 URL,故此處嚴格拋錯,不採 fail-safe(與 bingNewsSearchUrl 之 keyword 不同,keyword 只組查詢網址不作識別鍵)。
 *
 * @param {String} query 輸入查詢字串(供 encodeURIComponent 組入識別 URL)
 * @returns {String} 回傳 grid:// 開頭之識別 URL 字串
 * @throws {Error} query 非有效字串時拋出
 * @example
 * console.log(gridSourceUrl('attention mechanism'))
 * // => grid://openalex/attention%20mechanism
 */
export function gridSourceUrl(query) {

    //check
    if (!isestr(query)) {
        throw new Error('gridSourceUrl 需要 query（查詢字串）')
    }

    return `grid://openalex/${encodeURIComponent(query)}`
}

/**
 * Bing News RSS 關鍵字查詢(新聞面)
 *
 * keyword 非字串時 fail-safe 轉字串處理,不拋錯——與同檔 arxivSearchUrl 之 keyword 同語意(兩者常於
 * expandStage 以同一個 kw 變數呼叫,若一個拋錯一個不拋會讓同一線索之兩個探測端點行為不一致)。
 *
 * @param {*} keyword 輸入關鍵字，null／undefined 視為空字串，其餘轉字串並去頭尾空白
 * @param {String} [base='https://www.bing.com'] 輸入端點基底(settings.capture.services.bingNews.base;測試指向本機假站台)
 * @returns {String} 回傳 Bing News RSS 查詢網址字串
 * @example
 * console.log(bingNewsSearchUrl('transformer'))
 * // => https://www.bing.com/news/search?q=transformer&format=rss
 */
export function bingNewsSearchUrl(keyword, base = 'https://www.bing.com') {
    const kw = String(keyword ?? '').trim()
    const b = (isestr(base) ? base : 'https://www.bing.com').replace(/\/+$/, '')
    return `${b}/news/search?q=${encodeURIComponent(kw)}&format=rss`
}

/**
 * 組 arXiv API 關鍵字查詢網址(依提交日新到舊,最多 15 筆)
 *
 * 多字關鍵字以片語查詢(去除引號),單字不加引號;給 categories 時以 OR 逐一列出類別過濾(arXiv 不支援萬用字元)
 *
 * @param {String} keyword 輸入關鍵字字串
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Array} [opt.categories=[]] 輸入 arXiv 類別字串陣列(如 ['cs.LG','stat.ML'])，預設[]代表不限類別
 * @param {String} [opt.base='https://export.arxiv.org'] 輸入端點基底(settings.capture.services.arxiv.base)
 * @returns {String} 回傳查詢網址字串
 * @example
 * console.log(arxivSearchUrl('transformer', { categories: ['cs.LG'] }))
 * // => https://export.arxiv.org/api/query?search_query=all%3Atransformer%20AND%20(cat%3Acs.LG)&sortBy=submittedDate&sortOrder=descending&max_results=15
 */
export function arxivSearchUrl(keyword, opt = {}) {

    //check
    if (!isobj(opt)) {
        opt = {}
    }
    let categories = opt.categories
    if (!isarr(categories)) {
        categories = []
    }
    categories = categories.map((c) => String(c || '').trim()).filter(Boolean)

    const kw = String(keyword ?? '').trim()
    const term = /\s/.test(kw) ? `all:"${kw.replace(/"/g, '')}"` : `all:${kw}`
    const q = categories.length ? `${term} AND (${categories.map((c) => `cat:${c}`).join(' OR ')})` : term
    const b = (isestr(opt.base) ? opt.base : 'https://export.arxiv.org').replace(/\/+$/, '')
    return `${b}/api/query?search_query=${encodeURIComponent(q)}&sortBy=submittedDate&sortOrder=descending&max_results=15`
}

/**
 * 網格主題之逐項形狀檢核(建構期、種子展開、種子領域同步共用之單一判準):每項須為 [非空標籤字串, 非空查詢字串]。
 * 消費端以 [標籤, 查詢] 解構——字串項會被拆成字元(建出名為首字之領域並以第二字對外查詢),缺查詢者使網格來源識別失真
 *
 * @param {Array} gridTopics 輸入主題網格陣列，非陣列視為[]
 * @returns {undefined} 無回傳值
 * @throws {Error} 任一項不是 [非空標籤字串, 非空查詢字串] 時拋出(訊息指出第幾項)
 * @example
 * checkGridTopics([['模型評估', 'model evaluation']])
 * checkGridTopics(['model evaluation']) // 拋錯:cfg.data.gridTopics[0] 須為 [標籤, 查詢] 字串對
 */
export function checkGridTopics(gridTopics) {
    const list = isarr(gridTopics) ? gridTopics : []
    list.forEach((pair, i) => {
        const [tag, query] = isarr(pair) ? pair : []
        if (!isestr(tag) || !isestr(query)) {
            throw new Error(`cfg.data.gridTopics[${i}] 須為 [標籤, 查詢] 字串對，收到：${JSON.stringify(pair)}`)
        }
    })
}

/**
 * 靜態種子來源之逐項形狀檢核(建構期與種子展開共用之單一判準):每項須為含非空 kind、且 url 或 name 至少一為非空字串之物件。
 * 來源 id 由 kind|url(無 url 者 kind|name:名稱)雜湊而來——缺 kind 則以失真之 id 入庫,輪抓時找不到對應之抓取器而於執行期失敗;
 * 無 url 之來源(自訂抓取器之 API 聚合器等「虛擬來源」)以名稱為身分
 *
 * @param {Array} seedSources 輸入靜態種子來源陣列，非陣列視為[]
 * @returns {undefined} 無回傳值
 * @throws {Error} 任一項非物件、缺非空字串之 kind、或 url 與 name 皆缺時拋出(訊息指出第幾項)
 * @example
 * checkSeedSources([{ kind: 'rss', url: 'https://example.com/feed' }])
 * checkSeedSources([{ kind: 'my-api', name: '聚合器' }]) // 無 url 之虛擬來源:以 name 為身分
 * checkSeedSources(['https://example.com/feed']) // 拋錯:cfg.data.seedSources[0] 須為含 kind 之物件
 */
export function checkSeedSources(seedSources) {
    const list = isarr(seedSources) ? seedSources : []
    list.forEach((s, i) => {
        if (!isobj(s) || !isestr(s.kind) || (!isestr(s.url) && !isestr(s.name))) {
            throw new Error(`cfg.data.seedSources[${i}] 須為含 kind 之物件 { kind, url, tier?, name?, lang? }（url 可省，省時 name 必給——以名稱為來源身分），收到：${JSON.stringify(s)}`)
        }
    })
}

/**
 * 種子展開:靜態種子清單＋主題網格 → 帶執行期欄位的來源記錄(id 由 kind|url 決定,是來源去重鍵)。
 * 資料本體(seedSources/gridTopics)是執行端一直擴充的資產,由 cfg.data 傳入;展開邏輯屬套件。
 *
 * @param {Object} [data={}] 輸入資料物件，非物件視為{}
 * @param {Array} [data.seedSources=[]] 輸入靜態種子來源陣列，非陣列視為[]
 * @param {Array} [data.gridTopics=[]] 輸入主題網格陣列，各項須為 [標籤字串, 查詢字串] 且皆非空，非陣列視為[]
 * @param {Object} [opt={}] 輸入設定物件，非物件視為{}
 * @param {String} [opt.nowIso=''] 輸入現在時刻 ISO 字串，作為 addedAt
 * @returns {Array} 回傳展開後來源記錄陣列
 * @throws {Error} data.gridTopics 之任一項不是 [非空標籤字串, 非空查詢字串]、或 data.seedSources 之任一項缺 kind／url 時拋出(訊息指出第幾項;
 *   判準見 checkGridTopics、checkSeedSources)
 * @example
 * need test in nodejs.
 *
 * const seeds = expandSeeds({ gridTopics: [['模型評估', 'model evaluation']] }, { nowIso: new Date().toISOString() })
 * console.log(seeds.map((s) => s.kind))
 * // => [ 'grid' ]
 */
export function expandSeeds(data = {}, opt = {}) {

    //check
    if (!isobj(data)) {
        data = {}
    }
    if (!isobj(opt)) {
        opt = {}
    }

    const statics = isarr(data.seedSources) ? data.seedSources : []
    const gridTopics = isarr(data.gridTopics) ? data.gridTopics : []
    checkSeedSources(statics)
    checkGridTopics(gridTopics)
    const grids = gridTopics.map(([tag, query]) => ({
        kind: 'grid', tier: 2, name: `網格：${tag}`, url: gridSourceUrl(query), query, lang: 'en',
    }))
    // 身分:kind|url;無 url 之虛擬來源 kind|name:<名稱>(checkSeedSources 已保證 name 非空)
    return [...statics, ...grids].map((s) => ({
        ...s,
        id: sourceId(s.kind, isestr(s.url) ? s.url : `name:${s.name}`),
        url: isestr(s.url) ? normalizeUrl(s.url) : '',
        enabled: true,
        origin: 'seed',
        addedAt: opt.nowIso || '',
        lastFetchAt: '',
        okCount: 0,
        failCount: 0,
    }))
}

export default { gridSourceUrl, bingNewsSearchUrl, arxivSearchUrl, checkGridTopics, checkSeedSources, expandSeeds }
