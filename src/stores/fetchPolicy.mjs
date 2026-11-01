// fetchPolicy.mjs — 單篇全文抓取結果之分流規則(唯一規則來源):終態／重試／轉瀏覽器,以及各類之瀏覽器階梯
//
// 【為何分流】若一律「tries＋1、試滿 3 次 dead」:404 白試 3 輪;JS 空殼、挑戰頁、逾時等 curl 本就抓不到者
//   試 3 次仍 dead(實測 dead 2,828 篇中約八成屬此類);429／5xx 這類暫時性失敗則與前者同一待遇。
//   對標 Scrapy RetryMiddleware(只重試 5xx／408／429)與 scrapy-playwright／Crawlee(只對需要渲染或被擋者用瀏覽器)。
// 【三種處置】final＝一輪即終態(dead;feed 足量者仍走 feed 退路);retry＝照舊 curl 重試(計 tries);
//   browser＝本輪改走瀏覽器(配額不足即延後,不計 tries;見 detailFetchStage)。
// 【階梯依類別,皆無有頭】排程／常駐環境為非互動 session(如 Windows 工作排程器之 Password LogonType),有頭不可用;各類首階依實測抽樣:
//   401／403、管線逾時 → Camofox 先(Playwright 抽樣 0/5);JS 空殼、挑戰頁、轉址、網路錯、亂碼 → Playwright 無頭先。
//   跨輪件(延後／回收)前置一階 curl:暫時性失敗(抽樣中 curl 4/5)不必動用瀏覽器。
// 【環境失敗不算在文件頭上】Chrome 無法啟動、Camofox 未安裝或 server 起不來,屬本機環境——該方法本輪斷路、文件延後不計 tries,
//   否則三輪內把所有可救件判成 dead。
// 【瀏覽器佇列之路由欄位只有一種寫法】進(或留在)瀏覽器佇列一律經 browserQueueFields:補全文之延後與升級失敗(stages/detailFetchStage)、
//   健全閘重判(stores/healthRecheck)、回收 dead(ops/reviveDocs)、下游回報素材壞了之退回(refetchRequestOf)——各處手寫一份即不一致
//   (如延後時把已在佇列者之進佇列時刻重設,佇列最舊天數因此低報)。

import isobj from 'wsemi/src/isobj.mjs'
import isarr from 'wsemi/src/isarr.mjs'

/** HTTP 狀態:決定性失敗(一輪即終態) */
export const FINAL_HTTP_CODES = [400, 402, 404, 405, 406, 410, 414, 451]

/** HTTP 狀態:暫時性失敗(curl 重試);407(代理須驗證)屬本機連線環境,不是文章之決定性失敗 */
const isRetryHttp = (c) => c === 407 || c === 408 || c === 425 || c === 429 || (c >= 500 && c <= 599)

/** 傳輸層／抓取函數層之失敗(無 HTTP 回應):連線、逾時、抓取函數本身拋錯 */
const TRANSPORT_REASONS = ['timeout', 'curl-error', 'fetcher-error']

/** 瀏覽器階之定義:name → fetchWeb 之選項片段 */
export const BROWSER_STEPS = {
    curl: { method: 'curl' },
    playwright: { method: 'playwright' },
    'playwright-redirect': { method: 'playwright', waitForRedirect: true },
    camofox: { method: 'camofox' },
}

/** 類別 → 瀏覽器階梯(由前到後;camofoxEnabled=false 時去掉 camofox) */
export const BROWSER_CLASS_LADDER = {
    'http-blocked': ['camofox', 'playwright'],
    timeout: ['camofox', 'playwright'],
    net: ['playwright', 'camofox'],
    challenge: ['playwright', 'camofox'],
    redirect: ['playwright-redirect', 'camofox'],
    render: ['playwright', 'camofox'],
    charset: ['playwright', 'camofox'],
}

// format-noise(健全閘:結構化原文／標記殘留／逾合理長度)亦屬「換渲染方式可救」:curl 之 Readability 失敗或站方回原文者,
//   瀏覽器常可取得渲染後之正文(雜訊判準在健全閘內,curl 結果不過閘即同輪升級)
const RENDER_REASONS = ['empty', 'empty-content', 'empty-response', 'parse-error', 'too-short', 'placeholder', 'format-noise']

/**
 * 由 w-fetch-web 之結果取 HTTP 狀態碼:其對外失敗結果與 attempts 紀錄皆不帶數字欄,只有訊息「HTTP 404」(finalizeResult summarizeFail)
 *
 * @param {Object} r 輸入結果物件，取 httpCode、message，或 attempts 末筆之 message
 * @returns {Integer} 回傳狀態碼，取不到回 0
 * @example
 * console.log(httpCodeOf({ message: 'HTTP 404' }))
 * // => 404
 */
export function httpCodeOf(r) {
    if (Number.isInteger(r?.httpCode) && r.httpCode > 0) return r.httpCode
    const pick = (m) => String(m || '').match(/\bHTTP (\d{3})\b/)
    const m = pick(r?.message) || pick(Array.isArray(r?.attempts) ? r.attempts[r.attempts.length - 1]?.message : '')
    return m ? Number(m[1]) : 0
}
const INVALID_REASONS = ['invalid-url', 'internal-address', 'invalid-method']

/**
 * 是否為 PDF 網址:路徑以 .pdf 結尾,或 arXiv 之 /pdf/<id>(無副檔名)。只依網址判——curl 不回 Content-Type(w-fetch-web fetchWebByCurl)
 *
 * @param {String} url 輸入網址
 * @returns {Boolean} 回傳是否判為 PDF
 * @example
 * console.log(isPdfUrl('https://arxiv.org/pdf/2401.12345'), isPdfUrl('https://e.com/a.pdf?x=1'), isPdfUrl('https://e.com/pdf-guide'))
 * // => true true false
 */
export function isPdfUrl(url) {
    try {
        const u = new URL(String(url || ''))
        const p = u.pathname.toLowerCase()
        return p.endsWith('.pdf') || (/(^|\.)arxiv\.org$/i.test(u.hostname) && p.startsWith('/pdf/'))
    }
    catch {
        return false
    }
}

/**
 * 某類別之瀏覽器階梯(階名陣列)
 *
 * @param {String} cls 輸入類別(BROWSER_CLASS_LADDER 之鍵)
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Boolean} [opt.camofoxEnabled=true] 輸入是否允許 Camofox 階
 * @param {Boolean} [opt.crossRound=false] 輸入是否為跨輪件(延後／回收／前輪瀏覽器失敗;前置一階 curl)
 * @returns {Array} 回傳階名陣列，類別不在表內回[]
 * @example
 * console.log(ladderFor('timeout', { camofoxEnabled: false, crossRound: true }))
 * // => [ 'curl', 'playwright' ]
 */
export function ladderFor(cls, opt = {}) {
    if (!isobj(opt)) opt = {}
    const base = BROWSER_CLASS_LADDER[cls] || []
    const steps = opt.camofoxEnabled === false ? base.filter((s) => s !== 'camofox') : [...base]
    if (!steps.length) return []
    return opt.crossRound ? ['curl', ...steps] : steps
}

/**
 * 瀏覽器佇列是否被消化(capture.browser.perRun > 0)。停用時不得把文件放進瀏覽器佇列(永遠不會被消化);補全文段亦把指名瀏覽器之件
 *   併回補全文佇列、改走 curl
 *
 * @param {Object} capture 輸入抓取設定(settings.capture;取 browser.perRun)
 * @returns {Boolean} 回傳是否開啟
 * @example
 * console.log(browserQueueOn({ browser: { perRun: 12 } }), browserQueueOn({ browser: { perRun: 0 } }))
 * // => true false
 */
export function browserQueueOn(capture) {
    return Number(capture?.browser?.perRun) > 0
}

/**
 * 抓取之每輪產能與 raw 進料上界(由抓取設定推導之唯一來源;下游之容量自洽檢核與巡檢待辦表取用,不另推導):
 *   補全文佇列每輪取 articles.perRun 篇(stages/detailFetchStage);瀏覽器名額 browser.perRun 為本輪瀏覽器之配額(同輪升級與瀏覽器佇列共用;
 *   分流停用時為 0,開關即 browserQueueOn);raw 進料上界＝補全文名額＋瀏覽器名額(兩佇列之成者皆入 raw)＋grid 摘要直入上界
 *   (areas.perRun×sources.itemsPerSource;記錄工廠只把 grid 摘要直入 raw)——方向取偏高,估低了會讓真實積壓通過容量檢核
 *
 * @param {Object} capture 輸入抓取設定(settings.capture;取 articles.perRun、browser.perRun、areas.perRun、sources.itemsPerSource)
 * @returns {Object} 回傳 { articles, browser(停用為 0), browserOn, gridInflowMax, rawInflowMax, rawInflowDesc(推導式之說明,供警告與巡檢訊息) }
 * @example
 * let c = captureCapacityOf({ articles: { perRun: 90 }, browser: { perRun: 12 }, areas: { perRun: 4 }, sources: { itemsPerSource: 8 } })
 * console.log(c.rawInflowMax, c.browserOn, c.gridInflowMax)
 * // => 134 true 32
 */
export function captureCapacityOf(capture) {
    const browserOn = browserQueueOn(capture)
    const articles = Number(capture?.articles?.perRun) || 0
    const browser = browserOn ? Number(capture.browser.perRun) : 0
    const gridInflowMax = (Number(capture?.areas?.perRun) || 0) * (Number(capture?.sources?.itemsPerSource) || 0)
    return {
        articles,
        browser,
        browserOn,
        gridInflowMax,
        rawInflowMax: articles + browser + gridInflowMax,
        rawInflowDesc: `capture.articles.perRun ${articles}＋瀏覽器名額 capture.browser.perRun ${browser}＋grid 直入上界 ${gridInflowMax}＝capture.areas.perRun×capture.sources.itemsPerSource`,
    }
}

/**
 * 進(或留在)瀏覽器佇列之路由欄位(唯一寫法;檔頭):fetcher 'browser'(佇列成員之判準)、lastClass(下輪階梯之類別)、
 *   deferredAt(進佇列時刻,佇列等待天數據此量)——已在佇列者(status new 且 fetcher browser)保留原進佇列時刻,延後與失敗不重設
 *
 * @param {Object} doc 輸入文件現值(取 status、fetcher)
 * @param {String} cls 輸入類別(BROWSER_CLASS_LADDER 之鍵)
 * @param {String} nowIso 輸入現在時刻
 * @returns {Object} 回傳 docs.patch 之欄位 { fetcher:'browser', lastClass, deferredAt? }(status 由呼叫端依其轉移給)
 * @example
 * console.log(browserQueueFields({ status: 'raw' }, 'render', 'T1'), browserQueueFields({ status: 'new', fetcher: 'browser', deferredAt: 'T0' }, 'timeout', 'T1'))
 * // => { fetcher: 'browser', lastClass: 'render', deferredAt: 'T1' } { fetcher: 'browser', lastClass: 'timeout' }
 */
export function browserQueueFields(doc, cls, nowIso) {
    const inQueue = doc?.status === 'new' && doc?.fetcher === 'browser'
    return { fetcher: 'browser', lastClass: String(cls || ''), ...(inQueue ? {} : { deferredAt: String(nowIso || '') }) }
}

/**
 * 重抓時應排除之方法(依取得方式;null＝此來源不換法重抓):網頁正文(curl)→ 不用 curl、不前置 curl;瀏覽器 playwright／camofox／curl 所得 →
 *   排除該方法(fetchers/browserFetcher 據 refetchSkip 跳過之)。grid 摘要(abstract,素材即 API 摘要)、feed 退路、站台 adapter(各階皆先跑
 *   同一 adapter)、安裝方指名之自訂抓取器(其失敗語意不明)、未知者 → null
 *
 * @param {Object} doc 輸入文件(取 textFrom、fetcher)
 * @returns {Array|null} 回傳排除之方法陣列,或 null
 * @example
 * console.log(refetchSkipOf({ textFrom: 'article' }), refetchSkipOf({ textFrom: 'abstract' }))
 * // => [ 'curl' ] null
 */
export function refetchSkipOf(doc) {
    if (doc?.fetcher && doc.fetcher !== 'browser') return null
    const from = String(doc?.textFrom || '')
    if (from === 'article') return ['curl']
    if (from.startsWith('browser:playwright')) return ['playwright']
    if (from === 'browser:camofox') return ['camofox']
    if (from === 'browser:curl') return ['curl']
    return null
}

/**
 * 下游(如摘要)回報「素材壞了」之退回重抓——抓取端之欄位(唯一寫法):回待抓(status new)、進瀏覽器佇列(類別 render)、
 *   排除產生該素材之方法(refetchSkip)、lastReason 'material'。不退回者回 null:瀏覽器佇列停用(browserQueueOn 為假)、
 *   取得方式不可換法重抓(refetchSkipOf 為 null)。fetchTries 不動(重抓失敗即沿原次數計,至多耗到 capture.articles.maxTries);
 *   正文不清(重抓成功才覆寫);退回上限與下游自身欄位由呼叫端負責
 *
 * @param {Object} doc 輸入文件現值(取 status、fetcher、textFrom)
 * @param {Object} [o={}] 輸入 { capture: settings.capture, nowIso, note:String(寫入 lastError 之說明) }
 * @returns {Object|null} 回傳 docs.patch 之欄位或 null
 * @example
 * console.log(refetchRequestOf({ status: 'raw', textFrom: 'article' }, { capture: { browser: { perRun: 3 } }, nowIso: 'T', note: '亂碼' }).refetchSkip)
 * // => [ 'curl' ]
 */
export function refetchRequestOf(doc, o = {}) {
    if (!isobj(o)) o = {}
    if (!browserQueueOn(o.capture)) return null
    const skip = refetchSkipOf(doc)
    if (!isarr(skip)) return null
    return { status: 'new', ...browserQueueFields(doc, 'render', o.nowIso), refetchSkip: skip, lastReason: 'material', lastError: String(o.note || '') }
}

/**
 * 分流:一次全文抓取(或瀏覽器階梯)之結果 → 處置
 *
 * @param {Object} f 輸入抓取結果，含 ok、reason、httpCode、adapterId、fetcherId(內建 'article'／'browser'；其餘視為自訂抓取器)
 * @returns {Object} 回傳 { action:'ok'|'final'|'retry'|'browser', cls:String, why:String }
 * @example
 * console.log(classifyFetch({ ok: false, reason: 'http-error', httpCode: 404, fetcherId: 'article' }).action)
 * // => final
 * console.log(classifyFetch({ ok: false, reason: 'empty', fetcherId: 'article' }).cls)
 * // => render
 */
export function classifyFetch(f) {
    if (!isobj(f)) f = {}
    if (f.ok) return { action: 'ok', cls: '', why: '' }
    const reason = String(f.reason || '')
    const code = Number(f.httpCode) || 0
    const r = (action, cls, why) => ({ action, cls, why })
    // 自訂抓取器之 reason 語意不明,不轉瀏覽器;彙整貼文之 links 由轉錄環處置
    if (f.fetcherId && !['article', 'browser'].includes(f.fetcherId)) return r('retry', 'other', `非內建正文抓取器（${f.fetcherId}）`)
    if (INVALID_REASONS.includes(reason)) return r('final', 'invalid', reason)
    if (reason === 'paywall') return r('final', 'paywall', '付費牆／登入牆')
    if (reason === 'not-found') return r('final', 'not-found', '找不到頁面（頁面自述）')
    if (reason === 'soft-404') return r('final', 'soft-404', '轉址至站台首頁')
    // 檢定標準 CS2:標題與正文不符(錯頁)——正文抓取器 → 換瀏覽器渲染重抓;瀏覽器亦不符 → 終態(可 revive)
    if (reason === 'title-mismatch') return f.fetcherId === 'browser' ? r('final', 'title-mismatch', '標題與正文不符（錯頁）') : r('browser', 'render', '標題與正文不符（錯頁）')
    // PDF:尚無正文抽取(瀏覽器無頭會下載而非渲染),選抓取器前即判(detailFetchStage)——一輪即終態,日後抽取上線可以 revive 依 lastError 回收
    if (reason === 'pdf') return r('final', 'pdf', 'PDF 文件（尚無正文抽取）')
    if (FINAL_HTTP_CODES.includes(code)) return r('final', 'http-final', `HTTP ${code}`)
    // adapter 收攤(帶 adapterId 之失敗):瀏覽器階一樣先跑同一 adapter 並收攤(w-fetch-web buildPlan 恆插 adapter 階),轉瀏覽器只是白佔配額。
    //   但暫時性失敗(逾時、連線、5xx、429、抓取函數拋錯)不是文章之判定——內建 msn adapter 為 fallback:false,其 API 之暫時性失敗原樣帶
    //   adapterId 收攤(w-fetch-web fetchMsn、runPlan);此類不可一輪即判 dead(斷網一輪即判死整批),改重試(不轉瀏覽器)
    if (f.adapterId) {
        if (isRetryHttp(code) || TRANSPORT_REASONS.includes(reason)) return r('retry', 'adapter-transient', `adapter ${f.adapterId}：${reason || '失敗'}${code ? `（HTTP ${code}）` : ''}`)
        return r('final', 'adapter', `adapter ${f.adapterId}：${reason || '失敗'}`)
    }
    if (reason === 'adapter-error') return r('retry', 'adapter-error', 'adapter 之 match 拋錯（安裝方 adapter 問題）')
    if (isRetryHttp(code)) return r('retry', 'http-transient', `HTTP ${code}`)
    if (code === 401 || code === 403) return r('browser', 'http-blocked', `HTTP ${code}`)
    if (code >= 400 && code <= 499) return r('final', 'http-final', `HTTP ${code}`)
    if (reason === 'timeout') return r('browser', 'timeout', '抓取逾時')
    if (reason === 'curl-error') return r('browser', 'net', 'curl 執行失敗')
    if (reason === 'captcha' || reason === 'verify') return r('browser', 'challenge', reason)
    if (reason === 'redirect') return r('browser', 'redirect', '轉址包裝頁')
    if (RENDER_REASONS.includes(reason)) return r('browser', 'render', reason)
    if (reason === 'mojibake') return r('browser', 'charset', '編碼錯讀（亂碼）')
    return r('retry', 'unknown', reason || '未知')
}

/**
 * 某階之失敗是否為本機環境問題(該方法本輪斷路,文件不計 tries)
 *
 * @param {Object} s 輸入單階結果，含 reason、message
 * @returns {Boolean} 回傳是否為環境失敗
 * @example
 * console.log(isEnvFailure({ reason: 'camofox-not-found' }))
 * // => true
 */
export function isEnvFailure(s) {
    const reason = String(s?.reason || '')
    const msg = String(s?.message || '')
    if (reason === 'camofox-not-found' || reason === 'browser-env') return true
    if (reason === 'playwright-error') return /Executable doesn't exist|is not found|not installed|Failed to launch|browserType\.launch|distribution|ENOENT|EACCES|spawn /i.test(msg)
    if (reason === 'camofox-error') return /failed to start within|ENOENT|EADDRINUSE|EACCES/i.test(msg)
    return false
}

/**
 * 失敗是否「可能出自本機網路」:沒有收到 HTTP 回應(無狀態碼或 407)、也不是內容判定或決定性分流——落帳計次前須先確認本機網路
 * (core/util/netGuard;斷網時不算在對象頭上)。有 HTTP 狀態碼(407 除外)即表示網路通,內容判定(付費牆等)亦然
 *
 * @param {Object} f 輸入抓取結果，取 reason、httpCode
 * @returns {Boolean} 回傳是否須先確認網路
 * @example
 * console.log(mayBeNetFailure({ reason: 'curl-error' }), mayBeNetFailure({ reason: 'http-error', httpCode: 503 }))
 * // => true false
 */
export function mayBeNetFailure(f) {
    const code = Number(f?.httpCode) || 0
    if (code === 407) return true
    if (code > 0) return false
    const reason = String(f?.reason || '')
    if (['paywall', 'not-found', 'soft-404', 'title-mismatch', 'pdf', 'no-alt-method', ...INVALID_REASONS].includes(reason)) return false
    if (RENDER_REASONS.includes(reason) || reason === 'mojibake' || reason === 'captcha' || reason === 'verify' || reason === 'redirect') return false
    return true
}

export default { FINAL_HTTP_CODES, BROWSER_STEPS, BROWSER_CLASS_LADDER, httpCodeOf, isPdfUrl, ladderFor, browserQueueOn, captureCapacityOf, browserQueueFields, refetchSkipOf, refetchRequestOf, classifyFetch, isEnvFailure, mayBeNetFailure }
