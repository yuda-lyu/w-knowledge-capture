// unit-log-contract.test.mjs — 抓取之日誌契約(logContract):外部巡檢判讀抓取段日誌之字樣與正則,須對得上本套件實際產出之日誌行
// 規則(出自 logContract 檔頭):
//   ①CAPTURE_LOG_PARSE 之正則解析補全文段實際之積壓行,所得數字＝該段 report 之 detail(queued／queuedOldestDays)
//   ②CAPTURE_LOG_MUST_SEE 涵蓋鏈異常與環境類之實際 WARN(行內即使含已知字樣亦須見)
//   ③CAPTURE_LOG_KNOWN 涵蓋常態之實際 WARN(瀏覽器亦失敗等);三類皆為可編譯之正則片段
//   (段落完成行之 newDocs 正則另以真實流程之日誌檔驗證:unit-flow-capture A8c)
// 執行:自套件根 npx mocha test/unit-log-contract.test.mjs(暫存 test/_tmp/log-contract-<pid>,測完即刪;記憶體集合,不連網、不開瀏覽器)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { memStore } from './tools/memStore.mjs'
import { deepMerge } from './tools/captureTestKit.mjs'
import { recLog } from './tools/testKit.mjs'
import { genClockTZ } from '../src/core/runnerPackage.mjs'
import { defineMw } from '../src/core/kernel.mjs'
import { resolveSettings } from '../src/core/settingsDefault.mjs'
import { createBrowserFetcher } from '../src/fetchers/browserFetcher.mjs'
import { stageDetailFetch } from '../src/stages/detailFetchStage.mjs'
import { CAPTURE_LOG_KNOWN, CAPTURE_LOG_MUST_SEE, CAPTURE_LOG_PARSE } from '../src/logContract.mjs'

const clock = genClockTZ('Asia/Taipei')
const TMP = path.resolve(`test/_tmp/log-contract-${process.pid}`)
const LONG = (s) => `${s}。本段說明研究設計、樣本期間、交易成本假設與穩健性檢驗之結果。`.repeat(12)
const KNOWN = new RegExp(CAPTURE_LOG_KNOWN.join('|'))
const MUST_SEE = new RegExp(CAPTURE_LOG_MUST_SEE.join('|'))
const CAP = {
    articles: { perRun: 10, maxTries: 3, maxTextChars: 20000, aggregatorLinksPerDoc: 12, timeoutMs: 1000, skipTitlePatterns: [] },
    standards: { minFallbackChars: 300, minTextChars: 300 },
    browser: { perRun: 3, maxMs: 600000, navTimeoutMs: 20000, camofox: { enabled: true, port: 19417 } },
}
const DAY = 86400_000
// 多退一小時:補全文段之現在時刻取自 clock(秒級),與本檔之毫秒時刻同秒時會少算一天
const ago = (d) => new Date(Date.now() - d * DAY - 3600_000).toISOString()
const doc = (id, extra = {}) => ({ id, status: 'new', title: `文章 ${id}`, url: `https://site.example/${id}`, fetchTries: 0, sourceTier: 2, collectedAt: ago(1), ...extra })

/**
 * 補全文段之環境:article 抓取器依 outcomes 回傳(值為函數者呼叫之——可拋錯),瀏覽器抓取器以注入之子行程替身執行
 *
 * @param {Array} rows 輸入文件
 * @param {Object} outcomes 輸入 id → 抓取結果
 * @param {Function} [cli] 輸入子行程替身之結果函數
 * @param {Object} [stageOpt={}] 輸入子階段 opt(如 chain:換動作鏈)
 * @returns {Object} 回傳 { docs, run }
 */
function env(rows, outcomes, cli, stageOpt = {}) {
    const docs = memStore(rows)
    const runCli = async () => cli()
    const article = { id: 'article', retries: 0, retryDelayMs: 0, timeoutMs: 1000, fetch: async (d) => outcomes[d.id] || { ok: true, text: LONG('正常正文') } }
    const browser = createBrowserFetcher({ runCli })
    const registry = { resolve: (role, d) => (d.fetcher === 'browser' ? browser : article), label: () => 'x' }
    const deps = { stores: { docs }, registry, seen: { idOf: () => 'zz' }, settings: resolveSettings({ capture: deepMerge(CAP, {}) }), clock, dirs: { tmp: TMP } }
    return { docs, run: (log) => stageDetailFetch({ runCli, ...stageOpt }).run({ deps, log }) }
}
/** 逐篇動作鏈拋錯之環(程式／環境問題;補全文段之 onFail 落帳並 WARN「逐篇鏈異常」) */
const boom = defineMw({ name: 'boom', handle: async () => { throw new Error('動作鏈實作錯誤') } })

describe('unit-log-contract', function() {

    this.timeout(60_000)
    before(() => fs.mkdirSync(TMP, { recursive: true }))
    after(() => fs.rmSync(TMP, { recursive: true, force: true }))

    it('三類皆為可編譯之正則片段;必看字樣為純文字(不含正則語法,併入總表不改他人之語意)', () => {
        assert.ok(CAPTURE_LOG_KNOWN.length > 0 && CAPTURE_LOG_MUST_SEE.length > 0)
        for (const p of [...CAPTURE_LOG_KNOWN, ...CAPTURE_LOG_MUST_SEE]) assert.doesNotThrow(() => new RegExp(p), p)
        for (const p of CAPTURE_LOG_MUST_SEE) assert.ok(!/[\\^$.*+?()[\]{}|]/.test(p), `必看字樣不含正則語法:${p}`)
        for (const re of Object.values(CAPTURE_LOG_PARSE)) assert.ok(re instanceof RegExp)
        assert.ok(Object.isFrozen(CAPTURE_LOG_KNOWN) && Object.isFrozen(CAPTURE_LOG_MUST_SEE) && Object.isFrozen(CAPTURE_LOG_PARSE))
    })

    it('①積壓行之正則:解析補全文段實際之「待抓內文 N 篇（未試…、重試…、退避中…、最舊 M 天）」,數字＝report 之 queued／queuedOldestDays', async () => {
        const later = new Date(Date.now() + 3 * 3600_000).toISOString()
        const e = env([doc('a', { collectedAt: ago(9) }), doc('bb', { fetchTries: 1 }), doc('ccc', { fetchTries: 1, retryAt: later, collectedAt: ago(4) })], {})
        const log = recLog()
        const r = await e.run(log)
        const line = log.lines.find((l) => /待抓內文/.test(l))
        assert.ok(line, log.lines.join('\n'))
        assert.match(line, /（未試 1、重試 1、退避中 1、最舊 9 天）/, '前提:現行格式含未試／重試／退避中')
        assert.deepEqual([Number(line.match(CAPTURE_LOG_PARSE.queued)[1]), Number(line.match(CAPTURE_LOG_PARSE.queuedDays)[1])], [r.detail.queued, r.detail.queuedOldestDays])
        assert.deepEqual([r.detail.queued, r.detail.queuedOldestDays, r.detail.queuedBackoff], [3, 9, 1])
        // 舊格式(無組成)之日誌亦可解析(巡檢讀近數日之舊日誌)
        assert.equal(Number('待抓內文 7 篇（最舊 40 天），本輪取 27'.match(CAPTURE_LOG_PARSE.queuedDays)[1]), 40)
    })

    it('②必看:瀏覽器環境不可用、逐篇鏈異常之實際 WARN 皆命中必看(行內含已知字樣「內文[」亦須見);③已知:瀏覽器亦失敗之實際 WARN 命中已知、不命中必看', async () => {
        const envFail = () => ({ status: 'error', reason: 'browser-env', message: 'Chrome 無法啟動', envBroken: ['playwright', 'camofox'], steps: [] })
        const e1 = env([doc('e1')], { e1: { ok: false, reason: 'empty', message: 'shell' } }, envFail)
        const l1 = recLog()
        await e1.run(l1)
        const envLine = l1.lines.find((l) => /^WARN .*瀏覽器環境不可用/.test(l))
        assert.ok(envLine, l1.lines.join('\n'))
        assert.ok(MUST_SEE.test(envLine) && KNOWN.test(envLine), '環境不可用:行首「內文[」為已知字樣,仍須見')
        const e2 = env([doc('t1')], {}, envFail, { chain: [boom] })
        const l2 = recLog()
        await e2.run(l2)
        const chainLine = l2.lines.find((l) => /^WARN .*逐篇鏈異常/.test(l))
        assert.ok(chainLine && MUST_SEE.test(chainLine), l2.lines.join('\n'))
        const pageFail = () => ({ status: 'error', reason: 'camofox-empty', message: 'snapshot empty', final: false, envBroken: [], steps: [{ step: 'camofox', ok: false, reason: 'camofox-empty' }] })
        const e3 = env([doc('f1')], { f1: { ok: false, reason: 'http-error', message: 'HTTP 403', extra: { httpCode: 403 } } }, pageFail)
        const l3 = recLog()
        await e3.run(l3)
        const failLine = l3.lines.find((l) => /^WARN .*瀏覽器亦失敗/.test(l))
        assert.ok(failLine && KNOWN.test(failLine) && !MUST_SEE.test(failLine), l3.lines.join('\n'))
    })
})
