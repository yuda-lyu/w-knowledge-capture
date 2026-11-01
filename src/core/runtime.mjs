// runtime.mjs — 執行期生效值之單一來源:排程上限、整輪時間預算、執行鎖陳舊期限、本輪宣告之上限、鎖檔／金鑰檔／AI 工作區路徑
//
// 【為何獨立成純函數】這些值若散在各處推導,管線與外部監控會各算各的(如管線以 480 分跑、監控卻以 60 分判界)。
//   收斂為一份結果,同時餵給管線(deadlineMs／鎖／開工標記)、外部監控(判界)與 info()(揭露)。
// 【值有效性】數值鍵一律「有限且大於 0」,數字字串轉數;給了卻無效者視同未給並指名警告
//   (否則字串 '60' 會使門檻成 '6060'、給 0 會被當成有效值)。
// 【鎖之陳舊期限須涵蓋整輪】陳舊期限由持鎖者宣告(core/runnerPackage 之 acquireLock),他實例以它判定是否可接管,故須 ≥ 本輪最長可能耗時:
//   排程上限＋5 分,或時間預算＋安全邊際＋5 分,兩者取大;只給 deadlineMs 時若仍取 60 分,長時執行 60 分後即被接管。
// 【截止公式取執行秩序件】「上限 → 截止」之換算與其安全邊際、下限(deadlineMsOf、DEADLINE_MARGIN_MS)只有一份,在 core/runnerPackage 所取之來源;邊際留給截止後之
//   非 AI 工作與程序樹終止(各段 AI 呼叫之每次嘗試皆以剩餘時間封頂:budgetOf;dispatchAiFallback 以剩餘預算壓每次嘗試之逾時)。
// 【本輪宣告之上限(limitMin)】開工標記(run.start.json)之 limitMin 只有一種語意:排程上限;只明給時間預算者由預算推回(預算＋安全邊際,
//   無條件進位至分);皆無為 null(外部監控用其預設)。外部監控據以分辨「進行中 vs 被砍」與「耗時逼近上限」。

import path from 'path'
import isobj from 'wsemi/src/isobj.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import { deadlineMsOf, DEADLINE_MARGIN_MS } from './runnerPackage.mjs'
// 設定值之顯示字串與設定合併之訊息同一份
import { showSettingValue as show } from './settingsDefault.mjs'

const MIN = 60_000
const DEADLINE_DEFAULT_MS = 3000_000
// 執行鎖陳舊期限須大於排程上限:正常但偏慢的執行不可在跑到一半被下一實例判為殘留而搶鎖
const LOCK_STALE_EXTRA_MS = 300_000
const LOCK_STALE_DEFAULT_MS = 3600_000


/**
 * 數值設定之有效性(執行期數值鍵之單一判準):有限且大於 0 者取值,數字字串轉數
 *
 * @param {*} v 輸入設定值
 * @returns {Number} 回傳數值；無效(非數字、非有限、≤0、空字串、其他型別)時回傳 null
 * @example
 * console.log(positiveNumber('60'), positiveNumber(0), positiveNumber('abc'))
 * // => 60 null null
 */
export function positiveNumber(v) {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN)
    return Number.isFinite(n) && n > 0 ? n : null
}


/**
 * 數值設定之正規化:未給(undefined／null)與給了卻無效者分開回報
 *
 * @param {*} v 輸入設定值
 * @returns {Object} 回傳 { given:Boolean, value:Number(無效或未給時為 null) }
 */
function posNum(v) {
    if (v === undefined || v === null) return { given: false, value: null }
    return { given: true, value: positiveNumber(v) }
}



/**
 * 由整輪時間預算推回該輪之最長可能耗時(分):預算＋安全邊際(已開始之呼叫最多再跑到其自身 timeout)
 *
 * 外部監控判「進行中 vs 被砍」與「耗時逼近上限」時,對只宣告了時間預算之輪次以此為界
 *
 * @param {Number} deadlineMs 輸入整輪時間預算毫秒數
 * @returns {Integer} 回傳分鐘數(無條件進位)；deadlineMs 非有限正數時回傳 null
 * @example
 * console.log(limitMinOfDeadline(3540000))
 * // => 65
 */
export function limitMinOfDeadline(deadlineMs) {
    if (!(Number.isFinite(deadlineMs) && deadlineMs > 0)) return null
    return Math.ceil((deadlineMs + DEADLINE_MARGIN_MS) / MIN)
}


/**
 * resolveRuntime 所讀之 cfg 鍵(唯一一份;總組裝以 runtimeCfgOf 逐鍵交出,不把整份 cfg 交出——執行期生效值只由這些鍵決定)
 *
 * @type {Array}
 */
export const RUNTIME_CFG_KEYS = Object.freeze(['scheduleLimitMin', 'deadlineMs', 'lockStaleMs', 'lock', 'envFile', 'aiWorkspace', 'aiAdapter'])

/**
 * 交 resolveRuntime 之值(各總組裝同一份;只取 RUNTIME_CFG_KEYS)
 *
 * @param {Object} cfg 輸入總組裝之 cfg，非物件時視為{}
 * @returns {Object} 回傳 { scheduleLimitMin, deadlineMs, lockStaleMs, lock, envFile, aiWorkspace, aiAdapter }(未給之鍵為 undefined)
 * @example
 * console.log(Object.keys(runtimeCfgOf({ workDir: 'c:/kb', scheduleLimitMin: 65 })).length, runtimeCfgOf({ scheduleLimitMin: 65 }).scheduleLimitMin)
 * // => 7 65
 */
export function runtimeCfgOf(cfg) {
    const c = isobj(cfg) ? cfg : {}
    return Object.fromEntries(RUNTIME_CFG_KEYS.map((k) => [k, c[k]]))
}


/**
 * 解析執行期生效值(純函數;各總組裝之管線、開工標記與 info() 一律取用其結果;總組裝以 runtimeCfgOf 交 cfg 之值)
 *
 * 排程上限:cfg.scheduleLimitMin。
 * 時間預算:cfg.deadlineMs 明給者優先,否則由排程上限推導(core/runnerPackage 之 deadlineMsOf:上限−6 分,下限 10 分),再無則套件預設 50 分。
 * 鎖陳舊期限:cfg.lockStaleMs 明給者優先(小於時間預算＋安全邊際即警告),否則取「上限＋5 分」與「明給之預算＋6 分＋5 分」之大者,皆無則 60 分。
 * 本輪宣告之上限(limitMin):排程上限;只明給時間預算者由預算推回(limitMinOfDeadline);皆無為 null(檔頭)
 *
 * @param {Object} cfg 輸入總組裝之設定物件，非物件時視為{}
 * @param {Object} ctx 輸入路徑脈絡 { workDir:String, dirs:Object(core/dirs 之 expandDirs 產物) }
 * @returns {Object} 回傳 { envFile:String, aiWorkspace:String(注入 cfg.aiAdapter 時為 null), lockFile:String(cfg.lock 為 false 時為 null),
 *   scheduleLimitMin:Number(未給為 null), limitMin:Number(未給為 null), deadlineMs:Number, lockStaleMs:Integer, warnings:Array(字串) }
 * @throws {Error} ctx 缺 workDir／dirs、cfg.lock 非 false／true／字串，或 cfg.envFile／cfg.aiWorkspace 給了非字串時拋出
 * @example
 * let r = resolveRuntime({ scheduleLimitMin: 65 }, { workDir: 'c:/kb', dirs: { tmp: 'c:/kb/tmp' } })
 * console.log(r.deadlineMs, r.lockStaleMs, r.lockFile)
 * // => 3540000 4200000 c:/kb/tmp/run.lock
 */
export function resolveRuntime(cfg, ctx) {

    //check
    if (!isobj(cfg)) {
        cfg = {}
    }
    if (!isobj(ctx) || !isestr(ctx.workDir) || !isobj(ctx.dirs)) {
        throw new Error('resolveRuntime 需要 { workDir, dirs }')
    }

    const { workDir, dirs } = ctx
    const warnings = []
    const invalid = (key, v, unit) => warnings.push(`${key} 無效（收到 ${show(v)}；須為大於 0 之${unit}），視同未給`)

    // ── 路徑 ──
    let lockFile
    if (cfg.lock === false) lockFile = null
    else if (cfg.lock === undefined || cfg.lock === null || cfg.lock === true || cfg.lock === '') lockFile = `${dirs.tmp}/run.lock`
    else if (isestr(cfg.lock)) lockFile = cfg.lock
    // 其餘型別若原樣傳給取鎖,要到每輪執行才爆——建構期拋錯
    else throw new Error(`cfg.lock 須為 false（不上鎖）、true 或未給（預設 ${dirs.tmp}/run.lock）或鎖檔路徑字串，收到 ${show(cfg.lock)}`)
    if (cfg.envFile && !isestr(cfg.envFile)) throw new Error(`cfg.envFile 須為路徑字串（相對者以 workDir 為基準），收到 ${show(cfg.envFile)}`)
    if (cfg.aiWorkspace && !isestr(cfg.aiWorkspace)) throw new Error(`cfg.aiWorkspace 須為路徑字串，收到 ${show(cfg.aiWorkspace)}`)
    const envFile = cfg.envFile
        ? (path.isAbsolute(cfg.envFile) ? cfg.envFile : `${workDir}/${cfg.envFile}`)
        : `${workDir}/.env`
    // AI 工作區只供內建調度層使用;注入 cfg.aiAdapter 時無此目錄
    const aiWorkspace = cfg.aiAdapter ? null : (cfg.aiWorkspace || `${workDir}/tmp/ai-workspace`)

    // ── 排程上限 ──
    const top = posNum(cfg.scheduleLimitMin)
    if (top.given && top.value === null) invalid('cfg.scheduleLimitMin', cfg.scheduleLimitMin, '分鐘數')
    const scheduleLimitMin = top.value

    // ── 整輪時間預算 ──
    const dl = posNum(cfg.deadlineMs)
    if (dl.given && dl.value === null) invalid('cfg.deadlineMs', cfg.deadlineMs, '毫秒數')
    const deadlineMs = dl.value ?? (scheduleLimitMin !== null ? deadlineMsOf(scheduleLimitMin) : DEADLINE_DEFAULT_MS)
    if (scheduleLimitMin === null && dl.value === null) {
        warnings.push(`未給 scheduleLimitMin 亦未給 deadlineMs，整輪時間預算採套件預設 ${DEADLINE_DEFAULT_MS / MIN} 分（與本安裝端之排程上限無關）`)
    }

    // ── 執行鎖陳舊期限(持鎖者宣告值,須涵蓋本輪最長可能耗時)──
    const ls = posNum(cfg.lockStaleMs)
    if (ls.given && ls.value === null) invalid('cfg.lockStaleMs', cfg.lockStaleMs, '毫秒數')
    const need = Math.max(
        scheduleLimitMin !== null ? Math.ceil(scheduleLimitMin * MIN) + LOCK_STALE_EXTRA_MS : 0,
        dl.value !== null ? Math.ceil(dl.value) + DEADLINE_MARGIN_MS + LOCK_STALE_EXTRA_MS : 0,
    )
    const lockStaleMs = ls.value !== null ? Math.ceil(ls.value) : (need || LOCK_STALE_DEFAULT_MS)
    if (ls.value !== null && lockFile && ls.value < deadlineMs + DEADLINE_MARGIN_MS) {
        warnings.push(`cfg.lockStaleMs（${(ls.value / MIN).toFixed(1)} 分）小於整輪時間預算加安全邊際（${((deadlineMs + DEADLINE_MARGIN_MS) / MIN).toFixed(1)} 分）——偏慢但正常之一輪可能被下一個實例判為陳舊而接管，兩條管線同時寫同一個資料庫`)
    }

    // ── 本輪宣告之上限:排程上限;只明給預算者由預算推回;皆無為 null(檔頭)──
    const limitMin = scheduleLimitMin ?? (dl.value !== null ? limitMinOfDeadline(dl.value) : null)

    return { envFile, aiWorkspace, lockFile, scheduleLimitMin, limitMin, deadlineMs, lockStaleMs, warnings }
}


export default resolveRuntime
