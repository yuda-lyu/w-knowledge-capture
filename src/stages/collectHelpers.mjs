// collectHelpers.mjs — 抓取回合共用小件(供各子階段使用)

import isarr from 'wsemi/src/isarr.mjs'
import isobj from 'wsemi/src/isobj.mjs'

/**
 * 下游(預篩／摘要)之 AI 判素材壞了而未能換法重抓者之 skipKind:由下游寫入、本套件讀之(來源產出統計不計為已判定)——
 *   跨套件之契約值,下游一律取此常數,不手寫字面值(改名時兩端同動)
 *
 * @type {String}
 */
export const SKIP_KIND_MATERIAL = 'material'

/** 非對內容之判定之 skip 類別(skipKind → 另計之鍵):不計入 judged(檢定標準 CS5「來源統計分 skipReason」) */
const NON_JUDGING_SKIP_KINDS = {
    duplicate: 'dup', // 轉址至既有文件、與既有文件同一內容(CS10)
    routine: 'routine', // 標題樣式判定之例行公告／彙整貼文而無可轉錄連結(未進 AI;detailFetchStage.mwTranscodeLinks)
    [SKIP_KIND_MATERIAL]: 'material', // 下游(預篩／摘要)之 AI 判素材壞了而未能換法重抓:是抓取之結果,不是對來源內容之判定
}

/**
 * 由文件集統計各來源的「已判定/有產出」數(供零產出淘汰)。
 * 統計直接從文件算、不設計數器:並行批次下計數器有 read-modify-write 競態;
 * 文件的終態是唯一事實來源,每輪重算即可(瘦身只清素材不刪記錄,歷史完整)。
 * 【skip 依理由分計(CS5)】非對內容之判定之 skip——重複類(skipKind 'duplicate':轉址至既有文件、與既有文件同一內容)、
 *   例行貼文(skipKind 'routine':標題樣式判定、未進 AI)、素材壞了而未能重抓(skipKind 'material')——不計入 judged,分別另計 dup、routine、material。
 * 【觀察窗(CS5／CS7)】給 since 時,只計判定時刻(notedAt)不早於該來源窗起點者——冷卻重探與手動恢復開新窗,舊判定不再讓它立刻被停用;
 *   有窗而判定時刻不明者不計(無從知道落在窗內)。
 *
 * @param {Array} docs 輸入文件陣列(已由呼叫端 select 取出)，非陣列則回傳空物件
 * @param {Object} [cfg={}] 輸入設定物件，非物件則回退為 {}
 * @param {String} [cfg.yieldStatus='noted'] 輸入視為「有產出」之狀態字串
 * @param {String} [cfg.skipStatus='skip'] 輸入視為「已判定但無產出」之狀態字串
 * @param {Map} [cfg.since] 輸入來源 id → 觀察窗起點(ISO;無窗者不在其中)
 * @returns {Object} 回傳 { [sourceId]: { judged:Integer, yielded:Integer, dup:Integer, routine:Integer, material:Integer } }
 * @example
 * let docs = [{ sourceId: 's1', status: 'noted' }, { sourceId: 's1', status: 'skip' }, { sourceId: 's1', status: 'skip', skipKind: 'duplicate' }, { sourceId: 's1', status: 'skip', skipKind: 'routine' }, { sourceId: 's2', status: 'new' }]
 * console.log(judgeFromDocs(docs))
 * // => { s1: { judged: 2, yielded: 1, dup: 1, routine: 1, material: 0 } }
 */
export function judgeFromDocs(docs, cfg = {}) {

    //check
    if (!isarr(docs)) {
        return {}
    }
    if (!isobj(cfg)) {
        cfg = {}
    }

    const yieldStatus = cfg.yieldStatus || 'noted'
    const skipStatus = cfg.skipStatus || 'skip'
    const since = cfg.since instanceof Map ? cfg.since : new Map()
    const judged = {}
    for (const d of docs) {
        if (d.status !== yieldStatus && d.status !== skipStatus) continue
        const sid = String(d.sourceId || '').replace(/:linked$/, '')
        if (!sid) continue
        const from = since.get(sid)
        if (from) {
            const t = Date.parse(d.notedAt || '')
            if (!Number.isFinite(t) || t < Date.parse(from)) continue
        }
        if (!judged[sid]) judged[sid] = { judged: 0, yielded: 0, dup: 0, routine: 0, material: 0 }
        const other = d.status === skipStatus && Object.hasOwn(NON_JUDGING_SKIP_KINDS, String(d.skipKind)) ? NON_JUDGING_SKIP_KINDS[d.skipKind] : ''
        if (other) {
            judged[sid][other]++
            continue
        }
        judged[sid].judged++
        if (d.status === yieldStatus) judged[sid].yielded++
    }
    return judged
}

export default { SKIP_KIND_MATERIAL, judgeFromDocs }
