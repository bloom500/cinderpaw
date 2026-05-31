//! Real GPU detection for Windows (WMI/registry) and Linux (sysfs).
//! Falls back gracefully to GpuInfo { name: "Unknown GPU", vram_mb: 0, supports_vulkan: false } on any error.

use crate::inference::GpuInfo;

#[cfg(windows)]
pub fn detect() -> GpuInfo {
    let supports_vulkan = supports_vulkan();
    let (name, vram_mb) = detect_gpu_wmi();

    GpuInfo {
        name,
        vram_mb,
        supports_vulkan,
    }
}

#[cfg(target_os = "linux")]
pub fn detect() -> GpuInfo {
    let supports_vulkan = supports_vulkan();
    let (name, vram_mb) = detect_gpu_linux();

    GpuInfo {
        name,
        vram_mb,
        supports_vulkan,
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn detect() -> GpuInfo {
    GpuInfo {
        name: "Unknown GPU".into(),
        vram_mb: 0,
        supports_vulkan: false,
    }
}

// ── Vulkan runtime probe ─────────────────────────────────────────────

#[cfg(windows)]
fn supports_vulkan() -> bool {
    use std::fs;
    for path in &[
        "C:\\Windows\\System32\\vulkan-1.dll",
        "C:\\Windows\\SysWOW64\\vulkan-1.dll",
    ] {
        if fs::metadata(path).is_ok() {
            return true;
        }
    }
    false
}

#[cfg(target_os = "linux")]
fn supports_vulkan() -> bool {
    use std::fs;
    for path in &[
        "/usr/lib/x86_64-linux-gnu/libvulkan.so.1",
        "/usr/lib/libvulkan.so.1",
        "/usr/lib32/libvulkan.so.1",
    ] {
        if fs::metadata(path).is_ok() {
            return true;
        }
    }
    false
}

#[cfg(not(any(windows, target_os = "linux")))]
fn supports_vulkan() -> bool {
    false
}

// ── Windows WMI + Registry ─────────────────────────────────────────

#[cfg(windows)]
fn detect_gpu_wmi() -> (String, u64) {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    // Suppress console window on Windows — without this flag, each PowerShell
    // spawn briefly flashes a terminal window in the foreground.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // Batch all three queries into a single PowerShell invocation to cut
    // startup overhead from ~3× to 1× (PowerShell startup is ~1–3 s each).
    let combined_output = Command::new("powershell")
        .creation_flags(CREATE_NO_WINDOW)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            r#"
$qw = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0000' -ErrorAction SilentlyContinue).'HardwareInformation.qwMemorySize'
$vc = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Select-Object -First 1
"QW=$qw"
"RAM=$($vc.AdapterRAM)"
"NAME=$($vc.Name)"
"#,
        ])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    let mut vram_bytes: u64 = 0;
    let mut gpu_name_raw = String::new();

    for line in combined_output.lines() {
        let line = line.trim();
        if let Some(val) = line.strip_prefix("QW=") {
            if let Ok(n) = val.trim().parse::<u64>() {
                if n > vram_bytes { vram_bytes = n; }
            }
        } else if let Some(val) = line.strip_prefix("RAM=") {
            if vram_bytes == 0 {
                if let Ok(n) = val.trim().parse::<u64>() {
                    vram_bytes = n;
                }
            }
        } else if let Some(val) = line.strip_prefix("NAME=") {
            gpu_name_raw = val.trim().to_string();
        }
    }

    let gpu_name = if gpu_name_raw.is_empty() {
        "Unknown GPU".into()
    } else {
        gpu_name_raw
    };

    // Skip software renderers
    if gpu_name.contains("microsoft")
        || gpu_name.contains("Basic Render")
        || gpu_name.contains("VMware")
        || gpu_name.is_empty()
    {
        return ("Unknown GPU".into(), 0);
    }

    let vram_mb = vram_bytes / (1024 * 1024);

    (gpu_name, vram_mb)
}

// ── Linux sysfs ─────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn detect_gpu_linux() -> (String, u64) {
    use std::fs;

    let Ok(entries) = fs::read_dir("/sys/class/drm") else {
        return ("Unknown GPU".into(), 0);
    };

    let mut best_vram: u64 = 0;
    let mut best_name: String = "Unknown GPU".into();

    for entry in entries.flatten() {
        let path = entry.path();
        let device_path = path.join("device");
        if !device_path.is_dir() {
            continue;
        }

        let Ok(name_bytes) = fs::read(&device_path.join("name")) else {
            continue;
        };
        let name = String::from_utf8_lossy(&name_bytes).trim().to_string();
        if name.is_empty() || name == "魔族" || name == "llvmpipe" || name == "softpipe" {
            continue;
        }

        let Ok(vendor_bytes) = fs::read(&device_path.join("device/vendor")) else {
            continue;
        };
        let vendor_str = String::from_utf8_lossy(&vendor_bytes).trim().to_string();
        if !vendor_str.starts_with("0x10de") && !vendor_str.starts_with("0x1002")
            && !vendor_str.starts_with("0x8086") && !vendor_str.starts_with("0x15b3")
        {
            continue;
        }

        let vram = fs::read_to_string(&device_path.join("device/mem_info_vram_total"))
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(0);

        if vram > best_vram {
            best_vram = vram;
            best_name = name;
        }
    }

    let vram_mb = if best_vram > 1024 * 1024 * 1024 {
        best_vram / (1024 * 1024)
    } else {
        best_vram
    };

    (best_name, vram_mb)
}
