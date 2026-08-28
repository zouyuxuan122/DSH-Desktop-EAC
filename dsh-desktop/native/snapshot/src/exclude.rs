//! exclude.rs — 备份排除列表匹配。
//!
//! 规则（面向用户的极简语义，与 .gitignore 子集对齐）：
//!   · 无 `/` 的模式按「路径段」匹配任意深度：`skills` 排除任意层级的
//!     skills 目录/文件；`*.log` 排除任意 .log 文件；
//!   · 含 `/` 的模式按「相对路径」匹配：`profiles/web` 排除该目录及其
//!     全部内容（前缀语义），也支持 `profiles/web/*.yaml` 全段 glob。

/// 极简 glob：`*` 匹配任意字符序列（不含 `/`），其余字面匹配。
fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    glob_rec(&p, 0, &t, 0)
}

fn glob_rec(p: &[char], pi: usize, t: &[char], ti: usize) -> bool {
    if pi == p.len() {
        return ti == t.len();
    }
    if p[pi] == '*' {
        // 连续 * 折叠为一个
        let mut next = pi;
        while next < p.len() && p[next] == '*' {
            next += 1;
        }
        for skip in ti..=t.len() {
            if glob_rec(p, next, t, skip) {
                return true;
            }
        }
        return false;
    }
    if ti < t.len() && p[pi] == t[ti] {
        return glob_rec(p, pi + 1, t, ti + 1);
    }
    false
}

/// 相对路径是否命中排除列表（rel_path 使用 `/` 分隔，均相对被备份根目录）。
pub fn is_excluded(rel_path: &str, patterns: &[String]) -> bool {
    for raw in patterns {
        let pat = raw.trim().trim_start_matches('/');
        let pat = pat.strip_suffix('/').unwrap_or(pat);
        if pat.is_empty() {
            continue;
        }
        if pat.contains('/') {
            // 路径级：glob 全匹配或目录前缀
            if glob_match(pat, rel_path) {
                return true;
            }
            if rel_path == pat || rel_path.starts_with(&format!("{pat}/")) {
                return true;
            }
        } else {
            // 段级：任意一段命中即排除
            for seg in rel_path.split('/') {
                if glob_match(pat, seg) {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pats(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn segment_patterns_match_any_depth() {
        let p = pats(&["skills", "sessions", ".agent-presets", "memories"]);
        assert!(is_excluded("skills/a/b.md", &p));
        assert!(is_excluded("skills", &p));
        assert!(is_excluded("profiles/web/sessions/x.json", &p));
        assert!(is_excluded(".agent-presets/default.yaml", &p));
        assert!(!is_excluded("settings.yaml", &p));
        assert!(!is_excluded("profiles/web/cordis.patch.yml", &p));
    }

    #[test]
    fn glob_suffix_matches_files() {
        let p = pats(&["*.log", "*.tmp"]);
        assert!(is_excluded("a.log", &p));
        assert!(is_excluded("deep/nested/x.log", &p));
        assert!(!is_excluded("a.json", &p));
    }

    #[test]
    fn path_patterns_match_prefix_or_glob() {
        let p = pats(&["profiles/web", "updater/*.json"]);
        assert!(is_excluded("profiles/web", &p));
        assert!(is_excluded("profiles/web/cordis.patch.yml", &p));
        assert!(!is_excluded("profiles/desktop/x.yml", &p));
        assert!(is_excluded("updater/meta.json", &p));
        assert!(!is_excluded("updater/backup/keep.bin", &p));
    }

    #[test]
    fn empty_and_messy_patterns_ignored() {
        let p = pats(&["", "  ", "/trailing/"]);
        assert!(!is_excluded("anything", &p));
        assert!(is_excluded("trailing/x", &p));
    }
}
