// unit-ai-json-reply.test.mjs — 模型回覆之 JSON 抽取(core/ai/jsonReply):取「最後一段合格」之完整 JSON
// 規則(出自 core/ai/jsonReply 檔頭):
//   ①片段:去 ANSI 色碼與 code fence → 整段可解析即唯一一段 → 否則於頂層以括號配對(字串與跳脫感知)取完整片段;閉合而解析失敗者整段略過、
//     自其後續找;未閉合者為截斷之尾段(其後不再找,其內之元素不另當作一段);只收物件與陣列
//   ②合格:候選由後往前,取第一段 check(d) === true 者——模型先回一段、再「更正如下」回完整一段時取後者;前言之括號與尾隨說明之小片段由 check 篩掉;
//     check 回字串＝不合格之原因,回其他值或拋錯亦不合格;皆不合格即不合格(原因註明段數與末段之原因)
//   ③截斷放行(opt.acceptTruncated:true):截斷之尾段以 salvageTruncatedArray 搶救(只收前段完整之頂層物件元素),救得回即為最後一段;未開不搶救
//   ④取後者之代價:check 只驗「是陣列」時,尾隨說明之小片段(如「見 [3]」)會被取——呼叫端之 check 須驗到項目之形狀
//   ⑤含鍵物件(pickKeyedJson):自每個「{」起以大括號配對(雙／單引號皆為字串、跳脫感知)取完整物件;JSON.parse 不成即以注入之寬鬆解析
//     (opt.looseParse)再試;為物件且含任一指定鍵者為一個候選(其內不另列),不含鍵者往其內找;未閉合之「{」不中止掃描;不去 ANSI 與 code fence
//   ⑥選取與 pickJsonReply 同一規則:由後往前取第一個 accept(物件) === true 者(拋錯視同不合格);未給 accept 或皆不合格取最後一個含鍵者;無含鍵者回 null
// 執行:自套件根 npx mocha test/unit-ai-json-reply.test.mjs(純函數;不連網路、不呼叫真 AI、不寫檔)

import assert from 'node:assert/strict'
import jsonReply, { jsonFragmentsOf, pickJsonReply, pickKeyedJson } from '../src/core/ai/jsonReply.mjs'

// 至少一項帶整數 index 才合格(各工作之 check 皆驗到項目之形狀)
const byIndex = (d) => (Array.isArray(d) && d.some((x) => Number.isInteger(x?.index)) ? true : '無帶整數 index 之項')
// 只驗「是陣列」(對照組:④)
const loose = (d) => (Array.isArray(d) ? true : '須為陣列')
const ESC = String.fromCharCode(27)

describe('unit-ai-json-reply', function() {

    describe('jsonFragmentsOf(規則①)', function() {

        it('整段即 JSON:唯一一段、無截斷;空字串與非 JSON 文字無片段', () => {
            const f = jsonFragmentsOf('  [{"index":1}]  ')
            assert.deepEqual([f.fragments.length, f.fragments[0].value, f.truncatedAt], [1, [{ index: 1 }], -1])
            for (const t of ['', null, undefined, '好的,這是純文字。', '42', '"str"', 'null']) {
                const g = jsonFragmentsOf(t)
                assert.deepEqual([g.fragments.length, g.truncatedAt], [0, -1], JSON.stringify(t))
            }
        })

        it('多段依出現之序;前言之括號為一段;閉合而解析失敗者(「[注意]」)略過且自其後續找;字串內之括號不計', () => {
            const f = jsonFragmentsOf('[注意] 依意見 [3] 修改：{"edits":[{"ref":"a]1"}]}\n等等，更正如下：\n{"edits":[]}')
            assert.deepEqual(f.fragments.map((x) => x.value), [[3], { edits: [{ ref: 'a]1' }] }, { edits: [] }])
            assert.equal(f.truncatedAt, -1)
        })

        it('code fence 與 ANSI 色碼先剝除;起訖位置對應清理後之文字', () => {
            const f = jsonFragmentsOf(`${ESC}[32m前言${ESC}[0m\n\`\`\`json\n[{"index":1}]\n\`\`\`\n說明`)
            assert.deepEqual(f.fragments.map((x) => x.value), [[{ index: 1 }]])
            const { start, end } = f.fragments[0]
            assert.equal(f.text.slice(start, end + 1), '[{"index":1}]')
        })

        it('未閉合者為截斷之尾段:記其起點、其後不再找、其內完整之元素不另當作一段;其前之完整片段照收', () => {
            const f = jsonFragmentsOf('[{"index":1}]\n更正如下：\n[{"index":1},{"index":2},{"index":3,"v":"c')
            assert.deepEqual(f.fragments.map((x) => x.value), [[{ index: 1 }]])
            assert.equal(f.text.slice(f.truncatedAt, f.truncatedAt + 12), '[{"index":1}')
        })
    })

    describe('pickJsonReply:取最後一段合格者(規則②)', function() {

        it('自我更正(先回一段、再「更正如下」回完整一段):取後者', () => {
            const r = pickJsonReply('[{"index":1,"v":"a"}]\n等等，我漏了兩項，更正如下：\n[{"index":1,"v":"a"},{"index":2,"v":"b"},{"index":3,"v":"c"}]', byIndex)
            assert.deepEqual([r.ok, r.data.map((x) => x.index), r.count, r.truncated, r.reason], [true, [1, 2, 3], 2, false, ''])
        })

        it('前言之括號(「依意見 [3]」)不被取:其後之正式輸出合格即取之(取第一段之作法會拿到 [3])', () => {
            const r = pickJsonReply('依意見 [3] 整理如下：[{"index":1},{"index":2}]', byIndex)
            assert.deepEqual([r.ok, r.data.length, r.count], [true, 2, 2])
        })

        it('尾隨說明之小片段由 check 篩掉:末段不合格即往前取', () => {
            const r = pickJsonReply('[{"index":1},{"index":2}]\n註：第 2 項見原文 [3]，另 {"note":"x"}', byIndex)
            assert.deepEqual([r.ok, r.data.length, r.count], [true, 2, 3])
        })

        it('末段合格而前段不合格:取末段;只有一段:即該段', () => {
            assert.deepEqual(pickJsonReply('{"oops":1}\n[{"index":7}]', byIndex).data, [{ index: 7 }])
            assert.deepEqual(pickJsonReply('[{"index":7}]', byIndex).data, [{ index: 7 }])
        })

        it('check 須回嚴格之 true:回字串為不合格之原因;回 1／"true"／物件亦不合格;拋錯不外洩(記原因)', () => {
            for (const v of [1, 'true', {}, [], null, undefined]) {
                const r = pickJsonReply('[{"index":1}]', () => v)
                assert.equal(r.ok, false, JSON.stringify(v))
            }
            assert.equal(pickJsonReply('[{"index":1}]', () => '缺欄位 x').reason, '缺欄位 x')
            const t = pickJsonReply('[{"index":1}]', () => {
                throw new Error('壞了')
            })
            assert.deepEqual([t.ok, t.reason], [false, 'check 拋錯：壞了'])
        })

        it('皆不合格:不合格;單段時為該段之原因,多段時註明段數與末段之原因;無片段為「非 JSON（或輸出截斷）」', () => {
            const one = pickJsonReply('[3]', byIndex)
            assert.deepEqual([one.ok, one.data, one.reason, one.count], [false, null, '無帶整數 index 之項', 1])
            const two = pickJsonReply('[3] 與 {"x":1}', (d) => (Array.isArray(d) ? '陣列不收' : '物件不收'))
            assert.deepEqual([two.ok, two.reason, two.count], [false, '回覆含 2 段 JSON，皆未通過（末段：物件不收）', 2])
            const none = pickJsonReply('好的,這是純文字。', byIndex)
            assert.deepEqual([none.ok, none.reason, none.count], [false, '非 JSON（或輸出截斷）', 0])
        })

        it('check 只驗「是陣列」時,尾隨之小片段會被取——呼叫端之 check 須驗到項目之形狀(規則④對照)', () => {
            assert.deepEqual(pickJsonReply('[{"index":1},{"index":2}]\n註：見 [3]', loose).data, [3])
            assert.equal(pickJsonReply('[{"index":1},{"index":2}]\n註：見 [3]', byIndex).data.length, 2)
        })
    })

    describe('截斷放行(規則③)', function() {

        it('只有截斷之陣列:開啟時搶救前段完整之項(truncated:true);未開判「非 JSON（或輸出截斷）」;0 項可救亦不合格', () => {
            const cut = '[{"index":1,"v":"a"},{"index":2,"v":"b"},{"index":3,"v":"c'
            const on = pickJsonReply(cut, byIndex, { acceptTruncated: true })
            assert.deepEqual([on.ok, on.data.map((x) => x.index), on.truncated], [true, [1, 2], true])
            const off = pickJsonReply(cut, byIndex)
            assert.deepEqual([off.ok, off.reason], [false, '非 JSON（或輸出截斷）'])
            for (const v of ['yes', 1, null]) assert.equal(pickJsonReply(cut, byIndex, { acceptTruncated: v }).ok, false, `非 true 視為未開:${JSON.stringify(v)}`)
            assert.equal(pickJsonReply('[{"index":1,"v":"a', byIndex, { acceptTruncated: true }).ok, false)
        })

        it('完整一段＋截斷之更正版:開啟時搶救結果為最後一段而優先;未開即取完整之那段', () => {
            const t = '[{"index":1}]\n更正如下：\n[{"index":1},{"index":2},{"index":3,"v":"c'
            const on = pickJsonReply(t, byIndex, { acceptTruncated: true })
            assert.deepEqual([on.data.length, on.truncated, on.count], [2, true, 2])
            const off = pickJsonReply(t, byIndex)
            assert.deepEqual([off.data.length, off.truncated, off.count], [1, false, 1])
        })

        it('截斷之尾段前有前言括號(「[注意]」):前言略過、尾段照常搶救(上游自全文第一個 [ 起搶救者會誤判已閉合)', () => {
            const r = pickJsonReply('[注意] 以下為結果：[{"index":1},{"index":2},{"index":3,"v":"c', byIndex, { acceptTruncated: true })
            assert.deepEqual([r.ok, r.data.length, r.truncated], [true, 2, true])
        })

        it('外包物件之截斷被搶救成內層陣列(形狀改變):物件 check 判不合格', () => {
            const t = '{"ops":[{"op":"add"},{"op":"confirm"},{"op":"essence","text":"x'
            const strict = (d) => (!!d && typeof d === 'object' && !Array.isArray(d) && Array.isArray(d.ops) ? true : '須為外包物件 { ops }')
            const r = pickJsonReply(t, strict, { acceptTruncated: true })
            assert.deepEqual([r.ok, r.reason], [false, '須為外包物件 { ops }'])
            assert.equal(Array.isArray(pickJsonReply(t, loose, { acceptTruncated: true }).data), true)
        })
    })

    describe('pickKeyedJson:含鍵物件之最後一個合格者(規則⑤⑥)', function() {

        // 各棒形態之 check(嚴格布林)
        const hasOps = (j) => !!j && Array.isArray(j.ops)
        const PATCH = ['edits', 'adds', 'removes']
        // 寬鬆解析之替身:單引號字串改雙引號、去尾逗號(只驗注入機制;正式由呼叫端注入寬鬆 JSON 之解析器,本套件不依賴之)
        const looseStub = (raw) => JSON.parse(raw.replace(/'([^'\\]*)'/g, (m, s) => JSON.stringify(s)).replace(/,\s*([}\]])/g, '$1'))

        it('取最後一個合格者:自我更正取後者;末個不過 accept 即往前取;未給 accept 取最後一個含鍵者;accept 依由後往前之序呼叫、遇合格即停', () => {
            const fix = '{"ops":[{"op":"add","text":"a"}],"skipped":[]}\n等等，更正如下：\n{"ops":[{"op":"add","text":"a"},{"op":"confirm","id":"C1"}],"skipped":[]}'
            assert.equal(pickKeyedJson(fix, ['ops'], hasOps).ops.length, 2)
            assert.equal(pickKeyedJson(fix, ['ops']).ops.length, 2, '未給 accept:最後一個含鍵者')
            const tailBad = '{"ops":[{"op":"add","text":"a"}]}\n補充：{"ops":"無"}'
            assert.equal(pickKeyedJson(tailBad, ['ops'], hasOps).ops.length, 1, '末個不過 → 往前取')
            assert.equal(pickKeyedJson(tailBad, ['ops']).ops, '無', '未給 accept:取最後一個含鍵者(交呼叫端之 check 判不合格)')
            const seen = []
            const three = '{"ops":[1]} {"ops":"x"} {"ops":"y"}'
            const got = pickKeyedJson(three, ['ops'], (j) => {
                seen.push(j.ops)
                return Array.isArray(j.ops)
            })
            assert.deepEqual([got.ops, seen], [[1], ['y', 'x', [1]]], '由後往前、遇合格即停')
            assert.deepEqual(pickKeyedJson(three, ['ops'], () => false).ops, 'y', '皆不合格:取最後一個含鍵者')
        })

        it('accept 只認嚴格 true(回 1／"true" 不算);拋錯視同不合格(不外洩);非函數視為未給', () => {
            const t = '{"ops":[1]} 另 {"ops":[2]}'
            assert.deepEqual(pickKeyedJson(t, ['ops'], (j) => (j.ops[0] === 1 ? true : 1)).ops, [1], '回 1 不算合格 → 往前取到嚴格 true 者')
            assert.deepEqual(pickKeyedJson(t, ['ops'], (j) => (j.ops[0] === 1 ? true : 'true')).ops, [1])
            const thrown = pickKeyedJson(t, ['ops'], (j) => {
                if (j.ops[0] === 2) throw new Error('壞了')
                return true
            })
            assert.deepEqual(thrown.ops, [1], '拋錯之候選不合格,往前取')
            assert.deepEqual(pickKeyedJson(t, ['ops'], () => {
                throw new Error('壞了')
            }).ops, [2], '皆拋錯:取最後一個含鍵者')
            assert.deepEqual(pickKeyedJson(t, ['ops'], 'x').ops, [2], 'accept 非函數:取最後一個含鍵者')
        })

        it('片段之找法:前言之 [3] 與不含鍵之物件不成候選;不含鍵之外包物件往其內找;含鍵之物件其內不另列;keys 任一即可', () => {
            assert.equal(pickKeyedJson('依意見 [3] 修改：{"edits":[{"ref":"a1_1"}]}', PATCH).edits[0].ref, 'a1_1')
            assert.equal(pickKeyedJson('[3]', ['edits']), null)
            assert.deepEqual(pickKeyedJson('{"result":{"verdicts":[1]}}', ['verdicts']), { verdicts: [1] }, '外包物件不含鍵:往其內找')
            assert.deepEqual(pickKeyedJson('{"data":{"inner":{"issues":[]}},"note":"x"}', ['issues']), { issues: [] }, '兩層外包')
            const seen = []
            const outer = pickKeyedJson('{"edits":[{"ref":"a","edits":[]}]}', ['edits'], (j) => {
                seen.push(j)
                return false
            })
            assert.deepEqual([outer.edits, seen.length], [[{ ref: 'a', edits: [] }], 1], '含鍵之物件整段為一個候選,其內含鍵之物件不另列')
            assert.deepEqual(pickKeyedJson('{"adds":[1]}', PATCH), { adds: [1] }, 'keys 任一即可')
            assert.equal(pickKeyedJson('{"note":"x"}', ['ops']), null, '無含鍵者回 null')
            assert.equal(pickKeyedJson('{"opsx":[1]}', ['ops']), null, '鍵名須完全相同')
            assert.equal(pickKeyedJson('{bad}', ['ops'], undefined, { looseParse: () => Object.create({ ops: [1] }) }), null, '只認自有屬性之鍵(繼承而來者不算)')
        })

        it('字串與跳脫:雙引號字串內之大括號與單引號不計;單引號字串內之大括號亦不計(寬鬆 JSON);未閉合之「{」不中止,往其內找', () => {
            assert.deepEqual(pickKeyedJson('{"text":"it\'s {not} a brace }","ops":[1]}', ['ops']), { text: 'it\'s {not} a brace }', ops: [1] })
            assert.deepEqual(pickKeyedJson('{"text":"a \\"}\\" b","ops":[1]}', ['ops']), { text: 'a "}" b', ops: [1] }, '跳脫之雙引號')
            const sq = "{'note': 'a}b', 'ops': [1]}"
            assert.deepEqual(pickKeyedJson(sq, ['ops'], undefined, { looseParse: looseStub }), { note: 'a}b', ops: [1] }, '單引號字串內之 } 不收尾')
            assert.deepEqual(pickKeyedJson('{ 說明 it\'s {"ops":[2]} }', ['ops']), { ops: [2] }, '外層因單引號(視為字串起點)配對不到:視同未閉合,往其內找')
            assert.deepEqual(pickKeyedJson('{ 未閉合之前言 {"ops":[2]}', ['ops']), { ops: [2] }, '未閉合之外層:往其內找')
            assert.equal(pickKeyedJson("{'ops': [1], 'note': 'a}b'}", ['ops']), null, '未注入寬鬆解析:單引號之物件不成候選,其內亦無標準 JSON 物件')
            assert.deepEqual(pickKeyedJson('{"ops":[1]} {"ops":[2', ['ops'], hasOps), { ops: [1] }, '截斷之尾段不成候選、不搶救')
        })

        it('寬鬆解析之注入:未注入只認標準 JSON(尾逗號、單引號者不成候選);注入後 JSON.parse 不成者以之再試;寬鬆解析拋錯視同非物件', () => {
            const t = "{'ops': [],}"
            assert.equal(pickKeyedJson(t, ['ops']), null, '未注入')
            assert.equal(pickKeyedJson(t, ['ops'], undefined, { looseParse: 'x' }), null, '非函數視為未注入')
            assert.deepEqual(pickKeyedJson(t, ['ops'], undefined, { looseParse: looseStub }), { ops: [] })
            let calls = 0
            const counted = (raw) => {
                calls++
                return looseStub(raw)
            }
            assert.deepEqual(pickKeyedJson('{"ops":[1]}', ['ops'], undefined, { looseParse: counted }), { ops: [1] })
            assert.equal(calls, 0, '標準 JSON 可解析者不經寬鬆解析')
            assert.equal(pickKeyedJson(t, ['ops'], undefined, { looseParse: () => {
                throw new Error('壞了')
            } }), null)
            assert.equal(pickKeyedJson('{"ops":1}x{bad}', ['ops'], undefined, { looseParse: () => [1] }).ops, 1, '寬鬆解析回非物件(陣列)不成候選')
            for (const opt of [undefined, null, 'x', 5]) assert.deepEqual(pickKeyedJson('{"ops":[]}', ['ops'], undefined, opt), { ops: [] }, `opt=${String(opt)}`)
        })

        it('不去 ANSI 與 code fence(大括號配對不受影響;字串值之內容原樣);輸入非字串以 String 轉;keys 非陣列即無候選', () => {
            assert.deepEqual(pickKeyedJson('```json\n{"ops":[1]}\n```', ['ops']), { ops: [1] })
            assert.deepEqual(pickKeyedJson('{"text":"見 ```json 之例","ops":[]}', ['ops']).text, '見 ```json 之例', '字串值之 fence 字樣原樣')
            assert.deepEqual(pickKeyedJson('\u001b[32m{"ops":[1]}\u001b[0m', ['ops']), { ops: [1] })
            assert.equal(pickKeyedJson(null, ['ops']), null)
            assert.equal(pickKeyedJson(undefined, ['ops']), null)
            assert.deepEqual(pickKeyedJson({ toString: () => '{"ops":[3]}' }, ['ops']), { ops: [3] })
            for (const keys of ['ops', null, undefined, {}]) assert.equal(pickKeyedJson('{"ops":[1]}', keys), null, `keys=${JSON.stringify(keys)}`)
        })

        it('匯出:具名與預設物件同一實體;預設物件含 jsonFragmentsOf、pickJsonReply、pickKeyedJson', () => {
            assert.equal(jsonReply.pickKeyedJson, pickKeyedJson)
            assert.deepEqual(Object.keys(jsonReply).sort(), ['jsonFragmentsOf', 'pickJsonReply', 'pickKeyedJson'])
        })
    })
})
