// dirs.mjs — workDir → 各輸出目錄的展開(套件與執行端共用同一份展開,不各寫一份而靠人肉對齊)

import isestr from 'wsemi/src/isestr.mjs'
import isobj from 'wsemi/src/isobj.mjs'

/**
 * 路徑錨點正規化:反斜線轉正斜線、去尾斜線
 *
 * @param {String} workDir 輸入工作目錄路徑字串
 * @returns {String} 回傳正規化後之路徑字串(反斜線轉正斜線、去尾斜線)
 * @throws {Error} workDir 非有效字串時拋出
 * @example
 * console.log(normalizeWorkDir('kb\\sub\\'))
 * // => kb/sub
 */
export function normalizeWorkDir(workDir) {

    //check
    if (!isestr(workDir)) {
        throw new Error('normalizeWorkDir 需要 workDir（路徑字串）')
    }

    return String(workDir).replace(/\\/g, '/').replace(/\/$/, '')
}

/** 本套件之基本輸出目錄(相對 workDir) */
const BASE_DIRS = Object.freeze({ db: 'db', log: 'log', tmp: 'tmp', state: 'state', knowledge: 'knowledge' })

/**
 * 由 workDir 展開全部輸出目錄;overrides 逐鍵覆寫(cfg.dirs)。
 *
 * 【extra:下游套件之目錄】下游套件(如摘要之筆記目錄)以 extra 宣告其目錄(相對 workDir 之子路徑),與基本目錄同一份展開——
 *   其總組裝之 cfg.dirs 鍵集據此檢核;extra 不可重定基本目錄(重名即拋,免得下游悄悄改掉抓取之落點)。
 *
 * @param {String} workDir 輸入工作目錄路徑字串
 * @param {Object} [overrides={}] 輸入逐鍵覆寫物件(cfg.dirs)，非物件時視為{}；覆寫物件之其餘鍵原樣帶入結果
 * @param {Object} [extra={}] 輸入下游目錄 { 鍵: 相對 workDir 之子路徑 }，非物件時視為{}；值非字串者略過
 * @returns {Object} 回傳全部輸出目錄物件 {db, log, tmp, state, knowledge, ...extra}(皆為路徑字串)
 * @throws {Error} workDir 非有效字串(見 normalizeWorkDir)、或 extra 重定基本目錄時拋出
 * @example
 * console.log(expandDirs('c:/kb').db)
 * // => c:/kb/db
 *
 * console.log(expandDirs('c:/kb', { knowledge: 'd:/vault/知識' }).knowledge)
 * // => d:/vault/知識
 *
 * console.log(expandDirs('c:/kb', {}, { notes: 'knowledge/notes' }).notes)
 * // => c:/kb/knowledge/notes
 */
export function expandDirs(workDir, overrides = {}, extra = {}) {

    //check
    if (!isobj(overrides)) {
        overrides = {}
    }
    if (!isobj(extra)) {
        extra = {}
    }
    const clash = Object.keys(extra).filter((k) => k in BASE_DIRS)
    if (clash.length) {
        throw new Error(`expandDirs 之 extra 不可重定基本目錄：${clash.join('、')}（基本目錄：${Object.keys(BASE_DIRS).join('、')}）`)
    }

    const w = normalizeWorkDir(workDir)
    const sub = (rel) => `${w}/${String(rel).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}`
    return {
        ...Object.fromEntries(Object.entries(BASE_DIRS).map(([k, rel]) => [k, sub(rel)])),
        ...Object.fromEntries(Object.entries(extra).filter(([, rel]) => isestr(rel)).map(([k, rel]) => [k, sub(rel)])),
        ...overrides,
    }
}

export default { normalizeWorkDir, expandDirs }
