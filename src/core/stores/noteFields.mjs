// noteFields.mjs — 本套件所讀之下游筆記記錄欄位之單一宣告(資料契約)
//
// 【範圍】筆記由下游套件寫入 notes 集合(選開;見總組裝之 cfg.notes),本套件只讀下列欄位:出處文件 docId、建立時刻 createdAt、
//   標題 title、概念標籤 concepts(依序;第一個有效者為主標籤)、下游消化時刻 extractedAt(已被下游之產物引用——刪其筆記會使該產物撤出處);
//   記錄之 id 為集合之鍵(各集合同一契約),不在此列。
//   讀處:領域發現之候選與其例句(stores/areaPolicy)、同一內容之存量處置之留存者(standards/cs10Fix、ops/docStockFix)、原文回溯之對象(ops/refetchSources)。
// 【為何需要】本套件是最底層,筆記之欄位由下游定義;散在各處直接讀欄位時,下游一改名本套件即靜默改變行為(候選、留存者、回溯對象)。
//   欄位名與取值之容錯只在本檔一份;下游同義之規則(主標籤)亦經本檔取用,不另寫一份。
// 【主標籤】概念標籤依序、以概念鍵(normalizeConcept:字形折疊、改名與別名後之分群鍵)去重、略過鍵為空者;第一個為主標籤、其餘為次標籤。
//   領域發現之候選與下游之選題以同一定義計主標籤(下游經其抓取埠取 noteConceptsOf)。

import isarr from 'wsemi/src/isarr.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import { normalizeConcept } from '../util/text.mjs'

/**
 * 本套件所讀之筆記記錄欄位名(檔頭【範圍】)
 *
 * @type {Object}
 */
export const NOTE_FIELDS = Object.freeze({ docId: 'docId', createdAt: 'createdAt', title: 'title', concepts: 'concepts', extractedAt: 'extractedAt' })

/**
 * 筆記之出處文件 id
 *
 * @param {*} note 輸入筆記記錄
 * @returns {String} 回傳文件 id；缺或非字串時回傳 ''
 * @example
 * console.log(noteDocIdOf({ docId: 'd1' }), JSON.stringify(noteDocIdOf({})))
 * // => d1 ""
 */
export function noteDocIdOf(note) {
    const v = note?.[NOTE_FIELDS.docId]
    return isestr(v) ? v : ''
}

/**
 * 筆記之建立時刻(毫秒)
 *
 * @param {*} note 輸入筆記記錄
 * @returns {Number} 回傳毫秒數；缺或不可解析時回傳 NaN
 * @example
 * console.log(noteCreatedMsOf({ createdAt: '2026-01-02T00:00:00Z' }), noteCreatedMsOf({}))
 * // => 1767312000000 NaN
 */
export function noteCreatedMsOf(note) {
    return Date.parse(String(note?.[NOTE_FIELDS.createdAt] || ''))
}

/**
 * 筆記之標題
 *
 * @param {*} note 輸入筆記記錄
 * @returns {String} 回傳標題；缺時回傳 ''(非字串者轉字串)
 * @example
 * console.log(noteTitleOf({ title: '恆星演化' }), JSON.stringify(noteTitleOf(null)))
 * // => 恆星演化 ""
 */
export function noteTitleOf(note) {
    return String(note?.[NOTE_FIELDS.title] || '')
}

/**
 * 筆記是否已被下游消化(extractedAt 非空:已被下游之產物引用)
 *
 * @param {*} note 輸入筆記記錄
 * @returns {Boolean} 回傳是否已消化
 * @example
 * console.log(noteConsumedOf({ extractedAt: '2026-01-02T00:00:00Z' }), noteConsumedOf({ extractedAt: '' }), noteConsumedOf(null))
 * // => true false false
 */
export function noteConsumedOf(note) {
    return !!note?.[NOTE_FIELDS.extractedAt]
}

/**
 * 筆記之概念標籤(檔頭【主標籤】):依序、以概念鍵去重、略過鍵為空者;第一個為主標籤
 *
 * @param {*} note 輸入筆記記錄(concepts 非陣列者視為無標籤)
 * @returns {Array} 回傳 [{ key:概念鍵, label:原寫法(去頭尾空白) }]
 * @example
 * console.log(noteConceptsOf({ concepts: [' 恆星演化 ', '', '恆星演化', '紅移'] }))
 * // => [ { key: '恆星演化', label: '恆星演化' }, { key: '紅移', label: '紅移' } ]
 */
export function noteConceptsOf(note) {
    const list = note?.[NOTE_FIELDS.concepts]
    const out = []
    const seen = new Set()
    for (const c of isarr(list) ? list : []) {
        const key = normalizeConcept(c)
        if (!key || seen.has(key)) continue
        seen.add(key)
        out.push({ key, label: String(c).trim() })
    }
    return out
}

/**
 * 筆記之主標籤(noteConceptsOf 之第一個)
 *
 * @param {*} note 輸入筆記記錄
 * @returns {Object|null} 回傳 { key, label }；無有效標籤時回傳 null
 * @example
 * console.log(notePrimaryConceptOf({ concepts: ['', '紅移', '視差'] }), notePrimaryConceptOf({ concepts: [] }))
 * // => { key: '紅移', label: '紅移' } null
 */
export function notePrimaryConceptOf(note) {
    return noteConceptsOf(note)[0] || null
}

export default { NOTE_FIELDS, noteDocIdOf, noteCreatedMsOf, noteTitleOf, noteConsumedOf, noteConceptsOf, notePrimaryConceptOf }
