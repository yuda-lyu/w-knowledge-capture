// unit-flow-areas.test.mjs — 領域清單之整合測試:以總組裝 createKnowledgeCapture 跑領域(areas)子階段與其上下游
//   (種子主題 → grid 來源 → 網格抓取 → 線索探測 → 領域自動發現);網路以本機學術 API 替身(OpenAlex／Bing News／arXiv;固定埠 8827)取代,
//   AI 一律替身(腳本化回覆、記錄每次呼叫之提示詞與席位),不連外網、不燒額度。
//
// 案號即本檔規格之編號:
//   AR1  前置:正式組裝(端點基底指向本機)、種子主題 1 個、keyword 線索 1 筆、主概念「系外行星」之近期筆記 25 篇(cfg.notes:true);
//        自訂席位於啟動期交 AI 調度層檢核
//   AR2  第一輪:種子主題成為種子領域,grid 來源由領域派生;經 settings 之端點基底打本機假 OpenAlex → 摘要直入 raw(textFrom abstract)
//   AR3  線索擴充:keyword 線索經本機假 Bing News RSS 探測 → 本次實際新入庫 ≥3 才登錄 tier 3 常設來源
//   AR4  領域自動發現:主概念高支持且未涵蓋之候選 → AI 判覆蓋並產查詢 → 本機假 OpenAlex 驗證(計數、首頁摘要率、在庫比例)
//        → 新增 auto 領域＋grid 來源＋knowledge/areas.md;抓取段摘要尾附「｜領域 新增 1、暫停 0」
//   AR5  第二輪:24 小時內不重發現;回補空頁 → 標耗盡轉 fresh 模式;第三輪 fresh 依出版日由新到舊
//   AR6  瀏覽器環境失敗(接線):子行程層找不到 node 等環境失敗 → 可救件延後(fetcher=browser、不計 tries)、WARN、方法斷路
//   AR7  未開 notes(預設):不開 notes 集合,領域發現之候選只取線索;未覆寫席位時用套件預設席位(免費模型)
//   AR8  開 notes(cfg.notes:true):領域發現讀筆記主概念(候選為「筆記主概念」、evidence.kind＝concept、成長倍數依窗內外筆記數)
//   AR9  cfg.prompts.area 覆寫:覆寫之提示詞原樣送到 AI 替身(取得候選、既有領域與詞彙 ctx);輸出契約固定,覆寫者不能破壞之
//   AR10 capture.discover.ai 席位:領域發現以 settings.capture.discover.ai(替身記錄 spec)呼叫;席位於啟動期交 AI 調度層檢核
//   AR11 驗證未過:自動提案之查詢計數不足 → 記為已拒並冷卻;冷卻中同候選不再提;冷卻期滿同查詢重驗,通過即啟用
//   AR12 領域過濾與信箱:capture.areas.openAlexFields／arxivCategories、capture.expand.arxivCategories 與 capture.services.openAlex.mailto 傳到網格抓取、線索探測與領域驗證之請求
//   AR13 零注入:僅 workDir(加種子與本機端點基底)即可跑完一輪(內建 AI 調度層、真網路探測器、預設日誌與鎖),產物落地
//   AR14 arXiv 類別獨立:capture.areas.arxivCategories(網格遞補)與 capture.expand.arxivCategories(線索探測)各自生效,
//        一方之值不滲入另一方之 arXiv 查詢(兩者不同值、只設網格、只設探測三種組合)
// 執行:在套件根 npx mocha test/unit-flow-areas.test.mjs(暫存 test/_tmp/areas-*-<pid>,測完即刪;只連本機假站台;AI 一律替身)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { clueKey } from '../src/core/stores/frontierPolicy.mjs'
import { areaIdOf, AREA_META_ID } from '../src/stores/areaPolicy.mjs'
import { AREA_CONTRACT } from '../src/domain/areaDomain.mjs'
import { CAPTURE_DEFAULT } from '../src/core/settingsDefault.mjs'
import { normalizeUrl } from '../src/core/util/web.mjs'
import { netProbeUrlsOf } from '../src/core/util/netGuard.mjs'
import { createKnowledgeCapture } from '../src/createKnowledgeCapture.mjs'
import { tmpRoot, removeRoots, resetConceptFold, buildTestCapture, stubAdapter, recLog, subReport, assertSubStagesOk, withStores } from './tools/captureTestKit.mjs'
import { createScholarSite } from './tools/fakeSite.mjs'

const PORT = 8827 // 固定埠(≥8000、不隨機)
const GRID_QUERY = 'planetary science'
const SEED_TOPIC = ['行星科學', GRID_QUERY]
const VOCAB = { kbLabel: '天文學知識庫', domain: '天文學' }
const SEAT = { use: 'stub:seat-main', fallback: ['stub:seat-fallback'] }
const NOW = Date.now()
const recent = (d) => new Date(NOW - d * 86400_000).toISOString()

/** 領域發現之合格回覆(第 1 項為新領域) */
const areaAnswer = (label, query, why = '候選高支持且既有領域未涵蓋') => [{ index: 1, covered: false, label, query, why }]

/** keyword 線索(以相異文件數 3 達候選門檻;探測與領域發現皆以之為對象) */
const keywordClue = (value) => ({ id: clueKey('keyword', value), type: 'keyword', value, why: '測試', status: 'pending', hits: 3, distinctDocs: 3, addedAt: recent(1), fromRef: 'doc:x' })

describe('unit-flow-areas', function() {

    const site = createScholarSite({ port: PORT, gridQuery: GRID_QUERY })
    const H = site.base
    const hits = site.hits
    // 本機端點基底(capture.services)、不限重抓間隔、grid 每輪 4 個、瀏覽器分流停用;各案以展開後覆寫其中之組(組為物件,整個取代需連同其餘鍵給)
    const LOCAL = { services: { openAlex: { base: H }, arxiv: { base: H }, bingNews: { base: H } }, sources: { minIntervalMs: 0 }, areas: { perRun: 4 }, browser: { perRun: 0 } }
    const roots = []
    const rootOf = (name) => {
        const r = tmpRoot(name)
        roots.push(r)
        return r
    }

    before(async () => {
        await site.start()
    })
    after(async () => {
        await site.stop()
        removeRoots(roots)
        resetConceptFold()
    })

    // ── 主流程(notes 開啟):AR1～AR5、AR8、AR10 ──
    describe('主流程(cfg.notes:true)', () => {
        let root = ''
        let flow = null
        let ai = null
        let rep1 = null

        before(async () => {
            root = rootOf('areas-main')
            // 領域發現以替身回覆;其餘一律拋(抓取除領域發現外不得呼叫 AI)
            ai = stubAdapter((prompt) => {
                if (!/的抓取領域規劃員/.test(prompt)) throw new Error(`抓取不得呼叫 AI（領域發現除外）：${prompt.slice(0, 40)}`)
                return areaAnswer('系外行星大氣', 'exoplanet atmosphere composition', '主概念高支持且既有領域未涵蓋')
            }, { validateSeats: true })
            ;({ flow } = buildTestCapture(root, {
                aiAdapter: ai,
                notes: true,
                data: { gridTopics: [SEED_TOPIC], vocab: VOCAB },
                capture: { ...LOCAL, discover: { ai: SEAT } },
            }))
            await withStores(flow, async (s) => {
                await s.frontier.insertNew([keywordClue('tidal locking')])
                await s.notes.insertNew(Array.from({ length: 25 }, (_, i) => ({ id: `n${i}`, title: `系外行星研究 ${i}`, concepts: ['系外行星', '大氣光譜'], createdAt: recent(3), docId: `d${i}` })))
                await s.docs.insertNew(Array.from({ length: 25 }, (_, i) => ({ id: `d${i}`, url: `${H}/old/${i}`, status: 'noted', sourceId: 'rss-x', collectedAt: recent(3) })))
            })
            rep1 = await flow.run()
        })

        it('AR1 前置:cfg.notes:true 加開 notes 集合;席位以自訂值取代預設且於啟動期交調度層檢核', () => {
            // 規則:createKnowledgeCapture 之 storeNames——cfg.notes 為 true 才加開 notes
            assert.deepEqual(flow.info().collections, ['docs', 'docTexts', 'sources', 'frontier', 'areas', 'notes'])
            // 規則:core/settingsDefault 之席位為物件整個取代(不逐層合併)
            assert.deepEqual(flow.info().settings.capture.discover.ai, SEAT)
            // 規則:createKnowledgeCapture 於建構期以 validateSeats({ 'capture.discover.ai': 席位 }) 檢核(設定錯誤須在啟動期爆)
            assert.deepEqual(ai.seatChecks, [{ 'capture.discover.ai': SEAT }])
        })

        it('AR2 第一輪:種子領域 → grid 來源 → 本機假 OpenAlex → 摘要直入 raw;摘要尾附領域統計', async () => {
            assertSubStagesOk(rep1, assert)
            const s = rep1.stages[0].result.summary
            // 規則:captureObject.captureSummaryOf 之領域段(新增或暫停 >0 才附)
            assert.match(s, /｜領域 新增 1、暫停 0/, `抓取段摘要尾附領域統計：${s}`)
            await withStores(flow, async (st) => {
                const gid = areaIdOf(GRID_QUERY)
                const area = await st.areas.get(gid)
                // 規則:stores/areaPolicy.syncSeedAreas——data.gridTopics 成為種子領域
                assert.deepEqual([area.origin, area.status, area.label], ['seed', 'active', '行星科學'])
                const src = await st.sources.get(gid)
                // 規則:領域 id＝其 grid 來源 id;成功後 cursor 前進(stores/sourcePolicy.extraPatchOf)
                assert.deepEqual([src.kind, src.tier, src.cursor], ['grid', 2, 2], 'grid 來源由領域派生、成功後 cursor 前進')
                const raws = (await st.docs.select({ status: 'raw' })).filter((d) => d.textFrom === 'abstract')
                // 規則:fetchers/defaultFetchers.readGrid——grid 摘要即素材直入 raw(textFrom abstract)
                assert.equal(raws.length, 8, `grid 摘要直入 raw 8 篇：${raws.length}`)
                assert.ok(hits.some((h) => h.startsWith('/works?search=planetary%20science&per-page=8&page=1')), '經 settings.capture.services.openAlex.base 打本機')
            })
        })

        it('AR3 線索擴充:keyword 經本機 Bing RSS 探測、本次新入庫 4 篇 → 登錄 tier 3 來源;線索 done', async () => {
            const xp = subReport(rep1, '抓取', 'expand').detail
            assert.equal(xp.newSources, 1, JSON.stringify(xp))
            await withStores(flow, async (st) => {
                const srcs = (await st.sources.select()).filter((x) => /^frontier:keyword:tidal locking/.test(x.origin || ''))
                // 規則:stages/expandStage.probeSearchEndpoints——登錄門檻以本次實際新入庫篇數計(≥3);arXiv 查詢回 0 筆不登錄
                assert.equal(srcs.length, 1, '只登錄 Bing(arXiv 查詢回 0 筆不登錄)')
                assert.equal(srcs[0].tier, 3)
                assert.equal((await st.frontier.get(clueKey('keyword', 'tidal locking'))).status, 'done')
                assert.ok((await st.docs.select()).some((d) => d.url === normalizeUrl(`${H}/news/1`)), '探測文件入庫')
            })
        })

        it('AR4 領域自動發現:AI 一次、驗證通過 → auto 領域＋grid 來源＋areas.md;_meta 記發現時刻與當日新增;提示詞帶詞彙與既有領域', async () => {
            // 規則:stages/areaStage.discover——一次呼叫判一批,每輪至多一次
            assert.equal(ai.calls.length, 1, `領域發現至多一次 AI：${ai.calls.length}`)
            const prompt = ai.calls[0].prompt
            assert.ok(prompt.includes('【系外行星】') && prompt.includes('行星科學（planetary science）'), '候選與既有領域皆入 prompt')
            // 規則:domain/areaDomain 內建提示詞——知識庫稱呼(vocab.kbLabel)與主題範圍(vocab.domain)由詞彙注入
            assert.ok(prompt.includes('天文學知識庫的抓取領域規劃員'), '稱呼由 vocab.kbLabel 注入')
            assert.ok(prompt.includes('本知識庫之主題範圍為「天文學」'), '主題範圍由 vocab.domain 注入')
            await withStores(flow, async (st) => {
                const id = areaIdOf('exoplanet atmosphere composition')
                const a = await st.areas.get(id)
                assert.deepEqual([a.origin, a.status, a.statusBy, a.evidence.candidate, a.validation.count], ['auto', 'active', 'auto', '系外行星', 1500])
                const src = await st.sources.get(id)
                assert.deepEqual([src.kind, src.tier, src.origin], ['grid', 2, 'area:auto'])
                const meta = await st.areas.get(AREA_META_ID)
                assert.equal(meta.addedToday, 1)
            })
            const md = fs.readFileSync(`${root}/knowledge/areas.md`, 'utf8')
            assert.ok(md.includes('系外行星大氣') && md.includes('行星科學'), 'areas.md 投影')
        })

        it('AR8 開 notes:領域發現讀筆記主概念(候選為「筆記主概念」,成長倍數依窗內外筆記數;evidence.kind＝concept)', async () => {
            const prompt = ai.calls[0].prompt
            // 規則:stages/areaStage.discover 於 stores.notes 存在時讀其主概念;stores/areaPolicy.pickAreaCandidates 之主概念候選(窗內 25 篇、窗前 0 篇 → 成長 25 倍)
            assert.match(prompt, /1\. 【系外行星】（筆記主概念，近期 25 篇（成長 25 倍）；例：「系外行星研究 \d+」/, prompt)
            // 線索候選與概念候選同批送出(兩類各取半,互補不互擠)
            assert.match(prompt, /2\. 【tidal locking】（文章線索，被 3 篇相異文件帶出）/, prompt)
            await withStores(flow, async (st) => {
                const a = await st.areas.get(areaIdOf('exoplanet atmosphere composition'))
                assert.deepEqual([a.evidence.kind, a.evidence.support, a.evidence.growth], ['concept', 25, 25])
            })
        })

        it('AR10 席位:領域發現以 settings.capture.discover.ai 呼叫 AI(替身記錄 spec 與預算選項)', () => {
            // 規則:stages/areaStage.discover 之 call＝ai.callJson(prompt, check, { spec: settings.capture.discover.ai, shouldStop, budgetMs })
            assert.deepEqual(ai.calls[0].spec, SEAT)
            assert.equal(typeof ai.calls[0].opt.shouldStop, 'function', '整輪時間預算之守門函數須傳入')
            assert.ok(Number.isFinite(ai.calls[0].opt.budgetMs) && ai.calls[0].opt.budgetMs > 0, `單次呼叫須帶時間預算：${ai.calls[0].opt.budgetMs}`)
        })

        it('AR5 第二輪:24 小時內不重發現(AI 不再呼叫);回補空頁 → 標耗盡轉 fresh 模式;第三輪 fresh 依出版日由新到舊', async () => {
            const r2 = await flow.run()
            assertSubStagesOk(r2, assert)
            // 規則:capture.discover.everyHours(預設 24)——meta.lastDiscoverAt 持久化,未到間隔不呼叫 AI
            assert.equal(ai.calls.length, 1, '未到發現間隔不呼叫 AI')
            assert.equal(subReport(r2, '抓取', 'areas').detail.skipped, '未到發現間隔')
            await withStores(flow, async (st) => {
                const src = await st.sources.get(areaIdOf(GRID_QUERY))
                // 規則:fetchers/defaultFetchers.readGrid 之 _exhausted(空頁且 page>1)→ stores/sourcePolicy.extraPatchOf 轉 fresh
                assert.equal(src.mode, 'fresh', `空頁(page 2)→ 轉 fresh：${JSON.stringify({ mode: src.mode, cursor: src.cursor })}`)
                assert.ok(src.exhaustedAt)
            })
            const n0 = hits.length
            await flow.run()
            assert.ok(hits.slice(n0).some((h) => /search=planetary%20science.*&page=1&sort=publication_date:desc/.test(h)), 'fresh 模式之請求')
        })
    })

    // ── 瀏覽器環境失敗(接線) ──
    describe('瀏覽器環境失敗', () => {
        it('AR6 子行程層環境失敗 → 可救件延後(fetcher=browser、不計 tries)、WARN', async () => {
            const log = recLog()
            const { flow } = buildTestCapture(rootOf('areas-env'), {
                log,
                // 規則:cfg.stageOpts.<子階段> 透傳該子階段工廠之 opt(detailFetch.runCli 為子行程執行器之注入點)
                stageOpts: { detailFetch: { runCli: async () => ({ status: 'error', message: 'ENOENT: spawn node' }) } },
                data: { seedSources: [{ kind: 'rss', tier: 1, name: 'JS 站', url: `${H}/js-feed.xml`, lang: '' }] },
                capture: { ...LOCAL, browser: { perRun: 5 } },
            })
            await withStores(flow, async (st) => {
                await st.docs.insertNew([{ id: 'jsdoc', url: `${H}/js`, title: 'JS 頁', status: 'new', fetchTries: 0, sourceTier: 1, collectedAt: recent(0), feedText: '', text: '', textLength: 0 }])
            })
            const r = await flow.run()
            const df = subReport(r, '抓取', 'detailFetch').detail
            // 規則:fetchers/browserFetcher.runBrowserCli——找不到 node 等子行程層失敗為環境失敗(不計 tries),stages/detailFetchStage 延後至瀏覽器佇列
            assert.equal(df.browserEnvFail, 1, JSON.stringify(df))
            await withStores(flow, async (st) => {
                const d = await st.docs.get('jsdoc')
                assert.deepEqual([d.status, d.fetcher, d.fetchTries, d.deferrals], ['new', 'browser', 0, 1])
            })
            assert.ok(log.lines.some((l) => /^WARN 內文\[JS 頁\] 瀏覽器環境不可用/.test(l)), log.lines.filter((l) => /WARN/.test(l)).join('\n'))
        })
    })

    // ── 未開 notes(預設) ──
    describe('未開 notes(預設)', () => {
        let flow = null
        let ai = null
        let rep = null

        before(async () => {
            ai = stubAdapter(() => areaAnswer('潮汐鎖定現象', 'tidal locking synchronous rotation', '線索高支持且既有領域未涵蓋'))
            ;({ flow } = buildTestCapture(rootOf('areas-nonotes'), {
                aiAdapter: ai,
                data: { gridTopics: [SEED_TOPIC] },
                capture: LOCAL,
            }))
            await withStores(flow, async (s) => {
                await s.frontier.insertNew([keywordClue('tidal locking')])
            })
            rep = await flow.run()
        })

        it('AR7 不開 notes 集合;領域發現之候選只取線索(無筆記主概念);發現成功之領域來自線索', async () => {
            // 規則:createKnowledgeCapture 之 storeNames——cfg.notes 預設 false,抓取不預設依賴摘要之產物
            assert.deepEqual(flow.info().collections, ['docs', 'docTexts', 'sources', 'frontier', 'areas'])
            const stores = flow.openStores()
            try {
                assert.deepEqual(Object.keys(stores), ['docs', 'docTexts', 'sources', 'frontier', 'areas'], 'openStores 不含 notes')
            }
            finally {
                await flow.closeStores(stores)
            }
            assertSubStagesOk(rep, assert)
            // 規則:stages/areaStage.discover 於無 stores.notes 時 notes＝[](不拋錯),pickAreaCandidates 只剩線索候選
            assert.equal(ai.calls.length, 1)
            const prompt = ai.calls[0].prompt
            assert.match(prompt, /1\. 【tidal locking】（文章線索，被 3 篇相異文件帶出）/, prompt)
            assert.ok(!prompt.includes('筆記主概念'), '未開 notes 時候選不含筆記主概念')
            assert.equal(subReport(rep, '抓取', 'areas').detail.candidates, 1, '候選只有該線索')
            await withStores(flow, async (st) => {
                const a = await st.areas.get(areaIdOf('tidal locking synchronous rotation'))
                assert.deepEqual([a.origin, a.status, a.label, a.evidence.kind, a.evidence.candidate, a.evidence.clueDocs], ['auto', 'active', '潮汐鎖定現象', 'clue', 'tidal locking', 3])
            })
        })

        it('AR10 未覆寫席位時用套件預設席位呼叫 AI', () => {
            // 規則:core/settingsDefault.CAPTURE_DEFAULT.discover.ai 為套件預設席位(免費模型);領域發現未另指定時沿用
            assert.deepEqual(ai.calls[0].spec, CAPTURE_DEFAULT.discover.ai)
        })
    })

    // ── cfg.prompts.area 覆寫 ──
    describe('prompts.area 覆寫', () => {
        /** 組裝一個以覆寫提示詞跑領域發現之流程;answer 為 AI 替身之回覆 */
        async function runWithPrompt(name, answer) {
            const seen = []
            const ai = stubAdapter(() => answer)
            const { flow } = buildTestCapture(rootOf(name), {
                aiAdapter: ai,
                data: { gridTopics: [SEED_TOPIC], vocab: VOCAB },
                capture: LOCAL,
                // 覆寫之提示詞函數:記錄所收引數,回傳可辨識之文字
                prompts: {
                    area: (candidates, areas, ctx) => {
                        const text = `自訂提示詞｜${ctx.kbLabel}｜${ctx.domain}｜${candidates.map((c) => `${c.kind}:${c.label}`).join(',')}｜${areas.map((a) => a.label).join(',')}`
                        seen.push({ candidates, areas, ctx, text })
                        return text
                    },
                },
            })
            await withStores(flow, async (s) => {
                await s.frontier.insertNew([keywordClue('tidal locking')])
            })
            const rep = await flow.run()
            return { flow, ai, seen, rep }
        }

        it('AR9 覆寫之提示詞原樣送到 AI 替身(不再用內建提示詞);取得候選、既有領域與詞彙 ctx(含固定之輸出契約)', async () => {
            const { flow, ai, seen, rep } = await runWithPrompt('areas-prompt-ok', areaAnswer('潮汐鎖定現象', 'tidal locking synchronous rotation'))
            assertSubStagesOk(rep, assert)
            // 規則:domain/areaDomain.createAreaDomain 之 opt.buildPrompt 取代內建提示詞;createKnowledgeCapture 以 cfg.prompts.area 帶入
            assert.equal(seen.length, 1, '提示詞函數於一次發現呼叫一次')
            assert.equal(ai.calls.length, 1)
            assert.equal(ai.calls[0].prompt, seen[0].text, '送到 AI 替身者即覆寫函數之回傳')
            assert.ok(!/的抓取領域規劃員/.test(ai.calls[0].prompt), '不得混入內建提示詞')
            // 規則:buildPrompt 之 ctx＝{ kbLabel, domain, contract:AREA_CONTRACT, defaultPrompt }——輸出契約與提示詞同源且為凍結物件;defaultPrompt 供包裝內建提示詞
            const { defaultPrompt, ...ctxRest } = seen[0].ctx
            assert.deepEqual(ctxRest, { kbLabel: '天文學知識庫', domain: '天文學', contract: AREA_CONTRACT })
            assert.equal(typeof defaultPrompt, 'function')
            assert.ok(Object.isFrozen(seen[0].ctx.contract), '契約為凍結物件(覆寫者只能讀)')
            assert.deepEqual(seen[0].candidates.map((c) => [c.kind, c.label, c.clueDocs]), [['clue', 'tidal locking', 3]])
            assert.deepEqual(seen[0].areas.map((a) => [a.label, a.query]), [SEED_TOPIC], '既有領域(active／paused)隨提示詞函數送入')
            await withStores(flow, async (st) => {
                assert.ok(await st.areas.get(areaIdOf('tidal locking synchronous rotation')), '合契約之回覆照常新增領域')
            })
        })

        it('AR9 輸出契約固定:覆寫提示詞者之 AI 輸出仍由內建驗證擋下(標籤逾字數上限)→ 不新增領域、記發現失敗、等重試窗口', async () => {
            const tooLong = '一個超過十六個字之過長領域標籤名稱用以違反契約'
            assert.ok([...tooLong].length > AREA_CONTRACT.labelMax)
            const { flow, ai, rep } = await runWithPrompt('areas-prompt-bad', areaAnswer(tooLong, 'tidal locking synchronous rotation'))
            // 規則:stages/areaStage.discover 之 check＝domain.isValidItem(AREA_CONTRACT);全部項目不合格 → AI 呼叫視為失敗(整條遞補鏈交 check 驗)
            assert.equal(ai.calls.length, 1)
            const areas = subReport(rep, '抓取', 'areas')
            assert.match(areas.detail.error, /^AI 判定失敗：/, JSON.stringify(areas.detail))
            assert.equal(areas.detail.added, 0)
            await withStores(flow, async (st) => {
                const meta = await st.areas.get(AREA_META_ID)
                // 規則:發現失敗不作廢窗口——記 discoverFailAt、不推進 lastDiscoverAt
                assert.ok(meta.discoverFailAt, '失敗須記 discoverFailAt')
                assert.ok(!meta.lastDiscoverAt, '失敗不推進 lastDiscoverAt')
                const all = (await st.areas.select()).filter((a) => a.id !== AREA_META_ID)
                assert.deepEqual(all.map((a) => a.origin), ['seed'], '只有種子領域,無新增')
            })
        })
    })

    // ── 驗證未過、冷卻與期滿重驗 ──
    describe('驗證未過與冷卻(AR11)', () => {
        it('AR11 自動提案驗證未過(OpenAlex 計數低於 capture.discover.minHits)→ 記為已拒並冷卻、不啟用;冷卻中同候選不再提(不呼叫 AI);冷卻期滿同查詢重驗,通過即啟用', async () => {
            const QUERY = 'rare phenomenon study'
            const past = '2020-01-01T00:00:00.000Z'
            site.counts.set(QUERY, 5)
            const ai = stubAdapter(() => areaAnswer('稀有現象研究', QUERY))
            const root = rootOf('areas-reject')
            const { flow } = buildTestCapture(root, { aiAdapter: ai, data: { gridTopics: [SEED_TOPIC] }, capture: LOCAL })
            await withStores(flow, async (s) => {
                await s.frontier.insertNew([keywordClue('rare phenomenon')])
            })
            const id = areaIdOf(QUERY)

            // ① 驗證未過
            const r1 = await flow.run()
            assertSubStagesOk(r1, assert)
            const d1 = subReport(r1, '抓取', 'areas').detail
            assert.deepEqual([ai.calls.length, d1.proposed, d1.added, d1.rejected], [1, 1, 0, 1], JSON.stringify(d1))
            await withStores(flow, async (st) => {
                const a = await st.areas.get(id)
                // 規則:stages/areaStage.validateAreaQuery——計數低於 capture.discover.minHits 即不過;未過者記為已拒並冷卻 capture.discover.rejectCooldownDays(預設 30 天)
                assert.deepEqual([a.status, a.statusBy, a.origin, a.candidate], ['rejected', 'auto', 'auto', 'rare phenomenon'])
                assert.match(a.reason, /^驗證未過：計數 5 < 200/, a.reason)
                const days = (Date.parse(a.cooldownUntil) - Date.now()) / 86400_000
                assert.ok(days > 29.9 && days < 30.1, `冷卻約 30 天：${a.cooldownUntil}`)
                assert.equal(await st.sources.get(id), null, '未啟用者不得有 grid 來源')
            })
            assert.ok(!/｜領域/.test(r1.stages[0].result.summary), `無新增或暫停者摘要不附領域段：${r1.stages[0].result.summary}`)
            // 規則:stores/areaPolicy.renderAreasMd——冷卻中之已拒候選列於投影之末(不是領域列)
            assert.ok(fs.readFileSync(`${root}/knowledge/areas.md`, 'utf8').includes('冷卻中之已拒候選 1 個：稀有現象研究'))

            // ② 冷卻中:發現間隔已過,但同候選在冷卻內不再提 → 無候選、不呼叫 AI
            await withStores(flow, async (st) => st.areas.patch(AREA_META_ID, { lastDiscoverAt: past }))
            const r2 = await flow.run()
            const d2 = subReport(r2, '抓取', 'areas').detail
            // 規則:stores/areaPolicy.pickAreaCandidates 排除冷卻中之已拒候選(isRejected)
            assert.deepEqual([d2.discovered, d2.candidates, ai.calls.length], [true, 0, 1], JSON.stringify(d2))

            // ③ 冷卻期滿 + 查詢端計數已達標:同查詢重驗通過 → 啟用,冷卻清除
            site.counts.set(QUERY, 1500)
            await withStores(flow, async (st) => {
                await st.areas.patch(id, { cooldownUntil: past })
                await st.areas.patch(AREA_META_ID, { lastDiscoverAt: past })
            })
            const r3 = await flow.run()
            assertSubStagesOk(r3, assert)
            assert.equal(ai.calls.length, 2, '冷卻期滿後候選再被提出')
            await withStores(flow, async (st) => {
                const a = await st.areas.get(id)
                // 規則:stages/areaStage.discover 之 cooled／again——冷卻期滿者同查詢重驗(CS6),通過即轉 active 並清冷卻
                assert.deepEqual([a.status, a.origin, a.cooldownUntil, a.validation.count], ['active', 'auto', '', 1500])
                assert.equal((await st.sources.get(id)).kind, 'grid', '啟用後有 grid 來源')
            })
            site.counts.delete(QUERY)
        })
    })

    // ── 領域過濾與信箱 ──
    describe('領域過濾與信箱(AR12)', () => {
        it('AR12 capture.areas.openAlexFields、capture.expand.arxivCategories 與 capture.services.openAlex.mailto 傳到網格抓取、線索探測與領域驗證之請求', async () => {
            const ai = stubAdapter(() => areaAnswer('潮汐鎖定現象', 'tidal locking synchronous rotation'))
            const { flow } = buildTestCapture(rootOf('areas-filter'), {
                aiAdapter: ai,
                data: { gridTopics: [SEED_TOPIC] },
                capture: {
                    ...LOCAL,
                    areas: { ...LOCAL.areas, openAlexFields: '31|19', arxivCategories: ['astro-ph.EP'] },
                    expand: { arxivCategories: ['astro-ph.EP'] },
                    services: { ...LOCAL.services, openAlex: { base: H, mailto: 'astro@example.org' } },
                },
            })
            await withStores(flow, async (s) => {
                await s.frontier.insertNew([keywordClue('tidal locking')])
            })
            const n0 = hits.length
            const rep = await flow.run()
            assertSubStagesOk(rep, assert)
            const mine = hits.slice(n0)
            const paramsOf = (h) => new URL(h, H).searchParams
            // 規則:fetchers/defaultFetchers.readGrid——OpenAlex 以 primary_topic.field.id 白名單過濾、帶禮貌池信箱
            const grid = mine.find((h) => h.startsWith('/works?search=planetary%20science&per-page=8&page=1'))
            assert.ok(grid, `網格請求須存在：${mine.join('\n')}`)
            assert.equal(paramsOf(grid).get('filter'), 'primary_topic.field.id:31|19')
            assert.equal(paramsOf(grid).get('mailto'), 'astro@example.org')
            // 規則:stages/expandStage.probeSearchEndpoints——線索探測之 arXiv 查詢以 capture.expand.arxivCategories 逐一 OR 列出類別
            const arxiv = mine.find((h) => h.startsWith('/api/query?'))
            assert.ok(arxiv, `arXiv 探測請求須存在：${mine.join('\n')}`)
            assert.equal(paramsOf(arxiv).get('search_query'), 'all:"tidal locking" AND (cat:astro-ph.EP)')
            // 規則:stages/areaStage.validateAreaQuery——領域驗證同用領域過濾與信箱(與網格抓取同一組)
            const validate = mine.find((h) => /select=id,doi/.test(h))
            assert.ok(validate, `領域驗證請求須存在：${mine.join('\n')}`)
            assert.equal(paramsOf(validate).get('search'), 'tidal locking synchronous rotation')
            assert.equal(paramsOf(validate).get('filter'), 'primary_topic.field.id:31|19')
            assert.equal(paramsOf(validate).get('mailto'), 'astro@example.org')
        })
    })

    // ── 網格遞補與線索探測之 arXiv 類別各自獨立 ──
    describe('arXiv 類別之獨立(AR14)', () => {
        // 三種組合(各自一輪):兩者不同值、只設網格、只設探測——任一方之值都不得滲入另一方之請求(對稱)
        const COMBOS = [
            { name: 'areas-cats-both', areasCats: ['stat.ML', 'math.OC'], expandCats: ['astro-ph.EP'], gridQuery: 'all:planetary science AND (cat:stat.ML OR cat:math.OC)', probeQuery: 'all:"tidal locking" AND (cat:astro-ph.EP)' },
            { name: 'areas-cats-grid-only', areasCats: ['stat.ML'], expandCats: [], gridQuery: 'all:planetary science AND (cat:stat.ML)', probeQuery: 'all:"tidal locking"' },
            { name: 'areas-cats-probe-only', areasCats: [], expandCats: ['astro-ph.EP'], gridQuery: 'all:planetary science', probeQuery: 'all:"tidal locking" AND (cat:astro-ph.EP)' },
        ]
        for (const c of COMBOS) {
            it(`AR14 capture.areas.arxivCategories＝${JSON.stringify(c.areasCats)}、capture.expand.arxivCategories＝${JSON.stringify(c.expandCats)}:OpenAlex 失敗而遞補 arXiv 之網格請求只含前者、線索探測之 arXiv 請求只含後者`, async () => {
                const { flow } = buildTestCapture(rootOf(c.name), {
                    data: { gridTopics: [SEED_TOPIC] },
                    capture: {
                        ...LOCAL,
                        // OpenAlex 基底指向假站台上不存在之路徑(回 404)→ 網格抓取失敗而遞補 arXiv;arXiv 與 Bing 指向本機假站台(只看其收到之請求)
                        services: { ...LOCAL.services, openAlex: { base: `${H}/openalex-down` } },
                        areas: { ...LOCAL.areas, arxivCategories: c.areasCats },
                        expand: { arxivCategories: c.expandCats },
                        discover: { everyHours: 0 }, // 領域發現停用:不呼叫 AI、不驗證領域(OpenAlex 已指向死埠)
                    },
                })
                await withStores(flow, async (s) => {
                    await s.frontier.insertNew([keywordClue('tidal locking')])
                })
                const n0 = hits.length
                const rep = await flow.run()
                assert.equal(rep.ok, true, '管線整體須成功(網格雙供應商失敗只記為該來源之失敗,不使子階段拋錯)')
                const queries = hits.slice(n0).filter((h) => h.startsWith('/api/query?')).map((h) => new URL(h, H).searchParams.get('search_query'))
                // 規則:fetchers/defaultFetchers.readGrid——OpenAlex 失敗時遞補 arXiv,類別取 opt.arxivCategories(總組裝傳 capture.areas.arxivCategories)
                // 規則:stages/expandStage.probeSearchEndpoints——線索探測之 arXiv 查詢類別取 capture.expand.arxivCategories(與網格遞補各自獨立)
                assert.deepEqual([...queries].sort(), [c.gridQuery, c.probeQuery].sort(), `arXiv 請求恰兩筆(網格遞補一、線索探測一):${queries.join(' | ')}`)
                const gridQ = queries.find((q) => q.startsWith('all:planetary science'))
                const probeQ = queries.find((q) => q.startsWith('all:"tidal locking"'))
                for (const cat of c.expandCats) assert.ok(!gridQ.includes(cat), `網格遞補之查詢不得含探測類別 ${cat}：${gridQ}`)
                for (const cat of c.areasCats) assert.ok(!probeQ.includes(cat), `線索探測之查詢不得含網格類別 ${cat}：${probeQ}`)
            })
        }
    })

    // ── 零注入 ──
    describe('零注入(AR13)', () => {
        it('AR13 僅給 workDir(加種子與本機端點基底)即可跑完一輪:內建 AI 調度層、真網路探測器、預設日誌與鎖皆為套件預設;產物落地(db、日誌、run.json、領域清單)', async () => {
            const root = rootOf('areas-zero')
            // 不注入 aiAdapter、netGuard、logFactory、lock:端點基底全指本機,真探測器只探本機站台(不連外網)
            const flow = createKnowledgeCapture({
                workDir: root,
                data: { seedSources: [{ kind: 'rss', tier: 1, name: '零注入測試站', url: `${H}/zero/feed.xml`, lang: 'zh' }] },
                capture: { services: { openAlex: { base: H }, arxiv: { base: H }, bingNews: { base: H } } },
            })
            const info = flow.info()
            // 規則:core/util/netGuard.netProbeUrlsOf——capture.network.probeUrls 預設 null 時取 capture.services 三個端點基底之原點(不另引第三方)
            assert.equal(info.settings.capture.network.probeUrls, null)
            assert.deepEqual(netProbeUrlsOf(info.settings.capture), [H])
            const echoed = []
            const origLog = console.log
            console.log = (...a) => echoed.push(a.join(' '))
            let rep = null
            try {
                rep = await flow.run()
            }
            finally {
                console.log = origLog
            }
            assertSubStagesOk(rep, assert)
            assert.match(rep.stages[0].result.summary, /^來源 1 個、新文件 3、素材 3、轉錄 0、放棄 0｜線索消化 0、新來源 0$/, rep.stages[0].result.summary)
            await withStores(flow, async (st) => {
                const docs = await st.docs.select()
                assert.deepEqual(docs.map((d) => [d.status, d.textFrom]), [['raw', 'article'], ['raw', 'article'], ['raw', 'article']])
            })
            // 規則:套件預設目錄(core/dirs.expandDirs)——db／log／knowledge 落在 workDir 下,鎖已釋放
            assert.ok(fs.readdirSync(`${root}/db`).length > 0, 'LMDB 資料落在 <workDir>/db')
            assert.ok(fs.existsSync(`${root}/knowledge/areas.md`), '領域清單投影落在 <workDir>/knowledge')
            assert.ok(!fs.existsSync(`${root}/tmp/run.lock`), '執行鎖須已釋放')
            const logFile = rep.summaryFile.replace(/-run\.json$/, '-run.log')
            assert.ok(fs.existsSync(rep.summaryFile) && fs.existsSync(logFile), 'run.json 與日誌須落地(同一時間戳)')
            const logText = fs.readFileSync(logFile, 'utf8')
            // 規則:createKnowledgeCapture.run——啟動期檢核之警告每輪開頭記入日誌(未給排程上限亦未給預算時採套件預設)
            assert.match(logText, /WARN +啟動期檢核：未給 scheduleLimitMin 亦未給 deadlineMs/, logText.slice(0, 300))
            assert.ok(echoed.some((l) => /管道\[知識抓取\]/.test(l)), '預設日誌須同時輸出 stdout')
        })
    })
})
