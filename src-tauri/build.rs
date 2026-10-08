use std::path::Path;

fn main() {
    let target = std::env::var("TARGET").unwrap_or_default();
    let executable_suffix = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let sidecar =
        Path::new("binaries").join(format!("sciencebatch-cli-{target}{executable_suffix}"));
    println!("cargo:rerun-if-changed={}", sidecar.display());
    if !sidecar.is_file() {
        // Allow clean `cargo check` and ordinary Rust builds before the explicit
        // Tauri packaging hook has produced the companion executable.
        let mut override_config = match std::env::var("TAURI_CONFIG") {
            Ok(value) => match serde_json::from_str::<serde_json::Value>(&value) {
                Ok(config) => config,
                Err(error) => {
                    // Keep malformed caller configuration visible to tauri-build instead
                    // of silently replacing it with a partial override.
                    println!("cargo:warning=Could not parse TAURI_CONFIG: {error}");
                    tauri_build::build();
                    return;
                }
            },
            Err(_) => serde_json::json!({}),
        };
        if override_config
            .get("bundle")
            .and_then(serde_json::Value::as_object)
            .is_none_or(|bundle| !bundle.contains_key("externalBin"))
        {
            if !override_config.is_object() {
                override_config = serde_json::json!({});
            }
            let bundle = override_config
                .as_object_mut()
                .expect("Tauri configuration root must be an object")
                .entry("bundle")
                .or_insert_with(|| serde_json::json!({}));
            if !bundle.is_object() {
                *bundle = serde_json::json!({});
            }
            bundle
                .as_object_mut()
                .expect("Tauri bundle configuration must be an object")
                .insert("externalBin".into(), serde_json::json!([]));
        }
        unsafe {
            std::env::set_var(
                "TAURI_CONFIG",
                serde_json::to_string(&override_config)
                    .expect("serialize Tauri configuration override"),
            );
        }
    }
    tauri_build::build()
}
