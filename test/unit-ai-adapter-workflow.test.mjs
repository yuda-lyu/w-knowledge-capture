// unit-ai-adapter-workflow.test.mjs — AI 調度層之工作流入口(core/ai/adapter 之建構選項 workflow:getWkf、seatSpec):本機假 OpenAI 相容 REST
//   (固定埠 8832)走真實 fetch 與真實 w-dispatch-ai 工作流(dispatchAiWkf 之 callAi／runFanout),不連外網、不呼叫真 AI 或真 CLI
// 規則(出自 adapter 檔頭【工作流入口】):
//   ①workflow 預設關:未給(或 null／false)時回傳之鍵集同現行;給了非布林值即拋(同 acceptTruncated／preview／capability);true 另帶 getWkf、seatSpec
//   ②getWkf 快取同一物件、只轉出 providers／callAi／runFanout;定義表＝本實例可用表去掉條目之逾時(逾時由 seatSpec 帶);
//     與 callJson 共用 store(游標與冷卻)、冷卻偵測、事件入口(用量、健康)與工作目錄之確保(每次派送前);recordCall 收工作流之結果
//   ③呼叫端之 onEvent 串在本層之後、不取代(callAi 之第二參數、runFanout 之 callOpt 與各席規格;含值為 undefined 者),呼叫端拋錯不外洩
//   ④seatSpec:依實際長度(加防寫前綴)預篩,判準與計帳同 callJson(ai.providerLimits 恆生效、固有上限於 capability 開啟才計);全放不下回 null;
//     timeoutMs＝席位值,否則留存條目之逾時取大(再無則 ai.timeoutMs,再無則 300,000);budgetMs＝席位值,否則 timeoutMs×留存條目數;
//     minAttemptMs＝席位值,否則 min(20 秒, timeoutMs 之一半)、等於 20 秒者不帶(預算不足 20 秒之席位否則一次都不送出;門檻須明顯小於單次逾時,
//     末家開工時之剩餘才不致因開銷而略低於門檻——callJson 同一規則);
//     席位形狀與 id 不合即拋(同 validateSeats)
//   ⑤斷網不計:callAi 整鏈皆敗(已送出、無成交、非預算用盡或中止)、未逢整輪截止且 isNetDown 回 true → { ...原結果, ok:false, skipped:true, netDown:true };
//     runFanout 失敗(各席皆敗,或整合已呼叫而敗)時詢問一次,不通即標 netDown:true,其中整鏈皆敗之結果各標 skipped／netDown;
//     isNetDown 另轉交遞補層為 envDown(整鏈皆敗之名額各問一次,決定 n 與連敗是否落定;設計 da402 §4.2〈CA〉4),故詢問次數含遞補層者
// 執行:自套件根 npx mocha test/unit-ai-adapter-workflow.test.mjs(暫存 test/_tmp/ai-adapter-wkf-<pid>,測完即刪;埠 8832 為假 REST、8830 為無人監聽之死埠)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import NO_SIDE_EFFECT from 'w-dispatch-ai/src/wkf/noSideEffectPrefix.mjs'
import dispatchAiWkf from 'w-dispatch-ai/src/dispatchAiWkf.mjs'
import { createAiAdapter, callJsonShapeOf } from '../src/core/ai/adapter.mjs'
import { AI_DEFAULT } from '../src/core/settingsDefault.mjs'
import { tmpRoot } from './tools/captureTestKit.mjs'
import { removeRoots, sleep } from './tools/testKit.mjs'

// 暫存根(套件內 test/_tmp/ai-adapter-wkf-<pid>;before 建立、after 清除)
let TMP = ''
const PORT = 8832 // 假 REST(固定埠,≥8000、不隨機;本檔專屬)
const DEAD_PORT = 8830 // 無人監聽之死埠(連線即被拒;他檔亦只連不聽)
const BASE = `http://127.0.0.1:${PORT}/v1`
const DEAD_BASE = `http://127.0.0.1:${DEAD_PORT}/v1`


// ── 假伺服器:依請求之 model 決定情境(「情境~延遲毫秒」)──
const SCENES = {
    ops: '{"ops":[{"op":"add","text":"a"}]}',
    ops2: '{"ops":[{"op":"add","text":"b"},{"op":"confirm","id":"C1"}]}',
    plain: '這不是 JSON',
}
const hits = [] // 每次請求 { model, scene, content }

/**
 * 假伺服器處理器:limit 回 429(rate limit);其餘依情境回 200
 *
 * @param {Object} req 輸入請求
 * @param {Object} res 輸入回應
 * @returns {undefined} 無回傳值
 */
function handler(req, res) {
    let buf = ''
    req.on('data', (c) => {
        buf += c
    })
    req.on('end', async () => {
        let body = {}
        try {
            body = JSON.parse(buf)
        }
        catch { /* 本體非 JSON:依空物件處理 */ }
        const model = String(body.model || '')
        const [scene, delay] = model.split('~')
        const content = String(body.messages?.[body.messages.length - 1]?.content || '')
        hits.push({ model, scene, content })
        if (Number(delay)) await sleep(Number(delay))
        if (res.destroyed || res.writableEnded) return
        try {
            if (scene === 'limit') {
                res.writeHead(429, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }))
                return
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ id: 'fake', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: SCENES[scene] ?? SCENES.plain }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
        }
        catch { /* 連線已被中止 */ }
    })
}

const rest = (id, model, extra = {}) => ({ id, kind: 'api-openai-compat', baseURL: BASE, model, ...extra })
const CAT = [
    rest('w:ops', 'ops'),
    rest('w:ops2', 'ops2'),
    rest('w:plain', 'plain'),
    rest('w:limit', 'limit'),
    rest('w:own', 'ops', { timeoutMs: 3000 }), // 條目自帶逾時
    rest('w:slow', 'ops~400', { timeoutMs: 100 }), // 條目自帶逾時短於回應時間
    { id: 'w:dead', kind: 'api-openai-compat', baseURL: DEAD_BASE, model: 'ops' }, // 死埠:連線被拒
    { id: 'agy:x', kind: 'antigravity', model: 'x', exe: 'c:/no-such-dir/no-such-agy.exe', maxPromptChars: 30_000 }, // 條目自帶上限 30,000 字(模擬命令列型轉接器之硬上限;capability 開啟才計);exe 不存在,不呼叫真 CLI
]
// 提煉差量之外包物件(各棒之 check 形態;只認嚴格 true)
const opsCheck = (j) => !!j && typeof j === 'object' && Array.isArray(j.ops)
const opsCheckJson = (d) => (opsCheck(d) ? true : '須為 { ops:[] }')

let seq = 0

/**
 * 建立一個 adapter(每個測試各自一個,游標／冷卻／用量互不干擾);ai 為覆寫 settings.ai 之鍵
 *
 * @param {Object} [o={}] 輸入 { ai, ...createAiAdapter 之其他選項 }
 * @returns {Object} 回傳 adapter
 */
const mk = (o = {}) => {
    const { ai, ...more } = o
    return createAiAdapter({
        ai: { ...AI_DEFAULT, ...(ai || {}) },
        workspace: `${TMP}/ws-${++seq}`,
        env: {},
        catalogue: CAT,
        ...more,
    })
}

/**
 * 工作流 callAi 一次並收集各次嘗試之條目 id(依序)
 *
 * @param {Object} ad 輸入 adapter
 * @param {Object} spec 輸入名額 { use, fallback? }
 * @param {Object} [extra={}] 輸入其他逐次選項
 * @returns {Promise} 回傳 { r, tries, events }
 */
const callTry = async (ad, spec, extra = {}) => {
    const tries = []
    const events = []
    const r = await ad.getWkf().callAi('q', {
        spec,
        check: opsCheck,
        ...extra,
        onEvent: (ev) => {
            events.push(ev.type)
            if (ev.type === 'try') tries.push(ev.providerId)
        },
    })
    return { r, tries, events }
}

const BASE_KEYS = ['aiUsageToday', 'available', 'callJson', 'chainFor', 'drainStats', 'recordCall', 'validateSeats']

describe('unit-ai-adapter-workflow', function() {

    this.timeout(60_000)

    let server = null

    before(async function() {
        TMP = tmpRoot('ai-adapter-wkf')
        server = http.createServer(handler)
        await new Promise((resolve, reject) => {
            server.once('error', (e) => reject(new Error(`假伺服器無法監聽固定埠 ${PORT}(${e.code || e.message}):請確認無其他行程佔用`)))
            server.listen(PORT, '127.0.0.1', resolve)
        })
    })

    after(async function() {
        if (server) {
            server.closeAllConnections?.()
            await new Promise((resolve) => server.close(resolve))
        }
        removeRoots([TMP])
    })

    beforeEach(function() {
        hits.length = 0
    })

    describe('建構選項與回傳之鍵(規則①)', function() {

        it('未給 workflow(或 null／false):回傳之鍵集同現行(無 getWkf／seatSpec);給了非布林值即拋;true 另帶 getWkf、seatSpec(與 health 並存)', () => {
            for (const v of [undefined, null, false]) {
                const ad = mk({ workflow: v })
                assert.deepEqual(Object.keys(ad).sort(), BASE_KEYS, `workflow=${String(v)}`)
            }
            for (const bad of ['true', 1, 0, {}, []]) assert.throws(() => mk({ workflow: bad }), /^Error: createAiAdapter 之 workflow 須為布林值$/, JSON.stringify(bad))
            const on = mk({ workflow: true })
            assert.deepEqual(Object.keys(on).sort(), [...BASE_KEYS, 'getWkf', 'seatSpec'].sort())
            for (const k of ['getWkf', 'seatSpec']) assert.equal(typeof on[k], 'function', k)
            assert.deepEqual(Object.keys(mk({ workflow: true, ai: { healthStreak: 2 } })).sort(), [...BASE_KEYS, 'getWkf', 'health', 'seatSpec'].sort())
        })
    })

    describe('getWkf:定義表、快取與共用狀態(規則②③)', function() {

        it('快取同一物件;只轉出 providers／callAi／runFanout(多棒管線不轉出);定義表＝可用表去掉條目之逾時,其餘欄位不變', () => {
            const ad = mk({ workflow: true, ai: { providerTimeouts: { 'w:ops': 1234 } } })
            const wkf = ad.getWkf()
            assert.equal(ad.getWkf(), wkf, '同一實例快取同一份')
            assert.deepEqual(Object.keys(wkf).sort(), ['callAi', 'providers', 'runFanout'])
            assert.deepEqual(Object.keys(wkf.providers).sort(), [...ad.available().ids].sort())
            for (const id of ['w:ops', 'w:own', 'w:slow']) {
                const { timeoutMs, ...restOf } = ad.chainFor({ use: id })[0]
                assert.ok(Number.isInteger(timeoutMs), `${id}:可用表之條目帶逾時(三層取值)`)
                assert.equal('timeoutMs' in wkf.providers[id], false, `${id}:定義表無條目逾時`)
                assert.deepEqual(wkf.providers[id], restOf, `${id}:其餘欄位不變`)
            }
            assert.notEqual(mk({ workflow: true }).getWkf(), wkf, '不同實例各一份')
        })

        it('callAi 經假 REST 成交(提示詞前加防寫前綴);recordCall 收工作流之結果照計;用量與 callJson 同一份', async () => {
            const ad = mk({ workflow: true, clock: { date8: () => '2026-10-10' } })
            const r = await ad.getWkf().callAi('請回差量', { spec: { use: 'w:ops' }, check: opsCheck })
            assert.deepEqual([r.ok, r.providerId, r.json], [true, 'w:ops', { ops: [{ op: 'add', text: 'a' }] }])
            assert.equal(hits[0].content, `${NO_SIDE_EFFECT}請回差量`)
            assert.deepEqual([ad.aiUsageToday().today, ad.aiUsageToday().used, ad.aiUsageToday().byKey], ['2026-10-10', 1, { 'w:ops': 1 }], '工作流之嘗試記入本實例之用量')
            ad.recordCall(r)
            const j = await ad.callJson('請回差量', opsCheckJson, { spec: { use: 'w:ops2' } })
            assert.equal(j.ok, true)
            assert.deepEqual(ad.aiUsageToday().byKey, { 'w:ops': 1, 'w:ops2': 1 }, '兩條路徑記入同一份用量')
            assert.equal(ad.drainStats(), '成交 w:ops×1 w:ops2×1', 'recordCall 收工作流之結果(keyId 取結果之 keyId)')
        })

        it('冷卻與游標同一份 store:工作流路徑之 429 冷卻後,callJson 之下一次即降至鏈尾;反之 callJson 之冷卻,工作流亦降序', async () => {
            const spec = { use: 'w:limit', fallback: ['w:ops'] }
            const a = mk({ workflow: true })
            const r1 = await callTry(a, spec)
            assert.deepEqual([r1.r.ok, r1.r.providerId, r1.events.includes('cooled')], [true, 'w:ops', true])
            hits.length = 0
            assert.equal((await a.callJson('q', opsCheckJson, { spec })).providerId, 'w:ops')
            assert.deepEqual(hits.map((h) => h.scene), ['ops'], '工作流路徑寫入之冷卻,callJson 讀得到')
            const b = mk({ workflow: true })
            await b.callJson('q', opsCheckJson, { spec })
            const r2 = await callTry(b, spec)
            assert.deepEqual([r2.r.providerId, r2.tries], ['w:ops', ['w:ops']], 'callJson 寫入之冷卻,工作流讀得到')
            const c = mk({ workflow: true })
            const r3 = await callTry(c, spec)
            assert.deepEqual(r3.tries, ['w:limit', 'w:ops'], '另一實例之冷卻狀態獨立')
        })

        it('工作目錄於每次派送前確保存在(callAi 與 runFanout 皆然)', async () => {
            const ws = `${TMP}/ws-wkf-fresh/nested/ai-workspace`
            const ad = mk({ workflow: true, workspace: ws })
            assert.equal(fs.existsSync(ws), false)
            assert.equal((await ad.getWkf().callAi('q', { spec: { use: 'w:ops' }, check: opsCheck })).ok, true)
            assert.equal(fs.existsSync(ws), true)
            fs.rmSync(`${TMP}/ws-wkf-fresh`, { recursive: true, force: true })
            const f = await ad.getWkf().runFanout({ task: 'q', agents: [{ use: 'w:ops' }], check: opsCheck })
            assert.deepEqual([f.ok, f.integrated], [true, false])
            assert.equal(fs.existsSync(ws), true, 'runFanout 前亦確保')
        })
    })

    describe('呼叫端之 onEvent(規則③)', function() {

        it('callAi:本層事件入口先於呼叫端(呼叫端於 try 時讀得到本次用量);呼叫端拋錯不外洩;值為 undefined 之 onEvent 不使本層計帳失效', async () => {
            const ad = mk({ workflow: true })
            const seen = []
            const r = await ad.getWkf().callAi('q', {
                spec: { use: 'w:plain', fallback: ['w:ops'] },
                check: opsCheck,
                onEvent: (ev) => {
                    seen.push(ev.type)
                    if (ev.type === 'try') seen.push(`used:${ad.aiUsageToday().used}`)
                    throw new Error('回呼壞了')
                },
            })
            assert.equal(r.ok, true)
            assert.deepEqual(seen.filter((t) => ['try', 'skip-group', 'ok'].includes(t) || t.startsWith('used:')), ['try', 'used:1', 'skip-group', 'try', 'used:2', 'ok'])
            const r2 = await ad.getWkf().callAi('q', { spec: { use: 'w:ops' }, check: opsCheck, onEvent: undefined })
            assert.equal(r2.ok, true)
            assert.equal(ad.aiUsageToday().used, 3, 'onEvent:undefined 不蓋掉本層之計帳')
            // 前提(上游行為):直接用 dispatchAiWkf 時,逐次選項之 onEvent(含 undefined)以 { ...共用, ...逐次 } 蓋掉共用之 onEvent——此即本層須串接之原因
            let layer = 0
            const raw = dispatchAiWkf({ providers: { 'w:ops': rest('w:ops', 'ops') }, defaults: { onEvent: () => layer++, cwd: TMP } })
            await raw.callAi('q', { spec: { use: 'w:ops' }, check: opsCheck, onEvent: undefined })
            await raw.callAi('q', { spec: { use: 'w:ops' }, check: opsCheck, onEvent: () => {} })
            assert.equal(layer, 0, '前提不成立即表示上游已改合併方式,本層之串接可重新評估')
        })

        it('runFanout:callOpt.onEvent 與各席規格之 onEvent 皆串在本層之後;各席之嘗試皆記入用量;健康層照常計數', async () => {
            const ad = mk({ workflow: true, ai: { healthStreak: 5 } })
            const viaCallOpt = []
            const viaAgent = []
            const r = await ad.getWkf().runFanout({
                task: 'q',
                agents: [
                    { use: 'w:ops' },
                    {
                        use: 'w:plain',
                        fallback: ['w:ops2'],
                        onEvent: (ev) => {
                            if (ev.type === 'try') viaAgent.push(`${ev.providerId}@${ad.aiUsageToday().used}`)
                            throw new Error('席位回呼壞了')
                        },
                    },
                ],
                check: opsCheck,
                minCandidates: 99,
                callOpt: {
                    onEvent: (ev) => {
                        if (ev.type === 'try') viaCallOpt.push(ev.providerId)
                    },
                },
            })
            assert.deepEqual([r.ok, r.agents.map((a) => a.providerId)], [true, ['w:ops', 'w:ops2']])
            assert.deepEqual(viaCallOpt, ['w:ops'], '未自帶 onEvent 之席位走 callOpt 之回呼')
            assert.equal(viaAgent.length, 2, '自帶 onEvent 之席位走其回呼(上游之覆寫語意)')
            assert.ok(viaAgent.every((x) => Number(x.split('@')[1]) >= 1), `本層先記帳:${viaAgent.join(',')}`)
            assert.equal(ad.aiUsageToday().used, 3, '三次嘗試皆記入用量(席位自帶之回呼不蓋掉本層)')
            const c = ad.health.snapshot().counts
            assert.deepEqual([c['w:ops'].ok, c['w:ops2'].ok, c['w:plain'].fail.validation], [1, 1, 1], '健康層經同一入口計數')
            const r2 = await ad.getWkf().runFanout({ task: 'q', agents: [{ use: 'w:ops', onEvent: undefined }], check: opsCheck, callOpt: { onEvent: undefined } })
            assert.equal(r2.ok, true)
            assert.equal(ad.aiUsageToday().used, 4, 'callOpt 與席位之 onEvent:undefined 不蓋掉本層之計帳')
        })
    })

    describe('seatSpec(規則④)', function() {

        it('長度預篩:ai.providerLimits 之上限恆生效(恰等於上限者放行);逾長者計帳(onOversize 每條目一次、健康層計次);全放不下回 null;未給長度不預篩', () => {
            const limit = NO_SIDE_EFFECT.length + 50
            const over = []
            const ad = mk({ workflow: true, ai: { providerLimits: { 'w:ops': limit }, healthStreak: 2 }, onOversize: (ev) => over.push(ev) })
            const seat = { use: 'w:ops', fallback: ['w:ops2'] }
            assert.deepEqual([ad.seatSpec(seat, 50).use, ad.seatSpec(seat, 50).fallback], ['w:ops', ['w:ops2']], '恰等於上限者放行')
            assert.deepEqual([ad.seatSpec(seat, 51).use, ad.seatSpec(seat, 51).fallback], ['w:ops2', []], '逾上限 1 字即剔除、鏈序不變')
            assert.deepEqual(over, [{ providerId: 'w:ops', promptLen: limit + 1, limit }], 'onOversize 每條目每實例一次(長度含防寫前綴)')
            assert.equal(ad.health.snapshot().counts['w:ops'].oversize, 2, '次數計於健康層')
            assert.equal(ad.seatSpec({ use: 'w:ops' }, 51), null, '整條鏈都放不下 → null')
            for (const len of [undefined, NaN, 'x', Infinity]) assert.equal(ad.seatSpec({ use: 'w:ops' }, len).use, 'w:ops', `promptLen=${String(len)}:不預篩`)
        })

        it('條目自帶上限(agy:x 之 30,000 字)於 capability 開啟才計:開 → 剔除、全鏈皆放不下回 null;未開 → 不剔除;判準同 callJson', async () => {
            const on = mk({ workflow: true, capability: true })
            const off = mk({ workflow: true })
            const seat = { use: 'agy:x', fallback: ['w:ops'] }
            assert.deepEqual([on.seatSpec(seat, 31_000).use, on.seatSpec(seat, 31_000).fallback], ['w:ops', []])
            assert.equal(on.seatSpec({ use: 'agy:x' }, 31_000), null)
            assert.deepEqual([on.seatSpec(seat, 100).use, on.seatSpec(seat, 100).fallback], ['agy:x', ['w:ops']], '短提示詞照常保留')
            assert.deepEqual([off.seatSpec(seat, 31_000).use, off.seatSpec(seat, 31_000).fallback], ['agy:x', ['w:ops']], '未開不計條目固有上限')
            // 同一判準:callJson 以同一長度呼叫時剔除同一家(未送出)
            const tries = []
            const r = await on.callJson('長'.repeat(31_000), opsCheckJson, { spec: seat, onEvent: (ev) => (ev.type === 'try' ? tries.push(ev.providerId) : null) })
            assert.deepEqual([r.ok, tries], [true, ['w:ops']])
        })

        it('未自帶上限之 antigravity 條目:capability 開啟時長提示詞亦不剔除(上游 1.0.80 起超長改走 stdin);seatSpec 全鏈皆此類亦非 null;callJson 同一判準(送交、不計 oversize)', async () => {
            const free = { id: 'agy:free', kind: 'antigravity', model: 'x', exe: 'c:/no-such-dir/no-such-agy.exe' }
            const over = []
            const on = mk({ workflow: true, capability: true, catalogue: [...CAT, free], onOversize: (ev) => over.push(ev) })
            const seat = { use: 'agy:free', fallback: ['w:ops'] }
            assert.deepEqual([on.seatSpec(seat, 31_000).use, on.seatSpec(seat, 31_000).fallback], ['agy:free', ['w:ops']], '長提示詞不剔除')
            assert.equal(on.seatSpec({ use: 'agy:free' }, 1_000_000).use, 'agy:free', '全鏈皆此類:非 null')
            const tries = []
            const r = await on.callJson('長'.repeat(31_000), opsCheckJson, { spec: seat, onEvent: (ev) => (ev.type === 'try' ? tries.push(ev.providerId) : null) })
            assert.deepEqual([r.ok, r.providerId, tries], [true, 'w:ops', ['agy:free', 'w:ops']], '送交 agy:free(本例之執行檔不存在而失敗)後遞補')
            assert.deepEqual(over, [], '未剔除:onOversize 不作用')
        })

        it('timeoutMs／budgetMs／minAttemptMs 之取值:①席位給值即用之 ②未給取留存條目之逾時之最大(預篩後重算)、預算＝逾時×留存數 ③條目與 ai 段皆無逾時取 300,000;④未給 minAttemptMs 者取 min(20 秒, 逾時之一半),等於 20 秒者不帶', () => {
            const ad = mk({ workflow: true, ai: { timeoutMs: 1000, providerTimeouts: { 'w:ops2': 2000 }, providerLimits: { 'w:own': NO_SIDE_EFFECT.length + 10 } } })
            assert.deepEqual(ad.seatSpec({ use: 'w:ops', fallback: ['w:ops2'], timeoutMs: 5000, budgetMs: 7000, minAttemptMs: 100 }), { use: 'w:ops', fallback: ['w:ops2'], timeoutMs: 5000, budgetMs: 7000, minAttemptMs: 100 }, '①')
            assert.deepEqual(ad.seatSpec({ use: 'w:ops', fallback: ['w:ops2', 'w:own'] }), { use: 'w:ops', fallback: ['w:ops2', 'w:own'], timeoutMs: 3000, budgetMs: 9000, minAttemptMs: 1500 }, '②條目自帶 3000 為最大;④門檻＝逾時之一半')
            assert.deepEqual(ad.seatSpec({ use: 'w:ops', fallback: ['w:ops2', 'w:own'] }, 20), { use: 'w:ops', fallback: ['w:ops2'], timeoutMs: 2000, budgetMs: 4000, minAttemptMs: 1000 }, '②預篩剔除 w:own 後於留存者中取大')
            assert.deepEqual(ad.seatSpec({ use: 'w:ops', fallback: ['w:ops2'], timeoutMs: 600 }, 20), { use: 'w:ops', fallback: ['w:ops2'], timeoutMs: 600, budgetMs: 1200, minAttemptMs: 300 }, '①席位逾時優先;預算＝席位逾時×留存數')
            const bare = createAiAdapter({ ai: {}, workspace: `${TMP}/ws-bare`, env: {}, catalogue: [rest('b:1', 'ops'), rest('b:2', 'ops')], workflow: true })
            assert.deepEqual(bare.seatSpec({ use: 'b:1', fallback: ['b:2'] }), { use: 'b:1', fallback: ['b:2'], timeoutMs: 300_000, budgetMs: 600_000 }, '③套件統一預設;④一半 ≥ 20 秒 → 不帶(上游預設)')
            assert.deepEqual(bare.seatSpec({ use: 'b:1', timeoutMs: 40_000 }), { use: 'b:1', fallback: [], timeoutMs: 40_000, budgetMs: 40_000 }, '④40 秒之一半恰 20 秒 → 不帶')
            assert.deepEqual(bare.seatSpec({ use: 'b:1', timeoutMs: 20_000 }).minAttemptMs, 10_000, '④恰 20 秒 → 門檻 10 秒(否則末家開工時剩餘因開銷略低於 20 秒而不開工)')
        })

        it('④之由來(真上游實跑):逾時 5 秒而未給 minAttemptMs 之席位——經工作流之 callAi 與 callJson 皆確實送出並成交(上游預設之 20 秒門檻高於預算時,此前一次都不送出、每次皆 budget exhausted)', async () => {
            const ad = mk({ workflow: true })
            const n0 = hits.length
            const { use, fallback, ...rest } = ad.seatSpec({ use: 'w:ops', timeoutMs: 5000 })
            assert.equal(rest.minAttemptMs, 2500, '前提:門檻＝席位逾時之一半')
            // 各重複 5 次:門檻若貼近單次逾時,開工時之剩餘因毫秒級之開銷而時過時不過(間歇失敗)
            for (let i = 0; i < 5; i++) {
                const viaWkf = await ad.getWkf().callAi('q', { spec: { use, fallback }, ...rest, check: opsCheck, acceptTruncated: false })
                assert.equal(viaWkf.ok, true, JSON.stringify({ i, error: viaWkf.error, errorType: viaWkf.errorType }))
                const viaJson = await ad.callJson('q', opsCheckJson, { spec: { use: 'w:ops', timeoutMs: 5000 } })
                assert.equal(viaJson.ok, true, JSON.stringify({ i, errors: viaJson.errors }))
            }
            assert.equal(hits.length - n0, 10, '兩條路徑每次皆送出')
        })

        it('席位形狀或 id 不合即拋(訊息同 validateSeats 之逐席原因);fallback 中與首選重複者去除', () => {
            const ad = mk({ workflow: true })
            assert.throws(() => ad.seatSpec(null), /^Error: 席位須為物件/)
            assert.throws(() => ad.seatSpec({ use: 'w:ops', foo: 1 }), /^Error: 含不認得之鍵：foo（可用：/)
            assert.throws(() => ad.seatSpec({ use: 'w:ops', timeoutMs: -1 }), /^Error: timeoutMs 須為正數（毫秒）/)
            assert.throws(() => ad.seatSpec({ use: 'nope:x' }), /^Error: 席位引用了不可用的條目：nope:x/)
            assert.deepEqual(ad.seatSpec({ use: 'w:ops', fallback: ['w:ops', 'w:ops2'] }).fallback, ['w:ops2'])
        })

        it('seatSpec 之規格交 callAi:逾時由席位帶入(定義表無條目逾時)——同一條目經 callJson 依條目逾時(100ms)而逾時,經工作流以席位逾時成交', async () => {
            const ad = mk({ workflow: true, ai: { cooldownMs: 0 } })
            const viaJson = await ad.callJson('q', opsCheckJson, { spec: { use: 'w:slow' }, minAttemptMs: 10 })
            assert.equal(viaJson.ok, false)
            assert.match(viaJson.error, /^TIMEOUT/)
            const { use, fallback, ...more } = ad.seatSpec({ use: 'w:slow', timeoutMs: 3000, minAttemptMs: 10 }, 1)
            const r = await ad.getWkf().callAi('q', { spec: { use, fallback }, ...more, check: opsCheck })
            assert.deepEqual([r.ok, r.providerId], [true, 'w:slow'], r.error)
            const s2 = ad.seatSpec({ use: 'w:slow', minAttemptMs: 10 }, 1)
            assert.equal(s2.timeoutMs, 100, '席位未給:取條目之逾時')
            const { use: u2, fallback: f2, ...m2 } = s2
            const r2 = await ad.getWkf().callAi('q', { spec: { use: u2, fallback: f2 }, ...m2, check: opsCheck })
            assert.deepEqual([r2.ok, r2.errorType], [false, 'timeout'], '由 seatSpec 帶入之條目逾時生效')
        })
    })

    describe('斷網不計(規則⑤)', function() {

        const askCounter = (answer) => {
            const box = { n: 0 }
            box.fn = async () => {
                box.n++
                if (answer instanceof Error) throw answer
                return answer
            }
            return box
        }

        // 詢問次數:isNetDown 另轉交遞補層為 envDown(設計 da402 §4.2〈CA〉4)——遞補層於每個整鏈皆敗(有實際嘗試)之名額詢問一次以決定 n 與連敗是否落定;
        //   工作流之單棒結果不帶 envDown 欄,本入口另於失敗時詢問一次以標記。故整鏈皆敗之 callAi 共詢問 2 次(遞補層 1、本入口 1)
        it('callAi:整鏈皆敗且 isNetDown 回 true → { ...原結果, ok:false, skipped:true, netDown:true }(本入口詢問一次＋遞補層一次);回 false／拋錯／非 true → 原失敗結果', async () => {
            const spec = { use: 'w:dead', fallback: ['w:plain'] }
            const down = askCounter(true)
            const ad = mk({ workflow: true, isNetDown: down.fn })
            const { r } = await callTry(ad, spec)
            assert.deepEqual([r.ok, r.skipped, r.netDown, down.n], [false, true, true, 2])
            assert.equal(r.tried.length, 2, '兩家皆已實際送出(原結果之欄位保留)')
            assert.equal(r.tried[0].errorType, 'fetch', '死埠連線被拒')
            for (const answer of [false, 'yes', new Error('判斷失敗')]) {
                const box = askCounter(answer)
                const { r: r2 } = await callTry(mk({ workflow: true, isNetDown: box.fn }), spec)
                assert.equal(box.n, 2, `${String(answer)}:有詢問(遞補層與本入口各一次)`)
                assert.deepEqual([r2.ok, 'skipped' in r2, 'netDown' in r2], [false, false, false], `${String(answer)}:原失敗結果`)
                assert.equal(r2.error, r.error, '錯誤訊息不改')
            }
            const noAsk = await callTry(mk({ workflow: true }), spec)
            assert.deepEqual(['skipped' in noAsk.r, 'netDown' in noAsk.r], [false, false], '未給 isNetDown 不判斷')
        })

        it('callAi:成功、未送出即失敗(名稱不合)、時間預算用盡、中止 → 不詢問網路、不標記;整輪截止切斷最後一家 → 本入口不詢問、不標記(遞補層之 envDown 照問一次)', async () => {
            const box = askCounter(true)
            const ad = mk({ workflow: true, isNetDown: box.fn, ai: { cooldownMs: 0 } })
            const ok = await callTry(ad, { use: 'w:ops' })
            assert.equal(ok.r.ok, true)
            const unknown = await callTry(ad, { use: 'nope:x' })
            assert.deepEqual([unknown.r.ok, unknown.r.errorType, unknown.r.tried.length], [false, 'params', 0])
            const budget = await callTry(ad, { use: 'w:dead' }, { budgetMs: 1 })
            assert.deepEqual([budget.r.ok, budget.r.errorType], [false, 'budget'])
            const aborted = await callTry(ad, { use: 'w:dead' }, { shouldStop: () => true })
            assert.deepEqual([aborted.r.ok, aborted.r.errorType], [false, 'aborted'])
            assert.equal(box.n, 0, '以上皆不詢問(遞補層亦不問:無實際嘗試或非整鏈皆敗)')
            let stop = false
            setTimeout(() => {
                stop = true
            }, 60)
            const cut = await callTry(ad, { use: 'w:slow' }, { timeoutMs: 200, minAttemptMs: 10, shouldStop: () => stop })
            assert.deepEqual([cut.r.ok, cut.r.errorType], [false, 'timeout'], '被整輪截止切斷之最後一家:上游回逾時')
            assert.equal(box.n, 1, '本入口不問(整輪已截止);遞補層於整鏈皆敗時以 envDown 問一次(決定 n 與連敗是否落定)')
            for (const x of [ok, unknown, budget, aborted, cut]) assert.equal('netDown' in x.r, false)
        })

        it('runFanout:各席皆敗且不通 → 回傳標 netDown:true、整鏈皆敗之席位標 skipped／netDown(預算用盡之席不標);通 → 原結果;有一席成交 → 不詢問', async () => {
            const task = { task: 'q', check: opsCheck, minCandidates: 99 }
            const down = askCounter(true)
            const ad = mk({ workflow: true, isNetDown: down.fn })
            const r = await ad.getWkf().runFanout({ ...task, agents: [{ use: 'w:dead' }, { use: 'w:plain' }, { use: 'w:dead', budgetMs: 1 }] })
            assert.equal(r.ok, false)
            assert.equal(r.netDown, true)
            assert.equal(down.n, 3, '本入口詢問一次;遞補層於整鏈皆敗之兩席各問一次(預算用盡之席無實際嘗試,不問)')
            assert.deepEqual(r.agents.map((a) => [a.ok, a.skipped === true, a.netDown === true, a.errorType]), [[false, true, true, 'fetch'], [false, true, true, 'validation'], [false, false, false, 'budget']])
            const up = askCounter(false)
            const r2 = await mk({ workflow: true, isNetDown: up.fn }).getWkf().runFanout({ ...task, agents: [{ use: 'w:dead' }, { use: 'w:plain' }] })
            assert.deepEqual([r2.ok, 'netDown' in r2, r2.agents.some((a) => 'netDown' in a), up.n], [false, false, false, 3])
            const part = askCounter(true)
            const r3 = await mk({ workflow: true, isNetDown: part.fn }).getWkf().runFanout({ ...task, agents: [{ use: 'w:ops' }, { use: 'w:dead' }] })
            assert.deepEqual([r3.ok, 'netDown' in r3, part.n], [true, false, 1], '有一席成交:成果可用,本入口不問網路、不標記(整鏈皆敗之席由遞補層問一次)')
            const stopped = askCounter(true)
            const r4 = await mk({ workflow: true, isNetDown: stopped.fn }).getWkf().runFanout({ ...task, agents: [{ use: 'w:dead' }], callOpt: { shouldStop: () => true } })
            assert.deepEqual([r4.ok, 'netDown' in r4, stopped.n], [false, false, 0], '整輪截止(callOpt.shouldStop):不問網路')
        })

        it('runFanout:整合已呼叫而敗且不通 → 整合結果標 skipped／netDown、回傳標 netDown;缺整合規格(設定問題)不詢問', async () => {
            const down = askCounter(true)
            const ad = mk({ workflow: true, isNetDown: down.fn })
            const agents = [{ use: 'w:ops' }, { use: 'w:ops2' }]
            const r = await ad.getWkf().runFanout({ task: 'q', check: opsCheck, agents, integrate: { use: 'w:dead' } })
            assert.deepEqual([r.ok, r.netDown, r.integrateDetail.skipped, r.integrateDetail.netDown, down.n], [false, true, true, true, 2], '本入口一次＋遞補層於整合之整鏈皆敗一次')
            assert.deepEqual(r.agents.map((a) => [a.ok, 'netDown' in a]), [[true, false], [true, false]], '已成交之席位不標')
            const cfg = askCounter(true)
            const r2 = await mk({ workflow: true, isNetDown: cfg.fn }).getWkf().runFanout({ task: 'q', check: opsCheck, agents })
            assert.deepEqual([r2.ok, r2.error, 'netDown' in r2, cfg.n], [false, 'integrate spec (with use) is required', false, 0])
        })
    })

    describe('⑥ 單棒結果 → callJson 之形狀(callJsonShapeOf;評分角色之自訂呼叫與單棒包裝同讀)', function() {

        // 規則:adapter.callJsonShapeOf——嘗試數與失敗摘要與 callJson 同一判準(attemptsOf、errorsOf;驗證失敗附不合格原因)
        it('成功帶 data＝解析之物件;失敗之逐次摘要「條目:錯誤型別(耗時)」,驗證失敗者依序附不合格原因(與 callJson 同字樣);嘗試數只計實際送出者', () => {
            assert.deepEqual(callJsonShapeOf({ ok: true, json: { checks: [] }, providerId: 'p', tried: [{ providerId: 'p', outcome: 'ok' }] }), { ok: true, data: { checks: [] }, error: '', providerId: 'p', attempts: 1, skipped: false, errors: [] })
            const t = callJsonShapeOf({ ok: false, error: 'TIMEOUT', errorType: 'timeout', tried: [{ keyId: 'p#1', providerId: 'p', outcome: 'next-key', errorType: 'timeout', durationMs: 300000 }, { providerId: 'q', outcome: 'budget-out' }] })
            assert.deepEqual([t.attempts, t.skipped, t.errors], [1, false, ['p#1:timeout(300.0s)', 'q:budget-out']])
            const v = callJsonShapeOf({ ok: false, error: 'validation failed', errorType: 'validation', tried: [
                { providerId: 'a', outcome: 'skip-group', errorType: 'validation', durationMs: 1200 },
                { providerId: 'b', outcome: 'skip-group', errorType: 'timeout', durationMs: 3000 },
                { providerId: 'c', outcome: 'skip-group', errorType: 'validation', durationMs: 900 },
            ] }, ['回覆不含 { ops:[…] }', '解析不出含指定鍵之物件'])
            assert.deepEqual(v.errors, ['a:validation(1.2s)：回覆不含 { ops:[…] }', 'b:timeout(3.0s)', 'c:validation(0.9s)：解析不出含指定鍵之物件'], '原因依序對應驗證失敗者(未經驗證之失敗不取原因,後續不錯位)')
            assert.deepEqual(callJsonShapeOf({ ok: false, errorType: 'validation', tried: [{ providerId: 'a', outcome: 'skip-group', errorType: 'validation' }] }).errors, ['a:validation'], '未給原因時只列型別')
        })

        it('未送出(放不下／席位未設)、截止與斷網、預算用盡、中止:skipped 或明示之錯誤字樣;調度層之 skipped(斷網)照收', () => {
            assert.match(callJsonShapeOf({ ok: false, oversize: true, error: 'oversize' }).error, /提示詞超過受測條目之上限/)
            assert.match(callJsonShapeOf({ ok: false, unset: true, error: '席位未設' }).error, /席位未設/)
            // 工作流結果之斷網旗標與新結局(外審 terra F10／T08):netDown 保留;budget-cut／context-too-long 計入嘗試、被封頂者標 budget-cut
            const wn = callJsonShapeOf({ ok: false, error: 'TIMEOUT after 1s', errorType: 'timeout', skipped: true, netDown: true, tried: [{ providerId: 'a', outcome: 'skip-group', errorType: 'timeout', durationMs: 1000 }] })
            assert.deepEqual([wn.skipped, wn.netDown, wn.attempts], [true, true, 1])
            assert.equal('netDown' in callJsonShapeOf({ ok: false, error: 'x', tried: [] }), false, '非斷網不帶 netDown')
            const cut = callJsonShapeOf({ ok: false, error: 'budget exhausted', errorType: 'budget', tried: [{ providerId: 'a', outcome: 'skip-group', errorType: 'validation', durationMs: 500 }, { providerId: 'b', outcome: 'budget-cut', errorType: 'timeout', durationMs: 1200 }, { providerId: 'c', outcome: 'context-too-long', errorType: 'http', durationMs: 100 }] }, ['回覆不合'])
            assert.deepEqual([cut.skipped, cut.attempts, cut.errors], [true, 3, ['a:validation(0.5s)：回覆不合', 'b:budget-cut(1.2s)', 'c:http(0.1s)']])
            const nd = callJsonShapeOf({ ok: false, error: 'stopped', stopped: true, netDown: true, cause: 'fetch failed' })
            assert.deepEqual([nd.skipped, nd.error], [true, '中止（本機網路不通：fetch failed）'])
            assert.equal(callJsonShapeOf({ ok: false, error: 'stopped', stopped: true }).error, '中止（截止或預算用盡）')
            assert.equal(callJsonShapeOf({ ok: false, error: 'x', errorType: 'budget' }).skipped, true)
            assert.equal(callJsonShapeOf({ ok: false, error: 'x', errorType: 'aborted' }).skipped, true)
            assert.equal(callJsonShapeOf({ ok: false, error: 'x', skipped: true, netDown: true }).skipped, true)
            assert.deepEqual(callJsonShapeOf(null), { ok: false, data: null, error: '呼叫失敗', providerId: '', attempts: 0, skipped: false, errors: [] })
        })
    })
})
