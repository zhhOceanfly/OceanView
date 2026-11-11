## Plugin submission

- Plugin ID: `io.github.zhhoceanfly.oceanview`
- Version: `0.1.3`
- Publisher ID: `zhhoceanfly`

## Source repository and tag

- Source: https://github.com/zhhOceanfly/OceanView
- Immutable tag / Release: https://github.com/zhhOceanfly/OceanView/releases/tag/dbx-v0.1.3
- Manifest / candidate / package filename version: **0.1.3** (aligned with tag `dbx-v0.1.3`)

## Capabilities and user workflow

- Connection type **OceanView**: display name + Proto source (local directory or Git).
- Workbench **OceanView**: browse Protobuf and debug gRPC / HTTP / SSE / WebSocket.
- Call hosts/ports are configured inside Client environments.

## Permissions, data access, and network access

- `host.workbench`, `host.events`, `host.storage`, **`host.binary`**
- No `host.network:*`. Outbound RPCs from the Node sidecar on the user machine.
- Reads user-selected / Git `.proto` files; plugin data under `DBX_PLUGIN_DATA_DIR`.

## Native sidecar behavior

Yes:
- Go launcher `bin/oceanview-dbx` uses `exec.LookPath("node")` and spawns `runtime/sidecar.js` (**requires host.binary**).
- **Requires Node.js ≥ 18 on PATH.** Missing/old Node prints an actionable stderr message and exits non-zero (does not hang). Does **not** bundle Node under `runtime/node/`.
- May invoke `git` for Proto sync; local FS under plugin data / selected dirs.
- Ships `LICENSE` (MIT, copyright zhhoceanfly) and `THIRD_PARTY_NOTICES.md` for `runtime/node_modules` (`@grpc/grpc-js` / `@grpc/proto-loader` Apache-2.0, `protobufjs` BSD-3-Clause).
- `runGhz` / open-editor paths use `execFile` / argv (no `shell: true`).
- Go binaries stamped with `vcs.modified=false` on tag `dbx-v0.1.3`.
- Icon: `assets/plugin.svg` only.

## Files in this PR

- `publishers/zhhoceanfly.json` (replace prior `zoceanfly` if present)
- `candidates/io.github.zhhoceanfly.oceanview.json` (**exact filename**, no `candidates.` prefix; pins match Release `dbx-v0.1.3` / `release-candidates.json`)

## Release notes

v0.1.3: ExcelView find now scrolls the hit cell into view; hold right mouse button + wheel to scroll horizontally. DocsView gains the same find bar. Still requires Node.js >= 18 on PATH.
