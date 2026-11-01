# 現況（w-knowledge-capture）— 2026-11-01

> 只記現況，不寫過程（過程在 `../exp/`）。接續工作先讀本檔；完成一項功能或結束一輪工作即更新。
> **路徑基準**：原始碼在 `src/`（2026-11-01 移入）；下文與分檔之檔案路徑，除明寫 `test/`、`toolg/`、`sgud/`、`g.mjs` 者外，皆相對 `src/`。`srcCapture` 為本套件在宿主專案內原本之目錄名；`tmp/…` 證據夾屬宿主專案，不在本套件內。

## 身分與位置

- npm `w-knowledge-capture`、版本 1.0.0（首次發布時由 addVersion 升為 1.0.1）；主入口 `src/WKnowledgeCapture.mjs`、總組裝 `createKnowledgeCapture`、執行期件 `createCaptureRuntime`、物件 `captureObject.mjs`；`main` 為 `dist/w-knowledge-capture.umd.js`（Node 專用 UMD，發布流程產製）。
- 套件佈局（2026-11-01 依自有套件範本 w-knowledge-extract 重整）：`src/`（原始碼，子目錄不變）、`test/`（`test/tools/` 輔助件隨 npm 包發布）、`toolg/`（`addVersion`、`modifyReadme`、`cleanFolder`、`gDocsExams`、`gDistRollup`）、`g.mjs`（離線範例，輸出附檔末，README Example 為其複本）、根目錄範本檔（`.editorconfig`、`.eslintignore`、`.eslintrc.js`、`.jsdoc`、`babel.config.js`、`SECURITY.md`、`script.txt`）；`模型評比.csv` 留套件根（bench CLI 之 `--board` 輸出，程式不讀）。`package.json` 不設 `exports`／`files`（下游以深層路徑取 `src/…` 與 `test/tools/…`），發布範圍由 `.npmignore` 決定。
- 依賴：`dependencies` 為 opencc-js ^1.4.2、w-data-pipeline ^1.0.24、w-dispatch-ai ^1.0.64、w-dwdata-hub ^1.0.25、w-fetch-web ^1.0.30、w-orm-lmdb ^1.0.50、wsemi ^1.9.39（皆與 `src/` 之實際 import 對帳，守門 `unit-package` ⑤）；`devDependencies` 為 w-package-tools ^1.1.21（mocha 隨之安裝）。**不依賴執行殼**：執行秩序件取自 w-data-pipeline 1.0.24、w-dispatch-ai 1.0.64、wsemi 1.9.39（Gitea issue #39～#42），`core/runnerPackage.mjs` 以深層路徑取用（名稱 createClock→`genClockTZ`、runJsonCli→`execCliJsonFile`、cliFailDetail→`execCliFailDetail`，其餘同名）；`queueAge` 與 `readJson`／`writeFileAtomic` 在本套件 `core/util/{queueAge,fileIo}.mjs`。
- 被誰用：下游三套件（摘要、關聯、提煉）各經其 `core/capturePackage.mjs` 以深層路徑取本套件之 `w-knowledge-capture/src/…` 與 `w-knowledge-capture/test/tools/…`（埠名單：摘要 78→依審計增減、關聯 125、提煉見其埠檔）；宿主專案經其 `src/pipeline/packages/capture.mjs`；正式管線之抓取即本套件之實作。
- 發布狀態：尚未發布（發布由使用者；自有套件只發布至私有倉庫 Verdaccio）。

## 審計與結構

| 項 | 狀態 |
|---|---|
| 套件審計（2026-10-11） | **結案**：P0～P8＋P2 補做（終審 `tmp/capture-pkg-audit/終審.md` §5 56 條逐條核對；進度 `進度.md`）。快照 `tmp/capture-pkg-audit/pre/`＋`pre-manifest.json` **勿清** |
| 四套件界定審計（2026-10-28） | 結案 S0～S7（`tmp/pkg-scope/`）：語言設定 `cfg.lang`（`core/locale.mjs resolveLocale`；GEN-20）、自有套件升版 gen-upd；共用件由本套件提供、不立第五套件 |
| 隨下游審計之修改 | srcSummarize 審計（10-11～12）：待判登錄、存量帳協定、掃描累計器、總組裝共用件、詞彙機制、值工具、日誌核心字樣、測試件皆落本套件（GEN-19）；srcRelate 審計（10-12～29）：JSONL 共用件、`cmp`／`strictTextOf`、prompts 四件、`composeNamespaces`、`captureVocabDefaultOf`、benchKit base／seq、`withCheck`／`deepMerge`／`parseCsv`／`sourceFilesOf`／`benchCaseNotesOf`、回退帳協定（`rollbackPlanOf`／`writeRollback`）；srcExtract 審計 P1（10-30）：stockLedger `seq`、holds 先記、`stockLedger.mjs` 檔頭字樣 |
| 分層 | core 內 `core/util`、`core/stores`、`core/ai`、`core/vocab`、`core/standards`；`unit-core-layers` 守 core 分層之明列例外 |

## 最近驗證

| 日期 | 項 | 結果 |
|---|---|---|
| 2026-11-01 夜 | 重整為自有套件佈局（原始碼移入 `src/`、補根目錄範本檔與 `toolg/`、`package.json` 依範本、`unit-package` 等結構測試改指 `src/`、`src/` 全部匯出函數補齊 JSDoc〔含 `@example`〕、README 加標頭與 Example）後全套 `npm test` | **1099 ✓、0 ✗、5 pending**（與重整前同數）；`node node_modules/jsdoc/jsdoc.js -c .jsdoc`、`node toolg/gDocsExams.mjs`、`node toolg/gDistRollup.mjs` 皆 exit 0；`require('./dist/w-knowledge-capture.umd.js')` 載入且匯出鍵含主入口全部具名匯出；`g.mjs` 離線可跑 |
| 2026-11-01 晚 | 執行秩序件改取 w-data-pipeline／w-dispatch-ai／wsemi（匯入點換來源、名稱改寫、fileIo／queueAge 新檔、守門 ①⑤ 改寫、resolveClockCfg 收攏無效時區之拋出點）後全套 | **1099 ✓、0 ✗、5 pending**；執行殼 22、摘要 648、關聯 546（noteOps md 回寫改字串）、提煉 831；run-all 44 ✓（6 略過）；宿主 `verify-pkg-upgrade` 17 項 0 ✗、`check-seats` ✓ |
| 2026-11-01 | 升版 w-dispatch-ai 1.0.62（目錄依 issue #25 下架 3 條、新增 flint-40b-free）後 `bench/benchKit.mjs` `DEFAULT_FREE_MODELS` 對齊；`unit-bench`＋`unit-bench-kit` | 52 ✓；宿主 `verify-pkg-upgrade` 17 項 0 ✗、`check-seats` ✓（全套未重跑） |
| 2026-11-01 | `unit-package`（poolQuota 註解去日期、README 改 `rollbackStockHold` 後）；srcRelate `unit-relate-package`（README 改 `standardsCountsOf` 後） | 56 ✓；21 ✓（全套未重跑：本日只改註解、README 與 sgud） |
| 2026-10-31 | 全套（偵測器陣列注入、CS5 全掃、額度字樣補入後）＋五套件＋專案 run-all | **1095 ✓、0 ✗、5 pending**；執行殼 95、摘要 648、關聯 546、提煉 831；run-all 39 ✓（6 支需環境略過）。註：該次驗證後 18:00 於 `poolQuota.mjs` 補入之註解含日期，`unit-package` ⑥ 於 11-01 核對時失敗 1 案，同日修 |
| 2026-10-30 | 全套（sgud 建立、package 守門增 sgud／ignore 檔判準後） | **1079 ✓、0 ✗、5 pending**（真 AI／實網） |
| 2026-10-30 | 提煉審計檢查點 `pk p1`（五套件） | 抓取 1078 ✓（unit-package ⑥ 字樣改後）、執行殼 95、摘要 648、關聯 546、提煉 661 |
| 2026-10-29 | 關聯審計 P10 檢查點 | 抓取 1078／0／5；專案 run-all 39 ✓、6 未執行（需環境）、0 ✗ |
| 2026-10-11 | 複本真實 AI 冒煙（審計 P8；sonnet 20 席） | 一輪五段皆 ok、判準全過（`tmp/capture-pkg-audit/p8/check.json`） |

## 功能現況（對應規則帳本）

| 功能 | 狀態 | 規則／測試 |
|---|---|---|
| 七子階段（hygiene、seedSync、listFetch、detailFetch、docMaintain、expand、areas） | 落地並為正式管線所用 | CAP-01～14；`unit-capture-stages`、`unit-flow-capture`、`unit-flow-areas` |
| 正文健全閘、瀏覽器分流（Playwright／Camofox）、判死類別、退避 | 落地 | STD-09、CAP-04；`unit-capture-fetch-checks`、`unit-capture-browser`、`unit-capture-policies` |
| 無效文章處置、原文另存（docTexts）、死件回收、剔除清單 | 落地（宿主工具 `revive-dead`／`rejects`／`refetch-sources`） | CAP-13、STD-03；`unit-capture-fix`、`unit-capture-refetch`、`unit-rejects` |
| 本機網路不通之判斷（netGuard） | 落地 | CAP-12；`unit-capture-netguard` |
| AI 調度層（唯一一份）：遞補、冷卻、健康、免費池額度、能力預篩、JSON 取最後一段、斷網不計、工作流 | 落地 | AI-01～11；`unit-ai-adapter*`、`unit-ai-json-reply` |
| 檢定標準 CS1～CS12 之掃描與存量處置（CS10 重複、CS12 線索簡體） | 落地 | STD-09／22／25／26；`unit-capture-standards`、`unit-cs10fix`、`unit-cs12fix` |
| 領域發現（CS8；席位 `capture.discover.ai`） | 落地 | CAP-11；`unit-capture-areas`、`api-area-ai`（真 AI） |
| 健全閘偵測器陣列注入（`capture.standards.detectors`；內建 `GATE_DETECTORS_DEFAULT` 對外；自訂者帶 `module`，瀏覽器子行程依規格重建）；站台 adapter 帶 `module` 者亦達瀏覽器層 | 落地（2026-10-31） | CAPX-10；`unit-capture-browser`、`unit-settings`、`unit-assembly` |
| CS5 來源健康存量全掃（記錄形狀、連敗／連空／零產出與寫入同一判定 `sourceStopReasonOf`） | 落地（2026-10-31） | CAPX-11；`unit-capture-policies`、`unit-capture-standards` |
| 免費 AI 能力評分（`bench/`） | 落地；`模型評比.csv` 2026-10-06 由第一輪結果轉出 | GEN-15／16；`unit-bench*` |
| 語言設定 `lang` | 落地（預設 zh-TW，與出現前逐字同） | GEN-20；`unit-core-locale` |
| 自有套件佈局、編譯與文件（`src/`、`toolg/`、`dist` UMD、JSDoc、`g.mjs`、README Example） | 落地（2026-11-01）；`dist/`、`docs/` 由 `script.txt` 流程於發布時產製 | 規則帳本鐵則 9、10；`unit-package` ①⑤ |

## 已知缺口與待辦

- **目錄漂移**：`w-dispatch-ai` 目錄之三個免費 id 已下架（Gitea issue #25，2026-10-30 送出，不輪詢、待主控留言）；新免費池 7 個 id 尚無評比，恢復排程前先評比與題組。
- **實網測試 N5 之設計**（逐案應然 vs 分流不變式）待使用者裁示；勿短時間重複實跑、勿據短時間觀察改題組。
- **401／403 舊死件回收**維持 2026-10-04 裁示：待恢復排程後之瀏覽器實績再以 `--class http-blocked --untried-browser --limit 50` 驗證。
- **PDF 網址**一輪即 dead；正文抽取 2026-10-31 使用者裁示暫不做（等含排版解析之 PDF 套件成熟、免 AI 判斷結構；CAPX-12）。
- **免費模型實跑**（2026-10-31 起；`tmp/capture-live/run-free.mjs` 於複本 `tmp/standards-audit/live/kb` 跑抓取一輪，領域發現用免費席位）：結果與發現記 `tmp/capture-live/紀錄.md`，問題逐項修。r1：七子階段皆 ok、無 ERROR、正式庫未動；領域發現之兩個 opencode 席位各逾時 300 秒（額度字樣未被認得，已修）。r2（gemini flash 主席）：七子階段 ok、領域發現成交、整輪 280 秒。**使用者 10-31 定調兩階**（專案 `CLAUDE_process.md`〈真實 AI 測試之兩階與席位〉）：第一階＝驗計算與處理流程有效（發布前必做；席位用 agnes／laguna／gemini 等非 opencode 免費家，免費家皆不可用則用 haiku），第二階＝哪種模型有品質與穩定（評比、題組；專案方之事，不擋發布）。後續實跑席位依此，不等 opencode 恢復。**11-01 r3～r6**：r3 gemini 主席、r4 agnes 主席皆七子階段 ok、無問題，領域發現各成交 1 次並各新增一個自動領域（「套利限制」「統計預測評估檢定」）；r5 laguna 主席因每日新增上限略過未呼叫；r6 放寬複本上限（`CAP_LIVE_PERDAY=5`）後 laguna 兩把金鑰皆 HTTP 400、gemini 一次 validation 失敗、agnes 遞補成交並新增 3 領域——第一階「線索→AI 判定→OpenAlex 驗證→領域清單」與三家遞補鏈皆在複本走通。**laguna（Poolside）兩模型於供應商端停用**（直呼回「Model version … is deactivated」，/models 仍列；我方不能啟用；正式庫最後成交 10-04）：第一階席位改以 gemini、agnes 為準；本套件無須改。複本判定工具曾以字面比對正則片段白名單而誤報（r4），已改 RegExp。
- **opencode 免費池已撞總量上限**：本機 `opencode.log` 自 2026-10-30 16:24 起全部免費模型回「Free usage limit reached … subscribe to OpenCode Go」，跨每日 08:00 重置仍在（10-31 全日 371 行）；CLI 不失敗返回而等到逾時。套件 `core/ai/poolQuota` 原只認兩種每日額度字樣 → 未偵測 → 每席空耗一次逾時；**已補字樣**（2026-10-31；每日週期起點後第一次仍會空耗一次）。10-31 23:3x 再探：登入態（`auth.json` 之 OpenCode 憑證）與匿名同被擋、新上架之 flint-40b-free 亦同——限額由 OpenCode Console 伺服端按帳號計，大小與重置未文件化（GitHub anomalyco/opencode #59387、#60297：多人回報跨日不重置；官方對策只有等重置、訂閱 Go US$10/月、或改接他家）。**不列待決**：測試依上條兩階改用非 opencode 席位；opencode 恢復時再把其免費 id 納回評比（第二階）。
- **命令列用法字串仍為舊路徑**（2026-11-01 重整後）：`bench/areaBench.mjs`、`bench/benchKit.mjs`、`bench/benchRoles.mjs` 之用法輸出與預設 `cli.command` 仍印 `node bench/cli.mjs`，本套件實際為 `node src/bench/cli.mjs`（測試 `unit-bench-kit` 釘住預設字串，改字串屬行為改動，待裁示後與測試一併改）；`README` §13 已寫正確指令。
- **JSDoc `@example` 之驗證程度**：`src/` 419 個匯出函數皆有 `@example`；其中 2026-11-01 補入之約 150 則皆實際執行並與 `// =>` 逐字相符，其餘為既有範例（含 40 則以 `need test in nodejs.` 起頭之 Node 專用示意，部分引用未宣告之變數，未逐一執行）。
- **`unit-package` 對 `lodash-es/merge.js` 之測試依賴**：測試檔 `import 'lodash-es/merge.js'` 靠 wsemi 帶入之 lodash-es（守門 ⑤ 以 wsemi 自帶者放行）。
- **HOST_PATH 守門收斂（測試件）**：四套件之 package 測試各複製一份 `HOST_PATH` 正則（抓取 `test/unit-package.test.mjs:55`、摘要 :37、關聯 :41、提煉 :54），違反 GEN-19「共用件只一份歸最低使用者」，應收為本套件 `test/tools/` 一份、三套件經 `captureForTest` 取用；且現行只掃磁碟機路徑與 `/Users/`，**宿主名稱（`tai-kns`、`Telegram`）未掃**——規則帳本 GEN-20 ③ 寫會掃，2026-11-01 核對為守門缺口，收斂時一併補。
- **領域發現之提示詞覆寫 ctx 為內聯**（`domain/areaDomain.mjs:94`：kbLabel、domain、contract、defaultPrompt）：10-29 跨套件收斂（GEN-21 ②）之六個 domain 檔未含本套件之 areaDomain，尚未改經 `core/prompts.mjs` 之 `overridablePrompt`／`promptCtxOf`；另案（改時 CAPX-05 之 ctx 契約與 README 同步）。
- 規則帳本五份分檔之逐條核對：**2026-11-01 完成**（報告 `tmp/capture-doc-debt/報告-*.md`、驗收 `驗收.md`）；README 之 10-31 更新已隨 CAPX-10～12 寫入，另由 `unit-package` ⑥ 守沿革字樣。

## 需使用者決定者

- 無（排程恢復、容量、付費遞補不列入；上列待裁示項已在專案記錄）。
