// refetchSources.mjs — 已消化文件之原文回溯(供下游以原文為材料之存量判定,如筆記內容之紮根、段落雜湊補算)
//
// 【為何】終態瘦身先另存原文(core/stores/docTexts);原文另存啟用之前已瘦身之 noted 文件、或另存失敗者無原文,
//   依原文判定之存量檢核只能「未能判定」。本 op 依原取得方式重取同一份材料,經身分比對後另存,之後符合度掃描與存量處置即可判定。
// 【對象】noted 文件中原文(docs 與另存)皆無者(docTextOf 回 null)。有筆記集合(stores.notes)時限於被筆記引用者;
//   沒有筆記集合時為全部符合之 noted 文件。
// 【依原取得方式重取同一份材料】(依文件之 textFrom)
//   abstract(grid 摘要)→ 以原 API 重查同一記錄,不抓網頁(網頁是另一份材料):arXiv 網址 → arXiv API id_list(批次);DOI 網址 → OpenAlex
//     `filter=doi:`(批次);其餘(OpenAlex 之 landing page)→ OpenAlex 依題名搜尋。摘要取前 4,000 字、壓平空白(同 grid 入庫,
//     fetchers/defaultFetchers;OpenAlex 摘要還原同一函數 deinvertAbstract)。
//   其餘(article、adapter:*、msn-api、feed、未記)→ 內建正文抓取器(fetchArticle;站台 adapter 優先)。不用瀏覽器(背景回溯,不占瀏覽器名額;
//     抓不到者記 fetch-failed)。feed 者原材料為 feed 摘要,重取得到之正文較長(以之為材料之判定因而偏寬:只會少判不合格、不會誤判)。
// 【身分比對(不符即不另存;寧缺勿錯)】API 記錄:依編號(arXiv 編號、DOI)查得者編號即身分(入庫時網址與摘要出自同一記錄;記錄標題日後
//   可能被改寫——如被譯為中文——題名不同只註記);依題名搜尋者題名正規化(NFKC、去標點空白、小寫)後須相同且網址相同。
//   網頁:健全閘合格(stores/healthRecheck 之正文閘,含軟 404)且 CS2 記錄標題與正文相符(docStandards.checkTitleBody 合格;標題詞過少
//   而未能判定者,頁面自身之標題含記錄標題才算同一篇)。網頁可能已改版、轉址到首頁或他文:不符者記 identity-mismatch、不另存,該篇之存量
//   判定維持未能判定(正確,而非以錯材料判)。
// 【只寫三處】docTexts(另存:textFrom 'refetch:<arxiv|openalex|article>'、原長、閘後正文——同落盤之去重與截斷 maxTextChars)、處置帳
//   dirs.state/refetch-sources.jsonl(逐篇:outcome archived|identity-mismatch|not-found|fetch-failed|gate-failed、方法、原因),以及另存成功時
//   清除該文件之 paraKeysNoText(段落鍵補算之「無原文」標記;不清則補算永不重選)。不改筆記。預設只預演(列出對象與方法分布);
//   apply 才抓與寫。重跑略過已另存者與帳上已有結論者;opt.retry 只重試 fetch-failed(抓取或端點失敗),opt.retry 'all' 才連同
//   identity-mismatch／not-found／gate-failed(內容之判定)一併重試。
// 【取得的是「現在的頁面」】回溯物不能證明為摘要當時之材料:網頁(textFrom 'refetch:article')不可作為筆記內容之紮根材料(下游應視同無材料,
//   未能判定;寧缺勿錯),只供 CS10 段落比對與留存;API 依編號取得者(arXiv 編號〔原網址帶版本者保留版本〕、DOI)為同一記錄。
// 【回應形狀須驗】OpenAlex 無 results 陣列、arXiv 非 Atom feed → 端點錯誤(fetch-failed,可重試),不得當成「查無」。
// 【OpenAlex 金鑰】capture.services.openAlex.apiKeyEnv 所指之變數自 deps.envFile(金鑰檔;使用端傳 flow.info().envFile)讀入(deps.openAlexAuth 可直接給載體),
//   DOI 批次與題名搜尋附 api_key(fetchers/openAlexNet);未給或金鑰檔無該變數 → 不帶金鑰,請求同無金鑰時。金鑰不入日誌、處置帳、錯誤訊息(openAlexNet 遮罩)。
// 【OpenAlex 額度】429 之訊息為固定字樣 OPENALEX_QUOTA_MESSAGE(每日額度用盡或每秒請求超限;官方:兩者皆回 429、每日額度 UTC 00:00 重置)。OpenAlex 之請求
//   (DOI 批次、題名搜尋,不含 arXiv、網頁)連續 OPENALEX_QUOTA_STOP_AFTER(3)次 429(各次已含 w-fetch-web 之一次重試,每秒上限之 429 不會連續)→ 判定每日額度用盡,
//   停止 OpenAlex 之回溯(arXiv、網頁照常):out.quotaStop 列明原因與未處理篇數;遭 429 之批次／篇與未發出請求者皆「未處理」——不入處置帳,下次不必 retry 即可續跑。
//   非連續之 429(中間夾其他結果)不停止,該批／篇照舊記 fetch-failed(訊息換固定字樣,retry 重試)。
// 【呼叫端負責】取執行鎖;大量回溯會產生大量網路請求(OpenAlex polite pool 帶 mailto、arXiv 每次請求間隔 ≥3 秒、網頁同主機間隔 ≥2 秒),
//   是否執行由呼叫端決定。

import fs from 'fs'
import path from 'path'
import isarr from 'wsemi/src/isarr.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import isobj from 'wsemi/src/isobj.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import fetchWebByCurl from 'w-fetch-web/src/fetchWebByCurl.mjs'
import decodeEntities from 'w-dwdata-hub/src/decodeEntities.mjs'
import { docTextOf, archiveDocText } from '../core/stores/docTexts.mjs'
import { noteDocIdOf } from '../core/stores/noteFields.mjs'
import { readJsonlRows, appendJsonlRow } from '../core/util/jsonl.mjs'
import { STATUS } from '../core/standards/verdict.mjs'
import { oneline } from '../core/runnerPackage.mjs'
import { deinvertAbstract } from '../fetchers/defaultFetchers.mjs'
import { openAlexGet, openAlexAuthOf, createOpenAlexAuth, openAlexApiKeyOf, isOpenAlexQuota, OpenAlexQuotaError, OPENALEX_QUOTA_MESSAGE, OPENALEX_QUOTA_STOP_AFTER, openAlexQuotaStopText } from '../fetchers/openAlexNet.mjs'
import { fetchArticle } from '../fetchers/articleParse.mjs'
import { createHealthGates } from '../stores/healthRecheck.mjs'
import { dedupeText, gridAbstractCheck } from '../stores/contentGate.mjs'
import { checkTitleBody } from '../standards/docStandards.mjs'

/** 處置帳檔名(dirs.state 下;append-only JSONL) */
export const REFETCH_LEDGER_FILE = 'refetch-sources.jsonl'
/** grid 摘要入庫之字數上限(同 defaultFetchers readGrid) */
const ABSTRACT_MAX = 4000
const BATCH = 50

/**
 * 題名之比對鍵(NFKC、去 HTML 實體、去標點空白、小寫)
 *
 * @param {*} s 輸入題名
 * @returns {String} 回傳比對鍵
 * @example
 * console.log(titleKeyOf('Graphs &amp; Learning: A Study.') === titleKeyOf('graphs & learning — a study'))
 * // => true
 */
export function titleKeyOf(s) {
    return decodeEntities(String(s ?? '')).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

/**
 * 文件之重取方法(依原取得方式;網址判 arXiv／DOI)
 *
 * @param {Object} doc 輸入文件記錄(取 textFrom、url)
 * @returns {Object} 回傳 { method:'arxiv'|'openalex-doi'|'openalex-title'|'article', key:String(arXiv 編號或 DOI 網址;其餘 '') }
 * @example
 * console.log(refetchMethodOf({ textFrom: 'abstract', url: 'https://arxiv.org/abs/2401.01234v2' }))
 * // => { method: 'arxiv', key: '2401.01234v2' }
 *
 * console.log(refetchMethodOf({ textFrom: 'abstract', url: 'https://doi.org/10.1000/ABC' }))
 * // => { method: 'openalex-doi', key: 'https://doi.org/10.1000/abc' }
 *
 * console.log(refetchMethodOf({ textFrom: 'article', url: 'https://example.com/post/1' }))
 * // => { method: 'article', key: '' }
 */
export function refetchMethodOf(doc) {
    const url = String(doc?.url || '')
    if (String(doc?.textFrom || '') !== 'abstract') return { method: 'article', key: '' }
    // 原網址帶版本(v2)者保留版本——取回同一版之摘要;不帶者為當時之最新版,只能取現行版
    const ax = url.match(/arxiv\.org\/(?:abs|pdf)\/([^?#\s]+?(?:v\d+)?)(?:\.pdf)?$/i)
    if (ax) return { method: 'arxiv', key: ax[1] }
    if (/^https?:\/\/(dx\.)?doi\.org\/10\./i.test(url)) return { method: 'openalex-doi', key: url.replace(/^http:/i, 'https:').replace(/dx\.doi\.org/i, 'doi.org').toLowerCase() }
    return { method: 'openalex-title', key: '' }
}

/**
 * 網頁重取之判定(純函數):健全閘＋CS2 身分比對 → 可另存之正文或不符之原因
 *
 * @param {Object} doc 輸入文件記錄(取 title、url)
 * @param {Object} got 輸入 fetchArticle 之結果
 * @param {Object} o 輸入 { gates:createHealthGates 之產物, maxTextChars:Integer }
 * @returns {Object} 回傳 { outcome:'archived'|'fetch-failed'|'gate-failed'|'identity-mismatch', text?, fullLength?, why? }
 * @example
 * // 以替身健全閘示範(實際使用時 gates 取自 createHealthGates)
 * let gates = { main: { assess: () => ({ ok: true }) } }
 * let doc = { title: '恆星光譜分析方法', url: 'https://example.com/post/1' }
 * let content = '恆星光譜分析是天文學研究恆星組成的基本方法,透過光譜線可以推算恆星的溫度與化學成分。'
 * let j = judgeArticleRefetch(doc, { ok: true, content, title: '恆星光譜分析方法' }, { gates, maxTextChars: 20000 })
 * console.log(j.outcome, j.fullLength, j.why)
 * // => archived 42 以頁面標題確認同一篇
 *
 * console.log(judgeArticleRefetch(doc, { ok: false, reason: 'timeout', message: 'x' }, { gates, maxTextChars: 20000 }))
 * // => { outcome: 'fetch-failed', why: 'timeout x' }
 */
export function judgeArticleRefetch(doc, got, o) {
    if (!got?.ok) return { outcome: 'fetch-failed', why: oneline(`${got?.reason || ''} ${got?.message || ''}`, 160) }
    const content = String(got.content || '')
    const g = o.gates.main.assess({ text: content, title: got.title || doc.title || '', adapterId: got.adapterId || '', url: doc.url, finalUrl: got.finalUrl || '', fullLength: content.length })
    if (!g.ok) return { outcome: 'gate-failed', why: `${g.kind}${g.hit ? `：${oneline(g.hit, 80)}` : ''}` }
    const tb = checkTitleBody(doc.title, content)
    if (tb.status === STATUS.VIOLATION) return { outcome: 'identity-mismatch', why: `標題與正文不符（${oneline(tb.detail, 100)}）` }
    // 標題詞過少(CS2 未能判定):頁面自身之標題含記錄標題(比對鍵 ≥6 字元)亦算同一篇(如 arXiv 摘要頁「[編號] 題名」);否則不另存
    const k = titleKeyOf(doc.title)
    if (tb.status !== STATUS.PASS && !(k.length >= 6 && titleKeyOf(got.title).includes(k))) return { outcome: 'identity-mismatch', why: `無法確認同一篇（${oneline(tb.detail || '標題詞過少', 100)}；頁面標題不含記錄標題）` }
    const dd = dedupeText(content)
    return { outcome: 'archived', text: dd.text.slice(0, o.maxTextChars), fullLength: content.length, ...(tb.status !== STATUS.PASS ? { why: '以頁面標題確認同一篇' } : {}) }
}

/**
 * API 記錄之判定(純函數):身分(依編號查得者——arXiv 編號、DOI——編號即身分;依題名搜尋者須題名相同)＋摘要合 grid 判準 → 可另存之摘要
 *
 * @param {Object} doc 輸入文件記錄(取 title)
 * @param {Object|null} rec 輸入 API 記錄 { title, abstract }(查無為 null)
 * @param {Object} [o={}] 輸入 { byId:Boolean(依編號查得;入庫時網址與摘要出自同一記錄,記錄標題日後可能被改寫,如譯為中文——
 *   題名不同只註記不擋) }
 * @returns {Object} 回傳 { outcome:'archived'|'not-found'|'identity-mismatch'|'gate-failed', text?, fullLength?, why? }
 * @example
 * console.log(judgeAbstractRefetch({ title: '恆星光譜分析' }, null))
 * // => { outcome: 'not-found', why: 'API 查無此記錄' }
 *
 * let abs = '恆星光譜分析是天文學研究恆星組成的基本方法。'.repeat(14)
 * let j = judgeAbstractRefetch({ title: '恆星光譜分析' }, { title: '恆星光譜分析', abstract: abs })
 * console.log(j.outcome, j.fullLength, j.text.length)
 * // => archived 308 308
 *
 * console.log(judgeAbstractRefetch({ title: '恆星光譜分析' }, { title: '恆星光譜分析', abstract: '短' }))
 * // => { outcome: 'gate-failed', why: 'too-short' }
 */
export function judgeAbstractRefetch(doc, rec, o = {}) {
    if (!isobj(rec)) return { outcome: 'not-found', why: 'API 查無此記錄' }
    const sameTitle = titleKeyOf(rec.title) === titleKeyOf(doc.title)
    if (!sameTitle && o.byId !== true) return { outcome: 'identity-mismatch', why: `題名不同（API：${oneline(rec.title, 60)}）` }
    const abs = String(rec.abstract || '').replace(/\s+/g, ' ').trim()
    const gc = gridAbstractCheck(abs)
    if (!gc.ok) return { outcome: 'gate-failed', why: gc.kind }
    return { outcome: 'archived', text: abs.slice(0, ABSTRACT_MAX), fullLength: abs.length, ...(sameTitle ? {} : { why: `以編號確認同一記錄（記錄標題與 API 題名不同：${oneline(rec.title, 60)}）` }) }
}

/**
 * 內建之網路層(可由 deps.refetch 注入替身;測試不發網路)
 *
 * @param {Object} cap 輸入 settings.capture(取 services.openAlex〔base、mailto〕、services.arxiv.base、articles.timeoutMs)
 * @param {Object} [o={}] 輸入 { openAlexAuth:OpenAlex 金鑰載體〔openAlexNet 之 createOpenAlexAuth 產物;未給不帶金鑰〕, fetchWebByCurl:curl 抓取函數〔測試注入;預設 w-fetch-web〕 }
 * @returns {Object} 回傳 { arxiv(ids)→Map(id → {title,abstract}), openalexDoi(dois)→Map(doi → {title,abstract}), openalexTitle(title)→Array({title,abstract,url}), article(url)→fetchArticle 結果, pause(method) }
 */
function defaultNet(cap = {}, o = {}) {
    const fetchFn = isfun(o.fetchWebByCurl) ? o.fetchWebByCurl : fetchWebByCurl
    const auth = openAlexAuthOf(o.openAlexAuth)
    const oaBase = String(cap.services?.openAlex?.base || 'https://api.openalex.org').replace(/\/+$/, '')
    const axBase = String(cap.services?.arxiv?.base || 'https://export.arxiv.org').replace(/\/+$/, '')
    const mailto = cap.services?.openAlex?.mailto ? `&mailto=${encodeURIComponent(cap.services.openAlex.mailto)}` : ''
    // OpenAlex 回應須有 results 陣列:錯誤回應(額度、參數錯)解析成功卻無 results 時,不可當「查無」而永久記 not-found
    //   請求經 openAlexGet(附金鑰、失敗訊息遮罩);429 拋 OpenAlexQuotaError(固定訊息,帶 quota:true 供連續計數);回應片段入錯誤訊息前亦遮罩
    const getResults = async (u) => {
        const r = await openAlexGet(fetchFn, u, { auth, timeoutMs: 20_000, maxRetries: 1 })
        if (isOpenAlexQuota(r)) throw new OpenAlexQuotaError()
        if (r.status !== 'success') throw new Error(`HTTP 失敗：${oneline(r.message || r.reason, 120)}`)
        let j
        try {
            j = JSON.parse(r.html)
        }
        catch (e) {
            if (!auth.enabled) throw e
            throw new Error(auth.mask(String(e?.message)))
        }
        if (!isarr(j?.results)) throw new Error(`OpenAlex 回應無 results（${auth.mask(oneline(JSON.stringify(j).slice(0, 160), 160))}）`)
        return j.results
    }
    const oaRec = (p) => ({ title: decodeEntities(String(p?.title || '')).trim(), abstract: deinvertAbstract(p?.abstract_inverted_index), url: p?.doi || p?.primary_location?.landing_page_url || '' })
    const lastByHost = new Map()
    return {
        async arxiv(ids) {
            const r = await fetchFn(`${axBase}/api/query?id_list=${ids.map(encodeURIComponent).join(',')}&max_results=${ids.length}`, { timeoutMs: 30_000, maxRetries: 1 })
            if (r.status !== 'success') throw new Error(`arXiv 失敗：${oneline(r.message || r.reason, 120)}`)
            return parseArxivFeed(r.html)
        },
        async openalexDoi(dois) {
            const out = new Map()
            for (const p of await getResults(`${oaBase}/works?filter=${encodeURIComponent(`doi:${dois.join('|')}`)}&per-page=${dois.length}&select=title,doi,abstract_inverted_index,primary_location${mailto}`)) if (p?.doi) out.set(String(p.doi).toLowerCase(), oaRec(p))
            return out
        },
        async openalexTitle(title) {
            return (await getResults(`${oaBase}/works?search=${encodeURIComponent(title)}&per-page=5&select=title,doi,abstract_inverted_index,primary_location${mailto}`)).map(oaRec)
        },
        article: (url) => fetchArticle(url, { timeoutMs: cap.articles?.timeoutMs || 30_000 }),
        // 禮貌間隔:arXiv 建議每次請求間隔 3 秒;OpenAlex polite pool 每秒 10 次以內
        pause: (method) => new Promise((res) => setTimeout(res, method === 'arxiv' ? 3_100 : 150)),
        // 網頁:同主機兩次請求間隔 ≥2 秒(大批回溯連打同一站易被封鎖而反傷正式抓取)
        async pauseHost(url) {
            let host = ''
            try {
                host = new URL(String(url)).hostname
            }
            catch { /* 不合法網址不等待 */ }
            if (!host) return
            const wait = (lastByHost.get(host) || 0) + 2_000 - Date.now()
            if (wait > 0) await new Promise((res) => setTimeout(res, wait))
            lastByHost.set(host, Date.now())
        },
    }
}

/**
 * arXiv API(Atom)回應之解析(純函數):非 Atom feed 即拋(端點錯誤,不得當成「查無」);每筆以「帶版本之編號」與「去版本之編號」兩鍵
 *   皆可查(原網址帶版本者以帶版本鍵查同一版)
 *
 * @param {String} xml 輸入 API 回應
 * @returns {Map} 回傳 Map(編號 → { title, abstract })
 * @throws {Error} 回應非 Atom feed 時拋出
 * @example
 * const m = parseArxivFeed('<feed><entry><id>http://arxiv.org/abs/2401.01234v2</id><title>T</title><summary>S</summary></entry></feed>')
 * console.log(m.get('2401.01234v2').title, m.get('2401.01234').title)
 * // => T T
 */
export function parseArxivFeed(xml) {
    const s = String(xml || '')
    if (!/<feed[\s>]/i.test(s)) throw new Error(`arXiv 回應非 Atom feed（${oneline(s.slice(0, 120), 120)}）`)
    const out = new Map()
    for (const [, e] of s.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
        const full = ((e.match(/<id>([^<]+)<\/id>/) || [])[1] || '').replace(/^https?:\/\/arxiv\.org\/abs\//i, '').trim()
        const title = decodeEntities((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').replace(/\s+/g, ' ').trim()
        const abstract = decodeEntities((e.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || '').replace(/\s+/g, ' ').trim()
        if (!full) continue
        out.set(full, { title, abstract })
        const bare = full.replace(/v\d+$/, '')
        if (!out.has(bare)) out.set(bare, { title, abstract })
    }
    return out
}

/**
 * 已消化文件之原文回溯(檔頭)
 *
 * @param {Object} deps 輸入 { stores:{ docs, docTexts, notes? }, dirs:{ state }, clock, log, settings:{ capture }, refetch?(網路層替身), envFile?(金鑰檔路徑:
 *   OpenAlex 金鑰取自此檔之 capture.services.openAlex.apiKeyEnv 變數;使用端傳 flow.info().envFile), openAlexAuth?(金鑰載體,優先於 envFile),
 *   fetchWebByCurl?(curl 抓取函數,測試注入) };stores.notes 可缺(缺則對象為全部無原文之 noted 文件)
 * @param {Object} [opt={}] 輸入 { apply:Boolean, limit:Integer(本次至多幾篇;預設全部), ids:Array(只處理這些文件), methods:Array('arxiv'|'openalex-doi'|'openalex-title'|'article'),
 *   retry:Boolean|'all'(true＝帳上結論為 fetch-failed 者重試;'all'＝連同內容判定之結論〔identity-mismatch／not-found／gate-failed〕) }
 * @returns {Promise} 回傳 Promise，resolve 回傳 { candidates, byMethod:{ 方法: 篇數 }, processed, outcomes:{ 結論: 篇數 }, sample:Array, ledgerFile,
 *   quotaStop?:{ after:連續幾次 429 即停, unprocessed:未處理篇數〔遭 429 者與未發出請求者〕, byMethod:{ 'openalex-doi'|'openalex-title': 篇數 }, message } }(quotaStop 僅在額度用盡而停止時有)
 * @throws {Error} deps.stores 缺 docTexts 集合時拋出
 * @example
 * // 以記憶體替身集合與替身網路層示範，不連網；只預演不給 apply 時不寫任何檔
 * let docs = new Map([['d1', { id: 'd1', status: 'noted', title: '黑洞光譜的觀測', url: 'https://example.com/post/1', textFrom: 'article' }]])
 * let stores = {
 *     docs: { select: async () => [...docs.values()], get: async (id) => docs.get(id) ?? null, patch: async () => {} },
 *     docTexts: { get: async () => null, replace: async () => {} },
 * }
 * let deps = { stores, dirs: { state: './tmp/state' }, clock: { iso8: () => '2026-09-23T00:00:00+08:00' }, settings: { capture: {} } }
 * let r = await refetchSources(deps)
 * console.log(r.candidates, r.byMethod, r.sample)
 * // => 1 { article: 1 } [ 'd1｜article｜黑洞光譜的觀測' ]
 *
 * // apply 時才抓與寫(處置帳寫入 dirs.state 下的 refetch-sources.jsonl)；此處替身抓取器回報逾時
 * let net = { article: async () => ({ ok: false, reason: 'timeout', message: '逾時' }) }
 * let r2 = await refetchSources({ ...deps, refetch: net }, { apply: true })
 * console.log(r2.processed, r2.outcomes)
 * // => 1 { 'fetch-failed': 1 }
 */
export async function refetchSources(deps, opt = {}) {
    const { stores, dirs, clock, log } = deps
    if (!stores?.docTexts) throw new Error('refetchSources 需要 docTexts 集合(另存原文之處)')
    const cap = deps.settings?.capture || {}
    // 網路層:deps.refetch 整組置換(測試替身);否則內建——OpenAlex 金鑰取 deps.openAlexAuth,未給則依 capture.services.openAlex.apiKeyEnv 自 deps.envFile(金鑰檔)讀
    //   (使用端以 flow.info().envFile 傳入;皆未給＝不帶金鑰)
    const net = isobj(deps.refetch)
        ? deps.refetch
        : defaultNet(cap, { openAlexAuth: deps.openAlexAuth ?? createOpenAlexAuth(openAlexApiKeyOf(cap, deps.envFile)), fetchWebByCurl: deps.fetchWebByCurl })
    const ledgerFile = path.join(dirs.state, REFETCH_LEDGER_FILE)
    const seen = new Map() // 帳上各文件之最後結論(缺檔空、壞行略過:JSONL 共用件)
    for (const r of readJsonlRows(ledgerFile)) if (isestr(r.id)) seen.set(r.id, r.outcome)
    // 對象:noted 文件,其原文 docs 與另存皆無(docTextOf 回 null);有筆記集合(stores.notes)時限於被筆記引用者,沒有時為全部 noted 文件
    const targetIds = isfun(stores.notes?.select)
        ? new Set((await stores.notes.select()).map(noteDocIdOf).filter(isestr))
        : new Set((await stores.docs.select({ status: 'noted' })).map((d) => d.id).filter(isestr))
    const only = isarr(opt.ids) ? new Set(opt.ids) : null
    const methods = isarr(opt.methods) && opt.methods.length ? new Set(opt.methods) : null
    const cands = []
    // 帳上已有結論者:archived 恆略過;fetch-failed(抓取或端點失敗)於 retry 時重試;內容判定之結論只在 retry 'all' 時重試
    const retryable = (prev) => (opt.retry === 'all' ? true : (opt.retry === true && prev === 'fetch-failed'))
    for (const id of targetIds) {
        if (only && !only.has(id)) continue
        const prev = seen.get(id)
        if (prev === 'archived' || (prev && !retryable(prev))) continue
        const d = await stores.docs.get(id)
        if (!d || d.status !== 'noted') continue
        if (await docTextOf(stores, id)) continue
        const m = refetchMethodOf(d)
        if (methods && !methods.has(m.method)) continue
        cands.push({ d, ...m })
    }
    cands.sort((a, b) => String(a.d.id).localeCompare(String(b.d.id)))
    const byMethod = {}
    for (const c of cands) byMethod[c.method] = (byMethod[c.method] || 0) + 1
    const limit = Number.isInteger(opt.limit) && opt.limit > 0 ? opt.limit : cands.length
    const todo = cands.slice(0, limit)
    const out = { candidates: cands.length, byMethod, processed: 0, outcomes: {}, sample: todo.slice(0, 5).map((c) => `${c.d.id}｜${c.method}｜${oneline(c.d.title, 40)}`), ledgerFile }
    if (opt.apply !== true) return out

    fs.mkdirSync(dirs.state, { recursive: true })
    const gates = createHealthGates(cap.standards)
    const maxTextChars = Number(cap.articles?.maxTextChars) || 20_000
    const handled = new Set() // 已入處置帳之文件 id
    const record = async (c, j) => {
        handled.add(c.d.id)
        const at = clock.iso8()
        if (j.outcome === 'archived') {
            const a = await archiveDocText(stores.docTexts, { id: c.d.id, text: j.text, feedText: '', textFrom: `refetch:${c.method === 'article' ? 'article' : c.method.split('-')[0]}`, status: c.d.status, fullLength: j.fullLength, title: c.d.title, url: c.d.url }, at)
            if (!a.ok) j = { outcome: 'fetch-failed', why: `另存失敗：${a.reason}` }
            // 原文已可得:清「無原文」標記,段落鍵補算(docMaintain.fillParaKeys)才會重選(不清則永不重選)
            else if (c.d.paraKeysNoText) await stores.docs.patch(c.d.id, { paraKeysNoText: null })
        }
        appendJsonlRow(ledgerFile, { at, id: c.d.id, method: c.method, outcome: j.outcome, why: j.why || '', chars: j.text ? j.text.length : 0 })
        out.outcomes[j.outcome] = (out.outcomes[j.outcome] || 0) + 1
        out.processed++
    }
    // ── OpenAlex 額度(檔頭【OpenAlex 額度】):連續 OPENALEX_QUOTA_STOP_AFTER 次請求(DOI 批次或題名搜尋)皆 429 → 判定每日額度用盡而停止 OpenAlex 回溯(arXiv、網頁照常)。
    //   遭 429 而未定論者先存 pending:被其他結果打斷(未達門檻)→ 照舊記 fetch-failed(訊息換固定字樣);達門檻 → 與未發出請求者同為「未處理」,不入處置帳 ──
    const oaMethods = new Set(['openalex-doi', 'openalex-title'])
    let streak = 0
    let pending = []
    let quotaStopped = false
    const hitQuota = (cs, label) => {
        streak++
        pending.push(...cs)
        log?.warn?.(`原文回溯：${label} ${OPENALEX_QUOTA_MESSAGE}（連續第 ${streak} 次，連續 ${OPENALEX_QUOTA_STOP_AFTER} 次即停止 OpenAlex 回溯）`)
        return streak >= OPENALEX_QUOTA_STOP_AFTER
    }
    const clearQuota = async () => {
        if (!streak) return
        streak = 0
        const list = pending
        pending = []
        for (const c of list) await record(c, { outcome: 'fetch-failed', why: OPENALEX_QUOTA_MESSAGE })
    }
    // ① API 批次(arXiv、OpenAlex DOI)
    for (const [method, fetchBatch] of [['arxiv', net.arxiv], ['openalex-doi', net.openalexDoi]]) {
        const list = todo.filter((c) => c.method === method)
        for (let i = 0; i < list.length; i += BATCH) {
            if (quotaStopped) break
            const page = list.slice(i, i + BATCH)
            let got = null
            let quota = false
            try {
                got = await fetchBatch(page.map((c) => c.key))
            }
            catch (e) {
                if (oaMethods.has(method) && isOpenAlexQuota(e)) quota = true
                else log?.warn?.(`原文回溯：${method} 批次失敗（${oneline(e?.message, 120)}），本批 ${page.length} 篇記 fetch-failed`)
            }
            if (quota) {
                quotaStopped = hitQuota(page, method)
                if (!quotaStopped) await net.pause?.(method)
                continue
            }
            if (oaMethods.has(method)) await clearQuota()
            for (const c of page) await record(c, got ? judgeAbstractRefetch(c.d, got.get(c.key) || null, { byId: true }) : { outcome: 'fetch-failed', why: `${method} 批次失敗` })
            await net.pause?.(method)
        }
    }
    // ② OpenAlex 依題名(只收題名相同且網址相同者;多筆同名取網址相符者)
    for (const c of todo.filter((x) => x.method === 'openalex-title')) {
        if (quotaStopped) break
        let j
        try {
            const recs = await net.openalexTitle(c.d.title)
            const hit = recs.find((r) => titleKeyOf(r.title) === titleKeyOf(c.d.title) && String(r.url || '').toLowerCase() === String(c.d.url || '').toLowerCase()) || null
            j = judgeAbstractRefetch(c.d, hit)
        }
        catch (e) {
            if (isOpenAlexQuota(e)) {
                quotaStopped = hitQuota([c], 'openalex-title')
                if (!quotaStopped) await net.pause?.('openalex-title')
                continue
            }
            j = { outcome: 'fetch-failed', why: oneline(e?.message, 120) }
        }
        await clearQuota()
        await record(c, j)
        await net.pause?.('openalex-title')
    }
    // OpenAlex 段結束:額度用盡停止者,遭 429 之 pending 與未發出請求者皆為未處理(不入處置帳,下次直接續跑);否則未達門檻之 429 殘餘照舊記 fetch-failed
    if (quotaStopped) {
        pending = []
        const left = todo.filter((c) => oaMethods.has(c.method) && !handled.has(c.d.id))
        const byLeft = {}
        for (const c of left) byLeft[c.method] = (byLeft[c.method] || 0) + 1
        out.quotaStop = { after: OPENALEX_QUOTA_STOP_AFTER, unprocessed: left.length, byMethod: byLeft, message: openAlexQuotaStopText(left.length) }
        log?.warn?.(`原文回溯：${out.quotaStop.message}（${Object.entries(byLeft).map(([k, v]) => `${k} ${v}`).join('、')}）`)
    }
    else {
        await clearQuota()
    }
    // ③ 網頁(內建正文抓取器)
    for (const c of todo.filter((x) => x.method === 'article')) {
        let j
        try {
            await net.pauseHost?.(c.d.url)
            j = judgeArticleRefetch(c.d, await net.article(c.d.url), { gates, maxTextChars })
        }
        catch (e) {
            j = { outcome: 'fetch-failed', why: oneline(e?.message, 120) }
        }
        await record(c, j)
    }
    log?.info?.(`原文回溯：處理 ${out.processed} 篇（${Object.entries(out.outcomes).map(([k, v]) => `${k} ${v}`).join('、')}）；對象共 ${out.candidates} 篇${out.quotaStop ? `；OpenAlex 額度用盡而停止，未處理 ${out.quotaStop.unprocessed} 篇` : ''}`)
    return out
}

export default { REFETCH_LEDGER_FILE, titleKeyOf, refetchMethodOf, judgeArticleRefetch, judgeAbstractRefetch, parseArxivFeed, refetchSources }
