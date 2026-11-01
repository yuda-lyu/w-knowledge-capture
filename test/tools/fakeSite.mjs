// fakeSite.mjs — 本機假站台(測試用;只監聽本機固定埠、不連外網;內容一律為通用科學知識題材)
//
// 兩種站台:
//   createFakeSite     RSS、文章、JS 渲染頁、佔位頁、付費牆、亂碼頁(ISO-8859-1)、彙整頁、site 首頁之 feed 探測、JSON 原文頁、長 feed——
//                      頁面集合由 flowPages 給(可由呼叫端增補 site.pages)
//   createScholarSite  學術 API 替身(OpenAlex works、Bing News RSS、arXiv Atom、文章頁),供網格抓取與領域發現
// 【固定埠由呼叫端給】≥ 8000、不隨機(隨機埠於並行測試易衝突);監聽失敗即拋明確訊息。
// 【為何文章頁之句子逐段互異】正文入庫前會做無損去重(完全相同之行／句 ≥ 40 字只留首次;單行逾 2,000 字改以句為單位)與段落雜湊
//   (同一內容判定):各句都帶主題句與段序,使去重不動正文、各頁段落互不重疊——「截斷前原長＝正文長度」才能斷言;
//   句中不用小數點(句讀含英文句點,會把一句切成兩段而使後半段在各段間相同)。

import http from 'node:http'

/** 包成段落 */
export const para = (s) => `<p>${s}</p>`

/** 文章頁正文中供斷言之關鍵詞(證明正文確經 Readability 取得) */
export const ARTICLE_PHRASE = '穩健性檢驗'

/**
 * 文章頁之第 i 段(三句皆含段序,各段互異)
 *
 * @param {String} topic 輸入主題句
 * @param {Integer} i 輸入段序(自 1 起)
 * @returns {String} 回傳段落文字
 */
const articleParagraph = (topic, i) => `${topic}（第 ${i} 段）。本段（第 ${i} 段）說明觀測設計、樣本期間 2010 至 2024 年、儀器誤差假設與重複測量結果的${ARTICLE_PHRASE}，並討論在不同環境條件下的表現差異。第 ${i} 段另討論可能的失效條件，以及參數敏感度分析所揭示之邊界。`

/**
 * 一般文章頁:header／nav／footer 為雜訊,正文在 article(8 段)
 *
 * @param {String} title 輸入標題(h1 與 title 皆用之;正文含標題詞,才過標題與正文相符之判定)
 * @param {String} topic 輸入主題句(每段以主題句＋段序開頭,使各頁段落互異)
 * @returns {String} 回傳 HTML
 */
export function article(title, topic) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>` +
        `<header><nav><a href="/">首頁</a></nav></header><article><h1>${title}</h1>` +
        [...Array(8)].map((_, i) => para(articleParagraph(topic, i + 1))).join('') +
        '</article><footer>版權所有 測試站</footer></body></html>'
}

/**
 * JS 渲染頁:curl 只見空殼(佔位段),瀏覽器執行腳本後才有正文(先移除佔位段)
 *
 * @param {String} title 輸入標題(不含單引號)
 * @param {String} topic 輸入主題句(不含單引號)
 * @param {String} [placeholder='載入中'] 輸入佔位段文字
 * @returns {String} 回傳 HTML
 */
export function jsArticle(title, topic, placeholder = '載入中') {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>` +
        `<p id="ph">${placeholder}</p><div id="app"></div><script>` +
        'document.getElementById(\'ph\').remove();' +
        `var h='<article><h1>${title}</h1>';for(var i=1;i<=8;i++){h+='<p>${topic}（第 '+i+' 段）。本段（第 '+i+' 段）以瀏覽器渲染後才出現：說明觀測設計、樣本期間 2010 至 2024 年、儀器誤差假設與重複測量結果之穩健性檢驗，並討論不同環境條件下之差異與失效條件。</p>';}` +
        'document.getElementById(\'app\').innerHTML=h+\'</article>\';</script></body></html>'
}

/** 佔位頁文字(≥ 300 字之「請啟用 JavaScript」樣板):curl 取得即判佔位,須轉瀏覽器 */
export const PLACEHOLDER_TEXT = `Please enable JavaScript to view this page. This site uses modern browser features; without JavaScript the content cannot be displayed. ${'Our pages rely on scripts for layout, navigation and article rendering. '.repeat(6)}`

/** 付費牆頁:訂閱預告(瀏覽器無帳號,救不回,須一輪即終態) */
export const PAYWALL_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>付費文章</title></head><body><article><h1>付費文章</h1><p>This article is for subscribers only. Subscribe now to continue reading the full analysis of orbital resonance models. ${'Already a subscriber? Sign in to read. '.repeat(10)}</p></article></body></html>`

/** ISO-8859-1 頁之關鍵詞(curl 以 UTF-8 解碼成 U+FFFD 亂碼;Chrome 依 charset 正確解碼) */
export const LATIN1_WORD = 'étoiles'

/** ISO-8859-1 頁(法文天文題材;以 latin1 位元組送出,重音字元密度足以過亂碼門檻) */
export const LATIN1_HTML = '<!doctype html><html><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"><title>Étoiles variables</title></head><body><article><h1>Étoiles variables et distances galactiques</h1>' +
    [...Array(6)].map((_, i) => para(`Les étoiles variables de type céphéide pulsent avec une période régulière : plus la période est longue, plus la luminosité intrinsèque est élevée (section ${i + 1}). Cette relation permet de déterminer la distance des galaxies lointaines, mais l'extinction interstellaire et la métallicité introduisent des écarts qu'il faut corriger avec soin.`)).join('') +
    '</article></body></html>'

/**
 * RSS 項目
 *
 * @param {String} title 輸入標題
 * @param {String} link 輸入連結(同時為 guid)
 * @param {String} desc 輸入描述(feed 內嵌內文)
 * @returns {String} 回傳 item XML
 */
export const rssItem = (title, link, desc) => `<item><title><![CDATA[${title}]]></title><link>${link}</link><guid>${link}</guid><pubDate>Mon, 28 Sep 2026 08:00:00 GMT</pubDate><description><![CDATA[${desc}]]></description></item>`

/**
 * RSS 頻道
 *
 * @param {String} title 輸入頻道標題
 * @param {Array} items 輸入 item XML 字串陣列
 * @param {String} [home=''] 輸入頻道首頁網址
 * @returns {String} 回傳 RSS XML
 */
export const rss = (title, items, home = '') => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${title}</title><link>${home}/</link><description>測試</description>${items.join('')}</channel></rss>`

/** feed 內嵌之長內文(≥ 300 字、過健全閘;單行 < 2,000 字,去重不動) */
export const LONG_FEED = '本文以 feed 內嵌內文作為素材：探討珊瑚礁白化事件在不同海水溫度下之發生機率，說明熱累積指標、恢復時間與水質對存活率之影響，並以 2015 至 2024 年之衛星遙測資料檢驗結果之穩健性。'.repeat(4)

/**
 * 逾 maxTextChars 之長 feed 內文:每句相異(單行逾 2,000 字時去重以句為單位,重複句會被收掉而使長度失真)
 *
 * @param {Integer} minChars 輸入最少字數
 * @returns {String} 回傳長 feed 內文(長度 ≥ minChars)
 */
export function hugeFeed(minChars) {
    let s = ''
    for (let i = 1; s.length < minChars; i++) s += `第 ${i} 項觀測紀錄：木星衛星軌道之第 ${i} 次共振偏移量與潮汐加熱率，經重複測量與誤差傳遞檢驗後須併入長期趨勢分析。`
    return s
}

/** 逾 maxTextChars(預設 20,000)之長 feed 內文(長 feed 頁用;測試以其長度斷言原長已記) */
export const HUGE_FEED = hugeFeed(24_000)

/**
 * 以標記起頭之長文字(≥ 330 字、每句相異):feed 內嵌內文之素材;標記供斷言「內文取自哪個欄位」
 *
 * @param {String} tag 輸入標記(如「Atom 內嵌全文」)
 * @returns {String} 回傳文字
 */
export function taggedText(tag) {
    return [...Array(6)].map((_, i) => `${tag}之第 ${i + 1} 筆紀錄：記錄恆星光譜之譜線寬度與徑向速度之重複測量結果，並以誤差傳遞檢驗其穩定性。`).join('')
}

/** feed 格式測試之內文標記(Atom 之 content／summary、RSS 之 content:encoded) */
export const FEED_TAGS = { atomContent: 'Atom 內嵌全文', atomSummary: 'Atom 僅摘要', wpEncoded: 'WP 全文欄' }

/** Atom 項目(content 為 HTML,以字元實體跳脫) */
const atomEntry = (title, link, published, summary, htmlContent) => `<entry><title>${title}</title><link href="${link}"/><id>${link}</id><published>${published}</published><updated>${published}</updated><summary>${summary}</summary>` +
    `${htmlContent ? `<content type="html">${htmlContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</content>` : ''}</entry>`

/**
 * 流程測試之頁面集合(路徑 → [內容型別, 內容, 編碼?])
 *
 * 分組:主流程(feed.xml 與 a1／a2／彙整頁／site 探測)、瀏覽器分流(feed-b)、兩佇列(feed-c)、格式雜訊(feed-d)、長 feed(feed-e)、
 *   被擋與暫時性失敗(feed-g)、轉址(feed-r)、feed 格式(feed-atom、feed-wp)
 *
 * @param {Object} h 輸入 { H1:主站網址, H2:另一個迴路位址之網址(轉錄連結須為「外部」主機,同站連結會被濾除) }
 * @returns {Object} 回傳頁面對照表 { 路徑: [內容型別, 內容, 'latin1'?] }
 */
export function flowPages({ H1, H2 }) {
    return {
        '/feed.xml': ['application/rss+xml', rss('測試科學站', [
            rssItem('木星大紅斑之長期尺寸變遷', `${H1}/a1`, '摘要：大紅斑尺寸變遷'),
            rssItem('羅馬水道橋之坡度與水流設計', `${H1}/a2`, '摘要：水道橋坡度'),
            rssItem('Recent Science Links: 2026-09-28', `${H1}/links`, '本週連結'),
            rssItem('死連結測試文章', `${H1}/dead`, '太短'),
            rssItem('Feed 內嵌內文之測試文章', `${H1}/feedonly`, LONG_FEED),
        ], H1)],
        '/a1': ['text/html', article('木星大紅斑之長期尺寸變遷', '木星大紅斑於近百年間之尺寸縮減與色澤變化')],
        '/a2': ['text/html', article('羅馬水道橋之坡度與水流設計', '羅馬水道橋在不同地形下之坡度控制與流量估算')],
        '/a3': ['text/html', article('探測站之珊瑚礁白化文章', '珊瑚礁白化事件對近岸生態系之長期衝擊')],
        '/x1': ['text/html', article('Coral bleaching events and thermal stress thresholds', '珊瑚白化事件與熱壓力閾值之關係')],
        '/x2': ['text/html', article('Glacier retreat measurements from satellite altimetry', '衛星測高對冰川退縮量之量測方法')],
        '/links': ['text/html', '<!doctype html><html><head><title>Recent Science Links</title></head><body><h1>Recent Science Links</h1><ul>' +
            `<li><a href="${H2}/x1">Coral bleaching events and thermal stress thresholds in tropical reef systems</a></li>` +
            `<li><a href="${H2}/x2">Glacier retreat measurements from satellite altimetry at decadal scale</a></li>` +
            '<li><a href="https://scholar.google.com/scholar?q=astronomy">Google Scholar</a></li>' +
            `<li><a href="${H1}/about">About this weekly science links roundup page and its editors</a></li>` +
            `<li><a href="${H2}/short">More</a></li></ul></body></html>`],
        '/site': ['text/html', '<!doctype html><html><head><title>探測站</title><link rel="alternate" type="application/rss+xml" title="feed" href="/feed2.xml"></head><body><p>探測站首頁，提供自然科學研究文章。</p></body></html>'],
        '/feed2.xml': ['application/rss+xml', rss('探測站', [rssItem('探測站之珊瑚礁白化文章', `${H1}/a3`, '摘要')], H1)],
        // ── 瀏覽器分流(JS 渲染、佔位頁、付費牆、亂碼頁)──
        '/feed-b.xml': ['application/rss+xml', rss('瀏覽器測試站', [
            rssItem('JS 渲染之木衛二研究', `${H1}/js1`, '摘要'),
            rssItem('佔位頁後之火星地質研究', `${H1}/ph`, '摘要'),
            rssItem('付費牆之文章', `${H1}/pw`, '摘要'),
            rssItem('Étoiles variables', `${H1}/mj`, 'résumé'),
        ], H1)],
        '/js1': ['text/html', jsArticle('JS 渲染之木衛二研究', '木衛二冰殼下海洋之瀏覽器渲染正文')],
        '/ph': ['text/html', jsArticle('佔位頁後之火星地質研究', '火星地質研究之瀏覽器渲染正文', PLACEHOLDER_TEXT)],
        '/pw': ['text/html', PAYWALL_HTML],
        '/mj': ['text/html', LATIN1_HTML, 'latin1'],
        // ── 兩佇列(配額 1:一篇瀏覽、一篇延後)──
        '/feed-c.xml': ['application/rss+xml', rss('配額測試站', [
            rssItem('配額測試一', `${H1}/js2`, '摘要'),
            rssItem('配額測試二', `${H1}/js3`, '摘要'),
            rssItem('配額測試三（正常頁）', `${H1}/ok4`, '摘要'),
        ], H1)],
        '/js2': ['text/html', jsArticle('配額測試一', '第一篇瀏覽器渲染正文')],
        '/js3': ['text/html', jsArticle('配額測試二', '第二篇瀏覽器渲染正文')],
        '/ok4': ['text/html', article('配額測試三（正常頁）', '正常頁之 curl 正文')],
        // ── 格式雜訊:文章連結實為 API 之 JSON 原文——curl 與瀏覽器皆只得 JSON,不得當文章落 raw ──
        '/feed-d.xml': ['application/rss+xml', rss('格式雜訊測試站', [rssItem('隕石坑資料 API 原文', `${H1}/api.json`, '摘要')], H1)],
        '/api.json': ['application/json', JSON.stringify({ data: [...Array(40)].map((_, i) => ({ id: i, crater: `crater_${i}`, diameterKm: i / 10, updatedAt: '2026-09-28' })) })],
        // ── 長 feed:feed 內嵌內文逾 maxTextChars,全文連結 404 → feed 退路 ──
        '/feed-e.xml': ['application/rss+xml', rss('長 feed 測試站', [rssItem('長 feed 之內嵌全文', `${H1}/gone-e`, HUGE_FEED)], H1)],
        // ── 被擋與暫時性失敗:curl 無 Sec-Fetch-Mode 標頭(真瀏覽器導覽恆帶)→ 403;503 恆回忙碌 ──
        '/feed-g.xml': ['application/rss+xml', rss('擋與忙測試站', [
            rssItem('被擋之行星環文章', `${H1}/blocked-page`, '摘要'),
            rssItem('暫時忙碌之文章', `${H1}/flaky`, '摘要'),
        ], H1)],
        '/blocked-page': (req) => (req.headers['sec-fetch-mode']
            ? ['text/html', article('被擋之行星環文章', '行星環粒徑分布之被擋頁正文')]
            : ['text/html', '<html><body><h1>Forbidden</h1></body></html>', '', 403]),
        '/flaky': ['text/html', '<html><body>service unavailable</body></html>', '', 503],
        // ── 轉址:別名 301 至原文,內容相同 ──
        '/feed-r.xml': ['application/rss+xml', rss('轉址測試站', [
            rssItem('轉址之原文', `${H1}/orig-page`, '摘要'),
            rssItem('轉址之別名', `${H1}/alias-page`, '摘要'),
        ], H1)],
        '/orig-page': ['text/html', article('轉址之原文', '原文頁之主題句')],
        '/alias-page': ['text/html', '', '', 301, { Location: '/orig-page' }],
        // ── feed 格式:Atom(content 為跳脫之 HTML、僅 summary)與 RSS 之 content:encoded;全文連結皆 404,內文取自 feed ──
        '/feed-atom.xml': ['application/atom+xml', `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom 測試站</title><id>urn:astro-atom</id><updated>2026-09-28T08:00:00Z</updated>` +
            atomEntry('Atom 來源之行星大氣文章', `${H1}/gone-atom1`, '2026-09-27T01:02:03Z', '摘要短', `<p>${taggedText(FEED_TAGS.atomContent)}</p>`) +
            atomEntry('Atom 來源之僅摘要文章', `${H1}/gone-atom2`, '2026-09-27T02:00:00Z', taggedText(FEED_TAGS.atomSummary), '') +
            '</feed>'],
        '/feed-wp.xml': ['application/rss+xml', `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>WP 測試站</title><link>${H1}/</link><description>測試</description>` +
            `<item><title><![CDATA[WP 風格之全文欄文章]]></title><link>${H1}/gone-wp</link><guid>${H1}/gone-wp</guid><pubDate>Mon, 28 Sep 2026 08:00:00 GMT</pubDate><description><![CDATA[短描述]]></description>` +
            `<content:encoded><![CDATA[<p>${taggedText(FEED_TAGS.wpEncoded)}</p><p>第二段</p>]]></content:encoded></item></channel></rss>`],
    }
}

/**
 * 監聽固定埠;失敗即拋含埠號之明確訊息
 *
 * @param {Object} server 輸入 http.Server
 * @param {Integer} port 輸入埠
 * @param {String} host 輸入監聽位址
 * @returns {Promise} 回傳 Promise，監聽成功時 resolve
 */
function listenOrThrow(server, port, host) {
    return new Promise((resolve, reject) => {
        server.once('error', (e) => reject(new Error(`假站台無法監聽固定埠 ${port}（${e.code || e.message}）：請確認無其他行程佔用`)))
        server.listen(port, host, resolve)
    })
}

/**
 * 關閉站台(含已建立之連線)
 *
 * @param {Object|null} server 輸入 http.Server 或 null
 * @returns {Promise} 回傳 Promise，關閉後 resolve
 */
function closeServer(server) {
    return new Promise((resolve) => {
        if (!server) {
            resolve()
            return
        }
        server.closeAllConnections?.()
        server.close(() => resolve())
    })
}

/**
 * 通用假站台:依 pages 回應固定內容,未知路徑 404;記錄請求路徑(不含查詢)
 *
 * @param {Object} opt 輸入設定物件
 * @param {Integer} opt.port 輸入固定埠(≥ 8000)
 * @param {String} [opt.host='0.0.0.0'] 輸入監聽位址(0.0.0.0 時 127.0.0.1 與 127.0.0.2 皆可達)
 * @param {Object} [opt.pages={}] 輸入頁面對照表 { 路徑: [內容型別, 內容, 'latin1'?, 狀態碼?, 額外標頭?] 或 (req) => 頁面 }(可於 start 前後由呼叫端增補)
 * @returns {Object} 回傳 { port, pages, hits:Array(請求路徑), start():Promise, stop():Promise }
 * @throws {Error} port 非 ≥ 8000 之整數時拋出
 */
export function createFakeSite(opt = {}) {
    const { port, host = '0.0.0.0', pages = {} } = opt
    if (!Number.isInteger(port) || port < 8000) throw new Error('createFakeSite 需要固定埠 port（≥ 8000 之整數）')
    const hits = []
    let server = null
    return {
        port,
        pages,
        hits,
        start: async () => {
            server = http.createServer((req, res) => {
                const p = req.url.split('?')[0]
                hits.push(p)
                // 頁面為 [內容型別, 內容, 編碼('latin1' 或空), 狀態碼, 額外標頭] 或回傳之函數 (req) => 頁面
                const page = typeof pages[p] === 'function' ? pages[p](req) : pages[p]
                if (!page) {
                    res.writeHead(404, { 'Content-Type': 'text/html' })
                    res.end('<html><body>not found</body></html>')
                    return
                }
                const [type, body, enc, status, headers] = page
                if (enc === 'latin1') {
                    res.writeHead(status || 200, { 'Content-Type': `${type}; charset=iso-8859-1`, ...(headers || {}) })
                    res.end(Buffer.from(body, 'latin1'))
                    return
                }
                res.writeHead(status || 200, { 'Content-Type': `${type}; charset=utf-8`, ...(headers || {}) })
                res.end(body)
            })
            await listenOrThrow(server, port, host)
        },
        stop: async () => {
            await closeServer(server)
            server = null
        },
    }
}

/** 詞序列(領域標籤＋序號,供摘要之 inverted index;每篇用詞互異,段落雜湊不會重疊) */
const words = (n, tag) => Array.from({ length: n }, (_, k) => `${tag}word${k}`)
const inv = (ws) => Object.fromEntries(ws.map((w, k) => [w, [k]]))

/**
 * 學術 API 替身(回應形狀同真 OpenAlex:meta 含 db_response_time_ms／page／per_page／groups_count、group_by;
 * 過短之假回應〔< 100 字元〕會被 w-fetch-web 之 curl 判 empty-response 而落 arXiv 遞補,不是本站台要驗之路徑)
 *
 * 路由:
 *   /works  select 以 id,doi 起頭 → 領域驗證(計數預設 1500、可依查詢以 counts 改寫;8 筆);sort=publication_date:desc → fresh 模式(2 筆);
 *           search 等於 gridQuery → 第 1 頁 8 筆(總數報 100)、其後空頁(以空頁判回補耗盡);其餘 → 0 筆
 *   /news/search  Bing News RSS(4 篇);/api/query  arXiv Atom(空);/news/*、/paper/*、/js  文章頁(/js 為需渲染之空殼)
 *   /zero/feed.xml  零注入測試之種子 feed(3 篇);/zero/<n>  其文章頁(標題與正文相符)
 *
 * @param {Object} opt 輸入設定物件
 * @param {Integer} opt.port 輸入固定埠(≥ 8000)
 * @param {String} [opt.host='127.0.0.1'] 輸入監聽位址
 * @param {String} [opt.gridQuery='planetary science'] 輸入網格查詢字串(回應 8 筆之查詢)
 * @returns {Object} 回傳 { base, hits:Array(路徑＋查詢字串), counts:Map(領域驗證之查詢 → 計數;未列者 1500;測試中可改), start():Promise, stop():Promise }
 * @throws {Error} port 非 ≥ 8000 之整數時拋出
 */
export function createScholarSite(opt = {}) {
    const { port, host = '127.0.0.1', gridQuery = 'planetary science' } = opt
    if (!Number.isInteger(port) || port < 8000) throw new Error('createScholarSite 需要固定埠 port（≥ 8000 之整數）')
    const base = `http://127.0.0.1:${port}`
    const hits = []
    const counts = new Map()
    let server = null
    const work = (i, tag = 'g') => ({
        title: `Paper ${tag}${i} on planetary surface processes`,
        publication_year: 2025,
        doi: `${base}/paper/${tag}${i}`,
        abstract_inverted_index: inv(words(60, `${tag}${i}`)),
        primary_location: { landing_page_url: `${base}/paper/${tag}${i}` },
    })
    const newsRss = (items) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Bing</title><link>${base}/</link><description>x</description>` +
        items.map(([t, l]) => `<item><title><![CDATA[${t}]]></title><link>${l}</link><guid>${l}</guid><pubDate>Mon, 28 Sep 2026 08:00:00 GMT</pubDate><description><![CDATA[${t}]]></description></item>`).join('') + '</channel></rss>'
    return {
        base,
        hits,
        counts,
        start: async () => {
            server = http.createServer((req, res) => {
                const u = new URL(req.url, base)
                hits.push(`${u.pathname}${u.search}`)
                const json = (o) => {
                    const meta = { db_response_time_ms: 12, page: Number(u.searchParams.get('page') || 1), per_page: 8, groups_count: null, ...(o.meta || {}) }
                    res.writeHead(200, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ ...o, meta, group_by: [] }))
                }
                if (u.pathname === '/works') {
                    const search = u.searchParams.get('search') || ''
                    if ((u.searchParams.get('select') || '').startsWith('id,doi')) return json({ meta: { count: counts.get(search) ?? 1500 }, results: Array.from({ length: 8 }, (_, i) => work(i, 'v')) })
                    if (u.searchParams.get('sort') === 'publication_date:desc') return json({ meta: { count: 8 }, results: [work(90, 'f'), work(91, 'f')] })
                    const page = Number(u.searchParams.get('page') || 1)
                    if (search === gridQuery) return json({ meta: { count: 100 }, results: page === 1 ? Array.from({ length: 8 }, (_, i) => work(i)) : [] })
                    return json({ meta: { count: 0 }, results: [] })
                }
                if (u.pathname === '/news/search') {
                    res.writeHead(200, { 'Content-Type': 'application/rss+xml' })
                    res.end(newsRss([1, 2, 3, 4].map((i) => [`Tidal locking study ${i} and orbital resonance`, `${base}/news/${i}`])))
                    return
                }
                // 零注入測試用之種子 feed 與文章頁(標題與正文相符,curl 即可取得正文,不需瀏覽器)
                if (u.pathname === '/zero/feed.xml') {
                    res.writeHead(200, { 'Content-Type': 'application/rss+xml' })
                    res.end(newsRss([1, 2, 3].map((i) => [`零注入測試文章 ${i}`, `${base}/zero/${i}`])))
                    return
                }
                if (/^\/zero\/\d+$/.test(u.pathname)) {
                    const n = u.pathname.split('/')[2]
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
                    res.end(article(`零注入測試文章 ${n}`, `零注入測試文章 ${n} 之主題句`))
                    return
                }
                if (u.pathname === '/api/query') {
                    res.writeHead(200, { 'Content-Type': 'application/atom+xml' })
                    res.end('<feed xmlns="http://www.w3.org/2005/Atom"></feed>')
                    return
                }
                if (u.pathname.startsWith('/news/') || u.pathname.startsWith('/paper/') || u.pathname === '/js') {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
                    res.end(u.pathname === '/js' ? '<!doctype html><html><head><title>JS</title></head><body><div id="app">載入中</div><script>/* 需渲染 */</script></body></html>' : article(`Article ${u.pathname}`, `文章 ${u.pathname} 之主題句`))
                    return
                }
                res.writeHead(404, { 'Content-Type': 'text/html' })
                res.end('<html><body>not found</body></html>')
            })
            await listenOrThrow(server, port, host)
        },
        stop: async () => {
            await closeServer(server)
            server = null
        },
    }
}

export default { para, article, jsArticle, rssItem, rss, flowPages, createFakeSite, createScholarSite, hugeFeed, HUGE_FEED, LONG_FEED, taggedText, FEED_TAGS, ARTICLE_PHRASE, LATIN1_WORD }
