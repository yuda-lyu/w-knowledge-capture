// cs12Fix.mjs — 檢定標準 CS12(領域標籤與線索值為正體)之存量處置:預演(plan)→ 套用(apply;處置帳可回退)→ 連鎖斷言(verify)→ 回退(rollback)
//
// 【目標取自符合度掃描】與每輪掃描同一判定(standards/audit 之 CS12:全部領域標籤、pending 線索之值〔網址不計〕):只處置現行違反者
//   (已豁免者不在其列;豁免登錄之物件為 audit 之 CS12_HOLD_OBJECT)。
// 【修法與判定同一定義】領域標籤 toTw(與自動領域入庫同一轉換,stages/areaStage;判定亦看整個標籤);線索值 toTwKeepLinks
//   (網址與 [[連結]] 不轉——判定亦不計之,core/standards/textForms 之 FOREIGN_SPAN_RE)。轉換後仍違反者不寫(列 unfixable,不留半套)。
// 【種子領域不寫庫】種子領域之標籤以安裝方之種子(cfg.data.gridTopics)為準,每輪同步覆寫(stores/areaPolicy.syncSeedAreas):
//   改庫下輪即被改回 → 列 unfixable(請改種子)。registry 之 CS12 亦明載「種子之違反由安裝方改種子」。
// 【線索鍵不得因此改變】線索 id 為入庫時之 clueKey(型別, 值)(core/stores/frontierPolicy;鍵已含線索折疊,簡繁同鍵):轉換後之值算出之鍵
//   須等於記錄 id——不等者(如線索折疊未啟用)就地改值會使日後同一線索另建一筆、去重失效 → 列 unfixable,不寫。
// 【修不了者】登錄使用者待判 CS12_HOLD_OBJECT:<物件 id>:CS12(core/stores/holds 之 holdStockUnfixable;原因「存量修不了（CS12）：…」、下一步
//   CS12_HOLD_NEXT、期限 CS12_HOLD_DEADLINE_DAYS 天);已有未結或已豁免者不重登;未開 holds 集合者列 errors(不靜默)。符合度掃描以同一鍵認豁免。
//   已不再違反者(標籤或線索值已改正、記錄已不在、線索已非 pending)之未結登錄,由預演列出(resolvable)、套用結案——掃描唯讀、不會結案。
// 【處置帳】帳協定(core/stores/stockLedger;四工作與使用端同一本帳):值列 { at, object:'area'|'clue', id, stds:['CS12'], before:{ label|value },
//   after:{ label|value } }、待判列與結案列(core/stores/holds 檔頭之形狀);給 opt.ledgerFile 者逐件附寫(先寫入、即記帳、再回驗——中途中止亦留
//   已寫者)。本模組之列＝stds 含 CS12 之值列,及登錄鍵之物件為 CS12_HOLD_OBJECT 之待判列與結案列(讀帳、連鎖斷言、回退同一判定;他模組之列略過)。
//   讀帳(readCs12Ledger)遇無法解析之列即拋(allowBad 才略過);回退依帳逆序還原並附寫回退列 { at, rollbackOf, object, id }。
// 【回退＝撤銷該次處置之效果】值列以回退防護(帳協定之 rollbackPlanOf)還原:欄位＝after 者寫回 before、已＝before 者視為已完成;其後被改動或記錄
//   已不在 → 衝突(不覆寫、不記回退列;opt.acceptCurrent 記取代列);待判列只動同一登錄(core/stores/holds 之 rollbackStockHold)。
// 【字形政策依語言設定】判定與修正經 opt.locale(core/locale 之 scriptOf;未給＝臺灣正體):語言設定非繁體中文時掃描列不適用、無違反可處置。
// 【呼叫端負責】取執行鎖、一致備份、使用者同意(正式庫)。本模組不呼叫 AI。

import isarr from 'wsemi/src/isarr.mjs'
import isobj from 'wsemi/src/isobj.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import { withoutForeignSpans } from '../core/standards/textForms.mjs'
import { scriptOf } from '../core/locale.mjs'
import { clueKey } from '../core/stores/frontierPolicy.mjs'
import { holdKey, holdDeadlineOf, holdStockUnfixable, closeStockHold, rollbackStockHold, reopenStockHold, stockHoldProblems } from '../core/stores/holds.mjs'
import { stockAtOf, stockLedgerRowsOf, stockLedgerWriter, appendRollbackRow, rollbackPlanOf, rollbackWriteOf, writeRollback, stockErrorOf } from '../core/stores/stockLedger.mjs'
import { strOf as str } from '../core/util/values.mjs'
import { auditCaptureStandards, CS12_HOLD_OBJECT } from './audit.mjs'

/** 修不了者之待判之下一步 */
export const CS12_HOLD_NEXT = '使用者判讀：豁免（waiveHold：維持現狀，符合度掃描即記已豁免）；已不再違反者（標籤或線索值已改正，種子領域改種子之標籤）於下次存量處置之套用時結案'

/** 修不了者之待判之期限天數 */
export const CS12_HOLD_DEADLINE_DAYS = 30

/** 各物件之欄位與集合(與掃描同一定義;檔頭) */
const KINDS = {
    area: { store: 'areas', field: 'label' },
    clue: { store: 'frontier', field: 'value' },
}

/**
 * 各物件之判定／修正(依字形政策;與掃描同一定義):領域標籤整個判與修、線索值網址與 [[連結]] 不計不轉
 *
 * @param {*} locale 輸入 opt.locale(語言設定或字形政策;未給＝臺灣正體)
 * @returns {Object} 回傳 { area:{ fix, problems }, clue:{ fix, problems } }
 */
function kindFnsOf(locale) {
    const script = scriptOf(locale, 'opt.locale')
    return {
        area: { fix: (v) => script.fix(v), problems: (v) => script.problems(v) },
        clue: { fix: (v) => script.fixKeepLinks(v), problems: (v) => script.problems(withoutForeignSpans(v)) },
    }
}

/**
 * 是否為本模組之帳列:stds 含 CS12 之值列(area／clue),或登錄鍵之物件為 CS12_HOLD_OBJECT 之待判列與結案列(讀帳、連鎖斷言、回退同一判定)
 *
 * @param {*} r 輸入帳列
 * @returns {Boolean} 回傳是否為本模組之列
 */
function isCs12Row(r) {
    if (!isobj(r) || r.rollbackOf || !isarr(r.stds) || !r.stds.includes('CS12')) return false
    if (Object.hasOwn(KINDS, str(r.object))) return true
    return (r.object === 'hold' || r.object === 'hold-resolved') && str(r.hold || r.id).startsWith(`${CS12_HOLD_OBJECT}:`)
}

/**
 * 字形問題之簡述(修不了之說明用)
 *
 * @param {Object} pr 輸入 scriptProblems 之產物
 * @returns {String} 回傳簡述
 */
function problemsNote(pr) {
    const parts = [...pr.only.map((x) => x.c), ...pr.practical.map((x) => x.c), ...pr.phrases.map((x) => x.cn)]
    return [...new Set(parts)].slice(0, 8).join('、')
}

/**
 * 一件之處置判定(預演與套用同一判定;套用時以現值重算)
 *
 * @param {String} object 輸入 'area'|'clue'
 * @param {Object} rec 輸入現值記錄
 * @param {Object} fns 輸入 kindFnsOf 之產物(判定與修正)
 * @returns {Object} 回傳 { ok:true, field, before, after } 或 { ok:false, detail }
 */
function fixOf(object, rec, fns) {
    const k = KINDS[object]
    const f = fns[object]
    const before = str(rec?.[k.field])
    if (object === 'area' && rec?.origin === 'seed') {
        return { ok: false, detail: `種子領域之標籤以種子(cfg.data.gridTopics)為準,每輪同步覆寫;請改種子之標籤「${before}」` }
    }
    const after = f.fix(before)
    if (after === before) return { ok: false, detail: `轉正體無變化而仍違反（${problemsNote(f.problems(before))}）` }
    const left = f.problems(after)
    if (left.count) return { ok: false, detail: `轉正體後仍有字形問題（${problemsNote(left)}），未寫入` }
    if (object === 'clue' && clueKey(rec.type, after) !== str(rec.id)) {
        return { ok: false, detail: `轉正體後之線索鍵與記錄 id 不同(線索折疊未啟用?);就地改值會使同一線索另建一筆,未寫入` }
    }
    return { ok: true, field: k.field, before, after }
}

/**
 * 違反 id 之物件(先查領域、再查線索;兩集合之 id 互不重疊:領域 id 由查詢雜湊、線索 id 由型別與值雜湊)
 *
 * @param {Object} stores 輸入集合
 * @param {String} id 輸入物件 id
 * @returns {Promise} 回傳 Promise,resolve 回傳 { object, rec } 或 null
 */
async function recordOf(stores, id) {
    const a = isfun(stores.areas?.get) ? await stores.areas.get(id) : null
    if (a) return { object: 'area', rec: a }
    const f = isfun(stores.frontier?.get) ? await stores.frontier.get(id) : null
    if (f) return { object: 'clue', rec: f }
    return null
}

/**
 * 預演:列出各件之處置(不寫任何東西)
 *
 * @param {Object} stores 輸入集合 { areas?(select／get), frontier?(select／get), holds?(使用者豁免、已登錄之待判) }(areas、frontier 至少其一)
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Array} [opt.ids] 輸入只處置這些物件 id(已不再違反之未結登錄亦只取這些物件)
 * @param {Integer} [opt.limit] 輸入至多處置幾件(正整數;依掃描之序,達上限即停;修不了者不計入)
 * @param {Object} [opt.locale] 輸入語言設定或字形政策(總組裝之 info().locale;未給＝臺灣正體;非繁體中文之語言無違反可處置)
 * @returns {Promise} 回傳 Promise,resolve 回傳 { std:'CS12', items:[{ object:'area'|'clue', id, field, before, after }],
 *   unfixable:[{ object, id, std:'CS12', detail }], resolvable:[{ key, id, std:'CS12' }](已不再違反之未結登錄;套用時結案),
 *   counts:{ violations(掃描之違反數), items, unfixable, resolvable } }
 * @throws {Error} stores 既無 areas 亦無 frontier 集合時拋出
 * @example
 * need test in nodejs.
 *
 * const plan = await planCs12Fix({ areas, frontier, holds })
 * console.log(plan.items.map((x) => [x.id, x.before, x.after]))
 */
export async function planCs12Fix(stores, opt = {}) {

    //check
    if (!isobj(stores) || (!isfun(stores.areas?.select) && !isfun(stores.frontier?.select))) {
        throw new Error('planCs12Fix 需要 stores.areas 或 stores.frontier（具 select／get 方法）')
    }
    if (!isobj(opt)) {
        opt = {}
    }

    const only = isarr(opt.ids) && opt.ids.length ? new Set(opt.ids.map(String)) : null
    const limit = Number.isInteger(opt.limit) && opt.limit > 0 ? opt.limit : Infinity
    const fns = kindFnsOf(opt.locale)
    // 掃描必讀文件(各文件標準之計數);CS12 不看文件——交空集合替身,不全表讀正式之文件
    const audit = await auditCaptureStandards({ stores: { ...stores, docs: { select: async () => [] } }, locale: opt.locale }, { only: ['CS12'] })
    const cs12 = audit.standards.CS12 || { violation: 0, violations: [] }
    const items = []
    const unfixable = []
    const resolvable = []
    for (const v of cs12.violations) {
        const id = str(v.id)
        if (only && !only.has(id)) continue
        if (items.length >= limit) break
        const got = await recordOf(stores, id)
        if (!got) {
            unfixable.push({ object: '', id, std: 'CS12', detail: '記錄不在' })
            continue
        }
        const f = fixOf(got.object, got.rec, fns)
        if (f.ok) items.push({ object: got.object, id, field: f.field, before: f.before, after: f.after })
        else unfixable.push({ object: got.object, id, std: 'CS12', detail: f.detail })
    }
    // 已不再違反之未結登錄:掃描之違反(全部,不受 ids／limit 限)已無該物件者;套用時結案
    if (isfun(stores.holds?.select)) {
        const violating = new Set(cs12.violations.map((v) => str(v.id)))
        for (const h of await stores.holds.select()) {
            if (h?.object !== CS12_HOLD_OBJECT || h.std !== 'CS12' || h.status !== 'open') continue
            const oid = str(h.oid)
            if (violating.has(oid) || (only && !only.has(oid))) continue
            resolvable.push({ key: str(h.id) || holdKey(CS12_HOLD_OBJECT, oid, 'CS12'), id: oid, std: 'CS12' })
        }
    }
    return { std: 'CS12', items, unfixable, resolvable, counts: { violations: cs12.violation || 0, items: items.length, unfixable: unfixable.length, resolvable: resolvable.length } }
}

/**
 * 套用預演之計畫:值逐件以現值重算(fixOf;已合格或已不在者列 stale,現值修不了者列 errors),寫入、即記帳、再回驗;已不再違反之未結登錄結案;
 *   修不了者登錄使用者待判(已有未結或已豁免者不重登)
 *
 * @param {Object} stores 輸入集合 { areas?(get／patch), frontier?(get／patch), holds?(待判;計畫有修不了者或待結案者而未開 → 列 errors) }
 * @param {Object} plan 輸入 planCs12Fix 之產物(取 items、unfixable 中 std 為 CS12 者、resolvable 中 std 為 CS12 者;他模組之項略過)
 * @param {Object} [opt={}] 輸入設定物件
 * @param {String} [opt.at] 輸入處置時刻 ISO(帳列之 at、待判之登錄與結案時刻;預設現在)
 * @param {String} [opt.ledgerFile] 輸入處置帳(JSONL)絕對路徑;給了即逐件附寫(未給者只收於回傳之 ledger)
 * @param {Object} [opt.locale] 輸入語言設定或字形政策(與預演同一份;未給＝臺灣正體)
 * @returns {Promise} 回傳 Promise,resolve 回傳 { at, applied:{ CS12:件數 }, fixed:Array(本次改寫之 id), stale:Array, held:[{ key, id, std }](新登錄之待判),
 *   alreadyHeld:Array(已有未結或已豁免之登錄鍵), resolved:Array(結案之登錄鍵), errors:[{ id, object, error }], ledger:Array(帳列), ledgerFile }
 * @throws {Error} stores 非物件時拋出
 * @example
 * need test in nodejs.
 *
 * const r = await applyCs12Fix({ areas, frontier, holds }, plan, { at: clock.iso8(), ledgerFile: path.join(dirs.state, STOCK_LEDGER_FILE) })
 * console.log(r.fixed, r.held)
 */
export async function applyCs12Fix(stores, plan, opt = {}) {

    //check
    if (!isobj(stores)) {
        throw new Error('applyCs12Fix 需要 stores（領域 areas 或線索 frontier 集合,具 get／patch 方法）')
    }
    if (!isobj(opt)) {
        opt = {}
    }

    const at = stockAtOf(null, opt)
    const ledgerFile = isestr(opt.ledgerFile) ? opt.ledgerFile : ''
    const w = stockLedgerWriter(ledgerFile, at)
    const fns = kindFnsOf(opt.locale)
    const fixed = []
    const stale = []
    const held = []
    const alreadyHeld = []
    const resolved = []
    const errors = []
    for (const it of isarr(plan?.items) ? plan.items : []) {
        const object = str(it?.object)
        const id = str(it?.id)
        try {
            const k = KINDS[object]
            if (!k) throw new Error(`不明之物件「${object}」`)
            const store = stores[k.store]
            if (!isfun(store?.get) || !isfun(store?.patch)) throw new Error(`缺 ${k.store} 集合(具 get／patch 方法)`)
            const cur = await store.get(id)
            if (!cur || !fns[object].problems(str(cur[k.field])).count) {
                stale.push(id)
                continue
            }
            const f = fixOf(object, cur, fns)
            if (!f.ok) throw new Error(f.detail)
            await store.patch(id, { [f.field]: f.after })
            w.log({ object, id, stds: ['CS12'], before: { [f.field]: f.before }, after: { [f.field]: f.after } })
            if (str((await store.get(id))?.[f.field]) !== f.after) throw new Error('寫入後回驗不符')
            fixed.push(id)
        }
        catch (e) {
            errors.push(stockErrorOf(id, object, e))
        }
    }

    // 已不再違反之未結登錄:結案(帳記結案前之登錄,回退時復原)
    for (const x of (isarr(plan?.resolvable) ? plan.resolvable : []).filter((y) => str(y?.std) === 'CS12')) {
        const key = str(x.key)
        try {
            if (await closeStockHold(stores.holds, key, 'CS12', { at, log: w.log })) resolved.push(key)
        }
        catch (e) {
            errors.push(stockErrorOf(key, CS12_HOLD_OBJECT, e))
        }
    }

    // 修不了者:逐件登錄使用者待判(已有未結或已豁免者不重登);未開 holds 集合 → errors(不靜默)
    for (const u of (isarr(plan?.unfixable) ? plan.unfixable : []).filter((y) => str(y?.std) === 'CS12')) {
        const id = str(u.id)
        try {
            const h = { object: CS12_HOLD_OBJECT, oid: id, std: 'CS12', detail: str(u.detail), next: CS12_HOLD_NEXT, owner: 'user', deadline: holdDeadlineOf(at, CS12_HOLD_DEADLINE_DAYS) }
            const r = await holdStockUnfixable(stores.holds, h, { at, log: w.log })
            if (r.held) held.push({ key: r.key, id, std: 'CS12' })
            else alreadyHeld.push(r.key)
        }
        catch (e) {
            errors.push(stockErrorOf(id, CS12_HOLD_OBJECT, e))
        }
    }
    return { at, applied: { CS12: fixed.length }, fixed, stale, held, alreadyHeld, resolved, errors, ledger: w.rows, ledgerFile }
}

/**
 * 套用後之連鎖斷言:值列——記錄仍在且欄位現值＝帳列之 after(未被他處改寫);待判列——已登錄;結案列——已結案。他模組之列略過
 *
 * @param {Object} stores 輸入集合 { areas?(get), frontier?(get), holds?(get) }
 * @param {Array} rows 輸入帳列(applyCs12Fix 之 ledger,或 readCs12Ledger 之產物;他模組之列略過)
 * @returns {Promise} 回傳 Promise,resolve 回傳 { checked:Integer(驗過之本模組帳列數), problems:Array(字串) }
 * @example
 * need test in nodejs.
 *
 * const r = await applyCs12Fix(stores, plan, { at })
 * console.log((await verifyCs12Chain(stores, r.ledger)).problems)
 * // => []
 */
export async function verifyCs12Chain(stores, rows) {
    const st = isobj(stores) ? stores : {}
    let checked = 0
    const problems = []
    for (const r of (isarr(rows) ? rows : []).filter(isCs12Row)) {
        checked++
        if (r.object === 'hold' || r.object === 'hold-resolved') {
            problems.push(...(await stockHoldProblems(st.holds, r)))
            continue
        }
        const k = KINDS[r.object]
        const store = st[k.store]
        if (!isfun(store?.get)) {
            problems.push(`${r.object} ${r.id}：未開 ${k.store} 集合，無從驗證`)
            continue
        }
        const cur = await store.get(r.id)
        const want = str(r.after?.[k.field])
        if (!cur) problems.push(`${r.object} ${r.id}：不在`)
        else if (str(cur[k.field]) !== want) problems.push(`${r.object} ${r.id}：${k.field} 為「${str(cur[k.field])}」，非處置後之「${want}」（被他處改寫？）`)
    }
    return { checked, problems }
}

/**
 * 讀處置帳(JSONL;帳協定):本模組之列(值列、待判列與結案列),排除回退列與已被回退者;檔案不存在回空陣列
 *
 * @param {String} file 輸入處置帳絕對路徑
 * @param {Object} [opt={}] 輸入設定物件
 * @param {String} [opt.since] 輸入只取此時刻起之列(以時刻比較)
 * @param {String} [opt.at] 輸入只取此時刻之列(某次套用之列;連鎖斷言用)
 * @param {Boolean} [opt.allowBad=false] 輸入有無法解析之列時是否略過(預設即拋)
 * @returns {Array} 回傳列陣列(依檔內順序)
 * @throws {Error} 帳有無法解析之列而未給 allowBad 時拋出(訊息列行號)
 * @example
 * import fs from 'fs'
 * fs.mkdirSync('./tmp', { recursive: true })
 * const row = { at: '2026-09-01T00:00:00Z', object: 'area', id: 'a1', stds: ['CS12'], before: { label: '黑洞光谱' }, after: { label: '黑洞光譜' } }
 * const other = { at: '2026-09-01T00:00:00Z', object: 'doc', id: 'd2', stds: ['CS10'], before: {}, after: {} }
 * fs.writeFileSync('./tmp/ledger.jsonl', [row, other].map((r) => JSON.stringify(r)).join('\n') + '\n')
 * console.log(readCs12Ledger('./tmp/ledger.jsonl').map((r) => [r.object, r.id, r.after.label]))
 * // => [ [ 'area', 'a1', '黑洞光譜' ] ]
 * console.log(readCs12Ledger('./tmp/not-exist.jsonl'))
 * // => []
 */
export function readCs12Ledger(file, opt = {}) {
    if (!isobj(opt)) opt = {}
    return stockLedgerRowsOf(file, { since: opt.since, at: opt.at, allowBad: opt.allowBad, keep: isCs12Row })
}

/**
 * 回退(檔頭【回退＝撤銷該次處置之效果】):依帳逆序還原(本模組之列;他模組之列略過——restored 0、不報錯):值列以回退防護還原並回驗;
 *   待判列只動同一登錄(其後之裁示、他次登錄不被改寫);結案列——仍為本次所結者復原為結案前之登錄;給 opt.ledgerFile 者逐件附寫回退列
 *
 * @param {Object} stores 輸入集合 { areas?(get／patch／replace), frontier?(get／patch／replace), holds?(待判列、結案列;未開者列 errors) }
 * @param {Array} rows 輸入帳列(applyCs12Fix 之 ledger,或 readCs12Ledger 之產物)
 * @param {Object} [opt={}] 輸入設定物件
 * @param {String} [opt.at] 輸入回退時刻 ISO(回退列之 at、待判結案時刻;預設現在)
 * @param {String} [opt.ledgerFile] 輸入處置帳(JSONL)絕對路徑;給了即逐件附寫回退列
 * @param {Boolean} [opt.acceptCurrent=false] 輸入衝突之值列是否接受現值(記取代列 { accepted:'current', units }、不寫值)
 * @returns {Promise} 回傳 Promise,resolve 回傳 { restored:Integer, accepted:Integer, conflicts:[{ id, object, units }], errors:[{ id, object, error }] }
 * @throws {Error} stores 非物件時拋出
 * @example
 * const map = new Map([['a1', { id: 'a1', label: '黑洞光譜' }]])
 * const areas = {
 *     get: async (id) => (map.has(id) ? { ...map.get(id) } : null),
 *     patch: async (id, fields) => { Object.assign(map.get(id), fields) },
 *     replace: async (rec) => { map.set(rec.id, { ...rec }) },
 * }
 * const rows = [{ at: '2026-09-01T00:00:00Z', object: 'area', id: 'a1', stds: ['CS12'], before: { label: '黑洞光谱' }, after: { label: '黑洞光譜' } }]
 * const r = await rollbackCs12Fix({ areas }, rows, { at: '2026-09-02T00:00:00Z' })
 * console.log(r)
 * // => { restored: 1, accepted: 0, conflicts: [], errors: [] }
 * console.log(map.get('a1'))
 * // => { id: 'a1', label: '黑洞光谱' }
 */
export async function rollbackCs12Fix(stores, rows, opt = {}) {

    //check
    if (!isobj(stores)) {
        throw new Error('rollbackCs12Fix 需要 stores（領域 areas 或線索 frontier 集合,具 get／patch／replace 方法）')
    }
    if (!isobj(opt)) {
        opt = {}
    }

    const at = stockAtOf(null, opt)
    const ledgerFile = isestr(opt.ledgerFile) ? opt.ledgerFile : ''
    let restored = 0
    let accepted = 0
    const conflicts = []
    const errors = []
    for (const r of [...(isarr(rows) ? rows : [])].filter(isCs12Row).reverse()) {
        try {
            if (r.object === 'hold') await rollbackStockHold(stores.holds, r, at)
            else if (r.object === 'hold-resolved') await reopenStockHold(stores.holds, r)
            else {
                const k = KINDS[r.object]
                if (!isobj(r.before)) throw new Error(`${r.object} ${r.id} 之帳列缺 before（處置前之值），無從還原`)
                const store = stores[k.store]
                if (!isfun(store?.get) || !isfun(store?.patch) || !isfun(store?.replace)) throw new Error(`缺 ${k.store} 集合(具 get／patch／replace 方法)`)
                const cur = await store.get(r.id)
                const plan = rollbackPlanOf(cur, r)
                if (!cur || plan.conflict.length) {
                    const units = cur ? plan.conflict : ['（記錄不在）']
                    if (opt.acceptCurrent === true) {
                        appendRollbackRow(ledgerFile, r, at, { accepted: 'current', units })
                        accepted++
                    }
                    else conflicts.push({ id: r.id, object: r.object, units })
                    continue
                }
                if (plan.restore.length) {
                    await writeRollback(store, cur, rollbackWriteOf(r, plan.restore))
                    const back = rollbackPlanOf(await store.get(r.id), r)
                    if (back.restore.length || back.conflict.length) throw new Error(`${r.object} ${r.id} 還原後回驗不符`)
                }
            }
            appendRollbackRow(ledgerFile, r, at)
            restored++
        }
        catch (e) {
            errors.push(stockErrorOf(r.id, r.object, e))
        }
    }
    return { restored, accepted, conflicts, errors }
}

export default { CS12_HOLD_NEXT, CS12_HOLD_DEADLINE_DAYS, planCs12Fix, applyCs12Fix, verifyCs12Chain, readCs12Ledger, rollbackCs12Fix }
