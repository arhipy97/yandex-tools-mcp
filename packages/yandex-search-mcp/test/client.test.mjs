import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchSerp, requestXml } from '../src/client.mjs';

const env = { YANDEX_SEARCH_API_KEY: 'k', YANDEX_FOLDER_ID: 'f' };
const resp = (status, body) => async () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

test('requestXml rejects on HTTP error', async () => {
  await assert.rejects(requestXml({}, 'k', resp(403, { message: 'denied' })), /denied/);
});

test('requestXml rejects without rawData', async () => {
  await assert.rejects(requestXml({}, 'k', resp(200, {})), /rawData/);
});

test('fetchSerp returns error on HTTP error and missing rawData', async () => {
  const a = await fetchSerp('q', 213, 40, { fetchImpl: resp(500, 'x'), env });
  assert.ok(a.error);
  const b = await fetchSerp('q', 213, 40, { fetchImpl: resp(200, {}), env });
  assert.match(b.error, /rawData/);
});

test('fetchSerp parses a good response', async () => {
  const xml = '<group><doc><url>https://a.com/</url></doc></group>';
  const rawData = Buffer.from(xml).toString('base64');
  const r = await fetchSerp('q', 213, 40, { fetchImpl: resp(200, { rawData }), env });
  assert.equal(r.results[0].host, 'a.com');
});
