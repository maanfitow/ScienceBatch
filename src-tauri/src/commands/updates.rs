use std::cmp::Ordering;
use std::time::Duration;

use serde::{Deserialize, Serialize};

const GITHUB_LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/maanfitow/ScienceBatch/releases/latest";
const FALLBACK_RELEASES_URL: &str = "https://github.com/maanfitow/ScienceBatch/releases";
const MAX_UPDATE_RESPONSE_BYTES: usize = 512 * 1024;
const MAX_RELEASE_NOTES_CHARS: usize = 4000;
const REQUEST_TIMEOUT_SECS: u64 = 10;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: String,
    pub latest_tag: String,
    pub update_available: bool,
    pub no_published_releases: bool,
    pub release_name: String,
    pub release_notes: String,
    pub download_url: String,
    pub published_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitHubReleasePayload {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    html_url: Option<String>,
    draft: Option<bool>,
    prerelease: Option<bool>,
    published_at: Option<String>,
}

/// Resolves the update-check endpoint from `SCIENCEBATCH_UPDATE_CHECK_URL` or defaults to GitHub Releases.
pub fn resolve_update_endpoint() -> Result<String, String> {
    match std::env::var("SCIENCEBATCH_UPDATE_CHECK_URL") {
        Ok(value) if !value.trim().is_empty() => validate_update_endpoint(value.trim()),
        _ => Ok(GITHUB_LATEST_RELEASE_URL.to_string()),
    }
}

/// Validates that an update endpoint uses `https://` or loopback `http://127.0.0.1` / `http://localhost`.
pub fn validate_update_endpoint(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_whitespace) {
        return Err("Invalid update endpoint URL.".to_string());
    }

    if let Some(rest) = trimmed.strip_prefix("https://") {
        let host = rest.split(['/', '?', '#']).next().unwrap_or("");
        if host.is_empty() {
            return Err("Update endpoint HTTPS URL is missing a host.".to_string());
        }
        return Ok(trimmed.to_string());
    }

    for prefix in ["http://127.0.0.1", "http://localhost"] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            if rest.is_empty()
                || rest.starts_with(':')
                || rest.starts_with('/')
                || rest.starts_with('?')
            {
                return Ok(trimmed.to_string());
            }
        }
    }

    Err(format!(
        "Unsupported update endpoint protocol or host: {trimmed}"
    ))
}

/// Parses a SemVer string (with optional leading `v`/`V`, prerelease tag, and build metadata).
pub fn parse_semver(tag_or_version: &str) -> Option<(u64, u64, u64, Option<String>)> {
    let trimmed = tag_or_version.trim();
    let stripped = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);

    // Build metadata (+...) does not affect precedence and must be stripped first.
    let without_build = stripped.split('+').next()?.trim();
    if without_build.is_empty() {
        return None;
    }

    let (core, prerelease) = match without_build.split_once('-') {
        Some((core_part, pre_part)) => {
            let pre = pre_part.trim();
            if pre.is_empty() {
                return None;
            }
            (core_part, Some(pre.to_string()))
        }
        None => (without_build, None),
    };

    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next()?.parse::<u64>().ok()?;
    let patch = parts.next()?.parse::<u64>().ok()?;
    if parts.next().is_some() {
        return None;
    }

    Some((major, minor, patch, prerelease))
}

fn compare_prerelease(left: &str, right: &str) -> Ordering {
    let left_parts: Vec<&str> = left.split('.').collect();
    let right_parts: Vec<&str> = right.split('.').collect();

    for (l, r) in left_parts.iter().zip(right_parts.iter()) {
        let ord = match (l.parse::<u64>(), r.parse::<u64>()) {
            (Ok(ln), Ok(rn)) => ln.cmp(&rn),
            // Numeric identifiers always have lower precedence than non-numeric identifiers.
            (Ok(_), Err(_)) => Ordering::Less,
            (Err(_), Ok(_)) => Ordering::Greater,
            (Err(_), Err(_)) => l.cmp(r),
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }

    left_parts.len().cmp(&right_parts.len())
}

/// Returns `true` when `candidate` represents a strictly newer SemVer version than `current`.
pub fn is_newer_version(current: &str, candidate: &str) -> bool {
    let Some((c_maj, c_min, c_pat, c_pre)) = parse_semver(current) else {
        return false;
    };
    let Some((n_maj, n_min, n_pat, n_pre)) = parse_semver(candidate) else {
        return false;
    };

    match (n_maj, n_min, n_pat).cmp(&(c_maj, c_min, c_pat)) {
        Ordering::Greater => true,
        Ordering::Less => false,
        Ordering::Equal => match (c_pre.as_deref(), n_pre.as_deref()) {
            // A stable release (None) is newer than a prerelease (Some) on the same core version.
            (Some(_), None) => true,
            (None, Some(_)) | (None, None) => false,
            (Some(cur_pre), Some(cand_pre)) => {
                compare_prerelease(cand_pre, cur_pre) == Ordering::Greater
            }
        },
    }
}

fn sanitize_release_url(raw: Option<&str>) -> String {
    match raw.map(str::trim) {
        Some(url)
            if url.starts_with("https://")
                && !url.chars().any(|ch| ch.is_whitespace() || ch.is_control()) =>
        {
            url.to_string()
        }
        _ => FALLBACK_RELEASES_URL.to_string(),
    }
}

fn truncate_release_notes(raw: &str, max_chars: usize) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let mut chars = trimmed.chars();
    let collected: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{}\n\n...", collected.trim_end())
    } else {
        trimmed.to_string()
    }
}

fn normalize_version_label(raw: &str) -> String {
    match parse_semver(raw) {
        Some((maj, min, pat, Some(pre))) => format!("{maj}.{min}.{pat}-{pre}"),
        Some((maj, min, pat, None)) => format!("{maj}.{min}.{pat}"),
        None => raw.trim().trim_start_matches(['v', 'V']).to_string(),
    }
}

/// Parses a GitHub Release JSON payload and determines whether a newer stable release is available.
pub fn parse_github_release_payload(
    current_version: &str,
    body: &str,
) -> Result<UpdateCheckResult, String> {
    let payload: GitHubReleasePayload = serde_json::from_str(body)
        .map_err(|err| format!("Failed to parse GitHub release response: {err}"))?;

    let normalized_current = normalize_version_label(current_version);

    let latest_tag = payload.tag_name.trim().to_string();
    if latest_tag.is_empty() {
        return Err("GitHub release response is missing tag_name.".to_string());
    }

    let latest_version = normalize_version_label(&latest_tag);

    let is_draft_or_prerelease =
        payload.draft.unwrap_or(false) || payload.prerelease.unwrap_or(false);
    let update_available =
        !is_draft_or_prerelease && is_newer_version(current_version, &latest_tag);

    let release_name = payload
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&latest_tag)
        .to_string();

    let release_notes =
        truncate_release_notes(payload.body.as_deref().unwrap_or(""), MAX_RELEASE_NOTES_CHARS);
    let download_url = sanitize_release_url(payload.html_url.as_deref());
    let published_at = payload
        .published_at
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);

    Ok(UpdateCheckResult {
        current_version: normalized_current,
        latest_version,
        latest_tag,
        update_available,
        no_published_releases: false,
        release_name,
        release_notes,
        download_url,
        published_at,
    })
}

/// Fetches release metadata from `endpoint` with bounded reads and parses it against `current_version`.
pub async fn check_update_against_url(
    endpoint: &str,
    current_version: &str,
) -> Result<UpdateCheckResult, String> {
    let validated_url = validate_update_endpoint(endpoint)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .user_agent(format!("ScienceBatch/{current_version}"))
        .build()
        .map_err(|err| format!("Failed to initialize update HTTP client: {err}"))?;

    let mut response = client
        .get(&validated_url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|err| format!("Failed to check for updates: {err}"))?;

    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        let normalized = normalize_version_label(current_version);
        return Ok(UpdateCheckResult {
            current_version: normalized.clone(),
            latest_version: normalized,
            latest_tag: String::new(),
            update_available: false,
            no_published_releases: true,
            release_name: String::new(),
            release_notes: String::new(),
            download_url: FALLBACK_RELEASES_URL.to_string(),
            published_at: None,
        });
    }
    if !status.is_success() {
        return Err(format!(
            "Update server returned HTTP {} ({}).",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Error")
        ));
    }

    if let Some(len) = response.content_length() {
        if len > MAX_UPDATE_RESPONSE_BYTES as u64 {
            return Err("Update response exceeded the 512 KiB size limit.".to_string());
        }
    }

    let mut buffer = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("Failed to read update response body: {err}"))?
    {
        if buffer.len() + chunk.len() > MAX_UPDATE_RESPONSE_BYTES {
            return Err("Update response exceeded the 512 KiB size limit.".to_string());
        }
        buffer.extend_from_slice(&chunk);
    }

    let body = String::from_utf8(buffer)
        .map_err(|err| format!("Update response was not valid UTF-8: {err}"))?;

    parse_github_release_payload(current_version, &body)
}

#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateCheckResult, String> {
    let endpoint = resolve_update_endpoint()?;
    check_update_against_url(&endpoint, env!("CARGO_PKG_VERSION")).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn parse_semver_handles_prefixes_prereleases_and_invalid_inputs() {
        assert_eq!(parse_semver("0.1.0"), Some((0, 1, 0, None)));
        assert_eq!(parse_semver("v1.2.3"), Some((1, 2, 3, None)));
        assert_eq!(parse_semver("V2.10.4"), Some((2, 10, 4, None)));
        assert_eq!(
            parse_semver("v0.2.0-beta.1+build.42"),
            Some((0, 2, 0, Some("beta.1".to_string())))
        );
        assert_eq!(parse_semver("0.1"), None);
        assert_eq!(parse_semver("0.1.0-"), None);
        assert_eq!(parse_semver("invalid"), None);
    }

    #[test]
    fn is_newer_version_compares_semver_accurately() {
        assert!(!is_newer_version("0.1.0", "0.1.0"));
        assert!(!is_newer_version("0.1.0", "v0.1.0"));
        assert!(!is_newer_version("0.2.0", "0.1.9"));
        assert!(is_newer_version("0.1.0", "0.1.1"));
        assert!(is_newer_version("0.1.0", "v0.2.0"));
        assert!(is_newer_version("0.9.9", "1.0.0"));
        assert!(is_newer_version("0.2.0-beta.1", "0.2.0"));
        assert!(!is_newer_version("0.2.0", "0.2.0-beta.1"));
        assert!(is_newer_version("0.2.0-alpha.2", "0.2.0-alpha.10"));
    }

    #[test]
    fn validate_update_endpoint_restricts_protocols_and_hosts() {
        assert!(validate_update_endpoint(GITHUB_LATEST_RELEASE_URL).is_ok());
        assert!(validate_update_endpoint("http://127.0.0.1:8080/releases/latest").is_ok());
        assert!(validate_update_endpoint("http://localhost:3000/latest").is_ok());
        assert!(validate_update_endpoint("http://example.com/latest").is_err());
        assert!(validate_update_endpoint("http://127.0.0.1.evil.com/latest").is_err());
        assert!(validate_update_endpoint("javascript:alert(1)").is_err());
        assert!(validate_update_endpoint("file:///etc/passwd").is_err());
    }

    #[test]
    fn parse_github_release_payload_detects_newer_release_and_sanitizes_fields() {
        let json = r#"{
            "tag_name": "v0.2.0",
            "name": "ScienceBatch v0.2.0",
            "body": "Added Windows release parity and update notifications.",
            "html_url": "https://github.com/maanfitow/ScienceBatch/releases/tag/v0.2.0",
            "draft": false,
            "prerelease": false,
            "published_at": "2026-11-26T00:00:00Z"
        }"#;

        let parsed = parse_github_release_payload("0.1.0", json).expect("should parse release");
        assert!(parsed.update_available);
        assert_eq!(parsed.current_version, "0.1.0");
        assert_eq!(parsed.latest_version, "0.2.0");
        assert_eq!(parsed.latest_tag, "v0.2.0");
        assert_eq!(parsed.release_name, "ScienceBatch v0.2.0");
        assert_eq!(
            parsed.download_url,
            "https://github.com/maanfitow/ScienceBatch/releases/tag/v0.2.0"
        );
        assert_eq!(
            parsed.published_at.as_deref(),
            Some("2026-11-26T00:00:00Z")
        );
    }

    #[test]
    fn parse_github_release_payload_ignores_same_tag_draft_prerelease_and_unsafe_urls() {
        let same_tag = r#"{
            "tag_name": "v0.1.0",
            "html_url": "https://github.com/maanfitow/ScienceBatch/releases/tag/v0.1.0"
        }"#;
        let same_res = parse_github_release_payload("0.1.0", same_tag).expect("parse same tag");
        assert!(!same_res.update_available);

        let draft = r#"{
            "tag_name": "v0.3.0",
            "draft": true,
            "html_url": "https://github.com/maanfitow/ScienceBatch/releases/tag/v0.3.0"
        }"#;
        assert!(
            !parse_github_release_payload("0.1.0", draft)
                .expect("parse draft")
                .update_available
        );

        let prerelease = r#"{
            "tag_name": "v0.3.0-rc.1",
            "prerelease": true,
            "html_url": "http://insecure.example.com/download"
        }"#;
        let pre_res = parse_github_release_payload("0.1.0", prerelease).expect("parse prerelease");
        assert!(!pre_res.update_available);
        assert_eq!(pre_res.download_url, FALLBACK_RELEASES_URL);

        let js_url = r#"{
            "tag_name": "v0.3.0",
            "html_url": "javascript:alert(1)"
        }"#;
        let js_res = parse_github_release_payload("0.1.0", js_url).expect("parse js url");
        assert!(js_res.update_available);
        assert_eq!(js_res.download_url, FALLBACK_RELEASES_URL);
    }

    #[test]
    fn parse_github_release_payload_truncates_long_release_notes() {
        let long_notes = "a".repeat(MAX_RELEASE_NOTES_CHARS + 250);
        let payload = serde_json::json!({
            "tag_name": "v0.2.0",
            "body": long_notes,
            "html_url": "https://github.com/maanfitow/ScienceBatch/releases/tag/v0.2.0"
        })
        .to_string();

        let parsed = parse_github_release_payload("0.1.0", &payload).expect("parse truncated");
        assert!(parsed.release_notes.ends_with("\n\n..."));
        assert!(parsed.release_notes.chars().count() <= MAX_RELEASE_NOTES_CHARS + 5);
    }

    #[tokio::test]
    async fn check_update_against_local_http_server_detects_simulated_release() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback listener");
        let addr = listener.local_addr().expect("listener address");

        let body = r#"{
            "tag_name": "v0.2.5",
            "name": "v0.2.5 Release",
            "body": "- Windows installer parity\n- Update notifier",
            "html_url": "https://github.com/maanfitow/ScienceBatch/releases/tag/v0.2.5",
            "draft": false,
            "prerelease": false,
            "published_at": "2026-11-26T02:00:00Z"
        }"#;

        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept HTTP client");
            let mut req_buf = [0u8; 2048];
            let _ = stream.read(&mut req_buf);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write mock response");
            stream.flush().expect("flush mock response");
        });

        let endpoint = format!("http://{addr}/repos/maanfitow/ScienceBatch/releases/latest");
        let result = check_update_against_url(&endpoint, "0.1.0")
            .await
            .expect("check against simulated server");

        handle.join().expect("server thread finished");

        assert!(result.update_available);
        assert_eq!(result.current_version, "0.1.0");
        assert_eq!(result.latest_version, "0.2.5");
        assert_eq!(result.latest_tag, "v0.2.5");
        assert_eq!(result.release_name, "v0.2.5 Release");
        assert_eq!(
            result.download_url,
            "https://github.com/maanfitow/ScienceBatch/releases/tag/v0.2.5"
        );
    }

    #[tokio::test]
    async fn check_update_against_local_http_server_handles_404_as_no_published_releases() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback listener");
        let addr = listener.local_addr().expect("listener address");

        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept HTTP client");
            let mut req_buf = [0u8; 1024];
            let _ = stream.read(&mut req_buf);
            let body = r#"{"message":"Not Found"}"#;
            let response = format!(
                "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write 404 response");
        });

        let endpoint = format!("http://{addr}/latest");
        let res = check_update_against_url(&endpoint, "0.1.0")
            .await
            .expect("HTTP 404 should resolve cleanly as no published releases");

        handle.join().expect("server thread finished");
        assert!(!res.update_available);
        assert!(res.no_published_releases);
        assert_eq!(res.current_version, "0.1.0");
        assert_eq!(res.download_url, FALLBACK_RELEASES_URL);
    }

    #[tokio::test]
    async fn check_update_against_local_http_server_reports_http_error() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback listener");
        let addr = listener.local_addr().expect("listener address");

        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept HTTP client");
            let mut req_buf = [0u8; 1024];
            let _ = stream.read(&mut req_buf);
            let body = r#"{"message":"Internal Server Error"}"#;
            let response = format!(
                "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write 500 response");
        });

        let endpoint = format!("http://{addr}/latest");
        let err = check_update_against_url(&endpoint, "0.1.0")
            .await
            .expect_err("expected HTTP 500 error");

        handle.join().expect("server thread finished");
        assert!(err.contains("HTTP 500"));
    }
}
