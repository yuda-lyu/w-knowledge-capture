// reviveDocs.mjs — 把「確定抓不到」(dead)的文件放回待抓佇列(維運能力;命令列殼由使用端提供)
//
// 【為何需要】dead 是「試滿 capture.articles.maxTries」或「決定性失敗」之判定,前提是抓取能力與判準不變;能力升級後(如站台 adapter 上線、
//   反爬解法更新、分流規則改版)那批判定就過時了——記錄永不刪,故可回填:status→new。
// 【回填後之欄位】
//   - 當前狀態欄一律重設:lastReason／lastClass／curlReason／lastError／deadAt／deadClass／httpCode／deadBy／healthV／refetchSkip／retryAt／
//     fetchChainFails／fetcher——不重設則回填件帶著舊類別與舊路由,分流與剔除清單會讀到過期資訊。
//   - 歷史留在 revivedFrom(原 lastError)／revivedFromClass(原類別)／revives(累計回收次數)／revivedAt。
//   - fetchTries:呼叫端明給者(cfg.fetchTries)優先;給了抓取設定(cfg.capture)者預設 capture.articles.maxTries−1(只剩一次機會、排在隊尾,
//     不以整批舊件壓住隊頭——佇列依 tries 升冪排序,tries 0 之舊件會排到同層所有新件之前);兩者皆無為 0。生效值隨結果回傳。
// 【依現行分流自動路由 cfg.capture】給了抓取設定即依現行規則路由:判死類別屬瀏覽器類(stores/fetchPolicy 之 BROWSER_CLASS_LADDER)且瀏覽器佇列
//   開啟(browserQueueOn)者直入瀏覽器佇列(路由欄位經 browserQueueFields,與補全文段同一寫法),其餘回補全文佇列——呼叫端不必自組路由欄位。
// 【逐篇追加欄位 patchOf】另有特例(如只回收部分類別、指名抓取器)時由呼叫端依各篇追加欄位(併於自動路由之後)。
//   status 恆為 new、稽核欄恆由本函數寫。

import isobj from 'wsemi/src/isobj.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import { BROWSER_CLASS_LADDER, browserQueueOn, browserQueueFields } from '../stores/fetchPolicy.mjs'

/** 回填時重設之當前狀態欄(歷史另存於 revived*) */
const RESET_FIELDS = {
    lastError: '', lastReason: '', lastClass: '', curlReason: '', deadAt: '', deadClass: '', httpCode: 0, deadBy: '',
    healthV: null, refetchSkip: null, retryAt: '', fetchChainFails: 0, fetcher: '',
}

/**
 * 把狀態為 dead 的文件依 match 篩選後放回待抓佇列
 *
 * dryRun 時只統計不寫入,供操作前預覽篩選結果。
 *
 * @param {Object} stores 輸入集合物件，需含 docs(w-data-pipeline openCollection 介面，取 select、patch)
 * @param {Object} cfg 輸入設定物件
 * @param {Function} cfg.match 輸入篩選函數 (doc) => Boolean，決定哪些 dead 文件要回填，必填
 * @param {String} cfg.nowIso 輸入現在時刻 ISO 字串，寫入 revivedAt
 * @param {Boolean} [cfg.dryRun=false] 輸入是否僅統計不寫入
 * @param {Integer} [cfg.fetchTries] 輸入回填後之 fetchTries(非負整數);未給時:給了 cfg.capture 者為 capture.articles.maxTries−1,否則 0
 * @param {Integer} [cfg.limit] 輸入本次至多回填幾篇(依 deadAt 先後;未給＝全部符合者)
 * @param {Object} [cfg.capture] 輸入抓取設定(settings.capture);給了即依現行分流自動路由(瀏覽器類且瀏覽器佇列開啟 → 直入瀏覽器佇列),
 *   並以 maxTries−1 為 fetchTries 之預設
 * @param {Function} [cfg.patchOf] 輸入逐篇追加欄位函數 (doc) => Object，回傳之欄位併入回填內容(於自動路由之後;可覆寫 fetchTries、指名 fetcher 等;
 *   status 恆為 'new'、revived* 稽核欄恆由本函數寫,不可被覆寫);回傳非物件視為不追加
 * @returns {Promise} 回傳 Promise，resolve 回傳 { dead:Integer, matched:Integer, picked:Integer, revived:Integer, fetchTries:Integer(生效之回填值),
 *   byClass:Object, sample:Array(前 5 筆 url) }
 * @throws {Error} cfg.match 非函數、或 cfg.patchOf 給了但非函數時拋出
 * @example
 * need test in nodejs.
 *
 * let r = await reviveDeadDocs(stores, { match: deadMatcher({ host: 'example.com' }), nowIso: clock.iso8(), fetchTries: 2 })
 * console.log(r.revived)
 */
export async function reviveDeadDocs(stores, cfg) {

    //check
    if (!isobj(stores) || !isobj(stores.docs) || !isfun(stores.docs.select) || !isfun(stores.docs.patch)) {
        throw new Error('reviveDeadDocs 需要 stores.docs.select／stores.docs.patch（docs 集合）')
    }
    if (typeof cfg?.match !== 'function') throw new Error('reviveDeadDocs 需要 match(doc) 函數')
    if (cfg.patchOf != null && !isfun(cfg.patchOf)) throw new Error('reviveDeadDocs 之 patchOf 須為函數 (doc) => Object')
    const dead = await stores.docs.select({ status: 'dead' })
    const targets = dead.filter(cfg.match).sort((a, b) => String(a.deadAt || '').localeCompare(String(b.deadAt || '')) || String(a.id).localeCompare(String(b.id)))
    const picks = Number.isInteger(cfg.limit) && cfg.limit > 0 ? targets.slice(0, cfg.limit) : targets
    const byClass = {}
    for (const d of picks) {
        const k = String(d.deadClass || d.lastClass || d.lastReason || 'unclassified')
        byClass[k] = (byClass[k] || 0) + 1
    }
    // 回填後之 fetchTries(檔頭):明給者優先;給了抓取設定者預設 maxTries−1;否則 0
    const lastChance = Math.max(0, (Number(cfg.capture?.articles?.maxTries) || 0) - 1)
    const tries = Number.isInteger(cfg.fetchTries) && cfg.fetchTries >= 0 ? cfg.fetchTries : (isobj(cfg.capture) ? lastChance : 0)
    const autoRoute = isobj(cfg.capture) && browserQueueOn(cfg.capture)
    let revived = 0
    if (!cfg.dryRun) {
        for (const d of picks) {
            const cls = String(d.deadClass || '')
            const route = autoRoute && Object.hasOwn(BROWSER_CLASS_LADDER, cls) ? browserQueueFields(d, cls, cfg.nowIso) : null
            const extra = cfg.patchOf ? cfg.patchOf(d) : null
            await stores.docs.patch(d.id, {
                ...RESET_FIELDS,
                fetchTries: tries,
                ...(route || {}),
                ...(isobj(extra) ? extra : {}),
                status: 'new',
                revivedAt: cfg.nowIso,
                revivedFrom: String(d.lastError || '').slice(0, 120),
                revivedFromClass: String(d.deadClass || d.lastClass || d.lastReason || ''),
                revives: (Number(d.revives) || 0) + 1,
            })
            revived++
        }
    }
    return { dead: dead.length, matched: targets.length, picked: picks.length, revived, fetchTries: tries, byClass, sample: picks.slice(0, 5).map((d) => d.url) }
}

/**
 * 常用篩選產生器:依主機名(含子網域)、失敗原因之片段、判死類別、是否從未經瀏覽器嘗試,產出可直接交給 reviveDeadDocs 之 cfg.match
 *
 * 條件皆未給時,回傳之函數恆回 false(不誤配整批);host 以尾端錨定比對含子網域(如 host:'e.com' 亦配 'a.e.com');各條件為且
 *
 * @param {Object} [opt={}] 輸入設定物件
 * @param {String} [opt.host] 輸入主機名字串(不含協定，如 'example.com')，比對 d.url 之 hostname(含子網域)
 * @param {String} [opt.error] 輸入失敗原因之片段字串(字面比對，大小寫不拘)，比對 d.lastError
 * @param {Array|String} [opt.cls] 輸入判死類別(d.deadClass;陣列或逗號分隔字串)
 * @param {Boolean} [opt.untriedBrowser=false] 輸入只取從未經瀏覽器嘗試者(無 lastClass、無 curlReason、deadBy 非 browser)
 * @returns {Function} 回傳篩選函數 (d) => Boolean
 * @example
 * let match = deadMatcher({ host: 'example.com' })
 * console.log(match({ url: 'https://a.example.com/x', lastError: '' }))
 * // => true
 */
export function deadMatcher(opt = {}) {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    const { host, error } = opt
    const hostRe = host ? new RegExp(`(^|\\.)${String(host).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') : null
    const errRe = error ? new RegExp(String(error).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null
    const clsSet = opt.cls ? new Set((Array.isArray(opt.cls) ? opt.cls : String(opt.cls).split(',')).map((x) => String(x).trim()).filter(Boolean)) : null
    const untried = opt.untriedBrowser === true
    /**
     * @param {Object} d 輸入文件記錄，取 url、lastError、deadClass、lastClass、curlReason、deadBy
     * @returns {Boolean} 回傳是否符合篩選條件
     */
    return (d) => {
        if (hostRe) {
            let h = ''
            try {
                h = new URL(d.url).hostname
            }
            catch {
                return false
            }
            if (!hostRe.test(h)) return false
        }
        if (errRe && !errRe.test(String(d.lastError || ''))) return false
        if (clsSet && !clsSet.has(String(d.deadClass || ''))) return false
        if (untried && (d.lastClass || d.curlReason || d.deadBy === 'browser')) return false
        return !!(hostRe || errRe || clsSet || untried)
    }
}

export default { reviveDeadDocs, deadMatcher }
