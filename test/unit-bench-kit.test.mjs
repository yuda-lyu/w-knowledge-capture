// unit-bench-kit.test.mjs — AI 能力評分之角色化核心(bench/benchKit.mjs、bench/report.mjs)之單元測試:以替身角色(一頁多案之分類角色)與
//   替身調度層(不連外網、不呼叫真 AI)驗角色定義、分頁(內建與自訂)、逐案取項與判準、失敗歸類與停測(以頁為單位)、併發、進度事件、
//   詞彙注入(opt.vocab／--vocab)、命令列之擴充參數、評比表之多角色並存、報表之角色欄位、提示詞指紋、題組驗證,及領域發現角色與核心之關係
// 執行(套件根):node ./node_modules/mocha/bin/mocha.js --timeout 180000 test/unit-bench-kit.test.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import isobj from 'wsemi/src/isobj.mjs'
import {
    defineBenchRole, runBench, planBench, validateBenchCases, loadBenchCases, judgeBenchCase, benchFailOf, BENCH_FAIL_KINDS,
    benchPromptFpOf, DEFAULT_FREE_MODELS, freeModelsOf, parseBenchArgs, benchUsageOf, runBenchCli, benchArgPint,
    benchModelsCsv, benchCasesCsv, benchMarkdown, writeBenchReport, mergeBenchBoard, BENCH_BOARD_HEADER, BENCH_FAIL_COLUMNS,
    typeName, chunk, groupBy, vocabKeyOf, paginateByVocab, inputVocabProblemsOf, domainNeedsOf, noVerdict, benchPintOf, batchOption, benchVoteMissingOf,
} from '../src/bench/benchKit.mjs'
import * as area from '../src/bench/areaBench.mjs'
import { createAreaDomain } from '../src/domain/areaDomain.mjs'
import { sha1 } from '../src/core/util/text.mjs'
import { parseCsv } from './tools/testKit.mjs'

// 測試暫存(cwd 相對;帶 pid 使並行互不干擾;測完即刪)
const TMP = path.resolve(`test/_tmp/unit-bench-kit-${process.pid}`)

/** 固定時鐘(報表檔名與評比時間可斷言) */
const FIXED = { timeZone: 'Fixed/Test', iso8: () => '2031-03-04T05:06:07+08:00', stamp8: () => '20310304050607', date8: () => '2031-03-04', day8: () => '20310304' }

/**
 * 替身 domain(領域中立):首句稱呼取 vocab.kbLabel、範圍句取 vocab.scope;只認此二鍵(不認得即拋——同正式詞彙表之規則)
 *
 * @param {Object} [opt={}] 輸入 { vocab }
 * @returns {Object} 回傳 { kb, buildPrompt(texts), isValidItem(it) }
 */
function createTopicDomain({ vocab } = {}) {
    const v = isobj(vocab) ? vocab : {}
    const bad = Object.keys(v).filter((k) => !['kbLabel', 'scope'].includes(k))
    if (bad.length) throw new Error(`vocab 含不認得之鍵：${bad.join('、')}`)
    const kb = v.kbLabel || '知識庫'
    return {
        kb,
        buildPrompt: (texts) => `你是${kb}的分類員${v.scope ? `（範圍：${v.scope}）` : ''}。逐篇判 yes／no，只回 JSON 陣列：\n${texts.map((t, i) => `${i + 1}. 【${t}】`).join('\n')}`,
        isValidItem: (it) => isobj(it) && typeof it.reason === 'string' && it.reason.trim() !== '',
    }
}

/** 替身角色之定義:一頁 3 案之 yes／no 分類(提示詞以 domain 組;依頁內序號取項;理由空白為不合契約) */
const TOPIC_DEF = {
    id: 'topic',
    name: '題目分類(topic)',
    title: '題目分類 AI 能力評分',
    std: 'TS1',
    v: 2,
    pageSize: 3,
    caseProblems: (c) => [
        ...(typeof c.input?.text === 'string' && c.input.text ? [] : ['缺 input.text']),
        ...(['yes', 'no'].includes(c.expect?.label) ? [] : ['expect.label 須為 yes／no']),
    ],
    expectOf: (c) => c.expect.label,
    caseFieldsOf: (c) => ({ text: c.input.text }),
    domainOf: (vocab) => createTopicDomain({ vocab }),
    domainProblem: (d) => (isobj(d) && typeof d.buildPrompt === 'function' && typeof d.isValidItem === 'function' ? '' : '須具 buildPrompt 與 isValidItem'),
    promptOf: (cases, domain) => domain.buildPrompt(cases.map((c) => c.input.text)),
    check: (data) => (Array.isArray(data) ? true : '須為 JSON 陣列'),
    verdictOf: (data, c, at) => {
        const it = data.find((x) => x?.index === at.index)
        if (!it) return { cls: null, valid: false, problem: `回覆無 index ${at.index} 之項`, fields: { label: '', reason: '' } }
        const label = String(it.label ?? '')
        if (!['yes', 'no'].includes(label)) return { cls: null, valid: false, problem: `label 不合（${label}）`, fields: { label, reason: '' } }
        return { cls: label, valid: at.domain.isValidItem(it), problem: '', fields: { label, reason: String(it.reason ?? '') } }
    },
    blankFields: { label: '', reason: '' },
    detailOf: (r) => (r.reason ? `（${r.reason}）` : ''),
    report: { caseColumns: [{ name: '文字', key: 'text', md: true }], runColumns: [{ name: '標記', key: 'label' }, { name: '理由', key: 'reason' }] },
}
const topicRole = defineBenchRole(TOPIC_DEF)
const variant = (over) => defineBenchRole({ ...TOPIC_DEF, ...over })

/** 自訂分頁之角色:無自帶詞彙之案每 roleOpt.pageSize(預設 3)案一頁(以案 id 列),自帶詞彙之案各自一頁(以案物件列)排在最後;命令列 --page-size */
const groupRole = variant({
    id: 'group',
    name: '分群分類(group)',
    title: '分群分類 AI 能力評分',
    pageSize: undefined,
    paginate: (cases, ctx) => {
        const n = ctx.roleOpt.pageSize || 3
        const plain = cases.filter((c) => !c.input.vocab)
        const pages = []
        for (let i = 0; i < plain.length; i += n) pages.push(plain.slice(i, i + n).map((c) => c.id))
        for (const c of cases.filter((x) => x.input.vocab)) pages.push([c])
        return pages
    },
    cli: { command: 'node src/bench/cli.mjs group', options: [{ flag: '--page-size', key: 'pageSize', arg: '<n>', help: '一頁幾案(預設 3)', parse: benchArgPint }] },
})

/** 一頁多案之題組(應然:yes＝天文);t5 自帶詞彙 */
const TOPIC = {
    std: 'TS1',
    v: 2,
    note: '單元測試用之一頁多案題組',
    cases: [
        { id: 't1', input: { text: '行星大氣光譜' }, expect: { label: 'yes' }, why: '天文' },
        { id: 't2', input: { text: '麵包發酵溫度' }, expect: { label: 'no' }, why: '烹飪' },
        { id: 't3', input: { text: '系外行星凌日' }, expect: { label: 'yes' }, why: '天文' },
        { id: 't4', holdout: true, input: { text: '海浪週期' }, expect: { label: 'no' }, why: '海洋' },
        { id: 't5', type: 'scoped', input: { text: '星系旋臂', vocab: { scope: '天文' } }, expect: { label: 'yes' }, why: '範圍內' },
        { id: 't6', input: { text: '彗星軌道' }, expect: { label: 'yes' }, why: '天文' },
        { id: 't7', holdout: true, input: { text: '茶葉烘焙' }, expect: { label: 'no' }, why: '烹飪' },
    ],
}
const TRUTH = Object.fromEntries(TOPIC.cases.map((c) => [c.input.text, c.expect.label]))

/** 依頁之各篇組回覆 */
const reply = (texts, labelOf, reason = '依據主題') => texts.map((t, i) => ({ index: i + 1, label: labelOf(t, i), reason }))
const right = (texts) => reply(texts, (t) => TRUTH[t])
const TIMEOUT = { fail: { error: 'TIMEOUT after 300000ms', errors: ['x:timeout(300.0s)'] } }

/**
 * 替身調度層:自提示詞取該頁之各篇(「N. 【…】」行),script[模型](各篇, 第幾次問到此頁, 提示詞) => 回覆;回覆為 JSON 值、
 *   { fail:{ error, errors, skipped, events } }(失敗結果;events 經 callOpt.onEvent 送出)或 { throw:訊息 }。記錄每次呼叫並統計同時進行之呼叫數
 *
 * @param {Object} script 輸入 { 模型: 函數或固定回覆 }
 * @param {Object} [o={}] 輸入 { delayMs, chainFor }
 * @returns {Object} 回傳替身 { calls, peak, callJson, chainFor? }
 */
function pageStub(script, o = {}) {
    const calls = []
    const asked = new Map()
    const perModel = new Map()
    const peak = { all: 0, perModel: 0 }
    let inflight = 0
    return {
        calls,
        peak,
        ...(o.chainFor ? { chainFor: o.chainFor } : {}),
        callJson: async (prompt, check, callOpt) => {
            const model = callOpt?.spec?.use
            const texts = [...String(prompt).matchAll(/^\d+\. 【(.+?)】/gm)].map((m) => m[1])
            const key = `${model}|${texts.join('\u0001')}`
            const k = (asked.get(key) || 0) + 1
            asked.set(key, k)
            calls.push({ model, texts, label: texts[0], k, prompt, spec: callOpt?.spec })
            inflight++
            perModel.set(model, (perModel.get(model) || 0) + 1)
            peak.all = Math.max(peak.all, inflight)
            peak.perModel = Math.max(peak.perModel, perModel.get(model))
            try {
                await new Promise((r) => setTimeout(r, o.delayMs ?? 2))
                const fn = script[model]
                const out = typeof fn === 'function' ? fn(texts, k, prompt) : fn
                if (out && out.throw) throw new Error(out.throw)
                if (out && out.fail) {
                    for (const ev of out.fail.events || []) callOpt?.onEvent?.(ev)
                    return { ok: false, data: null, error: out.fail.error || '', providerId: '', attempts: 1, skipped: out.fail.skipped === true, errors: out.fail.errors || [] }
                }
                let c
                try {
                    c = check(out)
                }
                catch (e) {
                    c = `check 拋錯：${e.message}`
                }
                if (c !== true) return { ok: false, data: null, error: 'OUTPUT_VALIDATION_FAILED', providerId: '', attempts: 1, skipped: false, errors: [`${model}:validation(0.0s)：${c}`] }
                return { ok: true, data: out, error: '', providerId: `${model}#p`, attempts: 1, skipped: false, errors: [] }
            }
            finally {
                inflight--
                perModel.set(model, perModel.get(model) - 1)
            }
        },
    }
}

/** 領域發現之替身:一律判涵蓋 */
const COV_ALL = () => [{ index: 1, covered: true, why: '既有領域已涵蓋' }]
const areaStub = (script = { m: COV_ALL, n: COV_ALL, good: COV_ALL }) => pageStub(script)

const modelOf = (r, model) => r.models.find((x) => x.model === model)
const caseOf = (r, model, id) => modelOf(r, model).cases.find((c) => c.id === id)

describe('unit-bench-kit', function() {

    after(() => {
        fs.rmSync(TMP, { recursive: true, force: true })
    })

    it('defineBenchRole:缺必給函數、不認得之鍵、id／name 形式、pageSize 與 paginate 並給、std／v／models 形式、blankFields 共通欄位、report／cli 形狀、擴充選項與共用參數重名 → 拋錯並列出全部問題;合格者補預設、凍結、冪等', () => {
        assert.throws(() => defineBenchRole(null), /defineBenchRole 需要角色定義物件/)
        assert.throws(() => defineBenchRole({ id: 'Bad_Id', name: ' ', bogus: 1, expectOf: 'x' }), (e) => {
            for (const p of [/含不認得之鍵：bogus/, /id 須為小寫英文字母開頭/, /name 須為非空字串/, /expectOf 須為函數/, /缺 domainOf（函數）/, /缺 promptOf（函數）/, /缺 verdictOf（函數）/]) assert.match(e.message, p)
            assert.match(e.message, /^角色定義不合格（Bad_Id；7 項）/)
            return true
        })
        const probs = (over) => {
            try {
                variant(over)
                return ''
            }
            catch (e) {
                return e.message
            }
        }
        assert.match(probs({ pageSize: 2, paginate: () => [] }), /pageSize 與 paginate 擇一/)
        assert.match(probs({ pageSize: 0 }), /pageSize 須為正整數/)
        assert.match(probs({ std: [] }), /std 須為檢定標準 id 字串或其非空陣列/)
        assert.match(probs({ v: 1.5 }), /v 須為正整數/)
        assert.match(probs({ models: [] }), /models 須為非空之條目 id 字串陣列/)
        assert.match(probs({ check: 'x' }), /check 須為函數/)
        assert.match(probs({ blankFields: { reply: '' } }), /blankFields 不得含共通欄位：reply/)
        assert.match(probs({ report: { criterion: [] } }), /report 含不認得之鍵：criterion/)
        assert.match(probs({ report: { runColumns: [{ name: '甲', key: 'labl' }] } }), /report\.runColumns\[0\]\.key「labl」不在 blankFields/, '每回欄之鍵打錯即拋')
        assert.match(probs({ report: { caseColumns: [{ name: '甲' }] } }), /report\.caseColumns\[0\] 須為 \{ name, key, md\? \}/)
        assert.match(probs({ cli: { options: [{ flag: '--runs', key: 'r' }] } }), /cli\.options\[0\]\.flag「--runs」與共用參數重名/)
        assert.match(probs({ cli: { options: [{ flag: '--x', key: 'vocab' }] } }), /cli\.options\[0\]\.key「vocab」與共用參數之結果鍵重名/)
        assert.match(probs({ cli: { options: [{ flag: '--x', key: 'a' }, { flag: '--x', key: 'b' }] } }), /cli\.options\[1\]\.flag「--x」重複/)
        assert.match(probs({ cli: { bogus: 1 } }), /cli 含不認得之鍵：bogus/)
        // 合格者:補預設、凍結、冪等
        const min = defineBenchRole({ id: 'min', name: '最小角色', expectOf: () => 'a', domainOf: () => ({}), promptOf: () => 'p', verdictOf: () => ({ cls: 'a', valid: true, problem: '', fields: {} }) })
        assert.deepEqual([min.title, min.runnerName, min.pageSize, min.paginate, min.v, min.casesFile, min.std], ['最小角色 AI 能力評分', 'runBench', 1, null, null, '', []])
        assert.equal(min.models, DEFAULT_FREE_MODELS, '預設受測名單')
        assert.equal(min.report.criteria.length, 2, '預設判準說明')
        assert.deepEqual([min.check([1]), min.detailOf({}), min.mismatchNote({ cls: 'b' }, 'a'), min.cli.command], [true, '', '判 b，應然 a', 'node src/bench/cli.mjs'])
        assert.equal(min.vocabOf({ input: { vocab: { a: 1 } } }).a, 1, '預設取 input.vocab')
        assert.ok(Object.isFrozen(min) && Object.isFrozen(min.report) && Object.isFrozen(min.cli.options) && Object.isFrozen(min.blankFields))
        assert.equal(defineBenchRole(min), min, '冪等')
        assert.equal(topicRole.mismatchNote({ cls: 'yes', reason: '因' }, 'no'), '判 yes（因），應然 no', '預設之不符說明帶補充顯示')
    })

    it('分頁:pageSize 3 → 依題組順序每 3 案一頁,遇自帶詞彙之案即換頁(不改案序);每回每頁一次呼叫;同頁各案依頁內序號取項、共用該頁之耗時與成交條目;呼叫以頁計、合契約以案次計', async () => {
        const plan = planBench(topicRole, { cases: TOPIC })
        assert.deepEqual(plan.pages.map((p) => p.ids), [['t1', 't2', 't3'], ['t4'], ['t5'], ['t6', 't7']])
        assert.match(plan.pages[2].prompt, /（範圍：天文）/, '自帶詞彙之案以其詞彙組提示詞')
        assert.doesNotMatch(plan.pages[0].prompt, /範圍/)
        const ai = pageStub({ good: right })
        const r = await runBench(topicRole, { models: ['good'], cases: TOPIC, aiAdapter: ai, clock: FIXED })
        assert.deepEqual(ai.calls.map((c) => `${c.texts.join('+')}#${c.k}`), [
            '行星大氣光譜+麵包發酵溫度+系外行星凌日#1', '海浪週期#1', '星系旋臂#1', '彗星軌道+茶葉烘焙#1',
            '行星大氣光譜+麵包發酵溫度+系外行星凌日#2', '海浪週期#2', '星系旋臂#2', '彗星軌道+茶葉烘焙#2',
        ])
        const m = modelOf(r, 'good')
        assert.deepEqual(m.score, { pass: 7, total: 7, rate: 1 })
        assert.deepEqual([m.general.total, m.holdout.total], [5, 2])
        assert.deepEqual([m.calls.sent, m.calls.ok, m.calls.failed, m.calls.notRun], [8, 8, 0, 0], '呼叫以頁計')
        assert.deepEqual(m.contract, { valid: 14, total: 14, rate: 1 }, '合契約以案次計')
        const recs = ['t1', 't2', 't3'].map((id) => caseOf(r, 'good', id).runs[0])
        assert.deepEqual(recs.map((x) => [x.cls, x.label]), [['yes', 'yes'], ['no', 'no'], ['yes', 'yes']], '依頁內序號取各案之項')
        assert.equal(new Set(recs.map((x) => x.ms)).size, 1, '同頁共用耗時')
        assert.deepEqual(recs.map((x) => x.providerId), ['good#p', 'good#p', 'good#p'])
        assert.deepEqual(m.cases.map((c) => c.id), ['t1', 't2', 't3', 't4', 't5', 't6', 't7'], '結果依題組順序')
        assert.deepEqual([caseOf(r, 'good', 't2').text, caseOf(r, 'good', 't5').type, caseOf(r, 'good', 't4').holdout], ['麵包發酵溫度', 'scoped', true], '角色之案欄位與共通欄位')
        assert.deepEqual(r.meta, { std: 'TS1', v: 2, note: TOPIC.note, cases: 7, holdout: 2, runs: 2, models: ['good'], promptFp: plan.promptFp, startedAt: FIXED.iso8(), endedAt: FIXED.iso8(), stamp: FIXED.stamp8(), timeoutMs: null, concurrency: 2, stopAfterFails: 2 })
    })

    it('項編號跨頁連續(defineBenchRole 之 JSDoc):promptOf 與 check 之 ctx 帶 base(該頁首案之項編號減一;check 另帶該頁之 domain)、verdictOf 之 at 帶 seq(依分頁之序 1 起);planBench 之頁附 base;不讀新鍵之角色行為不變', async () => {
        // 規則:benchKit.prepare——票類角色以全域編號作答與取票,不各自以 WeakMap 記編號
        const seen = { prompt: [], check: [], verdict: [] }
        const role = variant({
            promptOf: (cases, domain, ctx) => (seen.prompt.push([cases.map((c) => c.id), ctx.base, Object.keys(ctx.roleOpt).length]), TOPIC_DEF.promptOf(cases, domain, ctx)),
            check: (data, cases, ctx) => (seen.check.push([cases.map((c) => c.id), ctx.base, ctx.domain === cases[0].__d]), Array.isArray(data) ? true : '須為 JSON 陣列'),
            verdictOf: (data, c, at) => (seen.verdict.push([c.id, at.index, at.seq]), TOPIC_DEF.verdictOf(data, c, at)),
        })
        const plan = planBench(role, { cases: TOPIC })
        assert.deepEqual(plan.pages.map((p) => [p.ids, p.base]), [[['t1', 't2', 't3'], 0], [['t4'], 3], [['t5'], 4], [['t6', 't7'], 5]], 'planBench 之頁附 base')
        assert.deepEqual(seen.prompt, [[['t1', 't2', 't3'], 0, 0], [['t4'], 3, 0], [['t5'], 4, 0], [['t6', 't7'], 5, 0]], 'promptOf 之 ctx.base')
        seen.prompt.length = 0
        const ai = pageStub({ good: right })
        const r = await runBench(role, { models: ['good'], cases: TOPIC, aiAdapter: ai, clock: FIXED, runs: 1 })
        assert.equal(modelOf(r, 'good').score.pass, 7)
        assert.deepEqual(seen.check.map((x) => [x[0], x[1]]), [[['t1', 't2', 't3'], 0], [['t4'], 3], [['t5'], 4], [['t6', 't7'], 5]], 'check 之 ctx.base')
        assert.deepEqual(seen.verdict, [['t1', 1, 1], ['t2', 2, 2], ['t3', 3, 3], ['t4', 1, 4], ['t5', 1, 5], ['t6', 1, 6], ['t7', 2, 7]], 'verdictOf 之 at.seq 跨頁連續、at.index 頁內')
        // check 之 ctx.domain＝該頁組提示詞之 domain(自帶詞彙之案為其自建之 domain)
        const domains = []
        const role2 = variant({ check: (data, cases, ctx) => (domains.push(ctx.domain), true) })
        await runBench(role2, { models: ['good'], cases: TOPIC, aiAdapter: pageStub({ good: right }), clock: FIXED, runs: 1 })
        assert.equal(domains.length, 4)
        assert.ok(domains.every((d) => isobj(d) && typeof d.buildPrompt === 'function'))
        assert.notEqual(domains[2], domains[0], '自帶詞彙之頁為其自建之 domain')
        assert.equal(domains[1], domains[0], '未自帶詞彙之頁共用預設 domain')
    })

    it('verdictOf 之 at 帶 base(該頁首案之項編號減一＝該頁 promptOf 之 ctx.base;各案 at.seq − at.index 恆等於之)——角色不必由 seq 反推基數', async () => {
        // 規則:benchKit.callPage 之 at(只加欄位;不讀此鍵之角色行為不變)
        const bases = []
        const at = []
        const role = variant({
            promptOf: (cases, domain, ctx) => (bases.push([cases.map((c) => c.id).join(','), ctx.base]), TOPIC_DEF.promptOf(cases, domain, ctx)),
            verdictOf: (data, c, a) => (at.push([c.id, a.base, a.seq - a.index]), TOPIC_DEF.verdictOf(data, c, a)),
        })
        const r = await runBench(role, { models: ['good'], cases: TOPIC, aiAdapter: pageStub({ good: right }), clock: FIXED, runs: 1 })
        assert.equal(modelOf(r, 'good').score.pass, 7)
        assert.deepEqual(at, [['t1', 0, 0], ['t2', 0, 0], ['t3', 0, 0], ['t4', 3, 3], ['t5', 4, 4], ['t6', 5, 5], ['t7', 5, 5]])
        const baseOfPage = new Map(bases.map(([ids, b]) => [ids, b]))
        assert.deepEqual([...baseOfPage.values()], [0, 3, 4, 5], 'at.base 與該頁之 ctx.base 同值')
    })

    it('paginateByVocab:同詞彙分組(組序依首見、組內題組原序)後每頁 size 案;未帶詞彙者同組;自訂分組鍵;size 非正整數即拋', () => {
        // 規則:benchKit.paginateByVocab(角色之 paginate 共用一份:groupBy(分組鍵) → chunk)
        const cs = [{ id: 'a' }, { id: 'b', input: { vocab: { k: 1 } } }, { id: 'c' }, { id: 'd' }, { id: 'e', input: { vocab: { k: 1 } } }]
        const ids = (pages) => pages.map((p) => p.map((c) => c.id))
        assert.deepEqual(ids(paginateByVocab(cs, 2)), [['a', 'c'], ['d'], ['b', 'e']])
        assert.deepEqual(ids(paginateByVocab(cs, 10)), [['a', 'c', 'd'], ['b', 'e']])
        assert.deepEqual(ids(paginateByVocab(cs, 2, (c) => c.id < 'c')), [['a', 'b'], ['c', 'd'], ['e']])
        assert.deepEqual(paginateByVocab([], 3), [])
        for (const bad of [0, -1, 1.5, '2', null]) assert.throws(() => paginateByVocab(cs, bad), /paginateByVocab 之 size 須為正整數/)
    })

    it('逐次呼叫選項(callOpt):併入調度層 callJson 之第三參數(與正式呼叫同一組選項,如陣列輸出之 acceptTruncated);未給即無附加鍵;含 spec／onEvent 或非物件 → 定義期拋錯', async () => {
        const seen = []
        const ai = pageStub({ good: right })
        const spy = { callJson: (p, c, o) => { seen.push(o); return ai.callJson(p, c, o) } }
        const role = variant({ callOpt: { acceptTruncated: true, preview: 'x' } })
        const r = await runBench(role, { models: ['good'], cases: TOPIC, runs: 1, aiAdapter: spy, clock: FIXED })
        assert.deepEqual(modelOf(r, 'good').score, { pass: 7, total: 7, rate: 1 })
        assert.ok(seen.length > 0 && seen.every((o) => o.acceptTruncated === true && o.preview === 'x' && o.spec?.use === 'good' && typeof o.onEvent === 'function'), '每次呼叫皆帶角色之選項與核心之席位、事件')
        assert.ok(Object.isFrozen(role.callOpt))
        const seen2 = []
        await runBench(topicRole, { models: ['good'], cases: TOPIC, runs: 1, aiAdapter: { callJson: (p, c, o) => { seen2.push(o); return ai.callJson(p, c, o) } }, clock: FIXED })
        assert.ok(seen2.every((o) => Object.keys(o).sort().join(',') === 'onEvent,spec'), '未給 callOpt 即只有席位與事件')
        assert.throws(() => variant({ callOpt: { spec: { use: 'x' } } }), /callOpt 不得含 spec/)
        assert.throws(() => variant({ callOpt: { onEvent: () => {} } }), /callOpt 不得含 onEvent/)
        assert.throws(() => variant({ callOpt: 'x' }), /callOpt 須為物件/)
    })

    describe('自訂呼叫(角色之 call)', function() {

        // 耗時歸零(兩次評分之結果比對用)
        const zeroMs = (r) => JSON.parse(JSON.stringify(r, (k, v) => (['ms', 'avgMs', 'avgMsAll'].includes(k) ? 0 : v)))
        // 以 call 重現預設之呼叫(adapter.callJson 收同一組材料)
        const sameAsDefault = (adapter, prompt, ctx) => adapter.callJson(prompt, ctx.check, { ...ctx.callOpt, spec: ctx.spec, onEvent: ctx.onEvent })

        it('定義:給了須為函數(否則定義期拋錯並列入問題);未給為 null;凍結之角色帶之', () => {
            assert.throws(() => variant({ call: 'x' }), /call 須為函數/)
            assert.throws(() => variant({ call: {} }), /^Error: 角色定義不合格（topic；1 項）：call 須為函數$/)
            assert.equal(topicRole.call, null)
            const fn = async () => ({ ok: false })
            assert.equal(variant({ call: fn }).call, fn)
        })

        it('被呼叫之參數:(調度層, 該頁之提示詞, { spec, check, callOpt, onEvent });spec 同預設(受測模型、不遞補、--timeout);callOpt 為角色之同一物件;check 帶入該頁之案;每回每頁一次', async () => {
            const ai = pageStub({ good: right })
            const seen = []
            const pageCases = []
            const role = variant({
                callOpt: { acceptTruncated: true },
                check: (data, cases) => {
                    pageCases.push(cases.map((c) => c.id))
                    return Array.isArray(data) ? true : '須為 JSON 陣列'
                },
                call: (adapter, prompt, ctx) => {
                    seen.push({ adapter, prompt, ctx })
                    return sameAsDefault(adapter, prompt, ctx)
                },
            })
            await runBench(role, { models: ['good'], cases: TOPIC, runs: 1, aiAdapter: ai, clock: FIXED, timeoutMs: 1234 })
            const plan = planBench(role, { cases: TOPIC })
            assert.equal(seen.length, plan.pages.length, '每回每頁一次')
            seen.forEach((s, k) => {
                assert.equal(s.adapter, ai, '原樣交調度層')
                assert.equal(s.prompt, plan.pages[k].prompt, '該頁之提示詞')
                assert.deepEqual(Object.keys(s.ctx).sort(), ['callOpt', 'check', 'onEvent', 'spec'])
                assert.deepEqual(s.ctx.spec, { use: 'good', fallback: [], timeoutMs: 1234 })
                assert.equal(s.ctx.callOpt, role.callOpt, '角色之 callOpt(同一凍結物件)')
                assert.equal(typeof s.ctx.onEvent, 'function')
            })
            assert.deepEqual(pageCases, plan.pages.map((p) => p.ids), 'ctx.check 帶入該頁之案')
            assert.ok(ai.calls.every((c) => c.spec?.use === 'good'))
        })

        it('回傳經同一判定流程:以 call 重現 callJson 時結果與預設角色逐欄相同(成功、不合 check、逾時、限流停測)', async () => {
            const script = { good: right, garbled: () => 'not-array', slow: () => TIMEOUT, limited: { fail: { error: 'FreeUsageLimitError: Rate limit exceeded', errors: [] } } }
            const opt = { models: ['good', 'garbled', 'slow', 'limited'], cases: TOPIC, clock: FIXED, concurrency: 1 }
            const viaCall = await runBench(variant({ call: sameAsDefault }), { ...opt, aiAdapter: pageStub(script) })
            const viaDefault = await runBench(topicRole, { ...opt, aiAdapter: pageStub(script) })
            assert.deepEqual(zeroMs(viaCall), zeroMs(viaDefault))
            assert.deepEqual(viaCall.models.map((m) => [m.model, m.score.pass, m.stopped !== '']), [['good', 7, false], ['garbled', 0, false], ['slow', 0, true], ['limited', 0, true]])
        })

        it('事件交失敗歸類(onEvent 收冷卻事件 → 限流即停);call 拋錯同調度層拋錯(該頁各案記呼叫失敗,評分不中斷)', async () => {
            const cooled = variant({
                call: async (adapter, prompt, ctx) => {
                    ctx.onEvent({ type: 'cooled', providerId: 'm', error: 'HTTP 429', cooldownMs: 1, n: 1, reason: 'rate-limit' })
                    return { ok: false, data: null, error: 'HTTP 429', providerId: '', attempts: 1, skipped: false, errors: [] }
                },
            })
            const r = await runBench(cooled, { models: ['m'], cases: TOPIC, runs: 1, aiAdapter: {}, clock: FIXED })
            assert.deepEqual([caseOf(r, 'm', 't1').runs[0].failKind, /額度用盡或限流/.test(modelOf(r, 'm').stopped)], ['limit', true])
            const boom = variant({
                call: async () => {
                    throw new Error('壞了')
                },
            })
            const thrownCall = await runBench(boom, { models: ['m'], cases: TOPIC, runs: 1, aiAdapter: {}, clock: FIXED })
            const thrownJson = await runBench(topicRole, { models: ['m'], cases: TOPIC, runs: 1, aiAdapter: { callJson: async () => { throw new Error('壞了') } }, clock: FIXED })
            assert.deepEqual(zeroMs(thrownCall), zeroMs(thrownJson), '與 callJson 拋錯之處理相同')
            assert.deepEqual([caseOf(thrownCall, 'm', 't1').runs[0].callFail, caseOf(thrownCall, 'm', 't1').runs[0].failKind, caseOf(thrownCall, 'm', 't1').runs[0].error], [true, 'error', '調度層拋錯：壞了'])
        })

        it('調度層之形狀:給了 call 者只要求為物件(不需 callJson);非物件即拋或停測;未給 call 者照舊須具 callJson', async () => {
            const role = variant({ call: async (adapter, prompt, ctx) => ({ ok: true, data: right([...prompt.matchAll(/^\d+\. 【(.+?)】/gm)].map((m) => m[1])), error: '', providerId: `${ctx.spec.use}#w`, attempts: 1, skipped: false, errors: [] }) })
            const r = await runBench(role, { models: ['m'], cases: TOPIC, runs: 1, aiAdapter: { getWkf: () => ({}) }, clock: FIXED })
            assert.deepEqual(modelOf(r, 'm').score, { pass: 7, total: 7, rate: 1 }, '無 callJson 之調度層亦可')
            await assert.rejects(runBench(role, { models: ['m'], cases: TOPIC, aiAdapter: 5 }), /需要 aiAdapter（調度層物件；由角色之 call 呼叫）或 adapterOf/)
            assert.equal(modelOf(await runBench(role, { models: ['m'], cases: TOPIC, runs: 1, adapterOf: () => 'x', clock: FIXED }), 'm').stopped, '調度層非物件')
            await assert.rejects(runBench(topicRole, { models: ['m'], cases: TOPIC, aiAdapter: { getWkf: () => ({}) } }), /需要 aiAdapter（具 callJson 之調度層）或 adapterOf/, '未給 call:字樣照舊')
            assert.equal(modelOf(await runBench(topicRole, { models: ['m'], cases: TOPIC, runs: 1, adapterOf: () => ({}), clock: FIXED }), 'm').stopped, '調度層不具 callJson')
        })

        it('runBenchCli:角色給了 call 時,內建調度層另開工作流入口(call 收到之調度層具 getWkf／seatSpec);call 只查看調度層,不呼叫任何 AI', async () => {
            fs.mkdirSync(TMP, { recursive: true })
            const casesFile = path.join(TMP, 'wf-cases.json')
            fs.writeFileSync(casesFile, JSON.stringify({ std: 'TS1', v: 2, cases: [{ id: 'w1', input: { text: '行星大氣光譜' }, expect: { label: 'yes' }, why: '天文' }] }), 'utf8')
            const got = []
            const wf = variant({
                id: 'wf',
                pageSize: 1,
                call: async (adapter, prompt, ctx) => {
                    got.push([typeof adapter.callJson, typeof adapter.getWkf, typeof adapter.seatSpec])
                    const s = adapter.seatSpec({ use: ctx.spec.use }, prompt.length)
                    return { ok: true, data: [{ index: 1, label: s?.use === ctx.spec.use ? 'yes' : 'no', reason: '工作流入口可用' }], error: '', providerId: ctx.spec.use, attempts: 1, skipped: false, errors: [] }
                },
            })
            const outDir = path.join(TMP, 'wf-out')
            const res = await runBenchCli(wf, ['--models', 'oc:opencode/big-pickle', '--cases', casesFile, '--out', outDir, '--runs', '1'], { log: { info: () => {} } })
            assert.deepEqual(got, [['function', 'function', 'function']])
            assert.deepEqual(modelOf(res.result, 'oc:opencode/big-pickle').score, { pass: 1, total: 1, rate: 1 })
            assert.ok(fs.existsSync(res.report.files.md), '報表照常落檔')
            assert.equal(fs.existsSync(path.join(outDir, 'ai-workspace')), false, 'AI 工作目錄結束後移除')
        })
    })

    it('逐案取項:回覆缺某序號之項 → 該案無裁決並註明(同頁他案照常);label 不合 → 無裁決;理由空白 → 類別照計而不合契約;verdictOf 拋錯 → 該案該回無裁決,評分不中斷', async () => {
        const partial = (texts) => right(texts).filter((x) => !(texts.length === 3 && x.index === 2))
        const sloppy = (texts) => texts.map((t, i) => ({ index: i + 1, label: TRUTH[t], reason: t === '海浪週期' ? ' ' : '依據' }))
        const weird = (texts) => reply(texts, (t) => (t === '彗星軌道' ? 'maybe' : TRUTH[t]))
        const r = await runBench(topicRole, { models: ['partial', 'sloppy', 'weird'], cases: TOPIC, aiAdapter: pageStub({ partial, sloppy, weird }), clock: FIXED })
        const p = caseOf(r, 'partial', 't2')
        assert.deepEqual(p.runs.map((x) => x.cls), [null, null])
        assert.match(p.note, /^第 1 回無可用之裁決（回覆無 index 2 之項；回覆「\[\{"index":1,/)
        assert.deepEqual([caseOf(r, 'partial', 't1').pass, caseOf(r, 'partial', 't3').pass], [true, true])
        assert.equal(caseOf(r, 'sloppy', 't4').pass, true, '類別對即通過(合契約只列資訊)')
        assert.deepEqual(modelOf(r, 'sloppy').contract, { valid: 12, total: 14, rate: 12 / 14 })
        assert.equal(caseOf(r, 'sloppy', 't4').runs[0].valid, false)
        assert.match(caseOf(r, 'weird', 't6').note, /第 1 回無可用之裁決（label 不合（maybe）；回覆「\[\{"index":1,"label":"maybe"/)
        const boom = variant({
            verdictOf: (data, c, at) => {
                if (c.id === 't2') throw new Error('判定壞了')
                return TOPIC_DEF.verdictOf(data, c, at)
            },
        })
        const r2 = await runBench(boom, { models: ['good'], cases: TOPIC, aiAdapter: pageStub({ good: right }), clock: FIXED })
        assert.match(caseOf(r2, 'good', 't2').runs[0].problem, /^判定拋錯：判定壞了/)
        assert.deepEqual([caseOf(r2, 'good', 't2').pass, modelOf(r2, 'good').score.pass], [false, 6], '其餘案照常')
        const odd = variant({ verdictOf: () => 'x' })
        const r3 = await runBench(odd, { models: ['good'], cases: TOPIC, aiAdapter: pageStub({ good: right }), clock: FIXED, runs: 1 })
        assert.match(caseOf(r3, 'good', 't1').runs[0].problem, /判定未回傳物件/)
    })

    it('逐案判準(judgeBenchCase):各回皆＝應然才通過;未呼叫、呼叫失敗、無裁決、類別不符逐回註明;各回不一致與回數不足另列;missNote 拋錯回預設', () => {
        assert.deepEqual(judgeBenchCase('yes', [{ run: 1, cls: 'yes' }, { run: 2, cls: 'yes' }], 2), { pass: true, consistent: true, note: '' })
        const both = judgeBenchCase('yes', [{ run: 1, cls: 'no' }, { run: 2, cls: 'no' }], 2)
        assert.deepEqual(both, { pass: false, consistent: true, note: '第 1 回判 no，應然 yes；第 2 回判 no，應然 yes' }, '兩回一致而錯者不通過')
        const mixed = judgeBenchCase('yes', [
            { run: 1, notRun: true, cls: null, error: '停測' },
            { run: 2, callFail: true, failKind: 'timeout', error: 'TIMEOUT', cls: null, reply: '' },
            { run: 3, cls: null, problem: '無此項', reply: '[]' },
            { run: 4, cls: 'no' },
        ], 5, (x, e) => `判為${x.cls}而非${e}`)
        assert.equal(mixed.note, '第 1 回未呼叫（停測）；第 2 回呼叫失敗（逾時：TIMEOUT）；第 3 回無可用之裁決（無此項；回覆「[]」）；第 4 回判為no而非yes；只有 4/5 回')
        assert.equal(mixed.consistent, false)
        assert.match(judgeBenchCase('yes', [{ run: 1, cls: 'yes' }, { run: 2, cls: 'no' }], 2).note, /^第 2 回判 no，應然 yes；各回不一致$/)
        assert.equal(judgeBenchCase('yes', [{ run: 1, cls: 'no' }], 1, () => { throw new Error('x') }).note, '第 1 回判 no，應然 yes')
        assert.deepEqual(judgeBenchCase('yes', [], 2), { pass: false, consistent: false, note: '只有 0/2 回' })
        assert.equal(judgeBenchCase('yes', [{ run: 1, cls: 'yes' }], 2).pass, false, '回數不足即不通過')
    })

    it('失敗歸類與停測(以頁為單位):限流即停、整頁各案記呼叫失敗、其後各頁記未呼叫;連續服務面失敗依呼叫計;回覆不合 check(reply)不計入連續失敗且歸零;他模型照跑', async () => {
        assert.equal(benchFailOf({ error: 'FreeUsageLimitError: Rate limit exceeded' }).kind, 'limit')
        // 冷卻事件之 reason(w-dispatch-ai 1.0.85 起;設計 da402 §4.2〈CA〉6):限流只認 rate-limit／detect
        assert.equal(benchFailOf({ error: 'Exit code 1' }, [{ type: 'cooled', error: 'Exit code 1', reason: 'detect' }]).kind, 'limit', '限流字樣偵測所致之冷卻')
        assert.equal(benchFailOf({ error: 'Exit code 1' }, [{ type: 'cooled', error: 'Exit code 1', reason: 'streak' }]).kind, 'error', '連敗所致之冷卻不算限流')
        assert.equal(benchFailOf({ error: 'TIMEOUT after 300s' }, [{ type: 'cooled', error: 'TIMEOUT after 300s', reason: 'timeout' }]).kind, 'timeout', '逾時所致之冷卻不算限流')
        assert.equal(benchFailOf({ error: 'x', errors: ['m:timeout(3.0s)'] }).kind, 'timeout')
        assert.deepEqual(benchFailOf({ error: 'OUTPUT_VALIDATION_FAILED', errors: ['m:validation(1.0s)：須為 JSON 陣列'] }, [{ type: 'skip-group', errorType: 'validation', stdout: '不是陣列' }]),
            { kind: 'reply', error: 'OUTPUT_VALIDATION_FAILED｜m:validation(1.0s)：須為 JSON 陣列', reply: '不是陣列' })
        assert.equal(benchFailOf({ error: 'budget', skipped: true }).kind, 'skipped')
        assert.deepEqual(benchFailOf(null), { kind: 'error', error: '呼叫失敗', reply: '' })
        assert.equal(benchFailOf({ error: 'HTTP 429' }, 'not-array').kind, 'limit', '事件非陣列視為無事件')

        const ai = pageStub({
            limited: (texts) => (texts[0] === '海浪週期' ? { fail: { error: 'HTTP 429 Too Many Requests' } } : right(texts)),
            slow: () => TIMEOUT,
            garbled: () => ({ not: 'array' }),
            bumpy: (texts) => (texts[0] === '海浪週期' ? { not: 'array' } : TIMEOUT),
            good: right,
        })
        const r = await runBench(topicRole, { models: ['limited', 'slow', 'garbled', 'bumpy', 'good'], cases: TOPIC, aiAdapter: ai, clock: FIXED })
        // 限流:第 2 頁(t4)限流 → 即停;第 1 頁三案之第 1 回有結果,其餘未呼叫
        const L = modelOf(r, 'limited')
        assert.match(L.stopped, /^額度用盡或限流，停測（第 1 回 t4：HTTP 429/)
        assert.deepEqual([L.calls.sent, L.calls.failed, L.calls.notRun, L.calls.byKind], [2, 1, 6, { limit: 1 }])
        assert.equal(ai.calls.filter((c) => c.model === 'limited').length, 2)
        assert.deepEqual(caseOf(r, 'limited', 't4').runs.map((x) => [x.callFail, x.failKind, x.notRun]), [[true, 'limit', false], [false, '', true]])
        assert.match(caseOf(r, 'limited', 't6').note, /^第 1 回未呼叫（額度用盡或限流，停測/)
        // 逾時:一頁之失敗及於頁內三案;連續 2 次呼叫失敗即停
        const S = modelOf(r, 'slow')
        assert.deepEqual([S.calls.sent, S.calls.failed, S.calls.notRun, S.contract.total], [2, 2, 6, 0])
        assert.match(S.stopped, /連續 2 回呼叫失敗，停測（最後一回：逾時）/)
        assert.deepEqual(['t1', 't2', 't3'].map((id) => caseOf(r, 'slow', id).runs[0].failKind), ['timeout', 'timeout', 'timeout'])
        // 回覆不合 check(reply):不停測、全部送出
        const G = modelOf(r, 'garbled')
        assert.deepEqual([G.stopped, G.calls.sent, G.calls.byKind], ['', 8, { reply: 8 }])
        assert.match(caseOf(r, 'garbled', 't1').note, /第 1 回呼叫失敗（回覆非 JSON：OUTPUT_VALIDATION_FAILED｜garbled:validation\(0\.0s\)：須為 JSON 陣列）/)
        // 逾時 → reply(歸零) → 逾時 → 逾時:第 4 頁才停,第 2 回全未呼叫
        const B = modelOf(r, 'bumpy')
        assert.deepEqual([B.calls.sent, B.calls.notRun, B.calls.byKind], [4, 4, { timeout: 3, reply: 1 }])
        assert.match(B.stopped, /^連續 2 回呼叫失敗/)
        assert.deepEqual(modelOf(r, 'good').score, { pass: 7, total: 7, rate: 1 }, '他模型照跑')
        // 條目不可用與調度層建立失敗:不呼叫,各回記未呼叫
        const gone = pageStub({ good: right }, { chainFor: (spec) => {
            if (spec.use === 'gone') throw new Error('席位引用了不可用的條目：gone')
            return [spec]
        } })
        const r2 = await runBench(topicRole, { models: ['gone'], cases: TOPIC, aiAdapter: gone, clock: FIXED })
        assert.deepEqual([modelOf(r2, 'gone').calls.sent, modelOf(r2, 'gone').calls.notRun, gone.calls.length], [0, 8, 0])
        assert.match(modelOf(r2, 'gone').stopped, /^條目不可用：席位引用了不可用的條目：gone/)
        const r3 = await runBench(topicRole, { models: ['x'], cases: TOPIC, adapterOf: () => { throw new Error('建不起來') }, clock: FIXED })
        assert.match(modelOf(r3, 'x').stopped, /^調度層建立失敗：建不起來/)
    })

    it('併發:模型間同時至多 concurrency 個;同一模型內序列(不重疊),順序為第 1 回全部頁 → 第 2 回', async () => {
        const script = { m1: right, m2: right, m3: right }
        const ai = pageStub(script, { delayMs: 8 })
        await runBench(topicRole, { models: ['m1', 'm2', 'm3'], cases: TOPIC, aiAdapter: ai, clock: FIXED })
        assert.equal(ai.peak.all, 2, '預設同時 2 個模型')
        assert.equal(ai.peak.perModel, 1, '同一模型不同時佔兩個請求')
        assert.deepEqual(ai.calls.filter((c) => c.model === 'm1').map((c) => `${c.texts[0]}#${c.k}`),
            ['行星大氣光譜#1', '海浪週期#1', '星系旋臂#1', '彗星軌道#1', '行星大氣光譜#2', '海浪週期#2', '星系旋臂#2', '彗星軌道#2'])
        const ai3 = pageStub(script, { delayMs: 8 })
        await runBench(topicRole, { models: ['m1', 'm2', 'm3'], cases: TOPIC, aiAdapter: ai3, clock: FIXED, concurrency: 3 })
        assert.equal(ai3.peak.all, 3)
        const ai1 = pageStub(script, { delayMs: 3 })
        await runBench(topicRole, { models: ['m1', 'm2', 'm3'], cases: TOPIC, aiAdapter: ai1, clock: FIXED, concurrency: 1 })
        assert.equal(ai1.peak.all, 1)
    })

    it('進度事件:start 帶 meta(指紋同結果);call 逐案逐回(一頁三案即三則、同一耗時);model-stopped、model-done 帶彙整(不含逐案);回呼拋錯不影響評分', async () => {
        const evs = []
        const r = await runBench(topicRole, { models: ['good', 'slow'], cases: TOPIC, aiAdapter: pageStub({ good: right, slow: () => TIMEOUT }), clock: FIXED, concurrency: 1, onProgress: (ev) => evs.push(ev) })
        assert.equal(evs[0].type, 'start')
        assert.equal(evs[0].meta.promptFp, r.meta.promptFp)
        const goodCalls = evs.filter((e) => e.type === 'call' && e.model === 'good')
        assert.equal(goodCalls.length, 14, '7 案 × 2 回')
        assert.deepEqual(goodCalls.slice(0, 3).map((e) => e.caseId), ['t1', 't2', 't3'])
        assert.equal(new Set(goodCalls.slice(0, 3).map((e) => e.record.ms)).size, 1)
        assert.equal(evs.filter((e) => e.type === 'call' && e.model === 'slow').length, 4, '停測前兩頁共 4 案')
        assert.ok(evs.some((e) => e.type === 'model-stopped' && e.model === 'slow' && /連續 2 回呼叫失敗/.test(e.reason)))
        const done = evs.filter((e) => e.type === 'model-done')
        assert.deepEqual(done.map((e) => [e.model, e.summary.score.pass]), [['good', 7], ['slow', 0]])
        assert.equal('cases' in done[0].summary, false, '彙整不含逐案明細')
        const r2 = await runBench(topicRole, { models: ['good'], cases: TOPIC, aiAdapter: pageStub({ good: right }), clock: FIXED, onProgress: () => { throw new Error('回呼壞了') } })
        assert.equal(modelOf(r2, 'good').score.pass, 7)
    })

    it('詞彙注入:opt.vocab 經 domainOf 建未自帶詞彙之案之 domain(提示詞與指紋隨之改變),自帶詞彙之案仍用其詞彙;opt.domainOf 給了即用之;vocab 與 domain 並給、vocab 非物件或不合、roleOpt 非物件、domain 不合 → 任何呼叫前拋錯', async () => {
        const ai = pageStub({ good: right })
        const r = await runBench(topicRole, { models: ['good'], cases: TOPIC, aiAdapter: ai, clock: FIXED, runs: 1, vocab: { kbLabel: '天文學知識庫' } })
        const heads = ai.calls.map((c) => c.prompt.slice(0, c.prompt.indexOf('的分類員')))
        assert.deepEqual(heads, ['你是天文學知識庫', '你是天文學知識庫', '你是知識庫', '你是天文學知識庫'])
        assert.match(ai.calls[2].prompt, /^你是知識庫的分類員（範圍：天文）/, '自帶詞彙之案用其詞彙')
        assert.notEqual(r.meta.promptFp, planBench(topicRole, { cases: TOPIC }).promptFp)
        assert.equal(r.meta.promptFp, planBench(topicRole, { cases: TOPIC, vocab: { kbLabel: '天文學知識庫' } }).promptFp)
        // opt.domainOf:opt.vocab 與自帶詞彙之案皆經之
        const seen = []
        const domainOf = (vocab) => {
            seen.push(vocab)
            return createTopicDomain({ vocab: { ...vocab, kbLabel: `[${vocab.kbLabel || '預設'}]` } })
        }
        const plan = planBench(topicRole, { cases: TOPIC, vocab: { kbLabel: '甲' }, domainOf })
        assert.deepEqual(seen, [{ kbLabel: '甲' }, { scope: '天文' }])
        assert.match(plan.pages[0].prompt, /^你是\[甲\]的分類員/)
        assert.match(plan.pages[2].prompt, /^你是\[預設\]的分類員（範圍：天文）/)
        // 錯誤(任何呼叫之前)
        const ai2 = pageStub({ good: right })
        const base = { models: ['good'], cases: TOPIC, aiAdapter: ai2 }
        await assert.rejects(runBench(topicRole, { ...base, vocab: { kbLabel: 'x' }, domain: createTopicDomain() }), /runBench 之 domain 與 vocab 擇一/)
        await assert.rejects(runBench(topicRole, { ...base, vocab: 'x' }), /runBench 之 vocab 須為物件/)
        await assert.rejects(runBench(topicRole, { ...base, vocab: { bogus: 1 } }), /runBench 之 vocab 不合：vocab 含不認得之鍵：bogus/)
        await assert.rejects(runBench(topicRole, { ...base, roleOpt: 5 }), /runBench 之 roleOpt 須為物件/)
        await assert.rejects(runBench(topicRole, { ...base, domain: { nope: 1 } }), /runBench 之 domain 須具 buildPrompt 與 isValidItem/)
        await assert.rejects(runBench(topicRole, { ...base, domainOf: () => ({}) }), /runBench 之 domainOf 所建之 domain 須具 buildPrompt 與 isValidItem（案 t5）/)
        await assert.rejects(runBench(variant({ domainProblem: () => { throw new Error('壞檢核') } }), base), /runBench 之 domain 檢核拋錯：壞檢核/, '檢核拋錯不得放行')
        await assert.rejects(runBench(variant({ promptOf: () => ' ' }), base), /runBench 之 promptOf 須回傳非空字串（頁：t1、t2、t3）/)
        await assert.rejects(runBench(topicRole, { ...base, models: [] }), /runBench 需要 models/)
        await assert.rejects(runBench(topicRole, { ...base, runs: 0 }), /runBench 之 runs 須為正整數/)
        await assert.rejects(runBench(topicRole, { models: ['good'], cases: TOPIC }), /runBench 需要 aiAdapter/)
        assert.equal(ai2.calls.length, 0, '設定錯誤不燒任何呼叫')
    })

    it('命令列解析:--vocab(絕對路徑;未給為空字串)與角色擴充之選項(值經 parse 驗,以 key 列出);不認得、缺值、重複、值不合即拋;擴充選項只屬定義它之角色;用法說明列出 --vocab 與擴充選項', () => {
        const d = parseBenchArgs([], groupRole)
        assert.deepEqual([d.vocab, d.runs, d.concurrency, d.timeZone, d.out], ['', 2, 2, 'Asia/Taipei', path.resolve('bench-out')])
        assert.equal('pageSize' in d, false, '未給之擴充選項不列')
        assert.equal(parseBenchArgs(['--vocab', 'x/v.json'], groupRole).vocab, path.resolve('x/v.json'))
        assert.equal(parseBenchArgs(['--vocab=v.json'], groupRole).vocab, path.resolve('v.json'))
        assert.equal(parseBenchArgs(['--page-size', '5'], groupRole).pageSize, 5)
        assert.equal(parseBenchArgs(['--page-size=2'], groupRole).pageSize, 2)
        assert.throws(() => parseBenchArgs(['--page-size', '0'], groupRole), /--page-size 須為正整數，收到「0」/)
        assert.throws(() => parseBenchArgs(['--page-size', '2', '--page-size', '3'], groupRole), /--page-size 重複給定/)
        assert.throws(() => parseBenchArgs(['--vocab'], groupRole), /--vocab 缺值/)
        assert.throws(() => parseBenchArgs(['--vocab', 'a', '--vocab', 'b'], groupRole), /--vocab 重複給定/)
        assert.throws(() => parseBenchArgs(['--page-size', '5'], topicRole), /不認得之參數：--page-size/, '擴充選項只屬定義它之角色')
        assert.throws(() => parseBenchArgs(['--page-size', '5'], area.areaBenchRole), /不認得之參數：--page-size/)
        assert.deepEqual(parseBenchArgs(['--models', 'free'], groupRole).models, [...DEFAULT_FREE_MODELS])
        assert.deepEqual(parseBenchArgs([], variant({ id: 'm2', models: ['x', 'y', 'x'] })).models, ['x', 'y'], '角色之預設受測名單(去重)')
        const u = benchUsageOf(groupRole)
        assert.match(u, /^用法：node src\/bench\/cli\.mjs group \[--models .*\[--vocab <詞彙 json>\] \[--page-size <n>\]$/m)
        assert.match(u, /^ {2}--vocab {8}詞彙覆寫/m)
        assert.match(u, /^ {2}--page-size {4}一頁幾案\(預設 3\)$/m)
        assert.match(u, /^ {2}--cases {8}題組檔\(JSON;本角色無內建題組,須給\)$/m)
        assert.equal(benchArgPint('7', '--x'), 7)
        assert.throws(() => benchArgPint('1e3', '--x'), /--x 須為正整數，收到「1e3」/)
    })

    it('runBenchCli:--vocab 詞彙檔交角色之 domainOf(提示詞帶詞彙);--page-size 經 roleOpt 改變分頁;報表、進度檔以角色 id 為檔名主幹;詞彙檔不存在／非 JSON／非物件／不合 → 建輸出目錄前拋錯', async () => {
        fs.mkdirSync(TMP, { recursive: true })
        const casesFile = path.join(TMP, 'topic.json')
        fs.writeFileSync(casesFile, JSON.stringify(TOPIC), 'utf8')
        const vocabFile = path.join(TMP, 'vocab.json')
        fs.writeFileSync(vocabFile, JSON.stringify({ kbLabel: '天文學知識庫' }), 'utf8')
        const outDir = path.join(TMP, 'cli-out')
        const lines = []
        const log = { info: (m) => lines.push(m), error: (m) => lines.push(m) }
        const ai = pageStub({ good: right })
        const res = await runBenchCli(groupRole, ['--models', 'good', '--cases', casesFile, '--vocab', vocabFile, '--out', outDir, '--runs', '1', '--page-size', '2'], { aiAdapter: ai, log })
        assert.deepEqual(ai.calls.map((c) => c.texts.length), [2, 2, 2, 1], '無自帶詞彙之 6 案每 2 案一頁,自帶詞彙之案另一頁')
        assert.ok(ai.calls.slice(0, 3).every((c) => c.prompt.startsWith('你是天文學知識庫的分類員')), '詞彙檔之稱呼進入提示詞')
        assert.match(ai.calls[3].prompt, /^你是知識庫的分類員（範圍：天文）/)
        assert.deepEqual(modelOf(res.result, 'good').score, { pass: 7, total: 7, rate: 1 })
        assert.ok(lines[0].startsWith('分群分類 AI 能力評分：1 個模型 × 7 案 × 1 回（題組 TS1 v2，提示詞指紋 '), lines[0])
        assert.ok(lines[0].includes(`，詞彙 ${vocabFile}）`), lines[0])
        assert.ok(lines.some((l) => l.includes('[good] 第 1 回 t1：yes（依據主題）')), '逐回行帶角色之補充顯示')
        const stamp = res.result.meta.stamp
        assert.deepEqual(Object.values(res.report.files).map((f) => path.basename(f)), [`group-bench-${stamp}-models.csv`, `group-bench-${stamp}-cases.csv`, `group-bench-${stamp}.md`, `group-bench-${stamp}.json`])
        assert.equal(path.basename(res.progressFile), `group-bench-${stamp}.progress.jsonl`)
        assert.equal(fs.readFileSync(res.progressFile, 'utf8').trim().split('\n').filter((l) => JSON.parse(l).type === 'call').length, 7, '逐回即存')
        assert.equal(res.board, null)
        // 詞彙檔不合:建輸出目錄與呼叫之前拋錯
        const out2 = path.join(TMP, 'cli-out-bad')
        const argv = (vf) => ['--models', 'good', '--cases', casesFile, '--vocab', vf, '--out', out2]
        await assert.rejects(runBenchCli(groupRole, argv(path.join(TMP, 'none.json')), { aiAdapter: ai, log }), /--vocab 指定之詞彙檔不存在/)
        fs.writeFileSync(path.join(TMP, 'v-bad.json'), '{ 壞', 'utf8')
        await assert.rejects(runBenchCli(groupRole, argv(path.join(TMP, 'v-bad.json')), { aiAdapter: ai, log }), /--vocab 詞彙檔讀取失敗/)
        fs.writeFileSync(path.join(TMP, 'v-arr.json'), '[1]', 'utf8')
        await assert.rejects(runBenchCli(groupRole, argv(path.join(TMP, 'v-arr.json')), { aiAdapter: ai, log }), /--vocab 詞彙檔須為 JSON 物件/)
        fs.writeFileSync(path.join(TMP, 'v-key.json'), JSON.stringify({ kbLable: 'x' }), 'utf8')
        await assert.rejects(runBenchCli(groupRole, argv(path.join(TMP, 'v-key.json')), { aiAdapter: ai, log }), /--vocab 詞彙不合（.*v-key\.json）：vocab 含不認得之鍵：kbLable/)
        assert.ok(!fs.existsSync(out2), '詞彙不合時不建輸出目錄')
        assert.equal(ai.calls.length, 4, '詞彙不合時不呼叫')
        assert.deepEqual(await runBenchCli(groupRole, ['-h'], { log }), { help: true })
        assert.equal(lines[lines.length - 1], benchUsageOf(groupRole))
    })

    it('領域發現角色之 --vocab:詞彙檔之稱呼進入未帶 input.vocab 之案之提示詞,帶 input.vocab 之案仍用其詞彙;不合抓取詞彙表規格之鍵即拋;opt.vocab 與 --vocab 同義', async () => {
        fs.mkdirSync(TMP, { recursive: true })
        const vf = path.join(TMP, 'area-vocab.json')
        fs.writeFileSync(vf, JSON.stringify({ kbLabel: '天文學知識庫' }), 'utf8')
        const ai = areaStub()
        const res = await area.runAreaBenchCli(['--models', 'm', '--vocab', vf, '--out', path.join(TMP, 'area-out'), '--runs', '1'], { aiAdapter: ai, log: { info: () => {} } })
        const set = area.loadAreaCases()
        assert.ok(set.cases.some((c) => c.input.vocab), '前提:內建題組有帶 vocab 之案')
        for (const c of set.cases) {
            const call = ai.calls.find((x) => x.label === c.input.candidate.label)
            const head = c.input.vocab ? `你是「${c.input.vocab.domain}」知識庫的抓取領域規劃員` : '你是天文學知識庫的抓取領域規劃員'
            assert.ok(call.prompt.startsWith(head), `${c.id}：${call.prompt.slice(0, 30)}`)
        }
        assert.equal(res.result.meta.promptFp, planBench(area.areaBenchRole, { vocab: { kbLabel: '天文學知識庫' } }).promptFp)
        assert.notEqual(res.result.meta.promptFp, planBench(area.areaBenchRole).promptFp)
        fs.writeFileSync(path.join(TMP, 'area-vocab-bad.json'), JSON.stringify({ kbLabel: 'x', categories: ['a'] }), 'utf8')
        await assert.rejects(area.runAreaBenchCli(['--models', 'm', '--vocab', path.join(TMP, 'area-vocab-bad.json'), '--out', path.join(TMP, 'area-out2')], { aiAdapter: areaStub(), log: { info: () => {} } }),
            /--vocab 詞彙不合（.*）：vocab 含不認得之鍵：categories/)
        const r2 = await area.runAreaBench({ models: ['m'], aiAdapter: areaStub(), runs: 1, clock: FIXED, vocab: { kbLabel: '天文學知識庫' } })
        assert.equal(r2.meta.promptFp, res.result.meta.promptFp)
    })

    it('評比表多角色並存:不同角色之同一模型各一列、互不覆蓋;同角色同模型以本次覆蓋;opt.role 可為角色或其顯示名;未給角色即拋;各角色同一表頭', async () => {
        const file = path.join(TMP, 'board', '模型評比.csv')
        fs.rmSync(path.dirname(file), { recursive: true, force: true })
        const wrong = (texts) => reply(texts, (t) => (t === '海浪週期' ? 'yes' : TRUTH[t]))
        const rTopic = await runBench(topicRole, { models: ['good', 'n2'], cases: TOPIC, aiAdapter: pageStub({ good: wrong, n2: right }), clock: FIXED })
        const b1 = mergeBenchBoard(file, rTopic, { role: topicRole, workspace: 'ws-topic' })
        assert.deepEqual([b1.written, b1.replaced, b1.rows], [['good', 'n2'], [], 2])
        const rArea = await area.runAreaBench({ models: ['good'], aiAdapter: areaStub(), runs: 1, clock: FIXED })
        const b2 = area.mergeAreaBenchBoard(file, rArea, { workspace: 'ws-area' })
        assert.deepEqual([b2.written, b2.replaced, b2.rows], [['good'], [], 3], '他角色之同名模型不被覆蓋')
        const rows = () => parseCsv(fs.readFileSync(file, 'utf8')).slice(1)
        assert.deepEqual(rows().map((r) => `${r[0]}／${r[1]}`).sort(), [`${area.AREA_BENCH_ROLE}／good`, '題目分類(topic)／good', '題目分類(topic)／n2'].sort())
        assert.deepEqual(rows().filter((r) => r[0] === '題目分類(topic)').map((r) => [r[1], r[2], r[10], r[11]]), [['n2', '7', '', 'ws-topic'], ['good', '6', 't4', 'ws-topic']], '同角色依通過數排序;失分案列出')
        const areaBefore = rows().find((r) => r[0] === area.AREA_BENCH_ROLE)
        // 同角色同模型以本次覆蓋(以顯示名指定角色);他角色之列原樣
        const rTopic2 = await runBench(topicRole, { models: ['good'], cases: TOPIC, aiAdapter: pageStub({ good: right }), clock: FIXED })
        const b3 = mergeBenchBoard(file, rTopic2, { role: '題目分類(topic)' })
        assert.deepEqual([b3.written, b3.replaced, b3.rows], [['good'], ['good'], 3])
        assert.deepEqual(rows().find((r) => r[0] === area.AREA_BENCH_ROLE), areaBefore)
        assert.deepEqual(Object.fromEntries(rows().filter((r) => r[0] === '題目分類(topic)').map((r) => [r[1], r[2]])), { good: '7', n2: '7' })
        // 停測者不寫
        const rStop = await runBench(topicRole, { models: ['slow'], cases: TOPIC, aiAdapter: pageStub({ slow: () => TIMEOUT }), clock: FIXED })
        const b4 = mergeBenchBoard(file, rStop, { role: topicRole })
        assert.deepEqual([b4.written, b4.skipped.map((x) => x.model), b4.rows], [[], ['slow'], 3])
        // 角色必給
        assert.throws(() => mergeBenchBoard(file, rTopic2), /mergeBenchBoard 需要 opt\.role/)
        assert.throws(() => mergeBenchBoard(file, rTopic2, { role: { name: 'x' } }), /mergeBenchBoard 之 opt\.role 需要角色定義/)
        assert.equal(area.AREA_BENCH_BOARD_HEADER, BENCH_BOARD_HEADER, '各角色同一表頭')
        assert.equal(parseCsv(fs.readFileSync(file, 'utf8'))[0].join(','), BENCH_BOARD_HEADER.join(','))
        // 命令列 --board:角色欄取該角色
        const casesFile = path.join(TMP, 'topic-board.json')
        fs.writeFileSync(casesFile, JSON.stringify(TOPIC), 'utf8')
        const res = await runBenchCli(groupRole, ['--models', 'good', '--cases', casesFile, '--out', path.join(TMP, 'cli-board-out'), '--runs', '1', '--board', file], { aiAdapter: pageStub({ good: right }), log: { info: () => {} } })
        assert.deepEqual(res.board.written, ['good'])
        assert.ok(rows().some((r) => r[0] === '分群分類(group)' && r[1] === 'good'))
        assert.equal(rows().length, 4)
        // 列序:角色名以碼元序(cmp;不隨 ICU 而異)、同角色依通過數;原子寫(目錄內不留暫存檔)
        const names = rows().map((r) => r[0])
        assert.deepEqual(names, [...names].sort((a, b) => (a < b ? -1 : (a > b ? 1 : 0))), '角色名依碼元序')
        assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')), [], '原子寫不留暫存檔')
    })

    it('報表(一頁多案之角色):逐案 CSV 之案欄與每回欄依角色之 report 欄位;Markdown 之標題、預設判準說明、逐案表之案欄與補充顯示;落檔檔名主幹為 <角色 id>-bench-<時間戳>;角色未給或未經定義即拋;失敗類別之欄與 BENCH_FAIL_KINDS 同一組鍵', async () => {
        const wrong = (texts) => reply(texts, (t) => (t === '海浪週期' ? 'yes' : TRUTH[t]), '理由,含逗號')
        const r = await runBench(topicRole, { models: ['good', 'bad'], cases: TOPIC, aiAdapter: pageStub({ good: right, bad: wrong }), clock: FIXED })
        const cs = parseCsv(benchCasesCsv(r, topicRole))
        assert.deepEqual(cs[0].slice(0, 6), ['模型', '案', '題型', '保留', '文字', '應然'])
        assert.deepEqual(cs[0].slice(6, 12), ['第1回類別', '第1回標記', '第1回理由', '第1回合契約', '第1回耗時秒', '第1回錯誤'])
        assert.deepEqual(cs[0].slice(-4), ['通過', '各回一致', '未通過原因', '應然依據'])
        assert.equal(cs.length, 1 + 2 * 7)
        assert.ok(cs.every((row) => row.length === cs[0].length), '各列欄數一致(含跳脫之欄)')
        const row = cs.find((x) => x[0] === 'bad' && x[1] === 't4')
        assert.deepEqual(row.slice(2, 10), ['', '是', '海浪週期', 'no', 'yes', 'yes', '理由,含逗號', '是'])
        assert.equal(row[cs[0].indexOf('通過')], '否')
        const md = benchMarkdown(r, topicRole)
        for (const p of [/^# 題目分類 AI 能力評分$/m, /^- 判準：逐案各回之類別皆＝應然才計通過（各回因而一致），不以比率放行$/m,
            /^- 合契約率：成功取得回覆之各回中，該案之項合輸出契約者之比率；平均耗時取成功之呼叫$/m,
            /^\| 案 \| 題型 \| 保留 \| 文字 \| 應然 \| 第 1 回 \| 第 2 回 \| 通過 \|$/m, /^\|---\|---\|---\|---\|---\|---\|---\|---\|$/m,
            /^\| t4 \| - \| 是 \| 海浪週期 \| no \| yes（理由,含逗號） \| yes（理由,含逗號） \| ✗ \|$/m,
            /^\| t5 \| scoped \| {2}\| 星系旋臂 \| yes \| yes（依據主題） \| yes（依據主題） \| ✓ \|$/m,
            /^- t4（保留）〔應然 no；依據：海洋〕：第 1 回判 yes（理由,含逗號），應然 no；第 2 回判 yes（理由,含逗號），應然 no$/m]) assert.match(md, p)
        const out = writeBenchReport(r, path.join(TMP, 'rep'), { role: topicRole })
        assert.deepEqual(Object.values(out.files).map((f) => path.basename(f)), ['topic-bench-20310304050607-models.csv', 'topic-bench-20310304050607-cases.csv', 'topic-bench-20310304050607.md', 'topic-bench-20310304050607.json'])
        for (const f of Object.values(out.files)) assert.ok(fs.statSync(f).size > 0, f)
        assert.deepEqual(JSON.parse(fs.readFileSync(out.files.json, 'utf8')).models.map((m) => m.score.pass), [7, 6])
        assert.equal(fs.readFileSync(out.files.md, 'utf8'), md)
        assert.throws(() => writeBenchReport(r, path.join(TMP, 'rep')), /writeBenchReport 之 opt\.role 需要角色定義/)
        assert.throws(() => benchCasesCsv(r), /benchCasesCsv 需要角色定義/)
        assert.throws(() => benchMarkdown(r, TOPIC_DEF), /benchMarkdown 需要角色定義/, '未經 defineBenchRole 之定義不收')
        assert.equal(parseCsv(benchModelsCsv(r)).length, 3, '逐模型 CSV 不需角色')
        assert.throws(() => benchModelsCsv({}, topicRole), /報表需要 runBench 之結果/)
        assert.throws(() => benchModelsCsv({}, area.areaBenchRole), /報表需要 runAreaBench 之結果/, '錯誤訊息用角色之執行器名')
        assert.deepEqual(Object.keys(BENCH_FAIL_KINDS), BENCH_FAIL_COLUMNS.map(([k]) => k))
    })

    it('提示詞指紋:一案一頁時＝各案「id＋提示詞」之 sha1 前 16 碼(與既有領域發現評分同式);分頁、題組或詞彙一改即不同;planBench 與 runBench 同一指紋', async () => {
        assert.equal(benchPromptFpOf([{ ids: ['a1'], prompt: 'P1' }, { ids: ['a2'], prompt: 'P2' }]), sha1('a1\u0002P1\u0001a2\u0002P2').slice(0, 16))
        assert.equal(benchPromptFpOf([]), '', '無頁時為空字串')
        // 領域發現(一案一頁):以 domain.buildPrompt 逐案組之提示詞依舊式計算
        const set = area.loadAreaCases()
        const legacy = sha1(set.cases.map((c) => `${c.id}\u0002${createAreaDomain(c.input.vocab ? { vocab: c.input.vocab } : {}).buildPrompt([c.input.candidate], c.input.areas)}`).join('\u0001')).slice(0, 16)
        assert.equal(planBench(area.areaBenchRole).promptFp, legacy)
        const r = await area.runAreaBench({ models: ['m'], aiAdapter: areaStub(), runs: 1, clock: FIXED })
        assert.equal(r.meta.promptFp, legacy)
        // 一頁多案:同樣之案,分頁一改指紋即不同
        const p3 = planBench(topicRole, { cases: TOPIC })
        const p2 = planBench(variant({ pageSize: 2 }), { cases: TOPIC })
        assert.notEqual(p3.promptFp, p2.promptFp)
        assert.equal(p3.promptFp, benchPromptFpOf(p3.pages))
        const r3 = await runBench(topicRole, { models: ['good'], cases: TOPIC, aiAdapter: pageStub({ good: right }), clock: FIXED, runs: 1 })
        assert.equal(r3.meta.promptFp, p3.promptFp)
        const changed = { ...TOPIC, cases: TOPIC.cases.map((c, i) => (i === 0 ? { ...c, input: { text: '行星大氣光譜之吸收線' } } : c)) }
        assert.notEqual(planBench(topicRole, { cases: changed }).promptFp, p3.promptFp)
        assert.notEqual(planBench(topicRole, { cases: TOPIC, vocab: { kbLabel: '甲' } }).promptFp, p3.promptFp)
    })

    it('題組驗證(角色):共通欄位、角色之 caseProblems(加上案之位置)、角色宣告之 std／v(題組有給即須相符)、suiteProblems、應然類別無法判定 → 一併列出;未給題組而角色無內建題組 → 拋錯', () => {
        const ok = TOPIC.cases[0]
        const bad = { std: 'TS9', v: 1, cases: [ok, { ...ok }, { ...ok, id: 'b', input: {} }, { ...ok, id: 'c', expect: { label: 'maybe' } }, { ...ok, id: 'd', why: '' }, 'x'] }
        assert.throws(() => validateBenchCases(topicRole, bad), (e) => {
            for (const p of [/題組之 std「TS9」非本角色之標準（TS1）/, /題組之 v「1」非本角色所讀之題組版本（2）/, /cases\[1\]\(t1\) id 重複/, /cases\[2\]\(b\) 缺 input\.text/,
                /cases\[3\]\(c\) expect\.label 須為 yes／no/, /cases\[4\]\(d\) 缺 why/, /cases\[5\] 須為物件/]) assert.match(e.message, p)
            assert.match(e.message, /^題組不合格（7 項）/)
            return true
        })
        assert.equal(validateBenchCases(topicRole, { cases: [ok] }).std, '', '題組未給 std／v 不驗')
        assert.equal(validateBenchCases(variant({ std: ['SS2', 'SS4'], v: undefined }), { std: 'SS4', v: 7, cases: [ok] }).std, 'SS4', '角色量多個標準;未宣告版本不驗')
        assert.throws(() => validateBenchCases(variant({ expectOf: (c) => (c.id === 't1' ? '' : c.expect.label) }), [ok]), /cases\[0\]\(t1\) 應然類別無法判定/)
        const suite = variant({ suiteProblems: (set) => (set.excluded !== undefined && !Array.isArray(set.excluded) ? ['excluded 須為陣列'] : []) })
        assert.throws(() => validateBenchCases(suite, { excluded: 'x', cases: [ok] }), /^Error: 題組不合格（1 項）：excluded 須為陣列$/)
        assert.throws(() => validateBenchCases(variant({ caseProblems: () => { throw new Error('檢核壞了') } }), [ok]), /cases\[0\]\(t1\) 角色之檢核拋錯：檢核壞了/)
        assert.throws(() => validateBenchCases(topicRole, { cases: [] }), /至少一案/)
        assert.throws(() => loadBenchCases(topicRole), /角色 topic 無內建題組，須給題組檔/)
        assert.equal(loadBenchCases(area.areaBenchRole).cases.length, area.loadAreaCases().cases.length, '角色之內建題組')
        assert.deepEqual(validateBenchCases(topicRole, TOPIC).cases.map((c) => c.holdout), [false, false, false, true, false, false, true], 'holdout 正規化為布林')
    })

    it('自訂分頁(paginate):可回傳案物件或案 id、可改變送出順序(結果仍依題組順序)、取 roleOpt;漏列、重複、題組外之案、空頁、非陣列、同頁混用詞彙 → 任何呼叫前拋錯', async () => {
        assert.deepEqual(planBench(groupRole, { cases: TOPIC }).pages.map((p) => p.ids), [['t1', 't2', 't3'], ['t4', 't6', 't7'], ['t5']])
        const ai = pageStub({ good: right })
        const r = await runBench(groupRole, { models: ['good'], cases: TOPIC, aiAdapter: ai, clock: FIXED, runs: 1, roleOpt: { pageSize: 4 } })
        assert.deepEqual(ai.calls.map((c) => c.texts.length), [4, 2, 1], 'roleOpt 交 paginate')
        assert.deepEqual(modelOf(r, 'good').cases.map((c) => c.id), ['t1', 't2', 't3', 't4', 't5', 't6', 't7'])
        assert.equal(modelOf(r, 'good').score.pass, 7)
        const pg = (fn) => variant({ id: 'pg', pageSize: undefined, paginate: fn })
        const ai2 = pageStub({ good: right })
        const run = (fn) => runBench(pg(fn), { models: ['good'], cases: TOPIC, aiAdapter: ai2 })
        const plain = ['t1', 't2', 't3', 't4', 't6', 't7']
        await assert.rejects(run(() => [plain.slice(0, 5), ['t5']]), /runBench 之分頁漏列案：t7/)
        await assert.rejects(run(() => [plain, ['t5'], ['t1']]), /runBench 之分頁重複列入案 t1/)
        await assert.rejects(run(() => [plain, ['t5', 'zz']]), /runBench 之分頁第 2 頁含題組外之案（zz）/)
        await assert.rejects(run(() => [plain, [], ['t5']]), /runBench 之分頁第 2 頁須為非空之案陣列/)
        await assert.rejects(run(() => 'x'), /runBench 之分頁\(paginate\)須回傳頁陣列/)
        await assert.rejects(run((cases) => [cases.map((c) => c.id)]), /runBench 之分頁第 1 頁混用不同詞彙之案（t1、t2、t3、t4、t5、t6、t7；同頁共用一份提示詞）/)
        await assert.rejects(run((cases) => [cases.map((c) => ({ ...c }))]), /含題組外之案/, '複製之案物件不認(依身分比對)')
        assert.equal(ai2.calls.length, 0, '分頁不合不燒任何呼叫')
    })

    it('每回紀錄之欄序:共通欄位在前、角色欄位依 blankFields 之序、valid(角色欄位未含者接後)、problem 殿後;角色欄位與共通欄位同名者略去(蓋不掉共通欄位)', async () => {
        const HEAD = ['run', 'notRun', 'ms', 'providerId', 'cls', 'callFail', 'failKind', 'error', 'reply']
        const r = await runBench(topicRole, { models: ['good', 'slow'], cases: TOPIC, aiAdapter: pageStub({ good: right, slow: () => TIMEOUT }), clock: FIXED, runs: 1 })
        assert.deepEqual(Object.keys(caseOf(r, 'good', 't1').runs[0]), [...HEAD, 'label', 'reason', 'valid', 'problem'])
        assert.deepEqual(Object.keys(caseOf(r, 'slow', 't1').runs[0]), [...HEAD, 'label', 'reason', 'valid', 'problem'], '呼叫失敗')
        assert.equal(caseOf(r, 'slow', 't6').runs[0].notRun, true)
        assert.deepEqual(Object.keys(caseOf(r, 'slow', 't6').runs[0]), [...HEAD, 'label', 'reason', 'valid', 'problem'], '未呼叫')
        assert.deepEqual(Object.keys(caseOf(r, 'good', 't1')), ['id', 'holdout', 'type', 'text', 'expect', 'why', 'runs', 'pass', 'consistent', 'note'])
        const placed = variant({
            blankFields: { valid: false, label: '', reason: '' },
            verdictOf: (data, c, at) => ({ ...TOPIC_DEF.verdictOf(data, c, at), fields: { valid: false, label: 'x', reason: 'y', cls: 'hack', problem: 'hack', run: 99 } }),
            caseFieldsOf: (c) => ({ text: c.input.text, id: 'hack', expect: 'hack' }),
        })
        const r2 = await runBench(placed, { models: ['good'], cases: TOPIC, aiAdapter: pageStub({ good: right }), clock: FIXED, runs: 1 })
        const rec = caseOf(r2, 'good', 't2').runs[0]
        assert.deepEqual(Object.keys(rec), [...HEAD, 'valid', 'label', 'reason', 'problem'])
        assert.deepEqual([rec.run, rec.cls, rec.problem, rec.valid, rec.label], [1, 'no', '', true, 'x'], '共通欄位不被蓋;valid 取判定之值')
        const cs = caseOf(r2, 'good', 't2')
        assert.deepEqual([cs.id, cs.expect, cs.text], ['t2', 'no', '麵包發酵溫度'])
        assert.throws(() => variant({ blankFields: { cls: '', problem: '' } }), /blankFields 不得含共通欄位：cls、problem/)
    })

    it('領域發現角色建在核心之上:areaBenchRole 為 defineBenchRole 之產物;共用之常數為同一物件;runAreaBench 與 runBench(areaBenchRole) 同結果;用法說明＝benchUsageOf(areaBenchRole) 且含 --vocab', async () => {
        assert.ok(Object.isFrozen(area.areaBenchRole))
        assert.equal(defineBenchRole(area.areaBenchRole), area.areaBenchRole)
        assert.deepEqual([area.areaBenchRole.id, area.areaBenchRole.runnerName, area.areaBenchRole.pageSize, [...area.areaBenchRole.std], area.areaBenchRole.v], ['area', 'runAreaBench', 1, ['CS8'], 1])
        assert.equal(area.AREA_FAIL_KINDS, BENCH_FAIL_KINDS)
        assert.equal(area.AREA_BENCH_BOARD_HEADER, BENCH_BOARD_HEADER)
        assert.equal(area.DEFAULT_FREE_MODELS, DEFAULT_FREE_MODELS)
        assert.equal(area.freeModelsOf, freeModelsOf)
        assert.equal(area.AREA_BENCH_ROLE, area.areaBenchRole.name)
        assert.equal(area.AREA_BENCH_USAGE, benchUsageOf(area.areaBenchRole))
        assert.match(area.AREA_BENCH_USAGE, /\[--board <評比表 csv>\] \[--vocab <詞彙 json>\]$/m)
        assert.equal(area.parseAreaBenchArgs([]).vocab, '')
        const opt = { models: ['m', 'n'], runs: 1, clock: FIXED }
        const zeroMs = (r) => JSON.parse(JSON.stringify(r, (k, v) => (['ms', 'avgMs', 'avgMsAll'].includes(k) ? 0 : v)))
        assert.deepEqual(zeroMs(await area.runAreaBench({ ...opt, aiAdapter: areaStub() })), zeroMs(await runBench(area.areaBenchRole, { ...opt, aiAdapter: areaStub() })))
        await assert.rejects(area.runAreaBench({ models: [] }), /^Error: runAreaBench 需要 models/, '錯誤訊息用角色之執行器名')
        assert.throws(() => area.validateAreaCases({ std: 'SS9', cases: area.loadAreaCases().cases }), /題組之 std「SS9」非本角色之標準（CS8）/)
    })

    it('角色作者之共用小件:型別名、切塊、分組(組序依首見、組內原序)、詞彙鍵(未帶詞彙者同鍵)、案詞彙之檢核(未帶不驗、非物件、驗證拋錯帶原因)、domain 之形狀檢核(非物件、缺函數、齊備後交 extra)、無裁決、正整數參數(未給回預設、不合即拋)、每頁案數選項(值經 benchArgPint 解析)', () => {
        assert.deepEqual([typeName(null), typeName([1]), typeName({}), typeName('x'), typeName(1), typeName(undefined)], ['null', 'array', 'object', 'string', 'number', 'undefined'])
        assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
        assert.deepEqual(chunk([], 3), [])
        assert.deepEqual(groupBy([1, 2, 3, 4, 6], (x) => x % 2), [[1, 3], [2, 4, 6]])
        const c0 = { input: {} }
        const c1 = { input: { vocab: { kbLabel: '甲' } } }
        assert.equal(vocabKeyOf(c0), vocabKeyOf({}), '未帶詞彙之案同鍵')
        assert.notEqual(vocabKeyOf(c0), vocabKeyOf(c1))
        const seen = []
        const validate = (v) => {
            seen.push(v)
            if (v.bad) throw new Error('vocab 含不認得之鍵：bad')
        }
        assert.deepEqual(inputVocabProblemsOf(c0, validate), [])
        assert.deepEqual(inputVocabProblemsOf({ input: { vocab: 5 } }, validate), ['input.vocab 須為物件'])
        assert.deepEqual(inputVocabProblemsOf({ input: { vocab: { bad: 1 } } }, validate), ['input.vocab 不合：vocab 含不認得之鍵：bad'])
        assert.deepEqual(inputVocabProblemsOf(c1, validate), [])
        assert.deepEqual(seen, [{ bad: 1 }, { kbLabel: '甲' }], '未帶詞彙或非物件者不交驗證')
        const need = domainNeedsOf(['buildPrompt', 'isValidItem'], (d) => (Array.isArray(d.types) ? '' : '之 types 須為陣列'))
        const fn = () => ''
        assert.equal(need(null), '須為物件（具 buildPrompt、isValidItem）')
        assert.equal(need({ buildPrompt: fn }), '須具 buildPrompt、isValidItem（缺 isValidItem）')
        assert.equal(need({ buildPrompt: fn, isValidItem: fn }), '之 types 須為陣列', '函數齊備後才交 extra')
        assert.equal(need({ buildPrompt: fn, isValidItem: fn, types: [] }), '')
        assert.equal(domainNeedsOf(['buildPrompt'])({ buildPrompt: fn }), '', '未給 extra 即只驗函數')
        const blank = { reason: '' }
        const nv = noVerdict('回覆為空陣列', blank)
        assert.deepEqual(nv, { cls: null, valid: false, problem: '回覆為空陣列', fields: { reason: '' } })
        assert.notEqual(nv.fields, blank, '欄位為複本')
        assert.deepEqual([benchPintOf(undefined, 7, 'batch'), benchPintOf(null, 7, 'batch'), benchPintOf(3, 7, 'batch')], [7, 7, 3])
        for (const v of [0, -1, 1.5, '3']) assert.throws(() => benchPintOf(v, 7, 'batch'), new RegExp(`roleOpt\\.batch 須為正整數，收到 ${JSON.stringify(v).replace(/[.]/g, '\\.')}`))
        const opt = batchOption(10, '題組之頁量')
        assert.deepEqual([opt.flag, opt.key, opt.arg, opt.help], ['--batch', 'batch', '<n>', '每頁案數(預設 10＝題組之頁量)'])
        assert.equal(opt.parse, benchArgPint)
        assert.equal(opt.parse('4', '--batch'), 4)
        assert.throws(() => opt.parse('0', '--batch'), /--batch 須為正整數，收到「0」/)
        // 缺票之原因(票類角色同一字樣):無項 → 預設或自訂字樣;有合格者 → 矛盾;皆不合格 → 不合格並附第一項
        const single = (x) => (x.verdict === 'keep' ? { verdict: 'keep' } : null)
        assert.equal(benchVoteMissingOf([], 3, single), '回覆無 index 3 之裁決')
        assert.equal(benchVoteMissingOf([], 3, single, { empty: '回覆為空陣列' }), '回覆為空陣列')
        assert.equal(benchVoteMissingOf([], 3, single, { empty: '' }), '回覆無 index 3 之裁決', '空字串即預設')
        assert.equal(benchVoteMissingOf([{ index: 3, verdict: 'keep' }, { index: 3, verdict: 'x' }], 3, single), '同編號 3 之裁決互相矛盾（同正式規則作廢為缺票）')
        assert.equal(benchVoteMissingOf([{ index: 3, verdict: 'x' }], 3, single), 'index 3 之裁決不合格（同正式之單票驗證，缺票）：{"index":3,"verdict":"x"}')
        assert.equal(benchVoteMissingOf(null, 1, single), '回覆無 index 1 之裁決')
    })
})
