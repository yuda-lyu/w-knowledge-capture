// browserFetcher.mjs — 瀏覽器階梯之呼叫端:以子行程 CLI(fetch_web_cli.mjs)執行,一輪之配額／時間／斷路狀態,與 detail 抓取器 'browser'
//
// 【子行程＋硬逾時】經wsemi 之 execCliJsonFile(wsemi execCli:逾時以 taskkill /T 樹狀殺),子行程以 process.execPath 啟動
//   (不靠 PATH 找 node);逾時值＝階梯各階最壞耗時之和＋餘裕(各階一律 maxRetries:0,見 browserLadder)。
// 【一輪之狀態】配額(capture.browser.perRun)、軟性時間上限(capture.browser.maxMs:逾時即不再開新篇;進行中之一篇受其子行程硬逾時封頂)、
//   方法斷路(某方法本輪出現環境失敗即不再用;全部方法皆斷 → 本輪不再走瀏覽器)。補全文環節之升級與瀏覽器佇列共用同一份。
// 【子行程層之失敗】逾時 → 頁面失敗(計 tries);其餘(找不到 node、CLI 本身拋錯、讀不到結果)→ 環境失敗(不計 tries)——
//   CLI 壞了不是文件的錯,算在文件頭上會三輪內把整批可救件判 dead。
// 【detail 抓取器 'browser'】doc.fetcher='browser'(w-data-pipeline 之指名路由欄,itemContract 保留之)者由此抓;
//   跨輪件之階梯前置一階 curl(暫時性失敗不必動用瀏覽器)。安裝方可經 cfg.fetchers 以同 id 置換(如改用遠端渲染服務)。

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import isobj from 'wsemi/src/isobj.mjs'
import isarr from 'wsemi/src/isarr.mjs'
import fsCreateFolder from 'wsemi/src/fsCreateFolder.mjs'
import W from 'w-data-pipeline/src/WDataPipeline.mjs'
import { execCliJsonFile } from '../core/runnerPackage.mjs'
import { gateDetectorSpecsOf } from '../core/util/injectables.mjs'
import { BROWSER_STEPS, ladderFor } from '../stores/fetchPolicy.mjs'
const { defineFetcher } = W

/** CLI 之絕對路徑(模組所在資料夾之檔案:以 fileURLToPath 解析;URL.pathname 為 URL 編碼字串,遇空格、中文、Windows 磁碟機代號會錯) */
export const BROWSER_CLI = fileURLToPath(new URL('./fetch_web_cli.mjs', import.meta.url))

/** 階梯固定參數(非設定鍵:調整須同時重估逾時;各值依實測抽樣) */
export const BROWSER_LADDER_CONST = {
    curlTimeoutMs: 15_000, // 跨輪前置之 curl 階(--max-time)
    camofoxStartMs: 30_000, // Camofox server 啟動等待
    camofoxSnapshotRetries: 1,
    camofoxSnapshotWaitMs: 4_000,
    playwrightOverheadMs: 25_000, // Chrome 啟動＋導航後等待(3 s)＋解析
    camofoxRequestMs: 15_000, // Camofox 每次 HTTP 請求之硬上限(w-fetch-web runCamofoxAttempt FETCH_TIMEOUT_MS)
    cliOverheadMs: 10_000, // node 子行程啟動與載入
}

/**
 * 由 settings.capture 組各階選項
 *
 * @param {Object} cap 輸入 settings.capture(取 browser.navTimeoutMs、browser.camofox.port)
 * @returns {Object} 回傳 stepOpts(browserLadder 之 stepOpt 所讀)
 * @example
 * console.log(stepOptsOf({ browser: { navTimeoutMs: 20000, camofox: { port: 9377 } } }))
 * // => {
 * // =>   navigationTimeoutMs: 20000,
 * // =>   curlTimeoutMs: 15000,
 * // =>   camofoxPort: 9377,
 * // =>   serverStartTimeoutMs: 30000,
 * // =>   snapshotRetries: 1,
 * // =>   snapshotWaitMs: 4000
 * // => }
 */
export function stepOptsOf(cap) {
    return {
        navigationTimeoutMs: cap.browser?.navTimeoutMs,
        curlTimeoutMs: BROWSER_LADDER_CONST.curlTimeoutMs,
        camofoxPort: cap.browser?.camofox?.port,
        serverStartTimeoutMs: BROWSER_LADDER_CONST.camofoxStartMs,
        snapshotRetries: BROWSER_LADDER_CONST.camofoxSnapshotRetries,
        snapshotWaitMs: BROWSER_LADDER_CONST.camofoxSnapshotWaitMs,
    }
}

/**
 * 階梯之最壞耗時(子行程硬逾時之依據)
 *
 * @param {Array} steps 輸入階名陣列
 * @param {Object} cap 輸入 settings.capture(取 browser.navTimeoutMs)
 * @returns {Integer} 回傳毫秒數
 * @example
 * console.log(ladderTimeoutMs(['curl'], { browser: { navTimeoutMs: 20000 } }) > 15000)
 * // => true
 */
export function ladderTimeoutMs(steps, cap) {
    const c = BROWSER_LADDER_CONST
    let ms = c.cliOverheadMs
    for (const name of isarr(steps) ? steps : []) {
        const m = BROWSER_STEPS[name]?.method
        if (m === 'curl') ms += c.curlTimeoutMs + 5_000
        else if (m === 'playwright') ms += (cap?.browser?.navTimeoutMs || 20_000) + c.playwrightOverheadMs
        else if (m === 'camofox') ms += c.camofoxStartMs + c.camofoxRequestMs * (3 + c.camofoxSnapshotRetries) + c.camofoxSnapshotWaitMs * c.camofoxSnapshotRetries + 1_000
    }
    return ms
}

/**
 * 以子行程執行瀏覽器階梯(結果檔讀回即刪)
 *
 * @param {String} url 輸入文章網址
 * @param {Array} steps 輸入階名陣列
 * @param {Object} opt 輸入設定物件
 * @param {Object} opt.capture 輸入 settings.capture(取 browser.navTimeoutMs、browser.camofox.port，與 standards 之 minTextChars、placeholderPatterns、paywallPatterns、maxSaneChars)
 * @param {String} opt.tmpDir 輸入暫存目錄(工作目錄之 tmp;子資料夾 browser)
 * @param {String} [opt.tag='doc'] 輸入暫存檔名標記(通常為 doc id)
 * @param {Array} [opt.skip=[]] 輸入本輪已斷路之方法
 * @param {Array} [opt.adapterSpecs=[]] 輸入帶 module 之站台 adapter 規格(總組裝 deps.siteAdapterSpecs;子行程據以載入)
 * @param {Function} [opt.runCli=execCliJsonFile] 輸入子行程執行器(測試注入)
 * @returns {Promise} 回傳 Promise，resolve 回傳 CLI 結果(見 browserLadder);子行程層失敗時 reason 為 'cli-timeout'(頁面失敗)或 'browser-env'(環境失敗)
 * @example
 * // 以替身 runCli 取代真實子行程(不啟動瀏覽器)；暫存設定檔寫入 tmpDir 下的 browser 資料夾，讀回後即刪
 * let runCli = async () => ({ status: 'success', method: 'curl', content: '黑洞光譜的觀測結果', title: '黑洞光譜' })
 * let r = await runBrowserCli('https://example.com/post/1', ['curl'], { capture: {}, tmpDir: './tmp', tag: 'demo', runCli })
 * console.log(r.status, r.method, r.content, r.envBroken, r.steps)
 * // => success curl 黑洞光譜的觀測結果 [] []
 *
 * // 子行程層逾時 → 頁面失敗
 * let runCliBad = async () => ({ status: 'error', message: 'EXEC TIMEOUT' })
 * let r2 = await runBrowserCli('https://example.com/post/1', ['curl'], { capture: {}, tmpDir: './tmp', tag: 'demo', runCli: runCliBad })
 * console.log(r2.status, r2.reason)
 * // => error cli-timeout
 */
export async function runBrowserCli(url, steps, opt = {}) {
    if (!isobj(opt)) opt = {}
    const cap = opt.capture || {}
    const dir = path.join(opt.tmpDir || 'tmp', 'browser')
    const tag = String(opt.tag || 'doc').replace(/[^\w.-]/g, '_').slice(0, 60)
    const optsFile = path.join(dir, `${tag}.opts.json`)
    const outFile = path.join(dir, `${tag}.out.json`)
    const timeoutMs = ladderTimeoutMs(steps, cap)
    // 暫存目錄與設定檔之寫入亦屬本機環境(磁碟滿、權限):失敗即 browser-env(不計 tries)。須在此 try 之內:
    //   若拋出於 try 之外,同輪升級件走逐篇鏈異常、瀏覽器佇列件被捕成 fetch-error → browser-failed 而計次
    try {
        fsCreateFolder(dir)
        fs.writeFileSync(optsFile, JSON.stringify({
            steps,
            skip: isarr(opt.skip) ? opt.skip : [],
            stepOpts: stepOptsOf(cap),
            // 子行程之健全閘與管線內同一組參數(閘之各類判準於子行程內同樣生效;新增參數須一併帶入);偵測器陣列化為跨行程規格
            //   (內建記 id、自訂記 module;null＝子行程用內建),子行程依同一順序重建
            gate: { minTextChars: cap.standards?.minTextChars, placeholderPatterns: cap.standards?.placeholderPatterns, paywallPatterns: cap.standards?.paywallPatterns, maxSaneChars: cap.standards?.maxSaneChars, detectorSpecs: gateDetectorSpecsOf(cap.standards?.detectors) },
            // 帶 module 之站台 adapter(總組裝之 siteAdapterSpecs;子行程載入後與自帶清單合併)
            adapterSpecs: isarr(opt.adapterSpecs) ? opt.adapterSpecs : [],
        }), 'utf8')
        fs.rmSync(outFile, { force: true })
    }
    catch (e) {
        return { status: 'error', reason: 'browser-env', httpCode: 0, message: `瀏覽器暫存檔寫入失敗：${String(e?.message || e).slice(0, 200)}`, final: false, envBroken: [], steps: [] }
    }
    const run = typeof opt.runCli === 'function' ? opt.runCli : execCliJsonFile
    let r
    try {
        r = await run({ script: BROWSER_CLI, exe: process.execPath, args: [url, optsFile], outputPath: outFile, timeoutMs })
    }
    catch (e) {
        r = { status: 'error', message: `子行程無法啟動：${e?.message || e}` }
    }
    finally {
        // 清暫存失敗(檔案被鎖)不得蓋掉本篇結果
        for (const f of [optsFile, outFile]) {
            try {
                fs.rmSync(f, { force: true })
            }
            catch { /* 下輪同名覆寫 */ }
        }
    }
    if (!isobj(r)) r = { status: 'error', message: '子行程回傳非物件' }
    // execCliJsonFile 之子行程層失敗沒有 reason(只有 message):逾時算頁面失敗,其餘算環境失敗(檔頭)
    if (r.status !== 'success' && !r.reason) {
        const timedOut = /TIMEOUT/i.test(String(r.message || ''))
        return { status: 'error', reason: timedOut ? 'cli-timeout' : 'browser-env', httpCode: 0, message: String(r.message || '').slice(0, 300), final: false, envBroken: [], steps: [] }
    }
    return { envBroken: [], steps: [], ...r }
}

/**
 * 一輪之瀏覽器狀態(配額、軟性時間上限、方法斷路、統計)
 *
 * @param {Object} cap 輸入 settings.capture(取 browser.perRun、browser.maxMs、browser.navTimeoutMs)
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Function} [opt.remainingMs] 輸入本段可用之剩餘毫秒數之函數(補全文子階段傳扣掉保留給後段之時間後者;未保留即整輪剩餘)，未給視為無限
 * @param {Function} [opt.now=Date.now] 輸入時鐘(測試注入)
 * @returns {Object} 回傳狀態物件 { canStart(steps), take(), account(r), remainingQuota(), timeUp(), broken:Set, stats }
 * @example
 * let t = 0
 * let round = createBrowserRound({ browser: { perRun: 2, maxMs: 60000 } }, { now: () => t })
 * console.log(round.canStart(['playwright']), round.remainingQuota())
 * // => true 2
 *
 * round.take()
 * round.account({ status: 'error', reason: 'browser-env', envBroken: ['playwright'] })
 * console.log(round.remainingQuota(), round.canStart(['playwright']), round.stats)
 * // => 1 false { tried: 1, ok: 0, envFail: 1, final: 0, pageFail: 0 }
 *
 * t = 61000
 * console.log(round.timeUp())
 * // => true
 */
export function createBrowserRound(cap, opt = {}) {
    if (!isobj(opt)) opt = {}
    const now = typeof opt.now === 'function' ? opt.now : Date.now
    const t0 = now()
    const quota = Number.isInteger(cap?.browser?.perRun) && cap.browser.perRun >= 0 ? cap.browser.perRun : 0
    const maxMs = Number.isInteger(cap?.browser?.maxMs) && cap.browser.maxMs >= 0 ? cap.browser.maxMs : 0
    const broken = new Set()
    const stats = { tried: 0, ok: 0, envFail: 0, final: 0, pageFail: 0 }
    let used = 0
    const remainingRound = () => (typeof opt.remainingMs === 'function' ? opt.remainingMs() : Infinity)
    const methodsOf = (steps) => (isarr(steps) ? steps : []).map((s) => BROWSER_STEPS[s]?.method).filter(Boolean)
    return {
        broken,
        stats,
        remainingQuota: () => Math.max(0, quota - used),
        timeUp: () => now() - t0 >= maxMs,
        /**
         * 可否再開一篇:配額未盡、未逾軟性時間上限、階梯中尚有未斷路之瀏覽器方法、整輪剩餘 ≥ 本篇硬逾時＋60 秒
         * @param {Array} steps 輸入本篇階梯
         * @returns {Boolean} 回傳可否開工
         */
        canStart(steps) {
            if (used >= quota || now() - t0 >= maxMs) return false
            if (!methodsOf(steps).some((m) => m !== 'curl' && !broken.has(m))) return false
            return remainingRound() >= ladderTimeoutMs(steps, cap) + 60_000
        },
        take() {
            used++
            stats.tried++
        },
        /**
         * 記一篇之結果:環境失敗之方法加入斷路
         * @param {Object} r 輸入 runBrowserCli 之結果
         */
        account(r) {
            for (const m of isarr(r?.envBroken) ? r.envBroken : []) broken.add(m)
            if (r?.status === 'success') stats.ok++
            else if (r?.reason === 'browser-env') stats.envFail++
            else if (r?.final) stats.final++
            else stats.pageFail++
        },
    }
}

/**
 * detail 抓取器 'browser'(只供指名:doc.fetcher='browser';跨輪件,階梯前置 curl)
 *
 * 讀 doc.lastClass 決定階梯(缺省 render);doc._browserRound 為該輪狀態(由補全文子階段注入;缺省時本次呼叫自建,不限配額以外之條件)
 *
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Function} [opt.runCli] 輸入子行程執行器(測試注入)
 * @returns {Object} 回傳 defineFetcher 產物(id 'browser'、role 'detail'、只供指名)
 * @example
 * // 以替身 runCli 取代真實子行程(不啟動瀏覽器)
 * let runCli = async () => ({ status: 'success', method: 'curl', content: '黑洞光譜的觀測結果', title: '黑洞光譜' })
 * let f = createBrowserFetcher({ runCli })
 * let ctx = { deps: { settings: { capture: { browser: { camofox: { enabled: false } } } }, dirs: { tmp: './tmp' } } }
 * let r = await f.fetch({ id: 'd1', url: 'https://example.com/post/1', lastClass: 'render' }, ctx)
 * console.log(f.id, f.role, r.ok, r.text)
 * // => browser detail true 黑洞光譜的觀測結果
 */
export function createBrowserFetcher(opt = {}) {
    if (!isobj(opt)) opt = {}
    return defineFetcher({
        id: 'browser',
        role: 'detail',
        kinds: ['__named-only__'],
        // 管線層逾時須大於子行程硬逾時(由子行程自己收攤並樹狀殺;管線層只是不再等,見 w-data-pipeline attemptFetch)
        timeoutMs: 900_000,
        fetch: async (doc, ctx) => {
            const cap = ctx.deps.settings.capture
            // 下游(如摘要)回報「素材壞了」之重抓(doc.refetchSkip):排除產生該素材之方法,含 curl 者不前置 curl——否則跨輪階梯首階 curl
            //   原樣取回同一份、過閘即停,等於沒換抓法。排除後無階可跑 → 終態(無他法可抓)
            const avoid = new Set(isarr(doc.refetchSkip) ? doc.refetchSkip.map(String) : [])
            const steps = ladderFor(doc.lastClass || 'render', { camofoxEnabled: cap.browser.camofox.enabled, crossRound: !avoid.has('curl') })
                .filter((s) => !avoid.has(BROWSER_STEPS[s]?.method))
            if (!steps.length) return { ok: false, reason: 'no-alt-method', message: `素材問題之重抓：已無可換之抓取方法（排除 ${[...avoid].join('、')}）`, extra: { final: true, steps: [] } }
            const round = doc._browserRound || null
            if (round) round.take()
            const r = await runBrowserCli(doc.url, steps, { capture: cap, tmpDir: ctx.deps.dirs?.tmp, tag: doc.id, skip: round ? [...round.broken] : [], adapterSpecs: ctx.deps.siteAdapterSpecs, runCli: opt.runCli })
            if (round) round.account(r)
            const extra = { method: r.method || '', finalUrl: r.finalUrl || '', adapterId: r.adapterId || '', httpCode: r.httpCode || 0, final: !!r.final, envBroken: r.envBroken || [], steps: (r.steps || []).map((s) => `${s.step}:${s.ok ? 'ok' : (s.skipped || s.gate || s.reason || 'fail')}`), ...(isobj(r.evidence) ? { evidence: r.evidence } : {}) }
            return r.status === 'success'
                ? { ok: true, text: r.content, title: r.title, extra }
                : { ok: false, reason: r.reason, message: r.message, extra }
        },
    })
}

export default { BROWSER_CLI, BROWSER_LADDER_CONST, stepOptsOf, ladderTimeoutMs, runBrowserCli, createBrowserRound, createBrowserFetcher }
