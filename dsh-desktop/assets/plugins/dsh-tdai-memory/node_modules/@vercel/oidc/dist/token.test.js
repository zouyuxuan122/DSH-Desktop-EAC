"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var import_crypto = require("crypto");
var import_vitest = require("vitest");
var os = __toESM(require("os"));
var path = __toESM(require("path"));
var fs = __toESM(require("fs"));
var import_token_io = require("./token-io");
var tokenUtil = __toESM(require("./token-util"));
var import_token = require("./token");
import_vitest.vi.mock("./token-io");
(0, import_vitest.describe)("refreshToken", () => {
  let rootDir;
  let userDataDir;
  let cliDataDir;
  let tokenDataDir;
  const projectId = "prj_test123";
  (0, import_vitest.beforeEach)(() => {
    import_vitest.vi.clearAllMocks();
    process.env.VERCEL_OIDC_TOKEN = void 0;
    const random = `test-${(0, import_crypto.randomUUID)()}`;
    rootDir = path.join(os.tmpdir(), random);
    userDataDir = path.join(rootDir, "data");
    cliDataDir = path.join(userDataDir, "com.vercel.cli");
    tokenDataDir = path.join(userDataDir, "com.vercel.token");
    fs.mkdirSync(cliDataDir, { recursive: true });
    fs.mkdirSync(tokenDataDir, { recursive: true });
    fs.mkdirSync(path.join(rootDir, ".vercel"), {
      recursive: true
    });
    fs.writeFileSync(path.join(cliDataDir, "auth.json"), '{token: "test"}');
    fs.writeFileSync(
      path.join(rootDir, ".vercel", "project.json"),
      JSON.stringify({ projectId })
    );
    import_vitest.vi.spyOn(process, "cwd").mockReturnValue(rootDir);
    import_vitest.vi.mocked(import_token_io.findRootDir).mockReturnValue(rootDir);
    import_vitest.vi.mocked(import_token_io.getUserDataDir).mockReturnValue(userDataDir);
    import_vitest.vi.spyOn(tokenUtil, "getVercelToken").mockResolvedValue("test");
    import_vitest.vi.spyOn(tokenUtil, "getVercelOidcToken").mockResolvedValue({
      token: "test-token"
    });
    import_vitest.vi.spyOn(tokenUtil, "getTokenPayload").mockReturnValue({
      sub: "test-sub",
      name: "test-name",
      exp: Date.now() + 1e5
    });
  });
  (0, import_vitest.test)("should correctly load saved token from file", async () => {
    const token = { token: "test-saved" };
    const tokenPath = path.join(tokenDataDir, `${projectId}.json`);
    fs.writeFileSync(tokenPath, JSON.stringify(token));
    await (0, import_token.refreshToken)();
    (0, import_vitest.expect)(process.env.VERCEL_OIDC_TOKEN).toBe("test-saved");
  });
  (0, import_vitest.test)("should correctly save token to file", async () => {
    await (0, import_token.refreshToken)();
    (0, import_vitest.expect)(process.env.VERCEL_OIDC_TOKEN).toBe("test-token");
    const tokenPath = path.join(tokenDataDir, `${projectId}.json`);
    const token = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
    (0, import_vitest.expect)(token).toEqual({ token: "test-token" });
  });
  (0, import_vitest.test)("should use provided team and project instead of reading project.json", async () => {
    const customProjectId = "prj_custom123";
    const customTeamId = "team_custom456";
    const getVercelOidcTokenSpy = import_vitest.vi.spyOn(tokenUtil, "getVercelOidcToken");
    const findRootDirSpy = import_vitest.vi.mocked(import_token_io.findRootDir);
    await (0, import_token.refreshToken)({ team: customTeamId, project: customProjectId });
    (0, import_vitest.expect)(findRootDirSpy).not.toHaveBeenCalled();
    (0, import_vitest.expect)(getVercelOidcTokenSpy).toHaveBeenCalledWith(
      "test",
      customProjectId,
      customTeamId
    );
    const tokenPath = path.join(tokenDataDir, `${customProjectId}.json`);
    (0, import_vitest.expect)(fs.existsSync(tokenPath)).toBe(true);
    const savedToken = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
    (0, import_vitest.expect)(savedToken).toEqual({ token: "test-token" });
  });
  (0, import_vitest.test)("should merge provided project with team from project.json", async () => {
    const customProjectId = "prj_custom234";
    const projectTeamId = "team_fromproject567";
    fs.writeFileSync(
      path.join(rootDir, ".vercel", "project.json"),
      JSON.stringify({ projectId, orgId: projectTeamId })
    );
    const getVercelOidcTokenSpy = import_vitest.vi.spyOn(tokenUtil, "getVercelOidcToken");
    await (0, import_token.refreshToken)({ project: customProjectId });
    (0, import_vitest.expect)(getVercelOidcTokenSpy).toHaveBeenCalledWith(
      "test",
      customProjectId,
      projectTeamId
    );
  });
  (0, import_vitest.test)("should merge provided team with project from project.json", async () => {
    const customTeamId = "team_custom789";
    const projectProjectId = "prj_fromjson123";
    fs.writeFileSync(
      path.join(rootDir, ".vercel", "project.json"),
      JSON.stringify({ projectId: projectProjectId, orgId: "original-team" })
    );
    const getVercelOidcTokenSpy = import_vitest.vi.spyOn(tokenUtil, "getVercelOidcToken");
    await (0, import_token.refreshToken)({ team: customTeamId });
    (0, import_vitest.expect)(getVercelOidcTokenSpy).toHaveBeenCalledWith(
      "test",
      projectProjectId,
      customTeamId
    );
  });
  (0, import_vitest.test)("should use cached token when valid with custom project", async () => {
    const customProjectId = "prj_customcached123";
    const customTeamId = "team_customcached456";
    const cachedToken = { token: "cached-valid-token" };
    const tokenPath = path.join(tokenDataDir, `${customProjectId}.json`);
    fs.writeFileSync(tokenPath, JSON.stringify(cachedToken));
    const getVercelOidcTokenSpy = import_vitest.vi.spyOn(tokenUtil, "getVercelOidcToken");
    await (0, import_token.refreshToken)({ team: customTeamId, project: customProjectId });
    (0, import_vitest.expect)(getVercelOidcTokenSpy).not.toHaveBeenCalled();
    (0, import_vitest.expect)(process.env.VERCEL_OIDC_TOKEN).toBe("cached-valid-token");
  });
  (0, import_vitest.test)("should refresh token when cached token expires within buffer", async () => {
    const customProjectId = "prj_buffertest123";
    const customTeamId = "team_buffertest456";
    const cachedToken = { token: "expiring-soon-token" };
    const tokenPath = path.join(tokenDataDir, `${customProjectId}.json`);
    fs.writeFileSync(tokenPath, JSON.stringify(cachedToken));
    const expiresIn3Minutes = Math.floor((Date.now() + 18e4) / 1e3);
    import_vitest.vi.spyOn(tokenUtil, "getTokenPayload").mockReturnValue({
      sub: "test-sub",
      name: "test-name",
      exp: expiresIn3Minutes
    });
    const getVercelOidcTokenSpy = import_vitest.vi.spyOn(tokenUtil, "getVercelOidcToken").mockResolvedValue({ token: "fresh-token" });
    await (0, import_token.refreshToken)({
      team: customTeamId,
      project: customProjectId,
      expirationBufferMs: 3e5
    });
    (0, import_vitest.expect)(getVercelOidcTokenSpy).toHaveBeenCalledWith(
      "test",
      customProjectId,
      customTeamId
    );
    (0, import_vitest.expect)(process.env.VERCEL_OIDC_TOKEN).toBe("fresh-token");
    const savedToken = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
    (0, import_vitest.expect)(savedToken).toEqual({ token: "fresh-token" });
  });
  (0, import_vitest.test)("should use cached token when it does not expire within buffer", async () => {
    const customProjectId = "prj_buffervalid123";
    const customTeamId = "team_buffervalid456";
    const cachedToken = { token: "valid-cached-token" };
    const tokenPath = path.join(tokenDataDir, `${customProjectId}.json`);
    fs.writeFileSync(tokenPath, JSON.stringify(cachedToken));
    const expiresIn10Minutes = Math.floor((Date.now() + 6e5) / 1e3);
    import_vitest.vi.spyOn(tokenUtil, "getTokenPayload").mockReturnValue({
      sub: "test-sub",
      name: "test-name",
      exp: expiresIn10Minutes
    });
    const getVercelOidcTokenSpy = import_vitest.vi.spyOn(tokenUtil, "getVercelOidcToken");
    await (0, import_token.refreshToken)({
      team: customTeamId,
      project: customProjectId,
      expirationBufferMs: 3e5
    });
    (0, import_vitest.expect)(getVercelOidcTokenSpy).not.toHaveBeenCalled();
    (0, import_vitest.expect)(process.env.VERCEL_OIDC_TOKEN).toBe("valid-cached-token");
  });
});
