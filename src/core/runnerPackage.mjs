// runnerPackage.mjs — 執行秩序件之單一匯入點(執行鎖、時間預算與截止公式、落檔日誌、單行化、AI 目錄展開、時鐘、子行程之 JSON 執行、CLI 失敗摘要)
//
// 【為何單一匯入點】執行秩序件取自自有套件 w-data-pipeline、w-dispatch-ai、wsemi 之深層路徑(自有套件發布後 main 指 UMD、原始碼在 src/;
//   w-data-pipeline 之主入口不提供具名匯出,具名取件一律走深層路徑);本套件一律經本檔取用——他檔不直接 import 該等路徑,
//   依賴之件一目瞭然,升版時只核對本檔。
// 【執行秩序只有一份實作】執行鎖之行程內登記表為模組級:同一行程內取用同一把鎖者須用同一份模組(w-data-pipeline 之 executionLock),
//   不得另帶副本;時鐘、日誌、時間預算、截止公式、子行程 JSON 執行、目錄展開同此,本套件不另寫一份。
// 【經本套件主入口原名轉出】本檔所列之名一併由主入口轉出:下游套件經本套件之埠取用(不另依賴該三套件之此類件),取得之件與來源模組之件為同一實體。

// ── 鎖、時間預算與截止公式、日誌、單行化(w-data-pipeline)──
export { acquireLock, inspectLock } from 'w-data-pipeline/src/lock/executionLock.mjs'
export { budgetOf, reserveOf, reserveMsOf } from 'w-data-pipeline/src/budget/budget.mjs'
export { deadlineMsOf, DEADLINE_MARGIN_MS, DEADLINE_FLOOR_MS } from 'w-data-pipeline/src/budget/deadline.mjs'
export { createRunLogger, createLogger } from 'w-data-pipeline/src/log/runLogger.mjs'
export { oneline } from 'w-data-pipeline/src/util/oneline.mjs'
// ── AI 目錄展開(w-dispatch-ai)──
export { default as resolveCatalogue } from 'w-dispatch-ai/src/resolveCatalogue.mjs'
// ── 時鐘、子行程之 JSON 執行、CLI 失敗摘要(wsemi)──
export { default as genClockTZ } from 'wsemi/src/genClockTZ.mjs'
export { default as execCliJsonFile } from 'wsemi/src/execCliJsonFile.mjs'
export { default as execCliFailDetail } from 'wsemi/src/execCliFailDetail.mjs'
