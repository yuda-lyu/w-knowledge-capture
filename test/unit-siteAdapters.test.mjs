// unit-siteAdapters.test.mjs — 站台 adapter:自帶清單與合併;接入 fetchArticle/內建抓取器/落庫之接線
// 執行:自套件根 node <mocha> --timeout 180000 test/unit-siteAdapters.test.mjs
//
// msn 之實作由 w-fetch-web 內建(見 fetchers/siteAdapters.mjs 檔頭),故本檔不測其行為,
// 改測兩件本套件真正負責的事:①自帶清單不蓋掉套件內建 ②套件內建之 msn 仍是本套件所依賴的形態
// (上游若改掉掛點或旗標,此處會紅,提醒重新評估——而非等生產輪次靜默退化)。
// msn 之端到端行為屬真網路驗證,不放進單元測試。
// 不發真網路:假網域 adapter 於本行程內回應,經 w-fetch-web 真實執行且 fallback:false,不觸發 curl

import assert from 'node:assert/strict'
import { isValidAdapter } from 'w-fetch-web/src/adapterContract.mjs'
import { defaultAdapters } from 'w-fetch-web/src/fetchWeb.mjs'
import { DEFAULT_SITE_ADAPTERS, mergeSiteAdapters } from '../src/fetchers/siteAdapters.mjs'
import { fetchArticle } from '../src/fetchers/articleParse.mjs'
import { createDefaultFetchers } from '../src/fetchers/defaultFetchers.mjs'
import { mwPersistOutcome } from '../src/stages/detailFetchStage.mjs'
import { composeChain, makeMsg } from '../src/core/kernel.mjs'
import { genClockTZ } from '../src/core/runnerPackage.mjs'
import { resolveSettings } from '../src/core/settingsDefault.mjs'
import { memStore } from './tools/memStore.mjs'
import { nullLogger } from './tools/nullLogger.mjs'

const BODY = `<p>${'Gradient clipping bounds the update norm so that rare large gradients cannot derail training. '.repeat(4)}</p>` +
  `<p>${'Learning rate warmup stabilizes early optimization only when the schedule matches the batch size. '.repeat(4)}</p>`
const log = nullLogger()

/** 假網域之 fetch adapter:驗接線用,不發網路 */
const fakeAdapter = {
    id: 'fake',
    match: /^https:\/\/capture-test\.invalid\//,
    fallback: false,
    fetch: async () => ({ status: 'success', html: `<html><head><title>T</title></head><body><article><h1>T</h1>${BODY}</article></body></html>` }),
}


describe('unit-siteAdapters', function() {

    // ── 自帶清單與套件內建之分工 ──
    it('自帶清單為空:msn 由 w-fetch-web 內建,本套件不以同網域 adapter 搶先命中', () => {
        assert.deepEqual([...DEFAULT_SITE_ADAPTERS], [])
        assert.equal(DEFAULT_SITE_ADAPTERS.some((a) => /msn/i.test(a.id)), false)
    })
    it('所依賴之 w-fetch-web 內建 msn:fetch 掛點、inspect 與 fallback 皆嚴格 false、match 認 ar/vi 不認 gm', () => {
        const msn = defaultAdapters.find((a) => a.id === 'msn')
        assert.ok(msn, 'w-fetch-web 內建清單已無 msn——本套件不含自帶版,須重新評估')
        assert.equal(isValidAdapter(msn), true)
        assert.equal(typeof msn.fetch, 'function')
        assert.equal(msn.inspect, false)
        assert.equal(msn.fallback, false)
        assert.deepEqual(msn.match('https://www.msn.com/en-us/money/economy/x/ar-AA1X4Z9P'), { kind: 'ar', id: 'AA1X4Z9P' })
        assert.deepEqual(msn.match('https://www.msn.com/en-us/money/topstocks/x/vi-AA26yIpz'), { kind: 'vi', id: 'AA26yIpz' })
        assert.equal(msn.match('https://www.msn.com/en-us/news/other/x/gm-GML610C95A'), null)
    })

    // ── mergeSiteAdapters ──
    it('mergeSiteAdapters:未注入回自帶(空);注入者排前;同 id 置換自帶', () => {
        assert.deepEqual(mergeSiteAdapters(DEFAULT_SITE_ADAPTERS, undefined).map((a) => a.id), [])
        const mine = { id: 'x', match: /x\.com/, parse: () => ({ success: false }) }
        assert.deepEqual(mergeSiteAdapters(DEFAULT_SITE_ADAPTERS, [mine]).map((a) => a.id), ['x'])
        const own = Object.freeze({ id: 'y', match: /y\.com/, parse: () => ({ success: false }) })
        const mineY = { id: 'y', match: /y\.com/, parse: () => ({ success: true }) }
        const merged = mergeSiteAdapters([own], [mineY])
        assert.equal(merged.length, 1)
        assert.equal(merged[0], mineY)
    })
    it('mergeSiteAdapters:不合契約者啟動期拋錯(w-fetch-web 會靜默略過,本套件不允許)', () => {
        assert.throws(() => mergeSiteAdapters(DEFAULT_SITE_ADAPTERS, [{ id: 'bad', match: /x/ }]), /siteAdapters\[0\].*bad/)
        assert.throws(() => mergeSiteAdapters(DEFAULT_SITE_ADAPTERS, [{ match: /x/, parse: () => ({}) }]), /siteAdapters\[0\]/)
    })
    it('mergeSiteAdapters:誤傳單一物件(非陣列)→ 拋錯(與 cfg.fetchers 同一處置,不靜默當成未注入);null 視為未注入', () => {
        assert.throws(() => mergeSiteAdapters(DEFAULT_SITE_ADAPTERS, { id: 'x', match: /x/, parse: () => ({}) }), /cfg\.siteAdapters 須為站台 adapter 陣列/)
        assert.throws(() => mergeSiteAdapters(DEFAULT_SITE_ADAPTERS, 'x'), /cfg\.siteAdapters 須為站台 adapter 陣列/)
        assert.deepEqual(mergeSiteAdapters(DEFAULT_SITE_ADAPTERS, null), [])
    })

    // ── 接線:經 w-fetch-web 真實執行 ──
    it('fetchArticle 之 options.adapters 生效(假網域 fetch adapter,不發網路)', async () => {
        const a = await fetchArticle('https://capture-test.invalid/p/1', { timeoutMs: 5000, adapters: [fakeAdapter] })
        assert.equal(a.ok, true, `失敗：${a.reason} ${a.message}`)
        assert.equal(a.method, 'adapter')
        assert.equal(a.adapterId, 'fake')
        assert.match(a.content, /learning rate warmup stabilizes early optimization/i)
    })
    it('fetchArticle 未給 adapters 時不停用套件內建:註冊清單為空仍不影響內建命中之途徑(curl 以 _fetchers 替身,不發任何網路請求含 DNS)', async () => {
        // 本套件不傳 useDefaultAdapters(預設 true),故空清單 ≠ 停用內建;
        // 以假網域驗「空清單時仍照常執行、不因此拋錯或跳過 adapter 機制」。curl 階走替身,測試完全離線(不真打 curl 查 .invalid 而產生 DNS 查詢)
        let curlCalls = 0
        const offlineCurl = async (url) => {
            curlCalls++
            return { status: 'error', url, reason: 'curl-error', message: 'offline stub' }
        }
        const a = await fetchArticle('https://capture-test.invalid/p/1', { timeoutMs: 5000, adapters: [], _fetchers: { curl: offlineCurl } })
        assert.equal(curlCalls, 1, 'curl 階走替身')
        assert.equal(a.ok, false, '假網域無 adapter 命中時應走 curl 而失敗')
        assert.notEqual(a.reason, '')
    })
    it('內建抓取器 article:siteAdapters 傳至 fetchArticle,extra 帶回 method/adapterId/finalUrl(內容未經轉址時 finalUrl 為空)', async () => {
        const art = createDefaultFetchers({ articleTimeoutMs: 5000, siteAdapters: [fakeAdapter] }).find((f) => f.id === 'article')
        const r = await art.fetch({ url: 'https://capture-test.invalid/p/2' })
        assert.equal(r.ok, true, `失敗：${r.reason} ${r.message}`)
        assert.deepEqual(r.extra, { method: 'adapter', adapterId: 'fake', finalUrl: '' })
        assert.match(r.text, /learning rate warmup/i)
    })
    it('落庫 textFrom:經 adapter 者記 adapter:<id>,否則 article', async () => {
        const docs = memStore([{ id: 'a', status: 'new' }, { id: 'b', status: 'new' }])
        const deps = { stores: { docs }, settings: resolveSettings({ capture: { articles: { maxTries: 3, maxTextChars: 10000 } } }), clock: genClockTZ('Asia/Taipei') }
        const run = (id, extra) => composeChain([mwPersistOutcome()], { chainName: 'x' })(
            makeMsg('doc', { id, _tries: 1, _fetched: { ok: true, text: 'x'.repeat(60), title: 't', extra } }, { stage: 'detailFetch' }),
            { deps, log },
        )
        await run('a', { method: 'adapter', adapterId: 'msn' })
        await run('b', {})
        assert.equal((await docs.get('a')).textFrom, 'adapter:msn')
        assert.equal((await docs.get('b')).textFrom, 'article')
    })

})
