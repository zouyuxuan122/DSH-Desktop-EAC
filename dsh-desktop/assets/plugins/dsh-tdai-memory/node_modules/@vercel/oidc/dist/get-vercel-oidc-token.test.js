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
var import_get_vercel_oidc_token = require("./get-vercel-oidc-token");
var tokenUtil = __toESM(require("./token-util"));
import_vitest.vi.mock("./token-io");
import_vitest.vi.mock("./get-context", () => ({
  getContext: () => ({ headers: {} })
}));
(0, import_vitest.describe)("getVercelOidcToken - Error Scenarios", () => {
  let rootDir;
  let userDataDir;
  let cliDataDir;
  let tokenDataDir;
  const projectId = "prj_test123";
  const teamId = "team_test456";
  (0, import_vitest.beforeEach)(() => {
    import_vitest.vi.clearAllMocks();
    import_vitest.vi.restoreAllMocks();
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
    import_vitest.vi.spyOn(process, "cwd").mockReturnValue(rootDir);
    import_vitest.vi.mocked(import_token_io.findRootDir).mockReturnValue(rootDir);
    import_vitest.vi.mocked(import_token_io.getUserDataDir).mockReturnValue(userDataDir);
  });
  (0, import_vitest.afterEach)(() => {
    if (fs.existsSync(rootDir)) {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
  (0, import_vitest.test)("should throw AccessTokenMissingError when CLI auth file is missing", async () => {
    fs.writeFileSync(
      path.join(rootDir, ".vercel", "project.json"),
      JSON.stringify({ projectId, orgId: teamId })
    );
    process.env.VERCEL_OIDC_TOKEN = createExpiredToken();
    await (0, import_vitest.expect)((0, import_get_vercel_oidc_token.getVercelOidcToken)()).rejects.toThrow(
      /No authentication found/
    );
  });
  (0, import_vitest.test)("should throw helpful error when project.json is missing", async () => {
    fs.writeFileSync(
      path.join(cliDataDir, "auth.json"),
      JSON.stringify({ token: "test-auth-token" })
    );
    process.env.VERCEL_OIDC_TOKEN = createExpiredToken();
    await (0, import_vitest.expect)((0, import_get_vercel_oidc_token.getVercelOidcToken)()).rejects.toThrow(
      /project\.json not found, have you linked your project with `vc link\?`/
    );
  });
  (0, import_vitest.test)("should throw helpful error when root directory cannot be found", async () => {
    import_vitest.vi.mocked(import_token_io.findRootDir).mockReturnValue(null);
    process.env.VERCEL_OIDC_TOKEN = createExpiredToken();
    await (0, import_vitest.expect)((0, import_get_vercel_oidc_token.getVercelOidcToken)()).rejects.toThrow(
      /Unable to find project root directory\. Have you linked your project with `vc link\?`/
    );
  });
  (0, import_vitest.test)("should throw helpful error when user data directory cannot be found", async () => {
    fs.writeFileSync(
      path.join(rootDir, ".vercel", "project.json"),
      JSON.stringify({ projectId, orgId: teamId })
    );
    import_vitest.vi.mocked(import_token_io.getUserDataDir).mockReturnValue(null);
    process.env.VERCEL_OIDC_TOKEN = createExpiredToken();
    await (0, import_vitest.expect)((0, import_get_vercel_oidc_token.getVercelOidcToken)()).rejects.toThrow(
      /Unable to find user data directory\. Please reach out to Vercel support\./
    );
  });
  (0, import_vitest.test)("should throw helpful error when API returns non-200", async () => {
    fs.writeFileSync(
      path.join(cliDataDir, "auth.json"),
      JSON.stringify({ token: "test-auth-token" })
    );
    fs.writeFileSync(
      path.join(rootDir, ".vercel", "project.json"),
      JSON.stringify({ projectId, orgId: teamId })
    );
    import_vitest.vi.spyOn(tokenUtil, "getVercelOidcToken").mockRejectedValue(
      new Error("Failed to refresh OIDC token: Unauthorized")
    );
    process.env.VERCEL_OIDC_TOKEN = createExpiredToken();
    await (0, import_vitest.expect)((0, import_get_vercel_oidc_token.getVercelOidcToken)()).rejects.toThrow(
      /Failed to refresh OIDC token: Unauthorized/
    );
  });
  (0, import_vitest.test)("should throw helpful error when token response is malformed", async () => {
    fs.writeFileSync(
      path.join(cliDataDir, "auth.json"),
      JSON.stringify({ token: "test-auth-token" })
    );
    fs.writeFileSync(
      path.join(rootDir, ".vercel", "project.json"),
      JSON.stringify({ projectId, orgId: teamId })
    );
    import_vitest.vi.spyOn(tokenUtil, "getVercelOidcToken").mockRejectedValue(
      new TypeError(
        "Vercel OIDC token is malformed. Expected a string-valued token property. Please run `vc env pull` and try again"
      )
    );
    process.env.VERCEL_OIDC_TOKEN = createExpiredToken();
    await (0, import_vitest.expect)((0, import_get_vercel_oidc_token.getVercelOidcToken)()).rejects.toThrow(
      /Vercel OIDC token is malformed\. Expected a string-valued token property\. Please run `vc env pull` and try again/
    );
  });
  (0, import_vitest.test)("should throw helpful error when token has invalid format", async () => {
    process.env.VERCEL_OIDC_TOKEN = "not-a-valid-jwt-token";
    import_vitest.vi.spyOn(tokenUtil, "getTokenPayload").mockImplementation(() => {
      throw new Error("Invalid token. Please run `vc env pull` and try again");
    });
    await (0, import_vitest.expect)((0, import_get_vercel_oidc_token.getVercelOidcToken)()).rejects.toThrow(
      /Invalid token\. Please run `vc env pull` and try again/
    );
  });
  (0, import_vitest.test)("should throw error when token expiry check fails", async () => {
    process.env.VERCEL_OIDC_TOKEN = "not-a-jwt-token";
    await (0, import_vitest.expect)((0, import_get_vercel_oidc_token.getVercelOidcToken)()).rejects.toThrow(
      /Invalid token\. Please run `vc env pull` and try again/
    );
  });
  (0, import_vitest.test)("should fail when no token exists and no CLI credentials available", async () => {
    process.env.VERCEL_OIDC_TOKEN = void 0;
    await (0, import_vitest.expect)((0, import_get_vercel_oidc_token.getVercelOidcToken)()).rejects.toThrow(/Invalid token/);
  });
  (0, import_vitest.test)("should propagate filesystem errors when saving token fails", async () => {
    fs.writeFileSync(
      path.join(cliDataDir, "auth.json"),
      JSON.stringify({ token: "test-auth-token" })
    );
    fs.writeFileSync(
      path.join(rootDir, ".vercel", "project.json"),
      JSON.stringify({ projectId, orgId: teamId })
    );
    import_vitest.vi.spyOn(tokenUtil, "getVercelOidcToken").mockResolvedValue({
      token: "new-valid-token"
    });
    import_vitest.vi.spyOn(tokenUtil, "getTokenPayload").mockReturnValue({
      sub: "test-sub",
      name: "test-name",
      exp: Date.now() / 1e3 - 1e3
    });
    import_vitest.vi.spyOn(tokenUtil, "saveToken").mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    process.env.VERCEL_OIDC_TOKEN = createExpiredToken();
    await (0, import_vitest.expect)((0, import_get_vercel_oidc_token.getVercelOidcToken)()).rejects.toThrow(/EACCES|permission/i);
  });
  (0, import_vitest.test)("should succeed when valid token exists in env", async () => {
    const validToken = createValidToken();
    process.env.VERCEL_OIDC_TOKEN = validToken;
    import_vitest.vi.spyOn(tokenUtil, "getTokenPayload").mockReturnValue({
      sub: "test-sub",
      name: "test-name",
      exp: Date.now() / 1e3 + 43200
    });
    const token = await (0, import_get_vercel_oidc_token.getVercelOidcToken)();
    (0, import_vitest.expect)(token).toBe(validToken);
  });
  (0, import_vitest.test)("should refresh when token is expired but all configs are valid", async () => {
    fs.writeFileSync(
      path.join(cliDataDir, "auth.json"),
      JSON.stringify({ token: "test-auth-token" })
    );
    fs.writeFileSync(
      path.join(rootDir, ".vercel", "project.json"),
      JSON.stringify({ projectId, orgId: teamId })
    );
    const newToken = createValidToken("new-token");
    import_vitest.vi.spyOn(tokenUtil, "getVercelOidcToken").mockResolvedValue({
      token: newToken
    });
    import_vitest.vi.spyOn(tokenUtil, "getTokenPayload").mockReturnValueOnce({
      sub: "test-sub",
      name: "test-name",
      exp: Date.now() / 1e3 - 1e3
    }).mockReturnValue({
      sub: "test-sub",
      name: "test-name",
      exp: Date.now() / 1e3 + 43200
    });
    process.env.VERCEL_OIDC_TOKEN = createExpiredToken();
    const token = await (0, import_get_vercel_oidc_token.getVercelOidcToken)();
    (0, import_vitest.expect)(token).toBe(newToken);
  });
  (0, import_vitest.test)("should use provided team and project for refresh instead of reading project.json", async () => {
    const customProjectId = "prj_custom123";
    const customTeamId = "team_custom456";
    fs.writeFileSync(
      path.join(cliDataDir, "auth.json"),
      JSON.stringify({ token: "test-auth-token" })
    );
    const newToken = createValidToken("custom-token");
    const getVercelOidcTokenSpy = import_vitest.vi.spyOn(tokenUtil, "getVercelOidcToken").mockResolvedValue({
      token: newToken
    });
    import_vitest.vi.spyOn(tokenUtil, "getTokenPayload").mockReturnValueOnce({
      sub: "test-sub",
      name: "test-name",
      exp: Date.now() / 1e3 - 1e3
    }).mockReturnValue({
      sub: "test-sub",
      name: "test-name",
      exp: Date.now() / 1e3 + 43200
    });
    process.env.VERCEL_OIDC_TOKEN = createExpiredToken();
    const token = await (0, import_get_vercel_oidc_token.getVercelOidcToken)({
      team: customTeamId,
      project: customProjectId
    });
    (0, import_vitest.expect)(token).toBe(newToken);
    (0, import_vitest.expect)(getVercelOidcTokenSpy).toHaveBeenCalledWith(
      "test-auth-token",
      customProjectId,
      customTeamId
    );
  });
  (0, import_vitest.test)("should use provided project and read team from project.json", async () => {
    const customProjectId = "prj_custom234";
    fs.writeFileSync(
      path.join(cliDataDir, "auth.json"),
      JSON.stringify({ token: "test-auth-token" })
    );
    fs.writeFileSync(
      path.join(rootDir, ".vercel", "project.json"),
      JSON.stringify({ projectId: "original-project-id", orgId: teamId })
    );
    const newToken = createValidToken("partial-custom-token");
    const getVercelOidcTokenSpy = import_vitest.vi.spyOn(tokenUtil, "getVercelOidcToken").mockResolvedValue({
      token: newToken
    });
    import_vitest.vi.spyOn(tokenUtil, "getTokenPayload").mockReturnValueOnce({
      sub: "test-sub",
      name: "test-name",
      exp: Date.now() / 1e3 - 1e3
    }).mockReturnValue({
      sub: "test-sub",
      name: "test-name",
      exp: Date.now() / 1e3 + 43200
    });
    process.env.VERCEL_OIDC_TOKEN = createExpiredToken();
    const token = await (0, import_get_vercel_oidc_token.getVercelOidcToken)({
      project: customProjectId
    });
    (0, import_vitest.expect)(token).toBe(newToken);
    (0, import_vitest.expect)(getVercelOidcTokenSpy).toHaveBeenCalledWith(
      "test-auth-token",
      customProjectId,
      teamId
    );
  });
  (0, import_vitest.test)("should use provided team and read project from project.json", async () => {
    const customTeamId = "team_custom789";
    fs.writeFileSync(
      path.join(cliDataDir, "auth.json"),
      JSON.stringify({ token: "test-auth-token" })
    );
    fs.writeFileSync(
      path.join(rootDir, ".vercel", "project.json"),
      JSON.stringify({ projectId, orgId: "original-team-id" })
    );
    const newToken = createValidToken("partial-custom-token-2");
    const getVercelOidcTokenSpy = import_vitest.vi.spyOn(tokenUtil, "getVercelOidcToken").mockResolvedValue({
      token: newToken
    });
    import_vitest.vi.spyOn(tokenUtil, "getTokenPayload").mockReturnValueOnce({
      sub: "test-sub",
      name: "test-name",
      exp: Date.now() / 1e3 - 1e3
    }).mockReturnValue({
      sub: "test-sub",
      name: "test-name",
      exp: Date.now() / 1e3 + 43200
    });
    process.env.VERCEL_OIDC_TOKEN = createExpiredToken();
    const token = await (0, import_get_vercel_oidc_token.getVercelOidcToken)({
      team: customTeamId
    });
    (0, import_vitest.expect)(token).toBe(newToken);
    (0, import_vitest.expect)(getVercelOidcTokenSpy).toHaveBeenCalledWith(
      "test-auth-token",
      projectId,
      customTeamId
    );
  });
  (0, import_vitest.test)("should not refresh when token is valid even with options provided", async () => {
    const validToken = createValidToken();
    process.env.VERCEL_OIDC_TOKEN = validToken;
    const getVercelOidcTokenSpy = import_vitest.vi.spyOn(tokenUtil, "getVercelOidcToken").mockResolvedValue({
      token: "should-not-be-called"
    });
    import_vitest.vi.spyOn(tokenUtil, "getTokenPayload").mockReturnValue({
      sub: "test-sub",
      name: "test-name",
      exp: Date.now() / 1e3 + 43200
    });
    const token = await (0, import_get_vercel_oidc_token.getVercelOidcToken)({
      team: "custom-team",
      project: "custom-project"
    });
    (0, import_vitest.expect)(token).toBe(validToken);
    (0, import_vitest.expect)(getVercelOidcTokenSpy).not.toHaveBeenCalled();
  });
});
function createExpiredToken() {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" })
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: "test-sub",
      exp: 1,
      iat: 1
    })
  ).toString("base64url");
  return `${header}.${payload}.fake_signature`;
}
function createValidToken(value = "valid-token") {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" })
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: "test-sub",
      exp: Math.floor(Date.now() / 1e3) + 43200,
      iat: Math.floor(Date.now() / 1e3)
    })
  ).toString("base64url");
  return `${header}.${payload}.fake_signature_${value}`;
}
