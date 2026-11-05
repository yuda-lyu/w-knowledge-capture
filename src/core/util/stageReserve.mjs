// stageReserve.mjs — 抓取各耗時子階段扣「保留給後段之時間」的共用件:取值器、守門閘、一次作業之估計、一次呼叫(AI)之估計、日誌字樣
//
// 【為何】整輪預算由 w-data-pipeline 之 ctx 持有(remainingMs／expired),只管「逾期」;組裝者(跨工作之時間分配)可保留一段時間給後段工作
//   (opt.reserveMs 或每輪依賴 deps.reserveMs)。子階段若直接問整輪預算,會一路做到逾期而吃掉保留,後段無從開工——
//   故子階段之開工判斷與每次取件、每次呼叫之封頂,一律經本件之守門閘(stageReserveGateOf),不直接取 budgetOf／ctx.remainingMs／ctx.expired
//   (守門:test/unit-capture-reserve-guard.test.mjs)。取值規則同一份(w-data-pipeline 之 reserveMsOf／reserveOf):
//   opt.reserveMs 明給者優先(含 0)、未給(或 null)取每輪 ctx.deps.reserveMs、皆未給為 0;保留多少屬組裝者,本件不讀任何工作之設定。
// 【保留為 0 時行為不變】未給保留(或 0)時,守門閘只看整輪是否逾期、不探詢 ctx.remainingMs、不加任何「一次作業」之門檻、不改封頂、
//   不附日誌與 detail——無組裝者注入時行為與有此機制前完全相同。
// 【一次作業之估計(開工門檻)】保留 > 0 時,開工須「整輪剩餘 − 保留 ≥ 一次作業之估計」:
//   抓取類(輪抓、補全文、擴充)取該段既有之單次逾時之最壞耗時(fetchStepMsOf:抓取器自宣告之逾時〔無則取設定之逾時〕× 嘗試次數 ＋ 重試等待;
//   輪抓取該輪各到期來源之最大者、補全文取本輪各待抓文件所解析之抓取器之最大者、擴充取一條線索之探測最壞耗時、瀏覽器佇列取其階梯最壞耗時),
//   本機逐項作業(文件維護)取下限 STAGE_STEP_FLOOR_MS,AI 呼叫(領域發現)取席位鏈首家之單次逾時(captureCallMsOf);不另設設定鍵。
//   估計不為 0:否則「剩餘 − 保留」恆夠,保留形同虛設。
// 【封頂】抓取類之單次逾時由抓取器與設定給定;開工前已確認「可用 ≥ 該段最壞之單次耗時」,進行中之一次作業不會越過保留。AI 呼叫另以
//   「剩餘 − 保留」封頂其 budgetMs。
// 【時間不足是少做,不是縮容量】開工前不成立 → 不開工;每次取件前同判 → 少做幾件;未取件者原樣留佇列待下輪(不記次、不退避、記錄不動)。
//   容量鍵(perRun 等)不變。報告以 detail.reserveDeferred 記因保留而留下輪之件數(領域發現為 true),只在確因保留延後時才有此欄。
//   「確因保留」＝cut:保留 > 0、整輪未逾期、可用不足;整輪逾期屬一般截止(走各段既有之逾時間預算字樣),不歸因於保留。

import isobj from 'wsemi/src/isobj.mjs'
import { budgetOf, reserveOf, reserveMsOf } from '../runnerPackage.mjs'

/** 一次作業之估計下限(毫秒):各段無自給逾時者(如本機逐項作業)以此計,使保留 > 0 時「剩餘 − 保留」須至少有此餘裕 */
export const STAGE_STEP_FLOOR_MS = 1_000

/** 未設任何逾時時之單次 AI 呼叫逾時(毫秒;同 AI 調度層之預設) */
const CALL_TIMEOUT_FALLBACK_MS = 300_000

/**
 * 子階段之保留時間取值器:opt.reserveMs 明給者優先(含 0;建構即檢核,不合法拋出)、未給(undefined／null)則每輪取 ctx.deps.reserveMs
 *   (組裝者之依賴;不合法於該輪拋出)、皆未給為 0。取值規則取 w-data-pipeline 之 reserveMsOf(各段同一份)
 *
 * @param {Object} opt 輸入子階段之 opt(取 reserveMs：非負毫秒數或 (ctx) => 毫秒數;可缺)
 * @param {String} stageName 輸入子階段函數名(錯誤訊息用，如 'stageListFetch')
 * @returns {Function} 回傳 (ctx) => 非負毫秒數
 * @throws {Error} opt.reserveMs 給了而非非負有限數亦非函數時拋出;回傳之函數於 opt／deps 之值不合時拋出
 * @example
 * const of = stageReserveFnOf({ reserveMs: 900000 }, 'stageListFetch')
 * const dep = stageReserveFnOf({}, 'stageListFetch')
 * console.log(of({ deps: {} }), dep({ deps: { reserveMs: 600000 } }), dep({ deps: {} }), stageReserveFnOf({ reserveMs: 0 }, 'stageListFetch')({ deps: { reserveMs: 1 } }))
 * // => 900000 600000 0 0
 */
export function stageReserveFnOf(opt, stageName) {
    const own = opt?.reserveMs === undefined || opt?.reserveMs === null ? null : reserveMsOf(opt.reserveMs, `${stageName} 之 opt.reserveMs`)
    return (ctx) => (own || reserveMsOf(ctx?.deps?.reserveMs, `${stageName} 之 deps.reserveMs`))(ctx)
}

/**
 * 本段本輪之守門閘:扣掉保留(keepMs)後之剩餘為本段可用;保留 > 0 時須「可用 ≥ 一次作業之估計」才開工,保留為 0 時只看整輪是否逾期
 *   (不探詢 ctx.remainingMs,與直接用整輪預算完全相同)。每次呼叫皆以當下之剩餘求值(不在建構時取一次)。
 *   「因保留而延後」之判讀以 cut 為準(保留 > 0、整輪未逾期、可用不足),閘內不記狀態
 *
 * @param {Object} ctx 輸入管道脈絡(同 budgetOf;可缺 remainingMs／expired〔視為無截止〕)
 * @param {Number} keepMs 輸入保留毫秒數(非負;非有限值或非正數視為 0)
 * @returns {Object} 回傳 { keep:Number 生效之保留毫秒數, expired:()=>Boolean 整輪是否已逾期, roundMs:()=>Number 整輪剩餘(無截止為 Infinity),
 *   remainingMs:()=>Number 扣保留後之可用(無截止為 Infinity), shouldStop:(stepMs)=>Boolean 逾期、或保留 > 0 且可用 < stepMs,
 *   cut:(stepMs)=>Boolean 因保留而停(保留 > 0、整輪未逾期、可用 < stepMs) }
 * @example
 * const g = stageReserveGateOf({ remainingMs: () => 17 * 60000, expired: () => false }, 15 * 60000)
 * console.log(g.keep, g.remainingMs(), g.shouldStop(120000), g.shouldStop(120001), g.cut(120001))
 * // => 900000 120000 false true true
 *
 * const off = stageReserveGateOf({ remainingMs: () => 1000, expired: () => false }, 0)
 * console.log(off.shouldStop(300000), off.cut(300000))
 * // => false false
 */
export function stageReserveGateOf(ctx, keepMs) {
    const keep = Number.isFinite(keepMs) && keepMs > 0 ? keepMs : 0
    const base = budgetOf(ctx)
    const sub = reserveOf(ctx, keep)
    const need = (stepMs) => (Number.isFinite(stepMs) && stepMs > 0 ? stepMs : 0)
    const shouldStop = (stepMs) => {
        if (base.expired()) return true
        if (keep <= 0) return false
        return sub.remainingMs() < need(stepMs)
    }
    const cut = (stepMs) => keep > 0 && !base.expired() && sub.remainingMs() < need(stepMs)
    return { keep, expired: base.expired, roundMs: base.remainingMs, remainingMs: sub.remainingMs, shouldStop, cut }
}

/**
 * 一次作業之估計(開工門檻):各候選之最大正有限數;皆無(0、負、非數)則為下限 STAGE_STEP_FLOOR_MS(不為 0——見檔頭)
 *
 * @param {...Number} candidates 輸入各候選毫秒數(該段既有之單次逾時;非正有限數者略過)
 * @returns {Number} 回傳毫秒數(正有限數)
 * @example
 * console.log(stageStepMsOf(30000, 120000, 0), stageStepMsOf(undefined, 0), stageStepMsOf())
 * // => 120000 1000 1000
 */
export function stageStepMsOf(...candidates) {
    let ms = 0
    for (const c of candidates) if (typeof c === 'number' && Number.isFinite(c) && c > ms) ms = c
    return ms > 0 ? ms : STAGE_STEP_FLOOR_MS
}

/**
 * 一次抓取之最壞耗時(開工門檻之估計):抓取器之單次逾時(自宣告者優先,否則取 fallbackTimeoutMs;皆無即 0＝無逾時、無從估計)× 嘗試次數(retries＋1)
 *   ＋重試之間之等待(retryDelayMs × retries)——同 w-data-pipeline 之 attemptFetch 之行為(逾時亦算一次失敗並可重試)
 *
 * @param {Object} fetcher 輸入抓取器(defineFetcher 之產物;取 timeoutMs、retries、retryDelayMs;非物件視為全缺)
 * @param {Number} [fallbackTimeoutMs] 輸入抓取器未自宣告逾時時之設定逾時(毫秒)
 * @returns {Number} 回傳毫秒數(無逾時可估為 0,交 stageStepMsOf 補下限)
 * @example
 * console.log(fetchStepMsOf({ timeoutMs: 90000, retries: 0 }, 30000), fetchStepMsOf({ retries: 2, retryDelayMs: 1000 }, 30000), fetchStepMsOf({}, 0), fetchStepMsOf(null, 30000))
 * // => 90000 92000 0 30000
 */
export function fetchStepMsOf(fetcher, fallbackTimeoutMs) {
    const f = isobj(fetcher) ? fetcher : {}
    const pos = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
    const timeoutMs = pos(f.timeoutMs) || pos(fallbackTimeoutMs)
    const retries = Number.isInteger(f.retries) && f.retries > 0 ? f.retries : 0
    return timeoutMs > 0 ? timeoutMs * (retries + 1) + pos(f.retryDelayMs) * retries : 0
}

/**
 * 一次 AI 呼叫之時間估計(開工門檻):該席位鏈首家之單次逾時——席位 timeoutMs → ai.providerTimeouts[席位 use] → ai.extraProviders 中該條目自帶之
 *   timeoutMs → ai.timeoutMs → 300000(調度層「席位逾時覆寫鏈內各條目、逐 id 逾時次之、條目自帶次之、再次為 ai.timeoutMs」之同一順序;不另設設定鍵)。
 *   調度層內建條目表自帶之逾時(未列於上述設定者)此處看不到,以 ai.timeoutMs 計——要精準請於 ai.providerTimeouts 明列
 *
 * @param {Object} settings 輸入已解析之設定(取 ai；可缺)
 * @param {Object} [seat] 輸入席位 { use, fallback?, timeoutMs? }(非物件者略過，以 ai.timeoutMs → 300000 計)
 * @returns {Number} 回傳毫秒數(正有限數)
 * @example
 * const ai = { timeoutMs: 120000, providerTimeouts: { 'x:a': 45000 }, extraProviders: [{ id: 'x:c', timeoutMs: 80000 }] }
 * console.log(captureCallMsOf({ ai }, { use: 'x:a' }), captureCallMsOf({ ai }, { use: 'x:a', timeoutMs: 9000 }), captureCallMsOf({ ai }, { use: 'x:c' }), captureCallMsOf({ ai }, { use: 'x:b' }), captureCallMsOf({}, null))
 * // => 45000 9000 80000 120000 300000
 */
export function captureCallMsOf(settings, seat) {
    const ai = isobj(settings?.ai) ? settings.ai : {}
    const pos = (v) => {
        const n = Number(v)
        return Number.isFinite(n) && n > 0 ? n : 0
    }
    const s = isobj(seat) ? seat : {}
    const own = typeof s.use === 'string' && Array.isArray(ai.extraProviders) ? ai.extraProviders.find((e) => isobj(e) && e.id === s.use) : null
    return pos(s.timeoutMs) || pos(ai.providerTimeouts?.[s.use]) || pos(own?.timeoutMs) || pos(ai.timeoutMs) || CALL_TIMEOUT_FALLBACK_MS
}

/**
 * 因保留而延後之日誌字樣(各段共用):保留、扣保留後之剩餘與一次作業之估計
 *
 * @param {Object} gate 輸入 stageReserveGateOf 之回傳
 * @param {Number} stepMs 輸入一次作業之估計(毫秒)
 * @returns {String} 回傳字串(如「保留 15 分，扣保留後剩餘 1 分，不足一次作業之估計 120 秒」)
 * @example
 * const g = stageReserveGateOf({ remainingMs: () => 16 * 60000, expired: () => false }, 15 * 60000)
 * console.log(reserveNoteOf(g, 120000))
 * // => 保留 15 分，扣保留後剩餘 1 分，不足一次作業之估計 120 秒
 */
export function reserveNoteOf(gate, stepMs) {
    const min = (ms) => Math.round(ms / 6000) / 10
    return `保留 ${min(gate.keep)} 分，扣保留後剩餘 ${min(gate.remainingMs())} 分，不足一次作業之估計 ${Math.round(stepMs / 1000)} 秒`
}

export default { STAGE_STEP_FLOOR_MS, stageReserveFnOf, stageReserveGateOf, stageStepMsOf, fetchStepMsOf, captureCallMsOf, reserveNoteOf }
