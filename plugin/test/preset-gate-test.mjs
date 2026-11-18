// Regression for the Standard-Mode mask leak (standard-mode-preset-analysis.md).
// The router is mounted only in `no-prefill`, but boot-adopt / the two self-heals
// used to mask every live agent, and a switch away from no-prefill never lifted
// the deny layer. Standard sessions ended up with 20 tools instead of 33.
process.env.DSH_TOOL_ROUTER_LOG = '0';

import { apply } from "../index.js";

const params = { type: "object", properties: { request: { type: "string" } }, required: ["request"] };
const GLOBAL = [
  "bash", "create_worktree", "edit", "find_tool", "glob", "grep", "present",
  "read", "read_image", "todo_write", "web_fetch", "web_search",
  "working_directory", "write",
];
const failures = [];
const ok = (c, m) => { if (!c) failures.push(m); console.log((c ? "PASS: " : "FAIL: ") + m); };

function harness({ preset, sessionPreset, boot = true } = {}) {
  const registered = new Map();
  const denied = new Set();
  const listeners = new Map();
  const logs = [];
  let restrictCalls = 0;

  const tools = {
    register(d) { registered.set(d.name, d); },
    schemas() { return GLOBAL.map((n) => ({ name: n, description: n + " tool", parameters: params })); },
    get(n) { return denied.has(n) ? undefined : registered.get(n) ?? { name: n, parameters: params }; },
    restrict({ deny }) {
      if (!Array.isArray(deny)) throw new Error("non-array deny");
      const unknown = deny.filter((n) => !GLOBAL.includes(n));
      if (unknown.length) throw new Error("known global tools: " + GLOBAL.join(", "));
      restrictCalls += 1;
      for (const n of deny) denied.add(n);
      return () => { for (const n of deny) denied.delete(n); };
    },
  };

  const session = sessionPreset !== undefined ? { agentPreset: sessionPreset } : undefined;
  const agent = { id: "session-abc123", ctx: { tools }, session };
  const agents = boot ? [agent] : [];
  const sessions = new Map(session ? [[agent.id, session]] : []);

  const ctx = {
    tools,
    get(name) {
      if (name === "agents") return { list: () => agents };
      if (name === "sessions") return { get: (id) => sessions.get(id) };
      if (name === "agentPresets") {
        return preset === undefined ? undefined : { composedPreset: () => preset };
      }
      return undefined;
    },
    on(e, f) { if (!listeners.has(e)) listeners.set(e, []); listeners.get(e).push(f); },
    off() {},
    effect(fn) { return fn(); },
  };

  const realError = console.error;
  console.error = (...a) => logs.push(a.join(" "));
  const dispose = apply(ctx);
  console.error = realError;

  const fireArgs = (e, ...args) => {
    const real = console.error;
    console.error = (...a) => logs.push(a.join(" "));
    try { for (const f of (listeners.get(e) ?? [])) f(...args); }
    finally { console.error = real; }
  };
  return {
    agent, denied, logs, dispose, fireArgs,
    stats: () => ({ restrictCalls }),
  };
}

console.log("--- 1. boot-adopt must skip a standard agent ---");
{
  const h = harness({ preset: "standard" });
  ok(h.stats().restrictCalls === 0, "standard agent not masked at mount");
  ok(h.denied.size === 0, "standard agent keeps its full tool surface");
  ok(h.logs.some((l) => l.includes("adopt skipped") && l.includes("standard")),
    "skip is visible in the log");
}

console.log("--- 2. boot-adopt still masks a no-prefill agent ---");
{
  const h = harness({ preset: "no-prefill" });
  ok(h.stats().restrictCalls >= 1, "no-prefill agent masked at mount");
  ok(h.denied.has("bash") && h.denied.has("read"), "bash/read denied for no-prefill");
  ok(!h.denied.has("find_tool"), "find_tool itself never denied");
}

console.log("--- 3. preset from the session cache is honoured (registry absent) ---");
{
  const h = harness({ sessionPreset: { val: "standard" } });
  ok(h.stats().restrictCalls === 0, "cached agentPreset.val=standard prevents the mask");
}

console.log("--- 4. agent/created for a standard agent is gated too ---");
{
  const h = harness({ preset: "standard", boot: false });
  h.fireArgs("agent/created", { agent: h.agent });
  ok(h.stats().restrictCalls === 0, "agent/created does not mask a standard agent");
}

console.log("--- 5. switching away from no-prefill releases the mask ---");
{
  const h = harness({ preset: "no-prefill" });
  ok(h.denied.has("bash"), "mask armed while still no-prefill");
  h.fireArgs("agent-preset/selected", h.agent.id, { agentPreset: "standard" });
  ok(h.denied.size === 0, "agent-preset/selected lifts the deny layer");
  ok(h.logs.some((l) => l.includes("released mask") && l.includes("standard")),
    "release is visible in the log");
}

console.log("--- 6. session-log variant of the same event releases the mask ---");
{
  const h = harness({ preset: "no-prefill" });
  h.fireArgs("session/event", { id: h.agent.id },
    { type: "agent-preset/selected", data: { agentPreset: "standard" } });
  ok(h.denied.size === 0, "session/event agent-preset/selected lifts the deny layer");
}

console.log("--- 7. unknown preset keeps legacy behaviour ---");
{
  const h = harness({});
  ok(h.stats().restrictCalls >= 1, "agent masked when no host API can name a preset");
}

if (failures.length) {
  console.error("FAILURES:\n" + failures.join("\n"));
  process.exit(1);
}
console.log("ALL_PASS");
