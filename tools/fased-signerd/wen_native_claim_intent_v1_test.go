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

func nativeClaimIntentFixture() signerWENNativeClaimIntentV1 {
	return signerWENNativeClaimIntentV1{DescriptorSHA256: strings.Repeat("a", 64), CapabilitySHA256: strings.Repeat("b", 64), Genesis: solana.PublicKey{1}.String(), ProgramID: solana.PublicKey{2}.String(), Sale: solana.PublicKey{3}.String(), Mint: nativeClaimMintFixture(), Destination: solana.PublicKey{4}.String(), Award: "126", From: "40", MinimumReceived: "1", MaxFeeLamports: "5000", MaxRentLamports: "0", MinFinalizedSlot: "1", ExpiresSlot: "100"}
}
func TestWENNativeClaimIntentRejectsAmbiguousRequests(t *testing.T) {
	good := nativeClaimIntentFixture()
	raw, _ := json.Marshal(good)
	if _, e := decodeWENNativeClaimIntentV1(raw); e != nil {
		t.Fatal(e)
	}
	for name, change := range map[string]func(*signerWENNativeClaimIntentV1){
		"future-history": func(v *signerWENNativeClaimIntentV1) { v.From = "43" },
		"zero-payout":    func(v *signerWENNativeClaimIntentV1) { v.MinimumReceived = "0" },
		"leading-zero":   func(v *signerWENNativeClaimIntentV1) { v.Award = "0126" },
		"overflow":       func(v *signerWENNativeClaimIntentV1) { v.MaxRentLamports = "18446744073709551615" },
		"expired":        func(v *signerWENNativeClaimIntentV1) { v.ExpiresSlot = "1" },
		"digest":         func(v *signerWENNativeClaimIntentV1) { v.CapabilitySHA256 = strings.Repeat("B", 64) },
	} {
		t.Run(name, func(t *testing.T) {
			v := good
			change(&v)
			if e := validateWENNativeClaimIntentV1(v); e == nil {
				t.Fatal("accepted")
			}
		})
	}
	extra := append(append([]byte{}, raw[:len(raw)-1]...), []byte(`,"transaction":"untrusted"}`)...)
	if _, e := decodeWENNativeClaimIntentV1(extra); e == nil {
		t.Fatal("unknown transaction field")
	}
	owner := solana.PublicKey{5}
	v := good
	v.Destination = owner.String()
	if _, e := buildWENNativeClaimInstructionV1(v, owner); e == nil {
		t.Fatal("aliased owner")
	}
	if _, e := buildWENNativeClaimInstructionV1(good, solana.PublicKey{}); e == nil {
		t.Fatal("missing owner")
	}
}
func TestWENNativeClaimInstructionPortableParity(t *testing.T) {
	cwd, e := os.Getwd()
	if e != nil {
		t.Fatal(e)
	}
	root := filepath.Clean(filepath.Join(cwd, "../../.."))
	script := `import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {readFileSync} from 'node:fs';const root=process.argv[1],r=createRequire(root+'/wen/package.json'),sdk=await import(pathToFileURL(r.resolve('@solana/kit')));const {buildNativeClaimInstruction}=await import(pathToFileURL(root+'/token/sat/wen-genesis/client/staking-claim-builder.mjs'));const inputs=JSON.parse(readFileSync(0,'utf8')),out=[];for(const v of inputs){const i=await buildNativeClaimInstruction(sdk,{program:v.programId,sale:v.sale,owner:v.owner,destination:v.destination,award:BigInt(v.award),from:BigInt(v.from)});out.push({data:Buffer.from(i.data).toString('hex'),accounts:i.accounts});}console.log(JSON.stringify(out));`
	type row struct {
		Address  string `json:"address"`
		Signer   bool   `json:"isSigner"`
		Writable bool   `json:"isWritable"`
	}
	type result struct {
		Data     string `json:"data"`
		Accounts []row  `json:"accounts"`
	}
	var expected []result
	var inputs []map[string]any
	for _, award := range []string{"0", "1", "2", "3", "126", "18446744073709551615"} {
		v := nativeClaimIntentFixture()
		v.Award = award
		v.From = "0"
		owner := solana.PublicKey{5}
		ix, e := buildWENNativeClaimInstructionV1(v, owner)
		if e != nil {
			t.Fatal(e)
		}
		data, e := ix.Data()
		if e != nil {
			t.Fatal(e)
		}
		out := result{Data: hex.EncodeToString(data)}
		for _, m := range ix.Accounts() {
			out.Accounts = append(out.Accounts, row{m.PublicKey.String(), m.IsSigner, m.IsWritable})
		}
		expected = append(expected, out)
		raw, _ := json.Marshal(v)
		var in map[string]any
		json.Unmarshal(raw, &in)
		in["owner"] = owner.String()
		inputs = append(inputs, in)
	}
	raw, _ := json.Marshal(inputs)
	cmd := exec.Command("node", "--input-type=module", "-e", script, root)
	cmd.Stdin = bytes.NewReader(raw)
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("portable comparison: %v %s", e, out)
	}
	var actual []result
	if e = json.Unmarshal(out, &actual); e != nil {
		t.Fatal(e, string(out))
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatal("Go/portable mismatch")
	}
	if expected[0].Accounts[3].Address == expected[1].Accounts[3].Address {
		t.Fatal("awards alias")
	}
}

func nativeClaimMintFixture() string {
	p, s := solana.PublicKey{2}, solana.PublicKey{3}
	k, _, e := solana.FindProgramAddress([][]byte{[]byte("wen-sat-mint-v1"), s[:]}, p)
	if e != nil {
		panic(e)
	}
	return k.String()
}
func TestWENNativeClaimWrongMintAndAliases(t *testing.T) {
	v := nativeClaimIntentFixture()
	owner := solana.PublicKey{5}
	v.Mint = wenBTCClaimMintV1
	if _, e := buildWENNativeClaimInstructionV1(v, owner); e == nil {
		t.Fatal("accepted BTC mint")
	}
	v = nativeClaimIntentFixture()
	v.Destination = solana.Token2022ProgramID.String()
	if _, e := buildWENNativeClaimInstructionV1(v, owner); e == nil {
		t.Fatal("accepted program alias")
	}
}
