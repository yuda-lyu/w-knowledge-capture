// jsonReply.mjs — 模型回覆之 JSON 抽取:取「最後一段合格」之完整 JSON(合格由呼叫端之 check 判定)
//
// 【為何取最後一段】模型偶會先回一段 JSON,再寫「等等…更正如下」回完整一段(實測:正式調度層 6 次呼叫中 1 次);
//   取第一段(上游 extractJsonLoose 之作法)即拿到被模型自己作廢之那段、其後之項全缺。前言含括號(「依意見 [3]」)、尾隨說明含小片段者,
//   由 check 篩掉——由後往前,取第一段 check(d) === true 者;皆不合格即不合格(換下一家)。
// 【片段之找法】去 ANSI 色碼與 code fence(同 extractJsonLoose)→ 整段可解析即唯一一段 → 否則於頂層自每個 { 或 [ 起以括號配對
//   (字串與跳脫感知)取完整片段:可解析者為一段;閉合而解析失敗者(前言之「[注意]」等)整段略過、自其後續找;未閉合者為截斷之尾段,
//   其後不再找(其內之元素不另當作一段)。只收物件與陣列。
// 【截斷放行】opt.acceptTruncated 為 true 時,截斷之尾段以上游 salvageTruncatedArray 搶救(只收前段完整之頂層物件元素),救得回即為最後一段
//   ——模型之最終輸出被截時,前段完整之項仍可部分接受(未涵蓋者由呼叫端之批次層處置);未開即不搶救(全有全無之輸出)。
// 【含鍵物件(pickKeyedJson)】多棒工作流之各棒(如起草、審計、修訂、終審)之輸出契約是「含指定鍵之物件」,片段另一種找法:
//   自每個「{」起以大括號配對(雙引號與單引號皆為字串,跳脫感知)取完整物件;先 JSON.parse,不成則以呼叫端注入之寬鬆解析
//   (opt.looseParse,如 JSON5 之 parse;本套件不依賴寬鬆解析器)再試;為物件(非陣列)且含任一指定鍵(自有屬性)者為一個候選,
//   其內之物件不另列(自其結尾之後續找);不含鍵者往其內找(外包物件 {"result":{…}} 取內層)。
// 【兩種片段來源為何不同】頂層片段服務「輸出即一段 JSON(陣列或物件)」之契約;含鍵物件服務「輸出為帶固定鍵之物件、可能被包一層」之契約:
//   ①只收含鍵之物件——前言之 [3]、{"note":…} 不論位置皆不成候選;②往不含鍵之外包物件內找;③未閉合之「{」不中止掃描,自其下一個「{」續找
//   (截斷之尾段本身不成候選、不搶救);④不去 ANSI 與 code fence——大括號配對不受 fence 標記與色碼影響,去之反會改動字串值之內容
//   (如引用 ```),且各棒既有解析之輸出依此而定(改了即與已驗證之行為不同)。
// 【選取只有一份】兩種來源之候選皆「由後往前,取第一個 judge(值) === true 者」(lastPassing;拋錯視同不合格)——同一規則不各寫一份。

import salvageTruncatedArray from 'w-dispatch-ai/src/wkf/salvageTruncatedArray.mjs'

/** ANSI 色碼(ESC [ … m) */
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/**
 * 去 ANSI 色碼與 code fence 標記(同上游 extractJsonLoose 之清理)
 *
 * @param {*} text 輸入回覆(非字串以 String 轉)
 * @returns {String} 回傳清理後之文字(已去頭尾空白)
 */
function cleanReply(text) {
    return String(text ?? '').replace(ANSI_RE, '').replace(/```(?:json)?/g, '').trim()
}

/**
 * 自位置 i 之開括號起找配對之收尾括號(字串與跳脫感知)
 *
 * 預設(頂層片段):「{」與「[」皆計入深度、只有雙引號為字串;opt.loose(含鍵物件):只計大括號、單引號亦為字串(寬鬆 JSON 之字串)
 *
 * @param {String} s 輸入文字
 * @param {Integer} i 輸入起點(該處為開括號)
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Boolean} [opt.loose=false] 輸入是否為含鍵物件之配對(只計大括號、單引號亦為字串)
 * @returns {Integer} 回傳收尾括號之位置，未閉合回 -1
 */
function closeOf(s, i, opt = {}) {
    const loose = opt?.loose === true
    let depth = 0
    let quote = ''
    let esc = false
    for (let j = i; j < s.length; j++) {
        const c = s[j]
        if (quote) {
            if (esc) esc = false
            else if (c === '\\') esc = true
            else if (c === quote) quote = ''
            continue
        }
        if (c === '"' || (loose && c === '\'')) quote = c
        else if (c === '{' || (!loose && c === '[')) depth++
        else if (c === '}' || (!loose && c === ']')) {
            depth--
            if (depth === 0) return j
        }
    }
    return -1
}

/**
 * 由後往前,取第一個 judge(值) === true 者(兩種片段來源共用之單一選取規則;見檔頭【選取只有一份】)
 *
 * judge 回其他值即不合格;拋錯亦不合格,其結果記為「check 拋錯：<訊息>」(最多 120 字)。依序呼叫 judge,遇合格者即停
 *
 * @param {Array} values 輸入候選值陣列(依出現之序)
 * @param {Function} judge 輸入判定函數 (值) => true｜不合格之原因
 * @returns {Object} 回傳 { index:合格者之位置(皆不合格為 -1), last:末項之判定結果(末項不合格時為其回傳值或拋錯之說明;否則 undefined) }
 */
function lastPassing(values, judge) {
    let last
    for (let k = values.length - 1; k >= 0; k--) {
        let c
        try {
            c = judge(values[k])
        }
        catch (e) {
            c = `check 拋錯：${String(e?.message || e).slice(0, 120)}`
        }
        if (c === true) return { index: k, last }
        if (k === values.length - 1) last = c
    }
    return { index: -1, last }
}

/**
 * 回覆中之完整 JSON 片段(頂層;依出現之序;見檔頭【片段之找法】)與截斷之尾段之起點
 *
 * @param {*} text 輸入模型回覆
 * @returns {Object} 回傳 { text:清理後之文字, fragments:[{ value, start, end }], truncatedAt:Integer(截斷之尾段之起點;無則 -1) }
 * @example
 * console.log(jsonFragmentsOf('[{"index":1}]\n等等，更正如下：\n[{"index":1},{"index":2}]').fragments.map((f) => f.value.length))
 * // => [ 1, 2 ]
 *
 * console.log(jsonFragmentsOf('依意見 [3] 修改：{"edits":[]}').fragments.map((f) => JSON.stringify(f.value)))
 * // => [ '[3]', '{"edits":[]}' ]
 */
export function jsonFragmentsOf(text) {
    const s = cleanReply(text)
    const out = { text: s, fragments: [], truncatedAt: -1 }
    if (!s) return out
    // 整段即 JSON(最常見,最快路徑)
    try {
        const j = JSON.parse(s)
        if (j !== null && typeof j === 'object') {
            out.fragments.push({ value: j, start: 0, end: s.length - 1 })
            return out
        }
    }
    catch { /* 進入括號配對 */ }
    let i = 0
    while (i < s.length) {
        const c = s[i]
        if (c !== '{' && c !== '[') {
            i++
            continue
        }
        const end = closeOf(s, i)
        if (end < 0) {
            out.truncatedAt = i
            break
        }
        try {
            const j = JSON.parse(s.slice(i, end + 1))
            if (j !== null && typeof j === 'object') out.fragments.push({ value: j, start: i, end })
        }
        catch { /* 閉合而非 JSON(前言之括號等):整段略過 */ }
        i = end + 1
    }
    return out
}

/**
 * 取回覆中「最後一段合格」之 JSON(見檔頭):由後往前,第一段 check(d) === true 者;截斷放行時,截斷之尾段之搶救結果為最後一段
 *
 * @param {*} text 輸入模型回覆
 * @param {Function} check 輸入驗證函數 (data) => true｜不合格原因字串(其他值或拋錯亦不合格)
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Boolean} [opt.acceptTruncated=false] 輸入是否搶救截斷之尾段
 * @returns {Object} 回傳 { ok:Boolean, data(合格之段;不合格為 null), reason:String(不合格之原因;多段時註明段數與末段之原因),
 *   count:Integer(候選段數), truncated:Boolean(合格者為截斷之搶救結果) }
 * @example
 * const check = (d) => (Array.isArray(d) && d.length >= 2 ? true : '須至少 2 項')
 * console.log(pickJsonReply('[{"index":1}]\n等等，更正如下：\n[{"index":1},{"index":2}]', check).data.length)
 * // => 2
 *
 * console.log(pickJsonReply('[{"index":1},{"index":2}] 註：[3]', check).data.length)
 * // => 2
 */
export function pickJsonReply(text, check, opt = {}) {
    const fr = jsonFragmentsOf(text)
    const cands = fr.fragments.map((f) => ({ value: f.value, truncated: false }))
    if (opt?.acceptTruncated === true && fr.truncatedAt >= 0) {
        let t = null
        try {
            t = salvageTruncatedArray(fr.text.slice(fr.truncatedAt))
        }
        catch {
            t = null
        }
        if (t) cands.push({ value: t, truncated: true })
    }
    if (!cands.length) return { ok: false, data: null, reason: '非 JSON（或輸出截斷）', count: 0, truncated: false }
    const { index, last } = lastPassing(cands.map((c) => c.value), check)
    if (index >= 0) return { ok: true, data: cands[index].value, reason: '', count: cands.length, truncated: cands[index].truncated }
    const lastWhy = typeof last === 'string' && last ? last.slice(0, 200) : '未通過 check'
    return { ok: false, data: null, reason: cands.length > 1 ? `回覆含 ${cands.length} 段 JSON，皆未通過（末段：${lastWhy}）` : lastWhy, count: cands.length, truncated: false }
}

/**
 * 回覆中「含任一指定鍵」之物件(依出現之序;見檔頭【含鍵物件】)
 *
 * @param {*} text 輸入模型回覆(非字串以 String 轉)
 * @param {Array} keys 輸入須含之鍵(任一即可)，非陣列視為 [](即無候選)
 * @param {Function} [looseParse] 輸入 JSON.parse 不成時之寬鬆解析 (片段) => 值，非函數即不再試
 * @returns {Array} 回傳候選物件陣列
 */
function keyedObjectsOf(text, keys, looseParse) {
    const s = String(text ?? '')
    const want = Array.isArray(keys) ? keys : []
    const loose = typeof looseParse === 'function' ? looseParse : null
    const parse = (raw) => {
        try {
            return JSON.parse(raw)
        }
        catch {
            if (!loose) return null
            try {
                return loose(raw)
            }
            catch {
                return null
            }
        }
    }
    const found = []
    let i = s.indexOf('{')
    while (i >= 0) {
        const end = closeOf(s, i, { loose: true })
        const obj = end < 0 ? null : parse(s.slice(i, end + 1))
        if (obj && typeof obj === 'object' && !Array.isArray(obj) && want.some((k) => Object.prototype.hasOwnProperty.call(obj, k))) {
            found.push(obj)
            i = s.indexOf('{', end + 1)
            continue
        }
        i = s.indexOf('{', i + 1)
    }
    return found
}

/**
 * 取回覆中「含指定鍵」之物件之最後一個合格者(見檔頭【含鍵物件】【兩種片段來源為何不同】):由後往前取第一個 accept(物件) === true 者;
 *   未給 accept 或皆不合格時取最後一個含鍵者(交呼叫端之 check 判不合格);無含鍵者回 null
 *
 * @param {*} text 輸入模型回覆(非字串以 String 轉)
 * @param {Array} keys 輸入須含之鍵(任一即可，如 ['edits', 'adds', 'removes'])，非陣列視為 []
 * @param {Function} [accept] 輸入合格判定函數 (obj) => Boolean，嚴格 true 才合格(拋錯視同不合格)
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Function} [opt.looseParse] 輸入寬鬆解析函數 (片段) => 值(如 JSON5 之 parse;尾逗號、單引號等)，JSON.parse 不成時以之再試，未給即只認標準 JSON
 * @returns {Object|null} 回傳選中之物件，無含鍵者回 null
 * @example
 * console.log(pickKeyedJson('依意見 [3] 修改如下：{"edits":[]}', ['edits']).edits.length)
 * // => 0
 *
 * console.log(pickKeyedJson('{"ops":[1]}\n等等，更正如下：\n{"ops":[1,2]}', ['ops'], (j) => Array.isArray(j.ops)).ops.length)
 * // => 2
 *
 * console.log(pickKeyedJson('{"result":{"verdicts":[]}}', ['verdicts']))
 * // => { verdicts: [] }
 */
export function pickKeyedJson(text, keys, accept, opt = {}) {
    const found = keyedObjectsOf(text, keys, opt?.looseParse)
    if (!found.length) return null
    if (typeof accept === 'function') {
        const { index } = lastPassing(found, accept)
        if (index >= 0) return found[index]
    }
    return found[found.length - 1]
}

export default { jsonFragmentsOf, pickJsonReply, pickKeyedJson }
