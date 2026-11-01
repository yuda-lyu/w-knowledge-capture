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
