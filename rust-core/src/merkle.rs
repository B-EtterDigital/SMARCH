use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProofStep {
    pub hash: String,
    pub side: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MerkleTree {
    pub root: String,
    pub layers: Vec<Vec<String>>,
}

fn sha256(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

pub fn leaf_hash(brick_id: &str, seal_head: &str) -> String {
    sha256(&format!("leaf\0{brick_id}\0{seal_head}"))
}

fn node_hash(left: &str, right: &str) -> String {
    sha256(&format!("node\0{left}\0{right}"))
}

pub fn build_merkle(leaves: &[String]) -> MerkleTree {
    if leaves.is_empty() {
        return MerkleTree {
            root: sha256("empty\0"),
            layers: vec![Vec::new()],
        };
    }
    let mut layers = vec![leaves.to_vec()];
    while layers.last().is_some_and(|layer| layer.len() > 1) {
        let previous = layers.last().expect("non-empty layer");
        let next = previous
            .chunks(2)
            .map(|pair| node_hash(&pair[0], pair.get(1).unwrap_or(&pair[0])))
            .collect();
        layers.push(next);
    }
    MerkleTree {
        root: layers.last().unwrap()[0].clone(),
        layers,
    }
}

pub fn inclusion_proof(layers: &[Vec<String>], index: usize) -> Vec<ProofStep> {
    let mut proof = Vec::new();
    let mut index = index;
    for layer in layers.iter().take(layers.len().saturating_sub(1)) {
        let is_right = index % 2 == 1;
        let sibling = if is_right {
            index - 1
        } else if index + 1 < layer.len() {
            index + 1
        } else {
            index
        };
        proof.push(ProofStep {
            hash: layer[sibling].clone(),
            side: if is_right { "left" } else { "right" }.into(),
        });
        index /= 2;
    }
    proof
}

pub fn verify_proof(leaf: &str, proof: &[ProofStep], root: &str) -> bool {
    proof.iter().fold(leaf.to_owned(), |hash, step| {
        if step.side == "left" {
            node_hash(&step.hash, &hash)
        } else {
            node_hash(&hash, &step.hash)
        }
    }) == root
}

pub fn verify_brick_inclusion(
    brick_id: &str,
    seal_head: &str,
    proof: &[ProofStep],
    root: &str,
) -> bool {
    verify_proof(&leaf_hash(brick_id, seal_head), proof, root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicates_odd_leaf_and_verifies_proofs() {
        let leaves: Vec<String> = (0..5)
            .map(|index| leaf_hash(&format!("brick-{index}"), &format!("head-{index}")))
            .collect();
        let tree = build_merkle(&leaves);
        for (index, leaf) in leaves.iter().enumerate() {
            assert!(verify_proof(
                leaf,
                &inclusion_proof(&tree.layers, index),
                &tree.root
            ));
        }
        assert!(!verify_brick_inclusion(
            "brick-4",
            "wrong",
            &inclusion_proof(&tree.layers, 4),
            &tree.root
        ));
    }
}
