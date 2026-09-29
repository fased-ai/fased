package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"os"
	"path/filepath"
	"testing"
)

type wenReadRPCFake struct {
	t         *testing.T
	genesis   solana.Hash
	page      *rpc.GetMultipleAccountsResult
	addresses []solana.PublicKey
	calls     int
	change    string
}

func (f *wenReadRPCFake) GetGenesisHash(context.Context) (solana.Hash, error) {
	f.calls++
	if f.change == "genesis" || f.change == "genesis-change" && f.calls > 1 {
		return solana.Hash{}, nil
	}
	return f.genesis, nil
}
func (f *wenReadRPCFake) GetSlot(_ context.Context, c rpc.CommitmentType) (uint64, error) {
	if c != rpc.CommitmentFinalized {
		f.t.Fatal("unfinalized reference")
	}
	switch f.change {
	case "reference-error":
		return 0, errors.New("RPC unavailable")
	case "stale":
		return 156, nil
	case "reference-behind":
		return 149, nil
	case "reference-expired":
		return 200, nil
	}
	return 151, nil
}
func (f *wenReadRPCFake) GetMultipleAccountsWithOpts(_ context.Context, keys []solana.PublicKey, o *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	if o.Commitment != rpc.CommitmentFinalized || o.Encoding != solana.EncodingBase64 || o.MinContextSlot == nil || *o.MinContextSlot != 100 || len(keys) != len(f.addresses) {
		f.t.Fatal("unbounded or unfinalized request")
	}
	for i, k := range keys {
		if k != f.addresses[i] {
			f.t.Fatalf("unexpected key %d", i)
		}
	}
	if f.change == "rpc-error" {
		return nil, errors.New("RPC unavailable")
	}
	if f.change == "nil-page" {
		return nil, nil
	}
	return f.page, nil
}

func wenRPCFixture(t *testing.T) (string, signerWENBTCPinsV1, signerWENBTCIntentV1, solana.PublicKey, *wenReadRPCFake) {
	t.Helper()
	root, pins, intent, wallet, f := wenArtifactCase(t)
	offer, _ := base64.StdEncoding.DecodeString(f.OfferBase64)
	for i, v := range []uint64{200000, 210000, 220000} {
		binary.LittleEndian.PutUint64(offer[328+(14+i)*8:], v)
	}
	pins.OfferSHA256 = wenHashV1(offer)
	intent.OfferSHA256 = pins.OfferSHA256
	if err := os.WriteFile(filepath.Join(root, pins.OfferSHA256), offer, 0600); err != nil {
		t.Fatal(err)
	}
	code := []byte{1, 2, 3}
	pins.CodeSHA256 = wenHashV1(code)
	raw, _ := base64.StdEncoding.DecodeString(f.DescriptorBase64)
	var envelope map[string]json.RawMessage
	json.Unmarshal(raw, &envelope)
	var deployment map[string]any
	json.Unmarshal(envelope["deployment"], &deployment)
	deployment["btcSubscription"].(map[string]any)["deployedBytesHash"] = pins.CodeSHA256
	envelope["deployment"], _ = json.Marshal(deployment)
	candidate, _ := json.Marshal(envelope)
	var payload map[string]any
	dec := json.NewDecoder(bytes.NewReader(candidate))
	dec.UseNumber()
	dec.Decode(&payload)
	delete(payload, "descriptorDigest")
	canonical, _ := wenJSONV1(payload)
	envelope["descriptorDigest"], _ = json.Marshal("sha256:" + wenHashV1(canonical))
	raw, _ = json.Marshal(envelope)
	pins.DescriptorSHA256 = wenHashV1(raw)
	intent.DescriptorSHA256 = pins.DescriptorSHA256
	if err := os.WriteFile(filepath.Join(root, pins.DescriptorSHA256), raw, 0600); err != nil {
		t.Fatal(err)
	}
	a, err := loadWENBTCAcceptanceV1(root, pins, intent, wallet, 150, 180000)
	if err != nil {
		t.Fatal(err)
	}
	admission := make([]byte, 280)
	copy(admission, []byte("WENBTCA1"))
	admission[8] = 1
	scope := []int{0, 3, 4, 5, 7, 8, 9}
	payloadBytes := []byte("wen-btc-sub-admission-scope-v1")
	for j, i := range scope {
		copy(admission[16+j*32:], a.keys[i][:])
		payloadBytes = append(payloadBytes, a.keys[i][:]...)
	}
	binary.LittleEndian.PutUint64(admission[248:], 172800)
	binary.LittleEndian.PutUint64(admission[256:], 200001)
	payloadBytes = append(payloadBytes, admission[256:264]...)
	digest := sha256.Sum256(payloadBytes)
	adm, bump, _ := solana.FindProgramAddress([][]byte{[]byte("wen-btc-sub-admission-v1"), digest[:]}, a.program)
	admission[11] = bump
	pins.AdmissionAccount = adm.String()
	a.admission = adm
	_, roles, err := a.acceptanceInstruction(180000)
	if err != nil {
		t.Fatal(err)
	}
	keys := make([]solana.PublicKey, 0, 30)
	for _, role := range roles {
		keys = append(keys, solana.MustPublicKeyFromBase58(role.Pubkey))
	}
	loader := solana.MustPublicKeyFromBase58("BPFLoaderUpgradeab1e11111111111111111111111")
	pd, _, _ := solana.FindProgramAddress([][]byte{a.program[:]}, loader)
	keys = append(keys, a.program, pd, solana.SysVarClockPubkey)
	page := &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 150}}, Value: make([]*rpc.Account, 30)}
	set := func(i int, owner solana.PublicKey, data []byte, exec bool) {
		page.Value[i] = &rpc.Account{Owner: owner, Executable: exec, Data: rpc.DataBytesOrJSONFromBytes(data)}
	}
	source := make([]byte, 165)
	copy(source, a.keys[3][:])
	copy(source[32:], wallet[:])
	binary.LittleEndian.PutUint64(source[64:], a.numbers[4])
	source[108] = 1
	set(1, solana.TokenProgramID, source, false)
	set(26, a.program, admission, false)
	program := make([]byte, 36)
	binary.LittleEndian.PutUint32(program, 2)
	copy(program[4:], pd[:])
	set(27, loader, program, true)
	data := make([]byte, 48)
	binary.LittleEndian.PutUint32(data, 3)
	binary.LittleEndian.PutUint64(data[4:], 1)
	copy(data[45:], code)
	set(28, loader, data, false)
	clock := make([]byte, 40)
	binary.LittleEndian.PutUint64(clock, 150)
	binary.LittleEndian.PutUint64(clock[32:], 180000)
	set(29, solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111"), clock, false)
	genesis, err := solana.HashFromBase58(pins.Genesis)
	if err != nil {
		t.Fatal(err)
	}
	return root, pins, intent, wallet, &wenReadRPCFake{t: t, genesis: genesis, page: page, addresses: keys}
}

func TestWENBTCFinalizedAcceptanceReader(t *testing.T) {
	for _, name := range []string{"valid", "genesis", "genesis-change", "rpc-error", "nil-page", "short-page", "old-slot", "expired-slot", "clock-owner", "clock-missing", "clock-slot", "negative-time", "expired-offer", "epoch-change", "source", "code", "accepted-record", "accepted-receipt", "accepted-custody", "admission-missing", "admission-scope", "admission-ready", "admission-overflow", "admission-padding", "reference-error", "stale", "reference-behind", "reference-expired"} {
		t.Run(name, func(t *testing.T) {
			root, pins, intent, wallet, f := wenRPCFixture(t)
			f.change = name
			mutate := func(i int, fn func([]byte)) {
				d := append([]byte(nil), f.page.Value[i].Data.GetBinary()...)
				fn(d)
				f.page.Value[i].Data = rpc.DataBytesOrJSONFromBytes(d)
			}
			switch name {
			case "short-page":
				f.page.Value = f.page.Value[:29]
			case "old-slot":
				f.page.Context.Slot = 99
			case "expired-slot":
				f.page.Context.Slot = 200
			case "clock-owner":
				f.page.Value[29].Owner = wallet
			case "clock-missing":
				f.page.Value[29] = nil
			case "clock-slot":
				mutate(29, func(d []byte) { d[0]++ })
			case "negative-time":
				mutate(29, func(d []byte) { d[39] = 128 })
			case "expired-offer":
				mutate(29, func(d []byte) { binary.LittleEndian.PutUint64(d[32:], 200000) })
			case "epoch-change":
				mutate(29, func(d []byte) { binary.LittleEndian.PutUint64(d[32:], 172799) })
			case "source":
				mutate(1, func(d []byte) { d[0] ^= 1 })
			case "code":
				mutate(28, func(d []byte) { d[45] ^= 1 })
			case "accepted-record":
				f.page.Value[5] = f.page.Value[26]
			case "accepted-receipt":
				f.page.Value[9] = f.page.Value[26]
			case "accepted-custody":
				f.page.Value[16] = f.page.Value[26]
			case "admission-missing":
				f.page.Value[26] = nil
			case "admission-scope":
				mutate(26, func(d []byte) { d[16] ^= 1 })
			case "admission-ready":
				mutate(26, func(d []byte) {
					binary.LittleEndian.PutUint64(d[240:], 10000)
					binary.LittleEndian.PutUint64(d[248:], 182800)
				})
			case "admission-overflow":
				mutate(26, func(d []byte) { binary.LittleEndian.PutUint64(d[240:], ^uint64(0)) })
			case "admission-padding":
				mutate(26, func(d []byte) { d[279] = 1 })
			}
			out, err := readWENBTCAcceptanceRPCV1(context.Background(), f, root, pins, intent, wallet, 180000, 5)
			if name == "valid" {
				if err != nil {
					t.Fatal(err)
				}
				if out.Slot != 150 || out.ReferenceSlot != 151 || out.Now != 180000 || len(out.Data) != 569 || len(out.Accounts) != 27 || f.calls != 2 {
					t.Fatal("incomplete result")
				}
			} else if err == nil {
				t.Fatal("invalid readback accepted")
			}
		})
	}
}
