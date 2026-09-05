// 实例健康检查（doctor）：启动前可跑的体检 + 一键修复。
// 覆盖：主程序/布局文件树完整性、运行时、profile 清单与基础 bundles、
// fs-ext 原生模块（上游便携包缺失，session 持久化入口会加载失败）、上游新版本。

use crate::instance::find_instance;
use crate::model::{DoctorCheck, InstanceMeta};
use crate::plugins;
use crate::store::App;

pub fn doctor_check(state: &App, inst_id: &str) -> Result<Vec<DoctorCheck>, String> {
    let inst = find_instance(state, inst_id)?;
    let mut out = Vec::new();
    let exe = inst
        .exe_path
        .clone()
        .filter(|p| p.exists())
        .or_else(|| crate::util::find_main_exe(&inst.app_dir));
    out.push(DoctorCheck {
        id: "exe".into(),
        title: "主程序".into(),
        level: if exe.is_some() { "ok" } else { "err" }.into(),
        detail: match &exe {
            Some(p) => p.display().to_string(),
            None => "未找到主程序 exe，实例无法启动（可尝试重装）".into(),
        },
        fix: None,
    });
    if exe.is_none() {
        return Ok(out);
    }

    if inst.edition == "full" {
        let dsh_desktop = inst.app_dir.join("dsh-desktop");
        let sidecar_ok = inst.app_dir.join("sidecar").join("server.js").is_file()
            && inst.app_dir.join("sidecar").join("rescue-integration.js").is_file();
        out.push(DoctorCheck {
            id: "sidecar".into(),
            title: "Sidecar 启动链".into(),
            level: if sidecar_ok { "ok" } else { "err" }.into(),
            detail: if sidecar_ok {
                "sidecar/server.js 与 rescue-integration.js 完整".into()
            } else {
                "sidecar 脚本缺失，壳会卡在「正在启动服务」直到超时。建议升级/重装实例。".into()
            },
            fix: None,
        });
        let desktop_ok = dsh_desktop.join("package.json").is_file();
        out.push(DoctorCheck {
            id: "desktop".into(),
            title: "dsh-desktop 程序树".into(),
            level: if desktop_ok { "ok" } else { "err" }.into(),
            detail: if desktop_ok {
                format!(
                    "v{} · {}",
                    std::fs::read_to_string(dsh_desktop.join("package.json"))
                        .ok()
                        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                        .and_then(|v| v["version"].as_str().map(String::from))
                        .unwrap_or_else(|| "?".into()),
                    dsh_desktop.display()
                )
            } else {
                "dsh-desktop/package.json 缺失，程序树不完整".into()
            },
            fix: None,
        });
        let node_ok = dsh_desktop.join("vendor").join("node").join("node.exe").is_file();
        out.push(DoctorCheck {
            id: "runtime".into(),
            title: "内置 Node 运行时".into(),
            level: if node_ok { "ok" } else { "warn" }.into(),
            detail: if node_ok {
                dsh_desktop.join("vendor").join("node").join("node.exe").display().to_string()
            } else {
                "vendor/node/node.exe 缺失：插件安装将退回系统 npm/pnpm，sidecar 可能无法启动".into()
            },
            fix: None,
        });
        // fs-ext 原生模块（session 持久化入口依赖；上游便携包不携带编译产物）
        let fs_ext_js = dsh_desktop.join("node_modules").join("fs-ext").join("fs-ext.js").is_file();
        let fs_ext_bin = dsh_desktop
            .join("node_modules")
            .join("fs-ext")
            .join("build")
            .join("Release")
            .join("fs_ext.node")
            .is_file();
        out.push(DoctorCheck {
            id: "native_fs_ext".into(),
            title: "fs-ext 原生模块".into(),
            level: if !fs_ext_js || fs_ext_bin { "ok" } else { "warn" }.into(),
            detail: if !fs_ext_js {
                "该版本不含 fs-ext 依赖，无需处理".into()
            } else if fs_ext_bin {
                "fs_ext.node 编译产物就位".into()
            } else {
                "上游便携包未携带 fs_ext.node（session-persistence-jsonl 入口会加载失败）。可一键从本机其它 EAC 安装修补。".into()
            },
            fix: if fs_ext_js && !fs_ext_bin { Some("native_fs_ext".into()) } else { None },
        });
    } else {
        let node_ok = inst.app_dir.join("resources").join("node").join("node.exe").is_file();
        let dsh_ok = inst
            .app_dir
            .join("resources")
            .join("app")
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js")
            .is_file();
        out.push(DoctorCheck {
            id: "runtime".into(),
            title: "Lite 运行时".into(),
            level: if node_ok && dsh_ok { "ok" } else { "err" }.into(),
            detail: if node_ok && dsh_ok {
                "resources/node 与 dsh 内核完整".into()
            } else {
                "resources 运行时不完整，建议重装该实例".into()
            },
            fix: None,
        });
    }

    // profile 清单与基础 bundles
    let profile = plugins::profile_dir(&inst);
    let pkg_path = profile.join("package.json");
    if !pkg_path.exists() {
        out.push(DoctorCheck {
            id: "profile".into(),
            title: "Profile 清单".into(),
            level: "warn".into(),
            detail: "profile 尚未初始化（首次启动会自动创建）".into(),
            fix: Some("profile".into()),
        });
    } else {
        let parsed = std::fs::read_to_string(&pkg_path)
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
        match parsed {
            None => out.push(DoctorCheck {
                id: "profile".into(),
                title: "Profile 清单".into(),
                level: "err".into(),
                detail: "package.json 损坏（无法解析），启动必崩。可一键重建模板。".into(),
                fix: Some("profile".into()),
            }),
            Some(m) => {
                let bundles = m["dsh"]["profile"]["bundles"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>())
                    .unwrap_or_default();
                let missing: Vec<&str> = plugins::BASE_BUNDLES
                    .iter()
                    .filter(|b| !bundles.iter().any(|x| x == *b))
                    .copied()
                    .collect();
                let level = if missing.is_empty() { "ok" } else { "err" };
                out.push(DoctorCheck {
                    id: "profile".into(),
                    title: "Profile 基础 bundles".into(),
                    level: level.into(),
                    detail: if missing.is_empty() {
                        format!("{} 项 bundles 就绪", bundles.len())
                    } else {
                        format!("缺失核心 bundles：{}（不修复则 dsh web 启动即崩）", missing.join(", "))
                    },
                    fix: if missing.is_empty() { None } else { Some("profile".into()) },
                });
            }
        }
    }

    // 连败/诊断信息透出
    if inst.fail_streak > 0 {
        out.push(DoctorCheck {
            id: "fail_streak".into(),
            title: "启动失败连击".into(),
            level: if inst.fail_streak >= 3 { "err" } else { "warn" }.into(),
            detail: inst.last_fail_reason.clone().unwrap_or_else(|| {
                format!("最近连续失败 {} 次（成功启动一次后自动清零）", inst.fail_streak)
            }),
            fix: Some("safe_recovery".into()),
        });
    }

    // 上游新版本
    if let Some(tag) = &inst.update_available {
        out.push(DoctorCheck {
            id: "update".into(),
            title: "上游新版本".into(),
            level: "warn".into(),
            detail: format!("当前 {tag_current}，上游已发布 {tag}。升级保留全部数据（DSH_HOME 与插件）。", tag_current = inst.tag),
            fix: None,
        });
    }

    Ok(out)
}

/// 一键修复。check 取值：profile / native_fs_ext / safe_recovery / deps
pub fn doctor_fix(state: &App, inst_id: &str, check: &str) -> Result<String, String> {
    let inst = find_instance(state, inst_id)?;
    match check {
        "profile" => {
            let profile = plugins::profile_dir(&inst);
            plugins::ensure_profile(&profile)?;
            plugins::repair_bundles_before_launch(&inst);
            Ok("已重建 profile 模板并补回基础 bundles".into())
        }
        "native_fs_ext" => fix_native_fs_ext(&inst),
        "safe_recovery" => {
            let n = plugins::quarantine_all_third_party(state, inst_id, "manual-recovery")?;
            plugins::repair_bundles_before_launch(&inst);
            Ok(format!("已隔离 {n} 个第三方插件并修复 bundles（可在隔离区恢复）"))
        }
        "deps" => {
            plugins::reinstall_deps_sync(state, &inst, |_| {})?;
            Ok("已按清单重装依赖".into())
        }
        other => Err(format!("未知修复项: {other}")),
    }
}

/// 从本机其它 EAC 安装（注册实例 / 常见目录）寻找 fs_ext.node 并复制补齐。
/// 二进制为 NAPI ABI，同 node 大版本下通用；复制前校验目标 fs-ext JS 包存在。
fn fix_native_fs_ext(inst: &InstanceMeta) -> Result<String, String> {
    if inst.edition != "full" {
        return Err("仅完整版需要 fs-ext 修补".into());
    }
    let dest = inst
        .app_dir
        .join("dsh-desktop")
        .join("node_modules")
        .join("fs-ext")
        .join("build")
        .join("Release")
        .join("fs_ext.node");
    if dest.exists() {
        return Ok("fs_ext.node 已存在，无需修复".into());
    }
    let mut sources: Vec<std::path::PathBuf> = Vec::new();
    // 1) 用户本地 dsh max / DeepSeek Harness 目录（限制深度避免大范围扫描）
    for base in ["D:\\DeepSeek Harness", "C:\\DeepSeek Harness", "D:\\dsh"] {
        collect_fs_ext_nodes(std::path::Path::new(base), 0, 8, &mut sources);
        if !sources.is_empty() {
            break;
        }
    }
    let src = sources.first().ok_or_else(|| {
        "本机未找到可用的 fs_ext.node 编译产物。可从源码构建（build-native.js）后重试。".to_string()
    })?;
    std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| format!("创建目录失败: {e}"))?;
    std::fs::copy(src, &dest).map_err(|e| format!("复制失败: {e}"))?;
    Ok(format!("已从 {} 复制 fs_ext.node", src.display()))
}

fn collect_fs_ext_nodes(dir: &std::path::Path, depth: usize, max: usize, out: &mut Vec<std::path::PathBuf>) {
    if depth > max || !out.is_empty() {
        return;
    }
    let candidate = dir
        .join("node_modules")
        .join("fs-ext")
        .join("build")
        .join("Release")
        .join("fs_ext.node");
    if candidate.is_file() {
        out.push(candidate);
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if e.path().is_dir() {
            let name = e.file_name().to_string_lossy().to_string();
            // node_modules 内部由上面的 candidate 直接命中，不再下钻依赖树
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            collect_fs_ext_nodes(&e.path(), depth + 1, max, out);
        }
    }
}
