package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"strconv"
)

func validateWENMiningFundingDescriptorV1(raw []byte, p wenStakingPinsV1) error {
	if len(raw) == 0 || len(raw) > 32768 || wenHashV1(raw) != p.DescriptorSHA256 {
		return errors.New("staking descriptor pin mismatch")
	}
	var strict map[string]any
	if err := decodeStrictJSONV2(raw, &strict); err != nil {
		return err
	}
	var d map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&d); err != nil {
		return err
	}
	expected := []string{"$schema", "descriptorVersion", "stage", "source", "componentGenerations", "build", "interfaces", "deployment", "runtimeCompatibility", "publication", "receiptBinding", "descriptorDigest"}
	if len(d) != len(expected) {
		return errors.New("descriptor field set")
	}
	for _, k := range expected {
		if _, ok := d[k]; !ok {
			return errors.New("descriptor missing field")
		}
	}
	if d["$schema"] != "sat.release-descriptor.v2" || d["descriptorVersion"] != json.Number("2") || d["stage"] != "deployed-release" {
		return errors.New("descriptor not deployment bound")
	}
	internal := d["descriptorDigest"]
	delete(d, "descriptorDigest")
	canonical, err := wenJSONV1(d)
	if err != nil || internal != "sha256:"+wenHashV1(canonical) {
		return errors.New("descriptor internal digest mismatch")
	}
	object := func(k string) map[string]any { v, _ := d[k].(map[string]any); return v }
	for _, k := range []string{"source", "componentGenerations", "build", "interfaces", "deployment", "runtimeCompatibility"} {
		if object(k)["status"] != "BOUND" {
			return errors.New("descriptor section not bound")
		}
	}
	for _, k := range []string{"deployment", "runtimeCompatibility", "publication", "receiptBinding"} {
		v := object(k)
		reason, _ := v["reason"].(string)
		if reason == "" || (v["status"] != "BOUND" && v["status"] != "NOT_BOUND") {
			return errors.New("descriptor section status")
		}
	}

	bad := errors.New("mining funding descriptor not admitted")
	h, ok := object("interfaces")["portfolioMiningFundingHandoff"].(map[string]any)
	if !ok {
		return bad
	}
	feature, _ := object("build")["candidateFeatures"].(map[string]any)
	if feature["portfolio-vault-candidate"] != true {
		return bad
	}
	roles := []string{"vault", "action", "owner", "sale", "miningBudget", "miningCapital"}
	accounts := make([]any, len(roles))
	for i, role := range roles {
		accounts[i] = map[string]any{"role": role, "signer": false, "writable": i == 0 || i == 1 || i == 5}
	}
	source, so := object("source")["sourceDigest"].(string)
	contract, co := object("interfaces")["contractDigest"].(string)
	for _, s := range []string{source, contract, p.CapabilitySHA256} {
		decoded, e := hex.DecodeString(s)
		if e != nil || len(decoded) != 32 || hex.EncodeToString(decoded) != s {
			return bad
		}
	}
	if !so || !co {
		return bad
	}
	handoff := map[string]any{"schema": "wen.portfolio-mining-funding-handoff.v1", "requiredFeature": "portfolio-vault-candidate", "operations": []string{"fundMining"}, "portableClient": "client/portfolio-mining-funding-preparation.mjs", "sourceDigest": source, "contractDigest": contract, "instruction": map[string]any{"opcode": 120, "dataLength": 1, "accounts": accounts}}
	encoded, e := wenJSONV1(handoff)
	if e != nil {
		return e
	}
	digest := wenHashV1(bytes.TrimSuffix(encoded, []byte{'\n'}))
	handoff["capabilityDigest"] = digest
	expectedBytes, _ := wenJSONV1(handoff)
	actualBytes, e := wenJSONV1(h)
	if e != nil || !bytes.Equal(expectedBytes, actualBytes) || digest != p.CapabilitySHA256 || object("componentGenerations")["portfolioMiningFundingCapability"] != digest || object("runtimeCompatibility")["portfolioMiningFundingCapability"] != digest {
		return bad
	}
	deployment, _ := object("deployment")["portfolioMiningFunding"].(map[string]any)
	program, e := solana.PublicKeyFromBase58(p.ProgramID)
	if e != nil || program.IsZero() {
		return bad
	}
	var authority any
	if p.UpgradeAuthority != nil {
		authority = hex.EncodeToString(p.UpgradeAuthority[:])
	}
	code, e := hex.DecodeString(p.CodeSHA256)
	if p.DeploymentSlot == 0 || e != nil || len(code) != 32 || hex.EncodeToString(code) != p.CodeSHA256 || deployment["program"] != hex.EncodeToString(program[:]) || deployment["genesis"] != p.Genesis || deployment["deploymentSlot"] != strconv.FormatUint(p.DeploymentSlot, 10) || deployment["deployedBytesHash"] != p.CodeSHA256 || deployment["upgradeAuthority"] != authority {
		return bad
	}
	return nil
}
