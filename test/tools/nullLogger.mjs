// nullLogger.mjs — 測試用靜默 logger（共用層，不帶 .test. 中綴）
const N = () => {}
export const nullLogger = () => ({ info: N, warn: N, error: N, debug: N })
export default nullLogger
