// Byte-equality conformance runner (Go). Re-signs every vector in the shared
// @xochi/spec fixture and asserts digest, signature, and signed_object match
// byte-for-byte, plus signer recovery -- the Go side of the same contract the TS,
// Python, and Elixir suites enforce against the SAME frozen file.
package conformance

import (
	"encoding/json"
	"maps"
	"path/filepath"
	"strings"
	"testing"
)

func fixturePath(t *testing.T) string {
	t.Helper()
	p, err := filepath.Abs(filepath.Join("..", "..", "packages", "spec", "conformance", "conformance.json"))
	if err != nil {
		t.Fatalf("resolve fixture path: %v", err)
	}
	return p
}

func TestFixtureCoversEveryProtocol(t *testing.T) {
	vs, err := LoadVectors(fixturePath(t))
	if err != nil {
		t.Fatalf("load vectors: %v", err)
	}
	counts := map[string]int{}
	for _, v := range vs {
		counts[v.Protocol]++
	}
	want := []string{"erc3009", "permit2", "xochi"}
	if len(counts) != len(want) {
		t.Fatalf("protocols: got %v, want exactly %v", counts, want)
	}
	for _, proto := range want {
		if counts[proto] < 1 {
			t.Errorf("protocol %s: no vectors", proto)
		}
	}
}

func TestVectorsReproduceByteForByte(t *testing.T) {
	vs, err := LoadVectors(fixturePath(t))
	if err != nil {
		t.Fatalf("load vectors: %v", err)
	}
	for _, v := range vs {
		v := v
		t.Run(v.Name, func(t *testing.T) {
			got, err := Sign(v)
			if err != nil {
				t.Fatalf("sign: %v", err)
			}
			if got.Digest != v.ExpectedDigest {
				t.Errorf("digest\n  got  %s\n  want %s", got.Digest, v.ExpectedDigest)
			}
			if got.Signature != v.ExpectedSignature {
				t.Errorf("signature\n  got  %s\n  want %s", got.Signature, v.ExpectedSignature)
			}
			if !signedObjectEqual(got.SignedObject, v.ExpectedSignedObject) {
				t.Errorf("signed_object\n  got  %v\n  want %v", deref(got.SignedObject), deref(v.ExpectedSignedObject))
			}
			recovered, err := Recover(got.Digest, got.Signature)
			if err != nil {
				t.Fatalf("recover: %v", err)
			}
			if !strings.EqualFold(recovered, v.ExpectedSigner) {
				t.Errorf("signer\n  got  %s\n  want %s", recovered, v.ExpectedSigner)
			}
		})
	}
}

func firstVector(t *testing.T, protocol string) Vector {
	t.Helper()
	vs, err := LoadVectors(fixturePath(t))
	if err != nil {
		t.Fatalf("load vectors: %v", err)
	}
	for _, v := range vs {
		if v.Protocol == protocol {
			return v
		}
	}
	t.Fatalf("no %s vector", protocol)
	return Vector{}
}

func TestShortNonceRejectedNotSilentlySigned(t *testing.T) {
	// A non-canonical (short) nonce must fail loud, never silently produce a
	// different signed_object than the reference (which left-pads). Guards the
	// conformance-coverage gap the frozen fixture cannot exercise.
	base := firstVector(t, "erc3009")
	base.Message = maps.Clone(base.Message)
	base.Message["nonce"] = "0x01"
	if _, err := Sign(base); err == nil {
		t.Fatal("expected error on short nonce, got nil (silent divergence)")
	}
}

var nonCanonicalIntegers = []struct {
	name  string
	value any
}{
	{"leading zero", "01000"},
	{"leading space", " 1000"},
	{"trailing newline", "1000\n"},
	{"plus sign", "+1000"},
	{"minus sign", "-1000"},
	{"hex", "0x3e8"},
	{"exponent string", "1e3"},
	{"separator", "1_000"},
	{"empty", ""},
	{"json exponent", json.Number("1e3")},
	{"json fraction", json.Number("1000.0")},
	{"json negative", json.Number("-1000")},
	{"float64", float64(1000)},
	{"bool", true},
}

func TestNonCanonicalIntegerRejectedNotSilentlySigned(t *testing.T) {
	base := firstVector(t, "erc3009")
	for _, tc := range nonCanonicalIntegers {
		t.Run(tc.name, func(t *testing.T) {
			bad := base
			bad.Message = maps.Clone(base.Message)
			bad.Message["value"] = tc.value
			if _, err := Sign(bad); err == nil || !strings.Contains(err.Error(), "non-canonical integer") {
				t.Fatalf("value %#v: expected non-canonical integer error, got %v", tc.value, err)
			}
		})
	}
}

func TestNonCanonicalDomainChainIDRejectedNotSilentlySigned(t *testing.T) {
	for _, protocol := range []string{"erc3009", "permit2", "xochi"} {
		base := firstVector(t, protocol)
		for _, tc := range nonCanonicalIntegers {
			t.Run(protocol+"/"+tc.name, func(t *testing.T) {
				bad := base
				if protocol == "xochi" {
					eip712 := *base.Eip712
					eip712.Domain = maps.Clone(eip712.Domain)
					eip712.Domain["chainId"] = tc.value
					bad.Eip712 = &eip712
				} else {
					bad.Domain = maps.Clone(base.Domain)
					bad.Domain["chainId"] = tc.value
				}
				if _, err := Sign(bad); err == nil || !strings.Contains(err.Error(), "non-canonical integer") {
					t.Fatalf("chainId %#v: expected non-canonical integer error, got %v", tc.value, err)
				}
			})
		}
	}
}

func signedObjectEqual(got, want *string) bool {
	if got == nil || want == nil {
		return got == nil && want == nil
	}
	return *got == *want
}

func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}
