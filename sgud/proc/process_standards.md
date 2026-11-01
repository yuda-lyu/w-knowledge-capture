# 處理要點 — 檢定標準之處置工具與 AI 標準(CS8)

> 本檔記本套件提供之符合度掃描、存量處置與待判工具之行為與使用判準,以及唯一之 AI 標準 CS8(領域發現)之換席做法。標準本身見 `../rule/rulebook_standards.md` 與 `README.md` §12;維運排程、巡檢、備份與同意流程屬使用端。本套件之處置工具(`src/standards/cs10Fix.mjs`、`src/standards/cs12Fix.mjs`)皆不呼叫 AI。

## 符合度掃描

- `auditCaptureStandards({ stores, settings }, opt)`(`src/standards/audit.mjs`,唯讀):依現行判定掃存量,逐標準列合格／違反／未能判定／已豁免之件。常用 `opt`:`only`(只跑指定標準 id)、`maxIds`(每態列出 id 之上限)、`material`(CS10 是否以原文補算無段落雜湊者,預設 true)。`stores.holds`(使用者豁免,選配,需自行開啟)可豁免 CS1a、CS2、CS10(登錄物件 `doc`)與 CS12(登錄物件 `CS12_HOLD_OBJECT`)之個案。標準表在 `CAPTURE_STANDARDS`(`src/standards/registry.mjs`)。
- 管線每輪結束自動掃一次可確定性判定之標準,由 `capture.standards.scanEachRun` 開啟(預設 false,大庫耗時;計數入 `run.json`)。
- **使用端判讀**:違反 > 0 必看;**違反數較前次掃描增加**(而非標準升版所致)表示有寫入入口缺閘門——新進者應被入口擋下,應查寫入入口,不以存量處置掩蓋。

## 存量處置(CS10、CS12)

流程:**預演 plan → 套用 apply(逐件記帳) → 連鎖斷言 verify → 重掃 → 不合格則回退 rollback**。套件只提供工具;**呼叫端負責**取執行鎖(套用期間無輪次在跑)、一致備份與使用者同意(正式庫)。先於資料複本演練(預演 → 套用 → 連鎖斷言 → 回退往返)再動正式庫。

- **CS10 同一內容**:`planCs10Fix` → `applyCs10Fix` → `verifyCs10Chain` → `rollbackCs10Fix`(另有 `readCs10Ledger`)。目標取自符合度掃描(只處置現行違反者,已豁免者不在內)。**只改文件,不碰筆記**:群內他份之文件改 `skip`(`skipKind: 'duplicate'`、`dupOf` 記留存者),套用回傳之 `notesToHandle` 列出其筆記,須由呼叫端以刪筆記之正規路徑撤除(可還原)——只改文件而筆記仍在,知識庫仍見同一內容兩份。留存者選定:給了 `stores.notes` 者依 ①筆記已被下游消化 ②有筆記 ③較早成筆記 ④id;未給者只依 ③④。與留存者直接相連者才處置,其餘列 `deferred`、下輪重掃再依其自身重疊成群。
- **CS12 領域標籤與線索值為正體**:`planCs12Fix` → `applyCs12Fix` → `verifyCs12Chain` → `rollbackCs12Fix`。修法與判定同一定義(線索值之網址與 `[[連結]]` 不轉)。**修不了者列 `unfixable`、不寫(不留半套)**:種子領域(標籤以 `data.gridTopics` 為準、每輪同步覆寫,改庫下輪即被改回,須改種子)、轉換後仍違反、轉換會使線索鍵改變者。開了 `holds` 時,套用自行登錄使用者待判(`CS12_HOLD_OBJECT`;下一步 `CS12_HOLD_NEXT`、期限 `CS12_HOLD_DEADLINE_DAYS` 天),未開者列 `errors`(不靜默);已不再違反之未結登錄由預演列 `resolvable`、套用時結案(掃描唯讀,不會結案)。
- **處置帳**:`<state>/stock-fix.jsonl`(`STOCK_LEDGER_FILE`,`src/core/stores/stockLedger.mjs`;下游各工作同一本帳,各模組只認自己的列)。逐件先寫入、即記帳、再回驗,中途中止亦留已寫者;讀帳遇無法解析之列即拒(`allowBad` 才略過)。
- **回退＝撤銷該次處置之效果**:依帳逆序逐列以回退防護還原(逐欄三態):現值＝處置後者寫回處置前之值(處置前不存在之鍵刪除)、已回到處置前者視為已完成、其後被改動之欄位或文件已不在者列 `conflicts`、不覆寫、不記回退列(`acceptCurrent` 才接受現值並記取代列)。
- **回退判準**(由使用端之編排層落實,套件不內建):套用失敗(`errors` 非空)、連鎖斷言有問題(`verify*Chain` 之 `problems` 非空)、或套用後重掃之不合格多於應剩之件數(全量:修不了者之件數;限量:套用前之違反數減已套用件數)——任一成立即回退。
- 守門測試:`test/unit-cs10fix.test.mjs`、`test/unit-cs12fix.test.mjs`、`test/unit-stock-ledger.test.mjs`、`test/unit-holds.test.mjs`。

## 待判(`src/core/stores/holds.mjs`,下游各工作同一機制)

- 查 `listHolds(store, filter)`、重試 `requestRetry(store, id, opt)`、豁免 `waiveHold(store, id, { by, ruling })`(裁示者與內容必給)、結案 `resolveHold`;逾期用 `overdueHolds`。
- 每個待判登錄須寫明「下一步」——使用者照做即可完成之處置(CS12 之 `CS12_HOLD_NEXT` 為例);豁免之個案,符合度掃描記「已豁免」。

## 原文回溯(依原文判定之存量標準之材料)

依原文判定之下游標準(如筆記紮根)只能以當時 AI 所讀之材料為準:API 類回溯物(arXiv 編號、DOI)為同一記錄,可作材料;網頁類回溯物是「現在的頁面」,不可作材料。作法、順序與用量見 `process_capture.md`〈原文回溯〉。

## AI 標準 CS8(領域發現;本套件唯一之 AI 標準)

- CS8:領域發現之 AI 輸出合契約(程式把關);判斷品質以題組評(`test/api-area-ai.test.mjs`、`node src/bench/cli.mjs`,見 `README.md` §13)。席位 `capture.discover.ai` 為葉(覆寫時整個取代,須連同要保留之 `fallback` 一併給),預設全為免費模型。
- **換席位前**:以該席之模型跑通用題組——`node src/bench/cli.mjs --models <id>`,或 `WK_LIVE_AI=1 WK_AREA_MODELS=<id> node ./node_modules/mocha/bin/mocha.js --timeout 180000 test/api-area-ai.test.mjs`(燒免費額度,須使用者同意);**各案各回之類別皆等於應然才算通過**(一回不符即不通過)。**分數會浮動**(同一模型兩次評分可差 1～2 案),據以換席位前宜加大 `--runs` 或重跑確認。條目 id 須在 w-dispatch-ai 目錄內(`opencode models` 查實),目錄漂移於建構期拋錯。
- **容量**:領域發現每 24 小時至多一次(`capture.discover.everyHours`)、每次一條遞補鏈;失敗不作廢窗口,`min(發現間隔, 3 小時)` 後再試。不構成額度壓力;下游 AI 標準之容量(依「容量 ≥ 進料」定配額與席位)屬各下游。
