# 規則帳本（w-knowledge-capture）

> **藍圖**：以規則為單位記程式碼須長成什麼樣（附盤點指令、站點全集與判準）。本檔為索引與本套件之鐵則；條目分檔如下表。與現況比對看 `../state/state.md`。
> 規則 ID 沿用專案帳本之編號（GEN／CORE／AI／CAP／CAPX／STD）；新規則在本檔新增節並編號，不再回寫專案檔。
> **路徑基準**（2026-11-01 起原始碼移入 `src/`）：分檔與本檔中的檔案路徑，除明寫 `test/`、`toolg/`、`sgud/`、`g.mjs` 者外，皆相對 `src/`（如 `core/kernel.mjs` 即 `src/core/kernel.mjs`）；盤點指令中的搜尋根 `src` 即原始碼夾；`tmp/…` 之證據夾與 `srcRunner`、`srcSummarize`、`srcRelate`、`srcExtract`、`srcPack` 等屬原宿主專案，不在本套件內（`srcCapture` 為本套件在宿主專案內原本之目錄名）。

## 分檔

| 檔 | 內容 | 來源 |
|---|---|---|
| `rulebook_專案-總則.md` | GEN-01～GEN-22（四模組英文名、機制入套件、設定三層驗證、只放新格式、模組邊界、測試之匯入根、hook 錨點、抓取一律取自本套件、跨套件共用件之歸屬與只一份、匯入指定詞、埠與橋接之使用） | 專案規則帳本 §1（2026-10-30 複製） |
| `rulebook_專案-core.md` | CORE-*、AI-01～11（執行秩序件只經 runnerPackage 取自 w-data-pipeline／w-dispatch-ai／wsemi、AI 調度層只一份：遞補、冷卻、健康、免費池額度、能力預篩、取最後一段合格之 JSON、斷網不計、工作流；md 與 text 之件） | 專案規則帳本 §2 |
| `rulebook_專案-capture.md` | CAP-01～14（子階段序、正文健全閘、瀏覽器分流、判死類別、線索擴充、領域發現、本機網路不通、資料檔形狀、原文保存） | 專案規則帳本 §3 |
| `rulebook_專案-srcCapture.md` | CAPX-01～12（抽提為獨立套件之邊界、領域中立、設定形狀、CLI 不隔離、AI_SCHEMA 八鍵、量測條件；10-31 起 CAPX-10 偵測器陣列注入、CAPX-11 CS5 全掃、CAPX-12 PDF 暫不做） | 專案規則帳本 §12；2026-11-01 逐條核對完成 |
| `rulebook_專案-檢定標準.md` | STD-00～04、07、10、14、22、24～29（框架：四態＋豁免、正體與數字紮根之單一實作、原文另存、待判登錄與檢核紀錄、判定小組、存量處置工具與回退＝撤銷、持久檔語意、核對件一份、單頁執行器一份、已不再違反之結案）＋ STD-09（抓取納入閘） | 專案規則帳本 §11 |

## 本套件之鐵則（各條之細目在分檔）

1. **邊界**（CAPX-01、GEN-17／18）：只 import 自己與 `package.json` 所列套件（無執行殼例外）；執行秩序件只經 `core/runnerPackage.mjs` 取自 w-data-pipeline／w-dispatch-ai／wsemi 之深層路徑（2026-11-01 起，此前為執行殼）；入口以原名轉出（同一實體——執行鎖之行程內登記表只有一份）。`src/` 內之 import：lodash-es 一律單函數路徑、wsemi 一律 `wsemi/src/<函數>.mjs`、其他自有套件走其 `src/` 深層路徑、node 內建模組無前綴（`fs`、`path`，與 `toolg/gDistRollup.mjs` 之剔除清單一致）。守門：`test/unit-package.test.mjs` ①⑤。
2. **領域中立**（GEN-02）：原始碼、README、bench 不含領域詞（詞表 `test/tools/domainTerms.mjs` 單一份，四套件同用）；不提下游工作之名（只稱「下游」）。守門：`unit-package` ②⑥。
3. **AI 調度層只一份**（AI-01～11）：遞補鏈、冷卻、健康降序、免費池額度、能力預篩（逾長帶 `oversize`）、取最後一段合格之 JSON、斷網不計、工作流在 `core/ai/`；宿主只以建構選項（providerPick、exes、persistStore、usageCounter）組裝，不另寫一份。字樣一律「席位」。
4. **設定**（GEN-03）：`capture` 段由本套件 `core/settingsDefault.mjs` 之 `CAPTURE_DEFAULT`／`CAPTURE_SCHEMA` 定義；鍵集、型別、值域於啟動期拋錯，不靜默回預設；頂層只收原給之段。
5. **抓取納入閘**（STD-09）：正文健全閘（最少字數、占位／付費牆樣式、格式雜訊）→ 不合格依原因重試、轉瀏覽器或終態；判死類別 `deadClass` 為結構化欄位（CAP-04）。
6. **共用件之家在本套件**（GEN-19／21／22）：待判登錄 `core/stores/holds.mjs`、存量帳協定 `core/stores/stockLedger.mjs`（先記後寫、seq、壞行即拒）、掃描累計器 `standards/audit.mjs`、總組裝 `core/assemblyKit.mjs`、詞彙 `core/vocab/vocabKit.mjs`、值工具 `core/util/values.mjs`（`cmp`、`strOf`、`strictTextOf`、`checkKeys`／`unknownKeysProblem`）、提示詞 `core/prompts.mjs`、JSONL `core/util/jsonl.mjs`、核心日誌字樣 `logContract.mjs` 之 `CORE_LOG_*`、資料契約 `core/stores/noteFields.mjs`（筆記專有欄位只在宣告模組存取）；測試件 `test/tools/{testKit,sourceScan,historyMarks,memStore,fakeRest,domainTerms,nullLogger}.mjs`。上層經埠／橋接取用；同名異義者改名。
7. **只放新格式**（GEN-04）：無遷移、相容、舊名退路；舊資料由宿主 `tmp/` 一次性工具處理。
8. **先記後寫、回退＝撤銷**（STD-22／25／26）：CS10／CS12 之存量處置先記帳列再寫；回退只還原該次處置改過之單位，現值已非該次結果者報衝突；JSON 帳逐帳驗結構、隔離失敗不假稱成功、預演純讀。
9. **發布面與結構**（2026-11-01 起依自有套件範本 w-knowledge-extract）：原始碼全在 `src/`（主入口 `src/WKnowledgeCapture.mjs`）；`package.json` 之 `main` 指 `dist/w-knowledge-capture.umd.js`（Node 專用 UMD，發布流程產製），**不設 `exports` 與 `files`**——下游以「套件名/src/…」與「套件名/test/tools/…」深層路徑取用，設了即擋掉；發布範圍由 `.npmignore` 定（排除 `sgud`、`CLAUDE*.md`、暫存、`test/*.test.mjs`、`test/fixtures`、`docs`；**保留 `test/tools`**），`CLAUDE*.md` 不入 git；scripts 為 `test` 與 `deploy`；`devDependencies` 為 `w-package-tools`（mocha 隨之安裝）；套件根有 `.editorconfig`／`.eslintignore`／`.eslintrc.js`／`.jsdoc`／`babel.config.js`／`SECURITY.md`／`g.mjs`／`toolg/`。守門：`unit-package` ⑤（2026-10-30 起含 sgud 與 ignore 檔之判準）。
10. **編譯清單與 JSDoc**（2026-11-01）：`toolg/gDistRollup.mjs` 之 `external`／`globals` 自 `src/WKnowledgeCapture.mjs` 靜態追蹤 import 圖（含自有套件 `src` 深層引用）盤點，原則見其檔頭（新增依賴或新引用自有套件之其他深層路徑後須重盤）；`opencc-js/dict/*` 打包不剔除。`src/` 每個匯出之函數須有 JSDoc（說明、`@param`、`@returns`、`@example`），匯出之常數須有說明。

## 盤點指令與判準

| 項 | 指令 | 判準 |
|---|---|---|
| 全套測試 | 自套件根 `npm test`（即 `mocha --parallel "test/*.test.mjs" --timeout 180000`） | 0 失敗；pending 只有真 AI／實網之案（`WK_LIVE_AI`／`WK_LIVE_NET` 未設） |
| 結構與守門 | `unit-package`（邊界①、中立②、package.json 與發布面⑤、舊名與沿革⑥、資料契約⑦）、`unit-core-layers`（core 分層）、`unit-entry`（入口名單）、`unit-domain-terms`（詞表自檢）、`unit-log-contract` | 皆綠 |
| 下游回歸 | 下游三套件（摘要、關聯、提煉）全套＋宿主專案之回歸 | 皆 0 失敗 |
| 免費 AI 能力評分 | `node src/bench/cli.mjs --help`；長跑見 `../proc/process.md` | 用法印出 exit 0 |
| 編譯 | `node toolg/gDistRollup.mjs`，再 `require('./dist/w-knowledge-capture.umd.js')` | 編譯 exit 0；載入不拋、匯出鍵含 `createKnowledgeCapture` 等（與主入口具名匯出同組） |
| 文件 | `node node_modules/jsdoc/jsdoc.js -c .jsdoc`、`node toolg/gDocsExams.mjs` | exit 0、無警告 |
| 按需引入 | `grep -rn "from 'lodash-es'" src toolg g.mjs`、`grep -rn "from 'wsemi'" src toolg g.mjs`、`grep -rn "from 'node:" src toolg g.mjs`（各自分別跑） | 皆無命中（lodash-es 只許 `lodash-es/<函數>.js`、wsemi 只許 `wsemi/src/<函數>.mjs`、內建模組無前綴） |

## 測試清單（`test/`；檔名前綴＝層級：`unit-` 單元、`api-` 需外部資源）

- 核心：`unit-core`、`unit-core-text`、`unit-core-locale`、`unit-core-shared`、`unit-core-layers`、`unit-assembly-kit`、`unit-holds`、`unit-jsonl`、`unit-settings`、`unit-entry`、`unit-package`、`unit-domain-terms`、`unit-log-contract`
- AI 調度：`unit-ai-adapter`、`unit-ai-adapter-ext`、`unit-ai-adapter-workflow`、`unit-ai-json-reply`
- 抓取：`unit-capture-stages`、`unit-capture-object`、`unit-capture-policies`、`unit-capture-standards`、`unit-capture-fetch-checks`、`unit-capture-browser`、`unit-capture-areas`、`unit-capture-netguard`、`unit-capture-refetch`、`unit-capture-fix`、`unit-capture-ops`、`unit-cs10fix`、`unit-cs12fix`、`unit-fetchers`、`unit-siteAdapters`、`unit-rejects`、`unit-flow-capture`、`unit-flow-areas`
- 評分：`unit-bench`、`unit-bench-kit`、`unit-bench-roles`
- 需外部資源（未設旗標即略過）：`api-capture-live`（實網）、`api-area-ai`（真 AI）

## 待補之規則

- 2026-10-31 新增條目在分檔 `rulebook_專案-srcCapture.md`：CAPX-10（健全閘偵測器陣列注入與跨行程規格）、CAPX-11（CS5 全掃、與寫入同一判定）、CAPX-12（PDF 正文抽取暫不做之裁示）。
