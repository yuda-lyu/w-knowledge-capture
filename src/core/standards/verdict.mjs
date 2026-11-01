// verdict.mjs — 檢定標準之判定結果(各檢定與符合度掃描共用之形狀)
//
// 【四態＋豁免】合格 pass／不合格 violation／未能判定 undetermined／不適用 na／豁免 waived(須記使用者裁示與日期)。
//   未能判定不得算合格(達檢定標準才能納入):符合度掃描分開計數並列出 id,不併入合格。
// 【一筆一標準一結果】checkX 對一個物件回傳每條適用標準各一筆 { std, status, detail, field };細項(哪一欄、哪幾處)放 detail。

/**
 * 判定狀態列舉(凍結物件)：合格 pass／不合格 violation／未能判定 undetermined／不適用 na／豁免 waived
 *
 * @type {Object<String, String>}
 */
export const STATUS = Object.freeze({ PASS: 'pass', VIOLATION: 'violation', UNDETERMINED: 'undetermined', NA: 'na', WAIVED: 'waived' })

/**
 * 組一筆判定結果
 *
 * @param {String} std 輸入標準 ID(如 'CS1a')
 * @param {String} status 輸入 STATUS 之一
 * @param {String} [detail=''] 輸入說明(不合格之處、未能判定之原因)
 * @param {String} [field=''] 輸入欄位或位置
 * @returns {Object} 回傳 { std, status, detail, field }
 * @example
 * console.log(result('CS1a', STATUS.VIOLATION, '缺標題', 'title'))
 * // => { std: 'CS1a', status: 'violation', detail: '缺標題', field: 'title' }
 */
export function result(std, status, detail = '', field = '') {
    return { std, status, detail: String(detail || ''), field: String(field || '') }
}

/**
 * 由子檢查之問題清單組一筆結果:有問題 → 不合格(列前 n 項),無 → 合格
 *
 * @param {String} std 輸入標準 ID
 * @param {Array} problems 輸入問題字串陣列(非陣列視為無問題;空值略過)
 * @param {Integer} [n=5] 輸入 detail 最多列出幾項
 * @returns {Object} 回傳判定結果(同 result)
 * @example
 * console.log(fromProblems('X1', ['缺標題']).status)
 * // => violation
 */
export function fromProblems(std, problems, n = 5) {
    const ps = (Array.isArray(problems) ? problems : []).filter(Boolean)
    return ps.length ? result(std, STATUS.VIOLATION, `${ps.slice(0, n).join('；')}${ps.length > n ? `；…共 ${ps.length} 處` : ''}`) : result(std, STATUS.PASS)
}

export default { STATUS, result, fromProblems }
