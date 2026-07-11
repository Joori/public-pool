export interface IMempoolInfo {
    // getmempoolinfo's "size" (transaction count) and "bytes" (sum of virtual
    // transaction sizes, i.e. vsize in vbytes — despite the name, NOT raw
    // serialized bytes and NOT "usage", which is memory-accounting overhead).
    size: number,
    bytes: number,
}
