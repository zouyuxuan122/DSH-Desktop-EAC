"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var index_browser_exports = {};
__export(index_browser_exports, {
  AccessTokenMissingError: () => import_auth_errors.AccessTokenMissingError,
  RefreshAccessTokenFailedError: () => import_auth_errors.RefreshAccessTokenFailedError,
  getContext: () => import_get_context.getContext,
  getVercelOidcToken: () => getVercelOidcToken,
  getVercelOidcTokenSync: () => getVercelOidcTokenSync,
  getVercelToken: () => getVercelToken
});
module.exports = __toCommonJS(index_browser_exports);
var import_get_context = require("./get-context");
var import_auth_errors = require("./auth-errors");
async function getVercelOidcToken() {
  return "";
}
function getVercelOidcTokenSync() {
  return "";
}
async function getVercelToken() {
  throw new Error("getVercelToken is not supported in browser environments");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AccessTokenMissingError,
  RefreshAccessTokenFailedError,
  getContext,
  getVercelOidcToken,
  getVercelOidcTokenSync,
  getVercelToken
});
