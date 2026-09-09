// AIO intentionally does not show the optional bottom-right live status pill.
// This must win over old localStorage/config.json overrides in existing profiles.
const marker = '// AIO disables the optional status-rotator Pill.';
const old = '\t\t\t\tconfig = cfg;';
const replacement = `${marker}\n\t\t\t\tcfg.pill = { ...(cfg.pill || {}), enabled: false };\n\t\t\t\tconfig = cfg;`;

export function migrateStatusRotator(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  let output = source.replace(/\r\n/g, '\n');
  if (output.includes(marker)) return newline === '\n' ? output : output.replace(/\n/g, newline);
  if (output.split(old).length !== 2) {
    throw new Error('Unrecognized status-rotator effective config boundary');
  }
  output = output.replace(old, replacement);
  return newline === '\n' ? output : output.replace(/\n/g, newline);
}
