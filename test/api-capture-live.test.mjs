// api-capture-live.test.mjs — 抓取之實網測試:以題組(預設 test/fixtures/capture-live-generic.json:真實可連之中立網址)跑總組裝之抓取物件
//   (真 curl＋Readability、真健全閘、真分流、真瀏覽器階梯子行程:系統 Chrome 無頭＋Camofox),逐案檢核分流結果
//
// 【閘門】連外網、啟動瀏覽器(不呼叫 AI):只在 WK_LIVE_NET=1 時執行,否則整組略過(mocha pending)並印出原因。
// 【題組】WK_LIVE_FIXTURE=<路徑> 改用外部題組:{ cases:[…] },或依類別分組之 { classes:{ 類別:[…] } };每案 { id?, url, title, expect }。
//   expect.outcome:final＝確定性失敗(逐案斷言去向);rescue／browser-queue＝站方相依(只斷言分流不變式);未設 expect 之案不納入(印出)。
// 【確定性之案】(HTTP 404／410、轉址至站台首頁之軟 404):一輪即 dead、lastReason 與 httpCode 為應然、tries＝capture.articles.maxTries;
//   viaBrowser:false 者未經瀏覽器(無 curlReason)、true 者經瀏覽器階梯而終態;deadClass 給了即驗。
// 【站方相依之案】去向會隨站方之限流、反自動化與時段翻轉(短時間重複實跑即可見救回與留佇列互換),逐案斷言去向不穩;只斷言分流不變式:
//   raw(另驗無假救回)、留瀏覽器佇列(new、fetcher browser、tries 1、curlReason 記原 curl 失敗)、
//   或暫時性 HTTP 失敗依分流規則重試(new、tries 1、退避 retryAt;如 429／5xx——分流規則判 retry 者)三者之一;不得 dead、不得延後。
//   題組所記之觀察(收入當日之去向)只列資訊。
// 【無假救回】每篇 raw:過現版健全閘(依入口、長度條件用 fullLength——與存量重判同一函數)且非 CS2 確定錯頁(與正文閘同一判定)。
// 【環境與名額】瀏覽器環境失敗 0(Chrome 與 Camofox 皆可啟動,否則分流形同停用);配額與時間給足——無延後、全數取件;抓取不得呼叫 AI。
// 【隔離】暫存 workDir test/_tmp/capture-live-<pid>(測完即刪);只放題組文件(無種子、無網格、領域發現停用、孤兒回收關閉);
//   Camofox 埠 19437(測試專用:同埠並行會借用彼此之 server 而互殺);測完以回收判準＋「本測試開始後才誕生」之時窗只回收本測試留下之孤兒。
// 執行(套件根):WK_LIVE_NET=1 node ./node_modules/mocha/bin/mocha.js --timeout 180000 test/api-capture-live.test.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createKnowledgeCapture } from '../src/createKnowledgeCapture.mjs'
import { createHealthGates, planHealthRecheck } from '../src/stores/healthRecheck.mjs'
import { classifyFetch, httpCodeOf } from '../src/stores/fetchPolicy.mjs'
import { checkTitleBody } from '../src/standards/docStandards.mjs'
import { STATUS } from '../src/core/standards/verdict.mjs'
import { sweepOrphanBrowsers } from '../src/core/ops/browserHygiene.mjs'
import { sha1 } from '../src/core/util/text.mjs'
import { normalizeUrl, unwrapNewsUrl } from '../src/core/util/web.mjs'
import { recLog } from './tools/testKit.mjs'

const LIVE = process.env.WK_LIVE_NET === '1'
const FIXTURE = process.env.WK_LIVE_FIXTURE ? path.resolve(process.env.WK_LIVE_FIXTURE) : fileURLToPath(new URL('./fixtures/capture-live-generic.json', import.meta.url))
const CAMOFOX_PORT = 19437
const OUTCOMES = ['final', 'rescue', 'browser-queue']

/**
 * 題組 → 案(兩種形狀皆收;未設 expect 者另列);文件 id 與生產同一身分鍵(sha1(正規化網址))
 *
 * @param {Object} fx 輸入題組
 * @returns {Object} 回傳 { cases:Array, skipped:Array }
 * @throws {Error} 案缺 url、expect 不合或網址重複時拋出(題組錯不得默默略過)
 */
function casesOf(fx) {
    const list = Array.isArray(fx?.cases)
        ? fx.cases.map((c) => ({ ...c, cls: c?.cls || '' }))
        : Object.entries(fx?.classes || {}).flatMap(([cls, xs]) => (Array.isArray(xs) ? xs : []).map((c) => ({ ...c, cls })))
    const cases = []
    const skipped = []
    for (const c of list) {
        if (!c || typeof c.url !== 'string' || !c.url) throw new Error(`題組之案缺 url：${JSON.stringify(c).slice(0, 120)}`)
        if (!c.expect) {
            skipped.push(c)
            continue
        }
        const name = String(c.id || c.url)
        if (!OUTCOMES.includes(c.expect.outcome) || !String(c.expect.basis || '').trim()) throw new Error(`題組之案 ${name} 之 expect 不合（outcome 須為 ${OUTCOMES.join('／')} 且附 basis）`)
        if (c.expect.outcome === 'final' && !c.expect.lastReason) throw new Error(`題組之案 ${name} 為確定性失敗而未給 expect.lastReason`)
        cases.push({ ...c, name, docId: sha1(normalizeUrl(unwrapNewsUrl(c.url))) })
    }
    const ids = new Set(cases.map((c) => c.docId))
    if (ids.size !== cases.length) throw new Error('題組有重複之網址(同一身分鍵)')
    return { cases, skipped }
}

/**
 * 逐案檢核之斷言(斷言訊息會被執行器截斷:不符者逐行印出後一次斷言)
 *
 * @param {String} label 輸入判準名
 * @param {Array} list 輸入 [{ r:列, problems:Array }]
 */
function assertCases(label, list) {
    const bad = list.filter((x) => x.problems.length)
    for (const x of bad) console.log(`    ${label} 不符：[${x.r.cls}] ${x.r.name} ${x.r.url}｜應然 ${x.r.expect.outcome}（${x.r.expect.basis}）｜${x.problems.join('；')}`)
    assert.equal(bad.length, 0, `${label}：${bad.length} 案不符（見上列）`)
}

describe('api-capture-live：抓取實網測試（真網路、真瀏覽器；確定性之案逐案斷言、站方相依之案斷言分流不變式）', function() {

    this.timeout(2 * 3600_000)

    const T0 = Date.now() // 本測試開始時刻(收拾孤兒之時窗起點;容許 5 秒時鐘誤差)
    const ROOT = path.resolve(`test/_tmp/capture-live-${process.pid}`)
    const runLog = recLog()
    let aiCalls = 0
    let flow = null
    let cases = []
    let rows = []
    let df = null

    before(async function() {
        if (!LIVE) {
            console.log('    略過：未設 WK_LIVE_NET=1（本測試連外網並啟動瀏覽器）')
            this.skip()
        }
        const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
        const got = casesOf(fx)
        cases = got.cases
        assert.ok(cases.length > 0, `題組無可測之案：${FIXTURE}`)
        assert.ok(cases.some((c) => c.expect.outcome === 'final'), '題組須含確定性之案(final)')
        for (const c of got.skipped) console.log(`    未設應然,不納入：${c.cls ? `[${c.cls}] ` : ''}${c.url}`)
        fs.rmSync(ROOT, { recursive: true, force: true })
        fs.mkdirSync(ROOT, { recursive: true })
        flow = createKnowledgeCapture({
            workDir: ROOT,
            data: { seedSources: [], gridTopics: [] },
            // 名額與時間給足,使每篇皆於同一輪走完分流;領域發現停用;孤兒回收關閉(它掃整台機器,本測試另以時窗收拾自己留下者)
            capture: {
                articles: { perRun: 1000 },
                browser: { perRun: 1000, maxMs: 6_000_000, hygiene: false, camofox: { port: CAMOFOX_PORT } },
                discover: { everyHours: 0 },
            },
            aiAdapter: {
                callJson: async () => {
                    aiCalls++
                    return { ok: false, data: null, error: '抓取不得呼叫 AI', providerId: '', attempts: 0, skipped: false, errors: [] }
                },
            },
            netGuard: null,
            scheduleLimitMin: 120,
            afterRun: false,
            logFactory: () => runLog,
        })
        const cap = flow.info().settings.capture
        assert.equal(cap.browser.camofox.port, CAMOFOX_PORT)
        assert.equal(cap.browser.hygiene, false)
        const now = flow.info().clock.iso8()
        const recs = cases.map((c) => ({ id: c.docId, url: c.url, title: c.title || '', publishedAt: '', author: '', feedText: '', sourceId: 'live-sample', sourceName: '實網題組', sourceTier: 2, lang: '', collectedAt: now, status: 'new', fetchTries: 0, text: '', textLength: 0 }))
        const s = flow.openStores()
        try {
            const r = await s.docs.insertNew(recs)
            assert.equal(r.addCount, recs.length, '題組全數入庫')
        }
        finally {
            await flow.closeStores(s)
        }
        console.log(`    題組 ${FIXTURE}：${cases.length} 案（確定性 ${cases.filter((c) => c.expect.outcome === 'final').length}、站方相依 ${cases.filter((c) => c.expect.outcome !== 'final').length}）`)

        // 一輪抓取(實網)
        const t0 = Date.now()
        const rep = await flow.run()
        df = rep.stages.find((x) => x.name === '抓取')?.result?.detail?.detailFetch || null
        console.log(`    耗時 ${Math.round((Date.now() - t0) / 1000)} 秒；detailFetch：${JSON.stringify(df?.detail || null)}`)
        const s2 = flow.openStores()
        let docs = []
        try {
            docs = (await s2.docs.select()).filter((d) => cases.some((c) => c.docId === d.id))
        }
        finally {
            await flow.closeStores(s2)
        }
        const gates = createHealthGates(cap.standards)
        rows = cases.map((c) => {
            const d = docs.find((x) => x.id === c.docId) || {}
            const h = d.status === 'raw' ? planHealthRecheck(d, gates) : null
            const tb = d.status === 'raw' ? checkTitleBody(d.title, d.text) : null
            return {
                ...c,
                status: d.status || '(缺)',
                fetcher: d.fetcher || '',
                textFrom: d.textFrom || '',
                len: d.textLength || 0,
                health: h ? (h.status === STATUS.PASS ? 'ok' : `${h.status}:${h.kind || h.why}`) : '-',
                cs2: tb ? `${tb.status}${tb.detail ? `(${tb.detail})` : ''}` : '-',
                reason: d.lastReason || '',
                curlReason: d.curlReason || '',
                deadClass: d.deadClass || '',
                tries: d.fetchTries,
                deferrals: d.deferrals || 0,
                retryAt: d.retryAt || '',
                lastError: String(d.lastError || ''),
            }
        })
        for (const r of rows) {
            console.log(`    [${r.cls}] ${r.name}｜應然 ${r.expect.outcome}${r.expect.lastReason ? `:${r.expect.lastReason}` : ''}｜實得 ${r.status}${r.textFrom ? `(${r.textFrom})` : ''}${r.fetcher ? `[${r.fetcher}]` : ''} ${r.len} 字 閘 ${r.health} CS2 ${r.cs2}｜${r.reason}${r.curlReason ? `←curl:${r.curlReason}` : ''}${r.deadClass ? `｜deadClass ${r.deadClass}` : ''}｜tries ${r.tries}｜${r.lastError.slice(0, 90)}`)
        }
        console.log('    瀏覽器逐階軌跡（日誌原文）：')
        for (const l of runLog.lines.filter((x) => /瀏覽器亦失敗|瀏覽器救回|延後至瀏覽器佇列|瀏覽器環境不可用|瀏覽器：試/.test(x))) console.log(`      ${l.slice(0, 300)}`)
    })

    after(async function() {
        if (!LIVE) return
        fs.rmSync(ROOT, { recursive: true, force: true })
        const sw = await sweepOrphanBrowsers({ filter: (o) => o.createdMs >= T0 - 5_000 })
        console.log(`    收拾本測試留下之孤兒瀏覽器：${sw.skipped || `孤兒 ${sw.orphans.length}、已殺 ${sw.killed.length}、殺不掉 ${sw.failed.length}`}`)
    })

    it('環境與名額:瀏覽器環境失敗 0、配額與時間充足時無延後、全數取件、每案皆有落庫結果;抓取未呼叫 AI', () => {
        assert.ok(df, '找不到 detailFetch 之子階段報告')
        assert.equal(df.detail.browserEnvFail, 0, `瀏覽器環境失敗須為 0（斷路：${(df.detail.browserBroken || []).join('、') || '-'}）`)
        assert.equal(df.detail.browserDeferred, 0, '配額與時間充足時不得延後')
        assert.equal(df.detail.left, 0, '全數取件（未逾時間預算）')
        assert.deepEqual(rows.filter((r) => r.status === '(缺)').map((r) => r.name), [], '題組文件須在庫')
        assert.deepEqual(rows.filter((r) => r.status === 'new' && !(r.tries > 0)).map((r) => r.name), [], '每案皆已取件(tries ≥ 1 或已終態)')
        assert.equal(aiCalls, 0, '抓取不得呼叫 AI')
    })

    it('確定性之案逐案:一輪即 dead、lastReason／httpCode／deadClass 為應然、tries＝capture.articles.maxTries、是否經瀏覽器與應然相符', () => {
        const max = flow.info().settings.capture.articles.maxTries
        const list = rows.filter((r) => r.expect.outcome === 'final')
        assert.ok(list.length > 0, '題組須含確定性之案')
        assertCases('確定性', list.map((r) => {
            const p = []
            if (r.status !== 'dead') p.push(`狀態 ${r.status}（應 dead）`)
            if (r.reason !== r.expect.lastReason) p.push(`lastReason ${r.reason || '-'}（應 ${r.expect.lastReason}）`)
            if (r.expect.httpCode && !new RegExp(`\\bHTTP ${r.expect.httpCode}\\b`).test(r.lastError)) p.push(`lastError「${r.lastError.slice(0, 60)}」（應含 HTTP ${r.expect.httpCode}）`)
            if (r.expect.deadClass && r.deadClass !== r.expect.deadClass) p.push(`deadClass ${r.deadClass || '-'}（應 ${r.expect.deadClass}）`)
            if (r.tries !== max) p.push(`tries ${r.tries}（一輪即 ${max}）`)
            if (r.expect.viaBrowser === false && r.curlReason) p.push(`經瀏覽器（curlReason ${r.curlReason}；決定性失敗不得進瀏覽器）`)
            if (r.expect.viaBrowser === true && !r.curlReason) p.push('未經瀏覽器階梯（應先 curl 失敗再經瀏覽器而終態）')
            return { r, problems: p }
        }))
    })

    it('站方相依之案:分流不變式——raw、留瀏覽器佇列(new／browser／tries 1／curlReason)或暫時性 HTTP 依規則重試之一;不得 dead、不得延後', () => {
        const list = rows.filter((r) => r.expect.outcome !== 'final')
        assertCases('分流不變式', list.map((r) => {
            const p = []
            if (r.deferrals > 0) p.push(`延後 ${r.deferrals} 次（配額與時間充足時不得延後）`)
            if (r.status === 'dead') p.push(`dead（${r.reason}${r.curlReason ? `←curl:${r.curlReason}` : ''}；站方相依之案不得一輪判死——一輪即終態只限確定性失敗）`)
            else if (r.status === 'raw') { /* 無假救回另驗(下一案) */ }
            else if (r.status === 'new' && r.fetcher === 'browser') {
                if (r.tries !== 1) p.push(`tries ${r.tries}（瀏覽器頁面失敗計 1）`)
                if (!r.curlReason) p.push('無 curlReason（應經 curl 失敗後之瀏覽器階梯）')
            }
            else if (r.status === 'new' && !r.fetcher) {
                const c = classifyFetch({ ok: false, reason: r.reason, httpCode: httpCodeOf({ message: r.lastError }), fetcherId: 'article' })
                if (c.action !== 'retry') p.push(`留補全文佇列而分流為 ${c.action}/${c.cls}（只有暫時性失敗可重試）`)
                if (r.tries !== 1) p.push(`tries ${r.tries}（應 1）`)
                if (!r.retryAt) p.push('未記退避 retryAt')
                if (!p.length) console.log(`    （資訊）${r.name}：暫時性失敗依規則重試（${c.cls}：${r.lastError.slice(0, 60)}）`)
            }
            else p.push(`去向 ${r.status}${r.fetcher ? `[${r.fetcher}]` : ''} 不在分流不變式之列`)
            return { r, problems: p }
        }))
        const by = {}
        for (const r of list) {
            const k = r.status === 'raw' ? '救回' : r.fetcher === 'browser' ? '留瀏覽器佇列' : r.status
            by[k] = (by[k] || 0) + 1
        }
        const drift = list.filter((r) => (r.expect.outcome === 'rescue') !== (r.status === 'raw')).map((r) => `${r.name}（題組所記 ${r.expect.outcome}，本次 ${r.status === 'raw' ? '救回' : r.status}）`)
        console.log(`    站方相依之去向（只列資訊）：${Object.entries(by).map(([k, v]) => `${k} ${v}`).join('、')}${drift.length ? `；與題組所記不同：${drift.join('、')}` : ''}`)
    })

    it('無假救回(每篇 raw):過現版健全閘(依入口、長度條件用 fullLength)且非 CS2 確定錯頁', () => {
        const raw = rows.filter((r) => r.status === 'raw')
        assertCases('無假救回', raw.map((r) => ({ r, problems: [...(r.health !== 'ok' ? [`健全閘 ${r.health}`] : []), ...(r.cs2.startsWith(STATUS.VIOLATION) ? [`CS2 ${r.cs2}`] : [])] })))
    })
})
