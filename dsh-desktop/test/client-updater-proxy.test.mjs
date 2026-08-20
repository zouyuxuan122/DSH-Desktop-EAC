import test from 'node:test';
import assert from 'node:assert/strict';

import { githubProxyUrl, downloadUrls } from '../client-updater.js';

const GITHUB_ASSET =
  'https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/download/v4.4/Deepseek-Harness-EAC-Setup-x64.exe';
const GITEE_ASSET =
  'https://gitee.com/zouyuxuan122/Deepseek-Harness-EAC/releases/download/v4.4/Deepseek-Harness-EAC-Setup-x64.exe';

test('githubProxyUrl only proxies GitHub asset URLs', () => {
  assert.equal(
    githubProxyUrl(GITHUB_ASSET),
    'https://gh.geekertao.top/' + GITHUB_ASSET,
  );
  assert.equal(githubProxyUrl(GITEE_ASSET), null);
  assert.equal(githubProxyUrl('https://github.com.evil.example/download.exe'), null);
  assert.equal(githubProxyUrl(''), null);
});

test('downloadUrls puts the proxy before GitHub and other fallback sources', () => {
  assert.deepEqual(downloadUrls(GITHUB_ASSET, [GITEE_ASSET]), [
    'https://gh.geekertao.top/' + GITHUB_ASSET,
    GITHUB_ASSET,
    GITEE_ASSET,
  ]);
});

test('downloadUrls keeps non-GitHub sources unchanged and removes duplicates', () => {
  assert.deepEqual(downloadUrls(GITEE_ASSET, [GITEE_ASSET, '']), [GITEE_ASSET]);
});
