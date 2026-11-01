// docTexts.mjs — 文件原文另存:檢定標準之回溯材料(下游產物之數字紮根、忠實性、相關性於標準調整時須以原文重檢)與取得物之保存
//
// 【為何另立集合,不留在 docs】docs 之 select 一律全表讀(w-orm-lmdb getRange 後才過濾),每輪呼叫多次;終態瘦身(docPolicy)
//   就是為了不讓原文拖慢它。另存於以 docId 為鍵之集合、只用主鍵直讀 get,不進任何 select。
// 【何時存】①落 raw 當下(正文落盤、feed 退路;此後 raw → dead 之存量重判、素材退回再死亦有材料可查);
//   ②內容類判死(付費牆、頁面自述找不到、軟 404、錯頁、存量重判判死)存其判定依據;③終態瘦身清空 docs 原文之前(回讀一致才清;
//   存不成即不清,不丟材料,下輪再試)。
// 【存什麼】兩層材料(去重後之正文不是「未處理的原文」):
//   - gz／feedGz:庫內形態(去重＋截斷 maxTextChars 後之正文;feed 摘要)——下游當時送 AI 之材料即此,
//     下游之檢定(如數字紮根)之材料讀它(docTextOf.text);
//   - rawGz:同一次取得之**去重與截斷前**之解析全文(取得物;與庫內形態不同時才存),rawFrom 記取得方式。HTML 原始碼不存
//     (w-fetch-web 解析模式不回傳)。
//   另記取得方式、狀態、原長、雜湊(sha1＝庫內形態之雜湊、rawSha1)。
// 【範圍】瘦身另存:noted(已據以產出筆記者之來源)、skip(非知識判定之回溯)、summarize-failed(重開時之材料);dead 只在有判定依據時由判死處另存,
//   aggregated 不存。
// 【完整性】同雜湊即略過之前須解壓回驗(壞壓縮回空字串仍被當「已存」,瘦身即清掉最後一份可讀材料);
//   docTextOf 遇壞檔回 null(視同無原文)。

import zlib from 'zlib'
import isobj from 'wsemi/src/isobj.mjs'
import isfun from 'wsemi/src/isfun.mjs'
// 另存之雜湊判「內容是否變了」:取內容雜湊(不取身分雜湊 sha1——語意與空輸入之處置不同,見 util/text 檔頭)
import { contentSha1 as sha1 } from '../util/text.mjs'

/**
 * 預設另存原文之終態(瘦身另存的範圍:noted、skip、summarize-failed)
 *
 * @type {Array}
 */
export const DOC_TEXT_STATUSES = ['noted', 'skip', 'summarize-failed']

/**
 * 壓縮文字(gzip → base64)
 *
 * @param {*} text 輸入文字,null／undefined 視為空字串,其餘轉字串後壓縮
 * @returns {String} 回傳壓縮後字串(gzip 後以 base64 編碼);輸入為空字串時回傳''
 * @example
 * let gz = packText('黑洞光譜')
 * console.log(typeof gz, unpackText(gz), JSON.stringify(packText('')))
 * // => string 黑洞光譜 ""
 */
export function packText(text) {
    const s = String(text ?? '')
    return s ? zlib.gzipSync(Buffer.from(s, 'utf8')).toString('base64') : ''
}

/**
 * 解壓文字
 *
 * @param {*} gz 輸入 packText 之結果(base64 之 gzip 字串)
 * @returns {String} 回傳原文字;輸入為空或壞資料時回傳''(要區分兩者改用 unpackTextStrict)
 * @example
 * console.log(unpackText(packText('黑洞光譜')), JSON.stringify(unpackText('不是壓縮')))
 * // => 黑洞光譜 ""
 */
export function unpackText(gz) {
    const s = unpackTextStrict(gz)
    return s === null ? '' : s
}

/**
 * 解壓文字(嚴格):壞資料回 null,與「本來就空」區分
 *
 * @param {*} gz 輸入 packText 之結果
 * @returns {String|null} 回傳原文字;空輸入回 '';壞資料回 null
 * @example
 * console.log(unpackTextStrict(packText('甲')), unpackTextStrict(''), unpackTextStrict('不是壓縮'))
 * // => 甲  null
 */
export function unpackTextStrict(gz) {
    if (!gz) return ''
    try {
        return zlib.gunzipSync(Buffer.from(String(gz), 'base64')).toString('utf8')
    }
    catch {
        return null
    }
}

/**
 * 另存記錄之內容是否完整可讀:各壓縮欄皆能解壓(gzip 自帶 CRC32,資料損毀即解壓失敗;雜湊欄不另驗——是否為「同一份」由 archiveDocText 比對內容)
 *
 * @param {Object} a 輸入另存記錄(取 gz、feedGz、rawGz 三個壓縮欄;空欄視為完整)
 * @returns {Boolean} 回傳是否完整;非物件、任一壓縮欄損毀者為 false
 * @example
 * console.log(archiveIntact({ gz: packText('甲'), feedGz: '', rawGz: '' }), archiveIntact({ gz: '不是壓縮' }), archiveIntact(null))
 * // => true false false
 */
export function archiveIntact(a) {
    if (!isobj(a)) return false
    return unpackTextStrict(a.gz) !== null && unpackTextStrict(a.feedGz) !== null && unpackTextStrict(a.rawGz) !== null
}

/**
 * 另存一篇文件之原文(庫內形態雜湊相同、內容回驗完整、且取得物未變則不重寫);寫後回讀比對
 *
 * @param {Object} archive 輸入 docTexts 集合(需 get／replace)
 * @param {Object} doc 輸入文件記錄(取 id、text、feedText、textFrom、status、fullLength、title、url)
 * @param {String} nowIso 輸入另存時刻(寫入記錄之 archivedAt)
 * @param {Object} [o={}] 輸入設定物件,非物件則回退為 {}
 * @param {String} [o.raw] 輸入同一次取得之去重與截斷前全文(給了即一併存;與庫內形態相同則不另存;未給 → 庫內形態未變者保留既有之 rawGz,
 *   已變者清掉——那是另一次取得之物)
 * @param {String} [o.rawFrom] 輸入取得方式(article／browser:<方法>／adapter:<id>／feed)
 * @returns {Promise} 回傳 Promise,resolve 回傳 { ok:Boolean, same?:Boolean(已存且內容相同而略過), reason?:String(ok 為 false 時之原因:缺文件 id／無原文／回讀不符) }
 * @throws {Error} archive 缺 get／replace 方法時拋出
 * @example
 * let saved = new Map()
 * let archive = { get: async (id) => saved.get(id) ?? null, replace: async (rec) => { saved.set(rec.id, rec) } }
 * let doc = { id: 'd1', text: '黑洞光譜觀測', status: 'noted', url: 'https://example.com/post/1' }
 * console.log(await archiveDocText(archive, doc, '2026-09-01T00:00:00Z'), await archiveDocText(archive, doc, '2026-09-02T00:00:00Z'), await archiveDocText(archive, { id: 'd2' }, '2026-09-01T00:00:00Z'))
 * // => { ok: true } { ok: true, same: true } { ok: false, reason: '無原文' }
 */
export async function archiveDocText(archive, doc, nowIso, o = {}) {
    if (!isfun(archive?.get) || !isfun(archive?.replace)) throw new Error('archiveDocText 需要 docTexts 集合(具 get／replace 方法)')
    if (!isobj(doc) || !doc.id) return { ok: false, reason: '缺文件 id' }
    if (!isobj(o)) o = {}
    const text = String(doc.text ?? '')
    const feed = String(doc.feedText ?? '')
    if (!text && !feed) return { ok: false, reason: '無原文' }
    const hash = sha1(`${text}\u0000${feed}`)
    const rawGiven = typeof o.raw === 'string'
    const raw = rawGiven && o.raw !== text ? o.raw : ''
    const cur = await archive.get(doc.id)
    // 既有者「同一份」:雜湊相同且解壓後內容逐字相同(只比雜湊時,壞壓縮會被當已存而清掉最後一份可讀材料)
    const curSame = !!cur && cur.sha1 === hash && archiveIntact(cur) && unpackTextStrict(cur.gz) === text && unpackTextStrict(cur.feedGz) === feed
    if (curSame && (!rawGiven || (cur.rawSha1 || '') === (raw ? sha1(raw) : ''))) return { ok: true, same: true }
    // 取得物:給了即用;未給而庫內形態未變(同一次取得)→ 保留既有者;否則清掉(屬另一次取得)
    const keepRaw = !rawGiven && curSame
    const rec = {
        id: doc.id, gz: packText(text), feedGz: packText(feed), chars: text.length, feedChars: feed.length,
        textFrom: String(doc.textFrom || ''), status: String(doc.status || ''), fullLength: Number(doc.fullLength) || text.length,
        title: String(doc.title || ''), url: String(doc.url || ''), sha1: hash, archivedAt: String(nowIso || ''),
        rawGz: keepRaw ? String(cur.rawGz || '') : packText(raw),
        rawSha1: keepRaw ? String(cur.rawSha1 || '') : (raw ? sha1(raw) : ''),
        rawChars: keepRaw ? Number(cur.rawChars) || 0 : raw.length,
        rawFrom: keepRaw ? String(cur.rawFrom || '') : (raw ? String(o.rawFrom || doc.textFrom || '') : ''),
    }
    await archive.replace(rec)
    const back = await archive.get(doc.id)
    if (!back || back.sha1 !== hash || unpackTextStrict(back.gz) !== text || unpackTextStrict(back.feedGz) !== feed || !archiveIntact(back)) return { ok: false, reason: '回讀不符' }
    return { ok: true }
}

/**
 * 取得方式為「今日之頁面」者(原文回溯之網頁重取 refetch:article;ops/refetchSources):不能證明為下游當時處理之材料
 *   (頁面會改版)。API 依編號／題名重取者(refetch:arxiv／refetch:openalex)為同一記錄,不在此列
 */
const CURRENT_PAGE_FROM = /^refetch:article/

/**
 * 取一篇文件之原文(庫內形態):docs 尚未瘦身者直取,已瘦身者取另存;皆無回 null(另存壞檔亦視同無)。
 *   currentPage:取得方式之語意由本套件判(CURRENT_PAGE_FROM)——下游據以決定可否作為其當時之材料,不自解讀 textFrom
 *
 * @param {Object} stores 輸入集合物件(需 docs;docTexts 選填;各具 get 方法)
 * @param {String} docId 輸入文件 id
 * @returns {Promise} 回傳 Promise,resolve 回傳 { text, feedText, textFrom, title, url, from:'docs'|'archive', currentPage:Boolean } 或 null
 * @example
 * let saved = new Map()
 * let docTexts = { get: async (id) => saved.get(id) ?? null, replace: async (rec) => { saved.set(rec.id, rec) } }
 * await archiveDocText(docTexts, { id: 'd1', text: '黑洞光譜觀測', title: '黑洞光譜', url: 'https://example.com/post/1', status: 'noted', textFrom: 'article' }, '2026-09-01T00:00:00Z')
 * let docs = { get: async () => ({ id: 'd1', text: '', feedText: '' }) } //已瘦身
 * let r = await docTextOf({ docs, docTexts }, 'd1')
 * console.log(r.text, r.from, r.currentPage, await docTextOf({ docs }, 'd1'))
 * // => 黑洞光譜觀測 archive false null
 */
export async function docTextOf(stores, docId) {
    const d = await stores?.docs?.get?.(docId)
    if (d && (d.text || d.feedText)) return { text: String(d.text || ''), feedText: String(d.feedText || ''), textFrom: d.textFrom || '', title: d.title || '', url: d.url || '', from: 'docs', currentPage: CURRENT_PAGE_FROM.test(String(d.textFrom || '')) }
    const a = isfun(stores?.docTexts?.get) ? await stores.docTexts.get(docId) : null
    if (!a || !archiveIntact(a)) return null
    const text = unpackText(a.gz)
    const feedText = unpackText(a.feedGz)
    if (!text && !feedText) return null
    return { text, feedText, textFrom: a.textFrom || '', title: a.title || d?.title || '', url: a.url || d?.url || '', from: 'archive', currentPage: CURRENT_PAGE_FROM.test(String(a.textFrom || '')) }
}

/**
 * 回填文件之素材欄位(docs 已瘦身而原文在另存者;下游重開、重處理前用):docTextOf 之結果 → docs.patch 之欄位。
 *   素材欄位之組成由本套件定(text、feedText),下游不自列
 *
 * @param {Object} src 輸入 docTextOf 之結果
 * @returns {Object} 回傳 from 'archive' → { text, feedText };其餘(docs 仍有原文、無原文)→ {}
 * @example
 * console.log(docTextRestoreOf({ text: '甲', feedText: '', from: 'archive' }), docTextRestoreOf({ text: '甲', from: 'docs' }))
 * // => { text: '甲', feedText: '' } {}
 */
export function docTextRestoreOf(src) {
    return src?.from === 'archive' ? { text: String(src.text || ''), feedText: String(src.feedText || '') } : {}
}

/**
 * 取一篇文件之另存全貌(含取得物 raw;剔除清單、回溯稽核用)
 *
 * @param {Object} stores 輸入集合物件(需 docTexts,具 get 方法)
 * @param {String} docId 輸入文件 id
 * @returns {Promise} 回傳 Promise,resolve 回傳 { text, feedText, raw(去重與截斷前之取得物;與 text 相同者為 ''), rawFrom, status, textFrom, archivedAt } 或 null(無或壞檔)
 * @example
 * let saved = new Map()
 * let docTexts = { get: async (id) => saved.get(id) ?? null, replace: async (rec) => { saved.set(rec.id, rec) } }
 * await archiveDocText(docTexts, { id: 'd1', text: '黑洞光譜觀測', status: 'noted', textFrom: 'article' }, '2026-09-01T00:00:00Z', { raw: '黑洞光譜觀測(含重複段)', rawFrom: 'article' })
 * let r = await docArchiveOf({ docTexts }, 'd1')
 * console.log(r.text, r.raw, r.rawFrom, r.archivedAt, await docArchiveOf({ docTexts }, 'dx'))
 * // => 黑洞光譜觀測 黑洞光譜觀測(含重複段) article 2026-09-01T00:00:00Z null
 */
export async function docArchiveOf(stores, docId) {
    const a = isfun(stores?.docTexts?.get) ? await stores.docTexts.get(docId) : null
    if (!a || !archiveIntact(a)) return null
    return { text: unpackText(a.gz), feedText: unpackText(a.feedGz), raw: unpackText(a.rawGz), rawFrom: String(a.rawFrom || ''), status: String(a.status || ''), textFrom: String(a.textFrom || ''), archivedAt: String(a.archivedAt || '') }
}

export default { DOC_TEXT_STATUSES, packText, unpackText, unpackTextStrict, archiveIntact, archiveDocText, docTextOf, docTextRestoreOf, docArchiveOf }
