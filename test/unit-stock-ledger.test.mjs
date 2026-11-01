// unit-stock-ledger.test.mjs — 存量處置帳之讀寫協定(core/stores/stockLedger;四工作與宿主同一本帳)
// 規則(出自 core/stores/stockLedger 檔頭與 JSDoc):
//   ①路徑:opt.ledgerFile 優先,其次 dirs.state 下之 STOCK_LEDGER_FILE;皆無即拋;時刻:opt.at 優先,其次 clock.iso8()
//   ②寫列:每列 { at, ...列 } 立即附寫;首次寫入時建目錄(無列不建);未給帳檔者只收於記憶體;onRow 每列呼叫
//   ③回退列 { at, rollbackOf, object, id };讀帳排除回退列與已被回退者(鍵 at|object|id)
//   ④讀帳:keep 只留本工作之列;since 以時刻比較(時區表示可不同;無法解析者依字面);at 字面相等;檔不存在或非字串 → 無列
//   ⑤壞行即拒:無法解析或非物件之列(含檔尾截斷)回報行號;stockLedgerRowsOf 遇之即拋,allowBad 才略過
//   ⑥逐件錯誤列(stockErrorOf):{ id, object, error } 皆字串、訊息上限 200 字(前綴不計)
//   ⑦回退防護(回退＝撤銷該次處置之效果):rollbackPlanOf 逐單位比現值——＝before(含處置前不存在而現亦不存在)→ done、＝after → restore、皆不是 → conflict;
//     記錄不在者依各單位之 before 判;缺 after 即拋;rollbackWriteOf 處置前不存在之單位列 unset(刪而非寫 null);writeRollback 無 unset 者 patch、
//     有者 replace 整筆;回退列可附 extra(接受現值之取代列 { accepted:'current', units }),讀帳同樣排除被取代者
// 執行:自套件根 npx mocha test/unit-stock-ledger.test.mjs(暫存 test/_tmp/stock-ledger-<pid>,測完即刪)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpRoot, removeRoots } from './tools/captureTestKit.mjs'
import { memStore } from './tools/memStore.mjs'
import {
    STOCK_LEDGER_FILE, STOCK_LEDGER_BAD_LINES, stockLedgerFileOf, stockAtOf, parseStockLedger, stockLedgerRowsOf, stockLedgerWriter, appendRollbackRow, stockErrorOf,
    rollbackPlanOf, rollbackWriteOf, writeRollback,
} from '../src/core/stores/stockLedger.mjs'
import { canonOf, sameValue } from '../src/core/util/values.mjs'

describe('unit-stock-ledger', function() {

    let root = ''
    let seq = 0
    const fileOf = () => `${root}/c${++seq}/state/${STOCK_LEDGER_FILE}`
    before(() => {
        root = tmpRoot('stock-ledger')
    })
    after(() => {
        removeRoots([root])
    })

    it('路徑:opt.ledgerFile 優先,其次 dirs.state;皆無即拋(寫入須可回退與稽核);時刻:opt.at 優先,其次 clock.iso8()', () => {
        assert.equal(stockLedgerFileOf({ dirs: { state: '/s' } }, { ledgerFile: '/x.jsonl' }, 'w'), '/x.jsonl')
        assert.equal(stockLedgerFileOf({ dirs: { state: '/s' } }, {}, 'w'), path.join('/s', 'stock-fix.jsonl'))
        assert.throws(() => stockLedgerFileOf({}, {}, 'applyX'), /applyX 需要處置帳之路徑/)
        assert.equal(stockAtOf({ clock: { iso8: () => 'C' } }, { at: 'A' }), 'A')
        assert.equal(stockAtOf({ clock: { iso8: () => 'C' } }, {}), 'C')
        assert.ok(Date.parse(stockAtOf({}, {})) > 0, '皆無 → 現在')
    })

    it('寫列:立即附寫 { at, ...列 };首次寫入時建目錄(無列不建);onRow 每列呼叫;未給帳檔者只收於記憶體', () => {
        const f = fileOf()
        const seen = []
        const w = stockLedgerWriter(f, 'T1', { onRow: (r) => seen.push(r.id) })
        assert.equal(fs.existsSync(path.dirname(f)), false, '無列不建目錄')
        w.log({ object: 'doc', id: 'd1', stds: ['CS10'] })
        w.log({ object: 'doc', id: 'd2', stds: ['CS10'] })
        assert.deepEqual(fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)), [{ at: 'T1', object: 'doc', id: 'd1', stds: ['CS10'] }, { at: 'T1', object: 'doc', id: 'd2', stds: ['CS10'] }])
        assert.deepEqual([w.rows.length, seen], [2, ['d1', 'd2']])
        const mem = stockLedgerWriter('', 'T1')
        mem.log({ object: 'doc', id: 'd3' })
        assert.deepEqual(mem.rows, [{ at: 'T1', object: 'doc', id: 'd3' }])
    })

    it('回退列與讀帳:排除回退列與已被回退者;keep 只留本工作之列;since 以時刻比較、at 字面相等;檔不存在 → 無列', () => {
        const f = fileOf()
        const w = stockLedgerWriter(f, '2026-10-05T04:00:00+08:00')
        w.log({ object: 'note', id: 'n1', stds: ['SS3'] })
        w.log({ object: 'edge', id: 'e1', stds: ['RS3'] })
        w.log({ object: 'note', id: 'n2', stds: ['SS3'] })
        appendRollbackRow(f, w.rows[0], '2026-10-05T05:00:00+08:00')
        const w2 = stockLedgerWriter(f, '2026-10-05T06:00:00Z')
        w2.log({ object: 'note', id: 'n3', stds: ['SS3'] })
        const { rows, bad } = parseStockLedger(f, { keep: (r) => r.object === 'note' })
        assert.deepEqual([rows.map((r) => r.id), bad], [['n2', 'n3'], []], '回退列與已被回退之 n1 不列;他工作之列不列')
        assert.deepEqual(parseStockLedger(f, { since: '2026-10-05T13:00:00+08:00' }).rows.map((r) => r.id), ['n3'], '06:00Z＝14:00+08:00(字面比較會漏判)')
        assert.deepEqual(parseStockLedger(f, { at: '2026-10-05T04:00:00+08:00' }).rows.map((r) => r.id), ['e1', 'n2'])
        assert.deepEqual(parseStockLedger(`${root}/none.jsonl`), { rows: [], bad: [] })
        assert.deepEqual(parseStockLedger(null), { rows: [], bad: [] })
        appendRollbackRow('', w.rows[1], 'T9')
        assert.equal(parseStockLedger(f).rows.length, 3, '未給帳檔者不寫回退列')
    })

    it('seq:寫列器開 seq 者每列帶本次序號;回退列與作廢列帶 rollbackOfSeq 精確對應那一列(同一次套用對同一物件可有多列);未開者列形狀不變、仍以 at|object|id 對應', () => {
        const f = fileOf()
        const w = stockLedgerWriter(f, 'T1', { seq: true })
        w.log({ object: 'core', id: 'k', stds: ['ES3'] })
        w.log({ object: 'hold', id: 'core:k:ES3', stds: ['ES3'] })
        w.log({ object: 'core', id: 'k', stds: ['ES5'] })
        assert.deepEqual(w.rows.map((r) => [r.seq, r.object, r.id]), [[0, 'core', 'k'], [1, 'hold', 'core:k:ES3'], [2, 'core', 'k']], '「每列 { at, seq, … }」')
        // 作廢第一列(先記後寫而寫入失敗):只排除 seq 0,同物件同 id 之 seq 2 仍列
        appendRollbackRow(f, w.rows[0], 'T2', { voided: 'write-failed' })
        const lines = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
        assert.deepEqual(lines.at(-1), { voided: 'write-failed', at: 'T2', rollbackOf: 'T1', rollbackOfSeq: 0, object: 'core', id: 'k' })
        assert.deepEqual(parseStockLedger(f).rows.map((r) => r.seq), [1, 2], '「帶 rollbackOfSeq 者精確對應該 at 之第 seq 列」')
        // 未開 seq 之寫列器:列無 seq;其回退列無 rollbackOfSeq,以 at|object|id 對應(同物件同 id 皆排除——舊協定)
        const w2 = stockLedgerWriter(f, 'T3')
        w2.log({ object: 'doc', id: 'd', stds: ['CS10'] })
        assert.equal('seq' in w2.rows[0], false)
        appendRollbackRow(f, w2.rows[0], 'T4')
        assert.deepEqual(parseStockLedger(f).rows.map((r) => [r.at, r.seq]), [['T1', 1], ['T1', 2]])
    })

    it('壞行即拒:無法解析與非物件之列(含檔尾截斷)回報行號;stockLedgerRowsOf 遇之即拋,allowBad 才略過', () => {
        const f = fileOf()
        const w = stockLedgerWriter(f, 'T1')
        w.log({ object: 'note', id: 'n1' })
        fs.appendFileSync(f, 'null\n[1,2]\n{"at":"T1","object":"note","id":"n2"}\n{"at":"截', 'utf8')
        const { rows, bad } = parseStockLedger(f)
        assert.deepEqual(rows.map((r) => r.id), ['n1', 'n2'])
        assert.deepEqual(bad.map((b) => b.line), [2, 3, 5])
        assert.match(bad[0].error, /不是物件/)
        assert.throws(() => stockLedgerRowsOf(f), /處置帳 .* 有 3 行無法解析（第 2 行：不是物件；第 3 行：不是物件；第 5 行：.*）.*allowBad/)
        assert.throws(() => stockLedgerRowsOf(f), (e) => e.code === STOCK_LEDGER_BAD_LINES && e.bad.map((b) => b.line).join(',') === '2,3,5', 'code 供呼叫端提示其略過之開關')
        assert.deepEqual(stockLedgerRowsOf(f, { allowBad: true }).map((r) => r.id), ['n1', 'n2'])
        assert.deepEqual(stockLedgerRowsOf(`${root}/none.jsonl`), [])
    })

    it('⑦回退防護:三態(done／restore／conflict)、記錄不在、缺 after 即拋;寫回刪處置前不存在之單位(replace)、否則 patch;取代列附 extra 而讀帳排除被取代者;值之正規化比較', async () => {
        const row = { at: 'T1', object: 'doc', id: 'd1', before: { status: 'noted', notedAt: 'N0' }, after: { status: 'skip', notedAt: 'N0', dupOf: 'd0' } }
        assert.deepEqual(rollbackPlanOf({ id: 'd1', status: 'skip', notedAt: 'N0', dupOf: 'd0', other: 1 }, row), { restore: ['status', 'dupOf'], done: ['notedAt'], conflict: [] }, '處置後未被動:可寫回(未改之單位為 done)')
        assert.deepEqual(rollbackPlanOf({ id: 'd1', status: 'noted', notedAt: 'N0' }, row), { restore: [], done: ['status', 'notedAt', 'dupOf'], conflict: [] }, '已回到處置前(冪等;處置前不存在而現亦不存在＝done)')
        assert.deepEqual(rollbackPlanOf({ id: 'd1', status: 'noted', notedAt: 'N0', dupOf: 'd0' }, row), { restore: ['dupOf'], done: ['status', 'notedAt'], conflict: [] }, '半途:只剩未回者')
        assert.deepEqual(rollbackPlanOf({ id: 'd1', status: 'archived', notedAt: 'N0', dupOf: 'd0' }, row).conflict, ['status'], '其後被改動 → 衝突')
        assert.deepEqual(rollbackPlanOf({ id: 'd1', status: 'skip', notedAt: 'N0', dupOf: null }, row).conflict, ['dupOf'], 'null 不等於不存在(不把殘留之 null 當處置前)')
        assert.deepEqual(rollbackPlanOf(null, row), { restore: [], done: ['dupOf'], conflict: ['status', 'notedAt'] }, '記錄不在:處置前存在之單位皆衝突(不復活)')
        assert.throws(() => rollbackPlanOf({}, { before: {} }), /帳列缺 after（處置後之值），無從判定其後是否被改動/)
        assert.deepEqual(rollbackWriteOf(row, ['status', 'dupOf']), { patch: { status: 'noted' }, unset: ['dupOf'] })
        const st = memStore([{ id: 'd1', status: 'skip', notedAt: 'N0', dupOf: 'd0', other: 1 }])
        let replaced = 0
        const real = st.replace
        st.replace = async (rec) => {
            replaced++
            return real(rec)
        }
        await writeRollback(st, await st.get('d1'), rollbackWriteOf(row, ['status', 'dupOf']))
        assert.deepEqual([await st.get('d1'), replaced], [{ id: 'd1', status: 'noted', notedAt: 'N0', other: 1 }, 1], '刪鍵以 replace 寫整筆(不留 null)')
        await writeRollback(st, await st.get('d1'), { patch: { status: 'x' }, unset: [] })
        assert.deepEqual([(await st.get('d1')).status, replaced], ['x', 1], '無須刪鍵者 patch')
        const f = fileOf()
        const w = stockLedgerWriter(f, 'T1')
        w.log({ object: 'doc', id: 'd1', stds: ['CS10'] })
        appendRollbackRow(f, w.rows[0], 'T2', { accepted: 'current', units: ['status'], at: 'X', rollbackOf: 'X' })
        const lines = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
        assert.deepEqual(lines[1], { accepted: 'current', units: ['status'], at: 'T2', rollbackOf: 'T1', object: 'doc', id: 'd1' }, 'extra 不覆寫回退列之鍵')
        assert.deepEqual(parseStockLedger(f).rows, [], '被取代者讀帳排除')
        assert.equal(canonOf({ b: [2, 1], a: 'x', c: undefined }), '{"a":"x","b":[2,1]}')
        assert.deepEqual([sameValue({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 }), sameValue([1, 2], [2, 1]), sameValue(undefined, null)], [true, false, false])
    })

    it('逐件錯誤列:{ id, object, error } 皆字串;訊息取錯誤之 message、上限 200 字(前綴不計);非錯誤物件之訊息為空', () => {
        assert.deepEqual(stockErrorOf('d1', 'doc', new Error('寫入失敗')), { id: 'd1', object: 'doc', error: '寫入失敗' })
        assert.deepEqual(stockErrorOf(undefined, null, new Error('x')), { id: '', object: '', error: 'x' })
        const long = stockErrorOf('e1', 'edge', new Error('甲'.repeat(300)), 'onEdgeFixed：')
        assert.deepEqual([long.error.startsWith('onEdgeFixed：甲'), long.error.length], [true, 'onEdgeFixed：'.length + 200])
        assert.deepEqual([stockErrorOf('n', 'note', '字串').error, stockErrorOf('n', 'note', null).error], ['', ''])
    })
})
