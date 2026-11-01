// domainTerms.mjs — 測試用之領域中立詞表與命中函數(抓取、摘要、關聯、提煉四套件同一份;不帶 .test. 中綴:共用層,避免被 runner 當測試檔抓取)
//
// 【單一來源】四套件之領域中立掃描(預設設定、詞彙、提示詞、評分題組、README、原始碼含註解與日誌字樣、檢定標準之登記)一律以本檔之詞表
//   與命中函數判定:本套件之測試直接取用,摘要、關聯、提煉三套件之測試經各自之 test/tools/captureForTest 取用(上層之測試取下層之件,依賴方向
//   合規)——同一規則多處手寫,詞表必然各自漂移(某處有「期貨」、他處沒有),掃描就各自留洞。
// 【詞表】量化／金融類之詞彙(各套件不得預設為該領域):中文以子字串比對;英文以詞界比對、不分大小寫,容常見之字尾變化
//   (s／es／ing／ed／er／ers),且前後不得為字母、數字、底線或連字號——quantum(物理詞)、stockFix(識別字)、stock-fix.jsonl(存量處置帳之檔名)、
//   fledge-alpha-free(模型條目 id 之片段)皆不是領域詞,不被命中。
// 【字尾規則抓不到之變化形另列】去 e 加 ing、加 d 者(hedging、hedged)字尾規則抓不到,另列為詞;中文之較長寫法(報酬率、投資組合)已被其前綴
//   (報酬、投資)以子字串命中,不另列。
// 【刻意不收】一般科學之詞:動量／momentum(物理之基本量)、crypto(密碼學與 node:crypto;改收「加密貨幣」與 cryptocurrency)——中立題材
//   (天文、醫學、物理)不得被誤傷。量化之用法另有詞表內之詞可抓(動量因子 → 因子、動量策略 → 策略)。
// 【白名單】無:詞界規則已使識別字、檔名與條目 id 之片段不被命中(自檢測試釘住);掃描命中者改寫原文,不加例外。
// 【次序】命中函數依詞表之序回傳(中文在前、英文在後;英文以 alpha 收尾),各測試檔之詞表自檢據此斷言。
// 【移植】本套件改為 npm 套件後,上層之 captureForTest 以 'w-knowledge-capture/test/tools/domainTerms.mjs' 取用(package.json 不設 exports,深層路徑直接可取用;test/tools 隨 npm 包發布)。

/**
 * 中文之領域詞(子字串比對)
 *
 * @type {Array}
 */
export const DOMAIN_TERMS_CJK = Object.freeze([
    '量化', '交易', '股票', '股市', '台股', '美股', '因子', '策略', '回測', '樣本外', '樣本內', '實盤', '实盘', '報酬', '市場', '倖存者', '窺探', '夏普',
    '金融', '行情', '投資', '基金', '證券', '期貨', '選擇權', '避險', '對沖', '套利', '選股', '波動率', '加密貨幣', '比特幣',
])

/**
 * 英文之領域詞(詞界比對、不分大小寫、容字尾變化)
 *
 * @type {Array}
 */
export const DOMAIN_TERMS_EN = Object.freeze([
    'quant', 'quantitative', 'q-fin', 'trading', 'trader', 'stock', 'backtest', 'portfolio', 'hedge', 'hedging', 'hedged', 'sharpe', 'out-of-sample', 'in-sample',
    'investor', 'investment', 'securities', 'arbitrage', 'forex', 'cryptocurrency', 'bitcoin', 'futures', 'alpha',
])

/**
 * 全部領域詞(中文在前、英文在後;命中函數之回傳依此序)
 *
 * @type {Array}
 */
export const DOMAIN_TERMS = Object.freeze([...DOMAIN_TERMS_CJK, ...DOMAIN_TERMS_EN])

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
const EN_SUFFIX = '(?:s|es|ing|ed|er|ers)?'
const enSource = (t) => `(?<![\\w-])${esc(t)}${EN_SUFFIX}(?![\\w-])`
const MATCHERS = Object.freeze([
    ...DOMAIN_TERMS_CJK.map((t) => [t, (s) => s.includes(t)]),
    ...DOMAIN_TERMS_EN.map((t) => {
        const re = new RegExp(enSource(t), 'i')
        return [t, (s) => re.test(s)]
    }),
])

/**
 * 同一詞表之單一正則(無 g／y 旗標,test 無狀態):以 [名稱, 正則] 逐行掃描之規則表用;命中與否與 domainTermsIn 恆一致(自檢測試釘住)
 *
 * @type {RegExp}
 */
export const DOMAIN_TERM_RE = new RegExp([...DOMAIN_TERMS_CJK.map(esc), ...DOMAIN_TERMS_EN.map(enSource)].join('|'), 'i')

/**
 * 文字中出現之領域詞
 *
 * @param {*} text 輸入待掃描文字(非字串者轉字串;null／undefined 視為空字串)
 * @returns {Array} 回傳命中之詞(依 DOMAIN_TERMS 之序、不重複)
 * @example
 * console.log(domainTermsIn('天文學之觀測與 quantum tunneling'), domainTermsIn('Backtests of a stock portfolio'))
 * // => [] [ 'stock', 'backtest', 'portfolio' ]
 */
export function domainTermsIn(text) {
    const s = String(text ?? '')
    return MATCHERS.filter(([, hit]) => hit(s)).map(([t]) => t)
}

/**
 * 文字是否含任一領域詞
 *
 * @param {*} text 輸入待掃描文字
 * @returns {Boolean} 回傳是否命中
 */
export function hasDomainTerm(text) {
    return domainTermsIn(text).length > 0
}

export default { DOMAIN_TERMS_CJK, DOMAIN_TERMS_EN, DOMAIN_TERMS, DOMAIN_TERM_RE, domainTermsIn, hasDomainTerm }
