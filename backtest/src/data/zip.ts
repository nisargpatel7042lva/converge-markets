import { inflateRawSync } from "node:zlib";

/**
 * Extracts the first entry of a ZIP archive (Binance's daily dumps hold exactly one CSV).
 * Reads the central directory, so entries written with a trailing data descriptor work too.
 */
export function unzipFirst(buf: Buffer): { name: string; data: Buffer } {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: end of central directory not found");
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error("zip: bad central directory");
  const method = buf.readUInt16LE(cdOffset + 10);
  const compSize = buf.readUInt32LE(cdOffset + 20);
  const nameLen = buf.readUInt16LE(cdOffset + 28);
  const localOffset = buf.readUInt32LE(cdOffset + 42);
  const name = buf.toString("utf8", cdOffset + 46, cdOffset + 46 + nameLen);
  if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("zip: bad local header");
  const lnLen = buf.readUInt16LE(localOffset + 26);
  const leLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + lnLen + leLen;
  const comp = buf.subarray(start, start + compSize);
  if (method === 0) return { name, data: Buffer.from(comp) };
  if (method === 8) return { name, data: inflateRawSync(comp) };
  throw new Error(`zip: unsupported compression method ${method}`);
}
