// poolQuota.mjs — 免費池「當日額度用盡」之偵測:只認 opencode 日誌之額度字樣
//
// 【為何需要】opencode CLI 撞額度上限時不會失敗返回,而是自行退避重試、直到被呼叫端之逾時砍掉;逾時冷卻(ai.cooldownMs)
//   只擋同一行程之後續呼叫,下一個行程(下一輪)又從頭各等一次逾時——額度用盡之時段,每輪都在每個用盡之模型上空耗一次完整逾時。
// 【判準:只認日誌之額度字樣,不以逾時推斷】逾時另有成因(模型於長輸出卡住時,同時段日誌並無任何限流字樣);
//   以逾時推斷會把卡住誤判為整日不可用。
// 【只收「額度用盡」字樣(QUOTA_PATTERNS)】「Please try again later」與「API rate limit for free users」出現後,
//   至每日重置前該模型不再成交;「retry after a brief wait」為瞬間限流(CLI 自行退避即過),不收。
//   「Free usage limit reached … subscribe to OpenCode Go」(實見於全部免費模型同時出現、跨日未因每日重置而消失):
//   免費額度之總量上限,CLI 同樣不失敗返回而等到逾時——收入字樣後本行程即避開;其重置週期非每日,每日週期起點後第一次呼叫仍會空耗一次逾時才再被收入。
// 【效果由呼叫端施作】本模組只回答「哪個模型自本日重置以來被回報額度用盡」;調度層據此把該條目寫進 store 之 cooling
//   (與 dispatchAiFallback 之冷卻同一機制:降到鏈尾、不移除,全鏈皆敗時仍會試到它)。本行程內該模型成交一次(noteOk)
//   即視為恢復——日誌字樣仍在,以成交時刻蓋過。
// 【全機共用】opencode 日誌為本機所有程序共用:任一程序撞到額度上限,其他程序之下一次呼叫即避開。
// 【讀法】只讀檔尾(首次至多 maxBytes,其後只讀新增位元組);以換行切開後才解碼,不切斷多位元組字元;
//   檔案變小或檔首改變(輪替／截斷)即從頭重讀。讀檔失敗(檔案不存在等)視為無資料,不拋錯。

import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * 「當日額度用盡」之日誌字樣(瞬間限流「retry after a brief wait」刻意不收,理由見檔頭)
 *
 * @type {Array<RegExp>}
 */
export const QUOTA_PATTERNS = [/Rate limit exceeded\. Please try again later/i, /API rate limit for free users/i, /Free usage limit reached/i]

/**
 * 檔首比對之位元組數(判斷日誌是否被換成另一個檔)
 *
 * @type {Integer}
 */
const HEAD_BYTES = 256

/**
 * opencode 日誌之預設位置(opencode 於 Windows／Linux／macOS 皆寫在家目錄之 .local/share/opencode/log)
 *
 * @returns {String} 回傳日誌絕對路徑
 * @example
 * console.log(defaultOpencodeLog().endsWith('opencode.log'))
 * // => true
 */
export function defaultOpencodeLog() {
    return path.join(os.homedir(), '.local', 'share', 'opencode', 'log', 'opencode.log')
}

/**
 * 本日額度週期之起點:最近一次(含當下)之 UTC resetUtcHour 時整
 *
 * @param {Number} nowMs 輸入當下時刻毫秒數
 * @param {Integer} [resetUtcHour=0] 輸入每日重置之 UTC 小時(0～23；UTC 0 時即 UTC+8 之 08:00)，非 0～23 之整數視為 0
 * @returns {Number} 回傳週期起點毫秒數
 * @example
 * console.log(new Date(resetStartMs(Date.parse('2026-10-02T22:22:09Z'))).toISOString())
 * // => 2026-10-02T00:00:00.000Z
 */
export function resetStartMs(nowMs, resetUtcHour = 0) {
    const h = Number.isInteger(resetUtcHour) && resetUtcHour >= 0 && resetUtcHour <= 23 ? resetUtcHour : 0
    const d = new Date(nowMs)
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h)
    if (t > nowMs) t -= 86400e3
    return t
}

/**
 * 自日誌文字取出「當日額度用盡」之行:{ ts, key },key＝`providerID/modelID`(＝供應商條目之 model 欄)
 *
 * @param {String} text 輸入日誌文字(多行)
 * @returns {Array<Object>} 回傳 [{ ts:Number, key:String }](時間或模型欄位缺漏之行略過)
 * @example
 * let line = 'timestamp=2026-10-02T22:22:09.412Z level=ERROR providerID=opencode modelID=muse-spark-1.3-contributor-free error.error="AI_APICallError: Rate limit exceeded. Please try again later."'
 * console.log(parseQuotaLines(line))
 * // => [ { ts: 1790979729412, key: 'opencode/muse-spark-1.3-contributor-free' } ]
 */
export function parseQuotaLines(text) {
    const out = []
    for (const line of String(text || '').split('\n')) {
        if (!QUOTA_PATTERNS.some((re) => re.test(line))) continue
        const ts = Date.parse((/(?:^|\s)timestamp=(\S+)/.exec(line) || [])[1] || '')
        const p = (/(?:^|\s)providerID=(\S+)/.exec(line) || [])[1]
        const m = (/(?:^|\s)modelID=(\S+)/.exec(line) || [])[1]
        if (!Number.isFinite(ts) || !p || !m) continue
        out.push({ ts, key: `${p}/${m}` })
    }
    return out
}

/**
 * 建立免費池額度偵測器(讀 opencode 日誌之增量;判定見檔頭)
 *
 * @param {Object} [opt={}] 輸入設定物件，非物件視為 {}
 * @param {String} [opt.file] 輸入 opencode 日誌路徑，未給(或非非空字串)則用 defaultOpencodeLog()
 * @param {Integer} [opt.resetUtcHour=0] 輸入每日額度重置之 UTC 小時(0～23)
 * @param {Integer} [opt.maxBytes=8388608] 輸入首次(或輪替後)讀取檔尾之上限位元組數(須涵蓋一日之日誌量)
 * @param {Integer} [opt.refreshMs=20000] 輸入兩次讀檔之最短間隔毫秒數(呼叫頻繁時節流)
 * @returns {Object} 回傳 { file:String, refresh:Function (nowMs?)=>undefined, isExhausted:Function (model, nowMs?)=>Boolean,
 *   info:Function (model)=>Object|null 回傳 { first, last, n }(本週期之額度字樣統計), noteOk:Function (model, atMs?)=>undefined }
 * @example
 * let q = createPoolQuota({ file: '/no/such/file.log' })
 * console.log(q.isExhausted('opencode/muse-spark-1.3-contributor-free'))
 * // => false
 */
export function createPoolQuota(opt = {}) {

    //check
    if (!opt || typeof opt !== 'object') {
        opt = {}
    }

    const file = typeof opt.file === 'string' && opt.file ? opt.file : defaultOpencodeLog()
    const resetUtcHour = opt.resetUtcHour ?? 0
    const maxBytes = Number.isInteger(opt.maxBytes) && opt.maxBytes > 0 ? opt.maxBytes : 8 * 1024 * 1024
    const refreshMs = Number.isFinite(opt.refreshMs) && opt.refreshMs >= 0 ? opt.refreshMs : 20_000
    let offset = 0 // 已解析至之位元組位置(下一次由此讀起)
    let head = null // 上次所見之檔首(至多 HEAD_BYTES 位元組):換成別的檔(輪替後新檔已長過舊位置)時大小判不出,以此判
    let lastRefresh = -Infinity
    let period = null // 目前統計所屬之週期起點
    const hits = new Map() // key → { first, last, n }(只收本週期)
    const okAt = new Map() // key → 本行程內最近一次成交時刻

    /**
     * 讀入日誌新增部分並更新本週期之統計(節流;讀檔失敗視為無新資料)
     *
     * @param {Number} [nowMs=Date.now()] 輸入當下時刻毫秒數
     * @returns {undefined} 無回傳值
     */
    const refresh = (nowMs = Date.now()) => {
        const start = resetStartMs(nowMs, resetUtcHour)
        if (period !== start) {
            period = start
            hits.clear()
        }
        if (nowMs - lastRefresh < refreshMs) return
        lastRefresh = nowMs
        let fd = null
        try {
            const size = fs.statSync(file).size
            fd = fs.openSync(file, 'r')
            const hb = Buffer.alloc(Math.min(HEAD_BYTES, size))
            fs.readSync(fd, hb, 0, hb.length, 0)
            // 輪替或截斷:檔案變小,或檔首與上次所見之共同前綴不同(新檔已長過舊位置時大小判不出)→ 從頭重讀
            const n = head ? Math.min(head.length, hb.length) : 0
            if (size < offset || (n > 0 && !head.subarray(0, n).equals(hb.subarray(0, n)))) offset = 0
            head = hb
            const from = Math.max(offset, size - maxBytes)
            const len = size - from
            if (len <= 0) return
            const buf = Buffer.alloc(len)
            fs.readSync(fd, buf, 0, len, from)
            // 跳讀(from > offset)者第一行可能不完整;只解析到最後一個換行,其後之半行留待下次
            const lastNl = buf.lastIndexOf(0x0a)
            if (lastNl < 0) return
            const firstNl = from > offset ? buf.indexOf(0x0a) : -1
            const text = buf.subarray(firstNl + 1, lastNl + 1).toString('utf8')
            offset = from + lastNl + 1
            for (const { ts, key } of parseQuotaLines(text)) {
                if (ts < start) continue
                const h = hits.get(key)
                if (!h) hits.set(key, { first: ts, last: ts, n: 1 })
                else {
                    h.first = Math.min(h.first, ts)
                    h.last = Math.max(h.last, ts)
                    h.n++
                }
            }
        }
        catch { /* 日誌不存在或無法讀取:視為無資料 */ }
        finally {
            if (fd !== null) {
                try {
                    fs.closeSync(fd)
                }
                catch { /* 關檔失敗不影響判定 */ }
            }
        }
    }

    /**
     * 是否自本週期起點以來被回報額度用盡,且其後本行程未見該模型成交
     *
     * @param {String} model 輸入條目之 model 欄(如 'opencode/muse-spark-1.3-contributor-free')
     * @param {Number} [nowMs=Date.now()] 輸入當下時刻毫秒數
     * @returns {Boolean} 回傳是否視為額度用盡
     */
    const isExhausted = (model, nowMs = Date.now()) => {
        refresh(nowMs)
        const h = hits.get(model)
        if (!h) return false
        return h.last >= period && h.last > (okAt.get(model) || 0)
    }

    return {
        file,
        refresh,
        isExhausted,
        info: (model) => {
            const h = hits.get(model)
            return h ? { ...h } : null
        },
        noteOk: (model, atMs = Date.now()) => {
            if (model) okAt.set(model, atMs)
        },
    }
}

export default createPoolQuota
