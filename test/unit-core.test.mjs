// unit-core.test.mjs — 核心件(core/)單元測試:
//   kernel(洋蔥組合、first 錨點、認名掛載、逐項執行與 emit、輸入檢查)、runtime、dirs、
//   util(patterns／records／web)、standards/verdict、vocab(含 vocabKit:詞彙表解析之共用件)、ops(runSummary／browserHygiene)
//   鎖、時鐘、日誌、時間預算、小工具與子行程 JSON 執行屬執行秩序件(經 core/runnerPackage 取自 w-data-pipeline／w-dispatch-ai／wsemi,其行為之測試隨件在該等套件內);概念鍵與正體另見 unit-core-text;分層另見 unit-core-layers
// 執行:自套件根 npx mocha test/unit-core.test.mjs(暫存落 test/_tmp/core-<pid>,測完即刪;不發網路)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defineMw, defineFirstMw, applyTaps, makeMsg, count, composeChain, runChainOverMsgs, stdReport, MwContractError } from '../src/core/kernel.mjs'
import { resolveRuntime, positiveNumber, limitMinOfDeadline } from '../src/core/runtime.mjs'
import { normalizeWorkDir, expandDirs } from '../src/core/dirs.mjs'
import { genClockTZ } from '../src/core/runnerPackage.mjs'
import { toPatterns } from '../src/core/util/patterns.mjs'
import { normalizeConcept, sha1, contentSha1 } from '../src/core/util/text.mjs'
import { given, strOf, textValueOf, strictTextOf, textListOf, uniq, jsonClone, cmp, unknownKeysProblem, checkKeys } from '../src/core/util/values.mjs'
import { isDirectRun } from '../src/core/util/cli.mjs'
import { msgOf } from './tools/testKit.mjs'
import { csvCell, toCsv, mdCell } from '../src/core/util/table.mjs'
import W from 'w-data-pipeline/src/WDataPipeline.mjs'
import { sourceId, autoSourceOrigin, sourceOriginOf, docRecord, externalDocOf, DEFAULT_DEDUP, defaultToRecord, defaultToLinkedRecord } from '../src/core/util/records.mjs'
import { normalizeUrl, unwrapNewsUrl } from '../src/core/util/web.mjs'
import { STATUS, result } from '../src/core/standards/verdict.mjs'
import { VOCAB_DEFAULT, resolveVocab, kbLabelOf, pickCaptureVocab } from '../src/core/vocab/vocabDefault.mjs'
import { vocabHeadOf, pickVocabKeys, mergeGuideFields, renameChainProblems } from '../src/core/vocab/vocabKit.mjs'
import { resolveSettings } from '../src/core/settingsDefault.mjs'
import { buildRunSummary, writeRunSummary, readRunSummary, writeRunStart, readRunStart, subReportOf, sanitize, RUN_SUMMARY_VERSION } from '../src/core/ops/runSummary.mjs'
import { profileDirOf, PLAYWRIGHT_PROFILE_PREFIX } from '../src/core/ops/browserHygiene.mjs'
import { NOTE_FIELDS, noteDocIdOf, noteCreatedMsOf, noteTitleOf, noteConsumedOf, noteConceptsOf, notePrimaryConceptOf } from '../src/core/stores/noteFields.mjs'

// 暫存路徑由本檔位置推導(與 cwd 無關);帶 pid 後綴使並行之多個 mocha 行程互不干擾;after 清除
const TMP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), `_tmp/core-${process.pid}`).replace(/\\/g, '/')
const MIN = 60_000

describe('unit-core', function() {

    before(function() {
        fs.rmSync(TMP, { recursive: true, force: true })
        fs.mkdirSync(TMP, { recursive: true })
    })

    after(function() {
        fs.rmSync(TMP, { recursive: true, force: true })
    })

    // ══════════════════════════ kernel ══════════════════════════
    describe('kernel', function() {

        const tag = (name, trace) => defineMw({
            name,
            handle: async (msg, ctx, next) => {
                trace.push(`${name}↓`); const r = await next(msg); trace.push(`${name}↑`); return r
            }
        })

        // ── 洋蔥語意 ──
        it('洋蔥順序:下行依序、上行反序(Koa compose)', async () => {
            const trace = []
            const run = composeChain([tag('a', trace), tag('b', trace), tag('c', trace)])
            await run(makeMsg('doc', {}), {})
            assert.deepEqual(trace, ['a↓', 'b↓', 'c↓', 'c↑', 'b↑', 'a↑'])
        })

        it('短路:不呼叫 next 即完結,halted 記錄短路者,後段不執行', async () => {
            const trace = []
            const gate = defineMw({
                name: 'gate',
                handle: async (msg) => {
                    trace.push('gate'); return msg
                }
            })
            const run = composeChain([tag('a', trace), gate, tag('c', trace)])
            const { halted } = await run(makeMsg('doc', {}), {})
            assert.equal(halted, 'gate')
            assert.deepEqual(trace, ['a↓', 'gate', 'a↑'], 'c 不得執行;a 的上行仍要走完(收尾語意)')
        })

        it('topics/when 不合 → 原樣放行(透明),不算短路', async () => {
            const trace = []
            const onlyNote = defineMw({
                name: 'onlyNote',
                topics: ['note'],
                handle: async (msg, ctx, next) => {
                    trace.push('onlyNote'); return next(msg)
                }
            })
            const skipEven = defineMw({
                name: 'skipEven',
                when: (m) => m.data.i % 2 === 1,
                handle: async (msg, ctx, next) => {
                    trace.push('skipEven'); return next(msg)
                }
            })
            const run = composeChain([onlyNote, skipEven, tag('z', trace)])
            const { halted } = await run(makeMsg('doc', { i: 2 }), {})
            assert.equal(halted, '')
            assert.deepEqual(trace, ['z↓', 'z↑'], '兩顆都透明放行')
        })

        it('msg 沿鏈傳遞:next(m2) 換信封後,下游收到 m2', async () => {
            const swap = defineMw({ name: 'swap', handle: (msg, ctx, next) => next(makeMsg('doc', { swapped: true })) })
            const probe = defineMw({
                name: 'probe',
                handle: (msg, ctx, next) => {
                    assert.equal(msg.data.swapped, true); return next(msg)
                }
            })
            await composeChain([swap, probe])(makeMsg('doc', { swapped: false }), {})
        })

        // ── first 錨點 ──
        it('first:候選依序試,第一個非空者勝出,結果與勝者記入 _first', async () => {
            const first = defineFirstMw({
                name: 'route',
                candidates: [
                    { name: 'c1', probe: () => null },
                    { name: 'c2', probe: () => 'hit2' },
                    {
                        name: 'c3',
                        probe: () => {
                            throw new Error('不該試到 c3')
                        }
                    },
                ],
            })
            const msg = makeMsg('doc', {})
            await composeChain([first])(msg, {})
            assert.equal(msg.data._first.route, 'hit2')
            assert.equal(msg.data._first.routeBy, 'c2')
        })

        it('first:tap add 追加候選;enforce pre 插頭', async () => {
            const first = defineFirstMw({ name: 'route', candidates: [{ name: 'c1', probe: () => 'base' }] })
            const chain = applyTaps([first], { route: { add: [{ name: 'mine', probe: () => 'mine!', enforce: 'pre' }] } })
            const msg = makeMsg('doc', {})
            await composeChain(chain)(msg, {})
            assert.equal(msg.data._first.route, 'mine!', 'pre 候選插頭應先勝出')
            // 原鏈不受污染
            const msg2 = makeMsg('doc', {})
            await composeChain([first])(msg2, {})
            assert.equal(msg2.data._first.route, 'base')
        })

        // ── 認名掛載 ──
        it('tap before/after/replace:定位正確、enforce 分帶排序', async () => {
            const trace = []
            const chain = applyTaps(
                [tag('a', trace), tag('b', trace)],
                {
                    b: {
                        before: [tag('pre2', trace), { ...tag('pre1', trace), enforce: 'pre' }],
                        after: [tag('post1', trace)],
                        replace: tag('B2', trace),
                    }
                },
            )
            await composeChain(chain)(makeMsg('doc', {}), {})
            const downs = trace.filter((s) => s.endsWith('↓')).map((s) => s.slice(0, -1))
            assert.deepEqual(downs, ['a', 'pre1', 'pre2', 'B2', 'post1'], 'pre 帶排最前;b 被 B2 置換')
        })

        it('tap 錨點不存在/未知鍵/對非 first 錨點 add → 定義期拋錯', () => {
            const base = [defineMw({ name: 'a', handle: (m, c, n) => n(m) })]
            assert.throws(() => applyTaps(base, { nope: { replace: base[0] } }), MwContractError)
            assert.throws(() => applyTaps(base, { a: { insert: [] } }), MwContractError)
            assert.throws(() => applyTaps(base, { a: { add: [{ name: 'x', probe: () => 1 }] } }), /非 first 錨點/)
            // 無錨點之訊息一律附鏈名與可用錨點(opt.chainName 未給或 opt 非物件時鏈名為「(未名鏈)」);原型鏈上之名不是錨點
            assert.throws(() => applyTaps(base, { nope: { after: [] } }, { chainName: 'X' }), (e) => e instanceof MwContractError && e.message === '鏈[X] 無錨點「nope」(可用:a)')
            assert.throws(() => applyTaps(base, { nope: { after: [] } }, 'bad'), (e) => e.message === '鏈[(未名鏈)] 無錨點「nope」(可用:a)')
            assert.throws(() => applyTaps(base, { toString: { after: [] } }, { chainName: 'X' }), (e) => e.message === '鏈[X] 無錨點「toString」(可用:a)')
        })

        it('鏈內 mw 名重複/非 defineMw 產物 → 定義期拋錯', () => {
            const a = defineMw({ name: 'a', handle: (m, c, n) => n(m) })
            assert.throws(() => composeChain([a, defineMw({ name: 'a', handle: (m, c, n) => n(m) })]), /重複/)
            assert.throws(() => composeChain([a, { name: 'b', handle: () => {} }]), /非 defineMw/)
        })

        // ── 逐項執行與 emit ──
        it('runChainOverMsgs:stats 加總、emit 衍生訊息從鏈頭續跑、逐項隔離', async () => {
            const seen = []
            const splitter = defineMw({
                name: 'split',
                handle: async (msg, ctx, next) => {
                    seen.push(msg.data.id)
                    count(msg, 'seen')
                    if (msg.data.id === 'mother') {
                        ctx.emit(makeMsg('doc', { id: 'child1' }, { from: 'mother' }))
                        ctx.emit(makeMsg('doc', { id: 'child2' }, { from: 'mother' }))
                    }
                    if (msg.data.id === 'boom') throw new Error('炸')
                    return next(msg)
                },
            })
            const r = await runChainOverMsgs({
                chain: [splitter],
                ctx: {},
                chainName: 'test',
                msgs: [makeMsg('doc', { id: 'mother' }), makeMsg('doc', { id: 'boom' }), makeMsg('doc', { id: 'tail' })],
            })
            assert.deepEqual(seen, ['mother', 'boom', 'tail', 'child1', 'child2'], '衍生訊息排佇列尾、同鏈續跑')
            assert.equal(r.stats.seen, 4, 'boom 拋錯不計入(其 stats 丟棄)、其餘 4 項各計 1')
            assert.equal(r.fails, 1, '單項拋錯記 fail 不中斷')
            assert.match(r.errors[0], /炸/)
        })

        it('runChainOverMsgs:shouldStop 守門——回 true 即不再取件,未處理者計 left、其 stats 不計、記錄不動', async () => {
            let n = 0
            const tick = defineMw({
                name: 'tick',
                handle: async (msg, ctx, next) => {
                    n++; count(msg, 'done'); return next(msg)
                }
            })
            const r = await runChainOverMsgs({
                chain: [tick],
                ctx: {},
                chainName: 'stop',
                msgs: [1, 2, 3, 4].map((i) => makeMsg('doc', { i })),
                shouldStop: () => n >= 2, // 第 3 筆取件前逾時間預算
            })
            assert.equal(n, 2, '進行中的那一筆跑完,之後不再取件')
            assert.equal(r.left, 2, '未處理者計 left(逐篇抓取據此回報「留下輪」)')
            assert.equal(r.stats.done, 2)
            assert.equal(r.fails, 0, '守門停止不是失敗')
            const r2 = await runChainOverMsgs({ chain: [tick], ctx: {}, msgs: [makeMsg('doc', {})] })
            assert.equal(r2.left, 0, '未給 shouldStop 時 left 恆 0')
        })

        it('runChainOverMsgs:單筆拋錯時呼叫 onFail 落帳(拋錯者之例外不覆蓋原錯誤);errors 至多留 5 筆樣本', async () => {
            const boom = defineMw({
                name: 'boom',
                handle: async () => {
                    throw new Error('逐項鏈異常')
                }
            })
            const failed = []
            const r = await runChainOverMsgs({
                chain: [boom],
                ctx: {},
                chainName: 'onfail',
                msgs: Array.from({ length: 7 }, (_, i) => makeMsg('doc', { id: `m${i}` })),
                onFail: async (m, e) => {
                    failed.push([m.data.id, e.message])
                    if (m.data.id === 'm0') throw new Error('落帳失敗不得蓋掉原錯誤')
                },
            })
            assert.equal(r.fails, 7)
            assert.equal(failed.length, 7, 'onFail 每筆皆呼叫;onFail 拋錯不中斷後續')
            assert.deepEqual(failed[1], ['m1', '逐項鏈異常'])
            assert.equal(r.errors.length, 5, '錯誤樣本至多 5 筆')
            assert.match(r.errors[0], /^doc:逐項鏈異常/)
        })

        it('emit 超過上限 → 拋錯(無限衍生保險絲)', async () => {
            const loop = defineMw({
                name: 'loop',
                handle: async (msg, ctx, next) => {
                    ctx.emit(makeMsg('doc', {})); return next(msg)
                }
            })
            const r = await runChainOverMsgs({ chain: [loop], ctx: {}, msgs: [makeMsg('doc', {})], maxEmits: 5, chainName: 'loop' })
            assert.ok(r.fails >= 1, '超限那次記 fail')
            assert.ok(r.errors.some((e) => /emit 超過上限/.test(e)))
        })

        // ── report ──
        it('stdReport:核心統計鍵一律補零(外部監控只認這組)', () => {
            const r = stdReport({ stats: { in: 3 }, summary: 'x' })
            assert.deepEqual(r.stats, { in: 3, out: 0, skip: 0, fail: 0, aiCalls: 0 })
            assert.equal(r.ok, true)
        })

        // ── 洋蔥契約:每環只可呼叫一次 next(重複呼叫會讓下游整段再跑一次)──
        it('同一環重複呼叫 next → 拋 MwContractError,下游只跑一次(同 Koa compose)', async () => {
            let downstream = 0
            const twice = defineMw({
                name: 'twice',
                handle: async (m, c, next) => {
                    await next(m); return next(m)
                }
            })
            const tail = defineMw({
                name: 'tail',
                handle: async (m, c, next) => {
                    downstream++; return next(m)
                }
            })
            await assert.rejects(() => composeChain([twice, tail], { chainName: 'x' })(makeMsg('doc', {}), {}), (e) => e instanceof MwContractError && /重複呼叫 next/.test(e.message))
            assert.equal(downstream, 1, '第二次呼叫即拋錯,下游不得重跑(重複落庫/重複寫檔)')
            const r = await runChainOverMsgs({ chain: [twice, tail], ctx: {}, msgs: [makeMsg('doc', {})], chainName: 'x' })
            assert.equal(r.fails, 1, '逐項執行器將之記為該項失敗(隔離,不中斷整段)')
        })
    })

    // ══════════════════════════ kernel 輸入檢查 ══════════════════════════
    describe('kernel 輸入檢查', function() {

        // ── applyTaps ──
        it('applyTaps:錨點之 before/after/add 給了但非陣列 → 拋 MwContractError(而非 for...of 對非陣列值之「not iterable」TypeError)', () => {
            const a = defineMw({ name: 'a', handle: (m, c, n) => n(m) })
            assert.throws(() => applyTaps([a], { a: { before: a } }), MwContractError)
            assert.throws(() => applyTaps([a], { a: { before: a } }), /之「before」須為陣列/)
            assert.throws(() => applyTaps([a], { a: { after: a } }), /之「after」須為陣列/)
            assert.throws(() => applyTaps([a], { a: { add: a } }), /之「add」須為陣列/)
        })

        it('applyTaps:before/after 給有效陣列 → 掛載成功、順序正確', () => {
            const a = defineMw({ name: 'a', handle: (m, c, n) => n(m) })
            const b = defineMw({ name: 'b', handle: (m, c, n) => n(m) })
            const d = defineMw({ name: 'd', handle: (m, c, n) => n(m) })
            const chain = applyTaps([a], { a: { before: [b], after: [d] } })
            assert.deepEqual(chain.map((m) => m.name), ['b', 'a', 'd'])
        })

        it('applyTaps:opt 非物件(含 null)→ 視為{}(opt=null 不得在 opt.chainName 存取處拋 TypeError)', () => {
            const a = defineMw({ name: 'a', handle: (m, c, n) => n(m) })
            assert.doesNotThrow(() => applyTaps([a], null, null))
            assert.doesNotThrow(() => applyTaps([a], { a: { before: [] } }, 'not-an-object'))
        })

        // ── runChainOverMsgs ──
        it('runChainOverMsgs:opt 非物件 → 拋 MwContractError(訊息:需要 opt 物件)', async () => {
            await assert.rejects(() => runChainOverMsgs(undefined), (e) => e instanceof MwContractError && /runChainOverMsgs 需要 opt 物件/.test(e.message))
            await assert.rejects(() => runChainOverMsgs('bogus'), MwContractError)
            await assert.rejects(() => runChainOverMsgs(42), MwContractError)
        })

        it('runChainOverMsgs:opt.msgs 給了但非陣列 → 拋 MwContractError;未給時視為[]', async () => {
            const a = defineMw({ name: 'a', handle: (m, c, n) => n(m) })
            await assert.rejects(() => runChainOverMsgs({ chain: [a], ctx: {}, msgs: 'bogus' }), (e) => e instanceof MwContractError && /opt\.msgs 須為陣列/.test(e.message))
            const r = await runChainOverMsgs({ chain: [a], ctx: {} })
            assert.deepEqual(r, { stats: {}, halts: {}, fails: 0, errors: [], left: 0 })
        })

        it('runChainOverMsgs:opt.msgs 給有效陣列 → 逐項執行並計入 stats', async () => {
            const a = defineMw({
                name: 'a',
                handle: (m, c, n) => {
                    count(m, 'seen')
                    return n(m)
                },
            })
            const r = await runChainOverMsgs({ chain: [a], ctx: {}, msgs: [makeMsg('doc', {})] })
            assert.equal(r.stats.seen, 1)
        })

        // ── makeMsg ──
        it('makeMsg:meta 非物件 → 回退為{};topic 為空或 data 非物件 → 拋 MwContractError', () => {
            assert.deepEqual(makeMsg('doc', { a: 1 }, 'bogus').meta, {})
            assert.deepEqual(makeMsg('doc', { a: 1 }, 42).meta, {})
            assert.deepEqual(makeMsg('doc', { a: 1 }, [1, 2]).meta, {})
            assert.throws(() => makeMsg('', {}), MwContractError)
            assert.throws(() => makeMsg('doc', null), MwContractError)
            assert.throws(() => makeMsg('doc', 'x'), MwContractError)
        })

        it('makeMsg:meta 為有效物件 → 逐鍵帶入(複製,不與輸入同一物件)', () => {
            const meta = { from: 'x' }
            const m = makeMsg('doc', {}, meta)
            assert.deepEqual(m.meta, { from: 'x' })
            assert.notEqual(m.meta, meta)
        })

        // ── count ──
        it('count:n 非數字 → 回退為1', () => {
            const m = makeMsg('doc', {})
            count(m, 'k', 'bogus')
            assert.equal(m.stats.k, 1)
            count(m, 'k', {})
            assert.equal(m.stats.k, 2)
        })

        it('count:n 為有效數字(含數字字串)→ 累加', () => {
            const m = makeMsg('doc', {})
            count(m, 'k', 5)
            count(m, 'k', '3')
            assert.equal(m.stats.k, 8)
        })
    })

    // ══════════════════════════ runtime ══════════════════════════
    describe('runtime(執行期生效值之單一來源)', function() {

        const CTX = { workDir: 'c:/kb', dirs: { tmp: 'c:/kb/tmp', state: 'c:/kb/state', log: 'c:/kb/log' } }
        const NONE_WARN = /^未給 scheduleLimitMin 亦未給 deadlineMs，整輪時間預算採套件預設 50 分/
        const rr = (cfg) => resolveRuntime(cfg, CTX)

        // ── 排程上限:值有效性,及其推導之預算／鎖陳舊／本輪宣告之上限 ──
        it('皆未給:時間預算 50 分、鎖陳舊 60 分、本輪宣告之上限 null,並警告未給', () => {
            const r = rr({})
            assert.equal(r.scheduleLimitMin, null)
            assert.equal(r.limitMin, null)
            assert.equal(r.deadlineMs, 50 * MIN)
            assert.equal(r.lockStaleMs, 60 * MIN)
            assert.equal(r.warnings.length, 1)
            assert.match(r.warnings[0], NONE_WARN)
        })

        it('頂層上限 65:預算＝上限−6 分、鎖陳舊＝上限＋5 分、本輪宣告之上限 65;數字字串同數字', () => {
            for (const v of [65, '65', ' 65 ']) {
                const r = rr({ scheduleLimitMin: v })
                assert.equal(r.scheduleLimitMin, 65, `值 ${JSON.stringify(v)}`)
                assert.equal(r.deadlineMs, 59 * MIN)
                assert.equal(r.lockStaleMs, 70 * MIN)
                assert.equal(r.limitMin, 65)
                assert.deepEqual(r.warnings, [])
            }
        })

        it('頂層上限為大值(480):預算＝上限−6 分、鎖陳舊＝上限＋5 分、本輪宣告之上限 480;無警告', () => {
            const r = rr({ scheduleLimitMin: 480 })
            assert.equal(r.scheduleLimitMin, 480)
            assert.equal(r.limitMin, 480)
            assert.equal(r.deadlineMs, 474 * MIN)
            assert.equal(r.lockStaleMs, 485 * MIN)
            assert.deepEqual(r.warnings, [])
        })

        it('排程上限只取頂層 cfg.scheduleLimitMin:cfg.monitor 內之同名鍵不作用(視同未給);頂層有效時亦不被其覆寫', () => {
            const m = rr({ monitor: { scheduleLimitMin: 60 } })
            assert.equal(m.scheduleLimitMin, null)
            assert.equal(m.limitMin, null)
            assert.equal(m.deadlineMs, 50 * MIN)
            assert.equal(m.warnings.length, 1)
            assert.match(m.warnings[0], NONE_WARN)
            const t = rr({ scheduleLimitMin: 480, monitor: { scheduleLimitMin: 60 } })
            assert.deepEqual([t.scheduleLimitMin, t.limitMin, t.lockStaleMs], [480, 480, 485 * MIN])
            assert.deepEqual(t.warnings, [])
        })

        it('頂層無效(0／負／非數字／空字串／非有限／布林／物件):視同未給並指名警告,另報未給(預算採預設)', () => {
            for (const bad of [0, -5, 'abc', '', NaN, Infinity, true, {}]) {
                const r = rr({ scheduleLimitMin: bad })
                assert.equal(r.scheduleLimitMin, null, `值 ${String(bad)}`)
                assert.equal(r.limitMin, null, `值 ${String(bad)}:無效上限不宣告(外部監控用其預設判界)`)
                assert.equal(r.deadlineMs, 50 * MIN, `值 ${String(bad)}`)
                assert.equal(r.warnings.length, 2, `值 ${String(bad)}:${r.warnings.join('｜')}`)
                assert.match(r.warnings[0], /^cfg\.scheduleLimitMin 無效（收到 .+；須為大於 0 之分鐘數），視同未給$/)
                assert.match(r.warnings[1], NONE_WARN)
            }
            // 明給時間預算者:只報無效、不另報未給;本輪宣告之上限由預算推回
            const b = rr({ scheduleLimitMin: 0, deadlineMs: 420 * MIN })
            assert.equal(b.warnings.length, 1)
            assert.match(b.warnings[0], /^cfg\.scheduleLimitMin 無效（收到 0；/)
            assert.equal(b.deadlineMs, 420 * MIN)
            assert.equal(b.limitMin, 426)
        })

        // ── 時間預算與鎖陳舊期限 ──
        it('只給 deadlineMs(7 小時):鎖陳舊＝預算＋6 分＋5 分(不取固定 60 分,否則長時執行 60 分後即被接管);本輪宣告之上限由預算推回', () => {
            const r = rr({ deadlineMs: 420 * MIN })
            assert.equal(r.scheduleLimitMin, null)
            assert.equal(r.deadlineMs, 420 * MIN)
            assert.equal(r.lockStaleMs, 431 * MIN)
            assert.equal(r.limitMin, 426, '預算＋6 分')
            assert.deepEqual(r.warnings, [], '給了預算即不報未給')
            assert.equal(rr({ deadlineMs: String(420 * MIN) }).deadlineMs, 420 * MIN, '數字字串')
        })

        it('上限與預算皆給:預算以明給者為準;鎖陳舊取兩者推導之大者;本輪宣告之上限取排程上限', () => {
            const a = rr({ scheduleLimitMin: 65, deadlineMs: 30 * MIN })
            assert.equal(a.deadlineMs, 30 * MIN)
            assert.equal(a.lockStaleMs, 70 * MIN, 'max(65＋5, 30＋6＋5)')
            assert.equal(a.limitMin, 65)
            const b = rr({ scheduleLimitMin: 65, deadlineMs: 120 * MIN })
            assert.equal(b.lockStaleMs, 131 * MIN, 'max(65＋5, 120＋6＋5)')
        })

        it('上限小於 16 分時預算下限 10 分;非整數上限之鎖陳舊仍為整數(取鎖只認正整數)', () => {
            assert.equal(rr({ scheduleLimitMin: 12 }).deadlineMs, 10 * MIN)
            const r = rr({ scheduleLimitMin: 1 / 3 })
            assert.ok(Number.isInteger(r.lockStaleMs), `lockStaleMs=${r.lockStaleMs}`)
            assert.ok(Number.isInteger(r.deadlineMs))
        })

        it('deadlineMs／lockStaleMs 無效:視同未給並指名警告,改用推導值', () => {
            const r = rr({ scheduleLimitMin: 65, deadlineMs: -1, lockStaleMs: 'abc' })
            assert.equal(r.deadlineMs, 59 * MIN)
            assert.equal(r.lockStaleMs, 70 * MIN)
            assert.match(r.warnings[0], /^cfg\.deadlineMs 無效（收到 -1；須為大於 0 之毫秒數），視同未給$/)
            assert.match(r.warnings[1], /^cfg\.lockStaleMs 無效（收到 "abc"；/)
        })

        it('明給 lockStaleMs 小於預算＋安全邊際即警告(偏慢之一輪會被接管);不上鎖時不警告;數字字串取整數', () => {
            const r = rr({ scheduleLimitMin: 65, lockStaleMs: 30 * MIN })
            assert.equal(r.lockStaleMs, 30 * MIN)
            assert.match(r.warnings[0], /^cfg\.lockStaleMs（30\.0 分）小於整輪時間預算加安全邊際（65\.0 分）/)
            assert.deepEqual(rr({ scheduleLimitMin: 65, lockStaleMs: 30 * MIN, lock: false }).warnings, [])
            assert.deepEqual(rr({ scheduleLimitMin: 65, lockStaleMs: 65 * MIN }).warnings, [], '恰等於不警告')
            assert.equal(rr({ scheduleLimitMin: 65, lockStaleMs: '4200000.4' }).lockStaleMs, 4200001)
        })

        // ── 路徑與值域 ──
        it('cfg.lock:false → null;未給／null／true／空字串 → 預設 <dirs.tmp>/run.lock;字串 → 原樣;其餘型別建構期拋錯', () => {
            assert.equal(rr({ lock: false }).lockFile, null)
            for (const v of [undefined, null, true, '']) assert.equal(rr({ lock: v }).lockFile, 'c:/kb/tmp/run.lock', `值 ${String(v)}`)
            assert.equal(rr({ lock: 'x/my.lock' }).lockFile, 'x/my.lock')
            for (const bad of [1, {}, [], () => 1]) assert.throws(() => rr({ lock: bad }), /^Error: cfg\.lock 須為 false（不上鎖）、true 或未給/)
        })

        it('envFile:未給 → workDir/.env;相對者以 workDir 為基準;絕對者原樣;給了非字串拋錯', () => {
            assert.equal(rr({}).envFile, 'c:/kb/.env')
            assert.equal(rr({ envFile: 'sec/.env' }).envFile, 'c:/kb/sec/.env')
            const abs = path.resolve('abs/.env')
            assert.equal(rr({ envFile: abs }).envFile, abs)
            for (const v of [false, '']) assert.equal(rr({ envFile: v }).envFile, 'c:/kb/.env', '假值同未給')
            assert.throws(() => rr({ envFile: 123 }), /cfg\.envFile 須為路徑字串/)
        })

        it('aiWorkspace:未給 → workDir/tmp/ai-workspace;給了取之;注入 aiAdapter 時為 null(不使用);給了非字串拋錯', () => {
            assert.equal(rr({}).aiWorkspace, 'c:/kb/tmp/ai-workspace')
            assert.equal(rr({ aiWorkspace: 'w/ai' }).aiWorkspace, 'w/ai')
            assert.equal(rr({ aiAdapter: {}, aiWorkspace: 'w/ai' }).aiWorkspace, null)
            assert.throws(() => rr({ aiWorkspace: {} }), /cfg\.aiWorkspace 須為路徑字串/)
        })

        it('cfg 非物件視為 {};ctx 缺 workDir／dirs 拋錯', () => {
            assert.equal(resolveRuntime(null, CTX).deadlineMs, 50 * MIN)
            assert.throws(() => resolveRuntime({}, {}), /resolveRuntime 需要 \{ workDir, dirs \}/)
            assert.throws(() => resolveRuntime({}), /resolveRuntime 需要/)
        })

        it('positiveNumber:有限且大於 0 者取值(數字字串轉數、去頭尾空白);其餘一律 null', () => {
            assert.equal(positiveNumber('60'), 60)
            assert.equal(positiveNumber(' 5 '), 5)
            assert.equal(positiveNumber(0.5), 0.5)
            for (const bad of [0, -1, 'abc', '', '  ', NaN, Infinity, true, null, undefined, [], {}]) assert.equal(positiveNumber(bad), null, `值 ${String(bad)}`)
        })

        it('limitMinOfDeadline:預算＋安全邊際(6 分)無條件進位;非有限正數回 null', () => {
            assert.equal(limitMinOfDeadline(59 * MIN), 65)
            assert.equal(limitMinOfDeadline(50 * MIN), 56)
            assert.equal(limitMinOfDeadline(59 * MIN + 1), 66)
            for (const bad of [0, -1, NaN, Infinity, '3000000', null]) assert.equal(limitMinOfDeadline(bad), null, `值 ${String(bad)}`)
        })
    })

    // ══════════════════════════ dirs ══════════════════════════
    describe('dirs(workDir → 各輸出目錄之展開)', function() {

        it('normalizeWorkDir 非有效字串 → 拋 Error(訊息:normalizeWorkDir 需要 workDir)', () => {
            assert.throws(() => normalizeWorkDir(undefined), /normalizeWorkDir 需要 workDir/)
            assert.throws(() => normalizeWorkDir(null), /normalizeWorkDir 需要 workDir/)
            assert.throws(() => normalizeWorkDir(''), /normalizeWorkDir 需要 workDir/)
            assert.throws(() => normalizeWorkDir(123), /normalizeWorkDir 需要 workDir/)
        })

        it('normalizeWorkDir 有效字串 → 反斜線轉正斜線、去尾斜線', () => {
            assert.equal(normalizeWorkDir('C:\\kb\\'), 'C:/kb')
            assert.equal(normalizeWorkDir('c:/kb'), 'c:/kb')
        })

        it('expandDirs overrides 非物件 → 視為{}(回退全預設目錄,不拋錯);目錄鍵只有 db／log／tmp／state／knowledge', () => {
            const d = expandDirs('c:/kb', 'bogus')
            assert.deepEqual(d, { db: 'c:/kb/db', log: 'c:/kb/log', tmp: 'c:/kb/tmp', state: 'c:/kb/state', knowledge: 'c:/kb/knowledge' })
        })

        it('expandDirs overrides 為有效物件 → 逐鍵覆寫、其餘鍵照預設;覆寫物件之其餘鍵原樣帶入', () => {
            const d = expandDirs('c:/kb', { db: 'c:/other/db', extra: 'x' })
            assert.equal(d.db, 'c:/other/db')
            assert.equal(d.log, 'c:/kb/log')
            assert.equal(d.extra, 'x')
        })

        it('expandDirs 之 workDir 先正規化(反斜線、尾斜線)再展開', () => {
            assert.equal(expandDirs('C:\\kb\\').knowledge, 'C:/kb/knowledge')
            assert.throws(() => expandDirs(''), /normalizeWorkDir 需要 workDir/)
        })
    })

    // ══════════════════════════ util/patterns ══════════════════════════
    describe('util/patterns', function() {

        it('toPatterns:接受 RegExp 與 JSON 可寫之 { p, f };非陣列視為[];形狀或語法錯誤拋錯並指名設定名與索引', () => {
            const re = /abc/i
            const out = toPatterns([re, { p: 'abc', f: 'i' }, { p: 'x' }], 'cfg')
            assert.equal(out[0], re, 'RegExp 原樣')
            assert.ok(out[1].test('ABC'))
            assert.ok(out[2] instanceof RegExp && out[2].flags === '')
            assert.deepEqual(toPatterns(undefined, 'cfg'), [])
            assert.deepEqual(toPatterns('abc', 'cfg'), [])
            assert.throws(() => toPatterns(['abc'], 'cfg'), /cfg\[0\] 須為 RegExp 或 \{ p: 樣式字串, f\?: 旗標 \}，收到："abc"/)
            assert.throws(() => toPatterns([{ p: '' }], 'cfg'), /cfg\[0\] 須為 RegExp 或/, '空樣式字串不合法(會匹配一切)')
            assert.throws(() => toPatterns([{ p: 'ok' }, { p: '(' }], 'cfg'), /cfg\[1\] 樣式不合法/)
            assert.throws(() => toPatterns([{ p: 'a', f: 5 }], 'cfg'), /cfg\[0\] 須為 RegExp 或/)
        })
    })

    // ══════════════════════════ util/values、util/cli、util/table ══════════════════════════
    describe('util/values、util/cli、util/table(值之小工具、命令列之直接執行判定與表格跳脫;各模組同一份)', function() {

        it('given:undefined／null 為未給,其餘(含 0、false、空字串)為給了;strOf:null／undefined 為空字串,其餘 String', () => {
            assert.deepEqual([undefined, null, 0, false, '', {}].map(given), [false, false, true, true, true, true])
            assert.deepEqual([null, undefined, 0, false, 'a', 12.5].map(strOf), ['', '', '0', 'false', 'a', '12.5'])
        })

        it('textValueOf:字串去頭尾空白、數字轉字串,其餘(null、undefined、布林、物件、陣列)為空字串——物件不被轉成「[object Object]」', () => {
            assert.deepEqual([' 甲 ', '', 3, 0, -1.5, null, undefined, true, { a: 1 }, ['x']].map((v) => textValueOf(v)), ['甲', '', '3', '0', '-1.5', '', '', '', '', ''])
        })

        it('strictTextOf:只收字串(去頭尾空白);數字、null、undefined、布林、物件、陣列皆為空字串(與 textValueOf 之差只在數字)', () => {
            // 規則:values.strictTextOf——資料欄位之「取其字串」,數字不視為文字
            assert.deepEqual([' 甲 ', '', 3, 0, null, undefined, true, { a: 1 }, ['x']].map((v) => strictTextOf(v)), ['甲', '', '', '', '', '', '', '', ''])
            assert.equal(strictTextOf(3), '', '數字不是文字')
            assert.equal(textValueOf(3), '3', '對照:textValueOf 收數字')
        })

        it('textListOf:陣列逐項取 textValueOf 去空(保序、不去重);非陣列取單值之 textValueOf,空即 [];物件、null、布林不成文字', () => {
            // 規則:values.textListOf——「取其文字清單」(模型常把單值寫成字串);逐項判準即 textValueOf
            assert.deepEqual(textListOf([' 甲 ', 3, 0, null, '', '  ', true, { a: 1 }, ['x'], '甲']), ['甲', '3', '0', '甲'])
            assert.deepEqual([textListOf(' 乙 '), textListOf(5), textListOf(''), textListOf(null), textListOf(undefined), textListOf({ a: 1 }), textListOf([])], [['乙'], ['5'], [], [], [], [], []])
        })

        it('uniq:去重保留首次出現之序(Set 之同值判定:1 與 \'1\' 不同、NaN 視為同一);回傳新陣列', () => {
            // 規則:values.uniq
            const a = ['b', 'a', 'b', 1, '1', 1, NaN, NaN]
            const u = uniq(a)
            assert.deepEqual(u, ['b', 'a', 1, '1', NaN])
            assert.notEqual(u, a, '新陣列')
            assert.deepEqual(uniq(new Set(['x', 'y'])), ['x', 'y'], '可迭代者皆可')
        })

        it('jsonClone:JSON 深複本(不共用參照;undefined 之鍵略過、Date 成字串);undefined 本身拋(非 JSON 文字)', () => {
            // 規則:values.jsonClone——JSON.parse(JSON.stringify(v))
            const a = { x: [1, { y: 2 }], u: undefined, d: new Date(Date.UTC(2026, 0, 2)) }
            const b = jsonClone(a)
            b.x[1].y = 3
            assert.deepEqual([a.x[1].y, b.x[1].y], [2, 3], '不共用參照')
            assert.deepEqual(Object.keys(b), ['x', 'd'], 'undefined 之鍵略過')
            assert.equal(b.d, '2026-01-02T00:00:00.000Z', 'Date 成字串')
            assert.deepEqual([jsonClone(null), jsonClone('s'), jsonClone(5)], [null, 's', 5])
            assert.throws(() => jsonClone(undefined), SyntaxError)
        })

        it('cmp:碼元序比較(-1／0／1;不用 localeCompare,跨機器一致):大寫在小寫前、數字依值、相等為 0;各套件之排序同一份', () => {
            // 規則:values.cmp——輸出須在各機器一致(localeCompare 隨地區與 ICU 版本而異)
            assert.deepEqual(['b', 'a', 'B', 'ä'].sort(cmp), ['B', 'a', 'b', 'ä'])
            assert.deepEqual([3, 10, 2].sort(cmp), [2, 3, 10])
            assert.deepEqual([cmp('a', 'a'), cmp('a', 'b'), cmp('b', 'a'), cmp(1, 1)], [0, -1, 1, 0])
        })

        it('unknownKeysProblem／checkKeys:不認得之鍵(含值為 undefined 者)之訊息只一種格式「<名> 含不認得之鍵：<鍵>（可用：<可用鍵>）」;名未給或空字串者不帶主詞;非物件不檢;checkKeys 拋同一訊息', () => {
            assert.equal(unknownKeysProblem({ a: 1, b: undefined, c: 2 }, ['a'], 'cfg.x'), 'cfg.x 含不認得之鍵：b、c（可用：a）')
            assert.equal(unknownKeysProblem({ b: 1 }, ['a', 'c']), '含不認得之鍵：b（可用：a、c）')
            assert.equal(unknownKeysProblem({ b: 1 }, ['a'], ''), '含不認得之鍵：b（可用：a）')
            assert.equal(unknownKeysProblem({ a: 1 }, ['a'], 'cfg'), '')
            for (const v of [null, undefined, 5, 'x', ['a']]) assert.equal(unknownKeysProblem(v, ['a'], 'cfg'), '', JSON.stringify(v))
            assert.equal(unknownKeysProblem({ a: 1 }, 'bad', 'cfg'), 'cfg 含不認得之鍵：a（可用：）', '可用鍵非陣列視為空')
            assert.throws(() => checkKeys({ db: 'x', dbb: 'y' }, ['db', 'log'], 'cfg.dirs'), (e) => e.message === 'cfg.dirs 含不認得之鍵：dbb（可用：db、log）')
            assert.doesNotThrow(() => checkKeys({ db: 'x' }, ['db'], 'cfg.dirs'))
        })

        it('isDirectRun(util/cli):process.argv[1] 與 metaUrl 同一實際檔才為 true(經符號連結／junction 執行亦認得;Windows 不分大小寫;檔不存在者以路徑比);被載入之模組(argv[1] 為他檔)、metaUrl 非字串或非 file URL、argv[1] 缺 → false', () => {
            const self = process.argv[1]
            assert.equal(isDirectRun(pathToFileURL(self).href), true)
            assert.equal(isDirectRun(import.meta.url), false, '本測試檔由測試執行器載入,非直接執行')
            if (process.platform === 'win32') assert.equal(isDirectRun(pathToFileURL(self.toUpperCase()).href), true, 'Windows 路徑不分大小寫')
            for (const v of [undefined, null, 5, {}, 'not a url', 'https://example.com/x.mjs']) assert.equal(isDirectRun(v), false, String(v))
            // 經目錄連結執行:argv[1] 為連結下之路徑,import.meta.url 為實際路徑(junction 於 Windows 不需管理員權限;他平台為一般符號連結)
            const realDir = path.join(TMP, 'cli-real')
            const linkDir = path.join(TMP, 'cli-link')
            fs.mkdirSync(realDir, { recursive: true })
            fs.writeFileSync(path.join(realDir, 'x.mjs'), '')
            fs.symlinkSync(realDir, linkDir, 'junction')
            const realUrl = pathToFileURL(path.join(realDir, 'x.mjs')).href
            try {
                process.argv[1] = path.join(linkDir, 'x.mjs')
                assert.equal(isDirectRun(realUrl), true, '經連結執行亦認得')
                process.argv[1] = path.join(realDir, 'y.mjs')
                assert.equal(isDirectRun(realUrl), false, '同目錄之他檔')
                assert.equal(isDirectRun(pathToFileURL(path.join(realDir, 'y.mjs')).href), true, '檔不存在者以路徑比')
                process.argv[1] = ''
                assert.equal(isDirectRun(pathToFileURL(self).href), false, 'argv[1] 缺即 false')
            }
            finally {
                process.argv[1] = self
            }
        })

        it('csvCell:含逗號、雙引號、換行(含單獨之 \\r)者加雙引號、內含雙引號加倍,其餘原樣;toCsv:BOM 開頭、CRLF 分列與結尾,非陣列之列視為空列', () => {
            assert.deepEqual(['a', 'a,b', 'a"b', 'a\nb', 'a\rb', null, 3].map(csvCell), ['a', '"a,b"', '"a""b"', '"a\nb"', '"a\rb"', '', '3'])
            assert.equal(toCsv(['x', 'y'], [[1, 'p,q'], [null, 'z']]), '﻿x,y\r\n1,"p,q"\r\n,z\r\n')
            assert.equal(toCsv(['x'], 'bad'), '﻿x\r\n')
            assert.equal(toCsv(['x'], [5, ['a']]), '﻿x\r\n\r\na\r\n')
        })

        it('contentSha1(內容雜湊):SHA-1 十六進位、空字串亦雜湊;與身分雜湊 sha1 之差別只在空輸入(sha1 回空字串)', () => {
            assert.equal(contentSha1(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709')
            assert.equal(contentSha1(null), contentSha1(''))
            assert.equal(sha1(''), '', '身分雜湊之空輸入回空字串(無鍵項目不共用 key)')
            for (const s of ['hello', '正文\u0000摘要', 'x'.repeat(10_000)]) assert.equal(contentSha1(s), sha1(s), s.slice(0, 10))
        })

        it('mdCell:換行(\\r\\n、\\r、\\n)壓成空白;「|」前之反斜線連續段加倍再加一個(「|」前恆為奇數個反斜線:表格不被打壞、原文之反斜線照樣顯示);其餘反斜線不動;null 為空字串', () => {
            assert.equal(mdCell('a|b'), 'a\\|b')
            assert.equal(mdCell('a\r\nb\rc\nd'), 'a b c d')
            assert.equal(mdCell('a\\|b'), 'a\\\\\\|b', '一個反斜線 → 三個')
            assert.equal(mdCell('a\\\\|b'), 'a\\\\\\\\\\|b', '兩個反斜線 → 五個(加倍後仍為偶數即成欄界)')
            assert.equal(mdCell('C:\\path'), 'C:\\path', '不在「|」前之反斜線不動')
            // 「|」前之反斜線數恆為奇數
            for (const s of ['|', '\\|', '\\\\|', '\\\\\\|', 'x\\\\\\\\|y']) {
                const runs = [...mdCell(s).matchAll(/(\\*)\|/g)].map((m) => m[1].length)
                assert.ok(runs.length && runs.every((n) => n % 2 === 1), `${JSON.stringify(s)}:${runs}`)
            }
            assert.equal(mdCell(null), '')
        })
    })

    // ══════════════════════════ util/records ══════════════════════════
    describe('util/records', function() {

        it('sourceId：kind／url 維持容錯(非字串亦不拋錯)；有效輸入可重現;追蹤參數不影響', () => {
            const a = sourceId('rss', 'https://e.com/feed?utm_source=x')
            assert.equal(a, sourceId('rss', 'https://e.com/feed?utm_source=x'))
            assert.equal(a, sourceId('rss', 'https://e.com/feed'), '去追蹤參數後同一把鍵')
            assert.equal(a.length, 40)
            assert.doesNotThrow(() => sourceId(undefined, undefined))
            assert.doesNotThrow(() => sourceId(123, {}))
        })

        it('docRecord：fields／src 非物件拋錯；opt 非物件視為{}；有效輸入形狀不變', () => {
            assert.throws(() => docRecord(null, { id: 's' }), /docRecord 需要 fields 與 src 物件/)
            assert.throws(() => docRecord({ url: 'x' }, null), /docRecord 需要 fields 與 src 物件/)
            assert.throws(() => docRecord('bad', 'bad'), /docRecord 需要 fields 與 src 物件/)
            const r = docRecord({ url: 'https://e.com/a', title: 'T' }, { id: 's1', name: 'S' }, 'bad-opt')
            assert.equal(r.collectedAt, '', 'opt 非物件視為{}，nowIso 回退空字串')
            const r2 = docRecord({ url: 'https://e.com/a', title: 'T' }, { id: 's1', name: 'S' }, { nowIso: '2026-09-23T00:00:00+08:00' })
            assert.deepEqual([r2.url, r2.title, r2.sourceId, r2.status, r2.collectedAt], ['https://e.com/a', 'T', 's1', 'new', '2026-09-23T00:00:00+08:00'])
            assert.deepEqual([r2.sourceTier, r2.fetchTries, r2.textLength], [2, 0, 0], 'tier 缺省 2、計數欄初值 0')
        })

        it('docRecord:feed 內文依 maxTextChars 截斷並記截斷前原長(feedFullLength,只在被截時記);項目宣告之 kind／fetcher 非空才寫入', () => {
            const long = 'x'.repeat(50)
            const cut = docRecord({ url: 'u', feedText: long }, { id: 's', name: 'S' }, { maxTextChars: 20 })
            assert.deepEqual([cut.feedText.length, cut.feedFullLength], [20, 50])
            const whole = docRecord({ url: 'u', feedText: long }, { id: 's', name: 'S' }, { maxTextChars: 100 })
            assert.deepEqual([whole.feedText.length, 'feedFullLength' in whole], [50, false])
            const routed = docRecord({ url: 'u', kind: 'k', fetcher: 'browser' }, { id: 's', name: 'S' })
            assert.deepEqual([routed.kind, routed.fetcher], ['k', 'browser'])
            const plain = docRecord({ url: 'u' }, { id: 's', name: 'S' })
            assert.deepEqual(['kind' in plain, 'fetcher' in plain], [false, false])
        })

        it('externalDocOf(管線外登記之文件):id 由總組裝之去重身分算(與 seen.idOf 同值;安裝方自訂 cfg.dedup 亦然,不自算 sha1)、url 為正準網址、形狀同 docRecord;網址不合回 null;缺身分拋錯', () => {
            const U = 'https://www.bing.com/news/apiclick.aspx?ref=x&url=https%3A%2F%2Fe.com%2Fa%3Futm_source%3Dz'
            for (const dedup of [DEFAULT_DEDUP, { keyOf: 'asis' }, { keyOf: (k) => `K:${k}` }]) {
                const identity = W.createIdentity(dedup)
                const seen = W.createSeenStore({ collection: { select: async () => [], get: async () => null }, identity, log: { info() {}, warn() {}, error() {} } })
                const rec = externalDocOf(identity, { url: U, title: 'T', publishedAt: '2026-10-01' }, { name: '手動抓取', tier: 1 }, { nowIso: '2026-10-06T00:00:00+08:00' })
                assert.equal(rec.id, seen.idOf(U), `dedup ${JSON.stringify(String(dedup.keyOf))}:與管線同一身分`)
                assert.deepEqual([rec.url, rec.title, rec.sourceName, rec.sourceTier, rec.status, rec.collectedAt], ['https://e.com/a', 'T', '手動抓取', 1, 'new', '2026-10-06T00:00:00+08:00'])
            }
            assert.match(externalDocOf(W.createIdentity(DEFAULT_DEDUP), { url: 'https://e.com/a' }).id, /^[0-9a-f]{40}$/)
            assert.equal(externalDocOf(W.createIdentity(DEFAULT_DEDUP), { url: 'ftp://e.com/a' }), null)
            assert.equal(externalDocOf(W.createIdentity(DEFAULT_DEDUP), {}), null)
            assert.throws(() => externalDocOf(null, { url: 'https://e.com/a' }), /externalDocOf 需要 identity/)
        })

        it('來源之來歷:autoSourceOrigin(寫入之唯一格式)與 sourceOriginOf(唯一解讀)互逆;預設之自動來源判定 capture.sources.isAutoSource 取同一解讀', () => {
            for (const [type, value] of [['keyword', 'momentum factor'], ['site', 'https://e.com/a:b'], ['topic', '波動率']]) {
                assert.deepEqual(sourceOriginOf({ origin: autoSourceOrigin(type, value) }), { auto: true, via: type })
            }
            assert.equal(autoSourceOrigin('site', 'https://e.com'), 'frontier:site:https://e.com')
            assert.deepEqual([sourceOriginOf({ origin: 'seed' }), sourceOriginOf({}), sourceOriginOf(null)], [{ auto: false, via: 'seed' }, { auto: false, via: '' }, { auto: false, via: '' }])
            const { isAutoSource } = resolveSettings({}).capture.sources
            assert.deepEqual([isAutoSource({ origin: autoSourceOrigin('keyword', 'x') }), isAutoSource({ origin: 'seed' })], [true, false])
        })

        it('defaultToRecord／defaultToLinkedRecord：工廠回傳函數，形狀正確(grid 來源另補 raw 相關欄位)', () => {
            const clock = genClockTZ('Asia/Taipei')
            const toRecord = defaultToRecord({ settings: resolveSettings({ capture: { articles: { maxTextChars: 100 } } }), clock })
            const rec = toRecord({ url: 'https://e.com/a', title: 'T', text: 'x'.repeat(10) }, { source: { id: 's1', name: 'S', kind: 'rss' } })
            assert.equal(rec.sourceId, 's1')
            assert.equal(rec.status, 'new')
            // feed 內文截斷上限取自 settings.capture.articles.maxTextChars
            const cut = defaultToRecord({ settings: resolveSettings({ capture: { articles: { maxTextChars: 5 } } }), clock })({ url: 'https://e.com/c', title: 'T', text: 'x'.repeat(10) }, { source: { id: 's1', name: 'S', kind: 'rss' } })
            assert.deepEqual([cut.feedText.length, cut.feedFullLength], [5, 10])
            const recGrid = toRecord({ url: 'https://e.com/g', title: 'G', summary: 'abstract' }, { source: { id: 's2', name: 'S2', kind: 'grid' } })
            assert.equal(recGrid.status, 'raw')
            assert.equal(recGrid.textFrom, 'abstract')
            const toLinked = defaultToLinkedRecord({ clock })
            const linked = toLinked({ url: 'https://e.com/b', text: 'L' }, { sourceId: 's1', sourceName: 'S', id: 'mother1', publishedAt: '2026-01-01' })
            assert.equal(linked.sourceId, 's1:linked', '轉錄件之 sourceId 不沿用母來源(否則真文章下輪又被拆成連結)')
            assert.equal(linked.fromDocId, 'mother1')
        })
    })

    // ══════════════════════════ util/web ══════════════════════════
    describe('util/web', function() {

        it('normalizeUrl：去 hash／追蹤參數／尾斜線；非字串 fail-safe 轉字串回傳,不拋錯', () => {
            assert.equal(normalizeUrl('https://a.com/x/?utm_source=y&b=2#frag'), 'https://a.com/x/?b=2')
            assert.doesNotThrow(() => normalizeUrl(undefined))
            assert.equal(normalizeUrl(undefined), '')
        })

        it('unwrapNewsUrl：解開 Bing News apiclick 轉址；非字串 fail-safe 轉字串回傳,不拋錯', () => {
            assert.equal(unwrapNewsUrl('https://www.bing.com/news/apiclick.aspx?ref=x&url=https%3A%2F%2Fe.com%2Fa'), 'https://e.com/a')
            assert.doesNotThrow(() => unwrapNewsUrl(undefined))
            assert.equal(unwrapNewsUrl(undefined), '')
        })
    })

    // ══════════════════════════ standards/verdict ══════════════════════════
    describe('standards/verdict(檢定標準之判定結果形狀)', function() {

        it('STATUS 為凍結之五態(pass／violation／undetermined／na／waived);result 組一筆 { std, status, detail, field }(缺者以空字串填)', () => {
            assert.deepEqual(STATUS, { PASS: 'pass', VIOLATION: 'violation', UNDETERMINED: 'undetermined', NA: 'na', WAIVED: 'waived' })
            assert.ok(Object.isFrozen(STATUS))
            assert.deepEqual(result('CS1a', STATUS.VIOLATION, '過短', 'text'), { std: 'CS1a', status: 'violation', detail: '過短', field: 'text' })
            assert.deepEqual(result('CS2', STATUS.PASS), { std: 'CS2', status: 'pass', detail: '', field: '' })
            assert.deepEqual(result('CS2', STATUS.NA, null, undefined), { std: 'CS2', status: 'na', detail: '', field: '' })
        })
    })

    // ══════════════════════════ vocab ══════════════════════════
    describe('vocab(詞彙表)', function() {

        it('內建預設詞彙領域中立:只有 domain／kbLabel／conceptRenames／conceptAliases 四鍵,主題範圍與稱呼皆空、別名表皆空', () => {
            assert.deepEqual(Object.keys(VOCAB_DEFAULT).sort(), ['conceptAliases', 'conceptRenames', 'domain', 'kbLabel'])
            assert.equal(VOCAB_DEFAULT.domain, '')
            assert.equal(VOCAB_DEFAULT.kbLabel, '')
            assert.deepEqual([VOCAB_DEFAULT.conceptRenames, VOCAB_DEFAULT.conceptAliases], [{}, {}])
        })

        it('resolveVocab:給定之鍵整鍵替換、未給者沿用預設;非物件(含 null、字串)視為未覆寫;可重複套用', () => {
            const v = resolveVocab({ domain: 'X', conceptAliases: { '算法': '演算法' } })
            assert.deepEqual([v.domain, v.kbLabel, v.conceptRenames, v.conceptAliases], ['X', '', {}, { '算法': '演算法' }])
            assert.deepEqual(resolveVocab('bad'), resolveVocab({}))
            assert.deepEqual(resolveVocab(null), resolveVocab({}))
            assert.deepEqual(resolveVocab(undefined), resolveVocab({}))
            const x = { domain: '機器學習', kbLabel: 'ML知識庫', conceptRenames: { '甲(1)': '甲' }, guide: {} }
            const once = resolveVocab(x)
            assert.deepEqual(resolveVocab(once), once, 'resolveVocab(resolveVocab(x)) 與 resolveVocab(x) 相同')
            assert.deepEqual(resolveVocab(resolveVocab({})), resolveVocab({}))
        })

        it('resolveVocab:不認得之鍵拋錯並列出可用鍵(打錯之鍵若靜默接受,正名鍵會維持預設而無人察覺)', () => {
            assert.throws(() => resolveVocab({ kbLable: 'x' }), /vocab 含不認得之鍵：kbLable（可用：domain、kbLabel、conceptRenames、conceptAliases、guide）/)
            assert.throws(() => resolveVocab({ categories: ['a'], domain: 'X' }), /vocab 含不認得之鍵：categories/)
        })

        it('resolveVocab:kbLabel 非字串、guide 非物件拋錯;主題範圍、稱呼與 guide 之 null 視為未給(取預設);值為 undefined 之鍵視為未給;guide 給了物件原樣保留(本套件之領域發現不讀取,只驗為物件)', () => {
            assert.throws(() => resolveVocab({ kbLabel: 5 }), /vocab\.kbLabel 須為字串/)
            assert.throws(() => resolveVocab({ guide: 'x' }), /vocab\.guide 須為物件/)
            assert.throws(() => resolveVocab({ guide: [] }), /vocab\.guide 須為物件/)
            assert.deepEqual([resolveVocab({ kbLabel: null }).kbLabel, resolveVocab({ domain: null }).domain], ['', ''], 'null 視為未給(取預設之空字串;稱呼由 kbLabelOf 推導)')
            assert.equal(kbLabelOf(resolveVocab({ kbLabel: null, domain: '天文學' })), '「天文學」知識庫')
            assert.deepEqual(resolveVocab({ guide: null }), resolveVocab({}), 'guide 之 null 視為未給')
            assert.deepEqual(resolveVocab({ domain: undefined, kbLabel: undefined, guide: undefined }), resolveVocab({}), '認得之鍵之值為 undefined 者視為未給')
            assert.throws(() => resolveVocab({ kbLable: undefined }), /vocab 含不認得之鍵：kbLable/, '不認得之鍵:值為 undefined 者亦檢(打錯之鍵名不因當下無值而放過)')
            assert.deepEqual(resolveVocab({ guide: { a: { b: 1 } } }).guide, { a: { b: 1 } })
        })

        it('resolveVocab:conceptRenames／conceptAliases 須為 { 原寫法: 新寫法 } 字串對照(形狀錯誤於建構期拋錯);null 視為空對照', () => {
            assert.throws(() => resolveVocab({ conceptRenames: 'x' }), /vocab\.conceptRenames 須為物件/)
            assert.throws(() => resolveVocab({ conceptAliases: ['a'] }), /vocab\.conceptAliases 須為物件/)
            assert.throws(() => resolveVocab({ conceptAliases: { '甲': '' } }), /vocab\.conceptAliases 之「甲」須對應非空字串/)
            assert.deepEqual(resolveVocab({ conceptAliases: null }).conceptAliases, {})
            assert.deepEqual(resolveVocab({ conceptRenames: null }).conceptRenames, {})
        })

        it('kbLabelOf:kbLabel 明給者優先;空字串與未給由 domain 推導;皆空為「知識庫」', () => {
            assert.equal(kbLabelOf({ domain: '機器學習', kbLabel: 'ML知識庫' }), 'ML知識庫')
            assert.equal(kbLabelOf({ domain: '機器學習', kbLabel: '' }), '「機器學習」知識庫')
            assert.equal(kbLabelOf({ domain: '', kbLabel: '  ' }), '知識庫')
            assert.equal(kbLabelOf({ domain: '' }), '知識庫')
            assert.equal(kbLabelOf({ domain: ' 機器學習 ' }), '「機器學習」知識庫')
            assert.equal(kbLabelOf(null), '知識庫')
            assert.equal(kbLabelOf(VOCAB_DEFAULT), '知識庫', '預設詞彙即領域中立之「知識庫」')
        })

        it('pickCaptureVocab:自任意詞彙表只取本套件所讀之鍵(鍵集即 VOCAB_DEFAULT 之鍵;他套件之鍵與本套件不讀之 guide 不取),結果必被 resolveVocab 接受', () => {
            const shared = { domain: '機器學習', kbLabel: 'ML 知識庫', conceptRenames: { a: 'b' }, conceptAliases: {}, guide: { x: 1 }, categories: ['其他'], claimTypes: ['實證'] }
            const v = pickCaptureVocab(shared)
            assert.deepEqual(Object.keys(v).sort(), Object.keys(VOCAB_DEFAULT).sort(), '鍵集取自 VOCAB_DEFAULT(本套件新增詞彙鍵時呼叫端自動帶上)')
            assert.deepEqual(v, { domain: '機器學習', kbLabel: 'ML 知識庫', conceptRenames: { a: 'b' }, conceptAliases: {} })
            assert.doesNotThrow(() => resolveVocab(v))
            assert.throws(() => resolveVocab(shared), /vocab 含不認得之鍵：categories/, '前提:原表直接交本套件會被拒')
            assert.deepEqual(pickCaptureVocab({ domain: 'X', categories: [] }), { domain: 'X' }, '未給者不列(由 resolveVocab 補預設)')
            for (const bad of [null, undefined, 'x', 5, []]) assert.deepEqual(pickCaptureVocab(bad), {})
        })
    })

    // ══════════════════════════ vocab/vocabKit(詞彙表解析之共用件;各工作與編排層同一份)══════════════════════════
    describe('vocab/vocabKit(頭之政策、子集、guide 之合併、改名鏈)', function() {

        it('vocabHeadOf:非物件視為 {};不認得之鍵為 checkKeys 之格式(值為 undefined／null 者亦檢);認得之鍵之值為 undefined 者剔除;null 依逐鍵宣告(unset 剔除、empty 依預設之型別換成 [] 或 {}、未宣告者照收);name 為訊息之稱呼', () => {
            for (const bad of [null, undefined, 'x', 5, []]) assert.deepEqual(vocabHeadOf(bad, ['a']), {})
            assert.deepEqual(vocabHeadOf({ a: 1, b: undefined }, ['a', 'b']), { a: 1 })
            const o = { nullAs: { a: 'unset', b: 'empty', c: 'empty' }, defaults: { b: [], c: {} } }
            assert.deepEqual(vocabHeadOf({ a: null, b: null, c: null, d: null }, ['a', 'b', 'c', 'd'], o), { b: [], c: {}, d: null })
            assert.equal(msgOf(() => vocabHeadOf({ a: 1, zz: 2, yy: null, xx: undefined }, ['a', 'b'])), 'vocab 含不認得之鍵：zz、yy、xx（可用：a、b）')
            assert.equal(msgOf(() => vocabHeadOf({ zz: 1 }, ['a'], { name: 'vocab.guide' })), 'vocab.guide 含不認得之鍵：zz（可用：a）')
            const src = { a: { x: 1 } }
            assert.notEqual(vocabHeadOf(src, ['a']), src, '回新物件(不改原物件)')
        })

        it('pickVocabKeys:只取所列之鍵(值為 undefined 者不列);給了 guideSections 時 guide 只留其段中已給者;非物件視為 {}', () => {
            assert.deepEqual(pickVocabKeys({ a: 1, b: undefined, c: 3 }, ['a', 'b']), { a: 1 })
            const v = { domain: 'X', guide: { relate: { r: 1 }, summarize: { s: 2 }, faith: undefined } }
            assert.deepEqual(pickVocabKeys(v, ['domain', 'guide'], { guideSections: ['summarize', 'faith'] }), { domain: 'X', guide: { summarize: { s: 2 } } })
            assert.deepEqual(pickVocabKeys(v, ['guide']), { guide: v.guide }, '未給 guideSections 即原樣')
            assert.deepEqual(pickVocabKeys({ guide: 'x' }, ['guide'], { guideSections: ['a'] }), { guide: 'x' }, 'guide 非物件原樣(形狀由解析判)')
            for (const bad of [null, undefined, 'x', 5, []]) assert.deepEqual(pickVocabKeys(bad, ['a']), {})
        })

        it('mergeGuideFields:逐欄回退預設(undefined／null 皆沿用);段與欄位之名值為 undefined 者亦檢;內建型別 string(空字串照填)／estr(非空)／array(非空字串陣列,複本);呼叫端型別收(值, 路徑, 預設值);不認得之段與欄位為 checkKeys 之格式', () => {
            const F = { s1: { a: 'string', b: 'estr', c: 'array' }, s2: { d: 'mine' } }
            const D = { s1: { a: 'A', b: 'B', c: ['C'] }, s2: { d: { x: 1 } } }
            const mine = (v, name, def) => {
                if (typeof v !== 'object') throw new Error(`${name} 須為物件`)
                return { ...def, ...v }
            }
            assert.deepEqual(mergeGuideFields(F, D, undefined, { types: { mine } }), D)
            assert.deepEqual(mergeGuideFields(F, D, null, { types: { mine } }), D)
            assert.deepEqual(mergeGuideFields(F, D, { s1: { a: '', b: null, c: undefined }, s2: null }, { types: { mine } }), { ...D, s1: { ...D.s1, a: '' } }, 'string 之空字串照填;null／undefined 之欄與 null 之段沿用預設')
            const arr = ['甲', '乙']
            const got = mergeGuideFields(F, D, { s1: { c: arr }, s2: { d: { y: 2 } } }, { types: { mine } })
            assert.deepEqual([got.s1.c, got.s2.d], [arr, { x: 1, y: 2 }])
            assert.notEqual(got.s1.c, arr, 'array 為複本')
            assert.equal(msgOf(() => mergeGuideFields(F, D, { zz: undefined })), 'vocab.guide 含不認得之鍵：zz（可用：s1、s2）', '值為 undefined 之段亦檢')
            assert.equal(msgOf(() => mergeGuideFields(F, D, { s1: { zz: undefined } })), 'vocab.guide.s1 含不認得之鍵：zz（可用：a、b、c）', '值為 undefined 之欄位亦檢')
            assert.equal(msgOf(() => mergeGuideFields(F, D, 'x')), 'vocab.guide 須為物件 { s1, s2 }')
            assert.equal(msgOf(() => mergeGuideFields(F, D, { zz: {}, s1: {} })), 'vocab.guide 含不認得之鍵：zz（可用：s1、s2）')
            assert.equal(msgOf(() => mergeGuideFields(F, D, { s1: 'x' })), 'vocab.guide.s1 須為物件')
            assert.equal(msgOf(() => mergeGuideFields(F, D, { s1: { zz: 1 } })), 'vocab.guide.s1 含不認得之鍵：zz（可用：a、b、c）')
            assert.equal(msgOf(() => mergeGuideFields(F, D, { s1: { a: 5 } })), 'vocab.guide.s1.a 須為字串')
            for (const bad of ['', '  ', 5]) assert.equal(msgOf(() => mergeGuideFields(F, D, { s1: { b: bad } })), 'vocab.guide.s1.b 須為非空字串')
            for (const bad of [[], ['甲', ''], 'x']) assert.equal(msgOf(() => mergeGuideFields(F, D, { s1: { c: bad } })), 'vocab.guide.s1.c 須為字串陣列(至少一項、每項非空字串)')
            assert.equal(msgOf(() => mergeGuideFields(F, D, { s2: { d: 'x' } }, { types: { mine } })), 'vocab.guide.s2.d 須為物件', '呼叫端之型別收設定路徑')
            assert.equal(msgOf(() => mergeGuideFields(F, D, { s2: { d: {} } })), 'mergeGuideFields 之欄位表引用未知之型別「mine」（vocab.guide.s2.d）')
            assert.equal(msgOf(() => mergeGuideFields(F, D, { zz: {} }, { name: 'x.guide' })), 'x.guide 含不認得之鍵：zz（可用：s1、s2）')
        })

        it('renameChainProblems:合格之對照(含連續改名之鏈)無問題;非物件、鍵值非非空字串、舊名仍在清單、新名不可達(或成環)→ 一次列全(同句去重)', () => {
            const L = ['丙', '丁']
            assert.deepEqual([renameChainProblems({}, L, 'n'), renameChainProblems({ 甲: '丙' }, L, 'n'), renameChainProblems({ 甲: '乙', 乙: '丙' }, L, 'n')], [[], [], []])
            for (const bad of [null, 'x', [], 5]) assert.deepEqual(renameChainProblems(bad, L, 'vocab.x'), ['vocab.x 須為物件 { 舊名: 新名 }'])
            assert.deepEqual(renameChainProblems({ 甲: '', 乙: 5 }, L, 'vocab.x'), ['vocab.x 之鍵與值須為非空字串'])
            assert.deepEqual(renameChainProblems({ 丙: '丁' }, L, 'vocab.x'), ['vocab.x 之「丙」仍在現行清單（改名之舊名須已自清單移除）'])
            assert.deepEqual(renameChainProblems({ 甲: '戊' }, L, 'vocab.x'), ['vocab.x.甲 之新名「戊」不在現行清單（丙、丁）'])
            assert.deepEqual(renameChainProblems({ A: 'B', B: 'A' }, L, 'vocab.x'), ['vocab.x.A 之新名「B」不在現行清單（丙、丁），且對照成環', 'vocab.x.B 之新名「A」不在現行清單（丙、丁），且對照成環'])
            assert.deepEqual(renameChainProblems({ 丙: '戊', 甲: '己' }, L, 'vocab.x'), [
                'vocab.x 之「丙」仍在現行清單（改名之舊名須已自清單移除）', 'vocab.x.丙 之新名「戊」不在現行清單（丙、丁）', 'vocab.x.甲 之新名「己」不在現行清單（丙、丁）',
            ], '一次列全')
        })
    })

    // ══════════════════════════ ops/runSummary ══════════════════════════
    describe('ops/runSummary', function() {

        it('buildRunSummary：p 非物件視為 {}(不拋錯，回傳空殼摘要)', () => {
            const s = buildRunSummary(undefined)
            assert.equal(s.name, '')
            assert.deepEqual(s.stages, [])
            const s2 = buildRunSummary(123)
            assert.deepEqual(s2.stages, [])
            assert.equal(s2.version, RUN_SUMMARY_VERSION)
        })

        it('writeRunSummary：p 非物件回 null；readRunSummary：file 非有效字串回 null', () => {
            assert.equal(writeRunSummary(undefined), null)
            assert.equal(writeRunSummary('not-obj'), null)
            assert.equal(readRunSummary(undefined), null)
            assert.equal(readRunSummary(123), null)
        })

        it('build→write→read 往返正常', () => {
            const summary = buildRunSummary({ report: { name: 'x', ms: 10, ok: true, stages: [] }, stamp: '20260923120000' })
            const file = writeRunSummary({ dir: `${TMP}/summary`, stamp: '20260923120000', summary })
            assert.ok(file && fs.existsSync(file))
            assert.ok(file.endsWith(`20260923${path.sep}20260923120000-run.json`) || file.endsWith('20260923/20260923120000-run.json'), `落於 <dir>/<day>/<stamp>-run.json:${file}`)
            const j = readRunSummary(file)
            assert.equal(j.version, RUN_SUMMARY_VERSION)
            assert.equal(j.name, 'x')
        })

        it('buildRunSummary:階段 report 映射(name／step／status／ms／ok／stats／summary,detail → sub);ai 之統計函數拋錯視為無資料而不拋;standards 經 sanitize 帶入', () => {
            const report = {
                name: '知識抓取',
                ms: 1000,
                ok: true,
                stages: [{
                    name: '抓取',
                    step: 1,
                    status: 'ok',
                    ms: 10,
                    result: { ok: true, stats: { in: 1 }, summary: 's', detail: { listFetch: { ok: true, stats: {}, detail: { newDocs: 3 }, summary: '' } } },
                }, {
                    name: '略過段',
                    step: 2,
                    status: 'skipped',
                    reason: '逾時間預算',
                    ms: 0,
                }],
            }
            const ai = {
                aiUsageToday: () => ({ byKey: { a: 1 } }),
                health: { snapshot: () => {
                    throw new Error('介面不同')
                } },
                drainStats: () => '無呼叫',
            }
            const s = buildRunSummary({ report, startedAt: 't0', endedAt: 't1', deadlineMs: 2940_000, ai, stamp: '20260923120000', standards: { at: 'x', f: () => 1 } })
            assert.deepEqual(s.stages[0], { name: '抓取', step: 1, status: 'ok', reason: '', ms: 10, ok: true, stats: { in: 1 }, summary: 's', sub: { listFetch: { ok: true, stats: {}, detail: { newDocs: 3 }, summary: '' } } })
            assert.deepEqual([s.stages[1].status, s.stages[1].reason, s.stages[1].sub], ['skipped', '逾時間預算', undefined])
            assert.deepEqual([s.name, s.stamp, s.startedAt, s.endedAt, s.ms, s.ok, s.deadlineMs], ['知識抓取', '20260923120000', 't0', 't1', 1000, true, 2940_000])
            assert.deepEqual([s.ai.usageToday, s.ai.health, s.ai.callStats], [{ a: 1 }, undefined, '無呼叫'], 'health 拋錯視為無資料')
            assert.deepEqual(s.standards, { at: 'x' }, 'standards 經 sanitize(函數剔除)')
            const bare = buildRunSummary({ report })
            assert.deepEqual([bare.deadlineMs, bare.ai, bare.standards, bare.stopped, bare.lockSkipped], [null, undefined, undefined, false, false])
            // 健康統計可得時原樣帶入(巡檢據此讀逐供應者之成敗;snapshot 以 false 呼叫)
            const asked = []
            const ai2 = { aiUsageToday: () => ({ byKey: {} }), health: { snapshot: (arg) => {
                asked.push(arg); return { counts: { p1: { ok: 1, truncated: 1 } } }
            } } }
            assert.deepEqual(buildRunSummary({ report, ai: ai2 }).ai.health, { counts: { p1: { ok: 1, truncated: 1 } } })
            assert.deepEqual(asked, [false])
        })

        it('sanitize 剔除函數、截長字串、限深度;write/read 往返;版本不符回 null', () => {
            const s = sanitize({ f: () => 1, s: 'x'.repeat(400), n: 1, deep: { a: { b: { c: { d: { e: { f: 1 } } } } } }, arr: [1, () => 2, 'a'] })
            assert.equal(s.f, undefined)
            assert.equal(s.s.length, 301)
            assert.equal(s.n, 1)
            assert.deepEqual(s.arr, [1, 'a'])
            assert.equal(s.deep.a.b.c.d, undefined, '深度限制(第 5 層起剔除)')
            assert.deepEqual(sanitize(new Error('x'.repeat(400))), { message: 'x'.repeat(300) }, 'Error 只留截斷之訊息')
            const stamp = '20260921129900'
            const file = writeRunSummary({ dir: `${TMP}/log`, stamp, summary: buildRunSummary({ report: { name: 'r', stages: [{ name: 'a' }, { name: 'b' }] }, stamp }) })
            assert.ok(file && fs.existsSync(file))
            const j = readRunSummary(file)
            assert.equal(j.stages.length, 2)
            fs.writeFileSync(file, JSON.stringify({ version: 999, stages: [] }), 'utf8')
            assert.equal(readRunSummary(file), null, '版本不符須退回正則路徑')
            fs.writeFileSync(file, '{壞', 'utf8')
            assert.equal(readRunSummary(file), null, '壞檔回 null')
            fs.writeFileSync(file, JSON.stringify({ version: RUN_SUMMARY_VERSION, stages: 'x' }), 'utf8')
            assert.equal(readRunSummary(file), null, 'stages 非陣列回 null(呼叫端退回正則解析)')
            assert.equal(readRunSummary(`${TMP}/log/none.json`), null, '檔案不存在回 null')
            assert.equal(writeRunSummary({ dir: `${TMP}/log`, stamp: 'bad', summary: {} }), null, 'stamp 非 14 碼數字回 null')
        })

        it('開工標記:writeRunStart／readRunStart 往返;stamp 格式不符回 null;版本不符或壞檔讀回 null', () => {
            const stamp = '20260921129800'
            const file = writeRunStart({ dir: `${TMP}/log`, stamp, start: { pid: 1, limitMin: 485, deadlineMs: 1, f: () => 1 } })
            assert.ok(file.endsWith(`${stamp}-run.start.json`))
            const j = readRunStart(file)
            assert.deepEqual([j.version, j.stamp, j.limitMin, j.pid, j.f], [1, stamp, 485, 1, undefined])
            assert.equal(writeRunStart({ dir: `${TMP}/log`, stamp: 'bad' }), null)
            assert.equal(writeRunStart(null), null)
            fs.writeFileSync(file, '{壞', 'utf8')
            assert.equal(readRunStart(file), null)
            fs.writeFileSync(file, JSON.stringify({ version: 9 }), 'utf8')
            assert.equal(readRunStart(file), null)
            assert.equal(readRunStart(''), null)
            fs.rmSync(file)
        })

        it('subReportOf:先依階段名取子階段 report,對不上再以子階段鍵於全部階段搜尋(階段名可被覆寫,子階段鍵才是固定接縫);找不到或形狀不合回 null', () => {
            const s = { stages: [{ name: '抓取', sub: { listFetch: { stats: { in: 3 } } } }, { name: '摘要', sub: { summarize: { detail: { notes: 7 } } } }] }
            assert.equal(subReportOf(s, '摘要', 'summarize').detail.notes, 7)
            assert.equal(subReportOf(s, '改了名的階段', 'summarize').detail.notes, 7, '階段名對不上仍以子階段鍵找到')
            assert.equal(subReportOf(s, '抓取', 'summarize').detail.notes, 7, '該階段無此子階段者亦搜尋全部階段')
            assert.equal(subReportOf(s, '抓取', 'listFetch').stats.in, 3)
            assert.equal(subReportOf(s, '不存在', 'x'), null)
            for (const bad of [null, undefined, {}, { stages: 'x' }, { stages: [null, { name: '抓取', sub: { listFetch: 'x' } }] }]) assert.equal(subReportOf(bad, '抓取', 'listFetch'), null, JSON.stringify(bad))
        })
    })

    // ══════════════════════════ ops/browserHygiene ══════════════════════════
    describe('ops/browserHygiene(孤兒瀏覽器行程回收;行程掃描與殺除之案例見 unit-capture-areas)', function() {

        it('profileDirOf:取 Playwright 暫存 profile(--user-data-dir,可帶引號);非 Playwright 暫存 profile 或無此參數回空字串', () => {
            const dir = path.join(path.sep, 'tmpx', `${PLAYWRIGHT_PROFILE_PREFIX}AbC`) // 不含空白(無引號之命令列以空白分隔參數)
            assert.equal(profileDirOf(`chrome.exe --user-data-dir=${dir} --remote-debugging-pipe`), dir)
            assert.equal(profileDirOf(`chrome.exe --user-data-dir="${path.join(path.sep, 'tmp x', `${PLAYWRIGHT_PROFILE_PREFIX}AbC`)}" --remote-debugging-pipe`), path.join(path.sep, 'tmp x', `${PLAYWRIGHT_PROFILE_PREFIX}AbC`), '帶引號者路徑可含空白')
            assert.equal(profileDirOf(`chrome.exe --user-data-dir=${path.join(path.sep, 'tmpx', 'user-own-profile')}`), '', '使用者自己之 Chrome profile 不是 Playwright 暫存目錄')
            assert.equal(profileDirOf('chrome.exe --remote-debugging-pipe'), '')
            assert.equal(profileDirOf(undefined), '')
        })
    })

    // ══════════════════════════ stores/noteFields ══════════════════════════
    describe('stores/noteFields(下游筆記記錄欄位之單一宣告;主標籤之定義)', function() {

        it('欄位名凍結且只列本套件所讀者;各取值之容錯:缺或型別不合回空字串／NaN／false', () => {
            assert.ok(Object.isFrozen(NOTE_FIELDS))
            assert.deepEqual(Object.keys(NOTE_FIELDS), ['docId', 'createdAt', 'title', 'concepts', 'extractedAt'])
            assert.deepEqual([noteDocIdOf({ docId: 'd1' }), noteDocIdOf({ docId: 5 }), noteDocIdOf({}), noteDocIdOf(null)], ['d1', '', '', ''])
            assert.equal(noteCreatedMsOf({ createdAt: '2026-01-02T00:00:00Z' }), Date.UTC(2026, 0, 2))
            for (const bad of [{}, { createdAt: 'x' }, { createdAt: '' }, null]) assert.ok(Number.isNaN(noteCreatedMsOf(bad)), JSON.stringify(bad))
            assert.deepEqual([noteTitleOf({ title: '恆星演化' }), noteTitleOf({}), noteTitleOf(null)], ['恆星演化', '', ''])
            assert.deepEqual([noteConsumedOf({ extractedAt: '2026-01-02' }), noteConsumedOf({ extractedAt: '' }), noteConsumedOf({}), noteConsumedOf(null)], [true, false, false, false])
        })

        it('noteConceptsOf:依序、以概念鍵(normalizeConcept)去重、略過鍵為空者;label 為原寫法去頭尾空白;非陣列視為無標籤;notePrimaryConceptOf 為其第一個', () => {
            // 鍵以 normalizeConcept 算(其字形折疊為模組級單例,同 worker 之他檔可能已設定;鍵之斷言不寫死折疊後之字形)
            const K = normalizeConcept
            assert.deepEqual(noteConceptsOf({ concepts: [' 恆星演化 ', '', '恆星演化', null, '紅移'] }), [{ key: K('恆星演化'), label: '恆星演化' }, { key: K('紅移'), label: '紅移' }])
            // 全形與半形、空白與大小寫於鍵上相同:同一篇只入一次,保留先出現之寫法
            assert.equal(K('Attention 機制'), K('ａｔｔｅｎｔｉｏｎ機制'))
            assert.deepEqual(noteConceptsOf({ concepts: ['Attention 機制', 'ａｔｔｅｎｔｉｏｎ機制', '視差'] }), [{ key: K('Attention 機制'), label: 'Attention 機制' }, { key: K('視差'), label: '視差' }])
            for (const bad of [{ concepts: '恆星' }, { concepts: null }, {}, null]) assert.deepEqual(noteConceptsOf(bad), [], JSON.stringify(bad))
            assert.deepEqual(notePrimaryConceptOf({ concepts: ['', '紅移', '視差'] }), { key: K('紅移'), label: '紅移' })
            assert.equal(notePrimaryConceptOf({ concepts: ['', '  '] }), null)
        })
    })
})
