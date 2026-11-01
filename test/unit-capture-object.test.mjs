// unit-capture-object.test.mjs — 抓取物件(captureObject):階段契約、子階段序列與隔離、固定格式摘要
//   應然取自 captureObject 檔頭之契約:
//   ①物件＝子階段序列(hygiene → seedSync → listFetch → detailFetch → docMaintain → expand → areas),工廠零參數即可用
//   ②子階段失敗預設隔離(記於 report、續跑後續子階段),宣告 onError:'abort' 才中止整個物件
//   ③物件 report 形狀 { ok, stats, detail:<子階段名 → report>, summary };全數成功才用固定格式摘要(對外契約:既有段落不動、
//     新增段落附於句尾且 >0 才附),有子階段失敗時一律改走通用摘要並列出失敗者(失敗時 detail 為 {}——truthy,固定格式會印出 undefined)
// 執行:自套件根 npx mocha test/unit-capture-object.test.mjs(不發網路、不開瀏覽器、不落檔)

import assert from 'node:assert/strict'
import { memStore } from './tools/memStore.mjs'
import { nullLogger } from './tools/nullLogger.mjs'
import { genClockTZ } from '../src/core/runnerPackage.mjs'
import { stdReport } from '../src/core/kernel.mjs'
import { resolveSettings } from '../src/core/settingsDefault.mjs'
import { resolveVocab } from '../src/core/vocab/vocabDefault.mjs'
import { createCaptureObject, CAPTURE_STAGE_KEYS, CAPTURE_TAP_STAGE_KEYS, stageFields, runSubStages, aggStats, genericSummary, failedNames, summaryOf, objectReport, captureSummaryOf } from '../src/captureObject.mjs'

const clock = genClockTZ('Asia/Taipei')

/**
 * 預設子階段所需之最小依賴(各集合為記憶體替身、無來源無文件無線索;不給 areas 集合 → 領域子階段回 disabled)
 *
 * @param {Object} [extra={}] 輸入覆寫
 * @returns {Object} 回傳 deps
 */
const mkDeps = (extra = {}) => ({
    stores: { docs: memStore(), docTexts: memStore(), sources: memStore(), frontier: memStore() },
    seen: null,
    registry: { resolve: () => null, label: () => '' },
    clock,
    dirs: { db: 'x/db', log: 'x/log', tmp: 'x/tmp', state: 'x/state', knowledge: 'x/knowledge' },
    data: { seedSources: [], gridTopics: [] },
    vocab: resolveVocab(null),
    settings: resolveSettings({}),
    ai: null,
    domains: {},
    netGuard: null,
    ...extra,
})

describe('unit-capture-object', function() {

    // ══════════════════════════ 工廠契約 ══════════════════════════
    describe('createCaptureObject 工廠契約', function() {

        it('零參數即符合階段契約(name＋run),失敗預設隔離(onError:continue)——抓取失敗不阻斷後段', () => {
            const o = createCaptureObject()
            assert.equal(o.name, '抓取')
            assert.equal(typeof o.run, 'function')
            assert.equal(o.onError, 'continue')
        })

        it('opt 非物件(null/字串/數字/陣列)→ 視為{},回傳零參數之預設階段物件(不拋錯);opt 為有效物件 → name 覆寫仍生效', () => {
            for (const bogus of [null, 'bogus', 42, [1, 2]]) {
                const o = createCaptureObject(bogus)
                assert.equal(o.name, '抓取')
                assert.equal(o.onError, 'continue')
            }
            assert.equal(createCaptureObject({ name: 'x1' }).name, 'x1')
        })

        it('階段契約欄位可覆寫(name/onError/when/timeoutMs/always),未給者不出現', () => {
            const o = createCaptureObject({ name: 'capture2', onError: 'abort', timeoutMs: 5000, when: () => false, always: true })
            assert.equal(o.name, 'capture2')
            assert.equal(o.onError, 'abort')
            assert.equal(o.timeoutMs, 5000)
            assert.equal(typeof o.when, 'function')
            assert.equal(o.always, true)
            const bare = createCaptureObject()
            assert.deepEqual(['when', 'timeoutMs', 'always'].map((k) => k in bare), [false, false, false])
        })

        it('stageFields:name／onError 給預設,when／timeoutMs／always 只在給了(含 false、0)時原樣透傳', () => {
            assert.deepEqual(stageFields({}, { name: 'n' }), { name: 'n', onError: 'continue' })
            assert.deepEqual(stageFields({ name: 'm', onError: 'abort', always: false, timeoutMs: 0 }, { name: 'n' }), { name: 'm', onError: 'abort', timeoutMs: 0, always: false })
        })

        it('CAPTURE_STAGE_KEYS 依執行順序列出內建子階段(凍結;亦為 opt.<子階段名> 之可用鍵)', () => {
            assert.deepEqual([...CAPTURE_STAGE_KEYS], ['hygiene', 'seedSync', 'listFetch', 'detailFetch', 'docMaintain', 'expand', 'areas'])
            assert.ok(Object.isFrozen(CAPTURE_STAGE_KEYS))
        })

        it('CAPTURE_TAP_STAGE_KEYS＝實際有動作鏈之子階段(由各工廠之行為推導,不手列):有鏈者對不存在之錨點拋「無錨點」,無鏈者(hygiene、areas)拒收 tap／chain——不靜默接受「掛得上卻永不生效」', () => {
            assert.ok(Object.isFrozen(CAPTURE_TAP_STAGE_KEYS))
            const tapped = []
            for (const k of CAPTURE_STAGE_KEYS) {
                let m = ''
                try {
                    createCaptureObject({ [k]: { tap: { __noSuchAnchor: { after: [] } } } })
                }
                catch (e) {
                    m = String(e.message)
                }
                if (/無錨點「__noSuchAnchor」/.test(m)) tapped.push(k)
                else assert.match(m, new RegExp(`子階段\\[${k}\\] 無動作鏈\\(hook 錨點\\),不可給 tap`), `${k}:${m}`)
            }
            assert.deepEqual(tapped, [...CAPTURE_TAP_STAGE_KEYS])
            for (const k of CAPTURE_STAGE_KEYS.filter((x) => !CAPTURE_TAP_STAGE_KEYS.includes(x))) {
                assert.throws(() => createCaptureObject({ [k]: { chain: [] } }), new RegExp(`子階段\\[${k}\\] 無動作鏈\\(hook 錨點\\),不可給 chain`))
                assert.doesNotThrow(() => createCaptureObject({ [k]: { tap: null, chain: undefined } }), `${k}:null／undefined 視為未給`)
            }
        })
    })

    // ══════════════════════════ 子階段序列與隔離 ══════════════════════════
    describe('子階段序列與隔離', function() {

        it('物件 stages 可整組換成自寫單元;通用摘要;單一子階段失敗被隔離', async () => {
            const trace = []
            const warns = []
            const obj = createCaptureObject({
                stages: [
                    {
                        name: 'o1',
                        run: async () => {
                            trace.push('o1'); return { ok: true, stats: { in: 1, out: 1 } }
                        }
                    },
                    {
                        name: 'boom',
                        run: async () => {
                            throw new Error('炸')
                        }
                    },
                    {
                        name: 'o2',
                        run: async () => {
                            trace.push('o2'); return { ok: true, stats: { in: 2, out: 2 } }
                        }
                    },
                ],
            })
            const r = await obj.run({ deps: {}, log: { ...nullLogger(), warn: (m) => warns.push(m) } })
            assert.deepEqual(trace, ['o1', 'o2'], 'boom 失敗後 o2 仍執行')
            assert.ok(warns.some((m) => /boom/.test(m)), '失敗須留痕')
            assert.match(r.summary, /2\/3 段完成/)
            assert.equal(r.stats.in, 3)
            assert.equal(r.stats.fail, 1)
            assert.equal(r.ok, false, '有子階段失敗 → 物件 report.ok 為 false')
            assert.deepEqual(Object.keys(r.detail), ['o1', 'boom', 'o2'])
        })

        it('自寫子階段宣告 onError:abort → 物件外拋(可被 pipeline 隔離)', async () => {
            const obj = createCaptureObject({
                stages: [{
                    name: 'hard',
                    onError: 'abort',
                    run: async () => {
                        throw new Error('硬炸')
                    }
                }],
            })
            await assert.rejects(() => obj.run({ deps: {}, log: nullLogger() }), /硬炸/)
        })

        it('runSubStages:when 不合者略過(report 無該鍵);回 ok:false 而未拋錯者亦記 WARN;拋錯者 report 為 ok:false 並記「失敗：訊息」;onError:abort 者原錯誤外拋', async () => {
            const warns = []
            const ctx = { deps: {}, log: { ...nullLogger(), warn: (m) => warns.push(m) } }
            const ran = []
            const reports = await runSubStages([
                { name: 'skipped', when: () => false, run: async () => ran.push('skipped') },
                { name: 'soft', run: async () => stdReport({ ok: false, summary: '維護鏈異常' }) },
                { name: 'thrown', run: async () => {
                    throw new Error('寫入失敗')
                } },
                { name: 'fine', run: async () => stdReport({ stats: { in: 1 } }) },
            ], ctx)
            assert.deepEqual(ran, [], 'when 不合不執行')
            assert.deepEqual(Object.keys(reports), ['soft', 'thrown', 'fine'])
            assert.equal(reports.thrown.ok, false)
            assert.equal(reports.thrown.summary, '失敗：寫入失敗')
            assert.equal(reports.thrown.stats.fail, 1)
            assert.deepEqual(warns, ['子階段[soft] 回報失敗：維護鏈異常', '子階段[thrown] 失敗（續跑後續子階段）：寫入失敗'])
            await assert.rejects(() => runSubStages([{ name: 'hard', onError: 'abort', run: async () => {
                throw new Error('硬炸')
            } }], ctx), /硬炸/)
        })

        it('預設子階段依序為 hygiene → seedSync → listFetch → detailFetch → docMaintain → expand → areas,全數成功時用固定格式摘要(無資料之空輪各計數為 0、無尾段)', async () => {
            const obj = createCaptureObject()
            const r = await obj.run({ deps: mkDeps(), log: nullLogger() })
            assert.deepEqual(Object.keys(r.detail), ['hygiene', 'seedSync', 'listFetch', 'detailFetch', 'docMaintain', 'expand', 'areas'])
            assert.equal(r.ok, true, JSON.stringify(Object.entries(r.detail).filter(([, x]) => x.ok === false)))
            assert.equal(r.summary, '來源 0 個、新文件 0、素材 0、轉錄 0、放棄 0｜線索消化 0、新來源 0')
            assert.equal(r.detail.hygiene.detail.disabled, true, '孤兒瀏覽器回收預設關閉(掃整台機器之行程,由安裝端開啟)')
            assert.equal(r.detail.areas.detail.disabled, true, '未開 areas 集合 → 領域子階段停用')
        })

        it('opt.<子階段名> 透傳給對應子階段工廠:hygiene 開啟並注入行程清單、seedSync 注入種子', async () => {
            const sources = memStore()
            const obj = createCaptureObject({
                hygiene: { enabled: true, listProcesses: async () => [], killTree: async () => assert.fail('無孤兒不應殺') },
                seedSync: { seeds: [{ id: 's1', kind: 'rss', tier: 1, name: '種子', url: 'https://s.example/feed' }] },
            })
            const r = await obj.run({ deps: mkDeps({ stores: { docs: memStore(), docTexts: memStore(), sources, frontier: memStore() } }), log: nullLogger() })
            assert.notEqual(r.detail.hygiene.detail.scanned, undefined)
            assert.equal(r.detail.hygiene.detail.scanned, 0)
            assert.equal((await sources.get('s1'))?.name, '種子', 'seedSync 之 seeds 生效')
        })

        it('runSubStages:enabled:false 者不跑(run 不被呼叫)、記 INFO、report 為 { detail:{ disabled:true } }(與子階段自身停用時同形);when 不合者仍不入 report', async () => {
            // 規則:captureObject.runSubStages 檔頭——零件庫用法之子階段開關,四套件之子階段經 stageFields 一體適用
            const infos = []
            const ctx = { deps: {}, log: { ...nullLogger(), info: (m) => infos.push(m) } }
            const ran = []
            const reports = await runSubStages([
                { name: 'off', enabled: false, run: async () => ran.push('off') },
                { name: 'cond', when: () => false, run: async () => ran.push('cond') },
                { name: 'on', enabled: true, run: async () => stdReport({ stats: { in: 1 } }) },
            ], ctx)
            assert.deepEqual(ran, [])
            assert.deepEqual(Object.keys(reports), ['off', 'on'])
            assert.deepEqual(reports.off, stdReport({ detail: { disabled: true } }))
            assert.deepEqual(infos, ['子階段[off] 已停用（enabled:false），略過'])
        })

        it('每個內建子階段皆收 opt.<子階段名>.enabled:false 與 when(ctx)(工廠以 stageFields 組契約欄位):停用者 report 為 { disabled:true }、不執行;when 不合者不入 report;輪抓停用時摘要退用通用格式(不印 undefined)', async () => {
            // 規則:captureObject 檔頭與 core/kernel.stageFields——cfg.stageOpts.<子階段>.enabled:false／when 對每個子階段一體適用
            for (const k of CAPTURE_STAGE_KEYS) {
                const r = await createCaptureObject({ [k]: { enabled: false } }).run({ deps: mkDeps(), log: nullLogger() })
                assert.deepEqual(r.detail[k], stdReport({ detail: { disabled: true } }), `${k}:enabled:false 即停用`)
                assert.equal(r.ok, true, `${k}:停用不是失敗`)
                const w = await createCaptureObject({ [k]: { when: () => false } }).run({ deps: mkDeps(), log: nullLogger() })
                assert.equal(k in w.detail, false, `${k}:when 不合者不入 report`)
            }
            const r = await createCaptureObject({ listFetch: { enabled: false } }).run({ deps: mkDeps(), log: nullLogger() })
            assert.match(r.summary, /^7\/7 段完成（in \d+、out \d+、fail 0）$/, `固定格式缺輪抓數字 → 通用摘要：${r.summary}`)
            const all = await createCaptureObject().run({ deps: mkDeps(), log: nullLogger() })
            assert.equal(all.summary, '來源 0 個、新文件 0、素材 0、轉錄 0、放棄 0｜線索消化 0、新來源 0', '未給 enabled 之預設不變')
            // 其餘子階段停用:固定格式仍用,該段不附(不得印出 undefined——10-28 沙箱實跑曾見「線索消化 undefined」)
            const noXp = await createCaptureObject({ expand: { enabled: false }, docMaintain: { enabled: false }, areas: { enabled: false } }).run({ deps: mkDeps(), log: nullLogger() })
            assert.equal(noXp.summary, '來源 0 個、新文件 0、素材 0、轉錄 0、放棄 0')
        })
    })

    // ══════════════════════════ 摘要 ══════════════════════════
    describe('摘要(固定格式與通用摘要)', function() {

        it('aggStats:各子階段之統一核心統計加總(缺 stats 者計 0);failedNames:列出 report.ok===false 者', () => {
            const reports = { a: { ok: true, stats: { in: 1, out: 2 } }, b: { ok: false, stats: { fail: 1, aiCalls: 3 } }, c: null, d: { ok: true } }
            assert.deepEqual(aggStats(reports), { in: 1, out: 2, skip: 0, fail: 1, aiCalls: 3 })
            assert.deepEqual(failedNames(reports), ['b'])
            assert.deepEqual(failedNames({}), [])
        })

        it('genericSummary:「完成段數/總段數（in、out、fail）」', () => {
            assert.equal(genericSummary({ a: { ok: true, stats: { in: 1 } }, b: { ok: false, stats: { fail: 1 } } }), '1/2 段完成（in 1、out 0、fail 1）')
            assert.equal(genericSummary({}), '0/0 段完成（in 0、out 0、fail 0）')
        })

        it('summaryOf:全數成功用固定格式(回空字串則退用通用摘要);部分失敗(子階段沒倒而 stats.fail>0)於句尾附「｜失敗 N」;有子階段失敗者一律改走通用摘要並列出失敗者,且不呼叫固定格式(失敗時 detail 為 {}——會印出 undefined)', () => {
            const ok = { a: { ok: true, stats: { in: 1 } } }
            assert.equal(summaryOf(ok, () => 'FIXED'), 'FIXED')
            assert.equal(summaryOf(ok, () => ''), '1/1 段完成（in 1、out 0、fail 0）')
            const partial = { a: { ok: true, stats: { in: 1, fail: 2 } } }
            assert.equal(summaryOf(partial, () => 'FIXED'), 'FIXED｜失敗 2')
            let called = 0
            const bad = { a: { ok: true, stats: {} }, b: stdReport({ ok: false, stats: { fail: 1 } }), c: stdReport({ ok: false }) }
            assert.equal(summaryOf(bad, () => {
                called++; return 'FIXED'
            }), '1/3 段完成（in 0、out 0、fail 1）｜失敗：b、c')
            assert.equal(called, 0, '有失敗者不呼叫固定格式')
        })

        it('objectReport:{ ok, stats, detail:子階段 report 對照表, summary };有子階段失敗則 ok 為 false', () => {
            const reports = { a: stdReport({ stats: { in: 2, out: 1 } }), b: stdReport({ ok: false, stats: { fail: 1 } }) }
            const r = objectReport(reports, 'S')
            assert.deepEqual([r.ok, r.summary, r.detail === reports], [false, 'S', true])
            assert.deepEqual(r.stats, { in: 2, out: 1, skip: 0, fail: 1, aiCalls: 0 })
            assert.equal(objectReport({ a: stdReport() }, '').ok, true)
        })

        it('captureSummaryOf:缺 listFetch 或 detailFetch 之 detail 時回空字串(由 summaryOf 退用通用摘要)', () => {
            assert.equal(captureSummaryOf({}), '')
            assert.equal(captureSummaryOf({ listFetch: { detail: { sourcesTried: 1, newDocs: 1 } } }), '')
            assert.equal(captureSummaryOf({ detailFetch: { detail: { filled: 1 } } }), '')
        })

        it('captureSummaryOf 固定格式:「來源 N 個、新文件 N、素材 N、轉錄 N、放棄 N」為基底,其後依序附 線索消化／瀏覽器／孤兒回收／領域／健全閘重判／段落鍵補算,各段 >0 才附(既有段落不動、新增段落附於句尾)', () => {
            const base = { listFetch: { detail: { sourcesTried: 3, newDocs: 5 } }, detailFetch: { detail: { filled: 4, aggregated: 1, dead: 2 } } }
            assert.equal(captureSummaryOf(base), '來源 3 個、新文件 5、素材 4、轉錄 1、放棄 2')
            assert.equal(captureSummaryOf({ ...base, expand: { detail: { picked: 4, newSources: 1 } } }), '來源 3 個、新文件 5、素材 4、轉錄 1、放棄 2｜線索消化 4、新來源 1')
            const full = {
                hygiene: { detail: { killed: 2 } },
                listFetch: { detail: { sourcesTried: 3, newDocs: 5 } },
                detailFetch: { detail: { filled: 4, aggregated: 1, dead: 2, browserTried: 3, browserOk: 2, browserDeferred: 1 } },
                docMaintain: { detail: { health: { due: 7, routed: { final: 1, browser: 2, refetch: 0, retry: 1 }, undetermined: 2, left: 3 }, paraKeys: { due: 9, filled: 6, noText: 2, left: 1 } } },
                expand: { detail: { picked: 4, newSources: 1 } },
                areas: { detail: { added: 1, paused: 2 } },
            }
            assert.equal(captureSummaryOf(full), '來源 3 個、新文件 5、素材 4、轉錄 1、放棄 2｜線索消化 4、新來源 1｜瀏覽器 3 試 2 成、延後 1｜孤兒回收 2｜領域 新增 1、暫停 2｜健全閘重判 7（改分流 4、未能判定 2、剩 3）｜段落鍵補算 6（無原文 2、剩 1）')
            // >0 才附:各尾段之計數為 0 者不附
            const zeros = {
                hygiene: { detail: { killed: 0 } },
                listFetch: { detail: { sourcesTried: 0, newDocs: 0 } },
                detailFetch: { detail: { filled: 0, aggregated: 0, dead: 0, browserTried: 0, browserDeferred: 0 } },
                docMaintain: { detail: { health: { due: 0 }, paraKeys: { due: 0 } } },
                areas: { detail: { added: 0, paused: 0 } },
            }
            assert.equal(captureSummaryOf(zeros), '來源 0 個、新文件 0、素材 0、轉錄 0、放棄 0')
            // 瀏覽器段:只有延後(未試)亦附,試與成之計數缺者以 0 計
            assert.equal(captureSummaryOf({ ...base, detailFetch: { detail: { filled: 0, aggregated: 0, dead: 0, browserDeferred: 2 } } }), '來源 3 個、新文件 5、素材 0、轉錄 0、放棄 0｜瀏覽器 0 試 0 成、延後 2')
            // 孤兒回收與領域:只有領域暫停(無新增)亦附
            assert.equal(captureSummaryOf({ ...base, areas: { detail: { paused: 1 } } }), '來源 3 個、新文件 5、素材 4、轉錄 1、放棄 2｜領域 新增 0、暫停 1')
        })

        it('固定格式於子階段失敗時不掩蓋失敗:物件摘要改走通用摘要並列出失敗者,不印 undefined', async () => {
            const obj = createCaptureObject({
                stages: [
                    { name: 'listFetch', run: async () => stdReport({ ok: false, stats: { fail: 1 }, summary: '失敗：x' }) },
                    { name: 'detailFetch', run: async () => stdReport({ detail: { filled: 1, aggregated: 0, dead: 0 } }) },
                ],
            })
            const r = await obj.run({ deps: {}, log: nullLogger() })
            assert.equal(r.summary, '1/2 段完成（in 0、out 0、fail 1）｜失敗：listFetch')
            assert.doesNotMatch(r.summary, /undefined/)
        })
    })
})
