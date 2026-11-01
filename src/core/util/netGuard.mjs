// netGuard.mjs — 本機網路可用性之確定性判準(探測固定端點):網路問題不得算在對象(文章、來源、線索、AI 批次)頭上
//
// 【為何需要】斷網時若逐篇照常分流計次:文章試滿判 dead、來源連敗停用、線索 2 輪即永久 failed、
//   AI 批次連續失敗而出隊——「網路問題」被記成「對象有問題」。故需要一個本機網路是否可用之確定性判準。
// 【判準】探測一組固定端點(預設為抓取器本就使用之 API／搜尋端點,不另引第三方;settings.capture.network.probeUrls 可改):
//   任一端點回 HTTP 狀態(含 4xx／5xx;407 代理須驗證除外)＝網路通;全部連線失敗／逾時＝不通。以失敗比例推斷屬機率判斷,不採。
// 【兩種詢問】check():開工前,結果快取 ttlMs(預設 60 秒);confirmDown():計次之前——距上次探測逾 confirmMinMs(預設 15 秒)即強制重探,
//   不沿用「通」之快取(剛斷網那一段不可因快取而照樣計次)。
// 【能證明／不能證明】能證明:探測當下這幾個端點自本機是否連得上。不能證明:其他網站之可達性(站台自身故障另由分流與退避處理)、
//   探測之後才斷網者(下一次 confirmDown 會發現)。端點全數同時故障而本機網路正常時,本判準會判「不通」而略過抓取(少抓,不誤判對象)。

import isobj from 'wsemi/src/isobj.mjs'
import isarr from 'wsemi/src/isarr.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import fetchWebByCurl from 'w-fetch-web/src/fetchWebByCurl.mjs'
import { oneline } from '../runnerPackage.mjs'

/**
 * 探測失敗之說明(一行):有 HTTP 碼寫碼,否則寫 reason——fetchWebByCurl 以靜默 curl 執行,連線失敗時 message 只是整串指令
 *   (含換行,不含 curl 之錯誤碼;取它會讓 WARN 斷成兩行且看不出原因),故不取 message
 *
 * @param {Object} r 輸入 fetchWebByCurl 之結果
 * @returns {String} 回傳說明
 * @example
 * console.log(probeFailText({ httpCode: 503 }))
 * // => HTTP 503
 *
 * console.log(probeFailText({ reason: 'timeout' }))
 * // => 逾時（timeout）
 *
 * console.log(probeFailText({ reason: 'ECONNREFUSED' }))
 * // => 連線失敗（ECONNREFUSED）
 */
export function probeFailText(r) {
    const code = Number(r?.httpCode) || 0
    if (code) return `HTTP ${code}`
    const reason = oneline(String(r?.reason || ''), 40)
    return reason === 'timeout' ? '逾時（timeout）' : `連線失敗${reason ? `（${reason}）` : ''}`
}

/**
 * 內建探測:curl 取端點(不重試);收到任何 HTTP 狀態(407 除外)即連得上
 *
 * @param {String} url 輸入端點網址
 * @param {Integer} timeoutMs 輸入逾時毫秒
 * @returns {Promise} 回傳 Promise，resolve 回傳 { url, reachable:Boolean, httpCode:Integer, message:String }
 */
async function curlProbe(url, timeoutMs) {
    const r = await fetchWebByCurl(url, { timeoutMs, maxRetries: 0 })
    const code = Number(r?.httpCode) || 0
    const reachable = r?.status === 'success' || (code > 0 && code !== 407)
    return { url, reachable, httpCode: code, message: reachable ? '' : probeFailText(r) }
}

/**
 * 端點之顯示名(主機)
 *
 * @param {String} url 輸入網址
 * @returns {String} 回傳主機名(解析失敗回原字串)
 */
function hostOf(url) {
    try {
        return new URL(url).hostname
    }
    catch {
        return String(url)
    }
}

/**
 * 建立本機網路判斷器
 *
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Array} [opt.urls=[]] 輸入探測端點網址陣列(空陣列＝不判斷,恆視為通)
 * @param {Integer} [opt.timeoutMs=8000] 輸入單一端點逾時毫秒(各端點並行)
 * @param {Integer} [opt.ttlMs=60000] 輸入 check() 之快取毫秒
 * @param {Integer} [opt.confirmMinMs=15000] 輸入 confirmDown() 強制重探之最短間隔毫秒(限頻)
 * @param {Function} [opt.probe] 輸入探測函數 (url, timeoutMs) => Promise<{ reachable, httpCode, message }>(測試注入;預設 curl)
 * @param {Function} [opt.now=Date.now] 輸入時鐘(測試注入)
 * @returns {Object} 回傳 { check(), confirmDown(), isDown(), describe(), state(), probes() }
 * @example
 * const g = createNetGuard({ urls: ['https://a.example'], probe: async () => ({ reachable: false, httpCode: 0, message: 'x' }) })
 * console.log(await g.confirmDown())
 * // => true
 */
export function createNetGuard(opt = {}) {
    if (!isobj(opt)) opt = {}
    const urls = (isarr(opt.urls) ? opt.urls : []).map(String).filter(Boolean)
    const timeoutMs = Number.isInteger(opt.timeoutMs) && opt.timeoutMs > 0 ? opt.timeoutMs : 8000
    const ttlMs = Number.isInteger(opt.ttlMs) && opt.ttlMs >= 0 ? opt.ttlMs : 60_000
    const confirmMinMs = Number.isInteger(opt.confirmMinMs) && opt.confirmMinMs >= 0 ? opt.confirmMinMs : 15_000
    const probe = isfun(opt.probe) ? opt.probe : curlProbe
    const now = isfun(opt.now) ? opt.now : Date.now
    let st = { up: null, at: 0, detail: [] }
    let probed = false // 是否已有探測結果(不以 st.at 之真假判——時刻可為 0)
    let nProbes = 0
    let inflight = null

    /**
     * 並行探測全部端點(同時只跑一次;並發之詢問共用同一次探測)
     * @returns {Promise} 回傳 Promise，resolve 回傳狀態物件
     */
    const probeAll = () => {
        if (inflight) return inflight
        inflight = (async () => {
            try {
                if (!urls.length) {
                    st = { up: true, at: now(), detail: [] }
                    probed = true
                    return st
                }
                nProbes++
                // 任一端點連得上即判通(不等其餘端點逾時);全部回來皆不通才判不通
                const detail = []
                const up = await new Promise((resolve) => {
                    let pending = urls.length
                    for (const u of urls) {
                        Promise.resolve()
                            .then(() => probe(u, timeoutMs))
                            .then((r) => ({ url: u, reachable: r?.reachable === true, httpCode: Number(r?.httpCode) || 0, message: oneline(String(r?.message || ''), 120) }))
                            .catch((e) => ({ url: u, reachable: false, httpCode: 0, message: oneline(String(e?.message || e), 120) }))
                            .then((x) => {
                                detail.push(x)
                                if (x.reachable) resolve(true)
                                if (--pending === 0) resolve(false)
                            })
                    }
                })
                st = { up, at: now(), detail: [...detail] }
                probed = true
                return st
            }
            finally {
                inflight = null
            }
        })()
        return inflight
    }

    return {
        /**
         * 開工前之判斷(快取 ttlMs)
         * @returns {Promise} 回傳 Promise，resolve 回傳 { up:Boolean, at, detail }
         */
        async check() {
            if (probed && now() - st.at < ttlMs) return st
            return probeAll()
        },
        /**
         * 計次前之確認:距上次探測逾 confirmMinMs 即強制重探(不沿用「通」之快取)
         * @returns {Promise} 回傳 Promise，resolve 回傳是否不通(Boolean)
         */
        async confirmDown() {
            if (probed && now() - st.at < confirmMinMs) return st.up === false
            return (await probeAll()).up === false
        },
        /** @returns {Boolean} 回傳最近一次探測是否不通(未探測過回 false;同步,供 shouldStop 用) */
        isDown: () => st.up === false,
        /** @returns {String} 回傳最近一次探測之說明(各端點主機與失敗原因) */
        describe: () => st.detail.map((x) => `${hostOf(x.url)}：${x.reachable ? `通（HTTP ${x.httpCode || '-'}）` : `不通（${x.message || '連線失敗'}）`}`).join('；'),
        /** @returns {Object} 回傳最近一次探測之狀態 */
        state: () => ({ ...st }),
        /** @returns {Integer} 回傳實際探測次數(測試與報告用) */
        probes: () => nProbes,
    }
}

/**
 * 預設探測端點:抓取器本就使用之端點基底(搜尋、學術 API 兩家)之原點——不另引第三方。capture.network.probeUrls 給了即用之
 *
 * @param {Object} [cap={}] 輸入抓取設定(settings.capture;取 network.probeUrls、services 之 bingNews／openAlex／arxiv 之 base)
 * @returns {Array} 回傳端點網址陣列(去重)
 * @example
 * console.log(netProbeUrlsOf({ services: { openAlex: { base: 'https://api.openalex.org/works' } } }))
 * // => [ 'https://api.openalex.org' ]
 */
export function netProbeUrlsOf(cap = {}) {
    const c = isobj(cap) ? cap : {}
    const urls = c.network?.probeUrls
    if (isarr(urls)) return [...new Set(urls.map(String).filter(Boolean))]
    const sv = isobj(c.services) ? c.services : {}
    const out = []
    for (const b of [sv.bingNews?.base, sv.openAlex?.base, sv.arxiv?.base]) {
        try {
            if (b) out.push(new URL(String(b)).origin)
        }
        catch { /* 不合法之基底略過 */ }
    }
    return [...new Set(out)]
}

/**
 * 子階段開工前之判斷(共用):不通 → WARN「本機網路不通」並回 true,呼叫端略過本段之網路工作
 *
 * @param {Object} ctx 輸入鏈上下文(取 ctx.deps.netGuard、ctx.log)
 * @param {String} label 輸入子階段之說明(日誌用,如「輪抓」)
 * @returns {Promise} 回傳 Promise，resolve 回傳是否略過(未設 netGuard 回 false)
 * @example
 * // 以替身探測函數模擬斷網，不實際連網
 * let netGuard = createNetGuard({ urls: ['https://a.example'], probe: async () => ({ reachable: false, httpCode: 0, message: 'x' }) })
 * let ctx = { deps: { netGuard }, log: { warn: (s) => console.log('WARN', s) } }
 * console.log(await netDownAtStart(ctx, '輪抓'))
 * // => WARN 輪抓：本機網路不通（a.example：不通（x）），本段略過（不計任何對象之失敗）
 * // => true
 */
export async function netDownAtStart(ctx, label) {
    const g = ctx?.deps?.netGuard
    if (!g || !isfun(g.check)) return false
    const s = await g.check()
    if (s.up !== false) return false
    ctx.log?.warn?.(`${label}：本機網路不通（${g.describe()}），本段略過（不計任何對象之失敗）`)
    return true
}

/**
 * 落帳計次前之確認(共用):不通 → 回 true(呼叫端不計該對象之失敗,並停本段)
 *
 * @param {Object} ctx 輸入鏈上下文(取 ctx.deps.netGuard)
 * @returns {Promise} 回傳 Promise，resolve 回傳是否不通(未設 netGuard 回 false)
 * @example
 * // 以替身探測函數模擬斷網，不實際連網
 * let netGuard = createNetGuard({ urls: ['https://a.example'], probe: async () => ({ reachable: false, httpCode: 0, message: 'x' }) })
 * console.log(await netDownNow({ deps: { netGuard } }), await netDownNow({}))
 * // => true false
 */
export async function netDownNow(ctx) {
    const g = ctx?.deps?.netGuard
    if (!g || !isfun(g.confirmDown)) return false
    return g.confirmDown()
}

export default { createNetGuard, netProbeUrlsOf, netDownAtStart, netDownNow, probeFailText }
