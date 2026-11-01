// areaPolicy.mjs — 領域清單(areas)之機制:身分、種子同步、來源暫停同步、候選挑選、語意覆蓋排除、自動領域品質回饋、投影
//
// 【領域＝一條 grid 查詢】領域 id 即其 grid 來源 id(sourceId('grid', gridSourceUrl(query)));既有網格來源之 cursor 與統計原樣保留。
//   改查詢＝新領域(舊領域退役):來源 id 由查詢雜湊而來,不可原地改。
// 【欄位單一擁有者】領域 status(active／paused／retired／rejected)歸本檔;來源之 paused 只由本檔依領域狀態寫;
//   來源之 enabled 歸品質政策(sourcePolicy:連敗、連空、零產出)——兩欄互不覆寫。
//   statusBy:seed(種子同步)／auto(自動發現與品質回饋)／manual(維運 CLI);manual 只能由 manual 解除。
// 【只存 label,鍵於使用時算】normalizeConcept 隨改名／別名政策變動,持久化之鍵會在政策改後失配(core/util/text 之規則)。
// 【覆蓋是語意不是字面】種子標籤為複合片語(「神經網路可解釋性研究」),與筆記主概念幾乎不等鍵——覆蓋判定以正規化後互含為第一道,
//   AI 判定與 OpenAlex 首頁重疊率為後兩道(見 stages/areaStage)。

import isarr from 'wsemi/src/isarr.mjs'
import isobj from 'wsemi/src/isobj.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import { sourceId } from '../core/util/records.mjs'
import { normalizeUrl } from '../core/util/web.mjs'
import { normalizeConcept } from '../core/util/text.mjs'
import { noteDocIdOf, noteCreatedMsOf, noteTitleOf, notePrimaryConceptOf } from '../core/stores/noteFields.mjs'
import { gridSourceUrl, checkGridTopics } from '../fetchers/endpoints.mjs'
import { isLowYield, reprobeDue, freshWindowPatch } from './sourcePolicy.mjs'

const DAY = 86400_000

/** 領域集合中之中繼記錄 id(發現時刻、當日計數) */
export const AREA_META_ID = '_meta'

/**
 * 領域 id(＝其 grid 來源 id)
 *
 * @param {String} query 輸入查詢字串
 * @returns {String} 回傳 id
 * @example
 * console.log(areaIdOf('attention mechanism') === areaIdOf('attention mechanism'))
 * // => true
 */
export function areaIdOf(query) {
    return sourceId('grid', gridSourceUrl(query))
}

/**
 * 領域 → grid 來源記錄(與 endpoints.expandSeeds 之 grid 段同形)
 *
 * @param {Object} area 輸入領域記錄 { id, label, query, origin }
 * @param {Object} [opt={}] 輸入設定物件
 * @param {String} [opt.nowIso=''] 輸入現在時刻
 * @returns {Object} 回傳來源記錄(id 由查詢雜湊而來,name 為「網格：標籤」,origin 依領域來歷為 'seed' 或 'area:auto')
 * @example
 * const src = gridSourceOf({ label: '黑洞光譜', query: 'black hole spectra', origin: 'seed' }, { nowIso: '2026-09-01T00:00:00Z' })
 * console.log(src.name, src.kind, src.origin, src.enabled)
 * // => 網格：黑洞光譜 grid seed true
 */
export function gridSourceOf(area, opt = {}) {
    if (!isobj(opt)) opt = {}
    const url = gridSourceUrl(area.query)
    return {
        id: sourceId('grid', url),
        kind: 'grid',
        tier: 2,
        name: `網格：${area.label}`,
        url: normalizeUrl(url),
        query: area.query,
        lang: 'en',
        enabled: true,
        origin: area.origin === 'auto' ? 'area:auto' : 'seed',
        addedAt: opt.nowIso || '',
        lastFetchAt: '',
        okCount: 0,
        failCount: 0,
    }
}

/**
 * 種子領域同步:data.gridTopics → 領域(冪等);種子檔不再列者退役(可逆);不覆寫 manual 狀態
 *
 * @param {Object} areas 輸入領域集合(select／insertNew／patch)
 * @param {Array} gridTopics 輸入 [[標籤, 查詢], …]
 * @param {Object} [opt={}] 輸入設定物件
 * @param {String} [opt.nowIso=''] 輸入現在時刻
 * @returns {Promise} 回傳 Promise，resolve 回傳 { added, revived, retired, relabeled }
 * @throws {Error} gridTopics 之任一項不是 [非空標籤字串, 非空查詢字串] 時拋出(fetchers/endpoints 之 checkGridTopics)——
 *   先於任何寫入:形狀錯之清單不得建出垃圾領域,也不得讓既有種子領域因「不在清單」而被退役
 * @example
 * const rows = new Map()
 * const areas = {
 *     select: async () => [...rows.values()].map((r) => ({ ...r })),
 *     insertNew: async (items) => {
 *         const fresh = items.filter((it) => !rows.has(it.id))
 *         fresh.forEach((it) => rows.set(it.id, { ...it }))
 *         return { addCount: fresh.length }
 *     },
 *     patch: async (id, fields) => { Object.assign(rows.get(id), fields) },
 * }
 * const nowIso = '2026-09-01T00:00:00Z'
 * console.log(await syncSeedAreas(areas, [['黑洞光譜', 'black hole spectra'], ['行星大氣', 'planetary atmosphere']], { nowIso }))
 * // => { added: 2, revived: 0, retired: 0, relabeled: 0 }
 * console.log(await syncSeedAreas(areas, [['黑洞光譜', 'black hole spectra']], { nowIso }))
 * // => { added: 0, revived: 0, retired: 1, relabeled: 0 }
 */
export async function syncSeedAreas(areas, gridTopics, opt = {}) {
    if (!isobj(opt)) opt = {}
    checkGridTopics(gridTopics)
    const nowIso = opt.nowIso || ''
    const want = new Map()
    for (const [label, query] of isarr(gridTopics) ? gridTopics : []) want.set(areaIdOf(query), { label, query })
    const cur = new Map((await areas.select()).filter((a) => a.id !== AREA_META_ID).map((a) => [a.id, a]))
    const out = { added: 0, revived: 0, retired: 0, relabeled: 0 }
    const toAdd = []
    for (const [id, s] of want) {
        const a = cur.get(id)
        if (!a) {
            toAdd.push({ id, label: s.label, query: s.query, origin: 'seed', status: 'active', statusBy: 'seed', reason: '', createdAt: nowIso, updatedAt: nowIso })
            continue
        }
        const patch = {}
        if (a.label !== s.label) {
            patch.label = s.label; out.relabeled++
        }
        if (a.origin !== 'seed') patch.origin = 'seed' // 自動領域後來寫進種子檔 → 改由種子擁有
        if (a.status !== 'active' && a.statusBy === 'seed') {
            Object.assign(patch, { status: 'active', statusBy: 'seed', reason: '' }); out.revived++
        }
        if (Object.keys(patch).length) await areas.patch(id, { ...patch, updatedAt: nowIso })
    }
    if (toAdd.length) out.added = (await areas.insertNew(toAdd)).addCount
    for (const a of cur.values()) {
        if (a.origin !== 'seed' || want.has(a.id) || a.status === 'retired' || a.statusBy === 'manual') continue
        await areas.patch(a.id, { status: 'retired', statusBy: 'seed', reason: '種子檔已移除（或查詢已改）', updatedAt: nowIso })
        out.retired++
    }
    return out
}

/**
 * 依領域狀態同步 grid 來源:active 者補入來源(既有者只同步宣告欄位,見 sourcePolicy.ensureSeedSources)、
 * 非 active 者之來源標 paused(恢復時清除);來源之 enabled 不動(歸品質政策)
 *
 * @param {Object} sources 輸入來源集合
 * @param {Object} areas 輸入領域集合
 * @param {Object} [opt={}] 輸入設定物件
 * @param {String} [opt.nowIso=''] 輸入現在時刻
 * @param {Function} [opt.ensure] 輸入補入函數 (sources, seeds) => Promise(sourcePolicy.ensureSeedSources;注入以免循環依賴)
 * @returns {Promise} 回傳 Promise，resolve 回傳 { added, paused, resumed }
 * @example
 * const areas = { select: async () => [{ id: 'a1', label: '黑洞光譜', query: 'black hole spectra', status: 'paused', reason: '低產出' }] }
 * const rows = new Map([['a1', { id: 'a1', paused: false }]])
 * const sources = {
 *     get: async (id) => rows.get(id) || null,
 *     patch: async (id, fields) => { Object.assign(rows.get(id), fields) },
 * }
 * console.log(await syncAreaSources(sources, areas))
 * // => { added: 0, paused: 1, resumed: 0 }
 * console.log(rows.get('a1'))
 * // => { id: 'a1', paused: true, pauseReason: '領域paused：低產出' }
 */
export async function syncAreaSources(sources, areas, opt = {}) {
    if (!isobj(opt)) opt = {}
    const list = (await areas.select()).filter((a) => a.id !== AREA_META_ID && a.query)
    const active = list.filter((a) => a.status === 'active')
    let added = 0
    if (isfun(opt.ensure) && active.length) added = (await opt.ensure(sources, active.map((a) => gridSourceOf(a, opt)))).addCount || 0
    let paused = 0
    let resumed = 0
    for (const a of list) {
        const src = await sources.get(a.id)
        if (!src) continue
        const want = a.status !== 'active'
        if (!!src.paused === want) continue
        await sources.patch(a.id, { paused: want, pauseReason: want ? `領域${a.status}：${a.reason || ''}`.slice(0, 120) : '' })
        if (want) paused++
        else resumed++
    }
    return { added, paused, resumed }
}

/**
 * 候選是否已被既有領域涵蓋(第一道:正規化後之互含;語意判定另由 AI 與重疊率擔任)
 *
 * @param {String} label 輸入候選標籤
 * @param {Array} areas 輸入領域陣列(取 label、query;不含 retired／rejected)
 * @returns {Object|null} 回傳涵蓋之領域或 null
 * @example
 * console.log(!!coveringArea('可解釋性', [{ label: '神經網路可解釋性研究', query: 'neural network interpretability', status: 'active' }]))
 * // => true
 */
export function coveringArea(label, areas) {
    const k = normalizeConcept(label)
    const en = String(label || '').toLowerCase().replace(/\s+/g, ' ').trim()
    if (!k && !en) return null
    for (const a of isarr(areas) ? areas : []) {
        if (!a || a.status === 'retired' || a.status === 'rejected') continue
        const ak = normalizeConcept(a.label)
        const q = String(a.query || '').toLowerCase()
        if (k && ak && (ak.includes(k) || k.includes(ak))) return a
        if (en && q && /[a-z]/.test(en) && (q.includes(en) || en.includes(q))) return a
    }
    return null
}

/**
 * 挑領域候選:筆記主概念(窗內支持數與成長,扣除既有領域 grid 文件之貢獻)＋線索(相異文件數);排除已涵蓋與冷卻中之已拒者
 *
 * @param {Object} input 輸入資料 { notes, docSourceOf:(docId)=>sourceId, clues, areas }
 * @param {Object} cfg 輸入設定 { nowMs, windowDays, minSupport, minClueDocs, limit }
 * @returns {Array} 回傳候選陣列 [{ key, label, kind:'concept'|'clue', support, growth, clueDocs, score, samples:[{noteId,title}] }]
 * @example
 * const notes = [
 *     { id: 'n1', docId: 'd1', title: '恆星演化概述', createdAt: '2026-08-25T00:00:00Z', concepts: ['恆星演化'] },
 *     { id: 'n2', docId: 'd2', title: '紅巨星階段', createdAt: '2026-08-28T00:00:00Z', concepts: ['恆星演化'] },
 * ]
 * const clues = [{ type: 'keyword', value: '引力透鏡', status: 'pending', distinctDocs: 5 }]
 * const cfg = { nowMs: Date.parse('2026-09-01T00:00:00Z'), windowDays: 30, minSupport: 2, minClueDocs: 3, limit: 4 }
 * const r = pickAreaCandidates({ notes, clues, areas: [], docSourceOf: () => 's9' }, cfg)
 * console.log(r.map((c) => [c.kind, c.label, c.support, c.clueDocs]))
 * // => [ [ 'concept', '恆星演化', 2, 0 ], [ 'clue', '引力透鏡', 0, 5 ] ]
 */
export function pickAreaCandidates(input, cfg) {
    const notes = isarr(input?.notes) ? input.notes : []
    const clues = isarr(input?.clues) ? input.clues : []
    const areas = isarr(input?.areas) ? input.areas : []
    const docSourceOf = isfun(input?.docSourceOf) ? input.docSourceOf : () => ''
    const nowMs = Number.isFinite(cfg?.nowMs) ? cfg.nowMs : Date.now()
    const W = (cfg?.windowDays || 30) * DAY
    const gridIds = new Set(areas.map((a) => a.id))
    const rejected = areas.filter((a) => a.status === 'rejected' && Date.parse(a.cooldownUntil || '') > nowMs)
    const isRejected = (label) => rejected.some((a) => normalizeConcept(a.label) === normalizeConcept(label) || String(a.candidate || '') === label)
    const live = areas.filter((a) => a.status === 'active' || a.status === 'paused')

    // 主概念＝筆記之主標籤(core/stores/noteFields:第一個有效標籤;與下游之選題同一定義)
    const tally = new Map()
    for (const n of notes) {
        const t = noteCreatedMsOf(n)
        if (!Number.isFinite(t) || t < nowMs - 2 * W) continue
        if (gridIds.has(docSourceOf(noteDocIdOf(n)))) continue // 既有領域 grid 文件之主概念不回頭證明自己(避免自我增強)
        const primary = notePrimaryConceptOf(n)
        if (!primary) continue
        const { key, label } = primary
        if (!tally.has(key)) tally.set(key, { label, recent: 0, prev: 0, samples: [] })
        const g = tally.get(key)
        if (t >= nowMs - W) {
            g.recent++
            if (g.samples.length < 5) g.samples.push({ noteId: n.id, title: noteTitleOf(n).slice(0, 80) })
        }
        else g.prev++
    }
    const concepts = []
    for (const [key, g] of tally) {
        if (g.recent < (cfg?.minSupport || 20)) continue
        if (coveringArea(g.label, live) || isRejected(g.label)) continue
        const growth = g.recent / Math.max(1, g.prev)
        concepts.push({ key, label: g.label, kind: 'concept', support: g.recent, growth: Math.round(growth * 100) / 100, clueDocs: 0, score: g.recent * (1 + Math.min(growth, 3)), samples: g.samples })
    }
    // 線索(keyword／topic;全狀態——done 者再被提及仍累計,只看 pending 者只剩 hits 1:已消化者被排除之選擇偏差)
    const clueCands = []
    for (const c of clues) {
        if (!['keyword', 'topic'].includes(c?.type) || c.status === 'failed') continue
        const docsN = Number(c.distinctDocs) || Number(c.hits) || 0
        if (docsN < (cfg?.minClueDocs || 3)) continue
        const label = String(c.value || '').trim()
        if (!label || coveringArea(label, live) || isRejected(label)) continue
        clueCands.push({ key: normalizeConcept(label) || label.toLowerCase(), label, kind: 'clue', support: 0, growth: 0, clueDocs: docsN, score: docsN, samples: [] })
    }
    concepts.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    clueCands.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    // 兩類各取半(互補不互擠),不足者由另一類補滿
    const limit = cfg?.limit || 8
    const half = Math.ceil(limit / 2)
    const picked = [...concepts.slice(0, half), ...clueCands.slice(0, half)]
    for (const x of [...concepts.slice(half), ...clueCands.slice(half)]) {
        if (picked.length >= limit) break
        picked.push(x)
    }
    // 同鍵去重(概念與線索可能撞名)
    const seen = new Set()
    return picked.filter((x) => (seen.has(x.key) ? false : (seen.add(x.key), true))).slice(0, limit)
}

/**
 * 領域品質門檻(自設定取;領域子階段之暫停與巡檢之種子列示同一組,不各自手寫)
 *
 * @param {Object} settings 輸入解析後之設定(capture.sources.lowYieldRate／cullMinJudged、capture.areas.minFreshRate)
 * @returns {Object} 回傳 { lowYieldRate, minJudged, minFreshRate }(設定缺席者為 undefined)
 * @example
 * const cfg = areaQualityCfgOf({ capture: { sources: { lowYieldRate: 0.3, cullMinJudged: 6 }, areas: { minFreshRate: 0.2 } } })
 * console.log(cfg)
 * // => { lowYieldRate: 0.3, minJudged: 6, minFreshRate: 0.2 }
 */
export function areaQualityCfgOf(settings) {
    const sp = isobj(settings?.capture?.sources) ? settings.capture.sources : {}
    return { lowYieldRate: sp.lowYieldRate, minJudged: sp.cullMinJudged, minFreshRate: settings?.capture?.areas?.minFreshRate }
}

/**
 * 領域之品質判定(單一規則;自動領域據以暫停、種子領域據以巡檢列示):低產出(沿用來源政策之 capture.sources.lowYieldRate／cullMinJudged)或
 *   冗餘(近 5 次新件率均值 < minFreshRate)
 *
 * @param {Object} src 輸入該領域之 grid 來源記錄(judged／yielded／freshHist)
 * @param {Object} cfg 輸入設定 { lowYieldRate, minJudged, minFreshRate }
 * @returns {String} 回傳不合格之理由,合格回空字串
 * @example
 * const cfg = { lowYieldRate: 0.3, minJudged: 6, minFreshRate: 0.2 }
 * console.log(areaQualityIssue({ judged: 10, yielded: 1 }, cfg))
 * // => 低產出（已判定 10、產出 1）
 * console.log(areaQualityIssue({ judged: 2, yielded: 0, freshHist: [0.1, 0.1, 0, 0.1, 0.1] }, cfg))
 * // => 冗餘（近 5 次新件率均值 0.08）
 * console.log(JSON.stringify(areaQualityIssue({ judged: 10, yielded: 8 }, cfg)))
 * // => ""
 */
export function areaQualityIssue(src, cfg) {
    if (!isobj(src)) return ''
    if (isLowYield(src, { lowYieldRate: cfg?.lowYieldRate, minJudged: cfg?.minJudged })) return `低產出（已判定 ${src.judged}、產出 ${src.yielded || 0}）`
    const h = isarr(src.freshHist) ? src.freshHist : []
    const avg = h.length ? h.reduce((s, x) => s + (Number(x) || 0), 0) / h.length : 1
    if (h.length >= 5 && avg < (cfg?.minFreshRate ?? 0.2)) return `冗餘（近 ${h.length} 次新件率均值 ${avg.toFixed(2)}）`
    return ''
}

/**
 * 自動領域之品質回饋:areaQualityIssue 不合格 → 暫停
 *
 * @param {Array} areas 輸入領域陣列
 * @param {Map} sourcesById 輸入來源 id → 來源記錄
 * @param {Object} cfg 輸入設定 { lowYieldRate, minJudged, minFreshRate }
 * @returns {Array} 回傳 [{ id, reason }](應暫停者)
 * @example
 * const cfg = { lowYieldRate: 0.3, minJudged: 6, minFreshRate: 0.2 }
 * const areas = [
 *     { id: 'a1', label: '黑洞光譜', origin: 'auto', status: 'active' },
 *     { id: 'a3', label: '恆星演化', origin: 'auto', status: 'active' },
 * ]
 * const sourcesById = new Map([['a1', { id: 'a1', judged: 10, yielded: 1 }], ['a3', { id: 'a3', judged: 10, yielded: 8 }]])
 * console.log(reviewAutoAreas(areas, sourcesById, cfg))
 * // => [ { id: 'a1', reason: '低產出（已判定 10、產出 1）' } ]
 */
export function reviewAutoAreas(areas, sourcesById, cfg) {
    const out = []
    for (const a of isarr(areas) ? areas : []) {
        if (a?.origin !== 'auto' || a.status !== 'active') continue
        const src = sourcesById?.get?.(a.id)
        if (!src || src.enabled === false) continue
        const reason = areaQualityIssue(src, cfg)
        if (reason) out.push({ id: a.id, reason })
    }
    return out
}

/**
 * 種子領域之產出監測(巡檢列示、不暫停——種子由使用者維護,只受來源層之零產出停用):
 *   啟用中且其 grid 來源仍啟用者,依 areaQualityIssue 同一規則列出不合格者
 *
 * @param {Array} areas 輸入領域陣列
 * @param {Map} sourcesById 輸入來源 id → 來源記錄
 * @param {Object} cfg 輸入設定 { lowYieldRate, minJudged, minFreshRate }
 * @returns {Array} 回傳 [{ id, label, reason }]
 * @example
 * const cfg = { lowYieldRate: 0.3, minJudged: 6, minFreshRate: 0.2 }
 * const areas = [
 *     { id: 'a2', label: '行星大氣', origin: 'seed', status: 'active' },
 *     { id: 'a4', label: '星系分類', origin: 'seed', status: 'active' },
 * ]
 * const sourcesById = new Map([['a2', { id: 'a2', judged: 10, yielded: 0 }], ['a4', { id: 'a4', judged: 10, yielded: 8 }]])
 * console.log(watchSeedAreas(areas, sourcesById, cfg))
 * // => [ { id: 'a2', label: '行星大氣', reason: '低產出（已判定 10、產出 0）' } ]
 */
export function watchSeedAreas(areas, sourcesById, cfg) {
    const out = []
    for (const a of isarr(areas) ? areas : []) {
        if (a?.origin !== 'seed' || a.status !== 'active') continue
        const src = sourcesById?.get?.(a.id)
        if (!src || src.enabled === false) continue
        const reason = areaQualityIssue(src, cfg)
        if (reason) out.push({ id: a.id, label: String(a.label || a.id), reason })
    }
    return out
}

/**
 * 被品質回饋暫停之自動領域(origin auto、status paused、statusBy auto)之冷卻重探(CS5 之對稱:來源停用有重探,領域暫停亦然)——
 *   與來源停用同一冷卻判定(sourcePolicy.reprobeDue;起點 pausedAt、次數 reprobes);暫停最久者先,至多 reprobePerRun 個。
 *   手動暫停(statusBy manual)不在此列(只由維運解除)
 *
 * @param {Array} areas 輸入領域陣列
 * @param {Object} cfg 輸入設定 { nowMs, reprobeDays, reprobePerRun }
 * @returns {Array} 回傳應重探之領域(依暫停時刻升冪)
 * @example
 * const areas = [
 *     { id: 'a1', origin: 'auto', status: 'paused', statusBy: 'auto', pausedAt: '2026-01-01T00:00:00Z', reprobes: 0 },
 *     { id: 'a2', origin: 'auto', status: 'paused', statusBy: 'manual', pausedAt: '2026-01-01T00:00:00Z' },
 *     { id: 'a3', origin: 'auto', status: 'paused', statusBy: 'auto', pausedAt: '2026-02-20T00:00:00Z', reprobes: 0 },
 * ]
 * const cfg = { nowMs: Date.parse('2026-03-01T00:00:00Z'), reprobeDays: 30, reprobePerRun: 2 }
 * console.log(reprobeAutoAreas(areas, cfg).map((a) => a.id))
 * // => [ 'a1' ]
 */
export function reprobeAutoAreas(areas, cfg) {
    const perRun = Number(cfg?.reprobePerRun) || 0
    if (!(perRun > 0)) return []
    return (isarr(areas) ? areas : [])
        .filter((a) => a?.origin === 'auto' && a.status === 'paused' && a.statusBy === 'auto' && reprobeDue(a.pausedAt, a.reprobes, cfg?.nowMs, cfg?.reprobeDays))
        .sort((a, b) => String(a.pausedAt).localeCompare(String(b.pausedAt)) || String(a.id).localeCompare(String(b.id)))
        .slice(0, perRun)
}

/**
 * 重探之落帳(領域轉 active、開新觀察窗;其來源開新窗並重新啟用——試抓,新窗內仍低產出／冗餘即再暫停,冷卻倍增)
 *
 * @param {Object} stores 輸入集合物件 { areas, sources }
 * @param {Object} area 輸入領域記錄
 * @param {String} nowIso 輸入現在時刻
 * @returns {Promise} 回傳 Promise，resolve 回傳 undefined
 * @example
 * const areaRows = new Map([['a1', { id: 'a1', status: 'paused', statusBy: 'auto', reprobes: 0 }]])
 * const srcRows = new Map([['a1', { id: 'a1', enabled: false, failCount: 8 }]])
 * const stores = {
 *     areas: { patch: async (id, fields) => { Object.assign(areaRows.get(id), fields) } },
 *     sources: {
 *         get: async (id) => srcRows.get(id) || null,
 *         patch: async (id, fields) => { Object.assign(srcRows.get(id), fields) },
 *     },
 * }
 * await reopenArea(stores, areaRows.get('a1'), '2026-09-01T00:00:00Z')
 * console.log(areaRows.get('a1').status, areaRows.get('a1').reprobes, srcRows.get('a1').enabled, srcRows.get('a1').failCount)
 * // => active 1 true 0
 */
export async function reopenArea(stores, area, nowIso) {
    await stores.areas.patch(area.id, { status: 'active', statusBy: 'auto', reason: '', windowFrom: nowIso, reprobes: (Number(area.reprobes) || 0) + 1, updatedAt: nowIso })
    if (await stores.sources.get(area.id)) await stores.sources.patch(area.id, { enabled: true, ...freshWindowPatch(nowIso) })
}

/**
 * 啟用中領域數(來源已被品質政策停用者不計:那條查詢實際上已不抓)
 *
 * @param {Array} areas 輸入領域陣列
 * @param {Map} sourcesById 輸入來源 id → 來源記錄
 * @returns {Integer} 回傳數量
 * @example
 * const areas = [{ id: 'a1', status: 'active' }, { id: 'a2', status: 'active' }, { id: 'a3', status: 'paused' }]
 * console.log(activeAreaCount(areas, new Map([['a2', { id: 'a2', enabled: false }]])))
 * // => 1
 */
export function activeAreaCount(areas, sourcesById) {
    return (isarr(areas) ? areas : []).filter((a) => a?.status === 'active' && sourcesById?.get?.(a.id)?.enabled !== false).length
}

/**
 * 領域清單之狀態統計(外部巡檢與維運同用;規則之單一來源——巡檢不另寫一份):啟用中依來歷(種子／自動)、暫停／退役／已拒、
 *   啟用中而其 grid 來源已被來源政策停用者(形同停擺,不計入啟用上限——與 activeAreaCount 同一判準)、耗盡轉追新之 grid 來源數、
 *   種子領域產出監測(watchSeedAreas;給門檻才判,列示不暫停)
 *
 * @param {Array} areas 輸入領域陣列(中繼記錄自動略過)
 * @param {Map} sourcesById 輸入 grid 來源 id → 來源記錄
 * @param {Object} [opt={}] 輸入 { areaQuality(areaQualityCfgOf 之產物;未給不判種子產出) }
 * @returns {Object} 回傳 { seed, auto, paused, retired, rejected, sourceDisabled, fresh, seedWatch:[{ id, label, reason }] }
 * @example
 * const r = areaCountsOf([{ id: 'a', origin: 'seed', status: 'active' }], new Map([['a', { id: 'a', enabled: false, mode: 'fresh' }]]))
 * console.log(r.seed, r.sourceDisabled, r.fresh)
 * // => 1 1 1
 */
export function areaCountsOf(areas, sourcesById, opt = {}) {
    if (!isobj(opt)) opt = {}
    const rows = (isarr(areas) ? areas : []).filter((a) => a && a.id !== AREA_META_ID)
    const grid = sourcesById instanceof Map ? [...sourcesById.values()] : []
    const active = (a) => a.status === 'active'
    return {
        seed: rows.filter((a) => a.origin === 'seed' && active(a)).length,
        auto: rows.filter((a) => a.origin === 'auto' && active(a)).length,
        paused: rows.filter((a) => a.status === 'paused').length,
        retired: rows.filter((a) => a.status === 'retired').length,
        rejected: rows.filter((a) => a.status === 'rejected').length,
        sourceDisabled: rows.filter((a) => active(a) && sourcesById?.get?.(a.id)?.enabled === false).length,
        fresh: grid.filter((s) => s?.mode === 'fresh').length,
        seedWatch: isobj(opt.areaQuality) ? watchSeedAreas(rows, sourcesById, opt.areaQuality) : [],
    }
}

/**
 * 領域清單之 md 投影(可由資料庫重建;人讀用)
 *
 * @param {Array} areas 輸入領域陣列
 * @param {Map} sourcesById 輸入來源 id → 來源記錄
 * @param {Object} [opt={}] 輸入設定物件
 * @param {String} [opt.title='領域清單'] 輸入標題
 * @param {String} [opt.nowIso=''] 輸入產製時刻
 * @returns {String} 回傳 md 字串(標題、說明引言、領域表格;已拒者不入表,另以一行列出冷卻中之候選)
 * @example
 * const areas = [{ id: 'a1', label: '黑洞光譜', query: 'black hole spectra', origin: 'seed', status: 'active' }]
 * const sourcesById = new Map([['a1', { id: 'a1', judged: 10, yielded: 4, mode: 'fresh' }]])
 * const lines = renderAreasMd(areas, sourcesById, { nowIso: '2026-09-01T00:00:00Z' }).split('\n')
 * console.log(lines[0])
 * // => # 領域清單
 * console.log(lines[6])
 * // => | 黑洞光譜 | black hole spectra | 種子 | active | 追新 | 10 | 0.40 | - |  |
 */
export function renderAreasMd(areas, sourcesById, opt = {}) {
    if (!isobj(opt)) opt = {}
    const rows = (isarr(areas) ? areas : []).filter((a) => a && a.id !== AREA_META_ID && a.status !== 'rejected')
    const order = { active: 0, paused: 1, retired: 2 }
    rows.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || String(a.origin).localeCompare(String(b.origin)) || String(a.label).localeCompare(String(b.label)))
    const cell = (v) => String(v ?? '').replace(/\|/g, '／').replace(/\s+/g, ' ').trim()
    const line = (a) => {
        const s = sourcesById?.get?.(a.id) || {}
        const yieldRate = s.judged ? (s.yielded || 0) / s.judged : null
        const h = isarr(s.freshHist) ? s.freshHist : []
        const fresh = h.length ? (h.reduce((x, y) => x + (Number(y) || 0), 0) / h.length).toFixed(2) : '-'
        const state = a.status === 'active' && s.enabled === false ? 'active（來源已停用）' : a.status
        return `| ${cell(a.label)} | ${cell(a.query)} | ${a.origin === 'auto' ? '自動' : '種子'} | ${cell(state)} | ${s.mode === 'fresh' ? '追新' : '回補'} | ${s.judged || 0} | ${yieldRate === null ? '-' : yieldRate.toFixed(2)} | ${fresh} | ${cell(a.reason || (a.evidence ? `${a.evidence.kind === 'clue' ? '線索' : '主概念'}「${a.evidence.candidate}」` : ''))} |`
    }
    const rejected = (isarr(areas) ? areas : []).filter((a) => a?.status === 'rejected')
    return [
        `# ${opt.title || '領域清單'}`,
        '',
        `> 由抓取之領域子階段自資料庫重建${opt.nowIso ? `（${opt.nowIso}）` : ''}；勿手改。種子在 data 之 gridTopics，自動領域由發現子階段依筆記主概念與文章線索新增；暫停／恢復請用維運工具。`,
        '',
        '| 領域 | 查詢 | 來源 | 狀態 | 模式 | 已判定 | 產出率 | 新件率 | 備註 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        ...rows.map(line),
        '',
        ...(rejected.length ? [`冷卻中之已拒候選 ${rejected.length} 個：${rejected.slice(0, 30).map((a) => cell(a.label)).join('、')}`, ''] : []),
    ].join('\n')
}

/**
 * 維運:手動設定領域狀態(暫停／恢復);statusBy 記 manual(種子同步不再覆寫,直到手動解除)
 *
 * 恢復(active)＝試抓:其來源開新觀察窗(連敗、連空、產出統計、新件率自本刻起算;sourcePolicy.freshWindowPatch),被品質政策停用者
 * 一併重新啟用——品質回饋只依新窗內之判定(judgeFromDocs 之 since),不以恢復前之舊統計立刻再暫停(CS7;否則下一輪即被同一份舊統計暫停)。
 * 新窗內樣本足量而仍低產出／冗餘者照常暫停(恢復不豁免品質政策)
 *
 * @param {Object} stores 輸入集合物件 { areas, sources }
 * @param {String} idOrLabel 輸入領域 id 或標籤
 * @param {String} status 輸入 'active'｜'paused'
 * @param {Object} [opt={}] 輸入設定物件
 * @param {String} [opt.reason=''] 輸入原因
 * @param {String} [opt.nowIso=''] 輸入現在時刻
 * @returns {Promise} 回傳 Promise，resolve 回傳 { ok, area?, error? }
 * @example
 * const areaRows = new Map([['a1', { id: 'a1', label: '黑洞光譜', status: 'active', origin: 'seed' }]])
 * const srcRows = new Map([['a1', { id: 'a1', paused: false }]])
 * const stores = {
 *     areas: {
 *         select: async () => [...areaRows.values()].map((r) => ({ ...r })),
 *         patch: async (id, fields) => { Object.assign(areaRows.get(id), fields) },
 *     },
 *     sources: {
 *         get: async (id) => srcRows.get(id) || null,
 *         patch: async (id, fields) => { Object.assign(srcRows.get(id), fields) },
 *     },
 * }
 * const r = await setAreaStatus(stores, '黑洞光譜', 'paused', { reason: '暫時不抓', nowIso: '2026-09-01T00:00:00Z' })
 * console.log(r.ok, r.area.status, areaRows.get('a1').statusBy, srcRows.get('a1').pauseReason)
 * // => true paused manual 領域paused：暫時不抓
 * console.log(await setAreaStatus(stores, '不存在', 'active'))
 * // => { ok: false, error: '找不到領域：不存在' }
 */
export async function setAreaStatus(stores, idOrLabel, status, opt = {}) {
    if (!isobj(opt)) opt = {}
    if (!['active', 'paused'].includes(status)) return { ok: false, error: `status 須為 active 或 paused，收到 ${status}` }
    const list = (await stores.areas.select()).filter((a) => a.id !== AREA_META_ID && a.status !== 'rejected')
    const a = list.find((x) => x.id === idOrLabel) || list.find((x) => x.label === idOrLabel)
    if (!a) return { ok: false, error: `找不到領域：${idOrLabel}` }
    await stores.areas.patch(a.id, { status, statusBy: 'manual', reason: String(opt.reason || (status === 'paused' ? '手動暫停' : '')).slice(0, 120), updatedAt: opt.nowIso || '', ...(status === 'active' ? { windowFrom: opt.nowIso || '' } : {}) })
    const src = await stores.sources.get(a.id)
    if (src) {
        const patch = { paused: status !== 'active', pauseReason: status !== 'active' ? `領域paused：${opt.reason || '手動暫停'}`.slice(0, 120) : '' }
        if (status === 'active') Object.assign(patch, { enabled: true, ...freshWindowPatch(opt.nowIso) })
        await stores.sources.patch(a.id, patch)
    }
    return { ok: true, area: { ...a, status } }
}

export default { AREA_META_ID, areaIdOf, gridSourceOf, syncSeedAreas, syncAreaSources, coveringArea, pickAreaCandidates, areaQualityCfgOf, areaQualityIssue, reviewAutoAreas, watchSeedAreas, reprobeAutoAreas, reopenArea, activeAreaCount, areaCountsOf, renderAreasMd, setAreaStatus }
