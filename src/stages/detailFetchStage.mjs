// detailFetchStage.mjs — 抓取物件子階段 a3:逐篇補素材(逐 doc 動作鏈)
//
// hook 錨點:capture.detailFetch.{titleSkip, routeFetcher(first), fetchDetail, contentGate, browserRetry,
//           transcodeLinks, feedFallback, persistOutcome}
// 逐 doc 一條 msg(topic:'doc')流過八環:標題預篩 → 路由(first:彙整貼文走 links;doc.fetcher 指名)→ 抓取 →
// 健全閘 → 瀏覽器升級(可短路:延後)→ 轉錄(彙整貼文短路)→ feed 退路(短路)→ 落庫(raw/dead/new/skip)。
// 抓取嘗試/內容契約復用 w-data-pipeline 內件(attemptFetch/normalizeContent)。
//
// 【兩個佇列】補全文佇列＝status new 且非指名瀏覽器;瀏覽器佇列＝status new 且 doc.fetcher='browser'(延後件、前輪瀏覽器失敗件、回收件)。
//   兩者分開挑選:延後件不計 tries 又多為舊件,與新件混排會永遠佔住隊頭、餓死新文件。
//   順序:先補全文(其中可救者同輪升級瀏覽器,占用配額),再以剩餘配額消化瀏覽器佇列。
// 【分流規則單一來源】終態／重試／轉瀏覽器與各類階梯皆由 stores/fetchPolicy 判定;正文可用與否由 stores/contentGate 判定。
// 【延後不計 tries】配額或時間用盡、或瀏覽器環境不可用時,可救件標 doc.fetcher='browser' 留待下輪,fetchTries 不動——
//   計 tries 會讓可救件三輪內被判 dead;環境失敗算在文件頭上亦同。feed 內文足量者不延後,照舊走 feed 退路。
// 【落 raw 之兩個入口同受 CS1a 與 CS10】正文落盤(persistOutcome)與 feed 退路(feedFallback)皆:過健全閘(feed 門檻 minFallbackChars,
//   長度條件以 feed 原長判)→ 記閘之版本 healthV(存量依版重判,stores/healthRecheck)→ 同一內容判定(contentIndex.matchSameContent:
//   網址代稱＋段落重疊;錨須已取得內容)→ 重疊者 skip(duplicate,記 dupOf),否則記 paraKeys,並**當下另存原文**(core/stores/docTexts:
//   庫內形態＋去重截斷前之取得物;另存失敗不擋落 raw,瘦身時補存)。
// 【網路問題不算在文件頭上】開工前探測本機網路(core/util/netGuard),不通即本段略過;落帳計次前,失敗可能出自網路者
//   (fetchPolicy.mayBeNetFailure)強制重探確認,不通 → 不計 tries、本段停止。
// 【暫時性失敗之時間退避】retry 類失敗記 retryAt(settings.capture.articles.retryBackoffHours;6 時、24 時),退避中不取件——每輪重試、3 次即 dead
//   會在站台維護 2 小時內判死整批。
// 【判死記一級類別】dead 寫 deadClass(分流類別)、httpCode、deadBy(實際抓取器;存量重判為 health);內容類判死(付費牆、找不到、軟 404、
//   錯頁)另存判定依據並記閘版本 healthV(閘改版後依版重判,docMaintain)。

import isobj from 'wsemi/src/isobj.mjs'
import { attemptFetch } from 'w-data-pipeline/src/fetch/attemptFetch.mjs'
import { normalizeContent } from 'w-data-pipeline/src/fetch/itemContract.mjs'
import { isTimeoutError } from 'w-data-pipeline/src/core/errors.mjs'
import { defineMw, defineFirstMw, applyTaps, makeMsg, count, runChainOverMsgs, stdReport, stageFields } from '../core/kernel.mjs'
import { budgetOf, oneline } from '../core/runnerPackage.mjs'
import { byRetryTierFifo, backoffUntil, docQueuesOf, docQueueStatsOf } from '../core/stores/docPolicy.mjs'
import { archiveDocText } from '../core/stores/docTexts.mjs'
import { defaultToLinkedRecord } from '../core/util/records.mjs'
import { normalizeUrl } from '../core/util/web.mjs'
import { toPatterns } from '../core/util/patterns.mjs'
import { netDownAtStart, netDownNow } from '../core/util/netGuard.mjs'
import { createContentGate, dedupeText, gateVersionOf } from '../stores/contentGate.mjs'
import { checkTitleBody } from '../standards/docStandards.mjs'
import { contentIndexOf, isContentAnchor, matchSameContent, sameContentPatch } from '../stores/contentIndex.mjs'
import { markSameContent } from '../stores/ingestGate.mjs'
import { STATUS } from '../core/standards/verdict.mjs'
import { classifyFetch, httpCodeOf, ladderFor, isPdfUrl, mayBeNetFailure, browserQueueOn, browserQueueFields } from '../stores/fetchPolicy.mjs'
import { runBrowserCli, createBrowserRound, ladderTimeoutMs } from '../fetchers/browserFetcher.mjs'
import { GATE_DEAD_CLASSES } from '../stores/healthRecheck.mjs'

/** 內容類判死(判定依據為已取得之正文,另存之);其中閘判者(GATE_DEAD_CLASSES)另記閘版本,閘改版後依版重判(docMaintain) */
export const CONTENT_DEAD_CLASSES = [...GATE_DEAD_CLASSES, 'title-mismatch']

/**
 * feed 內文可否作退路:長度 ≥ minFallbackChars 且過同一健全閘(門檻＝minFallbackChars;長度條件以 feed 原長判)。
 * 瀏覽器升級「放棄延後、改走 feed」與 feed 退路本身共用此一判定——只驗長度的話,feed 未過閘時會落庫計次
 *
 * @param {Object} doc 輸入文件(取 feedText、feedFullLength、title)
 * @param {Object} standards 輸入 settings.capture.standards(取 minFallbackChars 與健全閘之各鍵)
 * @returns {Object} 回傳 { usable:Boolean, long:Boolean, gate:閘結果|null, fullLength:Integer }
 * @example
 * console.log(feedUsableOf({ title: '黑洞光譜', feedText: '太短' }, { minFallbackChars: 20 }))
 * // => { usable: false, long: false, gate: null, fullLength: 2 }
 *
 * let feedText = '這是一篇關於黑洞光譜觀測的長摘要，內容包含吸積盤與噴流的描述，用來示範內文足量時的判定結果。'
 * let r = feedUsableOf({ title: '黑洞光譜', feedText }, { minFallbackChars: 20 })
 * console.log(r.usable, r.long, r.fullLength, r.gate.ok)
 * // => true true 46 true
 */
export function feedUsableOf(doc, standards) {
    const text = String(doc?.feedText || '')
    const fullLength = Number(doc?.feedFullLength) > 0 ? Number(doc.feedFullLength) : text.length
    if (text.length < standards.minFallbackChars) return { usable: false, long: false, gate: null, fullLength }
    const gate = createContentGate({ ...standards, minTextChars: standards.minFallbackChars }).assess({ text, title: doc.title, fullLength })
    return { usable: gate.ok, long: true, gate, fullLength }
}

/**
 * 另存原文(落 raw、內容類判死);集合未設或另存失敗不擋落庫(失敗計數並 WARN,瘦身時另存庫內形態)
 *
 * @param {Object} ctx 輸入鏈上下文
 * @param {Object} msg 輸入訊息
 * @param {Object} rec 輸入另存記錄(archiveDocText 之 doc)
 * @param {Object} [o={}] 輸入 { raw, rawFrom }
 * @returns {Promise} 回傳 Promise,resolve 回傳是否已存
 */
async function archiveNow(ctx, msg, rec, o = {}) {
    const archive = ctx.deps.stores?.docTexts
    // capture.articles.archiveText:false → 不另存(零件庫用法之選項;終態瘦身亦不清正文——docMaintain)
    if (!archive || ctx.deps.settings?.capture?.articles?.archiveText === false) return false
    try {
        const r = await archiveDocText(archive, rec, ctx.deps.clock?.iso8?.() || '', o)
        if (r.ok) {
            count(msg, 'archivedNow')
            return true
        }
        count(msg, 'archiveFailed')
        ctx.log.warn(`內文[${oneline(rec.title || rec.url, 40)}] 原文另存失敗（${r.reason}；落庫照常，瘦身時補存）`)
    }
    catch (e) {
        count(msg, 'archiveFailed')
        ctx.log.warn(`內文[${oneline(rec.title || rec.url, 40)}] 原文另存失敗（${oneline(e?.message, 120)}；落庫照常，瘦身時補存）`)
    }
    return false
}

/**
 * mw 錨點 capture.detailFetch.titleSkip:標題預篩:確定不含知識的例行貼文(彙整/公告)標記 _titleSkip,改走連結轉錄
 *
 * 讀 msg.data.title;寫 msg.data._titleSkip(Boolean)。不短路。
 *
 * @param {Object} [opt={}] 輸入子階段 opts,非物件則回退為 {}
 * @param {Array} [opt.patterns] 輸入標題比對之正則陣列,未給則以 toPatterns 編譯 ctx.deps.settings.capture.articles.skipTitlePatterns(RegExp 或 { p, f })
 * @returns {Object} 回傳 defineMw 產物
 * @example
 * let run = composeChain([mwTitleSkip({ patterns: [/週報|彙整/] })])
 * let a = await run(makeMsg('doc', { title: '天文週報 第12期' }), { deps: {} })
 * let b = await run(makeMsg('doc', { title: '黑洞光譜' }), { deps: {} })
 * console.log(a.msg.data._titleSkip, b.msg.data._titleSkip)
 * // => true false
 */
export const mwTitleSkip = (opt = {}) => {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    return defineMw({
        name: 'titleSkip',
        handle: async (msg, ctx, next) => {
            const patterns = opt.patterns || toPatterns(ctx.deps.settings.capture.articles.skipTitlePatterns, 'capture.articles.skipTitlePatterns')
            msg.data._titleSkip = patterns.some((re) => re.test(msg.data.title || ''))
            return next(msg)
        },
    })
}

/**
 * mw 錨點 capture.detailFetch.routeFetcher(first 錨點):第一個回非空 id 者勝出;都不回則用 doc.fetcher 指名(如 'browser'),
 * 再無則交 registry 依 match 自動判定
 *
 * 讀 msg.data._titleSkip／msg.data.fetcher;寫 msg.data._route(經本錨點自訂之 apply:勝出候選之結果，都不回則取 msg.data.fetcher，再無則空字串)。不短路。
 * 無 opt 參數。
 *
 * @returns {Object} 回傳 defineFirstMw 產物
 * @example
 * let mw = mwRouteFetcher()
 * let a = await composeChain([mw])(makeMsg('doc', { _titleSkip: true }), { deps: {} })
 * let b = await composeChain([mw])(makeMsg('doc', { _titleSkip: false, fetcher: 'browser' }), { deps: {} })
 * console.log(mw.name, mw.mode, a.msg.data._route, b.msg.data._route)
 * // => routeFetcher first links browser
 */
export const mwRouteFetcher = () => defineFirstMw({
    name: 'routeFetcher',
    candidates: [
        { name: 'aggregator-links', probe: (m) => (m.data._titleSkip ? 'links' : null) },
    ],
    apply: (msg, result) => {
        msg.data._route = result || msg.data.fetcher || ''
    },
})

/**
 * mw 錨點 capture.detailFetch.fetchDetail:內文抓取:依路由解析 detail 抓取器,attemptFetch＋內容契約;失敗記 _fetched.ok=false
 *
 * 讀 msg.data._route／msg.data.fetcher／msg.data.kind／msg.data.title／msg.data.url／msg.data.fetchTries;
 * 寫 msg.data._tries、msg.data._fetched、msg.data._fetcherId(實際使用之抓取器 id,分流規則據此判)。不短路。
 *
 * @param {Object} [opt={}] 輸入子階段 opts,非物件則回退為 {}
 * @param {Function} [opt.timeoutMsOf] 輸入逐篇逾時 (doc, { remainingMs, left, index }) => 毫秒(回非正整數即用抓取器或設定之逾時):
 *   單輪流程依整輪剩餘時間逐篇分配逾時(left＝本輪排在本篇之後之篇數、index＝本篇序;皆以本輪取件時之序計)
 * @returns {Object} 回傳 defineMw 產物
 * @throws {Error} 無可用內文抓取器(kind 未指定或未註冊)時拋出
 * @example
 * // W 為 w-data-pipeline 之預設匯出(import W from 'w-data-pipeline/src/WDataPipeline.mjs')
 * let fetcher = W.defineFetcher({ id: 'article', role: 'detail', kinds: ['web'], fetch: async () => ({ ok: true, text: '黑洞光譜的全文內容。', title: '黑洞光譜' }) })
 * let ctx = { deps: { registry: { resolve: () => fetcher }, settings: { capture: { articles: { timeoutMs: 0 } } } }, log: { info() {}, warn() {} } }
 * let msg = makeMsg('doc', { id: 'd1', kind: 'web', title: '黑洞光譜', url: 'https://example.com/post/1', fetchTries: 0 })
 * let { msg: out } = await composeChain([mwFetchDetail()])(msg, ctx)
 * console.log(out.data._fetcherId, out.data._tries, out.data._fetched.ok, out.data._fetched.contentLength)
 * // => article 1 true 10
 */
export const mwFetchDetail = (opt = {}) => defineMw({
    name: 'fetchDetail',
    handle: async (msg, ctx, next) => {
        const doc = msg.data
        const { registry, settings } = ctx.deps
        const timeoutOf = isobj(opt) && typeof opt.timeoutMsOf === 'function' ? opt.timeoutMsOf : null
        const fetcher = registry.resolve('detail', { ...doc, fetcher: doc._route || undefined }, ctx)
        if (!fetcher) throw new Error(`無可用內文抓取器（kind=${doc.kind || '未指定'}）`)
        doc._tries = (doc.fetchTries || 0) + 1
        doc._fetcherId = fetcher.id
        // 檢定標準 CS1e:自訂抓取器同過正文健全閘,除非其定義明示豁免(contract.gateExempt:true——站點專屬解析、結構化來源等,安裝方負責)
        doc._gateExempt = fetcher.contract?.gateExempt === true
        const label = oneline(doc.title || doc.url, 40)
        // PDF(網址判;curl 不回 Content-Type、以 UTF-8 解二進位,瀏覽器無頭會下載而非渲染):不發請求、不佔瀏覽器名額,分流判終態
        //   (內建正文抓取器才判;安裝方之自訂抓取器可自行處理 PDF)
        if (['article', 'browser'].includes(fetcher.id) && isPdfUrl(doc.url)) {
            doc._fetched = { ok: false, reason: 'pdf', message: 'PDF 文件（尚無正文抽取）', text: '', title: '', links: [], extra: {} }
            ctx.log.info(`內文[${label}] PDF 文件，未抓取（尚無正文抽取）`)
            return next(msg)
        }
        try {
            let timeoutMs = fetcher.timeoutMs || settings.capture.articles.timeoutMs || 0
            if (timeoutOf) {
                const own = timeoutOf(doc, { remainingMs: budgetOf(ctx).remainingMs(), left: Number(doc._left) || 0, index: Number(doc._index) || 0 })
                if (Number.isInteger(own) && own > 0) timeoutMs = own
            }
            const raw = await attemptFetch(fetcher, doc, ctx, timeoutMs)
            doc._fetched = normalizeContent(raw, { fetcherId: fetcher.id, minTextChars: fetcher.contract?.minTextChars })
            if (doc._fetched.ok && doc._fetched.links?.length) ctx.log.info(`內文[${label}] 成功（連結 ${doc._fetched.links.length} 條，${fetcher.id}）`)
            else if (doc._fetched.ok) ctx.log.info(`內文[${label}] 成功（${doc._fetched.contentLength} 字，${fetcher.id}${doc._fetched.extra?.adapterId ? `／adapter:${doc._fetched.extra.adapterId}` : ''}${doc._fetched.extra?.method && fetcher.id === 'browser' ? `／${doc._fetched.extra.method}` : ''}）`)
            else ctx.log.warn(`內文[${label}] 失敗（${doc._fetched.reason}：${oneline(doc._fetched.message, 120)}${fetcher.id === 'browser' ? `；階梯 ${(doc._fetched.extra?.steps || []).join('→')}` : ''}）`)
        }
        catch (e) {
            doc._fetched = { ok: false, reason: isTimeoutError(e) ? 'timeout' : 'fetch-error', message: oneline(e?.message, 300), text: '', title: '', links: [], extra: {} }
            ctx.log.warn(`內文[${label}] 失敗（${doc._fetched.reason}）：${oneline(e?.message, 200)}`)
        }
        return next(msg)
    },
})

/**
 * 檢定標準 CS2:記錄標題(清單／feed 所給)之詞皆不見於正文 → 錯頁(與符合度掃描同一判定 docStandards.checkTitleBody);
 *   正文抓取器與同輪瀏覽器救回(子行程無標題通道)兩處共用
 *
 * @param {Object} doc 輸入文件(取 title)
 * @param {String} text 輸入抓得之正文
 * @returns {String} 回傳不符之說明(相符或不適用回'')
 */
function titleMismatchOf(doc, text) {
    const tb = checkTitleBody(doc.title, text)
    return tb.status === STATUS.VIOLATION ? `標題與正文不符（${tb.detail}）` : ''
}

/**
 * 同一內容判定(檢定標準 CS10)是否開啟:capture.standards.sameContent 未給或非 false 即開(與入庫閘 stores/ingestGate 同一判準)
 *
 * @param {Object} ctx 輸入鏈上下文
 * @returns {Boolean} 回傳是否判定
 */
function sameContentOn(ctx) {
    return ctx.deps.settings?.capture?.standards?.sameContent !== false
}

/**
 * 寫入新段落雜湊(或改判 skip)前清除文件既有之 paraKeys:集合之 patch 為深合併(陣列逐位置合併),新陣列較短時殘留舊尾
 *   (素材被下游回報有問題而重抓之文件帶有前次之 paraKeys;見 stores/contentIndex 檔頭)
 *
 * @param {Object} docs 輸入 docs 集合
 * @param {Object} doc 輸入文件(取 id、paraKeys)
 * @returns {Promise} 回傳 Promise,resolve 時代表已清除(無既有陣列則不寫)
 */
async function clearParaKeys(docs, doc) {
    if (Array.isArray(doc.paraKeys) && doc.paraKeys.length) await docs.patch(doc.id, { paraKeys: null })
}

/**
 * 本輪之閘版本(檢定標準 CS1a;落 raw 時記 healthV):補全文子階段每輪算一次帶在訊息上(_healthV),自組鏈未帶者當場算
 *
 * @param {Object} doc 輸入訊息之 data
 * @param {Object} standards 輸入 settings.capture.standards
 * @returns {String} 回傳閘之版本
 */
const healthVOf = (doc, standards) => doc._healthV || gateVersionOf(standards)

/** 轉錄連結濾除之類別說明(articleParse.extractLinks 之計數鍵;capped 為逾每篇上限而未轉錄) */
const LINK_FILTER_LABELS = { invalid: '無效網址', nonHttp: '非 http', sameSite: '同站', share: '分享按鈕', denyHost: '學術索引／平台工具', shortText: '連結文字過短', capped: '逾每篇上限' }

/**
 * 轉錄連結濾除之計數入鏈統計(linkFiltered_<類別>)並組日誌說明(靜默剔除改計數)
 *
 * @param {Object} msg 輸入訊息
 * @param {Object} counts 輸入 { 類別: 數 }
 * @returns {String} 回傳日誌說明(無濾除回 '')
 */
function noteLinkFiltered(msg, counts) {
    const parts = []
    for (const [k, v] of Object.entries(isobj(counts) ? counts : {})) {
        const n = Number(v) || 0
        if (n <= 0) continue
        count(msg, `linkFiltered_${k}`, n)
        parts.push(`${LINK_FILTER_LABELS[k] || k} ${n}`)
    }
    return parts.length ? `；濾除 ${parts.join('、')}` : ''
}

/**
 * mw 錨點 capture.detailFetch.contentGate:正文健全閘(stores/contentGate;含軟 404):抓取「成功」但不可用者改判失敗(reason＝類別),交分流。
 * 軟 404 與其他類同屬健全閘(單一擁有者):瀏覽器階梯之結果於子行程內經同一閘(fetchers/browserLadder),不經本錨點
 *
 * 對正文抓取器之成功結果、且非標題預篩命中者作用(when)——內建(article／browser)與安裝方自訂者皆然(檢定標準 CS1e:
 * 自訂抓取器之結果亦須經健全判定,否則未經任何判定即入 raw);抓取器定義明示 contract.gateExempt:true 者豁免。讀 msg.data._fetched、msg.data._gate(本輪之健全閘;
 * 缺省時依 settings.capture.standards 建立);寫 msg.data._fetched(不合格時改為 { ok:false, reason, gate })。不短路。自訂抓取器之不合格分流為重試(fetchPolicy)。
 *
 * @returns {Object} 回傳 defineMw 產物
 * @example
 * // gate 以替身代之(實際缺省時依 settings.capture.standards 由 createContentGate 建立)
 * let gate = { assess: () => ({ ok: false, kind: 'paywall', hit: '訂閱後閱讀全文' }) }
 * let fetched = { ok: true, text: '訂閱後閱讀全文', title: '', links: [], extra: {} }
 * let msg = makeMsg('doc', { title: '黑洞光譜', url: 'https://example.com/post/1', _gate: gate, _fetched: fetched })
 * let { msg: out } = await composeChain([mwContentGate()])(msg, { deps: {}, log: { info() {}, warn() {} } })
 * console.log(out.data._fetched.ok, out.data._fetched.reason, out.stats)
 * // => false paywall { gate_paywall: 1 }
 */
export const mwContentGate = () => defineMw({
    name: 'contentGate',
    when: (m) => !m.data._titleSkip && m.data._fetched?.ok === true && !m.data._gateExempt,
    handle: async (msg, ctx, next) => {
        const doc = msg.data
        const f = doc._fetched
        const gate = doc._gate || createContentGate(ctx.deps.settings.capture.standards)
        const g = gate.assess({ text: f.text, title: f.title || doc.title, adapterId: f.extra?.adapterId, url: doc.url, finalUrl: f.extra?.finalUrl || '' })
        if (!g.ok) {
            doc._fetched = { ...f, ok: false, reason: g.kind, message: `健全閘：${g.hit}`, gate: g.kind }
            count(msg, `gate_${g.kind}`)
            ctx.log.info(`內文[${oneline(doc.title || doc.url, 40)}] 健全閘判 ${g.kind}（${oneline(g.hit, 80)}）`)
            return next(msg)
        }
        // 檢定標準 CS2:正文抓取器 → 轉瀏覽器重抓;瀏覽器亦不符 → 終態(dead,類別 title-mismatch,可 revive)——分流見 fetchPolicy.classifyFetch;
        //   capture.standards.titleMismatch:false 即不判(零件庫用法之選項;符合度掃描列停用)
        const tm = ctx.deps.settings.capture.standards?.titleMismatch === false ? '' : titleMismatchOf(doc, f.text)
        if (tm) {
            doc._fetched = { ...f, ok: false, reason: 'title-mismatch', message: tm, gate: 'title-mismatch' }
            count(msg, 'gate_title-mismatch')
            ctx.log.info(`內文[${oneline(doc.title || doc.url, 40)}] ${tm}（${doc._fetcherId}）`)
        }
        return next(msg)
    },
})

/**
 * 延後至瀏覽器佇列(不計 tries):路由欄位經 browserQueueFields(已在佇列者保留原進佇列時刻——每次延後皆重設者,
 *   瀏覽器環境連續斷路時佇列最舊天數即被低報),留待下輪
 *
 * @param {Object} ctx 輸入鏈上下文
 * @param {Object} msg 輸入訊息
 * @param {String} cls 輸入分流類別(決定下輪階梯)
 * @param {String} why 輸入延後原因
 * @returns {Promise} 回傳 Promise，resolve 時代表已落帳
 */
async function deferToBrowser(ctx, msg, cls, why) {
    const doc = msg.data
    await ctx.deps.stores.docs.patch(doc.id, {
        ...browserQueueFields(doc, cls, ctx.deps.clock.iso8()),
        lastReason: String(doc._fetched?.reason || '').slice(0, 40),
        lastError: String(doc._fetched?.message || '').slice(0, 200),
        deferrals: (doc.deferrals || 0) + 1,
    })
    count(msg, 'browserDeferred')
    ctx.log.info(`內文[${oneline(doc.title || doc.url, 40)}] 延後至瀏覽器佇列（${why}；不計 tries）`)
}

/**
 * mw 錨點 capture.detailFetch.browserRetry:分流(stores/fetchPolicy)與瀏覽器升級;可短路(延後)
 *
 * 僅對失敗結果、且非標題預篩命中者作用(when)。讀 msg.data._fetched／_fetcherId／_browserRound(本輪瀏覽器狀態)／feedText;
 * 寫 msg.data._class({ action, cls }，persistOutcome 據此判終態)與(升級成功時)msg.data._fetched。
 * - 內建 article 之失敗且分流為 browser:本輪可開工 → 子行程跑階梯(同輪升級不加 curl 前置),結果取代 _fetched;
 *   不可開工 → feed 足量者放行交 feed 退路,否則延後(短路);
 * - 瀏覽器抓取器之失敗:環境失敗 → 延後(短路);其餘依結果判 final 或 browser-failed(計 tries,仍留瀏覽器佇列)。
 *
 * @param {Object} [opt={}] 輸入子階段 opts,非物件則回退為 {}
 * @param {Function} [opt.runCli] 輸入子行程執行器(測試注入,傳給 runBrowserCli)
 * @returns {Object} 回傳 defineMw 產物
 * @example
 * // 瀏覽器佇列件(_fetcherId 為 browser)失敗且非環境失敗:標記 browser-failed 後續走，仍留瀏覽器佇列待下輪(不啟動瀏覽器)
 * let fetched = { ok: false, reason: 'timeout', message: '逾時', extra: {} }
 * let msg = makeMsg('doc', { id: 'd1', title: '黑洞光譜', url: 'https://example.com/post/1', _fetcherId: 'browser', _fetched: fetched })
 * let ctx = { deps: { settings: { capture: {} } }, log: { info() {}, warn() {} } }
 * let { msg: out, halted } = await composeChain([mwBrowserRetry()])(msg, ctx)
 * console.log(out.data._class, JSON.stringify(halted))
 * // => { action: 'browser-failed', cls: 'render' } ""
 */
export const mwBrowserRetry = (opt = {}) => {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    return defineMw({
        name: 'browserRetry',
        when: (m) => !m.data._titleSkip && m.data._fetched && m.data._fetched.ok !== true,
        handle: async (msg, ctx, next) => {
            const doc = msg.data
            const f = doc._fetched
            const cap = ctx.deps.settings.capture
            // feed 可作退路(長度＋同一健全閘)才放棄延後;只看長度時 feed 未過閘即落庫計次
            let feedOk
            const feedUsable = () => {
                if (feedOk === undefined) feedOk = feedUsableOf(doc, cap.standards).usable
                return feedOk
            }
            const c = classifyFetch({ ok: false, reason: f.reason, httpCode: f.extra?.httpCode || httpCodeOf(f), adapterId: f.extra?.adapterId, fetcherId: doc._fetcherId })

            // ── 瀏覽器佇列件(抓取器即瀏覽器階梯)──
            if (doc._fetcherId === 'browser') {
                if (f.reason === 'browser-env') {
                    count(msg, 'browserEnvFail')
                    if (feedUsable()) return next(msg)
                    await deferToBrowser(ctx, msg, doc.lastClass || 'render', '瀏覽器環境不可用')
                    return msg
                }
                const finalCls = f.reason === 'no-alt-method' ? 'no-alt-method' : (c.action === 'final' ? c.cls : 'browser-final')
                doc._class = (f.extra?.final || c.action === 'final') ? { action: 'final', cls: finalCls } : { action: 'browser-failed', cls: doc.lastClass || 'render' }
                return next(msg)
            }

            doc._class = c
            if (c.action !== 'browser') return next(msg)
            const round = doc._browserRound
            // 瀏覽器分流停用(capture.browser.perRun 0):照舊 curl 重試(計 tries)——不可延後至一個永遠不會被消化的佇列
            if (!round) {
                doc._class = { action: 'retry', cls: c.cls, why: '瀏覽器分流停用' }
                return next(msg)
            }
            const steps = ladderFor(c.cls, { camofoxEnabled: cap.browser.camofox.enabled, crossRound: false })
            if (!round.canStart(steps)) {
                if (feedUsable()) return next(msg)
                await deferToBrowser(ctx, msg, c.cls, '本輪瀏覽器配額／時間用盡或方法斷路')
                return msg
            }
            round.take()
            const r = await runBrowserCli(doc.url, steps, { capture: cap, tmpDir: ctx.deps.dirs?.tmp, tag: doc.id, skip: [...round.broken], adapterSpecs: ctx.deps.siteAdapterSpecs, runCli: opt.runCli })
            round.account(r)
            const trail = (r.steps || []).map((s) => `${s.step}:${s.ok ? 'ok' : (s.skipped || s.gate || s.reason || 'fail')}`).join('→')
            const label = oneline(doc.title || doc.url, 40)
            if (r.status === 'success') {
                // 子行程之閘無標題通道:救回之正文於此以同一判定查 CS2;仍不符 → 終態(錯頁,可 revive;救回之正文即判定依據,另存)
                const tm = titleMismatchOf(doc, r.content)
                if (tm) {
                    doc._fetched = { ...f, ok: false, text: '', reason: 'title-mismatch', message: tm, gate: 'title-mismatch', extra: { ...(f.extra || {}), final: true, curlReason: f.reason, evidence: { text: r.content, title: r.title || '', method: `browser:${r.method || ''}`, finalUrl: r.finalUrl || '' } } }
                    doc._fetcherId = 'browser'
                    doc._class = { action: 'final', cls: 'title-mismatch' }
                    count(msg, 'gate_title-mismatch')
                    ctx.log.warn(`內文[${label}] 瀏覽器救回之正文仍${tm}（${r.method}；${trail}）`)
                    return next(msg)
                }
                doc._fetched = { ok: true, text: r.content, title: r.title, links: [], contentLength: r.content.length, reason: '', message: '', extra: { method: r.method, finalUrl: r.finalUrl || '', adapterId: r.adapterId || '' } }
                doc._fetcherId = 'browser'
                doc._class = { action: 'ok', cls: c.cls }
                count(msg, 'browserOk')
                ctx.log.info(`內文[${label}] 瀏覽器救回（${r.content.length} 字，${r.method}；${trail}）`)
                return next(msg)
            }
            if (r.reason === 'browser-env') {
                count(msg, 'browserEnvFail')
                ctx.log.warn(`內文[${label}] 瀏覽器環境不可用（${oneline(r.message, 120)}；${trail}），本輪斷路：${[...round.broken].join('、') || '-'}`)
                if (feedUsable()) return next(msg)
                await deferToBrowser(ctx, msg, c.cls, '瀏覽器環境不可用')
                return msg
            }
            // 瀏覽器結果取代 _fetched 時保留 curl 之原始歸因(curlReason):末階錯誤不得掩蓋最初為何轉瀏覽器。
            //   curl 之正文與閘類別不留(那不是瀏覽器之判定依據);瀏覽器階之終態閘(付費牆、找不到、軟 404)另帶其正文(evidence)
            doc._fetched = { ...f, ok: false, text: '', gate: '', reason: r.reason, message: r.message, extra: { ...(f.extra || {}), httpCode: r.httpCode || 0, final: !!r.final, curlReason: f.reason, ...(isobj(r.evidence) ? { evidence: r.evidence } : {}) } }
            // 終態之類別取瀏覽器結果之分流類別(付費牆／找不到／軟 404／HTTP 決定性);判死欄位 deadClass 據此
            const rc = classifyFetch({ ok: false, reason: r.reason, httpCode: r.httpCode || 0, fetcherId: 'browser' })
            doc._class = r.final ? { action: 'final', cls: rc.action === 'final' ? rc.cls : 'browser-final' } : { action: 'browser-failed', cls: c.cls }
            ctx.log.warn(`內文[${label}] 瀏覽器亦失敗（${r.reason}：${oneline(r.message, 100)}；${trail}）`)
            return next(msg)
        },
    })
}

/**
 * mw 錨點 capture.detailFetch.transcodeLinks:彙整貼文轉錄:連結是這篇的全部價值;無連結可轉錄則直接略過(送 AI 只會白燒額度)。
 *
 * 僅 msg.data._titleSkip 為真且已有抓取結果(msg.data._fetched,成敗皆含)時執行(when)。
 * 讀 msg.data._fetched／msg.data.title。抓取成功且有連結:轉錄入庫(ctx.deps.stores.docs.patch status:'aggregated')並 count(msg,'aggregated')、短路;
 * 抓取成功但零連結、或失敗原因為內容契約(too-short:內建 links 抓取器無正文又無連結時 normalizeContent 之判定):標記 status:'skip'、短路
 * (when 因而不要求 _fetched.ok:否則內建抓取器下零連結走不到 skip 分支,會改送 feed 退路進 AI,或重試 3 輪後誤標 dead);
 * 其餘失敗(逾時、網路):呼叫 next 交落庫環退回 new 重試(達上限才 dead),不走 feed 退路。
 * 例行貼文之 skip 帶 skipKind 'routine'(依標題樣式,不是對內容之判定;來源產出統計不計——collectHelpers.judgeFromDocs,檢定標準 CS5)。
 * 濾除之連結(抓取器 extra.linkFiltered 逐因計數)與逾每篇上限而未轉錄者計入鏈統計(linkFiltered_<類別>)並見於日誌。
 *
 * @param {Object} [opt={}] 輸入子階段 opts,非物件則回退為 {}
 * @param {Function} [opt.toLinkedRecord] 輸入連結→doc 記錄轉換函數,未給用預設 toLinkedRecord
 * @param {Integer} [opt.linksPerDoc] 輸入單篇最多轉錄幾條連結,未給則用 settings.capture.articles.aggregatorLinksPerDoc
 * @returns {Object} 回傳 defineMw 產物
 * @example
 * // 彙整貼文(_titleSkip)抓取成功但無連結可轉錄:標記 skip(routine)並短路
 * let patches = []
 * let docs = { patch: async (id, p) => { patches.push(p) } }
 * let ctx = {
 *     deps: { stores: { docs }, clock: { iso8: () => '2026-09-01T00:00:00+08:00' }, settings: { capture: { articles: { aggregatorLinksPerDoc: 5 } } } },
 *     log: { info() {}, warn() {} },
 * }
 * let msg = makeMsg('doc', { id: 'd1', title: '天文週報', _titleSkip: true, _tries: 1, _fetched: { ok: true, text: '', links: [], extra: {} } })
 * let { msg: out, halted } = await composeChain([mwTranscodeLinks()])(msg, ctx)
 * console.log(halted, out.stats, patches[0].status, patches[0].skipKind)
 * // => transcodeLinks { titleSkipped: 1 } skip routine
 */
export const mwTranscodeLinks = (opt = {}) => {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    return defineMw({
        name: 'transcodeLinks',
        when: (m) => m.data._titleSkip && !!m.data._fetched,
        handle: async (msg, ctx, next) => {
            const doc = msg.data
            const { stores, seen, clock, settings } = ctx.deps
            const f = doc._fetched
            const links = (f.ok && f.links) || []
            if (links.length > 0) {
                const toLinked = opt.toLinkedRecord || defaultToLinkedRecord(ctx.deps)
                const take = links.slice(0, opt.linksPerDoc ?? settings.capture.articles.aggregatorLinksPerDoc)
                const linked = take.map((l) => toLinked(l, doc, { nowIso: clock.iso8() }))
                const ins = await seen.admit(linked)
                const same = await markSameContent(ctx, ins.fresh || []) // 檢定標準 CS10:轉錄亦為入庫入口
                await stores.docs.patch(doc.id, { status: 'aggregated', fetchTries: doc._tries, linkCount: links.length })
                count(msg, 'aggregated', ins.fresh.length)
                if (same) count(msg, 'sameContent', same)
                const filtered = noteLinkFiltered(msg, { ...(f.extra?.linkFiltered || {}), capped: links.length - take.length })
                ctx.log.info(`彙整[${oneline(doc.title, 40)}] 連結 ${links.length} 條，轉錄 ${take.length} 條，新增 ${ins.fresh.length} 篇${same ? `（其中 ${same} 篇與既有文件同一內容，記 skip）` : ''}${filtered}`)
                return msg // 短路:轉錄即此篇終點
            }
            if (f.ok || f.reason === 'too-short') {
                await stores.docs.patch(doc.id, { status: 'skip', skipKind: 'routine', fetchTries: doc._tries, skipReason: '標題樣式判定為例行公告／彙整貼文，無可轉錄之連結（未進 AI）', notedAt: clock?.iso8?.() || '' })
                count(msg, 'titleSkipped')
                const filtered = noteLinkFiltered(msg, f.extra?.linkFiltered)
                ctx.log.info(`彙整[${oneline(doc.title, 40)}] 無可轉錄之連結，略過（未進 AI）${filtered}`)
                return msg // 短路:略過即此篇終點
            }
            // 失敗:HTTP 決定性(404／410…)與網址不合法 → 一輪終態(與正文同一分流規則;一律重試的話,404 之彙整頁會白試 3 輪);
            //   其餘(網路、逾時、被擋)交落庫環重試(links 不走瀏覽器與 feed 退路:瀏覽器階梯不產連結,彙整貼文之 feed 內文不是知識)
            const c = classifyFetch({ ok: false, reason: f.reason, httpCode: f.extra?.httpCode || httpCodeOf(f), fetcherId: 'article' })
            doc._class = c.action === 'final' ? { action: 'final', cls: c.cls } : { action: 'retry', cls: c.cls || 'other' }
            return next(msg)
        },
    })
}

/**
 * mw 錨點 capture.detailFetch.feedFallback:feed 退路:全文抓不到但來源自帶素材夠長(feed 內嵌內文/論文摘要)。
 *
 * 僅 msg.data._fetched 存在且 !ok、且非標題預篩命中者(彙整貼文之 feed 內文不是知識,不送 AI)時執行(when)。讀 msg.data.feedText／msg.data._fetched;
 * feedText 未達 settings.capture.standards.minFallbackChars 時呼叫 next 放行(不短路);未過健全閘(門檻＝minFallbackChars;長度條件以 feed 原長 feedFullLength 判,
 * 與存量重判同一把尺)亦放行(不作退路)。
 * 過閘者:檢定標準 CS10——feed 內文之段落與既有文件重疊(與正文落盤同一判定 contentIndex.matchSameContent)→ skip(duplicate,未進 AI)、
 * count(msg,'sameContent');否則寫回 ctx.deps.stores.docs(status:'raw', textFrom:'feed', paraKeys, healthV)、count(msg,'filled')。兩者皆**短路**。
 * 無 opt 參數。
 *
 * @returns {Object} 回傳 defineMw 產物
 * @example
 * // 全文抓取失敗，但來源自帶內文足量且過健全閘:改用 feed 內文落 raw 並短路
 * let patches = []
 * let docs = { patch: async (id, p) => { patches.push(p) } }
 * let settings = { capture: { standards: { minFallbackChars: 20, sameContent: false } } }
 * let ctx = { deps: { stores: { docs }, settings, clock: { iso8: () => '2026-09-01T00:00:00+08:00' } }, log: { info() {}, warn() {} } }
 * let feedText = '這是一篇關於黑洞光譜觀測的長摘要，內容包含吸積盤與噴流的描述，用來示範來源自帶內文足量時的退路。'
 * let fetched = { ok: false, reason: 'timeout', message: '逾時', extra: {} }
 * let msg = makeMsg('doc', { id: 'd1', title: '黑洞光譜', url: 'https://example.com/post/1', feedText, _tries: 1, _fetched: fetched })
 * let { msg: out, halted } = await composeChain([mwFeedFallback()])(msg, ctx)
 * console.log(halted, out.stats, patches[0].status, patches[0].textFrom)
 * // => feedFallback { filled: 1 } raw feed
 */
export const mwFeedFallback = () => defineMw({
    name: 'feedFallback',
    when: (m) => m.data._fetched && !m.data._fetched.ok && !m.data._titleSkip,
    handle: async (msg, ctx, next) => {
        const doc = msg.data
        const { stores, settings, clock } = ctx.deps
        // feed 內文同過健全閘(門檻＝minFallbackChars):feed 裡的付費預告／佔位／亂碼不可繞過正文之閘門;
        //   長度條件以入庫前之 feed 原長判(feedFullLength)——判定與瀏覽器升級之「放棄延後」同一函數 feedUsableOf
        const fu = feedUsableOf(doc, settings.capture.standards)
        if (!fu.long) return next(msg)
        const fullLength = fu.fullLength
        if (!fu.usable) {
            count(msg, `gate_feed-${fu.gate.kind}`)
            ctx.log.info(`全文[${oneline(doc.title, 40)}] feed 內文未過健全閘（${fu.gate.kind}），不作退路`)
            return next(msg)
        }
        // 無損去重(同正文);原長取入庫前之 feed 原長(feedText 入庫即截 maxTextChars,其長度不是原長)
        const dd = dedupeText(doc.feedText)
        // 檢定標準 CS10:feed 內文亦為落 raw 之素材——自身網址之代稱(錨可能於入庫後才取得內容)與段落重疊者為同一內容,不重複入庫
        //   (capture.standards.sameContent:false 即不判、不算段落雜湊)
        const scOn = sameContentOn(ctx)
        const idx = scOn ? await contentIndexOf(stores.docs) : null
        const same = scOn ? matchSameContent(idx, { id: doc.id, urls: [doc.url], text: dd.text }) : { hit: null, paraKeys: null }
        await clearParaKeys(stores.docs, doc)
        if (same.hit) {
            await stores.docs.patch(doc.id, { ...sameContentPatch(same.hit, clock.iso8()), fetchTries: doc._tries, fetcher: '' })
            idx.add({ id: doc.id, status: 'skip', skipKind: 'duplicate', paraKeys: null })
            count(msg, 'sameContent')
            ctx.log.info(`全文[${oneline(doc.title, 40)}] feed 內文與既有文件同一內容（${same.hit.why}），記 skip（未進 AI）`)
            return msg // 短路:同一內容即此篇終點
        }
        if (idx) idx.add({ id: doc.id, url: doc.url, paraKeys: same.paraKeys, status: 'raw' })
        const patch = {
            paraKeys: same.paraKeys, // 段落雜湊(CS10 之跨文件比對;正文瘦身後仍留)
            healthV: healthVOf(doc, settings.capture.standards), // 閘之版本(CS1a 存量依版重判)
            text: dd.text,
            textLength: dd.text.length,
            fullLength,
            // 恆寫(0 亦寫):條件式省鍵會讓重抓後之文件留著前次之去重量(集合 patch 只合併、不刪鍵),下游之原長估算因而偏低
            dedupedChars: dd.removed,
            status: 'raw',
            fetchTries: doc._tries,
            fetcher: '',
            refetchSkip: null,
            textFrom: 'feed',
            lastReason: String(doc._fetched.reason || '').slice(0, 40),
            rawAt: clock.iso8(),
            ...(doc.retryAt ? { retryAt: '' } : {}),
        }
        await stores.docs.patch(doc.id, patch)
        // 落 raw 即另存(庫內形態;feed 逾 maxTextChars 之後段入庫時已截,另存不含該段)
        await archiveNow(ctx, msg, { ...doc, ...patch, feedText: doc.feedText })
        count(msg, 'filled')
        ctx.log.info(`全文[${oneline(doc.title, 40)}] 抓取失敗（${doc._fetched.reason}），改用 feed 內文`)
        return msg // 短路:已入彙整佇列
    },
})

/**
 * mw 錨點 capture.detailFetch.persistOutcome:落庫:成功→raw(素材就緒;轉址至既有文件者→skip 重複);失敗→依分流:
 * final 一輪即 dead,其餘重試計數並退回 new(瀏覽器失敗件留瀏覽器佇列),達 capture.articles.maxTries 標 dead——記錄永不刪除(去重憑證)。
 * 成功落 raw 時記閘之版本 healthV(檢定標準 CS1a 存量依版重判;抓取器明示豁免者另記 gateExempt)與段落雜湊 paraKeys(CS10)。
 *
 * 讀 msg.data._fetched／_tries／_class／_fetcherId;寫回 ctx.deps.stores.docs 並 count(msg,'filled'／'dead'／'duplicate')。不短路。無 opt 參數。
 *
 * @returns {Object} 回傳 defineMw 產物
 * @example
 * let patches = []
 * let docs = { patch: async (id, p) => { patches.push(p) } }
 * let settings = { capture: { articles: { maxTextChars: 1000, maxTries: 3, retryBackoffHours: 6 }, standards: { sameContent: false } } }
 * let ctx = { deps: { stores: { docs }, settings, clock: { iso8: () => '2026-09-01T00:00:00+08:00' } }, log: { info() {}, warn() {} } }
 * let run = composeChain([mwPersistOutcome()])
 *
 * // 成功:落 raw
 * let ok = makeMsg('doc', { id: 'd1', title: '黑洞光譜', url: 'https://example.com/post/1', _tries: 1, _fetcherId: 'article', _fetched: { ok: true, text: '黑洞光譜的全文內容。', title: '黑洞光譜', extra: {} } })
 * let r1 = await run(ok, ctx)
 * console.log(r1.msg.stats, patches[0].status, patches[0].textFrom, patches[0].textLength)
 * // => { filled: 1 } raw article 10
 *
 * // 失敗未達上限:退回 new 重試，並記退避期限 retryAt
 * let fail = makeMsg('doc', { id: 'd2', title: '黑洞光譜', url: 'https://example.com/post/2', _tries: 1, _fetcherId: 'article', _class: { action: 'retry', cls: 'other' }, _fetched: { ok: false, reason: 'timeout', message: '逾時', extra: {} } })
 * await run(fail, ctx)
 * console.log(patches[1].status, patches[1].fetchTries, patches[1].retryAt)
 * // => new 1 2026-08-31T22:00:00.000Z
 */
export const mwPersistOutcome = () => defineMw({
    name: 'persistOutcome',
    handle: async (msg, ctx, next) => {
        const doc = msg.data
        const { stores, settings, seen, clock } = ctx.deps
        const art = settings.capture.articles // 補全文設定組(maxTextChars、maxTries、retryBackoffHours)
        const f = doc._fetched
        if (f?.ok) {
            // 轉址後之內容若已是另一篇既有文件(Google News 包裝頁、短網址、跨站轉載):不重複入庫——該文件須已取得內容
            //   (isContentAnchor;指向舊死件或尚未抓到者時,本篇救回之正文照常落 raw)
            const finalUrl = f.extra?.finalUrl || ''
            if (finalUrl && normalizeUrl(finalUrl) !== normalizeUrl(doc.url) && typeof seen?.idOf === 'function') {
                const dupId = seen.idOf(finalUrl)
                const dup = dupId && dupId !== doc.id ? await stores.docs.get(dupId) : null
                if (dup && isContentAnchor(dup)) {
                    // skipKind duplicate:不是對內容之判定,來源產出統計不計(judgeFromDocs)
                    await clearParaKeys(stores.docs, doc)
                    await stores.docs.patch(doc.id, { status: 'skip', skipKind: 'duplicate', dupOf: dupId, fetchTries: doc._tries, fetcher: '', finalUrl, skipReason: `與既有文件重複（轉址至 ${oneline(finalUrl, 120)}，文件 ${dupId}）（未進 AI）`, notedAt: clock.iso8() })
                    count(msg, 'duplicate')
                    return next(msg)
                }
            }
            const extra = f.extra || {}
            // 無損去重在截斷之前(重複段落膨脹之頁截斷後,截掉之獨有內容在去重前就沒了)
            const dd = dedupeText(f.text)
            // 檢定標準 CS10:自身網址與轉址後網址之正準代稱(錨可能於入庫後才取得內容)、或跨文件段落雜湊重疊 → 與既有文件同一內容,
            //   不重複入庫(stores/contentIndex;capture.standards.sameContent:false 即不判、不算段落雜湊)
            const scOn = sameContentOn(ctx)
            const idx = scOn ? await contentIndexOf(stores.docs) : null
            const same = scOn ? matchSameContent(idx, { id: doc.id, urls: [doc.url, finalUrl], text: dd.text }) : { hit: null, paraKeys: null }
            await clearParaKeys(stores.docs, doc)
            if (same.hit) {
                await stores.docs.patch(doc.id, { ...sameContentPatch(same.hit, clock.iso8()), fetchTries: doc._tries, fetcher: '', finalUrl })
                idx.add({ id: doc.id, status: 'skip', skipKind: 'duplicate', paraKeys: null })
                count(msg, 'sameContent')
                ctx.log.info(`內文[${oneline(doc.title || doc.url, 40)}] 與既有文件同一內容（${same.hit.why}），記 skip（未進 AI）`)
                return next(msg)
            }
            const paraKeys = same.paraKeys
            if (idx) idx.add({ id: doc.id, url: doc.url, finalUrl, paraKeys, status: 'raw' })
            const textFrom = doc._fetcherId === 'browser' ? `browser:${extra.method || 'unknown'}` : (extra.adapterId ? `adapter:${extra.adapterId}` : 'article')
            const patch = {
                paraKeys, // 段落雜湊(CS10 之跨文件比對;正文瘦身後仍留)
                healthV: healthVOf(doc, settings.capture.standards), // 閘之版本(CS1a 存量依版重判)
                // 抓取器明示豁免健全閘者(CS1e contract.gateExempt):存量重判記不適用;曾豁免而改由他抓取器取得者清除
                ...(doc._gateExempt || doc.gateExempt ? { gateExempt: doc._gateExempt === true } : {}),
                text: dd.text.slice(0, art.maxTextChars),
                textLength: Math.min(dd.text.length, art.maxTextChars),
                fullLength: f.text.length, // 截斷前之原長(下游處理之截斷明示讀它)
                dedupedChars: dd.removed, // 恆寫(0 亦寫;見 feed 退路處同理)
                title: doc.title || f.title,
                status: 'raw',
                fetchTries: doc._tries,
                fetcher: doc.fetcher === 'browser' ? '' : (doc.fetcher || ''),
                // 下游端回報之重抓已完成:清除排除方法(陣列以 patch 深合併,只能以 null 清)
                ...(doc.refetchSkip ? { refetchSkip: null } : {}),
                ...(doc.retryAt ? { retryAt: '' } : {}),
                // 內容來源:瀏覽器階梯記 browser:<方法>;經站台 adapter 者記 adapter:<id>(如 msn 走站方 content API);否則為網頁正文
                textFrom,
                finalUrl,
                // 進入 raw 之時刻:raw 池等待時間據此量。collectedAt 是收錄時刻——舊件補抓後 collectedAt 已數十天,
                // 用它量會把「當輪就處理」誤判為久候(下游之佇列等待時間與監控皆讀 rawAt)
                rawAt: clock.iso8(),
            }
            await stores.docs.patch(doc.id, patch)
            // 落 raw 即另存:庫內形態＋去重截斷前之取得物(f.text;保留「未處理的原文」)
            await archiveNow(ctx, msg, { ...doc, ...patch, feedText: doc.feedText }, { raw: String(f.text || ''), rawFrom: textFrom })
            count(msg, 'filled')
        }
        else {
            const cls = doc._class || { action: 'retry', cls: '' }
            const final = cls.action === 'final'
            // 網路問題不算在文件頭上:失敗可能出自本機網路(無 HTTP 回應)者,計次前強制重探;不通 → 不落帳(仍為原狀待抓)、本段停止
            if (!final && mayBeNetFailure({ reason: f?.reason, httpCode: f?.extra?.httpCode || httpCodeOf(f || {}) }) && await netDownNow(ctx)) {
                count(msg, 'netDeferred')
                ctx.log.info(`內文[${oneline(doc.title || doc.url, 40)}] 失敗（${f?.reason || '-'}）時本機網路不通，不計 tries`)
                return next(msg)
            }
            const tries = final ? Math.max(doc._tries, art.maxTries) : doc._tries
            const dead = tries >= art.maxTries
            if (dead) count(msg, final ? 'finalDead' : 'dead')
            const nowIso = clock?.iso8?.() || ''
            const httpCode = Number(f?.extra?.httpCode) || httpCodeOf(f || {})
            // 內容類判死之依據:curl 之閘判(正文仍在 _fetched.text)或瀏覽器階之終態閘(extra.evidence)
            const evidence = isobj(f?.extra?.evidence) && f.extra.evidence.text ? f.extra.evidence : (f?.gate && f?.text ? { text: f.text, title: f.title || '', method: doc._fetcherId || '', finalUrl: f.extra?.finalUrl || '' } : null)
            const contentDead = dead && CONTENT_DEAD_CLASSES.includes(cls.cls) && !!evidence
            await stores.docs.patch(doc.id, {
                fetchTries: tries,
                status: dead ? 'dead' : 'new',
                // 瀏覽器失敗件留(或進)瀏覽器佇列(下輪以前置 curl 之階梯再試;路由欄位經 browserQueueFields——同輪升級失敗者此刻才進佇列,
                //   已在佇列者保留原進佇列時刻);其餘保留原路由(含安裝方指名之 detail 抓取器)
                ...(cls.action === 'browser-failed' ? browserQueueFields(doc, cls.cls, nowIso) : { fetcher: doc.fetcher || '' }),
                lastReason: String(f?.reason || '').slice(0, 40),
                ...(f?.extra?.curlReason ? { curlReason: String(f.extra.curlReason).slice(0, 40) } : {}),
                lastError: String(f?.message || '').slice(0, 200),
                // 暫時性失敗之時間退避(retry 類;瀏覽器佇列另依名額消化)
                ...(!dead && cls.action !== 'browser-failed' ? { retryAt: backoffUntil(Date.parse(nowIso), tries, art.retryBackoffHours) } : {}),
                // 判死之一級欄位(剔除清單與存量重判據此,不靠 lastError 文字)
                ...(dead ? { deadAt: nowIso, deadClass: cls.cls || 'unknown', httpCode, deadBy: doc._fetcherId || 'article' } : {}),
                ...(contentDead && GATE_DEAD_CLASSES.includes(cls.cls) ? { healthV: healthVOf(doc, settings.capture.standards) } : {}),
            })
            // 內容類判死:另存判定依據(閘改版後可依版重判;docMaintain)
            if (contentDead) {
                const dd = dedupeText(String(evidence.text))
                await archiveNow(ctx, msg, { id: doc.id, text: dd.text.slice(0, art.maxTextChars), feedText: doc.feedText || '', status: 'dead', textFrom: evidence.method || '', fullLength: String(evidence.text).length, title: doc.title || evidence.title || '', url: doc.url }, { raw: String(evidence.text), rawFrom: evidence.method || '' })
            }
        }
        return next(msg)
    },
})

/**
 * 逐篇補全文子階段工廠:逐 doc 一條 msg 依序流過 titleSkip → routeFetcher → fetchDetail → contentGate → browserRetry → transcodeLinks → feedFallback → persistOutcome 八環(可 tap／chain 掛載)
 *
 * run(ctx) 先確認本機網路，再分補全文佇列(status new 且非指名瀏覽器)與瀏覽器佇列(doc.fetcher 為 browser)兩段依時間預算逐篇跑鏈，
 * 回傳統一 report(detail 含 filled、aggregated、titleSkipped、dead、finalDead、duplicate、sameContent、left、queued、browser* 等計數)。
 *
 * @param {Object} [opt={}] 輸入子階段設定,非物件則回退為 {};可含 chain, tap, patterns, toLinkedRecord, linksPerDoc, articlesPerRun(每輪補全文篇數,預設 capture.articles.perRun), runCli,
 *   pick(本輪取件 (candidates, { ctx, quota, queues }) => 文件陣列:候選為補全文佇列依現行排序之全部,回傳者截至 quota、須為候選之成員——零件庫用法之
 *   「選完才抓」,如宿主以標題 AI 選文),timeoutMsOf(逐篇逾時,見 mwFetchDetail);階段契約欄位 enabled／when 等(core/kernel stageFields)
 * @returns {Object} 回傳階段物件 { name:'detailFetch', run(ctx) }
 * @throws {Error} run 時 opt.pick 回傳非陣列(須回傳候選之子集陣列)時拋出
 * @example
 * // W 為 w-data-pipeline 之預設匯出(import W from 'w-data-pipeline/src/WDataPipeline.mjs')
 * let rows = [{ id: 'd1', status: 'new', kind: 'web', title: '黑洞光譜', url: 'https://example.com/post/1', fetchTries: 0 }]
 * let docs = {
 *     select: async (f) => rows.filter((r) => !f || Object.entries(f).every(([k, v]) => r[k] === v)),
 *     get: async (id) => rows.find((r) => r.id === id) || null,
 *     patch: async (id, p) => Object.assign(rows.find((r) => r.id === id), p),
 * }
 * let text = '黑洞光譜的觀測記錄包含吸積盤與噴流的詳細描述，並比較不同波段的觀測結果，再說明各種輻射機制如何影響光譜的形狀與強度分布。'.repeat(5)
 * let fetcher = W.defineFetcher({ id: 'article', role: 'detail', kinds: ['web'], fetch: async () => ({ ok: true, text, title: '黑洞光譜' }) })
 * let ctx = {
 *     deps: {
 *         stores: { docs },
 *         registry: { resolve: () => fetcher },
 *         settings: resolveSettings({ capture: { standards: { sameContent: false } } }),
 *         clock: { iso8: () => '2026-09-01T00:00:00+08:00' },
 *     },
 *     log: { info() {}, warn() {} },
 * }
 * let stage = stageDetailFetch()
 * let r = await stage.run(ctx)
 * console.log(stage.name, r.ok, r.detail.filled, rows[0].status, rows[0].textFrom)
 * // => detailFetch true 1 raw article
 */
export function stageDetailFetch(opt = {}) {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    const chain = opt.chain || applyTaps(
        [mwTitleSkip(opt), mwRouteFetcher(opt), mwFetchDetail(opt), mwContentGate(opt), mwBrowserRetry(opt), mwTranscodeLinks(opt), mwFeedFallback(opt), mwPersistOutcome(opt)],
        opt.tap, { chainName: 'capture.detailFetch' },
    )
    return {
        ...stageFields(opt, { name: 'detailFetch' }),
        run: async (ctx) => {
            const { stores, settings } = ctx.deps
            const cap = settings.capture
            const budget = budgetOf(ctx)
            // 本機網路不通:本段略過(不發請求、不計任何文件之失敗;core/util/netGuard)。detail 須帶齊抓取物件固定格式摘要所讀之計數
            //   (素材／轉錄／放棄、瀏覽器試成延後;缺 aggregated 會使該摘要印出「轉錄 undefined」);
            //   佇列量(queued 等)不給:讀取端讀不到即不納入佇列消化之判定
            if (await netDownAtStart(ctx, '補全文')) return stdReport({ detail: { netDown: true, filled: 0, aggregated: 0, dead: 0, finalDead: 0, browserTried: 0, browserOk: 0, browserDeferred: 0 } })
            const queue = await stores.docs.select({ status: 'new' })
            const browserOn = browserQueueOn(cap)
            const nowParsed = Date.parse(ctx.deps.clock?.iso8?.() || '')
            const nowMs = Number.isFinite(nowParsed) ? nowParsed : Date.now()
            // 佇列之分法與計數取 core/stores/docPolicy 之 docQueuesOf／docQueueStatsOf(剔除清單與外部巡檢同一份):補全文佇列(退避中者本輪不取——
            //   retryAt 到期即回佇列,不丟)與瀏覽器佇列;瀏覽器分流停用時指名瀏覽器之件併回補全文佇列,並於此改走 curl
            const q = docQueuesOf(queue, { nowMs, browserOn })
            const viaArticle = (d) => (d.fetcher === 'browser' ? { ...d, fetcher: '' } : d)
            const mainQ = browserOn ? q.ready : q.ready.map(viaArticle)
            const browserQ = q.browser
            const quota = opt.articlesPerRun ?? cap.articles.perRun
            // 選取順序(core/stores/docPolicy byRetryTierFifo,下游各處理段共用同一份):tries＋鏈異常次數升冪(失敗件排隊末)→ tier → collectedAt(FIFO)。
            // 記錄一律保留,試滿 capture.articles.maxTries 才標 dead(終態,移出待抓清單);鏈異常另計 fetchChainFails(不入判死次數)
            const order = byRetryTierFifo('fetchTries', { plus: 'fetchChainFails' })
            const ordered = mainQ.sort(order)
            let pending = ordered.slice(0, quota)
            // 自訂取件(opt.pick):宿主決定本輪抓哪些(回傳截至 quota、只認候選之成員;非陣列即呼叫端錯誤)
            if (typeof opt.pick === 'function') {
                const picked = await opt.pick(ordered, { ctx, quota, queues: q })
                if (!Array.isArray(picked)) throw new Error('detailFetch 之 opt.pick 須回傳文件陣列（候選之子集）')
                const byIdQ = new Map(ordered.map((d) => [d.id, d]))
                pending = [...new Set(picked.map((d) => byIdQ.get(d?.id)).filter(Boolean))].slice(0, quota)
                ctx.log.info(`補全文：自訂取件 ${pending.length} 篇（候選 ${ordered.length}、配額 ${quota}）`)
            }
            // 積壓可見性:佇列長度、未試/重試/退避組成與最舊者天數每輪進日誌(外部監控據此告警排隊過長;沒有時間型丟棄,只告警不丟)
            const qs = docQueueStatsOf(queue, { nowMs, browserOn })
            const age = qs.main
            const bAge = qs.browser
            const backoff = qs.backoff.count
            ctx.log.info(`待抓內文 ${age.count} 篇（未試 ${qs.untried.count}、重試 ${qs.retry.count}、退避中 ${backoff}、最舊 ${age.oldestDays} 天），本輪取 ${pending.length}；瀏覽器佇列 ${bAge.count} 篇（最舊 ${bAge.oldestDays ?? '-'} 天）`)
            // 本輪共用之健全閘與瀏覽器狀態(配額／軟性時間上限／方法斷路;見 fetchers/browserFetcher)
            const gate = createContentGate(cap.standards)
            const round = browserOn ? createBrowserRound(cap, { remainingMs: budget.remainingMs }) : null
            // 閘之版本(CS1a):落 raw 時記 healthV;每輪算一次
            const shared = { _gate: gate, _browserRound: round, _healthV: gateVersionOf(cap.standards) }
            // 容量自洽警告(resolveSettings.warnings)由總組裝於每輪開頭記入,不在此重複記
            // 時間預算守門:逾整輪軟性截止即不再取件(未抓者仍為 new,下輪 FIFO 接手);本機網路轉不通(落帳前確認)亦停
            const netDown = () => ctx.deps.netGuard?.isDown?.() === true
            // 例外仍落帳:逐篇鏈拋錯(無可用抓取器、落庫失敗、插件拋錯)記 fetchChainFails(排序與 tries 加計,排隊尾、不擋隊頭)、每次 WARN,
            //   **不入判死次數、永不標 dead**——它是程式或環境問題,修好即可重抓;若記入 fetchTries,異常 k 次之件其後只剩 capture.articles.maxTries−k 次真抓取
            const onFail = async (m, e) => {
                const n = (m.data.fetchChainFails || 0) + 1
                await stores.docs.patch(m.data.id, { fetchChainFails: n, lastError: `逐篇鏈異常：${oneline(e?.message, 180)}` })
                ctx.log.warn(`內文[${oneline(m.data.title || m.data.url, 40)}] 逐篇鏈異常（第 ${n} 次；程式或環境問題，不計 tries、不標 dead，修復後重抓）：${oneline(e?.message, 160)}`)
            }
            // _index／_left:本篇序與其後篇數(逐篇逾時 timeoutMsOf 之依據;取件時之序)
            const msgs = pending.map((d, i) => makeMsg('doc', { ...d, ...shared, _index: i, _left: pending.length - i - 1 }, { stage: 'detailFetch' }))
            const r = await runChainOverMsgs({ chain, ctx, msgs, chainName: 'capture.detailFetch', shouldStop: () => budget.shouldStop() || netDown(), onFail })

            // 瀏覽器佇列:以補全文用剩之配額消化;配額、軟性時間、方法全斷或整輪截止即停(未取件者原狀留下輪,不落帳)
            let rb = { stats: {}, fails: 0, left: 0, errors: [] }
            let browserPicked = 0
            const allBroken = () => round && ['playwright', 'camofox'].filter((mth) => mth !== 'camofox' || cap.browser.camofox.enabled).every((mth) => round.broken.has(mth))
            if (round && browserQ.length && round.remainingQuota() > 0 && !round.timeUp() && !allBroken() && !netDown()) {
                const picks = browserQ.sort(order).slice(0, round.remainingQuota())
                browserPicked = picks.length
                // 逐篇開工守門:整輪剩餘須 ≥ 最長跨輪階梯之子行程硬逾時＋60 秒(進行中之一篇不可被整輪截止腰斬於子行程外)
                const worstMs = ladderTimeoutMs(['curl', 'camofox', 'playwright'], cap) + 60_000
                const bmsgs = picks.map((d) => makeMsg('doc', { ...d, ...shared }, { stage: 'detailFetch' }))
                rb = await runChainOverMsgs({
                    chain,
                    ctx,
                    msgs: bmsgs,
                    chainName: 'capture.detailFetch',
                    shouldStop: () => budget.shouldStop() || round.timeUp() || round.remainingQuota() === 0 || allBroken() || budget.remainingMs() < worstMs || netDown(),
                    onFail,
                })
            }
            for (const e of [...r.errors, ...rb.errors]) ctx.log.warn(`detailFetch 逐篇異常：${e}`)
            if (r.left > 0) ctx.log.warn(`補全文：逾時間預算，${r.left} 篇未取件留下輪`)
            const sum = (k) => (r.stats[k] || 0) + (rb.stats[k] || 0)
            const bs = round?.stats || { tried: 0, ok: 0, envFail: 0, final: 0, pageFail: 0 }
            const gateCounts = {}
            for (const k of Object.keys({ ...r.stats, ...rb.stats })) if (k.startsWith('gate_')) gateCounts[k.slice(5)] = sum(k)
            // 轉錄連結之濾除逐因計數(靜默剔除改計數)
            const linkFiltered = {}
            for (const k of Object.keys({ ...r.stats, ...rb.stats })) if (k.startsWith('linkFiltered_')) linkFiltered[k.slice(13)] = sum(k)
            if (round && bs.tried > 0) ctx.log.info(`瀏覽器：試 ${bs.tried}、成 ${bs.ok}、頁面失敗 ${bs.pageFail}、終態 ${bs.final}、環境失敗 ${bs.envFail}${round.broken.size ? `（斷路：${[...round.broken].join('、')}）` : ''}；延後 ${sum('browserDeferred')}`)
            if (sum('netDeferred') > 0) ctx.log.warn(`補全文：本機網路不通（${ctx.deps.netGuard?.describe?.() || '-'}），${sum('netDeferred')} 篇之失敗不計 tries，本段提前停止`)
            const dead = sum('dead') + sum('finalDead')
            return stdReport({
                stats: { in: pending.length - r.left + browserPicked - rb.left, out: sum('filled'), fail: r.fails + rb.fails + dead },
                detail: {
                    filled: sum('filled'),
                    aggregated: sum('aggregated'),
                    titleSkipped: sum('titleSkipped'),
                    dead,
                    finalDead: sum('finalDead'),
                    duplicate: sum('duplicate'),
                    sameContent: sum('sameContent'), // 檢定標準 CS10:與既有文件同一內容而記 skip(轉錄入庫、轉址代稱、段落重疊——正文與 feed 退路)
                    linkFiltered, // 轉錄連結濾除之逐因計數(無效網址、非 http、同站、分享按鈕、學術索引／平台工具、連結文字過短、逾每篇上限)
                    left: r.left,
                    queued: age.count,
                    queuedBackoff: backoff, // 暫時性失敗之退避中(retryAt 未到;不取、不丟)
                    queuedOldestDays: age.oldestDays,
                    netDeferred: sum('netDeferred'), // 失敗時本機網路不通而不計 tries 者
                    archivedNow: sum('archivedNow'), // 落 raw／內容類判死當下另存原文者
                    archiveFailed: sum('archiveFailed'),
                    browserQueued: bAge.count,
                    browserQueuedOldestDays: bAge.oldestDays,
                    browserTried: bs.tried,
                    browserOk: bs.ok,
                    browserDeferred: sum('browserDeferred'),
                    browserEnvFail: bs.envFail,
                    browserBroken: round ? [...round.broken] : [],
                    gate: gateCounts,
                },
            })
        },
    }
}

export default stageDetailFetch
