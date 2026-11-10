// reservedCall.mjs — 扣「保留給後段之時間」之 AI 呼叫之唯一包裝:進門判定、鏈內續派判停、預算取小(下游套件之各段同經此一份)
//
// 【為何】選配段(扣保留者)之每次 AI 呼叫有三個決定:要不要送出(進門)、遞補鏈內主席失敗後要不要續派(鏈內)、這次最多用多久(預算)。
//   各下游套件各寫一份時,進門與鏈內誤用同一門檻(主席等滿逾時後遞補一律被中止)、預算之正規化不一(0 被當不限而照跑整條鏈)——
//   故收為一份,由本套件(AI 調度層之擁有者)提供;各站特有之語意(閒置門檻、避開、事前預判、拒答歸因等)由各站自行保留。
// 【進門】本次進門門檻 enterMs ＝ 呼叫時給之 startMs(正數)與 firstMs 取小,未給(或非正數、非數字)即 firstMs;gate.shouldStop(enterMs) 為真
//   → 不送出,回 { ok:false, data:null, error:'ABORTED', providerId:'', attempts:0, skipped:true, errors:[] }(與調度層進門即中止同義,不計此次之失敗)。
//   firstMs 為段之開工門檻(captureCallMsOf;判定小組三席取各席之最大);startMs 為逐次之進門門檻(Gitea #132:判定小組之第三席於前兩票之後才叫,
//   以該席首家之逾時判,不以三席之最大值再擋一次——否則頁開工時剩餘 <「開工門檻＋前兩席耗時」者,前兩票已得而第三席不送出)。
//   firstMs 為 0(未保留:守門只剩整輪逾期)時進門與鏈內皆以 0 判,給了 startMs 亦然。
// 【鏈內】交調度層之 shouldStop ＝ 呼叫端之 shouldStop() === true ‖ gate.shouldStop(stepMs);stepMs ＝ aiChainStepMsOf(enterMs, spec)
//   ＝ min(enterMs, 席位 minAttemptMs ?? 60 秒)——進門門檻只管「要不要送出一次新的呼叫」,鏈內若仍以進門門檻判,主席等滿逾時後之剩餘即小於它,
//   遞補被中止(形同未設遞補)。
// 【預算】budgetMs ＝ min(castBudgetMs(呼叫端之 budgetMs) ?? ∞, gate.remainingMs())(w-dispatch-ai 之 castBudgetMs:執行期剩餘時間之同一份正規化,
//   ≤0 為已無時間、小數取整);各次嘗試之逾時由調度層以之封頂,使遞補不致侵入保留。
// 【不傳 minAttemptMs】席位之 minAttemptMs 照舊由 spec 交調度層(core/ai/adapter 之 minAttemptOf);改交調度層之 minAttemptMs 會蓋過席位值,
//   遞補鏈之預算為各條目逾時之和,續派門檻等於條目逾時時第二家永不開工。呼叫端自給之 minAttemptMs 原樣轉交(包裝不增不刪)。
// 【不得為 async】進門不足回 Promise.resolve(…),否則直接回傳 call(…) 之回傳值——呼叫端有依「同步拋出即不呼叫下一席」之契約者
//   (如判定小組之執行器),包成 async 會把同步拋出變成 rejected promise。
// 【gate】只需 shouldStop(ms) 與 remainingMs():w-data-pipeline 之 reserveOf 與本套件之 stageReserveGateOf 皆合(保留 0 時兩者之語意差異另案)。

import isobj from 'wsemi/src/isobj.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import castBudgetMs from 'w-dispatch-ai/src/castBudgetMs.mjs'

/** 鏈內續派之最低所需(毫秒):席位未給 minAttemptMs 時,扣保留之剩餘不少於此數才續派遞補 */
export const AI_CHAIN_STEP_MS = 60_000

/** 進門即中止之結果(不計此次之失敗;每次回新物件) */
const abortedResult = () => ({ ok: false, data: null, error: 'ABORTED', providerId: '', attempts: 0, skipped: true, errors: [] })

/**
 * 鏈內續派門檻:一次呼叫之遞補鏈內(主席失敗後之嘗試之間)是否續派之判停值——min(進門門檻, 席位 minAttemptMs(正數)否則 60 秒);
 *   進門門檻非正數(未保留)回 0
 *
 * @param {Number} firstMs 輸入本次之進門門檻毫秒數(非正數或非數視為 0)
 * @param {Object} [seat] 輸入本次呼叫之席位(取 minAttemptMs;非正數或未給即 AI_CHAIN_STEP_MS)
 * @returns {Number} 回傳毫秒數
 * @example
 * console.log(aiChainStepMsOf(360000), aiChainStepMsOf(30000), aiChainStepMsOf(0), aiChainStepMsOf(360000, { minAttemptMs: 30000 }))
 * // => 60000 30000 0 30000
 */
export function aiChainStepMsOf(firstMs, seat) {
    const ms = Number(firstMs)
    if (!(ms > 0)) return 0
    const own = Number(seat?.minAttemptMs)
    return Math.min(ms, own > 0 ? own : AI_CHAIN_STEP_MS)
}

/**
 * 逐次進門門檻之取值:有限之數字(含小數),或可解析為有限數之十進位數字字串(castBudgetMs 判為有效者);其餘(布林、物件、null、非數字字串、±Infinity)為 NaN
 *
 * @param {*} v 輸入 callOpt.startMs
 * @returns {Number} 回傳數值(無效為 NaN;是否為正數由呼叫端判)
 */
function startMsOf(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
    if (typeof v === 'string' && castBudgetMs(v) !== null) return Number(v.trim())
    return NaN
}

/**
 * 呼叫端之中止判斷是否成立(非函數或拋錯視同不成立;嚴格 true 才算)
 *
 * @param {*} fn 輸入呼叫端之 shouldStop
 * @returns {Boolean} 回傳是否已要求中止
 */
function callerStops(fn) {
    if (!isfun(fn)) return false
    try {
        return fn() === true
    }
    catch {
        return false
    }
}

/**
 * 扣保留之 AI 呼叫之包裝(檔頭):進門判定、鏈內續派判停、預算取小;不得為 async
 *
 * @param {Function} call 輸入 AI 呼叫函數 (prompt, check, callOpt) => 調度層之回傳(如 AI 調度層之 callJson,或下游之注入呼叫)
 * @param {Object} gate 輸入扣保留之閘 { shouldStop(ms):Boolean, remainingMs():Number }(w-data-pipeline 之 reserveOf 或 stageReserveGateOf 之產物)
 * @param {Object} opt 輸入設定物件
 * @param {Number} opt.firstMs 輸入段之開工門檻毫秒數(非負有限數;captureCallMsOf 之值,0＝未保留)
 * @returns {Function} 回傳 (prompt, check, callOpt?) => call 之回傳值(進門不足時為 Promise,resolve 進門即中止之結果);
 *   callOpt 之 startMs(正數)為本次之進門門檻(與 firstMs 取小;不轉交 call),budgetMs 與剩餘取小、shouldStop 併入鏈內判停,其餘鍵原樣轉交
 * @throws {Error} call 非函數、gate 缺 shouldStop／remainingMs、opt.firstMs 非非負有限數時同步拋出
 * @example
 * let left = 220000
 * let gate = { shouldStop: (ms) => left < ms, remainingMs: () => left }
 * let call = (p, c, o) => Promise.resolve({ ok: true, budgetMs: o.budgetMs, startMs: o.startMs })
 * let ask = reservedAiCallOf(call, gate, { firstMs: 360000 })
 * console.log((await ask('p', () => true, {})).error, await ask('p', () => true, { startMs: 120000 }))
 * // => ABORTED { ok: true, budgetMs: 220000, startMs: undefined }
 */
export function reservedAiCallOf(call, gate, opt) {

    //check
    if (!isfun(call)) {
        throw new Error('invalid call: must be a function')
    }
    if (!isobj(gate) || !isfun(gate.shouldStop) || !isfun(gate.remainingMs)) {
        throw new Error('invalid gate: must be an object with shouldStop(ms) and remainingMs()')
    }
    const firstMs = opt?.firstMs
    if (!(typeof firstMs === 'number' && Number.isFinite(firstMs) && firstMs >= 0)) {
        throw new Error('invalid opt.firstMs: must be a non-negative finite number')
    }

    return (prompt, check, callOpt) => {
        const { startMs, ...rest } = isobj(callOpt) ? callOpt : {}
        // 本次之進門門檻(檔頭【進門】):正數之 startMs(含小數;十進位數字字串亦收)與 firstMs 取小;否則 firstMs(未保留者 firstMs 0 → 仍為 0)
        const own = startMsOf(startMs)
        const enterMs = own > 0 ? Math.min(own, firstMs) : firstMs
        if (gate.shouldStop(enterMs)) return Promise.resolve(abortedResult())
        const stepMs = aiChainStepMsOf(enterMs, rest.spec)
        const cap = castBudgetMs(rest.budgetMs)
        const left = gate.remainingMs()
        const userStop = rest.shouldStop
        return call(prompt, check, {
            ...rest,
            budgetMs: cap === null ? left : Math.min(cap, left),
            shouldStop: () => callerStops(userStop) || gate.shouldStop(stepMs) === true,
        })
    }
}

export default { AI_CHAIN_STEP_MS, aiChainStepMsOf, reservedAiCallOf }
