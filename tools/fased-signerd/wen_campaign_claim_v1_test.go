package main

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestWENCampaignClaimParityAndReadV1(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", "--input-type=module", "-e", `
import {campaignRpcFixture} from './client/campaign-claim-fixture.mjs';
import {buildCampaignClaimInstruction} from './client/campaign-claim-instruction.mjs';
const rows=[];
for(const slots of [[0],[0,2,5,7]]){
 const f=await campaignRpcFixture(),enc=f.sdk.getAddressEncoder(),hex=k=>Buffer.from(enc.encode(k)).toString('hex');
 const raw=k=>Buffer.from(f.accounts.get(k).data[0],'base64');
 const derive=async(seed,...rest)=>(await f.sdk.getProgramDerivedAddress({programAddress:f.id.program,seeds:[seed,...rest]}))[0];
 const mint=await derive('wen-sat-mint-v1',enc.encode(f.id.economy)),pos=await derive('wen-retail-position-v2',enc.encode(f.id.owner),enc.encode(mint));
 const page=raw(f.page);page.fill(0,128);const windows=[];
 for(const [i,slot] of slots.entries()){
  const nonce=Buffer.alloc(8);nonce.writeBigUInt64LE(BigInt(i));const window=await derive('wen-retail-window-v2',enc.encode(f.id.issuer),enc.encode(mint),nonce),vault=f.key(30+i);
  const w=raw(f.request.windows[0].window),v=raw(f.request.windows[0].vault);w.set(enc.encode(vault),80);w.writeBigUInt64LE(BigInt(i),112);v.set(enc.encode(window),32);
  const at=128+slot*56;page.set(enc.encode(window),at);page.writeBigUInt64LE(BigInt(1000-i),at+32);page.writeBigUInt64LE(80n,at+40);page[at+48]=1;
  f.accounts.set(window,{...f.accounts.get(f.request.windows[0].window),data:[w.toString('base64'),'base64']});f.accounts.set(vault,{...f.accounts.get(f.request.windows[0].vault),data:[v.toString('base64'),'base64']});windows.push({window,vault});
 }
 f.accounts.get(f.page).data[0]=page.toString('base64');
 const account=k=>({Address:k,Owner:f.accounts.get(k).owner,Slot:110,Executable:f.accounts.get(k).executable,Data:f.accounts.get(k).data[0]});
 const snapshot={Program:f.id.program,Economy:f.id.economy,Owner:f.id.owner,Slot:110,Mask:slots.reduce((a,b)=>a|(1<<b),0),Position:account(pos),Page:account(f.page),Mint:account(mint),Destination:account(f.id.destination),Windows:windows.map(w=>({Window:account(w.window),Vault:account(w.vault)}))};
 const js=a=>({address:hex(a.Address),owner:hex(a.Owner),executable:a.Executable,data:[...Buffer.from(a.Data,'base64')]});
 const ix=await buildCampaignClaimInstruction(f.sdk,{program:hex(f.id.program),owner:hex(f.id.owner),mask:snapshot.Mask,position:js(snapshot.Position),page:js(snapshot.Page),destination:js(snapshot.Destination),windows:snapshot.Windows.map(w=>({window:js(w.Window),vault:js(w.Vault)}))});
 rows.push({snapshot,data:Buffer.from(ix.instruction.data).toString('hex'),accounts:ix.instruction.accounts,net:Number(ix.netSatRaw),purchase:Number(ix.purchaseLamports)});
}console.log(JSON.stringify(rows));`)
	cmd.Dir, _ = filepath.Abs("../../../token/sat/wen-genesis")
	raw, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("SDK %v %s", e, raw)
	}
	var rows []struct {
		Snapshot wenCampaignClaimSnapshotV1
		Data     string
		Accounts []struct {
			Address solana.PublicKey
			Role    int
		}
		Net, Purchase uint64
	}
	if e = json.Unmarshal(raw, &rows); e != nil {
		t.Fatal(e)
	}
	if len(rows) != 2 {
		t.Fatal("missing vectors")
	}
	for _, r := range rows {
		ix, a, e := buildWENCampaignClaimV1(r.Snapshot)
		if e != nil {
			t.Fatal(e)
		}
		d, _ := ix.Data()
		if hex.EncodeToString(d) != r.Data || a.Net != r.Net || a.Purchase != r.Purchase || len(ix.Accounts()) != len(r.Accounts) {
			t.Fatal("parity mismatch")
		}
		for i, k := range ix.Accounts() {
			v := r.Accounts[i]
			if k.PublicKey != v.Address || k.IsSigner != (v.Role&2 != 0) || k.IsWritable != (v.Role&1 != 0) {
				t.Fatal("account mismatch")
			}
		}
	}
	for _, flags := range []byte{30, 31, 62, 63} {
		b, _ := json.Marshal(rows[0].Snapshot)
		var x wenCampaignClaimSnapshotV1
		if e := json.Unmarshal(b, &x); e != nil {
			t.Fatal(e)
		}
		x.Windows[0].Window.Data[11] = flags
		if _, _, e := buildWENCampaignClaimV1(x); e != nil {
			t.Fatalf("protocol-supported campaign flags %d rejected: %v", flags, e)
		}
	}
	s := rows[0].Snapshot
	changes := map[string]func(*wenCampaignClaimSnapshotV1){
		"empty-mask": func(s *wenCampaignClaimSnapshotV1) { s.Mask = 0 }, "five-mask": func(s *wenCampaignClaimSnapshotV1) { s.Mask = 31 }, "empty-slot": func(s *wenCampaignClaimSnapshotV1) { s.Mask = 2 }, "owner": func(s *wenCampaignClaimSnapshotV1) { s.Owner = s.Economy }, "page-pda": func(s *wenCampaignClaimSnapshotV1) { s.Page.Data[80] = 1 }, "page-position": func(s *wenCampaignClaimSnapshotV1) { s.Page.Data[16] ^= 1 }, "slot": func(s *wenCampaignClaimSnapshotV1) { s.Page.Slot-- }, "replay": func(s *wenCampaignClaimSnapshotV1) { clear(s.Page.Data[128:184]) }, "dirty-empty": func(s *wenCampaignClaimSnapshotV1) { s.Page.Data[184] = 1 }, "padding": func(s *wenCampaignClaimSnapshotV1) { s.Page.Data[177] = 1 }, "zero-gross": func(s *wenCampaignClaimSnapshotV1) { clear(s.Page.Data[160:168]) }, "window-pda": func(s *wenCampaignClaimSnapshotV1) { s.Windows[0].Window.Data[112] = 1 }, "pending": func(s *wenCampaignClaimSnapshotV1) { s.Windows[0].Window.Data[10] = 0 }, "flags": func(s *wenCampaignClaimSnapshotV1) { s.Windows[0].Window.Data[11] = 8 }, "custody": func(s *wenCampaignClaimSnapshotV1) { clear(s.Windows[0].Vault.Data[64:72]) }, "destination": func(s *wenCampaignClaimSnapshotV1) { s.Destination.Data[32] ^= 1 }, "mintfee": func(s *wenCampaignClaimSnapshotV1) { s.Mint.Data[276] ^= 1 }}
	for name, mutate := range changes {
		t.Run(name, func(t *testing.T) {
			b, _ := json.Marshal(s)
			var x wenCampaignClaimSnapshotV1
			json.Unmarshal(b, &x)
			mutate(&x)
			if _, _, e := buildWENCampaignClaimV1(x); e == nil {
				t.Fatal("invalid claim accepted")
			}
		})
	}
	for _, mode := range []string{"ok", "genesis", "genesis-change", "stale", "missing", "binary"} {
		t.Run("read-"+mode, func(t *testing.T) {
			q := wenCampaignClaimRequestV1{Program: s.Program, Economy: s.Economy, Destination: s.Destination.Address, Mask: s.Mask}
			for _, w := range s.Windows {
				q.Windows = append(q.Windows, struct{ Window, Vault solana.PublicKey }{w.Window.Address, w.Vault.Address})
			}
			pd, _, _ := solana.FindProgramAddress([][]byte{s.Program[:]}, solana.BPFLoaderUpgradeableProgramID)
			p := make([]byte, 36)
			binary.LittleEndian.PutUint32(p, 2)
			copy(p[4:], pd[:])
			body := make([]byte, 48)
			binary.LittleEndian.PutUint32(body, 3)
			binary.LittleEndian.PutUint64(body[4:], 50)
			copy(body[45:], []byte{1, 2, 3})
			if mode == "binary" {
				body[47] ^= 1
			}
			clock := make([]byte, 40)
			binary.LittleEndian.PutUint64(clock, 110)
			records := []signerWENBTCAccountV1{s.Position, s.Page, s.Mint, s.Destination, {Address: s.Program, Owner: solana.BPFLoaderUpgradeableProgramID, Executable: true, Data: p}, {Address: pd, Owner: solana.BPFLoaderUpgradeableProgramID, Data: body}, {Address: solana.SysVarClockPubkey, Owner: solana.MustPublicKeyFromBase58("Sysvar1111111111111111111111111111111111111"), Data: clock}, s.Windows[0].Window, s.Windows[0].Vault}
			page := &rpc.GetMultipleAccountsResult{RPCContext: rpc.RPCContext{Context: rpc.Context{Slot: 110}}}
			keys := []solana.PublicKey{}
			for _, a := range records {
				keys = append(keys, a.Address)
				page.Value = append(page.Value, &rpc.Account{Owner: a.Owner, Executable: a.Executable, Data: rpc.DataBytesOrJSONFromBytes(a.Data)})
			}
			if mode == "missing" {
				page.Value[8] = nil
			}
			genesis := solana.Hash(solana.NewWallet().PublicKey())
			pins := signerWENBTCPinsV1{ProgramID: s.Program.String(), Genesis: genesis.String(), DeploymentSlot: 50, CodeSHA256: wenHashV1([]byte{1, 2, 3})}
			f := &campaignReadFake{wenReadRPCFake: &wenReadRPCFake{t: t, genesis: genesis, page: page, addresses: keys, change: mode}}
			got, e := readWENCampaignClaimV1(context.Background(), f, pins, q, s.Owner, 100, 132, 32)
			if (e == nil) != (mode == "ok") {
				t.Fatal(mode, e)
			}
			if e == nil {
				_, a, e := buildWENCampaignClaimV1(got)
				checkCampaignClaimPreparation(t, f, pins, q, s.Owner)
				if e != nil || a.Net != 970 {
					t.Fatal("read mismatch", e)
				}
			}
		})
	}
}
