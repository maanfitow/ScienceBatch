#!/usr/bin/env python3
"""Build a pinned, body-free resource catalog from a validated local QA cache."""

from __future__ import annotations

import argparse
import bisect
import errno
import gzip
import hashlib
import json
import os
import re
import stat
import tempfile
from pathlib import Path, PurePosixPath

BUNDLE_DIGEST = "6ffe055852f8faf66c0acbe1a7fb27f87b869a90bad1204f3bf4d9683f597c7c"
INDEX_SHA256 = "0fb434b0fa5fdebea7f767ed9c31939c99a780d6f95cd3f540aae55910bb5697"
INDEX_BYTES = 5_143_485
INDEX_ENTRIES = 134_980
MAX_U64 = (1 << 64) - 1
MAX_TABLE_BYTES = 32 * 1024 * 1024
MAX_INDEX_BYTES = INDEX_BYTES
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
SOURCE_EXTENSIONS = {".sty", ".cls", ".tex", ".fd", ".map"}
DEPENDENCY_COMMAND = re.compile(
    r"\\(?P<command>input|include|subfile|includeonly|usepackage|RequirePackage|"
    r"documentclass|LoadClass|InputIfFileExists|bibliography|addbibresource)\*?(?![A-Za-z@])"
    r"(?:\s*\[[^\]]*\])?\s*\{(?P<argument>[^{}]*)\}"
)
LITERAL_REFERENCE = re.compile(r"^[A-Za-z0-9_./+:-]+$")


class CatalogError(ValueError):
    """Raised when the local QA artifact is incomplete or malformed."""


def parse_index(index_path: Path) -> tuple[list[tuple[str, int, int]], bytes]:
    before = index_path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_INDEX_BYTES:
        raise CatalogError("index is not a regular file or exceeds the pinned size")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(index_path, flags)
    except OSError as error:
        raise CatalogError(f"cannot safely open index: {error}") from error
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or opened.st_size != before.st_size:
            raise CatalogError("index changed while opening")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            raw = stream.read(MAX_INDEX_BYTES + 1)
        after = os.fstat(descriptor)
        if _file_identity(opened) != _file_identity(after):
            raise CatalogError("index changed while reading")
    finally:
        os.close(descriptor)
    if len(raw) != INDEX_BYTES:
        raise CatalogError(f"index length mismatch: expected {INDEX_BYTES}, got {len(raw)}")
    actual_hash = hashlib.sha256(raw).hexdigest()
    if actual_hash != INDEX_SHA256:
        raise CatalogError(f"index SHA-256 mismatch: expected {INDEX_SHA256}, got {actual_hash}")
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise CatalogError(f"index is not UTF-8: {error}") from error

    entries: list[tuple[str, int, int]] = []
    names: set[str] = set()
    ranges: list[tuple[int, int, str]] = []
    for line_number, line in enumerate(content.splitlines(), start=1):
        fields = line.split()
        if len(fields) != 3:
            raise CatalogError(f"malformed index entry at line {line_number}")
        name, offset_text, length_text = fields
        if name in names:
            raise CatalogError(f"duplicate resource path at line {line_number}: {name}")
        if not safe_relative_path(name):
            raise CatalogError(f"unsafe resource path at line {line_number}: {name}")
        try:
            offset, length = int(offset_text), int(length_text)
        except ValueError as error:
            raise CatalogError(f"non-integer offset or length at line {line_number}") from error
        if offset < 0 or length < 0 or offset > MAX_U64 or length > MAX_U64 or offset + length > MAX_U64:
            raise CatalogError(f"invalid resource range at line {line_number}: {name}")
        names.add(name)
        entries.append((name, offset, length))
        ranges.append((offset, offset + length, name))
    if len(entries) != INDEX_ENTRIES:
        raise CatalogError(f"index entry count mismatch: expected {INDEX_ENTRIES}, got {len(entries)}")
    for previous, current in zip(sorted(ranges), sorted(ranges)[1:]):
        if current[0] < previous[1]:
            raise CatalogError(f"overlapping resource ranges: {previous[2]} and {current[2]}")
    return sorted(entries), raw


def safe_relative_path(name: str) -> bool:
    path = PurePosixPath(name)
    return (
        bool(name)
        and not path.is_absolute()
        and "\\" not in name
        and ":" not in name
        and all(part not in ("", ".", "..") for part in name.split("/"))
        and all(part == normalized for part, normalized in zip(name.split("/"), path.parts))
    )


def _file_identity(info: os.stat_result) -> tuple[int, int, int, int, int]:
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def validate_directory_chain(path: Path) -> Path:
    absolute = path.absolute()
    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current = current / part
        try:
            info = current.lstat()
        except OSError as error:
            raise CatalogError(f"missing cache directory component {current}: {error}") from error
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise CatalogError(f"cache directory path contains a symlink or non-directory: {current}")
    return absolute


def hash_regular_file(root: Path, relative: str, expected_size: int) -> str:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    directory_flags = flags | getattr(os, "O_DIRECTORY", 0)
    directory_fd = os.open(root, directory_flags)
    file_fd = -1
    try:
        parts = relative.split("/")
        for part in parts[:-1]:
            child_fd = os.open(part, directory_flags, dir_fd=directory_fd)
            os.close(directory_fd)
            directory_fd = child_fd
        file_fd = os.open(parts[-1], flags, dir_fd=directory_fd)
        before = os.fstat(file_fd)
        if not stat.S_ISREG(before.st_mode):
            raise CatalogError(f"indexed resource is not a regular file: {relative}")
        if before.st_size != expected_size:
            raise CatalogError(
                f"resource size mismatch for {relative}: expected {expected_size}, got {before.st_size}"
            )
        digest = hashlib.sha256()
        with os.fdopen(file_fd, "rb", closefd=False) as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
        after = os.fstat(file_fd)
        if _file_identity(before) != _file_identity(after):
            raise CatalogError(f"resource changed while hashing: {relative}")
        return digest.hexdigest()
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise CatalogError(f"symlink in indexed resource path: {relative}") from error
        raise CatalogError(f"cannot safely read indexed resource {relative}: {error}") from error
    finally:
        if file_fd >= 0:
            os.close(file_fd)
        os.close(directory_fd)


def build_catalog(cache_bundles: Path, output_dir: Path) -> dict[str, object]:
    cache_bundles = validate_directory_chain(cache_bundles)
    data_dir = cache_bundles / "data"
    index_path = data_dir / f"{BUNDLE_DIGEST}.index"
    bundle_root = data_dir / BUNDLE_DIGEST
    validate_directory_chain(data_dir)
    validate_directory_chain(bundle_root)
    if index_path.is_symlink() or not index_path.is_file():
        raise CatalogError(f"pinned bundle index is missing or not a regular file: {index_path}")

    entries, raw_index = parse_index(index_path)
    output_dir.mkdir(parents=True, exist_ok=True)
    table_fd, table_temp_name = tempfile.mkstemp(prefix=".resources-", suffix=".tsv.gz", dir=output_dir)
    metadata_fd, metadata_temp_name = tempfile.mkstemp(prefix=".metadata-", suffix=".json", dir=output_dir)
    os.close(table_fd)
    os.close(metadata_fd)
    table_temp = Path(table_temp_name)
    metadata_temp = Path(metadata_temp_name)
    decompressed_bytes = 0
    bundle_bytes = 0
    source_rows: list[bytes] = []
    reference_rows: list[bytes] = []
    try:
        table_hash = hashlib.sha256()
        with table_temp.open("wb") as raw_table:
            with gzip.GzipFile(fileobj=raw_table, mode="wb", filename="", mtime=0, compresslevel=9) as table:
                for name, offset, length in entries:
                    file_hash = hash_regular_file(bundle_root, name, length)
                    bundle_bytes += length
                    row = f"{name}\t{offset}\t{length}\t{file_hash}\n".encode("utf-8")
                    decompressed_bytes += len(row)
                    if decompressed_bytes > MAX_TABLE_BYTES:
                        raise CatalogError(f"decompressed resource table exceeds {MAX_TABLE_BYTES} bytes")
                    table.write(row)
                    suffix = Path(name).suffix.lower()
                    if suffix in SOURCE_EXTENSIONS:
                        role = "font-definition" if suffix == ".fd" else "font-map" if suffix == ".map" else "tex-source"
                        source_rows.append(f"{name}\t{suffix[1:]}\t{role}\t{file_hash}\n".encode("utf-8"))
                        if suffix in {".sty", ".cls", ".tex"}:
                            source_path = bundle_root.joinpath(*name.split("/"))
                            try:
                                source_text = source_path.read_text(encoding="utf-8")
                            except UnicodeDecodeError:
                                reference_rows.append(
                                    f"{name}\t0\tencoding\tnon-UTF-8 source; references not parsed\tunresolved\n".encode("utf-8")
                                )
                                continue
                            newline_offsets = [index for index, char in enumerate(source_text) if char == "\n"]
                            for match in DEPENDENCY_COMMAND.finditer(source_text):
                                command = match.group("command")
                                argument = match.group("argument").strip()
                                line_number = bisect.bisect_left(newline_offsets, match.start()) + 1
                                values = argument.split(",") if command in {
                                    "usepackage", "RequirePackage", "documentclass", "LoadClass",
                                    "bibliography", "addbibresource",
                                } else [argument]
                                for value in values:
                                    value = value.strip()
                                    classification = "literal" if LITERAL_REFERENCE.fullmatch(value) else "unresolved"
                                    reference_rows.append(
                                        f"{name}\t{line_number}\t{command}\t{value}\t{classification}\n".encode("utf-8")
                                    )
        table_bytes = table_temp.stat().st_size
        with table_temp.open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                table_hash.update(chunk)

        source_temp = output_dir / ".source-files.tsv.gz.tmp"
        reference_temp = output_dir / ".source-references.tsv.gz.tmp"
        index_temp = output_dir / ".index.txt.gz.tmp"
        for temp_path, rows in ((source_temp, source_rows), (reference_temp, reference_rows)):
            with temp_path.open("wb") as stream:
                with gzip.GzipFile(fileobj=stream, mode="wb", filename="", mtime=0, compresslevel=9) as gz:
                    for row in rows:
                        gz.write(row)
        with index_temp.open("wb") as stream:
            with gzip.GzipFile(fileobj=stream, mode="wb", filename="", mtime=0, compresslevel=9) as gz:
                gz.write(raw_index)
        source_files_sha = hashlib.sha256(source_temp.read_bytes()).hexdigest()
        source_refs_sha = hashlib.sha256(reference_temp.read_bytes()).hexdigest()
        index_gzip_sha = hashlib.sha256(index_temp.read_bytes()).hexdigest()

        metadata: dict[str, object] = {
            "schema": 1,
            "bundle": {
                "digest": BUNDLE_DIGEST,
                "identity": "Tectonic indexed-tar bundle digest plus exact indexed path",
                "index": {
                    "sha256": INDEX_SHA256,
                    "bytes": INDEX_BYTES,
                    "entries": INDEX_ENTRIES,
                    "file": "index.txt.gz",
                    "compressedBytes": index_temp.stat().st_size,
                    "compressedSha256": index_gzip_sha,
                },
            },
            "resources": {
                "file": "resources.tsv.gz",
                "encoding": "gzip UTF-8 TSV: path, offset, length, sha256",
                "sha256": table_hash.hexdigest(),
                "compressedBytes": table_bytes,
                "decompressedBytes": decompressed_bytes,
                "resourceBytes": bundle_bytes,
                "entries": len(entries),
            },
            "sourceMetadata": {
                "files": {
                    "file": "source-files.tsv.gz",
                    "sha256": source_files_sha,
                    "compressedBytes": source_temp.stat().st_size,
                    "entries": len(source_rows),
                },
                "references": {
                    "file": "source-references.tsv.gz",
                    "sha256": source_refs_sha,
                    "compressedBytes": reference_temp.stat().st_size,
                    "entries": len(reference_rows),
                },
                "scope": "Literal references from UTF-8 .sty/.cls/.tex sources; every indexed .fd and .map path is inventoried. This static scan does not resolve TeX semantics.",
                "unresolved": "Macro-valued and otherwise non-literal arguments are retained as unresolved expressions.",
            },
            "provenance": {
                "kind": "locally captured QA cache",
                "capture": "Automation resource preparation verification on 2026-10-08",
                "sourceCache": "temporary QA cache; no network access used by this builder",
                "trust": "Hashes pin the captured bytes and detect later corruption; they are not independent upstream authentication.",
            },
        }
        metadata_bytes = (json.dumps(metadata, sort_keys=True, indent=2) + "\n").encode("utf-8")
        metadata_temp.write_bytes(metadata_bytes)
        for generated in (table_temp, source_temp, reference_temp, index_temp, metadata_temp):
            generated.chmod(0o644)
        os.replace(table_temp, output_dir / "resources.tsv.gz")
        os.replace(index_temp, output_dir / "index.txt.gz")
        os.replace(source_temp, output_dir / "source-files.tsv.gz")
        os.replace(reference_temp, output_dir / "source-references.tsv.gz")
        os.replace(metadata_temp, output_dir / "metadata.json")
        return metadata
    finally:
        table_temp.unlink(missing_ok=True)
        metadata_temp.unlink(missing_ok=True)
        (output_dir / ".source-files.tsv.gz.tmp").unlink(missing_ok=True)
        (output_dir / ".source-references.tsv.gz.tmp").unlink(missing_ok=True)
        (output_dir / ".index.txt.gz.tmp").unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-bundles", type=Path, required=True, help="Tectonic cache/bundles directory")
    parser.add_argument("--output-dir", type=Path, default=Path("src-tauri/resource_catalog"))
    arguments = parser.parse_args()
    metadata = build_catalog(arguments.cache_bundles, arguments.output_dir)
    print(json.dumps(metadata, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
