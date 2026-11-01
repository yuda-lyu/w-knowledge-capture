// ingestGate.mjs — 文件入庫的單一閘門:契約檢查 → 業務過濾 → 去重占位入庫
//
// 【為何獨立成模組】入庫有兩條路徑:輪抓(listFetch 之 normalizeItems→filterItems→admitPersist 三環)
//   與探測入庫(expand)。若探測入庫直接 stores.docs.insertNew 一份自組記錄,就會繞過契約層(欄位對應、批內去重、
//   每來源上限的同一份實作)、業務過濾(安裝方之 filter 對它無效)與去重層的 invalid 留痕——同一規則
//   手寫兩份且不對稱。故兩條路徑都呼叫本模組:listFetch 的三環 mw 是本模組
//   三步的可掛載投影(hook 錨點與語意不變),expand 以 ingestFeedItems 一次走完三步。
// 【id 由去重層決定】seen.admit 一律以 identity(keyOf:'raw'＝sha1(canonicalUrl))覆寫 id;
//   契約層(normalizeItems)以同一份 identity 算 canonicalUrl 並做批內去重,兩層擋掉的是同一批。

import isobj from 'wsemi/src/isobj.mjs'
import { normalizeItems } from 'w-data-pipeline/src/fetch/itemContract.mjs'
import { defaultToRecord } from '../core/util/records.mjs'
import { contentIndexOf, matchSameContent, sameContentPatch } from './contentIndex.mjs'

/**
 * 內部共用檢查:o 須為物件且含 ctx.deps(閘門三步與 ingestFeedItems 皆依賴 ctx.deps 取得 stores/settings/seen,
 * 規則只在此寫一份,不逐函數各自手寫一次)
 *
 * @param {String} fnName 輸入呼叫端函數名稱(組錯誤訊息用)
 * @param {*} o 輸入待檢查之設定物件
 * @throws {Error} o 非物件、o.ctx 非物件或 o.ctx.deps 非物件時拋出
 */
function checkCtxDeps(fnName, o) {
    if (!isobj(o) || !isobj(o.ctx) || !isobj(o.ctx.deps)) {
        throw new Error(`${fnName} 需要 { ctx }`)
    }
}

/**
 * 步驟①契約檢查:原始項目 → 正規化項目(欄位對應、批內去重、每來源上限截斷);非法項目進 invalid 留痕。
 *
 * @param {Array} rawItems 輸入抓取函數回傳值(非陣列即拋——抓取器實作錯誤,不是「這次沒抓到」;
 *   此檢查由 w-data-pipeline normalizeItems 拋出 TypeError,本函數不重複判斷)
 * @param {Object} o 輸入設定物件，需含 ctx(ctx.deps)；可含 source、fetcherId、itemsPerSource
 * @param {Object} o.ctx 輸入管道脈絡(須含 ctx.deps;取 deps.settings、deps.seen)
 * @param {Object} [o.source] 輸入來源記錄(原樣帶入各項目)
 * @param {String} [o.fetcherId] 輸入抓取器 id(原樣帶入各項目)
 * @param {Integer} [o.itemsPerSource] 輸入每來源項目數上限(未給取 settings.capture.sources.itemsPerSource)
 * @returns {Object} 回傳 {items:Array, invalid:Array, dupInBatch:Integer}
 * @throws {Error} o 非物件或缺 ctx(ctx.deps)時拋出
 * @throws {TypeError} rawItems 非陣列時拋出(來自 w-data-pipeline normalizeItems)
 * @example
 * const ctx = { deps: { settings: { capture: { sources: { itemsPerSource: 8 } } } } }
 * const raw = [
 *     { url: 'https://example.com/post/1', title: '黑洞光譜' },
 *     { url: 'https://example.com/post/1', title: '黑洞光譜(重複)' },
 *     { title: '沒有網址' },
 * ]
 * const r = normalizeFeedItems(raw, { ctx, source: { id: 's1' }, fetcherId: 'rss' })
 * console.log(r.items.map((i) => i.url), r.invalid.length, r.dupInBatch)
 * // => [ 'https://example.com/post/1' ] 1 1
 */
export function normalizeFeedItems(rawItems, o) {

    //check
    checkCtxDeps('normalizeFeedItems', o)
    const { source, fetcherId, ctx, itemsPerSource } = o

    const { settings, seen } = ctx.deps
    // 契約層不截 feed 內文(maxTextChars 0):截斷與原長之記錄歸 toRecord(core/util/records.docRecord 記 feedFullLength)——若在此即截,
    //   docRecord 拿到的已是截後字串,feedFullLength 恆不成立、feed 入口之超長判準(健全閘 maxSaneChars)失效
    return normalizeItems(rawItems, {
        maxItems: itemsPerSource ?? settings.capture.sources.itemsPerSource,
        maxTextChars: 0,
        identity: seen?.identity || null,
        source,
        fetcherId,
    })
}

/**
 * 步驟②業務過濾(預設放行):黑名單/日期窗這類「否決」政策——必須在占位入庫之前。
 *
 * @param {Array} items 輸入正規化項目陣列
 * @param {Object} o 輸入設定物件，需含 ctx(ctx.deps)；可含 source、filter
 * @param {Object} o.ctx 輸入管道脈絡(須含 ctx.deps)
 * @param {Object} [o.source] 輸入來源記錄(傳給 filter)
 * @param {Function} [o.filter] 輸入業務過濾函數 (items, {source, ctx}) => Promise<Array>|Array，未給即放行
 * @returns {Promise} 回傳 Promise，resolve 回傳 {kept:Array, dropped:Integer}
 * @throws {Error} o 非物件或缺 ctx(ctx.deps)時拋出
 * @throws {TypeError} o.filter 回傳非陣列時拋出
 * @example
 * const ctx = { deps: {} }
 * const items = [{ url: 'https://example.com/post/1', title: '黑洞光譜' }, { url: 'https://example.com/post/2', title: '廣告' }]
 * const r = await filterFeedItems(items, { ctx, filter: (list) => list.filter((i) => i.title !== '廣告') })
 * console.log(r.kept.map((i) => i.title), r.dropped)
 * // => [ '黑洞光譜' ] 1
 */
export async function filterFeedItems(items, o) {

    //check
    checkCtxDeps('filterFeedItems', o)
    const { source, ctx, filter } = o

    if (typeof filter !== 'function') return { kept: items, dropped: 0 }
    const kept = await filter(items, { source, ctx })
    if (!Array.isArray(kept)) throw new TypeError('filterItems 之 filter 必須回傳陣列（要保留的項目）')
    return { kept, dropped: items.length - kept.length }
}

/**
 * 步驟③去重占位＋入庫(seen.admit＝insertNew):沒抓過才放行,越下游每步越貴。
 *   其後檢定標準 CS10:網址之正準代稱與既有文件相同者(同一內容換網址)→ 記錄留作去重憑證、狀態 skip(skipKind duplicate,不進 AI;
 *   來源產出統計不計——collectHelpers.judgeFromDocs)
 *
 * @param {Array} items 輸入正規化項目陣列
 * @param {Object} o 輸入設定物件，需含 ctx(ctx.deps)；可含 source、fetcher、toRecord
 * @param {Object} o.ctx 輸入管道脈絡(須含 ctx.deps;取 deps.seen、deps.stores.docs、deps.clock、deps.settings)
 * @param {Object} [o.source] 輸入來源記錄(寫入新記錄之來源欄位)
 * @param {Object} [o.fetcher] 輸入抓取器 { id }(記入 seen.admit 之 meta)
 * @param {Function} [o.toRecord] 輸入記錄組裝函數 (item, meta) => 文件記錄,未給即用內建 defaultToRecord
 * @returns {Promise} 回傳 Promise，resolve 回傳 seen.admit 之結果(含 fresh/dup/invalid;另 sameContent:Integer)
 * @throws {Error} o 非物件或缺 ctx(ctx.deps)時拋出
 * @example
 * import W from 'w-data-pipeline/src/WDataPipeline.mjs'
 * const rows = new Map()
 * const docs = {
 *     select: async () => [...rows.values()],
 *     insertNew: async (items) => {
 *         const added = items.filter((it) => !rows.has(it.id))
 *         added.forEach((it) => rows.set(it.id, { ...it }))
 *         return { added, addCount: added.length, dupCount: items.length - added.length }
 *     },
 *     patch: async (id, fields) => { Object.assign(rows.get(id), fields) },
 * }
 * const seen = W.createSeenStore({ collection: docs, identity: W.createIdentity({ keyOf: 'raw' }) })
 * const ctx = { deps: { settings: { capture: { sources: { itemsPerSource: 8 }, articles: { maxTextChars: 50 } } }, seen, clock: { iso8: () => '2026-09-01T00:00:00+08:00' }, stores: { docs } } }
 * const source = { id: 's1', name: '示範來源', kind: 'rss', tier: 3 }
 * await docs.insertNew([{ id: 'old1', url: 'https://arxiv.org/abs/2401.01234', status: 'noted' }])
 * const { items } = normalizeFeedItems([
 *     { url: 'https://arxiv.org/pdf/2401.01234', title: '同篇 PDF 版' },
 *     { url: 'https://example.com/post/1', title: '黑洞光譜' },
 * ], { ctx, source, fetcherId: 'rss' })
 * const r = await admitFeedItems(items, { ctx, source, fetcher: { id: 'rss' } })
 * console.log(r.fresh.map((x) => [x.url, x.status]), r.dup, r.sameContent)
 * // => [
 * //   [ 'https://arxiv.org/pdf/2401.01234', 'skip' ],
 * //   [ 'https://example.com/post/1', 'new' ]
 * // ] 0 1
 */
export async function admitFeedItems(items, o) {

    //check
    checkCtxDeps('admitFeedItems', o)
    const { source, fetcher, ctx, toRecord } = o

    const r = await ctx.deps.seen.admit(items, { toRecord: toRecord || defaultToRecord(ctx.deps), meta: { source, fetcher } })
    r.sameContent = await markSameContent(ctx, r.fresh || [])
    return r
}

/**
 * 新入庫之記錄若與既有文件為同一內容 → 改 skip(duplicate);其餘加入索引(同輪後到者亦可比對)。
 * 判定與正文落盤同一函數(contentIndex.matchSameContent):網址正準代稱;入庫即有素材之記錄(status raw,如 grid 摘要)另算段落雜湊比對
 * 並寫入 paraKeys(檢定標準 CS10 全部入口;段落少者依共享門檻自然不比)
 *
 * @param {Object} ctx 輸入管道脈絡(deps.stores.docs、clock)
 * @param {Array} recs 輸入新入庫之記錄(含 id、url;raw 者含 text);被改判者其 status 會就地改為 'skip'
 * @returns {Promise} 回傳 Promise，resolve 回傳改判為同一內容之筆數
 * @example
 * const rows = new Map([
 *     ['a', { id: 'a', url: 'https://arxiv.org/abs/2401.01234', status: 'noted' }],
 *     ['b', { id: 'b', url: 'https://arxiv.org/pdf/2401.01234', status: 'new' }],
 * ])
 * const docs = {
 *     select: async () => [...rows.values()],
 *     patch: async (id, fields) => { Object.assign(rows.get(id), fields) },
 * }
 * const recs = [{ id: 'b', url: 'https://arxiv.org/pdf/2401.01234', status: 'new' }]
 * console.log(await markSameContent({ deps: { stores: { docs } } }, recs), recs[0].status, rows.get('b').dupOf)
 * // => 1 skip a
 */
export async function markSameContent(ctx, recs) {
    const docs = ctx.deps.stores?.docs
    if (!recs.length || !docs) return 0
    // capture.standards.sameContent:false → 不判(零件庫用法之選項;補全文之兩個落 raw 入口同一判準)
    if (ctx.deps.settings?.capture?.standards?.sameContent === false) return 0
    const idx = await contentIndexOf(docs)
    let n = 0
    for (const rec of recs) {
        const material = rec.status === 'raw' ? String(rec.text || '') : null
        const same = matchSameContent(idx, { id: rec.id, urls: [rec.url], text: material })
        if (!same.hit) {
            idx.add(same.paraKeys ? { ...rec, paraKeys: same.paraKeys } : rec)
            if (same.paraKeys) {
                await docs.patch(rec.id, { paraKeys: same.paraKeys })
                rec.paraKeys = same.paraKeys
            }
            continue
        }
        await docs.patch(rec.id, sameContentPatch(same.hit, ctx.deps.clock?.iso8?.() || ''))
        rec.status = 'skip'
        n++
    }
    return n
}

/**
 * 三步一次走完(探測入庫用;輪抓走三環 mw 以保留掛載點)。
 *
 * @param {Array} rawItems 輸入抓取函數回傳值
 * @param {Object} o 輸入設定物件，需含 ctx(ctx.deps)；可含 source、fetcherId、fetcher、itemsPerSource、filter、toRecord
 * @param {Object} o.ctx 輸入管道脈絡(須含 ctx.deps)
 * @param {Object} [o.source] 輸入來源記錄
 * @param {String} [o.fetcherId] 輸入抓取器 id
 * @param {Object} [o.fetcher] 輸入抓取器 { id }(未給以 { id: fetcherId } 代)
 * @param {Integer} [o.itemsPerSource] 輸入每來源項目數上限
 * @param {Function} [o.filter] 輸入業務過濾函數,同 filterFeedItems
 * @param {Function} [o.toRecord] 輸入記錄組裝函數,同 admitFeedItems
 * @returns {Promise} 回傳 Promise，resolve 回傳 {items, invalid, dupInBatch, dropped, fresh, dup, unidentified, sameContent(CS10 改判 skip 之筆數)}
 * @throws {Error} o 非物件或缺 ctx(ctx.deps)時拋出
 * @example
 * import W from 'w-data-pipeline/src/WDataPipeline.mjs'
 * const rows = new Map()
 * const docs = {
 *     select: async () => [...rows.values()],
 *     insertNew: async (items) => {
 *         const added = items.filter((it) => !rows.has(it.id))
 *         added.forEach((it) => rows.set(it.id, { ...it }))
 *         return { added, addCount: added.length, dupCount: items.length - added.length }
 *     },
 *     patch: async (id, fields) => { Object.assign(rows.get(id), fields) },
 * }
 * const seen = W.createSeenStore({ collection: docs, identity: W.createIdentity({ keyOf: 'raw' }) })
 * const ctx = { deps: { settings: { capture: { sources: { itemsPerSource: 8 }, articles: { maxTextChars: 50 } } }, seen, clock: { iso8: () => '2026-09-01T00:00:00+08:00' }, stores: { docs } } }
 * const source = { id: 's1', name: '示範來源', kind: 'rss', tier: 3 }
 * const raw = [
 *     { url: 'https://example.com/post/3', title: '行星大氣' },
 *     { url: 'https://example.com/post/3', title: '行星大氣(重複)' },
 *     { url: 'https://example.com/post/4', title: '廣告' },
 *     { title: '沒有網址' },
 * ]
 * const r = await ingestFeedItems(raw, { ctx, source, fetcherId: 'rss', filter: (list) => list.filter((i) => i.title !== '廣告') })
 * console.log(r.fresh.map((x) => x.title), r.invalid.length, r.dupInBatch, r.dropped, r.dup, r.sameContent)
 * // => [ '行星大氣' ] 1 1 1 0 0
 */
export async function ingestFeedItems(rawItems, o) {

    //check
    checkCtxDeps('ingestFeedItems', o)

    const n = normalizeFeedItems(rawItems, o)
    const f = await filterFeedItems(n.items, o)
    const a = await admitFeedItems(f.kept, { ...o, fetcher: o.fetcher || { id: o.fetcherId } })
    return { items: f.kept, invalid: n.invalid, dupInBatch: n.dupInBatch, dropped: f.dropped, fresh: a.fresh, dup: a.dup, unidentified: a.invalid, sameContent: a.sameContent || 0 }
}

export default { normalizeFeedItems, filterFeedItems, admitFeedItems, markSameContent, ingestFeedItems }
