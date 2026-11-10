// unit-ai-reserved-call.test.mjs — 扣保留之 AI 呼叫之唯一包裝(core/ai/reservedCall)與一次 AI 呼叫之估計(core/util/stageReserve 之 captureCallMsOf)
//
// 規格出處(規則帳本 AI-12;設計 da402 §4.2〈CA〉1～2、§5.2〈CA〉CA-1／CA-2;Gitea #132 之逐次進門門檻):
//   ①進門:gate.shouldStop(本次進門門檻) 為真 → 不呼叫 call,回 { ok:false, data:null, error:'ABORTED', providerId:'', attempts:0, skipped:true, errors:[] };
//   ②否則呼叫 call(prompt, check, { ...callOpt, budgetMs: min(castBudgetMs(callOpt.budgetMs) ?? ∞, gate.remainingMs()), shouldStop }),
//     shouldStop ＝ 呼叫端之 shouldStop() === true ‖ gate.shouldStop(續派門檻);續派門檻 ＝ aiChainStepMsOf(本次進門門檻, callOpt.spec);
//   ③不傳 minAttemptMs(席位之 minAttemptMs 照舊由 spec 交調度層);④不得為 async(同步拋出即同步拋出;回傳值即 call 之回傳值);
//   ⑤本次進門門檻 ＝ callOpt.startMs 為正數時 min(startMs, firstMs),否則 firstMs;startMs 不轉交 call;firstMs 0(未保留)時進門與鏈內皆以 0 判;
//   ⑥gate 只需 shouldStop(ms)、remainingMs()——w-data-pipeline 之 reserveOf 與本套件之 stageReserveGateOf 皆合;
//   ⑦captureCallMsOf(settings, seatOrSeats):陣列取各席之最大;席位 timeoutMs 優先。

import assert from 'node:assert/strict'
import { reservedAiCallOf, aiChainStepMsOf, AI_CHAIN_STEP_MS } from '../src/core/ai/reservedCall.mjs'
import { captureCallMsOf, stageReserveGateOf } from '../src/core/util/stageReserve.mjs'
import { reserveOf } from '../src/core/runnerPackage.mjs'
import * as entry from '../src/WKnowledgeCapture.mjs'

/** 進門即中止之完整形狀(規格①) */
const ABORTED = Object.freeze({ ok: false, data: null, error: 'ABORTED', providerId: '', attempts: 0, skipped: true, errors: [] })

/**
 * 可控之扣保留閘(同 #132 草案之替身):left 為扣保留後之剩餘;expired 為整輪逾期
 *
 * @param {Object} s 輸入 { left, expired? }(可於呼叫中改寫,模擬時間經過)
 * @returns {Object} 回傳 { shouldStop(ms), remainingMs() }
 */
const subOf = (s) => ({ shouldStop: (ms) => s.expired === true || s.left < ms, remainingMs: () => s.left })

/**
 * 可控時鐘之管道脈絡(w-data-pipeline 之 budgetOf 所讀:remainingMs、expired)
 *
 * @param {Object} c 輸入 { left }(整輪剩餘;可改寫)
 * @returns {Object} 回傳 ctx
 */
const ctxOf = (c) => ({ remainingMs: () => c.left, expired: () => c.left <= 0 })

describe('unit-ai-reserved-call', function() {

    it('主入口轉出 reservedAiCallOf、aiChainStepMsOf、AI_CHAIN_STEP_MS、captureCallMsOf(下游套件經主入口取用;與模組為同一實體)', () => {
        assert.deepEqual([entry.reservedAiCallOf, entry.aiChainStepMsOf, entry.AI_CHAIN_STEP_MS, entry.captureCallMsOf], [reservedAiCallOf, aiChainStepMsOf, AI_CHAIN_STEP_MS, captureCallMsOf])
        assert.equal(entry.default.reservedAiCallOf, reservedAiCallOf, '預設匯出物件亦含之')
    })

    describe('aiChainStepMsOf(續派門檻)', function() {

        it('firstMs>0 → min(firstMs, 席位 minAttemptMs>0 ? 該值 : 60 秒);firstMs 非正數或非數 → 0', () => {
            // 規格:stepMs ＝ firstMs>0 ? min(firstMs, seat.minAttemptMs>0 ? 該值 : 60000) : 0
            assert.equal(AI_CHAIN_STEP_MS, 60_000)
            assert.deepEqual(
                [aiChainStepMsOf(360_000), aiChainStepMsOf(30_000), aiChainStepMsOf(0), aiChainStepMsOf(360_000, { minAttemptMs: 30_000 }), aiChainStepMsOf(360_000, { minAttemptMs: 90_000 })],
                [60_000, 30_000, 0, 30_000, 90_000],
            )
            // 非正數、非數之 firstMs → 0(未保留之語意);席位 minAttemptMs 非正數 → 取 60 秒
            for (const bad of [-1, NaN, 'abc', null, undefined]) assert.equal(aiChainStepMsOf(bad), 0, String(bad))
            for (const bad of [0, -5, 'x', null]) assert.equal(aiChainStepMsOf(360_000, { minAttemptMs: bad }), 60_000, String(bad))
            assert.equal(aiChainStepMsOf(360_000, null), 60_000, '席位非物件 → 60 秒')
        })
    })

    describe('reservedAiCallOf:進門、預算取小、鏈內判停(規格①②)', function() {

        it('進門不足(gate.shouldStop(firstMs) 為真)→ call 0 次、回進門即中止之完整形狀', async () => {
            let calls = 0
            const r = await reservedAiCallOf(() => {
                calls++
                return Promise.resolve({ ok: true })
            }, subOf({ left: 359_999 }), { firstMs: 360_000 })('p', () => true, { spec: { use: 'x:a' } })
            assert.deepEqual([calls, r], [0, ABORTED], '規格①:不足即不呼叫,回 ABORTED 之完整形狀')
        })

        it('call 收到之 budgetMs ＝ min(castBudgetMs(呼叫端值) ?? ∞, 扣保留剩餘):未給／非數／+Infinity 取剩餘;0 與負數為 0;數字字串照用;小數取整', async () => {
            const seen = []
            const call = (p, c, o) => {
                seen.push(o.budgetMs)
                return Promise.resolve({ ok: true })
            }
            const ask = reservedAiCallOf(call, subOf({ left: 220_000 }), { firstMs: 120_000 })
            for (const b of [undefined, 50_000, 300_000, 0, -5, '1500', 1500.9, Infinity, NaN, 'abc', null]) await ask('p', () => true, { budgetMs: b })
            // 規格②:budgetMs ＝ min(castBudgetMs(callOpt.budgetMs) ?? ∞, gate.remainingMs())
            assert.deepEqual(seen, [220_000, 50_000, 220_000, 0, 0, 1500, 1500, 220_000, 220_000, 220_000, 220_000])
        })

        it('鏈內 shouldStop:扣保留剩餘 ≥ 續派門檻為 false、< 續派門檻為 true;呼叫端 shouldStop 為 true 即 true;呼叫端拋錯或非 true 視同 false(仍由閘判)', async () => {
            const s = { left: 400_000 }
            const out = []
            await reservedAiCallOf((p, c, o) => {
                // 規格②:續派門檻＝aiChainStepMsOf(360 秒, 未給席位 minAttemptMs)＝60 秒
                out.push(o.shouldStop())
                s.left = 60_000
                out.push(o.shouldStop())
                s.left = 59_999
                out.push(o.shouldStop())
                return Promise.resolve({ ok: true })
            }, subOf(s), { firstMs: 360_000 })('p', () => true, {})
            assert.deepEqual(out, [false, false, true], '剩 400 秒、恰 60 秒不停;59.999 秒停')
            const both = []
            let mine = false
            await reservedAiCallOf((p, c, o) => {
                both.push(o.shouldStop())
                mine = true
                both.push(o.shouldStop())
                return Promise.resolve({ ok: true })
            }, subOf({ left: 400_000 }), { firstMs: 360_000 })('p', () => true, { shouldStop: () => mine })
            assert.deepEqual(both, [false, true], '呼叫端之 shouldStop 為 true 即停(與閘取「或」)')
            const odd = []
            const s2 = { left: 400_000 }
            await reservedAiCallOf((p, c, o) => {
                odd.push(o.shouldStop())
                s2.left = 1
                odd.push(o.shouldStop())
                return Promise.resolve({ ok: true })
            }, subOf(s2), { firstMs: 360_000 })('p', () => true, {
                shouldStop: () => {
                    throw new Error('壞了')
                },
            })
            assert.deepEqual(odd, [false, true], '呼叫端拋錯視同 false,閘之判斷照常')
            const truthy = []
            await reservedAiCallOf((p, c, o) => {
                truthy.push(o.shouldStop())
                return Promise.resolve({ ok: true })
            }, subOf({ left: 400_000 }), { firstMs: 360_000 })('p', () => true, { shouldStop: () => 'yes' })
            assert.deepEqual(truthy, [false], '只認嚴格 true')
        })

        it('不傳 minAttemptMs:席位之 minAttemptMs(90 秒)留在 spec 交調度層,包裝不另加頂層 minAttemptMs;續派門檻取 min(firstMs, 90 秒);其餘選項原樣轉交', async () => {
            const seen = []
            const spec = { use: 'x:a', minAttemptMs: 90_000 }
            const s = { left: 400_000 }
            await reservedAiCallOf((p, c, o) => {
                seen.push(o)
                s.left = 90_000
                const a = o.shouldStop()
                s.left = 89_999
                seen.push([a, o.shouldStop()])
                return Promise.resolve({ ok: true })
            }, subOf(s), { firstMs: 360_000 })('p', () => true, { spec, seat: 'first', segment: 'x', acceptTruncated: true, onEvent: null })
            // 規格③:不傳 minAttemptMs(席位 90 秒時調度層仍用 90 秒)
            assert.equal('minAttemptMs' in seen[0], false)
            assert.equal(seen[0].spec, spec, 'spec 原樣(同一物件)')
            assert.deepEqual([seen[0].seat, seen[0].segment, seen[0].acceptTruncated, seen[0].onEvent], ['first', 'x', true, null], '其餘鍵原樣轉交')
            assert.deepEqual(seen[1], [false, true], '續派門檻＝min(360 秒, 席位 90 秒)')
            // 呼叫端明給之 minAttemptMs 屬呼叫端之選擇,原樣轉交(包裝不增不刪)
            const seen2 = []
            await reservedAiCallOf((p, c, o) => {
                seen2.push(o.minAttemptMs)
                return Promise.resolve({ ok: true })
            }, subOf({ left: 400_000 }), { firstMs: 360_000 })('p', () => true, { minAttemptMs: 5000 })
            assert.deepEqual(seen2, [5000])
        })

        it('prompt、check 原樣轉交;callOpt 非物件視為 {}', async () => {
            const seen = []
            const check = () => true
            const ask = reservedAiCallOf((p, c, o) => {
                seen.push([p, c === check, Object.keys(o).sort()])
                return Promise.resolve({ ok: true })
            }, subOf({ left: 400_000 }), { firstMs: 360_000 })
            await ask('提示詞', check, null)
            await ask('提示詞', check, 'x')
            await ask('提示詞', check)
            assert.deepEqual(seen, Array(3).fill(['提示詞', true, ['budgetMs', 'shouldStop']]))
        })
    })

    describe('reservedAiCallOf:不得為 async(規格④)', function() {

        it('回傳值即 call 之回傳值(同一物件,不另包 Promise);進門不足時回 Promise', async () => {
            const p = Promise.resolve({ ok: true, tag: 1 })
            const ask = reservedAiCallOf(() => p, subOf({ left: 400_000 }), { firstMs: 360_000 })
            assert.equal(ask('p', () => true, {}), p, '包成 async 會回另一個 Promise')
            const sync = { ok: true, tag: 2 }
            assert.equal(reservedAiCallOf(() => sync, subOf({ left: 400_000 }), { firstMs: 360_000 })('p', () => true, {}), sync, 'call 回同步值者原樣回傳')
            const r = reservedAiCallOf(() => assert.fail('不應呼叫'), subOf({ left: 1 }), { firstMs: 360_000 })('p', () => true, {})
            assert.ok(r instanceof Promise, '進門不足回 Promise.resolve(…)')
            assert.deepEqual(await r, ABORTED)
        })

        it('call 同步拋出 → 包裝同步拋出(呼叫端依「同步拋出即不呼叫下一席」之契約);閘同步拋出亦同', () => {
            const ask = reservedAiCallOf(() => {
                throw new Error('同步拋出')
            }, subOf({ left: 400_000 }), { firstMs: 360_000 })
            assert.throws(() => ask('p', () => true, {}), /同步拋出/, '規格④:同步拋出須同步拋出(async 會變成 rejected promise)')
            const bad = reservedAiCallOf(() => Promise.resolve({ ok: true }), {
                shouldStop: () => {
                    throw new Error('閘壞了')
                },
                remainingMs: () => 1,
            }, { firstMs: 1 })
            assert.throws(() => bad('p', () => true, {}), /閘壞了/)
        })
    })

    describe('reservedAiCallOf:逐次進門門檻 startMs(Gitea #132;規格⑤)', function() {

        it('①給了即以之判進門並送出;startMs 不轉交 call;預算＝剩餘;鏈內仍以續派門檻判', async () => {
            const s1 = { left: 220_000 }
            const r0 = await reservedAiCallOf(() => assert.fail('未給 startMs 時依 firstMs'), subOf(s1), { firstMs: 360_000 })('p', () => true, { spec: { use: 'x:c' }, seat: 'third' })
            const seen = []
            const r1 = await reservedAiCallOf((p, c, o) => {
                seen.push(o.budgetMs, o.seat, 'startMs' in o, o.shouldStop())
                s1.left = 59_999
                seen.push(o.shouldStop())
                return Promise.resolve({ ok: true, data: [] })
            }, subOf(s1), { firstMs: 360_000 })('p', () => true, { spec: { use: 'x:c' }, seat: 'third', startMs: 120_000 })
            assert.deepEqual([r0, r1.ok, seen], [ABORTED, true, [220_000, 'third', false, false, true]])
        })

        it('②等號邊界:剩餘恰等於本次門檻 → 送出;少 1 毫秒 → 不送出', async () => {
            const sent = []
            await reservedAiCallOf(() => {
                sent.push('sent')
                return Promise.resolve({ ok: true })
            }, subOf({ left: 120_000 }), { firstMs: 360_000 })('p', () => true, { startMs: 120_000 })
            const r2 = await reservedAiCallOf(() => assert.fail('不足本次門檻時不送出'), subOf({ left: 119_999 }), { firstMs: 360_000 })('p', () => true, { startMs: 120_000 })
            assert.deepEqual([sent, r2], [['sent'], ABORTED])
        })

        it('③續派門檻以本次進門門檻為上限:本次 30 秒 → 鏈內剩 45 秒不停、29.999 秒停(未給 startMs 時為 60 秒)', async () => {
            const s3 = { left: 100_000 }
            const seen3 = []
            await reservedAiCallOf((p, c, o) => {
                s3.left = 45_000
                seen3.push(o.shouldStop())
                s3.left = 29_999
                seen3.push(o.shouldStop())
                return Promise.resolve({ ok: true })
            }, subOf(s3), { firstMs: 360_000 })('p', () => true, { startMs: 30_000 })
            assert.deepEqual(seen3, [false, true])
        })

        it('④不高於 firstMs:本次 600 秒、firstMs 360 秒、剩 400 秒 → 送出;剩 359.999 秒 → 不送出', async () => {
            const sent4 = []
            await reservedAiCallOf(() => {
                sent4.push('sent')
                return Promise.resolve({ ok: true })
            }, subOf({ left: 400_000 }), { firstMs: 360_000 })('p', () => true, { startMs: 600_000 })
            const r = await reservedAiCallOf(() => assert.fail('取 min(startMs, firstMs)'), subOf({ left: 359_999 }), { firstMs: 360_000 })('p', () => true, { startMs: 600_000 })
            assert.deepEqual([sent4, r], [['sent'], ABORTED])
        })

        it('⑤非正數、非數字、null、未給、+Infinity → 取 firstMs(剩 220 秒皆不送出)', async () => {
            for (const bad of [0, -1, -0.5, NaN, 'abc', '', null, undefined, Infinity, -Infinity, {}, true, [120_000]]) {
                const r = await reservedAiCallOf(() => assert.fail(`startMs=${String(bad)} 應取 firstMs`), subOf({ left: 220_000 }), { firstMs: 360_000 })('p', () => true, { startMs: bad })
                assert.equal(r.skipped, true, String(bad))
            }
        })

        it('正數含小數照用(不取整):firstMs 10、startMs 0.5、剩 1 → 送出;startMs 1.9、剩 1.5 → 不送出;十進位數字字串照收', async () => {
            // 規格:startMs「正數」與 firstMs 取小(外審 terra F05:不得以剩餘預算之取整規則處理)
            const sent = []
            await reservedAiCallOf(() => {
                sent.push('0.5')
                return Promise.resolve({ ok: true })
            }, subOf({ left: 1 }), { firstMs: 10 })('p', () => true, { startMs: 0.5 })
            const r = await reservedAiCallOf(() => assert.fail('1.9 > 1.5:不送出'), subOf({ left: 1.5 }), { firstMs: 10 })('p', () => true, { startMs: 1.9 })
            await reservedAiCallOf(() => {
                sent.push('str')
                return Promise.resolve({ ok: true })
            }, subOf({ left: 220_000 }), { firstMs: 360_000 })('p', () => true, { startMs: '120000' })
            assert.deepEqual([sent, r], [['0.5', 'str'], ABORTED])
        })

        it('startMs 與 budgetMs 並給:進門依 min(startMs, firstMs)、預算依 min(呼叫端值, 剩餘),兩者互不干擾;startMs 不轉交', async () => {
            const seen = []
            const r = await reservedAiCallOf((p, c, o) => {
                seen.push(o.budgetMs, 'startMs' in o)
                return Promise.resolve({ ok: true })
            }, subOf({ left: 220_000 }), { firstMs: 360_000 })('p', () => true, { startMs: 120_000, budgetMs: 50_000 })
            assert.deepEqual([r.ok, seen], [true, [50_000, false]])
            const r2 = await reservedAiCallOf(() => assert.fail('剩 100 秒 < 本次門檻 120 秒'), subOf({ left: 100_000 }), { firstMs: 360_000 })('p', () => true, { startMs: 120_000, budgetMs: 50_000 })
            assert.deepEqual(r2, ABORTED, '呼叫端之 budgetMs 不影響進門判斷')
        })

        it('⑥未保留(firstMs 0):給了 startMs 亦只看整輪逾期(進門與鏈內皆以 0 判)', async () => {
            const s6 = { left: 1, expired: false }
            const stops = []
            const r6 = await reservedAiCallOf((p, c, o) => {
                stops.push(o.shouldStop())
                s6.expired = true
                stops.push(o.shouldStop())
                return Promise.resolve({ ok: true })
            }, subOf(s6), { firstMs: 0 })('p', () => true, { startMs: 120_000 })
            assert.deepEqual([r6.ok, stops], [true, [false, true]])
            const r7 = await reservedAiCallOf(() => assert.fail('整輪已逾期'), subOf({ left: 1, expired: true }), { firstMs: 0 })('p', () => true, { startMs: 120_000 })
            assert.deepEqual(r7, ABORTED)
        })
    })

    describe('reservedAiCallOf:兩種閘皆可(規格⑥)', function() {

        it('w-data-pipeline 之 reserveOf:保留 15 分、整輪剩 15 分 + 220 秒 → 本次 120 秒進門;預算＝扣保留剩餘', async () => {
            const c = { left: 900_000 + 220_000 }
            const gate = reserveOf(ctxOf(c), 900_000)
            const seen = []
            const r0 = await reservedAiCallOf(() => assert.fail('未給 startMs 依 firstMs 360 秒'), gate, { firstMs: 360_000 })('p', () => true, {})
            await reservedAiCallOf((p, ck, o) => {
                seen.push(o.budgetMs, o.shouldStop())
                c.left = 900_000 + 59_999
                seen.push(o.shouldStop())
                return Promise.resolve({ ok: true })
            }, gate, { firstMs: 360_000 })('p', () => true, { startMs: 120_000 })
            assert.deepEqual([r0.skipped, seen], [true, [220_000, false, true]])
        })

        it('本套件之 stageReserveGateOf:同上;保留 0 時只看整輪逾期(不比門檻)', async () => {
            const c = { left: 900_000 + 220_000 }
            const gate = stageReserveGateOf(ctxOf(c), 900_000)
            const seen = []
            await reservedAiCallOf((p, ck, o) => {
                seen.push(o.budgetMs, o.shouldStop())
                c.left = 900_000 + 59_999
                seen.push(o.shouldStop())
                return Promise.resolve({ ok: true })
            }, gate, { firstMs: 360_000 })('p', () => true, { startMs: 120_000 })
            assert.deepEqual(seen, [220_000, false, true])
            const c0 = { left: 1000 }
            const off = stageReserveGateOf(ctxOf(c0), 0)
            const r = await reservedAiCallOf((p, ck, o) => Promise.resolve({ ok: true, b: o.budgetMs }), off, { firstMs: 360_000 })('p', () => true, {})
            assert.deepEqual([r.ok, r.b], [true, 1000], '保留 0:門檻不比、預算＝整輪剩餘')
        })
    })

    describe('reservedAiCallOf:建構參數檢核', function() {

        it('call 非函數、gate 缺 shouldStop／remainingMs、firstMs 非非負有限數 → 建構期同步拋錯(訊息 invalid <名稱>: must be …)', () => {
            const gate = subOf({ left: 1 })
            for (const bad of [null, undefined, 1, 'x', {}]) assert.throws(() => reservedAiCallOf(bad, gate, { firstMs: 0 }), /^Error: invalid call: must be a function$/, String(bad))
            for (const bad of [null, undefined, {}, { shouldStop: () => false }, { remainingMs: () => 1 }, 'x']) assert.throws(() => reservedAiCallOf(() => null, bad, { firstMs: 0 }), /^Error: invalid gate: must be an object with shouldStop\(ms\) and remainingMs\(\)$/)
            for (const bad of [undefined, null, -1, NaN, Infinity, '360000', {}]) assert.throws(() => reservedAiCallOf(() => null, gate, { firstMs: bad }), /^Error: invalid opt.firstMs: must be a non-negative finite number$/, String(bad))
            assert.throws(() => reservedAiCallOf(() => null, gate), /invalid opt.firstMs/, '未給 opt')
            assert.doesNotThrow(() => reservedAiCallOf(() => null, gate, { firstMs: 0 }))
        })
    })

    describe('captureCallMsOf:一次 AI 呼叫之估計(規格⑦)', function() {

        it('單席:席位 timeoutMs → providerTimeouts[use] → extraProviders 自帶 → ai.timeoutMs → 300000(順序不變)', () => {
            const ai = { timeoutMs: 120_000, providerTimeouts: { 'x:a': 45_000 }, extraProviders: [{ id: 'x:c', timeoutMs: 80_000 }] }
            assert.deepEqual(
                [captureCallMsOf({ ai }, { use: 'x:a' }), captureCallMsOf({ ai }, { use: 'x:a', timeoutMs: 9000 }), captureCallMsOf({ ai }, { use: 'x:c' }), captureCallMsOf({ ai }, { use: 'x:b' }), captureCallMsOf({}, null)],
                [45_000, 9000, 80_000, 120_000, 300_000],
            )
        })

        it('陣列:各席依同一順序取值後取最大;席位 timeoutMs 優先(9000 雖小於該 id 之逐 id 逾時亦以 9000 計);非物件之元素略過;空陣列同未給席位', () => {
            const ai = { timeoutMs: 1000, providerTimeouts: { 'x:a': 5000, 'x:b': 360_000 } }
            // 規格:陣列取最大(判定小組三席之段開工門檻)
            assert.equal(captureCallMsOf({ ai }, [{ use: 'x:a' }, { use: 'x:b' }]), 360_000)
            assert.equal(captureCallMsOf({ ai }, [{ use: 'x:a' }, { use: 'x:z' }]), 5000)
            // 規格:席位 timeoutMs 優先(與單席同一順序;RE 舊 callTimeoutMsOf 漏此項)
            assert.equal(captureCallMsOf({ ai }, [{ use: 'x:b', timeoutMs: 9000 }, { use: 'x:a' }]), 9000)
            assert.equal(captureCallMsOf({ ai }, [{ use: 'x:b', timeoutMs: 9000 }]), 9000)
            assert.equal(captureCallMsOf({ ai }, [null, 'x', { use: 'x:a' }]), 5000, '非物件之元素略過')
            assert.equal(captureCallMsOf({ ai }, []), 1000, '空陣列 → ai.timeoutMs')
            assert.equal(captureCallMsOf({}, []), 300_000)
        })
    })
})
