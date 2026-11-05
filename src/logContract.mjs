// logContract.mjs — 抓取之日誌契約:外部巡檢判讀抓取段日誌所需之字樣與正則(唯一來源;隨本套件之訊息一起改)
//
// 【為何在抓取套件】抓取各子階段(及其所用之 w-data-pipeline 輪抓與去重、w-fetch-web 正文抓取)之訊息字樣由本套件之碼與其依賴產生;
//   巡檢若自寫一份,本套件改字即失效——如補全文段之日誌為「待抓內文 N 篇（未試…、最舊 M 天）」,自寫之正則
//   /待抓內文 \d+ 篇（最舊 (\d+) 天）/ 即對不上,被砍之輪(無 run.json)之最舊天數讀成空。
// 【三類】
//   CAPTURE_LOG_KNOWN:已知常態之 WARN 字樣(各有機制兜底,或本為正常訊息)——巡檢不當未知警告;
//   CAPTURE_LOG_MUST_SEE:一律須見之字樣(行內即使含已知字樣或標題、網址,亦須列出);
//   CAPTURE_LOG_PARSE:逐輪數字之正則(執行摘要 run.json 缺時之退路;group 1 為數字)。
//   前兩類為正則片段字串,巡檢以「|」併入其總表(與其他工作之字樣合併)。另 CAPTURE_REPORT_KEYS:執行摘要中抓取段之階段名與子階段鍵。
// 【核心件之字樣由本檔宣告一份】本套件之核心件(總組裝共用件之每輪序列與其所用之管道、AI 調度層之事件、本機網路判斷)為下游各工作之總組裝
//   共用,其所發之字樣只在 CORE_LOG_KNOWN／CORE_LOG_MUST_SEE;本套件與下游套件之契約皆以之組成(不各抄一份——發出者改字只改這裡)。
// 【以實際訊息驗證】單元測試以真實之子階段與流程產出之日誌驗證(test/unit-log-contract、unit-flow-capture A8c;核心件之字樣以真實之
//   每輪序列、調度層事件與網路判斷產出之行驗證:test/unit-assembly-kit)。

/**
 * 核心件之已知常態 WARN 字樣(正則片段;本套件與下游套件之契約以之組成)
 *
 * @type {Array}
 */
export const CORE_LOG_KNOWN = Object.freeze([
    // 管線秩序之常態:執行鎖持有中略過本輪(管道之「管道[…] 略過本輪：」)、時間預算守門(管道之「管道[…] 階段[…] 略過：逾時間預算」;
    //   各子階段之守門行同此字樣)、啟動期檢核(每輪開頭之「啟動期檢核：」)——由巡檢之專屬判準彙整,不當未知警告
    '略過本輪', '逾時間預算', '啟動期檢核：',
    // AI 調度層之事件(core/assemblyKit 接到當輪日誌;設定 ai.healthStreak／ai.pools 時才有):健康降序、免費池額度降序——
    //   降至鏈尾即兜底(成交即恢復),屬常態;prompt 逾長剔除(「供應商能力：」)不列,逾長是批量設定問題、須看見
    '供應商健康：', '供應商額度：',
])

/**
 * 核心件之一律須見字樣(正則片段;純文字;本套件與下游套件之契約以之組成)
 *
 * @type {Array}
 */
export const CORE_LOG_MUST_SEE = Object.freeze([
    // 本機網路不通:網路判斷器確認不通——子階段開工前略過之行、AI 調度層整鏈皆敗之錯誤字樣(行首可能為各工作之已知字樣,如「批次 AI 失敗」)
    '本機網路不通',
])

/**
 * 抓取段之已知常態 WARN 字樣(正則片段;抓取專屬者＋核心件之字樣)
 *
 * @type {Array}
 */
export const CAPTURE_LOG_KNOWN = Object.freeze([
    // 正文抓取之失敗(w-fetch-web 之訊息;分流、瀏覽器階梯與重試兜底)
    'platform wrapper', 'captcha', 'HTTP (401|403|404|410|429)', 'minimal visible text',
    'curl-error', 'http-error', '（blocked：', '（redirect：',
    // 輪抓(w-data-pipeline runListFetch)與網格抓取器之失敗:來源政策兜底(連敗停用、冷卻重探)
    '網格雙供應商皆失敗', 'curl 抓取失敗', '找不到 feed', '無法解析 feed', '抓取失敗（第 \\d+ 次）', '抓取失敗（timeout', '抓取失敗（fetch-error',
    // 來源自動停用之變體須成套列全(stores/sourcePolicy:「已判定 N 篇、產出 0，自動停用」、「連續失敗 N 次，停用」、連續無資料):
    //   只列其一則另一則逐輪被判為未知而洗版
    '自動停用', '連續失敗 \\d+ 次', '連續 \\d+ 次無資料',
    // 補全文之 feed 退路、線索探測與擴充之失敗(冷卻重探兜底)
    '改用 feed 內文', '探測\\[', '擴充：.*失敗',
    // 逐篇／逐來源／逐線索之一般異常(落帳後下輪續作)、格式不合之項、去重層(w-data-pipeline createSeenStore)之無法識別項
    '內文\\[', '逐來源異常', '逐篇異常', '逐線索異常', '不符格式而略過', '去重檢測：',
    // 線索上限淘汰(設計如此,記錄保留可復活)
    '超過上限',
    // 核心件之字樣(管線秩序、AI 調度層之事件)
    ...CORE_LOG_KNOWN,
])

/**
 * 抓取段之一律須見字樣(正則片段;抓取專屬者＋核心件之字樣)
 *
 * @type {Array}
 */
export const CAPTURE_LOG_MUST_SEE = Object.freeze([
    // 逐篇／逐來源／逐線索之鏈異常(程式或環境問題,不計失敗、不判死;每次 WARN「第 N 次」)——行內含標題、來源名或線索值
    '逐線索鏈異常', '逐來源鏈異常', '逐篇鏈異常',
    // 環境:瀏覽器不可用(本輪斷路,分流形同停用)、孤兒回收殺除後仍存在(本機網路不通為核心件之字樣)
    '瀏覽器環境不可用', '孤兒瀏覽器回收：殺除後仍存在',
    // 材料之保存:原文另存、判定依據另存失敗
    '原文另存失敗', '判定依據另存失敗',
    // 領域發現:AI 判定或整段失敗、投影寫入失敗
    '領域發現：AI 判定失敗', '領域發現失敗', '領域清單投影寫入失敗',
    // OpenAlex 金鑰被判無效(401／403;fetchers/openAlexNet):設定錯誤須人為修正,行內即使併入已知字樣(如「網格雙供應商皆失敗：OpenAlex HTTP 401：…」)亦須見
    'OpenAlex 金鑰無效',
    // 核心件之字樣(本機網路不通)
    ...CORE_LOG_MUST_SEE,
])

/**
 * 逐輪數字之正則(執行摘要缺時之退路;group 1 為數字):
 *   newDocs:管線執行器之段落完成行(「步驟N 抓取 完成：」＋captureObject 之 captureSummaryOf 固定格式);
 *   queued／queuedDays:補全文段之積壓可見性行(stages/detailFetchStage)
 *
 * @type {Object}
 */
export const CAPTURE_LOG_PARSE = Object.freeze({
    newDocs: /步驟\d+ 抓取 完成：來源 \d+ 個、新文件 (\d+)/,
    queued: /待抓內文 (\d+) 篇/,
    queuedDays: /待抓內文 \d+ 篇（[^）]*?最舊 (\d+) 天）/,
})

/**
 * 執行摘要(run.json)中抓取段之 report 鍵:stages[] 中 name 為 stage 之段,其 sub 為子階段名 → 子階段 report({ ok, stats, detail, summary })。
 *   讀抓取段之報告者(外部巡檢等)以之取段名與子階段鍵,不寫字面(captureObject 之預設名與子階段鍵亦取此表)
 *
 * @type {Object}
 */
export const CAPTURE_REPORT_KEYS = Object.freeze({
    // 物件之階段名(captureObject 之預設 name)
    stage: '抓取',
    // 子階段之鍵(依執行順序)
    subStages: Object.freeze(['hygiene', 'seedSync', 'listFetch', 'detailFetch', 'docMaintain', 'expand', 'areas']),
})

export default { CORE_LOG_KNOWN, CORE_LOG_MUST_SEE, CAPTURE_LOG_KNOWN, CAPTURE_LOG_MUST_SEE, CAPTURE_LOG_PARSE, CAPTURE_REPORT_KEYS }
