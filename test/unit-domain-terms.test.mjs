// unit-domain-terms.test.mjs — 領域中立詞表(test/tools/domainTerms;四套件同一份)之自檢:四套件之中立掃描(預設設定、詞彙、提示詞、題組、README、
//   原始碼、標準之登記)共用此一詞表與命中函數,詞表抓不到或誤傷,各掃描即同時假綠或假紅
// 規則(出自 test/tools/domainTerms 檔頭):
//   ①詞表:中文與英文兩組、各不重複、凍結;全部詞表＝中文在前、英文在後(英文以 alpha 收尾);為四套件原各自手寫之詞表之聯集
//   ②含詞表詞之字串必命中:中文以子字串;英文以詞界、不分大小寫、容字尾變化(s／es／ing／ed／er／ers),緊鄰中文字亦算詞界;
//     字尾規則抓不到之變化形(hedging、hedged)另列為詞
//   ③中立題材不誤傷:天文、醫學、物理之代表文字(中英)不命中;識別字、檔名、模型條目 id 之片段與英文之相近字不命中
//   ④單一正則(DOMAIN_TERM_RE)之命中與否與 domainTermsIn 恆一致,且無狀態(連續 test 結果不變)
// 執行:自套件根 node <mocha> test/unit-domain-terms.test.mjs(純函數;不寫檔、不連網)

import assert from 'node:assert/strict'
import { DOMAIN_TERMS_CJK, DOMAIN_TERMS_EN, DOMAIN_TERMS, DOMAIN_TERM_RE, domainTermsIn, hasDomainTerm } from './tools/domainTerms.mjs'

/** 中立題材之代表文字(不得命中) */
const NEUTRAL = {
    天文: [
        '恆星演化與紅移之觀測：以望遠鏡量測視差，推算系外行星之軌道週期；半人馬座 α 星為距太陽最近之恆星系統',
        'Stellar parallax, redshift surveys and the orbital period of an exoplanet measured by a space telescope',
    ],
    醫學: [
        '隨機對照臨床試驗之設計：受試者分組、雙盲、樣本數與統計檢定力；不良反應之通報與追蹤',
        'A randomized controlled trial with blinded outcome assessment, sample size planning and adverse event reporting',
    ],
    物理: [
        '動量守恆與能量守恆：碰撞前後之總動量不變；量子穿隧與波函數之機率解釋；波動方程與駐波',
        'Conservation of momentum and energy in particle collisions; quantum tunneling through a potential barrier',
    ],
    識別字與相近字: [
        'quantum、quantity、docStockFix、planNoteStockFix、stock-fix.jsonl、oc:opencode/fledge-alpha-free、alphabet、future work、trade-off、node:crypto、cryptography、'
        + 'security review、investigated、hedgehog、q-final',
    ],
}

describe('unit-domain-terms', function() {

    it('詞表:中文與英文兩組、各不重複、凍結;全部詞表＝中文在前、英文在後(英文以 alpha 收尾);含四套件原詞表之聯集', () => {
        for (const list of [DOMAIN_TERMS_CJK, DOMAIN_TERMS_EN, DOMAIN_TERMS]) {
            assert.ok(Object.isFrozen(list))
            assert.equal(new Set(list).size, list.length, '不重複')
        }
        assert.deepEqual(DOMAIN_TERMS, [...DOMAIN_TERMS_CJK, ...DOMAIN_TERMS_EN])
        assert.ok(DOMAIN_TERMS_CJK.every((t) => /\p{Script=Han}/u.test(t)) && DOMAIN_TERMS_EN.every((t) => /^[a-z-]+$/.test(t)), '中文組皆含漢字、英文組皆為小寫英文')
        assert.equal(DOMAIN_TERMS.at(-1), 'alpha')
        // 原摘要／關聯／提煉三套件之詞表(三份同一內容)
        for (const t of ['量化', '交易', '股票', '股市', '因子', '策略', '回測', '樣本外', '樣本內', '實盤', '实盘', '報酬', '市場', '倖存者', '窺探', '夏普', '金融', '行情', '投資', '基金', '證券', '期貨', '選擇權', '避險', '套利', '選股', '加密貨幣']) assert.ok(DOMAIN_TERMS_CJK.includes(t), t)
        for (const t of ['quant', 'quantitative', 'trading', 'trader', 'stock', 'backtest', 'portfolio', 'hedge', 'sharpe', 'out-of-sample', 'in-sample', 'forex', 'cryptocurrency', 'bitcoin', 'futures', 'alpha']) assert.ok(DOMAIN_TERMS_EN.includes(t), t)
        // 原抓取之兩份內聯詞表之聯集補入者(其餘已在上列,或為上列之較長寫法:報酬率、投資組合以子字串命中)
        for (const t of ['台股', '美股', '對沖', '波動率', '比特幣']) assert.ok(DOMAIN_TERMS_CJK.includes(t), t)
        for (const t of ['q-fin', 'hedging', 'hedged', 'investor', 'investment', 'securities', 'arbitrage']) assert.ok(DOMAIN_TERMS_EN.includes(t), t)
        // 刻意不收(檔頭):物理之動量／momentum、密碼學之 crypto
        for (const t of ['動量', 'momentum', 'crypto']) assert.ok(!DOMAIN_TERMS.includes(t), t)
    })

    it('含詞表詞之字串必命中:每個中文詞置於句中;每個英文詞之原形／首字大寫／全大寫／加 s 置於句中,緊鄰中文字亦命中', () => {
        for (const t of DOMAIN_TERMS_CJK) {
            for (const s of [`前文${t}後文`, `（${t}）`, t]) assert.ok(domainTermsIn(s).includes(t), `${t} 應命中:${s}`)
        }
        for (const t of DOMAIN_TERMS_EN) {
            const cap = t[0].toUpperCase() + t.slice(1)
            for (const s of [`a ${t} b`, `${cap} first`, `UPPER ${t.toUpperCase()}.`, `plural ${t}s here`, `以${cap}驗證`]) assert.ok(domainTermsIn(s).includes(t), `${t} 應命中:${s}`)
        }
        assert.deepEqual(domainTermsIn('Backtests of a stock portfolio, quantitative trading and traders'), ['quantitative', 'trading', 'trader', 'stock', 'backtest', 'portfolio'])
        assert.deepEqual(domainTermsIn('量化交易之股票回測與樣本外、市場報酬、倖存者與窺探'), ['量化', '交易', '股票', '回測', '樣本外', '報酬', '市場', '倖存者', '窺探'], '依詞表之序')
        assert.deepEqual(domainTermsIn('台股與美股之報酬率、投資組合之波動率與對沖、比特幣'), ['台股', '美股', '報酬', '投資', '對沖', '波動率', '比特幣'], '較長寫法(報酬率、投資組合)以前綴命中')
        // hedge 之字尾規則抓不到 hedging／hedged(去 e 加 ing、加 d)——另列之詞命中
        assert.deepEqual(domainTermsIn('Hedging and hedged positions of institutional investors; investment in securities, arbitrage and q-fin preprints'), ['q-fin', 'hedging', 'hedged', 'investor', 'investment', 'securities', 'arbitrage'], '字尾規則抓不到之變化形另列')
        assert.equal(hasDomainTerm('只談期貨'), true)
    })

    it('中立題材不誤傷:天文、醫學、物理之代表文字(中英)不命中;識別字、檔名、模型條目 id 之片段與英文之相近字不命中', () => {
        for (const [topic, texts] of Object.entries(NEUTRAL)) {
            for (const s of texts) assert.deepEqual(domainTermsIn(s), [], `${topic}:${s}`)
        }
        assert.deepEqual([domainTermsIn(''), domainTermsIn(null), domainTermsIn(undefined), domainTermsIn(2026)], [[], [], [], []], '非字串轉字串;null／undefined 為空')
    })

    it('單一正則之命中與否與 domainTermsIn 恆一致,且無狀態(無 g／y 旗標;連續 test 結果不變)', () => {
        assert.ok(!/[gy]/.test(DOMAIN_TERM_RE.flags))
        const samples = [
            ...Object.values(NEUTRAL).flat(),
            ...DOMAIN_TERMS_CJK.map((t) => `前${t}後`),
            ...DOMAIN_TERMS_EN.flatMap((t) => [`a ${t} b`, `x-${t}-y`, `${t}Fix`, `${t.toUpperCase()}S`]),
        ]
        for (const s of samples) {
            const want = domainTermsIn(s).length > 0
            assert.equal(DOMAIN_TERM_RE.test(s), want, s)
            assert.equal(DOMAIN_TERM_RE.test(s), want, `再測一次結果不變:${s}`)
        }
        assert.ok(samples.some((s) => DOMAIN_TERM_RE.test(s)) && samples.some((s) => !DOMAIN_TERM_RE.test(s)), '樣本含命中與不命中兩類')
    })
})
