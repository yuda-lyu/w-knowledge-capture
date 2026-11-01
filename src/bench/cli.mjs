// cli.mjs — 領域發現 AI 能力評分之命令列(薄殼:直接執行時交 bench/areaBench 之 runAreaBenchCli;參數解析、評分、報表皆在該處)
//
// 用法:node bench/cli.mjs [--models <id,…>|free] [--cases <題組 json>] [--runs 2] [--out <目錄>] [--env <金鑰檔>]
//                          [--timeout <毫秒>] [--concurrency <n>]
//   各選項之說明見 areaBench 之 AREA_BENCH_USAGE(--help 印出);報表落 --out(預設 cwd 之 ./bench-out/)。
//
// 【被 import 時不執行】只在直接執行(node bench/cli.mjs …;判定取 core/util/cli 之 isDirectRun,各命令列同一份)時跑;被 import 時只轉出
//   runAreaBenchCli(與套件入口同一實體),故可與其他公開模組一樣被載入檢查,不必列為例外。

import { isDirectRun } from '../core/util/cli.mjs'
import { runAreaBenchCli, AREA_BENCH_USAGE } from './areaBench.mjs'

export { runAreaBenchCli }

if (isDirectRun(import.meta.url)) {
    runAreaBenchCli(process.argv.slice(2)).catch((e) => {
        console.error(`領域發現 AI 能力評分失敗：${e?.message || e}\n${AREA_BENCH_USAGE}`)
        process.exitCode = 1
    })
}

export default runAreaBenchCli
