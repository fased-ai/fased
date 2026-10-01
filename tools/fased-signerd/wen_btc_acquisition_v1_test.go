package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func wenAcquisitionFixture(t *testing.T) (signerWENBTCArtifactsV1, solana.PublicKey, signerWENBTCRouteV1, []byte, []signerTypedAccountV2) {
	t.Helper()
	raw, err := os.ReadFile("testdata/wen-btc-source-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Vectors []struct {
			Opcode     int
			ProgramID  string
			DataBase64 string
			Keys       []signerTypedAccountV2
		}
	}
	if err = json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	for _, v := range f.Vectors {
		if v.Opcode != 112 {
			continue
		}
		d, err := base64.StdEncoding.DecodeString(v.DataBase64)
		if err != nil {
			t.Fatal(err)
		}
		var a signerWENBTCArtifactsV1
		a.program = solana.MustPublicKeyFromBase58(v.ProgramID)
		copy(a.offer[:], d[1:465])
		for i := range a.keys {
			copy(a.keys[i][:], a.offer[8+32*i:40+32*i])
		}
		for i := range a.numbers {
			a.numbers[i] = binary.LittleEndian.Uint64(a.offer[328+8*i:])
		}
		n := int(d[465])
		route := signerWENBTCRouteV1{Program: solana.MustPublicKeyFromBase58(v.Keys[len(v.Keys)-1].Pubkey), Data: append([]byte(nil), d[466+n:]...), Accounts: append([]signerTypedAccountV2(nil), v.Keys[8:8+n]...)}
		for i := range route.Accounts {
			route.Accounts[i].IsSigner = d[466+i]&1 != 0
			route.Accounts[i].IsWritable = d[466+i]&2 != 0
		}
		return a, solana.MustPublicKeyFromBase58(v.Keys[0].Pubkey), route, d, v.Keys
	}
	t.Fatal("missing acquisition vector")
	return signerWENBTCArtifactsV1{}, solana.PublicKey{}, signerWENBTCRouteV1{}, nil, nil
}

func TestWENBTCAcquisitionMatchesRust(t *testing.T) {
	a, payer, r, data, keys := wenAcquisitionFixture(t)
	got, k, err := a.acquisitionInstruction(payer, r, 100)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, data) || !reflect.DeepEqual(k, keys) {
		t.Fatal("canonical Rust acquisition mismatch")
	}
	// Closing acceptance does not close the already-funded conversion window.
	if _, _, err = a.acquisitionInstruction(payer, r, a.numbers[14]); err != nil {
		t.Fatal(err)
	}
	if _, _, err = a.acquisitionInstruction(payer, r, a.numbers[15]+1); err == nil {
		t.Fatal("expired conversion accepted")
	}
}
func TestWENBTCAcquisitionRejectsRouteMutation(t *testing.T) {
	for _, name := range []string{"venue", "cash-mint", "asset-mint", "cash-pda", "short", "legs", "graph", "amount", "floor", "slippage", "fee", "signer", "writable", "fixed-key", "pool-alias", "tail-alias", "outer-alias", "program-alias", "too-many"} {
		t.Run(name, func(t *testing.T) {
			a, p, r, _, _ := wenAcquisitionFixture(t)
			at := 13 + 4*int(binary.LittleEndian.Uint32(r.Data[9:13]))
			switch name {
			case "venue":
				r.Program = p
			case "cash-mint":
				a.keys[3] = p
			case "asset-mint":
				a.keys[4] = p
			case "cash-pda":
				a.keys[6] = p
			case "short":
				r.Data = r.Data[:12]
			case "legs":
				r.Data[9] = 4
			case "graph":
				r.Data[13] = 27
			case "amount":
				r.Data[at] ^= 1
			case "floor":
				binary.LittleEndian.PutUint64(r.Data[at+8:], 1)
			case "slippage":
				binary.LittleEndian.PutUint16(r.Data[at+16:], 51)
			case "fee":
				r.Data[at+18] = 1
			case "signer":
				r.Accounts[2].IsSigner = false
			case "writable":
				r.Accounts[3].IsWritable = false
			case "fixed-key":
				r.Accounts[7].Pubkey = p.String()
			case "pool-alias":
				r.Accounts[4].Pubkey = r.Accounts[5].Pubkey
			case "tail-alias":
				r.Accounts[13].Pubkey = r.Accounts[3].Pubkey
			case "outer-alias":
				r.Accounts[13].Pubkey = p.String()
			case "program-alias":
				r.Accounts[13].Pubkey = a.program.String()
			case "too-many":
				for len(r.Accounts) < 65 {
					r.Accounts = append(r.Accounts, r.Accounts[13])
				}
			}
			if _, _, err := a.acquisitionInstruction(p, r, 100); err == nil {
				t.Fatal("invalid route accepted")
			}
		})
	}
}

func wenFundedAccounts(t *testing.T, a signerWENBTCArtifactsV1) (*signerWENBTCAccountV1, *signerWENBTCAccountV1, *signerWENBTCAccountV1, *signerWENBTCAccountV1) {
	t.Helper()
	nonce := make([]byte, 8)
	binary.LittleEndian.PutUint64(nonce, a.numbers[0])
	address, bump, err := solana.FindProgramAddress([][]byte{[]byte("wen-btc-subscription-v1"), a.keys[0][:], a.keys[2][:], nonce}, a.program)
	if err != nil {
		t.Fatal(err)
	}
	d := make([]byte, 192)
	copy(d, []byte("WENBTCS1"))
	d[8] = 1
	d[11] = bump
	copy(d[16:], a.keys[0][:])
	copy(d[48:], a.keys[2][:])
	digest := sha256.Sum256(append([]byte("wen-btc-subscription-offer-v1"), a.offer[8:]...))
	copy(d[80:], digest[:])
	copy(d[112:], nonce)
	binary.LittleEndian.PutUint64(d[120:], 1)
	binary.LittleEndian.PutUint64(d[128:], a.numbers[10])
	binary.LittleEndian.PutUint64(d[136:], a.numbers[12])
	record := &signerWENBTCAccountV1{Address: address, Owner: a.program, Slot: 150, Data: d}
	token := func(key, mint, owner solana.PublicKey, amount uint64) *signerWENBTCAccountV1 {
		d := make([]byte, 165)
		copy(d, mint[:])
		copy(d[32:], owner[:])
		binary.LittleEndian.PutUint64(d[64:], amount)
		d[108] = 1
		return &signerWENBTCAccountV1{Address: key, Owner: solana.TokenProgramID, Slot: 150, Data: d}
	}
	authority, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-activation-v1"), a.keys[0][:]}, a.program)
	return record, token(a.keys[6], a.keys[3], address, a.numbers[10]+a.numbers[12]), token(a.keys[7], a.keys[4], authority, 0), token(a.keys[8], a.keys[3], authority, 0)
}
func TestWENBTCAcquisitionFundedReadback(t *testing.T) {
	for _, name := range []string{"valid", "missing", "owner", "slot", "acquired", "recovered", "changed-offer", "future-accepted", "late-accepted", "spent", "padding", "cash-short", "cash-authority", "reserve-mint", "working-authority", "expired"} {
		t.Run(name, func(t *testing.T) {
			a, _, _, _, _ := wenAcquisitionFixture(t)
			r, c, b, w := wenFundedAccounts(t, a)
			now := uint64(100)
			switch name {
			case "missing":
				r = nil
			case "owner":
				r.Owner = c.Owner
			case "slot":
				r.Slot++
			case "acquired":
				r.Data[9] = 1
			case "recovered":
				r.Data[9] = 2
			case "changed-offer":
				r.Data[80] ^= 1
			case "future-accepted":
				now = 0
			case "late-accepted":
				binary.LittleEndian.PutUint64(r.Data[120:], a.numbers[14])
			case "spent":
				r.Data[144] = 1
			case "padding":
				r.Data[191] = 1
			case "cash-short":
				binary.LittleEndian.PutUint64(c.Data[64:], a.numbers[10]+a.numbers[12]-1)
			case "cash-authority":
				c.Data[32] ^= 1
			case "reserve-mint":
				b.Data[0] ^= 1
			case "working-authority":
				w.Data[32] ^= 1
			case "expired":
				now = a.numbers[15] + 1
			}
			err := a.verifyAcquisitionAccountsV1(150, now, r, c, b, w)
			if (err == nil) != (name == "valid") {
				t.Fatalf("unexpected result: %v", err)
			}
		})
	}
}

func TestWENBTCFinalizedAcquisitionReader(t *testing.T) {
	for _, name := range []string{"valid", "after-acceptance", "conversion-end", "conversion-expired", "wrong-operation", "genesis-change", "stale", "consumed", "underfunded", "wrong-reserve", "code", "missing-record"} {
		t.Run(name, func(t *testing.T) {
			root, pins, intent, wallet, f := wenRPCFixture(t)
			a, payer, route, _, _ := wenAcquisitionFixture(t)
			if payer != wallet {
				t.Fatal("fixture wallet mismatch")
			}
			for i, v := range []uint64{180001, 190000, 200000} {
				a.numbers[14+i] = v
				binary.LittleEndian.PutUint64(a.offer[328+(14+i)*8:], v)
			}
			pins.OfferSHA256 = wenHashV1(a.offer[:])
			intent.OfferSHA256 = pins.OfferSHA256
			intent.Operation = "acquisition"
			if err := os.WriteFile(filepath.Join(root, pins.OfferSHA256), a.offer[:], 0600); err != nil {
				t.Fatal(err)
			}
			_, roles, err := a.acquisitionInstruction(wallet, route, 180000)
			if err != nil {
				t.Fatal(err)
			}
			keys := []solana.PublicKey{}
			indices := map[solana.PublicKey]int{}
			for _, r := range roles {
				k := solana.MustPublicKeyFromBase58(r.Pubkey)
				if _, ok := indices[k]; !ok {
					indices[k] = len(keys)
					keys = append(keys, k)
				}
			}
			old := f.page.Value
			keys = append(keys, f.addresses[27:]...)
			page := &rpc.GetMultipleAccountsResult{RPCContext: f.page.RPCContext, Value: make([]*rpc.Account, len(keys))}
			copy(page.Value[len(keys)-3:], old[27:])
			record, cash, reserve, working := wenFundedAccounts(t, a)
			for _, account := range []*signerWENBTCAccountV1{record, cash, reserve, working} {
				i, ok := indices[account.Address]
				if !ok {
					t.Fatal("missing role")
				}
				page.Value[i] = &rpc.Account{Owner: account.Owner, Executable: account.Executable, Data: rpc.DataBytesOrJSONFromBytes(account.Data)}
			}
			f.addresses = keys
			f.page = page
			f.change = name
			clock := page.Value[len(keys)-1].Data.GetBinary()
			switch name {
			case "after-acceptance":
				binary.LittleEndian.PutUint64(clock[32:], 180002)
			case "conversion-end":
				binary.LittleEndian.PutUint64(clock[32:], 190000)
			case "conversion-expired":
				binary.LittleEndian.PutUint64(clock[32:], 190001)
			case "wrong-operation":
				intent.Operation = "acceptance"
			case "consumed":
				record.Data[9] = 1
			case "underfunded":
				binary.LittleEndian.PutUint64(cash.Data[64:], a.numbers[10]-1)
			case "wrong-reserve":
				reserve.Data[0] ^= 1
			case "code":
				page.Value[len(keys)-2].Data.GetBinary()[45] ^= 1
			case "missing-record":
				page.Value[indices[record.Address]] = nil
			}
			out, err := readWENBTCSubscriptionRPCV1(context.Background(), f, root, pins, intent, wallet, 180000, 5, &route)
			valid := name == "valid" || name == "after-acceptance" || name == "conversion-end"
			if (err == nil) != valid {
				t.Fatalf("unexpected result: %v", err)
			}
			if valid && (out.Data[0] != 112 || len(out.Accounts) != len(roles) || f.calls != 2) {
				t.Fatal("incomplete acquisition result")
			}
		})
	}
}
