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

func TestWENMiningClaimDescriptor(t *testing.T) {
	cwd, _ := os.Getwd()
	root := filepath.Clean(filepath.Join(cwd, "../../.."))
	output := filepath.Join(t.TempDir(), "descriptor.json")
	script := `import {pathToFileURL} from 'node:url';import {writeFileSync} from 'node:fs';const {claimDescriptorFixture}=await import(pathToFileURL(process.argv[1]+'/token/sat/wen-genesis/scripts/claim-descriptor-fixture.mjs'));const f=await claimDescriptorFixture({program:'11'.repeat(32),deployedBytesHash:'22'.repeat(32),deploymentSlot:1n,upgradeAuthority:null},'fixture');writeFileSync(process.argv[2],f.bytes,{flag:'wx'});`
	cmd := exec.Command("node", "--input-type=module", "-e", script, root, output)
	if out, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("fixture: %v %s", e, out)
	}
	raw, e := os.ReadFile(output)
	if e != nil {
		t.Fatal(e)
	}
	program := solana.PublicKey{}
	for i := range program {
		program[i] = 0x11
	}
	for _, mode := range []string{"ok", "opcode", "role", "writable", "signer", "length", "extra", "stage", "public", "operations", "source", "capability", "deployment", "authority", "unbound", "duplicate", "wrong-pin"} {
		t.Run(mode, func(t *testing.T) {
			var d map[string]any
			dec := json.NewDecoder(bytes.NewReader(raw))
			dec.UseNumber()
			if e := dec.Decode(&d); e != nil {
				t.Fatal(e)
			}
			h := d["interfaces"].(map[string]any)["miningClaimHandoff"].(map[string]any)
			op := h["instructions"].([]any)[0].(map[string]any)
			a := op["accounts"].([]any)[0].(map[string]any)
			dep := d["deployment"].(map[string]any)["miningClaim"].(map[string]any)
			switch mode {
			case "opcode":
				op["opcode"] = 81
			case "role":
				a["role"] = "destination"
			case "writable":
				a["writable"] = false
			case "signer":
				a["signer"] = false
			case "length":
				op["dataLength"] = 24
			case "extra":
				h["arbitrary"] = true
			case "stage":
				h["stage"] = "released"
			case "public":
				h["publicEntryEnabled"] = true
			case "operations":
				h["operations"] = []string{"sat", "sol"}
			case "source":
				h["sourceDigest"] = strings.Repeat("0", 64)
			case "deployment":
				dep["deploymentSlot"] = "2"
			case "authority":
				dep["upgradeAuthority"] = strings.Repeat("3", 64)
			case "unbound":
				d["runtimeCompatibility"].(map[string]any)["status"] = "NOT_BOUND"
			}
			delete(h, "capabilityDigest")
			b, _ := wenJSONV1(h)
			cap := wenHashV1(bytes.TrimSuffix(b, []byte{'\n'}))
			h["capabilityDigest"] = cap
			// Reseal altered capabilities so shape failures do not rely on stale hashes.
			for _, section := range []string{"componentGenerations", "runtimeCompatibility"} {
				d[section].(map[string]any)["miningClaimCapability"] = cap
			}
			if mode == "capability" {
				d["runtimeCompatibility"].(map[string]any)["miningClaimCapability"] = "wrong"
			}
			delete(d, "descriptorDigest")
			b, _ = wenJSONV1(d)
			d["descriptorDigest"] = "sha256:" + wenHashV1(b)
			b, _ = wenJSONV1(d)
			if mode == "duplicate" {
				b = append([]byte(`{"stage":"deployed-release",`), b[1:]...)
			}
			pins := wenStakingPinsV1{DescriptorSHA256: wenHashV1(b), CapabilitySHA256: cap, ProgramID: program.String(), Genesis: "fixture", DeploymentSlot: 1, CodeSHA256: strings.Repeat("22", 32)}
			if mode == "wrong-pin" {
				pins.DescriptorSHA256 = strings.Repeat("0", 64)
			}
			if e := validateWENMiningClaimDescriptorV1(b, pins); (e == nil) != (mode == "ok") {
				t.Fatalf("validation result: %v", e)
			}
		})
	}
}
