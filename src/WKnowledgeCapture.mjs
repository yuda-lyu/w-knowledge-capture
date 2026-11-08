// WKnowledgeCapture.mjs — 主入口:通用知識抓取套件
//
// 安裝即用(僅 workDir 必填);設定、資料、提示詞皆有通用預設,安裝方逐鍵覆寫即可收斂到自己的主題。
// 全部積木具名匯出,並預設匯出同一物件——安裝方依自己的管線自由組裝,不需改套件。
//
// 【匯出單一來源:模組清單】各公開模組於下方各列一次「命名空間匯入＋export *」;預設匯出物件由同一組命名空間合成,
//   具名匯出與預設物件必然同一組名稱(不另手寫名稱清單——三處各寫一份必然漂移)。
// 【名稱衝突即拋】兩模組匯出同名而不同實體時,export * 會靜默剔除該名(以具名匯入取用時才爆),故載入時即檢查並拋錯(合成之規則一份:
//   core/util/entry 之 composeNamespaces;下游套件之主入口經其埠取用同一件)。
// 【不列入者】fetchers/fetch_web_cli.mjs 為瀏覽器階梯之子行程執行檔(載入即執行),不是函式庫模組。

import * as createKnowledgeCaptureNs from './createKnowledgeCapture.mjs'
import * as captureObjectNs from './captureObject.mjs'
// ── 抓取執行期件之組裝(兩個總組裝共用)──
import * as captureRuntimeNs from './captureRuntime.mjs'
// ── 設定預設與 AI 調度 ──
import * as settingsDefaultNs from './core/settingsDefault.mjs'
import * as aiAdapterNs from './core/ai/adapter.mjs'
import * as poolQuotaNs from './core/ai/poolQuota.mjs'
import * as providerHealthNs from './core/ai/providerHealth.mjs'
import * as capabilityNs from './core/ai/capability.mjs'
import * as jsonReplyNs from './core/ai/jsonReply.mjs'
// ── 子階段工廠與 mw 積木 ──
import * as hygieneStageNs from './stages/hygieneStage.mjs'
import * as seedSyncStageNs from './stages/seedSyncStage.mjs'
import * as listFetchStageNs from './stages/listFetchStage.mjs'
import * as detailFetchStageNs from './stages/detailFetchStage.mjs'
import * as docMaintainStageNs from './stages/docMaintainStage.mjs'
import * as expandStageNs from './stages/expandStage.mjs'
import * as areaStageNs from './stages/areaStage.mjs'
import * as collectHelpersNs from './stages/collectHelpers.mjs'
// ── 領域發現之提示詞與輸出契約 ──
import * as areaDomainNs from './domain/areaDomain.mjs'
// ── 生命週期政策與閘門 ──
import * as sourcePolicyNs from './stores/sourcePolicy.mjs'
import * as areaPolicyNs from './stores/areaPolicy.mjs'
import * as contentGateNs from './stores/contentGate.mjs'
import * as healthRecheckNs from './stores/healthRecheck.mjs'
import * as contentIndexNs from './stores/contentIndex.mjs'
import * as fetchPolicyNs from './stores/fetchPolicy.mjs'
import * as ingestGateNs from './stores/ingestGate.mjs'
// ── 抓取器與端點 ──
import * as defaultFetchersNs from './fetchers/defaultFetchers.mjs'
import * as openAlexNetNs from './fetchers/openAlexNet.mjs'
import * as siteAdaptersNs from './fetchers/siteAdapters.mjs'
import * as articleParseNs from './fetchers/articleParse.mjs'
import * as endpointsNs from './fetchers/endpoints.mjs'
import * as browserLadderNs from './fetchers/browserLadder.mjs'
import * as browserFetcherNs from './fetchers/browserFetcher.mjs'
// ── 檢定標準 ──
import * as docStandardsNs from './standards/docStandards.mjs'
import * as registryNs from './standards/registry.mjs'
import * as auditNs from './standards/audit.mjs'
import * as cs10FixNs from './standards/cs10Fix.mjs'
import * as cs12FixNs from './standards/cs12Fix.mjs'
import * as verdictNs from './core/standards/verdict.mjs'
import * as textFormsNs from './core/standards/textForms.mjs'
// ── 語言設定(cfg.lang:輸出語言稱呼、字形政策、折疊方向、slug 政策;四工作同讀)──
import * as localeNs from './core/locale.mjs'
// ── AI 能力評分(角色化核心 benchKit,報表函數經其轉出;多角色之命令列 benchRoles;內建角色:領域發現 areaBench;命令列 bench/cli.mjs 為執行檔不列入)──
import * as benchKitNs from './bench/benchKit.mjs'
import * as benchRolesNs from './bench/benchRoles.mjs'
import * as areaBenchNs from './bench/areaBench.mjs'
import * as promptFpNs from './bench/promptFp.mjs'
// ── 維運(存量處置、原文回溯、剔除清單、孤兒瀏覽器回收、執行摘要、日誌)──
import * as reviveDocsNs from './ops/reviveDocs.mjs'
import * as refetchSourcesNs from './ops/refetchSources.mjs'
import * as docStockFixNs from './ops/docStockFix.mjs'
import * as rejectsNs from './rejects.mjs'
import * as logContractNs from './logContract.mjs'
import * as browserHygieneNs from './core/ops/browserHygiene.mjs'
import * as runSummaryNs from './core/ops/runSummary.mjs'
import * as provenanceNs from './core/ops/provenance.mjs'
// ── 執行秩序件(鎖、時間預算、截止公式、日誌、單行化、AI 目錄展開、時鐘、子行程 JSON 執行、CLI 失敗摘要;取自自有套件,經單一匯入點原名轉出)──
import * as runnerPackageNs from './core/runnerPackage.mjs'
// ── 核心件(管線秩序、路徑、執行期生效值、詞彙、存取政策、工具)──
import * as kernelNs from './core/kernel.mjs'
import * as assemblyKitNs from './core/assemblyKit.mjs'
import * as promptsNs from './core/prompts.mjs'
import * as runtimeNs from './core/runtime.mjs'
import * as dirsNs from './core/dirs.mjs'
import * as vocabDefaultNs from './core/vocab/vocabDefault.mjs'
import * as vocabKitNs from './core/vocab/vocabKit.mjs'
import * as docPolicyNs from './core/stores/docPolicy.mjs'
import * as docTextsNs from './core/stores/docTexts.mjs'
import * as noteFieldsNs from './core/stores/noteFields.mjs'
import * as frontierPolicyNs from './core/stores/frontierPolicy.mjs'
import * as holdsNs from './core/stores/holds.mjs'
import * as stockLedgerNs from './core/stores/stockLedger.mjs'
import * as jsonlNs from './core/util/jsonl.mjs'
import * as fileIoNs from './core/util/fileIo.mjs'
import * as queueAgeNs from './core/util/queueAge.mjs'
import * as netGuardNs from './core/util/netGuard.mjs'
import * as stageReserveNs from './core/util/stageReserve.mjs'
import * as textNs from './core/util/text.mjs'
import * as valuesNs from './core/util/values.mjs'
import * as cliNs from './core/util/cli.mjs'
import * as tableNs from './core/util/table.mjs'
import * as webNs from './core/util/web.mjs'
import * as recordsNs from './core/util/records.mjs'
import * as patternsNs from './core/util/patterns.mjs'
import * as injectablesNs from './core/util/injectables.mjs'
import * as entryNs from './core/util/entry.mjs'
import { composeNamespaces } from './core/util/entry.mjs'

export * from './createKnowledgeCapture.mjs'
export * from './captureObject.mjs'
export * from './captureRuntime.mjs'
export * from './core/settingsDefault.mjs'
export * from './core/ai/adapter.mjs'
export * from './core/ai/poolQuota.mjs'
export * from './core/ai/providerHealth.mjs'
export * from './core/ai/capability.mjs'
export * from './core/ai/jsonReply.mjs'
export * from './stages/hygieneStage.mjs'
export * from './stages/seedSyncStage.mjs'
export * from './stages/listFetchStage.mjs'
export * from './stages/detailFetchStage.mjs'
export * from './stages/docMaintainStage.mjs'
export * from './stages/expandStage.mjs'
export * from './stages/areaStage.mjs'
export * from './stages/collectHelpers.mjs'
export * from './domain/areaDomain.mjs'
export * from './stores/sourcePolicy.mjs'
export * from './stores/areaPolicy.mjs'
export * from './stores/contentGate.mjs'
export * from './stores/healthRecheck.mjs'
export * from './stores/contentIndex.mjs'
export * from './stores/fetchPolicy.mjs'
export * from './stores/ingestGate.mjs'
export * from './fetchers/defaultFetchers.mjs'
export * from './fetchers/openAlexNet.mjs'
export * from './fetchers/siteAdapters.mjs'
export * from './fetchers/articleParse.mjs'
export * from './fetchers/endpoints.mjs'
export * from './fetchers/browserLadder.mjs'
export * from './fetchers/browserFetcher.mjs'
export * from './standards/docStandards.mjs'
export * from './standards/registry.mjs'
export * from './standards/audit.mjs'
export * from './standards/cs10Fix.mjs'
export * from './standards/cs12Fix.mjs'
export * from './core/standards/verdict.mjs'
export * from './core/standards/textForms.mjs'
export * from './core/locale.mjs'
export * from './bench/benchKit.mjs'
export * from './bench/benchRoles.mjs'
export * from './bench/areaBench.mjs'
export * from './bench/promptFp.mjs'
export * from './ops/reviveDocs.mjs'
export * from './ops/refetchSources.mjs'
export * from './ops/docStockFix.mjs'
export * from './rejects.mjs'
export * from './logContract.mjs'
export * from './core/ops/browserHygiene.mjs'
export * from './core/ops/runSummary.mjs'
export * from './core/ops/provenance.mjs'
export * from './core/runnerPackage.mjs'
export * from './core/kernel.mjs'
export * from './core/assemblyKit.mjs'
export * from './core/prompts.mjs'
export * from './core/runtime.mjs'
export * from './core/dirs.mjs'
export * from './core/vocab/vocabDefault.mjs'
export * from './core/vocab/vocabKit.mjs'
export * from './core/stores/docPolicy.mjs'
export * from './core/stores/docTexts.mjs'
export * from './core/stores/noteFields.mjs'
export * from './core/stores/frontierPolicy.mjs'
export * from './core/stores/holds.mjs'
export * from './core/stores/stockLedger.mjs'
export * from './core/util/jsonl.mjs'
export * from './core/util/fileIo.mjs'
export * from './core/util/queueAge.mjs'
export * from './core/util/netGuard.mjs'
export * from './core/util/stageReserve.mjs'
export * from './core/util/text.mjs'
export * from './core/util/values.mjs'
export * from './core/util/cli.mjs'
export * from './core/util/table.mjs'
export * from './core/util/web.mjs'
export * from './core/util/records.mjs'
export * from './core/util/patterns.mjs'
export * from './core/util/injectables.mjs'
export * from './core/util/entry.mjs'

/**
 * 公開模組之命名空間(預設匯出物件之來源;與上方 export * 為同一組模組)
 *
 * @type {Array}
 */
const NAMESPACES = [
    createKnowledgeCaptureNs, captureObjectNs, captureRuntimeNs,
    settingsDefaultNs, aiAdapterNs, poolQuotaNs, providerHealthNs, capabilityNs, jsonReplyNs,
    hygieneStageNs, seedSyncStageNs, listFetchStageNs, detailFetchStageNs, docMaintainStageNs, expandStageNs, areaStageNs, collectHelpersNs,
    areaDomainNs,
    sourcePolicyNs, areaPolicyNs, contentGateNs, healthRecheckNs, contentIndexNs, fetchPolicyNs, ingestGateNs,
    defaultFetchersNs, openAlexNetNs, siteAdaptersNs, articleParseNs, endpointsNs, browserLadderNs, browserFetcherNs,
    docStandardsNs, registryNs, auditNs, cs10FixNs, cs12FixNs, verdictNs, textFormsNs, localeNs,
    benchKitNs, benchRolesNs, areaBenchNs, promptFpNs,
    reviveDocsNs, refetchSourcesNs, docStockFixNs, rejectsNs, logContractNs, browserHygieneNs, runSummaryNs, provenanceNs, runnerPackageNs,
    kernelNs, assemblyKitNs, promptsNs, runtimeNs, dirsNs, vocabDefaultNs, vocabKitNs, docPolicyNs, docTextsNs, noteFieldsNs, frontierPolicyNs, holdsNs, stockLedgerNs, jsonlNs,
    fileIoNs, queueAgeNs, netGuardNs, stageReserveNs, textNs, valuesNs, cliNs, tableNs, webNs, recordsNs, patternsNs, injectablesNs, entryNs,
]

/**
 * 通用知識抓取套件
 *
 * 提供一輪抓取之完整管線(孤兒瀏覽器回收 → 種子同步 → 來源輪抓 → 全文補抓 → 文件維護 → 線索擴充 → 領域清單):
 * ① 安裝即用:createKnowledgeCapture({ workDir }) 零注入即可跑,內建 rss/grid/article/links/browser 抓取器、feed/Bing/arXiv 線索探測、
 *    正文健全閘與瀏覽器分流、領域自動發現(免費 AI 為主之精簡調度層,w-dispatch-ai)
 * ② 逐層可覆寫:cfg 設定逐鍵覆寫、cfg.data 資料、cfg.prompts 提示詞、cfg.stages／stageOpts 子階段與動作鏈 tap、cfg.fetchers 抓取器、cfg.aiAdapter 調度層
 * ③ 領域中立:主題範圍、知識庫稱呼、種子、網格主題與網格／線索之領域過濾皆由安裝方決定
 * ④ 檢定標準:各標準之純函數判定、存量掃描與剔除清單,供測試與維運檢查功能是否正常
 *
 * @returns {Object} 回傳套件物件,含 createKnowledgeCapture、createCaptureObject、子階段工廠(stage*)、mw 積木(mw*)、
 *     設定預設(resolveSettings、*_DEFAULT、*_SCHEMA)、AI 調度(createAiAdapter 等)、生命週期政策與閘門、抓取器與端點、
 *     檢定標準、維運件與核心工具等(與具名匯出同一組)
 * @throws {Error} 兩個公開模組匯出同名而不同實體時於載入期拋出
 * @example
 * import WKnowledgeCapture from 'w-knowledge-capture/src/WKnowledgeCapture.mjs'
 *
 * //零注入:僅 workDir 必填(金鑰放 workDir/.env;預設 AI 席位為免金鑰之免費模型)
 * let flow = WKnowledgeCapture.createKnowledgeCapture({
 *     workDir: './my-kb',
 *     data: {
 *         seedSources: [{ kind: 'rss', tier: 1, name: '範例來源', url: 'https://example.com/feed', lang: 'en' }],
 *         vocab: { domain: '天文學' }, //主題範圍(選填), 未給即不限主題
 *     },
 * })
 * let report = await flow.run() //抓取一輪, 結束後寫 log/<day>/<stamp>-run.json
 * console.log(report.ok)
 */
const WKnowledgeCapture = composeNamespaces('WKnowledgeCapture', NAMESPACES)


export default WKnowledgeCapture
