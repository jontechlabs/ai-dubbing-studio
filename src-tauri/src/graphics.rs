use crate::domain::io_error;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphicsInfo {
    pub preference: String,
    pub executable: String,
    pub adapters: serde_json::Value,
}

#[cfg(windows)]
fn preference(executable: &str) -> String {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let value: String = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\DirectX\\UserGpuPreferences")
        .and_then(|key| key.get_value(executable))
        .unwrap_or_default();
    if value.split(';').any(|part| part == "GpuPreference=2") {
        "performance"
    } else if value.split(';').any(|part| part == "GpuPreference=1") {
        "economy"
    } else {
        "auto"
    }
    .into()
}
#[cfg(not(windows))]
fn preference(_: &str) -> String {
    "auto".into()
}

pub async fn info() -> Result<GraphicsInfo, String> {
    let executable = std::env::current_exe()
        .map_err(io_error)?
        .to_string_lossy()
        .into_owned();
    #[cfg(windows)]
    let adapters = {
        let result = tokio::time::timeout(std::time::Duration::from_secs(10), crate::media::command(std::path::Path::new("powershell.exe"))
            .args(["-NoProfile", "-NonInteractive", "-Command", "@(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,PNPDeviceID) | ConvertTo-Json -Compress"]).output()).await;
        result
            .ok()
            .and_then(Result::ok)
            .filter(|result| result.status.success())
            .and_then(|result| serde_json::from_slice(&result.stdout).ok())
            .unwrap_or(serde_json::json!([]))
    };
    #[cfg(not(windows))]
    let adapters = serde_json::json!([]);
    Ok(GraphicsInfo {
        preference: preference(&executable),
        executable,
        adapters,
    })
}

pub fn set(choice: &str) -> Result<(), String> {
    if !["auto", "economy", "performance"].contains(&choice) {
        return Err("INVALID_PROJECT".into());
    }
    #[cfg(windows)]
    {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        let executable = std::env::current_exe()
            .map_err(io_error)?
            .to_string_lossy()
            .into_owned();
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey("Software\\Microsoft\\DirectX\\UserGpuPreferences")
            .map_err(io_error)?;
        let old: String = key.get_value(&executable).unwrap_or_default();
        let other: String = old
            .split(';')
            .filter(|part| !part.is_empty() && !part.starts_with("GpuPreference="))
            .map(|part| format!("{part};"))
            .collect();
        let setting = match choice {
            "economy" => "GpuPreference=1;",
            "performance" => "GpuPreference=2;",
            _ => "",
        };
        let value = format!("{other}{setting}");
        if value.is_empty() {
            let _ = key.delete_value(&executable);
        } else {
            key.set_value(&executable, &value).map_err(io_error)?;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    Err("DESKTOP_REQUIRED".into())
}

pub fn open_settings() -> Result<(), String> {
    #[cfg(windows)]
    {
        crate::media::command(std::path::Path::new("explorer.exe"))
            .arg("ms-settings:display-advancedgraphics")
            .kill_on_drop(false)
            .spawn()
            .map_err(io_error)?;
        Ok(())
    }
    #[cfg(not(windows))]
    Err("DESKTOP_REQUIRED".into())
}
