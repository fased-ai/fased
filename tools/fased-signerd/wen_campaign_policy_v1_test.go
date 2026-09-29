package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func configureWENCampaignPolicyFixture(a *wenCampaignOwnerActionV1, s *wenCampaignPositionV1, issuer solana.PublicKey, now uint64) {
	b := make([]byte, 256)
	copy(b, "WENRCMP2")
	b[8] = 1
	copy(b[16:], issuer[:])
	copy(b[48:], s.Data[80:112])
	binary.LittleEndian.PutUint64(b[136:], now)
	window, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-retail-window-v2"), b[16:48], b[48:80], b[112:120]}, a.Program)
	copy(s.Data[48:], issuer[:])
	copy(s.Data[192:], window[:])
	s.Now = now
	s.PolicyWindow = &wenCampaignSetupAccountV1{Address: window, Owner: a.Program, Data: b, Lamports: 1100}
	a.Operation = "policy"
	a.Amount = 0
	a.Policy = &wenCampaignPolicyV1{Window: window, MaxPrice: 2, Daily: 100, Total: 1000, Expiry: now + 2000, MaxWait: 500, Enabled: 1}
}
func TestWENCampaignPolicyV1(t *testing.T) {
	program, issuer, owner := solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey()
	economy := campaignAccountingTestSale(program, issuer)
	mint, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-sat-mint-v1"), economy[:]}, program)
	pos, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-retail-position-v2"), owner[:], mint[:]}, program)
	d := make([]byte, 256)
	copy(d, "WENRPOS2")
	d[8] = 1
	copy(d[16:], owner[:])
	copy(d[80:], mint[:])
	a := wenCampaignOwnerActionV1{Program: program, Economy: economy, Position: pos}
	s := wenCampaignPositionV1{Address: pos, Owner: program, Data: d, Lamports: 1100, Rent: 100}
	configureWENCampaignPolicyFixture(&a, &s, issuer, 1000)
	binary.LittleEndian.PutUint64(s.Data[152:], 200)
	binary.LittleEndian.PutUint64(s.Data[176:], 50)
	ix, e := buildWENCampaignOwnerV1(a, owner, s)
	if e != nil {
		t.Fatal(e)
	}
	for _, flags := range []byte{30, 31, 62, 63} {
		s.PolicyWindow.Data[11] = flags
		if _, e := buildWENCampaignOwnerV1(a, owner, s); e != nil {
			t.Fatalf("protocol-supported campaign flags %d rejected: %v", flags, e)
		}
	}
	s.PolicyWindow.Data[11] = 0
	wire, _ := ix.Data()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", "--input-type=module", "-e", `
import {campaignKeeperFixture} from './client/campaign-keeper-fixture.mjs';
import {buildCampaignOwnerInstruction} from './client/campaign-owner-instruction.mjs';
let text='';for await(const x of process.stdin)text+=x;const {a,s,owner}=JSON.parse(text),{sdk}=await campaignKeeperFixture(),enc=sdk.getAddressEncoder(),hex=k=>Buffer.from(enc.encode(k)).toString('hex');
const account=x=>({address:hex(x.Address),owner:hex(x.Owner),executable:x.Executable,lamports:BigInt(x.Lamports),data:[...Buffer.from(x.Data,'base64')]});
const q=a.Policy,p=Buffer.from(s.Data,'base64');const x=await buildCampaignOwnerInstruction(sdk,{op:160,program:hex(a.Program),owner:hex(owner),issuer:p.subarray(48,80).toString('hex'),mint:p.subarray(80,112).toString('hex'),position:account(s),window:account(s.PolicyWindow),now:BigInt(s.Now),positionRent:BigInt(s.Rent),terms:{maxPrice:BigInt(q.MaxPrice),daily:BigInt(q.Daily),total:BigInt(q.Total),expiry:BigInt(q.Expiry),maxWait:BigInt(q.MaxWait),enabled:BigInt(q.Enabled)}});console.log(JSON.stringify({data:Buffer.from(x.instruction.data).toString('hex'),accounts:x.instruction.accounts}));`)
	cmd.Dir, _ = filepath.Abs("../../../token/sat/wen-genesis")
	raw, _ := json.Marshal(map[string]any{"a": a, "s": s, "owner": owner})
	cmd.Stdin = bytes.NewReader(raw)
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("retail parity: %v %s", e, out)
	}
	var v struct {
		Data     string
		Accounts []struct {
			Address solana.PublicKey
			Role    int
		}
	}
	if e = json.Unmarshal(out, &v); e != nil {
		t.Fatal(e)
	}
	if v.Data != hex.EncodeToString(wire) || len(v.Accounts) != 3 || len(ix.Accounts()) != 8 {
		t.Fatal("policy bytes differ")
	}
	for i, k := range ix.Accounts()[:3] {
		if k.PublicKey != v.Accounts[i].Address || k.IsSigner != (v.Accounts[i].Role&2 != 0) || k.IsWritable != (v.Accounts[i].Role&1 != 0) {
			t.Fatal("policy account differs")
		}
	}
	mutations := map[string]func(*wenCampaignOwnerActionV1, *wenCampaignPositionV1){
		"reserved":         func(a *wenCampaignOwnerActionV1, s *wenCampaignPositionV1) { s.Data[160] = 1 },
		"before-deadline":  func(a *wenCampaignOwnerActionV1, s *wenCampaignPositionV1) { s.Now-- },
		"spent-total":      func(a *wenCampaignOwnerActionV1, s *wenCampaignPositionV1) { a.Policy.Total = 199 },
		"spent-daily":      func(a *wenCampaignOwnerActionV1, s *wenCampaignPositionV1) { a.Policy.Daily = 49 },
		"expired":          func(a *wenCampaignOwnerActionV1, s *wenCampaignPositionV1) { a.Policy.Expiry = s.Now },
		"zero-price":       func(a *wenCampaignOwnerActionV1, s *wenCampaignPositionV1) { a.Policy.MaxPrice = 0 },
		"zero-wait":        func(a *wenCampaignOwnerActionV1, s *wenCampaignPositionV1) { a.Policy.MaxWait = 0 },
		"bad-enabled":      func(a *wenCampaignOwnerActionV1, s *wenCampaignPositionV1) { a.Policy.Enabled = 2 },
		"wrong-window":     func(a *wenCampaignOwnerActionV1, s *wenCampaignPositionV1) { s.PolicyWindow.Address = a.Position },
		"wrong-issuer":     func(a *wenCampaignOwnerActionV1, s *wenCampaignPositionV1) { s.PolicyWindow.Data[16] ^= 1 },
		"bad-status":       func(a *wenCampaignOwnerActionV1, s *wenCampaignPositionV1) { s.PolicyWindow.Data[10] = 3 },
		"bad-flags":        func(a *wenCampaignOwnerActionV1, s *wenCampaignPositionV1) { s.PolicyWindow.Data[11] = 8 },
		"wrong-owner":      func(a *wenCampaignOwnerActionV1, s *wenCampaignPositionV1) { s.PolicyWindow.Owner = a.Economy },
		"unrelated-action": func(a *wenCampaignOwnerActionV1, s *wenCampaignPositionV1) { a.Operation = "stop" },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			var copy struct {
				A wenCampaignOwnerActionV1
				S wenCampaignPositionV1
			}
			raw, _ := json.Marshal(struct {
				A wenCampaignOwnerActionV1
				S wenCampaignPositionV1
			}{a, s})
			json.Unmarshal(raw, &copy)
			mutate(&copy.A, &copy.S)
			if _, e := buildWENCampaignOwnerV1(copy.A, owner, copy.S); e == nil {
				t.Fatal("invalid policy accepted")
			}
		})
	}

	// A fresh RPC read cannot silently replace the reviewed campaign state.
	pins := signerWENBTCPinsV1{ProgramID: program.String(), Genesis: solana.Hash(solana.NewWallet().PublicKey()).String(), CodeSHA256: wenHashV1([]byte("fixture")), DeploymentSlot: 50}
	a0 := wenCampaignReviewArtifactV1{Pins: pins, Action: a, Binding: wenCampaignReviewBindingV1{Position: s}}
	c := campaignExecutionFixture(t, a0, nil, "ok")
	prepared, e := prepareWENCampaignOwnerV1(context.Background(), c, pins, a, owner, 100, 132, 32, 5000, nil)
	if e != nil {
		t.Fatal("policy prepare", e)
	}
	if _, e = prepareWENCampaignOwnerV1(context.Background(), c, pins, a, owner, 100, 132, 32, 5000, prepared); e != nil {
		t.Fatal("unchanged policy revalidation", e)
	}
	c.page.Value[4].Lamports++
	if _, e = prepareWENCampaignOwnerV1(context.Background(), c, pins, a, owner, 100, 132, 32, 5000, prepared); e == nil {
		t.Fatal("changed policy window accepted")
	}
	a.Policy.Enabled = 0
	if _, e = buildWENCampaignOwnerV1(a, owner, s); e != nil {
		t.Fatal("disable should be supported", e)
	}
	s.Now = 86400
	a.Policy.Expiry = s.Now + 1
	a.Policy.Daily = 1
	if _, e = buildWENCampaignOwnerV1(a, owner, s); e != nil {
		t.Fatal("new day preserves old spend", e)
	}
}
