// unit-core-shared.test.mjs — 下游套件共用之核心件(本套件之核心模組,供摘要等下游套件經主入口取用,不另寫一份):
//   standards/verdict.fromProblems、util/text.slugify／cutAtBoundary、kernel.mergeTaps、settingsDefault.mergeSettingsGroup(含 opt.types)／
//   cloneSettingsDefault／seatOrNull 型別、captureRuntime 之 conceptFoldsOf／captureIdentityOf／captureNetGuardOf(與抓取執行期件同一判準),
//   以及主入口確實轉出上列各名與經 core/runnerPackage 取用之件(reserveOf／reserveMsOf;其行為之測試隨件在 w-data-pipeline 套件內)及本套件 core/util/fileIo 之 readJson／writeFileAtomic
// 執行:自套件根 npx mocha test/unit-core-shared.test.mjs(暫存落 test/_tmp/core-shared-<pid>,測完即刪;不發網路)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineMw, applyTaps, mergeTaps, MwContractError } from '../src/core/kernel.mjs'
import { reserveOf, reserveMsOf } from '../src/core/runnerPackage.mjs'
import { readJson, writeFileAtomic } from '../src/core/util/fileIo.mjs'
import { queueAge } from '../src/core/util/queueAge.mjs'
import { STATUS, result, fromProblems } from '../src/core/standards/verdict.mjs'
import { sha1, slugify, slugSuffixOf, SLUG_SUFFIX_CHARS, cutAtBoundary } from '../src/core/util/text.mjs'
import { SETTING_TYPES, mergeSettingsGroup, cloneSettingsDefault, resolveSettings } from '../src/core/settingsDefault.mjs'
import { conceptFoldsOf, captureIdentityOf, captureNetGuardOf, createCaptureRuntime } from '../src/captureRuntime.mjs'
import { DEFAULT_DEDUP, textFromLabelOf } from '../src/core/util/records.mjs'
import { composeNamespaces } from '../src/core/util/entry.mjs'
import { VOCAB_DEFAULT, CAPTURE_VOCAB_KEYS, captureVocabDefaultOf, resolveVocab } from '../src/core/vocab/vocabDefault.mjs'
import { subOpt } from '../src/captureObject.mjs'
import { expandDirs } from '../src/core/dirs.mjs'
import WKnowledgeCapture from '../src/WKnowledgeCapture.mjs'
import * as WNamed from '../src/WKnowledgeCapture.mjs'

const TMP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), `_tmp/core-shared-${process.pid}`).replace(/\\/g, '/')

describe('unit-core-shared', function() {

    before(function() {
        fs.rmSync(TMP, { recursive: true, force: true })
        fs.mkdirSync(TMP, { recursive: true })
    })

    after(function() {
        fs.rmSync(TMP, { recursive: true, force: true })
    })

    describe('standards/verdict.fromProblems', function() {

        it('有問題 → 不合格且列前 n 項(其餘註明總數);無問題或非陣列 → 合格;空值略過', () => {
            assert.deepEqual(fromProblems('X1', []), result('X1', STATUS.PASS))
            assert.deepEqual(fromProblems('X1', null), result('X1', STATUS.PASS))
            assert.deepEqual(fromProblems('X1', ['', null]), result('X1', STATUS.PASS))
            const r = fromProblems('X1', ['a', 'b'])
            assert.equal(r.status, STATUS.VIOLATION)
            assert.equal(r.detail, 'a；b')
            const many = fromProblems('X1', ['1', '2', '3', '4', '5', '6', '7'], 5)
            assert.equal(many.detail, '1；2；3；4；5；…共 7 處')
            assert.equal(fromProblems('X1', ['1', '2', '3'], 2).detail, '1；2；…共 3 處')
        })
    })

    describe('util/text.slugify／cutAtBoundary', function() {

        it('slugify:保留中英數、其餘轉連字號、尾綴 8 碼 sha1(種子優先於標題);格式固定', () => {
            assert.equal(slugify('Hello World'), 'hello-world-0a4d55a8')
            assert.equal(slugify('Transformer 注意力機制！！', 'k1'), 'transformer-注意力機制-a2ab1959')
            assert.equal(slugify('Hello World', 'seed').slice(-8), sha1('seed').slice(0, 8))
            assert.match(slugify('！！！', 'x'), /^note-[0-9a-f]{8}$/, '無保留字元者以 note 開頭')
            assert.ok(slugify('a'.repeat(100)).length <= 48 + 9, '主體至多 48 字')
            assert.match(slugify(''), /^note-[0-9a-f]{8}$/, '空標題亦產生(亂數種子)')
        })

        it('slugSuffixOf:格式之單一解析(「-」＋ SLUG_SUFFIX_CHARS 碼小寫十六進位結尾)——slugify 之產物必解析回其尾碼;無尾碼、大寫、碼數不符、非字串回空;下游之尾碼容錯以之比對,不另寫正則', () => {
            assert.equal(SLUG_SUFFIX_CHARS, 8)
            assert.equal(slugSuffixOf(slugify('Hello World')), '0a4d55a8')
            assert.equal(slugSuffixOf(slugify('Transformer 注意力機制！！', 'k1')), 'a2ab1959')
            assert.equal(slugSuffixOf(' hello-world-0a4d55a8 '), '0a4d55a8', '前後空白不計')
            for (const x of ['hello-world', 'x-0A4D55A8', 'x-0a4d55a', 'x0a4d55a8', '', null, undefined, 12]) assert.equal(slugSuffixOf(x), '', String(x))
        })

        it('cutAtBoundary:未逾上限原樣;逾上限截至上限內最後之界;上限內無界或截後有效字數不足即不截', () => {
            const s = '2015-01 至 2025-08；另 2018-2024'
            assert.deepEqual(cutAtBoundary(s, 20, { boundaryRe: /[；;，,]/g }), { text: '2015-01 至 2025-08；', cut: true, from: 29 })
            assert.deepEqual(cutAtBoundary(s, 12, { boundaryRe: /[；;，,]/g }), { text: s, cut: false, from: 29 })
            assert.deepEqual(cutAtBoundary('短句。', 10), { text: '短句。', cut: false, from: 3 })
            assert.deepEqual(cutAtBoundary('第一句。第二句很長很長', 6), { text: '第一句。', cut: true, from: 11 }, '預設界為句末標點')
            assert.deepEqual(cutAtBoundary('。後面很長很長很長', 5), { text: '。後面很長很長很長', cut: false, from: 9 }, '截後無有效字即不截')
            assert.equal(cutAtBoundary('a  b\n c', 0).text, 'a b c', '上限非正整數不截,只收空白')
            assert.equal(cutAtBoundary('a，b，c', 4, { boundaryRe: /，/ }).text, 'a，b，', 'boundaryRe 未帶 g 者自動補 g')
        })
    })

    describe('kernel.mergeTaps', function() {

        const mw = (name) => defineMw({ name, handle: (m, c, n) => n(m) })

        it('before／after／add 依序串接;任一方非物件即回另一方;雙方皆 replace 拋錯(訊息含標籤與錨點)', () => {
            const A = mw('A')
            const B = mw('B')
            const C = mw('C')
            const m = mergeTaps({ x: { before: [A] } }, { x: { before: [B], after: [C] }, y: { after: [A] } }, 'obj.sub')
            assert.deepEqual(m.x.before.map((z) => z.name), ['A', 'B'])
            assert.deepEqual(m.x.after.map((z) => z.name), ['C'])
            assert.deepEqual(m.y.after.map((z) => z.name), ['A'])
            const only = { x: { after: [A] } }
            assert.equal(mergeTaps(undefined, only), only)
            assert.equal(mergeTaps(only, null), only)
            assert.equal(mergeTaps(null, undefined), undefined)
            assert.deepEqual(mergeTaps({ x: { replace: A } }, { x: { after: [B] } }).x.replace, A, '單方 replace 保留')
            assert.throws(() => mergeTaps({ x: { replace: A } }, { x: { replace: B } }, 'obj.sub'), (e) => e instanceof MwContractError && /obj\.sub 錨點\[x\] 之 replace 衝突/.test(e.message))
        })

        it('subOpt(物件之平鋪 opts 與子階段 opts 合併):子階段鍵優先;tap 以 mergeTaps 合併(雙方皆 replace 拋錯);未給子階段者即平鋪之複本', () => {
            const a = defineMw({ name: 'a', handle: async (m, c, n) => n(m) })
            const b = defineMw({ name: 'b', handle: async (m, c, n) => n(m) })
            const flat = { x: 1, y: 2, tap: { anchor: { before: [a] } } }
            const out = subOpt(flat, { y: 3, tap: { anchor: { after: [b] } } }, 'obj.sub')
            assert.equal(out.x, 1)
            assert.equal(out.y, 3, '子階段鍵優先')
            assert.deepEqual([out.tap.anchor.before, out.tap.anchor.after], [[a], [b]], 'tap 合併而非覆蓋')
            const plain = subOpt({ x: 1 }, undefined, 'obj.sub')
            assert.deepEqual(plain, { x: 1 })
            assert.equal('tap' in plain, false, '雙方皆無 tap 者不產生 tap 鍵')
            assert.throws(() => subOpt({ tap: { anchor: { replace: a } } }, { tap: { anchor: { replace: b } } }, 'obj.sub'), /obj\.sub/)
        })

        it('合併結果可交 applyTaps 套用(串接順序即執行順序)', () => {
            const core = mw('core')
            const chain = applyTaps([core], mergeTaps({ core: { before: [mw('p1')] } }, { core: { before: [mw('p2')], after: [mw('q')] } }), { chainName: 't' })
            assert.deepEqual(chain.map((z) => z.name), ['p1', 'p2', 'core', 'q'])
        })
    })

    describe('settingsDefault.mergeSettingsGroup／cloneSettingsDefault／seatOrNull(下游套件以同一規則驗其設定段)', function() {

        const SCHEMA = { n: 'pint', on: 'bool', seat: 'seatOrNull', grp: { r: 'ratio' } }
        const DFLT = { n: 1, on: true, seat: null, grp: { r: 0.5 } }

        it('逐鍵覆寫、未給沿用預設(複本,不共用預設之參照);undefined／null 之組視為未給', () => {
            const g = mergeSettingsGroup('x', { n: 5, grp: { r: 0.2 } }, SCHEMA, DFLT)
            assert.deepEqual(g, { n: 5, on: true, seat: null, grp: { r: 0.2 } })
            assert.deepEqual(mergeSettingsGroup('x', null, SCHEMA, DFLT), DFLT)
            const c = mergeSettingsGroup('x', undefined, SCHEMA, DFLT)
            c.grp.r = 0.9
            assert.equal(DFLT.grp.r, 0.5, '預設常數不被汙染')
            const d = { a: [1, { b: 2 }], f: () => 1, re: /x/ }
            const cd = cloneSettingsDefault(d)
            assert.ok(cd.a !== d.a && cd.a[1] !== d.a[1] && cd.f === d.f && cd.re === d.re, '陣列與物件遞迴複製;函數與 RegExp 原樣')
        })

        it('未知鍵、型別不符、組非物件皆拋錯(訊息含完整路徑);schema 引用不存在之型別名亦拋', () => {
            assert.throws(() => mergeSettingsGroup('x', 'str', SCHEMA, DFLT), /settings\.x 須為物件/)
            assert.throws(() => mergeSettingsGroup('x', { bogus: 1 }, SCHEMA, DFLT), /settings\.x 含不認得之鍵：bogus（可用：n、on、seat、grp）/)
            assert.throws(() => mergeSettingsGroup('x', { grp: { r: 2 } }, SCHEMA, DFLT), /settings\.x\.grp\.r 須為\s?0～1 之數/)
            assert.throws(() => mergeSettingsGroup('x', { n: 1 }, { n: 'nope' }, { n: 1 }), /型別「nope」不存在/)
        })

        it('seatOrNull:null 或合格席位;席位之形狀問題與 seat 型別同一判準(seatProblem)', () => {
            assert.ok(SETTING_TYPES.seatOrNull.test(null))
            assert.ok(SETTING_TYPES.seatOrNull.test({ use: 'claude:sonnet', fallback: ['oc:opencode/big-pickle'] }))
            assert.ok(!SETTING_TYPES.seatOrNull.test({ use: '' }))
            assert.ok(!SETTING_TYPES.seatOrNull.test('claude:sonnet'))
            assert.throws(() => mergeSettingsGroup('x', { seat: { use: 'a', timeout: 1 } }, SCHEMA, DFLT), /settings\.x\.seat 須為席位物件.*含不認得之鍵：timeout/)
            assert.deepEqual(mergeSettingsGroup('x', { seat: { use: 'a' } }, SCHEMA, DFLT).seat, { use: 'a' })
        })

        it('opt.types:下游段之專屬型別與共用表合併(子組遞迴同用;同名以 opt 者為準);未給 opt 者與共用表同一行為;錯誤訊息之可用型別列合併後之全集', () => {
            const types = { modeEnum: { test: (v) => v === false || v === 'all', desc: "false｜'all'" } }
            const sch = { mode: 'modeEnum', sub: { mode: 'modeEnum', n: 'pint' } }
            const dflt = { mode: false, sub: { mode: false, n: 1 } }
            assert.deepEqual(mergeSettingsGroup('y', { mode: 'all', sub: { mode: 'all' } }, sch, dflt, { types }), { mode: 'all', sub: { mode: 'all', n: 1 } })
            assert.throws(() => mergeSettingsGroup('y', { sub: { mode: 'some' } }, sch, dflt, { types }), /settings\.y\.sub\.mode 須為false｜'all'，收到 "some"/, '子組同用專屬型別')
            assert.throws(() => mergeSettingsGroup('y', { mode: 'all' }, sch, dflt), /型別「modeEnum」不存在/, '未給 opt.types 者不認專屬型別')
            assert.throws(() => mergeSettingsGroup('y', { n: 1 }, { n: 'nope' }, { n: 1 }, { types }), /可用：.*modeEnum/, '可用型別列合併後之全集')
            const strict = { pint: { test: (v) => v === 7, desc: '7' } }
            assert.throws(() => mergeSettingsGroup('z', { n: 5 }, { n: 'pint' }, { n: 1 }, { types: strict }), /settings\.z\.n 須為7/, '同名以 opt 者為準')
            assert.deepEqual(mergeSettingsGroup('x', { n: 5 }, SCHEMA, DFLT, 'bad'), mergeSettingsGroup('x', { n: 5 }, SCHEMA, DFLT), 'opt 非物件視為未給')
        })

        it('本套件自身之設定解析改用同一函數後行為不變(ai、capture 之錯誤訊息與預設)', () => {
            const s = resolveSettings({ capture: { sources: { perRun: 9 } } })
            assert.equal(s.capture.sources.perRun, 9)
            assert.equal(s.capture.sources.itemsPerSource, 8)
            assert.throws(() => resolveSettings({ ai: { bogus: 1 } }), /settings\.ai 含不認得之鍵：bogus/)
        })
    })

    describe('captureRuntime 之共用判準(conceptFoldsOf／captureIdentityOf／captureNetGuardOf)', function() {

        it('conceptFoldsOf:false 停用、函數自訂(兩者同用)、未給或 true 用內建繁簡折疊;其他型別拋錯', () => {
            assert.deepEqual(conceptFoldsOf(false), { fold: null, clueFold: null })
            const f = (t) => t
            assert.deepEqual(conceptFoldsOf(f), { fold: f, clueFold: f })
            const d = conceptFoldsOf(undefined)
            assert.equal(d.fold('數據'), '数据', '分群折向簡體')
            assert.equal(d.clueFold('数据'), '數據', '線索鍵折向正體')
            assert.equal(conceptFoldsOf(true).fold('網路'), '网路')
            assert.throws(() => conceptFoldsOf('yes'), /cfg\.conceptFold 須為/)
        })

        it('captureIdentityOf:未給用 DEFAULT_DEDUP;與抓取執行期件之 identity 對同一網址得同一 id', () => {
            const a = captureIdentityOf()
            const b = captureIdentityOf(DEFAULT_DEDUP)
            const rt = createCaptureRuntime({ netGuard: null }, resolveSettings({}))
            const url = 'https://example.com/a?b=1'
            assert.equal(a.of({ url }), b.of({ url }))
            assert.equal(a.of({ url }), rt.identity.of({ url }), '下游登記文件之 id 與抓取入庫一致')
        })

        it('captureNetGuardOf:null＝不判斷;給判斷器者原樣使用並以其 confirmDown 回答 isNetDown;非物件拋錯', async () => {
            assert.deepEqual(captureNetGuardOf(null, {}), { netGuard: null, isNetDown: null })
            const g = { check: async () => true, confirmDown: async () => true, isDown: () => false, describe: () => '' }
            const r = captureNetGuardOf(g, {})
            assert.equal(r.netGuard, g)
            assert.equal(await r.isNetDown(), true)
            assert.equal(captureNetGuardOf({ check: async () => true }, {}).isNetDown, null, '無 confirmDown 者不交 AI 調度層')
            assert.throws(() => captureNetGuardOf('x', {}), /cfg\.netGuard 須為網路判斷器物件/)
            const built = captureNetGuardOf(undefined, resolveSettings({}).capture)
            assert.equal(typeof built.netGuard.confirmDown, 'function', '未給者依 capture.network 建立')
        })
    })

    describe('util/records.textFromLabelOf(內文取得方式之顯示名;下游不自解讀 textFrom)', function() {

        it('feed 與 abstract 另標,其餘(全文抓取器、站台 adapter、瀏覽器、未給)皆為原網頁全文;原型鏈上之名不誤中', () => {
            assert.equal(textFromLabelOf('feed'), 'feed 內嵌內文')
            assert.equal(textFromLabelOf('abstract'), '論文摘要（abstract）')
            for (const v of ['article', 'adapter:x', 'browser', '', undefined, null, 'toString', 'constructor']) assert.equal(textFromLabelOf(v), '原網頁全文', String(v))
        })
    })

    describe('dirs.expandDirs 之 extra(下游套件之目錄與基本目錄同一份展開)', function() {

        it('extra 以相對 workDir 之子路徑展開、覆寫仍最優先;未給 extra 時與原展開完全相同;extra 不可重定基本目錄', () => {
            assert.deepEqual(expandDirs('c:/kb'), { db: 'c:/kb/db', log: 'c:/kb/log', tmp: 'c:/kb/tmp', state: 'c:/kb/state', knowledge: 'c:/kb/knowledge' })
            assert.deepEqual(Object.keys(expandDirs('c:/kb')), ['db', 'log', 'tmp', 'state', 'knowledge'], '鍵序不變')
            const d = expandDirs('C:\\kb\\', {}, { notes: 'knowledge/notes', x: '\\deep\\y\\' })
            assert.equal(d.notes, 'C:/kb/knowledge/notes')
            assert.equal(d.x, 'C:/kb/deep/y', '反斜線轉正斜線、去頭尾斜線')
            assert.equal(expandDirs('c:/kb', { knowledge: 'd:/v' }, { notes: 'knowledge/notes' }).notes, 'c:/kb/knowledge/notes', 'extra 相對 workDir,不隨 knowledge 之覆寫而動')
            assert.equal(expandDirs('c:/kb', { notes: 'e:/n' }, { notes: 'knowledge/notes' }).notes, 'e:/n', '覆寫最優先')
            assert.equal(expandDirs('c:/kb', {}, { bad: 5 }).bad, undefined, '非字串之 extra 略過')
            assert.throws(() => expandDirs('c:/kb', {}, { db: 'x' }), /extra 不可重定基本目錄：db/)
            assert.deepEqual(expandDirs('c:/kb', {}, 'x'), expandDirs('c:/kb'), '非物件之 extra 視為{}')
        })
    })

    describe('util/entry.composeNamespaces(四套件主入口之合成同一規則)', function() {

        it('各命名空間之具名匯出併為一物件、略過 default;同名同實體可、同名不同實體即拋(訊息帶入口名與鍵);入口名與陣列之形狀即驗', () => {
            // 規則:entry 檔頭【規則】——export * 會靜默剔除同名,故載入時即檢查
            const f = () => 1
            const out = composeNamespaces('W', [{ a: 1, f, default: 'd' }, { b: 2, f }])
            assert.deepEqual(out, { a: 1, f, b: 2 })
            assert.equal('default' in out, false)
            assert.throws(() => composeNamespaces('WX', [{ k: 1 }, { k: 2 }]), (e) => e.message === 'WX 之匯出名衝突：k(兩個公開模組匯出同名而不同實體;export * 會靜默剔除此名)')
            assert.throws(() => composeNamespaces('', []), /需要入口名/)
            assert.throws(() => composeNamespaces('W', null), /需要 W 之命名空間陣列/)
            // 本套件之主入口即以之合成(具名匯出與預設物件同一組)
            assert.equal(WKnowledgeCapture.composeNamespaces, composeNamespaces)
            assert.equal(WKnowledgeCapture.createKnowledgeCapture, WNamed.createKnowledgeCapture)
        })
    })

    describe('vocab/vocabDefault 之共用預設(下游套件之內建預設詞彙表以此為底)', function() {

        it('CAPTURE_VOCAB_KEYS＝內建預設之鍵(不含 guide;凍結);captureVocabDefaultOf＝resolveVocab({}),各次新物件(改一份不影響另一份)', () => {
            // 規則:vocabDefault.CAPTURE_VOCAB_KEYS／captureVocabDefaultOf——下游不另抄鍵集、不共用預設之參照
            assert.deepEqual([...CAPTURE_VOCAB_KEYS], Object.keys(VOCAB_DEFAULT))
            assert.ok(Object.isFrozen(CAPTURE_VOCAB_KEYS) && !CAPTURE_VOCAB_KEYS.includes('guide'))
            const a = captureVocabDefaultOf()
            const b = captureVocabDefaultOf()
            assert.deepEqual(a, resolveVocab({}))
            assert.deepEqual(Object.keys(a), [...CAPTURE_VOCAB_KEYS])
            a.conceptRenames.x = 'y'
            assert.deepEqual([b.conceptRenames, VOCAB_DEFAULT.conceptRenames], [{}, {}], '各次取得之物件互不共用參照')
        })
    })

    describe('core/util/fileIo、core/util/queueAge(檔案小工具:信封轉回退值與拋錯;佇列積壓)', function() {

        it('readJson:讀不到或非法 JSON 回 fallback;file 非字串回 fallback;正常檔回解析結果', () => {
            // 規則:fileIo.readJson——讀取失敗回退值(不拋)
            assert.deepEqual(readJson(`${TMP}/not-exist.json`, { a: 1 }), { a: 1 })
            assert.equal(readJson(123, null), null)
            fs.writeFileSync(`${TMP}/bad.json`, '{not json', 'utf8')
            assert.equal(readJson(`${TMP}/bad.json`, 'fb'), 'fb')
            writeFileAtomic(`${TMP}/ok.json`, JSON.stringify({ k: '中文' }))
            assert.deepEqual(readJson(`${TMP}/ok.json`), { k: '中文' })
        })

        it('writeFileAtomic:建父目錄、原子寫入(不留暫存檔)、回傳檔名、覆寫既有檔;路徑非字串拋錯', () => {
            // 規則:fileIo.writeFileAtomic——暫存檔＋rename,寫到一半中止不留半份
            const f = `${TMP}/atomic/a/x.txt`
            assert.equal(writeFileAtomic(f, '第一次'), f)
            assert.equal(fs.readFileSync(f, 'utf8'), '第一次')
            writeFileAtomic(f, '第二次')
            assert.equal(fs.readFileSync(f, 'utf8'), '第二次')
            assert.deepEqual(fs.readdirSync(`${TMP}/atomic/a`), ['x.txt'], '不留暫存檔')
            assert.throws(() => writeFileAtomic(123, 'x'), /writeFileAtomic 需要 file/)
        })

        it('writeFileAtomic:真理檔 rename 失敗 → 拋錯、不退回覆寫、不留暫存檔', () => {
            // 規則:fileIo.writeFileAtomic——非占用類失敗即拋;未允許覆寫即不寫
            const dir = `${TMP}/atomic/isdir`
            fs.mkdirSync(dir, { recursive: true })
            assert.throws(() => writeFileAtomic(dir, 'x'))
            assert.deepEqual(fs.readdirSync(`${TMP}/atomic`).filter((n) => n.includes('.tmp')), [], '不留暫存檔')
            assert.ok(fs.statSync(dir).isDirectory(), '目標仍為目錄(未被覆寫)')
        })

        it('queueAge:最舊天數以可解析日期計、無可解析者為 null(非 0);rows 非陣列視為空', () => {
            // 規則:queueAge——null＝無資料,不可與「全新」之 0 混為一談
            const now = Date.parse('2026-09-10T00:00:00Z')
            assert.deepEqual(queueAge([{ collectedAt: '2026-09-01T00:00:00Z' }, { collectedAt: '' }, {}], 'collectedAt', now), { count: 3, oldestDays: 9 })
            assert.deepEqual(queueAge([{ rawAt: '2026-09-09T12:00:00Z' }], 'rawAt', now), { count: 1, oldestDays: 0 })
            assert.deepEqual(queueAge([{}], 'collectedAt', now), { count: 1, oldestDays: null })
            assert.deepEqual(queueAge(null), { count: 0, oldestDays: null })
        })
    })

    describe('主入口轉出(下游套件只經主入口取用)', function() {

        it('上列共用件皆由主入口具名與預設物件轉出,且為同一實體', () => {
            const names = ['reserveOf', 'reserveMsOf', 'fromProblems', 'readJson', 'writeFileAtomic', 'queueAge', 'slugify', 'cutAtBoundary', 'mergeTaps', 'subOpt',
                'mergeSettingsGroup', 'cloneSettingsDefault', 'conceptFoldsOf', 'captureIdentityOf', 'captureNetGuardOf', 'expandDirs', 'textFromLabelOf', 'composeNamespaces', 'captureVocabDefaultOf', 'CAPTURE_VOCAB_KEYS']
            const local = { reserveOf, reserveMsOf, fromProblems, readJson, writeFileAtomic, queueAge, slugify, cutAtBoundary, mergeTaps, subOpt, mergeSettingsGroup, cloneSettingsDefault, conceptFoldsOf, captureIdentityOf, captureNetGuardOf, expandDirs, textFromLabelOf, composeNamespaces, captureVocabDefaultOf, CAPTURE_VOCAB_KEYS }
            for (const n of names) {
                assert.equal(WNamed[n], local[n], `具名轉出 ${n}`)
                assert.equal(WKnowledgeCapture[n], local[n], `預設物件 ${n}`)
            }
        })
    })
})
