# 處理要點（w-knowledge-capture）

> 業務端之特化要求與其處理流程。本檔為索引與要點；細節分檔如下表。
> **路徑基準**（2026-11-01 起原始碼移入 `src/`）：下文與分檔中的檔案路徑，除明寫 `test/`、`toolg/`、`sgud/`、`g.mjs` 者外，皆相對 `src/`（如 `core/kernel.mjs` 即 `src/core/kernel.mjs`）；`tmp/…` 之證據夾屬原宿主專案，不在本套件內。`srcCapture` 為本套件在宿主專案內原本之目錄名。

## 分檔

| 檔 | 內容 | 來源 |
|---|---|---|
| `process_專案-共通.md` | 編排層、執行殼與四套件之變更與驗收流程（宿主專案之視角：避開整點改碼、套件測試自套件根、宿主 run-all、席位核對、prompt 逐字檢查、等整點輪）、四模組英文名、設定對照（舊鍵 → 新鍵）、本專案領域設定所在 | 專案處理要點（2026-10-30 複製） |
| `process_專案-抓取.md` | 本套件之使用與驗收（邊界、測試、免費 AI 能力評分、CLI 讀取由 CLI 決定、單獨使用時之 cfg 對應表、線索來源）＋ 抓取之設定、維運與監看（子階段序、容量公式、瀏覽器前提、領域／死件回收／剔除清單／舊記錄補欄／原文回溯／CS10 存量、本機網路不通、資料檔形狀、退避、實網品質測試、監看字樣） | 專案處理要點 |
| `process_專案-檢定標準運維.md` | 符合度掃描、存量處置之同意流程與回退判準、AI 標準之開啟程序、已開啟之 AI 標準、容量快照、待判、原文回溯 | 專案處理要點 |

## 本套件之鐵則（細目見 `../rule/rulebook.md`）

- 本套件只 import 自己的檔案與 `package.json` 所列套件；**無執行殼例外**（2026-11-01 起執行秩序件取自 w-data-pipeline、w-dispatch-ai、wsemi），只經 `src/core/runnerPackage.mjs` 單一匯入點以深層路徑取用，並由主入口原名轉出。下游三套件（摘要、關聯、提煉）以深層路徑取用本套件之 `w-knowledge-capture/src/…` 與 `w-knowledge-capture/test/tools/…`（故 `package.json` 不設 `exports`／`files`，`.npmignore` 保留 `test/tools`）。
- 領域中立：不含任何領域詞；領域句、稱呼、來源清單由使用方給。
- 只放新格式、新工作流；不含遷移、相容、舊名退路（舊資料之處理一律在宿主端另寫一次性工具）。
- 跨套件共用件之家在本套件（待判登錄、存量帳協定、掃描累計器、總組裝共用件、詞彙機制、值工具、JSONL、核心日誌字樣、測試件）；只一份，上層經埠取用，不另寫。
- 改本套件後：跑本套件全套，再跑下游三套件（摘要、關聯、提煉）與宿主專案之回歸（它們經埠被取用）。

## 結構與工具（2026-11-01 重整為自有套件佈局，範本 w-knowledge-extract）

- 原始碼 `src/`（主入口 `src/WKnowledgeCapture.mjs`，子目錄 `core/ stages/ stores/ fetchers/ standards/ domain/ ops/ bench/` 不變）；測試 `test/`（輔助件 `test/tools/`，隨 npm 包發布）；範例 `g.mjs`（離線、不呼叫真實 AI，輸出附於檔末，README 之 Example 即其複本）；編譯與文件工具 `toolg/`（`addVersion`、`modifyReadme`、`cleanFolder`、`gDocsExams`、`gDistRollup`）；流程腳本 `script.txt`。
- 編譯：`node toolg/gDistRollup.mjs` → `dist/w-knowledge-capture.umd.js`（Node 專用 UMD；`external`／`globals` 之盤點原則見該檔檔頭，**新增依賴或新增對自有套件深層路徑之引用後須重新盤點**）。`opencc-js/dict/*` 打包進 dist（外部化則 UMD 經 `require` 取得命名空間物件而非字串，載入即拋錯）。
- 文件：`./node_modules/.bin/jsdoc -c .jsdoc`（輸出 `docs/`）。`src/` 每個匯出之函數須有 JSDoc（說明、`@param`、`@returns`、`@example`）。
- 發布與 `./dist`、版號由使用者處理，不列為待辦（全域設定 §5.1）。
- 命令列：`node src/bench/cli.mjs …`（免費 AI 能力評分）。程式內之用法字串仍印 `node bench/cli.mjs`（歷史寫法，屬輸出，未改）。

## 測試

- 一律自本套件根跑：`npm test`（即 `mocha --parallel "test/*.test.mjs" --timeout 180000`）；單檔去掉 `--parallel` 換檔名（`node ./node_modules/mocha/bin/mocha.js --timeout 180000 test/<檔名>`）。暫存落 `test/_tmp/`。
- 不連網、不呼叫真實 AI；實網 `WK_LIVE_NET=1`、真 AI `WK_LIVE_AI=1`（另 `WK_AREA_MODELS`、`WK_ENV_FILE`、`WK_LIVE_FIXTURE`）才會，燒額度須使用者同意；實網品質測試不可與正式輪次或其他用 Camofox 之行程同時跑。
- `package.json` 之 scripts 為 `test` 與 `deploy`（`gh-pages -d docs`）；不建 `.mocharc.json`。
- 整合測試需系統 Chrome（沒有時相關案明確失敗，不靜默略過）。

## 要點

- **免費 AI 能力評分**：`node src/bench/cli.mjs [--models …] [--runs 2] --out <套件外目錄> --board 模型評比.csv`；`--out` 必放套件與宿主專案外（CLI 會讀工作目錄上層之指示檔，不是通用能力）；長跑以 detached 執行；opencode 免費池台灣 08:00 重置，一天約只夠一次全量。評比表 `模型評比.csv`（套件根）隨套件發布。
- **CLI 讀取由 CLI 決定**（使用者 2026-10-06 裁示）：調度層不注入任何改變 CLI 讀取行為之環境變數（不做 CLI 隔離）；量通用能力改把工作目錄放套件外。
- **席位**：免費家為首選，付費（sonnet／luna）只當遞補。席位 id 以 `w-dispatch-ai` 目錄為準；目錄漂移（id 下架）時以 Gitea issue 通報 opensrcOper（首例 #25，2026-10-30）。
- **自有套件之來源**（2026-10-28 起）：只發布至私有倉庫 Verdaccio；升版走 update-pks（只更自有套件），升 `w-dispatch-ai` 後對齊席位清單。
- **套件之問題或擴充需求**：改本套件；全域技能或設定之建議走 Gitea issue（全域設定 §13）。
