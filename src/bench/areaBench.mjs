// areaBench.mjs — 領域發現 AI 之能力評分:角色化評分核心(bench/benchKit.mjs)之上之「領域發現」角色(areaBenchRole);
//   逐模型逐案以正式提示詞與輸出契約呼叫,逐案各回皆＝應然才計通過
//
// 【判準(檢定標準 CS8 之逐案判準)】每回之類別:covered(判既有領域已涵蓋)／new(判未涵蓋且 label、query 合 AREA_CONTRACT)／
//   new-invalid(判未涵蓋而不合契約)／無(呼叫失敗、未呼叫或回覆無可用之裁決)。逐案 runs 回之類別皆＝應然類別才計通過(各回因而一致);
//   一回不符即不通過——不以比率放行。另計輸出合契約率、平均耗時與呼叫失敗,只列資訊。
// 【與領域發現子階段同一提示詞與契約】一案一頁;提示詞＝domain.buildPrompt([候選], 既有領域);案給 input.vocab 時以之另建該案之 domain
//   (主題範圍句只在 vocab.domain 有給時出現),其餘案之詞彙可由 opt.vocab／命令列 --vocab 覆寫(安裝方之稱呼與主題範圍)。
//   席位 { use:受測模型, fallback:[] }——不遞補,量的是單一模型。check 只驗外層形狀(index 1 之項、covered 為布林):調度層取回覆中
//   最後一段過 check 者,只驗可解析會取到尾隨之小片段;契約之判定留在本層分類(子階段之 check 較嚴,不合者在生產中交遞補,此處要分出 new-invalid)。
// 【題組】{ std:'CS8', v:1, note, cases:[{ id, holdout, type?, input:{ candidate, areas, vocab? }, expect:{ covered }, why }] },與 CS8 題組同形
//   (type、input.vocab 為選填;題組有給之 std／v 須為 CS8／1);保留題(holdout)分列計分。
// 【共通機制在核心】題組之共通驗證、失敗不中斷、限流即停、連續失敗停測、併發、進度事件、受測名單、提示詞指紋、命令列與報表皆在
//   bench/benchKit.mjs(報表在 bench/report.mjs);本檔只定義角色,並以既有名稱(runAreaBench、writeAreaBenchReport…)轉為核心之呼叫——
//   回傳形狀與報表輸出不變。
// 【命令列】runAreaBenchCli 可程式呼叫;bench/cli.mjs 只是直接執行之薄殼。

import { fileURLToPath } from 'url'
import isobj from 'wsemi/src/isobj.mjs'
import isarr from 'wsemi/src/isarr.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import { createAreaDomain } from '../domain/areaDomain.mjs'
import { resolveVocab } from '../core/vocab/vocabDefault.mjs'
import { oneline } from '../core/runnerPackage.mjs'
import { textValueOf } from '../core/util/values.mjs'
import {
    defineBenchRole, runBench, validateBenchCases, loadBenchCases, parseBenchArgs, benchUsageOf, runBenchCli,
    benchModelsCsv, benchCasesCsv, benchMarkdown, writeBenchReport, mergeBenchBoard, BENCH_BOARD_HEADER, BENCH_FAIL_KINDS,
    typeName, inputVocabProblemsOf, domainNeedsOf,
} from './benchKit.mjs'

export { DEFAULT_FREE_MODELS, freeModelsOf } from './benchKit.mjs'

/**
 * 套件內建之通用題組檔(模組所在資料夾之檔案,以 fileURLToPath 解析)
 *
 * @type {String}
 */
export const AREA_CASES_FILE = fileURLToPath(new URL('./cases/area-generic.json', import.meta.url))

/**
 * 一回裁決之類別(與 CS8 題組執行之分類同義):應然 { covered:false } 無 valid 欄 → new;模型之未涵蓋須合契約(valid)才算 new
 *
 * @param {Object|null} v 輸入裁決 { covered, valid? }，或應然 { covered }；假值回 null
 * @returns {String|null} 回傳 'covered'／'new'／'new-invalid'，無裁決回 null
 * @example
 * console.log(areaClassOf({ covered: false, valid: false }), areaClassOf({ covered: false }), areaClassOf(null))
 * // => new-invalid new null
 */
export function areaClassOf(v) {
    return v ? (v.covered ? 'covered' : (v.valid === false ? 'new-invalid' : 'new')) : null
}

/**
 * 由 AI 回覆取本案之裁決:單一候選,取 index 1 之項(covered 須為布林);未涵蓋者以 domain.isValidItem 驗輸出契約
 *
 * @param {*} data 輸入回覆(已解析之 JSON)
 * @param {Object} domain 輸入領域發現 domain(取 isValidItem)
 * @returns {Object} 回傳 { verdict:{ covered, valid, label, query, why }|null, problem:String(無裁決之原因;有裁決為 '') }
 * @example
 * let d = createAreaDomain()
 * console.log(areaVerdictOf([{ index: 1, covered: true, why: '同義' }], d).verdict.covered, areaVerdictOf({}, d).problem)
 * // => true 回覆非 JSON 陣列（object）
 */
export function areaVerdictOf(data, domain) {
    if (!isarr(data)) return { verdict: null, problem: `回覆非 JSON 陣列（${typeName(data)}）` }
    const it = data.find((x) => x?.index === 1)
    if (!it) return { verdict: null, problem: data.length ? '回覆無 index 1 之項' : '回覆為空陣列' }
    if (typeof it.covered !== 'boolean') return { verdict: null, problem: `index 1 之 covered 非布林（${oneline(JSON.stringify(it.covered), 40)}）` }
    return { verdict: { covered: it.covered, valid: domain.isValidItem(it, 1) === true, label: textValueOf(it.label), query: textValueOf(it.query), why: textValueOf(it.why) }, problem: '' }
}

/**
 * 逐案之角色專屬檢核:候選、既有領域、案帶之詞彙(以詞彙表之規格驗)、應然(核心另驗 id、holdout、type、why)
 *
 * @param {Object} c 輸入案
 * @returns {Array} 回傳問題說明陣列(不含案之位置;核心加上)
 */
function areaCaseProblems(c) {
    const problems = []
    const inp = isobj(c.input) ? c.input : {}
    if (!isobj(inp.candidate) || !isestr(inp.candidate.label)) problems.push('缺 input.candidate.label')
    if (!isarr(inp.areas) || !inp.areas.every((a) => isobj(a) && isestr(a.label) && isestr(a.query))) problems.push('input.areas 須為 [{ label, query }]')
    problems.push(...inputVocabProblemsOf(c, resolveVocab))
    if (!isobj(c.expect) || typeof c.expect.covered !== 'boolean') problems.push('expect.covered 須為布林')
    return problems
}

/**
 * 每回紀錄之角色欄位(無裁決者為空值;鍵序即紀錄之欄序)
 *
 * @param {Object|null} v 輸入裁決(areaVerdictOf 之 verdict)
 * @returns {Object} 回傳 { covered, valid, label, query, why }
 */
const areaFieldsOf = (v) => ({ covered: v ? v.covered : null, valid: v ? v.valid : false, label: v ? v.label : '', query: v ? v.query : '', why: v ? v.why : '' })

/**
 * 領域發現之評分角色(benchKit 之 defineBenchRole 之產物;交 runBench、planBench、報表與命令列之共用函數)
 *
 * @type {Object}
 */
export const areaBenchRole = defineBenchRole({
    id: 'area',
    name: '領域發現(area)',
    title: '領域發現 AI 能力評分',
    runnerName: 'runAreaBench',
    std: 'CS8',
    v: 1,
    casesFile: AREA_CASES_FILE,
    caseProblems: areaCaseProblems,
    expectOf: (c) => areaClassOf(c.expect),
    caseFieldsOf: (c) => ({ kind: String(c.input.candidate.kind || ''), label: c.input.candidate.label }),
    domainOf: (vocab) => createAreaDomain({ vocab }),
    domainProblem: domainNeedsOf(['buildPrompt', 'isValidItem']),
    promptOf: (cases, domain) => domain.buildPrompt([cases[0].input.candidate], cases[0].input.areas),
    // 外層形狀(index 1 之項、covered 為布林——areaVerdictOf 所讀者);契約(label／query)不在此擋,留給本層分出 new-invalid
    check: (d) => (isarr(d) && d.some((x) => isobj(x) && x.index === 1 && typeof x.covered === 'boolean') ? true : `回覆無 index 1 且 covered 為布林之項（${typeName(d)}）`),
    verdictOf: (data, c, at) => {
        const { verdict, problem } = areaVerdictOf(data, at.domain)
        return { cls: areaClassOf(verdict), valid: verdict ? verdict.valid : false, problem, fields: areaFieldsOf(verdict) }
    },
    blankFields: areaFieldsOf(null),
    detailOf: (r) => (r.cls === 'new' || r.cls === 'new-invalid' ? `「${r.label}｜${r.query}」` : ''),
    mismatchNote: (r, expect) => (r.cls === 'new-invalid'
        ? `判未涵蓋但 label／query 不合輸出契約（「${r.label}｜${r.query}」）`
        : `判 ${r.cls}${r.cls === 'new' ? `「${r.label}｜${r.query}」` : ''}，應然 ${expect}${r.why ? `（理由：${oneline(r.why, 80)}）` : ''}`),
    report: {
        criteria: [
            '判準：逐案各回之類別皆＝應然才計通過（各回因而一致），不以比率放行；判未涵蓋者之 label／query 須合輸出契約，否則記 new-invalid',
            '合契約率：成功取得回覆之各回中，index 1 之項過輸出契約者之比率；平均耗時取成功之回',
        ],
        caseColumns: [{ name: '候選', key: 'label', md: true }, { name: '候選種類', key: 'kind' }],
        runColumns: [{ name: '標籤', key: 'label' }, { name: '查詢', key: 'query' }, { name: '理由', key: 'why' }],
    },
    cli: {
        command: 'node src/bench/cli.mjs',
        casesHelp: '題組檔(CS8 題組同形);未給＝套件內建之通用題組(src/bench/cases/area-generic.json)',
    },
})

/**
 * 驗題組並正規化:接受 { std, v, note, cases } 或案陣列;任一案不合即拋錯並列出全部問題
 *
 * @param {Object|Array} x 輸入題組物件或案陣列
 * @returns {Object} 回傳 { std, v, note, cases }；cases 各項 holdout 正規化為布林，其餘欄位原樣
 * @throws {Error} 題組形狀不合、無案、id 缺漏或重複、候選缺 label、既有領域形狀不合、input.vocab 不合詞彙表規格、
 *   expect.covered 非布林、缺 why，或題組有給之 std／v 非 CS8／1 時拋出
 * @example
 * let set = validateAreaCases([{ id: 'a', input: { candidate: { label: '甲' }, areas: [] }, expect: { covered: false }, why: '規則 3' }])
 * console.log(set.cases[0].holdout)
 * // => false
 */
export function validateAreaCases(x) {
    return validateBenchCases(areaBenchRole, x)
}

/**
 * 讀題組檔並驗之(相對路徑以當下 cwd 解析)
 *
 * @param {String} [file=AREA_CASES_FILE] 輸入題組 JSON 檔路徑，未給用套件內建之通用題組
 * @returns {Object} 回傳 validateAreaCases 之產物
 * @throws {Error} 檔案讀不到、非 JSON 或題組不合時拋出(訊息含檔案路徑)
 * @example
 * let set = loadAreaCases()
 * console.log(set.std, set.v, set.cases.length > 0)
 * // => CS8 1 true
 *
 * try { loadAreaCases('./no-such-cases.json') } catch (e) { console.log(e.message.startsWith('題組檔讀取失敗')) }
 * // => true
 */
export function loadAreaCases(file) {
    return loadBenchCases(areaBenchRole, file)
}

/** 呼叫失敗之類別說明(報表與未通過原因共用;與核心之 BENCH_FAIL_KINDS 同一物件) */
export const AREA_FAIL_KINDS = BENCH_FAIL_KINDS

/**
 * 領域發現 AI 之能力評分(判準見檔頭;併發、失敗與停測見 benchKit 檔頭)
 *
 * @param {Object} opt 輸入設定物件
 * @param {Array} opt.models 輸入受測模型(調度層條目 id)陣列，如 DEFAULT_FREE_MODELS；重複者去除
 * @param {Object|Array} [opt.cases] 輸入題組(validateAreaCases 所收形狀)，未給用套件內建之通用題組
 * @param {Integer} [opt.runs=2] 輸入每案呼叫回數
 * @param {Function} [opt.adapterOf] 輸入 (modelId) => 調度層(具 callJson)；與 aiAdapter 擇一，兩者皆給以 adapterOf 為準
 * @param {Object} [opt.aiAdapter] 輸入共用之調度層(core/ai/adapter 之 createAiAdapter 產物或相容者)
 * @param {Object} [opt.vocab] 輸入詞彙覆寫(未帶 input.vocab 之案以 domainOf(vocab) 建 domain;命令列 --vocab)；與 domain 擇一
 * @param {Object} [opt.domain] 輸入領域發現 domain(具 buildPrompt、isValidItem)，未給用 createAreaDomain() 之內建預設(或依 vocab 建)
 * @param {Function} [opt.domainOf] 輸入 (vocab) => domain，案帶 input.vocab 時與 opt.vocab 用；未給用 createAreaDomain({ vocab })
 *   (覆寫提示詞者須一併給 domain 或 vocab,否則未帶 vocab 之案仍用內建提示詞)
 * @param {Integer} [opt.timeoutMs] 輸入單回逾時毫秒數(寫入席位 timeoutMs,覆寫條目之逾時)，未給沿用調度層之設定
 * @param {Integer} [opt.concurrency=2] 輸入同時受測之模型數上限
 * @param {Integer} [opt.stopAfterFails=2] 輸入同一模型連續幾回服務面失敗(逾時、執行錯誤、略過)即停測
 * @param {Function} [opt.onProgress] 輸入進度回呼 (ev) => void；ev.type 為 'start'(帶 meta)、'call'(帶 model、caseId、record)、
 *   'model-stopped'(帶 model、reason)、'model-done'(帶 model、summary)；回呼拋錯不影響評分
 * @param {Object} [opt.clock] 輸入時鐘(wsemi 之 genClockTZ 產物)，未給依 timeZone 建立
 * @param {String} [opt.timeZone='Asia/Taipei'] 輸入 IANA 時區(評比時間與報表檔名之時間戳)
 * @returns {Promise} 回傳 Promise，resolve 回傳 { meta, models }：
 *   meta＝{ std, v, note, cases(案數), holdout(保留案數), runs, models, promptFp(實際送出之提示詞之指紋), startedAt, endedAt, stamp,
 *     timeoutMs, concurrency, stopAfterFails }；
 *   models[]＝{ model, stopped(停測原因,未停為 ''), score:{ pass, total, rate }, general, holdout(同形), contract:{ valid, total, rate }
 *     (成功取得回覆之各回中合輸出契約者), calls:{ sent, ok, failed, notRun, byKind }, avgMs(成功之回), avgMsAll(送出之回), cases[] }；
 *   cases[]＝{ id, holdout, type, kind, label(候選), expect(應然類別), why(應然依據), runs[], pass, consistent, note(未通過原因) }；
 *   runs[]＝{ run, notRun, ms, providerId, cls, callFail, failKind, error, reply, covered, valid, label, query, why, problem }
 * @throws {Error} models 為空、題組不合、runs／timeoutMs／concurrency／stopAfterFails 不合、未給調度層、domain 或 vocab 不合、
 *   或題組之案無法組提示詞時拋出(皆在任何呼叫之前)
 * @example
 * need test in nodejs.
 *
 * let ai = createAiAdapter({ ai: resolveSettings({}).ai, workspace: './bench-out/ai-workspace' })
 * let r = await runAreaBench({ models: ['oc:opencode/mimo-v2.6-flash-free'], aiAdapter: ai })
 * console.log(r.models[0].score)
 */
export async function runAreaBench(opt = {}) {
    return runBench(areaBenchRole, opt)
}

/**
 * 逐模型分數之 CSV(一模型一列;含 BOM)
 *
 * @param {Object} result 輸入 runAreaBench 之結果
 * @returns {String} 回傳 CSV 字串
 * @throws {Error} result 形狀不合時拋出
 * @example
 * // 以替身調度層(不呼叫真實 AI)產生一份結果
 * let ai = { callJson: async () => ({ ok: true, data: [{ index: 1, covered: true, why: '既有領域已涵蓋' }], error: '', providerId: 'stub', attempts: 1, skipped: false, errors: [] }) }
 * let cases = [{ id: 'a1', input: { candidate: { label: '快速排序' }, areas: [{ label: '排序演算法', query: 'sorting algorithms' }] }, expect: { covered: true }, why: '下位概念' }]
 * let result = await runAreaBench({ models: ['m1'], cases, runs: 1, aiAdapter: ai })
 * console.log(areaBenchModelsCsv(result).split('\n')[1].split(',').slice(0, 4))
 * // => [ 'm1', '1', '1', '100.0%' ]
 */
export function areaBenchModelsCsv(result) {
    return benchModelsCsv(result, areaBenchRole)
}

/**
 * 逐案明細之 CSV(一模型一案一列;各回之類別、標籤、查詢、理由、合契約、耗時、錯誤並排;含 BOM)
 *
 * @param {Object} result 輸入 runAreaBench 之結果
 * @returns {String} 回傳 CSV 字串
 * @throws {Error} result 形狀不合時拋出
 * @example
 * // 以替身調度層(不呼叫真實 AI)產生一份結果
 * let ai = { callJson: async () => ({ ok: true, data: [{ index: 1, covered: true, why: '既有領域已涵蓋' }], error: '', providerId: 'stub', attempts: 1, skipped: false, errors: [] }) }
 * let cases = [{ id: 'a1', input: { candidate: { label: '快速排序' }, areas: [{ label: '排序演算法', query: 'sorting algorithms' }] }, expect: { covered: true }, why: '下位概念' }]
 * let result = await runAreaBench({ models: ['m1'], cases, runs: 1, aiAdapter: ai })
 * let row = areaBenchCasesCsv(result).split('\n')[1].split(',')
 * console.log(row[0], row[1], row[6], row[7])
 * // => m1 a1 covered covered
 */
export function areaBenchCasesCsv(result) {
    return benchCasesCsv(result, areaBenchRole)
}

/**
 * Markdown 報表(逐模型分數表＋逐案明細＋未通過原因)
 *
 * @param {Object} result 輸入 runAreaBench 之結果
 * @returns {String} 回傳 Markdown 字串
 * @throws {Error} result 形狀不合時拋出
 * @example
 * // 以替身調度層(不呼叫真實 AI)產生一份結果
 * let ai = { callJson: async () => ({ ok: true, data: [{ index: 1, covered: true, why: '既有領域已涵蓋' }], error: '', providerId: 'stub', attempts: 1, skipped: false, errors: [] }) }
 * let cases = [{ id: 'a1', input: { candidate: { label: '快速排序' }, areas: [{ label: '排序演算法', query: 'sorting algorithms' }] }, expect: { covered: true }, why: '下位概念' }]
 * let result = await runAreaBench({ models: ['m1'], cases, runs: 1, aiAdapter: ai })
 * let md = areaBenchMarkdown(result)
 * console.log(md.split('\n')[0], md.includes('（全數通過）'))
 * // => # 領域發現 AI 能力評分 true
 */
export function areaBenchMarkdown(result) {
    return benchMarkdown(result, areaBenchRole)
}

/**
 * 報表落檔:逐模型 CSV、逐案 CSV、Markdown 與原始結果 JSON;寫後回驗檔案存在
 *
 * @param {Object} result 輸入 runAreaBench 之結果
 * @param {String} outDir 輸入輸出目錄(相對路徑以當下 cwd 解析;不存在即建立)
 * @param {Object} [opt={}] 輸入設定物件
 * @param {String} [opt.name] 輸入檔名主幹，未給為 area-bench-<結果之時間戳>
 * @returns {Object} 回傳 { dir, files:{ modelsCsv, casesCsv, md, json } }(皆為絕對路徑)
 * @throws {Error} result 形狀不合、outDir 非字串，或寫入後檔案不存在時拋出
 * @example
 * // 以替身調度層(不呼叫真實 AI)產生一份結果
 * let ai = { callJson: async () => ({ ok: true, data: [{ index: 1, covered: true, why: '既有領域已涵蓋' }], error: '', providerId: 'stub', attempts: 1, skipped: false, errors: [] }) }
 * let cases = [{ id: 'a1', input: { candidate: { label: '快速排序' }, areas: [{ label: '排序演算法', query: 'sorting algorithms' }] }, expect: { covered: true }, why: '下位概念' }]
 * let result = await runAreaBench({ models: ['m1'], cases, runs: 1, aiAdapter: ai })
 * let r = writeAreaBenchReport(result, './bench-out', { name: 'demo' })
 * console.log(Object.keys(r.files), r.files.md.endsWith('demo.md'))
 * // => [ 'modelsCsv', 'casesCsv', 'md', 'json' ] true
 */
export function writeAreaBenchReport(result, outDir, opt = {}) {
    return writeBenchReport(result, outDir, { ...(isobj(opt) ? opt : {}), role: areaBenchRole })
}

/**
 * 評比表:本次結果併入累積之評比表(一角色一模型一列;同角色同模型以本次覆蓋,其餘保留;停測或未完整者不寫)
 *
 * @param {String} file 輸入評比表路徑(相對路徑以當下 cwd 解析;不存在即新建)
 * @param {Object} result 輸入 runAreaBench 之結果
 * @param {Object} [opt={}] 輸入設定物件
 * @param {String} [opt.workspace=''] 輸入本次 CLI 子行程之工作目錄(記入「AI 工作目錄」欄;注入之調度層不知時給空字串)
 * @returns {Object} 回傳 { file(絕對路徑), written:Array(寫入之模型), replaced:Array(覆蓋舊列之模型), skipped:Array({ model, reason }), rows:Integer(表內總列數) }
 * @throws {Error} result 形狀不合、file 非字串、既有檔之表頭與本版不同,或寫入後檔案不存在時拋出
 * @example
 * need test in nodejs.
 *
 * let r = mergeAreaBenchBoard('./模型評比.csv', result, { workspace: './bench-out/ai-workspace' })
 * console.log(r.written, r.skipped)
 */
export function mergeAreaBenchBoard(file, result, opt = {}) {
    return mergeBenchBoard(file, result, { ...(isobj(opt) ? opt : {}), role: areaBenchRole })
}

/** 評比表之角色名(本評分量的是領域發現;＝areaBenchRole.name) */
export const AREA_BENCH_ROLE = areaBenchRole.name

/** 評比表之表頭(與核心之 BENCH_BOARD_HEADER 同一物件;各角色同一表頭) */
export const AREA_BENCH_BOARD_HEADER = BENCH_BOARD_HEADER

// ════════════════ 命令列(node src/bench/cli.mjs …;亦可程式呼叫 runAreaBenchCli) ════════════════

/** 命令列用法說明 */
export const AREA_BENCH_USAGE = benchUsageOf(areaBenchRole)

/**
 * 解析命令列參數(不認得之選項、缺值、重複、值不合一律拋錯——打錯之選項若靜默略過,跑出來的是另一份設定之評分)
 *
 * @param {Array} argv 輸入參數陣列(不含 node 與腳本路徑)；支援「--鍵 值」與「--鍵=值」
 * @returns {Object} 回傳 { help, models:Array, cases:String(絕對路徑;空字串＝內建題組), runs, out(絕對路徑), env:String(絕對路徑;空字串＝未給),
 *   timeoutMs:Integer|null, concurrency, timeZone:String(預設 'Asia/Taipei'), board:String(絕對路徑;空字串＝不寫評比表),
 *   vocab:String(詞彙檔絕對路徑;空字串＝未給) }
 * @throws {Error} 選項不認得、缺值、重複或值不合時拋出
 * @example
 * console.log(parseAreaBenchArgs(['--models', 'a,b', '--runs', '3']).models)
 * // => [ 'a', 'b' ]
 */
export function parseAreaBenchArgs(argv) {
    return parseBenchArgs(argv, areaBenchRole)
}

/**
 * 命令列主流程:解析參數 → 讀題組(與 --vocab 詞彙檔) → 建調度層(內建,金鑰見 --env) → runAreaBench(每回結果一完成即附寫逐回進度檔) → 寫報表 →
 * (--board)併入評比表。逐回進度檔 <out>/area-bench-<時間戳>.progress.jsonl:中途被終止也留得下已跑之結果;AI 子行程工作目錄 <out>/ai-workspace 結束後移除
 *
 * @param {Array} argv 輸入參數陣列(不含 node 與腳本路徑;選項見 AREA_BENCH_USAGE)
 * @param {Object} [inject={}] 輸入注入物件
 * @param {Object} [inject.aiAdapter] 輸入調度層，給了即不建內建調度層(亦不建 AI 工作目錄)
 * @param {Object} [inject.log] 輸入輸出物件 { info(msg), error(msg) }，預設 console
 * @returns {Promise} 回傳 Promise，resolve 回傳 { result, report:{ dir, files }, progressFile, board(未給 --board 為 null;否則 mergeAreaBenchBoard 之回傳) }；--help 時回 { help:true }
 * @throws {Error} 參數不合、題組不合、--vocab 詞彙檔不存在或不合、--env 指定之金鑰檔不存在，或評分前之檢核失敗時拋出
 * @example
 * need test in nodejs.
 *
 * let r = await runAreaBenchCli(['--models', 'oc:opencode/mimo-v2.6-flash-free', '--runs', '2', '--out', './bench-out'])
 * console.log(r.report.files.md)
 */
export async function runAreaBenchCli(argv, inject = {}) {
    return runBenchCli(areaBenchRole, argv, inject)
}

export default runAreaBench
