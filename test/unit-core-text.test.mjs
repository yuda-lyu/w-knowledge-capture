// unit-core-text.test.mjs — 識別鍵與文字標準之核心件:
//   core/util/text(sha1、概念分群鍵之字形折疊／改名／別名、線索鍵與分群脫鉤)與 core/standards/textForms(正體標準之判定與修正)
//   本檔每條案例之應然取自檔頭契約:分群鍵預設折向簡體(tw→cn)、線索鍵固定折向正體(cn→tw)、改名在折疊前、別名在折疊後且單跳;
//   正體以「簡體專用字＋同形字誤用＋誤用詞」之處數為判準(數量,不是比率)
// 執行:自套件根 npx mocha test/unit-core-text.test.mjs(純函數,不落檔、不發網路)

import assert from 'node:assert/strict'
import * as OpenCC from 'opencc-js'
import T from '../src/core/standards/textForms.mjs'
import { sha1, normalizeConcept, normalizeClue, setConceptFold, checkNameMap } from '../src/core/util/text.mjs'
import { clueKey } from '../src/core/stores/frontierPolicy.mjs'
import { resolveVocab } from '../src/core/vocab/vocabDefault.mjs'

const tw2cn = OpenCC.Converter({ from: 'tw', to: 'cn' })
const cn2tw = OpenCC.Converter({ from: 'cn', to: 'tw' })
const same = (...xs) => new Set(xs.map(normalizeConcept)).size === 1

/**
 * 依詞彙表注入與總組裝(createKnowledgeCapture)相同之預設折疊:分群折向簡體(tw→cn)、線索鍵折疊固定為 cn→tw;
 * 改名與別名取自已解析之詞彙表(組裝層之接線另由組裝測試驗證)
 *
 * @param {Object} [vocab] 輸入詞彙覆寫(cfg.data.vocab)
 */
const injectDefaultFold = (vocab) => {
    const v = resolveVocab(vocab)
    setConceptFold(tw2cn, { renames: v.conceptRenames, aliases: v.conceptAliases, clueFold: cn2tw })
}

describe('unit-core-text', function() {

    // 折疊為模組級單例:本檔前後一律清除,不留給同 worker 之他檔
    before(function() {
        setConceptFold(null)
    })

    after(function() {
        setConceptFold(null)
    })

    // ══════════════════════════ 雜湊與概念鍵 ══════════════════════════
    describe('text(雜湊與概念鍵基礎)', function() {

        it('sha1：委派 str2sha；空／null／undefined 輸入回空字串', () => {
            assert.equal(sha1('hello'), 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d')
            assert.equal(sha1(undefined), '')
            assert.equal(sha1(null), '')
        })

        it('normalizeConcept：全形轉半形、去空白、英文小寫，未注入折疊時原樣回傳', () => {
            setConceptFold(null)
            assert.equal(normalizeConcept('  注意力 機制 '), '注意力機制')
            assert.equal(normalizeConcept('Risk（測度）'), 'risk測度')
            assert.equal(normalizeConcept('Attention（機制）'), 'attention機制')
            assert.equal(normalizeConcept(null), '')
            assert.equal(normalizeConcept(undefined), '')
        })

        it('normalizeClue:NFKC、去空白與括號、英文小寫,未注入折疊時不折疊', () => {
            setConceptFold(null)
            assert.equal(normalizeClue('Transformer 架構'), 'transformer架構')
            assert.equal(normalizeClue('Ｔransformer（架構）'), 'transformer架構', '全形字母與括號')
            assert.equal(normalizeClue(undefined), '')
        })

        it('setConceptFold：注入函數後 normalizeConcept 套用折疊；傳非函數即清除(還原預設行為)', () => {
            setConceptFold((t) => t.replace(/风/g, '風'))
            assert.equal(normalizeConcept('风险'), '風险')
            setConceptFold('not-a-function') // 傳非函數 → 清除(視同 null)
            assert.equal(normalizeConcept('风险'), '风险', '傳非函數即清除折疊')
            setConceptFold(null) // 還原，避免影響本檔其他案例(模組層級共用狀態)
        })
    })

    // ══════════════════════════ 概念分群鍵(折疊、改名、別名)與線索鍵 ══════════════════════════
    describe('concept-key(分群鍵預設折疊 tw→cn、折疊前改名／折疊後別名兩段、線索鍵固定正規化)', function() {

        it('預設折疊(分群折向簡體):A 組字形變體收斂(含 cn→tw 折疊收斂不了者)', () => {
            injectDefaultFold(null)
            assert.ok(same('線性回歸', '線性迴歸', '线性回归'), '回歸／迴歸／回归')
            assert.ok(same('系統風險', '系统风险'))
            assert.ok(same('裡程碑', '里程碑'))
            assert.ok(same('衝突', '沖突'))
            assert.ok(same('捲積', '卷積'))
            assert.ok(same('Transformer 架構', 'transformer架構', 'Ｔransformer架構'), 'NFKC、去空白、小寫照舊')
            // 對照:若折向正體(cn→tw),回歸／迴歸／回归 收斂不了(分 2 鍵)——這是分群折向簡體之理由
            setConceptFold(cn2tw)
            assert.equal(new Set(['線性回歸', '線性迴歸', '线性回归'].map(normalizeConcept)).size, 2)
        })

        it('B 組(兩岸用語)字元級不收斂;以折疊後別名合併,且別名對別名之字形變體亦生效', () => {
            injectDefaultFold(null)
            assert.ok(!same('演算法', '算法'))
            assert.ok(!same('資料探勘', '数据挖掘'))
            injectDefaultFold({ conceptAliases: { '算法': '演算法', '数据挖掘': '資料探勘' } })
            assert.ok(same('演算法', '算法'))
            assert.ok(same('資料探勘', '数据挖掘', '數據挖掘'), '別名鍵經折疊:繁體寫法「數據挖掘」折疊後命中「数据挖掘」之別名')
        })

        it('C 組(繁體語意不同而折疊後同鍵)列為已知取捨;以折疊前改名拆開,改名不波及另一寫法', () => {
            injectDefaultFold(null)
            assert.ok(same('曆年', '歷年'), '已知取捨:tw→cn 字元級折疊把曆／歷併為历')
            assert.ok(same('回復率', '回覆率'), '已知取捨(恢復率／回應率)')
            injectDefaultFold({ conceptRenames: { '曆年': '曆年（曆法）' } })
            assert.ok(!same('曆年', '歷年'), '改名以原字形精確比對,拆得開')
            assert.equal(normalizeConcept('歷年'), tw2cn('歷年'), '另一寫法不受影響')
        })

        it('「(數字)」尾綴不自動去除(AR(1)/AR(2)、I(0)/I(1) 為不同概念);既有「名稱(743)」分身以折疊前改名收斂(含全形括號)', () => {
            injectDefaultFold(null)
            assert.ok(!same('AR(1)', 'AR(2)'))
            assert.ok(!same('I(0)', 'I(1)'))
            assert.ok(!same('資料結構(743)', '資料結構'), '零設定不自動併(年份與篇數同為數字,無從區分)')
            injectDefaultFold({ conceptRenames: { '資料結構(743)': '資料結構' } })
            assert.ok(same('資料結構(743)', '資料結構', '資料結構（743）', '资料结构'))
            assert.ok(!same('AR(1)', 'AR(2)'), '改名只作用於列出之寫法')
        })

        it('別名單跳不遞移;改名與別名可串接(改名 → 折疊 → 別名)', () => {
            setConceptFold(tw2cn, { aliases: { '甲': '乙', '乙': '丙' }, renames: { '丁(9)': '丁' }, clueFold: cn2tw })
            assert.equal(normalizeConcept('甲'), '乙', '單跳')
            assert.equal(normalizeConcept('乙'), '丙')
            setConceptFold(tw2cn, { renames: { '戊(12)': '戊' }, aliases: { '戊': '己' } })
            assert.equal(normalizeConcept('戊(12)'), '己', '改名後之寫法再經別名')
        })

        it('線索鍵固定正規化:預設 cn→tw 折疊、不套改名與別名——改分群政策(改名、別名)不改線索 id', () => {
            injectDefaultFold({ conceptAliases: { '算法': '演算法' }, conceptRenames: { '曆年': '曆年（曆法）' } })
            // 線索正規化:NFKC、去空白與括號、小寫後以 cn→tw 折疊
            const fixed = (s) => cn2tw(String(s).normalize('NFKC').replace(/\s+/g, '').replace(/[（）()［］[\]「」]/g, '').toLowerCase().trim())
            for (const v of ['线性回归', '算法', '曆年', 'Transformer 架構', '資料結構(743)']) {
                assert.equal(normalizeClue(v), fixed(v), v)
                assert.equal(clueKey('keyword', v), sha1(`keyword|${fixed(v)}`), `${v} 之線索鍵不受改名／別名影響`)
            }
            assert.notEqual(normalizeClue('线性回归'), normalizeConcept('线性回归'), '線索鍵與分群鍵已脫鉤')
        })

        it('折疊可全停或自訂:不折疊時兩者皆原樣;給函數者分群鍵與線索鍵同用該函數(安裝方自訂折疊)', () => {
            setConceptFold(null, { clueFold: null })
            assert.equal(normalizeConcept('线性回归'), '线性回归')
            assert.equal(normalizeClue('线性回归'), '线性回归')
            const fold = (s) => s.replace(/机/g, '機')
            setConceptFold(fold, { clueFold: fold })
            assert.equal(normalizeConcept('注意力机制'), '注意力機制')
            assert.equal(normalizeClue('注意力机制'), '注意力機制')
        })

        it('setConceptFold 只給 fn:線索折疊同 fn、改名與別名清空;opt 非物件視為{}', () => {
            setConceptFold(tw2cn, { aliases: { '算法': '演算法' } })
            assert.ok(same('演算法', '算法'))
            setConceptFold(cn2tw)
            assert.ok(!same('演算法', '算法'), '別名清空')
            assert.equal(normalizeClue('线性回归'), cn2tw('线性回归'), '線索折疊同 fn')
            setConceptFold(null, 'bad')
            assert.equal(normalizeConcept('线性回归'), '线性回归')
        })

        it('別名設定形狀錯誤於建構期拋錯(不可靜默不生效);null 視為空對照;拋錯時模組狀態不變', () => {
            assert.throws(() => checkNameMap(['a'], 'vocab.conceptAliases'), /vocab\.conceptAliases 須為物件/)
            assert.throws(() => checkNameMap({ '甲': '' }, 'vocab.conceptAliases'), /「甲」須對應非空字串/)
            assert.throws(() => checkNameMap({ '甲': 3 }, 'vocab.conceptRenames'), /「甲」須對應非空字串/)
            assert.deepEqual(checkNameMap(null, 'x'), [])
            assert.deepEqual(checkNameMap({ '算法': '演算法' }, 'vocab.conceptAliases'), [['算法', '演算法']])
            assert.throws(() => resolveVocab({ conceptRenames: 'x' }), /vocab\.conceptRenames 須為物件/)
            assert.deepEqual(resolveVocab({ conceptAliases: null }).conceptAliases, {})
            assert.throws(() => resolveVocab({ conceptAliases: { '算法': ['演算法'] } }), /vocab\.conceptAliases 之「算法」須對應非空字串/)
            injectDefaultFold(null)
            const before = normalizeConcept('线性回归')
            assert.throws(() => setConceptFold(cn2tw, { renames: 'x' }))
            assert.equal(normalizeConcept('线性回归'), before, '拋錯時模組狀態不變')
        })
    })

    // ══════════════════════════ 正體標準(textForms) ══════════════════════════
    describe('textForms(正體:簡體專用字、同形字誤用、誤用詞之判定與修正)', function() {

        it('①簡體專用字逐字計數(數量判準,不是比率):一字即不合格', () => {
            assert.equal(T.scriptProblems('這是一篇正體筆記，只有一個字是简體').only.length, 1)
            assert.equal(T.isTw('這是一篇正體筆記，只有一個字是简體'), false)
            assert.equal(T.scriptProblems('风险测度').only.length, 3)
        })

        it('①臺灣通行字(opencc 標準正體另取正字者)不誤判:群、峰、床、秘、為、雇', () => {
            for (const w of ['族群', '峰值', '溫床', '祕書與秘密', '為何', '雇主', '吃飯', '偽造', '裡面']) assert.equal(T.isTw(w), true, w)
        })

        it('②臺灣幾不使用之同形字:出現即誤用;列出之合法詞不誤判', () => {
            const bad = ['之后', '根据', '1万元', '价格', '几乎', '确定', '各种', '胜率', '广告', '厂商', '丰富', '夸大', '推荐', '涌入', '适合', '愿意', '苹果', '爬虫', '党員', '什么', '意味着']
            for (const w of bad) assert.equal(T.isTw(w), false, w)
            const ok = ['皇后與太后', '拮据', '万俟', '茶几', '胜肽', '丰采', '夸克', '尸位素餐', '党項', '么正矩陣']
            for (const w of ok) assert.equal(T.isTw(w), true, w)
        })

        it('③誤用詞:明列之詞為誤用;臺灣合法用法(分布、平台、占比、批准、干涉…)不誤判', () => {
            const bad = ['由于', '基于', '其余', '里面', '干部', '干燥', '水准', '采用', '示范', '特征', '划分', '丑陋', '希腊', '建筑', '旅游', '委托', '防御', '精致', '制造', '杠杆', '定制', '關系', '聯系', '抑郁', '呼吁', '搏斗', '杰出', '云端', '谷物']
            for (const w of bad) assert.equal(T.isTw(w), false, w)
            const ok = ['分布', '平台', '占比', '公布', '才是', '批准', '核准', '干涉', '若干', '上游', '下游', '游泳', '游資', '漏斗', '北斗', '谷底', '托福', '自制力', '控制與機制', '編制', '小丑', '划算', '划船', '公里', '里程', '濃郁', '周期', '了解', '回流', '借助']
            for (const w of ok) assert.equal(T.isTw(w), true, w)
        })

        it('③跨詞邊界不誤判(詞之前後字排除,避免跨詞誤判)', () => {
            const ok = ['機制成效', '特定制度環境', '嚴重制約', '限制程度', '機制作為', '新制成效', '匯率制成本', '新制作業', '強制冷凍', '上游資料', '下游客戶', '上游行業', '因果干預', '真實干預', '摩擦干擾', '核准時間', '相關系統', '高維系統', '導致密集', '公平准入', '公里面積', '若干部分', '可能干擾', '基金表現', '曲面包含', '基本面條件']
            for (const w of ok) assert.equal(T.isTw(w), true, w)
        })

        it('修正:只改違規處,臺灣合法之 台、占、分布 不被正規化;修正後合格', () => {
            assert.equal(T.toTw('之后的平台占比'), '之後的平台占比')
            assert.equal(T.toTw('这是数据'), '這是數據')
            assert.equal(T.toTw('由于市場分布'), '由於市場分布')
            assert.equal(T.toTw('关系與聯系'), '關係與聯繫')
            assert.equal(T.toTw('杠杆率'), '槓桿率')
            for (const s of ['之后的平台占比', '风险测度与波动率', '随着時間', '这里面', '1万元的价格', '定制化模型']) assert.equal(T.isTw(T.toTw(s)), true, s)
            // ②之單字修正造出③之誤用詞(准确 → 准確 → 準確):單次呼叫即須合格(迭代至不動點)
            assert.equal(T.toTw('依赖对长期预期盈利增长的准确估计'), '依賴對長期預期盈利增長的準確估計')
            assert.equal(T.isTw(T.toTw('模型的准确率与等价于')), true)
            // 性質:任一誤用詞之某字換成其同形誤用字(②之輸入)→ 單次 toTw 即合格(系統性覆蓋「②造出③」一類)
            const inv = {}
            for (const [bad, [good]] of Object.entries(T.TW_MISUSE_CHARS)) (inv[good] ||= []).push(bad)
            let n = 0
            for (const p of T.TW_MISUSE_PHRASES.keys()) {
                for (let i = 0; i < p.length; i++) {
                    for (const bad of inv[p[i]] || []) {
                        const s = `其${p.slice(0, i)}${bad}${p.slice(i + 1)}者`
                        assert.equal(T.isTw(T.toTw(s)), true, `${s} → ${T.toTw(s)}`)
                        n++
                    }
                }
            }
            assert.ok(n > 0)
        })

        it('修正:擴充區(U+10000 以上)之簡體專用字亦轉(性質:全表每字造句,單次 toTw 即合格;須以碼位而非 UTF-16 單位比對)', () => {
            assert.equal(T.isTw(T.toTw('甲\u{2003E}乙')), true, '𠀾(U+2003E)')
            let astral = 0
            for (const c of T.SIMPLIFIED_ONLY) {
                const s = `甲${c}乙`
                assert.equal(T.isTw(T.toTw(s)), true, `${s}(U+${c.codePointAt(0).toString(16)})→ ${T.toTw(s)}`)
                if (c.codePointAt(0) > 0xffff) astral++
            }
            assert.ok(astral > 0, '表內含擴充區字(否則本案驗不到)')
        })

        it('修正:混合文脈依片語取字義(頭发→頭髮,不是頭發)', () => {
            assert.equal(T.toTw('頭发'), '頭髮')
            assert.equal(T.toTw('这里面'), '這裡面')
            assert.equal(T.toTw('随着時間'), '隨著時間')
        })

        it('修正:本就合格者原樣回傳(含英文與數字)', () => {
            for (const s of ['臺灣的平台占比', 'Gradient 12-1', '皇后', '']) assert.equal(T.toTw(s), s)
            assert.equal(T.toTw(null), '')
            assert.equal(T.toTw(undefined), '')
        })

        it('連結與網址不算本篇文字:`[[連結]]` 與網址不檢(withoutForeignSpans)、不轉(toTwKeepLinks);連結外已合格者原樣', () => {
            assert.equal(T.withoutForeignSpans('见 [[简体-slug]] 与 https://x.com/数据'), '见   与  ')
            assert.equal(T.toTwKeepLinks('见 [[简体-slug]] 与 https://x.com/数据 之后'), '見 [[简体-slug]] 與 https://x.com/数据 之後')
            assert.equal(T.toTwKeepLinks('見 [[简体-slug]] 之後'), '見 [[简体-slug]] 之後', '連結外已合格 → 原樣')
            assert.equal(T.isTw(T.withoutForeignSpans('見 [[简体-slug]] 與 https://x.com/数据')), true, '檢查與修正同一定義:含此類片段者不會「不合格而修不了」')
        })

        it('scriptProblems 回傳逐處明細:簡體專用字(only)、同形字誤用(practical,附臺灣寫法)、誤用詞(phrases,附臺灣寫法);count 為三類之和', () => {
            const r = T.scriptProblems('之后由于数据')
            assert.equal(r.count, 4)
            assert.deepEqual(r.practical.map((x) => [x.c, x.tw]), [['后', '後'], ['据', '據']])
            assert.deepEqual(r.phrases.map((x) => [x.cn, x.tw]), [['由于', '由於']])
            assert.deepEqual(r.only.map((x) => x.c), ['数'])
            assert.deepEqual(T.scriptProblems(undefined), { count: 0, only: [], practical: [], phrases: [] })
        })

        it('scriptProblems 之位置為 UTF-16 索引且依序:擴充區字佔兩個單位、孤立代理字元以其單位值計;合法詞內之同形字不計(2026-10-10 改為碼位數值查表,複本語料 218,033 筆與逐碼位走訪逐筆相同)', () => {
            const r = T.scriptProblems('𠀀之后数')
            assert.deepEqual(r.practical.map((x) => [x.c, x.i]), [['后', 3]], '擴充區字(U+20000)在前:其後之字位置加 2')
            assert.deepEqual(r.only.map((x) => [x.c, x.i]), [['数', 4]])
            const lone = T.scriptProblems('\uD800数\uDC00后')
            assert.deepEqual([lone.only.map((x) => [x.c, x.i]), lone.practical.map((x) => [x.c, x.i])], [[['数', 1]], [['后', 3]]], '孤立代理字元不誤判、各前進一個單位')
            assert.deepEqual(T.scriptProblems('皇后與拮据之后').practical.map((x) => [x.c, x.i]), [['后', 6]], '皇后、拮据內者不計,詞外照計')
            // 碼位查表之前提:兩表之成員皆為單一碼位(多碼位者逐碼位走訪本即不可能命中)
            assert.ok([...T.SIMPLIFIED_ONLY].every((c) => [...c].length === 1))
            assert.ok(Object.keys(T.TW_MISUSE_CHARS).every((c) => [...c].length === 1))
        })
    })
})
