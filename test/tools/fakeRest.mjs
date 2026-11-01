// fakeRest.mjs — 測試用本機假 OpenAI 相容伺服器＋以真 adapter(core/ai/adapter)／真 w-dispatch-ai 組裝(不呼叫任何真實 AI 或 CLI)
// 共用層,不帶 .test. 中綴。埠由各測試檔自行指定(≥8000、不隨機;mocha --parallel 下不同檔不得共用同一埠)。
// model 名以「情境~延遲毫秒」組成:情境決定回應內容,延遲供時間預算邊界之實跑(如 'area~600' 延遲 600ms 後回領域發現結果)。
// 【各套件同一份】摘要、關聯、提煉之測試經各自之 test/tools/captureForTest.mjs 取用;依提示詞作答之情境以 opt.sceneOf 注入(如依本批之標題逐項作答)。

import fs from 'node:fs'
import http from 'node:http'
import { createAiAdapter } from '../../src/core/ai/adapter.mjs'
import { genClockTZ } from '../../src/core/runnerPackage.mjs'
import { sleep } from './testKit.mjs'

/**
 * 情境表(model 名 `情境~延遲毫秒` 之情境部分 → 回應內容);未列之情境一律回 plain
 *
 * @type {Object}
 */
export const SCENES = {
    // 領域發現之合契約輸出:候選 1 為新領域(標籤 2～16 字、英文查詢 2～6 詞、附理由)
    area: { fr: 'stop', content: JSON.stringify([{ index: 1, covered: false, label: '機器學習公平性', query: 'machine learning fairness', why: '候選高支持且未被既有領域涵蓋' }]) },
    // 領域發現之合契約輸出:候選 1 已被涵蓋
    covered: { fr: 'stop', content: JSON.stringify([{ index: 1, covered: true, why: '已由既有領域涵蓋' }]) },
    // 非 JSON 之純文字回覆
    plain: { fr: 'stop', content: '好的,這是純文字回覆。' },
    // 合 JSON 但形狀不合領域發現契約(缺 covered)
    arr: { fr: 'stop', content: '[{"index":1,"v":"a"}]' },
}

/**
 * 建立請求處理函數
 *
 * @param {Array} hits 輸入命中紀錄陣列(就地 push { model, key, t, len, prompt })
 * @param {Object} scenes 輸入情境表
 * @param {Function} [sceneOf] 輸入依請求作答之情境 (scene, prompt) => { fr, content }|undefined(undefined 者查情境表)
 * @returns {Function} 回傳 (req, res) => void
 */
function makeHandler(hits, scenes, sceneOf) {
    return (req, res) => {
        let buf = ''
        req.on('data', (c) => {
            buf += c
        })
        req.on('end', async () => {
            let body = {}
            try {
                body = JSON.parse(buf)
            }
            catch { /* 非 JSON */ }
            const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
            const model = String(body.model || '')
            const [scene, delay] = model.split('~')
            const content = String(body.messages?.[body.messages.length - 1]?.content || '')
            hits.push({ model, key, t: Date.now(), len: content.length, prompt: content })
            await sleep(Number(delay) || 0)
            if (res.destroyed || res.writableEnded) return
            const sc = (typeof sceneOf === 'function' ? sceneOf(scene, content) : undefined) || scenes[scene] || scenes.plain
            try {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ id: 'fake', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: sc.content }, finish_reason: sc.fr }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
            }
            catch { /* 連線已被中止 */ }
        })
    }
}

/**
 * 啟動假伺服器(固定埠)
 *
 * @param {Object} opt 輸入設定物件
 * @param {Integer} opt.port 輸入固定埠(≥8000 之整數)
 * @param {Object} [opt.scenes] 輸入追加／覆蓋之情境表(同名者取代內建)
 * @param {Function} [opt.sceneOf] 輸入依提示詞作答之情境 (scene, prompt) => { fr, content }|undefined(回 undefined 者查情境表)
 * @returns {Promise} 回傳 Promise，resolve 回傳 { port, base(含 /v1 之基底網址), hits(命中紀錄 { model, key, t, len, prompt },就地增長), close() }
 * @throws {Error} 埠不合規或無法監聽(被占用)時拋出
 */
export async function startServer(opt = {}) {
    const { port, scenes, sceneOf } = opt || {}
    if (!Number.isInteger(port) || port < 8000) {
        throw new Error('startServer 需要 opt.port(≥8000 之整數;固定埠,不隨機)')
    }
    const hits = []
    const server = http.createServer(makeHandler(hits, { ...SCENES, ...(scenes || {}) }, sceneOf))
    await new Promise((resolve, reject) => {
        server.once('error', (e) => reject(new Error(`假伺服器無法監聽固定埠 ${port}(${e.code || e.message}):請確認無其他行程佔用`)))
        server.listen(port, '127.0.0.1', resolve)
    })
    return {
        port,
        base: `http://127.0.0.1:${port}/v1`,
        hits,
        close: async () => {
            server.closeAllConnections?.()
            await new Promise((r) => server.close(r))
        },
    }
}

/** 條目(安裝方自帶形狀;id 即 rest:<model>) */
export const rest = (base, model, envVar = 'FAKE_ONE', extra = {}) => ({ id: `rest:${model}`, model, kind: 'api-openai-compat', baseURL: base, envVar, ...extra })
export const ENV = { FAKE_ONE: 'k1' }

let seq = 0
/**
 * 真 adapter(真 w-dispatch-ai);entries 為 ai.extraProviders;子進程工作目錄落 root 下
 *
 * @param {String} root 輸入工作目錄之根(測試之 _tmp)
 * @param {Array} entries 輸入條目陣列(見 rest)
 * @param {Object} [aiExtra={}] 輸入覆寫 settings.ai 之鍵
 * @param {Object} [opt={}] 輸入調度層建構 opt 之其餘(如 workflow:true 開工作流入口、isNetDown)
 * @returns {Object} 回傳 { ai, dir }
 */
export function mkAdapter(root, entries, aiExtra = {}, opt = {}) {
    const dir = `${root}/work-${++seq}`
    fs.mkdirSync(dir, { recursive: true })
    const ai = createAiAdapter({
        ai: {
            extraProviders: entries,
            providerTimeouts: Object.fromEntries(entries.map((e) => [e.id, 60_000])),
            cooldownMs: 900_000,
            maxRetries: 0,
            ...aiExtra,
        },
        env: ENV,
        workspace: dir,
        clock: genClockTZ('Asia/Taipei'),
        ...opt,
    })
    return { ai, dir }
}

export default { SCENES, startServer, rest, ENV, mkAdapter }
