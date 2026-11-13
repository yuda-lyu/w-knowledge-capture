# 累積經驗 — 套件工程(§16、§21、§22、§23、§31、§33)

> 本檔記本套件作為獨立自有套件之工程經驗:測試之 cwd 與匯入即執行、自使用端(宿主專案)抽提時之教訓、設定結構改版、抓取邊界之界定、副本收斂、泛用開源套件之視角(語言設定與契約)。節號沿用原節號;對應規則見 `../rule/rulebook_general.md`(GEN-*)與 `../rule/rulebook_package.md`,現況見 `../state/state.md`。

## 16. 測試之 cwd 與「匯入即執行」

- **事故形狀**:曾自使用端專案根(非套件根)以 mocha 直跑本套件之入口測試(本意只驗入口匯出)。該測試以 `path.resolve('.')`(cwd)為根逐檔 `import()`,於是 import 到使用端之入口腳本——其頂層 await 直接跑了一輪**完整流程**(執行鎖照取、日誌照寫、寫庫、呼叫 AI 一次),約十分鐘後才被停止,殘留已死 pid 之執行鎖。
- **成因**:①套件測試不在套件根執行(為省一次 `env -C` 改從上層跑);②測試以 cwd 為掃描根——匯入即執行之腳本(trigger、CLI、一次性工具)全在掃描範圍內。BFS 順序下,較淺層之入口腳本先於其他檔被匯入並以頂層 await 卡住其後之匯入,否則其他寫庫腳本也會被執行。
- **通則**:會 import 或執行所掃到之檔案者,**根一律取自模組位置**(`path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')`;`unit-entry`、`unit-core-layers`、`unit-package` 皆如此,規則 GEN-09);入口腳本之頂層副作用(頂層 await 跑管線)使「import 它」等於「執行它」。套件測試一律自套件根執行(`npm test`;單檔:`node ./node_modules/mocha/bin/mocha.js test/x.test.mjs`),不依賴當下 cwd——誤 `cd` 後以 cwd 定位之腳本會跑錯對象(曾改跑了 mocha 測試檔,於 `describe is not defined` 即失敗)。
- **盤點**:`git grep -nE "path\.resolve\('\.'\)|process\.cwd\(\)" -- src test`,判準:不得有以 cwd 為掃描／匯入根者(實跑 2 行,皆非掃描根:`src/bench/report.mjs` 顯示相對路徑、`test/unit-bench.test.mjs` 取磁碟根作測試路徑)。

## 21. 自使用端抽提為獨立套件時之經驗

- **opencode CLI 會讀工作目錄上層之指示檔——AI 工作目錄在某專案下,模型就帶著該專案規則作答**:免費 AI 評分(通用題組,提示詞無任何領域字樣)之理由出現與使用端專案領域相關之字句,範圍外題材因此被判「範圍外」;逐模型統計理由提及該領域者各約 2～6 次(每約 32 回),**同一模型改走 REST(`zen:`)則 0／32**——汙染來自 CLI 執行環境而非提示詞。成因:opencode 自工作目錄往上讀 AGENTS.md(無則 CLAUDE.md),另讀 `~/.claude/CLAUDE.md` 與 `~/.claude/skills`;`OPENCODE_DISABLE_CLAUDE_CODE=1` 關閉全部 .claude 相容(其官方 Rules 文件)。**最便宜之探針**:請模型自述「你被給了哪些規則檔、專案主題為何」——不設變數時回報出上層之 CLAUDE.md,設變數後為 none。**使用者裁示不做 CLI 隔離**(CLI 本即開放讀寫,讀哪些檔由 CLI 決定):調度層不干預、不注入該變數(`src/core/ai/adapter.mjs` 檔頭【CLI 讀取哪些檔由 CLI 決定】;`unit-ai-adapter` 之環境傳遞案釘住「不注入」;CAPX-04)。**通則**:評比或判定若會受「模型看到的情境」影響,先確認 CLI 型模型實際讀入什麼,並以 REST 同一模型作對照;量通用能力時把工作目錄放在無指示檔之目錄樹(評分之 AI 工作目錄為 `<--out>/ai-workspace`,`--out` 預設 `./bench-out` 依 cwd 解析——cwd 在有 CLAUDE.md 之專案下即受汙染),不改 CLI 行為。
- **評分要先確認受測環境,再談分數**:在專案目錄下不隔離之分數,就是套件實際之行為;隔離後之分數只供對照。同一模型兩次評分亦會差 1～2 案(每案 2 回之題組,單次分數只能粗分)——換席位前要加回數或重跑。
- **免費池額度一天只夠一次全量評分**:隔離後之第二輪撞當日額度(opencode 日誌 `AI_APICallError: Rate limit`),CLI 不結束、以逾時回報,評分以連 2 回失敗停測。**重跑評分前先算當日已用量**;要修正後重測,先只跑一兩個模型驗證修正,不整批重跑。查限流:`grep -a "timestamp=<UTC 日期>" ~/.local/share/opencode/log/opencode.log | grep -aiE "rate.?limit|FreeUsage"`(勿用 `429` 當關鍵字——會命中時間戳之毫秒)。
- **陣列輸入只驗「是陣列」不驗逐項形狀,解構時字串會被拆成字元**:`gridTopics: ['planetary science']` 建構通過,`for (const [label, query] of …)` 取出 `p`／`l`,建出名為「p」之領域並對外查詢「l」,且把不在清單之既有種子領域退役。**凡以解構取元組之消費點,形狀檢核要在建構期與每個消費點共用同一函數**(`checkGridTopics`／`checkSeedSources`,`src/fetchers/endpoints.mjs`;CAPX-03)。
- **提示詞等價可逐字驗**:使用端改用本套件時,以兩邊領域工廠之 `buildPrompt(同一組候選, 同一組領域)` 比字串(數百字逐字相同),比「看設定對不對」強——設定對而提示詞不同(如詞彙欄位被丟)也抓得到。
- **README 隨套件搬走,使用端之設定對應表與領域詞不放進去**:通用套件之 README 曾寫了以使用端領域為例之設定對應(使用端專屬知識),改為中立領域之範例,對應表留使用端。守門:`unit-package` ② 掃 README、`package.json` 與原始碼不含領域詞(詞表 `test/tools/domainTerms.mjs`,各套件同一份)——詞表只抓得到表內之詞,使用端對應表之「形狀」仍要人審。
- **交付物之結果不能只留在暫存**:評分跑了兩輪,結果只在可隨時清掉之暫存證據夾,套件內沒有 `模型評比.csv`——使用者問「跟 ./模型評比.csv 一致嗎」才發現。改由評分工具 `--board` 產生並更新套件內之現況總表(`mergeBenchBoard`:一角色一模型一列、本次覆蓋同模型之舊列;停測或未完整者不寫、記 AI 工作目錄);既有結果以程式轉出(不重跑 AI),並與該輪逐模型 CSV 逐欄核對(0 不一致)。**凡「評比／測量」類交付,驗收清單要有「結果落在交付物內哪個檔」一格**。
- **逾時之斷言不比毫秒位數**:「逾時三層」測試曾斷言錯誤訊息逐字為「TIMEOUT after 0.2s」,整套並行時偶得 0.199s 而紅——實際逾時＝min(該層值, 剩餘預算),預算自呼叫開始起算,派送前之耗時在負載下吃掉數毫秒。改為解析秒數、以區間判「哪一層生效」(席位 200ms:0.1 < x ≤ 0.2;`unit-ai-adapter` 之 `secOf`)。**凡斷言時間量,判的是落在哪個層級,不是精確值**。

## 22. 設定依工作改版、抓取只有一份實作

- **同一功能兩份實作,一天內就分歧**:抽提後使用端若仍留一份抓取副本,當日即見 AI 調度層之訊息與建構選項、時鐘、文字工具、席位與標題預篩樣式之來源各自不同。抓取只在本套件一份、使用端經單一匯入點取用;**舊副本刪除前先以腳本比對兩邊之匯出名**(全部模組之匯出名可由匯入點取得),主入口名稱不變。
- **測試之「裸設定」在設定搬家後會悄悄測到另一條路**:手寫 stub(如 `settings: { <舊鍵>: { … } }`)之鍵搬走後讀不到 → 預篩被當成停用,斷言失敗(運氣好)或照樣通過(測到不同路徑而不自知)。一律以 `resolveSettings({ 覆寫 })`(`src/core/settingsDefault.mjs`)產完整形狀;程式中為容忍裸設定而加之 `?.` 一併拿掉——容忍裸設定＝讓測試與生產走不同形狀。
- **改設定結構要證明「值沒變」**:新舊兩版設定各解析成完整生效值,依對照表逐鍵比(相同／刻意移除／僅鍵序不同三類),比「看起來搬對了」可靠;搬錯一個節流鍵,管線照跑只是行為變了。改設定路徑或搬遷後亦以「實際送出之提示詞」雜湊核對(見 §19),證明未動任何正式提示詞。
- **詞彙只收子集**:`resolveVocab`(`src/core/vocab/vocabDefault.mjs`)拒絕不認得之鍵,使用端把整份自有詞彙表交給領域工廠即於載入時拋錯。可用鍵見 `CAPTURE_VOCAB_KEYS`;子集規則只寫一處,不在兩處各手寫一份 `{ domain, kbLabel, … }`。
- **改設定結構後,使用端工具以 `?.`＋`??` 讀舊鍵者會靜默退回預設,不會拋錯**:本套件對舊鍵與舊頂層段一律在組裝期拋錯,但使用端工具自己讀 `settings.<舊段>?.x ?? 預設` 這類寫法讀不到就用其預設——零產出門檻由 6 變 20、重開候選數改變而無任何錯誤。改版後以 `git grep -nE "(settings|ST)\.\w+\?\."` 掃使用端之工具腳本,修後以唯讀預演對照先前數字。
- **歸類依功能與資料流,不依名稱聯想**:「預篩、領域發現不都屬於抓取嗎」——摘要端之內容預篩(triage)之判斷對象是「已抓到之原文是否為知識」,失敗時放行交摘要,屬摘要;領域發現產生新的抓取範圍(OpenAlex 查詢、grid 來源),屬抓取(本套件之 `capture.discover`)。依此分段後,兩者在設定中各自落在其工作之下。

## 23. 抓取邊界:以「行為／知識／組裝」界定,不以資料夾

- **以資料夾界定「抽提完成」必漏**:只搬走 `capture/**` 後,使用者指出仍未抽提乾淨。改以三型全檔掃描:**甲 行為**(寫抓取集合／欄位、抓取端轉移)、**乙 知識**(規則、常數、字樣、格式)、**丙 組裝與推導**。初版之漏法:①grep 有命中卻只當數字讀(瀏覽器名額是否大於 0 是分流開關之規則〔現為 `browserQueueOn`〕,不是容量);②軸缺「席位路徑、詞彙鍵集、每輪依賴之鍵、說明文字中之頻率、回收預設值、截斷預設值」這類知識形態;③把整個轉出檔列為合法消費,沒逐函數看;④只看「重複」不驗「語意」(兩份清單相同,但同檔註解說只列有 hook 錨點者,實有子階段無動作鏈——外掛掛上去永不生效,是缺陷)。**通則**:宣告某套件「只取用、不自做」前,把消費端逐檔逐段讀一遍,每段問「這段是對方的行為、知識還是組裝」;盤點指令要按知識形態列軸,不只按函數名。
- **下游要寫上游欄位時:上游 API 回傳欄位,下游合併自身欄位一次寫**:既不讓下游知道上游欄位之意義,也不產生兩次寫入之中間態(席位路徑只在 `core/settingsDefault` 定義、由 `captureSeatsOf` 取用即同理)。存量處置則反過來:上游(`cs10Fix`)先改文件、回傳成功者(`notesToHandle`),下游才刪自己的筆記;舊寫法先刪筆記再改文件,文件改不成時筆記已刪而文件仍為 `noted`。
- **等價驗證要用「改前之真原文」,不憑記憶重寫舊算法**:比對腳本初稿手寫「舊算法」,與實際舊碼有出入(如舊之白名單比記得的長)。改以版本控制取改前檔(或對話紀錄之 Edit 逆序反套重建,每次須恰命中 1 處),新舊並排跑真實庫比對。
- **無動作鏈之子階段收下 tap 會靜默無效**:`hygiene`、`areas` 為機制性子階段,工廠一律拒收 tap／chain(`rejectChainOpts`,`src/core/kernel.mjs`);「有鏈者」之鍵集 `CAPTURE_TAP_STAGE_KEYS` 以測試由各工廠之行為推導(對不存在之錨點拋「無錨點」者即有鏈,`unit-capture-object`),不手列——手列之表會與實作漂移,行為推導不會。
- **測試組裝之靜音日誌不落檔**:`buildTestCapture`(`test/tools/captureTestKit.mjs`)預設日誌是靜音替身,「真實日誌檔以契約正則解析」之測試讀不到檔而紅。驗日誌契約要接真日誌器落檔(`test/tools/testKit.mjs` 之 `fileLogFactory`,內以 `createLogger(..., { echo: false })` 寫檔)。

## 31. 收斂副本:AI 調度層只剩一份

- **「誰在用哪一份」先追到組裝點,再談收斂**:曾有兩份調度層(使用端編排層一份、本套件一份),分歧 27 項,其中一項(斷網不計)在正式管線到不了。收斂前以**差分夾具**(舊＝快照之舊實作、新＝收斂後實作＋正式選項,同一假 REST)逐情境比結果物件全欄、事件序列、狀態檔,差異只准出現事先列好之差異表;舊測試先原樣對新實作跑,失敗逐案對到差異表才准改斷言。
- **持久狀態以依賴注入,套件不知使用端之檔名**:游標與冷卻、逐日用量由使用端之組裝提供 `persistStore`／`usageCounter`(`AI_OPTIONS_KEYS`,`src/core/assemblyKit.mjs`),本層不讀寫固定檔名;驗收以真實狀態檔之**複本**做讀寫往返(游標、冷卻保留、用量追加)才收。
- **跳脫函數合一前先比兩份之語料差異**:剔除清單與評分報表之 `mdCell` 曾各有一洞(一份不處理單獨之 `\r` 與「|」前之反斜線,一份只加倍緊鄰之一個反斜線——「|」前兩個反斜線即成四個,欄界被打壞)。以快照之原函數對新函數跑邊界語料,差異逐項歸類後才收;規則「『|』前之反斜線連續段加倍再加一」以奇偶斷言釘住(GFM 以成對反斜線為跳脫;`src/core/util/table.mjs`、`unit-core` 之 mdCell 案)。
- **審計方案之指示與既有證據衝突時,依證據**:轉接檔之匯入指定詞曾擬改為套件根(依本地 `package.json` 之 `"."`);但自有套件發布後 `package.json` 之 `main` 指 UMD、無 `exports`、原始碼在 `src/`(已存之 tarball),改為套件根會在發布後解析到 UMD。故一律用 `套件名/src/入口檔` 之深層路徑(本套件 `package.json` 不設 `exports`／`files`,下游以 `w-knowledge-capture/src/…` 與 `w-knowledge-capture/test/tools/…` 取用),以 Node 解析器實測(含無別名之對照組),於 `unit-package` 釘住(GEN-18)。**審查者看到的是本地樣貌;發布後之樣貌要另查**。
- **副本守門之去處**:守門之標的消失後不刪守門,換成守新的不變式——執行秩序件只經單一匯入點 `core/runnerPackage.mjs` 取用(`unit-package` ①:鎖之行程內登記表為模組級,副本即互判殘留),即由「守副本一致」改為「守不再長副本」。

## 33. 泛用開源套件之視角(語言設定與契約;GEN-20)

- **每一步都要「預設行為逐字不變」之證據,不是口頭保證**:套件泛化(如輸出語言句)時,golden(提示詞標準檔)、契約測試、快照差分三者缺一即無從證明 opt-in 沒改到既有安裝。例:把提示詞中之「繁體中文」換成語言稱呼變數時,預設語言之分支須逐字保留原句,只有其他語言才用泛化句,否則提示詞指紋與正式席位 A/B 所依之基準即變(`src/core/locale.mjs` 檔頭【預設逐字不變】)。
- **加一個回傳欄位會打到十幾處「鍵集恰為」之斷言**:`locale` 進入 runtime 回傳、每輪依賴、`info()`、domain 成員,本套件與下游共五套件全套跑出 18 個失敗,全是 `deepEqual(Object.keys(...))`——這類斷言是刻意之契約守門(漏列即失敗)。改契約時先 Grep 期望清單再跑,比逐一等失敗省一輪全套:`git grep -nE "Object\.keys\(" -- test`(本套件 21 檔 119 處)。下游讀新鍵時,所有把整份 cfg 交下去之使用端都要補鍵。
- **「字形標準不適用」要列為 NA、不能變 0**:正體標準於非繁體中文時若直接不判,掃描總量歸 0 與「全部合格」在報表上無法區分;逐件列不適用(受檢總量不變、違反 0、合格 0)才看得出是語言設定關掉的。不適用字樣只一份(`SCRIPT_NA_DETAIL`,`src/core/locale.mjs`;`src/standards/audit.mjs` 之 CS12 引用)。
- **語言設定要在最底層解析一次、以物件傳遞,不在各處重解析字串**:`resolveLocale` 回凍結物件 `{ code, label, han, script, slug }`,執行期件解析後放 `deps.locale`,純函數經 `scriptOf(opt.locale)` 取字形政策(未給即預設正體)——既避免各呼叫點各自判語言,也讓測試能以字形政策物件直接注入。`Intl.getCanonicalLocales` 驗代碼、`Intl.DisplayNames` 取表外語言之稱呼,不手列全部語言。

## 37. Chromium 系啟動改經 w-playwright 之遷移經驗(CAPX-13)

- **依上游錯誤「訊息文字」分類者,上游改用固定詞彙後會靜默退化**:`fetchPolicy.isEnvFailure` 以 Playwright 原訊息(`Executable doesn't exist`、`browserType.launch`…)判環境失敗;w-playwright 的對外錯誤只含固定詞彙(`browser launch failed`…)且 w-fetch-web 只回 `err.message`、不帶 `code`,原正則一個都不命中——啟動被拒(含登入守門拒絕)會被當頁面失敗計在文件頭上、三次判死。遷移時要列「哪些地方依訊息文字判斷」並逐一重新取證;測試的訊息**取自 w-playwright 的真實 reject**(`setBrowserTypeForTest` 的替身拋錯 → `launchChromium` reject),不手抄字串,能抓到對方日後改詞彙(版本不符、登入守門無法在不啟動下觸發者才抄原始碼字樣並註明出處)。
- **接線測試走真子行程**:本套件的啟動點在子行程 CLI 內,而 `setBrowserTypeForTest` 只作用於同一行程。作法:`runBrowserCli` 的 `runCli` 注入縫自己 `spawnSync(node, ['--import', 預載件, CLI, …])`,預載件(`test/tools/wpwFakeLaunch.mjs`)在子行程內裝替身、把收到的合併後選項追加到記錄檔再拋錯拒絕啟動——真 CLI、真暫存檔協定、真 w-fetch-web → w-playwright,只有最底層的 BrowserType 是替身。必附對照案(空階 → 替身 0 次)與斷言自檢(`assertGuarded` 對壞物件須拋),否則「替身被呼叫」可能空過。
- **替身一拒絕,階梯行為就變**:預載件拋錯 → 啟動失敗 → (修正 `isEnvFailure` 後)判環境失敗 → `playwright` 方法斷路,同一階梯第二個 playwright 階不再啟動。「兩階各啟動一次」的斷言在修正前為綠、修正後為紅——那正是修正生效的證據;改斷言為斷路語意(`envBroken`、第二階 `skipped: 'env-broken'`),每個階的啟動點改各自一案。
- **修前不得跑真瀏覽器,修前紅要換法**:舊版 w-fetch-web 直接以 playwright 啟動真 Chrome,修前對照不可跑。修前紅取:接線測試因 `w-playwright` 未安裝而載入失敗(`ERR_MODULE_NOT_FOUND`,不啟動任何東西)、`isEnvFailure` 案對舊正則紅(純函數)、`unit-package` ⑤ 對舊 `package.json` 紅。修前基線只跑不啟動真瀏覽器的檔(排除 `unit-flow-capture`)。
- **`dependencies` 對帳規則要有明列例外**:`unit-package` ⑤ 原規定 `dependencies` 皆須被 `src/` import;`w-playwright` 是 dist 打包 w-fetch-web 原始碼後在執行期 require 的外部件(`gDistRollup` 的 `external`),`src/` 不 import。以 `DIST_EXTERNAL_ONLY` 明列(並斷言列者確在 `dependencies`、確不被 `src/` 使用),而不是放寬整條規則。
- **同一依賴樹會有第二份 playwright-core**:Camofox(Firefox 系)自帶 `playwright-core@1.65.0`(頂層),w-playwright 精確釘的 1.64.1 在 `node_modules/w-playwright/node_modules/`;兩者並存屬正常——前者不啟動 Chromium、不受守門約束。盤點 R-PW-ONLY 時只看本套件自己的 import 與宣告,不看 `node_modules` 內的 playwright-core 份數。
