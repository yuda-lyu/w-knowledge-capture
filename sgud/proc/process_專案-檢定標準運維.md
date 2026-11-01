# 處理要點（專案複製）— 檢定標準之運維

> 自專案 `CLAUDE_process.md` 之〈檢定標準之運維〉於 2026-10-30 建 sgud 時整段複製搬入；**未逐條核對是否仍適用**（內含 srcPack 時期之主詞、已結案之待辦與專案專有之路徑）。
> 現況以本套件 `sgud/state/state.md` 與 README 為準；原文仍在專案檔，之後只在本檔增修、不再回寫專案檔。

## 檢定標準之運維(2026-10-05;規則帳本 §11 STD-00～23)

- **符合度**:管線每輪結束自動掃一次確定性標準(各段 `standards.scanEachRun`;2026-10-10 正式庫規模單跑約 24 秒、輪末約 41 秒——同日效率改寫前 69～86 秒,見規則帳本「每輪全量掃描」條;計數入 run.json),巡檢「檢定標準違反（…掃描）」(違反 > 0 必看)、「違反數較前次掃描增加」(新進閘門應擋,非標準升版者查寫入入口).明細:`node src/tools/standards.mjs audit [--ids] [--only SS3,RS2] [--out ./tmp/x.json]`(唯讀;另印已豁免、資訊項、AI 標準之檢核紀錄與待判).
- **存量處置(須使用者同意;正式庫)**:①先停排程(`schtasks /change /tn trigger-kns-trade /disable`;CLI 對正式庫 `--apply` 會先檢查,未停即拒)②預演 `standards.mjs fix all`(或指定標準,不寫)→ 呈報件數與修不了者 ③同意後 `fix all --apply`(自動一致備份 db／knowledge／state 至 `./tmp/stock-backup-<時刻>`;逐件以現值重算、處置帳 `state/stock-fix.jsonl`;修不了者入待判)④CLI 隨即重掃＋連鎖斷言(筆記 syncHash／knowledgeChangedAt、重設基準名單、邊 updatedAt、提煉邊庫快照與 RS4／RS6 檢核、核心版號)——**回退判準**(編排層 `stockRollbackReasonsOf`):連鎖斷言有問題、套用失敗、或重掃之不合格多於應剩之件數(全量:修不了者之件數;`--limit`:套用前減已套用之件數——CLI 於限量時先以同一口徑掃一次;RS2／RS8 交兩席改寫者除外)→ CLI exit 1 並印回退指令 `standards.mjs rollback --since <時刻>`;回退依帳逆序還原(筆記 md 與記錄、邊、核心、文件、標籤;刪除之筆記 restoreNote)——**已知限制(2026-10-12 正式庫複本往返所見,關聯審計修)**:回退還原 CS10 所刪之筆記時帶回之邊仍過邊之標準閘(理由被轉正體、未過標準之衝突邊被拒而遺失)、空檢核庫之衝突邊一律登錄 RS4 待判、鄰居投影待下輪才補——**修好前勿對正式庫做含 CS10 之套用**⑤確認後恢復排程.演練可加 `--workdir <複本>`(不取正式庫鎖;**複本之筆記／核心記錄之 file 為指向正式庫之絕對路徑,演練前須先 `node src/tools/repoint-copy.mjs --workdir <複本> --apply` 改指複本**——未改指者寫入型工具拒跑,規則帳本 OPS-02).
- **AI 標準之開啟(皆須使用者同意)**:該標準之題組以**正式席位**逐案兩次全過(`WK_LIVE_AI=1 BENCH_RECORD=1 node test/api-standards-ai.test.mjs <標準>`,記指紋於 `data/bench/standards/verified.json`;未設 WK_LIVE_AI 時 run-all 只核對指紋——提示詞或題組改了而未重跑即失敗)→ `node src/tools/check-seats.mjs`(判定小組之首兩席須不同家,否則擋)→ 改 settings.json 開關與配額.既有邊覆核(RS6)開啟時可設 `relate.standards.edgeReview.deadline`(巡檢判趕不上／逾期).
- **已開啟之 AI 標準(2026-10-10)**:**RS4 衝突核對**(使用者同意「依你建議 開工」;規則帳本 STD-11 末)——`relate.standards.conflictCheck { enabled:true, perRun:10 }`、判定小組 first gemini(agy)／second muse／third mimo(遞補 sonnet);三席皆以題組 RS4 逐案兩次全過選定(luna、agnes、laguna 未過)。**第一席不可為提案席(正向 laguna、反向 sonnet)**——換席前先跑 `check-seats`。排程停用中,恢復排程才生效;存量 7,196 條約 30 天消化。**SS5 預篩攔下確認**(STD-13 末)——`summarize.standards.triageConfirm { enabled:true }`、first gemini／third muse(遞補 sonnet;確認席須異於預篩席 mimo)。**RS5 重評換席**(REL-13;閘門仍 false)——first gemini／second muse(遞補 sonnet),兩席題組皆過,開閘待候選覆核＋同意。gemini 同時是 RS4、SS5、RS5 之第一席(獨立額度,推估 60～107 次／日);主池(mimo／muse)另承 RS4 第二／三席、SS5 第三席、RS5 第二席——`check-seats` 之⑦另列「開啟之判定小組席」佔主池者。端對端與掃描耗時剖析見 `tmp/standards-golive/計畫.md` §4～§6。
- **AI 標準之容量(開啟前依「容量 ≥ 進料」定配額與席位;2026-10-05 正式庫複本實測之快照)**:呼叫數為下限＝兩席各 1 次／頁,另加第三席(兩席不一致時)、修訂與修訂後重判.重量方式:RS6＝`reviewQueueOf`(quota 0)之 total−done、RS4＝衝突邊中無 RS4 檢核紀錄者,皆 ÷10 頁 ×2;ES9＝各主核心 `stockNeedsOf` 之主張以 `packSupportPages`(60,000 字;材料同提煉段 `env.contentOf`)分頁 ×2;進料＝邊之 createdAt 近 7 日逐日計數.

  | 標準 | 存量(須核) | 一頁 | 存量一次全量 | 每日進料(近 7 日) | 進料所需 |
  |---|---|---|---|---|---|
  | RS6 既有邊覆核 | 非衝突邊 51,973 條 | 10 條 | ≥ 10,396 次 | 新非衝突邊均 536、最多 832 條／日(兩端內容變更者另計) | ≥ 108～168 次／日 |
  | RS4 衝突核對 | 衝突邊 6,868 條 | 10 條 | ≥ 1,374 次 | 新衝突邊均 67、最多 109 條／日 | ≥ 14～22 次／日 |
  | ES9 出處支持(存量) | 主張 2,217 條／88 核心 | 依字數 60,000(各核心材料最大 28,255 字 → 一核心一頁) | ≥ 176 次 | 新進操作於每個提煉 pass 內覆核 | 每 pass ≥ 2 次 |
  | ES8 失撐 | 7 條 | 同 ES9 | ≥ 2 次／核心 | — | — |
  | SS14 忠實性 | 存量須原文(G4) | 同摘要批 | — | 新筆記 | 摘要呼叫約 3 倍(帳本 STD-16) |
  | SS5 預篩確認 | — | 同預篩批 | — | 預篩攔下者以同一提示詞再判 | 量＝攔下篇數 |
  | SS9 重標 | 只在分類法變更時 | — | 新增一類約 64 次(「其他」1,270 篇) | — | 每輪至多 3 次 |
  | ES10 關聯影響 | 見帳本 STD-18 | — | — | 夥伴進料可達每日數百篇 | 依 `extract.recheck.perRun` |
  | ES11／ES14／CS8 | 候選對／存疑爭議／領域發現 | 10 對／同核心／— | 量小 | — | CS8 每日至多 1 次 |

  RS6 一開即須至少消化進料(每日 ≥ 108～168 次)才不積壓;存量 10,396 次以每日餘量消化,`relate.standards.edgeReview.deadline` 依此推算.
- **待判**:`standards.mjs holds [--std RS5] [--object note] [--all]`(唯讀)、`retry <鍵>`、`waive <鍵> --by=<裁示者> --ruling=<內容>`;各待判之「下一步」即可完成之處置(還原類寫明 `notes restore-edge … --apply`).
- **原文回溯(SS4 等存量判定之材料;須使用者同意)**:2026-10-04 前已瘦身之筆記來源無原文,SS4 只能未能判定.**先做舊筆記補 processedChars**(`tmp/capture-fix/backfill-old.mjs --part notes`,須同意;否則回溯之全文會把 SS4 材料放寬到 AI 當時未讀之後段)→ `node src/tools/refetch-sources.mjs`(預演:對象數與方法分布)→ 同意後分批、**先 API 類** `--methods arxiv,openalex-doi --limit 500 --apply`(再 `openalex-title`)——**網頁類(article)回溯物不作 SS4 材料**(現在的頁面不能證明為當時之材料;只供 CS10 段落比對),是否做另議(摘要型以 OpenAlex／arXiv API 重查;身分比對不符不另存;處置帳 `state/refetch-sources.jsonl`,重跑自動略過已處理者;`--retry` 只重試 fetch-failed、`--retry-all` 連同內容判定;CLI 依批量宣告鎖之陳舊期限)→ 之後 `standards.mjs audit --only SS4` 判定 → 存量處置 `fix SS4`(含原文沒有之數字之清單行逐條移除;標題／一句話重點有者入待判).演練加 `--workdir tmp/standards-audit/live/kb`.

---
