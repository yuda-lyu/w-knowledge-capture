// siteAdapters.mjs — 站台 adapter(w-fetch-web opt.adapters):本套件自帶清單與合併
//
// 【是什麼】w-fetch-web ≥1.0.17 之 adapter 讓特定站台改寫「怎麼取得/判識/解析」,
//   形狀 {id, match, fetch?, parse?, inspect?, fallback?}。契約以
//   w-fetch-web/src/adapterContract.mjs 檔頭為唯一事實來源,本檔不重述,只記本套件的取捨。
//
// 【本清單預設為空——站台知識能推回上游就不留在這裡】msn 等站已由 w-fetch-web ≥1.0.18 內建:
//   使用端 adapters 排在內建之前(fetchWeb.mjs:97-107),自帶一份同站 adapter 會永遠搶先命中,
//   等於把同一份站台知識鎖在本套件,套件日後對該站的修正都輪不到。
//   保留本檔之機制(清單＋合併＋啟動期契約檢核)供新站台使用;要覆寫套件內建之 adapter(如 msn),
//   於此加入同網域 adapter 即可(排在內建之前),或由安裝方以 cfg.siteAdapters 注入。
//
// 【接入點】articleParse.fetchArticle → fetchWeb(opt.adapters)。安裝方以 cfg.siteAdapters 注入,
//   經 mergeSiteAdapters 合併。本套件不傳 useDefaultAdapters,故 w-fetch-web 內建清單恆生效
//   (gelonghui、bloomberg、msn)。fetchArticleLinks/discoverFeed/readGrid 直呼 fetchWebByCurl,
//   不經 fetchWeb,不受 adapter 影響。
//
// 【reason 值域】adapter 回傳之 reason 一律取 w-fetch-web constants.REASONS 已登記之值:
//   該清單自述為 reason 之完整值域與唯一權威,呼叫端據以分支;自創值會落到未知分支。

import isarr from 'wsemi/src/isarr.mjs'
import { isValidAdapter } from 'w-fetch-web/src/adapterContract.mjs'

/** 本套件自帶之站台 adapter(陣列順序即比對優先序);預設無——站台知識能推回上游就不留在這裡 */
export const DEFAULT_SITE_ADAPTERS = Object.freeze([])

/**
 * 合併本套件自帶與安裝方注入之站台 adapter。
 * w-fetch-web 取「第一個 match 命中者」,故注入者排在自帶之前;同 id 者置換(與 mergeFetchers 同語意)。
 * 合併結果再由 w-fetch-web 排在其內建清單之前。
 * 不合契約者於此拋錯——w-fetch-web 對不合法 adapter 靜默略過,而本套件原則是設定錯誤於啟動期爆,
 * 不讓「註冊了卻完全沒反應」拖到跑輪次才發現。
 *
 * @param {Array} [defaults=DEFAULT_SITE_ADAPTERS] 輸入本套件自帶清單，非陣列視為 DEFAULT_SITE_ADAPTERS
 * @param {Array} [injected=[]] 輸入安裝方注入(cfg.siteAdapters)，未給(undefined／null)視為未注入([])
 * @returns {Array} 回傳合併後 adapter 陣列(注入者在前,自帶清單中未被同 id 置換者接續在後)
 * @throws {Error} injected 給了但非陣列(如誤傳單一 adapter 物件;與 cfg.fetchers 之 mergeFetchers 同一處置)，
 *   或內任一項不合 w-fetch-web adapter 契約(缺 id、match,或 parse／fetch 皆無)時拋出
 * @example
 * const mine = { id: 'x', match: /x\.com/, parse: () => ({ success: false }) }
 * console.log(mergeSiteAdapters([], [mine]).map((a) => a.id))
 * // => [ 'x' ]
 */
export function mergeSiteAdapters(defaults = DEFAULT_SITE_ADAPTERS, injected = []) {

    //check
    if (!isarr(defaults)) {
        defaults = DEFAULT_SITE_ADAPTERS
    }
    if (injected === undefined || injected === null) {
        injected = []
    }
    if (!isarr(injected)) {
        throw new Error('cfg.siteAdapters 須為站台 adapter 陣列（單一 adapter 亦須包成陣列）')
    }
    const list = injected

    list.forEach((a, i) => {
        if (!isValidAdapter(a)) {
            throw new Error(`cfg.siteAdapters[${i}](id=${a?.id ?? '?'}) 不合 w-fetch-web adapter 契約：須有 id、match(RegExp 或函數),以及 parse 或 fetch 至少其一`)
        }
    })
    const ids = new Set(list.map((a) => a.id))
    return [...list, ...defaults.filter((a) => !ids.has(a.id))]
}

export default { DEFAULT_SITE_ADAPTERS, mergeSiteAdapters }
