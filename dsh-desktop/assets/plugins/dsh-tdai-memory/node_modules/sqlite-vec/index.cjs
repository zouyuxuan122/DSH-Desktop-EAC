

const { join } = require("node:path");
const { fileURLToPath } = require("node:url");
const { arch, platform } = require("node:process");
const { statSync } = require("node:fs");


const BASE_PACKAGE_NAME = "sqlite-vec";
const ENTRYPOINT_BASE_NAME = "vec0";
const supportedPlatforms = [["macos","aarch64"],["linux","aarch64"],["windows","x86_64"],["linux","x86_64"],["macos","x86_64"]];

const invalidPlatformErrorMessage = `Unsupported platform for ${BASE_PACKAGE_NAME}, on a ${platform}-${arch} machine. Supported platforms are (${supportedPlatforms
  .map(([p, a]) => `${p}-${a}`)
  .join(",")}). Consult the ${BASE_PACKAGE_NAME} NPM package README for details.`;

const extensionNotFoundErrorMessage = packageName => `Loadble extension for ${BASE_PACKAGE_NAME} not found. Was the ${packageName} package installed?`;

function validPlatform(platform, arch) {
  return (
    supportedPlatforms.find(([p, a]) => platform == p && arch === a) !== null
  );
}
function extensionSuffix(platform) {
  if (platform === "win32") return "dll";
  if (platform === "darwin") return "dylib";
  return "so";
}
function platformPackageName(platform, arch) {
  const os = platform === "win32" ? "windows" : platform;
  return `${BASE_PACKAGE_NAME}-${os}-${arch}`;
}

function getLoadablePath() {
  if (!validPlatform(platform, arch)) {
    throw new Error(
      invalidPlatformErrorMessage
    );
  }
  const packageName = platformPackageName(platform, arch);
  const loadablePath = join(
    __dirname,
    "..",
    packageName,
    `${ENTRYPOINT_BASE_NAME}.${extensionSuffix(platform)}`
  );
  if (!statSync(loadablePath, { throwIfNoEntry: false })) {
    throw new Error(extensionNotFoundErrorMessage(packageName));
  }

  return loadablePath;
}

function load(db) {
  db.loadExtension(getLoadablePath());
}

module.exports = {getLoadablePath, load};
