// Copyright 2017-2020 the Tectonic Project
// Licensed under the MIT License.

//! A URL-get backend based on the `reqwest` crate.

use reqwest::{
    blocking::{Client, Response},
    header::{HeaderMap, ACCEPT_ENCODING, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_RANGE, RANGE},
    redirect::Policy,
    StatusCode, Url,
};
use tectonic_errors::{anyhow::bail, Result};

use crate::{GetUrlBackend, RangeReader};

const MAX_HTTP_REDIRECTS_ALLOWED: usize = 10;

/// URL-get backend implemented using the `reqwest` crate.
#[derive(Debug, Default)]
pub struct ReqwestBackend {}

impl GetUrlBackend for ReqwestBackend {
    type Response = Response;
    type RangeReader = ReqwestRangeReader;

    fn get_url(&mut self, url: &str) -> Result<Response> {
        let res = Client::new().get(url).send()?;
        if !res.status().is_success() {
            bail!(
                "unexpected HTTP response code {} for URL {}",
                res.status(),
                url
            );
        }
        Ok(res)
    }

    fn resolve_url(&mut self, url: &str) -> Result<String> {
        let parsed = Url::parse(url)?;
        let original_filename = parsed
            .path_segments()
            .and_then(|mut s| s.next_back())
            .unwrap_or(".") // if the filename is this, the `contains('.')` will already match
            .to_owned();

        // First, we actually do a HEAD request on the URL for the data file.
        // If it's redirected, we update our URL to follow the redirects. If
        // we didn't do this separately, the index file would have to be the
        // one with the redirect setup, which would be confusing and annoying.
        let redirect_policy = Policy::custom(move |attempt| {
            // In the process of resolving the file URL it might be necessary to
            // stop at a certain level of redirection. This might be required
            // because some hosts might redirect to a version of the URL where
            // it isn't possible to select the index file by appending
            // `.index.gz`. (This mostly happens because CDNs redirect to a file
            // hash.) However, the original default Tectonic URL doesn't contain
            // a `.` in the filename, and an October 2021 change to archive.org
            // added a redirect through a secondary URL with a similar path
            // structure. So we also keep resolving if the new filename seems to
            // match the original filename.
            if attempt.previous().len() >= MAX_HTTP_REDIRECTS_ALLOWED {
                attempt.error("too many redirections")
            } else if let Some(mut segments) = attempt.url().clone().path_segments() {
                let follow = segments
                    .next_back()
                    .map(|file| file.contains('.') || file == original_filename)
                    .unwrap_or(true);
                if follow {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            } else {
                attempt.follow()
            }
        });

        let res = Client::builder()
            .redirect(redirect_policy)
            .build()?
            .head(url)
            .send()?;

        if !(res.status().is_success()
            || res.status() == StatusCode::FOUND
            || res.status() == StatusCode::TEMPORARY_REDIRECT)
        {
            bail!(
                "unexpected HTTP response code {} for URL {}",
                res.status(),
                url
            );
        }

        let final_url: String = res.url().clone().into();
        Ok(final_url)
    }

    fn open_range_reader(&self, url: &str) -> Self::RangeReader {
        ReqwestRangeReader::new(url)
    }
}

/// A simple way to read chunks out of a big seekable byte stream. You could
/// implement this for io::File pretty trivially but that's not currently
/// needed.
#[derive(Debug)]
pub struct ReqwestRangeReader {
    url: String,
    client: Client,
}

impl ReqwestRangeReader {
    fn new(url: &str) -> ReqwestRangeReader {
        ReqwestRangeReader {
            url: url.to_owned(),
            client: Client::new(),
        }
    }
}

impl RangeReader for ReqwestRangeReader {
    type Response = Response;

    fn read_range(&mut self, offset: u64, length: usize) -> Result<Response> {
        if length == 0 {
            bail!("byte-range requests must have a nonzero length");
        }
        let length_u64 = u64::try_from(length).map_err(|_| {
            tectonic_errors::anyhow::anyhow!("byte-range length does not fit in 64 bits")
        })?;
        let end_inclusive = offset
            .checked_add(length_u64 - 1)
            .ok_or_else(|| tectonic_errors::anyhow::anyhow!("byte-range end overflows"))?;
        let header_val = format!("bytes={offset}-{end_inclusive}").parse()?;

        let mut headers = HeaderMap::new();
        headers.insert(RANGE, header_val);
        headers.insert(ACCEPT_ENCODING, "identity".parse()?);

        let res = self.client.get(&self.url).headers(headers).send()?;

        let content_ranges: Vec<&str> = res
            .headers()
            .get_all(CONTENT_RANGE)
            .iter()
            .map(|header| header.to_str())
            .collect::<std::result::Result<_, _>>()?;
        let content_encodings: Vec<&str> = res
            .headers()
            .get_all(CONTENT_ENCODING)
            .iter()
            .map(|header| header.to_str())
            .collect::<std::result::Result<_, _>>()?;
        let content_lengths: Vec<&str> = res
            .headers()
            .get_all(CONTENT_LENGTH)
            .iter()
            .map(|header| header.to_str())
            .collect::<std::result::Result<_, _>>()?;
        crate::validate_range_response(
            res.status().as_u16(),
            offset,
            length,
            &content_ranges,
            &content_encodings,
            &content_lengths,
        )
        .map_err(|error| {
            tectonic_errors::anyhow::anyhow!(
                "invalid byte-range response for URL {}: {error}",
                self.url
            )
        })?;

        Ok(res)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};

    fn read_fixture_response(status: &str, headers: &str, body: &[u8]) -> Result<Vec<u8>> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        let address = listener.local_addr()?;
        let body = body.to_vec();
        let status = status.to_owned();
        let headers = headers.to_owned();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut request = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            let mut range = None;
            let mut accept_encoding = None;
            loop {
                line.clear();
                request.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                if let Some((name, value)) = line.split_once(':') {
                    if name.eq_ignore_ascii_case("range") {
                        range = Some(value.trim().to_owned());
                    } else if name.eq_ignore_ascii_case("accept-encoding") {
                        accept_encoding = Some(value.trim().to_owned());
                    }
                }
            }
            assert_eq!(range.as_deref(), Some("bytes=5-7"));
            assert_eq!(accept_encoding.as_deref(), Some("identity"));

            let mut response = stream;
            write!(
                response,
                "HTTP/1.1 {status}\r\n{headers}Connection: close\r\n\r\n"
            )
            .unwrap();
            response.write_all(&body).unwrap();
        });

        let mut reader = ReqwestRangeReader::new(&format!("http://{address}/bundle.tar"));
        let result = reader
            .read_range(5, 3)
            .map_err(|error| tectonic_errors::anyhow::anyhow!("{error}"))
            .and_then(|mut response| {
                let mut bytes = Vec::new();
                response.read_to_end(&mut bytes)?;
                Ok(bytes)
            });
        server
            .join()
            .map_err(|_| tectonic_errors::anyhow::anyhow!("fixture HTTP server panicked"))?;
        result
    }

    #[test]
    fn range_reader_validates_single_matching_content_range_and_lengths() {
        assert_eq!(
            read_fixture_response(
                "206 Partial Content",
                "Content-Range: bytes 5-7/8\r\nContent-Length: 3\r\n",
                b"abc",
            )
            .unwrap(),
            b"abc"
        );
        assert_eq!(
            read_fixture_response(
                "206 Partial Content",
                "Content-Range: bytes 5-7/*\r\n",
                b"abc",
            )
            .unwrap(),
            b"abc"
        );

        for (status, headers) in [
            ("206 Partial Content", "Content-Length: 3\r\n"),
            (
                "206 Partial Content",
                "Content-Range: bytes 4-6/8\r\nContent-Length: 3\r\n",
            ),
            (
                "206 Partial Content",
                "Content-Range: bytes 5-7/7\r\nContent-Length: 3\r\n",
            ),
            (
                "206 Partial Content",
                "Content-Range: bytes 5-7/8\r\nContent-Range: bytes 5-7/8\r\nContent-Length: 3\r\n",
            ),
            (
                "206 Partial Content",
                "Content-Range: bytes 5-7/8\r\nContent-Length: 2\r\n",
            ),
            (
                "206 Partial Content",
                "Content-Range: bytes 5-7/8\r\nContent-Encoding: gzip\r\nContent-Length: 3\r\n",
            ),
            (
                "200 OK",
                "Content-Range: bytes 5-7/8\r\nContent-Length: 3\r\n",
            ),
        ] {
            assert!(read_fixture_response(status, headers, b"abc").is_err());
        }
    }

    #[test]
    fn range_reader_rejects_zero_length_and_offset_overflow_before_http() {
        let mut reader = ReqwestRangeReader::new("not a URL");
        assert!(reader.read_range(0, 0).is_err());
        assert!(reader.read_range(u64::MAX, 2).is_err());
    }
}
