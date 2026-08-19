/**
 * Settings-scroll-fix host half. Pure client-side CSS fix: the empty apply
 * exists so the plugin appears in the web profile's cordis.yml / Loader; the
 * browser half ships via exports["./client"], discovered through the
 * package.json dsh.client declaration.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply() {
  // host half intentionally empty; this is a client-side CSS fix
}
