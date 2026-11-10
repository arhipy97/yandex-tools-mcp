import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findSite, parseSerp } from '../src/serp.mjs';

const group = (url) => `<group><doc><url>${url}</url></doc></group>`;

test('parseSerp numbers groups from 1', () => {
  const xml = `<response>${group('https://a.com/')}${group('https://b.com/x')}${group('https://www.c.com/')}</response>`;
  const { error, results } = parseSerp(xml);
  assert.equal(error, undefined);
  assert.deepEqual(
    results.map((r) => [r.position, r.host]),
    [
      [1, 'a.com'],
      [2, 'b.com'],
      [3, 'www.c.com'],
    ],
  );
  assert.equal(results[1].url, 'https://b.com/x');
});

test('parseSerp reports yandex error', () => {
  const { error } = parseSerp('<response><error code="15">Nothing found</error></response>');
  assert.match(error, /15/);
  assert.match(error, /Nothing found/);
});

test('parseSerp empty input', () => {
  assert.equal(parseSerp('').error, 'empty');
});

test('parseSerp broken group', () => {
  const xml = `${group('https://a.com/')}<group><doc><title>x</title></doc></group>${group('https://c.com/')}`;
  const res = parseSerp(xml);
  assert.equal(res.error, 'broken group 2');
  assert.deepEqual(res.results, []);
});

test('findSite matches host and subdomains only', () => {
  const results = parseSerp(
    `${group('https://evil.com/fluffme.design')}${group('https://www.fluffme.design/x')}${group('https://ru.fluffme.design/')}`,
  ).results;
  assert.deepEqual(findSite(results, 'fluffme.design'), { position: 2, url: 'https://www.fluffme.design/x' });
  assert.equal(findSite(results.slice(0, 1), 'fluffme.design'), null);
});
