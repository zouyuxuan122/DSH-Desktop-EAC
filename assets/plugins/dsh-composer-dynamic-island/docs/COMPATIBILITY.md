# Compatibility and conformance boundary

## Community v0.15

`dsh-plugin.json` is the only Community v0.15 manifest in this package. It
declares one `facets.host` entry, no required contracts, no permissions, no
subscriptions, and no contributions. `lib/types/index.js` is DOM-free and can run in
a headless process. Its activation has no persistent effect and needs no
cleanup resource.

The manifest intentionally does not declare `client`, `worker`, `services`, or
`provides`, because the v0.15 schema rejects those surfaces.

Passing the schema and admission tests proves only manifest parsing and the
reported negotiation result for the tested host descriptor. It is not an
official certification, security review, or universal DSH compatibility claim.

## Optional DSH Web adapter

`lib/client.js`, `package.json#dsh.client`, and `cordis.patch.yml` are DSH Web
loader integration metadata outside the Community v0.15 facet model. The
adapter uses the host-provided client module loader and slot service, then
discovers controls inside the semantic composer surface.

The adapter renders a panel next to its fixed composer trigger, but exposes no
button-position editor, dragging, user-defined coordinates, size controls, or
layout persistence. Those behaviors are not part of Community v0.15, Runtime /
Presentation interoperation, or the current Views contract.

Button-extension discovery is bounded to a confirmed DSH input/composer
surface. Semantic `conversation.input.*` and `composer.*` slots are preferred;
plugin/extension data markers and direct toolbar buttons provide a constrained
fallback. Text-entry widgets and controls outside that surface are excluded.
This is an adapter discovery policy, not a new cross-host UI contract.

It does not read model-provider settings, API keys, conversation content, or
filesystem data. It persists only whether configuration is enabled and the
local identifiers of composer controls selected for the island. Older stored
coordinates and cached labels are discarded during configuration migration.

The Web adapter must be tested on each supported DSH Web host. A host without
the required slots or composer contract should leave the package's headless
host facet as a no-op.
