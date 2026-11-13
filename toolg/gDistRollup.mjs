import rollupFiles from 'w-package-tools/src/rollupFiles.mjs'


let fdSrc = './src'
let fdTar = './dist'


//external與globals之盤點原則:
//1. 已安裝自有套件(wsemi/w-dispatch-ai/w-data-pipeline/w-dwdata-hub/w-fetch-web/w-orm-lmdb)之gDistRollup剔除清單, 本套件一併剔除不打包;
//   本套件以src深層引用其原始碼, rollup會沿著引用打包到其src, 故其剔除者在此亦須剔除, 否則會被打包進來
//2. 本套件src之node內建模組一律以無前綴引用(fs、path、os), 與自有套件同一寫法, 故只需一套剔除規則;
//   rollup之external與globals以import字串逐字比對, 'fs'不涵蓋'node:fs'(實測只列fs時, node:fs出現globals猜名警告,
//   runin為browser時另成未解析引用), 若日後引用node:前綴須另行列入
//3. 本套件直接相依之第三方套件(opencc-js)比照w-*套件慣例列為external, 由package.json之dependencies安裝;
//   opencc-js核心含大型轉換表, 打包會使dist暴增; 其詞庫以子路徑引用(opencc-js/dict/*)則不剔除而打包進dist:
//   詞庫為純資料之ESM預設匯出(字串), 套件exports的「./*」只給ESM檔(無require條件), 列為external時UMD經require載入得到的是命名空間物件而非字串,
//   詞庫無法使用(實測載入dist即拋split非函數), 故須打包(約1.1MB, 其中STPhrases占大宗)
//4. dayjs已由wsemi剔除, 其外掛以子路徑引用(dayjs/plugin/utc.js由w-dwdata-hub引用), 須逐一列入, 否則外掛被打包而核心外部化
//5. globals右側為引入後的名稱, 不能包含小數點「.」
//6. runin須為nodejs: 本套件僅能於nodejs執行(lmdb、w-playwright、child_process), 未給時rollupFiles預設browser,
//   會以browser欄位解析被打包之相依(uuid、crypto-js等取瀏覽器版)並警告依賴node內建模組
//7. Chromium系瀏覽器一律經w-playwright啟動(不直接依賴playwright／playwright-core): 打包進來的w-fetch-web原始碼於執行期require w-playwright, 故須剔除且列於package.json之dependencies;
//   此處不可誤留playwright(unit-package守此項)
//盤點方式: 自src/WKnowledgeCapture.mjs靜態追蹤import圖(含自有套件src深層引用)取得全部裸import, 再與各套件剔除清單取聯集;
//   圖中被打包而不剔除者為lodash-es/*、crypto-js/*、uuid、eventemitter3(wsemi所引用, 體積小且各自有單函數路徑, 與自有套件之打包一致)與opencc-js/dict/*(見第3點)


rollupFiles({
    fns: 'WKnowledgeCapture.mjs',
    fdSrc,
    fdTar,
    nameDistType: 'kebabCase',
    runin: 'nodejs',
    globals: {

        //node內建模組(本套件與自有套件之剔除清單)
        'path': 'path',
        'fs': 'fs',
        'os': 'os',
        'readline': 'readline',
        'events': 'events',
        'url': 'url',
        'stream': 'stream',
        'stream/promises': 'streamPromises',
        'process': 'process',
        'child_process': 'child_process',
        'crypto': 'crypto',
        'util': 'util',
        'module': 'module',
        'http': 'http',
        'https': 'https',
        'zlib': 'zlib',
        'buffer': 'buffer',

        //本套件直接相依之第三方套件
        'opencc-js': 'OpenCC',

        //wsemi剔除清單
        'tree-kill': 'treeKill',
        'chokidar': 'chokidar',
        'dayjs': 'dayjs',
        'dayjs/plugin/utc.js': 'dayjs_plugin_utc',
        'html-to-text': 'html-to-text',
        'ua-parser-js': 'UAParser',
        'xss': 'filterXSS',

        //w-fetch-web、w-dwdata-hub剔除清單
        '@mozilla/readability': '@mozilla/readability',
        'jsdom': 'jsdom',
        'w-playwright': 'w-playwright',
        'cheerio': 'cheerio',
        'rss-parser': 'rss-parser',

        //w-orm-lmdb剔除清單
        'lmdb': 'lmdb',
        'mingo': 'mingo',

    },
    external: [

        //node內建模組(本套件與自有套件之剔除清單)
        'path',
        'fs',
        'os',
        'readline',
        'events',
        'url',
        'stream',
        'stream/promises',
        'process',
        'child_process',
        'crypto',
        'util',
        'module',
        'http',
        'https',
        'zlib',
        'buffer',

        //本套件直接相依之第三方套件
        'opencc-js',

        //wsemi剔除清單
        'tree-kill',
        'chokidar',
        'dayjs',
        'dayjs/plugin/utc.js',
        'html-to-text',
        'ua-parser-js',
        'xss',

        //w-fetch-web、w-dwdata-hub剔除清單
        '@mozilla/readability',
        'jsdom',
        'w-playwright',
        'cheerio',
        'rss-parser',

        //w-orm-lmdb剔除清單
        'lmdb',
        'mingo',

    ],
})


//node toolg/gDistRollup.mjs
