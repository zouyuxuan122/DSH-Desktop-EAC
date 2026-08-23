/**
 * Mobile-fix node half. Pure UI plugin: the empty apply exists so the plugin
 * appears in the web profile's cordis.yml / Loader; the browser half ships via
 * exports["./client"], discovered through the package.json dsh.client
 * declaration.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
function apply() {}
export { apply };
