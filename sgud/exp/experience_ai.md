# 累積經驗 — AI 調度層(§1、§1.1、§2、§27)

> 本檔記本套件 AI 調度層(`src/core/ai/`)與其上游 w-dispatch-ai 供應商目錄之累積經驗:目錄 id 漂移之三種形狀、prompt 長度上限、JSON 取最後一段。節號沿用原節號;對應規則見 `../rule/rulebook_core.md`(AI-*),現況見 `../state/state.md`。

## 1. AI 供應商目錄:id 隨上游目錄漂移之三種形狀

本套件之調度層(`src/core/ai/adapter.mjs`)建於 w-dispatch-ai 之內建目錄(其 `providers.mjs`)之上。目錄 id 隨模型輪替增刪或改名,而下列各處皆以字面引用 id,上游一動就漂:安裝端之可用池 `providerPick`(建構選項 `aiOptions.providerPick`)、席位 `use`／`fallback`、套件預設席位(`capture.discover.ai`,`src/core/settingsDefault.mjs`)、評分預設受測名單 `DEFAULT_FREE_MODELS`(`src/bench/benchKit.mjs`)、測試內之 id 字面。

| 形狀 | 後果 | 現行處置 |
|---|---|---|
| `providerPick` 列了目錄沒有之 id | 上游 `resolveCatalogue` 回 missing,`createAiAdapter` 於建構期拋 `ai.providerPick 含未知 id`(附最接近之 id),整輪不執行 | 啟動即爆;`unit-ai-adapter-ext` 之 providerPick 案釘住 |
| 席位引用「不在 `providerPick`、缺金鑰、目錄無」之 id | 上游**靜默略過**,遞補鏈默默變短甚至變空,不報錯 | 本層 `chainFor`／`validateSeats` 一律拋錯,訊息分「缺金鑰」「未列於 ai.providerPick」「目錄無此條目」三因 |
| 條目還在,但上游改政策使它 100% 失敗(§1.1) | 解析正常、啟動無警告、測試不紅,每次呼叫白繳一次失敗再遞補 | 啟動期檢不出,只有逐供應商之健康紀錄看得出 |

**同一形狀重複發生多次**:上游下架或改名條目而設定仍留舊 id;限時免費條目壽命可短到不足一日。啟動期拋錯屬好形狀(立刻發現),靜默形狀才危險。作法:

1. **升版 w-dispatch-ai 後要對齊四處,且要跑全套**:①套件預設席位;②`DEFAULT_FREE_MODELS`(`freeModelsOf()` 依判準自目錄推導,`unit-bench` 之「與依判準自目錄推得者一致」逐 id 抓漂移);③測試內引用目錄 id 之席位字面與缺金鑰例(`unit-settings`、`unit-ai-adapter*`、`unit-bench*`);④opencode 額度日誌夾具之 `modelID`(`poolQuota` 以 `providerID/modelID` 對條目之 `model` 欄,對不到即不發「供應商額度」字樣;見 `unit-ai-adapter-ext`、`unit-assembly-kit`)。④只在升版後跑**全套**才紅,單檔測試與只比對席位清單之檢查都看不到;不要只看 `npm i` 成功。
2. **套件預設只能用內建目錄之 id**:零設定安裝沒有 `extraProviders`,把自帶條目之 id 寫進預設即啟動期拋錯(零設定組裝之測試會抓到)。
3. **`extraProviders` 與內建目錄不要同時定義同一模型**——兩處必然漂移;目錄收錄後即移除自帶之一份。自帶條目之欄位照抄內建同族條目(如唯讀沙箱欄位不可省)。
4. **限時免費條目視同易失物**:不入套件預設;採用前先想好下架時之退路(誰承接、遞補鏈夠不夠長)。「備查」條目留在 pick 內同樣會拋錯,留著就要跟著維護,否則刪掉(備查資訊寫在經驗)。
5. **排席位看故障域,不只看分數**:同一家不要同時坐太多席,一家倒下會空幾席、遞補後是否仍有不同故障域之家。opencode 族(`oc:opencode/*`,金鑰 `OPENCODE_KEYS`)受同一政策與額度管轄,視為一個故障域;`oc:agnes-ai/*`、`oc:poolside/*` 雖走 opencode CLI,但金鑰屬各自家,只是同一上游帳號之替代傳輸路徑——**不增加額度也不增加多樣性**,不可當成另一家。套件預設席位為免費 opencode 族條目,安裝端要求韌性時須自行加入他家。
6. **小探測成功 ≠ 實際題可用;REST 條目「HTTP 200 卻 missing content」先懷疑傳輸,不要先懷疑模型**:開工前探測(小 JSON)正確,正式評比卻全敗。直打重現:HTTP 200、本體是 brotli 壓縮位元組、回應**沒有 `Content-Encoding` 標頭**——fetch 不解壓 → 轉接器 JSON 解析失敗 → `INVALID_RESPONSE: missing choices[0].message.content`;以 brotli 手解即為完整正確之答案,改帶 `Accept-Encoding: identity` 則直接回原文。小回應未被壓縮,所以探測過得了——**「短回應正常、長回應全敗」即此症之指紋**。同形曾於生產見到(長回應被 gzip 壓縮而無標頭,前兩 bytes `1f8b`,長輸入之呼叫近一日全敗);w-dispatch-ai 1.0.37 起 REST 轉接器預設帶 `Accept-Encoding: identity` 已根治。**診斷法**:把原始回應以位元組讀出,印全部標頭與前 16 bytes 之 hex,逐一試 gunzip／inflate／brotli／zstd。先猜「推理 token 吃光 max_tokens」是錯的——沒看原始回應就猜成因,正是要擋的。
7. **讀遞補結果之錯誤訊息要看全部,不只最後一筆**:同一條目多把金鑰時,`INVALID_RESPONSE`／HTTP 錯誤會換下一把、以**剩餘預算**重打(`TIMEOUT`／驗證失敗才整組跳過,分流規則見 w-dispatch-ai `dispatchAiFallback.mjs` 檔頭)。評比格記「TIMEOUT after 66.9s」而該格實耗 360s,表示第一把先以別的錯誤失敗、第二把用剩下之 67s 逾時——第一次就逾時者會是「after 360s」。只看最後一筆會把傳輸缺陷誤讀成「模型太慢」(`benchFailOf` 保留 `errors` 全列即為此)。

### 1.1 第三種形狀:條目還在,但上游改政策使它 100% 失敗

- **事件**:opencode 自家免費層曾對外斷供——CLI 回 exit 1、REST 回 HTTP 403,訊息一致(`OpenCode's free tier can only be used from within OpenCode`)。
- **斷供範圍之分界線是「金鑰屬於誰」,不是「走不走 opencode CLI」**(初判錯誤,經實測才釐清;條目 id 第二段即供應商):被擋者只有 provider 為 `opencode`(`OPENCODE_KEYS`)那一族,CLI(`oc:`)與 REST(`zen:`)皆被擋,沿用本機登入態亦被拒——是政策而非金鑰問題;以自家金鑰(agnes、poolside)走 opencode CLI 完全正常,opencode 只是傳輸層。
- **後來解除,但性質要記清楚**:上游閘門以「呼叫端 config 裡有沒有 bash 工具」判定是否為 opencode 本體;w-dispatch-ai 1.0.30 起注入 `OPENCODE_CONFIG_CONTENT` 且 `bash: 'ask'`(非 `'deny'`)即通過。①只有 CLI 路徑通,REST 無法偽裝、仍 403;②依賴上游目前之偵測方式,上游改判即再斷供——故不把某一家放太多席,遞補鏈保留非 opencode 家;③同族條目回 `UnknownError`(伺服器錯誤)者與閘門無關,閘門解除後仍不可用。
- **為何比「條目被移除」更難察覺**:pick 解析正常、啟動無警告。曾有一個條目身兼三席,每輪白繳十餘次失敗再全數遞補到有 session 上限之訂閱制家,連續十輪無人發現。
- **偵測判準(適用於使用端巡檢讀健康紀錄時;本套件之 `core/ai/providerHealth.mjs` 只負責降序,不負責告警,降序不等於告警)**——兩種判準都會漏:

| 錯誤判準 | 為什麼漏 |
|---|---|
| 靠「連續失敗被降序」(`cooled > 0`) | 上游冷卻只由 429／逾時觸發,`exec`／`http` 型失敗 `cooled` 恆 0,整天靜默 |
| 靠「整日聚合 `ok === 0`」 | 被「早上正常、下午全敗」抹平(實測聚合 ok 36／fail 162,`ok > 0` 直接濾掉) |

  正確判準是**末端連續輪數**:逐輪掃健康表,同一 id 連續 ≥2 輪 `ok=0` 且該段失敗 ≥6 次即告警。**教訓**:①健康表是唯一能看出這種形狀之處,須逐供應商看、且要看趨勢,不只看聚合;②新寫之告警一定要拿**真實日誌**重跑驗證——第一版通過了自己編的單元測試資料,卻抓不到真的那一家。

## 2. prompt 長度上限:安靜失敗、0ms、不計入逾時

`agy:`(antigravity CLI)以命令列傳 prompt,w-dispatch-ai 之 `dispatchAntigravity.mjs` 設 `MAX_PROMPT_LENGTH = 30000`(Windows 命令列 32,767 上限扣 exe 路徑與旗標之保守值;本套件對應 `src/core/ai/capability.mjs` 之 `KIND_MAX_PROMPT_CHARS.antigravity`)。超過就**未執行即回失敗**(errorType `params`),耗時近 0ms——不像逾時那樣顯眼,健康表上只是多一筆失敗,實際效果是「那個席位從來沒真的工作過」。

- **踩過三次,同一原因、不同席位**(皆下游批次呼叫:多候選批次、多份草稿之整合):實測 prompt 約 17k～44k 字元,註解寫之「約 1.5 萬字」低估約三倍。批次輸入長度＝各份材料字元總和加固定前綴,故候選數、批量、席位數一變,長度跟著變。
- **兩條路徑對超限之處置不同**:`callJson` 呼叫前經 `fitChain` 依實際長度剔除放不下之條目、直接改派遞補(未送出、無失敗紀錄);工作流入口經 `seatSpec(seat, promptLen)` 以同一判準預篩,全放不下回 `null`。**預設不計入條目與 kind 之固有上限**——須建構選項 `capability: true`,或以 `ai.providerLimits` 明給逐 id 上限;未開時長 prompt 照常送交轉接器,由其回 `params` 後才遞補。
- `params` 不計入健康降序(席位設定與供應商能力不相容,冷卻無益;另計 mismatch 供執行摘要揭露);`validateSeats` 對「全鏈條目皆有上限」之席位回警告(長 prompt 無處可去)。
- **教訓**:prompt 長度一律以真實材料實測,不憑印象估;改動候選數、批量、席位數時回頭重量。

## 27. 調度層之 JSON 抽取改「取最後一段合格者」(規則 AI-10)

- **調度層只有一份,但「誰在用」要追到組裝點**:本套件之 `createAiAdapter` 服務抓取之領域發現、評分與下游各工作(`callJson` 與多棒工作流)。歷史上曾有兩份(各套件獨立組裝一份、正式管線一份),改行為須兩份都改、且共用同一實作(`pickJsonReply` 即共用件);曾因未追組裝點而誤說「抓取套件之調度層服務四大工作」。說「誰在用」前先追到組裝點。
- **取最後一段時,`check` 是唯一之篩選**:取第一段時前言之 `[3]` 會被取走;取最後一段時尾隨說明之 `[3]` 會被取走——兩種錯是對稱的,真正的防線是 `check` 要驗到項目之形狀(至少一項帶 index 等)。改規則時逐一盤點傳給調度層之 `check`:曾有只驗 `Array.isArray` 者(與同段另一個 check 不對稱)→ 補正。`check` 之語意要一致:嚴格 `check(d) === true`(回「不合格原因」字串者不當合格;`core/ai/jsonReply.mjs` 之 `pickJsonReply`)。
- **驗收用實錄回覆重放正式路徑**:先前以條目 validate 攔 stdout 抓到之真實回覆最適合當驗收材料——假 REST 回這段原文,走正式調度層,比對舊作法(取第一段得 1 項)與新作法(取最後一段得 5 項);比只跑自己寫的單元測試更接近使用者會遇到之情形(`test/unit-ai-json-reply.test.mjs`)。
- **「誰傳 check」要盤到評分與真 AI 測試**:盤點只掃生產碼之 `callJson(…, check)` 會漏評分核心之預設 `() => true`(`src/bench/benchKit.mjs`)與真 AI 測試之「只驗陣列」——它們也走同一調度層、也受「取最後一段」影響,且評分須與正式取同一段才量得準。盤點式樣要含 `() => true` 與角色定義之 check,不只 `Array.isArray`:`git grep -nE "callJson\(|\(\) => true" -- src test`。
