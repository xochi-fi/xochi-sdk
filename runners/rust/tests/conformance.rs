//! Byte-equality conformance runner (Rust). Re-signs every vector in the shared
//! `@xochi/spec` fixture and asserts digest, signature, and signed_object match
//! byte-for-byte, plus signer recovery -- the Rust side of the same contract the
//! TS, Python, Go, and Elixir suites enforce against the SAME frozen file.

use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::{Value, json};
use xochi_conformance::{Vector, recover, sign};

fn load_vectors() -> Vec<Vector> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/spec/conformance/conformance.json");
    let data = std::fs::read_to_string(&path).expect("read fixture");
    serde_json::from_str(&data).expect("parse fixture")
}

fn first_vector(protocol: &str) -> Vector {
    load_vectors()
        .into_iter()
        .find(|v| v.protocol == protocol)
        .unwrap_or_else(|| panic!("no {protocol} vector"))
}

#[test]
fn fixture_covers_every_protocol() {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for v in load_vectors() {
        *counts.entry(v.protocol).or_default() += 1;
    }
    let mut protocols: Vec<&str> = counts.keys().map(String::as_str).collect();
    protocols.sort_unstable();
    assert_eq!(protocols, ["erc3009", "permit2", "xochi"]);
    assert!(counts.values().all(|&n| n >= 1));
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
    let mut base = first_vector("erc3009");
    base.message.as_mut().unwrap()["nonce"] = json!("0x01");
    assert!(
        sign(&base).is_err(),
        "short nonce must be rejected, not silently signed"
    );
}

fn non_canonical_integers() -> Vec<Value> {
    let mut values: Vec<Value> = [
        "01000", " 1000", "1000\n", "+1000", "-1000", "0x3e8", "1e3", "1_000", "",
    ]
    .into_iter()
    .map(Value::from)
    .collect();
    for raw in ["1e3", "1000.0", "-1000", "true"] {
        values.push(serde_json::from_str(raw).expect("json literal"));
    }
    values
}

fn assert_non_canonical_rejected(vector: &Vector, value: &Value) {
    match sign(vector) {
        Err(e) if e.to_string().contains("non-canonical integer") => {}
        other => panic!("{value}: expected non-canonical integer error, got {other:?}"),
    }
}

#[test]
fn non_canonical_integer_rejected_not_silently_signed() {
    let base = first_vector("erc3009");
    for value in non_canonical_integers() {
        let mut bad = base.clone();
        bad.message.as_mut().unwrap()["value"] = value.clone();
        assert_non_canonical_rejected(&bad, &value);
    }
}

#[test]
fn non_canonical_domain_chain_id_rejected_not_silently_signed() {
    for protocol in ["erc3009", "permit2", "xochi"] {
        let base = first_vector(protocol);
        for value in non_canonical_integers() {
            let mut bad = base.clone();
            let domain = match bad.eip712.as_mut() {
                Some(eip712) => &mut eip712["domain"],
                None => bad.domain.as_mut().unwrap(),
            };
            domain["chainId"] = value.clone();
            assert_non_canonical_rejected(&bad, &value);
        }
    }
}
