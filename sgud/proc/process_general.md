# 處理要點 — 總則:命名、測試入口、設定須知、領域由使用端給

> 本檔記本套件之共通處理要點(規則見 `../rule/rulebook_general.md`);抓取之使用與維運見 `process_capture.md`,檢定標準之處置工具見 `process_standards.md`。

## 命名(GEN-01)

- 本套件之模組名一律 `capture`(中文「抓取」):設定鍵 `capture`、設定表 `CAPTURE_DEFAULT`／`CAPTURE_SCHEMA`(`src/core/settingsDefault.mjs`)、物件工廠 `createCaptureObject`(`src/captureObject.mjs`)與執行期件 `createCaptureRuntime`(`src/captureRuntime.mjs`)、總組裝 `createKnowledgeCapture`(`src/createKnowledgeCapture.mjs`)、動作鏈名與 hook 前綴 `capture.<子階段>`(如 `capture.listFetch`、`capture.expand.probe`)、執行摘要之段名「抓取」(`CAPTURE_REPORT_KEYS`)。
- 舊名 `fetch` 不得再作為設定段或模組名。盤點:`git grep -nE "settings\.fetch\b|cfg\.fetch\b" -- src test` 應為空(`cfg.fetchers` 為抓取器鍵,不在此限)。
- 中文「彙整」只留「彙整貼文」(aggregator post,文件狀態 `aggregated`)之義。

## 測試入口(GEN-09)

- 套件測試一律自套件根跑 `npm test`(單檔作法見 `process_capture.md`)。**不可自他處根(如使用端專案根)以 mocha 直跑本套件測試檔**:測試之掃描與匯入根以測試檔位置推導(`path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')`),不用 cwd——位置推導之根與 cwd 錯位時,逐檔匯入之副作用可能落到套件外。歷史教訓:曾有測試以 cwd 為根,自他處根直跑時匯入到套件外之入口檔,啟動了一輪正式流程。
- 暫存一律落 `test/_tmp/<名>-<pid>`(`test/tools/testKit.mjs` 之暫存根工廠以套件根推導,測完刪;`test/_tmp/` 已列 `.gitignore`)。

## 設定須知(GEN-03、GEN-04)

- **本套件只放新格式、新工作流**(GEN-04):不含遷移、相容、舊名與舊鍵之退路;使用端之舊設定、舊資料之轉換由使用端另寫一次性工具(預演預設、實寫須同意、每步回驗)。
- `ai`、`capture` 兩段以 schema 驗鍵集、型別與值域(`AI_SCHEMA`、`CAPTURE_SCHEMA`),頂層 cfg 鍵以 `CFG_KEYS`(`src/createKnowledgeCapture.mjs`)驗,`cfg.data` 以 `DATA_KEYS`、提示詞以 `PROMPT_KEYS`、集合名以 `COLLECTION_KEYS` 驗:**打錯鍵、數字寫成字串、區段形狀錯、AI 席位引用不存在之條目 id、時區無效、樣式無法編譯,皆於建構期拋錯、整輪不執行**,不靜默回預設。只給想調的鍵,其餘沿用預設(組逐鍵合併;席位、樣式陣列、函數給了即整個取代,見 `README.md` §5)。
- `ai` 段不收席位與工作目錄:席位由呼叫端於 `callJson` 之 `callOpt.spec` 給,AI 工作目錄由 `cfg.aiWorkspace` 給(預設 `<workDir>/tmp/ai-workspace`)。
- 守門:`test/unit-settings.test.mjs`、`test/unit-assembly.test.mjs`(每個設定鍵逐鍵覆寫與拒收、`cfg` 各鍵檢核)。

## 領域由使用端給

- 本套件領域中立:預設不含任何領域詞;盤點用詞表單一份 `test/tools/domainTerms.mjs`(守門 `test/unit-domain-terms.test.mjs`、`test/unit-package.test.mjs`)。
- 領域句、知識庫稱呼、來源清單由使用端以設定與詞彙提供:`data.vocab`(`domain` 主題範圍句,領域發現之提示詞據此限定;`kbLabel` 知識庫稱呼;`conceptRenames`／`conceptAliases`)、`data.seedSources`、`data.gridTopics`,以及領域過濾 `capture.areas.openAlexFields`／`capture.areas.arxivCategories`／`capture.expand.arxivCategories`(未給即不限領域,網格會抓進跨領域雜訊)。整份改寫領域發現之提示詞用 `prompts.area`(輸出契約不變);更深之置換 `createAreaDomain({ vocab, buildPrompt })` 經 `stageOpts.areas.domain`(`README.md` §7)。要量覆寫後之提示詞,評分時一併給 `domain`／`domainOf`(`README.md` §13)。
