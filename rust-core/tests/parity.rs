use serde::Deserialize;
use smarch_core::merkle::{build_merkle, inclusion_proof, leaf_hash, verify_proof};
use std::{fs, path::Path, process::Command};

fn repo_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("repository root")
}

fn node_eval(source: &str) -> String {
    let output = Command::new("node")
        .args(["--input-type=module", "--eval", source])
        .current_dir(repo_root())
        .output()
        .expect("node must be available for cross-language parity");
    assert!(
        output.status.success(),
        "node parity probe failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("node stdout is utf8")
}

#[derive(Deserialize)]
struct JsProofStep {
    hash: String,
    side: String,
}

#[derive(Deserialize)]
struct JsMerkle {
    root: String,
    proof: Vec<JsProofStep>,
}

#[test]
fn javascript_and_rust_merkle_roots_and_proofs_match() {
    let module_url = serde_json::to_string(
        &repo_root()
            .join("tools/lib/merkle.ts")
            .to_string_lossy()
            .replace('\\', "/"),
    )
    .unwrap();
    let source = format!(
        r#"import {{ pathToFileURL }} from 'node:url';
const {{ leafHash, buildMerkle, inclusionProof }} = await import(pathToFileURL({module_url}).href);
const leaves = Array.from({{length: 5}}, (_, i) => leafHash(`brick-${{i}}`, `head-${{i}}`));
const tree = buildMerkle(leaves);
console.log(JSON.stringify({{root: tree.root, proof: inclusionProof(tree.layers, 4)}}));"#
    );
    let javascript: JsMerkle = serde_json::from_str(node_eval(&source).trim()).unwrap();
    let leaves: Vec<String> = (0..5)
        .map(|index| leaf_hash(&format!("brick-{index}"), &format!("head-{index}")))
        .collect();
    let rust = build_merkle(&leaves);
    let proof = inclusion_proof(&rust.layers, 4);
    assert_eq!(rust.root, javascript.root);
    assert_eq!(proof.len(), javascript.proof.len());
    for (rust_step, js_step) in proof.iter().zip(javascript.proof) {
        assert_eq!(rust_step.hash, js_step.hash);
        assert_eq!(rust_step.side, js_step.side);
    }

    // Skeptic failure mode: an odd-leaf or domain-separation bug changes this
    // root/proof, and a forged leaf must never verify against the honest root.
    let forged = leaf_hash("brick-4", "tampered");
    assert!(!verify_proof(&forged, &proof, &rust.root));
}

#[derive(Deserialize)]
struct WalkParity {
    node: Vec<String>,
    rust: Vec<String>,
}

#[test]
fn node_adapter_and_native_walker_return_identical_manifest_sets() {
    let fixture = tempfile::tempdir().unwrap();
    fs::create_dir_all(fixture.path().join("alpha")).unwrap();
    fs::create_dir_all(fixture.path().join("beta/nested")).unwrap();
    fs::create_dir_all(fixture.path().join("node_modules/ignored")).unwrap();
    fs::write(
        fixture.path().join("alpha/module.sweetspot.json"),
        "{\"brick\":{\"id\":\"alpha\"}}",
    )
    .unwrap();
    fs::write(
        fixture
            .path()
            .join("beta/nested/beta.module.sweetspot.json"),
        "{\"brick\":{\"id\":\"beta\"}}",
    )
    .unwrap();
    fs::write(
        fixture
            .path()
            .join("node_modules/ignored/module.sweetspot.json"),
        "{}",
    )
    .unwrap();

    let module_path = serde_json::to_string(
        &repo_root()
            .join("tools/lib/scan-walk.ts")
            .to_string_lossy()
            .replace('\\', "/"),
    )
    .unwrap();
    let root = serde_json::to_string(&fixture.path().to_string_lossy().replace('\\', "/")).unwrap();
    let binary =
        serde_json::to_string(&env!("CARGO_BIN_EXE_smarch-core").replace('\\', "/")).unwrap();
    let source = format!(
        r#"import {{ pathToFileURL }} from 'node:url';
const {{ walk }} = await import(pathToFileURL({module_path}).href);
const root = {root};
const options = {{ isExcludedDirName: name => name === 'node_modules', isExcludedPath: () => false }};
process.env.SMA_CORE = 'off';
const node = (await walk(root, options, [])).map(path => path.slice(root.length + 1));
process.env.SMA_CORE = 'required'; process.env.SMA_CORE_BIN = {binary};
const rust = (await walk(root, options, [])).map(path => path.slice(root.length + 1));
console.log(JSON.stringify({{node, rust}}));"#
    );
    let parity: WalkParity = serde_json::from_str(node_eval(&source).trim()).unwrap();
    assert_eq!(parity.node, parity.rust);
    assert_eq!(
        parity.rust,
        vec![
            "alpha/module.sweetspot.json",
            "beta/nested/beta.module.sweetspot.json"
        ]
    );
}
