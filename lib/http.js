// Shared HTTP helper: retries network failures and 5xx/429 responses with
// exponential backoff + jitter, enforces a timeout, and tags errors with
// provider/status/hint so the CLI can print actionable messages.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function taggedError(message, { status = 0, provider = null, hint = null } = {}) {
  const err = new Error(message);
  err.status = status;
  err.provider = provider;
  err.hint = hint;
  return err;
}

/**
 * fetch with retries. Returns the Response of the final attempt.
 * Retried: network errors, HTTP 408/425/429/5xx. Not retried: other 4xx.
 */
export async function apiFetch(url, { method = "GET", headers = {}, body, retries = 3, timeoutMs = 30000, provider = null, onRetry = null } = {}) {
  let attempt = 0;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { method, headers, body, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      if (attempt < retries) {
        const delay = backoff(attempt);
        onRetry?.(attempt + 1, retries, delay, "network");
        await sleep(delay);
        attempt++;
        continue;
      }
      const code = err.name === "AbortError" ? "timeout" : err.cause?.code || err.message;
      throw taggedError(
        code === "timeout"
          ? `${provider ? provider + " " : ""}request timed out after ${timeoutMs}ms`
          : `${provider ? provider + ": " : ""}network error (${code})`,
        { provider, hint: "Check your connection and retry." }
      );
    }
    clearTimeout(timer);
    const retryable = res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500;
    if (retryable && attempt < retries) {
      const delay = backoff(attempt, res.status === 429 ? 1500 : undefined);
      onRetry?.(attempt + 1, retries, delay, `HTTP ${res.status}`);
      await sleep(delay);
      attempt++;
      continue;
    }
    return res;
  }
}

function backoff(attempt, base = 500) {
  return Math.min(base * 2 ** attempt, 8000) + Math.random() * 250;
}

/** Common hints for auth/not-found/rate-limit responses. */
export function hintForStatus(status, provider, what = "resource") {
  if (status === 401 || status === 403) {
    return `${provider} rejected your token. Run: deploy login --provider ${provider}`;
  }
  if (status === 404) return `${what} not found on ${provider}.`;
  if (status === 429) return `${provider} rate-limited you. Wait a moment and retry (Netlify: 3 deploys/min, 100/day).`;
  if (status >= 500) return `${provider} had a server error — retrying usually helps.`;
  return null;
}
