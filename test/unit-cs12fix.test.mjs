// unit-cs12fix.test.mjs — 檢定標準 CS12(領域標籤與線索值為正體)之存量處置:預演 → 套用(寫入帳)→ 讀帳 → 回退 → 再預演回到原處置
// 規則(出自 standards/cs12Fix 檔頭):
//   ①目標取自符合度掃描之違反(全部領域標籤、pending 線索之值;網址不計;已豁免者不在其列——掃描以登錄物件 CS12_HOLD_OBJECT 認豁免)
//   ②修法與判定同一定義:領域標籤 toTw、線索值 toTwKeepLinks(網址與 [[連結]] 不轉)
//   ③種子領域不寫庫(標籤以種子為準,每輪同步覆寫)→ 列 unfixable
//   ④線索鍵不得因此改變:轉換後之值算出之 clueKey 須等於記錄 id,否則列 unfixable(線索折疊未啟用時即如此)
//   ⑤處置帳(帳協定)逐件先寫入、即記帳、再回驗;回退＝撤銷該次處置之效果——依帳逆序以回退防護還原(值＝after 者寫回、已＝before 者已完成、
//     其後被改動或記錄不在 → 衝突:不覆寫、不記回退列,acceptCurrent 記取代列)並附寫回退列,讀帳排除已回退與被取代者;讀帳遇無法解析之列即拋
//     (allowBad 才略過);本模組之列＝stds 含 CS12 之值列及 CS12_HOLD_OBJECT 之待判列與結案列(讀帳、連鎖斷言、回退同一判定)
//   ⑥修不了者登錄使用者待判(鍵 CS12_HOLD_OBJECT:id:CS12;已有未結或已豁免者不重登;未開 holds 集合 → errors;登錄列記登錄前之記錄);已不再違反之
//     未結登錄由預演列出(resolvable)、套用結案;回退:登錄列只動同一登錄(未結且 since＝帳列時刻)、結案列仍為該次所結者復原
//   ⑦連鎖斷言:值列之現值＝帳列之 after;登錄列已登錄、結案列已結案
// 執行:自套件根 npx mocha test/unit-cs12fix.test.mjs(暫存 test/_tmp/cs12fix-<pid>,測完即刪;記憶體集合,不連網)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as OpenCC from 'opencc-js'
import { memStore } from './tools/memStore.mjs'
import { tmpRoot, removeRoots } from './tools/captureTestKit.mjs'
import { planCs12Fix, applyCs12Fix, verifyCs12Chain, rollbackCs12Fix, readCs12Ledger, CS12_HOLD_NEXT, CS12_HOLD_DEADLINE_DAYS } from '../src/standards/cs12Fix.mjs'
import { waiveHold } from '../src/core/stores/holds.mjs'
import { auditCaptureStandards, CS12_HOLD_OBJECT } from '../src/standards/audit.mjs'
import { clueKey } from '../src/core/stores/frontierPolicy.mjs'
import { setConceptFold } from '../src/core/util/text.mjs'

const AT = '2026-10-06T12:00:00+08:00'
const cn2tw = OpenCC.Converter({ from: 'cn', to: 'tw' })
/** 總組裝之線索折疊(cn→tw;簡繁同鍵) */
const foldOn = () => setConceptFold(null, { clueFold: cn2tw })
const foldOff = () => setConceptFold(null)

const SIMP = 'GJR-GARCH杠杆效应'
const TW = 'GJR-GARCH槓桿效應'
const clue = (value, o = {}) => ({ id: clueKey(o.type || 'keyword', value), type: 'keyword', value, status: 'pending', hits: 1, ...o })
const AREAS = () => [
    { id: 'a1', label: '机器学习因子', query: 'ml factor', origin: 'auto', status: 'active' },
    { id: 'a2', label: '量化数据', query: 'quant data', origin: 'seed', status: 'active' },
    { id: 'a3', label: '動量策略', query: 'momentum', origin: 'auto', status: 'active' },
    { id: '_meta', discoveredAt: AT },
]
/**
 * 組集合(線索 id 依當下之折疊算出——須於設定折疊後呼叫)
 *
 * @param {Object} [o={}] 輸入 { areas, frontier, holds }
 * @returns {Object} 回傳 stores
 */
const mk = (o = {}) => ({
    areas: memStore(o.areas || AREAS()),
    frontier: memStore(o.frontier || [clue(SIMP), clue('动量反转', { status: 'done' }), clue('https://x.example.com/数据', { type: 'site' })]),
    ...(o.holds ? { holds: memStore(o.holds) } : {}),
})
const dumpOf = (st) => JSON.stringify(Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v._dump()])))

describe('unit-cs12fix', function() {

    this.timeout(60_000)

    let root = ''
    let seq = 0
    const ledgerPath = () => `${root}/case${++seq}/nested/cs12-fix.jsonl`
    before(() => {
        root = tmpRoot('cs12fix')
        foldOn()
    })
    after(() => {
        foldOff()
        removeRoots([root])
    })

    describe('預演(planCs12Fix)', function() {

        it('列出可修者與修不了者;只預演不寫任何集合;形狀與計數(非 pending 之線索與網址不計;中繼記錄無標籤不計)', async () => {
            const st = mk()
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
            const plan = await planCs12Fix(st)
            assert.deepEqual(plan, {
                std: 'CS12',
                items: [
                    { object: 'area', id: 'a1', field: 'label', before: '机器学习因子', after: '機器學習因子' },
                    { object: 'clue', id: clueKey('keyword', SIMP), field: 'value', before: SIMP, after: TW },
                ],
                unfixable: [{ object: 'area', id: 'a2', std: 'CS12', detail: '種子領域之標籤以種子(cfg.data.gridTopics)為準,每輪同步覆寫;請改種子之標籤「量化数据」' }],
                resolvable: [],
                counts: { violations: 3, items: 2, unfixable: 1, resolvable: 0 },
            })
            assert.deepEqual(writes, [])
            assert.equal(dumpOf(st), before)
        })

        it('線索鍵不得因轉換而改變:線索折疊未啟用時(簡繁不同鍵)→ 列 unfixable,不改值', async () => {
            foldOff()
            try {
                const plan = await planCs12Fix(mk({ areas: [], frontier: [clue(SIMP)] }))
                assert.deepEqual(plan.items, [])
                assert.equal(plan.unfixable.length, 1)
                assert.match(plan.unfixable[0].detail, /轉正體後之線索鍵與記錄 id 不同/)
            }
            finally {
                foldOn()
            }
        })

        it('只看線索值中網址以外之部分:site 線索之網址含簡體字不計;關鍵詞值內之網址不轉、其餘轉正體', async () => {
            const v = '见 https://x.example.com/数据 说明'
            const plan = await planCs12Fix(mk({ areas: [], frontier: [clue(v), clue('https://y.example.com/数据', { type: 'site' })] }))
            assert.deepEqual(plan.items.map((x) => [x.id, x.after]), [[clueKey('keyword', v), '見 https://x.example.com/数据 說明']])
            assert.equal(plan.counts.violations, 1, 'site 線索不計')
        })

        it('ids 只處置指定物件;limit 至多處置幾件(修不了者不計入,達上限即停);無效之 ids／limit 視為不限', async () => {
            assert.deepEqual((await planCs12Fix(mk(), { ids: ['a1'] })).items.map((x) => x.id), ['a1'])
            assert.deepEqual((await planCs12Fix(mk(), { ids: ['zzz'] })).items, [])
            assert.equal((await planCs12Fix(mk(), { ids: [] })).items.length, 2, '空陣列視同未給')
            const one = await planCs12Fix(mk(), { limit: 1 })
            assert.deepEqual([one.items.map((x) => x.id), one.counts.violations], [['a1'], 3], 'violations 為掃描之全部違反')
            for (const bad of [0, -1, 1.5, 'x', null]) assert.equal((await planCs12Fix(mk(), { limit: bad })).items.length, 2, `limit=${String(bad)}`)
        })

        it('已豁免者不在處置範圍:掃描以登錄物件 CS12_HOLD_OBJECT 認 waived(此前未帶登錄物件,豁免永不生效);open 之登錄不豁免、他標準之豁免不適用', async () => {
            assert.equal(CS12_HOLD_OBJECT, 'label')
            const waived = (oid, o = {}) => ({ id: `${CS12_HOLD_OBJECT}:${oid}:CS12`, object: CS12_HOLD_OBJECT, oid, std: 'CS12', status: 'waived', ...o })
            const p1 = await planCs12Fix(mk({ holds: [waived('a1'), waived('a2')] }))
            assert.deepEqual([p1.items.map((x) => x.id), p1.unfixable, p1.counts.violations], [[clueKey('keyword', SIMP)], [], 1])
            const rep = await auditCaptureStandards({ stores: { ...mk({ holds: [waived('a1')] }), docs: memStore() } }, { only: ['CS12'] })
            assert.deepEqual([rep.standards.CS12.waived, rep.standards.CS12.waiveds.map((x) => x.id)], [1, ['a1']], '掃描計 waived 並列出')
            assert.equal((await planCs12Fix(mk({ holds: [waived('a1', { status: 'open' })] }))).items.length, 2)
            assert.equal((await planCs12Fix(mk({ holds: [waived('a1', { std: 'CS10' })] }))).items.length, 2)
        })

        it('輸入檢核:stores 須含 areas 或 frontier(具 select);opt 非物件視為 {};只給其一亦可', async () => {
            await assert.rejects(() => planCs12Fix({}), /planCs12Fix 需要 stores\.areas 或 stores\.frontier/)
            await assert.rejects(() => planCs12Fix(null), /需要 stores\.areas 或 stores\.frontier/)
            for (const bad of [null, 'x', 5, []]) assert.equal((await planCs12Fix(mk(), bad)).items.length, 2)
            assert.deepEqual((await planCs12Fix({ areas: memStore(AREAS()) })).items.map((x) => x.id), ['a1'])
            assert.deepEqual((await planCs12Fix({ frontier: memStore([clue(SIMP)]) })).items.map((x) => x.object), ['clue'])
        })
    })

    describe('套用(applyCs12Fix)', function() {

        it('逐件寫入正體值;處置帳逐件 { at, object, id, stds:[CS12], before, after };給 ledgerFile 者逐件附寫;重掃後無違反(種子除外,登錄待判)', async () => {
            const st = mk({ holds: [] })
            const file = ledgerPath()
            const r = await applyCs12Fix(st, await planCs12Fix(st), { at: AT, ledgerFile: file })
            assert.deepEqual([r.at, r.applied, r.fixed, r.stale, r.errors], [AT, { CS12: 2 }, ['a1', clueKey('keyword', SIMP)], [], []])
            assert.deepEqual(r.ledger, [
                { at: AT, object: 'area', id: 'a1', stds: ['CS12'], before: { label: '机器学习因子' }, after: { label: '機器學習因子' } },
                { at: AT, object: 'clue', id: clueKey('keyword', SIMP), stds: ['CS12'], before: { value: SIMP }, after: { value: TW } },
                { at: AT, object: 'hold', id: `${CS12_HOLD_OBJECT}:a2:CS12`, stds: ['CS12'], before: { hold: null }, hold: `${CS12_HOLD_OBJECT}:a2:CS12` },
            ])
            assert.deepEqual(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)), r.ledger)
            assert.equal((await st.areas.get('a1')).label, '機器學習因子')
            assert.equal((await st.frontier.get(clueKey('keyword', SIMP))).value, TW)
            assert.equal((await st.areas.get('a2')).label, '量化数据', '種子領域不寫')
            const again = await planCs12Fix(st)
            assert.deepEqual([again.items, again.unfixable.map((x) => x.id)], [[], ['a2']])
            assert.equal(clueKey('keyword', TW), clueKey('keyword', SIMP), '線索 id 不變(與入庫之正體值同鍵)')
        })

        it('逐件以現值重算:已合格或已不在者列 stale 不重寫(重複套用為冪等);現值已改為種子領域者記 errors 不寫', async () => {
            const st = mk()
            const plan = await planCs12Fix(st)
            const first = await applyCs12Fix(st, plan, { at: AT })
            const again = await applyCs12Fix(st, plan, { at: '2026-10-07T00:00:00Z' })
            assert.deepEqual([first.fixed.length, again.fixed, again.stale.length, again.ledger], [2, [], 2, []])
            const st2 = mk()
            const plan2 = await planCs12Fix(st2)
            await st2.areas.patch('a1', { origin: 'seed' })
            await st2.frontier.del(clueKey('keyword', SIMP))
            const r = await applyCs12Fix(st2, plan2, { at: AT })
            assert.deepEqual([r.fixed, r.stale, r.errors.map((e) => [e.id, e.object])], [[], [clueKey('keyword', SIMP)], [['a1', 'area'], ['a2', CS12_HOLD_OBJECT]]], 'a2:修不了而未開 holds 集合')
            assert.match(r.errors[0].error, /種子領域/)
            assert.equal((await st2.areas.get('a1')).label, '机器学习因子')
        })

        it('回驗失敗(寫入後讀回不符)→ 記入 errors、不列 fixed;入帳已先寫,可回退;件與件互相隔離', async () => {
            const st = mk({ holds: [] })
            const plan = await planCs12Fix(st)
            st.areas.patch = async () => {} // 領域寫不進去
            const file = ledgerPath()
            const r = await applyCs12Fix(st, plan, { at: AT, ledgerFile: file })
            assert.deepEqual([r.fixed, r.errors.map((e) => e.id)], [[clueKey('keyword', SIMP)], ['a1']])
            assert.match(r.errors[0].error, /寫入後回驗不符/)
            assert.deepEqual(readCs12Ledger(file).map((x) => x.object), ['area', 'clue', 'hold'], '先寫入、即記帳、再回驗:失敗者亦留帳')
        })

        it('計畫為空或缺、缺集合、不明物件:不寫;缺集合與不明物件記 errors;opt 非物件視為 {}', async () => {
            const st = mk()
            for (const plan of [null, undefined, {}, { items: 'x' }, { items: [] }]) {
                const r = await applyCs12Fix(st, plan, 'bad')
                assert.deepEqual([r.applied, r.fixed, r.stale, r.errors], [{ CS12: 0 }, [], [], []], JSON.stringify(plan))
            }
            const r = await applyCs12Fix({ areas: memStore(AREAS()) }, { items: [{ object: 'clue', id: 'c' }, { object: 'doc', id: 'd' }] }, { at: AT })
            assert.deepEqual(r.errors.map((e) => [e.id, e.object]), [['c', 'clue'], ['d', 'doc']])
            assert.match(r.errors[0].error, /缺 frontier 集合/)
            assert.match(r.errors[1].error, /不明之物件/)
            await assert.rejects(() => applyCs12Fix(null, {}), /applyCs12Fix 需要 stores/)
        })
    })

    describe('寫入帳之讀取(readCs12Ledger)', function() {

        const write = (name, lines) => {
            const f = `${root}/ledger-${name}.jsonl`
            fs.writeFileSync(f, lines.join('\n'), 'utf8')
            return f
        }
        const row = (at, id, o = {}) => JSON.stringify({ at, object: 'area', id, stds: ['CS12'], before: { label: '甲' }, after: { label: '乙' }, ...o })

        it('檔案不存在或路徑非字串回空陣列;壞行即拋(allowBad 才略過);只取本模組之列(area／clue 或 CS12_HOLD_OBJECT 之待判與結案列,且 stds 含 CS12)', () => {
            assert.deepEqual(readCs12Ledger(`${root}/not-exist.jsonl`), [])
            for (const bad of [undefined, null, '', 5, {}]) assert.deepEqual(readCs12Ledger(bad), [])
            const hold = (id, object, key) => JSON.stringify({ at: 'T1', object, id: key, stds: ['CS12'], before: {}, hold: key })
            const f = write('mix', [
                row('T1', 'a'), '{壞掉', row('T1', 'b', { object: 'clue' }), row('T1', 'c', { object: 'doc' }), row('T1', 'd', { stds: ['CS10'] }), row('T1', 'e', { stds: 'CS12' }),
                hold('h1', 'hold', 'label:x:CS12'), hold('h2', 'hold-resolved', 'label:y:CS12'), hold('h3', 'hold', 'note:z:CS12'),
            ])
            assert.throws(() => readCs12Ledger(f), /有 1 行無法解析（第 2 行：/)
            assert.deepEqual(readCs12Ledger(f, { allowBad: true }).map((r) => r.id), ['a', 'b', 'label:x:CS12', 'label:y:CS12'])
        })

        it('排除回退列與已被回退者(同一物件被處置兩次者只排除對應那次);since 只取該時刻起之列', () => {
            const f = write('rb', [row('T1', 'x'), row('T2', 'x'), row('T3', 'y'), JSON.stringify({ at: 'T9', rollbackOf: 'T2', object: 'area', id: 'x' })])
            assert.deepEqual(readCs12Ledger(f).map((r) => `${r.at}:${r.id}`), ['T1:x', 'T3:y'])
            assert.deepEqual(readCs12Ledger(f, { since: 'T3' }).map((r) => r.id), ['y'])
            assert.deepEqual(readCs12Ledger(f, null).length, 2, 'opt 非物件視為 {}')
        })
    })

    describe('回退(rollbackCs12Fix)與回到原處置', function() {

        it('預演 → 套用 → 讀帳 → 回退 → 再預演:回到原處置;值還原、回退列附寫、讀帳不再列已回退者', async () => {
            const file = ledgerPath()
            const st = mk()
            const plan0 = await planCs12Fix(st)
            const before = dumpOf(st)
            await applyCs12Fix(st, plan0, { at: AT, ledgerFile: file })
            const rows = readCs12Ledger(file)
            assert.equal(rows.length, 2)
            const rb = await rollbackCs12Fix(st, rows, { at: '2026-10-06T13:00:00+08:00', ledgerFile: file })
            assert.deepEqual(rb, { restored: 2, accepted: 0, conflicts: [], errors: [] })
            assert.equal(dumpOf(st), before, '集合回到處置前')
            assert.deepEqual(await planCs12Fix(st), plan0)
            assert.deepEqual(readCs12Ledger(file), [])
            const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
            assert.deepEqual(lines.slice(-2).map((x) => [x.rollbackOf, x.object]), [[AT, 'clue'], [AT, 'area']], '逆序附寫')
        })

        it('依帳逆序還原(同一物件多列時最終回到最早之 before);只處理本模組之列(他模組之列、無 stds 之列略過);本模組之列缺 before 或 after 者記 errors;回驗不符記 errors 不附寫', async () => {
            const st = mk({ areas: [{ id: 'x', label: '丙', origin: 'auto' }, { id: 'y', label: '丙', origin: 'auto' }] })
            const rows = [
                { at: 'T1', object: 'area', id: 'x', stds: ['CS12'], before: { label: '甲' }, after: { label: '乙' } },
                { at: 'T2', object: 'area', id: 'x', stds: ['CS12'], before: { label: '乙' }, after: { label: '丙' } },
                { at: 'T3', object: 'doc', id: 'd', before: { status: 'x' } },
                { at: 'T4', object: 'area', id: 'y', before: { label: '丁' }, after: { label: '丙' } },
                { at: 'T5', object: 'area', id: 'y', stds: ['CS12'] },
                { at: 'T6', object: 'area', id: 'y', stds: ['CS12'], before: { label: '戊' } },
                null,
            ]
            const rb0 = await rollbackCs12Fix(st, rows)
            assert.equal(rb0.restored, 2)
            assert.deepEqual(rb0.errors.map((e) => [e.id, e.object]), [['y', 'area'], ['y', 'area']])
            assert.match(rb0.errors[0].error, /帳列缺 after（處置後之值），無從判定其後是否被改動/, '缺 after 之值列即錯')
            assert.match(rb0.errors[1].error, /area y 之帳列缺 before/)
            assert.equal((await st.areas.get('x')).label, '甲')
            assert.equal((await st.areas.get('y')).label, '丙', '無 stds 之列非本模組之列,不動')
            const st2 = mk({ areas: [{ id: 'x', label: '丙', origin: 'auto' }] })
            st2.areas.patch = async () => {}
            const file = ledgerPath()
            const rb = await rollbackCs12Fix(st2, [{ at: 'T1', object: 'area', id: 'x', stds: ['CS12'], before: { label: '甲' }, after: { label: '丙' } }], { ledgerFile: file })
            assert.equal(rb.restored, 0)
            assert.match(rb.errors[0].error, /area x 還原後回驗不符/)
            assert.equal(fs.existsSync(file), false, '回驗不符不附寫回退列')
            for (const r of [undefined, null, 'x', {}]) assert.deepEqual(await rollbackCs12Fix(st, r), { restored: 0, accepted: 0, conflicts: [], errors: [] })
            await assert.rejects(() => rollbackCs12Fix(null, []), /rollbackCs12Fix 需要 stores/)
        })

        it('回退防護:套用後他處改寫之值 → 衝突(不覆寫、不記回退列);記錄不在 → 衝突(不復活);acceptCurrent → 取代列', async () => {
            const file = ledgerPath()
            const st = mk()
            await applyCs12Fix(st, await planCs12Fix(st), { at: AT, ledgerFile: file })
            await st.areas.patch('a1', { label: '機器學習因子（使用者改名）' })
            await st.frontier.del(clueKey('keyword', SIMP))
            const rb = await rollbackCs12Fix(st, readCs12Ledger(file), { at: 'T9', ledgerFile: file })
            assert.deepEqual(rb, { restored: 0, accepted: 0, conflicts: [{ id: clueKey('keyword', SIMP), object: 'clue', units: ['（記錄不在）'] }, { id: 'a1', object: 'area', units: ['label'] }], errors: [] })
            assert.deepEqual([(await st.areas.get('a1')).label, await st.frontier.get(clueKey('keyword', SIMP))], ['機器學習因子（使用者改名）', null])
            assert.equal(readCs12Ledger(file).length, 2, '衝突之列仍列於帳')
            const ac = await rollbackCs12Fix(st, readCs12Ledger(file), { at: 'T10', ledgerFile: file, acceptCurrent: true })
            assert.deepEqual([ac.accepted, readCs12Ledger(file)], [2, []])
        })
    })

    describe('修不了者之待判、已不再違反者之結案與連鎖斷言', function() {

        const hk = (oid) => `${CS12_HOLD_OBJECT}:${oid}:CS12`
        const SEED_WHY = '種子領域之標籤以種子(cfg.data.gridTopics)為準,每輪同步覆寫;請改種子之標籤「量化数据」'

        it('修不了者登錄使用者待判(鍵、原因、下一步、期限、負責者)並記待判列;已有未結或已豁免者不重登(alreadyHeld、不記帳)', async () => {
            const st = mk({ holds: [] })
            const file = ledgerPath()
            const plan = await planCs12Fix(st)
            const r = await applyCs12Fix(st, plan, { at: AT, ledgerFile: file })
            assert.deepEqual([r.fixed.length, r.held, r.alreadyHeld, r.resolved, r.errors], [2, [{ key: hk('a2'), id: 'a2', std: 'CS12' }], [], [], []])
            const h = await st.holds.get(hk('a2'))
            assert.deepEqual([h.object, h.oid, h.std, h.status, h.owner, h.next, h.since, h.tries], [CS12_HOLD_OBJECT, 'a2', 'CS12', 'open', 'user', CS12_HOLD_NEXT, AT, 0])
            assert.equal(h.reason, `存量修不了（CS12）：${SEED_WHY}`)
            assert.equal(h.deadline, new Date(Date.parse(AT) + CS12_HOLD_DEADLINE_DAYS * 86400000).toISOString())
            assert.deepEqual(r.ledger.at(-1), { at: AT, object: 'hold', id: hk('a2'), stds: ['CS12'], before: { hold: null }, hold: hk('a2') })
            assert.deepEqual(readCs12Ledger(file), r.ledger)
            const again = await applyCs12Fix(st, plan, { at: '2026-10-07T00:00:00Z' })
            assert.deepEqual([again.held, again.alreadyHeld, again.ledger], [[], [hk('a2')], []], '已未結:不重登、不記帳')
            await waiveHold(st.holds, hk('a2'), { by: '使用者', ruling: '種子維持', at: '2026-10-07T01:00:00Z' })
            const third = await applyCs12Fix(st, plan, { at: '2026-10-08T00:00:00Z' })
            assert.deepEqual([third.held, third.alreadyHeld, (await st.holds.get(hk('a2'))).status], [[], [hk('a2')], 'waived'], '已豁免:不重登,裁示不被改寫')
        })

        it('未開 holds 集合:修不了者與待結案者記 errors(不靜默);值之修正照常;他標準之項略過', async () => {
            const st = mk()
            const plan = await planCs12Fix(st)
            const r = await applyCs12Fix(st, { ...plan, unfixable: [...plan.unfixable, { id: 'n1', std: 'SS3', detail: 'x' }], resolvable: [{ key: hk('zz'), id: 'zz', std: 'CS12' }, { key: 'core:c:ES3', id: 'c', std: 'ES3' }] }, { at: AT })
            assert.equal(r.fixed.length, 2)
            assert.deepEqual(r.errors.map((e) => [e.id, e.object, e.error]), [
                [hk('zz'), CS12_HOLD_OBJECT, '未開 holds 集合，已不再違反之待判未結案'],
                ['a2', CS12_HOLD_OBJECT, '未開 holds 集合，修不了之存量未登錄待判'],
            ])
        })

        it('已不再違反之未結登錄:預演列 resolvable(掃描全部違反已無該物件者;ids 只取指定物件;已結、已豁免、他標準、他物件不列),套用結案並記結案列', async () => {
            const open = (oid, o = {}) => ({ id: hk(oid), object: CS12_HOLD_OBJECT, oid, std: 'CS12', status: 'open', reason: 'r', next: 'n', owner: 'user', since: 'T0', at: 'T0', tries: 0, ctx: {}, ...o })
            const holds = [open('a3'), open('gone'), open('a2'), open('a1'), open('a4', { status: 'resolved' }), open('a5', { status: 'waived' }), { ...open('a6'), id: 'label:a6:CS10', std: 'CS10' }, { ...open('a7'), id: 'doc:a7:CS12', object: 'doc' }]
            const st = mk({ holds })
            const plan = await planCs12Fix(st)
            assert.deepEqual(plan.resolvable, [{ key: hk('a3'), id: 'a3', std: 'CS12' }, { key: hk('gone'), id: 'gone', std: 'CS12' }], 'a1、a2 仍違反;a3 已正體;gone 記錄不在')
            assert.equal(plan.counts.resolvable, 2)
            assert.deepEqual((await planCs12Fix(st, { ids: ['gone'] })).resolvable.map((x) => x.id), ['gone'])
            assert.deepEqual((await planCs12Fix(st, { limit: 1 })).resolvable.length, 2, 'limit 只限處置件數,不限結案')
            const file = ledgerPath()
            const r = await applyCs12Fix(st, plan, { at: AT, ledgerFile: file })
            assert.deepEqual([r.resolved, r.errors], [[hk('a3'), hk('gone')], []])
            const h = await st.holds.get(hk('a3'))
            assert.deepEqual([h.status, h.resolvedAt, h.how], ['resolved', AT, '存量處置重掃已無此違反'])
            const rows = r.ledger.filter((x) => x.object === 'hold-resolved')
            assert.deepEqual(rows.map((x) => [x.id, x.stds, x.before.hold.status, x.hold]), [[hk('a3'), ['CS12'], 'open', hk('a3')], [hk('gone'), ['CS12'], 'open', hk('gone')]])
            const again = await applyCs12Fix(st, plan, { at: '2026-10-07T00:00:00Z' })
            assert.deepEqual([again.resolved, again.ledger.filter((x) => x.object === 'hold-resolved')], [[], []], '非未結者不動、不記')
        })

        it('連鎖斷言(verifyCs12Chain):套用後無問題;值被他處改寫、記錄不在、待判未登錄、結案列仍未結者列出;只驗本模組之列', async () => {
            const st = mk({ holds: [{ id: hk('a3'), object: CS12_HOLD_OBJECT, oid: 'a3', std: 'CS12', status: 'open', reason: 'r', next: 'n', owner: 'user', since: 'T0', at: 'T0', tries: 0, ctx: {} }] })
            const r = await applyCs12Fix(st, await planCs12Fix(st), { at: AT })
            assert.deepEqual(r.ledger.map((x) => x.object), ['area', 'clue', 'hold-resolved', 'hold'])
            const rows = [...r.ledger, { at: AT, object: 'doc', id: 'd', stds: ['CS10'] }]
            assert.deepEqual(await verifyCs12Chain(st, rows), { checked: 4, problems: [] })
            await st.areas.patch('a1', { label: '机器学习因子' })
            await st.frontier.del(clueKey('keyword', SIMP))
            await st.holds.del(hk('a2'))
            await st.holds.patch(hk('a3'), { status: 'open' })
            const v = await verifyCs12Chain(st, rows)
            assert.deepEqual(v, { checked: 4, problems: [
                'area a1：label 為「机器学习因子」，非處置後之「機器學習因子」（被他處改寫？）',
                `clue ${clueKey('keyword', SIMP)}：不在`,
                `待判 ${hk('a3')}：未結案`,
                `待判 ${hk('a2')}：未登錄`,
            ] })
            assert.deepEqual((await verifyCs12Chain({}, r.ledger)).problems, ['area a1：未開 areas 集合，無從驗證', `clue ${clueKey('keyword', SIMP)}：未開 frontier 集合，無從驗證`, `待判 ${hk('a3')}：未開 holds 集合，無從驗證`, `待判 ${hk('a2')}：未開 holds 集合，無從驗證`])
            for (const bad of [undefined, null, 'x']) assert.deepEqual(await verifyCs12Chain(st, bad), { checked: 0, problems: [] })
        })

        it('回退:值還原;登錄列只動同一登錄(已豁免不改寫);結案列仍為該次所結者復原為結案前之登錄(其後已重開者不動);未開 holds 集合 → errors;再預演回到原處置', async () => {
            const open3 = { id: hk('a3'), object: CS12_HOLD_OBJECT, oid: 'a3', std: 'CS12', status: 'open', reason: 'r', next: 'n', owner: 'user', since: 'T0', at: 'T0', tries: 0, ctx: {} }
            const st = mk({ holds: [open3] })
            const file = ledgerPath()
            const plan0 = await planCs12Fix(st)
            const before = dumpOf(st)
            await applyCs12Fix(st, plan0, { at: AT, ledgerFile: file })
            const rows = readCs12Ledger(file)
            assert.deepEqual(rows.map((x) => x.object), ['area', 'clue', 'hold-resolved', 'hold'])
            const rb = await rollbackCs12Fix(st, rows, { at: '2026-10-06T13:00:00+08:00', ledgerFile: file })
            assert.deepEqual(rb, { restored: 4, accepted: 0, conflicts: [], errors: [] })
            assert.deepEqual(await st.holds.get(hk('a3')), open3, '結案列:復原為結案前之登錄')
            const h2 = await st.holds.get(hk('a2'))
            assert.deepEqual([h2.status, h2.how], ['resolved', '存量處置回退'], '登錄列:結案(登錄本身留存供追溯)')
            assert.equal(JSON.stringify(st.areas._dump()) + JSON.stringify(st.frontier._dump()), JSON.stringify(JSON.parse(before).areas) + JSON.stringify(JSON.parse(before).frontier))
            assert.deepEqual(readCs12Ledger(file), [])
            const replan = await planCs12Fix(st)
            assert.deepEqual([replan.items, replan.unfixable, replan.resolvable], [plan0.items, plan0.unfixable, plan0.resolvable])
            // 其後已被裁示或重開者不動
            const st2 = mk({ holds: [open3] })
            const ap = await applyCs12Fix(st2, await planCs12Fix(st2), { at: AT })
            await waiveHold(st2.holds, hk('a2'), { by: '使用者', ruling: '維持', at: 'T8' })
            await st2.holds.patch(hk('a3'), { status: 'open', at: 'T8' })
            assert.deepEqual(await rollbackCs12Fix(st2, ap.ledger.filter((x) => x.object !== 'area' && x.object !== 'clue')), { restored: 2, accepted: 0, conflicts: [], errors: [] })
            assert.deepEqual([(await st2.holds.get(hk('a2'))).status, (await st2.holds.get(hk('a3'))).at], ['waived', 'T8'])
            // 未開 holds 集合
            const rb3 = await rollbackCs12Fix({ areas: st2.areas }, ap.ledger.filter((x) => x.object === 'hold' || x.object === 'hold-resolved'))
            assert.deepEqual(rb3.errors.map((e) => [e.object, e.error]), [['hold', '未開 holds 集合，待判未結案'], ['hold-resolved', '未開 holds 集合，待判未處置']])
        })
    })
})
