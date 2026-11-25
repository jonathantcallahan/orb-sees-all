//! Demian's own connection to Jira Cloud. The Epics area reads sprints and issues through Jira's REST
//! API, and applies the chats' change cards, without a Claude run (see src/jira.ts). The API token is
//! kept in the system's credential store (the macOS Keychain, Windows' Credential Manager), never in
//! the app's database or the page: the page asks for a request and this signs it. Requests only go to
//! an Atlassian Cloud site, and only to its REST API.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::Value;

/// The credential store item the token is kept in, by the Atlassian account's email.
const SERVICE: &str = "Demian Jira API token";

/// The token as last read or saved, by email, so each request doesn't go to the credential store.
static TOKEN: Mutex<Option<(String, String)>> = Mutex::new(None);

#[cfg(target_os = "macos")]
mod store {
    use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

    /// errSecItemNotFound: there's no such item.
    const NOT_FOUND: i32 = -25300;

    pub fn get(account: &str) -> Result<Option<String>, String> {
        match get_generic_password(super::SERVICE, account) {
            Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|e| e.to_string()),
            Err(e) if e.code() == NOT_FOUND => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn set(account: &str, token: &str) -> Result<(), String> {
        set_generic_password(super::SERVICE, account, token.as_bytes()).map_err(|e| e.to_string())
    }

    pub fn delete(account: &str) -> Result<(), String> {
        match delete_generic_password(super::SERVICE, account) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == NOT_FOUND => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(windows)]
mod store {
    fn entry(account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(super::SERVICE, account).map_err(|e| e.to_string())
    }

    pub fn get(account: &str) -> Result<Option<String>, String> {
        match entry(account)?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn set(account: &str, token: &str) -> Result<(), String> {
        entry(account)?.set_password(token).map_err(|e| e.to_string())
    }

    pub fn delete(account: &str) -> Result<(), String> {
        match entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod store {
    pub fn get(_account: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    pub fn set(_account: &str, _token: &str) -> Result<(), String> {
        Err("Keeping a Jira token isn't supported on this system".into())
    }
    pub fn delete(_account: &str) -> Result<(), String> {
        Ok(())
    }
}

/// The credential store's account for an email: as typed, ignoring case and spaces around it.
fn account(email: &str) -> Result<String, String> {
    let email = email.trim().to_ascii_lowercase();
    if email.is_empty() || !email.contains('@') {
        return Err("Enter the email of your Atlassian account".into());
    }
    Ok(email)
}

/// The token for an email, from the cache or the credential store.
fn token(email: &str) -> Result<Option<String>, String> {
    let account = account(email)?;
    let mut cached = TOKEN.lock().map_err(|e| e.to_string())?;
    if let Some((who, token)) = cached.as_ref() {
        if *who == account {
            return Ok(Some(token.clone()));
        }
    }
    let found = store::get(&account)?;
    if let Some(token) = &found {
        *cached = Some((account, token.clone()));
    }
    Ok(found)
}

/// The Jira Cloud site's origin ("https://example.atlassian.net"), or why it isn't one: the token only
/// ever goes to Atlassian.
pub fn site_origin(site: &str) -> Result<String, String> {
    let bad = || "Enter your Jira Cloud address, like https://your-site.atlassian.net".to_string();
    let trimmed = site.trim();
    let with_scheme = if trimmed.contains("://") { trimmed.to_string() } else { format!("https://{trimmed}") };
    let url = reqwest::Url::parse(&with_scheme).map_err(|_| bad())?;
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    let label = host.strip_suffix(".atlassian.net").unwrap_or("");
    if url.scheme() != "https" || url.port().is_some() || !url.username().is_empty() || url.password().is_some() || label.is_empty() || label.contains('.') {
        return Err(bad());
    }
    Ok(format!("https://{host}"))
}

/// Whether a request path is one of Jira's REST APIs, with nothing that could lead elsewhere.
pub fn api_path(path: &str) -> bool {
    (path.starts_with("/rest/api/3/") || path.starts_with("/rest/agile/1.0/"))
        && !path.contains("..")
        && !path.contains("//")
        && !path.contains('#')
        && !path.contains('\\')
        && !path.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// The request's URL on the site, when its path is one of Jira's REST APIs both as written and as the URL
/// resolves it: a percent-encoded ".." ("%2e%2e") is one too, once it's parsed.
pub fn api_url(origin: &str, path: &str) -> Result<reqwest::Url, String> {
    let bad = || format!("Not a Jira REST API path: {path}");
    if !api_path(path) {
        return Err(bad());
    }
    let url = reqwest::Url::parse(&format!("{origin}{path}")).map_err(|_| bad())?;
    if url.origin().ascii_serialization() != origin || !api_path(url.path()) {
        return Err(bad());
    }
    Ok(url)
}

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c);
    }
    // reqwest's TLS here has no crypto provider of its own (the updater brings ring): install it once.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let built = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("Demian")
        .build()
        .map_err(|e| e.to_string())?;
    Ok(CLIENT.get_or_init(|| built))
}

/// A Jira response: its status, its body (JSON, or its text when it isn't), and how long Jira asks to
/// wait before trying again, when it's too busy (429).
#[derive(serde::Serialize)]
pub struct JiraResponse {
    status: u16,
    body: Value,
    retry_after: Option<u64>,
}

// The token commands run off the main thread (`async`): the Keychain can stop to ask the user, and the
// window would freeze while it does.

/// Saves the API token for an Atlassian account, replacing any it had.
#[tauri::command(async)]
pub fn jira_save_token(email: String, token: String) -> Result<(), String> {
    let account = account(&email)?;
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Paste the API token".into());
    }
    store::set(&account, &token)?;
    *TOKEN.lock().map_err(|e| e.to_string())? = Some((account, token));
    Ok(())
}

/// Forgets the API token for an Atlassian account.
#[tauri::command(async)]
pub fn jira_forget_token(email: String) -> Result<(), String> {
    let account = account(&email)?;
    store::delete(&account)?;
    *TOKEN.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

/// Whether there's an API token saved for an Atlassian account.
#[tauri::command(async)]
pub fn jira_has_token(email: String) -> bool {
    matches!(token(&email), Ok(Some(_)))
}

/// One request to the Jira Cloud site's REST API, signed with the saved token.
#[tauri::command]
pub async fn jira_request(site: String, email: String, method: String, path: String, body: Option<Value>) -> Result<JiraResponse, String> {
    let origin = site_origin(&site)?;
    let url = api_url(&origin, &path)?;
    let method = match method.to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        other => return Err(format!("Not a method Demian sends to Jira: {other}")),
    };
    // Read on a blocking thread, as the Keychain can stop to ask.
    let who = email.clone();
    let token = tauri::async_runtime::spawn_blocking(move || token(&who))
        .await
        .map_err(|e| e.to_string())??
        .ok_or("No Jira API token is saved: add one in Settings › Jira")?;
    let mut request = client()?
        .request(method, url)
        .basic_auth(email.trim(), Some(token))
        .header("Accept", "application/json");
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|e| format!("Couldn't reach Jira: {e}"))?;
    let status = response.status().as_u16();
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok());
    let text = response.text().await.map_err(|e| format!("Couldn't read Jira's answer: {e}"))?;
    let body = if text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text).unwrap_or_else(|_| Value::String(text.chars().take(2000).collect()))
    };
    Ok(JiraResponse { status, body, retry_after })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_atlassian_cloud_sites() {
        assert_eq!(site_origin("https://example.atlassian.net").unwrap(), "https://example.atlassian.net");
        assert_eq!(site_origin(" Example.atlassian.net/jira/software ").unwrap(), "https://example.atlassian.net");
        assert!(site_origin("http://example.atlassian.net").is_err());
        assert!(site_origin("https://example.atlassian.net.evil.com").is_err());
        assert!(site_origin("https://evil.com/example.atlassian.net").is_err());
        assert!(site_origin("https://a.b.atlassian.net").is_err());
        assert!(site_origin("https://atlassian.net").is_err());
        assert!(site_origin("https://user@example.atlassian.net").is_err());
        assert!(site_origin("https://example.atlassian.net:8443").is_err());
    }

    #[test]
    fn only_rest_api_paths() {
        assert!(api_path("/rest/api/3/search/jql"));
        assert!(api_path("/rest/agile/1.0/sprint/12/issue"));
        assert!(api_path("/rest/api/3/issue/ABC-1?fields=status,parent"));
        assert!(!api_path("/rest/api/2/search"));
        assert!(!api_path("/rest/api/3/../../wiki"));
        assert!(!api_path("//evil.com/rest/api/3/"));
        assert!(!api_path("/rest/api/3//x"));
        assert!(!api_path("/rest/api/3/issue/A B"));
        assert!(!api_path("https://evil.com/rest/api/3/"));
    }

    #[test]
    fn encoded_dot_segments_dont_lead_out_of_the_api() {
        let origin = "https://example.atlassian.net";
        assert_eq!(
            api_url(origin, "/rest/api/3/user/assignable/search?issueKey=ABC-1&query=Ana%20Lopez").unwrap().as_str(),
            "https://example.atlassian.net/rest/api/3/user/assignable/search?issueKey=ABC-1&query=Ana%20Lopez"
        );
        assert!(api_url(origin, "/rest/api/3/%2e%2e/%2e%2e/%2e%2e/wiki/api/v2/pages").is_err());
        assert!(api_url(origin, "/rest/api/3/%2E%2E/2/search").is_err());
        assert!(api_url(origin, "/rest/agile/1.0/.%2e/.%2e/api/2/search").is_err());
    }
}
