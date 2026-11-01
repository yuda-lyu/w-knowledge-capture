# 處理要點（w-knowledge-capture）

> 本套件之開發、驗證與使用端須知之處理流程。本檔為索引與要點；細節分檔如下表。路徑一律為 repo 相對路徑（`src/…`、`test/…`、`toolg/…`、`g.mjs`）。

## 分檔

| 檔 | 內容 |
|---|---|
| `process_general.md` | 命名（GEN-01）、測試入口（GEN-09）、設定須知（GEN-03／04）、領域由使用端給（GEN-02） |
| `process_capture.md` | 本套件之使用與驗收（邊界、測試、免費 AI 能力評分、CLI 讀取由 CLI 決定、併入多工作專案時之 cfg 對應表、線索來源）＋ 抓取之設定、維運 API 與日誌（子階段序、容量自洽、瀏覽器前提、領域／死件回收／剔除清單／原文回溯／孤兒瀏覽器、本機網路不通、資料檔形狀、退避、實網品質測試、日誌字樣契約） |
| `process_standards.md` | 檢定標準：符合度掃描、存量處置工具（CS10、CS12）之使用判準與回退、AI 標準之開啟、待判 |

## 本套件之鐵則（細目見 `../rule/rulebook.md`）

- 本套件只 import 自己的檔案與 `package.json` 所列套件；執行秩序件取自 w-data-pipeline、w-dispatch-ai、wsemi，只經 `src/core/runnerPackage.mjs` 單一匯入點以深層路徑取用，並由主入口原名轉出。下游套件（摘要、關聯、提煉）以深層路徑取用本套件之 `w-knowledge-capture/src/…` 與 `w-knowledge-capture/test/tools/…`（故 `package.json` 不設 `exports`／`files`，且不提供 `.npmignore`——npm 包依 `.gitignore`，`test/tools` 與 `sgud/` 皆隨包）。
- 領域中立：不含任何領域詞；領域句、稱呼、來源清單由使用端給。
- 只放新格式、新工作流；不含遷移、相容、舊名退路（舊資料之處理由使用端另寫一次性工具）。
- 跨套件共用件之家在本套件（待判登錄、存量帳協定、掃描累計器、總組裝共用件、詞彙機制、值工具、JSONL、核心日誌字樣、測試件）；只一份，下游經主入口與深層路徑取用，不另寫。
- 改本套件後：跑本套件全套，再跑下游套件（摘要、關聯、提煉）之全套（它們經深層路徑取用本套件）。

## 結構與工具（依自有套件範本 w-knowledge-extract）

- 原始碼 `src/`（主入口 `src/WKnowledgeCapture.mjs`，子目錄 `core/ stages/ stores/ fetchers/ standards/ domain/ ops/ bench/`）；測試 `test/`（輔助件 `test/tools/`，隨 npm 包發布）；範例 `g.mjs`（離線、不呼叫真實 AI，輸出附於檔末，README 之 Example 即其複本）；編譯與文件工具 `toolg/`（`addVersion`、`modifyReadme`、`cleanFolder`、`gDocsExams`、`gDistRollup`）；流程腳本 `script.txt`。
- 編譯：`node toolg/gDistRollup.mjs` → `dist/w-knowledge-capture.umd.js`（Node 專用 UMD；`external`／`globals` 之盤點原則見該檔檔頭，**新增依賴或新增對自有套件深層路徑之引用後須重新盤點**）。`opencc-js/dict/*` 打包進 dist（外部化則 UMD 經 `require` 取得命名空間物件而非字串，載入即拋錯）。
- 文件：`./node_modules/.bin/jsdoc -c .jsdoc`（輸出 `docs/`）。`src/` 每個匯出之函數須有 JSDoc（說明、`@param`、`@returns`、`@example`）。
- 發布與 `./dist`、版號由使用者處理，不列為待辦。
- 命令列：`node src/bench/cli.mjs …`（免費 AI 能力評分）。程式內印出之用法字串（`--help`、`cli.command` 預設）同此指令，由 `unit-bench*` 釘住。

## 測試

- 一律自本套件根跑：`npm test`（即 `mocha --parallel "test/*.test.mjs" --timeout 180000`）；單檔去掉 `--parallel` 換檔名（`node ./node_modules/mocha/bin/mocha.js --timeout 180000 test/<檔名>`）。暫存落 `test/_tmp/`。
- 不連網、不呼叫真實 AI；實網 `WK_LIVE_NET=1`、真 AI `WK_LIVE_AI=1`（另 `WK_AREA_MODELS`、`WK_ENV_FILE`、`WK_LIVE_FIXTURE`）才會，燒額度須使用者同意；實網品質測試不可與其他用 Camofox 之行程同時跑。
- `package.json` 之 scripts 為 `test` 與 `deploy`（`gh-pages -d docs`）；不建 `.mocharc.json`。
- 整合測試需系統 Chrome（沒有時相關案明確失敗，不靜默略過）。

## 要點

- **免費 AI 能力評分**：`node src/bench/cli.mjs [--models …] [--runs 2] --out <套件外目錄> --board 模型評比.csv`；`--out` 必放套件外（CLI 會讀工作目錄上層之指示檔，不是通用能力）；長跑以 detached 執行；opencode 免費池台灣 08:00 重置，一天約只夠一次全量。評比表 `模型評比.csv`（套件根）隨套件發布。
- **CLI 讀取由 CLI 決定**（使用者 2026-10-06 裁示）：調度層不注入任何改變 CLI 讀取行為之環境變數（不做 CLI 隔離）；量通用能力改把工作目錄放套件外。
- **席位**：免費家為首選，付費（sonnet／luna）只當遞補。席位 id 以 w-dispatch-ai 目錄為準；目錄漂移（id 下架）時於 w-dispatch-ai 端處理，本套件對齊 `src/bench/benchKit.mjs` 之 `DEFAULT_FREE_MODELS`，升 w-dispatch-ai 後亦須對齊。
