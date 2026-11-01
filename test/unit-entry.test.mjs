// unit-entry.test.mjs — 入口契約:具名匯出與預設匯出為同一組成員、全部公開模組之匯出皆掛入入口(同名即同一實作)、無名稱衝突、關鍵積木存在
// 規則(出自 WKnowledgeCapture 檔頭):
//   ①公開模組各列一次,具名匯出與預設物件由同一組命名空間合成,必然同一組名稱
//   ②兩個公開模組匯出同名而不同實體時載入即拋(export * 會靜默剔除該名,以具名匯入取用時才爆)
//   ③不列入者只有 fetchers/fetch_web_cli.mjs(瀏覽器階梯之子行程執行檔,載入即執行,不是函式庫模組)
// 執行:自套件根 npx mocha test/unit-entry.test.mjs
// 【以本檔位置定根,不用 cwd】本測試會 import(＝執行)原始碼夾(套件根下之 src/)每一支 .mjs,原始碼夾須與 cwd 無關;下文路徑皆相對 src/

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import WKnowledgeCapture, * as NS from '../src/WKnowledgeCapture.mjs'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

// 不是函式庫模組、不得 import 之檔(載入即執行子行程邏輯)
const NOT_LIBRARY = new Set(['fetchers/fetch_web_cli.mjs'])

/**
 * 走訪套件根下之 .mjs(略過測試、暫存與 node_modules;遞迴走訪不得進入其他測試並行建立又刪除之 test/_tmp)
 *
 * @param {String} dir 輸入目錄
 * @param {String} [rel=''] 輸入相對路徑前綴
 * @returns {Array} 回傳相對路徑陣列(正斜線)
 */
const walk = (dir, rel = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const r = rel ? `${rel}/${d.name}` : d.name
    if (d.isDirectory()) return /^(test|node_modules|_tmp)$/.test(d.name) ? [] : walk(path.join(dir, d.name), r)
    return [r]
})

const libraryFiles = () => walk(PKG).filter((f) => f.endsWith('.mjs') && f !== 'WKnowledgeCapture.mjs' && !NOT_LIBRARY.has(f))

describe('unit-entry', function() {

    this.timeout(60_000)

    it('具名匯出與預設匯出為同一組名稱、同一實體;預設物件不含 default 鍵', () => {
        const named = Object.keys(NS).filter((k) => k !== 'default').sort()
        const dflt = Object.keys(WKnowledgeCapture).sort()
        assert.deepEqual(named, dflt, '兩種取用方式之成員須完全相同')
        for (const k of named) assert.equal(NS[k], WKnowledgeCapture[k], `${k}:具名與預設須為同一實體`)
        assert.equal('default' in WKnowledgeCapture, false)
        assert.ok(named.length > 0)
    })

    it('入口成員皆有定義(無 undefined 成員)', () => {
        for (const [k, v] of Object.entries(WKnowledgeCapture)) assert.notEqual(v, undefined, k)
    })

    it('走訪涵蓋全部公開模組(各層目錄皆有模組、關鍵檔皆在):走訪不得空轉,否則下列匯出檢查恆過', () => {
        const files = libraryFiles()
        for (const f of ['createKnowledgeCapture.mjs', 'captureObject.mjs', 'rejects.mjs', 'core/settingsDefault.mjs', 'core/ai/adapter.mjs', 'standards/registry.mjs', 'standards/audit.mjs', 'standards/cs10Fix.mjs', 'standards/cs12Fix.mjs', 'standards/docStandards.mjs']) {
            assert.ok(files.includes(f), `走訪缺 ${f}`)
        }
        for (const d of ['stages', 'stores', 'fetchers', 'ops', 'standards', 'domain', 'core']) {
            assert.ok(files.some((f) => f.startsWith(`${d}/`)), `走訪缺目錄 ${d}/`)
        }
        assert.ok(files.every((f) => !f.startsWith('test/') && !f.includes('node_modules')))
        assert.ok(!files.includes('fetchers/fetch_web_cli.mjs'), '子行程執行檔不列入')
    })

    it('全部公開模組之具名匯出皆掛入入口且為同一實體(新增模組 export 而未掛入口即失敗)', async () => {
        const missing = []
        for (const f of libraryFiles()) {
            const mod = await import(pathToFileURL(path.join(PKG, f)).href)
            const own = Object.keys(mod).filter((k) => k !== 'default')
            assert.ok(own.length > 0, `${f} 無任何具名匯出(公開模組須有具名積木)`)
            for (const k of own) {
                if (WKnowledgeCapture[k] !== mod[k]) missing.push(`${f}:${k}`)
            }
        }
        assert.deepEqual(missing, [], '未掛入入口(或同名而不同實體)之具名匯出')
    })

    it('名稱無衝突:不同公開模組匯出同名時須為同一實體(獨立走訪重驗,不依賴載入期之檢查)', async () => {
        const owner = new Map()
        const conflicts = []
        for (const f of libraryFiles()) {
            const mod = await import(pathToFileURL(path.join(PKG, f)).href)
            for (const [k, v] of Object.entries(mod)) {
                if (k === 'default') continue
                const prev = owner.get(k)
                if (prev && prev.v !== v) conflicts.push(`${k}:${prev.f}／${f}`)
                if (!prev) owner.set(k, { f, v })
            }
        }
        assert.deepEqual(conflicts, [])
        assert.deepEqual([...owner.keys()].sort(), Object.keys(WKnowledgeCapture).sort(), '入口之成員恰為各公開模組具名匯出之聯集(無遺漏、無憑空名稱)')
    })

    it('關鍵積木存在且型別正確:總組裝、抓取物件、子階段工廠、設定、AI 調度、閘門、政策、抓取器、檢定標準、維運件', () => {
        const FUNCS = [
            'createKnowledgeCapture', 'createCaptureObject', 'runSubStages',
            'stageHygiene', 'stageSeedSync', 'stageListFetch', 'stageDetailFetch', 'stageDocMaintain', 'stageExpand', 'stageAreas',
            'resolveSettings', 'resolveCaptureSettings', 'seatProblem', 'createAiAdapter', 'resolveCatalogue', 'createAreaDomain', 'sanitizeAreaQuery',
            'createContentGate', 'gateVersionOf', 'gridAbstractCheck', 'createHealthGates', 'planHealthRecheck', 'planDeadRecheck',
            'buildIndex', 'matchSameContent', 'paraKeysOf', 'sameContentPatch', 'classifyFetch', 'isPdfUrl',
            'pickDueSources', 'ensureSeedSources', 'recordSourceOutcome', 'cullZeroYieldSources', 'reprobeSources',
            'saveClues', 'pickClues', 'enforceFrontierCap', 'settleClue',
            'createDefaultFetchers', 'mergeFetchers', 'mergeSiteAdapters', 'fetchArticle', 'runBrowserLadder',
            'checkTitleBody', 'contentKeysOfUrl', 'duplicateGroups', 'auditCaptureStandards', 'createStandardsTally', 'standardsScanOf', 'standardsCountsOf',
            'planCs10Fix', 'applyCs10Fix', 'verifyCs10Chain', 'rollbackCs10Fix', 'readCs10Ledger', 'planCs12Fix', 'applyCs12Fix', 'verifyCs12Chain', 'rollbackCs12Fix', 'readCs12Ledger', 'scriptProblems', 'toTw', 'cnToTw',
            'resolveLocale', 'scriptOf', 'scriptApplies', 'localeProblem',
            'featuresOnOf', 'featureProblemsOf',
            'promptSigText', 'promptSigsProblem', 'promptOverridesOf', 'promptTextOf', 'promptCtxOf', 'overridablePrompt', 'promptDomainOf', 'promptsForDomain', 'promptDomainConflicts', 'mergeDomains', 'checkDataKeys', 'resolveDataCfg',
            'composeNamespaces', 'captureVocabDefaultOf', 'benchVoteMissingOf',
            'runtimeCfgOf', 'applyConceptFold', 'seatsFrom', 'seatLabelsFrom', 'checkKeys', 'unknownKeysProblem', 'vocabHeadOf', 'pickVocabKeys', 'mergeGuideFields', 'renameChainProblems',
            'holdKey', 'putHold', 'resolveHold', 'waiveHold', 'requestRetry', 'listHolds', 'overdueHolds', 'retryRequestedOf', 'pipelineDueOf', 'holdDeadlineOf',
            'holdStockUnfixable', 'closeStockHold', 'rollbackStockHold', 'reopenStockHold', 'stockHoldProblems', 'rollbackPlanOf', 'rollbackWriteOf', 'writeRollback', 'canonOf', 'sameValue',
            'stockLedgerFileOf', 'stockAtOf', 'parseStockLedger', 'stockLedgerRowsOf', 'stockLedgerWriter', 'appendRollbackRow', 'stockErrorOf', 'readJsonlRows', 'appendJsonlRows', 'appendJsonlRow',
            'rejectListOf', 'rowsToCsv', 'rowsToMd', 'refetchSources', 'reviveDeadDocs',
            'buildRunSummary', 'writeRunSummary', 'writeRunStart', 'readRunSummary', 'readRunStart', 'subReportOf', 'createLogger',
            'resolveRuntime', 'limitMinOfDeadline', 'expandDirs', 'resolveVocab', 'acquireLock', 'inspectLock', 'createNetGuard', 'genClockTZ',
            'archiveDocText', 'docTextOf', 'packText', 'unpackText', 'defineMw', 'applyTaps', 'runChainOverMsgs', 'stdReport', 'execCliJsonFile',
            'given', 'strOf', 'textValueOf', 'strictTextOf', 'textListOf', 'uniq', 'jsonClone', 'cmp', 'isDirectRun',
            'typeName', 'chunk', 'groupBy', 'vocabKeyOf', 'paginateByVocab', 'inputVocabProblemsOf', 'domainNeedsOf', 'noVerdict', 'benchPintOf', 'batchOption', 'callJsonShapeOf',
        ]
        for (const k of FUNCS) assert.equal(typeof WKnowledgeCapture[k], 'function', k)
        const ARRAYS = ['CFG_KEYS', 'DATA_KEYS', 'PROMPT_KEYS', 'COLLECTION_KEYS', 'CAPTURE_STAGE_KEYS', 'CAPTURE_STANDARDS', 'DOC_STANDARDS', 'AUDITED_STANDARD_IDS', 'REJECT_OBJECTS', 'SKIP_TITLE_PATTERNS_DEFAULT', 'SEAT_KEYS', 'DOC_TERMINAL_STATUSES', 'HOLD_STATUSES', 'HOLD_OWNERS', 'AI_ROW_KEYS', 'RUNTIME_CFG_KEYS', 'DEPS_COMMON_KEYS', 'CAPTURE_VOCAB_KEYS', 'CORE_LOG_KNOWN', 'CORE_LOG_MUST_SEE', 'CAPTURE_LOG_KNOWN', 'CAPTURE_LOG_MUST_SEE']
        for (const k of ARRAYS) assert.ok(Array.isArray(WKnowledgeCapture[k]) && WKnowledgeCapture[k].length > 0, k)
        // 設定只有 ai、capture 兩段:預設與 schema 各兩份(來源政策與檢定標準之設定屬 capture.sources／capture.standards,無獨立之段)
        const OBJECTS = ['CAPTURE_DEFAULT', 'AI_DEFAULT', 'CAPTURE_SCHEMA', 'AI_SCHEMA', 'SETTING_TYPES', 'AREA_CONTRACT', 'AREA_PROMPT_SIGS', 'STATUS', 'VOCAB_DEFAULT', 'CAPTURE_REPORT_KEYS', 'SCRIPT_ZH_HANT_TW', 'SCRIPT_NONE']
        for (const k of OBJECTS) assert.equal(typeof WKnowledgeCapture[k], 'object', k)
        // 子階段鍵與日誌契約之報告鍵同一實體;物件之預設名即報告鍵之段名
        assert.equal(WKnowledgeCapture.CAPTURE_STAGE_KEYS, WKnowledgeCapture.CAPTURE_REPORT_KEYS.subStages)
        assert.equal(WKnowledgeCapture.createCaptureObject().name, WKnowledgeCapture.CAPTURE_REPORT_KEYS.stage)
        assert.ok(WKnowledgeCapture.LIMIT_TEXT_RE instanceof RegExp)
        assert.equal(typeof WKnowledgeCapture.GROUP_ID_SEP, 'string')
        assert.equal(typeof WKnowledgeCapture.CS12_HOLD_OBJECT, 'string')
        assert.equal(typeof WKnowledgeCapture.CS12_HOLD_NEXT, 'string')
        assert.equal(WKnowledgeCapture.CS12_HOLD_DEADLINE_DAYS, 30)
        assert.equal(WKnowledgeCapture.STOCK_LEDGER_FILE, 'stock-fix.jsonl')
    })
})
