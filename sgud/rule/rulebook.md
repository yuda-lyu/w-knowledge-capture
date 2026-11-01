# 規則帳本（w-knowledge-capture）

> **藍圖**：以規則為單位記程式碼須長成什麼樣（附盤點指令、站點全集與判準）。本檔為索引與本套件之鐵則；條目分檔如下表。與現況比對看 `../state/state.md`。
> 規則 ID（GEN／CORE／AI／CAP／CAPX／STD）為穩定編號，程式碼註解與測試會引用，**不重編**；新規則在對應分檔新增並編號，已移出者之編號不再使用。路徑一律為 repo 相對路徑（`src/…`、`test/…`、`toolg/…`、`g.mjs`）；盤點指令在套件根執行，以 `git grep` 只搜 git 追蹤檔（過濾範圍與 `.gitignore` 一致）。

## 分檔

| 檔 | 內容 |
|---|---|
| `rulebook_general.md` | GEN-01～04、06、07、09、10、16、18、19（工作英文名、機制在套件領域在使用端、設定三層驗證、只放新格式、模組邊界、hook 錨點全集、測試之匯入根、抓取之行為與知識只在本套件、評分命令列與評分小件、匯入指定詞、跨套件共用件之歸屬與只一份）＋ §2 使用端與下游須知 |
| `rulebook_core.md` | GEN-20～22（泛用套件與語言設定、共用件歸最低使用者、測試件之共用與守門）、CORE-01～05、07、08、10（時間預算、執行期生效值、執行鎖、掛載 fail-loud、例外分帳、身分雜湊、記錄不刪、直接寫檔之範圍）、AI-01～11（AI 調度層只一份：席位檢核、能力預篩、健康、免費池額度、截止歸類、截斷、事件、額度字樣、席位鍵、取最後一段合格之 JSON、開工門檻） |
| `rulebook_capture.md` | CAP-01～15（單一入庫閘門、文件狀態機、標題預篩、失敗分流與 dead、feed 退路、來源計帳、線索、瀏覽器分流、內容健全閘、孤兒瀏覽器、領域清單、本機網路判斷、剔除清單與回收、種子與網格主題形狀、同一內容與錯頁判定） |
| `rulebook_package.md` | CAPX-01～12（套件邊界、預設領域中立、設定與資料錯誤建構期拋錯、CLI 不隔離、提示詞可覆寫、筆記可缺、評分判準、時區、偵測器陣列注入、CS5 全掃、PDF 暫不做） |
| `rulebook_standards.md` | STD-00、01、03、04、07、09、10、14、22、24～26、29（檢定標準框架之抓取段與共用件：正體單一實作、原文另存、待判登錄、抓取納入閘、存量處置工具與回退＝撤銷、持久檔語意、已不再違反之結案）＋ 使用端須知 |

### 已移出（宿主專屬或屬下游套件；編號保留不重編）

本套件 sgud 原自使用端（宿主專案）之規則帳本整段複製，下列條目屬宿主專案之編排層、執行殼或下游套件之內部，不在本套件，已自 sgud 移出（宿主保有原文）：

- GEN-05（宿主執行端之組裝點）、GEN-08（宿主專案之階段要求）、GEN-11～14（摘要、關聯、提煉各套件之邊界與設定）、GEN-17（宿主編排層與各套件之匯入邊界；本套件側已併入 GEN-06②與 GEN-18）；GEN-15 對本套件有用者濃縮為 `rulebook_general.md` §2。
- CORE-06、CORE-09（批次 AI harness、md 讀寫；屬摘要套件）。
- STD-02、27、28（屬下游套件之標準與站點）。

## 本套件之鐵則（各條之細目在分檔）

1. **邊界**（CAPX-01、GEN-06、GEN-18）：只 import 自己與 `package.json` 所列套件（node 內建除外）；執行秩序件只經 `src/core/runnerPackage.mjs` 取自 w-data-pipeline／w-dispatch-ai／wsemi 之深層路徑，入口以原名轉出（同一實體——執行鎖之行程內登記表只有一份）。`src/` 內之 import：lodash-es 一律單函數路徑、wsemi 一律 `wsemi/src/<函數>.mjs`、其他自有套件走其 `src/` 深層路徑、node 內建模組無前綴（`fs`、`path`，與 `toolg/gDistRollup.mjs` 之剔除清單一致）。守門：`test/unit-package.test.mjs` ①⑤。
2. **領域中立**（GEN-02、CAPX-02）：原始碼、README、bench 不含領域詞（詞表 `test/tools/domainTerms.mjs` 單一份，各套件共用）；不提下游工作之名（只稱「下游」）。守門：`unit-package` ②⑥。
3. **AI 調度層只一份**（AI-01～11）：遞補鏈、冷卻、健康降序、免費池額度、能力預篩（逾長帶 `oversize`）、取最後一段合格之 JSON、斷網不計、工作流在 `src/core/ai/`；使用端只以建構選項（`providerPick`、`exes`、`persistStore`、`usageCounter`）組裝，不另寫一份。字樣一律「席位」。
4. **設定**（GEN-03）：`capture` 段由本套件 `src/core/settingsDefault.mjs` 之 `CAPTURE_DEFAULT`／`CAPTURE_SCHEMA` 定義；鍵集、型別、值域於啟動期拋錯，不靜默回預設；頂層只收原給之段。
5. **抓取納入閘**（STD-09）：正文健全閘（最少字數、占位／付費牆樣式、格式雜訊）→ 不合格依原因重試、轉瀏覽器或終態；判死類別 `deadClass` 為結構化欄位（CAP-04）。
6. **共用件之家在本套件**（GEN-19／21／22）：待判登錄 `src/core/stores/holds.mjs`、存量帳協定 `src/core/stores/stockLedger.mjs`（先記後寫、seq、壞行即拒）、掃描累計器 `src/standards/audit.mjs`、總組裝 `src/core/assemblyKit.mjs`、詞彙 `src/core/vocab/vocabKit.mjs`、值工具 `src/core/util/values.mjs`（`cmp`、`strOf`、`strictTextOf`、`checkKeys`／`unknownKeysProblem`）、提示詞 `src/core/prompts.mjs`、JSONL `src/core/util/jsonl.mjs`、核心日誌字樣 `src/logContract.mjs` 之 `CORE_LOG_*`、資料契約 `src/core/stores/noteFields.mjs`（筆記專有欄位只在宣告模組存取）；測試件 `test/tools/{testKit,sourceScan,historyMarks,memStore,fakeRest,domainTerms,nullLogger}.mjs`。下游經主入口與深層路徑取用；同名異義者改名。
7. **只放新格式**（GEN-04）：無遷移、相容、舊名退路；舊資料由使用端另寫一次性工具處理。
8. **先記後寫、回退＝撤銷**（STD-22／25／26）：CS10／CS12 之存量處置先記帳列再寫；回退只還原該次處置改過之單位，現值已非該次結果者報衝突；JSON 帳逐帳驗結構、隔離失敗不假稱成功、預演純讀。
9. **發布面與結構**（依自有套件範本 w-knowledge-extract）：原始碼全在 `src/`（主入口 `src/WKnowledgeCapture.mjs`）；`package.json` 之 `main` 指 `dist/w-knowledge-capture.umd.js`（Node 專用 UMD，發布流程產製），**不設 `exports` 與 `files`**——下游以「套件名/src/…」與「套件名/test/tools/…」深層路徑取用，設了即擋掉；發布範圍依 `.gitignore`（**不提供 `.npmignore`**：npm 包＝git 版控之內容；`sgud/`、`test/`〔含下游取用之 `test/tools`〕、`docs/` 皆隨包，`CLAUDE*.md` 與暫存由 `.gitignore` 排除；只有外部執行檔與單一資料夾 ≥10MB 之非程式碼資料才需 `.npmignore`，本套件兩者皆無），`CLAUDE*.md` 不入 git；scripts 為 `test` 與 `deploy`；`devDependencies` 為 `w-package-tools`（mocha 隨之安裝）；套件根有 `.editorconfig`／`.eslintignore`／`.eslintrc.js`／`.jsdoc`／`babel.config.js`／`SECURITY.md`／`g.mjs`／`toolg/`。守門：`unit-package` ⑤（無 `.npmignore`；`.gitignore` 須列 `CLAUDE*.md` 與暫存、不得排除 `sgud`／`test/tools`；`npm pack --dry-run` 清單含 `sgud/` 與 `test/tools/` 全部檔、不含 `CLAUDE*.md`／`AGENTS*.md`／暫存）。`sgud/` 隨包公開，須維持無金鑰、無內網位址、無宿主專名。
10. **編譯清單與 JSDoc**：`toolg/gDistRollup.mjs` 之 `external`／`globals` 自 `src/WKnowledgeCapture.mjs` 靜態追蹤 import 圖（含自有套件 `src` 深層引用）盤點，原則見其檔頭（新增依賴或新引用自有套件之其他深層路徑後須重盤）；`opencc-js/dict/*` 打包不剔除。`src/` 每個匯出之函數須有 JSDoc（說明、`@param`、`@returns`、`@example`），匯出之常數須有說明。

## 盤點指令與判準

| 項 | 指令 | 判準 |
|---|---|---|
| 全套測試 | 自套件根 `npm test`（即 `mocha --parallel "test/*.test.mjs" --timeout 180000`） | 0 失敗；pending 只有真 AI／實網之案（`WK_LIVE_AI`／`WK_LIVE_NET` 未設） |
| 結構與守門 | `unit-package`（邊界①、中立②、package.json 與發布面⑤、舊名與沿革⑥、資料契約⑦）、`unit-core-layers`（core 分層）、`unit-entry`（入口名單）、`unit-domain-terms`（詞表自檢）、`unit-log-contract` | 皆綠 |
| 下游回歸 | 下游套件（摘要、關聯、提煉）之全套 | 皆 0 失敗 |
| 免費 AI 能力評分 | `node src/bench/cli.mjs --help`；長跑見 `../proc/process.md` | 用法印出 exit 0 |
| 編譯 | `node toolg/gDistRollup.mjs`，再 `require('./dist/w-knowledge-capture.umd.js')` | 編譯 exit 0；載入不拋、匯出鍵含 `createKnowledgeCapture` 等（與主入口具名匯出同組） |
| 文件 | `node node_modules/jsdoc/jsdoc.js -c .jsdoc`、`node toolg/gDocsExams.mjs` | exit 0、無警告 |
| 按需引入 | `git grep -nE "from 'lodash-es'" -- src toolg g.mjs`、`git grep -nE "from 'wsemi'" -- src toolg g.mjs`、`git grep -nE "from 'node:" -- src toolg g.mjs`（各自分別跑） | 皆無命中（lodash-es 只許 `lodash-es/<函數>.js`、wsemi 只許 `wsemi/src/<函數>.mjs`、內建模組無前綴） |

## 測試清單（`test/`；檔名前綴＝層級：`unit-` 單元、`api-` 需外部資源）

- 核心：`unit-core`、`unit-core-text`、`unit-core-locale`、`unit-core-shared`、`unit-core-layers`、`unit-assembly`、`unit-assembly-kit`、`unit-holds`、`unit-stock-ledger`、`unit-jsonl`、`unit-settings`、`unit-entry`、`unit-package`、`unit-domain-terms`、`unit-log-contract`
- AI 調度：`unit-ai-adapter`、`unit-ai-adapter-ext`、`unit-ai-adapter-workflow`、`unit-ai-json-reply`
- 抓取：`unit-capture-stages`、`unit-capture-object`、`unit-capture-policies`、`unit-capture-standards`、`unit-capture-fetch-checks`、`unit-capture-browser`、`unit-capture-areas`、`unit-capture-netguard`、`unit-capture-refetch`、`unit-capture-fix`、`unit-capture-ops`、`unit-cs10fix`、`unit-cs12fix`、`unit-fetchers`、`unit-siteAdapters`、`unit-rejects`、`unit-flow-capture`、`unit-flow-areas`
- 評分：`unit-bench`、`unit-bench-kit`、`unit-bench-roles`
- 需外部資源（未設旗標即略過）：`api-capture-live`（實網）、`api-area-ai`（真 AI）
