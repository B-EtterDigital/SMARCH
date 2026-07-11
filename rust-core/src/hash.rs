use sha2::{Digest, Sha256};
use std::{fs, io, path::Path};
use xxhash_rust::xxh3::xxh3_64;

pub fn xxh3_hex(bytes: &[u8]) -> String {
    format!("{:016x}", xxh3_64(bytes))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn hash_file(path: &Path) -> io::Result<(u64, String, String)> {
    let bytes = fs::read(path)?;
    Ok((bytes.len() as u64, xxh3_hex(&bytes), sha256_hex(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_hash_vectors() {
        assert_eq!(xxh3_hex(b""), "2d06800538d394c2");
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
