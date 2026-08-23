//#region src/invariant.ts
const PACKAGE_NAME = "dsh-better-sidebar";
/** Cordis companion plugin name. */
const name = "dsh-better-sidebar-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the sidebar owns no service state or event protocol
* of its own — every route is mounted under the host's webServer fence, the
* pty lifecycle is exercised by the smoke spec, and the panel's store is a
* plain snapshot registry asserted by the behavior specs. The route fence,
* pty quota, and store semantics are each observed through their seams.
*/
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
