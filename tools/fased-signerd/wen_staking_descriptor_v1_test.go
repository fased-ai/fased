package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func stakingDescriptorFixture(t *testing.T) ([]byte, wenStakingPinsV1) {
	t.Helper()
	raw, e := os.ReadFile("testdata/wen-staking-descriptor.json")
	if e != nil {
		t.Fatal(e)
	}
	raw, eCompact := wenCompactV1(raw)
	if eCompact != nil {
		t.Fatal(eCompact)
	}
	var d struct {
		Interfaces struct {
			H struct {
				Capability string `json:"capabilityDigest"`
			} `json:"stakingChangeHandoff"`
		} `json:"interfaces"`
	}
	if e = json.Unmarshal(raw, &d); e != nil {
		t.Fatal(e)
	}
	f := stakingReviewFixture(t)
	return raw, wenStakingPinsV1{ProgramID: f.Intent.ProgramID, Genesis: f.Intent.Genesis, DescriptorSHA256: wenHashV1(raw), CapabilitySHA256: d.Interfaces.H.Capability, CodeSHA256: strings.Repeat("02", 32), DeploymentSlot: 50}
}

// Recompute all advertised hashes, so shape tests cannot pass by merely detecting stale hashes.
func repinStakingDescriptor(t *testing.T, d map[string]any, p wenStakingPinsV1) ([]byte, wenStakingPinsV1) {
	t.Helper()
	h := d["interfaces"].(map[string]any)["stakingChangeHandoff"].(map[string]any)
	ins, _ := json.Marshal(h["instructions"])
	h["instructionDigest"] = wenHashV1(ins)
	cap := struct {
		Operations        any `json:"operations"`
		InstructionDigest any `json:"instructionDigest"`
		SourceDigest      any `json:"sourceDigest"`
		ContractDigest    any `json:"contractDigest"`
		PortableClient    any `json:"portableClient"`
	}{h["operations"], h["instructionDigest"], h["sourceDigest"], h["contractDigest"], h["portableClient"]}
	b, _ := wenJSONV1(cap)
	p.CapabilitySHA256 = wenHashV1(bytes.TrimSuffix(b, []byte{'\n'}))
	h["capabilityDigest"] = p.CapabilitySHA256
	d["componentGenerations"].(map[string]any)["stakingChangeCapability"] = p.CapabilitySHA256
	d["runtimeCompatibility"].(map[string]any)["stakingChangeCapability"] = p.CapabilitySHA256
	delete(d, "descriptorDigest")
	b, _ = wenJSONV1(d)
	d["descriptorDigest"] = "sha256:" + wenHashV1(b)
	b, _ = wenJSONV1(d)
	p.DescriptorSHA256 = wenHashV1(b)
	return b, p
}
func TestWENStakingDescriptorV1(t *testing.T) {
	raw, p := stakingDescriptorFixture(t)
	if e := validateWENStakingDescriptorV1(raw, p); e != nil {
		t.Fatal(e)
	}
	for _, mode := range []string{"valid-repin", "missing-signer", "missing-writable", "opcode", "name", "length", "role", "signer", "writable", "source", "operations", "client", "deployment"} {
		t.Run(mode, func(t *testing.T) {
			var d map[string]any
			decoder := json.NewDecoder(bytes.NewReader(raw))
			decoder.UseNumber()
			if e := decoder.Decode(&d); e != nil {
				t.Fatal(e)
			}
			h := d["interfaces"].(map[string]any)["stakingChangeHandoff"].(map[string]any)
			op := h["instructions"].([]any)[0].(map[string]any)
			account := op["accounts"].([]any)[1].(map[string]any)
			switch mode {
			case "missing-signer":
				delete(account, "signer")
			case "missing-writable":
				delete(account, "writable")
			case "opcode":
				op["opcode"] = 10
			case "name":
				op["name"] = "legacy"
			case "length":
				op["dataLength"] = 25
			case "role":
				account["role"] = "owner"
			case "signer":
				account["signer"] = true
			case "writable":
				account["writable"] = true
			case "source":
				h["sourceDigest"] = strings.Repeat("00", 32)
			case "operations":
				h["operations"] = []string{"mining", "requestExit"}
			case "client":
				h["portableClient"] = "client/mining.mjs"
			case "deployment":
				d["deployment"].(map[string]any)["stakingChange"].(map[string]any)["genesis"] = "wrong"
			}
			b, pins := repinStakingDescriptor(t, d, p)
			e := validateWENStakingDescriptorV1(b, pins)
			if (e == nil) != (mode == "valid-repin") {
				t.Fatal("unexpected repinned descriptor", e)
			}
		})
	}
	bad := append(append([]byte(nil), raw...), []byte(" {}")...)
	q := p
	q.DescriptorSHA256 = wenHashV1(bad)
	if validateWENStakingDescriptorV1(bad, q) == nil {
		t.Fatal("trailing JSON accepted")
	}
	bad = append([]byte(`{"stage":"deployed-release",`), raw[1:]...)
	q.DescriptorSHA256 = wenHashV1(bad)
	if validateWENStakingDescriptorV1(bad, q) == nil {
		t.Fatal("duplicate accepted")
	}
}
func TestWENStakingAdmissionV1(t *testing.T) {
	raw, p := stakingDescriptorFixture(t)
	f := stakingReviewFixture(t)
	f.Intent.DescriptorSHA256 = p.DescriptorSHA256
	f.Intent.CapabilitySHA256 = p.CapabilitySHA256
	db := filepath.Join(t.TempDir(), "state.db")
	r := wenStakingReviewV1{Version: 1, WalletID: "staker", WalletPublicKey: f.Wallet, Intent: f.Intent, Pins: p, MaxTotalCostLamports: 10000000, MaxSlotLag: 2}
	root := writeStakingReviewFixture(t, db, r)
	if _, _, e := loadWENStakingAdmissionV1(db, "staker", f.Intent); e == nil {
		t.Fatal("missing descriptor accepted")
	}
	path := filepath.Join(root, p.DescriptorSHA256)
	if e := os.WriteFile(path, raw, 0600); e != nil {
		t.Fatal(e)
	}
	if _, _, e := loadWENStakingAdmissionV1(db, "staker", f.Intent); e != nil {
		t.Fatal(e)
	}
	raw[0] ^= 1
	if e := os.WriteFile(path, raw, 0600); e != nil {
		t.Fatal(e)
	}
	if _, _, e := loadWENStakingAdmissionV1(db, "staker", f.Intent); e == nil {
		t.Fatal("changed descriptor accepted")
	}
}
