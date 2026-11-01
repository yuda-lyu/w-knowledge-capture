# 處理要點（專案複製）— 編排層、執行殼與四套件之變更與驗收

> 自專案 `CLAUDE_process.md` 之〈編排層（src/pipeline）、執行殼（srcRunner）與四套件之變更與驗收〉（含流程、四模組英文名、設定對照、領域設定所在）於 2026-10-30 建 sgud 時整段複製搬入；**未逐條核對是否仍適用**（內含 srcPack 時期之主詞、已結案之待辦與專案專有之路徑）。
> 現況以本套件 `sgud/state/state.md` 與 README 為準；原文仍在專案檔，之後只在本檔增修、不再回寫專案檔。

## 編排層(src/pipeline)、執行殼(srcRunner)與四套件之變更與驗收(2026-10-11 起;此前為 srcPack,已解體)

**背景**:2026-10-11 使用者裁示 srcPack 解體(「4大工作 應該都被抽提出去, 剩下的不應該是套件任務, 故應該合併回原本 src」;終審 `tmp/srcpack-dissolve/終審.md`,規則帳本 GEN-17):
- **執行殼** → 本地套件 `./srcRunner`(暫名 npm `w-task-runner`,入口 `WTaskRunner.mjs`:設定持有、時鐘、日誌、runTask、行程安全網、單例執行鎖、時間預算與截止公式、Telegram、AI 呼叫接線、子進程 CLI)——與 tai-news 共用(tai-news 待使用者發布後切換),不依賴四知識套件與本專案.
- **編排**(四工作之串接與每輪收尾、巡檢、符合度掃描、存量處置、設定合併、詞彙、索引;AI 調度層只在此**組裝**——`src/pipeline/aiAdapter.mjs`)→ 專案 `src/pipeline/`(非套件;總組裝 `createKnowledgePipeline`).
- 四知識套件 `./srcCapture` ← `./srcSummarize` ← `./srcRelate` ← `./srcExtract` 照舊;**抓取套件依賴執行殼**(srcRunner ← srcCapture,只經 `src/core/runnerPackage.mjs`;2026-10-11 srcCapture 審計起).專案(src、test)取五套件**一律經 `src/pipeline/packages/` 之轉接檔**(每套件一支,具名 import——缺名於連結期即拋);鎖、時鐘、日誌、misc、時間預算、runJsonCli 只取自執行殼轉接檔(抓取套件以原名轉出之同名件與之為同一實體,仍不經抓取取用——config 之輕量閉包不得為此載入四套件);`src/config.mjs` 之靜態閉包只含執行殼——以上由 `test/unit-pipeline-imports` 釘住.套件發布為 npm 後只改五支轉接檔之指定詞,一律「套件名/src/入口檔」(`<pkg>/src/<入口>.mjs`;自有套件發布後 main 指 UMD、原始碼在 src/——規則帳本 GEN-18).
- **只有一份之機制(2026-10-11 srcCapture 審計;終審 `tmp/capture-pkg-audit/終審.md`)**:AI 調度層(遞補、冷卻、健康、免費池額度、能力預篩、取最後一段合格之 JSON、斷網不計、工作流)在抓取套件 `src/core/ai/`;執行期生效值 `resolveRuntime`、執行摘要 `runSummary`、總組裝共用件 `assemblyKit` 在抓取套件 `src/core/`——編排層經抓取轉接檔取用,不另寫一份(編排層原有之副本 `src/pipeline/{runtime,runSummary}.mjs`、`src/pipeline/ai/` 已刪).改這些機制改抓取套件,並跑四套件全套＋run-all.
- 各套件只放新格式＋新工作流(2026-10-03 使用者:「srcPack一律就是放新格式新workflow 這邊就是日後直接放到套件的 不要一直把爛掉的東西又移植到套件」——同一原則沿用至各套件):不含舊版相容、舊資料遷移、舊名退路;本專案舊資料之處理一律在 `tmp/` 另寫一次性工具.發布套件是使用者之事(全域規範 §7),不列為待辦.

### 流程

1. **避開整點改碼**(:58～:02 不動 src、各套件與 node_modules——排程輪啟動時一次載入全部模組).
2. **套件測試一律自各套件根**:`npm test`(即 `mocha --parallel "test/*.test.mjs" --timeout 180000`;套件＝srcRunner、srcCapture〔即本套件〕、srcSummarize、srcRelate、srcExtract;單檔去掉 --parallel 換檔名;暫存落各套件之 `test/_tmp/`).**絕不自宿主專案根以 mocha 直跑套件測試檔**:2026-10-04 01:30 如此跑 srcPack 之 `unit-entry`,其逐檔 import 掃到專案之 `src/trigger-run.mjs` 而啟動了一輪正式管線(規則帳本 GEN-09).
3. **宿主專案測試**(屬宿主端,非本套件):宿主專案根之 `node test/tools/run-all.mjs` 全數通過(逐檔執行、任一檔失敗即非 0;末行「N 支測試檔通過」).自執行形式之檔各於結尾「有失敗即拋錯」;**編排層之測試 `test/unit-pipeline-*`(2026-10-11 自 srcPack 移入)保留 mocha 形式**,run-all 以 mocha 單檔跑並取 passing／failing／pending(有 pending 或 0 passing 標 ○).新測試依所在之群之形式寫.`test/unit-flow-config.test.mjs` 以真 settings 組裝,釘住 3+3 席位結構、各席逾時、內建規則含 disputeBoundary、無啟動警告、提煉容量 ≥ 進料.
   - **四模組功能測試(2026-10-03 起)**:`test/unit-capture.test.mjs`／`unit-summarize`／`unit-relate`／`unit-extract` 各以正式 `flowConfig`(真 settings.json、真 vocab、真 `capture.articles.skipTitlePatterns`、真席位形狀)組隔離 flow(workDir 落 `test/_tmp/<案名>-<pid>`、只放受測物件、AI 換腳本化替身;抓取另起本機假站台固定埠 8796 走真 curl／Readability／feed 探測),共用件在 `test/tools/moduleTestKit.mjs`.斷言之報告 summary 格式即巡檢正則之契約——改 summary 格式須同步改測試與 `src/pipeline/patrol.mjs`.
   - **專案測試之共用件(2026-10-12 srcSummarize 審計 P10b、P12b 起)**:專案之測試取套件之共用測試件(詞法器、記憶體集合、假 OpenAI 相容伺服器、日誌之替身、子階段 report 與其斷言、集合之開關、讀 JSON、拋錯之訊息、延遲、可控截止之 ctx、AI 調度層之替身 stubAdapter、抓取整合測試之文件依網址取用 byUrl／docAtOf、證據規則之夾具 QUANT_RULE、提煉 3+3 之提示詞讀法與預設回覆 batchOf／acceptOps／keepAll／echoIntegrate)一律經 `test/tools/captureForTest.mjs`、`summarizeForTest.mjs`、`extractForTest.mjs`(`test/unit-pipeline-imports` ① 只許此三檔取套件之 `test/tools/`);**不得在專案 test/ 自寫副本**(`test/unit-core-copies` 守:四套件與專案之 test/ 皆不得另定義看得到之共用件之名,專案 test/tools 不得留與共用件同名之檔,各 test/tools 之具名匯出一名一檔;同名而語意不同者改名——如假站台 `startSite`、專測 HTTP 之 `mkRestAdapter`、整條管線之替身 `stubPipelineAdapter`、完整文件記錄 `rawDocRecord`).專案特有之件:`moduleTestKit`(四模組功能測試;其 silentLog／recLog／subReport／assertSubStagesOk／withStores 與提煉之四件轉出共用件、tmpRoot 以共用之工廠實例化、stubPipelineAdapter 之 callJson 以 stubAdapter 組成)、`pipelineAiKit`(提煉 3+3 之情境與本專案之調度層組裝 mkPipelineAdapter)、`stubAi`、`promptFixtures`(四工作之提示詞;`renderAllPromptsWith`)、`coverage`(不依賴受測程式碼).題材夾具(unit-capture 之量化題材頁產生器等)屬該檔之資料,不與抓取之中立題材 fakeSite 收斂.
   - **四模組品質測試(會燒額度,須使用者同意)**:`test/api-summarize-quality`／`api-relate-quality`(凍結題組 `data/bench/fixtures.json`＋正式 prompt＋正式席位,門檻用評比指標)與 `api-extract-quality`(自生產庫唯讀取主標籤最多之概念,複製筆記至隔離庫跑一批正式 3+3,驗不變式、紮根率、字形紀律).**未設 `WK_LIVE_AI=1` 一律印「略過」並綠**(run-all 下不呼叫 AI);實跑:`WK_LIVE_AI=1 node test/api-<x>-quality.test.mjs`(提煉者勿經 run-all,其單檔 10 分鐘逾時可能不足);執行鎖存在時自動略過.品質門檻見各檔檔頭.
   - **改 `settings.json` 須知(2026-10-03 起)**:套件對 `ai`／`capture`／`summarize`／`relate`／`extract` 各段以 schema 驗鍵集、型別與值域(capture 段由抓取套件 `src/core/settingsDefault.mjs` 之 `CAPTURE_SCHEMA`、summarize 段由摘要套件 `srcSummarize/core/summarizeSettings.mjs`、relate 段由關聯套件 `srcRelate/core/relateSettings.mjs` 之 `RELATE_SCHEMA`、extract 段由提煉套件 `srcExtract/core/extractSettings.mjs` 之 `EXTRACT_SCHEMA` 定義;ai 段與合併在編排層 `src/pipeline/settingsDefault.mjs`),頂層 cfg 鍵以 `CFG_KEYS` 驗——**打錯鍵、數字寫成字串、區段形狀錯皆於啟動期拋錯、整輪不執行**(此前靜默回套件預設).改完先跑 run-all(unit-flow-config C8 以真 settings 組裝)再等整點.`ai` 段不收 `workspace`(AI 工作目錄固定 `<workDir>/tmp/ai-workspace`,見 config.mjs).
4. **席位核對**:`node src/tools/check-seats.mjs`.
5. **prompt 逐字相同檢查**:`node src/tools/bench-models.mjs list` 之「各角色題目識別」;變了即該角色 prompt 改了——查明是否刻意;若是,該角色既有評比結果失效,需重跑評比.
6. 執行殼(srcRunner)或 tai-news 之執行殼接線變更時:`node src/tools/smoke-tai-news.mjs`,末行須 `SMOKE OK`(依 tai-news 之依賴擇一解析執行殼——有 `w-task-runner` 取之,否則取舊名 `w-knowledge-extract`;沙箱預演加 `--root <沙箱>`,作法見 `tmp/srcpack-dissolve/v7-sandbox.mjs`).套件升版後另跑 `node tmp/verify-pkg-upgrade.mjs`(自有套件之匯入由程式碼盤點,失敗 0 才算過).**自有套件之來源(2026-10-28 起)**:只發布至私有倉庫 Verdaccio(位址見全域設定;npmjs 上之版本不再更新),專案根 `.npmrc` 已設 `registry` 與 `omit-lockfile-registry-resolved=true`;升版走 update-pks(ncu 只更自有套件),升 w-dispatch-ai 後依經驗 §1 對齊五份清單並跑 `check-seats`.
7. **等下一個整點輪**:`log/<day>/<stamp>-run.log` 之「知識管線結束（ok=true｜…」與 `-run.json` 落地.VS Code 外掛內以背景 `until … sleep` 等,不用 cron.
8. **留紀錄**:`CLAUDE_experience.md`【工作紀錄】部.

### 四模組之英文名(2026-10-03 使用者指定,一律統一、不得另創或沿用舊名)

| 中文 | 英文(目錄、settings 之工作段、hook 前綴、物件工廠、欄位;2026-10-06 起設定鍵見下節〈設定對照〉) | 曾用舊名(已全數改掉,不得再出現於 src／test／各套件／settings) |
|---|---|---|
| 抓 | `capture`(`settings.capture`、`createCaptureObject`、hook `capture.*`、`CAPTURE_SCHEMA`;實作在 srcCapture) | fetch |
| 摘要 | `summarize`(`settings.summarize`(`summarize.ai`、`summarize.docsPerCall`、`summarize.charsPerDoc`、`summarize.rounds`…)、`createSummarizeObject`、hook `summarize.triage`／`summarize.summarize`、docs 欄位 `summarizeTries`、狀態 `summarize-failed`、評比角色 `summarize`) | extract(萃取)、organize／彙整(物件層) |
| 關聯 | `relate`(`settings.relate`(`relate.ai`、`relate.rounds`…)、`createRelateObject`、hook `relate.*`) | organizeRounds |
| 提煉 | `extract`(`settings.extract`(`extract.ai = { drafters, integrate, audit, revise, accept }`、`extract.perRun`…)、`createExtractObject`、hook `extract.extract`、notes 欄位 `extractedAt`、失敗帳 `state/extract-attempts.json`、`createExtractDomain`、`extractSeatsProblem`) | distill(`ai.distill`、`distill*`、`distilledAt`、`distill-attempts.json`) |

- 中文一律「抓取／摘要／關聯／提煉」;「彙整」只保留「彙整貼文」(aggregator post)之義、「萃取」只保留 prompt 原文(「你是…的萃取器」,改了即改 prompt 與題目識別).
- **資料層同步**:既有 LMDB 之 `docs.extractTries`→`summarizeTries`、`extract-failed`→`summarize-failed`、`notes.distilledAt`→`extractedAt`、`state/distill-attempts.json`→`extract-attempts.json` 由 `tmp/rename-modules/rename-data.mjs` 改(預設 dry-run;`--apply` 須使用者同意;2026-10-03 盤點:docs 有 extractTries 1,434、notes 有 distilledAt 18,028、舊失敗帳存在).**未改名前不要恢復排程**:套件只認新欄位,舊 `distilledAt` 會被視為未提煉、巡檢對 `extract-failed` 報未知狀態.
- 程式改名工具 `tmp/rename-modules/rename.mjs`(已套用;留作對照),模型評比.csv 之角色標籤已改「摘要(summarize)」(純文字改,未重跑 AI).

### 設定對照(2026-10-06 設定依四大工作改版;舊鍵一律拋錯、不留相容)

**結構**:`settings.json` 頂層＝執行環境(`workDir`、`timeZone`、`envFile`、`schedule`、`lock`、`lmdb`)＋`ai`(四大工作共用之供應商池與併發)＋依序 `capture`、`summarize`、`relate`、`extract`;段內依該工作之要點分組,檢定標準在各段之 `standards` 組(含 `scanEachRun`),AI 席位在用到它的那一組(鍵名 `ai`;判定小組席名 `first`／`second`／`third`).只給想調的鍵,其餘沿用套件預設(組逐鍵合併;席位、樣式陣列給了即整個取代).抓取段之鍵由抓取套件定義(srcCapture `core/settingsDefault.mjs` 之 `CAPTURE_DEFAULT`／`CAPTURE_SCHEMA`)、摘要段由摘要套件(`srcSummarize/core/summarizeSettings.mjs`)、關聯段由關聯套件(`srcRelate/core/relateSettings.mjs` 之 `RELATE_DEFAULT`／`RELATE_SCHEMA`;2026-10-09 起)定義;提煉段由提煉套件(`srcExtract/core/extractSettings.mjs`;2026-10-11 起)定義,ai 段與四段之合併在編排層 `src/pipeline/settingsDefault.mjs`.推導值(各關容量)在 `info().settings.capacity`.規則帳本 GEN-03、AI-09、GEN-10.

| 舊 | 新 |
|---|---|
| `capture.sourcesPerRun`／`itemsPerSource`／`minSourceIntervalMs`／`listTimeoutMs` | `capture.sources.perRun`／`itemsPerSource`／`minIntervalMs`／`listTimeoutMs` |
| `sourcePolicy.*`(maxConsecFails、maxConsecEmpty、cullMinJudged、lowYieldRate、reprobeDays、reprobePerRun、isAutoSource、extraPatchOf) | `capture.sources.*`(同名) |
| `capture.articlesPerRun`／`articleTimeoutMs`／`maxTextChars`／`maxFetchTries`／`retryBackoffHours`／`aggregatorLinksPerDoc`;`cfg.data.skipTitlePatterns` | `capture.articles.perRun`／`timeoutMs`／`maxTextChars`／`maxTries`／`retryBackoffHours`／`aggregatorLinksPerDoc`;`capture.articles.skipTitlePatterns` |
| `capture.browserPerRun`／`browserMaxMs`／`browserNavTimeoutMs`／`camofoxEnabled`／`camofoxPort`／`browserHygiene` | `capture.browser.perRun`／`maxMs`／`navTimeoutMs`／`camofox.enabled`／`camofox.port`／`hygiene` |
| `capture.netProbeUrls`／`netProbeTimeoutMs` | `capture.network.probeUrls`／`probeTimeoutMs` |
| `capture.gridPerRun`／`areaMaxActive`／`areaMinFreshRate`／`openAlexFields`／`gridArxivCategories` | `capture.areas.perRun`／`maxActive`／`minFreshRate`／`openAlexFields`／`arxivCategories`(預設 [];不再「null 沿用」) |
| `knowledge.frontierPerRun`／`frontierMaxPending`;`capture.arxivCategories` | `capture.expand.perRun`／`maxPending`;`capture.expand.arxivCategories` |
| `capture.areaDiscoverEveryHours`／`areaWindowDays`／`areaMinSupport`／`areaMinClueDocs`／`areaCandidatesPerCall`／`areaMinHits`／`areaNewPerDay`／`areaRejectCooldownDays`;`ai.area.executor` | `capture.discover.everyHours`／`windowDays`／`minSupport`／`minClueDocs`／`candidatesPerCall`／`minHits`／`newPerDay`／`rejectCooldownDays`;`capture.discover.ai`(必填;不再沿用摘要席位) |
| `capture.openAlexBase`／`arxivApiBase`／`bingNewsBase`;`cfg.openAlexMailto` | `capture.services.openAlex.base`／`arxiv.base`／`bingNews.base`;`capture.services.openAlex.mailto` |
| `capture.minTextChars`／`minFallbackChars`／`maxSaneChars`／`placeholderPatterns`／`paywallPatterns`／`healthRecheckPerRun`／`paraKeysPerRun` | `capture.standards.*`(同名) |
| `knowledge.standardsScanEachRun` | 各段 `standards.scanEachRun`(抓取套件預設 false、其餘三段 true;本專案四段皆 true) |
| `capture.terminalStatuses` | **移除**(常數 `DOC_TERMINAL_STATUSES`) |
| `ai.summarizeRounds`／`knowledge.docsPerSummarize`／`noteYieldRate`／`ai.summarize.executor`／`knowledge.summarizeCharsPerDoc` | `summarize.rounds`／`docsPerCall`／`yieldRate`／`ai`／`charsPerDoc` |
| `knowledge.triageEnabled`／`ai.triageRounds`／`knowledge.docsPerTriage`／`triageCharsPerDoc`／`triageMaxTries`／`triagePassRate`／`ai.triage.executor` | `summarize.triage.enabled`／`rounds`／`docsPerCall`／`charsPerDoc`／`maxTries`／`passRate`／`ai` |
| `knowledge.materialProblemPatterns`／`formatRefetchMax` | `summarize.refetch.patterns`／`max` |
| `knowledge.retagPerRun`／`retagBatch`／`retagMechanicalPerRun`／`ai.retag.executor` | `summarize.retag.perRun`／`notesPerCall`／`mechanicalPerRun`／`ai` |
| `knowledge.triageConfirm`／`ai.triageConfirm.{executor,third}`;`knowledge.summarizeFaithCheck`／`summarizeFaithMaxTries`／`ai.summarizeCheck.{executor,second,third}`;`knowledge.summarizeRepair` | `summarize.standards.triageConfirm.{enabled, ai.{first,third}}`;`summarize.standards.faithCheck.{enabled, maxTries, ai.{first,second,third}}`;`summarize.standards.repair.enabled` |
| `ai.relateRounds`／`knowledge.relateBatch`／`relateCandidates`／`ai.relate.executor` | `relate.rounds`／`notesPerCall`／`candidatesPerNote`／`ai` |
| `knowledge.relateReversePerRun`／`ai.relateReverse.executor`;`knowledge.relateRotationPerRun` | `relate.reverse.perRun`／`ai`;`relate.rotation.perRun` |
| `knowledge.relateReevalPerRun`／`PagesPerRun`／`Page`／`Apply`／`MaxTries`／`Guard`;`ai.relateReeval.{executor,second,third}` | `relate.reeval.perRun`／`pagesPerRun`／`pageSize`／`apply`／`maxTries`／`guard`;`relate.reeval.ai.{first,second,third}` |
| `knowledge.relateConflictCheck(／PerRun／Page／MaxTries)`;`knowledge.relateEdgeReview(／PerRun／Page／MaxTries／Deadline)`;`ai.relateConflictCheck.{executor,second,third}` | `relate.standards.conflictCheck.{enabled, perRun, pageSize, maxTries}`;`relate.standards.edgeReview.{enabled, perRun, pageSize, maxTries, deadline}`;`relate.standards.ai.{first,second,third}` |
| `knowledge.extractPerRun`／`NotesPerConcept`／`MinNotes`／`MinPending`／`MaxWaitDays`／`CatchupBatches`／`RelateGraceDays`／`SourceCap`／`NoteTries`／`ClaimsCap`／`ConsolidateEvery`／`MinRemainingMs`／`RelationTypes`;`knowledge.categoryFallback`;`ai.extract` | `extract.perRun`／`notesPerConcept`／`minNotes`／`minPending`／`maxWaitDays`／`catchupBatches`／`relateGraceDays`／`sourceCap`／`noteTries`／`claimsCap`／`consolidateEvery`／`minRemainingMs`／`relationTypes`;`extract.categoryFallback`;`extract.ai` |
| `knowledge.extractRecheckSlots`／`PerRun`／`Guard`／`WaitDays`;`extractRelationImpact` | `extract.recheck.slots`／`perRun`／`guard`／`waitDays`;`extract.recheck.relationImpact` |
| `knowledge.extractSupportCheck`／`extractSupportStockPerRun`／`extractOrphanCheckPerRun`／`extractSynonymCheckPerRun`;`knowledge.extractDisputeCheck(／PerRun／MinVersions／WaitDays／MaxTries)`;`ai.extractCheck.{executor,second,third}` | `extract.standards.supportCheck.enabled`／`supportStock.perRun`／`orphanCheck.perRun`／`synonymCheck.perRun`;`extract.standards.disputeCheck.{enabled, perRun, minVersions, waitDays, maxTries}`;`extract.standards.ai.{first,second,third}` |
| `ai.aiParallel`;`knowledge.*Capacity`／`gridInflowMax`／`rawInflowMax` | `ai.parallel`;`capacity.{triage, summarize, relate, extract, gridInflowMax, rawInflowMax}`(唯讀) |

- **席位清單之名稱**(`listSeats`;啟動期檢核、巡檢、`check-seats` 共用):`capture.discover.ai`、`summarize.ai`、`summarize.triage.ai`、`summarize.retag.ai`、`summarize.standards.{triageConfirm,faithCheck}.ai.{first,second,third}`、`relate.ai`、`relate.reverse.ai`、`relate.reeval.ai.{first,second,third}`、`relate.standards.ai.{first,second,third}`、`extract.ai.drafters[0..2]`、`extract.ai.{integrate,audit,revise,accept}`、`extract.standards.ai.{first,second,third}`(null 之選填席位不列).
- **帳檔**:2026-10-06 起新寫入之 `state/relate-*.jsonl` 之 `votes[].seat`／`verdicts[].seat` 為 `'first'`,此前為 `'executor'`(無程式讀回比對;人工讀帳時兩者同義).
- 改版前後之設定值逐鍵對照(`tmp/settings-redesign/compare.mjs`:相同 161、移除 1〔terminalStatuses〕、差異 1〔providerTimeouts 只是鍵序〕).
- **語言設定 `cfg.lang`(2026-10-28 四套件界定審計 S5;規則帳本 GEN-20)**:四套件之總組裝與本專案 `createKnowledgePipeline` 皆收頂層 `lang`(BCP 47 代碼;抓取套件 `core/locale.mjs` 之 `resolveLocale`),決定提示詞之輸出語言句、正體標準(CS12／SS3／RS3／ES3)之適用、概念鍵之繁簡折疊與筆記 slug 之字元政策.**本專案為繁體中文知識庫,settings 不給即預設 `zh-TW`,行為與語言設定出現前逐字相同**(既有提示詞指紋、slug、折疊不變);`conceptFold` 未給時改依語言設定(中文折、其餘不折),`true` 仍強制內建折疊.零件庫用法與產物契約之新選項(子階段 `enabled`／`when`、抓取 `stageOpts.listFetch.onAdmitted`／`collectIds`、`stageOpts.detailFetch.pick`／`timeoutMsOf`、`capture.sources.concurrency`、`capture.standards.sameContent`／`titleMismatch`、`capture.articles.archiveText`、`capture.discover.ai` 可 null、`cfg.aiOptions`;摘要 `domain.contract`、`stageOpts.summarize.sink`、`stageOpts.triage.rank`)皆 opt-in,本專案未使用.
- **摘要／關聯／提煉三套件與 w-knowledge-extract 之設定差異**(原載三套件 README,2026-10-12 移此——套件只寫現行規則;舊專案若以 w-knowledge-extract 之 `settings.<工作>` 原樣給三套件之 `cfg.<工作>`,除下列外皆可):摘要——`summarize.standards.scanEachRun` 預設 false、`summarize.standards.triageConfirm.ai.second` 不收(該席收下卻從未被呼叫)、`ai.providerPick` 不收、`ai.healthStreak` 以值表達預設 3、null 席位只在 `triage.ai`／`retag.ai` 與判定小組各席;關聯——`relate.ai` 預設免費三家、`relate.standards.scanEachRun` 預設 false、席位形狀取抓取套件之 `seatProblem`、`ai` 段只收 `RELATE_AI_SCHEMA`、`relationIndexTitle` 收於頂層(預設 '知識關聯總覽');提煉——`extract.ai` 預設免費三家輪替(起草三席首選各異)、`extract.standards.scanEachRun` 預設 false、席位形狀取 `seatProblem`、新葉 `supportStock.maxTries`／`orphanCheck.maxTries`(預設 3)、`ai` 段只收 `EXTRACT_AI_SCHEMA`(不收 `providerPick`、`parallel`).本專案之 settings 已依四大工作改版(上表),由 `src/pipeline/settingsDefault.mjs` 分段交各套件,不受此差異影響.

### 本專案領域設定在哪(套件領域中立)

- `data/vocab.json` 之 `kbLabel`(知識庫稱呼:prompt 首句、索引標題、巡檢推送標題)與 `guide`(prompt 領域句欄位,套件逐欄回退其中立預設;欄位名打錯或型別不符於建構期拋錯)——**改任何一句即改 prompt,題目識別隨之改變**.證據封頂與自承限制片語在 `basisCaps`／`selfLimitPhrases`,概念改名在 `conceptRenames`、同義在 `conceptAliases`.
- `settings.json` 之 `capture.areas.openAlexFields`／`capture.areas.arxivCategories`／`capture.expand.arxivCategories`(網格 OpenAlex 領域白名單、網格遞補 arXiv 類別、線索探測 arXiv 類別).未給即不限領域——網格會抓進跨領域雜訊.
- **關聯之型別與領域句**(關聯套件預設中立;編排層 src/pipeline 以 `pickRelateVocab(data/vocab.json)` 交之):`relationTypes`／`conflictType`／`fallbackType`、`relationTypeRoles`(implementation 實作範例、extension 延伸深化、sibling 同族策略、complement 互補搭配——RS6 之型別改正封閉清單讀之)、`guide.relate` 四欄(broadRelation「同屬量化交易」、vagueReason「都與交易有關」、changeDrivers「隨時間與市場機制轉換」、implementationCase「一方是另一方之方法或策略的程式實作、回測或應用實例」;extensionCase 未給＝套件預設句,與切換前逐字同)——**改任何一句即改關聯之提示詞**(RS4／RS5／RS6 指紋與 relate 題組識別隨之改變).
- **提煉之提示詞**:用提煉套件 `srcExtract` 內建 extract domain(規則表含「非對立之界線」disputeBoundary;編排層以 `pickExtractVocab(data/vocab.json)` 交之),本專案不注入;規則表之領域句取 `data/vocab.json` 之 `guide.extract` 三欄(ruleTarget、weakEvidence、temporal).要改提煉提示詞:以 `cfg.domains.extract` 注入「`createExtractDomain({ vocab })` 展開後只對個別規則加註」之 domain(不整份覆寫),並先以正式路徑之評比驗證.

---
