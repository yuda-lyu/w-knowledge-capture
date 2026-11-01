// docMaintainStage.mjs — 抓取物件子階段 a4:文件維護——健全閘存量重判(CS1a)→ 段落雜湊補算(CS10 存量)→ 終態瘦身
//
// hook 錨點:capture.docMaintain.{recheckHealth, fillParaKeys, slim}
//
// 【沒有佇列老化】不設「逾期」淘汰:文章價值與新舊無關,丟棄只能發生在「AI 判定非知識」(skip)或
//   「確定抓不到」(detailFetch 試滿 capture.articles.maxTries 標 dead)之後。時間到就丟是新聞爬蟲假設;
//   FIFO 下抓過而失敗者下輪必再輪到,時間型過期沒有任何正當觸發情境。
// 【健全閘存量重判(檢定標準 CS1a)】raw 存量之閘版本(healthV)不同於現版者,以 docs 中之原文依入口重判
//   (判定與分流之單一實作 stores/healthRecheck;長度條件用 fullLength):合格 → 記現版;不合格 → 既有分流(終態／瀏覽器佇列／
//   補全文佇列);無原文可判 → 未能判定,記入報告、不動。每輪至多 healthRecheckPerRun 篇有寫入(未能判定者不佔名額)、依 rawAt 先後,
//   時間預算截止即停(未判者留下輪)。
// 【段落雜湊補算(檢定標準 CS10 存量)】noted 文件無 paraKeys 者以 docs 或 docTexts 之原文補算並寫回(冪等:已有
//   paraKeys 或已記無原文者不再選);兩處皆無原文 → 記 paraKeysNoText(不再每輪重試;符合度掃描另行判為未能判定)。每輪至多
//   paraKeysPerRun 篇、依 notedAt 先後、時間預算截止即停。存量 paraKeys 以庫內(截斷後)正文算,與落盤時以截斷前全文算者在
//   前 40 段已逾 maxTextChars 之長文可能較少(contentIndex.PARA_KEYS_MAX)。人工匯入之文件無原文,不在補算範圍。
// 【原文不得在無另存時被清除】未設 docTexts(原文另存)集合時,須另存之終態(noted／skip／summarize-failed)不瘦身,
//   每輪 WARN 一次;其餘終態(dead／aggregated)照常瘦身。
// 【成本】重判與補算共用本輪一次 docs 全表讀(allDocsOf;docs 之 select 帶條件亦為全表讀);補算另每篇一次 docTexts 主鍵直讀。
// 【內容類 dead 依版重判(CS1a 之對稱)】閘判之終態(付費牆、找不到、軟 404)記有閘版本與另存之判定依據;
//   閘改版後以依據重判(stores/healthRecheck.planDeadRecheck):已不違規 → 回待抓(tries＝上限−1);仍違規 → 記現版。與 raw 重判共用每輪名額。
// 【索引同步】存量重判改狀態／清段落鍵、補算段落鍵時,同步本行程已建之同一內容索引(contentIndex.contentIndexIfBuilt)。
// 【判死前另存依據】存量重判判 dead 者,改狀態前另存庫內正文(dead 不在瘦身另存範圍——不另存則依據隨瘦身清除)。

import isobj from 'wsemi/src/isobj.mjs'
import { defineMw, applyTaps, makeMsg, count, runChainOverMsgs, stdReport, stageFields } from '../core/kernel.mjs'
import { budgetOf, oneline } from '../core/runnerPackage.mjs'
import { slimTerminalDocs, DOC_TERMINAL_STATUSES } from '../core/stores/docPolicy.mjs'
import { DOC_TEXT_STATUSES, archiveDocText, docTextOf } from '../core/stores/docTexts.mjs'
import { STATUS } from '../core/standards/verdict.mjs'
import { createHealthGates, planHealthRecheck, planDeadRecheck, GATE_DEAD_CLASSES } from '../stores/healthRecheck.mjs'
import { paraKeysOf, contentIndexIfBuilt } from '../stores/contentIndex.mjs'

/**
 * 同步本行程已建之同一內容索引(未建則略過:下次建立即讀到最新記錄)
 *
 * @param {Object} docs 輸入 docs 集合
 * @param {Object} upd 輸入 add() 之記錄(id 必要;status／paraKeys 出現才更新)
 * @returns {Promise} 回傳 Promise
 */
async function syncIndex(docs, upd) {
    const p = contentIndexIfBuilt(docs)
    if (p) (await p).add(upd)
}

/** 健全閘存量重判每輪至多寫入篇數(子階段 opt.healthRecheckPerRun 可覆寫) */
const HEALTH_RECHECK_PER_RUN = 500
/** 段落雜湊補算每輪至多篇數(子階段 opt.paraKeysPerRun 可覆寫;每篇一次 docTexts 主鍵直讀＋解壓) */
const PARA_KEYS_PER_RUN = 2000
/** 報告中列出之未能判定 id 上限 */
const LIST_MAX = 20
/** 重判分流之說明(日誌用) */
const ROUTE_LABELS = { final: '終態（dead）', browser: '瀏覽器佇列', refetch: '補全文佇列（feed 退路不成立，重抓）', retry: '補全文佇列（自訂抓取器重試）' }

/**
 * 每輪上限之讀取:非負整數才採用,否則用預設
 *
 * @param {*} v 輸入子階段 opt 之值
 * @param {Integer} def 輸入預設
 * @returns {Integer} 回傳上限
 */
const perRunOf = (v, def) => (Number.isInteger(v) && v >= 0 ? v : def)

/**
 * 本輪維護訊息共用之文件全表(docs 之 select 一律全表讀——帶條件亦同成本;兩環共用一次,各環自行依狀態篩選)。
 * 重判只改 raw 者之狀態、補算只讀 noted 者,共用不互相干擾;環被置換時另一環照樣自取
 *
 * @param {Object} msg 輸入維護訊息
 * @param {Object} docs 輸入 docs 集合
 * @returns {Promise} 回傳 Promise,resolve 回傳文件陣列
 */
async function allDocsOf(msg, docs) {
    if (!Array.isArray(msg.data._docs)) msg.data._docs = await docs.select()
    return msg.data._docs
}

/**
 * mw 錨點 capture.docMaintain.recheckHealth:健全閘存量重判(檢定標準 CS1a;見檔頭)
 *
 * 讀 ctx.deps.stores.docs(raw)、settings.capture(standards 之閘參數與 healthRecheckPerRun、articles.maxTries);寫回不同於現版之 raw 文件(healthV 或分流欄位)、
 * msg.data.health(本輪結果:version、undetermined[{ id, why }] 至多 20 筆)與 count(msg,'health*')。不短路。
 *
 * @param {Object} [opt={}] 輸入子階段 opts,非物件則回退為 {}
 * @param {Integer} [opt.healthRecheckPerRun=500] 輸入每輪至多寫入篇數(未給則用 settings.capture.standards.healthRecheckPerRun)
 * @returns {Object} 回傳 defineMw 產物
 * @example
 * // 閘版本(healthV)不同於現版的 raw 文件，以庫內原文重判:合格者改記現版
 * let text = '黑洞光譜的觀測記錄包含吸積盤與噴流的詳細描述。'.repeat(20)
 * let rows = [{ id: 'd1', status: 'raw', healthV: 'old', textFrom: 'article', text, fullLength: text.length, title: '黑洞光譜', rawAt: '2026-08-01T00:00:00+08:00' }]
 * let docs = {
 *     select: async () => rows,
 *     patch: async (id, p) => Object.assign(rows.find((r) => r.id === id), p),
 * }
 * let settings = { capture: { standards: {}, articles: { maxTries: 3 } } }
 * let ctx = { deps: { stores: { docs }, settings, clock: { iso8: () => '2026-09-01T00:00:00+08:00' } }, log: { info() {}, warn() {} } }
 * let { msg } = await composeChain([mwRecheckHealth()])(makeMsg('maintenance', {}), ctx)
 * console.log(msg.stats.healthDue, msg.stats.healthPassed, rows[0].healthV === msg.data.health.version)
 * // => 1 1 true
 */
export const mwRecheckHealth = (opt = {}) => {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    return defineMw({
        name: 'recheckHealth',
        handle: async (msg, ctx, next) => {
            const { stores, settings, clock } = ctx.deps
            const cap = settings?.capture || {}
            const gates = createHealthGates(cap.standards)
            // 每輪上限:子階段 opt ＞ settings.capture.standards.healthRecheckPerRun ＞ 預設
            const per = perRunOf(opt.healthRecheckPerRun ?? cap.standards?.healthRecheckPerRun, HEALTH_RECHECK_PER_RUN)
            const budget = budgetOf(ctx)
            const nowIso = clock?.iso8?.() || ''
            const due = (await allDocsOf(msg, stores.docs))
                .filter((d) => d.status === 'raw' && d.healthV !== gates.version)
                .sort((a, b) => String(a.rawAt || '').localeCompare(String(b.rawAt || '')) || String(a.id).localeCompare(String(b.id)))
            const undetermined = []
            const routed = { final: 0, browser: 0, refetch: 0, retry: 0 }
            let written = 0
            let passed = 0
            let na = 0
            let left = 0
            for (let i = 0; i < due.length; i++) {
                if (written >= per || budget.shouldStop()) {
                    left = due.length - i
                    break
                }
                const d = due[i]
                const p = planHealthRecheck(d, gates, { nowIso, maxFetchTries: cap.articles?.maxTries })
                if (p.status === STATUS.UNDETERMINED) {
                    undetermined.push({ id: d.id, why: p.why }) // 無原文可判:記入報告,不動該篇
                    continue
                }
                // 判 dead 者改狀態前另存判定依據(庫內正文;落 raw 時已另存同一份者不重寫)
                if (p.route?.action === 'final' && stores.docTexts) {
                    try {
                        await archiveDocText(stores.docTexts, { ...d, status: 'dead' }, nowIso)
                    }
                    catch (e) {
                        ctx.log.warn(`內文[${oneline(d.title || d.url, 40)}] 判定依據另存失敗（${oneline(e?.message, 100)}）`)
                    }
                }
                await stores.docs.patch(d.id, p.patch)
                await syncIndex(stores.docs, { id: d.id, status: p.patch.status || d.status, ...(Object.hasOwn(p.patch, 'paraKeys') ? { paraKeys: p.patch.paraKeys } : {}) })
                written++
                if (p.status === STATUS.PASS) passed++
                else if (p.status === STATUS.NA) na++
                else {
                    routed[p.route.action] = (routed[p.route.action] || 0) + 1
                    ctx.log.info(`內文[${oneline(d.title || d.url, 40)}] 健全閘重判（版本 ${gates.version}）判 ${p.kind}（${oneline(p.hit, 80)}）→ ${ROUTE_LABELS[p.route.action] || p.route.action}`)
                }
            }
            // 內容類 dead 依版重判(檔頭):與 raw 重判共用每輪名額;依據取 docs 或 docTexts(瘦身後)
            const deadDue = (await allDocsOf(msg, stores.docs))
                .filter((d) => d.status === 'dead' && d.healthV && d.healthV !== gates.version && GATE_DEAD_CLASSES.includes(d.deadClass))
                .sort((a, b) => String(a.deadAt || '').localeCompare(String(b.deadAt || '')) || String(a.id).localeCompare(String(b.id)))
            let deadRevived = 0
            let deadKept = 0
            let deadLeft = 0
            for (let i = 0; i < deadDue.length; i++) {
                if (written >= per || budget.shouldStop()) {
                    deadLeft = deadDue.length - i
                    break
                }
                const d = deadDue[i]
                const ev = await docTextOf(stores, d.id)
                const p = planDeadRecheck(d, ev?.text || null, gates, { nowIso, maxFetchTries: cap.articles?.maxTries })
                if (p.status === STATUS.UNDETERMINED) {
                    undetermined.push({ id: d.id, why: p.why })
                    continue
                }
                await stores.docs.patch(d.id, p.patch)
                written++
                if (p.status === STATUS.PASS) {
                    deadRevived++
                    ctx.log.info(`內文[${oneline(d.title || d.url, 40)}] 內容類 dead 依版重判（版本 ${gates.version}）：${p.why} → 回待抓`)
                }
                else deadKept++
            }
            count(msg, 'healthDeadDue', deadDue.length)
            count(msg, 'healthDeadRevived', deadRevived)
            count(msg, 'healthDeadKept', deadKept)
            left += deadLeft
            if (deadDue.length) ctx.log.info(`內容類 dead 依版重判（版本 ${gates.version}）：應重判 ${deadDue.length}、回待抓 ${deadRevived}、仍違規 ${deadKept}${deadLeft ? `、留下輪 ${deadLeft}` : ''}`)
            const nRouted = Object.values(routed).reduce((a, n) => a + n, 0)
            count(msg, 'healthDue', due.length)
            count(msg, 'healthPassed', passed)
            count(msg, 'healthNA', na)
            for (const [k, n] of Object.entries(routed)) count(msg, `healthRouted_${k}`, n)
            count(msg, 'healthUndetermined', undetermined.length)
            count(msg, 'healthLeft', left)
            msg.data.health = { version: gates.version, undetermined: undetermined.slice(0, LIST_MAX) }
            if (due.length) {
                ctx.log.info(`健全閘存量重判（版本 ${gates.version}）：應重判 ${due.length}、合格 ${passed}、不適用 ${na}、改分流 ${nRouted}（終態 ${routed.final}、瀏覽器佇列 ${routed.browser}、補全文佇列 ${routed.refetch + routed.retry}）、未能判定 ${undetermined.length}` +
                    `${undetermined.length ? `（${oneline(undetermined.slice(0, 3).map((x) => `${x.id}：${x.why}`).join('；'), 160)}）` : ''}${left ? `、留下輪 ${left}` : ''}`)
            }
            return next(msg)
        },
    })
}

/**
 * mw 錨點 capture.docMaintain.fillParaKeys:段落雜湊補算(檢定標準 CS10 存量;見檔頭)
 *
 * 讀 ctx.deps.stores.docs(noted)與 docTexts;寫回無 paraKeys 之 noted 文件之 paraKeys(或 paraKeysNoText)與 count(msg,'paraKeys*')。不短路。
 *
 * @param {Object} [opt={}] 輸入子階段 opts,非物件則回退為 {}
 * @param {Integer} [opt.paraKeysPerRun=2000] 輸入每輪至多篇數(未給則用 settings.capture.standards.paraKeysPerRun)
 * @returns {Object} 回傳 defineMw 產物
 * @example
 * // noted 文件無 paraKeys 者以原文補算;兩處皆無原文者記 paraKeysNoText
 * let text = '黑洞光譜的觀測記錄包含吸積盤與噴流的詳細描述。'.repeat(4)
 * let rows = [{ id: 'd1', status: 'noted', text }, { id: 'd2', status: 'noted', text: '' }]
 * let docs = {
 *     select: async () => rows,
 *     get: async (id) => rows.find((r) => r.id === id) || null,
 *     patch: async (id, p) => Object.assign(rows.find((r) => r.id === id), p),
 * }
 * let ctx = { deps: { stores: { docs }, settings: { capture: { standards: {} } }, clock: { iso8: () => '2026-09-01T00:00:00+08:00' } }, log: { info() {}, warn() {} } }
 * let { msg } = await composeChain([mwFillParaKeys()])(makeMsg('maintenance', {}), ctx)
 * console.log(msg.stats.paraKeysFilled, msg.stats.paraKeysNoText, rows[0].paraKeys.length)
 * // => 1 1 1
 */
export const mwFillParaKeys = (opt = {}) => {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    return defineMw({
        name: 'fillParaKeys',
        handle: async (msg, ctx, next) => {
            const { stores, clock, settings } = ctx.deps
            // 每輪上限:子階段 opt ＞ settings.capture.standards.paraKeysPerRun ＞ 預設
            const per = perRunOf(opt.paraKeysPerRun ?? settings?.capture?.standards?.paraKeysPerRun, PARA_KEYS_PER_RUN)
            const budget = budgetOf(ctx)
            const nowIso = clock?.iso8?.() || ''
            const due = (await allDocsOf(msg, stores.docs))
                .filter((d) => d.status === 'noted' && !Array.isArray(d.paraKeys) && !d.paraKeysNoText)
                .sort((a, b) => String(a.notedAt || '').localeCompare(String(b.notedAt || '')) || String(a.id).localeCompare(String(b.id)))
            let filled = 0
            let noText = 0
            for (const d of due.slice(0, per)) {
                if (budget.shouldStop()) break
                // 原文:docs 尚未瘦身者直取,已瘦身者取另存(docTexts;core/stores/docTexts.docTextOf 為取得原文之單一實作)
                const text = d.text ? String(d.text) : String((await docTextOf(stores, d.id))?.text || '')
                if (text) {
                    const paraKeys = paraKeysOf(text)
                    await stores.docs.patch(d.id, { paraKeys })
                    await syncIndex(stores.docs, { id: d.id, url: d.url, finalUrl: d.finalUrl, paraKeys, status: d.status })
                    filled++
                }
                else {
                    await stores.docs.patch(d.id, { paraKeysNoText: nowIso || true })
                    noText++
                }
            }
            const left = due.length - filled - noText
            count(msg, 'paraKeysDue', due.length)
            count(msg, 'paraKeysFilled', filled)
            count(msg, 'paraKeysNoText', noText)
            count(msg, 'paraKeysLeft', left)
            if (due.length) ctx.log.info(`段落雜湊補算（CS10 存量）：待補 ${due.length}、本輪補 ${filled}、無原文 ${noText}（docs 與 docTexts 皆無，符合度掃描記未能判定）${left ? `、留下輪 ${left}` : ''}`)
            return next(msg)
        },
    })
}

/**
 * mw 錨點 capture.docMaintain.slim:終態瘦身:清掉不再會被讀到的原文素材(select 成本隨位元組線性成長)
 *
 * 讀 ctx.deps.stores.docs(依 opt.terminalStatuses 選出終態文件)與 docTexts;須另存之終態先另存原文再清(core/stores/docPolicy);
 * 未設 docTexts 時須另存之終態不清、WARN 一次(原文不得在無另存時被清除)。count(msg,'slimmed'／'archived'／'archiveFailed'／'noArchive')。
 * 不讀寫 msg.data 本身欄位;不短路。
 *
 * @param {Object} [opt={}] 輸入子階段 opts,非物件則回退為 {}
 * @param {Array} [opt.terminalStatuses] 輸入終態狀態字串陣列,未給則用 DOC_TERMINAL_STATUSES(core/stores/docPolicy)
 * @returns {Object} 回傳 defineMw 產物
 * @example
 * let rows = [{ id: 'd1', status: 'dead', text: '失敗頁面的殘留素材', feedText: '' }]
 * let docs = {
 *     select: async (f) => rows.filter((r) => r.status === f.status),
 *     patch: async (id, p) => Object.assign(rows.find((r) => r.id === id), p),
 * }
 * let ctx = { deps: { stores: { docs }, clock: { iso8: () => '2026-09-01T00:00:00+08:00' } }, log: { info() {}, warn() {} } }
 * let { msg } = await composeChain([mwSlim({ terminalStatuses: ['dead'] })])(makeMsg('maintenance', {}), ctx)
 * console.log(msg.stats, rows[0].text === '', rows[0].textLength)
 * // => { slimmed: 1, archived: 0, archiveFailed: 0 } true 9
 */
export const mwSlim = (opt = {}) => {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    return defineMw({
        name: 'slim',
        handle: async (msg, ctx, next) => {
            const { stores, clock } = ctx.deps
            const terminal = opt.terminalStatuses || DOC_TERMINAL_STATUSES
            // capture.articles.archiveText:false → 不另存(零件庫用法之選項);須另存之終態亦不清正文(原文留庫)
            const archiveOn = ctx.deps.settings?.capture?.articles?.archiveText !== false
            const archive = archiveOn ? (stores.docTexts || null) : null
            // 原文先另存(docTexts)再清:檢定標準調整時以原文重檢(core/stores/docTexts 檔頭);無另存集合 → 須另存之終態不清
            const held = archive ? [] : (Array.isArray(terminal) ? terminal : []).filter((st) => DOC_TEXT_STATUSES.includes(st))
            const statuses = Array.isArray(terminal) ? terminal.filter((st) => !held.includes(st)) : terminal
            if (held.length) {
                count(msg, 'noArchive', 1)
                if (!archiveOn) ctx.log.info(`終態文件瘦身：原文另存停用（capture.articles.archiveText:false），${held.join('／')} 之正文不清；其餘終態照常瘦身`)
                else ctx.log.warn(`終態文件瘦身：未設原文另存集合（docTexts），${held.join('／')} 之原文本輪不清（原文不得在無另存時被清除）；其餘終態照常瘦身`)
            }
            const r = await slimTerminalDocs(stores.docs, { terminalStatuses: statuses, archive, nowIso: clock?.iso8?.() || '' })
            if (r.slimmed > 0) ctx.log.info(`終態文件瘦身：${r.slimmed} 篇（原文另存 ${r.archived} 篇），釋出 ${(r.freedBytes / 1024 / 1024).toFixed(2)} MB`)
            if (r.archiveFailed > 0) ctx.log.warn(`終態文件原文另存失敗 ${r.archiveFailed} 篇：本輪不清其原文，下輪再試`)
            count(msg, 'slimmed', r.slimmed)
            count(msg, 'archived', r.archived)
            count(msg, 'archiveFailed', r.archiveFailed)
            return next(msg)
        },
    })
}

/**
 * 文件維護子階段工廠:單一 maintenance 訊息依序流過 recheckHealth → fillParaKeys → slim 三環(可 tap／chain 掛載)
 *
 * run(ctx) 回傳統一 report,detail 含 slimmed、archived、archiveFailed、noArchive,以及 health(健全閘存量重判計數)與 paraKeys(段落雜湊補算計數)兩組。
 *
 * @param {Object} [opt={}] 輸入子階段設定,非物件則回退為 {};可含 chain, tap, terminalStatuses, healthRecheckPerRun, paraKeysPerRun
 * @returns {Object} 回傳階段物件 { name:'docMaintain', run(ctx) }
 * @example
 * let rows = [{ id: 'd1', status: 'dead', text: '失敗頁面的殘留素材' }]
 * let docs = {
 *     select: async (f) => rows.filter((r) => !f || Object.entries(f).every(([k, v]) => r[k] === v)),
 *     get: async (id) => rows.find((r) => r.id === id) || null,
 *     patch: async (id, p) => Object.assign(rows.find((r) => r.id === id), p),
 * }
 * let ctx = { deps: { stores: { docs }, settings: resolveSettings({}), clock: { iso8: () => '2026-09-01T00:00:00+08:00' } }, log: { info() {}, warn() {} } }
 * let stage = stageDocMaintain({ terminalStatuses: ['dead'] })
 * let r = await stage.run(ctx)
 * console.log(stage.name, r.ok, r.detail.slimmed, r.detail.health.due, r.detail.paraKeys.due)
 * // => docMaintain true 1 0 0
 */
export function stageDocMaintain(opt = {}) {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    const chain = opt.chain || applyTaps([mwRecheckHealth(opt), mwFillParaKeys(opt), mwSlim(opt)], opt.tap, { chainName: 'capture.docMaintain' })
    return {
        ...stageFields(opt, { name: 'docMaintain' }),
        run: async (ctx) => {
            const m = makeMsg('maintenance', {})
            const r = await runChainOverMsgs({ chain, ctx, msgs: [m], chainName: 'capture.docMaintain' })
            const s = r.stats
            const n = (k) => s[k] || 0
            return stdReport({
                ok: r.fails === 0,
                stats: { in: 1, out: 1, fail: r.fails },
                detail: {
                    slimmed: n('slimmed'),
                    archived: n('archived'),
                    archiveFailed: n('archiveFailed'),
                    noArchive: n('noArchive'),
                    // 檢定標準 CS1a:健全閘存量重判(版本、應重判、合格、不適用、改分流、未能判定〔附 id〕、留下輪)
                    health: {
                        version: m.data.health?.version || '',
                        due: n('healthDue'),
                        passed: n('healthPassed'),
                        na: n('healthNA'),
                        routed: { final: n('healthRouted_final'), browser: n('healthRouted_browser'), refetch: n('healthRouted_refetch'), retry: n('healthRouted_retry') },
                        // 內容類 dead 依版重判(應重判、回待抓、仍違規)
                        dead: { due: n('healthDeadDue'), revived: n('healthDeadRevived'), kept: n('healthDeadKept') },
                        undetermined: n('healthUndetermined'),
                        undeterminedIds: m.data.health?.undetermined || [],
                        left: n('healthLeft'),
                    },
                    // 檢定標準 CS10:存量段落雜湊補算
                    paraKeys: { due: n('paraKeysDue'), filled: n('paraKeysFilled'), noText: n('paraKeysNoText'), left: n('paraKeysLeft') },
                },
            })
        },
    }
}

export default stageDocMaintain
