//! 模块管理界面的入口。
//!
//! 为什么单独成文件：`#[tauri::command]` 宏在 main.rs 的尾部位置展开时
//! 与同文件里的其它命令发生符号冲突（E0255）。独立模块后展开环境干净，
//! 这是最省事且语义清晰的修法。
//!
//! ## 职责
//!
//! Dounai 是 360×420 的常驻悬浮窗，不适合承载模块的管理界面。
//! 这里只负责「把用户送到浏览器」——管理界面本身由各模块自带，
//! 密钥与厂商配置也归各模块自己保管，本窗口不涉及。

use crate::Runtime;

/// 模块管理界面的服务根与路径（与启动器、模块 manifest 的约定一致）。
///
/// 地址全部来自这张字面量表，**不接受前端传入任意 URL**。
fn admin_target_of(module_id: &str) -> Option<(&'static str, &'static str)> {
    match module_id {
        // 输入层：控制台在根路径
        "dounai-input" => Some(("http://127.0.0.1:8101", "/")),
        // 模型层：设置页
        "omninexus" => Some(("http://127.0.0.1:8102", "/settings")),
        // 语音层：控制台在根路径
        "moodvoice" => Some(("http://127.0.0.1:8103", "/")),
        _ => None,
    }
}

/// 用系统默认浏览器打开某层模块的管理界面。
#[tauri::command]
pub fn open_module_admin(module_id: String) -> Result<String, String> {
    let (base, path) =
        admin_target_of(&module_id).ok_or_else(|| format!("未知模块：{module_id}"))?;
    let url = format!("{base}{path}");

    #[cfg(target_os = "windows")]
    {
        // `start` 的第一个空参数是窗口标题占位，缺了会把 URL 当标题
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| format!("打开浏览器失败：{e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("打开浏览器失败：{e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("打开浏览器失败：{e}"))?;
    }

    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_known_modules_to_admin_urls() {
        assert_eq!(admin_target_of("omninexus"), Some(("http://127.0.0.1:8102", "/settings")));
        assert_eq!(admin_target_of("dounai-input"), Some(("http://127.0.0.1:8101", "/")));
        assert_eq!(admin_target_of("moodvoice"), Some(("http://127.0.0.1:8103", "/")));
    }

    #[test]
    fn rejects_unknown_module() {
        assert_eq!(admin_target_of("unknown-mod"), None);
    }
}
