# Vendored Rust dependencies

These source trees are copied from the crates.io releases listed below so ScienceBatch can apply small, reviewable compiler isolation patches. Their upstream license files are retained in each crate directory.

| Crate | Upstream version | Local changes |
| --- | --- | --- |
| `tectonic` | 0.17.0 | Adds an optional project `IoProvider` to the processing session and a per-session switch that prevents external bibliography tools from probing or launching subprocesses. Existing desktop defaults remain unchanged. |
| `tectonic_bundles` | 0.4.2 | Adds cached-only digest/index behavior and accounts for network bytes during explicit, bounded resource preparation. Cached-only compilation does not refresh remote digests or indexes. |

The package source and original licenses are preserved under each vendored crate. Do not update either crate independently of the matching ScienceBatch isolation review.

Source edits also use stable lock files in the current user's ScienceBatch cache under `transaction-locks/`; compilation creates no source or intermediate files. The desktop and CLI keep their existing compile trigger behavior, while this directory is used only for explicit edits.
