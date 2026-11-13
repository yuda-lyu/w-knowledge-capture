// captureTestKit.mjs — 抓取整合測試之共用件(不帶 .test. 中綴;只 import 套件內之檔案與 node_modules 套件)
//
// 【為何走總組裝】整合測試跑的是套件對外之總組裝 createKnowledgeCapture(設定、資料、抓取器登錄、去重、鎖、日誌、AI 調度層、執行摘要皆為真實件),
//   只換四件事:
//   ①workDir 換成 test/_tmp/<案名>-<pid>(真 LMDB、真目錄、鎖檔與日誌皆落此,與他測試隔離)
//   ②AI 調度層換成腳本化替身(不發網路、不燒額度;預設為「抓取不得呼叫 AI」)
//   ③不做本機網路探測(netGuard:null;斷網情境由測試明給真探測器指向死埠)
//   ④孤兒瀏覽器回收一律關閉(capture.browser.hygiene:它掃整台機器之行程,測試不可殺掉使用者或他專案之行程);
//     Camofox 預設關閉(capture.browser.camofox.enabled:避免與他處搶其伺服器埠)。
// 【暫存】test/_tmp 已入 .gitignore;各測試自建專用資料夾、測完即刪。
// 【位置無關之共用件在 testKit】日誌之替身、暫存根、概念折疊之還原、子階段 report 與其斷言、集合之開關、AI 調度層之替身、設定覆寫之深層合併等取
//   ./testKit.mjs(各套件同一份),本檔轉出之;本檔只放抓取之整合測試專屬者。

import wpw from 'w-playwright'
import { createKnowledgeCapture } from '../../src/createKnowledgeCapture.mjs'
import { resolveSettings } from '../../src/core/settingsDefault.mjs'
import { expandDirs } from '../../src/core/dirs.mjs'
import { normalizeUrl } from '../../src/core/util/web.mjs'
import { pkgRootOf, tmpRootsOf, silentLog, stubAdapter } from './testKit.mjs'

export { silentLog, recLog, removeRoots, resetConceptFold, subReport, assertSubStagesOk, withStores, stubAdapter, deepMerge } from './testKit.mjs'

/** 套件根(以本檔位置推導,與 cwd 無關;正斜線) */
export const PKG_ROOT = pkgRootOf(import.meta.url)

/** 專用暫存根(套件內 test/_tmp/<name>-<pid>;testKit 之 tmpRootsOf) */
export const { tmpRoot } = tmpRootsOf(PKG_ROOT)

/**
 * 完整設定(resolveSettings)之簡寫:只給本案要調之 capture 組鍵(形狀同 cfg.capture,如 { sources: { perRun: 3 } }),其餘沿用預設——
 * 子階段只讀 settings.capture.<組>.<鍵>,測試一律以完整設定餵之,不手寫缺組之殘缺形狀
 *
 * @param {Object} [capture={}] 輸入 capture 設定覆寫
 * @param {Object} [ai] 輸入 ai 設定覆寫
 * @returns {Object} 回傳 { ai, capture, warnings }
 */
export function settingsOf(capture = {}, ai = undefined) {
    return resolveSettings({ capture, ...(ai ? { ai } : {}) })
}

/**
 * 執行 fn 期間吞掉 w-fetch-web 之重試訊息(「[fetchWebByCurl] HTTP 503 …，等 3000ms 後重試」直接寫到 stderr,不屬受測輸出,
 * 不吞則洗掉測試報告);其餘輸出原樣放行
 *
 * @param {Function} fn 輸入 async () => 任意值
 * @returns {Promise} 回傳 fn 之回傳值(stderr 一律還原)
 */
export async function quiet(fn) {
    const orig = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk, ...rest) => (/^\[fetchWeb\w*\] /.test(String(chunk)) ? true : orig(chunk, ...rest))
    try {
        return await fn()
    }
    finally {
        process.stderr.write = orig
    }
}

/**
 * 「抓取不得呼叫 AI」之替身:被呼叫即記入 calls(測試須斷言 calls 為空——被拋錯之呼叫在領域發現中只會成為單次失敗而不使子階段失敗)
 *
 * @returns {Object} 回傳替身(同 stubAdapter)
 */
export function noAiAdapter() {
    return stubAdapter(() => {
        throw new Error('抓取不得呼叫 AI')
    })
}

/**
 * 以總組裝建立測試用之抓取流程
 *
 * overrides 之鍵即 cfg 之鍵(見 createKnowledgeCapture 之 CFG_KEYS),另有兩個測試專用鍵:
 *   log      日誌物件(給了即取代靜音日誌)
 *   capture  抓取設定覆寫(同 cfg.capture 之巢狀形狀;browser.hygiene 一律 false、browser.camofox.enabled 預設 false,其餘 browser 鍵照給)
 * 給 `netGuard: undefined` 即用套件依 settings.capture.network 之探測端點建立之真探測器(預設 null＝不探測)。
 *
 * @param {String} root 輸入暫存根(tmpRoot 之產物)
 * @param {Object} [overrides={}] 輸入 cfg 覆寫
 * @returns {Object} 回傳 { flow, cfg, dirs, ai }：ai 為實際使用之 AI 調度層(未給 aiAdapter 時為 noAiAdapter)
 */
export function buildTestCapture(root, overrides = {}) {
    const { log, capture, ...rest } = overrides
    const cap = capture || {}
    const cfg = {
        workDir: root,
        afterRun: false,
        logFactory: () => log || silentLog,
        lock: `${root}/tmp/run.lock`,
        aiAdapter: noAiAdapter(),
        capture: { ...cap, browser: { ...(cap.browser || {}), camofox: { enabled: false, ...(cap.browser?.camofox || {}) }, hygiene: false } },
        netGuard: null,
        ...rest,
    }
    return { flow: createKnowledgeCapture(cfg), cfg, dirs: expandDirs(root), ai: cfg.aiAdapter }
}

/**
 * 全部文件以網址為鍵之對照
 *
 * @param {Object} stores 輸入 openStores 之產物
 * @returns {Promise} 回傳 { 網址: 文件記錄 }
 */
export async function byUrl(stores) {
    return Object.fromEntries((await stores.docs.select()).map((d) => [d.url, d]))
}

/**
 * 依站台基底組「取某路徑文件」之函數
 *
 * @param {String} base 輸入站台基底網址
 * @returns {Function} 回傳 (path) => async (stores) => 文件記錄(網址經 normalizeUrl 後比對)
 */
export const docAtOf = (base) => (p) => async (stores) => (await byUrl(stores))[normalizeUrl(`${base}${p}`)]

/**
 * 系統 Google Chrome 之路徑(w-fetch-web 之 Playwright 階經 w-playwright 以 channel:'chrome' 啟動系統 Chrome;判定取 w-playwright 之 findSystemChrome,
 * 與其啟動所找之位置同一份實作:只以檔案存在判定,不啟動瀏覽器)
 *
 * @returns {String} 回傳路徑,找不到回空字串
 */
export function findSystemChrome() {
    return wpw.findSystemChrome({ channel: 'chrome' })
}

/**
 * 須有系統 Chrome 之測試的前置檢查:找不到即明確失敗並說明(不靜默略過——略過會使瀏覽器階梯之真實路徑在無 Chrome 環境從未被驗過)
 *
 * @throws {Error} 找不到系統 Chrome 時拋出
 */
export function assertChromeInstalled() {
    if (!findSystemChrome()) {
        throw new Error('本機找不到系統 Google Chrome：瀏覽器階梯之 Playwright 階以 channel:\'chrome\' 啟動系統 Chrome，須先安裝才能驗證瀏覽器分流之真實路徑（本測試不略過）')
    }
}

// 預設匯出只列本檔定義或匯入之名;自 testKit 轉出之共用件(recLog、removeRoots、resetConceptFold、subReport、assertSubStagesOk、withStores、deepMerge)請具名匯入
export default { PKG_ROOT, settingsOf, tmpRoot, quiet, silentLog, stubAdapter, noAiAdapter, buildTestCapture, byUrl, docAtOf, findSystemChrome, assertChromeInstalled }
