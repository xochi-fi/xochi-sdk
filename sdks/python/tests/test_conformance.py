"""Byte-equality conformance runner (Python).

Re-signs every vector in the shared `@xochi/spec` fixture and asserts the
digest, signature, and signed_object match byte-for-byte, plus signer recovery.
This is the Python side of the same contract the TS `test/conformance.test.ts`
and the Elixir `raxol_payments` suites enforce against the SAME frozen file.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from xochi_signer import recover, sign

FIXTURE = Path(__file__).resolve().parents[3] / "packages" / "spec" / "conformance" / "conformance.json"


def load_vectors() -> list[dict]:
    return json.loads(FIXTURE.read_text())


VECTORS = load_vectors()


def test_fixture_present_and_counted() -> None:
    assert len(VECTORS) == 45
    by_protocol: dict[str, int] = {}
    for v in VECTORS:
        by_protocol[v["protocol"]] = by_protocol.get(v["protocol"], 0) + 1
    assert by_protocol == {"erc3009": 9, "permit2": 19, "xochi": 17}


@pytest.mark.parametrize("vector", VECTORS, ids=[v["name"] for v in VECTORS])
def test_vector_reproduces_byte_for_byte(vector: dict) -> None:
    result = sign(vector)

    assert result["digest"] == vector["expected_digest"], "digest mismatch"
    assert result["signature"] == vector["expected_signature"], "signature mismatch"
    assert result["signed_object"] == vector["expected_signed_object"], "signed_object mismatch"

    recovered = recover(result["digest"], result["signature"])
    assert recovered.lower() == vector["expected_signer"].lower(), "signer recovery mismatch"


def test_short_nonce_rejected_not_silently_signed() -> None:
    # A non-canonical (short) nonce must fail loud, never silently produce a
    # different signed_object than the reference (which left-pads). Guards the
    # conformance-coverage gap the frozen fixture cannot exercise.
    base = next(v for v in VECTORS if v["protocol"] == "erc3009")
    bad = {**base, "message": {**base["message"], "nonce": "0x01"}}
    with pytest.raises(Exception):
        sign(bad)


@pytest.mark.parametrize("value", ["1_000", " 1000", "1000\n", "\u0661\u0660\u0660\u0660", "1e3", "0x3e8", True])
def test_non_canonical_integer_rejected_not_silently_signed(value: object) -> None:
    # The port accepts canonical input only (an int or an ASCII decimal string).
    # Python's int() takes several of these spellings, and ethers signs " 1000",
    # "1000\n" and "0x3e8" as 1000 -- the port refuses them all the same.
    base = next(v for v in VECTORS if v["protocol"] == "erc3009")
    bad = {**base, "message": {**base["message"], "value": value}}
    with pytest.raises(ValueError, match="non-canonical integer"):
        sign(bad)


@pytest.mark.parametrize("value", [" 1", "1\n", "\u0661", "0x1", "1_0", "1e0", True])
@pytest.mark.parametrize("protocol", ["erc3009", "permit2", "xochi"])
def test_non_canonical_domain_chain_id_rejected_not_silently_signed(protocol: str, value: object) -> None:
    # eth_account parses a string domain chainId leniently: " 1", "0x1" and an
    # Arabic-Indic digit all signed as chain 1 before the domain was checked.
    base = next(v for v in VECTORS if v["protocol"] == protocol)
    if protocol == "xochi":
        eip712 = base["eip712"]
        bad = {**base, "eip712": {**eip712, "domain": {**eip712["domain"], "chainId": value}}}
    else:
        bad = {**base, "domain": {**base["domain"], "chainId": value}}
    with pytest.raises(ValueError, match="non-canonical integer"):
        sign(bad)


def test_decimal_string_domain_chain_id_signs_as_the_integer() -> None:
    base = next(v for v in VECTORS if v["protocol"] == "erc3009")
    as_string = {**base, "domain": {**base["domain"], "chainId": str(base["domain"]["chainId"])}}
    assert sign(as_string)["digest"] == base["expected_digest"]
