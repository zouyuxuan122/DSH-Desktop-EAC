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
var auth_errors_exports = {};
__export(auth_errors_exports, {
  AccessTokenMissingError: () => AccessTokenMissingError,
  RefreshAccessTokenFailedError: () => RefreshAccessTokenFailedError
});
module.exports = __toCommonJS(auth_errors_exports);
class AccessTokenMissingError extends Error {
  constructor() {
    super(
      "No authentication found. Please log in with the Vercel CLI (vercel login)."
    );
    this.name = "AccessTokenMissingError";
  }
}
class RefreshAccessTokenFailedError extends Error {
  constructor(cause) {
    super("Failed to refresh authentication token.", { cause });
    this.name = "RefreshAccessTokenFailedError";
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AccessTokenMissingError,
  RefreshAccessTokenFailedError
});
