// unit-core-locale.test.mjs — 語言設定(core/locale):解析、字形政策之分派、標準之適用、slug 與折疊政策、各落點之接線(領域發現提示詞、線索入庫、
//   符合度掃描、存量處置、執行期件、總組裝)
// 規則(出自 core/locale 檔頭):
//   ①resolveLocale:未給＝zh-TW;字串為 BCP 47 代碼(正規化);已解析之產物原樣回傳;其餘拋錯並點名設定鍵
//   ②字形政策:zh-TW／zh-Hant／zh-Hant-TW 為臺灣正體(與 textForms 同一判定與修正);其餘語言為恆等(不改字、不報問題)
//   ③標準之 appliesTo:CS12 只適用於臺灣正體;語言設定非繁體中文時掃描逐件列「不適用」(受檢總量不為 0、不報合格),存量處置無違反可處置
//   ④預設逐字不變:未給語言設定時提示詞、入庫轉正體、折疊、slug 與語言設定出現前相同;純函數未給 locale 即正體
//   ⑤slug 政策:中文收漢字與拉丁(既有 slug 不變);其餘語言收任何文字之字母與數字;折疊:未給 conceptFold 時中文折、其餘不折,true 強制內建折疊
// 執行:自套件根 node <mocha> test/unit-core-locale.test.mjs(暫存 test/_tmp/core-locale-<pid>,測完即刪;記憶體集合,不連網、不呼叫 AI)

import assert from 'node:assert/strict'
import { memStore } from './tools/memStore.mjs'
import { tmpRoot } from './tools/captureTestKit.mjs'
import { removeRoots, silentLog, stubAdapter, msgOf } from './tools/testKit.mjs'
import { DEFAULT_LANG, SCRIPT_NA_DETAIL, SCRIPT_ZH_HANT_TW, SCRIPT_NONE, resolveLocale, scriptOf, scriptApplies, localeProblem } from '../src/core/locale.mjs'
import { scriptProblems, toTw, toTwKeepLinks, cnToTw } from '../src/core/standards/textForms.mjs'
import { slugify, setConceptFold } from '../src/core/util/text.mjs'
import { saveClues } from '../src/core/stores/frontierPolicy.mjs'
import { createAreaDomain } from '../src/domain/areaDomain.mjs'
import { auditCaptureStandards } from '../src/standards/audit.mjs'
import { planCs12Fix } from '../src/standards/cs12Fix.mjs'
import { DOC_STANDARDS } from '../src/standards/docStandards.mjs'
import { aiEventLoggersOf } from '../src/core/assemblyKit.mjs'
import { resolveSettings } from '../src/core/settingsDefault.mjs'
import { createCaptureRuntime, conceptFoldsOf } from '../src/captureRuntime.mjs'
import { createKnowledgeCapture, CFG_KEYS } from '../src/createKnowledgeCapture.mjs'

const NOW = '2026-10-28T12:00:00+08:00'
const SIMP = 'GJR-GARCH杠杆效应'
const TW = 'GJR-GARCH槓桿效應'
const S0 = resolveSettings({})

describe('unit-core-locale', function() {

    this.timeout(60_000)

    let root = ''
    before(() => {
        root = tmpRoot('core-locale')
    })
    after(() => {
        setConceptFold(null) // 折疊為模組級單例,不留給同 worker 之他檔
        removeRoots([root])
    })

    describe('resolveLocale／scriptOf／scriptApplies(core/locale)', function() {

        it('①未給＝zh-TW:稱呼「繁體中文」、中文、臺灣正體字形政策、slug 收漢字與拉丁;代碼正規化(zh-tw → zh-TW);已解析之產物原樣回傳', () => {
            const L = resolveLocale()
            assert.deepEqual([L.code, L.label, L.han, L.script.id, L.slug, DEFAULT_LANG], ['zh-TW', '繁體中文', true, 'zh-Hant-TW', 'han-latin', 'zh-TW'])
            assert.equal(resolveLocale(null).code, 'zh-TW')
            assert.equal(resolveLocale('zh-tw').code, 'zh-TW')
            assert.equal(resolveLocale(L), L, '已解析者原樣回傳(同一物件)')
            assert.ok(Object.isFrozen(L))
        })

        it('②字形政策之分派:zh-TW／zh-Hant／zh-Hant-TW 為臺灣正體;zh-HK、zh-CN、zh-Hans、en、ja 皆恆等;中文之稱呼依子標籤分繁簡;非中文之稱呼為繁體中文書寫之語言名', () => {
            for (const c of ['zh-TW', 'zh-Hant', 'zh-Hant-TW']) assert.deepEqual([resolveLocale(c).script.id, resolveLocale(c).label, resolveLocale(c).han], ['zh-Hant-TW', '繁體中文', true], c)
            assert.deepEqual([resolveLocale('zh-HK').script.id, resolveLocale('zh-HK').label, resolveLocale('zh-HK').han], ['none', '繁體中文', true])
            assert.deepEqual([resolveLocale('zh-CN').label, resolveLocale('zh-Hans').label, resolveLocale('zh-Hans-SG').label, resolveLocale('zh').label], ['簡體中文', '簡體中文', '簡體中文', '中文'])
            assert.deepEqual([resolveLocale('zh-CN').script.id, resolveLocale('zh-CN').han, resolveLocale('zh-CN').slug], ['none', true, 'han-latin'])
            const E = resolveLocale('en')
            assert.deepEqual([E.code, E.label, E.han, E.script.id, E.slug], ['en', '英文', false, 'none', 'unicode'])
            assert.deepEqual([resolveLocale('ja').label, resolveLocale('en-US').label, resolveLocale('de').label], ['日文', '英文', '德文'])
            const sw = resolveLocale('sw')
            assert.ok(typeof sw.label === 'string' && sw.label.length > 0 && sw.script.id === 'none', '表外語言:稱呼取 Intl 顯示名、字形政策恆等')
        })

        it('①錯值一律拋錯並點名設定鍵:非字串非物件、空字串、不合 BCP 47 之代碼、形狀不合之物件;localeProblem 列缺之欄', () => {
            for (const bad of [5, true, [], '', '  ', '!!', 'zh_TW', 'a b']) assert.match(msgOf(() => resolveLocale(bad)), /^cfg\.lang /, JSON.stringify(bad))
            assert.equal(msgOf(() => resolveLocale('!!')), 'cfg.lang 不是合法之語言代碼：!!')
            assert.equal(msgOf(() => resolveLocale(5, 'opt.locale')), "opt.locale 須為語言代碼字串（BCP 47，如 'zh-TW'、'en'）")
            assert.equal(msgOf(() => resolveLocale({ code: 'en' })), 'cfg.lang 須為語言代碼字串或 resolveLocale 之產物（缺 label、han、script、slug）')
            assert.equal(localeProblem(resolveLocale('en')), '')
            assert.equal(localeProblem({ code: 'en', label: '英文', han: false, script: { id: 'x' }, slug: 'unicode' }), 'script 缺函數 problems、fix、fixKeepLinks')
            assert.equal(localeProblem({ code: 'en', label: '英文', han: false, script: SCRIPT_NONE, slug: 'latin' }), 'slug 須為 han-latin 或 unicode')
        })

        it('②SCRIPT_ZH_HANT_TW 與 textForms 同一判定與修正;SCRIPT_NONE 不改字、不報問題;scriptOf:未給＝正體、代碼／語言設定／字形政策皆可、其餘拋', () => {
            const s = '之后由于数据 见 [[简体-slug]] https://x.com/数据'
            assert.deepEqual(SCRIPT_ZH_HANT_TW.problems(s), scriptProblems(s))
            assert.deepEqual([SCRIPT_ZH_HANT_TW.fix(s), SCRIPT_ZH_HANT_TW.fixKeepLinks(s)], [toTw(s), toTwKeepLinks(s)])
            assert.deepEqual([SCRIPT_NONE.problems(s), SCRIPT_NONE.fix(s), SCRIPT_NONE.fixKeepLinks(s), SCRIPT_NONE.fix(null)], [{ count: 0, only: [], practical: [], phrases: [] }, s, s, ''])
            assert.deepEqual([scriptOf().id, scriptOf(null).id, scriptOf('en').id, scriptOf('zh-Hant').id, scriptOf(resolveLocale('ja')).id, scriptOf(SCRIPT_NONE), scriptOf(SCRIPT_ZH_HANT_TW)], ['zh-Hant-TW', 'zh-Hant-TW', 'none', 'zh-Hant-TW', 'none', SCRIPT_NONE, SCRIPT_ZH_HANT_TW])
            assert.equal(msgOf(() => scriptOf({ id: 'x' }, 'deps.locale')), 'deps.locale 須為語言代碼、resolveLocale 之產物或字形政策物件（缺函數 problems、fix、fixKeepLinks）')
            assert.match(msgOf(() => scriptOf(5)), /^locale 須為/)
            assert.equal(cnToTw('头发与数据'), '頭髮與數據', '比對用之整段簡→繁轉換(下游文字相似度經抓取埠取之)')
        })

        it('③scriptApplies:未宣告 appliesTo 者一律適用;CS12 宣告 zh-Hant-TW,恆等政策不適用', () => {
            const cs12 = DOC_STANDARDS.find((x) => x.id === 'CS12')
            assert.deepEqual(cs12.appliesTo, ['zh-Hant-TW'])
            assert.deepEqual([scriptApplies(cs12, SCRIPT_ZH_HANT_TW), scriptApplies(cs12, SCRIPT_NONE), scriptApplies({ id: 'X' }, SCRIPT_NONE), scriptApplies(DOC_STANDARDS.find((x) => x.id === 'CS2'), SCRIPT_NONE)], [true, false, true, true])
        })
    })

    describe('slug 與折疊政策(core/util/text、captureRuntime)', function() {

        it('⑤slugify:預設只收漢字與拉丁(既有 slug 逐字不變);chars unicode 收任何文字之字母與數字;其他值拋錯', () => {
            assert.equal(slugify('Transformer 注意力機制！！', 'k1'), 'transformer-注意力機制-a2ab1959')
            assert.equal(slugify('Café résumé', 'k2'), 'caf-rsum-bfeb734d')
            assert.equal(slugify('Café résumé', 'k2', { chars: 'unicode' }), 'café-résumé-bfeb734d')
            assert.equal(slugify('量子 もつれ', 'k3', { chars: 'unicode' }).startsWith('量子-もつれ-'), true)
            assert.equal(slugify('量子 もつれ', 'k3', { chars: 'han-latin' }).startsWith('量子--'), false, '預設去掉假名後不留連續連字號')
            assert.equal(slugify('量子 もつれ', 'k3').startsWith('量子-'), true)
            assert.match(msgOf(() => slugify('x', 'k', { chars: 'latin' })), /slugify 之 opt\.chars 須為 'han-latin' 或 'unicode'/)
        })

        it('⑤conceptFoldsOf:未給 conceptFold 時依語言設定(中文折、其餘不折;未給語言設定視同中文);true 強制內建折疊;false 停用;函數自訂', () => {
            assert.deepEqual(conceptFoldsOf(undefined, resolveLocale('en')), { fold: null, clueFold: null })
            assert.deepEqual(conceptFoldsOf(undefined, resolveLocale('ja')), { fold: null, clueFold: null })
            assert.equal(typeof conceptFoldsOf(undefined, resolveLocale('zh-CN')).fold, 'function', '簡體中文亦折(折向簡體收斂字形)')
            assert.equal(typeof conceptFoldsOf(undefined).fold, 'function', '未給語言設定視同中文(與語言設定出現前相同)')
            assert.equal(typeof conceptFoldsOf(true, resolveLocale('en')).fold, 'function', 'true 強制內建折疊')
            assert.deepEqual(conceptFoldsOf(false, resolveLocale('zh-TW')), { fold: null, clueFold: null })
            const f = (t) => t
            assert.deepEqual(conceptFoldsOf(f, resolveLocale('en')), { fold: f, clueFold: f })
            assert.match(msgOf(() => conceptFoldsOf('x')), /cfg\.conceptFold 須為 false（停用）、true（內建繁簡折疊）、未給（依語言設定）或折疊函數/)
        })
    })

    describe('各落點之接線:提示詞、入庫、掃描、存量處置、事件時刻', function() {

        it('④領域發現提示詞:預設逐字含「繁體中文領域名」;lang en 換為「英文領域名」且不含「繁體中文」;錯值拋錯並點名 opt.locale', () => {
            const cand = [{ label: 'X', kind: 'concept', support: 3, growth: 1, samples: [] }]
            const p0 = createAreaDomain({}).buildPrompt(cand, [])
            const p1 = createAreaDomain({ locale: 'en' }).buildPrompt(cand, [])
            assert.ok(p0.includes('label（繁體中文領域名，'), p0)
            assert.ok(p1.includes('label（英文領域名，') && !p1.includes('繁體中文'), p1)
            assert.equal(p0.replace('繁體中文領域名', '英文領域名'), p1, '只換語言句,其餘逐字相同')
            assert.equal(createAreaDomain({ locale: resolveLocale('en') }).buildPrompt(cand, []), p1, '已解析之產物亦可')
            assert.match(msgOf(() => createAreaDomain({ locale: '!!' })), /^createAreaDomain 之 opt\.locale 不是合法之語言代碼/)
        })

        it('②④saveClues:預設關鍵詞轉正體(toTw 計數);cfg.locale en 不轉、計 0;網址一律不轉;錯值拋錯', async () => {
            const r0 = await saveClues(memStore(), [{ type: 'keyword', value: SIMP }], { nowIso: NOW })
            const f = memStore()
            const r1 = await saveClues(f, [{ type: 'keyword', value: SIMP }, { type: 'site', value: 'https://x.example.com/数据' }], { nowIso: NOW, locale: 'en' })
            assert.deepEqual([r0.toTw, r1.toTw, r1.addCount], [1, 0, 2])
            assert.deepEqual((await f.select()).map((x) => x.value).sort(), [SIMP, 'https://x.example.com/数据'])
            const f2 = memStore()
            await saveClues(f2, [{ type: 'keyword', value: SIMP }], { nowIso: NOW, locale: resolveLocale('zh-TW') })
            assert.equal((await f2.select())[0].value, TW)
            await assert.rejects(() => saveClues(memStore(), [{ type: 'keyword', value: 'x' }], { nowIso: NOW, locale: 5 }), /saveClues 之 cfg\.locale 須為語言代碼/)
        })

        it('③符合度掃描 CS12:預設判違反;deps.locale en 時領域標籤與線索逐件列不適用(總量不為 0、合格 0、違反 0;說明為共同字樣);存量處置預演無違反可處置', async () => {
            const o = () => ({
                docs: memStore([]), docTexts: memStore([]), sources: memStore([]),
                areas: memStore([{ id: 'a1', label: '机器学习因子', query: 'ml factor', origin: 'auto', status: 'active' }, { id: 'a2', label: '動量策略', query: 'momentum', origin: 'auto', status: 'active' }]),
                frontier: memStore([{ id: 'c1', type: 'keyword', value: SIMP, status: 'pending' }, { id: 'c2', type: 'keyword', value: TW, status: 'pending' }]),
            })
            const d = (await auditCaptureStandards({ stores: o() }, { only: ['CS12'] })).standards.CS12
            assert.deepEqual([d.total, d.violation, d.pass, d.na], [4, 2, 2, 0])
            const e = (await auditCaptureStandards({ stores: o(), locale: 'en' }, { only: ['CS12'] })).standards.CS12
            assert.deepEqual([e.total, e.violation, e.pass, e.na, e.violations], [4, 0, 0, 4, []])
            assert.equal(SCRIPT_NA_DETAIL, '語言設定非繁體中文，正體標準不適用')
            const z = (await auditCaptureStandards({ stores: o(), locale: resolveLocale('zh-Hant') }, { only: ['CS12'] })).standards.CS12
            assert.deepEqual([z.violation, z.na], [2, 0], 'zh-Hant 亦為臺灣正體')
            await assert.rejects(() => auditCaptureStandards({ stores: o(), locale: 'xx-!!' }, { only: ['CS12'] }), /auditCaptureStandards 之 deps\.locale/)
            const st = o()
            const plan = await planCs12Fix({ areas: st.areas, frontier: st.frontier }, { locale: 'en' })
            assert.deepEqual([plan.counts.violations, plan.items, plan.unfixable], [0, [], []])
            const plan0 = await planCs12Fix({ areas: st.areas, frontier: st.frontier })
            assert.ok(plan0.counts.violations > 0 && plan0.items.length + plan0.unfixable.length > 0, '預設照處置')
        })

        it('事件時刻之數字格式依語言代碼(aiEventLoggersOf 之 opt.lang):en 與預設同為 24 時制之時分;代碼不合即 ?', () => {
            const lines = []
            const ev = { providerId: 'p', first: Date.UTC(2026, 0, 1, 14, 5), last: Date.UTC(2026, 0, 1, 15, 6), n: 2, resetUtcHour: 0 }
            aiEventLoggersOf({ warn: (m) => lines.push(m) }, { timeZone: 'UTC' }, { lang: 'en' }).onPool(ev)
            aiEventLoggersOf({ warn: (m) => lines.push(m) }, { timeZone: 'UTC' }).onPool(ev)
            aiEventLoggersOf({ warn: (m) => lines.push(m) }, { timeZone: 'UTC' }, { lang: 'xx-!!' }).onPool(ev)
            assert.ok(lines[0].includes('自 14:05 起') && lines[0].includes('最近 15:06'), lines[0])
            assert.equal(lines[1], lines[0])
            assert.ok(lines[2].includes('自 ? 起'), lines[2])
        })
    })

    describe('執行期件與總組裝(captureRuntime、createKnowledgeCapture)', function() {

        it('createCaptureRuntime 讀 cfg.lang:locale 為解析後之語言設定、每輪依賴附同一物件、折疊依語言、領域 domain 之語言句依之;未給即 zh-TW;錯值拋錯並點名 cfg.lang', () => {
            const rt = createCaptureRuntime({ lang: 'en', netGuard: null }, S0)
            assert.deepEqual([rt.locale.code, rt.locale.script.id, rt.folds], ['en', 'none', { fold: null, clueFold: null }])
            assert.equal(rt.deps({ docs: memStore() }, silentLog).locale, rt.locale)
            assert.ok(rt.areaDomain.buildPrompt([{ label: 'X', kind: 'concept', support: 1, growth: 1, samples: [] }], []).includes('英文領域名'))
            const rt0 = createCaptureRuntime({ netGuard: null }, S0)
            assert.deepEqual([rt0.locale.code, typeof rt0.folds.fold], ['zh-TW', 'function'])
            assert.equal(typeof createCaptureRuntime({ lang: 'en', conceptFold: true, netGuard: null }, S0).folds.fold, 'function', 'conceptFold true 強制內建折疊')
            assert.match(msgOf(() => createCaptureRuntime({ lang: 'zh_TW', netGuard: null }, S0)), /^cfg\.lang 不是合法之語言代碼：zh_TW/)
            setConceptFold(null)
        })

        it('createKnowledgeCapture:lang 在 CFG_KEYS;info().locale 與每輪依賴同源;預設 zh-TW', () => {
            assert.ok(CFG_KEYS.includes('lang'))
            const build = (extra) => createKnowledgeCapture({ workDir: `${root}/kb-${Math.random().toString(16).slice(2, 8)}`, aiAdapter: stubAdapter(() => 'fail'), netGuard: null, lock: false, logFactory: () => silentLog, ...extra })
            assert.deepEqual([build({ lang: 'en' }).info().locale.code, build({}).info().locale.code, build({ lang: 'zh-hant-tw' }).info().locale.code], ['en', 'zh-TW', 'zh-Hant-TW'])
            assert.match(msgOf(() => build({ lang: '' })), /^cfg\.lang 須為語言代碼字串/)
            setConceptFold(null)
        })
    })
})
