const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_STATE_BYTES = 256 * 1024 * 1024;

function extOf(path) {
  const m = /(\.[a-z0-9]+)$/i.exec(String(path));
  return m ? m[1].toLowerCase() : "";
}

function stateFilePath() {
  const home = (typeof process !== "undefined" && process.env && process.env.DSH_HOME) ? process.env.DSH_HOME : "";
  if (home) return home.replace(/[\\/]+$/, "") + "/dsh-skin-state.json";
  return "dsh-skin-state.json";
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function apply(ctx) {
  ctx.inject(["webServer", "fs"], (c) => {
    c.effect(() => c.webServer.register({
      kind: "prefix",
      path: "/api/dsh-skin-image",
      handler: async (req, res) => {
        const send = (code, text) => {
          res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
          res.end(text);
        };
        try {
          const url = new URL(req.url || "/", "http://localhost");
          const path = url.searchParams.get("path") || "";
          const ext = extOf(path);
          const mime = MIME[ext];
          if (!mime) return send(400, "unsupported image type");
          const target = await c.fs.resolve(path);
          if (ext === ".svg") {
            const text = await c.fs.readText(target);
            res.writeHead(200, { "content-type": mime, "cache-control": "no-store" });
            res.end(text);
            return;
          }
          const bytes = await c.fs.readBytes(target, undefined, MAX_IMAGE_BYTES);
          res.writeHead(200, { "content-type": mime, "cache-control": "no-store" });
          res.end(bytes);
        } catch (e) {
          send(500, String(e && e.message ? e.message : e));
        }
      },
    }), "dsh-skin: image route");

    c.effect(() => c.webServer.register({
      kind: "prefix",
      path: "/api/dsh-skin-state",
      handler: async (req, res) => {
        const json = (code, body) => {
          res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
          res.end(body);
        };
        try {
          if (req.method === "GET" || req.method === "HEAD") {
            const target = await c.fs.resolve(stateFilePath());
            const stat = await c.fs.stat(target);
            if (!stat) return json(200, "{}");
            const text = await c.fs.readText(target);
            return json(200, text || "{}");
          }
          if (req.method === "POST") {
            const body = await readBody(req, MAX_STATE_BYTES);
            const target = await c.fs.resolve(stateFilePath());
            await c.fs.writeText(target, body, undefined, undefined, {
              mode: "danger-full-access",
              workspaceRoot: process.cwd()
            });
            return json(200, '{"ok":true}');
          }
          res.writeHead(405);
          res.end();
        } catch (e) {
          const text = String(e && e.message ? e.message : e);
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end(text);
        }
      },
    }), "dsh-skin: state route");
  });
}
