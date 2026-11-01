// records.mjs — doc 記錄組裝的單一模組:來源 id、正準 doc 形狀、入庫路徑的 toRecord
//
// 【單一組裝點】doc 記錄由多條入庫路徑(輪抓 toRecord、轉錄 toLinkedRecord、探測入庫)產生;
//   欄位名與預設值若各寫一份而靠人肉對齊,正準 schema(套件契約欄位)一改就要改多處。
//   故只有 docRecord 一個形狀,各路徑只覆寫自己的差異欄位。
// 【id 由去重層決定】記錄不自算 id:seen.admit 一律以 identity(keyOf:'raw'＝sha1(canonicalUrl))覆寫 id,
//   這是去重能成立的前提;探測入庫亦走同一閘門(stores/ingestGate),不自算 sha1。管線外登記之文件(下游之人工匯入)經 externalDocOf,
//   以總組裝之同一身分算 id——下游自算 sha1(網址)者,安裝方給 cfg.dedup 時即與管線之 id 不一致,同一網址日後被抓取再收一次。

import isobj from 'wsemi/src/isobj.mjs'
import { sha1 } from './text.mjs'
import { normalizeUrl, unwrapNewsUrl } from './web.mjs'

/**
 * 去重身分之預設設定(w-data-pipeline createIdentity 之 spec;總組裝於安裝方未給 cfg.dedup 時用之)
 *
 * @type {Object}
 */
export const DEFAULT_DEDUP = Object.freeze({ keyOf: 'raw' })

/**
 * 來源去重鍵:依 kind 與正規化後 url 算出 SHA-1(來源清單與轉錄來源之 id 皆由此決定;見檔頭【id 由去重層決定】)
 *
 * kind／url 非字串時 fail-safe(樣板字串化後照樣雜湊,不拋錯)——與 sha1／normalizeUrl 之容錯語意一致。
 *
 * @param {String} kind 輸入來源種類字串(如 'rss'、'grid')
 * @param {String} url 輸入來源網址字串(經 normalizeUrl 正規化後才雜湊)
 * @returns {String} 回傳 SHA-1 十六進位字串
 * @example
 * console.log(sourceId('rss', 'https://e.com/feed?utm_source=x'))
 * // => 8c6915c8580b776455f5d25c70686284e30b1a5f
 */
export function sourceId(kind, url) {
    return sha1(`${kind}|${normalizeUrl(url)}`)
}

/** 自動擴充所得來源之 origin 前綴(其後為「線索型別:線索值」) */
const AUTO_ORIGIN_PREFIX = 'frontier:'

/**
 * 自動擴充所得來源之 origin(寫入之唯一格式;stages/expandStage 由線索探測登錄來源時用之)
 *
 * @param {String} type 輸入線索型別('keyword'／'topic'／'site')
 * @param {String} value 輸入線索值
 * @returns {String} 回傳 origin 字串
 * @example
 * console.log(autoSourceOrigin('site', 'https://e.com'))
 * // => frontier:site:https://e.com
 */
export function autoSourceOrigin(type, value) {
    return `${AUTO_ORIGIN_PREFIX}${String(type ?? '')}:${String(value ?? '')}`
}

/**
 * 來源之來歷(讀 origin 之唯一解讀;自動來源之預設判定 capture.sources.isAutoSource、維運之統計與列示同用):
 *   自動擴充所得者 → { auto:true, via:線索型別 };其餘(種子 'seed' 等)→ { auto:false, via:origin 原值 }
 *
 * @param {Object} src 輸入來源記錄(取 origin)
 * @returns {Object} 回傳 { auto:Boolean, via:String }
 * @example
 * console.log(sourceOriginOf({ origin: 'frontier:keyword:momentum' }), sourceOriginOf({ origin: 'seed' }))
 * // => { auto: true, via: 'keyword' } { auto: false, via: 'seed' }
 */
export function sourceOriginOf(src) {
    const o = String(src?.origin || '')
    return o.startsWith(AUTO_ORIGIN_PREFIX) ? { auto: true, via: o.slice(AUTO_ORIGIN_PREFIX.length).split(':')[0] } : { auto: false, via: o }
}

/**
 * doc 記錄之正準形狀:所有入庫路徑由此出發,再各自覆寫差異欄位(見檔頭【單一組裝點】)。
 *
 * @param {Object} fields 輸入來源欄位物件，含 url、title、publishedAt、author、feedText(皆選填，缺者以空字串填入)；kind、fetcher(選填，項目宣告之補全文路由，非空才寫入)
 * @param {Object} src 輸入來源記錄物件，含 id、name、tier、lang(id／name 直接採用，tier 缺省 2，lang 缺省'')
 * @param {Object} [opt={}] 輸入設定物件，非物件視為{}
 * @param {String} [opt.nowIso=''] 輸入現在時刻 ISO 字串，作為 collectedAt
 * @param {Integer} [opt.maxTextChars=20000] 輸入 feedText 保留字數上限
 * @returns {Object} 回傳正準 doc 記錄物件
 * @throws {Error} fields 或 src 非物件時拋出
 * @example
 * const r = docRecord({ url: 'https://e.com/a', title: 'T' }, { id: 's1', name: 'S' }, { nowIso: '2026-09-23T00:00:00+08:00' })
 * console.log(r.url, r.title, r.sourceId, r.status, r.collectedAt)
 * // => https://e.com/a T s1 new 2026-09-23T00:00:00+08:00
 */
export function docRecord(fields, src, opt = {}) {

    //check
    if (!isobj(fields) || !isobj(src)) {
        throw new Error('docRecord 需要 fields 與 src 物件')
    }
    if (!isobj(opt)) {
        opt = {}
    }

    const feedFull = String(fields.feedText || '')
    const feedMax = opt.maxTextChars ?? 20_000
    return {
        url: fields.url,
        title: fields.title || '',
        publishedAt: fields.publishedAt || '',
        author: fields.author || '',
        feedText: feedFull.slice(0, feedMax),
        // 截斷前之 feed 原長(只在被截時記;feed 退路據此寫 fullLength——寫截後長度會讓下游之截斷明示報錯數字)
        ...(feedFull.length > feedMax ? { feedFullLength: feedFull.length } : {}),
        sourceId: src.id,
        sourceName: src.name,
        sourceTier: src.tier || 2,
        lang: src.lang || '',
        collectedAt: opt.nowIso || '',
        status: 'new',
        fetchTries: 0,
        text: '',
        textLength: 0,
        // 項目宣告之補全文路由(w-data-pipeline itemContract 保留 kind／fetcher 供指名 detail 抓取器;不於此帶入,
        //   安裝方之 list 抓取器宣告 fetcher 即失效而改走預設 article)
        ...(fields.kind ? { kind: String(fields.kind) } : {}),
        ...(fields.fetcher ? { fetcher: String(fields.fetcher) } : {}),
    }
}

/**
 * 管線外登記之文件記錄(如下游人工／代理匯入之筆記之來源):與管線同一身分、同一記錄形狀(docRecord)——日後抓取到同一網址即判已收。
 *   url 為正準網址(解轉址＋正規化,與身分同一組函數);id 由去重身分算(identity.of;安裝方之 cfg.dedup 生效),不自算 sha1(檔頭)
 *
 * @param {Object} identity 輸入去重身分(總組裝之 info().identity;w-data-pipeline createIdentity 之產物,具 of 方法)
 * @param {Object} fields 輸入 { url, title?, publishedAt? }
 * @param {Object} [src={}] 輸入來源 { id?, name?, tier? }
 * @param {Object} [opt={}] 輸入 { nowIso }
 * @returns {Object|null} 回傳 doc 記錄(含 id;status 'new'——終態由呼叫端依其轉移覆寫);網址非 http(s) 或身分算不出 id → null
 * @throws {Error} identity 缺 of 方法時拋出
 * @example
 * need test in nodejs.
 *
 * const rec = externalDocOf(flow.info().identity, { url: 'https://e.com/a?utm_source=x', title: 'T' }, { name: '手動抓取', tier: 1 }, { nowIso })
 * console.log(rec.url, rec.id === seen.idOf('https://e.com/a'))
 * // => https://e.com/a true
 */
export function externalDocOf(identity, fields, src = {}, opt = {}) {
    if (typeof identity?.of !== 'function') throw new Error('externalDocOf 需要 identity(去重身分,具 of 方法;總組裝之 info().identity)')
    const url = normalizeUrl(unwrapNewsUrl(fields?.url))
    if (!/^https?:\/\//.test(url)) return null
    const id = identity.of(url)
    if (!id) return null
    const s = isobj(src) ? src : {}
    return { ...docRecord({ url, title: fields.title, publishedAt: fields.publishedAt }, { id: s.id || '', name: s.name || '', tier: s.tier }, opt), id }
}

/** 文件內文取得方式(textFrom)之顯示名:feed 退路與學術摘要另標,其餘(全文抓取器、站台 adapter、瀏覽器)皆為原網頁全文 */
const TEXT_FROM_LABELS = Object.freeze({ feed: 'feed 內嵌內文', abstract: '論文摘要（abstract）' })

/**
 * 文件內文取得方式之顯示名(下游於其產物——如筆記之來源章——標示內文出處時用;textFrom 之值域由本套件之抓取器決定,下游不自解讀)
 *
 * @param {*} textFrom 輸入文件之 textFrom(如 'feed'、'abstract'、'article'、'adapter:<id>')
 * @returns {String} 回傳顯示名:feed → 「feed 內嵌內文」、abstract → 「論文摘要（abstract）」、其餘 → 「原網頁全文」
 * @example
 * console.log(textFromLabelOf('feed'), textFromLabelOf('adapter:x'))
 * // => feed 內嵌內文 原網頁全文
 */
export function textFromLabelOf(textFrom) {
    return Object.hasOwn(TEXT_FROM_LABELS, String(textFrom)) ? TEXT_FROM_LABELS[textFrom] : '原網頁全文'
}

/**
 * 內建 toRecord 工廠(輪抓與探測入庫共用):契約層項目 → doc;grid 摘要即素材直入 raw(DOI 多付費牆)
 *
 * @param {Object} deps 輸入依賴物件，需含 settings(取 settings.capture.articles.maxTextChars)、clock(取 clock.iso8())
 * @returns {Function} 回傳 toRecord(it, meta) 函數:it 為契約層項目、meta.source 為來源記錄，回傳正準 doc 記錄(grid 來源另補 status／text／textLength／textFrom／rawAt)
 * @example
 * let deps = { settings: { capture: { articles: { maxTextChars: 20000 } } }, clock: { iso8: () => '2026-09-23T00:00:00+08:00' } }
 * let toRecord = defaultToRecord(deps)
 * let rec = toRecord({ url: 'https://example.com/post/1', title: '黑洞光譜', time: '2026-09-01' }, { source: { id: 's1', name: '天文快訊', kind: 'rss' } })
 * console.log(rec.url, rec.title, rec.sourceId, rec.status)
 * // => https://example.com/post/1 黑洞光譜 s1 new
 *
 * let recGrid = toRecord({ url: 'https://example.com/paper/1', title: '星系演化', summary: '摘要文字' }, { source: { id: 's2', name: '論文庫', kind: 'grid' } })
 * console.log(recGrid.status, recGrid.textFrom, recGrid.textLength)
 * // => raw abstract 4
 */
export const defaultToRecord = ({ settings, clock }) => (it, meta) => {
    const s = meta.source
    const rec = docRecord(
        { url: it.canonicalUrl || it.url, title: it.title, publishedAt: it.time, author: it.author, feedText: it.text || it.summary, kind: it.kind, fetcher: it.fetcher },
        s, { nowIso: clock.iso8(), maxTextChars: settings.capture.articles.maxTextChars },
    )
    // 摘要即素材,直入 raw;rawAt＝進入 raw 之時刻(raw 池等待時間據此量);fullLength＝抓取器截 4,000 字前之摘要原長(extra.fullLength)
    if (s.kind === 'grid') Object.assign(rec, { status: 'raw', text: rec.feedText, textLength: rec.feedText.length, textFrom: 'abstract', rawAt: rec.collectedAt, fullLength: Number(it.extra?.fullLength) > 0 ? Number(it.extra.fullLength) : rec.feedText.length })
    return rec
}

/**
 * 內建轉錄記錄組裝工廠:sourceId 不可沿用母來源,否則真文章下輪又被拆成連結
 *
 * @param {Object} deps 輸入依賴物件，需含 clock(取 clock.iso8())
 * @returns {Function} 回傳組裝函數(l, mother):l 為轉錄連結{url,text}、mother 為母文件記錄，回傳正準 doc 記錄並附 fromDocId
 * @example
 * let toLinked = defaultToLinkedRecord({ clock: { iso8: () => '2026-09-23T00:00:00+08:00' } })
 * let mother = { id: 'd1', sourceId: 's1', sourceName: '天文快訊', sourceTier: 1, publishedAt: '2026-09-01' }
 * let l = toLinked({ url: 'https://example.com/post/2?utm_source=x', text: '全文連結' }, mother)
 * console.log(l.url, l.title, l.sourceId, l.sourceName, l.fromDocId)
 * // => https://example.com/post/2 全文連結 s1:linked 天文快訊（轉錄） d1
 */
export const defaultToLinkedRecord = ({ clock }) => (l, mother) => ({
    ...docRecord(
        { url: normalizeUrl(l.url), title: l.text, publishedAt: mother.publishedAt },
        { id: `${mother.sourceId}:linked`, name: `${mother.sourceName}（轉錄）`, tier: mother.sourceTier || 2, lang: mother.lang || '' },
        { nowIso: clock.iso8() },
    ),
    fromDocId: mother.id,
})

export default { DEFAULT_DEDUP, sourceId, autoSourceOrigin, sourceOriginOf, docRecord, externalDocOf, textFromLabelOf, defaultToRecord, defaultToLinkedRecord }
