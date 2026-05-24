use serde::{Deserialize, Serialize};
use sysinfo::System;

use crate::inference;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemInfo {
    pub os: String,
    pub cpu: String,
    pub cores: usize,
    pub ram_total_mb: u64,
    pub ram_used_mb: u64,
    pub gpu_name: String,
    pub vram_total_mb: u64,
    pub vram_used_mb: u64,
    pub supports_vulkan: bool,
}

pub fn collect() -> SystemInfo {
    let mut sys = System::new_all();
    sys.refresh_memory();
    sys.refresh_cpu_all();

    let gpu = inference::detect_gpu();
    let cpu = sys.cpus().first().map(|c| c.brand().to_string()).unwrap_or_default();

    SystemInfo {
        os: std::env::consts::OS.to_string(),
        cpu,
        cores: sys.cpus().len(),
        ram_total_mb: sys.total_memory() / 1024 / 1024,
        ram_used_mb: sys.used_memory() / 1024 / 1024,
        gpu_name: gpu.name,
        vram_total_mb: gpu.vram_mb,
        vram_used_mb: 0,
        supports_vulkan: gpu.supports_vulkan,
    }
}
