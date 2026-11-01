// healthRecheck.mjs — 檢定標準 CS1a「存量 raw 依閘版本重驗」之判定與分流(單一實作;抓取維護子階段 docMaintainStage.mwRecheckHealth 用)
//
// 【為何需要】(CS1a)健全閘改版(新類別、門檻、樣式)後,改版前落 raw 之文件未經新版判準即送摘要——
//   「新進與存量同一標準」不成立。文件落 raw 時記閘之版本 healthV(contentGate.gateVersionOf);不同於現版之 raw 以 docs 中之原文重判。
// 【依入口套用】(分入口;回溯須與即時閘同豁免):textFrom article／browser:<方法>＝完整閘(含軟 404,url＋finalUrl);
//   adapter:<id>＝adapter 豁免(只檢過短、亂碼、格式雜訊);feed＝feed 退路之閘(門檻 minFallbackChars);abstract(grid)＝grid 摘要判準
//   (contentGate.gridAbstractCheck:過短、亂碼);抓取器明示豁免(gateExempt)＝不適用;其餘(入口不明)＝未能判定。
// 【長度條件用 fullLength】庫內正文已去重、截斷,過短、佔位／付費牆之內容量閘門、逾合理上限以落庫時記之原長判;
//   feed 者為 feed 原長;grid 摘要為入庫時記之摘要原長(截 4,000 字前;未記者以摘要長度判)。
// 【不合格 → 既有分流】fetchPolicy.classifyFetch(與即時抓取同一規則):final → dead(一輪即終態);browser → 瀏覽器佇列(瀏覽器所得之正文
//   仍不合格 → 沿原類別留瀏覽器佇列;跨輪階梯前置 curl,各階之閘照樣擋下同一份壞內容);自訂抓取器 → 重試(退回補全文佇列、沿原路由);
//   feed 退路不成立 → 交回補全文佇列重抓(其後依抓取結果分流)。改分流者清 paraKeys(壞內容之段落雜湊不得留在同一內容索引)、
//   不動 fetchTries(重判不是一次新的抓取)。
// 【無原文可判】庫內正文為空或入口不明 → 未能判定:記入報告、不動該篇(不改 healthV,每輪照列直到處置)。
// 【能證明／不能證明】能證明:庫內正文(落盤之去重、截斷形態)在現版閘下之類別。不能證明:頁面自身標題之判準(頁面標題未落庫,以記錄標題代)、
//   截斷之後才出現之亂碼／標記密度與落盤前全文一致。

import isobj from 'wsemi/src/isobj.mjs'
import { STATUS } from '../core/standards/verdict.mjs'
import { createContentGate, gateVersionOf, gridAbstractCheck } from './contentGate.mjs'
import { classifyFetch, browserQueueFields } from './fetchPolicy.mjs'

/**
 * 建立重判用之閘(每輪一次):正文閘、feed 退路閘(門檻 minFallbackChars)與現版版本
 *
 * @param {Object} [standards={}] 輸入 settings.capture.standards(取 minTextChars、minFallbackChars 與其餘健全閘設定;非物件視為空)
 * @returns {Object} 回傳 { version:String, main:健全閘, feed:健全閘 }(閘具 assess 方法)
 * @throws {Error} 追加樣式形狀不合法時拋出(同 createContentGate)
 * @example
 * const gates = createHealthGates({ minTextChars: 300, minFallbackChars: 80 })
 * console.log(Object.keys(gates))
 * // => [ 'version', 'main', 'feed' ]
 * console.log(gates.main.assess({ text: '短', title: 't', url: 'https://example.com/a' }))
 * // => { ok: false, kind: 'too-short', hit: '正文 1 字，低於 300' }
 */
export function createHealthGates(standards = {}) {
    const c = isobj(standards) ? standards : {}
    return { version: gateVersionOf(c), main: createContentGate(c), feed: createContentGate({ ...c, minTextChars: c.minFallbackChars }) }
}

/**
 * 文件之入口(依落庫時之 textFrom;明示豁免者 exempt;不明者 '')
 *
 * @param {Object} doc 輸入文件記錄
 * @returns {String} 回傳 'article'|'browser'|'adapter'|'feed'|'grid'|'exempt'|''
 */
function entryOf(doc) {
    if (doc?.gateExempt === true) return 'exempt'
    const tf = String(doc?.textFrom || '')
    if (tf === 'article') return 'article'
    if (tf.startsWith('browser:')) return 'browser'
    if (tf.startsWith('adapter:') && tf.length > 8) return 'adapter'
    if (tf === 'feed') return 'feed'
    if (tf === 'abstract') return 'grid'
    return ''
}

/**
 * 一篇 raw 存量之重判與處置(純函數;寫入由呼叫端執行)
 *
 * @param {Object} doc 輸入文件記錄(取 id、text、title、url、finalUrl、textFrom、fullLength、fetcher、fetchTries、lastClass、gateExempt)
 * @param {Object} gates 輸入 createHealthGates 之產物
 * @param {Object} [opt={}] 輸入 { nowIso:String, maxFetchTries:Integer(終態時 fetchTries 補至此;預設 3;呼叫端傳 settings.capture.articles.maxTries) }
 * @returns {Object} 回傳 { status:STATUS 之一(pass／violation／undetermined／na), entry, kind?, hit?, why?,
 *   route?:{ action:'final'|'browser'|'refetch'|'retry', cls, why }(violation 才有), patch?:Object(undetermined 無——不動) }
 * @example
 * const gates = createHealthGates({ minTextChars: 300 })
 * console.log(planHealthRecheck({ id: 'd', textFrom: 'article', text: '短' }, gates).route.action)
 * // => browser
 */
export function planHealthRecheck(doc, gates, opt = {}) {
    if (!isobj(gates) || !gates.main || !gates.feed) throw new Error('planHealthRecheck 需要 gates(createHealthGates 之產物)')
    if (!isobj(opt)) opt = {}
    const entry = entryOf(doc)
    const version = gates.version
    if (entry === 'exempt') return { status: STATUS.NA, entry, why: '抓取器明示豁免健全閘（gateExempt）', patch: { healthV: version } }
    if (!entry) return { status: STATUS.UNDETERMINED, entry, why: `入口不明（textFrom「${String(doc?.textFrom || '')}」）` }
    const text = String(doc?.text || '')
    if (!text.trim()) return { status: STATUS.UNDETERMINED, entry, why: '庫內無原文' }
    const fullLength = Number(doc?.fullLength) > 0 ? Number(doc.fullLength) : undefined
    const adapterId = entry === 'adapter' ? String(doc.textFrom).slice(8) : ''
    let g
    if (entry === 'grid') g = gridAbstractCheck(text, { fullLength })
    else if (entry === 'feed') g = gates.feed.assess({ text, title: doc.title, fullLength })
    else g = gates.main.assess({ text, title: doc.title, url: doc.url, finalUrl: doc.finalUrl || '', adapterId, fullLength })
    if (g.ok) return { status: STATUS.PASS, entry, patch: { healthV: version } }

    // 不合格 → 既有分流(fetchPolicy.classifyFetch)
    let route
    if (entry === 'feed') route = { action: 'refetch', cls: '', why: 'feed 退路不成立' }
    else if (entry === 'browser') {
        const c = classifyFetch({ ok: false, reason: g.kind, fetcherId: 'browser' })
        route = c.action === 'final' ? { action: 'final', cls: c.cls, why: c.why } : { action: 'browser', cls: doc.lastClass || 'render', why: '瀏覽器所得之正文未過現版閘' }
    }
    else {
        // 安裝方指名之 detail 抓取器(doc.fetcher 非 browser)沿用其路由:分流規則對自訂抓取器為重試
        const custom = doc.fetcher && doc.fetcher !== 'browser' ? String(doc.fetcher) : ''
        const c = classifyFetch({ ok: false, reason: g.kind, adapterId, fetcherId: custom || 'article' })
        route = { action: c.action, cls: c.cls, why: c.why }
    }
    const nowIso = String(opt.nowIso || '')
    const maxTries = Number.isInteger(opt.maxFetchTries) && opt.maxFetchTries > 0 ? opt.maxFetchTries : 3
    const base = {
        lastReason: String(g.kind).slice(0, 40),
        lastError: `健全閘重判（版本 ${version}）：${String(g.hit || '')}`.slice(0, 200),
        paraKeys: null, // 壞內容之段落雜湊不得留在同一內容索引(重抓成功時落盤另寫)
        healthRecheckedAt: nowIso,
    }
    let patch
    // 終態:判死之一級欄位(deadClass／deadBy health);閘判之內容類記閘版本 healthV(閘再改版時依版重判,planDeadRecheck)——
    //   判定依據(庫內正文)由呼叫端於改狀態前另存(docMaintainStage)
    if (route.action === 'final') patch = { ...base, status: 'dead', fetchTries: Math.max(Number(doc.fetchTries) || 0, maxTries), fetcher: '', deadAt: nowIso, deadClass: route.cls || 'unknown', deadBy: 'health', httpCode: 0, ...(GATE_DEAD_CLASSES.includes(route.cls) ? { healthV: version } : {}) }
    else if (route.action === 'browser') patch = { ...base, status: 'new', ...browserQueueFields(doc, route.cls, nowIso) }
    else if (route.action === 'refetch') patch = { ...base, status: 'new', fetcher: '' }
    else patch = { ...base, status: 'new' } // retry:沿原路由(fetcher 不動)、fetchTries 不動,達上限由補全文之落庫判 dead
    return { status: STATUS.VIOLATION, entry, kind: g.kind, hit: g.hit, route, patch }
}

/** 健全閘判之內容類終態(判定依據為已取得之正文;閘改版後可依版重判) */
export const GATE_DEAD_CLASSES = ['paywall', 'not-found', 'soft-404']

/**
 * 內容類 dead 之依版重判(檢定標準 CS1a 之對稱:判準改版後之存量重判):閘判之終態(付費牆、頁面自述找不到、
 *   軟 404)記有閘版本 healthV 與另存之判定依據;現版不同時以依據重判——現版已不判違規 → 回待抓(tries＝上限−1,只給一次機會;
 *   依據是當時之頁面,不直接當素材),仍違規 → 記現版(不再每輪重判)。依據不可得 → 未能判定、不動
 *
 * @param {Object} doc 輸入 dead 文件(取 deadClass、healthV、title、url、finalUrl、fullLength、lastError)
 * @param {String|null} evidence 輸入判定依據(另存之庫內形態正文;不可得為 null)
 * @param {Object} gates 輸入 createHealthGates 之產物
 * @param {Object} [opt={}] 輸入 { nowIso, maxFetchTries(呼叫端傳 settings.capture.articles.maxTries) }
 * @returns {Object} 回傳 { status:STATUS 之一, why?, patch?(未能判定無) }
 * @example
 * const gates = createHealthGates({ minTextChars: 10 })
 * console.log(planDeadRecheck({ deadClass: 'paywall', healthV: 'old' }, '一段足夠長而不含付費字樣之正文內容。'.repeat(3), gates).status)
 * // => pass
 */
export function planDeadRecheck(doc, evidence, gates, opt = {}) {
    if (!isobj(gates) || !gates.main) throw new Error('planDeadRecheck 需要 gates(createHealthGates 之產物)')
    if (!isobj(opt)) opt = {}
    const text = String(evidence || '')
    if (!text.trim()) return { status: STATUS.UNDETERMINED, why: '判定依據不可得（無另存）' }
    const fullLength = Number(doc?.fullLength) > 0 ? Number(doc.fullLength) : undefined
    const g = gates.main.assess({ text, title: doc?.title, url: doc?.url, finalUrl: doc?.finalUrl || '', fullLength })
    const nowIso = String(opt.nowIso || '')
    if (!g.ok) return { status: STATUS.VIOLATION, why: `${g.kind}${g.hit ? `（${String(g.hit).slice(0, 60)}）` : ''}`, patch: { healthV: gates.version, healthRecheckedAt: nowIso } }
    const maxTries = Number.isInteger(opt.maxFetchTries) && opt.maxFetchTries > 0 ? opt.maxFetchTries : 3
    return {
        status: STATUS.PASS,
        why: `現版閘（${gates.version}）不再判 ${doc?.deadClass || '-'}`,
        patch: {
            status: 'new', fetchTries: Math.max(0, maxTries - 1), fetcher: '', retryAt: '',
            deadAt: '', deadClass: '', deadBy: '', httpCode: 0, healthV: null, lastReason: '', lastClass: '', curlReason: '',
            lastError: `健全閘改版（${gates.version}）後判定依據已合格，重抓（原判 ${doc?.deadClass || '-'}）`.slice(0, 200),
            revivedAt: nowIso, revivedFrom: String(doc?.lastError || '').slice(0, 120), revivedFromClass: String(doc?.deadClass || ''),
            revives: (Number(doc?.revives) || 0) + 1, healthRecheckedAt: nowIso,
        },
    }
}

export default { createHealthGates, planHealthRecheck, GATE_DEAD_CLASSES, planDeadRecheck }
