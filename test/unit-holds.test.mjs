// unit-holds.test.mjs — 待判登錄(core/stores/holds;四工作同一機制):登錄／結案／豁免／重試要求／列出／逾期、重試之判定(以時刻比較)、
//   期限、存量處置之待判件
// 規則(出自 core/stores/holds 檔頭與 JSDoc):
//   ①鍵＝物件:id:標準;同鍵未結案再登錄 → tries＋1、since 不變;已結案者再登錄 → 重開(前一段之處置存入 history)
//   ②欄位不全、負責者不在清單 → 拋錯;豁免須記裁示者與內容;requestRetry 只對未結案者;逾期以時刻比較
//   ③retryRequestedOf:要求晚於登錄之最後更新(以時刻比較,時區表示可不同;無法解析者依字面);pipelineDueOf:負責者為管線或要求了重試
//   ④holdDeadlineOf:登錄時刻起若干天(時刻無法解析、天數非正數即拋)
//   ⑤存量待判:holdStockUnfixable(已未結或已豁免者不重登;登錄即記帳列——含登錄前之記錄;缺集合即拋;原因未給者以 detail 組成同一格式)、closeStockHold(已不再違反之未結登錄結案、記結案列)、
//     rollbackStockHold(回退登錄列:只動同一登錄——未結且 since＝帳列時刻;有登錄前之記錄者寫回、無者結案)、reopenStockHold(回退結案列:仍為該次所結者復原)、
//     stockHoldProblems(登錄列已登錄、結案列之登錄在且已結案)
// 執行:自套件根 npx mocha test/unit-holds.test.mjs(暫存 test/_tmp/holds-<pid>,測完即刪;不連網)

import assert from 'node:assert/strict'
import WOrm from 'w-orm-lmdb/src/WOrmLmdb.mjs'
import W from 'w-data-pipeline/src/WDataPipeline.mjs'
import { memStore } from './tools/memStore.mjs'
import { tmpRoot, removeRoots } from './tools/captureTestKit.mjs'
import {
    HOLD_STATUSES, HOLD_OWNERS, holdKey, putHold, resolveHold, waiveHold, requestRetry, listHolds, overdueHolds,
    retryRequestedOf, pipelineDueOf, holdDeadlineOf, holdStockUnfixable, closeStockHold, rollbackStockHold, reopenStockHold, stockHoldProblems,
} from '../src/core/stores/holds.mjs'

describe('unit-holds', function() {

    let root = ''
    before(() => {
        root = tmpRoot('holds')
    })
    after(() => {
        removeRoots([root])
    })

    const T1 = '2026-10-04T10:00:00+08:00'
    const T2 = '2026-10-05T10:00:00+08:00'
    const H = (o = {}) => ({ object: 'notes', oid: 'n1', std: 'ES15', reason: '筆記逾提煉提示詞上限', next: '提示詞或席位版本變更後重送', owner: 'pipeline', ctx: { promptV: 3 }, ...o })

    it('putHold:鍵＝物件:id:標準;同鍵未結案再登錄 → tries＋1、since 不變;已結案者再登錄 → 重開(since 更新、tries 歸零);ctx 值轉字串', async () => {
        const st = memStore()
        const a = await putHold(st, H(), T1)
        assert.deepEqual([a.id, a.status, a.tries, a.since, a.ctx], [holdKey('notes', 'n1', 'ES15'), 'open', 0, T1, { promptV: '3' }])
        const b = await putHold(st, H({ reason: '仍逾上限' }), T2)
        assert.deepEqual([b.tries, b.since, b.at, b.reason], [1, T1, T2, '仍逾上限'])
        await resolveHold(st, a.id, { at: T2, how: '新版提示詞重送後已提煉' })
        const c = await putHold(st, H(), '2026-10-06T10:00:00+08:00')
        assert.deepEqual([c.status, c.tries, c.since], ['open', 0, '2026-10-06T10:00:00+08:00'])
    })

    it('欄位不全、負責者不在清單 → 拋錯(不靜默登錄殘缺紀錄)', async () => {
        const st = memStore()
        await assert.rejects(() => putHold(st, H({ reason: '' }), T1), /需要原因與下一步/)
        await assert.rejects(() => putHold(st, H({ owner: 'robot' }), T1), /負責者「robot」不在清單/)
        await assert.rejects(() => putHold(st, H({ std: '' }), T1), /需要 object、oid、std/)
        await assert.rejects(() => putHold({}, H(), T1), /需要 holds 集合/)
    })

    it('waiveHold 須記裁示者與裁示內容;requestRetry 只對未結案者;listHolds 篩選與排序;overdueHolds 只取未結案且逾期限者', async () => {
        const st = memStore()
        await putHold(st, H({ oid: 'n2', owner: 'user', deadline: '2026-10-04T12:00:00+08:00' }), T1)
        await putHold(st, H({ oid: 'n1' }), '2026-10-03T10:00:00+08:00')
        await putHold(st, H({ oid: 'n3', std: 'RS8', object: 'edges' }), T1)
        await assert.rejects(() => waiveHold(st, holdKey('notes', 'n2', 'ES15'), { by: '使用者' }), /須記裁示者與裁示內容/)
        const r = await requestRetry(st, holdKey('notes', 'n1', 'ES15'), { at: T2 })
        assert.equal(r.retryRequestedAt, T2)
        assert.deepEqual((await listHolds(st, { status: 'open', object: 'notes' })).map((h) => h.oid), ['n1', 'n2'], '依 since 升冪')
        assert.deepEqual(overdueHolds(await listHolds(st), T2).map((h) => h.oid), ['n2'])
        const w = await waiveHold(st, holdKey('notes', 'n2', 'ES15'), { by: '使用者', ruling: '此篇為目錄頁,不提煉', at: T2 })
        assert.deepEqual([w.status, w.waivedBy, w.ruling, w.waivedAt], ['waived', '使用者', '此篇為目錄頁,不提煉', T2])
        assert.deepEqual(overdueHolds(await listHolds(st), T2), [], '豁免後不再逾期')
        await assert.rejects(() => requestRetry(st, w.id, { at: T2 }), /已結案（waived），不可重試/)
        await assert.rejects(() => waiveHold(st, 'x:y:z', { by: 'a', ruling: 'b' }), /無此待判登錄/)
    })

    it('重開已結案／已豁免之登錄:前一段之處置(結案方式、豁免之裁示者與內容)存入 history、依序累積——裁示不被新登錄抹除', async () => {
        const st = memStore()
        const a = await putHold(st, H(), T1)
        assert.equal(a.history, undefined, '首次登錄無 history')
        await waiveHold(st, a.id, { by: '使用者', ruling: '保留此爭議', at: T2 })
        const b = await putHold(st, H({ reason: '內容變更後再判不了' }), '2026-10-06T10:00:00+08:00')
        assert.deepEqual([b.status, b.history.length, b.history[0].status, b.history[0].waivedBy, b.history[0].ruling, b.history[0].waivedAt], ['open', 1, 'waived', '使用者', '保留此爭議', T2])
        await resolveHold(st, b.id, { at: '2026-10-07T10:00:00+08:00', how: '兩席覆核已判定' })
        const c = await putHold(st, H(), '2026-10-08T10:00:00+08:00')
        assert.deepEqual(c.history.map((x) => [x.status, x.how || x.ruling]), [['waived', '保留此爭議'], ['resolved', '兩席覆核已判定']])
        const d = await putHold(st, H({ reason: '仍判不了' }), '2026-10-09T10:00:00+08:00')
        assert.equal(d.history.length, 2, '未結案再登錄不增 history')
    })

    it('真 LMDB:待判登錄之 ctx(巢狀物件)經 replace 落庫逐欄相符', async () => {
        const holds = W.openCollection({ WOrm, path: `${root}/db`, db: 'knowledge', cl: 'holds' })
        try {
            const h = await putHold(holds, H(), T1)
            assert.deepEqual(await holds.get(h.id), h)
            await putHold(holds, H({ reason: '仍逾上限' }), T2)
            assert.deepEqual([(await holds.get(h.id)).tries, (await holds.get(h.id)).reason], [1, '仍逾上限'])
        }
        finally {
            await holds.close()
        }
    })

    it('常值、預設負責者、鍵之轉字串、resolveHold 無此登錄回 null、listHolds 依 std／owner 篩選、overdueHolds 非陣列視為空', async () => {
        assert.deepEqual([HOLD_STATUSES, HOLD_OWNERS], [['open', 'resolved', 'waived'], ['pipeline', 'user']])
        assert.equal(holdKey(undefined, null, 5), '::5', '鍵之各段轉字串(缺者為空)')
        const st = memStore()
        assert.equal(await resolveHold(st, 'x:y:z', { at: T1, how: 'h' }), null)
        const a = await putHold(st, H({ owner: undefined }), T1)
        assert.equal(a.owner, 'pipeline', '未給負責者預設 pipeline')
        await putHold(st, H({ oid: 'n2', std: 'RS8', owner: 'user' }), T1)
        assert.deepEqual((await listHolds(st, { std: 'RS8' })).map((h) => h.oid), ['n2'])
        assert.deepEqual((await listHolds(st, { owner: 'pipeline' })).map((h) => h.oid), ['n1'])
        assert.deepEqual(overdueHolds(null, T1), [])
        assert.deepEqual(overdueHolds([{ status: 'open', deadline: '' }, { status: 'open' }], T1), [], '無期限者不逾期')
    })

    it('overdueHolds 以時刻比較(期限與現在時刻之時區表示不同時不提早判逾期);無法解析之期限或現在時刻不列', () => {
        const due = '2026-11-05T16:00:00.000Z' // ＝ 2026-11-06T00:00:00+08:00
        const h = [{ status: 'open', deadline: due, oid: 'a' }]
        assert.deepEqual(overdueHolds(h, '2026-11-05T23:00:00+08:00'), [], '同一時刻前 1 小時(+08:00 字面較大)不得判逾期')
        assert.deepEqual(overdueHolds(h, '2026-11-06T00:00:00+08:00'), [], '恰為期限之時刻不逾期')
        assert.deepEqual(overdueHolds(h, '2026-11-06T00:00:01+08:00').map((x) => x.oid), ['a'])
        assert.deepEqual(overdueHolds(h, '2026-11-05T16:00:01Z').map((x) => x.oid), ['a'], '同為 UTC 亦同')
        assert.deepEqual(overdueHolds([{ status: 'open', deadline: '不是時刻' }], '2026-11-06T00:00:01+08:00'), [])
        assert.deepEqual(overdueHolds(h, ''), [], '現在時刻無法解析即不列')
    })

    it('retryRequestedOf:要求晚於登錄之最後更新才算(以時刻比較——時區表示不同之同一時刻不算晚);未要求、非物件為 false;無法解析者依字面', () => {
        const at = '2026-10-05T02:00:00.000Z' // ＝ 10:00+08:00
        assert.equal(retryRequestedOf({ at, retryRequestedAt: '2026-10-05T10:00:01+08:00' }), true)
        assert.equal(retryRequestedOf({ at, retryRequestedAt: '2026-10-05T10:00:00+08:00' }), false, '同一時刻不算晚')
        assert.equal(retryRequestedOf({ at, retryRequestedAt: '2026-10-05T09:00:00+08:00' }), false, '+08:00 之字面較大但時刻較早——字串比較會誤判為晚')
        assert.equal(retryRequestedOf({ at: '2026-10-05T10:00:00+08:00', retryRequestedAt: '2026-10-05T03:00:00.000Z' }), true, '時刻較晚而字面較小')
        assert.equal(retryRequestedOf({ at: 'T1', retryRequestedAt: 'T2' }), true, '無法解析 → 依字面')
        assert.equal(retryRequestedOf({ at, retryRequestedAt: '' }), false)
        assert.equal(retryRequestedOf({ retryRequestedAt: T1 }), true, '登錄無 at 而有要求')
        for (const x of [null, undefined, 'x', [], {}]) assert.equal(retryRequestedOf(x), false)
    })

    it('pipelineDueOf:負責者為管線,或使用者要求了重試', () => {
        assert.equal(pipelineDueOf({ owner: 'pipeline', at: T1 }), true)
        assert.equal(pipelineDueOf({ owner: 'user', at: T1 }), false)
        assert.equal(pipelineDueOf({ owner: 'user', at: T1, retryRequestedAt: T2 }), true)
        assert.equal(pipelineDueOf(null), false)
    })

    it('holdDeadlineOf:登錄時刻起若干天(UTC);時刻無法解析、天數非正數即拋', () => {
        assert.equal(holdDeadlineOf('2026-10-01T08:00:00+08:00', 30), '2026-10-31T00:00:00.000Z')
        assert.equal(holdDeadlineOf('2026-10-01T00:00:00Z', 0.5), '2026-10-01T12:00:00.000Z')
        assert.throws(() => holdDeadlineOf('不是時刻', 30), (e) => e instanceof RangeError && /時刻無法解析/.test(e.message))
        for (const d of [0, -1, NaN, '30', undefined]) assert.throws(() => holdDeadlineOf(T1, d), (e) => e instanceof RangeError && /天數須為正數/.test(e.message), String(d))
    })

    it('holdStockUnfixable:新登錄者記帳列 { object:hold, id:鍵, stds, before:{ hold:登錄前之記錄｜null }, hold:鍵 };已未結或已豁免者不重登、不記帳;負責者預設 user;缺集合即拋', async () => {
        const st = memStore()
        const rows = []
        const log = (r) => rows.push(r)
        const h = { object: 'note', oid: 'n1', std: 'SS2', reason: '存量修不了（SS2）：缺內容類型', next: '使用者修正', deadline: holdDeadlineOf(T1, 30) }
        const a = await holdStockUnfixable(st, h, { at: T1, log })
        assert.deepEqual(a, { key: 'note:n1:SS2', held: true })
        assert.deepEqual(rows, [{ object: 'hold', id: 'note:n1:SS2', stds: ['SS2'], before: { hold: null }, hold: 'note:n1:SS2' }])
        const rec = await st.get('note:n1:SS2')
        assert.deepEqual([rec.owner, rec.status, rec.since, rec.deadline], ['user', 'open', T1, '2026-11-03T02:00:00.000Z'])
        assert.deepEqual(await holdStockUnfixable(st, h, { at: T2, log }), { key: 'note:n1:SS2', held: false }, '已未結 → 不重登')
        await waiveHold(st, 'note:n1:SS2', { by: '使用者', ruling: '維持', at: T2 })
        assert.deepEqual(await holdStockUnfixable(st, h, { at: T2, log }), { key: 'note:n1:SS2', held: false }, '已豁免 → 不重開')
        assert.equal(rows.length, 1, '未新登錄者不記帳')
        await assert.rejects(() => holdStockUnfixable(null, h, { at: T1 }), /未開 holds 集合，修不了之存量未登錄待判/)
        await assert.rejects(() => holdStockUnfixable(st, { ...h, oid: 'n2', next: '' }, { at: T1 }), /需要原因與下一步/)
        // 原因未給 → 以 detail 組成「存量修不了（標準）：說明」(說明至多 300 字);detail 不入登錄
        const { reason, ...noReason } = h
        assert.equal(reason, '存量修不了（SS2）：缺內容類型')
        await holdStockUnfixable(st, { ...noReason, oid: 'n3', detail: '缺內容類型' }, { at: T1 })
        const n3 = await st.get('note:n3:SS2')
        assert.deepEqual([n3.reason, Object.hasOwn(n3, 'detail')], [reason, false])
        await holdStockUnfixable(st, { ...noReason, oid: 'n4', detail: '長'.repeat(400) }, { at: T1 })
        assert.equal((await st.get('note:n4:SS2')).reason, `存量修不了（SS2）：${'長'.repeat(300)}`)
    })

    it('rollbackStockHold(回退＝撤銷該次登錄):只動同一登錄(未結且 since＝帳列時刻)——新登錄者結案、重開已結案者寫回登錄前之記錄;已豁免、他次登錄(since 不同)、已結案者不動;缺集合即拋', async () => {
        const st = memStore()
        const rows = []
        const log = (r) => rows.push({ at: T1, ...r }) // 帳之寫列器附 at(＝登錄時刻)
        const h = (oid) => ({ object: 'notes', oid, std: 'ES15', reason: '存量修不了（ES15）：x', next: '使用者', deadline: holdDeadlineOf(T1, 30) })
        // a:新登錄 → 回退結案
        await holdStockUnfixable(st, h('a'), { at: T1, log })
        assert.equal(await rollbackStockHold(st, rows[0], T2), true)
        const ra = await st.get(holdKey('notes', 'a', 'ES15'))
        assert.deepEqual([ra.status, ra.how, ra.resolvedAt], ['resolved', '存量處置回退', T2])
        // b:登錄後使用者豁免 → 回退不改寫
        await holdStockUnfixable(st, h('b'), { at: T1, log })
        await waiveHold(st, holdKey('notes', 'b', 'ES15'), { by: '使用者', ruling: '維持', at: T2 })
        assert.equal(await rollbackStockHold(st, rows[1], T2), false)
        assert.equal((await st.get(holdKey('notes', 'b', 'ES15'))).status, 'waived', '豁免不被改寫')
        // c:重開已結案者 → 回退寫回登錄前之記錄(結案狀態與其處置方式)
        const c0 = await putHold(st, H({ oid: 'c' }), '2026-10-01T00:00:00+08:00')
        const c1 = await resolveHold(st, c0.id, { at: '2026-10-02T00:00:00+08:00', how: '已處置' })
        await holdStockUnfixable(st, h('c'), { at: T1, log })
        assert.deepEqual(rows[2].before, { hold: c1 })
        assert.equal(await rollbackStockHold(st, rows[2], T2), true)
        assert.deepEqual(await st.get(c0.id), c1, '回到登錄前(已結案)')
        // d:其後被結案再由他次登錄重開(since 不同)→ 不動
        await holdStockUnfixable(st, h('d'), { at: T1, log })
        await resolveHold(st, holdKey('notes', 'd', 'ES15'), { at: T2, how: '他處結案' })
        await putHold(st, h('d'), '2026-10-07T00:00:00+08:00')
        assert.equal(await rollbackStockHold(st, rows[3], T2), false, '他次登錄不動')
        assert.equal((await st.get(holdKey('notes', 'd', 'ES15'))).status, 'open')
        assert.equal(await rollbackStockHold(st, { at: T1, id: 'x:y:z' }, T2), false, '無此登錄')
        await assert.rejects(() => rollbackStockHold(undefined, rows[0], T2), /未開 holds 集合，待判未結案/)
    })

    it('closeStockHold:未結者結案並記結案列(before 為結案前之登錄);非未結者不動、不記;reopenStockHold:仍為該次所結者復原,其後已被重開或豁免者不動', async () => {
        const st = memStore()
        const rows = []
        const a = await putHold(st, H({ oid: 'a', owner: 'user' }), T1)
        assert.equal(await closeStockHold(st, a.id, 'ES15', { at: T2, log: (r) => rows.push(r) }), true)
        assert.deepEqual([(await st.get(a.id)).status, (await st.get(a.id)).how], ['resolved', '存量處置重掃已無此違反'])
        assert.deepEqual(rows, [{ object: 'hold-resolved', id: a.id, stds: ['ES15'], before: { hold: a }, hold: a.id }])
        assert.equal(await closeStockHold(st, a.id, 'ES15', { at: T2, log: (r) => rows.push(r) }), false, '已結案 → 不動')
        assert.equal(rows.length, 1)
        // 回退結案列:仍為該次所結者 → 復原為結案前之登錄
        assert.equal(await reopenStockHold(st, { at: T2, ...rows[0] }), true)
        assert.deepEqual(await st.get(a.id), a)
        // 其後被重開(結案時刻不同)者不動
        assert.equal(await closeStockHold(st, a.id, 'ES15', { at: T2 }), true)
        await putHold(st, H({ oid: 'a', owner: 'user' }), '2026-10-06T10:00:00+08:00')
        assert.equal(await reopenStockHold(st, { at: T2, ...rows[0] }), false, '已被重開 → 不動')
        await assert.rejects(() => closeStockHold(null, a.id, 'ES15', { at: T2 }), /未開 holds 集合，已不再違反之待判未結案/)
        await assert.rejects(() => reopenStockHold(undefined, rows[0]), /未開 holds 集合，待判未處置/)
    })

    it('stockHoldProblems:登錄列已登錄、結案列之登錄在且已結案無問題;未登錄、結案列仍未結或登錄不在、無集合者列出', async () => {
        const st = memStore()
        await putHold(st, H({ oid: 'a' }), T1)
        const key = holdKey('notes', 'a', 'ES15')
        assert.deepEqual(await stockHoldProblems(st, { object: 'hold', id: key, hold: key }), [])
        assert.deepEqual(await stockHoldProblems(st, { object: 'hold', id: 'x:y:z' }), ['待判 x:y:z：未登錄'])
        assert.deepEqual(await stockHoldProblems(st, { object: 'hold-resolved', id: key, hold: key }), [`待判 ${key}：未結案`])
        await resolveHold(st, key, { at: T2, how: 'h' })
        assert.deepEqual(await stockHoldProblems(st, { object: 'hold-resolved', id: key, hold: key }), [])
        assert.deepEqual(await stockHoldProblems(st, { object: 'hold-resolved', id: 'x:y:z' }), ['待判 x:y:z：不在（結案列之登錄須在）'], '結案列之登錄不在 → 問題(此前不在即不報)')
        assert.deepEqual(await stockHoldProblems(null, { object: 'hold', id: 'x:y:z' }), ['待判 x:y:z：未開 holds 集合，無從驗證'])
    })
})
