# 累積經驗 — 抓取(§8、§15、§20)

> 本檔記本套件抓取流程之累積經驗:標題層預篩、瀏覽器分流與健全閘與實網驗證、無效文章處置與原文保存。節號沿用原節號;對應規則見 `../rule/rulebook_capture.md`,現況見 `../state/state.md`。

## 8. 標題層預篩(進 AI 之前就攔)

每次 AI 呼叫都是真實請求與數分鐘成本,讓週報／免責聲明／連結彙整佔滿一批,該輪就產不出任何知識。

- `capture.articles.skipTitlePatterns`(預設 `SKIP_TITLE_PATTERNS_DEFAULT`,`src/core/settingsDefault.mjs`;命中者於 `src/stages/detailFetchStage.mjs` 首次即 skip、不送 AI、不走 feed 退路;`unit-capture-stages` 之標題預篩案)只放「**看標題就能百分百確定**」之樣式;判斷不了的仍交 AI,不做過度攔截。
- 除站台專屬樣式外要備一條**泛用型**(如 `\bweekly\s*#?\d+`)——曾有貼文因不符站台專屬樣式而進了 AI 佇列,換回一句「這是匯流貼文」白耗一次額度。套件預設只收通用樣式;安裝端給了 `skipTitlePatterns` 即**整份取代**預設,故自訂時須自行帶入泛用型。

## 15. 抓取:瀏覽器分流、健全閘與實網驗證

- **「抓取成功」不等於拿到文章,而且每種瀏覽器各有盲點**:w-fetch-web 之成功門檻為正文 50 字;Camofox 回的是無障礙快照之合成文字,不經 HTML 判識、不檢 HTTP 狀態——機器人牆照樣「成功」。實見之假救回全是這型:機器人牆頁(「偵測到異常活動…請確認你不是機器人」,兩篇不同文章回同一段 552 字)、Akamai 牆(「flagged this request as exhibiting automated behavior」,兩篇同一段 412 字)、「preview…while we are checking your access」預覽殼 469 字、Chrome 渲染列印頁得數十萬字而開頭是 IAB 同意清單。**健全閘(`src/stores/contentGate.mjs`)必須自帶機器人牆與同意聲明之判準**(`PLACEHOLDER_PATTERNS_DEFAULT`、`CONSENT_MARKERS_DEFAULT`),不能依賴上游判識。**兩篇不同網址回同一段短文**是牆頁之強訊號,但尚未做跨篇比對(可加之判準)。
- **同一規則只寫在一條路徑上,另一條就繞過它**(兄弟路徑不對稱之典型):軟 404(轉址至站台首頁)原只寫在 curl 結果之錨點,瀏覽器結果走另一條路落庫——經 playwright＋`waitForRedirect` 轉到首頁之新聞列表即以「救回」落 raw。已收斂為健全閘之一類(`isSoft404`,單一擁有者),curl／同輪升級／瀏覽器佇列／子行程階梯共用。**新增任何內容判準時,先列出「成功結果有哪幾條路會落庫」,逐一確認**。
- **量閘門型樣式擋不到長頁**:弱樣式只在短正文套用是為了不誤殺長文,但同意聲明可以長到數十萬字;改以「開頭 2,000 字內相異標記 ≥3 種」判(`consentLeadChars`／`consentMinHits`;單一標記於正常文章亦常見,故不以單一樣式判)。
- **瀏覽器階梯之救回率落差大**(凍結題組 `test/fixtures/capture-live-generic.json`,每類不同主機):逾時類與 JS 空殼類救回率高;挑戰頁、meta refresh、401／403 低(約三成以下);curl 失敗類多半是站方或憑證網域錯誤而非頁面問題;Google News 包裝頁經 playwright＋`waitForRedirect` 轉至發布站(curl 對包裝頁回 reason `redirect`,故自然走該階梯)。主機層封鎖(curl 逾時、Camofox 遇 Akamai 牆)瀏覽器救不回;主機級成敗記憶(Crawlee 式)仍延後,以健全閘擋牆頁＋「只剩一次機會」控制浪費。
- **品質代理指標要分語言**:以標題詞覆蓋率判「救回的是不是這篇」,拉丁標題之正確文章 0.71～1.00、錯頁 0.00;中文標題常被改寫,正確文章只有 0.30 上下——同一門檻 0.4 會把正確中文文章誤報為假救回(中日韓改 0.2)。生產之 CS2(`checkTitleBody`,`src/standards/docStandards.mjs`)只判「覆蓋＝0」之確定錯頁,不設比率門檻。**代理指標之門檻須以人工逐篇核對之樣本校準**,不可只看數字就判產品錯或測試錯。
- **實網測試與正式輪次不可共用 Camofox 埠**:兩個行程同埠(預設 19417)會借用彼此之 server 而互殺。`test/api-capture-live.test.mjs` 用專屬埠 19437,並以「本測試開始後才誕生」之時窗限定只回收本測試留下之孤兒;跑實網測試前仍確認無其他抓取輪在用同一埠。
- **Camofox 內容行程會逃過樹狀殺**:server 被 `taskkill /T` 時,內容行程若其父(主瀏覽器)已先退出即不在樹內;故連經子行程 CLI 正常結束之抓取,亦可能留下 `camoufox.exe` 孤兒。回收判準為「歸屬＋父死」、不用年齡,見 `src/core/ops/browserHygiene.mjs` 檔頭(`capture.browser.hygiene`,預設關,由安裝端開啟)。

## 20. 抓取:無效文章處置與原文保存

- **「環境問題不算在對象頭上」要列出每一個計數器遞增點逐一問**:曾只列了 7 個兄弟路徑,再審又找出 7 條漏網——站台 adapter(如 MSN)之 API 逾時帶 adapterId 一輪即 dead、鏈異常共用判死次數、跨輪 curl 前置使瀏覽器環境失敗變計次、feed 只驗長度即放棄延後、暫存檔寫入在 try 外、線索端點故障 2 輪即永久 failed、AI 斷網照計 tries;且當時全程沒有任何斷網判斷(後補 `netGuard`)。**作法**:grep 所有寫 `tries`／`fetchTries`／`failCount`／status `dead`｜`failed` 之處,逐點問「這次失敗可能是本機／端點／程式嗎?」,不是從投訴那條路往外推:`git grep -nE "fetchTries\s*[:=+]|status: 'dead'" -- src`(實跑 32 行,逐點核對)。
- **去重之「錨」必須真的有內容**:同一內容索引不分狀態——dead(抓不到)與 new(還沒抓)之文件也當「既有文件」,後到而抓得到之件被判重複丟棄(同一篇論文之 /pdf/ 一輪 dead 後 /abs/ 即被擋;瀏覽器救回之正文因轉址指向舊死件而丟)。任何「已有同一份 → 略過這份」之判斷,先問「那一份真的取得內容了嗎」;身分去重(同網址)與內容去重(同內容)是兩件事。現行:`stores/contentIndex.mjs` 之 `isContentAnchor`(new、dead、重複 skip 不當錨)。
- **聯集合併不具傳遞性之關係會錯刪**:段落重疊甲乙、乙丙皆達門檻,甲丙可無共同內容;CS10 存量處置若以聯集成群、留一刪其餘,留甲即刪掉不同文章丙。**刪除類處置只動與留存者直接相連者**,其餘列 `deferred`、下輪重判(`ops/docStockFix.mjs` 之 `dupPlanOf`)。
- **下游函數之單元測試抓不到上游之轉換**:「記 feed 原長」之測試直接餵長字串而綠,實際管線中契約層(w-data-pipeline `normalizeItem`)已先截 `maxTextChars`——生產從未記到原長,健全閘之超長判準在 feed 入口失效。修法:契約層不截,記錄層截並記 `feedFullLength`。**每條「記錄某原始量」之規則,至少一條測試走正式入口鏈**(`test/unit-flow-capture.test.mjs` 之 A2／A5:真 rss 抓取器經 curl 讀本機假站台 → listFetch → detailFetch 之 feed 退路)。
- **偵測額度用盡只掃失敗結果之執行層輸出,不掃成功之內文**:曾有派工腳本以限流字樣掃 `error＋stderr＋stdout 末段`,兩份成功且完整之審查回覆因內文引用了「hit your session limit」「HTTP 429」而被標限流。本層 `coolDetect`(`src/core/ai/adapter.mjs`)據此只對**執行層失敗**之 stderr／stdout 掃 `LIMIT_TEXT_RE`,內容型失敗(`validation`、`incomplete`、`tool-unsupported`、`invalid-response`)與截斷不掃——其輸出是模型對輸入之回覆,輸入談到 rate limit／quota 就會誤觸冷卻;評分之失敗歸類(`benchFailOf`)同理只讀失敗結果之 error。誤判方向看似安全(多冷卻一次),但若據此「不再重派」會丟掉有效結果。
- **HTML 原始碼不存之根因在 w-fetch-web**:其解析模式(`parse: true`)只回正文,要另存 HTML 只能每篇多抓一次(流量×2)或由 w-fetch-web 於解析模式同時回傳原始回應——屬自有套件之功能擴充,由其開發者統籌。本套件改存「去重與截斷前之解析全文」(`core/stores/docTexts.mjs` 之 `rawGz`,`rawFrom` 記取得方式,與庫內形態不同時才存)。重抓不能代替當時之快照(頁面會改版、轉址、消失)。
- **另存之完整性以「解壓成功＋內容逐字相同」判,不以雜湊欄**:曾寫「解壓後重算 sha1 須等於記錄之 sha1」,套件測試 4 案失敗——測試自造之另存記錄 sha1 為假值。gzip 自帶 CRC32,資料損毀即解壓失敗,已足以判「可讀」(`archiveIntact`);「是否同一份」改為比對解壓內容。**完整性檢查之依據要選資料本身保證得了的(壓縮校驗),不選旁欄**。
- **「探測過沒」不要用時間戳之真假判**:`netGuard` 曾以 `st.at &&` 判已探測,測試注入之時鐘從 0 起算 → 永遠當沒探測過、每次重探;改用獨立旗標 `probed`。同型陷阱:任何以 0／空字串表「沒有」之欄位,遇到合法之 0 即誤判。
- **測試替身之逾時低於上游最短嘗試 → 未發請求即 `budget exhausted`**:測「整鏈皆敗且斷網 → skipped」時條目逾時給 5 秒,低於上游最短嘗試(20 秒),整鏈直接回預算用盡(本來就 skipped),測不到斷網分支。本層已把開工門檻改為 `min(20 秒, 單次逾時之一半)`(`adapter.mjs` 檔頭【單次嘗試之開工門檻】);`unit-capture-netguard` 仍給 60 秒(本機未監聽埠之連線被拒是瞬間失敗),直接用上游 `dispatchAiFallback` 之測試須給足。
- **刻意改變行為時,受影響之既有測試要逐條改寫並在註解寫明為何改**:一次 30 處行為改變(鏈異常分帳、同批 new 不當錨、回收清欄、retry 語意、回溯保留版本…)使既有測試 19 處失敗;逐條判「刻意改變 → 改測試並註明依據」或「回歸 → 修程式」,不整批改綠。
- **子行程 CLI 若會連到測試行程內之假站台,不可用 `execFileSync`**:同步 spawn 卡住測試行程之事件迴圈,假站台(`test/tools/fakeSite.mjs`)無法回應 → CLI 逾時。改用非同步 `execFile`(Promise 包裝)。
- **外部工具之失敗訊息不可原樣進日誌**:`fetchWebByCurl` 以靜默 curl 執行,連線失敗時 `message` 只是含換行之整串指令(不含 curl 之錯誤碼)——`netGuard` 之 WARN 因此斷成兩行、看不出原因。組日誌訊息時以結構化欄位(`reason`、碼)產生說明並一律壓成一行(`probeFailText`);單元測試替身給的是乾淨訊息,只有真探測器(或真實跑一次)才看得到。
- **子階段之「提早返回」report 須帶齊下游所讀之欄位**:斷網略過時補全文之 detail 少了 `aggregated`,抓取段之固定格式摘要成「轉錄 undefined」(巡檢以正則解析此句)。正常路徑之測試全綠,因為只有略過路徑缺欄。**跑整個物件之測試一律呼叫 `assertSubStagesOk`**(`test/tools/testKit.mjs`,已含「摘要不得含 undefined」)。盤點:`git grep -n "return stdReport({ detail: {" -- src/stages`,逐一核對各提早返回之欄位與正常路徑同形(實跑 6 行:areaStage 1、detailFetchStage 1、expandStage 2、hygieneStage 1、listFetchStage 1)。
- **日誌字樣即契約,改字樣要全範圍連動**:使用端巡檢判讀抓取段日誌之字樣與正則由 `src/logContract.mjs` 單一來源提供(`CAPTURE_LOG_KNOWN`／`MUST_SEE`／`PARSE`)。曾見重評逾次之 WARN 改為新字樣後,巡檢白名單與測試注入字樣仍是舊的——測試綠(它驗的是舊字樣不被報),實際 WARN 卻會被報為未知警告。作法:改 WARN 字樣時 `git grep` 舊字樣於 `src`、`test` 全範圍,白名單與測試一併改;新增 WARN 字樣入 `MUST_SEE` 時,測試注入「程式實際產生之原文」(不手寫近似句),並與產生端之單元測試斷言同一字串(`unit-log-contract`、`unit-flow-capture` A8c)。
- **實網逐案題組之「救回／留佇列」不是確定性結果,連「兩次一致」都不夠**:約 1 小時內三次實跑,站方相依之案每次不符之案不同,非終態案中近三成去向至少翻轉一次、兩個方向都有;翻轉者之逐階軌跡皆為站方回應(403、too-short 牆頁、ERR_HTTP2),單獨診斷各階皆成功,非階梯回歸。有案前兩次「變好」而依人工核對改了題組,**第三次即翻回被擋——題組改錯,已原樣還原**;短時間內重複打同批網址還可能自己觸發限流。**教訓**:①站方相依之結果不得據短時間觀察改題組;②實網測試勿在短時間內重複跑;③此類案只能斷言「分流不變式」(去向三選一且各自合規:raw 且無假救回、留瀏覽器佇列、暫時性 HTTP 失敗依規則重試;不得 dead、不得延後),救回與否只報告。`api-capture-live` 之題組即依此分「確定性之案」(404／410、轉址至首頁之軟 404,逐案斷言去向,三次皆穩定)與「站方相依之案」。
- **實網測試不可用靜默日誌**:瀏覽器階梯之逐階軌跡只在日誌(「瀏覽器亦失敗（…；camofox:…→playwright:…）」),測試原用靜默日誌,第一次不符時看不到那一輪 Camofox 回了什麼;改為照錄並印出(第二次即看到 `camofox:too-short`、`camofox:placeholder` 等逐階原因)。
- **驗收判準要逐字對照規則之適用範圍**:判準寫「本輪落 raw 者皆已另存」,複本實跑報 7 篇未另存——全是 grid 摘要(輪抓入庫即 raw;另存只限正文落盤與 feed 退路之終態,grid 於終態瘦身時才另存,見 `stages/docMaintainStage.mjs` 檔頭)。判準寬於規則會把設計判成缺陷,窄於規則會漏。**判準寫完先標它對應規則哪一條、範圍是否相同**;判準錯就更正判準並留痕,不是改產品遷就。
- **複本實跑才看得到兩件事**:①存量資料有舊形狀(缺欄),單元測試之資料不會有——舊 skip 缺 `skipKind` 會被算作「已判定」,首輪對複本即停用一批「已判定 6～8 篇、產出 0」之來源(補欄可校正);②長文 `rawGz` 確實存全長(庫內截 20,000 字、另存 5 萬餘字)——這是「存解析全文」決策能否成立之唯一實證。

## 34. 抓取:OpenAlex 金鑰與 429(規則 CAP-16)

- **「issue 說 429＝額度用盡」要先對官方文件**:官方 [Authentication〈Rate limits〉](https://help.openalex.org/api/authentication/)寫明 429 有兩因——超出每日額度,或超出每秒上限(無金鑰 10、有金鑰 30 次/秒),後者「costs nothing; wait a moment and retry」。故單次 429 之固定訊息兩因並列(`OPENALEX_QUOTA_MESSAGE`),只有「連續三次(各次已含 `fetchWebByCurl` 的一次 3 秒重試)」才判定每日額度用盡而停止。`X-RateLimit-Reset` 為「Seconds until reset (midnight UTC)」,重置時間寫 UTC 00:00。不帶金鑰時 `GET /rate-limit` 回 401(「You must provide a valid API key」),帶金鑰才可查——啟動時查剩餘額度(issue 列為可選)本輪未做。
- **query 帶金鑰＝金鑰進網址,漏出路徑要逐一堵**:官方兩種帶法等價,`fetchWebByCurl`(w-fetch-web)無自訂標頭選項,故用 `api_key=`。實測(`withRetry` 預設輸出)重試時 stderr 會印「`[fetchWebByCurl] HTTP 503 <含 api_key 之完整網址>，等 3000ms 後重試`」,且結果物件的 `url` 欄、curl 失敗之 `message`(含完整命令列)都帶金鑰。處置:帶金鑰之請求以 `maxRetries:0` 呼叫、重試自己做(`openAlexGet`),失敗結果之 `message／reason／url／finalUrl` 與自組之回應片段一律經 wsemi `maskDiagText`(遮罩規格 D1:不自寫);測試以真 curl 打本機假站台,在五種失敗(503、429、非 JSON、站方回顯金鑰、連線被拒)下斷言輸出與 stderr 皆不含金鑰原形與 URL 編碼形,並含「遮罩確實發生」的非空洞斷言(連線被拒之訊息應見 `api_key=***`)。改用標頭需 w-fetch-web 增 `headers` 與 `useShowLog`,屆時可簡化。
- **新增設定欄若會被誤填成機密,錯誤訊息不得回顯所收到之值**:`apiKeyEnv` 是變數「名」,最可能的錯誤是把金鑰「值」貼進去;設定錯誤訊息原樣回顯 `收到 "…"`,會把金鑰寫進啟動錯誤與日誌。`envName` 型別加 `noEcho`(訊息寫「值不顯示」)。
- **新增每輪依賴欄會破壞下游釘死欄集之測試**:`createCaptureRuntime().deps` 被下游總組裝展開,其測試多釘死欄集;`openAlexAuth` 因此只在帶金鑰時才放入 deps(未設金鑰者欄集同修前);`rt` 回傳物件則新增 `openAlexAuth`(本套件 `unit-assembly` 釘住,已更新)。
- **連續計數要與「入帳」一起設計**:只在連續 N 次時停止還不夠——前 N−1 次已各自記了 `fetch-failed`,續跑仍須 `retry`。作法:遭 429 者先暫存(pending),被其他結果打斷才記 `fetch-failed`,達門檻則與未發出請求者同為「未處理」不入帳。停止只及 OpenAlex(DOI 批次、題名),arXiv 與網頁不受額度影響、照常。
- **429 訊息保留「HTTP 429」字樣**:下游以訊息取狀態碼(`fetchPolicy.httpCodeOf` 之 `\bHTTP (\d{3})\b`)、日誌契約之已知常態 WARN 以 `HTTP (…|429)` 辨識;訊息改為 `OpenAlex HTTP 429：…` 而非 `OpenAlex 429：…`,既有判讀不變。
- **未設金鑰時要證明「與修前相同」,不是宣稱**:`tmp` 下以 `git archive` 取修前 `src`,同一組情境(混合 404／非 JSON／健康)對新舊各跑一次,請求網址、處置帳、結果、日誌逐字比對;另在測試內釘住四處請求網址之逐字格式。

### 34 續:多把金鑰(2026-11-05)

- **遮罩要看成功路徑**:`tidy` 原本只遮罩失敗結果,而真 `fetchWebByCurl` 成功時 `url`、`finalUrl` 都是含 `api_key` 之請求網址,公開匯出之 `openAlexGet` 因此把金鑰交回呼叫端.現有三處站點只取 `html`、`status`、`message`,未寫入日誌或磁碟,故未實際外洩;假抓取函數之成功結果不帶 `url`,單元測試與審查都看不到,是真金鑰實連時對結果逐欄比對才抓到.已改為帶金鑰之成功結果亦遮罩,無金鑰者仍原樣回傳.
- **issue 的因果推論要先實測,不照單全收**:使用端推論「逗號相連之整串無效 → OpenAlex 退回同 IP 共用額度 → 429」。以編造之假金鑰實連(5 次):`/works` 與 `/rate-limit` 對單把或逗號相連之假金鑰皆回 **401** `Invalid or missing API key`,**不退回無金鑰額度**;不帶金鑰之 `/works` 搜尋則另回 **429**(`Anonymous search is temporarily rate-limited…`,帶 `Retry-After`)。401 與 429 是兩種回應,同一個請求不會先 401 後 429;整日 429 的成因須回頭查「請求究竟帶了沒有金鑰」(變數名對不上、金鑰檔路徑不對都會變成不帶金鑰),本套件無法從日誌區分。探測只用假金鑰、有請求數上限,真金鑰之驗證交使用端。
- **舊碼並未把 401 誤判成 429,但 401 完全不可見**:`fetchWebByCurl` 的失敗結果不帶回應本文與標頭,只有 `httpCode` 與 `HTTP N` 訊息;`httpCodeOf`→401、`retryableOf`→假、`tidy` 只動 429。網格遇 401 靜默落 arXiv、領域驗證回 `OpenAlex 驗證失敗：HTTP 401`、回溯記 `fetch-failed`——都沒有「金鑰無效」之字樣,金鑰設錯無從察覺。
- **新增 WARN 字樣要先對照 `CAPTURE_LOG_KNOWN`**:已知常態含 `HTTP (401|403|404|410|429)`、`http-error`,含「HTTP 401」之新 WARN 會被巡檢歸為已知而吞掉,設錯金鑰正好看不見。作法:WARN 寫「狀態碼 401」避開已知字樣、並入 `CAPTURE_LOG_MUST_SEE`(行內併入已知字樣亦須見),以單元測試用真實產出之行驗證兩個正則。
- **全部金鑰無效時不能退回不帶金鑰**:退回即落入共用 IP 的每日 US$0.10 額度與匿名搜尋限流,現象變成 429,更難診斷。改為直接回 401／403 結果並不再送請求。
- **併發換把用「比較後再換」**:`advance(slot)` 只有當前把仍是 `slot` 才切。多個請求同時以同一把送出、同時收 429 時,第二個請求發現當前把已被切走,就直接用新的當前把,不會連跳。測試以「兩個請求都送出後才一起放行回應」之閘門重現(不靠延時)。
- **呼叫次數上限要算進 `maxRetries`**:一輪＝每把至多一次,輪與輪之間才等待,上限 `(maxRetries+1)×把數`;回溯每次請求 `maxRetries:1`,兩把皆 429 時一次請求就是 4 次呼叫、連續 3 次請求共 12 次(而非 6)。
- **直接匯出之 API 改形狀是破壞性變更**:`src/WKnowledgeCapture.mjs` 以 `export *` 轉出 `openAlexNet`,`openAlexApiKeyOf`(改回陣列)與 `createOpenAlexAuth`(只收陣列)為公開匯出;依派工不留舊形狀、不做字串相容,但對字串拋 `TypeError`(不回顯值),避免舊呼叫端靜默失去金鑰;README 已註明。
- **測試中的等待值不給極大**:為證明「換把不等待」曾把等待值給 600 秒,案例結束後未結束之計時器把 mocha 行程拖住 10 分鐘。改為成功路徑給大值(成功即不會走到等待)、需要證明「確有等待」之案例給 2 秒＋看門狗 300ms。

## 35. 抓取:耗時子階段扣保留給後段之時間(規則 CAP-17)

- **整輪預算只管逾期;各段直接問它,就一路做到逾期而吃掉保留**:此缺口曾在輪抓、補全文、擴充、文件維護同時存在而無人察覺——每段各自手寫「問整輪預算」,寫法一致故看不出來。處置:時間判斷收斂到單一守門閘(`src/core/util/stageReserve.mjs`),並以源碼守護(`unit-capture-reserve-guard`)禁止 `src/` 其餘處直接問整輪預算;日後新段若又直接問即紅。
- **守護掃描器要先用已知正例自檢**:守護測試首版取了詞法器之錯誤回傳欄位(取得 `undefined` 之骨架),對「尚未修正之現況碼」也是綠的(空轉);是自檢案(已知含 `budgetOf` 之片段須抓得到)先紅才發現。凡「掃描回空＝沒問題」之守護,都要有一個必抓得到之正例。
- **估計不可為 0**:保留 > 0 時開工門檻是「整輪剩餘 − 保留 ≥ 一次作業之估計」;估計取 0(例如抓取器未宣告逾時)則可用恆 ≥ 0,保留形同虛設。故估計有下限(`STAGE_STEP_FLOOR_MS`＝1 秒)。
- **估計要取「最壞耗時」,不是設定值**:外審發現兩處估計偏低——預設抓取器自宣告之逾時＝設定逾時＋60 秒(只取設定值會低估),探測請求含重試與線性退避(單次請求 27 秒而非 12 秒),site 線索之 feed 探測可逐候選試至 9 次請求。作法:估計取該段實際呼叫鏈之參數(抓取器逾時 × 嘗試次數 ＋ 重試等待),且常數與被估計之函數同一份(`FEED_PROBE_*` 自 `discoverFeed` 匯出,擴充段據以計算,不各寫 12000)。
- **保留為 0 時要「不探詢 ctx.remainingMs」才算行為不變**:守門閘在保留為 0 時只呼叫 `expired`、不呼叫 `remainingMs`(測試替身若在 `remainingMs` 內推進時鐘或計數,多一次探詢即改變時序);以探詢次數案證明。
- **「因保留而延後」要與「逾期」「容量上限」分開歸因**:`cut`＝保留 > 0、整輪未逾期、可用不足;整輪逾期、沒有待處理者、做完最後一件後才不足、超出每輪名額(`per`)者皆不算。`detail.reserveDeferred` 只在確因保留延後時才附,report 欄集於平時不變(下游釘死欄集之測試不破)。瀏覽器佇列之門檻保留為 0 時亦在(現版即有),歸因須再加「整輪剩餘本身 ≥ 門檻」。
- **別只盤取件迴圈**:同一段內之其他耗時站點各是獨立站點——AI 呼叫之後逐候選之驗證請求、自訂取件函數(可能含 AI)、同輪瀏覽器升級之 `canStart`、逐篇逾時函數收到之 `remainingMs`;盤點指令只抓得到「問整輪預算」之寫法,抓不到「根本沒有時間判斷」之迴圈,要另以「迴圈內有網路／AI 呼叫而無 `shouldStop`」之形狀逐段讀碼。
- **變數遮蔽**:`detailFetchStage` 內既有 `gate` 為內容健全閘,守門閘須另名(`reserveGate`),否則 `_gate: gate` 會把守門閘誤交給內容閘環。
- **佇列留待下輪之驗證**:延後路徑上不得有任何會改變未處理對象之寫入(來源 `lastFetchAt`、文件 `status`／`fetchTries`、線索 `status`、領域 `_meta`);測試逐項斷言「原樣」而非只斷言「沒處理」。
