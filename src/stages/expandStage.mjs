// expandStage.mjs — 抓取物件子階段 a5:線索探測(自我擴充:待探索線索 → 新來源/新文件)
//
// hook 錨點:capture.expand.probe(first)/capture.expand.settleClue
// probe 是 first 錨點:內建 site-feed 與 search-endpoints 兩顆候選,安裝方要加
// 新探測端點(如 Google Scholar)= tap add 一顆候選,不動套件。
//
// 【內建探測政策】site 走 feed 探測;keyword/topic 打 Bing News＋arXiv、
//   CJK 線索跳過 arXiv(全站英文,中文查詢必逾時白耗);探測實際新入庫 ≥3 篇才登錄常設來源
//   (線索產生速度遠高於輪抓量,無條件登錄會讓來源表被空查詢塞滿)。
// 【不是線索的問題就不算在線索頭上】線索依 hits 挑選、兩次失敗即 failed:
//   ①本機網路不通(core/util/netGuard 確認)→ 不計、本段停止;②關鍵詞之探測端點全數失敗而網路通 → 端點故障:不加 tries、退避(retryAt),
//   同輪連 2 篇即本輪停探關鍵詞(其餘原狀留下輪);③逐線索鏈異常 → chainFails、退避,不加 tries(與線索本身之失敗分帳);
//   ④線索本身之失敗(站台無 feed、首頁抓不到)照計 tries 並退避(retryAt;6 時、24 時),達上限 failed;
//   ⑤failed 依來源之冷卻參數重探(reprobeFailedClues),不永久封存。
// 【時間:扣保留給後段之時間(core/util/stageReserve)】opt.reserveMs 明給者優先、未給取每輪依賴 ctx.deps.reserveMs、皆未給為 0(由組裝者注入,本段不讀他工作
//   之設定)。保留 > 0 時每筆線索開工前須「整輪剩餘 − 保留 ≥ 本輪各線索之探測最壞耗時之最大者(keyword／topic＝兩個探測端點各一次請求;site＝首頁一次＋至多 8 個候選
//   feed 網址各一次;每次請求＝快速失敗之單次逾時 × 嘗試次數 ＋ 重試退避)」,不足即少探,未取件之線索仍為 pending、不記次、不退避
//   (detail.reserveDeferred 記筆數)。保留為 0 時只守整輪逾期(行為不變)。時間不足是少做,不是縮容量(perRun 不變)。

import isobj from 'wsemi/src/isobj.mjs'
import fetchRSS from 'w-dwdata-hub/src/fetchRSS.mjs'
import { defineMw, defineFirstMw, applyTaps, makeMsg, count, runChainOverMsgs, stdReport, stageFields } from '../core/kernel.mjs'
import { oneline } from '../core/runnerPackage.mjs'
import { stageReserveFnOf, stageReserveGateOf, stageStepMsOf, reserveNoteOf } from '../core/util/stageReserve.mjs'
import { pickClues, settleClue, deferClue, reprobeFailedClues, enforceFrontierCap } from '../core/stores/frontierPolicy.mjs'
import { netDownAtStart, netDownNow } from '../core/util/netGuard.mjs'
import { ingestFeedItems } from '../stores/ingestGate.mjs'
import { discoverFeed, FEED_PROBE_TIMEOUT_MS, FEED_PROBE_MAX_RETRIES, FEED_PROBE_MAX_CANDIDATES } from '../fetchers/articleParse.mjs'
import { bingNewsSearchUrl, arxivSearchUrl } from '../fetchers/endpoints.mjs'
import { sourceId, autoSourceOrigin } from '../core/util/records.mjs'
import { normalizeUrl } from '../core/util/web.mjs'

/** 一次探測請求之最壞耗時(毫秒):快速失敗之單次逾時 × 嘗試次數(含初始共 maxRetries＋1 次),加重試之間之線性退避(w-fetch-web 之 curl 抓取:第 k 次重試前等 3k 秒) */
const PROBE_REQUEST_MS = (FEED_PROBE_MAX_RETRIES + 1) * FEED_PROBE_TIMEOUT_MS + 3_000 * (FEED_PROBE_MAX_RETRIES * (FEED_PROBE_MAX_RETRIES + 1) / 2)

/**
 * 一條線索之探測最壞耗時(開工門檻之估計):site 線索＝首頁一次＋至多 FEED_PROBE_MAX_CANDIDATES 個候選 feed 網址各一次(discoverFeed,逐次循序);
 *   其餘(keyword／topic 與 tap 加入之自訂探測)＝至多兩個探測端點(Bing News＋arXiv)各一次。皆以 PROBE_REQUEST_MS 計
 *
 * @param {Object} clue 輸入線索記錄(取 type)
 * @returns {Number} 回傳毫秒數
 */
const clueStepMs = (clue) => (clue?.type === 'site' ? (1 + FEED_PROBE_MAX_CANDIDATES) * PROBE_REQUEST_MS : 2 * PROBE_REQUEST_MS)

/**
 * 探測衍生來源的記錄組裝(tier 3:優先權低於人工驗證過的種子)
 *
 * @param {Object} p 輸入候選來源欄位，含 name、url，可含 lang
 * @param {Object} clue 輸入待探索線索，含 type、value，可含 why
 * @param {String} nowIso 輸入現在時刻 ISO 字串
 * @returns {Object} 回傳來源記錄物件(未落地)
 */
function newSource(p, clue, nowIso) {
    return {
        id: sourceId('rss', normalizeUrl(p.url)),
        kind: 'rss',
        tier: 3,
        name: p.name,
        url: normalizeUrl(p.url),
        lang: p.lang || '',
        origin: autoSourceOrigin(clue.type, clue.value), // 格式之唯一寫法(core/util/records;讀取端 sourceOriginOf)
        note: oneline(clue.why, 120),
        enabled: true,
        addedAt: nowIso,
        lastFetchAt: '',
        okCount: 0,
        failCount: 0,
    }
}

/**
 * 內建候選①:site 線索 → 實際探測 RSS/Atom feed,抓得到才登錄
 *
 * first 錨點候選(probe):非 site 線索或 clue 非物件回 null(語意:不處理,交下一候選)
 *
 * @param {Object} clue 輸入線索記錄，需含 type、value；非物件回 null
 * @param {Object} ctx 輸入鏈上下文，取 ctx.deps.{stores,clock}
 * @returns {Promise} 回傳 Promise，resolve 回傳 null(非 site 線索)，或 { ok, resolved, newSources } ／ { ok:false, error, mayNet }(mayNet＝首頁抓取失敗，可能出自本機網路)
 * @example
 * // site 線索會實際連線探測站台首頁；此處以非 site 線索示範「不處理，回 null 交下一候選」(不連網)
 * console.log(await probeSiteFeed({ type: 'keyword', value: '黑洞光譜' }, {}))
 * // => null
 */
export async function probeSiteFeed(clue, ctx) {

    //check
    if (!isobj(clue)) {
        return null
    }
    if (clue.type !== 'site') return null

    const { stores, clock } = ctx.deps
    const d = await discoverFeed(clue.value)
    // 首頁抓取失敗可能出自本機網路(結算時確認);「未找到可用 feed」是對站台之判定
    if (!d.ok) return { ok: false, error: d.message, mayNet: /^首頁抓取失敗/.test(String(d.message || '')) }
    const r = await stores.sources.insertNew([newSource({ name: oneline(d.siteTitle || clue.value, 60), url: d.feedUrl }, clue, clock.iso8())])
    return { ok: true, resolved: d.feedUrl, newSources: r.addCount }
}

/**
 * 內建候選②:keyword/topic → Bing News＋arXiv 一次性探測(文件入庫;≥3 筆才登錄來源)。
 *
 * 入庫走與輪抓同一閘門(stores/ingestGate:契約檢查→業務過濾→去重占位),使安裝方之 filter/toRecord
 * 對探測文件同樣有效、契約層與去重層的 invalid 亦留痕。
 * first 錨點候選(probe):非 keyword/topic 線索或 clue 非物件回 null(語意:不處理,交下一候選)。
 *
 * @param {Object} clue 輸入線索記錄，需含 type、value；非物件回 null
 * @param {Object} ctx 輸入鏈上下文，取 ctx.deps.{stores,clock,settings}
 * @param {Object} [opt={}] 輸入設定物件，非物件則視為{}
 * @param {Array} [opt.arxivCategories] 輸入 arXiv 類別過濾字串陣列，優先於 settings.capture.expand.arxivCategories，皆無即不限
 * @param {Object} [opt.ingest] 輸入探測入庫閘門之覆寫(預設由 createCaptureObject 自 listFetch 之 opts 帶入)，含 filter、toRecord、itemsPerSource
 * @returns {Promise} 回傳 Promise，resolve 回傳 null(非 keyword/topic 線索)，或 { ok, resolved, yieldDocs, newSources, invalid, filtered, sameContent, partialErrors? }
 *   (invalid／filtered／sameContent＝契約不符、業務過濾、與既有文件同一內容〔CS10〕之筆數,計入 report detail)／ { ok:false, error }
 *   (端點全數失敗另帶 endpointFail:true;本輪關鍵詞端點已判故障者回 { ok:false, skipped:true, error })
 * @example
 * // keyword／topic 線索會實際連線 Bing News 與 arXiv；此處示範不連網的兩種回傳
 * let ctx = { deps: {} }
 * console.log(await probeSearchEndpoints({ type: 'site', value: 'example.com' }, ctx))
 * // => null
 *
 * // 本輪關鍵詞探測端點已判故障(clue._probeRound.keywordBroken):略過，原狀留下輪
 * let clue = { type: 'keyword', value: '黑洞光譜', _probeRound: { keywordBroken: true } }
 * console.log(await probeSearchEndpoints(clue, ctx))
 * // => { ok: false, skipped: true, error: '本輪關鍵詞探測端點故障，略過' }
 */
export async function probeSearchEndpoints(clue, ctx, opt = {}) {

    //check
    if (!isobj(clue)) {
        return null
    }
    if (!isobj(opt)) {
        opt = {}
    }
    if (clue.type !== 'keyword' && clue.type !== 'topic') return null

    const { stores, clock, settings } = ctx.deps
    // 本輪已判定探測端點故障(同輪連 2 篇關鍵詞之端點全敗而網路通)→ 略過,原狀留下輪(不計、不退避)
    if (clue._probeRound?.keywordBroken) return { ok: false, skipped: true, error: '本輪關鍵詞探測端點故障，略過' }
    const kw = clue.value
    const isCJK = /[一-鿿぀-ヿ가-힯]/.test(kw)
    // arXiv 類別過濾:opt.arxivCategories 優先,其次 settings.capture.expand.arxivCategories;皆無即不限(通用套件預設)
    const arxivCategories = Array.isArray(opt.arxivCategories) ? opt.arxivCategories : (settings?.capture?.expand?.arxivCategories || [])
    // 端點基底可注入(settings.capture.services.bingNews.base／arxiv.base;測試可指向本機假站台離線測)
    const probes = [
        { name: `Bing News：${kw}`, url: bingNewsSearchUrl(kw, settings?.capture?.services?.bingNews?.base), lang: '' },
        ...(isCJK ? [] : [{ name: `arXiv 查詢：${kw}`, url: arxivSearchUrl(kw, { categories: arxivCategories, base: settings?.capture?.services?.arxiv?.base }), lang: 'en' }]),
    ]
    let docsAdded = 0
    let registered = 0
    let invalid = 0
    let filtered = 0
    let sameContent = 0
    const errors = []
    for (const p of probes) {
        const src = newSource(p, clue, clock.iso8())
        let items = []
        try {
            // 探測用快速失敗設定:一次性試抓,用預設重試預算會讓一輪探測吃掉近兩小時
            items = await fetchRSS(src.url, { method: 'curl', withContent: true, maxRetries: FEED_PROBE_MAX_RETRIES, timeout: FEED_PROBE_TIMEOUT_MS, useShowLog: false })
        }
        catch (e) {
            // 端點失敗須留痕:網路失敗不可與「查無內容」混為一談(否則線索被標 done 而零產出之 done 失真);
            // 全數端點失敗即回 ok:false 留 pending 重試
            errors.push(`${p.name}：${oneline(e?.message, 80)}`)
            continue
        }
        const ins = await ingestFeedItems(items, { source: src, fetcherId: 'probe:rss', ctx, ...(opt.ingest || {}) })
        docsAdded += ins.fresh.length
        invalid += ins.invalid.length
        filtered += ins.dropped
        sameContent += ins.sameContent || 0
        if (ins.invalid.length) ctx.log.info(`探測[${p.name}] 有 ${ins.invalid.length} 項不符格式而略過：${oneline(ins.invalid.map((x) => x.reason).join('；'), 160)}`)
        if (ins.dropped > 0) ctx.log.info(`探測[${p.name}] 業務過濾剔除 ${ins.dropped} 項`)
        // 登錄門檻以「本次實際新入庫篇數」計(不以入庫閘前之原始項數判):全數重複、格式不合或被過濾者不該登錄成常設來源
        if (ins.fresh.length >= 3) {
            const r = await stores.sources.insertNew([{ ...src, lastFetchAt: clock.iso8(), okCount: 1 }])
            registered += r.addCount
        }
    }
    // 端點全數失敗:不是線索之問題(查無結果是 ok 而 0 筆)——結算時先確認本機網路,通則記為端點故障(不計 tries)
    if (errors.length === probes.length) return { ok: false, endpointFail: true, error: `探測端點皆失敗：${errors.join('；')}` }
    return { ok: true, resolved: `search:${kw}`, yieldDocs: docsAdded, newSources: registered, invalid, filtered, sameContent, ...(errors.length ? { partialErrors: errors } : {}) }
}

/**
 * 錨點:probe(first 錨點:第一個能處理該線索型別的探測器勝出;安裝方 tap add 追加探測器)
 *
 * 讀 msg.data(線索:type、value);寫 msg.data._outcome(探測結果)與 msg.data._probeBy(勝出候選名);不短路(恆呼叫 next)
 *
 * @param {Object} [opt={}] 輸入設定物件，非物件則視為{}，原樣傳入 probeSearchEndpoints
 * @returns {Object} 回傳 defineFirstMw 產物
 * @example
 * let mw = mwProbe()
 * console.log(mw.name, mw.mode, mw.candidates.map((c) => c.name))
 * // => probe first [ 'site-feed', 'search-endpoints' ]
 *
 * // 無候選能處理的線索型別:不連網，_outcome 記失敗、_probeBy 為空字串
 * let { msg } = await composeChain([mw])(makeMsg('clue', { type: 'other', value: 'x' }), {})
 * console.log(msg.data._outcome, JSON.stringify(msg.data._probeBy))
 * // => { ok: false, error: '無探測器可處理線索型別「other」' } ""
 */
export const mwProbe = (opt = {}) => {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    return defineFirstMw({
        name: 'probe',
        candidates: [
            { name: 'site-feed', probe: (m, ctx) => probeSiteFeed(m.data, ctx) },
            { name: 'search-endpoints', probe: (m, ctx) => probeSearchEndpoints(m.data, ctx, opt) },
        ],
        apply: (msg, result, _ctx, winner) => {
            msg.data._outcome = result || { ok: false, error: `無探測器可處理線索型別「${msg.data.type}」` }
            msg.data._probeBy = winner
        },
    })
}

/**
 * 錨點:settleClue(消化結果落帳:tries/failed 狀態機;逐線索統計)
 *
 * 讀 msg.data(線索:type、value、_outcome);不寫 msg.data(落帳寫入 stores.frontier);不短路(恆呼叫 next)
 *
 * @param {Object} [opt={}] 輸入設定物件，非物件則視為{}
 * @param {Integer} [opt.maxTries=2] 輸入線索失敗達幾次即轉 failed
 * @returns {Object} 回傳 defineMw 產物
 * @example
 * let rows = [{ id: 'c1', type: 'keyword', value: '黑洞光譜', status: 'pending', tries: 0 }]
 * let frontier = { patch: async (id, p) => Object.assign(rows.find((r) => r.id === id), p) }
 * let ctx = { deps: { stores: { frontier }, settings: { capture: {} }, clock: { iso8: () => '2026-09-01T00:00:00+08:00' } }, log: { info() {}, warn() {} } }
 * let outcome = { ok: true, resolved: 'search:黑洞光譜', yieldDocs: 4, newSources: 1 }
 * let { msg } = await composeChain([mwSettleClue()])(makeMsg('clue', { ...rows[0], _outcome: outcome }), ctx)
 * console.log(msg.stats.newSources, msg.stats.docsAdded, rows[0].status, rows[0].resolved)
 * // => 1 4 done search:黑洞光譜
 */
export const mwSettleClue = (opt = {}) => {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    return defineMw({
        name: 'settleClue',
        handle: async (msg, ctx, next) => {
            const { stores, clock, settings } = ctx.deps
            const clue = msg.data
            const outcome = clue._outcome
            const nowIso = clock.iso8()
            const backoffHours = settings?.capture?.articles?.retryBackoffHours ?? 6
            // 本輪端點已斷:原狀留下輪
            if (outcome.skipped) {
                count(msg, 'clueSkipped')
                return next(msg)
            }
            // 失敗可能出自本機網路或端點:先確認網路;不通 → 不計(本段停止)
            if (!outcome.ok && (outcome.endpointFail || outcome.mayNet) && await netDownNow(ctx)) {
                count(msg, 'netDeferred')
                ctx.log.info(`擴充：${clue.type}[${clue.value}] 失敗時本機網路不通，不計失敗`)
                return next(msg)
            }
            // 網路通而端點全數失敗:端點故障,不是線索之問題——不加 tries、退避;同輪連 2 篇即本輪停探關鍵詞
            if (!outcome.ok && outcome.endpointFail) {
                const d = await deferClue(stores.frontier, clue, { nowIso, kind: 'endpoint', error: outcome.error, backoffHours })
                const round = clue._probeRound
                if (round) {
                    round.endpointFails++
                    if (round.endpointFails >= 2) round.keywordBroken = true
                }
                count(msg, 'endpointDeferred')
                ctx.log.warn(`擴充：${clue.type}[${clue.value}] 探測端點皆失敗（${String(outcome.error || '').slice(0, 100)}），端點故障不計線索失敗，退避至 ${d.retryAt || '-'}${round?.keywordBroken ? '；本輪停探關鍵詞' : ''}`)
                return next(msg)
            }
            const settled = await settleClue(stores.frontier, clue, outcome, { nowIso, maxTries: opt.maxTries ?? 2, backoffHours })
            if (outcome.ok) {
                count(msg, 'newSources', outcome.newSources || 0)
                count(msg, 'docsAdded', outcome.yieldDocs || 0)
                // 探測入庫之剔除計數(皆入 report detail):契約不符、業務過濾、與既有文件同一內容(CS10)
                count(msg, 'itemsInvalid', outcome.invalid || 0)
                count(msg, 'itemsFiltered', outcome.filtered || 0)
                count(msg, 'sameContent', outcome.sameContent || 0)
                ctx.log.info(`擴充：${clue.type}[${clue.value}] → 來源 ${outcome.newSources || 0} 個、文件 ${outcome.yieldDocs || 0} 篇`)
            }
            else {
                if (settled.status === 'failed') count(msg, 'clueFailed')
                ctx.log.warn(`擴充：${clue.type}[${clue.value}] 失敗（${String(outcome.error || '').slice(0, 100)}）→ ${settled.status}`)
            }
            return next(msg)
        },
    })
}

/**
 * 擴充子階段:自我擴充(待探索線索 → 新來源/新文件)。hook 錨點:capture.expand.{probe(first), settleClue}
 *
 * @param {Object} [opt={}] 輸入設定物件，非物件則視為{}
 * @param {Array} [opt.chain] 輸入自組動作鏈(defineMw 產物陣列)，未給則以 tap 組裝預設鏈
 * @param {Object} [opt.tap] 輸入認名掛載規格(applyTaps 之 taps)，於預設鏈上 before/after/replace/add
 * @param {Integer} [opt.perRun] 輸入本輪取用線索筆數上限，未給則用 settings.capture.expand.perRun
 * @param {Integer} [opt.maxPending] 輸入待探索線索上限，未給則用 settings.capture.expand.maxPending
 * @param {Integer} [opt.maxTries=2] 輸入線索失敗達幾次即轉 failed
 * @param {Object} [opt.ingest] 輸入探測入庫閘門之 opts(filter、toRecord、itemsPerSource)，預設同 listFetch
 * @param {Number|Function} [opt.reserveMs] 輸入保留給後段之毫秒數(非負)，或 (ctx) => 毫秒數(每輪求值):> 0 時每筆線索開工前須「整輪剩餘 − 保留 ≥ 本輪各線索之探測最壞耗時
 *   之最大者(keyword／topic 54 秒、site 約 4 分)」才開工,不足即少探、未取件之線索仍為 pending(detail.reserveDeferred 記筆數);由組裝者注入(如後段工作之最低時間),本段不讀他工作之設定。
 *   未給(或 null)則取每輪依賴之 ctx.deps.reserveMs,皆未給為 0(只守整輪逾期,行為不變);明給 0 優先於依賴
 * @returns {Object} 回傳 stage 物件 { name, run }
 * @throws {MwContractError} opt.tap 指向不存在之錨點(可用 probe、settleClue)，或掛載規格不合法時拋出
 * @throws {Error} opt.reserveMs 非非負毫秒數亦非函數時建構即拋出(deps.reserveMs 不合、函數回傳不合者於該輪開工時拋出)
 * @example
 * // 以 tap 置換 probe 錨點為替身探測器(不連網);settleClue 照常落帳
 * let fakeProbe = defineMw({
 *     name: 'fakeProbe',
 *     handle: async (msg, ctx, next) => {
 *         msg.data._outcome = { ok: true, resolved: 'search:x', yieldDocs: 2, newSources: 0 }
 *         return next(msg)
 *     },
 * })
 * let rows = [{ id: 'c1', type: 'keyword', value: '黑洞光譜', status: 'pending', tries: 0, hits: 1 }]
 * let frontier = {
 *     select: async (f) => rows.filter((r) => !f || Object.entries(f).every(([k, v]) => r[k] === v)),
 *     patch: async (id, p) => Object.assign(rows.find((r) => r.id === id), p),
 * }
 * let ctx = { deps: { stores: { frontier }, settings: resolveSettings({}), clock: { iso8: () => '2026-09-01T00:00:00+08:00' } }, log: { info() {}, warn() {} } }
 * let stage = stageExpand({ tap: { probe: { replace: fakeProbe } } })
 * let r = await stage.run(ctx)
 * console.log(stage.name, r.ok, r.detail.picked, r.detail.docsAdded, rows[0].status)
 * // => expand true 1 2 done
 */
export function stageExpand(opt = {}) {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    // 保留時間:opt 明給者優先(建構即檢核);未給者每輪取 ctx.deps.reserveMs(組裝者之依賴);取值規則各段同一份(core/util/stageReserve)
    const reserveFn = stageReserveFnOf(opt, 'stageExpand')
    const chain = opt.chain || applyTaps([mwProbe(opt), mwSettleClue(opt)], opt.tap, { chainName: 'capture.expand' })
    return {
        ...stageFields(opt, { name: 'expand' }),
        run: async (ctx) => {
            const keepMs = reserveFn(ctx) // 本輪之保留(不合法即於此拋出,不先動任何線索)
            const { stores, settings, clock } = ctx.deps
            // 本機網路不通:本段略過(不發請求、不計任何線索之失敗;core/util/netGuard)
            if (await netDownAtStart(ctx, '擴充')) return stdReport({ detail: { netDown: true, picked: 0, newSources: 0, docsAdded: 0, failed: 0 } })
            const nowIso = clock.iso8()
            const nowMs = Date.parse(nowIso)
            // failed 線索之冷卻重探(與來源同一組冷卻參數 capture.sources.reprobeDays／reprobePerRun)
            const sp = settings.capture.sources || {}
            const rp = await reprobeFailedClues(stores.frontier, { nowMs, nowIso, reprobeDays: sp.reprobeDays, perRun: sp.reprobePerRun })
            if (rp.reprobed.length) ctx.log.info(`擴充：failed 線索冷卻期滿重探 ${rp.reprobed.length} 筆（${oneline(rp.reprobed.map((c) => `${c.type}[${c.value}]`).join('、'), 160)}）`)
            // 上限淘汰(frontierPolicy):線索產生量≫消化量,無上限即永無止境成長;淘汰者記錄保留、再被提及即復活
            const maxPending = opt.maxPending ?? settings.capture.expand.maxPending
            const cap = await enforceFrontierCap(stores.frontier, { maxPending, nowIso })
            if (cap.evicted > 0) ctx.log.warn(`擴充：待探索線索 ${cap.pending + cap.evicted} 筆超過上限 ${maxPending}，淘汰優先序最低之 ${cap.evicted} 筆（記錄保留，再被提及即復活）`)
            // 退避中(retryAt 未到)者不取
            const pending = await pickClues(stores.frontier, opt.perRun ?? settings.capture.expand.perRun, { nowMs })
            if (pending.length === 0) {
                ctx.log.info('擴充：待探索清單為空（或皆在退避中）')
                return stdReport({ detail: { picked: 0, newSources: 0, docsAdded: 0, failed: 0, evicted: cap.evicted, pending: cap.pending, reprobed: rp.reprobed.length } })
            }
            // 本輪之探測端點狀態(同輪連 2 篇關鍵詞之端點全敗 → 停探關鍵詞;各線索訊息共用同一份)
            const probeRound = { endpointFails: 0, keywordBroken: false }
            const msgs = pending.map((c) => makeMsg('clue', { ...c, _probeRound: probeRound }, { stage: 'expand' }))
            // 時間預算守門(每筆線索 2 次 HTTP,無守門時消化量一調高就吃掉後段時間);未取件之線索仍為 pending;本機網路轉不通亦停
            // 例外仍落帳:逐線索鏈拋錯(入庫失敗、安裝方 filter 回非陣列…)——記 chainFails 並退避(retryAt;線索依 hits 排序,不退避即每輪排回隊頭),
            //   **不加 tries、不轉 failed**(程式／環境問題,與線索本身之失敗分帳;否則兩次異常即 failed)
            // 扣保留(core/util/stageReserve):保留 > 0 時每筆線索開工前須「整輪剩餘 − 保留 ≥ 一條線索之探測最壞耗時」;保留為 0 時只守整輪逾期(同現版)
            const gate = stageReserveGateOf(ctx, keepMs)
            const stepMs = stageStepMsOf(...pending.map(clueStepMs))
            let reserveCut = false // 本段是否因保留而停(最後一次 shouldStop 為真之成因)
            const backoffHours = settings?.capture?.articles?.retryBackoffHours ?? 6
            const r = await runChainOverMsgs({
                chain,
                ctx,
                msgs,
                chainName: 'capture.expand',
                shouldStop: () => {
                    if (gate.expired() || ctx.deps.netGuard?.isDown?.() === true) return true
                    if (gate.cut(stepMs)) {
                        reserveCut = true
                        return true
                    }
                    return false
                },
                onFail: async (m, e) => {
                    const d = await deferClue(stores.frontier, m.data, { nowIso: clock.iso8(), kind: 'chain', error: `逐線索鏈異常：${oneline(e?.message, 120)}`, backoffHours })
                    ctx.log.warn(`擴充：${m.data.type}[${m.data.value}] 逐線索鏈異常（第 ${d.chainFails} 次；程式或環境問題，不計失敗、不轉 failed，退避至 ${d.retryAt || '-'}）：${oneline(e?.message, 120)}`)
                },
            })
            for (const e of r.errors) ctx.log.warn(`expand 逐線索異常：${e}`)
            // 因保留而延後:INFO 寫明(不是逾整輪預算,不印「逾時間預算」之 WARN);線索仍為 pending、不記次、不退避
            const reserveDeferred = reserveCut ? r.left : 0
            if (reserveDeferred > 0) ctx.log.info(`擴充：${reserveNoteOf(gate, stepMs)}，${r.left} 筆線索未取件留下輪`)
            else if (r.left > 0) ctx.log.warn(`擴充：逾時間預算，${r.left} 筆線索未取件留下輪`)
            if (r.stats.netDeferred) ctx.log.warn(`擴充：本機網路不通（${ctx.deps.netGuard?.describe?.() || '-'}），${r.stats.netDeferred} 筆線索之失敗不計，本段提前停止`)
            return stdReport({
                stats: { in: pending.length - r.left, out: r.stats.newSources || 0, fail: (r.stats.clueFailed || 0) + r.fails },
                detail: {
                    picked: pending.length - r.left,
                    newSources: r.stats.newSources || 0,
                    docsAdded: r.stats.docsAdded || 0,
                    failed: (r.stats.clueFailed || 0) + r.fails,
                    left: r.left,
                    // 因保留給後段之時間而留下輪之線索數(僅確因保留延後時才有此欄,report 欄集於平時不變)
                    ...(reserveDeferred > 0 ? { reserveDeferred } : {}),
                    evicted: cap.evicted,
                    pending: cap.pending,
                    reprobed: rp.reprobed.length, // failed 冷卻期滿重探
                    netDeferred: r.stats.netDeferred || 0, // 失敗時本機網路不通而不計者
                    endpointDeferred: r.stats.endpointDeferred || 0, // 端點故障而不計、退避者
                    skipped: r.stats.clueSkipped || 0, // 本輪端點已斷而原狀留下輪者
                    invalid: r.stats.itemsInvalid || 0,
                    filtered: r.stats.itemsFiltered || 0,
                    sameContent: r.stats.sameContent || 0,
                },
            })
        },
    }
}

export default stageExpand
