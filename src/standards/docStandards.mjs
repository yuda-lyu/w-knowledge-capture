// docStandards.mjs — 抓取之檢定標準(文件):純函數,新進守門與符合度掃描共用
//
// 【標準】
//   CS2 記錄標題與正文相符(錯頁):標題與正文同文字系統、標題詞 ≥4 而在正文前 6,000 字之覆蓋＝0 → 不符;
//       覆蓋 >0 者不判(翻譯標題、縮寫、錨文字等低覆蓋可為合格——判準只收「確定錯頁」);標題詞不足或文字系統不同 → 不適用
//   CS10 同一內容只入庫一次:同一站點正準編號(MSN ar-、arXiv、DOI、SSRN abstract_id)或同一主機之網址代稱(路徑末段 ≥5 詞之 slug,
//       去數字尾碼;限同主機)之文件視為同一內容;段落雜湊之跨文件比對另見 stores/contentIndex(跨站轉載由此判)
//   CS12 領域標籤與線索值正體(core/standards/textForms;appliesTo 字形政策 zh-Hant-TW——語言設定非繁體中文時掃描列不適用,core/locale)
// 【能證明／不能證明】CS10 之網址代稱只證明「同一篇轉載」;改寫轉載(內容相同而網址不同)須段落雜湊。

import isarr from 'wsemi/src/isarr.mjs'
import { STATUS, result } from '../core/standards/verdict.mjs'
import { CONTENT_GATE_V } from '../stores/contentGate.mjs'

/**
 * 文件類檢定標準之登錄表:依序為 CS1a(正文健全)、CS2(標題與正文相符)、CS10(同一內容只入庫一次)、CS12(領域標籤與線索值正體)
 *
 * 每筆 { id:標準代號, title:標準名稱, kind:'program'(程式判定), v:判定版本號, appliesTo?:Array(適用之字形政策;未給即不限) }。
 * 判定改版時遞增 v,存量即可依版重判;CS1a 之 v 取健全閘版本號。
 *
 * @type {Array<Object>}
 */
export const DOC_STANDARDS = [
    // CS1a:raw 存量依現版健全閘(stores/healthRecheck;入口別套閘);版本＝閘版本號(CONTENT_GATE_V;安裝方參數之簽章另見 gateVersionOf)
    { id: 'CS1a', title: '正文健全(raw 依現版健全閘)', kind: 'program', v: CONTENT_GATE_V },
    // CS2 v2:標題之漢字二字組改為逐段切(v1 串接全部漢字段後才切,跨空白／標點之相鄰詞產生標題中不存在之二字組,虛增「標題詞 ≥4」之門檻)
    { id: 'CS2', title: '記錄標題與正文相符(錯頁)', kind: 'program', v: 2 },
    // CS10:slug 代稱限同主機;錨須已取得內容(contentIndex.isContentAnchor)
    { id: 'CS10', title: '同一內容只入庫一次', kind: 'program', v: 2 },
    // CS12:只適用於臺灣正體之字形政策(語言設定 zh-TW／zh-Hant／zh-Hant-TW);其他語言之掃描逐件列不適用
    { id: 'CS12', title: '領域標籤與線索值正體', kind: 'program', v: 1, appliesTo: ['zh-Hant-TW'] },
]

const STOP = new Set(['about', 'after', 'again', 'also', 'among', 'been', 'before', 'being', 'between', 'both', 'could', 'does', 'during', 'each', 'from', 'have', 'into', 'more', 'most', 'other', 'over', 'same', 'should', 'some', 'such', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under', 'very', 'what', 'when', 'where', 'which', 'while', 'will', 'with', 'would', 'your'])

/**
 * 標題之比對詞:拉丁詞(≥4 字母、去虛詞)與中日韓二字組
 *
 * 二字組只在同一段連續漢字內切:跨空白、標點或其他文字系統之相鄰字不成詞(「恆星 光譜」不產生「星光」)——
 * 跨段之二字組不存在於標題,只會虛增詞數(使不足 4 詞而應判不適用者被判)並以巧合命中改變覆蓋。單字段不成詞
 *
 * @param {*} title 輸入標題
 * @returns {Object} 回傳 { latin:Array, cjk:Array }
 * @example
 * console.log(titleTokens('恆星 光譜 分析').cjk)
 * // => [ '恆星', '光譜', '分析' ]
 */
export function titleTokens(title) {
    const s = String(title ?? '').normalize('NFKC').toLowerCase()
    const latin = [...new Set((s.match(/[a-z]{4,}/g) || []).filter((w) => !STOP.has(w)))]
    const cjk = []
    for (const run of s.match(/\p{Script=Han}+/gu) || []) {
        for (let i = 0; i < run.length - 1; i++) cjk.push(run.slice(i, i + 2))
    }
    return { latin, cjk: [...new Set(cjk)] }
}

/**
 * CS2:記錄標題與正文是否確定不符(錯頁)
 *
 * 標題與正文須同文字系統、標題詞 ≥4 才判;標題詞在正文前 6,000 字之覆蓋為 0 才判不符,覆蓋 >0 一律合格;條件不足回不適用。
 *
 * @param {*} title 輸入記錄標題(入口給的標題,不是抓回頁面自己的標題)
 * @param {*} text 輸入正文
 * @returns {Object} 回傳判定結果 { std:'CS2', status:'pass'|'violation'|'na', detail:String, field:String }
 * @example
 * const text = '恆星光譜分析是天文學研究恆星組成的基本方法,透過光譜線可以推算恆星的溫度與化學成分。'.repeat(5)
 * const r = checkTitleBody('海洋生物 珊瑚礁 生態系統 保育', text)
 * console.log(r.status, r.detail)
 * // => violation 標題詞 9 個皆不見於正文
 */
export function checkTitleBody(title, text) {
    const t = titleTokens(title)
    const body = String(text ?? '').normalize('NFKC').toLowerCase().slice(0, 6000)
    const bodyHan = (body.match(/\p{Script=Han}/gu) || []).length
    const bodyLatin = (body.match(/[a-z]/g) || []).length
    // 依標題之文字系統取詞;正文須有同文字系統之內容才判(英文標題配中文正文等不判)
    const useCjk = t.cjk.length >= t.latin.length
    const words = useCjk ? t.cjk : t.latin
    if (words.length < 4) return result('CS2', STATUS.NA, `標題詞 ${words.length} 個(須 ≥4)`)
    if (useCjk ? bodyHan < 50 : bodyLatin < 200) return result('CS2', STATUS.NA, '正文與標題文字系統不同')
    const hit = words.filter((w) => body.includes(w)).length
    return hit === 0 ? result('CS2', STATUS.VIOLATION, `標題詞 ${words.length} 個皆不見於正文`) : result('CS2', STATUS.PASS, `覆蓋 ${hit}/${words.length}`)
}

/**
 * 網址之同一內容代稱(CS10):站點正準編號與轉載 slug
 *
 * @param {*} url 輸入網址(非合法網址回空陣列)
 * @returns {Array} 回傳代稱字串陣列(無則空陣列),形如 'arxiv:2401.01234'、'msn:…'、'doi:…'、'ssrn:…'、'slug:主機/詞-詞-…'
 * @example
 * console.log(contentKeysOfUrl('https://arxiv.org/abs/2401.01234'))
 * // => [ 'arxiv:2401.01234' ]
 * console.log(contentKeysOfUrl('https://example.com/post/1'))
 * // => []
 */
export function contentKeysOfUrl(url) {
    let u
    try {
        u = new URL(String(url ?? ''))
    }
    catch {
        return []
    }
    const keys = []
    const host = u.hostname.replace(/^www\./, '')
    // 路徑含非法百分比編碼(被截斷之 %E4%B8、字面 %)時 decodeURIComponent 拋 URIError:改以未解碼之路徑照算代稱。
    //   本函數供入庫比對、索引建立(全庫網址)與符合度掃描共用——拋錯會讓一筆網址使整個同一內容判定失效
    let p
    try {
        p = decodeURIComponent(u.pathname)
    }
    catch {
        p = u.pathname
    }
    const msn = /\/ar-([A-Za-z0-9]{6,})/.exec(p)
    if (host.endsWith('msn.com') && msn) keys.push(`msn:${msn[1]}`)
    const ax = /(?:arxiv\.org\/(?:abs|pdf)\/)(\d{4}\.\d{4,5})/i.exec(`${host}${p}`)
    if (ax) keys.push(`arxiv:${ax[1]}`)
    const doi = /(10\.\d{4,9}\/[^\s?#]+)/.exec(p)
    if (doi && (host.endsWith('doi.org') || /\/doi\//.test(p))) keys.push(`doi:${doi[1].toLowerCase().replace(/\.pdf$/, '')}`)
    const ssrn = u.searchParams.get('abstract_id') || u.searchParams.get('abstractid')
    if (host.endsWith('ssrn.com') && ssrn) keys.push(`ssrn:${ssrn}`)
    // 同站 slug:路徑末段(去副檔名、去數字尾碼)≥5 個以連字號分隔之字母詞,**限同一主機**(去 www.／m.／amp. 前綴;AMP、行動版、
    //   改路徑之同一頁)。跨站同 slug 不視為同一內容:泛用標題(如 what-is-a-hash-table-and-how-to-use-it)不同站即不同文,
    //   不帶主機會誤判重複(存量處置更會因而合併不同文章)——跨站轉載改由段落雜湊判(落盤時)
    const last = p.split('/').filter(Boolean).at(-1) || ''
    const slug = last.toLowerCase().replace(/\.(html?|php|aspx?)$/, '').replace(/[-_]?\d{5,}$/, '').replace(/^ar-[a-z0-9]+$/, '')
    const words = slug.split(/[-_]+/).filter((w) => /[a-z]/.test(w))
    if (words.length >= 5 && slug.length >= 30) keys.push(`slug:${host.replace(/^(m|amp)\./, '')}/${words.join('-')}`)
    return keys
}

/**
 * CS10:找出同一內容之文件群(只看傳入之文件;每群 ≥2 份)
 *
 * @param {Array} docs 輸入文件記錄陣列(取 id、url、finalUrl;非陣列視為空)
 * @returns {Array} 回傳 [{ key:同一內容代稱, ids:Array(該群文件 id) }];無重複回空陣列
 * @example
 * const groups = duplicateGroups([
 *     { id: 'a', url: 'https://arxiv.org/abs/2401.01234' },
 *     { id: 'b', url: 'https://arxiv.org/pdf/2401.01234' },
 *     { id: 'c', url: 'https://example.com/post/1' },
 * ])
 * console.log(groups)
 * // => [ { key: 'arxiv:2401.01234', ids: [ 'a', 'b' ] } ]
 */
export function duplicateGroups(docs) {
    const byKey = new Map()
    for (const d of isarr(docs) ? docs : []) {
        const keys = new Set([...contentKeysOfUrl(d?.url), ...contentKeysOfUrl(d?.finalUrl)])
        for (const k of keys) {
            if (!byKey.has(k)) byKey.set(k, new Set())
            byKey.get(k).add(d.id)
        }
    }
    return [...byKey.entries()].filter(([, ids]) => ids.size > 1).map(([key, ids]) => ({ key, ids: [...ids] }))
}

export default { DOC_STANDARDS, titleTokens, checkTitleBody, contentKeysOfUrl, duplicateGroups }
