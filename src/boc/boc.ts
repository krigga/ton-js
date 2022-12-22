import { sha256_sync } from "ton-crypto";
import { BitString, Cell } from "..";
import { CellType } from "./CellType";
import { crc32c } from "./utils/crc32c";
import { topologicalSort } from "./utils/topologicalSort";

const reachBocMagicPrefix = Buffer.from('B5EE9C72', 'hex');
const leanBocMagicPrefix = Buffer.from('68ff65f3', 'hex');
const leanBocMagicPrefixCRC = Buffer.from('acc3a728', 'hex');
let cacheContext: symbol | null = null;

type CellCache = {
    hash: Buffer | null;
    maxDepth: number | null;
}
function getCellCache(src: Cell): CellCache {
    if (!cacheContext) {
        throw Error('No cache context');
    }
    let ex = (src as any)[cacheContext] as CellCache;
    if (!ex) {
        ex = { hash: null, maxDepth: null };
        (src as any)[cacheContext] = ex;
    }
    return ex;
}

function inCache<T>(cell: Cell, handler: (cache: CellCache) => T): T {
    let wasCreated = false;
    if (!cacheContext) {
        wasCreated = true;
        cacheContext = Symbol();
    }
    let cache = getCellCache(cell);
    try {
        return handler(cache);
    } finally {
        if (wasCreated) {
            cacheContext = null;
        }
    }
}


//
// Hash Content
//

export function getMaxDepth(cell: Cell): number {
    return inCache(cell, (cache) => {
        if (cache.maxDepth !== null) {
            return cache.maxDepth;
        }
        let maxDepth = 0;
        if (cell.refs.length > 0) {
            for (let k in cell.refs) {
                const i = cell.refs[k];
                if (getMaxDepth(i) > maxDepth) {
                    maxDepth = getMaxDepth(i);
                }
            }
            maxDepth = maxDepth + 1;
        }
        cache.maxDepth = maxDepth;
        return maxDepth;
    })
}

export function getMaxLevel(cell: Cell) {
    //TODO level calculation differ for exotic cells
    // let maxLevel = 0;
    // for (let k in cell.refs) {
    //     const i = cell.refs[k];
    //     if (getMaxLevel(i) > maxLevel) {
    //         maxLevel = getMaxLevel(i);
    //     }
    // }
    // return maxLevel;
    return 0;
}

function getRefsDescriptor(cell: Cell) {
    return cell.refs.length + (cell.isExotic ? 1 : 0) * 8 + getMaxLevel(cell) * 32;
}

function getBitsDescriptor(cell: Cell) {
    let len = cell.bits.cursor;
    if (cell.isExotic) {
        len += 8;
    }
    return Math.ceil(len / 8) + Math.floor(len / 8);
}

function getRepr(cell: Cell) {
    const tuLen = cell.bits.getTopUppedLength();
    const repr = Buffer.alloc(2 + tuLen + (2 + 32) * cell.refs.length);
    let reprCursor = 0;
    repr[reprCursor++] = getRefsDescriptor(cell);
    repr[reprCursor++] = getBitsDescriptor(cell);
    cell.bits.writeTopUppedArray(repr, reprCursor);
    reprCursor += tuLen;
    for (const c of cell.refs) {
        const md = getMaxDepth(c);
        repr[reprCursor++] = Math.floor(md / 256);
        repr[reprCursor++] = md % 256;
    }
    for (const c of cell.refs) {
        c.hash().copy(repr, reprCursor);
        reprCursor += 32;
    }
    return repr;
}

export function hashCell(cell: Cell): Buffer {
    return inCache(cell, (cache) => {
        if (cache.hash) {
            return cache.hash;
        }
        let r = sha256_sync(getRepr(cell));
        cache.hash = r;
        return r;
    });
}

//
// Deserialize
//

function readNBytesUIntFromArray(n: number, ui8array: Buffer) {
    let res = 0;
    for (let c = 0; c < n; c++) {
        res *= 256;
        res += ui8array[c];
    }
    return res;
}

export function parseBocHeader(serializedBoc: Buffer) {
    // snake_case is used to match TON docs

    // Preflight check
    if (serializedBoc.length < 4 + 1) {
        throw new Error('Not enough bytes for magic prefix');
    }
    const inputData = serializedBoc; // Save copy for crc32

    // Parse prefix
    const prefix = serializedBoc.subarray(0, 4);
    serializedBoc = serializedBoc.subarray(4);
    let has_idx = false;
    let hash_crc32 = false;
    let has_cache_bits = false;
    let flags = 0;
    let size_bytes = 0;
    if (prefix.equals(reachBocMagicPrefix)) {
        const flags_byte = serializedBoc[0];
        has_idx = !!(flags_byte & 128);
        hash_crc32 = !!(flags_byte & 64);
        has_cache_bits = !!(flags_byte & 32);
        flags = (flags_byte & 16) * 2 + (flags_byte & 8);
        size_bytes = flags_byte % 8;
    } else if (prefix.equals(leanBocMagicPrefix)) {
        has_idx = true;
        hash_crc32 = false;
        has_cache_bits = false;
        flags = 0;
        size_bytes = serializedBoc[0];
    } else if (prefix.equals(leanBocMagicPrefixCRC)) {
        has_idx = true;
        hash_crc32 = true;
        has_cache_bits = false;
        flags = 0;
        size_bytes = serializedBoc[0];
    } else {
        throw Error('Unknown magic prefix');
    }

    // Counters
    serializedBoc = serializedBoc.subarray(1);
    if (serializedBoc.length < 1 + 5 * size_bytes) {
        throw new Error('Not enough bytes for encoding cells counters');
    }
    const offset_bytes = serializedBoc[0];
    serializedBoc = serializedBoc.subarray(1);
    const cells_num = readNBytesUIntFromArray(size_bytes, serializedBoc);
    serializedBoc = serializedBoc.subarray(size_bytes);
    const roots_num = readNBytesUIntFromArray(size_bytes, serializedBoc);
    serializedBoc = serializedBoc.subarray(size_bytes);
    const absent_num = readNBytesUIntFromArray(size_bytes, serializedBoc);
    serializedBoc = serializedBoc.subarray(size_bytes);
    const tot_cells_size = readNBytesUIntFromArray(offset_bytes, serializedBoc);
    serializedBoc = serializedBoc.subarray(offset_bytes);
    if (serializedBoc.length < roots_num * size_bytes) {
        throw new Error('Not enough bytes for encoding root cells hashes');
    }

    // Roots
    let root_list = [];
    for (let c = 0; c < roots_num; c++) {
        root_list.push(readNBytesUIntFromArray(size_bytes, serializedBoc));
        serializedBoc = serializedBoc.subarray(size_bytes);
    }

    // Index
    let index: number[] | null = null;
    if (has_idx) {
        index = [];
        if (serializedBoc.length < offset_bytes * cells_num)
            throw new Error("Not enough bytes for index encoding");
        for (let c = 0; c < cells_num; c++) {
            index.push(readNBytesUIntFromArray(offset_bytes, serializedBoc));
            serializedBoc = serializedBoc.subarray(offset_bytes);
        }
    }

    // Cells
    if (serializedBoc.length < tot_cells_size) {
        throw new Error('Not enough bytes for cells data');
    }
    const cells_data = serializedBoc.subarray(0, tot_cells_size);
    serializedBoc = serializedBoc.subarray(tot_cells_size);

    // CRC32
    if (hash_crc32) {
        if (serializedBoc.length < 4) {
            throw new Error('Not enough bytes for crc32c hashsum');
        }
        const length = inputData.length;
        if (!crc32c(inputData.subarray(0, length - 4)).equals(serializedBoc.subarray(0, 4))) {
            throw new Error('Crc32c hashsum mismatch');
        }
        serializedBoc = serializedBoc.subarray(4);
    }

    // Check if we parsed everything
    if (serializedBoc.length) {
        throw new Error('Too much bytes in BoC serialization');
    }
    return {
        has_idx: has_idx,
        hash_crc32: hash_crc32,
        has_cache_bits: has_cache_bits,
        flags: flags,
        size_bytes: size_bytes,
        off_bytes: offset_bytes,
        cells_num: cells_num,
        roots_num: roots_num,
        absent_num: absent_num,
        tot_cells_size: tot_cells_size,
        root_list: root_list,
        index: index,
        cells_data: cells_data
    };
}

export function deserializeCellData(cellData: Buffer, referenceIndexSize: number) {
    if (cellData.length < 2) {
        throw new Error('Not enough bytes to encode cell descriptors');
    }
    const d1 = cellData[0], d2 = cellData[1];
    cellData = cellData.subarray(2);
    // const level = Math.floor(d1 / 32);
    const isExotic = !!(d1 & 8);
    const refNum = d1 % 8;
    let dataBytesize = Math.ceil(d2 / 2);
    const fullfilledBytes = !(d2 % 2);

    // Build Cell
    let refs: number[] = [];
    if (cellData.length < dataBytesize + referenceIndexSize * refNum) {
        throw new Error('Not enough bytes to encode cell data');
    }

    // Cell data
    let kind: CellType = 'ordinary';
    if (isExotic) {
        let k = cellData.readUInt8();
        if (k === 1) {
            kind = 'pruned';
        } else if (k === 2) {
            kind = 'library_reference';
        } else if (k === 3) {
            kind = 'merkle_proof';
        } else if (k === 4) {
            kind = 'merkle_update';
        } else {
            throw Error('Invalid cell type: ' + k);
        }
        cellData = cellData.subarray(1);
        dataBytesize--;
    }
    const bits = BitString.fromTopUppedArray(cellData.subarray(0, dataBytesize), fullfilledBytes);
    cellData = cellData.subarray(dataBytesize);

    // References
    for (let r = 0; r < refNum; r++) {
        refs.push(readNBytesUIntFromArray(referenceIndexSize, cellData));
        cellData = cellData.subarray(referenceIndexSize);
    }

    // Resolve kind
    let cell = new Cell(kind, bits);

    return { cell, refs, residue: cellData };
}

export function deserializeBoc(serializedBoc: Buffer) {
    const header = parseBocHeader(serializedBoc);
    let cells_data = header.cells_data;
    let cells_array = [];
    let refs_array: number[][] = [];
    for (let ci = 0; ci < header.cells_num; ci++) {
        let dd = deserializeCellData(cells_data, header.size_bytes);
        cells_data = dd.residue;
        cells_array.push(dd.cell);
        refs_array.push(dd.refs);
    }
    for (let ci = header.cells_num - 1; ci >= 0; ci--) {
        let c = refs_array[ci];
        for (let ri = 0; ri < c.length; ri++) {
            const r = c[ri];
            if (r < ci) {
                throw new Error('Topological order is broken');
            }
            cells_array[ci].refs[ri] = cells_array[r];
        }
    }
    let root_cells = [];
    for (let ri of header.root_list) {
        root_cells.push(cells_array[ri]);
    }
    return root_cells;
}

//
// Serialize
//

function calcCellSerializedSize(cell: Cell, sSize: number) {
    return (
        2 + // descriptors
        (cell.isExotic ? 1 : 0) +
        cell.bits.getTopUppedLength() +
        cell.refs.length * sSize
    );
}

function serializeForBoc(cell: Cell, refs: number[], sSize: number, repr: Buffer, reprCursor: number) {
    repr[reprCursor++] = getRefsDescriptor(cell);
    repr[reprCursor++] = getBitsDescriptor(cell);

    if (cell.isExotic) {
        if (cell.kind === 'pruned') {
            repr[reprCursor++] = 1;
        } else if (cell.kind === 'library_reference') {
            repr[reprCursor++] = 2;
        } else if (cell.kind === 'merkle_proof') {
            repr[reprCursor++] = 3;
        } else if (cell.kind === 'merkle_update') {
            repr[reprCursor++] = 4;
        } else {
            throw Error('Invalid cell type');
        }
    }
    cell.bits.writeTopUppedArray(repr, reprCursor);
    reprCursor += cell.bits.getTopUppedLength();
    for (let refIndexInt of refs) {
        writeNumber(repr, reprCursor, refIndexInt, sSize);
        reprCursor += sSize;
    }
}

function writeNumber(b: Buffer, start: number, n: number, bytes: number) {
    for (let i = bytes - 1; i >= 0; i--) {
        b[start++] = (n >> (i * 8)) & 0xff;
    }
}

export function serializeToBoc(cell: Cell, has_idx = true, hash_crc32 = true, has_cache_bits = false, flags = 0) {
    return inCache(cell, () => {
        const root_cell = cell;
        const allCells = topologicalSort(root_cell);
        const cells_num = allCells.length;
        const s = cells_num.toString(2).length; // Minimal number of bits to represent reference (unused?)
        const s_bytes = Math.max(Math.ceil(s / 8), 1);
        const sizes = allCells.map((c, i) => calcCellSerializedSize(c.cell, s_bytes));
        let full_size = 0;
        let sizeIndex: number[] = [];
        for (let i = 0; i < sizes.length; i++) {
            full_size += sizes[i];
            sizeIndex.push(full_size);
        }
        const offset_bits = full_size.toString(2).length; // Minimal number of bits to offset/len (unused?)
        const offset_bytes = Math.max(Math.ceil(offset_bits / 8), 1);

        const serialization = Buffer.alloc(
            4 + // magic
            1 + // flags and s_bytes
            1 + // offset_bytes
            3 * s_bytes + // cells_num, roots, complete
            offset_bytes + // full_size
            s_bytes + // root_idx
            (has_idx ? cells_num * offset_bytes : 0) +
            full_size +
            (hash_crc32 ? 4 : 0)
        );
        let serCursor = 0;

        reachBocMagicPrefix.copy(serialization);
        serCursor = 4;
        serialization[serCursor++] = ((has_idx ? 1 : 0) << 7) |
            ((hash_crc32 ? 1 : 0) << 6) |
            ((has_cache_bits ? 1 : 0) << 5) |
            flags << 3 |
            s_bytes;
        serialization[serCursor++] = offset_bytes;
        writeNumber(serialization, serCursor, cells_num, s_bytes);
        serCursor += s_bytes;
        writeNumber(serialization, serCursor, 1, s_bytes);
        serCursor += s_bytes;
        writeNumber(serialization, serCursor, 0, s_bytes);
        serCursor += s_bytes;
        writeNumber(serialization, serCursor, full_size, offset_bytes);
        serCursor += offset_bytes;
        writeNumber(serialization, serCursor, 0, s_bytes);
        serCursor += s_bytes;
        if (has_idx) {
            allCells.forEach((_, index) => {
                writeNumber(serialization, serCursor, sizeIndex[index], offset_bytes);
                serCursor += offset_bytes;
            });
        }
        for (let i = 0; i < cells_num; i++) {
            //TODO it should be async map or async for
            serializeForBoc(allCells[i].cell, allCells[i].refs, s_bytes, serialization, serCursor);
            serCursor += sizes[i];
        }
        if (hash_crc32) {
            crc32c(serialization.subarray(0, serialization.length - 4)).copy(serialization, serialization.length - 4);
        }

        return serialization;
    });
}