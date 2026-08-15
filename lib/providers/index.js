// Provider registry: `deploy --provider netlify` dispatches here.

import * as local from "./local.js";
import * as netlify from "./netlify.js";
import * as vercel from "./vercel.js";
import * as cloudflare from "./cloudflare.js";
import * as s3 from "./s3.js";

export const PROVIDERS = { local, netlify, vercel, cloudflare, s3 };

export function getProvider(name) {
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(`Unknown provider "${name}". Available: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return provider;
}
