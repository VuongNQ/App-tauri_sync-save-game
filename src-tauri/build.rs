fn main() {
    // Load .env from the src-tauri directory (or repo root) at compile time.
    // Missing .env is OK — CI can set real env vars directly.
    if let Ok(path) = dotenvy::dotenv() {
        println!("cargo:rerun-if-changed={}", path.display());
    }

    // Forward selected env vars so code can use  env!() / option_env!().
    for key in ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] {
        println!("cargo:rerun-if-env-changed={key}");
        if let Ok(val) = std::env::var(key) {
            println!("cargo:rustc-env={key}={val}");
        }
    }

    tauri_build::build()
}
