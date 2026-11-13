// unit-capture-launch-wiring.test.mjs — 瀏覽器階梯之啟動點接線:Chromium 系瀏覽器一律經 w-playwright 啟動,且送出之選項含守門(CAPX-13)
//
// 本套件不直接啟動瀏覽器:階梯在子行程 CLI(src/fetchers/fetch_web_cli.mjs)內經 w-fetch-web 啟動。
// 本檔以真子行程(真 CLI、真 runBrowserCli 暫存檔協定)走完整條鏈,只在最底層以 w-playwright 之 setBrowserTypeForTest 替身
// (預載件 test/tools/wpwFakeLaunch.mjs)接住啟動、記下收到之合併後選項、拒絕啟動——不啟動任何瀏覽器、不連網、不碰錯誤密碼計數。
// 真 Chrome 之啟動路徑(替身以外的真路徑)由 unit-flow-capture 之瀏覽器案走(subprocess → w-fetch-web → w-playwright → 系統 Chrome)。
// 執行:自套件根 npx mocha test/unit-capture-launch-wiring.test.mjs(暫存 test/_tmp/launch-wiring-<pid>,測完即刪)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import wpw from 'w-playwright'
import { runBrowserCli } from '../src/fetchers/browserFetcher.mjs'
import { BROWSER_STEPS } from '../src/stores/fetchPolicy.mjs'

const TMP = path.resolve(`test/_tmp/launch-wiring-${process.pid}`)
const PRELOAD = pathToFileURL(fileURLToPath(new URL('./tools/wpwFakeLaunch.mjs', import.meta.url))).href
/** 守門功能(w-playwright 規格:每次啟動之命令列恰一個 --disable-features,含此功能) */
const GUARD = 'AutofillAiWalletPrivatePasses'
/** 會使守門失效而被 w-playwright 拒絕之環境變數:子行程一律清除,使本測試不受執行環境影響 */
const ENV_DROP = ['PWDEBUG', 'SELENIUM_REMOTE_URL', 'SELENIUM_REMOTE_CAPABILITIES', 'npm_config_pwdebug', 'npm_package_config_pwdebug']

/**
 * 以真子行程執行瀏覽器階梯 CLI(經 runBrowserCli 的 runCli 注入點,在 CLI 前加預載件),回傳 CLI 結果與替身收到之啟動選項
 *
 * @param {String} tag 輸入案名(記錄檔名)
 * @param {Array} steps 輸入階名陣列
 * @returns {Promise} 回傳 { r: CLI 結果, calls: 替身收到之選項陣列, stderr: 子行程 stderr }
 */
async function runLadder(tag, steps) {
    const logFile = path.join(TMP, `${tag}.log`)
    let stderr = ''
    const runCli = async ({ script, exe, args, outputPath, timeoutMs }) => {
        const env = { ...process.env, WK_WPW_LOG: logFile }
        for (const k of ENV_DROP) delete env[k]
        const p = spawnSync(exe, ['--import', PRELOAD, script, ...args, outputPath], { env, encoding: 'utf8', windowsHide: true, timeout: timeoutMs })
        stderr = String(p.stderr || '')
        if (!fs.existsSync(outputPath)) return { status: 'error', message: `子行程未寫出結果(exit ${p.status})：${stderr.slice(0, 300)}` }
        return JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    }
    const r = await runBrowserCli('https://wiring.test/a', steps, { capture: {}, tmpDir: TMP, tag, runCli })
    const calls = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    return { r, calls, stderr }
}

/**
 * 斷言一筆啟動選項含守門(w-playwright 規格:恰一個 --disable-features,為 args 最後一個元素,含守門功能與 Playwright 預設)
 *
 * @param {Object} o 輸入替身收到之選項
 * @param {String} msg 輸入說明
 */
function assertGuarded(o, msg) {
    assert.ok(Array.isArray(o.args), `${msg}：args 須為陣列`)
    const dis = o.args.filter((a) => /^--disable-features=/i.test(a))
    // 規則(w-playwright 規格):每次啟動恰一個 --disable-features,置於呼叫端 args 之末(Chromium 對多串只取最後一串)
    assert.equal(dis.length, 1, `${msg}：--disable-features 須恰一串：${JSON.stringify(o.args)}`)
    assert.equal(o.args[o.args.length - 1], dis[0], `${msg}：該串須為 args 最後一個元素`)
    const feats = dis[0].replace(/^--disable-features=/i, '').split(',')
    assert.ok(feats.includes(GUARD), `${msg}：須含守門功能 ${GUARD}：${dis[0]}`)
    assert.ok(feats.length > 1, `${msg}：須併入 Playwright 預設清單(不只守門一項)：${dis[0]}`)
    // 規則:Playwright 預設之那一串由 ignoreDefaultArgs 去掉(精確字串),否則命令列會成兩串
    assert.ok(Array.isArray(o.ignoreDefaultArgs) && o.ignoreDefaultArgs.some((a) => /^--disable-features=/i.test(a)), `${msg}：ignoreDefaultArgs 須含 Playwright 預設之 --disable-features 串`)
}

describe('瀏覽器階梯之啟動點接線(CAPX-13;Chromium 系一律經 w-playwright)', function() {
    this.timeout(180000)

    before(() => {
        fs.rmSync(TMP, { recursive: true, force: true })
        fs.mkdirSync(TMP, { recursive: true })
    })

    after(() => {
        fs.rmSync(TMP, { recursive: true, force: true })
        assert.equal(fs.existsSync(TMP), false, '暫存夾須已刪除')
    })

    it('前提:w-playwright 為精確釘 playwright-core 之自有套件,內附守門功能清單含 ' + GUARD, () => {
        // 規則(w-playwright 規格):守門功能清單由 w-playwright 持有,使用端不自行維護
        const info = wpw.getPlaywrightInfo()
        assert.ok(info.guardFeatures.includes(GUARD), JSON.stringify(info.guardFeatures))
        assert.equal(info.tableMatch, true, '內附預設清單須與實裝之 playwright-core 版本相符(否則 w-playwright 拒絕啟動)')
    })

    it('斷言自檢:assertGuarded 抓得到兩串 --disable-features、缺守門功能、守門串不在最後、未併入 Playwright 預設、未去掉 Playwright 預設串(使「選項含守門」之斷言有鑑別力)', () => {
        const good = { args: ['--lang=en-US', `--disable-features=A,B,${GUARD}`], ignoreDefaultArgs: ['--disable-features=A,B'] }
        assert.doesNotThrow(() => assertGuarded(good, 'good'))
        assert.throws(() => assertGuarded({ ...good, args: ['--disable-features=A,B', ...good.args] }, 'x'), /恰一串/)
        assert.throws(() => assertGuarded({ ...good, args: ['--lang=en-US', '--disable-features=A,B'] }, 'x'), /須含守門功能/)
        assert.throws(() => assertGuarded({ ...good, args: [`--disable-features=A,B,${GUARD}`, '--lang=en-US'] }, 'x'), /最後一個元素/)
        assert.throws(() => assertGuarded({ ...good, args: ['--lang=en-US', `--disable-features=${GUARD}`] }, 'x'), /Playwright 預設清單/)
        assert.throws(() => assertGuarded({ ...good, ignoreDefaultArgs: [] }, 'x'), /ignoreDefaultArgs/)
        assert.throws(() => assertGuarded({ ...good, ignoreDefaultArgs: undefined }, 'x'), /ignoreDefaultArgs/)
    })

    for (const step of ['playwright', 'playwright-redirect']) {
        it(`階 ${step}:子行程 CLI → w-fetch-web → w-playwright 的替身確被呼叫(次數 >0),選項含守門、無頭、系統 Chrome 通道`, async () => {
            // 規則(CAPX-13、w-playwright R-PW-WIRING):階梯內每個會啟動 Chromium 系瀏覽器之階,其啟動送出之選項含守門,且替身確被呼叫(未斷言次數時,
            //   依賴樹有兩份 w-playwright 會使替身只作用於另一份而空過)
            assert.equal(BROWSER_STEPS[step].method, 'playwright', '前提：該階名對應 playwright 方法')
            const { r, calls, stderr } = await runLadder(`step-${step}`, [step])
            assert.ok(calls.length > 0, `替身須被呼叫：${JSON.stringify(r).slice(0, 300)} stderr=${stderr.slice(0, 300)}`)
            // 每階 maxRetries 0(browserLadder):一階一次啟動
            assert.equal(calls.length, 1, `一階一次啟動：${calls.length}`)
            for (const o of calls) {
                assertGuarded(o, `階 ${step}`)
                assert.deepEqual([o.headless, o.channel], [true, 'chrome'], `階 ${step}：無頭、系統 Chrome 通道`)
            }
            // 替身拒絕啟動 → 階梯結果為結構化失敗(不拋、不掛)
            assert.equal(r.status, 'error')
            assert.equal(r.steps.length, 1)
        })
    }

    it('啟動被拒(w-playwright 固定詞彙之錯誤)→ 階梯判環境失敗:playwright 方法本輪斷路(同一階梯內第二個 playwright 階不再啟動),結果為 browser-env 而非頁面失敗', async () => {
        // 規則(CAP-08、fetchPolicy.isEnvFailure):啟動失敗屬本機環境,方法斷路、文件不計 tries;經 w-playwright 後訊息為固定詞彙,須端到端被認得
        const { r, calls } = await runLadder('both', ['playwright', 'playwright-redirect'])
        assert.equal(calls.length, 1, `斷路後第二個 playwright 階不啟動：${calls.length}`)
        assertGuarded(calls[0], '第 1 次啟動')
        assert.deepEqual(r.envBroken, ['playwright'], JSON.stringify(r))
        assert.equal(r.reason, 'browser-env', JSON.stringify(r).slice(0, 300))
        assert.deepEqual(r.steps.map((s) => [s.step, !!s.env, s.skipped || '']), [['playwright', true, ''], ['playwright-redirect', false, 'env-broken']], '第一階標環境失敗,第二階因斷路略過')
    })

    it('對照:階梯無 playwright 階(空階)→ 替身 0 次被呼叫(替身只記 w-playwright 之啟動,不誤記;「確被呼叫」之斷言有鑑別力)', async () => {
        const { r, calls } = await runLadder('none', [])
        assert.equal(calls.length, 0)
        assert.equal(r.status, 'error')
        assert.equal(r.reason, 'browser-env', '無可用階 → browser-env')
    })
})
