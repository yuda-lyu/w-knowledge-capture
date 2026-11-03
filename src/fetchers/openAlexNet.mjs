// openAlexNet.mjs — OpenAlex 請求之共用件:API 金鑰(讀取、附帶、遮罩)、429 之固定訊息、請求包裝(openAlexGet)
//
// 【為何有金鑰】OpenAlex 自 2026 年起不帶金鑰之請求共用「同一網路 IP」每日 US$0.10 之額度(超額 HTTP 429);免費金鑰另有每日 US$1。
//   官方文件(https://help.openalex.org/api/authentication/ 〈Sending your key〉):金鑰以 query 參數 `api_key=` 或標頭 `Authorization: Bearer` 擇一,
//   「Both work identically」;`/rate-limit` 須帶金鑰(不帶回 401)。本套件連 OpenAlex 之站點:網格來源(fetchers/defaultFetchers readGrid)、
//   領域發現之驗證(stages/areaStage validateAreaQuery)、原文回溯之 DOI 批次與題名搜尋(ops/refetchSources defaultNet)——一律經本檔取金鑰與發請求。
// 【金鑰只在 .env,設定檔只放變數名】settings.capture.services.openAlex.apiKeyEnv 為環境變數「名」(預設 OPENALEX_API_KEY;'' 不帶金鑰),
//   值由金鑰檔(cfg.envFile,與 AI 金鑰同一檔)讀入(w-dispatch-ai 之 readEnvFile,不污染 process.env);檔不存在、無此變數或值為空 → 不帶金鑰,請求同無金鑰時。
//   金鑰值只存在 createOpenAlexAuth 之閉包內:auth 物件經 JSON／util.inspect／展開皆不含金鑰值,設定、info()、deps 之輸出不會帶出。
// 【為何用 query `api_key=` 而非標頭】內建抓取函數 w-fetch-web 之 fetchWebByCurl 不提供自訂標頭(其 curl 引數之標頭為固定清單),標頭需另寫一套傳輸;
//   兩者官方等價,故用 query。金鑰因而進入網址,漏出路徑有三,逐一處置:
//   ①fetchWebByCurl 重試時由 withRetry 把「失敗原因＋網址」寫到 process.stderr(w-fetch-web 內部,無關閉旗標)→ 帶金鑰之請求一律以 maxRetries:0 呼叫,
//      重試由本檔自行做(openAlexGet;條件與等待同 w-fetch-web:5xx／429／curl 錯誤,等 3 秒)——不經 withRetry 即無該行輸出;
//   ②curl 失敗之 message 含完整命令列(含網址)→ 請求結果之 message／reason／url／finalUrl 經 auth.mask 遮罩後才交呼叫端(wsemi 之 maskDiagText,
//      跨套件遮罩規格〈診斷輸出與遮罩〉D1:不自寫等價實作);呼叫端自組之錯誤文字(回應片段)亦經 auth.mask;
//   ③行程清單可見 curl 引數(本機他使用者)——query 與標頭用 curl 時皆如此,需避免者須改不經命令列之傳輸(列為已知限制)。
//   自訂抓取函數(opt.fetchWebByCurl 注入者)收到的是含金鑰之網址,其記錄與回傳之遮罩由注入方負責。
// 【429】官方文件(同上〈Rate limits〉):429 有兩因——超出每日額度,或超出每秒請求上限(無金鑰 10／秒,有金鑰 30／秒);「A per-second 429 costs nothing; wait a moment and retry」;
//   X-RateLimit-Reset 為「Seconds until reset (midnight UTC)」。故單次 429 之訊息兩因並列(OPENALEX_QUOTA_MESSAGE),不單稱額度用盡;
//   連續 OPENALEX_QUOTA_STOP_AFTER 次(皆已過 fetchWebByCurl 之 3 秒重試,每秒上限之 429 不會連續)才判定每日額度用盡而停止(ops/refetchSources)。

import isobj from 'wsemi/src/isobj.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import delay from 'wsemi/src/delay.mjs'
import getDiagSecrets from 'wsemi/src/getDiagSecrets.mjs'
import maskDiagText from 'wsemi/src/maskDiagText.mjs'
import readEnvFile from 'w-dispatch-ai/src/readEnvFile.mjs'
import { httpCodeOf } from '../stores/fetchPolicy.mjs'

/** 金鑰變數名之預設(OpenAlex 官方文件建議之名;settings.capture.services.openAlex.apiKeyEnv 之預設) */
export const OPENALEX_KEY_ENV_DEFAULT = 'OPENALEX_API_KEY'

/** 429 之固定訊息(日誌、處置帳、拋出之錯誤共用;巡檢白名單以前綴「OpenAlex HTTP 429」辨識;仍含「HTTP 429」字樣,依訊息取狀態碼者〔fetchPolicy.httpCodeOf〕照常判得 429) */
export const OPENALEX_QUOTA_MESSAGE = 'OpenAlex HTTP 429：每日額度用盡或每秒請求超限（每日額度於 UTC 00:00 重置）'

/** 原文回溯連續幾次 429 即判定每日額度用盡而停止(官方:每秒上限之 429 等一下重試即過,fetchWebByCurl 已重試一次,連續三次仍 429 即非每秒上限) */
export const OPENALEX_QUOTA_STOP_AFTER = 3

/** 帶金鑰之請求重試前之等待毫秒(同 w-fetch-web 第一次重試前之 3 秒) */
const RETRY_WAIT_MS = 3000

/**
 * 429 連續停止之說明文字(原文回溯之日誌與結果共用)
 *
 * @param {Integer} unprocessed 輸入未處理篇數
 * @returns {String} 回傳說明
 * @example
 * console.log(openAlexQuotaStopText(120))
 * // => OpenAlex 連續 3 次 429，判定每日額度用盡（UTC 00:00 重置），停止 OpenAlex 回溯；未處理 120 篇（未入處置帳，下次直接續跑）
 */
export function openAlexQuotaStopText(unprocessed) {
    return `OpenAlex 連續 ${OPENALEX_QUOTA_STOP_AFTER} 次 429，判定每日額度用盡（UTC 00:00 重置），停止 OpenAlex 回溯；未處理 ${unprocessed} 篇（未入處置帳，下次直接續跑）`
}

/**
 * 讀取 OpenAlex API 金鑰:變數名取自 capture.services.openAlex.apiKeyEnv,值取自金鑰檔(不污染 process.env;不讀 process.env——與 AI 金鑰同一來源)
 *
 * 變數名為空、金鑰檔未給／不存在／不可讀、檔內無此變數或值為空 → 回 ''(不帶金鑰,請求同無金鑰時)。值修剪空白、剝除成對首尾引號(readEnvFile)。
 *
 * @param {Object} cap 輸入 settings.capture(取 services.openAlex.apiKeyEnv)
 * @param {String} envFile 輸入金鑰檔路徑(cfg.envFile 解析後之絕對路徑)
 * @returns {String} 回傳金鑰值，無則 ''
 * @example
 * console.log(JSON.stringify(openAlexApiKeyOf({ services: { openAlex: { apiKeyEnv: '' } } }, 'c:/kb/.env')))
 * // => ""
 *
 * console.log(JSON.stringify(openAlexApiKeyOf({ services: { openAlex: { apiKeyEnv: 'OPENALEX_API_KEY' } } }, 'c:/not-exist/.env')))
 * // => ""
 */
export function openAlexApiKeyOf(cap, envFile) {
    const name = cap?.services?.openAlex?.apiKeyEnv
    if (!isestr(name) || !isestr(envFile)) return ''
    const v = readEnvFile(envFile)[name]
    return isestr(v) ? v.trim() : ''
}

const INSPECT = Symbol.for('nodejs.util.inspect.custom')

/**
 * 建立 OpenAlex 金鑰載體:金鑰值只存於閉包,物件本身經 JSON.stringify／util.inspect／展開／字串化皆不含金鑰值
 *
 * @param {String} apiKey 輸入金鑰值(空或非字串＝不帶金鑰)
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Integer} [opt.retryWaitMs=3000] 輸入帶金鑰之請求重試前之等待毫秒(測試注入;正式執行恆用預設)
 * @returns {Object} 回傳 { enabled:Boolean, sign(url)→附 api_key 之網址, mask(text)→遮罩金鑰之文字, retryWaitMs }(凍結);無金鑰時 sign／mask 原樣回傳
 * @example
 * let a = createOpenAlexAuth('k+1/2=')
 * console.log(a.enabled, a.sign('https://api.openalex.org/works?search=x'))
 * // => true https://api.openalex.org/works?search=x&api_key=k%2B1%2F2%3D
 *
 * console.log(a.mask('curl failed: https://api.openalex.org/works?api_key=k%2B1%2F2%3D'), JSON.stringify(a))
 * // => curl failed: https://api.openalex.org/works?api_key=*** {"enabled":true}
 *
 * console.log(createOpenAlexAuth('').sign('https://api.openalex.org/works'))
 * // => https://api.openalex.org/works
 */
export function createOpenAlexAuth(apiKey, opt = {}) {
    const key = isestr(apiKey) ? apiKey.trim() : ''
    if (!key) {
        return Object.freeze({ enabled: false, sign: (url) => url, mask: (text) => text, toJSON: () => ({ enabled: false }) })
    }
    const secrets = getDiagSecrets({ values: [key] }).detail
    const retryWaitMs = isobj(opt) && Number.isFinite(opt.retryWaitMs) && opt.retryWaitMs >= 0 ? opt.retryWaitMs : RETRY_WAIT_MS
    return Object.freeze({
        enabled: true,
        retryWaitMs,
        sign: (url) => `${url}${String(url).includes('?') ? '&' : '?'}api_key=${encodeURIComponent(key)}`,
        mask: (text) => maskDiagText(text, secrets),
        toJSON: () => ({ enabled: true }),
        [INSPECT]: () => '[OpenAlexAuth enabled]',
    })
}

/** 不帶金鑰之載體(共用實體) */
export const NO_OPENALEX_AUTH = createOpenAlexAuth('')

/**
 * 取用金鑰載體:形狀合格(createOpenAlexAuth 之產物)者原樣回傳,否則回不帶金鑰之載體
 *
 * @param {*} auth 輸入候選載體
 * @returns {Object} 回傳金鑰載體
 * @example
 * console.log(openAlexAuthOf(undefined).enabled, openAlexAuthOf(createOpenAlexAuth('abc')).enabled)
 * // => false true
 */
export function openAlexAuthOf(auth) {
    return isobj(auth) && typeof auth.enabled === 'boolean' && isfun(auth.sign) && isfun(auth.mask) ? auth : NO_OPENALEX_AUTH
}

/**
 * 429 之錯誤(原文回溯之網路層拋出;帶 quota:true 供呼叫端辨識,自訂網路層亦可拋帶 quota:true 之錯誤參與連續計數)
 *
 * @example
 * let e = new OpenAlexQuotaError()
 * console.log(e.message === OPENALEX_QUOTA_MESSAGE, e.quota)
 * // => true true
 */
export class OpenAlexQuotaError extends Error {
    constructor() {
        super(OPENALEX_QUOTA_MESSAGE)
        this.name = 'OpenAlexQuotaError'
        this.quota = true
    }
}

/**
 * 是否為 429(請求結果或錯誤上的 quota 標記)
 *
 * @param {*} x 輸入 openAlexGet 之結果或錯誤
 * @returns {Boolean} 回傳是否為 429
 * @example
 * console.log(isOpenAlexQuota({ status: 'error', quota: true }), isOpenAlexQuota(new OpenAlexQuotaError()), isOpenAlexQuota(new Error('x')))
 * // => true true false
 */
export function isOpenAlexQuota(x) {
    return x?.quota === true
}

/** 帶金鑰時之重試條件(同 w-fetch-web:5xx、429、curl 錯誤;其餘 4xx、內容過短不重試) */
const retryableOf = (r) => {
    const c = httpCodeOf(r)
    return c >= 500 || c === 429 || r?.reason === 'curl-error'
}

/**
 * 失敗結果之整理:message／reason／url／finalUrl 遮罩金鑰;429 之 message 改為固定訊息並標 quota:true(成功結果原樣回傳)
 *
 * @param {*} r 輸入 fetchWebByCurl 風格之結果
 * @param {Object} auth 輸入金鑰載體
 * @returns {*} 回傳整理後之結果
 */
function tidy(r, auth) {
    if (!isobj(r) || r.status === 'success') return r
    const out = { ...r }
    for (const k of ['message', 'reason', 'url', 'finalUrl']) if (typeof out[k] === 'string') out[k] = auth.mask(out[k])
    if (httpCodeOf(r) === 429) {
        out.message = OPENALEX_QUOTA_MESSAGE
        out.quota = true
    }
    return out
}

/**
 * OpenAlex GET 請求(本套件連 OpenAlex 之唯一出口)
 *
 * 無金鑰:以 fetchByCurl(url, { timeoutMs, maxRetries }) 呼叫(與加入金鑰前相同)。有金鑰:網址附 api_key,以 maxRetries:0 呼叫、重試由本函數做
 * (避免 w-fetch-web 之重試輸出把含金鑰之網址寫到 stderr,見檔頭)。回傳 fetchByCurl 風格之結果,失敗者經整理(tidy):訊息遮罩金鑰、429 標 quota:true 並換固定訊息。
 *
 * @param {Function} fetchByCurl 輸入抓取函數 (url, { timeoutMs, maxRetries }) => Promise<{ status, html, message, reason, httpCode }>
 * @param {String} url 輸入不含金鑰之網址
 * @param {Object} [o={}] 輸入設定物件
 * @param {Object} [o.auth] 輸入金鑰載體(createOpenAlexAuth 之產物)，未給不帶金鑰
 * @param {Integer} [o.timeoutMs] 輸入單次逾時毫秒
 * @param {Integer} [o.maxRetries=0] 輸入失敗時最多重試次數(有金鑰時由本函數重試)
 * @param {Integer} [o.retryWaitMs] 輸入有金鑰時重試前之等待毫秒(測試注入)，未給用金鑰載體之 retryWaitMs(預設 3000)
 * @returns {Promise} 回傳 Promise，resolve 回傳整理後之結果({ status:'success', html, … } 或 { status:'error', message, reason, httpCode, quota? })；
 *   抓取函數自身拋錯時(僅自訂注入者)，有金鑰者以遮罩後之訊息重拋
 * @example
 * let seen = []
 * let fetchByCurl = async (u, o) => (seen.push([u, o.maxRetries]), { status: 'error', httpCode: 429, message: `HTTP 429 ${u}` })
 * let auth = createOpenAlexAuth('SECRETKEY')
 * let r = await openAlexGet(fetchByCurl, 'https://api.openalex.org/works?search=x', { auth, timeoutMs: 1000, maxRetries: 1, retryWaitMs: 1 })
 * console.log(seen.length, seen[0][0], seen[0][1], r.quota, r.message === OPENALEX_QUOTA_MESSAGE)
 * // => 2 https://api.openalex.org/works?search=x&api_key=SECRETKEY 0 true true
 */
export async function openAlexGet(fetchByCurl, url, o = {}) {
    const opt = isobj(o) ? o : {}
    const auth = openAlexAuthOf(opt.auth)
    const maxRetries = Number.isInteger(opt.maxRetries) && opt.maxRetries >= 0 ? opt.maxRetries : 0
    let r
    if (!auth.enabled) {
        r = await fetchByCurl(url, { timeoutMs: opt.timeoutMs, maxRetries })
    }
    else {
        const keyed = auth.sign(url)
        const wait = Number.isFinite(opt.retryWaitMs) && opt.retryWaitMs >= 0 ? opt.retryWaitMs : auth.retryWaitMs
        try {
            for (let n = 0; ; n++) {
                r = await fetchByCurl(keyed, { timeoutMs: opt.timeoutMs, maxRetries: 0 })
                if (r?.status === 'success' || n >= maxRetries || !retryableOf(r)) break
                await delay(wait)
            }
        }
        catch (e) {
            throw new Error(auth.mask(String(e?.message ?? e)))
        }
    }
    return tidy(r, auth)
}

export default { OPENALEX_KEY_ENV_DEFAULT, OPENALEX_QUOTA_MESSAGE, OPENALEX_QUOTA_STOP_AFTER, openAlexQuotaStopText, openAlexApiKeyOf, createOpenAlexAuth, NO_OPENALEX_AUTH, openAlexAuthOf, OpenAlexQuotaError, isOpenAlexQuota, openAlexGet }
