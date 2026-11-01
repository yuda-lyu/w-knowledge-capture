// vocabDefault.mjs — 套件內建預設詞彙表(知識庫之主題範圍、稱呼與概念標籤之寫法對照)
//
// 【安裝即用 vs 執行端擴充】內建預設讓零設定可跑;執行端給 cfg.data.vocab 時
//   「整鍵替換」(給 conceptRenames 就整組換,未給的鍵沿用內建)——不做深合併:合併語意不可預期,整鍵替換一眼可斷。
// 【領域中立】本套件為通用知識抓取套件,預設不綁任何領域;安裝方以 domain 給主題範圍、以 kbLabel 給知識庫稱呼,
//   即可把領域發現之提示詞收斂到自己的主題。
// 【只認本套件讀取之鍵】不認得之鍵拋錯並列出可用鍵:打錯之鍵(如 kbLable)若靜默接受,正名鍵會維持預設而無人察覺。
// 【頭之政策取共用件】值為 undefined 之鍵視為未給、null 依逐鍵宣告(VOCAB_NULL_AS)、不認得之鍵之訊息——皆取 vocabKit(各工作之詞彙表同一份)。
//
// 各鍵語意:
//   domain          主題範圍字串(如「機器學習」);空字串＝不限主題。領域發現之提示詞與知識庫稱呼據此產生
//   kbLabel         知識庫稱呼(提示詞首句);空字串＝由 domain 推導(見 kbLabelOf)
//   conceptRenames  概念標籤之折疊前精確改名 { 原寫法: 新寫法 }(拆開折疊誤合、把「名稱(數字)」類寫法改回基名;見 util/text)
//   conceptAliases  概念標籤之折疊後同義合併 { 別名: 正名 }(兩岸用語、同義詞;見 util/text)
//   guide           提示詞領域句之分段物件(本套件之領域發現不讀取;收下僅驗為物件,使同一份詞彙表可與其他知識處理段共用)

import isobj from 'wsemi/src/isobj.mjs'
import { given } from '../util/values.mjs'
import { checkNameMap } from '../util/text.mjs'
import { cloneSettingsDefault } from '../settingsDefault.mjs'
import { vocabHeadOf, pickVocabKeys } from './vocabKit.mjs'


/**
 * 內建預設詞彙表(領域中立)
 *
 * @type {Object}
 */
export const VOCAB_DEFAULT = {
    domain: '',
    kbLabel: '',
    conceptRenames: {},
    conceptAliases: {},
}


/**
 * 抓取共用之鍵(本套件所讀之鍵;下游套件之詞彙表以此篩出「抓取共用」與「自有」之鍵,不另抄一份)
 *
 * @type {Array}
 */
export const CAPTURE_VOCAB_KEYS = Object.freeze(Object.keys(VOCAB_DEFAULT))


/** 詞彙表之全部可用鍵(resolveVocab 據此拒絕不認得之鍵) */
const VOCAB_KEYS = [...CAPTURE_VOCAB_KEYS, 'guide']

/** null 之逐鍵政策(vocabKit 之 vocabHeadOf):主題範圍、稱呼與 guide 之 null 視為未給(取預設);概念之改名／別名之 null 為空對照 */
const VOCAB_NULL_AS = Object.freeze({ domain: 'unset', kbLabel: 'unset', conceptRenames: 'empty', conceptAliases: 'empty', guide: 'unset' })


/**
 * 合併內建預設詞彙表與執行端覆寫(整鍵替換)
 *
 * 可重複套用:resolveVocab(resolveVocab(x)) 與 resolveVocab(x) 相同
 *
 * @param {Object} [override] 輸入覆寫物件，給定之鍵整鍵替換內建值(值為 undefined 者視為未給;null 依 VOCAB_NULL_AS)，未給或非物件代表全用內建預設
 * @returns {Object} 回傳合併後詞彙表物件，含 domain、kbLabel、conceptRenames、conceptAliases(給了 guide 者另含 guide)
 * @throws {Error} 含不認得之鍵(附可用鍵)、kbLabel 非字串、guide 非物件，或 conceptRenames／conceptAliases 非 { 原寫法: 新寫法 } 字串對照時拋出
 * @example
 * let v = resolveVocab({ domain: '機器學習', kbLabel: '機器學習知識庫' })
 * console.log(v.domain, v.kbLabel, v.conceptRenames)
 * // => 機器學習 機器學習知識庫 {}
 */
export function resolveVocab(override) {
    const o = vocabHeadOf(override, VOCAB_KEYS, { nullAs: VOCAB_NULL_AS, defaults: VOCAB_DEFAULT })
    if (given(o.kbLabel) && typeof o.kbLabel !== 'string') throw new Error('vocab.kbLabel 須為字串')
    if (given(o.guide) && !isobj(o.guide)) throw new Error('vocab.guide 須為物件')

    const v = { ...VOCAB_DEFAULT, ...o }
    // 概念別名:形狀錯誤於建構期拋錯(不可讓打錯的別名表靜默不生效)
    checkNameMap(v.conceptRenames, 'vocab.conceptRenames')
    checkNameMap(v.conceptAliases, 'vocab.conceptAliases')
    return v
}


/**
 * 由詞彙表取得知識庫稱呼(提示詞首句共用):kbLabel 優先,否則由 domain 推導
 *
 * @param {Object} vocab 輸入詞彙表物件(resolveVocab 之產出，或至少含 domain／kbLabel)
 * @returns {String} 回傳稱呼字串：kbLabel 非空時為其值；否則 domain 為空時為「知識庫」，有 domain 時為「「<domain>」知識庫」
 * @example
 * console.log(kbLabelOf({ domain: '' }))
 * // => 知識庫
 *
 * console.log(kbLabelOf({ domain: '機器學習' }))
 * // => 「機器學習」知識庫
 *
 * console.log(kbLabelOf({ domain: '機器學習', kbLabel: '機器學習知識庫' }))
 * // => 機器學習知識庫
 */
export function kbLabelOf(vocab) {
    const label = typeof vocab?.kbLabel === 'string' ? vocab.kbLabel.trim() : ''
    if (label) return label
    const domain = String(vocab?.domain || '').trim()
    return domain ? `「${domain}」知識庫` : '知識庫'
}


/**
 * 自任意詞彙表取本套件所讀之鍵(VOCAB_DEFAULT 之鍵:domain、kbLabel、conceptRenames、conceptAliases):他套件與本套件共用一份詞彙表時,
 *   以此取子集交本套件(本套件之 resolveVocab 拒收其他鍵)——鍵集只在本檔定義,呼叫端不另抄一份(本套件新增詞彙鍵時呼叫端自動帶上)
 *
 * @param {Object} [vocab] 輸入詞彙表(可含他套件之鍵)，非物件視為{}
 * @returns {Object} 回傳只含本套件所讀之鍵(未給者不列)之新物件
 * @example
 * console.log(pickCaptureVocab({ domain: '機器學習', categories: ['其他'], guide: {} }))
 * // => { domain: '機器學習' }
 */
export function pickCaptureVocab(vocab) {
    return pickVocabKeys(vocab, CAPTURE_VOCAB_KEYS)
}


/**
 * 抓取共用之鍵之預設值(解析後之複本;下游套件之內建預設詞彙表以此為底,再加自有之鍵——同一份預設、各次取得之物件互不共用參照,
 *   下游就地改其預設不汙染本套件之預設常數)
 *
 * @returns {Object} 回傳 resolveVocab({}) 之複本
 * @example
 * console.log(captureVocabDefaultOf())
 * // => { domain: '', kbLabel: '', conceptRenames: {}, conceptAliases: {} }
 */
export function captureVocabDefaultOf() {
    return cloneSettingsDefault(resolveVocab({}))
}


export default VOCAB_DEFAULT
