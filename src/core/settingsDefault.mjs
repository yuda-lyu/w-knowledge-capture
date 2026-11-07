// settingsDefault.mjs — 套件內建設定預設值(安裝即用;安裝方以 cfg 逐鍵覆寫)
//
// 【兩段】ai(AI 調度層:逾時、遞補冷卻、自帶條目;免費池額度、健康降序、prompt 長度上限——後三者之預設值即關閉)、
//   capture(抓取之全部設定)。capture 依抓取之三要點分組:
//   要點 1 各網站文章之抓取(sources 來源輪抓與品質政策、articles 補全文、browser 瀏覽器分流、network 本機網路判斷)、
//   要點 2 領域清單(areas)、要點 3 自動擴展(expand 待探索線索、discover 新領域之發現,含其 AI 席位);
//   services 為要點 2、3 共用之外部查詢服務;standards 為檢定標準(正文健全閘、存量維護、符合度掃描)。
//   下游總組裝之 settings.capture 即本段——其抓取委由本套件,設定以 resolveCaptureSettings 驗證合併。
// 【合併】組(物件節點)逐鍵遞迴合併:只給想調的鍵,其餘沿用預設;葉(席位、樣式陣列、函數、逾時對照)給了即整個取代。
// 【數值為實際運行之知識庫實測定案】節流對齊處理速率(進料 ≫ 處理會讓佇列無上限累積、舊料被餓死)、逾時取各家實測上限之 2~3 倍。
// 【領域中立】預設值不綁任何主題:網格與線索探測之領域過濾(capture.areas.openAlexFields／capture.areas.arxivCategories／
//   capture.expand.arxivCategories)預設不限;種子來源、網格主題、知識庫稱呼與主題範圍由安裝方以 cfg.data 給。
// 【免費 AI 為主】領域發現之預設席位全為免費模型;付費家由安裝方加於遞補尾。
// 【設定錯誤一律啟動期拋錯,不靜默回預設】各組之鍵以 schema 逐鍵驗型別與值域、不認得之鍵拋錯、組給了但形狀錯亦拋——
//   安裝方之設定是刻意為之,靜默改用套件預設(如席位退回預設家、'27' 被算成字串)比拋錯更難察覺。
//   與執行期數值鍵(core/runtime:警告＋預設)之差別:執行期鍵有文件化之安全預設,設定鍵沒有(退回預設即安裝方的意圖被改寫)。

import isobj from 'wsemi/src/isobj.mjs'
import isarr from 'wsemi/src/isarr.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import { sourceOriginOf } from './util/records.mjs'
import { unknownKeysProblem, checkKeys } from './util/values.mjs'
import { gateDetectorProblems } from './util/injectables.mjs'

/**
 * 標題層預篩(確定不含知識的例行彙整貼文,進後續處理前攔下改走連結轉錄;{p,f} 形式供 JSON 覆寫)
 * 只收通用樣式;特定站台之例行貼文標題由安裝方以 capture.articles.skipTitlePatterns 給定(給了即整份取代本預設)
 */
export const SKIP_TITLE_PATTERNS_DEFAULT = [
    { p: '^Recent [\\w\\s-]*Links\\b', f: 'i' },
    { p: '^Weekly (Roundup|Links|Recap|Digest)', f: 'i' },
    { p: '^(Links|Reading) (Roundup|Digest)', f: 'i' },
    { p: '\\bweekly\\s*#?\\d+', f: 'i' },
    { p: '\\b(roundup|digest)\\s*#?\\d*\\s*$', f: 'i' },
]

/**
 * AI 調度層預設(金鑰一律走 envFile／env,不在此)
 *
 * 【席位只能引用 w-dispatch-ai 內建目錄或 ai.extraProviders 之 id】目錄之 id 隨模型輪替增刪,引用目錄外之 id 會在啟動期拋錯而整輪不執行;
 *   w-dispatch-ai 升版後須比對席位所列 id 是否仍在其 src/providers.mjs(零設定組裝之測試會抓到未知 id)。
 * 【高頻呼叫之機制以「值」表達開關,預設即關】pools、healthStreak、providerLimits 為多角色高頻呼叫而設(見 core/ai/adapter);
 *   抓取每日至多一次 AI 呼叫,預設全關(健康降序 0＝不開)——需要之下游(如批次摘要)於其設定預設給定。
 */
export const AI_DEFAULT = {
    // 單次嘗試逾時(條目 id 列於 providerTimeouts 者以其為準;與 w-dispatch-ai 預設同值)
    timeoutMs: 300_000,
    maxRetries: 0, // 同家不重試,韌性由換家提供(重試只是把逾時乘次數)
    cooldownMs: 900_000, // 限流／逾時之冷卻:移到鏈尾不移除,任一次成功即解除(0＝不冷卻;免費池額度與健康降序亦經此機制,0 時兩者無降序效果)
    providerTimeouts: {}, // 逐條目 id 之單次逾時 { 條目 id: 毫秒 }
    // 安裝方自帶條目(格式同 w-dispatch-ai 之 providers.mjs:{ id, model, kind, envVar?, baseURL?, body?, exe?, … }):
    //   新 id 追加、同 id 者逐欄覆蓋內建條目(可就地改 exe 路徑、baseURL 而不必等套件發版)
    extraProviders: [],
    // 免費池當日額度(core/ai/poolQuota):{ oc: { log:'auto'|日誌路徑, resetUtcHour:0～23 } } 即開——opencode 日誌回報當日額度用盡之條目
    //   降至鏈尾至每日重置('auto'＝opencode 預設日誌位置);{}＝不開
    pools: {},
    // 供應商健康降序(core/ai/providerHealth):連續幾次「整組皆敗」即降至鏈尾;0＝不開
    healthStreak: 0,
    // prompt 長度上限之逐條目覆寫 { 條目 id: 字元數 }(core/ai/capability):列出者於呼叫前依實際長度剔除放不下者;0＝解除該條目之固有上限;
    //   {}＝不剔除。條目固有之上限(條目自帶 maxPromptChars;kind 之硬上限表目前留空)另由調度層之建構選項 capability 開啟
    providerLimits: {},
}

/** 抓取設定(依抓取三要點分組;下游總組裝之 settings.capture 即本段) */
export const CAPTURE_DEFAULT = {
    // ── 要點 1:各網站之文章抓取 ──
    // 來源輪抓與來源品質政策(stores/sourcePolicy、stages/listFetchStage)
    sources: {
        perRun: 6, // 每輪輪抓來源數(tier／lastFetchAt 最舊優先;grid 來源另以 areas.perRun 計)
        itemsPerSource: 8, // 每來源最多取用新項目數
        minIntervalMs: 21_600_000, // 同一來源最短重抓間隔 6 小時
        // list 抓取器未自宣告 timeoutMs 時之全域逾時(與補全文之 articles.timeoutMs 對稱;0＝無逾時會讓對端不回應時整段卡到被砍)
        listTimeoutMs: 120_000,
        concurrency: 1, // 同時輪抓之來源數(>1 以波次並行;0／1 串行)——零件庫用法之選項,整段管線預設串行(來源逐個落帳、日誌不交錯)
        maxConsecFails: 8, // 連續失敗幾次即停用(0＝永不因連敗停用:來源由使用端管理時)
        maxConsecEmpty: 5, // 連續無新項目幾次即停用
        cullMinJudged: 6, // 已判定(noted＋skip)幾篇才據產出率判定
        // 產出率回饋:已判定 ≥ cullMinJudged 篇且產出率(noted/(noted+skip))低於此值者,輪抓時排到同層級之末(降序不停用);0 即關閉
        lowYieldRate: 0.1,
        // 冷卻重探(CS5):被品質政策停用之來源、被品質回饋暫停之自動領域、failed 線索,冷卻 reprobeDays × min(2^重探次數, 8) 天後
        //   重新啟用並開新觀察窗(試抓);每輪至多 reprobePerRun 個(以免一次湧入大量待判文件);任一為 0 即不重探
        reprobeDays: 30,
        reprobePerRun: 3,
        isAutoSource: (s) => sourceOriginOf(s).auto, // origin 之解讀取 core/util/records(與寫入同一格式)
        // grid 來源逐輪前進 cursor(翻頁);其他來源無 extraPatch。只在本輪抓取成功且確由 OpenAlex 回應(抓取器於來源物件標 _fetchedVia)時前進:
        //   失敗或改走 arXiv 遞補(不用 cursor)時照樣 +1 會讓該頁 OpenAlex 結果永遠漏抓。
        //   回補耗盡(抓取器標 _exhausted:空頁或達 OpenAlex 頁碼上限)→ 轉 fresh 模式(追新作,cursor 不再前進)
        extraPatchOf: (s, o) => {
            if (s.kind !== 'grid' || o?.ok !== true || s._fetchedVia !== 'openalex') return {}
            if (s._exhausted) return { mode: 'fresh', cursor: 1, exhaustedAt: new Date().toISOString() }
            if (s.mode === 'fresh') return {}
            return { cursor: Math.max(1, Number(s.cursor) || 1) + 1 }
        },
    },
    // 補全文(stages/detailFetchStage:curl → 正文健全閘 → 不合格依原因改走瀏覽器;決定性失敗一輪即終態)
    articles: {
        // 每輪最多補抓幾篇全文。下游(如摘要)之每輪容量須 ≥ 本值＋瀏覽器名額 browser.perRun(瀏覽器分流停用即 0 時計 0)＋grid 直入 raw 之上界
        //   (areas.perRun×sources.itemsPerSource),推導式見 stores/fetchPolicy 之 captureCapacityOf;否則 raw 在下游堆積;改任一名額時下游容量同步
        perRun: 27,
        timeoutMs: 30_000,
        maxTextChars: 20_000, // 單篇原文入庫上限(全文另存原文)
        // 原文另存(docTexts;檢定標準 CS13):false 即不另存、終態瘦身亦不清正文(原文留庫)——零件庫用法之選項(速報類不需回溯)
        archiveText: true,
        maxTries: 3, // 試滿即 dead——抓取失敗唯一的丟棄判準(沒有時間型過期,見 core/stores/docPolicy)
        // 暫時性失敗之時間退避(補全文之 retry 類;待探索線索之失敗亦用之):第 n 次失敗後 retryBackoffHours×4^(n-1) 小時內不再取
        //   (6 時、24 時…);0＝不退避。每輪重試、3 次即 dead 時,站台維護數小時即判死整批
        retryBackoffHours: 6,
        aggregatorLinksPerDoc: 12, // 彙整貼文最多轉錄幾條外部連結
        // 標題層預篩:看標題就能百分百確定為例行彙整貼文者,不補全文、改走連結轉錄(判斷不了的交給下游);給了即整份取代預設
        skipTitlePatterns: SKIP_TITLE_PATTERNS_DEFAULT,
    },
    // 瀏覽器分流(fetchers/browserFetcher、stores/fetchPolicy):curl 抓不到之 JS 空殼、挑戰頁、逾時、403、亂碼等改走
    //   w-fetch-web 之 Playwright／Camofox,一律在子行程執行(硬逾時＋樹狀殺)
    browser: {
        perRun: 6, // 每輪瀏覽器篇數(0＝停用瀏覽器分流):補全文升級與瀏覽器佇列(doc.fetcher='browser')共用;子行程逐篇序列執行
        maxMs: 240_000, // 本輪瀏覽器軟性時間上限:逾時即不再開新篇(進行中之一篇受其子行程硬逾時封頂,見 browserFetcher ladderTimeoutMs)
        navTimeoutMs: 20_000, // Playwright 導航逾時(w-fetch-web navigationTimeoutMs)
        camofox: {
            enabled: true, // 階梯是否含 Camofox(反偵測 Firefox;未安裝時該方法本輪斷路,不計 tries)
            // Camofox server 埠:須與同機其他使用 w-fetch-web 者不同(其預設 19377;同埠並行會借用彼此 server 而互殺,見 fetchWebByCamofox 檔頭)
            port: 19417,
        },
        // 孤兒瀏覽器回收(core/ops/browserHygiene;抓取物件第一個子階段):會掃描整台機器之行程,套件預設關閉、由安裝端開啟;測試組裝一律關閉
        hygiene: false,
    },
    // 本機網路判斷(core/util/netGuard):網路問題不算在文章／來源／線索／AI 呼叫頭上
    network: {
        // 探測端點:null＝取 services 三個端點基底之原點(本系統本就使用,不另引第三方);[]＝不判斷(恆視為通)
        probeUrls: null,
        probeTimeoutMs: 8_000, // 各端點並行探測之逾時
    },

    // ── 要點 2:領域清單(種子在 cfg.data.gridTopics;每個領域一條 OpenAlex 查詢,失敗時遞補 arXiv;stores/areaPolicy)──
    areas: {
        perRun: 3, // grid 來源每輪名額(與 sources.perRun 分開挑:領域增加不擠掉一般來源;raw 進料上界之一部分＝本值×sources.itemsPerSource)
        maxActive: 60, // 啟用中領域上限(含種子;輪替週期＝本值÷perRun 輪)
        minFreshRate: 0.2, // 冗餘判定:自動領域之 grid 來源近 5 次新件率(新入庫÷取得)低於此值即暫停
        // 領域過濾:預設不限(通用);安裝方依主題給定。OpenAlex primary_topic.field.id 以 | 串接(如 '17|26'),網格查詢與領域驗證共用
        openAlexFields: '',
        arxivCategories: [], // 網格遞補查 arXiv 之類別(如 ['cs.LG','stat.ML']);[]＝不限
    },

    // ── 要點 3:自動擴展 ──
    // 待探索線索 → 新來源／新文件(stages/expandStage、core/stores/frontierPolicy)
    expand: {
        perRun: 12, // 每輪消化幾筆待探索線索(探測便宜:每筆約 2 次 HTTP)
        // 待探索線索上限:超過即淘汰優先序最低者(hits 低、來自 skip 文件、最舊),記錄保留、再被提及即復活。
        //   線索產生量 ≫ 消化量,無上限則永無止境成長;0 即不設限
        maxPending: 2000,
        arxivCategories: [], // 關鍵詞探測查 arXiv 之類別;[]＝不限
    },
    // 新領域之發現(stages/areaStage:候選 → AI 判定 → OpenAlex 驗證 → 啟用;每日至多一次 AI 呼叫)
    discover: {
        everyHours: 24, // 領域發現之最短間隔(0＝停用自動發現;種子領域照常)
        windowDays: 30, // 主概念支持數之統計窗
        minSupport: 20, // 主概念候選(有筆記集合時):窗內主標籤筆記數下限(扣除既有領域 grid 文件之貢獻)
        minClueDocs: 3, // 線索候選:提及之相異文件數下限(全狀態)
        candidatesPerCall: 8, // 每次發現交 AI 判定之候選數上限
        minHits: 200, // 驗證:OpenAlex 計數下限(同 areas.openAlexFields 白名單;遠大於品質判定樣本,否則小領域永遠到不了判定)
        newPerDay: 2, // 每日新增自動領域上限
        rejectCooldownDays: 30, // 驗證未過之候選冷卻天數
        // 席位 { use, fallback?, timeoutMs?, minAttemptMs?, budgetMs? }:預設全為免費模型(opencode CLI 之匿名免費存取,免金鑰);付費家由安裝方加於 fallback 尾;
        //   null＝無席位(不發現,與 everyHours 0 同效;零件庫用法之不用 AI)
        ai: { use: 'oc:opencode/mimo-v2.6-flash-free', fallback: ['oc:opencode/big-pickle'] },
    },

    // ── 外部查詢服務(要點 2、3 共用;測試指向本機假站台)──
    services: {
        // mailto:OpenAlex 禮貌池信箱(網格查詢、領域驗證、來源重抓共用;'' 不帶)。
        // apiKeyEnv:OpenAlex API 金鑰之「環境變數名」(非金鑰值;值只放金鑰檔 cfg.envFile〔預設 <workDir>/.env〕,與 AI 金鑰同法),三處請求共用(fetchers/openAlexNet);
        //   金鑰檔無此變數或值為空 → 不帶金鑰(行為同無金鑰:無金鑰之請求共用同一 IP 每日 US$0.10 額度,易 429);'' 明確不使用(即使金鑰檔有該變數)。
        //   該變數之值可為逗號分隔之多把(各有各的每日額度):429 換下一把、401／403 標記該把無效(見 fetchers/openAlexNet【多把金鑰】);逗號相連之整串不是一把金鑰
        openAlex: { base: 'https://api.openalex.org', mailto: '', apiKeyEnv: 'OPENALEX_API_KEY' },
        arxiv: { base: 'https://export.arxiv.org' },
        bingNews: { base: 'https://www.bing.com' },
    },

    // ── 檢定標準:正文健全閘(CS1;stores/contentGate)、存量維護(stages/docMaintainStage)、符合度掃描(standards/audit)──
    standards: {
        minTextChars: 300, // 正文最少字數:curl 與瀏覽器結果同一把尺(w-fetch-web 之成功門檻僅 50 字)
        minFallbackChars: 300, // feed 摘要退路之最少字數(與 minTextChars 對稱)
        // 正文合理上限(字):逾之判格式雜訊(非文章——實見 67 萬字之格式雜訊頁;正常長文如期刊論文頁 16.7 萬字在內)
        maxSaneChars: 300_000,
        placeholderPatterns: [], // 佔位頁樣式追加([{p,f}];接在內建之後,僅短正文套用)
        paywallPatterns: [], // 付費牆樣式追加
        // 健全閘之偵測器(有序陣列;契約 core/util/injectables):null＝內建 GATE_DETECTORS_DEFAULT;給了即整組取代(含順序)——追加寫 [...GATE_DETECTORS_DEFAULT, mine]、
        //   換掉某一個以 id 篩掉再放自己的;自訂者須帶 module(瀏覽器階梯之子行程據以載入),其 sig 入閘版本(改了即存量重判)
        detectors: null,
        // 檢定標準之開關(零件庫用法;整段管線皆開):同一內容判定(CS10:網址代稱與段落雜湊,入庫與落 raw 之全部入口)、記錄標題對正文(CS2:錯頁)
        //   關閉者不判、不算,符合度掃描列為停用
        sameContent: true,
        titleMismatch: true,
        // 存量工作每輪上限:健全閘存量重判(CS1a;寫入篇數,未能判定者不佔)、段落雜湊補算(CS10;每篇一次原文另存讀取)。
        //   時間預算截止即停,未完者下輪接續
        healthRecheckPerRun: 500,
        paraKeysPerRun: 2000,
        // 每輪管線結束後掃一次可確定性判定之抓取標準(不呼叫 AI;本輪已逾時間預算者略過),各標準之計數入執行摘要(run.json 之 standards)。
        //   預設關閉:掃描讀全部文件(含原文另存),大庫耗時;由安裝端依庫規模開啟
        scanEachRun: false,
    },
}

/**
 * 席位規格之許可鍵(AI 調度層之 spec 契約;settings 之 seat 型別與 core/ai/adapter 之啟動期檢核共用此一份)
 *
 * @type {Array}
 */
export const SEAT_KEYS = Object.freeze(['use', 'fallback', 'timeoutMs', 'minAttemptMs', 'budgetMs'])

/**
 * 席位規格之形狀問題(合格回空字串):鍵限 SEAT_KEYS、use 為非空字串、fallback 為字串陣列、數值鍵為正數(毫秒)
 *
 * @param {*} spec 輸入席位規格，如 { use:'oc:opencode/big-pickle', fallback:['claude:sonnet'] }
 * @returns {String} 回傳問題說明(合格回 '')
 * @example
 * console.log(seatProblem({ use: 'claude:sonnet' }))
 * // =>
 *
 * console.log(seatProblem({ use: 'claude:sonnet', timeout: 1 }))
 * // => 含不認得之鍵：timeout（可用：use、fallback、timeoutMs、minAttemptMs、budgetMs）
 */
export function seatProblem(spec) {
    if (!isobj(spec)) return '席位須為物件 { use, fallback? }'
    const unknown = unknownKeysProblem(spec, SEAT_KEYS)
    if (unknown) return unknown
    if (!isestr(spec.use)) return 'use 須為非空字串（條目 id）'
    if (spec.fallback !== undefined && spec.fallback !== null && !(isarr(spec.fallback) && spec.fallback.every(isestr))) return 'fallback 須為條目 id 之字串陣列'
    const badNum = ['timeoutMs', 'minAttemptMs', 'budgetMs'].filter((k) => spec[k] !== undefined && !(Number.isFinite(spec[k]) && spec[k] > 0))
    if (badNum.length) return `${badNum.join('、')} 須為正數（毫秒）`
    return ''
}

/**
 * 免費池設定之形狀問題(合格回空字串):物件 { oc?: { log?: 'auto'|日誌路徑, resetUtcHour?: 0～23 之整數 } },只認得 oc
 *
 * @param {*} v 輸入 ai.pools 之值
 * @returns {String} 回傳問題說明(合格回 '')
 */
function poolsProblem(v) {
    if (!isobj(v)) return '須為物件'
    const unknown = unknownKeysProblem(v, ['oc'])
    if (unknown) return unknown
    if (!('oc' in v)) return ''
    const p = v.oc
    if (!isobj(p)) return 'oc 須為物件 { log?, resetUtcHour? }'
    const bad = unknownKeysProblem(p, ['log', 'resetUtcHour'], 'oc')
    if (bad) return bad
    if (p.log !== undefined && !isestr(p.log)) return "oc.log 須為 'auto' 或日誌路徑（非空字串）"
    if (p.resetUtcHour !== undefined && !(Number.isInteger(p.resetUtcHour) && p.resetUtcHour >= 0 && p.resetUtcHour <= 23)) return 'oc.resetUtcHour 須為 0～23 之整數'
    return ''
}

// ── 設定 schema(檔頭【設定錯誤一律啟動期拋錯】):節點為字串＝葉(型別名,給了即整個取代);為物件＝組(逐鍵遞迴合併) ──

/**
 * 型別判準(名稱 → { test, desc, why? });why 給出不合格之細節(錯誤訊息用)
 *
 * @type {Object}
 */
export const SETTING_TYPES = Object.freeze({
    pint: { test: (v) => Number.isInteger(v) && v > 0, desc: '正整數' },
    p0int: { test: (v) => Number.isInteger(v) && v >= 0, desc: '非負整數' },
    p0num: { test: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0, desc: '非負數' },
    ratio: { test: (v) => typeof v === 'number' && v >= 0 && v <= 1, desc: '0～1 之數' },
    bool: { test: (v) => typeof v === 'boolean', desc: '布林值' },
    str: { test: (v) => typeof v === 'string', desc: '字串' },
    // 環境變數名(金鑰檔 .env 之 KEY=value 之 KEY;readEnvFile 只認英數與底線):設定只放名,值只在金鑰檔;空字串＝不使用。
    //   noEcho:不合格時錯誤訊息不回顯所收到之值——把金鑰「值」誤貼進「變數名」欄是最可能的錯誤,回顯即把金鑰寫進啟動錯誤與日誌(診斷輸出與遮罩規格 D3)
    envName: { test: (v) => typeof v === 'string' && /^[A-Za-z0-9_]*$/.test(v), desc: '環境變數名（英數與底線；空字串＝不使用）', noEcho: true },
    strArr: { test: (v) => isarr(v) && v.every((x) => typeof x === 'string'), desc: '字串陣列' },
    strArrOrNull: { test: (v) => v === null || (isarr(v) && v.every((x) => typeof x === 'string')), desc: '字串陣列或 null' },
    objArr: { test: (v) => isarr(v) && v.every(isobj), desc: '物件陣列' },
    fn: { test: (v) => typeof v === 'function', desc: '函數' },
    // 樣式清單:RegExp 或 { p:樣式字串, f?:旗標 }(JSON 可寫);樣式能否編譯另於建構期驗(總組裝)
    patterns: { test: (v) => isarr(v) && v.every((x) => x instanceof RegExp || (isobj(x) && isestr(x.p) && (x.f === undefined || typeof x.f === 'string'))), desc: '樣式陣列（RegExp 或 { p: 樣式字串, f?: 旗標 }）' },
    timeouts: { test: (v) => isobj(v) && Object.values(v).every((x) => Number.isInteger(x) && x > 0), desc: '物件 { 條目 id: 逾時毫秒正整數 }' },
    seat: { test: (v) => seatProblem(v) === '', desc: '席位物件 { use: 條目 id, fallback?: [條目 id], timeoutMs?, minAttemptMs?, budgetMs? }', why: seatProblem },
    // 席位或 null(null＝沿用另一席位,由讀取端定義沿用誰;判定小組之空席亦為 null)
    seatOrNull: { test: (v) => v === null || seatProblem(v) === '', desc: '席位物件 { use: 條目 id, fallback?: [條目 id], … } 或 null', why: (v) => (v === null ? '' : seatProblem(v)) },
    // 免費池(AI 調度層之當日額度偵測,見 core/ai/poolQuota):{ oc: { log:'auto'|日誌路徑, resetUtcHour:0～23 } };只認得 oc;{}＝不開
    pools: { test: (v) => poolsProblem(v) === '', desc: "物件 { oc: { log:'auto'|日誌路徑, resetUtcHour:0～23 } }（只認得 oc）", why: poolsProblem },
    // prompt 長度上限之逐條目覆寫(AI 調度層之能力預篩,見 core/ai/capability):{ 條目 id: 字元數上限 };0＝解除該條目之固有上限(條目自帶或 kind 之硬上限)
    limits: { test: (v) => isobj(v) && Object.values(v).every((x) => Number.isInteger(x) && x >= 0), desc: '物件 { 條目 id: prompt 字元數上限(非負整數;0＝解除該條目之固有上限) }' },
    // 健全閘偵測器陣列或 null(null＝內建;契約見 core/util/injectables——自訂者須帶 module 之要求在總組裝驗,此處只驗形狀)
    detectorsOrNull: { test: (v) => v === null || gateDetectorProblems(v).length === 0, desc: '健全閘偵測器陣列（[{ id, kind, test, module?, export?, sig?, adapter? }]）或 null（內建）', why: (v) => (v === null ? '' : gateDetectorProblems(v).join('；')) },
})

/** ai 段之 schema(調度層對直接給定之 ai 物件亦以此驗 pools／healthStreak／providerLimits) */
export const AI_SCHEMA = {
    timeoutMs: 'pint', maxRetries: 'p0int', cooldownMs: 'p0int', providerTimeouts: 'timeouts', extraProviders: 'objArr',
    pools: 'pools', healthStreak: 'p0int', providerLimits: 'limits',
}

/** capture 段之 schema(與 CAPTURE_DEFAULT 同形) */
export const CAPTURE_SCHEMA = {
    sources: {
        perRun: 'p0int', itemsPerSource: 'p0int', minIntervalMs: 'p0int', listTimeoutMs: 'pint', concurrency: 'p0int',
        maxConsecFails: 'p0int', maxConsecEmpty: 'pint', cullMinJudged: 'pint', lowYieldRate: 'ratio', reprobeDays: 'p0int', reprobePerRun: 'p0int',
        isAutoSource: 'fn', extraPatchOf: 'fn',
    },
    articles: { perRun: 'p0int', timeoutMs: 'pint', maxTextChars: 'pint', archiveText: 'bool', maxTries: 'pint', retryBackoffHours: 'p0num', aggregatorLinksPerDoc: 'p0int', skipTitlePatterns: 'patterns' },
    browser: { perRun: 'p0int', maxMs: 'p0int', navTimeoutMs: 'pint', camofox: { enabled: 'bool', port: 'pint' }, hygiene: 'bool' },
    network: { probeUrls: 'strArrOrNull', probeTimeoutMs: 'pint' },
    areas: { perRun: 'p0int', maxActive: 'pint', minFreshRate: 'ratio', openAlexFields: 'str', arxivCategories: 'strArr' },
    expand: { perRun: 'p0int', maxPending: 'p0int', arxivCategories: 'strArr' },
    discover: {
        everyHours: 'p0num', windowDays: 'pint', minSupport: 'pint', minClueDocs: 'pint', candidatesPerCall: 'pint', minHits: 'pint',
        newPerDay: 'p0int', rejectCooldownDays: 'p0num', ai: 'seatOrNull',
    },
    services: { openAlex: { base: 'str', mailto: 'str', apiKeyEnv: 'envName' }, arxiv: { base: 'str' }, bingNews: { base: 'str' } },
    standards: {
        minTextChars: 'p0int', minFallbackChars: 'p0int', maxSaneChars: 'pint', placeholderPatterns: 'patterns', paywallPatterns: 'patterns', detectors: 'detectorsOrNull',
        sameContent: 'bool', titleMismatch: 'bool',
        healthRecheckPerRun: 'p0int', paraKeysPerRun: 'p0int', scanEachRun: 'bool',
    },
}

/**
 * 設定值之顯示字串(錯誤與警告訊息用;設定合併、執行期生效值與各套件之設定訊息同一份——下游之設定訊息經本函數產生)
 *
 * @param {*} v 輸入設定值
 * @returns {String} 回傳顯示字串:字串加引號、數字／布林／null 原樣、陣列為 'array'、其餘為型別名
 * @example
 * console.log([showSettingValue('60'), showSettingValue(0), showSettingValue(null), showSettingValue([1]), showSettingValue({})].join(' '))
 * // => "60" 0 null array object
 */
export function showSettingValue(v) {
    if (typeof v === 'string') return JSON.stringify(v)
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v)
    if (isarr(v)) return 'array'
    return typeof v
}
const show = showSettingValue

/**
 * 預設值之複本(陣列與一般物件遞迴複製;函數、RegExp 原樣):各實例拿到之設定互不共用預設常數之參照,
 * 某實例就地修改設定不會汙染同行程之其他實例
 *
 * @param {*} v 輸入預設值
 * @returns {*} 回傳複本
 * @example
 * let d = { a: [1, { b: 2 }] }
 * let c = cloneSettingsDefault(d)
 * console.log(c.a[1] !== d.a[1], c.a[1].b)
 * // => true 2
 */
export function cloneSettingsDefault(v) {
    if (isarr(v)) return v.map(cloneSettingsDefault)
    if (isobj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cloneSettingsDefault(x)]))
    return v
}

/**
 * 驗一組設定並與預設合併(本套件各段與下游套件之設定段共用此一份規則):組給了但非物件 → 拋;不認得之鍵 → 拋;
 * 葉之值型別不符 → 拋;undefined／null 之組視為未給(沿用預設);葉之 undefined 視為未給。
 * schema 之節點為字串＝葉(SETTING_TYPES 之型別名,給了即整個取代),為物件＝組(逐鍵遞迴合併)
 *
 * 下游套件之設定段若有本表以外之專屬型別(只該段用得到者),以 opt.types 帶入(與 SETTING_TYPES 合併、同名以 opt 者為準;遞迴之子組同用),
 * 不必把只一段用得到之型別加進共用表
 *
 * @param {String} where 輸入該組之路徑(錯誤訊息用，如 'capture.browser')
 * @param {*} given 輸入安裝方給的組
 * @param {Object} schema 輸入該組 schema(鍵 → 型別名或子組 schema)
 * @param {Object} dflt 輸入該組預設值
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Object} [opt.types] 輸入額外型別表(名稱 → { test, desc, why? },形同 SETTING_TYPES),未給只用 SETTING_TYPES
 * @returns {Object} 回傳合併後之組
 * @throws {Error} 形狀、未知鍵或型別錯誤時拋出；schema 引用不存在之型別名時亦拋出(可用型別列合併後之全集)
 * @example
 * let g = mergeSettingsGroup('x', { n: 5 }, { n: 'pint', on: 'bool' }, { n: 1, on: true })
 * console.log(g)
 * // => { n: 5, on: true }
 *
 * let g2 = mergeSettingsGroup('x', { mode: 'all' }, { mode: 'modeEnum' }, { mode: 'off' }, { types: { modeEnum: { test: (v) => ['off', 'all'].includes(v), desc: "'off'｜'all'" } } })
 * console.log(g2)
 * // => { mode: 'all' }
 */
export function mergeSettingsGroup(where, given, schema, dflt, opt = {}) {
    const types = isobj(opt) && isobj(opt.types) ? { ...SETTING_TYPES, ...opt.types } : SETTING_TYPES
    const out = cloneSettingsDefault(dflt)
    if (given === undefined || given === null) return out
    if (!isobj(given)) throw new Error(`settings.${where} 須為物件，收到 ${show(given)}`)
    checkKeys(given, Object.keys(schema), `settings.${where}`)
    for (const [k, v] of Object.entries(given)) {
        if (v === undefined) continue
        const node = schema[k]
        if (typeof node !== 'string') {
            out[k] = mergeSettingsGroup(`${where}.${k}`, v, node, dflt?.[k], opt)
            continue
        }
        const t = types[node]
        if (!t) throw new Error(`settings schema 錯誤：${where}.${k} 之型別「${node}」不存在（可用：${Object.keys(types).join('、')}）`)
        if (!t.test(v)) throw new Error(`settings.${where}.${k} 須為${t.desc}，收到 ${t.noEcho ? '（值不顯示）' : show(v)}${t.why ? `（${t.why(v)}）` : ''}`)
        out[k] = v
    }
    return out
}

/**
 * 抓取設定之驗證與合併(本套件總組裝與下游總組裝之 settings.capture 共用此一份)
 *
 * @param {Object} [capture] 輸入抓取設定覆寫(鍵見 CAPTURE_SCHEMA)，undefined／null 代表全用預設
 * @returns {Object} 回傳合併後之抓取設定(與 CAPTURE_DEFAULT 同形)
 * @throws {Error} 給了但非物件、含不認得之鍵、或值型別與值域不符時拋出
 * @example
 * let c = resolveCaptureSettings({ sources: { perRun: 9 } })
 * console.log(c.sources.perRun, c.sources.itemsPerSource, c.discover.ai.use)
 * // => 9 8 oc:opencode/mimo-v2.6-flash-free
 */
export function resolveCaptureSettings(capture) {
    return mergeSettingsGroup('capture', capture, CAPTURE_SCHEMA, CAPTURE_DEFAULT)
}

/**
 * 席位表之顯示名(設定路徑 → 名稱;各工作之席位表同一份寫法——席位檢核工具與報表用)
 *
 * @param {Array} rows 輸入席位表 [{ path:設定路徑, label:顯示名, of:(工作段之設定) => 席位 }]
 * @returns {Object} 回傳凍結之 { 設定路徑: 顯示名 }(依表之序)
 * @example
 * console.log(seatLabelsFrom([{ path: 'a.ai', label: '甲', of: (a) => a?.ai }]))
 * // => { 'a.ai': '甲' }
 */
export function seatLabelsFrom(rows) {
    return Object.freeze(Object.fromEntries((isarr(rows) ? rows : []).map((r) => [r.path, r.label])))
}

/**
 * 席位表之已設席位(設定路徑 → 席位;只列物件者——null＝沿用該工作之主席位或未啟用之空席,不列;各工作之 *SeatsOf 同一份寫法)
 *
 * @param {Array} rows 輸入席位表 [{ path, label, of:(工作段之設定) => 席位 }]
 * @param {*} section 輸入工作段之設定(如 settings.capture;非物件者各列之 of 自行處置)
 * @returns {Object} 回傳 { '<設定路徑>': 席位 }(依表之序)
 * @example
 * console.log(seatsFrom([{ path: 'a.ai', label: '甲', of: (a) => a?.ai }, { path: 'a.b.ai', label: '乙', of: (a) => a?.b?.ai }], { ai: { use: 'x:y' }, b: { ai: null } }))
 * // => { 'a.ai': { use: 'x:y' } }
 */
export function seatsFrom(rows, section) {
    const out = {}
    for (const r of isarr(rows) ? rows : []) {
        const seat = r.of(section)
        if (isobj(seat)) out[r.path] = seat
    }
    return out
}

/** 領域發現之席位(抓取唯一呼叫 AI 之子階段;頻率取 capture.discover.everyHours) */
const DISCOVER_SEAT = Object.freeze({ path: 'capture.discover.ai', label: '領域發現', of: (c) => c?.discover?.ai })

/**
 * 抓取之 AI 席位表(唯一一份):設定路徑、顯示名、自 settings.capture 取席位之函數
 *
 * @type {Array}
 */
const CAPTURE_SEATS = Object.freeze([DISCOVER_SEAT])

/**
 * 抓取之 AI 席位之顯示名(設定路徑 → 名稱;席位檢核工具與報表用)
 *
 * @type {Object}
 */
export const CAPTURE_SEAT_LABELS = seatLabelsFrom(CAPTURE_SEATS)

/**
 * 抓取之 AI 席位(設定路徑 → 席位;只列已設者):啟動期席位檢核、主力供應商計算與席位檢核工具取用,呼叫端不另寫席位路徑
 *
 * @param {Object} settings 輸入解析後之設定(取 capture;本套件或下游總組裝之 resolveSettings 產物皆可)
 * @returns {Object} 回傳 { '<設定路徑>': { use, fallback, … } }
 * @example
 * console.log(Object.keys(captureSeatsOf(resolveSettings({}))))
 * // => [ 'capture.discover.ai' ]
 */
export function captureSeatsOf(settings) {
    return seatsFrom(CAPTURE_SEATS, settings?.capture)
}

/**
 * 抓取之 AI 用量說明(報表與外部巡檢之待辦表用;唯一一份):抓取只有領域發現呼叫 AI,頻率取 capture.discover.everyHours(0＝停用自動發現)
 *
 * @param {Object} capture 輸入抓取設定(settings.capture)
 * @returns {String} 回傳說明字串
 * @example
 * console.log(captureAiNoteOf(resolveCaptureSettings({})))
 * // => 領域發現每日至多 1 次（`capture.discover.ai`）
 */
export function captureAiNoteOf(capture) {
    const h = Number(capture?.discover?.everyHours) || 0
    const seat = `\`${DISCOVER_SEAT.path}\``
    if (h <= 0) return `${DISCOVER_SEAT.label}已停用（capture.discover.everyHours 0；席位 ${seat}）`
    if (capture?.discover?.ai === null) return `${DISCOVER_SEAT.label}已停用（席位 ${seat} 為 null）`
    return `${DISCOVER_SEAT.label}${h === 24 ? '每日' : `每 ${h} 小時`}至多 1 次（${seat}）`
}

/** 設定之段(resolveSettings 只收此二段;總組裝只交原給之段——不把整份 cfg 交出) */
const SETTINGS_SECTIONS = Object.freeze(['ai', 'capture'])

/**
 * 各段逐組覆寫(ai／capture),每組依 schema 驗鍵集、型別與值域(檔頭)
 *
 * @param {Object} [cfg={}] 輸入安裝方設定物件，非物件時視為{};只收 SETTINGS_SECTIONS 之段(總組裝只交原給之段)
 * @param {Object} [cfg.ai] 輸入 AI 調度層覆寫(鍵見 AI_SCHEMA)
 * @param {Object} [cfg.capture] 輸入抓取設定覆寫(鍵見 CAPTURE_SCHEMA)
 * @returns {Object} 回傳完整設定物件 { ai, capture, warnings }；warnings 為設定自洽之警告字串陣列
 *   (抓取各鍵目前無跨鍵之自洽條件,恆為空陣列;保留此欄供總組裝併入啟動期警告)
 * @throws {Error} 含 ai、capture 以外之段(打錯之段名若靜默略過,該段即維持預設而無人察覺)、任一組給了但非物件、含不認得之鍵、
 *   或值型別與值域不符時拋出——不可讓安裝方之設定靜默失效
 * @example
 * let s = resolveSettings({ capture: { sources: { perRun: 9 } } })
 * console.log(s.capture.sources.perRun, s.capture.sources.itemsPerSource, s.capture.discover.ai.use)
 * // => 9 8 oc:opencode/mimo-v2.6-flash-free
 */
export function resolveSettings(cfg = {}) {

    //check
    if (!isobj(cfg)) {
        cfg = {}
    }
    checkKeys(cfg, SETTINGS_SECTIONS, 'settings')

    return {
        ai: mergeSettingsGroup('ai', cfg.ai, AI_SCHEMA, AI_DEFAULT),
        capture: resolveCaptureSettings(cfg.capture),
        warnings: [],
    }
}

export default {
    SKIP_TITLE_PATTERNS_DEFAULT, AI_DEFAULT, CAPTURE_DEFAULT, SEAT_KEYS, seatProblem, SETTING_TYPES, AI_SCHEMA, CAPTURE_SCHEMA, showSettingValue,
    cloneSettingsDefault, mergeSettingsGroup, resolveCaptureSettings, seatLabelsFrom, seatsFrom, CAPTURE_SEAT_LABELS, captureSeatsOf, captureAiNoteOf, resolveSettings,
}
