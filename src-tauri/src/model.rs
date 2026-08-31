// 数据模型：设置、实例、任务、版本目录、插件。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// 实例存储根目录
    pub instance_root: PathBuf,
    /// 下载镜像前缀，空 = 直连（例：https://ghproxy.cn/）
    pub mirror_prefix: String,
    /// npm registry，插件安装用
    pub npm_registry: String,
    /// 删除实例前确认
    pub confirm_delete: bool,
    /// 界面主题：dark / light
    pub theme: String,
    /// 减弱动效
    pub reduce_motion: bool,
    /// 已完成首次向导
    pub onboarded: bool,
}

impl Default for Settings {
    fn default() -> Self {
        let root = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("DSH EAC Instances");
        Self {
            instance_root: root,
            mirror_prefix: String::new(),
            npm_registry: "https://registry.npmjs.org".into(),
            confirm_delete: true,
            theme: "dark".into(),
            reduce_motion: false,
            onboarded: false,
        }
    }
}

/// 实例安装状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstanceStatus {
    Installing,
    Ready,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InstanceMeta {
    pub id: String,
    pub name: String,
    /// full / lite
    pub edition: String,
    pub version: String,
    pub tag: String,
    pub dir: PathBuf,
    pub app_dir: PathBuf,
    pub dsh_home: PathBuf,
    pub exe_path: Option<PathBuf>,
    pub status: InstanceStatus,
    pub error_message: Option<String>,
    pub created_at: u64,
    pub last_launched_at: Option<u64>,
    pub launch_count: u64,
    pub last_pid: Option<u32>,
    /// 上次成功启动时的健康 dsh.profile.bundles 快照，
    /// 用于在启动前修复被 EAC 退出流程清空的基础 bundles
    #[serde(default)]
    pub last_good_bundles: Vec<String>,
}

impl Default for InstanceMeta {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            edition: "full".into(),
            version: String::new(),
            tag: String::new(),
            dir: PathBuf::new(),
            app_dir: PathBuf::new(),
            dsh_home: PathBuf::new(),
            exe_path: None,
            status: InstanceStatus::Installing,
            error_message: None,
            created_at: 0,
            last_launched_at: None,
            launch_count: 0,
            last_pid: None,
            last_good_bundles: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[derive(Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub settings: Settings,
    pub instances: Vec<InstanceMeta>,
}



#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    pub id: String,
    /// instance / plugin
    pub kind: String,
    pub label: String,
    /// active / done / error / cancelled
    pub state: String,
    pub received: u64,
    pub total: u64,
    pub speed_bps: u64,
    pub message: String,
    pub instance_id: Option<String>,
    #[serde(default)]
    pub stage: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditionAsset {
    pub name: String,
    pub size: u64,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditionInfo {
    pub edition: String,
    pub label: String,
    pub tag: String,
    pub release_name: String,
    pub published_at: String,
    pub body_excerpt: String,
    pub asset: EditionAsset,
    pub sha_url: Option<String>,
}

/// 插件市场条目（dsh-plugin-market plugins.json 方言）
#[derive(Debug, Clone, Deserialize)]
pub struct MarketRaw {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Vec<MarketDesc>,
    #[serde(rename = "support_versions", default)]
    pub support_versions: String,
    #[serde(default)]
    pub urls: MarketUrls,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MarketDesc {
    pub language: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct MarketUrls {
    #[serde(default)]
    pub homepage: String,
    #[serde(default)]
    pub repository: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPlugin {
    pub id: String,
    pub name: String,
    pub desc_en: String,
    pub desc_zh: String,
    pub support_versions: String,
    pub homepage: String,
    pub repository: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    /// npm 包名
    pub name: String,
    /// cordis id（包名最后一段）
    pub id: String,
    pub version: String,
    pub is_bundle: bool,
    pub disabled: bool,
    pub is_core: bool,
}
