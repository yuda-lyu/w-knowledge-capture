# 處理要點 — 抓取:本套件之使用與驗收、設定、維運與日誌

> 本檔記本套件(`w-knowledge-capture`)之開發與驗收做法、使用端如何設定與維運本套件(使用端須知),以及抓取方面之處理要點。規則本身見 `../rule/rulebook_capture.md`、`../rule/rulebook_package.md`;現況見 `../state/state.md`;設定鍵、預設值與維運 API 之完整說明見 `README.md` §5、§11。

## 本套件之使用與驗收

- **邊界**(CAPX-01):本套件只 import 自己的檔案與 `package.json` 所列套件,不 import 使用端或下游套件之程式碼。執行秩序件只經 `src/core/runnerPackage.mjs` 以深層路徑取自 w-data-pipeline／w-dispatch-ai／wsemi,所列之名由主入口 `src/WKnowledgeCapture.mjs` 原名轉出(下游經本套件取得者與來源模組同一實體)。守門:`test/unit-package.test.mjs`(逐檔驗,含「深層路徑只許匯入點引用、與來源模組同一實體」)。
- **抓取之行為與知識全在本套件**(使用者 2026-10-06 裁示「該是抓取的就屬於抓取」):以「行為(寫抓取集合／欄位、抓取端轉移)、知識(規則、常數、字樣、格式、席位、詞彙鍵、預設值)、組裝與推導」三型界定,不以資料夾界定。使用端與下游只呼叫本套件 API:抓取執行期件一律 `createCaptureRuntime`(`src/captureRuntime.mjs`);下游要寫抓取欄位時由抓取 API 產生欄位、與自身欄位合併為一次 patch。**任何處要讀抓取設定或判斷抓取狀態前,先找本套件有無對應 API;沒有就加在本套件**,不在讀取處另寫(如 `captureCapacityOf`、`browserQueueOn`、`browserQueueFields` 皆在 `src/stores/fetchPolicy.mjs`)。
- **測試(一律自套件根)**:`npm test`(即 `mocha --parallel "test/*.test.mjs" --timeout 180000`,約 1 分鐘;通過數與待定數見 `../state/state.md`,待定者為需 `WK_LIVE_*` 開啟之真 AI 與實網案);單檔去掉 `--parallel` 換檔名:`node ./node_modules/mocha/bin/mocha.js --timeout 180000 test/<檔名>`。實網 `WK_LIVE_NET=1`、真 AI `WK_LIVE_AI=1`(燒免費額度,須使用者同意)。**不自他處根直跑**(GEN-09;見 `process_general.md`)。改抓取後,除本套件全套外,另跑下游套件(摘要、關聯、提煉)之測試——它們經主入口與深層路徑取用本套件。
- **免費 AI 能力評分**:`node src/bench/cli.mjs [--models <id,…>|free] [--runs 2] [--out <目錄>] [--concurrency 4] [--tz <時區>] --board 模型評比.csv`(預設 8 個免費模型 × 通用題組 16 案 × 2 回,實測約 25 分;單次報表 CSV／MD／JSON 落 `--out`)。**現況總表 `模型評比.csv`**(套件根;一角色一模型一列,`--board` 併入:本次結果覆蓋同角色同模型之舊列,停測或有未呼叫回合者不寫)。不同角色之列量的是不同能力,不可互比。長跑以 detached 執行(掛在工具呼叫上會被中途終止)。**opencode 免費額度一天約只夠一次全量**(同日再跑以逾時停測收場)。**量測條件**:現附之表於使用端專案目錄下所跑,CLI 讀入了該目錄之指示檔(表內「AI 工作目錄」欄記之,見下條);於專案外重跑屬另案(耗免費額度)。量通用能力時 `--out` 放在沒有指示檔之目錄樹外。
- **CLI 讀取由 CLI 決定**(使用者 2026-10-06 裁示「管線不要做 CLI 隔離,因原本開放給 CLI 就是有讀寫權限,CLI 會讀取哪些基本上就開給 CLI,由 CLI 決定」;CAPX-04):AI 調度層只有本套件一份(`src/core/ai/`),下游經之;它不注入任何改變 CLI 讀取行為之環境變數。背景:opencode CLI 自工作目錄往上讀 AGENTS.md(無則 CLAUDE.md)並讀家目錄之全域指示與技能——AI 工作目錄在某專案下時,模型自述讀到兩檔並以該專案主題作答(`OPENCODE_DISABLE_CLAUDE_CODE=1` 可擋,已實測;依裁示不採用)。
- **使用端須知:併入多工作專案時之 cfg 對應**(使用端以 `createKnowledgeCapture` 跑抓取時用;`README.md` §15「整合進多工作專案」同)。使用端另有設定檔頂層各段者,交給本套件之 cfg 如下:

| 使用端之來源 | 交給本套件之 cfg | 注意 |
|---|---|---|
| `capture` 段 | `capture`(原樣) | 與本套件同一形狀(由本套件 `CAPTURE_SCHEMA` 定義) |
| `ai` 段之 `timeoutMs`／`maxRetries`／`cooldownMs`／`providerTimeouts`／`extraProviders`(＋機制鍵 `pools`／`healthStreak`／`providerLimits`) | `ai` 同名鍵(`AI_SCHEMA` 八鍵;機制鍵預設關) | 使用端專有之 AI 鍵(併發、可用池等)會被拒收,不可整段照傳;可用池與 CLI 路徑等安裝端資產改經 `cfg.aiOptions`(`providerPick`、`exes`、`persistStore`、`usageCounter`) |
| 既有 LMDB 庫名與集合名 | `lmdb.db`、`lmdb.cls` | `cls` 只收本套件之集合(docs、docTexts、sources、frontier、areas、notes) |
| 詞彙表 | `data.vocab` 只取 `domain`、`kbLabel`、`conceptRenames`、`conceptAliases` | 其他鍵拋錯;取子集用 `pickCaptureVocab`(`src/core/vocab/vocabDefault.mjs`) |
| 種子來源、網格主題 | `data.seedSources`、`data.gridTopics` | 標題預篩在 `capture.articles.skipTitlePatterns` |
| 既有 `notes` 集合 | `notes: true` | 領域發現與原文回溯與原管線同口徑 |
| 金鑰檔、時間上限、時區 | `envFile`、`scheduleLimitMin`、`timeZone` | OpenAlex 信箱在 `capture.services.openAlex.mailto`;OpenAlex API 金鑰放金鑰檔(變數名由 `capture.services.openAlex.apiKeyEnv` 指,預設 `OPENALEX_API_KEY`;檔內無此變數則不帶金鑰,易 429) |

- **線索來源**:本套件只消化線索,不從文章產生線索(由下游以 `saveClues` 寫入,見 `README.md` §1)。單獨使用時沒有自我擴充之輸入。

## 抓取(capture)之設定、維運與日誌

- **子階段順序**:hygiene(孤兒瀏覽器回收)→ seedSync(種子來源＋種子領域)→ listFetch(rss 與 grid 分開取名額)→ detailFetch(curl → 健全閘 → 分流 → 瀏覽器階梯／延後 → feed 退路 → 落庫)→ docMaintain → expand(線索探測)→ areas(領域品質回饋、每日至多一次自動發現、投影 `knowledge/areas.md`)。
- **使用端須知:容量自洽**。raw 進料上界＝`capture.articles.perRun`＋`capture.browser.perRun`(瀏覽器名額;分流停用即 `perRun` 為 0 時計 0)＋`capture.areas.perRun`×`capture.sources.itemsPerSource`(grid 摘要直入上界),由 `captureCapacityOf`(`src/stores/fetchPolicy.mjs`)推導,為唯一來源;下游每輪容量須 ≥ 此值,使用端之啟動期檢核與巡檢取用之,不另推導。**方向取偏高**:曾漏計瀏覽器名額而估低,估低會讓真實積壓通過容量檢核。改名額(`articles.perRun`、`browser.perRun`、`areas.perRun`、`itemsPerSource`)前先算此式與下游容量。
- **前提(瀏覽器)**:本機須有系統 Google Chrome(Playwright,經 w-fetch-web)與 Camofox;缺任一 → 日誌 WARN「瀏覽器環境不可用」、該方法每輪斷路、可救件延後且不計失敗次數(使用端巡檢宜列為須見)。`capture.browser.camofox.port` 與同機其他 w-fetch-web 使用者之埠須錯開。`capture.browser.hygiene`(孤兒瀏覽器回收)預設關,開啟會掃整台機器之行程,且只在 Windows 動作(其餘平台回 `skipped`)。
- **維運 API(具名匯出;命令列殼由使用端提供,本套件不附)**:唯讀者可直接對正式庫跑;寫入者由呼叫端負責取執行鎖、備份與同意。
  - **領域**:`setAreaStatus(stores, idOrLabel, 'active'|'paused', { reason, nowIso })`(`src/stores/areaPolicy.mjs`);手動狀態記 `statusBy:'manual'`,種子同步與自動回饋不覆寫(CS7)。新增領域＝改 `data.gridTopics`(下一輪種子同步生效);刪種子＝退役(可逆)。
  - **死件回收**:`reviveDeadDocs(stores, { match, nowIso, dryRun, limit, fetchTries, capture, patchOf })` 與篩選產生器 `deadMatcher({ host, error, cls, untriedBrowser })`(`src/ops/reviveDocs.mjs`)。**`dryRun` 預設 false,呼叫端須自行先以 `dryRun: true` 預演**(列數量、類別分布、樣本)再實寫。回填 `fetchTries` 在給了 `capture` 時預設 `maxTries−1`(只剩一次機會、排隊尾,不以整批舊件壓住隊頭);清當前類別欄、留歷史(`revivedFrom`／`revivedFromClass`／`revives`);現行規則屬瀏覽器類且瀏覽器佇列開啟者直入瀏覽器佇列。判死類別 `deadClass` 見 CAP-04;舊記錄無結構化欄位者類別顯示 `unclassified`,補欄屬使用端之一次性資料遷移(套件不含,GEN-04)。
  - **剔除清單與待辦總表**:`rejectListOf(stores, opt)`(純讀、不取鎖;`src/rejects.mjs`);`rowsToCsv` 轉出帶 BOM(Excel 直接開啟)、`rowsToMd`。類別只讀結構化欄位,缺欄者歸 `unclassified`、不猜——補欄後才有分類。
  - **原文回溯**:`refetchSources(deps, { apply, limit, methods, retry })`(`src/ops/refetchSources.mjs`)。預設只預演(列對象與方法分布),`apply` 才抓與寫;處置帳 `<state>/refetch-sources.jsonl`,重跑略過已處理者。**API 類(`arxiv`、`openalex-doi`)先做**,再 `openalex-title`;**網頁類(article)回溯物是「現在的頁面」,不能證明為當時之材料,下游以原文為材料之判定(如筆記紮根)不得採用**,只供 CS10 段落比對與留存,是否做另議。大量回溯會產生大量網路請求(OpenAlex 帶信箱進禮貌池、arXiv 每次請求間隔 ≥ 3 秒、網頁同主機間隔 ≥ 2 秒),是否執行由呼叫端決定。**OpenAlex 金鑰與額度**:呼叫端傳 `deps.envFile`(`flow.info().envFile`)使 `openalex-doi`／`openalex-title` 帶金鑰;OpenAlex 連續 3 次 429 即停止 OpenAlex 回溯(結果 `quotaStop` 列未處理篇數;遭 429 與未發出請求者不入處置帳,額度於 UTC 00:00 重置後不加 `retry` 直接續跑,見 CAP-16)。
  - **孤兒瀏覽器**:`sweepOrphanBrowsers({ dryRun: true })` 只列不殺(判準同 hygiene 子階段:自家瀏覽器目標且父行程已死;`filter` 可限只回收特定時窗誕生者)。
  - **存量處置(CS10、CS12)**:見 `process_standards.md`。
- **本機網路不通**(CAP-12):每輪抓取開工前探測 `capture.network.probeUrls`(預設取 `capture.services` 三個端點基底之原點;`[]` 不探測),不通 → 輪抓／補全文／擴充略過、領域只略過發現,WARN「<段>：本機網路不通（…），本段略過（不計任何對象之失敗）」;執行中失敗而確認不通 → 該對象不計、本段停止;AI 呼叫整鏈皆敗而確認不通 → 該批不計 tries。**連續多輪出現即查本機網路／代理**;探測端點本身故障時亦會出現此 WARN(少抓,不誤判對象),可暫以 `capture.network.probeUrls` 改指其他端點。
- **資料檔形狀**(CAP-14):`data.seedSources` 每項須含非空 `kind`,且 `url` 與 `name` 至少給一(無 `url` 之虛擬來源以 `kind|name:<名稱>` 為身分);`data.gridTopics` 每項須為 `[標籤, 英文查詢]` 字串對。形狀錯一律建構期拋錯、整輪不執行(此前會在執行期建出垃圾領域或使輪抓失敗)。
- **暫時性失敗之退避**:補全文之 retry 類(HTTP 407／408／425／429／5xx、adapter 暫時性、未知)與線索失敗記 `retryAt`(`capture.articles.retryBackoffHours`:第 n 次失敗後 `本值×4^(n-1)` 小時內不再取;0＝不退避);退避中不取件、不丟;補全文日誌「待抓內文 N 篇（未試 N、重試 N、退避中 N、最舊 N 天），本輪取 N；瀏覽器佇列 N 篇（最舊 N 天）」。
- **實網品質測試**(不燒 AI,但連外網並啟動瀏覽器):`WK_LIVE_NET=1 node ./node_modules/mocha/bin/mocha.js --timeout 180000 test/api-capture-live.test.mjs`;題組預設 `test/fixtures/capture-live-generic.json`(領域中立之公開網址),`WK_LIVE_FIXTURE` 可換。**不可與正式輪次或其他用 Camofox 之行程同時跑**(同埠互借;測試用埠 19437);測完只回收「本測試開始後才誕生」之孤兒瀏覽器。確定性之案(404／410、軟 404)逐案斷言去向;**站方相依之案去向會隨限流、反自動化與時段翻轉,只斷言分流不變式**(raw 須過健全閘且非錯頁、或留瀏覽器佇列、或暫時性失敗依規則重試;不得 dead、不得延後)。**不符時**先看測試印出之「瀏覽器逐階軌跡」是否為站方回應(403、牆頁、協定錯誤);**勿在短時間內重複實跑**(可能觸發站方限流),**不據短時間觀察改題組**——曾一小時內三跑,多案去向兩方向翻轉,據兩次一致改案而第三次即翻回(已還原);確定性之案因站方現況改變而不符時,人工重核該站後更新該案與 `verifiedAt`。
- **日誌字樣契約**:抓取各子階段之日誌字樣與逐輪數字正則由 `src/logContract.mjs` 唯一宣告(`CAPTURE_LOG_KNOWN` 已知常態 WARN、`CAPTURE_LOG_MUST_SEE` 一律須見、`CAPTURE_LOG_PARSE` 逐輪數字、`CAPTURE_REPORT_KEYS` 執行摘要之段名與子階段鍵;核心件之字樣在 `CORE_LOG_KNOWN`／`CORE_LOG_MUST_SEE`),使用端之巡檢取用之、不自寫正則。**改任何日誌或 summary 字樣須同步 `src/logContract.mjs` 與 `test/unit-log-contract.test.mjs`(及 `test/unit-flow-capture.test.mjs` 之 A8c)**。常見字樣:`內文[…] 瀏覽器救回（N 字，<方法>；<階梯>）`、`延後至瀏覽器佇列`、`瀏覽器亦失敗`(常態)、WARN `瀏覽器環境不可用`(須見)、`瀏覽器：試 N、成 N、頁面失敗 N、終態 N、環境失敗 N；延後 N`、`健全閘判 <類>`、`孤兒瀏覽器回收：…`、`種子領域同步：…`、`領域發現：…`;抓取段 summary 尾「｜瀏覽器 N 試 N 成、延後 N｜孤兒回收 N｜領域 新增 N、暫停 N」。
- **PDF**:PDF 網址一輪即 dead(`lastReason: 'pdf'`;CS14 已知限制,正文抽取暫不做,CAPX-12)。
- **保留時間給後段(CAP-17;使用端／組裝者須知)**:同一輪內抓取之後還有其他工作時,組裝者於每輪依賴給 `deps.reserveMs`(毫秒數或 `(ctx) => 毫秒數`;或逐段以 `cfg.stageOpts.<listFetch／detailFetch／docMaintain／expand／areas>.reserveMs` 明給,明給者優先、含 0)。耗時之五段即不吃進該段時間:開工前與每次取件前須「整輪剩餘 − 保留 ≥ 一次作業之估計」,不足即少做、未處理者原樣留下輪(不記次、不退避),`report.detail.reserveDeferred` 記件數(領域發現為 `true`)。巡檢判讀:`left > 0` 而無 `reserveDeferred` ＝ 逾整輪預算(日誌為 WARN「逾時間預算」)或本機網路不通(`netDeferred`);有 `reserveDeferred` ＝ 因保留而少做(日誌為 INFO、字樣含「保留」)。未給保留時行為與無此機制前相同。保留 ≥ 整輪預算時五段皆不開工(每輪只留 INFO,無啟動期警告),屬組裝者設定問題。領域發現另有自有之 25 分鐘下限(`AREA_MIN_REMAINING_MS`),與保留並存。
