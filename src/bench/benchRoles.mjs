// benchRoles.mjs — 多角色之 AI 能力評分命令列:各知識處理套件(下游套件)之 bench/cli.mjs 共用之 --role 解析、--vocab-pick、
//   全部角色之準備期檢核、依序交核心之 runBenchCli、前面角色已停測之模型不再於後續角色受測
//
// 【為何在核心】各套件之評分皆為「一組角色＋同一套命令列規則」;各套件各寫一份即漂移(--role all 之限制、停測帶過、--vocab-pick 之子集檔、
//   準備期之範圍)。套件只給:角色清單(依 --role all 之執行序)、取本套件之詞彙鍵之函數與其名(用法說明)、子集檔名之主幹。
// 【--role】預設 all(依角色清單之序);all 時不可給 --cases 與角色專屬參數(各角色之題組格式與專屬參數不同);缺值、重複、不認得即拋。
// 【--vocab-pick】--vocab 之詞彙檔為多段共用之詞彙表:以 pickVocab 取本套件之鍵(他段之鍵略去),準備期以子集驗各角色;全部角色皆過後才把
//   子集寫入 --out 之 <vocabPrefix>-vocab-<時間戳>.json,並以之代 --vocab(報表所記之詞彙檔即此檔)。準備期不寫檔、不建目錄。
// 【準備期】全部角色之參數、題組、詞彙、分頁與提示詞皆於任何呼叫與寫檔之前組得出——後面角色之錯誤不得在前面角色燒完額度後才拋。
// 【停測帶過】前面角色已停測之模型(限流、連續呼叫失敗、條目不可用)不再於後續角色受測——免費額度用盡時 CLI 以逾時回報,不帶過去則每個
//   後續角色各再空耗數次完整逾時;受測模型皆已停測即略過其餘角色。

import fs from 'fs'
import path from 'path'
import isobj from 'wsemi/src/isobj.mjs'
import isarr from 'wsemi/src/isarr.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import isfun from 'wsemi/src/isfun.mjs'
// 詞彙檔之讀取(準備期之檢核;內容之規格交角色之 domainOf 驗)與單角色之命令列同一份
import { defineBenchRole, parseBenchArgs, loadBenchCases, planBench, runBench, runBenchCli, benchUsageOf, readBenchVocabFile as readVocabFile } from './benchKit.mjs'

/** 子集檔名主幹之形式 */
const PREFIX_RE = /^[a-z][a-z0-9-]*$/

/**
 * 以指定之值取代參數中之某選項(「--鍵 值」與「--鍵=值」皆換)
 *
 * @param {Array} rest 輸入其餘參數
 * @param {String} flag 輸入選項名
 * @param {String} value 輸入新值
 * @returns {Array} 回傳新參數陣列
 */
function withArg(rest, flag, value) {
    const out = []
    for (let i = 0; i < rest.length; i++) {
        if (rest[i] === flag) {
            i++
            continue
        }
        if (rest[i].startsWith(`${flag}=`)) continue
        out.push(rest[i])
    }
    return [...out, flag, value]
}

/**
 * 準備期(任何呼叫與寫檔之前):該角色之參數、題組、詞彙、分頁與提示詞皆組得出
 *
 * @param {Object} role 輸入角色
 * @param {Array} rest 輸入其餘參數
 * @param {Object|null} [picked=null] 輸入 --vocab-pick 所取之詞彙子集(給了即以之代 --vocab 之詞彙檔)
 * @throws {Error} 任一不合時拋出
 */
function preflight(role, rest, picked = null) {
    const a = parseBenchArgs(rest, role)
    const cases = loadBenchCases(role, a.cases || undefined)
    const vocab = picked || (a.vocab ? readVocabFile(a.vocab) : null)
    const roleOpt = Object.fromEntries(role.cli.options.filter((o) => a[o.key] !== undefined).map((o) => [o.key, a[o.key]]))
    planBench(role, { cases, ...(vocab ? { vocab } : {}), ...(Object.keys(roleOpt).length ? { roleOpt } : {}) })
}

/**
 * 定義一組評分角色之命令列(見檔頭):回傳角色之取用、單角色之執行與準備、--role 之解析、用法說明與命令列主流程
 *
 * @param {Object} def 輸入定義物件
 * @param {Array} def.roles 輸入角色陣列(defineBenchRole 之產物或定義;依 --role all 之執行序;id 不得重複)
 * @param {Function} def.pickVocab 輸入多段共用之詞彙表 → 本套件所讀之鍵之子集(如下游套件之 pick<工作>Vocab)
 * @param {String} def.pickName 輸入 pickVocab 之名(用法說明用)，如 'pickRelateVocab'
 * @param {String} def.vocabPrefix 輸入 --vocab-pick 子集檔名之主幹(小寫英數與連字號)，如 'relate'(檔名 relate-vocab-<時間戳>.json)
 * @returns {Object} 回傳凍結之物件 { roles:Array(凍結之角色), ids:Array(角色 id), roleOf(id), run(roleId, opt), plan(roleId, opt), parseArgs(argv), usage:String,
 *   runCli(argv, inject) }：roleOf 不認得之 id 即拋(列出可用者);run／plan 即核心之 runBench／planBench 以 id 取角色(各套件之單角色執行器只委派,不各寫);
 *   parseArgs 回 { role(角色 id 或 'all'), roles(依序之角色;help 時為 []), rest(其餘參數), help, pick(--vocab-pick) };
 *   runCli 回 { role, runs:Array<{ role(角色 id), result, report, progressFile, board }>, stopped:Array(本次停測之模型), skipped:Array(未跑之角色 id) }，
 *   --help 時回 { help:true }
 * @throws {Error} 角色清單非陣列或為空、角色定義不合、id 重複、pickVocab 非函數、pickName 非非空字串或 vocabPrefix 形式不合時拋出
 * @example
 * let cli = defineBenchRoles({ roles: [roleA, roleB], pickVocab: pickRelateVocab, pickName: 'pickRelateVocab', vocabPrefix: 'relate' })
 * console.log(cli.parseArgs(['--role=a', '--runs', '1']).rest)
 * // => [ '--runs', '1' ]
 */
export function defineBenchRoles(def) {

    //check
    if (!isobj(def)) {
        throw new Error('defineBenchRoles 需要定義物件 { roles, pickVocab, pickName, vocabPrefix }')
    }
    const problems = []
    if (!isarr(def.roles) || !def.roles.length) problems.push('roles 須為非空之角色陣列')
    if (!isfun(def.pickVocab)) problems.push('pickVocab 須為函數（多段共用之詞彙表 → 本套件之鍵）')
    if (!isestr(def.pickName) || !def.pickName.trim()) problems.push('pickName 須為非空字串（用法說明用）')
    if (!isestr(def.vocabPrefix) || !PREFIX_RE.test(def.vocabPrefix)) problems.push('vocabPrefix 須為小寫英文字母開頭之英數與連字號（子集檔名之主幹）')
    if (problems.length) throw new Error(`defineBenchRoles 之定義不合（${problems.length} 項）：${problems.join('；')}`)

    const roles = Object.freeze(def.roles.map((r) => defineBenchRole(r)))
    const ids = Object.freeze(roles.map((r) => r.id))
    const dup = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
    if (dup.length) throw new Error(`defineBenchRoles 之角色 id 重複：${dup.join('、')}`)
    // 角色專屬之命令列選項(--role all 時不可給:各角色之專屬參數不同)
    const roleFlags = Object.freeze([...new Set(roles.flatMap((r) => r.cli.options.map((o) => o.flag)))])
    const { pickVocab, pickName, vocabPrefix } = def

    /**
     * 依 id 取角色
     *
     * @param {String} id 輸入角色 id
     * @returns {Object} 回傳角色
     * @throws {Error} 不認得之 id 時拋出(列出可用者)
     */
    const roleOf = (id) => {
        const r = roles.find((x) => x.id === id)
        if (!r) throw new Error(`不認得之評分角色：${id}（可用：${ids.join('、')}、all）`)
        return r
    }

    /**
     * 單一角色之評分(核心之 runBench 以 id 取角色)
     *
     * @param {String} roleId 輸入角色 id
     * @param {Object} [opt={}] 輸入核心 runBench 之設定物件
     * @returns {Promise} 回傳 Promise，resolve 回傳核心 runBench 之結果
     * @throws {Error} 角色 id 不認得,或核心於任何呼叫之前之檢核不合時拋出
     */
    const run = async (roleId, opt = {}) => runBench(roleOf(roleId), opt)

    /**
     * 單一角色之評分準備(核心之 planBench 以 id 取角色;不呼叫 AI)
     *
     * @param {String} roleId 輸入角色 id
     * @param {Object} [opt={}] 輸入核心 planBench 之設定物件
     * @returns {Object} 回傳核心 planBench 之結果
     * @throws {Error} 角色 id 不認得,或題組、詞彙、分頁、提示詞不合時拋出
     */
    const plan = (roleId, opt = {}) => planBench(roleOf(roleId), opt)

    const usage = [
        `用法：node src/bench/cli.mjs [--role <${ids.join('|')}|all>] [共用參數…] [角色專屬參數…]`,
        `  --role         評分角色(預設 all:依序 ${ids.join('、')});all 時不可給 --cases 與角色專屬參數(${roleFlags.join('、')}),各角色用其內建之通用題組;`,
        '                 前面角色已停測之模型(限流、連續呼叫失敗、條目不可用)不再於後續角色受測',
        '  --vocab        詞彙檔只收本套件所讀之鍵(他鍵拋錯,以免打錯之鍵靜默失效);與其他知識處理段共用一份詞彙表者加 --vocab-pick',
        `  --vocab-pick   --vocab 之詞彙檔為多段共用之詞彙表:以 ${pickName} 取本套件之鍵(他段之鍵略去),所取之子集寫入 --out 之`,
        `                 ${vocabPrefix}-vocab-<時間戳>.json 並以之評分(報表所記之詞彙檔即此檔)`,
        '  --board        各角色之列並存於同一評比表(如套件根之 模型評比.csv);停測或有未呼叫回合之模型不寫',
        '',
        ...roles.flatMap((r) => [`【${r.name}】`, benchUsageOf(r), '']),
    ].join('\n').trimEnd()

    /**
     * 解析 --role 並取出其餘參數(其餘參數交核心逐角色解析)
     *
     * @param {Array} argv 輸入參數陣列(不含 node 與腳本路徑);支援「--role 值」與「--role=值」
     * @returns {Object} 回傳 { role, roles, rest, help, pick }
     * @throws {Error} --role 缺值、重複、不認得,all 時給 --cases 或角色專屬參數,或 --vocab-pick 帶值、重複或未配 --vocab 時拋出
     */
    const parseArgs = (argv) => {
        const list = isarr(argv) ? argv.map(String) : []
        let role = null
        let help = false
        let pick = false
        const rest = []
        for (let i = 0; i < list.length; i++) {
            const a = list[i]
            if (a === '--role' || a.startsWith('--role=')) {
                const v = a === '--role' ? list[++i] : a.slice('--role='.length)
                if (v === undefined || v === '' || v.startsWith('--')) throw new Error('--role 缺值')
                if (role !== null) throw new Error('--role 重複給定')
                role = v
                continue
            }
            if (a === '--vocab-pick' || a.startsWith('--vocab-pick=')) {
                if (a !== '--vocab-pick') throw new Error('--vocab-pick 不帶值(旗標)')
                if (pick) throw new Error('--vocab-pick 重複給定')
                pick = true
                continue
            }
            if (a === '--help' || a === '-h') help = true
            rest.push(a)
        }
        const id = role ?? 'all'
        if (help) return { role: id, roles: [], rest, help, pick }
        if (pick && !rest.some((a) => a === '--vocab' || a.startsWith('--vocab='))) throw new Error('--vocab-pick 須配 --vocab <多段共用之詞彙檔>')
        const picked = id === 'all' ? [...roles] : [roleOf(id)]
        if (id === 'all') {
            const flags = rest.filter((a) => a.startsWith('--')).map((a) => a.split('=')[0])
            if (flags.includes('--cases')) throw new Error('--role all 不可給 --cases（各角色之題組格式不同；指定題組請配 --role <角色>）')
            const own = [...new Set(flags.filter((f) => roleFlags.includes(f)))]
            if (own.length) throw new Error(`--role all 不可給角色專屬參數 ${own.join('、')}（請配 --role <角色>）`)
        }
        return { role: id, roles: picked, rest, help, pick }
    }

    /**
     * 命令列主流程:解析 --role → 各角色之準備期檢核(全部角色皆過才開始)→ 依序交核心之 runBenchCli(逐回進度檔、報表、--board 評比表);
     *   前面角色已停測之模型不再於後續角色受測,受測模型皆已停測即略過其餘角色
     *
     * @param {Array} argv 輸入參數陣列(不含 node 與腳本路徑;選項見 usage)
     * @param {Object} [inject={}] 輸入注入物件 { aiAdapter(各角色共用之調度層,給了即不建內建調度層), log({ info(msg), error(msg) },預設 console) }
     * @returns {Promise} 回傳 Promise，resolve 回傳 { role, runs, stopped, skipped }；--help 時回 { help:true }
     * @throws {Error} 參數不合、題組不合、詞彙檔不存在或不合、提示詞組不出,或核心之評分前檢核失敗時拋出(--role all 時皆在任何呼叫之前)
     */
    const runCli = async (argv, inject = {}) => {
        if (!isobj(inject)) inject = {}
        const log = isobj(inject.log) && isfun(inject.log.info) ? inject.log : { info: (m) => console.log(m), error: (m) => console.error(m) }
        const args = parseArgs(argv)
        if (args.help) {
            log.info(usage)
            return { help: true }
        }
        // --vocab-pick:多段共用之詞彙表取本套件之鍵(準備期以子集驗;通過後才寫子集檔——準備期不寫檔)
        const shared = args.pick ? parseBenchArgs(args.rest, args.roles[0]) : null
        const picked = shared ? pickVocab(readVocabFile(shared.vocab)) : null
        for (const role of args.roles) preflight(role, args.rest, picked)
        let base = args.rest
        if (picked) {
            fs.mkdirSync(shared.out, { recursive: true })
            const file = path.join(shared.out, `${vocabPrefix}-vocab-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
            fs.writeFileSync(file, `${JSON.stringify(picked, null, 2)}\n`, 'utf8')
            log.info(`--vocab-pick：自 ${shared.vocab} 取本套件之鍵（${Object.keys(picked).join('、')}）→ ${file}`)
            base = withArg(args.rest, '--vocab', file)
        }
        const runs = []
        const stopped = new Set()
        const skipped = []
        for (const [k, role] of args.roles.entries()) {
            let rest = base
            if (stopped.size) {
                const left = parseBenchArgs(base, role).models.filter((m) => !stopped.has(m))
                if (!left.length) {
                    skipped.push(...args.roles.slice(k).map((r) => r.id))
                    log.info(`── 其餘角色（${skipped.join('、')}）略過：受測模型皆已停測（${[...stopped].join('、')}）──`)
                    break
                }
                rest = withArg(base, '--models', left.join(','))
            }
            if (args.roles.length > 1) log.info(`── 角色 ${k + 1}/${args.roles.length}：${role.name}${stopped.size ? `（已停測不再受測：${[...stopped].join('、')}）` : ''} ──`)
            const r = await runBenchCli(role, rest, { ...(isobj(inject.aiAdapter) ? { aiAdapter: inject.aiAdapter } : {}), log })
            runs.push({ role: role.id, ...r })
            for (const m of r.result.models) if (m.stopped) stopped.add(m.model)
        }
        return { role: args.role, runs, stopped: [...stopped], skipped }
    }

    return Object.freeze({ roles, ids, roleOf, run, plan, parseArgs, usage, runCli })
}

export default { defineBenchRoles }
