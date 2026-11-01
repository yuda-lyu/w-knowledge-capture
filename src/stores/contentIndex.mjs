// contentIndex.mjs — 檢定標準 CS10「同一內容只入庫一次」之索引(入庫、落盤 raw、符合度掃描共用之單一實作)
//
// 【兩種同一內容】①網址之正準代稱(MSN ar-ID、arXiv、DOI、SSRN、轉載 slug;docStandards.contentKeysOfUrl)相同;
//   ②跨文件段落雜湊重疊:新文件之段落(正規化後 ≥ PARA_MIN_CHARS 字)與「同一份」既有文件共享 ≥ PARA_SHARED_MIN 段,
//     且 ≥ 新文件段數之 PARA_SHARED_RATIO——轉載、聚合站換網址重發之同文(網址無正準代稱時之唯一判據)。數量判準,不以機率。
// 【段落雜湊落在文件記錄】paraKeys(≤ PARA_KEYS_MAX 個 12 碼雜湊)於落 raw 時寫入——正文落盤、feed 退路、grid 摘要入庫三個入口
//   (CS10「全部入口」;段落少之文字如 grid 摘要依共享門檻自然不比,不另立規則);索引自全部文件之 url／finalUrl／paraKeys 建立,
//   每行程每個 docs 集合建一次(WeakMap 快取),其後以 add() 增量維護。存量 noted 文件之 paraKeys 由抓取維護子階段以 docs 或 docTexts 之原文
//   補算(docMaintainStage mwFillParaKeys);人工匯入(無原文)不在此列。paraKeys 為陣列:集合之 patch 為深合併(陣列逐位置合併),
//   覆寫既有陣列前須先寫 null(否則新陣列較短時殘留舊尾)。
// 【判定之單一實作】matchSameContent(網址代稱＋段落重疊)與 sameContentPatch(skip 之欄位)供各入口共用:入庫(ingestGate.markSameContent;
//   含轉錄、探測)、正文落盤與 feed 退路(detailFetchStage)——同一規則不在各入口各寫一份。
// 【錨須已取得內容】被比中而據以判「同一內容」之既有文件(錨)須真的取得過內容(isContentAnchor):
//   new(尚未抓到)、dead(確定抓不到)、重複 skip(自身內容即他人之內容)不當錨。若不分狀態——
//   arXiv /pdf/ 一輪 dead 後,同篇 /abs/ 入庫即被判重複;瀏覽器救回之正文因轉址指向舊死件而丟棄;內容就此永遠拿不到。
//   同一代稱之多份文件依序保留,比對時取第一個合格之錨。狀態由 add() 增量更新(落 raw／dead、存量重判、補算段落鍵皆經 add 同步;
//   索引每行程建一次,其後之狀態以各入口之 add 為準)。

import { sha1 } from '../core/util/text.mjs'
import { contentKeysOfUrl } from '../standards/docStandards.mjs'

/**
 * 文件可否充當同一內容之錨:已取得過內容者(raw／noted／skip〔非重複〕／aggregated／summarize-failed 等);new、dead、重複 skip 不可
 *
 * @param {Object} d 輸入文件記錄(取 status、skipKind)
 * @returns {Boolean} 回傳是否可當錨
 * @example
 * console.log(isContentAnchor({ status: 'noted' }), isContentAnchor({ status: 'dead' }), isContentAnchor({ status: 'skip', skipKind: 'duplicate' }))
 * // => true false false
 */
export function isContentAnchor(d) {
    const st = String(d?.status || '')
    if (!st || st === 'new' || st === 'dead') return false
    if (st === 'skip' && d?.skipKind === 'duplicate') return false
    return true
}

/** 段落之最短字數(正規化後;太短之段落如署名、套語不具辨識力) */
export const PARA_MIN_CHARS = 60
/** 每篇至多記幾段之雜湊 */
export const PARA_KEYS_MAX = 40
/** 同一內容:與同一份既有文件共享之段數下限 */
export const PARA_SHARED_MIN = 3
/** 同一內容:共享段數占新文件段數之比例下限 */
export const PARA_SHARED_RATIO = 0.5

/**
 * 段落雜湊:以空行或換行切段 → NFKC、去空白、小寫 → ≥ PARA_MIN_CHARS 字者取 sha1 前 12 碼(去重、保序、至多 PARA_KEYS_MAX 個)
 *
 * @param {*} text 輸入正文
 * @returns {Array} 回傳雜湊陣列
 * @example
 * console.log(paraKeysOf('短句。').length)
 * // => 0
 */
export function paraKeysOf(text) {
    const out = []
    const seen = new Set()
    for (const p of String(text ?? '').split(/\n+/)) {
        const n = p.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
        if (n.length < PARA_MIN_CHARS) continue
        const k = sha1(n).slice(0, 12)
        if (seen.has(k)) continue
        seen.add(k)
        out.push(k)
        if (out.length >= PARA_KEYS_MAX) break
    }
    return out
}

/**
 * 段落重疊之判定:新文件之段落雜湊與某一份既有文件共享 ≥ PARA_SHARED_MIN 且 ≥ 段數 × PARA_SHARED_RATIO
 *
 * @param {Array} keys 輸入新文件之段落雜湊(非陣列視為空)
 * @param {Array} other 輸入既有文件之段落雜湊(非陣列視為空)
 * @returns {Integer} 回傳共享段數(未達同一內容者回 0)
 * @example
 * console.log(sharedParas(['a', 'b', 'c', 'd'], ['a', 'b', 'c']))
 * // => 3
 * console.log(sharedParas(['a', 'b', 'c', 'd'], ['a', 'b']))
 * // => 0
 */
export function sharedParas(keys, other) {
    const set = new Set(Array.isArray(other) ? other : [])
    const shared = (Array.isArray(keys) ? keys : []).filter((k) => set.has(k)).length
    return shared >= PARA_SHARED_MIN && shared >= Math.ceil(keys.length * PARA_SHARED_RATIO) ? shared : 0
}

const cache = new WeakMap()

/**
 * 取得(或建立)某 docs 集合之同一內容索引
 *
 * 建立失敗不留快取:被拒之 Promise 若留著,本行程之後每次取用皆拒(同一內容判定整段失效直到重啟);失敗即自快取移除,下次取用重建。
 *
 * @param {Object} docs 輸入 docs 集合(具 select 方法;同一集合物件於本行程只建一次)
 * @returns {Promise} 回傳 Promise，resolve 回傳 { matchUrl(url, selfId) → { key, id }|null, matchParas(keys, selfId) → { id, shared }|null, add(doc) }
 * @example
 * const docs = { select: async () => [{ id: 'a', url: 'https://arxiv.org/abs/2401.01234', status: 'noted' }] }
 * const idx = await contentIndexOf(docs)
 * console.log(idx.matchUrl('https://arxiv.org/pdf/2401.01234', 'b'))
 * // => { key: 'arxiv:2401.01234', id: 'a' }
 * console.log((await contentIndexOf(docs)) === idx)
 * // => true
 */
export async function contentIndexOf(docs) {
    if (!cache.has(docs)) {
        const p = (async () => buildIndex(await docs.select()))()
        cache.set(docs, p)
        p.catch(() => {
            if (cache.get(docs) === p) cache.delete(docs)
        })
    }
    return cache.get(docs)
}

/**
 * 某 docs 集合之索引若本行程已建則回傳(不觸發建立——維護環節更新段落鍵或狀態時同步之;未建者下次建立時即讀到最新記錄)
 *
 * @param {Object} docs 輸入 docs 集合(與 contentIndexOf 同一物件)
 * @returns {Promise|null} 回傳索引之 Promise,未建回 null
 * @example
 * const docs = { select: async () => [] }
 * console.log(contentIndexIfBuilt(docs))
 * // => null
 * await contentIndexOf(docs)
 * console.log(contentIndexIfBuilt(docs) !== null)
 * // => true
 */
export function contentIndexIfBuilt(docs) {
    return cache.has(docs) ? cache.get(docs) : null
}

/**
 * 自文件陣列建索引(純函數;contentIndexOf 之本體,符合度掃描亦用)
 *
 * add(d) 為增量更新(upsert):網址代稱只增不減(網址不變);`paraKeys` 欄位出現即取代該文件之段落雜湊(null／[] 即清除);
 * `status` 欄位出現即重算可否當錨(isContentAnchor),未給 status 之新文件視為可當錨(符合度掃描只餵 noted)。
 *
 * @param {Array} rows 輸入文件記錄(取 id、url、finalUrl、paraKeys、status、skipKind;非陣列視為空)
 * @returns {Object} 回傳索引物件 { add, matchUrl, matchParas }(見 contentIndexOf)
 * @example
 * const idx = buildIndex([{ id: 'a', url: 'https://arxiv.org/abs/2401.01234', status: 'noted' }])
 * console.log(idx.matchUrl('https://arxiv.org/pdf/2401.01234', 'b'))
 * // => { key: 'arxiv:2401.01234', id: 'a' }
 * idx.add({ id: 'a', status: 'dead' })
 * console.log(idx.matchUrl('https://arxiv.org/pdf/2401.01234', 'b'))
 * // => null
 */
export function buildIndex(rows) {
    const entries = new Map() // 文件 id → { keys:Set(網址代稱), paras:Array, anchor:Boolean }
    const byKey = new Map() // 網址代稱 → Array(文件 id,先到者在前)
    const byPara = new Map() // 段落雜湊 → Set(文件 id)
    const add = (d) => {
        if (!d?.id) return
        const id = d.id
        let e = entries.get(id)
        if (!e) {
            e = { keys: new Set(), paras: [], anchor: true }
            entries.set(id, e)
        }
        for (const k of [...contentKeysOfUrl(d.url), ...contentKeysOfUrl(d.finalUrl)]) {
            if (e.keys.has(k)) continue
            e.keys.add(k)
            if (!byKey.has(k)) byKey.set(k, [])
            byKey.get(k).push(id)
        }
        if (Object.hasOwn(d, 'paraKeys')) {
            for (const k of e.paras) byPara.get(k)?.delete(id)
            e.paras = Array.isArray(d.paraKeys) ? d.paraKeys : []
            for (const k of e.paras) {
                if (!byPara.has(k)) byPara.set(k, new Set())
                byPara.get(k).add(id)
            }
        }
        if (Object.hasOwn(d, 'status')) e.anchor = isContentAnchor(d)
    }
    const isAnchor = (id) => entries.get(id)?.anchor === true
    for (const d of Array.isArray(rows) ? rows : []) add(d)
    return {
        add,
        matchUrl: (url, selfId) => {
            for (const k of contentKeysOfUrl(url)) {
                for (const id of byKey.get(k) || []) if (id !== selfId && isAnchor(id)) return { key: k, id }
            }
            return null
        },
        matchParas: (keys, selfId) => {
            const cand = new Set()
            for (const k of Array.isArray(keys) ? keys : []) for (const id of byPara.get(k) || []) if (id !== selfId && isAnchor(id)) cand.add(id)
            let best = null
            for (const id of cand) {
                const shared = sharedParas(keys, entries.get(id)?.paras)
                if (shared && (!best || shared > best.shared)) best = { id, shared }
            }
            return best
        },
    }
}

/**
 * CS10 同一內容之判定(各入口共用之單一實作):先比網址正準代稱(urls 依序),未命中且給了正文 → 算段落雜湊並比段落重疊
 *
 * @param {Object} idx 輸入索引(contentIndexOf／buildIndex 之產物)
 * @param {Object} d 輸入 { id:文件 id(自身不算), urls:Array(要比代稱之網址;空字串略過), text:String(給了才算段落雜湊並比對) }
 * @returns {Object} 回傳 { paraKeys:Array|null(未給 text 為 null), hit:null|{ id, why, key?, shared? } }(why 為 skip 理由括號內之說明)
 * @example
 * const idx = buildIndex([{ id: 'a', url: 'https://arxiv.org/abs/2401.01234' }])
 * console.log(matchSameContent(idx, { id: 'b', urls: ['https://arxiv.org/pdf/2401.01234'] }).hit.why)
 * // => arxiv:2401.01234，文件 a
 */
export function matchSameContent(idx, d = {}) {
    for (const u of Array.isArray(d.urls) ? d.urls : []) {
        const h = u ? idx.matchUrl(u, d.id) : null
        if (h) return { paraKeys: d.text === undefined || d.text === null ? null : paraKeysOf(d.text), hit: { ...h, why: `${h.key}，文件 ${h.id}` } }
    }
    if (d.text === undefined || d.text === null) return { paraKeys: null, hit: null }
    const paraKeys = paraKeysOf(d.text)
    const p = idx.matchParas(paraKeys, d.id)
    return { paraKeys, hit: p ? { ...p, why: `段落重疊 ${p.shared}／${paraKeys.length}，文件 ${p.id}` } : null }
}

/**
 * CS10 同一內容 → skip 之欄位(各入口同一處置:記錄留作去重憑證、skipKind duplicate〔來源產出統計不計〕、不進 AI)
 *
 * @param {Object} hit 輸入 matchSameContent 之 hit(取 id、why)
 * @param {String} nowIso 輸入判定時刻(notedAt)
 * @returns {Object} 回傳 patch 欄位 { status:'skip', skipKind:'duplicate', dupOf(錨文件 id;結構化之代表關係,錨日後失效時可追查), skipReason, notedAt }
 *   (各入口另併其自身之欄位)
 * @example
 * console.log(sameContentPatch({ id: 'a', why: 'arxiv:2401.01234，文件 a' }, '2026-09-01T00:00:00Z'))
 * // => {
 * //   status: 'skip',
 * //   skipKind: 'duplicate',
 * //   dupOf: 'a',
 * //   skipReason: '與既有文件同一內容（arxiv:2401.01234，文件 a）（未進 AI）',
 * //   notedAt: '2026-09-01T00:00:00Z'
 * // }
 */
export function sameContentPatch(hit, nowIso) {
    return { status: 'skip', skipKind: 'duplicate', dupOf: String(hit?.id || ''), skipReason: `與既有文件同一內容（${hit?.why || ''}）（未進 AI）`, notedAt: String(nowIso || '') }
}

export default { PARA_MIN_CHARS, PARA_KEYS_MAX, PARA_SHARED_MIN, PARA_SHARED_RATIO, isContentAnchor, paraKeysOf, sharedParas, contentIndexOf, contentIndexIfBuilt, buildIndex, matchSameContent, sameContentPatch }
