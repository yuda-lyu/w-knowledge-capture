// memStore.mjs — 測試用記憶體集合（實作 w-data-pipeline openCollection 之介面子集）
// 不帶 .test. 中綴：共用層，避免被 runner 當測試檔抓取。
export function memStore(rows = []) {
    const map = new Map(rows.map((r) => [r.id, { ...r }]))
    const match = (r, find) => !find || Object.entries(find).every(([k, v]) => r[k] === v)
    return {
        async select(find) {
            return [...map.values()].filter((r) => match(r, find)).map((r) => ({ ...r }))
        },
        async get(id) {
            const r = map.get(String(id)); return r ? { ...r } : null
        },
        async insertNew(items) {
            const added = []
            let dup = 0
            for (const it of items) {
                if (map.has(it.id)) {
                    dup++; continue
                }
                map.set(it.id, { ...it })
                added.push({ ...it })
            }
            return { added, addCount: added.length, dupCount: dup }
        },
        async patch(id, fields) {
            const r = map.get(String(id)); if (r) Object.assign(r, fields)
        },
        async replace(rec) {
            map.set(rec.id, { ...rec })
        },
        async del(id) {
            return map.delete(String(id))
        },
        async count(find) {
            return (await this.select(find)).length
        },
        async close() {},
        _dump: () => [...map.values()],
    }
}
export default memStore
