// sourceScan.mjs — 測試用之原始碼掃描(不帶 .test. 中綴:共用層):逐字元之小型詞法器,產出①字串字面(面向使用者之字樣——日誌、訊息、
//   待判之原因與下一步)②去註解之程式碼(字串原樣)③骨架(去註解、字串換成編號之佔位)——模組指定詞與 cfg 之讀取點以骨架比對,
//   註解與字串之內容(含分號、引號、「import … from …」之字樣)不會干擾比對。
//
// 【做法】單引號／雙引號字串、樣板字面(含 ${…} 巢狀:文字段之間以 \u0000 相連,運算式內之字串另計)、行註解、區塊註解(保留換行)、
//   正規表示式字面(前一個有意義之字元為運算子／左括號／逗號等,或前一個詞為 return 等關鍵字時視為正規表示式;骨架中以不透明之記號代之)。
//   只供各套件之原始碼掃描(風格固定),不是通用 JavaScript 剖析器。
// 【為何一份】各套件之守門(邊界、舊名、中立、日誌字樣)皆以之掃原始碼:抓取套件之測試直接取本檔,摘要、關聯、提煉之測試經各自之
//   test/tools/captureForTest.mjs 取用(行首正則之舊版會漏抓 export 區塊內註解含「;」或引號之指定詞)。原始檔之走訪(sourceFilesOf)亦在本檔:
//   各守門之排除規則同一份(node_modules、test/_tmp 一律略過,其餘由呼叫端 exclude)。

import fs from 'node:fs'
import path from 'node:path'

const REGEX_PREV = '(,=:[!&|?{};+-*%<>~^'
const REGEX_KW = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'else', 'do', 'await', 'yield', 'instanceof'])

/**
 * 詞法掃描
 *
 * @param {String} src 輸入原始碼
 * @returns {Object} 回傳 { strings:Array(字串字面之內容;樣板字面之文字段以 \u0000 相連), code:String(去註解之程式碼,字串原樣),
 *   skeleton:String(去註解;字串字面換成 "#<序號>#"、含運算式之樣板只留運算式、正規表示式字面換成 /re/) }
 * @example
 * console.log(lexSource("import a from './a.mjs' // 註解;'x'").skeleton)
 * // => import a from "#0#"
 */
export function lexSource(src) {
    const s = String(src ?? '')
    const n = s.length
    const strings = []
    const stack = [] // 樣板字面之運算式層:{ depth:大括號深度, parts:文字段 }
    let code = ''
    let skeleton = ''
    let i = 0

    /** 讀樣板字面之一段文字(自 s[i] 起,至 ` 或 ${ 止) */
    const readTemplate = () => {
        let text = ''
        while (i < n) {
            const c = s[i]
            if (c === '\\') {
                text += s.slice(i, i + 2)
                i += 2
                continue
            }
            if (c === '`') {
                i++
                return { text, end: 'close' }
            }
            if (c === '$' && s[i + 1] === '{') {
                i += 2
                return { text, end: 'expr' }
            }
            text += c
            i++
        }
        return { text, end: 'eof' }
    }
    const tail = () => code.slice(-400)
    const lastSig = () => (/(\S)\s*$/.exec(tail()) || [])[1] || ''
    const lastWord = () => (/([A-Za-z_$][\w$]*)\s*$/.exec(tail()) || [])[1] || ''
    const both = (c) => {
        code += c
        skeleton += c
    }
    const hold = (text) => {
        strings.push(text)
        return `"#${strings.length - 1}#"`
    }

    while (i < n) {
        const c = s[i]
        const d = s[i + 1]
        const top = stack[stack.length - 1]
        if (c === '/' && d === '/') {
            const j = s.indexOf('\n', i)
            i = j < 0 ? n : j
            continue
        }
        if (c === '/' && d === '*') {
            const j = s.indexOf('*/', i + 2)
            const end = j < 0 ? n : j + 2
            both(s.slice(i, end).replace(/[^\n]/g, '') || ' ')
            i = end
            continue
        }
        if (c === '\'' || c === '"') {
            let j = i + 1
            let text = ''
            while (j < n && s[j] !== c && s[j] !== '\n') {
                if (s[j] === '\\') {
                    text += s.slice(j, j + 2)
                    j += 2
                    continue
                }
                text += s[j]
                j++
            }
            code += `${c}${text}${c}`
            skeleton += hold(text)
            i = j + 1
            continue
        }
        if (c === '`') {
            i++
            const seg = readTemplate()
            code += `\`${seg.text}`
            if (seg.end === 'expr') {
                stack.push({ depth: 0, parts: [seg.text] })
                code += '${'
                skeleton += '`${'
                continue
            }
            code += '`'
            skeleton += hold(seg.text)
            continue
        }
        if (c === '{' && top) {
            top.depth++
            both(c)
            i++
            continue
        }
        if (c === '}' && top) {
            if (top.depth > 0) {
                top.depth--
                both(c)
                i++
                continue
            }
            i++
            both('}')
            const seg = readTemplate()
            top.parts.push(seg.text)
            code += seg.text
            if (seg.end === 'expr') {
                both('${')
                continue
            }
            stack.pop()
            strings.push(top.parts.join('\u0000'))
            both('`')
            continue
        }
        if (c === '/') {
            const p = lastSig()
            if (p === '' || REGEX_PREV.includes(p) || REGEX_KW.has(lastWord())) {
                let j = i + 1
                let inClass = false
                while (j < n && s[j] !== '\n') {
                    const x = s[j]
                    if (x === '\\') {
                        j += 2
                        continue
                    }
                    if (x === '[') inClass = true
                    else if (x === ']') inClass = false
                    else if (x === '/' && !inClass) break
                    j++
                }
                j++
                while (j < n && /[a-z]/i.test(s[j])) j++
                code += s.slice(i, j)
                skeleton += '/re/'
                i = j
                continue
            }
        }
        both(c)
        i++
    }
    return { strings, code, skeleton }
}

/**
 * 掃描原始碼(字串字面與去註解之程式碼;lexSource 之子集)
 *
 * @param {String} src 輸入原始碼
 * @returns {Object} 回傳 { strings, code }
 */
export function scanSource(src) {
    const { strings, code } = lexSource(src)
    return { strings, code }
}

const SPEC = '"#(\\d+)#"'

/** 模組指定詞之形式(於骨架上比對;子句內只容識別字、大括號、逗號、星號與 as——跨語句者不成立) */
const SPEC_PATTERNS = Object.freeze([
    new RegExp(`\\bimport\\s+(?:[\\w$]+\\s*,?\\s*)?(?:\\*\\s*as\\s+[\\w$]+|\\{[^{}]*\\})?\\s*from\\s*${SPEC}`, 'g'),
    new RegExp(`\\bexport\\s+(?:\\*(?:\\s*as\\s+[\\w$]+)?|\\{[^{}]*\\})\\s*from\\s*${SPEC}`, 'g'),
    new RegExp(`\\bimport\\s*${SPEC}`, 'g'),
    new RegExp(`\\bimport\\s*\\(\\s*${SPEC}`, 'g'),
    new RegExp(`\\brequire\\s*\\(\\s*${SPEC}\\s*\\)`, 'g'),
])

/**
 * 原始碼中之模組指定詞(靜態 import、export … from、副作用 import、動態 import、require):先剝註解與字串再比對(檔頭)
 *
 * @param {String} src 輸入原始碼
 * @returns {Array} 回傳指定詞字串陣列
 * @example
 * console.log(specifiersOf("export {\n    a, // 說明;含 'x'\n} from './a.mjs'"))
 * // => [ './a.mjs' ]
 */
export function specifiersOf(src) {
    const { skeleton, strings } = lexSource(src)
    const out = []
    for (const re of SPEC_PATTERNS) for (const m of skeleton.matchAll(re)) out.push(strings[Number(m[1])])
    return out
}

/**
 * 埠之轉出名:export { … } from 之子句(「x as y」取對外之名 y);於骨架上比對,註解與字串之內容不干擾
 *
 * @param {String} src 輸入原始碼
 * @returns {Array} 回傳名稱陣列(依出現序)
 * @example
 * console.log(exportedNamesOf("export {\n    a, // 說明;b\n    c as d,\n} from '../x.mjs'"))
 * // => [ 'a', 'd' ]
 */
export function exportedNamesOf(src) {
    const { skeleton } = lexSource(src)
    const out = []
    for (const m of skeleton.matchAll(new RegExp(`\\bexport\\s*\\{([^{}]*)\\}\\s*from\\s*${SPEC}`, 'g'))) {
        for (const t of m[1].split(',')) {
            const s = t.trim()
            if (!s) continue
            const [a, b] = s.split(/\s+as\s+/)
            out.push((b || a).trim())
        }
    }
    return out
}

/**
 * 具名匯入:import { … } from 之子句之 { spec, name }(「y as z」取被匯入之名 y);於骨架上比對,註解與字串之內容不干擾
 *
 * @param {String} src 輸入原始碼
 * @returns {Array} 回傳 [{ spec:指定詞, name:被匯入之名 }]
 * @example
 * console.log(namedImportsOf("import { d as e, a } from '../core/capturePackage.mjs'").map((x) => x.name))
 * // => [ 'd', 'a' ]
 */
export function namedImportsOf(src) {
    const { skeleton, strings } = lexSource(src)
    const out = []
    for (const m of skeleton.matchAll(new RegExp(`\\bimport\\s*\\{([^{}]*)\\}\\s*from\\s*${SPEC}`, 'g'))) {
        const spec = strings[Number(m[2])]
        for (const t of m[1].split(',')) {
            const s = t.trim()
            if (s) out.push({ spec, name: s.split(/\s+as\s+/)[0].trim() })
        }
    }
    return out
}

/**
 * 走訪套件根下之原始檔(各套件之守門同一份走訪:相對路徑、正斜線、排序;一律略過 node_modules 與 test/_tmp——並行之他測試會在 test/_tmp 建立與刪除檔案)
 *
 * @param {String} root 輸入套件根
 * @param {Object} [o={}] 輸入 { ext?:String(副檔名,預設 '.mjs';'' 為全部), exclude?:Array(另略過之頂層目錄名或相對路徑,如 ['test', 'bench']) }
 * @returns {Array} 回傳相對路徑陣列
 * @example
 * // sourceFilesOf(PKG, { exclude: ['test'] }) → ['WKnowledgeX.mjs', 'core/a.mjs', …]
 */
export function sourceFilesOf(root, o = {}) {
    const ext = typeof o?.ext === 'string' ? o.ext : '.mjs'
    const exclude = new Set(Array.isArray(o?.exclude) ? o.exclude : [])
    const out = []
    const walk = (rel) => {
        let entries = []
        try {
            entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
        }
        catch {
            return
        }
        for (const d of entries) {
            const r = rel ? `${rel}/${d.name}` : d.name
            if (d.isDirectory()) {
                if (d.name === 'node_modules' || r === 'test/_tmp' || exclude.has(r) || exclude.has(d.name)) continue
                walk(r)
            }
            else if (!ext || d.name.endsWith(ext)) out.push(r)
        }
    }
    walk('')
    return out.sort()
}

export default { lexSource, scanSource, specifiersOf, exportedNamesOf, namedImportsOf, sourceFilesOf }
