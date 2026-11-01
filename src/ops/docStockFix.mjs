// docStockFix.mjs — 文件之存量處置(檢定標準 CS10 同一內容只入庫一次)
//
// 【合併走刪筆記正規路徑】同一內容之群留一份,他份之筆記由呼叫端以刪筆記之正規路徑處理(如墓碑、封存、撤邊、可還原;
//   本檔只出計畫,不碰筆記);他份之文件改 skip(理由「與既有文件同一內容」、dupOf 記留存者——與新進之 CS10 同一處置;skip 為終態,不重開、
//   不重新摘要)。只刪筆記而文件仍 noted,掃描仍見同一內容入庫兩次。
// 【留哪一份】①筆記已被下游消化者(刪之會使下游之產物撤出處)②有筆記者 ③較早成筆記(文件之 notedAt)④id——
//   使被下游產物引用者盡量留下;兩份皆被消化者照樣只留一份,另一份之出處由下游之維護撤出(可逆),預演列出以供判讀。
//   無筆記集合時 noteOfDoc 回 null 即可(只剩 ③④ 決定留哪一份)。筆記之欄位經 core/stores/noteFields 讀(消化與否:noteConsumedOf)。
// 【群之合併】掃描之群可重疊(網址代稱群與段落重疊之兩兩配對),以聯集合併為連通群。
// 【只處置與留存者直接相連者】段落重疊不具傳遞性:甲乙共享 3 段、乙丙共享 3 段,甲丙可毫無共同內容;
//   聯集後若留甲,刪丙之筆記即刪掉一篇不同之文章。故一群之中只處置與留存者「同屬一個原始群(網址代稱群或段落配對)」者,其餘列 deferred
//   不動——下輪重掃時已處置者轉 skip(不在掃描範圍),剩餘者依其自身之重疊重新成群。

import isarr from 'wsemi/src/isarr.mjs'
import { noteConsumedOf } from '../core/stores/noteFields.mjs'

/**
 * 重疊之群合併為連通群(聯集)
 *
 * @param {Array} groups 輸入 [Array(文件 id)]
 * @returns {Array} 回傳 [Array(文件 id,排序)](依首個 id 排序)
 * @example
 * console.log(mergeDupGroups([['d3', 'd1'], ['d3', 'd2'], ['d8', 'd9']]))
 * // => [ [ 'd1', 'd2', 'd3' ], [ 'd8', 'd9' ] ]
 */
export function mergeDupGroups(groups) {
    const parent = new Map()
    const find = (x) => {
        while (parent.get(x) !== x) {
            parent.set(x, parent.get(parent.get(x)))
            x = parent.get(x)
        }
        return x
    }
    for (const g of isarr(groups) ? groups : []) {
        const ids = (isarr(g) ? g : []).map(String).filter(Boolean)
        for (const id of ids) if (!parent.has(id)) parent.set(id, id)
        for (let i = 1; i < ids.length; i++) {
            const [a, b] = [find(ids[0]), find(ids[i])]
            if (a !== b) parent.set(a < b ? b : a, a < b ? a : b)
        }
    }
    const by = new Map()
    for (const id of parent.keys()) {
        const r = find(id)
        if (!by.has(r)) by.set(r, [])
        by.get(r).push(id)
    }
    return [...by.values()].map((ids) => ids.sort()).filter((ids) => ids.length > 1).sort((a, b) => (a[0] < b[0] ? -1 : 1))
}

/**
 * 一群之處置:留哪一份、他份之筆記;只處置與留存者直接相連者(檔頭)
 *
 * @param {Array} ids 輸入群之文件 id
 * @param {Object} o 輸入 { docOf:(id)=>文件記錄|null, noteOfDoc:(id)=>筆記記錄|null(無筆記集合時回 null), edges?:Array(原始群,每群為文件 id 陣列;未給視為全群互連) }
 * @returns {Object} 回傳 { keeper:文件 id, keeperNote:筆記 id|null, others:[{ doc, note:筆記 id|null, consumed:Boolean }], deferred:Array(與留存者不直接相連之文件 id) }
 * @example
 * let docs = { d1: { notedAt: '2026-09-02' }, d2: { notedAt: '2026-09-01' }, d3: { notedAt: '2026-09-03' } }
 * let notes = { d1: { id: 'n1', extractedAt: '2026-09-10' }, d2: { id: 'n2', extractedAt: '' } }
 * let plan = dupPlanOf(['d1', 'd2', 'd3'], {
 *     docOf: (id) => docs[id],
 *     noteOfDoc: (id) => notes[id] || null,
 *     edges: [['d1', 'd2']],
 * })
 * console.log(plan.keeper, plan.keeperNote, plan.others, plan.deferred)
 * // => d1 n1 [ { doc: 'd2', note: 'n2', consumed: false } ] [ 'd3' ]
 */
export function dupPlanOf(ids, o) {
    const rows = (isarr(ids) ? ids : []).map((id) => {
        const d = o.docOf(id)
        const n = o.noteOfDoc(id)
        return { doc: id, note: n?.id || null, consumed: noteConsumedOf(n), notedAt: String(d?.notedAt || d?.createdAt || '') }
    })
    rows.sort((a, b) => Number(b.consumed) - Number(a.consumed) || Number(!!b.note) - Number(!!a.note) || a.notedAt.localeCompare(b.notedAt) || (a.doc < b.doc ? -1 : 1))
    const [keep, ...rest] = rows
    // 與留存者同屬一個原始群者才處置;未給 edges 時全群視為互連(單一原始群)
    const linked = isarr(o.edges) ? new Set(o.edges.filter((g) => isarr(g) && g.map(String).includes(String(keep?.doc))).flat().map(String)) : null
    const others = linked ? rest.filter((r) => linked.has(String(r.doc))) : rest
    const deferred = linked ? rest.filter((r) => !linked.has(String(r.doc))).map((r) => r.doc) : []
    return { keeper: keep?.doc || '', keeperNote: keep?.note || null, others: others.map(({ doc, note, consumed }) => ({ doc, note, consumed })), deferred }
}

export default { mergeDupGroups, dupPlanOf }
