/**
 * DSH Tool Router — pure decision logic (Stage 0 ranking + Stage 1 body).
 *
 * No DSH imports and no I/O: every function here is deterministic and testable
 * without an endpoint (see decision-unit-test.mjs and the byte-pinned fixture
 * test-fixtures/legacy-bodies.json). index.js keeps the host integration —
 * masking, reveal, logging — and the HTTP call itself.
 *
 * Legacy compatibility contract: with default settings,
 * buildDecisionBody() must return the exact bytes the pre-extraction plugin
 * sent (the fixture pins it). Behaviour changes arrive via `settings` only,
 * one phase at a time (tool cap, criterion length, `none`, context, model).
 */

/** Stage-1 instruction texts — quoted by tests; do not reword casually. */
export const CHOICE_INSTR = 'Best matching tool for the request.';
// Asked for TELEMETRY ONLY. d1-omni's noul head proved unreliable in both
// phrasings: the NOT form pinned pNone=0.841 on a bash-conf=1.000 match, the
// YES form answered 0.886 "unhandled" on a read-conf=0.99 match. Confidence
// alone decided every recorded probe correctly (matched 0.72-1.00 revealed,
// unmatched <=0.71 rejected), so the noul value is logged but never gates.
export const NOUL_INSTR = 'Is this request handled by any of the listed tools?';

export const MAX_CHOICES = 24;   // full-surface send; cap only for pathological mounts (d1 window = 16,384 tokens)
export const DESC_CHARS = 160;   // ~40 tokens/criterion; d1-omni has room for rich descriptions (was 56, an earlier tighter budget)
export const STATE_CHARS = 800;  // legacy state cap (the bare-string form, see buildDecisionBody)

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'are',
  'but', 'not', 'can', 'all', 'any', 'use', 'via', 'how', 'what', 'when',
  'need', 'make', 'some', 'please', 'just', 'also', 'then', 'than', 'will',
  'would', 'should', 'could', 'been', 'being', 'does', 'done',
]);

const tokenise = (s) => String(s ?? '')
  .toLowerCase()
  .split(/[^a-z0-9_]+/)
  .filter((t) => t.length > 1);

/** Stage 0 — lexical ordering over the mounted surface. */
export function rank(query, names, labels) {
  const terms = [...new Set(tokenise(query))]
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  const scored = names.map((name) => {
    const rec = labels[name] || {};
    const hay = new Set(tokenise([
      name, rec.short, (rec.router_labels || []).join(' '), rec.description,
    ].join(' ')));
    const nameTokens = new Set(tokenise(name));
    let score = 0;
    for (const t of terms) {
      if (hay.has(t)) score += 1;
      // Prefix match so "read" also scores read_image.
      if ([...nameTokens].some((n) => n === t || n.startsWith(t))) score += 3;
      if ((rec.router_labels || []).some((l) => l.toLowerCase().includes(t))) score += 2;
    }
    return { name, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Stage 0 — candidates for the full send: rank only ORDERs the batch; the cap
 * (settings.maxTools, default MAX_CHOICES) bites only on pathological mounts.
 * Shape: [{ name, score }, ...] — order is load-bearing (criteria follow it).
 */
export function buildCandidates(request, names, labels, settings = {}) {
  const cap = settings.maxTools ?? MAX_CHOICES;
  const ranked = rank(request, names, labels);
  return ranked.slice(0, Math.max(2, Math.min(cap, names.length)));
}

/**
 * Cut a criterion at a sentence boundary at or below `limit`; falls back to
 * the legacy hard cut when no boundary exists. Criteria already within the
 * limit are returned untouched (byte-identity with the legacy fixture).
 */
export function cutCriterion(text, limit) {
  const s = String(text ?? '');
  if (s.length <= limit) return s;
  for (let i = Math.min(limit, s.length) - 1; i > 0; i -= 1) {
    if ('.!?'.indexOf(s[i]) >= 0 && (i + 1 >= s.length || /\s/.test(s[i + 1]))) {
      return s.slice(0, i + 1);
    }
  }
  return s.slice(0, limit);
}

/**
 * Stage 1 — the exact request body as a JSON string.
 *
 * Legacy notes preserved from the original inline build:
 *  - d1-omni (llama.cpp): a bare STRING state calibrates the companion noul
 *    and the choice confidence; an earlier object form made unmatched requests
 *    score conf>=0.92 AND p(noul)<=0.02, so no threshold could ever reject
 *    them (measured: 0/13 zero-wrong-accept params with the object).
 *  - Rich criteria: d1-omni reads descriptions as the option definitions,
 *    e.g. bash's "checking processes" is exactly what a memory query needs.
 *  - No none_of_the_above: it competes with the real tools (see index.js).
 * An object state (Phase 5.5 context) passes through unstringified.
 */
export function buildDecisionBody(request, candidates, labels = {}, settings = {}) {
  const limit = settings.criterionChars ?? DESC_CHARS;
  const criteria = {};
  for (const { name } of candidates) {
    const rec = labels[name] || {};
    criteria[name] = cutCriterion((rec.description || '') || rec.short || name, limit);
  }

  // Phase 5.3 — the never-accepted `none` option (§12.6). Off by default, so
  // legacy bodies stay byte-identical; name collision with a real tool moves
  // the key to `no_tool`.
  let noneKey = null;
  if (settings.none === true || settings.none === 'on') {
    noneKey = settings.noneKey ?? (labels && labels['none'] ? 'no_tool' : 'none');
    criteria[noneKey] = 'No listed tool fits: a question to answer directly, '
      + 'or a capability that is not installed.';
  }

  // Phase 5.5 — latest user message as context. With contextChars > 0 the
  // state becomes an object (the form the model was told to treat as context)
  // and the choice instruction says so. Default 0 = legacy bare string.
  const ctxChars = Number(settings.contextChars ?? 0);
  const withContext = ctxChars > 0
    && settings.latestUserMessage != null
    && (request === null || typeof request !== 'object');
  const state = withContext
    ? {
      find_tool_request: String(request ?? ''),
      latest_user_message: String(settings.latestUserMessage).slice(0, ctxChars),
    }
    : (request !== null && typeof request === 'object'
      ? request
      : String(request).slice(0, settings.stateChars ?? STATE_CHARS));

  const bestTool = { type: 'choice', instructions: CHOICE_INSTR, criteria };
  if (withContext) bestTool.instructions += ' Use latest_user_message only as context.';

  const questions = { bestTool };
  // usable (noul) is telemetry only — sent by default (today's format), can be
  // dropped per profile/override to save a whole pass on no_batching lfm3-d1.
  if (!(settings.usable === false || settings.usable === 'off')) {
    questions.usable = { type: 'noul', instructions: NOUL_INSTR };
  }

  const body = { state, questions };
  if (settings.model) body.model = settings.model;  // multi-model servers only
  return JSON.stringify(body);
}

/**
 * Validate a `bestTool` answer against the keys that were sent (Phase 4.4
 * rules; wired into the fail-soft path in Phase 4). Returns { ok, reason? }.
 *  - probabilities must be a non-empty object
 *  - keys must be a subset of the keys sent
 *  - values must be finite numbers in [0, 1]
 *  - values must sum to 1 within ±0.02
 */
export function validateAnswer(answer, sentKeys) {
  const probs = answer?.probabilities;
  if (!probs || typeof probs !== 'object' || Array.isArray(probs)) {
    return { ok: false, reason: 'no-probabilities' };
  }
  const entries = Object.entries(probs);
  if (entries.length === 0) return { ok: false, reason: 'no-probabilities' };
  const sent = new Set(sentKeys);
  let sum = 0;
  for (const [k, v] of entries) {
    if (!sent.has(k)) return { ok: false, reason: 'unknown-key' };
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      return { ok: false, reason: 'bad-value' };
    }
    sum += v;
  }
  if (Math.abs(sum - 1) > 0.02) return { ok: false, reason: 'bad-sum' };
  return { ok: true, sum };
}
