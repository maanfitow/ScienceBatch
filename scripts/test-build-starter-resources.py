#!/usr/bin/env python3
"""Focused tests for starter resource build bounds and reproducibility."""

from __future__ import annotations

import gzip
import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("build-starter-resources.py")
SPEC = importlib.util.spec_from_file_location("build_starter_resources", SCRIPT)
assert SPEC and SPEC.loader
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class StarterBuilderTests(unittest.TestCase):
    def test_safe_paths_reject_traversal_and_platform_paths(self) -> None:
        for path in ("../escape", "/absolute", "a/../b", "a\\b", "C:/a", "a//b"):
            self.assertFalse(builder.safe_path(path), path)
        self.assertTrue(builder.safe_path("tex/latex/base/article.cls"))

    def test_reproducible_archive_and_pinned_member_hashes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sciencebatch-starter-builder-") as root_text:
            root = Path(root_text)
            cache_bundles = root / "cache" / "bundles"
            bundle_root = cache_bundles / "data" / builder.BUNDLE_DIGEST
            bundle_root.mkdir(parents=True)
            contents = b"starter class\n"
            (bundle_root / "article.cls").write_bytes(contents)
            resource_hash = hashlib.sha256(contents).hexdigest()

            catalog_dir = root / "catalog"
            catalog_dir.mkdir()
            table_path = catalog_dir / "resources.tsv.gz"
            with gzip.open(catalog_dir / "resources.tsv.gz", "wt", encoding="utf-8") as table:
                table.write(f"article.cls\t100\t{len(contents)}\t{resource_hash}\n")
            table_bytes = table_path.read_bytes()
            (catalog_dir / "metadata.json").write_text(
                json.dumps(
                    {
                        "bundle": {
                            "digest": builder.BUNDLE_DIGEST,
                            "index": {"sha256": builder.INDEX_SHA256},
                        },
                        "resources": {
                            "compressedBytes": len(table_bytes),
                            "sha256": hashlib.sha256(table_bytes).hexdigest(),
                        },
                    }
                ),
                encoding="utf-8",
            )

            paths_json = root / "paths.json"
            paths_json.write_text(
                json.dumps(
                    {
                        "items": [
                            {
                                "item": {
                                    "provider": "pinned_bundle",
                                    "path": "article.cls",
                                    "indexedBytes": len(contents),
                                    "sha256": resource_hash,
                                }
                            },
                            {"item": {"provider": "project_local", "path": "main.tex"}},
                        ]
                    }
                ),
                encoding="utf-8",
            )

            first, second = root / "first", root / "second"
            result_a = builder.build(cache_bundles, paths_json, catalog_dir, first)
            result_b = builder.build(cache_bundles, first / "manifest.json", catalog_dir, second)
            self.assertEqual(result_a, result_b)
            self.assertEqual((first / "resources.zip").read_bytes(), (second / "resources.zip").read_bytes())
            self.assertEqual((first / "manifest.json").read_bytes(), (second / "manifest.json").read_bytes())
            self.assertEqual(result_a["resourceCount"], 1)
            self.assertEqual(result_a["totalBytes"], len(contents))

    def test_changed_cache_body_fails_before_archive_publication(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sciencebatch-starter-tamper-") as root_text:
            root = Path(root_text)
            cache_bundles = root / "cache" / "bundles"
            bundle_root = cache_bundles / "data" / builder.BUNDLE_DIGEST
            bundle_root.mkdir(parents=True)
            (bundle_root / "article.cls").write_bytes(b"tampered")
            catalog_dir = root / "catalog"
            catalog_dir.mkdir()
            table_path = catalog_dir / "resources.tsv.gz"
            expected = b"trusted"
            digest = hashlib.sha256(expected).hexdigest()
            with gzip.open(table_path, "wt", encoding="utf-8") as table:
                table.write(f"article.cls\t100\t{len(expected)}\t{digest}\n")
            table_bytes = table_path.read_bytes()
            (catalog_dir / "metadata.json").write_text(
                json.dumps(
                    {
                        "bundle": {"digest": builder.BUNDLE_DIGEST, "index": {"sha256": builder.INDEX_SHA256}},
                        "resources": {"compressedBytes": len(table_bytes), "sha256": hashlib.sha256(table_bytes).hexdigest()},
                    }
                ),
                encoding="utf-8",
            )
            paths_json = root / "paths.json"
            paths_json.write_text(
                json.dumps([{"provider": "pinned_bundle", "path": "article.cls", "indexedBytes": len(expected), "sha256": digest}]),
                encoding="utf-8",
            )
            output_dir = root / "output"
            with self.assertRaises(builder.StarterBuildError):
                builder.build(cache_bundles, paths_json, catalog_dir, output_dir)
            self.assertFalse((output_dir / "resources.zip").exists())

    @unittest.skipUnless(
        hasattr(os, "O_NOFOLLOW") and os.open in os.supports_dir_fd,
        "requires no-follow directory handles",
    )
    def test_symlinked_cache_resource_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sciencebatch-starter-symlink-") as root_text:
            root = Path(root_text)
            outside = root / "outside.sty"
            outside.write_bytes(b"safe contents")
            bundle_root = root / "bundle"
            bundle_root.mkdir()
            (bundle_root / "article.cls").symlink_to(outside)
            descriptor = {
                "path": "article.cls",
                "length": len(b"safe contents"),
                "sha256": hashlib.sha256(b"safe contents").hexdigest(),
            }
            with self.assertRaises(OSError):
                builder.read_verified(bundle_root, descriptor)


if __name__ == "__main__":
    unittest.main()
