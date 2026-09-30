package main

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
)

var miningDescriptorFixtures = struct {
	sync.Mutex
	values map[string]struct {
		raw  []byte
		pins wenMiningPinsV1
	}
}{values: make(map[string]struct {
	raw  []byte
	pins wenMiningPinsV1
})}

func miningDescriptorFixture(t *testing.T, p wenMiningPinsV1) ([]byte, wenMiningPinsV1) {
	t.Helper()
	cacheKeyRaw, _ := json.Marshal(p)
	cacheKey := string(cacheKeyRaw)
	miningDescriptorFixtures.Lock()
	defer miningDescriptorFixtures.Unlock()
	if found, ok := miningDescriptorFixtures.values[cacheKey]; ok {
		return append([]byte(nil), found.raw...), found.pins
	}
	program := solana.MustPublicKeyFromBase58(p.ProgramID)
	cwd, _ := os.Getwd()
	root := filepath.Clean(filepath.Join(cwd, "../.."))
	script := `import {readFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';const root=process.argv[1],x=JSON.parse(readFileSync(0,'utf8'));const {claimDescriptorFixture}=await import(pathToFileURL(root+'/tools/fased-signerd/testdata/wen-protocol/scripts/claim-descriptor-fixture.mjs'));const b=await claimDescriptorFixture({program:x.program,deployedBytesHash:x.code,deploymentSlot:BigInt(x.slot),upgradeAuthority:x.authority},x.genesis);console.log(JSON.stringify({raw:Buffer.from(b.bytes).toString('base64'),sha:b.sha256,cap:b.miningCapabilityDigest}));`
	var authority any
	if p.UpgradeAuthority != nil {
		authority = hex.EncodeToString(p.UpgradeAuthority[:])
	}
	input, _ := json.Marshal(map[string]any{"program": hex.EncodeToString(program[:]), "code": p.CodeSHA256, "genesis": p.Genesis, "slot": p.DeploymentSlot, "authority": authority})
	cmd := exec.Command("node", "--input-type=module", "-e", script, root)
	cmd.Stdin = bytes.NewReader(input)
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("%v %s", e, out)
	}
	var fixture struct{ Raw, Sha, Cap string }
	if e = json.Unmarshal(out, &fixture); e != nil {
		t.Fatal(e)
	}
	raw, e := base64.StdEncoding.DecodeString(fixture.Raw)
	if e != nil {
		t.Fatal(e)
	}
	p.DescriptorSHA256 = fixture.Sha
	p.CapabilitySHA256 = fixture.Cap
	if e = validateWENMiningDescriptorV1(raw, p); e != nil {
		t.Fatal(e)
	}
	miningDescriptorFixtures.values[cacheKey] = struct {
		raw  []byte
		pins wenMiningPinsV1
	}{append([]byte(nil), raw...), p}
	return raw, p
}

func TestWENMiningDescriptorPortableParity(t *testing.T) {
	f := miningFixture(t)
	raw, p := miningDescriptorFixture(t, wenMiningPinsV1{ProgramID: f.Intent.ProgramID, Genesis: f.Intent.Genesis, CodeSHA256: wenHashV1([]byte("mining code")), DeploymentSlot: 5})
	for _, mode := range []string{"code", "slot", "authority", "program", "genesis", "capability", "descriptor"} {
		t.Run(mode, func(t *testing.T) {
			bad := p
			switch mode {
			case "code":
				bad.CodeSHA256 = wenHashV1([]byte("other"))
			case "slot":
				bad.DeploymentSlot++
			case "authority":
				w := solana.MustPublicKeyFromBase58(f.Wallet)
				bad.UpgradeAuthority = &w
			case "program":
				bad.ProgramID = f.Wallet
			case "genesis":
				bad.Genesis = f.Wallet
			case "capability":
				bad.CapabilitySHA256 = wenHashV1([]byte("other"))
			case "descriptor":
				bad.DescriptorSHA256 = wenHashV1([]byte("other"))
			}
			if validateWENMiningDescriptorV1(raw, bad) == nil {
				t.Fatal("changed pin admitted")
			}
		})
	}
	for _, tc := range []struct{ name, old, next string }{
		{"valid-wrapper", `"length":272`, `"length":272`},
		{"opcode", `"opcode":54`, `"opcode":79`},
		{"signer", `"signer":true`, `"signer":false`},
		{"layout", `"length":272`, `"length":273`},
		{"stage", `"stage":"source-candidate"`, `"stage":"activated"`},
		{"public-entry", `"publicEntryEnabled":false`, `"publicEntryEnabled":true`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Edit only the mining subtree, preserving ordered JSON inside capability hashes.
			var top map[string]json.RawMessage
			json.Unmarshal(raw, &top)
			var interfaces map[string]json.RawMessage
			json.Unmarshal(top["interfaces"], &interfaces)
			h := interfaces["miningCommitmentHandoff"]
			if !bytes.Contains(h, []byte(tc.old)) {
				t.Fatal("mutation target absent")
			}
			interfaces["miningCommitmentHandoff"] = bytes.Replace(h, []byte(tc.old), []byte(tc.next), 1)
			top["interfaces"], _ = json.Marshal(interfaces)
			delete(top, "descriptorDigest")
			changed, _ := json.Marshal(top)
			var canonical map[string]any
			dec := json.NewDecoder(bytes.NewReader(changed))
			dec.UseNumber()
			dec.Decode(&canonical)
			body, _ := wenJSONV1(canonical)
			top["descriptorDigest"], _ = json.Marshal("sha256:" + wenHashV1(body))
			changed, _ = json.Marshal(top)
			pins := p
			pins.DescriptorSHA256 = wenHashV1(changed)
			e := validateWENMiningDescriptorV1(changed, pins)
			if (e == nil) != (tc.name == "valid-wrapper") {
				t.Fatal("contract mutation result", e)
			}
		})
	}
	for _, mutation := range [][]byte{append([]byte(`{"descriptorVersion":2,`), raw[1:]...), []byte(`{}`), make([]byte, 32769)} {
		pins := p
		pins.DescriptorSHA256 = wenHashV1(mutation)
		if validateWENMiningDescriptorV1(mutation, pins) == nil {
			t.Fatal("malformed descriptor admitted")
		}
	}
	v := f.Intent
	v.DescriptorSHA256 = p.DescriptorSHA256
	v.CapabilitySHA256 = p.CapabilitySHA256
	db := filepath.Join(t.TempDir(), "state.db")
	root := writeMiningReviewFixture(t, db, wenMiningReviewV1{Version: 1, WalletID: "miner", WalletPublicKey: f.Wallet, Intent: v, Pins: p, MaxSlotLag: 2})
	if _, _, e := loadWENMiningAdmissionV1(db, "miner", v); e == nil {
		t.Fatal("missing descriptor admitted")
	}
	path := filepath.Join(root, p.DescriptorSHA256)
	if e := os.WriteFile(path, raw, 0600); e != nil {
		t.Fatal(e)
	}
	if _, _, e := loadWENMiningAdmissionV1(db, "miner", v); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(path, []byte("{}"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, _, e := loadWENMiningAdmissionV1(db, "miner", v); e == nil {
		t.Fatal("corrupt descriptor admitted")
	}
}
