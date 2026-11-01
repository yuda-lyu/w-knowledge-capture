// api-area-ai.test.mjs — 領域發現 AI 能力評分之真 AI 測試:以免費模型跑套件內建之通用題組(每案兩回),驗執行器全程無例外、
//   每模型每案每回皆有結果;評分只報告、不作通過門檻(模型能力隨時間變動),報表落 test/_tmp/area-ai-<時間戳>/ 並印出路徑
//
// 【閘門】會呼叫真 AI、耗用免費額度:只在 WK_LIVE_AI=1 時執行,否則整組略過(mocha pending)並印出原因。
// 【受測模型】WK_AREA_MODELS(逗號分隔之條目 id)給了即用之;否則為預設領域發現席位(settings.capture.discover.ai 之 use 與 fallback)。
// 【金鑰】WK_ENV_FILE(.env 格式之金鑰檔)給了即讀之;未給讀 process.env(預設席位為免金鑰之免費模型)。
// 【逐回即存】每回結果一完成即附寫報表目錄之 progress.jsonl:中途被終止也留得下已跑之結果。報表目錄保留(供人閱讀),AI 工作目錄測完即刪。
// 執行(套件根):WK_LIVE_AI=1 node ./node_modules/mocha/bin/mocha.js --timeout 180000 test/api-area-ai.test.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runAreaBench, loadAreaCases, writeAreaBenchReport, AREA_FAIL_KINDS } from '../src/bench/areaBench.mjs'
import { createAiAdapter } from '../src/core/ai/adapter.mjs'
import { resolveSettings } from '../src/core/settingsDefault.mjs'

const LIVE = process.env.WK_LIVE_AI === '1'
const RUNS = 2

describe('api-area-ai：免費 AI 跑通用題組（真 AI；評分只報告、不設門檻）', function() {

    this.timeout(3 * 3600_000)

    // AI 子行程工作目錄(cwd 相對;帶 pid;測完即刪)
    const workspace = path.resolve(`test/_tmp/area-ai-ws-${process.pid}`)

    before(function() {
        if (!LIVE) {
            console.log('    略過：未設 WK_LIVE_AI=1（本測試呼叫真 AI、耗用免費額度）')
            this.skip()
        }
    })

    after(() => {
        if (LIVE) fs.rmSync(workspace, { recursive: true, force: true })
    })

    it(`每案 ${RUNS} 回:執行器全程無例外、每模型每案每回皆有結果(呼叫失敗與停測亦記原因);報表落地並印出路徑`, async () => {
        const settings = resolveSettings({})
        const seat = settings.capture.discover.ai
        const models = process.env.WK_AREA_MODELS
            ? process.env.WK_AREA_MODELS.split(',').map((s) => s.trim()).filter(Boolean)
            : [seat.use, ...(seat.fallback || [])]
        assert.ok(models.length > 0, '受測模型為空')
        const set = loadAreaCases()
        const envFile = process.env.WK_ENV_FILE ? path.resolve(process.env.WK_ENV_FILE) : ''
        if (envFile) assert.ok(fs.existsSync(envFile), `WK_ENV_FILE 指定之金鑰檔不存在：${envFile}`)
        const ai = createAiAdapter({ ai: settings.ai, workspace, ...(envFile ? { envFile } : {}) })

        let outDir = ''
        let progressFile = ''
        const onProgress = (ev) => {
            if (ev.type === 'start') {
                outDir = path.resolve(`test/_tmp/area-ai-${ev.meta.stamp}`)
                fs.mkdirSync(outDir, { recursive: true })
                progressFile = path.join(outDir, 'progress.jsonl')
                console.log(`    受測 ${ev.meta.models.join('、')}；${ev.meta.cases} 案 × ${ev.meta.runs} 回；提示詞指紋 ${ev.meta.promptFp}；逐回進度 ${progressFile}`)
                return
            }
            fs.appendFileSync(progressFile, `${JSON.stringify({ at: new Date().toISOString(), ...ev })}\n`, 'utf8')
            if (ev.type === 'call') {
                const r = ev.record
                const what = r.callFail ? `失敗（${AREA_FAIL_KINDS[r.failKind] || r.failKind}：${String(r.error).slice(0, 80)}）` : (r.cls || `無裁決（${r.problem}）`)
                console.log(`      [${ev.model}] 第 ${r.run} 回 ${ev.caseId}：${what}${r.cls === 'new' || r.cls === 'new-invalid' ? `「${r.label}｜${r.query}」` : ''}（${(r.ms / 1000).toFixed(1)}s）`)
            }
            else if (ev.type === 'model-stopped') console.log(`      [${ev.model}] ${ev.reason}`)
        }

        // 執行器全程無例外:runAreaBench 拋錯即本測試失敗(呼叫失敗、限流、停測皆應記入結果而非拋出)
        const result = await runAreaBench({ models, cases: set, runs: RUNS, aiAdapter: ai, onProgress })

        // 每模型每案每回皆有結果:裁決(類別或無裁決之原因)、呼叫失敗(類別與錯誤)或未呼叫(原因)三者之一;未通過之案皆附原因
        assert.equal(result.models.length, models.length)
        for (const m of result.models) {
            assert.equal(m.cases.length, set.cases.length, `${m.model} 之案數`)
            for (const c of m.cases) {
                assert.equal(c.runs.length, RUNS, `${m.model}／${c.id} 之回數`)
                c.runs.forEach((r, k) => {
                    assert.equal(r.run, k + 1)
                    const has = r.notRun ? !!r.error : r.callFail ? !!(r.failKind && r.error) : (r.cls !== null || !!r.problem)
                    assert.ok(has, `${m.model}／${c.id} 第 ${k + 1} 回無結果：${JSON.stringify(r)}`)
                })
                if (!c.pass) assert.ok(c.note, `${m.model}／${c.id} 未通過而無原因`)
            }
            const { score, general, holdout, contract, calls } = m
            assert.equal(score.total, set.cases.length)
            assert.equal(general.total + holdout.total, score.total)
            assert.equal(calls.sent + calls.notRun, set.cases.length * RUNS)
            console.log(`    ${m.model}：通過 ${score.pass}/${score.total}（一般 ${general.pass}/${general.total}、保留 ${holdout.pass}/${holdout.total}）；合契約 ${contract.valid}/${contract.total}；平均 ${m.avgMs === null ? '-' : (m.avgMs / 1000).toFixed(1)}s；呼叫失敗 ${calls.failed}${calls.notRun ? `、未呼叫 ${calls.notRun}` : ''}${m.stopped ? `；${m.stopped}` : ''}`)
        }

        // 報表落地(評分只報告,不設門檻)
        const rep = writeAreaBenchReport(result, outDir, { name: 'area-bench' })
        for (const f of Object.values(rep.files)) assert.ok(fs.statSync(f).size > 0, f)
        console.log(`    報表：\n      ${[...Object.values(rep.files), progressFile].join('\n      ')}`)
    })
})
