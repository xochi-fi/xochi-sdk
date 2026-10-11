"""Python conformance signer for the Riddler protocol.

Reproduces the `digest`, `signature`, and `signed_object` of every vector in
`@xochi/spec` `conformance/conformance.json` byte-for-byte (SPEC.md §2/§8).
Mirrors the TypeScript reference signer in `@xochi/signer`. Network-free.
"""

from __future__ import annotations

import re
from typing import Any

from eth_abi import encode as abi_encode
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import keccak, to_bytes

# EIP-712 type lists for the two on-chain-verified methods. Byte-for-byte aligned
# with `@xochi/signer` (signing.ts). For `xochi`, the vector carries its own
# `eip712.types` (server-parity list at domain version "3").
ERC3009_TYPES: dict[str, list[dict[str, str]]] = {
    "ReceiveWithAuthorization": [
        {"name": "from", "type": "address"},
        {"name": "to", "type": "address"},
        {"name": "value", "type": "uint256"},
        {"name": "validAfter", "type": "uint256"},
        {"name": "validBefore", "type": "uint256"},
        {"name": "nonce", "type": "bytes32"},
    ],
}

PERMIT2_TYPES: dict[str, list[dict[str, str]]] = {
    "PermitWitnessTransferFrom": [
        {"name": "permitted", "type": "TokenPermissions"},
        {"name": "spender", "type": "address"},
        {"name": "nonce", "type": "uint256"},
        {"name": "deadline", "type": "uint256"},
        {"name": "witness", "type": "OriginPullWitness"},
    ],
    "TokenPermissions": [
        {"name": "token", "type": "address"},
        {"name": "amount", "type": "uint256"},
    ],
    "OriginPullWitness": [{"name": "orderId", "type": "bytes32"}],
}


class SignResult(dict):
    """{'digest': str, 'signature': str, 'signed_object': str | None}."""


# ASCII decimal only. Python's int() also takes "1_000", surrounding whitespace
# and non-ASCII Unicode digits, none of which the TS reference signs as the
# same value (ethers rejects "1_000"), so those are refused, not normalized.
_DECIMAL = re.compile(r"-?[0-9]+", re.ASCII)


def _coerce_int(value: Any) -> int:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str) and _DECIMAL.fullmatch(value):
        return int(value)
    raise ValueError(f"non-canonical integer {value!r}: expected an int or an ASCII decimal string")


def _coerce_scalar(value: Any, abi_type: str) -> Any:
    if abi_type.startswith(("uint", "int")):
        return _coerce_int(value)
    if abi_type.startswith("bytes"):
        return to_bytes(hexstr=value) if isinstance(value, str) else value
    return value  # address / string pass through as str


def _coerce_message(message: dict[str, Any], types: dict[str, list[dict[str, str]]], primary: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for field in types[primary]:
        name, abi_type = field["name"], field["type"]
        value = message[name]
        out[name] = _coerce_message(value, types, abi_type) if abi_type in types else _coerce_scalar(value, abi_type)
    return out


def _primary_type(types: dict[str, list[dict[str, str]]]) -> str:
    """The root type: the one no other type references as a field."""
    referenced = {f["type"] for fields in types.values() for f in fields}
    roots = [name for name in types if name not in referenced]
    if len(roots) != 1:
        raise ValueError(f"expected exactly one root type, found {roots}")
    return roots[0]


def _sign_typed(private_key: str, domain: dict[str, Any], types: dict[str, list[dict[str, str]]], message: dict[str, Any]) -> tuple[str, str]:
    primary = _primary_type(types)
    coerced = _coerce_message(message, types, primary)
    signable = encode_typed_data(domain, types, coerced)
    signed = Account.sign_message(signable, private_key)
    return signed.message_hash.to_0x_hex(), signed.signature.to_0x_hex()


def _signed_object_erc3009(message: dict[str, Any]) -> str:
    # Fail loud on a non-32-byte nonce. The reference signer (signing.ts)
    # LEFT-pads a short nonce; silently accepting one here would diverge on
    # non-canonical input -- invisible to the fixture (always full 32-byte
    # nonces). Conformance runner, not a production signer -- see README.
    nonce = to_bytes(hexstr=message["nonce"])
    if len(nonce) != 32:
        raise ValueError(f"bytes32 nonce must be 32 bytes, got {len(nonce)}")
    encoded = abi_encode(
        ["address", "address", "uint256", "uint256", "uint256", "bytes32"],
        [
            message["from"],
            message["to"],
            int(message["value"]),
            int(message["validAfter"]),
            int(message["validBefore"]),
            nonce,
        ],
    )
    return "0x" + encoded.hex()


def _signed_object_permit2(message: dict[str, Any]) -> str:
    # tuple(tuple(address,uint256),address,uint256,uint256) with all-static
    # members == the flat 5-word encoding (no offset pointer). Mirrors the TS
    # signer's offset-stripped `signed_object`.
    permitted = message["permitted"]
    encoded = abi_encode(
        ["address", "uint256", "address", "uint256", "uint256"],
        [
            permitted["token"],
            int(permitted["amount"]),
            message["spender"],
            int(message["nonce"]),
            int(message["deadline"]),
        ],
    )
    return "0x" + encoded.hex()


def sign(vector: dict[str, Any]) -> SignResult:
    """Runner contract: sign(vector) -> {digest, signature, signed_object}."""
    protocol = vector["protocol"]
    pk = vector["private_key"]

    if protocol == "erc3009":
        digest, signature = _sign_typed(pk, vector["domain"], ERC3009_TYPES, vector["message"])
        return SignResult(digest=digest, signature=signature, signed_object=_signed_object_erc3009(vector["message"]))

    if protocol == "permit2":
        digest, signature = _sign_typed(pk, vector["domain"], PERMIT2_TYPES, vector["message"])
        return SignResult(digest=digest, signature=signature, signed_object=_signed_object_permit2(vector["message"]))

    if protocol == "xochi":
        eip712 = vector["eip712"]
        digest, signature = _sign_typed(pk, eip712["domain"], eip712["types"], eip712["message"])
        # XochiIntent is off-chain (ecrecover server-side): no signed_object.
        return SignResult(digest=digest, signature=signature, signed_object=None)

    raise ValueError(f"unknown protocol: {protocol}")


def recover(digest: str, signature: str) -> str:
    """Recover the signer address from a digest + signature (for conformance)."""
    from eth_keys import keys

    sig_bytes = to_bytes(hexstr=signature)
    v = sig_bytes[64]
    v = v - 27 if v >= 27 else v  # normalize {27,28} -> {0,1}
    sig = keys.Signature(sig_bytes[:64] + bytes([v]))
    pub = sig.recover_public_key_from_msg_hash(to_bytes(hexstr=digest))
    return pub.to_checksum_address()


__all__ = ["sign", "recover", "SignResult", "ERC3009_TYPES", "PERMIT2_TYPES", "keccak"]
