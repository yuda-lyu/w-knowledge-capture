// browserHygiene.mjs — 孤兒瀏覽器行程回收(Windows):父行程已死之瀏覽器／Camofox／瀏覽器 CLI 子行程,樹狀殺除並回驗
//
// 【為何需要】Windows 上 Playwright 以 non-detached 啟動瀏覽器且不用 Job Object,清理只掛在 node 之 exit 處理;
//   node 被 TerminateProcess(排程 ExecutionTimeLimit／StopExisting、taskkill /F、崩潰)時瀏覽器整棵孤兒化並逐輪疊加。
//   Camofox 亦然:Camofox server 被 taskkill /T 樹狀殺時,內容行程若其父(主瀏覽器行程)已先退出即不在樹內而逃脫,
//   故連經子行程 CLI 正常結束之 Camofox 抓取,亦可能留下 camoufox.exe 內容行程孤兒。
// 【判準:歸屬＋父死,絕不用年齡】常駐瀏覽器可合法存活很久,年齡判準會誤殺健康者。歸屬以命令列辨識——
//   ①本套件之瀏覽器 CLI(fetch_web_cli.mjs)②Camofox server(@askjo/camofox-browser 之 server.js;路徑為原生反斜線,比對不分 / \)
//   ③camoufox.exe(Camofox 之 Firefox,含內容行程;其 ExecutablePath 於受限權杖下 CIM 讀不到,實測為空,故用命令列)
//   ④Playwright 啟動之 Chrome(w-fetch-web 經 w-playwright 用 channel:'chrome'＝系統 Chrome,與使用者自己的 Chrome 同一執行檔——
//   只認命令列含 playwright_chromiumdev_profile- 者,使用者之 Chrome 不帶此標記;w-playwright 呼叫的仍是 Playwright 的 chromium.launch,暫存 profile 前綴不變)。
// 【父死之判定含 PID 重用】Windows 會回收 PID:父 PID 若已被晚於子行程建立之新行程占用,亦視為父死。
// 【只殺根】孤兒之子孫(其父仍在)由 taskkill /T 一併收掉,不重複殺;殺後重列行程回驗(kill 不保證成功)。
// 【孤兒 Chrome 之暫存 profile】Playwright 以 mkdtemp(<os.tmpdir()>/playwright_chromiumdev_profile-XXXX)建 profile、正常關閉時刪除;
//   被硬殺者留下整個資料夾。只刪「已回驗殺除之孤兒」命令列 --user-data-dir 所指、且為暫存目錄之直屬子目錄並帶該前綴者
//   (歸屬即該孤兒;不以名稱或年齡掃整個暫存目錄——Camofox 之 tmp-cleanup 以名稱＋年齡刪除,無使用中檢查)。
// 【會掃整台機器】套件預設關閉(settings.capture.browser.hygiene),由安裝端開啟;測試一律注入行程清單與殺除函數。

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import isobj from 'wsemi/src/isobj.mjs'
import isarr from 'wsemi/src/isarr.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import execProcessKillPid from 'wsemi/src/execProcessKillPid.mjs'

/** Playwright 暫存 profile 目錄名前綴 */
export const PLAYWRIGHT_PROFILE_PREFIX = 'playwright_chromiumdev_profile-'

/**
 * 由 Chrome 命令列取 Playwright 暫存 profile 目錄(--user-data-dir;可帶引號);非 Playwright 暫存 profile 回 ''
 *
 * @param {String} cmd 輸入命令列
 * @returns {String} 回傳目錄路徑或空字串
 * @example
 * console.log(profileDirOf('chrome.exe --user-data-dir=/tmp/playwright_chromiumdev_profile-AbC --remote-debugging-pipe'))
 * // => /tmp/playwright_chromiumdev_profile-AbC
 */
export function profileDirOf(cmd) {
    const m = String(cmd || '').match(/--user-data-dir=(?:"([^"]+)"|(\S+))/)
    const dir = m ? (m[1] || m[2]) : ''
    return dir && path.basename(dir).startsWith(PLAYWRIGHT_PROFILE_PREFIX) ? dir : ''
}

/** 回收目標(映像名＋命令列特徵) */
export const HYGIENE_TARGETS_DEFAULT = [
    { name: 'fetch-cli', image: /^node(\.exe)?$/i, cmd: /[\\/]fetch_web_cli\.mjs\b/i },
    { name: 'camofox-server', image: /^node(\.exe)?$/i, cmd: /[\\/]@askjo[\\/]camofox-browser[\\/]server\.js\b/i },
    { name: 'camoufox', image: /^camoufox(\.exe)?$/i, cmd: /[\\/]camoufox[\\/]/i },
    { name: 'playwright-chrome', image: /^chrome(\.exe)?$/i, cmd: /playwright_chromiumdev_profile-/i },
]

/**
 * Windows 行程清單(PowerShell Get-CimInstance;輸出 UTF-8 JSON)。**全部行程皆列**(父行程存活與否要對全機判:
 * 目標之父可能是 python.exe、cmd.exe 等非目標映像——只列目標映像會把它們誤判為父死);命令列只取目標映像者(其餘留空,縮小輸出)
 *
 * @returns {Promise} 回傳 Promise，resolve 回傳 [{ name, pid, ppid, createdMs, cmd }]；非 Windows 回 []
 * @example
 * // 會實際啟動 PowerShell 列舉本機行程(僅列出、不殺除)，結果隨機器而異，故不給固定輸出
 * let procs = await listProcessesWin()
 * // 回傳 [{ name, pid, ppid, createdMs, cmd }]，其中 cmd 僅目標映像(node／chrome／camoufox)有值
 */
export function listProcessesWin() {
    if (process.platform !== 'win32') return Promise.resolve([])
    const ps = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
        "Get-CimInstance Win32_Process | Select-Object Name,ProcessId,ParentProcessId,@{n='Created';e={ if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' } }}," +
        "@{n='CommandLine';e={ if ($_.Name -match '^(node|chrome|camoufox)\\.exe$') { $_.CommandLine } else { '' } }} | " +
        'ConvertTo-Json -Compress -Depth 2'
    return new Promise((resolve, reject) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
            if (err) return reject(err)
            let j = []
            try {
                j = JSON.parse(String(stdout || '').trim() || '[]')
            }
            catch (e) {
                return reject(new Error(`行程清單非 JSON：${e.message}`))
            }
            const rows = isarr(j) ? j : [j]
            resolve(rows.filter(Boolean).map((r) => ({ name: String(r.Name || ''), pid: Number(r.ProcessId), ppid: Number(r.ParentProcessId), createdMs: Date.parse(r.Created || '') || 0, cmd: String(r.CommandLine || '') })))
        })
    })
}

/**
 * 找孤兒根:符合目標、且父行程不存在或父之建立時間晚於子(PID 重用);其父亦為目標孤兒者不列(由根之樹狀殺一併收掉)
 *
 * @param {Array} procs 輸入行程陣列 [{ name, pid, ppid, createdMs, cmd }]；全機行程(至少含各目標之父)
 * @param {Array} [targets=HYGIENE_TARGETS_DEFAULT] 輸入目標定義陣列 [{ name, image:RegExp, cmd:RegExp }]
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Array} [opt.alivePids] 輸入另行確認仍存活之 PID 陣列(父不在 procs 清單中但仍存活者,如非 node／chrome／camoufox 之父)
 * @returns {Array} 回傳孤兒根陣列 [{ pid, ppid, target, name, createdMs, cmd }]
 * @example
 * const procs = [{ name: 'chrome.exe', pid: 2, ppid: 1, createdMs: 10, cmd: '--user-data-dir=/tmp/playwright_chromiumdev_profile-x' }]
 * console.log(findOrphans(procs).map((o) => o.target))
 * // => [ 'playwright-chrome' ]
 */
export function findOrphans(procs, targets = HYGIENE_TARGETS_DEFAULT, opt = {}) {
    if (!isarr(procs)) procs = []
    if (!isarr(targets)) targets = HYGIENE_TARGETS_DEFAULT
    if (!isobj(opt)) opt = {}
    const byPid = new Map(procs.map((p) => [p.pid, p]))
    const alive = new Set(isarr(opt.alivePids) ? opt.alivePids : [])
    const targetOf = (p) => targets.find((t) => t.image.test(p.name) && t.cmd.test(p.cmd))
    const parentDead = (p) => {
        if (alive.has(p.ppid)) return false
        const par = byPid.get(p.ppid)
        if (!par) return true
        // PID 重用:父 PID 已被晚於子建立之行程占用
        return Number.isFinite(par.createdMs) && Number.isFinite(p.createdMs) && par.createdMs > 0 && p.createdMs > 0 && par.createdMs > p.createdMs
    }
    const orphans = []
    for (const p of procs) {
        const t = targetOf(p)
        if (!t || !parentDead(p)) continue
        // profile 目錄由完整命令列取(--user-data-dir 常在 200 字之後)
        const profileDir = t.name === 'playwright-chrome' ? profileDirOf(p.cmd) : ''
        orphans.push({ pid: p.pid, ppid: p.ppid, target: t.name, name: p.name, createdMs: p.createdMs, cmd: p.cmd.slice(0, 200), ...(profileDir ? { profileDir } : {}) })
    }
    const orphanPids = new Set(orphans.map((o) => o.pid))
    // 只殺根:父亦為孤兒根者略過(其父之樹狀殺會帶走它)——父既為孤兒則父仍在清單內,故上面不會判它父死;此處防衛同一輪內之重複
    return orphans.filter((o) => !orphanPids.has(o.ppid))
}

/**
 * 回收孤兒瀏覽器行程:列行程 → 找孤兒根 → 樹狀殺 → 重列回驗
 *
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Function} [opt.listProcesses=listProcessesWin] 輸入行程清單函數 async () => [{ name, pid, ppid, createdMs, cmd }]
 * @param {Function} [opt.killTree=execProcessKillPid] 輸入樹狀殺除函數 async (pid) => void
 * @param {Array} [opt.targets=HYGIENE_TARGETS_DEFAULT] 輸入目標定義
 * @param {Boolean} [opt.dryRun=false] 輸入只列不殺
 * @param {Function} [opt.filter] 輸入孤兒過濾函數 (orphan) => Boolean(如實網測試只回收本次測試期間誕生者:o.createdMs ≥ 開始時刻)
 * @param {String} [opt.tmpDir=os.tmpdir()] 輸入暫存目錄(孤兒 Chrome 之 profile 須為其直屬子目錄才刪;測試注入)
 * @param {Function} [opt.removeDir] 輸入刪目錄函數 (dir) => void(預設 fs.rmSync 遞迴;測試注入)
 * @returns {Promise} 回傳 Promise，resolve 回傳 { scanned, orphans:Array, killed:Array, failed:Array, profiles:{ removed:Array, failed:Array }, skipped?:String }
 * @example
 * // 以替身注入行程清單與殺除函數，不列舉真實行程、不殺任何行程
 * let procs = [{ name: 'chrome.exe', pid: 2, ppid: 1, createdMs: 10, cmd: 'chrome.exe playwright_chromiumdev_profile-x' }]
 * let r = await sweepOrphanBrowsers({
 *     listProcesses: async () => procs,
 *     killTree: async (pid) => { procs = procs.filter((p) => p.pid !== pid) },
 * })
 * console.log(r.scanned, r.orphans.map((o) => o.pid), r.killed.map((o) => o.pid), r.failed.length)
 * // => 1 [ 2 ] [ 2 ] 0
 */
export async function sweepOrphanBrowsers(opt = {}) {
    if (!isobj(opt)) opt = {}
    const list = isfun(opt.listProcesses) ? opt.listProcesses : listProcessesWin
    const kill = isfun(opt.killTree) ? opt.killTree : execProcessKillPid
    const targets = isarr(opt.targets) ? opt.targets : HYGIENE_TARGETS_DEFAULT
    const profiles = { removed: [], failed: [] }
    if (!isfun(opt.listProcesses) && process.platform !== 'win32') return { scanned: 0, orphans: [], killed: [], failed: [], profiles, skipped: '非 Windows：不動作' }
    const procs = await list()
    const orphans = findOrphans(procs, targets).filter((o) => !isfun(opt.filter) || opt.filter(o))
    if (opt.dryRun || !orphans.length) return { scanned: procs.length, orphans, killed: [], failed: [], profiles }
    const errors = new Map()
    for (const o of orphans) {
        try {
            await kill(o.pid)
        }
        catch (e) {
            errors.set(o.pid, String(e?.message || e).slice(0, 120))
        }
    }
    // 回驗:殺後重列,仍在者為失敗(taskkill 可能因權限或行程正在終止而無效)
    const after = new Set((await list()).map((p) => p.pid))
    const killed = []
    const failed = []
    for (const o of orphans) {
        if (after.has(o.pid)) failed.push({ ...o, error: errors.get(o.pid) || '殺除後仍存在' })
        else killed.push(o)
    }
    // 已回驗殺除之孤兒 Chrome:刪其暫存 profile(只限暫存目錄之直屬子目錄且帶 Playwright 前綴;刪後回驗)
    const tmpRoot = path.resolve(opt.tmpDir || os.tmpdir()).toLowerCase()
    const removeDir = isfun(opt.removeDir) ? opt.removeDir : (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 2 })
    for (const o of killed) {
        if (!o.profileDir) continue
        const abs = path.resolve(o.profileDir)
        if (path.dirname(abs).toLowerCase() !== tmpRoot || !path.basename(abs).startsWith(PLAYWRIGHT_PROFILE_PREFIX)) continue
        try {
            removeDir(abs)
            if (fs.existsSync(abs)) profiles.failed.push({ dir: abs, error: '刪除後仍存在' })
            else profiles.removed.push(abs)
        }
        catch (e) {
            profiles.failed.push({ dir: abs, error: String(e?.message || e).slice(0, 120) })
        }
    }
    return { scanned: procs.length, orphans, killed, failed, profiles }
}

export default { HYGIENE_TARGETS_DEFAULT, PLAYWRIGHT_PROFILE_PREFIX, profileDirOf, listProcessesWin, findOrphans, sweepOrphanBrowsers }
