// providerHealth.mjs — 供應商健康層(只觀察):連敗降序之回呼與執行摘要;連敗之計數與冷卻之寫入屬 w-dispatch-ai(遞補層)
//
// 【為何需要健康降序】w-dispatch-ai 之內建冷卻只認 HTTP 429 與逾時(另加呼叫端之限流字樣偵測),輸出驗證失敗(整組跳過)與
//   CLI 執行失敗(非零離開碼)皆不冷卻——主力供應商進入失敗風暴時,每一次呼叫仍先在它身上耗掉一次完整回應時間才遞補,
//   高頻呼叫之階段耗時因此成倍增加(實測數倍)。判準:連續 N 次(ai.healthStreak)整組皆敗 → 冷卻(降至鏈尾、不移除);成交歸零。
//
// 【決定歸遞補層,本層只觀察】(Gitea #130)連敗由 w-dispatch-ai 以 coolAfterFails(＝ai.healthStreak)計於調度層之 store
//   (failStreak;跨行程累計——每輪一個新行程之呼叫端也累計得到門檻),只計「組盡且實際送出之嘗試 > 0、型別不全為 params、非整組沒額度」者;
//   達門檻即以 reason 'streak' 寫冷卻並發 cooled 事件(帶 streak、errorType、error、keys〔有效金鑰數〕、attempted);觸發後不歸零,其後每次再敗皆重申。
//   本層:①不寫 store(冷卻紀錄與連敗之寫者只有遞補層);②onCool 由 cooled(reason 'streak')驅動——欄位與修前同:providerId、streak、errorType、
//   error(截 120 字)、keys(多金鑰條目且每把皆試過〔keys ≥ 2 且 attempted＝keys〕時才附);③視窗內之重申(遞補層每次再敗皆發)不重複回呼、不重複計:
//   本行程最近一次該條目之冷卻事件(任何原因)仍在其視窗內者視為重申——同修前「上游已冷卻(窗內)時不新冷卻、不回呼」;
//   ④snapshot 之 streak 讀遞補層之持久連敗(w-dispatch-ai 之 streakOf;只讀本行程觀察過之條目,持久值 0 者不列),lastType／lastError 取自本行程
//   觀察之組盡事件(最後一個計入之型別、錯誤前 120 字;只取遞補層會計入連敗者:實際送出 > 0、非整組沒額度)。調度層交本層之 store 為唯讀之存取
//   (不經會套用免費池之 store.get),快照不改動狀態。
//
// 【哪些失敗記入次數(本層之統計)】逐次失敗(next-key／skip-group)依型別記次數;params(進入執行前即被擋,如 prompt 超過 CLI 之長度上限)
//   另計 mismatch——那是席位設定與供應商能力不相容,冷卻改善不了,供執行摘要揭露。
//
// 【截斷放行(truncated)另計】經 acceptTruncated 放行之截斷內容屬成功(部分進度);由調度層呼叫 noteTruncated 另計次數,
//   性質同 oversize(機制在運作而非失敗),供執行摘要揭露放行頻率。

import isobj from 'wsemi/src/isobj.mjs'
import { streakOf } from 'w-dispatch-ai/src/cooling.mjs'

/**
 * 組盡事件中不算「計入之型別」者(本層之 lastType 取最後一個計入之型別;遞補層之連敗亦不計全為 params 之組)
 *
 * @type {Set}
 */
const IGNORE_TYPES = new Set(['params'])

/** 錯誤節錄之字數(onCool 與摘要) */
const ERROR_CHARS = 120

/**
 * 建立供應商健康層(只觀察;見檔頭)
 *
 * @param {Object} [opt={}] 輸入設定物件，非物件視為 {}
 * @param {Object} [opt.store] 輸入 w-dispatch-ai 之 store 物件 { get, set }(只讀:經 streakOf 讀持久連敗;不寫)，缺則 snapshot 無連敗
 * @param {Integer} [opt.threshold=3] 輸入連續失敗幾次即冷卻之正整數(＝ai.healthStreak;遞補層之 coolAfterFails,本層只供摘要)，預設3
 * @param {Integer} [opt.windowMs=900000] 輸入冷卻視窗毫秒數正整數(＝ai.cooldownMs;事件未帶有效視窗時用之)，預設900000
 * @param {Function} [opt.onCool] 輸入健康降序觸發時之回呼，格式 (ev)=>void，ev 為 { providerId, streak, errorType, error, keys? }，
 *   keys 僅於觸發之組為多金鑰條目且每把皆試過而敗(attempted＝keys≥2)時附上，為該條目之金鑰數；視窗內之重申不重複回呼
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
    const seen = new Set() // 本行程觀察過之條目(snapshot 只讀這些條目之持久連敗)
    const last = {} // providerId → { lastType, lastError }(本行程最近一次組盡事件)
    const coolAt = {} // providerId → { at, win }(本行程最近一次冷卻事件之時刻與有效視窗;判重申)
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
     * 事件入口(只觀察,不寫 store):ok 記成交;next-key／skip-group 記失敗型別次數(params 另計 mismatch);group-exhausted 記最後一個計入型別與錯誤
     * (供 snapshot);cooled(條目層)記其時刻與有效視窗,reason 'streak' 且非視窗內之重申者計一次健康降序並回呼 onCool(見檔頭)
     *
     * @param {Object} ev 輸入事件物件(w-dispatch-ai 之 dispatchAiFallback 事件)，需含 providerId
     * @returns {undefined} 無回傳值
     */
    function onEvent(ev) {
        if (!ev || typeof ev !== 'object' || !ev.providerId) return
        const id = String(ev.providerId)
        seen.add(id)
        if (ev.type === 'ok') {
            ensure(id).ok++
            delete last[id]
            delete coolAt[id]
            return
        }
        if (ev.type === 'skip-group' || ev.type === 'next-key') {
            const type = String(ev.errorType || 'exec')
            const c = ensure(id)
            c.fail[type] = (c.fail[type] || 0) + 1
            if (type === 'params') c.mismatch++
            return
        }
        if (ev.type === 'group-exhausted') {
            // 與遞補層之連敗同一前提:實際送出之嘗試 > 0(attempted)、非整組沒額度;不計者不改 lastType／lastError(否則附註與持久連敗不相符)
            if (Number.isInteger(ev.attempted) && ev.attempted <= 0) return
            if (ev.quotaExhausted === true) return
            const types = (Array.isArray(ev.errorTypes) ? ev.errorTypes : []).map((t) => String(t || 'exec'))
            const counted = types.filter((t) => !IGNORE_TYPES.has(t))
            if (types.length && !counted.length) return
            last[id] = { lastType: counted.length ? counted[counted.length - 1] : 'exec', lastError: String(ev.error || '').slice(0, ERROR_CHARS) }
            return
        }
        if (ev.type !== 'cooled' || ev.scope === 'key') return
        // 冷卻事件(任何原因):視窗內再發者為重申(遞補層對同一條目每次再觸發皆發,視窗內只更新時刻)
        const t = now()
        const prev = coolAt[id]
        const repeat = !!prev && t - prev.at < prev.win
        coolAt[id] = { at: t, win: Number.isInteger(ev.cooldownMs) && ev.cooldownMs > 0 ? ev.cooldownMs : windowMs }
        if (ev.reason !== 'streak' || repeat) return
        ensure(id).cooled++
        const keys = Number.isInteger(ev.keys) && ev.keys >= 2 && ev.attempted === ev.keys ? ev.keys : 0
        try {
            opt.onCool?.({ providerId: id, streak: ev.streak, errorType: ev.errorType, error: String(ev.error || '').slice(0, ERROR_CHARS), ...(keys ? { keys } : {}) })
        }
        catch { /* 回呼失敗不影響主流程 */ }
    }

    /**
     * 本行程累計(供執行摘要);drain 為 true 時取出後歸零累計(連敗屬遞補層之持久值,不歸零)
     *
     * @param {Boolean} [drain=false] 輸入是否於取出後歸零累計，預設false
     * @returns {Object} 回傳 { threshold, counts, streak } 之深拷貝快照；streak 為 { 條目 id: { n(持久連敗), lastType, lastError } }(本行程觀察過且持久連敗 > 0 者)
     */
    function snapshot(drain = false) {
        const streak = {}
        if (store) {
            for (const id of seen) {
                let n = 0
                try {
                    n = streakOf(store, id)
                }
                catch { /* 讀不出視為無 */ }
                if (n > 0) streak[id] = { n, lastType: last[id]?.lastType || '', lastError: last[id]?.lastError || '' }
            }
        }
        const out = { threshold, counts: JSON.parse(JSON.stringify(counts)), streak }
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
