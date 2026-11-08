// provenance.mjs — 產出鏈(produced)之共用件:makeProduced(組出並檢核)、appendProduced(追加歷史)、pkgIdOf(取套件名@版本)
//
// ════════════════ 為何有這個檔 ════════════════
// 寫入知識庫之記錄須記「哪一輪、哪個席位、實際由哪個條目成交、提示詞版本、套件版本」,使已進知識庫之問題資訊
// 能依紀錄定位、成批重處理或移除(使用端需求,Gitea #107～#109)。各下游套件之記錄資料結構同一,
// 故結構之組出、檢核、歷史上限與套件版取得集中於此,下游一律經此組 produced,不自行拼物件。
// 規格:跨套件之產出鏈規格(結構 §2、共用件 §5);落地條目見 sgud/rule/rulebook_core.md 之產出鏈條。
//
// ════════════════ 結構(規格 §2) ════════════════
// 單一產出者:{ v:1, stamp, stage, seat, provider, promptFp?, pkg, at }
// 多步產出  :{ v:1, stamp, stage, pkg, at, steps:[{ role, seat, provider, promptFp? }], failures:[{ role, seat, provider, type }] }
//   stamp   輪次 stamp(14 碼;輪次外之手動 ops／CLI 為 null)——來自 createRoundRunner 交給各段之 ctx.stamp
//   stage   產出階段(各套件之列舉值;小寫連字號名)
//   seat    席位:單一產出者為設定路徑或 first／second／third(字串);多步產出之 steps／failures 為席號(非負整數)
//   provider 實際成交條目(調度層遞補後實際回覆者之 providerId)
//   (不呼叫 AI 之寫入——確定性修正等:單一產出者之 seat 與 provider 須同時明給 null;只其一為 null 即拒)
//   promptFp 提示詞指紋(16 碼十六進位;無評比題組者省略;見 bench/promptFp 之 createPromptFpCache)
//   pkg     name@version(見 pkgIdOf)
//   at      寫入時刻(本地時區 ISO,YYYY-MM-DDTHH:mm:ss±hh:mm,與時鐘物件 iso8() 同格式)
// 記錄之 producedHistory 每次寫入追加一筆(produced 為最末筆),每筆記錄保留最近 50 筆,超出捨去最舊並累計 producedHistoryDropped。
//
// ════════════════ 輸入檢核 ════════════════
// 依《輸入參數之檢測機制》:本檔各函數之輸入皆為必須參數,無效即同步拋出 Error,先於任何輸出;訊息格式 `invalid <名稱>: must be <種類描述>`
// (V19),不回顯輸入值(K9;未知鍵之訊息帶鍵名——程式識別字而非資料值,需據以改正誤拼)。opt(appendProduced 之 max)給了而不合者視為未給、改用預設(K3)。
// 數字類(席號、max、捨去數)收數字字串並轉為數字後使用(K4、K7),布林不當數字(K5)。
//
// 【node 內建模組一律無前綴引用(fs、path、url)】與 toolg/gDistRollup.mjs 之 external 寫法一致(見該檔盤點原則 2)。

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import isobj from 'wsemi/src/isobj.mjs'
import isarr from 'wsemi/src/isarr.mjs'
import iseint from 'wsemi/src/iseint.mjs'
import { genClockTZ } from '../runnerPackage.mjs'

/**
 * produced 之結構版本(規格 §2.1 之 v)
 *
 * @type {Number}
 */
export const PRODUCED_VERSION = 1

/**
 * 每筆記錄保留之 producedHistory 筆數預設上限(規格 §2.3)
 *
 * @type {Number}
 */
export const PRODUCED_HISTORY_MAX = 50

const STAMP_RE = /^\d{14}$/
const STAGE_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const FP_RE = /^[0-9a-f]{16}$/
const PKG_RE = /^(?:@[^\s@/]+\/)?[^\s@/]+@[0-9][^\s@]*$/
const AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})[+-](\d{2}):(\d{2})$/

const KEYS_SINGLE = ['v', 'stamp', 'stage', 'seat', 'provider', 'promptFp', 'pkg', 'at']
const KEYS_MULTI = ['v', 'stamp', 'stage', 'pkg', 'at', 'steps', 'failures']
const KEYS_ALL = [...new Set([...KEYS_SINGLE, ...KEYS_MULTI])]
const KEYS_STEP = ['role', 'seat', 'provider', 'promptFp']
const KEYS_FAILURE = ['role', 'seat', 'provider', 'type']

const MSG_AT = 'a local-time ISO string YYYY-MM-DDTHH:mm:ss±hh:mm'
const MSG_FP = 'a 16-character lowercase hex string'
const MSG_SEAT_NO = 'a non-negative integer'
const MSG_PKG = 'a package id \'name@version\''

/**
 * 一般物件(原型為 Object.prototype 或 null;陣列、Date、Map、類別實例皆否)
 *
 * @param {*} v 輸入任意值
 * @returns {Boolean} 回傳是否為一般物件
 */
function isPlain(v) {
    if (!isobj(v)) return false
    const proto = Object.getPrototypeOf(v)
    return proto === Object.prototype || proto === null
}

/**
 * 給了(undefined 與 null 為未給;其餘含 0、false、空字串皆為給了)
 *
 * @param {*} v 輸入任意值
 * @returns {Boolean} 回傳是否給了
 */
const given = (v) => v !== undefined && v !== null

/**
 * 非空原始字串(去頭尾空白後有字;不收 String 包裝物件)
 *
 * @param {*} v 輸入任意值
 * @returns {Boolean} 回傳是否為非空字串
 */
const isTextual = (v) => typeof v === 'string' && v.trim() !== ''

/**
 * 拋出無效輸入之錯誤(V19 格式,不帶輸入值)
 *
 * @param {String} name 輸入欄位名稱(如 'o.steps[0].seat')
 * @param {String} must 輸入種類描述(如 'a non-empty string')
 * @throws {Error} 一律拋出 `invalid <name>: must be <must>`
 */
function bad(name, must) {
    throw new Error(`invalid ${name}: ${must}`)
}

/**
 * 檢核整數席號(非負整數;收數字字串並轉為數字,布林與小數、負數皆否)
 *
 * @param {*} v 輸入席號
 * @param {String} name 輸入欄位名稱
 * @returns {Number} 回傳轉換後之整數
 * @throws {Error} 不合時拋出
 */
function seatNoOf(v, name) {
    if (!iseint(v, { use: 'index' })) bad(name, `must be ${MSG_SEAT_NO}`)
    return Number(typeof v === 'string' ? v.trim() : v)
}

/**
 * 是否為本地時區 ISO 字串(YYYY-MM-DDTHH:mm:ss±hh:mm;日期須真實存在,時分秒與偏移不越界)
 *
 * @param {*} v 輸入任意值
 * @returns {Boolean} 回傳是否合格
 */
function isLocalIso(v) {
    if (typeof v !== 'string') return false
    const m = AT_RE.exec(v)
    if (!m) return false
    const [y, mo, d, h, mi, s, oh, om] = m.slice(1).map(Number)
    if (mo < 1 || mo > 12) return false
    const last = new Date(0)
    last.setUTCFullYear(y, mo, 0) // 該月最後一日
    if (d < 1 || d > last.getUTCDate()) return false
    return h <= 23 && mi <= 59 && s <= 59 && oh <= 23 && om <= 59
}

/** 本地時區之時鐘(惰性建立並快取;機器時區於行程內不變) */
let LOCAL_CLOCK = null

/**
 * 現在之本地時區 ISO 字串(機器本地時區;格式同 wsemi genClockTZ 之 iso8())
 *
 * @returns {String} 回傳 YYYY-MM-DDTHH:mm:ss±hh:mm
 */
function nowLocalIso() {
    if (!LOCAL_CLOCK) {
        let zone = ''
        try {
            zone = Intl.DateTimeFormat().resolvedOptions().timeZone
        }
        catch {
            zone = ''
        }
        try {
            LOCAL_CLOCK = genClockTZ(typeof zone === 'string' && zone ? zone : 'UTC')
        }
        catch {
            LOCAL_CLOCK = genClockTZ('UTC')
        }
    }
    return LOCAL_CLOCK.iso8()
}

/**
 * 檢核並組出一份 produced(新物件;鍵序固定;steps／failures 為新陣列與新物件)
 *
 * @param {*} o 輸入欲檢核之物件
 * @param {String} name 輸入根名稱('o' 或 'produced'),用於訊息
 * @param {Boolean} strict 輸入是否為已組出者(須帶 v 與 at;appendProduced 用,不代填)
 * @returns {Object} 回傳 produced
 * @throws {Error} 不合時拋出(第一個無效處)
 */
function producedOf(o, name, strict) {
    if (!isPlain(o)) bad(name, 'must be a plain object')
    for (const k of Object.keys(o)) {
        if (!KEYS_ALL.includes(k)) bad(`${name}.${k}`, 'unknown key')
    }

    if (strict ? o.v !== PRODUCED_VERSION : given(o.v) && o.v !== PRODUCED_VERSION) bad(`${name}.v`, `must be ${PRODUCED_VERSION}`)
    if (o.stamp !== null && !(typeof o.stamp === 'string' && STAMP_RE.test(o.stamp))) bad(`${name}.stamp`, 'must be a 14-digit stamp string or null')
    if (!(typeof o.stage === 'string' && STAGE_RE.test(o.stage))) bad(`${name}.stage`, 'must be a lowercase kebab-case name')

    // 鍵序固定:單一產出者 v、stamp、stage、seat、provider、promptFp?、pkg、at;多步產出 v、stamp、stage、pkg、at、steps、failures
    const multi = given(o.steps)
    const ordered = { v: PRODUCED_VERSION, stamp: o.stamp, stage: o.stage }

    // 單一產出者:席位、成交條目、提示詞指紋;多步產出不帶(規格 §2.2)
    if (multi) {
        for (const k of ['seat', 'provider', 'promptFp']) {
            if (given(o[k])) bad(`${name}.${k}`, `must not be given together with ${name}.steps`)
        }
    }
    else {
        // 不呼叫 AI 之寫入(確定性修正等):seat 與 provider 須同時明給 null(規格 §2.1);只其一為 null 即拒。
        //   缺省(undefined)不算 null——必須明給,以免漏接而靜默無值;兩鍵皆為鍵,值為 null 時仍寫入(形狀恆定,供依 provider 選件)
        if ((o.seat === null) !== (o.provider === null)) bad(`${name}.seat and ${name}.provider`, 'must be both non-empty strings or both null')
        if (o.seat !== null) {
            if (!isTextual(o.seat)) bad(`${name}.seat`, 'must be a non-empty string')
            if (!isTextual(o.provider)) bad(`${name}.provider`, 'must be a non-empty string')
        }
        if (given(o.promptFp) && !(typeof o.promptFp === 'string' && FP_RE.test(o.promptFp))) bad(`${name}.promptFp`, `must be ${MSG_FP}`)
        ordered.seat = o.seat
        ordered.provider = o.provider
        if (given(o.promptFp)) ordered.promptFp = o.promptFp
    }

    if (!(typeof o.pkg === 'string' && PKG_RE.test(o.pkg))) bad(`${name}.pkg`, `must be ${MSG_PKG}`)
    ordered.pkg = o.pkg
    if (strict || given(o.at)) {
        if (!isLocalIso(o.at)) bad(`${name}.at`, `must be ${MSG_AT}`)
        ordered.at = o.at
    }
    else {
        ordered.at = nowLocalIso()
    }

    if (multi) {
        if (!isarr(o.steps) || o.steps.length === 0) bad(`${name}.steps`, 'must be a non-empty array')
        ordered.steps = o.steps.map((s, i) => {
            const at = `${name}.steps[${i}]`
            if (!isPlain(s)) bad(at, 'must be a plain object')
            for (const k of Object.keys(s)) if (!KEYS_STEP.includes(k)) bad(`${at}.${k}`, 'unknown key')
            if (!isTextual(s.role)) bad(`${at}.role`, 'must be a non-empty string')
            const seat = seatNoOf(s.seat, `${at}.seat`)
            if (!isTextual(s.provider)) bad(`${at}.provider`, 'must be a non-empty string')
            if (given(s.promptFp) && !(typeof s.promptFp === 'string' && FP_RE.test(s.promptFp))) bad(`${at}.promptFp`, `must be ${MSG_FP}`)
            return { role: s.role, seat, provider: s.provider, ...(given(s.promptFp) ? { promptFp: s.promptFp } : {}) }
        })
        if (given(o.failures) && !isarr(o.failures)) bad(`${name}.failures`, 'must be an array')
        ordered.failures = (given(o.failures) ? o.failures : []).map((f, i) => {
            const at = `${name}.failures[${i}]`
            if (!isPlain(f)) bad(at, 'must be a plain object')
            for (const k of Object.keys(f)) if (!KEYS_FAILURE.includes(k)) bad(`${at}.${k}`, 'unknown key')
            if (!isTextual(f.role)) bad(`${at}.role`, 'must be a non-empty string')
            const seat = seatNoOf(f.seat, `${at}.seat`)
            if (!isTextual(f.provider)) bad(`${at}.provider`, 'must be a non-empty string')
            if (!isTextual(f.type)) bad(`${at}.type`, 'must be a non-empty string')
            return { role: f.role, seat, provider: f.provider, type: f.type }
        })
    }
    else if (given(o.failures)) {
        bad(`${name}.failures`, `must not be given without ${name}.steps`)
    }
    return ordered
}

/**
 * 依規格 §2 檢核並組出 produced(下游套件一律以此組,不自行拼物件)
 *
 * 兩種形狀:
 * - 單一產出者(未給 steps):必給 stamp、stage、seat、provider、pkg;選給 promptFp、at;不呼叫 AI 之寫入(確定性修正等)
 *   `seat` 與 `provider` 須**同時明給 null**(語意＝該次寫入無 AI 呼叫;只其一為 null 或缺省皆拒)
 * - 多步產出(給 steps):必給 stamp、stage、pkg、steps;選給 failures、at;不得帶頂層 seat／provider／promptFp
 * `v` 恆為 1(明給者須為 1);`stamp` 必須明給(輪次外之手動 ops／CLI 給 null——不容許省略,以免漏接 ctx.stamp 而靜默缺值);
 * 拒絕未知鍵與缺必填;`at` 未給(或 null)取現在(機器本地時區 ISO;有時鐘物件者宜明給 `clock.iso8()` 以與日誌同時區)。
 * 不改輸入,輸出與輸入不共用參考。
 *
 * @param {Object} o 輸入欄位物件
 * @param {String|null} o.stamp 輸入輪次 stamp(14 碼;取自 ctx.stamp;輪次外為 null)
 * @param {String} o.stage 輸入產出階段(小寫連字號名,如 'note-write'、'standards-fix')
 * @param {String|null} [o.seat] 輸入席位字串(單一產出者必給,如 'demo.ai'、'first';不呼叫 AI 之寫入與 provider 同時給 null)
 * @param {String|null} [o.provider] 輸入實際成交條目(單一產出者必給;調度層回傳之 providerId;不呼叫 AI 之寫入與 seat 同時給 null)
 * @param {String} [o.promptFp] 輸入提示詞指紋(16 碼小寫十六進位;可省——無評比題組者為 null,視同未給)
 * @param {String} o.pkg 輸入套件版('name@version',可由 pkgIdOf 取得)
 * @param {String} [o.at] 輸入寫入時刻(本地時區 ISO,YYYY-MM-DDTHH:mm:ss±hh:mm);未給取現在
 * @param {Number} [o.v=1] 輸入結構版本(只收 1)
 * @param {Array} [o.steps] 輸入多步產出之步驟 [{ role, seat(非負整數席號;收數字字串), provider, promptFp? }],依執行順序,至少一列
 * @param {Array} [o.failures] 輸入多步產出中失敗而遞補者 [{ role, seat, provider, type }](可空;未給為 [])
 * @returns {Object} 回傳 produced(鍵序固定)
 * @throws {Error} 輸入非一般物件、含未知鍵、缺必填、格式不符、單一產出者與多步產出之欄位混用、seat 與 provider 只其一為 null 時拋出;訊息 `invalid <名稱>: must be <種類描述>`,不含輸入值
 * @example
 * let p = makeProduced({ stamp: '20261108200009', stage: 'note-write', seat: 'demo.ai', provider: 'codex:gpt-6.1-terra', promptFp: '5118f8f40bf0dc40', pkg: 'w-demo-kb@1.0.10', at: '2026-11-08T20:12:31+08:00' })
 * console.log(JSON.stringify(p))
 * // => {"v":1,"stamp":"20261108200009","stage":"note-write","seat":"demo.ai","provider":"codex:gpt-6.1-terra","promptFp":"5118f8f40bf0dc40","pkg":"w-demo-kb@1.0.10","at":"2026-11-08T20:12:31+08:00"}
 *
 * let m = makeProduced({ stamp: null, stage: 'note-multi', pkg: 'w-demo-kb@1.0.10', at: '2026-11-08T20:12:31+08:00', steps: [{ role: 'draft', seat: 1, provider: 'claude:sonnet' }] })
 * console.log(JSON.stringify(m.steps), JSON.stringify(m.failures))
 * // => [{"role":"draft","seat":1,"provider":"claude:sonnet"}] []
 *
 * try { makeProduced({ stamp: null, stage: 'Summarize', seat: 'a', provider: 'b', pkg: 'x@1.0.0' }) } catch (e) { console.log(e.message) }
 * // => invalid o.stage: must be a lowercase kebab-case name
 *
 * let n = makeProduced({ stamp: null, stage: 'note-fix', seat: null, provider: null, pkg: 'w-demo-kb@1.0.10', at: '2026-11-08T20:12:31+08:00' })
 * console.log(JSON.stringify(n))
 * // => {"v":1,"stamp":null,"stage":"note-fix","seat":null,"provider":null,"pkg":"w-demo-kb@1.0.10","at":"2026-11-08T20:12:31+08:00"}
 *
 * try { makeProduced({ stamp: null, stage: 'note-fix', seat: 'demo.ai', provider: null, pkg: 'w-demo-kb@1.0.10' }) } catch (e) { console.log(e.message) }
 * // => invalid o.seat and o.provider: must be both non-empty strings or both null
 */
export function makeProduced(o) {
    return producedOf(o, 'o', false)
}

/**
 * 把一筆 produced 追加到記錄之歷史(規格 §2.3):回傳記錄應寫入之三欄,不改輸入
 *
 * - producedHistory:舊→新排列,最末筆即 produced;每次寫入(新建或改寫)追加一筆
 * - 超過上限(預設 50)時捨去最舊者,捨去數累計於 producedHistoryDropped
 * - 舊記錄(無 produced)從頭起算,不回填
 * - 回傳之 produced 與歷史最末筆值相同但為不同物件;歷史各筆皆為新物件(改輸出不牽動輸入)
 * - 既有歷史各筆不重新檢核形狀(只要求為一般物件;各筆於寫入當時已檢核),新的 produced 須合 §2 結構(含 v 與 at,不代填)
 * - opt.max 給了而不是正整數者視為未給、改用預設 50(輸入參數檢測機制 K3)
 *
 * @param {Object} rec 輸入記錄(可含 producedHistory、producedHistoryDropped;新記錄傳 {});其餘欄位不讀不回傳
 * @param {Object} produced 輸入欲追加之 produced(makeProduced 之產物)
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Number} [opt.max=50] 輸入保留之歷史筆數上限(正整數;收數字字串)
 * @returns {Object} 回傳 { produced, producedHistory, producedHistoryDropped }
 * @throws {Error} rec 非一般物件、rec.producedHistory 非陣列或含非一般物件之元素、rec.producedHistoryDropped 非非負整數、produced 不合 §2 時拋出
 * @example
 * let p1 = makeProduced({ stamp: '20261108100000', stage: 'note-write', seat: 'demo.ai', provider: 'a:b', pkg: 'w-demo-kb@1.0.10', at: '2026-11-08T10:00:00+08:00' })
 * let p2 = makeProduced({ stamp: '20261108110000', stage: 'note-repair', seat: 'demo.ai', provider: 'c:d', pkg: 'w-demo-kb@1.0.10', at: '2026-11-08T11:00:00+08:00' })
 * let r1 = appendProduced({}, p1)
 * let r2 = appendProduced(r1, p2)
 * console.log(r2.producedHistory.map((x) => x.stage), r2.produced.stage, r2.producedHistoryDropped)
 * // => [ 'note-write', 'note-repair' ] note-repair 0
 *
 * let r3 = appendProduced(r2, p1, { max: 2 })
 * console.log(r3.producedHistory.map((x) => x.stage), r3.producedHistoryDropped)
 * // => [ 'note-repair', 'note-write' ] 1
 */
export function appendProduced(rec, produced, opt = {}) {

    //check
    if (!isPlain(rec)) bad('rec', 'must be a plain object')
    const next = producedOf(produced, 'produced', true)
    if (!isPlain(opt)) {
        opt = {}
    }
    const max = iseint(opt.max, { use: 'count', min: 1 }) ? Number(typeof opt.max === 'string' ? opt.max.trim() : opt.max) : PRODUCED_HISTORY_MAX

    let history = []
    if (given(rec.producedHistory)) {
        if (!isarr(rec.producedHistory)) bad('rec.producedHistory', 'must be an array')
        history = rec.producedHistory.map((h, i) => {
            if (!isPlain(h)) bad(`rec.producedHistory[${i}]`, 'must be a plain object')
            return structuredClone(h)
        })
    }
    let dropped = 0
    if (given(rec.producedHistoryDropped)) {
        if (!iseint(rec.producedHistoryDropped, { min: 0 })) bad('rec.producedHistoryDropped', 'must be a non-negative integer')
        dropped = Number(typeof rec.producedHistoryDropped === 'string' ? rec.producedHistoryDropped.trim() : rec.producedHistoryDropped)
    }

    history.push(structuredClone(next))
    if (history.length > max) {
        const n = history.length - max
        history.splice(0, n)
        dropped += n
    }
    return { produced: next, producedHistory: history, producedHistoryDropped: dropped }
}

/** 套件版之快取:模組所在資料夾(絕對路徑) → 'name@version' 或 null(找不到、無法解析) */
const PKG_CACHE = new Map()

/**
 * 讀一個 package.json 並判定其類別
 *
 * @param {String} file 輸入 package.json 路徑
 * @returns {Object} 回傳 { kind:'id'(有 name 與 version), id } 或 { kind:'none'(不存在,或可解析但無 name 或 version——如範圍標記 { "type": "module" },皆續往上找) }
 *   或 { kind:'bad'(讀不了或壞 JSON;不再上溯) }
 */
function readPkgFile(file) {
    let text
    try {
        text = fs.readFileSync(file, 'utf8')
    }
    catch (e) {
        return { kind: ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(e?.code) ? 'none' : 'bad' }
    }
    let j
    try {
        j = JSON.parse(text.replace(/^\uFEFF/, ''))
    }
    catch {
        return { kind: 'bad' }
    }
    if (isPlain(j) && isTextual(j.name) && isTextual(j.version)) return { kind: 'id', id: `${j.name}@${j.version}` }
    return { kind: 'none' }
}

/**
 * 自某資料夾往上找套件版並快取沿途各資料夾
 *
 * @param {String} start 輸入起點資料夾(絕對路徑)
 * @returns {String|null} 回傳 'name@version';找不到或最近之 package.json 無法解析回 null
 */
function pkgIdOfDir(start) {
    const visited = []
    let dir = start
    let found = null
    for (;;) {
        if (PKG_CACHE.has(dir)) {
            found = PKG_CACHE.get(dir)
            break
        }
        visited.push(dir)
        const r = readPkgFile(path.join(dir, 'package.json'))
        if (r.kind === 'id') {
            found = r.id
            break
        }
        if (r.kind === 'bad') break // 寧缺勿錯:壞檔不上溯,以免把本套件記成外層之別的套件
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
    }
    for (const d of visited) PKG_CACHE.set(d, found)
    return found
}

/**
 * 自模組位置往上找最近之 package.json,回傳 `name@version`(規格 §5.3)
 *
 * - 路徑以 fileURLToPath 解析(不用 new URL(...).pathname,以免空白與中文被當編碼字串)
 * - 結果快取(行程內):同一資料夾與其子資料夾不重讀 package.json;「找不到」亦快取——行程中途改了 package.json 不會反映
 * - 最近之 package.json 若只是範圍標記(可解析但缺 name 或 version,如 { "type": "module" })則略過、續往上找;
 *   若無法解析(壞 JSON、讀不了)則回 null、不再上溯
 * - 【dist(UMD)下之行為】Node 載入之 UMD 內,rollup 把 import.meta.url 改寫為指向該 dist 檔之 file URL(`pathToFileURL(__filename)`),
 *   dist 位於套件目錄內,故往上仍找得到同一套件之 package.json,與原始碼下結果相同;
 *   瀏覽器載入之 UMD 或任何非 file: 之 URL 取不到磁碟位置,回 null(不拋錯)
 *
 * @param {String} importMetaUrl 輸入呼叫端模組之 import.meta.url
 * @returns {String|null} 回傳 'name@version';取不到回 null(非 file: URL、祖先皆無 package.json、最近之 package.json 無法解析)
 * @throws {Error} importMetaUrl 非字串、空字串、非 URL 之字串或 Windows 路徑(誤給路徑)時拋出
 * @example
 * console.log(pkgIdOf(import.meta.url))
 * // => w-knowledge-capture@1.0.12
 *
 * console.log(pkgIdOf('https://example.com/dist/w-x.umd.js'))
 * // => null
 *
 * try { pkgIdOf('not a url') } catch (e) { console.log(e.message) } //誤給路徑(而非 import.meta.url)亦同
 * // => invalid importMetaUrl: must be a URL string (import.meta.url)
 */
export function pkgIdOf(importMetaUrl) {

    //check
    const MSG = 'must be a URL string (import.meta.url)'
    if (!isTextual(importMetaUrl) || /^[A-Za-z]:[\\/]/.test(importMetaUrl)) bad('importMetaUrl', MSG)
    let url
    try {
        url = new URL(importMetaUrl)
    }
    catch {
        bad('importMetaUrl', MSG)
    }
    if (url.protocol !== 'file:') return null
    let file
    try {
        file = fileURLToPath(url)
    }
    catch {
        return null
    }
    return pkgIdOfDir(path.dirname(file))
}
