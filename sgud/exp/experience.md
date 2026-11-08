# 累積經驗（w-knowledge-capture）

> 執行時之累積經驗，留給後續之嘗試、執行與判斷。本檔為索引與通則；主題經驗分檔如下表（節號沿用既有節號，規則帳本與程式碼註解會引用）。日期一律絕對日期；路徑為 repo 相對路徑（`src/…`、`test/…`、`toolg/…`）。

## 分檔

| 檔 | 內容 |
|---|---|
| `experience_ai.md` | §1／§1.1 AI 供應商目錄隨上游漂移之形狀、§2 prompt 長度上限之安靜失敗、§27 JSON 抽取取最後一段合格者 |
| `experience_capture.md` | §8 標題層預篩、§15 瀏覽器分流與健全閘與實網驗證、§20 無效文章處置與原文保存、§34 OpenAlex 金鑰與 429(含多把金鑰)、§35 耗時子階段扣保留給後段之時間 |
| `experience_standards.md` | §19 檢定標準之判準（正體字形、判準與標準之設計、待判、存量處置與掃描） |
| `experience_package.md` | §16 測試之 cwd 與匯入即執行、§21 自使用端抽提為獨立套件、§22 設定依工作改版、§23 抓取邊界、§31 收斂副本、§33 泛用開源套件之視角 |

## 通則（本套件開發之心得）

1. **同一機制兩份即分歧**：曾同時有兩份 AI 調度層（使用端一份、本套件一份），差異 27 項並造成實際缺陷（斷網不計到不了、截斷放行恆開、不拋錯契約有洞）。處置：調度層只留本套件一份，使用端以建構選項組裝、持久狀態以依賴注入；差異逐條分類、新舊雙跑差分只准出現差異表之項。
2. **執行秩序件之重複以「單一匯入點＋原名轉出」收斂**：本套件只經 `src/core/runnerPackage.mjs` 取用鎖、時鐘、日誌、預算等並以原名轉出——執行鎖之行程內登記表只有一份（兩份實作會互判殘留而接管）。
3. **領域中立之規則要各套件同一份且掃描範圍對稱**：詞表單一份（`test/tools/domainTerms.mjs`），掃描擴及 README 與 `src/bench/`；守門補「舊名／沿革字樣」與「不指名下游工作」。
4. **資料契約要宣告**：下游產物之欄位（筆記之 docId／createdAt／concepts／extractedAt）只在 `src/core/stores/noteFields.mjs` 存取，守門釘住。
5. **移植指定詞依發布形**：核對實際 tarball 後定為「套件名/src/入口檔」（GEN-18），非套件根。
6. **改名只搜呼叫形會漏函數參照**：改名後以 `\bname\b` 全檔驗 0。
7. **真實呼叫端要實跑**：`node src/bench/cli.mjs --help` 須印用法且 exit 0；經連結（junction）執行時舊版 `isDirectRun` 靜默不跑，已改以實際路徑比對。
8. **「存量掃描只做部分」多半是自設規則的副作用，不是資料限制**（2026-10-31 CS5）：掃描「只重用既有判定函數」是對的（同一判定），但判定內嵌在寫入函數裡就沒有可重用之純函數，於是只掃得到有純函數的那一條。處置是把判定抽成純函數（`sourceStopReasonOf`）、寫入與掃描同呼叫，而不是放寬掃描規則或另寫一份判定。
9. **可注入件跨子行程要用「規格 + 重建」**（2026-10-31 健全閘偵測器、站台 adapter）：函數無法序列化到瀏覽器階梯之子行程，若只在主行程生效，curl 層與瀏覽器層之判定就不一致。作法：注入物件自述 `module`（`import.meta.url`）與 `export`，主行程化為 specs 寫入 optsFile，子行程依同一順序 import 重建；自訂者無 module 於啟動期拋錯。注入語意統一為「有序陣列、整組取代、內建陣列對外匯出」——追加、置換、外部組合都只是陣列運算，不需要第二種注入入口。
10. **實跑腳本之席位 id 須在該次設定之 `ai.providerPick` 池內**：免費 id 不在池內會於啟動期檢核拋錯（本就是設計）；寫實跑腳本前先讀所用設定之池。
11. **「全部免費模型同時逾時」先查 opencode.log，不要當成額度日常耗盡**（2026-10-31）：曾見評分整日每模型「呼叫失敗 2、未呼叫 30」、真實 AI 實跑兩席各逾時 300 秒，日誌實為新字樣「Free usage limit reached … subscribe to OpenCode Go」（總量上限，跨每日重置仍在），而額度偵測 `QUOTA_PATTERNS`（`src/core/ai/poolQuota.mjs`）只認舊的兩種每日字樣。供應商改訊息即偵測失效且症狀只是「逾時」——每次撞到整批逾時，先 `grep -o 'AI_APICallError: [^"]*' opencode.log | sort | uniq -c` 列全部字樣再判。
12. **「免費模型全掛」要先分族再下結論**（2026-10-31）：opencode Zen 之免費 id 共用一個伺服端按帳號計之上限（匿名、登入態、新上架 id 皆同；大小與重置未文件化），它掛掉不代表其他免費路徑掛掉——agy Gemini 群組有自己的週／5 小時額度（`MSYS_NO_PATHCONV=1 agy -p /usage --output-format json` 可查、不耗額度），agnes／laguna 走自有金鑰 REST。真實 AI 測試分兩階：第一階只驗流程有效，挑得到的席位就測；第二階才比模型品質。把「免費池策略」列為待決是把第二階問題擋在第一階前面。
13. **UMD 編譯時，ESM-only 之外部子路徑不能列 external**（2026-11-01）：`opencc-js/dict/*` 經套件 `exports` 的 `"./*"` 只給 ESM 檔（無 `require` 條件）、預設匯出為字串；列為 external 時 UMD 以 `require` 取得的是命名空間物件而非字串，載入 dist 即拋「split 不是函式」。`toolg/gDistRollup.mjs` 改為打包詞庫（dist 約 +1.1MB）。**每次調整 external 後都要實際 `require` 一次 dist**，編譯 exit 0 與 `Creating a browser bundle…` 警告都不代表可載入。該警告為 `format: 'umd'` 對任何 Node 內建模組之固有提示（`rollupFile.mjs` 註明），`named and default exports together` 警告為主入口同時具名與預設匯出之結果（CJS 取用者可 `.createKnowledgeCapture` 或 `.default.createKnowledgeCapture`）。
14. **範例與腳本要關閉 LMDB 控制代碼**（2026-11-01）：`flow.closeStores(stores)` 須傳入 `openStores()` 之產物；漏傳則不關閉，Windows 上其後 `fs.rmSync(workDir)` 拋 `EPERM`（記憶體映射檔被占用）。離線範例 `g.mjs` 與其他自寫腳本皆須先關閉再清目錄。
15. **健全閘最少字數 300**（2026-11-01）：離線範例之模擬正文不足 300 字時，文件停在 `new`、`lastError` 為「健全閘：正文 N 字，低於 300」，看起來像抓取器沒作用；模擬頁面請 `repeat` 到足量。
16. **重整佈局時結構測試以位置定根**：掃描原始碼之測試（`unit-core-layers`、`unit-entry`、`unit-package`、`unit-settings`、`unit-capture-standards`）各自以本檔位置推導根，搬動原始碼夾後須逐一改根；`src/standards/registry.mjs` 之 `enforcedAt` 路徑是資料（相對 `src/`），不隨之改寫。
17. **請子代理補 JSDoc 時，用「去掉全部 `/** */` 區塊後與快照逐字比對」驗證只改了註解**；範例之 `// =>` 必須實跑取得（子代理各自寫抽取並執行範例之驗證腳本），不可憑想像。

18. **新共用件之測試以命名空間匯入、變異在暫存副本上做**（2026-11-08 產出鏈，規則帳本 CORE-11）：新共用件尚未實作時，測試檔若具名匯入會整檔載入失敗而看不到逐案紅，改 `import * as Entry from '../src/WKnowledgeCapture.mjs'` 再解構，修前紅才有逐案證據。變異檢查把 `src/` 與 `test/tools/` 複製到 `tmp/<案>/mutwork/`（副本在 repo 內，裸 import 沿父層找得到 `node_modules`，不需 junction），逐一植入、跑對應測試檔、還原；辨認等價變異：歷史上限 `>` 改 `>=` 時多出之捨去數為 0（等價），`when` 與 `run` 雙掛 `ctx.stamp` 時 `run` 內那一掛於現行管線不可殺（`when` 必先於 `run`；縱深防禦，不刪）。
19. **輪次 stamp 掛在 `when` 與 `run` 之包裝，不改原階段物件**（2026-11-08）：w-data-pipeline 之 ctx 由其 `createContext` 建、無 stamp 欄；`definePipeline` 只對頂層 ctx 逐段傳遞同一物件，巢狀管線之內層另建 ctx（只共用 bag 與 deps，不繼承欄位）。包裝須保留 `this`（`run.call(this, ctx)`）、`__kind`、`always`、`timeoutMs`；被略過或停止後之段不呼叫 `run`，故 `when` 也要掛（其後 `always` 段仍經 `when`）。階段物件跨輪重用，不得在原物件上寫 stamp。
20. **`unit-package` ⑥ 掃 `src/` 與 README 之字樣**（2026-11-08）：不得含舊名（`知識套件`、`w-knowledge-extract`）、他工作之名（`提煉`、`關聯`）、帳本代號（`CORE-nn`、`規則帳本`）與完整日期；註解要指規則時寫「見 sgud/rule/rulebook_core.md 之○○條」，範例用中立名稱（`note-write`、`w-demo-kb`、`demo.ai`）。測試與 sgud 不在掃描內。
21. **UMD 下的兩件事要分開想**（2026-11-08，於 `tmp/` 暫存編譯後實測）：①rollup 把 `import.meta.url` 改寫為 `pathToFileURL(__filename)`（Node）——dist 在套件目錄內，往上找 `package.json` 仍得同一套件，`pkgIdOf` 可用；②`src/bench/cases/*.json` 不隨 dist，內建角色之 `casesFile` 指向 dist 旁不存在之路徑，`promptFpOf` 回 null 並經 `onFail` 告知。暫存編譯法：複製 `toolg/gDistRollup.mjs` 之選項成 `tmp/` 內腳本、`fdTar` 改 `./tmp/<案>/dist`，不動 `./dist`。

22. **角色物件只被「定義它的那一份 `benchKit` 模組」認得**（2026-11-08）：`defineBenchRole` 以模組級 `WeakSet` 記已定義者，兩份副本（如本套件工作樹與下游 `node_modules` 內之安裝版）互不認得對方的角色，拿另一份的 `planBench`／`promptFpOf` 去處理，會把已定義（已補預設 `pageSize:1`）的凍結角色重新驗證而拋「`pageSize` 與 `paginate` 擇一」或「`std` 須為檢定標準 id」。探測下游角色之成本時，須用「該下游自己安裝之 `benchKit`」的 `planBench`（實測下游 9 個角色各 3～27 ms〔第二次 1～12 ms〕，不呼叫 AI）。正常安裝只有一份本套件，無此問題；下游若有兩份本套件（巢狀 `node_modules`）則 `promptFpOf` 會以 `invalid role` 拒收，須對齊成一份。

23. **「明給 null」與「缺省」要分開判，且檢核之 xor 寫在逐欄檢核之前**（2026-11-08，產出鏈 `makeProduced`）：單一產出者之 `seat`／`provider` 同時為 `null` 才算「無 AI 呼叫」。`(seat === null) !== (provider === null)` 一句擋掉「只其一為 null」與「一個 null 另一個缺省」，其後逐欄之非空字串檢核只在 `seat !== null` 時跑，既有「缺 seat」「seat 為數字」等訊息字樣因此不變。若用 `== null` 會把缺省當 null 而讓漏接線之呼叫端靜默寫成「無 AI 呼叫」，變異檢查以此型變異驗證測試擋得住。
24. **改回呼之引數時，先分「引數鍵集之斷言」與「錯誤訊息逐字之斷言」**（2026-11-08）：`afterRun`／`scan.audit` 加 `stamp` 只改呼叫處之引數物件；本套件有三處斷言引數鍵集（`unit-assembly-kit` 序列案、`unit-assembly` 收尾鉤子案、`unit-package` 之 `cfg.afterRun` 案）須刻意更新並加註來由，另有一處逐字比對 `resolveAfterRun` 之錯誤訊息（內含舊簽名文字），該訊息為各總組裝共通字樣，不隨之改。

## 通用之坑（本套件常踩）

- **絕不自套件外之根以 mocha 直跑套件測試檔**：逐檔 import 若以 cwd 為根，會掃到使用端之入口腳本而啟動一輪完整流程（GEN-09；詳 `experience_package.md` §16）。
- **金鑰、權杖絕不印出、不寫入 repo、日誌或結果檔**。
- **opencode 免費池「夜間斷線」實為額度耗盡**（日誌 Rate limit 證實）；席位按額度算容量。
