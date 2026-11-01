// unit-ai-adapter.test.mjs — 精簡 AI 調度層(core/ai/adapter)之真實呼叫路徑:本機假 OpenAI 相容 REST(固定埠 8828)走真實 fetch 與真實 w-dispatch-ai,不連外網
// 規則(出自 adapter 檔頭):
//   ①callJson 不拋錯,一律回 { ok, data, error, providerId, attempts, skipped, errors };check 回 true 才合格,回字串(不合格原因)或其他值或拋錯皆不合格並交遞補
//   ②skipped:true 表「不是這次之失敗」(時間預算用盡、中止、本機網路不通),呼叫端不計次
//   ③限流／額度用盡字樣只在執行層失敗(非內容型失敗)時才冷卻:移到鏈尾不移除,任一次成功即解除;狀態收在實例閉包,多實例互不相踩
//   ④逾時三層取值 providerTimeouts 逐 id > 條目自帶 timeoutMs > ai.timeoutMs,席位 timeoutMs 覆寫該席位鏈內各條目;預算與實際派送讀同一個數字
//   ⑤席位於啟動期檢核(validateSeats):未知 id、缺金鑰、形狀錯一律拋錯,訊息彙整全部問題席位
//   ⑥金鑰來源 env 物件 > envFile > process.env;ai.extraProviders 新 id 追加、同 id 逐欄覆蓋;預設席位(settings.capture.discover.ai)於內建目錄皆可解析;
//     settings.ai 內無席位,callJson 之席位只由 callOpt.spec 給(未給即「席位無法解析」)
//   ⑦子進程工作目錄於每次派送前確保存在;送出之提示詞加防寫前綴;條目自帶 validate 與本層驗證取交集
//   ⑧高頻呼叫之機制(acceptTruncated、preview、capability、ai.pools、ai.healthStreak、ai.providerLimits)預設全關:未給或預設值時結果形狀、
//     截斷判定、鏈序、席位警告與實績彙總同上列各條(開啟後之行為見 unit-ai-adapter-ext)
//   ⑨回覆取最後一段合格之 JSON(core/ai/jsonReply 之 pickJsonReply):完整片段由後往前,取第一段 check === true 者——自我更正取後者、
//     前言之括號不被取、尾隨之小片段由 check 篩掉;皆不合格者 errors 附段數與末段之原因;check 每次嘗試只呼叫一輪(成交後不再呼叫)
// 執行:自套件根 npx mocha test/unit-ai-adapter.test.mjs(暫存 test/_tmp/ai-adapter-<pid>,測完即刪;埠 8828 為假 REST、8830 為無人監聽之死埠)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import NO_SIDE_EFFECT from 'w-dispatch-ai/src/wkf/noSideEffectPrefix.mjs'
import providersAll from 'w-dispatch-ai/src/providers.mjs'
import dispatchAiFallback from 'w-dispatch-ai/src/dispatchAiFallback.mjs'
import budgetFor from 'w-dispatch-ai/src/budgetFor.mjs'
import { createAiAdapter, LIMIT_TEXT_RE } from '../src/core/ai/adapter.mjs'
import { AI_DEFAULT, resolveSettings } from '../src/core/settingsDefault.mjs'
import { createNetGuard } from '../src/core/util/netGuard.mjs'
import { buildRunSummary } from '../src/core/ops/runSummary.mjs'
import { tmpRoot } from './tools/captureTestKit.mjs'
import { removeRoots, sleep } from './tools/testKit.mjs'

// 暫存根(套件內 test/_tmp/ai-adapter-<pid>;before 建立、after 清除)
let TMP = ''
const PORT = 8828 // 假 REST(固定埠,≥8000、不隨機;本檔專屬)
const DEAD_PORT = 8830 // 無人監聽之死埠(連線即被拒)
const BASE = `http://127.0.0.1:${PORT}/v1`
const DEAD_BASE = `http://127.0.0.1:${DEAD_PORT}/v1`
const KEY_VAR = 'CAPTURE_TEST_KEYS_8828'


// ── 假伺服器:依請求之 model 決定情境(「情境~延遲毫秒」);依 Bearer 金鑰決定 keyed 之成敗 ──
const SCENES = {
    ok: { fr: 'stop', content: '前言\n```json\n[{"index":1,"covered":true,"why":"x"}]\n```' },
    ok2: { fr: 'stop', content: '[{"index":2,"covered":false,"why":"y"}]' },
    plain: { fr: 'stop', content: '這不是 JSON' },
    obj: { fr: 'stop', content: '{"a":1}' },
    cut: { fr: 'stop', content: '[{"index":1,"covered":true,"wh' }, // 拿不到終止訊號之截斷(括號未閉合)
    trunc: { fr: 'length', content: '[{"index":1,"covered":true,"why":"x"}]' }, // JSON 完整但回報被截斷
    ratetext: { fr: 'stop', content: '本文討論 API 的 rate limit 與 quota exceeded 之應對方式。' }, // 內容談及限流字樣(非 JSON)
    sltext: { fr: 'stop', content: '本文引用「You\'ve hit your session limit · resets 10:30am」作為範例。' },
    // 截斷而前段有完整項目(擴充 opt 預設關閉之對照用):cutk 拿不到終止訊號(stop)、trunck 回報 length
    cutk: { fr: 'stop', content: '[{"index":1,"covered":true,"why":"x"},{"index":2,"cov' },
    trunck: { fr: 'length', content: '[{"index":1,"covered":true,"why":"x"},{"index":2,"cov' },
    // 回覆含多段 JSON(規則⑨):自我更正、前言之括號、尾隨說明之小片段、皆不合格
    multi: { fr: 'stop', content: '[{"index":1,"covered":true,"why":"x"}]\n等等，我漏了一項，更正如下：\n[{"index":1,"covered":true,"why":"x"},{"index":2,"covered":false,"why":"y"}]' },
    pre: { fr: 'stop', content: '依意見 [3] 整理如下：\n[{"index":1,"covered":true,"why":"x"}]' },
    tail: { fr: 'stop', content: '[{"index":1,"covered":true,"why":"x"}]\n註：第 1 項見原文 [3]' },
    twobad: { fr: 'stop', content: '[3]\n{"a":1}' },
}
const hits = [] // 每次請求 { model, scene, key, content }

/**
 * 假伺服器處理器
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
        const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
        const model = String(body.model || '')
        const [scene, delay] = model.split('~')
        const content = String(body.messages?.[body.messages.length - 1]?.content || '')
        hits.push({ model, scene, key, content })
        if (Number(delay)) await sleep(Number(delay))
        if (res.destroyed || res.writableEnded) return
        try {
            if (scene === 'limit') {
                res.writeHead(429, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }))
                return
            }
            if (scene === 'rl503') {
                res.writeHead(503, { 'Content-Type': 'application/json' })
                res.end('{"error":"rate limit exceeded, retry later"}')
                return
            }
            if (scene === 'sl500' || scene === 'x500') {
                // sl500:本體為 Claude Code 額度用盡之原文(只在 stdout);x500:同狀態碼無字樣(對照)
                res.writeHead(500, { 'Content-Type': 'text/plain' })
                res.end(scene === 'sl500' ? 'You\'ve hit your session limit · resets 10:30am (Asia/Taipei)' : 'internal error')
                return
            }
            if (scene === 'keyed' && key !== 'good') {
                res.writeHead(401, { 'Content-Type': 'application/json' })
                res.end('{"message":"invalid key"}')
                return
            }
            const sc = SCENES[scene === 'keyed' ? 'ok' : scene] || SCENES.plain
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ id: 'fake', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: sc.content }, finish_reason: sc.fr }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
        }
        catch { /* 連線已被中止 */ }
    })
}

const rest = (id, model, extra = {}) => ({ id, kind: 'api-openai-compat', baseURL: BASE, model, ...extra })
const CAT = [
    rest('fake:ok', 'ok'),
    rest('fake:ok2', 'ok2'),
    rest('fake:plain', 'plain'),
    rest('fake:obj', 'obj'),
    rest('fake:cut', 'cut'),
    rest('fake:trunc', 'trunc'),
    rest('fake:limit', 'limit'),
    rest('fake:rl503', 'rl503'),
    rest('fake:sl500', 'sl500'),
    rest('fake:x500', 'x500'),
    rest('fake:ratetext', 'ratetext'),
    rest('fake:sltext', 'sltext'),
    rest('fake:keyed', 'keyed', { envVar: KEY_VAR }),
    rest('fake:okkeyed', 'ok', { envVar: KEY_VAR }),
    rest('fake:plainv', 'plain', { validate: 'nonempty' }), // 條目自帶 validate
    { id: 'fake:dead', kind: 'api-openai-compat', baseURL: DEAD_BASE, model: 'ok' }, // 死埠:連線被拒
    rest('fake:multi', 'multi'),
    rest('fake:pre', 'pre'),
    rest('fake:tail', 'tail'),
    rest('fake:twobad', 'twobad'),
]
const arrCheck = (d) => (Array.isArray(d) ? true : '須為 JSON 陣列')
// 驗到項目之形狀(至少一項帶整數 index;規則⑨:取最後一段時 check 是唯一之篩選)
const idxCheck = (d) => (Array.isArray(d) && d.some((x) => Number.isInteger(x?.index)) ? true : '無帶整數 index 之項')

let seq = 0

/**
 * 建立一個 adapter(每個測試各自一個,游標／冷卻／用量互不干擾);ai 為覆寫 settings.ai 之鍵
 * (settings.ai 之鍵見 AI_SCHEMA,席位不在其內:由 callJson 之 callOpt.spec 給)
 *
 * @param {Object} [o={}] 輸入 { ai, ...createAiAdapter 之其他選項 }
 * @returns {Object} 回傳 adapter
 */
const mk = (o = {}) => {
    const { ai, ...rest2 } = o
    return createAiAdapter({
        ai: { ...AI_DEFAULT, ...(ai || {}) },
        workspace: `${TMP}/ws-${++seq}`,
        env: {},
        catalogue: CAT,
        ...rest2,
    })
}

describe('unit-ai-adapter', function() {

    this.timeout(60_000)

    let server = null

    before(async function() {
        TMP = tmpRoot('ai-adapter')
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

    describe('建構與必填檢查', function() {

        it('opt 非物件、缺 ai 或缺 workspace → 拋錯(訊息指出須給 ai 與 workspace,金鑰以 envFile 或 env 給)', () => {
            const re = /需要 \{ ai\(settings\.ai\), workspace\(AI 子進程工作目錄\) \}；金鑰以 envFile 或 env 給/
            for (const bad of [null, undefined, 42, 'x', [], true]) assert.throws(() => createAiAdapter(bad), re, `opt=${String(bad)}`)
            assert.throws(() => createAiAdapter({ workspace: TMP }), re, '缺 ai')
            assert.throws(() => createAiAdapter({ ai: 'x', workspace: TMP }), re, 'ai 非物件')
            assert.throws(() => createAiAdapter({ ai: {} }), re, '缺 workspace')
            assert.throws(() => createAiAdapter({ ai: {}, workspace: '' }), re, 'workspace 空字串')
        })

        it('envFile 須為路徑字串、env 須為物件;null 視為未給', () => {
            assert.throws(() => createAiAdapter({ ai: {}, workspace: TMP, envFile: 1 }), /envFile 須為金鑰檔路徑字串/)
            assert.throws(() => createAiAdapter({ ai: {}, workspace: TMP, env: 'x' }), /env 須為物件/)
            assert.throws(() => createAiAdapter({ ai: {}, workspace: TMP, env: [] }), /env 須為物件/)
            assert.doesNotThrow(() => createAiAdapter({ ai: {}, workspace: TMP, envFile: null, env: null, catalogue: CAT }))
        })

        it('回傳 { callJson, validateSeats, chainFor, drainStats, recordCall, aiUsageToday, available }', () => {
            const ad = mk()
            assert.deepEqual(Object.keys(ad).sort(), ['aiUsageToday', 'available', 'callJson', 'chainFor', 'drainStats', 'recordCall', 'validateSeats'])
            for (const k of Object.keys(ad)) assert.equal(typeof ad[k], 'function', k)
        })

        it('ai.extraProviders 給了但非陣列、條目非物件或缺 id → 建構期拋錯(不靜默略過);undefined／null 視為 []', () => {
            assert.throws(() => mk({ ai: { extraProviders: 'x' } }), /ai\.extraProviders 須為陣列/)
            assert.throws(() => mk({ ai: { extraProviders: { id: 'a' } } }), /ai\.extraProviders 須為陣列/)
            assert.throws(() => mk({ ai: { extraProviders: [{ kind: 'x' }] } }), /ai\.extraProviders\[0\] 須為含 id 之條目物件/)
            assert.throws(() => mk({ ai: { extraProviders: [{ id: 'a' }, 'b'] } }), /ai\.extraProviders\[1\] 須為含 id 之條目物件/)
            assert.doesNotThrow(() => mk({ ai: { extraProviders: null } }))
            assert.doesNotThrow(() => mk({ ai: { extraProviders: undefined } }))
        })
    })

    describe('LIMIT_TEXT_RE(目錄合併屬執行殼之 resolveCatalogue,其逐案在執行殼)', function() {

        it('LIMIT_TEXT_RE 只收實際觀察到之限流／額度用盡字樣,不誤判一般字樣', () => {
            for (const t of ['FreeUsageLimitError', 'rate limit exceeded', 'ratelimit', 'rate-limit', 'quota exceeded', 'Too Many Requests', 'usage limit reached', 'session limit reached', 'You\'ve hit your session limit · resets 10:30am', 'You\'ve hit your weekly limit', 'HTTP 429']) {
                assert.ok(LIMIT_TEXT_RE.test(t), `應命中:${t}`)
            }
            for (const t of ['ok', 'internal error', 'the speed limit is 60', 'session timeout', 'HTTP 500', '']) assert.ok(!LIMIT_TEXT_RE.test(t), `不應命中:${t}`)
        })
    })

    describe('席位解析與啟動期檢核', function() {

        it('預設席位(settings.capture.discover.ai)於 w-dispatch-ai 內建目錄皆可解析(免金鑰之 opencode CLI 條目):零設定組裝不因目錄輪替而拋錯;不呼叫任何 CLI', () => {
            const st = resolveSettings({})
            const seat = st.capture.discover.ai
            const ad = createAiAdapter({ ai: st.ai, workspace: `${TMP}/ws-default`, env: {} })
            assert.deepEqual(ad.validateSeats({ 'capture.discover.ai': seat }), { ok: true, warnings: [] })
            const chain = ad.chainFor(seat)
            assert.deepEqual(chain.map((e) => e.id), [seat.use, ...seat.fallback])
            for (const e of chain) {
                assert.equal(e.kind, 'opencode', `${e.id} 為 CLI 條目`)
                assert.equal(e.keys, undefined, `${e.id} 免金鑰`)
                // 逾時依三層取值:未於 providerTimeouts 列出者取目錄條目自帶值,再無則取 ai.timeoutMs
                assert.equal(e.timeoutMs, providersAll.find((p) => p.id === e.id)?.timeoutMs ?? AI_DEFAULT.timeoutMs, `${e.id} 之逾時`)
            }
            assert.deepEqual(ad.available().skipped.filter((x) => chain.some((e) => e.id === x.id)), [], '預設席位不因缺金鑰而停用')
        })

        it('validateSeats:未知 id 附最接近之拼寫提示、缺金鑰附變數名、未知席位鍵、數值鍵非正數;合格回 { ok:true, warnings:[] }', () => {
            const ad = mk()
            assert.throws(() => ad.validateSeats({ 'capture.discover.ai': { use: 'fake:plian' } }), /^Error: AI 席位於啟動期檢核失敗（1 席）：capture\.discover\.ai → 席位引用了不可用的條目：fake:plian（內建目錄與 ai\.extraProviders 皆無；最接近：fake:plain）/)
            assert.throws(() => ad.validateSeats({ s: { use: 'fake:keyed' } }), /fake:keyed（缺金鑰 CAPTURE_TEST_KEYS_8828）/)
            assert.throws(() => ad.validateSeats({ s: { use: 'fake:ok', foo: 1 } }), /s → 含不認得之鍵：foo（可用：/)
            assert.throws(() => ad.validateSeats({ s: { use: 'fake:ok', timeoutMs: 0 } }), /timeoutMs 須為正數（毫秒）/)
            assert.deepEqual(ad.validateSeats({ s: { use: 'fake:ok', fallback: ['fake:plain'], timeoutMs: 5000, minAttemptMs: 100, budgetMs: 9000 } }), { ok: true, warnings: [] })
            assert.deepEqual(ad.validateSeats({}), { ok: true, warnings: [] }, '無席位即無問題')
            assert.deepEqual(ad.validateSeats(null), { ok: true, warnings: [] })
        })

        it('validateSeats 彙整全部問題席位於一則訊息(逐席列出原因),不止於第一個', () => {
            const ad = mk()
            let msg = ''
            try {
                // 形狀錯之席位排在前、無法解析者在後、合格者居中:任一種問題都不得中斷後續席位之檢核
                ad.validateSeats({ c: { use: 'fake:ok', fallback: 'x' }, b: { use: 'fake:ok' }, a: { use: 'nope:1' }, d: { use: 'fake:ok', foo: 1 } })
            }
            catch (e) {
                msg = e.message
            }
            assert.match(msg, /（3 席）/)
            assert.match(msg, /a → 席位引用了不可用的條目：nope:1/)
            assert.match(msg, /c → fallback 須為條目 id 之字串陣列/)
            assert.match(msg, /d → 含不認得之鍵：foo（可用：/)
            assert.doesNotMatch(msg, /b →/, '合格之席位不列入')
        })

        it('chainFor:use 於前、fallback 依序、重複者去除(首選同時出現在遞補鏈時不重試同一家);缺 use 拋錯', () => {
            const ad = mk()
            assert.deepEqual(ad.chainFor({ use: 'fake:ok', fallback: ['fake:ok2', 'fake:ok', 'fake:plain'] }).map((e) => e.id), ['fake:ok', 'fake:ok2', 'fake:plain'])
            assert.throws(() => ad.chainFor({}), /席位缺 use/)
            assert.throws(() => ad.chainFor(null), /席位缺 use/)
            // 席位形狀(use 必給)由 seatProblem 把關:啟動期檢核與 callJson 皆先檢
            assert.throws(() => ad.validateSeats({ s: { fallback: ['fake:ok'] } }), /s → use 須為非空字串/)
        })

        it('逾時三層取值:providerTimeouts 逐 id > 條目自帶 timeoutMs > ai.timeoutMs;席位 timeoutMs 覆寫鏈內各條目;預算＝各條目逾時之總和', () => {
            const ad = createAiAdapter({
                ai: { timeoutMs: 1000, providerTimeouts: { 'fake:ok2': 2000 } },
                workspace: `${TMP}/ws-t`,
                env: {},
                catalogue: [...CAT, rest('fake:own', 'ok', { timeoutMs: 3000 }), rest('fake:both', 'ok', { timeoutMs: 100 })],
            })
            assert.deepEqual(ad.chainFor({ use: 'fake:ok', fallback: ['fake:ok2', 'fake:own'] }).map((e) => e.timeoutMs), [1000, 2000, 3000])
            const pt = createAiAdapter({ ai: { timeoutMs: 1000, providerTimeouts: { 'fake:both': 7000 } }, workspace: `${TMP}/ws-t`, env: {}, catalogue: [rest('fake:both', 'ok', { timeoutMs: 100 })] })
            assert.equal(pt.chainFor({ use: 'fake:both' })[0].timeoutMs, 7000, '逐 id 優先於條目自帶值')
            const chain = ad.chainFor({ use: 'fake:ok', fallback: ['fake:ok2'], timeoutMs: 1234 })
            assert.deepEqual(chain.map((e) => e.timeoutMs), [1234, 1234], '席位 timeoutMs 覆寫鏈內各條目')
            assert.equal(budgetFor(chain), 2468, '預算讀同一個數字')
            assert.deepEqual(ad.chainFor({ use: 'fake:ok', timeoutMs: 0 }).map((e) => e.timeoutMs), [1000], '非正數之席位逾時不生效')
        })
    })

    describe('callJson 成功與遞補', function() {

        it('成功:code fence 內之 JSON 寬鬆抽取、回 { ok, data, error, providerId, attempts, skipped, errors };席位由 callOpt.spec 給', async () => {
            const ad = mk()
            const r = await ad.callJson('請回 JSON', arrCheck, { spec: { use: 'fake:ok' } })
            assert.deepEqual(r, { ok: true, data: [{ index: 1, covered: true, why: 'x' }], error: '', providerId: 'fake:ok', attempts: 1, skipped: false, errors: [] })
            assert.equal(hits.length, 1)
        })

        it('送出之提示詞前加防寫前綴(agentic CLI 會順手寫檔),其後為原提示詞', async () => {
            await mk().callJson('請只回覆 JSON 陣列', arrCheck, { spec: { use: 'fake:ok' } })
            assert.ok(NO_SIDE_EFFECT.length > 0)
            assert.equal(hits[0].content, `${NO_SIDE_EFFECT}請只回覆 JSON 陣列`)
        })

        it('遞補:前家非 JSON → check 不被呼叫、換下一家,attempts 為實際送出次數;失敗後成功時 errors 為空陣列', async () => {
            const ad = mk()
            let called = 0
            const r = await ad.callJson('q', (d) => {
                called++
                return arrCheck(d)
            }, { spec: { use: 'fake:plain', fallback: ['fake:obj', 'fake:ok'] } })
            assert.equal(r.ok, true)
            assert.equal(r.providerId, 'fake:ok')
            assert.equal(r.attempts, 3, 'plain、obj(check 回字串)、ok 各送一次')
            assert.deepEqual(r.errors, [])
            assert.equal(called, 2, '非 JSON 者不進 check(obj 與 ok 各一次)')
            assert.deepEqual(hits.map((h) => h.scene), ['plain', 'obj', 'ok'])
        })

        it('全鏈不合格:errors 逐家列「條目:錯誤型別(耗時)：原因」(check 回字串者附其原因;非 JSON 附固定說明);ok:false、skipped:false', async () => {
            const ad = mk()
            const r = await ad.callJson('q', arrCheck, { spec: { use: 'fake:plain', fallback: ['fake:obj'] } })
            assert.equal(r.ok, false)
            assert.equal(r.skipped, false)
            assert.equal(r.data, null)
            assert.equal(r.providerId, '')
            assert.equal(r.attempts, 2)
            assert.equal(r.error, 'OUTPUT_VALIDATION_FAILED')
            assert.match(r.errors[0], /^fake:plain:validation\(\d+\.\ds\)：非 JSON（或輸出截斷）$/)
            assert.match(r.errors[1], /^fake:obj:validation\(\d+\.\ds\)：須為 JSON 陣列$/)
        })

        it('check 只認 === true:回字串、其他 truthy、false、undefined 皆不合格並換家;check 拋錯不外拋、記入原因', async () => {
            const ad = mk()
            for (const ret of ['truthy-but-not-true', 1, {}, false, undefined, null]) {
                const r = await ad.callJson('q', () => ret, { spec: { use: 'fake:ok' } })
                assert.equal(r.ok, false, `check 回 ${String(ret)} 不得放行`)
            }
            const bad = await ad.callJson('q', () => 'check 自述之原因', { spec: { use: 'fake:ok' } })
            assert.match(bad.errors[0], /：check 自述之原因$/)
            const thrown = await ad.callJson('q', () => {
                throw new Error('壞了')
            }, { spec: { use: 'fake:ok', fallback: ['fake:ok2'] } })
            assert.equal(thrown.ok, false)
            assert.equal(thrown.errors.length, 2, '拋錯視同不合格而交遞補,不中斷整條鏈')
            assert.match(thrown.errors[0], /check 拋錯：壞了/)
        })

        it('回覆含多段 JSON(規則⑨):自我更正取後者;前言之括號不被取;尾隨之小片段由 check 篩掉(只驗「是陣列」之 check 會取到它);check 每次嘗試只呼叫一輪', async () => {
            const ad = mk()
            let called = 0
            const counted = (d) => {
                called++
                return idxCheck(d)
            }
            const m = await ad.callJson('q', counted, { spec: { use: 'fake:multi' } })
            assert.deepEqual([m.ok, m.providerId, m.data.map((x) => x.index)], [true, 'fake:multi', [1, 2]], '取更正後之那段')
            assert.equal(called, 1, '末段即合格:只驗一次;成交後取用驗證時記下之段,不再呼叫 check')
            const p = await ad.callJson('q', idxCheck, { spec: { use: 'fake:pre' } })
            assert.deepEqual(p.data, [{ index: 1, covered: true, why: 'x' }], '前言之 [3] 不被取')
            const p2 = await ad.callJson('q', arrCheck, { spec: { use: 'fake:pre' } })
            assert.equal(p2.data.length, 1, '前言之括號在前:只驗「是陣列」亦取到正式輸出')
            const t = await ad.callJson('q', idxCheck, { spec: { use: 'fake:tail' } })
            assert.deepEqual(t.data, [{ index: 1, covered: true, why: 'x' }], '尾隨之 [3] 不過 check,往前取')
            const t2 = await ad.callJson('q', arrCheck, { spec: { use: 'fake:tail' } })
            assert.deepEqual(t2.data, [3], '對照:check 只驗「是陣列」時取到尾隨之小片段——check 須驗到項目之形狀')
        })

        it('回覆含多段 JSON 而皆不合格(規則⑨):換家;errors 附段數與末段之原因', async () => {
            const ad = mk()
            const r = await ad.callJson('q', idxCheck, { spec: { use: 'fake:twobad', fallback: ['fake:ok'] } })
            assert.deepEqual([r.ok, r.providerId, r.attempts], [true, 'fake:ok', 2])
            const f = await ad.callJson('q', idxCheck, { spec: { use: 'fake:twobad' } })
            assert.equal(f.ok, false)
            assert.match(f.errors[0], /^fake:twobad:validation\(\d+\.\ds\)：回覆含 2 段 JSON，皆未通過（末段：無帶整數 index 之項）$/)
        })

        it('截斷一律不放行:括號未閉合之輸出(不搶救半成品)與 finish_reason=length(即使 JSON 完整)皆換家;無遞補即失敗', async () => {
            const ad = mk()
            const cut = await ad.callJson('q', arrCheck, { spec: { use: 'fake:cut' } })
            assert.equal(cut.ok, false)
            assert.match(cut.errors[0], /^fake:cut:validation\(\d+\.\ds\)：非 JSON（或輸出截斷）$/)
            const trunc = await ad.callJson('q', arrCheck, { spec: { use: 'fake:trunc' } })
            assert.equal(trunc.ok, false)
            assert.match(trunc.errors[0], /^fake:trunc:incomplete\(/)
            const fb = await ad.callJson('q', arrCheck, { spec: { use: 'fake:trunc', fallback: ['fake:ok'] } })
            assert.equal(fb.ok, true)
            assert.equal(fb.providerId, 'fake:ok')
            assert.equal(fb.attempts, 2)
        })

        it('條目自帶 validate 與本層驗證取交集:條目 validate 通過而內容非 JSON 者不得放行(上游以條目覆寫共用 validate,不取交集即放行)', async () => {
            const ad = mk()
            const r = await ad.callJson('q', arrCheck, { spec: { use: 'fake:plainv' } })
            assert.equal(r.ok, false, '非 JSON 不得因條目 validate:nonempty 而成功')
            assert.match(r.errors[0], /^fake:plainv:validation\(\d+\.\ds\)：非 JSON（或輸出截斷）$/)
            const fb = await ad.callJson('q', arrCheck, { spec: { use: 'fake:plainv', fallback: ['fake:ok'] } })
            assert.equal(fb.ok, true)
            assert.equal(fb.providerId, 'fake:ok')
            // 前提(上游行為):同一條目直接交 dispatchAiFallback 時,條目之 validate 覆寫共用 validate,非 JSON 被放行——此即本層須取交集之原因
            const entry = ad.chainFor({ use: 'fake:plainv' })[0]
            const strict = (s) => {
                try {
                    return Array.isArray(JSON.parse(s))
                }
                catch {
                    return false
                }
            }
            const up = await dispatchAiFallback('q', { providers: [entry], validate: strict })
            assert.equal(up.ok, true, '前提不成立即表示上游已改行為,本層之交集可重新評估')
        })

        it('不拋錯:prompt 非字串或空、check 非函數、callOpt 非物件(視為 {})、席位無法解析 → 一律回失敗形狀;無預設席位,未給 callOpt.spec 即「席位無法解析」', async () => {
            const ad = mk()
            const shape = { ok: false, data: null, providerId: '', attempts: 0, skipped: false, errors: [] }
            for (const prompt of ['', 123, null, undefined, {}]) {
                const r = await ad.callJson(prompt, arrCheck)
                assert.deepEqual({ ...r, error: undefined }, { ...shape, error: undefined })
                assert.equal(r.error, 'callJson 需要 prompt（非空字串）與 check（函數）')
            }
            assert.equal((await ad.callJson('q', 'not-fn')).error, 'callJson 需要 prompt（非空字串）與 check（函數）')
            // callOpt 非物件視為 {}:不拋錯,而因無預設席位(席位只由 callOpt.spec 給)回「席位無法解析」且未送出
            for (const callOpt of [null, 'x', 5, []]) {
                const r = await ad.callJson('q', arrCheck, callOpt)
                assert.equal(r.ok, false, `callOpt=${JSON.stringify(callOpt)} 視為 {}`)
                assert.match(r.error, /^席位無法解析：席位須為物件/, `callOpt=${JSON.stringify(callOpt)} 視為 {}`)
            }
            assert.equal(hits.length, 0, '席位無法解析者未送出')
            const unknown = await ad.callJson('q', arrCheck, { spec: { use: 'nope:x' } })
            assert.match(unknown.error, /^席位無法解析：席位引用了不可用的條目：nope:x/)
            assert.equal(unknown.attempts, 0)
            assert.match((await ad.callJson('q', arrCheck, { spec: { use: 'fake:ok', foo: 1 } })).error, /^席位無法解析：含不認得之鍵：foo（可用：/)
            assert.match((await ad.callJson('q', arrCheck, { spec: {} })).error, /^席位無法解析：use 須為非空字串/)
            assert.match((await ad.callJson('q', arrCheck, { spec: { fallback: ['fake:ok'] } })).error, /^席位無法解析：use 須為非空字串/, '缺 use 而有 fallback 亦不成鏈')
            const noSeat = createAiAdapter({ ai: {}, workspace: `${TMP}/ws-noseat`, env: {}, catalogue: CAT })
            assert.match((await noSeat.callJson('q', arrCheck)).error, /^席位無法解析：席位須為物件/, '未給 callOpt.spec:無預設席位可退(ai 內無席位)')
            for (const spec of [null, 'x', 5, []]) assert.match((await ad.callJson('q', arrCheck, { spec })).error, /^席位無法解析：席位須為物件/, `spec=${JSON.stringify(spec)} 非物件`)
            assert.equal(hits.length, 0, '席位無法解析者未送出')
        })

        it('子進程工作目錄於每次派送前建立:不存在時建立,被清掉後下一次呼叫再建立', async () => {
            const ws = `${TMP}/ws-fresh/nested/ai-workspace`
            const ad = mk({ workspace: ws })
            assert.equal(fs.existsSync(ws), false)
            assert.equal((await ad.callJson('q', arrCheck, { spec: { use: 'fake:ok' } })).ok, true)
            assert.equal(fs.existsSync(ws), true)
            fs.rmSync(`${TMP}/ws-fresh`, { recursive: true, force: true })
            assert.equal((await ad.callJson('q', arrCheck, { spec: { use: 'fake:ok' } })).ok, true)
            assert.equal(fs.existsSync(ws), true)
        })

        it('事件:本層用量記帳先於呼叫端回呼(回呼內讀得到本次嘗試);回呼拋錯不影響呼叫;事件依 try → 失敗 → try → ok 之序', async () => {
            const ad = mk()
            const seen = []
            const r = await ad.callJson('q', arrCheck, {
                spec: { use: 'fake:plain', fallback: ['fake:ok'] },
                onEvent: (ev) => {
                    seen.push(ev.type)
                    if (ev.type === 'try') seen.push(`used:${ad.aiUsageToday().used}`)
                    throw new Error('回呼壞了')
                },
            })
            assert.equal(r.ok, true)
            assert.deepEqual(seen.filter((t) => ['try', 'skip-group', 'ok'].includes(t) || t.startsWith('used:')), ['try', 'used:1', 'skip-group', 'try', 'used:2', 'ok'])
        })
    })

    describe('金鑰來源與多金鑰', function() {

        it('金鑰來源:env 物件(逗號分隔多把)、envFile(readEnvFile 格式)、皆未給則讀 process.env;缺金鑰之條目不進可用表並列於 available().skipped', () => {
            assert.deepEqual(mk({ env: { [KEY_VAR]: 'k1, k2,' } }).chainFor({ use: 'fake:keyed' })[0].keys, ['k1', 'k2'])
            const envf = `${TMP}/keys.env`
            fs.writeFileSync(envf, `# 註解\n${KEY_VAR}="a1,a2"\n壞行\n`, 'utf8')
            assert.deepEqual(mk({ env: undefined, envFile: envf }).chainFor({ use: 'fake:keyed' })[0].keys, ['a1', 'a2'])
            assert.deepEqual(mk({ env: { [KEY_VAR]: 'fromEnv' }, envFile: envf }).chainFor({ use: 'fake:keyed' })[0].keys, ['fromEnv'], 'env 物件優先於 envFile')
            const old = process.env[KEY_VAR]
            process.env[KEY_VAR] = 'p1'
            try {
                assert.deepEqual(mk({ env: undefined }).chainFor({ use: 'fake:keyed' })[0].keys, ['p1'])
            }
            finally {
                if (old === undefined) delete process.env[KEY_VAR]
                else process.env[KEY_VAR] = old
            }
            const none = mk({ env: undefined, envFile: `${TMP}/not-exist.env` })
            assert.throws(() => none.chainFor({ use: 'fake:keyed' }), /fake:keyed（缺金鑰 CAPTURE_TEST_KEYS_8828）/)
            assert.deepEqual(none.available().skipped, [{ id: 'fake:keyed', envVar: KEY_VAR }, { id: 'fake:okkeyed', envVar: KEY_VAR }])
            assert.ok(!none.available().ids.includes('fake:keyed'))
            assert.ok(none.available().ids.includes('fake:ok'))
        })

        it('多金鑰:成交後游標推進(額度均攤)、金鑰失敗即換組內下一把;不同實例之游標互不相踩', async () => {
            const a = mk({ env: { [KEY_VAR]: 'k1,k2' } })
            const b = mk({ env: { [KEY_VAR]: 'k1,k2' } })
            await a.callJson('q', arrCheck, { spec: { use: 'fake:okkeyed' } })
            await a.callJson('q', arrCheck, { spec: { use: 'fake:okkeyed' } })
            await a.callJson('q', arrCheck, { spec: { use: 'fake:okkeyed' } })
            assert.deepEqual(hits.map((h) => h.key), ['k1', 'k2', 'k1'], '成交一次推進一把,輪替回到首把')
            hits.length = 0
            await b.callJson('q', arrCheck, { spec: { use: 'fake:okkeyed' } })
            assert.deepEqual(hits.map((h) => h.key), ['k1'], '另一實例自首把起(游標不共用)')
            hits.length = 0
            const c = mk({ env: { [KEY_VAR]: 'bad,good' } })
            const r = await c.callJson('q', arrCheck, { spec: { use: 'fake:keyed' } })
            assert.equal(r.ok, true)
            assert.equal(r.attempts, 2)
            assert.deepEqual(hits.map((h) => h.key), ['bad', 'good'], '壞金鑰(401)換下一把')
            const allBad = await mk({ env: { [KEY_VAR]: 'x1,x2' } }).callJson('q', arrCheck, { spec: { use: 'fake:keyed' } })
            assert.equal(allBad.ok, false)
            assert.equal(allBad.error, 'HTTP 401')
            assert.match(allBad.errors[0], /^fake:keyed#0:http\(\d+\.\ds\)$/)
            assert.match(allBad.errors[1], /^fake:keyed#1:http\(\d+\.\ds\)$/)
        })

        it('ai.extraProviders(搭配內建目錄):新 id 追加後可呼叫;同 id 逐欄覆蓋內建條目(可就地改 exe、baseURL 而不等套件發版)', async () => {
            const ad = createAiAdapter({
                ai: { ...AI_DEFAULT, extraProviders: [rest('mine:new', 'ok2'), { id: 'oc:opencode/big-pickle', exe: 'c:/x/opencode.exe', timeoutMs: 4321 }] },
                workspace: `${TMP}/ws-extra`,
                env: {},
            })
            assert.ok(ad.available().ids.includes('mine:new'))
            const r = await ad.callJson('q', arrCheck, { spec: { use: 'mine:new' } })
            assert.equal(r.ok, true)
            assert.deepEqual(r.data, [{ index: 2, covered: false, why: 'y' }])
            const merged = ad.chainFor({ use: 'oc:opencode/big-pickle' })[0]
            assert.equal(merged.exe, 'c:/x/opencode.exe')
            assert.equal(merged.kind, 'opencode', '未給之欄位沿用內建')
            assert.equal(merged.timeoutMs, 4321)
            // 同 id 覆蓋後實際呼叫即用新值:把 fake:ok 之 model 改為 plain
            const viaExtra = mk({ ai: { extraProviders: [{ id: 'fake:ok', model: 'plain' }] } })
            assert.equal((await viaExtra.callJson('q', arrCheck, { spec: { use: 'fake:ok' } })).ok, false)
            assert.equal(hits.at(-1).scene, 'plain')
        })
    })

    describe('逾時與冷卻', function() {

        it('逾時三層之實際效果:ai.timeoutMs(底)被條目自帶值蓋過,又被 providerTimeouts 逐 id 蓋過;席位 timeoutMs 覆寫鏈內條目', async () => {
            const cat = [rest('t:base', 'ok~700'), rest('t:own', 'ok~700', { timeoutMs: 5000 }), rest('t:pt', 'ok~700', { timeoutMs: 100 })]
            const ad = createAiAdapter({ ai: { ...AI_DEFAULT, timeoutMs: 250, providerTimeouts: { 't:pt': 5000 }, cooldownMs: 0 }, workspace: `${TMP}/ws-to`, env: {}, catalogue: cat })
            const opt = (spec) => ({ spec, minAttemptMs: 10 })
            // 實際逾時＝min(該層之值, 剩餘預算);預算自呼叫開始起算,派送前之耗時會使其略少於該層之值(負載高時差數毫秒:0.199s)——
            //   斷言判「哪一層生效」(落在該層之值以下、高於下一個候選層),不判毫秒位數
            const secOf = (e) => Number((/^TIMEOUT after ([\d.]+)s/.exec(String(e)) || [])[1])
            const base = await ad.callJson('q', arrCheck, opt({ use: 't:base' }))
            assert.equal(base.ok, false)
            assert.match(base.errors[0], /^t:base:timeout\(/)
            assert.ok(secOf(base.error) > 0.2 && secOf(base.error) <= 0.25, `底層 250ms:${base.error}`)
            assert.equal((await ad.callJson('q', arrCheck, opt({ use: 't:own' }))).ok, true, '條目自帶 5000ms 蓋過 ai.timeoutMs')
            assert.equal((await ad.callJson('q', arrCheck, opt({ use: 't:pt' }))).ok, true, 'providerTimeouts 5000ms 蓋過條目自帶之 100ms')
            const seat = await ad.callJson('q', arrCheck, opt({ use: 't:own', timeoutMs: 200 }))
            assert.equal(seat.ok, false, '席位 timeoutMs 200ms 覆寫條目自帶之 5000ms')
            assert.ok(secOf(seat.error) > 0.1 && secOf(seat.error) <= 0.2, `席位 200ms:${seat.error}`)
        })

        it('429 限流 → 冷卻(cooled 事件):降至鏈尾而不移除;前家成交即不再碰;另一實例之冷卻狀態獨立;任一次成功解除冷卻', async () => {
            const ad = mk()
            const events = []
            const spec = { use: 'fake:limit', fallback: ['fake:ok'] }
            const r1 = await ad.callJson('q', arrCheck, { spec, onEvent: (ev) => events.push(ev.type) })
            assert.equal(r1.ok, true)
            assert.equal(r1.providerId, 'fake:ok')
            assert.ok(events.includes('cooled'), `429 觸發冷卻:${events.join(',')}`)
            hits.length = 0
            const r2 = await ad.callJson('q', arrCheck, { spec })
            assert.equal(r2.attempts, 1)
            assert.deepEqual(hits.map((h) => h.scene), ['ok'], '冷卻中之條目降至鏈尾,前家成交即不再碰')
            hits.length = 0
            const other = mk()
            await other.callJson('q', arrCheck, { spec })
            assert.deepEqual(hits.map((h) => h.scene), ['limit', 'ok'], '另一實例之冷卻狀態獨立(仍先打 limit)')
            // 冷卻中之條目「只降序不移除」:鏈上僅剩它時照樣被嘗試
            hits.length = 0
            const only = await ad.callJson('q', arrCheck, { spec: { use: 'fake:limit' } })
            assert.equal(only.ok, false)
            assert.equal(only.error, 'HTTP 429')
            assert.deepEqual(hits.map((h) => h.scene), ['limit'])
        })

        it('冷卻只由執行層失敗之限流字樣觸發:HTTP 503／500 本體含限流或額度用盡字樣 → 冷卻;同狀態碼無字樣、內容型失敗(回覆文字談及字樣)→ 不冷卻', async () => {
            const cooled = async (use) => {
                const ev = []
                await mk().callJson('q', arrCheck, { spec: { use }, onEvent: (e) => ev.push(e.type) })
                return ev.includes('cooled')
            }
            assert.equal(await cooled('fake:rl503'), true, '503 本體含 rate limit')
            assert.equal(await cooled('fake:sl500'), true, '500 本體為額度用盡原文(session limit)')
            assert.equal(await cooled('fake:x500'), false, '對照:冷卻由字樣觸發,非狀態碼')
            assert.equal(await cooled('fake:ratetext'), false, '文章談及 rate limit 不是限流')
            assert.equal(await cooled('fake:sltext'), false, '文章引用額度用盡字樣不是額度用盡')
            assert.equal(await cooled('fake:plain'), false, '一般驗證失敗不冷卻')
        })

        it('ai.cooldownMs 為 0 即不冷卻:429 後下一次呼叫仍先打該家', async () => {
            const ad = mk({ ai: { cooldownMs: 0 } })
            const events = []
            const spec = { use: 'fake:limit', fallback: ['fake:ok'] }
            await ad.callJson('q', arrCheck, { spec, onEvent: (ev) => events.push(ev.type) })
            assert.ok(!events.includes('cooled'))
            hits.length = 0
            await ad.callJson('q', arrCheck, { spec })
            assert.deepEqual(hits.map((h) => h.scene), ['limit', 'ok'])
        })

        it('逾時亦冷卻(該服務卡住):逾時之條目於下次呼叫降至鏈尾', async () => {
            const cat = [rest('t:slow', 'ok~700', { timeoutMs: 150 }), rest('t:fast', 'ok')]
            const ad = createAiAdapter({ ai: { ...AI_DEFAULT }, workspace: `${TMP}/ws-slow`, env: {}, catalogue: cat })
            const spec = { use: 't:slow', fallback: ['t:fast'] }
            const ev = []
            const r = await ad.callJson('q', arrCheck, { spec, minAttemptMs: 10, onEvent: (e) => ev.push(e.type) })
            assert.equal(r.ok, true)
            assert.equal(r.providerId, 't:fast')
            assert.ok(ev.includes('cooled'))
            hits.length = 0
            await ad.callJson('q', arrCheck, { spec, minAttemptMs: 10 })
            assert.deepEqual(hits.map((h) => h.model), ['ok'], '逾時之條目已降至鏈尾')
        })
    })

    describe('skipped:不是這次之失敗', function() {

        it('整鏈皆敗且 isNetDown 確認本機不通 → skipped:true、錯誤註明不計;確認通或判斷拋錯 → 照常計(skipped:false);成功不詢問', async () => {
            const spec = { use: 'fake:dead', fallback: ['fake:plain'] }
            let asked = 0
            const down = mk({
                isNetDown: async () => {
                    asked++
                    return true
                },
            })
            const r1 = await down.callJson('q', arrCheck, { spec })
            assert.equal(r1.ok, false)
            assert.equal(r1.skipped, true)
            assert.match(r1.error, /^本機網路不通（不計此次之失敗）：/)
            assert.equal(r1.attempts, 2, '兩家皆已實際送出')
            assert.equal(asked, 1)
            assert.match(r1.errors[0], /^fake:dead:fetch\(/, '死埠連線被拒')
            const up = await mk({ isNetDown: async () => false }).callJson('q', arrCheck, { spec })
            assert.equal(up.skipped, false)
            assert.equal(up.ok, false)
            assert.doesNotMatch(up.error, /本機網路不通/)
            const errNet = await mk({ isNetDown: async () => {
                throw new Error('判斷失敗')
            } }).callJson('q', arrCheck, { spec })
            assert.equal(errNet.skipped, false, '判斷失敗視同通(照常計)')
            const notBool = await mk({ isNetDown: async () => 'yes' }).callJson('q', arrCheck, { spec })
            assert.equal(notBool.skipped, false, '只認 === true')
            let askedOk = 0
            const okAd = mk({
                isNetDown: async () => {
                    askedOk++
                    return true
                },
            })
            assert.equal((await okAd.callJson('q', arrCheck, { spec: { use: 'fake:ok' } })).ok, true)
            assert.equal(askedOk, 0, '成功時不詢問網路')
        })

        it('與 createNetGuard 之 confirmDown 接線(總組裝所用之形態):探測端點全不通 → skipped;有一個連得上 → 照常計', async () => {
            const spec = { use: 'fake:dead' }
            const guardDown = createNetGuard({ urls: ['http://a.invalid', 'http://b.invalid'], probe: async () => ({ reachable: false, httpCode: 0, message: '連線失敗' }) })
            const r = await mk({ isNetDown: () => guardDown.confirmDown() }).callJson('q', arrCheck, { spec })
            assert.equal(r.skipped, true)
            const guardUp = createNetGuard({ urls: ['http://a.invalid', 'http://b.invalid'], probe: async (u) => ({ reachable: u.includes('b.'), httpCode: 0, message: '' }) })
            const r2 = await mk({ isNetDown: () => guardUp.confirmDown() }).callJson('q', arrCheck, { spec })
            assert.equal(r2.skipped, false)
        })

        it('時間預算不足(callOpt.budgetMs、席位 budgetMs、剩餘低於 minAttemptMs)→ skipped:true 且未送出;逐次 minAttemptMs 優先於席位值,未給則用上游預設 20 秒', async () => {
            const ad = mk()
            const spec = { use: 'fake:ok' }
            const tiny = await ad.callJson('q', arrCheck, { spec, budgetMs: 1 })
            assert.equal(tiny.ok, false)
            assert.equal(tiny.skipped, true)
            assert.equal(tiny.attempts, 0)
            assert.equal(hits.length, 0, '未送出')
            const r1 = await ad.callJson('q', arrCheck, { spec, budgetMs: 30_000, minAttemptMs: 90_000 })
            assert.equal(r1.skipped, true)
            const r2 = await ad.callJson('q', arrCheck, { spec: { use: 'fake:ok', minAttemptMs: 90_000 }, budgetMs: 30_000 })
            assert.equal(r2.skipped, true, '席位層 minAttemptMs 生效')
            const r3 = await ad.callJson('q', arrCheck, { spec: { use: 'fake:ok', minAttemptMs: 90_000 }, budgetMs: 30_000, minAttemptMs: 10_000 })
            assert.equal(r3.ok, true, '逐次值優先於席位值')
            const r4 = await ad.callJson('q', arrCheck, { spec, budgetMs: 30_000 })
            assert.equal(r4.ok, true, '未給:上游預設 20 秒 ≤ 30 秒')
            const r5 = await ad.callJson('q', arrCheck, { spec: { use: 'fake:ok', budgetMs: 10_000 } })
            assert.equal(r5.skipped, true, '席位 budgetMs 與鏈預算取小(10 秒 < 20 秒門檻)')
        })

        it('shouldStop 中止:嘗試之間詢問,true 即停止遞補並回 skipped(未送出者不計);拋錯視同 false', async () => {
            const ad = mk()
            const r = await ad.callJson('q', arrCheck, { spec: { use: 'fake:ok' }, shouldStop: () => true })
            assert.equal(r.ok, false)
            assert.equal(r.skipped, true)
            assert.equal(r.attempts, 0)
            assert.equal(hits.length, 0)
            const thrown = await ad.callJson('q', arrCheck, {
                spec: { use: 'fake:ok' },
                shouldStop: () => {
                    throw new Error('壞了')
                },
            })
            assert.equal(thrown.ok, true, '詢問拋錯視同不中止')
            hits.length = 0
            // 第一家失敗後中止:第二家不送出,attempts 只計實際送出者
            const after1 = await ad.callJson('q', arrCheck, { spec: { use: 'fake:plain', fallback: ['fake:ok'] }, shouldStop: () => hits.length >= 1 })
            assert.equal(after1.skipped, true)
            assert.equal(after1.attempts, 1)
            assert.deepEqual(hits.map((h) => h.scene), ['plain'])
        })

        it('被整輪截止切斷之最後一家:上游回該家之逾時而非 aborted(無下一家可中止),仍以 shouldStop 判為 skipped', async () => {
            const cat = [rest('t:last', 'ok~600', { timeoutMs: 200 })]
            const ad = createAiAdapter({ ai: { ...AI_DEFAULT }, workspace: `${TMP}/ws-last`, env: {}, catalogue: cat })
            let stop = false
            setTimeout(() => {
                stop = true
            }, 60)
            const r = await ad.callJson('q', arrCheck, { spec: { use: 't:last' }, minAttemptMs: 10, shouldStop: () => stop })
            assert.equal(r.ok, false)
            assert.match(r.error, /^TIMEOUT/)
            assert.equal(r.skipped, true, '逾時發生時整輪已截止:不是該家之失敗')
        })
    })

    describe('實績彙總與用量', function() {

        it('drainStats:「成交 條目×次數；遞補略過 條目(錯誤型別)×次數」,取走並歸零;無呼叫回「無呼叫」', async () => {
            const ad = mk()
            assert.equal(ad.drainStats(), '無呼叫')
            await ad.callJson('q', arrCheck, { spec: { use: 'fake:ok' } })
            await ad.callJson('q', arrCheck, { spec: { use: 'fake:ok' } })
            await ad.callJson('q', arrCheck, { spec: { use: 'fake:plain', fallback: ['fake:ok'] } })
            assert.equal(ad.drainStats(), '成交 fake:ok×3；遞補略過 fake:plain(validation)×1')
            assert.equal(ad.drainStats(), '無呼叫')
            await ad.callJson('q', arrCheck, { spec: { use: 'fake:plain' } })
            assert.equal(ad.drainStats(), '遞補略過 fake:plain(validation)×1', '只有失敗時不列成交')
        })

        it('recordCall:假值不記錄;可由外部補記一筆(成交以 keyId 歸戶:有金鑰索引者為 id#索引)', () => {
            const ad = mk()
            ad.recordCall(null)
            ad.recordCall(undefined)
            assert.equal(ad.drainStats(), '無呼叫')
            ad.recordCall({ ok: true, providerId: 'p:a', keyIndex: null, tried: [] })
            ad.recordCall({ ok: true, providerId: 'p:b', keyIndex: 1, tried: [] })
            ad.recordCall({ ok: false, providerId: 'p:c', tried: [{ providerId: 'p:c', outcome: 'skip-group', errorType: 'timeout' }] })
            assert.equal(ad.drainStats(), '成交 p:a×1 p:b#1×1；遞補略過 p:c(timeout)×1')
        })

        it('aiUsageToday:依 clock 之今日分日、每次嘗試(含失敗)記一次;換日即歸零;無 clock 時 today 為空字串', async () => {
            let day = '2026-10-06'
            const ad = mk({ clock: { date8: () => day } })
            const usageOf = (a) => {
                const { today, used, byKey } = a.aiUsageToday()
                return { today, used, byKey }
            }
            assert.deepEqual(usageOf(ad), { today: '2026-10-06', used: 0, byKey: {} })
            await ad.callJson('q', arrCheck, { spec: { use: 'fake:plain', fallback: ['fake:ok'] } })
            assert.deepEqual(usageOf(ad), { today: '2026-10-06', used: 2, byKey: { 'fake:plain': 1, 'fake:ok': 1 } })
            day = '2026-10-07'
            assert.deepEqual(usageOf(ad), { today: '2026-10-07', used: 0, byKey: {} }, '換日即歸零')
            await ad.callJson('q', arrCheck, { spec: { use: 'fake:ok' } })
            assert.deepEqual(usageOf(ad), { today: '2026-10-07', used: 1, byKey: { 'fake:ok': 1 } })
            const noClock = mk()
            await noClock.callJson('q', arrCheck, { spec: { use: 'fake:ok' } })
            assert.deepEqual(usageOf(noClock), { today: '', used: 1, byKey: { 'fake:ok': 1 } })
            assert.deepEqual(Object.keys(ad.aiUsageToday()).sort(), ['byKey', 'chain', 'providers', 'skipped', 'today', 'used'], '另帶可用條目(其逐案見 unit-ai-adapter-ext 規則⑨)')
        })

        it('並行呼叫(同一實例):各自成交、實績與用量不遺漏;回覆不串線(依各自之席位取得各自之內容)', async () => {
            const ad = mk()
            const specs = [{ use: 'fake:ok' }, { use: 'fake:ok2' }, { use: 'fake:plain', fallback: ['fake:ok'] }, { use: 'fake:ok2' }, { use: 'fake:ok' }]
            const rs = await Promise.all(specs.map((spec) => ad.callJson('q', arrCheck, { spec })))
            assert.deepEqual(rs.map((r) => r.ok), [true, true, true, true, true])
            assert.deepEqual(rs.map((r) => r.providerId), ['fake:ok', 'fake:ok2', 'fake:ok', 'fake:ok2', 'fake:ok'])
            assert.deepEqual(rs.map((r) => r.data[0].index), [1, 2, 1, 2, 1])
            assert.equal(ad.aiUsageToday().used, 6, '五次呼叫共六次嘗試(其中一次先失敗後遞補)')
            const stats = ad.drainStats() // 成交各條目之先後依完成序,不比字串全文
            assert.match(stats, /^成交 .*；遞補略過 fake:plain\(validation\)×1$/)
            assert.match(stats, /fake:ok×3/)
            assert.match(stats, /fake:ok2×2/)
        })

        it('用量依金鑰(keyId)歸戶:多金鑰條目逐把記', async () => {
            const ad = mk({ env: { [KEY_VAR]: 'k1,k2' } })
            await ad.callJson('q', arrCheck, { spec: { use: 'fake:okkeyed' } })
            await ad.callJson('q', arrCheck, { spec: { use: 'fake:okkeyed' } })
            assert.deepEqual(ad.aiUsageToday().byKey, { 'fake:okkeyed#0': 1, 'fake:okkeyed#1': 1 })
        })
    })

    describe('CLI 子行程之環境:本層不干預(檔頭【CLI 讀取哪些檔由 CLI 決定】)', function() {

        // 假 opencode:條目之 exe 指向 node,w-dispatch-ai 之 opencode 轉接器以「run --agent build -m <model>」啟動 →
        //   node 執行工作目錄下名為 run 之腳本;腳本讀完 stdin(提示詞)後回報子行程所見之環境變數(JSON 陣列,過 arrCheck)
        const FAKE_RUN = [
            "let s = ''",
            "process.stdin.on('data', (c) => { s += c })",
            "process.stdin.on('end', () => process.stdout.write(JSON.stringify([{ claude: process.env.OPENCODE_DISABLE_CLAUDE_CODE ?? null, extra: process.env.CAPTURE_TEST_EXTRA ?? null, got: s.length > 0 }])))",
        ].join('\n')

        /**
         * 建立帶假 opencode 條目之 adapter(工作目錄預先放好 run 腳本)
         *
         * @param {Object} [entryEnv] 輸入條目自帶之 env(未給即不帶)
         * @returns {Object} 回傳 adapter
         */
        const mkCli = (entryEnv) => {
            const ws = `${TMP}/ws-cli-${++seq}`
            fs.mkdirSync(ws, { recursive: true })
            fs.writeFileSync(`${ws}/run`, FAKE_RUN, 'utf8')
            const entry = { id: 'oc:fake-cli', kind: 'opencode', model: 'fake', exe: process.execPath, ...(entryEnv ? { env: entryEnv } : {}) }
            return createAiAdapter({ ai: { ...AI_DEFAULT, extraProviders: [entry] }, workspace: ws, env: {}, catalogue: CAT })
        }

        it('本層不注入環境變數:CLI 子行程所見與本行程相同(CLI 讀取哪些指示檔由 CLI 決定);提示詞經 stdin 送達', async () => {
            const r = await mkCli().callJson('q', arrCheck, { spec: { use: 'oc:fake-cli' } })
            assert.equal(r.ok, true, r.error)
            assert.deepEqual(r.data, [{ claude: process.env.OPENCODE_DISABLE_CLAUDE_CODE ?? null, extra: process.env.CAPTURE_TEST_EXTRA ?? null, got: true }])
        })

        it('條目自帶 env 原樣傳給 CLI 子行程(安裝方以 ai.extraProviders 同 id 覆寫條目即可自行決定);本行程之 process.env 不受影響', async () => {
            const before = process.env.CAPTURE_TEST_EXTRA
            const r = await mkCli({ CAPTURE_TEST_EXTRA: 'x' }).callJson('q', arrCheck, { spec: { use: 'oc:fake-cli' } })
            assert.equal(r.ok, true, r.error)
            assert.equal(r.data[0].extra, 'x')
            assert.equal(process.env.CAPTURE_TEST_EXTRA, before, '只作用於子行程')
        })
    })

    describe('擴充 opt 預設全關(規則⑧):未給時之行為與未擴充前相同', function() {

        const CATK = [...CAT, rest('fake:cutk', 'cutk'), rest('fake:trunck', 'trunck')]
        const SHAPE_KEYS = ['attempts', 'data', 'error', 'errors', 'ok', 'providerId', 'skipped']

        it('未給 acceptTruncated(或給 false／null):REST 截斷一律不放行、拿不到終止訊號之截斷不搶救(即使前段有完整項目);結果皆無 truncated', async () => {
            for (const o of [{}, { acceptTruncated: false }, { acceptTruncated: null }]) {
                const ad = mk({ ...o, catalogue: CATK })
                const tr = await ad.callJson('q', arrCheck, { spec: { use: 'fake:trunck' } })
                assert.equal(tr.ok, false, `${JSON.stringify(o)}:截斷不放行`)
                assert.match(tr.errors[0], /^fake:trunck:incomplete\(\d+\.\ds\)$/, '未交本層驗證:不附不合格原因')
                assert.equal('truncated' in tr, false)
                const cut = await ad.callJson('q', arrCheck, { spec: { use: 'fake:cutk' } })
                assert.equal(cut.ok, false, `${JSON.stringify(o)}:不搶救半成品`)
                assert.match(cut.errors[0], /^fake:cutk:validation\(\d+\.\ds\)：非 JSON（或輸出截斷）$/)
                const fb = await ad.callJson('q', arrCheck, { spec: { use: 'fake:trunck', fallback: ['fake:ok'] } })
                assert.deepEqual([fb.ok, fb.providerId, fb.attempts, 'truncated' in fb], [true, 'fake:ok', 2, false], '截斷即換家')
            }
        })

        it('未給 preview:失敗形狀(未送出即失敗、派送後失敗、skipped)與成功形狀之鍵集不變(無 preview)', async () => {
            const ad = mk()
            const early = await ad.callJson('', arrCheck, { spec: { use: 'fake:ok' } })
            const noSeat = await ad.callJson('q', arrCheck, { spec: { use: 'nope:x' } })
            const disp = await ad.callJson('q', arrCheck, { spec: { use: 'fake:plain' } })
            const skip = await ad.callJson('q', arrCheck, { spec: { use: 'fake:ok' }, budgetMs: 1 })
            const ok = await ad.callJson('q', arrCheck, { spec: { use: 'fake:ok' } })
            for (const [name, r] of Object.entries({ early, noSeat, disp, skip, ok })) assert.deepEqual(Object.keys(r).sort(), SHAPE_KEYS, name)
            assert.equal(skip.skipped, true)
        })

        it('未給 ai.healthStreak:回傳無 health;同一家連續整組皆敗不降序(驗證失敗不在上游冷卻之列);drainStats 無健康摘要;執行摘要無 ai.health', async () => {
            const healthEvents = []
            const ad = mk({ onHealth: (ev) => healthEvents.push(ev) })
            assert.equal('health' in ad, false)
            for (let i = 0; i < 4; i++) {
                hits.length = 0
                const r = await ad.callJson('q', arrCheck, { spec: { use: 'fake:plain', fallback: ['fake:ok'] } })
                assert.equal(r.providerId, 'fake:ok')
                assert.deepEqual(hits.map((h) => h.scene), ['plain', 'ok'], `第 ${i + 1} 次仍先打 plain(未降序)`)
            }
            assert.deepEqual(healthEvents, [], '未開健康層:onHealth 不作用')
            const sum = buildRunSummary({ ai: ad, stamp: '20261007120000' })
            assert.equal(sum.ai.health, undefined)
            assert.equal(sum.ai.callStats, '成交 fake:ok×4；遞補略過 fake:plain(validation)×4', '無健康摘要')
        })

        it('未給 ai.pools:不讀 opencode 日誌、不依額度降序(opencode 條目照鏈序先打);onPool 不作用', async () => {
            // 假 opencode:exe 指向 node,工作目錄下之 run 腳本讀完 stdin 後回 JSON 陣列(同上方 CLI 子行程之作法;不呼叫真 CLI)
            const ws = `${TMP}/ws-pool-off`
            fs.mkdirSync(ws, { recursive: true })
            fs.writeFileSync(`${ws}/run`, "let s = ''\nprocess.stdin.on('data', (c) => { s += c })\nprocess.stdin.on('end', () => process.stdout.write('[{\"index\":1}]'))\n", 'utf8')
            const oc = { id: 'oc:opencode/muse-spark-1.3-contributor-free', kind: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free', exe: process.execPath }
            const poolEvents = []
            const reads = []
            const origStat = fs.statSync
            fs.statSync = (p, ...more) => {
                reads.push(String(p))
                return origStat(p, ...more)
            }
            let r = null
            const tries = []
            try {
                const ad = createAiAdapter({ ai: { ...AI_DEFAULT }, workspace: ws, env: {}, catalogue: [oc, ...CAT], onPool: (ev) => poolEvents.push(ev) })
                r = await ad.callJson('q', arrCheck, { spec: { use: oc.id, fallback: ['fake:ok'] }, onEvent: (ev) => (ev.type === 'try' ? tries.push(ev.providerId) : null) })
            }
            finally {
                fs.statSync = origStat
            }
            assert.equal(r.ok, true, r.error)
            assert.equal(r.providerId, oc.id, 'opencode 條目照鏈序先打且成交')
            assert.deepEqual(tries, [oc.id])
            assert.deepEqual(poolEvents, [])
            assert.deepEqual(reads.filter((p) => /opencode[\\/]log/i.test(p)), [], '未讀 opencode 日誌')
        })

        it('未給 capability 且 ai.providerLimits 為預設 {}:不依 prompt 長度預先剔除(長 prompt 照常送交 antigravity 轉接器,由其於啟動前回 params 後遞補);validateSeats 無長度警告;onOversize 不作用', async () => {
            // antigravity 條目:轉接器於啟動子行程之前即擋下逾 30,000 字之 prompt;exe 另指向不存在之路徑(萬一啟動亦只得 ENOENT,不呼叫真 CLI)
            const agy = (id) => ({ id, kind: 'antigravity', model: 'x', exe: `${TMP}/no-such-agy.exe` })
            const oversize = []
            const ad = mk({ catalogue: [agy('agy:fake'), agy('agy:fake2'), ...CAT], onOversize: (ev) => oversize.push(ev) })
            assert.deepEqual(ad.validateSeats({ s: { use: 'agy:fake', fallback: ['agy:fake2'] } }), { ok: true, warnings: [] }, '全鏈皆為 antigravity 亦不警告(固有上限未開)')
            const tries = []
            const r = await ad.callJson('長'.repeat(31_000), arrCheck, { spec: { use: 'agy:fake', fallback: ['fake:ok'] }, onEvent: (ev) => (ev.type === 'try' ? tries.push(ev.providerId) : null) })
            assert.equal(r.ok, true, r.error)
            assert.equal(r.providerId, 'fake:ok')
            assert.deepEqual(tries, ['agy:fake', 'fake:ok'], '未預先剔除:antigravity 照鏈序送交')
            assert.deepEqual([r.attempts, oversize], [2, []])
        })
    })
})
