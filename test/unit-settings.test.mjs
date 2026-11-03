// unit-settings.test.mjs — 設定預設與解析(core/settingsDefault):預設值通用、逐鍵覆寫、設定錯誤一律拋錯並列可用鍵、席位鍵檢核、實例互不汙染
// 規則(出自 settingsDefault 之設計):
//   ①預設值領域中立,不綁任何主題;領域發現之預設席位(capture.discover.ai)全為免費模型,付費家由安裝方加於遞補尾
//   ②設定只有兩段 ai、capture;capture 依抓取三要點分組(sources／articles／browser／network／areas／expand／discover／services／standards)。
//     組(物件節點)逐鍵遞迴合併:只給想調的鍵、其餘沿用預設;葉(席位、樣式陣列、函數、逾時對照)給了即整個取代,不逐層合併
//   ③設定錯誤一律啟動期拋錯(不認得之鍵、型別或值域不符、組形狀錯),訊息列出可用鍵與完整路徑;絕不靜默改用預設;鍵須放所屬組內(放到 capture 頂層之扁平鍵一律被拒,無相容層)
//   ④各實例拿到之設定互不共用預設常數之參照,某實例就地修改不汙染同行程之他實例
// 執行:自套件根 npx mocha test/unit-settings.test.mjs(純函數與讀檔掃描,不連網、不寫檔)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    CAPTURE_DEFAULT, AI_DEFAULT, SKIP_TITLE_PATTERNS_DEFAULT,
    SEAT_KEYS, seatProblem, SETTING_TYPES, CAPTURE_SCHEMA, AI_SCHEMA, resolveSettings, resolveCaptureSettings, captureSeatsOf,
} from '../src/core/settingsDefault.mjs'
import { VOCAB_DEFAULT, kbLabelOf } from '../src/core/vocab/vocabDefault.mjs'
import { createAreaDomain } from '../src/domain/areaDomain.mjs'
import { domainTermsIn } from './tools/domainTerms.mjs'
import { msgOf } from './tools/testKit.mjs'

// 套件根(以本檔位置定,不依 cwd)
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 兩段之 [段名, schema, 預設常數]
const SECTIONS = [
    ['ai', AI_SCHEMA, AI_DEFAULT],
    ['capture', CAPTURE_SCHEMA, CAPTURE_DEFAULT],
]

/**
 * 序列化供比對:函數以原始碼、RegExp 以樣式與旗標表示(JSON 本身不認得它們),undefined 亦保留
 *
 * @param {*} v 輸入任意值
 * @returns {String} 回傳序列化字串
 */
const snap = (v) => JSON.stringify(v, (k, x) => {
    if (typeof x === 'function') return `fn:${x.toString()}`
    if (x instanceof RegExp) return `re:${x.source}/${x.flags}`
    return x === undefined ? '__undefined__' : x
})

/**
 * schema 之全部葉(型別名為字串者):路徑、型別、預設值
 *
 * @param {Object} schema 輸入 schema(鍵 → 型別名或子組 schema)
 * @param {Object} dflt 輸入同形之預設值
 * @param {Array} [prefix=[]] 輸入路徑前綴
 * @returns {Array} 回傳 [{ path:Array, type:String, dflt:* }]
 */
function leavesOf(schema, dflt, prefix = []) {
    const out = []
    for (const [k, node] of Object.entries(schema)) {
        if (typeof node === 'string') out.push({ path: [...prefix, k], type: node, dflt: dflt?.[k] })
        else out.push(...leavesOf(node, dflt?.[k], [...prefix, k]))
    }
    return out
}

/**
 * schema 之全部組(含根;物件節點):路徑與其 schema、預設值
 *
 * @param {Object} schema 輸入 schema
 * @param {Object} dflt 輸入同形之預設值
 * @param {Array} [prefix=[]] 輸入路徑前綴
 * @returns {Array} 回傳 [{ path:Array, schema:Object, dflt:Object }](根在最前)
 */
function groupsOf(schema, dflt, prefix = []) {
    const out = [{ path: prefix, schema, dflt }]
    for (const [k, node] of Object.entries(schema)) {
        if (typeof node !== 'string') out.push(...groupsOf(node, dflt?.[k], [...prefix, k]))
    }
    return out
}

/**
 * 由路徑與值組出巢狀覆寫物件(['capture','sources','perRun'], 9 → { capture: { sources: { perRun: 9 } } })
 *
 * @param {Array} p 輸入路徑
 * @param {*} value 輸入葉值
 * @returns {Object} 回傳巢狀物件
 */
const nest = (p, value) => p.reduceRight((acc, k) => ({ [k]: acc }), value)

/**
 * 依路徑取值
 *
 * @param {Object} obj 輸入物件
 * @param {Array} p 輸入路徑
 * @returns {*} 回傳該路徑之值(中途缺即 undefined)
 */
const getAt = (obj, p) => p.reduce((o, k) => o?.[k], obj)

// 特定產業領域之詞彙(中英)與命中函數取 test/tools/domainTerms(四套件同一份;測試檔不在中立掃描之列)
const termsIn = domainTermsIn

// 各型別之邊界樣本:valid 為合格值(逐鍵覆寫取與預設不同者)、invalid 為不合格值;新增型別未補樣本即失敗(迫使邊界被列舉)
const SAMPLES = {
    pint: { valid: [7, 8], invalid: [0, -1, 1.5, '5', NaN, null, Infinity] },
    p0int: { valid: [7, 8], invalid: [-1, 1.5, '5', NaN, null] },
    p0num: { valid: [0.5, 2.5], invalid: [-0.1, '1', NaN, Infinity, null] },
    ratio: { valid: [0.5, 0.3], invalid: [1.5, -0.1, '0.5', NaN, null] },
    bool: { valid: [true, false], invalid: ['true', 1, 0, null] },
    str: { valid: ['custom', 'custom2'], invalid: [1, null, ['x']] },
    // 環境變數名(金鑰檔之 KEY=value 之 KEY;只認英數與底線):空字串合格(＝不使用);非字串、含連字號／空白／點者不合
    envName: { valid: ['CUSTOM_KEY', 'KEY2'], invalid: [1, null, ['x'], 'a-b', 'a b', 'a.b'] },
    strArr: { valid: [['a'], ['b', 'c']], invalid: ['a', [1], [null], null, {}] },
    strArrOrNull: { valid: [['a'], null], invalid: ['a', [1], {}, 0] },
    // 健全閘偵測器陣列或 null:非空陣列、每項 { id 唯一, kind 為健全閘類別, test 函數 };空陣列不合(整組取代之語意)、kind 不在類別不合、缺 test 不合
    detectorsOrNull: { valid: [null, [{ id: 'x', kind: 'paywall', test: () => null }]], invalid: ['a', [], [{ id: 'x', kind: 'paywall' }], [{ id: 'x', kind: 'wall', test: () => null }], [{ id: 'x', kind: 'paywall', test: () => null }, { id: 'x', kind: 'paywall', test: () => null }], {}, 0] },
    objArr: { valid: [[{ id: 'x' }], [{ a: 1 }, { b: 2 }]], invalid: [{}, [1], ['x'], 'x', null] },
    fn: { valid: [() => 'custom'], invalid: ['x', null, {}, 1] },
    patterns: { valid: [[/custom/i], [{ p: 'custom', f: 'i' }], [{ p: 'custom' }]], invalid: [['x'], [{ f: 'i' }], [{ p: 'x', f: 1 }], [null], 'x', null] },
    timeouts: { valid: [{ 'x:y': 1000 }], invalid: [{ a: 0 }, { a: 1.5 }, { a: '5' }, [], 'x', null] },
    seat: {
        valid: [{ use: 'x:y' }, { use: 'x:y', fallback: ['a:b'], timeoutMs: 1 }],
        invalid: ['x', {}, { use: '' }, { use: 'a', typo: 1 }, { use: 'a', fallback: 'b' }, { use: 'a', fallback: [1] }, { use: 'a', timeoutMs: 0 }, null],
    },
    // 領域發現席位 capture.discover.ai 用之(null＝無席位、不發現);下游套件之「沿用另一席位」亦用
    seatOrNull: {
        valid: [{ use: 'x:y' }, null, { use: 'x:y', fallback: ['a:b'], budgetMs: 1 }],
        invalid: ['x', {}, { use: '' }, { use: 'a', typo: 1 }, { use: 'a', fallback: 'b' }, { use: 'a', timeoutMs: 0 }, 0, false],
    },
    pools: {
        valid: [{ oc: { log: 'x:/logs/opencode.log', resetUtcHour: 0 } }, { oc: { log: 'auto', resetUtcHour: 23 } }, { oc: {} }, {}],
        invalid: [
            'x', null, [], 1, { oc: 'auto' }, { oc: null }, { oc: [] }, { other: {} }, { oc: {}, other: {} }, { oc: { log: '' } }, { oc: { log: 1 } },
            { oc: { resetUtcHour: 24 } }, { oc: { resetUtcHour: -1 } }, { oc: { resetUtcHour: 1.5 } }, { oc: { resetUtcHour: '0' } }, { oc: { typo: 1 } },
        ],
    },
    limits: { valid: [{ 'x:y': 30000 }, { 'x:y': 0 }, {}], invalid: [{ a: -1 }, { a: 1.5 }, { a: '5' }, { a: null }, [], 'x', null] },
}

// 全部葉與全部組(兩段合計;路徑含段名)
const LEAVES = SECTIONS.flatMap(([name, schema, dflt]) => leavesOf(schema, dflt, [name]))
const GROUPS = SECTIONS.flatMap(([name, schema, dflt]) => groupsOf(schema, dflt, [name]))

describe('unit-settings', function() {

    describe('預設值', function() {

        it('回傳 ai、capture 兩段加 warnings;warnings 恆為空陣列且每次為新陣列(抓取各鍵目前無跨鍵之自洽條件)', () => {
            const s = resolveSettings({})
            assert.deepEqual(Object.keys(s), ['ai', 'capture', 'warnings'])
            assert.deepEqual(s.warnings, [])
            assert.notEqual(s.warnings, resolveSettings({}).warnings)
            assert.equal(snap(resolveSettings()), snap(s), '未給 cfg 與給 {} 相同')
        })

        it('capture 依抓取三要點分組:sources／articles／browser／network(要點 1)、areas(要點 2)、expand／discover(要點 3)、services(共用)、standards(檢定標準)', () => {
            assert.deepEqual(Object.keys(CAPTURE_DEFAULT), ['sources', 'articles', 'browser', 'network', 'areas', 'expand', 'discover', 'services', 'standards'])
            assert.deepEqual(Object.keys(CAPTURE_SCHEMA), Object.keys(CAPTURE_DEFAULT))
            assert.deepEqual(Object.keys(AI_DEFAULT).sort(), ['cooldownMs', 'extraProviders', 'healthStreak', 'maxRetries', 'pools', 'providerLimits', 'providerTimeouts', 'timeoutMs'])
        })

        it('預設與 schema 之鍵集逐組一致,且每個預設值本身通過所屬型別之判準(否則安裝方原樣回填預設值即被拒)', () => {
            for (const g of GROUPS) {
                assert.deepEqual(Object.keys(g.dflt).sort(), Object.keys(g.schema).sort(), `${g.path.join('.')}:預設鍵集應等於 schema 鍵集(schema 之鍵集即可用鍵)`)
            }
            for (const l of LEAVES) {
                assert.ok(SETTING_TYPES[l.type], `${l.path.join('.')}:schema 指名之型別「${l.type}」須在 SETTING_TYPES`)
                assert.ok(SETTING_TYPES[l.type].test(l.dflt), `${l.path.join('.')} 之預設值須合型別「${l.type}」`)
            }
        })

        it('領域中立與保守預設:領域過濾預設不限;會掃描整機行程之瀏覽器回收與每輪符合度掃描預設關閉;Camofox 預設埠避開 w-fetch-web 之預設 19377', () => {
            const c = resolveSettings({}).capture
            assert.equal(c.areas.openAlexFields, '', '網格之領域過濾預設不限(主題範圍由安裝方給)')
            assert.deepEqual(c.areas.arxivCategories, [], '網格遞補之 arXiv 類別預設不限(空陣列,與線索探測之類別各自獨立)')
            assert.deepEqual(c.expand.arxivCategories, [], '線索探測之 arXiv 類別預設不限')
            assert.equal(c.browser.hygiene, false, '會掃描整台機器之行程,套件預設關閉')
            assert.equal(c.standards.scanEachRun, false, '掃描讀全部文件,大庫耗時,預設關閉')
            assert.notEqual(c.browser.camofox.port, 19377, '同埠並行會借用彼此之 server 而互殺')
            assert.equal(c.services.openAlex.mailto, '', '信箱預設不帶')
            assert.equal(c.network.probeUrls, null, '探測端點預設取 services 三個端點基底之原點')
        })

        it('免費 AI 為主:領域發現之預設席位(capture.discover.ai)全為 oc:(opencode 免費模型),不含付費家(claude:／codex:／agy:),且形狀合席位檢核', () => {
            const seat = resolveSettings({}).capture.discover.ai
            assert.equal(seatProblem(seat), '')
            const ids = [seat.use, ...(seat.fallback || [])]
            assert.ok(ids.length >= 2, '同家不重試(maxRetries 0),韌性由換家提供:預設席位須有遞補')
            assert.equal(AI_DEFAULT.maxRetries, 0)
            for (const id of ids) {
                assert.ok(id.startsWith('oc:'), `${id} 應為 opencode 條目`)
                assert.ok(!/^(claude|codex|agy):/.test(id), `${id} 不得為付費家`)
            }
        })

        it('ai 段不含席位(領域發現之席位在 capture.discover.ai):ai 段給 area 鍵被拒,訊息列出 ai 段可用之鍵', () => {
            assert.equal(('area' in resolveSettings({}).ai), false)
            assert.equal(msgOf(() => resolveSettings({ ai: { area: { use: 'oc:x' } } })), `settings.ai 含不認得之鍵：area（可用：${Object.keys(AI_SCHEMA).join('、')}）`)
        })

        it('預設設定、詞彙預設與預設領域提示詞不含特定產業領域之詞彙——預設為任意知識之抓取而設', () => {
            // 正向對照:掃描器須真能抓到(否則清單為空時此測試恆過;詞表之完整自檢在 unit-domain-terms)
            assert.deepEqual(termsIn('前 量化 後'), ['量化'])
            assert.deepEqual(termsIn('a bitcoin b'), ['bitcoin'])
            assert.deepEqual(termsIn('a quantum and portfoliography b'), [], '詞界:quantum、portfoliography 不誤判')
            const dom = createAreaDomain({})
            const prompt = dom.buildPrompt(
                [{ label: 'Protein folding', kind: 'concept', support: 30, growth: 1.2, samples: [{ title: 'A study of folding' }] }, { label: 'Chaos theory', kind: 'clue', clueDocs: 3 }],
                [{ label: 'Graph learning', query: 'graph neural networks' }],
            )
            const targets = {
                settings: snap(resolveSettings({})),
                skipTitlePatterns: snap(SKIP_TITLE_PATTERNS_DEFAULT),
                vocab: snap(VOCAB_DEFAULT),
                kbLabel: kbLabelOf(VOCAB_DEFAULT),
                prompt,
            }
            for (const [name, text] of Object.entries(targets)) assert.deepEqual(termsIn(text), [], `${name} 含領域詞彙`)
        })

        it('定義預設之原始碼(含註解)不含領域詞彙:設定預設、詞彙預設、領域提示詞', () => {
            for (const f of ['core/settingsDefault.mjs', 'core/vocab/vocabDefault.mjs', 'domain/areaDomain.mjs']) {
                const hit = termsIn(fs.readFileSync(path.join(PKG, 'src', f), 'utf8'))
                assert.deepEqual(hit, [], `${f} 含領域詞彙(註解範例亦須中立)`)
            }
        })

        it('預設詞彙通用:主題範圍與稱呼皆空、無概念改名與別名;稱呼由主題範圍推導', () => {
            assert.deepEqual(VOCAB_DEFAULT, { domain: '', kbLabel: '', conceptRenames: {}, conceptAliases: {} })
            assert.equal(kbLabelOf(VOCAB_DEFAULT), '知識庫')
            assert.equal(kbLabelOf({ domain: '機器學習' }), '「機器學習」知識庫')
            assert.equal(kbLabelOf({ domain: '機器學習', kbLabel: '研究庫' }), '研究庫', 'kbLabel 優先')
        })

        it('標題預篩之預設樣式(capture.articles.skipTitlePatterns)為通用彙整頁:{p,f} 形式可編譯並通過 patterns 型別判準;命中彙整貼文標題、不誤殺一般文章標題', () => {
            assert.ok(SETTING_TYPES.patterns.test(SKIP_TITLE_PATTERNS_DEFAULT))
            assert.equal(snap(resolveSettings({}).capture.articles.skipTitlePatterns), snap(SKIP_TITLE_PATTERNS_DEFAULT), '預設設定即通用樣式')
            const res = SKIP_TITLE_PATTERNS_DEFAULT.map((x) => new RegExp(x.p, x.f || ''))
            const skip = (t) => res.some((r) => r.test(t))
            for (const t of ['Recent Reading Links', 'Weekly Roundup #12', 'Reading Digest', 'Newsletter weekly #48', 'Morning roundup 2']) assert.ok(skip(t), `${t} 應判為彙整貼文`)
            for (const t of ['Attention Is All You Need', 'A new method for protein folding', 'How digestion works', 'The weekly cycle of a pulsar']) assert.ok(!skip(t), `${t} 不應判為彙整貼文`)
        })
    })

    describe('逐鍵覆寫(兩段 × 全部葉)', function() {

        for (const [name, schema, dflt] of SECTIONS) {
            it(`${name}:每個葉逐一覆寫 → 該葉取給定值,其餘全部葉(含同組與他段)維持預設`, () => {
                const base = resolveSettings({})
                const mine = leavesOf(schema, dflt, [name])
                for (const leaf of mine) {
                    const spec = SAMPLES[leaf.type]
                    assert.ok(spec, `${leaf.path.join('.')}:型別「${leaf.type}」缺邊界樣本(新增型別須補 SAMPLES)`)
                    const sample = spec.valid.find((v) => snap(v) !== snap(leaf.dflt))
                    assert.notEqual(sample, undefined, `${leaf.path.join('.')}:找不到與預設不同之合格樣本`)
                    const r = resolveSettings(nest(leaf.path, sample))
                    assert.equal(snap(getAt(r, leaf.path)), snap(sample), `${leaf.path.join('.')} 應取給定值`)
                    for (const other of LEAVES) {
                        if (other.path.join('.') !== leaf.path.join('.')) assert.equal(snap(getAt(r, other.path)), snap(getAt(base, other.path)), `${other.path.join('.')} 不應受 ${leaf.path.join('.')} 影響`)
                    }
                }
            })
        }

        it('兩段同時覆寫(含多組):互不干擾;未給之鍵沿用預設', () => {
            const r = resolveSettings({
                capture: {
                    sources: { perRun: 9, lowYieldRate: 0.25 },
                    areas: { arxivCategories: ['cs.LG'] },
                    standards: { scanEachRun: true },
                },
                ai: { cooldownMs: 0, providerTimeouts: { 'oc:x': 1000 } },
            })
            assert.deepEqual([r.capture.sources.perRun, r.capture.sources.itemsPerSource], [9, CAPTURE_DEFAULT.sources.itemsPerSource])
            assert.equal(r.capture.sources.lowYieldRate, 0.25)
            assert.equal(r.capture.sources.maxConsecFails, CAPTURE_DEFAULT.sources.maxConsecFails)
            assert.deepEqual(r.capture.areas.arxivCategories, ['cs.LG'])
            assert.deepEqual(r.capture.expand.arxivCategories, [], '網格遞補與線索探測之類別各自獨立')
            assert.equal(r.capture.standards.scanEachRun, true)
            assert.equal(r.ai.cooldownMs, 0, '0 為合法值(不冷卻),不得被當成未給而退回預設')
            assert.deepEqual(r.ai.providerTimeouts, { 'oc:x': 1000 })
            assert.equal(r.ai.timeoutMs, AI_DEFAULT.timeoutMs)
        })

        it('組逐鍵遞迴合併:只給巢狀組之一鍵,同組與子組之其餘鍵沿用預設(browser.camofox.port 不蓋掉 enabled)', () => {
            const r = resolveSettings({ capture: { browser: { camofox: { port: 19999 } } } })
            assert.equal(r.capture.browser.camofox.port, 19999)
            assert.equal(r.capture.browser.camofox.enabled, CAPTURE_DEFAULT.browser.camofox.enabled)
            assert.equal(r.capture.browser.perRun, CAPTURE_DEFAULT.browser.perRun)
            assert.equal(r.capture.browser.hygiene, CAPTURE_DEFAULT.browser.hygiene)
            const s = resolveSettings({ capture: { services: { openAlex: { mailto: 'me@example.com' } } } })
            assert.deepEqual(s.capture.services.openAlex, { base: CAPTURE_DEFAULT.services.openAlex.base, mailto: 'me@example.com', apiKeyEnv: CAPTURE_DEFAULT.services.openAlex.apiKeyEnv })
            assert.deepEqual(s.capture.services.arxiv, CAPTURE_DEFAULT.services.arxiv)
        })

        it('葉為物件者整個取代,不逐層合併:capture.discover.ai 給了 { use } 即無預設之 fallback;ai.providerTimeouts、樣式陣列亦然', () => {
            const r = resolveSettings({ capture: { discover: { ai: { use: 'claude:sonnet' } }, standards: { paywallPatterns: [{ p: '訂閱' }] } }, ai: { providerTimeouts: { 'claude:sonnet': 360000 } } })
            assert.deepEqual(r.capture.discover.ai, { use: 'claude:sonnet' })
            assert.equal('fallback' in r.capture.discover.ai, false)
            assert.equal(r.capture.discover.everyHours, CAPTURE_DEFAULT.discover.everyHours, '同組之其他鍵沿用')
            assert.deepEqual(r.capture.standards.paywallPatterns, [{ p: '訂閱' }])
            assert.deepEqual(r.ai.providerTimeouts, { 'claude:sonnet': 360000 })
        })

        it('零件庫用法之選項皆為葉且預設即整段管線之行為:discover.ai 可為 null(無席位)、sources.concurrency 1、sources.maxConsecFails 收 0、articles.archiveText true、standards.sameContent／titleMismatch true', () => {
            // 規則:core/settingsDefault 之 CAPTURE_DEFAULT 註解(零件庫用法之選項)
            const c = resolveSettings({}).capture
            assert.deepEqual([c.sources.concurrency, c.articles.archiveText, c.standards.sameContent, c.standards.titleMismatch], [1, true, true, true])
            assert.equal(resolveSettings({ capture: { discover: { ai: null } } }).capture.discover.ai, null, 'null 席位為合法值(非「組為 null 視為未給」:席位是葉)')
            assert.deepEqual(captureSeatsOf(resolveSettings({ capture: { discover: { ai: null } } })), {}, '席位表不列 null 席位(啟動期不檢)')
            assert.equal(resolveSettings({ capture: { sources: { maxConsecFails: 0, concurrency: 0 } } }).capture.sources.concurrency, 0)
            assert.match(msgOf(() => resolveSettings({ capture: { sources: { concurrency: -1 } } })), /settings\.capture\.sources\.concurrency 須為非負整數/)
            assert.match(msgOf(() => resolveSettings({ capture: { standards: { sameContent: 'no' } } })), /settings\.capture\.standards\.sameContent 須為布林值/)
            assert.match(msgOf(() => resolveSettings({ capture: { discover: { ai: 'x' } } })), /settings\.capture\.discover\.ai 須為席位物件.*或 null/)
        })

        it('undefined 視為未給(沿用預設);null 之組視為未給;cfg 非物件視為 {}', () => {
            const base = snap(resolveSettings({}))
            assert.equal(snap(resolveSettings({ capture: { sources: { perRun: undefined } } })), base)
            for (const g of GROUPS) {
                assert.equal(snap(resolveSettings(nest(g.path, null))), base, `${g.path.join('.')}:null`)
                assert.equal(snap(resolveSettings(nest(g.path, undefined))), base, `${g.path.join('.')}:undefined`)
            }
            for (const bad of [null, undefined, 5, 'x', [], true]) assert.equal(snap(resolveSettings(bad)), base, `cfg=${snap(bad)}`)
        })

        it('只收 ai、capture 兩段:他段(打錯之段名、他工作之段、總組裝之鍵;值為 undefined 者亦檢)→ 拋並列可用之段(總組裝只交原給之段;與下游套件之設定解析同一約定)', () => {
            assert.equal(msgOf(() => resolveSettings({ captur: { sources: {} } })), 'settings 含不認得之鍵：captur（可用：ai、capture）')
            assert.equal(msgOf(() => resolveSettings({ summarize: {}, relate: {}, whatever: 1 })), 'settings 含不認得之鍵：summarize、relate、whatever（可用：ai、capture）')
            assert.equal(msgOf(() => resolveSettings({ workDir: undefined })), 'settings 含不認得之鍵：workDir（可用：ai、capture）', '值為 undefined 之段亦檢')
            assert.equal(snap(resolveSettings({ ai: undefined, capture: undefined })), snap(resolveSettings({})))
        })

        it('resolveCaptureSettings:capture 段之驗證與合併(下游總組裝之 settings.capture 共用此一份);未給即全預設', () => {
            assert.equal(snap(resolveCaptureSettings()), snap(CAPTURE_DEFAULT))
            assert.equal(snap(resolveCaptureSettings(null)), snap(CAPTURE_DEFAULT))
            assert.equal(snap(resolveCaptureSettings({ sources: { perRun: 9 } })), snap(resolveSettings({ capture: { sources: { perRun: 9 } } }).capture))
            assert.equal(msgOf(() => resolveCaptureSettings({ sources: { perRun: 'x' } })), 'settings.capture.sources.perRun 須為非負整數，收到 "x"')
            assert.equal(msgOf(() => resolveCaptureSettings('x')), 'settings.capture 須為物件，收到 "x"')
        })

        it('capture.sources.isAutoSource／extraPatchOf 之預設:frontier 來源為自動來源;grid 翻頁只在確由 OpenAlex 成功回應時前進,回補耗盡轉 fresh 模式', () => {
            const { isAutoSource, extraPatchOf } = CAPTURE_DEFAULT.sources
            assert.equal(isAutoSource({ origin: 'frontier:abc' }), true)
            assert.equal(isAutoSource({ origin: 'seed' }), false)
            assert.equal(isAutoSource({}), false, '無 origin 不是自動來源')
            const ok = { ok: true }
            const grid = { kind: 'grid', _fetchedVia: 'openalex' }
            assert.deepEqual(extraPatchOf({ kind: 'rss', _fetchedVia: 'openalex' }, ok), {}, '非 grid 無逐輪前進之狀態')
            assert.deepEqual(extraPatchOf(grid, { ok: false }), {}, '失敗不前進(前進即漏頁)')
            assert.deepEqual(extraPatchOf(grid, undefined), {})
            assert.deepEqual(extraPatchOf({ kind: 'grid', _fetchedVia: 'arxiv' }, ok), {}, '改走 arXiv 遞補(不用 cursor)不前進')
            assert.deepEqual(extraPatchOf({ ...grid, cursor: 3 }, ok), { cursor: 4 })
            assert.deepEqual(extraPatchOf(grid, ok), { cursor: 2 }, '無 cursor 視為第 1 頁')
            assert.deepEqual(extraPatchOf({ ...grid, cursor: 0 }, ok), { cursor: 2 }, 'cursor 至少為 1')
            assert.deepEqual(extraPatchOf({ ...grid, mode: 'fresh' }, ok), {}, 'fresh 模式(追新作)cursor 不再前進')
            const done = extraPatchOf({ ...grid, cursor: 9, _exhausted: true }, ok)
            assert.deepEqual([done.mode, done.cursor], ['fresh', 1], '回補耗盡 → 轉 fresh 並回到第 1 頁')
            assert.ok(Math.abs(Date.now() - Date.parse(done.exhaustedAt)) < 5000, 'exhaustedAt 記耗盡時刻(ISO)')
            assert.equal(resolveSettings({}).capture.sources.isAutoSource, CAPTURE_DEFAULT.sources.isAutoSource, '函數葉原樣取用(不複製)')
        })
    })

    describe('設定錯誤一律拋錯並列可用鍵', function() {

        for (const [name, schema, dflt] of SECTIONS) {
            it(`${name}:每個葉給不合格值 → 拋錯,訊息含「settings.<路徑> 須為<期望型別>，收到 <值>」`, () => {
                for (const leaf of leavesOf(schema, dflt, [name])) {
                    const spec = SAMPLES[leaf.type]
                    assert.ok(spec, `${leaf.path.join('.')}:型別「${leaf.type}」缺邊界樣本`)
                    for (const bad of spec.invalid) {
                        const m = msgOf(() => resolveSettings(nest(leaf.path, bad)))
                        assert.notEqual(m, null, `${leaf.path.join('.')}=${snap(bad)} 應拋錯(不可靜默收下)`)
                        assert.ok(m.startsWith(`settings.${leaf.path.join('.')} 須為${SETTING_TYPES[leaf.type].desc}，收到 `), `${leaf.path.join('.')}=${snap(bad)}:${m}`)
                    }
                }
            })
        }

        it('每個組(含根與巢狀組):不認得之鍵 → 拋錯並列出該組全部可用鍵與完整路徑(打錯之鍵靜默失效比拋錯更難察覺)', () => {
            for (const g of GROUPS) {
                const where = g.path.join('.')
                const keys = Object.keys(g.schema)
                assert.equal(msgOf(() => resolveSettings(nest(g.path, { zzzNope: 1 }))), `settings.${where} 含不認得之鍵：zzzNope（可用：${keys.join('、')}）`, where)
                // 近似拼寫(少一個字母)同樣不被接受
                const typo = keys[0].slice(0, -1)
                assert.ok(msgOf(() => resolveSettings(nest(g.path, { [typo]: 1 })))?.includes(`含不認得之鍵：${typo}（可用：`), `${where}:${typo}`)
                assert.equal(msgOf(() => resolveSettings(nest(g.path, { a1: 1, b2: 2 })))?.includes('含不認得之鍵：a1、b2（可用：'), true, `${where}:多個未知鍵一併列出`)
            }
        })

        it('每個組(含根與巢狀組):給了但非物件 → 拋錯(字串、數字、布林、陣列、函數皆是)', () => {
            const shown = [['x', '"x"'], [1, '1'], [true, 'true'], [[], 'array'], [() => 1, 'function']]
            for (const g of GROUPS) {
                for (const [bad, text] of shown) {
                    assert.equal(msgOf(() => resolveSettings(nest(g.path, bad))), `settings.${g.path.join('.')} 須為物件，收到 ${text}`, g.path.join('.'))
                }
            }
        })

        it('鍵放錯層級一律被拒(無相容層):capture 頂層只認得組名,組內之鍵(如 sourcesPerRun、minTextChars)放到頂層、或 areas 組內放不屬於該組之鍵皆拋錯並列出可用之鍵', () => {
            const capKeys = Object.keys(CAPTURE_SCHEMA).join('、')
            for (const old of ['sourcesPerRun', 'articlesPerRun', 'browserPerRun', 'camofoxEnabled', 'browserHygiene', 'netProbeUrls', 'areaDiscoverEveryHours', 'frontierPerRun', 'terminalStatuses', 'gridArxivCategories', 'openAlexBase', 'minTextChars']) {
                assert.equal(msgOf(() => resolveSettings({ capture: { [old]: 1 } })), `settings.capture 含不認得之鍵：${old}（可用：${capKeys}）`, old)
            }
            assert.match(msgOf(() => resolveSettings({ capture: { areas: { gridArxivCategories: null } } })), /^settings\.capture\.areas 含不認得之鍵：gridArxivCategories/)
            assert.match(msgOf(() => resolveSettings({ capture: { sources: { sourcesPerRun: 1 } } })), /^settings\.capture\.sources 含不認得之鍵：sourcesPerRun/)
        })

        it('席位形狀錯之訊息附 seatProblem 之原因(capture.discover.ai;型別 seatOrNull:null 為無席位)', () => {
            assert.equal(
                msgOf(() => resolveSettings({ capture: { discover: { ai: { use: 'x', fallbak: [] } } } })),
                `settings.capture.discover.ai 須為${SETTING_TYPES.seatOrNull.desc}，收到 object（含不認得之鍵：fallbak（可用：${SEAT_KEYS.join('、')}））`,
            )
            assert.match(msgOf(() => resolveSettings({ capture: { discover: { ai: { use: 'x', timeoutMs: 0 } } } })), /timeoutMs 須為正數（毫秒）/)
            assert.match(msgOf(() => resolveSettings({ capture: { discover: { ai: { use: '' } } } })), /use 須為非空字串（條目 id）/)
        })

        it('值之顯示:字串加引號、數字與布林原樣、null 為 null、陣列為 array、物件為 object(訊息分得出 "27" 與 27)', () => {
            const pick = (v) => msgOf(() => resolveSettings({ capture: { articles: { perRun: v } } }))
            assert.match(pick('27'), /收到 "27"$/)
            assert.match(pick(1.5), /收到 1.5$/)
            assert.match(pick(true), /收到 true$/)
            assert.match(pick(null), /收到 null$/)
            assert.match(pick([1]), /收到 array$/)
            assert.match(pick({}), /收到 object$/)
        })

        it('同一組內有未知鍵與型別錯時,先報未知鍵(整組之鍵集不合比單鍵之值域更根本)', () => {
            assert.match(msgOf(() => resolveSettings({ capture: { articles: { perRun: 'x', nopeKey: 1 } } })), /^settings\.capture\.articles 含不認得之鍵：nopeKey/)
        })

        it('錯誤不留殘值:拋錯之呼叫不改動後續呼叫之結果', () => {
            const before = snap(resolveSettings({}))
            assert.throws(() => resolveSettings({ capture: { articles: { perRun: 'x' } } }))
            assert.equal(snap(resolveSettings({})), before)
        })
    })

    describe('型別判準與席位鍵檢核', function() {

        it('SETTING_TYPES 與 SEAT_KEYS 凍結(設定契約不得被執行期改寫)', () => {
            assert.ok(Object.isFrozen(SETTING_TYPES))
            assert.ok(Object.isFrozen(SEAT_KEYS))
            assert.deepEqual([...SEAT_KEYS], ['use', 'fallback', 'timeoutMs', 'minAttemptMs', 'budgetMs'])
        })

        it('SAMPLES 涵蓋 SETTING_TYPES 之全部型別(新增型別須補邊界樣本)', () => {
            assert.deepEqual(Object.keys(SAMPLES).sort(), Object.keys(SETTING_TYPES).sort())
        })

        it('型別判準之邊界:整數 vs 非負整數 vs 非負數;比例含 0 與 1;null 僅 strArrOrNull 合格;空物件為合格之逾時對照', () => {
            const T = (name, v) => SETTING_TYPES[name].test(v)
            assert.deepEqual([T('pint', 1), T('pint', 0), T('p0int', 0), T('p0int', -1), T('p0num', 0), T('p0num', 0.5), T('p0num', -0.5)], [true, false, true, false, true, true, false])
            assert.deepEqual([T('ratio', 0), T('ratio', 1), T('ratio', 1.0001), T('ratio', -0.0001)], [true, true, false, false])
            assert.deepEqual([T('strArr', []), T('strArrOrNull', null), T('strArr', null)], [true, true, false])
            assert.deepEqual([T('timeouts', {}), T('timeouts', { a: 1 }), T('objArr', []), T('patterns', [])], [true, true, true, true])
            assert.deepEqual([T('patterns', [{ p: 'x', f: undefined }]), T('patterns', [{ p: 'x', f: '' }]), T('patterns', [{ p: '' }])], [true, true, false], 'p 須為非空字串;f 可省略')
        })

        it('seatProblem:合格回空字串;非物件、未知鍵(列可用鍵)、use 非空字串、fallback 為字串陣列(undefined／null 可)、數值鍵為正有限數', () => {
            assert.equal(seatProblem({ use: 'a' }), '')
            assert.equal(seatProblem({ use: 'a', fallback: ['b', 'c'], timeoutMs: 1, minAttemptMs: 2.5, budgetMs: 3 }), '')
            assert.equal(seatProblem({ use: 'a', fallback: null }), '')
            assert.equal(seatProblem({ use: 'a', fallback: undefined }), '')
            assert.equal(seatProblem({ use: 'a', fallback: [] }), '')
            assert.match(seatProblem('x'), /^席位須為物件/)
            assert.match(seatProblem(null), /^席位須為物件/)
            assert.match(seatProblem([]), /^席位須為物件/)
            assert.equal(seatProblem({ use: 'a', timeout: 1 }), `含不認得之鍵：timeout（可用：${SEAT_KEYS.join('、')}）`, '不認得之鍵為 checkKeys 之格式(unknownKeysProblem;主詞由呼叫端之句給)')
            assert.equal(seatProblem({ use: 'a', x: 1, y: 2 }), `含不認得之鍵：x、y（可用：${SEAT_KEYS.join('、')}）`)
            for (const use of [undefined, '', 1, null, ['a']]) assert.equal(seatProblem({ use }), 'use 須為非空字串（條目 id）', `use=${snap(use)}`)
            for (const fallback of ['b', [1], ['a', ''], [null], {}]) assert.equal(seatProblem({ use: 'a', fallback }), 'fallback 須為條目 id 之字串陣列', `fallback=${snap(fallback)}`)
            for (const v of [0, -1, '5', NaN, Infinity, null]) {
                assert.equal(seatProblem({ use: 'a', timeoutMs: v }), 'timeoutMs 須為正數（毫秒）', `timeoutMs=${snap(v)}`)
            }
            assert.equal(seatProblem({ use: 'a', timeoutMs: 0, minAttemptMs: -1, budgetMs: 1 }), 'timeoutMs、minAttemptMs 須為正數（毫秒）', '多個數值鍵一併列出')
        })
    })

    describe('實例互不汙染', function() {

        // 走訪出物件與陣列之參照(RegExp 與函數不計:不可就地變更其內容)
        const refsOf = (v, out = new Set()) => {
            if (v && typeof v === 'object' && !(v instanceof RegExp)) {
                out.add(v)
                for (const x of Object.values(v)) refsOf(x, out)
            }
            return out
        }
        const overlap = (x, y) => [...x].filter((r) => y.has(r)).length

        it('兩個實例不共用巢狀參照,也不共用預設常數之參照', () => {
            const a = resolveSettings({})
            const b = resolveSettings({})
            const dflt = new Set()
            for (const d of [CAPTURE_DEFAULT, AI_DEFAULT]) refsOf(d, dflt)
            const ra = refsOf(a)
            assert.equal(overlap(ra, refsOf(b)), 0, '兩實例之物件／陣列不得為同一參照')
            assert.equal(overlap(ra, dflt), 0, '實例之物件／陣列不得為預設常數之參照')
            assert.ok(ra.size > 8, '走訪須真涵蓋巢狀結構(否則上列兩斷言恆過)')
        })

        it('某實例就地修改其陣列與物件,預設常數與其後建構之實例皆不受影響', () => {
            const consts = () => snap([CAPTURE_DEFAULT, AI_DEFAULT])
            const pristine = snap(resolveSettings({}))
            const constsBefore = consts()
            const a = resolveSettings({})
            a.capture.articles.skipTitlePatterns.push({ p: 'mutated' })
            a.capture.articles.skipTitlePatterns[0].p = 'mutated'
            a.capture.areas.arxivCategories.push('x')
            a.capture.expand.arxivCategories.push('y')
            a.capture.standards.placeholderPatterns.push(/x/)
            a.capture.sources.perRun = 999
            a.capture.browser.camofox.port = 1
            a.capture.services.openAlex.mailto = 'mutated@example.com'
            a.capture.discover.ai.fallback.push('mutated:x')
            a.capture.discover.ai.use = 'mutated:y'
            a.ai.providerTimeouts['m:z'] = 1
            a.ai.extraProviders.push({ id: 'm' })
            a.warnings.push('mutated')
            assert.notEqual(snap(a), pristine, '前提:修改確實發生')
            assert.equal(consts(), constsBefore, '預設常數不被汙染')
            assert.equal(snap(resolveSettings({})), pristine, '其後建構之實例不受影響')
        })

        it('給定之 cfg 不被改動(凍結之 cfg 亦可解析)', () => {
            const cfg = Object.freeze({
                capture: Object.freeze({
                    areas: Object.freeze({ arxivCategories: Object.freeze(['cs.LG']) }),
                    sources: Object.freeze({ perRun: 3 }),
                    discover: Object.freeze({ ai: Object.freeze({ use: 'oc:x', fallback: Object.freeze(['oc:y']) }) }),
                }),
            })
            const before = snap(cfg)
            const r = resolveSettings(cfg)
            assert.equal(snap(cfg), before)
            assert.deepEqual(r.capture.areas.arxivCategories, ['cs.LG'])
            assert.equal(r.capture.sources.perRun, 3)
            assert.deepEqual(r.capture.discover.ai, { use: 'oc:x', fallback: ['oc:y'] })
        })
    })
})
