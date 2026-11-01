// web.mjs — URL 泛用件:去重鍵正規化、新聞聚合站轉址解包
//
// 【單一真理來源】直接沿用 w-data-pipeline 之 normalizeUrl / unwrapRedirectUrl:
//   doc 主鍵＝seen store 之 identity(keyOf:'raw')＝sha1(normalizeUrl(unwrapRedirectUrl(url))),
//   套件內另一條入庫路徑(探測入庫 records.mjs)必須算出同一把鍵,
//   自己再抄一份正規化邏輯,兩邊日後一旦漂移就是同一篇文件兩個 id。

import W from 'w-data-pipeline/src/WDataPipeline.mjs'

/**
 * 正規化 URL 作為去重鍵:去 hash、去常見追蹤參數、去尾斜線(＝w-data-pipeline 同名函數)
 *
 * 無法解析時(含非字串輸入)由 w-data-pipeline 內部 try/catch 接住,fail-safe 轉字串原樣回傳,不拋錯
 * (實測:undefined／null 回傳''，數字／物件回傳其字串化結果)——去重仍以字串相等生效,不因畸形網址而中斷整批。
 *
 * @param {*} url 輸入網址，預期為字串；非字串或無法解析時 fail-safe 轉字串回傳(不拋錯)
 * @returns {String} 回傳正規化後網址字串
 * @example
 * console.log(normalizeUrl('https://a.com/x/?utm_source=y&b=2#frag'))
 * // => https://a.com/x/?b=2
 *
 * console.log(normalizeUrl(undefined))
 * // =>
 */
export function normalizeUrl(url) {
    return W.normalizeUrl(url)
}

/**
 * 解開新聞聚合站的點擊轉址連結,取出真實文章網址(＝w-data-pipeline unwrapRedirectUrl 之預設規則表)。
 * Bing News RSS 的 <link> 是 bing.com/news/apiclick.aspx?...&url=<真實網址>——
 * 真實網址完整帶在 url= 參數內,直接解碼即可。
 * 註:Google News 的 /rss/articles/<AU_yqL…> 為不透明 ID,真實網址「不在」連結內,
 * 離線不可解(base64 解開無 URL;抓包裝頁只得一包 JS 殼),故不在此處理。
 *
 * 無法解析或未命中規則表時(含非字串輸入)fail-safe 轉字串原樣回傳,不拋錯(與 normalizeUrl 同語意)。
 *
 * @param {*} url 輸入網址，預期為字串；非字串或無法解析時 fail-safe 轉字串回傳(不拋錯)
 * @returns {String} 回傳解開後之真實網址字串(未命中規則或非 http/https 時為原樣字串)
 * @example
 * console.log(unwrapNewsUrl('https://www.bing.com/news/apiclick.aspx?ref=x&url=https%3A%2F%2Fe.com%2Fa'))
 * // => https://e.com/a
 *
 * console.log(unwrapNewsUrl(undefined))
 * // =>
 */
export function unwrapNewsUrl(url) {
    return W.unwrapRedirectUrl(url)
}

export default { normalizeUrl, unwrapNewsUrl }
