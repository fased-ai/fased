package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func miningClaimReviewDescriptor(t *testing.T, p wenStakingPinsV1) ([]byte, wenStakingPinsV1) {
	t.Helper()
	cwd, _ := os.Getwd()
	root := filepath.Clean(filepath.Join(cwd, "../.."))
	output := filepath.Join(t.TempDir(), "descriptor.json")
	program := solana.MustPublicKeyFromBase58(p.ProgramID)
	args, _ := json.Marshal(map[string]any{"program": hex.EncodeToString(program[:]), "genesis": p.Genesis, "deployedBytesHash": p.CodeSHA256})
	script := `import {pathToFileURL} from 'node:url';import {writeFileSync} from 'node:fs';const p=JSON.parse(process.argv[3]);const {claimDescriptorFixture}=await import(pathToFileURL(process.argv[1]+'/tools/fased-signerd/testdata/wen-protocol/scripts/claim-descriptor-fixture.mjs'));const f=await claimDescriptorFixture({...p,deploymentSlot:1n,upgradeAuthority:null},p.genesis);writeFileSync(process.argv[2],f.bytes,{flag:'wx'});`
	cmd := exec.Command("node", "--input-type=module", "-e", script, root, output, string(args))
	if out, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("%v %s", e, out)
	}
	raw, e := os.ReadFile(output)
	if e != nil {
		t.Fatal(e)
	}
	var d struct {
		Interfaces struct {
			H struct {
				CapabilityDigest string `json:"capabilityDigest"`
			} `json:"miningClaimHandoff"`
		} `json:"interfaces"`
	}
	if e = json.Unmarshal(raw, &d); e != nil {
		t.Fatal(e)
	}
	p.DescriptorSHA256 = wenHashV1(raw)
	p.CapabilitySHA256 = d.Interfaces.H.CapabilityDigest
	return raw, p
}
func TestWENMiningClaimReviewedRead(t *testing.T) {
	v, w, p, f := miningClaimRPCFixture(t, "sol")
	raw, p := miningClaimReviewDescriptor(t, p)
	v.DescriptorSHA256 = p.DescriptorSHA256
	v.CapabilitySHA256 = p.CapabilitySHA256
	initial, e := readWENMiningClaimRPCV1(context.Background(), f, p, v, w, 2)
	if e != nil {
		t.Fatal(e)
	}
	v.AccountStateSHA256 = initial.StateHash
	for _, mode := range []string{"ok", "wallet", "intent", "budget", "lag", "pin", "mode", "symlink", "missing-descriptor", "bad-descriptor", "changed-review", "changed-descriptor", "changed-state", "during-read", "unknown-field"} {
		t.Run(mode, func(t *testing.T) {
			r := wenMiningClaimReviewV1{Version: 1, WalletID: "miner", WalletPublicKey: w.String(), Intent: v, Pins: p, MaxSlotLag: 2, MaxTotalCostLamports: 5000}
			switch mode {
			case "wallet":
				r.WalletPublicKey = "bad"
			case "intent":
				r.Intent.MinimumReceived = "2"
			case "budget":
				r.MaxTotalCostLamports = 4999
			case "lag":
				r.MaxSlotLag = 33
			case "pin":
				r.Pins.Genesis = "wrong"
			}
			db := filepath.Join(t.TempDir(), "state.db")
			root := filepath.Join(filepath.Dir(db), "wen-mining-claim", wenHashV1([]byte("miner")))
			if e := os.MkdirAll(root, 0700); e != nil {
				t.Fatal(e)
			}
			path := filepath.Join(root, wenMiningClaimAdmissionNameV1(v))
			descriptor := filepath.Join(root, p.DescriptorSHA256)
			write := func() {
				b, _ := json.Marshal(r)
				if mode == "unknown-field" {
					b = append(bytes.TrimSuffix(b, []byte("}")), []byte(`,"maxRentLamports":1}`)...)
				}
				if e := os.WriteFile(path, b, 0600); e != nil {
					t.Fatal(e)
				}
			}
			write()
			if e := os.WriteFile(descriptor, raw, 0600); e != nil {
				t.Fatal(e)
			}
			switch mode {
			case "mode":
				os.Chmod(path, 0666)
			case "symlink":
				os.Rename(path, path+"-real")
				os.Symlink(path+"-real", path)
			case "missing-descriptor":
				os.Remove(descriptor)
			case "bad-descriptor":
				os.WriteFile(descriptor, []byte("{}"), 0600)
			}
			c, owner, e := loadWENMiningClaimAdmissionV1(db, "miner", v)
			good := mode == "ok" || mode == "changed-review" || mode == "changed-descriptor" || mode == "changed-state" || mode == "during-read"
			if (e == nil) != good {
				t.Fatal("admission", e)
			}
			if !good {
				return
			}
			if mode == "changed-review" {
				r.MaxSlotLag++
				write()
			}
			if mode == "changed-descriptor" {
				os.WriteFile(descriptor, []byte("{}"), 0600)
			}
			if e = recheckWENMiningClaimReviewV1(db, "miner", v, c, owner); (e == nil) != (mode != "changed-review" && mode != "changed-descriptor") {
				t.Fatal("recheck", e)
			}
			if mode == "ok" || mode == "changed-state" || mode == "during-read" {
				f.calls = 0
				if mode == "changed-state" {
					f.page.Value[4].Lamports++
					defer func() { f.page.Value[4].Lamports-- }()
				}
				reader := &miningClaimReviewRaceRPC{miningClaimRPCFake: f}
				if mode == "during-read" {
					reader.after = func() { r.MaxSlotLag++; write() }
				}
				out, e := readReviewedWENMiningClaimV1(context.Background(), db, "miner", v, reader)
				if (e == nil) != (mode == "ok") {
					t.Fatal("reviewed read", out, e)
				}
			}
		})
	}
}

type miningClaimReviewRaceRPC struct {
	*miningClaimRPCFake
	after func()
}

func (f *miningClaimReviewRaceRPC) GetSlot(ctx context.Context, c rpc.CommitmentType) (uint64, error) {
	n, e := f.miningClaimRPCFake.GetSlot(ctx, c)
	if f.after != nil {
		f.after()
	}
	return n, e
}
