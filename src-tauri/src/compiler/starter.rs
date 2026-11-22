//! Read-only embedded subset for compiling the default LaTeX Showcase offline.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{Cursor, Read};
use std::sync::OnceLock;
use zip::ZipArchive;

pub const BUNDLE_DIGEST: &str = "6ffe055852f8faf66c0acbe1a7fb27f87b869a90bad1204f3bf4d9683f597c7c";
pub const INDEX_SHA256: &str = "0fb434b0fa5fdebea7f767ed9c31939c99a780d6f95cd3f540aae55910bb5697";
const MAX_ARCHIVE_BYTES: usize = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 32 * 1024 * 1024;
const MAX_RESOURCE_BYTES: usize = 32 * 1024 * 1024;
const MAX_RESOURCES: usize = 1_000;

const MANIFEST: &[u8] = include_bytes!("../../embedded_packages/starter-latex/manifest.json");
const ARCHIVE: &[u8] = include_bytes!("../../embedded_packages/starter-latex/resources.zip");

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StarterManifest {
    schema_version: u32,
    bundle_digest: String,
    index_sha256: String,
    resource_count: usize,
    total_bytes: usize,
    archive_bytes: usize,
    archive_sha256: String,
    resources: Vec<StarterResourceDescriptor>,
    provenance: String,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StarterResourceDescriptor {
    path: String,
    length: usize,
    sha256: String,
}

struct StarterPack {
    resources: BTreeMap<String, Vec<u8>>,
    descriptors: BTreeMap<String, (u64, String)>,
}

static STARTER: OnceLock<Result<StarterPack, String>> = OnceLock::new();

fn starter() -> Result<&'static StarterPack, String> {
    match STARTER.get_or_init(load_starter) {
        Ok(pack) => Ok(pack),
        Err(message) => Err(message.clone()),
    }
}

fn load_starter() -> Result<StarterPack, String> {
    load_starter_from(MANIFEST, ARCHIVE)
}

fn load_starter_from(manifest_bytes: &[u8], archive_bytes: &[u8]) -> Result<StarterPack, String> {
    if archive_bytes.len() > MAX_ARCHIVE_BYTES {
        return Err("embedded starter archive exceeds its size limit".into());
    }
    if manifest_bytes.len() > MAX_MANIFEST_BYTES {
        return Err("embedded starter manifest exceeds its size limit".into());
    }
    let manifest: StarterManifest = serde_json::from_slice(manifest_bytes)
        .map_err(|error| format!("embedded starter manifest is invalid: {error}"))?;
    if manifest.schema_version != 1
        || manifest.bundle_digest != BUNDLE_DIGEST
        || manifest.index_sha256 != INDEX_SHA256
        || manifest.provenance != "locally captured QA cache; not upstream authentication"
        || manifest.resource_count == 0
        || manifest.resource_count > MAX_RESOURCES
        || manifest.resource_count != manifest.resources.len()
        || manifest.archive_bytes != archive_bytes.len()
        || manifest.archive_sha256.len() != 64
        || format!("{:x}", Sha256::digest(archive_bytes)) != manifest.archive_sha256
    {
        return Err("embedded starter manifest does not match the pinned bundle identity".into());
    }

    let mut archive = ZipArchive::new(Cursor::new(archive_bytes))
        .map_err(|error| format!("embedded starter archive is invalid: {error}"))?;
    if archive.len() != manifest.resources.len() {
        return Err("embedded starter archive entry count does not match its manifest".into());
    }
    let mut resources = BTreeMap::new();
    let mut descriptors = BTreeMap::new();
    let mut total_bytes = 0usize;
    let mut previous_path: Option<&str> = None;
    for (index, descriptor) in manifest.resources.iter().enumerate() {
        if !safe_path(&descriptor.path)
            || descriptor.length > MAX_RESOURCE_BYTES
            || descriptor.sha256.len() != 64
            || !descriptor
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || previous_path.is_some_and(|previous| previous >= descriptor.path.as_str())
        {
            return Err("embedded starter manifest contains an invalid resource row".into());
        }
        previous_path = Some(&descriptor.path);
        total_bytes = total_bytes.saturating_add(descriptor.length);
        if total_bytes > MAX_TOTAL_BYTES {
            return Err("embedded starter payload exceeds its decompressed size limit".into());
        }
        let mut file = archive
            .by_index(index)
            .map_err(|error| format!("embedded starter archive entry is invalid: {error}"))?;
        if file.name() != descriptor.path
            || file.is_dir()
            || file
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 != 0o100000)
            || file.size() != descriptor.length as u64
        {
            return Err("embedded starter archive layout does not match its manifest".into());
        }
        let mut bytes = Vec::with_capacity(descriptor.length);
        file.by_ref()
            .take(descriptor.length.saturating_add(1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("cannot read embedded starter resource: {error}"))?;
        if bytes.len() != descriptor.length
            || format!("{:x}", Sha256::digest(&bytes)) != descriptor.sha256
        {
            return Err("embedded starter resource failed its length or hash check".into());
        }
        let path = descriptor.path.clone();
        let descriptor_hash = descriptor.sha256.clone();
        if resources.insert(path.clone(), bytes).is_some()
            || descriptors
                .insert(path, (descriptor.length as u64, descriptor_hash))
                .is_some()
        {
            return Err("embedded starter manifest contains duplicate paths".into());
        }
    }
    if total_bytes != manifest.total_bytes {
        return Err("embedded starter payload size does not match its manifest".into());
    }
    Ok(StarterPack {
        resources,
        descriptors,
    })
}

fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains(':')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

/// Validate the embedded archive against the resource catalog's canonical hashes.
pub(crate) fn validate_catalog(
    bundle_digest: &str,
    index_sha256: &str,
    catalog_resources: &BTreeMap<String, (u64, String)>,
) -> Result<(), String> {
    if bundle_digest != BUNDLE_DIGEST || index_sha256 != INDEX_SHA256 {
        return Err("starter resource identity differs from the pinned catalog".into());
    }
    let pack = starter()?;
    if pack
        .descriptors
        .iter()
        .any(|(path, (length, hash))| catalog_resources.get(path) != Some(&(*length, hash.clone())))
    {
        return Err("starter resource hashes do not match the pinned catalog".into());
    }
    Ok(())
}

pub(crate) fn contains(path: &str) -> bool {
    starter().is_ok_and(|pack| pack.resources.contains_key(path))
}

pub(crate) fn read(path: &str) -> Result<Option<Vec<u8>>, String> {
    starter().map(|pack| pack.resources.get(path).cloned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    #[test]
    fn starter_archive_is_pinned_bounded_and_hash_verified() {
        let pack = starter().expect("starter archive should load");
        assert_eq!(pack.resources.len(), 358);
        assert!(pack.resources.contains_key("latex.ltx"));
        assert!(pack.resources.contains_key("article.cls"));
        for (path, bytes) in &pack.resources {
            let (length, expected_hash) = &pack.descriptors[path];
            assert_eq!(bytes.len() as u64, *length);
            assert_eq!(format!("{:x}", Sha256::digest(bytes)), *expected_hash);
        }
    }

    #[test]
    fn starter_archive_rejects_catalog_identity_mismatch() {
        let mut resources = BTreeMap::new();
        let pack = starter().unwrap();
        for (path, descriptor) in &pack.descriptors {
            resources.insert(path.clone(), descriptor.clone());
        }
        assert!(validate_catalog("wrong", INDEX_SHA256, &resources).is_err());
        assert!(validate_catalog(BUNDLE_DIGEST, "wrong", &resources).is_err());
        assert!(validate_catalog(BUNDLE_DIGEST, INDEX_SHA256, &resources).is_ok());
    }

    #[test]
    fn loader_rejects_corrupt_archive_and_unsafe_manifest_paths() {
        let mut archive_bytes = Vec::new();
        {
            let mut archive = zip::ZipWriter::new(Cursor::new(&mut archive_bytes));
            archive
                .start_file("safe/file.sty", zip::write::SimpleFileOptions::default())
                .unwrap();
            archive.write_all(b"safe contents").unwrap();
            archive.finish().unwrap();
        }
        let archive_hash = format!("{:x}", Sha256::digest(&archive_bytes));
        let safe_manifest = json!({
            "schemaVersion": 1,
            "bundleDigest": BUNDLE_DIGEST,
            "indexSha256": INDEX_SHA256,
            "resourceCount": 1,
            "totalBytes": 13,
            "archiveBytes": archive_bytes.len(),
            "archiveSha256": archive_hash,
            "resources": [{"path":"safe/file.sty","length":13,"sha256":format!("{:x}", Sha256::digest(b"safe contents"))}],
            "provenance": "locally captured QA cache; not upstream authentication"
        });
        let safe_bytes = serde_json::to_vec(&safe_manifest).unwrap();
        assert!(load_starter_from(&safe_bytes, &archive_bytes).is_ok());
        let mut corrupted = archive_bytes.clone();
        corrupted[20] ^= 0xff;
        assert!(load_starter_from(&safe_bytes, &corrupted).is_err());

        let unsafe_manifest = json!({
            "schemaVersion": 1,
            "bundleDigest": BUNDLE_DIGEST,
            "indexSha256": INDEX_SHA256,
            "resourceCount": 1,
            "totalBytes": 13,
            "archiveBytes": archive_bytes.len(),
            "archiveSha256": archive_hash,
            "resources": [{"path":"../escape.sty","length":13,"sha256":format!("{:x}", Sha256::digest(b"safe contents"))}],
            "provenance": "locally captured QA cache; not upstream authentication"
        });
        assert!(load_starter_from(
            &serde_json::to_vec(&unsafe_manifest).unwrap(),
            &archive_bytes
        )
        .is_err());

        let mut oversized_manifest = safe_manifest;
        oversized_manifest["resourceCount"] = json!(MAX_RESOURCES + 1);
        assert!(load_starter_from(
            &serde_json::to_vec(&oversized_manifest).unwrap(),
            &archive_bytes
        )
        .is_err());
    }
}
