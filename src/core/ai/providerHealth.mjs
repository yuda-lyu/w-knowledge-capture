// providerHealth.mjs — 供應商健康層:連續失敗即降序(冷卻)、成功即復原;本檔為此決定之唯一擁有者
//
// 【為何需要】w-dispatch-ai 之內建冷卻只認 HTTP 429 與逾時(另加呼叫端之限流字樣偵測),輸出驗證失敗(整組跳過)與
//   CLI 執行失敗(非零離開碼)皆不冷卻——主力供應商進入失敗風暴時,每一次呼叫仍先在它身上耗掉一次完整回應時間才遞補,
//   高頻呼叫之階段耗時因此成倍增加(實測數倍)。
//
// 【判準:連續 N 次(預設 3)失敗 → 冷卻】單次驗證失敗是常態(各家約 2～30%),立即冷卻會讓主力被正常波動反覆踢下;
//   連續 3 敗在 <30% 失敗率下機率 <3%,而風暴期(>90%)幾乎必達。成功一次即歸零(與上游「任一次成功即解除冷卻」同語意)。
//
// 【冷卻沿用上游機制,不另建鏈序】把條目 id 寫進 store 之 state.cooling,下一次 dispatchAiFallback 讀 store 即以冷卻重排將其
//   降至鏈尾(只降序不移除,前面全敗仍會試到它;逾 cooldownMs 自動解除)。同一調度層實例之全部呼叫共用同一個 store,一處寫入處處生效。
//   競態:上游各呼叫可能以各自讀入之狀態整份寫回而蓋掉本層剛寫之 cooling——本層於該條目每次再失敗時重新斷言(streak 未歸零即再寫),
//   失效窗口至多一次呼叫。
//
// 【哪些失敗計入】
//   ①型別:除 params 外一律計入(排除清單 IGNORE_TYPES)——上游日後新增之錯誤型別預設計入,誤計之代價僅為降序一個冷卻窗(不移除)。
//     params(進入執行前即被擋,如 prompt 超過 CLI 之長度上限)不計 streak:那是席位設定與供應商能力不相容,不會因冷卻而改善,
//     另計 mismatch 供執行摘要揭露。
//   ②事件:以上游之 group-exhausted(一組試完仍無成交;w-dispatch-ai ≥1.0.39)計——上游每次呼叫每組恰發一次,位於該組最後一個
//     next-key／skip-group 之後;成交、組內預算用盡、中止之組不發。故無金鑰輪替(CLI 登入態、無金鑰之 REST)、單把、多把金鑰一律
//     同一規則:每收到一次計一次。一把失敗而他把成交之呼叫不會有此事件(「單把額度用盡」不當整家故障);組內預算用盡者後段金鑰
//     從未被試,亦不會有此事件。next-key／skip-group 只記失敗型別次數,不動 streak。本組各次嘗試之型別(ev.errorTypes)皆在排除清單者
//     不計;混合者以最後一個計入型別為本次之型別。
//   ③為何不自行由逐次事件重建「一次呼叫整組皆敗」:逐次事件不帶呼叫識別,而同一 onEvent 由並行呼叫共用;以失敗事件數或
//     「各把失敗次數之最小值」重建,在並行呼叫跨越一次成交時(游標只在成交時推進,在途呼叫與新呼叫之起點不同)會多計或少計。
//     組邊界只有上游知道,故由上游提供事件,本層按事件計數即精確;上游版本過舊(不發 group-exhausted)時本層永不降序。
//
// 【截斷放行(truncated)另計】經 acceptTruncated 放行之截斷內容屬成功(部分進度)、歸零 streak;由調度層呼叫 noteTruncated 另計次數,
//   性質同 oversize(機制在運作而非失敗),供執行摘要揭露放行頻率。

import isobj from 'wsemi/src/isobj.mjs'

/**
 * 不計入 streak 之 errorType(排除清單;取自 w-dispatch-ai getErrorType 值域,其餘型別一律計入,理由見檔頭)
 *
 * @type {Set}
 */
const IGNORE_TYPES = new Set(['params'])

/**
 * 建立供應商健康層:連續失敗即降序(冷卻)、成功即復原;本模組為此決定之唯一擁有者
 *
 * @param {Object} [opt={}] 輸入設定物件，非物件視為 {}
 * @param {Object} [opt.store] 輸入 w-dispatch-ai 之 store 物件 { get, set }，缺則只統計不冷卻
 * @param {Integer} [opt.threshold=3] 輸入連續失敗幾次即冷卻之正整數，預設3
 * @param {Integer} [opt.windowMs=900000] 輸入冷卻視窗毫秒數正整數(＝ai.cooldownMs)，預設900000；已冷卻且未逾窗者不重寫
 * @param {Function} [opt.onCool] 輸入觸發冷卻時之回呼，格式 (ev)=>void，ev 為 { providerId, streak, errorType, error, keys? }，
 *   keys 僅於觸發之組為多金鑰條目且每把皆試過而敗(attempted＝keys≥2)時附上，為該條目之金鑰數
 * @param {Function} [opt.now=Date.now] 輸入時間函數(測試注入用)，預設Date.now
 * @returns {Object} 回傳 { onEvent, noteOversize, noteTruncated, snapshot, summary, threshold, windowMs }
 * @example
 * let h = createProviderHealth({ threshold: 2 })
 * h.noteTruncated('p')
 * console.log(h.summary())
 * // => 截斷放行 p×1
 */
export function createProviderHealth(opt = {}) {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    const threshold = Number.isInteger(opt.threshold) && opt.threshold > 0 ? opt.threshold : 3
    const windowMs = Number.isInteger(opt.windowMs) && opt.windowMs > 0 ? opt.windowMs : 900_000
    const now = typeof opt.now === 'function' ? opt.now : Date.now
    const store = opt.store && typeof opt.store.get === 'function' && typeof opt.store.set === 'function' ? opt.store : null
    const streak = {} // providerId → { n, lastType, lastError }
    const cooledAt = {} // providerId → 本層最近一次「新」冷卻之時刻(視窗內之重寫是修復,不是新事件)
    let counts = {} // providerId → { ok, fail:{type:n}, cooled, mismatch, oversize, truncated }
    const ensure = (id) => (counts[id] ||= { ok: 0, fail: {}, cooled: 0, mismatch: 0, oversize: 0, truncated: 0 })

    /**
     * 記一次「prompt 逾該條目長度上限而未送出」(由調度層呼叫前之能力預篩呼叫——core/ai/adapter 之 callJson 與 seatSpec 剔除放不下之條目時)。
     * 與 mismatch(params:已 spawn 才被轉接器擋下)分開計:oversize 是呼叫前先擋下、省掉一次 spawn,是機制在運作而非失敗
     *
     * @param {String} id 輸入供應商條目 id
     * @returns {undefined} 無回傳值
     */
    function noteOversize(id) {
        ensure(id).oversize++
    }

    /**
     * 記一次「截斷內容經 acceptTruncated 放行」(由調度層見成功結果帶 truncated 時呼叫);性質同 oversize,非失敗
     *
     * @param {String} id 輸入供應商條目 id
     * @returns {undefined} 無回傳值
     */
    function noteTruncated(id) {
        ensure(id).truncated++
    }

    /**
     * 把供應商寫進上游之冷卻表(已在冷卻中且未逾窗則不動)
     *
     * @param {String} id 輸入供應商條目 id
     * @returns {Boolean} 回傳是否為新寫入(true＝本次新冷卻，false＝無 store 或未逾窗而略過)
     */
    function cool(id) {
        if (!store) return false
        let st
        try {
            st = store.get()
        }
        catch {
            st = null
        }
        if (!st || typeof st !== 'object') st = {}
        if (!st.cooling || typeof st.cooling !== 'object') st.cooling = {}
        const t = st.cooling[id]
        if (Number.isFinite(t) && now() - t < windowMs) return false
        st.cooling[id] = now()
        try {
            store.set(st)
        }
        catch { /* 寫入失敗:下次失敗事件再斷言 */ }
        return true
    }

    /**
     * 事件入口:ok 歸零 streak;next-key／skip-group 只記失敗型別次數;group-exhausted(一組試完仍無成交,上游每次呼叫每組
     * 恰發一次)計一次連續失敗,達門檻即呼叫 cool() 並觸發 onCool(見檔頭②③)
     *
     * @param {Object} ev 輸入事件物件(w-dispatch-ai ≥1.0.39 之 dispatchAiFallback 事件)，需含 providerId
     * @returns {undefined} 無回傳值
     */
    function onEvent(ev) {
        if (!ev || typeof ev !== 'object' || !ev.providerId) return
        const id = String(ev.providerId)
        if (ev.type === 'ok') {
            ensure(id).ok++
            delete streak[id]
            return
        }
        // 逐次失敗:只記型別次數(params 另計 mismatch:席位與能力不相容,供摘要揭露);連續失敗由組盡事件計
        if (ev.type === 'skip-group' || ev.type === 'next-key') {
            const type = String(ev.errorType || 'exec')
            const c = ensure(id)
            c.fail[type] = (c.fail[type] || 0) + 1
            if (type === 'params') c.mismatch++
            return
        }
        if (ev.type !== 'group-exhausted') return
        // 本組各次嘗試之型別皆在排除清單者不計;否則以最後一個計入型別為本次之型別(缺 errorTypes 者視為 exec)
        const types = (Array.isArray(ev.errorTypes) ? ev.errorTypes : []).map((t) => String(t || 'exec'))
        const counted = types.filter((t) => !IGNORE_TYPES.has(t))
        if (types.length && !counted.length) return
        const type = counted.length ? counted[counted.length - 1] : 'exec'
        // keys:多金鑰條目每把皆試過而敗(attempted＝keys≥2)時附上,供訊息註明「每次 N 把金鑰皆敗」;首把即整組跳過者不附
        const keys = Number.isInteger(ev.keys) && ev.keys >= 2 && ev.attempted === ev.keys ? ev.keys : 0
        const c = ensure(id)
        const s = (streak[id] ||= { n: 0, lastType: '', lastError: '' })
        s.n++
        s.lastType = type
        s.lastError = String(ev.error || '').slice(0, 120)
        if (s.n < threshold) return
        const inWindow = Number.isFinite(cooledAt[id]) && now() - cooledAt[id] < windowMs
        const fresh = cool(id)
        if (!fresh) {
            // 上游(429／逾時)或先前已冷卻且未逾窗:對齊時刻,不重複計
            if (!inWindow) cooledAt[id] = now()
            return
        }
        // 視窗內之重寫＝修復被上游蓋掉之紀錄,不是新事件
        if (inWindow) return
        cooledAt[id] = now()
        c.cooled++
        try {
            opt.onCool?.({ providerId: id, streak: s.n, errorType: type, error: s.lastError, ...(keys ? { keys } : {}) })
        }
        catch { /* 回呼失敗不影響主流程 */ }
    }

    /**
     * 本行程累計(供執行摘要);drain 為 true 時取出後歸零累計(streak 不歸零)
     *
     * @param {Boolean} [drain=false] 輸入是否於取出後歸零累計，預設false
     * @returns {Object} 回傳 { threshold, counts, streak } 之深拷貝快照
     */
    function snapshot(drain = false) {
        const out = { threshold, counts: JSON.parse(JSON.stringify(counts)), streak: JSON.parse(JSON.stringify(streak)) }
        if (drain) counts = {}
        return out
    }

    /**
     * 一行摘要:健康降序、席位不相容、prompt 逾長跳過與截斷放行(無則空字串)
     *
     * @param {Object} [snap=snapshot()] 輸入快照物件(snapshot 之產出)，預設取當前快照
     * @returns {String} 回傳彙整後之摘要字串，各項皆無時回傳空字串
     */
    function summary(snap = snapshot()) {
        const cooled = Object.entries(snap.counts).filter(([, c]) => c.cooled > 0).map(([id, c]) => `${id}×${c.cooled}`)
        const mism = Object.entries(snap.counts).filter(([, c]) => c.mismatch > 0).map(([id, c]) => `${id}(params)×${c.mismatch}`)
        const over = Object.entries(snap.counts).filter(([, c]) => (c.oversize || 0) > 0).map(([id, c]) => `${id}×${c.oversize}`)
        const trunc = Object.entries(snap.counts).filter(([, c]) => (c.truncated || 0) > 0).map(([id, c]) => `${id}×${c.truncated}`)
        return [
            cooled.length && `健康降序 ${cooled.join(' ')}`,
            mism.length && `席位不相容 ${mism.join(' ')}`,
            over.length && `prompt 逾長跳過 ${over.join(' ')}`,
            trunc.length && `截斷放行 ${trunc.join(' ')}`,
        ].filter(Boolean).join('；')
    }

    return { onEvent, noteOversize, noteTruncated, snapshot, summary, threshold, windowMs }
}

export default createProviderHealth
