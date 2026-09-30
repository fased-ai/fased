package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"strconv"
)

func validateWENMiningDescriptorV1(raw []byte, p wenMiningPinsV1) error {
	if len(raw) == 0 || len(raw) > 32768 || wenHashV1(raw) != p.DescriptorSHA256 {
		return errors.New("mining descriptor pin mismatch")
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
	var envelope struct {
		Interfaces struct {
			Handoff struct {
				Stage              string          `json:"stage"`
				PublicEntryEnabled *bool           `json:"publicEntryEnabled"`
				EntryLayout        json.RawMessage `json:"entryLayout"`
				Schema             string          `json:"schema"`
				Operations         []string        `json:"operations"`
				InstructionDigest  string          `json:"instructionDigest"`
				CapabilityDigest   string          `json:"capabilityDigest"`
				SourceDigest       string          `json:"sourceDigest"`
				ContractDigest     string          `json:"contractDigest"`
				PortableClient     string          `json:"portableClient"`
				Instructions       json.RawMessage `json:"instructions"`
			} `json:"miningCommitmentHandoff"`
		} `json:"interfaces"`
	}
	if err = json.Unmarshal(raw, &envelope); err != nil {
		return err
	}
	h := envelope.Interfaces.Handoff
	instructions, err := wenCompactV1(h.Instructions)
	if err != nil {
		return err
	}
	var ops []struct {
		Opcode     int    `json:"opcode"`
		Name       string `json:"name"`
		DataLength int    `json:"dataLength"`
		Accounts   []struct {
			Role     string `json:"role"`
			Signer   *bool  `json:"signer"`
			Writable *bool  `json:"writable"`
		} `json:"accounts"`
	}
	if err = json.Unmarshal(instructions, &ops); err != nil {
		return err
	}
	if !wenReservationHashV1(h.SourceDigest) || !wenReservationHashV1(h.ContractDigest) || h.Schema != "wen.mining-commitment-handoff-candidate.v1" || h.PortableClient != "client/mining-commitment-client.mjs" || len(h.Operations) != 2 || h.Operations[0] != "commit" || h.Operations[1] != "reveal" || len(ops) != 2 || ops[0].Opcode != 54 || ops[1].Opcode != 55 || wenHashV1(instructions) != h.InstructionDigest || h.SourceDigest != object("source")["sourceDigest"] || h.ContractDigest != object("interfaces")["contractDigest"] {
		return errors.New("descriptor mining instruction binding")
	}
	if h.Stage != "source-candidate" || h.PublicEntryEnabled == nil || *h.PublicEntryEnabled {
		return errors.New("invalid mining candidate boundary")
	}
	var layout struct {
		Magic   string `json:"magic"`
		Version int    `json:"version"`
		Length  int    `json:"length"`
	}
	if json.Unmarshal(h.EntryLayout, &layout) != nil || layout.Magic != "WENMEN01" || layout.Version != 1 || layout.Length != 272 {
		return errors.New("invalid mining entry layout")
	}
	layoutBytes, err := wenCompactV1(h.EntryLayout)
	if err != nil {
		return err
	}
	roles := []string{"owner", "entry"}
	for n, op := range ops {
		if op.Name != []string{"mining_commitment::commit_instruction", "mining_commitment::reveal_instruction"}[n] || op.DataLength != []int{33, 41}[n] || len(op.Accounts) != 2 {
			return errors.New("invalid mining instruction shape")
		}
		for j, a := range op.Accounts {
			if a.Role != roles[j] || a.Signer == nil || a.Writable == nil || *a.Signer != (j == 0) || *a.Writable != (j == 1) {
				return errors.New("invalid mining instruction accounts")
			}
		}
	}
	capability := struct {
		Operations        []string        `json:"operations"`
		InstructionDigest string          `json:"instructionDigest"`
		EntryLayout       json.RawMessage `json:"entryLayout"`
		SourceDigest      string          `json:"sourceDigest"`
		ContractDigest    string          `json:"contractDigest"`
		PortableClient    string          `json:"portableClient"`
	}{h.Operations, h.InstructionDigest, layoutBytes, h.SourceDigest, h.ContractDigest, h.PortableClient}
	encoded, err := wenJSONV1(capability)
	if err != nil {
		return err
	}
	digest := wenHashV1(bytes.TrimSuffix(encoded, []byte{'\n'}))
	if digest != p.CapabilitySHA256 || h.CapabilityDigest != digest || object("componentGenerations")["miningCommitmentCapability"] != digest || object("runtimeCompatibility")["miningCommitmentCapability"] != digest {
		return errors.New("descriptor capability not acknowledged")
	}
	deployment, _ := object("deployment")["miningCommitment"].(map[string]any)
	program, err := solana.PublicKeyFromBase58(p.ProgramID)
	if err != nil {
		return err
	}
	var authority any
	if p.UpgradeAuthority != nil {
		authority = hex.EncodeToString(p.UpgradeAuthority[:])
	}
	code, codeErr := hex.DecodeString(p.CodeSHA256)
	if p.DeploymentSlot == 0 || codeErr != nil || len(code) != 32 || hex.EncodeToString(code) != p.CodeSHA256 || deployment["program"] != hex.EncodeToString(program[:]) || deployment["genesis"] != p.Genesis || deployment["deploymentSlot"] != strconv.FormatUint(p.DeploymentSlot, 10) || deployment["deployedBytesHash"] != p.CodeSHA256 || deployment["upgradeAuthority"] != authority {
		return errors.New("descriptor differs from signer deployment pins")
	}
	return nil
}

// Bootstrap admission verifies descriptor semantics as well as protected review.
// This does not install a review, admit a deployment, or enable public signing.
func loadWENMiningAdmissionV1(dbPath, walletID string, v signerWENMiningIntentV1) (wenMiningExecutionConfigV1, solana.PublicKey, error) {
	c, w, e := loadWENMiningReviewV1(dbPath, walletID, v)
	if e != nil {
		return c, w, e
	}
	raw, e := readWENBTCObjectV1(c.Root, c.Pins.DescriptorSHA256, 32768)
	if e != nil {
		return c, w, e
	}
	e = validateWENMiningDescriptorV1(raw, c.Pins)
	return c, w, e
}
