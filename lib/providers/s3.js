// S3 provider (static hosting via the object store). Signs every request with
// AWS Signature V4 — no SDK required. Uploads files under a prefix; list uses
// ListObjectsV2. rollback is not supported in plain S3 and reports it clearly.
// Credentials: providers.s3.{accessKeyId, secretAccessKey, bucket, region} or
// AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION env vars.
// AWS_S3_ENDPOINT overrides the endpoint (path-style) — used by tests.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { apiFetch, hintForStatus, mapConcurrent, taggedError } from "../http.js";
import { progress } from "../format.js";
import { preflight } from "../preflight.js";

export const name = "s3";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export function mimeTypeFor(filePath) {
  return MIME_TYPES[path.extname(String(filePath)).toLowerCase()] || "application/octet-stream";
}

const ENDPOINT = () => process.env.AWS_S3_ENDPOINT || null;

function credsFor(config) {
  const s3 = config.providers?.s3 || {};
  const accessKeyId = s3.accessKeyId || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = s3.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY;
  const region = s3.region || process.env.AWS_REGION || "us-east-1";
  const bucket = s3.bucket;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("S3 credentials missing. Run: deploy login --provider s3 --access-key <AK> --secret-key <SK> --bucket <name>");
  }
  if (!bucket) {
    throw new Error("S3 bucket missing. Run: deploy login --provider s3 ... --bucket <name>");
  }
  return { accessKeyId, secretAccessKey, region, bucket };
}

function prefixFor({ flags, config, project }) {
  return (flags.prefix || config.providers?.s3?.prefix || project).replace(/^\/+|\/+$/g, "");
}

function sha256hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

/** AWS Signature V4 for S3 (path-style when endpoint is set, else virtual-hosted). */
export function sign({ accessKeyId, secretAccessKey, region, bucket, key, method = "PUT", query = {}, payloadHash, contentType = null, date = new Date(), endpoint = null }) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const host = endpoint ? new URL(endpoint).host : `${bucket}.s3.${region}.amazonaws.com`;
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  // path-style requests (endpoint override) put the bucket in the canonical URI
  const canonicalUri = endpoint ? `/${bucket}/${encodedKey}` : `/${encodedKey}`;
  const canonicalQuery = Object.entries(query)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const canonicalHeaders = `host:${host}\n${contentType ? `content-type:${contentType}\n` : ""}x-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = contentType
    ? "content-type;host;x-amz-content-sha256;x-amz-date"
    : "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(canonicalRequest)}`;
  const kDate = hmac("AWS4" + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    amzDate,
    payloadHash,
    host,
    encodedKey,
    canonicalQuery,
    canonicalRequest,
  };
}

/** Sign a PutObject request (kept for direct unit testing). */
export function signPut(opts) {
  const contentType = opts.contentType || mimeTypeFor(opts.key || "");
  return sign({ ...opts, method: "PUT", query: {}, payloadHash: sha256hex(opts.content), contentType });
}

export async function s3Fetch(creds, { key = "", method, query = {}, body = null, contentType = null }) {
  const endpoint = ENDPOINT();
  const payloadHash = body ? sha256hex(body) : sha256hex("");
  const signed = sign({ ...creds, key, method, query, payloadHash, contentType, endpoint });
  const url = endpoint
    ? `${endpoint}/${creds.bucket}${key ? "/" + signed.encodedKey : ""}${query && signed.canonicalQuery ? "?" + signed.canonicalQuery : ""}`
    : `https://${signed.host}${key ? "/" + signed.encodedKey : ""}${signed.canonicalQuery ? "?" + signed.canonicalQuery : ""}`;
  const res = await apiFetch(url, {
    method,
    headers: {
      Authorization: signed.authorization,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": signed.amzDate,
      Host: signed.host,
      ...(contentType ? { "Content-Type": contentType } : {}),
    },
    body: body || undefined,
    retries: 3,
    provider: "s3",
  });
  if (!res.ok) {
    const data = await res.text().catch(() => "");
    throw taggedError(`S3 API ${res.status} for ${key || "list"}: ${data.slice(0, 200) || res.statusText}`, {
      status: res.status,
      provider: "s3",
      hint: hintForStatus(res.status, "s3", key || "bucket"),
    });
  }
  return res;
}

export async function login({ flags }) {
  const accessKeyId = flags.accessKey || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = flags.secretKey || process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Pass --access-key and --secret-key (or set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)");
  }
  if (!flags.bucket) throw new Error("Pass --bucket <name>");
  return {
    accessKeyId,
    secretAccessKey,
    bucket: flags.bucket,
    region: flags.region || process.env.AWS_REGION || "us-east-1",
    prefix: flags.prefix || null,
  };
}

export async function deploy({ project, outDir, branch, preview, flags, config, rc }) {
  const creds = credsFor(config);
  const prefix = prefixFor({ flags, config, project });
  const pre = await preflight(outDir, { force: !!flags.force });
  console.log(`→ ${pre.count} files, ${(pre.total / 1024).toFixed(0)} KB (s3://${creds.bucket}/${prefix})`);

  let done = 0;
  await mapConcurrent(pre.files, 6, async (f) => {
    const content = await fs.promises.readFile(f.path);
    const contentType = mimeTypeFor(f.rel);
    await s3Fetch(creds, { key: `${prefix}/${f.rel}`, method: "PUT", body: content, contentType });
    done++;
    progress("uploading", done, pre.count);
  });
  const host = ENDPOINT() ? new URL(ENDPOINT()).host : `${creds.bucket}.s3.${creds.region}.amazonaws.com`;
  const url = `https://${host}/${prefix}/`;
  return { id: null, url, deployUrl: url, state: "uploaded", bucket: creds.bucket, prefix };
}

export async function rollback() {
  throw new Error(
    "S3 has no built-in rollback — restore from a previous deploy's files and re-run deploy, or enable S3 versioning + a proxy."
  );
}

export async function list({ project, flags, config, rc }) {
  const creds = credsFor(config);
  const prefix = prefixFor({ flags, config, project }) + "/";
  const res = await s3Fetch(creds, { key: "", method: "GET", query: { "list-type": "2", prefix } });
  const xml = await res.text();
  const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
  const times = [...xml.matchAll(/<LastModified>([^<]+)<\/LastModified>/g)].map((m) => m[1]);
  return keys.map((k, i) => ({
    id: k,
    createdAt: times[i] || null,
    branch: "main",
    url: `https://${creds.bucket}.s3.${creds.region}.amazonaws.com/${k}`,
    production: true,
  }));
}
