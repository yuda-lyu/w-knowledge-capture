// benchKit.mjs — AI 能力評分之角色化核心:各角色(領域發現;下游之預篩、摘要、修補、忠實性、重標…)以 defineBenchRole 定義,
//   共用同一個執行器(runBench)、逐案判準、失敗歸類與停測、併發、進度事件、受測名單、提示詞指紋、命令列與報表——不各寫一份評分器
//
// 【角色只描述題目與判類別】角色定義(defineBenchRole 之 JSDoc)給:題組之驗證、分頁、以 domain 組提示詞、由回覆判每案之類別與是否合契約;
//   怎麼呼叫、怎麼判通過、怎麼停測、怎麼出報表一律在本檔與 report.mjs。
// 【判準(逐案)】每回之類別由角色之 verdictOf 由 AI 回覆與該案算出(null＝無裁決:呼叫失敗、未呼叫或回覆無可用之裁決);
//   逐案 runs 回之類別皆＝應然(expectOf)才計通過(各回因而一致),一回不符即不通過——不以比率放行。另計輸出合契約率、平均耗時與
//   呼叫失敗,只列資訊。
// 【分頁】一次呼叫含一頁之案(預設一案一頁;角色以 pageSize 或 paginate 定):同頁之案共用一份提示詞與一次回覆,由 verdictOf 依頁內序號
//   取該案之項;呼叫失敗及於整頁各案。同頁之案須同一份詞彙(同一個 domain):內建分頁遇詞彙不同即換頁(不改案序),自訂分頁混用即拋。
// 【提示詞與正式管線同源】提示詞＝角色之 promptOf(該頁之案, domain);domain 由角色之 domainOf(詞彙) 建——角色須以正式管線之 domain 建構
//   函數為之。案自帶詞彙者(角色之 vocabOf,預設 input.vocab)以之另建該案之 domain;opt.vocab(命令列 --vocab)為其餘案之詞彙覆寫,
//   讓安裝方以自己的詞彙與正式提示詞跑自己的題組。席位 { use:受測模型, fallback:[] }——不遞補,量的是單一模型。
//   交調度層之 check 只驗可解析／形狀(預設只要求可解析為 JSON):契約之判定留在 verdictOf(生產之 check 較嚴、不合者交遞補;
//   此處要把不合契約者分出來計分)。
// 【自訂呼叫(角色之 call,選用)】預設一頁一次 callJson;正式管線不經 callJson 者(如多棒工作流經調度層之工作流入口 getWkf().callAi,
//   以各棒自己之解析器與 check)以 call(adapter, prompt, { spec, check, callOpt, onEvent }) 自行呼叫——呼叫與解析才與正式管線同一路徑。
//   其回傳須為 callJson 結果之形狀({ ok, data, error, providerId, attempts, skipped, errors });其後之判類別、事件、計時、拋錯包成失敗與預設同一套。
//   給了 call 之角色只要求調度層為物件(用哪些函數由 call 決定);命令列之內建調度層另開工作流入口(workflow:true),未給 call 者照舊。
// 【題組】{ std, v, note, cases:[{ id, holdout?, type?, input, expect, why }] }(或案陣列):共通欄位由本檔驗,input／expect 由角色之
//   caseProblems 驗;角色宣告 std／v 者,題組有給之 std／v 須相符。題組於任何呼叫之前驗完,不合即拋並列出全部問題(不燒額度跑一份
//   壞題組);分頁與提示詞亦於任何呼叫之前組完(組不出即拋)。保留題(holdout)分列計分。
// 【失敗不中斷】呼叫失敗(逾時、額度用盡、執行錯誤、回覆非 JSON 或不合 check)記為該頁各案該回不通過並註明原因,續跑其餘;調度層拋錯、
//   角色之 verdictOf 拋錯亦同(置換之調度層未必守「不拋錯」之契約;判定拋錯記為無裁決)。
// 【限流即停(逐模型)】判為額度用盡或限流(調度層之冷卻事件而非逾時所致,或錯誤訊息命中調度層之 LIMIT_TEXT_RE)即停測該模型;
//   連續 stopAfterFails 次服務面失敗(逾時、執行錯誤、略過)亦停——opencode 免費層限流時 CLI 不結束、以逾時回報,不停則每次空耗
//   一次完整逾時。回覆非 JSON(reply)是模型產出之問題,不計入連續失敗。停測後之各回記未呼叫與原因,其他模型照跑。
// 【併發】模型間有限併發(預設 2);同一模型內依「第 1 回全部頁 → 第 2 回 …」序列呼叫,同一模型不同時佔兩個請求。
// 【計數之單位】通過、一般／保留:案;合契約:取得回覆之案次(每案每回);送出呼叫、呼叫失敗、未呼叫、平均耗時:呼叫(頁)——一案一頁時兩者相同。
// 【報表】CSV／Markdown／JSON 與評比表在 report.mjs(只讀結果物件與角色定義),經本檔轉出——角色作者只需 import 本檔。
// 【命令列】runBenchCli(角色, argv) 為共用主流程(參數嚴格解析、逐回進度檔、報表、評比表);角色可擴充參數(cli.options),解析值交 opt.roleOpt。

import fs from 'fs'
import path from 'path'
import isobj from 'wsemi/src/isobj.mjs'
import isarr from 'wsemi/src/isarr.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import providersAll from 'w-dispatch-ai/src/providers.mjs'
import { createAiAdapter, LIMIT_TEXT_RE } from '../core/ai/adapter.mjs'
import { resolveSettings } from '../core/settingsDefault.mjs'
import { genClockTZ, oneline } from '../core/runnerPackage.mjs'
import { sha1 } from '../core/util/text.mjs'
import { unknownKeysProblem } from '../core/util/values.mjs'
import { appendJsonlRow } from '../core/util/jsonl.mjs'
import { writeBenchReport, mergeBenchBoard } from './report.mjs'

export { benchModelsCsv, benchCasesCsv, benchMarkdown, writeBenchReport, mergeBenchBoard, boardWorkspaceOf, BENCH_BOARD_HEADER, BENCH_FAIL_COLUMNS } from './report.mjs'

// ════════════════ 受測名單 ════════════════

/**
 * 依定價為免費、但 id 與 model 皆不帶 free 字樣之條目(w-dispatch-ai providers.mjs 該條目註解:官方定價表列為免費)
 *
 * @type {Array}
 */
const FREE_BY_PRICING = ['oc:opencode/big-pickle']

/**
 * 非文字生成之條目種類:決策模型須給 questions、回型別化答案,不產生文字回覆,無法擔任文字生成之角色
 *
 * @type {Array}
 */
const NON_TEXT_KINDS = ['api-typesafe-systemone']

/**
 * 預設受測名單:w-dispatch-ai 內建目錄(src/providers.mjs)之免費文字生成條目;受測順序為預設領域發現席位之首選(capture.discover.ai 之 use)在前,其餘依目錄順序
 *
 * 判準(與 freeModelsOf 同一判準):條目 id 或 model 含「free」(免費模型之命名慣例),另加 oc:opencode/big-pickle(定價為免費而命名不帶 free);
 * 排除非文字生成之決策模型(kind 'api-typesafe-systemone')。目錄隨模型輪替增刪,升級 w-dispatch-ai 後須以 freeModelsOf 比對本清單
 * (單元測試據此抓漂移;本清單對照 w-dispatch-ai 1.0.62 之目錄)。zen: 開頭之條目走 REST 並宣告金鑰變數,未給金鑰時調度層判為不可用
 * (該模型各回記未呼叫;目錄目前無 zen: 之免費文字生成條目)。
 * 可覆寫:runBench 之 models、命令列之 --models;角色另有其席位順序者以角色定義之 models 給
 *
 * @type {Array}
 */
export const DEFAULT_FREE_MODELS = Object.freeze([
    'oc:opencode/mimo-v2.6-flash-free',
    'oc:opencode/big-pickle',
    'oc:opencode/beam-free',
    'oc:opencode/deepseek-v4.1-flash-free',
    'oc:opencode/glm-5.3-flash-free',
    'oc:opencode/flint-40b-free',
    'oc:opencode/nemotron-3.5-lightning-free',
    'oc:opencode/nemotron-3.5-super-vl-free',
])

/**
 * 依判準(見 DEFAULT_FREE_MODELS)自供應商目錄推得免費文字生成條目之 id
 *
 * @param {Array} [catalogue] 輸入供應商目錄陣列，非陣列時用 w-dispatch-ai 內建目錄
 * @returns {Array} 回傳條目 id 陣列(依目錄順序)
 * @example
 * console.log(freeModelsOf([{ id: 'oc:x-free', kind: 'opencode' }, { id: 'zen:jev-free', kind: 'api-typesafe-systemone' }, { id: 'claude:sonnet', kind: 'claude' }]))
 * // => [ 'oc:x-free' ]
 */
export function freeModelsOf(catalogue) {
    const list = isarr(catalogue) ? catalogue : providersAll
    return list
        .filter((p) => isobj(p) && isestr(p.id) && !NON_TEXT_KINDS.includes(p.kind))
        .filter((p) => /free/i.test(p.id) || /free/i.test(String(p.model || '')) || FREE_BY_PRICING.includes(p.id))
        .map((p) => p.id)
}

// ════════════════ 角色定義 ════════════════

/** 命令列之共用選項名 → 結果鍵(角色擴充之選項不得與之重名) */
const BASE_CLI_OPTS = Object.freeze({ '--models': 'models', '--cases': 'cases', '--runs': 'runs', '--out': 'out', '--env': 'env', '--timeout': 'timeoutMs', '--concurrency': 'concurrency', '--tz': 'timeZone', '--board': 'board', '--vocab': 'vocab' })

/** 命令列解析結果之共用鍵(角色擴充之選項之 key 不得與之重名) */
const BASE_CLI_KEYS = Object.freeze(['help', ...Object.values(BASE_CLI_OPTS)])

/** 角色定義之可用鍵(不認得之鍵拋錯:打錯之鍵若靜默略過,該掛點即維持預設而無人察覺) */
const ROLE_KEYS = Object.freeze(['id', 'name', 'title', 'runnerName', 'std', 'v', 'casesFile', 'models',
    'suiteProblems', 'caseProblems', 'expectOf', 'caseFieldsOf', 'vocabOf', 'domainOf', 'domainProblem',
    'pageSize', 'paginate', 'promptOf', 'check', 'callOpt', 'call', 'verdictOf', 'blankFields', 'detailOf', 'mismatchNote', 'report', 'cli'])

/** 角色之逐次呼叫選項不得含之鍵(由核心給:席位與事件) */
const CALL_OPT_RESERVED = Object.freeze(['spec', 'onEvent'])

/** 角色定義之必給鍵(皆為函數) */
const ROLE_REQUIRED_FNS = Object.freeze(['expectOf', 'domainOf', 'promptOf', 'verdictOf'])

/** 角色定義之選給函數鍵 */
const ROLE_OPTIONAL_FNS = Object.freeze(['suiteProblems', 'caseProblems', 'caseFieldsOf', 'vocabOf', 'domainProblem', 'paginate', 'check', 'call', 'detailOf', 'mismatchNote'])

/** 每回紀錄之共通欄位(角色欄位不得同名:同名會蓋掉共通欄位) */
const RUN_RESERVED = Object.freeze(['run', 'notRun', 'ms', 'providerId', 'cls', 'callFail', 'failKind', 'error', 'reply', 'problem'])

/** 案結果之共通欄位(角色之案欄位不得同名) */
const CASE_RESERVED = Object.freeze(['id', 'holdout', 'type', 'expect', 'why', 'runs', 'pass', 'consistent', 'note'])

/** 角色 id 之形式(報表檔名主幹 <id>-bench-<時間戳>) */
const ROLE_ID_RE = /^[a-z][a-z0-9-]*$/

/** 角色擴充之命令列選項之形式 */
const CLI_FLAG_RE = /^--[a-z][a-z0-9-]*$/
const CLI_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Markdown 判準說明之預設(角色未給 report.criteria 時) */
const DEFAULT_CRITERIA = Object.freeze([
    '判準：逐案各回之類別皆＝應然才計通過（各回因而一致），不以比率放行',
    '合契約率：成功取得回覆之各回中，該案之項合輸出契約者之比率；平均耗時取成功之呼叫',
])

/** defineBenchRole 之產物(再交 defineBenchRole 即原樣回傳) */
const DEFINED = new WeakSet()

/**
 * 定義一個評分角色:驗定義之形狀並補預設,回傳凍結之角色物件(交 runBench、planBench、報表與命令列)。冪等:已定義之角色原樣回傳
 *
 * 角色只描述「題目長什麼樣、怎麼組提示詞、怎麼由回覆判類別」;呼叫、判通過、停測、報表在核心(見檔頭)。
 * 函數掛點之引數:c 為題組之案(holdout 已正規化為布林);ctx 為 { roleOpt }(runBench 之 opt.roleOpt,命令列由 cli.options 解析)——promptOf 與
 * check 之 ctx 另帶 base(該頁首案之項編號減一:項編號於一次評分內依分頁之序跨頁連續、1 起),check 之 ctx 另帶 domain(該頁之 domain);
 * at 為 { index(該案於頁內之序號,1 起), seq(該案之項編號,跨頁連續、1 起), base(該頁首案之項編號減一;同 promptOf 之 ctx.base), domain(該頁之 domain),
 * cases(同頁之案), roleOpt }。
 * 掛點於準備期(任何呼叫之前)拋錯即中止評分;verdictOf 於呼叫後拋錯則記為該案該回無裁決(不中斷)。
 *
 * @param {Object} def 輸入角色定義
 * @param {String} def.id 輸入角色 id:小寫英文字母開頭之英數與連字號(報表檔名主幹 <id>-bench-<時間戳>、進度檔名)，如 'area'
 * @param {String} def.name 輸入角色顯示名(評比表之「角色」欄;同名之列視為同一角色)，如 '領域發現(area)'
 * @param {String} [def.title] 輸入報表與命令列之標題，未給為「<name> AI 能力評分」
 * @param {String} [def.runnerName='runBench'] 輸入錯誤訊息中之執行器名(角色另包具名執行器時給之，如 'runAreaBench')
 * @param {String|Array} [def.std] 輸入本角色量測之檢定標準 id(或其陣列)；給了即要求題組有給之 std 為其一
 * @param {Integer} [def.v] 輸入本角色所讀之題組版本；給了即要求題組有給之 v 與之相同(題組格式隨版本而變)
 * @param {String} [def.casesFile] 輸入內建題組檔路徑(未給 cases／--cases 時用之)；未給＝無內建題組(須給題組)
 * @param {Array} [def.models=DEFAULT_FREE_MODELS] 輸入命令列之預設受測名單(--models 未給或 free)
 * @param {Function} [def.suiteProblems] 輸入題組層之角色專屬檢核 (set) => Array<String>(問題說明;空陣列＝合格)
 * @param {Function} [def.caseProblems] 輸入逐案之角色專屬檢核 (c) => Array<String>(驗 input 與 expect;核心另驗 id、holdout、type、why，
 *   說明不必帶案之位置，核心會加上「cases[i](id)」)
 * @param {Function} def.expectOf 輸入應然類別 (c) => String(非空字串;與 verdictOf 之 cls 同一組類別)
 * @param {Function} [def.caseFieldsOf] 輸入案結果之角色欄位 (c) => Object(依序置於案結果之 type 與 expect 之間，供報表之 caseColumns)
 * @param {Function} [def.vocabOf] 輸入案自帶之詞彙 (c) => Object|undefined，未給取 c.input.vocab；為物件者以 domainOf 另建該案之 domain
 * @param {Function} def.domainOf 輸入以詞彙建 domain (vocab|null) => domain(null＝預設詞彙)；須為正式管線之 domain 建構函數，提示詞才與正式管線同源。
 *   詞彙不合時拋錯(命令列 --vocab 以之驗詞彙檔)
 * @param {Function} [def.domainProblem] 輸入 domain 之形狀檢核 (d) => String(問題說明;空字串＝合格)，未給只要求為物件
 * @param {Integer} [def.pageSize=1] 輸入一頁(一次呼叫)幾案：依題組順序每 pageSize 案一頁(遇詞彙不同即換頁)；與 paginate 擇一
 * @param {Function} [def.paginate] 輸入自訂分頁 (cases, ctx) => Array<Array<案或案 id>>(如依字數打包、同焦點一頁)；每案恰列一次、頁非空、
 *   同頁之案須同一份詞彙，否則拋錯；與 pageSize 擇一
 * @param {Function} def.promptOf 輸入一頁之提示詞 (cases, domain, ctx) => String(非空;須以 domain 之提示詞函數組，與正式管線同源;ctx.base 為該頁之項編號基數)
 * @param {Function} [def.check] 輸入交調度層之 check (data, cases, ctx) => true|String(驗 verdictOf 所讀之外層形狀;不合即該頁呼叫失敗，記 reply;ctx 帶 domain、base)，
 *   未給只要求可解析為 JSON——調度層取回覆中最後一段過 check 者(core/ai/jsonReply),未給 check 會取到尾隨說明之小片段,宜給(內建角色皆給)
 * @param {Object} [def.callOpt={}] 輸入逐次呼叫選項(併入調度層 callJson 之第三參數;如正式管線對陣列輸出之呼叫逐次給 { acceptTruncated:true }——
 *   評分須與正式呼叫同一組選項,截斷之回覆才與正式同樣部分接受);不得含 spec、onEvent(由核心給);給了 call 時原樣交 call(ctx.callOpt)
 * @param {Function} [def.call] 輸入自訂呼叫 async (adapter, prompt, ctx:{ spec, check, callOpt, onEvent }) => callJson 結果之形狀
 *   ({ ok, data, error, providerId, attempts, skipped, errors })；未給即 adapter.callJson(prompt, check, { ...callOpt, spec, onEvent })。
 *   ctx.check 為本頁之 check(已帶入該頁之案)、ctx.onEvent 收調度事件(失敗歸類讀之);拋錯同調度層拋錯(記為該頁呼叫失敗)。見檔頭【自訂呼叫】
 * @param {Function} def.verdictOf 輸入逐案類別 (data, c, at) => { cls:String|null, valid:Boolean, problem:String, fields:Object }：
 *   由該頁回覆(已解析之 JSON)與該案算出類別(null＝無裁決，problem 寫原因)與是否合輸出契約(valid);fields 為記入每回紀錄之角色欄位
 * @param {Object} [def.blankFields={}] 輸入無回覆(呼叫失敗、未呼叫)時之角色欄位(鍵序即紀錄之欄序;含 valid 鍵者 valid 依其位置)
 * @param {Function} [def.detailOf] 輸入一回之補充顯示 (rec) => String(報表之各回儲存格與命令列之逐回行，接在類別之後)，未給為空字串
 * @param {Function} [def.mismatchNote] 輸入類別不符應然時之未通過原因 (rec, expect) => String(接在「第 n 回」之後)，未給為「判 <類別><補充>，應然 <應然>」
 * @param {Object} [def.report] 輸入報表設定 { criteria:Array<String>(Markdown 之判準說明行)，caseColumns:Array<{ name, key, md? }>(逐案 CSV 之案欄，
 *   取案結果之 key;md 為 true 者亦列於 Markdown 逐案表)，runColumns:Array<{ name, key }>(逐案 CSV 之每回欄，取每回紀錄之 key) }
 * @param {Object} [def.cli] 輸入命令列設定 { command(用法首句之指令，預設 'node bench/cli.mjs')，casesHelp(--cases 之說明)，
 *   options:Array<{ flag:'--xxx', key, arg?, help?, parse?(值字串, flag) => 值 }>(角色擴充之參數;解析值以 key 交 opt.roleOpt;parse 不合即拋) }
 * @returns {Object} 回傳凍結之角色物件(上列各鍵皆已補預設;std 為陣列、v 無則 null、casesFile 無則空字串、paginate 與 call 無則 null)
 * @throws {Error} 非物件、含不認得之鍵、缺必給之函數、id／name 形式不合、pageSize 與 paginate 並給、blankFields 含共通欄位名、
 *   report／cli 之形狀不合，或擴充之命令列選項與共用選項重名時拋出(列出全部問題)
 * @example
 * let role = defineBenchRole({
 *     id: 'topic',
 *     name: '題目分類(topic)',
 *     pageSize: 2,
 *     expectOf: (c) => c.expect.label,
 *     domainOf: (vocab) => ({ kb: vocab?.kbLabel || '知識庫' }),
 *     promptOf: (cases, d) => `${d.kb}：${cases.map((c, i) => `${i + 1}. ${c.input.text}`).join('；')}`,
 *     verdictOf: (data, c, at) => {
 *         let it = Array.isArray(data) ? data.find((x) => x?.index === at.index) : null
 *         return it ? { cls: it.label, valid: true, problem: '', fields: { label: it.label } } : { cls: null, valid: false, problem: '無此項', fields: { label: '' } }
 *     },
 *     blankFields: { label: '' },
 * })
 * console.log(role.pageSize, role.runnerName, Object.isFrozen(role))
 * // => 2 runBench true
 */
export function defineBenchRole(def) {

    //check
    if (DEFINED.has(def)) {
        return def
    }
    if (!isobj(def)) {
        throw new Error('defineBenchRole 需要角色定義物件')
    }

    const problems = []
    // 不認得之鍵之訊息取 core/util/values 之 unknownKeysProblem(各處同一格式;以下 report、cli 之子鍵同)
    const unknown = unknownKeysProblem(def, ROLE_KEYS)
    if (unknown) problems.push(unknown)
    const given = (k) => def[k] !== undefined && def[k] !== null
    if (!isestr(def.id) || !ROLE_ID_RE.test(def.id)) problems.push('id 須為小寫英文字母開頭之英數與連字號（報表檔名主幹）')
    if (!isestr(def.name) || !def.name.trim()) problems.push('name 須為非空字串（評比表之「角色」欄）')
    if (given('title') && (!isestr(def.title) || !def.title.trim())) problems.push('title 須為非空字串')
    if (given('runnerName') && (!isestr(def.runnerName) || !def.runnerName.trim())) problems.push('runnerName 須為非空字串')
    for (const k of ROLE_REQUIRED_FNS) if (!isfun(def[k])) problems.push(given(k) ? `${k} 須為函數` : `缺 ${k}（函數）`)
    for (const k of ROLE_OPTIONAL_FNS) if (given(k) && !isfun(def[k])) problems.push(`${k} 須為函數`)

    // 標準與題組版本
    let std = []
    if (given('std')) {
        if (isestr(def.std)) std = [def.std]
        else if (isarr(def.std) && def.std.length && def.std.every(isestr)) std = [...def.std]
        else problems.push('std 須為檢定標準 id 字串或其非空陣列')
    }
    if (given('v') && !(Number.isInteger(def.v) && def.v > 0)) problems.push('v 須為正整數（題組版本）')
    if (given('casesFile') && !isestr(def.casesFile)) problems.push('casesFile 須為題組檔路徑字串')
    let models = DEFAULT_FREE_MODELS
    if (given('models')) {
        if (isarr(def.models) && def.models.length && def.models.every(isestr)) models = Object.freeze([...new Set(def.models.map((m) => m.trim()).filter(Boolean))])
        else problems.push('models 須為非空之條目 id 字串陣列')
    }

    // 分頁
    if (given('pageSize') && !(Number.isInteger(def.pageSize) && def.pageSize > 0)) problems.push('pageSize 須為正整數（一頁幾案）')
    if (given('pageSize') && given('paginate')) problems.push('pageSize 與 paginate 擇一')

    // 逐次呼叫選項
    if (given('callOpt')) {
        if (!isobj(def.callOpt)) problems.push('callOpt 須為物件(併入調度層 callJson 之第三參數)')
        else {
            const clash = Object.keys(def.callOpt).filter((k) => CALL_OPT_RESERVED.includes(k))
            if (clash.length) problems.push(`callOpt 不得含 ${clash.join('、')}（由核心給）`)
        }
    }

    // 無回覆時之角色欄位
    let blankFields = {}
    if (given('blankFields')) {
        if (!isobj(def.blankFields)) problems.push('blankFields 須為物件')
        else {
            blankFields = { ...def.blankFields }
            const clash = Object.keys(blankFields).filter((k) => RUN_RESERVED.includes(k))
            if (clash.length) problems.push(`blankFields 不得含共通欄位：${clash.join('、')}`)
        }
    }

    // 報表
    let report = { criteria: DEFAULT_CRITERIA, caseColumns: [], runColumns: [] }
    if (given('report')) {
        if (!isobj(def.report)) problems.push('report 須為物件 { criteria?, caseColumns?, runColumns? }')
        else {
            const r = def.report
            const bad = unknownKeysProblem(r, ['criteria', 'caseColumns', 'runColumns'], 'report')
            if (bad) problems.push(bad)
            if (r.criteria !== undefined) {
                if (isarr(r.criteria) && r.criteria.every(isestr)) report.criteria = [...r.criteria]
                else problems.push('report.criteria 須為字串陣列（Markdown 之判準說明行）')
            }
            for (const [k, md] of [['caseColumns', true], ['runColumns', false]]) {
                if (r[k] === undefined) continue
                if (!isarr(r[k])) {
                    problems.push(`report.${k} 須為 [{ name, key${md ? ', md?' : ''} }]`)
                    continue
                }
                r[k].forEach((col, i) => {
                    const at = `report.${k}[${i}]`
                    if (!isobj(col) || !isestr(col.name) || !isestr(col.key)) return problems.push(`${at} 須為 { name, key${md ? ', md?' : ''} }（皆非空字串）`)
                    const extra = unknownKeysProblem(col, md ? ['name', 'key', 'md'] : ['name', 'key'], at)
                    if (extra) problems.push(extra)
                    if (md && col.md !== undefined && typeof col.md !== 'boolean') problems.push(`${at}.md 須為布林`)
                    // 每回欄取自每回紀錄:不在無回覆欄位(blankFields)者多半是打錯之鍵(該欄恆空)
                    if (!md && Object.keys(blankFields).length && !(col.key in blankFields)) problems.push(`${at}.key「${col.key}」不在 blankFields`)
                })
                report[k] = r[k].map((col) => (isobj(col) ? { name: col.name, key: col.key, ...(md ? { md: col.md === true } : {}) } : col))
            }
        }
    }

    // 命令列
    const casesFile = isestr(def.casesFile) ? def.casesFile : ''
    let cli = {
        command: 'node bench/cli.mjs',
        casesHelp: casesFile ? `題組檔(JSON);未給＝角色內建之題組(${path.basename(casesFile)})` : '題組檔(JSON;本角色無內建題組,須給)',
        options: [],
    }
    if (given('cli')) {
        if (!isobj(def.cli)) problems.push('cli 須為物件 { command?, casesHelp?, options? }')
        else {
            const c = def.cli
            const bad = unknownKeysProblem(c, ['command', 'casesHelp', 'options'], 'cli')
            if (bad) problems.push(bad)
            for (const k of ['command', 'casesHelp']) {
                if (c[k] === undefined) continue
                if (isestr(c[k]) && c[k].trim()) cli[k] = c[k]
                else problems.push(`cli.${k} 須為非空字串`)
            }
            if (c.options !== undefined) {
                if (!isarr(c.options)) problems.push('cli.options 須為 [{ flag, key, arg?, help?, parse? }]')
                else {
                    const flags = new Set()
                    const keys = new Set()
                    c.options.forEach((o, i) => {
                        const at = `cli.options[${i}]`
                        if (!isobj(o)) return problems.push(`${at} 須為物件 { flag, key, arg?, help?, parse? }`)
                        const extra = unknownKeysProblem(o, ['flag', 'key', 'arg', 'help', 'parse'], at)
                        if (extra) problems.push(extra)
                        if (!isestr(o.flag) || !CLI_FLAG_RE.test(o.flag)) problems.push(`${at}.flag 須為「--小寫英數與連字號」`)
                        else if (BASE_CLI_OPTS[o.flag] || o.flag === '--help') problems.push(`${at}.flag「${o.flag}」與共用參數重名`)
                        else if (flags.has(o.flag)) problems.push(`${at}.flag「${o.flag}」重複`)
                        else flags.add(o.flag)
                        if (!isestr(o.key) || !CLI_KEY_RE.test(o.key)) problems.push(`${at}.key 須為識別字`)
                        else if (BASE_CLI_KEYS.includes(o.key)) problems.push(`${at}.key「${o.key}」與共用參數之結果鍵重名`)
                        else if (keys.has(o.key)) problems.push(`${at}.key「${o.key}」重複`)
                        else keys.add(o.key)
                        if (o.arg !== undefined && !isestr(o.arg)) problems.push(`${at}.arg 須為字串`)
                        if (o.help !== undefined && typeof o.help !== 'string') problems.push(`${at}.help 須為字串`)
                        if (o.parse !== undefined && !isfun(o.parse)) problems.push(`${at}.parse 須為函數`)
                    })
                    cli.options = c.options.map((o) => (isobj(o) ? { flag: o.flag, key: o.key, arg: isestr(o.arg) ? o.arg : '<值>', help: typeof o.help === 'string' ? o.help : '', parse: isfun(o.parse) ? o.parse : (v) => v } : o))
                }
            }
        }
    }

    if (problems.length) {
        throw new Error(`角色定義不合格（${isestr(def.id) ? def.id : '?'}；${problems.length} 項）：${problems.join('；')}`)
    }

    const detailOf = isfun(def.detailOf) ? def.detailOf : () => ''
    const role = Object.freeze({
        id: def.id,
        name: def.name,
        title: isestr(def.title) ? def.title : `${def.name} AI 能力評分`,
        runnerName: isestr(def.runnerName) ? def.runnerName : 'runBench',
        std: Object.freeze(std),
        v: given('v') ? def.v : null,
        casesFile,
        models,
        suiteProblems: isfun(def.suiteProblems) ? def.suiteProblems : () => [],
        caseProblems: isfun(def.caseProblems) ? def.caseProblems : () => [],
        expectOf: def.expectOf,
        caseFieldsOf: isfun(def.caseFieldsOf) ? def.caseFieldsOf : () => ({}),
        vocabOf: isfun(def.vocabOf) ? def.vocabOf : (c) => c?.input?.vocab,
        domainOf: def.domainOf,
        domainProblem: isfun(def.domainProblem) ? def.domainProblem : (d) => (isobj(d) ? '' : '須為物件'),
        pageSize: given('pageSize') ? def.pageSize : 1,
        paginate: isfun(def.paginate) ? def.paginate : null,
        promptOf: def.promptOf,
        check: isfun(def.check) ? def.check : () => true,
        callOpt: Object.freeze(isobj(def.callOpt) ? { ...def.callOpt } : {}),
        call: isfun(def.call) ? def.call : null,
        verdictOf: def.verdictOf,
        blankFields: Object.freeze(blankFields),
        detailOf,
        mismatchNote: isfun(def.mismatchNote) ? def.mismatchNote : (rec, expect) => `判 ${rec.cls}${textOf(detailOf, rec)}，應然 ${expect}`,
        report: Object.freeze({
            criteria: Object.freeze([...report.criteria]),
            caseColumns: Object.freeze(report.caseColumns.map((x) => Object.freeze(x))),
            runColumns: Object.freeze(report.runColumns.map((x) => Object.freeze(x))),
        }),
        cli: Object.freeze({ command: cli.command, casesHelp: cli.casesHelp, options: Object.freeze(cli.options.map((x) => Object.freeze(x))) }),
    })
    DEFINED.add(role)
    return role
}

/**
 * 角色之文字掛點之安全呼叫(拋錯或非字串回空字串:顯示用之掛點不得中斷評分或報表)
 *
 * @param {Function} fn 輸入掛點
 * @param {...*} args 輸入引數
 * @returns {String} 回傳文字
 */
function textOf(fn, ...args) {
    try {
        const s = fn(...args)
        return typeof s === 'string' ? s : ''
    }
    catch {
        return ''
    }
}

/**
 * domain 之形狀檢核(角色之 domainProblem):拋錯或回傳非字串之真值皆視為不合格——檢核失效不得放行
 *
 * @param {Object} role 輸入角色
 * @param {*} d 輸入 domain
 * @returns {String} 回傳問題說明(空字串＝合格)
 */
function domainProblemOf(role, d) {
    try {
        const p = role.domainProblem(d)
        return typeof p === 'string' ? p : (p ? String(p) : '')
    }
    catch (e) {
        return `檢核拋錯：${oneline(e?.message || e, 160)}`
    }
}

/**
 * 角色之檢核掛點之安全呼叫:回傳非空字串之問題陣列(拋錯記為一項問題)
 *
 * @param {Function} fn 輸入掛點
 * @param {*} arg 輸入引數
 * @returns {Array} 回傳問題說明陣列
 */
function problemsOf(fn, arg) {
    let out
    try {
        out = fn(arg)
    }
    catch (e) {
        return [`角色之檢核拋錯：${oneline(e?.message || e, 160)}`]
    }
    return isarr(out) ? out.filter(isestr) : []
}

// ════════════════ 題組 ════════════════

/**
 * 驗題組並正規化:接受 { std, v, note, cases } 或案陣列;共通欄位(id、holdout、type、why)由本函數驗,input 與 expect 交角色之 caseProblems;
 * 角色宣告 std／v 者另驗題組有給之 std／v。任一不合即拋錯並列出全部問題
 *
 * @param {Object} role 輸入角色(defineBenchRole 之產物或定義)
 * @param {Object|Array} x 輸入題組物件或案陣列
 * @returns {Object} 回傳 { std, v, note, cases }；cases 各項 holdout 正規化為布林，其餘欄位原樣
 * @throws {Error} 角色定義不合、題組形狀不合、無案、id 缺漏或重複、holdout 非布林、type 非非空字串、角色之檢核有問題、
 *   應然類別無法判定、缺 why，或 std／v 與角色不符時拋出
 * @example
 * let role = defineBenchRole({
 *     id: 'topic',
 *     name: '題目分類(topic)',
 *     expectOf: (c) => c.expect.label,
 *     domainOf: () => ({}),
 *     promptOf: (cases) => cases.map((c, i) => `${i + 1}. ${c.input.text}`).join('；'),
 *     verdictOf: (data) => ({ cls: data?.label ?? null, valid: true, problem: '', fields: {} }),
 * })
 * let set = validateBenchCases(role, [{ id: 't1', input: { text: '黑洞光譜' }, expect: { label: 'astro' }, why: '天文題' }])
 * console.log(set.cases.length, set.cases[0].holdout)
 * // => 1 false
 *
 * try { validateBenchCases(role, [{ id: 't1', input: { text: '黑洞光譜' }, expect: { label: 'astro' } }]) } catch (e) { console.log(e.message) }
 * // => 題組不合格（1 項）：cases[0](t1) 缺 why(應然之依據)
 */
export function validateBenchCases(role, x) {

    //check
    role = defineBenchRole(role)
    const set = isarr(x) ? { cases: x } : x
    if (!isobj(set) || !isarr(set.cases) || set.cases.length === 0) {
        throw new Error('題組須為 { std?, v?, note?, cases:[…] } 或案陣列，且至少一案')
    }

    const problems = []
    // 題組層:角色宣告之標準與版本(題組有給才驗;題組格式隨版本而變,讀錯版本之題組會靜默誤判)
    if (role.std.length && isestr(set.std) && !role.std.includes(set.std)) problems.push(`題組之 std「${set.std}」非本角色之標準（${role.std.join('、')}）`)
    if (role.v !== null && set.v !== undefined && set.v !== null && set.v !== role.v) problems.push(`題組之 v「${set.v}」非本角色所讀之題組版本（${role.v}）`)
    problems.push(...problemsOf(role.suiteProblems, set))
    const ids = new Set()
    set.cases.forEach((c, i) => {
        const at = `cases[${i}]${isestr(c?.id) ? `(${c.id})` : ''}`
        if (!isobj(c)) {
            problems.push(`${at} 須為物件`)
            return
        }
        if (!isestr(c.id)) problems.push(`${at} 缺 id`)
        else if (ids.has(c.id)) problems.push(`${at} id 重複`)
        else ids.add(c.id)
        if (c.holdout !== undefined && typeof c.holdout !== 'boolean') problems.push(`${at} holdout 須為布林`)
        if (c.type !== undefined && !isestr(c.type)) problems.push(`${at} type 須為非空字串`)
        const own = problemsOf(role.caseProblems, c)
        for (const p of own) problems.push(`${at} ${p}`)
        // 角色之檢核合格者,應然類別須可判定(否則該案恆不通過——是角色之缺陷,不是模型之失分)
        if (!own.length) {
            let e = null
            try {
                e = role.expectOf(c)
            }
            catch { /* 下行列為問題 */ }
            if (!isestr(e)) problems.push(`${at} 應然類別無法判定（expectOf 須回傳非空字串）`)
        }
        if (!isestr(c.why)) problems.push(`${at} 缺 why(應然之依據)`)
    })
    if (problems.length) throw new Error(`題組不合格（${problems.length} 項）：${problems.join('；')}`)
    return {
        std: String(set.std || ''),
        v: set.v ?? 0,
        note: String(set.note || ''),
        cases: set.cases.map((c) => ({ ...c, holdout: c.holdout === true })),
    }
}

/**
 * 讀題組檔並驗之(相對路徑以當下 cwd 解析)
 *
 * @param {Object} role 輸入角色(defineBenchRole 之產物或定義)
 * @param {String} [file] 輸入題組 JSON 檔路徑，未給用角色之內建題組(casesFile)
 * @returns {Object} 回傳 validateBenchCases 之產物
 * @throws {Error} 未給檔且角色無內建題組、檔案讀不到、非 JSON 或題組不合時拋出(訊息含檔案路徑)
 * @example
 * let role = defineBenchRole({
 *     id: 'topic',
 *     name: '題目分類(topic)',
 *     expectOf: (c) => c.expect.label,
 *     domainOf: () => ({}),
 *     promptOf: (cases) => cases.map((c, i) => `${i + 1}. ${c.input.text}`).join('；'),
 *     verdictOf: (data) => ({ cls: data?.label ?? null, valid: true, problem: '', fields: {} }),
 * })
 * fs.mkdirSync('./bench-out', { recursive: true })
 * fs.writeFileSync('./bench-out/topic-cases.json', JSON.stringify({ cases: [{ id: 't1', input: { text: '黑洞光譜' }, expect: { label: 'astro' }, why: '天文題' }] }))
 * let set = loadBenchCases(role, './bench-out/topic-cases.json')
 * console.log(set.cases.length, set.cases[0].holdout)
 * // => 1 false
 *
 * try { loadBenchCases(role) } catch (e) { console.log(e.message) }
 * // => 角色 topic 無內建題組，須給題組檔
 */
export function loadBenchCases(role, file) {

    //check
    role = defineBenchRole(role)
    if (!isestr(file) && !role.casesFile) {
        throw new Error(`角色 ${role.id} 無內建題組，須給題組檔`)
    }

    const f = path.resolve(isestr(file) ? file : role.casesFile)
    let j
    try {
        j = JSON.parse(fs.readFileSync(f, 'utf8'))
    }
    catch (e) {
        throw new Error(`題組檔讀取失敗（${f}）：${e.message}`)
    }
    try {
        return validateBenchCases(role, j)
    }
    catch (e) {
        throw new Error(`${e.message}（${f}）`)
    }
}

// ════════════════ 逐案判準、失敗歸類、指紋 ════════════════

/** 呼叫失敗之類別說明(報表與未通過原因共用;鍵與 report.mjs 之 BENCH_FAIL_COLUMNS 同一組) */
export const BENCH_FAIL_KINDS = Object.freeze({ timeout: '逾時', limit: '額度用盡或限流', reply: '回覆非 JSON', error: '執行錯誤', skipped: '略過（預算、中止或斷網）' })

/**
 * 呼叫失敗之歸類:限流(調度層冷卻事件非逾時所致,或錯誤訊息命中 LIMIT_TEXT_RE)→ 逾時 → 回覆非 JSON(或不合 check)→ 略過 → 執行錯誤
 *
 * @param {Object} r 輸入 callJson 之失敗結果(取 error、errors、skipped)
 * @param {Array} [events=[]] 輸入本次呼叫之調度事件(callOpt.onEvent 所收;置換之調度層可能無)
 * @returns {Object} 回傳 { kind:BENCH_FAIL_KINDS 之鍵, error:String(錯誤摘要), reply:String(回覆非 JSON 時之回覆節錄) }
 * @example
 * console.log(benchFailOf({ error: 'FreeUsageLimitError: Rate limit exceeded' }).kind, benchFailOf({ error: 'TIMEOUT after 300s' }).kind)
 * // => limit timeout
 */
export function benchFailOf(r, events = []) {
    const evs = isarr(events) ? events : []
    const err = oneline(r?.error, 300)
    const errs = (isarr(r?.errors) ? r.errors : []).map((x) => oneline(x, 200)).filter(Boolean)
    const tries = evs.filter((ev) => ev?.type === 'skip-group' || ev?.type === 'next-key')
    const last = tries[tries.length - 1] || null
    const errorType = String(last?.errorType || '')
    const text = [err, ...errs].join(' ')
    let kind = 'error'
    if (evs.some((ev) => ev?.type === 'cooled' && !/^TIMEOUT/.test(String(ev.error || ''))) || LIMIT_TEXT_RE.test(text)) kind = 'limit'
    else if (errorType === 'timeout' || /^TIMEOUT/.test(err) || /:timeout\(/.test(text)) kind = 'timeout'
    else if (errorType === 'validation' || /:validation\(/.test(text)) kind = 'reply'
    else if (r?.skipped === true) kind = 'skipped'
    const error = [err, ...errs.filter((e) => e !== err)].filter(Boolean).join('｜') || '呼叫失敗'
    const reply = kind === 'reply' && isestr(last?.stdout) ? oneline(last.stdout, 200) : ''
    return { kind, error, reply }
}

/**
 * 逐案判定:各回之類別皆＝應然才通過(不以比率放行);未通過者組原因(逐回列出)
 *
 * @param {String} expect 輸入應然類別
 * @param {Array} recs 輸入該案各回紀錄(取 run、notRun、callFail、failKind、error、reply、cls、problem)
 * @param {Integer} runs 輸入應有之回數
 * @param {Function} [missNote] 輸入類別不符應然時之原因 (rec, expect) => String(接在「第 n 回」之後;拋錯或非字串時用預設)，
 *   未給為「判 <類別>，應然 <應然>」
 * @returns {Object} 回傳 { pass:Boolean, consistent:Boolean(各回類別相同且皆有裁決), note:String(未通過原因;通過為 '') }
 * @example
 * let r = judgeBenchCase('yes', [{ run: 1, cls: 'yes' }, { run: 2, cls: 'no' }], 2)
 * console.log(r.pass, r.consistent, r.note)
 * // => false false 第 2 回判 no，應然 yes；各回不一致
 */
export function judgeBenchCase(expect, recs, runs, missNote) {
    const list = isarr(recs) ? recs : []
    const note = (x) => {
        const dflt = `判 ${x.cls}，應然 ${expect}`
        return isfun(missNote) ? (textOf(missNote, x, expect) || dflt) : dflt
    }
    const classes = list.map((x) => x.cls)
    const pass = list.length === runs && classes.every((k) => k === expect)
    const consistent = classes.length > 0 && classes.every((k) => k !== null && k === classes[0])
    if (pass) return { pass, consistent, note: '' }
    const reasons = []
    for (const x of list) {
        const at = `第 ${x.run} 回`
        if (x.notRun) reasons.push(`${at}未呼叫（${x.error}）`)
        else if (x.callFail) reasons.push(`${at}呼叫失敗（${BENCH_FAIL_KINDS[x.failKind] || x.failKind}：${oneline(x.error, 160)}${x.reply ? `；回覆「${x.reply}」` : ''}）`)
        else if (x.cls === null) reasons.push(`${at}無可用之裁決（${x.problem}${x.reply ? `；回覆「${x.reply}」` : ''}）`)
        else if (x.cls !== expect) reasons.push(`${at}${note(x)}`)
    }
    if (!consistent && classes.length > 0 && classes.every((k) => k !== null)) reasons.push('各回不一致')
    if (list.length < runs) reasons.push(`只有 ${list.length}/${runs} 回`)
    return { pass, consistent, note: reasons.join('；') }
}

/**
 * 提示詞指紋:各頁(頁內案 id＋實際送出之提示詞)之 sha1 前 16 碼;題組、詞彙、提示詞或分頁一改即不同(一案一頁時即「案 id＋提示詞」)
 *
 * @param {Array} pages 輸入頁陣列 [{ ids:Array(頁內案 id), prompt:String }]
 * @returns {String} 回傳 16 碼十六進位字串(無頁時為空字串)
 * @example
 * console.log(benchPromptFpOf([{ ids: ['a1'], prompt: '題目' }]).length)
 * // => 16
 */
export function benchPromptFpOf(pages) {
    const list = isarr(pages) ? pages : []
    return sha1(list.map((p) => `${(isarr(p?.ids) ? p.ids : []).join('\u0003')}\u0002${String(p?.prompt ?? '')}`).join('\u0001')).slice(0, 16)
}

// ════════════════ 準備(任何呼叫之前):題組、domain、分頁、提示詞 ════════════════

/**
 * 題組:未給用角色之內建題組,給了即驗
 *
 * @param {Object} role 輸入角色
 * @param {*} cases 輸入題組
 * @returns {Object} 回傳 validateBenchCases 之產物
 */
const casesOf = (role, cases) => (cases === undefined || cases === null ? loadBenchCases(role) : validateBenchCases(role, cases))

/**
 * domain 之來源:其餘案之 domain(base)與案自帶詞彙時之建構函數(domainOf)
 * base:opt.domain 給了即用之;opt.vocab 給了以 domainOf(vocab) 建;皆未給以角色之 domainOf(null) 建(預設詞彙)
 *
 * @param {Object} role 輸入角色
 * @param {Object} opt 輸入 runBench／planBench 之設定物件(取 domain、domainOf、vocab)
 * @returns {Object} 回傳 { base, domainOf }
 * @throws {Error} vocab 非物件、domain 與 vocab 並給、vocab 不合(domainOf 拋錯)或 domain 形狀不合時拋出
 */
function domainsOf(role, opt) {
    const name = role.runnerName
    const domainOf = isfun(opt.domainOf) ? opt.domainOf : role.domainOf
    const hasVocab = opt.vocab !== undefined && opt.vocab !== null
    const hasDomain = opt.domain !== undefined && opt.domain !== null
    if (hasVocab && !isobj(opt.vocab)) throw new Error(`${name} 之 vocab 須為物件（詞彙覆寫）`)
    if (hasVocab && hasDomain) throw new Error(`${name} 之 domain 與 vocab 擇一（vocab 經 domainOf 建 domain）`)
    let base
    if (hasDomain) base = opt.domain
    else if (hasVocab) {
        try {
            base = domainOf(opt.vocab)
        }
        catch (e) {
            throw new Error(`${name} 之 vocab 不合：${e?.message || e}`)
        }
    }
    else base = role.domainOf(null)
    const p = domainProblemOf(role, base)
    if (p) throw new Error(`${name} 之 domain ${p}`)
    return { base, domainOf }
}

/**
 * 角色參數(opt.roleOpt;命令列由角色之 cli.options 解析)
 *
 * @param {Object} role 輸入角色
 * @param {Object} opt 輸入設定物件
 * @returns {Object} 回傳角色參數之淺拷貝(未給為 {})
 * @throws {Error} 給了但非物件時拋出
 */
function roleOptOf(role, opt) {
    if (opt.roleOpt === undefined || opt.roleOpt === null) return {}
    if (!isobj(opt.roleOpt)) throw new Error(`${role.runnerName} 之 roleOpt 須為物件（角色參數）`)
    return { ...opt.roleOpt }
}

/**
 * 穩定序列化(物件鍵排序):判斷兩案之詞彙是否相同(同頁之案須同一份詞彙)
 *
 * @param {*} v 輸入值
 * @returns {String} 回傳序列化字串
 */
function stableKey(v) {
    if (isarr(v)) return `[${v.map(stableKey).join(',')}]`
    if (isobj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableKey(v[k])}`).join(',')}}`
    return String(JSON.stringify(v))
}

/**
 * 去掉與共通欄位同名之鍵(角色欄位不得蓋掉共通欄位)
 *
 * @param {*} o 輸入角色欄位物件
 * @param {Array} reserved 輸入共通欄位名
 * @returns {Object} 回傳新物件(非物件回 {})
 */
const ownFields = (o, reserved) => (isobj(o) ? Object.fromEntries(Object.entries(o).filter(([k]) => !reserved.includes(k))) : {})

/**
 * 準備:各案之 domain、應然、角色欄位 → 分頁 → 各頁提示詞(皆在任何呼叫之前;組不出即拋)
 *
 * @param {Object} role 輸入角色
 * @param {Object} set 輸入已驗之題組
 * @param {Object} domains 輸入 domainsOf 之產物
 * @param {Object} ctx 輸入 { roleOpt }
 * @returns {Object} 回傳 { items:[{ i, c, domain, vkey, expect, fields, seq(項編號:依分頁之序跨頁連續、1 起) }], pages:[{ items, cases, ids, domain, prompt, label, base(首案之項編號減一) }] }
 * @throws {Error} 案之 domain 形狀不合、應然類別無法判定、分頁不合或提示詞非非空字串時拋出
 */
function prepare(role, set, domains, ctx) {
    const name = role.runnerName
    const items = set.cases.map((c, i) => {
        const cv = role.vocabOf(c)
        const own = isobj(cv)
        let domain = domains.base
        if (own) {
            domain = domains.domainOf(cv)
            const p = domainProblemOf(role, domain)
            if (p) throw new Error(`${name} 之 domainOf 所建之 domain ${p}（案 ${c.id}）`)
        }
        const expect = role.expectOf(c)
        if (!isestr(expect)) throw new Error(`${name} 之 expectOf 須回傳非空字串（案 ${c.id}）`)
        return { i, c, domain, vkey: own ? stableKey(cv) : '', expect, fields: ownFields(role.caseFieldsOf(c), CASE_RESERVED) }
    })

    let groups = []
    if (role.paginate) {
        const byCase = new Map(items.map((it) => [it.c, it]))
        const byId = new Map(items.map((it) => [it.c.id, it]))
        const out = role.paginate(items.map((it) => it.c), ctx)
        if (!isarr(out)) throw new Error(`${name} 之分頁(paginate)須回傳頁陣列`)
        const seen = new Set()
        groups = out.map((page, k) => {
            if (!isarr(page) || page.length === 0) throw new Error(`${name} 之分頁第 ${k + 1} 頁須為非空之案陣列`)
            return page.map((x) => {
                const it = isestr(x) ? byId.get(x) : byCase.get(x)
                if (!it) throw new Error(`${name} 之分頁第 ${k + 1} 頁含題組外之案（${isestr(x) ? x : oneline(JSON.stringify(x), 60)}）`)
                if (seen.has(it)) throw new Error(`${name} 之分頁重複列入案 ${it.c.id}`)
                seen.add(it)
                return it
            })
        })
        const missing = items.filter((it) => !seen.has(it)).map((it) => it.c.id)
        if (missing.length) throw new Error(`${name} 之分頁漏列案：${missing.join('、')}`)
        groups.forEach((g, k) => {
            if (g.some((it) => it.vkey !== g[0].vkey)) throw new Error(`${name} 之分頁第 ${k + 1} 頁混用不同詞彙之案（${g.map((it) => it.c.id).join('、')}；同頁共用一份提示詞）`)
        })
    }
    else {
        for (const it of items) {
            const last = groups[groups.length - 1]
            if (last && last.length < role.pageSize && last[0].vkey === it.vkey) last.push(it)
            else groups.push([it])
        }
    }

    // 項編號依分頁之序跨頁連續(1 起):各頁之基數交 promptOf／check(ctx.base)、各案之編號交 verdictOf(at.seq)——票類角色以全域編號作答與取票
    let seq = 0
    const pages = groups.map((g) => {
        const base = seq
        for (const it of g) it.seq = ++seq
        const cases = g.map((it) => it.c)
        const ids = cases.map((c) => c.id)
        const domain = g[0].domain
        const prompt = role.promptOf(cases, domain, { ...ctx, base })
        if (!isestr(prompt) || !prompt.trim()) throw new Error(`${name} 之 promptOf 須回傳非空字串（頁：${ids.join('、')}）`)
        return { items: g, cases, ids, domain, prompt, base, label: ids.length === 1 ? ids[0] : `${ids[0]}～${ids[ids.length - 1]}（${ids.length} 案）` }
    })
    return { items, pages }
}

/**
 * 評分之準備(不呼叫 AI):驗題組、建 domain、分頁、組各頁提示詞並算指紋——與 runBench 同一段準備(供指紋綁題組、預覽提示詞與測試)
 *
 * @param {Object} role 輸入角色(defineBenchRole 之產物或定義)
 * @param {Object} [opt={}] 輸入設定物件(cases、vocab、domain、domainOf、roleOpt;語意同 runBench)
 * @returns {Object} 回傳 { set(已驗之題組), pages:[{ ids, prompt, base(該頁首案之項編號減一) }], promptFp }
 * @throws {Error} 角色定義、題組、詞彙、domain、分頁或提示詞不合時拋出
 * @example
 * let role = defineBenchRole({
 *     id: 'topic',
 *     name: '題目分類(topic)',
 *     pageSize: 2,
 *     expectOf: (c) => c.expect.label,
 *     domainOf: () => ({}),
 *     promptOf: (cases) => cases.map((c, i) => `${i + 1}. ${c.input.text}`).join('；'),
 *     verdictOf: (data) => ({ cls: data?.label ?? null, valid: true, problem: '', fields: {} }),
 * })
 * let cases = [
 *     { id: 't1', input: { text: '黑洞光譜' }, expect: { label: 'astro' }, why: '天文題' },
 *     { id: 't2', input: { text: '恆星演化' }, expect: { label: 'astro' }, why: '天文題' },
 *     { id: 't3', input: { text: '細胞分裂' }, expect: { label: 'bio' }, why: '生物題' },
 * ]
 * let plan = planBench(role, { cases })
 * console.log(plan.pages.map((p) => `${p.ids.join('+')}:${p.base}`))
 * // => [ 't1+t2:0', 't3:2' ]
 * console.log(plan.pages[0].prompt, plan.promptFp.length)
 * // => 1. 黑洞光譜；2. 恆星演化 16
 */
export function planBench(role, opt = {}) {

    //check
    role = defineBenchRole(role)
    if (!isobj(opt)) {
        opt = {}
    }

    const set = casesOf(role, opt.cases)
    const domains = domainsOf(role, opt)
    const { pages } = prepare(role, set, domains, { roleOpt: roleOptOf(role, opt) })
    return { set, pages: pages.map((p) => ({ ids: [...p.ids], prompt: p.prompt, base: p.base })), promptFp: benchPromptFpOf(pages) }
}

// ════════════════ 執行器 ════════════════

/**
 * 一回紀錄:共通欄位在前、角色欄位(與共通欄位同名者略去)在後,valid 依角色欄位之位置(無則接後)、problem 殿後
 *
 * @param {Object} role 輸入角色
 * @param {Object} head 輸入共通欄位 { run, notRun, ms, providerId, cls, callFail, failKind, error, reply }
 * @param {Object|null} v 輸入該案之判定(verdictSafe 之產物);null＝無回覆(呼叫失敗、未呼叫)
 * @returns {Object} 回傳該回紀錄
 */
function recordOf(role, head, v) {
    const rec = { ...head, ...ownFields(v ? v.fields : role.blankFields, RUN_RESERVED) }
    rec.valid = v ? v.valid : false
    rec.problem = v ? v.problem : ''
    return rec
}

/**
 * 未呼叫之一回紀錄(停測或條目不可用)
 *
 * @param {Object} role 輸入角色
 * @param {Integer} run 輸入第幾回
 * @param {String} reason 輸入未呼叫之原因
 * @returns {Object} 回傳該回紀錄
 */
const notRunOf = (role, run, reason) => recordOf(role, { run, notRun: true, ms: 0, providerId: '', cls: null, callFail: false, failKind: '', error: reason, reply: '' }, null)

/**
 * 角色之 verdictOf 之安全呼叫與正規化(拋錯或回傳形狀不合 → 無裁決並註明;不中斷評分)
 *
 * @param {Object} role 輸入角色
 * @param {*} data 輸入該頁回覆(已解析之 JSON)
 * @param {Object} c 輸入該案
 * @param {Object} at 輸入 { index, seq, base, domain, cases, roleOpt }
 * @returns {Object} 回傳 { cls:String|null, valid:Boolean, problem:String, fields:Object }
 */
function verdictSafe(role, data, c, at) {
    let v
    try {
        v = role.verdictOf(data, c, at)
    }
    catch (e) {
        return { cls: null, valid: false, problem: `判定拋錯：${oneline(e?.message || e, 160)}`, fields: role.blankFields }
    }
    if (!isobj(v)) return { cls: null, valid: false, problem: '判定未回傳物件（verdictOf 須回傳 { cls, valid, problem, fields }）', fields: role.blankFields }
    const cls = isestr(v.cls) ? v.cls : null
    return {
        cls,
        valid: cls !== null && v.valid === true,
        problem: typeof v.problem === 'string' && v.problem ? v.problem : (cls === null ? '回覆無可用之裁決' : ''),
        fields: isobj(v.fields) ? v.fields : role.blankFields,
    }
}

/**
 * 一頁一回之呼叫(不拋錯):呼叫失敗及於整頁各案;成功者逐案交 verdictOf
 *
 * @param {Object} role 輸入角色
 * @param {Object} adapter 輸入調度層(取 callJson;角色給了 call 者原樣交 call)
 * @param {Object} page 輸入頁 { items, cases, domain, prompt, base }
 * @param {Object} spec 輸入席位規格
 * @param {Integer} run 輸入第幾回
 * @param {Object} ctx 輸入 { roleOpt }
 * @returns {Promise} 回傳 Promise，resolve 回傳 { call:{ notRun:false, callFail, failKind, error, ms }, records:Array(依頁內順序之各案紀錄) }
 */
async function callPage(role, adapter, page, spec, run, ctx) {
    const events = []
    // 交調度層之 check 收該頁之 domain 與項編號基數(票類角色之批合格判準須以該頁組提示詞之 domain 判)
    const check = (data) => role.check(data, page.cases, { ...ctx, domain: page.domain, base: page.base })
    const onEvent = (ev) => events.push(ev)
    const t0 = Date.now()
    let r
    try {
        // 角色之自訂呼叫(檔頭【自訂呼叫】)與預設之 callJson 收同一組材料;回傳其後之處理同一套
        r = role.call
            ? await role.call(adapter, page.prompt, { spec, check, callOpt: role.callOpt, onEvent })
            : await adapter.callJson(page.prompt, check, { ...role.callOpt, spec, onEvent })
    }
    catch (e) {
        r = { ok: false, error: `調度層拋錯：${oneline(e?.message || e, 200)}` }
    }
    const ms = Date.now() - t0
    const base = { run, notRun: false, ms, providerId: String(r?.providerId || '') }
    if (!r || r.ok !== true) {
        const f = benchFailOf(r, events)
        const head = { ...base, cls: null, callFail: true, failKind: f.kind, error: f.error, reply: f.reply }
        return { call: { notRun: false, callFail: true, failKind: f.kind, error: f.error, ms }, records: page.items.map(() => recordOf(role, head, null)) }
    }
    const records = page.items.map((it, k) => {
        const v = verdictSafe(role, r.data, it.c, { index: k + 1, seq: it.seq, base: page.base, domain: page.domain, cases: page.cases, roleOpt: ctx.roleOpt })
        return recordOf(role, { ...base, cls: v.cls, callFail: false, failKind: '', error: '', reply: v.cls === null ? oneline(JSON.stringify(r.data), 200) : '' }, v)
    })
    return { call: { notRun: false, callFail: false, failKind: '', error: '', ms }, records }
}

/**
 * 通過數彙整
 *
 * @param {Array} list 輸入案結果陣列
 * @returns {Object} 回傳 { pass, total, rate(無案為 null) }
 */
const tally = (list) => ({ pass: list.filter((c) => c.pass).length, total: list.length, rate: list.length ? list.filter((c) => c.pass).length / list.length : null })

/**
 * 平均(無元素回 null;取整數毫秒)
 *
 * @param {Array} xs 輸入數值陣列
 * @returns {Number|null} 回傳平均或 null
 */
const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null)

/**
 * 有限併發:同時至多 limit 個 worker,依序取件
 *
 * @param {Array} items 輸入工作陣列
 * @param {Integer} limit 輸入併發上限
 * @param {Function} worker 輸入 async (item, index) => void
 * @returns {Promise} 回傳 Promise，全部完成時 resolve
 */
async function runPool(items, limit, worker) {
    let next = 0
    const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++
            await worker(items[i], i)
        }
    })
    await Promise.all(lanes)
}

/**
 * 正整數選項(未給回預設;給了不合即拋錯)
 *
 * @param {*} v 輸入值
 * @param {Integer|null} dflt 輸入預設值
 * @param {String} name 輸入選項名(錯誤訊息用)
 * @param {String} runner 輸入執行器名(錯誤訊息用)
 * @returns {Integer|null} 回傳選項值
 * @throws {Error} 給了但非正整數時拋出
 */
function pintOpt(v, dflt, name, runner) {
    if (v === undefined || v === null) return dflt
    if (!Number.isInteger(v) || v <= 0) throw new Error(`${runner} 之 ${name} 須為正整數，收到 ${JSON.stringify(v)}`)
    return v
}

/**
 * AI 能力評分之執行器(判準、分頁、併發、失敗與停測見檔頭)
 *
 * @param {Object} role 輸入角色(defineBenchRole 之產物或定義)
 * @param {Object} opt 輸入設定物件
 * @param {Array} opt.models 輸入受測模型(調度層條目 id)陣列，如 DEFAULT_FREE_MODELS；重複者去除
 * @param {Object|Array} [opt.cases] 輸入題組(validateBenchCases 所收形狀)，未給用角色之內建題組
 * @param {Integer} [opt.runs=2] 輸入每案呼叫回數
 * @param {Function} [opt.adapterOf] 輸入 (modelId) => 調度層(具 callJson;角色給了 call 者只要求為物件)；與 aiAdapter 擇一，兩者皆給以 adapterOf 為準
 * @param {Object} [opt.aiAdapter] 輸入共用之調度層(core/ai/adapter 之 createAiAdapter 產物或相容者;角色給了 call 者只要求為物件)
 * @param {Object} [opt.vocab] 輸入詞彙覆寫(交 domainOf 建未自帶詞彙之案之 domain;命令列 --vocab);與 domain 擇一
 * @param {Object} [opt.domain] 輸入未自帶詞彙之案之 domain，未給以 vocab 或預設詞彙經角色之 domainOf 建
 * @param {Function} [opt.domainOf] 輸入 (vocab) => domain，案自帶詞彙與 opt.vocab 用;未給用角色之 domainOf
 *   (覆寫提示詞者須一併給 domain 或 vocab,否則未自帶詞彙之案仍用角色之預設 domain)
 * @param {Object} [opt.roleOpt] 輸入角色參數(交角色之 paginate、promptOf、check、verdictOf;命令列由角色之 cli.options 解析)
 * @param {Integer} [opt.timeoutMs] 輸入單次呼叫逾時毫秒數(寫入席位 timeoutMs,覆寫條目之逾時)，未給沿用調度層之設定
 * @param {Integer} [opt.concurrency=2] 輸入同時受測之模型數上限
 * @param {Integer} [opt.stopAfterFails=2] 輸入同一模型連續幾次服務面失敗(逾時、執行錯誤、略過)即停測
 * @param {Function} [opt.onProgress] 輸入進度回呼 (ev) => void；ev.type 為 'start'(帶 meta)、'call'(逐案逐回:帶 model、caseId、record)、
 *   'model-stopped'(帶 model、reason)、'model-done'(帶 model、summary)；回呼拋錯不影響評分
 * @param {Object} [opt.clock] 輸入時鐘(wsemi 之 genClockTZ 產物)，未給依 timeZone 建立
 * @param {String} [opt.timeZone='Asia/Taipei'] 輸入 IANA 時區(評比時間與報表檔名之時間戳)
 * @returns {Promise} 回傳 Promise，resolve 回傳 { meta, models }：
 *   meta＝{ std, v, note, cases(案數), holdout(保留案數), runs, models, promptFp(實際送出之提示詞之指紋), startedAt, endedAt, stamp,
 *     timeoutMs, concurrency, stopAfterFails }；
 *   models[]＝{ model, stopped(停測原因,未停為 ''), score:{ pass, total, rate }, general, holdout(同形), contract:{ valid, total, rate }
 *     (取得回覆之案次中合輸出契約者), calls:{ sent, ok, failed, notRun, byKind }(呼叫＝頁), avgMs(成功之呼叫), avgMsAll(送出之呼叫), cases[] }；
 *   cases[]＝{ id, holdout, type, ...角色之案欄位(caseFieldsOf), expect(應然類別), why(應然依據), runs[], pass, consistent, note(未通過原因) }；
 *   runs[]＝{ run, notRun, ms(該頁呼叫之耗時), providerId, cls, callFail, failKind, error, reply, ...角色欄位(blankFields／verdictOf 之 fields), valid, problem }
 * @throws {Error} 角色定義不合、models 為空、題組不合、runs／timeoutMs／concurrency／stopAfterFails 不合、未給調度層、vocab 或 domain 不合、
 *   roleOpt 非物件、或分頁與提示詞組不出時拋出(皆在任何呼叫之前)
 * @example
 * need test in nodejs.
 *
 * let ai = createAiAdapter({ ai: resolveSettings({}).ai, workspace: './bench-out/ai-workspace' })
 * let r = await runBench(role, { models: ['oc:opencode/mimo-v2.6-flash-free'], aiAdapter: ai, cases: './my-cases.json' })
 * console.log(r.models[0].score)
 */
export async function runBench(role, opt = {}) {

    //check
    role = defineBenchRole(role)
    if (!isobj(opt)) {
        opt = {}
    }
    const name = role.runnerName
    const models = [...new Set((isarr(opt.models) ? opt.models : []).filter(isestr).map((m) => m.trim()).filter(Boolean))]
    if (!models.length) {
        throw new Error(`${name} 需要 models（受測之調度層條目 id 陣列，如 DEFAULT_FREE_MODELS）`)
    }
    const set = casesOf(role, opt.cases)
    const runs = pintOpt(opt.runs, 2, 'runs', name)
    const timeoutMs = pintOpt(opt.timeoutMs, null, 'timeoutMs', name)
    const concurrency = pintOpt(opt.concurrency, 2, 'concurrency', name)
    const stopAfterFails = pintOpt(opt.stopAfterFails, 2, 'stopAfterFails', name)
    // 調度層之形狀:預設須具 callJson;角色給了 call 者只要求為物件(用哪些函數由 call 決定;檔頭【自訂呼叫】)
    const usable = (a) => isobj(a) && (role.call !== null || isfun(a.callJson))
    let adapterOf = null
    if (isfun(opt.adapterOf)) adapterOf = opt.adapterOf
    else if (usable(opt.aiAdapter)) adapterOf = () => opt.aiAdapter
    if (!adapterOf) {
        throw new Error(`${name} 需要 aiAdapter（${role.call ? '調度層物件；由角色之 call 呼叫' : '具 callJson 之調度層'}）或 adapterOf（modelId => 調度層）`)
    }
    const domains = domainsOf(role, opt)
    const ctx = { roleOpt: roleOptOf(role, opt) }
    const onProgress = isfun(opt.onProgress) ? opt.onProgress : null
    const clock = isobj(opt.clock) && isfun(opt.clock.iso8) && isfun(opt.clock.stamp8) ? opt.clock : genClockTZ(isestr(opt.timeZone) ? opt.timeZone : 'Asia/Taipei')

    /**
     * 送出進度事件(回呼拋錯不外洩)
     *
     * @param {Object} ev 輸入事件
     * @returns {undefined} 無回傳值
     */
    const emit = (ev) => {
        if (!onProgress) return
        try {
            onProgress(ev)
        }
        catch { /* 進度回呼失敗不影響評分 */ }
    }

    // 分頁與提示詞與模型無關:先全部組好(組不出即拋,在任何呼叫之前),指紋即實際送出之提示詞
    const { items, pages } = prepare(role, set, domains, ctx)
    const meta = {
        std: set.std,
        v: set.v,
        note: set.note,
        cases: set.cases.length,
        holdout: set.cases.filter((c) => c.holdout).length,
        runs,
        models,
        promptFp: benchPromptFpOf(pages),
        startedAt: clock.iso8(),
        endedAt: '',
        stamp: clock.stamp8(),
        timeoutMs,
        concurrency,
        stopAfterFails,
    }
    emit({ type: 'start', meta: { ...meta } })

    /**
     * 一個模型之評分(不拋錯:呼叫失敗與條目不可用皆記入結果)
     *
     * @param {String} model 輸入條目 id
     * @returns {Promise} 回傳 Promise，resolve 回傳該模型之結果(見 runBench 之回傳說明)
     */
    const benchModel = async (model) => {
        const spec = { use: model, fallback: [], ...(timeoutMs ? { timeoutMs } : {}) }
        let stopped = ''
        let adapter = null
        try {
            adapter = adapterOf(model)
            if (!usable(adapter)) stopped = role.call ? '調度層非物件' : '調度層不具 callJson'
        }
        catch (e) {
            stopped = `調度層建立失敗：${oneline(e?.message || e, 160)}`
        }
        // 條目可否解析(具 chainFor 之調度層):不可用者不呼叫,各回記未呼叫
        if (!stopped && isfun(adapter.chainFor)) {
            try {
                adapter.chainFor(spec)
            }
            catch (e) {
                stopped = `條目不可用：${oneline(e?.message || e, 200)}`
            }
        }
        if (stopped) emit({ type: 'model-stopped', model, reason: stopped })
        const recs = items.map(() => [])
        // 呼叫(頁)之紀錄:calls[頁][回];彙整依「頁 → 回」之順序(一案一頁時即逐案逐回)
        const calls = pages.map(() => [])
        let consecutive = 0
        for (let run = 1; run <= runs; run++) {
            for (let p = 0; p < pages.length; p++) {
                const page = pages[p]
                if (stopped) {
                    for (const it of page.items) recs[it.i].push(notRunOf(role, run, stopped))
                    calls[p].push({ notRun: true })
                    continue
                }
                const done = await callPage(role, adapter, page, spec, run, ctx)
                page.items.forEach((it, k) => {
                    recs[it.i].push(done.records[k])
                    emit({ type: 'call', model, caseId: it.c.id, record: { ...done.records[k] } })
                })
                calls[p].push(done.call)
                if (done.call.callFail && done.call.failKind === 'limit') {
                    stopped = `額度用盡或限流，停測（第 ${run} 回 ${page.label}：${oneline(done.call.error, 120)}）`
                }
                else if (done.call.callFail && done.call.failKind !== 'reply') {
                    consecutive++
                    if (consecutive >= stopAfterFails) stopped = `連續 ${consecutive} 回呼叫失敗，停測（最後一回：${BENCH_FAIL_KINDS[done.call.failKind] || done.call.failKind}）`
                }
                else {
                    consecutive = 0
                }
                if (stopped) emit({ type: 'model-stopped', model, reason: stopped })
            }
        }
        const cases = items.map((it) => ({
            id: it.c.id,
            holdout: it.c.holdout,
            type: isestr(it.c.type) ? it.c.type : '',
            ...it.fields,
            expect: it.expect,
            why: it.c.why,
            runs: recs[it.i],
            ...judgeBenchCase(it.expect, recs[it.i], runs, role.mismatchNote),
        }))
        const answered = cases.flatMap((c) => c.runs).filter((x) => !x.notRun && !x.callFail)
        const valid = answered.filter((x) => x.valid === true).length
        const all = calls.flat()
        const sent = all.filter((x) => !x.notRun)
        const okCalls = sent.filter((x) => !x.callFail)
        const failed = sent.filter((x) => x.callFail)
        const byKind = {}
        for (const x of failed) byKind[x.failKind] = (byKind[x.failKind] || 0) + 1
        const summary = {
            model,
            stopped,
            score: tally(cases),
            general: tally(cases.filter((c) => !c.holdout)),
            holdout: tally(cases.filter((c) => c.holdout)),
            contract: { valid, total: answered.length, rate: answered.length ? valid / answered.length : null },
            calls: { sent: sent.length, ok: okCalls.length, failed: failed.length, notRun: all.length - sent.length, byKind },
            avgMs: mean(okCalls.map((x) => x.ms)),
            avgMsAll: mean(sent.map((x) => x.ms)),
        }
        emit({ type: 'model-done', model, summary: { ...summary } })
        return { ...summary, cases }
    }

    const results = new Array(models.length)
    await runPool(models, concurrency, async (model, i) => {
        results[i] = await benchModel(model)
    })
    meta.endedAt = clock.iso8()
    return { meta, models: results }
}

// ════════════════ 角色作者之共用小件(各套件之評分角色同一份,不各寫) ════════════════

/**
 * 回覆之型別名(角色之 check 與錯誤說明用)
 *
 * @param {*} d 輸入值
 * @returns {String} 回傳型別名('null'、'array' 或 typeof 之值)
 * @example
 * console.log([typeName(null), typeName([1]), typeName({}), typeName('x')].join(','))
 * // => null,array,object,string
 */
export const typeName = (d) => (d === null ? 'null' : isarr(d) ? 'array' : typeof d)

/**
 * 依序切塊(角色之自訂分頁用)
 *
 * @param {Array} xs 輸入陣列
 * @param {Integer} n 輸入每塊個數(正整數)
 * @returns {Array} 回傳塊陣列(末塊可不足 n)
 * @example
 * console.log(JSON.stringify(chunk([1, 2, 3, 4, 5], 2)))
 * // => [[1,2],[3,4],[5]]
 */
export const chunk = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))

/**
 * 依鍵分組(組序依首見、組內保持原序;角色之自訂分頁依詞彙分組用)
 *
 * @param {Array} xs 輸入陣列
 * @param {Function} keyOf 輸入取鍵函數
 * @returns {Array} 回傳組陣列
 * @example
 * console.log(JSON.stringify(groupBy([1, 2, 3, 4], (x) => x % 2)))
 * // => [[1,3],[2,4]]
 */
export function groupBy(xs, keyOf) {
    const m = new Map()
    for (const x of xs) {
        const k = keyOf(x)
        if (!m.has(k)) m.set(k, [])
        m.get(k).push(x)
    }
    return [...m.values()]
}

/**
 * 案自帶詞彙之分組鍵(同頁之案須同一份詞彙;鍵序不同者分頁,只多一頁而不會混頁)
 *
 * @param {Object} c 輸入案
 * @returns {String} 回傳分組鍵(案帶 input.vocab 者為其 JSON 字串，未帶者為 'null')
 * @example
 * console.log(vocabKeyOf({ input: { vocab: { domain: '天文學' } } }), vocabKeyOf({}))
 * // => {"domain":"天文學"} null
 */
export const vocabKeyOf = (c) => JSON.stringify(c?.input?.vocab ?? null)

/**
 * 同詞彙分組後每頁 size 案之分頁(角色之 paginate 用;組序依首見、組內保持題組原序——同頁之案須同一份詞彙,見檔頭【分頁】)
 *
 * @param {Array} cases 輸入案陣列
 * @param {Integer} size 輸入每頁案數(正整數)
 * @param {Function} [keyOf=vocabKeyOf] 輸入分組鍵 (c) => 鍵
 * @returns {Array} 回傳頁陣列(各頁為案陣列)
 * @throws {Error} size 非正整數時拋出
 * @example
 * const cs = [{ id: 'a' }, { id: 'b', input: { vocab: { k: 1 } } }, { id: 'c' }]
 * console.log(JSON.stringify(paginateByVocab(cs, 2).map((p) => p.map((c) => c.id))))
 * // => [["a","c"],["b"]]
 */
export function paginateByVocab(cases, size, keyOf = vocabKeyOf) {
    if (!Number.isInteger(size) || size <= 0) throw new Error(`paginateByVocab 之 size 須為正整數，收到 ${JSON.stringify(size)}`)
    return groupBy(isarr(cases) ? cases : [], isfun(keyOf) ? keyOf : vocabKeyOf).flatMap((g) => chunk(g, size))
}

/**
 * 案自帶詞彙之檢核(以該工作之詞彙表之規格驗;未帶不驗)——角色之 caseProblems 用
 *
 * @param {Object} c 輸入案
 * @param {Function} validate 輸入 (vocab) => 任意(不合即拋;如各工作之詞彙解析,或以詞彙建該工作之 domain)
 * @returns {Array} 回傳問題說明陣列
 * @example
 * console.log(inputVocabProblemsOf({ input: { vocab: 5 } }, () => {}), inputVocabProblemsOf({ input: {} }, () => {}))
 * // => [ 'input.vocab 須為物件' ] []
 */
export function inputVocabProblemsOf(c, validate) {
    const v = c?.input?.vocab
    if (v === undefined) return []
    if (!isobj(v)) return ['input.vocab 須為物件']
    try {
        validate(v)
        return []
    }
    catch (e) {
        return [`input.vocab 不合：${e.message}`]
    }
}

/**
 * domain 之形狀檢核之工廠(角色之 domainProblem):須為物件、須具所列之函數;函數齊備後另交 extra 判該工作所讀之資料成員
 *
 * @param {Array} fns 輸入須具之函數名
 * @param {Function} [extra] 輸入 (d) => String(問題說明;'' 為合格)
 * @returns {Function} 回傳 (d) => String(問題說明;空字串＝合格)
 * @example
 * const need = domainNeedsOf(['buildPrompt'], (d) => (Array.isArray(d.types) ? '' : '之 types 須為陣列'))
 * console.log([need(null), need({}), need({ buildPrompt() {} }), need({ buildPrompt() {}, types: [] })].join('｜'))
 * // => 須為物件（具 buildPrompt）｜須具 buildPrompt（缺 buildPrompt）｜之 types 須為陣列｜
 */
export function domainNeedsOf(fns, extra) {
    return (d) => {
        if (!isobj(d)) return `須為物件（具 ${fns.join('、')}）`
        const miss = fns.filter((f) => !isfun(d[f]))
        if (miss.length) return `須具 ${fns.join('、')}（缺 ${miss.join('、')}）`
        return isfun(extra) ? (extra(d) || '') : ''
    }
}

/**
 * 無裁決(呼叫成功而回覆無可用之裁決;角色之 verdictOf 之形狀)
 *
 * @param {String} problem 輸入原因
 * @param {Object} blank 輸入角色之無回覆欄位
 * @returns {Object} 回傳 { cls:null, valid:false, problem, fields }，fields 為 blank 之淺拷貝
 * @example
 * console.log(noVerdict('回覆為空陣列', { label: '' }))
 * // => { cls: null, valid: false, problem: '回覆為空陣列', fields: { label: '' } }
 */
export const noVerdict = (problem, blank) => ({ cls: null, valid: false, problem, fields: { ...blank } })

/**
 * 缺票之原因(票類角色之 verdictOf 用:該編號之項皆不合格、互相矛盾或無此編號——各套件同一字樣)
 *
 * @param {Array} raws 輸入該編號之全部項(回覆中編號為該項者)
 * @param {Integer} k 輸入項編號
 * @param {Function} single 輸入正式之單票驗證 (raw) => 票|不確定|null(不合格)
 * @param {Object} [o={}] 輸入 { empty?:String(無該編號之項時之原因;未給為「回覆無 index k 之裁決」) }
 * @returns {String} 回傳原因
 * @example
 * console.log(benchVoteMissingOf([], 3, () => null), benchVoteMissingOf([{ index: 3, verdict: 'x' }], 3, () => null).startsWith('index 3 之裁決不合格'))
 * // => 回覆無 index 3 之裁決 true
 */
export function benchVoteMissingOf(raws, k, single, o = {}) {
    const list = isarr(raws) ? raws : []
    if (!list.length) return isestr(o?.empty) ? o.empty : `回覆無 index ${k} 之裁決`
    if (list.some((x) => single(x) !== null)) return `同編號 ${k} 之裁決互相矛盾（同正式規則作廢為缺票）`
    return `index ${k} 之裁決不合格（同正式之單票驗證，缺票）：${oneline(JSON.stringify(list[0]), 100)}`
}

/**
 * 角色參數之正整數(opt.roleOpt 之值;未給回預設、給了不合即拋——分頁於任何呼叫之前組,錯了不燒額度)
 *
 * @param {*} v 輸入值
 * @param {Integer} dflt 輸入預設值
 * @param {String} key 輸入參數名(錯誤訊息用)
 * @returns {Integer} 回傳正整數
 * @throws {Error} 給了而非正整數時拋出(「roleOpt.<key> 須為正整數，收到 …」)
 * @example
 * console.log(benchPintOf(undefined, 3, 'batch'), benchPintOf(5, 3, 'batch'))
 * // => 3 5
 *
 * try { benchPintOf(0, 3, 'batch') } catch (e) { console.log(e.message) }
 * // => roleOpt.batch 須為正整數，收到 0
 */
export function benchPintOf(v, dflt, key) {
    if (v === undefined || v === null) return dflt
    if (!Number.isInteger(v) || v <= 0) throw new Error(`roleOpt.${key} 須為正整數，收到 ${JSON.stringify(v)}`)
    return v
}

/**
 * 角色擴充之命令列選項:每頁案數(--batch;值之解析取 benchArgPint)
 *
 * @param {Integer} dflt 輸入預設值
 * @param {String} what 輸入預設值之出處(說明用)
 * @returns {Object} 回傳 cli.options 之一項 { flag:'--batch', key:'batch', arg:'<n>', help, parse }，parse 為 benchArgPint
 * @example
 * let opt = batchOption(5, '正式管線之每批數')
 * console.log(opt.flag, opt.key, opt.help, opt.parse('8', '--batch'))
 * // => --batch batch 每頁案數(預設 5＝正式管線之每批數) 8
 */
export const batchOption = (dflt, what) => ({ flag: '--batch', key: 'batch', arg: '<n>', help: `每頁案數(預設 ${dflt}＝${what})`, parse: benchArgPint })

// ════════════════ 命令列(角色之 bench/cli.mjs …;亦可程式呼叫 runBenchCli) ════════════════

/**
 * 命令列之正整數參數(角色擴充之選項亦可用之)
 *
 * @param {String} v 輸入參數值
 * @param {String} flag 輸入選項名(錯誤訊息用)
 * @returns {Integer} 回傳正整數
 * @throws {Error} 非正整數時拋出
 * @example
 * console.log(benchArgPint('20', '--page-size'))
 * // => 20
 */
export function benchArgPint(v, flag) {
    const n = Number(v)
    if (!/^\d+$/.test(String(v)) || !Number.isInteger(n) || n <= 0) throw new Error(`${flag} 須為正整數，收到「${v}」`)
    return n
}

/**
 * 命令列之時區參數:須為可用之 IANA 時區(無效者於第一次取時刻才拋,故當場取一次)
 *
 * @param {String} v 輸入參數值
 * @returns {String} 回傳時區字串
 * @throws {Error} 無效時區時拋出
 */
function cliTimeZone(v) {
    try {
        genClockTZ(v).iso8()
    }
    catch (e) {
        throw new Error(`--tz 須為 IANA 時區（如 Asia/Taipei、UTC），收到「${v}」：${oneline(e?.message, 120)}`)
    }
    return v
}

/**
 * 命令列用法說明(共用選項＋角色擴充之選項)
 *
 * @param {Object} role 輸入角色(defineBenchRole 之產物或定義)
 * @returns {String} 回傳用法說明(多行字串：首行為用法，其後為各選項一行)
 * @example
 * let role = defineBenchRole({
 *     id: 'topic',
 *     name: '題目分類(topic)',
 *     expectOf: (c) => c.expect.label,
 *     domainOf: () => ({}),
 *     promptOf: (cases) => cases.map((c, i) => `${i + 1}. ${c.input.text}`).join('；'),
 *     verdictOf: (data) => ({ cls: data?.label ?? null, valid: true, problem: '', fields: {} }),
 *     cli: { options: [batchOption(1, '一案一頁')] },
 * })
 * let lines = benchUsageOf(role).split('\n')
 * console.log(lines[3])
 * // =>   --runs         每案呼叫回數(預設 2;逐案各回皆＝應然才計通過)
 * console.log(lines[lines.length - 1])
 * // =>   --batch        每頁案數(預設 1＝一案一頁)
 */
export function benchUsageOf(role) {
    role = defineBenchRole(role)
    const opts = role.cli.options
    const line = (flag, text) => `  ${flag.padEnd(Math.max(15, flag.length + 2))}${text}`
    return [
        `用法：${role.cli.command} [--models <id,…>|free] [--cases <題組 json>] [--runs 2] [--out <目錄>] [--env <金鑰檔>] [--timeout <毫秒>] [--concurrency <n>] [--tz <IANA 時區>] [--board <評比表 csv>] [--vocab <詞彙 json>]${opts.map((o) => ` [${o.flag} ${o.arg}]`).join('')}`,
        line('--models', `受測之調度層條目 id(逗號分隔);未給或 free＝${role.models.join(',')}`),
        line('--cases', role.cli.casesHelp),
        line('--runs', '每案呼叫回數(預設 2;逐案各回皆＝應然才計通過)'),
        line('--out', '報表目錄(預設 ./bench-out;相對路徑以 cwd 解析)'),
        line('--env', '金鑰檔(.env 格式,REST 條目之金鑰);未給時 cwd 有 .env 即讀之,否則讀 process.env'),
        line('--timeout', '單回逾時毫秒數(未給沿用調度層預設)'),
        line('--concurrency', '同時受測之模型數(預設 2)'),
        line('--tz', '時區(評分時間與報表檔名之時間戳;預設 Asia/Taipei)'),
        line('--board', '評比表(累積之 csv;一角色一模型一列,本次覆蓋同模型之舊列;停測者不寫);未給不寫'),
        line('--vocab', '詞彙覆寫(JSON 物件檔;交角色之 domainOf 建 domain,提示詞與正式管線同源);未給用預設詞彙;案自帶詞彙者仍以之建該案之 domain'),
        ...opts.map((o) => line(o.flag, o.help)),
    ].join('\n')
}

/**
 * 解析命令列參數(不認得之選項、缺值、重複、值不合一律拋錯——打錯之選項若靜默略過,跑出來的是另一份設定之評分)
 *
 * @param {Array} argv 輸入參數陣列(不含 node 與腳本路徑)；支援「--鍵 值」與「--鍵=值」
 * @param {Object} role 輸入角色(defineBenchRole 之產物或定義;取 models 與 cli.options)
 * @returns {Object} 回傳 { help, models:Array, cases:String(絕對路徑;空字串＝內建題組), runs, out(絕對路徑), env:String(絕對路徑;空字串＝未給),
 *   timeoutMs:Integer|null, concurrency, timeZone:String(預設 'Asia/Taipei'), board:String(絕對路徑;空字串＝不寫評比表),
 *   vocab:String(絕對路徑;空字串＝未給)，及角色擴充之選項(有給者以其 key 列出解析值) }
 * @throws {Error} 選項不認得、缺值、重複或值不合時拋出
 * @example
 * let role = defineBenchRole({
 *     id: 'topic',
 *     name: '題目分類(topic)',
 *     expectOf: (c) => c.expect.label,
 *     domainOf: () => ({}),
 *     promptOf: (cases) => cases.map((c, i) => `${i + 1}. ${c.input.text}`).join('；'),
 *     verdictOf: (data) => ({ cls: data?.label ?? null, valid: true, problem: '', fields: {} }),
 * })
 * let a = parseBenchArgs(['--models', 'a,b', '--runs=3'], role)
 * console.log(a.models, a.runs, a.concurrency, a.timeZone)
 * // => [ 'a', 'b' ] 3 2 Asia/Taipei
 *
 * try { parseBenchArgs(['--run', '3'], role) } catch (e) { console.log(e.message) }
 * // => 不認得之參數：--run
 */
export function parseBenchArgs(argv, role) {
    role = defineBenchRole(role)
    const extra = new Map(role.cli.options.map((o) => [o.flag, o]))
    const got = {}
    const list = isarr(argv) ? argv.map(String) : []
    let help = false
    for (let i = 0; i < list.length; i++) {
        const a = list[i]
        if (a === '--help' || a === '-h') {
            help = true
            continue
        }
        const eq = a.indexOf('=')
        const inline = a.startsWith('--') && eq > 0
        const name = inline ? a.slice(0, eq) : a
        const key = BASE_CLI_OPTS[name] || extra.get(name)?.key
        if (!key) throw new Error(`不認得之參數：${a}`)
        let v
        if (inline) v = a.slice(eq + 1)
        else {
            v = list[i + 1]
            i++
        }
        if (v === undefined || v === '' || v.startsWith('--')) throw new Error(`${name} 缺值`)
        if (got[key] !== undefined) throw new Error(`${name} 重複給定`)
        got[key] = v
    }
    const models = got.models === undefined || got.models === 'free'
        ? [...role.models]
        : [...new Set(got.models.split(',').map((s) => s.trim()).filter(Boolean))]
    if (!models.length) throw new Error('--models 未列出任何條目 id')
    const out = {
        help,
        models,
        cases: got.cases === undefined ? '' : path.resolve(got.cases),
        runs: got.runs === undefined ? 2 : benchArgPint(got.runs, '--runs'),
        out: path.resolve(got.out === undefined ? 'bench-out' : got.out),
        env: got.env === undefined ? '' : path.resolve(got.env),
        timeoutMs: got.timeoutMs === undefined ? null : benchArgPint(got.timeoutMs, '--timeout'),
        concurrency: got.concurrency === undefined ? 2 : benchArgPint(got.concurrency, '--concurrency'),
        timeZone: got.timeZone === undefined ? 'Asia/Taipei' : cliTimeZone(got.timeZone),
        board: got.board === undefined ? '' : path.resolve(got.board),
        vocab: got.vocab === undefined ? '' : path.resolve(got.vocab),
    }
    for (const o of role.cli.options) {
        if (got[o.key] !== undefined) out[o.key] = o.parse(got[o.key], o.flag)
    }
    return out
}

/**
 * 讀 --vocab 之詞彙檔(單角色之命令列與多角色之命令列〔benchRoles〕共用;內容之規格交角色之 domainOf 驗)
 *
 * @param {String} file 輸入詞彙檔絕對路徑
 * @returns {Object} 回傳詞彙物件
 * @throws {Error} 檔案不存在、非 JSON 或非物件時拋出(訊息含檔案路徑)
 * @example
 * fs.mkdirSync('./bench-out', { recursive: true })
 * fs.writeFileSync('./bench-out/vocab.json', JSON.stringify({ domain: '天文學' }))
 * console.log(readBenchVocabFile(path.resolve('./bench-out/vocab.json')))
 * // => { domain: '天文學' }
 */
export function readBenchVocabFile(file) {
    if (!fs.existsSync(file)) throw new Error(`--vocab 指定之詞彙檔不存在：${file}`)
    let v
    try {
        v = JSON.parse(fs.readFileSync(file, 'utf8'))
    }
    catch (e) {
        throw new Error(`--vocab 詞彙檔讀取失敗（${file}）：${e.message}`)
    }
    if (!isobj(v)) throw new Error(`--vocab 詞彙檔須為 JSON 物件（${file}）`)
    return v
}

/**
 * 讀 --vocab 之詞彙檔並以角色之 domainOf 驗之(評分與建目錄之前)
 *
 * @param {Object} role 輸入角色
 * @param {String} file 輸入詞彙檔絕對路徑
 * @returns {Object} 回傳詞彙物件
 * @throws {Error} 檔案不存在、非 JSON、非物件或詞彙不合時拋出(訊息含檔案路徑)
 */
function readVocabFile(role, file) {
    const v = readBenchVocabFile(file)
    try {
        role.domainOf(v)
    }
    catch (e) {
        throw new Error(`--vocab 詞彙不合（${file}）：${e?.message || e}`)
    }
    return v
}

/**
 * 命令列主流程:解析參數 → 讀題組(與 --vocab 詞彙檔) → 建調度層(內建,金鑰見 --env;角色給了 call 者另開工作流入口 workflow:true) →
 * runBench(每回結果一完成即附寫逐回進度檔) → 寫報表 → (--board)併入評比表。逐回進度檔 <out>/<角色 id>-bench-<時間戳>.progress.jsonl:
 * 中途被終止也留得下已跑之結果;AI 子行程工作目錄 <out>/ai-workspace 結束後移除
 *
 * @param {Object} role 輸入角色(defineBenchRole 之產物或定義)
 * @param {Array} argv 輸入參數陣列(不含 node 與腳本路徑;選項見 benchUsageOf)
 * @param {Object} [inject={}] 輸入注入物件
 * @param {Object} [inject.aiAdapter] 輸入調度層，給了即不建內建調度層(亦不建 AI 工作目錄)
 * @param {Object} [inject.log] 輸入輸出物件 { info(msg), error(msg) }，預設 console
 * @returns {Promise} 回傳 Promise，resolve 回傳 { result, report:{ dir, files }, progressFile, board(未給 --board 為 null;否則 mergeBenchBoard 之回傳) }；
 *   --help 時回 { help:true }
 * @throws {Error} 參數不合、題組不合、--vocab 詞彙檔不存在或不合、--env 指定之金鑰檔不存在，或評分前之檢核失敗時拋出
 * @example
 * need test in nodejs.
 *
 * let r = await runBenchCli(role, ['--models', 'oc:opencode/mimo-v2.6-flash-free', '--cases', './my-cases.json', '--vocab', './my-vocab.json'])
 * console.log(r.report.files.md)
 */
export async function runBenchCli(role, argv, inject = {}) {
    role = defineBenchRole(role)
    if (!isobj(inject)) inject = {}
    const log = isobj(inject.log) && isfun(inject.log.info) ? inject.log : { info: (m) => console.log(m), error: (m) => console.error(m) }
    const args = parseBenchArgs(argv, role)
    if (args.help) {
        log.info(benchUsageOf(role))
        return { help: true }
    }
    const cases = loadBenchCases(role, args.cases || undefined)
    const vocab = args.vocab ? readVocabFile(role, args.vocab) : null
    let envFile = ''
    if (args.env) {
        if (!fs.existsSync(args.env)) throw new Error(`--env 指定之金鑰檔不存在：${args.env}`)
        envFile = args.env
    }
    else if (fs.existsSync(path.resolve('.env'))) envFile = path.resolve('.env')
    fs.mkdirSync(args.out, { recursive: true })
    const own = !isobj(inject.aiAdapter)
    const workspace = path.join(args.out, 'ai-workspace')
    // 角色之自訂呼叫(call)可經工作流入口(getWkf／seatSpec)呼叫,內建調度層即開之;未給 call 者照舊(檔頭【自訂呼叫】)
    const ai = own ? createAiAdapter({ ai: resolveSettings({}).ai, workspace, ...(envFile ? { envFile } : {}), ...(role.call ? { workflow: true } : {}) }) : inject.aiAdapter
    const stem = `${role.id}-bench`

    let progressFile = ''
    /**
     * 進度:逐回附寫進度檔並印一行
     *
     * @param {Object} ev 輸入 runBench 之進度事件
     * @returns {undefined} 無回傳值
     */
    const onProgress = (ev) => {
        if (ev.type === 'start') {
            progressFile = path.join(args.out, `${stem}-${ev.meta.stamp}.progress.jsonl`)
            log.info(`${role.title}：${ev.meta.models.length} 個模型 × ${ev.meta.cases} 案 × ${ev.meta.runs} 回（題組 ${ev.meta.std || '-'} v${ev.meta.v}，提示詞指紋 ${ev.meta.promptFp}${envFile ? `，金鑰檔 ${envFile}` : ''}${vocab ? `，詞彙 ${args.vocab}` : ''}）；逐回進度 ${progressFile}`)
            return
        }
        // 逐回進度為 append-only JSONL(core/util/jsonl 一份:檔尾半行先補換行,中途被砍不黏行)
        if (progressFile) appendJsonlRow(progressFile, { at: new Date().toISOString(), ...ev })
        if (ev.type === 'call') {
            const r = ev.record
            const what = r.callFail ? `失敗（${BENCH_FAIL_KINDS[r.failKind] || r.failKind}：${oneline(r.error, 100)}）` : (r.cls || `無裁決（${r.problem}）`)
            log.info(`  [${ev.model}] 第 ${r.run} 回 ${ev.caseId}：${what}${r.cls !== null ? textOf(role.detailOf, r) : ''}（${(r.ms / 1000).toFixed(1)}s）`)
        }
        else if (ev.type === 'model-stopped') log.info(`  [${ev.model}] ${ev.reason}`)
        else if (ev.type === 'model-done') {
            const s = ev.summary
            log.info(`  [${ev.model}] 完成：通過 ${s.score.pass}/${s.score.total}（一般 ${s.general.pass}/${s.general.total}、保留 ${s.holdout.pass}/${s.holdout.total}），合契約 ${s.contract.valid}/${s.contract.total}，呼叫失敗 ${s.calls.failed}${s.calls.notRun ? `，未呼叫 ${s.calls.notRun}` : ''}`)
        }
    }

    const roleOpt = Object.fromEntries(role.cli.options.filter((o) => args[o.key] !== undefined).map((o) => [o.key, args[o.key]]))
    let result
    try {
        result = await runBench(role, {
            models: args.models,
            cases,
            runs: args.runs,
            aiAdapter: ai,
            timeoutMs: args.timeoutMs ?? undefined,
            concurrency: args.concurrency,
            timeZone: args.timeZone,
            onProgress,
            ...(vocab ? { vocab } : {}),
            ...(Object.keys(roleOpt).length ? { roleOpt } : {}),
        })
    }
    finally {
        // AI 工作目錄只供本次子行程使用(內建調度層才建立),結束即移除
        if (own) {
            try {
                fs.rmSync(workspace, { recursive: true, force: true })
            }
            catch { /* 移除失敗不影響報表 */ }
        }
    }
    const report = writeBenchReport(result, args.out, { role, name: `${stem}-${result.meta.stamp}` })
    log.info(`報表：\n  ${[...Object.values(report.files), ...(progressFile ? [progressFile] : [])].join('\n  ')}`)
    // 評比表(--board):本次結果併入累積之總表;停測或未完整之模型不寫(report.mjs 檔頭)
    let board = null
    if (args.board) {
        board = mergeBenchBoard(args.board, result, { role, workspace: own ? workspace : '' })
        log.info(`評比表：${board.file}（寫入 ${board.written.length} 個模型${board.replaced.length ? `，其中覆蓋舊列 ${board.replaced.length}` : ''}${board.skipped.length ? `；未寫入（分數不完整）：${board.skipped.map((x) => `${x.model}（${x.reason}）`).join('、')}` : ''}）`)
    }
    return { result, report, progressFile, board }
}

export default runBench
