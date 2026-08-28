// Host half of dsh-message-rewind — intentionally a no-op.
//
// The whole feature runs client-side against public client-runtime services
// (sessions.fork/open, the composer dock slot, inputActions). The host entry
// only exists so the bundle has a loadable main; it registers nothing.

export const name = 'message-rewind'

export function apply() {
  // no host-side behavior
}
