//! Byte-equality conformance runner (Rust). Re-signs every vector in the shared
//! `@xochi/spec` fixture and asserts digest, signature, and signed_object match
//! byte-for-byte, plus signer recovery -- the Rust side of the same contract the
//! TS, Python, Go, and Elixir suites enforce against the SAME frozen file.

use std::collections::HashMap;
use std::path::PathBuf;

use xochi_signer::{Vector, recover, sign};

fn load_vectors() -> Vec<Vector> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/spec/conformance/conformance.json");
    let data = std::fs::read_to_string(&path).expect("read fixture");
    serde_json::from_str(&data).expect("parse fixture")
}

#[test]
fn fixture_present_and_counted() {
    let vectors = load_vectors();
    assert_eq!(vectors.len(), 45, "expected 45 vectors");
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for v in &vectors {
        *counts.entry(v.protocol.as_str()).or_default() += 1;
    }
    assert_eq!(counts.get("erc3009"), Some(&9));
    assert_eq!(counts.get("permit2"), Some(&19));
    assert_eq!(counts.get("xochi"), Some(&17));
}

#[test]
fn vectors_reproduce_byte_for_byte() {
    let vectors = load_vectors();
    let mut failures = Vec::new();

    for v in &vectors {
        let result = match sign(v) {
            Ok(r) => r,
            Err(e) => {
                failures.push(format!("{}: sign error: {e}", v.name));
                continue;
            }
        };
        if result.digest != v.expected_digest {
            failures.push(format!(
                "{}: digest\n  got  {}\n  want {}",
                v.name, result.digest, v.expected_digest
            ));
        }
        if result.signature != v.expected_signature {
            failures.push(format!("{}: signature mismatch", v.name));
        }
        if result.signed_object != v.expected_signed_object {
            failures.push(format!(
                "{}: signed_object\n  got  {:?}\n  want {:?}",
                v.name, result.signed_object, v.expected_signed_object
            ));
        }
        match recover(&result.digest, &result.signature) {
            Ok(addr) => {
                if !addr.to_string().eq_ignore_ascii_case(&v.expected_signer) {
                    failures.push(format!(
                        "{}: signer got {addr} want {}",
                        v.name, v.expected_signer
                    ));
                }
            }
            Err(e) => failures.push(format!("{}: recover error: {e}", v.name)),
        }
    }

    assert!(
        failures.is_empty(),
        "{} vector(s) failed:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn short_nonce_rejected_not_silently_signed() {
    // A non-canonical (short) nonce must fail loud, never silently produce a
    // different signed_object than the reference (which left-pads). Guards the
    // conformance-coverage gap the frozen fixture cannot exercise.
    let mut base = load_vectors()
        .into_iter()
        .find(|v| v.protocol == "erc3009")
        .expect("an erc3009 vector");
    base.message.as_mut().unwrap()["nonce"] = serde_json::json!("0x01");
    assert!(
        sign(&base).is_err(),
        "short nonce must be rejected, not silently signed"
    );
}
