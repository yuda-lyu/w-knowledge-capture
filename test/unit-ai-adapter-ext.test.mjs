// unit-ai-adapter-ext.test.mjs — AI 調度層之高頻呼叫機制(core/ai/adapter 之 acceptTruncated、callOpt.avoid、preview、capability、
//   ai.pools、ai.healthStreak、ai.providerLimits)與其模組(core/ai/poolQuota、providerHealth、capability):開啟後之行為;預設關閉之對照見 unit-ai-adapter(規則⑧);
//   安裝端之資產與持久狀態(providerPick、exes、persistStore、usageCounter;aiUsageToday 之可用條目;逾長之結構旗標)見規則⑨
// 規則(出自各檔檔頭):
//   ①截斷放行(建構 acceptTruncated＋逐次布林覆寫):REST 截斷交本層驗證裁決,救不回者接截斷搶救(收前段完整項目),成功帶 truncated:true;
//     拿不到終止訊號之截斷(CLI 型)經搶救而成功、無 truncated;0 項可救、content_filter、可見輸出為空一律失敗;
//     外包物件之截斷被搶救成內層陣列(形狀改變),全有全無之輸出以逐次 false 關閉
//   ②不合格原因依發生順序歸屬:截斷內容被本層驗證拒收者(incomplete＋rejected by validate)附原因;未經本層驗證之失敗不取原因,後續家不錯位
//   ③避開(callOpt.avoid):避開所列條目、其餘依原序;避開後無條目則不避;非陣列視為未給
//   ④失敗預覽(preview):失敗形狀附最後一次失敗嘗試之 stdout 前 120 字(未送出即失敗者為 '');成功不附
//   ⑤免費池當日額度(ai.pools.oc):日誌本週期有額度字樣之 opencode 條目降至鏈尾、不移除;onPool 每條目每行程一次;成交即恢復;
//     字樣判讀、週期起點、增量讀取、檔尾上限、節流
//   ⑥供應商健康降序(ai.healthStreak):連續 N 次組盡即冷卻(降序)並回呼 onHealth;params 只記 mismatch;逐次失敗只記次數;
//     多金鑰與並行之計數依上游之組盡事件;回傳帶 health、drainStats 附健康摘要、截斷放行另計、執行摘要帶 ai.health
//   ⑦ai 段之機制鍵(pools／healthStreak／providerLimits)以值開關、預設值即關閉({}／0／{});給了而不合即拋(設定段與調度層同一判準)
//   ⑧能力預篩:依實際 prompt 長度(含防寫前綴)剔除放不下之條目、鏈序不變;逐 id 上限恆生效,條目與 kind 之固有上限於 capability 開啟時才計;
//     全鏈放不下即失敗不送出;onOversize 每條目一次、次數計於健康層;validateSeats 警告全鏈皆有上限之席位;先預篩再避開(避開不致使呼叫失敗)
//   ⑨安裝端之資產以建構選項給:providerPick 只展開所列(依序;未知 id 建構期拋)、exes 依 kind 注入;persistStore 以其內容為起點、get 恆回同一物件、
//     外來副本併入後寫回(讀寫失敗不影響呼叫);usageCounter 接手記帳與今日統計;aiUsageToday 帶 chain／providers(不帶金鑰)／skipped;逾長失敗帶 oversize
// 執行:自套件根 npx mocha test/unit-ai-adapter-ext.test.mjs(本機假 OpenAI 相容 REST 固定埠 8831;暫存 test/_tmp/ai-adapter-ext-<pid>,測完即刪;
//   不連外網、不呼叫真 AI 或真 CLI(opencode 條目之 exe 為 node＋工作目錄下之假腳本)、不讀本機真實 opencode 日誌(日誌一律為暫存檔))

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import NO_SIDE_EFFECT from 'w-dispatch-ai/src/wkf/noSideEffectPrefix.mjs'
import { createAiAdapter } from '../src/core/ai/adapter.mjs'
import { QUOTA_PATTERNS, parseQuotaLines, resetStartMs, createPoolQuota, defaultOpencodeLog } from '../src/core/ai/poolQuota.mjs'
import { createProviderHealth } from '../src/core/ai/providerHealth.mjs'
import { KIND_MAX_PROMPT_CHARS, maxPromptCharsOf, fitChain } from '../src/core/ai/capability.mjs'
import { AI_DEFAULT, AI_SCHEMA, SETTING_TYPES, resolveSettings } from '../src/core/settingsDefault.mjs'
import { buildRunSummary } from '../src/core/ops/runSummary.mjs'
import { tmpRoot } from './tools/captureTestKit.mjs'
import { removeRoots, sleep, msgOf } from './tools/testKit.mjs'

// 暫存根(套件內 test/_tmp/ai-adapter-ext-<pid>;before 建立、after 清除)
let TMP = ''
const PORT = 8831 // 假 REST(固定埠,≥8000、不隨機;本檔專屬)
const BASE = `http://127.0.0.1:${PORT}/v1`


// ── 假伺服器之情境(以 model 選取):content 與 finish_reason ──
const SCENES = {
    s1: { fr: 'length', content: '[{"index":1,"v":"a"},{"index":2,"v":"b"},{"index":3,"v":"c' }, // 2 項完整＋1 項半截
    s0: { fr: 'length', content: '[{"index":1,"v":"a"},{"index":2,"v":"b"},{"index":3,"v":"c"}]\n\n補充說明:以上三項皆依原文整理,其中第二項之' }, // JSON 完整,截在其後說明
    s2: { fr: 'length', content: '[{"index":1,"v":"a' }, // 0 項完整
    cf: { fr: 'content_filter', content: '[{"index":1,"v":"a"}]' },
    empty: { fr: 'length', content: '', reasoning: 600 },
    ok: { fr: 'stop', content: '[{"index":1,"v":"a"},{"index":2,"v":"b"},{"index":3,"v":"c"}]' },
    cut: { fr: 'stop', content: '[{"index":1,"v":"a"},{"index":2,"v":"b"},{"index":3,"v":"c' }, // 拿不到終止訊號之截斷(CLI 型)
    plain: { fr: 'stop', content: '好的,這是純文字回覆,不是 JSON。' },
    long: { fr: 'stop', content: `長回覆:${'甲乙丙丁'.repeat(60)}` }, // 244 字之非 JSON(預覽截字用)
    // 全有全無之輸出(外包物件)
    dobj: { fr: 'stop', content: '{"ops":[{"op":"add","text":"a"},{"op":"confirm","id":"C1"}],"skipped":[]}' },
    dtrunc: { fr: 'length', content: '{"ops":[{"op":"add","text":"a"},{"op":"confirm","id":"C1"},{"op":"essence","text":"x' }, // REST 截斷
    dcut: { fr: 'stop', content: '{"ops":[{"op":"add","text":"a"},{"op":"confirm","id":"C1"},{"op":"ess' }, // 拿不到終止訊號之截斷
    darr: { fr: 'stop', content: '[{"op":"add","text":"a"}]' }, // 頂層陣列(未照外包物件格式)
}
const hits = [] // 每次請求 { model, key }

// ── model 'plan' 之排程(依 prompt 內 [[標籤]] 與 Bearer 金鑰):延遲與回應;供並行呼叫跨越一次成交之四情境 ──
//   json＝完整 JSON 陣列(成交);plain＝非 JSON(驗證失敗,整組跳過);st＝非 200 狀態碼(換金鑰)
const PLAN = {
    // 控制組:依序兩呼叫,皆 ka 401、kb 非 JSON
    'C1|ka': { ms: 20, st: 401 },
    'C1|kb': { ms: 20, body: 'plain' },
    'C2|ka': { ms: 20, st: 401 },
    'C2|kb': { ms: 20, body: 'plain' },
    // 多計情境:X、Y 並行,X 之 ka 於 100ms 成交(游標推進到 kb);Y 之 ka 於 300ms 回 401(成交之後)、kb 非 JSON;其後 Z 自 kb 起跑:kb 401、ka 非 JSON
    'X|ka': { ms: 100, body: 'json' },
    'Y|ka': { ms: 300, st: 401 },
    'Y|kb': { ms: 20, body: 'plain' },
    'Z|kb': { ms: 20, st: 401 },
    'Z|ka': { ms: 20, body: 'plain' },
    // 少計情境:X3、Y3 並行,Y3 之 ka 於 20ms 回 401(成交之前),X3 之 ka 於 100ms 成交,Y3 之 kb 於其後回 401(兩把皆敗)
    'X3|ka': { ms: 100, body: 'json' },
    'Y3|ka': { ms: 20, st: 401 },
    'Y3|kb': { ms: 200, st: 401 },
    // 多計情境(預算用盡):budgetMs 20500;X4、Y4 並行,X4 之 ka 成交;Y4 之 ka 於 1 秒回 401 → 剩餘不足 20000,組內預算用盡;Z4 自 kb 起跑亦同
    'X4|ka': { ms: 100, body: 'json' },
    'Y4|ka': { ms: 1000, st: 401 },
    'Z4|kb': { ms: 1000, st: 401 },
}

/**
 * 假伺服器:dead* 金鑰回 401;rl503 回 503(本體含 rate limit);sl500／x500 回 500(本體為額度用盡原文／無字樣);plan 依排程表;其餘依情境回 200
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
        hits.push({ model, key })
        try {
            if (model === 'plan') {
                const tag = (String(body.messages?.[body.messages.length - 1]?.content || '').match(/\[\[(\w+)\]\]/) || [])[1] || '?'
                const p = PLAN[`${tag}|${key}`] || { st: 500 }
                await sleep(p.ms || 0)
                if ((p.st || 200) !== 200) {
                    res.writeHead(p.st, { 'Content-Type': 'application/json' })
                    res.end('{"message":"invalid key"}')
                    return
                }
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: p.body === 'json' ? SCENES.ok.content : SCENES.plain.content }, finish_reason: 'stop' }] }))
                return
            }
            if (key.startsWith('dead')) {
                res.writeHead(401, { 'Content-Type': 'application/json' })
                res.end('{"message":"invalid key"}')
                return
            }
            if (model === 'rl503') {
                res.writeHead(503, { 'Content-Type': 'application/json' })
                res.end('{"error":"rate limit exceeded, retry later"}')
                return
            }
            if (model === 'sl500' || model === 'x500') {
                res.writeHead(500, { 'Content-Type': 'text/plain' })
                res.end(model === 'sl500' ? 'You\'ve hit your session limit · resets 10:30am (Asia/Taipei)' : 'internal error')
                return
            }
            const sc = SCENES[model] || SCENES.plain
            const usage = { prompt_tokens: 10, completion_tokens: 5, ...(sc.reasoning ? { completion_tokens_details: { reasoning_tokens: sc.reasoning } } : {}) }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ id: 'fake', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: sc.content }, finish_reason: sc.fr }], usage }))
        }
        catch { /* 連線已被中止 */ }
    })
}

// ── 供應商條目(安裝方自帶形狀,走 envVar 展開金鑰;以 catalogue 注入,不混入內建目錄)──
const rest = (id, model, envVar = 'FAKE_ONE', extra = {}) => ({ id, model, kind: 'api-openai-compat', baseURL: BASE, envVar, ...extra })
const CAT = [
    rest('rest:s1', 's1'),
    rest('rest:s0', 's0'),
    rest('rest:s2', 's2'),
    rest('rest:cf', 'cf'),
    rest('rest:empty', 'empty'),
    rest('rest:ok', 'ok'),
    rest('rest:ok2', 'ok'),
    rest('rest:cut', 'cut'),
    rest('rest:plain', 'plain'),
    rest('rest:long', 'long'),
    rest('rest:plainv', 'plain', 'FAKE_ONE', { validate: 'nonempty' }), // 單把金鑰、條目自帶 validate
    rest('rest:rl503', 'rl503'),
    rest('rest:sl500', 'sl500'),
    rest('rest:x500', 'x500'),
    rest('rest:dead2', 'ok', 'FAKE_DEAD2'), // 兩把皆死
    rest('rest:half', 'ok', 'FAKE_HALF'), // 一死一活
    rest('rest:plan', 'plan', 'FAKE_PLAN'), // 依排程表(兩把 ka、kb)
    rest('rest:nokey', 'plain', null), // 無金鑰條目(不帶認證標頭;回非 JSON → 驗證失敗)
    rest('rest:dobj', 'dobj'),
    rest('rest:dtrunc', 'dtrunc'),
    rest('rest:dcut', 'dcut'),
    rest('rest:darr', 'darr'),
]
const ENV = { FAKE_ONE: 'k1', FAKE_DEAD2: 'deadA, deadB,', FAKE_HALF: 'deadX,liveY', FAKE_PLAN: 'ka,kb' }

// 非空陣列才合格(調度層只認 === true;回字串＝不合格原因)
const check = (d) => (Array.isArray(d) && d.length > 0 ? true : '須為非空陣列')
// 外包物件之結構驗證(全有全無之輸出):須為非陣列物件且 ops 為陣列
const strict = (d) => (!!d && typeof d === 'object' && !Array.isArray(d) && Array.isArray(d.ops) ? true : '須為外包物件 { ops }')

let seq = 0

/**
 * 建立一個 adapter(每個測試各自一個,游標／冷卻／用量／健康互不干擾)
 *
 * @param {Object} [o={}] 輸入 createAiAdapter 之其他選項(覆寫預設之 workspace／env／catalogue)
 * @param {Object} [aiExtra={}] 輸入覆寫 settings.ai 之鍵(含擴充鍵 pools、healthStreak)
 * @returns {Object} 回傳 adapter
 */
const mk = (o = {}, aiExtra = {}) => createAiAdapter({
    ai: { ...AI_DEFAULT, ...aiExtra },
    workspace: `${TMP}/ws-${++seq}`,
    env: ENV,
    catalogue: CAT,
    ...o,
})

/**
 * 呼叫一次並收集各次嘗試之條目 id(依序)
 *
 * @param {Object} ai 輸入 adapter
 * @param {Object} spec 輸入席位
 * @param {Object} [extra={}] 輸入其他逐次選項
 * @returns {Promise} 回傳 { r, tries }
 */
const tryOrder = async (ai, spec, extra = {}) => {
    const tries = []
    const r = await ai.callJson('q', check, { spec, ...extra, onEvent: (ev) => (ev.type === 'try' ? tries.push(ev.providerId) : null) })
    return { r, tries }
}

describe('unit-ai-adapter-ext', function() {

    this.timeout(60_000)

    let server = null

    before(async function() {
        TMP = tmpRoot('ai-adapter-ext')
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

    describe('建構選項與 ai 段機制鍵之檢核(規則⑦)', function() {

        it('acceptTruncated／preview／capability 給了而非布林值即拋(打錯型別不可靜默關閉);未給或 null 為關', () => {
            for (const k of ['acceptTruncated', 'preview', 'capability']) {
                for (const bad of ['true', 1, 0, {}, []]) assert.throws(() => mk({ [k]: bad }), new RegExp(`createAiAdapter 之 ${k} 須為布林值`), `${k}=${JSON.stringify(bad)}`)
                for (const v of [undefined, null, true, false]) assert.doesNotThrow(() => mk({ [k]: v }), `${k}=${String(v)}`)
            }
        })

        it('ai.pools／ai.healthStreak／ai.providerLimits 給了而形狀不合即拋(訊息附原因,與設定段同一判準);未給、null 或預設值({}／0／{})為不開', () => {
            for (const bad of [-1, 1.5, '3', true, {}]) {
                assert.throws(() => mk({}, { healthStreak: bad }), /^Error: createAiAdapter 之 ai\.healthStreak 須為非負整數$/, `healthStreak=${JSON.stringify(bad)}`)
            }
            assert.equal(msgOf(() => mk({}, { pools: { oc: { resetUtcHour: 24 } } })), `createAiAdapter 之 ai.pools 須為${SETTING_TYPES.pools.desc}（oc.resetUtcHour 須為 0～23 之整數）`)
            assert.match(msgOf(() => mk({}, { pools: { mimo: {} } })), /（含不認得之鍵：mimo（可用：oc））$/)
            assert.match(msgOf(() => mk({}, { pools: 'auto' })), /ai\.pools 須為.*（須為物件）$/)
            for (const bad of [{ 'rest:ok': -1 }, { 'rest:ok': 1.5 }, { 'rest:ok': '100' }, [], 'x']) {
                assert.equal(msgOf(() => mk({}, { providerLimits: bad })), `createAiAdapter 之 ai.providerLimits 須為${SETTING_TYPES.limits.desc}`, JSON.stringify(bad))
            }
            assert.doesNotThrow(() => mk({}, { providerLimits: { 'rest:ok': 0 } }), '0＝解除該條目之固有上限(與 capability 之契約一致)')
            for (const v of [undefined, null]) {
                const ad = mk({}, { pools: v, healthStreak: v, providerLimits: v })
                assert.equal('health' in ad, false, `${String(v)}:不開`)
            }
            assert.deepEqual([AI_DEFAULT.pools, AI_DEFAULT.healthStreak, AI_DEFAULT.providerLimits], [{}, 0, {}], '預設值即關閉')
            assert.equal('health' in mk(), false, '預設設定(healthStreak 0):無健康層')
        })

        it('回傳之鍵:給 ai.healthStreak 才多 health(冷卻視窗＝ai.cooldownMs);只給 ai.pools 不增鍵', () => {
            const base = ['aiUsageToday', 'available', 'callJson', 'chainFor', 'drainStats', 'recordCall', 'validateSeats']
            assert.deepEqual(Object.keys(mk({}, { healthStreak: 2 })).sort(), [...base, 'health'].sort())
            assert.deepEqual(Object.keys(mk({}, { pools: { oc: { log: `${TMP}/none.log` } } })).sort(), base)
            const h = mk({}, { healthStreak: 4, cooldownMs: 600_000 }).health
            assert.deepEqual([h.threshold, h.windowMs], [4, 600_000])
            for (const k of ['onEvent', 'noteOversize', 'noteTruncated', 'snapshot', 'summary']) assert.equal(typeof h[k], 'function', k)
        })

        it('設定段:ai 段收 pools／healthStreak／providerLimits(預設 {}／0／{}＝關閉;值即開關);不合者拋錯並附原因', () => {
            assert.deepEqual([AI_SCHEMA.pools, AI_SCHEMA.healthStreak, AI_SCHEMA.providerLimits], ['pools', 'p0int', 'limits'])
            const off = resolveSettings({}).ai
            assert.deepEqual([off.pools, off.healthStreak, off.providerLimits], [{}, 0, {}], '未給即預設之關閉值')
            const on = resolveSettings({ ai: { pools: { oc: { log: 'auto', resetUtcHour: 0 } }, healthStreak: 3, providerLimits: { 'agy:x': 20_000 } } }).ai
            assert.deepEqual([on.pools, on.healthStreak, on.providerLimits, on.timeoutMs], [{ oc: { log: 'auto', resetUtcHour: 0 } }, 3, { 'agy:x': 20_000 }, AI_DEFAULT.timeoutMs])
            assert.doesNotThrow(() => mk({}, on), '設定段之產物可直接交調度層(含 auto 之池設定;建構時不讀日誌)')
            for (const v of [{ oc: { log: 'x:/logs/opencode.log', resetUtcHour: 23 } }, { oc: { log: 'auto' } }, { oc: {} }, {}]) assert.equal(SETTING_TYPES.pools.test(v), true, JSON.stringify(v))
            const bad = [
                ['x', '"x"', '須為物件'],
                [null, 'null', '須為物件'],
                [[], 'array', '須為物件'],
                [{ oc: 'auto' }, 'object', 'oc 須為物件 { log?, resetUtcHour? }'],
                [{ mimo: {} }, 'object', '含不認得之鍵：mimo（可用：oc）'],
                [{ oc: {}, x: 1 }, 'object', '含不認得之鍵：x（可用：oc）'],
                [{ oc: { log: '' } }, 'object', "oc.log 須為 'auto' 或日誌路徑（非空字串）"],
                [{ oc: { resetUtcHour: 24 } }, 'object', 'oc.resetUtcHour 須為 0～23 之整數'],
                [{ oc: { resetUtcHour: 1.5 } }, 'object', 'oc.resetUtcHour 須為 0～23 之整數'],
                [{ oc: { typo: 1 } }, 'object', 'oc 含不認得之鍵：typo（可用：log、resetUtcHour）'],
            ]
            for (const [v, shown, why] of bad) {
                assert.equal(SETTING_TYPES.pools.test(v), false, JSON.stringify(v))
                assert.equal(msgOf(() => resolveSettings({ ai: { pools: v } })), `settings.ai.pools 須為${SETTING_TYPES.pools.desc}，收到 ${shown}（${why}）`)
            }
            assert.equal(msgOf(() => resolveSettings({ ai: { healthStreak: -1 } })), 'settings.ai.healthStreak 須為非負整數，收到 -1')
            assert.equal(msgOf(() => resolveSettings({ ai: { providerLimits: { 'agy:x': -1 } } })), `settings.ai.providerLimits 須為${SETTING_TYPES.limits.desc}，收到 object`)
            assert.deepEqual(resolveSettings({ ai: { providerLimits: { 'agy:x': 0 } } }).ai.providerLimits, { 'agy:x': 0 }, '0＝解除該條目之固有上限')
            assert.notEqual(SETTING_TYPES.limits.desc, SETTING_TYPES.timeouts.desc, '長度上限之型別描述不借用逾時之描述')
        })

        it('抓取之總組裝路徑:resolveSettings 之產物(機制鍵皆預設)建出之調度層與未擴充前同形——無 health、validateSeats 無警告', () => {
            const ad = createAiAdapter({ ai: resolveSettings({}).ai, workspace: `${TMP}/ws-asm`, env: ENV, catalogue: CAT })
            assert.deepEqual(Object.keys(ad).sort(), ['aiUsageToday', 'available', 'callJson', 'chainFor', 'drainStats', 'recordCall', 'validateSeats'])
            assert.deepEqual(ad.validateSeats({ s: { use: 'rest:ok', fallback: ['rest:plain'] } }), { ok: true, warnings: [] })
        })
    })

    describe('安裝端之資產與持久狀態(providerPick、exes、persistStore、usageCounter;檔頭【安裝端之資產以建構選項給】【狀態】)', function() {

        /**
         * 記錄讀寫之持久層替身(同 createFileStore 之契約:get 回存檔之內容、set 存檔)
         *
         * @param {Object} [initial] 輸入起始內容
         * @returns {Object} 回傳 { get, set, saved:Array(每次 set 之深拷貝), reads:Function }
         */
        const memPersist = (initial = {}) => {
            let disk = JSON.parse(JSON.stringify(initial))
            let n = 0
            const saved = []
            return {
                get: () => {
                    n++
                    return JSON.parse(JSON.stringify(disk))
                },
                set: (s) => {
                    disk = JSON.parse(JSON.stringify(s))
                    saved.push(disk)
                },
                saved,
                reads: () => n,
            }
        }

        it('providerPick:只展開所列、依序;引用目錄有而未列者訊息為「未列於 ai.providerPick」;未知 id 建構期拋錯並附最接近之 id;形狀不合即拋', () => {
            const ad = mk({ providerPick: ['rest:ok2', 'rest:ok'] })
            assert.deepEqual(ad.available().ids, ['rest:ok2', 'rest:ok'], '依所列之序')
            assert.match(msgOf(() => ad.chainFor({ use: 'rest:plain' })), /rest:plain（未列於 ai\.providerPick）/)
            assert.match(msgOf(() => ad.chainFor({ use: 'rest:okk' })), /rest:okk（內建目錄與 ai\.extraProviders 皆無；最接近：rest:ok/)
            assert.match(msgOf(() => mk({ providerPick: ['rest:ok', 'rest:okk'] })), /^ai\.providerPick 含未知 id：rest:okk（內建目錄與 ai\.extraProviders 皆無；最接近：rest:okk→rest:ok2?）$/)
            for (const bad of [[], 'rest:ok', [''], [1], {}]) assert.equal(msgOf(() => mk({ providerPick: bad })), 'createAiAdapter 之 providerPick 須為條目 id 之非空字串陣列', JSON.stringify(bad))
            assert.equal(mk({ providerPick: null }).available().ids.length, CAT.length, 'null 視為未給(全目錄)')
        })

        it('exes:依 kind 注入 CLI 執行檔路徑(條目已自帶 exe 者不覆寫);非物件即拋', () => {
            const cat = [{ id: 'cli:a', kind: 'claude', model: 'sonnet' }, { id: 'cli:b', kind: 'claude', model: 'sonnet', exe: 'c:/own.exe' }, { id: 'cli:c', kind: 'codex', model: 'm' }]
            const ad = mk({ catalogue: cat, exes: { claude: 'c:/x/claude.exe' } })
            assert.deepEqual(['cli:a', 'cli:b', 'cli:c'].map((id) => ad.chainFor({ use: id })[0].exe), ['c:/x/claude.exe', 'c:/own.exe', undefined])
            assert.equal(msgOf(() => mk({ exes: 'c:/x.exe' })), 'createAiAdapter 之 exes 須為物件 { kind: CLI 執行檔路徑 }')
        })

        it('persistStore:以其內容為起點(行程內只讀一次);get 恆回同一物件;外來副本併入而非整份取代並寫回;冷卻(限流字樣)落入持久層;形狀不合即拋', async () => {
            const ps = memPersist({ cursors: { 'rest:half': 1 }, extra: 'kept' })
            const ad = mk({ persistStore: ps })
            const r = await ad.callJson('q', check, { spec: { use: 'rest:rl503', fallback: ['rest:ok'] } })
            assert.equal(r.ok, true)
            assert.equal(ps.reads(), 1, '只於第一次取用時讀取持久層')
            const last = ps.saved[ps.saved.length - 1]
            assert.ok(Number.isFinite(last.cooling?.['rest:rl503']), '限流之冷卻寫回持久層')
            assert.deepEqual([last.cursors?.['rest:half'], last.extra], [1, 'kept'], '既有內容保留(不整份取代)')
            await ad.callJson('q', check, { spec: { use: 'rest:ok' } })
            assert.equal(ps.reads(), 1, '其後之呼叫用同一物件,不重讀')
            for (const bad of ['x', {}, { get: () => ({}) }]) assert.equal(msgOf(() => mk({ persistStore: bad })), 'createAiAdapter 之 persistStore 須為 { get(), set(state) }', JSON.stringify(bad))
        })

        it('persistStore:讀取拋錯或非物件 → 視為全新狀態;寫回拋錯不影響呼叫', async () => {
            const broken = { get: () => { throw new Error('讀不到') }, set: () => { throw new Error('寫不進') } }
            const r = await mk({ persistStore: broken }).callJson('q', check, { spec: { use: 'rest:rl503', fallback: ['rest:ok'] } })
            assert.deepEqual([r.ok, r.providerId], [true, 'rest:ok'])
            const r2 = await mk({ persistStore: { get: () => 'garbage', set: () => {} } }).callJson('q', check, { spec: { use: 'rest:ok' } })
            assert.equal(r2.ok, true)
        })

        it('usageCounter:逐次事件交其記帳(本層不另計);aiUsageToday 之用量取其今日統計;計帳或查詢拋錯不影響呼叫;形狀不合即拋', async () => {
            const evs = []
            const uc = { onEvent: (ev) => evs.push(ev.type), today: () => ({ today: '2031-03-04', byKey: { 'rest:ok': 7 }, total: 7 }) }
            const ad = mk({ usageCounter: uc })
            await ad.callJson('q', check, { spec: { use: 'rest:ok' } })
            assert.ok(evs.includes('try') && evs.includes('ok'), `計數器收到逐次事件:${evs.join('、')}`)
            const u = ad.aiUsageToday()
            assert.deepEqual([u.today, u.used, u.byKey], ['2031-03-04', 7, { 'rest:ok': 7 }])
            const bad = mk({ usageCounter: { onEvent: () => { throw new Error('x') }, today: () => { throw new Error('y') } } })
            assert.equal((await bad.callJson('q', check, { spec: { use: 'rest:ok' } })).ok, true)
            assert.deepEqual([bad.aiUsageToday().used, bad.aiUsageToday().byKey], [0, {}])
            for (const b of ['x', { onEvent: () => {} }]) assert.equal(msgOf(() => mk({ usageCounter: b })), 'createAiAdapter 之 usageCounter 須為 { onEvent(ev), today() }')
        })

        it('aiUsageToday:另帶可用條目之 chain(「id×金鑰數」以 → 相連)、providers({ id, kind },不帶金鑰)、skipped(缺金鑰而停用者);未給 usageCounter 者用量為本行程內', async () => {
            const ad = mk({ providerPick: ['rest:half', 'rest:ok', 'rest:plan'], env: { FAKE_HALF: 'a,b', FAKE_ONE: 'k1' } })
            await ad.callJson('q', check, { spec: { use: 'rest:ok' } })
            const u = ad.aiUsageToday()
            assert.equal(u.chain, 'rest:half×2 → rest:ok×1')
            assert.deepEqual(u.providers, [{ id: 'rest:half', kind: 'api-openai-compat' }, { id: 'rest:ok', kind: 'api-openai-compat' }])
            assert.deepEqual(u.skipped, [{ id: 'rest:plan', envVar: 'FAKE_PLAN' }])
            assert.equal(JSON.stringify(u).includes('k1'), false, '不外露金鑰')
            assert.deepEqual([u.used, u.byKey], [1, { 'rest:ok#0': 1 }])
        })

        it('逾長失敗帶 oversize:true(呼叫端據此分辨,不比對字樣);其他失敗不帶', async () => {
            const ad = mk({ capability: true, catalogue: [...CAT, rest('rest:tiny', 'ok', 'FAKE_ONE', { maxPromptChars: 10 })] })
            const r = await ad.callJson('x'.repeat(50), check, { spec: { use: 'rest:tiny' } })
            assert.deepEqual([r.ok, r.attempts, r.oversize], [false, 0, true])
            assert.match(r.error, /超過本席位全部條目之上限/)
            const r2 = await ad.callJson('q', check, { spec: { use: 'rest:plain' } })
            assert.equal('oversize' in r2, false)
            const lifted = mk({ capability: true, catalogue: [...CAT, rest('rest:tiny', 'ok', 'FAKE_ONE', { maxPromptChars: 10 })] }, { providerLimits: { 'rest:tiny': 0 } })
            assert.equal((await lifted.callJson('x'.repeat(50), check, { spec: { use: 'rest:tiny' } })).ok, true, 'ai.providerLimits 給 0 即解除該條目之固有上限')
        })
    })

    describe('截斷放行與部分接受(規則①②)', function() {

        it('S1(2 完整＋1 半截):成功、收 2 項、truncated:true;健康層計「截斷放行」並帶入執行摘要與輪末彙總', async () => {
            const ai = mk({ acceptTruncated: true }, { healthStreak: 2 })
            const r = await ai.callJson('摘要', check, { spec: { use: 'rest:s1' } })
            assert.equal(r.ok, true, `未帶 acceptTruncated 即判 incomplete:${r.error}`)
            assert.deepEqual(r.data.map((x) => x.index), [1, 2], '搶救前段完整項目')
            assert.equal(r.truncated, true)
            assert.equal(r.attempts, 1)
            assert.equal(hits.length, 1)
            // 截斷放行另計、不當失敗
            const snap = ai.health.snapshot()
            assert.equal(snap.counts['rest:s1'].truncated, 1)
            assert.equal(snap.counts['rest:s1'].ok, 1)
            assert.match(ai.health.summary(), /截斷放行 rest:s1×1/)
            const sum = buildRunSummary({ ai, stamp: '20261007120000' })
            assert.equal(sum.ai.health.counts['rest:s1'].truncated, 1, '執行摘要 run.json 帶出')
            assert.match(sum.ai.callStats, /成交 rest:s1#0×1.*截斷放行 rest:s1×1/, '輪末彙總(drainStats)附健康摘要')
        })

        it('S0(JSON 完整、截在其後說明):成功全收 3 項、truncated:true', async () => {
            const ai = mk({ acceptTruncated: true })
            const r = await ai.callJson('摘要', check, { spec: { use: 'rest:s0' } })
            assert.equal(r.ok, true)
            assert.equal(r.data.length, 3)
            assert.equal(r.truncated, true)
        })

        it('S2(0 項完整):失敗 rejected by validate;content_filter 與可見輸出為空者一律失敗;完整成功不帶 truncated', async () => {
            const ai = mk({ acceptTruncated: true }, { healthStreak: 2 })
            const r2 = await ai.callJson('摘要', check, { spec: { use: 'rest:s2' } })
            assert.equal(r2.ok, false)
            assert.match(r2.error, /INCOMPLETE_RESPONSE: finish_reason=length; rejected by validate/)
            const rc = await ai.callJson('摘要', check, { spec: { use: 'rest:cf' } })
            assert.equal(rc.ok, false)
            assert.match(rc.error, /finish_reason=content_filter/)
            const re = await ai.callJson('摘要', check, { spec: { use: 'rest:empty' } })
            assert.equal(re.ok, false)
            assert.match(re.error, /no visible output.*reasoning_tokens=600/)
            const ro = await ai.callJson('摘要', check, { spec: { use: 'rest:ok' } })
            assert.equal(ro.ok, true)
            assert.equal('truncated' in ro, false, '成功形狀只在截斷放行時增欄位')
            assert.equal(ai.health.snapshot().counts['rest:ok'].truncated, 0)
        })

        it('逐次覆寫:建構關而 callOpt.acceptTruncated:true 即放行;建構開而 callOpt.acceptTruncated:false 即截斷一律換家;非布林值視為未給(沿用建構值)', async () => {
            const off = mk()
            const r1 = await off.callJson('摘要', check, { spec: { use: 'rest:s1' } })
            assert.equal(r1.ok, false)
            assert.match(r1.errors[0], /^rest:s1#0:incomplete\(\d+\.\ds\)$/)
            const r2 = await off.callJson('摘要', check, { spec: { use: 'rest:s1' }, acceptTruncated: true })
            assert.deepEqual([r2.ok, r2.truncated, r2.data.length], [true, true, 2])
            for (const v of ['yes', 1, null]) assert.equal((await off.callJson('摘要', check, { spec: { use: 'rest:s1' }, acceptTruncated: v })).ok, false, `建構關、逐次 ${JSON.stringify(v)}:沿用關`)
            const on = mk({ acceptTruncated: true })
            const r3 = await on.callJson('摘要', check, { spec: { use: 'rest:s1', fallback: ['rest:ok'] }, acceptTruncated: false })
            assert.deepEqual([r3.ok, r3.providerId, r3.attempts, 'truncated' in r3], [true, 'rest:ok', 2, false])
            for (const v of ['no', 0, null]) assert.equal((await on.callJson('摘要', check, { spec: { use: 'rest:s1' }, acceptTruncated: v })).truncated, true, `建構開、逐次 ${JSON.stringify(v)}:沿用開`)
        })

        it('拿不到終止訊號之截斷(finish_reason=stop 而本文被切,CLI 型):開啟時經搶救而成功、無 truncated(上游無截斷訊號);關閉時判非 JSON', async () => {
            const r = await mk({ acceptTruncated: true }).callJson('摘要', check, { spec: { use: 'rest:cut' } })
            assert.deepEqual([r.ok, r.data.map((x) => x.index), 'truncated' in r], [true, [1, 2], false])
            const off = await mk().callJson('摘要', check, { spec: { use: 'rest:cut' } })
            assert.equal(off.ok, false)
            assert.match(off.errors[0], /^rest:cut#0:validation\(\d+\.\ds\)：非 JSON（或輸出截斷）$/)
        })

        it('不合格原因之歸屬:截斷內容被本層驗證拒收者(incomplete＋rejected by validate)附原因;未經本層驗證之截斷失敗(content_filter)不取原因;後續家之原因不錯位', async () => {
            const ai = mk({ acceptTruncated: true })
            const r = await ai.callJson('摘要', check, { spec: { use: 'rest:s2', fallback: ['rest:cf', 'rest:plain', 'rest:dobj'] } })
            assert.equal(r.ok, false)
            assert.equal(r.errors.length, 4)
            assert.match(r.errors[0], /^rest:s2#0:incomplete\(\d+\.\ds\)：非 JSON（或輸出截斷）$/)
            assert.match(r.errors[1], /^rest:cf#0:incomplete\(\d+\.\ds\)$/, 'content_filter 未交本層驗證:不取原因')
            assert.match(r.errors[2], /^rest:plain#0:validation\(\d+\.\ds\)：非 JSON（或輸出截斷）$/)
            assert.match(r.errors[3], /^rest:dobj#0:validation\(\d+\.\ds\)：須為非空陣列$/, 'check 之原因歸本家,不錯位')
            // 救回之前段不合 check:附 check 自述之原因
            const r2 = await ai.callJson('摘要', (d) => (d.length >= 3 ? true : `只救回 ${d.length} 項`), { spec: { use: 'rest:s1' } })
            assert.equal(r2.ok, false)
            assert.match(r2.errors[0], /^rest:s1#0:incomplete\(\d+\.\ds\)：只救回 2 項$/)
        })

        it('全有全無之輸出:acceptTruncated:false 時 S1／S0／外包物件之 REST 截斷皆整組跳過(incomplete)由遞補成交;無遞補則失敗', async () => {
            for (const use of ['rest:s1', 'rest:s0', 'rest:dtrunc']) {
                const ai = mk({ acceptTruncated: true })
                const r = await ai.callJson('提煉', strict, { spec: { use, fallback: ['rest:dobj'] }, acceptTruncated: false })
                assert.equal(r.ok, true, use)
                assert.equal(r.providerId, 'rest:dobj', `${use} 截斷即換家`)
                assert.equal(r.truncated, undefined)
                assert.deepEqual(r.data.ops.map((o) => o.op), ['add', 'confirm'])
                assert.equal(r.attempts, 2)
                assert.deepEqual(r.errors, [], '成功時 errors 為空陣列')
            }
            const r2 = await mk({ acceptTruncated: true }).callJson('提煉', strict, { spec: { use: 'rest:dtrunc' }, acceptTruncated: false })
            assert.equal(r2.ok, false)
            assert.match(r2.errors.join(','), /rest:dtrunc#0:incomplete/)
        })

        it('對照:開啟時外包物件之截斷被搶救成內層陣列——寬鬆 check 會把半份當成功(全有全無之輸出須以結構 check 或逐次關閉)', async () => {
            const ai = mk({ acceptTruncated: true })
            const lenient = (d) => (!!d && typeof d === 'object' ? true : '須為物件或陣列')
            const r = await ai.callJson('提煉', lenient, { spec: { use: 'rest:dtrunc' } })
            assert.equal(r.ok, true)
            assert.equal(r.truncated, true)
            assert.ok(Array.isArray(r.data), '外包物件被搶救成內層陣列(形狀改變)')
            assert.deepEqual(r.data.map((o) => o.op), ['add', 'confirm'], '末尾之 essence 靜默遺失')
            const r2 = await ai.callJson('提煉', strict, { spec: { use: 'rest:dtrunc', fallback: ['rest:dobj'] } })
            assert.equal(r2.providerId, 'rest:dobj', '結構 check 只收外包物件 → 即使放行截斷亦換家')
        })

        it('拿不到終止訊號之截斷與頂層陣列:外包物件之 check 判失敗換家;無遞補則 OUTPUT_VALIDATION_FAILED', async () => {
            for (const use of ['rest:dcut', 'rest:darr']) {
                const r = await mk({ acceptTruncated: true }).callJson('提煉', strict, { spec: { use, fallback: ['rest:dobj'] }, acceptTruncated: false })
                assert.equal(r.providerId, 'rest:dobj', use)
                assert.equal(r.attempts, 2)
            }
            const r = await mk({ acceptTruncated: true }).callJson('提煉', strict, { spec: { use: 'rest:dcut' }, acceptTruncated: false })
            assert.equal(r.ok, false)
            assert.equal(r.error, 'OUTPUT_VALIDATION_FAILED')
        })
    })

    describe('避開(規則③)', function() {

        it('避開所列條目:其餘條目依原序遞補;被避開者未送出', async () => {
            const ai = mk()
            const { r, tries } = await tryOrder(ai, { use: 'rest:ok', fallback: ['rest:plain', 'rest:ok2'] }, { avoid: ['rest:ok'] })
            assert.deepEqual([r.ok, r.providerId, r.attempts], [true, 'rest:ok2', 2])
            assert.deepEqual(tries, ['rest:plain', 'rest:ok2'])
            const two = await tryOrder(ai, { use: 'rest:plain', fallback: ['rest:ok', 'rest:ok2'] }, { avoid: ['rest:plain', 'rest:ok'] })
            assert.deepEqual([two.r.providerId, two.tries], ['rest:ok2', ['rest:ok2']])
        })

        it('避開後無條目則不避(全鏈照試,不以避開讓呼叫失敗);未知 id、空陣列不影響;非陣列(字串、物件)視為未給', async () => {
            const ai = mk()
            const spec = { use: 'rest:ok', fallback: ['rest:ok2'] }
            for (const avoid of [['rest:ok', 'rest:ok2'], ['nope:x'], [], 'rest:ok', { 'rest:ok': true }]) {
                const { r, tries } = await tryOrder(ai, spec, { avoid })
                assert.deepEqual([r.ok, r.providerId, tries], [true, 'rest:ok', ['rest:ok']], `avoid=${JSON.stringify(avoid)}`)
            }
        })

        it('避開與截斷放行並用:避開首選後之遞補鏈照常交截斷搶救', async () => {
            const ai = mk({ acceptTruncated: true })
            const { r, tries } = await tryOrder(ai, { use: 'rest:ok', fallback: ['rest:s1'] }, { avoid: ['rest:ok'] })
            assert.deepEqual([r.ok, r.providerId, r.truncated, r.data.length, tries], [true, 'rest:s1', true, 2, ['rest:s1']])
        })
    })

    describe('失敗預覽(規則④)', function() {

        it('開啟時:派送後失敗附最後一次失敗嘗試之 stdout 前 120 字;未送出即失敗(提示詞不合、席位無法解析、預算不足)為空字串;成功不附', async () => {
            const ai = mk({ preview: true })
            const r = await ai.callJson('q', check, { spec: { use: 'rest:plain' } })
            assert.equal(r.preview, SCENES.plain.content)
            const long = await ai.callJson('q', check, { spec: { use: 'rest:long' } })
            assert.deepEqual([long.preview, long.preview.length], [SCENES.long.content.slice(0, 120), 120])
            const chain = await ai.callJson('q', check, { spec: { use: 'rest:long', fallback: ['rest:dobj'] } })
            assert.equal(chain.preview, SCENES.dobj.content.slice(0, 120), '遞補鏈:預覽為最後一次失敗嘗試者')
            const tr = await mk({ preview: true, acceptTruncated: true }).callJson('q', check, { spec: { use: 'rest:s2' } })
            assert.equal(tr.preview, SCENES.s2.content, '截斷內容被拒收:預覽為被拒之回覆')
            const early = await ai.callJson('', check, { spec: { use: 'rest:ok' } })
            const noSeat = await ai.callJson('q', check, { spec: { use: 'nope:x' } })
            const budget = await ai.callJson('q', check, { spec: { use: 'rest:ok' }, budgetMs: 1 })
            for (const [name, x] of Object.entries({ early, noSeat, budget })) assert.equal(x.preview, '', name)
            assert.equal(budget.skipped, true)
            const ok = await ai.callJson('q', check, { spec: { use: 'rest:ok' } })
            assert.equal(ok.ok, true)
            assert.equal('preview' in ok, false)
        })
    })

    describe('免費池當日額度(規則⑤)', function() {

        // 字樣取自本機 opencode 日誌之實際行之格式(當日額度、Console 前綴、重試耗盡、瞬間限流、一般行)
        const MUSE = 'opencode/muse-spark-1.3-contributor-free'
        const MIMO = 'opencode/mimo-v2.6-flash-free'
        const lineQuota = (iso, model = 'muse-spark-1.3-contributor-free') => `timestamp=${iso} level=ERROR run=8c7db97f message="stream error" providerID=opencode modelID=${model} session.id=ses_x small=false agent=build mode=primary error.error="AI_APICallError: Rate limit exceeded. Please try again later."`
        const lineConsole = (iso) => `timestamp=${iso} level=ERROR run=145b9d5b message="stream error" providerID=opencode modelID=muse-spark-1.3-contributor-free session.id=ses_y small=false agent=build mode=primary error.error="AI_APICallError: Error from provider (Console): Rate limit exceeded. Please try again later."`
        const lineRetry = (iso) => `timestamp=${iso} level=ERROR run=145b9d5b message="stream error" providerID=opencode modelID=mimo-v2.6-flash-free session.id=ses_z small=true agent=title mode=primary error.error="AI_RetryError: Failed after 3 attempts. Last error: Rate limit exceeded. Please try again later."`
        const lineBrief = (iso) => `timestamp=${iso} level=ERROR run=28d28bab message="stream error" providerID=opencode modelID=muse-spark-1.3-contributor-free session.id=ses_w small=false agent=build mode=primary error.error="AI_APICallError: Error from provider (Console): Rate limit exceeded. Please retry after a brief wait."`
        const lineInfo = (iso) => `timestamp=${iso} level=INFO run=517fe2cf message=stream providerID=opencode modelID=mimo-v2.6-flash-free session.id=ses_v small=false agent=build mode=primary`
        // 免費額度之總量上限(2026-10-30 16:24 起本機實見;全部免費模型同時出現、跨每日重置仍在):同樣不失敗返回而等到逾時,須收
        const lineTotal = (iso, model = 'big-pickle') => `timestamp=${iso} level=ERROR run=f00fc7e8 message="stream error" providerID=opencode modelID=${model} session.id=ses_t small=false agent=build mode=primary error.error="AI_APICallError: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"`

        it('字樣:當日額度三種寫法與免費總量上限(Free usage limit reached)皆收;瞬間限流(brief wait)與一般行不收;缺時間或模型欄位之行略過', () => {
            const got = parseQuotaLines([
                lineQuota('2026-10-02T22:22:09.412Z'),
                lineConsole('2026-09-30T23:32:05.612Z'),
                lineRetry('2026-09-30T23:32:11.483Z'),
                lineBrief('2026-10-01T09:07:58.000Z'),
                lineInfo('2026-10-02T16:23:15.797Z'),
                lineTotal('2026-10-30T08:24:50.958Z'),
            ].join('\n'))
            assert.deepEqual(got, [
                { ts: Date.parse('2026-10-02T22:22:09.412Z'), key: MUSE },
                { ts: Date.parse('2026-09-30T23:32:05.612Z'), key: MUSE },
                { ts: Date.parse('2026-09-30T23:32:11.483Z'), key: MIMO },
                { ts: Date.parse('2026-10-30T08:24:50.958Z'), key: 'opencode/big-pickle' },
            ])
            assert.ok(QUOTA_PATTERNS.some((re) => re.test('You’ve reached the API rate limit for free users. Upgrade to a Token Plan')), '免費用戶額度字樣')
            assert.deepEqual(parseQuotaLines('error.error="AI_APICallError: Rate limit exceeded. Please try again later."'), [], '缺時間或模型欄位之行略過')
            assert.deepEqual(parseQuotaLines(null), [])
        })

        it('週期起點:UTC resetUtcHour 時整(UTC 0 時即 UTC+8 之 08:00);非 0～23 之整數視為 0;預設日誌位置在家目錄之 .local/share/opencode/log', () => {
            assert.equal(resetStartMs(Date.parse('2026-10-02T22:22:09Z')), Date.parse('2026-10-02T00:00:00Z'), 'UTC+8 之 10-03 06:22 屬 10-02 UTC 0 時起之週期')
            assert.equal(resetStartMs(Date.parse('2026-10-03T00:00:00Z')), Date.parse('2026-10-03T00:00:00Z'), '恰在重置時刻者屬新週期')
            assert.equal(resetStartMs(Date.parse('2026-10-03T03:00:00Z'), 5), Date.parse('2026-10-02T05:00:00Z'), '重置時刻未到則取前一日')
            assert.equal(resetStartMs(Date.parse('2026-10-03T03:00:00Z'), 99), Date.parse('2026-10-03T00:00:00Z'), '非 0～23 之整數視為 0')
            assert.match(defaultOpencodeLog(), /[\\/]\.local[\\/]share[\\/]opencode[\\/]log[\\/]opencode\.log$/)
        })

        it('判定:本週期有額度字樣即用盡;成交蓋過;成交後再現字樣又用盡;前一週期之字樣不算;跨重置時刻即歸零', () => {
            const f = `${TMP}/pool-a.log`
            fs.writeFileSync(f, [lineInfo('2026-10-02T16:23:15.797Z'), lineQuota('2026-10-02T22:22:09.412Z'), lineQuota('2026-10-01T23:50:00.000Z', 'mimo-v2.6-flash-free')].join('\n') + '\n')
            const q = createPoolQuota({ file: f, refreshMs: 0 })
            const now = Date.parse('2026-10-02T23:00:00Z')
            assert.equal(q.isExhausted(MUSE, now), true)
            assert.equal(q.isExhausted(MIMO, now), false, 'mimo 之字樣在前一週期(10-01 23:50Z),本週期不算')
            assert.deepEqual(q.info(MUSE), { first: Date.parse('2026-10-02T22:22:09.412Z'), last: Date.parse('2026-10-02T22:22:09.412Z'), n: 1 })
            q.noteOk(MUSE, Date.parse('2026-10-02T22:40:00Z'))
            assert.equal(q.isExhausted(MUSE, now), false, '字樣之後本行程見其成交 → 視為恢復')
            fs.appendFileSync(f, lineConsole('2026-10-02T22:50:00.000Z') + '\n')
            assert.equal(q.isExhausted(MUSE, now), true, '成交之後又出現字樣 → 再度用盡')
            assert.equal(q.isExhausted(MUSE, Date.parse('2026-10-03T00:00:01Z')), false, '跨過 UTC 0 時重置')
        })

        it('增量讀取:只解析完整之行;半行留待下次;檔案變小即從頭重讀;檔案不存在視為無資料', () => {
            const f = `${TMP}/pool-b.log`
            const now = Date.parse('2026-10-02T23:00:00Z')
            const q = createPoolQuota({ file: f, refreshMs: 0 })
            assert.equal(q.isExhausted(MUSE, now), false, '檔案不存在')
            const full = lineQuota('2026-10-02T22:22:09.412Z')
            fs.writeFileSync(f, lineInfo('2026-10-02T22:00:00.000Z') + '\n' + full.slice(0, 60))
            assert.equal(q.isExhausted(MUSE, now), false, '半行不解析')
            fs.appendFileSync(f, full.slice(60) + '\n')
            assert.equal(q.isExhausted(MUSE, now), true, '補齊後解析')
            fs.writeFileSync(f, lineInfo('2026-10-02T22:30:00.000Z') + '\n')
            const q2 = createPoolQuota({ file: f, refreshMs: 0 })
            assert.equal(q2.isExhausted(MUSE, now), false)
            fs.writeFileSync(f, lineQuota('2026-10-02T22:31:00.000Z', 'mimo-v2.6-flash-free') + '\n') // 變小(輪替)
            assert.equal(q2.isExhausted(MIMO, now), true, '檔案變小即從頭重讀')
        })

        it('檔尾上限:只讀最後 maxBytes;跳讀處之第一個不完整行捨去', () => {
            const f = `${TMP}/pool-c.log`
            const old = lineQuota('2026-10-02T21:00:00.000Z', 'mimo-v2.6-flash-free')
            const filler = Array.from({ length: 40 }, (_, i) => lineInfo(`2026-10-02T21:${String(10 + i).padStart(2, '0')}:00.000Z`)).join('\n')
            const tail = lineQuota('2026-10-02T22:22:09.412Z')
            fs.writeFileSync(f, `${old}\n${filler}\n${tail}\n`)
            const q = createPoolQuota({ file: f, refreshMs: 0, maxBytes: Buffer.byteLength(tail) + 200 })
            const now = Date.parse('2026-10-02T23:00:00Z')
            assert.equal(q.isExhausted(MUSE, now), true, '檔尾之完整行照收')
            assert.equal(q.isExhausted(MIMO, now), false, '超出 maxBytes 之舊行不讀')
        })

        it('節流:refreshMs 內不重讀(新增之行要等下一次讀檔才見)', () => {
            const f = `${TMP}/pool-d.log`
            fs.writeFileSync(f, lineInfo('2026-10-02T22:00:00.000Z') + '\n')
            const q = createPoolQuota({ file: f, refreshMs: 60_000 })
            const t0 = Date.parse('2026-10-02T23:00:00Z')
            assert.equal(q.isExhausted(MUSE, t0), false)
            fs.appendFileSync(f, lineQuota('2026-10-02T22:59:00.000Z') + '\n')
            assert.equal(q.isExhausted(MUSE, t0 + 30_000), false, '30 秒內不重讀')
            assert.equal(q.isExhausted(MUSE, t0 + 61_000), true, '逾 refreshMs 即讀入')
        })

        // ── 調度層接線(真實派送路徑):opencode 條目之 exe 指向 node,工作目錄下之 run 腳本讀完 stdin 後回 JSON 陣列(不呼叫真 CLI)──
        const OC_MUSE = `oc:${MUSE}`
        const OC_MIMO = `oc:${MIMO}`
        const FAKE_CLI = "let s = ''\nprocess.stdin.on('data', (c) => { s += c })\nprocess.stdin.on('end', () => process.stdout.write('[{\"index\":1,\"v\":\"cli\"}]'))\n"
        const ocEntry = (model) => ({ id: `oc:${model}`, kind: 'opencode', model, exe: process.execPath })
        // 本週期內之時刻(當下前 60 秒,但不早於本週期起點)
        const nowIn = () => new Date(Math.max(resetStartMs(Date.now()), Date.now() - 60_000)).toISOString()

        /**
         * 帶假 opencode 條目(muse、mimo)之 adapter;日誌為暫存檔
         *
         * @param {Object} [pools] 輸入 ai.pools(undefined 即不給)
         * @param {Object} [o={}] 輸入 createAiAdapter 之其他選項
         * @param {Object} [aiExtra={}] 輸入覆寫 settings.ai 之其他鍵
         * @returns {Object} 回傳 adapter
         */
        const mkPool = (pools, o = {}, aiExtra = {}) => {
            const ws = `${TMP}/ws-pool-${++seq}`
            fs.mkdirSync(ws, { recursive: true })
            fs.writeFileSync(`${ws}/run`, FAKE_CLI, 'utf8')
            return mk({ workspace: ws, catalogue: [ocEntry(MUSE), ocEntry(MIMO), ...CAT], ...o }, { ...(pools === undefined ? {} : { pools }), ...aiExtra })
        }

        it('給定且日誌本週期有該模型之額度字樣 → 該 opencode 條目降至鏈尾:遞補鏈先打他家;onPool 每條目每行程一次;未用盡之 opencode 條目與非 opencode 條目不動', async () => {
            const log = `${TMP}/oc-1.log`
            fs.writeFileSync(log, lineQuota(nowIn()) + '\n')
            const seen = []
            const ai = mkPool({ oc: { log, resetUtcHour: 0 } }, { onPool: (ev) => seen.push(ev) })
            const a = await tryOrder(ai, { use: OC_MUSE, fallback: ['rest:ok'] })
            assert.deepEqual([a.r.ok, a.r.providerId, a.tries], [true, 'rest:ok', ['rest:ok']], '用盡之條目降至鏈尾,前家成交即不再碰')
            assert.equal(seen.length, 1)
            assert.deepEqual([seen[0].providerId, seen[0].model, seen[0].n, seen[0].resetUtcHour], [OC_MUSE, MUSE, 1, 0])
            assert.ok(Number.isFinite(seen[0].first) && seen[0].first === seen[0].last, 'onPool 附本週期之字樣統計')
            const b = await tryOrder(ai, { use: OC_MUSE, fallback: ['rest:ok'] })
            assert.deepEqual(b.tries, ['rest:ok'])
            assert.equal(seen.length, 1, '每條目每行程只回呼一次')
            const c = await tryOrder(ai, { use: OC_MIMO, fallback: ['rest:ok'] })
            assert.deepEqual([c.r.providerId, c.tries], [OC_MIMO, [OC_MIMO]], '未用盡之 opencode 條目照鏈序先打')
            const d = await tryOrder(ai, { use: 'rest:plain', fallback: ['rest:ok'] })
            assert.deepEqual(d.tries, ['rest:plain', 'rest:ok'], '非 opencode 條目不受額度影響')
        })

        it('只降序不移除:鏈上僅剩用盡之條目時照樣嘗試;本行程見其成交即恢復(其後照鏈序先打)', async () => {
            const log = `${TMP}/oc-2.log`
            fs.writeFileSync(log, lineQuota(nowIn()) + '\n')
            const ai = mkPool({ oc: { log } })
            const only = await tryOrder(ai, { use: OC_MUSE })
            assert.deepEqual([only.r.ok, only.r.providerId, only.tries], [true, OC_MUSE, [OC_MUSE]], only.r.error)
            const after = await tryOrder(ai, { use: OC_MUSE, fallback: ['rest:ok'] })
            assert.deepEqual(after.tries, [OC_MUSE], '成交後恢復:照鏈序先打')
        })

        it('日誌不存在、字樣屬前一週期、字樣為瞬間限流(brief wait) → 不降序、onPool 不作用;同一日誌而未給 ai.pools 亦不降序(對照)', async () => {
            const prev = new Date(resetStartMs(Date.now()) - 3600e3).toISOString()
            for (const [name, content, pools] of [['不存在', null, true], ['前一週期', lineQuota(prev), true], ['瞬間限流', lineBrief(nowIn()), true], ['未給 ai.pools', lineQuota(nowIn()), false]]) {
                const log = `${TMP}/oc-x-${++seq}.log`
                if (content !== null) fs.writeFileSync(log, content + '\n')
                const seen = []
                const ai = mkPool(pools ? { oc: { log } } : undefined, { onPool: (ev) => seen.push(ev) })
                const t = await tryOrder(ai, { use: OC_MUSE, fallback: ['rest:ok'] })
                assert.deepEqual([t.r.providerId, t.tries], [OC_MUSE, [OC_MUSE]], name)
                assert.deepEqual(seen, [], name)
            }
        })

        it('ai.cooldownMs 為 0(不冷卻)時無降序效果(上游不依冷卻重排;檔頭所載之限制)', async () => {
            const log = `${TMP}/oc-3.log`
            fs.writeFileSync(log, lineQuota(nowIn()) + '\n')
            const t = await tryOrder(mkPool({ oc: { log } }, {}, { cooldownMs: 0 }), { use: OC_MUSE, fallback: ['rest:ok'] })
            assert.deepEqual(t.tries, [OC_MUSE])
        })
    })

    describe('供應商健康降序(規則⑥)', function() {

        /** 記憶體之狀態 store(與 w-dispatch-ai createFileStore 同契約 {get,set};get 回副本,以驗健康層之重新斷言;非集合之 memStore) */
        const stateStore = (init = {}) => {
            let st = { ...init }
            return {
                get: () => JSON.parse(JSON.stringify(st)),
                set: (s) => {
                    st = JSON.parse(JSON.stringify(s))
                },
                _raw: () => st,
            }
        }
        // 事件形狀同 w-dispatch-ai ≥1.0.39 之 dispatchAiFallback:逐次失敗(next-key／skip-group)之後,該組試完仍無成交時另發 group-exhausted
        const fail = (providerId, errorType, extra = {}) => ({ type: 'skip-group', providerId, keyIndex: null, keyId: providerId, error: `${errorType} err`, errorType, ...extra })
        const exhausted = (providerId, errorTypes, extra = {}) => ({ type: 'group-exhausted', providerId, keyIndex: null, keyId: providerId, keys: 0, attempted: errorTypes.length, by: 'skip-group', errorTypes, error: `${errorTypes[errorTypes.length - 1]} err`, ...extra })
        /** 無金鑰條目之一次呼叫以與金鑰無關之失敗收尾:上游依序發 skip-group 與 group-exhausted */
        const failCall = (target, providerId, errorType, extra = {}) => {
            target.onEvent(fail(providerId, errorType, extra))
            target.onEvent(exhausted(providerId, [errorType], extra.error ? { error: extra.error } : {}))
        }
        const nk = (providerId, keyIndex, errorType = 'http', extra = {}) => ({ type: 'next-key', providerId, keyIndex, keyId: `${providerId}#${keyIndex}`, errorType, error: `${errorType} err`, ...extra })
        const okEv = (providerId, keyIndex = 0) => ({ type: 'ok', providerId, keyIndex, keyId: `${providerId}#${keyIndex}`, durationMs: 1 })

        it('連續 3 次呼叫失敗(每次一個組盡事件)→ 寫入冷卻表(降序);成功即歸零;未達門檻不冷卻;冷卻中再失敗重新斷言而不重複回呼', () => {
            const store = stateStore({ cursors: {}, cooling: {} })
            const cooled = []
            const t = 1_000_000
            const h = createProviderHealth({ store, threshold: 3, windowMs: 900_000, now: () => t, onCool: (ev) => cooled.push(ev) })
            failCall(h, 'g', 'validation')
            failCall(h, 'g', 'validation')
            assert.equal(store._raw().cooling.g, undefined, '兩次未達門檻不冷卻——單次驗證失敗是常態')
            h.onEvent(okEv('g'))
            failCall(h, 'g', 'validation')
            failCall(h, 'g', 'validation')
            assert.equal(store._raw().cooling.g, undefined, '成功歸零後重新計數')
            failCall(h, 'g', 'exec')
            assert.equal(store._raw().cooling.g, t, '第 3 次(混合 validation／exec)即寫入 cooling')
            assert.equal(cooled.length, 1)
            assert.deepEqual([cooled[0].providerId, cooled[0].streak, cooled[0].errorType], ['g', 3, 'exec'])
            store.set({ cursors: {}, cooling: {} }) // 模擬被上游整份寫回蓋掉
            failCall(h, 'g', 'validation')
            assert.equal(store._raw().cooling.g, t, '被蓋掉後於下一次失敗重新斷言')
            assert.equal(cooled.length, 1, '同一段 streak 只回呼一次')
            const s = h.snapshot()
            assert.equal(s.counts.g.cooled, 1)
            assert.equal(s.counts.g.fail.validation, 5, '失敗型別次數由逐次失敗事件計(組盡事件不重複記)')
            assert.equal(s.counts.g.ok, 1)
        })

        it('params(席位與能力不相容,如 prompt 超過 CLI 長度上限)不計 streak,另計 mismatch 並進摘要', () => {
            const store = stateStore({ cooling: {} })
            const h = createProviderHealth({ store, threshold: 2 })
            for (let i = 0; i < 6; i++) failCall(h, 'agy', 'params', { error: 'prompt too long (41000 chars > 30000)' })
            assert.equal(store._raw().cooling.agy, undefined, 'params 不冷卻:冷卻改善不了設定不相容')
            assert.equal(h.snapshot().counts.agy.mismatch, 6)
            assert.equal(h.snapshot().streak.agy, undefined)
            assert.match(h.summary(), /席位不相容 agy\(params\)×6/)
            assert.doesNotMatch(h.summary(), /健康降序/)
        })

        it('逐次失敗(next-key／skip-group)只記失敗次數、不動 streak;連續失敗以組盡事件計,無金鑰／單把／多把同一規則', () => {
            const store = stateStore({ cooling: {} })
            const h = createProviderHealth({ store, threshold: 2 })
            for (let i = 0; i < 4; i++) h.onEvent({ type: 'next-key', providerId: 'agnes', keyIndex: i % 2, keyId: `agnes#${i % 2}`, errorType: 'http', error: 'quota' })
            for (let i = 0; i < 3; i++) h.onEvent(fail('agnes', 'validation'))
            assert.equal(h.snapshot().streak.agnes, undefined, '沒有組盡事件就不計:一把失敗而他把成交之呼叫,上游不發組盡事件')
            assert.deepEqual(h.snapshot().counts.agnes.fail, { http: 4, validation: 3 })
            assert.equal(store._raw().cooling.agnes, undefined)
            for (const keys of [0, 1, 3]) {
                const pid = `k${keys}`
                for (let i = 0; i < 2; i++) h.onEvent(exhausted(pid, Array(Math.max(1, keys)).fill('exec'), { keys, by: 'all-keys' }))
                assert.ok(Number.isFinite(store._raw().cooling[pid]), `keys ${keys}:每收到一次組盡事件計一次`)
            }
        })

        it('排除清單:incomplete、tool-unsupported、invalid-response 與未知新型別皆計入;無金鑰 REST 之 fetch 計入;params 只記 mismatch;混合者以最後一個計入型別計;缺 errorTypes 者計為 exec', () => {
            const store = stateStore({ cooling: {} })
            const h = createProviderHealth({ store, threshold: 2 })
            for (const t of ['incomplete', 'tool-unsupported', 'invalid-response', 'future-x']) {
                failCall(h, `p-${t}`, t)
                failCall(h, `p-${t}`, t)
                assert.ok(Number.isFinite(store._raw().cooling[`p-${t}`]), `${t} 連續 2 次須冷卻`)
            }
            for (let i = 0; i < 2; i++) {
                h.onEvent({ type: 'next-key', providerId: 'rest-nokey', keyIndex: null, keyId: 'rest-nokey', errorType: 'fetch', error: 'FETCH_ERROR' })
                h.onEvent(exhausted('rest-nokey', ['fetch'], { by: 'all-keys' }))
            }
            assert.ok(Number.isFinite(store._raw().cooling['rest-nokey']), '無金鑰 REST 之網路層失敗計入')
            for (let i = 0; i < 4; i++) failCall(h, 'agy', 'params')
            assert.equal(store._raw().cooling.agy, undefined, 'params 不冷卻')
            assert.equal(h.snapshot().counts.agy.mismatch, 4)
            h.onEvent(exhausted('mix', ['http', 'params'], { keys: 2, by: 'all-keys' }))
            assert.deepEqual([h.snapshot().streak.mix.n, h.snapshot().streak.mix.lastType], [1, 'http'], '混合者計入,型別取最後一個計入型別')
            h.onEvent({ type: 'group-exhausted', providerId: 'none', keyIndex: null, keyId: 'none', keys: 0, attempted: 1, by: 'all-keys', error: 'x' })
            assert.equal(h.snapshot().streak.none.lastType, 'exec', '缺 errorTypes 者仍計入(計為 exec)')
        })

        it('兩把皆敗:每次呼叫一個組盡事件計一次,達門檻冷卻;onCool 帶 keys 2', () => {
            const store = stateStore({ cooling: {} })
            const cooled = []
            const h = createProviderHealth({ store, threshold: 2, onCool: (ev) => cooled.push(ev) })
            const call = () => {
                h.onEvent(nk('p', 0))
                h.onEvent(nk('p', 1))
                h.onEvent(exhausted('p', ['http', 'http'], { keys: 2, by: 'all-keys' }))
            }
            call()
            assert.equal(h.snapshot().streak.p.n, 1, '一次呼叫計 1(兩個換鑰失敗事件不重複計)')
            assert.equal(store._raw().cooling.p, undefined)
            call()
            assert.ok(Number.isFinite(store._raw().cooling.p), '第二次呼叫達門檻冷卻')
            assert.equal(cooled.length, 1)
            assert.deepEqual([cooled[0].keys, cooled[0].errorType, cooled[0].streak], [2, 'http', 2], '訊息可註明「每次 2 把金鑰皆敗」')
        })

        it('一死一活並行(游標只在成功時推進,並行呼叫皆從死金鑰起跑):6 次換鑰失敗後 6 次成功,無組盡事件,不得冷卻', () => {
            const store = stateStore({ cooling: {} })
            const h = createProviderHealth({ store, threshold: 2 })
            for (let i = 0; i < 6; i++) h.onEvent(nk('p', 0))
            for (let i = 0; i < 6; i++) h.onEvent(okEv('p', 1))
            assert.equal(store._raw().cooling.p, undefined, '以失敗事件數計會把同一把死金鑰誤算成整組皆敗')
            assert.deepEqual([h.snapshot().counts.p.cooled, h.snapshot().counts.p.fail.http], [0, 6])
        })

        it('組內預算用盡(後段金鑰從未被試):上游不發組盡事件,不得計入', () => {
            const store = stateStore({ cooling: {} })
            const h = createProviderHealth({ store, threshold: 2 })
            for (let i = 0; i < 6; i++) {
                h.onEvent(nk('p', 0))
                h.onEvent({ type: 'budget-out', providerId: 'p', keyIndex: 1, keyId: 'p#1', remainingMs: 1 })
            }
            assert.equal(store._raw().cooling.p, undefined)
            assert.equal(h.snapshot().streak.p, undefined)
        })

        it('不重複計:換鑰失敗後以整組跳過收尾之呼叫只計一次(整組跳過事件本身不計)', () => {
            const store = stateStore({ cooling: {} })
            const h = createProviderHealth({ store, threshold: 10 })
            for (let i = 0; i < 3; i++) {
                h.onEvent(nk('p', 0, 'http'))
                h.onEvent({ type: 'skip-group', providerId: 'p', keyIndex: 1, keyId: 'p#1', errorType: 'timeout', error: 'TIMEOUT' })
                h.onEvent(exhausted('p', ['http', 'timeout'], { keys: 2, by: 'skip-group' }))
            }
            assert.equal(h.snapshot().streak.p.n, 3, '3 個呼叫各計一次')
            assert.deepEqual(h.snapshot().counts.p.fail, { http: 3, timeout: 3 })
        })

        it('單把金鑰、首把即整組跳過亦每次計一次;onCool 之 keys 只在多金鑰且每把皆試過時附上;成功歸零後重新起算', () => {
            const store = stateStore({ cooling: {} })
            const cooled = []
            const h = createProviderHealth({ store, threshold: 2, onCool: (ev) => cooled.push(ev) })
            for (let i = 0; i < 2; i++) h.onEvent(exhausted('one', ['http'], { keys: 1, by: 'all-keys' }))
            for (let i = 0; i < 2; i++) h.onEvent(exhausted('first', ['timeout'], { keys: 2, attempted: 1, by: 'skip-group' }))
            assert.ok(Number.isFinite(store._raw().cooling.one), '只有 1 把者每次呼叫皆敗即計')
            assert.ok(Number.isFinite(store._raw().cooling.first), '首把即整組跳過(與金鑰無關)亦計')
            assert.deepEqual(cooled.map((e) => [e.providerId, 'keys' in e]), [['one', false], ['first', false]], '後段金鑰未試者不可寫成「每次 N 把金鑰皆敗」')
            const h2 = createProviderHealth({ store: stateStore({ cooling: {} }), threshold: 3 })
            h2.onEvent(exhausted('p', ['http', 'http'], { keys: 2, by: 'all-keys' }))
            h2.onEvent(okEv('p', 1))
            h2.onEvent(exhausted('p', ['http', 'http'], { keys: 2, by: 'all-keys' }))
            assert.equal(h2.snapshot().streak.p.n, 1, '成功歸零後重新起算')
        })

        it('上游已冷卻(窗內)時達門檻:只對齊時刻,不新冷卻、不回呼;全為 params 之組只記 mismatch', () => {
            const t = 5_000
            const store = stateStore({ cooling: { p: 4_000 } })
            const cooled = []
            const h = createProviderHealth({ store, threshold: 2, windowMs: 900_000, now: () => t, onCool: (ev) => cooled.push(ev) })
            for (let i = 0; i < 2; i++) {
                h.onEvent(nk('p', 0, 'http'))
                h.onEvent(nk('p', 1, 'http'))
                h.onEvent(exhausted('p', ['http', 'http'], { keys: 2, by: 'all-keys' }))
            }
            assert.equal(store._raw().cooling.p, 4_000, '冷卻時戳不變')
            assert.deepEqual([h.snapshot().counts.p.cooled, cooled.length], [0, 0])
            for (let i = 0; i < 2; i++) {
                h.onEvent(nk('q', 0, 'params'))
                h.onEvent(nk('q', 1, 'params'))
                h.onEvent(exhausted('q', ['params', 'params'], { keys: 2, by: 'all-keys' }))
            }
            assert.equal(h.snapshot().counts.q.mismatch, 4)
            assert.equal(h.snapshot().streak.q, undefined)
        })

        it('截斷放行與 prompt 逾長另計:noteTruncated／noteOversize 進 counts 與摘要(非失敗、不動 streak)', () => {
            const h = createProviderHealth({})
            h.noteTruncated('p')
            h.noteTruncated('p')
            h.noteOversize('q')
            assert.equal(h.snapshot().counts.p.truncated, 2)
            assert.equal(h.snapshot().counts.q.oversize, 1)
            assert.deepEqual(h.snapshot().streak, {})
            assert.equal(h.summary(), 'prompt 逾長跳過 q×1；截斷放行 p×2')
        })

        it('冷卻中且未逾窗不重寫時間戳;逾窗後再達門檻才重寫', () => {
            const store = stateStore({ cooling: {} })
            let t = 100
            const h = createProviderHealth({ store, threshold: 1, windowMs: 1000, now: () => t })
            failCall(h, 'p', 'validation')
            assert.equal(store._raw().cooling.p, 100)
            t = 500
            failCall(h, 'p', 'validation')
            assert.equal(store._raw().cooling.p, 100, '未逾窗不重寫(否則冷卻永不結束)')
            t = 1200
            failCall(h, 'p', 'validation')
            assert.equal(store._raw().cooling.p, 1200, '逾窗後重寫')
            assert.equal(h.snapshot().counts.p.cooled, 2)
        })

        it('無 store 時只統計不冷卻;非失敗事件(try／aborted／budget-out／cooled)與逐次失敗事件皆不影響 streak;snapshot(true) 取走歸零而 streak 保留', () => {
            const h = createProviderHealth({ threshold: 1 })
            h.onEvent({ type: 'try', providerId: 'x' })
            h.onEvent({ type: 'aborted', providerId: 'x' })
            h.onEvent({ type: 'budget-out', providerId: 'x' })
            h.onEvent({ type: 'cooled', providerId: 'x' })
            h.onEvent(fail('x', 'validation'))
            assert.deepEqual(h.snapshot().streak, {})
            h.onEvent(exhausted('x', ['validation']))
            assert.equal(h.snapshot().streak.x.n, 1)
            assert.equal(h.snapshot().counts.x.cooled, 0, '無 store 不冷卻')
            assert.equal(h.summary(), '')
            assert.equal(h.snapshot(true).counts.x.fail.validation, 1)
            assert.deepEqual([h.snapshot().counts, h.snapshot().streak.x.n], [{}, 1])
        })

        it('opt 非物件 → {},仍以預設值正常建構(門檻 3、冷卻視窗 900000、事件入口可用;不拋錯);有效物件之 threshold／windowMs 生效', () => {
            for (const bad of [null, 42, 'x', true]) {
                const h = createProviderHealth(bad)
                assert.deepEqual([h.threshold, h.windowMs, typeof h.onEvent], [3, 900_000, 'function'], String(bad))
            }
            const h = createProviderHealth({ threshold: 5, windowMs: 1234 })
            assert.deepEqual([h.threshold, h.windowMs], [5, 1234])
        })

        // ── 調度層接線(真實派送路徑之事件流;本層不公開 onEvent／store,以健康層之計數與下一次呼叫之鏈序為證)──

        it('調度層:連續整組皆敗達 healthStreak → 降序(下一次呼叫先打他家)並回呼 onHealth;計帳仍於 try 計;健康摘要進 drainStats(取走歸零)', async () => {
            const seen = []
            const ai = mk({ onHealth: (ev) => seen.push(ev), clock: { date8: () => '2026-10-07' } }, { healthStreak: 2 })
            for (let i = 0; i < 2; i++) assert.equal((await ai.callJson('q', check, { spec: { use: 'rest:plain' } })).error, 'OUTPUT_VALIDATION_FAILED')
            assert.equal(seen.length, 1)
            assert.deepEqual([seen[0].providerId, seen[0].streak, seen[0].errorType, 'keys' in seen[0]], ['rest:plain', 2, 'validation', false])
            assert.equal(ai.health.snapshot().counts['rest:plain'].cooled, 1)
            const { r, tries } = await tryOrder(ai, { use: 'rest:plain', fallback: ['rest:ok'] })
            assert.deepEqual([r.providerId, tries], ['rest:ok', ['rest:ok']], '降至鏈尾:前家成交即不再碰')
            assert.equal(ai.aiUsageToday().byKey['rest:plain#0'], 2, '計帳仍於 try 事件計')
            assert.match(ai.drainStats(), /健康降序 rest:plain×1/, '輪末彙總揭露健康降序')
            assert.doesNotMatch(ai.drainStats(), /健康降序/, 'drainStats 取走歸零')
        })

        it('調度層:金鑰字串「deadA, deadB,」展開為 2 把;兩把皆死 × healthStreak(2) → 冷卻、onHealth 帶 keys:2;第一次未達門檻', async () => {
            const seen = []
            const ai = mk({ onHealth: (ev) => seen.push(ev) }, { healthStreak: 2 })
            assert.deepEqual(ai.chainFor({ use: 'rest:dead2' })[0].keys, ['deadA', 'deadB'])
            await ai.callJson('摘要', check, { spec: { use: 'rest:dead2' } })
            assert.deepEqual([ai.health.snapshot().streak['rest:dead2'].n, ai.health.snapshot().counts['rest:dead2'].cooled, seen.length], [1, 0, 0], '第一次整組皆敗:streak 1')
            await ai.callJson('摘要', check, { spec: { use: 'rest:dead2' } })
            assert.equal(ai.health.snapshot().counts['rest:dead2'].cooled, 1, '第二次達門檻')
            assert.equal(seen.length, 1)
            assert.deepEqual([seen[0].providerId, seen[0].streak, seen[0].errorType, seen[0].keys], ['rest:dead2', 2, 'http', 2])
            const { tries } = await tryOrder(ai, { use: 'rest:dead2', fallback: ['rest:ok'] })
            assert.deepEqual(tries, ['rest:ok'], '冷卻生效:下一次呼叫先打他家')
        })

        it('調度層:一死一活、6 個並行呼叫(皆自死金鑰起跑):全數成交,不得冷卻', async () => {
            const ai = mk({}, { healthStreak: 2 })
            const rs = await Promise.all(Array.from({ length: 6 }, () => ai.callJson('摘要', check, { spec: { use: 'rest:half' } })))
            assert.ok(rs.every((r) => r.ok), '6 個呼叫全數成交')
            assert.equal(hits.filter((h) => h.key === 'deadX').length, 6, '並行呼叫皆自游標 0(死金鑰)起跑')
            const c = ai.health.snapshot().counts['rest:half']
            assert.deepEqual([c.ok, c.fail.http, c.cooled], [6, 6, 0])
            assert.ok(rs.every((r) => r.attempts === 2))
            const { tries } = await tryOrder(ai, { use: 'rest:half', fallback: ['rest:ok'] })
            assert.equal(tries[0], 'rest:half', '未冷卻:照鏈序先打')
        })

        it('調度層:並行呼叫跨越一次成交(四情境):每次呼叫試完仍無成交恰計一次——控制組 2、多計情境 2、少計情境 1、預算用盡情境 0', async () => {
            const streakOf = async (run) => {
                const ai = mk({}, { healthStreak: 99 }) // 門檻調高:只觀察計數,不觸發冷卻
                await run((tag, extra = {}) => ai.callJson(`[[${tag}]] 摘要`, check, { spec: { use: 'rest:plan' }, ...extra }))
                return ai.health.snapshot().streak['rest:plan']?.n ?? 0
            }
            const ctl = await streakOf(async (call) => {
                await call('C1')
                await call('C2')
            })
            const over = await streakOf(async (call) => {
                await Promise.all([call('X'), call('Y')])
                await call('Z')
            })
            const under = await streakOf(async (call) => {
                await Promise.all([call('X3'), call('Y3')])
            })
            const overb = await streakOf(async (call) => {
                const b = { budgetMs: 20_500 }
                await Promise.all([call('X4', b), call('Y4', b)])
                await call('Z4', b)
            })
            assert.deepEqual([ctl, over, under, overb], [2, 2, 1, 0])
        })

        it('調度層:無金鑰與單把金鑰之條目每次呼叫一個組盡事件計一次,達門檻冷卻;onHealth 不附 keys', async () => {
            const seen = []
            const ai = mk({ onHealth: (ev) => seen.push(ev) }, { healthStreak: 2 })
            assert.equal(ai.chainFor({ use: 'rest:nokey' })[0].keys, undefined, '無金鑰條目')
            assert.deepEqual(ai.chainFor({ use: 'rest:plainv' })[0].keys, ['k1'], '單把金鑰條目')
            for (const use of ['rest:nokey', 'rest:plainv']) {
                for (let i = 0; i < 2; i++) assert.equal((await ai.callJson('摘要', check, { spec: { use } })).error, 'OUTPUT_VALIDATION_FAILED')
                assert.equal(ai.health.snapshot().counts[use].cooled, 1, `${use}:兩次呼叫各計一次 → 達門檻冷卻`)
                const { tries } = await tryOrder(ai, { use, fallback: ['rest:ok'] })
                assert.deepEqual(tries, ['rest:ok'], `${use}:冷卻生效`)
            }
            assert.deepEqual(seen.map((e) => [e.providerId, e.streak, e.errorType, 'keys' in e]), [['rest:nokey', 2, 'validation', false], ['rest:plainv', 2, 'validation', false]])
        })

        it('調度層:執行層失敗之限流字樣(HTTP 503 rate limit、session limit 原文)由冷卻偵測冷卻,健康層不重複計;同狀態碼無字樣不冷卻', async () => {
            for (const use of ['rest:rl503', 'rest:sl500']) {
                const ai = mk({}, { healthStreak: 2 })
                const r = await ai.callJson('摘要', check, { spec: { use } })
                assert.equal(r.ok, false)
                assert.equal(ai.health.snapshot().counts[use].cooled, 0, `${use}:健康層未達門檻(1 < 2)`)
                const { tries } = await tryOrder(ai, { use, fallback: ['rest:ok'] })
                assert.deepEqual(tries, ['rest:ok'], `${use}:已由冷卻偵測降序`)
            }
            const ai = mk({}, { healthStreak: 2 })
            assert.equal((await ai.callJson('摘要', check, { spec: { use: 'rest:x500' } })).error, 'HTTP 500')
            const { tries } = await tryOrder(ai, { use: 'rest:x500', fallback: ['rest:ok'] })
            assert.deepEqual(tries, ['rest:x500', 'rest:ok'], '對照:冷卻由字樣觸發,非狀態碼(1 次未達健康門檻)')
        })

        it('調度層:callOpt.onEvent 排在本層事件入口之後——呼叫端收到 try／ok,健康層照常計數;呼叫端回呼拋錯不影響呼叫與計數', async () => {
            const ai = mk({}, { healthStreak: 2 })
            const seen = []
            const r = await ai.callJson('q', check, { spec: { use: 'rest:ok' }, onEvent: (ev) => seen.push(ev.type) })
            assert.equal(r.ok, true)
            assert.deepEqual(seen.filter((t) => t === 'try' || t === 'ok'), ['try', 'ok'])
            assert.equal(ai.health.snapshot().counts['rest:ok'].ok, 1, '健康層計入(事件單一入口)')
            const r2 = await ai.callJson('q', check, {
                spec: { use: 'rest:ok' },
                onEvent: () => {
                    throw new Error('boom')
                },
            })
            assert.equal(r2.ok, true)
            assert.equal(ai.health.snapshot().counts['rest:ok'].ok, 2)
        })

        it('調度層:recordCall 外部補記之截斷放行成功另計於健康層;執行摘要(run.json)之 ai.health 帶 threshold／counts／streak', async () => {
            const ai = mk({}, { healthStreak: 3 })
            ai.recordCall({ ok: true, truncated: true, providerId: 'p:x', keyIndex: null, tried: [] })
            ai.recordCall({ ok: true, providerId: 'p:x', keyIndex: null, tried: [] })
            assert.equal(ai.health.snapshot().counts['p:x'].truncated, 1, '只有帶 truncated 者計入')
            await ai.callJson('q', check, { spec: { use: 'rest:plain' } })
            const sum = buildRunSummary({ ai, stamp: '20261007120000' })
            assert.deepEqual([sum.ai.health.threshold, sum.ai.health.counts['p:x'].truncated, sum.ai.health.streak['rest:plain'].n], [3, 1, 1])
            assert.equal(sum.ai.callStats, '成交 p:x×2；遞補略過 rest:plain#0(validation)×1；截斷放行 p:x×1')
        })

        it('調度層:ai.cooldownMs 為 0 時健康層照常計數與回呼,但無降序效果(上游不依冷卻重排;檔頭所載之限制)', async () => {
            const seen = []
            const ai = mk({ onHealth: (ev) => seen.push(ev) }, { healthStreak: 2, cooldownMs: 0 })
            for (let i = 0; i < 2; i++) await ai.callJson('q', check, { spec: { use: 'rest:plain' } })
            assert.equal(seen.length, 1)
            const { tries } = await tryOrder(ai, { use: 'rest:plain', fallback: ['rest:ok'] })
            assert.deepEqual(tries, ['rest:plain', 'rest:ok'])
        })
    })

    describe('能力預篩(規則⑧)', function() {

        const agy = { id: 'agy:g', kind: 'antigravity' }
        const son = { id: 'claude:sonnet', kind: 'claude' }
        const cdx = { id: 'codex:luna', kind: 'codex' }

        it('上限來源:kind 硬上限 → 條目自帶 → 逐 id 覆寫;未知 kind 無上限;inherent:false 只認逐 id 覆寫', () => {
            assert.equal(KIND_MAX_PROMPT_CHARS.antigravity, 30_000, '來源:w-dispatch-ai dispatchAntigravity.mjs MAX_PROMPT_LENGTH')
            assert.equal(maxPromptCharsOf(agy), 30_000)
            assert.equal(maxPromptCharsOf(son), Infinity, 'claude 走 stdin,無命令列長度上限')
            assert.equal(maxPromptCharsOf(cdx), Infinity, 'codex 走 stdin')
            assert.equal(maxPromptCharsOf({ id: 'x', kind: 'antigravity', maxPromptChars: 12_000 }), 12_000, '條目自帶優先於 kind')
            assert.equal(maxPromptCharsOf(agy, { 'agy:g': 20_000 }), 20_000, '逐 id 覆寫優先於一切')
            assert.equal(maxPromptCharsOf(agy, { 'agy:g': 0 }), Infinity, '覆寫為 0／null＝明示解除上限')
            assert.equal(maxPromptCharsOf(null), Infinity)
            assert.equal(maxPromptCharsOf(agy, null), 30_000, '覆寫表非物件視為無覆寫')
            assert.equal(maxPromptCharsOf(agy, {}, { inherent: false }), Infinity, 'kind 之固有上限不計')
            assert.equal(maxPromptCharsOf({ id: 'x', kind: 'antigravity', maxPromptChars: 12_000 }, {}, { inherent: false }), Infinity, '條目自帶之固有上限不計')
            assert.equal(maxPromptCharsOf(son, { 'claude:sonnet': 500 }, { inherent: false }), 500, '逐 id 覆寫照常生效')
        })

        it('fitChain:超過上限者剔除、鏈序不變;放得下者全留;恰等於上限者放行;inherent:false 不計 kind 上限', () => {
            const chain = [agy, son, cdx]
            const small = fitChain(chain, 10_000)
            assert.deepEqual(small.kept.map((x) => x.id), ['agy:g', 'claude:sonnet', 'codex:luna'])
            assert.deepEqual(small.dropped, [])
            const big = fitChain(chain, 43_814)
            assert.deepEqual(big.kept.map((x) => x.id), ['claude:sonnet', 'codex:luna'], '剔除後鏈序不變,遞補照原順序')
            assert.deepEqual(big.dropped, [{ id: 'agy:g', limit: 30_000 }])
            assert.equal(fitChain(chain, 30_000).dropped.length, 0, '恰等於上限者放行(轉接器之判準為 >)')
            assert.equal(fitChain(chain, 30_001).dropped.length, 1)
            assert.deepEqual(fitChain(chain, 43_814, {}, { inherent: false }).dropped, [])
        })

        it('fitChain:全鏈皆放不下時 kept 為空(呼叫端據此回失敗,不送出);空鏈與非陣列為空鏈;promptLen 非有限數值視為 0(全數保留)', () => {
            const r = fitChain([agy, { id: 'agy:h', kind: 'antigravity' }], 50_000)
            assert.deepEqual(r.kept, [])
            assert.equal(r.dropped.length, 2)
            assert.deepEqual(fitChain([], 10), { kept: [], dropped: [] })
            assert.deepEqual(fitChain(null, 10), { kept: [], dropped: [] })
            assert.deepEqual(fitChain('x', 10), { kept: [], dropped: [] })
            for (const bad of [NaN, undefined, null, 'abc', {}, Infinity, -Infinity]) {
                const x = fitChain([agy, son], bad)
                assert.deepEqual([x.dropped, x.kept.length], [[], 2], String(bad))
            }
        })

        // ── 調度層接線(真實派送路徑):antigravity 條目之轉接器於啟動子行程之前即擋下逾 30,000 字之 prompt;exe 另指向不存在之路徑(不呼叫真 CLI)──
        const agyEntry = (id) => ({ id, kind: 'antigravity', model: 'x', exe: `${TMP}/no-such-agy.exe` })
        const catAgy = () => [agyEntry('agy:a'), agyEntry('agy:b'), ...CAT]
        const LONG = '長'.repeat(31_000)
        const lenOf = (p) => NO_SIDE_EFFECT.length + p.length

        /**
         * 以指定提示詞呼叫一次並收集各次嘗試之條目 id(依序)
         *
         * @param {Object} ai 輸入 adapter
         * @param {String} prompt 輸入提示詞
         * @param {Object} spec 輸入席位
         * @param {Object} [extra={}] 輸入其他逐次選項
         * @returns {Promise} 回傳 { r, tries }
         */
        const run = async (ai, prompt, spec, extra = {}) => {
            const tries = []
            const r = await ai.callJson(prompt, check, { spec, ...extra, onEvent: (ev) => (ev.type === 'try' ? tries.push(ev.providerId) : null) })
            return { r, tries }
        }

        it('capability 開啟:放不下之 antigravity 條目於呼叫前剔除(不送出)、遞補照原順序;onOversize 每條目每實例一次;健康層計「prompt 逾長跳過」;短 prompt 照常保留', async () => {
            const over = []
            const ai = mk({ capability: true, catalogue: catAgy(), onOversize: (ev) => over.push(ev) }, { healthStreak: 2 })
            for (let i = 0; i < 2; i++) {
                const a = await run(ai, LONG, { use: 'agy:a', fallback: ['rest:ok'] })
                assert.deepEqual([a.r.ok, a.r.providerId, a.r.attempts, a.tries], [true, 'rest:ok', 1, ['rest:ok']], `第 ${i + 1} 次:未送出放不下者`)
            }
            assert.deepEqual(over, [{ providerId: 'agy:a', promptLen: lenOf(LONG), limit: 30_000 }], '同一條目只回呼一次')
            assert.equal(ai.health.snapshot().counts['agy:a'].oversize, 2, '次數計於健康層')
            assert.match(ai.health.summary(), /prompt 逾長跳過 agy:a×2/)
            const short = await run(ai, 'q', { use: 'agy:a', fallback: ['rest:ok'] })
            assert.deepEqual([short.r.providerId, short.tries], ['rest:ok', ['agy:a', 'rest:ok']], '放得下者保留(本例之執行檔不存在而失敗後遞補)')
        })

        it('全鏈皆放不下 → 失敗不送出(attempts 0、errors 空、非 skipped、無請求),訊息附長度與各家上限;preview 開啟時為空字串', async () => {
            const ai = mk({ capability: true, preview: true, catalogue: catAgy() })
            const r = await ai.callJson(LONG, check, { spec: { use: 'agy:a', fallback: ['agy:b'] } })
            assert.deepEqual([r.ok, r.attempts, r.errors, r.skipped, r.preview, hits.length], [false, 0, [], false, '', 0])
            assert.equal(r.error, `prompt ${lenOf(LONG)} 字元超過本席位全部條目之上限（agy:a≤30000、agy:b≤30000）：縮短輸入或於遞補鏈加入無上限之條目`)
        })

        it('ai.providerLimits 之逐 id 上限恆生效(未開 capability 亦然):逾上限即剔除、恰等於上限者放行、未列出者不受 kind 上限;capability 開啟時逐 id 覆寫可放寬 kind 上限', async () => {
            const p = 'q'.repeat(100)
            const a = await run(mk({}, { providerLimits: { 'rest:plain': lenOf(p) - 1 } }), p, { use: 'rest:plain', fallback: ['rest:ok'] })
            assert.deepEqual(a.tries, ['rest:ok'], '逾上限 1 字即剔除')
            const b = await run(mk({}, { providerLimits: { 'rest:plain': lenOf(p) } }), p, { use: 'rest:plain', fallback: ['rest:ok'] })
            assert.deepEqual(b.tries, ['rest:plain', 'rest:ok'], '恰等於上限者放行')
            const c = await run(mk({ catalogue: catAgy() }, { providerLimits: { 'rest:plain': 1 } }), LONG, { use: 'agy:a', fallback: ['rest:ok'] })
            assert.deepEqual(c.tries, ['agy:a', 'rest:ok'], 'capability 未開:未列出之 antigravity 不受 kind 上限,照常送交(轉接器回 params 後遞補)')
            const d = await run(mk({ capability: true, catalogue: catAgy() }, { providerLimits: { 'agy:a': 40_000 } }), LONG, { use: 'agy:a', fallback: ['rest:ok'] })
            assert.deepEqual(d.tries, ['agy:a', 'rest:ok'], '逐 id 覆寫(40,000)優先於 kind 上限:未剔除')
        })

        it('validateSeats:全鏈條目皆有上限之席位回警告(上限取法同呼叫);首選有上限而遞補無上限者不警告;未開 capability 且無逐 id 上限者恆無警告;警告不影響問題席位之彙整', () => {
            const on = mk({ capability: true, catalogue: catAgy() })
            const w = on.validateSeats({ 'x.ai': { use: 'agy:a', fallback: ['agy:b'] }, 'y.ai': { use: 'agy:a', fallback: ['rest:ok'] } })
            assert.deepEqual(w, { ok: true, warnings: ['x.ai 之全鏈條目皆有 prompt 長度上限（agy:a≤30000、agy:b≤30000）：prompt 超過時本席位無處可去、呼叫即失敗；建議遞補鏈至少留一家無上限者'] })
            assert.deepEqual(mk({ catalogue: catAgy() }).validateSeats({ 'x.ai': { use: 'agy:a', fallback: ['agy:b'] } }).warnings, [], '固有上限未開')
            const lim = mk({}, { providerLimits: { 'rest:ok': 1000, 'rest:plain': 2000 } })
            assert.deepEqual(lim.validateSeats({ s: { use: 'rest:ok', fallback: ['rest:plain'] } }).warnings, ['s 之全鏈條目皆有 prompt 長度上限（rest:ok≤1000、rest:plain≤2000）：prompt 超過時本席位無處可去、呼叫即失敗；建議遞補鏈至少留一家無上限者'])
            assert.throws(() => on.validateSeats({ 'x.ai': { use: 'agy:a', fallback: ['agy:b'] }, bad: { use: 'nope:x' } }), /^Error: AI 席位於啟動期檢核失敗（1 席）：bad → 席位引用了不可用的條目：nope:x/)
        })

        it('先預篩再避開:放得下者只剩被避開者時不避(避開不致使呼叫失敗);預篩與避開各自生效', async () => {
            const ai = mk({ capability: true, catalogue: catAgy() })
            const a = await run(ai, LONG, { use: 'agy:a', fallback: ['rest:ok'] }, { avoid: ['rest:ok'] })
            assert.deepEqual([a.r.ok, a.r.providerId, a.tries], [true, 'rest:ok', ['rest:ok']])
            const b = await run(ai, LONG, { use: 'agy:a', fallback: ['rest:plain', 'rest:ok'] }, { avoid: ['rest:plain'] })
            assert.deepEqual([b.r.providerId, b.tries], ['rest:ok', ['rest:ok']], 'agy 逾長剔除、rest:plain 避開')
        })

        it('onOversize 回呼拋錯不影響呼叫', async () => {
            const ai = mk({
                capability: true,
                catalogue: catAgy(),
                onOversize: () => {
                    throw new Error('boom')
                },
            })
            const r = await ai.callJson(LONG, check, { spec: { use: 'agy:a', fallback: ['rest:ok'] } })
            assert.deepEqual([r.ok, r.providerId], [true, 'rest:ok'])
        })
    })
})
