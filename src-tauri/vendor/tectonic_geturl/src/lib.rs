// Copyright 2020-2021 the Tectonic Project.
// Licensed under the MIT License.

//! A simple, pluggable interface for HTTP GETs and range requests.
//!
//! At the moment, there are three backends that might be available:
//! 1. A "null" backend that is always available, but does nothing and always
//!    fails.
//! 2. A backend based on [reqwest](https://docs.rs/reqwest/).
//! 3. A backend based on [curl](https://docs.rs/curl/).
//!
//! The actual backend availability is determined at build time using [Cargo
//! features][features]. See the crate README for information about the features
//! and how they interact.
//!
//! [features]: https://doc.rust-lang.org/cargo/reference/features.html
//!
//! The default backend is intentionally exposed as a concrete type, so that
//! crates relying on this one need not use a lot of dyns and impl Traits. It is
//! intended that the choice of HTTP backend is a build-time one, not a runtime
//! one.

use cfg_if::cfg_if;
use std::io::Read;
use tectonic_errors::{anyhow::bail, Result};

pub(crate) fn validate_range_response(
    status: u16,
    offset: u64,
    length: usize,
    content_ranges: &[&str],
    content_encodings: &[&str],
    content_lengths: &[&str],
) -> Result<()> {
    if length == 0 {
        bail!("byte-range requests must have a nonzero length");
    }
    let length_u64 = u64::try_from(length).map_err(|_| {
        tectonic_errors::anyhow::anyhow!("byte-range length does not fit in a 64-bit offset")
    })?;
    let end = offset
        .checked_add(length_u64 - 1)
        .ok_or_else(|| tectonic_errors::anyhow::anyhow!("byte-range end overflows"))?;

    if status != 206 {
        bail!("unexpected HTTP response code {status} for byte-range request");
    }
    if content_ranges.len() != 1 {
        bail!("byte-range response must contain exactly one Content-Range header");
    }

    let mut parts = content_ranges[0].split_ascii_whitespace();
    if parts.next() != Some("bytes") {
        bail!("byte-range response has an invalid Content-Range unit");
    }
    let range_and_total = parts.next().ok_or_else(|| {
        tectonic_errors::anyhow::anyhow!("byte-range response has an invalid Content-Range")
    })?;
    if parts.next().is_some() {
        bail!("byte-range response has an invalid Content-Range");
    }
    let (range, total) = range_and_total.split_once('/').ok_or_else(|| {
        tectonic_errors::anyhow::anyhow!("byte-range response has an invalid Content-Range")
    })?;
    let (actual_start, actual_end) = range.split_once('-').ok_or_else(|| {
        tectonic_errors::anyhow::anyhow!("byte-range response has an invalid Content-Range")
    })?;
    let actual_start = parse_ascii_u64(actual_start)?;
    let actual_end = parse_ascii_u64(actual_end)?;
    if actual_start != offset || actual_end != end {
        bail!("byte-range response does not match the requested offsets");
    }
    if total != "*" {
        let total = parse_ascii_u64(total)?;
        if total <= actual_end {
            bail!("byte-range response has an invalid resource length");
        }
    }

    if content_encodings.len() > 1
        || content_encodings
            .first()
            .is_some_and(|encoding| !encoding.eq_ignore_ascii_case("identity"))
    {
        bail!("byte-range response used an unexpected Content-Encoding");
    }
    if content_lengths.len() > 1 {
        bail!("byte-range response contains duplicate Content-Length headers");
    }
    if let Some(content_length) = content_lengths.first() {
        let content_length = parse_ascii_u64(content_length)?;
        if content_length != length_u64 {
            bail!("byte-range response Content-Length does not match the request");
        }
    }

    Ok(())
}

fn parse_ascii_u64(value: &str) -> Result<u64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        bail!("byte-range response contains a non-decimal numeric field");
    }
    Ok(value.parse()?)
}

#[cfg(test)]
mod range_validation_tests {
    use super::validate_range_response;

    #[test]
    fn range_metadata_accepts_only_ascii_decimal_numbers() {
        for (content_range, content_length) in [
            ("bytes +5-7/8", "3"),
            ("bytes ٥-7/8", "3"),
            ("bytes 5-7/+8", "3"),
            ("bytes 5-7/8", "+3"),
            ("bytes 5-7/8", "٣"),
        ] {
            assert!(
                validate_range_response(206, 5, 3, &[content_range], &[], &[content_length],)
                    .is_err()
            );
        }
    }
}

/// A trait for reading byte ranges from an HTTP resource.
pub trait RangeReader {
    /// The readable type returned by the range request.
    type Response: Read;

    /// Read the specified range of bytes from this HTTP resource.
    fn read_range(&mut self, offset: u64, length: usize) -> Result<Self::Response>;
}

/// A trait for simple HTTP operations needed by the Tectonic backends.
pub trait GetUrlBackend: Default {
    /// The readable type returned by URL get requests.
    type Response: Read;

    /// The range-reader type for URLs that will undergo byte-range reads.
    type RangeReader: RangeReader;

    /// Starting with an input URL, follow redirections to get a final URL.
    ///
    /// But we attempt to detect redirects into CDNs/S3/etc and *stop* following
    /// before we get that deep.
    fn resolve_url(&mut self, url: &str) -> Result<String>;

    /// Perform an HTTP GET on a URL, returning a readable result.
    fn get_url(&mut self, url: &str) -> Result<Self::Response>;

    /// Open a range reader that can perform byte-range reads on the specified URL.
    fn open_range_reader(&self, url: &str) -> Self::RangeReader;
}

pub mod null;

#[cfg(feature = "curl")]
pub mod curl;

#[cfg(feature = "reqwest")]
pub mod reqwest;

cfg_if! {
    if #[cfg(feature = "reqwest")] {
        pub use crate::reqwest::ReqwestBackend as DefaultBackend;
    } else if #[cfg(feature = "curl")] {
        pub use crate::curl::CurlBackend as DefaultBackend;
    } else {
        pub use null::NullBackend as DefaultBackend;
    }
}

/// The range-reader type exposed by the default URL-get backend (for convenience).
pub type DefaultRangeReader = <DefaultBackend as GetUrlBackend>::RangeReader;
