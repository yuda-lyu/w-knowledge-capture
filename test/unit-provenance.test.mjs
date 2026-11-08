// unit-provenance.test.mjs — 產出鏈共用件(core/ops/provenance):makeProduced／appendProduced／pkgIdOf
// 規則(出自跨套件規格《知識套件之產出鏈》§2、§5;使用端 Gitea #107～#109;本檔「規格句」均指該規格):
//   ①makeProduced(規格 §5.1):依 §2 檢核並組出 produced——單一產出者與多步產出兩種形狀;v 恆為 1;拒絕未知鍵與缺必填;at 未給取現在(本地時區 ISO);
//     輸入為必須參數,錯誤即拋,訊息格式依《輸入參數之檢測機制》V19(invalid <名稱>: must be <種類描述>),不回顯輸入值(K9)
//   ②appendProduced(規格 §5.2、§2.3):每次寫入追加一筆;produced 為最後一筆;每筆記錄保留最近 max(預設 50)筆,超出捨去最舊並累計 producedHistoryDropped;不改輸入
//   ③pkgIdOf(規格 §5.3):自模組位置往上找最近之 package.json,回 name@version;結果快取;路徑以 fileURLToPath 解析
// 入口:三者皆自套件主入口取用(規格 §5.6)
// 執行:自套件根 npx mocha test/unit-provenance.test.mjs(暫存 test/_tmp/provenance-<pid>,測完即刪;不連網、不呼叫 AI)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as Entry from '../src/WKnowledgeCapture.mjs'
import { tmpRoot } from './tools/captureTestKit.mjs'
import { removeRoots, msgOf } from './tools/testKit.mjs'

// 以命名空間取用:未實作時各案各自失敗(TypeError),而非整檔載入失敗
const { makeProduced, appendProduced, pkgIdOf } = Entry

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG_JSON = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'))

const MSG_PKG = 'invalid o.pkg: must be a package id \'name@version\''

/** 單一產出者之合法輸入(規格 §2.1 之範例形狀) */
const SINGLE = Object.freeze({
    stamp: '20261108200009',
    stage: 'note-write',
    seat: 'demo.ai',
    provider: 'codex:gpt-6.1-terra',
    promptFp: '5118f8f40bf0dc40',
    pkg: 'w-demo-kb@1.0.10',
    at: '2026-11-08T20:12:31+08:00',
})

/** 多步產出之合法輸入(規格 §2.2 之範例形狀) */
const MULTI = Object.freeze({
    stamp: '20261108200009',
    stage: 'note-multi',
    pkg: 'w-demo-kb@1.0.3',
    at: '2026-11-08T20:12:31+08:00',
    steps: Object.freeze([
        Object.freeze({ role: 'draft', seat: 1, provider: 'ocgo:opencode-go/beam-free', promptFp: '0123456789abcdef' }),
        Object.freeze({ role: 'integrate', seat: 0, provider: 'claude:sonnet' }),
    ]),
    failures: Object.freeze([
        Object.freeze({ role: 'draft', seat: 2, provider: 'codex:gpt-6.1-terra', type: 'TIMEOUT' }),
    ]),
})

/**
 * 深度凍結(驗「不改輸入」:凍結後任何寫入在嚴格模式下即拋)
 *
 * @param {*} v 輸入值
 * @returns {*} 回傳同一值
 */
function deepFreeze(v) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
        Object.freeze(v)
        for (const k of Object.keys(v)) deepFreeze(v[k])
    }
    return v
}

/** 一份可改之深拷貝 */
const copy = (v) => JSON.parse(JSON.stringify(v))

/** 以 SINGLE 為底,覆寫或刪除(值為 undefined 者刪除該鍵)後的新物件 */
const single = (patch = {}) => {
    const o = copy(SINGLE)
    for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete o[k]
        else o[k] = v
    }
    return o
}

/** 以 MULTI 為底,同上 */
const multi = (patch = {}) => {
    const o = copy(MULTI)
    for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete o[k]
        else o[k] = v
    }
    return o
}

describe('unit-provenance', function() {

    this.timeout(60_000)

    let root = ''
    before(() => {
        root = tmpRoot('provenance')
    })
    after(() => {
        removeRoots([root])
    })

    describe('makeProduced:正例', function() {

        it('單一產出者:組出 { v:1, stamp, stage, seat, provider, promptFp, pkg, at },鍵序固定(規格 §2.1)', () => {
            const p = makeProduced(single())
            assert.deepEqual(p, { v: 1, ...SINGLE }, '規格 §2.1:各欄原值,另加結構版本 v:1')
            assert.deepEqual(Object.keys(p), ['v', 'stamp', 'stage', 'seat', 'provider', 'promptFp', 'pkg', 'at'])
            assert.equal(p.v, 1, '規格 §2.1:v 為結構版本 1')
            assert.ok(!('steps' in p) && !('failures' in p), '規格 §2.2:單一產出者不帶 steps／failures')
        })

        it('單一產出者:輪次外(手動 ops／CLI)stamp 為 null;promptFp 可省(undefined 或 null 皆不出現該鍵)(規格 §2.1)', () => {
            for (const fp of [undefined, null]) {
                const p = makeProduced(single({ stamp: null, promptFp: fp }))
                assert.equal(p.stamp, null)
                assert.ok(!('promptFp' in p), `promptFp=${fp} 時不寫該鍵(規格 §1:無題組者省略此欄)`)
                assert.deepEqual(Object.keys(p), ['v', 'stamp', 'stage', 'seat', 'provider', 'pkg', 'at'])
            }
        })

        it('多步產出:組出 { v:1, stamp, stage, pkg, at, steps, failures },不帶頂層 seat／provider／promptFp(規格 §2.2)', () => {
            const p = makeProduced(multi())
            assert.deepEqual(Object.keys(p), ['v', 'stamp', 'stage', 'pkg', 'at', 'steps', 'failures'])
            assert.deepEqual(p.steps, MULTI.steps, '規格 §2.2:每個實際成交之呼叫一列,依執行順序')
            assert.deepEqual(Object.keys(p.steps[0]), ['role', 'seat', 'provider', 'promptFp'])
            assert.deepEqual(Object.keys(p.steps[1]), ['role', 'seat', 'provider'], '步驟之 promptFp 可省')
            assert.deepEqual(p.failures, MULTI.failures, '規格 §2.2:失敗而遞補者')
            assert.deepEqual(Object.keys(p.failures[0]), ['role', 'seat', 'provider', 'type'])
            for (const k of ['seat', 'provider', 'promptFp']) assert.ok(!(k in p), `規格 §2.2:多步產出不帶頂層 ${k}`)
        })

        it('多步產出:failures 未給或給空陣列皆得 [](形狀恆定);席號可給數字字串並轉為數字(N2 非負整數,K4 檢測之值即使用之值)', () => {
            assert.deepEqual(makeProduced(multi({ failures: undefined })).failures, [])
            assert.deepEqual(makeProduced(multi({ failures: [] })).failures, [])
            const p = makeProduced(multi({ steps: [{ role: 'draft', seat: ' 2 ', provider: 'x:y' }] }))
            assert.equal(p.steps[0].seat, 2)
            assert.equal(typeof p.steps[0].seat, 'number')
        })

        it('at 未給:取現在,本地時區 ISO(YYYY-MM-DDTHH:mm:ss±hh:mm,與機器本地時區之偏移一致)(規格 §5.1)', () => {
            const before = Date.now()
            const p = makeProduced(single({ at: undefined }))
            const after = Date.now()
            assert.match(p.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
            const t = Date.parse(p.at)
            assert.ok(t >= before - 1000 && t <= after, `at 應為現在(取至秒):${p.at}`)
            const off = -new Date().getTimezoneOffset() // 分鐘,東為正
            const a = Math.abs(off)
            const want = `${off < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`
            assert.equal(p.at.slice(-6), want, '偏移取機器本地時區')
            assert.deepEqual(Object.keys(p), ['v', 'stamp', 'stage', 'seat', 'provider', 'promptFp', 'pkg', 'at'], 'at 預設後鍵序仍同')
            assert.equal(makeProduced(single({ at: null })).at.length, 25, 'at 為 null 視同未給')
        })

        it('at 明給:原樣保留(時鐘物件之 iso8() 即此格式);v 明給 1 可、其餘拒收', () => {
            assert.equal(makeProduced(single({ at: '2026-01-02T03:04:05+08:00' })).at, '2026-01-02T03:04:05+08:00')
            assert.equal(makeProduced(single({ at: '2026-08-18T04:00:00+00:00' })).at, '2026-08-18T04:00:00+00:00')
            assert.equal(makeProduced(single({ v: 1 })).v, 1)
        })

        it('不改輸入、不與輸入共享參考:輸入深度凍結後仍可組出;輸出之 steps／failures 為新物件(規格 §5.1:下游以此組,不自行拼物件)', () => {
            const inSingle = deepFreeze(single())
            const inMulti = deepFreeze(multi())
            const a = makeProduced(inSingle)
            const b = makeProduced(inMulti)
            assert.notEqual(a, inSingle)
            assert.notEqual(b.steps, inMulti.steps)
            assert.notEqual(b.steps[0], inMulti.steps[0])
            assert.notEqual(b.failures[0], inMulti.failures[0])
            b.steps[0].role = 'changed'
            assert.equal(inMulti.steps[0].role, 'draft', '改輸出不影響輸入')
        })
    })

    describe('makeProduced:反例(訊息全文;V19 格式,不回顯輸入值)', function() {

        /** [說明, 輸入, 訊息] */
        const BAD = [
            // o 本身
            ['o 為 null', null, 'invalid o: must be a plain object'],
            ['o 為陣列', [], 'invalid o: must be a plain object'],
            ['o 為字串', 'x', 'invalid o: must be a plain object'],
            ['o 未給', undefined, 'invalid o: must be a plain object'],
            // 未知鍵
            ['未知鍵(誤拼 provder)', { ...single(), provder: 'x' }, 'invalid o.provder: unknown key'],
            ['未知鍵(多一個 extra)', { ...single(), extra: 1 }, 'invalid o.extra: unknown key'],
            ['多步之步驟含未知鍵', multi({ steps: [{ role: 'draft', seat: 1, provider: 'x:y', model: 'm' }] }), 'invalid o.steps[0].model: unknown key'],
            ['多步之失敗列含未知鍵', multi({ failures: [{ role: 'draft', seat: 1, provider: 'x:y', type: 'T', why: 'w' }] }), 'invalid o.failures[0].why: unknown key'],
            // 缺必填(單一產出者)
            ['缺 stamp(輪次外須明給 null,以免漏接線而靜默缺值)', single({ stamp: undefined }), 'invalid o.stamp: must be a 14-digit stamp string or null'],
            ['缺 stage', single({ stage: undefined }), 'invalid o.stage: must be a lowercase kebab-case name'],
            ['缺 seat', single({ seat: undefined }), 'invalid o.seat: must be a non-empty string'],
            ['缺 provider', single({ provider: undefined }), 'invalid o.provider: must be a non-empty string'],
            ['缺 pkg', single({ pkg: undefined }), MSG_PKG],
            // 缺必填(多步)
            ['多步缺 pkg', multi({ pkg: undefined }), MSG_PKG],
            ['多步缺 stage', multi({ stage: undefined }), 'invalid o.stage: must be a lowercase kebab-case name'],
            ['多步 steps 為空陣列', multi({ steps: [] }), 'invalid o.steps: must be a non-empty array'],
            ['多步 steps 非陣列', multi({ steps: {} }), 'invalid o.steps: must be a non-empty array'],
            ['步驟非物件', multi({ steps: ['x'] }), 'invalid o.steps[0]: must be a plain object'],
            ['步驟缺 role', multi({ steps: [{ seat: 1, provider: 'x:y' }] }), 'invalid o.steps[0].role: must be a non-empty string'],
            ['步驟缺 seat', multi({ steps: [{ role: 'draft', provider: 'x:y' }] }), 'invalid o.steps[0].seat: must be a non-negative integer'],
            ['步驟缺 provider(第二步)', multi({ steps: [{ role: 'draft', seat: 1, provider: 'x:y' }, { role: 'integrate', seat: 0 }] }), 'invalid o.steps[1].provider: must be a non-empty string'],
            ['失敗列缺 type', multi({ failures: [{ role: 'draft', seat: 1, provider: 'x:y' }] }), 'invalid o.failures[0].type: must be a non-empty string'],
            ['failures 非陣列', multi({ failures: {} }), 'invalid o.failures: must be an array'],
            // 型別或格式不符
            ['v 非 1', single({ v: 2 }), 'invalid o.v: must be 1'],
            ['stamp 非 14 碼', single({ stamp: '2026110820' }), 'invalid o.stamp: must be a 14-digit stamp string or null'],
            ['stamp 為數字', single({ stamp: 20261108200009 }), 'invalid o.stamp: must be a 14-digit stamp string or null'],
            ['stage 含大寫', single({ stage: 'Summarize' }), 'invalid o.stage: must be a lowercase kebab-case name'],
            ['stage 含空白', single({ stage: 'standards fix' }), 'invalid o.stage: must be a lowercase kebab-case name'],
            ['seat 為空字串', single({ seat: '' }), 'invalid o.seat: must be a non-empty string'],
            ['seat 為數字(單一產出者之席位為設定路徑或 first／second／third)', single({ seat: 1 }), 'invalid o.seat: must be a non-empty string'],
            ['provider 僅空白', single({ provider: '   ' }), 'invalid o.provider: must be a non-empty string'],
            ['provider 為物件', single({ provider: { id: 'x' } }), 'invalid o.provider: must be a non-empty string'],
            ['promptFp 非 16 碼十六進位', single({ promptFp: 'xyz' }), 'invalid o.promptFp: must be a 16-character lowercase hex string'],
            ['promptFp 含大寫', single({ promptFp: '5118F8F40BF0DC40' }), 'invalid o.promptFp: must be a 16-character lowercase hex string'],
            ['pkg 無版本', single({ pkg: 'w-demo-kb' }), MSG_PKG],
            ['pkg 版本為空', single({ pkg: 'w-demo-kb@' }), MSG_PKG],
            ['pkg 無名稱', single({ pkg: '@1.0.0' }), MSG_PKG],
            ['at 僅日期', single({ at: '2026-11-08' }), 'invalid o.at: must be a local-time ISO string YYYY-MM-DDTHH:mm:ss±hh:mm'],
            ['at 為 UTC Z 且帶毫秒(toISOString 之形:非本地時區 ISO)', single({ at: '2026-11-08T12:12:31.000Z' }), 'invalid o.at: must be a local-time ISO string YYYY-MM-DDTHH:mm:ss±hh:mm'],
            ['at 日期不存在(2 月 30 日)', single({ at: '2026-02-30T10:00:00+08:00' }), 'invalid o.at: must be a local-time ISO string YYYY-MM-DDTHH:mm:ss±hh:mm'],
            ['at 時刻越界(25 時)', single({ at: '2026-11-08T25:00:00+08:00' }), 'invalid o.at: must be a local-time ISO string YYYY-MM-DDTHH:mm:ss±hh:mm'],
            ['at 為數字', single({ at: 1762603951000 }), 'invalid o.at: must be a local-time ISO string YYYY-MM-DDTHH:mm:ss±hh:mm'],
            ['步驟席號為負', multi({ steps: [{ role: 'draft', seat: -1, provider: 'x:y' }] }), 'invalid o.steps[0].seat: must be a non-negative integer'],
            ['步驟席號為小數', multi({ steps: [{ role: 'draft', seat: 1.5, provider: 'x:y' }] }), 'invalid o.steps[0].seat: must be a non-negative integer'],
            ['步驟席號為非數字字串', multi({ steps: [{ role: 'draft', seat: 'first', provider: 'x:y' }] }), 'invalid o.steps[0].seat: must be a non-negative integer'],
            ['步驟席號為布林(true 不得當 1,K5)', multi({ steps: [{ role: 'draft', seat: true, provider: 'x:y' }] }), 'invalid o.steps[0].seat: must be a non-negative integer'],
            ['步驟 promptFp 格式不符', multi({ steps: [{ role: 'draft', seat: 1, provider: 'x:y', promptFp: 'abc' }] }), 'invalid o.steps[0].promptFp: must be a 16-character lowercase hex string'],
            ['失敗列席號為負', multi({ failures: [{ role: 'draft', seat: -2, provider: 'x:y', type: 'T' }] }), 'invalid o.failures[0].seat: must be a non-negative integer'],
            // 兩種形狀不可混
            ['多步同時帶頂層 seat', multi({ seat: 'demo.ai' }), 'invalid o.seat: must not be given together with o.steps'],
            ['多步同時帶頂層 provider', multi({ provider: 'x:y' }), 'invalid o.provider: must not be given together with o.steps'],
            ['多步同時帶頂層 promptFp', multi({ promptFp: '0123456789abcdef' }), 'invalid o.promptFp: must not be given together with o.steps'],
            ['單一產出者帶 failures', single({ failures: [] }), 'invalid o.failures: must not be given without o.steps'],
        ]

        for (const [name, input, msg] of BAD) {
            it(`${name} → ${msg}`, () => {
                assert.equal(msgOf(() => makeProduced(input)), msg)
            })
        }

        it('錯誤為同步拋出之 Error,且先於任何輸出(拋錯時不回傳半成品)(輸入參數檢測機制 §5.1、V17)', () => {
            assert.throws(() => makeProduced(single({ stage: 'Bad' })), Error)
        })

        it('訊息不回顯輸入值(K9):各欄以含辨識字串之非法值觸發,訊息皆不含該字串', () => {
            const secret = 'S3CR3T-LEAK'
            const cases = [
                single({ stamp: secret }), single({ stage: secret }), single({ seat: 5, provider: secret }), single({ promptFp: secret }),
                single({ pkg: secret }), single({ at: secret }), multi({ steps: [{ role: secret, seat: secret, provider: 'x:y' }] }),
                { ...single(), [secret]: 1 },
            ]
            for (const c of cases) {
                const m = msgOf(() => makeProduced(c))
                assert.ok(m, '須拋錯')
                // 未知鍵之訊息帶鍵名(程式識別字,非資料值;需據以改正誤拼),故該案不查
                if (!(secret in c)) assert.ok(!m.includes(secret), m)
            }
        })
    })

    describe('makeProduced:不呼叫 AI 之寫入(單一產出者之 seat 與 provider 同時為 null;規格 §2.1)', function() {

        const PAIR = 'invalid o.seat and o.provider: must be both non-empty strings or both null'

        it('seat 與 provider 同時為 null → 組出,兩鍵仍在且值為 null(形狀恆定,供依 provider 選件);鍵序同單一產出者(規格 §2.1)', () => {
            const p = makeProduced(single({ seat: null, provider: null, promptFp: undefined }))
            assert.deepEqual(p, { v: 1, stamp: SINGLE.stamp, stage: SINGLE.stage, seat: null, provider: null, pkg: SINGLE.pkg, at: SINGLE.at })
            assert.deepEqual(Object.keys(p), ['v', 'stamp', 'stage', 'seat', 'provider', 'pkg', 'at'])
            assert.equal(Object.hasOwn(p, 'seat') && Object.hasOwn(p, 'provider'), true)
            assert.ok(!('steps' in p) && !('failures' in p), '仍為單一產出者形狀')
        })

        it('輪次外(stamp 為 null)之無 AI 寫入亦可;at 未給取現在;JSON 往返後同值', () => {
            const p = makeProduced(single({ stamp: null, seat: null, provider: null, promptFp: undefined, at: undefined }))
            assert.equal(p.stamp, null)
            assert.match(p.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
            assert.deepEqual(JSON.parse(JSON.stringify(p)), p)
        })

        it('promptFp 仍為選填(規格未禁):給了合格者保留,不合格式者仍拒', () => {
            assert.equal(makeProduced(single({ seat: null, provider: null })).promptFp, SINGLE.promptFp)
            assert.equal(msgOf(() => makeProduced(single({ seat: null, provider: null, promptFp: 'xyz' }))), 'invalid o.promptFp: must be a 16-character lowercase hex string')
        })

        it('只其一為 null 仍拒(訊息全文):seat 為 null 而 provider 為字串;seat 為字串而 provider 為 null;空白字串、數字、缺省與 null 並存亦拒', () => {
            assert.equal(msgOf(() => makeProduced(single({ seat: null }))), PAIR, 'seat null、provider 字串')
            assert.equal(msgOf(() => makeProduced(single({ provider: null }))), PAIR, 'seat 字串、provider null')
            assert.equal(msgOf(() => makeProduced(single({ seat: null, provider: undefined }))), PAIR, 'seat null、provider 缺省')
            assert.equal(msgOf(() => makeProduced(single({ seat: undefined, provider: null }))), PAIR, 'seat 缺省、provider null')
            assert.equal(msgOf(() => makeProduced(single({ seat: null, provider: '' }))), PAIR, 'seat null、provider 空字串')
            assert.equal(msgOf(() => makeProduced(single({ seat: '  ', provider: null }))), PAIR, 'seat 空白、provider null')
            assert.equal(msgOf(() => makeProduced(single({ seat: null, provider: 5 }))), PAIR, 'seat null、provider 數字')
        })

        it('null 不放寬其他情形:seat 與 provider 皆缺省(未明給 null)仍依原訊息拒;未知鍵、缺 pkg 等照舊(必須明給 null,以免漏接而靜默無值)', () => {
            assert.equal(msgOf(() => makeProduced(single({ seat: undefined, provider: undefined }))), 'invalid o.seat: must be a non-empty string')
            assert.equal(msgOf(() => makeProduced(single({ seat: null, provider: null, pkg: undefined }))), MSG_PKG)
            assert.equal(msgOf(() => makeProduced({ ...single({ seat: null, provider: null }), extra: 1 })), 'invalid o.extra: unknown key')
        })

        it('多步產出不受影響:steps 內之 provider 仍須非空字串(null 即拒);頂層 seat／provider 仍不得與 steps 並給', () => {
            assert.equal(msgOf(() => makeProduced(multi({ steps: [{ role: 'draft', seat: 1, provider: null }] }))), 'invalid o.steps[0].provider: must be a non-empty string')
            assert.equal(msgOf(() => makeProduced(multi({ seat: 'demo.ai' }))), 'invalid o.seat: must not be given together with o.steps')
        })

        it('appendProduced 同一檢核:null／null 之 produced 可追加並進歷史;只其一為 null 之手拼物件拒收(訊息名為 produced.seat and produced.provider)', () => {
            const p = makeProduced(single({ seat: null, provider: null, promptFp: undefined }))
            const r = appendProduced({}, p)
            assert.deepEqual(r.produced, p)
            assert.deepEqual(r.producedHistory, [p])
            const again = appendProduced({ producedHistory: r.producedHistory, producedHistoryDropped: 0 }, p)
            assert.equal(again.producedHistory.length, 2, '改寫後歷史長度 +1(規格 §7 驗收②)')
            assert.equal(msgOf(() => appendProduced({}, { ...p, seat: 'demo.ai' })), 'invalid produced.seat and produced.provider: must be both non-empty strings or both null')
            assert.equal(msgOf(() => appendProduced({}, { ...p, provider: 'a:b' })), 'invalid produced.seat and produced.provider: must be both non-empty strings or both null')
        })
    })

    describe('appendProduced', function() {

        const P1 = makeProduced(single({ stamp: '20261108100000', at: '2026-11-08T10:00:00+08:00' }))
        const P2 = makeProduced(single({ stamp: '20261108110000', at: '2026-11-08T11:00:00+08:00', provider: 'claude:sonnet' }))

        /** 產生 n 筆歷史(stamp 末兩碼為序號,以辨別捨去的是最舊者) */
        const historyOf = (n) => Array.from({ length: n }, (_, i) => makeProduced(single({ stamp: `202611081000${String(i).padStart(2, '0')}`, at: '2026-11-08T10:00:00+08:00' })))

        it('新記錄({}):producedHistory 為 [produced]、producedHistoryDropped 為 0;回傳恰三鍵(規格 §5.2)', () => {
            const r = appendProduced({}, P1)
            assert.deepEqual(Object.keys(r), ['produced', 'producedHistory', 'producedHistoryDropped'])
            assert.deepEqual(r.produced, P1)
            assert.deepEqual(r.producedHistory, [P1])
            assert.equal(r.producedHistoryDropped, 0)
        })

        it('每次寫入追加一筆(規格 §2.3):舊→新排列,produced 為最後一筆;長度 +1', () => {
            const r1 = appendProduced({}, P1)
            const r2 = appendProduced({ producedHistory: r1.producedHistory, producedHistoryDropped: r1.producedHistoryDropped }, P2)
            assert.equal(r2.producedHistory.length, 2, '規格 §7 驗收②:改寫後 producedHistory 長度 +1')
            assert.deepEqual(r2.producedHistory, [P1, P2])
            assert.deepEqual(r2.produced, P2)
            assert.deepEqual(r2.produced, r2.producedHistory.at(-1), '規格 §2.3:produced 與 producedHistory 最末相同')
            assert.notEqual(r2.produced, r2.producedHistory.at(-1), '值相同但不共用同一物件(改一不牽動另一)')
        })

        it('上限預設 50:剛滿 50 不捨去;51 筆時捨去最舊 1 筆並累計 producedHistoryDropped(規格 §2.3)', () => {
            const at49 = appendProduced({ producedHistory: historyOf(49) }, P2)
            assert.equal(at49.producedHistory.length, 50)
            assert.equal(at49.producedHistoryDropped, 0, '49+1=50 未超出')
            const full = historyOf(50)
            const over = appendProduced({ producedHistory: full, producedHistoryDropped: 0 }, P2)
            assert.equal(over.producedHistory.length, 50)
            assert.equal(over.producedHistoryDropped, 1)
            assert.equal(over.producedHistory[0].stamp, full[1].stamp, '最舊者(序號 00)被捨去,原第二筆成為最舊')
            assert.deepEqual(over.producedHistory.at(-1), P2)
            const again = appendProduced({ producedHistory: over.producedHistory, producedHistoryDropped: over.producedHistoryDropped }, P1)
            assert.equal(again.producedHistoryDropped, 2, '捨去數跨寫入累計')
            assert.equal(again.producedHistory.length, 50)
        })

        it('max 可調:舊 5 筆、max 3 → 追加後捨去 3 筆、保留最近 3 筆;既有捨去數累加', () => {
            const h = historyOf(5)
            const r = appendProduced({ producedHistory: h, producedHistoryDropped: 4 }, P2, { max: 3 })
            assert.equal(r.producedHistory.length, 3)
            assert.equal(r.producedHistoryDropped, 4 + 3)
            assert.deepEqual(r.producedHistory.map((x) => x.stamp), [h[3].stamp, h[4].stamp, P2.stamp], '保留最近 3 筆(舊 5 筆中最舊 3 筆被捨去前,再加新的 1 筆共 6,取後 3)')
            assert.equal(appendProduced({ producedHistory: h }, P2, { max: '3' }).producedHistory.length, 3, 'max 可給數字字串(N2,K7)')
        })

        it('opt 非預期輸入視為未給、改用預設 50(輸入參數檢測機制 K3):max 為 0、負、小數、非數字、opt 為 null／字串皆不拋錯', () => {
            const h = historyOf(60)
            for (const opt of [undefined, null, 'x', 5, [], {}, { max: 0 }, { max: -1 }, { max: 1.5 }, { max: 'x' }, { max: null }, { max: true }]) {
                const r = appendProduced({ producedHistory: h }, P2, opt)
                assert.equal(r.producedHistory.length, 50, JSON.stringify(opt))
                assert.equal(r.producedHistoryDropped, 11, JSON.stringify(opt))
            }
        })

        it('不改輸入、不共享參考:rec 與 produced 深度凍結後仍可呼叫;回傳之陣列與元素皆為新物件(規格 §5.2)', () => {
            const rec = deepFreeze({ producedHistory: historyOf(3), producedHistoryDropped: 1, other: { keep: true } })
            const p = deepFreeze(copy(P2))
            const r = appendProduced(rec, p)
            assert.notEqual(r.producedHistory, rec.producedHistory)
            assert.notEqual(r.producedHistory[0], rec.producedHistory[0])
            assert.notEqual(r.produced, p)
            assert.equal(rec.producedHistory.length, 3)
            assert.equal(rec.producedHistoryDropped, 1)
            r.producedHistory[0].stage = 'changed'
            assert.equal(rec.producedHistory[0].stage, 'note-write')
            assert.ok(!('other' in r), '只回傳產出鏈三欄,記錄其餘欄位由呼叫端自行合併')
        })

        it('produced 之正規化:鍵序同 makeProduced;未經 makeProduced 之手拼物件須合 §2 結構(缺 at 亦拒——appendProduced 不代填時間)', () => {
            const hand = { at: P2.at, pkg: P2.pkg, promptFp: P2.promptFp, provider: P2.provider, seat: P2.seat, stage: P2.stage, stamp: P2.stamp, v: 1 }
            const r = appendProduced({}, hand)
            assert.deepEqual(Object.keys(r.produced), Object.keys(P2))
            assert.equal(msgOf(() => appendProduced({}, { ...hand, at: undefined })), 'invalid produced.at: must be a local-time ISO string YYYY-MM-DDTHH:mm:ss±hh:mm')
            assert.equal(msgOf(() => appendProduced({}, { ...hand, extra: 1 })), 'invalid produced.extra: unknown key')
            assert.equal(msgOf(() => appendProduced({}, { ...hand, v: undefined })), 'invalid produced.v: must be 1', '已組出之 produced 須帶 v')
            assert.equal(msgOf(() => appendProduced({}, null)), 'invalid produced: must be a plain object')
        })

        it('反例(訊息全文):rec 非物件、producedHistory 非陣列或含非物件元素、producedHistoryDropped 非非負整數', () => {
            for (const bad of [undefined, null, [], 'x', 5]) assert.equal(msgOf(() => appendProduced(bad, P1)), 'invalid rec: must be a plain object', JSON.stringify(bad))
            assert.equal(msgOf(() => appendProduced({ producedHistory: 'x' }, P1)), 'invalid rec.producedHistory: must be an array')
            assert.equal(msgOf(() => appendProduced({ producedHistory: [P1, 5] }, P1)), 'invalid rec.producedHistory[1]: must be a plain object')
            assert.equal(msgOf(() => appendProduced({ producedHistoryDropped: -1 }, P1)), 'invalid rec.producedHistoryDropped: must be a non-negative integer')
            assert.equal(msgOf(() => appendProduced({ producedHistoryDropped: 'x' }, P1)), 'invalid rec.producedHistoryDropped: must be a non-negative integer')
        })

        it('既有歷史各筆於寫入當時已檢核,追加時只要求為一般物件、原樣保留(不因舊筆之欄位變動而卡住新的寫入)', () => {
            const odd = { v: 1, stage: 'note-write', future: 'x' }
            const r = appendProduced({ producedHistory: [odd] }, P1)
            assert.deepEqual(r.producedHistory[0], odd)
            assert.notEqual(r.producedHistory[0], odd)
        })

        it('舊記錄不回填(規格 §2.3):無 produced 之記錄追加時從頭起算,不憑空補歷史;producedHistory 為 null 視為未給', () => {
            const r = appendProduced({ title: '舊筆記' }, P1)
            assert.deepEqual(r.producedHistory, [P1])
            assert.deepEqual(appendProduced({ producedHistory: null, producedHistoryDropped: null }, P1).producedHistory, [P1])
        })

        it('多步產出可追加(steps 形狀經同一檢核)', () => {
            const m = makeProduced(multi())
            const r = appendProduced({}, m)
            assert.deepEqual(r.produced, m)
            assert.deepEqual(r.producedHistory, [m])
        })
    })

    describe('pkgIdOf', function() {

        /**
         * 在 root 下建一個含 package.json 之資料夾與其下之 file URL
         *
         * @param {String} name 輸入資料夾名(可含空白與中文)
         * @param {Object|String|null} pkg 輸入 package.json 內容(物件、原文字串;null 為不建)
         * @param {String} [sub='sub'] 輸入模組所在之子資料夾
         * @returns {Object} 回傳 { dir, url, pkgFile }
         */
        const fixture = (name, pkg, sub = 'sub') => {
            const dir = path.join(root, name)
            fs.mkdirSync(path.join(dir, sub), { recursive: true })
            const pkgFile = path.join(dir, 'package.json')
            if (pkg !== null) fs.writeFileSync(pkgFile, typeof pkg === 'string' ? pkg : JSON.stringify(pkg), 'utf8')
            return { dir, pkgFile, url: pathToFileURL(path.join(dir, sub, 'x.mjs')).href }
        }

        it('本套件:自測試檔與自 src 模組位置皆回 w-knowledge-capture@<package.json 之版本>(規格 §5.3)', () => {
            const want = `${PKG_JSON.name}@${PKG_JSON.version}`
            assert.equal(PKG_JSON.name, 'w-knowledge-capture')
            assert.equal(pkgIdOf(import.meta.url), want)
            assert.equal(pkgIdOf(pathToFileURL(path.join(PKG_ROOT, 'src', 'core', 'ops', 'provenance.mjs')).href), want)
            assert.match(pkgIdOf(import.meta.url), /^w-knowledge-capture@\d+\.\d+\.\d+/)
        })

        it('取最近之 package.json:子套件(巢狀)優先於外層', () => {
            const outer = fixture('nest-outer', { name: 'outer-pkg', version: '1.0.0' }, 'inner/deep')
            fs.writeFileSync(path.join(outer.dir, 'inner', 'package.json'), JSON.stringify({ name: '@scope/inner-pkg', version: '2.3.4' }), 'utf8')
            assert.equal(pkgIdOf(outer.url), '@scope/inner-pkg@2.3.4', '帶 scope 之套件名原樣')
        })

        it('最近之 package.json 若只是範圍標記(無 name 或無 version,如 { "type": "module" })則略過、續往上找', () => {
            const f = fixture('skip-scope', { name: 'real-pkg', version: '0.0.7' }, 'lib/deep')
            fs.writeFileSync(path.join(f.dir, 'lib', 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
            fs.writeFileSync(path.join(f.dir, 'lib', 'deep', 'package.json'), JSON.stringify({ name: 'no-version' }), 'utf8')
            assert.equal(pkgIdOf(f.url), 'real-pkg@0.0.7')
        })

        it('最近之 package.json 無法解析(壞 JSON):回 null,不上溯至外層(寧缺勿錯,以免記成別的套件)', () => {
            const f = fixture('bad-json', { name: 'outer-ok', version: '1.0.0' }, 'inner')
            fs.writeFileSync(path.join(f.dir, 'inner', 'package.json'), '{ not json', 'utf8')
            assert.equal(pkgIdOf(pathToFileURL(path.join(f.dir, 'inner', 'y.mjs')).href), null)
        })

        it('路徑以 fileURLToPath 解析:資料夾名含空白與中文(URL 內被編碼)仍找得到', () => {
            const f = fixture('含 空格與中文-pkg', { name: 'zh-pkg', version: '3.2.1' })
            assert.match(f.url, /%20|%E/, '前提:URL 內含編碼')
            assert.equal(pkgIdOf(f.url), 'zh-pkg@3.2.1')
        })

        it('結果快取:同一套件改了 package.json 後再問,仍回快取值(行程內不重讀);位於其子資料夾之另一模組亦同', () => {
            const f = fixture('cached', { name: 'cache-pkg', version: '1.0.0' })
            assert.equal(pkgIdOf(f.url), 'cache-pkg@1.0.0')
            fs.writeFileSync(f.pkgFile, JSON.stringify({ name: 'cache-pkg', version: '9.9.9' }), 'utf8')
            assert.equal(pkgIdOf(f.url), 'cache-pkg@1.0.0', '同一位置:快取')
            fs.mkdirSync(path.join(f.dir, 'sub', 'more'), { recursive: true })
            assert.equal(pkgIdOf(pathToFileURL(path.join(f.dir, 'sub', 'more', 'z.mjs')).href), 'cache-pkg@1.0.0', '子資料夾:沿用上層之快取')
            assert.equal(pkgIdOf(f.url), pkgIdOf(f.url))
        })

        it('找不到:位置之祖先皆無 package.json → null(不拋錯);「找不到」亦被快取', () => {
            const driveRoot = path.parse(PKG_ROOT).root
            assert.equal(fs.existsSync(path.join(driveRoot, 'package.json')), false, `前提:${driveRoot} 無 package.json`)
            const url = pathToFileURL(path.join(driveRoot, 'kc363-no-such-dir', 'x.mjs')).href
            assert.equal(pkgIdOf(url), null)
            assert.equal(pkgIdOf(url), null)
        })

        it('非 file: 之 URL(瀏覽器載入之 UMD、http 位置)取不到磁碟位置:回 null,不拋錯', () => {
            assert.equal(pkgIdOf('https://example.com/dist/w-x.umd.js'), null)
            assert.equal(pkgIdOf('http://localhost:8080/a/b.js'), null)
        })

        it('必須參數無效即拋(V19):未給、空字串、非字串、非 URL 之字串、誤給 Windows 路徑', () => {
            const MSG = 'invalid importMetaUrl: must be a URL string (import.meta.url)'
            for (const bad of [undefined, null, '', '   ', 5, {}, [], 'not a url', 'C:\\x\\y.mjs', 'D:/x/y.mjs']) {
                assert.equal(msgOf(() => pkgIdOf(bad)), MSG, JSON.stringify(bad))
            }
        })
    })
})
