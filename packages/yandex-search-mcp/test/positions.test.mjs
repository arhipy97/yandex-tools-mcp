import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPositions } from '../src/serp.mjs';

const res = (n, siteAt) =>
  Array.from({ length: n }, (_, i) => ({
    position: i + 1,
    url: i + 1 === siteAt ? 'https://fluffme.design/ru/p' : `https://o${i}.com/`,
    host: i + 1 === siteAt ? 'fluffme.design' : `o${i}.com`,
  }));

test('found returns position and url', async () => {
  const rows = await checkPositions({ phrases: ['a'], regions: [213] }, async () => ({ results: res(40, 12) }));
  assert.deepEqual(rows, [
    { phrase: 'a', region: 213, status: 'found', position: 12, url: 'https://fluffme.design/ru/p' },
  ]);
});

test('not_found reports checked count', async () => {
  const rows = await checkPositions({ phrases: ['a'], regions: [157] }, async () => ({ results: res(37) }));
  assert.equal(rows[0].status, 'not_found');
  assert.equal(rows[0].checked, 37);
});

test('defaults: regions 157 and 213', async () => {
  const calls = [];
  const rows = await checkPositions({ phrases: ['a'] }, async (p, r, d) => {
    calls.push([p, r, d]);
    return { results: res(5, 1) };
  });
  assert.deepEqual(calls, [
    ['a', 157, 40],
    ['a', 213, 40],
  ]);
  assert.equal(rows.length, 2);
});

test('fetch failure becomes error row, others continue', async () => {
  const rows = await checkPositions({ phrases: ['a', 'b'], regions: [213] }, async (p) => {
    if (p === 'a') throw new Error('boom');
    return { results: res(10, 3) };
  });
  assert.equal(rows[0].status, 'error');
  assert.match(rows[0].error, /boom/);
  assert.equal(rows[1].status, 'found');
});

test('serp error becomes error row', async () => {
  const rows = await checkPositions({ phrases: ['a'], regions: [213] }, async () => ({ error: 'empty', results: [] }));
  assert.deepEqual(rows[0], { phrase: 'a', region: 213, status: 'error', error: 'empty' });
});

test('21 phrases rejected', async () => {
  await assert.rejects(
    checkPositions({ phrases: Array.from({ length: 21 }, (_, i) => `p${i}`) }, async () => ({ results: [] })),
    /phrases/,
  );
});

test('only first depth results count', async () => {
  const rows = await checkPositions({ phrases: ['a'], regions: [213] }, async () => ({ results: res(41, 41) }));
  assert.equal(rows[0].status, 'not_found');
  assert.equal(rows[0].checked, 40);
});

const instant = { gapMs: 0, retryMs: 0 };

test('requests run one at a time, spaced by gapMs', async () => {
  let active = 0;
  let maxActive = 0;
  const starts = [];
  const t0 = Date.now();
  await checkPositions(
    { phrases: ['a', 'b'], regions: [157, 213] },
    async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      starts.push(Date.now() - t0);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { results: res(5, 1) };
    },
    { gapMs: 30, retryMs: 0 },
  );
  assert.equal(maxActive, 1);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 28, `gap ${i}`);
});

test('quota error is retried once', async () => {
  let calls = 0;
  const rows = await checkPositions(
    { phrases: ['a'], regions: [213] },
    async () => {
      calls++;
      if (calls === 1) return { error: 'search-api.webSearchRequestsPerSecond.rate rate quota limit exceed', results: [] };
      return { results: res(10, 3) };
    },
    instant,
  );
  assert.equal(calls, 2);
  assert.equal(rows[0].status, 'found');
});

test('non-quota error is not retried', async () => {
  let calls = 0;
  const rows = await checkPositions(
    { phrases: ['a'], regions: [213] },
    async () => {
      calls++;
      return { error: 'empty', results: [] };
    },
    instant,
  );
  assert.equal(calls, 1);
  assert.equal(rows[0].status, 'error');
});
