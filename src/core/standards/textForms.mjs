// textForms.mjs — 正體中文標準(抓取 CS12):判定與修正之單一實作
//
// 【判準是數量,不是比率】欄位內「簡體專用字」＋「同形字誤用」之處數＝0 才合格(檢定標準禁止以機率篩選)。
//   以「cn→tw 逐字改寫之比例 ≥2%」判定會讓 2% 以下之簡體照收;且臺灣合法之同形字(台、占、准、后…)會被改寫,
//   只好以例外字表排除,例外表又放過真簡體(之后、由于)。
// 【三類,皆可逐案說明】
//   ①簡體專用字:opencc STCharacters 之鍵中,不見於任何正體寫法(STCharacters／STPhrases 之值、TSCharacters 之鍵)者
//     ——正體文字永不出現(約 3,800 字,如 这、们、说、为);由字典推導,不手列。
//   ②臺灣正體幾不使用之同形字(TW_MISUSE_CHARS):后、据、万、价、几…——除列出之合法詞(皇后、拮据、万俟、茶几…)外,出現即誤用。
//   ③誤用詞(TW_MISUSE_PHRASES):同形字在臺灣正體另有常用寫法之詞(由于→由於、示范→示範、制造→製造…);只認明列之詞,
//     不以 opencc 片語表全收——片語表以 OpenCC 標準正體為準,大量臺灣合法用法(分布、平台、占比、公布、才是)會被判誤用。
//     台、占、才、布、周、了、回、借、注、伙、凶…兩岸混用者不列。
// 【偵測不可用 opencc 之轉換差異】opencc 片語之鍵是簡體寫法:臺灣文脈之「准許」(許 為正體)對不上片語「准许」→ 退回逐字 准→準,
//   合法用法被判誤用。故偵測只用上述明列表;opencc 只用於「修正」(且只改違規處與其緊鄰字,見 toTw)。
// 【不在範圍】網址、程式碼、原文引述(來源章之原文標題)不屬內容欄位,由呼叫端排除。

import OpenCC from 'opencc-js'
import ST_CHARS from 'opencc-js/dict/STCharacters'
import ST_PHRASES from 'opencc-js/dict/STPhrases'
import TS_CHARS from 'opencc-js/dict/TSCharacters'
import TW_VARIANTS from 'opencc-js/dict/TWVariants'
import TW_VARIANTS_PHRASES from 'opencc-js/dict/TWVariantsPhrases'
import TW_PHRASES from 'opencc-js/dict/TWPhrases'

const cn2tw = OpenCC.Converter({ from: 'cn', to: 'tw' })
const tw2cn = OpenCC.Converter({ from: 'tw', to: 'cn' })

// ① 簡體專用字(字典推導)
const tradChars = new Set()
const stKeys = []
for (const ent of ST_CHARS.split('|')) {
    const [k, ...v] = ent.split(' ')
    if (!k) continue
    stKeys.push(k)
    for (const x of v) for (const ch of x) tradChars.add(ch)
}
for (const ent of ST_PHRASES.split('|')) {
    const sp = ent.indexOf(' ')
    if (sp < 0) continue
    for (const ch of ent.slice(sp + 1)) if (ch !== ' ') tradChars.add(ch)
}
for (const ent of TS_CHARS.split('|')) {
    const k = ent.split(' ')[0]
    if (k) tradChars.add(k)
}
// 臺灣用字:opencc 標準正體取「羣、峯、牀、祕」等正字,臺灣通行「群、峰、床、秘」——後者為臺灣異體表之值,須視為正體
//   (未納入則「群」「峰」等臺灣通行字會被誤判為簡體)
for (const dict of [TW_VARIANTS, TW_VARIANTS_PHRASES, TW_PHRASES]) {
    for (const ent of dict.split('|')) {
        const sp = ent.indexOf(' ')
        if (sp < 0) continue
        for (const ch of ent.slice(sp + 1)) if (ch !== ' ') tradChars.add(ch)
    }
}
// 臺灣教育部標準字中、opencc 各表皆未列為正體寫法者(逐字附理由):雇(雇主、雇用;opencc 一律轉僱)
for (const ch of '雇') tradChars.add(ch)
/**
 * 簡體專用字集合(由 opencc 字典推導，約 3,800 字，如 这、们、说、为)：這些字不見於任何正體寫法，正體文字永不出現
 *
 * @type {Set<String>}
 */
export const SIMPLIFIED_ONLY = new Set(stKeys.filter((c) => !tradChars.has(c)))

// ② 臺灣正體幾不使用之同形字:字 → [正體, 合法詞(空白分隔)]
/**
 * 臺灣正體幾不使用之同形字對照表：鍵為易誤用之字，值為 [對應正體字, 合法詞(空白分隔，無則空字串)]；
 * 該字出現且不在任一合法詞內即判為誤用(如 后→後，但「皇后」合法)
 *
 * @type {Object<String, Array<String>>}
 */
export const TW_MISUSE_CHARS = {
    后: ['後', '皇后 太后 王后 后羿 影后 天后 母后 后土 后冠 歌后 后妃 帝后'],
    据: ['據', '拮据'],
    万: ['萬', '万俟'],
    价: ['價', ''],
    几: ['幾', '茶几 几案 几淨'],
    确: ['確', ''],
    种: ['種', ''],
    胜: ['勝', '胜肽 胜鍵'],
    广: ['廣', ''],
    厂: ['廠', ''],
    丰: ['豐', '丰采 丰姿 丰韻 丰神 丰儀 丰標'],
    夸: ['誇', '夸父 夸克'],
    荐: ['薦', ''],
    涌: ['湧', ''],
    适: ['適', ''],
    愿: ['願', ''],
    苹: ['蘋', ''],
    虫: ['蟲', ''],
    尸: ['屍', '尸位 尸祝 尸居'],
    党: ['黨', '党項'],
    么: ['麼', '么正'],
    着: ['著', ''],
}

// ③ 誤用詞:[同形字, 正體, 詞(空白分隔)];詞以臺灣文脈之寫法列(其餘字為正體)——全簡體之寫法含簡體專用字,已由①判
const PHRASE_GROUPS = [
    ['于', '於', '由于 在于 位于 等于 基于 用于 大于 小于 高于 低于 至于 便于 易于 限于 介于 源于 善于 敢于 勇于 不同于 同于 于是 免于 忠于 受制于 制于 有助于 致力于 多于 少于 早于 晚于 弱于 好于 甚于 勝于 出于 急于 苦于 合于 適于 始于 止于 陷于 迫于 囿于 屬于 對于 關于 處于 終于 歸于 鑑于 鑒于 相當于 取決于 優于 強于 來自于 有別于 無異于 歸因于 得益于 樂于 專注于 集中于 側重于 歸功于 著眼于 立足于 傾向于 類似于 相對于 對應于 依賴于 局限于 侷限于 聚焦于 不限于 僅限于 等價于 趨于 有利于 不利于'],
    ['余', '餘', '其余 剩余 余額 多余 余下 余地 余數 余量 盈余 余弦 余震 余溫 冗余 殘余 余波 余生 余裕 余款 余值 有余 之余 業余 結余 富余 余力 余暇 余味'],
    ['里', '裡', '里面 心里 那里 哪里 家里 手里 眼里 夜里 城里 屋里 這里 字里行間 里頭 里邊 背地里 暗地里 骨子里'],
    ['干', '幹', '干部 能干 骨干 主干 干活 苦干 實干 干勁 樹干 干線 干嘛 干練'],
    ['干', '乾', '干燥 干旱 干杯 烘干 曬干 干脆 干枯 干涸 干冰 干淨 餅干 干貨 干糧 干果 果干 筍干 干洗 風干 陰干 擦干 流干 吸干 喝干 抽干 榨干 未干'],
    ['准', '準', '水准 精准 基准 瞄准 准度 校准 照准 准星 准確 標准 准則 准時 准備 對准 准繩'],
    ['采', '採', '采用 采取 采集 采信 可采 采行 采摘 采收 采得 采樣 采納 采訪 采購 開采 采礦 采買 采擷'],
    ['范', '範', '示范 范例 范式 典范 模范 防范 范本 范文 就范 規范 范圍 范疇 風范 師范'],
    ['征', '徵', '特征 象征 征兆 表征 征收 征稅 征信 征集 征求 征詢 征才 征候 病征 體征 征象'],
    ['划', '劃', '划分 划定 策划 刻划 划清 划入 划出 划款 划一 計划 規划 籌划 區划 划歸 划時代'],
    ['丑', '醜', '丑陋 出丑 丑化 丑聞 丑惡 丑態 丑事'],
    ['仆', '僕', '仆人 公仆 奴仆 仆役'],
    ['咸', '鹹', '咸味 咸淡 咸魚 咸水'],
    ['腊', '臘', '希腊 腊月 腊肉 腊八'],
    ['蜡', '蠟', '打蜡 石蜡 蜡像 蜡燭 蜡筆 封蜡 蜂蜡'],
    ['筑', '築', '建筑 筑底 筑巢 修筑 筑起 構筑 筑牆 筑頂 筑堤'],
    ['涂', '塗', '涂抹 涂料 糊涂 涂改 涂層 涂鴉 涂上 涂裝'],
    ['柜', '櫃', '柜台 柜子 衣柜 柜員 貨柜 專柜 保險柜 櫥柜 書柜 冰柜'],
    ['帘', '簾', '窗帘 帘子 門帘 竹帘'],
    ['郁', '鬱', '抑郁 憂郁 郁悶 郁結 沉郁 陰郁'],
    ['吁', '籲', '呼吁 吁請'],
    ['厘', '釐', '厘清 厘定 厘米 毫厘'],
    ['咨', '諮', '咨商 咨詢'],
    ['淀', '澱', '沉淀 淀粉 積淀'],
    ['斗', '鬥', '搏斗 斗智 斗志 激斗 斗牛 打斗 爭斗 奮斗 戰斗 斗爭 決斗 械斗 斗毆'],
    ['杰', '傑', '杰出 豪杰 英杰 杰作'],
    ['云', '雲', '云端 云平台 云原生 白云 云中 云海 云集 云上 云計算 云服務 云儲存 云層 烏云 風云 云霧 云彩 云圖'],
    ['叶', '葉', '叶片 叶子 中叶 枝叶 落叶 茶叶 樹叶 綠叶 末叶 初叶'],
    ['谷', '穀', '谷物 稻谷 五谷 谷類'],
    ['游', '遊', '旅游 游客 游玩 游艇 游行 周游 漫游 巡游 郊游 游覽 游戲 游說 導游 游歷 游樂 交游 游學 游記'],
    ['托', '託', '委托 托管 信托 托付 寄托 拜托 受托 托人 推托 托詞 托辭'],
    ['御', '禦', '防御 抵御 御寒 御敵'],
    ['致', '緻', '精致 致密 細致 別致 雅致'],
    ['制', '製', '制造 制作 制成 制品 制程 研制 制冷 制片 特制 精制 印制 仿制 制得 重制 復制 繪制 炮制 釀制 煉制 監制 攝制 縫制'],
]
// 「表→錶」「面→麵」兩組不列:語料校準下全為跨詞誤判(如表現、表面、曲面包含),故不列
// 不規則之對照(同詞內多字皆改)
const PHRASE_PAIRS = '杠杆>槓桿 杠桿>槓桿 高杠>高槓 加杠桿>加槓桿 定制>訂製 關系>關係 聯系>聯繫 維系>維繫 系于>繫於 確系>確係'
// 詞之前後字排除(避免跨詞誤判,如:機制成效、特定制度、嚴重制約、上游資料、因果干預、核准時間、
//   相關系統、導致密集、公里面積、若干部分)——以詞之起訖為界:before＝詞首之前一字、after＝詞尾之後一字
const GROUP_GUARDS = {
    制: { before: '機限強體控抑管節壓牽專編法規學幣兵禁克遏箝鉗宰統稅税', after: '度約衡裁定止服式訂宜勝' },
    游: { before: '上下中力逆' },
    干: { before: '若', after: '預涉擾犯' },
    准: { before: '核批獲允' },
    致: { before: '導以所招獲' },
    里: { before: '公英海千萬鄰故鄉華' },
}
const PAIR_GUARDS = {
    定制: GROUP_GUARDS.制,
    關系: { after: '統列數' },
    聯系: { after: '統列數' },
    維系: { after: '統列數' },
}
// 逐詞之補充排除(與群組排除取聯集):新制成效、體制成本、新制作業
const PHRASE_EXTRA_GUARDS = {
    制成: { after: '效本果績長功交份分立熟員' },
    制作: { after: '業用為' },
}

function buildPhrases() {
    const out = new Map()
    const guards = {}
    for (const [ch, tw, list] of PHRASE_GROUPS) {
        for (const p of list.split(/\s+/).filter(Boolean)) {
            if ([...p].some((c) => SIMPLIFIED_ONLY.has(c))) continue // 全簡體寫法已由①判
            out.set(p, p.split(ch).join(tw))
            if (GROUP_GUARDS[ch]) guards[p] = GROUP_GUARDS[ch]
        }
    }
    for (const pair of PHRASE_PAIRS.split(/\s+/).filter(Boolean)) {
        const [cn, tw] = pair.split('>')
        out.set(cn, tw)
        if (PAIR_GUARDS[cn]) guards[cn] = PAIR_GUARDS[cn]
    }
    for (const [p, g] of Object.entries(PHRASE_EXTRA_GUARDS)) {
        const base = guards[p] || {}
        guards[p] = { before: `${base.before || ''}${g.before || ''}`, after: `${base.after || ''}${g.after || ''}` }
    }
    return { out, guards }
}
const built = buildPhrases()
/**
 * 誤用詞對照表：鍵為同形字在臺灣正體另有常用寫法之詞(如 由于)，值為應改成的正體詞(如 由於)；只含明列之詞
 *
 * @type {Map<String, String>}
 */
export const TW_MISUSE_PHRASES = built.out
const PHRASE_GUARDS = built.guards
const PHRASE_RE = new RegExp([...TW_MISUSE_PHRASES.keys()].sort((a, b) => b.length - a.length).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
const PRACTICAL_EXCEPT = Object.fromEntries(Object.entries(TW_MISUSE_CHARS).map(([c, [, ex]]) => [c, ex.split(/\s+/).filter(Boolean)]))
// ①②之碼位表:scriptProblems 逐碼位以數值查表,命中才配置字串——與「每碼位配置一字串再查字串表」同一結果(兩表之成員皆為單一碼位;
//   多碼位者原本即不可能命中);後者佔全量符合度掃描約 1/10(剖析:約 1.8 萬篇筆記之內容、標題、概念)
const SIMPLIFIED_ONLY_CPS = new Set([...SIMPLIFIED_ONLY].filter((c) => [...c].length === 1).map((c) => c.codePointAt(0)))
const TW_MISUSE_CPS = new Set(Object.keys(TW_MISUSE_CHARS).filter((c) => [...c].length === 1).map((c) => c.codePointAt(0)))

// 字元在某合法詞之內(該詞之任一出現涵蓋此位置)
function insideWord(s, i, words) {
    for (const w of words) {
        const k = w.indexOf(s[i])
        if (k < 0) continue
        for (let j = 0; j < w.length; j++) {
            if (w[j] !== s[i]) continue
            const st = i - j
            if (st >= 0 && s.startsWith(w, st)) return true
        }
    }
    return false
}

function guardOk(s, start, phrase) {
    const g = PHRASE_GUARDS[phrase]
    if (!g) return true
    if (g.before && start > 0 && g.before.includes(s[start - 1])) return false
    const end = start + phrase.length
    if (g.after && end < s.length && g.after.includes(s[end])) return false
    return true
}

/**
 * 字形問題逐處列出(①簡體專用字 ②同形字誤用 ③誤用詞)
 *
 * @param {*} text 輸入文字(非字串以 String 轉;以 UTF-16 索引回報位置)
 * @returns {Object} 回傳 { count, only:[{c,i}], practical:[{c,i,tw}], phrases:[{cn,tw,i}] }
 * @example
 * console.log(scriptProblems('之后由于数据').count)
 * // => 4
 */
export function scriptProblems(text) {
    const s = String(text ?? '')
    const only = []
    const practical = []
    // 以碼位取字(擴充區之簡體字佔兩個 UTF-16 單位;孤立代理字元以其單位值計,同 codePointAt)
    for (let i = 0; i < s.length;) {
        const cp = s.codePointAt(i)
        if (SIMPLIFIED_ONLY_CPS.has(cp)) only.push({ c: String.fromCodePoint(cp), i })
        else if (TW_MISUSE_CPS.has(cp)) {
            const c = String.fromCodePoint(cp)
            if (!insideWord(s, i, PRACTICAL_EXCEPT[c])) practical.push({ c, i, tw: TW_MISUSE_CHARS[c][0] })
        }
        i += cp > 0xffff ? 2 : 1
    }
    const phrases = []
    for (const m of s.matchAll(PHRASE_RE)) {
        if (guardOk(s, m.index, m[0])) phrases.push({ cn: m[0], tw: TW_MISUSE_PHRASES.get(m[0]), i: m.index })
    }
    return { count: only.length + practical.length + phrases.length, only, practical, phrases }
}

/**
 * 非本篇文字之片段:`[[連結]]`(他篇 id)與網址——正體之檢查不計、修正(toTwKeepLinks)不轉,同一定義
 *   (檢查與修正若定義不同,含此類片段之內容永遠「不合格而修不了」)
 * @type {RegExp}
 */
export const FOREIGN_SPAN_RE = /\[\[[^\]\n]*\]\]|https?:\/\/[^\s)>\]」）]+/g

/**
 * 去除非本篇文字之片段(以空白代之,保留前後文之分隔)
 *
 * @param {*} text 輸入文字
 * @returns {String} 回傳去除後之文字
 * @example
 * console.log(withoutForeignSpans('见 [[简体-slug]] 与 https://x.com/数据'))
 * // => '见   与  '
 */
export function withoutForeignSpans(text) {
    return String(text ?? '').replace(FOREIGN_SPAN_RE, ' ')
}

/**
 * 是否合於正體標準(三類問題皆 0)
 *
 * @param {*} text 輸入文字
 * @returns {Boolean} 回傳是否合格
 * @example
 * console.log(isTw('黑洞光譜的觀測結果'), isTw('黑洞光谱的观测结果'))
 * // => true false
 */
export function isTw(text) {
    return scriptProblems(text).count === 0
}

/**
 * 修正為臺灣正體:只改違規處——簡體專用字與其緊鄰字依 opencc 片語級轉換(字義依上下文:头发→頭髮),
 *   同形字誤用依②③之對照;其餘字不動(臺灣合法之 台、占、分布 等不被正規化)
 *   【先折回簡體再轉】混合文脈(頭发)之片語鍵對不上(opencc 片語鍵為全簡體),直接 cn→tw 會退回逐字(发→發);
 *   故整句先 tw→cn 再 cn→tw 取得片語上下文,只取違規處與緊鄰字之結果
 *
 * 【迭代至不動點】②之單字修正可能「造出」③之誤用詞(准确 → ②改「确」→ 准確 → 須③改「準確」;③在②之前已跑過),
 *   故一趟後仍不合格者再跑,至多 3 趟(否則殘留「准確」;新進之納入閘同受影響)
 *
 * @param {*} text 輸入文字
 * @returns {String} 回傳修正後文字(本就合格者原樣回傳)
 * @example
 * console.log(toTw('之后的平台占比'))
 * // => '之後的平台占比'
 */
export function toTw(text) {
    let s = String(text ?? '')
    for (let k = 0; k < 3 && !isTw(s); k++) s = toTwOnce(s)
    return s
}

/**
 * 逐字片語級之簡→繁轉換(opencc cn→tw;整段轉換,不是只改違規處):比對用之字形折疊(如下游之文字相似度),不用於寫回內容
 *
 * @param {*} text 輸入文字
 * @returns {String} 回傳轉換後文字
 * @example
 * console.log(cnToTw('头发与数据'))
 * // => 頭髮與數據
 */
export function cnToTw(text) {
    return cn2tw(String(text ?? ''))
}

/**
 * 轉正體(只改違規處;`[[連結]]` 與網址原樣——FOREIGN_SPAN_RE)
 *
 * @param {*} text 輸入文字
 * @returns {String} 回傳修正後文字
 * @example
 * console.log(toTwKeepLinks('见 [[简体-slug]] 与 https://x.com/数据 之后'))
 * // => '見 [[简体-slug]] 與 https://x.com/数据 之後'
 */
export function toTwKeepLinks(text) {
    const s = String(text ?? '')
    if (isTw(withoutForeignSpans(s))) return s
    let out = ''
    let last = 0
    for (const m of s.matchAll(FOREIGN_SPAN_RE)) {
        out += toTw(s.slice(last, m.index)) + m[0]
        last = m.index + m[0].length
    }
    return out + toTw(s.slice(last))
}

/**
 * toTw 之單趟(①簡體專用字與緊鄰字 → ③誤用詞 → ②同形字)
 *
 * @param {String} s 輸入文字(不合格者)
 * @returns {String} 回傳單趟修正後文字
 */
function toTwOnce(s) {
    const conv = cn2tw(tw2cn(s))
    let a = s
    // 以碼位對齊(擴充區之簡體字佔兩個 UTF-16 單位:以 UTF-16 索引逐「單位」比對 SIMPLIFIED_ONLY,擴充區字永遠對不上而不轉;
    //   與 scriptProblems 之碼位取字對稱)
    const sc = [...s]
    const cc = [...conv]
    if (cc.length === sc.length) {
        let out = ''
        for (let i = 0; i < sc.length; i++) {
            const near = SIMPLIFIED_ONLY.has(sc[i]) || SIMPLIFIED_ONLY.has(sc[i - 1]) || SIMPLIFIED_ONLY.has(sc[i + 1])
            out += near ? cc[i] : sc[i]
        }
        a = out
    }
    else {
        // 長度不等(片語轉換改了字數;'tw' 目標理論上不發生):逐字轉換簡體專用字
        a = [...s].map((c) => (SIMPLIFIED_ONLY.has(c) ? cn2tw(c) : c)).join('')
    }
    // ③誤用詞(先詞後字:詞內之同形字不再落入②)
    a = a.replace(PHRASE_RE, (m, off, all) => (guardOk(all, off, m) ? TW_MISUSE_PHRASES.get(m) : m))
    // ②同形字誤用
    let b = ''
    for (let i = 0; i < a.length; i++) {
        const c = a[i]
        b += TW_MISUSE_CHARS[c] && !insideWord(a, i, PRACTICAL_EXCEPT[c]) ? TW_MISUSE_CHARS[c][0] : c
    }
    return b
}

export default { SIMPLIFIED_ONLY, TW_MISUSE_CHARS, TW_MISUSE_PHRASES, FOREIGN_SPAN_RE, withoutForeignSpans, scriptProblems, isTw, cnToTw, toTw, toTwKeepLinks }
