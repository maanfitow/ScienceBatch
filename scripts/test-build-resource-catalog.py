"""Focused validation tests for the pinned resource catalog builder."""

import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("build-resource-catalog.py")
SPEC = importlib.util.spec_from_file_location("build_resource_catalog", MODULE_PATH)
builder = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(builder)


class CatalogBuilderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.data = self.root / "data"
        self.data.mkdir()
        self.index = self.data / f"{builder.BUNDLE_DIGEST}.index"
        self.bundle = self.data / builder.BUNDLE_DIGEST
        self.bundle.mkdir()
        (self.bundle / "alpha").write_bytes(b"abc")
        (self.bundle / "beta").write_bytes(b"")
        package_source = "\\RequirePackage{knownpkg,\\computedPackage}\n\\input{chapter}\n"
        (self.bundle / "pkg.sty").write_text(package_source, encoding="utf-8")
        (self.bundle / "font.fd").write_bytes(b"font fd")
        (self.bundle / "font.map").write_bytes(b"font map")
        index = (
            f"alpha 0 3\nbeta 512 0\npkg.sty 1024 {len(package_source.encode())}\n"
            "font.fd 1536 7\nfont.map 2048 8\n"
        )
        self.index.write_text(index, encoding="utf-8")
        raw = self.index.read_bytes()
        builder.INDEX_BYTES = len(raw)
        builder.INDEX_SHA256 = hashlib.sha256(raw).hexdigest()
        builder.INDEX_ENTRIES = 5

    def tearDown(self):
        self.temp.cleanup()

    def assert_invalid(self, message):
        with self.assertRaisesRegex(builder.CatalogError, message):
            builder.build_catalog(self.root, self.root / "out")

    def test_wrong_index_hash_is_rejected(self):
        builder.INDEX_SHA256 = "0" * 64
        self.assert_invalid("SHA-256 mismatch")

    def test_wrong_index_size_is_rejected(self):
        builder.INDEX_BYTES += 1
        self.assert_invalid("length mismatch")

    def test_wrong_resource_size_is_rejected(self):
        (self.bundle / "alpha").write_bytes(b"ab")
        self.assert_invalid("size mismatch")

    def test_symlink_resource_is_rejected(self):
        (self.bundle / "alpha").unlink()
        outside = self.root / "outside"
        outside.write_bytes(b"abc")
        (self.bundle / "alpha").symlink_to(outside)
        self.assert_invalid("symlink")

    def test_duplicate_paths_are_rejected(self):
        self.index.write_text("alpha 0 3\nalpha 512 3\n", encoding="utf-8")
        raw = self.index.read_bytes()
        builder.INDEX_BYTES = len(raw)
        builder.INDEX_SHA256 = hashlib.sha256(raw).hexdigest()
        builder.INDEX_ENTRIES = 2
        self.assert_invalid("duplicate")

    def test_ancestor_symlink_is_rejected(self):
        alias = self.root.parent / f"{self.root.name}-alias"
        alias.symlink_to(self.root, target_is_directory=True)
        try:
            with self.assertRaisesRegex(builder.CatalogError, "symlink"):
                builder.build_catalog(alias, self.root / "out")
        finally:
            alias.unlink()

    def test_index_range_overflow_is_rejected(self):
        self.index.write_text(f"alpha {builder.MAX_U64} 3\nbeta 512 0\n", encoding="utf-8")
        raw = self.index.read_bytes()
        builder.INDEX_BYTES = len(raw)
        builder.INDEX_SHA256 = hashlib.sha256(raw).hexdigest()
        builder.INDEX_ENTRIES = 2
        self.assert_invalid("range")

    def test_deterministic_output_including_empty_file(self):
        out1, out2 = self.root / "out1", self.root / "out2"
        first = builder.build_catalog(self.root, out1)
        second = builder.build_catalog(self.root, out2)
        self.assertEqual(first, second)
        self.assertEqual((out1 / "resources.tsv.gz").read_bytes(), (out2 / "resources.tsv.gz").read_bytes())
        self.assertEqual((out1 / "index.txt.gz").read_bytes(), (out2 / "index.txt.gz").read_bytes())
        self.assertEqual((out1 / "source-files.tsv.gz").read_bytes(), (out2 / "source-files.tsv.gz").read_bytes())
        self.assertEqual((out1 / "source-references.tsv.gz").read_bytes(), (out2 / "source-references.tsv.gz").read_bytes())
        self.assertEqual((out1 / "metadata.json").read_bytes(), (out2 / "metadata.json").read_bytes())
        self.assertLessEqual(first["resources"]["decompressedBytes"], builder.MAX_TABLE_BYTES)
        import gzip
        with gzip.open(out1 / "source-files.tsv.gz", "rt", encoding="utf-8") as stream:
            sources = stream.read()
        self.assertIn("font.fd\tfd\tfont-definition", sources)
        self.assertIn("font.map\tmap\tfont-map", sources)
        with gzip.open(out1 / "source-references.tsv.gz", "rt", encoding="utf-8") as stream:
            references = stream.read()
        self.assertIn("pkg.sty\t1\tRequirePackage\t\\computedPackage\tunresolved", references)
        self.assertIn("pkg.sty\t2\tinput\tchapter\tliteral", references)


if __name__ == "__main__":
    unittest.main()
