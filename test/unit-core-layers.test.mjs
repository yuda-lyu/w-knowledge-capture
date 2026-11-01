// unit-core-layers.test.mjs — 套件內模組分層契約(相對 import 之方向):
//   ①core/ 只引用 core/(不 import 其他模組目錄,也不 import 套件根之組裝器)——核心件是抓取各層共用之底層;執行秩序件之單一匯入點
//     core/runnerPackage.mjs 只以套件指定詞取自有套件(無相對 import;邊界與同一實體另見套件結構測試)
//   ②fetchers／stores／standards／domain／ops 不 import 套件根之組裝器(captureObject、createKnowledgeCapture、WKnowledgeCapture、rejects),
//     也不 import stages(stages 是動作鏈層,位於其上)
//   ③所有相對 import 皆指向存在之檔案
//   【為何要有】分層方向一旦被反向依賴(底層引用組裝器或動作鏈),抽提為套件後之單元測試與替換就會牽一髮動全身;以本測試把關,新增 import 違反方向即失敗
//   套件邊界(不 import 套件外之專案程式)另見套件結構測試
// 執行:自套件根 npx mocha test/unit-core-layers.test.mjs(只讀原始碼,不落檔)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 原始碼根(套件根下之 src/)以本檔位置推導(與 cwd 無關;自他處執行時不得掃到套件外之檔案);下文「套件根」之組裝器指 src/ 根之檔案,相對路徑皆相對 src/
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
const MODULE_DIRS = ['core', 'fetchers', 'stores', 'standards', 'domain', 'ops', 'stages', 'bench']
const LOW_DIRS = ['fetchers', 'stores', 'standards', 'domain', 'ops']
/** 執行秩序件之單一匯入點(只以套件指定詞取自有套件,不得有相對 import) */
const ORDER_BRIDGE = 'core/runnerPackage.mjs'
const SPEC_RE = /(?:from\s+|import\s+|import\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/g

const posix = (p) => p.replace(/\\/g, '/')
const topOf = (rel) => (rel.includes('/') ? rel.split('/')[0] : '(root)')

/**
 * 套件原始碼之 .mjs(相對路徑);不進 test 與 node_modules(走訪時即略過,不先遍歷再過濾:
 * 並行執行時遞迴遍歷會走進他檔正在清除之 test/_tmp 而 ENOENT)
 *
 * @returns {Array} 回傳相對路徑陣列
 */
function sourceFiles() {
    const out = []
    const walk = (rel) => {
        for (const d of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
            const r = rel ? `${rel}/${d.name}` : d.name
            if (d.isDirectory()) {
                if (!rel && (d.name === 'test' || d.name === 'node_modules')) continue
                walk(r)
            }
            else if (d.name.endsWith('.mjs')) out.push(r)
        }
    }
    walk('')
    return out
}

/**
 * 一支原始碼之相對 import 目標(相對套件根之路徑)
 *
 * @param {String} rel 輸入來源檔之相對路徑
 * @returns {Array} 回傳目標相對路徑陣列
 */
function importsOf(rel) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    const out = []
    for (const m of code.matchAll(SPEC_RE)) {
        out.push(posix(path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, rel)), m[2]))))
    }
    return out
}

describe('unit-core-layers', function() {

    it('前提:原始碼之各層目錄皆存在且有檔案(避免掃描範圍為空而本檔全數虛過)', () => {
        const files = sourceFiles()
        for (const d of MODULE_DIRS) assert.ok(files.some((f) => topOf(f) === d), `目錄 ${d}/ 無原始碼`)
        assert.ok(files.some((f) => topOf(f) === '(root)'), '套件根無原始碼')
        assert.ok(files.length >= 40, `原始碼檔數 ${files.length}`)
        const n = files.reduce((a, f) => a + importsOf(f).length, 0)
        assert.ok(n >= 100, `相對 import 數 ${n}(過少代表 import 抽取式樣失效,以下各案會虛過)`)
        assert.ok(importsOf('stages/listFetchStage.mjs').includes('stores/sourcePolicy.mjs'), 'import 抽取式樣須取得實際之相對 import 目標')
    })

    it('core/ 只引用 core/:不 import 其他模組目錄,也不 import 套件根之組裝器;執行秩序件之單一匯入點無相對 import', () => {
        const bad = []
        for (const f of sourceFiles().filter((x) => topOf(x) === 'core')) {
            for (const t of importsOf(f)) {
                if (topOf(t) !== 'core') bad.push(`${f} → ${t}`)
            }
        }
        assert.deepEqual(bad, [])
        assert.ok(sourceFiles().includes(ORDER_BRIDGE), '前提:單一匯入點存在')
        assert.deepEqual(importsOf(ORDER_BRIDGE), [], '單一匯入點只取自有套件之指定詞(相對 import 為零)')
    })

    it('fetchers／stores／standards／domain／ops 不 import 套件根之組裝器,也不 import stages(動作鏈層位於其上)', () => {
        const bad = []
        for (const f of sourceFiles().filter((x) => LOW_DIRS.includes(topOf(x)))) {
            for (const t of importsOf(f)) {
                const top = topOf(t)
                if (top === '(root)' || top === 'stages') bad.push(`${f} → ${t}`)
            }
        }
        assert.deepEqual(bad, [])
    })

    it('stages/ 不 import 套件根之組裝器(組裝器引用 stages,方向不可反)', () => {
        const bad = []
        for (const f of sourceFiles().filter((x) => topOf(x) === 'stages')) {
            for (const t of importsOf(f)) if (topOf(t) === '(root)') bad.push(`${f} → ${t}`)
        }
        assert.deepEqual(bad, [])
    })

    it('bench/(AI 能力評分層)不 import 套件根之組裝器與 stages;其餘各層不 import bench(評分層位於其上,只由主入口轉出)', () => {
        const bad = []
        for (const f of sourceFiles()) {
            const top = topOf(f)
            for (const t of importsOf(f)) {
                if (top === 'bench' && (topOf(t) === '(root)' || topOf(t) === 'stages')) bad.push(`${f} → ${t}`)
                if (top !== 'bench' && top !== '(root)' && topOf(t) === 'bench') bad.push(`${f} → ${t}`)
            }
        }
        assert.deepEqual(bad, [])
        assert.ok(importsOf('bench/benchKit.mjs').includes('core/ai/adapter.mjs'), '前提:評分層之相對 import 有被取得')
    })

    it('所有相對 import 皆指向存在之檔案', () => {
        const bad = []
        for (const f of sourceFiles()) {
            for (const t of importsOf(f)) if (!fs.existsSync(path.join(ROOT, t))) bad.push(`${f} → ${t}`)
        }
        assert.deepEqual(bad, [])
    })
})
