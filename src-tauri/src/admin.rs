use tauri::AppHandle;

use crate::{
    firestore,
    gdrive_auth,
    models::{AdminConfig, UserProfile, UserRole},
};

fn require_authenticated(app: &AppHandle) -> Result<String, String> {
    gdrive_auth::get_current_user_id(app).ok_or_else(|| "Not authenticated".to_string())
}

fn require_admin(app: &AppHandle) -> Result<String, String> {
    let user_id = require_authenticated(app)?;
    if firestore::current_user_role(app) != UserRole::Admin {
        return Err("Admin access required".into());
    }
    Ok(user_id)
}

pub fn get_admin_config_cmd(app: &AppHandle) -> Result<AdminConfig, String> {
    let _ = require_admin(app)?;
    firestore::load_admin_config(app)
}

pub fn update_admin_config_cmd(app: &AppHandle, config: AdminConfig) -> Result<AdminConfig, String> {
    let _ = require_admin(app)?;
    firestore::save_admin_config(app, &config)?;
    Ok(config)
}

pub fn list_users_cmd(app: &AppHandle) -> Result<Vec<UserProfile>, String> {
    let _ = require_admin(app)?;
    firestore::load_all_user_profiles(app)
}

pub fn update_user_role_cmd(
    app: &AppHandle,
    user_id: String,
    role: UserRole,
) -> Result<Vec<UserProfile>, String> {
    let _ = require_admin(app)?;
    let mut profile = firestore::load_user_profile(app, &user_id)?
        .ok_or_else(|| format!("User profile '{user_id}' not found"))?;
    profile.role = role;
    firestore::save_user_profile(app, &profile)?;
    firestore::load_all_user_profiles(app)
}
