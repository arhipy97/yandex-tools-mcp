// Compact SERP parsing and rank checking for the `positions` tool.

export function parseSerp(xml) {
  const err = xml.match(/<error(?:\s[^>]*)?>([\s\S]*?)<\/error>/);
  if (err) {
    const code = err[0].match(/code="([^"]*)"/)?.[1] ?? '?';
    return { error: `yandex ${code}: ${err[1].trim()}`, results: [] };
  }

  const groups = [...xml.matchAll(/<group>([\s\S]*?)<\/group>/g)];
  if (groups.length === 0) return { error: 'empty', results: [] };

  const results = [];
  for (const [i, g] of groups.entries()) {
    const url = g[1].match(/<doc(?:\s[^>]*)?>[\s\S]*?<url>([^<]+)<\/url>/)?.[1];
    let host;
    try {
      host = url && new URL(url).hostname.toLowerCase();
    } catch {
      host = undefined;
    }
    if (!url || !host) return { error: `broken group ${i + 1}`, results: [] };
    results.push({ position: i + 1, url, host });
  }
  return { results };
}

export function normalizeDomain(domain) {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
}

export function findSite(results, domain) {
  const d = normalizeDomain(domain);
  const hit = results.find((r) => r.host === d || r.host.endsWith(`.${d}`));
  return hit ? { position: hit.position, url: hit.url } : null;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function checkPositions(
  { phrases, regions = [157, 213], domain = 'fluffme.design', depth = 40 },
  fetchSerp,
) {
  if (!Array.isArray(phrases) || phrases.length < 1 || phrases.length > 20) {
    throw new Error('phrases: expected 1 to 20 items');
  }
  const pairs = phrases.flatMap((phrase) => regions.map((region) => ({ phrase, region })));
  return mapLimit(pairs, 4, async ({ phrase, region }) => {
    try {
      const { error, results } = await fetchSerp(phrase, region, depth);
      if (error) return { phrase, region, status: 'error', error };
      const hit = findSite(results, domain);
      if (hit) return { phrase, region, status: 'found', position: hit.position, url: hit.url };
      return { phrase, region, status: 'not_found', checked: results.length };
    } catch (e) {
      return { phrase, region, status: 'error', error: e instanceof Error ? e.message : String(e) };
    }
  });
}
