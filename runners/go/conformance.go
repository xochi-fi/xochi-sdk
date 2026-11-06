// Package conformance is the Go conformance runner for the Riddler protocol. It
// reproduces the digest, signature, and signed_object of every vector in
// @xochi/spec conformance/conformance.json byte-for-byte (SPEC.md §2/§8).
// Network-free.
package conformance

import (
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// SignResult is the runner contract: sign(vector) -> {digest, signature, signed_object}.
type SignResult struct {
	Digest       string
	Signature    string
	SignedObject *string // nil for xochi (off-chain intent)
}

// EIP-712 type lists for the two on-chain-verified methods, byte-for-byte aligned
// with @xochi/signer (signing.ts). xochi carries its own types in the vector.
var erc3009Types = apitypes.Types{
	"ReceiveWithAuthorization": {
		{Name: "from", Type: "address"},
		{Name: "to", Type: "address"},
		{Name: "value", Type: "uint256"},
		{Name: "validAfter", Type: "uint256"},
		{Name: "validBefore", Type: "uint256"},
		{Name: "nonce", Type: "bytes32"},
	},
}

var permit2Types = apitypes.Types{
	"PermitWitnessTransferFrom": {
		{Name: "permitted", Type: "TokenPermissions"},
		{Name: "spender", Type: "address"},
		{Name: "nonce", Type: "uint256"},
		{Name: "deadline", Type: "uint256"},
		{Name: "witness", Type: "OriginPullWitness"},
	},
	"TokenPermissions": {
		{Name: "token", Type: "address"},
		{Name: "amount", Type: "uint256"},
	},
	"OriginPullWitness": {{Name: "orderId", Type: "bytes32"}},
}

// domainType builds the EIP712Domain type list from the fields PRESENT in the
// domain, in canonical EIP-712 order. This is essential: erc3009 has
// name/version/chainId/verifyingContract, permit2 omits version, xochi omits
// verifyingContract and adds salt -- the domain typehash must match exactly.
func domainType(domain map[string]any) []apitypes.Type {
	order := []struct{ key, typ string }{
		{"name", "string"},
		{"version", "string"},
		{"chainId", "uint256"},
		{"verifyingContract", "address"},
		{"salt", "bytes32"},
	}
	var out []apitypes.Type
	for _, f := range order {
		if _, ok := domain[f.key]; ok {
			out = append(out, apitypes.Type{Name: f.key, Type: f.typ})
		}
	}
	return out
}

func buildDomain(domain map[string]any) (apitypes.TypedDataDomain, error) {
	d := apitypes.TypedDataDomain{}
	if v, ok := domain["name"]; ok {
		d.Name = toStr(v)
	}
	if v, ok := domain["version"]; ok {
		d.Version = toStr(v)
	}
	if v, ok := domain["chainId"]; ok {
		chainID, err := toBig(v)
		if err != nil {
			return d, fmt.Errorf("domain chainId: %w", err)
		}
		d.ChainId = (*math.HexOrDecimal256)(chainID)
	}
	if v, ok := domain["verifyingContract"]; ok {
		d.VerifyingContract = toStr(v)
	}
	if v, ok := domain["salt"]; ok {
		d.Salt = toStr(v)
	}
	return d, nil
}

// rootType is the primary type: the one no other type references as a field.
func rootType(types apitypes.Types) (string, error) {
	referenced := map[string]bool{}
	for _, fields := range types {
		for _, f := range fields {
			referenced[strings.TrimSuffix(f.Type, "[]")] = true
		}
	}
	var roots []string
	for name := range types {
		if name == "EIP712Domain" {
			continue
		}
		if !referenced[name] {
			roots = append(roots, name)
		}
	}
	if len(roots) != 1 {
		return "", fmt.Errorf("expected exactly one root type, found %v", roots)
	}
	return roots[0], nil
}

// coerceMessage converts JSON values into the Go types apitypes expects, walking
// the type list: uintN/intN -> *big.Int, bytesN -> []byte, nested struct ->
// recursed map, address/string -> string.
func coerceMessage(message map[string]any, types apitypes.Types, primary string) (apitypes.TypedDataMessage, error) {
	out := apitypes.TypedDataMessage{}
	for _, field := range types[primary] {
		v := message[field.Name]
		switch {
		case isStructType(types, field.Type):
			nested, err := coerceMessage(v.(map[string]any), types, field.Type)
			if err != nil {
				return nil, err
			}
			out[field.Name] = nested
		case strings.HasPrefix(field.Type, "uint") || strings.HasPrefix(field.Type, "int"):
			n, err := toBig(v)
			if err != nil {
				return nil, fmt.Errorf("%s.%s: %w", primary, field.Name, err)
			}
			out[field.Name] = n
		case strings.HasPrefix(field.Type, "bytes"):
			out[field.Name] = mustHexBytes(toStr(v))
		default: // address, string
			out[field.Name] = toStr(v)
		}
	}
	return out, nil
}

func isStructType(types apitypes.Types, typ string) bool {
	_, ok := types[strings.TrimSuffix(typ, "[]")]
	return ok
}

func eip712Digest(domain map[string]any, primaryTypes apitypes.Types, primary string, message map[string]any) ([]byte, error) {
	allTypes := apitypes.Types{"EIP712Domain": domainType(domain)}
	for k, v := range primaryTypes {
		allTypes[k] = v
	}
	d, err := buildDomain(domain)
	if err != nil {
		return nil, err
	}
	m, err := coerceMessage(message, allTypes, primary)
	if err != nil {
		return nil, err
	}
	td := apitypes.TypedData{
		Types:       allTypes,
		PrimaryType: primary,
		Domain:      d,
		Message:     m,
	}
	digest, _, err := apitypes.TypedDataAndHash(td)
	return digest, err
}

func signDigest(privKeyHex string, digest []byte) (string, error) {
	priv, err := crypto.HexToECDSA(strings.TrimPrefix(privKeyHex, "0x"))
	if err != nil {
		return "", err
	}
	sig, err := crypto.Sign(digest, priv)
	if err != nil {
		return "", err
	}
	sig[64] += 27 // normalize recovery id {0,1} -> {27,28}
	return hexutil.Encode(sig), nil
}

// Sign reproduces a vector's {digest, signature, signed_object}.
func Sign(v Vector) (SignResult, error) {
	switch v.Protocol {
	case "erc3009":
		digest, err := eip712Digest(v.Domain, erc3009Types, "ReceiveWithAuthorization", v.Message)
		if err != nil {
			return SignResult{}, err
		}
		sig, err := signDigest(v.PrivateKey, digest)
		if err != nil {
			return SignResult{}, err
		}
		so, err := signedObjectERC3009(v.Message)
		if err != nil {
			return SignResult{}, err
		}
		return SignResult{Digest: hexutil.Encode(digest), Signature: sig, SignedObject: &so}, nil

	case "permit2":
		digest, err := eip712Digest(v.Domain, permit2Types, "PermitWitnessTransferFrom", v.Message)
		if err != nil {
			return SignResult{}, err
		}
		sig, err := signDigest(v.PrivateKey, digest)
		if err != nil {
			return SignResult{}, err
		}
		so, err := signedObjectPermit2(v.Message)
		if err != nil {
			return SignResult{}, err
		}
		return SignResult{Digest: hexutil.Encode(digest), Signature: sig, SignedObject: &so}, nil

	case "xochi":
		types := toApiTypes(v.Eip712.Types)
		primary, err := rootType(types)
		if err != nil {
			return SignResult{}, err
		}
		digest, err := eip712Digest(v.Eip712.Domain, types, primary, v.Eip712.Message)
		if err != nil {
			return SignResult{}, err
		}
		sig, err := signDigest(v.PrivateKey, digest)
		if err != nil {
			return SignResult{}, err
		}
		return SignResult{Digest: hexutil.Encode(digest), Signature: sig, SignedObject: nil}, nil
	}
	return SignResult{}, fmt.Errorf("unknown protocol: %s", v.Protocol)
}

// Recover returns the signer address from a digest + signature.
func Recover(digest, signature string) (string, error) {
	d, err := hexutil.Decode(digest)
	if err != nil {
		return "", err
	}
	sig, err := hexutil.Decode(signature)
	if err != nil {
		return "", err
	}
	norm := make([]byte, 65)
	copy(norm, sig)
	if norm[64] >= 27 {
		norm[64] -= 27
	}
	pub, err := crypto.SigToPub(d, norm)
	if err != nil {
		return "", err
	}
	return crypto.PubkeyToAddress(*pub).Hex(), nil
}

var (
	addrTy, _  = abi.NewType("address", "", nil)
	uint256, _ = abi.NewType("uint256", "", nil)
	bytes32, _ = abi.NewType("bytes32", "", nil)
)

func signedObjectERC3009(m map[string]any) (string, error) {
	nonce, err := toBytes32(toStr(m["nonce"]))
	if err != nil {
		return "", err
	}
	ints, err := toBigs(m["value"], m["validAfter"], m["validBefore"])
	if err != nil {
		return "", err
	}
	args := abi.Arguments{{Type: addrTy}, {Type: addrTy}, {Type: uint256}, {Type: uint256}, {Type: uint256}, {Type: bytes32}}
	packed, err := args.Pack(
		common.HexToAddress(toStr(m["from"])),
		common.HexToAddress(toStr(m["to"])),
		ints[0],
		ints[1],
		ints[2],
		nonce,
	)
	if err != nil {
		return "", err
	}
	return hexutil.Encode(packed), nil
}

func signedObjectPermit2(m map[string]any) (string, error) {
	permitted := m["permitted"].(map[string]any)
	ints, err := toBigs(permitted["amount"], m["nonce"], m["deadline"])
	if err != nil {
		return "", err
	}
	args := abi.Arguments{{Type: addrTy}, {Type: uint256}, {Type: addrTy}, {Type: uint256}, {Type: uint256}}
	packed, err := args.Pack(
		common.HexToAddress(toStr(permitted["token"])),
		ints[0],
		common.HexToAddress(toStr(m["spender"])),
		ints[1],
		ints[2],
	)
	if err != nil {
		return "", err
	}
	return hexutil.Encode(packed), nil
}

func toBigs(vs ...any) ([]*big.Int, error) {
	out := make([]*big.Int, len(vs))
	for i, v := range vs {
		n, err := toBig(v)
		if err != nil {
			return nil, err
		}
		out[i] = n
	}
	return out, nil
}

func toApiTypes(t map[string][]TypeField) apitypes.Types {
	out := apitypes.Types{}
	for name, fields := range t {
		var conv []apitypes.Type
		for _, f := range fields {
			conv = append(conv, apitypes.Type{Name: f.Name, Type: f.Type})
		}
		out[name] = conv
	}
	return out
}

func mustHexBytes(s string) []byte {
	b, err := hexutil.Decode(s)
	if err != nil {
		panic(err)
	}
	return b
}

// toBytes32 fails loud on a non-32-byte value. The reference signer (@xochi/
// signer signing.ts) LEFT-pads a short nonce; a naive right-pad here would
// silently diverge (produce a different signed_object) on non-canonical input --
// invisible to the fixture, which always uses full 32-byte nonces. Reject rather
// than guess. (Conformance runner: not a production signer -- see README.)
func toBytes32(s string) ([32]byte, error) {
	var out [32]byte
	b, err := hexutil.Decode(s)
	if err != nil {
		return out, err
	}
	if len(b) != 32 {
		return out, fmt.Errorf("bytes32 must be 32 bytes, got %d (%s)", len(b), s)
	}
	copy(out[:], b)
	return out, nil
}
