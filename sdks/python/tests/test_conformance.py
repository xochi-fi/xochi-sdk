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

from riddler_signer import recover, sign

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
