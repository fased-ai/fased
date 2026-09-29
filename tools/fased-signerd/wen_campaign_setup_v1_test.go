package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"math"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
)

func TestWENCampaignAtomicSetupRetailParity(t *testing.T) {
	root, e := filepath.Abs("../../../token/sat/wen-genesis")
	if e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", "--input-type=module", "-e", `
import {campaignKeeperFixture} from './client/campaign-keeper-fixture.mjs';
import {buildCampaignSetupInstruction} from './client/campaign-setup-instruction.mjs';
const f=await campaignKeeperFixture(),enc=f.sdk.getAddressEncoder(),hex=k=>Buffer.from(enc.encode(k)).toString('hex');
const derive=async(seed,...rest)=>(await f.sdk.getProgramDerivedAddress({programAddress:f.id.program,seeds:[seed,...rest]}))[0];
const mint=await derive('wen-sat-mint-v1',enc.encode(f.id.economy));
const position=await derive('wen-retail-position-v2',enc.encode(f.id.owner),enc.encode(mint));
const registry=await derive('wen-retail-members-v2',enc.encode(f.id.issuer),enc.encode(mint));
const empty=address=>({Address:address,Owner:'11111111111111111111111111111111',Executable:false,Lamports:0,Data:''});
const raw=f.accounts.get(f.window),window={Address:f.window,Owner:raw.owner,Executable:false,Lamports:raw.lamports,Data:raw.data[0]};
const wd=Buffer.from(window.Data,'base64');wd[11]=12;window.Data=wd.toString('base64');
const rows=[];
for(const existing of [false,true]) {
 const index=existing?7n:0n,nonce=Buffer.alloc(8);nonce.writeBigUInt64LE(index);
 const member=await derive('wen-retail-member-v2',enc.encode(registry),nonce);
 const g=empty(registry);
 if(existing){const b=Buffer.alloc(112);b.write('WENRMEM2');b[8]=1;b.set(enc.encode(f.id.issuer),16);b.set(enc.encode(mint),48);b.writeBigUInt64LE(index,80);g.Data=b.toString('base64');g.Owner=f.id.program;g.Lamports=1000;}
 const snapshot={Program:f.id.program,Economy:f.id.economy,Owner:f.id.owner,Issuer:f.id.issuer,Now:1800,Terms:{Deposit:1000,MaxPrice:1,Daily:100,Total:1000,Expiry:3000,MaxWait:1500},Position:empty(position),Window:window,Registry:g,Member:empty(member)};
 const account=a=>({address:hex(a.Address),owner:hex(a.Owner),executable:a.Executable,lamports:BigInt(a.Lamports),data:[...Buffer.from(a.Data,'base64')]});
 const p=await buildCampaignSetupInstruction(f.sdk,{op:161,program:hex(f.id.program),owner:hex(f.id.owner),issuer:hex(f.id.issuer),mint:hex(mint),now:1800n,terms:{deposit:1000n,maxPrice:1n,daily:100n,total:1000n,expiry:3000n,maxWait:1500n},position:account(snapshot.Position),window:account(window),registry:account(g),member:account(snapshot.Member)});
 rows.push({snapshot,data:Buffer.from(p.instruction.data).toString('hex'),accounts:p.instruction.accounts,allocations:p.allocations.map(a=>({Address:a.address,Bytes:a.bytes}))});
}
console.log(JSON.stringify(rows));`)
	cmd.Dir = root
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("retail setup vectors: %v: %s", e, out)
	}
	var rows []struct {
		Snapshot wenCampaignSetupV1
		Data     string
		Accounts []struct {
			Address solana.PublicKey
			Role    int
		}
		Allocations []wenCampaignAllocationV1
	}
	if e = json.Unmarshal(out, &rows); e != nil {
		t.Fatal(e)
	}
	if len(rows) != 2 {
		t.Fatal("expected new and existing registry")
	}
	for _, r := range rows {
		ix, allocations, e := buildWENCampaignAtomicSetupV1(r.Snapshot)
		if e != nil {
			t.Fatal(e)
		}
		data, e := ix.Data()
		if e != nil {
			t.Fatal(e)
		}
		expected, e := hex.DecodeString(r.Data)
		if e != nil {
			t.Fatal(e)
		}
		if !bytes.Equal(data, expected) || ix.ProgramID() != r.Snapshot.Program || !reflect.DeepEqual(allocations, r.Allocations) {
			t.Fatal("setup bytes/program/allocations differ")
		}
		if len(ix.Accounts()) != len(r.Accounts) {
			t.Fatal("setup account count differs")
		}
		for i, a := range ix.Accounts() {
			v := r.Accounts[i]
			if a.PublicKey != v.Address || a.IsSigner != (v.Role&2 != 0) || a.IsWritable != (v.Role&1 != 0) {
				t.Fatalf("setup account %d differs", i)
			}
		}
	}
	changes := map[string]func(*wenCampaignSetupV1){
		"zero-deposit":       func(v *wenCampaignSetupV1) { v.Terms.Deposit = 0 },
		"price-limit":        func(v *wenCampaignSetupV1) { v.Terms.MaxPrice = 0 },
		"expiry":             func(v *wenCampaignSetupV1) { v.Terms.Expiry = 2199 },
		"cutoff":             func(v *wenCampaignSetupV1) { v.Now = 1900 },
		"used-position":      func(v *wenCampaignSetupV1) { v.Position.Lamports = 1 },
		"wrong-owner":        func(v *wenCampaignSetupV1) { v.Owner = v.Issuer },
		"wrong-economy":      func(v *wenCampaignSetupV1) { v.Economy = v.Issuer },
		"wrong-position":     func(v *wenCampaignSetupV1) { v.Position.Address = v.Window.Address },
		"window-header":      func(v *wenCampaignSetupV1) { v.Window.Data[8] = 2 },
		"window-short":       func(v *wenCampaignSetupV1) { v.Window.Data = v.Window.Data[:3] },
		"window-executable":  func(v *wenCampaignSetupV1) { v.Window.Executable = true },
		"window-owner":       func(v *wenCampaignSetupV1) { v.Window.Owner = v.Owner },
		"window-issuer":      func(v *wenCampaignSetupV1) { v.Window.Data[16] ^= 1 },
		"window-pda":         func(v *wenCampaignSetupV1) { v.Window.Address = v.Position.Address },
		"closed-window":      func(v *wenCampaignSetupV1) { v.Window.Data[10] = 1 },
		"standing-window":    func(v *wenCampaignSetupV1) { v.Window.Data[11] = 13 },
		"unknown-flags":      func(v *wenCampaignSetupV1) { v.Window.Data[11] = 8 },
		"execution-overflow": func(v *wenCampaignSetupV1) { binary.LittleEndian.PutUint64(v.Window.Data[232:], math.MaxUint64) },
		"unfunded-execution": func(v *wenCampaignSetupV1) { binary.LittleEndian.PutUint64(v.Window.Data[248:], 60001) },
		"entry-overflow":     func(v *wenCampaignSetupV1) { binary.LittleEndian.PutUint64(v.Window.Data[216:], math.MaxUint64) },
		"registry-pda":       func(v *wenCampaignSetupV1) { v.Registry.Address = v.Member.Address },
		"registry-binding":   func(v *wenCampaignSetupV1) { v.Registry.Data[16] ^= 1 },
		"registry-full":      func(v *wenCampaignSetupV1) { binary.LittleEndian.PutUint64(v.Registry.Data[80:], math.MaxUint64) },
		"member-pda":         func(v *wenCampaignSetupV1) { v.Member.Address = v.Registry.Address },
		"used-member":        func(v *wenCampaignSetupV1) { v.Member.Data = []byte{1} },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			v := rows[1].Snapshot
			v.Window.Data = bytes.Clone(v.Window.Data)
			v.Registry.Data = bytes.Clone(v.Registry.Data)
			change(&v)
			if _, _, e := buildWENCampaignAtomicSetupV1(v); e == nil {
				t.Fatal("invalid setup accepted")
			}
		})
	}
}
