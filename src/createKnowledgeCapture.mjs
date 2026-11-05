// createKnowledgeCapture.mjs — 總組裝:通用知識抓取(安裝即用,僅 workDir 必填;逐層可覆寫)
//
// ════════════════ 套件用法 ════════════════
//
//   import W from 'w-knowledge-capture/src/WKnowledgeCapture.mjs'
//   const flow = W.createKnowledgeCapture({ workDir: 'c:/my-kb', data: { seedSources: [ … ] } })
//   await flow.run()
//
// 擴充入口(每層都有預設):
//   ①cfg 設定覆寫(ai／capture 逐鍵;標題預篩樣式在 capture.articles.skipTitlePatterns)   ②cfg.data 種子來源、網格主題、知識庫稱呼與主題範圍
//   ③cfg.prompts.area 領域發現之提示詞                        ④cfg.stages 整組自訂子階段／cfg.stageOpts 各內建子階段之 opt(含 tap)
//   ⑤cfg.fetchers／cfg.siteAdapters 抓取器與站台 adapter       ⑥cfg.aiAdapter 整組置換 AI 調度層
//
// 【執行端不需要的膠水全在此】workDir → 各目錄展開;lmdb/WOrm 內建(可注入);AI 調度層內建(envFile 給金鑰;cfg.aiAdapter 可整組置換);
//   clock/logFactory 內建。抓取執行期件(資料檢核、樣式與健全閘、文字折疊、抓取器＋cfg.fetchers 合併、dedup → identity＋seen、網路判斷、
//   領域發現 domain、每輪依賴)一律經 captureRuntime 之 createCaptureRuntime 組裝——與下游之總組裝同一份,不在此另組。
// 【組裝機制取自 core/assemblyKit】鍵檢核、目錄、時鐘、提示詞與子階段設定、儲存、日誌工廠／收尾鉤子／調度層之形狀、調度層之建構與
//   事件日誌、集合之開關、每輪之序列與 info() 之共同欄,為各總組裝共用之一份(下游套件之總組裝同取之);本檔只放抓取專屬者
//   (抓取之鍵集、captureRuntime、抓取物件、每輪依賴、抓取之符合度掃描)與檢核之順序。
// 【時間預算單一來源】整輪軟性截止 deadlineMs、執行鎖陳舊期限 lockStaleMs 與各路徑皆由 core/runtime 之 resolveRuntime 一次解析
//   (排程上限 cfg.scheduleLimitMin;cfg 明給者優先);管線與 info() 同取此份。各耗時段經 core/util/stageReserve 之守門閘消費同一份預算,
//   並扣掉組裝者保留給後段之時間(各段 opt.reserveMs,未給取每輪依賴 deps.reserveMs;皆未給為 0＝只守整輪逾期):時間不足是少做幾件、未處理者留待下輪,不縮容量。
// 【開工標記】每輪開工先寫 log/<day>/<stamp>-run.start.json(本輪上限之宣告):被砍的輪次沒有 run.json,外部巡檢逐輪判界靠它。
// 【啟動期檢核】設定(各段 schema)、cfg 各鍵之形狀、資料、提示詞、子階段、AI 席位(use／fallback 全部可解析)皆於建構期驗——
//   打錯之鍵、缺金鑰或 id 打錯要在啟動期爆,不是靜默沿用預設或跑到第一次呼叫才被子階段當單次失敗吞掉。
// 【收尾在管線之外、摘要之後】每輪結束依序:①符合度掃描(settings.capture.standards.scanEachRun)②寫結構化摘要 run.json
//   ③收尾鉤子(cfg.afterRun 給函數才跑;本套件無內建巡檢)。收尾讀 run.json 時當輪的已存在;收尾失敗只留 warn,不影響本輪成敗。
// 【調度層事件寫入當輪日誌】ai.pools／ai.healthStreak／ai.providerLimits 開啟時,供應商額度／健康／能力之事件以 WARN 寫入當輪日誌
//   (未開即無此類字樣;注入 cfg.aiAdapter 時不接,調度層屬注入方)。
// 【筆記耦合為選用】抓取不預設依賴摘要之產物:cfg.notes 開啟(true 或集合名)才加開 notes 集合——領域發現讀其主概念、
//   原文回溯以之定對象;未開時領域發現只用線索、回溯對象＝無原文之已消化文件。

import isobj from 'wsemi/src/isobj.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import { resolveRuntime, runtimeCfgOf } from './core/runtime.mjs'
import { normalizeWorkDir } from './core/dirs.mjs'
import { resolveSettings, captureSeatsOf } from './core/settingsDefault.mjs'
import {
    checkKeys, resolveDirsCfg, resolveClockCfg, resolvePromptsCfg, checkDataKeys, checkStageConfig, checkOptionalCollections, resolveLmdbCfg,
    resolveLogFactory, resolveAfterRun, checkAiAdapter, createRoundLog, buildAiAdapter, startupWarningsOf,
    createStoreOpener, pipelineNameOf, createRoundRunner, assemblyInfoOf,
} from './core/assemblyKit.mjs'
import { createCaptureObject, CAPTURE_STAGE_KEYS } from './captureObject.mjs'
import { createCaptureRuntime, CAPTURE_STORE_KEYS, CAPTURE_DATA_KEYS } from './captureRuntime.mjs'
import { AREA_PROMPT_SIGS } from './domain/areaDomain.mjs'
import { auditCaptureStandards, standardsCountsOf } from './standards/audit.mjs'

/**
 * cfg 之全部可用鍵(本檔、captureRuntime、core/runtime、core/dirs、core/settingsDefault、core/assemblyKit 讀取者之聯集):不在此者於組裝期拋錯——
 * 打錯之鍵若靜默接受,正名鍵會維持預設而無人察覺。新增讀取 cfg.<鍵> 處須同步列入
 *
 * @type {Array}
 */
export const CFG_KEYS = Object.freeze([
    'workDir', 'name', 'dirs', 'timeZone', 'clock', 'lang', 'data', 'prompts', 'conceptFold',
    'ai', 'capture',
    'scheduleLimitMin', 'deadlineMs', 'lockStaleMs', 'lock', 'envFile', 'aiWorkspace', 'aiAdapter', 'aiOptions',
    'stages', 'stageOpts', 'fetchers', 'siteAdapters', 'dedup', 'lmdb', 'notes',
    'logFactory', 'afterRun', 'netGuard',
])

/**
 * cfg.data 之可用鍵(即抓取所讀之資料鍵,captureRuntime 之 CAPTURE_DATA_KEYS)
 *
 * @type {Array}
 */
export const DATA_KEYS = CAPTURE_DATA_KEYS

/**
 * cfg.prompts 之可用鍵(提示詞覆寫;函數形式見 domain/areaDomain 之 AREA_PROMPT_SIGS,輸出契約固定,見其 AREA_CONTRACT)
 *
 * @type {Array}
 */
export const PROMPT_KEYS = Object.freeze(Object.keys(AREA_PROMPT_SIGS))

/**
 * 集合之對外名(cfg.lmdb.cls 之可用鍵):抓取所用之集合(captureRuntime 之 CAPTURE_STORE_KEYS)＋notes(僅於 cfg.notes 開啟時開啟)
 *
 * @type {Array}
 */
export const COLLECTION_KEYS = Object.freeze([...CAPTURE_STORE_KEYS, 'notes'])

/** 內建管線名(日誌與執行摘要 run.json 之 name;cfg.name 給了即取代) */
const PIPELINE_NAME = '知識抓取'

/**
 * 總組裝:通用知識抓取(安裝即用,僅 workDir 必填;擴充入口見檔頭)
 *
 * @param {Object} [cfg={}] 輸入設定物件，非物件時視為{}(再由 workDir 檢查拋錯)；可用鍵見 CFG_KEYS
 * @param {String} cfg.workDir 輸入工作目錄路徑字串(唯一必填:所有輸出的路徑錨點)
 * @param {String} [cfg.name] 輸入管線名(日誌之管道名與執行摘要 run.json 之 name)，未給用內建名「知識抓取」
 * @param {Object} [cfg.dirs] 輸入目錄逐鍵覆寫(鍵見 core/dirs 之 expandDirs)
 * @param {String} [cfg.timeZone='Asia/Taipei'] 輸入 IANA 時區(日誌時間戳、檔名、「今日」判定之基準;不依系統時區)
 * @param {Object} [cfg.clock] 輸入時鐘物件(wsemi 之 genClockTZ 產物)，給了即不依 timeZone 建立
 * @param {String} [cfg.lang='zh-TW'] 輸入語言設定(BCP 47 代碼;core/locale 之 resolveLocale):提示詞之輸出語言句、正體標準之適用(只有繁體中文有字形標準,
 *   其餘語言列不適用、入庫不轉字形)、概念鍵之繁簡折疊(中文才折)、slug 之字元政策、時刻之數字格式依之;預設繁體中文
 * @param {Object} [cfg.data] 輸入資料 { seedSources:[], gridTopics:[], vocab:{ kbLabel?, domain? } }
 * @param {Object} [cfg.prompts] 輸入提示詞覆寫 { area:(candidates, areas, ctx) => 字串 }(輸出契約固定)
 * @param {Boolean|Function} [cfg.conceptFold] 輸入概念與線索鍵之字形折疊：false 停用、函數自訂、true 內建繁簡折疊、未給依語言設定(中文折、其他不折)
 * @param {Object} [cfg.ai] 輸入 AI 調度層覆寫(鍵見 core/settingsDefault 之 AI_SCHEMA；領域發現之席位在 capture.discover.ai)
 * @param {Object} [cfg.capture] 輸入抓取設定覆寫(鍵見 core/settingsDefault 之 CAPTURE_SCHEMA:sources、articles〔含標題預篩樣式 skipTitlePatterns〕、browser、network、areas、expand、discover、services、standards〔含 scanEachRun〕)
 * @param {Number} [cfg.scheduleLimitMin] 輸入排程執行上限分鐘數，時間預算與鎖陳舊期限由此推導(core/runtime)
 * @param {Number} [cfg.deadlineMs] 輸入整輪軟性截止毫秒數，未給由排程上限推導
 * @param {Number} [cfg.lockStaleMs] 輸入執行鎖陳舊期限毫秒數(持鎖者宣告值)
 * @param {Boolean|String} [cfg.lock] 輸入執行鎖：false 不上鎖、true 或未給用 <dirs.tmp>/run.lock、字串為鎖檔路徑
 * @param {String} [cfg.envFile] 輸入金鑰檔路徑(相對者以 workDir 為基準)，預設 <workDir>/.env
 * @param {String} [cfg.aiWorkspace] 輸入 AI 子進程工作目錄，預設 <workDir>/tmp/ai-workspace
 * @param {Object} [cfg.aiAdapter] 輸入整組置換之 AI 調度層(須具 callJson(prompt, check, { spec, budgetMs?, shouldStop? }))，未給用內建 createAiAdapter
 * @param {Object} [cfg.aiOptions] 輸入內建調度層之建構選項(安裝端之資產:{ providerPick?, exes?, persistStore?, usageCounter? };鍵見 core/assemblyKit 之
 *   AI_OPTIONS_KEYS),注入 aiAdapter 時不用
 * @param {Array} [cfg.stages] 輸入整組自訂之子階段陣列({ name, run(ctx) })，給了即取代內建子階段(與 stageOpts 擇一)
 * @param {Object} [cfg.stageOpts] 輸入各內建子階段之 opt { hygiene, seedSync, listFetch, detailFetch, docMaintain, expand, areas }(含 tap)
 * @param {Array} [cfg.fetchers] 輸入安裝方抓取器(同 id 置換內建、新 id 追加)
 * @param {Array} [cfg.siteAdapters] 輸入站台 adapter(同 id 置換套件自帶、其餘排前)
 * @param {Object} [cfg.dedup] 輸入去重身分設定(w-data-pipeline createIdentity)，預設 { keyOf:'raw' }
 * @param {Object} [cfg.lmdb] 輸入 { WOrm?, path?(預設 dirs.db), db?(預設 'knowledge'), cls?(集合名覆寫) }
 * @param {Boolean|String} [cfg.notes=false] 輸入筆記集合:true 或集合名 → 加開 notes(領域發現之主概念候選、原文回溯之對象)
 * @param {Function} [cfg.logFactory] 輸入日誌工廠 () => logger，預設每輪一檔 log/<day>/<stamp>-run.log
 * @param {Function|Boolean} [cfg.afterRun] 輸入收尾鉤子 ({ report, summaryFile, log, deps }) => 結果，false 或未給即無
 * @param {Object|null} [cfg.netGuard] 輸入本機網路判斷器(整組置換)；null＝不判斷；未給依 settings.capture.network.probeUrls(預設取 capture.services 三個端點基底之原點)建立
 * @returns {Object} 回傳 { run:Function, openStores:Function, closeStores:Function, info:Function }
 * @throws {Error} cfg.workDir 非有效字串、cfg 含不認得之鍵、settings 各段不合 schema、cfg 各鍵形狀不合(見各檢核)、
 *   健全閘之追加樣式無法編譯、詞彙表不合規格，或 AI 席位無法解析時拋出
 * @example
 * need test in nodejs.
 *
 * let flow = createKnowledgeCapture({
 *     workDir: 'c:/my-kb',
 *     data: { seedSources: [{ kind: 'rss', tier: 1, name: '範例來源', url: 'https://example.com/feed', lang: 'en' }], vocab: { domain: '天文學' } },
 * })
 * let report = await flow.run()
 * console.log(report.ok)
 */
export function createKnowledgeCapture(cfg = {}) {

    //check
    if (!isobj(cfg)) {
        cfg = {}
    }
    if (!isestr(cfg.workDir)) {
        throw new Error('createKnowledgeCapture 需要 workDir（唯一必填：所有輸出的路徑錨點）')
    }
    checkKeys(cfg, CFG_KEYS, 'cfg')
    const pipelineName = pipelineNameOf(cfg.name, PIPELINE_NAME)

    const workDir = normalizeWorkDir(cfg.workDir)

    // ── 路徑(workDir 展開,cfg.dirs 逐鍵覆寫;打錯之目錄鍵若靜默接受,該目錄會落在預設處)──
    const dirs = resolveDirsCfg(workDir, cfg.dirs)

    // ── 設定與資料(內建預設＋覆寫;形狀錯誤一律啟動期拋錯;設定解析只交原給之兩段)──
    const settings = resolveSettings({ ai: cfg.ai, capture: cfg.capture })
    const clock = resolveClockCfg(cfg.clock, cfg.timeZone)
    // cfg.data 之鍵集(種子、網格主題、詞彙覆寫;標題預篩樣式不在此,在 capture.articles.skipTitlePatterns)——形狀與逐項之檢核在
    //   captureRuntime 之 resolveCaptureData(與下游之總組裝同一份)
    checkDataKeys(cfg.data, DATA_KEYS)
    const prompts = resolvePromptsCfg(cfg.prompts, AREA_PROMPT_SIGS)
    // ── 執行期生效值(core/runtime:排程上限/時間預算/鎖/路徑之單一來源;管線與 info() 同取此份;先於抓取執行期件:OpenAlex 金鑰自 runtime.envFile 讀)──
    const runtime = resolveRuntime(runtimeCfgOf(cfg), { workDir, dirs })
    // 抓取執行期件(captureRuntime;與下游之總組裝同一份):資料檢核、健全閘與標題預篩樣式於建構期編譯、詞彙解析、文字折疊
    //   (線索鍵與概念鍵;內建 opencc,cfg.conceptFold 可停用或自訂)、抓取器＋cfg.fetchers、去重身分、網路判斷、領域發現之 domain
    //   (cfg.prompts.area 覆寫提示詞)、OpenAlex 金鑰載體(capture.services.openAlex.apiKeyEnv 所指之變數自金鑰檔讀)——設定錯誤一律於此拋
    const rt = createCaptureRuntime(cfg, settings, { buildAreaPrompt: prompts.area, envFile: runtime.envFile })
    const { data, registry, identity } = rt
    const vocabResolved = rt.vocab

    // ── 其餘 cfg 鍵之形狀(先於 AI 組裝:設定形狀錯誤的訊息不該被席位檢核搶先)──
    checkStageConfig(cfg.stages, cfg.stageOpts, CAPTURE_STAGE_KEYS)
    // 選開之集合:筆記(檔頭【筆記耦合為選用】)
    const optional = { notes: { value: cfg.notes, label: '筆記' } }
    const optionalOn = checkOptionalCollections(optional)
    const mkLog = resolveLogFactory(cfg.logFactory, { dir: dirs.log, clock })
    const afterRun = resolveAfterRun(cfg.afterRun)
    checkAiAdapter(cfg.aiAdapter)

    // ── LMDB(WOrm 內建,可注入替換;集合名可覆寫,預設即對外名)──
    const lmdb = resolveLmdbCfg(cfg.lmdb, dirs, { keys: COLLECTION_KEYS, optional })
    const storeNames = [...CAPTURE_STORE_KEYS, ...optionalOn]

    // ── 領域發現之 domain(captureRuntime 已依詞彙與 cfg.prompts.area 建立)──
    const domains = { area: rt.areaDomain }

    // ── AI 調度層(內建;cfg.aiAdapter 整組置換——測試替身／自建調度皆走這裡);網路判斷經 captureRuntime 之 isNetDown 詢問同一份 netGuard;
    //    調度層之事件(額度／健康／能力)寫入當輪日誌 ──
    const roundLog = createRoundLog()
    const ai = buildAiAdapter({ aiAdapter: cfg.aiAdapter, options: cfg.aiOptions, ai: settings.ai, envFile: runtime.envFile, workspace: runtime.aiWorkspace, clock, lang: rt.locale.code, isNetDown: rt.isNetDown, roundLog })
    // 啟動期席位檢核(檔頭):不可解析即拋;席位清單取 captureSeatsOf(席位路徑只在 core/settingsDefault 定義)。
    //   執行期生效值之警告(無效值、未給上限)與設定自洽警告併入:每輪開頭以「啟動期檢核：」記入日誌
    const startupWarnings = startupWarningsOf(ai, captureSeatsOf(settings), [runtime.warnings, settings.warnings])

    // ── 抓取物件:自訂子階段整組置換;否則內建子階段＋各子階段 opt(領域發現之 OpenAlex 驗證之信箱讀 capture.services.openAlex.mailto,與網格抓取器同一個) ──
    const captureObject = createCaptureObject(cfg.stages ? { stages: cfg.stages } : (cfg.stageOpts || {}))

    // ── 集合之開關:抓取所用之集合＋選開之筆記集合 ──
    const { openStores, closeStores } = createStoreOpener(lmdb, storeNames)

    /**
     * 每輪依賴(deps):套件子階段與執行端自寫子階段同一條注入通道。
     *
     * 【只放可列舉之普通屬性】w-data-pipeline 之管線建脈絡時以 spread 複製 deps({ ...parentCtx.deps, ...spec.deps });getter
     *   (Object.defineProperty 預設 enumerable:false)在 spread 時直接消失 → 子階段拿到 undefined、每輪靜默失敗。
     *
     * @param {Object} stores 輸入 openStores 之產物
     * @param {Object} log 輸入該輪日誌(去重身分查詢 seen 用)
     * @returns {Object} 回傳依賴物件 { stores, seen, registry, netGuard, locale(抓取子階段之每輪依賴,captureRuntime 之 deps), clock, dirs, data, vocab, settings, ai, domains }
     *   (vocab＝已解析之詞彙表;locale＝語言設定)
     */
    const buildDeps = (stores, log) => ({
        stores,
        // 去重身分查詢、抓取器 registry、本機網路判斷(null＝不判斷)、語言設定:captureRuntime 之 deps(與下游之總組裝同一份)
        ...rt.deps(stores, log),
        clock,
        dirs,
        data,
        // 已解析之詞彙表(kbLabel、domain);data.vocab 是安裝方原給之覆寫
        vocab: vocabResolved,
        settings,
        ai,
        domains,
    })

    /**
     * 執行一輪抓取(寫開工標記 → 開集合 → 跑管線(鎖、時間預算) → 符合度掃描(可選) → 寫執行摘要 → 收尾鉤子(可選) → 關集合)
     *
     * 符合度掃描(settings.capture.standards.scanEachRun):可確定性判定之抓取標準,計數入執行摘要;不呼叫 AI
     *
     * @returns {Promise} 回傳 Promise，resolve 回傳 report(runPipeline 之產物,另含 summaryFile 與 afterRun(收尾鉤子之回傳值));
     *   未取得執行鎖時 report.lockSkipped 為 true,不掃描、不寫摘要、不觸發收尾鉤子
     */
    const run = createRoundRunner({
        name: pipelineName,
        dirs,
        clock,
        mkLog,
        startupWarnings,
        runtime,
        openStores,
        closeStores,
        buildDeps,
        stages: [captureObject],
        ai,
        roundLog,
        scan: {
            enabled: () => settings.capture.standards.scanEachRun === true,
            audit: ({ stores }) => auditCaptureStandards({ stores, settings, locale: rt.locale }, { material: true }),
            countsOf: standardsCountsOf,
        },
        afterRun,
    })

    return {
        run,
        /** 維運入口(工具用):同一套集合定義,呼叫端自負開關 */
        openStores,
        closeStores,
        /**
         * 維運入口:不開管線時取得依賴與執行期生效值(與管線實際使用同源,皆取自 resolveRuntime)
         *
         * @returns {Object} 回傳 { dirs, settings, clock, ai, domains, registry, identity(去重身分;管線外登記文件之 id 須經之,externalDocOf),
         *   locale(語言設定), lmdb, data, vocab(已解析之詞彙表), deadlineMs, lockStaleMs,
         *   startupWarnings, scheduleLimitMin(未給為 null), envFile, aiWorkspace(注入 cfg.aiAdapter 時為 null), lockFile(cfg.lock 為 false 時為 null),
         *   collections(openStores 開啟之集合對外名) }；envFile／aiWorkspace／lockFile 為絕對路徑(相對路徑以當下 cwd 解析,與實際讀寫相同)
         */
        info: () => assemblyInfoOf({
            dirs,
            settings,
            clock,
            ai,
            domains,
            extra: { registry, identity, locale: rt.locale },
            lmdb,
            data,
            vocab: vocabResolved,
            runtime,
            startupWarnings,
            collections: storeNames,
        }),
    }
}

export default createKnowledgeCapture
