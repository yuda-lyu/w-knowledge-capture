// assemblyKit.mjs — 總組裝之共用件:與各工作之內容無關之組裝機制(本套件之 createKnowledgeCapture 與下游套件之總組裝共用同一份)
//
// 【範圍】cfg 鍵檢核、workDir 展開之目錄、時鐘、提示詞覆寫(cfg 層;驗證與 SIGS 之形狀在 core/prompts,各層同一份)、提示詞覆寫與注入之 domain
//   之衝突、domain 之注入與合併(mergeDomains:只收執行期件之 opt.domains)、cfg.data 之鍵集與只讀詞彙者之解析、子階段設定、儲存(集合鍵、
//   預設名、選開之集合)、日誌工廠／收尾鉤子／調度層之形狀、AI 調度層之建構與其事件日誌、啟動期警告、功能表之必填檢核(featureProblemsOf:
//   各工作宣告「功能 × 開啟判準 × 判定小組之必填席 × 所需 domain 成員」之表,建構期、執行期、判定小組之必填與席位檢核工具同讀)、
//   集合之開關、管線名(cfg.name 取代內建名)、每輪之序列、info() 之共同欄、下游總組裝之每輪依賴(deps)之共同欄(DEPS_COMMON_KEYS)。
//   交 resolveRuntime 之鍵(RUNTIME_CFG_KEYS／runtimeCfgOf)在 core/runtime(與 resolveRuntime 同處)。
//   各工作之執行期件(如抓取之 captureRuntime)、每輪依賴(deps)之值、子階段物件與符合度掃描之內容不在此,由呼叫端以參數與回呼帶入。
// 【為何收斂於此】這些機制在各總組裝皆為同型:各寫一份時,任一側改了訊息、序列或時限,另一側即漂移,而外部巡檢依賴同一組字樣與序列。
// 【只收值,不讀 cfg】各函數之參數為 cfg 之值(呼叫端讀 cfg.<鍵> 後傳入):cfg 之鍵集屬各總組裝(其 CFG_KEYS),本檔不暗中讀取任何鍵——
//   否則總組裝會出現「接受卻無人讀」或「讀了卻未列」之鍵。錯誤訊息中之鍵名(cfg.dirs 等)為各總組裝共通之鍵。
// 【檢核順序屬呼叫端】形狀錯誤之訊息不得被後段之檢核(如 AI 席位)搶先:各檢核分開匯出,由呼叫端依其順序逐一呼叫。
// 【選開之集合】下游工作之產物集合(如筆記、核心)對本工作是選用:cfg 值 false／未給＝不開、true＝開(集合名取 lmdb.cls 或預設)、
//   字串＝開且即集合名;兩處給了不同之集合名即拋(擇一給),不默默以其一為準。
// 【調度層之所需函數(need)】預設只檢 callJson(各工作之階段只呼叫它);另需其他函數之總組裝(如多棒工作流之 getWkf／seatSpec)以 need 宣告——
//   注入者與內建者同一判準(內建者於宣告時才檢,未宣告照舊),缺漏於組裝期即爆,不留到第一次呼叫才以「不是函數」失敗。
// 【當輪日誌】AI 調度層於建構期建立而日誌逐輪建立:調度層之事件(供應商健康／額度／能力)經轉接寫入當輪日誌——每輪開始時換成該輪之
//   日誌、結束時移除;輪外之事件(維運工具於管線外呼叫)不記。同一 flow 並發多輪時(其一因執行鎖略過),結束者只移除自己,
//   執行中者之事件仍寫入其日誌。注入 cfg.aiAdapter 時不建調度層、亦不接事件(調度層屬注入方)。
// 【每輪序列】建目錄 → 日誌 → 啟動期警告 → 開工標記 → 開集合 → 管線(鎖、時間預算) → 未取得鎖即回 → 符合度掃描(回呼;逾時間預算略過、
//   失敗只留 warn) → 執行摘要 run.json → 收尾鉤子(失敗只留 warn) → 關集合。收尾讀 run.json 時當輪的已存在;未取得鎖＝本輪未執行,
//   不掃描、不寫摘要、不收尾(寫了會被外部巡檢當成一輪早夭的執行)。開工標記與執行摘要為附加產物,寫入失敗只留 warn。

import path from 'path'
import isobj from 'wsemi/src/isobj.mjs'
import isarr from 'wsemi/src/isarr.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import fsCreateFolder from 'wsemi/src/fsCreateFolder.mjs'
import WOrmDefault from 'w-orm-lmdb/src/WOrmLmdb.mjs'
import W from 'w-data-pipeline/src/WDataPipeline.mjs'
import { acquireLock, genClockTZ, oneline, createLogger } from './runnerPackage.mjs'
import { given, checkKeys } from './util/values.mjs'
import { promptSigText, promptSigsProblem } from './prompts.mjs'
import { expandDirs } from './dirs.mjs'
import { buildRunSummary, writeRunSummary, writeRunStart } from './ops/runSummary.mjs'
import { createAiAdapter } from './ai/adapter.mjs'

/**
 * cfg.lmdb 之可用鍵
 *
 * @type {Array}
 */
const LMDB_KEYS = Object.freeze(['WOrm', 'path', 'db', 'cls'])

/** 預設庫名:各工作之集合預設同庫,共用一份 LMDB 時不必遷移 */
const LMDB_DB_DEFAULT = 'knowledge'

/** 預設時區(cfg.clock 與 cfg.timeZone 皆未給時) */
const TIME_ZONE_DEFAULT = 'Asia/Taipei'

/** 整組置換之 AI 調度層預設所需之函數(各總組裝之階段只呼叫 callJson;另需者以 need 宣告) */
const AI_ADAPTER_NEED_DEFAULT = Object.freeze(['callJson'])

/** AI 調度層(core/ai/adapter)公開函數之呼叫形式(所需函數之錯誤訊息用;未列之名只列名) */
const AI_ADAPTER_SIGS = Object.freeze({
    callJson: 'callJson(prompt, check, { spec })',
    validateSeats: 'validateSeats(seats)',
    chainFor: 'chainFor(spec)',
    drainStats: 'drainStats()',
    recordCall: 'recordCall(r)',
    aiUsageToday: 'aiUsageToday()',
    available: 'available()',
    getWkf: 'getWkf()',
    seatSpec: 'seatSpec(seat, promptLen)',
})

/**
 * info() 之共同欄(依序;各工作之專屬欄排在 domains 之後,不得與之同名)
 *
 * @type {Array}
 */
const INFO_COMMON_KEYS = Object.freeze(['dirs', 'settings', 'clock', 'ai', 'domains', 'lmdb', 'data', 'vocab', 'deadlineMs', 'lockStaleMs', 'startupWarnings', 'scheduleLimitMin', 'envFile', 'aiWorkspace', 'lockFile', 'collections'])

/**
 * 每輪依賴(deps)之共同欄(依序):deps 欄集之單一來源——下游套件之總組裝之 buildDeps 取之組 deps(各欄之值由總組裝給;
 *   與 info() 之共同欄 INFO_COMMON_KEYS 同處定義,兩組欄之增減在此一處對照)
 *
 * @type {Array}
 */
export const DEPS_COMMON_KEYS = Object.freeze(['stores', 'clock', 'dirs', 'data', 'vocab', 'locale', 'settings', 'ai', 'domains'])

// 鍵集檢核(「不認得之鍵」之訊息只一種格式)在 util/values(提示詞覆寫之驗證、詞彙表之解析同取,不載入本檔之執行期依賴);此處轉出同一實體
export { checkKeys }

/**
 * cfg.dirs 之檢核與目錄展開:可用鍵即 expandDirs 之鍵(基本目錄＋extra 宣告之下游目錄),各值須為非空路徑字串——
 *   打錯之目錄鍵若靜默接受,該目錄會落在預設處
 *
 * @param {String} workDir 輸入工作目錄路徑字串(normalizeWorkDir 之產物)
 * @param {*} dirsCfg 輸入 cfg.dirs，未給代表全由 workDir 展開
 * @param {Object} [extra={}] 輸入下游目錄 { 鍵: 相對 workDir 之子路徑 }(見 core/dirs 之 expandDirs；不隨 knowledge 之覆寫移動)
 * @returns {Object} 回傳全部輸出目錄物件 { db, log, tmp, state, knowledge, ...extra }(cfg.dirs 逐鍵覆寫)
 * @throws {Error} cfg.dirs 非物件、含不認得之鍵、值非非空字串，或 extra 重定基本目錄時拋出
 * @example
 * console.log(resolveDirsCfg('c:/kb', undefined, { notes: 'knowledge/notes' }).notes)
 * // => c:/kb/knowledge/notes
 *
 * console.log(resolveDirsCfg('c:/kb', { notes: 'd:/vault/notes' }, { notes: 'knowledge/notes' }).notes)
 * // => d:/vault/notes
 */
export function resolveDirsCfg(workDir, dirsCfg, extra) {
    if (given(dirsCfg)) {
        if (!isobj(dirsCfg)) throw new Error('cfg.dirs 須為物件 { 目錄鍵: 路徑 }')
        checkKeys(dirsCfg, Object.keys(expandDirs(workDir, {}, extra)), 'cfg.dirs')
        for (const [k, v] of Object.entries(dirsCfg)) {
            if (!isestr(v)) throw new Error(`cfg.dirs.${k} 須為非空路徑字串`)
        }
    }
    return expandDirs(workDir, dirsCfg || {}, extra)
}

/**
 * cfg.clock／cfg.timeZone 之檢核與時鐘建立:給了時鐘即原樣採用;未給依時區(預設 Asia/Taipei)建立,
 *   並於建構期先取一次時刻(無效時區於第一次取時刻才拋,設定錯誤須在啟動期爆)
 *
 * @param {*} clock 輸入 cfg.clock(wsemi 之 genClockTZ 產物)，未給依 timeZone 建立
 * @param {*} timeZone 輸入 cfg.timeZone(IANA 時區字串)，未給為 Asia/Taipei
 * @returns {Object} 回傳時鐘物件
 * @throws {Error} cfg.clock 非時鐘物件(缺 iso8／stamp8／date8)、cfg.timeZone 非非空字串或無效時拋出
 * @example
 * console.log(resolveClockCfg(undefined, 'UTC').iso8().endsWith('+00:00'))
 * // => true
 */
export function resolveClockCfg(clock, timeZone) {
    if (given(clock) && !(isobj(clock) && isfun(clock.iso8) && isfun(clock.stamp8) && isfun(clock.date8))) {
        throw new Error('cfg.clock 須為時鐘物件（wsemi 之 genClockTZ 產物：iso8／stamp8／date8…）')
    }
    if (given(timeZone) && !isestr(timeZone)) throw new Error('cfg.timeZone 須為 IANA 時區字串（如 Asia/Taipei）')
    if (given(clock)) return clock
    // 無效時區之拋出點依時鐘實作而異(建立時驗 IANA 名稱、或第一次取時刻才拋):兩者皆收為同一設定錯誤訊息
    try {
        const out = genClockTZ(timeZone || TIME_ZONE_DEFAULT)
        out.iso8()
        return out
    }
    catch (e) {
        throw new Error(`cfg.timeZone 無效（${timeZone}）：${e.message}`)
    }
}

/**
 * cfg.prompts 之檢核:各鍵為提示詞函數(輸出契約固定,由各工作之領域物件驗;SIGS 與訊息同 core/prompts 之 promptOverridesOf)
 *
 * @param {*} p 輸入 cfg.prompts，未給代表全用內建提示詞
 * @param {Object} sigs 輸入可用鍵與其函數形式 { 鍵: { params, returns? } }(各 domain 檔之 SIGS;錯誤訊息用)
 * @returns {Object} 回傳提示詞覆寫物件(只含有給之鍵)
 * @throws {Error} sigs 不合形狀、cfg.prompts 非物件、含不認得之鍵或值非函數時拋出
 * @example
 * console.log(Object.keys(resolvePromptsCfg({ area: () => 'p' }, { area: { params: '(candidates, areas, ctx)' } })))
 * // => [ 'area' ]
 */
export function resolvePromptsCfg(p, sigs) {

    //check
    const sp = promptSigsProblem(sigs)
    if (sp) {
        throw new Error(`resolvePromptsCfg 需要 sigs（{ 鍵: { params, returns? } }）：sigs ${sp}`)
    }

    if (!given(p)) return {}
    const keys = Object.keys(sigs)
    if (!isobj(p)) throw new Error(`cfg.prompts 須為物件 { ${keys.map((k) => `${k}?`).join(', ')} }`)
    checkKeys(p, keys, 'cfg.prompts')
    const out = {}
    for (const k of keys) {
        if (!given(p[k])) continue
        if (!isfun(p[k])) throw new Error(`cfg.prompts.${k} 須為函數 ${promptSigText(sigs[k])}`)
        out[k] = p[k]
    }
    return out
}

/**
 * 提示詞覆寫與整組注入之 domain 之衝突(執行期件之單一判定):同一 domain 同給提示詞覆寫與整組 domain 時,注入者整組置換內建者、
 *   提示詞覆寫對它不生效——其一會靜默失效
 *
 * @param {*} prompts 輸入提示詞覆寫 { 鍵: Function|null|undefined }(非物件視為無覆寫)
 * @param {*} injected 輸入注入之 domain { domain 之鍵: domain }(非物件視為無注入)
 * @param {Object} ownerOf 輸入提示詞之鍵 → 其所屬 domain 之鍵
 * @returns {Array} 回傳衝突之說明陣列(依提示詞之鍵序;無衝突為空陣列)
 * @example
 * console.log(promptDomainConflicts({ faith: () => 'p', triage: null }, { summarize: {} }, { faith: 'summarize', triage: 'triage' }).length)
 * // => 1
 */
export function promptDomainConflicts(prompts, injected, ownerOf) {
    if (!isobj(prompts) || !isobj(injected) || !isobj(ownerOf)) return []
    return Object.keys(prompts)
        .filter((p) => given(prompts[p]) && isestr(ownerOf[p]) && given(injected[ownerOf[p]]))
        .map((p) => `cfg.prompts.${p} 與 cfg.domains.${ownerOf[p]} 擇一：注入之 domain 整組置換內建者，提示詞覆寫對它不生效（要以內建者改提示詞，請只給 cfg.prompts；要整組置換，請把提示詞寫進注入之 domain）`)
}

/**
 * domain 之注入與內建者合併(各工作之執行期件同一機制;注入只經執行期件之 opt.domains——各總組裝明傳自己之子集,不退回整份 cfg.domains):
 *   給了的整組置換、沒給的沿用內建。注入者須具備內建 domain 之全部成員(o.optional 所列者除外——依功能而必填者由功能表判;函數成員須為函數、
 *   資料成員不可為 undefined),另交 o.check 判該工作之形狀(如詞彙表須經解析、型別定義須合規格)——子階段與納入閘會讀之,缺一要到執行期才爆
 *
 * @param {Object} builtin 輸入內建 domain { 鍵: domain }(其鍵即可用鍵)
 * @param {*} injected 輸入注入之 domain(執行期件之 opt.domains)，未給(undefined 或 null)代表全用內建
 * @param {Object} [o={}] 輸入 { optional?:{ 鍵: Array(選填之成員) }, factories?:{ 鍵: String(建議之工廠寫法,如 'createSummarizeDomain({ vocab })'——帶詞彙,照做者不會丟失安裝方之詞彙) },
 *   check?:(鍵, domain) => Array(形狀之問題;空陣列為合格) }
 * @returns {Object} 回傳生效之 domain { 鍵: domain }
 * @throws {Error} injected 給了而非物件、含不認得之鍵、某項非物件、缺成員或 o.check 回問題時拋出
 * @example
 * const builtin = { a: { buildPrompt: () => 'p', vocab: {} } }
 * console.log(mergeDomains(builtin, undefined) === builtin, mergeDomains(builtin, { a: { buildPrompt: () => 'q', vocab: {} } }).a.buildPrompt())
 * // => true q
 */
export function mergeDomains(builtin, injected, o = {}) {
    if (!given(injected)) return builtin
    const keys = Object.keys(builtin)
    if (!isobj(injected)) throw new Error(`cfg.domains 須為物件 { ${keys.map((k) => `${k}?`).join(', ')} }`)
    checkKeys(injected, keys, 'cfg.domains')
    const out = { ...builtin }
    for (const [k, d] of Object.entries(injected)) {
        if (!given(d)) continue
        if (!isobj(d)) throw new Error(`cfg.domains.${k} 須為 domain 物件`)
        const hint = `建議以 ${isestr(o?.factories?.[k]) ? o.factories[k] : '內建 domain 之工廠'} 之產物展開後覆寫`
        const optional = isarr(o?.optional?.[k]) ? o.optional[k] : []
        const missing = Object.keys(builtin[k]).filter((m) => !optional.includes(m)).filter((m) => (isfun(builtin[k][m]) ? !isfun(d[m]) : d[m] === undefined))
        if (missing.length) throw new Error(`cfg.domains.${k} 缺成員「${missing.join('、')}」（須具備內建 domain 之全部成員；${hint}）`)
        const bad = isfun(o?.check) ? o.check(k, d) : []
        if (isarr(bad) && bad.length) throw new Error(`cfg.domains.${k} 不合：${bad.join('；')}（${hint}）`)
        out[k] = d
    }
    return out
}

/**
 * cfg.data 之鍵集檢核(只檢鍵集;形狀與逐項之檢核在各工作之資料解析——非物件者由其拋形狀之錯誤)
 *
 * @param {*} d 輸入 cfg.data
 * @param {Array} keys 輸入可用鍵(各工作所讀之資料鍵之聯集)
 * @returns {undefined} 無回傳值
 * @throws {Error} 物件而含不認得之鍵時拋出(checkKeys 之格式)
 * @example
 * checkDataKeys({ vocab: {} }, ['vocab'])
 * console.log('ok')
 * // => ok
 */
export function checkDataKeys(d, keys) {
    if (isobj(d)) checkKeys(d, keys, 'cfg.data')
}

/**
 * 只讀詞彙覆寫之 cfg.data 之檢核與正規化(各工作之資料解析同一份;抓取另讀種子與網格主題,自有其解析)
 *
 * @param {*} d 輸入 cfg.data，未給代表全用預設
 * @param {Object} [o={}] 輸入 { keys?:Array(訊息所列之可用鍵,預設 ['vocab']), vocabKeysOf?:String(詞彙之可用鍵之出處,訊息用) }
 * @returns {Object} 回傳 { vocab:Object|null(安裝方原給之詞彙覆寫;null＝用內建預設) }
 * @throws {Error} 非物件、或 vocab 非物件時拋出
 * @example
 * console.log(resolveDataCfg({ vocab: { domain: '天文學' } }).vocab.domain, resolveDataCfg(undefined).vocab)
 * // => 天文學 null
 */
export function resolveDataCfg(d, o = {}) {
    const keys = isarr(o?.keys) && o.keys.length ? o.keys : ['vocab']
    if (!given(d)) d = {}
    if (!isobj(d)) throw new Error(`cfg.data 須為物件 { ${keys.join(', ')} }`)
    if (given(d.vocab) && !isobj(d.vocab)) throw new Error(`cfg.data.vocab 須為物件（詞彙覆寫${isestr(o?.vocabKeysOf) ? `，鍵見 ${o.vocabKeysOf}` : ''}）`)
    return { vocab: d.vocab || null }
}

/**
 * 子階段設定之檢核:cfg.stages(整組自訂)與 cfg.stageOpts(內建子階段之 opt)擇一
 *
 * @param {*} stages 輸入 cfg.stages
 * @param {*} stageOpts 輸入 cfg.stageOpts
 * @param {Array} stageKeys 輸入內建子階段鍵(依序;cfg.stageOpts 之可用鍵)
 * @returns {undefined} 無回傳值
 * @throws {Error} stageKeys 非非空陣列、stages 非非空陣列、項目不合 { name, run }、子階段重名、stageOpts 形狀不合或含不認得之子階段、
 *   兩者同時給時拋出
 * @example
 * checkStageConfig(undefined, { listFetch: {} }, ['listFetch', 'detailFetch'])
 * console.log('ok')
 * // => ok
 */
export function checkStageConfig(stages, stageOpts, stageKeys) {

    //check
    if (!isarr(stageKeys) || stageKeys.length === 0) {
        throw new Error('checkStageConfig 需要 stageKeys（內建子階段鍵陣列）')
    }

    if (given(stages)) {
        if (!isarr(stages) || stages.length === 0) throw new Error('cfg.stages 須為非空陣列（子階段 { name, run(ctx) }）')
        const names = new Set()
        stages.forEach((st, i) => {
            if (!isobj(st) || !isestr(st.name) || !isfun(st.run)) throw new Error(`cfg.stages[${i}] 須為 { name: 非空字串, run(ctx) }`)
            // 物件 report 以子階段名為鍵,重名會互相覆蓋
            if (names.has(st.name)) throw new Error(`cfg.stages 有重複之子階段名：${st.name}`)
            names.add(st.name)
        })
        // 給了自訂子階段時內建子階段不建立,其 opt 無處生效——兩者並給即設定矛盾
        if (given(stageOpts)) throw new Error('cfg.stages（整組自訂子階段）與 cfg.stageOpts（內建子階段之 opt）擇一：自組子階段請直接對各子階段工廠傳 opt')
    }
    if (given(stageOpts)) {
        if (!isobj(stageOpts)) throw new Error(`cfg.stageOpts 須為物件 { ${stageKeys.join(', ')} }`)
        checkKeys(stageOpts, stageKeys, 'cfg.stageOpts')
        for (const [k, v] of Object.entries(stageOpts)) {
            if (given(v) && !isobj(v)) throw new Error(`cfg.stageOpts.${k} 須為物件（該子階段工廠之 opt）`)
        }
    }
}

/**
 * 選開之集合之檢核(檔頭【選開之集合】):各 cfg 值須為 false／未給(不開)、true(開)或集合名字串(開)
 *
 * @param {Object} [optional] 輸入 { 集合對外名: { value:cfg 之值, label:集合之稱呼(訊息用，如 '筆記') } }，未給代表無選開之集合
 * @returns {Array} 回傳開啟者之對外名陣列(依 optional 之鍵序)
 * @throws {Error} optional 給了而非物件，或某 cfg 值非 false／true／非空字串時拋出(訊息指名該鍵)
 * @example
 * console.log(checkOptionalCollections({ notes: { value: true, label: '筆記' }, cores: { value: false, label: '核心' } }))
 * // => [ 'notes' ]
 */
export function checkOptionalCollections(optional) {

    //check
    if (!given(optional)) {
        return []
    }
    if (!isobj(optional)) {
        throw new Error('checkOptionalCollections 需要 { 集合對外名: { value, label } }')
    }

    const on = []
    for (const [key, o] of Object.entries(optional)) {
        const v = isobj(o) ? o.value : undefined
        const label = isobj(o) && isestr(o.label) ? o.label : key
        if (given(v) && typeof v !== 'boolean' && !isestr(v)) {
            throw new Error(`cfg.${key} 須為 false（預設，不開${label}集合）、true（開 ${key} 集合）或${label}集合名字串`)
        }
        if (v === true || isestr(v)) on.push(key)
    }
    return on
}

/**
 * cfg.lmdb 之檢核與展開:WOrm 內建可注入;集合名可覆寫(預設即對外名,與各工作共用同一庫時不必遷移);
 *   選開之集合以 cfg 值給集合名時與 cfg.lmdb.cls 同一鍵擇一給(檔頭【選開之集合】)
 *
 * @param {*} l 輸入 cfg.lmdb，未給代表全用預設
 * @param {Object} dirs 輸入目錄物件(取 db 為預設路徑)
 * @param {Object} opt 輸入設定物件
 * @param {Array} opt.keys 輸入集合之對外名陣列(cfg.lmdb.cls 之可用鍵;依序)
 * @param {Object} [opt.defaults={}] 輸入預設集合名 { 對外名: 集合名 }，未列者即對外名
 * @param {Object} [opt.optional] 輸入選開之集合 { 對外名: { value:cfg 之值, label:集合之稱呼 } }(對外名須在 keys 內;形狀同 checkOptionalCollections)
 * @returns {Object} 回傳 { WOrm, path(預設 dirs.db), db(預設 'knowledge'), cls:{ 對外名: 集合名 }(依 keys 之序) }
 * @throws {Error} opt.keys 非非空字串陣列、dirs 缺 db、opt.defaults／opt.optional 含 keys 以外之鍵(呼叫端錯誤);
 *   cfg.lmdb 形狀不合、含不認得之鍵、cls 之值非非空字串、選開之集合之 cfg 值形狀不合，或其集合名與 cfg.lmdb.cls 不一致時拋出
 * @example
 * let l = resolveLmdbCfg({ cls: { docs: 'myDocs' } }, { db: 'c:/kb/db' }, { keys: ['docs', 'notes'], optional: { notes: { value: 'myNotes', label: '筆記' } } })
 * console.log(l.path, l.db, l.cls)
 * // => c:/kb/db knowledge { docs: 'myDocs', notes: 'myNotes' }
 */
export function resolveLmdbCfg(l, dirs, opt) {

    //check
    if (!isobj(opt)) {
        opt = {}
    }
    const keys = opt.keys
    if (!isarr(keys) || keys.length === 0 || !keys.every(isestr)) {
        throw new Error('resolveLmdbCfg 需要 opt.keys（集合之對外名陣列）')
    }
    if (!isobj(dirs) || !isestr(dirs.db)) {
        throw new Error('resolveLmdbCfg 需要 dirs（含 db）')
    }
    const defaults = isobj(opt.defaults) ? opt.defaults : {}
    const optional = isobj(opt.optional) ? opt.optional : {}
    for (const [what, o] of [['defaults', defaults], ['optional', optional]]) {
        const stray = Object.keys(o).filter((k) => !keys.includes(k))
        if (stray.length) throw new Error(`resolveLmdbCfg 之 opt.${what} 含 keys 以外之集合：${stray.join('、')}`)
    }

    if (!given(l)) l = {}
    if (!isobj(l)) throw new Error('cfg.lmdb 須為物件 { WOrm?, path?, db?, cls? }')
    checkKeys(l, LMDB_KEYS, 'cfg.lmdb')
    if (given(l.WOrm) && !isfun(l.WOrm)) throw new Error('cfg.lmdb.WOrm 須為 ORM 建構函數（w-orm-lmdb 之 WOrm 或相容實作）')
    for (const k of ['path', 'db']) {
        if (given(l[k]) && !isestr(l[k])) throw new Error(`cfg.lmdb.${k} 須為非空字串`)
    }
    if (given(l.cls)) {
        if (!isobj(l.cls)) throw new Error('cfg.lmdb.cls 須為物件 { 對外名: 集合名 }')
        checkKeys(l.cls, keys, 'cfg.lmdb.cls')
        for (const [k, v] of Object.entries(l.cls)) {
            if (!isestr(v)) throw new Error(`cfg.lmdb.cls.${k} 須為非空字串（集合名）`)
        }
    }
    checkOptionalCollections(optional)
    const cls = { ...Object.fromEntries(keys.map((k) => [k, isestr(defaults[k]) ? defaults[k] : k])), ...(l.cls || {}) }
    for (const [key, o] of Object.entries(optional)) {
        const v = isobj(o) ? o.value : undefined
        if (!isestr(v)) continue
        const label = isestr(o.label) ? o.label : key
        if (isestr(l.cls?.[key]) && l.cls[key] !== v) throw new Error(`cfg.${key}（${v}）與 cfg.lmdb.cls.${key}（${l.cls[key]}）不一致：${label}集合名擇一給`)
        cls[key] = v
    }
    return { WOrm: l.WOrm || WOrmDefault, path: l.path || dirs.db, db: l.db || LMDB_DB_DEFAULT, cls }
}

/**
 * cfg.logFactory 之檢核:給了函數即用之;未給為預設日誌工廠(每輪一檔 <dir>/<日>/<時間戳>-run.log,同時輸出 stdout)
 *
 * @param {*} logFactory 輸入 cfg.logFactory
 * @param {Object} [opt={}] 輸入設定物件(預設日誌工廠用)
 * @param {String} opt.dir 輸入日誌根目錄(dirs.log)
 * @param {Object} opt.clock 輸入時鐘物件
 * @returns {Function} 回傳日誌工廠 () => logger
 * @throws {Error} cfg.logFactory 給了而非函數，或須用預設工廠而缺 dir／clock 時拋出
 * @example
 * let f = () => ({ info: () => {}, warn: () => {}, error: () => {} })
 * console.log(resolveLogFactory(f) === f)
 * // => true
 */
export function resolveLogFactory(logFactory, opt = {}) {
    if (given(logFactory) && !isfun(logFactory)) throw new Error('cfg.logFactory 須為函數 () => logger { info, warn, error }')
    if (isfun(logFactory)) return logFactory
    const { dir, clock } = isobj(opt) ? opt : {}
    if (!isestr(dir) || !isobj(clock)) throw new Error('resolveLogFactory 之預設日誌工廠需要 { dir, clock }')
    return () => createLogger('run', { dir, clock })
}

/**
 * cfg.afterRun 之檢核:函數即收尾鉤子;false 或未給即無
 *
 * @param {*} afterRun 輸入 cfg.afterRun
 * @returns {Function|null} 回傳收尾鉤子，無則 null
 * @throws {Error} 給了 false 與函數以外之值時拋出
 * @example
 * console.log(resolveAfterRun(false), resolveAfterRun(undefined))
 * // => null null
 */
export function resolveAfterRun(afterRun) {
    if (given(afterRun) && afterRun !== false && !isfun(afterRun)) {
        throw new Error('cfg.afterRun 須為函數（收尾鉤子 ({ report, summaryFile, log, deps }) => 結果）或 false；本套件無內建巡檢')
    }
    return isfun(afterRun) ? afterRun : null
}

/**
 * 所需之調度層函數名(need)之檢核與正規化:未給為預設(只需 callJson);給了須為函數名之非空字串陣列(重複者去除)
 *
 * @param {*} need 輸入函數名陣列
 * @param {String} name 輸入參數名(錯誤訊息用，如 'checkAiAdapter 之 opt.need')
 * @returns {Array} 回傳函數名陣列
 * @throws {Error} 給了而非非空字串之非空陣列時拋出(呼叫端錯誤)
 */
function aiAdapterNeedOf(need, name) {
    if (!given(need)) return [...AI_ADAPTER_NEED_DEFAULT]
    if (!isarr(need) || need.length === 0 || !need.every(isestr)) throw new Error(`${name} 須為函數名之非空字串陣列（如 ['callJson']）`)
    return [...new Set(need)]
}

/**
 * cfg.aiAdapter 之檢核:給了即須為物件且具所需之函數(整組置換之 AI 調度層;預設只需 callJson,另需者如工作流入口之 getWkf／seatSpec 以 opt.need 宣告)
 *
 * @param {*} aiAdapter 輸入 cfg.aiAdapter
 * @param {Object} [opt={}] 輸入設定物件，非物件視為 {}
 * @param {Array} [opt.need=['callJson']] 輸入所需之函數名陣列(非空字串之非空陣列;給了即取代預設)
 * @returns {undefined} 無回傳值
 * @throws {Error} opt.need 形狀不合時拋出(呼叫端錯誤);aiAdapter 給了而非物件或缺任一所需函數時拋出，訊息列出所需之函數(預設時為
 *   「cfg.aiAdapter 須為具 callJson(prompt, check, { spec }) 之物件」)
 * @example
 * checkAiAdapter({ callJson: async () => ({ ok: false }) })
 * console.log('ok')
 * // => ok
 *
 * try {
 *     checkAiAdapter({ callJson: async () => ({ ok: false }) }, { need: ['getWkf', 'seatSpec'] })
 * }
 * catch (e) {
 *     console.log(e.message)
 * }
 * // => cfg.aiAdapter 須為具 getWkf()、seatSpec(seat, promptLen) 之物件
 */
export function checkAiAdapter(aiAdapter, opt = {}) {

    //check
    if (!isobj(opt)) {
        opt = {}
    }
    const need = aiAdapterNeedOf(opt.need, 'checkAiAdapter 之 opt.need')

    if (given(aiAdapter) && !(isobj(aiAdapter) && need.every((k) => isfun(aiAdapter[k])))) {
        throw new Error(`cfg.aiAdapter 須為具 ${need.map((k) => (Object.prototype.hasOwnProperty.call(AI_ADAPTER_SIGS, k) ? AI_ADAPTER_SIGS[k] : k)).join('、')} 之物件`)
    }
}

/**
 * 建立當輪日誌之轉接(檔頭【當輪日誌】):每輪開始時 enter、結束時 leave;寫入一律送往最近進入且尚未離開之日誌,無則不記
 *
 * @returns {Object} 回傳 { enter(log), leave(log), current():logger|null, warn(msg) }
 * @example
 * let rl = createRoundLog()
 * let lines = []
 * let log = { warn: (m) => lines.push(m) }
 * rl.enter(log)
 * rl.warn('a')
 * rl.leave(log)
 * rl.warn('b')
 * console.log(lines)
 * // => [ 'a' ]
 */
export function createRoundLog() {
    const active = []
    const current = () => (active.length ? active[active.length - 1] : null)
    return {
        enter: (log) => {
            if (log) active.push(log)
        },
        leave: (log) => {
            const i = active.lastIndexOf(log)
            if (i >= 0) active.splice(i, 1)
        },
        current,
        warn: (msg) => {
            current()?.warn?.(msg)
        },
    }
}

/**
 * AI 調度層之事件回呼(onHealth／onOversize／onPool)→ 當輪日誌之 WARN 一行(字樣為外部巡檢之判讀對象);
 *   回呼本身不拋錯(日誌失敗或事件形狀不合皆不影響呼叫)
 *
 * @param {Object} roundLog 輸入當輪日誌之轉接(createRoundLog 之產物)，未給即不記
 * @param {Object} [clock] 輸入時鐘物件(取 timeZone 格式化額度事件之時刻;未給時區即系統時區)
 * @param {Object} [opt={}] 輸入設定物件
 * @param {String} [opt.lang='zh-TW'] 輸入語言代碼(時刻之數字格式之地區;語言設定 locale.code)
 * @returns {Object} 回傳 { onHealth, onOversize, onPool }(core/ai/adapter 之建構 opt)
 * @example
 * let lines = []
 * let h = aiEventLoggersOf({ warn: (m) => lines.push(m) })
 * h.onOversize({ providerId: 'p', limit: 100, promptLen: 120 })
 * console.log(lines[0])
 * // => 供應商能力：p 之 prompt 上限 100 字元，本輪有呼叫達 120 字元而改由遞補承接（未 spawn）
 */
export function aiEventLoggersOf(roundLog, clock, opt = {}) {
    const lang = isobj(opt) && isestr(opt.lang) ? opt.lang : 'zh-TW'
    /**
     * 時刻(毫秒)→「時:分」(依時鐘之時區);非有限數、時區或語言代碼無效為 ?
     *
     * @param {Number} ms 輸入時刻毫秒數
     * @returns {String} 回傳時分字串
     */
    const hm = (ms) => {
        if (!Number.isFinite(ms)) return '?'
        try {
            return new Intl.DateTimeFormat(lang, { timeZone: clock?.timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(ms)
        }
        catch {
            return '?'
        }
    }
    /**
     * 包成不拋錯之回呼:組字樣並寫入當輪日誌
     *
     * @param {Function} lineOf 輸入 (ev) => 日誌字樣
     * @returns {Function} 回傳 (ev) => undefined
     */
    const say = (lineOf) => (ev) => {
        try {
            roundLog?.warn?.(lineOf(isobj(ev) ? ev : {}))
        }
        catch { /* 日誌失敗不影響呼叫 */ }
    }
    return {
        // ev.keys:整組金鑰皆敗觸發者(每次連續失敗＝該條目全部金鑰各試一次皆敗),否則「連續 3 次」會被讀成 3 次嘗試
        onHealth: say((ev) => `供應商健康：${ev.providerId} 連續 ${ev.streak} 次 ${ev.errorType} 失敗${ev.keys ? `（每次 ${ev.keys} 把金鑰皆敗）` : ''}（${ev.error}），降序冷卻`),
        // prompt 逾該條目長度上限而於呼叫前被剔除(省掉一次 spawn);同一條目只記一行,次數由執行摘要彙報
        onOversize: say((ev) => `供應商能力：${ev.providerId} 之 prompt 上限 ${ev.limit} 字元，本輪有呼叫達 ${ev.promptLen} 字元而改由遞補承接（未 spawn）`),
        // 免費池當日額度用盡(ai.pools.oc):opencode CLI 撞限流不返回、會等到逾時,故呼叫前即降至鏈尾;每條目一行
        onPool: say((ev) => `供應商額度：${ev.providerId} 自 ${hm(ev.first)} 起 opencode 日誌回報當日額度用盡（${ev.n} 筆，最近 ${hm(ev.last)}），本輪呼叫前降至鏈尾、照設定遞補，至每日重置（UTC ${ev.resetUtcHour} 時）止`),
    }
}

/**
 * cfg.aiOptions 之可用鍵(安裝端之資產以內建調度層之建構選項給:可用池、逐 kind 之執行檔、跨行程之持久狀態與用量;core/ai/adapter 檔頭)
 *
 * @type {Array}
 */
export const AI_OPTIONS_KEYS = Object.freeze(['providerPick', 'exes', 'persistStore', 'usageCounter'])

/**
 * AI 調度層:cfg.aiAdapter 給了即原樣採用(不建、不接事件);否則建內建調度層(core/ai/adapter)並把其事件接到當輪日誌
 *
 * @param {Object} p 輸入參數物件
 * @param {Object} [p.aiAdapter] 輸入 cfg.aiAdapter(整組置換之調度層)
 * @param {Object} p.ai 輸入解析後之 settings.ai
 * @param {String} [p.envFile] 輸入金鑰檔路徑
 * @param {String} p.workspace 輸入 AI 子進程工作目錄
 * @param {Object} [p.clock] 輸入時鐘物件(用量分日與事件時刻)
 * @param {String} [p.lang] 輸入語言代碼(事件時刻之數字格式;語言設定 locale.code,未給 zh-TW)
 * @param {Function} [p.isNetDown] 輸入本機網路確認函數 () => Promise<Boolean>(非函數即不給)
 * @param {Object} [p.roundLog] 輸入當輪日誌之轉接(createRoundLog 之產物)，未給即事件不記
 * @param {Object} [p.adapterOpt] 輸入調度層之其餘建構 opt(如 preview、acceptTruncated、workflow);其 onPool／onHealth／onOversize 先被呼叫(拋錯不外洩),再記當輪日誌
 * @param {Object} [p.options] 輸入安裝端之調度層建構選項(cfg.aiOptions:鍵限 AI_OPTIONS_KEYS——providerPick、exes、persistStore、usageCounter;
 *   core/ai/adapter 檔頭【安裝端之資產以建構選項給】),透傳 createAiAdapter;套件之 adapterOpt 優先於之;注入 aiAdapter 時只驗形狀、不用
 * @param {Array} [p.need] 輸入所需之調度層函數名陣列(交 checkAiAdapter 之 opt.need;未給＝只需 callJson);給了時內建調度層亦須具之
 *   (同一判準:如工作流入口 getWkf／seatSpec 須於 adapterOpt 給 workflow:true,漏給即於組裝期拋錯)
 * @param {Function} [p.createAdapter] 輸入調度層工廠(測試注入用)，預設 core/ai/adapter 之 createAiAdapter
 * @returns {Object} 回傳 AI 調度層
 * @throws {Error} p.need 形狀不合、p.options 給了而非物件或含不認得之鍵(cfg.aiOptions)、cfg.aiAdapter 給了而不具所需之函數、
 *   調度層建構失敗(見 createAiAdapter)、或給了 p.need 而內建調度層缺所需之函數時拋出
 * @example
 * let roundLog = createRoundLog()
 * let ai = buildAiAdapter({ ai: resolveSettings({}).ai, workspace: './tmp/ai-workspace', clock: genClockTZ('Asia/Taipei'), roundLog })
 * console.log(typeof ai.callJson)
 * // => function
 *
 * let wf = buildAiAdapter({ ai: resolveSettings({}).ai, workspace: './tmp/ai-workspace', roundLog, adapterOpt: { workflow: true }, need: ['getWkf', 'seatSpec', 'recordCall'] })
 * console.log(typeof wf.getWkf, typeof wf.seatSpec, typeof wf.recordCall)
 * // => function function function
 *
 * let mine = { callJson: async () => ({ ok: true }) }
 * console.log(buildAiAdapter({ aiAdapter: mine }) === mine)
 * // => true
 *
 * try { buildAiAdapter({ aiAdapter: mine, need: ['getWkf'] }) } catch (e) { console.log(e.message) }
 * // => cfg.aiAdapter 須為具 getWkf() 之物件
 */
export function buildAiAdapter(p) {

    //check
    if (!isobj(p)) {
        p = {}
    }
    const needGiven = given(p.need)
    const need = aiAdapterNeedOf(p.need, 'buildAiAdapter 之 p.need')
    // 安裝端之建構選項(cfg.aiOptions):形狀於此驗(注入 aiAdapter 時亦驗——打錯之鍵不得靜默接受),值之形狀由 createAiAdapter 驗
    const options = given(p.options) ? p.options : null
    if (options !== null && !isobj(options)) throw new Error(`cfg.aiOptions 須為物件（內建調度層之建構選項：${AI_OPTIONS_KEYS.join('、')}）`)
    if (options) checkKeys(options, AI_OPTIONS_KEYS, 'cfg.aiOptions')

    checkAiAdapter(p.aiAdapter, { need })
    if (given(p.aiAdapter)) return p.aiAdapter
    const make = isfun(p.createAdapter) ? p.createAdapter : createAiAdapter
    const extra = isobj(p.adapterOpt) ? p.adapterOpt : {}
    const loggers = aiEventLoggersOf(p.roundLog, p.clock, { lang: p.lang })
    /**
     * 事件回呼:呼叫端自帶者先呼叫(拋錯不外洩),再記當輪日誌
     *
     * @param {String} k 輸入回呼名(onPool／onHealth／onOversize)
     * @returns {Function} 回傳 (ev) => undefined
     */
    const chain = (k) => {
        if (!isfun(extra[k])) return loggers[k]
        return (ev) => {
            try {
                extra[k](ev)
            }
            catch { /* 呼叫端回呼失敗不影響日誌與呼叫 */ }
            loggers[k](ev)
        }
    }
    const out = make({
        ai: p.ai,
        envFile: p.envFile,
        workspace: p.workspace,
        clock: p.clock,
        ...(isfun(p.isNetDown) ? { isNetDown: p.isNetDown } : {}),
        ...(options || {}),
        ...extra,
        onPool: chain('onPool'),
        onHealth: chain('onHealth'),
        onOversize: chain('onOversize'),
    })
    // 宣告了所需之函數者,內建調度層與注入者同一判準(未宣告者照舊不檢:預設行為不變)
    if (needGiven) {
        const missing = need.filter((k) => !isfun(out?.[k]))
        if (missing.length) throw new Error(`內建 AI 調度層缺所需之函數：${missing.join('、')}（adapterOpt 未開啟對應之機制；如工作流入口 getWkf／seatSpec 須給 workflow:true）`)
    }
    return out
}

/**
 * 啟動期警告之彙整:先交調度層之 validateSeats 檢核席位(不可解析即拋;注入之調度層無此函數者不檢),其 warnings 在前,
 *   其餘警告清單依序併入(每輪開頭以「啟動期檢核：」記入日誌)
 *
 * @param {Object} ai 輸入 AI 調度層
 * @param {Object} seats 輸入席位對照 { 席位路徑: 席位 }(各工作之席位清單)
 * @param {Array} [more=[]] 輸入其餘警告清單之陣列(如 [runtime.warnings, settings.warnings])，各清單非陣列者略過
 * @returns {Array} 回傳警告字串陣列
 * @throws {Error} validateSeats 拋錯(席位不可解析)時原樣拋出
 * @example
 * console.log(startupWarningsOf({ validateSeats: () => ({ warnings: ['w1'] }) }, {}, [['w2'], undefined]))
 * // => [ 'w1', 'w2' ]
 */
export function startupWarningsOf(ai, seats, more = []) {
    const out = []
    if (isfun(ai?.validateSeats)) {
        const r = ai.validateSeats(seats)
        for (const w of r?.warnings || []) out.push(w)
    }
    for (const list of isarr(more) ? more : []) {
        for (const w of isarr(list) ? list : []) out.push(w)
    }
    return out
}

/** 判定小組之席位鍵(依序;功能表之 panel.seats 取其子集) */
const PANEL_SEAT_KEYS = Object.freeze(['first', 'second', 'third'])

/**
 * 設定之巢狀值(路徑以點分隔;中途非物件 → undefined)
 *
 * @param {Object} obj 輸入設定
 * @param {String} p 輸入路徑(如 'relate.standards.ai')
 * @returns {*} 回傳該值
 */
function valueAtPath(obj, p) {
    return String(p || '').split('.').filter(Boolean).reduce((o, k) => (isobj(o) ? o[k] : undefined), obj)
}

/**
 * 功能表中已開啟之功能(依表之序;o.enabled 給了即以之為準,不讀各功能之 on——子階段之選項覆寫設定時用)
 *
 * @param {Array} features 輸入功能表(見 featureProblemsOf)
 * @param {Object} settings 輸入已解析之設定
 * @param {Object} [o={}] 輸入 { enabled?:Array(開啟之功能鍵) }
 * @returns {Array} 回傳已開啟之功能(功能表之項)
 * @example
 * const F = [{ key: 'x', on: (s) => s.x === true }, { key: 'y', on: () => false }]
 * console.log(featuresOnOf(F, { x: true }).map((f) => f.key), featuresOnOf(F, {}, { enabled: ['y'] }).map((f) => f.key))
 * // => [ 'x' ] [ 'y' ]
 */
export function featuresOnOf(features, settings, o = {}) {
    const list = isarr(features) ? features.filter(isobj) : []
    const forced = isarr(o?.enabled) ? new Set(o.enabled) : null
    return list.filter((f) => (forced ? forced.has(f.key) : (isfun(f.on) && f.on(settings) === true)))
}

/**
 * 功能表之問題(各工作之功能、席位與 domain 成員之單一判定;建構期之執行期件、執行期之子階段、判定小組之必填與席位檢核工具同讀,字樣同一份):
 *   已開啟之功能所需之判定小組席位——同一小組(panel.path)之功能共用一組,所缺之席依 first／second／third 之序,一句列出需要所缺之席之開啟者;
 *   依功能而必填之 domain 函數成員——一句列出需要它之開啟者;功能之額外檢核(extra)。功能皆未開 → 無問題(未開之功能不檢其席位與成員)
 *
 * @param {Array} features 輸入功能表 [{ key:String, what:String(稱呼;含開啟之設定), on:(settings)=>Boolean, panel?:{ path:String(設定路徑,不含 settings.),
 *   seats:Array(該功能必填之席) }, members?:Array(依功能而必填之 domain 函數成員), extra?:(settings, domain, domainLabel)=>String(問題說明;'' 為無;
 *   domainLabel 為訊息中 domain 之稱呼——與成員之訊息同一稱呼) }]
 * @param {Object} settings 輸入已解析之設定
 * @param {Object} domain 輸入該工作之 domain(非物件視為缺全部成員)
 * @param {Object} [o={}] 輸入 { enabled?:Array(開啟之功能鍵;見 featuresOnOf), domainLabel?:String(訊息中 domain 之稱呼;預設 'domain'——
 *   總組裝之啟動期以 'cfg.domains.<鍵>' 指出注入之 domain) }
 * @returns {Array} 回傳問題說明陣列(無問題為空陣列;依序:席位〔小組首次出現之序〕、成員〔功能表中首次出現之序〕、額外檢核)
 * @example
 * const F = [{ key: 'x', what: '甲覆核(a.x.enabled)', on: (s) => s.a.x.enabled === true, panel: { path: 'a.ai', seats: ['first', 'second'] }, members: ['buildX'] }]
 * console.log(featureProblemsOf(F, { a: { x: { enabled: true }, ai: { first: { use: 'p' } } } }, {}))
 * // => [ '甲覆核(a.x.enabled)已啟用,但缺席位 settings.a.ai.second', '甲覆核(a.x.enabled)已啟用,但 domain 缺 buildX' ]
 */
export function featureProblemsOf(features, settings, domain, o = {}) {
    const enabled = featuresOnOf(features, settings, o)
    if (!enabled.length) return []
    const out = []
    const seatsOf = (f) => (isarr(f.panel?.seats) ? f.panel.seats : [])
    for (const p of [...new Set(enabled.filter((f) => isestr(f.panel?.path)).map((f) => f.panel.path))]) {
        const fs = enabled.filter((f) => f.panel?.path === p)
        const panel = valueAtPath(settings, p)
        const missing = PANEL_SEAT_KEYS.filter((k) => fs.some((f) => seatsOf(f).includes(k)) && !isobj(panel?.[k]))
        if (!missing.length) continue
        const by = fs.filter((f) => seatsOf(f).some((k) => missing.includes(k)))
        out.push(`${by.map((f) => f.what).join('、')}已啟用,但缺席位 ${missing.map((k) => `settings.${p}.${k}`).join('、')}`)
    }
    const dl = isestr(o?.domainLabel) ? o.domainLabel : 'domain'
    for (const m of [...new Set(enabled.flatMap((f) => (isarr(f.members) ? f.members : [])))]) {
        if (isfun(domain?.[m])) continue
        out.push(`${enabled.filter((f) => isarr(f.members) && f.members.includes(m)).map((f) => f.what).join('、')}已啟用,但 ${dl} 缺 ${m}`)
    }
    for (const f of enabled) {
        const x = isfun(f.extra) ? f.extra(settings, domain, dl) : ''
        if (isestr(x)) out.push(`${f.what}已啟用,但 ${x}`)
    }
    return out
}

/**
 * 集合之開關(每次執行開一組,結束一律關閉——LMDB 檔案鎖不可跨執行持有)
 *
 * @param {Object} lmdb 輸入 resolveLmdbCfg 之產物 { WOrm, path, db, cls }(開集合時才讀,與 info().lmdb 同一物件)
 * @param {Array} names 輸入開啟之集合對外名(依序;各名須在 lmdb.cls)
 * @returns {Object} 回傳 { openStores():{ 對外名: 集合 }(任一開啟失敗即拋,已開啟者先行關閉), closeStores(stores):Promise }
 * @throws {Error} lmdb 形狀不合、names 非非空字串陣列或某名不在 lmdb.cls 時拋出
 * @example
 * need test in nodejs.
 *
 * let { openStores, closeStores } = createStoreOpener(resolveLmdbCfg({}, { db: 'c:/kb/db' }, { keys: ['docs'] }), ['docs'])
 * let st = openStores()
 * await closeStores(st)
 */
export function createStoreOpener(lmdb, names) {

    //check
    if (!isobj(lmdb) || !isfun(lmdb.WOrm) || !isestr(lmdb.path) || !isestr(lmdb.db) || !isobj(lmdb.cls)) {
        throw new Error('createStoreOpener 需要 lmdb { WOrm, path, db, cls }（resolveLmdbCfg 之產物）')
    }
    if (!isarr(names) || names.length === 0 || !names.every(isestr)) {
        throw new Error('createStoreOpener 需要 names（集合之對外名陣列）')
    }
    const missing = names.filter((n) => !isestr(lmdb.cls[n]))
    if (missing.length) {
        throw new Error(`createStoreOpener 之集合無集合名（lmdb.cls 未列）：${missing.join('、')}`)
    }

    const list = [...names]

    /**
     * 開集合(每次執行開一組)
     *
     * @returns {Object} 回傳集合物件 { 對外名: 集合 }(各為 w-data-pipeline openCollection 之產物)
     * @throws {Error} 任一集合開啟失敗時拋出(已開啟者先行關閉)
     */
    const openStores = () => {
        const out = {}
        try {
            for (const name of list) {
                out[name] = W.openCollection({ WOrm: lmdb.WOrm, path: lmdb.path, db: lmdb.db, cl: lmdb.cls[name] })
            }
        }
        catch (e) {
            for (const s of Object.values(out)) s.close().catch(() => {})
            throw e
        }
        return out
    }

    /**
     * 關閉 openStores 開出之全部集合
     *
     * @param {Object} stores 輸入 openStores 之產物，未給視為{}
     * @returns {Promise} 回傳 Promise，resolve 時代表全部集合皆已關閉
     */
    const closeStores = async (stores) => {
        for (const s of Object.values(stores || {})) await s.close()
    }

    return { openStores, closeStores }
}

/**
 * 管線名之解析:cfg.name 給了(非空字串)即取代內建名,未給(undefined 或 null)用內建名;日誌之管道名與執行摘要 run.json 之 name 取之
 *
 * @param {*} name 輸入 cfg.name
 * @param {String} builtin 輸入各總組裝之內建管線名
 * @returns {String} 回傳管線名
 * @throws {Error} builtin 非非空字串(呼叫端錯誤)、cfg.name 給了而非非空字串時拋出
 * @example
 * console.log(pipelineNameOf(undefined, '知識抓取'), pipelineNameOf('夜間抓取', '知識抓取'))
 * // => 知識抓取 夜間抓取
 */
export function pipelineNameOf(name, builtin) {

    //check
    if (!isestr(builtin)) {
        throw new Error('pipelineNameOf 需要 builtin（內建管線名）')
    }
    if (!given(name)) {
        return builtin
    }
    if (!isestr(name)) {
        throw new Error('cfg.name 須為非空字串（管線名；未給用內建名）')
    }

    return name
}

/**
 * 建立每輪之執行函數(序列見檔頭【每輪序列】)
 *
 * 每輪之 stamp(14 碼;與日誌檔名、run.start.json、run.json 之 stamp 同一值)於呼叫各段時掛在該段收到之 ctx 上:
 * 各段之 when(ctx) 與 run(ctx) 皆可讀 ctx.stamp(產出鏈之 makeProduced 取之,見 core/ops/provenance);輪次外(手動 ops／CLI)之呼叫 ctx 無此欄。
 * 其餘簽名與行為不變。段本身若為巢狀管線(definePipeline 產物),其內層段另有自己的 ctx、不繼承此欄。
 * scan.audit 與 afterRun 回呼之引數亦帶 stamp(同值):`audit({ stores, deps, log, stamp })`、`afterRun({ report, summaryFile, log, deps, stamp })`;
 * 其餘引數鍵與值不變(cfg.afterRun 與本函數之檢核錯誤訊息逐字不變,其內所列簽名為既有鍵,不含 stamp)。
 *
 * @param {Object} p 輸入參數物件
 * @param {String} p.name 輸入管線名(日誌與執行摘要 run.json 之 name)
 * @param {Object} p.dirs 輸入目錄物件(每輪先建全部目錄;開工標記與執行摘要落 dirs.log)
 * @param {Object} p.clock 輸入時鐘物件
 * @param {Function} p.mkLog 輸入日誌工廠 () => logger(每輪一個;logger.now 為 14 碼時間戳者即本輪時間戳,否則取時鐘)
 * @param {Array} [p.startupWarnings=[]] 輸入啟動期警告(每輪開頭以「啟動期檢核：」記入;每輪讀同一陣列)
 * @param {Object} p.runtime 輸入執行期生效值(core/runtime 之 resolveRuntime 產物;取 deadlineMs、lockStaleMs、lockFile、scheduleLimitMin、limitMin)
 * @param {Function} p.openStores 輸入開集合 () => stores
 * @param {Function} p.closeStores 輸入關集合 async (stores) => undefined
 * @param {Function} p.buildDeps 輸入每輪依賴 (stores, log) => deps(只放可列舉之普通屬性)
 * @param {Array} p.stages 輸入管線之段(各為 { name, run(ctx) };每輪以同一組建管線)
 * @param {Object} [p.ai] 輸入 AI 調度層(執行摘要取其 aiUsageToday／health／drainStats)
 * @param {Object} [p.roundLog] 輸入當輪日誌之轉接(createRoundLog 之產物;每輪 enter、結束 leave)
 * @param {Object} [p.scan] 輸入符合度掃描(未給即不掃) { enabled:布林值或 () => 布林值(每輪判定), audit:async ({ stores, deps, log, stamp }) => 掃描結果(stamp＝本輪 stamp),
 *   countsOf:(掃描結果, { at, ms }) => { counts:{ 標準 id: { violation, … } }, … } }
 * @param {Function} [p.afterRun] 輸入收尾鉤子 ({ report, summaryFile, log, deps, stamp }) => 結果(stamp＝本輪 stamp,與 summaryFile 之 stamp 同值)
 * @param {Function} [p.afterRunNote] 輸入收尾結果之附註 (結果) => 字串(附於收尾失敗／略過之日誌行;如外部巡檢之紀錄是否已更新)，回空字串或拋錯即不附
 * @returns {Function} 回傳 run():Promise，resolve 回傳 report(w-data-pipeline runPipeline 之產物,另含 summaryFile 與 afterRun(收尾鉤子之回傳值));
 *   未取得執行鎖時 report.lockSkipped 為 true,不掃描、不寫摘要、不觸發收尾鉤子
 * @throws {Error} 參數缺漏或形狀不合時拋出(呼叫端錯誤)
 * @example
 * need test in nodejs.
 *
 * let run = createRoundRunner({ name: '知識抓取', dirs, clock, mkLog, startupWarnings, runtime, openStores, closeStores, buildDeps, stages: [obj], ai, roundLog })
 * let report = await run()
 */
export function createRoundRunner(p) {

    //check
    if (!isobj(p)) {
        p = {}
    }
    const { name, dirs, clock, mkLog, runtime, openStores, closeStores, buildDeps, ai, roundLog } = p
    if (!isestr(name)) {
        throw new Error('createRoundRunner 需要 name（管線名）')
    }
    if (!isobj(dirs) || !isestr(dirs.log)) {
        throw new Error('createRoundRunner 需要 dirs（含 log）')
    }
    if (!isobj(clock) || !isfun(clock.iso8) || !isfun(clock.stamp8)) {
        throw new Error('createRoundRunner 需要 clock（時鐘物件）')
    }
    if (!isobj(runtime)) {
        throw new Error('createRoundRunner 需要 runtime（resolveRuntime 之產物）')
    }
    for (const [k, f] of Object.entries({ mkLog, openStores, closeStores, buildDeps })) {
        if (!isfun(f)) throw new Error(`createRoundRunner 需要 ${k}（函數）`)
    }
    if (!isarr(p.stages) || p.stages.length === 0) {
        throw new Error('createRoundRunner 需要 stages（管線之段陣列）')
    }
    const scan = given(p.scan) ? p.scan : null
    if (scan && !(isobj(scan) && isfun(scan.audit) && isfun(scan.countsOf) && (isfun(scan.enabled) || typeof scan.enabled === 'boolean'))) {
        throw new Error('createRoundRunner 之 scan 須為 { enabled:布林值或 () => 布林值, audit:async ({ stores, deps, log }) => 掃描結果, countsOf:(掃描結果, { at, ms }) => 計數摘要 }')
    }
    if (given(p.afterRun) && !isfun(p.afterRun)) {
        throw new Error('createRoundRunner 之 afterRun 須為函數')
    }
    if (given(p.afterRunNote) && !isfun(p.afterRunNote)) {
        throw new Error('createRoundRunner 之 afterRunNote 須為函數 (收尾結果) => 附註字串')
    }

    const stages = [...p.stages]
    const startupWarnings = isarr(p.startupWarnings) ? p.startupWarnings : []
    const afterRun = isfun(p.afterRun) ? p.afterRun : null
    const { deadlineMs, lockStaleMs, lockFile, scheduleLimitMin, limitMin } = runtime

    /**
     * 收尾結果之附註(附於收尾失敗／略過之日誌行;未給或拋錯為空字串)
     *
     * @param {*} r 輸入收尾鉤子之回傳值
     * @returns {String} 回傳「；附註」或空字串
     */
    const noteOf = (r) => {
        if (!isfun(p.afterRunNote)) return ''
        try {
            const s = p.afterRunNote(r)
            return isestr(s) ? `；${s}` : ''
        }
        catch {
            return ''
        }
    }

    /**
     * 本輪是否掃描(每輪判定);判定拋錯視同掃描失敗:只留 warn,不掃
     *
     * @param {Object} log 輸入當輪日誌
     * @returns {Boolean} 回傳是否掃描
     */
    const scanOnOf = (log) => {
        if (!scan) return false
        try {
            return (isfun(scan.enabled) ? scan.enabled() : scan.enabled) === true
        }
        catch (e) {
            log.warn(`符合度掃描失敗：${oneline(e?.message, 200)}（本輪不列違反數）`)
            return false
        }
    }

    /**
     * 本輪各段:於各段之 when 與 run 被呼叫時,先把本輪 stamp 掛到該段收到之 ctx(ctx.stamp;與 run.json 之 stamp 同一值)——
     *   產出鏈(core/ops/provenance 之 makeProduced)取之。不改原階段物件(跨輪重用)、不改各段之簽名與回報;
     *   this 照原階段呼叫方式傳入;非物件或無 run 函數者原樣交給管線(由管線的契約檢查照舊報錯)。
     *   只掛在管線頂層之 ctx(子階段序列 runSubStages 傳遞同一 ctx 故同見);段本身若為巢狀管線(definePipeline 產物),
     *   其內層段另有自己的 ctx,不繼承此欄
     *
     * @param {Array} list 輸入階段陣列
     * @param {String} stamp 輸入本輪 stamp
     * @returns {Array} 回傳包裝後之新階段陣列
     */
    const stampedStagesOf = (list, stamp) => list.map((st) => {
        if (st === null || typeof st !== 'object' || !isfun(st.run)) return st
        const { run, when } = st
        return {
            ...st,
            when: function(ctx) {
                ctx.stamp = stamp
                return isfun(when) ? when.call(this, ctx) : true
            },
            run: function(ctx) {
                ctx.stamp = stamp
                return run.call(this, ctx)
            },
        }
    })

    return async () => {
        for (const d of Object.values(dirs)) fsCreateFolder(d)
        const log = mkLog()
        roundLog?.enter?.(log)
        try {
            for (const w of startupWarnings) log.warn(`啟動期檢核：${w}`)
            // 本輪時間戳:與日誌檔名同一 stamp(自訂日誌工廠無 now 者取開工時刻);開工標記與執行摘要共用
            const stamp = /^\d{14}$/.test(String(log.now || '')) ? log.now : clock.stamp8()
            // 開工標記:本輪上限之宣告先落地(limitMin＝本輪宣告之上限,見 core/runtime:排程上限,否則由明給之預算推回;皆無為 null);失敗只留 warn
            const startFile = writeRunStart({
                dir: dirs.log,
                stamp,
                start: { pid: process.pid, startedAt: clock.iso8(), limitMin: limitMin ?? scheduleLimitMin ?? null, scheduleLimitMin: scheduleLimitMin ?? null, deadlineMs, lockStaleMs },
            })
            if (!startFile) log.warn?.('開工標記（run.start.json）寫入失敗——外部巡檢對本輪退用其他判界來源')
            const stores = openStores()
            try {
                const deps = buildDeps(stores, log)
                const root = W.definePipeline({
                    name,
                    log,
                    onError: 'continue',
                    deadlineMs,
                    lock: lockFile ? () => acquireLock(lockFile, { staleMs: lockStaleMs }) : undefined,
                    deps,
                    stages: stampedStagesOf(stages, stamp),
                })
                const startedAt = clock.iso8()
                const t0Run = Date.now()
                const report = await W.runPipeline(root, { log })
                // 未取得鎖＝本輪未執行(上一輪仍在跑):不掃描、不寫摘要、不收尾——寫了會被當成一輪早夭的執行
                if (report.lockSkipped) return report

                // ① 符合度掃描(回呼):計數入執行摘要;本輪已逾時間預算者略過(不延長本輪);失敗只留 warn,不影響本輪成敗
                let standards
                if (scanOnOf(log)) {
                    if (Number.isFinite(deadlineMs) && Date.now() >= t0Run + deadlineMs) log.info('符合度掃描：本輪已逾時間預算，略過（下輪補掃）')
                    else {
                        const t0 = Date.now()
                        try {
                            standards = scan.countsOf(await scan.audit({ stores, deps, log, stamp }), { at: clock.iso8(), ms: Date.now() - t0 })
                            const bad = Object.entries(standards.counts).filter(([, c]) => c.violation > 0)
                            log.info(`符合度掃描（${((Date.now() - t0) / 1000).toFixed(1)}s）：${bad.length ? `違反 ${bad.map(([id, c]) => `${id} ${c.violation}`).join('、')}` : '各確定性標準皆無違反'}`)
                        }
                        catch (e) {
                            log.warn(`符合度掃描失敗：${oneline(e?.message, 200)}（本輪不列違反數）`)
                        }
                    }
                }

                // ② 結構化摘要先落地(收尾鉤子與外部巡檢優先讀它;失敗只留 warn,不影響本輪成敗)。
                //   AI 實績(drainStats)為「取走並歸零」,只由 buildRunSummary 取一次(落 ai.callStats),日誌由此轉記
                const summary = buildRunSummary({ report, startedAt, endedAt: clock.iso8(), deadlineMs, ai, stamp, standards })
                if (summary.ai?.callStats && summary.ai.callStats !== '無呼叫') log.info(`AI 實績：${summary.ai.callStats}`)
                const file = writeRunSummary({ dir: dirs.log, stamp, summary })
                if (!file) log.warn?.('執行摘要（run.json）寫入失敗')
                report.summaryFile = file

                // ③ 收尾鉤子:在管線外、摘要之後;回傳值掛 report.afterRun。失敗留痕,不影響本輪成敗
                if (afterRun) {
                    const t0 = Date.now()
                    try {
                        const r = await afterRun({ report, summaryFile: file, log, deps, stamp })
                        report.afterRun = r
                        const sec = ((Date.now() - t0) / 1000).toFixed(1)
                        if (r && r.ok === false) log.warn(`收尾失敗：${oneline(r.error, 200)}（${sec}s；管線本身不受影響${noteOf(r)}）`)
                        else if (r && r.skipped) log.warn(`收尾略過：${oneline(r.message || r.skipped, 200)}（${sec}s${noteOf(r)}）`)
                        else log.info(`收尾完成（${sec}s）`)
                    }
                    catch (e) {
                        report.afterRun = { ok: false, error: oneline(e?.message, 200) }
                        log.warn(`收尾鉤子拋錯：${oneline(e?.message, 200)}`)
                    }
                }
                return report
            }
            finally {
                await closeStores(stores)
            }
        }
        finally {
            roundLog?.leave?.(log)
        }
    }
}

/**
 * info() 之共同欄位組裝(每次呼叫重算:路徑以當下 cwd 解析為絕對路徑,與實際讀寫相同)
 *
 * @param {Object} p 輸入參數物件
 * @param {Object} p.dirs 輸入目錄物件
 * @param {Object} p.settings 輸入解析後之設定
 * @param {Object} p.clock 輸入時鐘物件
 * @param {Object} p.ai 輸入 AI 調度層
 * @param {Object} p.domains 輸入生效之 domain 物件
 * @param {Object} [p.extra={}] 輸入各工作之專屬欄(排在 domains 之後;不得與共同欄同名，如抓取之 registry、identity)
 * @param {Object} p.lmdb 輸入 resolveLmdbCfg 之產物
 * @param {Object} p.data 輸入解析後之資料
 * @param {Object} p.vocab 輸入已解析之詞彙表
 * @param {Object} p.runtime 輸入 resolveRuntime 之產物(取 deadlineMs、lockStaleMs、scheduleLimitMin、envFile、aiWorkspace、lockFile)
 * @param {Array} p.startupWarnings 輸入啟動期警告(原陣列)
 * @param {Array} p.collections 輸入 openStores 開啟之集合對外名(回傳其複本)
 * @returns {Object} 回傳 { dirs, settings, clock, ai, domains, ...extra, lmdb, data, vocab, deadlineMs, lockStaleMs, startupWarnings,
 *   scheduleLimitMin(未給為 null), envFile, aiWorkspace(注入 cfg.aiAdapter 時為 null), lockFile(cfg.lock 為 false 時為 null), collections }；
 *   envFile／aiWorkspace／lockFile 為絕對路徑(非字串者為 null)
 * @throws {Error} extra 含共同欄之名時拋出(呼叫端錯誤:共同欄會被靜默蓋掉)
 * @example
 * let i = assemblyInfoOf({ runtime: { envFile: 'c:/kb/.env', aiWorkspace: null, lockFile: null, deadlineMs: 1, lockStaleMs: 2 }, collections: ['docs'] })
 * console.log(i.scheduleLimitMin, i.aiWorkspace, i.collections)
 * // => null null [ 'docs' ]
 */
export function assemblyInfoOf(p) {

    //check
    if (!isobj(p)) {
        p = {}
    }
    const extra = isobj(p.extra) ? p.extra : {}
    const clash = Object.keys(extra).filter((k) => INFO_COMMON_KEYS.includes(k))
    if (clash.length) {
        throw new Error(`assemblyInfoOf 之 extra 不可與共同欄同名：${clash.join('、')}`)
    }

    const runtime = isobj(p.runtime) ? p.runtime : {}
    const { envFile, aiWorkspace, lockFile } = runtime
    return {
        dirs: p.dirs,
        settings: p.settings,
        clock: p.clock,
        ai: p.ai,
        domains: p.domains,
        ...extra,
        lmdb: p.lmdb,
        data: p.data,
        vocab: p.vocab,
        deadlineMs: runtime.deadlineMs,
        lockStaleMs: runtime.lockStaleMs,
        startupWarnings: p.startupWarnings,
        scheduleLimitMin: runtime.scheduleLimitMin ?? null,
        envFile: isestr(envFile) ? path.resolve(envFile) : null,
        aiWorkspace: isestr(aiWorkspace) ? path.resolve(aiWorkspace) : null,
        lockFile: isestr(lockFile) ? path.resolve(lockFile) : null,
        collections: isarr(p.collections) ? [...p.collections] : [],
    }
}

export default {
    checkKeys, resolveDirsCfg, resolveClockCfg, resolvePromptsCfg, promptDomainConflicts, mergeDomains, checkDataKeys, resolveDataCfg,
    checkStageConfig, checkOptionalCollections, resolveLmdbCfg,
    resolveLogFactory, resolveAfterRun, checkAiAdapter, createRoundLog, aiEventLoggersOf, AI_OPTIONS_KEYS, buildAiAdapter, startupWarningsOf,
    featuresOnOf, featureProblemsOf, createStoreOpener, pipelineNameOf, createRoundRunner, assemblyInfoOf, DEPS_COMMON_KEYS,
}
