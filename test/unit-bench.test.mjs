// unit-bench.test.mjs — 領域發現 AI 能力評分(bench/)之單元測試:以替身調度層(不連外網)驗判準、失敗與停測、併發、提示詞同源、
//   報表、題組與預設受測名單
// 執行(套件根):node ./node_modules/mocha/bin/mocha.js --timeout 180000 test/unit-bench.test.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import providersAll from 'w-dispatch-ai/src/providers.mjs'
import {
    runAreaBench, validateAreaCases, loadAreaCases, areaClassOf, areaVerdictOf, freeModelsOf,
    DEFAULT_FREE_MODELS, AREA_CASES_FILE, AREA_FAIL_KINDS, AREA_BENCH_USAGE, parseAreaBenchArgs, runAreaBenchCli,
    areaBenchModelsCsv, areaBenchCasesCsv, areaBenchMarkdown, writeAreaBenchReport,
    mergeAreaBenchBoard, AREA_BENCH_ROLE, AREA_BENCH_BOARD_HEADER, areaBenchRole,
} from '../src/bench/areaBench.mjs'
import * as cliNs from '../src/bench/cli.mjs'
import WKnowledgeCapture from '../src/WKnowledgeCapture.mjs'
import { createAreaDomain, AREA_CONTRACT } from '../src/domain/areaDomain.mjs'
import { createAiAdapter } from '../src/core/ai/adapter.mjs'
import { pickJsonReply } from '../src/core/ai/jsonReply.mjs'
import { resolveSettings } from '../src/core/settingsDefault.mjs'
import { parseCsv } from './tools/testKit.mjs'

// 測試暫存(cwd 相對;帶 pid 使並行互不干擾;測完即刪)
const TMP = path.resolve(`test/_tmp/unit-bench-${process.pid}`)

// 領域中立之掃描詞(以片段組成,本檔不含其字面——結構測試掃描原始碼時不誤判本檔)
const NON_NEUTRAL = new RegExp([
    ['量', '化'], ['交', '易'], ['股', '票'], ['股', '價'], ['金', '融'], ['投', '資'], ['因', '子'], ['波', '動'], ['套', '利'], ['對', '沖'],
    ['避', '險'], ['期', '貨'], ['選', '擇', '權'], ['報', '酬'], ['資', '產'], ['市', '場'], ['基', '金'], ['價', '格'], ['證', '券'], ['匯', '率'],
    ['加', '密', '貨'], ['t', 'rading'], ['s', 'tock'], ['p', 'ortfolio'], ['f', 'inanc'], ['i', 'nvest'], ['v', 'olatil'], ['a', 'rbitrage'],
    ['h', 'edge'], ['m', 'arket'], ['q', 'uant'], ['e', 'quity'], ['b', 'itcoin'], ['c', 'rypto'], ['d', 'ividend'],
].map((p) => p.join('')).join('|'), 'i')

/** 單元測試用之小題組(CS8 題組同形;應然:a1 covered、a2 new、h1 covered、h2 new) */
const MINI = {
    std: 'CS8',
    v: 1,
    note: '單元測試用之小題組',
    cases: [
        { id: 'a1', holdout: false, input: { candidate: { label: '快速排序', kind: 'concept', support: 9, growth: 2, samples: [{ title: '樞紐選擇' }] }, areas: [{ label: '排序演算法', query: 'sorting algorithms' }] }, expect: { covered: true }, why: '規則 1 下位概念' },
        { id: 'a2', holdout: false, input: { candidate: { label: '海洋酸化', kind: 'clue', clueDocs: 3 }, areas: [{ label: '凝態物理', query: 'condensed matter physics' }] }, expect: { covered: false }, why: '規則 3 新領域' },
        { id: 'h1', holdout: true, input: { candidate: { label: '工程學', kind: 'concept', support: 30, growth: 1, samples: [] }, areas: [] }, expect: { covered: true }, why: '規則 2 過寬' },
        { id: 'h2', holdout: true, input: { candidate: { label: '語音辨識', kind: 'concept', support: 9, growth: 2, samples: [] }, areas: [{ label: '電腦視覺', query: 'computer vision' }] }, expect: { covered: false }, why: '規則 3 新領域' },
    ],
}

const COV = (why = '既有領域已涵蓋') => [{ index: 1, covered: true, why }]
const NEW = (label, query, why = '值得持續抓取') => [{ index: 1, covered: false, label, query, why }]
/** 小題組之正解(依候選標籤) */
const RIGHT = { 快速排序: COV(), 海洋酸化: NEW('海洋酸化', 'ocean acidification'), 工程學: COV('過寬'), 語音辨識: NEW('語音辨識', 'speech recognition') }
const right = (label) => RIGHT[label]

/**
 * 替身調度層:script[模型] 為 (標籤, 第幾次問到此案, callOpt) => 回覆;回覆為 JSON 值,或 { fail:{ error, errors, skipped, events } }(失敗結果;
 *   events 經 callOpt.onEvent 送出,模擬調度事件),或 { throw:訊息 }(調度層拋錯)。記錄每次呼叫並統計同時進行之呼叫數
 *
 * @param {Object} script 輸入 { 模型: 函數或固定回覆 }
 * @param {Object} [o={}] 輸入 { delayMs, chainFor }
 * @returns {Object} 回傳替身 { calls, peak, callJson, chainFor? }
 */
function benchStubAi(script, o = {}) {
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
            const label = (String(prompt).match(/【(.+?)】/) || [])[1] || ''
            const key = `${model}|${label}`
            const k = (asked.get(key) || 0) + 1
            asked.set(key, k)
            calls.push({ model, label, k, prompt, spec: callOpt?.spec })
            inflight++
            perModel.set(model, (perModel.get(model) || 0) + 1)
            peak.all = Math.max(peak.all, inflight)
            peak.perModel = Math.max(peak.perModel, perModel.get(model))
            try {
                await new Promise((r) => setTimeout(r, o.delayMs ?? 2))
                const fn = script[model]
                const out = typeof fn === 'function' ? fn(label, k, callOpt) : fn
                if (out && out.throw) throw new Error(out.throw)
                if (out && out.fail) {
                    for (const ev of out.fail.events || []) callOpt?.onEvent?.(ev)
                    return { ok: false, data: null, error: out.fail.error || '', providerId: '', attempts: 1, skipped: out.fail.skipped === true, errors: out.fail.errors || [] }
                }
                const c = check(out)
                if (c !== true) return { ok: false, data: null, error: 'OUTPUT_VALIDATION_FAILED', providerId: '', attempts: 1, skipped: false, errors: [`${model}:validation(0.0s)：${c}`] }
                return { ok: true, data: out, error: '', providerId: model, attempts: 1, skipped: false, errors: [] }
            }
            finally {
                inflight--
                perModel.set(model, perModel.get(model) - 1)
            }
        },
    }
}

const caseOf = (r, model, id) => r.models.find((x) => x.model === model).cases.find((c) => c.id === id)
const modelOf = (r, model) => r.models.find((x) => x.model === model)

describe('unit-bench', function() {

    after(() => {
        fs.rmSync(TMP, { recursive: true, force: true })
    })

    it('areaClassOf 與 CS8 題組執行之分類同義:無裁決 null、covered(不看契約)、未涵蓋合契約 new、不合 new-invalid、應然 { covered:false } 為 new', () => {
        assert.equal(areaClassOf(null), null)
        assert.equal(areaClassOf(undefined), null)
        assert.equal(areaClassOf({ covered: true }), 'covered')
        assert.equal(areaClassOf({ covered: true, valid: false }), 'covered')
        assert.equal(areaClassOf({ covered: false, valid: true }), 'new')
        assert.equal(areaClassOf({ covered: false, valid: false }), 'new-invalid')
        assert.equal(areaClassOf({ covered: false }), 'new')
    })

    it('交調度層之 check 驗外層形狀(index 1 且 covered 為布林;契約不擋,留給 new-invalid);與調度層之取最後一段合用時,尾隨之 [3] 不被取', () => {
        const ck = areaBenchRole.check
        assert.equal(ck([{ index: 1, covered: false, label: '', query: '' }]), true, '不合契約者仍過 check(本層分出 new-invalid)')
        for (const bad of [[3], [], [{ index: 2, covered: true }], [{ index: 1, covered: 'yes' }], { index: 1, covered: true }]) assert.notEqual(ck(bad), true, JSON.stringify(bad))
        const p = pickJsonReply('[{"index":1,"covered":true,"why":"既有領域已涵蓋"}]\n註：見 [3]', ck)
        assert.deepEqual([p.ok, p.data[0].covered], [true, true])
    })

    it('areaVerdictOf:非陣列、空陣列、無 index 1、covered 非布林 → 無裁決並註明;未涵蓋者以 domain.isValidItem 驗輸出契約', () => {
        const d = createAreaDomain()
        assert.match(areaVerdictOf({ a: 1 }, d).problem, /非 JSON 陣列（object）/)
        assert.match(areaVerdictOf([], d).problem, /空陣列/)
        assert.match(areaVerdictOf([{ index: 2, covered: true, why: 'x' }], d).problem, /無 index 1/)
        assert.match(areaVerdictOf([{ index: '1', covered: true, why: 'x' }], d).problem, /無 index 1/, 'index 須為數字 1(與契約之 Number.isInteger 一致)')
        assert.match(areaVerdictOf([{ index: 1, covered: 'yes' }], d).problem, /covered 非布林/)
        const ok = areaVerdictOf(NEW('海洋酸化', 'ocean acidification'), d)
        assert.deepEqual(ok, { verdict: { covered: false, valid: true, label: '海洋酸化', query: 'ocean acidification', why: '值得持續抓取' }, problem: '' })
        assert.equal(areaVerdictOf(NEW('海', 'ocean acidification'), d).verdict.valid, false, `label 少於 ${AREA_CONTRACT.labelMin} 字`)
        assert.equal(areaVerdictOf(NEW('海洋酸化', '海洋 酸化'), d).verdict.valid, false, 'query 須為英文')
        assert.equal(areaVerdictOf(NEW('海洋酸化', 'ocean'), d).verdict.valid, false, `query 少於 ${AREA_CONTRACT.queryMinWords} 詞`)
        const noWhy = areaVerdictOf([{ index: 1, covered: true }], d).verdict
        assert.equal(noWhy.valid, false, 'covered 亦須給 why')
        assert.equal(areaClassOf(noWhy), 'covered')
    })

    it('逐案判準:各回皆＝應然才通過;一回不符即不通過並逐回註明;兩回一致而錯者不通過(各回一致另列)', async () => {
        const ai = benchStubAi({
            good: right,
            flip: (label, k) => (label === '快速排序' && k === 2 ? NEW('快速排序', 'quicksort pivot selection') : right(label)),
            wrong: (label) => (label === '快速排序' ? NEW('快速排序', 'quicksort pivot selection') : right(label)),
        })
        const r = await runAreaBench({ models: ['good', 'flip', 'wrong'], cases: MINI, aiAdapter: ai })
        assert.equal(r.meta.runs, 2)
        assert.deepEqual(modelOf(r, 'good').score, { pass: 4, total: 4, rate: 1 })
        const f = caseOf(r, 'flip', 'a1')
        assert.equal(f.pass, false)
        assert.equal(f.consistent, false)
        assert.match(f.note, /第 2 回判 new「快速排序｜quicksort pivot selection」，應然 covered/)
        assert.match(f.note, /各回不一致/)
        assert.doesNotMatch(f.note, /第 1 回/, '相符之回不列為原因')
        const w = caseOf(r, 'wrong', 'a1')
        assert.equal(w.pass, false)
        assert.equal(w.consistent, true, '兩回一致而錯')
        assert.equal(modelOf(r, 'wrong').score.pass, 3)
    })

    it('判未涵蓋而 label／query 不合契約 → new-invalid,應然 new 之案不通過;合契約率只計取得回覆之各回', async () => {
        const ai = benchStubAi({
            sloppy: (label) => (label === '海洋酸化' ? NEW('海', '海洋') : right(label)),
        })
        const r = await runAreaBench({ models: ['sloppy'], cases: MINI, aiAdapter: ai })
        const c = caseOf(r, 'sloppy', 'a2')
        assert.deepEqual(c.runs.map((x) => x.cls), ['new-invalid', 'new-invalid'])
        assert.equal(c.pass, false)
        assert.match(c.note, /不合輸出契約（「海｜海洋」）/)
        const m = modelOf(r, 'sloppy')
        assert.deepEqual(m.contract, { valid: 6, total: 8, rate: 0.75 })
        assert.equal(m.calls.failed, 0)
    })

    it('保留題分列計分:general／holdout 各自之通過數與案數', async () => {
        const ai = benchStubAi({ gen: (label) => (label === '工程學' || label === '語音辨識' ? NEW('錯誤題目', 'wrong topic') : right(label)) })
        const r = await runAreaBench({ models: ['gen'], cases: MINI, aiAdapter: ai })
        const m = modelOf(r, 'gen')
        assert.deepEqual([m.general.pass, m.general.total, m.holdout.pass, m.holdout.total, m.score.pass, m.score.total], [2, 2, 1, 2, 3, 4])
        assert.equal(r.meta.holdout, 2)
    })

    it('呼叫失敗(ok:false、調度層拋錯)記為該回不通過並註明,不中斷:其餘案、其餘回與其餘模型照跑', async () => {
        const ai = benchStubAi({
            flaky: (label, k) => {
                if (label === '快速排序' && k === 1) return { fail: { error: 'Exit code 1', errors: ['flaky:exec(0.1s)'] } }
                if (label === '工程學' && k === 1) return { throw: '連線中斷' }
                return right(label)
            },
            good: right,
        })
        const r = await runAreaBench({ models: ['flaky', 'good'], cases: MINI, aiAdapter: ai })
        assert.equal(ai.calls.filter((c) => c.model === 'flaky').length, 8, '失敗不中斷:兩回四案皆有呼叫')
        const a1 = caseOf(r, 'flaky', 'a1')
        assert.equal(a1.pass, false)
        assert.deepEqual([a1.runs[0].callFail, a1.runs[0].failKind, a1.runs[1].cls], [true, 'error', 'covered'])
        assert.match(a1.note, /第 1 回呼叫失敗（執行錯誤：Exit code 1/)
        assert.match(caseOf(r, 'flaky', 'h1').note, /調度層拋錯：連線中斷/)
        assert.equal(caseOf(r, 'flaky', 'a2').pass, true)
        assert.equal(modelOf(r, 'flaky').calls.failed, 2)
        assert.equal(modelOf(r, 'flaky').stopped, '', '非連續之失敗不停測')
        assert.deepEqual(modelOf(r, 'good').score, { pass: 4, total: 4, rate: 1 })
    })

    it('限流即停:冷卻事件(非逾時所致)或限流字樣 → 停測該模型,其後各回記未呼叫;逾時所致之冷卻不算限流;其他模型照跑', async () => {
        const ai = benchStubAi({
            cooled: (label) => (label === '海洋酸化' ? { fail: { error: 'Exit code 1', events: [{ type: 'cooled', error: 'Exit code 1' }] } } : right(label)),
            worded: (label) => (label === '快速排序' ? { fail: { error: 'FreeUsageLimitError: Rate limit exceeded' } } : right(label)),
            slowcool: (label) => (label === '快速排序' ? { fail: { error: 'TIMEOUT after 300s', events: [{ type: 'cooled', error: 'TIMEOUT after 300s' }] } } : right(label)),
            good: right,
        })
        const r = await runAreaBench({ models: ['cooled', 'worded', 'slowcool', 'good'], cases: MINI, aiAdapter: ai })
        assert.equal(ai.calls.filter((c) => c.model === 'cooled').length, 2, '第 2 案限流後即停')
        const m = modelOf(r, 'cooled')
        assert.match(m.stopped, /額度用盡或限流，停測（第 1 回 a2/)
        assert.equal(m.calls.notRun, 6)
        assert.match(caseOf(r, 'cooled', 'h1').note, /第 1 回未呼叫（額度用盡或限流/)
        assert.equal(caseOf(r, 'cooled', 'a2').runs[0].failKind, 'limit')
        assert.equal(ai.calls.filter((c) => c.model === 'worded').length, 1, '限流字樣即停')
        assert.equal(modelOf(r, 'worded').calls.byKind.limit, 1)
        assert.equal(modelOf(r, 'slowcool').stopped, '', '逾時所致之冷卻記逾時、不即停')
        assert.equal(caseOf(r, 'slowcool', 'a1').runs[0].failKind, 'timeout')
        assert.deepEqual(modelOf(r, 'good').score, { pass: 4, total: 4, rate: 1 })
    })

    it('連續 stopAfterFails 回服務面失敗(逾時)即停測;回覆非 JSON 為模型產出之問題,不計入連續失敗', async () => {
        const timeout = { fail: { error: 'TIMEOUT after 300000ms', errors: ['slow:timeout(300.0s)'] } }
        const garbled = { fail: { error: 'OUTPUT_VALIDATION_FAILED', errors: ['garbled:validation(1.0s)：非 JSON（或輸出截斷）'], events: [{ type: 'skip-group', errorType: 'validation', stdout: '抱歉，我無法判斷這些候選' }] } }
        const ai = benchStubAi({ slow: () => timeout, garbled: () => garbled })
        const r = await runAreaBench({ models: ['slow', 'garbled'], cases: MINI, aiAdapter: ai })
        assert.equal(ai.calls.filter((c) => c.model === 'slow').length, 2)
        assert.match(modelOf(r, 'slow').stopped, /連續 2 回呼叫失敗，停測（最後一回：逾時）/)
        assert.equal(ai.calls.filter((c) => c.model === 'garbled').length, 8, '回覆非 JSON 不停測')
        const g = caseOf(r, 'garbled', 'a1')
        assert.equal(g.runs[0].failKind, 'reply')
        assert.match(g.note, /回覆非 JSON：OUTPUT_VALIDATION_FAILED.*；回覆「抱歉，我無法判斷這些候選」/)
        assert.equal(modelOf(r, 'garbled').calls.byKind.reply, 8)
        const r3 = await runAreaBench({ models: ['slow'], cases: MINI, aiAdapter: benchStubAi({ slow: () => timeout }), stopAfterFails: 3 })
        assert.equal(modelOf(r3, 'slow').calls.sent, 3, 'stopAfterFails 可調')
    })

    it('條目不可用(調度層 chainFor 拋錯)或調度層建立失敗 → 不呼叫,各回記未呼叫並註明', async () => {
        const ai = benchStubAi({ good: right }, { chainFor: (spec) => {
            if (spec.use === 'gone') throw new Error('席位引用了不可用的條目：gone（缺金鑰 X_KEYS）')
            return [spec]
        } })
        const r = await runAreaBench({ models: ['gone', 'good'], cases: MINI, aiAdapter: ai })
        assert.equal(ai.calls.filter((c) => c.model === 'gone').length, 0)
        const m = modelOf(r, 'gone')
        assert.match(m.stopped, /條目不可用：席位引用了不可用的條目：gone/)
        assert.deepEqual([m.calls.sent, m.calls.notRun, m.score.pass], [0, 8, 0])
        assert.match(caseOf(r, 'gone', 'a1').note, /第 1 回未呼叫（條目不可用/)
        const r2 = await runAreaBench({ models: ['x'], cases: MINI, adapterOf: () => { throw new Error('建不起來') } })
        assert.match(modelOf(r2, 'x').stopped, /調度層建立失敗：建不起來/)
    })

    it('併發:模型間同時至多 concurrency 個;同一模型內序列(不重疊),順序為第 1 回全部案 → 第 2 回', async () => {
        const script = { m1: right, m2: right, m3: right }
        const ai = benchStubAi(script, { delayMs: 8 })
        await runAreaBench({ models: ['m1', 'm2', 'm3'], cases: MINI, aiAdapter: ai })
        assert.equal(ai.peak.all, 2, '預設同時 2 個模型')
        assert.equal(ai.peak.perModel, 1, '同一模型不同時佔兩個請求')
        assert.deepEqual(ai.calls.filter((c) => c.model === 'm1').map((c) => `${c.label}#${c.k}`),
            ['快速排序#1', '海洋酸化#1', '工程學#1', '語音辨識#1', '快速排序#2', '海洋酸化#2', '工程學#2', '語音辨識#2'])
        const ai1 = benchStubAi(script, { delayMs: 3 })
        await runAreaBench({ models: ['m1', 'm2', 'm3'], cases: MINI, aiAdapter: ai1, concurrency: 1 })
        assert.equal(ai1.peak.all, 1)
        const ai3 = benchStubAi(script, { delayMs: 8 })
        await runAreaBench({ models: ['m1', 'm2', 'm3'], cases: MINI, aiAdapter: ai3, concurrency: 3 })
        assert.equal(ai3.peak.all, 3)
    })

    it('提示詞與領域發現子階段同源:送出＝domain.buildPrompt([候選], 既有領域);input.vocab 帶主題範圍句;席位 { use:模型, fallback:[] }(timeoutMs 給了即帶)', async () => {
        const cases = { ...MINI, cases: [...MINI.cases, { id: 'v1', holdout: false, input: { vocab: { domain: '天文學' }, candidate: { label: '麵包發酵', kind: 'clue', clueDocs: 3 }, areas: [{ label: '系外行星', query: 'exoplanet detection' }] }, expect: { covered: true }, why: '主題範圍句' }] }
        const ai = benchStubAi({ m: (label) => right(label) || COV('範圍外') })
        await runAreaBench({ models: ['m'], cases, aiAdapter: ai, runs: 1, timeoutMs: 1234 })
        const d = createAreaDomain()
        assert.equal(ai.calls[0].prompt, d.buildPrompt([MINI.cases[0].input.candidate], MINI.cases[0].input.areas))
        assert.deepEqual(ai.calls[0].spec, { use: 'm', fallback: [], timeoutMs: 1234 })
        const v = ai.calls.find((c) => c.label === '麵包發酵').prompt
        assert.match(v, /^你是「天文學」知識庫的/)
        assert.match(v, /本知識庫之主題範圍為「天文學」/)
        assert.doesNotMatch(ai.calls[0].prompt, /主題範圍為/, '未帶 vocab 之案不加主題範圍句')
        // 覆寫提示詞:domain 與 domainOf 皆用安裝方之 buildPrompt
        const mine = (vocab) => createAreaDomain({ vocab, buildPrompt: (cands, areas, ctx) => `自訂：${ctx.kbLabel}【${cands[0].label}】${areas.length}` })
        const ai2 = benchStubAi({ m: (label) => right(label) || COV('範圍外') })
        await runAreaBench({ models: ['m'], cases, aiAdapter: ai2, runs: 1, domain: mine(null), domainOf: mine })
        assert.equal(ai2.calls[0].prompt, '自訂：知識庫【快速排序】1')
        assert.equal(ai2.calls.find((c) => c.label === '麵包發酵').prompt, '自訂：「天文學」知識庫【麵包發酵】1')
        const ai3 = benchStubAi({ m: right })
        await runAreaBench({ models: ['m'], cases: MINI, aiAdapter: ai3, runs: 1 })
        assert.deepEqual(ai3.calls[0].spec, { use: 'm', fallback: [] }, '未給 timeoutMs 即不帶')
    })

    it('onProgress 逐回送出事件(start 帶 meta、call 帶紀錄、model-done 帶彙整);回呼拋錯不影響評分', async () => {
        const evs = []
        const r = await runAreaBench({ models: ['m'], cases: MINI, aiAdapter: benchStubAi({ m: right }), onProgress: (ev) => evs.push(ev) })
        assert.equal(evs[0].type, 'start')
        assert.equal(evs[0].meta.promptFp, r.meta.promptFp)
        const calls = evs.filter((e) => e.type === 'call')
        assert.equal(calls.length, 8)
        assert.deepEqual([calls[0].model, calls[0].caseId, calls[0].record.run, calls[0].record.cls], ['m', 'a1', 1, 'covered'])
        assert.equal(evs[evs.length - 1].type, 'model-done')
        assert.equal(evs[evs.length - 1].summary.score.pass, 4)
        const r2 = await runAreaBench({ models: ['m'], cases: MINI, aiAdapter: benchStubAi({ m: right }), onProgress: () => { throw new Error('回呼壞了') } })
        assert.equal(modelOf(r2, 'm').score.pass, 4)
    })

    it('runs 決定每案回數(1 回、3 回);設定錯誤於任何呼叫之前拋錯', async () => {
        const r1 = await runAreaBench({ models: ['m'], cases: MINI, aiAdapter: benchStubAi({ m: right }), runs: 1 })
        assert.deepEqual(modelOf(r1, 'm').cases.map((c) => c.runs.length), [1, 1, 1, 1])
        const r3 = await runAreaBench({ models: ['m'], cases: MINI, aiAdapter: benchStubAi({ m: (label, k) => (label === '工程學' && k === 3 ? NEW('工程學', 'engineering design') : right(label)) }), runs: 3 })
        assert.equal(caseOf(r3, 'm', 'h1').pass, false, '3 回中一回不符即不通過')
        const ai = benchStubAi({ m: right })
        await assert.rejects(runAreaBench({ models: [], cases: MINI, aiAdapter: ai }), /需要 models/)
        await assert.rejects(runAreaBench({ models: ['m'], cases: MINI, aiAdapter: ai, runs: 0 }), /runs 須為正整數/)
        await assert.rejects(runAreaBench({ models: ['m'], cases: MINI, aiAdapter: ai, concurrency: 1.5 }), /concurrency 須為正整數/)
        await assert.rejects(runAreaBench({ models: ['m'], cases: MINI }), /需要 aiAdapter/)
        await assert.rejects(runAreaBench({ models: ['m'], cases: MINI, aiAdapter: ai, domain: { buildPrompt: () => 'x' } }), /runAreaBench 之 domain 須具 buildPrompt、isValidItem（缺 isValidItem）/)
        await assert.rejects(runAreaBench({ models: ['m'], cases: { cases: [] }, aiAdapter: ai }), /至少一案/)
        assert.equal(ai.calls.length, 0, '設定錯誤不燒任何呼叫')
    })

    it('validateAreaCases:重複 id、缺 expect.covered、缺 why、候選缺 label、既有領域形狀錯、input.vocab 鍵不合 → 拋錯並列出全部問題', () => {
        const base = MINI.cases[0]
        const bad = [
            { ...base, id: 'x' },
            { ...base, id: 'x' },
            { ...base, id: 'y', expect: {} },
            { ...base, id: 'z', why: '' },
            { ...base, id: 'w', input: { candidate: { kind: 'clue' }, areas: [] } },
            { ...base, id: 'u', input: { candidate: { label: 'U' }, areas: [{ label: '只有標籤' }] } },
            { ...base, id: 't', input: { ...base.input, vocab: { domian: '打錯之鍵' } } },
            { ...base, id: 's', holdout: 'yes' },
        ]
        assert.throws(() => validateAreaCases(bad), (e) => {
            for (const p of [/cases\[1\]\(x\) id 重複/, /\(y\) expect\.covered 須為布林/, /\(z\) 缺 why/, /\(w\) 缺 input\.candidate\.label/,
                /\(u\) input\.areas 須為/, /\(t\) input\.vocab 不合：vocab 含不認得之鍵：domian/, /\(s\) holdout 須為布林/]) assert.match(e.message, p)
            assert.match(e.message, /題組不合格（7 項）/)
            return true
        })
        assert.throws(() => validateAreaCases(null), /至少一案/)
        assert.equal(validateAreaCases([base]).cases[0].holdout, false, '案陣列亦收;holdout 缺省為 false')
    })

    it('CS8 題組形狀相容:與 CS8 題組同形之樣本(無 type、無 input.vocab;概念與線索兩種候選)可直接評分', async () => {
        // 形狀同 CS8 題組檔:{ std, v, note, cases:[{ id, holdout, input:{ candidate:{ label, kind, support, growth, samples }|{ label, kind, clueDocs }, areas }, expect:{ covered }, why }] }
        const cs8Shape = {
            std: 'CS8',
            v: 1,
            note: '等形狀樣本',
            cases: [
                { id: 'a01', holdout: false, input: { candidate: { label: '珊瑚白化', kind: 'concept', support: 9, growth: 2, samples: [{ title: '海溫與共生藻' }] }, areas: [{ label: '珊瑚礁生態', query: 'coral reef ecology' }] }, expect: { covered: true }, why: '下位概念' },
                { id: 'a04', holdout: false, input: { candidate: { label: 'ProtoFold-X3模型', kind: 'clue', clueDocs: 2 }, areas: [{ label: '有機合成', query: 'organic synthesis' }] }, expect: { covered: true }, why: '過窄' },
                { id: 'h1', holdout: true, input: { candidate: { label: '微塑膠汙染', kind: 'concept', support: 10, growth: 2, samples: [{ title: '海洋中之塑膠微粒' }] }, areas: [{ label: '古典音樂', query: 'classical music history' }] }, expect: { covered: false }, why: '新領域' },
            ],
        }
        const set = validateAreaCases(cs8Shape)
        assert.deepEqual([set.std, set.v, set.cases.length], ['CS8', 1, 3])
        const ai = benchStubAi({ m: (label) => (label === '微塑膠汙染' ? NEW('微塑膠汙染', 'microplastic pollution') : COV()) })
        const r = await runAreaBench({ models: ['m'], cases: cs8Shape, aiAdapter: ai })
        assert.deepEqual(modelOf(r, 'm').score, { pass: 3, total: 3, rate: 1 })
        assert.deepEqual(modelOf(r, 'm').cases.map((c) => c.type), ['', '', ''])
        assert.match(ai.calls.find((c) => c.label === 'ProtoFold-X3模型').prompt, /文章線索，被 2 篇相異文件帶出/)
    })

    it('預設通用題組:結構有效、12～16 案、保留題 ≥4、線索類 ≥2、六種題型齊備、範圍外之案帶 vocab.domain、題型與應然相符、內容領域中立', () => {
        const raw = fs.readFileSync(AREA_CASES_FILE, 'utf8')
        assert.doesNotMatch(raw, NON_NEUTRAL, '通用題組須領域中立')
        const set = loadAreaCases()
        assert.equal(set.std, 'CS8')
        const n = set.cases.length
        assert.ok(n >= 12 && n <= 16, `案數 ${n}`)
        assert.ok(set.cases.filter((c) => c.holdout).length >= 4)
        assert.ok(set.cases.filter((c) => c.input.candidate.kind === 'clue').length >= 2)
        for (const c of set.cases) {
            assert.ok(c.id && c.why && typeof c.expect.covered === 'boolean', c.id)
            assert.match(c.why, /規則 [123]|主題範圍句/, `${c.id} 之 why 須寫明依據之規則`)
            if (c.input.candidate.kind === 'clue') assert.ok(Number.isInteger(c.input.candidate.clueDocs), c.id)
            else assert.ok(Number.isFinite(c.input.candidate.support) && Array.isArray(c.input.candidate.samples), c.id)
        }
        const types = new Set(set.cases.map((c) => c.type))
        assert.deepEqual([...types].sort(), ['hyponym', 'new', 'out-of-scope', 'synonym', 'too-broad', 'too-narrow'])
        for (const c of set.cases) {
            assert.equal(c.expect.covered, c.type !== 'new', `${c.id}：題型 ${c.type} 之應然`)
            if (c.type === 'out-of-scope') assert.ok(c.input.vocab?.domain, `${c.id} 須帶 vocab.domain`)
            else assert.equal(c.input.vocab, undefined, `${c.id} 非範圍外之案不帶 vocab`)
        }
    })

    it('DEFAULT_FREE_MODELS 與依判準自 w-dispatch-ai 目錄推得者一致(含 big-pickle、排除決策模型);各條目皆在目錄內;內建調度層下 oc: 條目免金鑰可解析、zen: 條目缺金鑰判不可用', () => {
        const ids = new Set(providersAll.map((p) => p.id))
        for (const m of DEFAULT_FREE_MODELS) assert.ok(ids.has(m), `${m} 不在 w-dispatch-ai 目錄`)
        // 內建調度層(不呼叫 AI;金鑰給空物件):命令列實際組席位之路徑
        const ad = createAiAdapter({ ai: resolveSettings({}).ai, workspace: path.join(TMP, 'ws'), env: {} })
        for (const m of DEFAULT_FREE_MODELS.filter((x) => x.startsWith('oc:'))) assert.doesNotThrow(() => ad.chainFor({ use: m, fallback: [] }), m)
        assert.throws(() => ad.chainFor({ use: 'zen:jev-1.13-free', fallback: [] }), /缺金鑰 OPENCODE_KEYS/)
        assert.deepEqual([...DEFAULT_FREE_MODELS].sort(), freeModelsOf().sort(), 'w-dispatch-ai 目錄之免費條目已變動:更新 DEFAULT_FREE_MODELS')
        assert.ok(DEFAULT_FREE_MODELS.includes('oc:opencode/big-pickle'))
        for (const p of providersAll.filter((x) => x.kind === 'api-typesafe-systemone')) assert.ok(!DEFAULT_FREE_MODELS.includes(p.id), `${p.id} 為決策模型`)
        assert.equal(new Set(DEFAULT_FREE_MODELS).size, DEFAULT_FREE_MODELS.length)
        // 規則:受測名單以預設領域發現席位之首選(capture.discover.ai 之 use)為首,席位之全部成員(use、fallback)皆在名單內——取自設定預設,不另抄一份名單
        //   (名單依目錄推導、另含席位未列之條目,故只驗首選在前與成員皆在名單內)
        const seat = resolveSettings({}).capture.discover.ai
        assert.equal(DEFAULT_FREE_MODELS[0], seat.use, '預設席位之首選(capture.discover.ai.use)在前')
        for (const m of [seat.use, ...seat.fallback]) assert.ok(DEFAULT_FREE_MODELS.includes(m), `預設席位成員 ${m} 須在受測名單內`)
        assert.deepEqual(DEFAULT_FREE_MODELS.slice(0, 3), ['oc:opencode/mimo-v2.6-flash-free', 'oc:opencode/big-pickle', 'oc:opencode/beam-free'])
        assert.deepEqual(freeModelsOf([{ id: 'a-free', kind: 'opencode' }, { id: 'b', model: 'x-free', kind: 'opencode' }, { id: 'c', kind: 'claude' }, { id: 'd-free', kind: 'api-typesafe-systemone' }]), ['a-free', 'b'])
    })

    it('報表:CSV 含 BOM、表頭與列數(模型數;模型×案數),逗號／引號／換行照錄跳脫;Markdown 含分數表、逐案明細、未通過原因', async () => {
        const tricky = 'a,"b"\nc'
        const ai = benchStubAi({
            good: right,
            // 標籤含逗號、引號、換行;查詢只一詞 → 不合契約(new-invalid)
            odd: (label) => (label === '海洋酸化' ? NEW(tricky, 'x') : right(label)),
        })
        const r = await runAreaBench({ models: ['odd', 'good'], cases: MINI, aiAdapter: ai })
        // 規則:兩份 CSV 皆以 UTF-8 BOM 開頭(試算表軟體以之判 UTF-8)
        for (const csv of [areaBenchModelsCsv(r), areaBenchCasesCsv(r)]) assert.equal(csv.charCodeAt(0), 0xFEFF, 'CSV 須含 BOM')
        const ms = parseCsv(areaBenchModelsCsv(r))
        assert.equal(ms.length, 3)
        assert.deepEqual(ms[0].slice(0, 4), ['模型', '通過', '案數', '通過率'])
        assert.deepEqual(ms.slice(1).map((x) => x[0]), ['good', 'odd'], '依通過數排序')
        assert.ok(ms.every((x) => x.length === ms[0].length))
        assert.equal(ms[1][3], '100.0%')
        const cs = parseCsv(areaBenchCasesCsv(r))
        assert.equal(cs.length, 1 + 2 * 4)
        assert.ok(cs.every((x) => x.length === cs[0].length), '各列欄數一致(含跳脫之欄)')
        assert.ok(cs[0].includes('第1回標籤') && cs[0].includes('第2回錯誤') && cs[0].includes('未通過原因'))
        const row = cs.find((x) => x[0] === 'odd' && x[1] === 'a2')
        assert.equal(row[cs[0].indexOf('第1回標籤')], tricky, '模型產出之文字照錄')
        assert.equal(row[cs[0].indexOf('第1回類別')], 'new-invalid')
        assert.equal(row[cs[0].indexOf('通過')], '否')
        const md = areaBenchMarkdown(r)
        for (const p of [/^# 領域發現 AI 能力評分/m, /^## 逐模型分數/m, /^\| good \| 4\/4 \| 2\/2 \| 2\/2 \|/m, /^## 逐案明細/m, /^### odd/m, /^## 未通過原因/m, /- a2〔應然 new；依據：規則 3 新領域〕：/]) assert.match(md, p)
        assert.ok(md.includes('a,"b" c'), 'Markdown 儲存格之換行已跳脫')
        assert.ok(!/\| a,"b"\nc/.test(md))
        const allPass = await runAreaBench({ models: ['good'], cases: MINI, aiAdapter: benchStubAi({ good: right }) })
        assert.match(areaBenchMarkdown(allPass), /（全數通過）/)
        assert.throws(() => areaBenchModelsCsv({}), /runAreaBench 之結果/)
    })

    it('writeAreaBenchReport:CSV×2、Markdown、JSON 落地於指定目錄,內容可讀回', async () => {
        const r = await runAreaBench({ models: ['m'], cases: MINI, aiAdapter: benchStubAi({ m: right }) })
        const out = writeAreaBenchReport(r, path.join(TMP, 'report'), { name: 'unit' })
        assert.equal(out.dir, path.join(TMP, 'report'))
        for (const f of Object.values(out.files)) assert.ok(fs.statSync(f).size > 0, f)
        assert.equal(path.basename(out.files.modelsCsv), 'unit-models.csv')
        assert.deepEqual(JSON.parse(fs.readFileSync(out.files.json, 'utf8')).models[0].score, { pass: 4, total: 4, rate: 1 })
        assert.match(fs.readFileSync(out.files.md, 'utf8'), /^\| m \| 4\/4 /m)
        const out2 = writeAreaBenchReport(r, path.join(TMP, 'report'))
        assert.equal(path.basename(out2.files.md), `area-bench-${r.meta.stamp}.md`, '未給 name 以結果之時間戳為檔名')
    })

    it('mergeAreaBenchBoard:累積評比表——新建、同角色同模型以本次覆蓋其餘保留、依通過數排序;停測或未完整者不寫;表頭不同即拋;含逗號引號之欄位可讀回', async () => {
        // 規則:bench/report.mjs 檔頭【評比表(累積)】
        const file = path.join(TMP, 'board', '模型評比.csv')
        fs.rmSync(path.dirname(file), { recursive: true, force: true })
        const wrongN = (label) => (label === '工程學' ? NEW('工程學', 'engineering design') : right(label))
        const r1 = await runAreaBench({ models: ['m', 'n'], cases: MINI, aiAdapter: benchStubAi({ m: right, n: wrongN }) })
        const b1 = mergeAreaBenchBoard(file, r1, { workspace: 'x,y "ws"' })
        assert.deepEqual([b1.written, b1.replaced, b1.skipped, b1.rows], [['m', 'n'], [], [], 2])
        const text1 = fs.readFileSync(file, 'utf8')
        assert.equal(text1.charCodeAt(0), 0xFEFF, '含 BOM')
        const lines1 = text1.slice(1).trim().split('\r\n')
        assert.equal(lines1[0], AREA_BENCH_BOARD_HEADER.join(','))
        assert.match(lines1[1], new RegExp(`^${AREA_BENCH_ROLE.replace(/[()]/g, '\\$&')},m,4,4,100\\.0%`), '通過多者在前')
        assert.match(lines1[2], /,n,3,4,75\.0%,/)
        assert.match(lines1[2], /,h1,/, '失分案列出(n 把過寬之「工程學」判為新領域)')
        assert.ok(lines1[1].includes('"x,y ""ws"""'), 'AI 工作目錄之逗號與引號依 RFC 4180 跳脫')
        // 第二次:n 改善 → 覆蓋 n 之舊列,m 保留;停測之 slow 不寫;工作目錄為專案外之絕對路徑 → 不入表(評比表隨套件發布,不得帶機器路徑)
        const timeout = { fail: { error: 'TIMEOUT after 300000ms', errors: ['slow:timeout(300.0s)'] } }
        const r2 = await runAreaBench({ models: ['n', 'slow'], cases: MINI, aiAdapter: benchStubAi({ n: right, slow: () => timeout }) })
        const b2 = mergeAreaBenchBoard(file, r2, { workspace: path.resolve(path.parse(process.cwd()).root, 'ws2') })
        assert.deepEqual([b2.written, b2.replaced, b2.rows], [['n'], ['n'], 2])
        assert.deepEqual(b2.skipped.map((x) => x.model), ['slow'])
        assert.match(b2.skipped[0].reason, /停測/)
        const lines2 = fs.readFileSync(file, 'utf8').slice(1).trim().split('\r\n')
        assert.match(lines2[1], /,m,4,4,/)
        assert.match(lines2[2], /,n,4,4,100\.0%,/, 'n 之舊列被覆蓋')
        assert.ok(lines2[1].includes('"x,y ""ws"""'), '未受測之 m 原列(含跳脫欄位)原樣保留')
        assert.ok(lines2[2].includes(',（專案外之工作目錄）,'), '專案外之絕對路徑不入表')
        assert.ok(!/[A-Za-z]:[\\/]/.test(lines2.join('\n')), '表內無磁碟機路徑')
        assert.ok(!lines2.some((l) => l.includes(',slow,')), '停測者不寫')
        // 表頭不同 → 拋錯、不覆寫
        const foreign = path.join(TMP, 'board', 'foreign.csv')
        fs.writeFileSync(foreign, '模型,分數\r\nx,1\r\n', 'utf8')
        assert.throws(() => mergeAreaBenchBoard(foreign, r1), /評比表之表頭與本版不同，不覆寫/)
        assert.equal(fs.readFileSync(foreign, 'utf8'), '模型,分數\r\nx,1\r\n')
        assert.throws(() => mergeAreaBenchBoard('', r1), /需要評比表路徑字串/)
    })

    it('提示詞指紋:同題組同提示詞相同;題組或提示詞一改即不同', async () => {
        const fp = async (opt) => (await runAreaBench({ models: ['m'], cases: MINI, aiAdapter: benchStubAi({ m: right }), runs: 1, ...opt })).meta.promptFp
        const a = await fp({})
        assert.match(a, /^[0-9a-f]{16}$/)
        assert.equal(await fp({}), a)
        const changed = { ...MINI, cases: MINI.cases.map((c, i) => (i === 0 ? { ...c, input: { ...c.input, areas: [] } } : c)) }
        assert.notEqual(await fp({ cases: changed }), a)
        assert.notEqual(await fp({ domain: createAreaDomain({ vocab: { kbLabel: '另一個知識庫' } }) }), a)
    })

    it('命令列:parseAreaBenchArgs 之預設與錯誤;runAreaBenchCli 以替身調度層跑完並寫出報表與逐回進度檔;bench/cli.mjs 被 import 時不執行且轉出同一實體', async () => {
        const d = parseAreaBenchArgs([])
        assert.deepEqual([d.models, d.runs, d.concurrency, d.timeoutMs, d.cases, d.env, d.out], [[...DEFAULT_FREE_MODELS], 2, 2, null, '', '', path.resolve('bench-out')])
        assert.deepEqual(parseAreaBenchArgs(['--models', 'free']).models, [...DEFAULT_FREE_MODELS])
        assert.deepEqual(parseAreaBenchArgs(['--models=a, b,a', '--runs=3', '--timeout', '9000']).models, ['a', 'b'])
        assert.equal(parseAreaBenchArgs(['--runs=3']).runs, 3)
        assert.equal(parseAreaBenchArgs(['--timeout', '9000']).timeoutMs, 9000)
        assert.equal(parseAreaBenchArgs(['--out', 'x/y']).out, path.resolve('x/y'), '輸出目錄以 cwd 解析')
        assert.equal(parseAreaBenchArgs(['-h']).help, true)
        assert.throws(() => parseAreaBenchArgs(['--model', 'a']), /不認得之參數：--model/)
        assert.throws(() => parseAreaBenchArgs(['--runs']), /--runs 缺值/)
        assert.throws(() => parseAreaBenchArgs(['--runs', '--out', 'x']), /--runs 缺值/)
        assert.throws(() => parseAreaBenchArgs(['--runs', '0']), /--runs 須為正整數/)
        assert.throws(() => parseAreaBenchArgs(['--runs', '2', '--runs', '3']), /重複給定/)
        assert.throws(() => parseAreaBenchArgs(['--models', ' , ']), /未列出任何條目/)
        // 時區:預設 Asia/Taipei,可由 --tz 指定;無效時區於解析時即拋
        assert.equal(d.timeZone, 'Asia/Taipei')
        assert.equal(parseAreaBenchArgs(['--tz', 'UTC']).timeZone, 'UTC')
        assert.equal(parseAreaBenchArgs(['--tz=Europe/London']).timeZone, 'Europe/London')
        assert.throws(() => parseAreaBenchArgs(['--tz', 'Nowhere/City']), /--tz 須為 IANA 時區/)
        // 評比表:未給不寫;給了以 cwd 解析
        assert.equal(d.board, '')
        assert.equal(parseAreaBenchArgs(['--board', 'x/模型評比.csv']).board, path.resolve('x/模型評比.csv'))
        // 命令列檔:被 import 時不執行(本檔頂層已 import 之;若執行,mocha 之參數會被當成評分參數而失敗),轉出者與入口同一實體
        assert.equal(cliNs.runAreaBenchCli, runAreaBenchCli)
        assert.equal(WKnowledgeCapture.runAreaBenchCli, runAreaBenchCli)
        assert.match(AREA_BENCH_USAGE, /--models/)
        // 用法首句與角色之 cli.command＝本命令列檔自套件根起算之實際位置(佈局為 src/ 時須帶 src/;印出之指令可直接複製執行)
        const cliRel = path.relative(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), fileURLToPath(import.meta.resolve('../src/bench/cli.mjs'))).replace(/\\/g, '/')
        assert.equal(cliRel, 'src/bench/cli.mjs')
        assert.equal(areaBenchRole.cli.command, `node ${cliRel}`)
        assert.ok(AREA_BENCH_USAGE.startsWith(`用法：node ${cliRel} [--models `), AREA_BENCH_USAGE.split('\n')[0])

        fs.mkdirSync(TMP, { recursive: true })
        const casesFile = path.join(TMP, 'mini.json')
        fs.writeFileSync(casesFile, JSON.stringify(MINI), 'utf8')
        const outDir = path.join(TMP, 'cli-out')
        const lines = []
        const log = { info: (m) => lines.push(m), error: (m) => lines.push(m) }
        const ai = benchStubAi({ m: right, n: (label) => (label === '工程學' ? NEW('工程學', 'engineering design') : right(label)) })
        const res = await runAreaBenchCli(['--models', 'm,n', '--cases', casesFile, '--out', outDir, '--runs', '2'], { aiAdapter: ai, log })
        assert.equal(res.result.models.length, 2)
        for (const f of Object.values(res.report.files)) assert.ok(fs.existsSync(f), f)
        assert.equal(path.dirname(res.report.files.md), outDir)
        const prog = fs.readFileSync(res.progressFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
        assert.equal(prog.filter((e) => e.type === 'call').length, 2 * 4 * 2, '逐回即存')
        assert.ok(lines.some((l) => /\[n\] 完成：通過 3\/4/.test(l)))
        assert.ok(!fs.existsSync(path.join(outDir, 'ai-workspace')), '注入調度層時不建 AI 工作目錄')
        assert.match(res.result.meta.startedAt, /\+08:00$/, '預設時區 Asia/Taipei')
        assert.equal(res.board, null, '未給 --board 不寫評比表')
        const boardFile = path.join(TMP, 'cli-board', '模型評比.csv')
        const rb = await runAreaBenchCli(['--models', 'm', '--cases', casesFile, '--out', outDir, '--runs', '1', '--board', boardFile], { aiAdapter: ai, log })
        assert.deepEqual([rb.board.file, rb.board.written], [boardFile, ['m']])
        assert.ok(lines.some((l) => l.startsWith(`評比表：${boardFile}`)), '印出評比表路徑')
        assert.match(fs.readFileSync(boardFile, 'utf8'), /,m,4,4,100\.0%,/)
        const utc = await runAreaBenchCli(['--models', 'm', '--cases', casesFile, '--out', outDir, '--runs', '1', '--tz', 'UTC'], { aiAdapter: ai, log })
        assert.match(utc.result.meta.startedAt, /\+00:00$/, '--tz 指定之時區用於評分時間')
        assert.deepEqual(await runAreaBenchCli(['--help'], { log }), { help: true })
        await assert.rejects(runAreaBenchCli(['--models', 'm', '--cases', casesFile, '--out', outDir, '--env', path.join(TMP, 'no-such.env')], { aiAdapter: ai, log }), /金鑰檔不存在/)
        assert.equal(AREA_FAIL_KINDS.timeout, '逾時')
    })
})
