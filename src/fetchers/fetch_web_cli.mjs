#!/usr/bin/env node
// fetch_web_cli.mjs — 瀏覽器階梯之子行程入口(檔名 snake_case 標示其為「被執行的腳本」,與被 import 之模組區隔)
//
// 用法(由 browserFetcher 經wsemi 之 execCliJsonFile 呼叫,不由人工執行):
//   node fetch_web_cli.mjs <url> <optsFile> <outputPath>
//   optsFile 為 JSON:{ steps:[階名], skip:[方法名], stepOpts:{…}, gate:{ minTextChars, placeholderPatterns, paywallPatterns, maxSaneChars } }
//   結果一律寫 outputPath(JSON);寫成功即 exit 0(含 status:'error' 之結構化失敗),寫不出才 exit 1。
//   被 import 時不做任何事(只在以 node 直接執行時跑):套件之入口契約測試會 import 每一個模組。
//
// 【為何是子行程】w-fetch-web 之 Playwright／Camofox 階會啟動瀏覽器與 Camofox server。在主行程呼叫時:
//   ①外層逾時只是「不再等」(w-data-pipeline attemptFetch 為合作式取消,fetchWeb 不收 signal),背景瀏覽器繼續跑、與下一篇重疊,
//     Camofox 固定埠自撞;②主行程被強制終止(排程 ExecutionTimeLimit／StopExisting、崩潰)時瀏覽器整棵孤兒化。
//   子行程由 wsemi execCli 控管逾時並以 taskkill /T 樹狀殺。
// 【Chromium 系瀏覽器之啟動只經 w-playwright】Playwright 階由 w-fetch-web 呼叫自有套件 w-playwright 啟動(本套件不直接依賴 playwright／playwright-core);
//   w-playwright 於每次啟動之命令列恰給一串 --disable-features(Playwright 預設清單＋守門功能 AutofillAiWalletPrivatePasses＋呼叫端自給者),
//   使 Windows 上 Chromium 153 起每啟動一個新根行程即以無效密碼呼叫一次 LogonUser 之行為不再發生(避免帳號被本機原則鎖定);原因與細節見 README §2。
//   守門之接線由 test/unit-capture-launch-wiring 斷言(以預載件 test/tools/wpwFakeLaunch 在本 CLI 的子行程內接住啟動)。
// 【PATH 前置 node 目錄】Camofox server 以 spawn('node', …) 啟動且無 error 監聽(w-fetch-web runCamofoxAttempt),
//   排程環境之 PATH 未必含 node(以絕對路徑啟動 node 之排程即屬此類):前置本行程之 node 目錄。

import fs from 'fs'
import path from 'path'
import { isDirectRun } from '../core/util/cli.mjs'

/**
 * 子行程主流程:讀設定 → 跑階梯 → 結果落檔 → 離開
 *
 * @param {Array} argv 輸入 [url, optsFile, outputPath]
 * @returns {Promise} 回傳 Promise，完成時行程以 exit 0 結束(寫檔失敗 exit 1)
 */
async function main(argv) {
    const [url, optsFile, outputPath] = argv
    process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`

    const writeOut = (result) => {
        try {
            fs.writeFileSync(outputPath, JSON.stringify(result), 'utf8')
        }
        catch (e) {
            process.stderr.write(`寫入結果失敗：${e?.message || e}\n`)
            process.exit(1)
        }
    }
    if (!url || !optsFile || !outputPath) {
        process.stderr.write('用法：node fetch_web_cli.mjs <url> <optsFile> <outputPath>\n')
        process.exit(1)
    }
    // 子行程內之未捕捉例外亦須落成結構化結果(否則呼叫端只看到非 0 離開碼)
    process.on('unhandledRejection', (e) => {
        writeOut({ status: 'error', reason: 'browser-env', message: `子行程未處理之 rejection：${e?.message || e}`, final: false, envBroken: [], steps: [] })
        process.exit(0)
    })
    process.on('uncaughtException', (e) => {
        writeOut({ status: 'error', reason: 'browser-env', message: `子行程例外：${e?.message || e}`, final: false, envBroken: [], steps: [] })
        process.exit(0)
    })

    let opts = {}
    try {
        opts = JSON.parse(fs.readFileSync(optsFile, 'utf8'))
    }
    catch (e) {
        writeOut({ status: 'error', reason: 'browser-env', message: `讀不到階梯設定：${e?.message || e}`, final: false, envBroken: [], steps: [] })
        process.exit(0)
    }

    // 依賴於 PATH 設定之後才載入(Camofox 之 spawn 讀 process.env.PATH)
    const { default: fetchWeb } = await import('w-fetch-web/src/fetchWeb.mjs')
    const { DEFAULT_SITE_ADAPTERS, mergeSiteAdapters } = await import('./siteAdapters.mjs')
    const { createContentGate, GATE_DETECTORS_DEFAULT } = await import('../stores/contentGate.mjs')
    const { runBrowserLadder } = await import('./browserLadder.mjs')
    const { importGateDetectors, importAdapters } = await import('../core/util/injectables.mjs')

    // 注入件依主行程寫入之跨行程規格重建(偵測器:內建以 id 取、自訂 import;adapter:帶 module 者 import 後與自帶清單合併);
    //   載不到即環境失敗(browser-env:不計該篇之次數,訊息指出哪一件)
    let gate
    let adapters
    try {
        const { detectorSpecs, ...gateOpt } = opts.gate || {}
        const detectors = Array.isArray(detectorSpecs) ? await importGateDetectors(detectorSpecs, GATE_DETECTORS_DEFAULT) : null
        gate = createContentGate({ ...gateOpt, detectors })
        adapters = mergeSiteAdapters(DEFAULT_SITE_ADAPTERS, await importAdapters(opts.adapterSpecs || []))
    }
    catch (e) {
        writeOut({ status: 'error', reason: 'browser-env', message: `子行程載入注入件失敗：${e?.message || e}`, final: false, envBroken: [], steps: [] })
        process.exit(0)
    }

    const result = await runBrowserLadder(url, opts.steps || [], {
        fetchWeb,
        gate,
        skip: opts.skip || [],
        stepOpts: { ...(opts.stepOpts || {}), adapters },
    })
    writeOut(result)
    process.exit(0)
}

// 只在以 node 直接執行時跑(被 import 時不動作;判定取 core/util/cli 之 isDirectRun,各命令列同一份)
if (isDirectRun(import.meta.url)) await main(process.argv.slice(2))
