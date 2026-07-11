use ignore::{DirEntry, WalkBuilder, WalkState};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Debug, Clone, Default)]
pub struct WalkOptions {
    pub excluded_roots: Vec<PathBuf>,
    pub excluded_dir_names: Vec<String>,
    pub excluded_dir_patterns: Vec<String>,
    pub include_hashes: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScanFile {
    pub path: String,
    pub relative_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub xxh3: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

fn normalized(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn is_manifest(entry: &DirEntry) -> bool {
    let Some(file_type) = entry.file_type() else {
        return false;
    };
    if !file_type.is_file() {
        return false;
    }
    let name = entry.file_name().to_string_lossy();
    name == "module.sweetspot.json" || name.ends_with(".module.sweetspot.json")
}

fn excluded(path: &Path, root: &Path, options: &WalkOptions) -> bool {
    if options
        .excluded_roots
        .iter()
        .any(|item| path.starts_with(item))
    {
        return true;
    }
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if path != root && options.excluded_dir_names.iter().any(|item| item == name) {
        return true;
    }
    path != root
        && options
            .excluded_dir_patterns
            .iter()
            .any(|pattern| name.contains(pattern))
}

pub fn scan(root: &Path, options: &WalkOptions) -> Result<Vec<ScanFile>, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("cannot resolve {}: {error}", root.display()))?;
    let output = Arc::new(Mutex::new(Vec::<PathBuf>::new()));
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));
    let output_ref = Arc::clone(&output);
    let errors_ref = Arc::clone(&errors);
    let options = Arc::new(options.clone());

    let mut builder = WalkBuilder::new(&root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(true)
        .require_git(false)
        .parents(true)
        .follow_links(false)
        .filter_entry({
            let root = root.clone();
            let options = Arc::clone(&options);
            move |entry| !excluded(entry.path(), &root, &options)
        });

    builder.build_parallel().run(|| {
        let output = Arc::clone(&output_ref);
        let errors = Arc::clone(&errors_ref);
        Box::new(move |result| match result {
            Ok(entry) => {
                if is_manifest(&entry) {
                    output
                        .lock()
                        .expect("walk output lock")
                        .push(entry.into_path());
                }
                WalkState::Continue
            }
            Err(error) => {
                errors
                    .lock()
                    .expect("walk error lock")
                    .push(error.to_string());
                WalkState::Continue
            }
        })
    });

    let errors = errors.lock().map_err(|error| error.to_string())?;
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }

    let mut paths = output.lock().map_err(|error| error.to_string())?.clone();
    paths.sort_by_key(|path| normalized(path));
    paths
        .into_iter()
        .map(|path| {
            let (size, xxh3, sha256) = if options.include_hashes {
                let (size, xxh3, sha256) = crate::hash::hash_file(&path)
                    .map_err(|error| format!("cannot hash {}: {error}", path.display()))?;
                (Some(size), Some(xxh3), Some(sha256))
            } else {
                (None, None, None)
            };
            Ok(ScanFile {
                relative_path: normalized(path.strip_prefix(&root).unwrap_or(&path)),
                path: normalized(&path),
                size,
                xxh3,
                sha256,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn parallel_walk_honors_gitignore_and_is_sorted() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("a")).unwrap();
        fs::create_dir_all(dir.path().join("b")).unwrap();
        fs::create_dir_all(dir.path().join("ignored")).unwrap();
        fs::write(dir.path().join("a/module.sweetspot.json"), "{}").unwrap();
        fs::write(dir.path().join("b/x.module.sweetspot.json"), "{}").unwrap();
        fs::write(dir.path().join("ignored/module.sweetspot.json"), "{}").unwrap();
        fs::write(dir.path().join(".gitignore"), "ignored/\n").unwrap();
        let files = scan(dir.path(), &WalkOptions::default()).unwrap();
        assert_eq!(
            files
                .iter()
                .map(|item| item.relative_path.as_str())
                .collect::<Vec<_>>(),
            vec!["a/module.sweetspot.json", "b/x.module.sweetspot.json"]
        );
    }
}
