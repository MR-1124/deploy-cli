// Minimal zero-dependency ZIP writer. Uses the "store" method (no compression)
// with UTF-8 names — plenty for a static site upload to Netlify.

import fs from "node:fs";
import { listFiles } from "./files.js";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = (Math.max(date.getFullYear() - 1980, 0) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return [time, day];
}

/** Zip a directory into a single Buffer (store method, no compression). */
export async function zipDirectory(dir) {
  const files = (await listFiles(dir)).filter((f) => f.type === "file").sort((a, b) => a.rel.localeCompare(b.rel));
  const now = new Date();
  const [dosTime, dosDate] = dosDateTime(now);

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const data = await fs.promises.readFile(f.path);
    const name = Buffer.from(f.rel, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4);         // version needed to extract
    local.writeUInt16LE(0x0800, 6);     // flags: UTF-8 names
    local.writeUInt16LE(0, 8);          // method: store
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    chunks.push(local, name, data);
    central.push({ name, crc, size: data.length, offset });
    offset += 30 + name.length + data.length;
  }

  const cdStart = offset;
  const cdChunks = [];
  for (const c of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0); // central directory signature
    h.writeUInt16LE(20, 4);         // version made by
    h.writeUInt16LE(20, 6);         // version needed
    h.writeUInt16LE(0x0800, 8);     // UTF-8 names
    h.writeUInt16LE(0, 10);         // method: store
    h.writeUInt16LE(dosTime, 12);
    h.writeUInt16LE(dosDate, 14);
    h.writeUInt32LE(c.crc, 16);
    h.writeUInt32LE(c.size, 20);
    h.writeUInt32LE(c.size, 24);
    h.writeUInt16LE(c.name.length, 28);
    h.writeUInt16LE(0, 30); // extra length
    h.writeUInt16LE(0, 32); // comment length
    h.writeUInt16LE(0, 34); // disk number start
    h.writeUInt16LE(0, 36); // internal attrs
    h.writeUInt32LE(0, 38); // external attrs
    h.writeUInt32LE(c.offset, 42);
    cdChunks.push(h, c.name);
  }

  const cdSize = cdChunks.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, ...cdChunks, eocd]);
}
