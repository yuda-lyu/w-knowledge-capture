// unit-capture-reserve-guard.test.mjs — 守護:子階段(src/stages/)不得直接以整輪預算(budgetOf／ctx.remainingMs／ctx.expired)判斷開工與封頂
// 【為何要有】整輪預算只管逾期;組裝者可保留一段時間給後段(opt.reserveMs 或每輪依賴 deps.reserveMs)。子階段若直接問整輪預算,
//   會一路做到逾期而吃掉保留——此缺口曾在抓取、補全文、擴充、文件維護等段同時存在而無人察覺。故子階段之時間判斷一律經
//   core/util/stageReserve 之 stageReserveGateOf(保留為 0 時與直接用整輪預算逐項相同),本測試守住「日後新段不再漏掉」。
// 規則(規則帳本 CAP-17):
//   ①src/ 全部原始碼(去註解)不得出現 budgetOf、budget.<方法>、ctx.remainingMs／ctx.expired(刻意例外列於 WHITELIST,逐項寫明理由;白名單不得過期);
//     範圍取整個 src/(不只 stages/):其他目錄新增之時間判斷同樣不得繞過守門閘
//   ②凡 stages/ 之檔出現 shouldStop／remainingMs／expired 之時間判斷,必同檔引用 stageReserveGateOf(不得以另一條路繞過)
//   ③五個耗時段(listFetch、detailFetch、expand、docMaintain、areas)皆須引用 stageReserveGateOf 與 stageReserveFnOf(刪掉守門即紅)
//   ④掃描器自檢:已知正例(含 budgetOf／ctx.remainingMs 之片段)必抓得到,註解與字串內之字樣不誤抓
// 執行:自套件根 npx mocha test/unit-capture-reserve-guard.test.mjs(只讀原始碼,不落檔)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lexSource, sourceFilesOf } from './tools/sourceScan.mjs'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(PKG, 'src')

/** 直接取用整輪預算之寫法(以骨架〔去註解、字串換佔位〕比對) */
const DIRECT_BUDGET = [
    { name: 'budgetOf', re: /\bbudgetOf\b/ },
    { name: 'budget.<方法>', re: /\bbudget\.(remainingMs|shouldStop|expired|capMs|capSeat)\b/ },
    { name: 'ctx.remainingMs／ctx.expired', re: /\bctx\??\.(remainingMs|expired)\b/ },
]
/** 時間判斷之徵象(出現即須引用守門閘) */
const TIME_USE = /\b(shouldStop|remainingMs|expired)\b/

/**
 * 刻意例外白名單:{ '<相對 src/ 之檔>': [{ pattern:direct 規則名, why:理由 }] }。新增例外須寫明「為何不扣保留」,
 *   且該檔必須真的仍含該寫法(過期者此測試失敗)。子階段(src/stages/)無例外:五個耗時段皆經守門閘,其餘子階段(hygiene、seedSync)不做時間判斷
 */
const WHITELIST = Object.freeze({
    'core/util/stageReserve.mjs': [{ pattern: 'budgetOf', why: '守門閘之底層:保留為 0 時閘即整輪預算(budgetOf),各子階段一律經此閘取時間,不直接問整輪預算' }],
    'core/runnerPackage.mjs': [{ pattern: 'budgetOf', why: '執行秩序件之單一匯入點:只轉出 w-data-pipeline 之名(下游套件經本套件取用),不判斷開工或封頂' }],
})

/** 一支原始碼命中之直接取用規則名 */
const directHitsOf = (code) => {
    const sk = lexSource(code).skeleton
    return DIRECT_BUDGET.filter((d) => d.re.test(sk)).map((d) => d.name)
}
const srcFiles = () => sourceFilesOf(SRC, { exclude: [] })
const stageFiles = () => srcFiles().filter((f) => f.startsWith('stages/'))
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')
const allowed = (rel, name) => (WHITELIST[rel] || []).some((w) => w.pattern === name)

describe('unit-capture-reserve-guard', function() {

    it('①src/ 不得直接以整輪預算判斷開工與封頂(白名單除外;子階段無例外)', () => {
        const files = srcFiles()
        assert.ok(files.length >= 60 && stageFiles().length >= 8, `掃描檔數須含全部原始碼與全部子階段(實得 ${files.length}／${stageFiles().length}):掃描範圍壞掉時結果不算數`)
        const bad = []
        for (const f of files) for (const name of directHitsOf(read(f))) if (!allowed(f, name)) bad.push(`src/${f}: ${name}`)
        assert.deepEqual(bad, [], `時間判斷須經 stageReserveGateOf 取(core/util/stageReserve),不得直接問整輪預算:\n${bad.join('\n')}`)
        assert.deepEqual(Object.keys(WHITELIST).filter((k) => k.startsWith('stages/')), [], '子階段不得列入白名單')
    })

    it('白名單不得過期:每一例外之檔存在、確實仍含該寫法、理由非空', () => {
        for (const [rel, list] of Object.entries(WHITELIST)) {
            const f = rel
            assert.ok(fs.existsSync(path.join(SRC, f)), `白名單之檔不存在:${rel}`)
            const hits = directHitsOf(read(f))
            for (const w of list) {
                assert.ok(typeof w.why === 'string' && w.why.trim().length >= 10, `${rel}:${w.pattern} 須寫明理由`)
                assert.ok(hits.includes(w.pattern), `${rel} 已不含 ${w.pattern},請自白名單移除`)
            }
        }
    })

    it('②出現時間判斷之子階段檔,必同檔引用 stageReserveGateOf', () => {
        const bad = []
        for (const f of stageFiles()) {
            const sk = lexSource(read(f)).skeleton
            if (TIME_USE.test(sk) && !/\bstageReserveGateOf\b/.test(sk)) bad.push(`src/${f}`)
        }
        assert.deepEqual(bad, [], `以下子階段有時間判斷而未經守門閘:\n${bad.join('\n')}`)
    })

    it('③五個耗時段皆引用 stageReserveGateOf 與 stageReserveFnOf(取值與守門兩者缺一不可)', () => {
        for (const f of ['listFetchStage', 'detailFetchStage', 'expandStage', 'docMaintainStage', 'areaStage']) {
            const sk = lexSource(read(`stages/${f}.mjs`)).skeleton
            assert.ok(/\bstageReserveGateOf\b/.test(sk), `${f} 未引用 stageReserveGateOf`)
            assert.ok(/\bstageReserveFnOf\b/.test(sk), `${f} 未引用 stageReserveFnOf`)
        }
    })

    it('④掃描器自檢:已知正例抓得到;註解與字串內之字樣不誤抓', () => {
        assert.deepEqual(directHitsOf('import { budgetOf } from \'../core/runnerPackage.mjs\'\nconst b = budgetOf(ctx)'), ['budgetOf'])
        assert.deepEqual(directHitsOf('const r = budget.remainingMs() < 5'), ['budget.<方法>'])
        assert.deepEqual(directHitsOf('if (ctx.remainingMs() < 5) return'), ['ctx.remainingMs／ctx.expired'])
        assert.deepEqual(directHitsOf('if (ctx?.expired()) return'), ['ctx.remainingMs／ctx.expired'])
        assert.deepEqual(directHitsOf('// 各段經 budgetOf(ctx) 消費\nconst s = \'budgetOf(ctx)\'\n/* ctx.remainingMs */ const ok = gate.shouldStop(1)'), [])
        // 新增一支「直接問整輪預算」之假子階段 → 第①條之判準會抓
        assert.ok(directHitsOf('export const stageNew = () => ({ run: async (ctx) => { if (ctx.expired()) return } })').length > 0)
        // 有時間判斷而未引用守門閘 → 第②條之判準會抓
        const sk = lexSource('const stop = () => gate.shouldStop(1)').skeleton
        assert.ok(TIME_USE.test(sk) && !/\bstageReserveGateOf\b/.test(sk))
    })
})
