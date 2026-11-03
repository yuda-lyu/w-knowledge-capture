// captureRuntime.mjs — 抓取執行期件之組裝(唯一一份):本套件之總組裝 createKnowledgeCapture 與下游之總組裝(多工作之知識管線)共用,
//   呼叫端不另組任何抓取件
//
// 【組裝之件】種子／網格主題之檢核、抓取之樣式與健全閘於建構期編譯、抓取之文字折疊(線索鍵與領域候選之概念鍵)、
//   抓取器／站台 adapter／registry／去重身分、本機網路判斷(與交給 AI 調度層之 isNetDown)、領域發現之 domain、
//   抓取子階段每輪所需之依賴(seen、registry、netGuard)與抓取所用之集合(CAPTURE_STORE_KEYS)。
// 【為何獨立】各總組裝各自逐段同型實作時,任一側新增抓取器選項、網路判斷條件或每輪依賴,另一側即漂移(如交給 AI 調度層之 isNetDown
//   一側只看 netGuard 是否存在、另一側另驗 confirmDown 為函數)。
// 【呼叫端負責】cfg 之鍵集檢核(含 cfg.data 之鍵集)、設定解析(resolveSettings)、AI 調度層、集合之開關與每輪管線——抓取以外之件不在此。
// 【文字折疊為模組級單例】本函數設定本套件之折疊(core/util/text 之 setConceptFold;同行程多個實例以最後建構者為準);
//   回傳之 folds 供呼叫端以同一組折疊設定其自身之單例(下游之概念分群鍵),兩邊之線索鍵／概念鍵才一致。

import * as OpenCC from 'opencc-js'
import isobj from 'wsemi/src/isobj.mjs'
import isarr from 'wsemi/src/isarr.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import W from 'w-data-pipeline/src/WDataPipeline.mjs'
import { setConceptFold } from './core/util/text.mjs'
import { resolveLocale } from './core/locale.mjs'
import { given } from './core/util/values.mjs'
import { toPatterns } from './core/util/patterns.mjs'
import { createNetGuard, netProbeUrlsOf } from './core/util/netGuard.mjs'
import { resolveVocab } from './core/vocab/vocabDefault.mjs'
import { DEFAULT_DEDUP } from './core/util/records.mjs'
import { gateDetectorProblems, adapterSpecsOf } from './core/util/injectables.mjs'
import { createDefaultFetchers, mergeFetchers } from './fetchers/defaultFetchers.mjs'
import { createOpenAlexAuth, openAlexApiKeyOf } from './fetchers/openAlexNet.mjs'
import { checkSeedSources, checkGridTopics } from './fetchers/endpoints.mjs'
import { DEFAULT_SITE_ADAPTERS, mergeSiteAdapters } from './fetchers/siteAdapters.mjs'
import { createContentGate } from './stores/contentGate.mjs'
import { createAreaDomain } from './domain/areaDomain.mjs'

/**
 * 抓取所用之集合(對外名;抓取子階段讀寫者):總組裝之開集合須至少含這些(下游之總組裝另加其自身之集合)
 *
 * @type {Array}
 */
export const CAPTURE_STORE_KEYS = Object.freeze(['docs', 'docTexts', 'sources', 'frontier', 'areas'])

/**
 * 抓取所讀之資料鍵(cfg.data 之 seedSources、gridTopics、vocab):本套件總組裝之 cfg.data 可用鍵即此;下游總組裝之 cfg.data 須至少接受這些
 *
 * @type {Array}
 */
export const CAPTURE_DATA_KEYS = Object.freeze(['seedSources', 'gridTopics', 'vocab'])

/**
 * 抓取所讀之資料(cfg.data 之 seedSources、gridTopics、vocab)之檢核與正規化;cfg.data 之鍵集由呼叫端檢核(各總組裝之 cfg.data 可另有其鍵)
 *
 * @param {*} d 輸入 cfg.data，未給代表全用預設
 * @returns {Object} 回傳 { seedSources:Array, gridTopics:Array, vocab:Object|null(安裝方原給之詞彙覆寫) }
 * @throws {Error} 非物件、seedSources／gridTopics 非陣列或逐項形狀不合(見 fetchers/endpoints 之 checkSeedSources／checkGridTopics)、
 *   vocab 非物件時拋出
 * @example
 * console.log(resolveCaptureData({ gridTopics: [['圖學習', 'graph learning']] }).gridTopics.length)
 * // => 1
 */
export function resolveCaptureData(d) {
    if (!given(d)) d = {}
    if (!isobj(d)) throw new Error(`cfg.data 須為物件 { ${CAPTURE_DATA_KEYS.join(', ')} }`)
    for (const k of ['seedSources', 'gridTopics']) {
        if (given(d[k]) && !isarr(d[k])) throw new Error(`cfg.data.${k} 須為陣列`)
    }
    // 逐項形狀亦於建構期驗(與種子展開、種子領域同步同一判準):形狀錯之項於執行期會建出垃圾領域並對外查詢,或使整段輪抓失敗
    checkSeedSources(d.seedSources)
    checkGridTopics(d.gridTopics)
    if (given(d.vocab) && !isobj(d.vocab)) throw new Error('cfg.data.vocab 須為物件（詞彙覆寫 { domain?, kbLabel?, conceptRenames?, conceptAliases? }，鍵見 core/vocab/vocabDefault）')
    return {
        seedSources: d.seedSources || [],
        gridTopics: d.gridTopics || [],
        vocab: d.vocab || null, // null＝用內建預設(resolveVocab)
    }
}

/**
 * 文字折疊之決定(cfg.conceptFold):false 停用、函數自訂(分群與線索鍵同用)、true 內建繁簡折疊;未給時依語言設定——中文(locale.han)用內建繁簡折疊,
 *   其他語言不折疊(未給語言設定亦用內建折疊,與語言設定出現前相同)。內建折疊:分群折向簡體(tw→cn:繁體多字對一簡體,折向簡體才收斂字形變體);
 *   線索鍵用固定之 cn→tw(待探索線索之去重鍵持久化,不可隨分群政策變動)。下游套件(與本套件共用概念鍵者)以同一函數決定其折疊,兩邊之概念鍵才一致
 *
 * @param {*} conceptFold 輸入 cfg.conceptFold
 * @param {Object} [locale] 輸入語言設定(core/locale 之 resolveLocale 產物;未給視同中文)
 * @returns {Object} 回傳 { fold:Function|null, clueFold:Function|null }
 * @throws {Error} 給了 false／true／函數以外之值時拋出
 * @example
 * console.log(conceptFoldsOf(false))
 * // => { fold: null, clueFold: null }
 *
 * console.log(conceptFoldsOf(undefined, resolveLocale('en')))
 * // => { fold: null, clueFold: null }
 */
export function conceptFoldsOf(conceptFold, locale) {
    if (given(conceptFold) && typeof conceptFold !== 'boolean' && !isfun(conceptFold)) {
        throw new Error('cfg.conceptFold 須為 false（停用）、true（內建繁簡折疊）、未給（依語言設定）或折疊函數 (t) => String')
    }
    if (conceptFold === false) return { fold: null, clueFold: null }
    if (isfun(conceptFold)) return { fold: conceptFold, clueFold: conceptFold }
    if (conceptFold !== true && isobj(locale) && locale.han === false) return { fold: null, clueFold: null }
    return { fold: OpenCC.Converter({ from: 'tw', to: 'cn' }), clueFold: OpenCC.Converter({ from: 'cn', to: 'tw' }) }
}

/**
 * 文字折疊之套用(各工作之執行期件同一份):依 cfg.conceptFold 與語言設定決定折疊(conceptFoldsOf),並以詞彙表之概念改名／別名設定模組級之折疊單例
 *   (同行程多個實例以最後建構者為準)。【false 須明確清除】false 若只是「不設定」,先前實例注入之折疊會殘留
 *
 * @param {*} conceptFold 輸入 cfg.conceptFold
 * @param {Object} vocab 輸入已解析之詞彙表(取 conceptRenames、conceptAliases)
 * @param {Object} [locale] 輸入語言設定(resolveLocale 之產物;未給視同中文)
 * @returns {Object} 回傳 { fold, clueFold }(conceptFoldsOf 之產物;供呼叫端揭露與下游比對)
 * @throws {Error} cfg.conceptFold 型別不合、或詞彙表之概念對照形狀錯時拋出
 * @example
 * console.log(applyConceptFold(false, { conceptRenames: {}, conceptAliases: {} }))
 * // => { fold: null, clueFold: null }
 */
export function applyConceptFold(conceptFold, vocab, locale) {
    const folds = conceptFoldsOf(conceptFold, locale)
    setConceptFold(folds.fold, { renames: vocab?.conceptRenames, aliases: vocab?.conceptAliases, clueFold: folds.clueFold })
    return folds
}

/**
 * 文件之去重身分(cfg.dedup;未給用 DEFAULT_DEDUP):抓取入庫與管線外登記文件(下游之人工匯入等,externalDocOf)須用同一身分,
 *   文件 id 才與管線一致
 *
 * @param {Object} [dedup] 輸入去重身分設定(w-data-pipeline createIdentity 之設定)，未給用 DEFAULT_DEDUP
 * @returns {Object} 回傳去重身分物件(w-data-pipeline createIdentity 之產物)
 * @throws {Error} 設定不合 w-data-pipeline 之契約時拋出
 * @example
 * need test in nodejs.
 *
 * console.log(typeof captureIdentityOf().of)
 * // => function
 */
export function captureIdentityOf(dedup) {
    return W.createIdentity(dedup || DEFAULT_DEDUP)
}

/**
 * 本機網路判斷器之決定(cfg.netGuard 整組置換——測試替身走這裡;null＝不判斷;未給依 settings.capture.network 建立):
 *   網路問題不算在文章／來源／線索／AI 呼叫頭上。下游套件之 AI 調度層以同一判斷器詢問(isNetDown),斷網整鏈皆敗時不計失敗
 *
 * @param {*} netGuardCfg 輸入 cfg.netGuard
 * @param {Object} capture 輸入解析後之抓取設定(settings.capture;取 network、services)
 * @returns {Object} 回傳 { netGuard(null＝不判斷), isNetDown(交 AI 調度層之函數;判斷器無 confirmDown 時為 null) }
 * @throws {Error} cfg.netGuard 給了而非物件時拋出
 * @example
 * console.log(captureNetGuardOf(null, {}))
 * // => { netGuard: null, isNetDown: null }
 */
export function captureNetGuardOf(netGuardCfg, capture) {
    if (given(netGuardCfg) && !isobj(netGuardCfg)) throw new Error('cfg.netGuard 須為網路判斷器物件 { check, confirmDown, isDown, describe } 或 null（不判斷）')
    const netGuard = netGuardCfg === null
        ? null
        : (netGuardCfg || createNetGuard({ urls: netProbeUrlsOf(capture), timeoutMs: capture.network.probeTimeoutMs }))
    const isNetDown = isfun(netGuard?.confirmDown) ? () => netGuard.confirmDown() : null
    return { netGuard, isNetDown }
}

/**
 * 組裝抓取執行期件(檔頭):建構期即驗資料、編譯樣式與健全閘、設定抓取之文字折疊、建抓取器與網路判斷——設定錯誤要在啟動期爆
 *
 * @param {Object} cfg 輸入總組裝之 cfg(讀 lang、data、conceptFold、fetchers、siteAdapters、dedup、netGuard)
 * @param {Object} settings 輸入解析後之設定(讀 capture;本套件或下游總組裝之 resolveSettings 產物皆可)
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Object} [opt.vocab] 輸入交本套件之詞彙(只含本套件所讀之鍵,見 core/vocab/vocabDefault 之 pickCaptureVocab);未給即用 cfg.data.vocab
 * @param {Function} [opt.buildAreaPrompt] 輸入領域發現之提示詞覆寫 (candidates, areas, ctx) => 字串(輸出契約固定,見 domain/areaDomain)
 * @param {String} [opt.envFile] 輸入金鑰檔路徑(解析後之路徑;OpenAlex 金鑰取自此檔中 capture.services.openAlex.apiKeyEnv 所指之變數)，未給或檔內無該變數則不帶金鑰
 * @returns {Object} 回傳 { data, vocab(已解析), locale(語言設定:core/locale 之 resolveLocale 產物;各工作之執行期件同讀 cfg.lang), folds:{ fold, clueFold },
 *   fetchers, registry, identity, netGuard(null＝不判斷), isNetDown(交 AI 調度層之函數;netGuard 無 confirmDown 時為 null), areaDomain,
 *   openAlexAuth(OpenAlex 金鑰載體,不含金鑰值之可見欄位), deps(stores, log) }
 *   ——deps 回傳抓取子階段每輪所需之 { seen, registry, netGuard, locale }(seen 依 stores.docs 與去重身分每輪建立),由呼叫端併入其每輪依賴
 * @throws {Error} cfg.lang 不合、cfg.data 形狀不合(resolveCaptureData)、抓取樣式或健全閘之追加樣式無法編譯、cfg.conceptFold 型別不合、
 *   抓取器／站台 adapter 不合契約、去重身分設定不合、cfg.netGuard 非物件、詞彙不合規格時拋出
 * @example
 * need test in nodejs.
 *
 * let rt = createCaptureRuntime({ data: { seedSources: [] } }, resolveSettings({}))
 * console.log(rt.registry.label())
 */
export function createCaptureRuntime(cfg, settings, opt = {}) {
    if (!isobj(cfg)) cfg = {}
    if (!isobj(opt)) opt = {}
    const cap = settings?.capture
    if (!isobj(cap)) throw new Error('createCaptureRuntime 需要解析後之 settings(含 capture)')

    // ── 語言設定(cfg.lang;core/locale):輸出語言之稱呼、字形政策、折疊方向、slug 政策——各工作之執行期件同讀此一份 ──
    const locale = resolveLocale(cfg.lang)

    // ── 資料(種子、網格主題、詞彙覆寫)──
    const data = resolveCaptureData(cfg.data)

    // ── 樣式與健全閘於建構期編譯一次:樣式語法錯誤在啟動期即爆,不等到第一篇補全文才拋
    //   (標題預篩之 new RegExp(undefined) 是空樣式、匹配一切,誤傳會把每一篇都判成彙整貼文而靜默零產出,故形狀亦於此驗)。
    //   自訂偵測器須帶 module:瀏覽器階梯於子行程執行,無 module 者載不到,curl 層與瀏覽器層之閘即不一致——於此拋錯 ──
    const gateProblems = gateDetectorProblems(createContentGate(cap.standards).detectors, { requireModule: true })
    if (gateProblems.length) throw new Error(`settings.capture.standards.detectors：${gateProblems.join('；')}`)
    toPatterns(cap.articles.skipTitlePatterns, 'settings.capture.articles.skipTitlePatterns')

    // ── 詞彙(kbLabel／domain／概念別名之設定錯誤在建構期即爆)與文字折疊(線索鍵、領域候選之概念鍵)──
    const vocab = resolveVocab(isobj(opt.vocab) ? opt.vocab : data.vocab)
    const folds = applyConceptFold(cfg.conceptFold, vocab, locale)

    // ── 站台 adapter:安裝方 cfg.siteAdapters 同 id 置換本套件自帶、其餘排前;不合契約者啟動期拋錯;合併結果再由 w-fetch-web 排在其內建清單之前。
    //   帶 module 者另化為跨行程規格(瀏覽器階梯之子行程據以載入);無 module 者只作用於主行程之 curl 層(README 已知限制)──
    const siteAdapters = mergeSiteAdapters(DEFAULT_SITE_ADAPTERS, cfg.siteAdapters)
    const siteAdapterSpecs = adapterSpecsOf(siteAdapters)

    // ── OpenAlex 金鑰載體(fetchers/openAlexNet):變數名取 capture.services.openAlex.apiKeyEnv,值取 opt.envFile(金鑰檔;與 AI 金鑰同檔);
    //   無金鑰檔／無此變數 → 不帶金鑰。載體只在閉包內持金鑰值:rt、deps 被輸出時不帶出金鑰。網格抓取器與每輪依賴(領域發現之驗證)共用同一個 ──
    const openAlexAuth = createOpenAlexAuth(openAlexApiKeyOf(cap, opt.envFile))

    // ── 抓取器與去重身分 ──
    const fetchers = mergeFetchers(
        createDefaultFetchers({
            articleTimeoutMs: cap.articles.timeoutMs,
            // OpenAlex 禮貌池信箱(網格查詢、領域發現之驗證、原文回溯共用同一個 capture.services.openAlex.mailto)
            openAlexMailto: cap.services.openAlex.mailto,
            // OpenAlex API 金鑰載體(同上)
            openAlexAuth,
            // 網格來源之領域過濾(OpenAlex field id／arXiv 類別):預設不限,主題範圍由安裝方以 capture.areas 給
            openAlexFields: cap.areas.openAlexFields,
            arxivCategories: cap.areas.arxivCategories,
            // 端點基底(預設公開服務;測試指向本機假站台)
            openAlexBase: cap.services.openAlex.base,
            arxivApiBase: cap.services.arxiv.base,
            siteAdapters,
        }),
        cfg.fetchers || [],
    )
    const registry = W.createFetcherRegistry(fetchers)
    const identity = captureIdentityOf(cfg.dedup)

    // ── 本機網路判斷:各抓取子階段經 deps.netGuard、AI 調度層經 isNetDown 詢問同一份 ──
    const { netGuard, isNetDown } = captureNetGuardOf(cfg.netGuard, cap)

    // ── 領域發現之提示詞:內建(依詞彙注入稱呼與主題範圍)→ opt.buildAreaPrompt 覆寫組 prompt(輸出契約與驗證固定)──
    const areaDomain = createAreaDomain({ vocab, locale, ...(isfun(opt.buildAreaPrompt) ? { buildPrompt: opt.buildAreaPrompt } : {}) })

    return {
        data,
        vocab,
        locale,
        folds,
        fetchers,
        registry,
        identity,
        netGuard,
        isNetDown,
        areaDomain,
        siteAdapterSpecs,
        openAlexAuth,
        /**
         * 抓取子階段每輪所需之依賴(只放可列舉之普通屬性:w-data-pipeline 以 spread 複製 deps)
         *
         * @param {Object} stores 輸入該輪開啟之集合(取 docs)
         * @param {Object} log 輸入該輪日誌
         * @returns {Object} 回傳 { seen(去重身分查詢,依 stores.docs 建立), registry, netGuard, locale(語言設定;子階段交純函數之字形政策),
         *   siteAdapterSpecs(帶 module 之站台 adapter 之跨行程規格;瀏覽器階梯之子行程據以載入), openAlexAuth?(OpenAlex 金鑰載體;領域發現之驗證取用。
         *   【僅在帶金鑰時才有此欄】未設金鑰者之 deps 欄集與加入金鑰支援前相同——下游總組裝(展開本函數之產物)與其測試所釘之欄集不因本套件加入此欄而變) }
         */
        deps: (stores, log) => ({
            seen: W.createSeenStore({ collection: stores.docs, identity, log }),
            registry,
            netGuard,
            locale,
            siteAdapterSpecs,
            ...(openAlexAuth.enabled ? { openAlexAuth } : {}),
        }),
    }
}

export default { CAPTURE_STORE_KEYS, CAPTURE_DATA_KEYS, resolveCaptureData, conceptFoldsOf, applyConceptFold, captureIdentityOf, captureNetGuardOf, createCaptureRuntime }
