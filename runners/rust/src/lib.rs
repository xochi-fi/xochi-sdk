//! Rust conformance runner for the Riddler protocol.
//!
//! Reproduces the `digest`, `signature`, and `signed_object` of every vector in
//! `@xochi/spec` `conformance/conformance.json` byte-for-byte (SPEC.md §2/§8),
//! reproducing the signatures of `@xochi/signer` for the vectors, like the
//! Python / Go runners. Network-free.

use alloy_dyn_abi::{DynSolValue, TypedData};
use alloy_primitives::{Address, FixedBytes, U256, keccak256};
use k256::ecdsa::{RecoveryId, Signature, SigningKey, VerifyingKey};
use serde::Deserialize;
use serde_json::{Map, Value, json};

#[derive(Debug, Deserialize)]
pub struct Vector {
    pub name: String,
    pub protocol: String,
    pub private_key: String,
    pub expected_signer: String,
    pub expected_digest: String,
    pub expected_signature: String,
    pub expected_signed_object: Option<String>,
    // erc3009 / permit2
    pub domain: Option<Value>,
    pub message: Option<Value>,
    // xochi
    pub eip712: Option<Value>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct SignResult {
    pub digest: String,
    pub signature: String,
    pub signed_object: Option<String>,
}

pub type Error = Box<dyn std::error::Error>;

// EIP-712 type lists for the two on-chain-verified methods, byte-for-byte aligned
// with @xochi/signer (signing.ts). xochi carries its own types in the vector.
fn erc3009_types() -> Map<String, Value> {
    let mut m = Map::new();
    m.insert(
        "ReceiveWithAuthorization".into(),
        json!([
            {"name": "from", "type": "address"},
            {"name": "to", "type": "address"},
            {"name": "value", "type": "uint256"},
            {"name": "validAfter", "type": "uint256"},
            {"name": "validBefore", "type": "uint256"},
            {"name": "nonce", "type": "bytes32"}
        ]),
    );
    m
}

fn permit2_types() -> Map<String, Value> {
    let mut m = Map::new();
    m.insert(
        "PermitWitnessTransferFrom".into(),
        json!([
            {"name": "permitted", "type": "TokenPermissions"},
            {"name": "spender", "type": "address"},
            {"name": "nonce", "type": "uint256"},
            {"name": "deadline", "type": "uint256"},
            {"name": "witness", "type": "OriginPullWitness"}
        ]),
    );
    m.insert(
        "TokenPermissions".into(),
        json!([{"name": "token", "type": "address"}, {"name": "amount", "type": "uint256"}]),
    );
    m.insert(
        "OriginPullWitness".into(),
        json!([{"name": "orderId", "type": "bytes32"}]),
    );
    m
}

// EIP712Domain type built from the fields PRESENT in the domain, in canonical
// order. erc3009 has name/version/chainId/verifyingContract, permit2 omits
// version, xochi omits verifyingContract and adds salt.
fn domain_type(domain: &Value) -> Value {
    let order = [
        ("name", "string"),
        ("version", "string"),
        ("chainId", "uint256"),
        ("verifyingContract", "address"),
        ("salt", "bytes32"),
    ];
    let fields: Vec<Value> = order
        .iter()
        .filter(|(k, _)| domain.get(k).is_some())
        .map(|(k, t)| json!({"name": k, "type": t}))
        .collect();
    Value::Array(fields)
}

// The root type: the one no other type references as a field.
fn root_type(types: &Map<String, Value>) -> Result<String, Error> {
    let mut referenced = std::collections::HashSet::new();
    for fields in types.values() {
        for f in fields.as_array().ok_or("types entry is not an array")? {
            if let Some(t) = f.get("type").and_then(Value::as_str) {
                referenced.insert(t.trim_end_matches("[]").to_string());
            }
        }
    }
    let roots: Vec<&String> = types.keys().filter(|k| !referenced.contains(*k)).collect();
    match roots.as_slice() {
        [one] => Ok((*one).clone()),
        _ => Err(format!("expected exactly one root type, found {roots:?}").into()),
    }
}

fn build_typed_data(
    domain: &Value,
    mut types: Map<String, Value>,
    primary: &str,
    message: &Value,
) -> Value {
    types.insert("EIP712Domain".into(), domain_type(domain));
    json!({ "types": types, "primaryType": primary, "domain": domain, "message": message })
}

fn digest_of(typed: &Value) -> Result<[u8; 32], Error> {
    let td: TypedData = serde_json::from_value(typed.clone())?;
    Ok(td.eip712_signing_hash()?.0)
}

fn sign_digest(private_key: &str, digest: &[u8; 32]) -> Result<String, Error> {
    let pk = hex::decode(private_key.trim_start_matches("0x"))?;
    let sk = SigningKey::from_slice(&pk)?;
    let (sig, recid): (Signature, RecoveryId) = sk.sign_prehash_recoverable(digest)?;
    let mut out = [0u8; 65];
    out[..64].copy_from_slice(&sig.to_bytes());
    out[64] = recid.to_byte() + 27; // {0,1} -> {27,28}
    Ok(format!("0x{}", hex::encode(out)))
}

fn to_u256(v: &Value) -> Result<U256, Error> {
    match v {
        Value::String(s) => {
            let (radix, digits) = if let Some(h) = s.strip_prefix("0x") {
                (16, h)
            } else {
                (10, s.as_str())
            };
            Ok(U256::from_str_radix(digits, radix)?)
        }
        Value::Number(n) => Ok(U256::from(n.as_u64().ok_or("number not u64")?)),
        _ => Err("value is not a uint".into()),
    }
}

fn to_addr(v: &Value) -> Result<Address, Error> {
    Ok(v.as_str().ok_or("address not a string")?.parse()?)
}

// Fails loud on a non-32-byte value rather than panicking (FixedBytes::from_slice
// panics) or silently padding. The reference signer LEFT-pads a short nonce; a
// naive port would diverge on non-canonical input -- invisible to the fixture,
// which always uses full 32-byte nonces. (Conformance runner, not a production
// signer -- see README.)
fn to_b32(v: &Value) -> Result<FixedBytes<32>, Error> {
    let s = v.as_str().ok_or("bytes32 not a string")?;
    let bytes = hex::decode(s.trim_start_matches("0x"))?;
    if bytes.len() != 32 {
        return Err(format!("bytes32 must be 32 bytes, got {}", bytes.len()).into());
    }
    Ok(FixedBytes::<32>::from_slice(&bytes))
}

fn signed_object_erc3009(m: &Value) -> Result<String, Error> {
    let tuple = DynSolValue::Tuple(vec![
        DynSolValue::Address(to_addr(&m["from"])?),
        DynSolValue::Address(to_addr(&m["to"])?),
        DynSolValue::Uint(to_u256(&m["value"])?, 256),
        DynSolValue::Uint(to_u256(&m["validAfter"])?, 256),
        DynSolValue::Uint(to_u256(&m["validBefore"])?, 256),
        DynSolValue::FixedBytes(to_b32(&m["nonce"])?, 32),
    ]);
    Ok(format!("0x{}", hex::encode(tuple.abi_encode_params())))
}

fn signed_object_permit2(m: &Value) -> Result<String, Error> {
    let p = &m["permitted"];
    let tuple = DynSolValue::Tuple(vec![
        DynSolValue::Address(to_addr(&p["token"])?),
        DynSolValue::Uint(to_u256(&p["amount"])?, 256),
        DynSolValue::Address(to_addr(&m["spender"])?),
        DynSolValue::Uint(to_u256(&m["nonce"])?, 256),
        DynSolValue::Uint(to_u256(&m["deadline"])?, 256),
    ]);
    Ok(format!("0x{}", hex::encode(tuple.abi_encode_params())))
}

/// Runner contract: sign(vector) -> {digest, signature, signed_object}.
pub fn sign(v: &Vector) -> Result<SignResult, Error> {
    match v.protocol.as_str() {
        "erc3009" => {
            let domain = v.domain.as_ref().ok_or("erc3009 vector missing domain")?;
            let message = v.message.as_ref().ok_or("erc3009 vector missing message")?;
            let typed =
                build_typed_data(domain, erc3009_types(), "ReceiveWithAuthorization", message);
            let digest = digest_of(&typed)?;
            Ok(SignResult {
                digest: format!("0x{}", hex::encode(digest)),
                signature: sign_digest(&v.private_key, &digest)?,
                signed_object: Some(signed_object_erc3009(message)?),
            })
        }
        "permit2" => {
            let domain = v.domain.as_ref().ok_or("permit2 vector missing domain")?;
            let message = v.message.as_ref().ok_or("permit2 vector missing message")?;
            let typed = build_typed_data(
                domain,
                permit2_types(),
                "PermitWitnessTransferFrom",
                message,
            );
            let digest = digest_of(&typed)?;
            Ok(SignResult {
                digest: format!("0x{}", hex::encode(digest)),
                signature: sign_digest(&v.private_key, &digest)?,
                signed_object: Some(signed_object_permit2(message)?),
            })
        }
        "xochi" => {
            let eip712 = v.eip712.as_ref().ok_or("xochi vector missing eip712")?;
            let domain = &eip712["domain"];
            let message = &eip712["message"];
            let types: Map<String, Value> = eip712["types"]
                .as_object()
                .ok_or("eip712.types not an object")?
                .clone();
            let primary = root_type(&types)?;
            let typed = build_typed_data(domain, types, &primary, message);
            let digest = digest_of(&typed)?;
            Ok(SignResult {
                digest: format!("0x{}", hex::encode(digest)),
                signature: sign_digest(&v.private_key, &digest)?,
                signed_object: None, // off-chain intent
            })
        }
        other => Err(format!("unknown protocol: {other}").into()),
    }
}

/// Recover the signer address from a digest + signature.
pub fn recover(digest: &str, signature: &str) -> Result<Address, Error> {
    let d = hex::decode(digest.trim_start_matches("0x"))?;
    let sig = hex::decode(signature.trim_start_matches("0x"))?;
    let mut v = sig[64];
    if v >= 27 {
        v -= 27;
    }
    let signature = Signature::from_slice(&sig[..64])?;
    let recid = RecoveryId::from_byte(v).ok_or("bad recovery id")?;
    let vk: VerifyingKey = VerifyingKey::recover_from_prehash(&d, &signature, recid)?;
    let point = vk.to_encoded_point(false);
    let hash = keccak256(&point.as_bytes()[1..]); // keccak of 64-byte uncompressed pubkey
    Ok(Address::from_slice(&hash[12..]))
}
