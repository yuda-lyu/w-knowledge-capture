// wpwFakeLaunch.mjs — 子行程預載件(node --import):以 w-playwright 之 setBrowserTypeForTest 裝替身,不啟動任何瀏覽器
//
// 用途:瀏覽器階梯之子行程(src/fetchers/fetch_web_cli.mjs)經 w-fetch-web 啟動 Chromium 系瀏覽器;本件讓該子行程之啟動止於 w-playwright 之替身,
//   把「替身收到的合併後選項」逐筆追加至 WK_WPW_LOG 指向之檔(一行一筆 JSON),再拋錯拒絕啟動——測試據以斷言啟動點確經 w-playwright 且選項含守門。
// 用法:node --import <本檔之 file URL> <fetch_web_cli.mjs> <url> <optsFile> <outputPath>,環境變數 WK_WPW_LOG=<記錄檔路徑>
// 載不到 w-playwright 時本件即拋錯、子行程於載入階段結束(未執行任何啟動)

import fs from 'fs'
import wpw from 'w-playwright'

const logFile = process.env.WK_WPW_LOG
if (!logFile) throw new Error('wpwFakeLaunch: 須以環境變數 WK_WPW_LOG 給記錄檔路徑')

wpw.setBrowserTypeForTest({
    launch: async (o) => {
        // 只記測試要斷言之鍵(合併後之 args 最後一個元素為合併之 --disable-features);不記 env 等其他鍵
        fs.appendFileSync(logFile, `${JSON.stringify({ args: o.args, ignoreDefaultArgs: o.ignoreDefaultArgs, headless: o.headless, channel: o.channel })}\n`)
        throw new Error('wk-fake-launch-refused')
    },
})
