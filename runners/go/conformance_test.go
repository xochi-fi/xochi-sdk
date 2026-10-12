// Byte-equality conformance runner (Go). Re-signs every vector in the shared
// @xochi/spec fixture and asserts digest, signature, and signed_object match
// byte-for-byte, plus signer recovery -- the Go side of the same contract the TS,
// Python, and Elixir suites enforce against the SAME frozen file.
package conformance

import (
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

func TestFixturePresentAndCounted(t *testing.T) {
	vs, err := LoadVectors(fixturePath(t))
	if err != nil {
		t.Fatalf("load vectors: %v", err)
	}
	if len(vs) != 45 {
		t.Fatalf("expected 45 vectors, got %d", len(vs))
	}
	counts := map[string]int{}
	for _, v := range vs {
		counts[v.Protocol]++
	}
	for proto, want := range map[string]int{"erc3009": 9, "permit2": 19, "xochi": 17} {
		if counts[proto] != want {
			t.Errorf("protocol %s: expected %d vectors, got %d", proto, want, counts[proto])
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

func TestShortNonceRejectedNotSilentlySigned(t *testing.T) {
	// A non-canonical (short) nonce must fail loud, never silently produce a
	// different signed_object than the reference (which left-pads). Guards the
	// conformance-coverage gap the frozen fixture cannot exercise.
	vs, err := LoadVectors(fixturePath(t))
	if err != nil {
		t.Fatalf("load vectors: %v", err)
	}
	var base Vector
	for _, v := range vs {
		if v.Protocol == "erc3009" {
			base = v
			break
		}
	}
	bad := make(map[string]any, len(base.Message))
	for k, v := range base.Message {
		bad[k] = v
	}
	bad["nonce"] = "0x01"
	base.Message = bad
	if _, err := Sign(base); err == nil {
		t.Fatal("expected error on short nonce, got nil (silent divergence)")
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
