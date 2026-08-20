import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { shouldIncludeBundledPluginPath } = require("../scripts/after-pack.js");

test("afterPack excludes local plugin repair backups", () => {
  const root = join("tmp", "assets", "plugins");
  assert.equal(shouldIncludeBundledPluginPath(join(root, "plugin", "lib", "index.js"), root), true);
  assert.equal(
    shouldIncludeBundledPluginPath(join(root, "plugin", "lib", "index.js.bak-dsh-fix"), root),
    false
  );
  assert.equal(
    shouldIncludeBundledPluginPath(join(root, "plugin", ".backup-before-install", "index.js"), root),
    false
  );
});
