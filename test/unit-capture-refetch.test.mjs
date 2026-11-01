// unit-capture-refetch.test.mjs — 已消化文件之原文回溯(ops/refetchSources;CS13 原文可回溯):依原取得方式重取、身分比對不符即不另存、
//   只寫 docTexts 與處置帳、預演不寫、重跑略過已有結論者;筆記集合可缺;網路層以替身注入(不發任何請求)
// 執行:自套件根 node <mocha> --timeout 180000 test/unit-capture-refetch.test.mjs(暫存 test/_tmp/refetch-<pid>,測完即刪)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { memStore } from './tools/memStore.mjs'
import { settingsOf } from './tools/captureTestKit.mjs'
import { genClockTZ } from '../src/core/runnerPackage.mjs'
import { docTextOf } from '../src/core/stores/docTexts.mjs'
import { createHealthGates } from '../src/stores/healthRecheck.mjs'
import { titleKeyOf, refetchMethodOf, judgeArticleRefetch, judgeAbstractRefetch, refetchSources, REFETCH_LEDGER_FILE } from '../src/ops/refetchSources.mjs'

const TMP = path.resolve(`test/_tmp/refetch-${process.pid}`).replace(/\\/g, '/')
const clock = genClockTZ('Asia/Taipei')
const ABS = 'We study momentum portfolios in US equities from 1990 to 2020 and find annual excess returns of about seven percent. '.repeat(4).trim()
const BODY = (title) => `${title}\n\n${'動量策略之實證研究顯示，買進過去贏家並放空過去輸家之組合，於樣本期間內有顯著之超額報酬，且於控制規模與價值因子後仍然存在。'.repeat(8)}`

describe('unit-capture-refetch', function() {

    before(() => fs.mkdirSync(TMP, { recursive: true }))
    after(() => fs.rmSync(TMP, { recursive: true, force: true }))

    it('純函數:題名比對鍵(實體、標點、大小寫無關);方法依原取得方式與網址(arXiv／DOI／其餘 OpenAlex 題名;非摘要一律正文)', () => {
        assert.equal(titleKeyOf('Momentum &amp; Value: A Study.'), titleKeyOf('momentum & value — a study'))
        // 原網址帶版本者保留版本(取回同一版之摘要);不帶者取現行版
        assert.deepEqual(refetchMethodOf({ textFrom: 'abstract', url: 'https://arxiv.org/abs/2301.13235v2' }), { method: 'arxiv', key: '2301.13235v2' })
        assert.deepEqual(refetchMethodOf({ textFrom: 'abstract', url: 'https://arxiv.org/abs/2301.13235' }), { method: 'arxiv', key: '2301.13235' })
        assert.deepEqual(refetchMethodOf({ textFrom: 'abstract', url: 'https://doi.org/10.1007/S10614-025' }), { method: 'openalex-doi', key: 'https://doi.org/10.1007/s10614-025' })
        assert.equal(refetchMethodOf({ textFrom: 'abstract', url: 'http://hdl.handle.net/2027.42/61659' }).method, 'openalex-title')
        for (const tf of ['article', 'adapter:msn', 'feed', '']) assert.equal(refetchMethodOf({ textFrom: tf, url: 'https://arxiv.org/abs/1' }).method, 'article')
    })

    it('判定:API 記錄題名相同且摘要合 grid 判準 → 另存(前 4,000 字);題名不同 → identity-mismatch;查無 → not-found;網頁須過健全閘且 CS2 合格(未能判定不算相符)', () => {
        const d = { title: 'Momentum in US Equities', url: 'https://doi.org/10.1/x' }
        assert.deepEqual(judgeAbstractRefetch(d, { title: 'Momentum in US equities.', abstract: ABS }).outcome, 'archived')
        assert.equal(judgeAbstractRefetch(d, { title: 'Value in Europe', abstract: ABS }).outcome, 'identity-mismatch', '依題名搜尋者:題名不同即不符')
        const byId = judgeAbstractRefetch({ ...d, title: 'AMM 流動性提供策略的參數影響量測' }, { title: 'Automated Market Makers', abstract: ABS }, { byId: true })
        assert.deepEqual([byId.outcome, /以編號確認同一記錄/.test(byId.why)], ['archived', true], '依編號查得者:編號即身分(記錄標題被改寫只註記)')
        assert.equal(judgeAbstractRefetch(d, null).outcome, 'not-found')
        assert.equal(judgeAbstractRefetch(d, { title: d.title, abstract: 'short' }).outcome, 'gate-failed')
        const gates = createHealthGates({ minTextChars: 300 })
        const doc = { title: '台股動量策略之長期實證研究', url: 'https://e.com/a' }
        assert.equal(judgeArticleRefetch(doc, { ok: true, title: doc.title, content: BODY(doc.title) }, { gates, maxTextChars: 20000 }).outcome, 'archived')
        const OTHER = '天氣預報顯示本週末將有鋒面通過，北部地區降雨機率提高，山區請注意午後雷陣雨與低溫，出門記得攜帶雨具並注意保暖。'.repeat(8)
        assert.equal(judgeArticleRefetch(doc, { ok: true, title: 'x', content: OTHER }, { gates, maxTextChars: 20000 }).outcome, 'identity-mismatch', '網頁已改為他文')
        assert.equal(judgeArticleRefetch(doc, { ok: true, content: '太短' }, { gates, maxTextChars: 20000 }).outcome, 'gate-failed')
        assert.equal(judgeArticleRefetch(doc, { ok: false, reason: 'http-error', message: 'HTTP 404' }, { gates, maxTextChars: 20000 }).outcome, 'fetch-failed')
        assert.equal(judgeArticleRefetch({ title: 'AB', url: 'https://e.com/b' }, { ok: true, content: BODY('AB') }, { gates, maxTextChars: 20000 }).outcome, 'identity-mismatch', '標題詞過少且頁面標題不含 → 無法確認同一篇')
        const short = { title: 'Deep kernel hedging', url: 'https://arxiv.org/abs/2609.34474' }
        const sc = `Deep kernel hedging. ${'We propose a kernel based hedging method for derivatives and evaluate it on simulated and market data with transaction costs. '.repeat(5)}`
        assert.equal(judgeArticleRefetch(short, { ok: true, title: '[2609.34474] Deep kernel hedging', content: sc }, { gates, maxTextChars: 20000 }).outcome, 'archived', '頁面自身之標題含記錄標題 → 同一篇')
        assert.equal(judgeArticleRefetch(short, { ok: true, title: 'arXiv listing', content: sc }, { gates, maxTextChars: 20000 }).outcome, 'identity-mismatch')
    })

    it('op:預演不寫;apply 依方法重取、只寫 docTexts 與處置帳(textFrom refetch:<方法>)、不改 docs;重跑略過已有結論者,retry 才重試;已另存者不再列', async () => {
        const at = '2026-09-01T00:00:00+08:00'
        const docs = memStore([
            { id: 'dA', status: 'noted', textFrom: 'abstract', url: 'https://arxiv.org/abs/2301.00001', title: 'Momentum Crashes', notedAt: at },
            { id: 'dB', status: 'noted', textFrom: 'abstract', url: 'http://hdl.handle.net/1/b', title: 'Value Premium Revisited', notedAt: at },
            { id: 'dC', status: 'noted', textFrom: 'article', url: 'https://e.com/c', title: '台股動量策略之長期實證研究', notedAt: at },
            { id: 'dD', status: 'noted', textFrom: 'article', url: 'https://e.com/d', title: '台股價值因子之長期實證研究', notedAt: at },
            { id: 'dE', status: 'noted', textFrom: 'article', url: 'https://e.com/e', title: '有原文者', text: '已有原文', notedAt: at },
            { id: 'dF', status: 'skip', textFrom: 'article', url: 'https://e.com/f', title: '非筆記來源', notedAt: at },
        ])
        const notes = memStore(['dA', 'dB', 'dC', 'dD', 'dE'].map((d, i) => ({ id: `n${i}`, docId: d })))
        const docTexts = memStore([])
        const calls = []
        const refetch = {
            arxiv: async (ids) => {
                calls.push(['arxiv', ids])
                return new Map([['2301.00001', { title: 'Momentum crashes', abstract: ABS }]])
            },
            openalexDoi: async (dois) => {
                calls.push(['doi', dois])
                return new Map()
            },
            // 依題名搜尋:同名而網址不同之另一記錄 → 不採(查無)
            openalexTitle: async (title) => {
                calls.push(['title', title])
                return [{ title: 'Value premium revisited', abstract: ABS, url: 'https://doi.org/10.9/other' }]
            },
            article: async (url) => {
                calls.push(['article', url])
                return url.endsWith('/c') ? { ok: true, title: 'x', content: BODY('台股動量策略之長期實證研究') } : { ok: false, reason: 'http-error', message: 'HTTP 404' }
            },
        }
        const deps = { stores: { docs, notes, docTexts }, dirs: { state: `${TMP}/state` }, clock, log: { info: () => {}, warn: () => {} }, settings: settingsOf({ standards: { minTextChars: 300 }, articles: { maxTextChars: 20000 } }), refetch }
        const pre = await refetchSources(deps, {})
        assert.deepEqual([pre.candidates, pre.byMethod, calls.length, fs.existsSync(`${TMP}/state/${REFETCH_LEDGER_FILE}`)], [4, { arxiv: 1, 'openalex-title': 1, article: 2 }, 0, false], '預演不抓不寫')
        const r = await refetchSources(deps, { apply: true })
        assert.deepEqual(r.outcomes, { archived: 2, 'not-found': 1, 'fetch-failed': 1 })
        const a = await docTextOf({ docs, docTexts }, 'dA')
        assert.deepEqual([a.textFrom, a.text.length > 0, a.from], ['refetch:arxiv', true, 'archive'])
        assert.equal((await docTextOf({ docs, docTexts }, 'dC')).textFrom, 'refetch:article')
        assert.equal(await docTextOf({ docs, docTexts }, 'dB'), null, '同名而網址不同之記錄 → 不採、不另存')
        assert.equal((await docs.get('dA')).text, undefined, '不改 docs')
        const led = fs.readFileSync(`${TMP}/state/${REFETCH_LEDGER_FILE}`, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
        assert.deepEqual(led.map((x) => [x.id, x.outcome]).sort(), [['dA', 'archived'], ['dB', 'not-found'], ['dC', 'archived'], ['dD', 'fetch-failed']])
        // 重跑:已另存者不再列、帳上有結論者略過;retry 只重試 fetch-failed(抓取或端點失敗);retry 'all' 連同內容判定(not-found 等)
        //   (內容判定之結論以同一網址再抓多半同一結果,不應隨 retry 一併重試)
        calls.length = 0
        const again = await refetchSources(deps, { apply: true })
        assert.deepEqual([again.candidates, calls.length], [0, 0])
        const re = await refetchSources(deps, { retry: true })
        assert.deepEqual([re.candidates, re.byMethod], [1, { article: 1 }])
        const reAll = await refetchSources(deps, { apply: true, retry: 'all' })
        assert.deepEqual([reAll.candidates, reAll.byMethod], [2, { 'openalex-title': 1, article: 1 }])
    })

    it('對象之定義:有筆記集合(stores.notes)時限於被筆記引用之 noted 文件;筆記集合可缺,缺時對象為全部無原文之 noted 文件(有原文者、非 noted 者不列),apply 照常另存', async () => {
        const at = '2026-09-01T00:00:00+08:00'
        const T1 = '台股動量策略之長期實證研究'
        const T2 = '台股價值因子之長期實證研究'
        const docs = memStore([
            { id: 'a1', status: 'noted', textFrom: 'article', url: 'https://e.com/a1', title: T1, notedAt: at },
            { id: 'a2', status: 'noted', textFrom: 'article', url: 'https://e.com/a2', title: T2, notedAt: at }, // 已消化而無筆記記錄
            { id: 'a3', status: 'noted', textFrom: 'article', url: 'https://e.com/a3', title: '有原文者', text: '已有原文', notedAt: at },
            { id: 'a4', status: 'skip', textFrom: 'article', url: 'https://e.com/a4', title: '非 noted', notedAt: at },
        ])
        const docTexts = memStore([])
        const refetch = { article: async (url) => ({ ok: true, title: 'x', content: BODY(url.endsWith('/a1') ? T1 : T2) }) }
        const base = { stores: { docs, docTexts }, dirs: { state: `${TMP}/state-notes` }, clock, log: { info: () => {}, warn: () => {} }, settings: settingsOf({ standards: { minTextChars: 300 }, articles: { maxTextChars: 20000 } }), refetch }
        const idsOf = (r) => r.sample.map((s) => s.split('｜')[0])
        // 有筆記集合:只列被筆記引用者
        const withNotes = await refetchSources({ ...base, stores: { ...base.stores, notes: memStore([{ id: 'n1', docId: 'a1' }]) } }, {})
        assert.deepEqual([withNotes.candidates, idsOf(withNotes)], [1, ['a1']])
        // 無筆記集合:全部無原文之 noted 文件(a3 有原文、a4 非 noted 皆不列)
        const noNotes = await refetchSources(base, {})
        assert.deepEqual([noNotes.candidates, idsOf(noNotes)], [2, ['a1', 'a2']])
        const r = await refetchSources(base, { apply: true })
        assert.deepEqual(r.outcomes, { archived: 2 })
        assert.equal((await docTextOf({ docs, docTexts }, 'a2')).textFrom, 'refetch:article', '無筆記記錄之已消化文件亦可回溯另存')
    })
})
