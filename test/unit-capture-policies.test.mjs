// unit-capture-policies.test.mjs — 抓取之政策件(純機制,以記憶體集合替身驗證):
//   stores/sourcePolicy(來源種子同步、輪抓挑選、成敗計數、品質淘汰、產出率回饋、冷卻重探)、
//   core/stores/docPolicy(終態瘦身、待處理佇列選取順序)、core/stores/docTexts(原文另存與取回)、
//   core/stores/frontierPolicy(線索去重累加、優先序、上限淘汰、消化紀錄)、stores/ingestGate(入庫單一閘門與同一內容判定)、
//   stages/collectHelpers(來源產出統計)
//   各案例之應然取自各模組檔頭之契約(狀態機約定、無時間型過期、記錄永不刪除、計數歸零時機、機制入套件而門檻留執行端);
//   每條輸入檢查至少一個無效輸入案例＋一個有效輸入行為不變之案例
// 執行:自套件根 npx mocha test/unit-capture-policies.test.mjs(不發網路、不落檔)

import assert from 'node:assert/strict'
import W from 'w-data-pipeline/src/WDataPipeline.mjs'
import { memStore } from './tools/memStore.mjs'
import { nullLogger } from './tools/nullLogger.mjs'
import { ensureSeedSources, isLowYield, pickDueSources, recordSourceOutcome, cullZeroYieldSources, reprobeSources, reprobeDue, sourceStopReasonOf, sourceRecordProblems } from '../src/stores/sourcePolicy.mjs'
import { slimTerminalDocs, byRetryTierFifo, DOC_TERMINAL_STATUSES, DOC_PENDING_STATUSES, DOC_STATUSES, docQueuesOf, docQueueStatsOf } from '../src/core/stores/docPolicy.mjs'
import { unpackText, docTextOf, docTextRestoreOf, archiveDocText } from '../src/core/stores/docTexts.mjs'
import { clueKey, clueRulesOf, clueDropOf, saveClues, pickClues, settleClue, enforceFrontierCap } from '../src/core/stores/frontierPolicy.mjs'
import { ingestFeedItems, normalizeFeedItems, filterFeedItems, admitFeedItems } from '../src/stores/ingestGate.mjs'
import { paraKeysOf, sharedParas } from '../src/stores/contentIndex.mjs'
import { judgeFromDocs } from '../src/stages/collectHelpers.mjs'
import { CAPTURE_DEFAULT } from '../src/core/settingsDefault.mjs'
import { setConceptFold } from '../src/core/util/text.mjs'
import { defaultToRecord } from '../src/core/util/records.mjs'
import { settingsOf as S } from './tools/captureTestKit.mjs'

const log = nullLogger()
const NOW = '2026-08-18T12:00:00+08:00'

describe('unit-capture-policies', function() {

    // 線索鍵之折疊為模組級單例(core/util/text):mocha --parallel 之 worker 會重用行程,他檔注入之折疊會殘留;
    // 本檔前提為「未注入折疊」,故前後一律清除
    before(function() {
        setConceptFold(null)
    })

    after(function() {
        setConceptFold(null)
    })

    // ══════════════════════════ sourcePolicy ══════════════════════════
    describe('sourcePolicy', function() {

        it('種子同步：宣告欄位跟著種子檔更新，執行期統計不動', async () => {
            const s = memStore([{ id: 'a', tier: 2, name: '舊名', okCount: 7, lastFetchAt: 'X' }])
            const r = await ensureSeedSources(s, [{ id: 'a', tier: 1, name: '新名' }, { id: 'b', tier: 3, name: 'B' }])
            assert.equal(r.addCount, 1)
            assert.equal(r.synced, 1)
            const a = await s.get('a')
            assert.equal(a.tier, 1)
            assert.equal(a.name, '新名')
            assert.equal(a.okCount, 7, '執行期統計不可被種子覆寫')
        })

        it('ensureSeedSources：sources 缺方法拋錯；seeds 非陣列拋錯；declaredFields 非陣列回退預設仍可同步', async () => {
            await assert.rejects(() => ensureSeedSources({}, []), /ensureSeedSources 需要 sources 集合/)
            const s0 = memStore()
            await assert.rejects(() => ensureSeedSources(s0, 'not-array'), /ensureSeedSources 需要 seeds/)

            const s = memStore([{ id: 'a', tier: 2, name: '舊名' }])
            const r = await ensureSeedSources(s, [{ id: 'a', tier: 1, name: '新名' }], 'not-array')
            assert.equal(r.synced, 1, 'declaredFields 非陣列回退為預設 [tier,name,lang,query]，同步仍生效')
            assert.equal((await s.get('a')).name, '新名')
        })

        it('failCount 成功即歸零；連續失敗達門檻停用', async () => {
            const s = memStore([{ id: 'a', name: 'A', failCount: 7 }])
            await recordSourceOutcome(s, await s.get('a'), { ok: true, itemCount: 3 }, { nowIso: NOW, maxConsecFails: 8 })
            assert.equal((await s.get('a')).failCount, 0, '成功必歸零——不歸零會跨月累積讓健康來源莫名停用')
            for (let i = 0; i < 8; i++) await recordSourceOutcome(s, await s.get('a'), { ok: false, error: 'x' }, { nowIso: NOW, maxConsecFails: 8 })
            assert.equal((await s.get('a')).enabled, false, '連續 8 次失敗停用')
        })

        it('maxConsecFails 0＝永不因連敗停用(來源由宿主管理;零件庫用法):連敗照計 failCount、不停用;預設 8 不變', async () => {
            // 規則:stores/sourcePolicy.recordSourceOutcome 之 cfg.maxConsecFails(0＝永不);core/settingsDefault sources.maxConsecFails
            const s = memStore([{ id: 'a', name: 'A', failCount: 0 }])
            for (let i = 0; i < 20; i++) await recordSourceOutcome(s, await s.get('a'), { ok: false, error: 'x' }, { nowIso: NOW, maxConsecFails: 0 })
            assert.equal((await s.get('a')).failCount, 20, '連敗照計')
            assert.notEqual((await s.get('a')).enabled, false, '不停用')
            assert.equal(CAPTURE_DEFAULT.sources.maxConsecFails, 8)
            assert.equal(S({ sources: { maxConsecFails: 0 } }).capture.sources.maxConsecFails, 0, 'schema 收 0(p0int)')
        })

        it('空回計數只停用自動衍生來源，種子來源不受影響', async () => {
            const s = memStore([{ id: 'seed', name: 'S', origin: 'seed' }, { id: 'auto', name: 'A', origin: 'frontier:kw' }])
            const cfg = { nowIso: NOW, maxConsecEmpty: 3, isAutoSource: (x) => /^frontier:/.test(x.origin) }
            for (let i = 0; i < 3; i++) {
                await recordSourceOutcome(s, await s.get('seed'), { ok: true, itemCount: 0 }, cfg)
                await recordSourceOutcome(s, await s.get('auto'), { ok: true, itemCount: 0 }, cfg)
            }
            assert.notEqual((await s.get('seed')).enabled, false, '種子來源一時無新文不停用')
            assert.equal((await s.get('auto')).enabled, false)
        })

        it('停用條件之單一判定 sourceStopReasonOf(CS5;寫入與符合度掃描同用):連敗 failCount ≥ maxConsecFails(0＝永不)、自動來源 emptyCount ≥ maxConsecEmpty(種子不計);recordSourceOutcome 之停用即此判定(本輪計數後之記錄)', async () => {
            // 規則:stores/sourcePolicy 檔頭、sourceStopReasonOf JSDoc
            const auto = (x) => x.origin === 'auto'
            assert.equal(sourceStopReasonOf({ failCount: 8 }, { maxConsecFails: 8 }), '連續失敗 8 次')
            assert.equal(sourceStopReasonOf({ failCount: 7 }, { maxConsecFails: 8 }), '')
            assert.equal(sourceStopReasonOf({ failCount: 99 }, { maxConsecFails: 0 }), '', '0＝永不因連敗停用')
            assert.equal(sourceStopReasonOf({ failCount: 8 }), '連續失敗 8 次', '預設門檻 8')
            assert.equal(sourceStopReasonOf({ emptyCount: 5, origin: 'auto' }, { maxConsecEmpty: 5, isAutoSource: auto }), '連續 5 次無資料')
            assert.equal(sourceStopReasonOf({ emptyCount: 5, origin: 'seed' }, { maxConsecEmpty: 5, isAutoSource: auto }), '', '種子來源不因連空停用')
            assert.equal(sourceStopReasonOf({ emptyCount: 5, origin: 'auto' }, { maxConsecEmpty: 5 }), '', '未給 isAutoSource 即不判連空')
            assert.equal(sourceStopReasonOf({ failCount: 8, emptyCount: 5, origin: 'auto' }, { isAutoSource: auto }), '連續失敗 8 次', '兩者皆達以連敗為原因')
            assert.equal(sourceStopReasonOf(null, 'x'), '')
            // 與 recordSourceOutcome 同一判定:失敗分支以本輪 failCount 判;成功分支 failCount 歸零後以 emptyCount 判
            const s = memStore([{ id: 'a', name: 'A', origin: 'auto', failCount: 7, emptyCount: 4 }])
            const r1 = await recordSourceOutcome(s, await s.get('a'), { ok: false, error: 'x' }, { nowIso: NOW, maxConsecFails: 8, maxConsecEmpty: 5, isAutoSource: auto })
            assert.deepEqual([r1.disabled, r1.reason, (await s.get('a')).disableReason], [true, '連續失敗 8 次', '連續失敗 8 次'])
            const t = memStore([{ id: 'b', name: 'B', origin: 'auto', failCount: 3, emptyCount: 4 }])
            const r2 = await recordSourceOutcome(t, await t.get('b'), { ok: true, itemCount: 0 }, { nowIso: NOW, maxConsecFails: 8, maxConsecEmpty: 5, isAutoSource: auto })
            assert.deepEqual([r2.disabled, r2.reason, (await t.get('b')).failCount], [true, '連續 5 次無資料', 0])
        })

        it('來源記錄之形狀 sourceRecordProblems(CS5 存量掃描):時刻欄須為 ISO 字串、計數欄非負整數、enabled／paused 布林、原因欄字串;未給者不判(手動停用可無原因、舊記錄可缺時刻);非物件即一條問題', () => {
            // 規則:sourceRecordProblems JSDoc
            assert.deepEqual(sourceRecordProblems({ id: 'a', enabled: false, disabledAt: '2026-01-01T00:00:00Z', failCount: 8, disableReason: '連續失敗 8 次' }), [])
            assert.deepEqual(sourceRecordProblems({ id: 'a', enabled: false }), [], '手動停用可無原因與時刻')
            assert.deepEqual(sourceRecordProblems({ id: 'a', disabledAt: 'yesterday' }), ['disabledAt 非時刻字串'])
            assert.deepEqual(sourceRecordProblems({ id: 'a', failCount: -1, judged: 1.5, reprobes: '2' }), ['failCount 非非負整數', 'judged 非非負整數', 'reprobes 非非負整數'])
            assert.deepEqual(sourceRecordProblems({ id: 'a', enabled: 'yes', paused: 0 }), ['enabled 非布林', 'paused 非布林'])
            assert.deepEqual(sourceRecordProblems({ id: 'a', disableReason: 3, lastError: {} }), ['disableReason 非字串', 'lastError 非字串'])
            assert.deepEqual(sourceRecordProblems({ id: 'a', lastFetchAt: '', windowFrom: null, reprobedAt: undefined }), [], '空字串／null／undefined 視為未給')
            assert.deepEqual(sourceRecordProblems('x'), ['記錄非物件'])
        })

        it('recordSourceOutcome：sources 缺 patch 拋錯；outcome 非物件拋錯；cfg 非物件回退為 {}', async () => {
            const s = memStore([{ id: 'a', name: 'A' }])
            const a = await s.get('a')
            await assert.rejects(() => recordSourceOutcome({}, a, { ok: true }), /recordSourceOutcome 需要 sources 集合/)
            await assert.rejects(() => recordSourceOutcome(s, a, null), /recordSourceOutcome 需要 outcome 物件/)
            const rec = await recordSourceOutcome(s, a, { ok: true, itemCount: 1 }, null)
            assert.equal(rec.disabled, false, 'cfg 非物件回退為 {}，不拋錯且正常寫入')
            assert.equal((await s.get('a')).okCount, 1)
        })

        it('來源 extraPatch 只在成功時套用;預設 extraPatchOf 只在 OpenAlex 成功回應(來源物件標 _fetchedVia)時前進 grid cursor', async () => {
            const s = memStore([{ id: 'g', name: 'G', kind: 'grid', cursor: 3, failCount: 0 }])
            await recordSourceOutcome(s, await s.get('g'), { ok: false, error: 'x' }, { nowIso: NOW, extraPatch: { cursor: 4 } })
            assert.equal((await s.get('g')).cursor, 3, '失敗不前進')
            await recordSourceOutcome(s, await s.get('g'), { ok: true, itemCount: 8 }, { nowIso: NOW, extraPatch: { cursor: 4 } })
            assert.equal((await s.get('g')).cursor, 4)
            const f = CAPTURE_DEFAULT.sources.extraPatchOf
            assert.deepEqual(f({ kind: 'grid', cursor: 2, _fetchedVia: 'openalex' }, { ok: true }), { cursor: 3 })
            assert.deepEqual(f({ kind: 'grid', cursor: 2, _fetchedVia: 'arxiv' }, { ok: true }), {}, '改走 arXiv 遞補(不用 cursor):不前進,該頁 OpenAlex 下輪重抓')
            assert.deepEqual(f({ kind: 'grid', cursor: 2 }, { ok: true }), {}, '未標 _fetchedVia(抓取器非內建 grid)不前進')
            assert.deepEqual(f({ kind: 'grid', cursor: 2, _fetchedVia: 'openalex' }, { ok: false }), {})
            assert.deepEqual(f({ kind: 'rss' }, { ok: true }), {})
        })

        it('零產出淘汰：有產出或樣本不足者不動', async () => {
            const s = memStore([
                { id: 'z', name: '純雜訊' }, { id: 'm', name: '混合' }, { id: 'few', name: '樣本少' },
            ])
            const judge = { z: { judged: 8, yielded: 0 }, m: { judged: 10, yielded: 3 }, few: { judged: 3, yielded: 0 } }
            await cullZeroYieldSources(s, (x) => judge[x.id], { minJudged: 6, log })
            assert.equal((await s.get('z')).enabled, false)
            assert.notEqual((await s.get('m')).enabled, false, '混合型來源有真產出，淘汰它是誤殺')
            assert.notEqual((await s.get('few')).enabled, false)
        })

        it('零產出淘汰同時把 judged/yielded 落在來源記錄上（有變才寫）', async () => {
            const s = memStore([{ id: 'x', name: 'X' }, { id: 'y', name: 'Y', judged: 4, yielded: 1 }])
            const judge = { x: { judged: 8, yielded: 2 }, y: { judged: 4, yielded: 1 } }
            const r = await cullZeroYieldSources(s, (v) => judge[v.id], { minJudged: 6, log })
            assert.deepEqual(r, { culled: 0, synced: 1 }, 'y 統計未變不寫')
            assert.deepEqual([(await s.get('x')).judged, (await s.get('x')).yielded], [8, 2])
        })

        it('cullZeroYieldSources：sources 缺方法拋錯；judgeOf 非函數拋錯；有效輸入淘汰行為不變', async () => {
            const s0 = memStore([{ id: 'a', name: 'A' }])
            await assert.rejects(() => cullZeroYieldSources({}, () => null), /cullZeroYieldSources 需要 sources 集合/)
            await assert.rejects(() => cullZeroYieldSources(s0, 'not-fn'), /cullZeroYieldSources 需要 judgeOf 函數/)

            const s = memStore([{ id: 'a', name: 'A' }])
            const r = await cullZeroYieldSources(s, () => ({ judged: 8, yielded: 0 }), { minJudged: 6, log })
            assert.equal(r.culled, 1, '有效輸入淘汰行為不變')
        })

        it('CS5 停用記時刻與原因(連敗、連空、零產出);冷卻期滿重探:開新觀察窗(統計歸零)、次數＋1、冷卻倍增;每輪上限、停用最久者先;時刻未記者先補記不重探;未設即不重探', async () => {
            const DAY = 86400_000
            const at = (d) => new Date(Date.parse(NOW) - d * DAY).toISOString()
            // 停用記時刻
            const s0 = memStore([{ id: 'f', name: 'F', failCount: 7 }, { id: 'z', name: 'Z' }])
            await recordSourceOutcome(s0, await s0.get('f'), { ok: false, error: 'x' }, { nowIso: NOW, maxConsecFails: 8 })
            assert.deepEqual([(await s0.get('f')).enabled, (await s0.get('f')).disabledAt, (await s0.get('f')).disableReason], [false, NOW, '連續失敗 8 次'])
            await cullZeroYieldSources(s0, () => ({ judged: 8, yielded: 0 }), { minJudged: 6, nowIso: NOW, log })
            assert.deepEqual([(await s0.get('z')).enabled, (await s0.get('z')).disabledAt], [false, NOW])
            // 重探
            const s = memStore([
                { id: 'old', name: 'O', enabled: false, disabledAt: at(40), disableReason: '已判定 8 篇產出 0，自動停用', judged: 8, yielded: 0, failCount: 3, freshHist: [0.1] },
                { id: 'older', name: 'OO', enabled: false, disabledAt: at(50) },
                { id: 'again', name: 'A', enabled: false, disabledAt: at(40), reprobes: 1 }, // 冷卻 60 天未滿
                { id: 'fresh', name: 'N', enabled: false, disabledAt: at(10) },
                { id: 'nots', name: 'T', enabled: false },
                { id: 'live', name: 'L' },
            ])
            const r = await reprobeSources(s, { nowIso: NOW, reprobeDays: 30, reprobePerRun: 1, log })
            assert.deepEqual([r.reprobed, r.due, r.stamped], [['older'], 2, 1], '停用最久者先、每輪上限 1')
            const o = await s.get('older')
            assert.deepEqual([o.enabled, o.reprobes, o.windowFrom, o.judged, o.yielded, o.failCount, o.reprobedAt], [true, 1, NOW, 0, 0, 0, NOW])
            assert.equal((await s.get('nots')).disabledAt, NOW, '時刻未記者以首次觀察為起點')
            assert.equal((await s.get('nots')).enabled, false)
            const r2 = await reprobeSources(s, { nowIso: NOW, reprobeDays: 30, reprobePerRun: 5, log })
            assert.deepEqual(r2.reprobed, ['old'])
            assert.deepEqual((await s.get('old')).freshHist, [], '新件率亦自新窗起算')
            assert.equal((await s.get('again')).enabled, false, '已重探 1 次者冷卻 60 天')
            assert.equal(reprobeDue(at(61), 1, Date.parse(NOW), 30), true)
            assert.equal(reprobeDue(at(239), 9, Date.parse(NOW), 30), false, '倍增上限 8 倍(240 天)')
            assert.equal(reprobeDue(at(240), 9, Date.parse(NOW), 30), true)
            assert.deepEqual((await reprobeSources(memStore([{ id: 'x', enabled: false, disabledAt: at(400) }]), { nowIso: NOW, reprobeDays: 0, reprobePerRun: 3 })).reprobed, [], 'reprobeDays 0 即不重探')
            assert.ok(CAPTURE_DEFAULT.sources.reprobeDays > 0 && CAPTURE_DEFAULT.sources.reprobePerRun > 0, '預設開啟(capture.sources.reprobeDays／reprobePerRun)')
        })

        it('輪抓挑選：tier 優先、最舊優先、未逾最短間隔不入選', async () => {
            const s = memStore([
                { id: 'a', tier: 2, lastFetchAt: '2026-08-18T10:00:00+08:00' },
                { id: 'b', tier: 1, lastFetchAt: '2026-08-18T09:00:00+08:00' },
                { id: 'c', tier: 1, lastFetchAt: new Date().toISOString() }, // 剛抓過
                { id: 'd', tier: 1, lastFetchAt: '' },
            ])
            const due = await pickDueSources(s, { limit: 10, minIntervalMs: 3600_000 })
            assert.deepEqual(due.map((x) => x.id), ['d', 'b', 'a'], 'c 未逾間隔須排除；d 從未抓過最優先')
        })

        it('輪抓挑選之產出率回饋：樣本足量且產出率低者排同層級之末；樣本不足與統計缺席者不動；門檻 0 即關閉', async () => {
            const s = memStore([
                { id: 'a', tier: 1, lastFetchAt: '2026-08-18T08:00:00+08:00', judged: 10, yielded: 0 }, // 最舊但產出 0/10
                { id: 'b', tier: 1, lastFetchAt: '2026-08-18T09:00:00+08:00', judged: 10, yielded: 5 },
                { id: 'c', tier: 1, lastFetchAt: '2026-08-18T10:00:00+08:00', judged: 3, yielded: 0 }, // 樣本不足
                { id: 'd', tier: 2, lastFetchAt: '2026-08-18T07:00:00+08:00' }, // 無統計
            ])
            const base = { limit: 10, minIntervalMs: 3600_000, minJudged: 6 }
            assert.deepEqual((await pickDueSources(s, { ...base, lowYieldRate: 0.1 })).map((x) => x.id), ['b', 'c', 'a', 'd'], '低產出者降到 tier 1 之末,仍在 tier 2 之前')
            assert.deepEqual((await pickDueSources(s, { ...base, lowYieldRate: 0 })).map((x) => x.id), ['a', 'b', 'c', 'd'], '門檻 0 即不依產出率重排')
            assert.equal(isLowYield({ judged: 10, yielded: 1 }, { lowYieldRate: 0.1, minJudged: 6 }), false, '恰為門檻不算低')
            assert.equal(isLowYield({ judged: 10, yielded: 0 }, { lowYieldRate: 0.1, minJudged: 6 }), true)
        })

        it('isLowYield：opt 非物件回退為 {}（不拋錯，等同未給門檻）；有效輸入判定不變', () => {
            assert.doesNotThrow(() => isLowYield({ judged: 10, yielded: 0 }, null))
            assert.equal(isLowYield({ judged: 10, yielded: 0 }, null), false, 'opt 非物件回退為 {}，無門檻即不判定為低產出')
            assert.equal(isLowYield({ judged: 10, yielded: 0 }, { lowYieldRate: 0.3, minJudged: 6 }), true, '有效輸入判定不變')
        })

        it('pickDueSources：sources 缺 select 拋錯；第二參數非物件回退為 {}（limit 未給＝全取語意）', async () => {
            await assert.rejects(() => pickDueSources({}), /pickDueSources 需要 sources 集合/)
            const s = memStore([{ id: 'a', tier: 1, lastFetchAt: '' }, { id: 'b', tier: 2, lastFetchAt: '' }])
            const due = await pickDueSources(s, null)
            assert.equal(due.length, 2, 'opt 非物件回退為 {}，limit 未給維持全取語意')
            const due2 = await pickDueSources(s, { limit: 1 })
            assert.equal(due2.length, 1, '有效輸入 limit 行為不變')
        })

        it('pickDueSources：limit 非非負整數即不限(與 pickClues 同一規則)；minIntervalMs 未給視為 0(已抓過者亦到期)', async () => {
            const past = new Date(Date.now() - 60_000).toISOString()
            const s = memStore([
                { id: 'a', tier: 1, lastFetchAt: '' },
                { id: 'b', tier: 1, lastFetchAt: past },
                { id: 'c', tier: 2, lastFetchAt: past },
            ])
            assert.equal((await pickDueSources(s, { limit: -1 })).length, 3, '負數 limit 不是 slice(0,-1) 之「去掉最後一筆」')
            assert.equal((await pickDueSources(s, { limit: 1.5 })).length, 3, '非整數 limit 視同未給')
            assert.equal((await pickDueSources(s, { limit: 0 })).length, 0, 'limit 0 仍為取 0 筆')
            assert.deepEqual((await pickDueSources(s, {})).map((x) => x.id), ['a', 'b', 'c'], '未給 minIntervalMs：已抓過者亦到期')
            assert.deepEqual((await pickDueSources(s, { minIntervalMs: 3600_000 })).map((x) => x.id), ['a'], '有效間隔行為不變：1 分鐘前抓過者未到期')
        })
    })

    // ══════════════════════════ docPolicy ══════════════════════════
    describe('docPolicy', function() {

        it('終態瘦身：清素材保記錄；非終態不可清（沒有時間型過期）', async () => {
            const docs = memStore([
                { id: '1', status: 'noted', text: 'AAAA', feedText: 'BB' },
                { id: '2', status: 'raw', text: 'KEEP' },
                { id: '3', status: 'new', fetchTries: 1, collectedAt: '2026-01-01T00:00:00+08:00' }, // 舊且抓過：不是終態，不碰
            ])
            const r = await slimTerminalDocs(docs, { terminalStatuses: ['noted'] })
            assert.equal(r.slimmed, 1)
            assert.equal((await docs.get('1')).text, '')
            assert.equal((await docs.get('1')).textLength, 6, '瘦身須記下原長度')
            assert.equal((await docs.get('2')).text, 'KEEP', '非終態不可清')
            assert.equal((await docs.get('3')).status, 'new', '新舊與抓過幾次都不是丟棄理由；記錄永不刪除')
        })

        it('slimTerminalDocs：docs 缺方法拋錯；cfg.terminalStatuses 非陣列拋錯；cfg.textFields 非陣列回退預設', async () => {
            const docs = memStore([{ id: '1', status: 'noted', text: 'AAAA', feedText: 'BB' }])
            await assert.rejects(() => slimTerminalDocs({}, { terminalStatuses: ['noted'] }), /slimTerminalDocs 需要 docs 集合/)
            await assert.rejects(() => slimTerminalDocs(docs, {}), /slimTerminalDocs 需要 cfg\.terminalStatuses（狀態陣列）/)
            await assert.rejects(() => slimTerminalDocs(docs), /slimTerminalDocs 需要 cfg\.terminalStatuses（狀態陣列）/, 'cfg 全未給時亦回退為 {} 後同樣視為缺 terminalStatuses')

            const r = await slimTerminalDocs(docs, { terminalStatuses: ['noted'], textFields: 'not-array' })
            assert.equal(r.slimmed, 1, 'textFields 非陣列回退為預設 [text,feedText]，瘦身仍生效')
            assert.equal((await docs.get('1')).text, '')
        })

        it('選取順序 byRetryTierFifo：tries 升冪 → tier 升冪 → collectedAt 升冪（補全文與下游處理共用一份比較器）', () => {
            const rows = [
                { id: 't1-tried', sourceTier: 1, fetchTries: 2, collectedAt: '2026-06-01' },
                { id: 't3-new', sourceTier: 3, fetchTries: 0, collectedAt: '2026-08-01' },
                { id: 't1-new-late', sourceTier: 1, fetchTries: 0, collectedAt: '2026-08-02' },
                { id: 't1-new-early', sourceTier: 1, fetchTries: 0, collectedAt: '2026-07-01' },
            ]
            assert.deepEqual(rows.slice().sort(byRetryTierFifo('fetchTries')).map((r) => r.id), ['t1-new-early', 't1-new-late', 't3-new', 't1-tried'])
            assert.deepEqual(rows.slice().sort(byRetryTierFifo('summarizeTries')).map((r) => r.id), ['t1-tried', 't1-new-early', 't1-new-late', 't3-new'], '換欄位名即下游處理側語意(此處 summarizeTries 皆 0 → 只剩 tier→collectedAt)')
        })

        it('byRetryTierFifo：triesField 非有效字串回退為 fetchTries；有效輸入排序不變', () => {
            const rows = [{ id: 'a', fetchTries: 2 }, { id: 'b', fetchTries: 0 }]
            assert.deepEqual(rows.slice().sort(byRetryTierFifo(123)).map((r) => r.id), ['b', 'a'], 'triesField 非字串回退為 fetchTries')
            assert.deepEqual(rows.slice().sort(byRetryTierFifo('')).map((r) => r.id), ['b', 'a'], '空字串非有效字串同樣回退')
            assert.deepEqual(rows.slice().sort(byRetryTierFifo('fetchTries')).map((r) => r.id), ['b', 'a'], '有效輸入行為不變')
        })

        it('狀態機全集 DOC_STATUSES＝待處理兩態＋終態(外部巡檢之「未定義狀態」以之判,不自列)', () => {
            assert.deepEqual(DOC_PENDING_STATUSES, ['new', 'raw'])
            assert.deepEqual(DOC_STATUSES, ['new', 'raw', ...DOC_TERMINAL_STATUSES])
            assert.ok(Object.isFrozen(DOC_STATUSES))
        })

        it('待抓佇列之分法 docQueuesOf(補全文段、剔除清單、巡檢同一份):補全文(未試／重試／退避中)與瀏覽器佇列互斥;瀏覽器停用時指名瀏覽器者併回補全文;非 new 不計', () => {
            const NOW_MS = Date.parse('2026-10-06T00:00:00Z')
            const docs = [
                { id: 'u', status: 'new', collectedAt: '2026-10-01T00:00:00Z' },
                { id: 'r', status: 'new', fetchTries: 1, collectedAt: '2026-10-02T00:00:00Z', retryAt: '2026-10-05T00:00:00Z' }, // 退避已到期 → 重試
                { id: 'k', status: 'new', fetchTries: 1, collectedAt: '2026-09-30T00:00:00Z', retryAt: '2026-10-07T00:00:00Z' }, // 退避中
                { id: 'b', status: 'new', fetcher: 'browser', fetchTries: 0, collectedAt: '2026-09-01T00:00:00Z', deferredAt: '2026-10-04T00:00:00Z' },
                { id: 'x', status: 'raw' },
            ]
            const ids = (q) => Object.fromEntries(Object.entries(q).map(([k, v]) => [k, v.map((d) => d.id)]))
            assert.deepEqual(ids(docQueuesOf(docs, { nowMs: NOW_MS })), { news: ['u', 'r', 'k', 'b'], main: ['u', 'r', 'k'], ready: ['u', 'r'], backoff: ['k'], untried: ['u'], retry: ['r'], browser: ['b'] })
            assert.deepEqual(ids(docQueuesOf(docs, { nowMs: NOW_MS, browserOn: false })), { news: ['u', 'r', 'k', 'b'], main: ['u', 'r', 'k', 'b'], ready: ['u', 'r', 'b'], backoff: ['k'], untried: ['u', 'b'], retry: ['r'], browser: [] }, '瀏覽器停用:併回補全文佇列')
            const s = docQueueStatsOf(docs, { nowMs: NOW_MS })
            assert.deepEqual(s, { total: 4, news: { count: 4, oldestDays: 35 }, main: { count: 3, oldestDays: 6 }, backoff: { count: 1, oldestDays: 6 }, untried: { count: 1, oldestDays: 5 }, retry: { count: 1, oldestDays: 4 }, browser: { count: 1, oldestDays: 2 } }, '瀏覽器佇列以進佇列時刻計等待')
            assert.deepEqual(docQueuesOf(null, 'bad').news, [], '非陣列與 opt 非物件之穩健處理')
        })
    })

    // ══════════════════════════ docTexts ══════════════════════════
    describe('docTexts(原文另存)', function() {

        it('終態瘦身＋原文另存(回溯材料):noted／skip／summarize-failed 先存 docTexts、回讀一致才清;dead 不存;同文不重寫;docTextOf 兩路皆取得', async () => {
            const docs = memStore([
                { id: 'n', status: 'noted', text: '正文甲', feedText: '摘要甲', textFrom: 'article', title: 'T', url: 'https://x/a' },
                { id: 's', status: 'skip', text: '正文乙' },
                { id: 'f', status: 'summarize-failed', text: '正文丙' },
                { id: 'd', status: 'dead', text: '殘文' },
            ])
            const docTexts = memStore()
            const r = await slimTerminalDocs(docs, { terminalStatuses: ['noted', 'skip', 'summarize-failed', 'dead'], archive: docTexts, nowIso: NOW })
            assert.equal(r.slimmed, 4)
            assert.equal(r.archived, 3, 'dead 不另存')
            assert.equal(r.archiveFailed, 0)
            const a = await docTexts.get('n')
            assert.equal(unpackText(a.gz), '正文甲')
            assert.equal(unpackText(a.feedGz), '摘要甲')
            assert.equal(a.archivedAt, NOW)
            assert.equal(await docTexts.get('d'), null)
            assert.equal((await docs.get('n')).text, '', 'docs 照樣清空(select 不載入原文)')
            const via = await docTextOf({ docs, docTexts }, 'n')
            assert.deepEqual([via.text, via.feedText, via.from], ['正文甲', '摘要甲', 'archive'])
            assert.equal((await docTextOf({ docs }, 'missing')), null)
            // 重抓後同一 id 再瘦身:內容不同才重寫;相同不重寫
            await docs.patch('n', { text: '正文甲', feedText: '摘要甲' })
            const r2 = await slimTerminalDocs(docs, { terminalStatuses: ['noted'], archive: docTexts, nowIso: NOW })
            assert.equal(r2.slimmed, 1)
            assert.equal(r2.archived, 0, '同文不重寫')
            const raw = memStore([{ id: 'r', status: 'raw', text: '待處理' }])
            assert.deepEqual(await docTextOf({ docs: raw, docTexts }, 'r'), { text: '待處理', feedText: '', textFrom: '', title: '', url: '', from: 'docs', currentPage: false })
        })

        it('取得方式之語意由本套件判:原文回溯之網頁重取(refetch:article)為「今日之頁面」(currentPage),API 依編號重取(refetch:arxiv／openalex)與原取得者不是;回填欄位(docTextRestoreOf)只在原文出自另存時給 text／feedText', async () => {
            const docs = memStore([{ id: 'p', status: 'noted', text: '' }, { id: 'q', status: 'noted', text: '' }, { id: 'o', status: 'noted', text: '' }, { id: 'live', status: 'raw', text: '在庫正文', textFrom: 'article' }])
            const docTexts = memStore()
            for (const [id, textFrom] of [['p', 'refetch:article'], ['q', 'refetch:arxiv'], ['o', 'article']]) assert.equal((await archiveDocText(docTexts, { id, text: `${id} 之原文`, textFrom, status: 'noted' }, NOW)).ok, true)
            const st = { docs, docTexts }
            assert.deepEqual(await Promise.all(['p', 'q', 'o', 'live'].map(async (id) => (await docTextOf(st, id)).currentPage)), [true, false, false, false])
            assert.deepEqual(docTextRestoreOf(await docTextOf(st, 'o')), { text: 'o 之原文', feedText: '' })
            assert.deepEqual(docTextRestoreOf(await docTextOf(st, 'live')), {}, 'docs 仍有原文 → 不回填')
            assert.deepEqual([docTextRestoreOf(null), docTextRestoreOf(undefined)], [{}, {}])
        })

        it('終態瘦身:原文另存回讀不符 → 該篇本輪不清(不丟材料)', async () => {
            const docs = memStore([{ id: 'n', status: 'noted', text: '正文' }])
            const broken = memStore()
            broken.replace = async () => {} // 寫入無效:回讀為 null
            const r = await slimTerminalDocs(docs, { terminalStatuses: ['noted'], archive: broken })
            assert.equal(r.archiveFailed, 1)
            assert.equal(r.slimmed, 0)
            assert.equal((await docs.get('n')).text, '正文', '另存失敗不清原文')
        })
    })

    // ══════════════════════════ frontierPolicy ══════════════════════════
    describe('frontierPolicy(待探索線索)', function() {

        it('線索：去重累加 hits、hits 優先消化、達上限轉 failed', async () => {
            const f = memStore()
            await saveClues(f, [{ type: 'keyword', value: 'Transformer', why: 'a' }], { nowIso: NOW })
            await saveClues(f, [{ type: 'keyword', value: 'transformer', why: 'b' }], { nowIso: NOW }) // 大小寫視同重複
            await saveClues(f, [{ type: 'site', value: 'not-a-url' }, { type: 'weird', value: 'x' }], { nowIso: NOW })
            const rows = f._dump()
            assert.equal(rows.length, 1, 'site 非網址與未知 type 不可入庫')
            assert.equal(rows[0].hits, 2, '重複是訊號：hits 累加')

            await saveClues(f, [{ type: 'topic', value: 'cold' }], { nowIso: NOW })
            const picked = await pickClues(f, 10)
            assert.equal(picked[0].value, 'Transformer', 'hits 高者優先——純 FIFO 會讓核心題目排在冷門線索後')

            let st1 = await settleClue(f, picked[0], { ok: false, error: 'x' }, { nowIso: NOW, maxTries: 2 })
            assert.equal(st1.status, 'pending')
            st1 = await settleClue(f, await f.get(picked[0].id), { ok: false, error: 'x' }, { nowIso: NOW, maxTries: 2 })
            assert.equal(st1.status, 'failed')
        })

        it('線索鍵折疊：全形／空白／括號／大小寫視同一筆；記錄 id 即折疊後之 clueKey', async () => {
            const f = memStore()
            await saveClues(f, [{ type: 'keyword', value: 'Transformer 架構' }], { nowIso: NOW })
            await saveClues(f, [{ type: 'keyword', value: 'transformer架構' }], { nowIso: NOW })
            await saveClues(f, [{ type: 'keyword', value: 'Ｔransformer（架構）' }], { nowIso: NOW }) // 全形 Ｔ＋括號
            assert.equal(f._dump().length, 1, '三種寫法須折疊為一筆——鍵只做 lowercase 則 hits 無法累加')
            assert.equal(f._dump()[0].hits, 3)
            assert.equal(f._dump()[0].value, 'Transformer 架構', '保留首見原值供人讀')
            assert.equal(f._dump()[0].id, clueKey('keyword', 'transformer架構'), '記錄 id 即折疊後之 clueKey')
            // site 型以 normalizeUrl 折疊(去追蹤參數／尾斜線)
            await saveClues(f, [{ type: 'site', value: 'https://Example.com/blog/?utm_source=x' }], { nowIso: NOW })
            await saveClues(f, [{ type: 'site', value: 'https://example.com/blog' }], { nowIso: NOW })
            assert.equal(f._dump().filter((x) => x.type === 'site').length, 1)
        })

        it('線索上限淘汰：超過 maxPending 即淘汰優先序最低者（hits 低、來自 skip 文件、最舊）；再被提及即復活；pickClues 同一優先序；0 即不設限', async () => {
            const f = memStore()
            await saveClues(f, [{ type: 'keyword', value: 'hot' }], { nowIso: '2026-08-18T10:00:00+08:00' })
            await saveClues(f, [{ type: 'keyword', value: 'hot' }], { nowIso: '2026-08-18T10:01:00+08:00' }) // hits 2
            await saveClues(f, [{ type: 'keyword', value: 'from-skip' }], { nowIso: '2026-08-18T09:00:00+08:00', fromRef: 'skip:d1' })
            await saveClues(f, [{ type: 'keyword', value: 'old-cold' }], { nowIso: '2026-08-18T08:00:00+08:00' })
            await saveClues(f, [{ type: 'keyword', value: 'new-cold' }], { nowIso: '2026-08-18T11:00:00+08:00' })
            assert.deepEqual((await pickClues(f, 10)).map((c) => c.value), ['hot', 'old-cold', 'new-cold', 'from-skip'], 'hits 降冪 → 來自知識文件者先 → 先來後到')
            assert.deepEqual(await enforceFrontierCap(f, { maxPending: 2, nowIso: NOW }), { pending: 2, evicted: 2 })
            assert.deepEqual((await f.select({ status: 'evicted' })).map((c) => c.value).sort(), ['from-skip', 'new-cold'], '淘汰的是至今只被提過一次的冷門線索')
            assert.deepEqual((await pickClues(f, 10)).map((c) => c.value), ['hot', 'old-cold'])
            const s = await saveClues(f, [{ type: 'keyword', value: 'From-Skip' }], { nowIso: NOW })
            assert.deepEqual([s.addCount, s.merged, s.revived], [0, 1, 1], '淘汰者再被提及即累加 hits 並復活——記錄保留是去重憑證,淘汰的不是資訊本身')
            assert.equal((await f.select({ status: 'pending' })).length, 3)
            assert.deepEqual(await enforceFrontierCap(f, { maxPending: 0, nowIso: NOW }), { pending: 3, evicted: 0 }, '0 即不設限')
        })

        it('saveClues：frontier 缺方法拋錯；cfg 非物件回退為 {}（仍以預設 types 過濾）', async () => {
            await assert.rejects(() => saveClues({}, [{ type: 'keyword', value: 'x' }]), /saveClues 需要 frontier 集合/)
            const f = memStore()
            const r = await saveClues(f, [{ type: 'keyword', value: 'x' }], null)
            assert.equal(r.addCount, 1, 'cfg 非物件回退為 {}，預設 types 白名單與 maxValueLen 仍生效')
        })

        it('clueDropOf 與 saveClues 同一格式判定(CS9／CS11;符合度掃描逐筆呼叫之,不走寫入之整條路徑):逐因與 saveClues 之 dropped 一一對應', async () => {
            const cfg = { groundText: '材料提到 https://real.example/a 與 news.example' }
            const rules = clueRulesOf(cfg)
            const cases = [
                [{ type: 'weird', value: 'x' }, 'type'],
                [{ type: ' Keyword ', value: '  ' }, 'empty'],
                [{ type: 'topic', value: 'x'.repeat(121) }, 'long'],
                [{ type: 'site', value: 'not-a-url' }, 'site'],
                [{ type: 'site', value: 'https://made-up.example/' }, 'ungrounded'],
                [{ type: 'site', value: 'https://www.news.example/p' }, null],
                [{ type: 'keyword', value: ' 動量 ' }, null],
            ]
            for (const [clue, want] of cases) {
                assert.equal(clueDropOf(clue, rules).drop, want, JSON.stringify(clue))
                const r = await saveClues(memStore(), [clue], { ...cfg, nowIso: NOW })
                assert.deepEqual(Object.entries(r.dropped).filter(([, n]) => n > 0).map(([k]) => k), want ? [want] : [], `saveClues 之判定同 clueDropOf:${JSON.stringify(clue)}`)
            }
            assert.deepEqual(clueDropOf({ type: ' Keyword ', value: ' 動量 ' }, rules), { drop: null, type: 'keyword', raw: '動量' }, '回傳正規化後之型別與去頭尾空白之值')
            assert.deepEqual([clueRulesOf(null).maxLen, clueRulesOf(null).types, clueRulesOf({}).siteGrounded('https://x.example')], [120, ['keyword', 'topic', 'site'], true], '未給材料 → 不檢 CS11;預設型別與長度')
            assert.equal(clueRulesOf({ types: ['keyword'], maxValueLen: 3 }).maxLen, 3)
        })

        it('pickClues：frontier 缺 select 拋錯；limit 非非負整數即不限', async () => {
            await assert.rejects(() => pickClues({}), /pickClues 需要 frontier 集合/)
            const f = memStore([
                { id: 'a', type: 'keyword', value: 'a', status: 'pending', hits: 1, addedAt: 'x' },
                { id: 'b', type: 'keyword', value: 'b', status: 'pending', hits: 2, addedAt: 'y' },
            ])
            const unlimited = await pickClues(f, 'not-a-number')
            assert.equal(unlimited.length, 2, 'limit 非非負整數即不限，回傳全部待消化線索')
            const limited = await pickClues(f, 1)
            assert.equal(limited.length, 1, '有效 limit 行為不變')
        })

        it('enforceFrontierCap：frontier 缺方法拋錯；有效輸入淘汰行為不變', async () => {
            await assert.rejects(() => enforceFrontierCap({}, { maxPending: 1 }), /enforceFrontierCap 需要 frontier 集合/)
            const f = memStore([
                { id: 'a', type: 'keyword', value: 'a', status: 'pending', hits: 5, addedAt: 'x' },
                { id: 'b', type: 'keyword', value: 'b', status: 'pending', hits: 1, addedAt: 'y' },
            ])
            const r = await enforceFrontierCap(f, { maxPending: 1, nowIso: NOW })
            assert.deepEqual(r, { pending: 1, evicted: 1 })
        })

        it('settleClue：frontier 缺 patch 拋錯；outcome 非物件拋錯；cfg 非物件回退為 {}', async () => {
            const f0 = memStore([{ id: 'c1', tries: 0 }])
            const c1 = await f0.get('c1')
            await assert.rejects(() => settleClue({}, c1, { ok: true }), /settleClue 需要 frontier 集合/)
            await assert.rejects(() => settleClue(f0, c1, null), /settleClue 需要 outcome 物件/)

            const f = memStore([{ id: 'c1', tries: 0, status: 'pending' }])
            const st = await settleClue(f, await f.get('c1'), { ok: false, error: 'x' }, null)
            assert.equal(st.status, 'pending', 'cfg 非物件回退為 {}，maxTries 預設 2，未達上限仍 pending')
        })
    })

    // ══════════════════════════ ingestGate ══════════════════════════
    describe('ingestGate(入庫單一閘門:契約檢查 → 業務過濾 → 去重占位入庫)', function() {

        it('入庫閘門 ingestFeedItems：契約檢查（無 url 留痕、批內去重、正規化 id）→ 業務過濾 → seen.admit 去重占位；探測入庫與輪抓同一份', async () => {
            const docs = memStore()
            const seen = W.createSeenStore({ collection: docs, identity: W.createIdentity({ keyOf: 'raw' }), log })
            const ctx = { deps: { settings: S({ sources: { itemsPerSource: 8 }, articles: { maxTextChars: 50 } }), seen, clock: { iso8: () => NOW } }, log }
            const source = { id: 's1', name: 'S', kind: 'rss', tier: 3 }
            const raw = [
                { url: 'https://a.com/x?utm_source=z', title: 'A', description: 'd'.repeat(80) },
                { url: 'https://a.com/x', title: 'A 重複（追蹤參數不同）' },
                { title: '沒有 url' },
                { url: 'https://a.com/y', title: 'B' },
            ]
            const r = await ingestFeedItems(raw, { source, fetcherId: 'probe:rss', ctx, filter: (items) => items.filter((i) => i.title !== 'B') })
            assert.equal(r.invalid.length, 1, '無 url 者進 invalid 留痕')
            assert.equal(r.dupInBatch, 1, '批內以同一份 identity 去重')
            assert.equal(r.dropped, 1, '業務過濾對探測文件同樣生效')
            assert.equal(r.fresh.length, 1)
            assert.equal(r.fresh[0].id, seen.idOf('https://a.com/x'), 'id 由去重層以 canonicalUrl 算出')
            assert.deepEqual([r.fresh[0].sourceId, r.fresh[0].sourceTier, r.fresh[0].status, r.fresh[0].fetchTries], ['s1', 3, 'new', 0], '正準 doc 形狀(util/records)')
            assert.equal(r.fresh[0].feedText.length, 50, 'feedText 依 capture.articles.maxTextChars 截斷')
            const again = await ingestFeedItems(raw, { source, fetcherId: 'probe:rss', ctx })
            assert.equal(again.fresh.length, 1, '第二次:x 已在庫,只有 B(本次未過濾)入庫')
            assert.equal(again.dup, 1)
        })

        it('檢定標準 CS10 入庫:網址正準代稱(arXiv、MSN ar-ID、DOI)與既有文件相同 → 留記錄、狀態 skip(skipKind duplicate、不進 AI);同批後到者之錨尚未取得內容不判;段落雜湊與共享門檻(≥3 段且 ≥ 半數)', async () => {
            const docs = memStore([{ id: 'old1', url: 'https://arxiv.org/abs/2401.01234', status: 'noted' }, { id: 'old2', url: 'https://www.msn.com/en-us/money/markets/some-story/ar-AA1abcDEF', status: 'noted' }])
            const seen = W.createSeenStore({ collection: docs, identity: W.createIdentity({ keyOf: 'raw' }), log })
            const ctx = { deps: { settings: S({ sources: { itemsPerSource: 8 }, articles: { maxTextChars: 50 } }), seen, clock: { iso8: () => NOW }, stores: { docs } }, log }
            const source = { id: 's1', name: 'S', kind: 'rss', tier: 3 }
            const r = await ingestFeedItems([
                { url: 'https://arxiv.org/pdf/2401.01234', title: '同篇 PDF 版' },
                { url: 'https://www.msn.com/zh-tw/money/other-path/ar-AA1abcDEF', title: '同一 MSN 文' },
                { url: 'https://doi.org/10.1111/jofi.13000', title: '新 DOI' },
                { url: 'https://journal.example/doi/10.1111/jofi.13000', title: '同一 DOI 之期刊頁' },
                { url: 'https://new.example/a', title: '全新' },
            ], { source, fetcherId: 'rss', ctx })
            assert.equal(r.fresh.length, 5)
            // 錨須已取得內容(contentIndex.isContentAnchor):既有 noted 為錨;同批先到者尚為 new(未取得內容)不當錨——
            //   後到者照常待抓,落盤時再以自身網址之代稱比對(屆時先到者若已取得內容即判重複;先到者若抓不到,後到者之內容不致遺失)
            assert.equal(r.sameContent, 2, 'arXiv、MSN(錨為 noted);同批之 DOI 後到者不判(錨尚未取得內容)')
            const st = Object.fromEntries((await docs.select()).map((d) => [d.url, d]))
            assert.deepEqual([st['https://arxiv.org/pdf/2401.01234'].status, st['https://arxiv.org/pdf/2401.01234'].skipKind, st['https://arxiv.org/pdf/2401.01234'].dupOf], ['skip', 'duplicate', 'old1'])
            assert.match(st['https://arxiv.org/pdf/2401.01234'].skipReason, /^與既有文件同一內容（arxiv:2401\.01234，文件 old1）（未進 AI）/)
            assert.equal(st['https://doi.org/10.1111/jofi.13000'].status, 'new', '同批先到者照常')
            assert.equal(st['https://journal.example/doi/10.1111/jofi.13000'].status, 'new', '同批後到者:錨為 new,不判重複')
            assert.equal(st['https://new.example/a'].status, 'new')
            // 錨已死(dead)者不當錨:同一代稱之新件照常入庫待抓
            const docs2 = memStore([{ id: 'dd', url: 'https://arxiv.org/pdf/2402.00001', status: 'dead' }])
            const seen2 = W.createSeenStore({ collection: docs2, identity: W.createIdentity({ keyOf: 'raw' }), log })
            const r2 = await ingestFeedItems([{ url: 'https://arxiv.org/abs/2402.00001', title: 'abs 版' }], { source, fetcherId: 'rss', ctx: { deps: { ...ctx.deps, seen: seen2, stores: { docs: docs2 } }, log } })
            assert.deepEqual([r2.fresh.length, r2.sameContent], [1, 0], 'PDF 一輪 dead 後,同篇 abs 不被判重複(dead 不當錨)')
            // 段落雜湊與門檻
            const P = (s) => `${s}之內容說明，`.repeat(10) // 每段 70 字(≥ 60 才計)
            const a = paraKeysOf([P('甲'), P('乙'), P('丙'), P('丁')].join('\n'))
            assert.equal(a.length, 4)
            assert.equal(paraKeysOf('短段\n\n也短').length, 0)
            assert.equal(sharedParas(a, a.slice(0, 3)), 3, '共享 3 段且 ≥ 半數 → 同一內容')
            assert.equal(sharedParas(a, a.slice(0, 2)), 0, '只共享 2 段 → 不算')
            const many = paraKeysOf(Array.from({ length: 10 }, (_, i) => P(`段${i}`)).join('\n'))
            assert.equal(sharedParas(many, many.slice(0, 4)), 0, '共享 4 段而未及半數(10 段)→ 不算')
        })

        it('檢定標準 CS10 全部入口:入庫即有素材之記錄(grid 摘要直入 raw)與正文落盤同一判定——算段落雜湊並寫入 paraKeys;段落與既有文件重疊(≥3 段且 ≥ 半數)→ skip(duplicate,理由同正文落盤);單段之 grid 摘要依共享門檻自然不比;rss 等 new 記錄無素材 → 只比網址代稱、不寫 paraKeys', async () => {
            const P = (s) => `${s}之研究段落內容說明，`.repeat(7) // 每段 ≥ 60 字
            const multi = [P('甲'), P('乙'), P('丙'), P('丁')].join('\n')
            const abstract = 'Gradient clipping stabilizes the training of deep recurrent networks across many architectures and datasets. '.repeat(3) // 單段(grid 摘要形態)
            const docs = memStore([
                { id: 'old-multi', url: 'https://orig.example/a', status: 'noted', paraKeys: paraKeysOf(multi) },
                { id: 'old-grid', url: 'https://doi.org/10.1/old', status: 'noted', paraKeys: paraKeysOf(abstract) },
            ])
            const seen = W.createSeenStore({ collection: docs, identity: W.createIdentity({ keyOf: 'raw' }), log })
            const ctx = { deps: { settings: S({ sources: { itemsPerSource: 8 }, articles: { maxTextChars: 20000 } }), seen, clock: { iso8: () => NOW }, stores: { docs } }, log }
            // grid 來源:內建 toRecord 把摘要直入 raw(core/util/records defaultToRecord)
            const grid = { id: 'g1', name: 'G', kind: 'grid', tier: 2 }
            const r = await ingestFeedItems([
                { url: 'https://doi.org/10.1/same-abstract', title: '同一摘要之另一篇', description: abstract },
                { url: 'https://doi.org/10.1/fresh', title: '新摘要', description: 'Learning rate warmup improves the convergence of transformer models over long training runs. '.repeat(3) },
                { url: 'https://doi.org/10.1/multi', title: '多段素材', description: multi },
            ], { source: grid, fetcherId: 'grid', ctx })
            assert.equal(r.fresh.length, 3)
            const st = Object.fromEntries((await docs.select()).map((d) => [d.url, d]))
            // 規格:與正文落盤同一判定 → 段落重疊 ≥3 段且 ≥ 半數者 skip(duplicate),理由同正文落盤之格式
            const dupe = st['https://doi.org/10.1/multi']
            assert.deepEqual([dupe.status, dupe.skipKind], ['skip', 'duplicate'])
            assert.match(dupe.skipReason, /^與既有文件同一內容（段落重疊 4／4，文件 old-multi）（未進 AI）/)
            assert.equal(r.sameContent, 1)
            // 規格:段落少之文字(單段 grid 摘要)依共享門檻(≥3 段)自然不比 → 照常 raw,並記其段落雜湊(已計算,非「未算」)
            const same = st['https://doi.org/10.1/same-abstract']
            assert.deepEqual([same.status, same.paraKeys], ['raw', paraKeysOf(abstract)])
            assert.equal(same.paraKeys.length, 1)
            assert.deepEqual(st['https://doi.org/10.1/fresh'].paraKeys.length, 1, '新摘要亦記 paraKeys')
            // 規格:new 記錄(無素材,如 rss)只比網址代稱,不寫 paraKeys(落盤時才算)
            const rss = await ingestFeedItems([{ url: 'https://news.example/x', title: 'rss 項目', description: multi }], { source: { id: 's1', name: 'S', kind: 'rss', tier: 3 }, fetcherId: 'rss', ctx })
            const x = await docs.get(rss.fresh[0].id)
            assert.deepEqual([x.status, x.paraKeys], ['new', undefined])
        })

        const buildCtx = () => {
            const docs = memStore()
            const seen = W.createSeenStore({ collection: docs, identity: W.createIdentity({ keyOf: 'raw' }), log })
            return { deps: { settings: S({ sources: { itemsPerSource: 8 }, articles: { maxTextChars: 50 } }), seen, clock: { iso8: () => NOW } }, log }
        }

        it('入庫之設定接線:每來源取用上限取自 settings.capture.sources.itemsPerSource(子階段 opt.itemsPerSource 優先)、feed 內文截斷上限取自 settings.capture.articles.maxTextChars', () => {
            const mk = (settings) => ({ deps: { settings, seen: null, clock: { iso8: () => NOW } }, log })
            const raw = Array.from({ length: 6 }, (_, i) => ({ url: `https://a.com/${i}`, title: `T${i}` }))
            const n = (settings, opt = {}) => normalizeFeedItems(raw, { source: { id: 's1' }, fetcherId: 'rss', ctx: mk(settings), ...opt }).items.length
            assert.equal(n(S({ sources: { itemsPerSource: 2 } })), 2)
            assert.equal(n(S({ sources: { itemsPerSource: 2 } }), { itemsPerSource: 4 }), 4, 'opt 優先')
            assert.equal(n(S()), 6, '預設 8 → 6 筆全取')
            // maxTextChars:defaultToRecord 之 feedText 截斷與 feedFullLength
            const toRecord = defaultToRecord({ settings: S({ articles: { maxTextChars: 10 } }), clock: { iso8: () => NOW } })
            const rec = toRecord({ canonicalUrl: 'https://a.com/x', title: 't', text: 'x'.repeat(30) }, { source: { id: 's', name: 'S' } })
            assert.deepEqual([rec.feedText.length, rec.feedFullLength], [10, 30])
        })

        it('normalizeFeedItems：o 非物件或缺 ctx.deps 拋錯；有效輸入正規化不變', () => {
            assert.throws(() => normalizeFeedItems([], undefined), /normalizeFeedItems 需要 \{ ctx \}/)
            assert.throws(() => normalizeFeedItems([], { ctx: {} }), /normalizeFeedItems 需要 \{ ctx \}/)
            const ctx = buildCtx()
            const r = normalizeFeedItems([{ url: 'https://a.com/x', title: 'A' }], { source: { id: 's1' }, fetcherId: 'rss', ctx })
            assert.equal(r.items.length, 1, '有效輸入正規化行為不變')
        })

        it('filterFeedItems：o 非物件或缺 ctx.deps 拋錯；有效輸入過濾不變', async () => {
            await assert.rejects(() => filterFeedItems([], null), /filterFeedItems 需要 \{ ctx \}/)
            const ctx = buildCtx()
            const r = await filterFeedItems([{ id: 1 }, { id: 2 }], { ctx, filter: (items) => items.filter((i) => i.id === 1) })
            assert.equal(r.kept.length, 1)
            assert.equal(r.dropped, 1, '有效輸入過濾行為不變')
        })

        it('admitFeedItems：o 非物件或缺 ctx.deps 拋錯；有效輸入入庫不變', async () => {
            await assert.rejects(() => admitFeedItems([], {}), /admitFeedItems 需要 \{ ctx \}/)
            const ctx = buildCtx()
            const n = normalizeFeedItems([{ url: 'https://a.com/x', title: 'A' }], { source: { id: 's1', name: 'S', tier: 2 }, fetcherId: 'rss', ctx })
            const r = await admitFeedItems(n.items, { source: { id: 's1', name: 'S', tier: 2 }, fetcher: { id: 'rss' }, ctx })
            assert.equal(r.fresh.length, 1, '有效輸入入庫行為不變')
        })

        it('ingestFeedItems：o 非物件或缺 ctx.deps 拋錯；有效輸入三步走完不變', async () => {
            await assert.rejects(() => ingestFeedItems([], null), /ingestFeedItems 需要 \{ ctx \}/)
            const ctx = buildCtx()
            const r = await ingestFeedItems([{ url: 'https://a.com/y', title: 'B' }], { source: { id: 's1', name: 'S', tier: 2 }, fetcherId: 'rss', ctx })
            assert.equal(r.fresh.length, 1, '有效輸入行為不變')
        })
    })

    // ══════════════════════════ collectHelpers ══════════════════════════
    describe('collectHelpers(來源產出統計)', function() {

        it('judgeFromDocs：docs 非陣列回傳 {}；cfg 非物件回退為 {}；有效輸入統計不變', () => {
            assert.deepEqual(judgeFromDocs(null), {})
            assert.deepEqual(judgeFromDocs(undefined, { yieldStatus: 'x' }), {})
            const docs = [{ sourceId: 's1', status: 'noted' }, { sourceId: 's1', status: 'skip' }, { sourceId: 's2', status: 'new' }]
            assert.deepEqual(judgeFromDocs(docs, null), { s1: { judged: 2, yielded: 1, dup: 0, routine: 0, material: 0 } }, 'cfg 非物件回退為 {}，不拋錯')
            assert.deepEqual(judgeFromDocs(docs), { s1: { judged: 2, yielded: 1, dup: 0, routine: 0, material: 0 } }, '有效輸入統計行為不變')
        })

        it('judgeFromDocs(CS5):重複類 skip(skipKind duplicate)不計入 judged、另計 dup;觀察窗(since)只計窗內判定,判定時刻不明者不計;無窗之來源照全量', () => {
            const docs = [
                { sourceId: 's1', status: 'noted', notedAt: '2026-10-01T00:00:00Z' },
                { sourceId: 's1', status: 'skip', notedAt: '2026-10-02T00:00:00Z', skipKind: 'duplicate' },
                { sourceId: 's1', status: 'skip', notedAt: '2026-10-03T00:00:00Z' },
                { sourceId: 's2', status: 'skip', notedAt: '2026-09-01T00:00:00Z' },
                { sourceId: 's2', status: 'skip', notedAt: '2026-10-05T00:00:00Z' },
                { sourceId: 's2', status: 'noted' },
                { sourceId: 's2:linked', status: 'noted', notedAt: '2026-10-06T00:00:00Z' },
            ]
            const r = judgeFromDocs(docs, { since: new Map([['s2', '2026-10-01T00:00:00Z']]) })
            assert.deepEqual(r.s1, { judged: 2, yielded: 1, dup: 1, routine: 0, material: 0 }, '無窗:全量;重複不計判定')
            assert.deepEqual(r.s2, { judged: 2, yielded: 1, dup: 0, routine: 0, material: 0 }, '窗前之判定與時刻不明者不計;彙整轉錄(:linked)併入原來源')
        })

        it('judgeFromDocs(CS5 分 skipReason):例行貼文之 skip(skipKind routine)與重複類同一處理——不計入 judged、另計 routine;素材壞了而未能重抓者(skipKind material)另計 material;AI 判非知識之 skip(無 skipKind)照計;未知 skipKind 照計(不當作非判定)', () => {
            const docs = [
                { sourceId: 's1', status: 'skip', skipKind: 'routine', notedAt: '2026-10-02T00:00:00Z' },
                { sourceId: 's1', status: 'skip', skipKind: 'routine' },
                { sourceId: 's1', status: 'skip', notedAt: '2026-10-03T00:00:00Z' },
                { sourceId: 's1', status: 'noted', notedAt: '2026-10-03T00:00:00Z' },
                { sourceId: 's1', status: 'skip', skipKind: 'constructor' },
                { sourceId: 's2', status: 'skip', skipKind: 'routine', notedAt: '2026-09-01T00:00:00Z' },
            ]
            const r = judgeFromDocs(docs, { since: new Map([['s2', '2026-10-01T00:00:00Z']]) })
            // 規格:例行貼文(標題樣式判定、未進 AI)不是對內容之判定 → judged 只含 AI 判定之 skip 與 noted(2+1 未知類別)
            assert.deepEqual(r.s1, { judged: 3, yielded: 1, dup: 0, routine: 2, material: 0 })
            // 規格:AI 判素材壞了而未能換法重抓者(skipKind material)不是對來源內容之判定 → 不計 judged、另計 material
            assert.deepEqual(judgeFromDocs([{ sourceId: 's9', status: 'skip', skipKind: 'material' }, { sourceId: 's9', status: 'skip', skipKind: 'not-knowledge' }]).s9, { judged: 1, yielded: 0, dup: 0, routine: 0, material: 1 })
            // 規格:觀察窗對例行貼文同樣生效(窗前者不計)
            assert.deepEqual(r.s2, undefined, '窗前之例行貼文不計(該來源無窗內判定)')
        })
    })
})
