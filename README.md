# w-knowledge-capture
A general-purpose pipeline for capturing knowledge: source polling, full-text fetching, clue expansion and domain discovery.

![language](https://img.shields.io/badge/language-JavaScript-orange.svg) 
[![npm version](http://img.shields.io/npm/v/w-knowledge-capture.svg?style=flat)](https://npmjs.org/package/w-knowledge-capture) 
[![license](https://img.shields.io/npm/l/w-knowledge-capture.svg?style=flat)](https://npmjs.org/package/w-knowledge-capture) 
[![npm download](https://img.shields.io/npm/dt/w-knowledge-capture.svg)](https://npmjs.org/package/w-knowledge-capture) 
[![npm download](https://img.shields.io/npm/dm/w-knowledge-capture.svg)](https://npmjs.org/package/w-knowledge-capture) 
[![jsdelivr download](https://img.shields.io/jsdelivr/npm/hm/w-knowledge-capture.svg)](https://www.jsdelivr.com/package/npm/w-knowledge-capture)

## Documentation
To view documentation or get support, visit [docs](https://yuda-lyu.github.io/w-knowledge-capture/global.html).

## Installation

### Using npm(ES6 module):
```alias
npm i w-knowledge-capture
```

#### Example:
> **Link:** [[dev source code](https://github.com/yuda-lyu/w-knowledge-capture/blob/master/g.mjs)]
```alias
import fs from 'fs'
import WKnowledgeCapture from './src/WKnowledgeCapture.mjs'


let { createKnowledgeCapture } = WKnowledgeCapture


let test = async () => {
    let ms = []

    //workDir, 知識庫根目錄(唯一必填): db/log/state/knowledge/tmp 等皆由此展開
    let workDir = './_test_knowledge_capture'
    fs.rmSync(workDir, { recursive: true, force: true })

    //items與pages, 模擬來源之文章清單與內文頁, 實務上由內建 rss/grid/article 抓取器連網取得
    let items = [
        { url: 'https://example.com/post/black-hole', title: '黑洞吸積盤之輻射機制', time: '2026-09-01', summary: '吸積盤之輻射' },
        { url: 'https://example.com/post/exoplanet', title: '系外行星大氣之光譜分析', time: '2026-09-02', summary: '穿越光譜' },
        { url: 'https://example.com/post/weekly-roundup', title: 'Weekly Roundup 12', time: '2026-09-02', summary: '彙整貼文' },
    ]
    let pages = {
        'https://example.com/post/black-hole': '黑洞吸積盤中的氣體因摩擦而加熱，並以 X 射線輻射出重力位能。觀測者可由光譜線的輪廓推估盤的內緣位置與黑洞自旋。'.repeat(8),
        'https://example.com/post/exoplanet': '行星凌星時，恆星光線穿過行星大氣，不同波長被吸收的程度不同，由穿越光譜即可推估大氣成分與雲層高度。'.repeat(8),
    }

    //fetchers, 以替身置換內建 rss 與 article 抓取器(同 id 置換, 其餘內建抓取器保留), 離線可跑
    let calls = { rss: 0, article: [] }
    let fetchers = [
        {
            id: 'rss',
            kinds: ['rss'],
            fetch: async () => {
                calls.rss++
                return items
            },
        },
        {
            id: 'article',
            role: 'detail',
            match: () => true,
            fetch: async (doc) => {
                calls.article.push(doc.url)
                return { ok: true, text: pages[doc.url], title: doc.title, extra: { method: 'stub', adapterId: '', finalUrl: '' } }
            },
        },
    ]

    //aiAdapter, AI 調度層替身(cfg.aiAdapter 為正當擴充口): 本例停用領域自動發現, 抓取不呼叫 AI, 故一律回失敗
    let aiAdapter = {
        callJson: async () => ({ ok: false, data: null, error: '範例不呼叫 AI', providerId: '', attempts: 0, skipped: false }),
        drainStats: () => '無呼叫',
        aiUsageToday: () => ({ today: '', used: 0, byKey: {} }),
    }

    //flow, 總組裝: 內建設定/資料檢核/去重/LMDB/鎖/日誌/執行摘要走預設, 只置換抓取器與 AI 調度層
    let silent = { info: () => {}, warn: () => {}, error: () => {} }
    let flow = createKnowledgeCapture({
        workDir,
        data: {
            seedSources: [{ kind: 'rss', tier: 1, name: '範例天文部落格', url: 'https://example.com/feed', lang: 'zh' }],
            vocab: { domain: '天文學' }, //主題範圍(選填), 領域發現之提示詞據此限定, 未給即不限主題
        },
        capture: {
            sources: { minIntervalMs: 0 }, //同一來源最短重抓間隔預設 6 小時, 此處設 0 使第二輪即重抓以展示去重
            areas: { perRun: 0 }, //不展開領域之網格來源
            expand: { perRun: 0 }, //不探測線索
            browser: { perRun: 0, hygiene: false, camofox: { enabled: false } }, //不啟動瀏覽器, 不掃描與回收本機行程
            discover: { everyHours: 0 }, //停用領域自動發現(它會呼叫 AI)
        },
        fetchers,
        aiAdapter,
        scheduleLimitMin: 60, //排程執行上限(分鐘), 整輪時間預算與鎖陳舊期限由此推導
        netGuard: null, //不探測本機網路(預設會探測 capture.services 之端點)
        afterRun: false, //無收尾鉤子
        logFactory: () => silent, //靜音日誌(預設每輪寫 log/<day>/<stamp>-run.log)
    })

    //run, 第一輪: 孤兒瀏覽器回收 → 種子同步 → 來源輪抓 → 全文補抓 → 文件維護 → 線索擴充 → 領域清單
    let r1 = await flow.run()
    ms.push({ round1: `ok[${r1.ok}], ` + r1.stages.map((s) => `${s.name}[${s.status}]`).join(', ') })
    for (let s of r1.stages) {
        ms.push({ [s.name]: s.result.summary })
    }

    //stores, 讀回入庫之文件(標題命中預設彙整貼文樣式者放棄抓全文而標 dead, 其餘取得全文標 raw)
    let stores = flow.openStores()
    let docs = await stores.docs.select()
    ms.push({ docs: docs.map((d) => `${d.title}｜${d.status}`).sort() })
    await flow.closeStores(stores)

    //run, 第二輪: 重抓同一來源但文章皆已入庫(去重), 不再補抓全文
    let r2 = await flow.run()
    ms.push({ round2: r2.stages.slice(0, 4).map((s) => `${s.name}: ${s.result.summary}`) })
    ms.push({ calls: { rss: calls.rss, article: calls.article.length } })

    //clear
    fs.rmSync(workDir, { recursive: true, force: true })

    console.log('ms', ms)
    return ms
}
await test()
    .catch((err) => {
        console.log(err)
    })
// => ms [
//   { round1: 'ok[true], 抓取[ok]' },
//   { '抓取': '來源 1 個、新文件 3、素材 2、轉錄 0、放棄 1｜線索消化 0、新來源 0｜失敗 1' },
//   {
//     docs: [ 'Weekly Roundup 12｜dead', '系外行星大氣之光譜分析｜raw', '黑洞吸積盤之輻射機制｜raw' ]
//   },
//   { round2: [ '抓取: 來源 1 個、新文件 0、素材 0、轉錄 0、放棄 0｜線索消化 0、新來源 0' ] },
//   { calls: { rss: 2, article: 2 } }
// ]
```

---

## 概述

通用知識抓取:從 RSS、論文目錄(OpenAlex／arXiv)與網頁持續抓文章,判定正文可用才入庫,交給下游處理;來源與抓取領域可自行擴充。

- **領域中立**:預設不綁任何主題。主題範圍、知識庫稱呼、種子來源、網格主題、網格與探測之領域過濾,全由使用方給。
- **逐層可覆寫**:設定、資料、提示詞、子階段、抓取器、AI 調度層、儲存皆有預設,使用方只給要改的部分。
- **自成一體**:本套件只 import 自己的檔案與 `package.json` 所列套件;原始碼在 `src/`,下文所列檔案路徑(`core/…`、`stages/…`、`createKnowledgeCapture.mjs` 等)皆相對 `src/`(測試輔助件在 `test/tools/`,隨 npm 包發布供下游取用)。

---

## 1. 一輪做什麼

`flow.run()` 依序跑七個子階段(`cfg.stageOpts` 之鍵):

| 子階段 | 鍵 | 做什麼 | 呼叫 AI |
|---|---|---|---|
| 孤兒瀏覽器回收 | `hygiene` | 殺掉父行程已死之自家瀏覽器(預設關,`capture.browser.hygiene`) | 否 |
| 種子同步 | `seedSync` | 種子來源與網格主題寫入 `sources`／`areas`;零產出來源停用、冷卻期滿重探 | 否 |
| 來源輪抓 | `listFetch` | 挑到期來源抓清單(RSS、網格),新項目入 `docs`(`status:'new'`) | 否 |
| 全文補抓 | `detailFetch` | curl 抓全文 → 正文健全閘 → 不合格依原因重試、轉瀏覽器(Playwright／Camofox,子行程)或終態 → `raw` | 否 |
| 文件維護 | `docMaintain` | 存量依現版閘重判、段落雜湊補算、終態原文另存後自文件清除 | 否 |
| 線索擴充 | `expand` | 消化待探索線索:網站 → 探 feed;關鍵詞／主題 → Bing News＋arXiv 查詢;產出夠多才登錄為常設來源 | 否 |
| 領域清單 | `areas` | 自動領域之品質回饋;每 24 小時至多一次以 AI 判斷候選是否為新領域並給英文查詢,經 OpenAlex 驗證才啟用 | 是(席位 `capture.discover.ai`) |

文件狀態:`new`(待補全文)→ `raw`(正文可用,交下游)／`skip`(重複、彙整頁等)／`aggregated`(彙整貼文,外部連結已轉錄成新文件)／`dead`(確定抓不到)。下游處理 `raw` 後改為 `noted`／`skip`／`summarize-failed`。

### 與下游之介面

| 方向 | 內容 |
|---|---|
| 本套件 → 下游 | `docs` 中 `status:'raw'` 之文件(正文在 `text`,取得方式在 `textFrom`);記錄形狀見 `core/util/records.mjs` 之 `docRecord` |
| 下游 → 本套件 | ①文件判定後改 `status`(`noted`／`skip`／`summarize-failed`);②**待探索線索**以 `saveClues(stores.frontier, clues, { fromRef, nowIso })` 寫入(型別 `site`／`keyword`／`topic`);③(選配)筆記集合 `notes`,見 §6 |

**自我擴充之輸入**:本套件**消化**線索(`expand`、`areas`),但不從文章內容產生線索——內建管線中寫入線索者是下游(例如摘要時 AI 列出之相關網站與關鍵詞)。沒有下游、也沒有使用方寫入線索時,擴充只剩種子來源與網格主題,領域發現沒有候選。

---

## 2. 安裝與執行環境

```
npm i w-knowledge-capture
```

依賴套件(`dependencies`,隨本套件一併安裝):opencc-js、w-data-pipeline、w-dispatch-ai、w-dwdata-hub、w-fetch-web、w-orm-lmdb、wsemi。

執行秩序件(執行鎖 `acquireLock`／`inspectLock`、時間預算 `budgetOf`／`reserveOf`／`reserveMsOf`、截止公式 `deadlineMsOf`、落檔日誌 `createLogger`／`createRunLogger`、單行化 `oneline`——w-data-pipeline;AI 目錄展開 `resolveCatalogue`——w-dispatch-ai;時鐘 `genClockTZ`、子行程之 JSON 執行 `execCliJsonFile`、CLI 失敗摘要 `execCliFailDetail`——wsemi)只經 `core/runnerPackage.mjs` 以深層路徑取用,並由本套件主入口以原名轉出——下游套件經本套件取得之件即來源模組之件(同一實體;執行鎖之行程內登記表只有一份,兩份實作會互判殘留而接管)。本套件自身之檔案小工具 `readJson`、`writeFileAtomic`(wsemi `fsWriteTextAtomic` 之拋錯包裝)、`queueAge` 在 `core/util/{fileIo,queueAge}.mjs`,亦由主入口轉出。

| 外部程式 | 用途 | 沒有時 |
|---|---|---|
| curl | 全文補抓之第一層 | 必備 |
| 系統 Chrome | 瀏覽器階梯(Playwright 經 w-fetch-web) | 該方法本輪斷路,可救件延後(不計失敗次數) |
| Camofox(反偵測 Firefox) | 瀏覽器階梯之後段(`capture.browser.camofox.enabled`) | 同上 |
| opencode CLI | 預設 AI 席位(免費模型,免金鑰) | 領域發現失敗,3 小時後再試(不作廢當日窗口);其餘子階段不受影響 |

金鑰(付費或 REST 供應商)放 `<workDir>/.env`(或 `cfg.envFile`),不寫在設定裡。

### OpenAlex API 金鑰與 429

OpenAlex 自 2026 年起,**不帶金鑰之請求共用同一網路 IP 每日 US$0.10 額度**(回應 `meta.notice`),超額回 HTTP 429;免費金鑰(不需付款方式)每日 US$1、UTC 00:00 重置([官方文件](https://help.openalex.org/api/authentication/))。本套件連 OpenAlex 的三處(網格來源、領域發現之驗證、原文回溯之 DOI 批次與題名搜尋)共用同一把金鑰:

- **設定只放環境變數名,值放金鑰檔**:`capture.services.openAlex.apiKeyEnv`(預設 `'OPENALEX_API_KEY'`)所指之變數,自 `cfg.envFile`(預設 `<workDir>/.env`,與 AI 金鑰同一檔)讀入,不污染 `process.env`、不入設定與 `info()`。金鑰檔不存在、檔內無該變數或值為空 → **不帶金鑰,請求與加入金鑰支援前逐字相同**;`apiKeyEnv: ''` 明確不使用(即使檔內有該變數)。
- **帶法**:`api_key=` 查詢參數(官方:與 `Authorization: Bearer` 標頭「Both work identically」;內建抓取函數 `fetchWebByCurl` 不提供自訂標頭,故用查詢參數)。金鑰不入日誌、處置帳、事件、拋出之錯誤與 stderr:請求結果之訊息一律遮罩(wsemi `maskDiagText`),並自行重試以避開 `fetchWebByCurl` 重試時把網址寫到 stderr。已知限制:`curl` 執行期間金鑰在本機行程清單的命令列可見(標頭亦同)。自訂 `fetchWebByCurl`(各階段 `opt` 注入者)收到含金鑰的網址,其記錄須自行遮罩。
- **`netGuard` 本機網路探測不帶金鑰**(只看可達,429 亦算可達)。
- **429 的訊息固定**:`OpenAlex HTTP 429：每日額度用盡或每秒請求超限（每日額度於 UTC 00:00 重置）`(官方:429 有兩因——超出每日額度,或超出每秒上限〔無金鑰 10、有金鑰 30 次/秒〕;後者等一下重試即過)。網格遇 429 仍切 arXiv,另記一行同字樣之警告、來源標 `_oaQuota`、report 的 `detail.gridOaQuota` 計其數;領域驗證遇 429 之 `reason` 為此字樣(暫時性,不冷卻)。
- **原文回溯連續 3 次 429 即停止 OpenAlex 回溯**(DOI 批次與題名搜尋;各次已含一次重試,每秒上限之 429 不會連續三次):回傳 `quotaStop: { after, unprocessed, byMethod, message }` 列明原因與未處理篇數;遭 429 與尚未發出請求者皆**不入處置帳**,額度恢復後不加 `retry` 直接續跑。arXiv 與網頁回溯不受影響;非連續之 429(中間夾其他結果)不停止,該批／篇照舊記 `fetch-failed`(訊息為上列固定字樣)。
- 使用端:`refetchSources(deps, …)` 的金鑰自 `deps.envFile` 讀(傳 `flow.info().envFile`),或直接給 `deps.openAlexAuth`(`createOpenAlexAuth(金鑰)` 之產物)。

---

## 3. 快速開始

```js
import W from 'w-knowledge-capture/src/WKnowledgeCapture.mjs'

const flow = W.createKnowledgeCapture({
    workDir: 'd:/my-kb', //唯一必填
    data: {
        seedSources: [{ kind: 'rss', tier: 1, name: '範例來源', url: 'https://example.com/feed', lang: 'en' }],
        gridTopics: [['圖神經網路', 'graph neural network']], //[標籤, OpenAlex 英文查詢]
        vocab: { kbLabel: '機器學習知識庫', domain: '機器學習' }, //皆選填;未給 domain 即不限主題
    },
    scheduleLimitMin: 60, //每輪時間上限(分),據以推導整輪預算與鎖之陳舊期限
})
const report = await flow.run()
console.log(report.ok, report.summaryFile)
```

`createKnowledgeCapture` 回傳 `{ run, openStores, closeStores, info }`:`run` 跑一輪;`openStores`／`closeStores` 給維運工具開關集合;`info()` 揭露生效之目錄、設定、時鐘、AI 調度層、時間預算與集合名(與管線同一來源)。

**設定錯誤一律在建構期拋錯**:`cfg` 與設定(`ai`、`capture`)之不認得鍵、型別或值域不合、AI 席位引用不存在之條目 id、時區無效、樣式無法編譯——都不會靜默改用預設(訊息含完整路徑,如 `settings.capture.articles.perRun …`)。

---

## 4. 覆寫點一覽

| 層 | cfg 鍵 | 預設 |
|---|---|---|
| 路徑 | `workDir`(必填)、`dirs`(逐鍵:`db`、`log`、`tmp`、`state`、`knowledge`) | `<workDir>/db` 等 |
| 管線名 | `name`(日誌之管道名與執行摘要 `run.json` 之 `name`;非空字串) | `'知識抓取'` |
| 時鐘 | `timeZone`(IANA 時區;日誌時間戳、檔名、「今日」之基準)、`clock`(整組置換) | `'Asia/Taipei'` |
| 語言 | `lang`(BCP 47 代碼;`core/locale.mjs` 之 `resolveLocale`):提示詞之輸出語言句、正體標準 CS12 之適用(只有繁體中文有字形標準——其餘語言掃描逐件列「不適用」、入庫不轉字形)、概念鍵之繁簡折疊(中文才折)、slug 之字元政策(中文收漢字與拉丁,其餘收任何文字)、調度層事件時刻之數字格式。每輪依賴 `deps.locale` 與 `info().locale` 為解析後之 `{ code, label, han, script, slug }`;純函數(如 `saveClues`、`auditCaptureStandards`)收 `locale`,未給即正體 | `'zh-TW'` |
| 設定 | `ai`、`capture`(兩段;組逐層合併,見 §5) | `core/settingsDefault.mjs` |
| 資料 | `data`:`seedSources`、`gridTopics`、`vocab` | 空清單 |
| 提示詞 | `prompts.area`(見 §7) | 內建通用提示詞 |
| 子階段 | `stageOpts.<鍵>`(各子階段之 opt,含動作鏈 `tap`;契約欄位 `enabled:false` 停用、`when(ctx)` 條件執行,每個子階段皆收)或 `stages`(整組自訂,與 `stageOpts` 擇一) | 七個內建子階段 |
| 抓取器 | `fetchers`(同 id 置換、新 id 追加)、`siteAdapters` | rss／grid／article／links／browser |
| AI | `aiAdapter`(整組置換)、`aiOptions`(內建調度層之建構選項:`providerPick`、`exes`、`persistStore`、`usageCounter`)、`envFile`、`aiWorkspace` | 內建調度層(w-dispatch-ai) |
| 儲存 | `lmdb`:`WOrm`、`path`、`db`、`cls`(集合名);`notes`;`dedup` | w-orm-lmdb、`<workDir>/db`、`'knowledge'` |
| 時間與鎖 | `scheduleLimitMin`、`deadlineMs`、`lockStaleMs`、`lock` | 預算 50 分、鎖 `<workDir>/tmp/run.lock` |
| 其他 | `conceptFold`(繁簡折疊:`false` 停用、函數自訂、`true` 內建、未給依 `lang`——中文折、其餘不折)、`netGuard`(本機網路判斷;`null` 不判斷)、`logFactory`、`afterRun`(收尾鉤子) | 內建 |

可用鍵之全集在 `createKnowledgeCapture.mjs` 之 `CFG_KEYS`、`DATA_KEYS`、`PROMPT_KEYS`、`COLLECTION_KEYS`。

**相對路徑之基準各鍵不同**:`envFile` 以 `workDir` 為基準;`lock`(字串)與 `aiWorkspace` 以執行時之 cwd 為基準。要穩定請一律給絕對路徑;`info()` 回報的是解析後之絕對路徑。

---

## 5. 設定(`ai`／`capture`)

設定只有兩段:`ai`(AI 調度層)與 `capture`(抓取,依抓取三要點分組:要點 1 各網站之文章抓取、要點 2 領域清單、要點 3 自動擴展,另有外部服務端點與檢定標準)。

**合併規則**:**組**(物件,如 `capture.articles`、`capture.browser.camofox`)逐鍵遞迴合併——給了的鍵取代預設、其餘沿用;**葉**(席位物件 `capture.discover.ai`、樣式陣列、函數、`ai.providerTimeouts`、`ai.extraProviders`、`ai.pools`、`ai.providerLimits`)整個取代、不逐層合併。完整鍵、型別與註解以 `core/settingsDefault.mjs` 為準(`CAPTURE_DEFAULT`／`CAPTURE_SCHEMA`／`AI_DEFAULT`／`AI_SCHEMA`);下表列常調者(鍵為 `capture.<組>.<鍵>`)。

```js
createKnowledgeCapture({
    workDir,
    capture: {
        articles: { perRun: 40 },                              //只改所給之鍵
        browser: { camofox: { enabled: false } },              //巢狀組逐層合併:其餘 browser 鍵沿用預設
        discover: { ai: { use: 'oc:opencode/big-pickle' } },   //葉(席位)整個取代:不與預設之 fallback 合併
    },
    ai: { cooldownMs: 600000 },
})
```

| 組 | 鍵 | 預設 | 意義 |
|---|---|---|---|
| `sources`(要點 1) | `perRun` | 6 | 每輪輪抓之 rss 等來源數 |
| | `itemsPerSource` | 8 | 每來源最多取用新項目數 |
| | `minIntervalMs`／`listTimeoutMs` | 21600000／120000 | 同一來源最短重抓間隔／list 抓取器逾時 |
| | `concurrency` | 1 | 同時輪抓之來源數(>1 以波次並行;0／1 串行) |
| | `maxConsecFails`／`maxConsecEmpty` | 8／5 | 連敗、自動來源連空即停用(`maxConsecFails:0`＝永不因連敗停用,來源由宿主管理時) |
| | `cullMinJudged`／`lowYieldRate` | 6／0.1 | 零產出淘汰之樣本數／低產出排後門檻 |
| | `reprobeDays`／`reprobePerRun` | 30／3 | 停用來源與暫停之自動領域冷卻重探 |
| `articles`(要點 1) | `perRun` | 27 | 每輪最多補抓幾篇全文;**下游每輪容量須 ≥ 本值＋`browser.perRun`(瀏覽器分流停用即 `browser.perRun:0` 時計 0)＋`areas.perRun × sources.itemsPerSource`**(推導式見 `captureCapacityOf`) |
| | `timeoutMs`／`maxTextChars` | 30000／20000 | 單篇抓取逾時／單篇入庫上限 |
| | `archiveText` | true | 原文另存(CS13);`false` 即不另存、終態瘦身亦不清正文(速報類不需回溯時) |
| | `maxTries` | 3 | 試滿即 `dead` |
| | `retryBackoffHours` | 6 | 暫時性失敗之退避:第 n 次失敗後 `本值×4^(n-1)` 小時內不再取(0＝不退避) |
| | `aggregatorLinksPerDoc` | 12 | 彙整貼文最多轉錄幾條外部連結 |
| | `skipTitlePatterns` | 通用彙整頁標題樣式 | 標題確定為例行彙整頁者不補全文、改走連結轉錄;`RegExp` 或 `{ p, f }` 之陣列,**給了即整份取代預設** |
| `browser`(要點 1) | `perRun`／`maxMs` | 6／240000 | 每輪瀏覽器篇數與時間上限(`perRun:0` 停用瀏覽器) |
| | `navTimeoutMs` | 20000 | Playwright 導航逾時 |
| | `camofox.enabled`／`camofox.port` | true／19417 | 階梯是否含 Camofox／其埠(同機有其他 w-fetch-web 使用者時埠須錯開) |
| | `hygiene` | false | 孤兒瀏覽器回收(會掃整台機器之行程) |
| `network`(要點 1) | `probeUrls`／`probeTimeoutMs` | `null`／8000 | 本機網路判斷之探測端點(`null`＝取 `services` 三個端點基底之原點;`[]`＝不判斷)／逾時 |
| `areas`(要點 2) | `perRun`／`maxActive` | 3／60 | 每輪網格(領域查詢)來源數(與 `sources.perRun` 分開挑)／啟用中領域上限 |
| | `minFreshRate` | 0.2 | 自動領域之 grid 來源近 5 次新件率低於此即暫停 |
| | `openAlexFields` | `''` | 網格與領域驗證之 OpenAlex field id 白名單(`'17\|26'`);空＝不限 |
| | `arxivCategories` | `[]` | **網格遞補**(OpenAlex 失敗時)查 arXiv 之類別;空＝不限 |
| `expand`(要點 3) | `perRun`／`maxPending` | 12／2000 | 每輪消化線索數／待探索上限 |
| | `arxivCategories` | `[]` | **線索探測**查 arXiv 之類別;空＝不限(與 `areas.arxivCategories` 各自獨立) |
| `discover`(要點 3) | `everyHours` | 24 | 領域發現間隔(0＝停用自動發現) |
| | `newPerDay` | 2 | 每日新增自動領域上限 |
| | `minHits` | 200 | 驗證:OpenAlex 計數下限 |
| | `windowDays`／`minSupport`／`minClueDocs` | 30／20／3 | 候選統計窗(天)／主概念支持數下限／線索提及之相異文件數下限 |
| | `candidatesPerCall`／`rejectCooldownDays` | 8／30 | 每次交 AI 判定之候選數上限／驗證未過之冷卻天數 |
| | `ai` | 見 §8 | 領域發現之席位;`null`＝無席位、不發現(不用 AI 時) |
| `services` | `openAlex.base`／`openAlex.mailto` | 公開服務／`''` | OpenAlex 端點基底與禮貌池信箱(網格、領域驗證、原文回溯共用;`''` 不帶) |
| | `openAlex.apiKeyEnv` | `'OPENALEX_API_KEY'` | OpenAlex API 金鑰之**環境變數名**(非金鑰值;值自 `cfg.envFile` 讀);檔內無該變數或值為空 → 不帶金鑰;`''` 明確不使用。見 §2「OpenAlex API 金鑰與 429」 |
| | `arxiv.base`／`bingNews.base` | 公開服務 | 測試可指向本機假站台 |
| `standards` | `minTextChars`／`minFallbackChars` | 300／300 | 正文最少字數(curl 與瀏覽器同一把尺)／feed 摘要退路之最少字數 |
| | `maxSaneChars` | 300000 | 正文合理上限(逾之判格式雜訊) |
| | `placeholderPatterns`／`paywallPatterns` | `[]` | 健全閘之追加樣式(`RegExp` 或 `{ p, f }`;接在內建偵測器之樣式之後) |
| | `detectors` | `null` | 健全閘之偵測器陣列(有序;`null`＝內建 `GATE_DETECTORS_DEFAULT`;給了即整組取代,見 §9「牆頁與佔位之新判準」) |
| | `sameContent`／`titleMismatch` | true／true | 同一內容判定(CS10)、記錄標題對正文(CS2)之開關;關閉者不判、不算,符合度掃描列為停用 |
| | `healthRecheckPerRun`／`paraKeysPerRun` | 500／2000 | 存量健全閘重判／段落雜湊補算之每輪上限 |
| | `scanEachRun` | false | 每輪結束掃一次可確定性判定之標準,計數入 `run.json`(大庫耗時) |

`ai` 段(與 `capture` 並列,不含席位):

| 鍵 | 預設 | 意義 |
|---|---|---|
| `timeoutMs`／`maxRetries`／`cooldownMs` | 300000／0／900000 | 單次逾時／同家不重試／限流冷卻 |
| `providerTimeouts`／`extraProviders` | `{}`／`[]` | 逐條目逾時／自帶條目(同 id 逐欄覆蓋內建) |
| `pools` | `{}`(不開) | 免費池當日額度:`{ oc: { log: 'auto'｜日誌路徑, resetUtcHour: 0 } }` 即開(見 §8) |
| `healthStreak` | `0`(不開) | 供應商健康降序:連續幾次整組皆敗即降至鏈尾(見 §8) |
| `providerLimits` | `{}`(不剔除) | prompt 長度上限之逐條目覆寫 `{ 條目 id: 字元數 }`(見 §8) |

後三鍵為多角色高頻呼叫而設,預設之值即關閉(抓取每日至多一次 AI 呼叫);降序皆經冷卻機制,`cooldownMs` 為 0 時無降序效果。

`capture.sources` 另有函數鍵 `isAutoSource`、`extraPatchOf`(自動來源判定、網格 cursor 前進;函數為葉,給了即整個取代)。

---

## 6. 資料(`cfg.data`)與儲存

| 鍵 | 形狀 | 說明 |
|---|---|---|
| `seedSources` | `[{ kind:'rss', tier, name, url, lang }]` | 靜態種子;自種子檔移除者暫停(可逆)。每項須含非空 `kind`、`url`(建構期驗) |
| `gridTopics` | `[[標籤, 英文查詢], …]` | 網格主題 → 種子領域與其網格來源(OpenAlex 查詢,失敗遞補 arXiv)。每項須為字串對(建構期驗;寫成字串陣列或物件會拋錯) |
| `vocab` | `{ kbLabel?, domain?, conceptRenames?, conceptAliases? }` | 知識庫稱呼、主題範圍(提示詞注入)、概念改名與別名;其他鍵拋錯 |

**集合**(LMDB,`cfg.lmdb.cls` 可改名;資料形狀與狀態機與既有知識庫相同,共用庫不必遷移):`docs`(文件)、`docTexts`(原文另存)、`sources`(來源)、`frontier`(待探索線索)、`areas`(領域)、`notes`(選配)。

**`cfg.notes`**(預設 `false`):給 `true` 或集合名才開 `notes`。開啟後,領域發現另以筆記之主概念為候選,原文回溯以「被筆記引用者」為對象;未開時兩者只依線索與文件。筆記由下游寫入,本套件只讀其 `docId`、`createdAt`、`title`、`concepts`、`extractedAt`,一律經 `core/stores/noteFields`(`noteConceptsOf`:依序、以概念鍵去重,第一個為主標籤——下游之選題經其抓取埠取同一函數)。

---

## 7. 提示詞

本套件只有一個 AI 角色:**領域發現**。

```js
createKnowledgeCapture({
    workDir,
    prompts: {
        //candidates:[{ label, kind, support, growth, samples }], areas:[{ label, query }]
        //ctx:{ kbLabel, domain, contract, defaultPrompt }(defaultPrompt(candidates, areas)＝內建提示詞,可包裝而不必重寫)
        area: (candidates, areas, ctx) => `你是${ctx.kbLabel}的領域規劃員…（標籤 ${ctx.contract.labelMin}～${ctx.contract.labelMax} 字）`,
    },
})
```

- 覆寫的是「怎麼問」;**輸出驗證不隨覆寫改變**:每項須有 `index`、`covered`、`why`;未涵蓋者另須 `label`(`AREA_CONTRACT.labelMin`～`labelMax` 字)與英文 `query`(`queryMinWords`～`queryMaxWords` 詞)。不合者不落地。
- `AREA_CONTRACT` 為凍結物件,覆寫者據 `ctx.contract` 寫數字,不要另抄。
- 更深的置換:`createAreaDomain({ vocab, buildPrompt })` 產生之物件可經 `stageOpts.areas.domain` 整組換掉。

---

## 8. AI 調度

- **預設席位全為免費模型**:`capture.discover.ai = { use: 'oc:opencode/mimo-v2.6-flash-free', fallback: ['oc:opencode/big-pickle'] }`。付費家請自行加在 `fallback` 尾端(席位為葉,覆寫時整個取代,須連同要保留之 `fallback` 一併給)。免費模型之目錄會隨供應方變動,實際可用之條目以 `opencode models` 之輸出為準。
- **席位不在 `ai` 段**:`ai` 只管調度(逾時、冷卻、自帶條目);席位由呼叫端於 `callJson` 之 `callOpt.spec` 給(領域發現傳 `settings.capture.discover.ai`)。調度層沒有預設席位,未給 `spec` 即回「席位無法解析」。
- 條目 id 只能引用 w-dispatch-ai 內建目錄(`src/providers.mjs`)或 `ai.extraProviders` 所列者;**w-dispatch-ai 升版後若目錄刪了 id,建構期即拋錯**。
- 呼叫量:每 24 小時至多一次(`capture.discover.everyHours`),每次一條遞補鏈。
- 失敗不作廢窗口:`min(發現間隔, 3 小時)` 後再試;不退回關鍵詞抽取。本機網路不通時不算 AI 之失敗。
- **整組置換**:`cfg.aiAdapter` 給一個具 `callJson(prompt, check, { spec, budgetMs?, shouldStop? })` 之物件,回傳 `{ ok, data, error, providerId, attempts, skipped, errors }`;`validateSeats`、`drainStats` 選用。下游總組裝另需其他函數者(如工作流入口之 `getWkf`／`seatSpec`)以 `checkAiAdapter(aiAdapter, { need })`／`buildAiAdapter({ …, need })` 宣告(預設只需 `callJson`,字樣不變);宣告了 `need` 時內建調度層亦須具之(如漏開 `workflow` 即於組裝期拋錯)。
- **安裝端之資產以建構選項給**(`createAiAdapter({ ai, …, providerPick, exes, persistStore, usageCounter })`;不進 `ai` 段之 schema——下游套件恆以席位呼叫,不收供應商池之設定):`providerPick` 為可用池(只展開所列、依序;席位引用未列者啟動期附「未列於 ai.providerPick」)、`exes` 為逐 kind 之 CLI 執行檔路徑、`persistStore`(`{ get, set }`)為游標與冷卻之跨行程持久層、`usageCounter`(`{ onEvent, today }`)為逐日用量——檔名與落點屬安裝端;未給即行程內。`aiUsageToday()` 回今日用量與 `chain`(可用條目依序之「id×金鑰數」)、`providers`(`{ id, kind }`,不帶金鑰)、`skipped`(缺金鑰而停用者);能力預篩後無條目可送之失敗另帶 `oversize: true`。本層為四套件之獨立組裝與下游總組裝共用之唯一實作(下游以 `buildAiAdapter` 建同一實作)。
- **回覆取最後一段合格之 JSON**:`callJson` 把回覆中之完整 JSON 片段由後往前交 `check`,取第一段 `check(d) === true` 者(`pickJsonReply`;`check` 回字串＝不合格之原因,記入 `errors`)。模型先回一段、再寫「更正如下」回完整一段時取後者;前言之括號(「依意見 [3]」)與尾隨說明之小片段由 `check` 篩掉——**故 `check` 須驗到項目之形狀**(只驗「是陣列」會取到尾隨之 `[3]`)。全部不合格即換下一家;多段皆不合格時原因註明段數與末段之原因。`jsonFragmentsOf`／`pickJsonReply` 亦具名匯出,自建調度層可用同一判準。輸出契約為「含固定鍵之物件(可能被包一層)」之多棒工作流,各棒之解析用 `pickKeyedJson(text, keys, accept, { looseParse })`:自每個 `{` 起配對(雙／單引號皆為字串)、只收含任一 `keys` 之物件(其內不另列;不含鍵之外包物件往內找)、JSON 不成時以呼叫端注入之寬鬆解析(如 JSON5 之 `parse`;本套件不依賴之)再試,選取規則與 `pickJsonReply` 同一份(由後往前取第一個 `accept(物件) === true` 者;皆不合格取最後一個含鍵者;無則 `null`);不去 ANSI 與 code fence。
- **高頻呼叫之機制(預設全關,抓取不用;供下游套件如批次摘要開啟)**:未開時行為、結果形狀與錯誤字樣皆與上述相同。
  | 機制 | 開法 | 效果 |
  |---|---|---|
  | 截斷放行與部分接受 | 建構選項 `acceptTruncated: true`;逐次 `callOpt.acceptTruncated` 布林值優先 | REST 截斷(finish_reason=length)交驗證裁決,未閉合之尾段搶救前段完整項目(`salvageTruncatedArray`)而為最後一段,成功帶 `truncated: true`;外包物件之截斷會被救成內層陣列,全有全無之輸出請逐次關閉 |
  | 避開 | `callOpt.avoid: [條目 id]` | 本次不打所列條目;避開後無條目則不避 |
  | 失敗預覽 | 建構選項 `preview: true` | 失敗形狀另帶 `preview`(最後一次失敗嘗試之 stdout 前 120 字;未送出者為 `''`) |
  | 免費池當日額度 | `ai.pools.oc` | opencode 日誌回報當日額度用盡之 opencode 條目降至鏈尾(不移除)至每日重置;本行程見其成交即恢復;`onPool` 每條目一次 |
  | 供應商健康降序 | `ai.healthStreak` 正整數 | 連續 N 次整組皆敗即降至鏈尾、`onHealth` 回呼;回傳另帶 `health`,`drainStats` 與 run.json(`ai.health`)附健康摘要。本套件預設 0＝不開(高頻呼叫之下游總組裝於其 ai 段預設另給) |
  | prompt 長度能力預篩 | `ai.providerLimits`(逐條目上限,恆生效);建構選項 `capability: true` 另計條目與 kind 之固有上限(如 antigravity 30,000 字) | 呼叫前剔除放不下之條目(鏈序不變;全部放不下即失敗不送出);`onOversize` 每條目一次;`validateSeats` 對全鏈皆有上限之席位回警告 |
  | 多棒工作流之呼叫入口 | 建構選項 `workflow: true` | 另回 `getWkf()`(w-dispatch-ai 工作流之 `callAi`／`runFanout`,快取;與 `callJson` 共用游標、冷卻、健康、用量與工作目錄之確保;定義表去掉條目逾時;呼叫端之 `onEvent` 串在本層之後、不取代;整鏈皆敗且本機網路不通者回 `skipped:true, netDown:true`)與 `seatSpec(seat, promptLen)`(依長度預篩遞補鏈〔判準與計帳同 `callJson`〕、全放不下回 `null`;帶席位之 `timeoutMs`〔未給取留存條目之最大〕、`budgetMs`〔未給＝逾時×留存數〕、`minAttemptMs`〔未給者取 min(20 秒, 逾時之一半),同 `callJson`——預算不足 20 秒之席位否則一次都不送出〕) |
- 上表之免費池額度、健康降序、能力預篩開啟時,總組裝把事件各以 WARN 一行寫入當輪日誌(字樣「供應商額度：」「供應商健康：」「供應商能力：」;未開即無;並發時寫入最近開始且仍在執行之輪;注入 `cfg.aiAdapter` 時不接)。前兩者屬常態(已列日誌契約 `CAPTURE_LOG_KNOWN`),逾長剔除須看見故不列。
- 未開免費池額度時:opencode 免費額度用盡,該次呼叫會等滿逾時,之後在同一行程內移到鏈尾(`cooldownMs`)。
- **CLI 讀取哪些檔由 CLI 決定,本層不干預**:CLI 型條目本即開放讀寫(`aiWorkspace` 只把寫入隔離在工作目錄)。例如 opencode 會自工作目錄往上讀 AGENTS.md(無則 CLAUDE.md),並讀 `~/.claude/CLAUDE.md`——工作目錄在某專案底下時,模型會帶著那個專案的規則與主題作答(實測)。要量不受其影響之能力(例如通用題組之評分),把 `aiWorkspace`／評分之 `--out` 放在沒有這些檔之目錄樹,或用 REST 條目。條目自帶之 `env`(`ai.extraProviders` 同 id 覆寫)原樣傳給 CLI。

---

## 9. 擴充點

| 要做的事 | 作法 |
|---|---|
| 加一種來源 | `cfg.fetchers` 加 `role:'list'` 之抓取器(`kinds` 宣告來源種類),種子給該 `kind` |
| 某站正文另有取法 | `cfg.siteAdapters`(同 id 置換套件自帶、其餘排前);格式同 w-fetch-web 之站台 adapter,另可帶 `module`(模組規格:`import.meta.url`、絕對路徑或套件名;`export` 指具名匯出)——帶 `module` 者瀏覽器階梯之子行程亦載入,不帶者只作用於主行程之 curl 層 |
| 牆頁、佔位、付費牆之新判準 | `capture.standards.detectors`:有序偵測器陣列,給了即整組取代(含順序);追加寫 `[...GATE_DETECTORS_DEFAULT, mine]`、換掉某一個以 `id` 篩掉內建再放自己的、外部獨立使用即 `import { GATE_DETECTORS_DEFAULT }` 自行組合。偵測器 `{ id, kind(健全閘類別 `GATE_KINDS` 之一,分流依之), adapter?(站台 adapter 之正文亦套), module(自訂者必填:子行程據以載入), export?, sig?(判準簽章,改了即存量依新版重判), test(c, env) → null 或 { hit } }`;`env` 帶正規化之門檻與樣式、該篇之 `text`／`title`／`head`／`len`／`lead(n)`／`mojibake()`／`formatNoise()`。只加字串樣式者仍可用 `placeholderPatterns`／`paywallPatterns` |
| 改某一環之行為 | `cfg.stageOpts.<子階段>.tap`:對動作鏈之錨點 before／after／replace;錨點名列在各 `stages/*.mjs` 檔頭 |
| 新的探測端點 | `stageOpts.expand.tap` 在 `capture.expand.probe`(first 錨點)加一顆候選 |
| 換掉整條管線 | `cfg.stages` 給 `[{ name, run(ctx) }]`(與 `stageOpts` 擇一);可用匯出之子階段工廠自組 |
| 關掉某子階段／條件執行 | `cfg.stageOpts.<子階段>.enabled:false`(report 為 `{ detail:{ disabled:true } }`、記 INFO)、`when(ctx)`(不合者不跑、不入 report);每個子階段皆收(四套件同) |
| 來源沒有網址(自訂抓取器之 API 聚合器) | 種子給 `{ kind, name }` 即可(虛擬來源:身分為 `kind|name:<名稱>`,`url` 為 `''`);`fetchList` 把來源記錄整個交抓取器 |
| 列表完即知新件 | `stageOpts.listFetch.onAdmitted(fresh, { source, ctx })`(每來源入庫後呼叫;拋錯＝該來源之逐來源鏈異常);`stageOpts.listFetch.collectIds:true` → `report.detail.listFetch.newIds` |
| 選完才抓(宿主以標題選文) | `stageOpts.detailFetch.pick(candidates, { ctx, quota, queues })` 回本輪要抓之件(候選已依現行排序;回傳截至 quota、只認候選之成員) |
| 逐篇逾時(依本段可用之剩餘分配) | `stageOpts.detailFetch.timeoutMsOf(doc, { remainingMs, left, index })` 回毫秒(非正整數即用設定值);`remainingMs` 為整輪剩餘扣掉保留給後段之時間(未給保留即整輪剩餘) |
| 保留時間給後段(耗時之子階段少做、不吃進保留) | `stageOpts.<listFetch／detailFetch／docMaintain／expand／areas>.reserveMs`(非負毫秒數或 `(ctx) => 毫秒數`,每輪求值),未給(或 null)取每輪依賴 `deps.reserveMs`,皆未給為 0(只守整輪逾期,行為不變);明給 0 優先於依賴;不合法於建構(opt)或該輪開工時(deps)拋出。保留 > 0 時,開工前與每次取件(並行者每波)前須「整輪剩餘 − 保留 ≥ 一次作業之估計」才開工:輪抓取各到期來源抓取之最壞耗時之最大者(抓取器逾時〔無則 `capture.sources.listTimeoutMs`〕× 嘗試次數 ＋ 重試等待)、補全文取各待抓文件所解析之抓取器之同式最大者(至少 `capture.articles.timeoutMs`;自訂取件 `pick` 於可用已不足一次抓取時略過)、瀏覽器佇列取最長階梯逾時＋60 秒、擴充取一條線索之探測最壞耗時(keyword／topic 54 秒;site 約 4 分)、文件維護取 1 秒(本機逐項作業)、領域發現取發現席位首家之單次逾時(其後逐候選之 OpenAlex 驗證亦每個候選前判);不足即少做,**未處理者原樣留佇列待下輪**(來源之 `lastFetchAt`、文件之 `status`／`fetchTries`、線索之 `status` 皆不動),該段 `report.detail.reserveDeferred` 記因保留而留下輪之件數(領域發現為 `true`;只在確因保留延後時才有此欄),日誌以 INFO 寫明。容量鍵(`perRun` 等)不縮。領域發現另有自有之 25 分鐘下限(整輪剩餘 < 25 分即不發現,不論保留),與保留並存,且 AI 呼叫預算再以「整輪剩餘 − 保留」封頂 |
| 自訂領域驗證(非學術目錄) | `stageOpts.areas.validate(query, ctx, opt)` → `{ ok, reason, transient? }`(取代 OpenAlex);不用 AI 時 `capture.discover.ai: null` |
| 調度層之安裝端資產 | `cfg.aiOptions`:`providerPick`(可用池)、`exes`(逐 kind 之 CLI 路徑)、`persistStore`／`usageCounter`(跨行程之狀態與用量;如 w-dispatch-ai 之 `createFileStore`／`createUsageCounter`) |
| 換儲存 | `cfg.lmdb.WOrm` 給相容之 ORM 建構函數 |
| 收尾通知／巡檢 | `cfg.afterRun({ report, summaryFile, log, deps })`(管線之外、摘要之後;失敗只記 WARN) |

**下游套件共用之件**(與抓取內容無關之機制與多工作同讀之規則;下游知識處理套件經主入口取用,不另寫一份——同名即同義):
- 總組裝共用件 `core/assemblyKit.mjs`:鍵檢核、目錄(`resolveDirsCfg` 之 extra 供下游目錄)、時鐘、提示詞鍵、子階段設定、選開集合、lmdb、管線名(`pipelineNameOf`:`cfg.name` 取代內建名)、日誌、調度層與其事件日誌(所需之函數以 `need` 宣告)、啟動期警告、集合開關、每輪 run、info 共同欄、功能表之必填檢核(`featuresOnOf`／`featureProblemsOf`:同一判定小組之功能共用一句、一次列全)、domain 之注入與合併(`mergeDomains`,只收 opt.domains)、`cfg.data` 之鍵集與解析(`checkDataKeys`／`resolveDataCfg`)、提示詞覆寫與注入 domain 之衝突(`promptDomainConflicts`)——下游以參數帶入自己之鍵集與回呼,本套件之總組裝即以之組成。提示詞覆寫之驗證與套用在 `core/prompts.mjs`(`promptSigText`／`promptSigsProblem`／`promptOverridesOf`／`promptTextOf`;覆寫之末參數 `promptCtxOf(vocab, kbLabel, defaultPrompt)`、可覆寫之 domain 成員 `overridablePrompt(custom, key, builtin, { check, norm, ctxOf })`〔未覆寫即內建本身;覆寫者收正規化之原參數＋ctx,回傳經 check〕、提示詞之鍵 → domain `promptDomainOf({ domain: SIGS })`、某 domain 之覆寫子集 `promptsForDomain`;cfg 層、執行期件、domain 工廠同一份);交執行期生效值之鍵 `RUNTIME_CFG_KEYS`／`runtimeCfgOf`(`core/runtime.mjs`);主入口之合成 `composeNamespaces(name, namespaces)`(`core/util/entry.mjs`:各公開模組之命名空間併為預設匯出物件,同名不同實體即拋——四套件之主入口同一件)。
- 待判登錄 `core/stores/holds.mjs`(四工作同一機制):`holdKey`、`putHold`、`resolveHold`、`waiveHold`、`listHolds`、`overdueHolds`、`requestRetry`、期限 `holdDeadlineOf(nowIso, days)`、重試判定 `retryRequestedOf`／`pipelineDueOf`(以時刻比較),存量之待判件 `holdStockUnfixable`、`closeStockHold`、`rollbackStockHold`、`reopenStockHold`、`stockHoldProblems`。
- 存量處置帳 `core/stores/stockLedger.mjs`(四工作與宿主同一本帳 `STOCK_LEDGER_FILE`):`stockLedgerFileOf`、`stockAtOf`、`parseStockLedger`、`stockLedgerRowsOf`(壞行即拒,`allowBad` 才略過)、`stockLedgerWriter`、`appendRollbackRow`、逐件錯誤列 `stockErrorOf`。
- 符合度掃描之框架 `standards/audit.mjs`:累計器 `createStandardsTally`、總覽之形狀 `standardsScanOf`、計數摘要 `standardsCountsOf`、`AI_ROW_KEYS`。
- 詞彙表解析 `core/vocab/vocabKit.mjs`:`vocabHeadOf`(不認得之鍵與 undefined／null 之政策)、`pickVocabKeys`、`mergeGuideFields`、`renameChainProblems`;抓取共用之鍵與預設 `core/vocab/vocabDefault.mjs`:`CAPTURE_VOCAB_KEYS`(下游以之篩「抓取共用」與「自有」之鍵)、`captureVocabDefaultOf()`(解析後之複本;下游之內建預設詞彙表以此為底,不與本套件之預設共用參照)。
- 值與命令列之小件:`core/util/values.mjs`(`strOf`、`textValueOf`、`strictTextOf`〔只收字串〕、`textListOf`〔文字值之清單:陣列逐項去空、單值成一項〕、`uniq`〔去重保序〕、`jsonClone`〔JSON 深複本〕、`cmp`〔碼元序比較;各套件之排序同一份,不用 localeCompare〕、`given`、`checkKeys`、`unknownKeysProblem`——「不認得之鍵」之訊息只此格式;下游之區域 `str`／`strs`／`uniq`／`clone` 一律取此)、總組裝之每輪依賴欄集 `DEPS_COMMON_KEYS`(`core/assemblyKit.mjs`;與 `info()` 之共同欄同處定義,下游之 `buildDeps` 取之組 deps)、`core/util/cli.mjs`(`isDirectRun`:比對實際路徑,經連結執行亦判得到)、席位表 `seatsFrom`／`seatLabelsFrom`(`core/settingsDefault.mjs`)。
- 子階段扣保留之共用件 `core/util/stageReserve.mjs`:取值器 `stageReserveFnOf`、守門閘 `stageReserveGateOf`(保留為 0 時只守整輪逾期,不探詢剩餘)、一次作業之估計 `stageStepMsOf`／`STAGE_STEP_FLOOR_MS`、一次抓取之最壞耗時 `fetchStepMsOf`、一次 AI 呼叫之估計 `captureCallMsOf`、日誌字樣 `reserveNoteOf`;`src/` 內除守門閘與執行秩序件之單一匯入點外,不直接問整輪預算(`budgetOf`／`ctx.remainingMs`／`ctx.expired`),守門見 `unit-capture-reserve-guard`。另 `fetchers/articleParse.mjs` 匯出 `FEED_PROBE_TIMEOUT_MS`／`FEED_PROBE_MAX_RETRIES`／`FEED_PROBE_MAX_CANDIDATES`(feed 探測之逾時、重試、候選數;擴充子階段據以估計探測最壞耗時,與 `discoverFeed` 同一份)。
- 核心件之通用函數:`reserveOf`(選配段之子預算)、`fromProblems`、`readJson`／`writeFileAtomic`、`slugify`／`slugSuffixOf`／`SLUG_SUFFIX_CHARS`(slug 尾碼格式之單一來源:產生與下游之尾碼容錯同讀)／`cutAtBoundary`、`mergeTaps`、`mergeSettingsGroup`／`cloneSettingsDefault`(與本套件同一設定合併規則)、`conceptFoldsOf`／`applyConceptFold`／`captureIdentityOf`／`captureNetGuardOf`(與抓取同一折疊、去重身分、網路判斷)、`expandDirs` 之 extra、`textFromLabelOf`(文件內文取得方式之顯示名)、下游筆記欄位之讀取 `core/stores/noteFields.mjs`(`noteConsumedOf` 等)。
- 日誌契約之核心字樣 `CORE_LOG_KNOWN`／`CORE_LOG_MUST_SEE`(每輪序列、AI 調度層之事件、網路判斷所發;下游之契約以之組成)與報告鍵 `CAPTURE_REPORT_KEYS`(段名與子階段鍵)。
- 評分核心 `bench/benchKit.mjs`(見 §13;項編號由核心於分頁後給定——`promptOf`／`check` 之 ctx 帶 `base`〔該頁首案之項編號減一〕、`check` 另帶該頁之 `domain`、`verdictOf` 之 at 帶 `seq`〔跨頁連續、1 起〕與 `base`〔該頁之基數;頁內重起之角色以 seq − base 取頁內序〕,票類角色以之作答與取票;角色作者之共用小件 typeName、chunk、groupBy、vocabKeyOf、`paginateByVocab`〔同詞彙分組後每頁 N 案之分頁骨架〕、inputVocabProblemsOf、domainNeedsOf、noVerdict、benchPintOf、batchOption、缺票之原因 `benchVoteMissingOf`;自訂 `call` 之角色以調度層之 `callJsonShapeOf(r, rejects)`(`core/ai/adapter.mjs`)把工作流入口之結果轉成 `callJson` 之形狀——嘗試數與失敗摘要之規則與 `callJson` 同一份;評比表 `mergeBenchBoard` 原子寫、角色列碼元序,逐回進度檔走 `core/util/jsonl.mjs`)與多角色命令列 `bench/benchRoles.mjs`(`defineBenchRoles` 之 `run(roleId, opt)`／`plan(roleId, opt)`:下游之單角色執行器只委派)。
- 測試之共用件(`test/tools/`;下游之測試經各自之 `test/tools/captureForTest.mjs` 取用,發布之 tarball 須含之;橋接所轉出之每一名皆須有測試取用——宿主之守門守之):`domainTerms`(領域中立詞表)、`memStore`、`nullLogger`、`testKit`(日誌之替身、暫存根之工廠、子階段 report 與整輪斷言、集合之開關、拋錯之訊息、延遲、可控截止之 ctx、AI 調度層之替身與手寫替身之 check 包裝 `withCheck`、設定覆寫之深層合併 `deepMerge`、CSV 之解析 `parseCsv`…)、`sourceScan`(詞法器與原始檔之走訪 `sourceFilesOf`)、`fakeRest`(假 OpenAI 相容伺服器)、`promptGolden`(提示詞標準檔之比對 `goldenDiffOf` 與重產)、`historyMarks`(舊名、沿革與面向使用者字樣之判準;題組檔之說明文字 `benchCaseNotesOf`——沿革守門只掃題組之 note 與各案 why,材料不掃)。

---

## 10. 執行輸出

| 檔案 | 內容 |
|---|---|
| `<log>/<日>/<時間戳>-run.start.json` | 開工標記(本輪上限之宣告);被砍的輪次沒有 run.json,外部巡檢靠它判界。**取鎖之前寫入**:上一輪仍持鎖而本輪略過時,同樣只有開工標記、沒有 run.json(`run()` 回傳 `lockSkipped:true`) |
| `<log>/<日>/<時間戳>-run.log` | 本輪日誌 |
| `<log>/<日>/<時間戳>-run.json` | 結構化摘要(各子階段報告、AI 實績 `ai.callStats`、`standards` 計數) |
| `<knowledge>/areas.md` | 領域清單之投影(狀態、產出率、新件率、已拒候選) |
| `<state>/refetch-sources.jsonl` | 原文回溯之帳(`refetchSources`) |

---

## 11. 維運 API

皆為具名匯出,唯讀者可直接對正式庫跑;**寫入者由呼叫端負責取執行鎖、備份與同意**。

| 函數 | 寫入 | 做什麼 |
|---|---|---|
| `auditCaptureStandards({ stores, settings }, opt)` | 否 | 依現行判定掃存量,逐標準列合格／違反／未能判定之件;`stores.holds`(使用者豁免,選配,需自行開啟)可豁免 CS1a、CS2、CS10(登錄物件 `doc`)與 CS12(登錄物件 `CS12_HOLD_OBJECT`)之個案 |
| `rejectListOf(stores, opt)` | 否 | 剔除清單(依物件、狀態、類別、主機、時間篩選)與待辦總表;`rowsToCsv`／`rowsToMd` 轉出 |
| `planCs10Fix` → `applyCs10Fix` → `verifyCs10Chain` → `rollbackCs10Fix` | apply／rollback | 同一內容重複入庫之存量處置:預演 → 套用(逐件記帳於存量處置帳 `STOCK_LEDGER_FILE`;失敗之件逐件隔離、記 `stockErrorOf` 之列)→ 連鎖斷言 → 依帳回退(讀帳遇無法解析之列即拒,`allowBad` 才略過;回退＝撤銷該次處置之效果:逐欄三態 `rollbackPlanOf`——現值＝處置後者寫回、已回到處置前者為已完成、其後被改動或文件已不在者報 `conflicts` 不覆寫,`acceptCurrent` 記取代列;處置前不存在之鍵刪除);只改文件,筆記之處置回傳 `notesToHandle` 由呼叫端做 |
| `planCs12Fix` → `applyCs12Fix` → `verifyCs12Chain` → `rollbackCs12Fix` | apply／rollback | 領域標籤與線索值轉正體之存量處置(同上之帳、斷言與回退);種子領域、轉換後仍違反、轉換會改變線索鍵者列 `unfixable` 不寫——開 `holds` 時由套用自行登錄待判(負責者使用者),已不再違反之未結登錄由預演列 `resolvable`、套用結案 |
| `reviveDeadDocs(stores, { match, nowIso, dryRun, fetchTries, patchOf })` | 是(dryRun 否) | 抓取能力升級後把 `dead` 放回佇列;`deadMatcher` 組篩選 |
| `refetchSources(deps, { apply, limit, methods, retry })` | apply 時 | 已消化而無原文之文件,以 arXiv／OpenAlex／原網址回溯正文並另存;OpenAlex 金鑰取自 `deps.envFile`(或 `deps.openAlexAuth`);OpenAlex 連續 3 次 429 即停止 OpenAlex 回溯(`quotaStop` 列未處理篇數,未入處置帳,可直接續跑) |
| `sweepOrphanBrowsers` | 殺行程 | 孤兒瀏覽器回收(同 `hygiene` 子階段) |

---

## 12. 檢定標準

`CAPTURE_STANDARDS`(`standards/registry.mjs`)一條一列:對象、判定類別、能證明／不能證明、執行處(`檔案:函數`)、是否可存量掃描。

| id | 標準 | 類別 | 存量掃描 |
|---|---|---|---|
| CS1a～e | 正文健全(一般閘;站台 adapter、feed 退路、網格摘要、自訂抓取器各有入口判準) | 程式 | CS1a(b～e 之存量併入 CS1a) |
| CS2 | 標題與正文確定不符(錯頁)者不入庫 | 程式 | 是 |
| CS3 | 失敗分流:決定性一輪終態、暫時性退避重試、需渲染轉瀏覽器;本機斷網不計次 | 程式 | 否 |
| CS4 | 正規化網址只入庫一次 | 程式 | 否(身分即網址雜湊) |
| CS5 | 來源健康:連敗、連空、零產出停用;冷卻重探開新觀察窗 | 程式 | 是(記錄形狀;啟用者之連敗／連空／零產出與寫入同一判定) |
| CS6 | 自動領域經驗證才啟用;被拒者冷卻 | 程式 | 否 |
| CS7 | 手動狀態不被自動改寫 | 程式 | 否 |
| CS8 | 領域發現之 AI 輸出合契約;判斷品質以題組評 | 程式＋AI | 否(見 §13) |
| CS9 | 線索格式 | 程式 | 是 |
| CS10 | 同一內容(正準編號、網址代稱、段落重疊)只入一次 | 程式 | 是(存量處置見 §11) |
| CS11 | site 線索須見於送給 AI 之材料 | 程式 | 否 |
| CS12 | 領域標籤與線索值為正體 | 程式 | 是 |
| CS13 | 終態原文先另存並回讀驗證才清除 | 程式 | 否 |
| CS14 | PDF 一輪即終態(已知限制) | 已知限制 | 否 |

CS2、CS10 與 CS13 之另存可以設定關閉(`capture.standards.titleMismatch`、`capture.standards.sameContent`、`capture.articles.archiveText`;零件庫用法,見 §5):關閉者不判、不算,符合度掃描之該列記 `disabled:true`、總量 0(不報合格),`run.json` 之計數摘要同附 `disabled`。

---

## 13. 免費 AI 能力評分(角色化核心;內建角色:領域發現)

**角色化核心** `bench/benchKit.mjs`:`defineBenchRole`(角色定義:題組驗證、分頁、提示詞〔以正式 domain 組〕、逐次呼叫選項 `callOpt`〔與正式呼叫同一組,如陣列輸出之 `acceptTruncated`〕、選用之自訂呼叫 `call(adapter, prompt, { spec, check, callOpt, onEvent })`〔正式管線不經 `callJson` 者,如經工作流入口 `getWkf().callAi` 以各棒之解析器呼叫;回傳 `callJson` 結果之形狀,其後之判定同一套;給了 `call` 之角色只要求調度層為物件,命令列之內建調度層另開 `workflow`〕、逐案類別)、`runBench`、`planBench`(只備題、不呼叫 AI)、`runBenchCli`;逐案判準、停測、報表與評比表由核心統一。下游套件於其上定義自己之角色,共用同一判準;不同角色之列並存於同一評比表。**多角色之命令列** `bench/benchRoles.mjs`:`defineBenchRoles({ roles, pickVocab, pickName, vocabPrefix })` 回 `{ roleOf, parseArgs, usage, runCli }`——`--role <角色|all>` 之解析與限制(all 不可給 `--cases` 與角色專屬參數)、`--vocab-pick`(多段共用之詞彙表以 `pickVocab` 取本套件之鍵,子集檔 `<vocabPrefix>-vocab-<時間戳>.json` 寫入 `--out`)、全部角色之準備期(任何呼叫與寫檔之前)、前面角色已停測之模型不再於後續角色受測;下游套件之 `bench/cli.mjs` 皆經之(規則只此一份)。本套件內建之角色為**領域發現**(`areaBenchRole`;`runAreaBench` 等為其包裝)。

領域發現量的是 CS8 之 AI 部分:模型能否正確判斷「候選已被既有領域涵蓋／是新領域」,並給出合契約之標籤與查詢。與 `areas` 子階段**同一提示詞、同一輸出契約**;席位只放受測模型、不遞補。

```
node src/bench/cli.mjs [--models <id,…>|free] [--cases <題組 json>] [--vocab <詞彙 json>] [--runs 2] [--out <目錄>] [--env <金鑰檔>] [--timeout <毫秒>] [--concurrency <n>] [--tz <IANA 時區>] [--board <評比表 csv>]
```

- `--vocab`:詞彙物件之 JSON 檔,經角色之 `domainOf` 建 domain(題組中自帶 `input.vocab` 之案仍用其自帶者;不認得之鍵拒收)——讓安裝方以自己的詞彙與正式提示詞跑自己的題組。程式呼叫:`runAreaBench({ vocab })`(與 `domain` 擇一)。

**評比表 `模型評比.csv`**(套件根):各免費模型於本評分之現況總表(一角色一模型一列)。由 `--board 模型評比.csv` 產生與更新:本次結果覆蓋**同角色同模型**之舊列、其餘保留;**停測或有未呼叫回合者不寫入**(分數不完整,例如撞當日額度)。欄位含「AI 工作目錄」——CLI 型模型會讀該目錄上層之指示檔(§8),同一模型在不同目錄下之分數可不同。現附之表係於宿主專案目錄下所跑(宿主之指示檔被 CLI 讀入;各列之目錄見該欄)。程式呼叫:`mergeBenchBoard(file, result, { role, workspace })`(領域發現另有 `mergeAreaBenchBoard(file, result, { workspace })`)。

時區(評分時間與報表檔名之時間戳)預設 `Asia/Taipei`,`--tz` 或 `runAreaBench({ timeZone })` 可改;管線之時區同理由 `cfg.timeZone`／`cfg.clock` 指定。

- **受測名單**:未給或 `free` ＝ `DEFAULT_FREE_MODELS`(w-dispatch-ai 目錄中 id 或 model 含 free 者,加定價為免費之 big-pickle,排除決策模型與走付費訂閱額度者〔`ocgo:` OpenCode Go 月費訂閱:名稱雖帶 free,仍須持已訂閱之金鑰,不是匿名免費池〕)。`freeModelsOf()` 由目錄重算;w-dispatch-ai 升版後名單有變,單元測試會失敗提醒。要評比訂閱類條目,以 `--models` 明列其 id。
- **題組**:未給 ＝ `bench/cases/area-generic.json`(通用 16 案,含保留題 5 案;題型:下位概念、同義、過寬、過窄、範圍外、新領域)。格式 `{ std, v, note, cases:[{ id, holdout, type?, input:{ candidate, areas, vocab? }, expect:{ covered }, why }] }`,於任何呼叫之前驗完;題組宣告之 std／v 須為 CS8／1。
- **計分**:每案呼叫 `runs` 回,**各回之類別皆等於應然才算通過**(一回不符即不通過,不以比率放行);保留題分列。合契約率、平均耗時、呼叫失敗只列資訊。
- **停測**:判為額度用盡或限流即停測該模型;連續 2 回逾時或執行錯誤亦停(opencode 限流時不結束、以逾時回報)。其他模型照跑。
- **報表**:`<out>/area-bench-<時間戳>` 之逐模型 CSV、逐案 CSV、Markdown(分數表、逐案明細、未通過原因)、JSON;逐回進度另寫 `.progress.jsonl`(中途被終止也留得下)。預設 `--out ./bench-out`(cwd)。單次報表在 `--out`;跨次之現況總表在 `--board`(上述評比表)。
- **程式呼叫**:`runAreaBench({ models, cases, runs, aiAdapter | adapterOf, domain | domainOf, ... })`。**正式管線覆寫了提示詞者**,評分時一併給 `domain`／`domainOf`,才是量正式提示詞。
- **分數會浮動**:每案只跑 `runs` 回,同一模型兩次評分可差 1～2 案;據以換席位前,宜加大 `--runs` 或重跑一次確認。
- **免費額度**:opencode 免費模型有每日額度(實測於 UTC 0 時重置)。一次全量(8 模型 × 16 案 × 2 回)約 256 次呼叫;同日再跑會撞額度——CLI 不結束、以逾時回報,評分以「連續 2 回失敗停測」收場,該模型之分數無效,須隔日重跑。

---

## 14. 測試

在套件根執行(`package.json` 之測試指令只有 `test`;另有文件發布用之 `deploy`):

```
npm test                                                        # mocha --parallel "test/*.test.mjs" --timeout 180000
node <mocha 路徑>/bin/mocha.js --timeout 180000 test/<檔名>      # 單檔
```

| 層 | 檔案 | 內容 |
|---|---|---|
| 核心 | `unit-core`、`unit-core-text`、`unit-core-layers`、`unit-core-shared` | 管線秩序、執行期生效值、文字正規化、下游筆記欄位之宣告與主標籤、核心件之分層;下游共用之通用函數與共用判準、檔案小工具(readJson、writeFileAtomic、queueAge;鎖、時鐘、日誌、時間預算之行為案在其來源套件) |
| 設定與組裝 | `unit-settings`、`unit-assembly`、`unit-assembly-kit`、`unit-entry`、`unit-package`、`unit-domain-terms` | 每個設定鍵逐鍵覆寫與拒收、`cfg` 各鍵檢核、總組裝共用件、入口匯出、**套件邊界(不 import 套件外)、發布面(不設 `exports`／`files` 使深層路徑可取用、無 `.npmignore` 而發布範圍依 `.gitignore`、`npm pack --dry-run` 清單含 `sgud/` 與 `test/tools/` 而不含 `CLAUDE*.md`、根目錄範本檔、`LICENSE`)與發布內容不帶宿主之痕跡(磁碟機絕對路徑、使用者目錄)、預設領域中立(詞表 `test/tools/domainTerms` 為四套件同一份,下游之測試經其 `captureForTest` 取用;自檢 `unit-domain-terms`)、舊名、沿革與面向使用者之字樣(判準 `test/tools/historyMarks`,四套件同一份;不以名指下游之工作)、下游筆記欄位只經 `core/stores/noteFields` 讀、覆寫生效** |
| 待判與存量帳 | `unit-holds`、`unit-stock-ledger`、`unit-cs12fix` | 待判之登錄、期限、重試判定與存量待判件;存量處置帳之讀寫協定(壞行即拒、回退列、逐件錯誤列);CS12 之預演／套用／斷言／回退 |
| AI 調度 | `unit-ai-adapter`、`unit-ai-adapter-ext` | 遞補、驗證、限流冷卻、逾時三層、金鑰來源、斷網不計(本機假 REST);CLI 子行程之環境本層不干預(node 假 CLI);高頻呼叫之機制(截斷放行、避開、預覽、免費池、健康降序、能力預篩)與預設關閉 |
| 抓取器與政策 | `unit-fetchers`、`unit-siteAdapters`、`unit-capture-fetch-checks`、`unit-capture-policies`、`unit-capture-browser`、`unit-capture-netguard` | 抓取器契約、站台 adapter、健全閘、分流、瀏覽器階梯、本機網路判斷 |
| 子階段 | `unit-capture-stages`、`unit-capture-object`、`unit-capture-ops`、`unit-capture-areas`、`unit-capture-refetch`、`unit-capture-fix`、`unit-capture-reserve`、`unit-capture-reserve-gate`、`unit-capture-reserve-guard` | 扣保留給後段之時間(五個耗時段:開工前與每次取件前之門檻、少做而未處理者留佇列、保留未給行為不變、邊界與不誤報;共用守門閘與估計;守護子階段不直接問整輪預算)、七個子階段與動作鏈、領域發現(提示詞覆寫、筆記可缺、席位)、原文回溯、存量處置 |
| 標準與剔除 | `unit-capture-standards`、`unit-cs10fix`、`unit-rejects` | 各標準之判定、存量掃描(唯讀)、CS10 預演／套用／斷言／回退、剔除清單 |
| 評分 | `unit-bench`、`unit-bench-kit` | 評分器之判準、停測、報表、題組驗證、免費名單與目錄之漂移;角色化核心(分頁、多角色評比表、`--vocab`) |
| 整合 | `unit-flow-capture`、`unit-flow-areas` | 本機假站台上跑完整一輪(含**系統 Chrome** 救回 JS 頁、403、亂碼頁)與領域流程 |
| 實網 | `api-capture-live` | `WK_LIVE_NET=1` 才跑:真網址題組(預設 `test/fixtures/capture-live-generic.json`,`WK_LIVE_FIXTURE` 可換);確定性之案逐案斷言,站方相依之案只斷言分流不變式 |
| 真 AI | `api-area-ai` | `WK_LIVE_AI=1` 才跑:預設席位跑通用題組(`WK_AREA_MODELS` 換模型、`WK_ENV_FILE` 給金鑰) |

- **固定埠**(≥8000、不隨機):8821、8824～8828、8831 為本機假伺服器,8830 為無人監聽之死埠,19437 為實網測試之 Camofox。
- **暫存**:各測試自建 `test/_tmp/<名>-<pid>`,測完刪除(`test/_tmp/` 已列 .gitignore)。
- **整合測試需要系統 Chrome**;沒有時相關案明確失敗並說明,不靜默略過。
- **已知缺陷**以 `it.skip('[已知缺陷] …')` 保留其應然斷言(修正後解除即成回歸測試)。

---

## 15. 收斂到特定主題

套件預設不限主題;要專注某一領域,只給資料與過濾,不改程式。以天文學知識庫為例:

```js
createKnowledgeCapture({
    workDir: 'd:/astro-kb',
    data: {
        vocab: { kbLabel: '天文學知識庫', domain: '天文學' },         //提示詞之稱呼與主題範圍句(範圍外之候選判已涵蓋)
        seedSources: [{ kind: 'rss', tier: 1, name: 'arXiv astro-ph', url: 'https://rss.arxiv.org/rss/astro-ph', lang: 'en' }],
        gridTopics: [['系外行星', 'exoplanet detection'], ['重力波', 'gravitational waves']],
    },
    capture: {
        areas: {
            openAlexFields: '31',                                      //網格與領域驗證:OpenAlex field id 白名單(31＝Physics and Astronomy)
            arxivCategories: ['astro-ph.EP', 'astro-ph.HE'],           //網格遞補之 arXiv 類別
        },
        expand: { arxivCategories: ['astro-ph.EP', 'astro-ph.HE'] },   //線索探測之 arXiv 類別(與網格遞補各自設定)
    },
    prompts: { area: myAreaPrompt },                                   //選填:整份改寫領域發現之提示詞(輸出契約不變)
})
```

**接上既有知識庫**(與其他管線共用 LMDB):`lmdb.db`／`lmdb.cls` 對齊既有之庫名與集合名(`cls` 只收本套件之集合);既有庫有筆記集合者給 `notes: true`,領域發現與原文回溯即與原管線同口徑。

**整合進多工作專案**(專案之設定檔頂層有 `ai`、`capture` 等段,各工作各佔一段):專案之 `capture` 段與本套件之 `capture` 同形狀,原樣傳入 `cfg.capture` 即可,只列要覆寫之鍵;`ai` 段只挑本套件認得之鍵(`AI_SCHEMA`:`timeoutMs`、`maxRetries`、`cooldownMs`、`providerTimeouts`、`extraProviders`、`pools`、`healthStreak`、`providerLimits`)傳入——專案之其他 AI 鍵(如併發、可用池)會被拒收;可用池與 CLI 路徑等安裝端資產改經 `cfg.aiOptions` 給;`cfg.data` 只收 `seedSources`、`gridTopics`、`vocab`。領域發現之席位在 `capture.discover.ai`,與專案其他工作之席位各自獨立。

**單輪速報之零件庫用法**(宿主只要「列表 → 自己選文 → 抓全文 → 拿到新件」,不要領域、線索與回溯):關掉用不到的子階段、把選文與回傳交給鉤子,其餘機制(來源輪抓、去重入庫、正文健全閘、瀏覽器分流、失敗分流)照用。

```js
const flow = createKnowledgeCapture({
    workDir: 'd:/daily-brief',
    data: { seedSources: [{ kind: 'rss', tier: 1, name: '某通訊社', url: 'https://example.com/rss' }, { kind: 'my-api', name: '聚合器 API' }] },   //第二個為虛擬來源:無 url、以名稱為身分
    fetchers: [myApiListFetcher],                                      //自訂抓取器(role:'list',kinds:['my-api'])
    capture: {
        sources: { concurrency: 4, maxConsecFails: 0 },                //並行輪抓;來源由宿主管理、永不自動停用
        articles: { perRun: 20, archiveText: false },                  //不另存原文
        standards: { sameContent: false, titleMismatch: false },       //速報不判同一內容與錯頁
        discover: { ai: null },                                        //不用 AI(領域發現不跑)
    },
    stageOpts: {
        seedSync: { enabled: true },
        listFetch: { collectIds: true, onAdmitted: async (fresh, { source }) => notify(source.name, fresh) },
        detailFetch: {
            pick: async (candidates, { quota }) => (await rankByTitle(candidates)).slice(0, quota),   //選完才抓
            timeoutMsOf: (doc, { remainingMs, left }) => Math.min(30_000, Math.floor(remainingMs / (left + 1))),
        },
        docMaintain: { enabled: false }, expand: { enabled: false }, areas: { enabled: false },
    },
})
const report = await flow.run()
const newIds = report.stages[0].result.detail.listFetch.detail.newIds   //本輪新入庫之文件 id(停用之子階段 report 為 { detail:{ disabled:true } })
```

---

## 16. 已知限制

- **線索不由本套件產生**(§1):單獨使用時沒有自我擴充之輸入。
- **PDF 不抽正文**(CS14)。
- 站台 adapter 與健全閘偵測器以函數注入,而瀏覽器階梯於子行程執行(函數無法序列化):帶 `module` 者子行程依規格載入,不帶 `module` 之 adapter 只作用於主行程之 curl 層(子行程只有 w-fetch-web 內建清單與本套件自帶清單);不帶 `module` 之自訂偵測器於啟動期拒絕(兩層之閘須一致)。
- 調度層之免費池額度、健康降序、prompt 長度預篩預設皆關,須安裝方開啟(開啟後之事件寫入當輪日誌,見 §8)。
- CLI 型模型會讀入工作目錄上層與家目錄之指示檔(由 CLI 決定,§8);評分結果因而與執行之目錄有關。
- **內建提示詞、日誌、錯誤訊息與文件為繁體中文**;`lang` 只換輸出語言句、字形政策、折疊與 slug 政策,不翻譯提示詞本體(整份提示詞可經 `cfg.prompts` 覆寫)。字形標準只有臺灣正體一種(`zh-TW`／`zh-Hant`／`zh-Hant-TW`);其他語言之正體標準列不適用,無對應之字形檢查。
- CS2(錯頁)只以拉丁詞與漢字二字組比對:其他文字系統之標題列不適用(非 0、非合格)。
