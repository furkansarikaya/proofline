// The network guard of measure.mjs, proven against a real listener: a local server on a random port counts every
// HTTP request and WebSocket upgrade that reaches it while a file: page (and its worker) tries a fetch, a
// WebSocket and a shared worker towards it. Nothing may arrive, and every attempt is listed in network.blocked.
//   node network-check.mjs [--no-sandbox]
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const MEASURE = fileURLToPath(new URL("../../skills/visual-proof/scripts/measure.mjs", import.meta.url));
const hits = [];
const srv = createServer((q, r) => { hits.push(`http ${q.method} ${q.url}`); r.end("x"); });
srv.on("upgrade", (q, s) => { hits.push(`upgrade ${q.url}`); s.destroy(); });
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
const port = srv.address().port;
const dir = mkdtempSync(join(tmpdir(), "visual-proof-network-"));
let failed = null;
try {
  mkdirSync(join(dir, "app"));
  const to = `127.0.0.1:${port}`;
  writeFileSync(join(dir, "app/index.html"), `<!doctype html><html><body><main id="m">network check</main><script>
try { new WebSocket('ws://${to}/page-ws'); } catch (e) {}
fetch('http://${to}/page-fetch').catch(() => {});
fetch('http://${to}/page-post', { method: 'POST', body: 'x' }).catch(() => {});
new Worker(URL.createObjectURL(new Blob(["fetch('http://${to}/worker-fetch').catch(() => {}); try { new WebSocket('ws://${to}/worker-ws'); } catch (e) {}"])));
try { new SharedWorker('shared.js'); } catch (e) {}
</script></body></html>`);
  writeFileSync(join(dir, "visual.json"), JSON.stringify({ schema: "visual-proof.config/1", class: "STANDARD", base_url: `file://${dir}/app/`,
    viewports: [{ name: "phone", width: 360, height: 740 }, { name: "desktop", width: 1280, height: 800 }],
    screens: [{ id: "s", path: "index.html", states: [{ name: "success", path: "index.html", ready: "#m" }] }] }));
  const child = spawn(process.execPath, [MEASURE, "--config", join(dir, "visual.json"), "--out", join(dir, "out"), ...process.argv.slice(2)], { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => { err += d; });
  const code = await new Promise((ok) => child.on("exit", ok));
  if (code !== 0) throw new Error(`measure.mjs exited ${code}: ${err.slice(-300)}`);
  await new Promise((r) => setTimeout(r, 1000));
  const net = JSON.parse(readFileSync(join(dir, "out/report.json"), "utf8")).network;
  if (hits.length) throw new Error(`requests reached the server: ${hits.join(", ")}`);
  for (const p of ["page-ws", "page-fetch", "page-post", "worker-fetch", "worker-ws", "shared.js"]) {
    if (!net.blocked.some((b) => b.url.endsWith(p))) throw new Error(`${p} is not listed in network.blocked: ${JSON.stringify(net.blocked)}`);
  }
  if (net.unguarded.length) throw new Error(`unguarded targets: ${JSON.stringify(net.unguarded)}`);
  // A page served from the same local server: its own-origin POST continues and is listed in same_origin_writes.
  srv.removeAllListeners("request");
  srv.on("request", (q, r) => {
    hits.push(`${q.method} ${q.url}`);
    r.setHeader("content-type", "text/html");
    r.end(q.url === "/" ? `<!doctype html><main id="m">own origin</main><script>fetch('/api/save', { method: 'POST', body: 'x' }).catch(() => {});</script>` : "ok");
  });
  hits.length = 0;
  writeFileSync(join(dir, "visual.json"), JSON.stringify({ schema: "visual-proof.config/1", class: "STANDARD", base_url: `http://${to}/`,
    viewports: [{ name: "phone", width: 360, height: 740 }, { name: "desktop", width: 1280, height: 800 }],
    screens: [{ id: "s", path: "/", states: [{ name: "success", path: "/", ready: "#m" }] }] }));
  rmSync(join(dir, "out"), { recursive: true, force: true });
  const c2 = spawn(process.execPath, [MEASURE, "--config", join(dir, "visual.json"), "--out", join(dir, "out"), ...process.argv.slice(2)], { stdio: ["ignore", "ignore", "pipe"] });
  const code2 = await new Promise((ok) => c2.on("exit", ok));
  if (code2 !== 0) throw new Error(`measure.mjs (own origin) exited ${code2}`);
  const w = JSON.parse(readFileSync(join(dir, "out/report.json"), "utf8")).network.same_origin_writes;
  if (!w.some((x) => x.method === "POST" && x.url === `http://${to}/api/save`)) throw new Error(`own-origin POST not listed in same_origin_writes: ${JSON.stringify(w)}`);
  if (!hits.includes("POST /api/save")) throw new Error(`own-origin POST did not reach its own server: ${hits.join(", ")}`);
} catch (e) { failed = e; } finally { srv.close(); rmSync(dir, { recursive: true, force: true }); }
if (failed) { console.error(`network-check: ${failed.message}`); process.exit(1); }
console.log("network-check: no request, worker request or WebSocket handshake reached the server; all listed as blocked");
