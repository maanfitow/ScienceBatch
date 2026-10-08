// Copyright 2017-2021 the Tectonic Project
// Licensed under the MIT License.

//! The web-friendly "indexed tar" bundle backend.
//!
//! The main type offered by this module is the [`ItarBundle`] struct,
//! which can (but should not) be used directly as any other bundle.
//!
//! Instead, wrap it in a [`crate::BundleCache`] for filesystem-backed
//! caching.
//!
//! While the on-server file format backing the "indexed tar" backend is indeed
//! a standard `tar` file, as far as the client is concerned, this backend is
//! centered on HTTP byte-range requests. For each file contained in the backing
//! resource, the index file merely contains a byte offset and length that are
//! then used to construct an HTTP Range request to obtain the file as needed.

use crate::{Bundle, CachableBundle, FileIndex, FileInfo, NET_RETRY_ATTEMPTS, NET_RETRY_SLEEP_MS};
use flate2::read::GzDecoder;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Cursor, Read},
    str::FromStr,
    thread,
    time::Duration,
};
use tectonic_errors::prelude::*;
use tectonic_geturl::{DefaultBackend, DefaultRangeReader, GetUrlBackend, RangeReader};
use tectonic_io_base::{digest, InputHandle, InputOrigin, IoProvider, OpenResult};
use tectonic_status_base::{tt_note, tt_warning, NoopStatusBackend, StatusBackend};

mod batch;

/// Read a single file's bytes through `reader`, retrying on transient failures.
///
/// This is the shared core used by both the one-at-a-time [`ItarBundle::open_fileinfo`]
/// path and the concurrent [`ItarBundle::batch_open`] path.
fn read_file_with_retries(
    reader: &mut DefaultRangeReader,
    info: &ItarFileInfo,
    status: &mut dyn StatusBackend,
) -> OpenResult<Vec<u8>> {
    // Edge case for zero-sized reads (these cause errors on some web hosts).
    if info.length == 0 {
        return OpenResult::Ok(Vec::new());
    }

    for i in 0..NET_RETRY_ATTEMPTS {
        if let Err(e) = crate::cache::consume_download_bytes(info.length as u64) {
            return OpenResult::Err(e.into());
        }
        let mut stream = match reader.read_range(info.offset, info.length) {
            Ok(r) => r,
            Err(e) => {
                tt_warning!(status,
                    "failure fetching \"{}\" from network ({}/{NET_RETRY_ATTEMPTS})",
                    info.name, i+1; e
                );
                thread::sleep(Duration::from_millis(NET_RETRY_SLEEP_MS));
                continue;
            }
        };

        let mut v = Vec::with_capacity(info.length);
        match stream.read_to_end(&mut v) {
            Ok(_) => return OpenResult::Ok(v),
            Err(e) => {
                tt_warning!(status,
                    "failure downloading \"{}\" from network ({}/{NET_RETRY_ATTEMPTS})",
                    info.name, i+1; e.into()
                );
                thread::sleep(Duration::from_millis(NET_RETRY_SLEEP_MS));
                continue;
            }
        };
    }

    OpenResult::Err(anyhow!(
        "failed to download \"{}\"; please check your network connection.",
        info.name
    ))
}

/// The internal file-information struct used by the [`ItarBundle`].
#[derive(Clone, Debug)]
pub struct ItarFileInfo {
    name: String,
    offset: u64,
    length: usize,
}

impl FileInfo for ItarFileInfo {
    fn name(&self) -> &str {
        &self.name
    }
    fn path(&self) -> &str {
        &self.name
    }

    fn length(&self) -> Option<u64> {
        Some(self.length as u64)
    }
}

/// A simple FileIndex for compatiblity with [`crate::BundleCache`]
#[derive(Default, Debug)]
pub struct ItarFileIndex {
    content: HashMap<String, ItarFileInfo>,
}

impl<'this> FileIndex<'this> for ItarFileIndex {
    type InfoType = ItarFileInfo;

    fn iter(&'this self) -> Box<dyn Iterator<Item = &'this ItarFileInfo> + 'this> {
        Box::new(self.content.values())
    }

    fn len(&self) -> usize {
        self.content.len()
    }

    fn initialize(&mut self, reader: &mut dyn Read) -> Result<()> {
        self.content.clear();

        for line in BufReader::new(reader).lines() {
            let line = line?;
            let mut bits = line.split_whitespace();

            if let (Some(name), Some(offset), Some(length)) =
                (bits.next(), bits.next(), bits.next())
            {
                self.content.insert(
                    name.to_owned(),
                    ItarFileInfo {
                        name: name.to_owned(),
                        offset: offset.parse::<u64>()?,
                        length: length.parse::<usize>()?,
                    },
                );
            } else {
                // TODO: preserve the warning info or something!
                bail!("malformed index line");
            }
        }
        Ok(())
    }

    /// Find a file in this index
    fn search(&'this mut self, name: &str) -> Option<ItarFileInfo> {
        self.content.get(name).cloned()
    }
}

/// The old-fashoned Tectonic web bundle format.
pub struct ItarBundle {
    url: String,
    /// Maps all available file names to [`FileInfo`]s.
    /// This is empty after we create this bundle, so we don't need network
    /// to make an object. It is automatically filled by get_index when we need it.
    index: ItarFileIndex,

    /// RangeReader object, responsible for sending queries.
    /// Will be None when the object is created, automatically
    /// replaced with Some(...) once needed.
    reader: Option<DefaultRangeReader>,
}

impl ItarBundle {
    /// Make a new ItarBundle.
    /// This method does not require network access.
    /// It will succeed even in we can't connect to the bundle, or if we're given a bad url.
    pub fn new(url: String) -> Result<ItarBundle> {
        Ok(ItarBundle {
            index: ItarFileIndex::default(),
            reader: None,
            url,
        })
    }

    fn connect_reader(&mut self) {
        let geturl_backend = DefaultBackend::default();
        // Connect reader if it is not already connected
        if self.reader.is_none() {
            self.reader = Some(geturl_backend.open_range_reader(&self.url));
        }
    }

    /// Fill this bundle's index, if it is empty.
    fn ensure_index(&mut self) -> Result<()> {
        // The index may have been initialized from the on-disk cache. Make sure
        // file reads still have a range reader before taking the early return.
        // Creating the reader does not perform network I/O.
        self.connect_reader();

        // Fetch index if it is empty
        if self.index.is_initialized() {
            return Ok(());
        }

        let mut reader = self.get_index_reader()?;
        self.index.initialize(&mut reader)?;

        Ok(())
    }
}

impl IoProvider for ItarBundle {
    fn input_open_name(
        &mut self,
        name: &str,
        status: &mut dyn StatusBackend,
    ) -> OpenResult<InputHandle> {
        if let Err(e) = self.ensure_index() {
            return OpenResult::Err(e);
        };

        let info = match self.index.search(name) {
            Some(a) => a,
            None => return OpenResult::NotAvailable,
        };

        // Retries are handled in open_fileinfo,
        // since BundleCache never calls input_open_name.
        self.open_fileinfo(&info, status)
    }
}

impl Bundle for ItarBundle {
    fn all_files(&self) -> Vec<String> {
        self.index.iter().map(|x| x.path().to_owned()).collect()
    }

    fn get_digest(&mut self) -> Result<tectonic_io_base::digest::DigestData> {
        let digest_text = match self.input_open_name(digest::DIGEST_NAME, &mut NoopStatusBackend {})
        {
            OpenResult::Ok(h) => {
                let mut text = String::new();
                h.take(64).read_to_string(&mut text)?;
                text
            }

            OpenResult::NotAvailable => {
                // Broken or un-cacheable backend.
                bail!("bundle does not provide needed SHA256SUM file");
            }

            OpenResult::Err(e) => {
                return Err(e);
            }
        };

        Ok(atry!(digest::DigestData::from_str(&digest_text); ["corrupted SHA256 digest data"]))
    }
}

impl CachableBundle<'_, ItarFileIndex> for ItarBundle {
    fn supports_batch_open(&self) -> bool {
        true
    }

    fn get_location(&mut self) -> String {
        self.url.clone()
    }

    fn initialize_index(&mut self, source: &mut dyn Read) -> Result<()> {
        self.index.initialize(source)?;
        Ok(())
    }

    fn index(&mut self) -> &mut ItarFileIndex {
        &mut self.index
    }

    fn all_infos(&mut self) -> Vec<ItarFileInfo> {
        self.index.iter().cloned().collect()
    }

    fn search(&mut self, name: &str) -> Option<ItarFileInfo> {
        self.index.search(name)
    }

    fn get_index_reader(&mut self) -> Result<Box<dyn Read>> {
        let mut geturl_backend = DefaultBackend::default();
        let index_url = format!("{}.index.gz", self.url);
        let reader = GzDecoder::new(crate::cache::BudgetReader(
            geturl_backend.get_url(&index_url)?,
        ));
        Ok(Box::new(reader))
    }

    fn open_fileinfo(
        &mut self,
        info: &ItarFileInfo,
        status: &mut dyn StatusBackend,
    ) -> OpenResult<InputHandle> {
        match self.ensure_index() {
            Ok(_) => {}
            Err(e) => return OpenResult::Err(e),
        };

        tt_note!(status, "downloading {}", info.name);

        match read_file_with_retries(self.reader.as_mut().unwrap(), info, status) {
            OpenResult::Ok(v) => OpenResult::Ok(InputHandle::new_read_only(
                info.name.to_owned(),
                Cursor::new(v),
                InputOrigin::Other,
            )),
            OpenResult::NotAvailable => OpenResult::NotAvailable,
            OpenResult::Err(e) => OpenResult::Err(e),
        }
    }

    /// Download many files concurrently.
    ///
    /// Each file is an independent HTTP byte-range request, so on a cold cache
    /// the dominant cost is round-trip latency multiplied by the number of
    /// files. Issuing them one-at-a-time (as the engine does on demand) is
    /// therefore badly latency-bound. Here we fan the requests out across a pool
    /// of worker threads, each with its own range reader (and thus its own
    /// pooled HTTP connection), which collapses N serial round-trips into
    /// roughly N/concurrency.
    fn batch_open(
        &mut self,
        infos: &[ItarFileInfo],
        status: &mut dyn StatusBackend,
    ) -> Vec<OpenResult<Vec<u8>>> {
        batch::open(self, infos, status)
    }

    fn prepare_resources(
        &mut self,
        infos: &[ItarFileInfo],
        status: &mut dyn StatusBackend,
        write_resource: &mut dyn FnMut(&ItarFileInfo, &[u8]) -> Result<()>,
    ) -> Result<usize> {
        use crate::ByteRange;

        const MAX_RANGE_BYTES: u64 = 32 * 1024 * 1024;
        const MAX_CONCURRENT_RANGES: usize = 4;

        struct RangeGroup<'a> {
            range: ByteRange,
            files: Vec<&'a ItarFileInfo>,
        }

        let mut ordered: Vec<&ItarFileInfo> = infos.iter().collect();
        ordered.sort_unstable_by_key(|info| info.offset);

        let mut prepared = 0;
        let mut groups: Vec<RangeGroup<'_>> = Vec::new();
        for info in ordered {
            let length = info.length as u64;
            if length > MAX_RANGE_BYTES {
                bail!(
                    "resource '{}' exceeds the 32 MiB preparation range limit",
                    info.name
                );
            }
            let end = info
                .offset
                .checked_add(length)
                .ok_or_else(|| anyhow!("resource '{}' range overflows", info.name))?;
            if length == 0 {
                write_resource(info, &[])?;
                prepared += 1;
                continue;
            }

            if let Some(group) = groups.last_mut() {
                let start = group.range.offset;
                let group_end = start
                    .checked_add(group.range.length as u64)
                    .ok_or_else(|| anyhow!("preparation range overflows"))?;
                if info.offset < group_end {
                    bail!("bundle index contains overlapping resource ranges");
                }
                if end.saturating_sub(start) <= MAX_RANGE_BYTES {
                    group.range.length = usize::try_from(end - start)
                        .map_err(|_| anyhow!("preparation range does not fit in memory"))?;
                    group.files.push(info);
                    continue;
                }
            }

            groups.push(RangeGroup {
                range: ByteRange {
                    offset: info.offset,
                    length: usize::try_from(length)
                        .map_err(|_| anyhow!("resource range does not fit in memory"))?,
                },
                files: vec![info],
            });
        }

        for wave in groups.chunks(MAX_CONCURRENT_RANGES) {
            let ranges: Vec<ByteRange> = wave.iter().map(|group| group.range).collect();
            let results = batch::open_ranges(&self.url, &ranges, status);
            if results.len() != wave.len() {
                bail!("resource range worker returned an incomplete result set");
            }

            for (group, result) in wave.iter().zip(results) {
                let bytes = match result {
                    OpenResult::Ok(bytes) => bytes,
                    OpenResult::Err(error) => return Err(error),
                    OpenResult::NotAvailable => bail!("resource byte range is unavailable"),
                };
                if bytes.len() != group.range.length {
                    bail!("resource byte range returned an unexpected length");
                }

                let start = group.range.offset;
                let mut slices = Vec::with_capacity(group.files.len());
                for info in &group.files {
                    let slice_start = usize::try_from(info.offset - start)
                        .map_err(|_| anyhow!("resource offset does not fit in memory"))?;
                    let slice_end = slice_start
                        .checked_add(info.length)
                        .ok_or_else(|| anyhow!("resource length overflows"))?;
                    if slice_end > bytes.len() {
                        bail!("resource range does not contain the indexed resource");
                    }
                    slices.push((*info, slice_start, slice_end));
                }

                for (info, slice_start, slice_end) in slices {
                    write_resource(info, &bytes[slice_start..slice_end])?;
                    prepared += 1;
                }
            }
        }

        Ok(prepared)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn prepare_fixture_body(
        body: &'static [u8],
        request_count: usize,
    ) -> (std::result::Result<usize, String>, usize) {
        use std::io::{BufRead, BufReader, Write};

        let _guard = crate::cache::PREPARE_BUDGET_TEST_LOCK.lock().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for _ in 0..request_count {
                let (stream, _) = listener.accept().unwrap();
                let mut request = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                loop {
                    line.clear();
                    request.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                }
                let mut response = stream;
                write!(
                    response,
                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-2/3\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                response.write_all(body).unwrap();
            }
        });

        let mut bundle = ItarBundle::new(format!("http://{address}/bundle.tar")).unwrap();
        bundle
            .index
            .initialize(&mut Cursor::new(b"one.sty 0 3\n"))
            .unwrap();
        let infos = bundle.all_infos();
        let mut writes = 0;
        let result = bundle
            .prepare_resources(&infos, &mut NoopStatusBackend {}, &mut |_, _| {
                writes += 1;
                Ok(())
            })
            .map_err(|error| error.to_string());
        server.join().unwrap();
        (result, writes)
    }

    #[test]
    fn cached_index_still_connects_range_reader() {
        let mut bundle = ItarBundle::new("https://example.invalid/bundle.tar".into()).unwrap();
        bundle
            .index
            .initialize(&mut Cursor::new(b"plain.tex 0 1\n"))
            .unwrap();

        assert!(bundle.reader.is_none());
        bundle.ensure_index().unwrap();
        assert!(bundle.reader.is_some());
    }

    #[test]
    fn preparation_coalesces_adjacent_resources_into_one_exact_range() {
        use std::io::{BufRead, BufReader, Write};

        let _guard = crate::cache::PREPARE_BUDGET_TEST_LOCK.lock().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut request = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            let mut requested_range = None;
            loop {
                line.clear();
                request.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                if let Some((name, value)) = line.split_once(':') {
                    if name.eq_ignore_ascii_case("range") {
                        requested_range = Some(value.trim().to_owned());
                    }
                }
            }
            assert_eq!(requested_range.as_deref(), Some("bytes=0-5"));
            let mut response = stream;
            write!(
                response,
                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-5/6\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabcdef"
            )
            .unwrap();
        });

        let mut bundle = ItarBundle::new(format!("http://{address}/bundle.tar")).unwrap();
        bundle
            .index
            .initialize(&mut Cursor::new(b"one.sty 0 3\ntwo.sty 3 3\n"))
            .unwrap();
        let infos = bundle.all_infos();
        let mut written = BTreeMap::new();
        let count = bundle
            .prepare_resources(&infos, &mut NoopStatusBackend {}, &mut |info, bytes| {
                written.insert(info.name().to_owned(), bytes.to_vec());
                Ok(())
            })
            .unwrap();
        server.join().unwrap();

        assert_eq!(count, 2);
        assert_eq!(written.get("one.sty").unwrap(), b"abc");
        assert_eq!(written.get("two.sty").unwrap(), b"def");
    }

    #[test]
    fn preparation_does_not_publish_short_or_oversized_ranges() {
        let (short_result, short_writes) = prepare_fixture_body(b"ab", 3);
        assert!(short_result.is_err());
        assert_eq!(short_writes, 0);

        let (oversized_result, oversized_writes) = prepare_fixture_body(b"abcd", 1);
        assert!(oversized_result.is_err());
        assert_eq!(oversized_writes, 0);
    }
}
