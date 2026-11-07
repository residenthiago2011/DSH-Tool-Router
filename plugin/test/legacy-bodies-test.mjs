// Phase 2.1b — snapshot the EXACT Stage-1 request bodies find_tool sends.
//
// Starts a local node:http stub on port 0 that records POSTed bodies and
// returns a canned answer, drives find_tool through the stub DSH context
// (same shape as router-e2e-test.mjs) for five sample requests, then:
//   - no fixture yet  -> writes test-fixtures/legacy-bodies.json (bootstrap)
//   - fixture present -> asserts byte-identity (regression guard for the
//                        decision.js extraction in Phase 2.1c/d)
// Endpoint-free: the stub IS the endpoint. The plugin reads
// DSH_TOOL_ROUTER_URL at module load, so env is set before the import.
import { createServer } from 'node:http';
import {
  readFileSync, writeFileSync, mkdirSync, existsSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const failures = [];
const ok = (cond, msg) => {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures.push(msg);
};

// --- the five sample requests (rank-sim phrasings + one pt, per §12.5) ------
const requests = [
  'read the contents of a text file from disk',
  'run a simple echo command to generate the content',
  'search the codebase for a function definition',
  'create a file named hello.txt with the content hi',
  'procure onde a função main está definida neste projeto',
];

// --- stub decision endpoint -------------------------------------------------
const bodies = [];
const server = createServer((req, res) => {
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => {
    bodies.push(data);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      model: 'legacy-bodies-stub',
      answers: {
        bestTool: {
          type: 'choice', choice: 'read', probabilities: { read: 1 }, confidence: 1,
        },
        usable: { type: 'noul', noul: 0.9 },
      },
      usage: { input_tokens: 1, output_tokens: 0 },
    }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
process.env.DSH_TOOL_ROUTER_URL = `http://127.0.0.1:${port}`; // bare-origin form

// --- stub DSH context (same semantics as router-e2e-test.mjs) ---------------
const registry = new Map();
const denied = new Set();
const listeners = new Map();
const on = (n, fn) => { if (!listeners.has(n)) listeners.set(n, []); listeners.get(n).push(fn); };
const off = (n, fn) => { const l = listeners.get(n) ?? []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); };
const emit = (n, payload) => { for (const fn of [...(listeners.get(n) ?? [])]) fn(payload); };

const defs = [
  ['bash', 'Run a shell command on the device'],
  ['read', 'Read the contents of a text file from disk'],
  ['write', 'Write a file to disk'],
  ['edit', 'Edit a file on disk'],
  ['read_image', 'Read an image file'],
  ['grep', 'Search file contents with a pattern'],
  ['glob', 'Find files by glob pattern'],
  ['web_search', 'Search the web'],
  ['web_fetch', 'Fetch a web page'],
  ['todo_write', 'Update the todo list'],
  ['present', 'Present content to the user'],
];
const baseParams = {
  type: 'object',
  properties: { request: { type: 'string', description: 'What to do.' } },
  required: ['request'],
};
const schemasFor = () => {
  const out = [];
  const seen = new Set();
  for (const [name, description] of defs) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!denied.has(name)) out.push({ name, description, parameters: baseParams });
  }
  for (const [name, def] of registry) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!denied.has(name)) out.push({ name, description: def.description, parameters: def.parameters ?? null });
  }
  return out;
};
const toolsService = {
  register(def) { registry.set(def.name, def); emit('tools/change', {}); },
  schemas() { return schemasFor(); },
  get(name) {
    if (denied.has(name)) return undefined;
    const reg = registry.get(name);
    if (reg) return { name, description: reg.description, parameters: reg.parameters ?? null };
    const d = defs.find((x) => x[0] === name);
    if (d) return { name: d[0], description: d[1], parameters: baseParams };
    return undefined;
  },
  restrict({ deny }) {
    if (!Array.isArray(deny) || deny.length === 0) throw new Error('restrict called with bad deny');
    for (const n of deny) denied.add(n);
    emit('tools/change', {}); // synchronous, device semantics
    return () => { for (const n of deny) denied.delete(n); emit('tools/change', {}); };
  },
};
const ctx = {
  effect(fn) { return fn(); },
  on,
  off,
  tools: toolsService,
};

const mod = await import('../index.js');
mod.apply(ctx);
const agent = { id: 'session-legacy001', ctx: { tools: toolsService } };
emit('agent/created', { agent });

const findTool = registry.get('find_tool');
if (!findTool) { console.log('FAIL: find_tool not registered'); process.exit(1); }

// --- drive five decision calls ----------------------------------------------
for (const request of requests) {
  const out = await findTool.execute({ request }, { agent });
  if (!out?.selected) {
    failures.push(`no accept for: ${request} (selected=${out?.selected} conf=${out?.confidence})`);
    console.log(`FAIL: no accept for: ${request} (selected=${out?.selected} conf=${out?.confidence})`);
  }
}
server.close();

// --- structural checks (hold with or without a fixture) ---------------------
ok(bodies.length === requests.length, `captured ${bodies.length}/${requests.length} bodies`);
let shapeOk = true;
for (const raw of bodies) {
  let j;
  try { j = JSON.parse(raw); } catch { shapeOk = false; break; }
  const q = j?.questions ?? {};
  if (typeof j?.state !== 'string'
    || q.bestTool?.type !== 'choice'
    || q.usable?.type !== 'noul'
    || typeof q.bestTool?.instructions !== 'string'
    || typeof q.bestTool?.criteria !== 'object') { shapeOk = false; break; }
  for (const v of Object.values(q.bestTool.criteria)) {
    if (String(v).length > 160) { shapeOk = false; break; }
  }
}
ok(shapeOk, 'every body: string state + bestTool(choice, <=160-char criteria) + usable(noul)');

// --- fixture: bootstrap or byte-identity ------------------------------------
const fixturePath = fileURLToPath(new URL('../test-fixtures/legacy-bodies.json', import.meta.url));
if (existsSync(fixturePath)) {
  const prev = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const sameRequests = JSON.stringify(prev.requests) === JSON.stringify(requests);
  const sameBodies = prev.bodies.length === bodies.length
    && prev.bodies.every((b, i) => b === bodies[i]);
  ok(sameRequests && sameBodies, 'legacy bodies byte-identical to test-fixtures/legacy-bodies.json');
  if (!(sameRequests && sameBodies)) {
    for (let i = 0; i < Math.max(prev.bodies?.length ?? 0, bodies.length); i += 1) {
      if (prev.bodies?.[i] !== bodies[i]) {
        console.log(`  first difference at [${i}]:\n   was: ${String(prev.bodies?.[i]).slice(0, 200)}\n   got: ${String(bodies[i]).slice(0, 200)}`);
        break;
      }
    }
  }
} else {
  mkdirSync(dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, `${JSON.stringify({ requests, bodies }, null, 2)}\n`, 'utf8');
  console.log(`WROTE ${fixturePath} (${bodies.length} bodies)`);
}

console.log(failures.length === 0 ? 'ALL_PASS' : `HAS_FAILURES: ${failures.join(' | ')}`);
process.exit(failures.length === 0 ? 0 : 1);
