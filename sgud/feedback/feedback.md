# 回饋(feedback)

任務中發現之自有套件、全域技能、全域設定之調整與抽提提案(全域設定 §12.2);只增不改,處置結果另記一列,供主控核實、盤點與整合。本檔為提案紀錄,不等於已修改;不寫金鑰、內網位址、帳號與使用端專案名稱與案情。

| 日期 | 類別 | 對象 | 內容 | 依據 |
|---|---|---|---|---|
| 2026-11-11 | 自有套件 | w-dispatch-ai `dispatchAiFallback` 之 `envDown` 等待上限 | 環境歸因之等待為 `min(5 秒, max(期限−現在, 1))`:整條遞補鏈耗盡預算而失敗(本機斷網時 CLI 條目等滿逾時、或呼叫端以剩餘時間給 `budgetMs`)者,詢問幾乎不等待,呼叫端之真實探測(本套件 `netGuard.confirmDown`,探測逾時預設 8 秒)來不及回覆即視同「通」——n 與連敗照常落定、結果不帶 `envDown`。本套件依設計已移除「結果後自問」,此情境由修前之 skipped 變為照計失敗。建議:環境歸因屬整鏈結束後之記帳,其等待不以剩餘預算封頂(或給下限,如 5 秒;或開放 `envDownWaitMs`)。已列本輪需裁示。 | `node_modules/w-dispatch-ai/src/dispatchAiFallback.mjs:1287`;重現 `ci402` 探測(延遲 50 毫秒回 true 之 `isNetDown`＋等滿逾時之條目) |
| 2026-11-11 | 自有套件 | w-dispatch-ai `cooled` 事件(條目層) | 事件未帶「寫入前是否已在有效視窗內」(視窗內之重申只更新時刻、n 不變,與視窗外之新觸發同形),只觀察之呼叫端(本套件健康層之 `onHealth`)只能以本行程觀察到之事件判斷重申:新行程於前輪留下之視窗內首次重申仍回呼一次;同一 store 之另一實例成交清除後,本實例未見 `ok` 而可能把真正之新冷卻當重申。建議 `cooled` 另帶 `fresh: true|false`(或 `n0`)。 | `src/core/ai/providerHealth.mjs` `onEvent`(`coolAt`);`node_modules/w-dispatch-ai/src/cooling.mjs:192-212` `applyCool`;外審 terra F06 |
| 2026-11-11 | 自有套件 | w-dispatch-ai `callAiWithFallback`(工作流之單棒結果) | 回傳物件未帶遞補層結果之 `envDown`(已帶 `quotaExhausted`、`failureKind`),工作流之呼叫端(本套件工作流入口)無從得知遞補層已確認斷網,只能再問一次 `isNetDown` 以標記(每個整鏈皆敗之名額共問 2 次)。建議單棒結果同樣原樣帶出 `envDown: true`,呼叫端即可只讀不問。 | `node_modules/w-dispatch-ai/src/wkf/callAiWithFallback.mjs:306-321`;`src/core/ai/adapter.mjs` 工作流入口 `callAi`／`runFanout` |
