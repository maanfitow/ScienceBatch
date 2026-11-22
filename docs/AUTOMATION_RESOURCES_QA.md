# Compiler Resource Preparation QA

This checklist exercises the public CLI against a temporary compiler cache. It
does not compile a document and does not modify the configured user cache.

## Reproduce interruption and resume

Build the CLI, then run:

```sh
cargo build --manifest-path src-tauri/Cargo.toml --bin sciencebatch-cli
node scripts/test-resource-preparation.mjs --cli src-tauri/target/debug/sciencebatch-cli --interrupt-after-seconds 20
```

The script creates a fresh directory under `/tmp`, sets `TECTONIC_CACHE_DIR` to
that directory, and calls the explicit public operation
`resources prepare --engine latex --json` twice. It sends SIGINT to each pass.
For both passes it saves CLI JSON stdout and stderr logs in the temporary
directory. It checks for the structured `operation.interrupted` result, checks
that each pass exits 130, waits for a newly published indexed resource before
interrupting, checks that the resumed pass adds more resources, and checks that
previously completed files retain their length and modification time. It fails
if either pass publishes no resource within the default 300-second wait. The
script prints the cache and log paths; it deliberately leaves them in place for
inspection. The download ceiling remains the production 8 GiB limit,
and the supervisor retains its 30 minute deadline.

The operation itself explicitly authorizes download. The compatibility flag
`--allow-resource-download` is not required by this CLI command.

## Readiness and cache safety checks

`resources status --json` parses the cached bundle index and
checks every indexed path. Readiness requires a regular file at each safe,
contained path with the exact indexed length. Extra cached files do not make an
incomplete index ready. Empty or malformed indexes fail as unavailable, and
symlink, special-file, and path traversal cases are rejected.

Preparation uses bounded coalesced byte ranges for the existing indexed-tar
bundle. It groups adjacent missing resources into ranges of at most 32 MiB,
fetches at most four ranges at a time, and holds no more than 128 MiB of range
payloads concurrently (this is the range-payload bound, not a total process
RSS cap). A range must have the exact requested length before any
resource within that range is published. Individual files are staged and
renamed atomically, so a completed cache entry survives cancellation and a
later preparation skips it. Cache-only paths remain network-free.

The generic bundle fallback rejects resources over 32 MiB before opening them,
and bounds streamed reads. This prevents backends that eagerly allocate their
whole resource from allocating an unbounded body during explicit preparation.

## Regression tests

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib automation::resources::tests:: -- --test-threads=1
cargo test --manifest-path src-tauri/vendor/tectonic_bundles/Cargo.toml --lib preparation_ -- --nocapture
```

The resource tests cover the Tokio/reqwest cold-cache regression, cancellation
and reaping, exact indexed-file readiness, and rejection of empty or escaping
indexes. The vendored bundle tests use local HTTP range fixtures to verify that
adjacent files share one exact request and that short or oversized responses
publish no resources.

## Recorded real-cache run

The default bundle was prepared on 2026-10-08 using a temporary cache at
`/tmp/sciencebatch-resource-prepare-verification-20261008-real1/cache`. The
public command was:

```sh
TECTONIC_CACHE_DIR=/tmp/sciencebatch-resource-prepare-verification-20261008-real1/cache \
  src-tauri/target/debug/sciencebatch-cli resources prepare --engine latex --json
```

After the bulk path was implemented, the first pass was interrupted with SIGINT
after 28,970 complete cache files (381,812,409 bytes) were present. It exited
130 with `operation.interrupted`; a before/after path, length, and modification
time comparison showed that every previously complete file was preserved. The
resumed pass finished in 4 minutes 7 seconds and returned `files: 134980`,
`bytesDownloaded: 2479248199`, and `prepared: true`. The final status reported
`ready: true`, 134,980 indexed resource files, and 2,777,207,554 cached bytes.
Both public invocations used stdout for the JSON envelope and stderr for logs;
stderr was empty for the completed pass.

The downloaded-byte total is lower than the final cache byte count because
previously completed resources from the interrupted pass were reused. A warm
preparation returned `bytesDownloaded: 0` and `files: 134980`; stderr was empty.
A sorted path, length, and modification-time comparison over the complete
bundle cache before and after the warm pass was identical. Do not point these
checks at the normal user cache.

The updated debug `.deb` was extracted without installation into
`/tmp/sciencebatch-resource-deb-iiz9411z/`. A warm preparation through its
packaged CLI returned zero downloaded bytes and 134,980 files. The separate
`warm-resource-network.strace` trace contained no IPv4/IPv6 network calls.
The complete vendored bundle suite passed all eight tests. The reproducible
interruption script also passed from a second fresh temporary cache at
`/tmp/sciencebatch-resource-qa-eXje13/`: both passes exited 130, previously
published resources were preserved, and resumption added 9,932 resources.
