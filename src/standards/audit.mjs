// audit.mjs — 抓取檢定標準之符合度掃描(唯讀,不寫任何知識庫檔案)
//
// 【單一實作】管線之新進守門與本掃描呼叫同一組判定,輸入同為落地形態——掃描之結果即「現行標準下存量之真實違反數」,不另寫一份量測:
//   CS1a stores/healthRecheck.planHealthRecheck(與維護子階段同一判定;閘取 deps.settings.capture.standards,未給＝套件預設);
//   CS2 standards/docStandards.checkTitleBody;CS10 docStandards.duplicateGroups＋stores/contentIndex(段落雜湊,與入庫同一函數);
//   CS12 core/standards/textForms.scriptProblems;CS5 stores/sourcePolicy.cullZeroYieldSources;CS9 core/stores/frontierPolicy.clueDropOf
//   (saveClues 之格式判定即此純函數)。會寫入之判定函數(cullZeroYieldSources)以唯讀替身集合呼叫,只取其回傳之判定(culled),不寫入任何集合。
//   (CS9 不逐筆走 saveClues 寫入之整條路徑——每筆另做正體轉換、去重鍵與查庫,約 5.6 萬筆線索即需 12 秒;只呼叫其格式判定,結果逐筆相同)
//   找不到既有判定函數可重用者不掃(各條之理由見 standards/registry 之 scanNote)。
// 【CS5 以已記之統計判,不以即時之文件統計判】零產出淘汰每輪先以文件統計同步各來源之 judged／yielded、再停用達條件者,故淘汰之後
//   「已記統計已達條件而仍啟用」之來源不應存在(重新啟用皆開新觀察窗,統計歸零)——存在即有寫入入口繞過。即時之文件統計會因下游
//   於兩輪之間判定文件而出現「剛達條件、下輪即停用」者,那是正常之時序,不是違反(以之計違反,每輪巡檢都會誤報)。
//   連敗／連空同理以已記之 failCount／emptyCount 判(sourceStopReasonOf,與 recordSourceOutcome 同一判定);全部記錄另驗執行期欄位之形狀
//   (sourceRecordProblems:時刻為 ISO、計數為非負整數;未給者不判——手動停用可無原因),停用者形狀合格即不適用。
// 【CS9 之範圍】全部線索(任一狀態;已完成與已淘汰者仍供領域發現取候選)以寫入時同一函數重驗格式;site 線索須見於材料(CS11)
//   所需之材料未隨線索落庫,不在此判。型別清單由 opt.clueTypes 傳入(與線索寫入者同一設定;未給＝saveClues 之預設)。
// 【回報】逐標準:總量、四態計數、版本、完整 id(不合格與未能判定皆列);讀不到材料者記未能判定,不報為零。
//   不合格或未能判定而該物件該標準有使用者豁免(holds 之 waived;集合可缺)者記「已豁免」(逐一列出)——豁免是裁示,不是合格。
// 【四工作之掃描共用件(只此一份)】累計器 createStandardsTally(逐標準之桶、四態、以 holdKey 認豁免、逐態 id 上限;登錄另認之豁免鍵與判定說明之
//   替換為選項)、總覽之形狀 standardsScanOf(標準列之對象、AI 列之計數欄 AI_ROW_KEYS 補 0 與全零不列、受檢總量與到期數)、計數摘要
//   standardsCountsOf(入執行摘要 run.json 之 standards;AI 列有則附)——下游各工作之掃描與編排層之合併皆用之,不另寫一份。

import isobj from 'wsemi/src/isobj.mjs'
import isarr from 'wsemi/src/isarr.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import { STATUS, result } from '../core/standards/verdict.mjs'
import { withoutForeignSpans } from '../core/standards/textForms.mjs'
import { scriptOf, scriptApplies, SCRIPT_NA_DETAIL } from '../core/locale.mjs'
import { docTextOf } from '../core/stores/docTexts.mjs'
import { holdKey } from '../core/stores/holds.mjs'
import { clueRulesOf, clueDropOf } from '../core/stores/frontierPolicy.mjs'
import { oneline } from '../core/runnerPackage.mjs'
import { createHealthGates, planHealthRecheck } from '../stores/healthRecheck.mjs'
import { buildIndex, paraKeysOf } from '../stores/contentIndex.mjs'
import { cullZeroYieldSources, sourceStopReasonOf, sourceRecordProblems } from '../stores/sourcePolicy.mjs'
import { checkTitleBody, duplicateGroups, DOC_STANDARDS } from './docStandards.mjs'
import { CAPTURE_STANDARDS } from './registry.mjs'

/** 本掃描逐件判定之標準 id(registry 之 scan 為 true 者;依 registry 之序) */
export const AUDITED_STANDARD_IDS = Object.freeze(CAPTURE_STANDARDS.filter((s) => s.scan).map((s) => s.id))

/** CS10 同一內容群之 id:群內文件 id 以此字元串接(存量處置據以拆回;standards/cs10Fix) */
export const GROUP_ID_SEP = '＋'

/** CS12 之待判登錄物件名(領域標籤與線索值共用):掃描據以認使用者豁免,存量處置(standards/cs12Fix)據以登錄修不了者 */
export const CS12_HOLD_OBJECT = 'label'

/** CS9 不合格之原因(clueDropOf 之 drop 值＝saveClues 之 dropped 鍵 → 說明) */
const CLUE_DROP_LABELS = { type: '型別不在清單', empty: '值空', long: '值過長', site: '網址格式不合', ungrounded: '網址不見於材料' }

/** AI 列之計數欄(依序;檢核紀錄之已檢、四態、版本過時,待判之未結、已豁免) */
export const AI_ROW_KEYS = Object.freeze(['checked', 'pass', 'violation', 'undetermined', 'na', 'stale', 'holdsOpen', 'holdsWaived'])

/**
 * 符合度掃描之累計器(四工作同一份;檔頭):registry 之列中 scan 為真者(only 之範圍內)各一桶 { id, title, kind, v, module, object, total,
 *   pass, violation, undetermined, na, waived, violations, undetermineds, waiveds };add 記一筆判定——不合格／未能判定而該物件該標準有使用者
 *   豁免者記 waived(待判登錄之 waived,鍵以 holdKey 組;o.waivedKeyOf 為登錄另認之豁免鍵)、逐態列出之 id 至多 maxIds
 *
 * @param {Array} standards 輸入 registry 之列(取 scan 為真者;依序)
 * @param {Object} [o={}] 輸入設定物件
 * @param {String} [o.module] 輸入桶之 module 欄(工作段名)
 * @param {Iterable} [o.only] 輸入只建這些標準之桶(未給＝全部)
 * @param {Array} [o.holds] 輸入待判登錄之全部記錄(未給＝集合未開,無豁免)
 * @param {Integer} [o.maxIds] 輸入每態列出之 id 上限(非負整數;預設全部)
 * @param {Function} [o.waivedKeyOf] 輸入 (登錄) => 豁免鍵｜空值:登錄另認之豁免鍵(如下游之存量經覆核待判之豁免)
 * @param {Function} [o.detailOf] 輸入 (判定) => 說明:判定說明之替換(未給用判定之 detail)
 * @returns {Object} 回傳 { std:{ [id]: 桶 }, add:(物件 id, 判定, refs:[[待判之物件, 待判之 id], …])=>void }(判定之 field 有值且異於物件 id 者,
 *   列出之 id 為「物件 id#field」)
 * @example
 * const t = createStandardsTally([{ id: 'X1', title: 't', kind: 'code', v: 1, object: 'docs', scan: true }], { module: 'm', holds: [{ object: 'doc', oid: 'a', std: 'X1', status: 'waived' }] })
 * t.add('a', { std: 'X1', status: 'violation', detail: 'd' }, [['doc', 'a']])
 * t.add('b', { std: 'X1', status: 'violation', detail: 'd' }, [['doc', 'b']])
 * console.log(t.std.X1.waived, t.std.X1.violation, t.std.X1.violations)
 * // => 1 1 [ { id: 'b', detail: 'd' } ]
 */
export function createStandardsTally(standards, o = {}) {
    if (!isobj(o)) o = {}
    const only = o.only ? new Set(o.only) : null
    const maxIds = Number.isInteger(o.maxIds) && o.maxIds >= 0 ? o.maxIds : Infinity
    const std = {}
    for (const s of isarr(standards) ? standards : []) {
        if (!s?.scan || (only && !only.has(s.id))) continue
        std[s.id] = { id: s.id, title: s.title, kind: s.kind, v: s.v, module: String(o.module || ''), object: s.object, total: 0, pass: 0, violation: 0, undetermined: 0, na: 0, waived: 0, violations: [], undetermineds: [], waiveds: [] }
    }
    const waivedKeys = new Set()
    for (const h of isarr(o.holds) ? o.holds : []) {
        if (h?.status === 'waived') waivedKeys.add(holdKey(h.object, h.oid, h.std))
        const k = isfun(o.waivedKeyOf) ? o.waivedKeyOf(h) : ''
        if (isestr(k)) waivedKeys.add(k)
    }
    const add = (objId, r, refs = []) => {
        const b = std[r?.std]
        if (!b) return
        const st = (r.status === STATUS.VIOLATION || r.status === STATUS.UNDETERMINED) && (isarr(refs) ? refs : []).some(([obj, oid]) => waivedKeys.has(holdKey(obj, oid, r.std))) ? STATUS.WAIVED : r.status
        const detail = isfun(o.detailOf) ? o.detailOf(r) : r.detail
        b.total++
        b[st] = (b[st] || 0) + 1
        const id = r.field && r.field !== objId ? `${objId}#${r.field}` : objId
        if (st === STATUS.VIOLATION && b.violations.length < maxIds) b.violations.push({ id, detail })
        if (st === STATUS.UNDETERMINED && b.undetermineds.length < maxIds) b.undetermineds.push({ id, detail })
        if (st === STATUS.WAIVED && b.waiveds.length < maxIds) b.waiveds.push({ id, detail })
    }
    return { std, add }
}

/**
 * 唯讀替身集合:select／get 只讀給定之記錄(select 依 find 之欄位相等篩選),寫入一律不落地——供會寫入之判定函數只取其判定、不改任何集合
 *
 * @param {Array} rows 輸入記錄陣列
 * @returns {Object} 回傳 { select, get, patch, insertNew }(patch、insertNew 為空操作)
 */
function readOnlyOf(rows) {
    const list = Array.isArray(rows) ? rows : []
    const match = (r, find) => !isobj(find) || Object.entries(find).every(([k, v]) => r?.[k] === v)
    return {
        select: async (find) => list.filter((r) => match(r, find)).map((r) => ({ ...r })),
        get: async (id) => {
            const r = list.find((x) => String(x?.id) === String(id))
            return r ? { ...r } : null
        },
        patch: async () => {},
        insertNew: async () => ({ added: [], addCount: 0, dupCount: 0 }),
    }
}

/**
 * 抓取檢定標準之符合度掃描(唯讀)
 *
 * @param {Object} deps 輸入 { stores:{ docs, docTexts?, sources?, frontier?, areas?, holds? }, settings?(capture.standards:CS1a 之閘、titleMismatch／sameContent
 *   為 false 時 CS2／CS10 不判且桶記 disabled:true;capture.sources:CS5 之 cullMinJudged), locale?(語言設定或字形政策;CS12 只適用於臺灣正體,
 *   其餘逐件列不適用;未給＝正體) }
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Boolean} [opt.material=true] 輸入 CS10 是否以原文(docs 或 docTexts)補算無段落雜湊者;false 時該等文件記未能判定
 * @param {Array} [opt.only] 輸入只跑這些標準 id(未給或空陣列＝全部)
 * @param {Integer} [opt.maxIds] 輸入每態列出之 id 上限(非負整數;預設全部)
 * @param {Array} [opt.clueTypes] 輸入 CS9 之線索型別清單(與線索寫入者同一設定;未給＝saveClues 之預設)
 * @returns {Promise} 回傳 Promise,resolve 回傳 { counts:{ docsRaw, docsNoted, areas, frontierPending, frontier, sources },
 *   standards:{ [id]: { id, title, kind, v, module, object, total, pass, violation, undetermined, na, waived,
 *   violations:[{ id, detail }], undetermineds:[{ id, detail }], waiveds:[{ id, detail }] } } }
 * @throws {Error} deps.stores.docs 缺 select 方法、opt.clueTypes 給了而非陣列時拋出
 * @example
 * need test in nodejs.
 *
 * const rep = await auditCaptureStandards({ stores, settings }, { maxIds: 50 })
 * console.log(rep.standards.CS10.violation, rep.counts.docsNoted)
 */
export async function auditCaptureStandards(deps, opt = {}) {

    //check
    const stores = deps?.stores
    if (!isobj(stores) || !isfun(stores.docs?.select)) {
        throw new Error('auditCaptureStandards 需要 deps.stores.docs（具 select 方法）')
    }
    if (!isobj(opt)) {
        opt = {}
    }
    // 型別清單給錯是設定錯誤:當下即拋(否則每筆線索都判成「判定拋錯」而淹沒真正之違反)
    if (opt.clueTypes !== undefined && !Array.isArray(opt.clueTypes)) {
        throw new Error('auditCaptureStandards 之 clueTypes 須為字串陣列')
    }

    const only = Array.isArray(opt.only) && opt.only.length ? opt.only : null
    const useMaterial = opt.material !== false
    // 累計器(四工作同一份;使用者豁免為 holds 之 waived,一次讀;refs＝該物件於待判登錄之 [物件, id],可多個)
    const allHolds = stores.holds ? await stores.holds.select() : null
    const { std, add } = createStandardsTally(CAPTURE_STANDARDS, { module: 'capture', only, holds: allHolds, maxIds: opt.maxIds })
    // 停用之標準(零件庫用法:capture.standards.titleMismatch:false → CS2、sameContent:false → CS10):不判、桶記 disabled(總量 0,不報合格)
    const stdCfg = deps.settings?.capture?.standards || {}
    const disabled = new Set([...(stdCfg.titleMismatch === false ? ['CS2'] : []), ...(stdCfg.sameContent === false ? ['CS10'] : [])])
    for (const id of disabled) if (std[id]) std[id].disabled = true
    const want = (id) => !!std[id] && !disabled.has(id)
    // 字形政策(deps.locale;core/locale):CS12 只適用於臺灣正體——其他語言仍逐件列「不適用」(受檢總量不為 0、不報合格)
    const script = scriptOf(deps.locale, 'auditCaptureStandards 之 deps.locale')
    const cs12Applies = scriptApplies(DOC_STANDARDS.find((s) => s.id === 'CS12'), script)

    // ── 文件 raw:CS1a(現版健全閘,依入口套判準)、CS2(記錄標題對正文)──
    const raw = await stores.docs.select({ status: 'raw' })
    const gates = want('CS1a') ? createHealthGates(deps.settings?.capture?.standards || {}) : null
    for (const d of raw) {
        if (gates) {
            const p = planHealthRecheck(d, gates, {})
            add(d.id, result('CS1a', p.status, p.why || (p.kind ? `${p.kind}${p.hit ? `（${p.hit}）` : ''}` : '')), [['doc', d.id]])
        }
        if (want('CS2')) add(d.id, checkTitleBody(d.title, d.text), [['doc', d.id]])
    }

    // ── 文件 noted:CS10 ──
    const noted = await stores.docs.select({ status: 'noted' })
    if (want('CS10')) {
        // 網址正準代稱相同(duplicateGroups)＋跨文件段落雜湊重疊(依入庫先後逐篇比對先前者;與入庫時同一判定 contentIndex)。
        //   段落雜湊:記錄有 paraKeys 者用之;無者以原文(docs 或 docTexts;與入庫同一函數 paraKeysOf)當場算——原文皆不可得(或未讀材料)者
        //   段落重疊無從比對 → 未能判定(不報合格;網址代稱群照判)
        const groups = duplicateGroups(noted)
        const pIdx = buildIndex([])
        const withKeys = []
        const noKeys = new Map() // 文件 id → 未能判定之說明
        for (const d of noted) {
            if (Array.isArray(d.paraKeys)) {
                withKeys.push(d)
                continue
            }
            let text = String(d.text || '')
            if (!text && useMaterial) text = String((await docTextOf(stores, d.id))?.text || '')
            if (text) withKeys.push({ ...d, paraKeys: paraKeysOf(text) })
            else noKeys.set(d.id, useMaterial ? '無段落雜湊且原文不可得（docs 與 docTexts 皆無），段落重疊無從比對' : '無段落雜湊且未讀原文（material:false），段落重疊無從比對')
        }
        for (const d of withKeys.filter((x) => x.paraKeys.length).sort((a, b) => String(a.notedAt || '').localeCompare(String(b.notedAt || '')) || String(a.id).localeCompare(String(b.id)))) {
            const hit = pIdx.matchParas(d.paraKeys, d.id)
            if (hit) groups.push({ key: `para:${hit.shared}`, ids: [hit.id, d.id] })
            pIdx.add({ id: d.id, paraKeys: d.paraKeys })
        }
        const inGroup = new Set(groups.flatMap((x) => x.ids))
        for (const d of noted) if (!inGroup.has(d.id)) add(d.id, noKeys.has(d.id) ? result('CS10', STATUS.UNDETERMINED, noKeys.get(d.id)) : result('CS10', STATUS.PASS), [['doc', d.id]])
        for (const gp of groups) add(gp.ids.join(GROUP_ID_SEP), result('CS10', STATUS.VIOLATION, `同一內容 ${gp.ids.length} 份（${gp.key}）`), gp.ids.map((x) => ['doc', x]))
    }

    // ── 領域標籤、線索值:CS12(正體)──
    const areas = stores.areas ? await stores.areas.select() : []
    const clues = stores.frontier ? await stores.frontier.select() : []
    const frontierPending = clues.filter((f) => f?.status === 'pending')
    if (want('CS12')) {
        // 修不了而經使用者豁免者(待判登錄物件 CS12_HOLD_OBJECT)記 waived——不帶登錄物件者豁免永不生效、每輪照報違反
        for (const a of areas) {
            if (!a?.label) continue
            if (!cs12Applies) {
                add(a.id, result('CS12', STATUS.NA, SCRIPT_NA_DETAIL), [[CS12_HOLD_OBJECT, a.id]])
                continue
            }
            const pr = script.problems(a.label)
            add(a.id, pr.count ? result('CS12', STATUS.VIOLATION, `領域標籤「${a.label}」`) : result('CS12', STATUS.PASS), [[CS12_HOLD_OBJECT, a.id]])
        }
        for (const f of frontierPending) {
            if (!/\p{Script=Han}/u.test(String(f?.value || ''))) continue
            if (!cs12Applies) {
                add(f.id, result('CS12', STATUS.NA, SCRIPT_NA_DETAIL), [[CS12_HOLD_OBJECT, f.id]])
                continue
            }
            // 網址(站點線索)不計——與正體之修正同一定義(FOREIGN_SPAN_RE);站點線索入庫時本不轉(core/stores/frontierPolicy)
            const pr = script.problems(withoutForeignSpans(f.value))
            add(f.id, pr.count ? result('CS12', STATUS.VIOLATION, `線索「${f.value}」`) : result('CS12', STATUS.PASS), [[CS12_HOLD_OBJECT, f.id]])
        }
    }

    // ── 來源:CS5(全部記錄之執行期欄位形狀;啟用中者已記之連敗／連空與產出統計不得已達停用條件;檔頭)──
    const sources = stores.sources ? await stores.sources.select() : []
    if (want('CS5')) {
        const sp = deps.settings?.capture?.sources
        const minJudged = sp?.cullMinJudged
        // 連敗／連空之門檻與自動來源判定同 listFetch 之 recordSourceOutcome(未給 capture.sources 即該函數之預設;無 isAutoSource 即不判連空)
        const stopCfg = { maxConsecFails: sp?.maxConsecFails, maxConsecEmpty: sp?.maxConsecEmpty, isAutoSource: sp?.isAutoSource }
        const recorded = (s) => ({ judged: Number(s?.judged) || 0, yielded: Number(s?.yielded) || 0 })
        for (const s of sources) {
            if (!s?.id) continue
            try {
                const shape = sourceRecordProblems(s)
                if (shape.length) {
                    add(s.id, result('CS5', STATUS.VIOLATION, `記錄形狀：${shape.join('、')}`))
                    continue
                }
                if (s.enabled === false) {
                    add(s.id, result('CS5', STATUS.NA, '已停用'))
                    continue
                }
                const stop = sourceStopReasonOf(s, stopCfg)
                if (stop) {
                    add(s.id, result('CS5', STATUS.VIOLATION, `已達停用條件（${stop}）而仍啟用`))
                    continue
                }
                const r = await cullZeroYieldSources(readOnlyOf([s]), recorded, { minJudged })
                add(s.id, r.culled ? result('CS5', STATUS.VIOLATION, `已判定 ${recorded(s).judged} 篇、產出 0 而仍啟用`) : result('CS5', STATUS.PASS))
            }
            catch (e) {
                add(s.id, result('CS5', STATUS.UNDETERMINED, `判定拋錯：${oneline(e?.message, 120)}`))
            }
        }
    }

    // ── 線索:CS9(格式;寫入時同一函數重驗,唯讀)──
    if (want('CS9')) {
        const rules = clueRulesOf({ types: opt.clueTypes })
        for (const c of clues) {
            if (!c?.id) continue
            try {
                const { drop } = clueDropOf({ type: c.type, value: c.value }, rules)
                add(c.id, drop ? result('CS9', STATUS.VIOLATION, `線索「${oneline(c.value, 60)}」（${String(c.type ?? '')}）：${CLUE_DROP_LABELS[drop] || drop}`) : result('CS9', STATUS.PASS))
            }
            catch (e) {
                add(c.id, result('CS9', STATUS.UNDETERMINED, `判定拋錯：${oneline(e?.message, 120)}`))
            }
        }
    }

    return {
        counts: { docsRaw: raw.length, docsNoted: noted.length, areas: areas.length, frontierPending: frontierPending.length, frontier: clues.length, sources: sources.length },
        standards: std,
    }
}

/**
 * 掃描結果 → 總覽之形狀(四工作同一份;與他工作之掃描合併、入計數摘要之前):標準列原樣(給了 o.object 者對象改為之);AI 列之計數欄
 *   (AI_ROW_KEYS)null 補 0、全零之列與整列為 null 者不列——受檢總量與到期數(total／due;有者附之)有其一非零者照列;counts 之各值轉數值
 *
 * @param {Object} rep 輸入各工作之掃描之產物 { counts?, standards?, ai? }
 * @param {Object} [o={}] 輸入設定物件
 * @param {String} [o.object] 輸入標準列之對象(合併之總覽之欄;未給不改)
 * @returns {Object} 回傳 { counts:{ 名: 數值 }, standards:{ [id]: 標準列 }, ai:{ [id]: { checked, pass, violation, undetermined, na, stale, holdsOpen,
 *   holdsWaived, v, total?, due? } } }
 * @example
 * const s = standardsScanOf({ counts: { edges: 3 }, standards: {}, ai: { RS4: { v: 1, checked: null, holdsOpen: 2 }, RS5: null, RS6: { v: 1, checked: 0, holdsOpen: 0 } } })
 * console.log(s.counts.edges, Object.keys(s.ai), s.ai.RS4.checked, s.ai.RS4.holdsOpen)
 * // => 3 [ 'RS4' ] 0 2
 */
export function standardsScanOf(rep, o = {}) {
    const r = isobj(rep) ? rep : {}
    const object = isestr(o?.object) ? o.object : ''
    const standards = {}
    for (const [id, s] of Object.entries(isobj(r.standards) ? r.standards : {})) {
        if (isobj(s)) standards[id] = object ? { ...s, object } : { ...s }
    }
    const ai = {}
    for (const [id, a] of Object.entries(isobj(r.ai) ? r.ai : {})) {
        if (!isobj(a)) continue
        const row = Object.fromEntries(AI_ROW_KEYS.map((k) => [k, Number(a[k]) || 0]))
        const prog = a.total !== undefined ? { total: Number(a.total) || 0, due: Number(a.due) || 0 } : null
        if (AI_ROW_KEYS.every((k) => row[k] === 0) && !(prog && (prog.total || prog.due))) continue
        ai[id] = { ...row, v: a.v ?? null, ...(prog || {}) }
    }
    const counts = Object.fromEntries(Object.entries(isobj(r.counts) ? r.counts : {}).map(([k, v]) => [k, Number(v) || 0]))
    return { counts, standards, ai }
}

/**
 * 符合度掃描之計數摘要(四工作同一份;管線每輪掃描後入執行摘要 run.json 之 standards,巡檢讀之;不含逐件 id——明細以掃描本身取得):
 *   逐標準 { v, total, violation, undetermined, waived };掃描有 AI 列者(standardsScanOf 之形狀)另附 ai[標準]＝{ holdsOpen, total?, due? }
 *
 * @param {Object} scan 輸入掃描之產物(抓取之 auditCaptureStandards,或他工作經 standardsScanOf 整形者)
 * @param {Object} [o={}] 輸入 { at:掃描時刻, ms:耗時 }
 * @returns {Object} 回傳 { at, ms, counts:{ 標準: { v, total, violation, undetermined, waived } }, ai?:{ AI 標準: { holdsOpen, total?, due? } } }
 * @example
 * const c = standardsCountsOf({ standards: { CS2: { id: 'CS2', v: 1, total: 3, violation: 1, undetermined: 0, waived: 0 } } }, { at: 't', ms: 5 })
 * console.log(c.counts.CS2.violation, 'ai' in c)
 * // => 1 false
 */
export function standardsCountsOf(scan, o = {}) {
    if (!isobj(o)) o = {}
    const counts = {}
    for (const s of Object.values(isobj(scan?.standards) ? scan.standards : {})) {
        if (isobj(s)) counts[s.id] = { v: s.v, total: s.total, violation: s.violation, undetermined: s.undetermined, waived: s.waived || 0, ...(s.disabled === true ? { disabled: true } : {}) }
    }
    const out = { at: String(o.at || ''), ms: Number(o.ms) || 0, counts }
    if (isobj(scan?.ai)) {
        out.ai = {}
        for (const [id, a] of Object.entries(scan.ai)) out.ai[id] = { holdsOpen: Number(a?.holdsOpen) || 0, ...(a?.total !== undefined ? { total: Number(a.total) || 0, due: Number(a.due) || 0 } : {}) }
    }
    return out
}

export default { AUDITED_STANDARD_IDS, GROUP_ID_SEP, CS12_HOLD_OBJECT, AI_ROW_KEYS, createStandardsTally, auditCaptureStandards, standardsScanOf, standardsCountsOf }
