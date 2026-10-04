export async function fetchJson(url, opts = {}, timeoutMs = 15000) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${new URL(url).host}${new URL(url).pathname}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export async function fetchBuffer(url, opts = {}, timeoutMs = 20000) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${new URL(url).host}`);
  return Buffer.from(await res.arrayBuffer());
}
