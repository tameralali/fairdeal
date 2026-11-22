// Pages name their scripts and styles with the deployed commit, so browsers keep them; the pages
// themselves are checked every time. Running locally (no commit) everything is checked every time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/index.js';

async function serve(assetVersion) {
  const srv = createServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'aq-assets-')), mailer: null, assetVersion });
  const url = `http://127.0.0.1:${await srv.listen(0)}`;
  return { srv, url };
}

test('with a commit: versioned addresses, an import map for every module, and a year of caching', async () => {
  const { srv, url } = await serve('abc123def456');
  try {
    for (const p of ['/', '/t/some-table', '/hands/some-table', '/verify', '/admin']) {
      const r = await fetch(url + p);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers.get('cache-control'), 'no-cache', `${p} is always checked`);
      const html = await r.text();
      const map = JSON.parse(html.match(/<script type="importmap">(.*?)<\/script>/)[1]);
      assert.equal(map.imports['/js/api.js'], '/js/api.js?v=abc123def456');
      assert.equal(map.imports['/shared/money.js'], '/shared/money.js?v=abc123def456');
      for (const f of fs.readdirSync('public/js')) if (f.endsWith('.js')) assert.ok(map.imports[`/js/${f}`], `${f} is in the map`);
      for (const f of fs.readdirSync('shared')) if (f.endsWith('.js')) assert.ok(map.imports[`/shared/${f}`], `${f} is in the map`);
      assert.ok(html.indexOf('type="importmap"') < html.indexOf('type="module"'), 'the map comes before any module');
      for (const m of html.matchAll(/(?:src|href)="(\/(?:js|css)\/[^"]+)"/g)) assert.match(m[1], /\?v=abc123def456$/, `${m[1]} in ${p}`);
      assert.ok(!html.includes('/socket.io/socket.io.js'));
    }
    const js = await fetch(url + '/js/api.js?v=abc123def456');
    assert.equal(js.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const css = await fetch(url + '/css/table.css?v=abc123def456');
    assert.equal(css.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal((await fetch(url + '/shared/money.js?v=abc123def456')).headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal((await fetch(url + '/js/api.js')).headers.get('cache-control'), 'no-cache', 'no version: checked');
    assert.equal((await fetch(url + '/js/api.js?v=old')).headers.get('cache-control'), 'no-cache', 'an old version is not kept');
    const sock = await fetch(url + '/vendor/socket.io.min.js?v=abc123def456');
    assert.equal(sock.status, 200);
    assert.match(sock.headers.get('content-type'), /javascript/);
    assert.equal(sock.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.ok((await sock.text()).length > 10000);
    assert.equal((await fetch(url + '/fonts/inter-latin-400-normal.woff2')).headers.get('cache-control'), 'public, max-age=2592000');
    assert.equal((await fetch(url + '/sounds/deal-1.mp3')).headers.get('cache-control'), 'public, max-age=2592000');
    assert.equal((await fetch(url + '/healthz')).status, 200);
  } finally { await srv.close(); }
});

test('without a commit the pages are served as they are, and checked every time', async () => {
  const { srv, url } = await serve(null);
  try {
    const html = await (await fetch(url + '/')).text();
    assert.equal(html, fs.readFileSync('public/index.html', 'utf8'));
    const t = await (await fetch(url + '/t/x')).text();
    assert.equal(t, fs.readFileSync('public/table.html', 'utf8'));
    assert.equal((await fetch(url + '/js/api.js')).headers.get('cache-control'), 'no-cache');
    assert.equal((await fetch(url + '/js/api.js?v=abc')).headers.get('cache-control'), 'no-cache');
    assert.equal((await fetch(url + '/socket.io/socket.io.js')).status, 200, 'socket.io still serves its own copy');
  } finally { await srv.close(); }
});
