// Minimal POSIX ustar tar writer/reader with zero dependencies.
// Good enough for shipping a static site folder as a single upload body,
// and for extracting it safely on the server side.

import fs from "node:fs";
import path from "node:path";
import { listFiles } from "./files.js";

const fsp = fs.promises;
const BLOCK = 512;

function ustarHeader(name, { type = "0", size = 0, mode = 0o644, mtime = 0 }) {
  const buf = Buffer.alloc(BLOCK);
  const write = (off, val, len) => {
    const s = String(val).slice(0, len);
    buf.write(s, off, s.length, "ascii");
  };
  write(0, name, 100);                 // name
  write(100, mode.toString(8).padStart(7, "0"), 8);
  write(108, "1000", 8);               // uid
  write(116, "1000", 8);               // gid
  write(124, size.toString(8).padStart(11, "0"), 12);
  write(136, mtime.toString(8).padStart(11, "0"), 12);
  write(156, type, 1);                 // typeflag
  buf.write("ustar", 257, 5, "ascii"); // magic
  buf.write("00", 262, 2, "ascii");    // version
  // checksum: sum of all bytes with the checksum field as 8 spaces
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i];
  write(148, sum.toString(8).padStart(6, "0") + "\0 ", 8);
  return buf;
}

/** Tar a directory into a single Buffer (memory-bound; fine for site deploys). */
export async function tarDirectory(dir) {
  const chunks = [];
  const files = await listFiles(dir, { dirs: true });
  const mtime = Date.now() / 1000;
  for (const f of files) {
    if (f.type === "dir") {
      chunks.push(ustarHeader(f.rel.endsWith("/") ? f.rel : f.rel + "/", { type: "5", mode: 0o755, mtime }));
    } else {
      const data = await fsp.readFile(f.path);
      const stat = await fsp.stat(f.path);
      chunks.push(ustarHeader(f.rel, { type: "0", size: data.length, mode: stat.mode & 0o777, mtime }));
      chunks.push(data);
      const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
      if (pad) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2)); // end-of-archive marker
  return Buffer.concat(chunks);
}

function readStr(b, off, len) {
  const end = b.indexOf(0, off);
  const stop = end === -1 || end >= off + len ? off + len : end;
  return b.toString("ascii", off, stop).trimEnd();
}

function safeJoin(base, name) {
  const root = path.resolve(base);
  const p = path.resolve(root, name);
  if (p !== root && !p.startsWith(root + path.sep)) {
    throw new Error(`Refusing to extract outside target dir: ${name}`);
  }
  return p;
}

/** Extract a ustar archive (as produced by tarDirectory) into destDir. */
export function extractTar(buf, destDir) {
  let off = 0;
  fs.mkdirSync(destDir, { recursive: true });
  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    off += BLOCK;
    if (header.every((b) => b === 0)) break; // end marker
    const name = readStr(header, 0, 100);
    if (!name) break;
    const size = parseInt(readStr(header, 124, 12), 8) || 0;
    const type = String.fromCharCode(header[156]);
    const content = buf.subarray(off, off + size);
    off += Math.ceil(size / BLOCK) * BLOCK;
    const target = safeJoin(destDir, name);
    if (type === "5") {
      fs.mkdirSync(target, { recursive: true });
    } else if (type === "0" || type === "\0") {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    // other entry types (symlinks etc.) are ignored — static hosting doesn't need them
  }
}
