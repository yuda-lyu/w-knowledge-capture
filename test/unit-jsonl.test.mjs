// unit-jsonl.test.mjs — append-only JSONL 帳之讀寫共用件(core/util/jsonl;四套件之稽核帳、事件帳、處置帳、回溯帳、影響帳同一份)
// 規則(出自 core/util/jsonl 檔頭與 JSDoc;2026-10-12 關聯套件審計終審 D15):
//   ①缺檔＝空帳([]);②壞行(無法解析或非物件之列,含檔尾截斷之半行)略過並逐行回報 { line, error }(未給 onBad 即靜默略過),不整檔作廢;
//   ③讀取本身失敗(路徑為目錄等)即拋「JSONL 帳讀取失敗」,不假裝成空帳;④append 先補尾換行:檔尾非換行時先補一個換行,前次被砍之半行不與本列黏成一行;
//   ⑤目錄於首次寫入時建立;空陣列不寫、不建目錄;⑥appendJsonlRow 為單列形,寫入之列與讀回逐欄相同
// 執行:自套件根 node <mocha> test/unit-jsonl.test.mjs(暫存 test/_tmp/jsonl-<pid>,測完即刪)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpRoot, removeRoots } from './tools/captureTestKit.mjs'
import { readJsonlRows, appendJsonlRows, appendJsonlRow } from '../src/core/util/jsonl.mjs'

describe('unit-jsonl', function() {

    let root = ''
    let seq = 0
    const fileOf = () => `${root}/c${++seq}/state/x.jsonl`
    before(() => {
        root = tmpRoot('jsonl')
    })
    after(() => {
        removeRoots([root])
    })

    it('①缺檔＝[];⑤首次寫入建目錄、空陣列不寫不建;⑥單列與多列寫入後讀回逐欄相同、依寫入序', () => {
        const f = fileOf()
        assert.deepEqual(readJsonlRows(f), [])
        assert.deepEqual(appendJsonlRows(f, []), [])
        assert.equal(fs.existsSync(path.dirname(f)), false, '空陣列不建目錄')
        assert.deepEqual(appendJsonlRow(f, { a: 1, s: '中文,"引號"' }), { a: 1, s: '中文,"引號"' })
        appendJsonlRows(f, [{ b: 2 }, { c: [3] }])
        assert.deepEqual(readJsonlRows(f), [{ a: 1, s: '中文,"引號"' }, { b: 2 }, { c: [3] }])
        assert.equal(fs.readFileSync(f, 'utf8'), '{"a":1,"s":"中文,\\"引號\\""}\n{"b":2}\n{"c":[3]}\n', '每列一行、以換行結尾')
    })

    it('②壞行略過並回報行號與原因(無法解析、非物件;空行不計);未給 onBad 即靜默略過', () => {
        const f = fileOf()
        fs.mkdirSync(path.dirname(f), { recursive: true })
        fs.writeFileSync(f, '{"a":1}\n\nnull\n[1]\n{"b":2}\n{"c":', 'utf8')
        const bad = []
        assert.deepEqual(readJsonlRows(f, { onBad: (b) => bad.push(b) }), [{ a: 1 }, { b: 2 }])
        assert.deepEqual(bad.map((b) => b.line), [3, 4, 6])
        assert.deepEqual(bad.slice(0, 2).map((b) => b.error), ['不是物件', '不是物件'])
        assert.ok(bad[2].error.length > 0 && bad[2].error.length <= 120, '解析錯誤之原因截 120 字')
        assert.deepEqual(readJsonlRows(f), [{ a: 1 }, { b: 2 }], '未給 onBad 亦略過壞行')
    })

    it('③讀取本身失敗(路徑為目錄)即拋 JSONL 帳讀取失敗,不當空帳', () => {
        const f = fileOf()
        fs.mkdirSync(f, { recursive: true })
        assert.throws(() => readJsonlRows(f), /^Error: JSONL 帳讀取失敗（x\.jsonl）：/)
    })

    it('④尾端半行之續寫:檔尾非換行時先補換行,壞的只有那半行、新列完好;檔尾已有換行者不多補', () => {
        const f = fileOf()
        fs.mkdirSync(path.dirname(f), { recursive: true })
        fs.writeFileSync(f, '{"a":1}\n{"b":', 'utf8')
        appendJsonlRow(f, { c: 3 })
        assert.equal(fs.readFileSync(f, 'utf8'), '{"a":1}\n{"b":\n{"c":3}\n')
        const bad = []
        assert.deepEqual(readJsonlRows(f, { onBad: (b) => bad.push(b) }), [{ a: 1 }, { c: 3 }])
        assert.deepEqual(bad.map((b) => b.line), [2])
        appendJsonlRow(f, { d: 4 })
        assert.equal(fs.readFileSync(f, 'utf8'), '{"a":1}\n{"b":\n{"c":3}\n{"d":4}\n', '檔尾已有換行不多補空行')
        const g = fileOf()
        fs.mkdirSync(path.dirname(g), { recursive: true })
        fs.writeFileSync(g, '', 'utf8')
        appendJsonlRow(g, { e: 5 })
        assert.equal(fs.readFileSync(g, 'utf8'), '{"e":5}\n', '空檔不補換行')
    })
})
