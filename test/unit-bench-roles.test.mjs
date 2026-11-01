// unit-bench-roles.test.mjs — 多角色之評分命令列(bench/benchRoles.mjs 之 defineBenchRoles)之單元測試:以兩個替身角色(一頁多案之分類角色;
//   其一帶專屬參數)與替身調度層(不連外網、不呼叫真 AI)驗定義之檢核、--role 之解析與限制、用法說明、--role all 之準備期(後面角色之錯誤於
//   任何呼叫與寫檔之前拋出)、依序執行與評比表並存、停測之模型帶過與略過其餘角色、--vocab-pick 之子集檔
// 執行(套件根):node ./node_modules/mocha/bin/mocha.js --timeout 180000 test/unit-bench-roles.test.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import isobj from 'wsemi/src/isobj.mjs'
import { defineBenchRole, benchUsageOf, benchArgPint, planBench } from '../src/bench/benchKit.mjs'
import { defineBenchRoles } from '../src/bench/benchRoles.mjs'
import { plainLog, msgOf } from './tools/testKit.mjs'

// 測試暫存(cwd 相對;帶 pid 使並行互不干擾;測完即刪)
const TMP = path.resolve(`test/_tmp/unit-bench-roles-${process.pid}`)

/** 替身 domain:首句稱呼取 vocab.kbLabel;只認此鍵(不認得即拋——同正式詞彙表之規則) */
function createTopicDomain({ vocab } = {}) {
    const v = isobj(vocab) ? vocab : {}
    const bad = Object.keys(v).filter((k) => k !== 'kbLabel')
    if (bad.length) throw new Error(`vocab 含不認得之鍵：${bad.join('、')}`)
    const kb = v.kbLabel || '知識庫'
    return { kb, buildPrompt: (texts) => `你是${kb}的分類員。逐篇判 yes／no：\n${texts.map((t, i) => `${i + 1}. 【${t}】`).join('\n')}` }
}

/**
 * 替身角色(一頁多案之 yes／no 分類;內建題組檔於 TMP 下)
 *
 * @param {String} id 輸入角色 id
 * @param {Object} [over={}] 輸入覆寫之定義鍵
 * @returns {Object} 回傳角色
 */
function topicRole(id, over = {}) {
    return defineBenchRole({
        id,
        name: `題目分類(${id})`,
        pageSize: 2,
        casesFile: path.join(TMP, `${id}-cases.json`),
        caseProblems: (c) => (typeof c.input?.text === 'string' && c.input.text ? [] : ['缺 input.text']),
        expectOf: (c) => c.expect.label,
        domainOf: (vocab) => createTopicDomain({ vocab }),
        promptOf: (cases, domain) => domain.buildPrompt(cases.map((c) => c.input.text)),
        check: (data) => (Array.isArray(data) ? true : '須為 JSON 陣列'),
        verdictOf: (data, c, at) => {
            const it = data.find((x) => x?.index === at.index)
            return it ? { cls: it.label, valid: true, problem: '', fields: { label: it.label } } : { cls: null, valid: false, problem: '無此項', fields: { label: '' } }
        },
        blankFields: { label: '' },
        models: ['m', 'n'],
        ...over,
    })
}

const CASES = { cases: [{ id: 'a1', input: { text: '行星' }, expect: { label: 'yes' }, why: '天文' }, { id: 'a2', input: { text: '麵包' }, expect: { label: 'no' }, why: '烹飪' }, { id: 'a3', input: { text: '彗星' }, expect: { label: 'yes' }, why: '天文' }] }
const TRUTH = { 行星: 'yes', 麵包: 'no', 彗星: 'yes' }

/** 兩個角色:alpha(無專屬參數)、beta(專屬參數 --page-size,自訂分頁) */
const ALPHA = topicRole('alpha')
const BETA = topicRole('beta', {
    pageSize: undefined,
    paginate: (cases, ctx) => {
        const n = ctx.roleOpt.pageSize || 2
        const pages = []
        for (let i = 0; i < cases.length; i += n) pages.push(cases.slice(i, i + n))
        return pages
    },
    cli: { options: [{ flag: '--page-size', key: 'pageSize', arg: '<n>', help: '一頁幾案', parse: benchArgPint }] },
})
const pickVocab = (v) => Object.fromEntries(Object.entries(isobj(v) ? v : {}).filter(([k]) => k === 'kbLabel'))
const CLI = defineBenchRoles({ roles: [ALPHA, BETA], pickVocab, pickName: 'pickTopicVocab', vocabPrefix: 'topic' })

/**
 * 替身調度層:依提示詞之各篇作答;fail[模型] 給了即每次呼叫以該錯誤失敗(limit 字樣即限流);記錄每次呼叫
 *
 * @param {Object} [o={}] 輸入 { fail:{ 模型: 錯誤訊息 } }
 * @returns {Object} 回傳 { calls, callJson }
 */
function stub(o = {}) {
    const calls = []
    return {
        calls,
        callJson: async (prompt, check, callOpt) => {
            const model = callOpt?.spec?.use
            const texts = [...String(prompt).matchAll(/^\d+\. 【(.+?)】/gm)].map((m) => m[1])
            calls.push({ model, texts, prompt: String(prompt) })
            if (o.fail?.[model]) return { ok: false, data: null, error: o.fail[model], providerId: '', attempts: 1, skipped: false, errors: [] }
            const data = texts.map((t, i) => ({ index: i + 1, label: TRUTH[t] }))
            return check(data) === true ? { ok: true, data, error: '', providerId: `${model}#p`, attempts: 1, skipped: false, errors: [] } : { ok: false, data: null, error: 'OUTPUT_VALIDATION_FAILED', providerId: '', attempts: 1, skipped: false, errors: [] }
        },
    }
}

describe('unit-bench-roles', function() {

    before(() => {
        fs.mkdirSync(TMP, { recursive: true })
        for (const id of ['alpha', 'beta']) fs.writeFileSync(path.join(TMP, `${id}-cases.json`), JSON.stringify(CASES), 'utf8')
    })

    after(() => {
        fs.rmSync(TMP, { recursive: true, force: true })
    })

    it('定義之檢核:roles 非陣列或為空、pickVocab 非函數、pickName 空、vocabPrefix 形式不合 → 拋錯並列出全部問題;角色 id 重複 → 拋;合格者凍結、角色經 defineBenchRole', () => {
        const m = msgOf(() => defineBenchRoles({ roles: [], pickVocab: 1, pickName: '', vocabPrefix: 'Bad' }))
        for (const k of ['roles 須為非空之角色陣列', 'pickVocab 須為函數', 'pickName 須為非空字串', 'vocabPrefix 須為小寫英文字母開頭']) assert.ok(m.includes(k), k)
        assert.match(msgOf(() => defineBenchRoles(null)), /需要定義物件/)
        assert.match(msgOf(() => defineBenchRoles({ roles: [ALPHA, ALPHA], pickVocab, pickName: 'p', vocabPrefix: 'topic' })), /角色 id 重複：alpha/)
        assert.ok(Object.isFrozen(CLI) && Object.isFrozen(CLI.roles))
        assert.deepEqual(CLI.ids, ['alpha', 'beta'])
        assert.equal(CLI.roleOf('beta'), BETA)
        assert.match(msgOf(() => CLI.roleOf('x')), /不認得之評分角色：x（可用：alpha、beta、all）/)
        assert.deepEqual(Object.keys(CLI), ['roles', 'ids', 'roleOf', 'run', 'plan', 'parseArgs', 'usage', 'runCli'])
    })

    it('單角色之執行與準備(run／plan):以 id 取角色交核心之 runBench／planBench(各套件之單角色執行器只委派);不認得之 id 即拋;核心之前驗照拋', async () => {
        // 規則:benchRoles 之 run／plan——規則只在核心一份
        assert.deepEqual(CLI.plan('beta', { cases: CASES }).pages.map((p) => p.ids), planBench(BETA, { cases: CASES }).pages.map((p) => p.ids))
        assert.match(msgOf(() => CLI.plan('x')), /不認得之評分角色：x/)
        await assert.rejects(CLI.run('alpha', { cases: CASES }), /需要 models/)
        await assert.rejects(CLI.run('x', {}), /不認得之評分角色：x/)
    })

    it('--role 解析:預設 all(依序全部角色);--role x／--role=x;缺值、重複、不認得 → 拋;all 配 --cases 或角色專屬參數 → 拋(單一角色可);--vocab-pick 帶值、重複、未配 --vocab → 拋;--help 不驗', () => {
        const all = CLI.parseArgs(['--runs', '1'])
        assert.equal(all.role, 'all')
        assert.deepEqual(all.roles.map((r) => r.id), ['alpha', 'beta'])
        assert.deepEqual(all.rest, ['--runs', '1'])
        assert.deepEqual(CLI.parseArgs(['--role', 'beta', '--page-size', '1']).roles.map((r) => r.id), ['beta'])
        assert.deepEqual(CLI.parseArgs(['--role=alpha']).roles.map((r) => r.id), ['alpha'])
        assert.match(msgOf(() => CLI.parseArgs(['--role'])), /--role 缺值/)
        assert.match(msgOf(() => CLI.parseArgs(['--role', '--runs'])), /--role 缺值/)
        assert.match(msgOf(() => CLI.parseArgs(['--role', 'alpha', '--role=beta'])), /--role 重複給定/)
        assert.match(msgOf(() => CLI.parseArgs(['--role', 'gamma'])), /不認得之評分角色：gamma/)
        assert.match(msgOf(() => CLI.parseArgs(['--cases', 'x.json'])), /--role all 不可給 --cases/)
        assert.match(msgOf(() => CLI.parseArgs(['--page-size=1'])), /--role all 不可給角色專屬參數 --page-size/)
        assert.match(msgOf(() => CLI.parseArgs(['--vocab-pick=1', '--vocab', 'v.json'])), /--vocab-pick 不帶值/)
        assert.match(msgOf(() => CLI.parseArgs(['--vocab-pick', '--vocab-pick', '--vocab', 'v.json'])), /--vocab-pick 重複給定/)
        assert.match(msgOf(() => CLI.parseArgs(['--vocab-pick'])), /--vocab-pick 須配 --vocab/)
        const p = CLI.parseArgs(['--vocab-pick', '--vocab=v.json'])
        assert.equal(p.pick, true)
        assert.deepEqual(p.rest, ['--vocab=v.json'], '--vocab-pick 不留在其餘參數')
        const h = CLI.parseArgs(['--role', 'nope', '--help'])
        assert.equal(h.help, true)
        assert.deepEqual(h.roles, [])
    })

    it('用法說明:列出 --role 之可用值與 all 之限制、--vocab-pick 之取鍵函數與子集檔名、各角色之核心用法(含專屬參數)', () => {
        assert.match(CLI.usage, /--role <alpha\|beta\|all>/)
        assert.match(CLI.usage, /all 時不可給 --cases 與角色專屬參數\(--page-size\)/)
        assert.match(CLI.usage, /以 pickTopicVocab 取本套件之鍵/)
        assert.match(CLI.usage, /topic-vocab-<時間戳>\.json/)
        for (const r of [ALPHA, BETA]) assert.ok(CLI.usage.includes(`【${r.name}】\n${benchUsageOf(r)}`), r.id)
    })

    it('--role all:依序執行各角色,逐角色報表;評比表兩角色之列並存;--help 只印用法', async () => {
        const out = path.join(TMP, 'all')
        const ai = stub()
        const log = plainLog()
        const r = await CLI.runCli(['--models', 'm', '--runs', '1', '--out', out, '--board', path.join(out, 'board.csv')], { aiAdapter: ai, log })
        assert.equal(r.role, 'all')
        assert.deepEqual(r.runs.map((x) => x.role), ['alpha', 'beta'])
        assert.deepEqual(r.stopped, [])
        assert.deepEqual(r.skipped, [])
        for (const x of r.runs) assert.equal(x.result.models[0].score.pass, 3, x.role)
        const board = fs.readFileSync(path.join(out, 'board.csv'), 'utf8')
        for (const name of [ALPHA.name, BETA.name]) assert.ok(board.includes(name), name)
        assert.ok(log.lines.some((l) => l.startsWith('── 角色 1/2：題目分類(alpha)')))
        const h = plainLog()
        assert.deepEqual(await CLI.runCli(['--help'], { aiAdapter: ai, log: h }), { help: true })
        assert.equal(h.lines[0], CLI.usage)
    })

    it('準備期:後面角色之錯誤(其專屬題組不合、詞彙不合)於任何呼叫與寫檔之前拋出', async () => {
        const out = path.join(TMP, 'pre')
        const ai = stub()
        fs.writeFileSync(path.join(TMP, 'beta-cases.json'), JSON.stringify({ cases: [{ id: 'z', input: {}, expect: { label: 'yes' }, why: 'w' }] }), 'utf8')
        try {
            await assert.rejects(() => CLI.runCli(['--models', 'm', '--out', out], { aiAdapter: ai, log: plainLog() }), /缺 input\.text/)
        }
        finally {
            fs.writeFileSync(path.join(TMP, 'beta-cases.json'), JSON.stringify(CASES), 'utf8')
        }
        const bad = path.join(TMP, 'bad-vocab.json')
        fs.writeFileSync(bad, JSON.stringify({ kbLabel: '甲', other: 1 }), 'utf8')
        await assert.rejects(() => CLI.runCli(['--models', 'm', '--out', out, '--vocab', bad], { aiAdapter: ai, log: plainLog() }), /vocab 含不認得之鍵：other/)
        await assert.rejects(() => CLI.runCli(['--models', 'm', '--out', out, '--vocab', path.join(TMP, 'none.json')], { aiAdapter: ai, log: plainLog() }), /--vocab 指定之詞彙檔不存在/)
        assert.equal(ai.calls.length, 0, '未呼叫任何 AI')
        assert.equal(fs.existsSync(out), false, '未建輸出目錄')
    })

    it('停測帶過:前面角色已停測之模型不再於後續角色受測(--models 兩種寫法皆換);受測模型皆已停測即略過其餘角色', async () => {
        const out = path.join(TMP, 'stop')
        const ai = stub({ fail: { n: 'FreeUsageLimitError: Rate limit exceeded' } })
        const log = plainLog()
        const r = await CLI.runCli(['--models=m,n', '--runs', '1', '--out', out], { aiAdapter: ai, log })
        assert.deepEqual(r.stopped, ['n'])
        assert.deepEqual(r.runs.map((x) => x.result.models.map((m) => m.model)), [['m', 'n'], ['m']])
        assert.ok(log.lines.some((l) => l.includes('（已停測不再受測：n）')))
        const ai2 = stub({ fail: { m: 'FreeUsageLimitError: Rate limit exceeded' } })
        const log2 = plainLog()
        const r2 = await CLI.runCli(['--models', 'm', '--runs', '1', '--out', out], { aiAdapter: ai2, log: log2 })
        assert.deepEqual(r2.runs.map((x) => x.role), ['alpha'])
        assert.deepEqual(r2.skipped, ['beta'])
        assert.ok(log2.lines.some((l) => l === '── 其餘角色（beta）略過：受測模型皆已停測（m）──'))
    })

    it('--vocab-pick:多段共用之詞彙表 → 以 pickVocab 取本套件之鍵、子集檔寫入 --out 並以之評分(提示詞帶詞彙);未給 --vocab-pick 者他段之鍵於準備期拋錯', async () => {
        const out = path.join(TMP, 'pick')
        const shared = path.join(TMP, 'shared-vocab.json')
        fs.writeFileSync(shared, JSON.stringify({ kbLabel: '天文知識庫', categories: ['甲'] }), 'utf8')
        const ai = stub()
        const log = plainLog()
        const r = await CLI.runCli(['--role', 'alpha', '--models', 'm', '--runs', '1', '--out', out, '--vocab', shared, '--vocab-pick'], { aiAdapter: ai, log })
        assert.equal(r.runs.length, 1)
        const files = fs.readdirSync(out).filter((f) => /^topic-vocab-.+\.json$/.test(f))
        assert.equal(files.length, 1)
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, files[0]), 'utf8')), { kbLabel: '天文知識庫' })
        assert.ok(ai.calls.every((c) => c.prompt.startsWith('你是天文知識庫的分類員')))
        assert.ok(log.lines.some((l) => l.startsWith(`--vocab-pick：自 ${shared} 取本套件之鍵（kbLabel）→ `)))
        const ai2 = stub()
        await assert.rejects(() => CLI.runCli(['--role', 'alpha', '--models', 'm', '--out', path.join(TMP, 'pick2'), '--vocab', shared], { aiAdapter: ai2, log: plainLog() }), /vocab 含不認得之鍵：categories/)
        assert.equal(ai2.calls.length, 0)
        assert.equal(fs.existsSync(path.join(TMP, 'pick2')), false)
    })
})
