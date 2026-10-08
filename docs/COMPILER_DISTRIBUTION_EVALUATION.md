# Compiler Distribution and Storage Evaluation

Date: 2026-10-08. Scope: Linux x86_64 measurements and an architecture comparison. This is an evaluation, not approval to replace engines, change compilation policy, remove supported assets, or publish an installer.

## Recommendation

Optimize the existing embedded-engine distribution first: use a production build, remove shipping debug symbols, avoid duplicate compiler code across executables, and extend the current full-bundle preparation with explicitly prepared, validated resource sets. Evaluate a system-TeX backend separately for users who already have TeX installed or need engines and tools beyond the current Tectonic/BibTeX support.

The current multi-gigabyte total comes mainly from the complete resource bundle. Moving a compiler executable outside the application does not by itself eliminate the fonts, macros, formats, and tools needed to compile documents. Both approaches benefit from selective resource installation.

## Measured sizes

All MB/GB values below use decimal units. Download archives, logical file payloads, and allocated filesystem space are distinct measurements. System GTK/WebKit dependencies, user documents, exported PDFs, and future cache growth are excluded.

| Item | Bytes | Meaning |
| --- | ---: | --- |
| Current debug `.deb` | 132,534,018 | Existing installer archive, not a production release |
| Debug installed size from package metadata | 448,211,968 | `Installed-Size: 437707` KiB |
| GUI after `strip --strip-all` | 94,215,512 | Temporary copy; original executable preserved |
| CLI after `strip --strip-all` | 81,418,160 | Temporary copy; original executable preserved |
| Stripped analysis package | 49,521,468 | Temporary xz-compressed package; size experiment only |
| Stripped analysis package file payload | 175,635,195 | Both executables and the existing packaged assets |
| Complete resource cache, logical size | 2,782,353,293 | Includes the bundle index and resource files |
| Complete resource cache, allocated space | 3,107,639,296 | Observed on this filesystem; many small files add allocation overhead |
| Existing partial cache, allocated space | 55,910,400 | Includes resources, index, and reusable formats; sufficient for the tested fixtures, not all supported documents |
| TinyTeX-1 v2026.10 Linux x86_64 archive | 53,589,988 | Official external distribution download, independently measured |
| TinyTeX-1 archive regular-file payload | 177,024,338 | Metadata sum for 6,408 regular files, including shipped formats; not installed filesystem usage |

Removing symbols alone reduced the installer archive by approximately 62.6% and installed payload by approximately 60.8%. This does not change compiled application logic. The stripped CLI passed the existing headless CLI matrix with the app closed. The stripped GUI was not subjected to new native QA. The temporary analysis package is not a release artifact and must not be offered as a validated installer.

The debug installation plus the complete cache is approximately 3.56 GB. The stripped analysis payload plus the same complete cache remains approximately 3.28 GB: optimizing executable size cannot solve full-bundle storage. Combining that payload with the existing partial cache is approximately 232 MB, but this is only a measured fixture environment, not a promised universal starter configuration.

The complete bundle has 134,980 indexed resources. Fonts and font-related files dominate logical payload: `.pfb`, `.tfm`, `.otf`, `.ttf`, `.vf`, and `.afm` together account for approximately 2.24 GB. This supports selective preparation; it does not justify removing currently supported fonts or packages. The embedded package directory is approximately 2.7 MiB, frontend `dist` approximately 9.1 MiB, and the current Typst asset crate has approximately 10.2 MB of asset data. Those are much smaller than the complete TeX cache.

## Embedded Tectonic and Typst

Benefits:

- A controlled engine/resource version set reduces differences between machines and makes diagnostics and support more predictable.
- The existing snapshot/VFS path handles unsaved primary and secondary buffers without copying source or intermediate compilation files to disk.
- Typst's existing bundled resources work without a separate engine download.
- Isolated workers, cancellation, progress, and stale-result handling already integrate with the desktop and automation interfaces.

Costs:

- Compiler code is shipped in the desktop and console executables. A dedicated shared worker could reduce duplication, but the actual saving requires a separate refactor and measurement.
- The project maintains its local Tectonic/bundle patches and resource management code.
- The current `resources prepare` command prepares the entire existing bundle. A selective preparation contract is a new feature, not an existing flag.
- Tectonic is not a universal replacement for every TeX engine/tool workflow. Automation currently supports in-memory BibTeX and rejects external tools such as Biber with a structured error.

Optimization sequence:

1. Validate production release builds and stripping on each supported platform.
2. Measure a common compiler worker design while retaining the desktop private-worker compatibility contract.
3. Define explicit resource packs and project resource preparation, with validated manifests, resumability, quotas, and actionable missing-resource diagnostics.
4. Keep full-bundle preparation as an optional explicit offline-completeness choice.

A packed local cache is another possible optimization without reducing resource coverage. The measured difference between complete-cache logical size and allocated space is approximately 325 MB. A container could reduce small-file allocation overhead, and compression could reduce payload further, but neither saving has been verified with a compiler-compatible packed provider. This needs its own design and performance measurements.

Resource discovery cannot rely only on scanning `\\usepackage`: TeX dependencies can be selected dynamically. Preparation must never compile under the current policy. A validated initial pack and explicit preparation of missing resources are safer starting contracts than silently downloading during CLI/MCP compilation.

## External distribution, as used by TeXstudio and LaTeX Workshop

[TeXstudio requires a separately installed LaTeX system](https://texstudio-org.github.io/getting_started.html). [LaTeX Workshop requires a compatible distribution on PATH](https://github.com/James-Yu/LaTeX-Workshop/wiki/Install) and documents TeX Live, TinyTeX, and MiKTeX options.

Benefits:

- An existing system distribution can be reused with no second installation of the same TeX resources.
- A build that actually removes embedded Tectonic can have a smaller application payload. Retaining it as a fallback preserves its storage cost.
- TeX Live can provide pdfTeX, XeTeX, LuaTeX, Biber, indexing, and other established tools. This broadens compatibility beyond the current engine contract. See the [official TeX Live guide](https://www.tug.org/texlive/doc/texlive-en/texlive-en.html).
- Engine/package maintenance can be delegated to the distribution's existing management tools.

Costs:

- New users still need a distribution. Full TeX Live occupies several GB; the 2026 guide illustrates a full configuration requiring 9,402 MB. That is an example, not a locally measured universal total. Smaller installation schemes are available.
- TinyTeX starts smaller but grows with additional packages and fonts. [TinyTeX-1](https://github.com/rstudio/tinytex-releases/blob/master/README.md) is a subset, not a full distribution. Its measured 53.59 MB archive contains 177.02 MB of regular-file payload, including shipped formats, before filesystem overhead, additional generated formats, extra packages, and ScienceBatch itself. TinyTeX-0 is infrastructure-only and is not a usable LaTeX installation by itself.
- Archive inspection found `pdftex`, `xetex`, `luatex`, and `latexmk`, but not Biber or the existing ScienceBatch first-class classes/icon packages (`IEEEtran.cls`, `acmart.cls`, `llncs.cls`, `curve.cls`, `beamer.cls`, `fontawesome5.sty`, `simpleicons.sty`, and `academicons.sty`). Matching the current support promise would need extra resources; the archive baseline is not a feature-equivalent full environment.
- PATH configuration, installed versions, missing tools, distribution updates, and permissions become part of application support. The LaTeX Workshop documentation specifically identifies additional Perl requirements for its default MiKTeX/latexmk recipe.
- Traditional build recipes use intermediate files. [LaTeX Workshop's compilation documentation](https://github.com/James-Yu/LaTeX-Workshop/wiki/Compile) exposes output/auxiliary directories and cleanup operations. Copying sources to a temporary directory and deleting it afterward would violate ScienceBatch's current no-disk-intermediates contract.
- Preserving live buffers and the memory-only contract needs a new external-engine adapter and a supported memory filesystem/VFS strategy across platforms, or an explicitly approved policy change. The existing worker isolation can remain, but resource confinement, external subprocesses, cancellation, diagnostics, and offline operation must be verified for the new engine.

The external ScienceBatch variant has not been built. Its exact installer and installed sizes cannot be honestly inferred from the distribution's archive size. Keeping Typst embedded while offering external LaTeX is a reasonable optional direction, but requires separate design and acceptance criteria.

## Evidence and limits

- Existing artifact: `src-tauri/target/debug/bundle/deb/ScienceBatch_0.1.0_amd64.deb`.
- Stripped copies: `/tmp/sciencebatch-size-strip-all-5htf3qc4/`.
- Size-only package: `/tmp/sciencebatch-size-package-xfjvr7u5/sciencebatch-stripped-analysis.deb`.
- Stripped CLI matrix fixtures: `/tmp/sciencebatch-automation-cli-C4LB9d/`.
- Full preparation and resumption evidence: [Resource QA](AUTOMATION_RESOURCES_QA.md).
- Official external archive: [TinyTeX v2026.10](https://github.com/rstudio/tinytex-releases/releases/tag/v2026.10), downloaded to `/tmp/sciencebatch-external-size-1sqaf2ac/` without extraction, installation, or execution.
- Archive SHA-256: `4d519d6236ee6798e3ec0d8e2093d1fda01aeb267aa22c2a5586d76bcfce6566`, matching the official GitHub release API digest.
- TypeScript typecheck and Rust `cargo check` passed during this evaluation. Graphify was consulted before evaluating architecture changes. No application code or engine configuration was changed by this evaluation.

An isolated cold release benchmark used `cargo build --manifest-path src-tauri/Cargo.toml --release --bins --features tauri/custom-protocol`, two jobs, debug information disabled, symbol stripping, thin LTO, and one codegen unit. The benchmark disabled the prebuilt sidecar requirement only through its environment and used a separate temporary target. It was stopped and reaped at the agreed 15-minute evaluation limit while dependencies were still compiling; no ScienceBatch release binaries were produced. Its temporary target was removed. The production release size remains unmeasured: the successful size result above is the stripped-debug experiment, not a completed optimized release build.

Previous native QA statuses are unchanged. Archive inspection and CLI checks do not establish native GUI or cross-platform release readiness.
