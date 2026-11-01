// browserLadder.mjs — 瀏覽器階梯之執行邏輯(純邏輯;fetchWeb 與健全閘皆注入):依序跑各階,任一階取得合格正文即停
//
// 【為何獨立成檔】實際執行於子行程 CLI(fetch_web_cli.mjs,子行程＋硬逾時＋樹狀殺,見該檔頭);
//   階梯之判斷(成功即停、決定性失敗即停、環境失敗只斷該方法、每階結果都過健全閘)抽成純函數,才能不啟動瀏覽器而測完整個表。
// 【每階一律 maxRetries:0】w-fetch-web 預設重試 5 次、Camofox 每次自起 server;重試交給下一階或下一輪,
//   否則單篇最壞耗時無上界(camofox-empty 未標不可重試亦會被重試)。
// 【成功＝抓取成功且過健全閘】w-fetch-web 之成功門檻僅 50 字,Camofox 不檢 HTTP 狀態(抽樣中 265～273 字之封鎖樣板皆判成功);
//   故每階結果交 contentGate,未過者視同該階失敗(付費牆即停:瀏覽器無帳號)。

import isobj from 'wsemi/src/isobj.mjs'
import isarr from 'wsemi/src/isarr.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import { BROWSER_STEPS, FINAL_HTTP_CODES, httpCodeOf, isEnvFailure } from '../stores/fetchPolicy.mjs'

/**
 * 組單階之 fetchWeb 選項
 *
 * @param {Object} def 輸入階定義(BROWSER_STEPS 之值)
 * @param {Object} so 輸入階選項 { navigationTimeoutMs, curlTimeoutMs, camofoxPort, serverStartTimeoutMs, snapshotRetries, snapshotWaitMs, adapters }
 * @returns {Object} 回傳 fetchWeb 之 opt
 */
function stepOpt(def, so) {
    const base = { method: def.method, parse: true, maxRetries: 0, useShowLog: false }
    if (isarr(so.adapters)) base.adapters = so.adapters
    if (def.method === 'curl') return { ...base, timeoutMs: so.curlTimeoutMs }
    if (def.method === 'playwright') return { ...base, navigationTimeoutMs: so.navigationTimeoutMs, waitForRedirect: !!def.waitForRedirect }
    return { ...base, port: so.camofoxPort, serverStartTimeoutMs: so.serverStartTimeoutMs, snapshotRetries: so.snapshotRetries, snapshotWaitMs: so.snapshotWaitMs }
}

/**
 * 依序跑瀏覽器階梯(任一階取得過健全閘之正文即停;HTTP 決定性失敗或付費牆即停;環境失敗只斷該方法並續走下一階)
 *
 * @param {String} url 輸入文章網址
 * @param {Array} steps 輸入階名陣列(fetchPolicy BROWSER_STEPS 之鍵，如 ['curl','playwright','camofox'])
 * @param {Object} opt 輸入設定物件
 * @param {Function} opt.fetchWeb 輸入 w-fetch-web 之 fetchWeb(測試注入替身)
 * @param {Object} opt.gate 輸入健全閘(createContentGate 之產物)
 * @param {Array} [opt.skip=[]] 輸入本輪已斷路之方法名('playwright'／'camofox'／'curl')
 * @param {Object} [opt.stepOpts={}] 輸入階選項(見 stepOpt)
 * @returns {Promise} 回傳 Promise，resolve 回傳 { status:'success'|'error', reason, httpCode, message, title?, content?, method?, adapterId?, finalUrl?, final:Boolean, envBroken:Array, steps:Array }
 * @throws {Error} opt.fetchWeb 非函數或 opt.gate 缺 assess 時拋出
 * @example
 * // 以替身 fetchWeb 與健全閘執行(不連網、不啟動瀏覽器)；第一階即取得合格正文，故不再跑後續階
 * let fetchWeb = async (url, o) => ({ status: 'success', method: o.method, content: '黑洞光譜的觀測結果', title: '黑洞光譜' })
 * let gate = { assess: () => ({ ok: true }) }
 * let r = await runBrowserLadder('https://example.com/post/1', ['curl', 'playwright'], { fetchWeb, gate })
 * console.log(r.status, r.method, r.content, r.steps.map((s) => s.step))
 * // => success curl 黑洞光譜的觀測結果 [ 'curl' ]
 */
export async function runBrowserLadder(url, steps, opt = {}) {

    //check
    if (!isobj(opt) || !isfun(opt.fetchWeb) || !isfun(opt.gate?.assess)) {
        throw new Error('runBrowserLadder 需要 opt.fetchWeb 與 opt.gate')
    }
    if (!isarr(steps)) steps = []

    const skip = new Set(isarr(opt.skip) ? opt.skip : [])
    const so = isobj(opt.stepOpts) ? opt.stepOpts : {}
    const envBroken = []
    const trail = []
    let last = null
    // 瀏覽器方法(非 curl 階)是否真的執行過:跨輪階梯前置之 curl 失敗後,瀏覽器階若全為環境失敗/斷路,失敗仍屬本機環境——
    //   不可只以 last 判(它已被前置 curl 之失敗設定),否則末尾會回 curl 之原因而落帳計次
    const hasBrowserStep = steps.some((s) => BROWSER_STEPS[s] && BROWSER_STEPS[s].method !== 'curl')
    let ranBrowser = false

    for (const name of steps) {
        const def = BROWSER_STEPS[name]
        if (!def) {
            trail.push({ step: name, skipped: 'unknown-step' })
            continue
        }
        if (skip.has(def.method) || envBroken.includes(def.method)) {
            trail.push({ step: name, skipped: 'env-broken' })
            continue
        }
        const t0 = Date.now()
        let r
        try {
            r = await opt.fetchWeb(url, stepOpt(def, so))
        }
        catch (e) {
            r = { status: 'error', reason: 'fetcher-error', message: String(e?.message || e) }
        }
        const ms = Date.now() - t0
        if (r?.status === 'success') {
            if (def.method !== 'curl') ranBrowser = true
            const g = opt.gate.assess({ text: r.content, title: r.title, adapterId: r.adapterId, url, finalUrl: r.finalUrl || '' })
            if (g.ok) {
                trail.push({ step: name, method: r.method, ok: true, ms, chars: String(r.content || '').length })
                return { status: 'success', reason: '', httpCode: 0, message: '', title: r.title || '', content: String(r.content || ''), method: r.method || def.method, adapterId: r.adapterId || '', finalUrl: r.finalUrl || '', final: false, envBroken, steps: trail }
            }
            trail.push({ step: name, method: r.method, ok: false, ms, gate: g.kind, hit: g.hit })
            last = { reason: g.kind, httpCode: 0, message: `健全閘：${g.hit}` }
            // 付費牆(無帳號)、頁面自述找不到(Camofox 不檢 HTTP 狀態,404 頁會以「成功」回來)、轉址至站台首頁(軟 404)即停:換階也救不回。
            //   回傳判定所依之正文(evidence;落 dead 時另存,閘改版後可依版重判)
            if (['paywall', 'not-found', 'soft-404'].includes(g.kind)) {
                return { status: 'error', ...last, final: true, evidence: { text: String(r.content || ''), title: r.title || '', method: r.method || def.method, finalUrl: r.finalUrl || '' }, envBroken, steps: trail }
            }
            continue
        }
        const code = httpCodeOf(r)
        const env = isEnvFailure(r)
        trail.push({ step: name, method: def.method, ok: false, ms, reason: r?.reason || '', httpCode: code || undefined, env: env || undefined, message: String(r?.message || '').slice(0, 160) })
        if (env) {
            envBroken.push(def.method)
            continue
        }
        if (def.method !== 'curl') ranBrowser = true
        last = { reason: r?.reason || 'unknown', httpCode: code, message: String(r?.message || '').slice(0, 300) }
        if (FINAL_HTTP_CODES.includes(code)) return { status: 'error', ...last, final: true, envBroken, steps: trail }
    }

    // 瀏覽器方法沒有任何一階真正執行(全被斷路或全為環境失敗):環境問題,不算在文件頭上——含「前置 curl 已失敗」者
    //   (階梯本為瀏覽器而設;只有 curl 一階之階梯〔下游回報素材問題而排除瀏覽器方法者〕不在此列)
    if (!last || (hasBrowserStep && !ranBrowser)) {
        return { status: 'error', reason: 'browser-env', httpCode: 0, message: `瀏覽器環境不可用（${[...skip, ...envBroken].join('、') || '無可用階'}）${last ? `；前置 curl：${last.reason}` : ''}`, final: false, envBroken, steps: trail }
    }
    return { status: 'error', ...last, final: false, envBroken, steps: trail }
}

export default runBrowserLadder
