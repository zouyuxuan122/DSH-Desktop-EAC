// The AIO build must keep provider/model selection in the host's native
// conversation.input.model control. The WebUI replacement is intentionally
// disabled because its async module flag can mount before settings sync.
export function migrateWebuiNativeModelSelection(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  source = source.replace(/\r\n/g, '\n');
  const old = 'if (on("modelSeats")) applyModelSeats(ctx);';
  const marker = '// AIO keeps provider/model selection in the host native control.';
  if (source.includes(marker)) return newline === '\n' ? source : source.replace(/\n/g, newline);
  if (source.split(old).length !== 2) {
    throw new Error('Unrecognized dsh-webui model seat registration boundary');
  }
  source = source.replace(old, `${marker}\n\t\t\tvoid applyModelSeats;`);
  return newline === '\n' ? source : source.replace(/\n/g, newline);
}
