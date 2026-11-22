# Pinned Resource Catalog

This directory contains metadata generated from the locally captured QA cache for the existing Tectonic indexed-tar bundle. It contains no TeX or font resource bodies. The bundle identity is `6ffe055852f8faf66c0acbe1a7fb27f87b869a90bad1204f3bf4d9683f597c7c`; its index is 5,143,485 bytes, SHA-256 `0fb434b0fa5fdebea7f767ed9c31939c99a780d6f95cd3f540aae55910bb5697`, with 134,980 entries.

The application also embeds a verified 358-resource LaTeX starter closure for the built-in Showcase and Scratchpad. It is the union of the 328 indexed resources reported by the static/declared resource plan and the additional pinned bundle bodies observed in successful explicit offline Showcase compiles, including the 12 pt class and font/runtime inputs. The payload is 15,897,961 indexed bytes and is stored as a deterministic 4,146,109-byte ZIP archive in `src-tauri/embedded_packages/starter-latex`. Its separate manifest pins the archive hash, every member's path, exact byte count, and SHA-256 to the bundle and index above. The observed runtime paths are specific to this Showcase and QA environment; this measured subset is not a general TeX dependency closure. Resources outside it remain subject to explicit preparation. Resource bodies are checked against the embedded catalog at application initialization and again when loaded by the compiler. The bundled files are reported as embedded and do not count toward cache transfer or storage.

`index.txt.gz` preserves the original validated index bytes so a later cold-cache preparation can seed the exact pinned index without fetching it. `resources.tsv.gz` is deterministic gzip TSV with columns `path`, `offset`, `length`, and `sha256`. It records one row for every indexed resource, including zero-byte resources. `source-files.tsv.gz` inventories all indexed `.sty`, `.cls`, `.tex`, `.fd`, and `.map` files with their type, role, and resource hash. `source-references.tsv.gz` records literal package, class, input, include, and bibliography references found by a lightweight scan of UTF-8 `.sty`, `.cls`, and `.tex` files. Non-literal expressions are retained and marked unresolved. This is source-reference metadata for later analysis; it does not implement TeX expansion or claim complete dependency resolution. The `.fd` and `.map` inventory preserves font-definition and font-map paths for later resolver use.

`metadata.json` records schema version, pinned bundle/index identities, table sizes and hashes, and source provenance. The provenance is a local QA cache capture from 2026-10-08. SHA-256 values detect changes relative to this capture; they are not independent authentication of upstream bundle content.

For the validated capture, `resources.tsv.gz` is 6,401,234 bytes compressed / 13,917,185 bytes decompressed and contains 134,980 rows. It records 2,777,207,554 logical resource bytes. `index.txt.gz` is 1,268,112 bytes. The source inventory has 13,708 entries (including all 4,530 `.fd` and 326 `.map` files); its reference scan emits 22,269 records. All compressed artifact hashes and exact sizes are pinned in `metadata.json`.

## Rebuilding

Use the already prepared cache. The builder never fetches a bundle:

```sh
python3 scripts/build-resource-catalog.py \
  --cache-bundles /path/to/cache/bundles \
  --output-dir src-tauri/resource_catalog
```

The starter subset is rebuilt from its checked-in manifest, which retains the union of exact static/declared plan paths and the additional pinned paths observed in successful explicit offline Showcase runs. It verifies each path against both `resources.tsv.gz` and the existing cache before publishing the archive and manifest. The operation never downloads resources:

```sh
python3 scripts/build-starter-resources.py \
  --cache-bundles /path/to/cache/bundles \
  --paths-json src-tauri/embedded_packages/starter-latex/manifest.json
```

The generated archive has a 32 MiB compressed and decompressed size bound and at most 1,000 members. ZIP timestamps and file metadata are fixed for reproducible builds. The builder also accepts a paginated `resources.list` response (`items`) or an explicit pinned resource list. Only indexed `pinned_bundle` bodies are included; local template assets are never added as bundle resources.

The input must contain `data/<bundle-digest>.index` and the corresponding `data/<bundle-digest>/` tree. Before publishing any generated files, the builder checks the pinned index byte count and SHA-256, every row's field count and integer range arithmetic, duplicate and unsafe paths, entry count, non-overlapping ranges, and every indexed file's exact size, regular-file status, and symlink-free containment. It hashes each resource body while streaming, but emits only hashes and index metadata. The decompressed resource table is limited to 32 MiB. Directory ancestors, index files, and resource paths must be symlink-free; the builder opens indexed files with no-follow semantics where supported and detects replacement or mutation during hashing.

Any invalid, missing, changed, unsafe, or unreadable input fails the command without claiming a valid catalog. Correct the QA artifact or report the blocker; do not update the pins to make a failed cache pass. The generated gzip streams use a fixed timestamp and empty filename for reproducible bytes.

Focused validation tests run with:

```sh
python3 scripts/test-build-resource-catalog.py
```
