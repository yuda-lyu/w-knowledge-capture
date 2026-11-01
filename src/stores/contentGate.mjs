// contentGate.mjs — 單篇正文之健全閘:抓取「成功」但內容不可用者(過短／亂碼／佔位頁／付費牆)於落庫前判出,交分流規則處置
//
// 【為何需要】w-fetch-web 之成功門檻為解析後 50 字(constants MIN_CONTENT),內容契約未宣告時更只要 1 字
//   (w-data-pipeline itemContract normalizeContent);實測曾有 159 篇 JS 提示／付費牆／佔位樣板頁以「成功」落 raw,
//   進入下游(預篩、摘要)才被判非知識——額度與材料皆浪費。另 curl 一律以 UTF-8 解碼(fetchWebByCurl),
//   GBK／Big5 頁成亂碼(重抓實測 U+FFFD 每千字 457～746),亂碼素材曾產出帶詳細數字之筆記(捏造風險)。
// 【各類處置不同】too-short／placeholder／format-noise → 轉瀏覽器(渲染可救);mojibake → 轉瀏覽器(依 charset 解碼可救);
//   paywall → 終態(瀏覽器無帳號,救不回);not-found(頁面自述找不到,強證據、只看標題與開頭)、soft-404(轉址至站台首頁)→ 終態。
//   處置由 fetchPolicy 決定,本檔只判類。
// 【弱樣式一律加內容量閘門】字串樣式是對全世界頁面之猜測:正常長文提到 "enable JavaScript"／"subscribe" 者多的是,
//   不加閘門即誤殺(同 w-fetch-web inspectHtml 之 SPARSE_VISIBLE_MAX 理由)。佔位樣式只在正文 < placeholderMaxChars、
//   付費牆樣式只在正文 < paywallMaxChars 時套用;亂碼與過短為量測型判準,不需閘門。
// 【adapter 內容豁免樣式】站台 adapter 之正文由站方 API 組出(來源已知,同 w-fetch-web defaultAdapters 之 inspect:false 理由),
//   不套字串樣式(找不到頁面、佔位、付費牆、同意聲明),只檢軟 404、亂碼、格式雜訊與過短。
// 【偵測器陣列(可注入)】各類判準為有序偵測器(GATE_DETECTORS_DEFAULT;契約 core/util/injectables),settings.capture.standards.detectors 給了即整組取代
//   (含順序):追加＝[...GATE_DETECTORS_DEFAULT, mine]、換掉某一個＝以 id 篩掉再放自己的;自訂偵測器須帶 module(子行程之瀏覽器階梯據以載入,
//   否則 curl 層與瀏覽器層之閘不一致),其 sig 入閘版本。分流只認 GATE_KINDS 之類別,自訂者沿用既有類別。
// 【閘之版本(檢定標準 CS1a 存量依閘版本重驗)】版本＝程式版號 CONTENT_GATE_V＋閘之有效參數簽章(gateVersionOf):
//   判準(類別、門檻、內建樣式、各入口之套用、grid 摘要判準)改變 → CONTENT_GATE_V 加一;安裝方調整門檻或追加樣式 → 簽章自然改變。
//   文件落 raw 時記 healthV,存量由 stores/healthRecheck 依版本重判(長度條件以落庫時記之原長 fullLength 判)。

import isobj from 'wsemi/src/isobj.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import { toPatterns } from '../core/util/patterns.mjs'
import { sha1 } from '../core/util/text.mjs'
import { gateDetectorProblems } from '../core/util/injectables.mjs'

/** 健全閘之程式版號:判準改變(類別、門檻、內建樣式、各入口之套用、grid 摘要判準)即加一——存量 raw 依新版重判(healthRecheck) */
export const CONTENT_GATE_V = 1

/** 內建佔位頁樣式(多語、弱證據;僅短正文套用) */
export const PLACEHOLDER_PATTERNS_DEFAULT = [
    { p: '(please\\s+)?(enable|turn\\s+on|activate)\\s+javascript|javascript\\s+(is\\s+)?(required|disabled|must\\s+be\\s+enabled)|requires\\s+javascript', f: 'i' },
    { p: '(please\\s+)?enable\\s+cookies|cookies?\\s+(are\\s+)?(required|disabled|must\\s+be\\s+enabled)', f: 'i' },
    { p: 'verify(ing)?\\s+(that\\s+)?you\\s+are\\s+(a\\s+)?human|are\\s+you\\s+a\\s+robot|unusual\\s+traffic|bot\\s+detection|request\\s+(was\\s+)?blocked|access\\s+(to\\s+this\\s+page\\s+(has\\s+been|is)\\s+)?denied', f: 'i' },
    { p: '(this\\s+)?(page|article|content|story)\\s+(was\\s+)?(not\\s+found|is\\s+(no\\s+longer\\s+)?(un)?available|has\\s+been\\s+removed)|404\\s+not\\s+found', f: 'i' },
    { p: '(your\\s+)?browser\\s+(is\\s+)?(not\\s+supported|is\\s+out\\s+of\\s+date|does\\s+not\\s+support)', f: 'i' },
    { p: '請(開啟|啟用|打開)\\s*(javascript|cookie)|需要\\s*javascript|瀏覽器(不支援|已停用|版本過舊)|請(開啓|启用|打开)\\s*(javascript|cookie)', f: 'i' },
    { p: '頁面不存在|網頁不存在|找不到(該|此)?(頁面|網頁|文章)|文章已(刪除|下架|移除)|页面不存在|找不到(该|此)?(页面|网页|文章)', f: 'i' },
    { p: '請(證明|確認)您(是|不是)(真人|機器人)|請完成(安全)?驗證|访问受限|訪問受限|存取遭拒', f: 'i' },
    // 機器人牆(Camofox 之合成內容不經 w-fetch-web 之 HTML 判識,牆頁照樣「成功」):實見某新聞站兩篇
    //   不同文章皆回同一段 552 字「We've detected unusual activity from your computer network…let us know you're not a robot」而落 raw
    { p: 'detected\\s+unusual\\s+(activity|traffic)|(you(\'|’)?re|you\\s+are|i(\'|’)?m|i\\s+am)\\s+not\\s+a\\s+robot|click\\s+the\\s+box\\s+below\\s+to\\s+let\\s+us\\s+know|checking\\s+(if\\s+the\\s+site\\s+connection\\s+is\\s+secure|your\\s+browser\\s+before)|just\\s+a\\s+moment\\.\\.\\.|press\\s+(&|and)\\s+hold|pardon\\s+our\\s+interruption', f: 'i' },
    // 實網測試:usnews 經 Camofox 回 412 字之 Akamai 牆(兩篇不同文章同一段)、nytimes 回 469 字之「存取查核中」預覽殼
    { p: 'flagged\\s+this\\s+request\\s+as\\s+(exhibiting\\s+)?automated|exhibiting\\s+automated\\s+behavio(u)?r|restrict\\s+programmatic\\s+access|preview\\s+(view\\s+)?of\\s+this\\s+article\\s+while\\s+we\\s+are\\s+checking\\s+your\\s+access', f: 'i' },
    // 維護／暫時無法提供(實測 hexun 已下架文章之回應「内容正在升级改造，请稍后再试」)
    { p: '(内容|內容|頁面|页面|網站|网站|系統|系统|服務|服务)正在(升級|升级|維護|维护|改造|更新)|請稍後再試|请稍后再试|稍後再來|稍后再来|under\\s+maintenance|temporarily\\s+unavailable', f: 'i' },
]

/** 「找不到頁面」強證據之正文開頭比對窗(字) */
const NOT_FOUND_LEAD_CHARS = 1200

/**
 * 內建「同意聲明樣板」之標記(cookie／IAB TCF 同意牆被當正文抽出):於正文開頭 consentLeadChars 字內命中相異標記 ≥ consentMinHits
 * 即判佔位,**不受內容量閘門**——例如某雜誌站列印頁經 Chrome 渲染得 811,911 字,開頭為 IAB 廠商清單
 * (「Vendors who are part of the IAB TCF…Reject all／Accept all…Legitimate Interest…Store and/or access information on a device」),
 * 截成 20,000 字落 raw。單一標記於正常文章亦會出現(隱私條款連結、「接受全部」按鈕文字),故以相異標記數判,不以單一樣式判
 */
export const CONSENT_MARKERS_DEFAULT = [
    { p: '\\bIAB\\b|\\bTCF\\b|transparency\\s*(&|and)\\s*consent\\s+framework', f: 'i' },
    { p: 'legitimate\\s+interests?', f: 'i' },
    { p: 'store\\s+and\\/or\\s+access\\s+information\\s+on\\s+a\\s+device', f: 'i' },
    { p: '\\b(accept|reject)\\s+all\\b', f: 'i' },
    { p: 'personali[sz]ed\\s+(ads|advertising|content)|select\\s+(basic|personali[sz]ed)\\s+ads', f: 'i' },
    { p: '(cookie|privacy)\\s+(settings|preferences|choices)|manage\\s+(cookies|preferences|consent)', f: 'i' },
    { p: 'data\\s+retention\\s+period|measure\\s+(advertising|content)\\s+performance|precise\\s+geolocation\\s+data', f: 'i' },
    { p: '我們(和|與)我們的合作夥伴|同意(所有|全部)\\s*cookie|接受(所有|全部)\\s*cookie|cookie\\s*(設定|偏好)', f: 'i' },
]

/**
 * 內建「找不到頁面」之強證據(不受內容量閘門:Camofox 不檢 HTTP 狀態,404 頁連同側欄熱門文章可達上萬字——實測 forbes 12,086 字、
 * idahostatesman 780 字皆為 404 頁);只比對標題與正文開頭 1,200 字(頁面自我宣告身分之位置;樣式皆為整句,
 * 正常文章開頭極少出現)
 */
export const NOT_FOUND_PATTERNS_DEFAULT = [
    { p: 'we\\s+(can(\'|’)?t|cannot|could\\s+not|couldn(\'|’)?t)\\s+find\\s+(the|this)\\s+page|unable\\s+to\\s+(locate|find)\\s+the\\s+page|the\\s+page\\s+you\\s+(are\\s+|were\\s+|\'re\\s+)?(looking\\s+for|requested)\\s+(could\\s+not|cannot|can(\'|’)?t|does\\s+not|doesn(\'|’)?t|is\\s+no\\s+longer|no\\s+longer|might\\s+have\\s+been|may\\s+have\\s+been)', f: 'i' },
    { p: '^\\W*(404|page\\s+not\\s+found|not\\s+found|error\\s+404)\\b|\\b404\\s*(error|not\\s+found|page)\\b', f: 'i' },
    { p: '找不到(您要的|該|此|這個)?(頁面|網頁|页面|网页|文章)|頁面不存在|页面不存在|網頁不存在|网页不存在|文章不存在|已被(刪除|删除)或不存在', f: 'i' },
]

/** 內建付費牆／登入牆樣式(弱證據;僅短正文套用) */
export const PAYWALL_PATTERNS_DEFAULT = [
    { p: 'subscribe\\s+(now\\s+)?to\\s+(continue|read|unlock|access|keep\\s+reading)|subscribers?[\\s-]+only|(for|available\\s+to)\\s+(paid\\s+|premium\\s+)?(subscribers|members)\\s+only|already\\s+a\\s+subscriber|become\\s+a\\s+(member|subscriber)\\s+to', f: 'i' },
    { p: 'unlock\\s+(this|the\\s+full|full)\\s+(article|story|content)|(premium|pro)\\s+(content|article)\\s+(is\\s+)?(locked|for\\s+subscribers)|to\\s+continue\\s+reading,?\\s+(please\\s+)?(subscribe|sign\\s+in|log\\s+in)', f: 'i' },
    { p: '(sign|log)\\s+in\\s+to\\s+(continue|read|view)\\s+(this|the\\s+(full|rest))', f: 'i' },
    { p: '付費(會員|訂閱|閱讀)|訂閱(後|才能|即可)(閱讀|觀看|解鎖)|會員專屬|(登入|登錄)(後|即可|才能)(閱讀|觀看)(全文|完整)|付费(会员|订阅|阅读)|订阅(后|才能|即可)(阅读|观看|解锁)|会员专属', f: 'i' },
]

/**
 * 轉址後之軟 404:內容來自同站之首頁(原網址有路徑,轉址後路徑為 / 或空且無查詢字串)。
 * 健全閘之一類(單一擁有者):curl 結果、同輪瀏覽器升級、瀏覽器佇列皆經本閘——不可只掛在 detailFetch 之 contentGate 錨點
 *   (瀏覽器階梯之結果不經該錨點;例如 ttv.com.tw 經 playwright＋waitForRedirect 轉至首頁之 4,118 字新聞列表,會以「救回」落 raw)
 *
 * @param {String} url 輸入原網址
 * @param {String} finalUrl 輸入內容實際來源網址
 * @returns {Boolean} 回傳是否為軟 404
 * @example
 * console.log(isSoft404('https://e.com/news/1', 'https://www.e.com/'))
 * // => true
 */
export function isSoft404(url, finalUrl) {
    if (!isestr(url) || !isestr(finalUrl)) return false
    try {
        const a = new URL(url)
        const b = new URL(finalUrl)
        const hostOf = (u) => u.hostname.replace(/^www\./, '')
        return hostOf(a) === hostOf(b) && a.pathname.replace(/\/+$/, '').length > 1 && b.pathname.replace(/\/+$/, '') === '' && !b.search
    }
    catch {
        return false
    }
}

// 樣式正規化之實作在 core/util/patterns(多個任務模組共用,任務模組間不互相 import),此處轉出供抓取端就近取用
export { toPatterns }

/**
 * 亂碼度量:U+FFFD(取代字元)與 UTF-8 被當 Latin-1 解碼之典型序列,回傳每千字數與總數
 *
 * @param {String} text 輸入正文
 * @returns {Object} 回傳 { count:Integer, perK:Number }
 * @example
 * console.log(mojibakeOf('ab�cd').count)
 * // => 1
 */
export function mojibakeOf(text) {
    const s = String(text || '')
    const repl = (s.match(/�/g) || []).length
    const latin = (s.match(/[ÃÂ][\u0080-¿]|â€[™œ˜“”\u0080-¿]/g) || []).length
    const count = repl + latin
    return { count, perK: s.length ? (count * 1000) / s.length : 0 }
}

/** 亂碼判準之預設門檻(閘與 grid 兩路共用同一份,不各判各的) */
export const MOJIBAKE_DEFAULT = { perK: 5, min: 10 }

/**
 * 是否為亂碼正文(U+FFFD／Latin-1 誤解碼序列:個數與每千字皆達門檻)
 *
 * @param {String} text 輸入正文
 * @param {Object} [opt=MOJIBAKE_DEFAULT] 輸入門檻 { perK, min }
 * @returns {Boolean} 回傳是否判為亂碼
 * @example
 * console.log(isMojibakeText('�'.repeat(20) + 'a'.repeat(100)))
 * // => true
 */
export function isMojibakeText(text, opt = MOJIBAKE_DEFAULT) {
    const o = isobj(opt) ? opt : MOJIBAKE_DEFAULT
    const m = mojibakeOf(text)
    return m.count >= (o.min ?? MOJIBAKE_DEFAULT.min) && m.perK >= (o.perK ?? MOJIBAKE_DEFAULT.perK)
}

/** 格式雜訊之預設門檻 */
export const FORMAT_NOISE_DEFAULT = { markupPerK: 8, markupMin: 20, jsonKeysPerK: 10, jsonKeysMin: 20, maxSaneChars: 300_000 }

/**
 * 長度條件所用之長度:給了原長(fullLength,落庫時記之截斷／去重前長度)且不短於正文者用原長,否則用正文長度。
 * 存量重判之正文已去重、截斷(maxTextChars),長度條件(過短、內容量閘門、逾合理上限)須以原長判
 *
 * @param {Number} textLength 輸入正文長度
 * @param {*} fullLength 輸入原長(非有限正數視為未給)
 * @returns {Number} 回傳長度條件所用之長度
 */
function lengthFor(textLength, fullLength) {
    return Number.isFinite(fullLength) && fullLength > textLength ? fullLength : textLength
}

/**
 * 格式雜訊判準(格式未處理乾淨之素材:如把 xml 回傳導致超長文之類):
 * ①結構化資料原文(XML／RSS／Atom／sitemap／HTML 原始碼起頭)②JSON 原文(鍵值樣式密度)③字面標籤／HTML 實體密度
 * (curl 經 Readability 之 textContent 已無標籤——命中多為 feed 雙重跳脫或 API 原文)④原長逾合理上限(非文章:例如某站實見 676,270 字)。
 * 不以符號比判:技術文章之公式、程式碼、表格符號多,會誤殺
 *
 * @param {String} text 輸入正文(截斷前;存量重判時為庫內正文,另給 opt.fullLength)
 * @param {Object} [opt=FORMAT_NOISE_DEFAULT] 輸入門檻 { markupPerK, markupMin, jsonKeysPerK, jsonKeysMin, maxSaneChars };
 *   另可給 fullLength(原長:④以之判,正文已截斷時用)
 * @returns {Object} 回傳 { noisy:Boolean, why:String }
 * @example
 * console.log(formatNoiseOf('<?xml version="1.0"?><rss><channel>…</channel></rss>').noisy)
 * // => true
 */
export function formatNoiseOf(text, opt = FORMAT_NOISE_DEFAULT) {
    const o = { ...FORMAT_NOISE_DEFAULT, ...(isobj(opt) ? opt : {}) }
    const s = String(text || '')
    const len = lengthFor(s.length, o.fullLength)
    if (len > o.maxSaneChars) return { noisy: true, why: `原長 ${len} 字逾合理上限 ${o.maxSaneChars}` }
    const lead = s.slice(0, 400).trimStart()
    if (/^(<\?xml\b|<rss\b|<feed\b|<urlset\b|<sitemapindex\b|<!doctype\s+html|<html\b)/i.test(lead)) return { noisy: true, why: '結構化資料原文（XML／RSS／HTML 原始碼起頭）' }
    const perK = (n) => (s.length ? (n * 1000) / s.length : 0)
    if (/^[[{]/.test(lead)) {
        const keys = (s.match(/"[^"\n]{1,60}"\s*:/g) || []).length
        if (keys >= o.jsonKeysMin && perK(keys) >= o.jsonKeysPerK) return { noisy: true, why: `JSON 原文（鍵值 ${keys} 個）` }
    }
    const tags = (s.match(/<\/?[a-zA-Z][\w:-]*(?:\s[^<>]{0,200})?\/?>/g) || []).length
    const ents = (s.match(/&(?:#\d{2,6}|#x[0-9a-f]{2,6}|[a-z]{2,8});/gi) || []).length
    if (tags + ents >= o.markupMin && perK(tags + ents) >= o.markupPerK) return { noisy: true, why: `標記殘留（標籤 ${tags}、實體 ${ents}，每千字 ${perK(tags + ents).toFixed(1)}）` }
    return { noisy: false, why: '' }
}

/**
 * 無損去重:移除完全相同之段落／行／句(≥ minLen 字,留首次出現),其餘一字不動。
 * 單行長牆(一行逾 2,000 字;Readability 之 textContent 常把整篇壓成一行)改以句為單位比對。
 * 於截斷之前執行(例如某站實見 37,188 字、重複行比 0.82,去重後約 7k)
 *
 * @param {String} text 輸入正文
 * @param {Object} [opt={}] 輸入設定 { minLen=40 }
 * @returns {Object} 回傳 { text:String, removed:Integer(移除之字數) }
 * @example
 * const r = dedupeText('第一段落的文字內容已經足夠長到可以被判斷為重複段落。\n其他。\n第一段落的文字內容已經足夠長到可以被判斷為重複段落。', { minLen: 10 })
 * console.log(r.removed > 0)
 * // => true
 */
export function dedupeText(text, opt = {}) {
    const s = String(text || '')
    const minLen = Number.isInteger(opt?.minLen) && opt.minLen > 0 ? opt.minLen : 40
    const seen = new Set()
    const keyOf = (u) => u.replace(/\s+/g, ' ').trim()
    const keep = (u) => {
        const k = keyOf(u)
        if (k.length < minLen) return true
        if (seen.has(k)) return false
        seen.add(k)
        return true
    }
    const out = []
    for (const line of s.split('\n')) {
        if (line.length <= 2000) {
            if (keep(line)) out.push(line)
            continue
        }
        // 單行長牆:以句為單位(句讀含中英;句尾之引號／括號隨句)
        const sents = line.match(/[^。！？.!?]+(?:[。！？.!?]+["」』）)]*\s*|$)/g) || [line]
        out.push(sents.filter(keep).join(''))
    }
    const t = out.join('\n')
    return { text: t, removed: s.length - t.length }
}

/**
 * 內建偵測器(有序;契約見 core/util/injectables):每項 test(c, env) 命中回 { hit },不命中回 null。順序即判定順序——
 *   軟 404(決定性,先於一切內容判準)→ 亂碼 → 格式雜訊 → 找不到頁面(先於過短:404 頁多半也短)→ 過短 → 同意聲明樣板 → 佔位(含機器人牆;
 *   先於付費牆:兩者皆命中之短頁先交瀏覽器渲染)→ 付費牆。adapter:true 者對站台 adapter 之正文亦套(adapter 內容豁免字串樣式,檔頭)。
 *   env 為 createContentGate 於建構期正規化之門檻與樣式(opt)加每篇之 { text, title, head, len, lead(n), adapterId, url, finalUrl, mojibake(), formatNoise() }
 *
 * @type {Array}
 */
export const GATE_DETECTORS_DEFAULT = Object.freeze([
    { id: 'soft-404', kind: 'soft-404', adapter: true, builtin: true, test: (c, env) => (isSoft404(env.url, env.finalUrl) ? { hit: `轉址至站台首頁：${String(env.finalUrl).slice(0, 120)}` } : null) },
    { id: 'mojibake', kind: 'mojibake', adapter: true, builtin: true, test: (c, env) => {
        const moji = env.mojibake()
        return moji.count >= env.opt.mojibakeMin && moji.perK >= env.opt.mojibakePerK ? { hit: `亂碼 ${moji.count} 個（每千字 ${moji.perK.toFixed(1)}）` } : null
    } },
    // 格式雜訊(adapter 內容亦判:站方 API 回原文結構即改版訊號,分流以 adapterId 判 final,不換法重抓)
    { id: 'format-noise', kind: 'format-noise', adapter: true, builtin: true, test: (c, env) => {
        const fn = env.formatNoise()
        return fn.noisy ? { hit: fn.why } : null
    } },
    // 找不到頁面(強證據,只看標題與開頭):先於過短判——404 頁正文多半也短,判 too-short 會被送去瀏覽器白跑。
    //   開頭窗 1,200 字:Camofox 之合成內容常以導覽選單起頭(實測 idahostatesman 之「unable to locate the page」在第 ~520 字)
    { id: 'not-found', kind: 'not-found', adapter: false, builtin: true, test: (c, env) => {
        const lead = env.lead(NOT_FOUND_LEAD_CHARS)
        const nf = env.patterns.notFounds.find((r) => r.test(env.title.trim()) || r.test(lead))
        return nf ? { hit: String(`${env.title}\n${lead}`.match(nf)?.[0] || '').slice(0, 80) } : null
    } },
    { id: 'too-short', kind: 'too-short', adapter: true, builtin: true, test: (c, env) => (env.len < env.opt.minTextChars ? { hit: `正文 ${env.len} 字，低於 ${env.opt.minTextChars}` } : null) },
    // 同意聲明樣板佔據開頭(不受內容量閘門;以相異標記數判,見 CONSENT_MARKERS_DEFAULT)
    { id: 'consent', kind: 'placeholder', adapter: false, builtin: true, test: (c, env) => {
        const lead = env.lead(env.opt.consentLeadChars)
        const hits = env.patterns.consentMarkers.filter((r) => r.test(lead)).length
        return hits >= env.opt.consentMinHits ? { hit: `同意聲明樣板（開頭 ${env.opt.consentLeadChars} 字內 ${hits} 種標記）` } : null
    } },
    // 佔位(含機器人牆、維護頁;弱樣式加內容量閘門)先於付費牆:兩者皆命中之短頁(如「請開啟 JavaScript…訂閱以繼續」)先交瀏覽器渲染;
    //   渲染後仍是付費牆者,瀏覽器結果再過一次本閘即判 paywall(終態)——反之先判付費牆則永遠不給渲染的機會
    { id: 'placeholder', kind: 'placeholder', adapter: false, builtin: true, test: (c, env) => {
        if (env.len >= env.opt.placeholderMaxChars) return null
        const re = env.patterns.placeholders.find((r) => r.test(env.head))
        return re ? { hit: String(env.head.match(re)?.[0] || '').slice(0, 80) } : null
    } },
    { id: 'paywall', kind: 'paywall', adapter: false, builtin: true, test: (c, env) => {
        if (env.len >= env.opt.paywallMaxChars) return null
        const re = env.patterns.paywalls.find((r) => r.test(env.head))
        return re ? { hit: String(env.head.match(re)?.[0] || '').slice(0, 80) } : null
    } },
].map((d) => Object.freeze(d)))

/**
 * 建立健全閘(設定於建構期正規化,每篇呼叫 assess)
 *
 * @param {Object} [opt={}] 輸入設定物件，非物件視為{}(總組裝傳 settings.capture.standards;其餘鍵〔minFallbackChars、healthRecheckPerRun…〕本函數不讀)
 * @param {Array|null} [opt.detectors=null] 輸入有序偵測器陣列(整組取代;null＝GATE_DETECTORS_DEFAULT;契約 core/util/injectables.gateDetectorProblems——
 *   id 唯一、kind 為健全閘類別、test 函數;自訂者之簽章 sig 入閘版本)
 * @param {Integer} [opt.minTextChars=300] 輸入正文最少字數(與 feed 退路之 minFallbackChars 同一把尺)
 * @param {Number} [opt.mojibakePerK=5] 輸入亂碼每千字門檻
 * @param {Integer} [opt.mojibakeMin=10] 輸入亂碼最少個數(短文避免 1～2 個即觸發)
 * @param {Integer} [opt.placeholderMaxChars=1500] 輸入佔位樣式之內容量閘門(正文短於此才套用)
 * @param {Integer} [opt.paywallMaxChars=3000] 輸入付費牆樣式之內容量閘門
 * @param {Integer} [opt.consentLeadChars=2000] 輸入同意聲明樣板之開頭比對窗(字)
 * @param {Integer} [opt.consentMinHits=3] 輸入同意聲明樣板之相異標記門檻
 * @param {Array} [opt.placeholderPatterns=[]] 輸入安裝方追加之佔位樣式(RegExp 或 {p,f})，接在內建之後
 * @param {Array} [opt.paywallPatterns=[]] 輸入安裝方追加之付費牆樣式
 * @param {Integer} [opt.maxSaneChars=300000] 輸入正文合理上限(逾之判 format-noise)
 * @param {Object} [opt.formatNoise] 輸入格式雜訊門檻覆寫(見 FORMAT_NOISE_DEFAULT)
 * @returns {Object} 回傳 { assess(c), minTextChars, signature, detectors }；c 為 { text, title?, adapterId?, url?, finalUrl?, fullLength? }，回傳 { ok:Boolean, kind:''|'soft-404'|'mojibake'|'format-noise'|'not-found'|'too-short'|'placeholder'|'paywall', hit:String }
 *   (同意聲明樣板歸 placeholder,hit 以「同意聲明樣板」起頭;soft-404 須給 url 與 finalUrl;format-noise 對 adapter 內容亦判;
 *   fullLength＝原長,給了即以之判長度條件——過短、佔位／付費牆之內容量閘門、逾合理上限,存量重判用(庫內正文已去重、截斷);
 *   signature＝正規化後之有效參數(含追加樣式;給了自訂偵測器陣列時另含各偵測器之 id 與 sig)字串,供閘之版本 gateVersionOf;detectors＝生效之偵測器陣列)
 * @throws {Error} 追加樣式形狀不合法、偵測器陣列不合契約時拋出
 * @example
 * const g = createContentGate({ minTextChars: 10 })
 * console.log(g.assess({ text: 'short' }).kind)
 * // => too-short
 */
export function createContentGate(opt = {}) {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    const minTextChars = Number.isInteger(opt.minTextChars) && opt.minTextChars >= 0 ? opt.minTextChars : 300
    const mojibakePerK = Number.isFinite(opt.mojibakePerK) && opt.mojibakePerK > 0 ? opt.mojibakePerK : 5
    const mojibakeMin = Number.isInteger(opt.mojibakeMin) && opt.mojibakeMin > 0 ? opt.mojibakeMin : 10
    const placeholderMaxChars = Number.isInteger(opt.placeholderMaxChars) && opt.placeholderMaxChars > 0 ? opt.placeholderMaxChars : 1500
    const paywallMaxChars = Number.isInteger(opt.paywallMaxChars) && opt.paywallMaxChars > 0 ? opt.paywallMaxChars : 3000
    const consentLeadChars = Number.isInteger(opt.consentLeadChars) && opt.consentLeadChars > 0 ? opt.consentLeadChars : 2000
    const consentMinHits = Number.isInteger(opt.consentMinHits) && opt.consentMinHits > 0 ? opt.consentMinHits : 3
    const consentMarkers = toPatterns(CONSENT_MARKERS_DEFAULT, 'CONSENT_MARKERS_DEFAULT')
    const noiseOpt = { ...FORMAT_NOISE_DEFAULT, ...(isobj(opt.formatNoise) ? opt.formatNoise : {}), ...(Number.isInteger(opt.maxSaneChars) && opt.maxSaneChars > 0 ? { maxSaneChars: opt.maxSaneChars } : {}) }
    const placeholders = [...toPatterns(PLACEHOLDER_PATTERNS_DEFAULT, 'PLACEHOLDER_PATTERNS_DEFAULT'), ...toPatterns(opt.placeholderPatterns, 'capture.standards.placeholderPatterns')]
    const paywalls = [...toPatterns(PAYWALL_PATTERNS_DEFAULT, 'PAYWALL_PATTERNS_DEFAULT'), ...toPatterns(opt.paywallPatterns, 'capture.standards.paywallPatterns')]
    const notFounds = toPatterns(NOT_FOUND_PATTERNS_DEFAULT, 'NOT_FOUND_PATTERNS_DEFAULT')
    const reSig = (list) => list.map((r) => `${r.source}/${r.flags}`)
    // 偵測器:null＝內建;給了即整組取代(含順序),契約於此驗(設定 schema 亦驗同一份;自訂者須帶 module 之要求在總組裝 createCaptureRuntime)
    const custom = opt.detectors !== undefined && opt.detectors !== null
    if (custom) {
        const problems = gateDetectorProblems(opt.detectors)
        if (problems.length) throw new Error(`capture.standards.detectors 不合契約：${problems.join('；')}`)
    }
    const detectors = custom ? [...opt.detectors] : [...GATE_DETECTORS_DEFAULT]
    // 自訂陣列時簽章另含各偵測器之 id 與 sig(改了即換閘版本);只用內建時簽章不帶偵測器欄(存量之 healthV 不因注入機制本身而全數重判)
    const signature = JSON.stringify({ minTextChars, mojibakePerK, mojibakeMin, placeholderMaxChars, paywallMaxChars, consentLeadChars, consentMinHits, noiseOpt, placeholders: reSig(placeholders), paywalls: reSig(paywalls), ...(custom ? { detectors: detectors.map((d) => `${d.id}:${d.sig || ''}`) } : {}) })
    const fixed = { opt: { minTextChars, mojibakePerK, mojibakeMin, placeholderMaxChars, paywallMaxChars, consentLeadChars, consentMinHits, noiseOpt }, patterns: { placeholders, paywalls, notFounds, consentMarkers } }

    /**
     * 判一篇正文:依序跑偵測器,首個命中者即該類(adapter 內容只跑 adapter:true 者)
     *
     * @param {Object} c 輸入 { text, title?, adapterId?, url?, finalUrl?, fullLength? }
     * @returns {Object} 回傳 { ok, kind, hit }
     */
    function assess(c) {
        const text = String(c?.text || '').trim()
        const title = String(c?.title || '')
        const head = `${title}\n${text}`
        // 長度條件所用之長度:存量重判時正文已去重、截斷,以原長判;即時閘未給 fullLength 即正文長度
        const len = lengthFor(text.length, c?.fullLength)
        let moji = null
        let noise = null
        const env = {
            ...fixed,
            text,
            title,
            head,
            len,
            adapterId: c?.adapterId || '',
            url: c?.url,
            finalUrl: c?.finalUrl,
            lead: (n) => text.slice(0, n),
            mojibake: () => (moji ||= mojibakeOf(text)),
            formatNoise: () => (noise ||= formatNoiseOf(text, { ...noiseOpt, fullLength: len })),
        }
        for (const d of detectors) {
            if (env.adapterId && d.adapter !== true) continue
            const r = d.test(c, env)
            if (r) return { ok: false, kind: d.kind, hit: String(r?.hit || d.id) }
        }
        return { ok: true, kind: '', hit: '' }
    }

    return { assess, minTextChars, signature, detectors }
}

/**
 * 健全閘之版本(檔頭【閘之版本】):程式版號＋閘之有效參數簽章(正文閘與 feed 退路閘〔門檻 minFallbackChars〕兩者)。
 * 文件落 raw 時記為 healthV;不同於現版之 raw 存量由 healthRecheck 重判
 *
 * @param {Object} [standards={}] 輸入 settings.capture.standards(取 minTextChars、minFallbackChars、placeholderPatterns、paywallPatterns、maxSaneChars)
 * @returns {String} 回傳版本字串「<CONTENT_GATE_V>:<簽章 8 碼>」
 * @throws {Error} 追加樣式形狀不合法時拋出(同 createContentGate)
 * @example
 * console.log(gateVersionOf({ minTextChars: 300 }) === gateVersionOf({ minTextChars: 300 }))
 * // => true
 */
export function gateVersionOf(standards = {}) {
    const c = isobj(standards) ? standards : {}
    const main = createContentGate(c)
    const feed = createContentGate({ ...c, minTextChars: c.minFallbackChars })
    return `${CONTENT_GATE_V}:${sha1(`${main.signature}|${feed.signature}`).slice(0, 8)}`
}

/** grid 摘要之最短字數(CS1d:grid 摘要直入 raw,只擋過短與亂碼——結構化 API 內容,佔位／付費牆樣式對論文摘要只會誤殺) */
const GRID_MIN_CHARS = 250

/**
 * grid 摘要之判準(CS1d;defaultFetchers.readGrid 入庫前與存量重判同一函數):過短(< 250 字)→ too-short;亂碼(與閘同門檻)→ mojibake
 *
 * @param {*} text 輸入摘要
 * @param {Object} [opt={}] 輸入 { fullLength:Number(原長;給了且長於摘要者以之判過短) }
 * @returns {Object} 回傳 { ok:Boolean, kind:''|'too-short'|'mojibake', hit:String }
 * @example
 * console.log(gridAbstractCheck('短摘要').kind)
 * // => too-short
 */
export function gridAbstractCheck(text, opt = {}) {
    const s = String(text ?? '')
    const len = lengthFor(s.length, isobj(opt) ? opt.fullLength : undefined)
    if (len < GRID_MIN_CHARS) return { ok: false, kind: 'too-short', hit: `摘要 ${len} 字，低於 ${GRID_MIN_CHARS}` }
    if (isMojibakeText(s)) {
        const m = mojibakeOf(s)
        return { ok: false, kind: 'mojibake', hit: `亂碼 ${m.count} 個（每千字 ${m.perK.toFixed(1)}）` }
    }
    return { ok: true, kind: '', hit: '' }
}

export default createContentGate
