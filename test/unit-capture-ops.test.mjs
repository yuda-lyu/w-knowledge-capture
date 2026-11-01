// unit-capture-ops.test.mjs — 抓取之維運能力(ops/):
//   reviveDocs(把「確定抓不到」之 dead 文件依條件放回待抓佇列:篩選、回填欄位、稽核欄)、
//   docStockFix(CS10 同一內容之存量處置:重疊群之聯集合併與「留哪一份」之計畫;本檔只出計畫,不碰筆記)
//   原文回溯(ops/refetchSources)之判定與帳另見 unit-capture-refetch
// 執行:自套件根 npx mocha test/unit-capture-ops.test.mjs(不發網路、不落檔)

import assert from 'node:assert/strict'
import { memStore } from './tools/memStore.mjs'
import { reviveDeadDocs, deadMatcher } from '../src/ops/reviveDocs.mjs'
import { mergeDupGroups, dupPlanOf } from '../src/ops/docStockFix.mjs'

const NOW = '2026-09-23T10:00:00+08:00'

describe('unit-capture-ops', function() {

    // ══════════════════════════ reviveDocs ══════════════════════════
    describe('reviveDocs', function() {

        it('reviveDeadDocs：stores 非物件或缺 docs.select/patch 拋錯；cfg.match 非函數拋既有錯(訊息不變)', async () => {
            await assert.rejects(() => reviveDeadDocs(undefined, { match: () => true }), /reviveDeadDocs 需要 stores\.docs\.select／stores\.docs\.patch（docs 集合）/)
            await assert.rejects(() => reviveDeadDocs({}, { match: () => true }), /reviveDeadDocs 需要 stores\.docs\.select／stores\.docs\.patch（docs 集合）/)
            await assert.rejects(() => reviveDeadDocs({ docs: memStore() }, {}), /reviveDeadDocs 需要 match\(doc\) 函數/)
        })

        it('deadMatcher：opt 非物件回退為 {}(恆不比對，回傳 false)', () => {
            const m0 = deadMatcher(null)
            assert.equal(m0({ url: 'https://x.com', lastError: 'boom' }), false)
            const m1 = deadMatcher('not-obj')
            assert.equal(m1({ url: 'https://x.com', lastError: 'boom' }), false)
        })

        it('deadMatcher(host) 篩出子網域，reviveDeadDocs 依 match 回填並清 fetchTries、留 revivedFrom;回傳 picked(本次回填篇數)與 byClass(類別分布;舊記錄無類別欄 → unclassified)', async () => {
            const docs = memStore([
                { id: 'd1', url: 'https://dead.example.com/x', status: 'dead', lastError: '404' },
                { id: 'd2', url: 'https://other.com/y', status: 'dead', lastError: '404' },
            ])
            const r = await reviveDeadDocs({ docs }, { match: deadMatcher({ host: 'dead.example.com' }), nowIso: NOW })
            assert.deepEqual(r, { dead: 2, matched: 1, picked: 1, revived: 1, fetchTries: 0, byClass: { unclassified: 1 }, sample: ['https://dead.example.com/x'] })
            const d1 = await docs.get('d1')
            assert.equal(d1.status, 'new')
            assert.equal(d1.fetchTries, 0)
            assert.equal(d1.revivedFrom, '404')
            const d2 = await docs.get('d2')
            assert.equal(d2.status, 'dead', '不符 host 者不受影響')
        })

        it('reviveDeadDocs/deadMatcher:依主機名(含子網域)與失敗原因回填 dead→new、fetchTries 歸零、revivedFrom 留痕;dryRun 不寫;match 必填', async () => {
            const docs = memStore([
                { id: 'd1', status: 'dead', url: 'https://www.msn.com/a', lastError: 'HTTP 403', fetchTries: 3 },
                { id: 'd2', status: 'dead', url: 'https://other.com/b', lastError: 'HTTP 403', fetchTries: 3 },
                { id: 'd3', status: 'new', url: 'https://www.msn.com/c', fetchTries: 1 },
            ])
            const m = deadMatcher({ host: 'msn.com' })
            assert.equal(m({ url: 'https://www.msn.com/x' }), true, '子網域命中')
            assert.equal(m({ url: 'https://notmsn.com/x' }), false, '同尾綴之他網域不命中')
            assert.equal(deadMatcher({})({ url: 'https://msn.com' }), false, '未給任何條件不命中(避免全量回填)')
            const dry = await reviveDeadDocs({ docs }, { match: m, nowIso: NOW, dryRun: true })
            assert.deepEqual([dry.dead, dry.matched, dry.revived], [2, 1, 0])
            assert.equal((await docs.get('d1')).status, 'dead', 'dryRun 不寫')
            const r = await reviveDeadDocs({ docs }, { match: deadMatcher({ error: '403' }), nowIso: NOW })
            assert.deepEqual([r.matched, r.revived], [2, 2])
            const d1 = await docs.get('d1')
            assert.deepEqual([d1.status, d1.fetchTries, d1.revivedFrom, d1.revivedAt], ['new', 0, 'HTTP 403', NOW])
            await assert.rejects(() => reviveDeadDocs({ docs }, {}), /需要 match/)
        })

        it('reviveDeadDocs patchOf:逐篇追加欄位(只留一次機會、指名瀏覽器佇列);status 與稽核欄不可被覆寫;非物件回傳視為不追加;patchOf 非函數拋錯', async () => {
            const docs = memStore([
                { id: 'j1', status: 'dead', url: 'https://a.com/1', lastError: 'minimal visible text (12 chars in 900 bytes HTML)', fetchTries: 3 },
                { id: 'x1', status: 'dead', url: 'https://x.com/2', lastError: 'X/Twitter error page', fetchTries: 3 },
            ])
            const patchOf = (d) => (/minimal visible text/.test(d.lastError)
                ? { fetchTries: 2, fetcher: 'browser', lastClass: 'empty', deferredAt: NOW, status: 'raw', revivedAt: 'forged', revivedFrom: 'forged' }
                : null)
            const r = await reviveDeadDocs({ docs }, { match: () => true, nowIso: NOW, patchOf })
            assert.deepEqual([r.matched, r.revived], [2, 2])
            const j1 = await docs.get('j1')
            assert.deepEqual([j1.status, j1.fetchTries, j1.fetcher, j1.lastClass, j1.deferredAt], ['new', 2, 'browser', 'empty', NOW], '追加欄位生效、status 恆為 new')
            assert.deepEqual([j1.revivedAt, j1.revivedFrom], [NOW, 'minimal visible text (12 chars in 900 bytes HTML)'], '稽核欄恆由本函數寫')
            const x1 = await docs.get('x1')
            // 回傳 null＝不追加:預設 tries 歸零;路由欄重設為補全文佇列(''——回填時一律重設當前狀態欄)
            assert.deepEqual([x1.status, x1.fetchTries, x1.fetcher], ['new', 0, ''], '回傳 null＝不追加(預設 tries 歸零、不指名抓取器)')
            await assert.rejects(() => reviveDeadDocs({ docs }, { match: () => true, nowIso: NOW, patchOf: 'x' }), /patchOf 須為函數/)
        })

        it('reviveDeadDocs 之 fetchTries 預設(回收政策歸抓取):給了 cfg.capture 而未明給 → capture.articles.maxTries−1(只剩一次機會);明給者優先;皆無為 0;生效值隨結果回傳', async () => {
            const mk = () => memStore([{ id: 'a', status: 'dead', url: 'https://a.com/1', lastError: 'HTTP 500' }])
            const cap = (maxTries) => ({ articles: { maxTries }, browser: { perRun: 0 } })
            for (const [cfg, want] of [[{ capture: cap(3) }, 2], [{ capture: cap(1) }, 0], [{ capture: cap(3), fetchTries: 1 }, 1], [{}, 0]]) {
                const docs = mk()
                const r = await reviveDeadDocs({ docs }, { match: () => true, nowIso: NOW, ...cfg })
                assert.deepEqual([r.fetchTries, (await docs.get('a')).fetchTries], [want, want], JSON.stringify(cfg))
            }
            // dryRun 亦回傳生效值(預演輸出用)
            assert.equal((await reviveDeadDocs({ docs: mk() }, { match: () => true, nowIso: NOW, dryRun: true, capture: cap(4) })).fetchTries, 3)
        })
    })

    // ══════════════════════════ docStockFix ══════════════════════════
    describe('docStockFix(CS10 存量處置之計畫)', function() {

        it('mergeDupGroups:重疊之群以聯集合併為連通群(依首個 id 排序);單一成員之群不成群', () => {
            assert.deepEqual(mergeDupGroups([['a', 'b'], ['b', 'c'], ['x', 'y'], ['z']]), [['a', 'b', 'c'], ['x', 'y']])
            assert.deepEqual(mergeDupGroups([['y', 'x'], ['b', 'a']]), [['a', 'b'], ['x', 'y']], '群內 id 與群之間皆排序')
            assert.deepEqual(mergeDupGroups(null), [])
            assert.deepEqual(mergeDupGroups([null, 'x', [], ['']]), [], '非陣列項與空 id 略過')
        })

        it('dupPlanOf:留存序＝已消化(extractedAt) > 有筆記 > 較早成筆記;他份之筆記與是否已消化列於 others', () => {
            const notes = { d1: { id: 'n1' }, d2: { id: 'n2', extractedAt: 't' }, d3: null }
            const p = dupPlanOf(['d1', 'd2', 'd3'], { docOf: (id) => ({ id, notedAt: { d1: '1', d2: '2', d3: '0' }[id] }), noteOfDoc: (id) => notes[id] })
            assert.deepEqual([p.keeper, p.keeperNote, p.others.map((o) => [o.doc, o.note])], ['d2', 'n2', [['d1', 'n1'], ['d3', null]]])
            assert.deepEqual(p.others.map((o) => o.consumed), [false, false])
            assert.deepEqual(p.deferred, [], '未給 edges 時全群視為互連')
        })

        it('dupPlanOf:無筆記集合(noteOfDoc 恆回 null)時只剩較早成筆記(notedAt,缺則取 createdAt)與 id 決定留哪一份', () => {
            const docs = { d1: { notedAt: '2026-02-01' }, d2: { notedAt: '2026-01-01' }, d3: { createdAt: '2026-01-01' } }
            const p = dupPlanOf(['d1', 'd3', 'd2'], { docOf: (id) => docs[id], noteOfDoc: () => null })
            assert.deepEqual([p.keeper, p.keeperNote, p.others.map((o) => o.doc)], ['d2', null, ['d3', 'd1']], '同 notedAt 者依 id')
            assert.deepEqual(dupPlanOf([], { docOf: () => null, noteOfDoc: () => null }), { keeper: '', keeperNote: null, others: [], deferred: [] })
        })

        it('dupPlanOf:只處置與留存者同屬一個原始群者,其餘列 deferred(段落重疊不具傳遞性,不連坐刪除不同之文章)', () => {
            const docOf = (id) => ({ id, notedAt: `2026-0${id === 'A' ? 1 : 2}-01` })
            const noteOfDoc = (id) => ({ id: `n${id}`, ...(id === 'A' ? { extractedAt: '2026-03-01' } : {}) })
            const p = dupPlanOf(['A', 'B', 'C'], { docOf, noteOfDoc, edges: [['A', 'B'], ['B', 'C']] })
            assert.deepEqual([p.keeper, p.others.map((o) => o.doc), p.deferred], ['A', ['B'], ['C']], '留 A(已消化);C 與 A 無直接重疊 → 不處置')
            const q = dupPlanOf(['A', 'B', 'C'], { docOf, noteOfDoc })
            assert.deepEqual([q.others.length, q.deferred], [2, []], '未給 edges 時全群視為互連')
        })
    })
})
