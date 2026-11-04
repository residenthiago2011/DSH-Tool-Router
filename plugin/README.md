# DeepSeek Harness - Tool Router

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

### From a GitHub Release (plugin panel / tarball URL)

DeepSeek Harness → **Plugins** → **Add plugin** → Registry: **Official npm
registry** → paste:

```text
https://github.com/residenthiago2011/DSH-Tool-Router/releases/download/v1.2.0/residenthiago-dsh-tool-router-1.2.0.tgz
```

Pick the newest tag from the
[Releases page](https://github.com/residenthiago2011/DSH-Tool-Router/releases);
each release also carries a `SHA256SUMS.txt` for `sha256sum -c`. To remove the
plugin later, open its card → **Uninstall** (the profile must run with HMR
enabled for the panel uninstall; otherwise use `dsh plugin remove`).

### From a registry package

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
