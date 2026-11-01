// unit-capture-standards.test.mjs — 抓取檢定標準:文件標準之純函數(docStandards)、標準全集(registry)之欄位完整性、符合度掃描(audit)
// 規則(出自 standards/* 檔頭):
//   ①每條標準一列定義(id、標題、對象、kind、版本、能證明／不能證明、執行處、是否掃描);執行處須指向實際存在之檔與函數
//   ②可掃描之文件標準(CS1a、CS2、CS10、CS12)之標題與版本取自 DOC_STANDARDS 單一來源;領域發現之契約數字取自 AREA_CONTRACT
//   ③掃描唯讀:不寫任何知識庫檔案;會寫入之判定函數以唯讀替身集合呼叫,只取其判定
//   ④逐標準回報總量與四態(合格／不合格／未能判定／不適用)與豁免;讀不到材料記未能判定,不報為零;使用者豁免是裁示,不是合格
// 執行:自套件根 npx mocha test/unit-capture-standards.test.mjs(純記憶體集合,不連網、不寫檔)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { memStore } from './tools/memStore.mjs'
import { DOC_STANDARDS, titleTokens, checkTitleBody, contentKeysOfUrl, duplicateGroups } from '../src/standards/docStandards.mjs'
import { CAPTURE_STANDARDS } from '../src/standards/registry.mjs'
import { auditCaptureStandards, createStandardsTally, standardsScanOf, standardsCountsOf, AI_ROW_KEYS, AUDITED_STANDARD_IDS, GROUP_ID_SEP } from '../src/standards/audit.mjs'
import { CONTENT_GATE_V } from '../src/stores/contentGate.mjs'
import { AREA_CONTRACT } from '../src/domain/areaDomain.mjs'
import { paraKeysOf } from '../src/stores/contentIndex.mjs'
import { packText } from '../src/core/stores/docTexts.mjs'
import { STATUS } from '../src/core/standards/verdict.mjs'
import { settingsOf } from './tools/captureTestKit.mjs'

// 套件根(以本檔位置定,不依 cwd)
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── 文件素材 ──
// 健全正文(≥300 字、無佔位／付費牆字樣、非亂碼、非格式雜訊)
const HEALTHY = '這是一段用於測試之正常內容,描述研究方法、實驗設計與結果之分析。'.repeat(20)
// 段落(正規化後 ≥60 字才計入段落雜湊)
const P = (s) => `${s}之研究段落內容說明，`.repeat(6)

/**
 * 組一組集合(各集合為記憶體實作;holds 給了才有)
 *
 * @param {Object} [o={}] 輸入 { docs, docTexts, sources, frontier, areas, holds }(各為記錄陣列)
 * @returns {Object} 回傳 stores
 */
const stores = (o = {}) => ({
    docs: memStore(o.docs || []),
    docTexts: memStore(o.docTexts || []),
    sources: memStore(o.sources || []),
    frontier: memStore(o.frontier || []),
    areas: memStore(o.areas || []),
    ...(o.holds ? { holds: memStore(o.holds) } : {}),
})

/**
 * 執行掃描(只取指定標準之結果)
 *
 * @param {Object} o 輸入集合內容(同 stores)
 * @param {Array} only 輸入標準 id
 * @param {Object} [deps2={}] 輸入併入 deps 之其他鍵(如 settings)
 * @param {Object} [opt={}] 輸入掃描選項
 * @returns {Promise} 回傳掃描報告
 */
const audit = (o, only, deps2 = {}, opt = {}) => auditCaptureStandards({ stores: stores(o), ...deps2 }, { only, ...opt })

const ids = (list) => list.map((x) => x.id)

describe('unit-capture-standards', function() {

    describe('文件標準之純函數(standards/docStandards)', function() {

        it('DOC_STANDARDS:CS1a、CS2、CS10、CS12 各一列,皆為程式判定、版本為正整數;CS1a 之版本即健全閘版本號', () => {
            assert.deepEqual(DOC_STANDARDS.map((s) => s.id), ['CS1a', 'CS2', 'CS10', 'CS12'])
            for (const s of DOC_STANDARDS) {
                assert.ok(typeof s.title === 'string' && s.title.length > 0, `${s.id} 標題`)
                assert.equal(s.kind, 'program')
                assert.ok(Number.isInteger(s.v) && s.v > 0, `${s.id} 版本`)
            }
            assert.equal(DOC_STANDARDS.find((s) => s.id === 'CS1a').v, CONTENT_GATE_V, '判準改變即升版:CS1a 版本取閘版本號')
        })

        it('titleTokens:拉丁詞取 ≥4 字母並去虛詞與重複(縮寫、數字不計);中日韓取連續漢字之二字組', () => {
            assert.deepEqual(titleTokens('Momentum Strategies in Taiwan Equities: ETF VIX 2024'), { latin: ['momentum', 'strategies', 'taiwan', 'equities'], cjk: [] }, '≤3 字母之縮寫與數字不計')
            assert.deepEqual(titleTokens('This that with from have been').latin, [], '虛詞不計')
            assert.deepEqual(titleTokens('Data data DATA science').latin, ['data', 'science'], '大小寫折疊後去重')
            assert.deepEqual(titleTokens('注意力機制').cjk, ['注意', '意力', '力機', '機制'])
            assert.deepEqual(titleTokens('機').cjk, [], '單字不成二字組')
            assert.deepEqual(titleTokens(null), { latin: [], cjk: [] })
            assert.deepEqual(titleTokens(undefined), { latin: [], cjk: [] })
            assert.deepEqual(titleTokens('ＡＢＣＤＥ'), { latin: ['abcde'], cjk: [] }, 'NFKC 折疊全形')
        })

        it('CS2 checkTitleBody:標題詞 ≥4 且覆蓋 >0 → 合格;覆蓋 =0 → 不合格(確定錯頁);標題詞不足或文字系統不同 → 不適用', () => {
            const body = 'Momentum strategies in Taiwan equities earn excess returns after costs. '.repeat(10)
            const pass = checkTitleBody('Momentum strategies Taiwan equities excess', body)
            assert.deepEqual([pass.std, pass.status, pass.detail], ['CS2', STATUS.PASS, '覆蓋 5/5'])
            const viol = checkTitleBody('Chocolate recipes wedding cakes baking guide', body)
            assert.deepEqual([viol.status, viol.detail], [STATUS.VIOLATION, '標題詞 6 個皆不見於正文'])
            const few = checkTitleBody('Short title', body)
            assert.deepEqual([few.status, few.detail], [STATUS.NA, '標題詞 2 個(須 ≥4)'])
            // 門檻邊界:3 個詞不判、4 個詞才判(詞太少之覆蓋 0 不足以證明錯頁)
            assert.deepEqual([checkTitleBody('Chocolate recipes wedding', body).status, checkTitleBody('Chocolate recipes wedding', body).detail], [STATUS.NA, '標題詞 3 個(須 ≥4)'])
            assert.equal(checkTitleBody('Chocolate recipes wedding cakes', body).status, STATUS.VIOLATION)
            const cross = checkTitleBody('Momentum strategies Taiwan equities excess', '台股動量策略之超額報酬'.repeat(10))
            assert.deepEqual([cross.status, cross.detail], [STATUS.NA, '正文與標題文字系統不同'], '拉丁標題配中文正文不判')
            const crossZh = checkTitleBody('台股動量策略之超額報酬研究', 'Momentum strategies in Taiwan equities earn excess returns after costs. '.repeat(10))
            assert.equal(crossZh.status, STATUS.NA, '中文標題配英文正文不判')
        })

        it('CS2:覆蓋只計正文前 6,000 字(其後之詞不算);正文不足(拉丁 <200 字母、漢字 <50)不判;標題與正文皆經 NFKC 並不分大小寫;輸入非字串不拋', () => {
            const title = 'Momentum strategies Taiwan equities excess'
            const filler = 'Lorem ipsum dolor sit amet consectetur adipiscing elit. '
            const late = filler.repeat(Math.ceil(6000 / filler.length) + 2) + title
            assert.equal(checkTitleBody(title, late).status, STATUS.VIOLATION, '標題詞全在 6,000 字之後 → 前段覆蓋 0')
            assert.equal(checkTitleBody(title, `${title} ${filler.repeat(200)}`).status, STATUS.PASS, '標題詞在前段 → 合格')
            assert.equal(checkTitleBody(title, 'short body').status, STATUS.NA, '拉丁正文不足 200 字母')
            assert.equal(checkTitleBody('台股動量策略之超額報酬研究', '台股').status, STATUS.NA, '漢字正文不足 50')
            assert.equal(checkTitleBody('ＭＯＭＥＮＴＵＭ strategies Taiwan equities', `momentum ${filler.repeat(10)}`).status, STATUS.PASS, '全形大寫之標題詞與小寫正文相符')
            assert.equal(checkTitleBody(null, null).status, STATUS.NA)
            assert.equal(checkTitleBody(undefined, 123).status, STATUS.NA)
        })

        // 規則:standards/docStandards.checkTitleBody 之「確定錯頁」判準——標題與正文同文字系統、標題詞(拉丁 ≥4 字母去虛詞;中日韓二字組)≥4 而覆蓋＝0 → 不合格;
        //   0＜覆蓋 → 合格(不判);標題詞不足 → 不適用。WALL＝機器人牆頁(典型之確定錯頁:與任何描述性標題皆無共同詞)
        const WALL = 'Our company keeps high security standards and one of our security tools has flagged this request as exhibiting automated behavior. To protect our platform integrity, we restrict programmatic access from unauthorized commercial tools. If you believe this is an error, please contact Helpdesk and provide the reference.'

        it('CS2 縮寫與翻譯標題不誤殺(確定錯頁才不合格):≤3 字母之縮寫不計詞;全稱改寫之正文只要一詞相符即合格;機器人牆頁配描述性標題 → 不合格', () => {
            assert.equal(checkTitleBody('ETF, VIX and CPI: Fed and SEC risk', WALL).status, STATUS.NA, '標題詞只有 risk 一個')
            const title = 'CAPM beta fails during FOMC weeks'
            const article = 'The Capital Asset Pricing Model predicts that market beta explains the cross-section of expected returns. Around Federal Open Market Committee announcements the relation strengthens, while on other days the slope is flat or negative. We document this pattern across portfolios sorted on size and value.'
            const r = checkTitleBody(title, article)
            assert.deepEqual([r.status, r.detail], [STATUS.PASS, '覆蓋 1/5'], '覆蓋 >0 不判(全稱改寫之正文仍含 beta)')
            const w = checkTitleBody(title, WALL)
            assert.deepEqual([w.status, w.detail], [STATUS.VIOLATION, '標題詞 5 個皆不見於正文'], '同一標題配錯頁(牆頁)→ 不合格,說明列標題詞數')
        })

        it('CS2 轉錄錨文字標題(轉錄件之記錄標題＝彙整頁之連結文字,verify C17):描述性錨文字而目標頁為該文 → 合格;泛用錨文字(Click here to read more)詞不足 → 不適用;描述性錨文字配錯頁 → 不合格;中文錨文字同理(二字組)', () => {
            const anchor = 'Read the full paper: Momentum crashes and volatility scaling (SSRN)'
            const paper = 'Momentum strategies earn large premia but experience infrequent and persistent crashes. We show that scaling the strategy by its forecast volatility substantially reduces crash risk and nearly doubles the Sharpe ratio in long samples of equities and futures.'
            assert.equal(checkTitleBody(anchor, paper).status, STATUS.PASS)
            assert.deepEqual([checkTitleBody('Click here to read more about this', paper).status], [STATUS.NA], '泛用錨文字之標題詞 3 個(click、here、read)')
            assert.equal(checkTitleBody(anchor, WALL).status, STATUS.VIOLATION, '描述性錨文字之詞皆不見於牆頁 → 確定錯頁')
            const zh = '延伸閱讀：台股動量策略之實證'
            assert.equal(checkTitleBody(zh, '台股動量策略之回測結果顯示，扣除交易成本後仍有超額報酬，持有期間與形成期為關鍵參數。'.repeat(3)).status, STATUS.PASS)
            assert.equal(checkTitleBody(zh, '這是一篇講述烘焙麵包與咖啡沖煮技巧的生活文章，內容涵蓋發酵溫度與研磨粗細的經驗分享。'.repeat(3)).status, STATUS.VIOLATION)
        })

        // 規則:standards/docStandards.titleTokens——二字組只在同一段連續漢字內切(CS2 v2;v1 串接全部漢字段後才切,
        //   跨空白之相鄰詞產生標題中不存在之二字組,使「標題詞 ≥4」之門檻被虛增)
        it('titleTokens 不跨越非漢字邊界產生二字組(空白、標點、拉丁字);單字段不成詞;CS2 因而對三個二字詞之標題判不適用', () => {
            assert.deepEqual(titleTokens('台股 動量 策略').cjk, ['台股', '動量', '策略'])
            assert.deepEqual(titleTokens('深度學習：模型壓縮').cjk, ['深度', '度學', '學習', '模型', '型壓', '壓縮'], '全形冒號(NFKC 後為半形)為段界')
            assert.deepEqual(titleTokens('GPU 加速 與 CUDA').cjk, ['加速'], '單字段「與」不成詞;拉丁字為段界')
            assert.deepEqual(titleTokens('量子計算之錯誤更正').cjk.length, 8, '單一段照舊逐字切')
            const body = '海洋生態系統之長期監測與物種分布研究，'.repeat(10)
            const r = checkTitleBody('台股 動量 策略', body)
            assert.deepEqual([r.status, r.detail], [STATUS.NA, '標題詞 3 個(須 ≥4)'], 'v1 會得 5 個詞而判不合格')
            assert.equal(DOC_STANDARDS.find((x) => x.id === 'CS2').v, 2, '判定改變即升版')
        })

        it('CS10 contentKeysOfUrl:各站點正準代稱——MSN ar-ID(限 msn 主機)、arXiv(abs／pdf／版本,不分子網域)、DOI(doi.org 或 /doi/ 路徑,小寫並去 .pdf)、SSRN abstract_id(限 ssrn 主機)', () => {
            assert.deepEqual(contentKeysOfUrl('https://www.msn.com/en-in/money/economy/x/ar-AA29ARZ4'), ['msn:AA29ARZ4'])
            assert.deepEqual(contentKeysOfUrl('https://example.com/ar-AA29ARZ4'), [], 'ar-ID 限 msn 主機')
            for (const u of ['https://arxiv.org/abs/2401.01234', 'https://arxiv.org/pdf/2401.01234v3', 'https://export.arxiv.org/abs/2401.01234v12', 'http://www.arxiv.org/pdf/2401.01234']) {
                assert.deepEqual(contentKeysOfUrl(u), ['arxiv:2401.01234'], u)
            }
            assert.deepEqual(contentKeysOfUrl('https://arxiv.org/abs/math/0301234'), [], '舊式編號不在判準內')
            assert.deepEqual(contentKeysOfUrl('https://doi.org/10.1000/ABC.pdf'), ['doi:10.1000/abc'])
            assert.deepEqual(contentKeysOfUrl('https://journals.example.org/doi/10.1000/ABC'), ['doi:10.1000/abc'])
            assert.deepEqual(contentKeysOfUrl('https://journals.example.org/papers/10.1000/ABC'), [], '非 doi.org 且路徑無 /doi/ 者不是 DOI 網址')
            assert.deepEqual(contentKeysOfUrl('https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1234567'), ['ssrn:1234567'])
            assert.deepEqual(contentKeysOfUrl('https://papers.ssrn.com/sol3/papers.cfm?abstractid=7654321'), ['ssrn:7654321'])
            assert.deepEqual(contentKeysOfUrl('https://example.com/papers.cfm?abstract_id=1234567'), [], 'abstract_id 限 ssrn 主機')
        })

        it('CS10 轉載 slug:路徑末段 ≥5 個字母詞且 ≥30 字才成代稱;去 www.／m.／amp.、副檔名、5 位以上數字尾碼;限同一主機(跨站同 slug 不是同一內容);短 slug 不成代稱', () => {
            const key = 'slug:blog.example.com/how-to-build-a-small-neural-network-from-scratch'
            for (const u of [
                'https://blog.example.com/how-to-build-a-small-neural-network-from-scratch/',
                'https://www.blog.example.com/how-to-build-a-small-neural-network-from-scratch-1234567.html',
                'https://m.blog.example.com/how-to-build-a-small-neural-network-from-scratch',
                'https://amp.blog.example.com/how-to-build-a-small-neural-network-from-scratch?utm_source=x#frag',
            ]) assert.deepEqual(contentKeysOfUrl(u), [key], u)
            assert.notDeepEqual(contentKeysOfUrl('https://other.example.net/how-to-build-a-small-neural-network-from-scratch'), [key], '跨站同 slug 不同代稱')
            assert.deepEqual(contentKeysOfUrl('https://example.com/a-b-c-d-e'), [], '五詞但不足 30 字')
            assert.deepEqual(contentKeysOfUrl('https://example.com/short-slug'), [])
            assert.deepEqual(contentKeysOfUrl('https://example.com/'), [])
        })

        it('contentKeysOfUrl:非網址、空值、非字串回空陣列(不拋)', () => {
            for (const bad of ['not a url', '', null, undefined, 123, {}]) assert.deepEqual(contentKeysOfUrl(bad), [], String(bad))
        })

        // 規則:standards/docStandards.contentKeysOfUrl——路徑含非法百分比編碼(如被截斷之 %E4%B8)時以未解碼之路徑照算代稱;
        //   同一函數供入庫比對、索引建立(全部文件之網址)與符合度掃描共用,拋錯會讓一筆壞網址使索引建立與整輪 CS10 掃描失敗
        it('contentKeysOfUrl 遇路徑含非法百分比編碼不拋錯,以未解碼之路徑照算代稱;duplicateGroups 與符合度掃描不因而中斷', () => {
            for (const u of ['https://example.com/a%E0%A4%A', 'https://example.com/100%/x', 'https://example.com/%zz']) {
                assert.doesNotThrow(() => contentKeysOfUrl(u), u)
                assert.deepEqual(contentKeysOfUrl(u), [], `${u}:無可辨之代稱`)
            }
            assert.deepEqual(contentKeysOfUrl('https://arxiv.org/abs/2401.01234%zz'), ['arxiv:2401.01234'], '代稱照算')
            assert.deepEqual(contentKeysOfUrl('https://blog.example.com/how-to-build-a-small-neural-network-from-scratch%E4%B8'), ['slug:blog.example.com/how-to-build-a-small-neural-network-from-scratch%e4%b8'], 'slug 以字面計')
            const g = duplicateGroups([
                { id: 'a', url: 'https://example.com/100%/x' },
                { id: 'b', url: 'https://arxiv.org/abs/2401.01234' },
                { id: 'c', url: 'https://arxiv.org/pdf/2401.01234v2' },
            ])
            assert.deepEqual(g, [{ key: 'arxiv:2401.01234', ids: ['b', 'c'] }])
        })

        it('duplicateGroups:同代稱 ≥2 份成群(url 與 finalUrl 皆算);各群只列同代稱者;非陣列回空陣列', () => {
            const g = duplicateGroups([
                { id: 'a', url: 'https://arxiv.org/abs/2401.01234' },
                { id: 'b', url: 'https://example.com/x', finalUrl: 'https://arxiv.org/pdf/2401.01234v2' },
                { id: 'c', url: 'https://www.msn.com/en-in/money/x/ar-AA29ARZ4' },
                { id: 'd', url: 'https://example.com/y' },
            ])
            assert.deepEqual(g, [{ key: 'arxiv:2401.01234', ids: ['a', 'b'] }])
            // 轉載 slug 經 duplicateGroups 端對端成群:代稱只取路徑末段,查詢字串不影響;短 slug 不成代稱
            const s = duplicateGroups([
                { id: 'p', url: 'https://blog.example.com/how-to-build-a-small-neural-network-from-scratch/?a=6080' },
                { id: 'q', url: 'https://blog.example.com/how-to-build-a-small-neural-network-from-scratch' },
                { id: 'r', url: 'https://example.com/short-slug' },
            ])
            assert.deepEqual(s, [{ key: 'slug:blog.example.com/how-to-build-a-small-neural-network-from-scratch', ids: ['p', 'q'] }])
            assert.deepEqual(duplicateGroups([{ id: 'a', url: 'https://arxiv.org/abs/2401.01234' }]), [], '單份不成群')
            assert.deepEqual(duplicateGroups(null), [])
            assert.deepEqual(duplicateGroups('x'), [])
            assert.deepEqual(duplicateGroups([{ id: 'a', url: 'https://arxiv.org/abs/2401.01234', finalUrl: 'https://arxiv.org/abs/2401.01234' }]), [], '同一份之 url 與 finalUrl 同代稱不重複計')
        })
    })

    describe('標準全集(standards/registry)之欄位完整性', function() {

        const IDS = ['CS1a', 'CS1b', 'CS1c', 'CS1d', 'CS1e', 'CS2', 'CS3', 'CS4', 'CS5', 'CS6', 'CS7', 'CS8', 'CS9', 'CS10', 'CS11', 'CS12', 'CS13', 'CS14']
        const KEY_ORDER = ['id', 'title', 'object', 'kind', 'v', 'proves', 'notProves', 'enforcedAt', 'scan', 'scanNote']
        const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        // 檔案內宣告該名稱(函數宣告、const／let／var、或 export { … }):以讀檔＋正則驗,不 import
        const declares = (src, name) => [
            new RegExp(`(^|\\n)\\s*(export\\s+)?(async\\s+)?function\\s*\\*?\\s*${esc(name)}\\s*\\(`),
            new RegExp(`(^|\\n)\\s*(export\\s+)?(const|let|var)\\s+${esc(name)}\\s*=`),
            new RegExp(`export\\s*\\{[^}]*\\b${esc(name)}\\b[^}]*\\}`),
        ].some((r) => r.test(src))

        it('標準全集為 CS1a～e、CS2～CS14,id 不重複、依序列出', () => {
            assert.deepEqual(CAPTURE_STANDARDS.map((s) => s.id), IDS)
        })

        it('每條標準之欄位齊全且型別正確、欄序固定(報表與比對之輸出可重現);全集與各列皆凍結', () => {
            assert.ok(Object.isFrozen(CAPTURE_STANDARDS))
            for (const s of CAPTURE_STANDARDS) {
                assert.ok(Object.isFrozen(s) && Object.isFrozen(s.enforcedAt), `${s.id} 凍結`)
                assert.deepEqual(Object.keys(s), KEY_ORDER, `${s.id} 欄序`)
                for (const k of ['id', 'title', 'object', 'proves', 'notProves', 'scanNote']) assert.ok(typeof s[k] === 'string' && s[k].trim().length > 0, `${s.id}.${k} 須為非空字串(能證明／不能證明與不掃之理由皆須寫明)`)
                assert.ok(['program', 'program+ai', 'known-limit'].includes(s.kind), `${s.id}.kind=${s.kind}`)
                assert.ok(Number.isInteger(s.v) && s.v > 0, `${s.id}.v`)
                assert.equal(typeof s.scan, 'boolean', `${s.id}.scan`)
                assert.ok(Array.isArray(s.enforcedAt) && s.enforcedAt.length > 0, `${s.id} 須有執行處`)
            }
        })

        it('kind:CS8 為程式驗契約＋AI 評內容,CS14 為已知限制,其餘為程式判定', () => {
            const kinds = Object.fromEntries(CAPTURE_STANDARDS.map((s) => [s.id, s.kind]))
            assert.equal(kinds.CS8, 'program+ai')
            assert.equal(kinds.CS14, 'known-limit')
            for (const id of IDS.filter((x) => x !== 'CS8' && x !== 'CS14')) assert.equal(kinds[id], 'program', id)
        })

        it('執行處:每條皆為「套件內檔案:函數」且該檔存在、檔內宣告該函數(讀檔＋正則驗);路徑相對原始碼夾(src/)、不含 ..、不重複', () => {
            let n = 0
            for (const s of CAPTURE_STANDARDS) {
                assert.equal(new Set(s.enforcedAt).size, s.enforcedAt.length, `${s.id} 執行處不重複`)
                for (const ref of s.enforcedAt) {
                    n++
                    const m = /^([A-Za-z0-9_./-]+\.mjs):([A-Za-z_$][\w$]*)$/.exec(ref)
                    assert.ok(m, `${s.id} 執行處格式「檔案:函數」:${ref}`)
                    const [, file, name] = m
                    assert.ok(!file.split('/').includes('..') && !path.isAbsolute(file), `${ref} 須為相對原始碼夾(src/)之路徑`)
                    const abs = path.join(PKG, 'src', file)
                    assert.ok(fs.existsSync(abs), `${s.id} 執行處之檔不存在:${ref}`)
                    assert.ok(declares(fs.readFileSync(abs, 'utf8'), name), `${s.id} 執行處之函數未宣告於檔內:${ref}`)
                }
            }
            assert.ok(n >= CAPTURE_STANDARDS.length, '走訪須真涵蓋各執行處')
            // 對照:宣告檢查須真能分辨有無(否則上列恆過)
            assert.equal(declares('function foo() {}', 'foo'), true)
            assert.equal(declares('// function foo() {}', 'foo'), false, '註解中之宣告不算')
            assert.equal(declares('const x = 1', 'foo'), false)
        })

        it('版本單一來源:文件標準(CS1a、CS2、CS10、CS12)之標題與版本取自 DOC_STANDARDS,其餘為 1', () => {
            for (const s of CAPTURE_STANDARDS) {
                const d = DOC_STANDARDS.find((x) => x.id === s.id)
                if (d) assert.deepEqual([s.title, s.v], [d.title, d.v], s.id)
                else assert.equal(s.v, 1, `${s.id} 非文件標準版本為 1`)
            }
        })

        it('CS8 標題之契約數字取自 AREA_CONTRACT(提示詞、驗證與標題同讀一份)', () => {
            const t = CAPTURE_STANDARDS.find((s) => s.id === 'CS8').title
            for (const n of [AREA_CONTRACT.labelMin, AREA_CONTRACT.labelMax, AREA_CONTRACT.queryMinWords, AREA_CONTRACT.queryMaxWords]) assert.ok(t.includes(String(n)), `標題含 ${n}:${t}`)
        })

        it('掃描旗標與掃描器一致:scan 為 true 者即 AUDITED_STANDARD_IDS(依全集之序),文件標準(CS1a、CS2、CS10、CS12)皆在其內;掃描報告之鍵與標題、kind、版本取自全集', async () => {
            assert.deepEqual(AUDITED_STANDARD_IDS, CAPTURE_STANDARDS.filter((s) => s.scan).map((s) => s.id))
            for (const id of DOC_STANDARDS.map((s) => s.id)) assert.ok(AUDITED_STANDARD_IDS.includes(id), `文件標準 ${id} 須可掃描`)
            assert.ok(Object.isFrozen(AUDITED_STANDARD_IDS))
            const rep = await audit({}, undefined)
            assert.deepEqual(Object.keys(rep.standards), [...AUDITED_STANDARD_IDS])
            for (const [id, b] of Object.entries(rep.standards)) {
                const s = CAPTURE_STANDARDS.find((x) => x.id === id)
                assert.deepEqual([b.id, b.title, b.kind, b.v, b.object, b.module], [s.id, s.title, s.kind, s.v, s.object, 'capture'], id)
            }
        })

    })

    describe('符合度掃描(standards/audit)', function() {

        // 表覆蓋:各標準之掃描案例區塊於其 before 登記;最後一個區塊核對「可掃描標準 = 案例區塊已執行者」(新增可掃描標準即須補案例)
        const covered = new Set()

        after(function() {
            // 本 after 於全部案例區塊之後執行:區塊被跳過(describe.skip)即未登記
            assert.deepEqual([...covered].sort(), [...AUDITED_STANDARD_IDS].sort(), '每條可掃描標準皆須有執行過之掃描案例區塊')
        })

        const wellFormed = (b) => {
            assert.equal(b.total, b.pass + b.violation + b.undetermined + b.na + b.waived, `${b.id}:每筆判定恰歸一態(total＝四態＋豁免)`)
            assert.equal(b.violations.length, b.violation)
            assert.equal(b.undetermineds.length, b.undetermined)
            assert.equal(b.waiveds.length, b.waived)
        }

        describe('CS1a 健全閘(raw 存量依現版閘重判)', function() {

            before(() => covered.add('CS1a'))

            const raw = (id, o) => ({ id, status: 'raw', title: `標題 ${id}`, url: `https://x.example/${id}`, textFrom: 'article', text: HEALTHY, ...o })
            const one = async (o, deps2, opt) => {
                const rep = await audit({ docs: [raw('r', o)] }, ['CS1a'], deps2, opt)
                const b = rep.standards.CS1a
                wellFormed(b)
                return b
            }

            it('合格:article 入口之健全正文;不合格之各類(過短、佔位頁、付費牆、亂碼、格式雜訊、頁面自述找不到、轉址至首頁之軟 404)逐類列出', async () => {
                const ok = await one({})
                assert.deepEqual([ok.pass, ok.violation, ok.total], [1, 0, 1])
                const cases = [
                    ['too-short', { text: '短' }, /^too-short（正文 1 字，低於 300）$/],
                    ['placeholder', { text: 'Please enable JavaScript to view this page. '.repeat(10) }, /^placeholder（/],
                    ['paywall', { text: 'Subscribe now to continue reading the full story. '.repeat(10) }, /^paywall（/],
                    ['mojibake', { text: `${'�'.repeat(30)}${'a'.repeat(400)}` }, /^mojibake（亂碼 30 個/],
                    ['format-noise', { text: `<?xml version="1.0"?><rss>${'x'.repeat(400)}</rss>` }, /^format-noise（/],
                    ['not-found', { title: 'Page not found', text: `${HEALTHY}` }, /^not-found（/],
                    ['soft-404', { url: 'https://e.example/news/1', finalUrl: 'https://www.e.example/' }, /^soft-404（轉址至站台首頁/],
                ]
                for (const [kind, o, re] of cases) {
                    const b = await one(o)
                    assert.deepEqual([b.violation, b.pass], [1, 0], kind)
                    assert.match(b.violations[0].detail, re, kind)
                    assert.equal(b.violations[0].id, 'r')
                }
            })

            it('依入口套判準:adapter 豁免佔位／付費牆字樣(來源已知)但仍檢過短;feed 退路以 minFallbackChars 為門檻;grid 摘要以 250 字為門檻;明示豁免者不適用', async () => {
                const paywalled = 'Subscribe now to continue reading the full story. '.repeat(10)
                assert.equal((await one({ textFrom: 'adapter:site', text: paywalled })).pass, 1, 'adapter 正文不套付費牆字樣')
                assert.equal((await one({ textFrom: 'article', text: paywalled })).violation, 1, '對照:同一正文走 article 入口即不合格')
                assert.match((await one({ textFrom: 'adapter:site', text: '短' })).violations[0].detail, /^too-short/)
                const feed250 = 'f'.repeat(250)
                assert.equal((await one({ textFrom: 'feed', text: feed250 })).violation, 1, 'feed 250 字 < 預設 300')
                assert.equal((await one({ textFrom: 'feed', text: feed250 }, { settings: settingsOf({ standards: { minFallbackChars: 100 } }) })).pass, 1, '閘取 deps.settings.capture.standards:門檻 minFallbackChars 改 100 即合格')
                assert.equal((await one({ textFrom: 'abstract', text: 'g'.repeat(260) })).pass, 1, 'grid 摘要 ≥250 字')
                assert.match((await one({ textFrom: 'abstract', text: 'g'.repeat(100) })).violations[0].detail, /^too-short（摘要 100 字，低於 250）/)
                const ex = await one({ gateExempt: true, text: '短' })
                assert.deepEqual([ex.na, ex.violation, ex.pass], [1, 0, 0], '抓取器明示豁免(gateExempt)→ 不適用')
                assert.equal(ex.total, 1)
            })

            it('未能判定(不報合格也不報為零):入口不明、庫內無原文;記入 undetermineds 並附原因', async () => {
                const noEntry = await one({ textFrom: '' })
                assert.deepEqual([noEntry.undetermined, noEntry.pass], [1, 0])
                assert.equal(noEntry.undetermineds[0].detail, '入口不明（textFrom「」）')
                assert.equal((await one({ textFrom: 'weird' })).undetermineds[0].detail, '入口不明（textFrom「weird」）')
                const empty = await one({ text: '' })
                assert.equal(empty.undetermined, 1)
                assert.equal(empty.undetermineds[0].detail, '庫內無原文')
                assert.equal((await one({ text: '   \n ' })).undetermined, 1, '全空白亦無原文')
            })

            it('長度條件以落庫時記之原長(fullLength)判:庫內正文已截斷時不誤判過短;未記原長則以庫內長度判', async () => {
                const short = HEALTHY.slice(0, 200)
                assert.equal((await one({ text: short })).violation, 1)
                assert.equal((await one({ text: short, fullLength: 5000 })).pass, 1)
            })

            it('閘參數取自 deps.settings.capture.standards(minTextChars 改大即由合格轉不合格);未給 settings 用套件預設;給了 settings 而缺 capture.standards 組亦用套件預設(不拋)', async () => {
                const t = HEALTHY.slice(0, 400)
                assert.equal((await one({ text: t })).pass, 1)
                const strict = await one({ text: t }, { settings: settingsOf({ standards: { minTextChars: 500 } }) })
                assert.equal(strict.violation, 1)
                assert.match(strict.violations[0].detail, /低於 500/)
                assert.equal((await one({ text: t }, { settings: { capture: {} } })).pass, 1, '缺 standards 組 → 套件預設(300)')
                // 閘參數只讀 capture.standards:放在 capture 頂層之同名鍵不被讀(改大無效)
                assert.equal((await one({ text: t }, { settings: { capture: { minTextChars: 500 } } })).pass, 1, 'settings.capture.minTextChars 不在 capture.standards 內,不被讀')
            })

            it('只掃 raw:new、noted、skip、dead 之文件不在 CS1a 範圍;counts 之 docsRaw 計 raw 數', async () => {
                const docs = [raw('r1'), raw('r2', { text: '短' }), { id: 'n1', status: 'new' }, { id: 'o1', status: 'noted', text: '短' }, { id: 's1', status: 'skip' }, { id: 'd1', status: 'dead' }]
                const rep = await audit({ docs }, ['CS1a'])
                assert.deepEqual([rep.standards.CS1a.total, rep.standards.CS1a.pass, rep.standards.CS1a.violation], [2, 1, 1])
                assert.equal(rep.counts.docsRaw, 2)
                assert.equal(rep.counts.docsNoted, 1)
            })
        })

        describe('CS2 記錄標題對庫內正文(錯頁)', function() {

            before(() => covered.add('CS2'))

            const EN = 'Momentum strategies in Taiwan equities earn excess returns after costs. '.repeat(10)
            const raw = (id, title, text) => ({ id, status: 'raw', title, text, textFrom: 'article', url: `https://x.example/${id}` })

            it('合格、不合格、不適用各一:覆蓋 >0 合格;覆蓋 =0 不合格並列詳情;標題詞不足或文字系統不同不適用', async () => {
                const rep = await audit({ docs: [
                    raw('ok', 'Momentum strategies Taiwan equities excess', EN),
                    raw('bad', 'Chocolate recipes wedding cakes baking guide', EN),
                    raw('few', 'Short title', EN),
                    raw('cross', 'Momentum strategies Taiwan equities excess', '台股動量策略之超額報酬'.repeat(10)),
                ] }, ['CS2'])
                const b = rep.standards.CS2
                wellFormed(b)
                assert.deepEqual([b.pass, b.violation, b.na, b.undetermined, b.total], [1, 1, 2, 0, 4])
                assert.deepEqual(b.violations, [{ id: 'bad', detail: '標題詞 6 個皆不見於正文' }])
            })

            it('只判 raw 之記錄標題對其庫內正文;noted 文件不在範圍;與 CS1a 同掃時各自獨立計', async () => {
                const docs = [raw('bad', 'Chocolate recipes wedding cakes baking guide', EN), { id: 'n', status: 'noted', title: 'Chocolate recipes wedding cakes baking guide', text: EN, url: 'https://x.example/n' }]
                const rep = await audit({ docs }, ['CS2', 'CS1a'])
                assert.equal(rep.standards.CS2.total, 1)
                assert.equal(rep.standards.CS2.violation, 1)
                assert.equal(rep.standards.CS1a.total, 1, 'CS1a 同一份 raw 另計')
            })
        })

        describe('CS10 同一內容只入庫一次(noted 存量)', function() {

            before(() => covered.add('CS10'))

            const noted = (id, o = {}) => ({ id, status: 'noted', notedAt: '2026-10-01T00:00:00Z', url: `https://${id}.example.net/p`, ...o })
            const TEXT = [P('甲'), P('乙'), P('丙'), P('丁')].join('\n')

            it('網址代稱群:同一代稱之文件成群,群 id 以 GROUP_ID_SEP 串接、詳情含份數與代稱;群外文件合格', async () => {
                assert.equal(GROUP_ID_SEP, '＋')
                const rep = await audit({ docs: [
                    noted('a', { url: 'https://arxiv.org/abs/2401.01234', paraKeys: [] }),
                    noted('b', { url: 'https://arxiv.org/pdf/2401.01234v2', paraKeys: [] }),
                    noted('c', { url: 'https://www.msn.com/en-in/money/x/ar-AA29ARZ4', paraKeys: [] }),
                    noted('d', { url: 'https://www.msn.com/en-in/news/y/ar-AA29ARZ4', paraKeys: [] }),
                    noted('e', { url: 'https://example.com/lone', paraKeys: [] }),
                ] }, ['CS10'])
                const b = rep.standards.CS10
                wellFormed(b)
                assert.deepEqual(b.violations, [{ id: 'a＋b', detail: '同一內容 2 份（arxiv:2401.01234）' }, { id: 'c＋d', detail: '同一內容 2 份（msn:AA29ARZ4）' }])
                assert.deepEqual([b.violation, b.pass, b.total], [2, 1, 3], '群為判定單位:兩群各記一筆不合格、群外之 e 合格;群內之 a b c d 不另計')
            })

            it('三份同代稱成一群(份數 3,id 依文件序串接)', async () => {
                const rep = await audit({ docs: ['a', 'b', 'c'].map((id, i) => noted(id, { url: `https://arxiv.org/abs/2401.01234${i ? `v${i}` : ''}`, paraKeys: [] })) }, ['CS10'])
                assert.deepEqual(rep.standards.CS10.violations, [{ id: 'a＋b＋c', detail: '同一內容 3 份（arxiv:2401.01234）' }])
            })

            it('段落雜湊重疊:共享段數 ≥3 且 ≥ 後入庫文件段數之一半 → 同一內容;群 id 依 notedAt 先後(先者在前);不足門檻不成群', async () => {
                const k = (p, n) => Array.from({ length: n }, (_, i) => `${p}${i}`)
                // 集合內之順序與入庫先後相反(d、b、c、a):掃描須自行依 notedAt 排序,不依集合順序
                const rep = await audit({ docs: [
                    noted('d', { notedAt: '2026-10-04', paraKeys: [...k('d', 6)] }),
                    noted('b', { notedAt: '2026-10-02', paraKeys: [...k('s', 3), ...k('b', 3)] }), // 與 a 共享 3／6 → 成群
                    noted('c', { notedAt: '2026-10-03', paraKeys: [...k('s', 2), ...k('c', 4)] }), // 與 a 只共享 2 → 不成群
                    noted('a', { notedAt: '2026-10-01', paraKeys: k('s', 6) }),
                ] }, ['CS10'])
                const b = rep.standards.CS10
                wellFormed(b)
                assert.deepEqual(ids(b.violations), ['a＋b'])
                assert.match(b.violations[0].detail, /^同一內容 2 份（para:3）$/)
                assert.deepEqual([b.violation, b.pass], [1, 2], 'c、d 合格')
            })

            it('notedAt 相同者依 id 定序(輸出可重現,不依集合順序):群 id 先小後大', async () => {
                const k = (p, n) => Array.from({ length: n }, (_, i) => `${p}${i}`)
                const rep = await audit({ docs: [
                    noted('z', { notedAt: '2026-10-01', paraKeys: k('s', 6) }),
                    noted('y', { notedAt: '2026-10-01', paraKeys: k('s', 6) }),
                ] }, ['CS10'])
                assert.deepEqual(ids(rep.standards.CS10.violations), ['y＋z'])
            })

            it('無段落雜湊者以原文(docs 或 docTexts 另存)當場補算並參與比對;兩處皆無 → 未能判定(不報合格);paraKeys 為空陣列(已算而無足長段落)→ 合格', async () => {
                const rep = await audit({
                    docs: [
                        noted('a', { notedAt: '2026-10-01', paraKeys: paraKeysOf(TEXT) }),
                        noted('b', { notedAt: '2026-10-02', text: '' }), // 原文在 docTexts → 補算 → 與 a 重疊
                        noted('c', { notedAt: '2026-10-03', text: [P('子'), P('丑'), P('寅')].join('\n') }), // docs 有原文 → 補算、不重疊
                        noted('d', { notedAt: '2026-10-04', text: '' }), // 皆無原文
                        noted('e', { notedAt: '2026-10-05', paraKeys: [] }),
                    ],
                    docTexts: [{ id: 'b', gz: packText(TEXT), feedGz: '', sha1: 'h' }],
                }, ['CS10'])
                const b = rep.standards.CS10
                wellFormed(b)
                assert.deepEqual(b.violations, [{ id: 'a＋b', detail: '同一內容 2 份（para:4）' }])
                assert.deepEqual(b.undetermineds, [{ id: 'd', detail: '無段落雜湊且原文不可得（docs 與 docTexts 皆無），段落重疊無從比對' }])
                assert.equal(b.pass, 2, 'c(補算、不重疊)、e(已算而無足長段落)')
            })

            it('material:false 不讀另存原文:資料同預設模式案(a～e)——僅 docTexts 有原文者(b)與 docs、docTexts 皆無原文者(d)皆轉為未能判定(附「未讀原文（material:false）」之說明);docs 內有原文者(c)仍補算、已有段落雜湊者(a、e)照常;不因此報合格或不合格', async () => {
                const docs = [
                    noted('a', { notedAt: '2026-10-01', paraKeys: paraKeysOf(TEXT) }),
                    noted('b', { notedAt: '2026-10-02', text: '' }), // 原文只在 docTexts:不讀 → 無從比對(預設模式下補算後與 a 重疊成群)
                    noted('c', { notedAt: '2026-10-03', text: [P('子'), P('丑'), P('寅')].join('\n') }), // docs 有原文 → 仍補算、不重疊
                    noted('d', { notedAt: '2026-10-04', text: '' }), // docs 與 docTexts 皆無原文(預設模式下記「原文不可得」)
                    noted('e', { notedAt: '2026-10-05', paraKeys: [] }), // 已算而無足長段落 → 合格
                ]
                const rep = await audit({ docs, docTexts: [{ id: 'b', gz: packText(TEXT), feedGz: '', sha1: 'h' }] }, ['CS10'], {}, { material: false })
                const b = rep.standards.CS10
                wellFormed(b)
                // 規則:standards/audit 之 CS10——material:false 時無段落雜湊且 docs 無原文者一律記未能判定(不讀 docTexts,故 b 不與 a 成群、無不合格)
                assert.deepEqual([b.violation, ids(b.undetermineds), b.pass], [0, ['b', 'd'], 3], 'a、c、e 合格;b、d 未能判定;無不合格(b 未與 a 比對)')
                for (const id of ['b', 'd']) {
                    const detail = b.undetermineds.find((x) => x.id === id).detail
                    assert.equal(detail, '無段落雜湊且未讀原文（material:false），段落重疊無從比對', `${id} 之說明`)
                    assert.match(detail, /未讀原文（material:false）/)
                    assert.doesNotMatch(detail, /原文不可得/, `${id}:未讀材料不得說成「原文不可得」(預設模式之說法)`)
                }
            })

            it('只掃 noted:skip(含重複件)、raw、dead 之文件不參與(處置後之重複件不再被報)', async () => {
                const rep = await audit({ docs: [
                    noted('a', { url: 'https://arxiv.org/abs/2401.01234', paraKeys: [] }),
                    { id: 'b', status: 'skip', skipKind: 'duplicate', url: 'https://arxiv.org/pdf/2401.01234', dupOf: 'a' },
                    { id: 'c', status: 'raw', url: 'https://arxiv.org/abs/2401.01234v2' },
                    { id: 'd', status: 'dead', url: 'https://arxiv.org/abs/2401.01234v3' },
                ] }, ['CS10'])
                assert.deepEqual([rep.standards.CS10.total, rep.standards.CS10.violation, rep.standards.CS10.pass], [1, 0, 1])
            })

            it('段落重疊不具傳遞性:甲乙重疊、乙丙重疊(甲丙無共同段落)記為兩個配對群 a＋b、b＋c,而非併成一群', async () => {
                const k = (p, n) => Array.from({ length: n }, (_, i) => `${p}${i}`)
                const rep = await audit({ docs: [
                    noted('a', { notedAt: '2026-10-01', paraKeys: k('a', 6) }),
                    noted('b', { notedAt: '2026-10-02', paraKeys: [...k('a', 3), ...k('b', 3)] }),
                    noted('c', { notedAt: '2026-10-03', paraKeys: [...k('b', 3), ...k('c', 3)] }),
                ] }, ['CS10'])
                assert.deepEqual(ids(rep.standards.CS10.violations), ['a＋b', 'b＋c'])
                assert.equal(rep.standards.CS10.pass, 0)
            })
        })

        describe('CS12 領域標籤與線索值正體', function() {

            before(() => covered.add('CS12'))

            it('領域標籤:簡體專用字、同形字誤用、誤用詞皆不合格;正體與純 ASCII 標籤合格;無標籤之領域不計', async () => {
                const rep = await audit({ areas: [
                    { id: 'a1', label: '加密貨幣市場微結構' },
                    { id: 'a2', label: '加密货币市场微结构' },
                    { id: 'a3', label: '圖神經網路 graph learning' },
                    { id: 'a4', label: '由于資料稀疏之方法' },
                    { id: 'a5' },
                    { id: 'a6', label: '' },
                ] }, ['CS12'])
                const b = rep.standards.CS12
                wellFormed(b)
                assert.deepEqual([b.pass, b.violation, b.total], [2, 2, 4])
                assert.deepEqual(b.violations, [{ id: 'a2', detail: '領域標籤「加密货币市场微结构」' }, { id: 'a4', detail: '領域標籤「由于資料稀疏之方法」' }])
                assert.equal(rep.counts.areas, 6, 'counts 計全部領域')
            })

            it('線索值:只掃 pending 之含漢字者;網址(連同其簡體字)不計;done／failed／evicted 與無漢字之值不在範圍', async () => {
                const rep = await audit({ frontier: [
                    { id: 'c1', status: 'pending', type: 'keyword', value: '圖神經網路' },
                    { id: 'c2', status: 'pending', type: 'keyword', value: '图神经网络' },
                    { id: 'c3', status: 'pending', type: 'topic', value: 'graph learning' }, // 無漢字:不判
                    { id: 'c4', status: 'pending', type: 'site', value: 'https://example.com/数据' }, // 網址:漢字僅在網址內 → 去除後合格
                    { id: 'c5', status: 'done', type: 'keyword', value: '图神经网络' }, // 非 pending:不掃
                    { id: 'c6', status: 'failed', type: 'keyword', value: '图神经网络' },
                    { id: 'c7', status: 'evicted', type: 'keyword', value: '图神经网络' },
                    { id: 'c8', status: 'pending', type: 'keyword', value: '基于数据' },
                ] }, ['CS12'])
                const b = rep.standards.CS12
                wellFormed(b)
                assert.deepEqual(b.violations, [{ id: 'c2', detail: '線索「图神经网络」' }, { id: 'c8', detail: '線索「基于数据」' }])
                assert.deepEqual([b.pass, b.total], [2, 4], 'c1 與 c4 合格')
                assert.deepEqual([rep.counts.frontierPending, rep.counts.frontier], [5, 8])
            })
        })

        describe('CS5 來源健康(啟用中之來源不得已達零產出停用條件)', function() {

            before(() => covered.add('CS5'))

            const src = (id, o) => ({ id, name: id, enabled: true, judged: 0, yielded: 0, ...o })

            it('已記統計達零產出條件(已判定 ≥6 篇、產出 0)而仍啟用 → 不合格;樣本不足或有產出 → 合格;已停用 → 不適用', async () => {
                const rep = await audit({ sources: [
                    src('s1', { judged: 6, yielded: 0 }),
                    src('s2', { judged: 5, yielded: 0 }),
                    src('s3', { judged: 10, yielded: 1 }),
                    src('s4', { judged: 20, yielded: 0, enabled: false }),
                    src('s5'),
                    src('s6', { judged: undefined, yielded: undefined }),
                ] }, ['CS5'])
                const b = rep.standards.CS5
                wellFormed(b)
                assert.deepEqual(b.violations, [{ id: 's1', detail: '已判定 6 篇、產出 0 而仍啟用' }])
                assert.deepEqual([b.pass, b.na, b.violation, b.total], [4, 1, 1, 6])
                assert.equal(rep.counts.sources, 6)
            })

            it('門檻取自 deps.settings.capture.sources.cullMinJudged(與淘汰同一判定):調為 3 即 3 篇亦不合格;調為 20 即 6 篇合格', async () => {
                const o = { sources: [src('s1', { judged: 6, yielded: 0 })] }
                assert.equal((await audit(o, ['CS5'], { settings: settingsOf({ sources: { cullMinJudged: 3 } }) })).standards.CS5.violation, 1)
                assert.equal((await audit(o, ['CS5'], { settings: settingsOf({ sources: { cullMinJudged: 20 } }) })).standards.CS5.violation, 0)
                assert.equal((await audit({ sources: [src('s1', { judged: 3, yielded: 0 })] }, ['CS5'], { settings: settingsOf({ sources: { cullMinJudged: 3 } }) })).standards.CS5.violation, 1)
                // 門檻只讀 capture.sources.cullMinJudged:未給該組時用預設門檻 6;同名鍵放在其他層級不被讀
                assert.equal((await audit(o, ['CS5'], { settings: { capture: {} } })).standards.CS5.violation, 1, '未給 capture.sources:預設門檻 6')
                assert.equal((await audit(o, ['CS5'], { settings: { sources: { cullMinJudged: 20 } } })).standards.CS5.violation, 1, '同名鍵不在 capture.sources 內即不被讀')
            })

            it('連敗／連空與寫入同一判定(sourceStopReasonOf;門檻取 capture.sources.maxConsecFails／maxConsecEmpty、自動來源取 isAutoSource):已記 failCount 達門檻而仍啟用 → 不合格;自動來源連空達門檻而仍啟用 → 不合格;種子來源連空不判;maxConsecFails 0 不判連敗', async () => {
                // 規則:standards/registry CS5 scanNote、audit 檔頭【CS5 以已記之統計判】
                const auto = (x) => x.origin === 'auto'
                const rep = await audit({ sources: [
                    src('f8', { failCount: 8 }),
                    src('f7', { failCount: 7 }),
                    src('e5', { emptyCount: 5, origin: 'auto' }),
                    src('seed5', { emptyCount: 5, origin: 'seed' }),
                ] }, ['CS5'], { settings: settingsOf({ sources: { maxConsecFails: 8, maxConsecEmpty: 5, isAutoSource: auto } }) })
                const b = rep.standards.CS5
                assert.deepEqual(b.violations, [{ id: 'f8', detail: '已達停用條件（連續失敗 8 次）而仍啟用' }, { id: 'e5', detail: '已達停用條件（連續 5 次無資料）而仍啟用' }])
                assert.deepEqual([b.pass, b.violation, b.total], [2, 2, 4])
                assert.equal((await audit({ sources: [src('f9', { failCount: 9 })] }, ['CS5'], { settings: settingsOf({ sources: { maxConsecFails: 0 } }) })).standards.CS5.violation, 0, '0＝永不因連敗停用')
                assert.equal((await audit({ sources: [src('e9', { emptyCount: 9, origin: 'auto' })] }, ['CS5'], { settings: { capture: {} } })).standards.CS5.violation, 0, '未給 capture.sources 即無 isAutoSource,不判連空')
                assert.equal((await audit({ sources: [src('f8', { failCount: 8 })] }, ['CS5'], { settings: { capture: {} } })).standards.CS5.violation, 1, '連敗門檻之預設 8')
            })

            it('記錄形狀(sourceRecordProblems):全部記錄(含已停用)之時刻欄、計數欄、布林欄、原因欄給了即須合形狀 → 不合格(附欄位);停用者形狀合格即不適用;未給之欄不判', async () => {
                const rep = await audit({ sources: [
                    src('bad-time', { enabled: false, disabledAt: 'yesterday' }),
                    src('bad-count', { failCount: -1 }),
                    src('manual', { enabled: false }),
                    src('ok', { lastFetchAt: '2026-10-01T00:00:00+08:00', okCount: 3 }),
                ] }, ['CS5'])
                const b = rep.standards.CS5
                assert.deepEqual(b.violations, [{ id: 'bad-time', detail: '記錄形狀：disabledAt 非時刻字串' }, { id: 'bad-count', detail: '記錄形狀：failCount 非非負整數' }])
                assert.deepEqual([b.pass, b.na, b.violation, b.total], [1, 1, 2, 4])
            })

            it('判定函數拋錯 → 未能判定(附原因),不報合格也不外拋;無 id 之記錄略過', async () => {
                const bad = new Proxy({ id: 'boom', enabled: true, judged: 1, yielded: 0 }, {
                    get(t, k) {
                        if (k === 'judged') throw new Error('讀取失敗')
                        return t[k]
                    },
                })
                const sources = { select: async () => [bad, { name: '無 id', enabled: true, judged: 9, yielded: 0 }, src('ok')], patch: async () => {}, get: async () => null }
                const rep = await auditCaptureStandards({ stores: { ...stores_(), sources } }, { only: ['CS5'] })
                const b = rep.standards.CS5
                assert.deepEqual([b.undetermined, b.pass, b.total], [1, 1, 2])
                assert.equal(b.undetermineds[0].id, 'boom')
                assert.match(b.undetermineds[0].detail, /^判定拋錯：讀取失敗/)
            })
        })

        describe('CS9 線索格式(寫入時同一函數重驗,唯讀)', function() {

            before(() => covered.add('CS9'))

            const clue = (id, type, value, status = 'pending') => ({ id, type, value, status })

            it('型別在清單、值非空、不逾長度上限、site 為 http(s) 網址 → 合格;各違反逐因列出', async () => {
                const rep = await audit({ frontier: [
                    clue('k1', 'keyword', '圖神經網路'),
                    clue('k2', 'topic', 'graph learning'),
                    clue('k3', 'site', 'https://example.com/a'),
                    clue('k4', 'Keyword', ' padded '),
                    clue('b1', 'foo', 'x'),
                    clue('b2', 'keyword', '   '),
                    clue('b3', 'keyword', 'x'.repeat(121)),
                    clue('b4', 'site', 'ftp://example.com/a'),
                    clue('b5', 'site', 'example.com'),
                    { id: 'b6', type: 'keyword', value: undefined },
                ] }, ['CS9'])
                const b = rep.standards.CS9
                wellFormed(b)
                assert.deepEqual([b.pass, b.violation, b.total], [4, 6, 10])
                const why = Object.fromEntries(b.violations.map((v) => [v.id, v.detail]))
                assert.equal(why.b1, '線索「x」（foo）：型別不在清單')
                assert.equal(why.b2, '線索「」（keyword）：值空')
                assert.match(why.b3, /（keyword）：值過長$/)
                assert.equal(why.b4, '線索「ftp://example.com/a」（site）：網址格式不合')
                assert.equal(why.b5, '線索「example.com」（site）：網址格式不合')
                assert.equal(why.b6, '線索「」（keyword）：值空')
            })

            it('範圍為全部線索(任一狀態,已完成與已淘汰者仍供領域發現取候選);與 CS12 只掃 pending 不同', async () => {
                const rep = await audit({ frontier: [clue('d1', 'foo', 'x', 'done'), clue('f1', 'foo', 'x', 'failed'), clue('e1', 'foo', 'x', 'evicted'), clue('p1', 'foo', 'x', 'pending')] }, ['CS9', 'CS12'])
                assert.equal(rep.standards.CS9.violation, 4)
                assert.equal(rep.standards.CS12.total, 0, '無漢字之值 CS12 不計')
            })

            it('判定函數拋錯 → 未能判定(附原因),不報合格也不外拋;其餘線索照常判定', async () => {
                const bad = { id: 'x1', type: 'keyword', status: 'pending', value: { toString() {
                    throw new Error('壞值')
                } } }
                const rep = await audit({ frontier: [bad, clue('ok1', 'keyword', 'a b'), clue('b1', 'foo', 'x')] }, ['CS9'])
                const b = rep.standards.CS9
                wellFormed(b)
                assert.deepEqual([b.undetermined, b.pass, b.violation, b.total], [1, 1, 1, 3])
                assert.deepEqual(b.undetermineds, [{ id: 'x1', detail: '判定拋錯：壞值' }])
            })

            it('型別清單由 opt.clueTypes 傳入(與寫入者同一設定,未給用寫入之預設 keyword／topic／site);給了而非陣列 → 立即拋錯', async () => {
                const o = { frontier: [clue('k1', 'keyword', 'a b'), clue('t1', 'topic', 'c d'), clue('s1', 'site', 'https://example.com/')] }
                assert.equal((await audit(o, ['CS9'])).standards.CS9.violation, 0)
                const only = (await audit(o, ['CS9'], {}, { clueTypes: ['keyword'] })).standards.CS9
                assert.deepEqual(ids(only.violations), ['t1', 's1'])
                await assert.rejects(() => audit(o, ['CS9'], {}, { clueTypes: 'keyword' }), /clueTypes 須為字串陣列/)
            })

            it('無 id 之記錄略過;重驗以唯讀替身呼叫寫入端之判定,線索集合內容不變(判定函數之 insertNew 未落地)', async () => {
                const frontier = memStore([clue('k1', 'foo', 'x'), { type: 'foo', value: 'noid', status: 'pending' }])
                const before = JSON.stringify(frontier._dump())
                const rep = await auditCaptureStandards({ stores: { ...stores_(), frontier } }, { only: ['CS9'] })
                assert.deepEqual([rep.standards.CS9.total, rep.standards.CS9.violation], [1, 1])
                assert.equal(JSON.stringify(frontier._dump()), before)
            })
        })

        describe('唯讀、豁免、選項與計數', function() {

            // 各集合之寫入計數(patch、insertNew、replace、del 任一被呼叫即記一次)
            const spied = (o = {}) => {
                const writes = []
                const wrap = (store, name) => new Proxy(store, {
                    get(t, k) {
                        if (['patch', 'insertNew', 'replace', 'del'].includes(k)) {
                            return (...a) => {
                                writes.push(`${name}.${k}`)
                                return t[k](...a)
                            }
                        }
                        return t[k]
                    },
                })
                const base = stores({ ...o, holds: o.holds || [] })
                const out = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, wrap(v, k)]))
                return { stores: out, writes, raw: base }
            }
            const MIXED = () => ({
                docs: [
                    { id: 'r1', status: 'raw', textFrom: 'article', title: 'Chocolate recipes wedding cakes baking guide', text: 'x'.repeat(400), url: 'https://x.example/r1' },
                    { id: 'a', status: 'noted', url: 'https://arxiv.org/abs/2401.01234', notedAt: '2026-10-01' },
                    { id: 'b', status: 'noted', url: 'https://arxiv.org/pdf/2401.01234', notedAt: '2026-10-02', text: 'y'.repeat(100) },
                ],
                sources: [{ id: 's1', enabled: true, judged: 9, yielded: 0 }],
                frontier: [{ id: 'c1', status: 'pending', type: 'foo', value: '图神经网络' }],
                areas: [{ id: 'ar1', label: '加密货币' }],
            })

            it('唯讀:全部標準皆掃(含 CS5 與 CS9 之判定函數)後,各集合寫入次數為 0、內容逐筆不變', async () => {
                const { stores: st, writes, raw } = spied(MIXED())
                const before = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, JSON.stringify(v._dump())]))
                const rep = await auditCaptureStandards({ stores: st })
                assert.ok(Object.values(rep.standards).some((b) => b.violation > 0), '前提:掃描確有違反(判定函數確實被呼叫)')
                assert.deepEqual(writes, [])
                for (const [k, v] of Object.entries(raw)) assert.equal(JSON.stringify(v._dump()), before[k], `${k} 內容不變`)
            })

            it('回報形狀:counts 六項與逐標準總量、四態、豁免、完整 id 清單;每筆判定恰歸一態', async () => {
                const rep = await auditCaptureStandards({ stores: stores(MIXED()) })
                assert.deepEqual(Object.keys(rep), ['counts', 'standards'])
                assert.deepEqual(rep.counts, { docsRaw: 1, docsNoted: 2, areas: 1, frontierPending: 1, frontier: 1, sources: 1 })
                assert.deepEqual(Object.keys(rep.standards), [...AUDITED_STANDARD_IDS])
                for (const b of Object.values(rep.standards)) {
                    wellFormed(b)
                    assert.deepEqual(Object.keys(b), ['id', 'title', 'kind', 'v', 'module', 'object', 'total', 'pass', 'violation', 'undetermined', 'na', 'waived', 'violations', 'undetermineds', 'waiveds'])
                }
                assert.equal(rep.standards.CS10.violation, 1)
                assert.equal(rep.standards.CS5.violation, 1)
                assert.equal(rep.standards.CS12.violation, 2, '領域標籤與線索值各一')
                assert.equal(rep.standards.CS9.violation, 1)
            })

            it('停用之標準(settings.capture.standards.titleMismatch:false → CS2、sameContent:false → CS10):不判、桶記 disabled:true 且總量 0(不報合格);其餘照掃;計數摘要附 disabled;預設無 disabled 鍵', async () => {
                // 規則:standards/audit.auditCaptureStandards 之 deps.settings(零件庫用法之標準開關;stores/ingestGate、detailFetchStage 同讀此鍵)
                const off = settingsOf({ standards: { titleMismatch: false, sameContent: false } })
                const rep = await auditCaptureStandards({ stores: stores(MIXED()), settings: off })
                assert.deepEqual([rep.standards.CS2.disabled, rep.standards.CS2.total, rep.standards.CS2.pass, rep.standards.CS2.violation], [true, 0, 0, 0])
                assert.deepEqual([rep.standards.CS10.disabled, rep.standards.CS10.total, rep.standards.CS10.violation], [true, 0, 0])
                assert.deepEqual([rep.standards.CS5.violation, rep.standards.CS12.violation, rep.standards.CS9.violation], [1, 2, 1], '其餘標準照掃')
                assert.deepEqual(standardsCountsOf(rep).counts.CS2, { v: rep.standards.CS2.v, total: 0, violation: 0, undetermined: 0, waived: 0, disabled: true })
                const one = await auditCaptureStandards({ stores: stores(MIXED()), settings: settingsOf({ standards: { sameContent: false } }) })
                assert.deepEqual(['disabled' in one.standards.CS2, one.standards.CS10.disabled, one.standards.CS2.total > 0], [false, true, true], '只關一個')
                const dflt = await auditCaptureStandards({ stores: stores(MIXED()), settings: settingsOf() })
                assert.ok(Object.values(dflt.standards).every((b) => !('disabled' in b)), '預設皆開:桶無 disabled 鍵')
                assert.equal('disabled' in standardsCountsOf(dflt).counts.CS10, false)
            })

            it('only:只跑指定標準(未知 id 忽略;空陣列或未給即全部);maxIds 只截各態列出之 id,不影響計數', async () => {
                const o = MIXED()
                assert.deepEqual(Object.keys((await audit(o, ['CS10', 'CS99'])).standards), ['CS10'])
                assert.deepEqual(Object.keys((await audit(o, [])).standards), [...AUDITED_STANDARD_IDS])
                assert.deepEqual(Object.keys((await audit(o, undefined)).standards), [...AUDITED_STANDARD_IDS])
                const many = { areas: Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, label: '加密货币' })) }
                const cut = (await audit(many, ['CS12'], {}, { maxIds: 2 })).standards.CS12
                assert.deepEqual([cut.violation, cut.violations.length], [5, 2], '計數為全部、清單截為 2')
                assert.equal((await audit(many, ['CS12'], {}, { maxIds: 0 })).standards.CS12.violations.length, 0)
                assert.equal((await audit(many, ['CS12'], {}, { maxIds: -1 })).standards.CS12.violations.length, 5, '無效值視為不限')
            })

            it('使用者豁免:不合格與未能判定而該物件該標準有 waived 之待判登錄 → 記 waived(逐一列出,不算合格);open 狀態、他標準、他物件種類之登錄不豁免;無 holds 集合者不影響', async () => {
                const docs = [
                    { id: 'r1', status: 'raw', textFrom: 'article', title: 't', text: '短', url: 'https://x.example/1' }, // CS1a 不合格 → 有豁免
                    { id: 'r2', status: 'raw', textFrom: 'article', title: 't', text: '短', url: 'https://x.example/2' }, // CS1a 不合格 → 豁免為 open
                    { id: 'r3', status: 'raw', textFrom: '', title: 't', text: HEALTHY, url: 'https://x.example/3' }, // CS1a 未能判定 → 有豁免
                    { id: 'r4', status: 'raw', textFrom: 'article', title: 't', text: '短', url: 'https://x.example/4' }, // 豁免之標準不同
                    { id: 'r5', status: 'raw', textFrom: 'article', title: 't', text: '短', url: 'https://x.example/5' }, // 豁免之物件種類不同
                    { id: 'r6', status: 'raw', textFrom: 'article', title: 't', text: HEALTHY, url: 'https://x.example/6' }, // 合格不受豁免影響
                ]
                const holds = [
                    { id: 'doc:r1:CS1a', object: 'doc', oid: 'r1', std: 'CS1a', status: 'waived', waivedBy: '使用者', ruling: '保留' },
                    { id: 'doc:r2:CS1a', object: 'doc', oid: 'r2', std: 'CS1a', status: 'open' },
                    { id: 'doc:r3:CS1a', object: 'doc', oid: 'r3', std: 'CS1a', status: 'waived' },
                    { id: 'doc:r4:CS2', object: 'doc', oid: 'r4', std: 'CS2', status: 'waived' },
                    { id: 'note:r5:CS1a', object: 'note', oid: 'r5', std: 'CS1a', status: 'waived' },
                    { id: 'doc:r6:CS1a', object: 'doc', oid: 'r6', std: 'CS1a', status: 'waived' },
                ]
                const b = (await audit({ docs, holds }, ['CS1a'])).standards.CS1a
                wellFormed(b)
                assert.deepEqual(ids(b.waiveds), ['r1', 'r3'], '不合格與未能判定之豁免皆列入')
                assert.deepEqual(ids(b.violations), ['r2', 'r4', 'r5'])
                assert.deepEqual([b.waived, b.violation, b.undetermined, b.pass, b.total], [2, 3, 0, 1, 6])
                const none = (await audit({ docs }, ['CS1a'])).standards.CS1a
                assert.deepEqual([none.waived, none.violation, none.undetermined], [0, 4, 1], '無 holds 集合:不豁免')
            })

            it('CS10 之群只要有任一成員被豁免即整群記 waived(refs 為群內各文件)', async () => {
                const docs = [
                    { id: 'a', status: 'noted', url: 'https://arxiv.org/abs/2401.01234', paraKeys: [] },
                    { id: 'b', status: 'noted', url: 'https://arxiv.org/pdf/2401.01234', paraKeys: [] },
                    { id: 'c', status: 'noted', url: 'https://www.msn.com/en-in/money/x/ar-AA29ARZ4', paraKeys: [] },
                    { id: 'd', status: 'noted', url: 'https://www.msn.com/en-in/news/y/ar-AA29ARZ4', paraKeys: [] },
                ]
                const holds = [{ id: 'doc:b:CS10', object: 'doc', oid: 'b', std: 'CS10', status: 'waived' }]
                const b = (await audit({ docs, holds }, ['CS10'])).standards.CS10
                assert.deepEqual(b.waiveds, [{ id: 'a＋b', detail: '同一內容 2 份（arxiv:2401.01234）' }])
                assert.deepEqual(b.violations.map((v) => v.id), ['c＋d'])
            })

            it('輸入檢核:deps.stores.docs 須具 select;opt 非物件視為 {};缺 stores 或 deps 拋錯', async () => {
                await assert.rejects(() => auditCaptureStandards({ stores: {} }), /auditCaptureStandards 需要 deps\.stores\.docs（具 select 方法）/)
                await assert.rejects(() => auditCaptureStandards({ stores: { docs: {} } }), /需要 deps\.stores\.docs/)
                await assert.rejects(() => auditCaptureStandards(null), /需要 deps\.stores\.docs/)
                await assert.rejects(() => auditCaptureStandards(), /需要 deps\.stores\.docs/)
                for (const bad of [null, 'x', 5, []]) assert.equal(Object.keys((await auditCaptureStandards({ stores: stores() }, bad)).standards).length, AUDITED_STANDARD_IDS.length)
            })

            it('空庫:各標準總量為 0、各態為 0(不報合格亦不報違反);集合缺席(areas、sources、frontier 未給)不拋', async () => {
                const rep = await auditCaptureStandards({ stores: { docs: memStore([]) } })
                assert.deepEqual(rep.counts, { docsRaw: 0, docsNoted: 0, areas: 0, frontierPending: 0, frontier: 0, sources: 0 })
                for (const b of Object.values(rep.standards)) assert.deepEqual([b.total, b.pass, b.violation, b.undetermined, b.na, b.waived], [0, 0, 0, 0, 0, 0], b.id)
            })
        })

        describe('standardsCountsOf(執行摘要之計數;四工作同一份)', function() {

            it('逐標準取 v、total、violation、undetermined、waived;附掃描時刻與耗時;不含逐件 id;抓取之掃描無 AI 列 → 無 ai', async () => {
                const rep = await auditCaptureStandards({ stores: stores({ areas: [{ id: 'a', label: '加密货币' }] }) })
                const c = standardsCountsOf(rep, { at: '2026-10-06T00:00:00+08:00', ms: 12 })
                assert.equal(c.at, '2026-10-06T00:00:00+08:00')
                assert.equal(c.ms, 12)
                assert.deepEqual(Object.keys(c.counts), [...AUDITED_STANDARD_IDS])
                assert.deepEqual(c.counts.CS12, { v: 1, total: 1, violation: 1, undetermined: 0, waived: 0 })
                assert.equal(JSON.stringify(c).includes('violations'), false)
                assert.equal('ai' in c, false)
            })

            it('缺值之穩健處理:waived 缺者為 0;at 非字串轉字串、ms 非數字為 0;o 非物件視為 {};rep 缺或無 standards 回空 counts', () => {
                assert.deepEqual(standardsCountsOf({ standards: { CS2: { id: 'CS2', v: 1, total: 3, violation: 1, undetermined: 0 } } }, { at: 5, ms: 'x' }), { at: '5', ms: 0, counts: { CS2: { v: 1, total: 3, violation: 1, undetermined: 0, waived: 0 } } })
                for (const o of [null, 'x', 5, undefined]) assert.deepEqual(standardsCountsOf({ standards: {} }, o), { at: '', ms: 0, counts: {} })
                assert.deepEqual(standardsCountsOf(null), { at: '', ms: 0, counts: {} })
                assert.deepEqual(standardsCountsOf({}), { at: '', ms: 0, counts: {} })
            })

            it('掃描有 AI 列(standardsScanOf 之形狀)→ 附 ai[標準]＝{ holdsOpen, total?, due? }(有受檢總量者才附;值轉數值);空之 ai 照附空物件', () => {
                const c = standardsCountsOf({ standards: {}, ai: { ES9: { holdsOpen: 1, total: 5, due: 2, checked: 3 }, RS4: { holdsOpen: '2' }, X: null } }, { at: 't', ms: 1 })
                assert.deepEqual(c.ai, { ES9: { holdsOpen: 1, total: 5, due: 2 }, RS4: { holdsOpen: 2 }, X: { holdsOpen: 0 } })
                assert.deepEqual(standardsCountsOf({ standards: {}, ai: {} }).ai, {})
            })
        })

        describe('createStandardsTally(累計器;四工作同一份)', function() {

            const REG = [
                { id: 'A1', title: '甲', kind: 'code', v: 2, object: 'docs', scan: true },
                { id: 'A2', title: '乙', kind: 'code', v: 1, object: 'docs', scan: true },
                { id: 'A3', title: '丙', kind: 'ai', v: 1, object: 'docs', scan: false },
            ]

            it('桶:registry 之 scan 為真者依序各一桶(only 之範圍內;module 欄;四態與逐態 id 之初值);未建桶之標準之判定略過', () => {
                const t = createStandardsTally(REG, { module: 'm' })
                assert.deepEqual(Object.keys(t.std), ['A1', 'A2'])
                assert.deepEqual(t.std.A1, { id: 'A1', title: '甲', kind: 'code', v: 2, module: 'm', object: 'docs', total: 0, pass: 0, violation: 0, undetermined: 0, na: 0, waived: 0, violations: [], undetermineds: [], waiveds: [] })
                assert.deepEqual(Object.keys(createStandardsTally(REG, { only: ['A2', 'A3', 'Z'] }).std), ['A2'])
                t.add('x', { std: 'A3', status: 'violation' })
                t.add('x', { std: 'Z', status: 'violation' })
                t.add('x', null)
                assert.deepEqual([t.std.A1.total, t.std.A2.total], [0, 0])
                for (const bad of [null, 'x', 5]) assert.deepEqual(Object.keys(createStandardsTally(REG, bad).std), ['A1', 'A2'])
                assert.deepEqual(createStandardsTally(null).std, {})
            })

            it('四態計數與逐態列出(field 有值且異於物件 id → 「物件 id#field」);maxIds 只限列出、不限計數', () => {
                const t = createStandardsTally(REG, { maxIds: 1 })
                t.add('a', { std: 'A1', status: 'pass' })
                t.add('b', { std: 'A1', status: 'violation', detail: 'd1', field: 'C2' })
                t.add('c', { std: 'A1', status: 'violation', detail: 'd2' })
                t.add('d', { std: 'A1', status: 'undetermined', detail: 'u', field: 'd' })
                t.add('e', { std: 'A1', status: 'na' })
                const b = t.std.A1
                assert.deepEqual([b.total, b.pass, b.violation, b.undetermined, b.na, b.waived], [5, 1, 2, 1, 1, 0])
                assert.deepEqual([b.violations, b.undetermineds], [[{ id: 'b#C2', detail: 'd1' }], [{ id: 'd', detail: 'u' }]])
            })

            it('豁免:待判登錄之 waived(鍵以 holdKey 組,refs 任一相符)→ 不合格／未能判定記 waived 並列出;合格不受影響;未結之登錄、他標準不豁免;waivedKeyOf 另認之鍵', () => {
                const holds = [
                    { object: 'doc', oid: 'a', std: 'A1', status: 'waived' },
                    { object: 'doc', oid: 'b', std: 'A1', status: 'open' },
                    { object: 'doc', oid: 'c', std: 'A2', status: 'waived' },
                    { object: 'review', oid: 'z', std: 'R6', status: 'waived', src: 'doc:d:A1' },
                ]
                const t = createStandardsTally(REG, { holds, waivedKeyOf: (h) => h.src })
                t.add('a', { std: 'A1', status: 'violation', detail: 'x' }, [['doc', 'a']])
                t.add('a2', { std: 'A1', status: 'undetermined', detail: 'y' }, [['note', 'n'], ['doc', 'a']])
                t.add('p', { std: 'A1', status: 'pass' }, [['doc', 'a']])
                t.add('b', { std: 'A1', status: 'violation' }, [['doc', 'b']])
                t.add('c', { std: 'A1', status: 'violation' }, [['doc', 'c']])
                t.add('d', { std: 'A1', status: 'violation' }, [['doc', 'd']])
                const b = t.std.A1
                assert.deepEqual([b.waived, b.pass, b.violation], [3, 1, 2])
                assert.deepEqual(b.waiveds.map((x) => x.id), ['a', 'a2', 'd'])
                assert.deepEqual(createStandardsTally(REG, { holds: null }).std.A1.waived, 0)
            })

            it('detailOf:判定說明之替換(未給用判定之 detail)', () => {
                const t = createStandardsTally(REG, { detailOf: (r) => (r.status === 'undetermined' ? '未讀材料' : r.detail) })
                t.add('a', { std: 'A1', status: 'undetermined', detail: '原' })
                t.add('b', { std: 'A1', status: 'violation', detail: '原' })
                assert.deepEqual([t.std.A1.undetermineds[0].detail, t.std.A1.violations[0].detail], ['未讀材料', '原'])
            })
        })

        describe('standardsScanOf(總覽之形狀;四工作同一份)', function() {

            it('標準列原樣(給了 object 者改之);AI 列計數欄 null 補 0、全零與 null 之列不列;受檢總量／到期有其一非零者照列並附之;counts 之值轉數值', () => {
                const rep = {
                    counts: { edges: '3', cores: 2 },
                    standards: { X1: { id: 'X1', object: 'edge', total: 1 }, X2: null },
                    ai: {
                        R4: { v: 1, checked: null, holdsOpen: 2 },
                        R5: null,
                        R6: { v: 1, checked: 0, holdsOpen: 0 },
                        E9: { v: 2, checked: 0, holdsOpen: 0, total: 5, due: 0 },
                        E8: { v: 1, checked: 0, total: 0, due: 0 },
                    },
                }
                const s = standardsScanOf(rep, { object: 'edges' })
                assert.deepEqual(s.counts, { edges: 3, cores: 2 })
                assert.deepEqual(s.standards, { X1: { id: 'X1', object: 'edges', total: 1 } })
                assert.deepEqual(Object.keys(s.ai), ['R4', 'E9'])
                assert.deepEqual(s.ai.R4, { checked: 0, pass: 0, violation: 0, undetermined: 0, na: 0, stale: 0, holdsOpen: 2, holdsWaived: 0, v: 1 })
                assert.deepEqual(s.ai.E9, { checked: 0, pass: 0, violation: 0, undetermined: 0, na: 0, stale: 0, holdsOpen: 0, holdsWaived: 0, v: 2, total: 5, due: 0 })
                assert.deepEqual(standardsScanOf(rep).standards.X1.object, 'edge', '未給 object 不改')
                assert.deepEqual(AI_ROW_KEYS, ['checked', 'pass', 'violation', 'undetermined', 'na', 'stale', 'holdsOpen', 'holdsWaived'])
                for (const bad of [null, undefined, 'x', {}]) assert.deepEqual(standardsScanOf(bad), { counts: {}, standards: {}, ai: {} })
            })
        })
    })
})

/**
 * 空集合組(供只替換其中一個集合之案例用)
 *
 * @returns {Object} 回傳 { docs, docTexts, areas, frontier, sources }
 */
function stores_() {
    return { docs: memStore([]), docTexts: memStore([]), areas: memStore([]), frontier: memStore([]), sources: memStore([]) }
}
