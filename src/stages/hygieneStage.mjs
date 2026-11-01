// hygieneStage.mjs — 抓取物件子階段 a0:孤兒瀏覽器行程回收(core/ops/browserHygiene;取得執行鎖之後、任何瀏覽器使用之前)
//
// 【為何是管線內第一段】執行鎖在 runPipeline 內取得(w-data-pipeline definePipeline),鎖外掃描可能誤殺前一輪仍在跑之行程;
//   放抓取物件第一段＝持鎖後、本輪瀏覽器啟動前。
// 【預設關閉】會掃描整台機器之行程:settings.capture.browser.hygiene 由安裝端開啟;測試組裝一律關閉(或注入行程清單)。
// 【失敗只揭露不擋輪】行程清單或殺除失敗回 report.ok=false(物件層記 WARN、日誌可見),不中止本輪抓取。
// 【無動作鏈】機制性子階段,無 hook 錨點:opt.tap／chain 給了即拋錯(不在 captureObject 之 CAPTURE_TAP_STAGE_KEYS)。

import isobj from 'wsemi/src/isobj.mjs'
import { stdReport, rejectChainOpts, stageFields } from '../core/kernel.mjs'
import { sweepOrphanBrowsers } from '../core/ops/browserHygiene.mjs'

/**
 * 孤兒瀏覽器回收子階段
 *
 * @param {Object} [opt={}] 輸入子階段 opts，非物件則回退為 {}
 * @param {Boolean} [opt.enabled] 輸入是否啟用，未給則用 settings.capture.browser.hygiene===true
 * @param {Function} [opt.listProcesses] 輸入行程清單函數(測試注入；見 sweepOrphanBrowsers)
 * @param {Function} [opt.killTree] 輸入樹狀殺除函數(測試注入)
 * @param {Array} [opt.targets] 輸入回收目標定義(見 HYGIENE_TARGETS_DEFAULT)
 * @returns {Object} 回傳階段物件 { name:'hygiene', run(ctx) }
 * @throws {MwContractError} opt.tap／opt.chain 給了時拋出(本子階段無動作鏈)
 * @example
 * // 以替身注入行程清單與殺除函數，不列舉真實行程、不殺任何行程
 * let procs = [{ name: 'chrome.exe', pid: 2, ppid: 1, createdMs: 10, cmd: 'chrome.exe playwright_chromiumdev_profile-x' }]
 * let stage = stageHygiene({
 *     enabled: true,
 *     listProcesses: async () => procs,
 *     killTree: async (pid) => { procs = procs.filter((p) => p.pid !== pid) },
 * })
 * let r = await stage.run({ deps: {}, log: { info() {}, warn() {} } })
 * console.log(stage.name, r.ok, r.detail.scanned, r.detail.killed)
 * // => hygiene true 1 1
 *
 * // 未啟用(opt.enabled 與 settings.capture.browser.hygiene 皆未開)時不掃描
 * console.log((await stageHygiene().run({ deps: {} })).detail)
 * // => { disabled: true, orphans: 0, killed: 0, failed: 0 }
 */
export function stageHygiene(opt = {}) {

    //check
    if (!isobj(opt)) {
        opt = {}
    }
    rejectChainOpts('hygiene', opt)

    // enabled:false 於物件層即略過本子階段(runSubStages,不入 report);enabled:true 強制回收(不看設定);未給依 settings.capture.browser.hygiene
    return {
        ...stageFields(opt, { name: 'hygiene' }),
        run: async (ctx) => {
            const enabled = opt.enabled ?? ctx.deps.settings?.capture?.browser?.hygiene === true
            if (!enabled) return stdReport({ detail: { disabled: true, orphans: 0, killed: 0, failed: 0 } })
            const r = await sweepOrphanBrowsers({ listProcesses: opt.listProcesses, killTree: opt.killTree, targets: opt.targets })
            const byTarget = {}
            for (const o of r.killed) byTarget[o.target] = (byTarget[o.target] || 0) + 1
            const prof = r.profiles || { removed: [], failed: [] }
            if (r.skipped) ctx.log.info(`孤兒瀏覽器回收：${r.skipped}`)
            else if (r.orphans.length) ctx.log.info(`孤兒瀏覽器回收：掃描 ${r.scanned} 個行程，孤兒 ${r.orphans.length}，已殺 ${r.killed.length}（${Object.entries(byTarget).map(([k, v]) => `${k} ${v}`).join('、') || '-'}）${prof.removed.length ? `；清除其暫存 profile ${prof.removed.length} 個` : ''}`)
            for (const f of r.failed) ctx.log.warn(`孤兒瀏覽器回收：殺除後仍存在 ${f.target} pid ${f.pid}（${f.error}）`)
            // profile 刪不掉只揭露(INFO 帶路徑):不影響本輪,下輪不會再列(其孤兒已死、命令列不復存在)——留待人工清
            for (const f of prof.failed) ctx.log.info(`孤兒瀏覽器回收：暫存 profile 未能刪除 ${f.dir}（${f.error}）`)
            return stdReport({
                ok: r.failed.length === 0,
                stats: { in: r.orphans.length, out: r.killed.length, fail: r.failed.length },
                detail: { scanned: r.scanned, orphans: r.orphans.length, killed: r.killed.length, failed: r.failed.length, byTarget, profilesRemoved: prof.removed.length, profilesFailed: prof.failed.length, ...(r.skipped ? { skipped: r.skipped } : {}) },
            })
        },
    }
}

export default stageHygiene
