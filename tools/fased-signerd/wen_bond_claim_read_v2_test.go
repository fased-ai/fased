package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

type wenBondRPCFakeV2 struct {
	t                                     *testing.T
	keys                                  []solana.PublicKey
	rows                                  []*rpc.Account
	owner                                 solana.PublicKey
	genesis                               solana.Hash
	min, expiry, slotStart, pageSlot, now uint64
	calls, reads, heights                 int
	mode                                  string
	message                               []byte
}

func (f *wenBondRPCFakeV2) GetGenesisHash(context.Context) (solana.Hash, error) {
	f.calls++
	if f.mode == "genesis" || f.mode == "genesis changed" && f.calls > 1 {
		return solana.Hash{}, nil
	}
	return f.genesis, nil
}
func (f *wenBondRPCFakeV2) GetSlot(_ context.Context, c rpc.CommitmentType) (uint64, error) {
	if c != rpc.CommitmentFinalized {
		f.t.Fatal("unfinalized reference")
	}
	if f.mode == "stale" {
		return f.expiry, nil
	}
	if f.mode == "reference behind" {
		return f.pageSlot - 1, nil
	}
	return f.pageSlot + 1, nil
}
func (f *wenBondRPCFakeV2) GetMultipleAccountsWithOpts(_ context.Context, keys []solana.PublicKey, o *rpc.GetMultipleAccountsOpts) (*rpc.GetMultipleAccountsResult, error) {
	if o.Commitment != rpc.CommitmentFinalized || o.Encoding != solana.EncodingBase64 || o.MinContextSlot == nil || *o.MinContextSlot < f.min || len(keys) != len(f.keys) {
		f.t.Fatal("unbounded Bond read")
	}
	for i, k := range keys {
		if k != f.keys[i] {
			f.t.Fatal("Bond key changed", i)
		}
	}
	f.reads++
	f.pageSlot = *o.MinContextSlot
	if f.pageSlot < f.slotStart {
		f.pageSlot = f.slotStart
	}
	clock := append([]byte(nil), f.rows[13].Data.GetBinary()...)
	binary.LittleEndian.PutUint64(clock, f.pageSlot)
	now := f.now
	if f.mode == "vesting growth" && f.reads > 1 {
		now++
	}
	binary.LittleEndian.PutUint64(clock[32:], now)
	if f.mode == "clock slot" {
		clock[0] ^= 1
	}
	if f.mode == "clock negative" {
		binary.LittleEndian.PutUint64(clock[32:], ^uint64(0))
	}
	f.rows[13].Data = rpc.DataBytesOrJSONFromBytes(clock)
	return &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: f.pageSlot}}, Value: f.rows}, nil
}
func (f *wenBondRPCFakeV2) GetLatestBlockhash(_ context.Context, c rpc.CommitmentType) (*rpc.GetLatestBlockhashResult, error) {
	if c != rpc.CommitmentFinalized {
		f.t.Fatal("commitment")
	}
	if f.mode == "missing hash" {
		return nil, nil
	}
	slot := f.pageSlot + 1
	if f.mode == "stale hash" {
		slot = f.pageSlot - 1
	}
	return &rpc.GetLatestBlockhashResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: slot}}, Value: &rpc.LatestBlockhashResult{Blockhash: solana.Hash{7}, LastValidBlockHeight: 20}}, nil
}
func (f *wenBondRPCFakeV2) GetBlockHeight(_ context.Context, c rpc.CommitmentType) (uint64, error) {
	if c != rpc.CommitmentFinalized {
		f.t.Fatal("commitment")
	}
	f.heights++
	if f.mode == "expired" || f.mode == "expires during" && f.heights > 1 {
		return 20, nil
	}
	if f.mode == "height rollback" && f.heights > 1 {
		return 9, nil
	}
	return 10, nil
}
func (f *wenBondRPCFakeV2) GetFeeForMessage(_ context.Context, m string, c rpc.CommitmentType) (*rpc.GetFeeForMessageResult, error) {
	if c != rpc.CommitmentFinalized {
		f.t.Fatal("commitment")
	}
	var e error
	f.message, e = base64.StdEncoding.DecodeString(m)
	if e != nil {
		f.t.Fatal(e)
	}
	n := uint64(5000)
	if f.mode == "fee cap" {
		n++
	}
	return &rpc.GetFeeForMessageResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: f.pageSlot + 1}}, Value: &n}, nil
}
func (f *wenBondRPCFakeV2) GetBalance(_ context.Context, owner solana.PublicKey, c rpc.CommitmentType) (*rpc.GetBalanceResult, error) {
	if c != rpc.CommitmentFinalized || owner != f.owner {
		f.t.Fatal("balance owner")
	}
	n := uint64(114767240)
	if f.mode == "protected balance" {
		n--
	}
	return &rpc.GetBalanceResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: f.pageSlot + 1}}, Value: n}, nil
}
func (f *wenBondRPCFakeV2) SimulateRawTransactionWithOpts(_ context.Context, wire []byte, o *rpc.SimulateTransactionOpts) (*rpc.SimulateTransactionResponse, error) {
	if o.Commitment != rpc.CommitmentFinalized || o.SigVerify || o.ReplaceRecentBlockhash || len(wire) != 65+len(f.message) || wire[0] != 1 || !bytes.Equal(wire[1:65], make([]byte, 64)) || !bytes.Equal(wire[65:], f.message) {
		f.t.Fatal("simulation changed Bond message")
	}
	if f.mode == "concurrent claim" {
		d := append([]byte(nil), f.rows[1].Data.GetBinary()...)
		binary.LittleEndian.PutUint64(d[256:], 100)
		binary.LittleEndian.PutUint64(d[264:], 97)
		binary.LittleEndian.PutUint64(d[272:], 3)
		f.rows[1].Data = rpc.DataBytesOrJSONFromBytes(d)
	}
	if f.mode == "custody changed" {
		d := append([]byte(nil), f.rows[7].Data.GetBinary()...)
		d[64]++
		f.rows[7].Data = rpc.DataBytesOrJSONFromBytes(d)
	}
	if f.mode == "program changed" {
		d := append([]byte(nil), f.rows[12].Data.GetBinary()...)
		d[47] ^= 1
		f.rows[12].Data = rpc.DataBytesOrJSONFromBytes(d)
	}
	n := uint64(90000)
	if f.mode == "compute cap" {
		n = 200001
	}
	slot := f.pageSlot + 1
	if f.mode == "expired simulation" {
		slot = f.expiry
	}
	result := &rpc.SimulateTransactionResponse{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: slot}}, Value: &rpc.SimulateTransactionResult{UnitsConsumed: &n}}
	if f.mode == "simulation error" {
		result.Value.Err = "program error"
	}
	return result, nil
}
func bondReadFixtureV2(t *testing.T, owners ...solana.PublicKey) (*wenBondRPCFakeV2, wenBondPinsV2, wenBondReadPolicyV2) {
	t.Helper()
	p, _, _, _, _ := bondClaimFixtureV2(t)
	if len(owners) > 0 {
		p.Owner = owners[0]
	}
	creator := solana.PublicKey{8}
	sale, sb, e := wenBondKeyV2(p.Program, "wen-genesis-v1", creator[:], p.Policy[:])
	if e != nil {
		t.Fatal(e)
	}
	p.Sale = sale
	p, q, r, n, now := bondClaimFixtureV2(t, p)
	c, e := inspectWENBondClaimV2(p, q, r, n, now, 1)
	if e != nil {
		t.Fatal(e)
	}
	pr, m, cu, dest := bondClaimFundingFixtureV2(t, p, c)
	keys, e := wenBondClaimReadKeysV2(p, n)
	if e != nil {
		t.Fatal(e)
	}
	account := func(owner solana.PublicKey, data []byte, ex bool) *rpc.Account {
		return &rpc.Account{Owner: owner, Data: rpc.DataBytesOrJSONFromBytes(data), Executable: ex, Lamports: 1}
	}
	token := func(a *signerWENBTCAccountV1) *rpc.Account { return account(a.Owner, a.Data, a.Executable) }
	sd := make([]byte, 200)
	copy(sd, []byte("WENGEN01"))
	copy(sd[8:], []byte{2, 0, 3, sb})
	copy(sd[16:], creator[:])
	copy(sd[48:], p.Policy[:])
	cashMint := solana.MustPublicKeyFromBase58("DE8BhmX7qJGzjUSHnYYEXjAcnr86aVUCNquoyEqYsENc")
	copy(sd[80:], cashMint[:])
	binary.LittleEndian.PutUint64(sd[152:], 604800)
	binary.LittleEndian.PutUint64(sd[160:], 604801)
	binary.LittleEndian.PutUint64(sd[168:], 50000000000)
	binary.LittleEndian.PutUint64(sd[176:], 50000000000)
	binary.LittleEndian.PutUint64(sd[192:], 1)
	_, ab, _ := wenBondKeyV2(p.Program, "wen-activation-v1", p.Sale[:])
	ad := make([]byte, 160)
	copy(ad, []byte("WENACTR1"))
	copy(ad[8:], []byte{1, 0, 1, ab})
	copy(ad[16:], p.Sale[:])
	copy(ad[128:], p.Policy[:])
	binary.LittleEndian.PutUint64(ad[80:], 1)
	scaled := uint64(50000000000) * 100000
	binary.LittleEndian.PutUint64(ad[88:], scaled/2)
	binary.LittleEndian.PutUint64(ad[120:], scaled/2-scaled/3-scaled*40/300-scaled*6/300)
	root, rb, _ := wenBondKeyV2(p.Program, "wen-accounting-domain-v1", p.Sale[:], []byte{2})
	source, _, _ := wenBondKeyV2(p.Program, "wen-bond-owner-v1", p.Sale[:], p.Owner[:])
	_, eb, _ := wenBondKeyV2(p.Program, "wen-accounting-source-v1", root[:], source[:])
	rd := make([]byte, 104)
	copy(rd, []byte("WENDOM01"))
	copy(rd[8:], []byte{1, 0, 2, rb})
	copy(rd[16:], p.Sale[:])
	binary.LittleEndian.PutUint64(rd[48:], 1)
	binary.LittleEndian.PutUint64(rd[56:], 1)
	binary.LittleEndian.PutUint64(rd[64:], 1)
	rd[72] = 1
	ed := make([]byte, 128)
	copy(ed, []byte("WENDS001"))
	copy(ed[8:], []byte{1, 0, 0, eb})
	copy(ed[16:], root[:])
	copy(ed[48:], source[:])
	code := []byte{1, 2, 3}
	program := make([]byte, 36)
	binary.LittleEndian.PutUint32(program, 2)
	copy(program[4:], keys[12][:])
	body := make([]byte, 48)
	binary.LittleEndian.PutUint32(body, 3)
	binary.LittleEndian.PutUint64(body[4:], 90)
	copy(body[45:], code)
	rows := []*rpc.Account{account(p.Program, q.Data, false), account(p.Program, r.Data, false), account(p.Program, sd, false), account(p.Program, ad, false), token(pr), token(m), token(cu), token(dest), account(p.Program, rd, false), account(p.Program, ed, false), account(solana.BPFLoaderUpgradeableProgramID, []byte{1}, true), account(solana.BPFLoaderUpgradeableProgramID, program, true), account(solana.BPFLoaderUpgradeableProgramID, body, false), account(solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111"), make([]byte, 40), false)}
	policy := wenBondReadPolicyV2{Deployment: signerWENBTCPinsV1{ProgramID: p.Program.String(), Genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", CodeSHA256: wenHashV1(code), DeploymentSlot: 90}, Nonce: n, MinimumNet: 1, MinimumSlot: 1000, ExpiresSlot: 1032, MaxSlotLag: 32}
	return &wenBondRPCFakeV2{t: t, keys: keys, rows: rows, owner: p.Owner, genesis: solana.MustHashFromBase58(policy.Deployment.Genesis), min: 1000, expiry: 1032, slotStart: 1000, now: now}, p, policy
}
func TestWENBondClaimV2FinalizedReader(t *testing.T) {
	f, p, policy := bondReadFixtureV2(t)
	s, e := readWENBondClaimV2(context.Background(), f, p, policy)
	if e != nil {
		t.Fatal(e)
	}
	if s.Slot != 1000 || s.ReferenceSlot != 1001 || s.Claim.AvailableNet != 4850000000000 || !wenReservationHashV1(s.StateSHA256) || f.calls != 2 || f.reads != 1 {
		t.Fatal("incomplete read", s)
	}
	for _, mode := range []string{"genesis", "genesis changed", "stale", "reference behind", "clock slot", "clock negative", "missing receipt", "code", "policy", "sale-cash", "cutover", "domain", "entry", "token", "future quote", "funding"} {
		t.Run(mode, func(t *testing.T) {
			f, p, policy := bondReadFixtureV2(t)
			f.mode = mode
			mutate := func(i, at int) {
				d := append([]byte(nil), f.rows[i].Data.GetBinary()...)
				d[at] ^= 1
				f.rows[i].Data = rpc.DataBytesOrJSONFromBytes(d)
			}
			switch mode {
			case "missing receipt":
				f.rows[1] = nil
			case "code":
				mutate(12, 47)
			case "policy":
				p.Policy[0] ^= 1
			case "sale-cash":
				mutate(2, 80)
			case "cutover":
				mutate(2, 192)
			case "domain":
				mutate(8, 72)
			case "entry":
				mutate(9, 80)
			case "token":
				f.rows[10].Executable = false
			case "future quote":
				policy.MinimumSlot = 90
				f.min = 90
				f.slotStart = 90
			case "funding":
				d := append([]byte(nil), f.rows[4].Data.GetBinary()...)
				binary.LittleEndian.PutUint64(d[80:], 4999999999999)
				f.rows[4].Data = rpc.DataBytesOrJSONFromBytes(d)
			}
			if _, e := readWENBondClaimV2(context.Background(), f, p, policy); e == nil {
				t.Fatal("unadmitted read", mode)
			}
		})
	}
}

func TestWENBondClaimV2TrackedFinalizedReader(t *testing.T) {
	f, p, policy := bondReadFixtureV2(t)
	quote := append([]byte(nil), f.rows[0].Data.GetBinary()...)
	quote[10] = 2
	f.rows[0].Data = rpc.DataBytesOrJSONFromBytes(quote)
	receipt := append([]byte(nil), f.rows[1].Data.GetBinary()...)
	h := sha256.Sum256(quote)
	copy(receipt[144:176], h[:])
	f.rows[1].Data = rpc.DataBytesOrJSONFromBytes(receipt)
	s, err := readWENBondClaimV2(context.Background(), f, p, policy)
	if err != nil || s.Claim.AvailableNet != 4850000000000 || s.Claim.QuoteSHA256 != h {
		t.Fatal("tracked Bond finalized read rejected", s, err)
	}
}
func TestWENBondClaimV2CostBoundPreparation(t *testing.T) {
	for _, mode := range []string{"ok", "vesting growth", "missing hash", "stale hash", "fee cap", "protected balance", "simulation error", "compute cap", "expired simulation", "expired", "expires during", "height rollback", "concurrent claim", "custody changed", "program changed"} {
		t.Run(mode, func(t *testing.T) {
			f, p, policy := bondReadFixtureV2(t)
			f.mode = mode
			out, e := prepareWENBondClaimV2(context.Background(), f, p, policy, 5000, 114762240, nil)
			pass := mode == "ok" || mode == "vesting growth"
			if pass != (e == nil) {
				t.Fatal(mode, e)
			}
			if !pass {
				return
			}
			if out.fee != 5000 || out.units != 90000 || f.reads != 2 || !bytes.Equal(out.message, f.message) {
				t.Fatal("missing exact-wire cost proof")
			}
			if e = verifyWENBondClaimMessageV2(out.message, p, out.snapshot.Claim, out.blockhash, out.currentHeight, out.lastValidHeight); e != nil {
				t.Fatal(e)
			}
		})
	}
	f, p, policy := bondReadFixtureV2(t)
	out, e := prepareWENBondClaimV2(context.Background(), f, p, policy, 5000, 114762240, nil)
	if e != nil {
		t.Fatal(e)
	}
	next, _, _ := bondReadFixtureV2(t)
	next.slotStart = 1002
	again, e := prepareWENBondClaimV2(context.Background(), next, p, policy, 5000, 114762240, out)
	if e != nil || !bytes.Equal(out.message, again.message) {
		t.Fatal("message replaced", e)
	}
	altered := *out
	altered.message = append([]byte(nil), out.message...)
	altered.message[5] ^= 1
	next, _, _ = bondReadFixtureV2(t)
	if _, e = prepareWENBondClaimV2(context.Background(), next, p, policy, 5000, 114762240, &altered); e == nil {
		t.Fatal("altered stored wire accepted")
	}
}
