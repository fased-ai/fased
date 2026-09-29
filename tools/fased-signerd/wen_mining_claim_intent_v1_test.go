package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func miningClaimIntentFixture() signerWENMiningClaimIntentV1 {
	return signerWENMiningClaimIntentV1{Operation: "sol", DescriptorSHA256: strings.Repeat("a", 64), CapabilitySHA256: strings.Repeat("b", 64), AccountStateSHA256: strings.Repeat("c", 64), Genesis: solana.PublicKey{1}.String(), ProgramID: solana.PublicKey{2}.String(), Economy: solana.PublicKey{3}.String(), ID: "1", Nonce: "2", Ordinal: "0", ExpectedGross: "100", MinimumReceived: "97", MaxFeeLamports: "5000", MinFinalizedSlot: "1", ExpiresSlot: "33"}
}
func TestWENMiningClaimIntentValidation(t *testing.T) {
	good := miningClaimIntentFixture()
	raw, _ := json.Marshal(good)
	if _, e := decodeWENMiningClaimIntentV1(raw); e != nil {
		t.Fatal(e)
	}
	for name, change := range map[string]func(*signerWENMiningClaimIntentV1){"operation": func(v *signerWENMiningClaimIntentV1) { v.Operation = "btc" }, "sat-destination": func(v *signerWENMiningClaimIntentV1) { v.Operation = "sat" }, "sol-destination": func(v *signerWENMiningClaimIntentV1) { x := v.Economy; v.Destination = &x }, "hash": func(v *signerWENMiningClaimIntentV1) { v.AccountStateSHA256 = strings.Repeat("C", 64) }, "key": func(v *signerWENMiningClaimIntentV1) { v.ProgramID = "bad" }, "zero-key": func(v *signerWENMiningClaimIntentV1) { v.Economy = solana.PublicKey{}.String() }, "integer": func(v *signerWENMiningClaimIntentV1) { v.ID = "01" }, "overflow": func(v *signerWENMiningClaimIntentV1) { v.Nonce = "18446744073709551616" }, "minimum": func(v *signerWENMiningClaimIntentV1) { v.MinimumReceived = "101" }, "zero-fee": func(v *signerWENMiningClaimIntentV1) { v.MaxFeeLamports = "0" }, "fee-limit": func(v *signerWENMiningClaimIntentV1) { v.MaxFeeLamports = "18446744073709551615" }, "old-slot": func(v *signerWENMiningClaimIntentV1) { v.MinFinalizedSlot = "0" }, "expired": func(v *signerWENMiningClaimIntentV1) { v.ExpiresSlot = "1" }, "long-window": func(v *signerWENMiningClaimIntentV1) { v.ExpiresSlot = "34" }} {
		t.Run(name, func(t *testing.T) {
			v := good
			change(&v)
			if validateWENMiningClaimIntentV1(v) == nil {
				t.Fatal("accepted")
			}
		})
	}
	for _, suffix := range []string{`,"transaction":"bad"}`, `,"id":"2"}`, `,"maxRentLamports":"1"}`} {
		b := append(append([]byte{}, raw[:len(raw)-1]...), []byte(suffix)...)
		if _, e := decodeWENMiningClaimIntentV1(b); e == nil {
			t.Fatal("ambiguous fields accepted")
		}
	}
	for _, owner := range []solana.PublicKey{{}, solana.MustPublicKeyFromBase58(good.Economy)} {
		if _, e := buildWENMiningClaimInstructionV1(good, owner); e == nil {
			t.Fatal("aliased or absent owner")
		}
	}
	v := good
	v.Operation = "sat"
	dest := solana.PublicKey{4}.String()
	v.Destination = &dest
	v.MinimumReceived = "98"
	if validateWENMiningClaimIntentV1(v) == nil {
		t.Fatal("fee ignored")
	}
	v.ExpectedGross = "0"
	v.MinimumReceived = "0"
	if e := validateWENMiningClaimIntentV1(v); e != nil {
		t.Fatal("zero-valued leg must remain closable", e)
	}
}
func TestWENMiningClaimPortableParity(t *testing.T) {
	type row struct {
		Address string `json:"address"`
		Role    int    `json:"role"`
	}
	type result struct {
		Data     string `json:"data"`
		Accounts []row  `json:"accounts"`
	}
	var expected []result
	var inputs []map[string]any
	for _, op := range []string{"sol", "sat"} {
		for _, n := range []string{"0", "17", "18446744073709551615"} {
			v := miningClaimIntentFixture()
			v.Operation = op
			v.ID = n
			v.Nonce = n
			v.Ordinal = n
			owner := solana.PublicKey{5}
			if op == "sat" {
				d := solana.PublicKey{4}.String()
				v.Destination = &d
			}
			ix, e := buildWENMiningClaimInstructionV1(v, owner)
			if e != nil {
				t.Fatal(e)
			}
			data, _ := ix.Data()
			out := result{Data: hex.EncodeToString(data)}
			for _, m := range ix.Accounts() {
				role := 0
				if m.IsSigner {
					role += 2
				}
				if m.IsWritable {
					role++
				}
				out.Accounts = append(out.Accounts, row{m.PublicKey.String(), role})
			}
			expected = append(expected, out)
			raw, _ := json.Marshal(v)
			var input map[string]any
			json.Unmarshal(raw, &input)
			input["owner"] = owner.String()
			inputs = append(inputs, input)
		}
	}
	cwd, _ := os.Getwd()
	root := filepath.Clean(filepath.Join(cwd, "../../.."))
	output := filepath.Join(t.TempDir(), "parity.json")
	script := `import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {readFileSync,writeFileSync} from 'node:fs';const root=process.argv[1],r=createRequire(root+'/wen/package.json'),sdk=await import(pathToFileURL(r.resolve('@solana/kit')));const {buildMiningClaimInstruction}=await import(pathToFileURL(root+'/token/sat/wen-genesis/client/mining-claim-instruction.mjs'));const out=[];for(const v of JSON.parse(readFileSync(0,'utf8'))){const i=await buildMiningClaimInstruction(sdk,{program:v.programId,sale:v.economy,owner:v.owner,id:BigInt(v.id),nonce:BigInt(v.nonce),ordinal:BigInt(v.ordinal),operation:v.operation,...(v.operation==='sat'?{destination:v.destination}:{})});out.push({data:Buffer.from(i.data).toString('hex'),accounts:i.accounts});}writeFileSync(process.argv[2],JSON.stringify(out),{flag:'wx'});`
	raw, _ := json.Marshal(inputs)
	cmd := exec.Command("node", "--input-type=module", "-e", script, root, output)
	cmd.Stdin = bytes.NewReader(raw)
	if out, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("parity: %v %s", e, out)
	}
	raw, e := os.ReadFile(output)
	if e != nil {
		t.Fatal(e)
	}
	var actual []result
	if e = json.Unmarshal(raw, &actual); e != nil {
		t.Fatal(e)
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatal("Go/SDK instruction mismatch")
	}
}
