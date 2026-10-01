package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"testing"
)

func testSignerPrivateKeyV2(t *testing.T) solana.PrivateKey {
	t.Helper()
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate signer key: %v", err)
	}
	return solana.PrivateKey(privateKey)
}
func splTokenTestAccountV2(mint, owner solana.PublicKey, amount uint64) *rpc.Account {
	data := make([]byte, 165)
	copy(data[0:32], mint[:])
	copy(data[32:64], owner[:])
	binary.LittleEndian.PutUint64(data[64:72], amount)
	data[108] = 1
	return &rpc.Account{Owner: solana.TokenProgramID, Data: rpc.DataBytesOrJSONFromBytes(data)}
}
