package main

import (
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
)

type wenMiningPreimageScopeV1 struct {
	Genesis string `json:"genesis"`
	Program string `json:"program"`
	Economy string `json:"economy"`
	Offer   string `json:"offer"`
	Owner   string `json:"owner"`
	Vault   string `json:"vault"`
	Nonce   string `json:"nonce"`
	Capital string `json:"capital"`
	Open    string `json:"open"`
}
type wenMiningPreimageV1 struct {
	Schema     string                   `json:"schema"`
	Scope      wenMiningPreimageScopeV1 `json:"scope"`
	Allocation []uint16                 `json:"allocation"`
	Salt       string                   `json:"salt"`
	Digest     string                   `json:"digest"`
}

func wenMiningPreimageKeyV1(v signerWENMiningIntentV1, wallet solana.PublicKey) string {
	b, _ := json.Marshal(struct {
		Genesis string `json:"genesis"`
		Program string `json:"program"`
		Offer   string `json:"offer"`
		Owner   string `json:"owner"`
		Nonce   string `json:"nonce"`
	}{v.Genesis, v.ProgramID, v.Offer, wallet.String(), v.Nonce})
	return wenHashV1(b)
}

// Signer-owned configured directory, never a path from an execution request.
// Reads the portable immutable record; caller must zero returned reveal bytes.
func loadWENMiningPreimageV1(root string, v signerWENMiningIntentV1, wallet solana.PublicKey) ([]byte, error) {
	bad := errors.New("protected mining preimage unavailable or invalid")
	if validateWENMiningIntentV1(v) != nil || wallet.IsZero() || !filepath.IsAbs(root) || filepath.Clean(root) != root || root == "/" {
		return nil, bad
	}
	info, e := os.Lstat(root)
	if e != nil {
		return nil, bad
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 || !ok || stat.Uid != uint32(os.Geteuid()) {
		return nil, bad
	}
	fd, e := syscall.Open(filepath.Join(root, wenMiningPreimageKeyV1(v, wallet)+".json"), syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if e != nil {
		return nil, bad
	}
	f := os.NewFile(uintptr(fd), "mining-preimage")
	defer f.Close()
	info, e = f.Stat()
	if e != nil {
		return nil, bad
	}
	stat, ok = info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || !ok || stat.Uid != uint32(os.Geteuid()) || info.Size() <= 0 || info.Size() > 4096 {
		return nil, bad
	}
	raw, e := io.ReadAll(io.LimitReader(f, 4097))
	if e != nil {
		return nil, bad
	}
	defer zeroBytes(raw)
	if len(raw) > 4096 {
		return nil, bad
	}
	return validateWENMiningPreimageV1(raw, v, wallet)
}
func validateWENMiningPreimageV1(raw []byte, v signerWENMiningIntentV1, wallet solana.PublicKey) ([]byte, error) {
	bad := errors.New("protected mining preimage unavailable or invalid")
	if len(raw) == 0 || len(raw) > 4096 || validateWENMiningIntentV1(v) != nil || wallet.IsZero() {
		return nil, bad
	}
	var r wenMiningPreimageV1
	if decodeStrictJSONV2(raw, &r) != nil {
		return nil, bad
	}
	expected := wenMiningPreimageScopeV1{v.Genesis, v.ProgramID, v.Economy, v.Offer, wallet.String(), v.CapitalVault, v.Nonce, v.Capital, v.Open}
	if r.Schema != "wen.mining-preimage.v1" || r.Scope != expected || r.Digest != v.CommitmentSHA256 || !wenReservationHashV1(r.Salt) || len(r.Allocation) != 4 {
		return nil, bad
	}
	salt, e := hex.DecodeString(r.Salt)
	if e != nil {
		return nil, bad
	}
	defer zeroBytes(salt)
	material := make([]byte, 40)
	total := uint32(0)
	for i, n := range r.Allocation {
		total += uint32(n)
		binary.LittleEndian.PutUint16(material[i*2:], n)
	}
	if total != 10000 {
		return nil, bad
	}
	copy(material[8:], salt)
	proof := []byte("wen-mining-commitment-v1")
	for _, k := range []string{v.ProgramID, v.Economy, v.Offer, wallet.String(), v.CapitalVault} {
		key := solana.MustPublicKeyFromBase58(k)
		proof = append(proof, key[:]...)
	}
	for _, n := range []string{v.Nonce, v.Capital} {
		value, _ := strconv.ParseUint(n, 10, 64)
		b := make([]byte, 8)
		binary.LittleEndian.PutUint64(b, value)
		proof = append(proof, b...)
	}
	proof = append(proof, material...)
	defer zeroBytes(proof)
	if wenHashV1(proof) != r.Digest {
		zeroBytes(material)
		return nil, bad
	}
	return material, nil
}
