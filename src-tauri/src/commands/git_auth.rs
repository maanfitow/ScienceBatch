use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read as _, Write as _};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

const KEYRING_SERVICE: &str = "com.sciencebatch.editor";
const GITHUB_ENTRY_KEY: &str = "oauth-github";
const GITLAB_ENTRY_KEY: &str = "oauth-gitlab";

const GITHUB_HOST: &str = "github.com";
const GITLAB_HOST: &str = "gitlab.com";
const GITHUB_OAUTH_BASE: &str = "https://github.com";
const GITHUB_API_BASE: &str = "https://api.github.com";
const GITLAB_OAUTH_BASE: &str = "https://gitlab.com";
const GITLAB_API_BASE: &str = "https://gitlab.com";

const OAUTH_HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const PKCE_CALLBACK_TIMEOUT: Duration = Duration::from_secs(180);
const CREDENTIAL_SOCKET_TIMEOUT: Duration = Duration::from_secs(5);
const GITLAB_REFRESH_MARGIN_SECS: u64 = 60;
const USER_AGENT: &str = "ScienceBatch";

/// Internal session persisted exclusively in the OS keyring. Never serialized to disk or sent to the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredOAuthSession {
    provider: String,
    host: String,
    access_token: String,
    refresh_token: Option<String>,
    expires_at: Option<u64>,
    username: Option<String>,
    display_name: Option<String>,
    avatar_url: Option<String>,
    /// Public OAuth client identifier (never a secret), retained so token refresh works when provided dynamically.
    #[serde(default)]
    client_id: Option<String>,
}

/// Public account state returned to the frontend. Contains no tokens or secrets.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitAccountStatus {
    pub provider: String,
    pub signed_in: bool,
    pub username: Option<String>,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub host: String,
    pub expires_at: Option<u64>,
    pub client_id_configured: bool,
}

/// Device code verification metadata returned when starting GitHub Device Flow.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubDeviceFlowStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

/// Result of polling GitHub for device flow authorization completion.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubDevicePollResult {
    /// One of: "pending", "slow_down", "authorized", "expired", "denied".
    pub status: String,
    pub account: Option<GitAccountStatus>,
    pub interval: Option<u64>,
    pub error: Option<String>,
}

/// Remote repository summary returned from GitHub or GitLab APIs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitProviderRepo {
    pub id: u64,
    pub name: String,
    pub full_name: String,
    pub clone_url: String,
    pub html_url: String,
    pub private: bool,
    pub default_branch: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OAuthProvider {
    GitHub,
    GitLab,
}

impl OAuthProvider {
    fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "github" => Ok(Self::GitHub),
            "gitlab" => Ok(Self::GitLab),
            other => Err(format!(
                "git_auth.unsupported_provider: Unsupported Git provider '{other}'. Expected 'github' or 'gitlab'."
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::GitHub => "github",
            Self::GitLab => "gitlab",
        }
    }

    fn display_name(self) -> &'static str {
        match self {
            Self::GitHub => "GitHub",
            Self::GitLab => "GitLab",
        }
    }

    fn host(self) -> &'static str {
        match self {
            Self::GitHub => GITHUB_HOST,
            Self::GitLab => GITLAB_HOST,
        }
    }

    fn entry_key(self) -> &'static str {
        match self {
            Self::GitHub => GITHUB_ENTRY_KEY,
            Self::GitLab => GITLAB_ENTRY_KEY,
        }
    }

    fn git_username(self) -> &'static str {
        match self {
            Self::GitHub => "x-access-token",
            Self::GitLab => "oauth2",
        }
    }

    fn env_var_name(self) -> &'static str {
        match self {
            Self::GitHub => "SCIENCEBATCH_GITHUB_CLIENT_ID",
            Self::GitLab => "SCIENCEBATCH_GITLAB_CLIENT_ID",
        }
    }

    fn compile_time_client_id(self) -> Option<&'static str> {
        match self {
            Self::GitHub => option_env!("SCIENCEBATCH_GITHUB_CLIENT_ID"),
            Self::GitLab => option_env!("SCIENCEBATCH_GITLAB_CLIENT_ID"),
        }
    }
}

#[derive(Debug, Clone)]
struct ProviderEndpoints {
    github_oauth_base: String,
    github_api_base: String,
    gitlab_oauth_base: String,
    gitlab_api_base: String,
}

impl Default for ProviderEndpoints {
    fn default() -> Self {
        Self {
            github_oauth_base: GITHUB_OAUTH_BASE.to_string(),
            github_api_base: GITHUB_API_BASE.to_string(),
            gitlab_oauth_base: GITLAB_OAUTH_BASE.to_string(),
            gitlab_api_base: GITLAB_API_BASE.to_string(),
        }
    }
}

trait SessionStore: Send + Sync {
    fn load<'a>(
        &'a self,
        provider: OAuthProvider,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Option<StoredOAuthSession>, String>> + Send + 'a>,
    >;

    fn save<'a>(
        &'a self,
        provider: OAuthProvider,
        session: StoredOAuthSession,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>>;

    fn delete<'a>(
        &'a self,
        provider: OAuthProvider,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>>;
}

struct KeyringSessionStore;

impl SessionStore for KeyringSessionStore {
    fn load<'a>(
        &'a self,
        provider: OAuthProvider,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Option<StoredOAuthSession>, String>> + Send + 'a>,
    > {
        Box::pin(async move {
            let entry_key = provider.entry_key();
            tokio::task::spawn_blocking(move || load_keyring_session_sync(entry_key))
                .await
                .map_err(|error| format!("git_auth.keyring_failed: Keyring worker task failed: {error}"))?
        })
    }

    fn save<'a>(
        &'a self,
        provider: OAuthProvider,
        session: StoredOAuthSession,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            let entry_key = provider.entry_key();
            tokio::task::spawn_blocking(move || save_keyring_session_sync(entry_key, &session))
                .await
                .map_err(|error| format!("git_auth.keyring_failed: Keyring worker task failed: {error}"))?
        })
    }

    fn delete<'a>(
        &'a self,
        provider: OAuthProvider,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            let entry_key = provider.entry_key();
            tokio::task::spawn_blocking(move || delete_keyring_session_sync(entry_key))
                .await
                .map_err(|error| format!("git_auth.keyring_failed: Keyring worker task failed: {error}"))?
        })
    }
}

fn load_keyring_session_sync(entry_key: &str) -> Result<Option<StoredOAuthSession>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, entry_key)
        .map_err(|error| format!("git_auth.keyring_failed: Failed to open OS keyring entry: {error}"))?;
    match entry.get_password() {
        Ok(raw) => {
            let session: StoredOAuthSession = serde_json::from_str(&raw)
                .map_err(|error| format!("git_auth.keyring_failed: Stored OAuth session in OS keyring is corrupted: {error}"))?;
            Ok(Some(session))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("git_auth.keyring_failed: Failed to read OAuth session from OS keyring: {error}")),
    }
}

fn save_keyring_session_sync(entry_key: &str, session: &StoredOAuthSession) -> Result<(), String> {
    let payload = serde_json::to_string(session)
        .map_err(|error| format!("git_auth.keyring_failed: Failed to serialize OAuth session: {error}"))?;
    let entry = keyring::Entry::new(KEYRING_SERVICE, entry_key)
        .map_err(|error| format!("git_auth.keyring_failed: Failed to open OS keyring entry: {error}"))?;
    entry
        .set_password(&payload)
        .map_err(|error| format!("git_auth.keyring_failed: Failed to store OAuth session in OS keyring: {error}"))
}

fn delete_keyring_session_sync(entry_key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, entry_key)
        .map_err(|error| format!("git_auth.keyring_failed: Failed to open OS keyring entry: {error}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("git_auth.keyring_failed: Failed to delete OAuth session from OS keyring: {error}")),
    }
}

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn non_empty_trimmed(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn resolve_configured_client_id(provider: OAuthProvider) -> Option<String> {
    if let Ok(runtime) = std::env::var(provider.env_var_name()) {
        if let Some(id) = non_empty_trimmed(Some(&runtime)) {
            return Some(id);
        }
    }
    non_empty_trimmed(provider.compile_time_client_id())
}

fn resolve_client_id(
    provider: OAuthProvider,
    explicit_client_id: Option<String>,
) -> Result<String, String> {
    if let Some(configured) = resolve_configured_client_id(provider) {
        return Ok(configured);
    }
    if let Some(explicit) = non_empty_trimmed(explicit_client_id.as_deref()) {
        return Ok(explicit);
    }
    Err(format!(
        "git_auth.missing_client_id: {} OAuth client ID is not configured. Set {} or provide a client ID in ScienceBatch Git Account settings.",
        provider.display_name(),
        provider.env_var_name()
    ))
}

fn account_status_from_session(
    provider: OAuthProvider,
    session: Option<&StoredOAuthSession>,
) -> GitAccountStatus {
    let client_id_configured = resolve_configured_client_id(provider).is_some();
    match session {
        Some(session) => GitAccountStatus {
            provider: provider.as_str().to_string(),
            signed_in: true,
            username: session.username.clone(),
            display_name: session.display_name.clone(),
            avatar_url: session.avatar_url.clone(),
            host: session.host.clone(),
            expires_at: session.expires_at,
            client_id_configured,
        },
        None => GitAccountStatus {
            provider: provider.as_str().to_string(),
            signed_in: false,
            username: None,
            display_name: None,
            avatar_url: None,
            host: provider.host().to_string(),
            expires_at: None,
            client_id_configured,
        },
    }
}

fn build_oauth_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(OAUTH_HTTP_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| format!("git_auth.request_failed: Failed to initialize OAuth HTTP client: {error}"))
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

fn random_base64url(num_bytes: usize) -> Result<String, String> {
    let mut bytes = vec![0u8; num_bytes];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("git_auth.crypto_failed: Failed to generate cryptographically secure random bytes: {error}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn random_hex(num_bytes: usize) -> Result<String, String> {
    let mut bytes = vec![0u8; num_bytes];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("git_auth.crypto_failed: Failed to generate cryptographically secure random bytes: {error}"))?;
    let mut hex = String::with_capacity(num_bytes * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    Ok(hex)
}

fn pkce_code_challenge_s256(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

fn sanitize_single_line(value: &str) -> String {
    value.replace(['\r', '\n', '\0'], "")
}

/// Replaces any known secret strings (and their URL-encoded forms) with `[redacted]`.
pub(crate) fn redact_secrets(text: &str, secrets: &[String]) -> String {
    let mut redacted = text.to_string();
    for secret in secrets {
        if secret.is_empty() {
            continue;
        }
        redacted = redacted.replace(secret, "[redacted]");
        let encoded = urlencoding::encode(secret);
        if !encoded.is_empty() && encoded != *secret {
            redacted = redacted.replace(encoded.as_ref(), "[redacted]");
        }
    }
    redacted
}

#[derive(Deserialize)]
struct GitHubDeviceCodeResponse {
    device_code: Option<String>,
    user_code: Option<String>,
    verification_uri: Option<String>,
    expires_in: Option<u64>,
    interval: Option<u64>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Deserialize)]
struct GitHubAccessTokenResponse {
    access_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
    interval: Option<u64>,
}

#[derive(Deserialize)]
struct GitHubUserResponse {
    login: String,
    name: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct GitLabTokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Deserialize)]
struct GitLabUserResponse {
    username: String,
    name: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct GitHubRepoApiItem {
    id: u64,
    name: String,
    full_name: String,
    clone_url: String,
    html_url: String,
    private: bool,
    default_branch: Option<String>,
    updated_at: Option<String>,
}

#[derive(Deserialize)]
struct GitLabProjectApiItem {
    id: u64,
    name: String,
    path_with_namespace: String,
    http_url_to_repo: String,
    web_url: String,
    visibility: Option<String>,
    default_branch: Option<String>,
    last_activity_at: Option<String>,
}

#[tauri::command]
pub async fn get_git_accounts() -> Result<Vec<GitAccountStatus>, String> {
    get_git_accounts_with(&KeyringSessionStore).await
}

async fn get_git_accounts_with(store: &dyn SessionStore) -> Result<Vec<GitAccountStatus>, String> {
    let mut accounts = Vec::with_capacity(2);
    for provider in [OAuthProvider::GitHub, OAuthProvider::GitLab] {
        let session = store.load(provider).await?;
        accounts.push(account_status_from_session(provider, session.as_ref()));
    }
    Ok(accounts)
}

#[tauri::command]
pub async fn sign_out_git_account(provider: String) -> Result<(), String> {
    let provider = OAuthProvider::parse(&provider)?;
    KeyringSessionStore.delete(provider).await
}

#[tauri::command]
pub async fn start_github_device_flow(
    client_id: Option<String>,
) -> Result<GitHubDeviceFlowStart, String> {
    start_github_device_flow_with(client_id, &ProviderEndpoints::default()).await
}

async fn start_github_device_flow_with(
    client_id: Option<String>,
    endpoints: &ProviderEndpoints,
) -> Result<GitHubDeviceFlowStart, String> {
    let client_id = resolve_client_id(OAuthProvider::GitHub, client_id)?;
    let client = build_oauth_http_client()?;
    let url = format!(
        "{}/login/device/code",
        endpoints.github_oauth_base.trim_end_matches('/')
    );
    let body = format!(
        "client_id={}&scope={}",
        urlencoding::encode(&client_id),
        urlencoding::encode("repo read:user")
    );
    let response = client
        .post(&url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|error| format!("git_auth.request_failed: Failed to reach GitHub OAuth device endpoint: {error}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("git_auth.request_failed: Failed to read GitHub OAuth device response: {error}"))?;
    let parsed: GitHubDeviceCodeResponse = serde_json::from_slice(&bytes).map_err(|error| {
        format!("git_auth.invalid_response: Invalid JSON from GitHub device endpoint (HTTP {status}): {error}")
    })?;
    if !status.is_success() {
        let detail = parsed
            .error_description
            .or(parsed.error)
            .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
        return Err(format!("git_auth.oauth_failed: GitHub device flow failed: {detail}"));
    }
    if let Some(error) = parsed.error {
        let detail = parsed.error_description.unwrap_or(error);
        return Err(format!("git_auth.oauth_failed: GitHub device flow failed: {detail}"));
    }
    Ok(GitHubDeviceFlowStart {
        device_code: parsed
            .device_code
            .ok_or_else(|| "git_auth.invalid_response: GitHub response missing device_code.".to_string())?,
        user_code: parsed
            .user_code
            .ok_or_else(|| "git_auth.invalid_response: GitHub response missing user_code.".to_string())?,
        verification_uri: parsed
            .verification_uri
            .ok_or_else(|| "git_auth.invalid_response: GitHub response missing verification_uri.".to_string())?,
        expires_in: parsed.expires_in.unwrap_or(900),
        interval: parsed.interval.unwrap_or(5),
    })
}

#[tauri::command]
pub async fn poll_github_device_flow(
    device_code: String,
    client_id: Option<String>,
) -> Result<GitHubDevicePollResult, String> {
    poll_github_device_flow_with(
        device_code,
        client_id,
        &ProviderEndpoints::default(),
        &KeyringSessionStore,
    )
    .await
}

async fn poll_github_device_flow_with(
    device_code: String,
    client_id: Option<String>,
    endpoints: &ProviderEndpoints,
    store: &dyn SessionStore,
) -> Result<GitHubDevicePollResult, String> {
    let device_code = device_code.trim();
    if device_code.is_empty() {
        return Err("git_auth.invalid_request: GitHub device_code cannot be empty.".to_string());
    }
    let client_id = resolve_client_id(OAuthProvider::GitHub, client_id)?;
    let client = build_oauth_http_client()?;
    let url = format!(
        "{}/login/oauth/access_token",
        endpoints.github_oauth_base.trim_end_matches('/')
    );
    let body = format!(
        "client_id={}&device_code={}&grant_type={}",
        urlencoding::encode(&client_id),
        urlencoding::encode(device_code),
        urlencoding::encode("urn:ietf:params:oauth:grant-type:device_code")
    );
    let response = client
        .post(&url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|error| format!("git_auth.request_failed: Failed to poll GitHub OAuth token endpoint: {error}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("git_auth.request_failed: Failed to read GitHub token poll response: {error}"))?;
    let parsed: GitHubAccessTokenResponse = serde_json::from_slice(&bytes).map_err(|error| {
        format!("git_auth.invalid_response: Invalid JSON from GitHub token endpoint (HTTP {status}): {error}")
    })?;

    if let Some(error_code) = parsed.error.as_deref() {
        return match error_code {
            "authorization_pending" => Ok(GitHubDevicePollResult {
                status: "pending".to_string(),
                account: None,
                interval: None,
                error: parsed.error_description,
            }),
            "slow_down" => Ok(GitHubDevicePollResult {
                status: "slow_down".to_string(),
                account: None,
                interval: parsed.interval,
                error: parsed.error_description,
            }),
            "expired_token" => Ok(GitHubDevicePollResult {
                status: "expired".to_string(),
                account: None,
                interval: None,
                error: Some(format!(
                    "git_auth.expired: {}",
                    parsed
                        .error_description
                        .unwrap_or_else(|| "Device authorization code expired.".to_string())
                )),
            }),
            "access_denied" => Ok(GitHubDevicePollResult {
                status: "denied".to_string(),
                account: None,
                interval: None,
                error: Some(format!(
                    "git_auth.denied: {}",
                    parsed
                        .error_description
                        .unwrap_or_else(|| "Authorization was denied by the user.".to_string())
                )),
            }),
            other => {
                let detail = parsed.error_description.unwrap_or_else(|| other.to_string());
                Err(format!("git_auth.oauth_failed: GitHub OAuth error ({other}): {detail}"))
            }
        };
    }

    if !status.is_success() {
        return Err(format!(
            "git_auth.http_status: GitHub OAuth token endpoint returned HTTP {}.",
            status.as_u16()
        ));
    }

    let access_token = parsed
        .access_token
        .map(|token| sanitize_single_line(&token))
        .filter(|token| !token.is_empty())
        .ok_or_else(|| "git_auth.invalid_response: GitHub token response did not include an access token.".to_string())?;

    let user = fetch_github_user(&client, &endpoints.github_api_base, &access_token).await?;
    let session = StoredOAuthSession {
        provider: OAuthProvider::GitHub.as_str().to_string(),
        host: OAuthProvider::GitHub.host().to_string(),
        access_token,
        refresh_token: None,
        expires_at: None,
        username: Some(user.login),
        display_name: user.name,
        avatar_url: user.avatar_url,
        client_id: Some(client_id),
    };
    let account = account_status_from_session(OAuthProvider::GitHub, Some(&session));
    store.save(OAuthProvider::GitHub, session).await?;

    Ok(GitHubDevicePollResult {
        status: "authorized".to_string(),
        account: Some(account),
        interval: None,
        error: None,
    })
}

async fn fetch_github_user(
    client: &reqwest::Client,
    api_base: &str,
    access_token: &str,
) -> Result<GitHubUserResponse, String> {
    let url = format!("{}/user", api_base.trim_end_matches('/'));
    let response = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| format!("git_auth.request_failed: Failed to fetch GitHub user profile: {error}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("git_auth.request_failed: Failed to read GitHub user profile response: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "git_auth.http_status: GitHub user profile request failed with HTTP {}.",
            status.as_u16()
        ));
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("git_auth.invalid_response: Failed to parse GitHub user profile: {error}"))
}

#[tauri::command]
pub async fn start_gitlab_pkce_flow(
    client_id: Option<String>,
) -> Result<GitAccountStatus, String> {
    start_gitlab_pkce_flow_with(
        client_id,
        &ProviderEndpoints::default(),
        &KeyringSessionStore,
        |auth_url| {
            open::that_detached(auth_url)
                .map_err(|error| format!("git_auth.browser_open_failed: Failed to open system browser for GitLab sign-in: {error}"))
        },
        PKCE_CALLBACK_TIMEOUT,
    )
    .await
}

async fn start_gitlab_pkce_flow_with<F>(
    client_id: Option<String>,
    endpoints: &ProviderEndpoints,
    store: &dyn SessionStore,
    open_browser: F,
    callback_timeout: Duration,
) -> Result<GitAccountStatus, String>
where
    F: FnOnce(&str) -> Result<(), String>,
{
    let client_id = resolve_client_id(OAuthProvider::GitLab, client_id)?;
    let code_verifier = random_base64url(32)?;
    let code_challenge = pkce_code_challenge_s256(&code_verifier);
    let expected_state = random_base64url(24)?;

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("git_auth.callback_listener_failed: Failed to bind local OAuth callback listener: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("git_auth.callback_listener_failed: Failed to inspect local OAuth callback port: {error}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let authorize_url = format!(
        "{}/oauth/authorize?client_id={}&redirect_uri={}&response_type=code&state={}&code_challenge={}&code_challenge_method=S256&scope={}",
        endpoints.gitlab_oauth_base.trim_end_matches('/'),
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(&expected_state),
        urlencoding::encode(&code_challenge),
        urlencoding::encode("api read_user write_repository")
    );

    open_browser(&authorize_url)?;

    let code = tokio::time::timeout(
        callback_timeout,
        wait_for_pkce_callback(&listener, &expected_state),
    )
    .await
    .map_err(|_| "git_auth.timeout: GitLab sign-in timed out after 180 seconds waiting for browser callback.".to_string())??;

    let client = build_oauth_http_client()?;
    let token_url = format!(
        "{}/oauth/token",
        endpoints.gitlab_oauth_base.trim_end_matches('/')
    );
    let token_body = format!(
        "client_id={}&code={}&code_verifier={}&grant_type=authorization_code&redirect_uri={}",
        urlencoding::encode(&client_id),
        urlencoding::encode(&code),
        urlencoding::encode(&code_verifier),
        urlencoding::encode(&redirect_uri)
    );
    let response = client
        .post(&token_url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(token_body)
        .send()
        .await
        .map_err(|error| format!("git_auth.request_failed: Failed to exchange GitLab authorization code: {error}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("git_auth.request_failed: Failed to read GitLab OAuth token response: {error}"))?;
    let parsed: GitLabTokenResponse = serde_json::from_slice(&bytes).map_err(|error| {
        format!("git_auth.invalid_response: Invalid JSON from GitLab token endpoint (HTTP {status}): {error}")
    })?;
    if !status.is_success() || parsed.error.is_some() {
        let detail = parsed
            .error_description
            .or(parsed.error)
            .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
        return Err(format!("git_auth.oauth_failed: GitLab token exchange failed: {detail}"));
    }

    let access_token = parsed
        .access_token
        .map(|token| sanitize_single_line(&token))
        .filter(|token| !token.is_empty())
        .ok_or_else(|| "git_auth.invalid_response: GitLab token response did not include an access token.".to_string())?;
    let refresh_token = parsed
        .refresh_token
        .map(|token| sanitize_single_line(&token))
        .filter(|token| !token.is_empty());
    let expires_at = parsed
        .expires_in
        .map(|secs| now_unix_secs().saturating_add(secs));

    let user = fetch_gitlab_user(&client, &endpoints.gitlab_api_base, &access_token).await?;
    let session = StoredOAuthSession {
        provider: OAuthProvider::GitLab.as_str().to_string(),
        host: OAuthProvider::GitLab.host().to_string(),
        access_token,
        refresh_token,
        expires_at,
        username: Some(user.username),
        display_name: user.name,
        avatar_url: user.avatar_url,
        client_id: Some(client_id),
    };
    let account = account_status_from_session(OAuthProvider::GitLab, Some(&session));
    store.save(OAuthProvider::GitLab, session).await?;
    Ok(account)
}

async fn wait_for_pkce_callback(
    listener: &TcpListener,
    expected_state: &str,
) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|error| format!("git_auth.callback_listener_failed: Failed to accept local OAuth callback connection: {error}"))?;
        let mut buf = vec![0u8; 8192];
        let read_len = match tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf)).await
        {
            Ok(Ok(n)) if n > 0 => n,
            _ => continue,
        };
        let request = String::from_utf8_lossy(&buf[..read_len]);
        let request_line = request.lines().next().unwrap_or_default();
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or_default();
        let target = parts.next().unwrap_or_default();

        if method != "GET" || (!target.starts_with("/callback?") && target != "/callback") {
            let _ = stream
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await;
            let _ = stream.shutdown().await;
            continue;
        }

        let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
        let params = parse_query_params(query);

        if let Some(err) = params.get("error") {
            let desc = params
                .get("error_description")
                .map(String::as_str)
                .unwrap_or(err.as_str());
            let body = format!(
                "<!doctype html><html><body><p>ScienceBatch sign-in failed: {}</p></body></html>",
                escape_html(desc)
            );
            let _ = send_html_response(&mut stream, "400 Bad Request", &body).await;
            let code_prefix = if err == "access_denied" {
                "git_auth.denied"
            } else {
                "git_auth.oauth_failed"
            };
            return Err(format!("{code_prefix}: GitLab authorization failed: {desc}"));
        }

        let returned_state = params.get("state").map(String::as_str).unwrap_or("");
        if !constant_time_eq(returned_state.as_bytes(), expected_state.as_bytes()) {
            let _ = send_html_response(
                &mut stream,
                "400 Bad Request",
                "<!doctype html><html><body><p>ScienceBatch sign-in failed: invalid OAuth state.</p></body></html>",
            )
            .await;
            return Err("git_auth.invalid_state: GitLab OAuth callback failed state verification.".to_string());
        }

        let Some(code) = params.get("code").filter(|c| !c.is_empty()) else {
            let _ = send_html_response(
                &mut stream,
                "400 Bad Request",
                "<!doctype html><html><body><p>ScienceBatch sign-in failed: missing authorization code.</p></body></html>",
            )
            .await;
            return Err("git_auth.missing_code: GitLab OAuth callback did not include an authorization code.".to_string());
        };

        let _ = send_html_response(
            &mut stream,
            "200 OK",
            "<!doctype html><html><body><p>ScienceBatch sign-in complete. You can close this window.</p></body></html>",
        )
        .await;
        return Ok(code.clone());
    }
}

async fn send_html_response(
    stream: &mut tokio::net::TcpStream,
    status: &str,
    body: &str,
) -> std::io::Result<()> {
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    stream.shutdown().await
}

fn parse_query_params(query: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (raw_key, raw_val) = pair.split_once('=').unwrap_or((pair, ""));
        let key = urlencoding::decode(&raw_key.replace('+', " "))
            .map(|cow| cow.into_owned())
            .unwrap_or_else(|_| raw_key.to_string());
        let val = urlencoding::decode(&raw_val.replace('+', " "))
            .map(|cow| cow.into_owned())
            .unwrap_or_else(|_| raw_val.to_string());
        map.insert(key, val);
    }
    map
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

async fn fetch_gitlab_user(
    client: &reqwest::Client,
    api_base: &str,
    access_token: &str,
) -> Result<GitLabUserResponse, String> {
    let url = format!("{}/api/v4/user", api_base.trim_end_matches('/'));
    let response = client
        .get(&url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| format!("git_auth.request_failed: Failed to fetch GitLab user profile: {error}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("git_auth.request_failed: Failed to read GitLab user profile response: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "git_auth.http_status: GitLab user profile request failed with HTTP {}.",
            status.as_u16()
        ));
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("git_auth.invalid_response: Failed to parse GitLab user profile: {error}"))
}

async fn refresh_gitlab_session_if_needed(
    session: StoredOAuthSession,
    endpoints: &ProviderEndpoints,
    store: &dyn SessionStore,
) -> Result<StoredOAuthSession, String> {
    let now = now_unix_secs();
    let needs_refresh = session
        .expires_at
        .is_some_and(|exp| exp <= now.saturating_add(GITLAB_REFRESH_MARGIN_SECS));
    if !needs_refresh {
        return Ok(session);
    }
    let Some(refresh_token) = session
        .refresh_token
        .as_deref()
        .filter(|token| !token.is_empty())
    else {
        return Ok(session);
    };

    let client_id = resolve_configured_client_id(OAuthProvider::GitLab)
        .or_else(|| non_empty_trimmed(session.client_id.as_deref()));

    let mut body = format!(
        "grant_type=refresh_token&refresh_token={}",
        urlencoding::encode(refresh_token)
    );
    if let Some(id) = client_id.as_deref() {
        body.push_str("&client_id=");
        body.push_str(&urlencoding::encode(id));
    }

    let client = build_oauth_http_client()?;
    let url = format!(
        "{}/oauth/token",
        endpoints.gitlab_oauth_base.trim_end_matches('/')
    );
    let response = client
        .post(&url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|error| format!("git_auth.request_failed: Failed to refresh GitLab OAuth token: {error}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("git_auth.request_failed: Failed to read GitLab token refresh response: {error}"))?;
    let parsed: GitLabTokenResponse = serde_json::from_slice(&bytes).map_err(|error| {
        format!("git_auth.invalid_response: Invalid JSON from GitLab refresh endpoint (HTTP {status}): {error}")
    })?;
    if !status.is_success() || parsed.error.is_some() {
        let detail = parsed
            .error_description
            .or(parsed.error)
            .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
        return Err(format!(
            "git_auth.refresh_failed: GitLab session refresh failed ({detail}). Please sign in again."
        ));
    }

    let new_access_token = parsed
        .access_token
        .map(|token| sanitize_single_line(&token))
        .filter(|token| !token.is_empty())
        .ok_or_else(|| "git_auth.invalid_response: GitLab refresh response did not include an access token.".to_string())?;
    let new_refresh_token = parsed
        .refresh_token
        .map(|token| sanitize_single_line(&token))
        .filter(|token| !token.is_empty())
        .or_else(|| session.refresh_token.clone());
    let new_expires_at = parsed
        .expires_in
        .map(|secs| now_unix_secs().saturating_add(secs))
        .or(session.expires_at);

    let updated = StoredOAuthSession {
        access_token: new_access_token,
        refresh_token: new_refresh_token,
        expires_at: new_expires_at,
        client_id: client_id.or(session.client_id),
        ..session
    };
    store.save(OAuthProvider::GitLab, updated.clone()).await?;
    Ok(updated)
}

async fn load_active_session(
    provider: OAuthProvider,
    endpoints: &ProviderEndpoints,
    store: &dyn SessionStore,
) -> Result<StoredOAuthSession, String> {
    let session = store.load(provider).await?.ok_or_else(|| {
        format!(
            "git_auth.not_signed_in: Not signed in to {}. Sign in first from Git Accounts.",
            provider.display_name()
        )
    })?;
    match provider {
        OAuthProvider::GitHub => Ok(session),
        OAuthProvider::GitLab => refresh_gitlab_session_if_needed(session, endpoints, store).await,
    }
}

#[tauri::command]
pub async fn list_git_provider_repositories(
    provider: String,
) -> Result<Vec<GitProviderRepo>, String> {
    let provider = OAuthProvider::parse(&provider)?;
    list_git_provider_repositories_with(provider, &ProviderEndpoints::default(), &KeyringSessionStore)
        .await
}

async fn list_git_provider_repositories_with(
    provider: OAuthProvider,
    endpoints: &ProviderEndpoints,
    store: &dyn SessionStore,
) -> Result<Vec<GitProviderRepo>, String> {
    let session = load_active_session(provider, endpoints, store).await?;
    let client = build_oauth_http_client()?;

    match provider {
        OAuthProvider::GitHub => {
            let url = format!(
                "{}/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator,organization_member",
                endpoints.github_api_base.trim_end_matches('/')
            );
            let response = client
                .get(&url)
                .header("Accept", "application/vnd.github+json")
                .bearer_auth(&session.access_token)
                .send()
                .await
                .map_err(|error| format!("git_auth.request_failed: Failed to list GitHub repositories: {error}"))?;
            let status = response.status();
            let bytes = response
                .bytes()
                .await
                .map_err(|error| format!("git_auth.request_failed: Failed to read GitHub repositories response: {error}"))?;
            if !status.is_success() {
                return Err(format!(
                    "git_auth.http_status: GitHub repository list failed with HTTP {}.",
                    status.as_u16()
                ));
            }
            let items: Vec<GitHubRepoApiItem> = serde_json::from_slice(&bytes)
                .map_err(|error| format!("git_auth.invalid_response: Failed to parse GitHub repositories response: {error}"))?;
            Ok(items
                .into_iter()
                .map(|repo| GitProviderRepo {
                    id: repo.id,
                    name: repo.name,
                    full_name: repo.full_name,
                    clone_url: repo.clone_url,
                    html_url: repo.html_url,
                    private: repo.private,
                    default_branch: repo.default_branch,
                    updated_at: repo.updated_at,
                })
                .collect())
        }
        OAuthProvider::GitLab => {
            let url = format!(
                "{}/api/v4/projects?membership=true&order_by=last_activity_at&sort=desc&per_page=100",
                endpoints.gitlab_api_base.trim_end_matches('/')
            );
            let response = client
                .get(&url)
                .bearer_auth(&session.access_token)
                .send()
                .await
                .map_err(|error| format!("git_auth.request_failed: Failed to list GitLab projects: {error}"))?;
            let status = response.status();
            let bytes = response
                .bytes()
                .await
                .map_err(|error| format!("git_auth.request_failed: Failed to read GitLab projects response: {error}"))?;
            if !status.is_success() {
                return Err(format!(
                    "git_auth.http_status: GitLab project list failed with HTTP {}.",
                    status.as_u16()
                ));
            }
            let items: Vec<GitLabProjectApiItem> = serde_json::from_slice(&bytes)
                .map_err(|error| format!("git_auth.invalid_response: Failed to parse GitLab projects response: {error}"))?;
            Ok(items
                .into_iter()
                .map(|project| GitProviderRepo {
                    id: project.id,
                    name: project.name,
                    full_name: project.path_with_namespace,
                    clone_url: project.http_url_to_repo,
                    html_url: project.web_url,
                    private: project.visibility.as_deref() != Some("public"),
                    default_branch: project.default_branch,
                    updated_at: project.last_activity_at,
                })
                .collect())
        }
    }
}

#[tauri::command]
pub async fn create_git_provider_repository(
    provider: String,
    name: String,
    private: bool,
    description: Option<String>,
) -> Result<GitProviderRepo, String> {
    let provider = OAuthProvider::parse(&provider)?;
    create_git_provider_repository_with(
        provider,
        name,
        private,
        description,
        &ProviderEndpoints::default(),
        &KeyringSessionStore,
    )
    .await
}

async fn create_git_provider_repository_with(
    provider: OAuthProvider,
    name: String,
    private: bool,
    description: Option<String>,
    endpoints: &ProviderEndpoints,
    store: &dyn SessionStore,
) -> Result<GitProviderRepo, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("git_auth.empty_repo_name: Repository name cannot be empty.".to_string());
    }
    let session = load_active_session(provider, endpoints, store).await?;
    let client = build_oauth_http_client()?;
    let description = non_empty_trimmed(description.as_deref());

    match provider {
        OAuthProvider::GitHub => {
            #[derive(Serialize)]
            struct CreateGitHubRepo<'a> {
                name: &'a str,
                private: bool,
                #[serde(skip_serializing_if = "Option::is_none")]
                description: Option<&'a str>,
            }
            let url = format!(
                "{}/user/repos",
                endpoints.github_api_base.trim_end_matches('/')
            );
            let payload = serde_json::to_string(&CreateGitHubRepo {
                name,
                private,
                description: description.as_deref(),
            })
            .map_err(|error| format!("git_auth.invalid_request: Failed to encode GitHub repository request: {error}"))?;
            let response = client
                .post(&url)
                .header("Accept", "application/vnd.github+json")
                .header("Content-Type", "application/json")
                .bearer_auth(&session.access_token)
                .body(payload)
                .send()
                .await
                .map_err(|error| format!("git_auth.request_failed: Failed to create GitHub repository: {error}"))?;
            let status = response.status();
            let bytes = response
                .bytes()
                .await
                .map_err(|error| format!("git_auth.request_failed: Failed to read GitHub create repository response: {error}"))?;
            if !status.is_success() {
                return Err(format!(
                    "git_auth.http_status: GitHub repository creation failed with HTTP {}.",
                    status.as_u16()
                ));
            }
            let repo: GitHubRepoApiItem = serde_json::from_slice(&bytes)
                .map_err(|error| format!("git_auth.invalid_response: Failed to parse created GitHub repository: {error}"))?;
            Ok(GitProviderRepo {
                id: repo.id,
                name: repo.name,
                full_name: repo.full_name,
                clone_url: repo.clone_url,
                html_url: repo.html_url,
                private: repo.private,
                default_branch: repo.default_branch,
                updated_at: repo.updated_at,
            })
        }
        OAuthProvider::GitLab => {
            #[derive(Serialize)]
            struct CreateGitLabProject<'a> {
                name: &'a str,
                visibility: &'a str,
                #[serde(skip_serializing_if = "Option::is_none")]
                description: Option<&'a str>,
            }
            let url = format!(
                "{}/api/v4/projects",
                endpoints.gitlab_api_base.trim_end_matches('/')
            );
            let payload = serde_json::to_string(&CreateGitLabProject {
                name,
                visibility: if private { "private" } else { "public" },
                description: description.as_deref(),
            })
            .map_err(|error| format!("git_auth.invalid_request: Failed to encode GitLab project request: {error}"))?;
            let response = client
                .post(&url)
                .header("Content-Type", "application/json")
                .bearer_auth(&session.access_token)
                .body(payload)
                .send()
                .await
                .map_err(|error| format!("git_auth.request_failed: Failed to create GitLab project: {error}"))?;
            let status = response.status();
            let bytes = response
                .bytes()
                .await
                .map_err(|error| format!("git_auth.request_failed: Failed to read GitLab create project response: {error}"))?;
            if !status.is_success() {
                return Err(format!(
                    "git_auth.http_status: GitLab project creation failed with HTTP {}.",
                    status.as_u16()
                ));
            }
            let project: GitLabProjectApiItem = serde_json::from_slice(&bytes)
                .map_err(|error| format!("git_auth.invalid_response: Failed to parse created GitLab project: {error}"))?;
            Ok(GitProviderRepo {
                id: project.id,
                name: project.name,
                full_name: project.path_with_namespace,
                clone_url: project.http_url_to_repo,
                html_url: project.web_url,
                private: project.visibility.as_deref() != Some("public"),
                default_branch: project.default_branch,
                updated_at: project.last_activity_at,
            })
        }
    }
}

/// Loopback TCP server guard holding an ephemeral nonce and in-memory Git credential.
pub(crate) struct EphemeralGitCredentialGuard {
    addr: SocketAddr,
    nonce: String,
    shutdown_tx: Option<oneshot::Sender<()>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl EphemeralGitCredentialGuard {
    async fn start(expected_host: String, username: String, token: String) -> Result<Self, String> {
        let nonce = random_hex(32)?;
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|error| format!("git_auth.credential_listener_failed: Failed to bind ephemeral Git credential listener: {error}"))?;
        let addr = listener
            .local_addr()
            .map_err(|error| format!("git_auth.credential_listener_failed: Failed to inspect ephemeral Git credential address: {error}"))?;
        let (shutdown_tx, mut shutdown_rx) = oneshot::channel();
        let server_nonce = nonce.clone();

        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accepted = listener.accept() => {
                        let Ok((mut stream, _)) = accepted else {
                            break;
                        };
                        let expected_nonce = server_nonce.clone();
                        let expected_host = expected_host.clone();
                        let username = username.clone();
                        let token = token.clone();
                        tokio::spawn(async move {
                            let _ = handle_credential_client(
                                &mut stream,
                                &expected_nonce,
                                &expected_host,
                                &username,
                                &token,
                            ).await;
                        });
                    }
                }
            }
        });

        Ok(Self {
            addr,
            nonce,
            shutdown_tx: Some(shutdown_tx),
            task: Some(task),
        })
    }

    pub(crate) fn addr(&self) -> SocketAddr {
        self.addr
    }

    pub(crate) fn nonce(&self) -> &str {
        &self.nonce
    }
}

impl Drop for EphemeralGitCredentialGuard {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

async fn handle_credential_client(
    stream: &mut tokio::net::TcpStream,
    expected_nonce: &str,
    expected_host: &str,
    username: &str,
    token: &str,
) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(512);
    let mut chunk = [0u8; 256];
    let read_result = tokio::time::timeout(CREDENTIAL_SOCKET_TIMEOUT, async {
        loop {
            let n = stream.read(&mut chunk).await?;
            if n == 0 {
                break;
            }
            let remaining = 4096usize.saturating_sub(buf.len());
            if remaining == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n.min(remaining)]);
            if buf.iter().filter(|&&b| b == b'\n').count() >= 2 {
                break;
            }
        }
        Ok::<_, std::io::Error>(())
    })
    .await;

    if !matches!(read_result, Ok(Ok(()))) {
        let _ = stream.shutdown().await;
        return Ok(());
    }

    let request = String::from_utf8_lossy(&buf);
    let mut lines = request.lines();
    let recv_nonce = lines.next().unwrap_or("").trim();
    let recv_host = lines.next().unwrap_or("").trim();

    if constant_time_eq(recv_nonce.as_bytes(), expected_nonce.as_bytes())
        && recv_host.eq_ignore_ascii_case(expected_host)
    {
        let payload = format!(
            "{}\n{}\n",
            sanitize_single_line(username),
            sanitize_single_line(token)
        );
        let _ = tokio::time::timeout(CREDENTIAL_SOCKET_TIMEOUT, async {
            stream.write_all(payload.as_bytes()).await?;
            stream.flush().await
        })
        .await;
    }
    let _ = stream.shutdown().await;
    Ok(())
}

/// Prepared ephemeral credential helper state for a single Git CLI invocation.
pub(crate) struct PreparedGitCredentials {
    guard: EphemeralGitCredentialGuard,
    secrets: Vec<String>,
}

impl PreparedGitCredentials {
    pub(crate) fn addr(&self) -> String {
        self.guard.addr().to_string()
    }

    pub(crate) fn nonce(&self) -> &str {
        self.guard.nonce()
    }

    pub(crate) fn secrets(&self) -> &[String] {
        &self.secrets
    }
}

fn match_https_provider(url: &str) -> Option<OAuthProvider> {
    let trimmed = url.trim();
    let scheme_prefix = trimmed.get(..8)?;
    if !scheme_prefix.eq_ignore_ascii_case("https://") {
        return None;
    }
    let rest = &trimmed[8..];
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let host_port = authority
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(authority);
    let host = host_port
        .split_once(':')
        .map(|(host, _)| host)
        .unwrap_or(host_port)
        .to_ascii_lowercase();
    match host.as_str() {
        GITHUB_HOST => Some(OAuthProvider::GitHub),
        GITLAB_HOST => Some(OAuthProvider::GitLab),
        _ => None,
    }
}

/// Prepares an ephemeral loopback credential guard when any target HTTPS URL matches a signed-in GitHub/GitLab account.
pub(crate) async fn prepare_git_credentials_for_urls(
    urls: &[String],
) -> Option<PreparedGitCredentials> {
    prepare_git_credentials_for_urls_with(urls, &ProviderEndpoints::default(), &KeyringSessionStore)
        .await
}

async fn prepare_git_credentials_for_urls_with(
    urls: &[String],
    endpoints: &ProviderEndpoints,
    store: &dyn SessionStore,
) -> Option<PreparedGitCredentials> {
    let mut checked = [false; 2];
    for url in urls {
        let Some(provider) = match_https_provider(url) else {
            continue;
        };
        let slot = match provider {
            OAuthProvider::GitHub => 0,
            OAuthProvider::GitLab => 1,
        };
        if checked[slot] {
            continue;
        }
        checked[slot] = true;

        let Ok(Some(session)) = store.load(provider).await else {
            continue;
        };
        let active = match provider {
            OAuthProvider::GitHub => session,
            OAuthProvider::GitLab => {
                match refresh_gitlab_session_if_needed(session, endpoints, store).await {
                    Ok(refreshed) => refreshed,
                    Err(_) => continue,
                }
            }
        };
        if active.access_token.is_empty() {
            continue;
        }
        let Ok(guard) = EphemeralGitCredentialGuard::start(
            provider.host().to_string(),
            provider.git_username().to_string(),
            active.access_token.clone(),
        )
        .await
        else {
            continue;
        };
        let mut secrets = vec![active.access_token];
        if let Some(refresh_token) = active.refresh_token.filter(|token| !token.is_empty()) {
            secrets.push(refresh_token);
        }
        return Some(PreparedGitCredentials { guard, secrets });
    }
    None
}

/// Formats `git -c credential.helper=...` value with forward slashes and quoting suitable for Git's `sh -c` invocation.
pub(crate) fn format_git_credential_helper_value(cli_path: &Path) -> String {
    let raw = cli_path.to_string_lossy();
    let stripped = if cfg!(windows) {
        if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{unc}")
        } else if let Some(drive) = raw.strip_prefix(r"\\?\") {
            drive.to_string()
        } else {
            raw.into_owned()
        }
    } else {
        raw.into_owned()
    };
    let forward_slashed = stripped.replace('\\', "/");
    if forward_slashed.contains(|c: char| {
        c.is_whitespace() || matches!(c, '"' | '\'' | '(' | ')' | '&' | '$' | ';')
    }) {
        let escaped = forward_slashed.replace('"', "\\\"");
        format!("!\"{escaped}\" --git-credential")
    } else {
        format!("!{forward_slashed} --git-credential")
    }
}

/// Formats the complete `credential.helper=<helper>` argument passed to `git -c`.
pub(crate) fn format_git_credential_config_entry(cli_path: &Path) -> String {
    format!(
        "credential.helper={}",
        format_git_credential_helper_value(cli_path)
    )
}

fn fetch_credential_from_loopback(
    addr: &str,
    nonce: &str,
    protocol: Option<&str>,
    host: Option<&str>,
) -> Option<(String, String)> {
    if !protocol.is_some_and(|p| p.eq_ignore_ascii_case("https")) {
        return None;
    }
    let host = host.map(str::trim).filter(|h| !h.is_empty())?;
    let mut stream = TcpStream::connect(addr).ok()?;
    let _ = stream.set_read_timeout(Some(CREDENTIAL_SOCKET_TIMEOUT));
    let _ = stream.set_write_timeout(Some(CREDENTIAL_SOCKET_TIMEOUT));
    let request = format!(
        "{}\n{}\n",
        sanitize_single_line(nonce),
        sanitize_single_line(host)
    );
    stream.write_all(request.as_bytes()).ok()?;
    stream.flush().ok()?;
    let _ = stream.shutdown(Shutdown::Write);

    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    let mut lines = response.lines();
    let username = lines.next()?.trim();
    let password = lines.next()?.trim();
    if username.is_empty() || password.is_empty() {
        return None;
    }
    Some((username.to_string(), password.to_string()))
}

/// Entrypoint invoked by `sciencebatch-cli --git-credential <get|store|erase>`.
pub fn run_git_credential_helper() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let action = args.get(1).map(|s| s.as_str()).unwrap_or("");
    if action == "store" || action == "erase" || action != "get" {
        return 0;
    }

    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut protocol: Option<String> = None;
    let mut host: Option<String> = None;
    let mut line = String::new();

    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let trimmed = line.trim_end_matches(['\r', '\n']);
                if trimmed.is_empty() {
                    break;
                }
                if let Some((key, value)) = trimmed.split_once('=') {
                    match key {
                        "protocol" => protocol = Some(value.to_string()),
                        "host" => host = Some(value.to_string()),
                        _ => {}
                    }
                }
            }
        }
    }

    let Ok(addr) = std::env::var("SCIENCEBATCH_GIT_CRED_ADDR") else {
        return 0;
    };
    let Ok(nonce) = std::env::var("SCIENCEBATCH_GIT_CRED_NONCE") else {
        return 0;
    };

    if let Some((username, password)) =
        fetch_credential_from_loopback(&addr, &nonce, protocol.as_deref(), host.as_deref())
    {
        let stdout = std::io::stdout();
        let mut out = stdout.lock();
        let _ = writeln!(out, "username={username}");
        let _ = writeln!(out, "password={password}");
        let _ = out.flush();
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct InMemorySessionStore {
        entries: Mutex<HashMap<&'static str, StoredOAuthSession>>,
    }

    impl InMemorySessionStore {
        fn insert(&self, provider: OAuthProvider, session: StoredOAuthSession) {
            self.entries
                .lock()
                .unwrap()
                .insert(provider.entry_key(), session);
        }
    }

    impl SessionStore for InMemorySessionStore {
        fn load<'a>(
            &'a self,
            provider: OAuthProvider,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<Option<StoredOAuthSession>, String>>
                    + Send
                    + 'a,
            >,
        > {
            let result = self.entries.lock().unwrap().get(provider.entry_key()).cloned();
            Box::pin(async move { Ok(result) })
        }

        fn save<'a>(
            &'a self,
            provider: OAuthProvider,
            session: StoredOAuthSession,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>>
        {
            self.entries
                .lock()
                .unwrap()
                .insert(provider.entry_key(), session);
            Box::pin(async { Ok(()) })
        }

        fn delete<'a>(
            &'a self,
            provider: OAuthProvider,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>>
        {
            self.entries.lock().unwrap().remove(provider.entry_key());
            Box::pin(async { Ok(()) })
        }
    }

    async fn spawn_mock_http_server<F>(handler: F) -> (String, oneshot::Sender<()>)
    where
        F: Fn(String, String, String) -> (&'static str, String) + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, mut rx) = oneshot::channel();
        let handler = Arc::new(handler);

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut rx => break,
                    accepted = listener.accept() => {
                        let Ok((mut stream, _)) = accepted else { break; };
                        let handler = Arc::clone(&handler);
                        tokio::spawn(async move {
                            let mut raw = Vec::new();
                            let mut buf = [0u8; 4096];
                            let mut content_length = 0usize;
                            let mut header_end = None;
                            loop {
                                let Ok(n) = stream.read(&mut buf).await else { return; };
                                if n == 0 { break; }
                                raw.extend_from_slice(&buf[..n]);
                                if header_end.is_none() {
                                    if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                                        let end = pos + 4;
                                        header_end = Some(end);
                                        let headers = String::from_utf8_lossy(&raw[..pos]);
                                        for line in headers.lines() {
                                            if let Some((k, v)) = line.split_once(':') {
                                                if k.trim().eq_ignore_ascii_case("content-length") {
                                                    content_length = v.trim().parse().unwrap_or(0);
                                                }
                                            }
                                        }
                                    }
                                }
                                if let Some(end) = header_end {
                                    if raw.len() >= end + content_length {
                                        break;
                                    }
                                }
                            }
                            let end = header_end.unwrap_or(raw.len());
                            let head = String::from_utf8_lossy(&raw[..end]);
                            let body = String::from_utf8_lossy(&raw[end..end + content_length]).into_owned();
                            let mut first = head.lines().next().unwrap_or("").split_whitespace();
                            let method = first.next().unwrap_or("").to_string();
                            let path = first.next().unwrap_or("").to_string();
                            let (status, resp_body) = handler(method, path, body);
                            let resp = format!(
                                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{resp_body}",
                                resp_body.len()
                            );
                            let _ = stream.write_all(resp.as_bytes()).await;
                            let _ = stream.shutdown().await;
                        });
                    }
                }
            }
        });

        (format!("http://{addr}"), tx)
    }

    #[test]
    fn pkce_s256_matches_rfc7636_digest() {
        let verifier = random_base64url(32).unwrap();
        assert_eq!(verifier.len(), 43);
        assert!(!verifier.contains(['+', '/', '=']));

        // RFC 7636 Appendix B known vector
        let rfc_verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let rfc_challenge = pkce_code_challenge_s256(rfc_verifier);
        assert_eq!(rfc_challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn redact_secrets_scrubs_raw_and_url_encoded_values() {
        let token = "gho_secret+token/123=abc";
        let encoded = urlencoding::encode(token);
        let input = format!("fatal: https://x-access-token:{token}@github.com failed and {encoded}");
        let output = redact_secrets(&input, &["".to_string(), token.to_string()]);
        assert!(!output.contains(token));
        assert!(!output.contains(encoded.as_ref()));
        assert_eq!(
            output,
            "fatal: https://x-access-token:[redacted]@github.com failed and [redacted]"
        );
    }

    #[test]
    fn format_git_credential_helper_handles_spaces_and_backslashes() {
        let with_spaces = Path::new(r"C:\Program Files\ScienceBatch\sciencebatch-cli.exe");
        assert_eq!(
            format_git_credential_helper_value(with_spaces),
            "!\"C:/Program Files/ScienceBatch/sciencebatch-cli.exe\" --git-credential"
        );
        assert_eq!(
            format_git_credential_config_entry(with_spaces),
            "credential.helper=!\"C:/Program Files/ScienceBatch/sciencebatch-cli.exe\" --git-credential"
        );
        let simple = Path::new("/usr/local/bin/sciencebatch-cli");
        assert_eq!(
            format_git_credential_helper_value(simple),
            "!/usr/local/bin/sciencebatch-cli --git-credential"
        );
        assert_eq!(
            format_git_credential_config_entry(simple),
            "credential.helper=!/usr/local/bin/sciencebatch-cli --git-credential"
        );
    }

    #[test]
    fn https_url_matching_ignores_ssh_and_other_hosts() {
        assert_eq!(
            match_https_provider("https://github.com/user/repo.git"),
            Some(OAuthProvider::GitHub)
        );
        assert_eq!(
            match_https_provider("HTTPS://user@GITLAB.COM:443/group/proj.git"),
            Some(OAuthProvider::GitLab)
        );
        assert_eq!(match_https_provider("git@github.com:user/repo.git"), None);
        assert_eq!(match_https_provider("ssh://git@gitlab.com/user/repo.git"), None);
        assert_eq!(match_https_provider("http://github.com/user/repo.git"), None);
        assert_eq!(match_https_provider("https://bitbucket.org/user/repo.git"), None);
        assert_eq!(match_https_provider("file:///tmp/repo.git"), None);
    }

    #[tokio::test]
    async fn github_device_flow_poll_lifecycle_and_repo_ops() {
        let poll_step = Arc::new(Mutex::new(0u8));
        let poll_step_srv = Arc::clone(&poll_step);
        let (base_url, shutdown) = spawn_mock_http_server(move |method, path, body| {
            match (method.as_str(), path.as_str()) {
                ("POST", "/login/device/code") => {
                    assert!(body.contains("client_id=gh-test-client"));
                    (
                        "200 OK",
                        r#"{"device_code":"dev-123","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}"#.to_string(),
                    )
                }
                ("POST", "/login/oauth/access_token") => {
                    let mut step = poll_step_srv.lock().unwrap();
                    let current = *step;
                    *step += 1;
                    match current {
                        0 => ("200 OK", r#"{"error":"authorization_pending"}"#.to_string()),
                        1 => ("200 OK", r#"{"error":"slow_down","interval":10}"#.to_string()),
                        2 => ("200 OK", r#"{"access_token":"gho_mock_token_xyz"}"#.to_string()),
                        3 => ("200 OK", r#"{"error":"expired_token"}"#.to_string()),
                        _ => ("200 OK", r#"{"error":"access_denied"}"#.to_string()),
                    }
                }
                ("GET", "/user") => (
                    "200 OK",
                    r#"{"login":"ada","name":"Ada Lovelace","avatar_url":"https://avatars.example/ada.png"}"#.to_string(),
                ),
                ("GET", p) if p.starts_with("/user/repos") => (
                    "200 OK",
                    r#"[{"id":42,"name":"paper","full_name":"ada/paper","clone_url":"https://github.com/ada/paper.git","html_url":"https://github.com/ada/paper","private":true,"default_branch":"main","updated_at":"2026-01-01T00:00:00Z"}]"#.to_string(),
                ),
                ("POST", "/user/repos") => {
                    assert!(body.contains("\"name\":\"thesis\""));
                    (
                        "201 Created",
                        r#"{"id":43,"name":"thesis","full_name":"ada/thesis","clone_url":"https://github.com/ada/thesis.git","html_url":"https://github.com/ada/thesis","private":true,"default_branch":"main","updated_at":"2026-01-02T00:00:00Z"}"#.to_string(),
                    )
                }
                _ => ("404 Not Found", "{}".to_string()),
            }
        })
        .await;

        let endpoints = ProviderEndpoints {
            github_oauth_base: base_url.clone(),
            github_api_base: base_url,
            ..ProviderEndpoints::default()
        };
        let store = InMemorySessionStore::default();

        let start = start_github_device_flow_with(Some("gh-test-client".into()), &endpoints)
            .await
            .unwrap();
        assert_eq!(start.device_code, "dev-123");
        assert_eq!(start.user_code, "ABCD-1234");

        let pending = poll_github_device_flow_with(
            start.device_code.clone(),
            Some("gh-test-client".into()),
            &endpoints,
            &store,
        )
        .await
        .unwrap();
        assert_eq!(pending.status, "pending");
        assert!(pending.account.is_none());

        let slow = poll_github_device_flow_with(
            start.device_code.clone(),
            Some("gh-test-client".into()),
            &endpoints,
            &store,
        )
        .await
        .unwrap();
        assert_eq!(slow.status, "slow_down");
        assert_eq!(slow.interval, Some(10));

        let authorized = poll_github_device_flow_with(
            start.device_code.clone(),
            Some("gh-test-client".into()),
            &endpoints,
            &store,
        )
        .await
        .unwrap();
        assert_eq!(authorized.status, "authorized");
        let account = authorized.account.unwrap();
        assert!(account.signed_in);
        assert_eq!(account.username.as_deref(), Some("ada"));
        let account_json = serde_json::to_string(&account).unwrap();
        assert!(!account_json.contains("gho_mock_token_xyz"));

        let repos =
            list_git_provider_repositories_with(OAuthProvider::GitHub, &endpoints, &store)
                .await
                .unwrap();
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].full_name, "ada/paper");

        let created = create_git_provider_repository_with(
            OAuthProvider::GitHub,
            "thesis".into(),
            true,
            Some("Draft".into()),
            &endpoints,
            &store,
        )
        .await
        .unwrap();
        assert_eq!(created.name, "thesis");

        let expired = poll_github_device_flow_with(
            start.device_code.clone(),
            Some("gh-test-client".into()),
            &endpoints,
            &store,
        )
        .await
        .unwrap();
        assert_eq!(expired.status, "expired");

        let denied = poll_github_device_flow_with(
            start.device_code,
            Some("gh-test-client".into()),
            &endpoints,
            &store,
        )
        .await
        .unwrap();
        assert_eq!(denied.status, "denied");

        let _ = shutdown.send(());
    }

    #[tokio::test]
    async fn gitlab_pkce_refresh_and_repo_ops() {
        let captured_verifier_challenge = Arc::new(Mutex::new((String::new(), String::new())));
        let captured_srv = Arc::clone(&captured_verifier_challenge);
        let (base_url, shutdown) = spawn_mock_http_server(move |method, path, body| {
            match (method.as_str(), path.as_str()) {
                ("POST", "/oauth/token") => {
                    let params = parse_query_params(&body);
                    if params.get("grant_type").map(String::as_str) == Some("authorization_code") {
                        let verifier = params.get("code_verifier").cloned().unwrap_or_default();
                        captured_srv.lock().unwrap().0 = verifier;
                        (
                            "200 OK",
                            r#"{"access_token":"glpat-initial-123","refresh_token":"glref-123","expires_in":30}"#.to_string(),
                        )
                    } else {
                        assert_eq!(
                            params.get("grant_type").map(String::as_str),
                            Some("refresh_token")
                        );
                        (
                            "200 OK",
                            r#"{"access_token":"glpat-refreshed-456","refresh_token":"glref-456","expires_in":7200}"#.to_string(),
                        )
                    }
                }
                ("GET", "/api/v4/user") => (
                    "200 OK",
                    r#"{"username":"curie","name":"Marie Curie","avatar_url":"https://gitlab.example/curie.png"}"#.to_string(),
                ),
                ("GET", p) if p.starts_with("/api/v4/projects") => (
                    "200 OK",
                    r#"[{"id":99,"name":"radium","path_with_namespace":"curie/radium","http_url_to_repo":"https://gitlab.com/curie/radium.git","web_url":"https://gitlab.com/curie/radium","visibility":"private","default_branch":"main","last_activity_at":"2026-01-03T00:00:00Z"}]"#.to_string(),
                ),
                ("POST", "/api/v4/projects") => (
                    "201 Created",
                    r#"{"id":100,"name":"polonium","path_with_namespace":"curie/polonium","http_url_to_repo":"https://gitlab.com/curie/polonium.git","web_url":"https://gitlab.com/curie/polonium","visibility":"private","default_branch":"main","last_activity_at":"2026-01-04T00:00:00Z"}"#.to_string(),
                ),
                _ => ("404 Not Found", "{}".to_string()),
            }
        })
        .await;

        let endpoints = ProviderEndpoints {
            gitlab_oauth_base: base_url.clone(),
            gitlab_api_base: base_url,
            ..ProviderEndpoints::default()
        };
        let store = InMemorySessionStore::default();
        let captured_client = Arc::clone(&captured_verifier_challenge);

        let account = start_gitlab_pkce_flow_with(
            Some("gl-test-client".into()),
            &endpoints,
            &store,
            move |auth_url| {
                let query = auth_url.split_once('?').unwrap().1;
                let params = parse_query_params(query);
                let redirect_uri = params.get("redirect_uri").unwrap().clone();
                let state = params.get("state").unwrap().clone();
                let challenge = params.get("code_challenge").unwrap().clone();
                assert_eq!(params.get("code_challenge_method").unwrap(), "S256");
                captured_client.lock().unwrap().1 = challenge;
                let callback_url = format!(
                    "{redirect_uri}?code=auth-code-999&state={}",
                    urlencoding::encode(&state)
                );
                tokio::spawn(async move {
                    let client = reqwest::Client::new();
                    let resp = client.get(&callback_url).send().await.unwrap();
                    let body = resp.text().await.unwrap();
                    assert!(body.contains("ScienceBatch sign-in complete. You can close this window."));
                });
                Ok(())
            },
            Duration::from_secs(5),
        )
        .await
        .unwrap();

        assert!(account.signed_in);
        assert_eq!(account.username.as_deref(), Some("curie"));
        let (verifier, challenge) = captured_verifier_challenge.lock().unwrap().clone();
        assert_eq!(pkce_code_challenge_s256(&verifier), challenge);

        // expires_in was 30s (within 60s refresh window), so listing repos triggers automatic refresh.
        let repos =
            list_git_provider_repositories_with(OAuthProvider::GitLab, &endpoints, &store)
                .await
                .unwrap();
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].full_name, "curie/radium");

        let refreshed_session = store.load(OAuthProvider::GitLab).await.unwrap().unwrap();
        assert_eq!(refreshed_session.access_token, "glpat-refreshed-456");

        let created = create_git_provider_repository_with(
            OAuthProvider::GitLab,
            "polonium".into(),
            true,
            None,
            &endpoints,
            &store,
        )
        .await
        .unwrap();
        assert_eq!(created.name, "polonium");

        let _ = shutdown.send(());
    }

    #[tokio::test]
    async fn loopback_git_credential_handshake_valid_vs_invalid() {
        let store = InMemorySessionStore::default();
        store.insert(
            OAuthProvider::GitHub,
            StoredOAuthSession {
                provider: "github".into(),
                host: "github.com".into(),
                access_token: "gho_loopback_secret_123".into(),
                refresh_token: None,
                expires_at: None,
                username: Some("ada".into()),
                display_name: None,
                avatar_url: None,
                client_id: None,
            },
        );

        // Non-matching / SSH URLs produce None (fallback to GCM / SSH).
        assert!(prepare_git_credentials_for_urls_with(
            &["git@github.com:ada/paper.git".into()],
            &ProviderEndpoints::default(),
            &store
        )
        .await
        .is_none());
        assert!(prepare_git_credentials_for_urls_with(
            &["https://bitbucket.org/ada/paper.git".into()],
            &ProviderEndpoints::default(),
            &store
        )
        .await
        .is_none());

        let creds = prepare_git_credentials_for_urls_with(
            &["https://github.com/ada/paper.git".into()],
            &ProviderEndpoints::default(),
            &store,
        )
        .await
        .expect("should prepare loopback credentials for github.com HTTPS");

        let addr = creds.addr();
        let nonce = creds.nonce().to_string();
        assert_eq!(creds.secrets(), &["gho_loopback_secret_123".to_string()]);

        // Valid request
        let addr_clone = addr.clone();
        let nonce_clone = nonce.clone();
        let valid = tokio::task::spawn_blocking(move || {
            fetch_credential_from_loopback(
                &addr_clone,
                &nonce_clone,
                Some("https"),
                Some("github.com"),
            )
        })
        .await
        .unwrap();
        assert_eq!(
            valid,
            Some((
                "x-access-token".to_string(),
                "gho_loopback_secret_123".to_string()
            ))
        );

        // Wrong host
        let addr_clone = addr.clone();
        let nonce_clone = nonce.clone();
        let wrong_host = tokio::task::spawn_blocking(move || {
            fetch_credential_from_loopback(
                &addr_clone,
                &nonce_clone,
                Some("https"),
                Some("evil.example.com"),
            )
        })
        .await
        .unwrap();
        assert_eq!(wrong_host, None);

        // Wrong nonce
        let addr_clone = addr.clone();
        let wrong_nonce = tokio::task::spawn_blocking(move || {
            fetch_credential_from_loopback(
                &addr_clone,
                "0000000000000000",
                Some("https"),
                Some("github.com"),
            )
        })
        .await
        .unwrap();
        assert_eq!(wrong_nonce, None);

        // Non-https protocol rejected before dialing
        let non_https = tokio::task::spawn_blocking(move || {
            fetch_credential_from_loopback(&addr, &nonce, Some("http"), Some("github.com"))
        })
        .await
        .unwrap();
        assert_eq!(non_https, None);

        drop(creds);
    }
}
