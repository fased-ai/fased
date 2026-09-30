package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"path/filepath"
	"strconv"

	solana "github.com/gagliardetto/solana-go"
)

// Signer-owned reviewed configuration, never populated from the intent or RPC.
// These pins identify admitted files; live deployment/custody proof is separate.
type signerWENBTCPinsV1 struct {
	DescriptorSHA256, CapabilitySHA256, OfferSHA256     string
	ProgramID, Genesis, SourceAccount, AdmissionAccount string
	CodeSHA256                                          string
	DeploymentSlot                                      uint64
	UpgradeAuthority                                    *solana.PublicKey
}

type signerWENBTCArtifactsV1 struct {
	program, source, admission solana.PublicKey
	offer                      [464]byte
	policy                     [96]byte
	keys                       [10]solana.PublicKey
	numbers                    [17]uint64
}

func wenHashV1(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func wenJSONV1(v any) ([]byte, error) {
	var out bytes.Buffer
	e := json.NewEncoder(&out)
	e.SetEscapeHTML(false)
	if err := e.Encode(v); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
func wenCompactV1(b []byte) ([]byte, error) {
	var out bytes.Buffer
	err := json.Compact(&out, b)
	return out.Bytes(), err
}

// Uses the signer's bounded, owner-checked non-symlink file reader. Request
// strings are hashes only; the caller cannot select arbitrary filesystem paths.
func readWENBTCObjectV1(root, digest string, limit int64) ([]byte, error) {
	if len(digest) != 64 {
		return nil, errors.New("invalid artifact digest")
	}
	decoded, err := hex.DecodeString(digest)
	if err != nil || hex.EncodeToString(decoded) != digest || !filepath.IsAbs(root) || filepath.Clean(root) != root {
		return nil, errors.New("invalid artifact store binding")
	}
	b, err := readSignerAdminJSONFile(filepath.Join(root, digest), limit)
	if err != nil {
		return nil, err
	}
	if wenHashV1(b) != digest {
		return nil, errors.New("artifact digest mismatch")
	}
	return b, nil
}

func loadWENBTCAcceptanceV1(root string, pins signerWENBTCPinsV1, intent signerWENBTCIntentV1, wallet solana.PublicKey, slot, now uint64) (signerWENBTCArtifactsV1, error) {
	return loadWENBTCArtifactsV1(root, pins, intent, wallet, slot, now, "acceptance")
}

func loadWENBTCArtifactsV1(root string, pins signerWENBTCPinsV1, intent signerWENBTCIntentV1, wallet solana.PublicKey, slot, now uint64, operation string) (signerWENBTCArtifactsV1, error) {
	var out signerWENBTCArtifactsV1
	if err := validateWENBTCIntentV1(intent); err != nil {
		return out, err
	}
	if intent.Operation != operation || intent.DescriptorSHA256 != pins.DescriptorSHA256 || intent.CapabilitySHA256 != pins.CapabilitySHA256 || intent.OfferSHA256 != pins.OfferSHA256 || intent.ProgramID != pins.ProgramID || intent.Genesis != pins.Genesis || intent.SourceAccount != pins.SourceAccount {
		return out, errors.New("intent differs from signer-owned admission")
	}
	min, _ := strconv.ParseUint(intent.MinFinalizedSlot, 10, 64)
	expiry, _ := strconv.ParseUint(intent.ExpiresSlot, 10, 64)
	if slot < min || slot >= expiry {
		return out, errors.New("intent outside finalized slot lifetime")
	}
	for _, binding := range []struct {
		text   string
		target *solana.PublicKey
	}{{pins.ProgramID, &out.program}, {pins.SourceAccount, &out.source}, {pins.AdmissionAccount, &out.admission}} {
		text, target := binding.text, binding.target
		key, err := solana.PublicKeyFromBase58(text)
		if err != nil || key.IsZero() || key.String() != text {
			return out, errors.New("invalid pinned account")
		}
		*target = key
	}
	descriptor, err := readWENBTCObjectV1(root, pins.DescriptorSHA256, 32768)
	if err != nil {
		return out, err
	}
	if err = validateWENBTCDescriptorV1(descriptor, pins); err != nil {
		return out, err
	}
	offer, err := readWENBTCObjectV1(root, pins.OfferSHA256, 464)
	if err != nil {
		return out, err
	}
	if len(offer) != 464 || string(offer[:8]) != "WENBTCO1" {
		return out, errors.New("invalid offer wire")
	}
	copy(out.offer[:], offer)
	for i := range out.keys {
		copy(out.keys[i][:], offer[8+32*i:40+32*i])
		if out.keys[i].IsZero() {
			return out, errors.New("zero offer identity")
		}
	}
	for i := range out.numbers {
		out.numbers[i] = binary.LittleEndian.Uint64(offer[328+8*i : 336+8*i])
	}
	if out.keys[2] != wallet || wallet.IsZero() {
		return out, errors.New("offer buyer differs from signer wallet")
	}
	if err = out.validateTerms(now); err != nil {
		return out, err
	}
	maxCash, _ := strconv.ParseUint(intent.MaxCashRaw, 10, 64)
	maxCost, _ := strconv.ParseUint(intent.MaxCostRaw, 10, 64)
	if out.numbers[4] > maxCash || out.numbers[12] > maxCost {
		return out, errors.New("offer exceeds reviewed cash or conversion cost")
	}
	// Activation policy is consumed by acceptance only. Acquisition binds the
	// exact offer commitment in the finalized funded record instead.
	if operation == "acquisition" {
		return out, nil
	}
	policy, err := readWENBTCObjectV1(root, hex.EncodeToString(out.keys[1][:]), 96)
	if err != nil {
		return out, err
	}
	if len(policy) != 96 || (string(policy[:8]) != "WENACT01" && string(policy[:8]) != "WENACT03") || !bytes.Equal(policy[8:40], out.keys[3][:]) {
		return out, errors.New("activation policy differs from offer")
	}
	copy(out.policy[:], policy)
	return out, nil
}

func validateWENBTCDescriptorV1(raw []byte, p signerWENBTCPinsV1) error {
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
				Schema            string          `json:"schema"`
				Operations        []string        `json:"operations"`
				InstructionDigest string          `json:"instructionDigest"`
				CapabilityDigest  string          `json:"capabilityDigest"`
				SourceDigest      string          `json:"sourceDigest"`
				ContractDigest    string          `json:"contractDigest"`
				PortableClient    string          `json:"portableClient"`
				Instructions      json.RawMessage `json:"instructions"`
			} `json:"btcSubscriptionHandoff"`
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
		Opcode int `json:"opcode"`
	}
	if err = json.Unmarshal(instructions, &ops); err != nil {
		return err
	}
	if h.Schema != "wen.btc-subscription-handoff-candidate.v1" || h.PortableClient != "client/btc-subscription-client.mjs" || len(h.Operations) != 2 || h.Operations[0] != "acceptance" || h.Operations[1] != "acquisition" || len(ops) != 2 || ops[0].Opcode != 111 || ops[1].Opcode != 112 || wenHashV1(instructions) != h.InstructionDigest || h.SourceDigest != object("source")["sourceDigest"] || h.ContractDigest != object("interfaces")["contractDigest"] {
		return errors.New("descriptor BTC instruction binding")
	}
	capability := struct {
		Operations        []string `json:"operations"`
		InstructionDigest string   `json:"instructionDigest"`
		SourceDigest      string   `json:"sourceDigest"`
		ContractDigest    string   `json:"contractDigest"`
		PortableClient    string   `json:"portableClient"`
	}{h.Operations, h.InstructionDigest, h.SourceDigest, h.ContractDigest, h.PortableClient}
	encoded, err := wenJSONV1(capability)
	if err != nil {
		return err
	}
	digest := wenHashV1(bytes.TrimSuffix(encoded, []byte{'\n'}))
	if digest != p.CapabilitySHA256 || h.CapabilityDigest != digest || object("componentGenerations")["btcSubscriptionCapability"] != digest || object("runtimeCompatibility")["btcSubscriptionCapability"] != digest {
		return errors.New("descriptor capability not acknowledged")
	}
	deployment, _ := object("deployment")["btcSubscription"].(map[string]any)
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

func (a signerWENBTCArtifactsV1) validateTerms(now uint64) error {
	k, n := a.keys, a.numbers
	if k[3] == k[4] {
		return errors.New("offer mint alias")
	}
	for _, pair := range [][2]int{{6, 7}, {6, 8}, {6, 9}, {7, 8}, {7, 9}} {
		if k[pair[0]] == k[pair[1]] {
			return errors.New("offer custody alias")
		}
	}
	if n[1] == 0 || n[4] == 0 || n[5] == 0 || n[10] == 0 || n[13] == 0 || now >= n[14] || n[14] > n[15] || n[15] >= n[16] {
		return errors.New("offer amount or deadline")
	}
	sum := func(values ...uint64) (uint64, error) {
		var total uint64
		for _, v := range values {
			if v > ^uint64(0)-total {
				return 0, errors.New("offer sum overflow")
			}
			total += v
		}
		return total, nil
	}
	gross, err := sum(n[5:9]...)
	if err != nil {
		return err
	}
	before, err := sum(n[2], n[3])
	if err != nil || before == 0 {
		return errors.New("offer supply denominator")
	}
	after, err := sum(before, gross)
	if err != nil {
		return err
	}
	ratio := new(big.Int).Mul(new(big.Int).SetUint64(n[1]), new(big.Int).SetUint64(gross))
	ratio.Add(ratio, new(big.Int).SetUint64(before-1))
	ratio.Div(ratio, new(big.Int).SetUint64(before))
	if !ratio.IsUint64() {
		return errors.New("offer retained overflow")
	}
	retained := ratio.Uint64()
	floor := after / 100000
	if after%100000 != 0 {
		floor++
	}
	if floor > n[1] && floor-n[1] > retained {
		retained = floor - n[1]
	}
	if _, err = sum(n[1], retained); err != nil {
		return err
	}
	committed, err := sum(retained, n[9])
	if err != nil || retained == 0 || n[4] <= committed {
		return errors.New("offer retained funding")
	}
	designated, err := sum(n[10], n[11], n[12])
	if err != nil || designated != n[4]-committed {
		return errors.New("offer allocation mismatch")
	}
	return nil
}

// Independently derives all acceptance accounts; never takes a client key list.
// Returns unsigned source instruction only, not an admitted/signable transaction.
func (a signerWENBTCArtifactsV1) acceptanceInstruction(now uint64) ([]byte, []signerSATAccountV2, error) {
	if err := a.validateTerms(now); err != nil {
		return nil, nil, err
	}
	return a.acceptanceInstructionForEpoch(now / 28800)
}

// Wire-only helper mirrors the Rust builder; execution must use the time-checked wrapper.
func (a signerWENBTCArtifactsV1) acceptanceInstructionForEpoch(epoch uint64) ([]byte, []signerSATAccountV2, error) {
	if err := a.validateTerms(0); err != nil {
		return nil, nil, err
	}
	var derivationError error
	derive := func(program solana.PublicKey, seeds ...[]byte) solana.PublicKey {
		key, _, err := solana.FindProgramAddress(seeds, program)
		if err != nil {
			derivationError = err
		}
		return key
	}
	u64 := func(v uint64) []byte { b := make([]byte, 8); binary.LittleEndian.PutUint64(b, v); return b }
	k := a.keys
	s := k[0][:]
	program := a.program
	token := solana.TokenProgramID
	ray := solana.MustPublicKeyFromBase58("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C")
	var config solana.PublicKey
	copy(config[:], a.policy[40:72])
	record := derive(program, []byte("wen-btc-subscription-v1"), s, k[2][:], u64(a.numbers[0]))
	mint := derive(program, []byte("wen-sat-mint-v1"), s)
	left, right := mint, k[3]
	if bytes.Compare(left[:], right[:]) > 0 {
		left, right = right, left
	}
	pool := derive(ray, []byte("pool"), config[:], left[:], right[:])
	lp := derive(ray, []byte("pool_lp_mint"), pool[:])
	creator := derive(program, []byte("wen-pool-creator-v1"), s)
	ownedLP := derive(solana.SPLAssociatedTokenAccountProgramID, creator[:], token[:], lp[:])
	paid := derive(program, []byte("wen-paid-primary-v1"), s, record[:])
	keys := []solana.PublicKey{k[2], a.source, derive(program, []byte("wen-allocation-v1"), s, []byte{0}), k[6], k[8], record, k[3], token, {}, paid,
		derive(program, []byte("wen-issuance-epoch-v1"), s, u64(epoch)), derive(program, []byte("wen-sat-promises-v1"), s), derive(program, []byte("wen-paid-release-v1"), s), mint,
		derive(program, []byte("wen-reserve-ledger-v1"), s), k[0], derive(program, []byte("wen-subscription-custody-v1"), paid[:]), solana.Token2022ProgramID, derive(program, []byte("wen-activation-v1"), s), pool, config,
		derive(ray, []byte("pool_vault"), pool[:], mint[:]), derive(ray, []byte("pool_vault"), pool[:], k[3][:]), lp, ownedLP, k[4], a.admission}
	if derivationError != nil {
		return nil, nil, derivationError
	}
	writable := map[int]bool{0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 9: true, 10: true, 11: true, 12: true, 14: true, 16: true}
	seen := map[solana.PublicKey]bool{}
	accounts := make([]signerSATAccountV2, len(keys))
	for i, key := range keys {
		if seen[key] {
			return nil, nil, fmt.Errorf("acceptance account alias at %d", i)
		}
		seen[key] = true
		accounts[i] = signerSATAccountV2{Pubkey: key.String(), IsSigner: i == 0, IsWritable: writable[i]}
	}
	data := append([]byte{111}, a.offer[:]...)
	data = append(data, a.policy[:]...)
	data = append(data, u64(epoch)...)
	return data, accounts, nil
}
