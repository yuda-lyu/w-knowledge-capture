// unit-prompt-fp.test.mjs — 提示詞指紋之輪次快取(bench/promptFp:createPromptFpCache → promptFpOf)
// 規則(出自跨套件規格《知識套件之產出鏈》§1「提示詞指紋」、§5.5;使用端 Gitea #107～#109):
//   ①指紋算法以評比機制已有者為準:對該角色之評比題組以現行設定(詞彙)組出各頁提示詞,取 benchPromptFpOf;不另發明算法
//   ②每輪每角色只算一次並快取(一個快取實例＝一輪);同一角色不同詞彙為不同指紋、各算一次
//   ③該角色無評比題組可算者回 null(不拋錯);算不出者(題組檔讀不到、提示詞組不出)亦回 null,經 onFail 告知,同輪不重試
//   ④不呼叫 AI(planBench 為純準備:驗題組、組提示詞)
// 執行:自套件根 npx mocha test/unit-prompt-fp.test.mjs(暫存 test/_tmp/prompt-fp-<pid>,測完即刪;不連網、不呼叫 AI)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as Entry from '../src/WKnowledgeCapture.mjs'
import { tmpRoot } from './tools/captureTestKit.mjs'
import { removeRoots, msgOf } from './tools/testKit.mjs'

const { createPromptFpCache, benchPromptFpOf, planBench, defineBenchRole, areaBenchRole } = Entry

const CASES = {
    std: 'TS1',
    v: 1,
    cases: [
        { id: 't1', input: { text: '黑洞光譜' }, expect: { label: 'astro' }, why: '天文題' },
        { id: 't2', input: { text: '恆星演化' }, expect: { label: 'astro' }, why: '天文題' },
        { id: 't3', input: { text: '細胞分裂' }, expect: { label: 'bio' }, why: '生物題' },
    ],
}

describe('unit-prompt-fp', function() {

    this.timeout(60_000)

    let root = ''
    let casesFile = ''
    before(() => {
        root = tmpRoot('prompt-fp')
        casesFile = path.join(root, 'topic-cases.json')
        fs.writeFileSync(casesFile, JSON.stringify(CASES), 'utf8')
    })
    after(() => {
        removeRoots([root])
    })

    /**
     * 建一個會計次之角色(promptOf 每被呼叫一次即計一次;一頁一次呼叫)
     *
     * @param {Object} [over={}] 輸入覆寫之角色欄位
     * @returns {Object} 回傳 { role, calls(promptOf 之累計呼叫數) }
     */
    const countingRole = (over = {}) => {
        const st = { calls: 0 }
        const role = defineBenchRole({
            id: 'fp-topic',
            name: '提示詞指紋測試(topic)',
            pageSize: 2,
            casesFile,
            expectOf: (c) => c.expect.label,
            domainOf: (vocab) => ({ kb: vocab?.kbLabel || '知識庫' }),
            promptOf: (cases, d) => {
                st.calls++
                return `${d.kb}：${cases.map((c, i) => `${i + 1}. ${c.input.text}`).join('；')}`
            },
            verdictOf: (data) => ({ cls: data?.label ?? null, valid: true, problem: '', fields: {} }),
            ...over,
        })
        return { role, st }
    }

    it('與評比機制同一算法:promptFpOf(role) 等於 benchPromptFpOf(planBench(role).pages),亦等於 planBench(role).promptFp(規格 §1)', () => {
        const { role } = countingRole()
        const { promptFpOf } = createPromptFpCache()
        const plan = planBench(role)
        const fp = promptFpOf(role)
        assert.match(fp, /^[0-9a-f]{16}$/)
        assert.equal(fp, benchPromptFpOf(plan.pages))
        assert.equal(fp, plan.promptFp)
        // 內建角色(領域發現)亦同:評比結果之「提示詞指紋」欄即此值
        assert.equal(promptFpOf(areaBenchRole), benchPromptFpOf(planBench(areaBenchRole).pages))
        assert.equal(promptFpOf(areaBenchRole), planBench(areaBenchRole).promptFp)
    })

    it('詞彙(現行設定)進指紋:給 vocab 者以該詞彙組提示詞,與 planBench(role, { vocab }) 同值;詞彙不同則指紋不同(規格 §1:以現行設定組出)', () => {
        const { role } = countingRole()
        const { promptFpOf } = createPromptFpCache()
        const vocab = { kbLabel: '天文學知識庫' }
        assert.equal(promptFpOf(role, { vocab }), planBench(role, { vocab }).promptFp)
        assert.notEqual(promptFpOf(role, { vocab }), promptFpOf(role), '預設詞彙與天文詞彙不同')
        assert.equal(promptFpOf(areaBenchRole, { vocab }), planBench(areaBenchRole, { vocab }).promptFp)
    })

    it('每輪每角色只算一次(規格 §5.5):同一快取實例重複呼叫不再組提示詞;值相同', () => {
        const { role, st } = countingRole()
        const cache = createPromptFpCache()
        const a = cache.promptFpOf(role)
        const afterFirst = st.calls
        assert.equal(afterFirst, 2, '3 案、一頁 2 案 → 2 頁 → promptOf 2 次(planBench 算一次)')
        const b = cache.promptFpOf(role)
        const c = cache.promptFpOf(role, undefined)
        const d = cache.promptFpOf(role, {})
        assert.deepEqual([b, c, d], [a, a, a])
        assert.equal(st.calls, afterFirst, '第二次起命中快取,promptOf 不再被呼叫')
        const { promptFpOf } = cache
        assert.equal(promptFpOf(role), a, '可解構取用(不依賴 this)')
        assert.equal(st.calls, afterFirst)
    })

    it('不同詞彙各算一次;相同詞彙(鍵序不同之同值物件)命中快取', () => {
        const { role, st } = countingRole()
        const cache = createPromptFpCache()
        const x = cache.promptFpOf(role, { vocab: { kbLabel: '甲', domain: 'd' } })
        assert.equal(st.calls, 2)
        const y = cache.promptFpOf(role, { vocab: { domain: 'd', kbLabel: '甲' } })
        assert.equal(y, x)
        assert.equal(st.calls, 2, '鍵序不同之同值詞彙不重算')
        const z = cache.promptFpOf(role, { vocab: { kbLabel: '乙', domain: 'd' } })
        assert.notEqual(z, x)
        assert.equal(st.calls, 4, '另一份詞彙另算一次')
        cache.promptFpOf(role, { vocab: { kbLabel: '乙', domain: 'd' } })
        assert.equal(st.calls, 4)
    })

    it('不同角色各算一次、互不影響', () => {
        const a = countingRole({ id: 'fp-a', name: '角色甲(a)' })
        const b = countingRole({ id: 'fp-b', name: '角色乙(b)', promptOf: (cases) => `乙：${cases.map((c) => c.id).join('+')}` })
        const cache = createPromptFpCache()
        const fa = cache.promptFpOf(a.role)
        const fb = cache.promptFpOf(b.role)
        assert.notEqual(fa, fb)
        cache.promptFpOf(a.role)
        cache.promptFpOf(b.role)
        assert.equal(a.st.calls, 2)
    })

    it('一個快取實例＝一輪:新實例(下一輪)重算——現行設定若已變,指紋跟著變(規格 §5.5:每輪)', () => {
        const { role, st } = countingRole()
        const round1 = createPromptFpCache()
        round1.promptFpOf(role)
        round1.promptFpOf(role)
        assert.equal(st.calls, 2)
        const round2 = createPromptFpCache()
        round2.promptFpOf(role)
        assert.equal(st.calls, 4, '新一輪重算一次')
    })

    it('無評比題組者回 null(不拋錯、不組提示詞):角色無內建題組檔(規格 §1:省略此欄;§5.5:無題組者回 null)', () => {
        const { role, st } = countingRole({ casesFile: undefined })
        assert.equal(role.casesFile, '')
        const fails = []
        const cache = createPromptFpCache({ onFail: (id, e) => fails.push([id, e]) })
        assert.equal(cache.promptFpOf(role), null)
        assert.equal(cache.promptFpOf(role, { vocab: { kbLabel: '甲' } }), null)
        assert.equal(st.calls, 0)
        assert.deepEqual(fails, [], '無題組是常態,不算失敗')
    })

    it('算不出者回 null 並經 onFail 告知一次(id、錯誤);同輪不重試;不影響其他角色', () => {
        const bad = countingRole({ id: 'fp-bad', name: '壞題組檔(bad)', casesFile: path.join(root, 'no-such-cases.json') })
        const ok = countingRole({ id: 'fp-ok', name: '好角色(ok)' })
        const throwing = () => {
            throw new Error('組不出')
        }
        const boom = countingRole({ id: 'fp-boom', name: '提示詞拋錯(boom)', promptOf: throwing })
        const fails = []
        const cache = createPromptFpCache({ onFail: (id, e) => fails.push([id, String(e.message)]) })
        assert.equal(cache.promptFpOf(bad.role), null)
        assert.equal(cache.promptFpOf(bad.role), null)
        assert.equal(fails.length, 1, '同輪同角色只告知一次、不重試')
        assert.equal(fails[0][0], 'fp-bad')
        assert.match(fails[0][1], /題組檔讀取失敗/)
        assert.equal(cache.promptFpOf(boom.role), null)
        assert.equal(fails.length, 2)
        assert.equal(fails[1][0], 'fp-boom')
        assert.match(fails[1][1], /組不出/)
        assert.match(cache.promptFpOf(ok.role), /^[0-9a-f]{16}$/)
    })

    it('onFail 自身拋錯不外洩(指紋是附記,不得拖垮寫入);onFail 非函數視為未給', () => {
        const bad = countingRole({ id: 'fp-bad2', name: '壞題組檔2(bad2)', casesFile: path.join(root, 'no-such-cases2.json') })
        const broken = () => {
            throw new Error('回呼壞了')
        }
        assert.equal(createPromptFpCache({ onFail: broken }).promptFpOf(bad.role), null)
        for (const f of [undefined, null, 'x', 5]) assert.equal(createPromptFpCache({ onFail: f }).promptFpOf(bad.role), null)
        for (const o of [undefined, null, 'x', 5, []]) assert.equal(typeof createPromptFpCache(o).promptFpOf, 'function')
    })

    it('opt 之詞彙或角色參數非物件:視為未給(輸入參數檢測機制 K3),與不給同值', () => {
        const { role } = countingRole()
        const cache = createPromptFpCache()
        const base = cache.promptFpOf(role)
        for (const opt of [null, 'x', 5, [], { vocab: null }, { vocab: 'x' }, { vocab: [] }, { roleOpt: 'x' }, { roleOpt: [] }, { unknown: 1 }]) {
            assert.equal(cache.promptFpOf(role, opt), base, JSON.stringify(opt))
        }
    })

    it('非 JSON 可表達之角色參數(含函數)不快取:每次重算,以免不同參數撞同一鍵而回錯值', () => {
        const { role, st } = countingRole()
        const cache = createPromptFpCache()
        const fn = () => 1
        cache.promptFpOf(role, { roleOpt: { f: fn } })
        const n = st.calls
        cache.promptFpOf(role, { roleOpt: { f: fn } })
        assert.equal(st.calls, n + 2, '第二次重算(2 頁)')
    })

    it('必須參數 role 無效即拋(V19):未給、非物件、不合格之角色定義', () => {
        const { promptFpOf } = createPromptFpCache()
        for (const bad of [undefined, null, 5, 'x', [], {}]) {
            assert.equal(msgOf(() => promptFpOf(bad)), 'invalid role: must be a bench role (defineBenchRole product or definition)', JSON.stringify(bad))
        }
    })

    it('入口匯出:createPromptFpCache 自主入口取得(規格 §5.6)', () => {
        assert.equal(typeof Entry.createPromptFpCache, 'function')
        assert.equal(typeof Entry.default.createPromptFpCache, 'function')
    })
})
