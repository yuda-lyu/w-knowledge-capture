// unit-assembly.test.mjs — 總組裝 createKnowledgeCapture 之嚴格性與接線:cfg 逐鍵／子鍵檢核(由系統之鍵集推導)、notes 開關、info() 內容、run() 以替身子階段、AI 調度層接線
// 規則(出自 createKnowledgeCapture 檔頭):
//   ①設定錯誤一律啟動期拋錯,不靜默沿用預設:cfg 之未知鍵、各鍵之形狀、設定兩段(ai／capture)、資料、提示詞、子階段、AI 席位皆於建構期驗;訊息點名錯誤之鍵並列可用鍵
//   ②形狀錯誤之訊息不得被席位檢核搶先;給了卻無效之執行期數值鍵(排程上限、時間預算、鎖陳舊期限)視同未給並以啟動期警告指名
//   ③筆記耦合為選用:cfg.notes 開啟(true 或集合名)才加開 notes 集合;抓取不預設依賴摘要之產物
//   ④每輪依賴(deps)只放可列舉之普通屬性(pipeline 以 spread 複製 deps);子階段只讀約定之鍵,自寫子階段與套件子階段同一條注入通道
//   ⑤每輪開工先寫 run.start.json(本輪上限之宣告),管線後依序:符合度掃描(可選)、寫 run.json、收尾鉤子(可選);收尾失敗只留 warn、不影響本輪;未取得執行鎖者不掃描、不寫摘要、不收尾
//   ⑥時間預算、鎖陳舊期限、各路徑由 resolveRuntime 一次解析,管線與 info() 同取此份;集合每次執行開、結束一律關
// 執行:自套件根 npx mocha test/unit-assembly.test.mjs(暫存 test/_tmp/assembly-<pid>,測完即刪;真 LMDB、子階段為替身、AI 為替身或指向死埠 8830,不連外網)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import WOrmLmdb from 'w-orm-lmdb/src/WOrmLmdb.mjs'
import W from 'w-data-pipeline/src/WDataPipeline.mjs'
import {
    createKnowledgeCapture, CFG_KEYS, DATA_KEYS, PROMPT_KEYS, COLLECTION_KEYS, CAPTURE_STAGE_KEYS, AUDITED_STANDARD_IDS,
    stdReport, acquireLock, createLogger, expandDirs, AREA_CONTRACT, SKIP_TITLE_PATTERNS_DEFAULT,
    createCaptureRuntime, resolveCaptureData, CAPTURE_STORE_KEYS, CAPTURE_DATA_KEYS, captureSeatsOf, CAPTURE_SEAT_LABELS, captureAiNoteOf, resolveSettings,
} from '../src/WKnowledgeCapture.mjs'
import { setConceptFold, normalizeConcept } from '../src/core/util/text.mjs'
import { tmpRoot, noAiAdapter } from './tools/captureTestKit.mjs'
import { removeRoots, recLog, silentLog, sleep, FIXED_CLOCK, findFiles, readJsonFile, msgOf } from './tools/testKit.mjs'

// 替身 AI 調度層(整組置換 cfg.aiAdapter:不建內建調度層、不呼叫真實 AI;被呼叫即拋——抓取之子階段替身不得呼叫 AI)
const stubAi = noAiAdapter()
const DEAD_BASE = 'http://127.0.0.1:8830/v1' // 無人監聽之死埠:連線即被拒
const MIN = 60_000

/**
 * 從錯誤訊息「（可用：a、b、c）」取出系統自己列出之可用鍵(鍵集由系統推導,不手列)
 *
 * @param {Function} fn 輸入會拋含「可用：」訊息之函數
 * @returns {Array} 回傳可用鍵陣列
 */
const availableKeysOf = (fn) => {
    let m = ''
    try {
        fn()
    }
    catch (e) {
        m = String(e.message)
    }
    const hit = /（可用：([^）]+)）/.exec(m)
    assert.ok(hit, `訊息須列出可用鍵:${m}`)
    return hit[1].split('、')
}

// ── cfg 逐鍵之錯值(皆須拋錯並點名該鍵)、寬容鍵(無效值僅警告)、有效值(須被接受) ──
const MORE_WRONG = (extra) => ['x', 5, [], ...extra]
const STRICT = {
    workDir: { wrong: [5, '', {}, [], null], name: /需要 workDir/, valid: ['C:/x/y'] },
    name: { wrong: [5, '', {}, [], true, false], name: /cfg\.name 須為非空字串/, valid: ['自訂管線名'] },
    dirs: { wrong: MORE_WRONG([{ zzz: 'a' }, { db: 5 }]), name: /cfg\.dirs/, valid: [{}, { knowledge: 'D:/vault/k' }] },
    timeZone: { wrong: [5, '', {}, 'Nowhere/City'], name: /cfg\.timeZone/, valid: ['UTC', 'Asia/Taipei'] },
    clock: { wrong: [{}, 'x', 5], name: /cfg\.clock/, valid: [FIXED_CLOCK] },
    lang: { wrong: [5, '', {}, [], true, '!!', 'zh_TW'], name: /cfg\.lang/, valid: ['zh-TW', 'en', 'ja'] },
    data: { wrong: MORE_WRONG([{ zzz: 1 }]), name: /cfg\.data/, valid: [{}, { seedSources: [] }] },
    prompts: { wrong: MORE_WRONG([{ zzz: 1 }, { area: 'x' }]), name: /cfg\.prompts/, valid: [{}, { area: () => 'p' }] },
    conceptFold: { wrong: ['x', 5, {}], name: /cfg\.conceptFold/, valid: [true, false, (t) => t] },
    ai: { wrong: MORE_WRONG([{ zzz: 1 }, { area: { use: 'oc:x' } }, { timeoutMs: 0 }]), name: /settings\.ai/, valid: [{}, { cooldownMs: 0 }] },
    capture: { wrong: MORE_WRONG([{ zzz: 1 }, { sourcesPerRun: 3 }, { sources: 'x' }, { sources: { perRun: 'x' } }, { standards: { scanEachRun: 'yes' } }, { sources: { lowYieldRate: 2 } }]), name: /settings\.capture/, valid: [{}, { sources: { perRun: 3 } }, { sources: { lowYieldRate: 0.2 }, standards: { scanEachRun: true } }] },
    scheduleLimitMin: { warn: ['abc', -1, 0, {}, [], true], valid: [55, '65'] },
    deadlineMs: { warn: ['abc', -1, 0, {}, [], true], valid: [600_000] },
    lockStaleMs: { warn: ['abc', -1, 0, {}, [], true], valid: [3_600_000] },
    lock: { wrong: [5, {}, []], name: /cfg\.lock/, valid: [false, true, 'x/run.lock'] },
    envFile: { wrong: [5, {}, [], true], name: /cfg\.envFile/, valid: ['sec/.env'] },
    aiWorkspace: { wrong: [5, {}, [], true], name: /cfg\.aiWorkspace/, valid: ['x/ws'] },
    aiAdapter: { wrong: [{}, 5, 'x', [], false, 0], name: /cfg\.aiAdapter/, valid: [stubAi] },
    // 內建調度層之建構選項:鍵集於組裝期驗(注入 aiAdapter 時亦驗);值之形狀由 createAiAdapter 驗(本表之 build 注入替身,不建內建者)
    aiOptions: { wrong: ['x', 5, [], true, { zzz: 1 }, { providerpick: [] }], name: /cfg\.aiOptions/, valid: [{}, { exes: {} }, { providerPick: ['oc:opencode/big-pickle'] }] },
    stages: { wrong: [[], 'x', 5, {}, [{ name: 'a' }]], name: /cfg\.stages/, valid: [[{ name: 'a', run: async () => ({}) }]] },
    stageOpts: { wrong: MORE_WRONG([{ zzz: {} }, { listFetch: 5 }]), name: /cfg\.stageOpts/, valid: [{}, { listFetch: {} }] },
    fetchers: { wrong: [{}, [5], 'x', 5], name: /cfg\.fetchers/, valid: [[]] },
    siteAdapters: { wrong: [{}, [{ id: 'x' }], 'x', 5, false, 0], name: /cfg\.siteAdapters/, valid: [[]] },
    dedup: { wrong: ['x', 5, [], { keyOf: 'nope' }, true], name: /主鍵策略/, valid: [{ keyOf: 'raw' }] },
    lmdb: { wrong: MORE_WRONG([{ zzz: 1 }, { WOrm: {} }, { path: '' }, { db: 5 }, { cls: 'x' }]), name: /cfg\.lmdb/, valid: [{}, { db: 'other' }] },
    notes: { wrong: [5, {}, [], 0], name: /cfg\.notes/, valid: [true, false, 'myNotes'] },
    logFactory: { wrong: [5, 'x', {}, [], 0, false], name: /cfg\.logFactory/, valid: [() => recLog()] },
    afterRun: { wrong: [5, true, 'x', {}, [], 0], name: /cfg\.afterRun/, valid: [false, () => ({})] },
    netGuard: { wrong: ['x', 5, [], false, 0, true], name: /cfg\.netGuard/, valid: [null, { check: async () => ({ up: true }) }] },
}

describe('unit-assembly', function() {

    this.timeout(120_000)

    let root = ''
    before(() => {
        root = tmpRoot('assembly')
    })
    after(() => {
        setConceptFold(null) // 概念折疊為模組級單例,不留給同 worker 之他檔
        removeRoots([root])
    })

    let seq = 0
    const dirOf = (name = 'c') => `${root}/${name}-${++seq}`
    // 預設組裝:替身 AI、不探測網路、不上鎖、靜音日誌;extra 逐鍵覆寫
    const build = (extra = {}) => createKnowledgeCapture({ workDir: dirOf(), aiAdapter: stubAi, netGuard: null, lock: false, logFactory: () => silentLog, ...extra })

    describe('cfg 逐鍵嚴格性(CFG_KEYS 全部鍵 × 錯值／寬容／有效值)', function() {

        it('案例表之鍵集等於 CFG_KEYS(新增 cfg 鍵而未補嚴格性案例即失敗);每個鍵至少有錯值或寬容案例與有效值案例', () => {
            assert.deepEqual(Object.keys(STRICT).sort(), [...CFG_KEYS].sort())
            for (const [k, s] of Object.entries(STRICT)) {
                assert.ok((s.wrong?.length || 0) + (s.warn?.length || 0) > 0, `${k} 缺錯值案例`)
                assert.ok(s.valid?.length > 0, `${k} 缺有效值案例`)
            }
        })

        for (const key of CFG_KEYS) {
            it(`${key}:${STRICT[key]?.wrong ? '錯值一律拋錯並點名該鍵' : '無效值視同未給並以啟動期警告指名(不拋)'};有效值被接受`, () => {
                const s = STRICT[key]
                for (const bad of s.wrong || []) {
                    let m = null
                    try {
                        build({ [key]: bad })
                    }
                    catch (e) {
                        m = String(e.message)
                    }
                    assert.notEqual(m, null, `${key}=${JSON.stringify(bad)} 應於建構期拋錯(不得靜默接受)`)
                    assert.match(m, s.name, `${key}=${JSON.stringify(bad)}:${m}`)
                }
                for (const bad of s.warn || []) {
                    const flow = build({ [key]: bad })
                    assert.ok(flow.info().startupWarnings.some((w) => w.startsWith(`cfg.${key} 無效（收到 `) && w.endsWith('視同未給')), `${key}=${JSON.stringify(bad)} 應有指名警告:${flow.info().startupWarnings.join('｜')}`)
                }
                for (const ok of s.valid) {
                    assert.doesNotThrow(() => build({ [key]: ok }), `${key}=${typeof ok} 為有效值`)
                }
            })
        }

        it('cfg 非物件視為 {} 後由 workDir 檢查拋錯;不認得之鍵拋錯並列出全部可用鍵(即 CFG_KEYS);近似拼寫亦不接受', () => {
            for (const bad of [null, undefined, 5, 'x', []]) assert.throws(() => createKnowledgeCapture(bad), /createKnowledgeCapture 需要 workDir/)
            const m = (() => {
                try {
                    build({ aiAdapte: stubAi })
                }
                catch (e) {
                    return e.message
                }
                return ''
            })()
            assert.equal(m, `cfg 含不認得之鍵：aiAdapte（可用：${CFG_KEYS.join('、')}）`)
            assert.deepEqual(availableKeysOf(() => build({ zzz: 1 })), [...CFG_KEYS])
        })
    })

    describe('cfg 子鍵嚴格性(鍵集取自系統自己列出之可用鍵)', function() {

        it('cfg.data:DATA_KEYS(種子、網格主題、詞彙)各鍵給錯型別即拋(點名 cfg.data.<鍵>);有效值逐鍵反映於 info().data;標題預篩樣式不在 cfg.data(歸 capture.articles.skipTitlePatterns,整份取代預設)', () => {
            assert.deepEqual(availableKeysOf(() => build({ data: { zzz: 1 } })), [...DATA_KEYS])
            assert.deepEqual([...DATA_KEYS], ['seedSources', 'gridTopics', 'vocab'])
            for (const k of DATA_KEYS) {
                const wrong = k === 'vocab' ? [5, 'x', [], false, 0] : [5, 'x', {}, false, 0]
                for (const bad of wrong) assert.throws(() => build({ data: { [k]: bad } }), new RegExp(`cfg\\.data\\.${k} 須為`), `data.${k}=${JSON.stringify(bad)}`)
            }
            assert.throws(() => build({ data: { skipTitlePatterns: [/^only/i] } }), /cfg\.data 含不認得之鍵：skipTitlePatterns/, '標題預篩樣式屬設定(capture.articles.skipTitlePatterns),不在 cfg.data')
            const seeds = [{ kind: 'rss', tier: 1, name: 'n', url: 'https://example.com/feed', lang: 'en' }]
            const grid = [['圖學習', 'graph learning']]
            const info = build({
                data: { seedSources: seeds, gridTopics: grid, vocab: { domain: '天文學' } },
                capture: { articles: { skipTitlePatterns: [/^only/i, { p: '^json', f: 'i' }] } },
            }).info()
            assert.deepEqual([info.data.seedSources, info.data.gridTopics], [seeds, grid])
            assert.deepEqual(Object.keys(info.data).sort(), ['gridTopics', 'seedSources', 'vocab'])
            assert.deepEqual(info.settings.capture.articles.skipTitlePatterns, [/^only/i, { p: '^json', f: 'i' }], '給了即整份取代預設(設定值保留 RegExp 與 { p, f } 原樣;編譯於使用處以 toPatterns)')
            assert.equal(info.vocab.domain, '天文學')
            assert.deepEqual(info.data.vocab, { domain: '天文學' }, 'data.vocab 為安裝方原給之覆寫;info().vocab 為已解析')
        })

        it('cfg.prompts:PROMPT_KEYS 各鍵給非函數即拋;函數被內建領域物件採用(取得候選、既有領域與 { kbLabel, domain, contract });回傳非空字串之外者於組提示詞時拋', () => {
            assert.deepEqual(availableKeysOf(() => build({ prompts: { zzz: 1 } })), [...PROMPT_KEYS])
            for (const k of PROMPT_KEYS) for (const bad of [5, 'x', {}, [], false, 0]) assert.throws(() => build({ prompts: { [k]: bad } }), new RegExp(`cfg\\.prompts\\.${k} 須為函數`), `prompts.${k}=${JSON.stringify(bad)}`)
            const seen = []
            const flow = build({ data: { vocab: { domain: '天文學' } }, prompts: { area: (cands, areas, ctx) => {
                seen.push([cands, areas, ctx])
                return `提示詞：${ctx.kbLabel}`
            } } })
            const out = flow.info().domains.area.buildPrompt([{ label: 'x' }], [{ label: 'y' }])
            assert.equal(out, '提示詞：「天文學」知識庫')
            assert.deepEqual(seen[0][0], [{ label: 'x' }])
            const { defaultPrompt, ...ctxRest } = seen[0][2]
            assert.deepEqual(ctxRest, { kbLabel: '「天文學」知識庫', domain: '天文學', contract: AREA_CONTRACT })
            assert.equal(typeof defaultPrompt, 'function', 'ctx.defaultPrompt＝內建提示詞函數')
            for (const bad of ['', '  ', 5, null]) assert.throws(() => build({ prompts: { area: () => bad } }).info().domains.area.buildPrompt([], []), /須回傳非空字串/, `回傳 ${JSON.stringify(bad)}`)
        })

        it('cfg.dirs:可用鍵即 expandDirs 之鍵;各鍵給非字串或空字串即拋;有效路徑逐鍵取代對應目錄,其餘仍由 workDir 展開', () => {
            const keys = Object.keys(expandDirs('c:/x'))
            assert.deepEqual(availableKeysOf(() => build({ dirs: { zzz: 'a' } })), keys)
            for (const k of keys) for (const bad of [5, '', {}, [], false, 0]) assert.throws(() => build({ dirs: { [k]: bad } }), new RegExp(`cfg\\.dirs\\.${k} 須為非空路徑字串`), `dirs.${k}=${JSON.stringify(bad)}`)
            const wd = dirOf('dirs')
            for (const k of keys) {
                const info = createKnowledgeCapture({ workDir: wd, aiAdapter: stubAi, netGuard: null, lock: false, dirs: { [k]: `${wd}/custom-${k}` } }).info()
                assert.deepEqual(info.dirs, { ...expandDirs(wd), [k]: `${wd}/custom-${k}` }, k)
            }
        })

        it('cfg.lmdb:可用鍵取自系統(WOrm、path、db、cls);各鍵給錯型別即拋;有效值反映於 info().lmdb;lmdb.path 預設為 dirs.db', () => {
            assert.deepEqual(availableKeysOf(() => build({ lmdb: { zzz: 1 } })), ['WOrm', 'path', 'db', 'cls'])
            assert.throws(() => build({ lmdb: { WOrm: {} } }), /cfg\.lmdb\.WOrm 須為 ORM 建構函數/)
            for (const k of ['path', 'db']) for (const bad of [5, '', {}, []]) assert.throws(() => build({ lmdb: { [k]: bad } }), new RegExp(`cfg\\.lmdb\\.${k} 須為非空字串`), `${k}=${JSON.stringify(bad)}`)
            for (const bad of ['x', 5, []]) assert.throws(() => build({ lmdb: { cls: bad } }), /cfg\.lmdb\.cls 須為物件/)
            const wd = dirOf('lmdb')
            const def = createKnowledgeCapture({ workDir: wd, aiAdapter: stubAi, netGuard: null, lock: false }).info().lmdb
            assert.deepEqual([def.path, def.db], [`${wd}/db`, 'knowledge'])
            const WOrm = () => ({})
            const custom = createKnowledgeCapture({ workDir: wd, aiAdapter: stubAi, netGuard: null, lock: false, lmdb: { WOrm, path: `${wd}/other`, db: 'mine' } }).info().lmdb
            assert.deepEqual([custom.WOrm === WOrm, custom.path, custom.db], [true, `${wd}/other`, 'mine'])
        })

        it('cfg.lmdb.cls:可用鍵即 COLLECTION_KEYS;各鍵給非空字串以外即拋;有效值逐鍵改集合名、其餘維持預設名', () => {
            assert.deepEqual(availableKeysOf(() => build({ lmdb: { cls: { zzz: 'x' } } })), [...COLLECTION_KEYS])
            for (const k of COLLECTION_KEYS) for (const bad of [5, '', {}, [], false, 0]) assert.throws(() => build({ lmdb: { cls: { [k]: bad } } }), new RegExp(`cfg\\.lmdb\\.cls\\.${k} 須為非空字串`), `cls.${k}=${JSON.stringify(bad)}`)
            const dflt = build().info().lmdb.cls
            assert.deepEqual(dflt, Object.fromEntries(COLLECTION_KEYS.map((k) => [k, k])), '預設集合名即對外名(與知識庫套件相同,共用庫時不必遷移)')
            for (const k of COLLECTION_KEYS) assert.deepEqual(build({ lmdb: { cls: { [k]: `my_${k}` } } }).info().lmdb.cls, { ...dflt, [k]: `my_${k}` }, k)
        })

        it('cfg.stageOpts:可用鍵即 CAPTURE_STAGE_KEYS(內建子階段依序);各鍵給非物件即拋;{} 皆被接受', () => {
            assert.deepEqual(availableKeysOf(() => build({ stageOpts: { zzz: {} } })), [...CAPTURE_STAGE_KEYS])
            assert.deepEqual([...CAPTURE_STAGE_KEYS], ['hygiene', 'seedSync', 'listFetch', 'detailFetch', 'docMaintain', 'expand', 'areas'])
            for (const k of CAPTURE_STAGE_KEYS) {
                for (const bad of [5, 'x', [], false, 0]) assert.throws(() => build({ stageOpts: { [k]: bad } }), new RegExp(`cfg\\.stageOpts\\.${k} 須為物件`), `stageOpts.${k}=${JSON.stringify(bad)}`)
                assert.doesNotThrow(() => build({ stageOpts: { [k]: {} } }), k)
            }
        })

        it('設定兩段(ai／capture)子鍵之嚴格性由 resolveSettings 之 schema 承擔:總組裝對各組之錯誤原樣拋出(完整路徑與鍵可辨)', () => {
            assert.throws(() => build({ capture: { sources: { perRn: 1 } } }), /settings\.capture\.sources 含不認得之鍵：perRn（可用：.*perRun/)
            assert.throws(() => build({ capture: { articles: { perRun: '27' } } }), /settings\.capture\.articles\.perRun 須為非負整數，收到 "27"/)
            assert.throws(() => build({ capture: { discover: { ai: { use: 'x', fallbak: [] } } } }), /settings\.capture\.discover\.ai 須為席位物件.*含不認得之鍵：fallbak/)
            assert.throws(() => build({ capture: { standards: { scanEachRun: 1 } } }), /settings\.capture\.standards\.scanEachRun 須為布林值/)
            assert.throws(() => build({ capture: { standards: { placeholderPatterns: [{ p: '(' }] } } }), /placeholderPatterns\[0\]/, '追加之健全閘樣式於建構期編譯')
            assert.throws(() => build({ capture: { articles: { skipTitlePatterns: [{ p: '(' }] } } }), /capture\.articles\.skipTitlePatterns\[0\] 樣式不合法/, '標題預篩樣式於建構期編譯')
        })
    })

    describe('檢核順序與跨鍵關係', function() {

        it('形狀錯誤之訊息不被席位檢核搶先:同時有 cfg 形狀錯與無法解析之席位 → 報形狀錯', () => {
            const seatBad = { capture: { discover: { ai: { use: 'oc:opencode/no-such-model-free' } } } }
            assert.throws(() => createKnowledgeCapture({ workDir: dirOf(), netGuard: null, lock: false, ...seatBad }), /AI 席位於啟動期檢核失敗/, '前提:單獨之席位錯誤確實拋出')
            for (const [name, extra, re] of [
                ['notes 型別錯', { notes: 5 }, /cfg\.notes 須為/],
                ['stages 與 stageOpts 並給', { stages: [{ name: 'a', run: () => {} }], stageOpts: {} }, /擇一/],
                ['data 形狀錯', { data: 'x' }, /cfg\.data 須為物件/],
                ['logFactory 型別錯', { logFactory: 5 }, /cfg\.logFactory/],
                ['lmdb 形狀錯', { lmdb: 'x' }, /cfg\.lmdb/],
            ]) {
                assert.throws(() => createKnowledgeCapture({ workDir: dirOf(), netGuard: null, lock: false, ...seatBad, ...extra }), re, name)
            }
        })

        it('設定(ai／capture)之錯誤先於其他 cfg 鍵之形狀錯(同時錯時先報 settings)', () => {
            assert.throws(() => build({ data: 'x', capture: 'x' }), /settings\.capture 須為物件/)
        })

        it('cfg.stages(整組自訂子階段)與 cfg.stageOpts(內建子階段 opt)擇一;各自單給皆可', () => {
            const st = [{ name: 'a', run: async () => stdReport() }]
            assert.throws(() => build({ stages: st, stageOpts: { listFetch: {} } }), /cfg\.stages（整組自訂子階段）與 cfg\.stageOpts（內建子階段之 opt）擇一/)
            assert.throws(() => build({ stages: st, stageOpts: {} }), /擇一/, '空物件亦算並給')
            assert.doesNotThrow(() => build({ stages: st }))
            assert.doesNotThrow(() => build({ stageOpts: { listFetch: {} } }))
            assert.throws(() => build({ stages: [{ name: 'a', run: () => {} }, { name: 'a', run: () => {} }] }), /cfg\.stages 有重複之子階段名：a/)
        })

        it('注入 cfg.aiAdapter:不建內建調度層(無 aiWorkspace、不檢核席位之可解析),交其 validateSeats 檢核 { "capture.discover.ai": settings.capture.discover.ai };其回傳之 warnings 併入啟動期警告;其拋錯即建構期拋錯', () => {
            // 無 validateSeats:即使席位 id 不存在亦不拋(席位解析屬被置換之調度層)
            const loose = createKnowledgeCapture({ workDir: dirOf(), netGuard: null, lock: false, aiAdapter: stubAi, capture: { discover: { ai: { use: 'oc:opencode/no-such-model-free' } } } })
            assert.equal(loose.info().ai, stubAi, '注入之調度層原樣交 info()')
            assert.equal(loose.info().aiWorkspace, null)
            const seatArgs = []
            const checked = createKnowledgeCapture({
                workDir: dirOf(),
                netGuard: null,
                lock: false,
                capture: { discover: { ai: { use: 'mine:a', fallback: ['mine:b'] } } },
                aiAdapter: { ...stubAi, validateSeats: (seats) => {
                    seatArgs.push(seats)
                    return { ok: true, warnings: ['席位提示一'] }
                } },
            })
            assert.deepEqual(seatArgs, [{ 'capture.discover.ai': { use: 'mine:a', fallback: ['mine:b'] } }], '建構期恰檢核一次')
            assert.ok(checked.info().startupWarnings.includes('席位提示一'))
            assert.throws(() => build({ aiAdapter: { ...stubAi, validateSeats: () => {
                throw new Error('席位不合格(替身)')
            } } }), /席位不合格\(替身\)/)
        })

        it('notes 與 lmdb.cls.notes:集合名擇一給(兩處給得不一致即拋;一致或只給一處皆可);cfg.notes 為 true 時集合名取自 lmdb.cls.notes', () => {
            assert.throws(() => build({ notes: 'a', lmdb: { cls: { notes: 'b' } } }), /cfg\.notes（a）與 cfg\.lmdb\.cls\.notes（b）不一致：筆記集合名擇一給/)
            assert.equal(build({ notes: 'a', lmdb: { cls: { notes: 'a' } } }).info().lmdb.cls.notes, 'a')
            assert.equal(build({ notes: 'a' }).info().lmdb.cls.notes, 'a')
            assert.equal(build({ notes: true, lmdb: { cls: { notes: 'custom' } } }).info().lmdb.cls.notes, 'custom')
            assert.equal(build({ lmdb: { cls: { notes: 'custom' } } }).info().collections.includes('notes'), false, '只給集合名而未開 notes 仍不開')
        })

        it('概念折疊接線(模組級單例):conceptFold 為 false 明確清除先前實例注入之折疊;給函數即自訂;未給用內建繁簡折疊', () => {
            build() // 內建:繁 → 簡
            assert.equal(normalizeConcept('風險'), '风险')
            build({ conceptFold: false })
            assert.equal(normalizeConcept('風險'), '風險', 'false 須明確清除(只是不設定會殘留前一實例之折疊)')
            build({ conceptFold: (t) => t.toUpperCase() })
            assert.equal(normalizeConcept('abc'), 'ABC')
            build({ conceptFold: true })
            assert.equal(normalizeConcept('風險'), '风险')
        })
    })

    describe('captureRuntime(兩個總組裝共用之抓取執行期件;captureRuntime 檔頭)', function() {

        const S0 = resolveSettings({})

        it('鍵集與集合:本總組裝之 cfg.data 可用鍵即 CAPTURE_DATA_KEYS、集合即 CAPTURE_STORE_KEYS＋notes;resolveCaptureData 只驗抓取所讀之鍵(鍵集由各總組裝自驗)', () => {
            assert.equal(DATA_KEYS, CAPTURE_DATA_KEYS)
            assert.deepEqual([...COLLECTION_KEYS], [...CAPTURE_STORE_KEYS, 'notes'])
            assert.deepEqual(build().info().collections, [...CAPTURE_STORE_KEYS])
            assert.deepEqual(resolveCaptureData({ seedSources: [], other: 1 }), { seedSources: [], gridTopics: [], vocab: null }, '不認得之鍵不在此驗')
            for (const bad of ['x', 5, []]) assert.throws(() => resolveCaptureData(bad), /cfg\.data 須為物件 \{ seedSources, gridTopics, vocab \}/)
            assert.throws(() => resolveCaptureData({ gridTopics: {} }), /cfg\.data\.gridTopics 須為陣列/)
            assert.throws(() => resolveCaptureData({ gridTopics: ['p'] }), /gridTopics/, '逐項形狀同 checkGridTopics')
            assert.throws(() => resolveCaptureData({ vocab: 'x' }), /cfg\.data\.vocab 須為物件/)
        })

        it('回傳之件與每輪依賴:deps(stores, log) 恰為 { seen, registry, netGuard }(seen 依 stores.docs 與去重身分);總組裝之每輪依賴含此三者且為同一實體', async () => {
            const rt = createCaptureRuntime({ netGuard: null }, S0)
            assert.deepEqual(Object.keys(rt).sort(), ['areaDomain', 'data', 'deps', 'fetchers', 'folds', 'identity', 'isNetDown', 'locale', 'netGuard', 'registry', 'siteAdapterSpecs', 'vocab'])
            const docs = W.openCollection({ WOrm: WOrmLmdb, path: `${dirOf('rt')}/db`, db: 'knowledge', cl: 'docs' })
            try {
                const d = rt.deps({ docs }, silentLog)
                assert.deepEqual(Object.keys(d).sort(), ['locale', 'netGuard', 'registry', 'seen', 'siteAdapterSpecs'])
                assert.equal(d.locale, rt.locale, '語言設定與執行期件同一物件')
                assert.equal(d.registry, rt.registry)
                assert.equal(d.seen.idOf('https://example.com/a'), rt.identity.of('https://example.com/a'), 'seen 以本實例之去重身分算 id')
            }
            finally {
                await docs.close()
            }
            // 總組裝:自寫子階段收到之依賴含 captureRuntime 之三件
            const sink = {}
            const flow = build({ stages: [{ name: 'probe', run: async (ctx) => {
                Object.assign(sink, { keys: Object.keys(ctx.deps).sort(), registry: ctx.deps.registry, seenIdOf: typeof ctx.deps.seen?.idOf, netGuard: ctx.deps.netGuard })
                return stdReport()
            } }] })
            await flow.run()
            assert.deepEqual(sink.keys, ['ai', 'clock', 'data', 'dirs', 'domains', 'locale', 'netGuard', 'registry', 'seen', 'settings', 'siteAdapterSpecs', 'stores', 'vocab'])
            assert.deepEqual([sink.registry === flow.info().registry, sink.seenIdOf, sink.netGuard], [true, 'function', null])
        })

        it('交 AI 調度層之 isNetDown:netGuard 具 confirmDown 才給(呼叫即問同一份);null 或無 confirmDown 者為 null(不給一個呼叫即拋之函數)', async () => {
            assert.equal(createCaptureRuntime({ netGuard: null }, S0).isNetDown, null)
            assert.equal(createCaptureRuntime({ netGuard: { check: async () => ({ up: true }) } }, S0).isNetDown, null)
            let asked = 0
            const g = { check: async () => ({}), confirmDown: async () => {
                asked++
                return true
            } }
            const rt = createCaptureRuntime({ netGuard: g }, S0)
            assert.equal(rt.netGuard, g)
            assert.equal(await rt.isNetDown(), true)
            assert.equal(asked, 1)
            assert.equal(typeof createCaptureRuntime({}, S0).isNetDown, 'function', '未給 netGuard 即依 settings.capture.network 建立(具 confirmDown)')
            assert.throws(() => createCaptureRuntime({ netGuard: 'x' }, S0), /cfg\.netGuard 須為網路判斷器物件/)
        })

        it('文字折疊之決定隨回傳(folds):未給／true 為內建(分群 tw→cn、線索 cn→tw)、false 皆為 null、函數兩者同用;型別錯即拋', () => {
            const d = createCaptureRuntime({ netGuard: null }, S0).folds
            assert.deepEqual([d.fold('學習'), d.clueFold('学习')], ['学习', '學習'])
            assert.deepEqual(createCaptureRuntime({ netGuard: null, conceptFold: false }, S0).folds, { fold: null, clueFold: null })
            const f = (t) => t
            assert.deepEqual(createCaptureRuntime({ netGuard: null, conceptFold: f }, S0).folds, { fold: f, clueFold: f })
            assert.throws(() => createCaptureRuntime({ netGuard: null, conceptFold: 'x' }, S0), /cfg\.conceptFold 須為/)
            setConceptFold(null)
        })

        it('詞彙:opt.vocab 給了即用之(他套件交其子集),否則用 cfg.data.vocab;領域發現之提示詞依其稱呼;opt.buildAreaPrompt 覆寫提示詞', () => {
            const a = createCaptureRuntime({ netGuard: null, data: { vocab: { domain: '天文學' } } }, S0)
            assert.equal(a.vocab.domain, '天文學')
            const b = createCaptureRuntime({ netGuard: null, data: { vocab: { domain: '天文學' } } }, S0, { vocab: { domain: '機器學習', kbLabel: 'ML 庫' } })
            assert.deepEqual([b.vocab.domain, b.vocab.kbLabel], ['機器學習', 'ML 庫'])
            assert.match(b.areaDomain.buildPrompt([{ kind: 'clue', label: 'x', clueDocs: 2 }], []), /ML 庫/)
            const c = createCaptureRuntime({ netGuard: null }, S0, { buildAreaPrompt: (cands, areas, ctx) => `自訂：${ctx.kbLabel}` })
            assert.equal(c.areaDomain.buildPrompt([], []), '自訂：知識庫')
            assert.throws(() => createCaptureRuntime({}, null), /需要解析後之 settings/)
        })

        it('抓取之 AI 席位:captureSeatsOf 回已設席位(路徑 → 席位)、CAPTURE_SEAT_LABELS 為同一組路徑之顯示名;總組裝之啟動期席位檢核即交此清單', () => {
            assert.deepEqual(captureSeatsOf(S0), { 'capture.discover.ai': S0.capture.discover.ai })
            assert.deepEqual(Object.keys(CAPTURE_SEAT_LABELS), Object.keys(captureSeatsOf(S0)))
            assert.equal(CAPTURE_SEAT_LABELS['capture.discover.ai'], '領域發現')
            assert.deepEqual(captureSeatsOf({}), {}, '未設者不列')
            // AI 用量說明(外部巡檢待辦表之 AI 欄):頻率取 capture.discover.everyHours(0＝停用),席位路徑取同一張席位表
            assert.equal(captureAiNoteOf(S0.capture), '領域發現每日至多 1 次（`capture.discover.ai`）', '預設 24 小時')
            assert.equal(captureAiNoteOf(resolveSettings({ capture: { discover: { everyHours: 12 } } }).capture), '領域發現每 12 小時至多 1 次（`capture.discover.ai`）')
            assert.equal(captureAiNoteOf(resolveSettings({ capture: { discover: { everyHours: 0 } } }).capture), '領域發現已停用（capture.discover.everyHours 0；席位 `capture.discover.ai`）')
            assert.equal(captureAiNoteOf(resolveSettings({ capture: { discover: { ai: null } } }).capture), '領域發現已停用（席位 `capture.discover.ai` 為 null）')
            const seen = []
            build({ aiAdapter: { ...stubAi, validateSeats: (s) => {
                seen.push(s)
                return { ok: true, warnings: [] }
            } } })
            assert.deepEqual(seen, [captureSeatsOf(S0)])
        })

        it('零件庫用法:capture.discover.ai 為 null 時啟動期不檢席位(validateSeats 收空表、不拋);cfg.aiOptions 透傳內建調度層之建構選項(providerPick 含未知 id 即於組裝期拋,與 ai.providerPick 同字樣);注入 aiAdapter 時 aiOptions 只驗鍵集', () => {
            // 規則:core/settingsDefault captureSeatsOf(seatsFrom 略過非物件之席位)、core/assemblyKit.buildAiAdapter 之 p.options、core/ai/adapter 之 providerPick
            const seen = []
            assert.doesNotThrow(() => build({ capture: { discover: { ai: null } }, aiAdapter: { ...stubAi, validateSeats: (s) => {
                seen.push(s)
                return { ok: true, warnings: [] }
            } } }))
            assert.deepEqual(seen, [{}])
            assert.throws(() => build({ aiAdapter: undefined, aiOptions: { providerPick: ['nope:x'] } }), /ai\.providerPick 含未知 id：nope:x/)
            assert.throws(() => build({ aiAdapter: undefined, aiOptions: { persistStore: {} } }), /createAiAdapter 之 persistStore 須為 \{ get\(\), set\(state\) \}/)
            assert.doesNotThrow(() => build({ aiAdapter: undefined, aiOptions: { providerPick: ['oc:opencode/mimo-v2.6-flash-free', 'oc:opencode/big-pickle'] } }), '可用池含預設席位之條目即過')
            assert.equal(msgOf(() => build({ aiOptions: { exe: {} } })), 'cfg.aiOptions 含不認得之鍵：exe（可用：providerPick、exes、persistStore、usageCounter）', '注入替身時仍驗鍵集')
        })
    })

    describe('info():生效值單一來源', function() {

        it('預設:目錄、集合、執行鎖與金鑰檔與 AI 工作區路徑皆自 workDir 展開(絕對路徑),未給排程上限即套件預設預算並於啟動期警告', () => {
            const wd = dirOf('info')
            const info = createKnowledgeCapture({ workDir: wd, aiAdapter: stubAi, netGuard: null }).info()
            assert.deepEqual(info.dirs, expandDirs(wd))
            assert.deepEqual(info.collections, ['docs', 'docTexts', 'sources', 'frontier', 'areas'])
            assert.equal(info.lockFile, path.resolve(`${wd}/tmp/run.lock`))
            assert.equal(info.envFile, path.resolve(`${wd}/.env`))
            assert.equal(info.aiWorkspace, null, '注入 aiAdapter 時無 AI 工作區')
            assert.equal(info.scheduleLimitMin, null)
            assert.equal(info.deadlineMs, 50 * MIN)
            assert.equal(info.lockStaleMs, 60 * MIN)
            assert.equal(info.startupWarnings.length, 1)
            assert.match(info.startupWarnings[0], /^未給 scheduleLimitMin 亦未給 deadlineMs，整輪時間預算採套件預設 50 分/)
            assert.deepEqual(info.data.seedSources, [])
            assert.deepEqual(info.data.gridTopics, [])
            assert.deepEqual(info.settings.capture.articles.skipTitlePatterns, SKIP_TITLE_PATTERNS_DEFAULT, '預設標題預篩樣式(capture.articles.skipTitlePatterns)即通用清單')
            assert.deepEqual(info.vocab, { domain: '', kbLabel: '', conceptRenames: {}, conceptAliases: {} })
            assert.equal(info.data.vocab, null, '未給詞彙覆寫')
            assert.deepEqual(info.registry.list.map((f) => f.id), ['rss', 'grid', 'article', 'links', 'browser'])
            assert.equal(typeof info.domains.area.buildPrompt, 'function')
        })

        it('路徑:workDir 之反斜線轉正斜線並去尾斜線;envFile 相對者以 workDir 為基準、絕對者原樣;lock 為字串即鎖檔路徑、false 即無鎖', () => {
            const wd = dirOf('paths')
            const win = createKnowledgeCapture({ workDir: `${wd.replace(/\//g, '\\')}\\`, aiAdapter: stubAi, netGuard: null }).info()
            assert.deepEqual(win.dirs, expandDirs(wd), '反斜線與尾斜線正規化')
            const rel = createKnowledgeCapture({ workDir: wd, aiAdapter: stubAi, netGuard: null, envFile: 'sec/.env', lock: `${wd}/x/my.lock` }).info()
            assert.equal(rel.envFile, path.resolve(`${wd}/sec/.env`))
            assert.equal(rel.lockFile, path.resolve(`${wd}/x/my.lock`))
            const abs = createKnowledgeCapture({ workDir: wd, aiAdapter: stubAi, netGuard: null, envFile: `${root}/elsewhere/.env`, lock: false }).info()
            assert.equal(abs.envFile, path.resolve(`${root}/elsewhere/.env`))
            assert.equal(abs.lockFile, null)
        })

        it('時間預算與鎖陳舊期限由排程上限推導(上限−6 分,鎖＝上限＋5 分);明給之預算或陳舊期限優先;陳舊期限小於預算加邊際者警告', () => {
            const a = build({ scheduleLimitMin: 55 }).info()
            assert.deepEqual([a.scheduleLimitMin, a.deadlineMs, a.lockStaleMs, a.startupWarnings], [55, 49 * MIN, 60 * MIN, []])
            assert.deepEqual([build({ scheduleLimitMin: '65' }).info().scheduleLimitMin, build({ scheduleLimitMin: '65' }).info().deadlineMs], [65, 59 * MIN], '數字字串取數')
            assert.equal(build({ scheduleLimitMin: 5 }).info().deadlineMs, 10 * MIN, '預算下限 10 分')
            const d = build({ deadlineMs: 20 * MIN }).info()
            assert.deepEqual([d.deadlineMs, d.lockStaleMs], [20 * MIN, 31 * MIN], '鎖＝預算＋6 分邊際＋5 分')
            const s = build({ scheduleLimitMin: 55, lockStaleMs: 10 * MIN, lock: true }).info()
            assert.equal(s.lockStaleMs, 10 * MIN)
            assert.ok(s.startupWarnings.some((w) => /cfg\.lockStaleMs（10\.0 分）小於整輪時間預算加安全邊際（55\.0 分）/.test(w)), s.startupWarnings.join('｜'))
            assert.equal(build({ scheduleLimitMin: 55, lock: false, lockStaleMs: 10 * MIN }).info().startupWarnings.length, 0, '無鎖時不警告陳舊期限')
        })

        it('時鐘:cfg.clock 原樣採用;未給依 cfg.timeZone(預設 Asia/Taipei)建立,時間戳格式固定', () => {
            assert.equal(build({ clock: FIXED_CLOCK }).info().clock, FIXED_CLOCK)
            const def = build().info().clock
            assert.equal(def.timeZone, 'Asia/Taipei')
            assert.match(def.stamp8(), /^\d{14}$/)
            assert.match(def.iso8(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/)
            assert.match(build({ timeZone: 'UTC' }).info().clock.iso8(), /\+00:00$/)
        })
    })

    describe('notes 開關與集合(openStores／closeStores,真 LMDB)', function() {

        it('預設五個集合(docs、docTexts、sources、frontier、areas);notes 預設不開;cfg.notes 為 true 或集合名才加開 notes', async () => {
            const names = async (extra) => {
                const flow = createKnowledgeCapture({ workDir: dirOf('notes'), aiAdapter: stubAi, netGuard: null, lock: false, ...extra })
                const st = flow.openStores()
                try {
                    return [Object.keys(st), flow.info().collections]
                }
                finally {
                    await flow.closeStores(st)
                }
            }
            const base = ['docs', 'docTexts', 'sources', 'frontier', 'areas']
            assert.deepEqual(await names({}), [base, base])
            assert.deepEqual(await names({ notes: false }), [base, base])
            assert.deepEqual(await names({ notes: true }), [[...base, 'notes'], [...base, 'notes']])
            assert.deepEqual(await names({ notes: 'myNotes' }), [[...base, 'notes'], [...base, 'notes']])
        })

        it('集合寫入自訂之集合名:notes 給集合名 → 資料落該名之集合、預設名之集合為空;cls 改名同理;集合可讀寫', async () => {
            const wd = dirOf('cls')
            const flow = createKnowledgeCapture({ workDir: wd, aiAdapter: stubAi, netGuard: null, lock: false, notes: 'myNotes', lmdb: { cls: { docs: 'myDocs' } } })
            assert.equal(flow.info().lmdb.cls.notes, 'myNotes')
            const st = flow.openStores()
            await st.notes.insertNew([{ id: 'n1', title: 't' }])
            await st.docs.insertNew([{ id: 'd1', url: 'https://example.com/a', status: 'new' }])
            assert.equal((await st.docs.get('d1')).url, 'https://example.com/a')
            await flow.closeStores(st)
            // 以同路徑、同庫名直接開各集合驗證落點
            const peek = async (cl) => {
                const c = W.openCollection({ WOrm: WOrmLmdb, path: `${wd}/db`, db: 'knowledge', cl })
                try {
                    return (await c.select()).map((r) => r.id)
                }
                finally {
                    await c.close()
                }
            }
            assert.deepEqual(await peek('myNotes'), ['n1'])
            assert.deepEqual(await peek('myDocs'), ['d1'])
            assert.deepEqual(await peek('notes'), [], '預設名之筆記集合不得有資料')
            assert.deepEqual(await peek('docs'), [], '預設名之文件集合不得有資料')
        })

        it('closeStores 關閉全部集合(關閉後各函數即 reject,不得靜默回空)', async () => {
            const flow = build({ notes: true })
            const st = flow.openStores()
            await flow.closeStores(st)
            for (const [name, c] of Object.entries(st)) await assert.rejects(() => c.get('x'), undefined, `${name} 關閉後之讀取應被拒`)
            await flow.closeStores(undefined)
            await flow.closeStores({})
        })

        it('openStores 中途失敗:拋出原錯誤,已開啟之集合先行關閉(不留持有檔案鎖之殘餘)', async () => {
            const closed = []
            let n = 0
            const WOrm = (o) => {
                n++
                if (n === 3) throw new Error('第三個集合開不起來')
                return { select: async () => [], selectByPk: async () => null, insert: async () => [], save: async () => {}, del: async () => {}, close: async () => { closed.push(o.cl) } }
            }
            const flow = build({ lmdb: { WOrm } })
            assert.throws(() => flow.openStores(), /第三個集合開不起來/)
            await sleep(20)
            assert.deepEqual(closed, ['docs', 'docTexts'])
        })

        it('自訂 WOrm 注入:各集合以 { url:路徑, db, cl:集合名, autoGenPk:false } 開啟(去重之主鍵一律自備)', () => {
            const calls = []
            const WOrm = (o) => {
                calls.push(o)
                return { close: async () => {} }
            }
            const wd = dirOf('worm')
            createKnowledgeCapture({ workDir: wd, aiAdapter: stubAi, netGuard: null, lock: false, notes: true, lmdb: { WOrm, db: 'mine', cls: { sources: 'src2' } } }).openStores()
            assert.deepEqual(calls, ['docs', 'docTexts', 'src2', 'frontier', 'areas', 'notes'].map((cl) => ({ url: `${wd}/db`, db: 'mine', cl, autoGenPk: false })))
        })
    })

    describe('run():以替身子階段(deps 契約、開工標記、執行摘要、收尾鉤子、鎖)', function() {

        /**
         * 探針子階段:執行當下記下 deps、開工標記、鎖檔內容與剩餘預算,並寫入一篇 noted 文件
         *
         * @param {Object} sink 輸入收集物件
         * @param {String} dir 輸入 workDir
         * @param {Object} [o={}] 輸入 { name, lockFile }
         * @returns {Object} 回傳子階段
         */
        const probe = (sink, dir, o = {}) => ({
            name: o.name || 'probe',
            run: async (ctx) => {
                sink.deps = ctx.deps
                sink.starts = findFiles(`${dir}/log`, '-run.start.json')
                sink.startBody = sink.starts[0] ? readJsonFile(sink.starts[0]) : null
                sink.lockBody = o.lockFile && fs.existsSync(o.lockFile) ? readJsonFile(o.lockFile) : null
                sink.remainingMs = ctx.remainingMs()
                sink.runs = (sink.runs || 0) + 1
                await ctx.deps.stores.docs.insertNew([{ id: `p${sink.runs}`, url: `https://example.com/p${sink.runs}`, status: 'noted', title: 't', notedAt: '2026-10-06' }])
                return stdReport({ stats: { in: 1, out: 1 }, detail: { wrote: 1 } })
            },
        })
        const boom = { name: 'boom', run: async () => {
            throw new Error('替身子階段失敗')
        } }
        const aiSpy = () => {
            const spy = { drained: 0 }
            spy.ai = { callJson: stubAi.callJson, drainStats: () => {
                spy.drained++
                return '成交 stub:x×1'
            }, aiUsageToday: () => ({ today: '', used: 1, byKey: { 'stub:x': 1 } }) }
            return spy
        }
        // 每輪一個記錄型日誌,runs[i] 為第 i 輪
        const logs = () => {
            const runs = []
            return { runs, factory: () => {
                const l = recLog()
                runs.push(l)
                return l
            } }
        }

        it('deps 契約:子階段只讀 stores／seen／registry／clock／dirs／data／vocab／settings／ai／domains／netGuard;同一輪各子階段取得同一份;stores 為五個集合;結束後集合已關閉', async () => {
            const sink = {}
            const sink2 = {}
            const dir = dirOf('deps')
            const flow = createKnowledgeCapture({ workDir: dir, aiAdapter: stubAi, netGuard: null, lock: false, stages: [probe(sink, dir), probe(sink2, dir, { name: 'probe2' })], logFactory: logs().factory })
            const rep = await flow.run()
            assert.equal(rep.ok, true)
            const d = sink.deps
            assert.equal(d, sink2.deps, '同一輪各子階段之 deps 為同一份')
            assert.deepEqual(Object.keys(d).sort(), ['ai', 'clock', 'data', 'dirs', 'domains', 'locale', 'netGuard', 'registry', 'seen', 'settings', 'siteAdapterSpecs', 'stores', 'vocab'])
            assert.deepEqual(Object.keys(d.stores), ['docs', 'docTexts', 'sources', 'frontier', 'areas'], '預設不含 notes')
            assert.deepEqual(Object.keys(d.dirs).sort(), ['db', 'knowledge', 'log', 'state', 'tmp'])
            assert.deepEqual(Object.keys(d.data).sort(), ['gridTopics', 'seedSources', 'vocab'])
            assert.deepEqual(Object.keys(d.settings).sort(), ['ai', 'capture', 'warnings'])
            assert.deepEqual(Object.keys(d.domains), ['area'])
            assert.deepEqual(Object.keys(d.vocab).sort(), ['conceptAliases', 'conceptRenames', 'domain', 'kbLabel'], '已解析之詞彙表')
            assert.equal(d.netGuard, null)
            assert.equal(d.ai, stubAi)
            assert.equal(typeof d.seen.idOf, 'function')
            assert.equal(typeof d.registry.resolve, 'function')
            assert.equal(d.clock, flow.info().clock)
            assert.equal(d.settings, flow.info().settings)
            await assert.rejects(() => d.stores.docs.get('p1'), undefined, '執行結束後集合已關閉')
        })

        it('cfg.dedup 接線:每輪 deps.seen 以其身分策略算主鍵(預設 raw:網址之 SHA-1 十六進位);asis 即自然鍵本身;函數即自訂', async () => {
            const idOf = async (dedup) => {
                const sink = {}
                await build({ ...(dedup ? { dedup } : {}), stages: [{ name: 'p', run: async (ctx) => {
                    sink.id = ctx.deps.seen.idOf('https://example.com/a')
                    sink.same = ctx.deps.seen.idOf('https://example.com/a')
                    return stdReport()
                } }] }).run()
                assert.equal(sink.id, sink.same, '同一輸入恆得同一主鍵')
                return sink.id
            }
            assert.match(await idOf(undefined), /^[0-9a-f]{40}$/)
            assert.equal(await idOf({ keyOf: 'asis' }), 'https://example.com/a')
            assert.equal(await idOf({ keyOf: (k) => `K:${k}` }), 'K:https://example.com/a')
            assert.notEqual(await idOf({ keyOf: 'raw' }), await idOf({ keyOf: 'asis' }))
        })

        it('deps 只放可列舉之普通屬性(收尾鉤子收到之 deps 即組裝所建,非 pipeline 複本):無 getter、無不可列舉屬性;notes 開啟時多一個 notes 集合', async () => {
            let seen = null
            const dir = dirOf('plain')
            const flow = createKnowledgeCapture({ workDir: dir, aiAdapter: stubAi, netGuard: null, lock: false, notes: true, stages: [probe({}, dir)], logFactory: logs().factory, afterRun: ({ deps }) => {
                seen = deps
            } })
            await flow.run()
            const desc = Object.getOwnPropertyDescriptors(seen)
            assert.deepEqual(Object.keys(desc).sort(), ['ai', 'clock', 'data', 'dirs', 'domains', 'locale', 'netGuard', 'registry', 'seen', 'settings', 'siteAdapterSpecs', 'stores', 'vocab'])
            for (const [k, dd] of Object.entries(desc)) assert.ok(dd.enumerable && 'value' in dd && !dd.get, `deps.${k} 須為可列舉之普通屬性`)
            assert.deepEqual(Object.keys(seen.stores), ['docs', 'docTexts', 'sources', 'frontier', 'areas', 'notes'])
        })

        it('開工標記:run.start.json 於子階段執行之前已落地(被砍之輪次沒有 run.json,外部巡檢逐輪判界靠它);內容為本輪上限之宣告;時間戳與日誌、摘要同一個', async () => {
            const sink = {}
            const dir = dirOf('start')
            const log = createLogger('run', { dir: `${dir}/log`, clock: FIXED_CLOCK, echo: false })
            // 排程上限取 65 分:推導之鎖陳舊期限(70 分)不同於套件預設(60 分),才分得出「持鎖者宣告值」是否取自推導
            const flow = createKnowledgeCapture({ workDir: dir, aiAdapter: stubAi, netGuard: null, clock: FIXED_CLOCK, scheduleLimitMin: 65, stages: [probe(sink, dir, { lockFile: `${dir}/tmp/run.lock` })], logFactory: () => log })
            const rep = await flow.run()
            assert.equal(sink.starts.length, 1, '子階段執行當下開工標記已存在')
            assert.equal(sink.starts[0].replace(/\\/g, '/'), `${dir}/log/20260102/20260102030405-run.start.json`)
            assert.deepEqual(sink.startBody, { pid: process.pid, startedAt: '2026-01-02T03:04:05+08:00', limitMin: 65, scheduleLimitMin: 65, deadlineMs: 59 * MIN, lockStaleMs: 70 * MIN, version: 1, stamp: '20260102030405' })
            assert.equal(rep.summaryFile.replace(/\\/g, '/'), `${dir}/log/20260102/20260102030405-run.json`)
            assert.ok(fs.existsSync(`${dir}/log/20260102/20260102030405-run.log`))
            assert.deepEqual(sink.lockBody && [sink.lockBody.pid, sink.lockBody.staleMs], [process.pid, 70 * MIN], '持鎖者宣告之陳舊期限＝info().lockStaleMs')
            assert.ok(sink.remainingMs <= 59 * MIN && sink.remainingMs > 59 * MIN - 10_000, `管線取 resolveRuntime 之預算:${sink.remainingMs}`)
        })

        it('開工標記:未給排程上限者 limitMin／scheduleLimitMin 為 null、預算採套件預設;自訂 logFactory 之 now(14 碼)作時間戳,無效者取時鐘;每輪於日誌記啟動期警告', async () => {
            const sink = {}
            const dir = dirOf('start2')
            const mk = (now) => {
                const l = recLog()
                l.now = now
                return () => l
            }
            const flow = createKnowledgeCapture({ workDir: dir, aiAdapter: stubAi, netGuard: null, lock: false, clock: FIXED_CLOCK, stages: [probe(sink, dir)], logFactory: mk('20250101010101') })
            const rep = await flow.run()
            assert.equal(sink.startBody.limitMin, null)
            assert.equal(sink.startBody.scheduleLimitMin, null)
            assert.equal(sink.startBody.deadlineMs, 50 * MIN)
            assert.equal(sink.startBody.stamp, '20250101010101')
            assert.equal(rep.summaryFile.replace(/\\/g, '/'), `${dir}/log/20250101/20250101010101-run.json`)
            for (const bad of ['', 'abc', undefined]) {
                const s = {}
                const d2 = dirOf('start3')
                await createKnowledgeCapture({ workDir: d2, aiAdapter: stubAi, netGuard: null, lock: false, clock: FIXED_CLOCK, stages: [probe(s, d2)], logFactory: mk(bad) }).run()
                assert.equal(s.startBody.stamp, '20260102030405', `now=${String(bad)} → 取時鐘`)
            }
            const lg = logs()
            const f2 = createKnowledgeCapture({ workDir: dirOf('warn'), aiAdapter: stubAi, netGuard: null, lock: false, stages: [boom], logFactory: lg.factory })
            await f2.run()
            await f2.run()
            for (const run of lg.runs) assert.ok(run.lines.some((l) => /^WARN 啟動期檢核：未給 scheduleLimitMin 亦未給 deadlineMs/.test(l)), run.lines.join('\n'))
        })

        it('執行摘要 run.json:管線名、各段與子階段 report(失敗者不被掩蓋)、時間預算、AI 實績與用量(drainStats 於輪末只取一次);日誌記子階段失敗與 AI 實績', async () => {
            const sink = {}
            const dir = dirOf('sum')
            const spy = aiSpy()
            const lg = logs()
            const flow = createKnowledgeCapture({ workDir: dir, aiAdapter: spy.ai, netGuard: null, lock: false, scheduleLimitMin: 55, clock: FIXED_CLOCK, stages: [probe(sink, dir), boom], logFactory: lg.factory })
            const rep = await flow.run()
            assert.equal(rep.ok, true, '物件 onError:continue;子階段失敗不使管線失敗')
            assert.equal(rep.lockSkipped, false)
            assert.deepEqual(rep.stages.map((s) => s.name), ['抓取'])
            const sum = readJsonFile(rep.summaryFile)
            assert.equal(sum.name, '知識抓取')
            assert.deepEqual([sum.version, sum.stamp, sum.startedAt, sum.ok, sum.lockSkipped, sum.stopped, sum.aborted, sum.deadlineMs], [1, '20260102030405', '2026-01-02T03:04:05+08:00', true, false, false, false, 49 * MIN])
            assert.equal(sum.stages[0].name, '抓取')
            assert.equal(sum.stages[0].ok, false, '有子階段失敗 → 物件 ok:false')
            assert.match(sum.stages[0].summary, /｜失敗：boom$/, '摘要不得掩蓋失敗')
            assert.equal(sum.stages[0].sub.probe.detail.wrote, 1)
            assert.equal(sum.stages[0].sub.boom.ok, false)
            assert.deepEqual(sum.ai, { usageToday: { 'stub:x': 1 }, callStats: '成交 stub:x×1' })
            assert.equal(spy.drained, 1, 'AI 實績為「取走並歸零」,只取一次(落 run.json,日誌由此轉記)')
            assert.equal(sum.standards, undefined, 'capture.standards.scanEachRun 預設 false → 不掃')
            const lines = lg.runs[0].lines
            assert.ok(lines.includes('WARN 子階段[boom] 失敗（續跑後續子階段）：替身子階段失敗'), lines.join('\n'))
            assert.ok(lines.includes('INFO AI 實績：成交 stub:x×1'))
            assert.equal(lines.some((l) => l.includes('符合度掃描')), false)
        })

        it('cfg.name 取代管線名(run.json 之 name);未給用內建名「知識抓取」', async () => {
            const dir = dirOf('pname')
            const flow = createKnowledgeCapture({ workDir: dir, aiAdapter: stubAi, netGuard: null, lock: false, clock: FIXED_CLOCK, stages: [probe({}, dir)], logFactory: () => silentLog, name: '自訂管線名' })
            assert.equal(readJsonFile((await flow.run()).summaryFile).name, '自訂管線名')
        })

        it('開工標記與執行摘要為附加產物:寫入失敗只留 warn,不影響本輪成敗與收尾(report.summaryFile 為 null)', async () => {
            const dir = dirOf('writefail')
            fs.mkdirSync(`${dir}/log`, { recursive: true })
            fs.writeFileSync(`${dir}/log/20260102`, 'x', 'utf8') // 日期子目錄之位置被檔案占住:兩者皆無法建立目錄
            const lg = logs()
            const seen = []
            const flow = createKnowledgeCapture({ workDir: dir, aiAdapter: stubAi, netGuard: null, lock: false, clock: FIXED_CLOCK, stages: [probe({}, dir)], logFactory: lg.factory, afterRun: ({ summaryFile }) => {
                seen.push(summaryFile)
            } })
            const rep = await flow.run()
            assert.equal(rep.ok, true)
            assert.equal(rep.summaryFile, null)
            assert.deepEqual(seen, [null], '收尾鉤子仍被呼叫')
            assert.ok(lg.runs[0].lines.includes('WARN 開工標記（run.start.json）寫入失敗——外部巡檢對本輪退用其他判界來源'), lg.runs[0].lines.join('\n'))
            assert.ok(lg.runs[0].lines.includes('WARN 執行摘要（run.json）寫入失敗'))
        })

        it('AI 實績為「無呼叫」時不記日誌;調度層缺 drainStats／aiUsageToday 時 run.json 之 ai 段不含該欄(介面不同不致拋)', async () => {
            const lg = logs()
            const flow = build({ stages: [boom], logFactory: lg.factory, ai: undefined, aiAdapter: { callJson: stubAi.callJson, drainStats: () => '無呼叫' } })
            const rep = await flow.run()
            assert.equal(lg.runs[0].lines.some((l) => l.includes('AI 實績')), false)
            assert.deepEqual(readJsonFile(rep.summaryFile).ai, { callStats: '無呼叫' })
        })

        it('符合度掃描(capture.standards.scanEachRun):於寫 run.json 之前跑,計數入 run.json 之 standards(涵蓋本輪子階段寫入之文件);日誌記違反;不呼叫 AI', async () => {
            const sink = {}
            const dir = dirOf('scan')
            const lg = logs()
            const flow = createKnowledgeCapture({
                workDir: dir, aiAdapter: stubAi, netGuard: null, lock: false, capture: { standards: { scanEachRun: true } },
                stages: [probe(sink, dir), { name: 'bad', run: async (ctx) => {
                    await ctx.deps.stores.areas.insertNew([{ id: 'ar1', label: '图神经网络' }])
                    return stdReport()
                } }],
                logFactory: lg.factory,
            })
            const rep = await flow.run()
            const sum = readJsonFile(rep.summaryFile)
            assert.deepEqual(Object.keys(sum.standards.counts), [...AUDITED_STANDARD_IDS])
            assert.match(sum.standards.at, /^\d{4}-\d{2}-\d{2}T/)
            assert.ok(Number.isFinite(sum.standards.ms) && sum.standards.ms >= 0)
            assert.deepEqual(sum.standards.counts.CS10, { v: 2, total: 1, violation: 0, undetermined: 1, waived: 0 }, '本輪子階段寫入之 1 篇 noted 文件(無原文)被 CS10 掃到並記未能判定')
            assert.deepEqual(sum.standards.counts.CS12, { v: 1, total: 1, violation: 1, undetermined: 0, waived: 0 })
            assert.ok(lg.runs[0].lines.some((l) => /^INFO 符合度掃描（\d+\.\ds）：違反 CS12 1$/.test(l)), lg.runs[0].lines.join('\n'))
        })

        it('符合度掃描:本輪已逾時間預算者略過(不延長本輪,日誌註明下輪補掃);掃描本身失敗只留 warn(本輪不列違反數),不影響本輪成敗與其後之摘要、收尾', async () => {
            const lg = logs()
            const slow = { name: 'slow', run: async () => {
                await sleep(40)
                return stdReport()
            } }
            const late = build({ capture: { standards: { scanEachRun: true } }, deadlineMs: 5, stages: [slow], logFactory: lg.factory })
            const r1 = await late.run()
            assert.ok(lg.runs[0].lines.includes('INFO 符合度掃描：本輪已逾時間預算，略過（下輪補掃）'), lg.runs[0].lines.join('\n'))
            assert.equal(readJsonFile(r1.summaryFile).standards, undefined)
            // 掃描失敗:子階段把 docs.select 弄壞(掃描與子階段共用同一組集合)
            const lg2 = logs()
            const after = []
            const broken = build({
                capture: { standards: { scanEachRun: true } },
                stages: [{ name: 'breaker', run: async (ctx) => {
                    ctx.deps.stores.docs.select = async () => {
                        throw new Error('讀取壞了')
                    }
                    return stdReport()
                } }],
                logFactory: lg2.factory,
                afterRun: ({ summaryFile }) => {
                    after.push(summaryFile)
                },
            })
            const r2 = await broken.run()
            assert.equal(r2.ok, true)
            assert.ok(lg2.runs[0].lines.includes('WARN 符合度掃描失敗：讀取壞了（本輪不列違反數）'), lg2.runs[0].lines.join('\n'))
            assert.equal(readJsonFile(r2.summaryFile).standards, undefined)
            assert.deepEqual(after, [r2.summaryFile], '掃描失敗不影響其後之收尾')
        })

        it('收尾鉤子:在 run.json 之後呼叫({ report, summaryFile, log, deps });回傳值掛 report.afterRun;符合度掃描之計數已在 run.json(掃描→摘要→收尾之序)', async () => {
            const order = []
            const sink = {}
            const dir = dirOf('after')
            const args = []
            const flow = createKnowledgeCapture({
                workDir: dir, aiAdapter: stubAi, netGuard: null, lock: false, capture: { standards: { scanEachRun: true } },
                stages: [{ ...probe(sink, dir), run: async (ctx) => {
                    order.push('stage')
                    return probe(sink, dir).run(ctx)
                } }],
                logFactory: logs().factory,
                afterRun: async (x) => {
                    order.push('afterRun')
                    args.push(x)
                    const sum = fs.existsSync(x.summaryFile) ? readJsonFile(x.summaryFile) : null
                    return { ok: true, sawSummary: !!sum, sawStandards: !!sum?.standards, sawStage: sum?.stages?.[0]?.name }
                },
            })
            const rep = await flow.run()
            assert.deepEqual(order, ['stage', 'afterRun'])
            assert.deepEqual(Object.keys(args[0]).sort(), ['deps', 'log', 'report', 'summaryFile'])
            assert.equal(args[0].summaryFile, rep.summaryFile)
            assert.equal(args[0].report, rep, '收尾鉤子收到之 report 即回傳者')
            assert.deepEqual(rep.afterRun, { ok: true, sawSummary: true, sawStandards: true, sawStage: '抓取' })
        })

        it('收尾鉤子之結果分完成／略過／失敗三態記日誌;報告取得失敗不影響本輪;鉤子拋錯 → report.afterRun 記 { ok:false, error }、warn,本輪仍成功', async () => {
            const cases = [
                [{ ok: false, error: '寫檔失敗' }, /^WARN 收尾失敗：寫檔失敗（[\d.]+s；管線本身不受影響）$/],
                [{ ok: true, skipped: 'locked', message: '另一巡檢進行中' }, /^WARN 收尾略過：另一巡檢進行中（[\d.]+s）$/],
                [{ ok: true, skipped: 'x' }, /^WARN 收尾略過：x（[\d.]+s）$/],
                [{ ok: true }, /^INFO 收尾完成（[\d.]+s）$/],
                [undefined, /^INFO 收尾完成（[\d.]+s）$/],
            ]
            for (const [ret, re] of cases) {
                const lg = logs()
                const rep = await build({ stages: [boom], logFactory: lg.factory, afterRun: () => ret }).run()
                assert.equal(rep.afterRun, ret, 'report.afterRun 為收尾鉤子之回傳值')
                assert.ok(lg.runs[0].lines.some((l) => re.test(l)), `${JSON.stringify(ret)}:\n${lg.runs[0].lines.join('\n')}`)
            }
            const lg = logs()
            const rep = await build({ stages: [boom], logFactory: lg.factory, afterRun: () => {
                throw new Error('鉤子壞了')
            } }).run()
            assert.equal(rep.ok, true, '收尾失敗不影響本輪成敗')
            assert.deepEqual(rep.afterRun, { ok: false, error: '鉤子壞了' })
            assert.ok(lg.runs[0].lines.includes('WARN 收尾鉤子拋錯：鉤子壞了'))
            assert.ok(fs.existsSync(rep.summaryFile), 'run.json 已先落地')
        })

        it('afterRun 為 false 或未給:無收尾(report 無 afterRun 欄);非同步鉤子被等候後才回傳', async () => {
            for (const extra of [{}, { afterRun: false }]) {
                const rep = await build({ stages: [boom], ...extra }).run()
                assert.equal('afterRun' in rep, false)
            }
            let done = false
            const rep = await build({ stages: [boom], afterRun: async () => {
                await sleep(60)
                done = true
                return { ok: true }
            } }).run()
            assert.equal(done, true, 'run() 等候收尾完成')
            assert.deepEqual(rep.afterRun, { ok: true })
        })

        it('執行鎖:取得者執行並於結束釋放鎖檔;鎖被占用 → 本輪略過(lockSkipped,不跑子階段、不掃描、不寫 run.json、不收尾);釋放後下一輪照常', async () => {
            const sink = {}
            const dir = dirOf('lock')
            const after = []
            const lg = logs()
            const flow = createKnowledgeCapture({ workDir: dir, aiAdapter: stubAi, netGuard: null, capture: { standards: { scanEachRun: true } }, stages: [probe(sink, dir)], logFactory: lg.factory, afterRun: (x) => {
                after.push(x.summaryFile)
            } })
            const lockFile = flow.info().lockFile
            const held = acquireLock(lockFile, { staleMs: 3_600_000 })
            assert.equal(held.ok, true)
            const skipped = await flow.run()
            held.release()
            assert.equal(skipped.lockSkipped, true)
            assert.match(skipped.stopReason, /^本行程已持有此鎖（/)
            assert.deepEqual([sink.runs, after, skipped.summaryFile, findFiles(`${dir}/log`, '-run.json')], [undefined, [], undefined, []])
            assert.ok(lg.runs[0].lines.some((l) => /^WARN 管道\[知識抓取\] 略過本輪：本行程已持有此鎖/.test(l)), lg.runs[0].lines.join('\n'))
            const ok = await flow.run()
            assert.equal(ok.lockSkipped, false)
            assert.equal(sink.runs, 1)
            assert.deepEqual(after, [ok.summaryFile])
            assert.equal(fs.existsSync(lockFile), false, '執行結束已釋放鎖')
        })

        it('同一 flow 並發兩次 run():恰一輪執行、另一輪略過(同一行程亦互斥,不讓兩條管線同時寫同一個資料庫);lock:false 則皆執行', async () => {
            const slow = (sink) => ({ name: 'slow', run: async () => {
                sink.n = (sink.n || 0) + 1
                await sleep(150)
                return stdReport()
            } })
            const s1 = {}
            const f1 = build({ lock: true, stages: [slow(s1)] })
            const [a, b] = await Promise.all([f1.run(), f1.run()])
            assert.deepEqual([a, b].map((r) => !!r.lockSkipped).sort(), [false, true])
            assert.equal(s1.n, 1)
            const s2 = {}
            const f2 = build({ lock: false, stages: [slow(s2)] })
            const both = await Promise.all([f2.run(), f2.run()])
            assert.deepEqual(both.map((r) => !!r.lockSkipped), [false, false])
            assert.equal(s2.n, 2)
        })

        it('連續兩輪:集合每輪重開(前一輪結束已關閉),資料跨輪保存;各輪之 run.json 各一份', async () => {
            const dir = dirOf('twice')
            const seen = []
            const flow = createKnowledgeCapture({ workDir: dir, aiAdapter: stubAi, netGuard: null, lock: false, stages: [{ name: 'count', run: async (ctx) => {
                const rows = await ctx.deps.stores.docs.select()
                seen.push(rows.length)
                await ctx.deps.stores.docs.insertNew([{ id: `d${rows.length}`, url: `https://example.com/${rows.length}`, status: 'new' }])
                return stdReport()
            } }], logFactory: logs().factory })
            const r1 = await flow.run()
            await sleep(1100)
            const r2 = await flow.run()
            assert.deepEqual(seen, [0, 1])
            assert.notEqual(r1.summaryFile, r2.summaryFile)
            assert.equal(findFiles(`${dir}/log`, '-run.json').length, 2)
        })

        it('預設日誌工廠:每輪一檔 log/<日>/<時間戳>-run.log,日誌行含層級與時間;與開工標記、摘要同一時間戳', async () => {
            const dir = dirOf('deflog')
            const orig = console.log
            console.log = () => {} // 預設日誌同時輸出 stdout:測試中靜音
            let rep
            try {
                rep = await createKnowledgeCapture({ workDir: dir, aiAdapter: stubAi, netGuard: null, lock: false, clock: FIXED_CLOCK, stages: [boom] }).run()
            }
            finally {
                console.log = orig
            }
            const logFile = `${dir}/log/20260102/20260102030405-run.log`
            assert.ok(fs.existsSync(logFile))
            const text = fs.readFileSync(logFile, 'utf8')
            assert.match(text, /^\[2026-01-02T03:04:05\+08:00\] WARN\s+啟動期檢核：未給 scheduleLimitMin/m)
            assert.match(text, /WARN\s+子階段\[boom\] 失敗（續跑後續子階段）：替身子階段失敗/)
            assert.deepEqual(findFiles(`${dir}/log`, '-run.start.json').map((f) => path.basename(f)), ['20260102030405-run.start.json'])
            assert.equal(path.basename(rep.summaryFile), '20260102030405-run.json')
        })
    })

    describe('AI 調度層接線(內建調度層;指向死埠,不連外網)', function() {

        const KEY_VAR = 'CAPTURE_ASSEMBLY_KEY_8830'
        const keyed = (extra = {}) => ({
            ai: { extraProviders: [{ id: 't:keyed', kind: 'api-openai-compat', baseURL: DEAD_BASE, model: 'm', envVar: KEY_VAR }] },
            capture: { discover: { ai: { use: 't:keyed' } } },
            ...extra,
        })

        it('金鑰檔:預設 <workDir>/.env;envFile 相對者以 workDir 為基準、絕對者原樣;缺金鑰之席位於建構期拋錯(附變數名);金鑰不進 process.env', () => {
            const wd = dirOf('env')
            assert.equal(process.env[KEY_VAR], undefined, '前提:環境變數未設')
            assert.throws(() => createKnowledgeCapture({ workDir: wd, netGuard: null, lock: false, ...keyed() }), new RegExp(`缺金鑰 ${KEY_VAR}`))
            fs.mkdirSync(wd, { recursive: true })
            fs.writeFileSync(`${wd}/.env`, `${KEY_VAR}=k1\n`, 'utf8')
            const f1 = createKnowledgeCapture({ workDir: wd, netGuard: null, lock: false, ...keyed() })
            assert.deepEqual(f1.info().ai.chainFor({ use: 't:keyed' })[0].keys, ['k1'])
            fs.mkdirSync(`${wd}/sec`, { recursive: true })
            fs.writeFileSync(`${wd}/sec/.env`, `${KEY_VAR}=a1,a2\n`, 'utf8')
            const f2 = createKnowledgeCapture({ workDir: wd, netGuard: null, lock: false, envFile: 'sec/.env', ...keyed() })
            assert.deepEqual(f2.info().ai.chainFor({ use: 't:keyed' })[0].keys, ['a1', 'a2'])
            fs.mkdirSync(`${root}/abs-env`, { recursive: true })
            fs.writeFileSync(`${root}/abs-env/k.env`, `${KEY_VAR}=z9\n`, 'utf8')
            const f3 = createKnowledgeCapture({ workDir: dirOf('env2'), netGuard: null, lock: false, envFile: `${root}/abs-env/k.env`, ...keyed() })
            assert.deepEqual(f3.info().ai.chainFor({ use: 't:keyed' })[0].keys, ['z9'])
            assert.equal(process.env[KEY_VAR], undefined, '金鑰檔之值不污染 process.env')
        })

        it('設定接線:ai.timeoutMs／providerTimeouts 進調度層之逾時三層;席位 capture.discover.ai 為啟動期檢核之對象、呼叫時由領域發現以 spec 傳入;AI 工作區預設 <workDir>/tmp/ai-workspace、可改且於第一次呼叫前建立', async () => {
            const wd = dirOf('wire')
            const flow = createKnowledgeCapture({
                workDir: wd, netGuard: null, lock: false,
                ai: { timeoutMs: 1234, providerTimeouts: { 't:own': 4321 }, extraProviders: [{ id: 't:plain', kind: 'api-openai-compat', baseURL: DEAD_BASE, model: 'm' }, { id: 't:own', kind: 'api-openai-compat', baseURL: DEAD_BASE, model: 'm' }] },
                capture: { discover: { ai: { use: 't:plain', fallback: ['t:own'] } } },
            })
            const info = flow.info()
            const seat = info.settings.capture.discover.ai
            assert.deepEqual(info.ai.chainFor(seat).map((e) => [e.id, e.timeoutMs]), [['t:plain', 1234], ['t:own', 4321]])
            assert.equal(info.aiWorkspace, path.resolve(`${wd}/tmp/ai-workspace`))
            assert.equal(fs.existsSync(info.aiWorkspace), false, '建構不建目錄')
            const r = await info.ai.callJson('q', () => true, { spec: seat, minAttemptMs: 10 })
            assert.equal(r.ok, false, '死埠:連線被拒')
            assert.match(r.errors[0], /^t:plain:fetch\(/)
            assert.equal(fs.existsSync(info.aiWorkspace), true, '第一次呼叫前建立工作區')
            const noSeat = await info.ai.callJson('q', () => true)
            assert.deepEqual([noSeat.ok, noSeat.attempts, noSeat.error.startsWith('席位無法解析：')], [false, 0, true], '調度層無隱含預設席位:呼叫端須自帶 spec(領域發現傳 settings.capture.discover.ai)')
            const ws = `${root}/custom-ws`
            const plain = { ai: { extraProviders: [{ id: 't:plain', kind: 'api-openai-compat', baseURL: DEAD_BASE, model: 'm' }] }, capture: { discover: { ai: { use: 't:plain' } } } }
            const f2 = createKnowledgeCapture({ workDir: dirOf('wire2'), netGuard: null, lock: false, aiWorkspace: ws, ...plain })
            assert.equal(f2.info().aiWorkspace, path.resolve(ws))
            await f2.info().ai.callJson('q', () => true, { spec: f2.info().settings.capture.discover.ai })
            assert.equal(fs.existsSync(ws), true)
        })

        it('本機網路判斷接線:給 netGuard 物件(具 confirmDown)者,調度層整鏈皆敗時詢問之 → 不通即 skipped;netGuard 為 null 或不具 confirmDown 者不詢問', async () => {
            const wire = { ai: { extraProviders: [{ id: 't:dead', kind: 'api-openai-compat', baseURL: DEAD_BASE, model: 'm' }] }, capture: { discover: { ai: { use: 't:dead' } } } }
            const spec = { use: 't:dead' }
            let asked = 0
            const guard = { check: async () => ({ up: false, detail: [] }), confirmDown: async () => {
                asked++
                return true
            }, isDown: () => true, describe: () => '' }
            const down = createKnowledgeCapture({ workDir: dirOf('net'), netGuard: guard, lock: false, ...wire })
            const r = await down.info().ai.callJson('q', () => true, { spec })
            assert.deepEqual([r.ok, r.skipped, asked], [false, true, 1])
            assert.match(r.error, /^本機網路不通（不計此次之失敗）：/)
            for (const ng of [null, { check: async () => ({ up: true }) }]) {
                const r2 = await createKnowledgeCapture({ workDir: dirOf('net'), netGuard: ng, lock: false, ...wire }).info().ai.callJson('q', () => true, { spec })
                assert.deepEqual([r2.ok, r2.skipped], [false, false], `netGuard=${ng === null ? 'null' : '無 confirmDown'}`)
            }
            assert.equal(asked, 1)
        })

        it('時鐘接線:cfg.clock 同時供調度層之「今日」用量分日', () => {
            const flow = createKnowledgeCapture({ workDir: dirOf('clk'), netGuard: null, lock: false, clock: FIXED_CLOCK })
            assert.equal(flow.info().ai.aiUsageToday().today, '2026-01-02')
        })
    })
})
