// kernel.mjs — middleware 核心:訊息信封、洋蔥組合、emit、first 錨點、認名掛載
//
// ════════════════ 全套件動作層的唯一契約════════════════
//
// 【訊息信封 msg】{ topic, data, meta, stats } 是動作鏈上唯一流通物;
//   data=正準記錄＋執行期附掛欄位(_ 前綴),stats=鏈上累計計數。
// 【洋蔥組合(Koa compose)】mw 簽名 (msg, ctx, next):await next(msg) 前=下行、
//   後=上行;不呼叫 next=短路(該 msg 就此完結,halted 記錄短路者)。
// 【first 錨點(Rollup resolveId 語意)】候選依序試,第一個回非空值者勝出;
//   掛載以 add 追加候選(enforce:'pre' 插頭)。
// 【認名掛載(tapable tap 語意)】applyTaps(chain, taps):before/after/replace/add
//   認 mw 名定位;錨點不存在、名稱重複、對非 first 錨點 add——一律定義期拋錯,
//   不默默失效(與 w-data-pipeline defineStage 同一哲學)。
// 【enforce(Vite 語意)】use 追加時 pre → normal → post 分帶排序。

import isobj from 'wsemi/src/isobj.mjs'
import isarr from 'wsemi/src/isarr.mjs'
import isnum from 'wsemi/src/isnum.mjs'
import cint from 'wsemi/src/cint.mjs'

/** 定義期錯誤(設定寫錯要在啟動期爆,不是跑到一半) */
export class MwContractError extends Error {
    constructor(msg) {
        super(msg); this.name = 'MwContractError'; this.code = 'MW_CONTRACT'
    }
}

const ENFORCE = new Set(['pre', 'post', ''])

/**
 * 定義一顆 middleware(洋蔥鏈之基本單元;mw 工廠,opt 省略 @example)
 *
 * @param {Object} spec 輸入定義物件
 * @param {String} spec.name 輸入 mw 名稱，鏈內須唯一(認名掛載之錨點)
 * @param {Function} spec.handle 輸入處理函數，簽名 async (msg, ctx, next) => any，不呼叫 next 即短路
 * @param {Array} [spec.topics] 輸入僅接受之 topic 字串陣列，未給則不限，不合者原樣放行(transparent pass)
 * @param {Function} [spec.when] 輸入細過濾函數 (msg, ctx) => Boolean，未給則不限，不合者原樣放行
 * @param {String} [spec.enforce=''] 輸入排序帶，'pre'／'post'／''(一般帶)，以 use 追加時據此排序，預設''
 * @returns {Object} 回傳 mw 物件 { __kind:'mw', name, handle, topics, when, enforce, mode, candidates }
 * @throws {MwContractError} spec 缺 name、handle 非函數、topics 非字串陣列、when 非函數、enforce 不合法時拋出
 */
export function defineMw(spec) {
    const name = String(spec?.name || '').trim()
    if (!name) throw new MwContractError('middleware 缺少 name')
    if (typeof spec.handle !== 'function') throw new MwContractError(`middleware[${name}] 缺少 handle 函數`)
    if (spec.topics !== undefined && (!Array.isArray(spec.topics) || spec.topics.some((t) => typeof t !== 'string'))) {
        throw new MwContractError(`middleware[${name}] 的 topics 須為字串陣列`)
    }
    if (spec.when !== undefined && typeof spec.when !== 'function') throw new MwContractError(`middleware[${name}] 的 when 須為函數`)
    const enforce = spec.enforce || ''
    if (!ENFORCE.has(enforce)) throw new MwContractError(`middleware[${name}] 的 enforce 只能是 pre／post,收到:${spec.enforce}`)
    return {
        __kind: 'mw',
        name,
        handle: spec.handle,
        topics: spec.topics || null,
        when: spec.when || null,
        enforce,
        mode: '',
        candidates: null,
    }
}

/**
 * 定義 first 錨點:候選依序試,第一個回非空值者勝出(同 Rollup resolveId 語意;mw 工廠,省略 @example)
 *
 * @param {Object} spec 輸入定義物件
 * @param {String} spec.name 輸入錨點名稱，鏈內須唯一(tap add 對此名追加候選)
 * @param {Array} spec.candidates 輸入非空候選陣列，各項為 { name, probe(msg, ctx) => 結果|null, when?, enforce? }
 * @param {Function} [spec.apply] 輸入結果套用函數 (msg, result, ctx, winnerName) => void，未給時預設寫入 msg.data._first[name] 與 msg.data._first[name+'By']
 * @param {Array} [spec.topics] 同 defineMw
 * @param {Function} [spec.when] 同 defineMw
 * @param {String} [spec.enforce] 同 defineMw
 * @returns {Object} 回傳 mw 物件(mode:'first',帶 candidates 陣列)
 * @throws {MwContractError} spec 缺 name、candidates 非非空陣列、候選形狀非 { name, probe } 時拋出
 */
export function defineFirstMw(spec) {
    const name = String(spec?.name || '').trim()
    if (!name) throw new MwContractError('first 錨點缺少 name')
    const cands = spec.candidates
    if (!Array.isArray(cands) || cands.length === 0) throw new MwContractError(`first 錨點[${name}] 需要非空 candidates`)
    for (const c of cands) {
        if (!c?.name || typeof c.probe !== 'function') throw new MwContractError(`first 錨點[${name}] 的候選須為 { name, probe(msg,ctx) }`)
    }
    const apply = spec.apply || ((msg, result, _ctx, winner) => {
        msg.data._first = { ...(msg.data._first || {}), [name]: result, [`${name}By`]: winner }
    })
    const mw = defineMw({
        name,
        topics: spec.topics,
        when: spec.when,
        enforce: spec.enforce,
        // 一般函數而非箭頭:composeChain 以 mw.handle(...) 方法呼叫,this=所屬 mw 實例——
        // applyTaps 之 add 會複製錨點換 candidates 陣列,閉包寫法會讓 clone 仍讀原陣列
        handle: async function (msg, ctx, next) {
            let result = null
            let winner = ''
            for (const c of this.candidates) {
                if (c.when && !c.when(msg, ctx)) continue
                const r = await c.probe(msg, ctx)
                if (r !== null && r !== undefined) {
                    result = r; winner = c.name; break
                }
            }
            apply(msg, result, ctx, winner)
            return next(msg)
        },
    })
    mw.mode = 'first'
    mw.candidates = cands.slice()
    return mw
}

/**
 * 內部:鏈的定義期檢查(元素契約＋名稱唯一)
 *
 * @param {Array} chain 輸入鏈(defineMw／defineFirstMw 產物陣列)
 * @param {String} chainName 輸入鏈名稱字串，供錯誤訊息使用
 * @returns {Array} 回傳同一陣列(通過檢查即原樣回傳)
 * @throws {MwContractError} chain 非非空陣列、含非 defineMw 產物之元素、mw 名重複時拋出
 */
function checkChain(chain, chainName) {
    if (!Array.isArray(chain) || chain.length === 0) throw new MwContractError(`鏈[${chainName}] 須為非空陣列`)
    const seen = new Set()
    for (const m of chain) {
        if (!m || m.__kind !== 'mw') throw new MwContractError(`鏈[${chainName}] 含非 defineMw 產物之元素`)
        if (seen.has(m.name)) throw new MwContractError(`鏈[${chainName}] 有重複的 mw 名:${m.name}`)
        seen.add(m.name)
    }
    return chain
}

/**
 * enforce 分帶排序(pre → 無 → post;帶內保持原順序)
 *
 * @param {Array} list 輸入 mw 陣列
 * @returns {Array} 回傳排序後之新陣列
 */
function sortByEnforce(list) {
    const pre = list.filter((m) => m.enforce === 'pre')
    const normal = list.filter((m) => !m.enforce)
    const post = list.filter((m) => m.enforce === 'post')
    return [...pre, ...normal, ...post]
}

/**
 * 認名掛載:對預設鏈套用 taps,回傳新鏈(原鏈不動)。
 *
 * @param {Array} chain 輸入預設鏈(defineMw 產物陣列)
 * @param {Object} taps 輸入掛載規格，格式為 { [錨點名]: { before?, after?, replace?, add? } }；before／after／add 給了須為陣列，replace 須為 defineMw 產物
 * @param {Object} [opt={}] 輸入設定物件，非物件時視為{}
 * @param {String} [opt.chainName='(未名鏈)'] 輸入鏈名稱字串，供錯誤訊息使用
 * @returns {Array} 回傳套用 taps 後之新鏈
 * @throws {MwContractError} 錨點不存在(附可用錨點)、掛載鍵不認得、before/after/add 給了但非陣列、replace 非 defineMw 產物、對非 first 錨點 add 候選時拋出
 * @example
 * let mw = defineMw({ name: 'b', handle: (m, c, n) => n(m) })
 * let chain = applyTaps([mw], { b: { after: [defineMw({ name: 'log', handle: (m, c, n) => n(m) })] } })
 * console.log(chain.map((m) => m.name))
 * // => [ 'b', 'log' ]
 */
export function applyTaps(chain, taps, opt = {}) {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    const chainName = opt.chainName || '(未名鏈)'
    checkChain(chain, chainName)
    if (!taps) return chain.slice()
    const byName = new Map(chain.map((m) => [m.name, m]))
    const KNOWN = new Set(['before', 'after', 'replace', 'add'])
    for (const [anchor, t] of Object.entries(taps)) {
        if (!byName.has(anchor)) {
            throw new MwContractError(`鏈[${chainName}] 無錨點「${anchor}」(可用:${[...byName.keys()].join('/')})`)
        }
        for (const k of Object.keys(t || {})) {
            if (!KNOWN.has(k)) throw new MwContractError(`鏈[${chainName}] 錨點[${anchor}] 不認得的掛載鍵「${k}」(可用:before/after/replace/add)`)
        }
        // before/after/add 給了但非陣列 → 定義期拋錯(否則 for...of 對非陣列值迭代會拋出語意不明之「not iterable」TypeError)
        for (const k of ['before', 'after', 'add']) {
            if (t?.[k] !== undefined && !isarr(t[k])) {
                throw new MwContractError(`鏈[${chainName}] 錨點[${anchor}] 之「${k}」須為陣列`)
            }
        }
    }
    let out = []
    for (const m of chain) {
        const t = taps[m.name]
        if (!t) {
            out.push(m); continue
        }
        let center = m
        if (t.replace) {
            if (t.replace.__kind !== 'mw') throw new MwContractError(`鏈[${chainName}] 錨點[${m.name}] 之 replace 須為 defineMw 產物`)
            center = t.replace
        }
        if (t.add) {
            if (center.mode !== 'first') throw new MwContractError(`鏈[${chainName}] 錨點[${m.name}] 非 first 錨點,不可 add 候選(改用 before/after/replace)`)
            // 對 first 錨點追加候選:複製一顆免污染預設鏈;enforce:'pre' 之候選插頭
            const clone = { ...center, candidates: center.candidates.slice() }
            for (const c of t.add) {
                if (!c?.name || typeof c.probe !== 'function') throw new MwContractError(`鏈[${chainName}] 錨點[${m.name}] 之 add 候選須為 { name, probe }`)
                if (c.enforce === 'pre') clone.candidates.unshift(c)
                else clone.candidates.push(c)
            }
            center = clone
        }
        for (const b of t.before || []) {
            if (b.__kind !== 'mw') throw new MwContractError(`鏈[${chainName}] 錨點[${m.name}] 之 before 含非 defineMw 產物`)
        }
        for (const a of t.after || []) {
            if (a.__kind !== 'mw') throw new MwContractError(`鏈[${chainName}] 錨點[${m.name}] 之 after 含非 defineMw 產物`)
        }
        out.push(...sortByEnforce(t.before || []), center, ...sortByEnforce(t.after || []))
    }
    return checkChain(out, chainName)
}

/**
 * 無動作鏈(hook 錨點)之子階段拒收 tap／chain:其工廠不建動作鏈,給了不會生效——靜默接受即「掛得上卻永不生效」
 *
 * @param {String} stageName 輸入子階段名(錯誤訊息用)
 * @param {Object} opt 輸入子階段工廠之 opt(已正規化為物件)
 * @returns {undefined} 無回傳值(通過檢查即靜默返回，不通過則拋錯)
 * @throws {MwContractError} opt.tap 或 opt.chain 給了(非 undefined／null)時拋出
 * @example
 * rejectChainOpts('hygiene', { enabled: true })
 * // 不拋錯；rejectChainOpts('hygiene', { tap: {} }) 拋 MwContractError
 */
export function rejectChainOpts(stageName, opt) {
    for (const k of ['tap', 'chain']) {
        if (opt?.[k] !== undefined && opt?.[k] !== null) throw new MwContractError(`子階段[${stageName}] 無動作鏈(hook 錨點),不可給 ${k}`)
    }
}

/**
 * 合併兩份 taps(如物件層平鋪之 tap 與子階段之 tap、執行端之 tap 與插件展開之 tap)
 *
 * before/after/add 依序串接,replace 雙方皆給時拋錯(兩方搶同一錨點之置換沒有合理之合併語意,靜默後者蓋前者最難查);
 * 任一方未給(非物件)即原樣回傳另一方
 *
 * @param {Object} [a] 輸入第一份 taps 物件，格式為 { '<環名>': { before, after, replace, add } }，未給代表無
 * @param {Object} [b] 輸入第二份 taps 物件，格式同 a，未給代表無
 * @param {String} [label=''] 輸入錯誤訊息用之標籤字串，例如 '<物件>.<子階段>'，預設''
 * @returns {Object} 回傳合併後 taps 物件
 * @throws {MwContractError} 同一錨點雙方皆給 replace 時拋出
 * @example
 * let mwA = defineMw({ name: 'mwA', handle: (m, c, n) => n(m) })
 * let mwB = defineMw({ name: 'mwB', handle: (m, c, n) => n(m) })
 * let merged = mergeTaps({ x: { before: [mwA] } }, { x: { before: [mwB], after: [mwB] } })
 * console.log(merged.x.before.length, merged.x.after.length)
 * // => 2 1
 */
export function mergeTaps(a, b, label = '') {

    //check
    if (!isobj(a)) {
        return b
    }
    if (!isobj(b)) {
        return a
    }
    if (typeof label !== 'string') {
        label = ''
    }

    const out = { ...a }
    for (const [anchor, t] of Object.entries(b)) {
        if (!out[anchor]) {
            out[anchor] = t; continue
        }
        const x = { ...out[anchor] }
        if (t.before) x.before = [...(x.before || []), ...t.before]
        if (t.after) x.after = [...(x.after || []), ...t.after]
        if (t.add) x.add = [...(x.add || []), ...t.add]
        if (t.replace) {
            if (x.replace) throw new MwContractError(`${label} 錨點[${anchor}] 之 replace 衝突（雙方同時置換）`)
            x.replace = t.replace
        }
        out[anchor] = x
    }
    return out
}

/**
 * 建立訊息信封
 *
 * @param {String} topic 輸入 topic 字串(如 'doc'／'source')
 * @param {Object} data 輸入正準記錄物件(執行期附掛欄位以 _ 前綴)
 * @param {Object} [meta={}] 輸入附加中繼資料物件，非物件時視為{}
 * @returns {Object} 回傳訊息信封 { topic, data, meta, stats }
 * @throws {MwContractError} topic 為空、data 非物件時拋出
 * @example
 * let msg = makeMsg('doc', { id: 'd1' })
 * console.log(msg.topic, msg.data, msg.meta, msg.stats)
 * // => doc { id: 'd1' } {} {}
 */
export function makeMsg(topic, data, meta = {}) {
    const t = String(topic || '').trim()
    if (!t) throw new MwContractError('msg 缺少 topic')
    if (!data || typeof data !== 'object') throw new MwContractError(`msg[${t}] 的 data 須為物件`)

    //check
    if (!isobj(meta)) {
        meta = {}
    }

    return { topic: t, data, meta: { ...meta }, stats: {} }
}

/**
 * 鏈上累計計數(mw 內慣用寫法:count(msg, 'docs'))
 *
 * @param {Object} msg 輸入訊息信封(makeMsg 產物)
 * @param {String} key 輸入統計鍵名
 * @param {Number} [n=1] 輸入本次累加量，非數字時視為1
 * @returns {Object} 回傳同一 msg(已更新 msg.stats[key])
 * @example
 * let msg = makeMsg('doc', {})
 * count(msg, 'docs')
 * count(msg, 'docs', 3)
 * console.log(msg.stats)
 * // => { docs: 4 }
 */
export function count(msg, key, n = 1) {

    //check
    if (!isnum(n)) {
        n = 1
    }
    n = cint(n)

    msg.stats[key] = (msg.stats[key] || 0) + n
    return msg
}

/**
 * 組合一條鏈為執行器(Koa compose 洋蔥)
 *
 * @param {Array} chain 輸入鏈(defineMw／defineFirstMw 產物陣列)
 * @param {Object} [opt={}] 輸入設定物件(非物件時以選擇性串連讀取,不拋錯)
 * @param {String} [opt.chainName='(未名鏈)'] 輸入鏈名稱字串，供錯誤訊息使用
 * @returns {Function} 回傳執行器 async (msg, ctx) => {msg, halted}，halted 為短路者 mw 名(未短路為空字串)
 * @throws {MwContractError} chain 非非空陣列、含非 defineMw 產物、mw 名重複、同一環重複呼叫 next 時拋出
 * @example
 * let mwCount = defineMw({ name: 'mwCount', handle: async (m, c, next) => { count(m, 'seen'); return next(m) } })
 * let mwStop = defineMw({ name: 'mwStop', handle: async (m) => m })
 * let run = composeChain([mwCount, mwStop], { chainName: 'demo' })
 * let { msg, halted } = await run(makeMsg('doc', { id: 'd1' }), {})
 * console.log(msg.stats, halted)
 * // => { seen: 1 } mwStop
 */
export function composeChain(chain, opt = {}) {
    const chainName = opt?.chainName || '(未名鏈)'
    checkChain(chain, chainName)
    return async function run(msg, ctx) {
        let halted = ''
        const dispatch = async (i, m) => {
            if (i >= chain.length) return m
            const mw = chain[i]
            // topic/when 不合 → 原樣放行(透明):掛載通用 mw 於混合 topic 鏈時不需自防
            if ((mw.topics && !mw.topics.includes(m.topic)) || (mw.when && !mw.when(m, ctx))) {
                return dispatch(i + 1, m)
            }
            let called = false
            const next = (m2) => {
                // 同一環重複呼叫 next 會讓下游整段再跑一次(重複落庫/重複寫檔);Koa compose 同樣拒絕(next() called multiple times)
                if (called) throw new MwContractError(`鏈[${chainName}] 之 mw[${mw.name}] 重複呼叫 next(每環只可呼叫一次)`)
                called = true; return dispatch(i + 1, m2 || m)
            }
            const r = await mw.handle(m, ctx, next)
            if (!called) halted = mw.name
            return r === undefined ? m : r
        }
        const out = await dispatch(0, msg)
        return { msg: out, halted }
    }
}

/**
 * 以鏈逐項處理(含 emit 佇列):初始項目跑完後,ctx.emit 衍生的訊息從鏈頭續跑。
 *
 * 【emit 語意】1→N 衍生(如一篇文拆多筆):emit 的 msg 進本階段佇列、
 *   同一條鏈從頭流過;mw 以 topics/when 自行忽略不相干訊息。
 * 【逐項隔離】單一 msg 拋錯記 fail、不中斷整段(與 w-data-pipeline 逐來源隔離同一哲學);
 *   錯誤樣本留 errors(截斷),供階段 report 與日誌。
 *
 * 【shouldStop:時間預算守門】每取一筆 msg 前詢問;回 true 即停止取件(不中斷進行中的那一筆),
 *   未處理者原樣留在佇列(記錄未動,下輪自然接手)並計入 left。逐篇抓取／逐項套用皆可
 *   接 ctx.expired,使整輪的軟性截止對逐項迴圈同樣生效(不只階段之間檢查)。
 *
 * @param {Object} opt 輸入設定物件
 * @param {Array} opt.chain 輸入鏈(defineMw 產物陣列)
 * @param {Object} opt.ctx 輸入管道脈絡，逐項執行時併入 emit 後交予各 mw
 * @param {Array} [opt.msgs=[]] 輸入初始訊息陣列(makeMsg 產物)，給了須為陣列
 * @param {String} [opt.chainName] 輸入鏈名稱字串，供錯誤訊息使用
 * @param {Integer} [opt.maxEmits=10000] 輸入 emit 衍生總數上限(疑似無限衍生之保險絲)
 * @param {Function} [opt.shouldStop] 輸入 ()=>Boolean，每取一筆 msg 前詢問，回 true 即停止取件
 * @param {Function} [opt.onFail] 輸入 async (msg, error) => void，單筆拋錯時呼叫供呼叫端落帳(如記 tries)
 * @param {Integer} [opt.concurrency=1] 輸入同時處理之筆數:>1 時以波次並行(每波至多 N 筆,一波全部結束才取下一波;shouldStop 於波次間詢問;
 *   emit 衍生之訊息入佇列於後續波次處理;stats／fails／errors 之加總語意不變),1 或未給即逐筆串行
 * @returns {Promise} 回傳 Promise，resolve 回傳 {stats, halts, fails, errors, left}；stats=各 msg.stats 加總，left=因 shouldStop 未處理之筆數
 * @throws {MwContractError} opt 非物件、opt.msgs 給了但非陣列、opt.concurrency 給了但非正整數時拋出
 * @example
 * let mwDo = defineMw({
 *     name: 'mwDo',
 *     handle: async (m, c, next) => {
 *         if (m.data.bad) throw new Error('壞資料')
 *         count(m, 'done')
 *         return next(m)
 *     },
 * })
 * let r = await runChainOverMsgs({
 *     chain: [mwDo],
 *     ctx: {},
 *     msgs: [makeMsg('doc', { id: 1 }), makeMsg('doc', { id: 2, bad: true }), makeMsg('doc', { id: 3 })],
 *     chainName: 'demo',
 * })
 * console.log(r)
 * // => {
 * // =>   stats: { done: 2 },
 * // =>   halts: {},
 * // =>   fails: 1,
 * // =>   errors: [ 'doc:壞資料' ],
 * // =>   left: 0
 * // => }
 */
export async function runChainOverMsgs(opt) {

    //check
    if (!isobj(opt)) {
        throw new MwContractError('runChainOverMsgs 需要 opt 物件')
    }
    if (opt.msgs !== undefined && !isarr(opt.msgs)) {
        throw new MwContractError('runChainOverMsgs 之 opt.msgs 須為陣列')
    }
    if (opt.concurrency !== undefined && !(Number.isInteger(opt.concurrency) && opt.concurrency >= 1)) {
        throw new MwContractError('runChainOverMsgs 之 opt.concurrency 須為正整數')
    }

    const { chain, ctx } = opt
    const runner = composeChain(chain, { chainName: opt.chainName })
    const queue = [...(opt.msgs || [])]
    const maxEmits = opt.maxEmits ?? 10_000 // runaway 保險絲,遠大於實務量
    const shouldStop = typeof opt.shouldStop === 'function' ? opt.shouldStop : null
    const concurrency = opt.concurrency ?? 1
    let emitted = 0
    const chainCtx = {
        ...ctx,
        emit: (m) => {
            if (!m || !m.topic) throw new MwContractError('ctx.emit 需要 makeMsg 產物')
            emitted++
            if (emitted > maxEmits) throw new MwContractError(`鏈[${opt.chainName}] emit 超過上限 ${maxEmits}(疑似無限衍生)`)
            queue.push(m)
        },
    }
    const agg = { stats: {}, halts: {}, fails: 0, errors: [], left: 0 }
    /**
     * 處理一筆(逐項隔離:拋錯記 fails、交 onFail 落帳,不中斷整段)
     * @param {Object} m 輸入訊息
     */
    const runOne = async (m) => {
        try {
            const { msg, halted } = await runner(m, chainCtx)
            if (halted) agg.halts[halted] = (agg.halts[halted] || 0) + 1
            for (const [k, v] of Object.entries(msg.stats)) agg.stats[k] = (agg.stats[k] || 0) + v
        }
        catch (e) {
            agg.fails++
            if (agg.errors.length < 5) agg.errors.push(`${m.topic}:${String(e?.message || e).slice(0, 160)}`)
            // 例外仍落帳之接縫:呼叫端據此記 tries(不記則該項永遠停在原排序位置、每輪佔一個名額)
            if (typeof opt.onFail === 'function') {
                try {
                    await opt.onFail(m, e)
                }
                catch { /* 落帳失敗不覆蓋原錯誤 */ }
            }
        }
    }
    while (queue.length > 0) {
        if (shouldStop && shouldStop() === true) {
            agg.left = queue.length; break
        }
        // 並行(concurrency > 1):一波取至多 N 筆同時跑,整波結束才取下一波(emit 衍生者入佇列於後續波次);串行即逐筆
        if (concurrency > 1) await Promise.all(queue.splice(0, concurrency).map(runOne))
        else await runOne(queue.shift())
    }
    return agg
}

/**
 * 階段契約欄位之透傳(name／onError 給預設;when／enabled／timeoutMs／always 只在給了時原樣透傳):子階段與物件之工廠皆以此組回傳物件,
 *   使 `cfg.stageOpts.<子階段>.enabled:false`／`when(ctx)` 對每個子階段一體適用(runSubStages 據以略過)
 *
 * @param {Object} opt 輸入呼叫端之工廠 opt(已正規化為物件)
 * @param {Object} defaults 輸入預設值物件
 * @param {String} defaults.name 輸入 name 之預設值
 * @returns {Object} 回傳階段契約欄位物件 { name, onError, when?, enabled?, timeoutMs?, always? }
 * @example
 * console.log(stageFields({ enabled: false }, { name: 'n' }))
 * // => { name: 'n', onError: 'continue', enabled: false }
 */
export function stageFields(opt, defaults) {
    const o = isobj(opt) ? opt : {}
    return {
        name: o.name || defaults.name,
        onError: o.onError || 'continue',
        ...(o.when !== undefined && { when: o.when }),
        ...(o.enabled !== undefined && { enabled: o.enabled }),
        ...(o.timeoutMs !== undefined && { timeoutMs: o.timeoutMs }),
        ...(o.always !== undefined && { always: o.always }),
    }
}

/**
 * 統一階段 report:核心統計鍵補零,外部監控只認這組
 *
 * @param {Object} [part={}] 輸入部分欄位物件，非物件時視為{}
 * @param {Boolean} [part.ok] 輸入是否成功，預設由 part.ok!==false 推得(未給即 true)
 * @param {Object} [part.stats] 輸入統計物件，逐鍵覆寫核心統計鍵(in/out/skip/fail/aiCalls 皆補零)
 * @param {Object} [part.detail] 輸入細節物件，預設{}
 * @param {String} [part.summary] 輸入摘要字串，預設''
 * @param {Boolean} [part.stop] 輸入是否為守門停止，true 時附加 stop/reason 欄位
 * @param {String} [part.reason] 輸入停止原因字串(part.stop 為 true 時使用)，預設''
 * @returns {Object} 回傳統一 report 物件 { ok, stats, detail, summary, stop?, reason? }
 * @example
 * console.log(stdReport({ stats: { in: 3 }, summary: 'x' }))
 * // => { ok: true, stats: { in: 3, out: 0, skip: 0, fail: 0, aiCalls: 0 }, detail: {}, summary: 'x' }
 */
export function stdReport(part = {}) {

    //check
    if (!isobj(part)) {
        part = {}
    }

    return {
        ok: part.ok !== false,
        stats: { in: 0, out: 0, skip: 0, fail: 0, aiCalls: 0, ...(part.stats || {}) },
        detail: part.detail || {},
        summary: part.summary || '',
        ...(part.stop ? { stop: true, reason: part.reason || '' } : {}),
    }
}

export default { defineMw, defineFirstMw, applyTaps, rejectChainOpts, mergeTaps, makeMsg, count, composeChain, runChainOverMsgs, stdReport, MwContractError }
