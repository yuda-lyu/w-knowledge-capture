// unit-assembly-kit.test.mjs — 總組裝共用件(core/assemblyKit)之契約:各檢核之訊息與判準、下游目錄、選開之集合、儲存之參數化、
//   AI 調度層之建構與事件日誌(當輪日誌之換入換出)、集合之開關、每輪之序列、info() 之共同欄
// 規則(出自 core/assemblyKit 檔頭):
//   ①只收值、不讀 cfg:各檢核之訊息為各總組裝共通之字樣(抓取之總組裝經之拋出,訊息逐字不變);子階段鍵、集合鍵、預設集合名、下游目錄以參數帶入;
//     管線名(pipelineNameOf):cfg.name 給了即取代內建名
//   ②選開之集合:false／未給不開、true 開(集合名取 lmdb.cls 或預設)、字串即集合名;與 cfg.lmdb.cls 不一致即拋——筆記與核心同一機制
//   ③當輪日誌:調度層之事件(健康／額度／能力)寫入當輪日誌——每輪開始換入、結束移除;輪外不記;並發之輪結束者只移除自己;
//     注入 cfg.aiAdapter 時不建、不接
//   ④每輪序列:建目錄 → 日誌 → 啟動期警告 → 開工標記 → 開集合 → 管線(鎖、時間預算) → 未取得鎖即回 → 符合度掃描(回呼) → run.json → 收尾鉤子 → 關集合;
//     掃描逾時間預算略過、失敗只留 warn;開工標記與執行摘要寫入失敗只留 warn;收尾失敗只留 warn(收尾附註附於失敗／略過之行);
//     開工標記之 limitMin＝本輪宣告之上限(core/runtime 之 limitMin);核心件之日誌字樣(logContract 之 CORE_LOG_*)皆命中真實發出者之行
//   ⑤info() 之共同欄:鍵序固定、各工作之專屬欄排在 domains 之後、路徑為絕對路徑
//   ⑥功能表之必填檢核:已開啟之功能所需之判定小組席位(同一小組共用、依 first／second／third 之序、一句列出需要所缺之席之開啟者)、
//     依功能而必填之 domain 成員(一句列出需要它之開啟者)、額外檢核;功能皆未開 → 無問題
//   ⑦提示詞覆寫(SIGS { params, returns? };cfg 層、執行期件、domain 工廠三層同一份驗證與訊息)、提示詞覆寫與注入 domain 之衝突、
//     domain 之注入與合併(選填成員、形狀檢核、建議之工廠)、cfg.data 之鍵集與只讀詞彙者之解析、交 resolveRuntime 之鍵
// 執行:自套件根 npx mocha test/unit-assembly-kit.test.mjs(暫存 test/_tmp/assembly-kit-<pid>,測完即刪;真 LMDB;調度層為替身工廠,
//   或為內建調度層而條目指向無人監聽之死埠 8830、opencode 日誌為本測試自寫之暫存檔——不連外網、不呼叫真實 AI)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import WOrmLmdb from 'w-orm-lmdb/src/WOrmLmdb.mjs'
import W from 'w-data-pipeline/src/WDataPipeline.mjs'
import {
    checkKeys, resolveDirsCfg, resolveClockCfg, resolvePromptsCfg, promptDomainConflicts, mergeDomains, checkDataKeys, resolveDataCfg,
    checkStageConfig, checkOptionalCollections, resolveLmdbCfg,
    resolveLogFactory, resolveAfterRun, checkAiAdapter, createRoundLog, aiEventLoggersOf, AI_OPTIONS_KEYS, buildAiAdapter, startupWarningsOf,
    featuresOnOf, featureProblemsOf, createStoreOpener, pipelineNameOf, createRoundRunner, assemblyInfoOf, DEPS_COMMON_KEYS,
} from '../src/core/assemblyKit.mjs'
import { promptSigText, promptSigsProblem, promptOverridesOf, promptTextOf, promptCtxOf, overridablePrompt, promptDomainOf, promptsForDomain } from '../src/core/prompts.mjs'
import { AREA_PROMPT_SIGS } from '../src/domain/areaDomain.mjs'
import { given } from '../src/core/util/values.mjs'
import { expandDirs } from '../src/core/dirs.mjs'
import { resolveRuntime, RUNTIME_CFG_KEYS, runtimeCfgOf } from '../src/core/runtime.mjs'
import { acquireLock } from '../src/core/runnerPackage.mjs'
import { stdReport } from '../src/core/kernel.mjs'
import { runSubStages } from '../src/captureObject.mjs'
import { createKnowledgeCapture } from '../src/createKnowledgeCapture.mjs'
import { netDownAtStart } from '../src/core/util/netGuard.mjs'
import { CORE_LOG_KNOWN, CORE_LOG_MUST_SEE, CAPTURE_LOG_KNOWN, CAPTURE_LOG_MUST_SEE } from '../src/logContract.mjs'
import { tmpRoot, noAiAdapter } from './tools/captureTestKit.mjs'
import { removeRoots, recLog, resetConceptFold, FIXED_CLOCK, sleep, readJsonFile, msgOf, findFiles } from './tools/testKit.mjs'

const MIN = 60_000
const DEAD_BASE = 'http://127.0.0.1:8830/v1' // 無人監聽之死埠:連線即被拒

/** 三種調度層事件之樣本(字樣與下游之總組裝逐字同;巡檢以之判讀) */
const EV = {
    health: { providerId: 'p:a', streak: 3, errorType: 'validation', error: 'x' },
    healthKeys: { providerId: 'agnes:agnes-3.0-flash', streak: 3, errorType: 'http', error: 'HTTP 401', keys: 2 },
    oversize: { providerId: 'agy:x', limit: 30000, promptLen: 41000 },
    pool: { providerId: 'oc:opencode/m', model: 'opencode/m', first: Date.UTC(2026, 0, 2, 1, 5), last: Date.UTC(2026, 0, 2, 2, 30), n: 4, resetUtcHour: 0 },
}
const LINE = {
    health: 'WARN 供應商健康：p:a 連續 3 次 validation 失敗（x），降序冷卻',
    healthKeys: 'WARN 供應商健康：agnes:agnes-3.0-flash 連續 3 次 http 失敗（每次 2 把金鑰皆敗）（HTTP 401），降序冷卻',
    oversize: 'WARN 供應商能力：agy:x 之 prompt 上限 30000 字元，本輪有呼叫達 41000 字元而改由遞補承接（未 spawn）',
    pool: 'WARN 供應商額度：oc:opencode/m 自 09:05 起 opencode 日誌回報當日額度用盡（4 筆，最近 10:30），本輪呼叫前降至鏈尾、照設定遞補，至每日重置（UTC 0 時）止',
}

describe('unit-assembly-kit', function() {

    this.timeout(120_000)

    let root = ''
    before(() => {
        root = tmpRoot('assembly-kit')
    })
    after(() => {
        resetConceptFold() // 經總組裝之案例會設定模組級之概念折疊,不留給同 worker 之他檔
        removeRoots([root])
    })

    let seq = 0
    const dirOf = (name = 'k') => `${root}/${name}-${++seq}`

    describe('檢核件(訊息逐字;各總組裝經之拋出)', function() {

        it('given:undefined／null 為未給,其餘(含 0、false、空字串)為給了;checkKeys:不認得之鍵拋錯並列出可用鍵,全在可用鍵內不拋,非物件不檢', () => {
            assert.deepEqual([undefined, null, 0, false, '', {}].map(given), [false, false, true, true, true, true])
            assert.equal(msgOf(() => checkKeys({ db: 1, dbb: 2, x: 3 }, ['db', 'log'], 'cfg.dirs')), 'cfg.dirs 含不認得之鍵：dbb、x（可用：db、log）')
            assert.equal(msgOf(() => checkKeys({ db: 1 }, ['db', 'log'], 'cfg.dirs')), null)
            for (const v of [undefined, null, 'x', 5, []]) assert.equal(msgOf(() => checkKeys(v, ['db'], 'cfg.x')), null, `${JSON.stringify(v)} 不檢`)
        })

        it('pipelineNameOf:undefined／null 用內建名,非空字串取代之;其餘(空字串、非字串)拋錯點名 cfg.name;內建名非非空字串為呼叫端錯誤', () => {
            assert.deepEqual([undefined, null].map((v) => pipelineNameOf(v, '知識抓取')), ['知識抓取', '知識抓取'])
            assert.equal(pipelineNameOf('夜間抓取', '知識抓取'), '夜間抓取')
            for (const bad of ['', 5, {}, [], true, false, 0]) assert.equal(msgOf(() => pipelineNameOf(bad, '知識抓取')), 'cfg.name 須為非空字串（管線名；未給用內建名）', JSON.stringify(bad))
            for (const bad of ['', undefined, 5]) assert.equal(msgOf(() => pipelineNameOf('x', bad)), 'pipelineNameOf 需要 builtin（內建管線名）', JSON.stringify(bad))
        })

        it('resolveDirsCfg:未給即 expandDirs;extra 宣告之下游目錄展開於 workDir 下、cfg.dirs 可覆寫之;未宣告者被拒(可用鍵含 extra);值須為非空字串;下游目錄不隨 knowledge 之覆寫移動;extra 不得重定基本目錄', () => {
            const wd = 'c:/kb'
            const ex = { notes: 'knowledge/notes' }
            assert.deepEqual(resolveDirsCfg(wd), expandDirs(wd))
            assert.deepEqual(resolveDirsCfg(wd, undefined, ex), { ...expandDirs(wd), notes: 'c:/kb/knowledge/notes' })
            assert.equal(resolveDirsCfg(wd, { notes: 'd:/vault/notes' }, ex).notes, 'd:/vault/notes', 'cfg.dirs.notes 被接受並覆寫')
            assert.equal(msgOf(() => resolveDirsCfg(wd, { notes: 'x' })), 'cfg.dirs 含不認得之鍵：notes（可用：db、log、tmp、state、knowledge）', '未宣告 extra 者不認得 notes')
            assert.equal(msgOf(() => resolveDirsCfg(wd, { zzz: 'x' }, ex)), 'cfg.dirs 含不認得之鍵：zzz（可用：db、log、tmp、state、knowledge、notes）')
            for (const bad of [5, '', {}, [], false, 0]) assert.equal(msgOf(() => resolveDirsCfg(wd, { notes: bad }, ex)), 'cfg.dirs.notes 須為非空路徑字串', JSON.stringify(bad))
            for (const bad of ['x', 5, []]) assert.equal(msgOf(() => resolveDirsCfg(wd, bad, ex)), 'cfg.dirs 須為物件 { 目錄鍵: 路徑 }', JSON.stringify(bad))
            const moved = resolveDirsCfg(wd, { knowledge: 'd:/vault/k' }, ex)
            assert.deepEqual([moved.knowledge, moved.notes], ['d:/vault/k', 'c:/kb/knowledge/notes'], '下游目錄相對 workDir,不隨 knowledge 移動')
            assert.match(msgOf(() => resolveDirsCfg(wd, undefined, { db: 'x' })), /expandDirs 之 extra 不可重定基本目錄：db/)
        })

        it('resolveClockCfg:給了時鐘即原樣;未給依時區建立(預設 Asia/Taipei)並於建構期試取;時鐘缺函數、時區非字串或無效即拋(訊息逐字);給了時鐘仍驗時區之型別、不試取', () => {
            assert.equal(resolveClockCfg(FIXED_CLOCK), FIXED_CLOCK)
            assert.equal(resolveClockCfg(undefined).timeZone, 'Asia/Taipei')
            assert.match(resolveClockCfg(null, 'UTC').iso8(), /\+00:00$/)
            for (const bad of [{}, 'x', 5, { iso8: () => '', stamp8: () => '' }]) {
                assert.equal(msgOf(() => resolveClockCfg(bad)), 'cfg.clock 須為時鐘物件（wsemi 之 genClockTZ 產物：iso8／stamp8／date8…）', JSON.stringify(bad))
            }
            for (const bad of [5, '', {}, []]) assert.equal(msgOf(() => resolveClockCfg(undefined, bad)), 'cfg.timeZone 須為 IANA 時區字串（如 Asia/Taipei）', JSON.stringify(bad))
            assert.equal(msgOf(() => resolveClockCfg(FIXED_CLOCK, 5)), 'cfg.timeZone 須為 IANA 時區字串（如 Asia/Taipei）')
            assert.match(msgOf(() => resolveClockCfg(undefined, 'Nowhere/City')), /^cfg\.timeZone 無效（Nowhere\/City）：/)
            assert.equal(msgOf(() => resolveClockCfg(FIXED_CLOCK, 'Nowhere/City')), null, '給了時鐘即不依時區建立')
        })

        it('resolvePromptsCfg:鍵與函數形式參數化(SIGS { params, returns? },returns 預設「提示詞字串」);未給回 {};非物件、不認得之鍵、非函數即拋(訊息列出各鍵與形式);只回有給之鍵;SIGS 形狀錯即拋', () => {
            const sigs = { triage: { params: '(docs, ctx)' }, summarize: { params: '(docs, budgets, ctx)' }, rules: { params: '(defaultRules, ctx)', returns: '規則陣列' } }
            for (const v of [undefined, null]) assert.deepEqual(resolvePromptsCfg(v, sigs), {})
            for (const bad of ['x', 5, []]) assert.equal(msgOf(() => resolvePromptsCfg(bad, sigs)), 'cfg.prompts 須為物件 { triage?, summarize?, rules? }', JSON.stringify(bad))
            assert.equal(msgOf(() => resolvePromptsCfg({ zzz: () => '' }, sigs)), 'cfg.prompts 含不認得之鍵：zzz（可用：triage、summarize、rules）')
            for (const bad of ['x', 5, {}, [], false, 0]) assert.equal(msgOf(() => resolvePromptsCfg({ summarize: bad }, sigs)), 'cfg.prompts.summarize 須為函數 (docs, budgets, ctx) => 提示詞字串', JSON.stringify(bad))
            assert.equal(msgOf(() => resolvePromptsCfg({ rules: 'x' }, sigs)), 'cfg.prompts.rules 須為函數 (defaultRules, ctx) => 規則陣列', 'returns 給了即用之')
            const f = () => 'p'
            const out = resolvePromptsCfg({ triage: f, summarize: null }, sigs)
            assert.deepEqual(Object.keys(out), ['triage'])
            assert.equal(out.triage, f)
            assert.equal(msgOf(() => resolvePromptsCfg({ area: 'x' }, AREA_PROMPT_SIGS)), 'cfg.prompts.area 須為函數 (candidates, areas, ctx) => 提示詞字串', '抓取之訊息')
            for (const bad of [undefined, {}, 'x', { a: '(x, ctx)' }, { a: { params: '' } }, { a: { params: '(x)', returns: 5 } }]) assert.match(msgOf(() => resolvePromptsCfg({}, bad)), /^resolvePromptsCfg 需要 sigs/, JSON.stringify(bad))
        })

        it('提示詞覆寫之驗證(core/prompts;domain 工廠與執行期件之 opt.prompts):promptOverridesOf 回全部鍵(未給為 null)、訊息與 cfg 層同形;promptTextOf 須非空字串;promptSigText', () => {
            const sigs = { a: { params: '(x, ctx)' }, b: { params: '(y, ctx)', returns: '規則物件或 null' } }
            const f = () => 'p'
            assert.deepEqual([promptOverridesOf(undefined, sigs, 'F'), promptOverridesOf(null, sigs, 'F')], [{ a: null, b: null }, { a: null, b: null }])
            assert.deepEqual(promptOverridesOf({ a: f, b: null }, sigs, 'F'), { a: f, b: null })
            assert.equal(msgOf(() => promptOverridesOf('x', sigs, 'F')), 'F 之 opt.prompts 須為物件 { a, b }（各為覆寫提示詞之函數）')
            assert.equal(msgOf(() => promptOverridesOf({ z: f }, sigs, 'F')), 'F 之 opt.prompts 含不認得之鍵：z（可用：a、b）')
            assert.equal(msgOf(() => promptOverridesOf({ a: 'x' }, sigs, 'F')), 'F 之 opt.prompts.a 須為函數 (x, ctx) => 提示詞字串')
            assert.equal(msgOf(() => promptOverridesOf({ b: 1 }, sigs, 'F')), 'F 之 opt.prompts.b 須為函數 (y, ctx) => 規則物件或 null')
            assert.match(msgOf(() => promptOverridesOf({}, { a: '(x)' }, 'F')), /^promptOverridesOf 需要 sigs/)
            assert.equal(promptTextOf('提示詞', 'k'), '提示詞')
            for (const bad of [' \n ', '', 5, null, undefined]) assert.equal(msgOf(() => promptTextOf(bad, 'k')), 'opt.prompts.k 須回傳非空字串', JSON.stringify(bad))
            assert.deepEqual([promptSigText({ params: '(a)' }), promptSigText({ params: '(a)', returns: 'r' })], ['(a) => 提示詞字串', '(a) => r'])
            assert.deepEqual([promptSigsProblem(sigs), promptSigsProblem({})], ['', '須為非空物件 { 鍵: { params, returns? } }'])
        })

        it('覆寫之套用一份(core/prompts 檔頭):promptCtxOf 之 ctx 形狀;overridablePrompt 未覆寫即內建本身、覆寫者收正規化之原參數＋ctx 且回傳經 check(預設須非空字串);promptDomainOf 由各 domain 之 SIGS 推導歸屬(鍵屬兩 domain 即拋);promptsForDomain 只取該 domain 給了之覆寫', () => {
            // 規則:prompts.promptCtxOf／overridablePrompt／promptDomainOf／promptsForDomain——各 domain 檔與執行期件不各寫一份
            const vocab = { domain: '天文學', relationTypes: ['a'] }
            const builtin = (x) => `p:${x}`
            assert.deepEqual(promptCtxOf(vocab, '「天文學」知識庫', builtin), { kbLabel: '「天文學」知識庫', domain: '天文學', vocab, defaultPrompt: builtin })
            const ctxOf = (b) => promptCtxOf(vocab, 'kb', b)
            assert.equal(overridablePrompt({ a: null }, 'a', builtin, { ctxOf }), builtin, '未覆寫即內建函數本身')
            assert.equal(overridablePrompt(null, 'a', builtin), builtin)
            const seen = []
            const f = overridablePrompt({ a: (x, y, ctx) => (seen.push([x, y, ctx.kbLabel, ctx.defaultPrompt === builtin]), `${ctx.defaultPrompt(x)}+${y}`) }, 'a', builtin, { ctxOf, norm: (x, y) => [Array.isArray(x) ? x : [], y === undefined ? 0 : y] })
            assert.deepEqual([f('v'), f(['w'], 2), seen], ['p:+0', 'p:w+2', [[[], 0, 'kb', true], [['w'], 2, 'kb', true]]], '覆寫者收正規化之原參數＋ctx')
            assert.equal(msgOf(() => overridablePrompt({ a: () => '' }, 'a', builtin)('v')), 'opt.prompts.a 須回傳非空字串', '預設 check 為 promptTextOf')
            assert.deepEqual(overridablePrompt({ b: () => null }, 'b', () => ({}), { check: (v, k) => (v === null ? null : `${k}!`) })(), null, '自訂 check')
            assert.match(msgOf(() => overridablePrompt({}, 'a', 'x')), /需要內建函數（a）/)
            const ownerOf = promptDomainOf({ triage: { triage: { params: '(docs, ctx)' } }, summarize: { summarize: { params: '(docs, ctx)' }, faith: { params: '(input, ctx)' } } })
            assert.deepEqual(ownerOf, { triage: 'triage', summarize: 'summarize', faith: 'summarize' })
            assert.ok(Object.isFrozen(ownerOf))
            assert.match(msgOf(() => promptDomainOf({ a: { k: {} }, b: { k: {} } })), /提示詞之鍵 k 同時屬 a 與 b/)
            assert.match(msgOf(() => promptDomainOf(null)), /需要 \{ domain 之鍵: SIGS \}/)
            const g = () => 'p'
            assert.deepEqual(promptsForDomain({ triage: g, summarize: null, faith: g }, ownerOf, 'summarize'), { faith: g })
            assert.deepEqual([promptsForDomain({ triage: g }, ownerOf, 'summarize'), promptsForDomain(null, ownerOf, 'triage'), promptsForDomain({ triage: g }, null, 'triage')], [{}, {}, {}])
        })

        it('promptDomainConflicts:同一 domain 同給提示詞覆寫與整組 domain → 一句(依提示詞之鍵序);未給之覆寫、未注入之 domain、非物件 → 無', () => {
            const owner = { summarize: 'summarize', faith: 'summarize', triage: 'triage' }
            const f = () => 'p'
            const msg = (p, o) => `cfg.prompts.${p} 與 cfg.domains.${o} 擇一：注入之 domain 整組置換內建者，提示詞覆寫對它不生效（要以內建者改提示詞，請只給 cfg.prompts；要整組置換，請把提示詞寫進注入之 domain）`
            assert.deepEqual(promptDomainConflicts({ summarize: f, faith: f, triage: f }, { summarize: {} }, owner), [msg('summarize', 'summarize'), msg('faith', 'summarize')])
            assert.deepEqual(promptDomainConflicts({ summarize: null, triage: f }, { summarize: {}, triage: null }, owner), [], '未給之覆寫、注入為 null 者不衝突')
            assert.deepEqual([promptDomainConflicts(null, { a: {} }, owner), promptDomainConflicts({ a: f }, 'x', owner)], [[], []])
        })

        it('mergeDomains:未給回內建;非物件、不認得之鍵(checkKeys 之格式)、某項非物件、缺成員(選填者除外;函數須為函數、資料不可為 undefined)、check 之問題即拋(訊息附建議之工廠);給了者整組置換', () => {
            const builtin = { a: { build: () => 'p', vocab: {}, opt1: () => '' }, b: { build: () => 'q' } }
            const o = { optional: { a: ['opt1'] }, factories: { a: 'createA()' }, check: (k, d) => (d.vocab === 'bad' ? ['vocab 須為物件'] : []) }
            assert.equal(mergeDomains(builtin, undefined, o), builtin)
            assert.equal(mergeDomains(builtin, null, o), builtin)
            const inj = { build: () => 'x', vocab: {} }
            const out = mergeDomains(builtin, { a: inj, b: null }, o)
            assert.deepEqual([out.a === inj, out.b === builtin.b], [true, true], '選填成員可缺;null 沿用內建')
            assert.equal(msgOf(() => mergeDomains(builtin, 'x', o)), 'cfg.domains 須為物件 { a?, b? }')
            assert.equal(msgOf(() => mergeDomains(builtin, { zz: {} }, o)), 'cfg.domains 含不認得之鍵：zz（可用：a、b）')
            assert.equal(msgOf(() => mergeDomains(builtin, { a: 'x' }, o)), 'cfg.domains.a 須為 domain 物件')
            assert.equal(msgOf(() => mergeDomains(builtin, { a: { build: 'x' } }, o)), 'cfg.domains.a 缺成員「build、vocab」（須具備內建 domain 之全部成員；建議以 createA() 之產物展開後覆寫）')
            assert.equal(msgOf(() => mergeDomains(builtin, { a: { ...inj, vocab: 'bad' } }, o)), 'cfg.domains.a 不合：vocab 須為物件（建議以 createA() 之產物展開後覆寫）')
            assert.equal(msgOf(() => mergeDomains(builtin, { b: {} }, o)), 'cfg.domains.b 缺成員「build」（須具備內建 domain 之全部成員；建議以 內建 domain 之工廠 之產物展開後覆寫）', '未給工廠之稱呼')
        })

        it('checkDataKeys:物件才檢鍵集(checkKeys 之格式);resolveDataCfg:只讀詞彙覆寫之 cfg.data——未給回 { vocab:null }、非物件或 vocab 非物件即拋(訊息逐字)', () => {
            assert.equal(msgOf(() => checkDataKeys({ vocab: {}, x: 1 }, ['vocab'])), 'cfg.data 含不認得之鍵：x（可用：vocab）')
            for (const v of [undefined, null, 'x', 5]) assert.equal(msgOf(() => checkDataKeys(v, ['vocab'])), null, '非物件不檢(形狀由資料解析拋)')
            assert.deepEqual([resolveDataCfg(undefined), resolveDataCfg(null), resolveDataCfg({ vocab: { a: 1 } })], [{ vocab: null }, { vocab: null }, { vocab: { a: 1 } }])
            assert.equal(msgOf(() => resolveDataCfg('x', { keys: ['vocab'] })), 'cfg.data 須為物件 { vocab }')
            assert.equal(msgOf(() => resolveDataCfg({ vocab: 3 }, { vocabKeysOf: 'X 之 KEYS' })), 'cfg.data.vocab 須為物件（詞彙覆寫，鍵見 X 之 KEYS）')
            assert.equal(msgOf(() => resolveDataCfg({ vocab: 3 })), 'cfg.data.vocab 須為物件（詞彙覆寫）')
        })

        it('runtimeCfgOf:只取 RUNTIME_CFG_KEYS(resolveRuntime 所讀之鍵);交之與交整份 cfg 之解析結果相同', () => {
            assert.deepEqual(RUNTIME_CFG_KEYS, ['scheduleLimitMin', 'deadlineMs', 'lockStaleMs', 'lock', 'envFile', 'aiWorkspace', 'aiAdapter'])
            const cfg = { workDir: 'c:/kb', data: {}, scheduleLimitMin: 65, lock: 'c:/kb/x.lock', envFile: 'k.env', bogus: 1 }
            assert.deepEqual(Object.keys(runtimeCfgOf(cfg)), RUNTIME_CFG_KEYS)
            const ctx = { workDir: 'c:/kb', dirs: { tmp: 'c:/kb/tmp' } }
            assert.deepEqual(resolveRuntime(runtimeCfgOf(cfg), ctx), resolveRuntime(cfg, ctx))
            assert.deepEqual(runtimeCfgOf(null), Object.fromEntries(RUNTIME_CFG_KEYS.map((k) => [k, undefined])))
        })

        it('checkStageConfig:子階段鍵參數化(可用鍵與訊息取自參數);stages 與 stageOpts 之各錯誤訊息逐字;各自單給或皆未給不拋;stageKeys 缺即拋', () => {
            const keys = ['triage', 'summarize', 'retag', 'sync']
            for (const bad of ['x', 5, []]) assert.equal(msgOf(() => checkStageConfig(undefined, bad, keys)), 'cfg.stageOpts 須為物件 { triage, summarize, retag, sync }', JSON.stringify(bad))
            assert.equal(msgOf(() => checkStageConfig(undefined, { zzz: {} }, keys)), 'cfg.stageOpts 含不認得之鍵：zzz（可用：triage、summarize、retag、sync）')
            for (const bad of [5, 'x', [], false, 0]) assert.equal(msgOf(() => checkStageConfig(undefined, { retag: bad }, keys)), 'cfg.stageOpts.retag 須為物件（該子階段工廠之 opt）', JSON.stringify(bad))
            for (const bad of [[], 'x', 5, {}]) assert.equal(msgOf(() => checkStageConfig(bad, undefined, keys)), 'cfg.stages 須為非空陣列（子階段 { name, run(ctx) }）', JSON.stringify(bad))
            assert.equal(msgOf(() => checkStageConfig([{ name: 'a', run: () => {} }, { name: '' }], undefined, keys)), 'cfg.stages[1] 須為 { name: 非空字串, run(ctx) }')
            assert.equal(msgOf(() => checkStageConfig([{ name: 'a', run: () => {} }, { name: 'a', run: () => {} }], undefined, keys)), 'cfg.stages 有重複之子階段名：a')
            assert.equal(msgOf(() => checkStageConfig([{ name: 'a', run: () => {} }], {}, keys)), 'cfg.stages（整組自訂子階段）與 cfg.stageOpts（內建子階段之 opt）擇一：自組子階段請直接對各子階段工廠傳 opt')
            for (const [s, o] of [[undefined, undefined], [[{ name: 'a', run: () => {} }], undefined], [undefined, { triage: {}, sync: null }]]) assert.equal(msgOf(() => checkStageConfig(s, o, keys)), null)
            for (const bad of [undefined, [], 'x']) assert.match(msgOf(() => checkStageConfig(undefined, undefined, bad)), /^checkStageConfig 需要 stageKeys/)
        })

        it('checkOptionalCollections:筆記與核心同一機制——false／未給不開、true 或集合名開;其餘值即拋(訊息指名該鍵與稱呼);回傳開啟者(依鍵序);稱呼缺即以鍵代之', () => {
            for (const [key, label] of [['notes', '筆記'], ['cores', '核心']]) {
                for (const v of [false, undefined, null]) assert.deepEqual(checkOptionalCollections({ [key]: { value: v, label } }), [], `${key}=${v}`)
                for (const v of [true, 'myName']) assert.deepEqual(checkOptionalCollections({ [key]: { value: v, label } }), [key], `${key}=${v}`)
                for (const bad of [5, {}, [], 0, '']) {
                    assert.equal(msgOf(() => checkOptionalCollections({ [key]: { value: bad, label } })), `cfg.${key} 須為 false（預設，不開${label}集合）、true（開 ${key} 集合）或${label}集合名字串`, `${key}=${JSON.stringify(bad)}`)
                }
            }
            assert.equal(msgOf(() => checkOptionalCollections({ notes: { value: 5, label: '筆記' } })), 'cfg.notes 須為 false（預設，不開筆記集合）、true（開 notes 集合）或筆記集合名字串', '抓取之訊息逐字')
            assert.deepEqual(checkOptionalCollections({ cores: { value: 'c2' }, x: { value: false }, notes: { value: true } }), ['cores', 'notes'])
            assert.match(msgOf(() => checkOptionalCollections({ cores: { value: 5 } })), /^cfg\.cores 須為 false（預設，不開cores集合）/)
            assert.deepEqual(checkOptionalCollections(undefined), [])
            assert.match(msgOf(() => checkOptionalCollections('x')), /^checkOptionalCollections 需要/)
        })

        it('resolveLmdbCfg:集合鍵與預設名參數化;預設 WOrm 內建、path＝dirs.db、db＝knowledge、集合名即對外名(依鍵序);cfg.lmdb 之各錯誤訊息逐字;呼叫端參數錯誤即拋', () => {
            const dirs = { db: 'c:/kb/db' }
            const keys = ['docs', 'docTexts', 'frontier', 'notes', 'holds', 'cores']
            const def = resolveLmdbCfg(undefined, dirs, { keys })
            assert.deepEqual(Object.keys(def), ['WOrm', 'path', 'db', 'cls'])
            assert.deepEqual([def.WOrm === WOrmLmdb, def.path, def.db], [true, 'c:/kb/db', 'knowledge'])
            assert.deepEqual(def.cls, Object.fromEntries(keys.map((k) => [k, k])))
            assert.deepEqual(Object.keys(def.cls), keys, '鍵序同 keys')
            assert.equal(resolveLmdbCfg(undefined, dirs, { keys, defaults: { holds: 'myHolds' } }).cls.holds, 'myHolds', '預設集合名可參數化')
            const WOrm = () => ({})
            const c = resolveLmdbCfg({ WOrm, path: 'c:/x', db: 'mine', cls: { docs: 'd2' } }, dirs, { keys })
            assert.deepEqual([c.WOrm === WOrm, c.path, c.db, c.cls.docs, c.cls.notes], [true, 'c:/x', 'mine', 'd2', 'notes'])
            const lm = (l) => msgOf(() => resolveLmdbCfg(l, dirs, { keys }))
            for (const bad of ['x', 5, []]) assert.equal(lm(bad), 'cfg.lmdb 須為物件 { WOrm?, path?, db?, cls? }')
            assert.equal(lm({ zzz: 1 }), 'cfg.lmdb 含不認得之鍵：zzz（可用：WOrm、path、db、cls）')
            assert.equal(lm({ WOrm: {} }), 'cfg.lmdb.WOrm 須為 ORM 建構函數（w-orm-lmdb 之 WOrm 或相容實作）')
            for (const k of ['path', 'db']) for (const bad of [5, '', {}, []]) assert.equal(lm({ [k]: bad }), `cfg.lmdb.${k} 須為非空字串`)
            for (const bad of ['x', 5, []]) assert.equal(lm({ cls: bad }), 'cfg.lmdb.cls 須為物件 { 對外名: 集合名 }')
            assert.equal(lm({ cls: { zzz: 'x' } }), 'cfg.lmdb.cls 含不認得之鍵：zzz（可用：docs、docTexts、frontier、notes、holds、cores）')
            for (const bad of [5, '', {}, [], false, 0]) assert.equal(lm({ cls: { holds: bad } }), 'cfg.lmdb.cls.holds 須為非空字串（集合名）')
            // 呼叫端參數錯誤
            assert.match(msgOf(() => resolveLmdbCfg(undefined, dirs, {})), /^resolveLmdbCfg 需要 opt\.keys/)
            assert.match(msgOf(() => resolveLmdbCfg(undefined, {}, { keys })), /^resolveLmdbCfg 需要 dirs/)
            assert.equal(msgOf(() => resolveLmdbCfg(undefined, dirs, { keys: ['docs'], optional: { notes: { value: true } } })), 'resolveLmdbCfg 之 opt.optional 含 keys 以外之集合：notes')
            assert.equal(msgOf(() => resolveLmdbCfg(undefined, dirs, { keys: ['docs'], defaults: { notes: 'n' } })), 'resolveLmdbCfg 之 opt.defaults 含 keys 以外之集合：notes')
        })

        it('resolveLmdbCfg 之選開集合:字串即集合名;true 取 cls 或預設名;與 cfg.lmdb.cls 不一致即拋(筆記、核心同一訊息格式),一致者接受;值形狀不合即拋', () => {
            const dirs = { db: 'c:/kb/db' }
            const keys = ['docs', 'notes', 'cores']
            const opt = (notes, cores) => ({ keys, optional: { notes: { value: notes, label: '筆記' }, cores: { value: cores, label: '核心' } } })
            assert.deepEqual(resolveLmdbCfg(undefined, dirs, opt('n2', 'c2')).cls, { docs: 'docs', notes: 'n2', cores: 'c2' })
            assert.deepEqual(resolveLmdbCfg({ cls: { cores: 'cx' } }, dirs, opt(true, true)).cls, { docs: 'docs', notes: 'notes', cores: 'cx' })
            assert.deepEqual(resolveLmdbCfg({ cls: { cores: 'cx' } }, dirs, opt(false, 'cx')).cls.cores, 'cx', '兩處一致即接受')
            assert.equal(msgOf(() => resolveLmdbCfg({ cls: { notes: 'b' } }, dirs, opt('a', false))), 'cfg.notes（a）與 cfg.lmdb.cls.notes（b）不一致：筆記集合名擇一給', '抓取之訊息逐字')
            assert.equal(msgOf(() => resolveLmdbCfg({ cls: { cores: 'cx' } }, dirs, opt(false, 'c2'))), 'cfg.cores（c2）與 cfg.lmdb.cls.cores（cx）不一致：核心集合名擇一給')
            assert.match(msgOf(() => resolveLmdbCfg(undefined, dirs, opt(5, false))), /^cfg\.notes 須為 false（預設，不開筆記集合）/)
        })

        it('resolveLogFactory／resolveAfterRun／checkAiAdapter:形狀錯誤之訊息逐字;給了函數即原樣;未給之日誌工廠為預設(每輪一檔 <dir>/<日>/<時間戳>-run.log)且缺 dir／clock 即拋', () => {
            for (const bad of [5, 'x', {}, [], 0, false]) assert.equal(msgOf(() => resolveLogFactory(bad, { dir: 'x', clock: FIXED_CLOCK })), 'cfg.logFactory 須為函數 () => logger { info, warn, error }', JSON.stringify(bad))
            const f = () => recLog()
            assert.equal(resolveLogFactory(f), f)
            const dir = `${dirOf('lf')}/log`
            const mk = resolveLogFactory(undefined, { dir, clock: FIXED_CLOCK })
            const orig = console.log
            console.log = () => {} // 預設日誌同時輸出 stdout:測試中靜音
            try {
                mk().info('一行')
            }
            finally {
                console.log = orig
            }
            assert.match(fs.readFileSync(`${dir}/20260102/20260102030405-run.log`, 'utf8'), /^\[2026-01-02T03:04:05\+08:00\] INFO\s+一行$/m)
            for (const o of [undefined, {}, { dir }, { clock: FIXED_CLOCK }]) assert.match(msgOf(() => resolveLogFactory(undefined, o)), /^resolveLogFactory 之預設日誌工廠需要/)
            for (const v of [false, undefined, null]) assert.equal(resolveAfterRun(v), null)
            assert.equal(resolveAfterRun(f), f)
            for (const bad of [5, true, 'x', {}, [], 0]) assert.equal(msgOf(() => resolveAfterRun(bad)), 'cfg.afterRun 須為函數（收尾鉤子 ({ report, summaryFile, log, deps }) => 結果）或 false；本套件無內建巡檢', JSON.stringify(bad))
            for (const v of [undefined, null, { callJson: () => {} }]) assert.equal(msgOf(() => checkAiAdapter(v)), null)
            for (const bad of [{}, 5, 'x', [], false, 0]) assert.equal(msgOf(() => checkAiAdapter(bad)), 'cfg.aiAdapter 須為具 callJson(prompt, check, { spec }) 之物件', JSON.stringify(bad))
        })
    })

    describe('功能表之必填檢核(featuresOnOf／featureProblemsOf;各工作之單一判定)', function() {

        // 甲、乙共用 a.ai(甲只需 first、乙需 first／second);丙用 a.c.ai;丁無小組、有額外檢核
        const F = [
            { key: 'x', what: '甲(a.x.enabled)', on: (s) => s.a.x === true, panel: { path: 'a.ai', seats: ['first'] }, members: ['buildX', 'buildShared'] },
            { key: 'y', what: '乙(a.y.enabled)', on: (s) => s.a.y === true, panel: { path: 'a.ai', seats: ['first', 'second'] }, members: ['buildShared'] },
            { key: 'z', what: '丙(a.z.perRun > 0)', on: (s) => s.a.z > 0, panel: { path: 'a.c.ai', seats: ['first', 'second'] } },
            { key: 'w', what: '丁(a.w)', on: (s) => s.a.w === true, extra: (s, d, dl) => (d?.rules ? '' : `${dl}.rules 缺`) },
        ]
        const S = (a) => ({ a: { x: false, y: false, z: 0, w: false, ai: { first: null, second: null, third: null }, c: { ai: { first: null, second: null } }, ...a } })
        const seat = { use: 'p' }

        it('featuresOnOf:依表之序取已開啟者;o.enabled 給了即以之為準(不讀 on);表非陣列、項非物件略過', () => {
            assert.deepEqual(featuresOnOf(F, S({ y: true, x: true })).map((f) => f.key), ['x', 'y'])
            assert.deepEqual(featuresOnOf(F, S({ x: true }), { enabled: ['z'] }).map((f) => f.key), ['z'])
            assert.deepEqual(featuresOnOf(null, S({})), [])
            assert.deepEqual(featuresOnOf([null, 5, { key: 'q' }], S({})), [], '無 on 者不算開啟')
        })

        it('席位:同一小組之功能共用一組,所缺之席依 first／second／third 之序,一句列出需要所缺之席之開啟者(只開甲 → 只需 first);功能皆未開 → 無問題', () => {
            const d = { buildX: () => {}, buildShared: () => {}, rules: [] }
            assert.deepEqual(featureProblemsOf(F, S({}), {}), [], '皆未開:不檢席位與成員')
            assert.deepEqual(featureProblemsOf(F, S({ x: true }), d), ['甲(a.x.enabled)已啟用,但缺席位 settings.a.ai.first'])
            assert.deepEqual(featureProblemsOf(F, S({ x: true, ai: { first: seat } }), d), [], '只開甲:second 不必填')
            assert.deepEqual(featureProblemsOf(F, S({ x: true, y: true, ai: { first: seat } }), d), ['乙(a.y.enabled)已啟用,但缺席位 settings.a.ai.second'], '乙需 second:只列乙')
            assert.deepEqual(featureProblemsOf(F, S({ x: true, y: true }), d), ['甲(a.x.enabled)、乙(a.y.enabled)已啟用,但缺席位 settings.a.ai.first、settings.a.ai.second'])
            assert.deepEqual(featureProblemsOf(F, S({ y: true, z: 2 }), d), ['乙(a.y.enabled)已啟用,但缺席位 settings.a.ai.first、settings.a.ai.second', '丙(a.z.perRun > 0)已啟用,但缺席位 settings.a.c.ai.first、settings.a.c.ai.second'], '各小組各一句,依首次出現之序')
        })

        it('成員:依功能表中首次出現之序,一句列出需要它之開啟者;domain 非物件視為缺全部;額外檢核以「已啟用,但 …」列出;o.enabled 覆寫設定之開關', () => {
            const full = { ai: { first: seat, second: seat } }
            assert.deepEqual(featureProblemsOf(F, S({ x: true, y: true, ...full }), { buildX: () => {} }), ['甲(a.x.enabled)、乙(a.y.enabled)已啟用,但 domain 缺 buildShared'])
            assert.deepEqual(featureProblemsOf(F, S({ x: true, y: true, ...full }), null), ['甲(a.x.enabled)已啟用,但 domain 缺 buildX', '甲(a.x.enabled)、乙(a.y.enabled)已啟用,但 domain 缺 buildShared'])
            assert.deepEqual(featureProblemsOf(F, S({ w: true }), {}), ['丁(a.w)已啟用,但 domain.rules 缺'])
            assert.deepEqual(featureProblemsOf(F, S({ w: true }), { rules: [] }), [])
            assert.deepEqual(featureProblemsOf(F, S({ x: true }), { buildX: () => {}, buildShared: () => {} }, { enabled: ['z'] }), ['丙(a.z.perRun > 0)已啟用,但缺席位 settings.a.c.ai.first、settings.a.c.ai.second'], '子階段之選項覆寫:只檢所給之功能')
            assert.deepEqual(featureProblemsOf(F, S({ x: true }), {}, { enabled: [] }), [])
            assert.deepEqual(featureProblemsOf(F, S({ x: true, ai: { first: seat } }), { buildX: () => {} }, { domainLabel: 'cfg.domains.a' }), ['甲(a.x.enabled)已啟用,但 cfg.domains.a 缺 buildShared'], 'domainLabel:訊息中 domain 之稱呼')
            assert.deepEqual(featureProblemsOf(F, S({ w: true }), {}, { domainLabel: 'cfg.domains.a' }), ['丁(a.w)已啟用,但 cfg.domains.a.rules 缺'], '額外檢核收同一稱呼(與成員之訊息一致)')
        })
    })

    describe('AI 調度層與事件日誌(當輪日誌)', function() {

        it('createRoundLog:寫入送往最近進入且尚未離開之日誌;離開者移除自己(後入者先離開時,先入者恢復為當輪);離開未進入者不影響;無進行中者不記不拋', () => {
            const rl = createRoundLog()
            const a = recLog()
            const b = recLog()
            rl.warn('無人')
            assert.equal(rl.current(), null)
            rl.enter(a)
            rl.warn('一')
            rl.enter(b)
            rl.warn('二')
            rl.leave(b)
            rl.warn('三')
            rl.leave(recLog())
            rl.warn('四')
            rl.enter(b)
            rl.leave(a)
            rl.warn('五')
            rl.leave(b)
            rl.warn('六')
            assert.deepEqual([a.lines, b.lines], [['WARN 一', 'WARN 三', 'WARN 四'], ['WARN 二', 'WARN 五']])
            assert.equal(rl.current(), null)
        })

        it('aiEventLoggersOf:三種事件之 WARN 字樣逐字(健康含／不含金鑰數、能力、額度);額度之時刻依時鐘之時區(非有限數或時區無效為 ?);回呼不拋錯', () => {
            const rl = createRoundLog()
            const log = recLog()
            rl.enter(log)
            const h = aiEventLoggersOf(rl, FIXED_CLOCK)
            assert.deepEqual(Object.keys(h).sort(), ['onHealth', 'onOversize', 'onPool'])
            h.onHealth(EV.health)
            h.onHealth(EV.healthKeys)
            h.onOversize(EV.oversize)
            h.onPool(EV.pool)
            assert.deepEqual(log.lines, [LINE.health, LINE.healthKeys, LINE.oversize, LINE.pool])
            const utc = recLog()
            aiEventLoggersOf({ warn: (m) => utc.warn(m) }, { timeZone: 'UTC' }).onPool(EV.pool)
            assert.match(utc.lines[0], /自 01:05 起 .*最近 02:30）/)
            const odd = recLog()
            aiEventLoggersOf({ warn: (m) => odd.warn(m) }, { timeZone: 'Fixed/Test' }).onPool({ ...EV.pool, first: NaN })
            assert.match(odd.lines[0], /^WARN 供應商額度：oc:opencode\/m 自 \? 起 .*最近 \?）/, '時區無效或時刻非有限數為 ?')
            const thrower = aiEventLoggersOf({ warn: () => {
                throw new Error('日誌壞了')
            } }, FIXED_CLOCK)
            for (const k of ['onHealth', 'onOversize', 'onPool']) {
                assert.doesNotThrow(() => thrower[k](EV.health))
                assert.doesNotThrow(() => aiEventLoggersOf(rl, FIXED_CLOCK)[k](null))
                assert.doesNotThrow(() => aiEventLoggersOf(undefined)[k](EV.health))
            }
        })

        it('buildAiAdapter:未注入即以工廠建調度層(ai、envFile、workspace、clock 照傳;isNetDown 為函數才給;其餘 opt 照傳),三種事件回呼接至當輪日誌;輪外之事件不記;呼叫端自帶之回呼先被呼叫(拋錯不外洩)', () => {
            const made = []
            const createAdapter = (o) => {
                made.push(o)
                return { callJson: async () => ({ ok: false }) }
            }
            const rl = createRoundLog()
            const ai = { timeoutMs: 1 }
            const isNetDown = async () => false
            const seen = []
            const ad = buildAiAdapter({ ai, envFile: 'c:/kb/.env', workspace: 'c:/kb/ws', clock: FIXED_CLOCK, isNetDown, roundLog: rl, adapterOpt: { preview: true, onHealth: (ev) => {
                seen.push(ev)
                throw new Error('呼叫端回呼壞了')
            } }, createAdapter })
            assert.equal(made.length, 1)
            assert.equal(ad.callJson !== undefined, true)
            const o = made[0]
            assert.deepEqual([o.ai, o.envFile, o.workspace, o.clock, o.isNetDown, o.preview], [ai, 'c:/kb/.env', 'c:/kb/ws', FIXED_CLOCK, isNetDown, true])
            for (const k of ['onPool', 'onHealth', 'onOversize']) assert.equal(typeof o[k], 'function', k)
            const log = recLog()
            rl.enter(log)
            o.onHealth(EV.health)
            o.onOversize(EV.oversize)
            o.onPool(EV.pool)
            rl.leave(log)
            o.onHealth(EV.healthKeys)
            o.onOversize(EV.oversize)
            assert.deepEqual(log.lines, [LINE.health, LINE.oversize, LINE.pool], '輪內三種事件各一行;輪外不記')
            assert.deepEqual(seen, [EV.health, EV.healthKeys], '呼叫端之 onHealth 先被呼叫(拋錯不外洩)')
            // isNetDown 非函數即不給
            buildAiAdapter({ ai, workspace: 'w', clock: FIXED_CLOCK, isNetDown: null, createAdapter })
            assert.equal('isNetDown' in made[1], false)
        })

        it('buildAiAdapter:注入 cfg.aiAdapter 即原樣回傳(不建、不接事件);形狀不合即拋', () => {
            let n = 0
            const createAdapter = () => {
                n++
                return {}
            }
            const injected = { callJson: async () => ({ ok: false }) }
            assert.equal(buildAiAdapter({ aiAdapter: injected, ai: {}, workspace: 'w', roundLog: createRoundLog(), createAdapter }), injected)
            assert.equal(n, 0, '不建內建調度層')
            assert.equal(msgOf(() => buildAiAdapter({ aiAdapter: {}, createAdapter })), 'cfg.aiAdapter 須為具 callJson(prompt, check, { spec }) 之物件')
        })

        it('buildAiAdapter 之 p.options(cfg.aiOptions):鍵限 AI_OPTIONS_KEYS、原樣透傳工廠;套件之 adapterOpt 蓋過同名者;非物件或不認得之鍵即拋(注入 aiAdapter 時亦驗);未給即不傳', () => {
            // 規則:core/assemblyKit.buildAiAdapter 之 JSDoc(p.options);core/ai/adapter 檔頭【安裝端之資產以建構選項給】
            assert.deepEqual([...AI_OPTIONS_KEYS], ['providerPick', 'exes', 'persistStore', 'usageCounter'])
            assert.ok(Object.isFrozen(AI_OPTIONS_KEYS))
            const made = []
            const createAdapter = (o) => {
                made.push(o)
                return { callJson: async () => ({ ok: false }) }
            }
            const store = { get: () => ({}), set: () => {} }
            buildAiAdapter({ ai: {}, workspace: 'w', createAdapter, options: { providerPick: ['a:b'], exes: { claude: 'C:/x/claude.exe' }, persistStore: store } })
            assert.deepEqual([made[0].providerPick, made[0].exes, made[0].persistStore, 'usageCounter' in made[0]], [['a:b'], { claude: 'C:/x/claude.exe' }, store, false])
            buildAiAdapter({ ai: {}, workspace: 'w', createAdapter, options: { exes: { claude: 'host' } }, adapterOpt: { exes: { claude: 'pkg' } } })
            assert.deepEqual(made[1].exes, { claude: 'pkg' }, '套件之 adapterOpt 優先')
            buildAiAdapter({ ai: {}, workspace: 'w', createAdapter })
            assert.deepEqual(['providerPick', 'exes', 'persistStore', 'usageCounter'].map((k) => k in made[2]), [false, false, false, false], '未給即不傳(預設行為不變)')
            for (const v of [undefined, null]) assert.doesNotThrow(() => buildAiAdapter({ ai: {}, workspace: 'w', createAdapter, options: v }))
            const msg = 'cfg.aiOptions 須為物件（內建調度層之建構選項：providerPick、exes、persistStore、usageCounter）'
            for (const bad of ['x', 5, [], true]) assert.equal(msgOf(() => buildAiAdapter({ ai: {}, workspace: 'w', createAdapter, options: bad })), msg, JSON.stringify(bad))
            assert.equal(msgOf(() => buildAiAdapter({ ai: {}, workspace: 'w', createAdapter, options: { zzz: 1 } })), 'cfg.aiOptions 含不認得之鍵：zzz（可用：providerPick、exes、persistStore、usageCounter）')
            const injected = { callJson: async () => ({ ok: false }) }
            assert.equal(msgOf(() => buildAiAdapter({ aiAdapter: injected, options: 'x', createAdapter })), msg, '注入者亦驗形狀')
            assert.equal(buildAiAdapter({ aiAdapter: injected, options: { exes: {} }, createAdapter }), injected, '注入者:選項不用、原樣回傳')
        })

        it('checkAiAdapter 之 opt.need:所需之函數(給了即取代預設之 callJson);缺任一即拋並列出所需之名(調度層之公開函數附呼叫形式);未給或 null 為預設(字樣同上);need 形狀不合即拋', () => {
            const fn = () => {}
            const need = ['getWkf', 'seatSpec', 'recordCall']
            const msg = 'cfg.aiAdapter 須為具 getWkf()、seatSpec(seat, promptLen)、recordCall(r) 之物件'
            assert.equal(msgOf(() => checkAiAdapter({ getWkf: fn, seatSpec: fn, recordCall: fn }, { need })), null, '三名皆具即過(不另要求 callJson)')
            for (const miss of need) {
                const ad = Object.fromEntries(need.filter((k) => k !== miss).map((k) => [k, fn]))
                assert.equal(msgOf(() => checkAiAdapter({ ...ad, callJson: fn }, { need })), msg, `缺 ${miss}`)
            }
            assert.equal(msgOf(() => checkAiAdapter({ getWkf: fn, seatSpec: 'x', recordCall: fn }, { need })), msg, '非函數視同缺')
            for (const bad of [5, 'x', [], false]) assert.equal(msgOf(() => checkAiAdapter(bad, { need })), msg, JSON.stringify(bad))
            for (const v of [undefined, null]) assert.equal(msgOf(() => checkAiAdapter(v, { need })), null, '未注入不檢')
            assert.equal(msgOf(() => checkAiAdapter({ callJson: fn }, { need: ['callJson', 'myHook', 'callJson'] })), 'cfg.aiAdapter 須為具 callJson(prompt, check, { spec })、myHook 之物件', '未列呼叫形式之名只列名;重複者去除')
            for (const opt of [undefined, null, {}, { need: null }, 'x']) {
                assert.equal(msgOf(() => checkAiAdapter({ callJson: fn }, opt)), null, `opt=${JSON.stringify(opt)}:預設只需 callJson`)
                assert.equal(msgOf(() => checkAiAdapter({}, opt)), 'cfg.aiAdapter 須為具 callJson(prompt, check, { spec }) 之物件', `opt=${JSON.stringify(opt)}:預設字樣不變`)
            }
            for (const bad of [[], 'callJson', [''], ['callJson', 1], {}]) assert.equal(msgOf(() => checkAiAdapter({ callJson: fn }, { need: bad })), 'checkAiAdapter 之 opt.need 須為函數名之非空字串陣列（如 [\'callJson\']）', JSON.stringify(bad))
        })

        it('buildAiAdapter 之 p.need:透傳 checkAiAdapter(注入者同一判準與字樣);給了時內建調度層亦須具之(漏開工作流入口即於組裝期拋);未給照舊不檢內建者', () => {
            const fn = () => {}
            const need = ['getWkf', 'seatSpec', 'recordCall']
            const injected = { getWkf: fn, seatSpec: fn, recordCall: fn }
            assert.equal(buildAiAdapter({ aiAdapter: injected, need, createAdapter: () => ({}) }), injected, '注入者具所需之函數即原樣回傳')
            assert.equal(msgOf(() => buildAiAdapter({ aiAdapter: { callJson: fn }, need })), 'cfg.aiAdapter 須為具 getWkf()、seatSpec(seat, promptLen)、recordCall(r) 之物件')
            assert.equal(msgOf(() => buildAiAdapter({ aiAdapter: { callJson: fn }, need: 'getWkf' })), 'buildAiAdapter 之 p.need 須為函數名之非空字串陣列（如 [\'callJson\']）')
            // 內建調度層(替身工廠):宣告了 need 而缺 → 拋;未宣告照舊(預設行為不變)
            const made = []
            const plain = (o) => {
                made.push(o)
                return { callJson: fn, recordCall: fn }
            }
            assert.equal(msgOf(() => buildAiAdapter({ ai: {}, workspace: 'w', need, createAdapter: plain })), '內建 AI 調度層缺所需之函數：getWkf、seatSpec（adapterOpt 未開啟對應之機制；如工作流入口 getWkf／seatSpec 須給 workflow:true）')
            assert.equal(typeof buildAiAdapter({ ai: {}, workspace: 'w', createAdapter: plain }).callJson, 'function', '未給 need:內建者照舊不檢')
            assert.equal(typeof buildAiAdapter({ ai: {}, workspace: 'w', createAdapter: () => ({}) }).callJson, 'undefined', '未給 need:替身工廠之產物原樣回傳(現行)')
            // 真內建調度層:adapterOpt.workflow 透傳 → 具 getWkf／seatSpec 而過;漏給 → 拋
            const real = { ai: {}, workspace: `${dirOf('need')}/ws`, roundLog: createRoundLog(), adapterOpt: { catalogue: [{ id: 't:dead', kind: 'api-openai-compat', baseURL: DEAD_BASE, model: 'm' }] } }
            const ok = buildAiAdapter({ ...real, adapterOpt: { ...real.adapterOpt, workflow: true }, need })
            assert.deepEqual([typeof ok.getWkf, typeof ok.seatSpec, typeof ok.recordCall], ['function', 'function', 'function'])
            assert.equal(msgOf(() => buildAiAdapter({ ...real, need })), '內建 AI 調度層缺所需之函數：getWkf、seatSpec（adapterOpt 未開啟對應之機制；如工作流入口 getWkf／seatSpec 須給 workflow:true）')
        })

        it('startupWarningsOf:席位檢核之警告在前、其餘清單依序併入(非陣列者略過);無 validateSeats 者不檢;validateSeats 拋錯原樣拋出', () => {
            const seats = { 'x.ai': { use: 'a' } }
            const got = []
            const ai = { validateSeats: (s) => {
                got.push(s)
                return { ok: true, warnings: ['席位提示'] }
            } }
            assert.deepEqual(startupWarningsOf(ai, seats, [['執行期'], undefined, ['設定一', '設定二']]), ['席位提示', '執行期', '設定一', '設定二'])
            assert.deepEqual(got, [seats])
            assert.deepEqual(startupWarningsOf({ callJson: () => {} }, seats, [['只此']]), ['只此'])
            assert.deepEqual(startupWarningsOf(ai, seats), ['席位提示'])
            assert.throws(() => startupWarningsOf({ validateSeats: () => {
                throw new Error('席位不合格')
            } }, seats, []), /席位不合格/)
        })
    })

    describe('集合之開關(createStoreOpener;真 LMDB)', function() {

        it('依名開啟、資料落 lmdb.cls 之集合名(開集合時才讀 lmdb);closeStores 後讀取被拒;closeStores(undefined)／({}) 不拋', async () => {
            const wd = dirOf('open')
            const lmdb = resolveLmdbCfg({ cls: { notes: 'myNotes' } }, { db: `${wd}/db` }, { keys: ['docs', 'notes', 'cores'] })
            const { openStores, closeStores } = createStoreOpener(lmdb, ['docs', 'notes'])
            const st = openStores()
            assert.deepEqual(Object.keys(st), ['docs', 'notes'])
            await st.notes.insertNew([{ id: 'n1', title: 't' }])
            await closeStores(st)
            for (const c of Object.values(st)) await assert.rejects(() => c.get('x'))
            await closeStores(undefined)
            await closeStores({})
            const peek = W.openCollection({ WOrm: WOrmLmdb, path: `${wd}/db`, db: 'knowledge', cl: 'myNotes' })
            try {
                assert.deepEqual((await peek.select()).map((r) => r.id), ['n1'])
            }
            finally {
                await peek.close()
            }
        })

        it('中途失敗:拋原錯誤、已開啟者先行關閉;lmdb 形狀不合、names 不合或某名不在 lmdb.cls 即拋', async () => {
            const closed = []
            let n = 0
            const WOrm = (o) => {
                n++
                if (n === 2) throw new Error('第二個集合開不起來')
                return { select: async () => [], close: async () => {
                    closed.push(o.cl)
                } }
            }
            const lmdb = resolveLmdbCfg({ WOrm }, { db: 'c:/kb/db' }, { keys: ['docs', 'notes'] })
            assert.throws(() => createStoreOpener(lmdb, ['docs', 'notes']).openStores(), /第二個集合開不起來/)
            await sleep(20)
            assert.deepEqual(closed, ['docs'])
            assert.match(msgOf(() => createStoreOpener({}, ['docs'])), /^createStoreOpener 需要 lmdb/)
            for (const bad of [undefined, [], [5]]) assert.match(msgOf(() => createStoreOpener(lmdb, bad)), /^createStoreOpener 需要 names/)
            assert.equal(msgOf(() => createStoreOpener(lmdb, ['docs', 'cores'])), 'createStoreOpener 之集合無集合名（lmdb.cls 未列）：cores')
        })
    })

    describe('每輪 run(createRoundRunner;真 LMDB、下游目錄 notes、選開集合 cores)', function() {

        /**
         * 以共用件組一個最小之總組裝(下游示意):下游目錄 notes、集合 docs／notes(＋選開之 cores)、記錄型日誌、執行順序之記錄
         *
         * @param {String} wd 輸入 workDir
         * @param {Object} [o={}] 輸入 { stages, lock, limit(排程上限;未給為 55、null 為不給), deadlineMs, cores, scan, afterRun, afterRunNote, ai, warnings, now(字串或每輪呼叫之函數) }
         * @returns {Object} 回傳 { run, order, logs, deps, roundLog, dirs, runtime, names }
         */
        const assemble = (wd, o = {}) => {
            const order = []
            const logs = []
            const deps = []
            const dirs = resolveDirsCfg(wd, undefined, { notes: 'knowledge/notes' })
            const limit = o.limit === undefined ? 55 : o.limit
            const runtime = resolveRuntime({ lock: o.lock ?? false, ...(limit !== null ? { scheduleLimitMin: limit } : {}), ...(o.deadlineMs ? { deadlineMs: o.deadlineMs } : {}) }, { workDir: wd, dirs })
            const optional = { cores: { value: o.cores ?? false, label: '核心' } }
            const lmdb = resolveLmdbCfg(undefined, dirs, { keys: ['docs', 'notes', 'cores'], optional })
            const names = ['docs', 'notes', ...checkOptionalCollections(optional)]
            const opener = createStoreOpener(lmdb, names)
            const roundLog = createRoundLog()
            const run = createRoundRunner({
                name: '共用件測試',
                dirs,
                clock: FIXED_CLOCK,
                mkLog: () => {
                    const l = recLog()
                    if (o.now) l.now = typeof o.now === 'function' ? o.now() : o.now
                    logs.push(l)
                    return l
                },
                startupWarnings: o.warnings || ['w1'],
                runtime,
                openStores: () => {
                    order.push('open')
                    return opener.openStores()
                },
                closeStores: async (st) => {
                    order.push('close')
                    await opener.closeStores(st)
                },
                buildDeps: (stores, log) => {
                    const d = { stores, dirs, log }
                    deps.push(d)
                    return d
                },
                stages: o.stages || [{ name: 'noop', run: async () => stdReport() }],
                ai: o.ai,
                roundLog,
                scan: o.scan,
                afterRun: o.afterRun,
                afterRunNote: o.afterRunNote,
            })
            return { run, order, logs, deps, roundLog, dirs, runtime, names }
        }
        const COUNTS = (violation = 1) => ({ enabled: true, audit: async () => ({ n: 1 }), countsOf: (r, { at, ms }) => ({ at, ms, counts: { X1: { v: 1, total: r.n, violation }, X2: { v: 1, total: 1, violation: 0 } } }) })

        it('序列:建目錄(含下游之 notes)→ 啟動期警告 → 開工標記 → 開集合 → 段(寫一篇筆記至 <workDir>/knowledge/notes)→ 掃描 → run.json → 收尾 → 關集合;掃描與收尾取得同一份 deps;回傳 report(含 summaryFile、afterRun)', async () => {
            const wd = dirOf('seq')
            const seen = {}
            const a = assemble(wd, {
                stages: [{ name: 'note', run: async (ctx) => {
                    a.order.push('stage')
                    seen.startsAtStage = findFiles(`${wd}/log`, '-run.start.json').length
                    seen.notesDir = ctx.deps.dirs.notes
                    fs.writeFileSync(`${ctx.deps.dirs.notes}/n1.md`, '# 筆記一\n', 'utf8')
                    await ctx.deps.stores.notes.insertNew([{ id: 'n1', title: '筆記一' }])
                    return stdReport({ stats: { in: 1, out: 1 }, detail: { wrote: 1 } })
                } }],
                scan: { ...COUNTS(1), audit: async ({ stores, deps, log }) => {
                    a.order.push('scan')
                    seen.scan = { notes: (await stores.notes.select()).length, deps, hasLog: typeof log.info, runJsons: findFiles(`${wd}/log`, '-run.json').length }
                    return { n: 1 }
                } },
                afterRun: async (x) => {
                    a.order.push('after')
                    seen.after = { keys: Object.keys(x).sort(), sum: readJsonFile(x.summaryFile), deps: x.deps, log: x.log }
                    return { ok: true, tag: 'done' }
                },
            })
            const rep = await a.run()
            assert.deepEqual(a.order, ['open', 'stage', 'scan', 'after', 'close'])
            assert.equal(seen.startsAtStage, 1, '段執行當下開工標記已落地')
            assert.equal(seen.notesDir, `${wd}/knowledge/notes`)
            assert.ok(fs.existsSync(`${wd}/knowledge/notes/n1.md`), '零設定之下游目錄於每輪開頭建立、可寫入')
            assert.deepEqual([seen.scan.notes, seen.scan.hasLog, seen.scan.runJsons], [1, 'function', 0], '掃描在 run.json 之前、看得到本輪之寫入')
            assert.equal(a.deps.length, 1, '每輪建一次 deps')
            assert.equal(seen.scan.deps, a.deps[0])
            assert.equal(seen.after.deps, a.deps[0], '收尾鉤子收到之 deps 即組裝所建')
            assert.equal(seen.after.log, a.logs[0])
            // 刻意更新(產出鏈規格 §5.4):收尾鉤子之引數加 stamp(與 run.json 同值);其餘鍵不變
            assert.deepEqual(seen.after.keys, ['deps', 'log', 'report', 'stamp', 'summaryFile'])
            assert.equal(seen.after.sum.stamp, '20260102030405')
            assert.deepEqual(seen.after.sum.standards.counts.X1, { v: 1, total: 1, violation: 1 }, '收尾讀 run.json 時當輪之計數已在')
            assert.equal(seen.after.sum.standards.at, FIXED_CLOCK.iso8())
            assert.equal(rep.ok, true)
            assert.equal(rep.summaryFile.replace(/\\/g, '/'), `${wd}/log/20260102/20260102030405-run.json`)
            assert.deepEqual(rep.afterRun, { ok: true, tag: 'done' })
            const sum = readJsonFile(rep.summaryFile)
            assert.deepEqual([sum.name, sum.stamp, sum.startedAt, sum.deadlineMs, sum.stages.map((s) => s.name)], ['共用件測試', '20260102030405', FIXED_CLOCK.iso8(), 49 * MIN, ['note']])
            const start = readJsonFile(findFiles(`${wd}/log`, '-run.start.json')[0])
            assert.deepEqual(start, { pid: process.pid, startedAt: FIXED_CLOCK.iso8(), limitMin: 55, scheduleLimitMin: 55, deadlineMs: 49 * MIN, lockStaleMs: 60 * MIN, version: 1, stamp: '20260102030405' })
            const lines = a.logs[0].lines
            assert.equal(lines[0], 'WARN 啟動期檢核：w1', '啟動期警告為每輪第一行')
            assert.ok(lines.some((l) => /^INFO 符合度掃描（\d+\.\ds）：違反 X1 1$/.test(l)), lines.join('\n'))
            assert.ok(lines.some((l) => /^INFO 收尾完成（[\d.]+s）$/.test(l)), lines.join('\n'))
            for (const d of ['db', 'log', 'tmp', 'state', 'knowledge', 'knowledge/notes']) assert.ok(fs.existsSync(`${wd}/${d}`), d)
            assert.equal(a.roundLog.current(), null, '輪後當輪日誌已移除')
        })

        it('stamp 交各段(產出鏈規格 §5.4):每段 ctx.stamp(when 與 run 皆見)等於該輪 run.json 與 run.start.json 之 stamp;每輪各自一值;子階段共用同一 ctx;階段物件不被改;段之簽名與回報不變', async () => {
            const seenRun = []
            const seenWhen = []
            const seenSub = []
            const stages = [
                { name: 'a', when: (ctx) => { seenWhen.push(['a', ctx.stamp]); return true }, run: async (ctx) => { seenRun.push(['a', ctx.stamp]); return stdReport() } },
                { name: 'skipped', when: (ctx) => { seenWhen.push(['skipped', ctx.stamp]); return false }, run: async () => { throw new Error('when 為 false 不應執行') } },
                { name: 'b', run: async (ctx) => {
                    seenRun.push(['b', ctx.stamp])
                    const reps = await runSubStages([{ name: 'sub', run: async (c) => { seenSub.push(c.stamp); return stdReport() } }], ctx)
                    return stdReport({ detail: reps })
                } },
            ]
            const before = stages.map((s) => ({ ...s }))
            const stamps = ['20261108100000', '20261108110000']
            let n = 0
            const wd = dirOf('stamp')
            const a = assemble(wd, { stages, now: () => stamps[n++] })
            const r1 = await a.run()
            const r2 = await a.run()
            // 規格 §5.4:各段 ctx 帶 stamp,與該輪 run.json 之 stamp 同一值
            for (const [i, r] of [r1, r2].entries()) {
                const sum = readJsonFile(r.summaryFile)
                assert.equal(sum.stamp, stamps[i], `第 ${i + 1} 輪 run.json 之 stamp`)
                assert.deepEqual(seenRun.filter((_, k) => Math.floor(k / 2) === i), [['a', sum.stamp], ['b', sum.stamp]], `第 ${i + 1} 輪各段 ctx.stamp 等於 run.json 之 stamp`)
                assert.deepEqual(seenWhen.filter((_, k) => Math.floor(k / 2) === i), [['a', sum.stamp], ['skipped', sum.stamp]], `第 ${i + 1} 輪 when 亦見 stamp(含被略過之段)`)
                assert.equal(seenSub[i], sum.stamp, '子階段(runSubStages 傳遞同一 ctx)亦見')
                const startFiles = findFiles(`${wd}/log`, `${sum.stamp}-run.start.json`)
                assert.equal(startFiles.length, 1, 'run.start.json 檔名之 stamp 同一值')
                assert.equal(readJsonFile(startFiles[0]).stamp, sum.stamp)
                assert.deepEqual(r.stages.map((s) => [s.name, s.status]), [['a', 'ok'], ['skipped', 'skip'], ['b', 'ok']], '各段之回報與略過語意不變')
            }
            assert.notEqual(seenRun[0][1], seenRun[2][1], '每輪各自一值')
            // 階段物件不被改(跨輪重用):鍵與函數皆原樣
            stages.forEach((s, i) => {
                assert.deepEqual(Object.keys(s), Object.keys(before[i]))
                assert.equal(s.run, before[i].run)
                assert.equal(s.when, before[i].when)
                assert.ok(!('stamp' in s))
            })
        })

        it('stamp 取自日誌之 now(自訂日誌工廠有 now 者)或時鐘 stamp8(無 now 者),與 run.json 同值;停止後之 always 段、巢狀管線作為段亦照常執行', async () => {
            const seen = []
            const sub = W.definePipeline({ name: 'nested', stages: [{ name: 'inner', run: async () => { seen.push('inner'); return stdReport() } }] })
            const stages = [
                { name: 'halt', run: async (ctx) => { seen.push(['halt', ctx.stamp]); return { ...stdReport(), stop: true, reason: '測試停止' } } },
                { name: 'skipme', run: async () => { throw new Error('停止後不應執行') } },
                { name: 'fin', always: true, run: async (ctx) => { seen.push(['fin', ctx.stamp]); return stdReport() } },
            ]
            const a = assemble(dirOf('stamp2'), { stages }) // 無 now:取 FIXED_CLOCK.stamp8()
            const rep = await a.run()
            const sum = readJsonFile(rep.summaryFile)
            assert.equal(sum.stamp, FIXED_CLOCK.stamp8())
            assert.deepEqual(seen, [['halt', sum.stamp], ['fin', sum.stamp]], '停止後 always 段照常執行且見 stamp')
            assert.deepEqual(rep.stages.map((s) => [s.name, s.status]), [['halt', 'ok'], ['skipme', 'skip'], ['fin', 'ok']])
            const nested = assemble(dirOf('stamp3'), { stages: [sub], now: '20261201000000' })
            const rep2 = await nested.run()
            assert.equal(rep2.ok, true, '巢狀管線(__kind:pipeline)包裝後仍照常執行')
            assert.deepEqual(seen.slice(2), ['inner'])
            assert.equal(readJsonFile(rep2.summaryFile).stamp, '20261201000000')
        })

        it('scan.audit 與 afterRun 之引數亦帶 stamp(產出鏈規格 §5.4):與該輪 run.json 之 stamp 同值,每輪各自一值;引數鍵集為既有鍵加 stamp,其餘鍵與值不變', async () => {
            const auditArgs = []
            const afterArgs = []
            const stamps = ['20261108120000', '20261108130000']
            let n = 0
            const a = assemble(dirOf('stamp-cb'), {
                now: () => stamps[n++],
                scan: { ...COUNTS(0), audit: async (x) => {
                    auditArgs.push(x)
                    return { n: 1 }
                } },
                afterRun: async (x) => {
                    afterArgs.push(x)
                    return { ok: true }
                },
            })
            const r1 = await a.run()
            const r2 = await a.run()
            for (const [i, r] of [r1, r2].entries()) {
                const sum = readJsonFile(r.summaryFile)
                assert.equal(sum.stamp, stamps[i], `第 ${i + 1} 輪 run.json 之 stamp`)
                assert.equal(auditArgs[i].stamp, sum.stamp, `第 ${i + 1} 輪 scan.audit 收到之 stamp`)
                assert.equal(afterArgs[i].stamp, sum.stamp, `第 ${i + 1} 輪 afterRun 收到之 stamp`)
                assert.deepEqual(Object.keys(auditArgs[i]).sort(), ['deps', 'log', 'stamp', 'stores'])
                assert.deepEqual(Object.keys(afterArgs[i]).sort(), ['deps', 'log', 'report', 'stamp', 'summaryFile'])
                assert.equal(afterArgs[i].summaryFile, r.summaryFile, '既有鍵之值不變')
                assert.equal(afterArgs[i].report, r)
                assert.equal(afterArgs[i].deps, auditArgs[i].deps, '掃描與收尾取得同一份 deps')
            }
            assert.notEqual(auditArgs[0].stamp, auditArgs[1].stamp)
            assert.deepEqual(a.deps.length, 2)
        })

        it('選開之集合 cores:開啟者每輪開集合含 cores(段可讀寫),未開者不含', async () => {
            for (const [cores, want] of [[false, ['docs', 'notes']], [true, ['docs', 'notes', 'cores']], ['myCores', ['docs', 'notes', 'cores']]]) {
                const sink = {}
                const a = assemble(dirOf('cores'), { cores, stages: [{ name: 'peek', run: async (ctx) => {
                    sink.keys = Object.keys(ctx.deps.stores)
                    if (ctx.deps.stores.cores) await ctx.deps.stores.cores.insertNew([{ id: 'c1' }])
                    return stdReport()
                } }] })
                await a.run()
                assert.deepEqual([sink.keys, a.names], [want, want], String(cores))
            }
        })

        it('未取得執行鎖:略過本輪(不跑段、不掃描、不寫 run.json、不收尾),集合仍關閉、當輪日誌已移除;開工標記已寫(取鎖之前)', async () => {
            const wd = dirOf('lock')
            let ran = 0
            const a = assemble(wd, { lock: true, scan: { ...COUNTS(1), audit: async () => {
                a.order.push('scan')
                return { n: 1 }
            } }, afterRun: () => {
                a.order.push('after')
            }, stages: [{ name: 's', run: async () => {
                ran++
                return stdReport()
            } }] })
            const held = acquireLock(a.runtime.lockFile, { staleMs: 3_600_000 })
            assert.equal(held.ok, true)
            let rep
            try {
                rep = await a.run()
            }
            finally {
                held.release()
            }
            assert.equal(rep.lockSkipped, true)
            assert.deepEqual([ran, a.order], [0, ['open', 'close']])
            assert.deepEqual([rep.summaryFile, 'afterRun' in rep], [undefined, false])
            assert.deepEqual([findFiles(`${wd}/log`, '-run.json').length, findFiles(`${wd}/log`, '-run.start.json').length], [0, 1])
            assert.ok(a.logs[0].lines.some((l) => /^WARN 管道\[共用件測試\] 略過本輪：/.test(l)), a.logs[0].lines.join('\n'))
            assert.equal(a.roundLog.current(), null)
            const ok = await a.run()
            assert.deepEqual([ok.lockSkipped, ran], [false, 1], '釋放後下一輪照常')
            assert.equal(fs.existsSync(a.runtime.lockFile), false, '執行結束已釋放鎖')
        })

        it('核心件之日誌字樣(logContract 之 CORE_LOG_KNOWN／CORE_LOG_MUST_SEE;本套件與下游套件之契約以之組成)皆命中真實發出者之 WARN 行:每輪序列之啟動期檢核、執行鎖之略過本輪、管道之階段逾時間預算,AI 調度層之健康／額度事件,網路判斷之本機網路不通;抓取之契約含之', async () => {
            const lines = []
            // 每輪序列:啟動期警告(每輪第一行);第一段逾時間預算 → 其後之段由管道略過
            const late = assemble(dirOf('core-log'), { deadlineMs: 5, stages: [{ name: 'slow', run: async () => {
                await sleep(40)
                return stdReport()
            } }, { name: 'next', run: async () => stdReport() }] })
            await late.run()
            lines.push(...late.logs[0].lines)
            // 執行鎖持有中
            const locked = assemble(dirOf('core-lock'), { lock: true })
            const held = acquireLock(locked.runtime.lockFile, { staleMs: 3_600_000 })
            try {
                await locked.run()
            }
            finally {
                held.release()
            }
            lines.push(...locked.logs[0].lines)
            // AI 調度層之事件(經當輪日誌之轉接)
            const rl = createRoundLog()
            const ev = recLog()
            rl.enter(ev)
            const h = aiEventLoggersOf(rl, FIXED_CLOCK)
            h.onHealth(EV.health)
            h.onPool(EV.pool)
            lines.push(...ev.lines)
            // 網路判斷:子階段開工前確認不通
            const net = recLog()
            assert.equal(await netDownAtStart({ deps: { netGuard: { check: async () => ({ up: false }), describe: () => '127.0.0.1：不通' } }, log: net }, '輪抓'), true)
            lines.push(...net.lines)
            const warns = lines.filter((l) => l.startsWith('WARN '))
            assert.ok(warns.some((l) => /^WARN 管道\[共用件測試\] 階段\[next\] 略過：逾時間預算$/.test(l)), warns.join('\n'))
            assert.deepEqual([...CORE_LOG_KNOWN], ['略過本輪', '逾時間預算', '啟動期檢核：', '供應商健康：', '供應商額度：'])
            assert.deepEqual([...CORE_LOG_MUST_SEE], ['本機網路不通'])
            assert.ok([CORE_LOG_KNOWN, CORE_LOG_MUST_SEE].every(Object.isFrozen))
            assert.deepEqual(CORE_LOG_KNOWN.filter((p) => !warns.some((l) => new RegExp(p).test(l))), [], `未在真實發出者之行出現之已知字樣:\n${warns.join('\n')}`)
            assert.deepEqual(CORE_LOG_MUST_SEE.filter((p) => !warns.some((l) => l.includes(p))), [], `未在真實發出者之行出現之須見字樣:\n${warns.join('\n')}`)
            assert.deepEqual(CORE_LOG_KNOWN.filter((p) => !CAPTURE_LOG_KNOWN.includes(p)), [], '抓取之契約含核心件之已知字樣')
            assert.deepEqual(CORE_LOG_MUST_SEE.filter((p) => !CAPTURE_LOG_MUST_SEE.includes(p)), [], '抓取之契約含核心件之須見字樣')
        })

        it('符合度掃描:enabled 為 false／回傳 false 不掃;逾時間預算者略過(日誌註明下輪補掃);audit 拋錯或 enabled 拋錯只留 warn(本輪不列違反數),run.json 與收尾照常', async () => {
            const scanLines = (a) => a.logs[0].lines.filter((l) => l.includes('符合度掃描'))
            let audits = 0
            const counting = (enabled) => ({ ...COUNTS(0), enabled, audit: async () => {
                audits++
                return { n: 1 }
            } })
            for (const enabled of [false, () => false]) {
                const a = assemble(dirOf('scan-off'), { scan: counting(enabled) })
                const rep = await a.run()
                assert.deepEqual([scanLines(a), readJsonFile(rep.summaryFile).standards], [[], undefined])
            }
            assert.equal(audits, 0)
            const on = assemble(dirOf('scan-on'), { scan: counting(() => true) })
            const repOn = await on.run()
            assert.deepEqual(readJsonFile(repOn.summaryFile).standards.counts.X2, { v: 1, total: 1, violation: 0 })
            assert.ok(/^INFO 符合度掃描（\d+\.\ds）：各確定性標準皆無違反$/.test(scanLines(on)[0]), scanLines(on).join('\n'))
            const late = assemble(dirOf('scan-late'), { deadlineMs: 5, scan: counting(true), stages: [{ name: 'slow', run: async () => {
                await sleep(40)
                return stdReport()
            } }] })
            const repLate = await late.run()
            assert.deepEqual(scanLines(late), ['INFO 符合度掃描：本輪已逾時間預算，略過（下輪補掃）'])
            assert.equal(readJsonFile(repLate.summaryFile).standards, undefined)
            assert.equal(audits, 1, '逾時者不呼叫 audit')
            for (const [scan, want] of [
                [{ ...COUNTS(1), audit: async () => {
                    throw new Error('掃描壞了')
                } }, 'WARN 符合度掃描失敗：掃描壞了（本輪不列違反數）'],
                [{ ...COUNTS(1), enabled: () => {
                    throw new Error('判定壞了')
                } }, 'WARN 符合度掃描失敗：判定壞了（本輪不列違反數）'],
            ]) {
                const after = []
                const a = assemble(dirOf('scan-fail'), { scan, afterRun: ({ summaryFile }) => {
                    after.push(summaryFile)
                } })
                const rep = await a.run()
                assert.equal(rep.ok, true)
                assert.deepEqual(scanLines(a), [want])
                assert.equal(readJsonFile(rep.summaryFile).standards, undefined)
                assert.deepEqual(after, [rep.summaryFile], '掃描失敗不影響其後之收尾')
            }
            for (const bad of [{}, { enabled: true, audit: () => {} }, { enabled: 'yes', audit: () => {}, countsOf: () => {} }]) {
                assert.match(msgOf(() => assemble(dirOf('scan-bad'), { scan: bad })), /^createRoundRunner 之 scan 須為/)
            }
        })

        it('收尾鉤子:完成／略過／失敗三態與拋錯之日誌字樣逐字;回傳值掛 report.afterRun;未給者 report 無此欄;AI 實績非「無呼叫」者記一行', async () => {
            const cases = [
                [{ ok: false, error: '寫檔失敗' }, /^WARN 收尾失敗：寫檔失敗（[\d.]+s；管線本身不受影響）$/],
                [{ ok: true, skipped: 'locked', message: '另一巡檢進行中' }, /^WARN 收尾略過：另一巡檢進行中（[\d.]+s）$/],
                [{ ok: true, skipped: 'x' }, /^WARN 收尾略過：x（[\d.]+s）$/],
                [{ ok: true }, /^INFO 收尾完成（[\d.]+s）$/],
                [undefined, /^INFO 收尾完成（[\d.]+s）$/],
            ]
            for (const [ret, re] of cases) {
                const a = assemble(dirOf('after'), { afterRun: () => ret })
                const rep = await a.run()
                assert.equal(rep.afterRun, ret)
                assert.ok(a.logs[0].lines.some((l) => re.test(l)), `${JSON.stringify(ret)}:\n${a.logs[0].lines.join('\n')}`)
            }
            const t = assemble(dirOf('after'), { afterRun: () => {
                throw new Error('鉤子壞了')
            } })
            const rep = await t.run()
            assert.deepEqual([rep.ok, rep.afterRun], [true, { ok: false, error: '鉤子壞了' }])
            assert.ok(t.logs[0].lines.includes('WARN 收尾鉤子拋錯：鉤子壞了'))
            const none = await assemble(dirOf('after')).run()
            assert.equal('afterRun' in none, false)
            const spy = { drained: 0 }
            const withAi = assemble(dirOf('after'), { ai: { drainStats: () => {
                spy.drained++
                return '成交 a×1'
            } } })
            const r2 = await withAi.run()
            assert.ok(withAi.logs[0].lines.includes('INFO AI 實績：成交 a×1'))
            assert.deepEqual([readJsonFile(r2.summaryFile).ai.callStats, spy.drained], ['成交 a×1', 1], '實績只取一次')
            const noCalls = assemble(dirOf('after'), { ai: { drainStats: () => '無呼叫' } })
            await noCalls.run()
            assert.equal(noCalls.logs[0].lines.some((l) => l.includes('AI 實績')), false)
        })

        it('收尾附註(afterRunNote):回非空字串者以「；附註」附於收尾失敗／略過之行,完成行不附;回空字串、非字串或拋錯即不附;不改收尾之回傳值;非函數即拋', async () => {
            // 下游示意:外部巡檢之紀錄是否已更新(收尾回傳 recordWritten 為布林者才附)
            const note = (r) => (typeof r?.recordWritten === 'boolean' ? (r.recordWritten ? '監控紀錄已更新' : '監控紀錄停留在上一輪') : '')
            const cases = [
                [{ ok: false, error: '推送失敗', recordWritten: true }, /^WARN 收尾失敗：推送失敗（[\d.]+s；管線本身不受影響；監控紀錄已更新）$/],
                [{ ok: false, error: '寫檔失敗', recordWritten: false }, /^WARN 收尾失敗：寫檔失敗（[\d.]+s；管線本身不受影響；監控紀錄停留在上一輪）$/],
                [{ ok: true, skipped: 'locked', message: '另一巡檢進行中', recordWritten: false }, /^WARN 收尾略過：另一巡檢進行中（[\d.]+s；監控紀錄停留在上一輪）$/],
                [{ ok: false, error: '自訂鉤子失敗' }, /^WARN 收尾失敗：自訂鉤子失敗（[\d.]+s；管線本身不受影響）$/],
                [{ ok: true, recordWritten: true }, /^INFO 收尾完成（[\d.]+s）$/],
            ]
            for (const [ret, re] of cases) {
                const a = assemble(dirOf('note'), { afterRun: () => ret, afterRunNote: note })
                const rep = await a.run()
                assert.equal(rep.afterRun, ret, '附註不改收尾之回傳值')
                assert.ok(a.logs[0].lines.some((l) => re.test(l)), `${JSON.stringify(ret)}:\n${a.logs[0].lines.join('\n')}`)
            }
            for (const bad of [() => '', () => 5, () => {
                throw new Error('附註壞了')
            }]) {
                const a = assemble(dirOf('note'), { afterRun: () => ({ ok: false, error: 'x' }), afterRunNote: bad })
                const rep = await a.run()
                assert.equal(rep.ok, true)
                assert.ok(a.logs[0].lines.some((l) => /^WARN 收尾失敗：x（[\d.]+s；管線本身不受影響）$/.test(l)), a.logs[0].lines.join('\n'))
            }
            assert.match(msgOf(() => assemble(dirOf('note'), { afterRunNote: 5 })), /^createRoundRunner 之 afterRunNote 須為函數/)
        })

        it('開工標記之 limitMin＝本輪宣告之上限(runtime.limitMin):只給時間預算者由預算推回(預算＋6 分,無條件進位);皆未給為 null', async () => {
            const startOf = async (o) => {
                const wd = dirOf('lim')
                await assemble(wd, o).run()
                const s = readJsonFile(findFiles(`${wd}/log`, '-run.start.json')[0])
                return [s.limitMin, s.scheduleLimitMin, s.deadlineMs]
            }
            assert.deepEqual(await startOf({ limit: null, deadlineMs: 20 * MIN }), [26, null, 20 * MIN])
            assert.deepEqual(await startOf({ limit: null }), [null, null, 50 * MIN], '皆未給:預算採套件預設,不宣告上限')
            assert.deepEqual(await startOf({ deadlineMs: 20 * MIN }), [55, 55, 20 * MIN], '排程上限優先')
        })

        it('開工標記與執行摘要之寫入失敗只留 warn(字樣逐字);report.summaryFile 為 null、收尾仍被呼叫;logger.now 為 14 碼者作本輪時間戳', async () => {
            const wd = dirOf('wfail')
            fs.mkdirSync(`${wd}/log`, { recursive: true })
            fs.writeFileSync(`${wd}/log/20260102`, 'x', 'utf8') // 日期子目錄之位置被檔案占住
            const seen = []
            const a = assemble(wd, { afterRun: ({ summaryFile }) => {
                seen.push(summaryFile)
            } })
            const rep = await a.run()
            assert.deepEqual([rep.ok, rep.summaryFile, seen], [true, null, [null]])
            assert.ok(a.logs[0].lines.includes('WARN 開工標記（run.start.json）寫入失敗——外部巡檢對本輪退用其他判界來源'))
            assert.ok(a.logs[0].lines.includes('WARN 執行摘要（run.json）寫入失敗'))
            const b = assemble(dirOf('now'), { now: '20250101010101' })
            const r2 = await b.run()
            assert.equal(path.basename(r2.summaryFile), '20250101010101-run.json')
        })

        it('當輪日誌:段內之調度層事件寫入本輪日誌,輪後不記;同一 flow 並發兩輪而後者因鎖略過、先結束時,執行中者之事件仍寫入其日誌', async () => {
            let release
            const gate = new Promise((resolve) => {
                release = resolve
            })
            let started
            const startedP = new Promise((resolve) => {
                started = resolve
            })
            let loggers = null
            const a = assemble(dirOf('round'), { lock: true, stages: [{ name: 'wait', run: async () => {
                loggers.onHealth(EV.health)
                started()
                await gate
                loggers.onOversize(EV.oversize)
                return stdReport()
            } }] })
            loggers = aiEventLoggersOf(a.roundLog, FIXED_CLOCK)
            const p1 = a.run()
            await startedP
            const r2 = await a.run()
            assert.equal(r2.lockSkipped, true)
            release()
            const r1 = await p1
            assert.equal(r1.lockSkipped, false)
            assert.ok(a.logs[0].lines.includes(LINE.health) && a.logs[0].lines.includes(LINE.oversize), a.logs[0].lines.join('\n'))
            assert.equal(a.logs[1].lines.some((l) => l.startsWith('WARN 供應商')), false, '略過之輪不收他輪之事件')
            loggers.onPool(EV.pool)
            assert.equal(a.logs.flatMap((l) => l.lines).some((l) => l.startsWith('WARN 供應商額度')), false, '輪外之事件不記')
            assert.equal(a.roundLog.current(), null)
        })

        it('開集合拋錯:run() 以原錯誤 reject,當輪日誌已移除;參數缺漏即拋(呼叫端錯誤)', async () => {
            const wd = dirOf('throw')
            const dirs = expandDirs(wd)
            const runtime = resolveRuntime({ lock: false }, { workDir: wd, dirs })
            const roundLog = createRoundLog()
            const p = { name: 'x', dirs, clock: FIXED_CLOCK, mkLog: () => recLog(), runtime, openStores: () => {
                throw new Error('開不了')
            }, closeStores: async () => {}, buildDeps: () => ({}), stages: [{ name: 's', run: async () => stdReport() }], roundLog }
            await assert.rejects(() => createRoundRunner(p)(), /開不了/)
            assert.equal(roundLog.current(), null)
            const miss = (k, v) => msgOf(() => createRoundRunner({ ...p, [k]: v }))
            assert.match(miss('name', ''), /^createRoundRunner 需要 name/)
            assert.match(miss('dirs', {}), /^createRoundRunner 需要 dirs/)
            assert.match(miss('clock', {}), /^createRoundRunner 需要 clock/)
            assert.match(miss('runtime', null), /^createRoundRunner 需要 runtime/)
            for (const k of ['mkLog', 'openStores', 'closeStores', 'buildDeps']) assert.equal(miss(k, 5), `createRoundRunner 需要 ${k}（函數）`)
            for (const bad of [[], undefined, 'x']) assert.match(miss('stages', bad), /^createRoundRunner 需要 stages/)
            assert.match(miss('afterRun', 5), /^createRoundRunner 之 afterRun 須為函數/)
        })
    })

    describe('info 之共同欄(assemblyInfoOf)', function() {

        it('鍵序固定、專屬欄排在 domains 之後;路徑以當下 cwd 解析為絕對路徑(非字串為 null);未給排程上限為 null;startupWarnings 為原陣列、collections 為複本;專屬欄與共同欄同名即拋', () => {
            const sw = ['w']
            const cols = ['docs', 'notes']
            const runtime = { envFile: 'sec/.env', aiWorkspace: null, lockFile: 'x/run.lock', deadlineMs: 1, lockStaleMs: 2 }
            const p = { dirs: { db: 'd' }, settings: { s: 1 }, clock: FIXED_CLOCK, ai: { a: 1 }, domains: { area: {} }, lmdb: { l: 1 }, data: { d: 1 }, vocab: { v: 1 }, runtime, startupWarnings: sw, collections: cols }
            const COMMON = ['dirs', 'settings', 'clock', 'ai', 'domains', 'lmdb', 'data', 'vocab', 'deadlineMs', 'lockStaleMs', 'startupWarnings', 'scheduleLimitMin', 'envFile', 'aiWorkspace', 'lockFile', 'collections']
            assert.deepEqual(Object.keys(assemblyInfoOf(p)), COMMON)
            const i = assemblyInfoOf({ ...p, extra: { registry: 'R', identity: 'I' } })
            assert.deepEqual(Object.keys(i), [...COMMON.slice(0, 5), 'registry', 'identity', ...COMMON.slice(5)])
            assert.deepEqual([i.envFile, i.aiWorkspace, i.lockFile, i.scheduleLimitMin], [path.resolve('sec/.env'), null, path.resolve('x/run.lock'), null])
            assert.deepEqual([i.deadlineMs, i.lockStaleMs], [1, 2])
            assert.equal(i.startupWarnings, sw)
            assert.notEqual(i.collections, cols)
            assert.deepEqual(i.collections, cols)
            assert.equal(assemblyInfoOf({ ...p, runtime: { ...runtime, scheduleLimitMin: 55 } }).scheduleLimitMin, 55)
            assert.equal(msgOf(() => assemblyInfoOf({ ...p, extra: { lmdb: 'x', registry: 'R' } })), 'assemblyInfoOf 之 extra 不可與共同欄同名：lmdb')
        })

        it('DEPS_COMMON_KEYS:下游總組裝之每輪依賴(deps)之共同欄——鍵與序固定、凍結;與 info() 之共同欄同處定義(deps 多 stores、locale,少執行期生效值)', () => {
            // 規則:core/assemblyKit 之 DEPS_COMMON_KEYS(deps 欄集之單一來源;下游套件之 buildDeps 取之)
            assert.deepEqual([...DEPS_COMMON_KEYS], ['stores', 'clock', 'dirs', 'data', 'vocab', 'locale', 'settings', 'ai', 'domains'])
            assert.ok(Object.isFrozen(DEPS_COMMON_KEYS))
            const infoKeys = Object.keys(assemblyInfoOf({}))
            assert.deepEqual(DEPS_COMMON_KEYS.filter((k) => !infoKeys.includes(k)), ['stores', 'locale'], 'deps 獨有之欄(info() 之 locale 屬各工作之專屬欄)')
        })

        it('抓取之總組裝:info() 之鍵序(共同欄＋registry、identity 於 domains 之後)與集合名單取自共用件', () => {
            const info = createKnowledgeCapture({ workDir: dirOf('cap-info'), aiAdapter: noAiAdapter(), netGuard: null, lock: false, notes: true }).info()
            assert.deepEqual(Object.keys(info), ['dirs', 'settings', 'clock', 'ai', 'domains', 'registry', 'identity', 'locale', 'lmdb', 'data', 'vocab', 'deadlineMs', 'lockStaleMs', 'startupWarnings', 'scheduleLimitMin', 'envFile', 'aiWorkspace', 'lockFile', 'collections'])
            assert.deepEqual(info.collections, ['docs', 'docTexts', 'sources', 'frontier', 'areas', 'notes'])
        })
    })

    describe('經抓取總組裝之端到端(內建調度層;條目指向死埠)', function() {

        const dead = { id: 't:dead', kind: 'api-openai-compat', baseURL: DEAD_BASE, model: 'm' }
        // 自寫子階段:以領域發現之席位呼叫一次(死埠必敗)
        const caller = { name: 'caller', run: async (ctx) => {
            const r = await ctx.deps.ai.callJson('q', () => true, { spec: ctx.deps.settings.capture.discover.ai, minAttemptMs: 10 })
            return stdReport({ detail: { ok: r.ok } })
        } }
        const build = (ai, lines) => createKnowledgeCapture({
            workDir: dirOf('e2e'), netGuard: null, lock: false, clock: FIXED_CLOCK,
            ai: { extraProviders: [dead], ...ai },
            capture: { discover: { ai: { use: 't:dead' } } },
            stages: [caller],
            logFactory: () => {
                const l = recLog()
                lines.push(l)
                return l
            },
        })

        it('ai.healthStreak 開啟:席位之呼叫整組皆敗達門檻 → 當輪日誌出現「供應商健康：」一行;未開(預設 0)者無任何「供應商」字樣', async () => {
            const on = []
            await build({ healthStreak: 1 }, on).run()
            const hit = on[0].lines.filter((l) => l.startsWith('WARN 供應商'))
            assert.equal(hit.length, 1, on[0].lines.join('\n'))
            assert.match(hit[0], /^WARN 供應商健康：t:dead 連續 1 次 \S+ 失敗（.*），降序冷卻$/)
            const off = []
            await build({}, off).run()
            assert.equal(off[0].lines.some((l) => l.includes('供應商')), false, off[0].lines.join('\n'))
        })

        it('ai.pools.oc 開啟且 opencode 日誌回報某免費模型當日額度用盡:每輪第一次呼叫前即降序,當輪日誌出現「供應商額度：」一行(條目、筆數、重置時)', async () => {
            const logFile = `${dirOf('oclog')}/opencode.log`
            fs.mkdirSync(path.dirname(logFile), { recursive: true })
            fs.writeFileSync(logFile, `timestamp=${new Date().toISOString()} level=ERROR providerID=opencode modelID=mimo-v2.6-flash-free error.error="AI_APICallError: Rate limit exceeded. Please try again later."\n`, 'utf8')
            const lines = []
            await build({ pools: { oc: { log: logFile, resetUtcHour: 0 } } }, lines).run()
            const hit = lines[0].lines.filter((l) => l.startsWith('WARN 供應商額度：'))
            assert.equal(hit.length, 1, lines[0].lines.join('\n'))
            assert.match(hit[0], /^WARN 供應商額度：oc:opencode\/mimo-v2\.6-flash-free 自 \d{2}:\d{2} 起 opencode 日誌回報當日額度用盡（1 筆，最近 \d{2}:\d{2}），本輪呼叫前降至鏈尾、照設定遞補，至每日重置（UTC 0 時）止$/)
        })

        it('ai.providerLimits:首選條目之 prompt 上限放不下 → 呼叫前剔除、改由遞補承接,當輪日誌出現「供應商能力：」一行(同一條目每實例一次:兩次呼叫仍一行)', async () => {
            const lines = []
            const flow = createKnowledgeCapture({
                workDir: dirOf('e2e-cap'), netGuard: null, lock: false, clock: FIXED_CLOCK,
                ai: { extraProviders: [dead, { ...dead, id: 't:dead2' }], providerLimits: { 't:dead': 5 } },
                capture: { discover: { ai: { use: 't:dead', fallback: ['t:dead2'] } } },
                stages: [caller, { ...caller, name: 'caller2' }],
                logFactory: () => {
                    const l = recLog()
                    lines.push(l)
                    return l
                },
            })
            await flow.run()
            const hit = lines[0].lines.filter((l) => l.startsWith('WARN 供應商'))
            assert.equal(hit.length, 1, lines[0].lines.join('\n'))
            assert.match(hit[0], /^WARN 供應商能力：t:dead 之 prompt 上限 5 字元，本輪有呼叫達 \d+ 字元而改由遞補承接（未 spawn）$/)
        })

        it('注入 cfg.aiAdapter:不建內建調度層(info().ai 即注入者、無 AI 工作區),即使設定開啟健康與額度亦無事件字樣', async () => {
            const lines = []
            const injected = noAiAdapter()
            const flow = createKnowledgeCapture({
                workDir: dirOf('e2e-inj'), netGuard: null, lock: false, clock: FIXED_CLOCK, aiAdapter: injected,
                ai: { healthStreak: 1, pools: { oc: { log: 'auto' } } },
                stages: [{ name: 's', run: async () => stdReport() }],
                logFactory: () => {
                    const l = recLog()
                    lines.push(l)
                    return l
                },
            })
            await flow.run()
            assert.deepEqual([flow.info().ai, flow.info().aiWorkspace], [injected, null])
            assert.equal(lines[0].lines.some((l) => l.includes('供應商')), false)
        })
    })
})
