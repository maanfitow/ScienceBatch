#!/usr/bin/env python3
"""Build a deterministic embedded resource archive from an already prepared QA cache."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import stat
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

BUNDLE_DIGEST = "6ffe055852f8faf66c0acbe1a7fb27f87b869a90bad1204f3bf4d9683f597c7c"
INDEX_SHA256 = "0fb434b0fa5fdebea7f767ed9c31939c99a780d6f95cd3f540aae55910bb5697"
MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
MAX_TOTAL_BYTES = 32 * 1024 * 1024
MAX_CATALOG_TABLE_BYTES = 32 * 1024 * 1024
MAX_CATALOG_COMPRESSED_BYTES = 16 * 1024 * 1024
MAX_ENTRIES = 1_000


class StarterBuildError(ValueError):
    pass


def safe_path(value: str) -> bool:
    path = PurePosixPath(value)
    return (
        bool(value)
        and not path.is_absolute()
        and "\\" not in value
        and ":" not in value
        and all(part not in ("", ".", "..") for part in value.split("/"))
        and tuple(value.split("/")) == path.parts
    )


def validate_directory_chain(path: Path) -> Path:
    absolute = path.absolute()
    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current = current / part
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise StarterBuildError(f"cache path contains a symlink or non-directory: {current}")
    return absolute


def open_directory_chain(path: Path) -> int:
    absolute = path.absolute()
    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(absolute.anchor, directory_flags)
    try:
        for part in absolute.parts[1:]:
            child = os.open(part, directory_flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def read_regular_file(path: Path, limit: int) -> bytes:
    before = path.lstat()
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode) or before.st_size > limit:
        raise StarterBuildError(f"input is not a bounded regular file: {path}")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or opened.st_size != before.st_size:
            raise StarterBuildError(f"input changed while opening: {path}")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            data = stream.read(limit + 1)
        after = os.fstat(descriptor)
        if _file_identity(opened) != _file_identity(after):
            raise StarterBuildError(f"input changed while reading: {path}")
    finally:
        os.close(descriptor)
    if len(data) > limit:
        raise StarterBuildError(f"input exceeds its size limit: {path}")
    return data


def _file_identity(info: os.stat_result) -> tuple[int, int, int, int, int]:
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def load_resources(
    paths_json: Path, table_path: Path, metadata: dict[str, object]
) -> list[dict[str, object]]:
    payload = json.loads(read_regular_file(paths_json, 16 * 1024 * 1024))
    manifest_input = False
    if isinstance(payload, dict):
        if isinstance(payload.get("items"), list):
            payload = payload["items"]
        elif (
            payload.get("schemaVersion") == 1
            and payload.get("bundleDigest") == BUNDLE_DIGEST
            and payload.get("indexSha256") == INDEX_SHA256
            and isinstance(payload.get("resources"), list)
        ):
            payload = payload["resources"]
            manifest_input = True
    if not isinstance(payload, list):
        raise StarterBuildError("resource input must be a JSON array, a resource-list object, or a pinned starter manifest")

    requested: dict[str, dict[str, object]] = {}
    for row in payload:
        item = row.get("item", row) if isinstance(row, dict) else None
        if not isinstance(item, dict):
            raise StarterBuildError("resource list contains a malformed item")
        if manifest_input:
            item = {
                "provider": "pinned_bundle",
                "path": item.get("path"),
                "indexedBytes": item.get("length"),
                "sha256": item.get("sha256"),
            }
        if item.get("provider") != "pinned_bundle":
            continue
        path = item.get("path")
        digest = item.get("sha256")
        size = item.get("indexedBytes")
        if not isinstance(path, str) or not safe_path(path):
            raise StarterBuildError("resource list contains an unsafe bundle path")
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise StarterBuildError(f"resource list has an invalid hash for {path}")
        if not isinstance(size, int) or size < 0 or size > MAX_TOTAL_BYTES:
            raise StarterBuildError(f"resource list has an invalid size for {path}")
        if path in requested:
            raise StarterBuildError(f"duplicate resource path: {path}")
        requested[path] = {"path": path, "length": size, "sha256": digest}

    if not requested or len(requested) > MAX_ENTRIES:
        raise StarterBuildError("starter resource count is empty or exceeds its limit")

    artifact = metadata["resources"]
    if not isinstance(artifact, dict):
        raise StarterBuildError("resource catalog metadata is malformed")
    table_bytes = read_regular_file(table_path, MAX_CATALOG_COMPRESSED_BYTES)
    if len(table_bytes) != artifact.get("compressedBytes"):
        raise StarterBuildError("compressed resource catalog table size does not match metadata")
    table_hash = hashlib.sha256(table_bytes).hexdigest()
    if table_hash != artifact.get("sha256"):
        raise StarterBuildError("compressed resource catalog table hash does not match metadata")
    catalog: dict[str, tuple[int, str]] = {}
    decompressed_bytes = 0
    with gzip.GzipFile(fileobj=io.BytesIO(table_bytes), mode="rb") as compressed:
        stream = io.TextIOWrapper(compressed, encoding="utf-8")
        for line in stream:
            decompressed_bytes += len(line.encode("utf-8"))
            if decompressed_bytes > MAX_CATALOG_TABLE_BYTES:
                raise StarterBuildError("decompressed resource catalog table exceeds its size limit")
            fields = line.rstrip("\n").split("\t")
            if len(fields) != 4:
                raise StarterBuildError("pinned resource catalog has a malformed row")
            name, _offset, length_text, digest = fields
            if name in requested:
                catalog[name] = (int(length_text), digest)
    if len(catalog) != len(requested):
        raise StarterBuildError("one or more starter paths are absent from the pinned catalog")
    for path, descriptor in requested.items():
        if catalog[path] != (descriptor["length"], descriptor["sha256"]):
            raise StarterBuildError(f"resource list metadata does not match the pinned catalog: {path}")
    return [requested[path] for path in sorted(requested)]


def read_verified(root: Path, descriptor: dict[str, object]) -> bytes:
    path = str(descriptor["path"])
    directory_fd = open_directory_chain(root)
    file_fd = -1
    try:
        directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        parts = path.split("/")
        for part in parts[:-1]:
            child = os.open(part, directory_flags, dir_fd=directory_fd)
            os.close(directory_fd)
            directory_fd = child
        file_fd = os.open(parts[-1], os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=directory_fd)
        opened = os.fstat(file_fd)
        if not stat.S_ISREG(opened.st_mode) or opened.st_size != descriptor["length"]:
            raise StarterBuildError(f"resource is not a regular file or has an unexpected size: {path}")
        with os.fdopen(file_fd, "rb", closefd=False) as stream:
            data = stream.read(int(descriptor["length"]) + 1)
        after = os.fstat(file_fd)
        if _file_identity(opened) != _file_identity(after):
            raise StarterBuildError(f"resource changed while reading: {path}")
    finally:
        if file_fd >= 0:
            os.close(file_fd)
        os.close(directory_fd)
    if len(data) != descriptor["length"] or hashlib.sha256(data).hexdigest() != descriptor["sha256"]:
        raise StarterBuildError(f"resource failed pinned hash verification: {path}")
    return data


def build(cache_bundles: Path, paths_json: Path, catalog_dir: Path, output_dir: Path) -> dict[str, object]:
    catalog_dir = validate_directory_chain(catalog_dir)
    metadata = json.loads(read_regular_file(catalog_dir / "metadata.json", 1024 * 1024))
    bundle = metadata["bundle"]
    if bundle["digest"] != BUNDLE_DIGEST or bundle["index"]["sha256"] != INDEX_SHA256:
        raise StarterBuildError("resource catalog identity does not match the compiled starter identity")
    descriptors = load_resources(paths_json, catalog_dir / "resources.tsv.gz", metadata)
    bundle_root = validate_directory_chain(cache_bundles / "data" / BUNDLE_DIGEST)
    contents = [(descriptor, read_verified(bundle_root, descriptor)) for descriptor in descriptors]
    total_bytes = sum(len(data) for _, data in contents)
    if total_bytes > MAX_TOTAL_BYTES:
        raise StarterBuildError("starter resource payload exceeds the 32 MiB limit")

    output_dir.mkdir(parents=True, exist_ok=True)
    archive_path = output_dir / "resources.zip"
    manifest_path = output_dir / "manifest.json"
    fd, temp_name = tempfile.mkstemp(prefix=".starter-", suffix=".zip", dir=output_dir)
    os.close(fd)
    temp_archive = Path(temp_name)
    try:
        with zipfile.ZipFile(temp_archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for descriptor, data in contents:
                info = zipfile.ZipInfo(str(descriptor["path"]), date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                info.create_system = 3
                archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        archive_bytes = temp_archive.read_bytes()
        if len(archive_bytes) > MAX_ARCHIVE_BYTES:
            raise StarterBuildError("compressed starter archive exceeds the 32 MiB limit")
        manifest = {
            "schemaVersion": 1,
            "bundleDigest": BUNDLE_DIGEST,
            "indexSha256": INDEX_SHA256,
            "resourceCount": len(descriptors),
            "totalBytes": total_bytes,
            "archiveBytes": len(archive_bytes),
            "archiveSha256": hashlib.sha256(archive_bytes).hexdigest(),
            "resources": descriptors,
            "provenance": "locally captured QA cache; not upstream authentication",
        }
        temp_manifest = output_dir / ".manifest.json.tmp"
        temp_manifest.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        temp_archive.replace(archive_path)
        temp_manifest.replace(manifest_path)
        return manifest
    finally:
        temp_archive.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache-bundles", type=Path, required=True)
    parser.add_argument("--paths-json", type=Path, required=True)
    parser.add_argument("--catalog-dir", type=Path, default=Path("src-tauri/resource_catalog"))
    parser.add_argument("--output-dir", type=Path, default=Path("src-tauri/embedded_packages/starter-latex"))
    args = parser.parse_args()
    try:
        manifest = build(args.cache_bundles, args.paths_json, args.catalog_dir, args.output_dir)
    except (OSError, KeyError, TypeError, ValueError, zipfile.BadZipFile) as error:
        parser.exit(2, f"error: {error}\n")
    print(json.dumps({key: manifest[key] for key in ("resourceCount", "totalBytes", "archiveBytes", "archiveSha256")}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
