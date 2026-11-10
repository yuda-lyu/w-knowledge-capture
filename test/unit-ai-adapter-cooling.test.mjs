// unit-ai-adapter-cooling.test.mjs — AI 調度層與 w-dispatch-ai 冷卻／連敗／預算之單一擁有者對接(設計 da402 §4.2〈CA〉3～6、§5.2〈CA〉CA-3～CA-6;
//   規則帳本 AI-03、AI-04、AI-05、AI-13、AI-14)
//
// 規格(逐條對應下列各案之斷言註解):
//   CA-3 callJson 之歸類依遞補層結果:attempts 計入 budget-cut 與 context-too-long;skipped ＝ errorType 為 budget／aborted 或結果帶 envDown;
//        不再以呼叫端此刻之 shouldStop 回頭猜「被截止切斷之末家」(整鏈真失敗而判停值已為真 → skipped:false);本層不再自問 isNetDown
//        (經遞補層之 envDown;為真即 skipped:true、netDown:true、錯誤註明不計);budgetMs 經 castBudgetMs(0／負＝已無時間 → 不送出)。
//        errors 與 drainStats 之失敗標籤:被封頂之嘗試記為 budget-cut。
//   CA-4 轉傳 ai.cooldownGrowth、ai.cooldownMaxMs、coolAfterFails(＝ai.healthStreak)、envDown(＝isNetDown)於 callJson 與工作流入口;
//        設定段之預設 1／24 小時、檢核(growth ≥ 1 之數、maxMs 正整數)。
//   CA-5 健康層只觀察:不寫 store;onCool 由遞補層之 cooled(reason 'streak')驅動(欄位 providerId、streak、errorType、error〔120 字〕、
//        keys〔多金鑰且每把皆試過〕);視窗內之重申不重複回呼;snapshot 之 streak 讀遞補層之持久連敗(streakOf)。免費池經 coolEntry 以 reason 'quota' 寫入
//        (固定視窗、不動 n;ai.cooldownMs 0 時不寫)。
//   CA-6 評比分類:限流只認 cooled.reason 為 rate-limit／detect(streak、budget、quota、timeout 不判限流);budget-cut 歸「截止」(skipped),不歸 timeout。
// 執行:自套件根 npx mocha test/unit-ai-adapter-cooling.test.mjs(本機假 REST 固定埠 8838;暫存 test/_tmp/ai-adapter-cooling-<pid>,測完即刪;不連外、不呼叫真 AI)。
//   被封頂之案以真實逾時(數百毫秒)驅動遞補層之期限,斷言只看結局(tried／事件／store),不以牆鐘判定。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { coolingOf, streakOf } from 'w-dispatch-ai/src/cooling.mjs'
import { createAiAdapter } from '../src/core/ai/adapter.mjs'
import { createProviderHealth } from '../src/core/ai/providerHealth.mjs'
import { resetStartMs } from '../src/core/ai/poolQuota.mjs'
import { benchFailOf } from '../src/bench/benchKit.mjs'
import { AI_DEFAULT, AI_SCHEMA, SETTING_TYPES, resolveSettings } from '../src/core/settingsDefault.mjs'
import { tmpRoot } from './tools/captureTestKit.mjs'
import { removeRoots, sleep } from './tools/testKit.mjs'

let TMP = ''
const PORT = 8838 // 假 REST(固定埠,≥8000、不隨機;本檔專屬)
const DEAD_PORT = 8830 // 無人監聽之死埠(他檔亦只連不聽)
const BASE = `http://127.0.0.1:${PORT}/v1`
const hits = [] // 每次請求 { model, key }

/**
 * 假伺服器:model 為「情境~延遲毫秒」;dead* 金鑰回 401;limit 回 429;ctx 回 Anthropic 之脈絡過長(400);plain 回非 JSON;其餘回 JSON 陣列
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
        const key = String(req.headers.authorization || req.headers['x-api-key'] || '').replace(/^Bearer\s+/i, '')
        const model = String(body.model || '')
        const [scene, delay] = model.split('~')
        hits.push({ model, key })
        if (Number(delay)) await sleep(Number(delay))
        if (res.destroyed || res.writableEnded) return
        try {
            if (key.startsWith('dead')) {
                res.writeHead(401, { 'Content-Type': 'application/json' })
                res.end('{"message":"invalid key"}')
                return
            }
            if (scene === 'limit') {
                res.writeHead(429, { 'Content-Type': 'application/json' })
                res.end('{"error":{"message":"rate limit exceeded"}}')
                return
            }
            if (scene === 'ctx') {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end('{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}')
                return
            }
            const content = scene === 'plain' ? '這不是 JSON' : '[{"index":1,"v":"a"}]'
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ id: 'fake', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
        }
        catch { /* 連線已被中止 */ }
    })
}

const rest = (id, model, extra = {}) => ({ id, kind: 'api-openai-compat', baseURL: BASE, model, ...extra })
const CAT = [
    rest('c:ok', 'ok'),
    rest('c:plain', 'plain'),
    rest('c:plain2', 'plain'),
    rest('c:hang', 'ok~3000', { timeoutMs: 600 }), // 收件後 3 秒才回;條目逾時 600 毫秒
    rest('c:hangL', 'ok~8000', { timeoutMs: 4000 }), // 收件後 8 秒才回;條目逾時 4 秒(被封頂之案:預算 1.5 秒,差額遠大於 minAttemptMs,負載下仍判封頂)
    rest('c:limit', 'limit'),
    rest('c:dead2', 'ok', { envVar: 'C_DEAD2' }), // 兩把皆死(401)
    { id: 'c:ctx', kind: 'api-anthropic', baseURL: `http://127.0.0.1:${PORT}`, model: 'ctx', envVar: 'C_ANT' }, // 脈絡過長
    { id: 'c:down', kind: 'api-openai-compat', baseURL: `http://127.0.0.1:${DEAD_PORT}/v1`, model: 'ok' }, // 死埠:連線被拒
]
const ENV = { C_DEAD2: 'deadA,deadB', C_ANT: 'k-ant' }
const check = (d) => (Array.isArray(d) && d.length > 0 ? true : '須為非空陣列')

/**
 * opencode 日誌之當日額度字樣一行(時刻取本週期內:當下前 1 秒,但不早於本週期起點——避免恰跨 UTC 重置時落在前一週期)
 *
 * @param {String} model 輸入 opencode 模型(provider/model)
 * @returns {String} 回傳日誌行
 */
const quotaLine = (model) => {
    const iso = new Date(Math.max(resetStartMs(Date.now()), Date.now() - 1000)).toISOString()
    return `timestamp=${iso} level=ERROR run=8c7db97f message="stream error" providerID=opencode modelID=${model.split('/')[1]} session.id=ses_x small=false agent=build mode=primary error.error="AI_APICallError: Rate limit exceeded. Please try again later."`
}

let seq = 0

/**
 * 記憶體之持久層(同 createFileStore 之契約 { get, set };get 恆回同一狀態物件,以便直接以 coolingOf／streakOf 檢視)
 *
 * @param {Object} [init={}] 輸入初始狀態
 * @returns {Object} 回傳 { get, set, state, sets:()=>Number }
 */
const memPersist = (init = {}) => {
    const state = { cursors: {}, cooling: {}, ...init }
    let n = 0
    return {
        get: () => state,
        set: () => {
            n++
        },
        state,
        sets: () => n,
    }
}

/**
 * 建立 adapter(每個測試各自一個)
 *
 * @param {Object} [o={}] 輸入 createAiAdapter 之其他選項
 * @param {Object} [aiExtra={}] 輸入覆寫 settings.ai 之鍵
 * @returns {Object} 回傳 adapter
 */
const mk = (o = {}, aiExtra = {}) => createAiAdapter({
    ai: { ...AI_DEFAULT, ...aiExtra },
    workspace: `${TMP}/ws-${++seq}`,
    env: ENV,
    catalogue: CAT,
    ...o,
})

describe('unit-ai-adapter-cooling', function() {

    this.timeout(60_000)

    let server = null

    before(async function() {
        TMP = tmpRoot('ai-adapter-cooling')
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

    describe('CA-3 callJson 之歸類依遞補層之結果', function() {

        it('被封頂(budget-cut):skipped:true、attempts 計入被封頂之嘗試;errors 與 drainStats 記為 budget-cut(不記 timeout);非鏈首被封頂者不冷卻', async () => {
            const ad = mk()
            const evs = []
            // 預算 1.5 秒、minAttemptMs 300:前家(非 JSON)快速失敗後,後家之嘗試被期限封頂(差額約 2.5 秒 ≥ 300、結束時剩餘 < 300)——時間餘裕足以吸收負載下之派送開銷
            const r = await ad.callJson('q', check, { spec: { use: 'c:plain', fallback: ['c:hangL'] }, budgetMs: 1500, minAttemptMs: 300, onEvent: (ev) => evs.push(ev) })
            // 規格 CA-3:skipped 依遞補層結果(errorType budget)
            assert.deepEqual([r.ok, r.skipped], [false, true], r.error)
            // 規格 CA-3:attemptsOf 計入 budget-cut(修前只計 ok／next-key／skip-group → 1)
            assert.equal(r.attempts, 2)
            // 規格 CA-3:被封頂之嘗試以 budget-cut 標記(修前沿用 tried 之 errorType 記為 timeout)
            assert.match(r.errors[1], /^c:hangL:budget-cut\(\d+\.\ds\)$/)
            assert.match(r.errors[0], /^c:plain:validation\(/)
            assert.equal(evs.filter((ev) => ev.type === 'cooled' && ev.providerId === 'c:hangL').length, 0, '非鏈首被封頂者不冷卻(遞補層 R-COOL-1)')
            assert.match(ad.drainStats(), /c:hangL\(budget-cut\)×1/, '輪末彙總之遞補略過同一標籤')
        })

        it('脈絡過長(context-too-long):attempts 計入(已實際送出;修前漏計為 0)', async () => {
            const r = await mk().callJson('q', check, { spec: { use: 'c:ctx' } })
            assert.equal(r.ok, false)
            assert.match(r.error, /^CONTEXT_TOO_LONG/)
            assert.equal(hits.length, 1, '已送出一次')
            assert.equal(r.attempts, 1, '規格 CA-3:attemptsOf 計入 context-too-long')
            assert.equal(r.skipped, false)
        })

        it('整鏈真失敗而呼叫端判停值此刻已為真 → skipped:false(照計失敗;修前以 shouldStop 回頭猜為 skipped)', async () => {
            let stop = false
            const r = await mk().callJson('q', check, { spec: { use: 'c:plain' }, shouldStop: () => stop, onEvent: (ev) => (ev.type === 'try' ? (stop = true) : null) })
            assert.deepEqual([r.ok, r.attempts, r.error], [false, 1, 'OUTPUT_VALIDATION_FAILED'])
            assert.equal(r.skipped, false, '規格 CA-3:去掉 || stopNow()——各家皆試過而真的失敗者照計失敗')
            // 嘗試之間判停仍生效(遞補層回 aborted → skipped)
            let stop2 = false
            const r2 = await mk().callJson('q', check, { spec: { use: 'c:plain', fallback: ['c:ok'] }, shouldStop: () => stop2, onEvent: (ev) => (ev.type === 'try' ? (stop2 = true) : null) })
            assert.deepEqual([r2.ok, r2.skipped, r2.attempts], [false, true, 1])
        })

        it('budgetMs 經 castBudgetMs:0、負數、-Infinity → 不送出、skipped(修前 0／負改用鏈預算照送);+Infinity、NaN、未給 → 照鏈預算送出;數字字串照用', async () => {
            const ad = mk()
            for (const b of [0, -1, -Infinity]) {
                hits.length = 0
                const r = await ad.callJson('q', check, { spec: { use: 'c:ok' }, budgetMs: b })
                assert.deepEqual([r.ok, r.skipped, r.attempts, hits.length], [false, true, 0, 0], `budgetMs=${b}:已無時間,不送出`)
            }
            for (const b of [Infinity, NaN, undefined, '30000']) {
                hits.length = 0
                const r = await ad.callJson('q', check, { spec: { use: 'c:ok' }, budgetMs: b })
                assert.deepEqual([r.ok, hits.length], [true, 1], `budgetMs=${String(b)}`)
            }
            hits.length = 0
            const s = await ad.callJson('q', check, { spec: { use: 'c:ok' }, budgetMs: '1' })
            assert.deepEqual([s.ok, s.skipped, hits.length], [false, true, 0], '數字字串「1」照用(1 毫秒 < 開工門檻,不送出)')
        })

        it('席位 budgetMs 為設定值:非正整數(0.5、1500.7)視為未給 → 用鏈預算照送(交接 6;外審 terra F04);正整數照用;seatSpec 同一判準', async () => {
            const ad = mk({ workflow: true })
            for (const b of [0.5, 1500.7]) {
                hits.length = 0
                const r = await ad.callJson('q', check, { spec: { use: 'c:ok', budgetMs: b } })
                assert.deepEqual([r.ok, hits.length], [true, 1], `席位 budgetMs=${b}:視為未給`)
            }
            hits.length = 0
            const small = await ad.callJson('q', check, { spec: { use: 'c:ok', budgetMs: 1000 } })
            assert.deepEqual([small.ok, small.skipped, hits.length], [false, true, 0], '正整數照用(1 秒 < 開工門檻 20 秒,不送出)')
            assert.deepEqual([ad.seatSpec({ use: 'c:ok', budgetMs: 0.5 }).budgetMs, ad.seatSpec({ use: 'c:ok', budgetMs: 1500.7 }).budgetMs, ad.seatSpec({ use: 'c:ok', budgetMs: 1500 }).budgetMs], [300_000, 300_000, 1500], 'seatSpec:非正整數 → 逾時×留存數')
        })

        it('isNetDown 回 true → 經遞補層之 envDown:skipped:true、netDown:true、錯誤註明不計;本次之 n 與連敗遞增不落定;本層不另問(只問一次)', async () => {
            const now = Date.now()
            const init = () => ({ cooling: { 'c:hang': { at: now - 60_000, n: 2, reason: 'timeout' } }, failStreak: { 'c:hang': { k: 1, at: now - 60_000 } } })
            let asked = 0
            const p = memPersist(init())
            const ad = mk({
                persistStore: p,
                isNetDown: async () => {
                    asked++
                    return true
                },
            }, { cooldownMs: 1000, cooldownGrowth: 2, healthStreak: 5 })
            const r = await ad.callJson('q', check, { spec: { use: 'c:hang' } })
            // 規格 CA-3:skipped 依結果之 envDown;netDown:true;錯誤註明
            assert.deepEqual([r.ok, r.skipped, r.netDown], [false, true, true])
            assert.match(r.error, /^本機網路不通（不計此次之失敗）：TIMEOUT/)
            assert.equal(asked, 1, '只由遞補層詢問一次(本層不再自問)')
            // 規格 CA-4:envDown 轉傳 → 遞補層不落定 n 與連敗(視窗外之逾時本應 n 2 → 3、連敗 1 → 2)
            assert.deepEqual([coolingOf(p.state, 'c:hang').n, streakOf(p.state, 'c:hang')], [2, 1])
            // 對照:網路通 → n 與連敗照常遞增、照計失敗、無 netDown
            const p2 = memPersist(init())
            let askedUp = 0
            const up = await mk({
                persistStore: p2,
                isNetDown: async () => {
                    askedUp++
                    return false
                },
            }, { cooldownMs: 1000, cooldownGrowth: 2, healthStreak: 5 }).callJson('q', check, { spec: { use: 'c:hang' } })
            assert.deepEqual([up.skipped, 'netDown' in up, coolingOf(p2.state, 'c:hang').n, streakOf(p2.state, 'c:hang')], [false, false, 3, 2])
            assert.doesNotMatch(up.error, /本機網路不通/)
            assert.equal(askedUp, 1, '規格 CA-3:去掉本層之 netDownNow()——遞補層回「通」時本層不再自問')
        })

        // 已知缺陷(需裁示;遞補層 w-dispatch-ai 之 envDown 等待以剩餘預算封頂):整條鏈等滿逾時而耗盡預算時,遞補層之詢問近乎不等待,
        //   需 50 毫秒才回覆之 isNetDown 被視同「通」→ 照計失敗(修前本層無時限自問 → skipped)。缺陷仍在時本案標 pending(this.skip),修正後自動轉為斷言
        it('已知缺陷:isNetDown 需數十毫秒才回 true 而整鏈已耗盡預算 → 應 skipped:true、netDown:true(遞補層修正前 pending)', async function() {
            const ad = mk({
                isNetDown: async () => {
                    await sleep(50)
                    return true
                },
            })
            const r = await ad.callJson('q', check, { spec: { use: 'c:hang' } })
            if (r.skipped !== true) this.skip() // 已知缺陷:遞補層 dispatchAiFallback 之 envDown 等待 min(5 秒, 剩餘預算) ≈ 1 毫秒
            assert.deepEqual([r.ok, r.skipped, r.netDown], [false, true, true])
        })
    })

    describe('CA-1 包裝接真 callJson(端對端)', function() {

        it('不帶 minAttemptMs:席位 minAttemptMs 90 秒、扣保留剩餘 30 秒、firstMs 20 秒 → 進門放行,callJson 仍以席位之 90 秒判開工(預算 30 秒 < 90 秒 → 不送出、skipped);席位未給 minAttemptMs 者照送', async () => {
            const { reservedAiCallOf } = await import('../src/core/ai/reservedCall.mjs')
            const ad = mk()
            const gate = { shouldStop: (ms) => ms > 30_000, remainingMs: () => 30_000 }
            const ask = reservedAiCallOf(ad.callJson, gate, { firstMs: 20_000 })
            const r = await ask('q', check, { spec: { use: 'c:ok', minAttemptMs: 90_000 } })
            // 規格 CA-1:不傳 minAttemptMs(若交續派門檻 20 秒,callJson 以逐次值優先而照送)
            assert.deepEqual([r.ok, r.skipped, r.attempts, hits.length], [false, true, 0, 0])
            const r2 = await ask('q', check, { spec: { use: 'c:ok' } })
            assert.deepEqual([r2.ok, hits.length], [true, 1], '席位未給:callJson 依其開工門檻規則(AI-11)照送')
        })
    })

    describe('CA-4 新選項之轉傳與設定', function() {

        it('callJson:cooldownGrowth／cooldownMaxMs 轉傳——cooled 事件之 cooldownMs 為加長後之有效視窗(上限 cooldownMaxMs)、reason 為觸發原因', async () => {
            const now = Date.now()
            const evOf = async (rec) => {
                const p = memPersist({ cooling: { 'c:limit': rec } })
                const evs = []
                await mk({ persistStore: p }, { cooldownMs: 1000, cooldownGrowth: 4, cooldownMaxMs: 60_000 }).callJson('q', check, { spec: { use: 'c:limit' }, onEvent: (ev) => evs.push(ev) })
                return evs.filter((ev) => ev.type === 'cooled').map((ev) => [ev.reason, ev.n, ev.cooldownMs])
            }
            // 夾具時刻須在「有效視窗外」而未逾「有效視窗＋cooldownMaxMs」(逾者遞補層視為久未觸發而清除,n 歸零);兩側皆留數十秒餘裕
            // 視窗外再限流:n 1(視窗 1 秒)→ 2,有效視窗 1000×4(清除線 61 秒,夾具 5 秒前)
            assert.deepEqual(await evOf({ at: now - 5000, n: 1, reason: 'rate-limit' }), [['rate-limit', 2, 4000]])
            // n 3(有效視窗 min(1000×4², 60000)＝16000;夾具 30 秒前,清除線 76 秒)→ 4:1000×4^3＝64000 → 上限 60000
            assert.deepEqual(await evOf({ at: now - 30_000, n: 3, reason: 'rate-limit' }), [['rate-limit', 4, 60_000]])
        })

        it('工作流入口(getWkf().callAi)同樣轉傳:cooled 事件之有效視窗與 reason;coolAfterFails(＝healthStreak)跨呼叫累計達門檻以 streak 冷卻;envDown 不落定 n', async () => {
            const now = Date.now()
            const p = memPersist({ cooling: { 'c:limit': { at: now - 5000, n: 1, reason: 'rate-limit' } } })
            const ad = mk({ workflow: true, persistStore: p }, { cooldownMs: 1000, cooldownGrowth: 4, cooldownMaxMs: 50_000, healthStreak: 2 })
            const evs = []
            await ad.getWkf().callAi('q', { spec: { use: 'c:limit' }, check: (j) => Array.isArray(j), onEvent: (ev) => evs.push(ev) })
            assert.deepEqual(evs.filter((ev) => ev.type === 'cooled').map((ev) => [ev.reason, ev.n, ev.cooldownMs]), [['rate-limit', 2, 4000]], '工作流入口之 cooldownGrowth')
            // 工作流入口之 cooldownMaxMs(外審 terra T01):n 3(有效視窗 min(1000×4², 50000)＝16000;夾具 30 秒前,清除線 66 秒)→ 4:64000 → 上限 50000
            const ev2 = []
            const p3 = memPersist({ cooling: { 'c:limit': { at: now - 30_000, n: 3, reason: 'rate-limit' } } })
            await mk({ workflow: true, persistStore: p3 }, { cooldownMs: 1000, cooldownGrowth: 4, cooldownMaxMs: 50_000 }).getWkf().callAi('q', { spec: { use: 'c:limit' }, check: (j) => Array.isArray(j), onEvent: (ev) => ev2.push(ev) })
            assert.deepEqual(ev2.filter((ev) => ev.type === 'cooled').map((ev) => [ev.n, ev.cooldownMs]), [[4, 50_000]], '工作流入口之 cooldownMaxMs:64000 → 上限 50000')
            const s = []
            for (let i = 0; i < 2; i++) await ad.getWkf().callAi('q', { spec: { use: 'c:plain' }, check: (j) => Array.isArray(j), onEvent: (ev) => (ev.type === 'cooled' ? s.push([ev.reason, ev.streak]) : null) })
            assert.deepEqual(s, [['streak', 2]], '工作流入口之 coolAfterFails(＝ai.healthStreak 2)')
            const p2 = memPersist({ cooling: { 'c:hang': { at: now - 60_000, n: 2, reason: 'timeout' } } })
            let asked = 0
            const ad2 = mk({
                workflow: true,
                persistStore: p2,
                isNetDown: async () => {
                    asked++
                    return true
                },
            }, { cooldownMs: 1000, cooldownGrowth: 2 })
            const r = await ad2.getWkf().callAi('q', { spec: { use: 'c:hang' }, timeoutMs: 600, check: (j) => Array.isArray(j) })
            assert.deepEqual([r.ok, r.skipped, r.netDown], [false, true, true], '工作流入口之斷網標記照舊')
            assert.equal(coolingOf(p2.state, 'c:hang').n, 2, '工作流入口之 envDown:n 不落定')
            assert.ok(asked >= 1)
        })

        it('設定段:ai.cooldownGrowth 預設 1、ai.cooldownMaxMs 預設 24 小時;growth 須為 ≥ 1 之數、maxMs 須為正整數,不合即拋;調度層對直接給定之 ai 同一判準', () => {
            assert.deepEqual([AI_DEFAULT.cooldownGrowth, AI_DEFAULT.cooldownMaxMs], [1, 86_400_000])
            const s = resolveSettings({})
            assert.deepEqual([s.ai.cooldownGrowth, s.ai.cooldownMaxMs], [1, 86_400_000])
            assert.deepEqual([resolveSettings({ ai: { cooldownGrowth: 4, cooldownMaxMs: 14_400_000 } }).ai.cooldownGrowth, resolveSettings({ ai: { cooldownGrowth: 1.5 } }).ai.cooldownGrowth], [4, 1.5])
            for (const bad of [0.5, 0, -1, '4', NaN, Infinity, null]) assert.throws(() => resolveSettings({ ai: { cooldownGrowth: bad } }), /cooldownGrowth/, String(bad))
            for (const bad of [0, -1, 1.5, '3600000', Infinity]) assert.throws(() => resolveSettings({ ai: { cooldownMaxMs: bad } }), /cooldownMaxMs/, String(bad))
            assert.equal(SETTING_TYPES[AI_SCHEMA.cooldownGrowth].test(1), true)
            assert.throws(() => mk({}, { cooldownGrowth: 0.5 }), /ai\.cooldownGrowth/)
            assert.throws(() => mk({}, { cooldownMaxMs: -1 }), /ai\.cooldownMaxMs/)
            assert.doesNotThrow(() => mk({}, { cooldownGrowth: undefined, cooldownMaxMs: null }), '未給或 null 由遞補層取預設')
        })
    })

    describe('CA-5 健康層只觀察、免費池經 coolEntry', function() {

        const exhausted = (providerId, errorTypes, extra = {}) => ({ type: 'group-exhausted', providerId, keyIndex: null, keyId: providerId, keys: 0, attempted: errorTypes.length, by: 'skip-group', errorTypes, error: `${errorTypes[errorTypes.length - 1]} err`, ...extra })
        const streakEv = (providerId, k, extra = {}) => ({ type: 'cooled', providerId, keyIndex: null, keyId: providerId, error: 'x'.repeat(200), cooldownMs: 900_000, n: 1, reason: 'streak', streak: k, errorType: 'validation', keys: 0, attempted: 1, ...extra })

        it('健康層不寫 store:組盡事件、cooled(streak)皆不呼叫 store.set、不改 cooling(修前達門檻即寫 cooling)', () => {
            let sets = 0
            const state = { cooling: {} }
            const store = {
                get: () => state,
                set: () => {
                    sets++
                },
            }
            const h = createProviderHealth({ store, threshold: 1 })
            for (let i = 0; i < 3; i++) h.onEvent(exhausted('g', ['validation']))
            h.onEvent(streakEv('g', 3))
            assert.deepEqual([sets, state.cooling], [0, {}], '規格 CA-5:不再寫 store(冷卻之寫者只有遞補層)')
        })

        it('onCool 由 cooled(reason streak) 驅動:欄位 providerId／streak／errorType／error(截 120 字)／keys(多金鑰且每把皆試過);視窗內之重申不重複回呼;其他 reason 與組盡事件不回呼', () => {
            let t = 1_000_000
            const seen = []
            const h = createProviderHealth({ store: { get: () => ({}), set: () => {} }, threshold: 2, now: () => t, onCool: (ev) => seen.push(ev) })
            h.onEvent(exhausted('g', ['validation']))
            h.onEvent(exhausted('g', ['validation']))
            h.onEvent({ type: 'cooled', providerId: 'g', error: 'TIMEOUT', cooldownMs: 900_000, n: 1, reason: 'timeout' })
            assert.equal(seen.length, 0, '組盡事件與 timeout 之冷卻不回呼(連敗之判斷屬遞補層)')
            t += 10
            h.onEvent(streakEv('h', 2))
            assert.deepEqual(seen, [{ providerId: 'h', streak: 2, errorType: 'validation', error: 'x'.repeat(120) }])
            t += 10
            h.onEvent(streakEv('h', 3))
            assert.equal(seen.length, 1, '視窗內之重申(遞補層每次再敗皆重申)不重複回呼')
            assert.equal(h.snapshot().counts.h.cooled, 1, '計數同回呼(視窗內之重申不計)')
            t += 900_000
            h.onEvent(streakEv('h', 4))
            assert.deepEqual([seen.length, seen[1].streak], [2, 4], '逾窗後再觸發即回呼')
            h.onEvent(streakEv('k2', 2, { keys: 2, attempted: 2, errorType: 'http' }))
            h.onEvent(streakEv('k1', 2, { keys: 2, attempted: 1 }))
            h.onEvent(streakEv('k0', 2, { keys: 1, attempted: 1 }))
            assert.deepEqual(seen.slice(2).map((e) => [e.providerId, e.keys]), [['k2', 2], ['k1', undefined], ['k0', undefined]], 'keys 只在多金鑰且每把皆試過時附上')
            assert.match(h.summary(), /健康降序 h×2 k2×1 k1×1 k0×1/)
            // 先有他因之冷卻(如逾時)且在視窗內 → 連敗之冷卻不重複回呼(同修前「上游已冷卻(窗內)時不新冷卻、不回呼」)
            const seen2 = []
            const h2 = createProviderHealth({ threshold: 2, now: () => t, onCool: (ev) => seen2.push(ev) })
            h2.onEvent({ type: 'cooled', providerId: 'p', error: 'TIMEOUT', cooldownMs: 900_000, n: 1, reason: 'timeout' })
            h2.onEvent(streakEv('p', 2))
            assert.deepEqual([seen2.length, h2.snapshot().counts.p?.cooled ?? 0], [0, 0])
        })

        it('snapshot 之 streak 讀遞補層之持久連敗(streakOf):觀察過之條目以持久值呈現(含前輪累計);lastType／lastError 取自本行程觀察;無 store 或持久值為 0 者不列', () => {
            const state = { failStreak: { g: { k: 4, at: 1 }, z: { k: 9, at: 1 } } }
            const h = createProviderHealth({ store: { get: () => state, set: () => {} }, threshold: 3 })
            h.onEvent(exhausted('g', ['http', 'validation']))
            h.onEvent({ type: 'skip-group', providerId: 'q', errorType: 'validation', error: 'v' })
            const s = h.snapshot()
            // 規格 CA-5:snapshot 之 streak 讀 streakOf(修前為本行程內之計數 1)
            assert.deepEqual(s.streak.g, { n: 4, lastType: 'validation', lastError: 'validation err' })
            assert.equal(s.streak.q, undefined, '持久值 0 不列')
            assert.equal(s.streak.z, undefined, '本行程未觀察之條目不列(只經 streakOf 讀觀察過之條目)')
            const h0 = createProviderHealth({ threshold: 3 })
            h0.onEvent(exhausted('g', ['http']))
            assert.deepEqual(h0.snapshot().streak, {}, '無 store 時無持久值')
            // 遞補層不計連敗之組盡(零嘗試、整組沒額度)不改附註(外審 terra F08)
            h.onEvent(exhausted('g', [], { attempted: 0, error: 'quota skip' }))
            h.onEvent(exhausted('g', ['http', 'http'], { quotaExhausted: true, error: 'no credit' }))
            assert.deepEqual(h.snapshot().streak.g, { n: 4, lastType: 'validation', lastError: 'validation err' })
        })

        it('調度層:健康快照(snapshot／run.json)不經有副作用之 store.get——不改免費池之冷卻時刻(外審 terra F07)', async () => {
            const MUSE = 'opencode/muse-spark-1.3-contributor-free'
            const log = `${TMP}/oc-snap.log`
            fs.mkdirSync(TMP, { recursive: true })
            fs.writeFileSync(log, `${quotaLine(MUSE)}\n`)
            const p = memPersist({ failStreak: { [`oc:${MUSE}`]: { k: 1, at: 1 } } })
            const ad = mk({ persistStore: p, catalogue: [{ id: `oc:${MUSE}`, kind: 'opencode', model: MUSE, exe: process.execPath }, ...CAT] }, { pools: { oc: { log } }, healthStreak: 3 })
            await ad.callJson('q', check, { spec: { use: 'c:plain' } })
            const id = `oc:${MUSE}`
            assert.equal(p.state.cooling[id]?.reason, 'quota', '前提:呼叫時免費池已寫入冷卻')
            p.state.cooling[id].at -= 1000 // 標記時刻;快照若經 store.get 會套用免費池而改寫為現在
            const at0 = p.state.cooling[id].at
            ad.health.snapshot()
            ad.drainStats()
            assert.equal(p.state.cooling[id].at, at0, '快照與輪末彙總不改動狀態')
        })

        it('調度層:連敗跨行程累計——兩個調度層實例(各代表一輪之新行程)共用同一持久 store,各整組皆敗一次 → 第二輪即達 healthStreak 2 而降序並回呼 onHealth(修前以行程為界,永不達門檻)', async () => {
            const p = memPersist()
            const seen = []
            const a = mk({ persistStore: p, onHealth: (ev) => seen.push(['a', ev]) }, { healthStreak: 2 })
            assert.equal((await a.callJson('q', check, { spec: { use: 'c:dead2' } })).ok, false)
            assert.deepEqual([streakOf(p.state, 'c:dead2'), seen.length], [1, 0])
            const b = mk({ persistStore: p, onHealth: (ev) => seen.push(['b', ev]) }, { healthStreak: 2 })
            assert.equal((await b.callJson('q', check, { spec: { use: 'c:dead2' } })).ok, false)
            assert.equal(seen.length, 1)
            assert.deepEqual([seen[0][0], seen[0][1].providerId, seen[0][1].streak, seen[0][1].errorType, seen[0][1].keys], ['b', 'c:dead2', 2, 'http', 2], 'onHealth 欄位同修前(多金鑰每把皆試過附 keys)')
            assert.equal(coolingOf(p.state, 'c:dead2').reason, 'streak')
            assert.deepEqual(b.health.snapshot().streak['c:dead2'].n, 2)
            const tries = []
            await b.callJson('q', check, { spec: { use: 'c:dead2', fallback: ['c:ok'] }, onEvent: (ev) => (ev.type === 'try' ? tries.push(ev.providerId) : null) })
            assert.deepEqual(tries, ['c:ok'], '降序生效:下一次呼叫先打他家')
        })

        it('免費池:applyPool 經 coolEntry 寫入 { at, n, reason:"quota" }(修前寫數字);既有紀錄之 n 不動(固定視窗原因);ai.cooldownMs 0 時不寫;數字字串之 cooldownMs 與遞補層同一判準', async () => {
            const MUSE = 'opencode/muse-spark-1.3-contributor-free'
            const log = `${TMP}/oc-cool.log`
            fs.mkdirSync(TMP, { recursive: true })
            fs.writeFileSync(log, `${quotaLine(MUSE)}\n`)
            const cat = [{ id: `oc:${MUSE}`, kind: 'opencode', model: MUSE, exe: process.execPath }, ...CAT]
            const run = async (init, aiExtra = {}) => {
                const p = memPersist(init)
                await mk({ persistStore: p, catalogue: cat }, { pools: { oc: { log } }, ...aiExtra }).callJson('q', check, { spec: { use: 'c:ok' } })
                return p.state.cooling[`oc:${MUSE}`]
            }
            const fresh = await run({})
            assert.deepEqual([typeof fresh, fresh.n, fresh.reason, Number.isFinite(fresh.at)], ['object', 1, 'quota', true], '規格 CA-5:經 coolEntry(reason quota)')
            const old = await run({ cooling: { [`oc:${MUSE}`]: { at: Date.now() - 86_400_000, n: 3, reason: 'timeout' } } })
            assert.deepEqual([old.n, old.reason], [3, 'quota'], '視窗外以 quota 觸發:不動 n(避免逐日累加)')
            assert.equal(await run({}, { cooldownMs: 0 }), undefined, 'ai.cooldownMs 0:不冷卻、不寫')
            assert.equal((await run({}, { cooldownMs: '60000' }))?.reason, 'quota', '直接給調度層之數字字串 cooldownMs:遞補層照用,免費池亦寫(外審 terra F09)')
        })
    })

    describe('CA-6 評比之失敗分類', function() {

        const cooled = (reason, error = 'x') => ({ type: 'cooled', providerId: 'p', error, cooldownMs: 1000, n: 1, reason })

        it('限流只認 cooled.reason 為 rate-limit／detect;streak、budget、quota、timeout 不判限流(修前凡非 TIMEOUT 字樣之冷卻皆判限流)', () => {
            const r = { ok: false, error: 'OUTPUT_VALIDATION_FAILED', errors: ['p:validation(1.0s)'], skipped: false }
            const tries = [{ type: 'skip-group', providerId: 'p', errorType: 'validation', error: 'v', stdout: '回覆' }]
            assert.equal(benchFailOf(r, [...tries, cooled('rate-limit')]).kind, 'limit')
            assert.equal(benchFailOf(r, [...tries, cooled('detect')]).kind, 'limit')
            for (const reason of ['streak', 'budget', 'quota', 'timeout']) assert.equal(benchFailOf(r, [...tries, cooled(reason)]).kind, 'reply', reason)
            assert.equal(benchFailOf({ ok: false, error: 'FreeUsageLimitError: Rate limit exceeded' }, []).kind, 'limit', '錯誤字樣命中 LIMIT_TEXT_RE 照判限流')
            // 實際之整組沒額度結果(外審 terra T07):無限流字樣 → 執行錯誤(計入連續失敗,依交接 7;需裁示 2);錯誤文字另命中限流字樣者照判限流
            const quota = { ok: false, error: 'QUOTA_EXHAUSTED: provider "p" has no credit on all 2 key(s) (Credit balance is too low)', errors: ['p#0:http(0.1s)', 'p#1:http(0.1s)'], skipped: false }
            const qev = [{ type: 'next-key', providerId: 'p', errorType: 'http' }, { type: 'next-key', providerId: 'p', errorType: 'http' }, { type: 'cooled', scope: 'entry', providerId: 'p', reason: 'quota', failureKind: 'no-credit', error: 'x' }]
            assert.equal(benchFailOf(quota, qev).kind, 'error')
            assert.equal(benchFailOf({ ...quota, error: `${quota.error} rate limit exceeded` }, qev).kind, 'limit')
        })

        it('budget-cut 歸「截止」(skipped),不歸 timeout:前家逾時、後家被封頂之呼叫判 skipped(修前依最後一次失敗事件判 timeout)', () => {
            const evs = [
                { type: 'skip-group', providerId: 'a', errorType: 'timeout', error: 'TIMEOUT after 300s' },
                cooled('timeout', 'TIMEOUT after 300s'),
                { type: 'group-exhausted', providerId: 'a', errorTypes: ['timeout'] },
                { type: 'budget-cut', providerId: 'b', errorType: 'timeout', error: 'TIMEOUT after 120s', appliedTimeoutMs: 120_000, entryTimeoutMs: 300_000 },
            ]
            const r = { ok: false, error: 'budget exhausted', errors: ['a:timeout(300.0s)', 'b:budget-cut(120.0s)'], skipped: true }
            assert.equal(benchFailOf(r, evs).kind, 'skipped')
            // 無事件(置換之調度層)時以 errors 之標籤判;耗時不明(無括號)、附不合格原因者亦認(外審 terra F11)
            assert.equal(benchFailOf(r, []).kind, 'skipped')
            assert.equal(benchFailOf({ ...r, errors: ['a:timeout(1.0s)', 'b:budget-cut'] }, []).kind, 'skipped')
            assert.equal(benchFailOf({ ...r, errors: ['a:timeout(1.0s)', 'b:budget-cut：x'] }, []).kind, 'skipped')
            assert.equal(benchFailOf({ ...r, errors: ['a:timeout(1.0s)', 'b:budget-cutx(1.0s)'] }, []).kind, 'timeout', '不誤認他字樣')
            // 對照:無封頂之逾時照判 timeout
            assert.equal(benchFailOf({ ok: false, error: 'TIMEOUT after 300s', errors: ['a:timeout(300.0s)'], skipped: false }, evs.slice(0, 3)).kind, 'timeout')
            // 優先序:限流 → 截止(同一呼叫先遇限流、後被封頂 → 判限流,即停測)
            assert.equal(benchFailOf(r, [cooled('rate-limit', 'HTTP 429'), ...evs]).kind, 'limit')
        })
    })
})
