package conformance

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"strings"
)

// TypeField is one EIP-712 struct field ({name, type}).
type TypeField struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// Eip712 is the self-contained signable blob carried by xochi vectors.
type Eip712 struct {
	Domain  map[string]any         `json:"domain"`
	Types   map[string][]TypeField `json:"types"`
	Message map[string]any         `json:"message"`
}

// Vector is one conformance fixture entry.
type Vector struct {
	Name                 string         `json:"name"`
	Protocol             string         `json:"protocol"`
	PrivateKey           string         `json:"private_key"`
	ExpectedSigner       string         `json:"expected_signer"`
	ExpectedDigest       string         `json:"expected_digest"`
	ExpectedSignature    string         `json:"expected_signature"`
	ExpectedSignedObject *string        `json:"expected_signed_object"`
	Domain               map[string]any `json:"domain"`  // erc3009 / permit2
	Message              map[string]any `json:"message"` // erc3009 / permit2
	Eip712               *Eip712        `json:"eip712"`  // xochi
}

// LoadVectors reads the shared fixture with UseNumber so large uint256 amounts
// survive as json.Number (not lossy float64).
func LoadVectors(path string) ([]Vector, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var vs []Vector
	if err := dec.Decode(&vs); err != nil {
		return nil, err
	}
	return vs, nil
}

func toStr(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case json.Number:
		return x.String()
	default:
		return ""
	}
}

func toBig(v any) *big.Int {
	switch x := v.(type) {
	case json.Number:
		if b, ok := new(big.Int).SetString(x.String(), 10); ok {
			return b
		}
	case string:
		if b, ok := new(big.Int).SetString(strings.TrimSpace(x), 10); ok {
			return b
		}
	case float64:
		return big.NewInt(int64(x))
	}
	panic(fmt.Sprintf("cannot convert %v (%T) to *big.Int", v, v))
}
