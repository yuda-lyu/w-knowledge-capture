# 處理要點（專案複製）— srcCapture 之使用與驗收、抓取之設定、維運與監看

> 自專案 `CLAUDE_process.md` 之〈srcCapture 之使用與驗收〉與〈抓取之設定、維運與監看〉於 2026-10-30 建 sgud 時整段複製搬入；**未逐條核對是否仍適用**（內含 srcPack 時期之主詞、已結案之待辦與專案專有之路徑）。
> 現況以本套件 `sgud/state/state.md` 與 README 為準；原文仍在專案檔，之後只在本檔增修、不再回寫專案檔。

## srcCapture(抓取之獨立套件,暫名 w-knowledge-capture)之使用與驗收(2026-10-06 起)

**背景**:使用者 2026-10-06 要求「重新抽提[抓取]之功能的程式碼放入 `./srcCapture`,一律不要 import 此處既有程式碼,方便移植至套件;維持通用套件角度、不預設量化;設定與提示詞有預設、可由外部覆寫;內含完整測試、檢定標準與免費 AI 能力評分」.方案 `tmp/capture-extract/方案.md`、全盤 `tmp/capture-extract/全盤.md`.**同日後段起 srcPack 之抓取一律取自 srcCapture**(使用者「srcPack 內抓取(capture) 得直接import srcCapture內函數 , srcPack 內不要自己處理抓取」;單一匯入點 `srcPack/core/capturePackage.mjs`,規則帳本 GEN-10)——**正式管線之抓取即 srcCapture 之實作**;srcPack 不再有 capture 模組,抓取之測試在 srcCapture(srcPack 原抓取測試逐案比對後移除,`tmp/settings-redesign/agents/COV/涵蓋比對.md`).**改抓取一律改 srcCapture**,改完跑 srcCapture 與下游套件(srcSummarize、srcRelate、srcExtract)及專案之測試(2026-10-11 srcPack 解體後,編排層之測試在專案 `test/unit-pipeline-*`).

- **邊界**:srcCapture 只 import 自己的檔案與其 `package.json` 所列套件(依賴實際由專案根 `node_modules` 解析);不 import src／test／data、執行殼與其他本地套件.執行秩序件只經 `core/runnerPackage.mjs` 取自 w-data-pipeline／w-dispatch-ai／wsemi 之深層路徑,所列之名由主入口原名轉出(2026-11-01 起;此前取自執行殼 `w-task-runner`).結構測試 `test/unit-package.test.mjs` ① 逐檔驗(含「深層路徑只許匯入點引用、與來源模組同一實體」)(規則帳本 CAPX-01).
- **抓取之行為與知識全在 srcCapture(2026-10-06 抓取邊界盤查,`tmp/settings-redesign/抓取邊界-盤查.md`;使用者「該是抓取的就屬於抓取」)**:以「行為(寫抓取集合／欄位、抓取端轉移)、知識(規則、常數、字樣、格式、席位、詞彙鍵、預設值)、組裝與推導」三型界定,不以資料夾.編排層與 src 只呼叫其 API(經抓取轉接檔)——抓取執行期件一律 `createCaptureRuntime`;下游要寫抓取欄位時由抓取 API 產生欄位、與自身欄位合併為一次 patch.**任何處要讀抓取設定或判斷抓取狀態前,先找抓取套件有無對應 API;沒有就加在抓取套件**,不在讀取處另寫.收尾跑規則帳本 GEN-10 之 6 條盤點(應得結果寫在該條).
- **測試(一律自套件根)**:`npm test`(即 `mocha --parallel "test/*.test.mjs" --timeout 180000`;2026-10-06 抓取邊界收斂後:799 通過、5 待修＝真 AI 1、實網 4;2026-10-11 srcCapture 審計 P6 後 979 通過、5 待定;2026-11-01 移入 `src/` 後 1099 通過、5 待定,約 1 分鐘);單檔去掉 `--parallel` 換檔名.實網 `WK_LIVE_NET=1`、真 AI `WK_LIVE_AI=1`(燒免費額度).**不自宿主專案根直跑**(同 GEN-09).
- **免費 AI 能力評分**:`node src/bench/cli.mjs [--models <id,…>] [--runs 2] [--out <目錄>] [--concurrency 4] [--tz <時區>] --board 模型評比.csv`(預設 8 個免費模型 × 通用題組 16 案 × 2 回;約 25 分;單次報表 CSV／MD／JSON 落 `--out`).**現況總表 `模型評比.csv`**(一模型一列;`--board` 併入:本次覆蓋同模型、停測或不完整者不寫;2026-10-06 由第一輪結果以 `tmp/capture-extract/make-board.mjs` 轉出,未重跑 AI,與該輪逐模型 CSV 逐欄核對一致).與本專案題組之評比(`bench-models`:摘要、關聯;根目錄之總表 2026-10-09 已刪)量的是不同角色,不可互比.長跑以 detached 執行(範例 `tmp/capture-extract/bench-free.mjs`).**opencode 免費額度一天約只夠一次全量**(同日再跑以逾時停測收場).在本專案目錄下跑,CLI 模型會帶著本專案 CLAUDE.md 作答(下條)——量通用能力時 `--out` 放專案外.
- **CLI 讀取由 CLI 決定(使用者 2026-10-06 裁示「管線不要做 CLI 隔離, 因原本開放給cli就是有讀寫權限 cli會讀取哪些基本上就開給cli, 由cli決定」)**:AI 調度層(2026-10-11 起只剩抓取套件一份,正式管線亦經之)不注入任何改變 CLI 讀取行為之環境變數(規則帳本 CAPX-04).背景:opencode CLI 自工作目錄往上讀 AGENTS.md(無則 CLAUDE.md)並讀 `~/.claude/CLAUDE.md`、`~/.claude/skills`——AI 工作目錄在本專案下時,模型自述讀到兩檔並以本專案主題作答(`OPENCODE_DISABLE_CLAUDE_CODE=1` 可擋,已實測;依裁示不採用).
- **單獨使用 srcCapture 時之對應**(本專案管線不需此表——編排層已直接用其實作;此表供另以 `createKnowledgeCapture` 跑抓取時用;srcCapture README §15「整合進多工作專案」同):

| 專案來源 | 交給 srcCapture 之 cfg | 注意 |
|---|---|---|
| `settings.capture` | `capture`(原樣) | 2026-10-06 設定改版後同一形狀(由抓取套件定義) |
| `settings.ai` 之 `timeoutMs`／`maxRetries`／`cooldownMs`／`providerTimeouts`／`extraProviders`(＋機制鍵 `pools`／`healthStreak`／`providerLimits`) | `ai` 同名鍵(抓取套件之 `AI_SCHEMA` 八鍵;機制鍵抓取預設關) | 本專案專有之 `providerPick`、`parallel`、`exes` 會被拒收,不可整段照傳(此三鍵於本專案由 `src/pipeline/aiAdapter.mjs` 以建構選項交調度層) |
| `settings.lmdb.db`、`settings.lmdb.cl` | `lmdb.db`、`lmdb.cls` | `cls` 只收抓取之集合(docs、docTexts、sources、frontier、areas、notes) |
| `data/vocab.json` | `data.vocab` 只取 `domain`、`kbLabel`、`conceptRenames`、`conceptAliases` | 其他鍵拋錯;取子集用抓取套件之 `pickCaptureVocab`(編排層 `src/pipeline/vocabDefault.mjs` 之 `captureVocabOf` 即經之) |
| `data/seed-sources.json`、`data/grid-topics.json` | `data.seedSources`、`data.gridTopics` | 標題預篩在 `capture.articles.skipTitlePatterns` |
| 既有 `notes` 集合 | `notes: true` | 領域發現與原文回溯同管線口徑 |
| `ENV_FILE`、`scheduleLimitMin()`、`TIME_ZONE` | `envFile`、`scheduleLimitMin`、`timeZone` | OpenAlex 信箱在 `capture.services.openAlex.mailto` |

- 原驗收腳本 `tmp/capture-extract/quant-override.mjs`(比對兩份實作之設定與提示詞)屬抓取兩份實作並存時期,未隨改版更新——抓取已只有一份實作,**勿再用**;跨套件之提示詞等價改由 `test/api-standards-ai`(CS8 提示詞指紋)把關.
- **線索來源**:srcCapture 只消化線索,不從文章產生線索(管線由摘要之 noteStage 以 `saveClues` 寫入,經 capturePackage 取用).單獨使用時沒有自我擴充之輸入.

---


---

## 抓取(capture)之設定、維運與監看(2026-10-04 起;方案與三審 `tmp/capture-audit/終審.md`)

- **子階段順序**:hygiene(孤兒瀏覽器回收)→ seedSync(種子來源＋種子領域)→ listFetch(rss 與 grid 分開取名額)→ detailFetch(curl → 健全閘 → 分流 → 瀏覽器階梯／延後 → feed 退路 → 落庫)→ docMaintain → expand(線索探測)→ areas(領域品質回饋、每日至多一次自動發現、投影 `knowledge/areas.md`).
- **設定(settings.capture)**:瀏覽器 `capture.browser.perRun` 12(0＝停用)、`capture.browser.maxMs` 240000、`capture.browser.navTimeoutMs` 20000、`capture.browser.camofox.enabled` true、`capture.browser.camofox.port` 19417(與 tai-news 之 19377 分開);健全閘 `capture.standards.minTextChars` 300、`capture.standards.placeholderPatterns`／`paywallPatterns`(追加樣式 [{p,f}]);`capture.browser.hygiene` true(套件預設 false);grid 名額 `capture.areas.perRun` 4;領域 `capture.discover.newPerDay` 2、`capture.areas.maxActive` 60(其餘用套件預設).**容量**:raw 進料上界＝`capture.articles.perRun`＋`capture.browser.perRun`(瀏覽器名額;分流停用為 0)＋`capture.areas.perRun`×`capture.sources.itemsPerSource`(本專案 90＋12＋32＝134;抓取套件 `captureCapacityOf` 推導,啟動期檢核與巡檢同此式——2026-10-06 前漏計瀏覽器名額而為 122)須 ≤ 預篩容量,放行量(×0.5＝67)須 ≤ 摘要容量 72——改名額先算這兩條.
- **前提**:本機須有 Google Chrome(Playwright 以 `channel:'chrome'` 用系統 Chrome)與 Camofox(`@askjo/camofox-browser` 已裝);缺任一 → 日誌 WARN「瀏覽器環境不可用」、該方法每輪斷路、文件延後不計次(巡檢列為須見).
- **維運**:
  - 領域:`node src/tools/areas.mjs`(列出)／`pause <id或標籤> [--reason 文字]`／`resume <id或標籤>`(取執行鎖;手動狀態記 manual,種子同步與自動回饋不覆寫).新增領域＝改 `data/grid-topics.json`(下一輪種子同步生效);刪種子＝退役(可逆).
  - 死件回收:`node src/tools/revive-dead.mjs (--host <主機> | --error <字串> | --class <判死類別,…>) [--untried-browser] [--limit N] [--tries N] [--apply] [--force] [--workdir <dir>]`(--workdir 對複本預演;解析後即正式庫者照取鎖——各工具共用 `src/config.mjs workDirOf`,規則帳本 OPS-02)——**2026-10-05 起預設只預演**(列數量、類別分布、樣本),`--apply` 才寫(取執行鎖);回填 tries 預設上限−1(只剩一次機會、排隊尾);清當前類別欄、留歷史(revivedFrom／revivedFromClass／revives);現行規則屬瀏覽器類者直入瀏覽器佇列.判死類別(`deadClass`)見規則帳本 CAP-04;舊死件須先補欄(下條).瀏覽器分流上線前之舊死件以一次性工具 `tmp/capture-audit/revive-browser.mjs`(已用;401／403 舊死件依 10-04 裁示暫不回收,待恢復排程後之瀏覽器實績——屆時以 `--class http-blocked --untried-browser --limit 50` 先回收 50 篇驗證).
  - **剔除清單與待辦總表**(2026-10-05):`node src/tools/rejects.mjs [--object docs,sources,clues,areas,refetch] [--status …] [--class …] [--host …] [--since 2026-10-01] [--limit N] [--format csv|md --out <檔>] [--workdir <dir>]`(純讀、不取鎖;未給 --out 只印待辦總表、計數表與最近 20 列;csv 帶 BOM 供 Excel).類別只讀結構化欄位,舊記錄顯示 unclassified——補欄後才有分類(下條).
  - **舊記錄補欄**(一次性工具;**正式庫 --apply 須使用者同意**):`node tmp/capture-fix/backfill-old.mjs [--workdir <dir>] [--part skip,dead,notes,dup,sources] [--apply] [--limit N]`(預設預演、輸出 `tmp/capture-fix/backfill-plan.json`;--apply 須明列 --part、逐筆回讀、寫入帳 `backfill-applied-<時刻>.jsonl` 可回退).各部:舊 skip 之 skipKind／dupOf、舊 dead 之 deadClass／httpCode／deadBy、舊摘要筆記之 processedChars＝6,000(SUM-09 前每篇截 6,000 字;**須在原文回溯之前**,否則 SS4 材料被放寬到全文)、錨失效之重複件回 new、補欄後零產出停用不成立之來源重開.**正式庫預演(2026-10-06 00:5x,唯讀)**:skip 22,939(預篩 12,563、非知識 10,211、素材 163、例行 2;無理由 39 維持未知;正式庫無重複 skip)、dead 1,743(http-blocked 1,522——其中未經瀏覽器 1,521、http-final 218、http-transient 2、unknown 1;無碼無原因 7)、筆記 processedChars 18,072(共 18,114)、錨失效之重複 0、重開候選來源 39(共 793 個零產出停用;cullMinJudged 6).計畫 `tmp/capture-fix/backfill-plan.json`(複本之預演另存 `backfill-plan-copy.json`).**套用順序建議**:skip → sources(依補欄後之 skipKind 重算)→ dead → notes(須在原文回溯之前)；各部 `--part <部> --apply`,寫入帳可回退.**複本演練(2026-10-06 01:05)**:全部各部一次套用 42,795 筆、逐筆回讀全過、寫入帳同數;再預演各部 0(冪等);剔除清單 unclassified 只剩無理由 39／無碼 7;`revive-dead --class http-blocked --untried-browser --limit 50` 符合 1,521、取 50(`tmp/capture-fix/全盤.md` §4.2b).
  - **原文回溯(正式庫預演 2026-10-06)**:對象 18,072 篇(網頁 article 7,773、openalex-doi 8,700、arxiv 397、openalex-title 1,202);API 類先做 `--methods arxiv,openalex-doi`(9,097 篇)→ `openalex-title`;網頁類另議(回溯物是現在的頁面,不作 SS4 材料).須在補欄 notes 部之後.
  - **CS10 存量處置(正式庫預演 2026-10-06,B2／B3 修正後)**:`node src/tools/standards.mjs fix CS10` → 341 件;其中將刪之筆記已被核心引用者 8(提煉維護撤其出處,可還原).套用須使用者同意且停排程(`--apply` 先做一致備份).
  - 孤兒瀏覽器(只列不殺):`node src/tools/browser-orphans.mjs`(判準同管線之 hygiene 子階段;實際回收由每輪第一個子階段執行).
- **本機網路不通**(2026-10-05;規則帳本 CAP-12):每輪抓取開工前探測 `capture.network.probeUrls`(預設 Bing／OpenAlex／arXiv 之原點),不通 → 輪抓／補全文／擴充略過、領域只略過發現,WARN「<段>：本機網路不通（…），本段略過（不計任何對象之失敗）」(巡檢必看);執行中失敗而確認不通 → 該對象不計、本段停止;AI 呼叫整鏈皆敗而確認不通 → 該批不計 tries.**連續多輪出現即查本機網路／代理**;探測端點本身故障時亦會出現此 WARN(少抓,不誤判對象)——可暫以 `capture.network.probeUrls` 改指其他端點.
- **資料檔形狀(2026-10-06;規則帳本 CAP-14)**:`data/seed-sources.json` 每項須含非空 `kind`、`url`;`data/grid-topics.json` 每項須為 `[標籤, 英文查詢]` 字串對——形狀錯一律啟動期拋錯、整輪不執行(此前會在執行期建出垃圾領域或使輪抓失敗).改這兩檔後先跑 run-all(unit-flow-config 以真資料組裝).
- **暫時性失敗之退避**:補全文之 retry 類(5xx／429／407、adapter 暫時性、未知)與線索失敗記 `retryAt`(`capture.articles.retryBackoffHours` 6 → 6 時、24 時;0＝不退避);退避中不取件、不丟;補全文日誌「待抓內文 N 篇（未試…、重試…、退避中 N…）」.
- **實網品質測試**(不燒 AI,約 20～40 分):`WK_LIVE_NET=1 node test/api-capture-quality.test.mjs`;執行鎖持有者存活即略過(殘鎖不擋,`moduleTestKit.liveRunLock`);**不可與正式輪次或其他用 Camofox 之行程同時跑**(同埠互借);測完只回收「本測試開始後才誕生」之孤兒瀏覽器.題組 `data/bench/capture-live.json`(凍結)由 `test/tools/make-capture-live-fixture.mjs` 自生產 dead 件抽樣產生——**通常不重跑**(10-04 死件回收後重跑會換掉樣本).**N5 不符時**(2026-10-06 起測試印「瀏覽器逐階軌跡」):先看軌跡是否為站方回應(403、牆頁、協定錯誤),必要時以 `node test/tools/ladder-diag.mjs <網址…>` 單獨跑該網址各階(勿與實網測試或正式輪次同時跑);**勿在短時間內重複實跑**(可能觸發站方限流),**不據短時間觀察改題組**——2026-10-06 一小時內三跑,8／27 案去向翻轉(兩方向),曾據兩次一致改 2 案而第三次即翻回(已還原).N5 之設計(逐案應然 vs 分流不變式)待使用者裁示.
- **監看**(日誌):`內文[…] 瀏覽器救回（N 字，<方法>；<階梯>）`、`延後至瀏覽器佇列`、`瀏覽器亦失敗`(常態)、WARN `瀏覽器環境不可用`(須見)、`瀏覽器：試 N、成 N、頁面失敗 N、終態 N、環境失敗 N；延後 N`、`健全閘判 <類>`(含 `format-noise`)、`孤兒瀏覽器回收：…`、`種子領域同步：…`、`領域發現：…`;抓取段 summary 尾「｜瀏覽器 N 試 N 成、延後 N｜孤兒回收 N｜領域 新增 N、暫停 N」.巡檢近況總覽之「抓取（今日）」「領域」兩行與 ⑧b(瀏覽器佇列積壓).PDF 網址一輪即 dead(lastReason `pdf`;正文抽取待裁示,見規則帳本 §9).

---
