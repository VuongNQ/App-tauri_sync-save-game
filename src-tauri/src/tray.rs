use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager,
};

use crate::sync;

const TRAY_ID: &str = "main-tray";

pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }

    let open_item = MenuItemBuilder::with_id("open", "Open Dashboard").build(app)?;
    let sync_item = MenuItemBuilder::with_id("sync_all", "Sync All Now").build(app)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&open_item)
        .item(&sync_item)
        .item(&separator)
        .item(&quit_item)
        .build()?;

    let icon = app.default_window_icon().cloned()
        .expect("app must have a default window icon configured in tauri.conf.json");

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Save Game Sync")
        .menu(&menu)
        .on_menu_event(|app_handle, event| {
            let id = event.id().as_ref();
            match id {
                "open" => {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
                "sync_all" => {
                    let handle = app_handle.clone();
                    std::thread::spawn(move || {
                        let _ = sync::sync_all_games(&handle);
                    });
                }
                "quit" => {
                    app_handle.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick { .. } = event {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}
