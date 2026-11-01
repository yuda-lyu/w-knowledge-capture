// registry.mjs — 抓取檢定標準之全集(定義表;純資料,不判定)
//
// 【一條一列】{ id, title, object(對象與入口), kind, v, proves(能證明), notProves(不能證明), enforcedAt(執行處), scan, scanNote }:
//   kind:'program'＝程式判定;'program+ai'＝契約由程式判、內容判定由 AI(以題組逐案評);'known-limit'＝已知限制(行為已定、不再改進)。
//   enforcedAt:新進守門與處置之所在,「套件內檔案:函數」(路徑相對原始碼夾 src/);同一標準多處執行者皆列。
//   scan:auditCaptureStandards(standards/audit)是否以本條 id 逐件判定並計數;scanNote 寫掃描之範圍,或不掃之理由。
// 【版本單一來源】可掃描之文件標準(CS1a、CS2、CS10、CS12)之標題與版本取自 standards/docStandards 之 DOC_STANDARDS(判定改變即升版,
//   掃描與存量處置據以判斷是否須重掃);其餘為 1。領域發現之契約數字取自 domain/areaDomain 之 AREA_CONTRACT(提示詞與驗證同讀)。
// 【能證明／不能證明】程式標準只證明形式、來源與結構(判定可重算);「不能證明」即該標準之已知盲區,由所列之他標準或使用者判讀補位。

import { DOC_STANDARDS } from './docStandards.mjs'
import { AREA_CONTRACT } from '../domain/areaDomain.mjs'

/**
 * 文件標準之標題與版本(DOC_STANDARDS 為唯一來源;缺者即拋——表與判定脫節時於載入當下發現)
 *
 * @param {String} id 輸入標準 id
 * @returns {Object} 回傳 { title, v }
 * @throws {Error} DOC_STANDARDS 無此 id 時拋出
 */
function docStd(id) {
    const s = DOC_STANDARDS.find((x) => x.id === id)
    if (!s) throw new Error(`registry:DOC_STANDARDS 缺 ${id}`)
    return { title: s.title, v: s.v }
}

const C = AREA_CONTRACT

/** 抓取檢定標準全集(依 id 排序) */
export const CAPTURE_STANDARDS = Object.freeze([
    {
        id: 'CS1a',
        ...docStd('CS1a'),
        object: 'docs;入口 article(內建正文抓取器)、browser(瀏覽器階梯)',
        kind: 'program',
        proves: '正文不是錯誤頁、亂碼、格式雜訊、過短、佔位或付費牆(依閘版本);存量 raw 依現版閘重判',
        notProves: '內容是否為知識(下游之範疇判定);是否為該網址之正確文章(CS2 只判確定錯頁)',
        enforcedAt: [
            'stores/contentGate.mjs:createContentGate',
            'stages/detailFetchStage.mjs:mwContentGate',
            'fetchers/browserLadder.mjs:runBrowserLadder',
            'stores/healthRecheck.mjs:planHealthRecheck',
            'stages/docMaintainStage.mjs:mwRecheckHealth',
        ],
        scan: true,
        scanNote: 'raw 依現版閘重判(planHealthRecheck,與維護子階段同一判定);依 textFrom 套各入口之判準,故 CS1b～e 之存量亦計於此條',
    },
    {
        id: 'CS1b',
        title: '正文健全(站台 adapter:豁免找不到、佔位、付費牆)',
        object: 'docs;入口 adapter(站台 adapter 之正文)',
        kind: 'program',
        v: 1,
        proves: 'adapter 之正文不過短、非亂碼、非格式雜訊',
        notProves: 'adapter 正文之找不到、佔位、付費牆(刻意豁免:站方 API 組出之正文,來源已知)',
        enforcedAt: [
            'stores/contentGate.mjs:createContentGate',
            'stages/detailFetchStage.mjs:mwContentGate',
        ],
        scan: false,
        scanNote: '存量併入 CS1a 之掃描(planHealthRecheck 依 textFrom adapter:<id> 套豁免)',
    },
    {
        id: 'CS1c',
        title: '正文健全(feed 退路:長度達退路門檻且過健全閘)',
        object: 'docs;入口 feed 退路(全文抓不到時以 feed 內文落 raw)',
        kind: 'program',
        v: 1,
        proves: 'feed 內文達退路長度(minFallbackChars)且過同一健全閘(長度條件以 feed 原長判)',
        notProves: '庫內截斷之後段內容之亂碼與標記密度(閘以入庫之截斷形態判)',
        enforcedAt: [
            'stages/detailFetchStage.mjs:feedUsableOf',
            'stages/detailFetchStage.mjs:mwFeedFallback',
            'stages/detailFetchStage.mjs:mwBrowserRetry',
        ],
        scan: false,
        scanNote: '存量併入 CS1a 之掃描(planHealthRecheck 依 textFrom feed 以 feed 退路之閘判)',
    },
    {
        id: 'CS1d',
        title: '正文健全(grid 摘要:不過短、非亂碼;刻意不經一般閘)',
        object: 'docs;入口 grid(OpenAlex／arXiv 摘要直入 raw)',
        kind: 'program',
        v: 1,
        proves: '論文摘要不過短、非亂碼',
        notProves: '摘要之佔位、付費牆樣式(刻意不套:對論文摘要只會誤殺)',
        enforcedAt: [
            'stores/contentGate.mjs:gridAbstractCheck',
            'fetchers/defaultFetchers.mjs:createDefaultFetchers',
        ],
        scan: false,
        scanNote: '存量併入 CS1a 之掃描(planHealthRecheck 依 textFrom abstract 以 gridAbstractCheck 判)',
    },
    {
        id: 'CS1e',
        title: '正文健全(安裝方自訂之正文抓取器:未明示豁免者同 CS1a)',
        object: 'docs;入口 安裝方自訂之 detail 抓取器',
        kind: 'program',
        v: 1,
        proves: '自訂抓取器之正文同過健全閘(不合格 → 重試,不轉瀏覽器)',
        notProves: '抓取器明示豁免(contract.gateExempt)者之正文(安裝方負責)',
        enforcedAt: [
            'stages/detailFetchStage.mjs:mwFetchDetail',
            'stages/detailFetchStage.mjs:mwContentGate',
            'stages/detailFetchStage.mjs:mwPersistOutcome',
            'stores/fetchPolicy.mjs:classifyFetch',
        ],
        scan: false,
        scanNote: '存量併入 CS1a 之掃描(自訂抓取器之正文以 textFrom article 落 raw;明示豁免者記 gateExempt → 不適用)',
    },
    {
        id: 'CS2',
        ...docStd('CS2'),
        object: 'docs;入口 article、browser(正文抓取器與同輪瀏覽器救回之正文)',
        kind: 'program',
        proves: '記錄標題與正文確定不符(錯頁):同文字系統、標題詞 ≥4、正文開頭之覆蓋為 0',
        notProves: '標題詞過少或跨文字系統時之相符與否(不適用,不擋)',
        enforcedAt: [
            'standards/docStandards.mjs:checkTitleBody',
            'stages/detailFetchStage.mjs:mwContentGate',
            'stages/detailFetchStage.mjs:mwBrowserRetry',
            'stores/fetchPolicy.mjs:classifyFetch',
            'ops/refetchSources.mjs:judgeArticleRefetch',
        ],
        scan: true,
        scanNote: 'raw 之記錄標題對庫內正文(checkTitleBody)',
    },
    {
        id: 'CS3',
        title: '失敗分流(終態／重試／轉瀏覽器)',
        object: 'docs;補全文、彙整轉錄、瀏覽器階梯之失敗,與存量重判之不合格',
        kind: 'program',
        v: 1,
        proves: '失敗依類分流:決定性失敗一輪即終態、暫時性失敗退避重試、需渲染或被擋者轉瀏覽器;本機網路不通不計次',
        notProves: '終態判定之時效:非內容類之終態(HTTP 決定性、無效網址等)於抓取能力或站台改變後不自動回收(由維運回收;內容類終態於閘改版時依版重判)',
        enforcedAt: [
            'stores/fetchPolicy.mjs:classifyFetch',
            'stages/detailFetchStage.mjs:mwBrowserRetry',
            'stages/detailFetchStage.mjs:mwTranscodeLinks',
            'stages/detailFetchStage.mjs:mwPersistOutcome',
            'stores/healthRecheck.mjs:planHealthRecheck',
        ],
        scan: false,
        scanNote: '未掃:分流是對單次抓取結果之處置(結果只部分落庫:類別、原因、狀態碼);內容類終態之依版重判由維護子階段處理(stores/healthRecheck 之 planDeadRecheck)',
    },
    {
        id: 'CS4',
        title: '網址去重(正規化網址、轉址後網址)',
        object: 'docs;全部入口(輪抓、探測、轉錄、轉址後網址)',
        kind: 'program',
        v: 1,
        proves: '同一正規化網址只入庫一次;轉址至已取得內容之既有文件者記 skip(重複)',
        notProves: '網址不同之同一內容(由 CS10 之正準編號與段落重疊判)',
        enforcedAt: [
            'stores/ingestGate.mjs:normalizeFeedItems',
            'stores/ingestGate.mjs:admitFeedItems',
            'stages/detailFetchStage.mjs:mwPersistOutcome',
        ],
        scan: false,
        scanNote: '未掃:文件 id 即正規化網址之雜湊(去重層之身分),同一網址不可能有兩筆',
    },
    {
        id: 'CS5',
        title: '來源健康(連敗、連空、零產出即停用;冷卻期滿重探並開新觀察窗)',
        object: 'sources;輪抓計帳、每輪之零產出淘汰與冷卻重探',
        kind: 'program',
        v: 1,
        proves: '來源依連敗、自動來源連空、零產出(觀察窗內之已判定篇數,非對內容之判定之 skip 不計)停用;停用者冷卻期滿重探並開新觀察窗(計數歸零)',
        notProves: '來源之內容價值(由產出之知識量間接反映)',
        enforcedAt: [
            'stores/sourcePolicy.mjs:recordSourceOutcome',
            'stores/sourcePolicy.mjs:sourceStopReasonOf',
            'stores/sourcePolicy.mjs:sourceRecordProblems',
            'stores/sourcePolicy.mjs:cullZeroYieldSources',
            'stores/sourcePolicy.mjs:reprobeSources',
            'stages/collectHelpers.mjs:judgeFromDocs',
            'stages/seedSyncStage.mjs:mwCullSources',
            'stages/listFetchStage.mjs:mwAccountSource',
        ],
        scan: true,
        scanNote: '全部來源記錄:執行期欄位之形狀(sourceRecordProblems:時刻欄為 ISO 字串、計數欄為非負整數、enabled／paused 布林、原因欄字串;未給者不判);啟用中之來源:已記之連敗／連空(sourceStopReasonOf,與 recordSourceOutcome 同一判定、同一門檻)與產出統計(cullZeroYieldSources 唯讀呼叫)皆不得已達停用條件;停用者形狀合格即不適用(重探由冷卻與每輪名額決定,逾期未重探不是違反)',
    },
    {
        id: 'CS6',
        title: '領域自動提案經驗證才啟用;被拒者記原因並冷卻,期滿同查詢可重驗',
        object: 'areas;自動發現(種子領域刻意免驗)',
        kind: 'program',
        v: 1,
        proves: '自動提案之領域經 OpenAlex 驗證(計數、首頁有摘要者、首頁已在庫比例)才啟用;被拒者冷卻中不再提,冷卻期滿同查詢可重驗',
        notProves: '領域之內容價值(由產出之知識量間接反映);種子領域之適切性(安裝方宣告,刻意免驗)',
        enforcedAt: [
            'stages/areaStage.mjs:validateAreaQuery',
            'stages/areaStage.mjs:discover',
            'stores/areaPolicy.mjs:pickAreaCandidates',
        ],
        scan: false,
        scanNote: '未掃:已拒記錄之原因與冷卻期無既有判定函數可重用;冷卻中之判定內嵌於 pickAreaCandidates 與 discover 兩處,且不能區分「冷卻已滿」與「未記冷卻」',
    },
    {
        id: 'CS7',
        title: '手動狀態不被自動改寫;手動恢復重設觀察窗',
        object: 'areas(statusBy manual)與其 grid 來源;種子同步、品質回饋、冷卻重探、維運之手動設定',
        kind: 'program',
        v: 1,
        proves: '手動暫停只由手動解除(種子同步與自動重探不改寫);手動恢復開新觀察窗,品質回饋只依新窗內之判定',
        notProves: '來源與領域之內容價值(由產出之知識量間接反映)',
        enforcedAt: [
            'stores/areaPolicy.mjs:setAreaStatus',
            'stores/areaPolicy.mjs:syncSeedAreas',
            'stores/areaPolicy.mjs:reprobeAutoAreas',
            'stores/sourcePolicy.mjs:freshWindowPatch',
            'stages/collectHelpers.mjs:judgeFromDocs',
        ],
        scan: false,
        scanNote: '未掃:被改寫者其 statusBy 一併被改寫,記錄不留寫入者之沿革,存量無確定性判準;由寫入處之條件保證',
    },
    {
        id: 'CS8',
        title: `領域發現之 AI 輸出合契約(標籤 ${C.labelMin}～${C.labelMax} 字、英文查詢 ${C.queryMinWords}～${C.queryMaxWords} 詞、覆蓋判斷與理由必填)`,
        object: 'areas;領域發現之 AI 輸出',
        kind: 'program+ai',
        v: 1,
        proves: '輸出合契約(程式驗,不合者不落地);覆蓋判斷與新領域之提出以題組逐案驗(AI)',
        notProves: '新領域對知識庫之長期價值(使用者判讀)',
        enforcedAt: [
            'domain/areaDomain.mjs:AREA_CONTRACT',
            'domain/areaDomain.mjs:sanitizeAreaQuery',
            'domain/areaDomain.mjs:createAreaDomain',
            'stages/areaStage.mjs:discover',
        ],
        scan: false,
        scanNote: '未掃:輸出契約於產出當下驗(不合者不落地);AI 之判定以題組逐案評,不在存量掃描',
    },
    {
        id: 'CS9',
        title: '線索格式(型別在清單、值非空、不逾長度上限、site 為 http(s) 網址)',
        object: 'frontier;線索之寫入',
        kind: 'program',
        v: 1,
        proves: '入庫之線索格式合格;不合者不入庫並逐因計數',
        notProves: '線索之品質與可產出性',
        enforcedAt: [
            'core/stores/frontierPolicy.mjs:saveClues',
        ],
        scan: true,
        scanNote: '全部線索以 saveClues 同一判定重驗(唯讀呼叫,不寫入);型別清單與寫入者同一設定',
    },
    {
        id: 'CS10',
        ...docStd('CS10'),
        object: 'docs;全部入口(入庫、轉錄、轉址後網址、feed 退路、正文落盤)與存量 noted',
        kind: 'program',
        proves: '站點正準編號相同、同主機網址代稱相同或段落雜湊重疊之同一內容只入一次',
        notProves: '措辭改寫之轉載;無原文者(未能判定)',
        enforcedAt: [
            'standards/docStandards.mjs:contentKeysOfUrl',
            'stores/contentIndex.mjs:matchSameContent',
            'stores/contentIndex.mjs:sameContentPatch',
            'stores/ingestGate.mjs:markSameContent',
            'stages/detailFetchStage.mjs:mwTranscodeLinks',
            'stages/detailFetchStage.mjs:mwFeedFallback',
            'stages/detailFetchStage.mjs:mwPersistOutcome',
            'stages/docMaintainStage.mjs:mwFillParaKeys',
            'standards/cs10Fix.mjs:applyCs10Fix',
        ],
        scan: true,
        scanNote: 'noted 文件之網址代稱群與段落重疊(依入庫先後逐篇比對;無段落雜湊者以原文補算,原文不可得 → 未能判定)',
    },
    {
        id: 'CS11',
        title: 'site 線索之網址或主機須見於送給 AI 之材料',
        object: 'frontier;site 線索之寫入(寫入者傳入材料才檢)',
        kind: 'program',
        v: 1,
        proves: 'site 線索見於材料(防模型自編網址)',
        notProves: '線索之品質與可產出性;寫入者未傳材料時不檢',
        enforcedAt: [
            'core/stores/frontierPolicy.mjs:saveClues',
        ],
        scan: false,
        scanNote: '未掃:判定所需之材料(當時送給 AI 之內文)未隨線索落庫',
    },
    {
        id: 'CS12',
        ...docStd('CS12'),
        object: 'areas 之標籤(自動領域入庫即轉;種子領域刻意不轉)、frontier 之線索值(keyword／topic;網址不轉)',
        kind: 'program',
        proves: '標籤與線索值為正體(簡體專用字、同形字誤用、誤用詞皆 0;網址不計)',
        notProves: '錯字(錯字仍是正體字);線索之品質與可產出性',
        enforcedAt: [
            'core/stores/frontierPolicy.mjs:saveClues',
            'stages/areaStage.mjs:discover',
            'standards/cs12Fix.mjs:applyCs12Fix',
        ],
        scan: true,
        scanNote: '全部領域標籤(含種子;種子之違反由安裝方改種子)與 pending 線索值(網址不計);語言設定非繁體中文時逐件列不適用(字形政策 appliesTo,core/locale)',
    },
    {
        id: 'CS13',
        title: '終態文件之原文可回溯(先另存並回讀驗證,才自文件清除)',
        object: 'docs;終態(noted／skip／summarize-failed)之原文、內容類 dead 之判定依據(集合 docTexts)',
        kind: 'program',
        v: 1,
        proves: '原文先另存(回讀一致)才自文件清除;未設另存集合時須另存之終態不清;落 raw 即另存',
        notProves: '當時頁面之 HTML 快照(只存解析後之正文;重抓不等於當時快照);feed 與 grid 逾入庫上限之後段',
        enforcedAt: [
            'core/stores/docTexts.mjs:archiveDocText',
            'core/stores/docPolicy.mjs:slimTerminalDocs',
            'stages/docMaintainStage.mjs:mwSlim',
            'stages/detailFetchStage.mjs:mwPersistOutcome',
            'stages/detailFetchStage.mjs:mwFeedFallback',
            'ops/refetchSources.mjs:refetchSources',
        ],
        scan: false,
        scanNote: '未掃:未列入本套件之掃描範圍;可重用之判定函數已有(core/stores/docTexts 之 docTextOf:文件與另存皆無原文即不可回溯),每篇須讀另存並解壓',
    },
    {
        id: 'CS14',
        title: 'PDF 一輪即終態(正文抽取不做)',
        object: 'docs;網址為 PDF 者(路徑 .pdf 結尾或 arXiv /pdf/)',
        kind: 'known-limit',
        v: 1,
        proves: 'PDF 網址不發請求、不佔瀏覽器名額,一輪即終態(deadClass pdf,可回收)',
        notProves: 'PDF 之內容(正文抽取不做)',
        enforcedAt: [
            'stores/fetchPolicy.mjs:isPdfUrl',
            'stores/fetchPolicy.mjs:classifyFetch',
            'stages/detailFetchStage.mjs:mwFetchDetail',
        ],
        scan: false,
        scanNote: '已知限制,不掃',
    },
].map((s) => Object.freeze({
    // 欄序固定(報表與比對之輸出可重現)
    id: s.id, title: s.title, object: s.object, kind: s.kind, v: s.v, proves: s.proves, notProves: s.notProves,
    enforcedAt: Object.freeze([...s.enforcedAt]), scan: s.scan, scanNote: s.scanNote,
})))

export default { CAPTURE_STANDARDS }
