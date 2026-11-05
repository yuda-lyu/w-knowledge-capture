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
// 【多把金鑰】apiKeyEnv 所指變數之值可為逗號分隔之多把(各自有自己的每日額度):openAlexApiKeyOf 回陣列(拆逗號、trim、去空、去重;無金鑰 []),
//   createOpenAlexAuth 收陣列,閉包持多把與「當前把」(行程內記憶,不落地);換把一律在 openAlexGet(本檔唯一請求出口):
//   ①429:切下一把立即再送、不等待;所有可用之把都 429 才算這一次 429(標 quota:true,走連續計數),其後才走既有之等待與 maxRetries——
//      每一次「嘗試」是一輪(每把至多一次),故呼叫次數上限為 (maxRetries+1)×把數;
//   ②401／403:該把於本行程標記無效、不再使用並切下一把(WARN 一次,寫明變數名、狀態碼、第幾把,不印值);全部無效 → 回 401／403 結果
//      (message 指明金鑰無效、標 invalidKey:true、不標 quota、不計入 429 連續計數,此後不再送請求),不默默退回不帶金鑰;
//   ③5xx、curl 錯誤:同把重試,不換把;其餘 4xx:不重試、不換把;
//   ④併發:多個請求同時收到 429 時,只有「當前把仍是自己用的那把」才切(避免連跳多把)。
//   不分逗號的舊形狀(字串)不再接受:createOpenAlexAuth 對非陣列拋 TypeError(不回顯值),避免舊呼叫端靜默失去金鑰。

import isarr from 'wsemi/src/isarr.mjs'
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
 * 金鑰清單之整理:非字串略過,各項 trim,去空,去重(保序,首見者在前)
 *
 * @param {Array} list 輸入候選金鑰陣列
 * @returns {Array} 回傳整理後之金鑰陣列
 */
function keysOf(list) {
    const out = []
    for (const x of isarr(list) ? list : []) {
        const k = isestr(x) ? x.trim() : ''
        if (k && !out.includes(k)) out.push(k)
    }
    return out
}

/**
 * 讀取 OpenAlex API 金鑰:變數名取自 capture.services.openAlex.apiKeyEnv,值取自金鑰檔(不污染 process.env;不讀 process.env——與 AI 金鑰同一來源)
 *
 * 值可為逗號分隔之多把(各自有自己的每日額度):拆逗號、trim、去空、去重(保序)。變數名為空、金鑰檔未給／不存在／不可讀、檔內無此變數或值為空 → 回 []
 * (不帶金鑰,請求同無金鑰時)。值先經 readEnvFile 修剪空白、剝除成對首尾引號。
 *
 * @param {Object} cap 輸入 settings.capture(取 services.openAlex.apiKeyEnv)
 * @param {String} envFile 輸入金鑰檔路徑(cfg.envFile 解析後之絕對路徑)
 * @returns {Array} 回傳金鑰陣列，無則 []
 * @example
 * console.log(JSON.stringify(openAlexApiKeyOf({ services: { openAlex: { apiKeyEnv: '' } } }, 'c:/kb/.env')))
 * // => []
 *
 * console.log(JSON.stringify(openAlexApiKeyOf({ services: { openAlex: { apiKeyEnv: 'OPENALEX_API_KEY' } } }, 'c:/not-exist/.env')))
 * // => []
 *
 * // 檔內 OPENALEX_API_KEY=ka, kb ,ka → ["ka","kb"]
 */
export function openAlexApiKeyOf(cap, envFile) {
    const name = cap?.services?.openAlex?.apiKeyEnv
    if (!isestr(name) || !isestr(envFile)) return []
    const v = readEnvFile(envFile)[name]
    // 逐項再剝首尾引號:readEnvFile 只剝整個值最外層的一對,KEY="a","b" 會留下 a" 與 "b
    return isestr(v) ? keysOf(v.split(',').map((s) => s.trim().replace(/^["']+|["']+$/g, ''))) : []
}

const INSPECT = Symbol.for('nodejs.util.inspect.custom')

/**
 * 建立 OpenAlex 金鑰載體:金鑰值只存於閉包,物件本身經 JSON.stringify／util.inspect／展開／字串化皆不含任一把金鑰值
 *
 * 載體持多把金鑰與「當前把」(行程內記憶);換把與無效標記由 openAlexGet 驅動(cursor／advance／reject),見檔頭【多把金鑰】。
 *
 * @param {Array} keys 輸入金鑰陣列(openAlexApiKeyOf 之回傳;各項 trim、去空、去重;空陣列或 null／undefined＝不帶金鑰)；字串等其他形狀拋 TypeError(不回顯值)
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Integer} [opt.retryWaitMs=3000] 輸入帶金鑰之請求重試前之等待毫秒(測試注入;正式執行恆用預設)
 * @param {String} [opt.envName=''] 輸入金鑰變數名(capture.services.openAlex.apiKeyEnv;非機密，只用於無效金鑰之 WARN 與失敗訊息)
 * @returns {Object} 回傳(凍結)；有金鑰者為 { enabled:true, retryWaitMs, sign(url)→以當前把附 api_key 之網址, mask(text)→遮罩全部把之文字,
 *   cursor()→當前把序〔0 起；全部無效 -1；非機密〕, advance(slot)→僅當前把仍是 slot 時切下一把可用者並回傳當前把序, reject(slot, code, log)→標記該把無效〔WARN 一次〕,
 *   invalid()→全部無效時為 { httpCode, message }，否則 null }；無金鑰者為 { enabled:false, sign／mask 原樣回傳 }
 * @throws {TypeError} keys 為非陣列且非 null／undefined 時拋出
 * @example
 * let a = createOpenAlexAuth(['k+1/2=', 'k2'])
 * console.log(a.enabled, a.sign('https://api.openalex.org/works?search=x'))
 * // => true https://api.openalex.org/works?search=x&api_key=k%2B1%2F2%3D
 *
 * console.log(a.mask('curl failed: https://api.openalex.org/works?api_key=k%2B1%2F2%3D'), JSON.stringify(a))
 * // => curl failed: https://api.openalex.org/works?api_key=*** {"enabled":true}
 *
 * console.log(createOpenAlexAuth([]).sign('https://api.openalex.org/works'))
 * // => https://api.openalex.org/works
 */
export function createOpenAlexAuth(keys, opt = {}) {
    if (keys !== undefined && keys !== null && !isarr(keys)) {
        throw new TypeError('createOpenAlexAuth 須傳金鑰陣列（openAlexApiKeyOf 之回傳）；不再接受字串等其他形狀')
    }
    const list = keysOf(keys)
    if (!list.length) {
        return Object.freeze({ enabled: false, sign: (url) => url, mask: (text) => text, toJSON: () => ({ enabled: false }) })
    }
    const n = list.length
    const secrets = getDiagSecrets({ values: list }).detail
    const retryWaitMs = isobj(opt) && Number.isFinite(opt.retryWaitMs) && opt.retryWaitMs >= 0 ? opt.retryWaitMs : RETRY_WAIT_MS
    const envName = isobj(opt) && isestr(opt.envName) ? opt.envName : ''
    const where = envName ? `${envName} 之` : ''
    // 狀態:bad[i] 為使第 i 把無效之 HTTP 狀態碼(0＝可用);warned[i] 為該把是否已 WARN;cur 為當前把序(全部無效 -1)
    const bad = new Array(n).fill(0)
    const warned = new Array(n).fill(false)
    let cur = 0
    let lastBad = 0
    /** 自 from 的下一把起(環狀)找第一把可用者;只剩 from 自己可用時回 from;全部無效 -1 */
    const nextValid = (from) => {
        for (let k = 1; k <= n; k++) {
            const j = (from + k) % n
            if (!bad[j]) return j
        }
        return -1
    }
    const left = () => bad.filter((c) => !c).length
    return Object.freeze({
        enabled: true,
        retryWaitMs,
        cursor: () => cur,
        sign: (url) => {
            if (cur < 0) throw new Error('OpenAlex 金鑰皆已標記無效，不簽署')
            return `${url}${String(url).includes('?') ? '&' : '?'}api_key=${encodeURIComponent(list[cur])}`
        },
        advance: (slot) => {
            if (cur === slot) cur = nextValid(slot)
            return cur
        },
        reject: (slot, code, log) => {
            if (!Number.isInteger(slot) || slot < 0 || slot >= n) return
            if (!bad[slot]) {
                bad[slot] = code
                lastBad = code
            }
            if (cur === slot) cur = nextValid(slot)
            if (!warned[slot] && typeof log?.warn === 'function') {
                warned[slot] = true
                const rest = left()
                try {
                    log.warn(`OpenAlex 金鑰無效（狀態碼 ${code}）：${where}第 ${slot + 1}／${n} 把不被接受，本行程不再使用該把；${rest > 0 ? `尚餘 ${rest} 把可用` : '已無可用金鑰，OpenAlex 請求不再送出（不退回不帶金鑰）'}`)
                }
                catch { /* 日誌失敗不影響請求 */ }
            }
        },
        invalid: () => (cur >= 0 ? null : { httpCode: lastBad, message: `狀態碼 ${lastBad}：OpenAlex 金鑰無效（${where}全部 ${n} 把皆不被接受，請檢查金鑰檔中之設定值）` }),
        mask: (text) => maskDiagText(text, secrets),
        toJSON: () => ({ enabled: true }),
        [INSPECT]: () => '[OpenAlexAuth enabled]',
    })
}

/** 不帶金鑰之載體(共用實體) */
export const NO_OPENALEX_AUTH = createOpenAlexAuth([])

/**
 * 取用金鑰載體:形狀合格(createOpenAlexAuth 之產物，含換把方法)者原樣回傳,否則回不帶金鑰之載體
 *
 * @param {*} auth 輸入候選載體
 * @returns {Object} 回傳金鑰載體
 * @throws {TypeError} 自稱有金鑰(enabled:true、有 sign／mask)卻缺換把方法之舊形狀物件時拋出(不靜默降級為不帶金鑰)
 * @example
 * console.log(openAlexAuthOf(undefined).enabled, openAlexAuthOf(createOpenAlexAuth(['abc'])).enabled)
 * // => false true
 */
export function openAlexAuthOf(auth) {
    if (!isobj(auth) || typeof auth.enabled !== 'boolean' || !isfun(auth.sign) || !isfun(auth.mask)) return NO_OPENALEX_AUTH
    // 有金鑰者須為 createOpenAlexAuth 之新形狀(換把與無效標記之方法);只有 enabled／sign／mask 之舊形狀拋錯,不靜默降級為不帶金鑰(同 createOpenAlexAuth 對字串之處置)
    if (auth.enabled && !(isfun(auth.cursor) && isfun(auth.advance) && isfun(auth.reject) && isfun(auth.invalid))) {
        throw new TypeError('OpenAlex 金鑰載體形狀不符：須為 createOpenAlexAuth 之產物（不再接受只有 enabled／sign／mask 之舊形狀）')
    }
    return auth
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
 * 結果之整理:message／reason／url／finalUrl 遮罩金鑰(帶金鑰之成功結果其 url／finalUrl 亦含 api_key,一併遮罩;無金鑰之成功結果原樣回傳);失敗且為 429 者 message 改為固定訊息並標 quota:true
 *
 * @param {*} r 輸入 fetchWebByCurl 風格之結果
 * @param {Object} auth 輸入金鑰載體
 * @returns {*} 回傳整理後之結果
 */
function tidy(r, auth) {
    if (!isobj(r) || (r.status === 'success' && !auth.enabled)) return r
    const out = { ...r }
    for (const k of ['message', 'reason', 'url', 'finalUrl']) if (typeof out[k] === 'string') out[k] = auth.mask(out[k])
    if (r.status !== 'success' && httpCodeOf(r) === 429) {
        out.message = OPENALEX_QUOTA_MESSAGE
        out.quota = true
    }
    return out
}

/**
 * 帶金鑰之一輪請求:以當前把送;429 → 切下一把立即再送(本輪每把至多一次;所有可用之把皆 429 才回 429);401／403 → 該把標記無效並切下一把;
 * 全部無效 → 回無效金鑰結果(不送請求);其餘結果(成功、5xx、curl 錯誤、其他 4xx)原樣回傳,由呼叫端決定是否同把重試
 *
 * @param {Function} fetchByCurl 輸入抓取函數
 * @param {String} url 輸入不含金鑰之網址
 * @param {Object} auth 輸入有金鑰之載體
 * @param {Object} opt 輸入 { timeoutMs, log }
 * @returns {Promise} 回傳 Promise，resolve 回傳 fetchWebByCurl 風格之結果(未整理)
 */
async function keyedRound(fetchByCurl, url, auth, opt) {
    const tried = new Set() // 本輪已因 429 用過之把序
    const refused = new Set() // 本輪已因 401／403 被拒之把序(真載體標記後不會再被選中;此集合使形狀合格但 reject 不生效之替身亦必終止)
    let last429 = null
    for (;;) {
        const inv = auth.invalid()
        if (inv) return { status: 'error', url, reason: 'http-error', httpCode: inv.httpCode, message: inv.message, invalidKey: true }
        const slot = auth.cursor()
        if (tried.has(slot)) return last429 // 可用之把皆已 429
        const r = await fetchByCurl(auth.sign(url), { timeoutMs: opt.timeoutMs, maxRetries: 0 })
        if (r?.status === 'success') return r
        const code = httpCodeOf(r)
        if (code === 429) {
            tried.add(slot)
            last429 = r
            auth.advance(slot) // 只有當前把仍是 slot 才切(併發之請求已切過者不再切)
            continue
        }
        if (code === 401 || code === 403) {
            if (refused.has(slot)) return r
            refused.add(slot)
            auth.reject(slot, code, opt.log)
            continue
        }
        return r
    }
}

/**
 * OpenAlex GET 請求(本套件連 OpenAlex 之唯一出口)
 *
 * 無金鑰：以 fetchByCurl(url, { timeoutMs, maxRetries }) 呼叫(與加入金鑰前相同)。有金鑰：網址附 api_key，一律以 maxRetries:0 呼叫、重試與換把由本函數做
 * (避免 w-fetch-web 之重試輸出把含金鑰之網址寫到 stderr，見檔頭)。每一次「嘗試」為一輪：429 換下一把立即再送(不等待)，所有可用之把都 429 才算這一次 429；
 * 401／403 標記該把無效並換把；5xx／curl 錯誤同把重試(輪與輪之間等待)；其他 4xx 不重試。呼叫次數上限 (maxRetries+1)×把數。
 * 回傳 fetchByCurl 風格之結果，失敗者經整理(tidy)：訊息遮罩全部把、429 標 quota:true 並換固定訊息；全部金鑰無效者標 invalidKey:true。
 *
 * @param {Function} fetchByCurl 輸入抓取函數 (url, { timeoutMs, maxRetries }) => Promise<{ status, html, message, reason, httpCode }>
 * @param {String} url 輸入不含金鑰之網址
 * @param {Object} [o={}] 輸入設定物件
 * @param {Object} [o.auth] 輸入金鑰載體(createOpenAlexAuth 之產物)，未給不帶金鑰
 * @param {Integer} [o.timeoutMs] 輸入單次逾時毫秒
 * @param {Integer} [o.maxRetries=0] 輸入失敗時最多重試次數(有金鑰時由本函數重試)
 * @param {Integer} [o.retryWaitMs] 輸入有金鑰時重試前之等待毫秒(測試注入)，未給用金鑰載體之 retryWaitMs(預設 3000)
 * @param {Object} [o.log] 輸入日誌物件(取 warn)；金鑰被判無效時於此記 WARN 一次(各站點傳自己既有之日誌；未給則不記)
 * @returns {Promise} 回傳 Promise，resolve 回傳整理後之結果({ status:'success', html, … } 或 { status:'error', message, reason, httpCode, quota?, invalidKey? })；
 *   抓取函數自身拋錯時(僅自訂注入者)，有金鑰者以遮罩後之訊息重拋
 * @example
 * let seen = []
 * let fetchByCurl = async (u, o) => (seen.push([u, o.maxRetries]), { status: 'error', httpCode: 429, message: `HTTP 429 ${u}` })
 * let auth = createOpenAlexAuth(['SECRETKEY'])
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
        const wait = Number.isFinite(opt.retryWaitMs) && opt.retryWaitMs >= 0 ? opt.retryWaitMs : auth.retryWaitMs
        try {
            for (let n = 0; ; n++) {
                r = await keyedRound(fetchByCurl, url, auth, opt)
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
