// unit-rejects.test.mjs — 剔除清單與待辦總表(rejects.mjs;唯讀匯出):類別只讀結構化欄位、篩選(status／class／host 含子網域／since／limit)、
//   重複件帶出錨狀態、待辦總表各桶、回溯帳(最後一行／壞行略過)、CSV(BOM、RFC 4180 跳脫)、Markdown 跳脫、純讀
// 執行:自套件根 node <mocha> --timeout 180000 test/unit-rejects.test.mjs(暫存 test/_tmp/rejects-<pid>,測完即刪)
// 各 assertion 之註解「規則:」說明對應之行為規則(rejectClassOf／rejectListOf／rowsToCsv／rowsToMd 各條);「約定:」為規則未明文、實作所定之行為

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { memStore } from './tools/memStore.mjs'
import { parseCsv } from './tools/testKit.mjs'
import { REJECT_OBJECTS, rejectClassOf, rejectListOf, rowsToCsv, rowsToMd } from '../src/rejects.mjs'

const TMP = path.resolve(`test/_tmp/rejects-${process.pid}`).replace(/\\/g, '/')
const LEDGER = `${TMP}/state/refetch-sources.jsonl`
const NOW_MS = Date.parse('2026-10-05T12:00:00+08:00')
const DAY = 86400_000
/** UTF-8 BOM(U+FEFF;以字碼組出,避免原始碼內夾不可見字元) */
const BOM = String.fromCharCode(0xfeff)
/** d 天前之 ISO 時刻(UTC) */
const T = (d) => new Date(NOW_MS - d * DAY).toISOString()
const FUTURE = new Date(NOW_MS + 3600_000).toISOString()
const PAST = new Date(NOW_MS - 3600_000).toISOString()

// ── 固定資料(各列之 at、網址、欄位皆為下方斷言之預期來源)──
const DOCS = () => [
    // dead:有 deadClass／只有 lastClass／兩者皆無(缺欄之記錄)
    { id: 'dead-final', status: 'dead', url: 'https://a.example.com/p1', title: '終態404', deadClass: 'http-final', lastClass: 'render', lastReason: 'http-error', lastError: 'HTTP 404', deadAt: T(1), httpCode: 404, deadBy: 'detailFetch', fetchTries: 3, fetchChainFails: 2, sourceName: '來源甲' },
    { id: 'dead-lastclass', status: 'dead', url: 'https://b.example.org/p2', title: '只有lastClass', lastClass: 'render', lastReason: 'empty', lastError: 'shell', deadAt: T(2) },
    { id: 'dead-old', status: 'dead', url: 'https://notexample.com/p3', title: '缺欄之記錄', lastReason: 'http-error', lastError: 'HTTP 410 gone' },
    // skip:重複件三種錨(noted／dead／已不在)、例行、缺 skipKind、材料
    { id: 'skip-dup', status: 'skip', url: 'https://a.example.com/p4', title: '重複(錨為noted)', skipKind: 'duplicate', skipReason: '與既有文件同一內容（未進 AI）', notedAt: T(3), dupOf: 'noted-anchor' },
    { id: 'skip-dup-dead', status: 'skip', url: 'https://c.example.org/p8', title: '重複(錨為dead)', skipKind: 'duplicate', skipReason: '轉址至既有文件', notedAt: T(8), dupOf: 'dead-final' },
    { id: 'skip-dup-missing', status: 'skip', url: 'https://c.example.org/p5', title: '重複(錨已不在)', skipKind: 'duplicate', skipReason: '與既有文件同一內容', notedAt: T(4), dupOf: 'ghost' },
    { id: 'skip-routine', status: 'skip', url: 'https://c.example.org/p6', title: '例行', skipKind: 'routine', skipReason: '標題樣式判定為例行公告', notedAt: T(5) },
    { id: 'skip-old', status: 'skip', title: '缺skipKind', skipReason: '與既有文件同一內容（另一格式之文字）', notedAt: T(6) },
    { id: 'skip-material', status: 'skip', url: 'https://d.example.org/p7', title: '材料不足', skipKind: 'material', skipReason: '原文過短', notedAt: T(7) },
    // aggregated／summarize-failed(皆無決定時刻)
    { id: 'agg', status: 'aggregated', url: 'https://agg.example.org/x', title: '彙整貼文', linkCount: 3 },
    { id: 'sumfail', status: 'summarize-failed', url: 'https://sf.example.org/y', title: '摘要失敗', lastError: '未達檢定標準：概念 1 個' },
    // noted:錨、段落鍵無原文(時間字串／true 兩種值)、有段落鍵者、回溯帳之對象
    { id: 'noted-anchor', status: 'noted', url: 'https://anchor.example.org/', title: '錨', paraKeysNoText: T(1) },
    { id: 'noted-flag-true', status: 'noted', paraKeysNoText: true },
    { id: 'noted-keys', status: 'noted', paraKeys: ['k1'] },
    { id: 'rf1', status: 'noted', url: 'https://a.example.com/rf1', title: '回溯甲' },
    { id: 'rf2', status: 'noted', url: 'https://x.example.net/rf2', title: '回溯乙' },
    { id: 'rf3', status: 'noted', url: 'https://c.example.net/rf3', title: '回溯丙' },
    // new:瀏覽器佇列(有／無 deferredAt;有 retryAt 亦屬瀏覽器佇列)、退避中、未試(含缺欄、retryAt 已過)、重試(retryAt 已過亦屬重試)
    { id: 'new-browser', status: 'new', fetcher: 'browser', deferredAt: T(2), collectedAt: T(30) },
    { id: 'new-browser-backoff', status: 'new', fetcher: 'browser', retryAt: FUTURE, collectedAt: T(9) },
    { id: 'new-backoff', status: 'new', fetchTries: 1, retryAt: FUTURE, collectedAt: T(20) },
    { id: 'new-untried', status: 'new', fetchTries: 0, collectedAt: T(8) },
    { id: 'new-untried-nofield', status: 'new', collectedAt: T(7) },
    { id: 'new-untried-pastretry', status: 'new', fetchTries: 0, retryAt: PAST, collectedAt: T(6) },
    { id: 'new-retry', status: 'new', fetchTries: 2, collectedAt: T(3) },
    { id: 'new-retry-pastretry', status: 'new', fetchTries: 1, retryAt: PAST, collectedAt: T(5) },
    // raw:最舊天數以 rawAt 計(collectedAt 另有更舊之值,不得被採用)
    { id: 'raw-old', status: 'raw', rawAt: T(4), collectedAt: T(50) },
    { id: 'raw-new', status: 'raw', rawAt: T(1) },
]
const SOURCES = () => [
    { id: 'src-dis', name: '停用來源', kind: 'rss', url: 'https://feeds.example.com/rss', enabled: false, disableReason: '連續失敗 8 次', disabledAt: T(2), failCount: 8, chainFails: 3, lastError: 'HTTP 500' },
    { id: 'src-paused', name: '暫停來源', kind: 'grid', url: 'https://api.example.net/q', enabled: true, paused: true },
    { id: 'src-paused-reason', name: '暫停來源2', kind: 'grid', url: 'https://q.example.net/q', paused: true, pauseReason: '種子檔已移除' },
    { id: 'src-both', name: '兩者皆有', kind: 'rss', url: 'https://both.example.com/', enabled: false, paused: true, disableReason: '零產出', disabledAt: T(7) },
    { id: 'src-ok', name: '正常', kind: 'rss', url: 'https://ok.example.com/', enabled: true },
    { id: 'src-ok-nofield', name: '未設enabled', kind: 'rss' },
]
const CLUES = () => [
    { id: 'c-failed', type: 'keyword', value: '關鍵詞甲', status: 'failed', lastError: 'timeout', failedAt: T(1), tries: 2, chainFails: 1, hits: 3 },
    // 非 pending 之 retryAt 不算退避
    { id: 'c-evicted', type: 'topic', value: '低頻主題', status: 'evicted', evictedAt: T(3), hits: 1, retryAt: FUTURE },
    { id: 'c-evicted-err', type: 'topic', value: '曾失敗後被淘汰', status: 'evicted', evictedAt: T(4), lastError: '舊失敗', tries: 1, hits: 1 },
    { id: 'c-site', type: 'site', value: 'https://sub.example.org/news', status: 'failed', lastError: 'dns', failedAt: T(5), tries: 2 },
    { id: 'c-pend', type: 'keyword', value: '待探索', status: 'pending' },
    { id: 'c-pend-backoff', type: 'keyword', value: '退避', status: 'pending', retryAt: FUTURE },
    { id: 'c-done', type: 'keyword', value: '已消化', status: 'done' },
]
const AREAS = () => [
    // 中繼記錄(id 以 _meta 開頭)須排除
    { id: '_meta', lastDiscoverAt: T(1) },
    { id: '_meta-x', lastDiscoverAt: T(1), status: 'rejected' },
    { id: 'a-rej', label: '被拒領域', query: 'q rej', status: 'rejected', statusBy: 'auto', reason: '驗證未過：計數 50 < 200', updatedAt: T(2) },
    // paused:決定時刻取 pausedAt(updatedAt 較新,不得採用);手動暫停無 pausedAt → 取 updatedAt
    { id: 'a-pause', label: '暫停領域', query: 'q pause', status: 'paused', statusBy: 'auto', reason: '低產出', pausedAt: T(4), updatedAt: T(1) },
    { id: 'a-pause-manual', label: '手動暫停領域', query: 'q manual', status: 'paused', statusBy: 'manual', reason: '手動暫停', updatedAt: T(2) },
    { id: 'a-ret', label: '退役領域', query: 'q ret', status: 'retired', statusBy: 'seed', reason: '種子檔已移除（或查詢已改）', updatedAt: T(4) },
    { id: 'a-act', label: '運作中', query: 'q act', status: 'active', statusBy: 'seed' },
]
// 回溯帳:rf1 兩行(取最後一行)、壞行／非物件／無 id 略過、rf2 已另存(archived 不列為剔除)、rf3 查無
const LEDGER_LINES = [
    JSON.stringify({ at: T(6), id: 'rf1', method: 'article', outcome: 'fetch-failed', why: 'HTTP 503', chars: 0 }),
    JSON.stringify({ at: T(2), id: 'rf1', method: 'article', outcome: 'identity-mismatch', why: '標題與正文不符', chars: 0 }),
    '{ this is not json',
    '',
    JSON.stringify({ at: T(1), id: 'rf2', method: 'arxiv', outcome: 'archived', why: '', chars: 900 }),
    JSON.stringify({ at: T(3), id: 'rf3', method: 'openalex-doi', outcome: 'not-found', why: 'API 查無此記錄', chars: 0 }),
    '[1,2]',
    JSON.stringify({ at: T(1), id: '', outcome: 'fetch-failed' }),
    JSON.stringify({ at: T(1), outcome: 'fetch-failed' }),
]

const stores = () => ({ docs: memStore(DOCS()), sources: memStore(SOURCES()), frontier: memStore(CLUES()), areas: memStore(AREAS()) })
const list = (opt = {}) => rejectListOf(stores(), { nowMs: NOW_MS, ledgerFile: LEDGER, ...opt })
const ids = (r) => r.rows.map((x) => x.id).sort()

/**
 * RFC 4180 剖析(測試用;與被測之輸出端獨立實作):引號內之逗號、換行、雙引號加倍皆還原;引號外之 CRLF 為列界
 *
 * @param {String} text 輸入 CSV 字串(不含 BOM)
 * @returns {Array} 回傳列陣列(各為欄位字串陣列)
 */

/**
 * 會記錄呼叫並在寫入類方法被呼叫時拋錯之替身集合(純讀驗證)
 *
 * @param {Array} rows 輸入集合內容
 * @param {Array} calls 輸入呼叫紀錄(就地 push `名稱.方法`)
 * @param {String} name 輸入集合名稱
 * @returns {Object} 回傳 Proxy 包裝之 memStore
 */
function spyStore(rows, calls, name) {
    const s = memStore(rows)
    return new Proxy(s, {
        get(t, k) {
            const v = t[k]
            if (typeof v !== 'function') return v
            // 與真集合同為非同步介面:寫入類方法以 rejected promise 回報違規(呼叫端 await 即拋)
            return async (...a) => {
                calls.push(`${name}.${String(k)}`)
                if (['patch', 'insertNew', 'replace', 'del'].includes(String(k))) throw new Error(`純讀違規：呼叫了 ${name}.${String(k)}`)
                return v.apply(t, a)
            }
        },
    })
}

describe('unit-rejects', function() {

    before(() => {
        fs.mkdirSync(`${TMP}/state`, { recursive: true })
        fs.writeFileSync(LEDGER, `${LEDGER_LINES.join('\n')}\n`, 'utf8')
    })
    after(() => fs.rmSync(TMP, { recursive: true, force: true }))

    describe('rejectClassOf:類別只讀結構化欄位', function() {

        it('docs:dead 取 deadClass → lastClass → unclassified;skip 取 skipKind → unclassified;aggregated／summarize-failed 同名;其餘狀態不屬剔除', () => {
            const c = rejectClassOf
            // 規則:docs dead:deadClass(有則用)→ 否則 lastClass → 否則 'unclassified'(缺欄之記錄未分類)
            assert.equal(c({ status: 'dead', deadClass: 'http-final', lastClass: 'render' }, 'docs'), 'http-final')
            assert.equal(c({ status: 'dead', lastClass: 'render' }, 'docs'), 'render')
            assert.equal(c({ status: 'dead' }, 'docs'), 'unclassified')
            assert.equal(c({ status: 'dead', deadClass: '', lastClass: '' }, 'docs'), 'unclassified', '空字串視同缺欄')
            // 規則:只讀結構化欄位(不得解析 lastError／skipReason 文字)——文字再像 404 或重複,結構化欄位缺即 unclassified
            assert.equal(c({ status: 'dead', lastReason: 'http-error', lastError: 'HTTP 404 Not Found' }, 'docs'), 'unclassified')
            assert.equal(c({ status: 'skip', skipReason: '與既有文件同一內容（未進 AI）' }, 'docs'), 'unclassified')
            // 規則:docs skip:skipKind(值域 duplicate／routine／triage／not-knowledge／material)→ 否則 'unclassified'
            for (const k of ['duplicate', 'routine', 'triage', 'not-knowledge', 'material']) assert.equal(c({ status: 'skip', skipKind: k }, 'docs'), k)
            assert.equal(c({ status: 'skip' }, 'docs'), 'unclassified')
            // 約定:值域外之非空 skipKind 照原值(類別集合為開放集合,新類別不被併入 unclassified)
            assert.equal(c({ status: 'skip', skipKind: 'future-kind' }, 'docs'), 'future-kind')
            // 規則:docs aggregated → 'aggregated';summarize-failed → 'summarize-failed'
            assert.equal(c({ status: 'aggregated' }, 'docs'), 'aggregated')
            assert.equal(c({ status: 'summarize-failed' }, 'docs'), 'summarize-failed')
            // 規則:docs 之剔除限 dead／skip／aggregated／summarize-failed(new／raw／noted 不屬剔除)
            for (const s of ['new', 'raw', 'noted', '', undefined]) assert.equal(c({ status: s, deadClass: 'x', skipKind: 'y' }, 'docs'), '')
        })

        it('sources／clues／areas／refetch:各依 enabled／paused／status／outcome;archived 不列;無關記錄回空字串;未知物件拋錯', () => {
            const c = rejectClassOf
            // 規則:sources:enabled===false → 'source-disabled';paused===true → 'source-paused'
            assert.equal(c({ enabled: false }, 'sources'), 'source-disabled')
            assert.equal(c({ paused: true }, 'sources'), 'source-paused')
            assert.equal(c({ enabled: false, paused: true }, 'sources'), 'source-disabled', '兩者並存取停用(列序在前)')
            for (const s of [{ enabled: true }, {}, { paused: false }, { paused: 'true' }]) assert.equal(c(s, 'sources'), '')
            // 規則:clues(frontier):status 為 failed／evicted → 'clue-failed'／'clue-evicted'
            assert.equal(c({ status: 'failed' }, 'clues'), 'clue-failed')
            assert.equal(c({ status: 'evicted' }, 'clues'), 'clue-evicted')
            for (const s of ['pending', 'done', undefined]) assert.equal(c({ status: s }, 'clues'), '')
            // 規則:areas:status 為 rejected／paused／retired → 'area-rejected'／'area-paused'／'area-retired'
            for (const s of ['rejected', 'paused', 'retired']) assert.equal(c({ status: s }, 'areas'), `area-${s}`)
            assert.equal(c({ status: 'active' }, 'areas'), '')
            // 規則:refetch:'refetch-' + outcome(archived 不列為剔除)
            for (const o of ['identity-mismatch', 'not-found', 'fetch-failed', 'gate-failed']) assert.equal(c({ outcome: o }, 'refetch'), `refetch-${o}`)
            assert.equal(c({ outcome: 'archived' }, 'refetch'), '')
            assert.equal(c({}, 'refetch'), '', '無 outcome 者不列')
            // 非物件記錄回空字串;未知物件拋錯(不靜默回空)
            assert.equal(c(null, 'docs'), '')
            assert.throws(() => c({ status: 'dead' }, 'notes'), /未知物件「notes」/)
            assert.deepEqual([...REJECT_OBJECTS], ['docs', 'sources', 'clues', 'areas', 'refetch'])
        })
    })

    describe('rejectListOf:列、計數、排序', function() {

        it('docs 各列欄位:dead 之 extra 取結構化欄位(缺者不列);缺欄之記錄 → unclassified 且 at 空;aggregated／summarize-failed 之 reason／detail', async () => {
            const r = await list()
            const by = (id) => r.rows.find((x) => x.id === id)
            // 規則:docs dead:reason＝lastReason、detail＝lastError、at＝deadAt、extra＝{ httpCode, deadBy, fetchTries, fetchChainFails, sourceName }
            assert.deepEqual(by('dead-final'), { object: 'docs', id: 'dead-final', url: 'https://a.example.com/p1', label: '終態404', status: 'dead', class: 'http-final', reason: 'http-error', detail: 'HTTP 404', at: T(1), extra: { httpCode: 404, deadBy: 'detailFetch', fetchTries: 3, fetchChainFails: 2, sourceName: '來源甲' } })
            assert.deepEqual(by('dead-lastclass'), { object: 'docs', id: 'dead-lastclass', url: 'https://b.example.org/p2', label: '只有lastClass', status: 'dead', class: 'render', reason: 'empty', detail: 'shell', at: T(2), extra: {} })
            // 規則:缺欄之記錄 → unclassified(不由 lastError 文字「HTTP 410」推導)
            assert.deepEqual(by('dead-old'), { object: 'docs', id: 'dead-old', url: 'https://notexample.com/p3', label: '缺欄之記錄', status: 'dead', class: 'unclassified', reason: 'http-error', detail: 'HTTP 410 gone', at: '', extra: {} })
            // 規則:docs aggregated:reason＝'彙整貼文（已轉錄連結）'、extra＝{ linkCount };summarize-failed:detail＝lastError
            assert.deepEqual(by('agg'), { object: 'docs', id: 'agg', url: 'https://agg.example.org/x', label: '彙整貼文', status: 'aggregated', class: 'aggregated', reason: '彙整貼文（已轉錄連結）', detail: '', at: '', extra: { linkCount: 3 } })
            assert.deepEqual(by('sumfail'), { object: 'docs', id: 'sumfail', url: 'https://sf.example.org/y', label: '摘要失敗', status: 'summarize-failed', class: 'summarize-failed', reason: '', detail: '未達檢定標準：概念 1 個', at: '', extra: {} })
            // 非剔除之文件(noted／new／raw)不成列
            for (const id of ['noted-anchor', 'new-retry', 'raw-old', 'rf1']) assert.equal(by(id)?.object === 'docs', false, id)
        })

        it('重複件(skip):reason＝skipReason、at＝notedAt;有 dupOf 者帶出錨之狀態(noted／dead／查無 missing);無 dupOf 者 extra 空', async () => {
            const r = await list()
            const by = (id) => r.rows.find((x) => x.id === id)
            // 規則:docs skip:reason＝skipReason、at＝notedAt、extra＝{ dupOf, dupOfStatus(若有 dupOf,查 docs 取其 status;查無 'missing') }
            assert.deepEqual(by('skip-dup'), { object: 'docs', id: 'skip-dup', url: 'https://a.example.com/p4', label: '重複(錨為noted)', status: 'skip', class: 'duplicate', reason: '與既有文件同一內容（未進 AI）', detail: '', at: T(3), extra: { dupOf: 'noted-anchor', dupOfStatus: 'noted' } })
            assert.deepEqual(by('skip-dup-dead').extra, { dupOf: 'dead-final', dupOfStatus: 'dead' })
            assert.deepEqual(by('skip-dup-missing').extra, { dupOf: 'ghost', dupOfStatus: 'missing' })
            assert.deepEqual([by('skip-routine').class, by('skip-routine').extra, by('skip-routine').at], ['routine', {}, T(5)])
            assert.deepEqual([by('skip-old').class, by('skip-old').reason], ['unclassified', '與既有文件同一內容（另一格式之文字）'], '缺 skipKind → unclassified')
            assert.equal(by('skip-material').class, 'material')
        })

        it('sources／clues／areas／refetch 各列欄位(停用／暫停之原因與時刻;線索 label 與網址;領域 paused 取 pausedAt;中繼記錄排除;回溯帳最後一行、壞行略過、archived 不列)', async () => {
            const r = await list()
            const by = (id) => r.rows.find((x) => x.id === id)
            // 規則:sources:label＝name、reason＝disableReason(停用)、detail＝lastError、at＝disabledAt、extra＝{ failCount, chainFails, kind }
            assert.deepEqual(by('src-dis'), { object: 'sources', id: 'src-dis', url: 'https://feeds.example.com/rss', label: '停用來源', status: 'disabled', class: 'source-disabled', reason: '連續失敗 8 次', detail: 'HTTP 500', at: T(2), extra: { failCount: 8, chainFails: 3, kind: 'rss' } })
            // 規則:paused 之 reason＝'領域暫停／種子移除'(記錄有 pauseReason 者取之,為約定);無 disabledAt → at 空
            assert.deepEqual(by('src-paused'), { object: 'sources', id: 'src-paused', url: 'https://api.example.net/q', label: '暫停來源', status: 'paused', class: 'source-paused', reason: '領域暫停／種子移除', detail: '', at: '', extra: { kind: 'grid' } })
            assert.equal(by('src-paused-reason').reason, '種子檔已移除')
            // 約定:停用且暫停並存,列為停用,暫停以 extra.paused 註記
            assert.deepEqual([by('src-both').status, by('src-both').class, by('src-both').extra], ['disabled', 'source-disabled', { kind: 'rss', paused: true }])
            assert.equal(by('src-ok'), undefined)
            assert.equal(by('src-ok-nofield'), undefined)
            // 規則:clues:label＝`${type}:${value}`、reason＝lastError、at＝failedAt／evictedAt、extra＝{ tries, chainFails, hits }
            assert.deepEqual(by('c-failed'), { object: 'clues', id: 'c-failed', url: '', label: 'keyword:關鍵詞甲', status: 'failed', class: 'clue-failed', reason: 'timeout', detail: '', at: T(1), extra: { tries: 2, chainFails: 1, hits: 3 } })
            assert.deepEqual([by('c-site').url, by('c-site').label], ['https://sub.example.org/news', 'site:https://sub.example.org/news'], 'site 型線索之 value 即網址(供 host 篩選)')
            // 約定:淘汰者之原因為上限淘汰;曾有之 lastError 屬更早之失敗,記於 detail
            assert.deepEqual([by('c-evicted').reason, by('c-evicted').detail, by('c-evicted').at], ['逾待探索上限而淘汰（再被提及即復活）', '', T(3)])
            assert.deepEqual([by('c-evicted-err').reason, by('c-evicted-err').detail], ['逾待探索上限而淘汰（再被提及即復活）', '舊失敗'])
            assert.equal(by('c-pend'), undefined)
            assert.equal(by('c-done'), undefined)
            // 規則:areas:label＝label、reason＝reason、at＝updatedAt／pausedAt、extra＝{ query, statusBy };id 以 _meta 開頭者為中繼記錄須排除
            assert.deepEqual(by('a-rej'), { object: 'areas', id: 'a-rej', url: '', label: '被拒領域', status: 'rejected', class: 'area-rejected', reason: '驗證未過：計數 50 < 200', detail: '', at: T(2), extra: { query: 'q rej', statusBy: 'auto' } })
            assert.equal(by('a-pause').at, T(4), 'paused 取 pausedAt(updatedAt 較新亦不採)')
            assert.equal(by('a-pause-manual').at, T(2), '無 pausedAt(手動暫停)退取 updatedAt')
            assert.equal(by('a-ret').at, T(4))
            assert.equal(by('a-act'), undefined)
            assert.deepEqual([by('_meta'), by('_meta-x')], [undefined, undefined])
            // 規則:refetch:id＝docId、reason＝outcome、detail＝why、at＝帳之 at、extra＝{ method };同 id 取最後一行;壞行略過
            assert.deepEqual(by('rf1'), { object: 'refetch', id: 'rf1', url: 'https://a.example.com/rf1', label: '回溯甲', status: 'identity-mismatch', class: 'refetch-identity-mismatch', reason: 'identity-mismatch', detail: '標題與正文不符', at: T(2), extra: { method: 'article' } })
            assert.deepEqual([by('rf3').class, by('rf3').detail, by('rf3').extra], ['refetch-not-found', 'API 查無此記錄', { method: 'openalex-doi' }])
            // 規則:archived 不列為剔除(rf2 已另存)
            assert.equal(by('rf2'), undefined)
        })

        it('counts:`物件:狀態:類別` 計全部符合篩選者(全集 25 列);rows 依 at 新到舊、同時刻依物件順序再依 id、無 at 者排後', async () => {
            const r = await list()
            // 規則:counts:{ '<object>:<status>:<class>': n }(全部符合篩選者)
            assert.deepEqual(r.counts, {
                'areas:paused:area-paused': 2,
                'areas:rejected:area-rejected': 1,
                'areas:retired:area-retired': 1,
                'clues:evicted:clue-evicted': 2,
                'clues:failed:clue-failed': 2,
                'docs:aggregated:aggregated': 1,
                'docs:dead:http-final': 1,
                'docs:dead:render': 1,
                'docs:dead:unclassified': 1,
                'docs:skip:duplicate': 3,
                'docs:skip:material': 1,
                'docs:skip:routine': 1,
                'docs:skip:unclassified': 1,
                'docs:summarize-failed:summarize-failed': 1,
                'refetch:identity-mismatch:refetch-identity-mismatch': 1,
                'refetch:not-found:refetch-not-found': 1,
                'sources:disabled:source-disabled': 2,
                'sources:paused:source-paused': 2,
            })
            assert.equal(r.rows.length, 25)
            assert.equal(Object.values(r.counts).reduce((a, b) => a + b, 0), 25)
            // 排序(約定):T(1) 之 docs 先於 clues;T(2) 依 docs／sources／areas／refetch;同物件依 id;T(3) 依 docs／clues／refetch
            assert.deepEqual(r.rows.slice(0, 10).map((x) => x.id), ['dead-final', 'c-failed', 'dead-lastclass', 'src-dis', 'a-pause-manual', 'a-rej', 'rf1', 'skip-dup', 'c-evicted', 'rf3'])
            const firstEmpty = r.rows.findIndex((x) => x.at === '')
            assert.ok(firstEmpty > 0 && r.rows.slice(firstEmpty).every((x) => x.at === ''), '無 at 者全排在有 at 者之後')
            assert.deepEqual(r.rows.slice(0, firstEmpty).map((x) => Date.parse(x.at)), r.rows.slice(0, firstEmpty).map((x) => Date.parse(x.at)).sort((a, b) => b - a))
        })
    })

    describe('rejectListOf:篩選', function() {

        it('status／class(各為陣列,同鍵內為「或」、鍵間為「且」);objects 只列所選物件且只需所選物件之集合', async () => {
            // 規則:opt.status(陣列)
            assert.deepEqual(ids(await list({ status: ['paused'] })), ['a-pause', 'a-pause-manual', 'src-paused', 'src-paused-reason'])
            assert.deepEqual(ids(await list({ status: ['skip', 'aggregated'] })), ['agg', 'skip-dup', 'skip-dup-dead', 'skip-dup-missing', 'skip-material', 'skip-old', 'skip-routine'])
            // 規則:opt.class(陣列)
            assert.deepEqual(ids(await list({ class: ['duplicate'] })), ['skip-dup', 'skip-dup-dead', 'skip-dup-missing'])
            assert.deepEqual(ids(await list({ class: ['http-final', 'refetch-not-found'] })), ['dead-final', 'rf3'])
            assert.deepEqual(ids(await list({ status: ['skip'], class: ['routine', 'http-final'] })), ['skip-routine'])
            // 約定:逗號字串亦收,CLI 薄殼可直接傳
            assert.deepEqual(ids(await list({ class: 'duplicate,routine' })), ['skip-dup', 'skip-dup-dead', 'skip-dup-missing', 'skip-routine'])
            // 規則:opt.objects(陣列,預設 ['docs','sources','clues','areas','refetch'])
            const only = await rejectListOf({ sources: memStore(SOURCES()), frontier: memStore(CLUES()) }, { objects: ['sources', 'clues'], nowMs: NOW_MS })
            assert.deepEqual([...new Set(only.rows.map((x) => x.object))].sort(), ['clues', 'sources'])
            assert.deepEqual(Object.keys(only.pending).sort(), ['clues', 'sources'], 'pending 只含所選物件')
            assert.equal(Object.keys(only.counts).every((k) => /^(sources|clues):/.test(k)), true)
            // 約定:只列回溯而無 docs 集合 → 照列,網址與標題(須查文件才有)留空
            const rfOnly = await rejectListOf({}, { objects: ['refetch'], ledgerFile: LEDGER, nowMs: NOW_MS })
            assert.deepEqual(rfOnly.rows.map((x) => [x.id, x.url, x.label]).sort(), [['rf1', '', ''], ['rf3', '', '']])
        })

        it('host:主機含子網域尾端比對(example.com 配 a.example.com,不配 notexample.com);不分大小寫;可給網址;無網址之列(領域、關鍵詞線索、無 url 文件)不符', async () => {
            // 規則:opt.host(主機,含子網域尾端比對)
            const expected = ['dead-final', 'rf1', 'skip-dup', 'src-both', 'src-dis']
            assert.deepEqual(ids(await list({ host: 'example.com' })), expected)
            assert.deepEqual(ids(await list({ host: 'a.example.com' })), ['dead-final', 'rf1', 'skip-dup'], '子網域精確')
            // 規則:無網址者不能證明屬該主機 → 不符(領域、關鍵詞線索、無 url 之文件皆不在上列結果內)
            // 約定:輸入正規化——不分大小寫、前導 *. 忽略、給網址取其主機(與 deadMatcher 同一比對函數)
            assert.deepEqual(ids(await list({ host: 'EXAMPLE.COM' })), expected, '不分大小寫')
            assert.deepEqual(ids(await list({ host: '*.example.com' })), expected, '前導 *. 忽略')
            assert.deepEqual(ids(await list({ host: 'https://a.example.com/some/path' })), ['dead-final', 'rf1', 'skip-dup'], '給網址取其主機')
            assert.deepEqual(ids(await list({ host: 'example.org' })), ['agg', 'c-site', 'dead-lastclass', 'skip-dup-dead', 'skip-dup-missing', 'skip-material', 'skip-routine', 'sumfail'])
            assert.deepEqual(ids(await list({ host: 'notexample.com' })), ['dead-old'], '尾端錨定:notexample.com 只配自己')
            // counts 隨篩選(只計符合者)
            assert.deepEqual((await list({ host: 'a.example.com' })).counts, { 'docs:dead:http-final': 1, 'docs:skip:duplicate': 1, 'refetch:identity-mismatch:refetch-identity-mismatch': 1 })
        })

        it('since:以決定時刻 at 比較(含邊界);無 at 者排除;可帶時區偏移;paused 領域取 pausedAt', async () => {
            // 規則:opt.since(ISO 字串;以該列之「決定時刻」at 比較,無 at 者在給 since 時排除)
            const since = '2026-10-02T12:00:00+08:00' // ＝ T(3)
            assert.equal(Date.parse(since), Date.parse(T(3)))
            assert.deepEqual(ids(await list({ since })), ['a-pause-manual', 'a-rej', 'c-evicted', 'c-failed', 'dead-final', 'dead-lastclass', 'rf1', 'rf3', 'skip-dup', 'src-dis'])
            // 無 at 之列(dead-old、agg、sumfail、暫停之來源)不在其中;不給 since 則在
            const none = ids(await list())
            for (const id of ['dead-old', 'agg', 'sumfail', 'src-paused', 'src-paused-reason']) assert.equal(none.includes(id), true, id)
            // 極近之 since:空
            assert.deepEqual((await list({ since: T(0.5) })).rows, [])
            // 與其他篩選並用(且)
            assert.deepEqual(ids(await list({ since, host: 'example.com' })), ['dead-final', 'rf1', 'skip-dup', 'src-dis'])
        })

        it('limit 只截斷 rows;counts 與 pending 不受 limit(也不受任何篩選)影響', async () => {
            const full = await list()
            // 規則:opt.limit(rows 上限;counts 與 pending 不受 limit 影響)
            const cut = await list({ limit: 3 })
            assert.deepEqual(cut.rows.map((x) => x.id), ['dead-final', 'c-failed', 'dead-lastclass'], '截斷取最新者')
            assert.deepEqual(cut.counts, full.counts)
            assert.deepEqual(cut.pending, full.pending)
            // 約定:limit 非正整數 → 不限(同 refetchSources 之 limit 慣例)
            for (const bad of [0, -1, 1.5, 'x', undefined]) assert.equal((await list({ limit: bad })).rows.length, 25, `limit=${bad}`)
            // 規則:pending(待辦總表,不受篩選影響)
            const filtered = await list({ status: ['dead'], class: ['http-final'], host: 'nowhere.test', since: T(0.1), limit: 1 })
            assert.deepEqual(filtered.rows, [])
            assert.deepEqual(filtered.counts, {})
            assert.deepEqual(filtered.pending, full.pending)
        })

        it('錯誤輸入拋錯而不靜默放寬:未知物件、所需集合缺、since 無法解析、host 無效、stores 非物件', async () => {
            // 約定:錯誤輸入一律拋錯——靜默忽略會讓篩選丟失而範圍放寬(同 reviveDeadDocs 之嚴格解析原則)
            await assert.rejects(() => list({ objects: ['bogus'] }), /未知物件「bogus」/)
            await assert.rejects(() => rejectListOf({ docs: memStore([]) }, { objects: ['sources'] }), /需要 stores\.sources/)
            await assert.rejects(() => rejectListOf({}, { objects: ['clues'] }), /需要 stores\.frontier/)
            await assert.rejects(() => rejectListOf({}, { objects: ['areas'] }), /需要 stores\.areas/)
            await assert.rejects(() => rejectListOf({}, { objects: ['docs'] }), /需要 stores\.docs/)
            await assert.rejects(() => list({ since: 'garbage' }), /since 須為可解析/)
            await assert.rejects(() => list({ host: '*.' }), /host 須為主機名/)
            await assert.rejects(() => rejectListOf(null, {}), /需要 stores 物件/)
        })
    })

    describe('rejectListOf:待辦總表', function() {

        it('docs:new 之組成(瀏覽器佇列／補全文退避中／未試／重試,互斥且和＝總數)、raw、摘要失敗、段落鍵無原文;各類最舊天數之時間欄', async () => {
            const { pending } = await list()
            // 規則:docs:`new` 之組成——瀏覽器佇列(fetcher==='browser')、補全文退避中(retryAt 晚於 nowMs)、補全文未試(fetchTries 為 0 且不在退避)、補全文重試(其餘)
            // 規則:各類之「最舊天數」(瀏覽器佇列以 deferredAt、補全文以 collectedAt、raw 以 rawAt)
            assert.deepEqual(pending.docs, {
                new: {
                    total: 8,
                    browser: { count: 2, oldestDays: 9 }, // new-browser(deferredAt 2 天;collectedAt 30 天不採)、new-browser-backoff(無 deferredAt,取 collectedAt 9 天);有 retryAt 者仍屬瀏覽器佇列
                    backoff: { count: 1, oldestDays: 20 }, // new-backoff
                    untried: { count: 3, oldestDays: 8 }, // fetchTries 0／缺欄／retryAt 已過
                    retry: { count: 2, oldestDays: 5 }, // new-retry(3 天)、new-retry-pastretry(5 天)
                },
                raw: { count: 2, oldestDays: 4 }, // rawAt 4 天(collectedAt 50 天不採)
                summarizeFailed: { count: 1 },
                paraKeysNoText: { count: 2 }, // noted 中 paraKeysNoText 為真者(時間字串與 true 皆算)
            })
            const n = pending.docs.new
            assert.equal(n.browser.count + n.backoff.count + n.untried.count + n.retry.count, n.total, '四組互斥且和為 new 總數')
            // 規則:opt.nowMs(待辦之退避判斷用,預設 Date.now())——不給 nowMs 時以實際現在判:遠未來之 retryAt 在退避、遠過去者不在(重試組)
            const dflt = await rejectListOf({ docs: memStore([
                { id: 'far', status: 'new', fetchTries: 1, retryAt: '2999-01-01T00:00:00Z', collectedAt: T(1) },
                { id: 'old', status: 'new', fetchTries: 1, retryAt: '2000-01-01T00:00:00Z', collectedAt: T(1) },
            ]) }, { objects: ['docs'] })
            assert.deepEqual([dflt.pending.docs.new.backoff.count, dflt.pending.docs.new.retry.count], [1, 1])
        })

        it('docs:new 之組成依 opt.capture 之瀏覽器佇列開關,與補全文段同一分法(core/stores/docPolicy docQueueStatsOf):停用時指名瀏覽器之件併回補全文佇列(此前一律另列瀏覽器佇列);開啟或未給同預設', async () => {
            const base = (await list({ objects: ['docs'] })).pending.docs.new
            assert.deepEqual((await list({ objects: ['docs'], capture: { browser: { perRun: 3 } } })).pending.docs.new, base)
            // new-browser(無 tries → 未試,collectedAt 30 天)、new-browser-backoff(retryAt 未到 → 退避中,collectedAt 9 天)併回補全文
            assert.deepEqual((await list({ objects: ['docs'], capture: { browser: { perRun: 0 } } })).pending.docs.new, {
                total: 8, browser: { count: 0, oldestDays: null }, backoff: { count: 2, oldestDays: 20 }, untried: { count: 4, oldestDays: 30 }, retry: { count: 2, oldestDays: 5 },
            })
        })

        it('clues／sources／areas／refetch:各 status 計數(含 0 之已知狀態)、pending 中退避者、啟用／停用／暫停、領域不含中繼記錄、回溯各 outcome(含 archived)', async () => {
            const { pending } = await list()
            // 規則:clues:各 status 計數(pending／done／failed／evicted)與 pending 中退避中(retryAt 晚於 now)者
            assert.deepEqual(pending.clues, { total: 7, byStatus: { pending: 2, done: 1, failed: 2, evicted: 2 }, backoff: 1 })
            const empty = await rejectListOf({ frontier: memStore([{ id: 'x', type: 'keyword', value: 'v', status: 'weird' }]) }, { objects: ['clues'], nowMs: NOW_MS })
            // 約定:已知四態缺者列 0(待辦表不得因沒有該行而被讀成沒有此狀態);未知狀態照列
            assert.deepEqual(empty.pending.clues.byStatus, { pending: 0, done: 0, failed: 0, evicted: 0, weird: 1 })
            // 規則:sources:啟用、停用、暫停計數
            assert.deepEqual(pending.sources, { total: 6, enabled: 4, disabled: 2, paused: 3 })
            // 規則:areas:各 status 計數(_meta 開頭者排除)
            assert.deepEqual(pending.areas, { total: 5, byStatus: { rejected: 1, paused: 2, retired: 1, active: 1 } })
            // 規則:refetch:各 outcome 計數(含 archived);同 id 取最後一行、壞行略過
            assert.deepEqual(pending.refetch, { total: 3, byOutcome: { 'identity-mismatch': 1, archived: 1, 'not-found': 1 } })
        })

        it('回溯帳不存在(或未給路徑)即略過:無 refetch 列、待辦為空;不因此拋錯、不建立檔案', async () => {
            const missing = `${TMP}/nostate/refetch-sources.jsonl`
            for (const ledgerFile of [missing, undefined, '']) {
                const r = await rejectListOf(stores(), { objects: ['refetch'], ledgerFile, nowMs: NOW_MS })
                assert.deepEqual([r.rows, r.counts, r.pending.refetch], [[], {}, { total: 0, byOutcome: {} }])
            }
            assert.equal(fs.existsSync(`${TMP}/nostate`), false, '純讀:不建立回溯帳與其目錄')
        })
    })

    describe('純讀', function() {

        it('只呼叫集合之 select(get 亦可);patch／insertNew／replace／del 一旦被呼叫即拋錯;回溯帳內容與 mtime 不變', async () => {
            const calls = []
            const spy = { docs: spyStore(DOCS(), calls, 'docs'), sources: spyStore(SOURCES(), calls, 'sources'), frontier: spyStore(CLUES(), calls, 'frontier'), areas: spyStore(AREAS(), calls, 'areas') }
            const before = { text: fs.readFileSync(LEDGER, 'utf8'), mtime: fs.statSync(LEDGER).mtimeMs }
            // 規則:純讀:不得呼叫任何 patch／insert／replace／del——替身於寫入類方法被呼叫時拋錯,故能跑完即證明未呼叫
            const r = await rejectListOf(spy, { nowMs: NOW_MS, ledgerFile: LEDGER, status: ['dead', 'paused'], host: 'example.com', since: T(30), limit: 5 })
            assert.ok(r.rows.length > 0)
            const used = [...new Set(calls)].sort()
            assert.deepEqual(used.filter((c) => !/\.(select|get)$/.test(c)), [], '只用 select／get')
            assert.deepEqual(used, ['areas.select', 'docs.select', 'frontier.select', 'sources.select'])
            const after = { text: fs.readFileSync(LEDGER, 'utf8'), mtime: fs.statSync(LEDGER).mtimeMs }
            assert.deepEqual(after, before, '回溯帳未被改')
            // 替身確實會在寫入時拋錯(替身本身有效)
            await assert.rejects(() => spy.docs.patch('x', {}), /純讀違規/)
            await assert.rejects(() => spy.sources.insertNew([]), /純讀違規/)
            await assert.rejects(() => spy.frontier.replace({ id: 'x' }), /純讀違規/)
            await assert.rejects(() => spy.areas.del('x'), /純讀違規/)
        })
    })

    describe('rowsToCsv', function() {

        it('UTF-8 BOM 開頭、欄名列、列間 CRLF;RFC 4180 跳脫(逗號／雙引號／換行)後以獨立剖析器還原與原列逐欄一致;extra 為 JSON 字串一欄(無資料為 {})', async () => {
            const r = await list()
            const nasty = { object: 'docs', id: 'x"y', url: 'https://e.com/?a=1,2', label: '多行\n標題,含"引號"', status: 'dead', class: 'unclassified', reason: 'a\r\nb', detail: '|pipe|;\'單引號\'', at: '', extra: { note: '含,逗號與"引號"', n: 0, flag: false } }
            const rows = [...r.rows, nasty]
            const csv = rowsToCsv(rows)
            // 規則:UTF-8 BOM 開頭
            assert.equal(csv.charCodeAt(0), 0xfeff)
            assert.ok(csv.startsWith(`${BOM}object,id,url,label,status,class,reason,detail,at,extra\r\n`))
            assert.ok(csv.endsWith('\r\n'))
            // 規則:RFC 4180 跳脫、extra 以 JSON 字串一欄
            const parsed = parseCsv(csv.slice(1))
            assert.equal(parsed.length, rows.length + 1, '列數＝標頭＋資料列(換行不致撕裂列)')
            assert.deepEqual(parsed[0], ['object', 'id', 'url', 'label', 'status', 'class', 'reason', 'detail', 'at', 'extra'])
            for (let i = 0; i < rows.length; i++) {
                const f = parsed[i + 1]
                assert.equal(f.length, 10, `第 ${i + 1} 列欄數`)
                for (const [k, c] of ['object', 'id', 'url', 'label', 'status', 'class', 'reason', 'detail', 'at'].entries()) assert.equal(f[k], rows[i][c], `第 ${i + 1} 列 ${c}`)
                assert.deepEqual(JSON.parse(f[9]), rows[i].extra, `第 ${i + 1} 列 extra`)
            }
            assert.equal(parsed[1][9], JSON.stringify(r.rows[0].extra))
            // 無 extra 者為 {}(恆為可 JSON.parse 之值)
            assert.equal(parseCsv(rowsToCsv([{ id: 'z' }]).slice(1))[1][9], '{}')
            // 約定:非陣列視為空,只有欄名列
            assert.equal(rowsToCsv(null), `${BOM}object,id,url,label,status,class,reason,detail,at,extra\r\n`)
            // 只在需要時加引號(逗號、引號、換行);一般欄位不加
            assert.ok(csv.split('\r\n')[1].startsWith('docs,dead-final,https://a.example.com/p1,終態404,dead,http-final,http-error,HTTP 404,'))
        })
    })

    describe('rowsToMd', function() {

        it('先待辦總表、再計數表、再逐列表;表格內之「|」與換行跳脫(含反斜線緊鄰「|」),表格列不斷行且欄數固定', async () => {
            const r = await list()
            const nasty = { object: 'docs', id: 'x1', url: 'https://e.com/?q=a|b', label: 'a|b', status: 'dead', class: 'unclassified', reason: 'line1\nline2', detail: 'c\\|d', at: '', extra: { k: 'v|w' } }
            const md = rowsToMd([...r.rows, nasty], { counts: r.counts, pending: r.pending, title: '測試報告', note: '產出 2026-10-05' })
            // 規則:先待辦總表、再計數表、再逐列表
            const iPending = md.indexOf('## 待辦總表')
            const iCounts = md.indexOf('## 計數')
            const iList = md.indexOf('## 清單')
            assert.ok(md.startsWith('# 測試報告\n\n產出 2026-10-05\n\n## 待辦總表'))
            assert.ok(iPending > 0 && iPending < iCounts && iCounts < iList)
            // 待辦與計數之內容取自 pending／counts(規則:先待辦總表、再計數表);列之標籤字樣、title／note 選項為約定
            assert.ok(md.includes('| docs | 待補全文合計（new，含瀏覽器佇列） | 8 |  |'))
            assert.ok(md.includes('| docs | 　瀏覽器佇列（fetcher=browser） | 2 | 9 |'))
            assert.ok(md.includes('| docs | 待摘要（raw） | 2 | 4 |'))
            assert.ok(md.includes('| clues | 　pending 中退避中（retryAt 未到） | 1 |  |'))
            assert.ok(md.includes('| docs | skip | duplicate | 3 |'))
            // 規則:表格內 | 與換行須跳脫——「|」→「\|」;反斜線緊鄰「|」者先加倍;換行壓成空白
            const line = md.split('\n').find((l) => l.startsWith('| docs | x1 |'))
            assert.equal(line, '| docs | x1 | dead | unclassified | a\\|b | line1 line2 | c\\\\\\|d |  | https://e.com/?q=a\\|b | k=v\\|w |')
            assert.equal(line.split(/(?<!\\)\|/).length, 12, '10 欄＝11 個未跳脫之「|」')
            // 每個資料列各占一行(換行不撕裂表格):清單區之表格列數＝列數＋2(欄名與分隔線)
            const table = md.slice(iList).split('\n').filter((l) => l.startsWith('|'))
            assert.equal(table.length, r.rows.length + 1 + 2)
            // 約定:逐列表之欄位配置;extra 逐項寫為 k=v 置於附註欄(CSV 才是 JSON 字串一欄)
            assert.ok(md.includes('httpCode=404；deadBy=detailFetch；fetchTries=3；fetchChainFails=2；sourceName=來源甲'))
        })

        it('未給 counts 由 rows 計;未給 pending 不列待辦總表;list:false 不列逐列表;被 limit 截斷者標明', async () => {
            // 規則:rowsToMd(rows, { counts, pending });其餘(list 選項、截斷標示、預設標題)為約定
            const r = await list({ limit: 4 })
            const noPending = rowsToMd(r.rows)
            assert.equal(noPending.includes('## 待辦總表'), false)
            assert.ok(noPending.includes('## 計數（物件／狀態／類別；共 4 筆）'), '未給 counts → 由 rows 計')
            assert.ok(noPending.includes('## 清單（4 列）'))
            const cut = rowsToMd(r.rows, { counts: r.counts, pending: r.pending })
            assert.ok(cut.includes('## 清單（4 列；符合 25 列，已截斷）'), '給 counts 時標明截斷')
            const noList = rowsToMd([], { counts: r.counts, pending: r.pending, list: false })
            assert.equal(noList.includes('## 清單'), false)
            assert.ok(noList.includes('## 待辦總表') && noList.includes('## 計數'))
            // 非陣列 rows 視為空;預設標題
            assert.ok(rowsToMd(undefined).startsWith('# 剔除清單與待辦總表\n'))
        })
    })
})
