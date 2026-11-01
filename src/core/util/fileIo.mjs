// fileIo.mjs — JSON 讀取與原子寫檔:把 wsemi 之 { success }／{ error } 信封轉成本套件各處所需之「回退值」與「拋錯」語意
//
// 【為何包一層】wsemi 之 fs* 家族一律回信封、不拋錯;本套件之狀態檔與投影檔有兩種固定用法——讀不到回退值(fsReadJson)、
//   寫失敗必須拋出(fsWriteTextAtomic:真理檔靜默寫失敗＝追蹤靜默丟失)。各處自行判 r.error 必然分歧,故語意只在此轉一次。

import isestr from 'wsemi/src/isestr.mjs'
import fsReadJson from 'wsemi/src/fsReadJson.mjs'
import fsWriteTextAtomic from 'wsemi/src/fsWriteTextAtomic.mjs'


/**
 * 讀 JSON 檔;讀不到或非法 JSON 回 fallback
 *
 * @param {String} file 輸入 JSON 檔案路徑字串，非字串時直接回 fallback
 * @param {*} [fallback=null] 輸入讀取失敗時之回傳值，預設null
 * @returns {*} 回傳解析後之物件或陣列，失敗時回傳 fallback
 * @example
 * need test in nodejs.
 *
 * console.log(readJson('./not-exist.json', { a: 1 }))
 * // => { a: 1 }
 */
export function readJson(file, fallback = null) {

    //check
    if (!isestr(file)) {
        return fallback
    }

    const r = fsReadJson(file)
    return r?.error !== undefined ? fallback : r.success
}


/**
 * 原子寫檔:先寫同目錄暫存檔再 rename(寫到一半中止不會留下半份檔案);rename 被暫時占用(EPERM／EBUSY／EACCES)時短重試,
 * 仍失敗者——opt.fallbackOverwrite 為 true(投影檔:可由真理重建者)退回直接覆寫,否則拋錯
 * (真理檔:退回非原子覆寫即失去「中止不留半份」之保證,寧可本次不寫)。實作委派 wsemi 之 fsWriteTextAtomic,本函數只把信封轉為拋錯
 *
 * @param {String} file 輸入目標檔案路徑字串
 * @param {String} text 輸入檔案內容
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Integer} [opt.retries=3] 輸入 rename 被占用時之重試次數
 * @param {Boolean} [opt.fallbackOverwrite=false] 輸入重試仍被占用時是否退回直接覆寫
 * @returns {String} 回傳 file
 * @throws {Error} file 非有效字串、寫暫存檔失敗、rename 非占用類失敗、或占用重試後仍失敗且未允許覆寫時拋出(暫存檔已清除)
 * @example
 * need test in nodejs.
 *
 * writeFileAtomic('./tmp/state.json', '{}')
 */
export function writeFileAtomic(file, text, opt = {}) {

    //check
    if (!isestr(file)) {
        throw new Error('writeFileAtomic 需要 file（檔案路徑字串）')
    }
    if (opt === null || typeof opt !== 'object') {
        opt = {}
    }

    const r = fsWriteTextAtomic(file, text, opt)
    if (r?.error !== undefined) {
        throw (r.error instanceof Error ? r.error : new Error(String(r.error)))
    }
    return file
}


export default { readJson, writeFileAtomic }
