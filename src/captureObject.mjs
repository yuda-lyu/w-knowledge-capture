// captureObject.mjs — 抓取物件:子階段序列(hygiene → seedSync → listFetch → detailFetch → docMaintain → expand → areas)
//
// ════════════════ 分形組裝:物件=子階段序列,子階段=動作鏈 ════════════════
//
// 工廠零參數即可用(內建預設子階段與動作鏈);opt 逐層覆寫:
//   opt.stages           整組重排子階段(混入自寫 {name, run(ctx)} 單元)
//   opt.<子階段名>       透傳該子階段工廠(其內 tap/chain/單元 opts;另 enabled:false 即不跑該子階段、when(ctx) 逐輪判——零件庫用法:只跑要的子階段)
//   opt.name/onError…    階段契約欄位
//
// 【依賴一律走 ctx.deps】stores/seen/registry/clock/dirs/settings/data/vocab/ai/domains/netGuard 由總組裝每輪開啟交入;
//   套件子階段與自寫子階段同一條注入通道。
// 【子階段失敗預設隔離】單一子階段倒了記於 detail、續跑後續子階段;子階段宣告 onError:'abort' 才中止整個物件
//   (如輪抓失敗時,補全文與維護仍應消化既有待處理文件)。
// 【物件 report 形狀】{ ok, stats, detail: <子階段名 → 子階段 report>, summary }——detail 即各子階段 report 之對照表,
//   執行摘要(core/ops/runSummary)據此落地。

import isobj from 'wsemi/src/isobj.mjs'
import { stdReport, mergeTaps, stageFields } from './core/kernel.mjs'
import { stageHygiene } from './stages/hygieneStage.mjs'
import { stageSeedSync } from './stages/seedSyncStage.mjs'
import { stageListFetch } from './stages/listFetchStage.mjs'
import { stageDetailFetch } from './stages/detailFetchStage.mjs'
import { stageDocMaintain } from './stages/docMaintainStage.mjs'
import { stageExpand } from './stages/expandStage.mjs'
import { stageAreas } from './stages/areaStage.mjs'
import { CAPTURE_REPORT_KEYS } from './logContract.mjs'

/**
 * 內建子階段之鍵(依執行順序;亦為 opt.<子階段名> 與總組裝 cfg.stageOpts 之可用鍵)——即日誌契約 CAPTURE_REPORT_KEYS 之 subStages(同一實體)
 *
 * @type {Array}
 */
export const CAPTURE_STAGE_KEYS = CAPTURE_REPORT_KEYS.subStages

/**
 * 有動作鏈(hook 錨點)之內建子階段:opt.<子階段>.tap 與跨階段插件只能掛在這些子階段(錨點名列於各 stages/*.mjs 檔頭)。
 * hygiene(孤兒回收)與 areas(領域清單)為機制性子階段、無動作鏈,其工廠拒收 tap／chain(core/kernel 之 rejectChainOpts)
 *
 * @type {Array}
 */
export const CAPTURE_TAP_STAGE_KEYS = Object.freeze(['seedSync', 'listFetch', 'detailFetch', 'docMaintain', 'expand'])

// 階段契約欄位之透傳(name／onError 給預設;when／enabled／timeoutMs／always 原樣透傳)定義於 core/kernel(子階段工廠同用),此處原名轉出
export { stageFields }

/**
 * 物件之平鋪 opts 與某子階段之 opts 合併(下游套件之物件共用;本套件之物件無平鋪 opts):子階段優先,但 tap 以 mergeTaps 合併——
 *   呼叫端可能同時給平鋪之 tap 與子階段之 tap(兩方各自組 opt 時),二擇一會使其一靜默失效
 *
 * @param {Object} flat 輸入平鋪 opts(物件層)
 * @param {Object} [sub] 輸入子階段 opts(opt.<子階段名>)
 * @param {String} label 輸入 mergeTaps 之錯誤標籤，如 'relate.relate'
 * @returns {Object} 回傳合併後之子階段工廠 opt
 * @throws {Error} 同錨點雙方皆給 replace 時拋出(mergeTaps)
 * @example
 * console.log(subOpt({ a: 1, b: 2 }, { b: 3 }, 'x.y'))
 * // => { a: 1, b: 3 }
 */
export function subOpt(flat, sub, label) {
    const out = { ...flat, ...(sub || {}) }
    const tap = mergeTaps(flat.tap, sub?.tap, label)
    if (tap) out.tap = tap
    return out
}

/**
 * 子階段序列執行:逐段隔離(失敗記報告續跑;onError:'abort' 才外拋)
 *
 * @param {Array} stages 輸入子階段陣列，各項為 { name, run(ctx), when?, enabled?, onError? }(enabled 為 false 者不跑、記 INFO、report 為
 *   { detail:{ disabled:true } }——與各子階段自身停用時之 report 同形;when 不合者略過且不入 report)
 * @param {Object} ctx 輸入管道脈絡(原樣傳遞給各子階段之 run)
 * @returns {Promise} 回傳 Promise，resolve 回傳 { <子階段名>: report }
 * @throws {Error} 子階段宣告 onError:'abort' 且其 run 拋錯時，原錯誤外拋
 * @example
 * let stages = [
 *     { name: 'a', run: async () => ({ ok: true, stats: { in: 2, out: 2 } }) },
 *     { name: 'b', enabled: false, run: async () => ({ ok: true }) },
 *     { name: 'c', run: async () => { throw new Error('boom') } },
 * ]
 * let ctx = { log: { info() {}, warn() {} } }
 * let reports = await runSubStages(stages, ctx)
 * console.log(Object.keys(reports), reports.b.detail, reports.c.ok, reports.c.summary)
 * // => [ 'a', 'b', 'c' ] { disabled: true } false 失敗：boom
 *
 * try { await runSubStages([{ name: 'x', onError: 'abort', run: async () => { throw new Error('boom') } }], ctx) } catch (e) { console.log(e.message) }
 * // => boom
 */
export async function runSubStages(stages, ctx) {
    const reports = {}
    for (const st of stages) {
        if (st.enabled === false) {
            ctx.log?.info?.(`子階段[${st.name}] 已停用（enabled:false），略過`)
            reports[st.name] = stdReport({ detail: { disabled: true } })
            continue
        }
        if (st.when && !st.when(ctx)) continue
        try {
            reports[st.name] = await st.run(ctx)
            // 回 ok:false 而未拋錯者(維護型子階段之鏈異常只進 report)亦須在日誌可見:管道對任何結果一律記 INFO「完成」,
            //   只掃 WARN／ERROR 之巡檢不記即連續失敗零告警
            if (reports[st.name]?.ok === false) ctx.log.warn(`子階段[${st.name}] 回報失敗：${String(reports[st.name].summary || JSON.stringify(reports[st.name].stats || {})).slice(0, 200)}`)
        }
        catch (e) {
            reports[st.name] = stdReport({ ok: false, stats: { fail: 1 }, summary: `失敗：${String(e?.message || e).slice(0, 160)}` })
            if (st.onError === 'abort') throw e
            ctx.log.warn(`子階段[${st.name}] 失敗（續跑後續子階段）：${String(e?.message || e).slice(0, 200)}`)
        }
    }
    return reports
}

/**
 * 彙總各子階段之統一核心統計
 *
 * @param {Object} reports 輸入子階段名 → report 之對照物件
 * @returns {Object} 回傳加總後統計物件 { in, out, skip, fail, aiCalls }
 * @example
 * console.log(aggStats({ a: { stats: { in: 3, out: 2, fail: 1 } }, b: { stats: { in: 1, out: 1, aiCalls: 2 } } }))
 * // => { in: 4, out: 3, skip: 0, fail: 1, aiCalls: 2 }
 */
export function aggStats(reports) {
    const agg = { in: 0, out: 0, skip: 0, fail: 0, aiCalls: 0 }
    for (const r of Object.values(reports)) {
        for (const k of Object.keys(agg)) agg[k] += r?.stats?.[k] || 0
    }
    return agg
}

/**
 * 通用摘要(自組 stages 時用;預設 stages 有固定格式摘要)
 *
 * @param {Object} reports 輸入子階段名 → report 之對照物件
 * @returns {String} 回傳摘要字串，如「2/3 段完成（in 3、out 3、fail 1）」
 * @example
 * console.log(genericSummary({ a: { ok: true, stats: { in: 3, out: 3 } }, b: { ok: false, stats: { fail: 1 } } }))
 * // => 1/2 段完成（in 3、out 3、fail 1）
 */
export function genericSummary(reports) {
    const names = Object.keys(reports)
    const okCount = names.filter((n) => reports[n]?.ok !== false).length
    const a = aggStats(reports)
    return `${okCount}/${names.length} 段完成（in ${a.in}、out ${a.out}、fail ${a.fail}）`
}

/**
 * 失敗的子階段名(摘要不得掩蓋失敗)
 *
 * @param {Object} reports 輸入子階段名 → report 之對照物件
 * @returns {Array} 回傳 report.ok===false 之子階段名字串陣列
 * @example
 * console.log(failedNames({ a: { ok: true }, b: { ok: false }, c: {} }))
 * // => [ 'b' ]
 */
export function failedNames(reports) {
    return Object.entries(reports).filter(([, r]) => r?.ok === false).map(([n]) => n)
}

/**
 * 組摘要:全數成功才用固定格式摘要;有子階段失敗時一律改走通用摘要並列出失敗者。
 *
 * 【不能只看 detail 是否存在】失敗時 stdReport 之 detail 是 {}——truthy,固定格式會印出 undefined 而把失敗掩蓋成看似正常的一行。
 * 【部分失敗亦要在人讀路徑看得見】子階段沒倒但 stats.fail>0 時於句尾附註「｜失敗 N」(不改既有格式)
 *
 * @param {Object} reports 輸入子階段名 → report 之對照物件
 * @param {Function} fixedFormat 輸入 () => String，全數成功時嘗試組固定格式摘要，回空字串則退用通用摘要
 * @returns {String} 回傳摘要字串
 * @example
 * let ok = { a: { ok: true, stats: { in: 1, out: 1 } } }
 * console.log(summaryOf(ok, () => '全部完成'))
 * // => 全部完成
 * console.log(summaryOf({ a: { ok: true, stats: { in: 1, out: 1, fail: 2 } } }, () => '全部完成'))
 * // => 全部完成｜失敗 2
 * console.log(summaryOf({ ...ok, b: { ok: false, stats: { fail: 1 } } }, () => '全部完成'))
 * // => 1/2 段完成（in 1、out 1、fail 1）｜失敗：b
 */
export function summaryOf(reports, fixedFormat) {
    const failed = failedNames(reports)
    if (failed.length > 0) return `${genericSummary(reports)}｜失敗：${failed.join('、')}`
    const s = fixedFormat() || genericSummary(reports)
    const fail = aggStats(reports).fail
    return fail > 0 ? `${s}｜失敗 ${fail}` : s
}

/**
 * 物件 report(檔頭之形狀)
 *
 * @param {Object} reports 輸入子階段名 → report 之對照物件
 * @param {String} summary 輸入摘要字串
 * @returns {Object} 回傳物件 report(stdReport 產物):{ ok, stats, detail:reports, summary }
 * @example
 * let rep = objectReport({ a: { ok: true, stats: { in: 2, out: 2 } }, b: { ok: false, stats: { fail: 1 } } }, '1/2 段完成')
 * console.log(rep.ok, rep.stats, rep.summary, Object.keys(rep.detail))
 * // => false { in: 2, out: 2, skip: 0, fail: 1, aiCalls: 0 } 1/2 段完成 [ 'a', 'b' ]
 */
export function objectReport(reports, summary) {
    return stdReport({ ok: failedNames(reports).length === 0, stats: aggStats(reports), detail: reports, summary })
}

/**
 * 抓取之固定格式摘要(預設子階段全數成功時):格式為對外契約——外部巡檢之正則退路依此解析逐輪統計,
 * 既有段落不動,新增段落一律附於句尾、>0 才附
 *
 * @param {Object} reports 輸入子階段名 → report 之對照物件
 * @returns {String} 回傳摘要字串；缺 listFetch 或 detailFetch 之 detail 時回 ''(由 summaryOf 退用通用摘要)
 * @example
 * let reports = {
 *     listFetch: { detail: { sourcesTried: 3, newDocs: 12 } },
 *     detailFetch: { detail: { filled: 10, aggregated: 1, dead: 0 } },
 *     expand: { detail: { picked: 4, newSources: 2 } },
 * }
 * console.log(captureSummaryOf(reports))
 * // => 來源 3 個、新文件 12、素材 10、轉錄 1、放棄 0｜線索消化 4、新來源 2
 * console.log(captureSummaryOf({ listFetch: reports.listFetch }) === '')
 * // => true
 */
export function captureSummaryOf(reports) {
    // 停用之子階段(enabled:false 之 { disabled:true })無數字:輪抓或補全文停用即退用通用摘要;其餘停用者該段不附
    const on = (r) => (r?.detail && !r.detail.disabled ? r.detail : null)
    const lf = on(reports.listFetch)
    const df = on(reports.detailFetch)
    const xp = on(reports.expand)
    const hy = on(reports.hygiene)
    const ar = on(reports.areas)
    const dm = on(reports.docMaintain)
    if (!lf || !df) return ''
    return `來源 ${lf.sourcesTried} 個、新文件 ${lf.newDocs}、素材 ${df.filled}、轉錄 ${df.aggregated}、放棄 ${df.dead}` +
        (xp ? `｜線索消化 ${xp.picked}、新來源 ${xp.newSources}` : '') +
        (df.browserTried > 0 || df.browserDeferred > 0 ? `｜瀏覽器 ${df.browserTried || 0} 試 ${df.browserOk || 0} 成、延後 ${df.browserDeferred || 0}` : '') +
        (hy?.killed > 0 ? `｜孤兒回收 ${hy.killed}` : '') +
        (ar?.added > 0 || ar?.paused > 0 ? `｜領域 新增 ${ar.added || 0}、暫停 ${ar.paused || 0}` : '') +
        // 存量回補(檢定標準 CS1a 健全閘重判、CS10 段落鍵補算;有處理才附):本輪處理數與剩餘
        (dm?.health?.due > 0 ? `｜健全閘重判 ${dm.health.due}（改分流 ${Object.values(dm.health.routed || {}).reduce((a, b) => a + (b || 0), 0)}、未能判定 ${dm.health.undetermined || 0}、剩 ${dm.health.left || 0}）` : '') +
        (dm?.paraKeys?.due > 0 ? `｜段落鍵補算 ${dm.paraKeys.filled || 0}（無原文 ${dm.paraKeys.noText || 0}、剩 ${dm.paraKeys.left || 0}）` : '')
}

/**
 * 抓取物件:hygiene → seedSync → listFetch → detailFetch → docMaintain → expand → areas。
 *
 * @param {Object} [opt={}] 輸入設定物件，非物件時視為{}
 * @param {Array} [opt.stages] 輸入整組重排之子階段陣列(混入自寫 {name, run(ctx)} 單元)，給了即取代下列內建子階段
 * @param {Object} [opt.hygiene] 輸入透傳給 stageHygiene 之 opt(孤兒瀏覽器回收;預設依 settings.capture.browser.hygiene)
 * @param {Object} [opt.seedSync] 輸入透傳給 stageSeedSync 之 opt
 * @param {Object} [opt.listFetch] 輸入透傳給 stageListFetch 之 opt(filter/toRecord/itemsPerSource 亦供 expand 之入庫閘門沿用)
 * @param {Object} [opt.detailFetch] 輸入透傳給 stageDetailFetch 之 opt
 * @param {Object} [opt.docMaintain] 輸入透傳給 stageDocMaintain 之 opt
 * @param {Object} [opt.expand] 輸入透傳給 stageExpand 之 opt
 * @param {Object} [opt.areas] 輸入透傳給 stageAreas 之 opt(領域清單:品質回饋、自動發現、來源同步、投影)
 * @param {String} [opt.name='抓取'] 輸入階段名稱
 * @param {String} [opt.onError='continue'] 輸入階段失敗處置，'continue'／'abort'
 * @returns {Object} 回傳階段物件 { name, onError, run(ctx) }
 * @example
 * need test in nodejs.
 *
 * let obj = createCaptureObject({ detailFetch: { articlesPerRun: 10 } })
 * console.log(obj.name)
 * // => 抓取
 */
export function createCaptureObject(opt = {}) {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    const lf = opt.listFetch || {}
    const stages = opt.stages || [
        // 孤兒瀏覽器回收:持鎖後、本輪瀏覽器啟動前(settings.capture.browser.hygiene 開啟才動作)
        stageHygiene(opt.hygiene || {}),
        stageSeedSync(opt.seedSync || {}),
        stageListFetch(lf),
        stageDetailFetch(opt.detailFetch || {}),
        stageDocMaintain(opt.docMaintain || {}),
        // 探測入庫與輪抓走同一閘門(stores/ingestGate):安裝方給 listFetch 的 filter/toRecord/itemsPerSource
        // 對探測文件同樣生效;要分開治理時明給 opt.expand.ingest
        stageExpand({ ingest: { filter: lf.filter, toRecord: lf.toRecord, itemsPerSource: lf.itemsPerSource }, ...(opt.expand || {}) }),
        // 領域清單:品質回饋、自動發現(每日至多一次 AI)、來源同步、投影——排最末,AI 不阻塞抓取
        stageAreas(opt.areas || {}),
    ]
    return {
        ...stageFields(opt, { name: CAPTURE_REPORT_KEYS.stage }),
        run: async (ctx) => {
            const reports = await runSubStages(stages, ctx)
            return objectReport(reports, summaryOf(reports, () => captureSummaryOf(reports)))
        },
    }
}

export default createCaptureObject
