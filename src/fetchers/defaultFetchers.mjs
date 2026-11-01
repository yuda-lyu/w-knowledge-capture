// defaultFetchers.mjs — 內建抓取器(w-data-pipeline DI 規格):rss/grid(list)＋article/links(detail)
//
// list 角色:rss(fetchRSS)與 grid(OpenAlex＋arXiv 雙供應商容錯);
// detail 角色:article(正文)與 links(彙整貼文抽連結)。
// 回傳皆為「原始項目」,欄位映射由 toRecord(內建預設,可覆寫)處理。
// 安裝方以 cfg.fetchers 追加自寫抓取器;同 id 者置換內建。
// 【領域中立】grid 之領域過濾(OpenAlex field／arXiv 類別)由 opt 給,預設不限。
//   grid 遞補之 arXiv 類別即 opt.arxivCategories(總組裝傳 capture.areas.arxivCategories);線索探測之類別(capture.expand.arxivCategories)
//   由 stages/expandStage 讀取,與本檔無關(兩者各有一份清單,可分別設定)。

import isarr from 'wsemi/src/isarr.mjs'
import isobj from 'wsemi/src/isobj.mjs'
import ispint from 'wsemi/src/ispint.mjs'
import cint from 'wsemi/src/cint.mjs'
import fetchWebByCurl from 'w-fetch-web/src/fetchWebByCurl.mjs'
import decodeEntities from 'w-dwdata-hub/src/decodeEntities.mjs'
import fetchRSS from 'w-dwdata-hub/src/fetchRSS.mjs'
import W from 'w-data-pipeline/src/WDataPipeline.mjs'
import { fetchArticle, fetchArticleLinks } from './articleParse.mjs'
import { createBrowserFetcher } from './browserFetcher.mjs'
import { gridAbstractCheck } from '../stores/contentGate.mjs'
import { oneline } from '../core/runnerPackage.mjs'
const { defineFetcher } = W


/** grid 每頁筆數(OpenAlex per-page／arXiv max_results) */
const GRID_PER_PAGE = 8
/** OpenAlex 頁碼分頁之上限筆數(官方:basic paging 僅前 10,000 筆,其後須 cursor 分頁) */
const OPENALEX_PAGING_MAX = 10_000

/**
 * OpenAlex 摘要 inverted index 還原為文字(grid 入庫與原文回溯 ops/refetchSources 共用)
 *
 * @param {Object} inv 輸入 inverted index 物件(詞 → 位置陣列)
 * @returns {String} 回傳摘要文字(壓平空白)
 * @example
 * console.log(deinvertAbstract({ Black: [0], holes: [1], emit: [2], light: [3] }))
 * // => Black holes emit light
 */
export function deinvertAbstract(inv) {
    const arr = []
    for (const [w, positions] of Object.entries(inv || {})) for (const p of positions) arr[p] = w
    return arr.join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * 抓取器自行略過之項目計數:寫在來源訊息上(src._dropped,listFetch 計入 report detail)並記一行日誌(不靜默剔除:逐因計數)
 *
 * @param {Object} src 輸入來源記錄(msg.data)
 * @param {Object} drops 輸入 { short, mojibake, noUrl } 計數
 * @param {Object} [log] 輸入日誌(ctx.log;未給不記)
 * @param {String} via 輸入供應者('OpenAlex'／'arXiv')
 */
function noteGridDrops(src, drops, log, via) {
    if (isobj(src)) src._dropped = { ...drops }
    const n = drops.short + drops.mojibake + drops.noUrl
    if (n > 0) log?.info?.(`網格[${oneline(src?.name || src?.query, 40)}] ${via} 略過 ${n} 篇（摘要短於 250 字 ${drops.short}、亂碼 ${drops.mojibake}、無網址 ${drops.noUrl}）`)
}

/**
 * grid 來源:OpenAlex 依 query＋cursor 翻頁;OpenAlex 失敗(429/網路/回應非 JSON)時切 arXiv(雙供應商容錯)
 *
 * 領域過濾皆由 opt 給(通用套件預設不限):OpenAlex 以 primary_topic.field.id 白名單擋跨域雜訊、arXiv 以類別 OR 過濾。
 * 【回應非 JSON 亦須遞補】OpenAlex 回 200 但內容非 JSON(錯誤頁/維護頁)時須視同失敗而切 arXiv,不可直接拋錯
 * 【略過之項目計數】摘要過短、亂碼(gridAbstractCheck,與存量重判同一判準)、無網址者不入庫,逐因計數於 src._dropped 並記日誌
 *
 * @param {Object} src 輸入 grid 來源記錄，需含 query，可含 cursor(頁碼)；本函數於其上標 _fetchedVia('openalex'｜'arxiv'),
 *   供來源政策判 cursor 是否前進(arXiv 遞補不用 cursor,前進會漏頁);另標 _dropped({ short, mojibake, noUrl })
 * @param {Object} opt 輸入設定物件，可含 openAlexMailto、openAlexFields、arxivCategories、openAlexBase、arxivApiBase、fetchWebByCurl
 * @param {Object} [ctx] 輸入管道脈絡(取 ctx.log 記略過計數;未給不記)
 * @returns {Promise} 回傳 Promise，resolve 回傳原始項目陣列 [{ url, time, title, summary, text }]，雙供應商皆失敗時 reject
 */
async function readGrid(src, opt, ctx) {
    const fetchByCurl = typeof opt.fetchWebByCurl === 'function' ? opt.fetchWebByCurl : fetchWebByCurl
    const fields = String(opt.openAlexFields || '').trim()
    // 遞補 arXiv 之類別:arxivCategories(capture.areas.arxivCategories;網格專用——線索探測另有 capture.expand.arxivCategories,見 stages/expandStage)
    const catList = isarr(opt.arxivCategories) ? opt.arxivCategories : []
    const cats = catList.map((c) => String(c || '').trim()).filter(Boolean)
    // 端點基底可注入(settings.capture.services.openAlex.base／arxiv.base;測試指向本機假站台)
    const oaBase = String(opt.openAlexBase || 'https://api.openalex.org').replace(/\/+$/, '')
    const axBase = String(opt.arxivApiBase || 'https://export.arxiv.org').replace(/\/+$/, '')
    // 兩種模式:backfill＝依相關度逐頁回補(cursor);fresh＝耗盡後改追新作(依出版日由新到舊取第 1 頁,去重擋重複)
    const fresh = src.mode === 'fresh'
    const page = fresh ? 1 : Math.max(1, Number(src.cursor) || 1)
    const mailto = opt.openAlexMailto ? `&mailto=${encodeURIComponent(opt.openAlexMailto)}` : ''
    const u = `${oaBase}/works?search=${encodeURIComponent(src.query)}&per-page=${GRID_PER_PAGE}&page=${page}` +
    (fresh ? '&sort=publication_date:desc' : '') +
    (fields ? `&filter=${encodeURIComponent(`primary_topic.field.id:${fields}`)}` : '') +
    `&select=title,publication_year,doi,abstract_inverted_index,primary_location${mailto}`
    const r = await fetchByCurl(u, { timeoutMs: 15_000, maxRetries: 1 })
    let openAlexWhy = r.message || r.reason || ''
    if (r.status === 'success') {
        let j = null
        try {
            j = JSON.parse(r.html)
        }
        catch {
            openAlexWhy = '回應非 JSON'
        }
        // 結構驗證:須有 results 陣列——錯誤 JSON(如 { error })不可被當成「空頁」而誤判耗盡,改走遞補
        if (j && typeof j === 'object' && !isarr(j.results)) {
            openAlexWhy = `回應缺 results（${oneline(JSON.stringify(j).slice(0, 80), 80)}）`
            j = null
        }
        if (j && typeof j === 'object') {
            if (isobj(src)) src._fetchedVia = 'openalex'
            // 耗盡:回補模式遇空頁,或頁碼已達 OpenAlex 頁碼分頁之上限(前 10,000 筆)或其回報之總數 → 標記交 extraPatchOf 轉 fresh 模式。
            //   耗盡須明確標記:否則空結果仍標 openalex 而 cursor 照加,翻到上限後每輪改落 arXiv 遞補、恆拿同 8 筆
            const results = j.results
            const total = Number(j.meta?.count)
            const cap = Number.isFinite(total) && total >= 0 ? Math.min(total, OPENALEX_PAGING_MAX) : OPENALEX_PAGING_MAX
            if (!fresh && isobj(src) && ((results.length === 0 && page > 1) || page * GRID_PER_PAGE >= cap)) src._exhausted = true
            const items = []
            const drops = { short: 0, mojibake: 0, noUrl: 0 }
            for (const p of results) {
                const abstract = deinvertAbstract(p.abstract_inverted_index)
                // grid 摘要直入 raw(不經補全文之健全閘):只擋過短與亂碼(結構化 API 內容,佔位／付費牆樣式對論文摘要只會誤殺)
                const gc = gridAbstractCheck(abstract)
                if (!gc.ok) {
                    drops[gc.kind === 'too-short' ? 'short' : 'mojibake']++
                    continue
                }
                const url = p.doi || p.primary_location?.landing_page_url || ''
                if (!/^https?:\/\//.test(url)) {
                    drops.noUrl++
                    continue
                }
                // 摘要入庫截 4,000 字;截前之原長經 extra 帶到記錄(fullLength:截斷前原長須記下,存量重判之長度條件以之判)
                items.push({ url, time: String(p.publication_year || ''), title: decodeEntities(String(p.title || '')).trim(), summary: abstract.slice(0, 300), text: abstract.slice(0, 4000), extra: { fullLength: abstract.length } })
            }
            noteGridDrops(src, drops, ctx?.log, 'OpenAlex')
            return items
        }
    }
    const q2 = cats.length ? `all:${src.query} AND (${cats.map((c) => `cat:${c}`).join(' OR ')})` : `all:${src.query}`
    // 遞補亦依 cursor 分頁(start＝(頁−1)×每頁):若固定取相關度前 8 篇,OpenAlex 一壞即恆拿同 8 篇
    const u2 = `${axBase}/api/query?search_query=${encodeURIComponent(q2)}&sortBy=${fresh ? 'submittedDate&sortOrder=descending' : 'relevance'}&start=${(page - 1) * GRID_PER_PAGE}&max_results=${GRID_PER_PAGE}`
    const r2 = await fetchByCurl(u2, { timeoutMs: 15_000, maxRetries: 1 })
    if (r2.status !== 'success') throw new Error(`網格雙供應商皆失敗：OpenAlex ${openAlexWhy}；arXiv ${r2.message || r2.reason}`)
    if (isobj(src)) src._fetchedVia = 'arxiv'
    const items = []
    const drops = { short: 0, mojibake: 0, noUrl: 0 }
    for (const [, e] of String(r2.html || '').matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
        const id = (e.match(/<id>([^<]+)<\/id>/) || [])[1] || ''
        const title = decodeEntities((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').replace(/\s+/g, ' ').trim()
        const summary = decodeEntities((e.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || '').replace(/\s+/g, ' ').trim()
        const published = ((e.match(/<published>([^<]+)<\/published>/) || [])[1] || '').slice(0, 10)
        if (!id) {
            drops.noUrl++
            continue
        }
        // 過短與亂碼判準與 OpenAlex 路、存量重判同一函數(arXiv 路同樣驗亂碼)
        const gc = gridAbstractCheck(summary)
        if (!gc.ok) {
            drops[gc.kind === 'too-short' ? 'short' : 'mojibake']++
            continue
        }
        items.push({ url: id.replace('http://', 'https://').replace(/v\d+$/, ''), time: published, title, summary: summary.slice(0, 300), text: summary.slice(0, 4000), extra: { fullLength: summary.length } })
    }
    noteGridDrops(src, drops, ctx?.log, 'arXiv')
    return items
}

/**
 * 建立內建五支抓取器(w-data-pipeline defineFetcher 規格)
 *
 * list 角色:rss(fetchRSS,curl)、grid(OpenAlex＋arXiv 雙供應商容錯);detail 角色:article(正文,經站台 adapter 與 Readability)、
 * links(彙整貼文抽外部連結,僅供指名路由)、browser(瀏覽器階梯,子行程執行,僅供指名路由:doc.fetcher='browser')
 *
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Integer} [opt.articleTimeoutMs=30000] 輸入單篇正文抓取逾時毫秒正整數(總組裝傳 capture.articles.timeoutMs)，預設30000
 * @param {String} [opt.openAlexMailto=''] 輸入 OpenAlex polite pool 聯絡信箱字串(總組裝傳 capture.services.openAlex.mailto)，預設''
 * @param {String} [opt.openAlexFields=''] 輸入 OpenAlex primary_topic.field.id 白名單字串(以 | 串接，如 '17|26')，預設''代表不限領域
 * @param {Array} [opt.arxivCategories=[]] 輸入 grid 遞補查 arXiv 時之類別過濾字串陣列(如 ['cs.LG', 'stat.ML'];總組裝傳 capture.areas.arxivCategories)，預設[]代表不限類別
 * @param {Array} [opt.siteAdapters] 輸入站台 adapter 陣列(排於 w-fetch-web 內建清單之前)，未給則用本套件自帶清單
 * @param {Function} [opt.fetchWebByCurl] 輸入 grid 抓取所用之 curl 抓取函數(測試或自訂網路層注入)，預設 w-fetch-web 之 fetchWebByCurl
 * @param {String} [opt.openAlexBase='https://api.openalex.org'] 輸入 OpenAlex API 基底(總組裝傳 capture.services.openAlex.base;測試指向本機假站台)
 * @param {String} [opt.arxivApiBase='https://export.arxiv.org'] 輸入 arXiv API 基底(總組裝傳 capture.services.arxiv.base)
 * @returns {Array} 回傳抓取器陣列，依序為 rss、grid、article、links、browser
 * @example
 * need test in nodejs.
 *
 * let fetchers = createDefaultFetchers({ articleTimeoutMs: 30000, arxivCategories: ['cs.LG'] })
 * console.log(fetchers.map((f) => f.id))
 * // => [ 'rss', 'grid', 'article', 'links', 'browser' ]
 */
export function createDefaultFetchers(opt = {}) {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    //articleTimeoutMs
    let articleTimeoutMs = opt.articleTimeoutMs
    if (!ispint(articleTimeoutMs)) {
        articleTimeoutMs = 30_000
    }
    articleTimeoutMs = cint(articleTimeoutMs)

    return [
    // method:'curl' 不用 auto:TLS 指紋站台 curl 過不了 fetch 更不可能過,auto 只讓最壞耗時翻倍
        // 靜音旗標之選項名為 useShowLog(w-dwdata-hub fetchRSS 與 w-fetch-web 皆讀此名;寫成 showLog 無效)
        defineFetcher({ id: 'rss', kinds: ['rss'], timeoutMs: 120_000, fetch: (src) => fetchRSS(src.url, { method: 'curl', withContent: true, maxRetries: 2, timeout: 20_000, useShowLog: false }) }),
        defineFetcher({ id: 'grid', kinds: ['grid'], timeoutMs: 45_000, fetch: (src, ctx) => readGrid(src, opt, ctx) }),
        defineFetcher({
            id: 'article',
            role: 'detail',
            match: () => true,
            timeoutMs: articleTimeoutMs + 60_000,
            fetch: async (d) => {
                const a = await fetchArticle(d.url, { timeoutMs: articleTimeoutMs, adapters: opt.siteAdapters })
                // extra 經 normalizeContent 原樣帶到 doc._fetched.extra(成敗皆保留):成功時供落庫標記內容來源(textFrom)與 finalUrl;
                //   失敗時之 httpCode／adapterId 供分流規則(stores/fetchPolicy)判終態／重試／轉瀏覽器
                return a.ok
                    ? { ok: true, text: a.content, title: a.title, extra: { method: a.method, adapterId: a.adapterId, finalUrl: a.finalUrl || '' } }
                    : { ok: false, reason: a.reason, message: a.message, extra: { httpCode: a.httpCode || 0, adapterId: a.adapterId || '' } }
            },
        }),
        defineFetcher({
            id: 'links',
            role: 'detail',
            kinds: ['__named-only__'],
            timeoutMs: articleTimeoutMs + 60_000,
            fetch: async (d) => {
                const a = await fetchArticleLinks(d.url, { timeoutMs: articleTimeoutMs })
                // 濾除之連結逐因計數經 extra 帶到 doc._fetched.extra(normalizeContent 原樣保留),轉錄環計入 report detail
                return a.ok ? { ok: true, links: a.links, extra: { linkFiltered: a.filtered || {} } } : { ok: false, reason: a.reason, message: a.message }
            },
        }),
        // 瀏覽器階梯(只供指名:doc.fetcher='browser';子行程執行,見 fetchers/browserFetcher)
        createBrowserFetcher(),
    ]
}

/**
 * 合併內建抓取器與安裝方注入者:同 id 置換內建,新 id 追加(置換語意讓安裝方可整支換掉 rss 抓法)
 *
 * @param {Array} defaults 輸入內建抓取器陣列(createDefaultFetchers 之產出)
 * @param {Array} [injected=[]] 輸入安裝方注入之抓取器陣列(cfg.fetchers)，預設[]
 * @returns {Array} 回傳合併後抓取器陣列(不改動輸入陣列)
 * @throws {Error} defaults 或 injected 非陣列、注入項非物件時拋出——單一物件誤傳會讓注入靜默失效
 * @example
 * let merged = mergeFetchers([{ id: 'rss' }, { id: 'grid' }], [{ id: 'rss', mine: true }, { id: 'pdf' }])
 * console.log(merged.map((f) => `${f.id}${f.mine ? '*' : ''}`))
 * // => [ 'rss*', 'grid', 'pdf' ]
 */
export function mergeFetchers(defaults, injected = []) {

    //check
    if (!isarr(defaults)) {
        throw new Error('mergeFetchers 之 defaults 須為抓取器陣列')
    }
    if (injected === undefined || injected === null) {
        injected = []
    }
    if (!isarr(injected)) {
        throw new Error('cfg.fetchers 須為抓取器陣列（單一抓取器亦須包成陣列）')
    }
    injected.forEach((f, i) => {
        if (!isobj(f)) throw new Error(`cfg.fetchers[${i}] 須為抓取器物件（defineFetcher 規格）`)
    })

    const out = [...defaults]
    for (const f of injected) {
        const i = out.findIndex((x) => x.id === f.id)
        if (i >= 0) out[i] = f
        else out.push(f)
    }
    return out
}

export default { createDefaultFetchers, mergeFetchers }
