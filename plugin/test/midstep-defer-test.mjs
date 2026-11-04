// Regression for the 2026-11-04 incident (session f631c7b5): the request a step
// sends and the view dispatch enforces must never diverge.
//
// Host ordering (dsh-agent-loop, measured from the device build):
//   turn()    -> session.append("turn/start")              observers notified inline
//   preStep() -> await systemPrompt.assemble(...)          <-- tool schemas snapshotted
//              -> dispatch.waterfall("agent/pre-step")     <-- the plugin runs here
//   step()    -> buildRequest(..., assembly.tools)         <-- header built from snapshot
//   execute   -> tools.get(name, agent)                    <-- RESTRICTED view
// A deny-write from agent/pre-step (or any mid-step path) therefore lands AFTER
// the snapshot but BEFORE dispatch: the header advertises a tool the registry
// already denies, and the model's first call dies with `unknown tool`.
//
// Contract pinned here:
//   (1) mount-time adoption (boot-adopt) arms BEFORE the first assemble().
//   (2) an agent adopted WHILE its turn is open PARKS the hide until a host
//       boundary (step/end | turn/start | turn/end): advertised == callable.
//   (3) a tool called during that un-masked window is never re-hidden when the
//       parked arm lands (revealed re-seeded from the session log).
//   (4) reveals still apply immediately mid-turn — they only widen visibility.
//   (5) agent/disposed releases the record and its restriction.
import { apply } from "../index.js";

const failures = [];
const ok = (cond, msg) => {
  if (cond) console.log("PASS: " + msg);
  else { failures.push(msg); console.log("FAIL: " + msg); }
};
const next = () => Promise.resolve({ kind: "enter", messages: [] });

const params = { type: "object", properties: { request: { type: "string" } }, required: ["request"] };
const TOOL_NAMES = ["bash", "read", "write", "grep", "web_search"];

function harness() {
  const registry = new Map();
  const denied = new Set();
  const listeners = new Map();
  const sessionEvents = new Map();
  const agents = [];
  const grabbed = [];
  let restrictCalls = 0;

  const on = (n, fn) => {
    if (!listeners.has(n)) listeners.set(n, []);
    listeners.get(n).push(fn);
    grabbed.push([n, fn]);
  };
  const off = (n, fn) => {
    const l = listeners.get(n) ?? [];
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  };
  // Rest-args emission: `session/event` observers receive (session, event),
  // exactly like dsh-session's callbackArgs = [this, event].
  const emit = (n, ...args) => {
    for (const fn of [...(listeners.get(n) ?? [])]) fn(...args);
  };

  const defOf = (n) => {
    if (registry.has(n)) {
      const r = registry.get(n);
      return { name: n, description: r.description, parameters: r.parameters ?? null };
    }
    if (TOOL_NAMES.includes(n)) return { name: n, description: n + " tool", parameters: params };
    return undefined;
  };

  const tools = {
    register(def) { registry.set(def.name, def); },
    schemas() { return [...new Set([...registry.keys(), ...TOOL_NAMES])].map(defOf).filter(Boolean); },
    get(n) { return denied.has(n) ? undefined : defOf(n); },
    restrict({ deny }) {
      if (!Array.isArray(deny) || deny.length === 0) throw new Error("restrict requires a deny list");
      restrictCalls += 1;
      for (const n of deny) denied.add(n);
      return () => { for (const n of deny) denied.delete(n); };
    },
  };

  const ctx = {
    tools,
    on,
    off,
    effect(fn) { return fn(); },
    get(name) {
      if (name === "agents") return { list: () => [...agents] };
      if (name === "sessions") return {
        get: (id) => sessionEvents.has(String(id))
          ? { id: String(id), events: sessionEvents.get(String(id)) }
          : undefined,
      };
      return undefined;
    },
  };

  const sessionFor = (agent) => ({
    id: agent.id,
    push(ev) {
      if (!sessionEvents.has(agent.id)) sessionEvents.set(agent.id, []);
      sessionEvents.get(agent.id).push(ev);
      emit("session/event", { id: agent.id }, ev);
    },
  });

  return {
    ctx, tools, denied, registry, agents, grabbed, sessionFor,
    stats: () => ({ restrictCalls }),
    listenersOf: (n) => (listeners.get(n) ?? []).slice(),
    fire: emit,
  };
}

const runPreStep = async (h, agent, step = 1) => {
  for (const fn of h.listenersOf("agent/pre-step")) {
    await fn({ agent, messages: [], turn: 1, step }, next);
  }
};

// ---------------------------------------------------------------- (1) boot-adopt
{
  const h = harness();
  const bootAgent = { id: "session-bootadopt", ctx: { tools: h.tools } };
  h.agents.push(bootAgent); // resumed BEFORE the bundle applies — the f631c7b5 race
  apply(h.ctx);
  ok(h.stats().restrictCalls === 1, "boot-adopt arms at mount, before any turn/assemble (restrictCalls=1)");
  ok(h.denied.size === TOOL_NAMES.length, `boot-adopt hides the whole surface (denied=${h.denied.size})`);
  ok(!h.denied.has("find_tool"), "boot-adopt keeps find_tool visible");
}

// ------------------------------------- (2)+(3)+(4) late adopt inside an open turn
{
  const h = harness();
  const agent = { id: "session-latewin", ctx: { tools: h.tools } };
  apply(h.ctx);

  // The host opens the turn BEFORE the plugin ever learns about the agent
  // (its agent/created was missed — exactly the f631c7b5 boot-order race).
  const sess = h.sessionFor(agent);
  sess.push({ type: "turn/start", data: { turn: 1 } });
  ok(h.stats().restrictCalls === 0, "no arm before the agent is even known");

  // agent/pre-step runs AFTER assemble(): adoption may not hide anything yet.
  await runPreStep(h, agent);
  ok(h.stats().restrictCalls === 0, "late adopt inside an open turn does NOT write the registry (parked)");
  ok(h.denied.size === 0, "advertised surface stays callable during that step (denied=0)");
  ok(!h.denied.has("bash"), "header/dispatch consistent: advertised bash stays reachable");

  sess.push({ type: "step/start", data: { turn: 1, step: 1 } });

  // The model used bash during the un-masked window; the log records it.
  sess.push({ type: "tool/call", data: { turn: 1, step: 1, callId: "c1", name: "bash", arguments: "{}" } });

  // The step closes -> the parked hide lands (first safe boundary).
  sess.push({ type: "step/end", data: { turn: 1, step: 1 } });
  ok(h.stats().restrictCalls === 1, "parked hide applied exactly once at step/end (restrictCalls=1)");
  ok(h.denied.size === TOOL_NAMES.length - 1, `mask covers every unused tool (denied=${h.denied.size})`);
  ok(!h.denied.has("bash"), "tool called during the window survives the parked arm (seeded from the log)");
  ok(!h.denied.has("find_tool"), "find_tool still visible after the boundary");

  // (4) A reveal mid-turn still applies immediately: it only widens visibility.
  const findTool = h.registry.get("find_tool");
  const beforeReveal = h.stats().restrictCalls;
  const answer = await findTool.execute({ request: "grep" }, { agent });
  ok(answer?.selected === "grep", "exact-name reveal answers");
  ok(h.stats().restrictCalls === beforeReveal + 1, "reveal re-arms immediately, no deferral (restrictCalls+1)");
  ok(!h.denied.has("grep"), "revealed tool is callable");

  // turn/end closes the window bookkeeping without another write.
  const afterReveal = h.stats().restrictCalls;
  sess.push({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  ok(h.stats().restrictCalls === afterReveal, "turn/end performs no extra registry write");

  // Next turn: the arm exists before assemble() again, so pre-step is quiet.
  sess.push({ type: "turn/start", data: { turn: 2 } });
  await runPreStep(h, agent, 1);
  ok(h.stats().restrictCalls === afterReveal, "later pre-step boundaries with an armed mask are no-ops");
}

// --------------------------------------------------- (5) agent/disposed cleanup
{
  const h = harness();
  const agent = { id: "session-disposed1", ctx: { tools: h.tools } };
  apply(h.ctx);
  const created = h.listenersOf("agent/created")[0];
  created({ agent });
  ok(h.stats().restrictCalls === 1, "agent/created still arms once");
  const disposed = h.listenersOf("agent/disposed")[0];
  ok(typeof disposed === "function", "agent/disposed listener installed");
  disposed({ agent });
  ok(h.denied.size === 0, "agent/disposed releases the restriction");
}

console.log(failures.length === 0 ? "ALL_PASS" : "HAS_FAILURES: " + failures.join(" | "));
process.exit(failures.length === 0 ? 0 : 1);