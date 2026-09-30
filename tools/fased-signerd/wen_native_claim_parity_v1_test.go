package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestWENNativeClaimStatePortableParity(t *testing.T) {
	var vectors []map[string]any
	v, base := nativeStateFixture(t)
	owner, policy := solana.PublicKey{5}, solana.PublicKey{6}
	h := func(k solana.PublicKey) string { return hex.EncodeToString(k[:]) }
	record := func(a *signerWENBTCAccountV1) any {
		if a == nil {
			return nil
		}
		return map[string]any{"address": h(a.Address), "owner": h(a.Owner), "executable": a.Executable, "data": append([]byte(nil), a.Data...)}
	}
	add := func(s wenNativeClaimSnapshotV1) {
		out, e := validateWENNativeClaimStateV1(v, owner, policy, s)
		vectors = append(vectors, map[string]any{"records": map[string]any{"source": record(s.Source), "receipt": record(s.Receipt), "cohort": record(s.Cohort), "history": record(s.History), "claim": record(s.Paid), "mint": record(s.Mint), "inventory": record(s.Inventory), "destination": record(s.Destination)}, "ok": e == nil, "net": out.Net})
	}
	add(base)
	for _, field := range []string{"source", "receipt", "cohort", "history", "mint", "inventory", "destination"} {
		var a *signerWENBTCAccountV1
		switch field {
		case "source":
			a = base.Source
		case "receipt":
			a = base.Receipt
		case "cohort":
			a = base.Cohort
		case "history":
			a = base.History
		case "mint":
			a = base.Mint
		case "inventory":
			a = base.Inventory
		case "destination":
			a = base.Destination
		}
		for i := range a.Data {
			a.Data[i] ^= 255
			add(base)
			a.Data[i] ^= 255
		}
	}
	input := map[string]any{"identity": map[string]any{"program": v.ProgramID, "sale": v.Sale, "owner": owner.String(), "policy": policy.String(), "destination": v.Destination, "award": v.Award, "from": v.From}, "vectors": vectors}
	// Each vector owns its bytes so later mutations cannot replace observations.
	raw, e := json.Marshal(input)
	if e != nil {
		t.Fatal(e)
	}
	cwd, _ := os.Getwd()
	root := filepath.Clean(filepath.Join(cwd, "../.."))
	script := `import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {readFileSync} from 'node:fs';
const root=process.argv[1],r=createRequire(root+'/package.json'),sdk=await import(pathToFileURL(r.resolve('@solana/kit'))),client=root+'/tools/fased-signerd/testdata/wen-protocol/client/';
const {validateNativeClaimEntitlement}=await import(pathToFileURL(client+'staking-claim-entitlement.mjs')),{buildNativeClaimInstruction}=await import(pathToFileURL(client+'staking-claim-builder.mjs')),{validateSatMint,validateSatCustody,satTransferNet,TOKEN_2022}=await import(pathToFileURL(client+'sat-token.mjs'));
const input=JSON.parse(readFileSync(0,'utf8')),id={...input.identity,award:BigInt(input.identity.award),from:BigInt(input.identity.from),now:43n*86400n},ix=await buildNativeClaimInstruction(sdk,id),hex=a=>Buffer.from(sdk.getAddressEncoder().encode(a)).toString('hex'),[collector]=await sdk.getProgramDerivedAddress({programAddress:id.program,seeds:['wen-sat-collector-v1',sdk.getAddressEncoder().encode(id.sale)]});
for(let index=0;index<input.vectors.length;index++){const v=input.vectors[index],r=v.records;for(const a of Object.values(r))if(a)a.data=new Uint8Array(Buffer.from(a.data,'base64'));let ok=false,net;
try{const e=await validateNativeClaimEntitlement(sdk,r,id),mint=hex(ix.accounts[10].address),tokenProgram=hex(TOKEN_2022);validateSatMint(r.mint,{address:mint,tokenProgram,authority:hex(id.sale),collector:hex(collector)});validateSatCustody(r.inventory,{address:hex(ix.accounts[8].address),tokenProgram,mint,authority:hex(ix.accounts[3].address),minimum:e.unpaid});const dest=validateSatCustody(r.destination,{address:hex(id.destination),tokenProgram,mint,authority:hex(id.owner),minimum:0n}),x=satTransferNet(e.gross);if(x.net===0n||dest.amount+x.net>0xffffffffffffffffn||dest.withheld+x.fee>0xffffffffffffffffn)throw Error('capacity');ok=true;net=x.net;}catch{}
assert.equal(ok,v.ok,'case '+index);if(ok)assert.equal(net,BigInt(v.net),'net '+index);}
console.log('PASS portable native state parity: '+input.vectors.length+' snapshots');`
	cmd := exec.Command("node", "--input-type=module", "-e", script, root)
	cmd.Stdin = bytes.NewReader(raw)
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("%v %s", e, out)
	}
	t.Log(string(out))
}
