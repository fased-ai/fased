package main

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type wenArtifactFixture struct {
	DescriptorBase64, DescriptorSHA256, CapabilitySHA256, OfferBase64, OfferSHA256, PolicyBase64, PolicySHA256 string
	ProgramID, Genesis, SourceAccount, AdmissionAccount                                                        string
	Vector                                                                                                     struct {
		DataBase64 string
		Keys       []signerSATAccountV2
	}
}

func wenArtifactCase(t *testing.T) (string, signerWENBTCPinsV1, signerWENBTCIntentV1, solana.PublicKey, wenArtifactFixture) {
	t.Helper()
	raw, err := os.ReadFile("testdata/wen-btc-signer-artifacts.json")
	if err != nil {
		t.Fatal(err)
	}
	var f wenArtifactFixture
	if err = json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	for hash, b64 := range map[string]string{f.DescriptorSHA256: f.DescriptorBase64, f.OfferSHA256: f.OfferBase64, f.PolicySHA256: f.PolicyBase64} {
		b, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			t.Fatal(err)
		}
		if wenHashV1(b) != hash {
			t.Fatal("fixture digest")
		}
		if err = os.WriteFile(filepath.Join(root, hash), b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	pins := signerWENBTCPinsV1{DescriptorSHA256: f.DescriptorSHA256, CapabilitySHA256: f.CapabilitySHA256, OfferSHA256: f.OfferSHA256, ProgramID: f.ProgramID, Genesis: f.Genesis, SourceAccount: f.SourceAccount, AdmissionAccount: f.AdmissionAccount, CodeSHA256: strings.Repeat("22", 32), DeploymentSlot: 1}
	intent := signerWENBTCIntentV1{Operation: "acceptance", DescriptorSHA256: f.DescriptorSHA256, CapabilitySHA256: f.CapabilitySHA256, OfferSHA256: f.OfferSHA256, ProgramID: f.ProgramID, Genesis: f.Genesis, SourceAccount: f.SourceAccount, MaxCashRaw: "1000000000", MaxCostRaw: "10000000", MaxFeeLamports: "5000", MaxRentLamports: "5000000", MinFinalizedSlot: "100", ExpiresSlot: "200"}
	return root, pins, intent, solana.MustPublicKeyFromBase58(f.Vector.Keys[0].Pubkey), f
}
func TestWENBTCArtifactAcceptanceMatchesRust(t *testing.T) {
	root, pins, intent, wallet, f := wenArtifactCase(t)
	a, err := loadWENBTCAcceptanceV1(root, pins, intent, wallet, 150, 1)
	if err != nil {
		t.Fatal(err)
	}
	data, keys, err := a.acceptanceInstructionForEpoch(7)
	if err != nil {
		t.Fatal(err)
	}
	expected, _ := base64.StdEncoding.DecodeString(f.Vector.DataBase64)
	if !bytes.Equal(data, expected) || !reflect.DeepEqual(keys, f.Vector.Keys) {
		for i := range data {
			if data[i] != expected[i] {
				t.Logf("data mismatch %d: %d != %d", i, data[i], expected[i])
			}
		}
		for i := range keys {
			if keys[i] != f.Vector.Keys[i] {
				t.Logf("key mismatch %d: %v != %v", i, keys[i], f.Vector.Keys[i])
			}
		}
		t.Fatal("canonical mismatch")
	}
	current, _, err := a.acceptanceInstruction(1)
	if err != nil || !bytes.Equal(current[len(current)-8:], make([]byte, 8)) {
		t.Fatal("epoch not derived from time")
	}
	if _, _, err = a.acceptanceInstruction(100); err == nil {
		t.Fatal("expired builder accepted")
	}
	if _, err = normalizeSignerIntentForWalletV2(signerIntentV2{Type: intentWENBTCSubscriptionV1, WENBTC: &intent}, &wallet); err == nil {
		t.Fatal("signing unexpectedly enabled")
	}
}
func TestWENBTCArtifactAdmissionRejectsIntentDrift(t *testing.T) {
	for _, field := range []string{"DescriptorSHA256", "CapabilitySHA256", "OfferSHA256", "ProgramID", "Genesis", "SourceAccount", "Operation", "MaxCashRaw", "MaxCostRaw"} {
		t.Run(field, func(t *testing.T) {
			root, pins, intent, wallet, _ := wenArtifactCase(t)
			value := "1"
			if strings.HasSuffix(field, "SHA256") {
				value = strings.Repeat("1", 64)
			}
			if field == "ProgramID" || field == "Genesis" {
				value = intent.SourceAccount
			}
			if field == "SourceAccount" {
				value = intent.ProgramID
			}
			if field == "Operation" {
				value = "acquisition"
			}
			reflect.ValueOf(&intent).Elem().FieldByName(field).SetString(value)
			if _, err := loadWENBTCAcceptanceV1(root, pins, intent, wallet, 150, 1); err == nil {
				t.Fatal("drift accepted")
			}
		})
	}
}
func TestWENBTCArtifactFileAndTimeBoundaries(t *testing.T) {
	for _, name := range []string{"modified", "symlink", "oversize", "writable", "missing-policy", "buyer", "slot-low", "slot-expired", "deadline", "deployment"} {
		t.Run(name, func(t *testing.T) {
			root, pins, intent, wallet, f := wenArtifactCase(t)
			slot, now := uint64(150), uint64(1)
			path := filepath.Join(root, f.OfferSHA256)
			switch name {
			case "modified":
				b, _ := os.ReadFile(path)
				b[50] ^= 1
				os.WriteFile(path, b, 0600)
			case "symlink":
				os.Remove(path)
				os.Symlink(filepath.Join(root, f.PolicySHA256), path)
			case "oversize":
				os.WriteFile(path, make([]byte, 465), 0600)
			case "writable":
				os.Chmod(path, 0666)
			case "missing-policy":
				os.Remove(filepath.Join(root, f.PolicySHA256))
			case "buyer":
				wallet = solana.MustPublicKeyFromBase58(pins.ProgramID)
			case "slot-low":
				slot = 99
			case "slot-expired":
				slot = 200
			case "deadline":
				now = 100
			case "deployment":
				pins.CodeSHA256 = strings.Repeat("33", 32)
			}
			if _, err := loadWENBTCAcceptanceV1(root, pins, intent, wallet, slot, now); err == nil {
				t.Fatal("invalid admission accepted")
			}
		})
	}
}
func TestWENBTCArtifactRejectsRepinnedInvalidTerms(t *testing.T) {
	for _, name := range []string{"allocation", "overflow", "zero-buyer", "custody-alias", "policy"} {
		t.Run(name, func(t *testing.T) {
			root, pins, intent, wallet, f := wenArtifactCase(t)
			b, _ := base64.StdEncoding.DecodeString(f.OfferBase64)
			switch name {
			case "allocation":
				b[328+10*8]++
			case "overflow":
				for i := 0; i < 8; i++ {
					b[328+6*8+i] = 255
				}
			case "zero-buyer":
				clear(b[72:104])
			case "custody-alias":
				copy(b[8+6*32:8+7*32], b[8+7*32:8+8*32])
			case "policy":
				p, _ := base64.StdEncoding.DecodeString(f.PolicyBase64)
				p[8] ^= 1
				hash := wenHashV1(p)
				os.WriteFile(filepath.Join(root, hash), p, 0600)
				decoded, _ := hex.DecodeString(hash)
				copy(b[40:72], decoded)
			}
			hash := wenHashV1(b)
			os.WriteFile(filepath.Join(root, hash), b, 0600)
			pins.OfferSHA256 = hash
			intent.OfferSHA256 = hash
			if _, err := loadWENBTCAcceptanceV1(root, pins, intent, wallet, 150, 1); err == nil {
				t.Fatal("invalid repinned terms accepted")
			}
		})
	}
}

func TestWENBTCArtifactRejectsRepinnedDescriptorMismatch(t *testing.T) {
	for _, name := range []string{"runtime", "runtime-capability", "component-capability", "source", "deployment"} {
		t.Run(name, func(t *testing.T) {
			root, pins, intent, wallet, f := wenArtifactCase(t)
			raw, _ := base64.StdEncoding.DecodeString(f.DescriptorBase64)
			var envelope map[string]json.RawMessage
			if err := json.Unmarshal(raw, &envelope); err != nil {
				t.Fatal(err)
			}
			section, field, want := "runtimeCompatibility", "status", "descriptor section not bound"
			value := any("NOT_BOUND")
			switch name {
			case "runtime-capability":
				field = "btcSubscriptionCapability"
				value = strings.Repeat("1", 64)
				want = "descriptor capability not acknowledged"
			case "component-capability":
				section = "componentGenerations"
				field = "btcSubscriptionCapability"
				value = strings.Repeat("1", 64)
				want = "descriptor capability not acknowledged"
			case "source":
				section = "source"
				field = "sourceDigest"
				value = strings.Repeat("1", 64)
				want = "descriptor BTC instruction binding"
			case "deployment":
				section = "deployment"
				field = "btcSubscription"
				value = map[string]any{}
				want = "descriptor differs from signer deployment pins"
			}
			var nested map[string]json.RawMessage
			if err := json.Unmarshal(envelope[section], &nested); err != nil {
				t.Fatal(err)
			}
			nested[field], _ = json.Marshal(value)
			envelope[section], _ = json.Marshal(nested)
			candidate, _ := json.Marshal(envelope)
			var payload map[string]any
			dec := json.NewDecoder(bytes.NewReader(candidate))
			dec.UseNumber()
			if err := dec.Decode(&payload); err != nil {
				t.Fatal(err)
			}
			delete(payload, "descriptorDigest")
			canonical, err := wenJSONV1(payload)
			if err != nil {
				t.Fatal(err)
			}
			envelope["descriptorDigest"], _ = json.Marshal("sha256:" + wenHashV1(canonical))
			candidate, _ = json.Marshal(envelope)
			hash := wenHashV1(candidate)
			if err = os.WriteFile(filepath.Join(root, hash), candidate, 0600); err != nil {
				t.Fatal(err)
			}
			pins.DescriptorSHA256 = hash
			intent.DescriptorSHA256 = hash
			if _, err = loadWENBTCAcceptanceV1(root, pins, intent, wallet, 150, 1); err == nil || !strings.Contains(err.Error(), want) {
				t.Fatalf("expected %s, got %v", want, err)
			}
		})
	}
}
