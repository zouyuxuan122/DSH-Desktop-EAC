import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isSafeNpmVersion, isSafeWslInstallDir } = require("../wsl-backend.js")._internals;

test("WSL install paths reject shell metacharacters", () => {
  assert.equal(isSafeWslInstallDir("/home/user/.dsh-desktop"), true);
  assert.equal(isSafeWslInstallDir("/home/用户/.dsh-desktop"), true);
  assert.equal(isSafeWslInstallDir("/tmp/x;touch${IFS}/tmp/pwn"), false);
  assert.equal(isSafeWslInstallDir("/tmp/$(touch-pwn)"), false);
  assert.equal(isSafeWslInstallDir("/tmp/has space"), false);
});

test("WSL npm versions reject shell and package-spec injection", () => {
  assert.equal(isSafeNpmVersion("0.1.0-rc.7"), true);
  assert.equal(isSafeNpmVersion("latest"), true);
  assert.equal(isSafeNpmVersion("1.2.3+build.4"), true);
  assert.equal(isSafeNpmVersion("1.2.3;touch-pwn"), false);
  assert.equal(isSafeNpmVersion("1.2.3 || true"), false);
});
