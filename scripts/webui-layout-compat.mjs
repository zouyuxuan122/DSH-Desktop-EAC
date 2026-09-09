// Reviewed WebUI 0.5.1 only. Keep the AIO sidebar focused on workspace tools.
const marker = '\t\t\t\t// AIO hides the WebUI usage/balance navigation entry.';
const oldPortal = `name: "usage",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageWorkbenchEntry, {})`;
const newPortal = `name: "usage",
				children: null`;

export function migrateWebuiLayout(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  let output = source.replace(/\r\n/g, '\n');
  if (output.includes(marker)) return newline === '\n' ? output : output.replace(/\n/g, newline);
  if (output.split(oldPortal).length !== 2) {
    throw new Error('Unrecognized WebUI usage navigation portal boundary');
  }
  output = output.replace(oldPortal, `${marker}\n${newPortal}`);
  return newline === '\n' ? output : output.replace(/\n/g, newline);
}
