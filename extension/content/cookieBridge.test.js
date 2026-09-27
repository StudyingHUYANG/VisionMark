const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('cookie bridge only serves a Bilibili video content script', async () => {
  let listener;
  let reads = 0;
  const cookies = [
    { domain: '.bilibili.com', hostOnly: false, path: '/', secure: true, name: 'SESSDATA', value: 'synthetic-cookie', expirationDate: 1000 },
    { domain: '.other.example', name: 'other', value: 'synthetic-other' }
  ];
  const chrome = {
    runtime: { onMessage: { addListener: callback => { listener = callback; } } },
    cookies: { getAll: async () => { reads += 1; return cookies; } }
  };
  const context = vm.createContext({ chrome, URL });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8'), context);

  const request = sender => new Promise(resolve => {
    listener({ type: 'visionmark:bilibili-cookies' }, sender, resolve);
  });
  const denied = await request({ tab: { id: 1 }, url: 'https://example.com/video/BVTEST' });
  assert.equal(denied.error, 'Sender is not a Bilibili video page');
  assert.equal(reads, 0);

  const accepted = await request({ tab: { id: 1 }, url: 'https://www.bilibili.com/video/BVTEST' });
  assert.equal(reads, 1);
  assert.equal(accepted.cookies.length, 1);
  assert.equal(accepted.cookies[0].name, 'SESSDATA');
});

test('content utility formats allowed cookies for yt-dlp without direct cookies API', async () => {
  const chrome = { runtime: { sendMessage: async () => ({ cookies: [
    { domain: '.bilibili.com', hostOnly: false, path: '/', secure: true, name: 'SESSDATA', value: 'synthetic-cookie', expirationDate: 1000 }
  ] }) } };
  const window = {};
  const context = vm.createContext({ chrome, window, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'utils.js'), 'utf8'), context);

  const content = await window.VisionMarkCookieUtils.getBilibiliCookiesForYtDlp();
  assert.match(content, /\.bilibili\.com\tTRUE\t\/\tTRUE\t1000\tSESSDATA\tsynthetic-cookie/);
  assert.equal(await window.VisionMarkCookieUtils.isUserLoggedInToBilibili(), true);
});
