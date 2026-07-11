use serde::Serialize;
use smarch_core::{hash, merkle, sim, walk};
use std::{env, fs, path::PathBuf, process};

const PROTOCOL_VERSION: &str = "1.0.0";

#[derive(Serialize)]
struct Envelope<T: Serialize> {
    protocol_version: &'static str,
    command: &'static str,
    data: T,
}

#[derive(Serialize)]
struct ScanData {
    root: String,
    files: Vec<walk::ScanFile>,
}
#[derive(Serialize)]
struct HashData {
    path: String,
    size: u64,
    xxh3: String,
    sha256: String,
}
#[derive(Serialize)]
struct SimData {
    left: String,
    right: String,
    score: f64,
}
#[derive(Serialize)]
struct MerkleData {
    root: String,
    leaf_count: usize,
    proof_index: Option<usize>,
    proof: Vec<merkle::ProofStep>,
}

fn value(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .cloned()
}
fn values(args: &[String], name: &str) -> Vec<String> {
    args.iter()
        .enumerate()
        .filter_map(|(index, arg)| {
            (arg == name)
                .then(|| args.get(index + 1).cloned())
                .flatten()
        })
        .collect()
}
fn positional(args: &[String]) -> Vec<String> {
    let valued = [
        "--exclude-root",
        "--exclude-dir",
        "--exclude-pattern",
        "--proof-index",
    ];
    let mut output = Vec::new();
    let mut skip = false;
    for arg in args {
        if skip {
            skip = false;
            continue;
        }
        if valued.contains(&arg.as_str()) {
            skip = true;
            continue;
        }
        if !arg.starts_with('-') {
            output.push(arg.clone());
        }
    }
    output
}
fn emit<T: Serialize>(command: &'static str, data: T) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string(&Envelope {
            protocol_version: PROTOCOL_VERSION,
            command,
            data
        })
        .map_err(|error| error.to_string())?
    );
    Ok(())
}

fn run() -> Result<(), String> {
    let mut args: Vec<String> = env::args().skip(1).collect();
    let command = args
        .first()
        .cloned()
        .ok_or("missing command (scan, hash, sim, or merkle)")?;
    args.remove(0);
    if !args.iter().any(|arg| arg == "--json") {
        return Err("--json is required".into());
    }
    match command.as_str() {
        "scan" => {
            let positions = positional(&args);
            let root = PathBuf::from(positions.first().ok_or("scan requires ROOT")?);
            let options = walk::WalkOptions {
                excluded_roots: values(&args, "--exclude-root")
                    .into_iter()
                    .map(PathBuf::from)
                    .collect(),
                excluded_dir_names: values(&args, "--exclude-dir"),
                excluded_dir_patterns: values(&args, "--exclude-pattern"),
                include_hashes: args.iter().any(|arg| arg == "--include-hashes"),
            };
            let files = walk::scan(&root, &options)?;
            emit(
                "scan",
                ScanData {
                    root: root.to_string_lossy().replace('\\', "/"),
                    files,
                },
            )
        }
        "hash" => {
            let positions = positional(&args);
            let path = PathBuf::from(positions.first().ok_or("hash requires PATH")?);
            let (size, xxh3, sha256) = hash::hash_file(&path).map_err(|error| error.to_string())?;
            emit(
                "hash",
                HashData {
                    path: path.to_string_lossy().replace('\\', "/"),
                    size,
                    xxh3,
                    sha256,
                },
            )
        }
        "sim" => {
            let positions = positional(&args);
            let left_path = PathBuf::from(positions.first().ok_or("sim requires LEFT RIGHT")?);
            let right_path = PathBuf::from(positions.get(1).ok_or("sim requires LEFT RIGHT")?);
            let left = fs::read_to_string(&left_path).map_err(|error| error.to_string())?;
            let right = fs::read_to_string(&right_path).map_err(|error| error.to_string())?;
            emit(
                "sim",
                SimData {
                    left: left_path.to_string_lossy().replace('\\', "/"),
                    right: right_path.to_string_lossy().replace('\\', "/"),
                    score: sim::similarity(&left, &right),
                },
            )
        }
        "merkle" => {
            let positions = positional(&args);
            let pairs: Vec<(String, String)> = positions
                .iter()
                .map(|pair| {
                    pair.split_once(':')
                        .map(|(id, head)| (id.into(), head.into()))
                        .ok_or_else(|| format!("invalid leaf {pair:?}; expected BRICK:HEAD"))
                })
                .collect::<Result<_, _>>()?;
            let leaves: Vec<String> = pairs
                .iter()
                .map(|(id, head)| merkle::leaf_hash(id, head))
                .collect();
            let tree = merkle::build_merkle(&leaves);
            let proof_index = value(&args, "--proof-index")
                .map(|value| value.parse::<usize>().map_err(|_| "invalid proof index"))
                .transpose()?;
            if proof_index.is_some_and(|index| index >= leaves.len()) {
                return Err("proof index out of range".into());
            }
            let proof = proof_index
                .map(|index| merkle::inclusion_proof(&tree.layers, index))
                .unwrap_or_default();
            emit(
                "merkle",
                MerkleData {
                    root: tree.root,
                    leaf_count: leaves.len(),
                    proof_index,
                    proof,
                },
            )
        }
        _ => Err(format!("unknown command {command:?}")),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("smarch-core: {error}");
        process::exit(2);
    }
}
