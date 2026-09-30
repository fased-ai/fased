package main

import (
	"bytes"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func miningFundingFixture(t *testing.T) (signerWENMiningFundingIntentV1, solana.PublicKey, []byte) {
	t.Helper()
	raw, e := os.ReadFile("testdata/wen-mining-funding-candidate.json")
	if e != nil {
		t.Fatal(e)
	}
	var f struct {
		Nonce        string
		VaultIDBytes []int
		Instruction  struct {
			Program  string
			Data     []int
			Accounts []struct {
				Address          string
				Signer, Writable bool
			}
		}
	}
	if e = json.Unmarshal(raw, &f); e != nil {
		t.Fatal(e)
	}
	var id solana.PublicKey
	for i, n := range f.VaultIDBytes {
		id[i] = byte(n)
	}
	v := signerWENMiningFundingIntentV1{DescriptorSHA256: strings.Repeat("a", 64), CapabilitySHA256: strings.Repeat("b", 64), Genesis: solana.PublicKey{9}.String(), ProgramID: f.Instruction.Program, Sale: f.Instruction.Accounts[3].Address, VaultID: id.String(), Nonce: f.Nonce, Amount: "6000", Deadline: "100", MaxFeeLamports: "5000", MinFinalizedSlot: "1", ExpiresSlot: "20"}
	return v, solana.MustPublicKeyFromBase58(f.Instruction.Accounts[2].Address), raw
}
func TestWENMiningFundingRustAndPortableParity(t *testing.T) {
	v, owner, raw := miningFundingFixture(t)
	ix, e := buildWENMiningFundingInstructionV1(v, owner)
	if e != nil {
		t.Fatal(e)
	}
	var f struct {
		Instruction struct {
			Program  string
			Data     []int
			Accounts []struct {
				Address          string
				Signer, Writable bool
			}
		}
	}
	json.Unmarshal(raw, &f)
	d, _ := ix.Data()
	if !bytes.Equal(d, []byte{120}) || ix.ProgramID().String() != f.Instruction.Program {
		t.Fatal("Rust opcode/program mismatch")
	}
	for i, a := range ix.Accounts() {
		w := f.Instruction.Accounts[i]
		if a.PublicKey.String() != w.Address || a.IsSigner != w.Signer || a.IsWritable != w.Writable {
			t.Fatalf("Rust account %d mismatch", i)
		}
	}
	cwd, _ := os.Getwd()
	root := filepath.Clean(filepath.Join(cwd, "../.."))
	input, _ := json.Marshal(map[string]any{"program": v.ProgramID, "owner": owner.String(), "id": v.VaultID, "recipient": owner.String(), "sale": v.Sale, "nonce": v.Nonce, "accounts": f.Instruction.Accounts})
	script := `import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {readFileSync} from 'node:fs';import assert from 'node:assert/strict';const root=process.argv[1],req=createRequire(root+'/package.json'),sdk=await import(pathToFileURL(req.resolve('@solana/kit')));const {derivePortfolioVaultCandidate}=await import(pathToFileURL(root+'/tools/fased-signerd/testdata/wen-protocol/client/portfolio-vault-candidate.mjs'));const x=JSON.parse(readFileSync(0,'utf8'));for(const nonce of [x.nonce,'0','18446744073709551615']){const out=await derivePortfolioVaultCandidate(sdk,x,'fundMining',{nonce:BigInt(nonce)});assert.deepEqual(Array.from(out.instruction.data),[120]);if(nonce===x.nonce)for(let i=0;i<6;i++){assert.equal(out.instruction.accounts[i].address,x.accounts[i].Address);assert.equal(out.instruction.accounts[i].isSigner,x.accounts[i].Signer);assert.equal(out.instruction.accounts[i].isWritable,x.accounts[i].Writable);}}console.log('PASS: Rust/Go/portable funding opcode and accounts');`
	cmd := exec.Command("node", "--input-type=module", "-e", script, root)
	cmd.Stdin = bytes.NewReader(input)
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("%v %s", e, out)
	}
	t.Log(string(out))
}
func TestWENMiningFundingRejectsMalformedIntent(t *testing.T) {
	v, owner, _ := miningFundingFixture(t)
	raw, _ := json.Marshal(v)
	if _, e := decodeWENMiningFundingIntentV1(raw); e != nil {
		t.Fatal(e)
	}
	for _, mutate := range []func(*signerWENMiningFundingIntentV1){func(x *signerWENMiningFundingIntentV1) { x.Amount = "0" }, func(x *signerWENMiningFundingIntentV1) { x.Nonce = "01" }, func(x *signerWENMiningFundingIntentV1) { x.Nonce = "18446744073709551616" }, func(x *signerWENMiningFundingIntentV1) { x.Deadline = "9223372036854775808" }, func(x *signerWENMiningFundingIntentV1) { x.ExpiresSlot = x.MinFinalizedSlot }, func(x *signerWENMiningFundingIntentV1) { x.MaxFeeLamports = "6500001" }, func(x *signerWENMiningFundingIntentV1) { x.CapabilitySHA256 = "bad" }, func(x *signerWENMiningFundingIntentV1) { x.Sale = owner.String() }} {
		x := v
		mutate(&x)
		if _, e := buildWENMiningFundingInstructionV1(x, owner); e == nil {
			t.Fatal("malformed intent admitted")
		}
	}
	for _, s := range []string{"", string(raw[:len(raw)-1]) + `,"owner":"spoof"}`, string(raw[:len(raw)-1]) + `,"nonce":"7"}`} {
		if _, e := decodeWENMiningFundingIntentV1([]byte(s)); e == nil {
			t.Fatal("malformed JSON admitted")
		}
	}
	if _, e := buildWENMiningFundingInstructionV1(v, solana.PublicKey{}); e == nil {
		t.Fatal("zero owner")
	}
	for _, nonce := range []string{"0", "18446744073709551615"} {
		x := v
		x.Nonce = nonce
		if _, e := buildWENMiningFundingInstructionV1(x, owner); e != nil {
			t.Fatal(e)
		}
	}
}
