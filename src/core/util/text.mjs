// text.mjs — 概念正規化與雜湊（識別鍵體系的基石）
//
// 【sha1 委派 wsemi str2sha】與 w-data-pipeline 之 keyOf 同一來源；
//   記錄 id（文件、線索、來源）皆由 sha1 衍生並持久化為去重憑證，不可換演算法。
// 【內容雜湊另一函數(contentSha1)】判「內容是否變了」(原文另存之同一份判定與回讀驗證)之雜湊,與身分雜湊 sha1 語意不同:
//   空內容亦須有確定之雜湊(sha1 對空輸入回 ''——無鍵項目不得共用同一 key),且不隨身分雜湊之實作來源(wsemi)而定——兩者不共用一個函數。

import crypto from 'crypto'
import str2sha from 'wsemi/src/str2sha.mjs'

/**
 * SHA-1 十六進位（空輸入回 ''，fail-safe：合法雜湊會讓無鍵項目共用同一 key）
 *
 * @param {*} s 輸入任意值，null／undefined 視為空字串，其餘轉字串後雜湊
 * @returns {String} 回傳 SHA-1 十六進位字串(40 碼)；輸入為空字串時回傳''
 * @example
 * console.log(sha1('hello'))
 * // => aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d
 *
 * console.log(sha1(undefined))
 * // =>
 */
export function sha1(s) {
    return str2sha(String(s ?? ''), 1)
}

/**
 * 內容雜湊:SHA-1 十六進位(node crypto,UTF-8);任何輸入皆雜湊,含空字串(檔頭【內容雜湊另一函數】)
 *
 * @param {*} s 輸入任意值，null／undefined 視為空字串，其餘轉字串後雜湊
 * @returns {String} 回傳 SHA-1 十六進位字串(40 碼)
 * @example
 * console.log(contentSha1(''))
 * // => da39a3ee5e6b4b0d3255bfef95601890afd80709
 */
export function contentSha1(s) {
    return crypto.createHash('sha1').update(String(s ?? '')).digest('hex')
}

// ── 概念分群鍵的字形折疊（可注入）──
//
// 【為何需要】NFKC 統一的是全形半形，**不做繁簡轉換**——「注意力機制」與「注意力机制」
//   在 NFKC 下是不同分群鍵。模型偶爾無視「一律繁體」指示輸出簡體標籤，同一概念因此分裂成兩群，
//   依分群鍵累計或去重之機制（如領域標籤去重）隨之失效，重複收錄同一概念。
// 【為何注入而非內建】字形對應表是隨語料成長的資料（opencc 級辭典逾千條目），
//   內建會讓套件揹上重依賴；且「摺疊到哪種字形」是執行端政策。
//   注入函數只需「一致」不需「語言學正確」——摺疊結果僅作分群鍵、永不顯示（英文為不動點）。
// 【總組裝預設折向簡體（opencc tw→cn）】繁體多字對一簡體（迴／回、裡／里、衝／沖…），折向簡體才收斂字形變體；
//   cn→tw 收斂不了（回歸／迴歸／回归 分 2 鍵）。代價：少數繁體語意不同之字對同鍵
//   （曆年／歷年、回復／回覆…），以折疊前改名拆開（見下）；兩岸用語（演算法／算法）字元級轉換不收斂，以折疊後別名合併。
// 【別名兩段】renames＝折疊前精確改名（NFKC＋去空白後比對原字形）：可拆開折疊誤合、可把「名稱(數字)」類寫法改回基名；
//   aliases＝折疊後同義合併（鍵與值皆經改名、去括號、小寫、折疊）：兩岸用語、同義詞。兩者皆單跳、不遞移。
// 【線索鍵與分群脫鉤】待探索線索之去重鍵是持久化的（frontier 記錄 id），若隨分群政策（改名、別名、折疊）變動，
//   既有線索會全部換鍵（去重失效、hits 歸零）；線索鍵另走 normalizeClue：只用 clueFold（總組裝注入固定之內建折疊 cn→tw），
//   不套改名與別名。
let conceptFold = null
let clueFold = null
let renameMap = new Map()
let aliasMap = new Map()

/**
 * 折疊前之比對形：NFKC、去空白(\s 已涵蓋全形空白 U+3000;NFKC 亦將其轉為半形空白)
 *
 * @param {*} s 輸入任意值，null／undefined 視為空字串
 * @returns {String} 回傳比對形字串
 */
const preFormOf = (s) => String(s ?? '').normalize('NFKC').replace(/\s+/g, '')

/**
 * 去括號字元、英文小寫、去頭尾空白
 *
 * @param {String} t 輸入折疊前之比對形
 * @returns {String} 回傳待折疊之字串
 */
const stripOf = (t) => t.replace(/[（）()［］[\]「」]/g, '').toLowerCase().trim()

/**
 * 檢查別名對照物件:須為 { 原寫法: 新寫法 } 且兩端皆為非空字串
 *
 * @param {*} map 輸入待檢查之值，undefined／null 視為空對照
 * @param {String} name 輸入設定鍵名稱(錯誤訊息用，如 'vocab.conceptRenames')
 * @returns {Array} 回傳 [原寫法, 新寫法] 陣列
 * @throws {Error} 非物件、或任一端非非空字串時拋出
 * @example
 * console.log(checkNameMap({ '算法': '演算法' }, 'vocab.conceptAliases'))
 * // => [ [ '算法', '演算法' ] ]
 */
export function checkNameMap(map, name) {
    if (map === undefined || map === null) return []
    if (typeof map !== 'object' || Array.isArray(map)) throw new Error(`${name} 須為物件 { 原寫法: 新寫法 }`)
    const out = Object.entries(map)
    for (const [k, v] of out) {
        if (!preFormOf(k) || typeof v !== 'string' || !preFormOf(v)) throw new Error(`${name} 之「${k}」須對應非空字串`)
    }
    return out
}

/**
 * 注入字形折疊函數與別名（如 opencc-js 之 Converter({from:'tw',to:'cn'})）；傳非函數即清除折疊(還原為不折疊)
 *
 * 只給 fn 時:改名與別名清空、線索折疊同 fn。
 *
 * @param {Function} fn 輸入分群用折疊函數 (t:String) => String，傳非函數視為清除
 * @param {Object} [opt={}] 輸入設定物件，非物件視為{}
 * @param {Function} [opt.clueFold] 輸入線索鍵用折疊函數(總組裝注入固定之內建折疊,使線索鍵不隨分群政策變動)，未給此鍵即同 fn，給非函數即不折疊
 * @param {Object} [opt.renames] 輸入折疊前改名對照 { 原寫法: 新寫法 }(vocab.conceptRenames)
 * @param {Object} [opt.aliases] 輸入折疊後別名對照 { 別名: 正名 }(vocab.conceptAliases)
 * @returns {undefined} 無回傳值(設定模組層級變數，供 normalizeConcept／normalizeClue 內部使用)
 * @throws {Error} opt.renames／opt.aliases 不合 checkNameMap 時拋出(模組狀態不變)
 * @example
 * // 此函數改的是模組層級狀態，用畢須傳非函數還原，以免影響其後的正規化結果
 * setConceptFold((t) => t.replace(/机/g, '機'), { aliases: { '算法': '演算法' } })
 * console.log(normalizeConcept('注意力机制'), normalizeConcept('算法'))
 * // => 注意力機制 演算法
 *
 * setConceptFold(null)
 * console.log(normalizeConcept('注意力机制'), normalizeConcept('算法'))
 * // => 注意力机制 算法
 */
export function setConceptFold(fn, opt = {}) {
    if (opt === null || typeof opt !== 'object') opt = {}
    const renames = checkNameMap(opt.renames, 'vocab.conceptRenames')
    const aliases = checkNameMap(opt.aliases, 'vocab.conceptAliases')
    conceptFold = typeof fn === 'function' ? fn : null
    clueFold = Object.prototype.hasOwnProperty.call(opt, 'clueFold') ? (typeof opt.clueFold === 'function' ? opt.clueFold : null) : conceptFold
    renameMap = new Map(renames.map(([k, v]) => [preFormOf(k), preFormOf(v)]))
    aliasMap = new Map()
    const keyOf = (s) => {
        let t = preFormOf(s)
        if (renameMap.has(t)) t = renameMap.get(t)
        t = stripOf(t)
        return conceptFold ? conceptFold(t) : t
    }
    for (const [k, v] of aliases) aliasMap.set(keyOf(k), keyOf(v))
}

/**
 * 正規化概念標籤作為分群鍵。
 * 概念標籤（如領域標籤）是分群與去重的唯一依據——標籤對不起來，同一概念就會分裂成多筆。
 * 統一全形半形（NFKC）、去空白、英文小寫，再套用注入的字形折疊（見 setConceptFold）。
 *
 * @param {*} s 輸入任意值，null／undefined 視為空字串，其餘轉字串後正規化
 * @returns {String} 回傳正規化後之分群鍵字串
 * @example
 * console.log(normalizeConcept('  注意力 機制 '))
 * // => 注意力機制
 *
 * console.log(normalizeConcept('Attention（機制）'))
 * // => attention機制
 */
export function normalizeConcept(s) {
    let t = preFormOf(s)
    if (renameMap.has(t)) t = renameMap.get(t)
    t = stripOf(t)
    if (conceptFold) t = conceptFold(t)
    return aliasMap.get(t) ?? t
}

/**
 * 正規化待探索線索值作為去重鍵(持久化鍵;見檔頭【線索鍵與分群脫鉤】):NFKC、去空白與括號、英文小寫，再套用線索折疊，不套改名與別名
 *
 * @param {*} s 輸入任意值，null／undefined 視為空字串
 * @returns {String} 回傳正規化後之線索鍵字串
 * @example
 * console.log(normalizeClue('Transformer 架構'))
 * // => transformer架構
 */
export function normalizeClue(s) {
    const t = stripOf(preFormOf(s))
    return clueFold ? clueFold(t) : t
}

/** slug 雜湊尾碼之碼數(格式常數;slugify 之尾碼與下游之尾碼解析同讀) */
export const SLUG_SUFFIX_CHARS = 8

const SLUG_SUFFIX_RE = new RegExp(`-([0-9a-f]{${SLUG_SUFFIX_CHARS}})$`)

/**
 * slug 之雜湊尾碼(格式之單一解析:「-」＋8 碼小寫十六進位結尾;下游之 slug 抄寫容錯以之比對)
 *
 * @param {*} slug 輸入 slug 字串
 * @returns {String} 回傳尾碼(8 碼小寫十六進位);無尾碼回 ''
 * @example
 * console.log(slugSuffixOf('hello-world-0a4d55a8'), slugSuffixOf('hello-world'), slugSuffixOf('x-0A4D55A8'))
 * // => 0a4d55a8  (空字串)  (空字串)
 */
export function slugSuffixOf(slug) {
    const m = String(slug ?? '').trim().match(SLUG_SUFFIX_RE)
    return m ? m[1] : ''
}

/**
 * 由標題產生檔名 slug：保留中英數，其餘轉連字號，尾綴 8 碼雜湊確保唯一。
 * 尾碼同時是下游「slug 抄寫容錯」的比對基礎（模型抄長中文 slug 會漏字，尾碼相符即可解析回真實 slug;slugSuffixOf），故格式不可變更。
 *
 * @param {*} title 輸入標題，null／undefined 視為空字串
 * @param {String} [seed=''] 輸入雜湊種子字串，預設用 title（仍空則用亂數，此時不可重現），確保重覆標題仍可分辨
 * @param {Object} [opt={}] 輸入設定物件
 * @param {String} [opt.chars='han-latin'] 輸入保留之字元類別:'han-latin' 漢字與拉丁字母數字(預設;既有 slug 不變);'unicode' 任何文字之字母與數字
 *   (語言設定非中文時,core/locale 之 locale.slug)
 * @returns {String} 回傳 slug 字串，格式為 `<保留字元或'note'>-<8碼雜湊>`
 * @throws {Error} opt.chars 給了而非 'han-latin'／'unicode' 時拋出
 * @example
 * console.log(slugify('Hello World'))
 * // => hello-world-0a4d55a8
 *
 * console.log(slugify('Transformer 注意力機制！！', 'k1'))
 * // => transformer-注意力機制-a2ab1959
 *
 * console.log(slugify('Café résumé', 'k2', { chars: 'unicode' }))
 * // => café-résumé-bfeb734d
 */
export function slugify(title, seed = '', opt = {}) {
    const chars = opt !== null && typeof opt === 'object' && opt.chars !== undefined ? opt.chars : 'han-latin'
    if (chars !== 'han-latin' && chars !== 'unicode') throw new Error(`slugify 之 opt.chars 須為 'han-latin' 或 'unicode'，收到：${String(chars)}`)
    const base = String(title || '')
        .toLowerCase()
        .replace(/[\s　]+/g, '-')
        .replace(chars === 'unicode' ? /[^\p{L}\p{N}\p{M}-]+/gu : /[^\p{Script=Han}a-z0-9-]+/gu, '')
        .replace(/-{2,}/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48)
    const suffix = sha1(seed || title || String(Math.random())).slice(0, SLUG_SUFFIX_CHARS)
    return `${base || 'note'}-${suffix}`
}

/** 有效字數(去空白、標點與符號後之字元數;NFKC) */
const meaningfulChars = (s) => [...String(s ?? '').normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '')].length

/**
 * 文字之長度處置(不靜默截斷之單一實作):去多餘空白;逾上限者截至上限內最後一個界(boundaryRe);
 *   界前有效字數不足 minMeaningful 或上限內無界 → 不截(全文保留,不在詞或數字中間斷開)
 *
 * @param {*} text 輸入文字
 * @param {Integer} max 輸入上限(字;以 Unicode 字元計)
 * @param {Object} [opt={}] 輸入 { boundaryRe:RegExp(須帶 g;預設句末標點), minMeaningful:Integer(截後至少之有效字數,預設 1) }
 * @returns {Object} 回傳 { text, cut:Boolean, from(原字數) }
 * @example
 * console.log(cutAtBoundary('2015-01 至 2025-08；另 2018-2024', 20, { boundaryRe: /[；;，,]/g }))
 * // => { text: '2015-01 至 2025-08；', cut: true, from: 29 }
 *
 * console.log(cutAtBoundary('2015-01 至 2025-08；另 2018-2024', 12, { boundaryRe: /[；;，,]/g }))
 * // => { text: '2015-01 至 2025-08；另 2018-2024', cut: false, from: 29 }(上限內無界 → 不截)
 */
export function cutAtBoundary(text, max, opt = {}) {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim()
    const chars = [...s]
    if (!(Number.isInteger(max) && max > 0) || chars.length <= max) return { text: s, cut: false, from: chars.length }
    const re = opt.boundaryRe instanceof RegExp ? new RegExp(opt.boundaryRe.source, opt.boundaryRe.flags.includes('g') ? opt.boundaryRe.flags : `${opt.boundaryRe.flags}g`) : /[。！？；!?;]/g
    const head = chars.slice(0, max).join('')
    let at = -1
    for (const m of head.matchAll(re)) at = m.index + m[0].length
    const cut = at > 0 ? head.slice(0, at).trim() : ''
    const minKeep = Number.isInteger(opt.minMeaningful) && opt.minMeaningful > 0 ? opt.minMeaningful : 1
    if (!cut || meaningfulChars(cut) < minKeep) return { text: s, cut: false, from: chars.length }
    return { text: cut, cut: true, from: chars.length }
}

export default { sha1, normalizeConcept, normalizeClue, checkNameMap, setConceptFold, SLUG_SUFFIX_CHARS, slugSuffixOf, slugify, cutAtBoundary }
