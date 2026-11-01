// unit-package.test.mjs — 套件結構測試:邊界、預設領域中立、覆寫生效、cfg 檢核、package.json、舊名與沿革、下游筆記之資料契約
//
// 【佈局】原始碼全在 src/(主入口 src/WKnowledgeCapture.mjs);套件根另有 g.mjs(範例)、toolg/(編譯與文件工具)、test/;下文路徑除註明外皆相對套件根
// ① 邊界:套件內全部 .mjs(排除 node_modules、test/_tmp 與產物夾 tmp、dist、docs)之 import 不得跑出套件根、目標須存在、不得引用專案既有程式與資料——套件須能整份移植;
//   執行秩序件(鎖、時間預算、截止公式、日誌、單行化、AI 目錄展開、時鐘、子行程 JSON 執行、CLI 失敗摘要)只經單一匯入點 core/runnerPackage.mjs
//   取自 w-data-pipeline／w-dispatch-ai／wsemi 之深層路徑,所列之名與來源模組之件為同一實體
// ② 預設領域中立:預設設定、預設資料、預設提示詞、預設題組、README、package.json 與原始碼(含 bench/*.mjs)不含量化／金融詞彙
//   (通用知識抓取;量化之種子、網格、稱呼與範例屬安裝方之資料;詞表取 test/tools/domainTerms,四套件同一份)
// ③ 覆寫生效:以非量化之自訂主題(天文學知識庫)逐層覆寫——設定、資料、提示詞、抓取器、AI 調度層、筆記、子階段 tap、儲存集合——逐項斷言生效;預設不被污染
// ④ cfg 檢核:未知鍵、子鍵與形狀錯誤一律啟動期拋錯(不靜默回預設)
// ⑤ package.json:scripts 為 test(mocha 標準指令)與 deploy(文件發布,同自有套件);依賴對帳(src/ 之 import 套件＝dependencies,dayjs 等 wsemi 自帶者除外;
//   測試與編譯工具(g.mjs、toolg/)另 import 者在 devDependencies,測試執行器 mocha 經 scripts.test 呼叫而不 import,隨編譯工具套件 w-package-tools 安裝;所列者皆有使用者);
//   執行秩序件來源三套件之安裝版合於所列範圍;入口(src/)可載入;
//   發布面(main 指向 dist 之 UMD、不設 exports 與 files,使下游得以「套件名/src/…」與「套件名/test/tools/…」深層路徑取用;無 .npmignore、npm 包＝git 版控內容(依 .gitignore),
//   npm pack --dry-run 之清單含 sgud/、test/tools/ 而不含 CLAUDE*.md 與暫存;LICENSE 為 MIT);
//   發布內容(README、*.csv、非測試 .mjs)不含宿主之痕跡:磁碟機絕對路徑與使用者目錄
// ⑥ 舊名、沿革與面向使用者之字樣不出現:已不存在之套件與總組裝之名、暫存路徑、帶日期之沿革、帳本與審查代號、「此前」敘事、宿主之指令、
//   下游工作之名(README、package.json 與原始碼逐行;字串字面與 README 另判面向使用者之字樣;判準取 test/tools/historyMarks,四套件同一份)
// ⑦ 下游筆記記錄之資料契約:筆記欄位之讀取只經 core/stores/noteFields(下游改名時只改一處,主標籤之定義與下游同一份)
// 執行:在套件根 npx mocha test/unit-package.test.mjs(暫存 test/_tmp/pkg-*-<pid>,測完即刪;不連網路、不呼叫真 AI)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isBuiltin } from 'node:module'
import { execFileSync, execSync } from 'node:child_process'
import W from 'w-data-pipeline/src/WDataPipeline.mjs'
import WOrm from 'w-orm-lmdb/src/WOrmLmdb.mjs'
import providers from 'w-dispatch-ai/src/providers.mjs'
import { createKnowledgeCapture, CFG_KEYS, DATA_KEYS, PROMPT_KEYS, COLLECTION_KEYS } from '../src/createKnowledgeCapture.mjs'
import { CAPTURE_STAGE_KEYS } from '../src/captureObject.mjs'
import { resolveSettings, CAPTURE_DEFAULT, AI_DEFAULT, SKIP_TITLE_PATTERNS_DEFAULT, CAPTURE_SCHEMA, AI_SCHEMA } from '../src/core/settingsDefault.mjs'
import { VOCAB_DEFAULT, resolveVocab, kbLabelOf } from '../src/core/vocab/vocabDefault.mjs'
import { createAreaDomain, AREA_CONTRACT } from '../src/domain/areaDomain.mjs'
import { PLACEHOLDER_PATTERNS_DEFAULT, PAYWALL_PATTERNS_DEFAULT, NOT_FOUND_PATTERNS_DEFAULT, CONSENT_MARKERS_DEFAULT } from '../src/stores/contentGate.mjs'
import { HYGIENE_TARGETS_DEFAULT } from '../src/core/ops/browserHygiene.mjs'
import { DEFAULT_SITE_ADAPTERS } from '../src/fetchers/siteAdapters.mjs'
import { bingNewsSearchUrl, arxivSearchUrl } from '../src/fetchers/endpoints.mjs'
import { CAPTURE_STANDARDS } from '../src/standards/registry.mjs'
import { DOC_STANDARDS } from '../src/standards/docStandards.mjs'
import { AUDITED_STANDARD_IDS } from '../src/standards/audit.mjs'
import { readRunSummary } from '../src/core/ops/runSummary.mjs'
import { genClockTZ } from '../src/core/runnerPackage.mjs'
import * as RunnerPort from '../src/core/runnerPackage.mjs'
import { defineMw, stdReport } from '../src/core/kernel.mjs'
import { sourceId } from '../src/core/util/records.mjs'
import { normalizeConcept } from '../src/core/util/text.mjs'
import { normalizeUrl } from '../src/core/util/web.mjs'
import { tmpRoot, removeRoots, resetConceptFold, buildTestCapture, stubAdapter, recLog, subReport, assertSubStagesOk, withStores } from './tools/captureTestKit.mjs'
import { article } from './tools/fakeSite.mjs'
import { domainTermsIn } from './tools/domainTerms.mjs'
import { lexSource, specifiersOf } from './tools/sourceScan.mjs'
import { HOST_CLI, historyHitsOf, userTextHitsOf, historyScanOf, userTextScanOf, benchCaseNotesOf } from './tools/historyMarks.mjs'

/** 套件根(以本檔位置推導,與 cwd 無關) */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')

/** 宿主之痕跡:磁碟機絕對路徑(盤符＋反斜線;字串字面中之跳脫形亦含)與使用者目錄 */
const HOST_PATH = /\b[A-Za-z]:\\|\/Users\/|C:\/Users/

// ═══════════════════════ 掃描工具(①⑤共用) ═══════════════════════

/**
 * 套件內全部指定副檔名之檔(預設 .mjs;相對路徑,正斜線;排除 node_modules、test/_tmp 與套件根之產物夾 tmp、dist、docs)。
 * 自行逐層走訪而不用遞迴 readdir:並行之他測試會建立與刪除 test/_tmp 內之檔案,遞迴走訪先遍歷再過濾會走進正被清除之目錄而 ENOENT
 *
 * @param {String} [ext='.mjs'] 輸入副檔名
 * @returns {Array} 回傳相對路徑陣列
 */
function sourceFiles(ext = '.mjs') {
    const out = []
    const walk = (rel) => {
        let entries = []
        try {
            entries = fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })
        }
        catch {
            return
        }
        for (const d of entries) {
            const r = rel ? `${rel}/${d.name}` : d.name
            if (d.isDirectory()) {
                if (d.name === 'node_modules' || r === 'test/_tmp' || (!rel && ['tmp', 'dist', 'docs'].includes(d.name))) continue
                walk(r)
            }
            else if (d.name.endsWith(ext)) out.push(r)
        }
    }
    walk('')
    return out.sort()
}

/** 讀檔;讀取當下已被他行程刪除者回 null */
function readText(rel) {
    try {
        return fs.readFileSync(path.join(ROOT, rel), 'utf8')
    }
    catch {
        return null
    }
}

/**
 * npm 實際打包之檔案清單(自套件根執行 npm pack --dry-run --json;不寫檔、不連網;相對路徑,正斜線)。
 * npm 11 之 --json 為「套件名 → 結果」之物件、舊版為陣列,兩者皆收
 *
 * @returns {Array} 回傳打包清單之相對路徑陣列
 */
function packListOf() {
    const out = execSync('npm pack --dry-run --json', { cwd: ROOT, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
    const j = JSON.parse(out)
    const r = Array.isArray(j) ? j[0] : Object.values(j)[0]
    return r.files.map((f) => String(f.path).replace(/\\/g, '/'))
}

// 原始碼之掃描(指定詞、去註解之程式碼、骨架——字串換成佔位、註解去除)取各套件同一份之詞法器(test/tools/sourceScan):
//   註解與字串之內容(含「;」、引號、「import … from …」之字樣、錯誤訊息中之「cfg.<鍵>」)不干擾比對

/** 專案內不屬本套件之目錄名:指定詞以之起頭即引用專案既有程式或資料(含使用端專案之排程殼與下游套件之目錄) */
const PROJECT_DIRS = ['src', 'test', 'data', 'srcRunner', 'srcSummarize', 'srcRelate', 'srcExtract']

/** 執行秩序件之單一匯入點 */
const ORDER_BRIDGE = 'src/core/runnerPackage.mjs'

/** 執行秩序件之來源(自有套件之深層路徑):只許單一匯入點引用;其他檔引用即繞過匯入點(鎖之行程內登記表為模組級,副本即互判殘留) */
const ORDER_SPEC_RE = /^(w-data-pipeline\/src\/(lock|budget|log)\/|w-data-pipeline\/src\/util\/oneline\.mjs$|w-dispatch-ai\/src\/resolveCatalogue\.mjs$|wsemi\/src\/(genClockTZ|execCliJsonFile|execCliFailDetail)\.mjs$)/

/** 執行秩序件之來源套件(安裝版須合於 package.json 所列範圍) */
const ORDER_PKGS = ['w-data-pipeline', 'w-dispatch-ai', 'wsemi']

/**
 * 分類一個指定詞
 *
 * @param {String} file 輸入引用者(相對套件根)
 * @param {String} spec 輸入指定詞
 * @returns {Object} 回傳 { kind:'builtin'|'relative'|'package', pkg?:套件名, problem?:問題說明 }
 */
function classify(file, spec) {
    const bridge = file === ORDER_BRIDGE
    if (spec.startsWith('node:') || isBuiltin(spec)) return { kind: 'builtin' }
    if (spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')) {
        const target = path.resolve(path.dirname(path.join(ROOT, file)), spec).replace(/\\/g, '/')
        const rel = path.relative(ROOT, target).replace(/\\/g, '/')
        if (rel.startsWith('..') || path.isAbsolute(rel)) return { kind: 'relative', problem: `相對 import 跑出套件根 → ${spec}` }
        if (!fs.existsSync(target)) return { kind: 'relative', problem: `目標不存在 → ${spec}` }
        return { kind: 'relative' }
    }
    // 絕對路徑、file: 與網路 URL:機器專屬或不可移植
    if (spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec) || /^[a-z][a-z0-9+.-]*:/i.test(spec)) return { kind: 'package', problem: `絕對路徑或 URL 形式之指定詞 → ${spec}` }
    if (PROJECT_DIRS.some((d) => spec === d || spec.startsWith(`${d}/`))) return { kind: 'package', problem: `引用專案既有程式或資料 → ${spec}` }
    const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
    if (ORDER_SPEC_RE.test(spec) && !bridge) return { kind: 'package', pkg, problem: `執行秩序件須經單一匯入點 core/runnerPackage.mjs 取用 → ${spec}` }
    return { kind: 'package', pkg }
}

/** 全套件掃描結果(逐檔之指定詞與分類);於 ① 與 ⑤ 共用 */
function scanAll() {
    const files = sourceFiles()
    const rows = []
    for (const f of files) {
        const code = readText(f)
        if (code === null) continue
        for (const spec of specifiersOf(code)) rows.push({ file: f, spec, ...classify(f, spec) })
    }
    return { files, rows }
}

describe('unit-package', function() {

    after(() => {
        resetConceptFold()
    })

    // ═══════════════════════ ① 邊界 ═══════════════════════
    describe('① 邊界(套件須能整份移植)', () => {
        let scan = null

        before(() => {
            scan = scanAll()
        })

        it('掃描器自檢:各種 import 形式皆能取出指定詞(含多行、export from、副作用 import、動態 import);註解、JSDoc 與字串內之字樣不計;分類器抓得到跑出套件、專案目錄、繞過執行殼匯入點與絕對路徑', () => {
            // 規則:specifiersOf(詞法器,各套件同一份)／classify 為邊界檢查之唯一判準——自檢使「掃不到」不會被誤認為「沒有違規」
            const fixture = [
                "import a from './a.mjs'",
                'import {',
                '    b,',
                "} from '../../srcSummarize/x.mjs'",
                "export * from 'wsemi/src/isobj.mjs'",
                "import 'side-effect-pkg'",
                `const m = await ${'imp'}${"ort('../../src/y.mjs')"}`,
                "// import c from 'commented-out'",
                '/**',
                " * import d from 'in-jsdoc'",
                ' */',
                "const s = 'import e from \"in-string\"'",
            ].join('\n')
            assert.deepEqual(specifiersOf(fixture).sort(), ['../../src/y.mjs', '../../srcSummarize/x.mjs', './a.mjs', 'side-effect-pkg', 'wsemi/src/isobj.mjs'])
            assert.match(classify('test/x.test.mjs', '../../srcSummarize/x.mjs').problem, /跑出套件根/)
            assert.match(classify('src/core/x.mjs', '../nope/none.mjs').problem, /目標不存在/)
            assert.match(classify('src/core/x.mjs', 'srcSummarize/core/kernel.mjs').problem, /引用專案既有程式或資料/)
            assert.match(classify('src/stages/x.mjs', '../../../srcRunner/WTaskRunner.mjs').problem, /跑出套件根/)
            assert.match(classify('src/stages/x.mjs', 'w-data-pipeline/src/lock/executionLock.mjs').problem, /須經單一匯入點/)
            assert.match(classify('src/core/ai/adapter.mjs', 'wsemi/src/genClockTZ.mjs').problem, /須經單一匯入點/)
            assert.deepEqual(classify(ORDER_BRIDGE, 'w-data-pipeline/src/lock/executionLock.mjs'), { kind: 'package', pkg: 'w-data-pipeline' })
            assert.match(classify('src/core/x.mjs', 'data/vocab.json').problem, /引用專案既有程式或資料/)
            assert.match(classify('src/core/x.mjs', 'C:/proj/a.mjs').problem, /絕對路徑或 URL/)
            assert.deepEqual(classify('src/core/x.mjs', 'wsemi/src/isobj.mjs'), { kind: 'package', pkg: 'wsemi' })
            assert.deepEqual(classify('src/core/x.mjs', '@scope/pkg/sub.js'), { kind: 'package', pkg: '@scope/pkg' })
            assert.deepEqual(classify('src/core/x.mjs', 'node:fs'), { kind: 'builtin' })
            assert.deepEqual(classify('src/core/x.mjs', 'fs'), { kind: 'builtin' })
            assert.deepEqual(classify('src/core/x.mjs', '../core/kernel.mjs'), { kind: 'relative' })
            // 掃描範圍:套件檔案確實被掃到(含本檔自身、共用件與套件根之範例、編譯工具)
            for (const f of ['src/WKnowledgeCapture.mjs', 'src/createKnowledgeCapture.mjs', 'src/core/kernel.mjs', 'src/stages/areaStage.mjs', 'g.mjs', 'toolg/gDistRollup.mjs', 'test/unit-package.test.mjs', 'test/tools/captureTestKit.mjs']) {
                assert.ok(scan.files.includes(f), `掃描須含 ${f}`)
            }
            assert.ok(scan.files.length >= 40 && scan.rows.length >= 150, `掃描量過少：${scan.files.length} 檔／${scan.rows.length} 條指定詞`)
            assert.ok(!scan.files.some((f) => f.includes('node_modules') || f.startsWith('test/_tmp/') || /^(tmp|dist|docs)\//.test(f)), '須排除 node_modules、test/_tmp 與產物夾 tmp、dist、docs')
        })

        it('全部相對 import 解析後不跑出套件根、目標檔案存在', () => {
            // 規則:套件須能整份移出專案——相對路徑只在套件內
            const bad = scan.rows.filter((r) => r.kind === 'relative' && r.problem).map((r) => `${r.file}：${r.problem}`)
            assert.deepEqual(bad, [])
        })

        it('不引用專案既有程式與資料(src／專案 test／data／下游套件)、不用絕對路徑或 URL 形式之指定詞', () => {
            // 規則:只可 import 套件內相對路徑或 node_modules 之套件(執行秩序件經單一匯入點 core/runnerPackage)
            const bad = scan.rows.filter((r) => r.kind === 'package' && r.problem).map((r) => `${r.file}：${r.problem}`)
            assert.deepEqual(bad, [])
        })

        it('執行秩序件只經單一匯入點(core/runnerPackage.mjs)取自 w-data-pipeline／w-dispatch-ai／wsemi 之深層路徑;匯入點之指定詞皆為該等路徑;所列之名皆與來源模組之件為同一實體', async () => {
            // 規則:core/runnerPackage【執行秩序只有一份實作】——鎖之行程內登記表為模組級,兩份實作在同一行程會互判殘留而接管
            const viaOrder = [...new Set(scan.rows.filter((r) => ORDER_SPEC_RE.test(r.spec)).map((r) => r.file))]
            assert.deepEqual(viaOrder, [ORDER_BRIDGE], '來源之深層路徑只許單一匯入點引用')
            const specs = specifiersOf(readText(ORDER_BRIDGE))
            assert.ok(specs.length >= 5 && specs.every((s) => ORDER_SPEC_RE.test(s)), `匯入點之指定詞須皆為執行秩序件之來源:${specs.join('、')}`)
            assert.ok(new Set(specs.map((s) => s.split('/')[0])).size === 3, '三個來源套件皆經匯入點取件')
            const modules = await Promise.all(specs.map((s) => import(s)))
            const names = Object.keys(RunnerPort)
            assert.ok(names.length >= 12 && ['acquireLock', 'inspectLock', 'budgetOf', 'createLogger', 'genClockTZ', 'execCliJsonFile', 'resolveCatalogue'].every((n) => names.includes(n)), `匯入點之名:${names.join('、')}`)
            const sourced = (k) => modules.some((m) => RunnerPort[k] !== undefined && (m[k] === RunnerPort[k] || m.default === RunnerPort[k]))
            assert.deepEqual(names.filter((k) => !sourced(k)), [], '匯入點之名須與來源模組之件為同一實體(不得另包一層)')
            const entry = await import('../src/WKnowledgeCapture.mjs')
            assert.deepEqual(names.filter((k) => entry[k] !== RunnerPort[k]), [], '本套件主入口原名轉出之件即來源之件(下游經本套件取用,不另依賴該三套件之此類件)')
        })
    })

    // ═══════════════════════ ② 預設領域中立 ═══════════════════════
    describe('② 預設領域中立', () => {
        /**
         * 特定產業(量化／金融)領域之詞彙(中英;預設內容不得含):詞表與命中函數取 test/tools/domainTerms(四套件同一份;英文詞以詞界比對——
         * quantum 為物理詞、docStockFix 等識別字、xxx-alpha-free 等模型條目 id 不誤傷)。通用知識抓取套件不預設任何領域:量化之種子、網格主題、
         * 稱呼與範例屬安裝方之資料(cfg.data、cfg.prompts、cfg.capture 之領域過濾),不在套件預設內
         */
        const quantHits = domainTermsIn
        /** 值含函數與 RegExp 時之可掃描文字 */
        const textOf = (v) => JSON.stringify(v, (k, x) => (typeof x === 'function' || x instanceof RegExp ? String(x) : x))

        it('詞表自檢:量化範例句被抓到、中立題材與物理詞(quantum)、識別字(docStockFix)不被誤傷', () => {
            // 規則:詞表須非空洞——抓不到時「無命中」不代表中立
            assert.deepEqual(quantHits('量化交易知識庫之股票回測'), ['量化', '交易', '股票', '回測'])
            assert.deepEqual(quantHits('Quant trading with stock portfolio hedge alpha in q-fin backtests'), ['quant', 'q-fin', 'trading', 'stock', 'backtest', 'portfolio', 'hedge', 'alpha'])
            assert.deepEqual(quantHits('天文學知識庫：木星大紅斑、quantum tunneling、docStockFix、attention mechanism、oc:opencode/fledge-alpha-free'), [])
        })

        it('預設設定(resolveSettings({})):ai、capture 兩段之全部預設值不含量化詞彙;領域過濾鍵預設不限、領域發現之 AI 席位全為免費模型', () => {
            const s = resolveSettings({})
            assert.deepEqual(quantHits(textOf(s)), [])
            // 規則:core/settingsDefault【領域中立】——領域過濾預設不限,安裝方依主題給定
            assert.equal(s.capture.areas.openAlexFields, '')
            assert.deepEqual(s.capture.areas.arxivCategories, [])
            assert.deepEqual(s.capture.expand.arxivCategories, [])
            // 規則:【免費 AI 為主】預設席位全為免費模型(w-dispatch-ai 目錄中 opencode CLI 之匿名存取:免金鑰、不用已存認證),付費家由安裝方加於遞補尾
            const catalogue = new Map(providers.map((p) => [p.id, p]))
            for (const id of [s.capture.discover.ai.use, ...s.capture.discover.ai.fallback]) {
                const e = catalogue.get(id)
                assert.ok(e, `預設席位 ${id} 須在 w-dispatch-ai 內建目錄`)
                assert.deepEqual([e.kind, e.useStoredAuth, e.envVar], ['opencode', false, undefined], `預設席位 ${id} 須為匿名免金鑰之免費存取`)
            }
        })

        it('預設資料:標題預篩樣式、詞彙表、站台 adapter、種子與網格(預設無)、端點、健全閘樣式、回收目標、檢定標準表皆不含量化詞彙', () => {
            const resolved = resolveSettings({})
            // 規則:cfg.data 之種子與網格預設為空——量化之來源與主題由安裝方傳入
            const flow = createKnowledgeCapture({ workDir: `${ROOT}/test/_tmp/pkg-neutral-unused`, aiAdapter: stubAdapter(() => 'fail'), netGuard: null, lock: false })
            const info = flow.info()
            assert.deepEqual([info.data.seedSources, info.data.gridTopics], [[], []])
            assert.equal(info.data.vocab, null, '未給詞彙覆寫')
            assert.deepEqual([info.vocab.domain, info.vocab.kbLabel], ['', ''], '詞彙預設為空(不限主題、稱呼由 domain 推導)')
            assert.equal(kbLabelOf(info.vocab), '知識庫')
            assert.deepEqual(Object.keys(info.data).sort(), ['gridTopics', 'seedSources', 'vocab'], 'cfg.data 只收種子、網格主題與詞彙(標題預篩樣式已移至 capture.articles.skipTitlePatterns)')
            assert.equal(info.settings.capture.articles.skipTitlePatterns.length, SKIP_TITLE_PATTERNS_DEFAULT.length)
            const all = {
                skipTitlePatterns: SKIP_TITLE_PATTERNS_DEFAULT,
                vocab: [VOCAB_DEFAULT, resolveVocab()],
                siteAdapters: DEFAULT_SITE_ADAPTERS,
                endpoints: [bingNewsSearchUrl('x'), arxivSearchUrl('x')],
                gate: [PLACEHOLDER_PATTERNS_DEFAULT, PAYWALL_PATTERNS_DEFAULT, NOT_FOUND_PATTERNS_DEFAULT, CONSENT_MARKERS_DEFAULT],
                hygiene: HYGIENE_TARGETS_DEFAULT,
                standards: [CAPTURE_STANDARDS, DOC_STANDARDS],
                contract: AREA_CONTRACT,
                defaults: [CAPTURE_DEFAULT, AI_DEFAULT],
                resolved,
            }
            for (const [k, v] of Object.entries(all)) assert.deepEqual(quantHits(textOf(v)), [], `預設資料「${k}」含量化詞彙`)
        })

        it('預設提示詞(createAreaDomain 之 buildPrompt 輸出):首句稱呼為通用「知識庫」、無主題範圍句、不含量化詞彙;注入詞彙後才出現主題', () => {
            const cands = [
                { label: '行星大氣', kind: 'concept', support: 30, growth: 1.2, clueDocs: 0, samples: [{ title: '行星大氣之光譜分析' }] },
                { label: 'tidal locking', kind: 'clue', support: 0, growth: 0, clueDocs: 4, samples: [] },
            ]
            const areas = [{ label: '行星科學', query: 'planetary science' }]
            const def = createAreaDomain({}).buildPrompt(cands, areas)
            // 規則:domain/areaDomain【領域中立】——稱呼與主題範圍經 vocab 注入,內建提示詞不綁領域
            assert.ok(def.startsWith('你是知識庫的抓取領域規劃員'), def.slice(0, 40))
            assert.ok(!def.includes('主題範圍'), '未給 domain 時不含主題範圍句')
            assert.deepEqual(quantHits(def), [], '預設提示詞含量化詞彙')
            assert.deepEqual(quantHits(createAreaDomain({}).buildPrompt([], [])), [], '空候選之預設提示詞含量化詞彙')
            // 規則:vocab.kbLabel／domain 注入後提示詞才帶出稱呼與主題
            const astro = createAreaDomain({ vocab: { kbLabel: '天文學知識庫', domain: '天文學' } }).buildPrompt(cands, areas)
            assert.ok(astro.startsWith('你是天文學知識庫的抓取領域規劃員') && astro.includes('本知識庫之主題範圍為「天文學」'), astro.slice(0, 80))
        })

        it('預設題組(src/bench/cases/*.json,若存在):逐檔為合法 JSON 且不含量化詞彙', function() {
            const dir = `${ROOT}/src/bench/cases`
            if (!fs.existsSync(dir)) return this.skip()
            const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
            assert.ok(files.length >= 1, 'src/bench/cases 存在但無題組檔')
            for (const f of files) {
                const text = fs.readFileSync(`${dir}/${f}`, 'utf8')
                assert.doesNotThrow(() => JSON.parse(text), `${f} 須為合法 JSON`)
                assert.deepEqual(quantHits(text), [], `題組 ${f} 含量化詞彙`)
            }
        })

        it('README、package.json 與套件原始碼(src/ 含評分之 bench/*.mjs,另含套件根之 g.mjs 與 toolg/;不含測試)之文字不含量化詞彙(範例、註解與日誌字樣亦須中立)', () => {
            const files = sourceFiles().filter((f) => !f.startsWith('test/'))
            assert.ok(files.length >= 40 && files.some((f) => f.startsWith('src/bench/')) && files.includes('g.mjs'), `掃描量過少或漏 src/bench/、g.mjs:${files.length}`)
            const bad = []
            for (const f of [...files, 'package.json', 'README.md']) {
                const hits = quantHits(readText(f) || '')
                if (hits.length) bad.push(`${f}：${hits.join('、')}`)
            }
            assert.deepEqual(bad, [])
        })
    })

    // ═══════════════════════ ③ 覆寫生效 ═══════════════════════
    describe('③ 覆寫生效(自訂主題:天文學知識庫)', () => {
        const roots = []
        const rootOf = (name) => {
            const r = tmpRoot(name)
            roots.push(r)
            return r
        }
        after(() => {
            removeRoots(roots)
        })

        const FEED_URL = 'https://astro.example.org/feed.xml'
        const SEAT = { use: 'stub:astro-seat', fallback: [] }
        const VOCAB = { kbLabel: '天文學知識庫', domain: '天文學', conceptAliases: { '星系': '銀河' } }
        const bodyOf = (title) => [...Array(8)].map((_, i) => `${title}（第 ${i + 1} 段）：本段說明觀測設計、樣本期間 2010 至 2024 年與重複測量結果的穩健性檢驗，並討論第 ${i + 1} 組資料在不同環境條件下的差異。`).join('\n')

        // ── 離線整輪:全部覆寫同時生效(抓取器皆為替身,不連網路)──
        describe('離線整輪(設定、資料、抓取器、AI 調度層、筆記、子階段 tap、儲存集合)', () => {
            const calls = { rss: [], article: [], links: [] }
            const taps = { admit: [], title: [] }
            const items = [
                { url: 'https://astro.example.org/p/weekly-12', title: '天文週報 第 12 期', time: '2026-09-28', summary: '彙整頁一' },
                { url: 'https://astro.example.org/p/digest-7', title: 'Astro Digest 7', time: '2026-09-28', summary: '彙整頁二' },
                { url: 'https://astro.example.org/p/roundup-12', title: 'Weekly Roundup 12', time: '2026-09-28', summary: '預設樣式才會命中之標題' },
                { url: 'https://astro.example.org/p/black-hole', title: '黑洞吸積盤之輻射機制', time: '2026-09-28', summary: '逾每來源取用上限而不入庫' },
            ]
            const rssFetcher = W.defineFetcher({ id: 'rss', kinds: ['rss'], timeoutMs: 10_000, fetch: async (src) => {
                calls.rss.push(src.url)
                return items
            } })
            const articleFetcher = W.defineFetcher({ id: 'article', role: 'detail', match: () => true, timeoutMs: 10_000, fetch: async (d) => {
                calls.article.push(d.url)
                return { ok: true, text: bodyOf(d.title), title: d.title, extra: { method: 'stub', adapterId: '', finalUrl: '' } }
            } })
            const linksFetcher = W.defineFetcher({ id: 'links', role: 'detail', kinds: ['__named-only__'], timeoutMs: 10_000, fetch: async (d) => {
                calls.links.push(d.url)
                const n = d.url.endsWith('weekly-12') ? 1 : 2
                return { ok: true, links: [{ url: `https://other.example.org/c/${n}`, text: `由彙整頁轉錄而來之第 ${n} 篇天文學文章之連結文字` }] }
            } })
            const pdfFetcher = W.defineFetcher({ id: 'pdf', role: 'detail', kinds: ['pdf'], fetch: async () => ({ ok: false, reason: 'pdf', message: '不抓' }) })
            const probe = (name, push) => defineMw({ name, handle: async (msg, ctx, next) => {
                push(msg.data)
                return next(msg)
            } })
            let root = ''
            let flow = null
            let ai = null
            let rep = null
            let aliasOk = false

            before(async () => {
                root = rootOf('pkg-override')
                ai = stubAdapter(() => {
                    throw new Error('此整輪(領域自動發現已停用)不應呼叫 AI')
                }, { validateSeats: true })
                ;({ flow } = buildTestCapture(root, {
                    aiAdapter: ai,
                    scheduleLimitMin: 90,
                    capture: {
                        sources: { itemsPerSource: 3, minIntervalMs: 0, maxConsecFails: 4, lowYieldRate: 0.25 },
                        articles: { maxTries: 5, skipTitlePatterns: [{ p: '^天文週報', f: '' }, /^Astro Digest/i] },
                        areas: { perRun: 0 },
                        browser: { perRun: 0 },
                        discover: { everyHours: 0, ai: SEAT },
                        standards: { scanEachRun: true },
                    },
                    ai: { timeoutMs: 123_456, cooldownMs: 0 },
                    data: {
                        seedSources: [{ kind: 'rss', tier: 1, name: '天文學測試來源', url: FEED_URL, lang: 'zh' }],
                        gridTopics: [['系外行星', 'exoplanet detection']],
                        vocab: VOCAB,
                    },
                    fetchers: [rssFetcher, articleFetcher, linksFetcher, pdfFetcher],
                    stageOpts: {
                        listFetch: { tap: { admitPersist: { after: [probe('probe-admit', (src) => taps.admit.push(src.name))] } } },
                        detailFetch: { tap: { titleSkip: { before: [probe('probe-title', (doc) => taps.title.push(doc.title))] } } },
                    },
                    dedup: { keyOf: (k) => `astro:${k}` },
                    notes: 'astroNotes',
                    lmdb: {
                        path: `${root}/custom-db`,
                        db: 'astro',
                        cls: { docs: 'astroDocs', docTexts: 'astroDocTexts', sources: 'astroSources', frontier: 'astroFrontier', areas: 'astroAreas' },
                    },
                }))
                // 概念別名為模組級狀態(建構者設定之);於其他組裝發生前取值
                aliasOk = normalizeConcept('星系') === normalizeConcept('銀河')
                rep = await flow.run()
            })

            it('設定兩段(ai／capture)依組逐鍵覆寫、未給之鍵沿用預設(capture.sources／articles／areas／browser／discover／standards)', () => {
                const s = flow.info().settings
                // 規則:core/settingsDefault.resolveSettings——各組逐鍵覆寫
                assert.deepEqual([s.capture.sources.itemsPerSource, s.capture.articles.maxTries, s.capture.discover.everyHours], [3, 5, 0])
                assert.deepEqual([s.capture.sources.maxConsecFails, s.capture.sources.lowYieldRate], [4, 0.25])
                assert.deepEqual([s.ai.timeoutMs, s.ai.cooldownMs], [123_456, 0])
                assert.deepEqual(s.capture.discover.ai, SEAT, '席位為物件,整個取代預設')
                assert.equal(s.capture.standards.scanEachRun, true)
                assert.deepEqual([s.capture.areas.perRun, s.capture.browser.perRun], [0, 0])
                // 未給之鍵沿用預設(含同組之其餘鍵)
                assert.equal(s.capture.sources.perRun, CAPTURE_DEFAULT.sources.perRun)
                assert.equal(s.capture.sources.maxConsecEmpty, CAPTURE_DEFAULT.sources.maxConsecEmpty)
                assert.equal(s.capture.discover.minHits, CAPTURE_DEFAULT.discover.minHits)
                assert.equal(s.capture.browser.camofox.port, CAPTURE_DEFAULT.browser.camofox.port, 'camofox 組之埠沿用預設(enabled 由測試組裝關閉)')
                assert.equal(s.ai.maxRetries, AI_DEFAULT.maxRetries)
            })

            it('執行期:scheduleLimitMin 推導整輪時間預算與鎖陳舊期限(上限 90 分 → 預算 84 分、鎖 95 分)', () => {
                const i = flow.info()
                // 規則:core/runtime.resolveRuntime——預算＝上限−6 分;鎖陳舊期限＝上限＋5 分
                assert.deepEqual([i.scheduleLimitMin, i.deadlineMs, i.lockStaleMs], [90, 84 * 60_000, 95 * 60_000])
            })

            it('seedSources 經自訂 rss 抓取器入庫;capture.sources.itemsPerSource 3 截斷入庫數(第 4 項不入庫)', async () => {
                assertSubStagesOk(rep, assert)
                // 規則:cfg.data.seedSources 補入 sources;stages/listFetchStage 之 normalizeItems 以 settings.capture.sources.itemsPerSource 截斷
                assert.deepEqual(calls.rss, [FEED_URL], '自訂 rss 抓取器被實際使用')
                await withStores(flow, async (st) => {
                    assert.ok(await st.sources.get(sourceId('rss', FEED_URL)), '種子來源入庫')
                    const urls = (await st.docs.select()).map((d) => d.url)
                    assert.ok(!urls.some((u) => u.endsWith('/black-hole')), `第 4 項不得入庫：${urls.join('、')}`)
                    assert.equal((await st.docs.select()).filter((d) => !d.fromDocId).length, 3)
                })
            })

            it('capture.articles.skipTitlePatterns 整份取代預設(JSON 形與 RegExp 形皆可):自訂樣式命中者轉錄、僅預設樣式會命中者(Weekly Roundup)照常補全文', async () => {
                // 規則:settings.capture.articles.skipTitlePatterns 給了即整份取代 SKIP_TITLE_PATTERNS_DEFAULT(stages/detailFetchStage.mwTitleSkip 以 toPatterns 編譯)
                assert.ok(SKIP_TITLE_PATTERNS_DEFAULT.some((x) => new RegExp(x.p, x.f).test('Weekly Roundup 12')), '測試前提：預設樣式會命中此標題')
                assert.deepEqual(calls.links.sort(), ['https://astro.example.org/p/digest-7', 'https://astro.example.org/p/weekly-12'])
                assert.deepEqual(calls.article, ['https://astro.example.org/p/roundup-12'], '只有未被自訂樣式命中者經正文抓取器')
                await withStores(flow, async (st) => {
                    const byTitle = Object.fromEntries((await st.docs.select()).map((d) => [d.title, d]))
                    assert.deepEqual([byTitle['天文週報 第 12 期'].status, byTitle['Astro Digest 7'].status, byTitle['Weekly Roundup 12'].status], ['aggregated', 'aggregated', 'raw'])
                    assert.equal((await st.docs.select()).filter((d) => d.fromDocId).length, 2, '兩條轉錄連結入庫為子件')
                })
            })

            it('fetchers:同 id 置換內建(rss／article／links)、新 id(pdf)追加、未被置換者(grid／browser)保留', () => {
                const reg = flow.info().registry
                // 規則:fetchers/defaultFetchers.mergeFetchers——同 id 置換、新 id 追加
                assert.equal(reg.get('rss'), rssFetcher)
                assert.equal(reg.get('article'), articleFetcher)
                assert.equal(reg.get('links'), linksFetcher)
                assert.equal(reg.get('pdf'), pdfFetcher)
                assert.deepEqual(reg.ids, ['rss', 'grid', 'article', 'links', 'browser', 'pdf'])
            })

            it('dedup 覆寫去重身分:文件 id 依自訂之主鍵策略產生(含轉錄子件)', async () => {
                // 規則:cfg.dedup 交 w-data-pipeline 之 createIdentity;seen.admit 以 identity.of 覆寫記錄 id(core/util/records 檔頭【id 由去重層決定】)
                await withStores(flow, async (st) => {
                    const docs = await st.docs.select()
                    assert.equal(docs.length, 5)
                    for (const d of docs) assert.equal(d.id, `astro:${normalizeUrl(d.url)}`, `${d.url} 之 id 須為自訂主鍵：${d.id}`)
                })
            })

            it('aiAdapter 整組置換:info().ai 即替身;席位於啟動期交其 validateSeats 檢核;領域自動發現停用(capture.discover.everyHours 0)→ 本輪不呼叫 AI', () => {
                assert.equal(flow.info().ai, ai)
                // 規則:createKnowledgeCapture 於建構期以 validateSeats({ 'capture.discover.ai': 席位 }) 檢核
                assert.deepEqual(ai.seatChecks, [{ 'capture.discover.ai': SEAT }])
                assert.equal(subReport(rep, '抓取', 'areas').detail.skipped, '自動發現停用')
                assert.equal(ai.calls.length, 0)
                // 規則:注入 aiAdapter 時不建內建調度層,故無 AI 工作區
                assert.equal(flow.info().aiWorkspace, null)
            })

            it('capture.standards.scanEachRun:true → 每輪掃描、run.json 帶各可掃描標準之計數', () => {
                const sum = readRunSummary(rep.summaryFile)
                // 規則:createKnowledgeCapture.run 之符合度掃描(standardsCountsOf)入執行摘要
                assert.ok(sum.standards && sum.standards.counts, '摘要須含 standards 計數')
                assert.deepEqual(Object.keys(sum.standards.counts).sort(), [...AUDITED_STANDARD_IDS].sort())
            })

            it('stageOpts.tap 生效:listFetch 之 admitPersist 後與 detailFetch 之 titleSkip 前各掛一環並被實際執行', () => {
                // 規則:cfg.stageOpts.<子階段> 透傳該子階段工廠之 opt(含 tap;stages/*Stage 之 applyTaps)
                assert.deepEqual(taps.admit, ['天文學測試來源'])
                assert.deepEqual(taps.title.sort(), ['Astro Digest 7', 'Weekly Roundup 12', '天文週報 第 12 期'].sort(), '補全文逐篇經過掛載之環')
            })

            it('lmdb 與 notes:資料寫入自訂之路徑／資料庫／集合名,預設名之集合為空;notes 給集合名 → 加開該名之筆記集合', async () => {
                const lm = flow.info().lmdb
                // 規則:core/assemblyKit.resolveLmdbCfg(createKnowledgeCapture 以之組裝)——path／db／cls 覆寫;cfg.notes 為字串即筆記集合名
                assert.deepEqual([lm.path, lm.db, lm.cls.docs, lm.cls.notes], [`${root}/custom-db`, 'astro', 'astroDocs', 'astroNotes'])
                assert.deepEqual(flow.info().collections, ['docs', 'docTexts', 'sources', 'frontier', 'areas', 'notes'])
                await withStores(flow, async (st) => {
                    await st.notes.insertNew([{ id: 'n1', title: '黑洞吸積盤筆記' }])
                })
                const read = async (cl) => {
                    const c = W.openCollection({ WOrm, path: lm.path, db: lm.db, cl })
                    try {
                        return await c.select()
                    }
                    finally {
                        await c.close()
                    }
                }
                assert.equal((await read('astroDocs')).length, 5, '3 項＋2 轉錄寫入自訂名之文件集合')
                assert.ok((await read('astroSources')).some((s) => s.url === FEED_URL))
                assert.equal((await read('astroNotes')).length, 1)
                for (const cl of ['docs', 'docTexts', 'sources', 'frontier', 'areas', 'notes']) assert.deepEqual(await read(cl), [], `預設名之集合「${cl}」須為空`)
                // 規則:LMDB 檔案只落在 lmdb.path——預設之 db 目錄不留資料檔
                assert.deepEqual(fs.readdirSync(`${root}/db`), [])
            })

            it('data.gridTopics 成為種子領域與 grid 來源;data.vocab 進詞彙表(別名並影響概念折疊)', async () => {
                await withStores(flow, async (st) => {
                    const areas = await st.areas.select()
                    // 規則:stages/seedSyncStage——主題網格先成為領域,grid 來源由啟用中之領域派生
                    assert.deepEqual(areas.map((a) => [a.label, a.query, a.origin, a.status]), [['系外行星', 'exoplanet detection', 'seed', 'active']])
                    assert.deepEqual((await st.sources.select({ kind: 'grid' })).map((s) => [s.query, s.tier]), [['exoplanet detection', 2]])
                })
                const i = flow.info()
                assert.deepEqual([i.vocab.kbLabel, i.vocab.domain, i.vocab.conceptAliases], ['天文學知識庫', '天文學', { '星系': '銀河' }])
                assert.deepEqual(i.data.vocab, VOCAB, '安裝方原給之詞彙覆寫原樣保留')
                // 規則:core/util/text.setConceptFold——vocab.conceptAliases 為折疊後同義合併
                assert.equal(aliasOk, true, '別名「星系」須折疊為正名「銀河」')
            })
        })

        // ── 時鐘、目錄與預設日誌(離線整輪)──
        describe('時鐘、目錄、預設日誌與鎖(離線整輪)', () => {
            const FIXED = { timeZone: 'Fixed/Test', iso8: () => '2031-03-04T05:06:07+08:00', stamp8: () => '20310304050607', date8: () => '2031-03-04', day8: () => '20310304' }
            const stubFetchers = () => [
                W.defineFetcher({ id: 'rss', kinds: ['rss'], fetch: async () => [{ url: 'https://astro.example.org/p/one', title: '黑洞吸積盤之輻射機制', time: '2026-09-28', summary: '摘要' }] }),
                W.defineFetcher({ id: 'article', role: 'detail', match: () => true, fetch: async (d) => ({ ok: true, text: bodyOf(d.title), title: d.title, extra: { method: 'stub', adapterId: '', finalUrl: '' } }) }),
            ]

            it('cfg.clock 驅動日誌檔名、執行摘要、開工標記與記錄時刻;cfg.dirs 為全部輸出之落點;未給 logFactory 時每輪一檔日誌並同步輸出 stdout;鎖落自訂 tmp 且已釋放', async () => {
                const root = rootOf('pkg-dirs')
                const dirs = { db: `${root}/d-db`, log: `${root}/d-log`, tmp: `${root}/d-tmp`, state: `${root}/d-state`, knowledge: `${root}/d-know` }
                const { flow } = buildTestCapture(root, {
                    clock: FIXED,
                    dirs,
                    logFactory: undefined,
                    lock: undefined,
                    fetchers: stubFetchers(),
                    data: { seedSources: [{ kind: 'rss', tier: 1, name: '天文學測試來源', url: FEED_URL, lang: 'zh' }] },
                    capture: { areas: { perRun: 0 }, browser: { perRun: 0 } },
                })
                const echoed = []
                const origLog = console.log
                console.log = (...a) => echoed.push(a.join(' '))
                let rep = null
                try {
                    rep = await flow.run()
                }
                finally {
                    console.log = origLog
                }
                const norm = (p) => path.resolve(p)
                // 規則:createKnowledgeCapture.run——日誌檔、開工標記與執行摘要同一時間戳(clock.stamp8),落 dirs.log/<日期>/
                const logDir = `${dirs.log}/20310304`
                assert.equal(norm(rep.summaryFile), norm(`${logDir}/20310304050607-run.json`))
                assert.ok(fs.existsSync(`${logDir}/20310304050607-run.start.json`), '開工標記須與摘要同一時間戳')
                assert.equal(readRunSummary(rep.summaryFile).startedAt, FIXED.iso8())
                // 規則:core/runnerPackage 之 createLogger——每輪一檔 {stamp}-run.log,同時輸出 stdout(logFactory 預設)
                const fileLines = fs.readFileSync(`${logDir}/20310304050607-run.log`, 'utf8').trim().split('\n')
                assert.ok(fileLines.length >= 5 && fileLines.every((l) => /^\[2031-03-04T05:06:07\+08:00\] (INFO|WARN|ERROR) /.test(l)), `日誌行須帶 clock 之時刻：${fileLines.slice(0, 3).join(' | ')}`)
                assert.ok(fileLines.every((l) => echoed.includes(l)), '日誌行須同時輸出 stdout')
                assert.ok(fileLines.some((l) => /管道\[知識抓取\]/.test(l)), '日誌須記管線名')
                // 規則:cfg.clock 經 deps.clock 到達各階段——記錄時刻取自注入之時鐘
                await withStores(flow, async (st) => {
                    assert.equal((await st.sources.select())[0].addedAt, FIXED.iso8())
                    const docs = await st.docs.select()
                    assert.equal(docs.length, 1)
                    assert.equal(docs[0].collectedAt, FIXED.iso8())
                })
                // 規則:cfg.dirs 逐鍵覆寫(core/dirs.expandDirs)——輸出只落在覆寫之目錄,預設目錄不被建立
                assert.deepEqual(flow.info().dirs, dirs)
                assert.ok(fs.readdirSync(dirs.db).length > 0, 'LMDB 資料落在 dirs.db')
                assert.ok(fs.existsSync(`${dirs.knowledge}/areas.md`), '領域清單投影落在 dirs.knowledge')
                for (const d of ['db', 'log', 'tmp', 'state', 'knowledge']) assert.ok(!fs.existsSync(`${root}/${d}`), `預設目錄 ${d} 不應被建立`)
                // 規則:core/runtime——cfg.lock 未給時鎖檔為 <dirs.tmp>/run.lock;管線結束即釋放
                assert.equal(flow.info().lockFile, norm(`${dirs.tmp}/run.lock`))
                assert.ok(!fs.existsSync(`${dirs.tmp}/run.lock`), '執行鎖須已釋放')
            })
        })

        // ── 整輪時間預算 ──
        describe('整輪時間預算(cfg.deadlineMs)', () => {
            it('逾整輪軟性截止即不再取件:未取件者原狀留為 new、不丟失;領域發現因剩餘時間不足而略過;下一輪(無截止)接手補完', async () => {
                const root = rootOf('pkg-deadline')
                const items = Array.from({ length: 6 }, (_, i) => ({ url: `https://astro.example.org/p/budget-${i}`, title: `預算測試文章 ${i}`, time: '2026-09-28', summary: '摘要' }))
                const fetchers = [
                    W.defineFetcher({ id: 'rss', kinds: ['rss'], fetch: async () => items }),
                    // 每篇耗時 1 秒:3 秒之預算只容得下數篇(前置段耗時不定,預算取寬以免負載下一篇都取不到)
                    W.defineFetcher({ id: 'article', role: 'detail', match: () => true, fetch: async (d) => {
                        await new Promise((r) => setTimeout(r, 1000))
                        return { ok: true, text: bodyOf(d.title), title: d.title, extra: { method: 'stub', adapterId: '', finalUrl: '' } }
                    } }),
                ]
                const data = { seedSources: [{ kind: 'rss', tier: 1, name: '天文學測試來源', url: FEED_URL, lang: 'zh' }] }
                const capture = { areas: { perRun: 0 }, browser: { perRun: 0 }, sources: { itemsPerSource: 6 } }
                const { flow } = buildTestCapture(root, { fetchers, data, capture, deadlineMs: 3000 })
                const t0 = Date.now()
                const rep = await flow.run()
                const elapsed = Date.now() - t0
                const df = subReport(rep, '抓取', 'detailFetch').detail
                // 規則:core/runnerPackage 之 budgetOf 之 shouldStop 為逐篇守門(stages/detailFetchStage 之 runChainOverMsgs.shouldStop);整輪預算取自 cfg.deadlineMs(core/runtime)
                assert.ok(df.filled >= 1 && df.filled < 6, `預算內只取得部分：${JSON.stringify(df)}`)
                assert.equal(df.left, 6 - df.filled, '未取件者計入 left')
                assert.ok(elapsed < 5500, `逾時後須即停(全部 6 篇須 6 秒以上)：${elapsed}ms`)
                // 規則:stages/areaStage——整輪剩餘時間低於 AREA_MIN_REMAINING_MS 即略過領域發現(保護後段)
                assert.equal(subReport(rep, '抓取', 'areas').detail.skipped, '整輪剩餘時間不足')
                await withStores(flow, async (st) => {
                    const docs = await st.docs.select()
                    assert.deepEqual([docs.filter((d) => d.status === 'raw').length, docs.filter((d) => d.status === 'new').length], [df.filled, 6 - df.filled], '未取件者留為 new')
                })
                // 下一輪(同庫、無截止):留下者被接手
                const next = buildTestCapture(root, { fetchers, data, capture }).flow
                const rep2 = await next.run()
                assert.equal(subReport(rep2, '抓取', 'detailFetch').detail.left, 0)
                await withStores(next, async (st) => assert.equal((await st.docs.select()).filter((d) => d.status === 'raw').length, 6, '兩輪後全數補完'))
            })
        })

        // ── 站台 adapter 與概念折疊 ──
        describe('站台 adapter 與概念折疊', () => {
            it('cfg.siteAdapters 傳入內建正文抓取器:命中之 adapter 取得內容(不連網路)→ 正文落 raw、textFrom 記 adapter:<id>', async () => {
                const adapterCalls = []
                const pageUrl = 'https://astro.invalid/p/adapter-page'
                const adapter = { id: 'astro-site', match: /astro\.invalid/, fetch: async (u) => {
                    adapterCalls.push(u)
                    return { status: 'success', html: article('行星環之粒徑分布觀測', '行星環粒徑分布之掩星觀測') }
                } }
                const { flow } = buildTestCapture(rootOf('pkg-adapter'), {
                    siteAdapters: [adapter],
                    fetchers: [W.defineFetcher({ id: 'rss', kinds: ['rss'], fetch: async () => [{ url: pageUrl, title: '行星環之粒徑分布觀測', time: '2026-09-28', summary: '摘要' }] })],
                    data: { seedSources: [{ kind: 'rss', tier: 1, name: '天文學測試來源', url: 'https://astro.invalid/feed.xml', lang: 'zh' }] },
                    capture: { areas: { perRun: 0 }, browser: { perRun: 0 } },
                })
                const rep = await flow.run()
                assertSubStagesOk(rep, assert)
                // 規則:fetchers/siteAdapters.mergeSiteAdapters 之結果交 createDefaultFetchers,fetchers/articleParse.fetchArticle 傳 w-fetch-web 之 adapters
                assert.deepEqual(adapterCalls, [pageUrl], 'adapter 之 fetch 掛點被實際使用')
                await withStores(flow, async (st) => {
                    const d = (await st.docs.select())[0]
                    // 規則:stages/detailFetchStage.persistOutcome——經站台 adapter 者 textFrom 記 adapter:<id>
                    assert.deepEqual([d.status, d.textFrom], ['raw', 'adapter:astro-site'], d.lastError || '')
                    assert.ok(d.text.includes('穩健性檢驗'))
                })
            })

            it('cfg.conceptFold:未給用內建繁簡折疊(兩種字形同鍵);false 停用;給函數即以之折疊(折疊為模組級狀態,以最後建構者為準)', () => {
                const mk = (opt) => buildTestCapture(rootOf('pkg-fold'), opt).flow
                // 規則:createKnowledgeCapture 之 setConceptFold——內建 opencc(tw→cn);false 明確清除先前實例注入者
                mk({})
                assert.equal(normalizeConcept('注意力機制'), normalizeConcept('注意力机制'))
                mk({ conceptFold: false })
                assert.notEqual(normalizeConcept('注意力機制'), normalizeConcept('注意力机制'))
                mk({ conceptFold: (t) => t.toUpperCase() })
                assert.equal(normalizeConcept('abc'), 'ABC')
                mk({})
                assert.equal(normalizeConcept('注意力機制'), normalizeConcept('注意力机制'), '重新建構後恢復內建折疊')
            })
        })

        // ── 執行期覆寫(info) ──
        describe('執行期覆寫(info)', () => {
            it('deadlineMs／lockStaleMs 優先於由排程上限推導者;lock:false 不上鎖、字串即鎖檔路徑;envFile 相對者以 workDir 為基準;aiWorkspace 自訂;lockStaleMs 不足以涵蓋整輪時於啟動期警告', () => {
                const root = rootOf('pkg-runtime')
                const abs = (p) => path.resolve(p)
                // 規則:core/runtime.resolveRuntime——明給之 deadlineMs／lockStaleMs 優先;cfg.lock 三種形態;路徑之基準
                const a = createKnowledgeCapture({ workDir: root, netGuard: null, scheduleLimitMin: 90, deadlineMs: 1_200_000, lockStaleMs: 9_000_000, lock: false, envFile: 'keys/.env', aiWorkspace: `${root}/ws` }).info()
                assert.deepEqual([a.scheduleLimitMin, a.deadlineMs, a.lockStaleMs, a.lockFile], [90, 1_200_000, 9_000_000, null])
                assert.equal(a.envFile, abs(`${root}/keys/.env`))
                assert.equal(a.aiWorkspace, abs(`${root}/ws`))
                assert.deepEqual(a.startupWarnings, [])
                const b = createKnowledgeCapture({ workDir: root, netGuard: null, aiAdapter: stubAdapter(() => 'fail'), lock: `${root}/my.lock`, deadlineMs: 1_200_000, lockStaleMs: 600_000 }).info()
                assert.equal(b.lockFile, abs(`${root}/my.lock`))
                assert.equal(b.aiWorkspace, null, '注入調度層時無 AI 工作區')
                assert.ok(b.startupWarnings.some((w) => /cfg\.lockStaleMs（10\.0 分）小於整輪時間預算加安全邊際/.test(w)), b.startupWarnings.join('\n'))
                assert.ok(b.startupWarnings.some((w) => /未給 scheduleLimitMin/.test(w)) === false, '已給 deadlineMs 者不再警告未給預算')
            })
        })

        // ── 提示詞與詞彙(不需執行)──
        describe('提示詞與詞彙(domains.area)', () => {
            const cands = [{ label: '行星大氣', kind: 'concept', support: 30, growth: 1.2, clueDocs: 0, samples: [] }]
            const areas = [{ label: '行星科學', query: 'planetary science' }]

            it('data.vocab 注入內建提示詞之稱呼與主題範圍;info().domains.area 之契約為凍結之 AREA_CONTRACT', () => {
                const { flow } = buildTestCapture(rootOf('pkg-vocab'), { data: { vocab: { kbLabel: '天文學知識庫', domain: '天文學' } } })
                const d = flow.info().domains.area
                const p = d.buildPrompt(cands, areas)
                // 規則:domain/areaDomain.createAreaDomain——稱呼(vocab.kbLabel)與主題範圍(vocab.domain)由詞彙注入
                assert.ok(p.startsWith('你是天文學知識庫的抓取領域規劃員') && p.includes('本知識庫之主題範圍為「天文學」'), p.slice(0, 80))
                assert.equal(d.contract, AREA_CONTRACT)
                assert.ok(Object.isFrozen(AREA_CONTRACT))
            })

            it('prompts.area 覆寫:以其回傳取代內建提示詞,取得(候選、既有領域、{ kbLabel, domain, contract, defaultPrompt });回傳非空字串之外者拋錯', () => {
                const seen = []
                const { flow } = buildTestCapture(rootOf('pkg-prompt'), {
                    data: { vocab: { kbLabel: '天文學知識庫', domain: '天文學' } },
                    prompts: { area: (c, a, ctx) => {
                        seen.push({ c, a, ctx })
                        return `自訂｜${ctx.kbLabel}｜${c.length}｜${a.length}`
                    } },
                })
                // 規則:cfg.prompts.area 經 createAreaDomain 之 opt.buildPrompt 取代內建提示詞(輸出契約與驗證不變)
                assert.equal(flow.info().domains.area.buildPrompt(cands, areas), '自訂｜天文學知識庫｜1｜1')
                const { defaultPrompt, ...rest } = seen[0].ctx
                assert.deepEqual(rest, { kbLabel: '天文學知識庫', domain: '天文學', contract: AREA_CONTRACT })
                assert.equal(typeof defaultPrompt, 'function', 'ctx.defaultPrompt＝內建提示詞函數(覆寫者可包裝)')
                assert.ok(defaultPrompt(cands, areas).includes('天文學知識庫'), '內建提示詞依同一詞彙')
                assert.deepEqual([seen[0].c, seen[0].a], [cands, areas])
                const empty = buildTestCapture(rootOf('pkg-prompt-empty'), { prompts: { area: () => '  ' } }).flow
                assert.throws(() => empty.info().domains.area.buildPrompt(cands, areas), /須回傳非空字串/)
            })
        })

        // ── 每輪依賴與自訂子階段 ──
        describe('每輪依賴(deps)與自訂子階段(cfg.stages)', () => {
            /** 每輪依賴之契約鍵(套件子階段與自寫子階段同一條注入通道;皆為可列舉之普通屬性) */
            const DEPS_KEYS = ['ai', 'clock', 'data', 'dirs', 'domains', 'locale', 'netGuard', 'registry', 'seen', 'settings', 'siteAdapterSpecs', 'stores', 'vocab']

            it('cfg.stages 整組取代內建子階段:自寫子階段經 ctx.deps 取得依賴;單一子階段失敗被隔離、後續照跑;摘要退用通用格式並列出失敗者', async () => {
                const seenDeps = []
                const stages = [
                    { name: 'boom', run: async () => {
                        throw new Error('自訂子階段失敗')
                    } },
                    { name: 'peek', run: async (ctx) => {
                        seenDeps.push(Object.keys(ctx.deps).sort())
                        const docs = await ctx.deps.stores.docs.select()
                        return stdReport({ stats: { in: docs.length }, detail: { domain: ctx.deps.vocab.domain, seeds: ctx.deps.data.seedSources.length, area: ctx.deps.settings.capture.discover.ai.use } })
                    } },
                ]
                const { flow } = buildTestCapture(rootOf('pkg-stages'), {
                    stages,
                    data: { seedSources: [{ kind: 'rss', tier: 1, name: '天文學測試來源', url: FEED_URL, lang: 'zh' }], vocab: { domain: '天文學' } },
                    capture: { discover: { ai: SEAT } },
                })
                const rep = await flow.run()
                // 規則:createKnowledgeCapture.buildDeps——每輪依賴為可列舉之普通屬性(w-data-pipeline 之 createContext 以 spread 複製 deps,getter 會消失)
                assert.deepEqual(seenDeps, [DEPS_KEYS])
                const sub = rep.stages[0].result.detail
                // 規則:captureObject.runSubStages——子階段失敗預設隔離(記 detail、續跑後續);內建子階段未建立
                assert.deepEqual(Object.keys(sub), ['boom', 'peek'])
                assert.equal(sub.boom.ok, false)
                assert.match(sub.boom.summary, /自訂子階段失敗/)
                assert.deepEqual(sub.peek.detail, { domain: '天文學', seeds: 1, area: 'stub:astro-seat' })
                // 規則:captureObject.summaryOf——有子階段失敗時一律走通用摘要並列出失敗者(不掩蓋失敗)
                assert.equal(rep.stages[0].result.summary, '1/2 段完成（in 0、out 0、fail 1）｜失敗：boom')
            })

            it('cfg.afterRun:給函數才跑;於管線與執行摘要之後執行(摘要檔已落地)、取得 { report, summaryFile, log, deps }、回傳值掛 report.afterRun', async () => {
                const seen = []
                const { flow } = buildTestCapture(rootOf('pkg-afterrun'), {
                    log: recLog(),
                    capture: { areas: { perRun: 0 }, browser: { perRun: 0 } },
                    afterRun: async (ctx) => {
                        seen.push({ keys: Object.keys(ctx).sort(), summaryExists: fs.existsSync(ctx.summaryFile), reportOk: ctx.report.ok, deps: Object.keys(ctx.deps).sort() })
                        return { ok: true, tag: 'done' }
                    },
                })
                const rep = await flow.run()
                // 規則:createKnowledgeCapture.run 之收尾鉤子在管線外、摘要之後,收尾讀 run.json 時當輪的已存在
                assert.deepEqual(seen, [{ keys: ['deps', 'log', 'report', 'summaryFile'], summaryExists: true, reportOk: true, deps: DEPS_KEYS }])
                assert.deepEqual(rep.afterRun, { ok: true, tag: 'done' })
                assert.equal(rep.summaryFile && fs.existsSync(rep.summaryFile), true)
            })

            it('cfg.afterRun 失敗(回 ok:false 或拋錯)只留 WARN、不影響本輪成敗;未給 afterRun 者 report 無此欄', async () => {
                const log = recLog()
                let mode = 'fail'
                const { flow } = buildTestCapture(rootOf('pkg-afterrun-fail'), {
                    log,
                    capture: { areas: { perRun: 0 }, browser: { perRun: 0 } },
                    afterRun: async () => {
                        if (mode === 'throw') throw new Error('收尾炸了')
                        return { ok: false, error: '收尾回報失敗' }
                    },
                })
                const r1 = await flow.run()
                // 規則:收尾失敗只留 warn(createKnowledgeCapture 檔頭【收尾在管線之外、摘要之後】)
                assert.equal(r1.ok, true, '收尾失敗不得翻轉本輪成敗')
                assert.deepEqual(r1.afterRun, { ok: false, error: '收尾回報失敗' })
                assert.ok(log.lines.some((l) => /^WARN 收尾失敗：收尾回報失敗（/.test(l)), log.lines.join('\n'))
                mode = 'throw'
                const r2 = await flow.run()
                assert.equal(r2.ok, true)
                assert.deepEqual(r2.afterRun, { ok: false, error: '收尾炸了' })
                assert.ok(log.lines.some((l) => /^WARN 收尾鉤子拋錯：收尾炸了/.test(l)), log.lines.join('\n'))
                const plain = buildTestCapture(rootOf('pkg-afterrun-none'), { capture: { areas: { perRun: 0 }, browser: { perRun: 0 } } }).flow
                assert.ok(!('afterRun' in await plain.run()))
            })
        })

        // ── 覆寫不污染預設 ──
        describe('覆寫不污染預設', () => {
            it('上述覆寫之後:預設常數未被改動;resolveSettings 之各實例互不共用預設之陣列與物件', () => {
                // 規則:core/settingsDefault.cloneSettingsDefault——各實例拿到預設之複本,就地修改不汙染同行程之其他實例
                assert.deepEqual([CAPTURE_DEFAULT.sources.itemsPerSource, CAPTURE_DEFAULT.articles.maxTries, CAPTURE_DEFAULT.discover.everyHours], [8, 3, 24])
                assert.equal(SKIP_TITLE_PATTERNS_DEFAULT.length, 5)
                assert.equal(CAPTURE_DEFAULT.discover.ai.use, 'oc:opencode/mimo-v2.6-flash-free')
                assert.deepEqual([VOCAB_DEFAULT.domain, VOCAB_DEFAULT.kbLabel], ['', ''])
                const a = resolveSettings({})
                a.capture.areas.arxivCategories.push('x')
                a.capture.discover.ai.fallback.push('y')
                a.capture.articles.skipTitlePatterns.push({ p: 'z' })
                a.capture.sources.itemsPerSource = 99
                const b = resolveSettings({})
                assert.ok(!b.capture.areas.arxivCategories.includes('x') && !CAPTURE_DEFAULT.areas.arxivCategories.includes('x'))
                assert.ok(!b.capture.discover.ai.fallback.includes('y') && !CAPTURE_DEFAULT.discover.ai.fallback.includes('y'))
                assert.equal(b.capture.articles.skipTitlePatterns.length, 5)
                assert.equal(CAPTURE_DEFAULT.articles.skipTitlePatterns.length, 5)
                assert.equal(b.capture.sources.itemsPerSource, 8)
            })
        })
    })

    // ═══════════════════════ ④ cfg 檢核 ═══════════════════════
    describe('④ cfg 檢核(未知鍵、子鍵、形狀錯誤一律啟動期拋錯)', () => {
        const roots = []
        const workDir = () => {
            const r = tmpRoot('pkg-cfg')
            roots.push(r)
            return r
        }
        after(() => {
            removeRoots(roots)
        })
        const build = (cfg) => () => createKnowledgeCapture({ workDir: `${ROOT}/test/_tmp/pkg-cfg-unused`, ...cfg })

        it('workDir 為唯一必填;cfg 之未知鍵拋錯並列出可用鍵(打錯之鍵不靜默沿用預設)', () => {
            // 規則:createKnowledgeCapture 之 checkKeys(CFG_KEYS)
            assert.throws(() => createKnowledgeCapture({}), /需要 workDir/)
            assert.throws(() => createKnowledgeCapture(), /需要 workDir/)
            assert.throws(build({ foo: 1 }), /cfg 含不認得之鍵：foo（可用：workDir、/)
            assert.throws(build({ capture: { sources: { perRun: 3 } }, aiAdapte: stubAdapter(() => 'fail') }), /cfg 含不認得之鍵：aiAdapte/)
        })

        it('cfg 頂層只認得 CFG_KEYS 所列(設定只有 ai、capture 兩段,無相容層):sourcePolicy、standards、openAlexMailto 等不在其內之鍵一律被拒(來源政策、標準、信箱各在 capture.sources／standards／services.openAlex.mailto)', () => {
            // 規則:createKnowledgeCapture.CFG_KEYS 只收 ai、capture 兩個設定段;不在清單之鍵若靜默接受,安裝方之設定會失效而無人察覺
            for (const old of ['sourcePolicy', 'standards', 'openAlexMailto']) {
                assert.throws(build({ [old]: {} }), new RegExp(`cfg 含不認得之鍵：${old}（可用：`), old)
                assert.ok(!CFG_KEYS.includes(old), `${old} 不得在 CFG_KEYS`)
            }
            assert.deepEqual(CFG_KEYS.filter((k) => ['ai', 'capture'].includes(k)), ['ai', 'capture'], '設定段只有 ai、capture')
        })

        it('CFG_KEYS 與程式實際讀取之 cfg 鍵一致:讀取者皆在清單內、清單內每鍵皆有讀取者(無被接受卻無效之鍵);清單內每個鍵單獨傳入皆被接受', () => {
            // 規則:createKnowledgeCapture.CFG_KEYS 之註記——新增讀取 cfg.<鍵> 處須同步列入;漏列者安裝方傳入即被當未知鍵,多列者被接受卻靜默無效
            const readers = ['src/createKnowledgeCapture.mjs', 'src/captureRuntime.mjs', 'src/core/runtime.mjs', 'src/core/dirs.mjs', 'src/core/settingsDefault.mjs', 'src/core/assemblyKit.mjs']
            // 判準自檢(詞法器之骨架):字串、樣板文字段與註解中之 cfg.<鍵> 不算讀取;樣板之 ${…} 運算式中者算
            assert.deepEqual([...lexSource("x(cfg.a); y('cfg.b'); z(\"cfg.c\"); w(`cfg.d ${cfg.e} ${f('cfg.g')}`) // cfg.h\n/* cfg.i */").skeleton.matchAll(/\bcfg\??\.([A-Za-z_]\w*)/g)].map((m) => m[1]), ['a', 'e'])
            const read = new Set()
            for (const f of readers) {
                for (const m of lexSource(readText(f) || '').skeleton.matchAll(/\bcfg\??\.([A-Za-z_]\w*)/g)) read.add(m[1])
            }
            assert.deepEqual([...read].filter((k) => !CFG_KEYS.includes(k)).sort(), [], '程式讀取之 cfg 鍵須皆列入 CFG_KEYS')
            assert.deepEqual(CFG_KEYS.filter((k) => !read.has(k)).sort(), [], 'CFG_KEYS 內不得有無人讀取之鍵')
            // 每鍵單獨傳入最小合法值皆被接受(不因鍵名被拒)
            const valid = {
                workDir: workDir(), dirs: {}, timeZone: 'Asia/Taipei', clock: genClockTZ('Asia/Taipei'), lang: 'zh-TW', data: {}, prompts: {}, conceptFold: true,
                ai: {}, capture: {}, scheduleLimitMin: 60, deadlineMs: 1_000_000, lockStaleMs: 3_600_000,
                name: '自訂管線名', lock: false, envFile: '.env', aiWorkspace: 'ws', aiAdapter: stubAdapter(() => 'fail'), aiOptions: {}, stages: [{ name: 'x', run: async () => stdReport() }],
                stageOpts: {}, fetchers: [], siteAdapters: [], dedup: { keyOf: 'raw' }, lmdb: {}, notes: false,
                logFactory: () => ({ info: () => {}, warn: () => {}, error: () => {} }), afterRun: false, netGuard: null,
            }
            assert.deepEqual(Object.keys(valid).sort(), [...CFG_KEYS].sort(), '本測試之最小合法值須涵蓋全部可用鍵')
            for (const [k, v] of Object.entries(valid)) {
                assert.doesNotThrow(() => createKnowledgeCapture({ workDir: valid.workDir, [k]: v }), `鍵 ${k} 單獨傳入須被接受`)
            }
        })

        it('設定兩段(ai、capture):組非物件、未知子鍵、型別與值域錯誤皆拋錯(訊息指出完整路徑)', () => {
            // 規則:core/settingsDefault.mergeSettingsGroup——各組以 schema 逐鍵驗型別與值域,路徑含組名
            assert.throws(build({ capture: 'x' }), /settings\.capture 須為物件/)
            assert.throws(build({ capture: { bogusKey: 1 } }), /settings\.capture 含不認得之鍵：bogusKey（可用：/)
            assert.throws(build({ capture: { sources: 'x' } }), /settings\.capture\.sources 須為物件，收到 "x"/)
            assert.throws(build({ capture: { sources: { perRun: '6' } } }), /settings\.capture\.sources\.perRun 須為非負整數，收到 "6"/)
            assert.throws(build({ capture: { sources: { bogus: 1 } } }), /settings\.capture\.sources 含不認得之鍵：bogus/)
            assert.throws(build({ capture: { sources: { lowYieldRate: 2 } } }), /settings\.capture\.sources\.lowYieldRate 須為\s?0～1 之數，收到 2/)
            assert.throws(build({ capture: { areas: { minFreshRate: 1.5 } } }), /settings\.capture\.areas\.minFreshRate 須為\s?0～1 之數，收到 1\.5/)
            assert.throws(build({ capture: { areas: { arxivCategories: 'cs.LG' } } }), /settings\.capture\.areas\.arxivCategories 須為字串陣列/)
            assert.throws(build({ capture: { expand: { arxivCategories: 'cs.LG' } } }), /settings\.capture\.expand\.arxivCategories 須為字串陣列/)
            assert.throws(build({ capture: { browser: { camofox: { port: 0 } } } }), /settings\.capture\.browser\.camofox\.port 須為正整數，收到 0/)
            assert.throws(build({ capture: { services: { openAlex: { mailto: 5 } } } }), /settings\.capture\.services\.openAlex\.mailto 須為字串，收到 5/)
            assert.throws(build({ capture: { standards: { placeholderPatterns: [{ p: '(' }] } } }), /placeholderPatterns\[0\] 樣式不合法/)
            assert.throws(build({ capture: { standards: { scanEachRun: 'yes' } } }), /settings\.capture\.standards\.scanEachRun 須為布林值/)
            assert.throws(build({ capture: { standards: { bogus: true } } }), /settings\.capture\.standards 含不認得之鍵：bogus/)
            assert.throws(build({ ai: { bogus: 1 } }), /settings\.ai 含不認得之鍵：bogus/)
            assert.throws(build({ ai: { area: { use: 'oc:x' } } }), /settings\.ai 含不認得之鍵：area/)
            assert.throws(build({ capture: { discover: { ai: { use: 'x', timeout: 1 } } } }), /settings\.capture\.discover\.ai 須為席位物件.*含不認得之鍵：timeout/)
            assert.throws(build({ capture: { discover: { ai: { fallback: [] } } } }), /settings\.capture\.discover\.ai 須為席位物件.*use 須為非空字串/)
        })

        it('設定鍵須放所屬組內(無相容層):capture 頂層之扁平鍵、capture.terminalStatuses、capture.areas.gridArxivCategories、cfg.data.skipTitlePatterns 皆被拒並列出可用之鍵', () => {
            assert.throws(build({ capture: { sourcesPerRun: 3 } }), /settings\.capture 含不認得之鍵：sourcesPerRun/)
            assert.throws(build({ capture: { terminalStatuses: [] } }), /settings\.capture 含不認得之鍵：terminalStatuses/)
            assert.throws(build({ capture: { areas: { gridArxivCategories: null } } }), /settings\.capture\.areas 含不認得之鍵：gridArxivCategories/)
            assert.throws(build({ data: { skipTitlePatterns: [] } }), new RegExp(`cfg\\.data 含不認得之鍵：skipTitlePatterns（可用：${DATA_KEYS.join('、')}）`))
            assert.deepEqual([...DATA_KEYS], ['seedSources', 'gridTopics', 'vocab'])
        })

        it('設定 schema、預設與程式讀取三者一致:各組 schema 鍵＝預設鍵(預設有而 schema 無者安裝方無法覆寫);程式以 settings.capture.<組>.<鍵>／cap.<組>.<鍵> 讀取者皆在 schema;schema 每個葉鍵至少被一處原始碼引用', () => {
            // 規則:core/settingsDefault【設定錯誤一律啟動期拋錯】——各組之鍵集即可用鍵;讀到 schema 外之鍵即讀到 undefined(靜默失效),無人引用之鍵即被接受卻無效
            const code = Object.fromEntries(sourceFiles().filter((f) => f.startsWith('src/') && !f.startsWith('src/bench/')).map((f) => [f, lexSource(readText(f) || '').code]))
            assert.ok(Object.keys(code).length >= 40)
            // 各組(含根)之 schema 鍵集＝預設鍵集
            const groupsOf = (schema, dflt, prefix = []) => [[prefix.join('.'), schema, dflt], ...Object.entries(schema).filter(([, n]) => typeof n !== 'string').flatMap(([k, n]) => groupsOf(n, dflt[k], [...prefix, k]))]
            for (const [name, schema, dflt] of [...groupsOf(CAPTURE_SCHEMA, CAPTURE_DEFAULT, ['capture']), ...groupsOf(AI_SCHEMA, AI_DEFAULT, ['ai'])]) {
                assert.deepEqual(Object.keys(schema).sort(), Object.keys(dflt).sort(), `${name} 之 schema 鍵須等於預設鍵`)
            }
            // 程式讀取:settings.capture.<組>.<鍵> 與別名 cap.<組>.<鍵>(組名須為 capture 之組)皆須在 schema
            const groups = Object.keys(CAPTURE_SCHEMA)
            const read = new Set()
            const topRead = new Set()
            for (const c of Object.values(code)) {
                for (const m of c.matchAll(/settings\??\.capture\??\.([A-Za-z_]\w*)/g)) topRead.add(m[1])
                for (const m of c.matchAll(/(?:settings\??\.capture|\bcap)\??\.([A-Za-z_]\w*)\??\.([A-Za-z_]\w*)/g)) if (groups.includes(m[1])) read.add(`${m[1]}.${m[2]}`)
            }
            assert.ok(read.size >= 20, `須讀得到足量之 capture.<組>.<鍵> 讀取者(掃描非空洞)：${read.size}`)
            assert.deepEqual([...topRead].filter((k) => !groups.includes(k)).sort(), [], 'settings.capture.<x> 之 x 須為 capture 之組(不得讀扁平鍵)')
            assert.deepEqual([...read].filter((p) => !(p.split('.')[1] in CAPTURE_SCHEMA[p.split('.')[0]])).sort(), [], '程式讀取之 capture.<組>.<鍵> 須皆在 schema')
            // 每個葉鍵(組內之鍵名)至少被一處原始碼引用(settingsDefault 本身不計)
            const leafKeys = (schema) => Object.entries(schema).flatMap(([k, n]) => (typeof n === 'string' ? [k] : leafKeys(n)))
            const unused = [...new Set([...leafKeys(CAPTURE_SCHEMA), ...leafKeys(AI_SCHEMA)])].filter((k) => !Object.entries(code).some(([f, c]) => f !== 'src/core/settingsDefault.mjs' && new RegExp(`\\b${k}\\b`).test(c)))
            assert.deepEqual(unused, [], 'schema 之葉鍵須至少被一處原始碼引用')
        })

        it('cfg.data:形狀、未知鍵、詞彙表(未知鍵與型別);標題預篩樣式(capture.articles.skipTitlePatterns)之形狀與編譯於建構期驗', () => {
            // 規則:createKnowledgeCapture.resolveData／core/vocab/vocabDefault.resolveVocab;標題預篩樣式之形狀歸 settings schema、編譯於建構期以 toPatterns 驗
            assert.throws(build({ data: 'x' }), /cfg\.data 須為物件/)
            assert.throws(build({ data: { bogus: [] } }), new RegExp(`cfg\\.data 含不認得之鍵：bogus（可用：${DATA_KEYS.join('、')}）`))
            assert.throws(build({ data: { seedSources: {} } }), /cfg\.data\.seedSources 須為陣列/)
            assert.throws(build({ data: { gridTopics: 'x' } }), /cfg\.data\.gridTopics 須為陣列/)
            assert.throws(build({ capture: { articles: { skipTitlePatterns: ['^abc'] } } }), /settings\.capture\.articles\.skipTitlePatterns 須為樣式陣列（RegExp 或 \{ p: 樣式字串, f\?: 旗標 \}）/)
            assert.throws(build({ capture: { articles: { skipTitlePatterns: [{ p: '(' }] } } }), /capture\.articles\.skipTitlePatterns\[0\] 樣式不合法/)
            assert.throws(build({ data: { vocab: { kbLable: 'x' } } }), /vocab 含不認得之鍵：kbLable/)
            assert.throws(build({ data: { vocab: { kbLabel: 5 } } }), /vocab\.kbLabel 須為字串/)
            assert.throws(build({ data: { vocab: { conceptAliases: { a: '' } } } }), /vocab\.conceptAliases 之「a」須對應非空字串/)
        })

        // 規則:createKnowledgeCapture.resolveData 以 fetchers/endpoints 之 checkSeedSources／checkGridTopics 於建構期驗逐項形狀
        //   (createKnowledgeCapture 檔頭【啟動期檢核】)。未驗時之實測後果:gridTopics 給字串陣列(['planetary science'])→ 執行時
        //   stores/areaPolicy.syncSeedAreas 以 [label, query] 解構取字串前兩個字元成領域 p／查詢 l,並對外發出該查詢;[['只有標籤']] → 每輪 seedSync
        //   失敗;seedSources 缺 kind → 以失真之 id 入庫、整個 listFetch 於執行期失敗(url 可省:無 url 之虛擬來源以 name 為身分)
        it('cfg.data.gridTopics 之每項須為 [標籤, 查詢] 字串對、seedSources 之每項須含 kind 且 url／name 至少一:逐項形狀錯誤於建構期拋錯', () => {
            assert.throws(build({ data: { gridTopics: ['planetary science'] } }), /cfg\.data\.gridTopics\[0\] 須為 \[標籤, 查詢\] 字串對/)
            assert.throws(build({ data: { gridTopics: [['只有標籤']] } }), /cfg\.data\.gridTopics\[0\] 須為 \[標籤, 查詢\] 字串對/)
            assert.throws(build({ data: { gridTopics: [['標籤', '']] } }), /cfg\.data\.gridTopics\[0\] 須為 \[標籤, 查詢\] 字串對/)
            assert.throws(build({ data: { seedSources: [{ name: '無來源' }] } }), /cfg\.data\.seedSources\[0\] 須為含 kind 之物件/)
            assert.throws(build({ data: { seedSources: ['https://astro.invalid/feed.xml'] } }), /cfg\.data\.seedSources\[0\] 須為含 kind 之物件/)
            assert.throws(build({ data: { seedSources: [{ kind: 'rss' }] } }), /cfg\.data\.seedSources\[0\] 須為含 kind 之物件.*url 可省，省時 name 必給/, 'url 與 name 皆缺即拋')
            assert.doesNotThrow(build({ data: { seedSources: [{ kind: 'rss', name: '只有名稱之虛擬來源' }] } }), '無 url 之虛擬來源(有 name)於建構期放行')
        })

        it('cfg.prompts、cfg.stages／stageOpts:未知鍵、非函數、重名、兩者並給皆拋錯', () => {
            // 規則:core/assemblyKit.resolvePromptsCfg／checkStageConfig(createKnowledgeCapture 以之組裝)
            assert.throws(build({ prompts: 'x' }), /cfg\.prompts 須為物件/)
            assert.throws(build({ prompts: { bogus: () => 'x' } }), new RegExp(`cfg\\.prompts 含不認得之鍵：bogus（可用：${PROMPT_KEYS.join('、')}）`))
            assert.throws(build({ prompts: { area: 'text' } }), /cfg\.prompts\.area 須為函數/)
            assert.throws(build({ stageOpts: { bogus: {} } }), new RegExp(`cfg\\.stageOpts 含不認得之鍵：bogus（可用：${CAPTURE_STAGE_KEYS.join('、')}）`))
            assert.throws(build({ stageOpts: { listFetch: 5 } }), /cfg\.stageOpts\.listFetch 須為物件/)
            assert.throws(build({ stages: [] }), /cfg\.stages 須為非空陣列/)
            assert.throws(build({ stages: [{ name: 'a' }] }), /cfg\.stages\[0\] 須為 \{ name: 非空字串, run\(ctx\) \}/)
            assert.throws(build({ stages: [{ name: 'a', run: () => {} }, { name: 'a', run: () => {} }] }), /cfg\.stages 有重複之子階段名：a/)
            assert.throws(build({ stages: [{ name: 'a', run: () => {} }], stageOpts: {} }), /cfg\.stages（整組自訂子階段）與 cfg\.stageOpts（內建子階段之 opt）擇一/)
        })

        it('cfg.lmdb、cfg.notes、cfg.dirs:未知鍵、型別、集合名衝突皆拋錯', () => {
            // 規則:core/assemblyKit.resolveLmdbCfg／resolveDirsCfg(createKnowledgeCapture 以之組裝)
            assert.throws(build({ lmdb: 'x' }), /cfg\.lmdb 須為物件/)
            assert.throws(build({ lmdb: { bogus: 1 } }), /cfg\.lmdb 含不認得之鍵：bogus/)
            assert.throws(build({ lmdb: { WOrm: {} } }), /cfg\.lmdb\.WOrm 須為 ORM 建構函數/)
            assert.throws(build({ lmdb: { path: '' } }), /cfg\.lmdb\.path 須為非空字串/)
            assert.throws(build({ lmdb: { cls: { bogus: 'x' } } }), new RegExp(`cfg\\.lmdb\\.cls 含不認得之鍵：bogus（可用：${COLLECTION_KEYS.join('、')}）`))
            assert.throws(build({ lmdb: { cls: { docs: '' } } }), /cfg\.lmdb\.cls\.docs 須為非空字串/)
            assert.throws(build({ notes: 5 }), /cfg\.notes 須為 false/)
            assert.throws(build({ notes: 'a', lmdb: { cls: { notes: 'b' } } }), /cfg\.notes（a）與 cfg\.lmdb\.cls\.notes（b）不一致/)
            assert.throws(build({ dirs: 'x' }), /cfg\.dirs 須為物件/)
            assert.throws(build({ dirs: { bogus: 'x' } }), /cfg\.dirs 含不認得之鍵：bogus（可用：db、log、tmp、state、knowledge）/)
            assert.throws(build({ dirs: { db: 5 } }), /cfg\.dirs\.db 須為非空路徑字串/)
        })

        it('抓取器、站台 adapter、AI 調度層、網路判斷器、日誌、收尾鉤子、時鐘、時區:形狀錯誤拋錯', () => {
            assert.throws(build({ fetchers: {} }), /cfg\.fetchers 須為抓取器陣列/)
            assert.throws(build({ fetchers: [5] }), /cfg\.fetchers\[0\] 須為抓取器物件/)
            assert.throws(build({ siteAdapters: {} }), /cfg\.siteAdapters 須為站台 adapter 陣列/)
            assert.throws(build({ siteAdapters: [{ id: 'x' }] }), /cfg\.siteAdapters\[0\]\(id=x\) 不合 w-fetch-web adapter 契約/)
            assert.throws(build({ aiAdapter: {} }), /cfg\.aiAdapter 須為具 callJson/)
            assert.throws(build({ netGuard: 'x' }), /cfg\.netGuard 須為網路判斷器物件/)
            assert.throws(build({ logFactory: 5 }), /cfg\.logFactory 須為函數/)
            assert.throws(build({ afterRun: 5 }), /cfg\.afterRun 須為函數/)
            assert.throws(build({ clock: {} }), /cfg\.clock 須為時鐘物件/)
            assert.throws(build({ timeZone: 'Nowhere/City' }), /cfg\.timeZone 無效（Nowhere\/City）/)
            assert.throws(build({ timeZone: 5 }), /cfg\.timeZone 須為 IANA 時區字串/)
            assert.throws(build({ conceptFold: 'x' }), /cfg\.conceptFold 須為 false/)
            assert.throws(build({ lock: 5 }), /cfg\.lock 須為 false/)
            assert.throws(build({ envFile: 5 }), /cfg\.envFile 須為路徑字串/)
        })

        it('AI 席位無法解析(內建目錄無此條目)於建構期拋錯並附最接近之條目;未覆寫時預設席位可解析', () => {
            // 規則:core/ai/adapter.validateSeats——席位引用不可用之條目即拋(靜默略過會讓遞補鏈莫名變短)
            assert.throws(build({ capture: { discover: { ai: { use: 'oc:opencode/no-such-model-free' } } } }), /AI 席位於啟動期檢核失敗（1 席）：capture\.discover\.ai → 席位引用了不可用的條目：oc:opencode\/no-such-model-free（內建目錄與 ai\.extraProviders 皆無/)
            assert.doesNotThrow(() => createKnowledgeCapture({ workDir: workDir(), netGuard: null, lock: false }), '套件預設席位須可解析(w-dispatch-ai 升版後引用之條目須仍在其目錄)')
        })
    })

    // ═══════════════════════ ⑤ package.json ═══════════════════════
    describe('⑤ package.json', () => {
        const pkg = JSON.parse(fs.readFileSync(`${ROOT}/package.json`, 'utf8'))
        /** 測試執行器(由 scripts.test 呼叫,不被 import;隨編譯工具套件 BUILD_TOOLS 安裝) */
        const TEST_RUNNER = 'mocha'
        /** 編譯與文件工具套件(toolg/ 以 w-package-tools 之 src 深層路徑取用;同自有套件之 devDependencies) */
        const BUILD_TOOLS = 'w-package-tools'
        /** 檔案所屬群組:src/ 為套件原始碼(lib)、test/ 為測試、其餘(g.mjs、toolg/)為範例與編譯工具(tool) */
        const groupOf = (file) => (file.startsWith('test/') ? 'test' : file.startsWith('src/') ? 'lib' : 'tool')

        it('scripts 為 test(mocha --parallel 之標準指令)與 deploy(文件發布,同自有套件之範本),不增設其他指令', () => {
            // 規則:套件之 package.json 提供 npm test(有 parallel 之標準寫法)與 deploy(gh-pages -d docs;自有套件範本皆有)
            assert.deepEqual(Object.keys(pkg.scripts), ['test', 'deploy'])
            assert.equal(pkg.scripts.test, 'mocha --parallel "test/*.test.mjs" --timeout 180000')
            assert.equal(pkg.scripts.deploy, 'gh-pages -d docs')
        })

        /**
         * wsemi 自行規定並安裝之依賴(dayjs、lodash-es 等):自有套件之慣例是依賴由該自有套件統籌,使用端不重列
         * (自 node_modules 之 wsemi/package.json 讀取,依 Node 之由近而遠解析)
         *
         * @returns {Set} 回傳套件名集合
         */
        function providedByWsemi() {
            for (let dir = ROOT; ; dir = path.dirname(dir)) {
                const f = `${dir}/node_modules/wsemi/package.json`
                if (fs.existsSync(f)) return new Set(Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).dependencies || {}))
                if (path.dirname(dir) === dir) throw new Error('找不到 node_modules/wsemi(須先安裝套件依賴)')
            }
        }

        it('依賴對帳:src/ 之 import 套件＝dependencies(wsemi 自帶者除外);測試與編譯工具(g.mjs、toolg/)另 import 者在 devDependencies;所列者皆有使用者', () => {
            const scan = scanAll()
            const deps = new Set(Object.keys(pkg.dependencies || {}))
            const dev = new Set(Object.keys(pkg.devDependencies || {}))
            const byWsemi = providedByWsemi()
            assert.ok(deps.has('wsemi') && byWsemi.has('dayjs'), '前提：wsemi 為依賴且其依賴含 dayjs')
            const used = { lib: new Set(), test: new Set(), tool: new Set() }
            for (const r of scan.rows.filter((x) => x.kind === 'package' && x.pkg && !x.problem)) used[groupOf(r.file)].add(r.pkg)
            const libMissing = [...used.lib].filter((p) => !deps.has(p) && !byWsemi.has(p))
            const devMissing = [...used.test, ...used.tool].filter((p) => !deps.has(p) && !dev.has(p) && !byWsemi.has(p))
            assert.deepEqual([libMissing, devMissing], [[], []], '被 import 之套件須列於 package.json')
            assert.deepEqual([...deps].filter((p) => !used.lib.has(p)), [], 'dependencies 不得有 src/ 未使用者')
            // 測試執行器 mocha 由 scripts.test 呼叫、不被 import:隨編譯工具套件安裝(同自有套件),不在 import 對帳之內,但須可解析
            assert.ok(dev.has(BUILD_TOOLS) && used.tool.has(BUILD_TOOLS), `編譯工具套件 ${BUILD_TOOLS} 須列於 devDependencies 且被 toolg/ 使用`)
            assert.doesNotThrow(() => import.meta.resolve(TEST_RUNNER), `測試執行器 ${TEST_RUNNER} 須已安裝`)
            assert.deepEqual([...dev].filter((p) => !used.test.has(p) && !used.tool.has(p)), [], 'devDependencies 不得有測試與編譯工具未使用者')
            assert.deepEqual([...dev].filter((p) => used.lib.has(p)), [], 'src/ 使用者須列於 dependencies')
            // 掃描非空洞:套件之主要外部依賴確實被掃到
            for (const p of ['wsemi', 'w-data-pipeline', 'w-fetch-web', 'w-dwdata-hub', 'w-orm-lmdb', 'w-dispatch-ai', 'opencc-js']) assert.ok(used.lib.has(p), `應掃到對 ${p} 之引用`)
        })

        it('依賴為 semver 範圍,不指向本機路徑(file:／link:／絕對路徑);執行秩序件來源三套件之安裝版合於所列範圍(新函數須有之最低版)', () => {
            for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
                assert.match(range, /^[\^~>=<]*\d+\.\d+\.\d+/, `${name} 之版本範圍須為 semver：${range}`)
            }
            // 規則:匯入點所取之深層路徑於來源套件之某版起才有;安裝版低於所列最低版即找不到模組,所列範圍須與實際安裝相容
            const cmp = (a, b) => a.map(Number).reduce((r, v, i) => (r !== 0 ? r : v - Number(b[i])), 0)
            for (const p of ORDER_PKGS) {
                const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.dependencies[p])
                assert.ok(m, `${p} 之範圍須為 ^x.y.z：${pkg.dependencies[p]}`)
                const installed = JSON.parse(fs.readFileSync(fileURLToPath(import.meta.resolve(`${p}/package.json`)), 'utf8')).version.split('.')
                assert.equal(installed[0], m[1], `${p} 安裝版 ${installed.join('.')} 之主版號須同所列 ${pkg.dependencies[p]}`)
                assert.ok(cmp(installed, m.slice(1)) >= 0, `${p} 安裝版 ${installed.join('.')} 須 ≥ 所列最低版 ${m[1]}.${m[2]}.${m[3]}`)
            }
        })

        it('入口可載入:main 指向 dist 之 UMD(dist 由發布流程產製,不要求存在),ESM 入口 src/WKnowledgeCapture.mjs 存在;預設匯出物件與具名匯出為同一組(含 createKnowledgeCapture)', async () => {
            // 規則(移植指定詞):自有套件發布後 main 指 UMD、原始碼在 src/,下游一律以「套件名/src/入口檔」取 ESM 入口——
            //   套件不設 exports(設了即擋掉該子路徑與 test/tools 之深層路徑),入口檔須實際存在於 src/
            assert.equal(pkg.main, `dist/${pkg.name}.umd.js`)
            assert.ok(fs.existsSync(`${ROOT}/src/WKnowledgeCapture.mjs`), 'ESM 入口 src/WKnowledgeCapture.mjs 須存在')
            const mod = await import('../src/WKnowledgeCapture.mjs')
            // 規則:WKnowledgeCapture 之預設匯出由同一組命名空間合成,具名匯出與預設物件必然同一組名稱
            assert.equal(typeof mod.createKnowledgeCapture, 'function')
            assert.equal(mod.default.createKnowledgeCapture, mod.createKnowledgeCapture)
            const named = Object.keys(mod).filter((k) => k !== 'default').sort()
            assert.deepEqual(Object.keys(mod.default).sort(), named)
        })

        it('發布面:不設 exports 與 files(下游以深層路徑取用 src/ 與 test/tools/);無 .npmignore,發布範圍依 .gitignore(CLAUDE*.md 與暫存不入包);npm pack --dry-run 之清單含 sgud/、test/tools/、src/ 而不含 CLAUDE*.md 與暫存;套件根範本檔齊備;LICENSE 為 MIT 且署名同作者', () => {
            // 規則:設 exports 即擋掉「套件名/src/…」「套件名/test/tools/…」之深層路徑(下游套件與專案以之取用);設 files 白名單則套件根新增檔案時易漏
            assert.equal(pkg.exports, undefined, '不設 exports')
            assert.equal(pkg.files, undefined, '不設 files(發布範圍依 .gitignore)')
            assert.equal(pkg.name, 'w-knowledge-capture')
            assert.deepEqual([pkg.repository.type, pkg.repository.url], ['git', 'git+https://github.com/yuda-lyu/w-knowledge-capture.git'])
            assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.length >= 3 && typeof pkg.author === 'string' && pkg.author.length > 0, 'keywords 與 author 須有')
            // 發布範圍(自有套件之 npm 發布範圍):預設不提供 .npmignore,npm 包＝git 版控之內容(依 .gitignore);sgud/(agent 之指引要求文件:經驗、處理要點、
            //   規則帳本、現況)、test/(含下游取用之 test/tools/)、docs/ 皆隨包;CLAUDE*.md 由 .gitignore 排除,不入版控亦不入包。
            //   只有外部執行檔與單一資料夾 ≥10MB 之非程式碼資料才提供 .npmignore——本套件兩者皆無(test/、docs/ 皆 <10MB),故不得有該檔
            //   (npm 於有 .npmignore 時不讀 .gitignore,CLAUDE*.md 與暫存即須另列、sgud 易被誤列)
            assert.equal(fs.existsSync(`${ROOT}/.npmignore`), false, '不得有 .npmignore(發布範圍依 .gitignore;本套件無外部執行檔與 ≥10MB 之非程式碼資料)')
            const gitignore = (readText('.gitignore') || '').split(/\r?\n/).map((l) => l.trim())
            for (const l of ['CLAUDE*.md', 'node_modules', 'tmp', 'test/_tmp', '.env']) assert.ok(gitignore.includes(l), `.gitignore 須列 ${l}`)
            assert.ok(!gitignore.some((l) => /^!?\/?(sgud|test\/tools)/.test(l) || l === '!CLAUDE.md'), '.gitignore 不得排除 sgud 與 test/tools(隨包)、不得加 !CLAUDE.md')
            // 實際打包清單(npm pack --dry-run;不寫檔、不連網):含 sgud/、test/tools/ 之全部檔與 src/ 之主入口,不含 CLAUDE*.md、AGENTS*.md、暫存與 .npmignore
            const packed = packListOf()
            for (const f of ['package.json', 'README.md', 'LICENSE', 'src/WKnowledgeCapture.mjs', 'test/unit-package.test.mjs', 'sgud/rule/rulebook.md', 'sgud/state/state.md', 'sgud/proc/process.md', 'sgud/exp/experience.md']) assert.ok(packed.includes(f), `打包清單須含 ${f}`)
            const toolFiles = fs.readdirSync(`${ROOT}/test/tools`, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => `test/tools/${e.name}`)
            assert.ok(toolFiles.length >= 5, `test/tools 之檔過少：${toolFiles.length}`)
            assert.deepEqual(toolFiles.filter((f) => !packed.includes(f)), [], 'test/tools 之檔(下游取用)須全數隨包')
            assert.ok(packed.some((f) => f.startsWith('sgud/')), '打包清單須含 sgud/')
            const leaked = packed.filter((f) => /(^|\/)(CLAUDE|AGENTS)[^/]*\.md$/.test(f) || /^(tmp|test\/_tmp|node_modules|\.agents|\.claude|\.opencode)\//.test(f) || /(^|\/)\.(env|npmignore)$/.test(f))
            assert.deepEqual(leaked, [], '打包清單不得含 CLAUDE*.md、AGENTS*.md、暫存、node_modules、.env、.npmignore')
            // 自有套件根目錄範本檔(編譯、文件、風格與安全政策)
            for (const f of ['.editorconfig', '.eslintignore', '.eslintrc.js', '.jsdoc', 'babel.config.js', 'SECURITY.md', 'g.mjs', 'README.md', 'LICENSE', 'script.txt', 'toolg/addVersion.mjs', 'toolg/modifyReadme.mjs', 'toolg/cleanFolder.mjs', 'toolg/gDocsExams.mjs', 'toolg/gDistRollup.mjs', 'test/tools/captureTestKit.mjs']) {
                assert.ok(fs.existsSync(`${ROOT}/${f}`), `套件根須有 ${f}`)
            }
            const lic = readText('LICENSE') || ''
            assert.equal(pkg.license, 'MIT')
            assert.ok(lic.startsWith('MIT License') && lic.includes(`Copyright (c) 2026 ${pkg.author}`), 'LICENSE 須為 MIT 並署名作者')
        })

        it('範例 g.mjs 離線可直接執行(不連網、不呼叫真 AI、不留工作目錄),輸出與檔末 `// =>` 逐行相符;README 之 Example 含 g.mjs 全文', () => {
            // 規則:自有套件根目錄 g.mjs 為可直接執行之範例,README 之 Example 連該檔(改 g.mjs 須同步 README)
            const g = (readText('g.mjs') || '').replace(/\r\n/g, '\n')
            const rd = (readText('README.md') || '').replace(/\r\n/g, '\n')
            assert.ok(g.length > 1000 && rd.includes(g.trimEnd()), 'README 之 Example 須含 g.mjs 全文')
            const lines = g.split('\n')
            const at = lines.findIndex((l) => l.startsWith('// => '))
            assert.ok(at > 0, 'g.mjs 檔末須附 `// =>` 輸出')
            const want = lines.slice(at).filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ => /, '').replace(/^\/\/ ?/, ''))
            const cwd = tmpRoot('pkg-g-mjs')
            fs.mkdirSync(cwd, { recursive: true })
            try {
                // 以 g.mjs 之位置載入 src,工作目錄(./_test_knowledge_capture)落在暫存夾,與套件根無關
                const out = execFileSync(process.execPath, [`${ROOT}/g.mjs`], { cwd, encoding: 'utf8', timeout: 120_000 })
                assert.deepEqual(out.replace(/\r\n/g, '\n').trimEnd().split('\n'), want)
                assert.equal(fs.existsSync(`${cwd}/_test_knowledge_capture`), false, '範例結束須清掉工作目錄')
            }
            finally {
                removeRoots([cwd])
            }
        })

        it('發布內容(README、*.csv、非測試 .mjs)不含宿主之痕跡:磁碟機絕對路徑(含字串字面中之跳脫形)與使用者目錄;test/ 內不計', () => {
            // 判準自檢:被抓到與不誤判(盤符之相對寫法、網址、正斜線之範例路徑不算)
            for (const s of ['C:\\work\\x', "'d:\\\\kb'", '/Users/me/x', 'C:/Users/me']) assert.ok(HOST_PATH.test(s), s)
            for (const s of ['c:/kb/db', "workDir: 'd:/my-kb'", 'https://a.example/b', 'a:b', '相對\\路徑']) assert.ok(!HOST_PATH.test(s), s)
            const files = [...sourceFiles('.mjs').filter((f) => !f.startsWith('test/')), ...sourceFiles('.csv').filter((f) => !f.startsWith('test/')), 'README.md']
            assert.ok(files.length >= 40 && files.some((f) => f.endsWith('.csv')), `掃描量過少或漏 csv：${files.length}`)
            const bad = []
            for (const f of files) {
                (readText(f) || '').split('\n').forEach((l, i) => {
                    if (HOST_PATH.test(l)) bad.push(`${f}:${i + 1} ${l.trim().slice(0, 80)}`)
                })
            }
            assert.deepEqual(bad, [])
        })
    })

    // ═══════════════════════ ⑥ 舊名、沿革與面向使用者之字樣 ═══════════════════════
    describe('⑥ 舊名、沿革與面向使用者之字樣(README、package.json 與原始碼〔含 bench/*.mjs;不含測試〕;判準取 test/tools/historyMarks,四套件同一份)', () => {
        // 舊名:已不存在之套件與其總組裝之名(本套件之消費者一律稱「下游」或「下游之總組裝」)
        const OLD = /w-knowledge-extract(?!or)|\bKnowledgeExtract\b|\bcreateKnowledgeExtract\b|知識套件|srcPack|extractOpt/
        // 他工作之名:本套件不以名指下游之工作(一律稱「下游」);逐行(含註解)與字樣同判
        const OTHER_JOBS = /提煉|鄰居|關聯/
        const LINE = { old: OLD, extra: [['執行端之指令', HOST_CLI], ['他工作', OTHER_JOBS]] }
        const USER = { cli: HOST_CLI, otherJobs: OTHER_JOBS }
        const files = () => [...sourceFiles().filter((x) => !x.startsWith('test/')), 'package.json', 'README.md']
        // 題組(bench/cases/*.json)之說明文字(頂層 note 與各案之 why)亦掃:說明屬原始碼之一部分,不得帶沿革;材料與應然為題材,不掃
        const caseDocs = () => sourceFiles('.json').filter((x) => x.startsWith('src/bench/cases/')).flatMap((f) => benchCaseNotesOf(f, readText(f) || ''))

        it('判準自檢:舊名、各種沿革指標、宿主之指令、他工作之名被抓到;範例資料之日期與時刻、工作目錄下之 tmp、工作流之棒名、下游套件之現名不誤判;掃描範圍含題組檔之說明(note 與各案之 why,不含材料)', () => {
            const cd = caseDocs()
            assert.ok(cd.some((d) => /#note$/.test(d.file)) && cd.filter((d) => /\.why$/.test(d.file)).length >= 10, `題組之說明須在掃描範圍:${cd.length}`)
            assert.deepEqual(benchCaseNotesOf('x.json', '{"note":"說明","cases":[{"id":"a","why":"理由","input":{"text":"此前之審查"},"expect":{"to":"盤查-42d9c6e3"}}]}'), [{ file: 'x.json#note', text: '說明' }, { file: 'x.json#a.why', text: '理由' }], '只取說明,不取材料與應然')
            assert.deepEqual([benchCaseNotesOf('y.json', '[{"id":"b","why":"w"}]'), benchCaseNotesOf('z.json', '{壞')], [[{ file: 'y.json#b.why', text: 'w' }], []], '案陣列亦可;非 JSON 回空')
            const hitsOf = (s) => historyHitsOf(s, LINE)
            for (const s of ['知識套件(w-knowledge-extract)之調度層', 'createKnowledgeExtract 之 cfg', 'srcPack/core']) assert.deepEqual(hitsOf(s), ['舊名'], s)
            assert.deepEqual(hitsOf('(2026-10-06 抓取邊界盤查 C1)'), ['日期', '帳本／審查代號'])
            assert.deepEqual(hitsOf('見 GEN-17 與 tmp/capture-pkg-audit/終審.md'), ['暫存路徑', '帳本／審查代號'])
            assert.deepEqual(hitsOf('——此前三處各寫一份而已分歧'), ['此前敘事'])
            assert.deepEqual([hitsOf('以 notes 工具清理'), hitsOf('如提煉之起草')], [['執行端之指令'], ['他工作']])
            for (const s of ["collectedAt: '2026-09-01'", "'2026-09-21T12:00:00+08:00'", "workspace: 'c:/kb/tmp/ai-workspace'", '`${workDir}/tmp/ai-workspace`', 'test/_tmp/x',
                '多棒工作流(如起草、審計、修訂、終審)', 'SHA-1 與 UTF-8', 'w-knowledge-extractor 與 createKnowledgeExtractor', '交給下游處理']) assert.deepEqual(hitsOf(s), [], s)
            assert.deepEqual([userTextHitsOf('見 STD-06 與 notes 工具', USER), userTextHitsOf('下游之關聯', USER), userTextHitsOf('抓取：本輪新增 3 篇', USER)], [['執行端之指令', '規則帳本代號'], ['他工作'], []])
        })

        it('掃描器自檢:具名例外只免其類且須仍有對象(過時列為違反);資料契約之名(引號整個包住、整串相等)不判', () => {
            const allow = [{ file: 'a.mjs', mark: '他工作', token: '跨篇關聯', why: '提示詞原文' }]
            assert.deepEqual(historyScanOf([{ file: 'a.mjs', text: '跨篇關聯 與 2026-01-02 決定' }], { ...LINE, allow }), ['a.mjs:1〔日期〕跨篇關聯 與 2026-01-02 決定'])
            assert.deepEqual(historyScanOf([{ file: 'b.mjs', text: '跨篇關聯' }], { ...LINE, allow }), ['b.mjs:1〔他工作〕跨篇關聯', '具名例外未用到(過時即須移除):a.mjs〔他工作〕跨篇關聯'])
            assert.deepEqual(historyScanOf([{ file: 'c.mjs', text: "const S = ['來源', '關聯']\n// 見關聯" }], { ...LINE, contractNames: ['關聯'] }), ['c.mjs:2〔他工作〕// 見關聯'])
            assert.deepEqual(userTextScanOf([{ file: 'c.mjs', strings: ['關聯', '重判關聯'] }], { ...USER, contractNames: ['關聯'] }), ['c.mjs〔他工作〕重判關聯'])
        })

        it('不含舊名、沿革指標、宿主之指令與他工作之名(逐行,含註解;題組檔之說明同判)', () => {
            const docs = [...files().map((f) => ({ file: f, text: readText(f) || '' })), ...caseDocs()]
            assert.ok(docs.length >= 70, `掃描量過少：${docs.length}`)
            assert.deepEqual(historyScanOf(docs, LINE), [])
        })

        it('面向使用者之字樣(原始碼之字串字面、README)不含宿主之指令、他工作之名與帳本代號', () => {
            const src = files().filter((f) => f.endsWith('.mjs')).map((f) => ({ file: f, strings: lexSource(readText(f) || '').strings }))
            assert.ok(src.reduce((n, d) => n + d.strings.length, 0) >= 3000, '字串字面過少(掃描空洞)')
            assert.deepEqual(userTextScanOf([...src, { file: 'README.md', strings: [readText('README.md') || ''] }], USER), [])
        })
    })

    // ═══════════════════════ ⑦ 下游筆記記錄之資料契約 ═══════════════════════
    describe('⑦ 下游筆記記錄之欄位只經單一宣告模組(core/stores/noteFields)讀取', () => {
        const DECL = 'src/core/stores/noteFields.mjs'
        // 筆記專有之欄位(docId、extractedAt、concepts)之屬性存取;createdAt、title 為多集合共有之欄名,以宣告模組之函數讀(領域發現之候選)
        const READ = /[\w\])?]\.(docId|extractedAt|concepts)\b/

        it('判準自檢:屬性存取被抓到,展開運算子與註解不誤判', () => {
            assert.ok(READ.test('n.docId') && READ.test('note?.extractedAt') && READ.test('list[0].concepts') && READ.test('(x).concepts'))
            assert.ok(!READ.test('...concepts.slice(0, half)') && !READ.test('const concepts = []'))
        })

        it('原始碼(不含測試;註解行除外)中,筆記欄位之屬性存取只在宣告模組', () => {
            assert.ok(sourceFiles().includes(DECL))
            const bad = []
            for (const f of sourceFiles().filter((x) => x.startsWith('src/') && x !== DECL)) {
                (readText(f) || '').split('\n').forEach((l, i) => {
                    if (/^\s*(\/\/|\*|\/\*)/.test(l)) return
                    if (READ.test(l)) bad.push(`${f}:${i + 1} ${l.trim().slice(0, 100)}`)
                })
            }
            assert.deepEqual(bad, [])
        })
    })
})
