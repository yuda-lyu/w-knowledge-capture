# 現況（w-knowledge-capture）— 2026-11-02

> 只記現況，不寫過程（過程在 `../exp/`）。接續工作先讀本檔；完成一項功能或結束一輪工作即更新。規則見 `../rule/rulebook.md`，兩者比對即知尚未做到者。
> 路徑一律為 repo 相對路徑：原始碼 `src/`、測試 `test/`、工具 `toolg/`、範例 `g.mjs`。

## 身分與位置

- npm `w-knowledge-capture`、版本 1.0.1（`package.json`）；主入口 `src/WKnowledgeCapture.mjs`、總組裝 `createKnowledgeCapture`（`src/createKnowledgeCapture.mjs`）、執行期件 `createCaptureRuntime`（`src/captureRuntime.mjs`）、物件 `src/captureObject.mjs`；`main` 為 `dist/w-knowledge-capture.umd.js`（Node 專用 UMD，發布流程產製）。
- 套件佈局（依自有套件範本 w-knowledge-extract）：`src/`（原始碼，子目錄 `core/ stages/ stores/ fetchers/ standards/ domain/ ops/ bench/`）、`test/`（`test/tools/` 輔助件隨 npm 包發布）、`toolg/`（`addVersion`、`modifyReadme`、`cleanFolder`、`gDocsExams`、`gDistRollup`）、`g.mjs`（離線範例，輸出附檔末，README Example 為其複本）、根目錄範本檔（`.editorconfig`、`.eslintignore`、`.eslintrc.js`、`.jsdoc`、`babel.config.js`、`SECURITY.md`、`script.txt`）；`模型評比.csv` 留套件根（bench CLI 之 `--board` 輸出，程式不讀）。`package.json` 不設 `exports`／`files`（下游以深層路徑取 `src/…` 與 `test/tools/…`），且不提供 `.npmignore`：發布範圍依 `.gitignore`（npm 包＝git 版控之內容；`sgud/`、`test/`、`docs/` 皆隨包，`CLAUDE*.md`、暫存不入包）。
- 打包清單（2026-11-02 `npm pack --dry-run`）279 檔：`src/` 81、`test/` 53（含 `test/tools/` 10、測試檔 42、`fixtures/` 1）、`docs/` 110、`sgud/` 16、`toolg/` 5、`dist/` 2、套件根 12；`CLAUDE*.md` 0。`docs/` 約 8.3MB、`test/` 約 1.7MB，皆低於 10MB 門檻（守門 `unit-package` ⑤ 以實際打包清單斷言）。
- 依賴：`dependencies` 為 opencc-js ^1.4.2、w-data-pipeline ^1.0.24、w-dispatch-ai ^1.0.64、w-dwdata-hub ^1.0.25、w-fetch-web ^1.0.30、w-orm-lmdb ^1.0.50、wsemi ^1.9.39（皆與 `src/` 之實際 import 對帳，守門 `test/unit-package.test.mjs` ⑤）；`devDependencies` 為 w-package-tools ^1.1.21（mocha 隨之安裝）。執行秩序件取自 w-data-pipeline、w-dispatch-ai、wsemi，由 `src/core/runnerPackage.mjs` 以深層路徑取用（名稱 createClock→`genClockTZ`、runJsonCli→`execCliJsonFile`、cliFailDetail→`execCliFailDetail`，其餘同名）；`queueAge` 與 `readJson`／`writeFileAtomic` 在本套件 `src/core/util/{queueAge,fileIo}.mjs`。
- 被誰用：下游套件（摘要、關聯、提煉）各經其埠檔以深層路徑取本套件之 `src/…` 與 `test/tools/…`；使用端（宿主專案）以套件取用，抓取即本套件之實作。
- 發布與版號由使用者處理，不列為待辦。

## 結構

| 項 | 狀態 |
|---|---|
| 分層 | `src/core` 內 `util`、`stores`、`ai`、`vocab`、`standards`、`ops`；`test/unit-core-layers.test.mjs` 守 core 分層之明列例外 |
| 共用件（供下游套件取用） | 待判登錄、存量帳協定、掃描累計器、總組裝共用件、詞彙機制、值工具、JSONL、核心日誌字樣、提示詞、測試件皆落本套件（GEN-19／21／22）；`stockLedger` 之 `seq`、`holds` 先記後寫、回退帳協定（`rollbackPlanOf`／`writeRollback`） |
| 語言設定 `cfg.lang` | `src/core/locale.mjs` 之 `resolveLocale`（GEN-20） |

## 最近驗證

| 日期 | 項 | 結果 |
|---|---|---|
| 2026-11-02 | 發布範圍對齊（刪 `.npmignore`、`unit-package` ⑤ 改判實際打包清單）、bench 用法字串改 `node src/bench/cli.mjs`（`unit-bench*` 釘住）、註解更正（宿主時期措辭、`articles.perRun` 容量式補 `browser.perRun`）後全套 `npm test`（連跑三次） | **1100 ✓、0 ✗、5 pending**（三次同數，與改動前同數）；`node src/bench/cli.mjs --help` 首句印 `node src/bench/cli.mjs`；`npm pack --dry-run` 279 檔（含 `sgud/` 16、`test/tools/` 10，`CLAUDE*.md` 0） |
| 2026-11-01 | sgud 改寫為套件角度（檔名去宿主前綴、移出宿主專屬內容）後全套 `npm test` | **1100 ✓、0 ✗、5 pending**（與改動前同數；sgud 不入測試） |
| 2026-11-01 夜 | 重整為自有套件佈局（原始碼移入 `src/`、補根目錄範本檔與 `toolg/`、`package.json` 依範本、`unit-package` 等結構測試改指 `src/`、`src/` 全部匯出函數補齊 JSDoc〔含 `@example`〕、README 加標頭與 Example）後全套 `npm test` | **1099 ✓、0 ✗、5 pending**（與重整前同數）；`node node_modules/jsdoc/jsdoc.js -c .jsdoc`、`node toolg/gDocsExams.mjs`、`node toolg/gDistRollup.mjs` 皆 exit 0；`require('./dist/w-knowledge-capture.umd.js')` 載入且匯出鍵含主入口全部具名匯出；`g.mjs` 離線可跑 |
| 2026-11-01 晚 | 執行秩序件改取 w-data-pipeline／w-dispatch-ai／wsemi（匯入點換來源、名稱改寫、`fileIo`／`queueAge` 新檔、守門 ①⑤ 改寫、`resolveClockCfg` 收攏無效時區之拋出點）後全套 | **1099 ✓、0 ✗、5 pending** |
| 2026-11-01 | 升版 w-dispatch-ai 1.0.62（目錄下架 3 條、新增 flint-40b-free）後 `src/bench/benchKit.mjs` 之 `DEFAULT_FREE_MODELS` 對齊；`unit-bench`＋`unit-bench-kit` | 52 ✓（全套未重跑） |
| 2026-11-01 | `unit-package`（`poolQuota` 註解去日期、README 改 `rollbackStockHold` 後） | 56 ✓（全套未重跑：本日只改註解與 README） |
| 2026-10-31 | 全套（偵測器陣列注入、CS5 全掃、額度字樣補入後） | **1095 ✓、0 ✗、5 pending**。註：該次驗證後於 `poolQuota.mjs` 補入之註解含日期，`unit-package` ⑥ 於 11-01 失敗 1 案，同日修 |
| 2026-10-30 | 全套（sgud 建立、package 守門增 sgud／ignore 檔判準後） | **1079 ✓、0 ✗、5 pending**（真 AI／實網） |

## 功能現況（對應規則帳本）

| 功能 | 狀態 | 規則／測試 |
|---|---|---|
| 七子階段（hygiene、seedSync、listFetch、detailFetch、docMaintain、expand、areas） | 落地 | CAP-01～14；`unit-capture-stages`、`unit-flow-capture`、`unit-flow-areas` |
| 正文健全閘、瀏覽器分流（Playwright／Camofox）、判死類別、退避 | 落地 | STD-09、CAP-04；`unit-capture-fetch-checks`、`unit-capture-browser`、`unit-capture-policies` |
| 無效文章處置、原文另存（docTexts）、死件回收、剔除清單 | 落地（`src/ops/{reviveDocs,refetchSources,docStockFix}.mjs`、`src/rejects.mjs`） | CAP-13、STD-03；`unit-capture-fix`、`unit-capture-refetch`、`unit-rejects` |
| 本機網路不通之判斷（netGuard） | 落地 | CAP-12；`unit-capture-netguard` |
| AI 調度層（唯一一份）：遞補、冷卻、健康、免費池額度、能力預篩、JSON 取最後一段、斷網不計、工作流 | 落地 | AI-01～11；`unit-ai-adapter*`、`unit-ai-json-reply` |
| 檢定標準 CS1～CS12 之掃描與存量處置（CS10 重複、CS12 線索簡體） | 落地 | STD-09／22／25／26；`unit-capture-standards`、`unit-cs10fix`、`unit-cs12fix` |
| 領域發現（CS8；席位 `capture.discover.ai`） | 落地 | CAP-11；`unit-capture-areas`、`api-area-ai`（真 AI） |
| 健全閘偵測器陣列注入（`capture.standards.detectors`；內建 `GATE_DETECTORS_DEFAULT` 對外；自訂者帶 `module`，瀏覽器子行程依規格重建）；站台 adapter 帶 `module` 者亦達瀏覽器層 | 落地（2026-10-31） | CAPX-10；`unit-capture-browser`、`unit-settings`、`unit-assembly` |
| CS5 來源健康存量全掃（記錄形狀、連敗／連空／零產出與寫入同一判定 `sourceStopReasonOf`） | 落地（2026-10-31） | CAPX-11；`unit-capture-policies`、`unit-capture-standards` |
| 免費 AI 能力評分（`src/bench/`） | 落地；`模型評比.csv` 2026-10-06 由第一輪結果轉出 | GEN-15／16；`unit-bench*` |
| 語言設定 `lang` | 落地（預設 zh-TW，與出現前逐字同） | GEN-20；`unit-core-locale` |
| 自有套件佈局、編譯與文件（`src/`、`toolg/`、`dist` UMD、JSDoc、`g.mjs`、README Example） | 落地（2026-11-01）；`dist/`、`docs/` 由 `script.txt` 流程於發布時產製 | 規則帳本鐵則 9、10；`unit-package` ①⑤ |

## 已知缺口與待辦

- **免費 AI 評比未涵蓋新席位**：`DEFAULT_FREE_MODELS`（`src/bench/benchKit.mjs`）已隨 w-dispatch-ai 目錄對齊，但新免費池之 id 尚無評比（`模型評比.csv` 為 2026-10-06 第一輪結果）；需要時以 bench CLI 重跑評比與題組。
- **實網測試之設計待使用者確認**：`test/api-capture-live.test.mjs` 現行設計為「確定性之案逐案斷言、站方相依之案只斷言分流不變式」，是否定案待使用者確認；勿短時間重複實跑、勿據短時間觀察改題組。
- **預設領域發現席位同屬 opencode 族**：`src/core/settingsDefault.mjs:164` 之 `capture.discover.ai` 預設 `use` 與 `fallback` 皆為 `oc:opencode/…`（同一故障域）；opencode 免費池撞總量上限時（見下條）預設席位即不可用，使用端須自給席位（`cfg.capture.discover.ai`，付費家加於 `fallback` 尾）。
- **STD-01 站點偏差**：領域標籤（`src/stages/areaStage.mjs`、`src/standards/audit.mjs`、`src/standards/cs12Fix.mjs`）與關鍵字／主題線索值（`src/core/stores/frontierPolicy.mjs`）用 `script.fix`／`script.problems`，未經 `withoutForeignSpans`／`fixKeepLinks`；皆為無連結之短文字，結果等價，規則帳本 STD-01 已記為待辦。
- **401／403（http-blocked）舊死件回收**：`src/ops/reviveDocs.mjs` 已支援 `cls`／`untriedBrowser` 篩選；2026-10-04 裁示維持——待瀏覽器階梯有實績後，再以「只取從未經瀏覽器嘗試者」驗證，不預先大量回收。
- **PDF 網址**一輪即 dead；正文抽取 2026-10-31 使用者裁示暫不做（等含排版解析之 PDF 套件成熟、免 AI 判斷結構；CAPX-12）。
- **真實 AI 測試**：第一階（驗流程有效）已以 gemini、agnes 席位走通領域發現與遞補鏈（2026-11-01）；laguna（Poolside）兩模型於供應商端停用（直呼回「Model version … is deactivated」，我方無法啟用），第一階席位以 gemini、agnes 為準，本套件無須改；第二階（哪種模型有品質與穩定）為使用端之事，不擋發布。
- **opencode 免費池已撞總量上限**：自 2026-10-30 16:24 起全部免費模型回「Free usage limit reached … subscribe to OpenCode Go」，跨每日 08:00 重置仍在；CLI 不失敗返回而等到逾時。`src/core/ai/poolQuota.mjs` 原只認兩種每日額度字樣，已補入該字樣（2026-10-31；每日週期起點後第一次仍會空耗一次）。登入態與匿名同被擋、新上架之免費 id 亦同——限額由供應商伺服端按帳號計，大小與重置未文件化。測試改用非 opencode 席位；opencode 恢復時再把其免費 id 納回評比。
- **`docs/` 逼近發布範圍門檻**：`docs/`（JSDoc 產物，隨 `script.txt` 流程於發布時重產）現約 8.3MB；單一資料夾逾 10MB 時，依發布範圍原則須提供 `.npmignore` 排除 `docs/`（首段抄 `.gitignore`、`CLAUDE*.md` 必列、不得列 `sgud`），並同步改 `unit-package` ⑤ 與規則帳本鐵則 9。
- **`sgud/` 隨包公開**：須維持無金鑰、無內網位址、無宿主專名；本套件測試未另守此項（`unit-package` ⑤ 只斷言 `sgud/` 在打包清單內）。
- **JSDoc `@example` 之驗證程度**：`src/` 419 個匯出函數皆有 `@example`；其中 2026-11-01 補入之約 150 則皆實際執行並與 `// =>` 逐字相符，其餘為既有範例（含 40 則以 `need test in nodejs.` 起頭之 Node 專用示意，部分引用未宣告之變數，未逐一執行）。
- **`unit-package` 對 `lodash-es/merge.js` 之測試依賴**：測試檔 `import 'lodash-es/merge.js'` 靠 wsemi 帶入之 lodash-es（守門 ⑤ 以 wsemi 自帶者放行）。
- **宿主痕跡守門之範圍**：`test/unit-package.test.mjs:59` 之 `HOST_PATH` 只掃「磁碟機代號＋反斜線」與 `/Users/` 形之路徑，不含正斜線之磁碟機路徑與使用端專屬名稱；若要守，須擴充該正則並收為 `test/tools/` 一份（下游套件各自之 package 測試另有同款正則，GEN-19 要求共用件只一份歸最低使用者）。
- **領域發現之提示詞覆寫 ctx 為內聯**（`src/domain/areaDomain.mjs:94`：kbLabel、domain、contract、defaultPrompt）：尚未改經 `src/core/prompts.mjs` 之 `overridablePrompt`／`promptCtxOf`（下游套件之 domain 檔已改）；另案（改時 CAPX-05 之 ctx 契約與 README 同步）。

## 需使用者決定者

- 無（上列待裁示項已記於上）。
