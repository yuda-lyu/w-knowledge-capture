// unit-capture-reserve-gate.test.mjs — 子階段扣保留之共用件(src/core/util/stageReserve.mjs):取值器、守門閘、一次作業之估計、一次呼叫(AI)之估計、日誌字樣
// 規則(出自該檔檔頭與規則帳本 CAP-17):
//   ①保留值:opt.reserveMs 明給者優先(含 0;建構即檢核)、未給(或 null)取每輪 ctx.deps.reserveMs、皆未給為 0;取值規則取 w-data-pipeline 之 reserveMsOf(各段同一份)
//   ②守門閘:保留為 0 時只看整輪是否逾期(且不探詢 ctx.remainingMs——與直接用整輪預算完全相同);保留 > 0 時須「整輪剩餘 − 保留 ≥ 一次作業之估計」
//   ③「因保留而停」(cut)只在保留 > 0、整輪未逾期、可用不足時成立(整輪逾期屬一般截止,不歸因於保留)
//   ④一次作業之估計:各段自給之逾時取最大正有限數,皆無則 1 秒(不為零,否則「剩餘 − 保留」恆夠、保留形同虛設);AI 呼叫取席位逾時鏈
// 執行:自套件根 npx mocha test/unit-capture-reserve-gate.test.mjs

import assert from 'node:assert/strict'
import {
    STAGE_STEP_FLOOR_MS, stageReserveFnOf, stageReserveGateOf, stageStepMsOf, fetchStepMsOf, captureCallMsOf, reserveNoteOf
} from '../src/core/util/stageReserve.mjs'
import WKnowledgeCapture from '../src/WKnowledgeCapture.mjs'

const MIN = 60_000

/** 計數型 ctx:remainingMs／expired 各被探詢幾次(斷言「保留為 0 時不多探詢」) */
function spyCtx(remainMs, { expired = false } = {}) {
    const n = { remaining: 0, expired: 0 }
    return {
        n,
        remainingMs: () => {
            n.remaining++
            return remainMs
        },
        expired: () => {
            n.expired++
            return expired
        },
    }
}

describe('unit-capture-reserve-gate', function() {

    describe('stageReserveFnOf(取值器)', () => {
        it('opt.reserveMs 明給者優先(含 0);未給或 null 取 ctx.deps.reserveMs;皆未給為 0', () => {
            assert.equal(stageReserveFnOf({ reserveMs: 900000 }, 'stageX')({ deps: { reserveMs: 1 } }), 900000)
            assert.equal(stageReserveFnOf({ reserveMs: 0 }, 'stageX')({ deps: { reserveMs: 600000 } }), 0, '明給 0 優先於依賴')
            assert.equal(stageReserveFnOf({}, 'stageX')({ deps: { reserveMs: 600000 } }), 600000)
            assert.equal(stageReserveFnOf({ reserveMs: null }, 'stageX')({ deps: { reserveMs: 600000 } }), 600000, 'null 視為未給')
            assert.equal(stageReserveFnOf({}, 'stageX')({ deps: {} }), 0)
            assert.equal(stageReserveFnOf(undefined, 'stageX')({}), 0)
            assert.equal(stageReserveFnOf(null, 'stageX')(null), 0)
        })
        it('函數形式 (ctx) => 毫秒:opt 與 deps 皆可,每次呼叫求值並收到該輪之 ctx', () => {
            let n = 0
            const f = stageReserveFnOf({
                reserveMs: (c) => {
                    n++; return c.k
                }
            }, 'stageX')
            assert.deepEqual([f({ k: 5 }), f({ k: 7 }), n], [5, 7, 2])
            assert.equal(stageReserveFnOf({}, 'stageX')({ deps: { reserveMs: (c) => c.deps.q * 2, q: 4 } }), 8)
        })
        it('不合法:opt 於建構即拋(訊息含階段名與 opt.reserveMs);deps 與函數回傳不合法於呼叫時拋(訊息含 deps.reserveMs)', () => {
            for (const bad of [-1, 'x', NaN, Infinity, true, {}, []]) {
                assert.throws(() => stageReserveFnOf({ reserveMs: bad }, 'stageX'), /stageX 之 opt\.reserveMs/, String(bad))
                assert.throws(() => stageReserveFnOf({}, 'stageX')({ deps: { reserveMs: bad } }), /stageX 之 deps\.reserveMs/, `deps ${String(bad)}`)
            }
            assert.throws(() => stageReserveFnOf({ reserveMs: () => -1 }, 'stageX')({}), /reserveMs/)
            assert.throws(() => stageReserveFnOf({ reserveMs: () => NaN }, 'stageX')({}), /reserveMs/)
        })
    })

    describe('stageReserveGateOf(守門閘)', () => {
        it('保留為 0(或非正、非有限):只看整輪是否逾期;不探詢 ctx.remainingMs(與直接用整輪預算完全相同)', () => {
            for (const keep of [0, -5, NaN, undefined, Infinity, 'x']) {
                const c = spyCtx(1_000)
                const g = stageReserveGateOf(c, keep)
                assert.equal(g.keep, 0, String(keep))
                assert.equal(g.shouldStop(10 * MIN), false, '剩 1 秒、估計 10 分,保留為 0 → 仍不停(現版只守逾期)')
                assert.equal(g.cut(10 * MIN), false)
                assert.equal(c.n.remaining, 0, `保留 ${String(keep)}:不得探詢 remainingMs`)
            }
            const ex = stageReserveGateOf(spyCtx(5_000, { expired: true }), 0)
            assert.deepEqual([ex.shouldStop(0), ex.expired(), ex.cut(1)], [true, true, false], '整輪逾期 → 停,但不歸因於保留')
        })
        it('保留 > 0:停止須「整輪剩餘 − 保留 < 估計」;恰等於 → 不停;少 1 毫秒 → 停;remainingMs() 為扣保留後之剩餘', () => {
            const at = stageReserveGateOf({ remainingMs: () => 17 * MIN, expired: () => false }, 15 * MIN)
            assert.deepEqual([at.keep, at.remainingMs(), at.roundMs()], [15 * MIN, 2 * MIN, 17 * MIN])
            assert.equal(at.shouldStop(2 * MIN), false, '恰等於')
            assert.equal(at.shouldStop(2 * MIN + 1), true, '少 1 毫秒')
            assert.deepEqual([at.cut(2 * MIN), at.cut(2 * MIN + 1)], [false, true])
        })
        it('因保留而停(cut):整輪已逾期不算;無截止(remainingMs 缺或回 Infinity)不停;剩餘小於保留時可用夾為 0', () => {
            const exp = stageReserveGateOf({ remainingMs: () => 0, expired: () => true }, 15 * MIN)
            assert.deepEqual([exp.shouldStop(1000), exp.cut(1000)], [true, false])
            const none = stageReserveGateOf({}, 15 * MIN)
            assert.deepEqual([none.remainingMs(), none.shouldStop(10 * MIN), none.cut(10 * MIN)], [Infinity, false, false])
            const inf = stageReserveGateOf({ remainingMs: () => Infinity, expired: () => false }, 15 * MIN)
            assert.equal(inf.shouldStop(10 * MIN), false)
            const low = stageReserveGateOf({ remainingMs: () => 5 * MIN, expired: () => false }, 15 * MIN)
            assert.deepEqual([low.remainingMs(), low.shouldStop(1), low.cut(1)], [0, true, true])
        })
        it('估計為 0 或未給:保留 > 0 時 shouldStop(0) 只在逾期時成立(可用恆 ≥ 0)', () => {
            const g = stageReserveGateOf({ remainingMs: () => 1000, expired: () => false }, 15 * MIN)
            assert.deepEqual([g.shouldStop(0), g.shouldStop(), g.shouldStop(NaN)], [false, false, false])
        })
        it('每次求值當下之剩餘(不在建構時取一次):時鐘推進後同一閘之判斷隨之改變', () => {
            let rem = 20 * MIN
            const g = stageReserveGateOf({ remainingMs: () => rem, expired: () => false }, 15 * MIN)
            assert.equal(g.shouldStop(2 * MIN), false)
            rem = 16 * MIN
            assert.equal(g.shouldStop(2 * MIN), true)
        })
    })

    describe('stageStepMsOf(一次作業之估計)', () => {
        it('取各候選之最大正有限數;皆無(0、負、NaN、非數)則為下限 1 秒', () => {
            assert.equal(STAGE_STEP_FLOOR_MS, 1000)
            assert.equal(stageStepMsOf(30_000, 120_000, 0), 120_000)
            assert.equal(stageStepMsOf(undefined, null, 0, -5, NaN, 'x'), STAGE_STEP_FLOOR_MS)
            assert.equal(stageStepMsOf(), STAGE_STEP_FLOOR_MS)
            assert.equal(stageStepMsOf(500), 500, '正數即採用(不被下限墊高)')
        })
    })

    describe('fetchStepMsOf(一次抓取之最壞耗時)', () => {
        it('抓取器自宣告之逾時優先於設定之逾時;× (retries＋1) ＋ retryDelayMs × retries;皆無逾時 → 0(交 stageStepMsOf 補下限)', () => {
            assert.equal(fetchStepMsOf({ timeoutMs: 90000, retries: 0 }, 30000), 90000, '自宣告優先')
            assert.equal(fetchStepMsOf({}, 30000), 30000, '無自宣告 → 取設定之逾時')
            assert.equal(fetchStepMsOf({ timeoutMs: 30000, retries: 1, retryDelayMs: 2000 }, 0), 62000, '2 次嘗試＋1 次等待')
            assert.equal(fetchStepMsOf({ timeoutMs: 1000, retries: 3, retryDelayMs: 500 }), 5500, '4 次嘗試＋3 次等待')
            assert.equal(fetchStepMsOf({ timeoutMs: 0 }, 0), 0)
            assert.equal(fetchStepMsOf({}, undefined), 0)
            assert.equal(fetchStepMsOf(null, 30000), 30000, '非物件抓取器 → 只取設定逾時')
            assert.equal(fetchStepMsOf({ timeoutMs: 1000, retries: -2, retryDelayMs: 500 }), 1000, '非法 retries 視為 0')
            assert.equal(fetchStepMsOf({ timeoutMs: 1000, retries: 1.5 }), 1000, '非整數 retries 視為 0')
            assert.equal(fetchStepMsOf({ timeoutMs: '1000', retries: 1 }), 0, '非數字逾時視為未給')
        })
    })

    describe('captureCallMsOf(一次 AI 呼叫之估計)', () => {
        it('席位 timeoutMs → ai.providerTimeouts[席位 use] → ai.extraProviders 該條目 timeoutMs → ai.timeoutMs → 300000', () => {
            const ai = { timeoutMs: 120000, providerTimeouts: { 'x:a': 45000 }, extraProviders: [{ id: 'x:c', timeoutMs: 80000 }] }
            assert.equal(captureCallMsOf({ ai }, { use: 'x:a' }), 45000)
            assert.equal(captureCallMsOf({ ai }, { use: 'x:a', timeoutMs: 9000 }), 9000)
            assert.equal(captureCallMsOf({ ai }, { use: 'x:c' }), 80000)
            assert.equal(captureCallMsOf({ ai }, { use: 'x:b' }), 120000)
            assert.equal(captureCallMsOf({}, null), 300000)
            assert.equal(captureCallMsOf(undefined, undefined), 300000)
            assert.equal(captureCallMsOf({ ai: { timeoutMs: -1, providerTimeouts: { 'x:a': 'zz' } } }, { use: 'x:a', timeoutMs: 0 }), 300000, '非正數視為未給')
        })
    })

    describe('reserveNoteOf(日誌字樣)', () => {
        it('寫明保留、扣保留後剩餘與一次作業之估計(分鐘一位小數、估計以秒)', () => {
            const g = stageReserveGateOf({ remainingMs: () => 16 * MIN, expired: () => false }, 15 * MIN)
            const s = reserveNoteOf(g, 120_000)
            assert.match(s, /保留 15 分/)
            assert.match(s, /剩餘 1 分/)
            assert.match(s, /120 秒/)
        })
    })

    it('共用件已掛入套件主入口(具名與預設同一實體)', () => {
        for (const [k, v] of Object.entries({ STAGE_STEP_FLOOR_MS, stageReserveFnOf, stageReserveGateOf, stageStepMsOf, fetchStepMsOf, captureCallMsOf, reserveNoteOf })) {
            assert.equal(WKnowledgeCapture[k], v, k)
        }
    })
})
