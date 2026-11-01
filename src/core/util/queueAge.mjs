// queueAge.mjs — 佇列積壓摘要(供日誌與監控之積壓告警)

import isarr from 'wsemi/src/isarr.mjs'
import isestr from 'wsemi/src/isestr.mjs'


/**
 * 佇列積壓摘要:筆數與最舊者天數
 *
 * 無任何可解析日期時 oldestDays 為 null(顯示 '-'),不回 0——0 是「全新」,null 是「無資料」,
 * 混為一談會讓下游之天數判準在舊資料無該欄時永遠測到 0
 *
 * @param {Array} rows 輸入記錄陣列，非陣列視為空陣列
 * @param {String} [field='collectedAt'] 輸入日期欄位名稱字串，預設'collectedAt'
 * @param {Number} [now=Date.now()] 輸入現在時刻毫秒數(測試注入用)，預設Date.now()
 * @returns {Object} 回傳 { count, oldestDays }，oldestDays 為最舊者距今天數(無可解析日期時為 null)
 * @example
 * let now = Date.parse('2026-09-10T00:00:00Z')
 * console.log(queueAge([{ collectedAt: '2026-09-01T00:00:00Z' }, { collectedAt: '' }], 'collectedAt', now))
 * // => { count: 2, oldestDays: 9 }
 */
export function queueAge(rows, field = 'collectedAt', now = Date.now()) {

    //check
    if (!isarr(rows)) {
        rows = []
    }
    if (!isestr(field)) {
        field = 'collectedAt'
    }
    if (!Number.isFinite(now)) {
        now = Date.now()
    }

    let oldest = Infinity
    for (const r of rows) {
        const t = Date.parse(r?.[field] || '')
        if (Number.isFinite(t) && t < oldest) oldest = t
    }
    const oldestDays = Number.isFinite(oldest) ? Math.max(0, Math.floor((now - oldest) / 86400_000)) : null
    return { count: rows.length, oldestDays }
}


export default queueAge
