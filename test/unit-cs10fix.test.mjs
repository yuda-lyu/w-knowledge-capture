// unit-cs10fix.test.mjs — 檢定標準 CS10(同一內容只入庫一次)之存量處置:預演 → 套用(寫入帳)→ 讀帳 → 回退 → 再預演回到原群
// 規則(出自 standards/cs10Fix 檔頭):
//   ①目標取自符合度掃描之違反(已豁免者不在其列);群之合併與留存者之選定:有筆記集合者依 已消化 > 有筆記 > 較早成筆記 > id,未給者只依 較早成筆記 > id
//   ②只處置與留存者直接相連者,其餘列 deferred 不動(段落重疊不具傳遞性:甲乙、乙丙重疊而甲丙無共同內容,不可因聯集而刪掉不同之文章)
//   ③只動文件:他份改 skip(欄位同新進之 CS10:skipKind duplicate、skipReason、dupOf 記留存者);不碰筆記,回傳 notesToHandle 供呼叫端處置
//   ④處置帳(帳協定)逐件先寫入、即記帳、再回驗(中途中止亦留已寫者);before 只列處置前存在之欄位;回退＝撤銷該次處置之效果——依帳逆序以回退防護
//     還原(欄位＝after 者寫回 before、處置前不存在者刪除;已＝before 者已完成;其後被改動或文件不在 → 衝突:不覆寫、不記回退列,acceptCurrent 記取代列)
//     並附寫回退列,讀帳排除已回退與被取代者;讀帳遇無法解析之列即拋(allowBad 才略過);本模組之列＝文件列且 stds 含 CS10(讀帳、連鎖斷言、
//     回退同一判定),缺 before 或 after 者回退記 errors
//   ⑤改 skip 與回退時同步本行程已建之同一內容索引,否則同行程之後續入庫仍以已改 skip 者為錨
//   ⑥連鎖斷言:文件仍在且帳列 after 之各欄＝現值
// 執行:自套件根 npx mocha test/unit-cs10fix.test.mjs(暫存 test/_tmp/cs10fix-<pid>,測完即刪;記憶體集合,不連網)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { memStore } from './tools/memStore.mjs'
import { tmpRoot, removeRoots } from './tools/captureTestKit.mjs'
import { planCs10Fix, applyCs10Fix, verifyCs10Chain, rollbackCs10Fix, readCs10Ledger } from '../src/standards/cs10Fix.mjs'
import { contentIndexOf, contentIndexIfBuilt, paraKeysOf } from '../src/stores/contentIndex.mjs'
import { packText } from '../src/core/stores/docTexts.mjs'

const AT = '2026-10-06T12:00:00+08:00'
const URL1 = 'https://arxiv.org/abs/2401.01234'
const keys = (p, n) => Array.from({ length: n }, (_, i) => `${p}${i}`)
const P = (s) => `${s}之研究段落內容說明，`.repeat(6)
const TEXT = [P('甲'), P('乙'), P('丙'), P('丁')].join('\n')

/** 同一篇之兩個網址(arXiv abs 與 pdf):同代稱 */
const urlPair = (o1 = {}, o2 = {}) => [
    { id: 'd1', status: 'noted', url: URL1, notedAt: '2026-09-01T00:00:00Z', paraKeys: [], ...o1 },
    { id: 'd2', status: 'noted', url: 'https://arxiv.org/pdf/2401.01234v2', notedAt: '2026-09-02T00:00:00Z', paraKeys: [], ...o2 },
]

/**
 * 組集合:docs 必有;docTexts 恆有(可空);notes、holds 給了才有
 *
 * @param {Object} o 輸入 { docs, docTexts, notes, holds }
 * @returns {Object} 回傳 stores
 */
const mk = (o) => ({
    docs: memStore(o.docs),
    docTexts: memStore(o.docTexts || []),
    ...(o.notes ? { notes: memStore(o.notes) } : {}),
    ...(o.holds ? { holds: memStore(o.holds) } : {}),
})

const dumpOf = (st) => JSON.stringify(Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v._dump()])))

describe('unit-cs10fix', function() {

    this.timeout(60_000)

    let root = ''
    before(() => {
        root = tmpRoot('cs10fix')
    })
    after(() => {
        removeRoots([root])
    })

    let seq = 0
    const ledgerPath = () => `${root}/case${++seq}/nested/cs10-fix.jsonl`

    describe('預演(planCs10Fix)', function() {

        it('列出各群之留存者與處置對象;只預演不寫任何集合;形狀與計數', async () => {
            const st = mk({ docs: urlPair(), notes: [{ id: 'n1', docId: 'd1' }, { id: 'n2', docId: 'd2', extractedAt: '2026-09-10T00:00:00Z' }] })
            const writes = []
            for (const [name, s] of Object.entries(st)) {
                for (const m of ['patch', 'insertNew', 'replace', 'del']) {
                    const f = s[m]
                    s[m] = (...a) => {
                        writes.push(`${name}.${m}`)
                        return f(...a)
                    }
                }
            }
            const before = dumpOf(st)
            const plan = await planCs10Fix(st)
            assert.deepEqual(plan, {
                std: 'CS10',
                notesRead: true,
                groups: [{
                    id: 'd1＋d2',
                    ids: ['d1', 'd2'],
                    keeper: 'd2',
                    keeperNote: 'n2',
                    others: [{ doc: 'd1', note: 'n1', consumed: false }],
                    skipDocs: ['d1'],
                    deferred: [],
                }],
                counts: { violations: 1, undetermined: 0, groups: 1, skipDocs: 1, deferred: 0 },
            })
            assert.deepEqual(writes, [])
            assert.equal(dumpOf(st), before)
        })

        it('留存者之選定(有筆記集合):筆記已被消化 > 有筆記 > 較早成筆記 > id', async () => {
            const keeperOf = async (docs, notes) => (await planCs10Fix(mk({ docs, notes }))).groups[0].keeper
            // ① 已消化者勝(即使較晚成筆記)
            assert.equal(await keeperOf(urlPair(), [{ id: 'n1', docId: 'd1' }, { id: 'n2', docId: 'd2', extractedAt: 'x' }]), 'd2')
            // ① 兩份皆已消化 → 回到 ③ 較早成筆記
            assert.equal(await keeperOf(urlPair(), [{ id: 'n1', docId: 'd1', extractedAt: 'x' }, { id: 'n2', docId: 'd2', extractedAt: 'y' }]), 'd1')
            // ② 都未消化而只有一份有筆記 → 有筆記者勝(即使較晚)
            assert.equal(await keeperOf(urlPair(), [{ id: 'n2', docId: 'd2' }]), 'd2')
            // ③ 都無筆記 → 較早成筆記者
            assert.equal(await keeperOf(urlPair(), []), 'd1')
            assert.equal(await keeperOf(urlPair({ notedAt: '2026-09-05T00:00:00Z' }), []), 'd2')
            // ④ notedAt 相同 → id 小者
            assert.equal(await keeperOf(urlPair({ notedAt: '2026-09-01' }, { notedAt: '2026-09-01' }), []), 'd1')
            assert.equal(await keeperOf([{ ...urlPair()[1], id: 'b' }, { ...urlPair()[0], id: 'c', notedAt: urlPair()[1].notedAt }], []), 'b')
        })

        it('未給筆記集合:留存者只依 較早成筆記 > id,notesRead 為 false,各項之 note 為 null', async () => {
            const plan = await planCs10Fix(mk({ docs: urlPair() }))
            assert.equal(plan.notesRead, false)
            assert.deepEqual(plan.groups[0], { id: 'd1＋d2', ids: ['d1', 'd2'], keeper: 'd1', keeperNote: null, others: [{ doc: 'd2', note: null, consumed: false }], skipDocs: ['d2'], deferred: [] })
        })

        it('只處置與留存者直接相連者:段落重疊不具傳遞性(甲乙、乙丙重疊而甲丙無共同段落)→ 乙處置、丙列 deferred 不動', async () => {
            const docs = [
                { id: 'a', status: 'noted', url: 'https://a.example.net/p', notedAt: '2026-09-01', paraKeys: keys('A', 6) },
                { id: 'b', status: 'noted', url: 'https://b.example.net/p', notedAt: '2026-09-02', paraKeys: [...keys('A', 3), ...keys('B', 3)] },
                { id: 'c', status: 'noted', url: 'https://c.example.net/p', notedAt: '2026-09-03', paraKeys: [...keys('B', 3), ...keys('C', 3)] },
            ]
            const plan = await planCs10Fix(mk({ docs }))
            assert.equal(plan.groups.length, 1, '兩個配對群以聯集合併為連通群')
            assert.deepEqual([plan.groups[0].ids, plan.groups[0].keeper, plan.groups[0].skipDocs, plan.groups[0].deferred], [['a', 'b', 'c'], 'a', ['b'], ['c']])
            assert.deepEqual(plan.counts, { violations: 2, undetermined: 0, groups: 1, skipDocs: 1, deferred: 1 }, 'violations 為掃描之配對群數,groups 為合併後之連通群數')
            // 套用後重掃:乙已 skip,甲與丙無共同內容 → 無群(丙依其自身之重疊於下輪重新成群)
            const st = mk({ docs })
            const r = await applyCs10Fix(st, plan, { at: AT })
            assert.deepEqual(r.skipped, ['b'])
            assert.equal((await st.docs.get('c')).status, 'noted', '丙不動')
            assert.deepEqual((await planCs10Fix(st)).groups, [])
        })

        it('已豁免者不在處置範圍(掃描記 waived):給了 holds 而該群任一成員有 CS10 之 waived 登錄 → 不列入;open 之登錄不豁免', async () => {
            const waived = [{ id: 'doc:d1:CS10', object: 'doc', oid: 'd1', std: 'CS10', status: 'waived' }]
            const p1 = await planCs10Fix(mk({ docs: urlPair(), holds: waived }))
            assert.deepEqual([p1.groups, p1.counts.violations], [[], 0])
            const p2 = await planCs10Fix(mk({ docs: urlPair(), holds: [{ ...waived[0], status: 'open' }] }))
            assert.equal(p2.groups.length, 1)
            const p3 = await planCs10Fix(mk({ docs: urlPair(), holds: [{ ...waived[0], std: 'CS1a' }] }))
            assert.equal(p3.groups.length, 1, '他標準之豁免不適用')
        })

        it('預設以原文補算(material:true,與每輪掃描同口徑):無段落雜湊者讀 docTexts 另存原文後成群;material:false 則該等文件不成群並計入未能判定', async () => {
            const noKeys = (id, o = {}) => ({ id, status: 'noted', url: `https://${id}.example.net/p`, notedAt: `2026-09-0${id === 'x' ? 1 : 2}`, text: '', ...o })
            const docTexts = ['x', 'y'].map((id) => ({ id, gz: packText(TEXT), feedGz: '', sha1: 'h' }))
            const docs = [noKeys('x'), noKeys('y')]
            const on = await planCs10Fix(mk({ docs, docTexts }))
            assert.deepEqual(on.groups.map((g) => [g.ids, g.keeper]), [[['x', 'y'], 'x']])
            const off = await planCs10Fix(mk({ docs, docTexts }), { material: false })
            assert.deepEqual([off.groups, off.counts.violations, off.counts.undetermined], [[], 0, 2])
            assert.equal(paraKeysOf(TEXT).length, 4, '前提:素材含 4 個足長段落')
        })

        it('ids 只處置含指定文件 id 之群;limit 至多幾群(依首個 id 排序);無效之 ids／limit 視為不限', async () => {
            const docs = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => ({ id, status: 'noted', url: `https://arxiv.org/abs/2401.0000${Math.floor(i / 2)}`, notedAt: '2026-09-01', paraKeys: [] }))
            const all = await planCs10Fix(mk({ docs }))
            assert.deepEqual(all.groups.map((g) => g.ids), [['a', 'b'], ['c', 'd'], ['e', 'f']])
            assert.deepEqual((await planCs10Fix(mk({ docs }), { ids: ['d'] })).groups.map((g) => g.ids), [['c', 'd']])
            assert.deepEqual((await planCs10Fix(mk({ docs }), { ids: ['zzz'] })).groups, [])
            assert.equal((await planCs10Fix(mk({ docs }), { ids: [] })).groups.length, 3, '空陣列視同未給')
            const two = await planCs10Fix(mk({ docs }), { limit: 2 })
            assert.deepEqual([two.groups.length, two.counts.groups, two.counts.violations], [2, 2, 3], 'violations 為掃描之全部違反,groups 為本次處置之群數')
            for (const bad of [0, -1, 1.5, 'x', null]) assert.equal((await planCs10Fix(mk({ docs }), { limit: bad })).groups.length, 3, `limit=${String(bad)}`)
        })

        it('輸入檢核:stores.docs 須具 select 與 get;opt 非物件視為 {}', async () => {
            await assert.rejects(() => planCs10Fix({}), /planCs10Fix 需要 stores\.docs（具 select／get 方法）/)
            await assert.rejects(() => planCs10Fix({ docs: { select: async () => [] } }), /需要 stores\.docs/)
            await assert.rejects(() => planCs10Fix(null), /需要 stores\.docs/)
            for (const bad of [null, 'x', 5, []]) assert.equal((await planCs10Fix(mk({ docs: urlPair() }), bad)).groups.length, 1)
        })
    })

    describe('套用(applyCs10Fix)', function() {

        it('他份文件改 skip(與新進之 CS10 同一處置欄位);留存者與筆記集合不動;回傳 notesToHandle 列出其筆記供呼叫端處置', async () => {
            const st = mk({ docs: urlPair(), notes: [{ id: 'n1', docId: 'd1' }, { id: 'n2', docId: 'd2', extractedAt: 'x' }] })
            const plan = await planCs10Fix(st)
            const notesBefore = JSON.stringify(st.notes._dump())
            const keeperBefore = JSON.stringify(await st.docs.get('d2'))
            const r = await applyCs10Fix(st, plan, { at: AT })
            assert.equal(r.at, AT)
            assert.deepEqual(r.applied, { CS10: 1 })
            assert.deepEqual([r.skipped, r.stale, r.errors], [['d1'], [], []])
            assert.deepEqual(r.notesToHandle, [{ doc: 'd1', note: 'n1', consumed: false, keeper: 'd2', keeperNote: 'n2' }])
            const d1 = await st.docs.get('d1')
            assert.deepEqual([d1.status, d1.skipKind, d1.dupOf, d1.notedAt], ['skip', 'duplicate', 'd2', AT])
            assert.equal(d1.skipReason, '與既有文件同一內容（d2；檢定標準 CS10 存量合併）（未進 AI）')
            assert.equal(JSON.stringify(await st.docs.get('d2')), keeperBefore, '留存者不動')
            assert.equal(JSON.stringify(st.notes._dump()), notesBefore, '筆記屬下游產物,本模組不碰')
            assert.deepEqual((await planCs10Fix(st)).groups, [], '處置後重掃:重複件已 skip(不在 noted 範圍)')
        })

        it('寫入帳:逐件 { at, object:doc, id, stds:[CS10], before, after };before 只列處置前存在之欄位(不存在者不列——回退時刪除而非寫 null);未給 ledgerFile 即不落檔', async () => {
            const st = mk({ docs: urlPair() })
            const r = await applyCs10Fix(st, await planCs10Fix(st), { at: AT })
            assert.equal(r.ledgerFile, '')
            assert.equal(r.ledger.length, 1)
            const row = r.ledger[0]
            assert.deepEqual([row.at, row.object, row.id, row.stds], [AT, 'doc', 'd2', ['CS10']])
            assert.deepEqual(row.before, { status: 'noted', notedAt: '2026-09-02T00:00:00Z' })
            assert.deepEqual(row.after, { status: 'skip', skipKind: 'duplicate', dupOf: 'd1', skipReason: '與既有文件同一內容（d1；檢定標準 CS10 存量合併）（未進 AI）', notedAt: AT })
        })

        it('給 ledgerFile 者逐件附寫 JSONL(父目錄不存在則建立);讀帳回傳同一批列', async () => {
            const file = ledgerPath()
            const st = mk({ docs: urlPair() })
            const r = await applyCs10Fix(st, await planCs10Fix(st), { at: AT, ledgerFile: file })
            assert.equal(r.ledgerFile, file)
            const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
            assert.deepEqual(lines, r.ledger)
            assert.deepEqual(readCs10Ledger(file), r.ledger)
        })

        it('逐件以現值判斷:文件已不在或已為 skip 者列 stale 不重寫;其筆記仍列入 notesToHandle(其文件已非正式集合之一份)', async () => {
            const st = mk({ docs: urlPair(), notes: [{ id: 'n1', docId: 'd1' }, { id: 'n2', docId: 'd2', extractedAt: 'x' }] })
            const plan = await planCs10Fix(st)
            await st.docs.del('d1')
            const gone = await applyCs10Fix(st, plan, { at: AT })
            assert.deepEqual([gone.skipped, gone.stale, gone.ledger.length, gone.applied], [[], ['d1'], 0, { CS10: 1 }])
            assert.deepEqual(gone.notesToHandle.map((x) => x.doc), ['d1'])
            // 已為 skip:重複套用同一預演為冪等(第二次全數 stale、不寫入帳)
            const st2 = mk({ docs: urlPair(), notes: [{ id: 'n1', docId: 'd1' }, { id: 'n2', docId: 'd2', extractedAt: 'x' }] })
            const plan2 = await planCs10Fix(st2)
            const first = await applyCs10Fix(st2, plan2, { at: AT })
            const again = await applyCs10Fix(st2, plan2, { at: '2026-10-07T00:00:00Z' })
            assert.deepEqual([first.skipped, again.skipped, again.stale, again.ledger], [['d1'], [], ['d1'], []])
            assert.equal((await st2.docs.get('d1')).notedAt, AT, '第二次不改寫已處置者之時刻')
        })

        it('回驗失敗(改 skip 後讀回狀態不符)→ 記入 errors(群 id、object:dup、原因);該文件不列入 skipped 與 notesToHandle(文件仍在,其筆記須保留);入帳已先寫,可回退', async () => {
            const st = mk({ docs: urlPair(), notes: [{ id: 'n1', docId: 'd1' }, { id: 'n2', docId: 'd2', extractedAt: 'x' }] })
            const plan = await planCs10Fix(st)
            const patch = st.docs.patch
            st.docs.patch = async (id, f) => patch(id, Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'status'))) // 狀態寫不進去
            const file = ledgerPath()
            const r = await applyCs10Fix(st, plan, { at: AT, ledgerFile: file })
            assert.equal(r.errors.length, 1)
            assert.deepEqual([r.errors[0].id, r.errors[0].object], ['d1＋d2', 'dup'])
            assert.match(r.errors[0].error, /文件 d1 改 skip 後回驗不符/)
            assert.deepEqual([r.skipped, r.notesToHandle, r.applied], [[], [], { CS10: 0 }])
            assert.equal(r.ledger.length, 1, '先寫入、即記帳、再回驗:失敗者亦留帳')
            assert.equal(readCs10Ledger(file).length, 1)
        })

        it('群與群互相隔離:某群失敗不影響其他群之套用與計數', async () => {
            const docs = [
                { id: 'a', status: 'noted', url: 'https://arxiv.org/abs/2401.00001', notedAt: '2026-09-01', paraKeys: [] },
                { id: 'b', status: 'noted', url: 'https://arxiv.org/abs/2401.00001v2', notedAt: '2026-09-02', paraKeys: [] },
                { id: 'c', status: 'noted', url: 'https://arxiv.org/abs/2401.00002', notedAt: '2026-09-01', paraKeys: [] },
                { id: 'd', status: 'noted', url: 'https://arxiv.org/abs/2401.00002v2', notedAt: '2026-09-02', paraKeys: [] },
            ]
            const st = mk({ docs })
            const plan = await planCs10Fix(st)
            assert.deepEqual(plan.groups.map((g) => g.skipDocs), [['b'], ['d']])
            const patch = st.docs.patch
            st.docs.patch = async (id, f) => patch(id, id === 'b' ? Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'status')) : f) // 只有 b 寫不進去
            const r = await applyCs10Fix(st, plan, { at: AT })
            assert.deepEqual([r.applied, r.skipped, r.errors.map((e) => e.id)], [{ CS10: 1 }, ['d'], ['a＋b']])
        })

        it('預演為空或缺:不處置任何東西(plan 非物件、groups 非陣列皆視為無群);opt 非物件視為 {}', async () => {
            const st = mk({ docs: urlPair() })
            for (const plan of [null, undefined, {}, { groups: 'x' }, { groups: [] }]) {
                const r = await applyCs10Fix(st, plan, 'bad')
                assert.deepEqual([r.applied, r.skipped, r.stale, r.errors, r.notesToHandle], [{ CS10: 0 }, [], [], [], []], JSON.stringify(plan))
            }
            assert.equal((await st.docs.get('d2')).status, 'noted')
        })

        it('輸入檢核:stores.docs 須具 get 與 patch', async () => {
            await assert.rejects(() => applyCs10Fix({}, { groups: [] }), /applyCs10Fix 需要 stores\.docs（具 get／patch 方法）/)
            await assert.rejects(() => applyCs10Fix({ docs: { get: async () => null } }, {}), /需要 stores\.docs/)
            await assert.rejects(() => applyCs10Fix(null, {}), /需要 stores\.docs/)
        })
    })

    describe('寫入帳之讀取(readCs10Ledger)', function() {

        const write = (name, lines) => {
            const f = `${root}/ledger-${name}.jsonl`
            fs.writeFileSync(f, lines.join('\n'), 'utf8')
            return f
        }
        const row = (at, id, o = {}) => JSON.stringify({ at, object: 'doc', id, stds: ['CS10'], before: { status: 'noted' }, after: { status: 'skip' }, ...o })

        it('檔案不存在或路徑非字串回空陣列;無法解析與非物件之列即拋(列行號),allowBad 才略過;空行不計', () => {
            assert.deepEqual(readCs10Ledger(`${root}/not-exist.jsonl`), [])
            for (const bad of [undefined, null, '', 5, {}]) assert.deepEqual(readCs10Ledger(bad), [])
            const f = write('bad', [row('T1', 'x'), '', '{壞掉', '123', '"x"', 'null', '[1]', row('T2', 'y')])
            assert.throws(() => readCs10Ledger(f), /有 5 行無法解析（第 3 行：.*；第 4 行：不是物件；第 5 行：不是物件；第 6 行：不是物件；第 7 行：不是物件）/)
            assert.deepEqual(readCs10Ledger(f, { allowBad: true }).map((r) => r.id), ['x', 'y'])
        })

        it('只取本模組之文件列(object doc 且 stds 含 CS10);他物件、他標準之列不取', () => {
            const f = write('mix', [row('T1', 'a'), row('T1', 'b', { object: 'note' }), row('T1', 'c', { stds: ['CS12'] }), row('T1', 'd', { stds: ['CS12', 'CS10'] }), row('T1', 'e', { stds: 'CS10' })])
            assert.deepEqual(readCs10Ledger(f).map((r) => r.id), ['a', 'd'])
        })

        it('排除回退列與已被回退者:回退列以 { rollbackOf: 原列之 at, object, id } 對應;同一文件被處置兩次者只排除對應那次', () => {
            const f = write('rb', [
                row('T1', 'x'),
                row('T2', 'x'),
                row('T3', 'y'),
                JSON.stringify({ at: 'T9', rollbackOf: 'T2', object: 'doc', id: 'x' }),
            ])
            assert.deepEqual(readCs10Ledger(f).map((r) => `${r.at}:${r.id}`), ['T1:x', 'T3:y'])
            assert.equal(readCs10Ledger(f).some((r) => r.rollbackOf), false, '回退列本身不回傳')
        })

        it('since:只取該時刻(含)起之列(以時刻比較——時區表示不同亦正確);at:只取該次套用之列', () => {
            const f = write('since', [row('2026-10-01T00:00:00Z', 'a'), row('2026-10-02T00:00:00Z', 'b'), row('2026-10-03T00:00:00Z', 'c'), row('2026-10-02T07:00:00+08:00', 'd')])
            assert.deepEqual(readCs10Ledger(f, { since: '2026-10-02T00:00:00Z' }).map((r) => r.id), ['b', 'c'], 'd 為 10-01T23:00Z(字面比較會誤取)')
            assert.deepEqual(readCs10Ledger(f, { at: '2026-10-02T00:00:00Z' }).map((r) => r.id), ['b'])
            assert.deepEqual(readCs10Ledger(f, null).map((r) => r.id), ['a', 'b', 'c', 'd'], 'opt 非物件視為 {}')
        })
    })

    describe('回退(rollbackCs10Fix)與回到原群', function() {

        it('預演 → 套用 → 讀帳 → 回退 → 再預演:回到原群與原處置;文件欄位還原、回退列附寫、讀帳不再列已回退者', async () => {
            const file = ledgerPath()
            const st = mk({ docs: urlPair(), notes: [{ id: 'n1', docId: 'd1' }, { id: 'n2', docId: 'd2', extractedAt: 'x' }] })
            const plan0 = await planCs10Fix(st)
            const docsBefore = JSON.stringify(st.docs._dump())
            const ap = await applyCs10Fix(st, plan0, { at: AT, ledgerFile: file })
            assert.equal((await st.docs.get('d1')).status, 'skip')
            const rows = readCs10Ledger(file)
            assert.deepEqual(rows, ap.ledger)
            const rb = await rollbackCs10Fix(st, rows, { at: '2026-10-06T13:00:00+08:00', ledgerFile: file })
            assert.deepEqual(rb, { restored: 1, accepted: 0, conflicts: [], errors: [] })
            assert.deepEqual(await planCs10Fix(st), plan0, '回退後再預演與處置前相同(群、留存者、處置對象、計數)')
            assert.deepEqual(readCs10Ledger(file), [], '已回退者不再列')
            const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
            assert.deepEqual(lines.at(-1), { at: '2026-10-06T13:00:00+08:00', rollbackOf: AT, object: 'doc', id: 'd1' })
            // 文件逐欄回到處置前:處置時新增之欄位刪除(不留 null 殘留鍵)
            assert.deepEqual(st.docs._dump(), JSON.parse(docsBefore))
            // 冪等:同一列再回退 → 已＝before,視為已完成
            assert.deepEqual(await rollbackCs10Fix(st, rows, { at: 'T9' }), { restored: 1, accepted: 0, conflicts: [], errors: [] })
            assert.deepEqual(st.docs._dump(), JSON.parse(docsBefore))
        })

        it('回退防護:套用後他處改動之欄位 → 衝突(不覆寫、不記回退列、讀帳仍列);acceptCurrent → 記取代列(值不動、讀帳不再列);文件已不在 → 衝突(不復活)', async () => {
            const file = ledgerPath()
            const st = mk({ docs: [...urlPair(), { id: 'd3', status: 'noted', url: 'https://arxiv.org/pdf/2401.01234v3', notedAt: '2026-09-03T00:00:00Z', paraKeys: [] }] })
            const ap = await applyCs10Fix(st, await planCs10Fix(st), { at: AT, ledgerFile: file })
            assert.deepEqual(ap.skipped, ['d2', 'd3'])
            await st.docs.patch('d2', { status: 'archived' }) // 其後他處改動(非處置前之值)
            await st.docs.del('d3')
            const rb = await rollbackCs10Fix(st, readCs10Ledger(file), { at: 'T9', ledgerFile: file })
            assert.deepEqual(rb, { restored: 0, accepted: 0, conflicts: [{ id: 'd3', object: 'doc', units: ['（記錄不在）'] }, { id: 'd2', object: 'doc', units: ['status'] }], errors: [] })
            assert.deepEqual([(await st.docs.get('d2')).dupOf, await st.docs.get('d3')], ['d1', null], '不覆寫、不復活')
            assert.deepEqual(readCs10Ledger(file).map((r) => r.id), ['d2', 'd3'], '衝突之列仍列於帳')
            const ac = await rollbackCs10Fix(st, readCs10Ledger(file), { at: 'T10', ledgerFile: file, acceptCurrent: true })
            assert.deepEqual([ac.restored, ac.accepted, ac.conflicts], [0, 2, []])
            assert.deepEqual(readCs10Ledger(file), [], '接受現值:取代列使之不再列')
            const last = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(-2)
            assert.deepEqual(last, [{ accepted: 'current', units: ['（記錄不在）'], at: 'T10', rollbackOf: AT, object: 'doc', id: 'd3' }, { accepted: 'current', units: ['status'], at: 'T10', rollbackOf: AT, object: 'doc', id: 'd2' }])
            assert.equal((await st.docs.get('d2')).dupOf, 'd1', '接受現值不寫值')
        })

        it('依帳逆序還原:同一文件有多列時最終回到最早之 before(各列處置前不存在之欄位刪除);只處理本模組之列(文件列且 stds 含 CS10),他模組之列略過;本模組之列缺 before 或 after 者記 errors', async () => {
            const st = mk({ docs: [{ id: 'x', status: 'skip', skipKind: 'duplicate', dupOf: 'w', notedAt: 'T0' }] })
            const rows = [
                { at: 'T1', object: 'doc', id: 'x', stds: ['CS10'], before: { status: 'noted' }, after: { status: 'skip', skipKind: 'duplicate' } },
                { at: 'T2', object: 'doc', id: 'x', stds: ['CS10'], before: { status: 'skip', skipKind: 'duplicate' }, after: { status: 'skip', skipKind: 'duplicate', dupOf: 'w' } },
                { at: 'T3', object: 'note', id: 'n', stds: ['CS10'], before: { status: 'x' }, after: { status: 'y' } },
                { at: 'T4', object: 'doc', id: 'z', before: { status: 'x' }, after: { status: 'y' } },
                { at: 'T5', object: 'doc', id: 'y', stds: ['CS10'] },
                { at: 'T6', object: 'doc', id: 'x', stds: ['CS10'], before: { status: 'skip' } },
                null,
            ]
            const rb = await rollbackCs10Fix(st, rows)
            assert.equal(rb.restored, 2)
            assert.deepEqual(rb.errors.map((e) => [e.id, e.object]), [['x', 'doc'], ['y', 'doc']])
            assert.match(rb.errors[0].error, /帳列缺 after（處置後之值），無從判定其後是否被改動/, '缺 after 之值列即錯(無舊版退路)')
            assert.match(rb.errors[1].error, /文件 y 之帳列缺 before/)
            assert.deepEqual(await st.docs.get('x'), { id: 'x', status: 'noted', notedAt: 'T0' }, '逆序:先退 T2 再退 T1,最終為最早之 before;處置前不存在之欄位刪除')
            assert.equal(await st.docs.get('z'), null, '無 stds 之列非本模組之列,不動')
        })

        it('還原後回驗狀態不符 → 記入 errors(不計入 restored、不附寫回退列);其餘列照常處理', async () => {
            const st = mk({ docs: [{ id: 'x', status: 'skip' }, { id: 'y', status: 'skip' }] })
            const patch = st.docs.patch
            st.docs.patch = async (id, f) => patch(id, id === 'x' ? Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'status')) : f)
            const file = ledgerPath()
            const rows = [
                { at: 'T1', object: 'doc', id: 'x', stds: ['CS10'], before: { status: 'noted' }, after: { status: 'skip' } },
                { at: 'T1', object: 'doc', id: 'y', stds: ['CS10'], before: { status: 'noted' }, after: { status: 'skip' } },
            ]
            const rb = await rollbackCs10Fix(st, rows, { at: 'T9', ledgerFile: file })
            assert.equal(rb.restored, 1)
            assert.equal(rb.errors.length, 1)
            assert.deepEqual([rb.errors[0].id, rb.errors[0].object], ['x', 'doc'])
            assert.match(rb.errors[0].error, /文件 x 還原後回驗不符/)
            assert.equal((await st.docs.get('y')).status, 'noted')
            const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
            assert.deepEqual(lines, [{ at: 'T9', rollbackOf: 'T1', object: 'doc', id: 'y' }])
        })

        it('只回退部分列:其餘列仍在帳上(讀帳仍列)', async () => {
            const docs = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, status: 'noted', url: `https://arxiv.org/abs/2401.0000${Math.floor(i / 2)}${i % 2 ? 'v2' : ''}`, notedAt: `2026-09-0${i + 1}`, paraKeys: [] }))
            const st = mk({ docs })
            const file = ledgerPath()
            const plan = await planCs10Fix(st)
            const ap = await applyCs10Fix(st, plan, { at: AT, ledgerFile: file })
            assert.deepEqual(ap.skipped, ['b', 'd'])
            await rollbackCs10Fix(st, readCs10Ledger(file).filter((r) => r.id === 'b'), { ledgerFile: file, at: 'T9' })
            assert.deepEqual(readCs10Ledger(file).map((r) => r.id), ['d'])
            assert.equal((await st.docs.get('b')).status, 'noted')
            assert.equal((await st.docs.get('d')).status, 'skip')
        })

        it('連鎖斷言(verifyCs10Chain):套用後無問題;文件被他處改寫或已不在者列出;只驗本模組之列(checked 只計驗過者)', async () => {
            const st = mk({ docs: [...urlPair(), { id: 'd3', status: 'noted', url: 'https://arxiv.org/pdf/2401.01234v3', notedAt: '2026-09-03T00:00:00Z', paraKeys: [] }] })
            const ap = await applyCs10Fix(st, await planCs10Fix(st), { at: AT })
            assert.deepEqual(ap.skipped, ['d2', 'd3'])
            const rows = [...ap.ledger, { at: AT, object: 'note', id: 'n', stds: ['SS3'] }]
            assert.deepEqual(await verifyCs10Chain(st, rows), { checked: 2, problems: [] })
            await st.docs.patch('d2', { status: 'noted', dupOf: null })
            await st.docs.del('d3')
            const v = await verifyCs10Chain(st, rows)
            assert.equal(v.checked, 2)
            assert.deepEqual(v.problems, ['文件 d2：status、dupOf 與處置後之值不符（被他處改寫？）', '文件 d3：不在'])
            for (const bad of [undefined, null, 'x']) assert.deepEqual(await verifyCs10Chain(st, bad), { checked: 0, problems: [] })
            await assert.rejects(() => verifyCs10Chain({}, []), /verifyCs10Chain 需要 stores\.docs（具 get 方法）/)
        })

        it('rows 非陣列視為空;輸入檢核:stores.docs 須具 get、patch 與 replace(刪處置前不存在之欄位)', async () => {
            const st = mk({ docs: urlPair() })
            for (const rows of [undefined, null, 'x', {}]) assert.deepEqual(await rollbackCs10Fix(st, rows), { restored: 0, accepted: 0, conflicts: [], errors: [] })
            await assert.rejects(() => rollbackCs10Fix({}, []), /rollbackCs10Fix 需要 stores\.docs（具 get／patch／replace 方法）/)
            await assert.rejects(() => rollbackCs10Fix({ docs: { patch: async () => {} } }, []), /需要 stores\.docs/)
        })
    })

    describe('同一內容索引之同步', function() {

        it('本行程已建索引者:改 skip 後該文件不再充當錨(重複件不當錨),回退後復為錨;未建索引者不因處置而建立', async () => {
            // d2 已消化 → 留 d2、處置 d1;d1 於索引中排在 d2 之前(先到者在前)
            const st = mk({ docs: urlPair(), notes: [{ id: 'n1', docId: 'd1' }, { id: 'n2', docId: 'd2', extractedAt: 'x' }] })
            const idx = await contentIndexOf(st.docs)
            assert.equal(idx.matchUrl(URL1, 'zzz').id, 'd1', '前提:索引建於處置之前,d1 為首個錨')
            const plan = await planCs10Fix(st)
            const file = ledgerPath()
            const ap = await applyCs10Fix(st, plan, { at: AT, ledgerFile: file })
            assert.equal(idx.matchUrl(URL1, 'zzz').id, 'd2', '改 skip(重複)之 d1 不再當錨')
            await rollbackCs10Fix(st, ap.ledger)
            assert.equal(idx.matchUrl(URL1, 'zzz').id, 'd1', '回退後 d1 復為錨')
            // 未建索引者:處置不觸發建立(下次建立即讀到最新記錄)
            const st2 = mk({ docs: urlPair() })
            assert.equal(contentIndexIfBuilt(st2.docs), null)
            await applyCs10Fix(st2, await planCs10Fix(st2), { at: AT })
            assert.equal(contentIndexIfBuilt(st2.docs), null)
        })

        it('索引建立失敗不留快取:被拒之建立自快取移除,下次取用重建(否則本行程之後每次取用皆拒,同一內容判定整段失效)', async () => {
            // 規則:stores/contentIndex.contentIndexOf——建立失敗即自快取移除
            let fail = true
            const docs = { select: async () => {
                if (fail) throw new Error('讀取失敗(模擬)')
                return [{ id: 'd1', url: URL1, status: 'noted' }]
            } }
            await assert.rejects(() => contentIndexOf(docs), /讀取失敗/)
            await new Promise((resolve) => setImmediate(resolve)) // 讓移除快取之回呼先跑
            assert.equal(contentIndexIfBuilt(docs), null, '失敗之建立不留快取')
            fail = false
            const idx = await contentIndexOf(docs)
            assert.equal(idx.matchUrl(URL1, 'zzz').id, 'd1', '下次取用重建成功')
            assert.ok(contentIndexIfBuilt(docs), '成功之建立留快取')
        })

        it('網址含非法百分比編碼之文件不使索引建立失敗(contentKeysOfUrl 不拋);合法網址之代稱照常', async () => {
            // 規則:standards/docStandards.contentKeysOfUrl——解碼失敗改以未解碼之路徑照算
            const docs = { select: async () => [
                { id: 'bad', url: 'https://example.com/100%/x', status: 'noted' },
                { id: 'd1', url: URL1, status: 'noted' },
            ] }
            const idx = await contentIndexOf(docs)
            assert.equal(idx.matchUrl(URL1, 'zzz').id, 'd1')
        })
    })
})
