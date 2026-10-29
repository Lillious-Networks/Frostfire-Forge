import { BLOCK_SIZE_PX, blockKey, type BlockExtent, type MapBlocks } from "./blocks";

// The block owners as the Gateway is told them (POST /blocks, modules/gateway-client.ts): per map, the table's epoch,
// its size in blocks and one character per block naming the owner, so the Gateway can send a login straight to the
// node that owns the saved point. The Gateway has its own copy of the decoder (src/gateway/blockroute.ts in the
// Gateway repo); both read the same layout.

/** One character per owner: the index of the node in `nodes`, spelled with these. */
export const REPORT_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** The character of a block no node owns. */
export const NO_OWNER = ".";
/** A report names at most this many nodes (one alphabet character each). */
export const MAX_REPORT_NODES = REPORT_ALPHABET.length;
/** The most blocks a map's report may hold; the Gateway refuses more. */
export const MAX_REPORT_BLOCKS = 65536;
/** The longest node id or map name a report may carry. */
export const MAX_REPORT_NAME = 128;

/** What goes to the Gateway for one map. `owners` is row by row (by * blocksX + bx). */
export interface BlockReport {
  map: string;
  epoch: number;
  blockPx: number;
  blocksX: number;
  blocksY: number;
  nodes: string[];
  owners: string;
}

/** What the report is read from: the BlockTable has all of it. */
export interface BlockReportSource {
  ownersOf(map: string): MapBlocks["owners"];
  epochOf(map: string): number;
  extentOf(map: string): BlockExtent | undefined;
  maps(): string[];
  onChange(listener: (map: string) => void): () => void;
}

const whole = (value: number) => Number.isSafeInteger(value) && value >= 1;
const bare = (map: string) => (map.endsWith(".json") ? map.slice(0, -5) : map);

/**
 * The compact table of one map, or null when there is nothing to say or it cannot be said: no table yet (epoch 0), no
 * known size, a table too large for a report, more owners than the alphabet holds, or a name that is not one.
 */
export function encodeBlockReport(map: string, table: MapBlocks, extent: BlockExtent | undefined, blockPx: number = BLOCK_SIZE_PX): BlockReport | null {
  const name = bare(map);
  if (!name || name.length > MAX_REPORT_NAME) return null;
  if (!Number.isSafeInteger(table.epoch) || table.epoch < 1) return null;
  if (!extent || !whole(extent.blocksX) || !whole(extent.blocksY) || extent.blocksX * extent.blocksY > MAX_REPORT_BLOCKS) return null;
  if (!whole(blockPx)) return null;
  const nodes: string[] = [];
  const index = new Map<string, number>();
  let owners = "";
  for (let by = 0; by < extent.blocksY; by++) {
    for (let bx = 0; bx < extent.blocksX; bx++) {
      const id = table.owners[blockKey(bx, by)]?.nodeId;
      if (typeof id !== "string" || id === "") {
        owners += NO_OWNER;
        continue;
      }
      let at = index.get(id);
      if (at === undefined) {
        if (id.length > MAX_REPORT_NAME || nodes.length >= MAX_REPORT_NODES) return null;
        at = nodes.length;
        nodes.push(id);
        index.set(id, at);
      }
      owners += REPORT_ALPHABET[at];
    }
  }
  return { map: name, epoch: table.epoch, blockPx, blocksX: extent.blocksX, blocksY: extent.blocksY, nodes, owners };
}

/** The report of one cached map, null when encodeBlockReport has none (or the map is not cached). */
export function reportOf(source: Pick<BlockReportSource, "ownersOf" | "epochOf" | "extentOf">, map: string): BlockReport | null {
  const epoch = source.epochOf(map);
  if (epoch < 1) return null;
  return encodeBlockReport(map, { epoch, owners: source.ownersOf(map) }, source.extentOf(map));
}

/**
 * The owner of the block a position is in: what BlockTable.ownerOf says for the same table, including the clamp of a
 * position on or past the far edge into the last block and of a negative or non-finite one into block 0. Null for a
 * block no node owns.
 */
export function decodeBlockOwner(report: Pick<BlockReport, "blockPx" | "blocksX" | "blocksY" | "nodes" | "owners">, x: number, y: number): string | null {
  const block = (px: number, count: number) => Math.min(Number.isFinite(px) ? Math.max(0, Math.floor(px / report.blockPx)) : 0, count - 1);
  const char = report.owners[block(y, report.blocksY) * report.blocksX + block(x, report.blocksX)];
  if (char === undefined || char === NO_OWNER) return null;
  return report.nodes[REPORT_ALPHABET.indexOf(char)] ?? null;
}
