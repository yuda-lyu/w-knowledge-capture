// cs10Fix.mjs — 檢定標準 CS10(同一內容只入庫一次)之存量處置:預演(plan)→ 套用(apply;處置帳可回退)→ 連鎖斷言(verify)→ 回退(rollback)
//
// 【目標取自符合度掃描】與管線、掃描同一組判定(standards/audit 之 CS10):只處置現行違反者(已豁免者不在其列)。群之合併與留存者之選定
//   沿用 ops/docStockFix(mergeDupGroups;dupPlanOf——只處置與留存者直接相連者,其餘列 deferred 不動,下輪重掃再依其自身之重疊成群)。
// 【只動文件,不刪筆記】他份之文件改 skip,與新進之 CS10 同一處置欄位(stores/contentIndex.sameContentPatch:skipKind duplicate、
//   skipReason;dupOf 記留存者)。筆記屬下游(摘要)之產物,本模組不碰:套用之回傳列出「這些文件之筆記須由呼叫端處置」(notesToHandle;
//   宜以刪筆記之正規路徑撤除、可還原)——只改文件而筆記仍在,知識庫仍見同一內容兩份。
// 【留存者】給了筆記集合(stores.notes)者依 ①筆記已被下游消化 ②有筆記 ③較早成筆記(文件之 notedAt)④id;未給者只依 ③④
//   (筆記之欄位經 core/stores/noteFields 讀)。
// 【預設以原文補算】無段落雜湊之 noted 文件以原文補算後比對(opt.material 預設 true),與每輪符合度掃描同一口徑——否則掃描報出之群
//   有一部分處置不到。
// 【同一內容索引】改 skip 與回退時同步本行程已建之索引(contentIndexIfBuilt;同維護子階段)——否則同行程之後續入庫仍以已改 skip 者為錨。
// 【處置帳】帳協定(core/stores/stockLedger;四工作與使用端同一本帳):逐件 { at, object:'doc', id, stds:['CS10'], before, after }——after 為寫入之欄位、
//   before 為其處置前之值(處置前不存在之欄位不列);給 opt.ledgerFile 者逐件附寫(先寫入、即記帳、再回驗——中途中止亦留已寫者)。本模組之列＝文件列且
//   stds 含 CS10(讀帳、連鎖斷言、回退同一判定;他模組之列略過)。讀帳(readCs10Ledger)遇無法解析之列即拋(allowBad 才略過)。
// 【回退＝撤銷該次處置之效果】依帳逆序逐列以回退防護(帳協定之 rollbackPlanOf)還原:欄位＝after 者寫回 before(處置前不存在者刪除)、已＝before 者
//   視為已完成;其後被改動之欄位或文件已不在 → 衝突(不覆寫、不記回退列;opt.acceptCurrent 記取代列);缺 after 之列即錯。
// 【呼叫端負責】取執行鎖、一致備份、使用者同意(正式庫)。本模組不呼叫 AI。

import isarr from 'wsemi/src/isarr.mjs'
import isobj from 'wsemi/src/isobj.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import { mergeDupGroups, dupPlanOf } from '../ops/docStockFix.mjs'
import { noteDocIdOf } from '../core/stores/noteFields.mjs'
import { stockAtOf, stockLedgerRowsOf, stockLedgerWriter, appendRollbackRow, rollbackPlanOf, rollbackWriteOf, writeRollback, stockErrorOf } from '../core/stores/stockLedger.mjs'
import { strOf as str } from '../core/util/values.mjs'
import { sameContentPatch, contentIndexIfBuilt } from '../stores/contentIndex.mjs'
import { auditCaptureStandards, GROUP_ID_SEP } from './audit.mjs'

/**
 * 本行程已建之同一內容索引(未建回 null:下次建立即讀到最新記錄)
 *
 * @param {Object} docs 輸入 docs 集合
 * @returns {Promise} 回傳 Promise,resolve 回傳索引或 null
 */
async function builtIndexOf(docs) {
    const p = contentIndexIfBuilt(docs)
    return p ? await p : null
}

/**
 * 是否為本模組之帳列:文件列且 stds 含 CS10(讀帳、連鎖斷言、回退同一判定)
 *
 * @param {*} r 輸入帳列
 * @returns {Boolean} 回傳是否為本模組之列
 */
function isCs10Row(r) {
    return isobj(r) && !r.rollbackOf && r.object === 'doc' && isarr(r.stds) && r.stds.includes('CS10')
}

/**
 * 預演:列出各群之處置(不寫任何東西)
 *
 * @param {Object} stores 輸入集合 { docs(select／get), docTexts?, notes?(select;未給則以文件之 notedAt 定留存者), holds?(使用者豁免) }
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Array} [opt.ids] 輸入只處置含這些文件 id 之群
 * @param {Integer} [opt.limit] 輸入至多幾群(正整數)
 * @param {Boolean} [opt.material=true] 輸入無段落雜湊之 noted 文件是否以原文補算後比對;false 時該等文件不成群
 * @returns {Promise} 回傳 Promise,resolve 回傳 { std:'CS10', notesRead:Boolean,
 *   groups:[{ id, ids, keeper, keeperNote, others:[{ doc, note, consumed }], skipDocs, deferred }],
 *   counts:{ violations(掃描之違反群數), undetermined(掃描之未能判定數), groups, skipDocs, deferred } }
 * @throws {Error} stores.docs 缺 select／get 方法時拋出
 * @example
 * need test in nodejs.
 *
 * const plan = await planCs10Fix({ docs, docTexts, notes }, { limit: 50 })
 * console.log(plan.groups.map((g) => [g.keeper, g.skipDocs]))
 */
export async function planCs10Fix(stores, opt = {}) {

    //check
    if (!isobj(stores) || !isfun(stores.docs?.select) || !isfun(stores.docs?.get)) {
        throw new Error('planCs10Fix 需要 stores.docs（具 select／get 方法）')
    }
    if (!isobj(opt)) {
        opt = {}
    }

    const only = isarr(opt.ids) && opt.ids.length ? new Set(opt.ids.map(String)) : null
    const limit = Number.isInteger(opt.limit) && opt.limit > 0 ? opt.limit : Infinity
    const audit = await auditCaptureStandards({ stores }, { only: ['CS10'], material: opt.material !== false })
    const cs10 = audit.standards.CS10 || { violation: 0, undetermined: 0, violations: [] }
    // 原始群(網址代稱群、段落配對)保留供「只處置與留存者直接相連者」(ops/docStockFix 檔頭)
    const edges = cs10.violations.map((v) => str(v.id).split(GROUP_ID_SEP))
    const notes = isfun(stores.notes?.select) ? await stores.notes.select() : null
    const byDoc = notes ? new Map(notes.map((n) => [noteDocIdOf(n), n])) : null
    const groups = []
    for (const ids of mergeDupGroups(edges)) {
        if (only && !ids.some((x) => only.has(x))) continue
        if (groups.length >= limit) break
        const docs = new Map()
        for (const id of ids) docs.set(id, await stores.docs.get(id))
        const p = dupPlanOf(ids, { docOf: (id) => docs.get(id) || null, noteOfDoc: (id) => byDoc?.get(id) || null, edges: edges.filter((g) => g.some((x) => ids.includes(x))) })
        groups.push({ id: ids.join(GROUP_ID_SEP), ids, keeper: p.keeper, keeperNote: p.keeperNote, others: p.others, skipDocs: p.others.map((o) => o.doc), deferred: p.deferred })
    }
    return {
        std: 'CS10',
        notesRead: !!notes,
        groups,
        counts: {
            violations: cs10.violation || 0,
            undetermined: cs10.undetermined || 0,
            groups: groups.length,
            skipDocs: groups.reduce((n, g) => n + g.skipDocs.length, 0),
            deferred: groups.reduce((n, g) => n + g.deferred.length, 0),
        },
    }
}

/**
 * 套用預演之計畫:各群他份之文件改 skip(逐件以現值判斷:不在或已為 skip 者略過);逐件記處置帳;不碰筆記
 *
 * notesToHandle:處置成功之群其他份文件(本次改 skip、或已為 skip、或已不在)逐一列出——其筆記須由呼叫端撤除;note 為 null 者係
 * 預演時未給筆記集合或該文件無筆記,由呼叫端依文件 id 查。寫入失敗之文件不列(文件仍在正式集合,其筆記須保留)。
 *
 * @param {Object} stores 輸入集合 { docs(get／patch) }
 * @param {Object} plan 輸入 planCs10Fix 之產物
 * @param {Object} [opt={}] 輸入設定物件
 * @param {String} [opt.at] 輸入處置時刻 ISO(skip 之 notedAt 與帳列之 at;預設現在)
 * @param {String} [opt.ledgerFile] 輸入處置帳(JSONL)絕對路徑;給了即逐件附寫(未給者只收於回傳之 ledger)
 * @returns {Promise} 回傳 Promise,resolve 回傳 { at, applied:{ CS10:群數 }, skipped:Array(本次改 skip 之文件 id), stale:Array(不在或已為 skip 者),
 *   errors:[{ id, object, error }], ledger:Array(帳列), ledgerFile, notesToHandle:[{ doc, note, consumed, keeper, keeperNote }] }
 * @throws {Error} stores.docs 缺 get／patch 方法時拋出
 * @example
 * need test in nodejs.
 *
 * const r = await applyCs10Fix({ docs }, plan, { at: clock.iso8(), ledgerFile: path.join(dirs.state, STOCK_LEDGER_FILE) })
 * console.log(r.skipped, r.notesToHandle)
 */
export async function applyCs10Fix(stores, plan, opt = {}) {

    //check
    if (!isobj(stores) || !isfun(stores.docs?.get) || !isfun(stores.docs?.patch)) {
        throw new Error('applyCs10Fix 需要 stores.docs（具 get／patch 方法）')
    }
    if (!isobj(opt)) {
        opt = {}
    }

    const at = stockAtOf(null, opt)
    const ledgerFile = isestr(opt.ledgerFile) ? opt.ledgerFile : ''
    const w = stockLedgerWriter(ledgerFile, at)
    const idx = await builtIndexOf(stores.docs)
    let applied = 0
    const skipped = []
    const stale = []
    const errors = []
    const notesToHandle = []
    for (const g of isarr(plan?.groups) ? plan.groups : []) {
        try {
            for (const o of isarr(g?.others) ? g.others : []) {
                const did = str(o?.doc)
                const d = await stores.docs.get(did)
                if (!d || d.status === 'skip') stale.push(did)
                else {
                    // 與新進之 CS10 同一處置欄位(skipKind duplicate——來源產出統計不計為已判定);dupOf 記留存者。before 只列處置前存在之欄位(檔頭【處置帳】)
                    const after = { ...sameContentPatch({ why: `${g.keeper}；檢定標準 CS10 存量合併` }, at), dupOf: g.keeper }
                    const before = Object.fromEntries(Object.keys(after).filter((k) => Object.hasOwn(d, k) && d[k] !== undefined).map((k) => [k, d[k]]))
                    await stores.docs.patch(did, after)
                    w.log({ object: 'doc', id: did, stds: ['CS10'], before, after })
                    if ((await stores.docs.get(did))?.status !== 'skip') throw new Error(`文件 ${did} 改 skip 後回驗不符`)
                    idx?.add({ id: did, status: 'skip', skipKind: 'duplicate' })
                    skipped.push(did)
                }
                notesToHandle.push({ doc: did, note: o?.note || null, consumed: !!o?.consumed, keeper: str(g.keeper), keeperNote: g.keeperNote || null })
            }
            applied++
        }
        catch (e) {
            errors.push(stockErrorOf(g?.id, 'dup', e))
        }
    }
    return { at, applied: { CS10: applied }, skipped, stale, errors, ledger: w.rows, ledgerFile, notesToHandle }
}

/**
 * 套用後之連鎖斷言:文件列之文件仍在,且帳列 after 之各欄＝現值(未被他處改寫)。他模組之列略過
 *
 * @param {Object} stores 輸入集合 { docs(get) }
 * @param {Array} rows 輸入帳列(applyCs10Fix 之 ledger,或 readCs10Ledger 之產物;他模組之列略過)
 * @returns {Promise} 回傳 Promise,resolve 回傳 { checked:Integer(驗過之本模組帳列數), problems:Array(字串) }
 * @throws {Error} stores.docs 缺 get 方法時拋出
 * @example
 * need test in nodejs.
 *
 * const r = await applyCs10Fix({ docs }, plan, { at })
 * console.log((await verifyCs10Chain({ docs }, r.ledger)).problems)
 * // => []
 */
export async function verifyCs10Chain(stores, rows) {

    //check
    if (!isobj(stores) || !isfun(stores.docs?.get)) {
        throw new Error('verifyCs10Chain 需要 stores.docs（具 get 方法）')
    }

    let checked = 0
    const problems = []
    for (const r of (isarr(rows) ? rows : []).filter(isCs10Row)) {
        checked++
        const cur = await stores.docs.get(r.id)
        if (!cur) {
            problems.push(`文件 ${r.id}：不在`)
            continue
        }
        const after = isobj(r.after) ? r.after : {}
        const diff = Object.keys(after).filter((k) => (cur[k] ?? null) !== (after[k] ?? null))
        if (diff.length) problems.push(`文件 ${r.id}：${diff.join('、')} 與處置後之值不符（被他處改寫？）`)
    }
    return { checked, problems }
}

/**
 * 讀處置帳(JSONL;帳協定):本模組之列(文件列且 stds 含 CS10),排除回退列與已被回退者;檔案不存在回空陣列
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
 * const row = { at: '2026-09-01T00:00:00Z', object: 'doc', id: 'd2', stds: ['CS10'], before: { status: 'noted' }, after: { status: 'skip', skipKind: 'duplicate', dupOf: 'd1' } }
 * const other = { at: '2026-09-01T00:00:00Z', object: 'area', id: 'a1', stds: ['CS12'], before: {}, after: {} }
 * fs.writeFileSync('./tmp/ledger.jsonl', [row, other].map((r) => JSON.stringify(r)).join('\n') + '\n')
 * console.log(readCs10Ledger('./tmp/ledger.jsonl').map((r) => [r.id, r.after.status]))
 * // => [ [ 'd2', 'skip' ] ]
 * console.log(readCs10Ledger('./tmp/not-exist.jsonl'))
 * // => []
 */
export function readCs10Ledger(file, opt = {}) {
    if (!isobj(opt)) opt = {}
    return stockLedgerRowsOf(file, { since: opt.since, at: opt.at, allowBad: opt.allowBad, keep: isCs10Row })
}

/**
 * 回退(檔頭【回退＝撤銷該次處置之效果】):依帳逆序逐列以回退防護還原(本模組之列;他模組之列略過——restored 0、不報錯);逐件回驗;
 *   給 opt.ledgerFile 者附寫回退列(接受現值者附寫取代列)
 *
 * @param {Object} stores 輸入集合 { docs(get／patch／replace) }
 * @param {Array} rows 輸入帳列(applyCs10Fix 之 ledger,或 readCs10Ledger 之產物)
 * @param {Object} [opt={}] 輸入設定物件
 * @param {String} [opt.at] 輸入回退列之時刻 ISO(預設現在)
 * @param {String} [opt.ledgerFile] 輸入處置帳(JSONL)絕對路徑;給了即逐件附寫回退列
 * @param {Boolean} [opt.acceptCurrent=false] 輸入衝突之列是否接受現值(記取代列 { accepted:'current', units }、不寫值)
 * @returns {Promise} 回傳 Promise,resolve 回傳 { restored:Integer, accepted:Integer(接受現值之列數), conflicts:[{ id, object:'doc', units }](其後被改動之欄位;
 *   文件已不在者 units 為 ['（記錄不在）']), errors:[{ id, object, error }] }
 * @throws {Error} stores.docs 缺 get／patch／replace 方法時拋出
 * @example
 * const map = new Map([['d2', { id: 'd2', status: 'skip', skipKind: 'duplicate', dupOf: 'd1' }]])
 * const docs = {
 *     get: async (id) => (map.has(id) ? { ...map.get(id) } : null),
 *     patch: async (id, fields) => { Object.assign(map.get(id), fields) },
 *     replace: async (rec) => { map.set(rec.id, { ...rec }) },
 * }
 * const rows = [{ at: '2026-09-01T00:00:00Z', object: 'doc', id: 'd2', stds: ['CS10'], before: { status: 'noted' }, after: { status: 'skip', skipKind: 'duplicate', dupOf: 'd1' } }]
 * const r = await rollbackCs10Fix({ docs }, rows, { at: '2026-09-02T00:00:00Z' })
 * console.log(r)
 * // => { restored: 1, accepted: 0, conflicts: [], errors: [] }
 * console.log(map.get('d2'))
 * // => { id: 'd2', status: 'noted' }
 */
export async function rollbackCs10Fix(stores, rows, opt = {}) {

    //check
    if (!isobj(stores) || !isfun(stores.docs?.get) || !isfun(stores.docs?.patch) || !isfun(stores.docs?.replace)) {
        throw new Error('rollbackCs10Fix 需要 stores.docs（具 get／patch／replace 方法）')
    }
    if (!isobj(opt)) {
        opt = {}
    }

    const at = stockAtOf(null, opt)
    const ledgerFile = isestr(opt.ledgerFile) ? opt.ledgerFile : ''
    const idx = await builtIndexOf(stores.docs)
    let restored = 0
    let accepted = 0
    const conflicts = []
    const errors = []
    for (const r of [...(isarr(rows) ? rows : [])].filter(isCs10Row).reverse()) {
        try {
            if (!isobj(r.before)) throw new Error(`文件 ${r.id} 之帳列缺 before（處置前之欄位），無從還原`)
            const cur = await stores.docs.get(r.id)
            const plan = rollbackPlanOf(cur, r)
            if (!cur || plan.conflict.length) {
                const units = cur ? plan.conflict : ['（記錄不在）']
                if (opt.acceptCurrent === true) {
                    appendRollbackRow(ledgerFile, r, at, { accepted: 'current', units })
                    accepted++
                }
                else conflicts.push({ id: r.id, object: 'doc', units })
                continue
            }
            if (plan.restore.length) {
                await writeRollback(stores.docs, cur, rollbackWriteOf(r, plan.restore))
                const back = rollbackPlanOf(await stores.docs.get(r.id), r)
                if (back.restore.length || back.conflict.length) throw new Error(`文件 ${r.id} 還原後回驗不符`)
            }
            idx?.add({ id: r.id, status: str(r.before.status), skipKind: str(r.before.skipKind) })
            appendRollbackRow(ledgerFile, r, at)
            restored++
        }
        catch (e) {
            errors.push(stockErrorOf(r.id, 'doc', e))
        }
    }
    return { restored, accepted, conflicts, errors }
}

export default { planCs10Fix, applyCs10Fix, verifyCs10Chain, readCs10Ledger, rollbackCs10Fix }
