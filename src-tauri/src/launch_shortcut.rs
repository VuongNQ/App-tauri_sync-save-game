//! Steam-style "play" shortcuts: `syncsave://launch/<gameId>` or `--launch <gameId>`.
//!
//! Triggering a shortcut opens a small launcher window. The window runs the
//! existing `sync_and_launch_game` command (pull/push under the per-game save
//! gate, then start the game) and only asks the user when sync needs a choice
//! (conflict, offline, account missing). A second app instance forwards its
//! arguments to the running one through `tauri-plugin-single-instance`.
use std::path::PathBuf;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::settings;

pub const URL_SCHEME: &str = "syncsave";
const LAUNCH_FLAG: &str = "--launch";
const LAUNCHER_LABEL: &str = "launcher";

/// Game IDs are generated slugs (`manual-foo-bar`). Anything else in a
/// shortcut is rejected before it reaches a window URL.
fn is_valid_game_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Parse `syncsave://launch/<gameId>` (trailing slash and query ignored).
fn parse_launch_url(raw: &str) -> Option<String> {
    let rest = raw
        .trim()
        .strip_prefix(URL_SCHEME)?
        .strip_prefix("://")?;
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let mut parts = rest.trim_matches('/').splitn(2, '/');
    if !parts.next()?.eq_ignore_ascii_case("launch") {
        return None;
    }
    let id = urlencoding::decode(parts.next()?.trim_end_matches('/')).ok()?;
    is_valid_game_id(&id).then(|| id.into_owned())
}

/// Find a launch request in a process argument list (argv[0] included or not).
pub fn launch_request_from_args<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let args: Vec<String> = args.into_iter().map(|a| a.as_ref().to_string()).collect();
    for (i, arg) in args.iter().enumerate() {
        if let Some(id) = parse_launch_url(arg) {
            return Some(id);
        }
        if let Some(value) = arg.strip_prefix("--launch=") {
            if is_valid_game_id(value) {
                return Some(value.to_string());
            }
        }
        if arg == LAUNCH_FLAG {
            if let Some(value) = args.get(i + 1).filter(|v| is_valid_game_id(v)) {
                return Some(value.clone());
            }
        }
    }
    None
}

pub fn launch_url(game_id: &str) -> String {
    format!("{URL_SCHEME}://launch/{}", urlencoding::encode(game_id))
}

/// Open (or re-target) the launcher window for a game.
pub fn open_launcher(app: &AppHandle, game_id: &str) -> Result<(), String> {
    if !is_valid_game_id(game_id) {
        return Err("Invalid game id in shortcut".into());
    }
    let route = format!("index.html#/launch/{}", urlencoding::encode(game_id));
    if let Some(existing) = app.get_webview_window(LAUNCHER_LABEL) {
        // Only one launch at a time: re-target the existing window.
        let hash = serde_json::to_string(&format!("#/launch/{}", urlencoding::encode(game_id)))
            .map_err(|e| e.to_string())?;
        existing
            .eval(format!("window.location.hash = {hash};"))
            .map_err(|e| e.to_string())?;
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, LAUNCHER_LABEL, WebviewUrl::App(route.into()))
        .title("SyncSaveGame — Launching")
        .inner_size(420.0, 230.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .center()
        .focused(true)
        .build()
        .map_err(|e| format!("Could not open launcher window: {e}"))?;
    Ok(())
}

/// Handle a launch request from argv. Logs instead of failing: a bad shortcut
/// must never prevent the tray app itself from starting.
pub fn handle_args<I, S>(app: &AppHandle, args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let Some(game_id) = launch_request_from_args(args) else {
        return false;
    };
    println!("[shortcut] Launch requested for '{game_id}'");
    if let Err(e) = open_launcher(app, &game_id) {
        eprintln!("[shortcut] {e}");
        return false;
    }
    true
}

/// Show the dashboard, optionally on a specific route (e.g. `/game/<id>`).
pub fn show_main(app: &AppHandle, route: Option<&str>) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window unavailable")?;
    if let Some(route) = route {
        let hash = serde_json::to_string(&format!("#{route}")).map_err(|e| e.to_string())?;
        window
            .eval(format!("window.location.hash = {hash};"))
            .map_err(|e| e.to_string())?;
    }
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    Ok(())
}

/// What the launcher window shows before sync starts. Local state only, so
/// it answers instantly and works offline.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchTarget {
    pub game_id: String,
    pub name: String,
    pub thumbnail: Option<String>,
    pub has_cloud: bool,
    pub can_launch: bool,
}

pub fn launch_target(app: &AppHandle, game_id: &str) -> Result<LaunchTarget, String> {
    let state = settings::load_state(app)?;
    let game = settings::find_game(&state, game_id)?;
    let can_launch = game
        .exe_path
        .as_deref()
        .map(settings::expand_env_vars)
        .is_some_and(|p| std::path::Path::new(&p).is_file());
    Ok(LaunchTarget {
        game_id: game.id.clone(),
        name: game.name.clone(),
        thumbnail: game.thumbnail.clone(),
        has_cloud: game.gdrive_folder_id.is_some(),
        can_launch,
    })
}

fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').trim();
    if trimmed.is_empty() {
        "Game".to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

/// Windows Internet Shortcut (the same `.url` format Steam uses for
/// `steam://rungameid/...`). The game's own exe provides the icon.
fn internet_shortcut_contents(url: &str, icon: Option<&str>) -> String {
    let mut out = format!("[InternetShortcut]\r\nURL={url}\r\n");
    if let Some(icon) = icon {
        out.push_str(&format!("IconFile={icon}\r\nIconIndex=0\r\n"));
    }
    out
}

/// Write `<Game name>.url` to the Desktop and return its path.
pub fn create_desktop_shortcut(app: &AppHandle, game_id: &str) -> Result<String, String> {
    let state = settings::load_state(app)?;
    let game = settings::find_game(&state, game_id)?;
    let desktop: PathBuf = app
        .path()
        .desktop_dir()
        .map_err(|e| format!("Desktop folder not found: {e}"))?;

    let icon = game
        .exe_path
        .as_deref()
        .map(settings::expand_env_vars)
        .filter(|p| std::path::Path::new(p).is_file())
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .map(|p| p.to_string_lossy().into_owned())
        });

    let path = desktop.join(format!("{}.url", sanitize_file_name(&game.name)));
    let contents = internet_shortcut_contents(&launch_url(game_id), icon.as_deref());
    std::fs::write(&path, contents).map_err(|e| format!("Could not write shortcut: {e}"))?;
    println!("[shortcut] Created {}", path.display());
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_deep_links() {
        assert_eq!(parse_launch_url("syncsave://launch/manual-elden-ring"), Some("manual-elden-ring".into()));
        assert_eq!(parse_launch_url("syncsave://launch/manual-elden-ring/"), Some("manual-elden-ring".into()));
        assert_eq!(parse_launch_url("syncsave://launch/a%2Db?x=1"), Some("a-b".into()));
        assert_eq!(parse_launch_url("syncsave://open/a"), None);
        assert_eq!(parse_launch_url("syncsave://launch/"), None);
        assert_eq!(parse_launch_url("syncsave://launch/a%2F..%2Fb"), None);
        assert_eq!(parse_launch_url("syncsave://launch/x';alert(1)"), None);
        assert_eq!(parse_launch_url("other://launch/a"), None);
    }

    #[test]
    fn parses_cli_args() {
        assert_eq!(launch_request_from_args(["app.exe", "--launch", "g1"]), Some("g1".into()));
        assert_eq!(launch_request_from_args(["app.exe", "--launch=g1"]), Some("g1".into()));
        assert_eq!(launch_request_from_args(["app.exe", "syncsave://launch/g1"]), Some("g1".into()));
        assert_eq!(launch_request_from_args(["app.exe", "--launch"]), None);
        assert_eq!(launch_request_from_args(["app.exe"]), None);
    }

    #[test]
    fn url_round_trip_and_shortcut_file() {
        let url = launch_url("manual-hades-2");
        assert_eq!(parse_launch_url(&url), Some("manual-hades-2".into()));
        let body = internet_shortcut_contents(&url, Some("C:\\Games\\h.exe"));
        assert!(body.starts_with("[InternetShortcut]\r\nURL=syncsave://launch/manual-hades-2\r\n"));
        assert!(body.contains("IconFile=C:\\Games\\h.exe"));
    }

    #[test]
    fn sanitizes_names() {
        assert_eq!(sanitize_file_name("Elden Ring: Nightreign"), "Elden Ring  Nightreign");
        assert_eq!(sanitize_file_name("..."), "Game");
        assert_eq!(sanitize_file_name("A/B?"), "A B");
    }
}
