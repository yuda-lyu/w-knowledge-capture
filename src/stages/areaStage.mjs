// areaStage.mjs — 抓取物件子階段 a6(最末):領域清單之品質回饋、自動發現、來源同步與投影
//
// 【領域自動擴充】各篇文章帶出之重要新領域須能創建與擴充領域清單:候選取自筆記主概念(近窗支持數與成長,扣除既有領域 grid 文件)
//   與文章線索(相異文件數);排除語意已涵蓋者;一次 AI 呼叫判覆蓋並產生領域標籤與 OpenAlex 查詢;以 OpenAlex 計數、
//   首頁摘要率與「首頁已在庫比例」驗證後才啟用(未過者記為已拒並冷卻,不每日重提)。
//   筆記集合(stores.notes)為選配:未開時候選只取線索(不拋錯)。
// 【排在抓取物件最末】AI 呼叫放在 listFetch 之前會以席位遞補鏈之總逾時阻塞整段抓取;
//   且以整輪剩餘時間守門、單次封頂,保護後段處理。
// 【頻率與額度持久化】發現時刻、當日新增數存於領域集合之中繼記錄(_meta),跨行程重啟不重置。
// 【AI 失敗即等下一窗口】不退回關鍵詞抽取:未經語意判定之查詢會產生冗餘領域。
// 【無動作鏈】機制性子階段,無 hook 錨點:opt.tap／chain 給了即拋錯(不在 captureObject 之 CAPTURE_TAP_STAGE_KEYS)。

import fs from 'fs'
import path from 'path'
import isobj from 'wsemi/src/isobj.mjs'
import isarr from 'wsemi/src/isarr.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import fsCreateFolder from 'wsemi/src/fsCreateFolder.mjs'
import fetchWebByCurl from 'w-fetch-web/src/fetchWebByCurl.mjs'
import { stdReport, rejectChainOpts, stageFields } from '../core/kernel.mjs'
import { budgetOf, oneline } from '../core/runnerPackage.mjs'
import { sha1 } from '../core/util/text.mjs'
import { ensureSeedSources } from '../stores/sourcePolicy.mjs'
import { AREA_META_ID, areaIdOf, syncAreaSources, pickAreaCandidates, areaQualityCfgOf, reviewAutoAreas, reprobeAutoAreas, reopenArea, activeAreaCount, renderAreasMd } from '../stores/areaPolicy.mjs'
import { createAreaDomain } from '../domain/areaDomain.mjs'
import { scriptOf } from '../core/locale.mjs'
import { netDownAtStart } from '../core/util/netGuard.mjs'

/** 發現所需之整輪剩餘時間下限(保護後段) */
export const AREA_MIN_REMAINING_MS = 25 * 60_000
/** 發現之 AI 一次嘗試之時間上限(整個呼叫之預算為其 2 倍,容得下首家逾時後一次遞補;見 discover) */
export const AREA_AI_BUDGET_MS = 5 * 60_000
/** 發現失敗後之重試間隔上限(與發現間隔取小者;失敗不作廢當日窗口) */
export const DISCOVER_RETRY_MS = 3 * 3_600_000

/**
 * 寫領域清單之投影 <dirs.knowledge>/areas.md(唯一寫法:領域子階段每輪末與領域維運工具〔暫停／恢復後重繪〕共用;投影可由資料庫重建)
 *
 * @param {Object} stores 輸入集合 { areas, sources }
 * @param {Object} dirs 輸入目錄(取 knowledge)
 * @param {Object} [opt={}] 輸入設定物件(渲染見 stores/areaPolicy 之 renderAreasMd)，非物件則視為{}
 * @param {String} [opt.nowIso] 輸入投影之時刻 ISO 字串，未給則不印時刻
 * @returns {Promise} 回傳 Promise，resolve 回傳 { file:String(絕對路徑), areas:Array(不含中繼記錄), sourcesById:Map(grid 來源) }
 * @throws {Error} 讀集合或寫檔失敗時拋出(呼叫端決定記 WARN 或中止)
 * @example
 * let stores = {
 *     areas: { select: async () => [{ id: 'a1', label: '黑洞光譜', query: 'black hole spectra', origin: 'seed', status: 'active' }] },
 *     sources: { select: async () => [] },
 * }
 * let r = await writeAreasProjection(stores, { knowledge: './tmp/knowledge' }, { nowIso: '2026-09-01T00:00:00+08:00' })
 * console.log(r.areas.length, r.sourcesById.size, r.file.endsWith('areas.md'))
 * // => 1 0 true
 */
export async function writeAreasProjection(stores, dirs, opt = {}) {
    const areas = (await stores.areas.select()).filter((a) => a.id !== AREA_META_ID)
    const sourcesById = new Map((await stores.sources.select({ kind: 'grid' })).map((s) => [s.id, s]))
    fsCreateFolder(dirs.knowledge)
    const file = path.resolve(dirs.knowledge, 'areas.md')
    fs.writeFileSync(file, renderAreasMd(areas, sourcesById, { nowIso: isobj(opt) ? opt.nowIso : undefined }), 'utf8')
    return { file, areas, sourcesById }
}

/**
 * 以 OpenAlex 驗證候選查詢:計數(同 field 白名單)、首頁有摘要者、首頁已在庫比例(冗餘)
 *
 * @param {String} query 輸入查詢
 * @param {Object} ctx 輸入管道脈絡(取 deps.settings.capture 之 services.openAlex〔base、mailto〕、areas.openAlexFields、discover.minHits，與 deps.stores.docs、deps.seen)
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Function} [opt.fetchWebByCurl] 輸入 curl 抓取函數 (url, { timeoutMs, maxRetries }) => Promise<{ status, html, message }>(測試注入)，未給則用 w-fetch-web 之 fetchWebByCurl
 * @returns {Promise} 回傳 Promise，resolve 回傳 { ok, count, abstracts, overlap, reason }；OpenAlex 呼叫失敗或回應格式不符時另帶 transient:true(暫時性失敗，不應冷卻)
 * @example
 * // 以替身抓取函數回傳 8 筆皆有摘要之結果(不連網)
 * let words = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`w${i}`, [i]]))
 * let results = Array.from({ length: 8 }, (_, i) => ({ doi: `https://doi.org/10.1000/x${i}`, abstract_inverted_index: words }))
 * let fetchWebByCurl = async () => ({ status: 'success', html: JSON.stringify({ meta: { count: 120 }, results }) })
 * let ctx = {
 *     deps: {
 *         settings: { capture: { services: { openAlex: {} }, areas: { openAlexFields: '' }, discover: { minHits: 30 } } },
 *         stores: { docs: { get: async () => null } },
 *         seen: { idOf: (url) => url },
 *     },
 * }
 * console.log(await validateAreaQuery('black hole spectra', ctx, { fetchWebByCurl }))
 * // => { ok: true, count: 120, abstracts: 8, overlap: 0, reason: '' }
 *
 * // 抓取失敗:ok 為 false 且標 transient
 * let bad = async () => ({ status: 'error', message: 'HTTP 503' })
 * let r = await validateAreaQuery('black hole spectra', ctx, { fetchWebByCurl: bad })
 * console.log(r.ok, r.reason, r.transient)
 * // => false OpenAlex 驗證失敗：HTTP 503 true
 */
export async function validateAreaQuery(query, ctx, opt = {}) {
    const cap = ctx.deps.settings.capture
    const fetchFn = typeof opt.fetchWebByCurl === 'function' ? opt.fetchWebByCurl : fetchWebByCurl
    const oa = cap.services.openAlex
    const base = String(oa.base || 'https://api.openalex.org').replace(/\/+$/, '')
    const fields = String(cap.areas.openAlexFields || '').trim()
    const mailto = oa.mailto ? `&mailto=${encodeURIComponent(oa.mailto)}` : ''
    const u = `${base}/works?search=${encodeURIComponent(query)}&per-page=8&select=id,doi,primary_location,abstract_inverted_index` +
        (fields ? `&filter=${encodeURIComponent(`primary_topic.field.id:${fields}`)}` : '') + mailto
    const r = await fetchFn(u, { timeoutMs: 15_000, maxRetries: 1 })
    if (r?.status !== 'success') return { ok: false, count: 0, abstracts: 0, overlap: 0, reason: `OpenAlex 驗證失敗：${oneline(r?.message || r?.reason, 80)}`, transient: true }
    let j = null
    try {
        j = JSON.parse(r.html)
    }
    catch {
        return { ok: false, count: 0, abstracts: 0, overlap: 0, reason: 'OpenAlex 回應非 JSON', transient: true }
    }
    if (!isobj(j) || !isarr(j.results) || !Number.isFinite(Number(j.meta?.count))) return { ok: false, count: 0, abstracts: 0, overlap: 0, reason: 'OpenAlex 回應缺 results／meta.count', transient: true }
    const count = Number(j.meta.count)
    const abstracts = j.results.filter((p) => isobj(p?.abstract_inverted_index) && Object.keys(p.abstract_inverted_index).length >= 20).length
    const urls = j.results.map((p) => p?.doi || p?.primary_location?.landing_page_url || '').filter((x) => /^https?:\/\//.test(x))
    let inDb = 0
    for (const url of urls) {
        const id = typeof ctx.deps.seen?.idOf === 'function' ? ctx.deps.seen.idOf(url) : ''
        if (id && await ctx.deps.stores.docs.get(id)) inDb++
    }
    const overlap = urls.length ? inDb / urls.length : 0
    const reasons = []
    if (count < cap.discover.minHits) reasons.push(`計數 ${count} < ${cap.discover.minHits}`)
    if (abstracts < 5) reasons.push(`首頁有摘要者 ${abstracts}/8`)
    if (overlap > 0.5) reasons.push(`首頁已在庫 ${Math.round(overlap * 100)}%（與既有來源冗餘）`)
    return { ok: reasons.length === 0, count, abstracts, overlap: Math.round(overlap * 100) / 100, reason: reasons.join('；') }
}

/**
 * 領域子階段:品質回饋 → (到期時)自動發現 → 來源同步 → 投影
 *
 * @param {Object} [opt={}] 輸入子階段 opts，非物件則回退為 {}
 * @param {Object} [opt.domain] 輸入整組置換之領域發現 domain，未給則用 ctx.deps.domains.area(再無則依 vocab 建)
 * @param {Function} [opt.callAI] 輸入覆寫之 AI 呼叫函數 (prompt, check, { shouldStop, budgetMs }) => Promise<{ ok, data, error }>，未給則以 ctx.deps.ai.callJson 呼叫 settings.capture.discover.ai 席位
 * @param {Function} [opt.fetchWebByCurl] 輸入驗證用之 curl 抓取函數(測試注入)
 * @param {Function} [opt.validate] 輸入候選查詢之驗證器 (query, ctx, opt) => Promise<{ ok, reason, transient? }>(預設 validateAreaQuery:OpenAlex);
 *   非學術目錄之領域由宿主注入自己的驗證
 * @param {Function} [opt.now] 輸入現在時刻毫秒函數(測試注入)
 * @returns {Object} 回傳階段物件 { name:'areas', run(ctx) }(階段契約欄位 enabled／when 等見 core/kernel stageFields)
 * @throws {MwContractError} opt.tap／opt.chain 給了時拋出(本子階段無動作鏈)
 * @example
 * let stage = stageAreas()
 * console.log(stage.name, stage.onError, typeof stage.run)
 * // => areas continue function
 *
 * // 未開啟 areas 集合(ctx.deps.stores.areas 缺席)時，run 直接回報停用
 * console.log((await stage.run({ deps: { stores: {} } })).detail)
 * // => { disabled: true, reason: '未開啟 areas 集合' }
 */
export function stageAreas(opt = {}) {

    //check
    if (!isobj(opt)) {
        opt = {}
    }
    rejectChainOpts('areas', opt)

    return {
        ...stageFields(opt, { name: 'areas' }),
        run: async (ctx) => {
            const { stores, settings, clock, dirs } = ctx.deps
            if (!stores?.areas) return stdReport({ detail: { disabled: true, reason: '未開啟 areas 集合' } })
            const cap = settings.capture
            const sp = cap.sources || {}
            const nowIso = clock.iso8()
            const nowMs = typeof opt.now === 'function' ? opt.now() : Date.now()
            const all = await stores.areas.select()
            const meta = all.find((a) => a.id === AREA_META_ID) || { id: AREA_META_ID }
            let areas = all.filter((a) => a.id !== AREA_META_ID)
            const srcById = new Map((await stores.sources.select({ kind: 'grid' })).map((s) => [s.id, s]))
            const detail = { paused: 0, discovered: false, candidates: 0, proposed: 0, added: 0, rejected: 0, aiCalls: 0, skipped: '' }

            // ① 自動領域品質回饋(每輪,不需 AI;產出統計只計觀察窗內之判定——見 seedSync 之 cullSources)
            for (const p of reviewAutoAreas(areas, srcById, areaQualityCfgOf(settings))) {
                await stores.areas.patch(p.id, { status: 'paused', statusBy: 'auto', reason: p.reason, pausedAt: nowIso, updatedAt: nowIso })
                detail.paused++
                ctx.log.info(`領域：暫停自動領域 ${areas.find((a) => a.id === p.id)?.label}（${p.reason}）`)
            }
            // ①′ 被品質回饋暫停之自動領域,冷卻期滿重探(與來源停用之重探同一判定;暫停時刻未記者以首次觀察為起點)
            areas = (await stores.areas.select()).filter((a) => a.id !== AREA_META_ID)
            for (const a of areas.filter((x) => x.origin === 'auto' && x.status === 'paused' && x.statusBy === 'auto' && !x.pausedAt)) await stores.areas.patch(a.id, { pausedAt: nowIso })
            detail.reprobed = 0
            for (const a of reprobeAutoAreas(areas, { nowMs, reprobeDays: sp.reprobeDays, reprobePerRun: sp.reprobePerRun })) {
                await reopenArea(stores, a, nowIso)
                detail.reprobed++
                ctx.log.info(`領域：自動領域 ${a.label} 暫停冷卻期滿，重探（第 ${(Number(a.reprobes) || 0) + 1} 次；原因：${a.reason || '-'}），新觀察窗自本刻起算`)
            }

            // ② 自動發現(間隔、每日上限、啟用上限、整輪剩餘時間、本機網路皆守門)
            const day = nowIso.slice(0, 10)
            const addedToday = meta.day === day ? (meta.addedToday || 0) : 0
            const everyMs = (cap.discover.everyHours || 0) * 3_600_000
            const lastMs = Date.parse(meta.lastDiscoverAt || '')
            // 發現失敗(AI 失敗、驗證端拋錯)不作廢窗口:lastDiscoverAt 不推進,失敗後 min(間隔, 3 時)再試
            //   (失敗亦寫 lastDiscoverAt 的話,斷網或供應商故障一次即等一整個間隔)
            const failMs = Date.parse(meta.discoverFailAt || '')
            const retryMs = Math.min(everyMs, DISCOVER_RETRY_MS)
            const budget = budgetOf(ctx)
            areas = (await stores.areas.select()).filter((a) => a.id !== AREA_META_ID)
            const activeN = activeAreaCount(areas, srcById)
            if (everyMs <= 0 || cap.discover.newPerDay <= 0) detail.skipped = '自動發現停用'
            else if (!cap.discover.ai) detail.skipped = '未設領域發現席位（capture.discover.ai 為 null）'
            else if (Number.isFinite(lastMs) && nowMs - lastMs < everyMs) detail.skipped = '未到發現間隔'
            else if (Number.isFinite(failMs) && nowMs - failMs < retryMs) detail.skipped = '上次發現失敗，未到重試間隔'
            else if (addedToday >= cap.discover.newPerDay) detail.skipped = '已達每日新增上限'
            else if (activeN >= cap.areas.maxActive) detail.skipped = `啟用中領域已達上限 ${cap.areas.maxActive}`
            else if (budget.remainingMs() < AREA_MIN_REMAINING_MS) detail.skipped = '整輪剩餘時間不足'
            // 本機網路不通:只略過發現(品質回饋、重探、來源同步、投影皆不需網路,照跑)
            else if (await netDownAtStart(ctx, '領域發現')) detail.skipped = '本機網路不通'
            else {
                detail.discovered = true
                try {
                    const r = await discover(ctx, { opt, areas, nowMs, nowIso, budget, room: Math.min(cap.discover.newPerDay - addedToday, cap.areas.maxActive - activeN) })
                    Object.assign(detail, r)
                }
                catch (e) {
                    ctx.log.warn(`領域發現失敗（${oneline(e?.message, 160)}），${Math.round(retryMs / 60_000)} 分後再試`)
                    detail.error = oneline(e?.message, 160)
                }
                await stores.areas.insertNew([{ id: AREA_META_ID }])
                const lastResult = { candidates: detail.candidates, added: detail.added, rejected: detail.rejected, error: detail.error || '' }
                if (detail.error) await stores.areas.patch(AREA_META_ID, { discoverFailAt: nowIso, day, addedToday: addedToday + detail.added, lastResult })
                else await stores.areas.patch(AREA_META_ID, { lastDiscoverAt: nowIso, discoverFailAt: '', day, addedToday: addedToday + detail.added, lastResult })
            }
            if (detail.skipped && detail.skipped !== '未到發現間隔') ctx.log.info(`領域發現略過：${detail.skipped}`)

            // ③ 來源同步(新領域補入 grid 來源、非 active 者暫停其來源)
            const sync = await syncAreaSources(stores.sources, stores.areas, { nowIso, ensure: ensureSeedSources })
            Object.assign(detail, { sourcesAdded: sync.added, sourcesPaused: sync.paused, sourcesResumed: sync.resumed })

            // ④ 投影(可由資料庫重建;與領域維運工具同一寫法 writeAreasProjection)
            try {
                const p = await writeAreasProjection(stores, dirs, { nowIso })
                detail.active = activeAreaCount(p.areas, p.sourcesById)
                detail.total = p.areas.filter((a) => a.status !== 'rejected').length
            }
            catch (e) {
                ctx.log.warn(`領域清單投影寫入失敗：${oneline(e?.message, 160)}`)
            }
            return stdReport({ stats: { in: detail.candidates, out: detail.added, fail: detail.error ? 1 : 0, aiCalls: detail.aiCalls }, detail })
        },
    }
}

/**
 * 自動發現:候選 → 一次 AI 判覆蓋並產查詢 → OpenAlex 驗證 → 新增 auto 領域或記為已拒(冷卻)
 *
 * 候選取自線索,以及(有筆記集合 stores.notes 時)筆記主概念;無筆記集合時只取線索。
 * AI 席位取 settings.capture.discover.ai({ use, fallback, timeoutMs? })。
 *
 * @param {Object} ctx 輸入管道脈絡
 * @param {Object} o 輸入 { opt, areas, nowMs, nowIso, budget, room }
 * @returns {Promise} 回傳 Promise，resolve 回傳 { candidates, proposed, added, rejected, aiCalls }
 */
async function discover(ctx, o) {
    const { stores, settings, ai } = ctx.deps
    const cap = settings.capture
    const out = { candidates: 0, proposed: 0, added: 0, rejected: 0, aiCalls: 0 }
    // 筆記為選配集合:有才讀其主概念(連同文件之來源,供扣除既有領域 grid 文件之貢獻);沒有則候選只取線索
    const hasNotes = isfun(stores.notes?.select)
    const notes = hasNotes ? await stores.notes.select() : []
    const docSrc = hasNotes ? new Map((await stores.docs.select({ status: 'noted' })).map((d) => [d.id, d.sourceId])) : new Map()
    const clues = await stores.frontier.select()
    const dc = cap.discover
    const cands = pickAreaCandidates({ notes, docSourceOf: (id) => docSrc.get(id) || '', clues, areas: o.areas }, {
        nowMs: o.nowMs, windowDays: dc.windowDays, minSupport: dc.minSupport, minClueDocs: dc.minClueDocs, limit: dc.candidatesPerCall,
    })
    out.candidates = cands.length
    if (!cands.length) {
        ctx.log.info('領域發現：無候選（主概念與線索皆已涵蓋或未達門檻）')
        return out
    }
    const domain = o.opt.domain || ctx.deps.domains?.area || createAreaDomain({ vocab: ctx.deps.data?.vocab })
    const prompt = domain.buildPrompt(cands, o.areas.filter((a) => a.status === 'active' || a.status === 'paused'))
    const check = (d) => isarr(d) && d.some((it) => domain.isValidItem(it, cands.length))
    // 預算須容得下一次遞補:若上限只等於首家逾時,首家逾時即預算用盡、遞補鏈開不了工(當日窗口作廢);
    //   故上限取 2×AREA_AI_BUDGET_MS;保護後段之界線不變(至多吃進保留 AREA_AI_BUDGET_MS)
    const budgetMs = Math.max(30_000, Math.min(2 * AREA_AI_BUDGET_MS, o.budget.remainingMs() - AREA_MIN_REMAINING_MS + AREA_AI_BUDGET_MS))
    const call = o.opt.callAI || ((p, c, x) => ai.callJson(p, c, { spec: dc.ai, ...x }))
    out.aiCalls = 1
    const r = await call(prompt, check, { shouldStop: o.budget.shouldStop, budgetMs })
    if (!r?.ok) {
        ctx.log.warn(`領域發現：AI 判定失敗（${oneline(r?.error, 160)}），稍後再試（不作廢窗口）`)
        out.error = `AI 判定失敗：${oneline(r?.error, 120)}`
        return out
    }
    const items = (isarr(r.data) ? r.data : []).filter((it) => domain.isValidItem(it, cands.length)).sort((a, b) => a.index - b.index)
    // 字形政策(deps.locale;core/locale):領域標籤以正體入庫只在語言設定為繁體中文時(其餘恆等)
    const script = scriptOf(ctx.deps.locale, 'deps.locale')
    const known = new Set(o.areas.map((a) => a.id))
    // 已拒而冷卻已滿之查詢:同查詢再被提出即重驗(CS6;known 若含已拒者,同查詢永不重驗而冷卻形同永久)
    const cooled = new Set(o.areas.filter((a) => a.status === 'rejected' && !(Date.parse(a.cooldownUntil || '') > o.nowMs)).map((a) => a.id))
    const cooldownUntil = new Date(o.nowMs + (dc.rejectCooldownDays || 0) * 86400_000).toISOString()
    const reject = async (id, rec) => {
        if (known.has(id)) await stores.areas.patch(id, { ...rec, updatedAt: o.nowIso })
        else await stores.areas.insertNew([{ id, ...rec, createdAt: o.nowIso, updatedAt: o.nowIso }])
        known.add(id)
        out.rejected++
    }
    for (const it of items) {
        const cand = cands[it.index - 1]
        if (it.covered) {
            await reject(`cand:${sha1(cand.label)}`, { label: script.fix(cand.label), candidate: cand.label, query: '', origin: 'auto', status: 'rejected', statusBy: 'auto', reason: `已涵蓋或不宜：${oneline(it.why, 80)}`, cooldownUntil })
            continue
        }
        if (out.added >= o.room) break
        const query = domain.sanitizeQuery(it.query)
        const id = areaIdOf(query)
        const label = script.fix(String(it.label).trim()) // 檢定標準 CS12:領域標籤以正體入庫(只改違規處;字形政策依語言設定)
        out.proposed++
        if (known.has(id) && !cooled.has(id)) continue // 同查詢已存在(任何狀態;已拒而冷卻已滿者除外——重驗)
        const again = cooled.delete(id) // 本輪只重驗一次(同查詢再被提出即視為已存在)
        // 驗證器可注入(opt.validate;預設 OpenAlex 計數與首頁摘要):非學術目錄之領域由宿主自驗
        const validate = typeof o.opt.validate === 'function' ? o.opt.validate : validateAreaQuery
        const v = await validate(query, ctx, o.opt)
        if (!v.ok) {
            // 暫時性失敗(網路、回應異常)不入冷卻,下一窗口再試;驗證不過才冷卻
            if (!v.transient) await reject(id, { label, query, candidate: cand.label, origin: 'auto', status: 'rejected', statusBy: 'auto', reason: `驗證未過：${v.reason}`, cooldownUntil })
            ctx.log.info(`領域發現：候選「${cand.label}」→「${label}」(${query}) 未啟用（${v.reason}）`)
            continue
        }
        const rec = {
            label, query, origin: 'auto', status: 'active', statusBy: 'auto', reason: '',
            evidence: { candidate: cand.label, kind: cand.kind, support: cand.support, growth: cand.growth, clueDocs: cand.clueDocs, samples: cand.samples, why: oneline(it.why, 160) },
            validation: { count: v.count, abstracts: v.abstracts, overlap: v.overlap },
            updatedAt: o.nowIso,
        }
        if (again) await stores.areas.patch(id, { ...rec, cooldownUntil: '' })
        else await stores.areas.insertNew([{ id, ...rec, createdAt: o.nowIso }])
        known.add(id)
        out.added++
        ctx.log.info(`領域發現：${again ? '冷卻期滿重驗通過，啟用' : '新增'}自動領域「${label}」（查詢 ${query}；來自${cand.kind === 'clue' ? '線索' : '主概念'}「${cand.label}」；OpenAlex ${v.count} 筆）`)
    }
    return out
}

export default stageAreas
