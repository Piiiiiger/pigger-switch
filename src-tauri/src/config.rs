use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::AppError;

/// 获取用户主目录，带回退和日志
///
/// 不直接读 `HOME`：Windows 上它可能由 Git/MSYS 等工具注入，不等于真实用户目录。
/// 测试可通过 `PIGGER_SWITCH_TEST_HOME` 显式覆盖，隔离真实用户数据。
pub fn get_home_dir() -> PathBuf {
    if let Ok(home) = std::env::var("PIGGER_SWITCH_TEST_HOME") {
        let trimmed = home.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    dirs::home_dir().unwrap_or_else(|| {
        log::warn!("无法获取用户主目录，回退到当前目录");
        PathBuf::from(".")
    })
}

/// Claude Code 配置目录（会话日志在它下面的 `projects/`）。
/// 设置里填了自定义目录时用它，否则 `CLAUDE_CONFIG_DIR`，再否则 `~/.claude`。
pub fn get_claude_config_dir() -> PathBuf {
    if let Some(custom) = crate::settings::get_claude_override_dir() {
        return custom;
    }
    if let Some(dir) = env_dir("CLAUDE_CONFIG_DIR") {
        return dir;
    }
    get_home_dir().join(".claude")
}

/// Codex 配置目录（会话日志在它下面的 `sessions/`）。
/// 设置里填了自定义目录时用它，否则 `CODEX_HOME`，再否则 `~/.codex`。
pub fn get_codex_config_dir() -> PathBuf {
    if let Some(custom) = crate::settings::get_codex_override_dir() {
        return custom;
    }
    if let Some(dir) = env_dir("CODEX_HOME") {
        return dir;
    }
    get_home_dir().join(".codex")
}

/// Codex auth.json 路径
pub fn get_codex_auth_path() -> PathBuf {
    get_codex_config_dir().join("auth.json")
}

fn env_dir(name: &str) -> Option<PathBuf> {
    // 测试里覆盖了 home 时不让真实环境变量漏进来
    if std::env::var_os("PIGGER_SWITCH_TEST_HOME").is_some() {
        return None;
    }
    let value = std::env::var(name).ok()?;
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| PathBuf::from(trimmed))
}

/// 应用数据目录 (~/.pigger-switch)：数据库、设置、模型定价覆盖、备份都在这里
pub fn get_app_config_dir() -> PathBuf {
    get_home_dir().join(".pigger-switch")
}

/// CC Switch 的数据库（可从中导入历史用量）
pub fn get_cc_switch_db_path() -> PathBuf {
    get_home_dir().join(".cc-switch").join("cc-switch.db")
}

/// 原子写入：写入同目录临时文件后 rename 替换，避免半写状态
pub fn atomic_write(path: &Path, data: &[u8]) -> Result<(), AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Config(format!("无效路径: {}", path.display())))?;
    fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = parent.join(format!(".{file_name}.tmp.{}", std::process::id()));
    let _ = fs::remove_file(&tmp);
    {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        // 设置里存着 Pigger 的令牌：只让本人读写
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&tmp).map_err(|e| AppError::io(&tmp, e))?;
        file.write_all(data).map_err(|e| AppError::io(&tmp, e))?;
        file.sync_all().map_err(|e| AppError::io(&tmp, e))?;
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        AppError::io(path, e)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_existing_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("nested").join("file.json");
        atomic_write(&path, b"one").expect("first write");
        atomic_write(&path, b"two").expect("second write");
        assert_eq!(fs::read_to_string(&path).expect("read"), "two");
        let leftovers: Vec<_> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp."))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_leaves_the_file_readable_only_by_its_owner() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.json");
        fs::write(&path, b"old").expect("seed");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("chmod");
        // 用常见桌面的 umask（新文件默认 0644），证明是 atomic_write 自己收紧的
        let previous = unsafe { libc::umask(0o022) };
        let written = atomic_write(&path, b"{}");
        unsafe { libc::umask(previous) };
        written.expect("write");
        let mode = fs::metadata(&path).expect("stat").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
