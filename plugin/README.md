# @residenthiago/dsh-tool-router

Lazy tool discovery for [DeepSeek Harness](https://github.com/tonyd2wild/DeepSeek-Harness):
hides every tool schema from the model's prefill and reveals exactly one tool
on demand through a **decision model API** (`POST /v1/systemone`).

- **Prefill cost:** one small `find_tool` schema instead of every mounted tool
  (measured 6,559 → 283 prefill tokens on a Standard profile).
- **Stage 1** — one decision call returns the winning tool.
- **Stage 2** — accept iff `confidence >= 0.70`; otherwise return a
  probability-ordered shortlist so the model can retry with an exact tool name.
  Exact tool-name requests skip the decision call and reveal instantly.

## Install

```sh
dsh plugin --profile <profile> add @residenthiago/dsh-tool-router
```

Then select the bundle on the Plugins page (installation enables it by
default) and restart DSH if the profile runs without HMR.

The package declares a bundle patch (`dsh.bundle.patch` → `cordis.patch.yml`)
with the `no-prefill` agent preset, so it appears in the Plugins panel as the
**Tool Router** card with its own enable/disable toggle.

## Configuration

The decision-model endpoint defaults to `http://127.0.0.1:8081/v1/systemone`.
Edit `ROUTER_BASE` in `index.js` to point at another host or port.

## License

MIT — see `LICENSE`.
