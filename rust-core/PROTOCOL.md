# `smarch-core` JSON protocol

`smarch-core` is an optional accelerator. Every command requires `--json`, writes exactly one JSON object to stdout, writes diagnostics to stderr, and exits nonzero on malformed input or an operational failure. Protocol `1.0.0` field names are stable.

All responses have `{ "protocol_version": "1.0.0", "command": string, "data": object }`. Paths are absolute or root-relative UTF-8 strings with `/` separators. File lists are lexically sorted so parallel walking cannot change output order.

## Scan

`smarch-core scan --json ROOT [--exclude-root PATH] [--exclude-dir NAME] [--exclude-pattern TEXT] [--include-hashes]`

The parallel walker honors `.gitignore`, `.git/info/exclude`, explicit exclusions, and symlink boundaries. `data` is `{ root, files }`; each file is `{ path, relative_path }`, plus `{ size, xxh3, sha256 }` when `--include-hashes` is present. It selects `module.sweetspot.json` and `*.module.sweetspot.json` files.

## Hash

`smarch-core hash --json PATH`

`data` is `{ path, size, xxh3, sha256 }`. `xxh3` is a 16-character lowercase XXH3-64 fast-path digest. `sha256` is the 64-character lowercase manifest/integrity digest.

## Similarity

`smarch-core sim --json LEFT RIGHT`

Both arguments are source file paths. `data` is `{ left, right, score }`, where `score` is the JavaScript token-normalization, 5-token shingle, winnowing-Jaccard, and SimHash-Hamming score in `[0,1]`.

## Merkle

`smarch-core merkle --json BRICK:HEAD... [--proof-index N]`

`data` is `{ root, leaf_count, proof_index, proof }`. Proof steps are `{ hash, side }`, with `side` equal to `left` or `right`. Semantics match `tools/lib/merkle.ts`: `leaf\0` and `node\0` domain separation, `empty\0` empty roots, ordered leaves, and final-node duplication on odd layers.

Consumers must reject unknown major protocol versions or a mismatched `command`. The Node adapter falls back to its local implementation when the binary is absent, disabled with `SMA_CORE=off`, or returns an invalid response; `SMA_CORE=required` makes such failures fatal.
