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

/// Should the embedding path be pinned to CPU on this host? Covers known-
/// fragile AMD cards AND any GPU we failed to identify (see below).
///
/// Background: on RX 580 / Polaris / early-Vega AMD cards, llama.cpp's
/// Vulkan embed (bge-small, ~130 MB) crashes at model load with
/// `STATUS_ACCESS_VIOLATION` — a confirmed `llama.cpp × AMDVLK` driver bug
/// that no work-around on the Cinderpaw side has fixed (see
/// `docs/agents-memory/project_local_models_gpu.md`). Chat inference on the
/// same GPU is fine — only the embedding path is the problem.
///
/// The heuristic matches the names that have crashed in this dev env plus
/// the broader AMD/ATI families that share the legacy AMDVLK/Mesa RADV
/// drivers. NVIDIA and Intel GPUs are never flagged — the issue is
/// AMD-specific.
///
/// UNIDENTIFIED GPUs ARE FLAGGED. This reverses the earlier reading that it
/// is "conservative" to attempt the GPU and let the user set
/// `FERAL_EMBED_GPU_LAYERS=0` themselves. That is only conservative for
/// someone who already knows the variable exists. The two ways to be wrong
/// are not comparable:
///
///   - Wrong toward CPU: embeddings run on the CPU for a card we could not
///     name. bge-small is ~130 MB; the cost is some latency, it is visible,
///     and one env var undoes it.
///   - Wrong toward GPU: llama.cpp aborts the process at first embed. The
///     whole sidecar dies, memory capture stops, and chat keeps working —
///     so nobody notices. That is not hypothetical: it ran for two days on
///     the dev box (see OPUS_CHECKPOINT_20260824.md) and the only sign was
///     a leaf store that quietly stopped growing.
///
/// A name we cannot read means detection failed, not that the hardware is
/// fine. This only ever runs on a Vulkan build, so CUDA/Metal/CPU builds —
/// where a healthy NVIDIA card would live — are untouched.
pub fn should_force_cpu_embed(info: &GpuInfo) -> bool {
    let n = info.name.to_ascii_lowercase();
    if n.is_empty() || n == "unknown gpu" {
        return true;
    }
    // The exact names confirmed to crash on this dev box.
    let confirmed_crashes = [
        "rx 580", "rx 570", "rx 560", "rx 550", "rx 480", "rx 470", "rx 460",
        "radeon rx 580", "radeon rx 570", "radeon rx 560", "radeon rx 480",
        "polaris", "gfx803",
    ];
    for needle in &confirmed_crashes {
        if n.contains(needle) {
            return true;
        }
    }
    // Broader AMD families that share the legacy driver path. Still
    // conservative — only AMD vendor strings, never NVIDIA/Intel.
    let is_amd_vendor = n.contains("amd") || n.contains("radeon") || n.contains("ati ");
    let is_known_amd_arch = n.contains("vega") || n.contains("polaris") || n.contains("navi")
        || n.contains("rdna") || n.contains("gfx8") || n.contains("gfx9") || n.contains("gfx10");
    is_amd_vendor && is_known_amd_arch
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

#[cfg(test)]
mod tests {
    use super::*;

    fn gpu(name: &str) -> GpuInfo {
        GpuInfo { name: name.into(), vram_mb: 8192, supports_vulkan: true }
    }

    #[test]
    fn confirmed_crashers_are_pinned_to_cpu() {
        for name in [
            "AMD Radeon RX 580",
            "Radeon RX 570 Series",
            "AMD Polaris",
            "gfx803",
            "AMD Radeon Vega 8 Graphics",
        ] {
            assert!(should_force_cpu_embed(&gpu(name)), "{name} should pin to CPU");
        }
    }

    #[test]
    fn healthy_non_amd_gpus_keep_the_gpu_path() {
        for name in [
            "NVIDIA GeForce RTX 4090",
            "NVIDIA RTX A6000",
            "Intel(R) Arc(TM) A770 Graphics",
            "Intel(R) UHD Graphics 770",
        ] {
            assert!(!should_force_cpu_embed(&gpu(name)), "{name} should keep the GPU");
        }
    }

    /// The regression this module exists for. An unreadable GPU name means
    /// detection failed; guessing "GPU is fine" aborts the whole sidecar at
    /// first embed and memory capture stops silently. Guessing "use the CPU"
    /// costs latency and nothing else.
    #[test]
    fn an_unidentified_gpu_is_pinned_to_cpu_not_gambled_on() {
        assert!(should_force_cpu_embed(&gpu("Unknown GPU")));
        assert!(should_force_cpu_embed(&gpu("unknown gpu")));
        assert!(should_force_cpu_embed(&gpu("")));
    }

    #[test]
    fn an_amd_vendor_string_without_a_known_arch_is_not_flagged_by_arch_rule() {
        // "AMD" alone is not an architecture; only the vendor+arch pair or a
        // confirmed name trips the AMD branch. Guards against the substring
        // rule quietly widening to every AMD product ever made.
        assert!(!should_force_cpu_embed(&gpu("AMD Ryzen 7 Graphics")));
    }
}
