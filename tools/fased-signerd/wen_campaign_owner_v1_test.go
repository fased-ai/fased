package main

import (
	"context"
	"encoding/binary"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"testing"
)

type campaignReadFake struct {
	*wenReadRPCFake
	accounting       map[solana.PublicKey]*rpc.Account
	accountingReads  int
	accountingChange bool
}

func (c *campaignReadFake) GetMultipleAccountsWithOpts(ctx context.Context, keys []solana.PublicKey, o *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	if len(keys) == len(c.addresses) && keys[0] == c.addresses[0] {
		return c.wenReadRPCFake.GetMultipleAccountsWithOpts(ctx, keys, o)
	}
	if o.Commitment != rpc.CommitmentFinalized || o.Encoding != solana.EncodingBase64 || o.MinContextSlot == nil || c.accounting == nil {
		c.t.Fatal("unbounded campaign accounting fixture")
	}
	c.accountingReads++
	out := &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: *o.MinContextSlot}}, Value: make([]*rpc.Account, len(keys))}
	for i, k := range keys {
		if a := c.accounting[k]; a != nil {
			copy := *a
			if c.accountingChange && c.accountingReads == 3 && i == 0 {
				copy.Lamports++
			}
			out.Value[i] = &copy
		}
	}
	return out, nil
}

func (c *campaignReadFake) GetMinimumBalanceForRentExemption(_ context.Context, n uint64, k rpc.CommitmentType) (uint64, error) {
	if n != 256 || k != rpc.CommitmentFinalized {
		c.t.Fatal("wrong rent read")
	}
	if c.change == "rent" {
		return 0, errors.New("rent unavailable")
	}
	return 100, nil
}
func (c *campaignReadFake) GetSlot(_ context.Context, k rpc.CommitmentType) (uint64, error) {
	if k != rpc.CommitmentFinalized {
		c.t.Fatal("wrong commitment")
	}
	if c.change == "stale" {
		return 140, nil
	}
	return 111, nil
}
func TestWENCampaignOwnerReadV1(t *testing.T) {
	for _, mode := range []string{"ok", "genesis", "genesis-change", "stale", "missing", "code", "clock", "owner", "position", "rent", "amount", "accounting-missing", "accounting-change"} {
		t.Run(mode, func(t *testing.T) {
			key := func(n byte) (k solana.PublicKey) {
				for i := range k {
					k[i] = n
				}
				return
			}
			program, issuer, wallet := key(2), key(5), key(4)
			economy := campaignAccountingTestSale(program, issuer)
			mint, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-sat-mint-v1"), economy[:]}, program)
			window := campaignAccountingTestWindow(program, issuer, mint)
			position, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-retail-position-v2"), wallet[:], mint[:]}, program)
			action := wenCampaignOwnerActionV1{Operation: "withdraw", Program: program, Economy: economy, Position: position, Amount: 1000}
			data := make([]byte, 256)
			copy(data, []byte("WENRPOS2"))
			data[8] = 1
			copy(data[16:], wallet[:])
			copy(data[48:], issuer[:])
			copy(data[80:], mint[:])
			copy(data[192:], window[:])
			loader := solana.BPFLoaderUpgradeableProgramID
			pd, _, _ := solana.FindProgramAddress([][]byte{program[:]}, loader)
			code := []byte{1, 2, 3}
			p := make([]byte, 36)
			binary.LittleEndian.PutUint32(p, 2)
			copy(p[4:], pd[:])
			body := make([]byte, 48)
			binary.LittleEndian.PutUint32(body, 3)
			binary.LittleEndian.PutUint64(body[4:], 50)
			copy(body[45:], code)
			clock := make([]byte, 40)
			binary.LittleEndian.PutUint64(clock, 110)
			binary.LittleEndian.PutUint64(clock[32:], 1000)
			if mode == "code" {
				body[45] ^= 1
			}
			if mode == "clock" {
				clock[0] ^= 1
			}
			if mode == "position" {
				data[16] ^= 1
			}
			if mode == "amount" {
				action.Amount = 1001
			}
			account := func(d []byte, o solana.PublicKey, e bool) *rpc.Account {
				return &rpc.Account{Owner: o, Executable: e, Lamports: 1100, Data: rpc.DataBytesOrJSONFromBytes(d)}
			}
			page := &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 110}}, Value: []*rpc.Account{account(data, program, false), account(p, loader, true), account(body, loader, false), account(clock, solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111"), false)}}
			if mode == "missing" {
				page.Value[0] = nil
			}
			if mode == "owner" {
				page.Value[0].Owner = loader
			}
			genesis := solana.Hash(key(1))
			pins := signerWENBTCPinsV1{ProgramID: program.String(), Genesis: genesis.String(), CodeSHA256: wenHashV1(code), DeploymentSlot: 50}
			c := &campaignReadFake{wenReadRPCFake: &wenReadRPCFake{t: t, genesis: genesis, page: page, addresses: []solana.PublicKey{position, program, pd, solana.SysVarClockPubkey}, change: mode}, accounting: campaignAccountingTestAccounts(t, program, economy, issuer, window, mint), accountingChange: mode == "accounting-change"}
			if mode == "accounting-missing" {
				delete(c.accounting, economy)
			}
			result, err := readWENCampaignOwnerV1(context.Background(), c, pins, action, wallet, 100, 132, 2)
			if (err == nil) != (mode == "ok") {
				t.Fatal("unexpected campaign read", err)
			}
			if err == nil {
				action.Operation = "top-up"
				action.Amount = 1000
				for _, failure := range []string{"ok", "fee", "balance", "expired", "expires-during", "changed", "accounting-changed", "units", "simulation"} {
					mock := &campaignPrepareFake{campaignReadFake: c, next: 109, mode: failure}
					prepared, e := prepareWENCampaignOwnerV1(context.Background(), mock, pins, action, wallet, 100, 132, 32, 5000, nil)
					if (e == nil) != (failure == "ok") {
						t.Fatalf("prepare %s: %v", failure, e)
					}
					if e == nil {
						again := &campaignPrepareFake{campaignReadFake: c, next: 117, mode: "ok"}
						if _, e = prepareWENCampaignOwnerV1(context.Background(), again, pins, action, wallet, 100, 132, 32, 5000, prepared); e != nil {
							t.Fatal("revalidation", e)
						}
						altered := *prepared
						altered.message = append([]byte(nil), prepared.message...)
						altered.message[0] ^= 1
						if _, e = prepareWENCampaignOwnerV1(context.Background(), &campaignPrepareFake{campaignReadFake: c, next: 117}, pins, action, wallet, 100, 132, 32, 5000, &altered); e == nil {
							t.Fatal("altered approved message")
						}
					}
				}

				for _, op := range []string{"stop", "top-up", "withdraw"} {
					action.Operation = op
					action.Amount = 1000
					if op == "stop" {
						action.Amount = 0
					}
					ix, e := buildWENCampaignOwnerV1(action, wallet, result)
					if e != nil {
						t.Fatal(e)
					}
					tx, e := solana.NewTransaction([]solana.Instruction{ix}, genesis, solana.TransactionPayer(wallet))
					if e != nil {
						t.Fatal(e)
					}
					tx.Message.SetVersion(solana.MessageVersionV0)
					message, _ := tx.Message.MarshalBinary()
					if e := verifyWENCampaignOwnerMessageV1(action, wallet, result, genesis, 1, 2, message); e != nil {
						t.Fatal(e)
					}
					if e := verifyWENCampaignOwnerMessageV1(action, wallet, result, genesis, 2, 2, message); e == nil {
						t.Fatal("expired lifetime accepted")
					}
					for _, i := range []int{0, len(message) / 2, len(message) - 1} {
						bad := append([]byte(nil), message...)
						bad[i] ^= 1
						if e := verifyWENCampaignOwnerMessageV1(action, wallet, result, genesis, 1, 2, bad); e == nil {
							t.Fatal("changed message accepted")
						}
					}
					bytes, _ := ix.Data()
					want := map[string]byte{"stop": 139, "top-up": 143, "withdraw": 138}[op]
					if bytes[0] != want || !ix.Accounts()[0].IsSigner || !ix.Accounts()[1].IsWritable {
						t.Fatal("wrong instruction")
					}
				}
			}
		})
	}
}
