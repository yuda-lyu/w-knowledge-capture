// unit-capture-openalex-keys.test.mjs — OpenAlex 多把金鑰(CAP-16 之延伸):apiKeyEnv 之值可為逗號分隔多把;429 切下一把、401／403 標記該把無效並切下一把;
//   全部無效時回 401／403 結果(指明金鑰無效、不計入 429 連續計數、不退回不帶金鑰);5xx／curl 錯誤同把重試;併發 429 不連跳多把;遮罩涵蓋全部把。
// 網路:不連外網。請求一律以注入之假抓取函數(依網址上之 api_key 回應)或本機死埠(真 curl 之連線失敗訊息遮罩);等待以注入值歸零(retryWaitMs:0),
//   「換把不等待」以大等待值＋看門狗證明(完成即得,不以固定延時偵測)。
//
// 案號即本檔規格之編號:
//   OA10 金鑰讀取:逗號分隔 → 陣列(拆、trim、去空、去重);單把長度 1;無金鑰 []
//   OA11 載體形狀:只收陣列(字串等舊形狀拋 TypeError 且不回顯值);舊形狀物件不被 openAlexAuthOf 採用
//   OA12 openAlexGet 換把:429 換把(不等待、記住當前把)、皆 429 才算 429、401／403 標記無效(WARN 一次、不印值)、全部無效、5xx／curl 錯誤不換把、
//        併發不連跳、maxRetries 併用之呼叫次數上限
//   OA13 遮罩涵蓋全部把:mask、JSON／inspect／展開、curl 失敗訊息(真 curl)、拋錯、WARN 與無效結果
//   OA14 三處站點接線:網格、領域驗證、原文回溯(換把、無效 WARN 走各站點既有日誌、全部無效不計入 429 連續計數)
//   OA15 日誌契約:無效金鑰之 WARN 為「須見」字樣且非已知常態
// 執行:自套件根 node <mocha> --timeout 180000 test/unit-capture-openalex-keys.test.mjs(暫存 test/_tmp/openalex-keys-*-<pid>,測完即刪)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import util from 'node:util'
import fetchWebByCurl from 'w-fetch-web/src/fetchWebByCurl.mjs'
import { memStore } from './tools/memStore.mjs'
import { settingsOf, tmpRoot, removeRoots, recLog } from './tools/captureTestKit.mjs'
import { genClockTZ } from '../src/core/runnerPackage.mjs'
import { createDefaultFetchers } from '../src/fetchers/defaultFetchers.mjs'
import {
    OPENALEX_QUOTA_MESSAGE, openAlexApiKeyOf, createOpenAlexAuth, openAlexAuthOf, NO_OPENALEX_AUTH, isOpenAlexQuota, openAlexGet,
} from '../src/fetchers/openAlexNet.mjs'
import { httpCodeOf } from '../src/stores/fetchPolicy.mjs'
import { validateAreaQuery } from '../src/stages/areaStage.mjs'
import { createCaptureRuntime } from '../src/captureRuntime.mjs'
import { refetchSources, REFETCH_LEDGER_FILE } from '../src/ops/refetchSources.mjs'
import { CAPTURE_LOG_KNOWN, CAPTURE_LOG_MUST_SEE } from '../src/logContract.mjs'

const DEAD = 'http://127.0.0.1:8830' // 無人監聽之死埠(連線即被拒;他檔亦只連不聽)
const U = 'https://x.test/works?search=a'
const ENV = 'OPENALEX_API_KEY'
// 含需 URL 編碼之字元(+ / =):編碼形式與原形都不得出現在任何輸出
const KA = 'kaTest+Key/1f=AAA-secret'
const KB = 'kbTest+Key/2e=BBB-secret'
const KC = 'kcTest+Key/3d=CCC-secret'
const clock = genClockTZ('Asia/Taipei')
const AT = '2026-09-01T00:00:00+08:00'
const pad = (n) => String(n).padStart(3, '0')
const words = (n, tag) => Array.from({ length: n }, (_, k) => `${tag}word${k}`)
const inv = (ws) => Object.fromEntries(ws.map((w, k) => [w, [k]]))

const ok = { status: 'success', html: '{"results":[]}', httpCode: 200 }
const fail = (httpCode, extra = {}) => ({ status: 'error', httpCode, reason: 'http-error', message: `HTTP ${httpCode}`, ...extra })
const keyOf = (u) => new URL(u).searchParams.get('api_key')
const noSecret = (text) => [KA, KB, KC].every((k) => !String(text).includes(k) && !String(text).includes(encodeURIComponent(k)))

/** 假抓取函數:依網址上之 api_key 回應;respond(key, nthCallOfThisKey, nthCallOverall) → 結果。calls 依序記所用之把 */
function fakeSite(respond) {
    const calls = []
    const perKey = new Map()
    const f = async (u) => {
        const k = keyOf(u)
        const n = perKey.get(k) ?? 0
        perKey.set(k, n + 1)
        calls.push(k)
        return respond(k, n, calls.length - 1)
    }
    return { f, calls }
}

/** 看門狗:ms 內未完成即失敗(證明「換把不等待」:等待值給極大,若等待則逾此限) */
const settles = (p, ms = 3000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`未在 ${ms}ms 內完成(疑有等待)`)), ms).unref())])

/** 吞下 fn 期間所有 stderr 輸出並回傳 */
async function withStderr(fn) {
    const errs = []
    const orig = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk) => {
        errs.push(String(chunk))
        return true
    }
    try {
        return { value: await fn(), stderr: errs.join('') }
    }
    finally {
        process.stderr.write = orig
    }
}

const mk = (keys, opt = {}) => createOpenAlexAuth(keys, { retryWaitMs: 0, envName: ENV, ...opt })
const warnsOf = (log) => log.lines.filter((l) => l.startsWith('WARN OpenAlex 金鑰無效'))

describe('unit-capture-openalex-keys', function() {

    const roots = []
    const rootOf = (name) => {
        const r = tmpRoot(name)
        roots.push(r)
        return r
    }
    let TMP = ''
    let ENVF = ''
    before(() => {
        TMP = rootOf('openalex-keys')
        ENVF = `${TMP}/keys.env`
        fs.writeFileSync(ENVF, [
            'OA_TWO=ka,kb',
            'OA_SPACED=ka, kb ,',
            'OA_DUP=ka,ka,kb,ka',
            'OA_EMPTYISH= , ,',
            'OA_QUOTED="ka,kb"',
            'OA_QUOTED2="ka","kb"',
            "OA_SQ='ka', 'kb'",
            `OA_PLUS=${KA},${KB}`,
            'OA_ONE=only',
            `${ENV}=ka,kb`,
            '',
        ].join('\n'))
    })
    after(() => removeRoots(roots))

    // ══════════════════════════ OA10 金鑰讀取 ══════════════════════════
    describe('OA10 金鑰讀取(逗號分隔多把)', function() {
        const cap = (name) => ({ services: { openAlex: { apiKeyEnv: name } } })
        it('值 a,b → [a,b];a, b , → 拆逗號並 trim 去空;a,a,b,a → 去重保序;全空 → [];成對引號內之逗號亦拆;含 + / = 之值原樣保留;單把長度 1', () => {
            assert.deepEqual(openAlexApiKeyOf(cap('OA_TWO'), ENVF), ['ka', 'kb'])
            assert.deepEqual(openAlexApiKeyOf(cap('OA_SPACED'), ENVF), ['ka', 'kb'])
            assert.deepEqual(openAlexApiKeyOf(cap('OA_DUP'), ENVF), ['ka', 'kb'], '去重保序(首見者在前)')
            assert.deepEqual(openAlexApiKeyOf(cap('OA_EMPTYISH'), ENVF), [], '只有逗號與空白 → 不帶金鑰')
            assert.deepEqual(openAlexApiKeyOf(cap('OA_QUOTED'), ENVF), ['ka', 'kb'])
            assert.deepEqual(openAlexApiKeyOf(cap('OA_QUOTED2'), ENVF), ['ka', 'kb'], '逐項各自加引號(readEnvFile 只剝最外層一對):逐項再剝,不得留下 ka" 與 "kb')
            assert.deepEqual(openAlexApiKeyOf(cap('OA_SQ'), ENVF), ['ka', 'kb'], '單引號亦同')
            assert.deepEqual(openAlexApiKeyOf(cap('OA_PLUS'), ENVF), [KA, KB])
            assert.deepEqual(openAlexApiKeyOf(cap('OA_ONE'), ENVF), ['only'])
            assert.deepEqual(openAlexApiKeyOf(cap('NOT_THERE'), ENVF), [])
            assert.ok(Array.isArray(openAlexApiKeyOf(cap(''), ENVF)) && openAlexApiKeyOf(cap(''), ENVF).length === 0, "apiKeyEnv '' → []")
        })
    })

    // ══════════════════════════ OA11 載體形狀 ══════════════════════════
    describe('OA11 載體形狀', function() {
        it('createOpenAlexAuth 只收陣列(或 null／undefined＝不帶);字串、數字、物件等舊形狀拋 TypeError,訊息不回顯所收到之值', () => {
            for (const bad of ['secret-key-in-string', 'a,b', 5, { k: 'secret-key-in-object' }, true]) {
                assert.throws(() => createOpenAlexAuth(bad), (e) => e instanceof TypeError && !String(e.message).includes('secret-key') && !String(e.message).includes('a,b'), `舊形狀 ${typeof bad} 須拋錯`)
            }
            for (const none of [[], [''], ['  ', ''], [null, 5, undefined], null, undefined]) assert.equal(createOpenAlexAuth(none).enabled, false, JSON.stringify(none))
            assert.equal(createOpenAlexAuth(['k']).enabled, true)
        })
        it('openAlexAuthOf:只認新形狀之載體;自稱有金鑰(enabled:true、有 sign／mask)卻缺換把方法之舊形狀物件拋 TypeError(不靜默降級為不帶金鑰);其餘不合形狀者視同未給', () => {
            const a = mk(['ka'])
            assert.equal(openAlexAuthOf(a), a)
            assert.throws(() => openAlexAuthOf({ enabled: true, sign: (u) => u, mask: (t) => t }), (e) => e instanceof TypeError)
            assert.throws(() => openAlexAuthOf({ enabled: true, sign: (u) => u, mask: (t) => t, cursor: () => 0 }), TypeError, '缺任一方法皆拋')
            assert.equal(openAlexAuthOf({ enabled: true }), NO_OPENALEX_AUTH, '連 sign／mask 都沒有者非載體,視同未給')
            const off = { enabled: false, sign: (u) => u, mask: (t) => t }
            assert.equal(openAlexAuthOf(off), off, '明示不帶金鑰(enabled:false)之載體原樣可用,不要求換把方法')
            assert.equal(openAlexAuthOf(undefined), NO_OPENALEX_AUTH)
            assert.equal(openAlexAuthOf(5), NO_OPENALEX_AUTH)
            assert.equal(openAlexAuthOf(NO_OPENALEX_AUTH), NO_OPENALEX_AUTH)
        })
        it('陣列內之空白、空字串、非字串略過;重複去除;順序保留(經行為證明:首把為 ka)', async () => {
            const { f, calls } = fakeSite(() => ok)
            await openAlexGet(f, U, { auth: mk([' ka ', '', 'ka', null, 'kb']) })
            assert.deepEqual(calls, ['ka'])
            const s2 = fakeSite((k) => (k === 'ka' ? fail(429) : ok))
            await openAlexGet(s2.f, U, { auth: mk([' ka ', 'ka', '', 'kb']) })
            assert.deepEqual(s2.calls, ['ka', 'kb'], 'ka 重複只算一把:429 後下一把是 kb,不是第二個 ka')
        })
    })

    // ══════════════════════════ OA12 openAlexGet 換把 ══════════════════════════
    describe('OA12 openAlexGet 換把', function() {
        it('429 換把:ka 回 429、kb 回 200 → 成功且用到 kb;換把不等待(等待值給極大仍即刻完成);下一請求直接用 kb(不再先試 ka)', async () => {
            const auth = mk([KA, KB], { retryWaitMs: 600_000 })
            const { f, calls } = fakeSite((k) => (k === KA ? fail(429) : ok))
            const r = await settles(openAlexGet(f, U, { auth, maxRetries: 1 }))
            assert.equal(r.status, 'success')
            assert.deepEqual(calls, [KA, KB], '先 ka(429)後立即 kb')
            await settles(openAlexGet(f, U, { auth, maxRetries: 1 }))
            assert.deepEqual(calls, [KA, KB, KB], '記住當前把:第二個請求直接 kb')
        })
        it('皆 429 才算 429:兩把各試一次後回 429(固定訊息、quota:true)、isOpenAlexQuota 為真;計入連續計數之標記與單把相同', async () => {
            const auth = mk([KA, KB])
            const { f, calls } = fakeSite(() => fail(429))
            const r = await openAlexGet(f, U, { auth, maxRetries: 0 })
            assert.deepEqual(calls, [KA, KB], '每把一輪一次')
            assert.deepEqual([r.status, r.httpCode, r.message, r.quota, isOpenAlexQuota(r)], ['error', 429, OPENALEX_QUOTA_MESSAGE, true, true])
            assert.equal(r.invalidKey, undefined)
        })
        it('單把:429 只同把重試(行為同改前);呼叫次數 = maxRetries＋1', async () => {
            const auth = mk([KA])
            const { f, calls } = fakeSite(() => fail(429))
            const r = await openAlexGet(f, U, { auth, maxRetries: 2 })
            assert.deepEqual(calls, [KA, KA, KA])
            assert.equal(r.quota, true)
        })
        it('maxRetries 併用:三把皆 429、maxRetries:2 → 呼叫次數恰為 (2＋1)×3 = 9,每輪順序 ka,kb,kc 輪替;輪與輪之間才等待', async () => {
            const auth = mk([KA, KB, KC])
            const { f, calls } = fakeSite(() => fail(429))
            const r = await openAlexGet(f, U, { auth, maxRetries: 2 })
            assert.equal(calls.length, 9)
            assert.deepEqual(calls, [KA, KB, KC, KA, KB, KC, KA, KB, KC])
            assert.equal(r.quota, true)
            // 輪與輪之間須等待:等待值給 2 秒、看門狗 300ms,第一輪結束後即卡在等待(看門狗逾時),證明有走既有之等待
            //   (等待值不給極大:未結束之計時器會拖住測試行程;2 秒後背景續跑之請求不再被斷言)
            const slow = mk([KA, KB], { retryWaitMs: 2000 })
            const s2 = fakeSite(() => fail(429))
            await assert.rejects(() => settles(openAlexGet(s2.f, U, { auth: slow, maxRetries: 1 }), 300), /疑有等待/)
            assert.deepEqual(s2.calls, [KA, KB], '第一輪兩把用畢後才等待')
        })
        it('第一輪 ka 429、kb 成功 → 不進入下一輪;之後 kb 429、ka 成功(換回):輪替循環', async () => {
            const auth = mk([KA, KB])
            let phase = 1
            const { f, calls } = fakeSite((k) => (phase === 1 ? (k === KA ? fail(429) : ok) : (k === KB ? fail(429) : ok)))
            await openAlexGet(f, U, { auth })
            phase = 2
            const r = await openAlexGet(f, U, { auth })
            assert.equal(r.status, 'success')
            assert.deepEqual(calls, [KA, KB, KB, KA])
        })
        it('401 且帶金鑰:該把標記無效、立即切下一把;WARN 一次(寫明變數名、狀態碼、第幾把,不印值);之後不再使用該把', async () => {
            const auth = mk([KA, KB])
            const log = recLog()
            const { f, calls } = fakeSite((k) => (k === KA ? fail(401) : ok))
            const r = await settles(openAlexGet(f, U, { auth, log, maxRetries: 1 }))
            assert.equal(r.status, 'success')
            assert.deepEqual(calls, [KA, KB])
            const w = warnsOf(log)
            assert.equal(w.length, 1, log.lines.join('\n'))
            assert.match(w[0], /^WARN OpenAlex 金鑰無效（狀態碼 401）：OPENALEX_API_KEY 之第 1／2 把/)
            assert.ok(noSecret(log.lines.join('\n')))
            // 之後多次請求:不再碰 ka、不再 WARN
            await openAlexGet(f, U, { auth, log })
            await openAlexGet(f, U, { auth, log })
            assert.deepEqual(calls, [KA, KB, KB, KB])
            assert.equal(warnsOf(log).length, 1, '同一把只 WARN 一次')
            assert.equal(r.invalidKey, undefined, '成功結果不帶無效標記')
        })
        it('403 同 401(狀態碼寫入 WARN);其他 4xx(404)不換把、不標記、不重試', async () => {
            const log = recLog()
            const a403 = mk([KA, KB])
            const s403 = fakeSite((k) => (k === KA ? fail(403) : ok))
            assert.equal((await openAlexGet(s403.f, U, { auth: a403, log })).status, 'success')
            assert.deepEqual(s403.calls, [KA, KB])
            assert.match(warnsOf(log)[0], /狀態碼 403/)
            const a404 = mk([KA, KB])
            const s404 = fakeSite(() => fail(404))
            const r = await openAlexGet(s404.f, U, { auth: a404, maxRetries: 2 })
            assert.deepEqual([r.httpCode, r.message, s404.calls], [404, 'HTTP 404', [KA]], '404:一次、原訊息、不換把')
        })
        it('全部無效:回 401 結果(指明金鑰無效、含變數名與把數)、invalidKey:true、不標 quota、httpCodeOf 判得 401;每把各 WARN 一次;之後請求不送出網路請求、不再 WARN、不退回不帶金鑰', async () => {
            const auth = mk([KA, KB])
            const log = recLog()
            const { f, calls } = fakeSite(() => fail(401))
            const r = await openAlexGet(f, U, { auth, log, maxRetries: 3 })
            assert.deepEqual(calls, [KA, KB], '每把一次;401 不重試')
            assert.deepEqual([r.status, r.httpCode, r.reason, r.invalidKey, r.quota, isOpenAlexQuota(r)], ['error', 401, 'http-error', true, undefined, false])
            assert.match(r.message, /^狀態碼 401：OpenAlex 金鑰無效（OPENALEX_API_KEY 之全部 2 把皆不被接受/)
            assert.equal(httpCodeOf(r), 401, '狀態碼在 httpCode 欄')
            assert.equal(httpCodeOf({ message: r.message }), 0, '訊息不含「HTTP 401」:合成之結果不讓下游由訊息推得「有 HTTP 回應＝網路通」(組合訊息由另一供應商之原因決定)')
            assert.ok(!r.message.includes(OPENALEX_QUOTA_MESSAGE) && !/429/.test(r.message), '不得被誤報為額度用盡')
            const w = warnsOf(log)
            assert.equal(w.length, 2)
            assert.match(w[0], /第 1／2 把/)
            assert.match(w[1], /第 2／2 把/)
            assert.match(w[1], /已無可用金鑰/)
            assert.ok(noSecret(JSON.stringify(r)) && noSecret(log.lines.join('\n')))
            const before = calls.length
            const r2 = await settles(openAlexGet(f, U, { auth, log, maxRetries: 3 }))
            assert.equal(calls.length, before, '全部無效後不再送出請求(也不退回不帶金鑰)')
            assert.deepEqual([r2.status, r2.httpCode, r2.invalidKey], ['error', 401, true])
            assert.equal(warnsOf(log).length, 2, '不重複 WARN')
        })
        it('單把 401:結果為無效金鑰(非 429)、一次請求、WARN 一次;接受 403 與 401 混合(以最後一次標記之碼為準)', async () => {
            const log = recLog()
            const auth = mk([KA])
            const { f, calls } = fakeSite(() => fail(401))
            const r = await openAlexGet(f, U, { auth, log })
            assert.deepEqual([calls, r.httpCode, r.invalidKey, r.quota], [[KA], 401, true, undefined])
            assert.match(r.message, /全部 1 把皆不被接受/)
            const mix = mk([KA, KB])
            const s = fakeSite((k) => (k === KA ? fail(403) : fail(401)))
            const r2 = await openAlexGet(s.f, U, { auth: mix })
            assert.deepEqual([r2.httpCode, r2.invalidKey], [401, true])
        })
        it('混合:ka 401、kb 429 → 回 429(尚有可用之把但皆 429:額度,非無效);呼叫 ka、kb 各一次;kb 仍可用', async () => {
            const auth = mk([KA, KB])
            const { f, calls } = fakeSite((k) => (k === KA ? fail(401) : fail(429)))
            const r = await openAlexGet(f, U, { auth, maxRetries: 0 })
            assert.deepEqual(calls, [KA, KB])
            assert.deepEqual([r.quota, r.invalidKey, r.httpCode], [true, undefined, 429])
            // 三把:ka 401 → kb 429 → kc 429 → 回 429
            const a3 = mk([KA, KB, KC])
            const s3 = fakeSite((k) => (k === KA ? fail(401) : fail(429)))
            const r3 = await openAlexGet(s3.f, U, { auth: a3 })
            assert.deepEqual([s3.calls, r3.quota], [[KA, KB, KC], true])
        })
        it('5xx 與 curl 錯誤:同把重試、不換把、不標記無效', async () => {
            for (const bad of [fail(503), { status: 'error', reason: 'curl-error', message: 'curl: (7) Failed to connect' }]) {
                const auth = mk([KA, KB])
                const { f, calls } = fakeSite((k, n) => (n === 0 ? bad : ok))
                const r = await openAlexGet(f, U, { auth, maxRetries: 1 })
                assert.equal(r.status, 'success')
                assert.deepEqual(calls, [KA, KA], `${bad.reason}:同把重試`)
            }
            const auth = mk([KA, KB])
            const { f, calls } = fakeSite(() => fail(500))
            await openAlexGet(f, U, { auth, maxRetries: 2 })
            assert.deepEqual(calls, [KA, KA, KA], '5xx 持續:只打 ka,共 maxRetries＋1 次')
        })
        it('同一輪內 429 後遇 5xx:同把(新的當前把)重試,不再換把', async () => {
            const auth = mk([KA, KB])
            const { f, calls } = fakeSite((k, n) => (k === KA ? fail(429) : (n === 0 ? fail(503) : ok)))
            const r = await openAlexGet(f, U, { auth, maxRetries: 1 })
            assert.equal(r.status, 'success')
            assert.deepEqual(calls, [KA, KB, KB])
        })
        it('併發:兩個請求同時以 ka 送出且同時收到 429 → 只換一把(ka→kb),不連跳到 kc;兩者皆以 kb 完成;之後的請求用 kb', async () => {
            const auth = mk([KA, KB, KC])
            const calls = []
            let arrived = 0
            let release
            const gate = new Promise((r) => { release = r })
            const f = async (u) => {
                const k = keyOf(u)
                calls.push(k)
                if (k === KA && arrived < 2) {
                    arrived++
                    if (arrived === 2) release()
                    await gate
                    return fail(429)
                }
                return k === KB ? ok : fail(500)
            }
            const [r1, r2] = await settles(Promise.all([openAlexGet(f, U, { auth }), openAlexGet(f, U, { auth })]))
            assert.deepEqual([r1.status, r2.status], ['success', 'success'])
            assert.deepEqual(calls, [KA, KA, KB, KB], `未使用 kc:${calls.map((k) => k.slice(0, 2)).join(',')}`)
            await openAlexGet(f, U, { auth })
            assert.equal(calls.at(-1), KB)
            assert.equal(calls.length, 5)
        })
        it('併發:兩個請求同時以 ka 送出且同時收到 401 → WARN 一次、ka 只標記一次,兩者皆以 kb 完成', async () => {
            const auth = mk([KA, KB])
            const log = recLog()
            const calls = []
            let arrived = 0
            let release
            const gate = new Promise((r) => { release = r })
            const f = async (u) => {
                const k = keyOf(u)
                calls.push(k)
                if (k === KA) {
                    arrived++
                    if (arrived === 2) release()
                    await gate
                    return fail(401)
                }
                return ok
            }
            const rs = await settles(Promise.all([openAlexGet(f, U, { auth, log }), openAlexGet(f, U, { auth, log })]))
            assert.deepEqual(rs.map((r) => r.status), ['success', 'success'])
            assert.deepEqual(calls, [KA, KA, KB, KB])
            assert.equal(warnsOf(log).length, 1)
        })
        it('終止保險:載體之 reject 若不生效(形狀合格之替身),同一把被拒第二次即回該結果,不無窮迴圈', async () => {
            const calls = []
            const stub = { enabled: true, retryWaitMs: 0, sign: (u) => `${u}&api_key=stub`, mask: (t) => t, cursor: () => 0, advance: () => 0, reject: () => {}, invalid: () => null }
            const f = async () => {
                calls.push(1)
                if (calls.length > 50) throw new Error('loop')
                return fail(401)
            }
            const r = await settles(openAlexGet(f, U, { auth: stub }))
            assert.deepEqual([r.status, r.httpCode, calls.length <= 2], ['error', 401, true])
        })
        it('無金鑰:不受影響——以 (url, { timeoutMs, maxRetries }) 呼叫一次、網址不動,429 同改前', async () => {
            const { f, calls } = fakeSite(() => fail(429))
            const seen = []
            const f2 = async (u, o) => (seen.push([u, o]), f(u))
            const r = await openAlexGet(f2, U, { timeoutMs: 77, maxRetries: 0 })
            assert.deepEqual(seen, [[U, { timeoutMs: 77, maxRetries: 0 }]])
            assert.deepEqual([calls.length, r.quota], [1, true])
        })
        it('抓取函數自身拋錯(自訂注入者):遮罩全部把後重拋', async () => {
            const auth = mk([KA, KB])
            await assert.rejects(() => openAlexGet(async (u) => { throw new Error(`boom ${u} and ${KB} and ${encodeURIComponent(KA)}`) }, U, { auth }), (e) => noSecret(e.message) && /boom https:\/\/x\.test\/works\?search=a&api_key=\*\*\*/.test(e.message))
        })
    })

    // ══════════════════════════ OA13 遮罩涵蓋全部把 ══════════════════════════
    describe('OA13 遮罩涵蓋全部把', function() {
        it('mask:每一把之原形、URL 編碼形、表單編碼形、JSON 內皆遮', () => {
            const a = mk([KA, KB, KC])
            for (const k of [KA, KB, KC]) {
                const text = `curl failed https://x.test/works?api_key=${encodeURIComponent(k)} raw ${k} form ${encodeURIComponent(k).replace(/%20/g, '+')} json ${JSON.stringify({ k })}`
                assert.ok(noSecret(a.mask(text)), a.mask(text))
            }
            assert.ok(noSecret(a.mask(`${KA} ${KB} ${KC}`)))
            assert.equal(a.mask('不含金鑰之訊息'), '不含金鑰之訊息')
        })
        it('載體經 JSON.stringify／util.inspect／展開／String／Object.values／getOwnPropertyNames 皆不含任一把;JSON 仍為 {"enabled":true}', () => {
            const a = mk([KA, KB])
            const dumps = [JSON.stringify(a), util.inspect(a, { depth: 6, showHidden: true }), JSON.stringify({ ...a }), String(a), JSON.stringify(Object.values(a).filter((v) => typeof v !== 'function')), JSON.stringify(Object.getOwnPropertyNames(a)), util.inspect({ ...a }, { depth: 6, showHidden: true })]
            for (const d of dumps) assert.ok(noSecret(d), d)
            assert.equal(JSON.stringify(a), '{"enabled":true}')
            assert.equal(util.inspect(a), '[OpenAlexAuth enabled]')
        })
        it('成功結果之 url／finalUrl 亦不含任一把(真 curl 成功時兩者皆為含 api_key 之請求網址);html 等其餘欄位原樣', async () => {
            const auth = mk([KA, KB])
            const r = await openAlexGet(async (u) => ({ ...ok, url: u, finalUrl: u }), U, { auth })
            assert.equal(r.status, 'success')
            assert.ok(noSecret(JSON.stringify(r)), JSON.stringify(r))
            assert.match(r.url, /api_key=\*\*\*/)
            assert.match(r.finalUrl, /api_key=\*\*\*/)
            assert.equal(r.html, ok.html)
            assert.equal(r.httpCode, 200)
        })
        it('真 curl 連線失敗(死埠)之訊息含完整命令列:輪替到第二把後,結果的 message／reason／url／finalUrl、stderr 皆不含任一把', async () => {
            const auth = mk([KA, KB])
            // 先讓當前把換到 kb
            const s = fakeSite((k) => (k === KA ? fail(429) : ok))
            await openAlexGet(s.f, U, { auth })
            assert.deepEqual(s.calls, [KA, KB])
            const { value: r, stderr } = await withStderr(() => openAlexGet(fetchWebByCurl, `${DEAD}/works?search=a`, { auth, timeoutMs: 3000, maxRetries: 1 }))
            assert.equal(r.status, 'error')
            assert.ok(noSecret(JSON.stringify(r)), JSON.stringify(r))
            assert.ok(noSecret(stderr), stderr)
            assert.match(String(r.message) + String(r.reason), /api_key=\*\*\*|curl|Failed|refused|connect/i, '確為連線失敗而非他因')
        })
        it('curl 失敗訊息同時含兩把(先後輪替之網址)亦全遮', async () => {
            const auth = mk([KA, KB])
            const both = `Command failed: curl ${U}&api_key=${encodeURIComponent(KA)} then ${U}&api_key=${encodeURIComponent(KB)}`
            const r = await openAlexGet(async () => ({ status: 'error', reason: 'curl-error', message: both, url: both, finalUrl: both }), U, { auth })
            assert.ok(noSecret(JSON.stringify(r)), JSON.stringify(r))
        })
        it('無效金鑰之 WARN 與全部無效之結果不含任一把', async () => {
            const auth = mk([KA, KB])
            const log = recLog()
            const r = await openAlexGet(fakeSite(() => fail(401)).f, U, { auth, log })
            assert.ok(noSecret(JSON.stringify(r)) && noSecret(log.lines.join('\n')) && noSecret(util.inspect(r, { depth: 5 })))
        })
    })

    // ══════════════════════════ OA14 三處站點接線 ══════════════════════════
    describe('OA14 三處站點接線(網格、領域驗證、原文回溯)', function() {
        const MAILTO = 'kc@example.org'
        const gridBody = JSON.stringify({ meta: { count: 100 }, results: Array.from({ length: 3 }, (_, i) => ({ title: `Paper g${i}`, publication_year: 2025, doi: `https://doi.org/10.1000/g${i}`, abstract_inverted_index: inv(words(60, `g${i}`)), primary_location: {} })) })
        const gridOk = { status: 'success', html: gridBody, httpCode: 200 }
        const arxivOk = { status: 'success', httpCode: 200, html: '<feed></feed>' }
        const isOa = (u) => u.startsWith('https://oa.test')
        const gridFetchers = (auth, f) => createDefaultFetchers({ openAlexBase: 'https://oa.test', arxivApiBase: 'https://ax.test', openAlexMailto: MAILTO, openAlexAuth: auth, fetchWebByCurl: f }).find((x) => x.id === 'grid')

        it('網格:ka 401、kb 200 → 取得 OpenAlex 項目(不落 arXiv);WARN 走 ctx.log 一次;後續來源直接用 kb', async () => {
            const auth = mk([KA, KB])
            const log = recLog()
            const calls = []
            const f = async (u) => {
                if (!isOa(u)) return arxivOk
                const k = keyOf(u)
                calls.push(k)
                return k === KA ? fail(401) : gridOk
            }
            const src = { query: 'planetary science', name: 'g', cursor: 1 }
            const items = await gridFetchers(auth, f).fetch(src, { log })
            assert.equal(items.length, 3)
            assert.equal(src._fetchedVia, 'openalex')
            assert.deepEqual(calls, [KA, KB])
            assert.equal(warnsOf(log).length, 1, log.lines.join('\n'))
            await gridFetchers(auth, f).fetch({ query: 'x', name: 'g2', cursor: 1 }, { log })
            assert.deepEqual(calls, [KA, KB, KB])
            assert.equal(warnsOf(log).length, 1)
        })
        it('網格:ka 429、kb 200 → 成功(不標 _oaQuota、無額度警告);兩把皆 429 → 切 arXiv 並標 _oaQuota', async () => {
            const log = recLog()
            const f = async (u) => (isOa(u) ? (keyOf(u) === KA ? fail(429) : gridOk) : arxivOk)
            const src = { query: 'q', name: 'g', cursor: 1 }
            const items = await gridFetchers(mk([KA, KB]), f).fetch(src, { log })
            assert.deepEqual([items.length, src._fetchedVia, src._oaQuota], [3, 'openalex', false])
            assert.equal(log.lines.some((l) => l.includes(OPENALEX_QUOTA_MESSAGE)), false)
            const src2 = { query: 'q', name: 'g', cursor: 1 }
            const f2 = async (u) => (isOa(u) ? fail(429) : arxivOk)
            await gridFetchers(mk([KA, KB]), f2).fetch(src2, { log })
            assert.deepEqual([src2._fetchedVia, src2._oaQuota], ['arxiv', true])
            assert.ok(log.lines.some((l) => l.includes(OPENALEX_QUOTA_MESSAGE)))
        })
        it('網格:全部金鑰無效 → 切 arXiv 取得項目,不標 _oaQuota(非額度),WARN 為無效金鑰字樣;兩者皆失敗之拋錯訊息指明金鑰無效且不重複「OpenAlex OpenAlex」', async () => {
            const log = recLog()
            const auth = mk([KA, KB])
            const arxivFeed = `<feed><entry><id>http://arxiv.org/abs/2401.00000v1</id><title>Arx</title><summary>${'Tidal heating of icy satellites is estimated from orbital resonance. '.repeat(6)}</summary><published>2024-01-01T00:00:00Z</published></entry></feed>`
            const f = async (u) => (isOa(u) ? fail(401) : { status: 'success', httpCode: 200, html: arxivFeed })
            const src = { query: 'q', name: 'g', cursor: 1 }
            const items = await gridFetchers(auth, f).fetch(src, { log })
            assert.deepEqual([items.length, src._fetchedVia, src._oaQuota], [1, 'arxiv', false])
            assert.equal(log.lines.some((l) => l.includes(OPENALEX_QUOTA_MESSAGE)), false, '401 不得被記成額度')
            assert.equal(warnsOf(log).length, 2)
            const both = async (u) => (isOa(u) ? fail(401) : fail(503))
            await assert.rejects(() => gridFetchers(auth, both).fetch({ query: 'q', name: 'g', cursor: 1 }, { log }), (e) => /OpenAlex 狀態碼 401：OpenAlex 金鑰無效/.test(e.message) && !/OpenAlex OpenAlex/.test(e.message) && /arXiv HTTP 503/.test(e.message))
        })
        it('網格:全部金鑰無效且 arXiv 為斷網類失敗(無 HTTP 狀態) → 組合訊息由 arXiv 之原因決定(httpCodeOf 得 0,下游得以判為本機網路問題),不因合成之金鑰無效結果誤判為「網路通」', async () => {
            const auth = mk([KA, KB])
            const f = async (u) => (isOa(u) ? fail(401) : { status: 'error', reason: 'curl-error', message: 'curl: (6) Could not resolve host' })
            await assert.rejects(() => gridFetchers(auth, f).fetch({ query: 'q', name: 'g', cursor: 1 }, { log: recLog() }), (e) => httpCodeOf({ message: e.message }) === 0 && /OpenAlex 金鑰無效/.test(e.message) && /Could not resolve host/.test(e.message))
        })
        it('網格:金鑰全部無效而改走 arXiv 時,每個來源各記一行 WARN(OpenAlex 金鑰無效、本次改走 arXiv),使長駐行程後續各輪亦可見;429 與其他失敗不記此行', async () => {
            const log = recLog()
            const auth = mk([KA, KB])
            const arxivFeed = `<feed><entry><id>http://arxiv.org/abs/2401.00000v1</id><title>Arx</title><summary>${'Tidal heating of icy satellites is estimated from orbital resonance. '.repeat(6)}</summary><published>2024-01-01T00:00:00Z</published></entry></feed>`
            const f = async (u) => (isOa(u) ? fail(401) : { status: 'success', httpCode: 200, html: arxivFeed })
            await gridFetchers(auth, f).fetch({ query: 'q1', name: 'src-one', cursor: 1 }, { log })
            await gridFetchers(auth, f).fetch({ query: 'q2', name: 'src-two', cursor: 1 }, { log })
            const deg = log.lines.filter((l) => /^WARN 網格\[src-(one|two)\] OpenAlex 金鑰無效.*改走 arXiv/.test(l))
            assert.equal(deg.length, 2, log.lines.join('\n'))
            assert.equal(warnsOf(log).length, 2, '金鑰本身仍只在判定時各 WARN 一次')
            const log2 = recLog()
            await gridFetchers(mk([KA]), async (u) => (isOa(u) ? fail(503) : { status: 'success', httpCode: 200, html: arxivFeed })).fetch({ query: 'q3', name: 'src-three', cursor: 1 }, { log: log2 })
            assert.equal(log2.lines.some((l) => /金鑰無效/.test(l)), false, '5xx 等其他失敗不記金鑰無效')
        })
        it('網格:200 回應缺 results 而回應片段內含金鑰時,先遮罩再截斷(金鑰跨截點亦不殘留前綴)', async () => {
            const auth = mk([KA, KB])
            const body = JSON.stringify({ error: `${'x'.repeat(60)}${KA}` })
            const f = async (u) => (isOa(u) ? { status: 'success', httpCode: 200, html: body } : fail(503))
            await assert.rejects(() => gridFetchers(auth, f).fetch({ query: 'q', name: 'g', cursor: 1 }, { log: recLog() }), (e) => /回應缺 results/.test(e.message) && !e.message.includes('kaTest') && !e.message.includes(KA.slice(0, 8)))
        })
        it('網格:ctx 未給(無日誌可記)時換把照常、不拋錯;WARN 只在有日誌時才發(已知限制:首次遇到無效金鑰之站點若無日誌,該把之 WARN 不補發)', async () => {
            const auth = mk([KA, KB])
            const f = async (u) => (isOa(u) ? (keyOf(u) === KA ? fail(401) : gridOk) : arxivOk)
            const items = await gridFetchers(auth, f).fetch({ query: 'q', name: 'g', cursor: 1 }, {})
            assert.equal(items.length, 3)
            // ka 已標記無效(當時無日誌、未 WARN);之後 kb 可用、不再碰 ka,故沒有補發之時機
            const log = recLog()
            await gridFetchers(auth, f).fetch({ query: 'q', name: 'g', cursor: 1 }, { log })
            assert.equal(warnsOf(log).length, 0)
        })

        const areaCtx = (auth, log) => ({
            log,
            deps: {
                settings: settingsOf({ services: { openAlex: { base: 'https://oa.test', mailto: MAILTO } }, discover: { minHits: 30 } }),
                stores: { docs: { get: async () => null } },
                seen: { idOf: (u) => u },
                openAlexAuth: auth,
            },
        })
        const areaBody = JSON.stringify({ meta: { count: 1500 }, results: Array.from({ length: 8 }, (_, i) => ({ id: `W${i}`, doi: `https://doi.org/10.1000/v${i}`, primary_location: {}, abstract_inverted_index: inv(words(60, `v${i}`)) })) })
        it('領域驗證:ka 429、kb 200 → ok;ka 401、kb 200 → ok 且 WARN 走 ctx.log 一次;皆 429 → quota:true;全部無效 → 不標 quota、reason 指明金鑰無效、仍 transient', async () => {
            const okf = { status: 'success', html: areaBody, httpCode: 200 }
            const r1 = await validateAreaQuery('black hole', areaCtx(mk([KA, KB]), recLog()), { fetchWebByCurl: async (u) => (keyOf(u) === KA ? fail(429) : okf) })
            assert.deepEqual([r1.ok, r1.count], [true, 1500])
            const log2 = recLog()
            const a2 = mk([KA, KB])
            const r2 = await validateAreaQuery('black hole', areaCtx(a2, log2), { fetchWebByCurl: async (u) => (keyOf(u) === KA ? fail(401) : okf) })
            assert.equal(r2.ok, true)
            assert.equal(warnsOf(log2).length, 1)
            const r3 = await validateAreaQuery('black hole', areaCtx(mk([KA, KB]), recLog()), { fetchWebByCurl: async () => fail(429) })
            assert.deepEqual([r3.ok, r3.quota, r3.transient, r3.reason], [false, true, true, OPENALEX_QUOTA_MESSAGE])
            const log4 = recLog()
            const r4 = await validateAreaQuery('black hole', areaCtx(mk([KA, KB]), log4), { fetchWebByCurl: async () => fail(401) })
            assert.deepEqual([r4.ok, r4.quota, r4.transient], [false, undefined, true])
            assert.match(r4.reason, /OpenAlex 金鑰無效/)
            assert.ok(!r4.reason.includes('429'))
            assert.equal(warnsOf(log4).length, 2)
        })

        /** 回溯環境:DOI 文件 nDoi 篇 */
        const refetchEnv = (name, { nDoi = 0, deps = {} } = {}) => {
            const dir = rootOf(`openalex-keys-${name}`)
            const rows = []
            for (let i = 0; i < nDoi; i++) rows.push({ id: `d${pad(i)}`, status: 'noted', textFrom: 'abstract', url: `https://doi.org/10.1000/t${pad(i)}`, title: `DOI paper ${pad(i)}`, notedAt: AT })
            const log = recLog()
            const docs = memStore(rows)
            const docTexts = memStore([])
            const settings = settingsOf({ services: { openAlex: { base: 'https://oa.test', mailto: MAILTO }, arxiv: { base: 'https://ax.test' } }, standards: { minTextChars: 300 }, articles: { maxTextChars: 20000 } })
            const state = `${dir}/state`
            const base = { stores: { docs, docTexts }, dirs: { state }, clock, log, settings, ...deps }
            const ledger = () => (fs.existsSync(`${state}/${REFETCH_LEDGER_FILE}`) ? fs.readFileSync(`${state}/${REFETCH_LEDGER_FILE}`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
            return { base, log, ledger }
        }
        const doiOk = (u) => {
            const filter = new URL(u).searchParams.get('filter') || ''
            const dois = filter.slice(4).split('|')
            return { status: 'success', httpCode: 200, html: JSON.stringify({ meta: { count: dois.length }, results: dois.map((d, i) => ({ title: `T ${d}`, doi: d, abstract_inverted_index: inv(words(60, `d${i}`)), primary_location: {} })) }) }
        }
        it('原文回溯:金鑰檔 ka,kb(變數 OPENALEX_API_KEY):ka 429 → 換 kb 成功(全數 archived);ka 401 → WARN 走 deps.log 一次且寫明變數名,後續批次只用 kb', async () => {
            const calls = []
            const env = refetchEnv('swap429', { nDoi: 120, deps: { envFile: ENVF, fetchWebByCurl: async (u) => (calls.push(keyOf(u)), keyOf(u) === 'ka' ? fail(429) : doiOk(u)) } })
            const r = await refetchSources(env.base, { apply: true })
            assert.deepEqual(r.outcomes, { archived: 120 })
            assert.equal(r.quotaStop, undefined)
            assert.deepEqual(calls, ['ka', 'kb', 'kb', 'kb'], '120 篇 3 批:第 1 批 ka(429)→kb,其後直接 kb')
            const calls2 = []
            const env2 = refetchEnv('swap401', { nDoi: 120, deps: { envFile: ENVF, fetchWebByCurl: async (u) => (calls2.push(keyOf(u)), keyOf(u) === 'ka' ? fail(401) : doiOk(u)) } })
            const r2 = await refetchSources(env2.base, { apply: true })
            assert.deepEqual(r2.outcomes, { archived: 120 })
            assert.deepEqual(calls2, ['ka', 'kb', 'kb', 'kb'])
            const w = warnsOf(env2.log)
            assert.equal(w.length, 1, env2.log.lines.join('\n'))
            assert.match(w[0], /OPENALEX_API_KEY 之第 1／2 把/)
        })
        it('原文回溯:兩把皆 429 → 連續 3 次即停(quotaStop,未處理不入帳);兩把皆 401 → 不計入 429 連續計數(無 quotaStop),各批記 fetch-failed,僅送出兩個請求(之後不再送)', async () => {
            const callsA = []
            const authA = createOpenAlexAuth(['ka', 'kb'], { retryWaitMs: 0, envName: ENV }) // 等待歸零(回溯每次請求 maxRetries:1 ＝ 兩輪)
            const envA = refetchEnv('all429', { nDoi: 200, deps: { openAlexAuth: authA, fetchWebByCurl: async (u) => (callsA.push(keyOf(u)), fail(429)) } })
            const rA = await refetchSources(envA.base, { apply: true })
            assert.ok(rA.quotaStop, '皆 429 → 額度用盡而停')
            assert.equal(rA.quotaStop.unprocessed, 200)
            assert.equal(callsA.length, 12, '連續 3 次請求 × (maxRetries 1 ＋ 1 輪) × 2 把 = 12(上限 (maxRetries+1)×把數)')
            const callsB = []
            const envB = refetchEnv('all401', { nDoi: 200, deps: { envFile: ENVF, fetchWebByCurl: async (u) => (callsB.push(keyOf(u)), fail(401)) } })
            const rB = await refetchSources(envB.base, { apply: true })
            assert.equal(rB.quotaStop, undefined, '金鑰無效不是額度用盡,不得觸發 429 連續停止')
            assert.deepEqual(rB.outcomes, { 'fetch-failed': 200 })
            assert.deepEqual(callsB, ['ka', 'kb'], '兩把各被拒一次後不再送出')
            assert.equal(warnsOf(envB.log).length, 2)
            assert.ok(envB.ledger().length === 200 && envB.ledger().every((x) => x.outcome === 'fetch-failed' && x.why === 'openalex-doi 批次失敗'), '處置帳列為 fetch-failed(同其他非 429 之批次失敗;可 retry),不是未處理')
            assert.ok(envB.log.lines.some((l) => /^WARN 原文回溯：openalex-doi 批次失敗（HTTP 失敗：狀態碼 401：OpenAlex 金鑰無效/.test(l)), '批次失敗之日誌指明金鑰無效')
            assert.ok(!envB.log.lines.some((l) => l.includes(OPENALEX_QUOTA_MESSAGE)))
        })
        it('createCaptureRuntime:金鑰檔 ka,kb → 載體啟用且帶變數名(WARN 寫明 OPENALEX_API_KEY);金鑰檔無該變數 → 未啟用', async () => {
            const cap = settingsOf({ services: { openAlex: { base: 'https://oa.test' }, arxiv: { base: 'https://ax.test' } } })
            const rt = createCaptureRuntime({ data: {} }, cap, { envFile: ENVF })
            assert.equal(rt.openAlexAuth.enabled, true)
            const log = recLog()
            const { f, calls } = fakeSite((k) => (k === 'ka' ? fail(401) : ok))
            await openAlexGet(f, U, { auth: rt.openAlexAuth, log })
            assert.deepEqual(calls, ['ka', 'kb'])
            assert.match(warnsOf(log)[0], /OPENALEX_API_KEY 之第 1／2 把/)
            const rtNone = createCaptureRuntime({ data: {} }, cap, { envFile: `${TMP}/not-exist.env` })
            assert.equal(rtNone.openAlexAuth.enabled, false)
        })
    })

    // ══════════════════════════ OA15 日誌契約 ══════════════════════════
    describe('OA15 日誌契約', function() {
        const KNOWN = new RegExp(CAPTURE_LOG_KNOWN.join('|'))
        const MUST_SEE = new RegExp(CAPTURE_LOG_MUST_SEE.join('|'))
        it('無效金鑰之 WARN 行為「須見」字樣、且不被已知常態字樣吞掉;含該文字之失敗結果訊息亦被須見字樣涵蓋', async () => {
            const log = recLog()
            const r = await openAlexGet(fakeSite(() => fail(401)).f, U, { auth: mk([KA, KB]), log })
            const w = warnsOf(log)
            assert.equal(w.length, 2)
            for (const line of w) {
                assert.ok(MUST_SEE.test(line), `須見:${line}`)
                assert.ok(!KNOWN.test(line), `不得被視為已知常態:${line}`)
            }
            assert.ok(MUST_SEE.test(`網格雙供應商皆失敗：OpenAlex ${r.message}；arXiv HTTP 503`), '併入已知字樣之行(網格雙供應商皆失敗)亦須見')
            assert.ok(CAPTURE_LOG_MUST_SEE.includes('OpenAlex 金鑰無效'))
        })
    })
})
