package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func directCampaignStakeFixture(t *testing.T, same bool) (signerWENStakingIntentV1, wenCampaignClaimSnapshotV1, wenStakingHistorySnapshotV1) {
	v, owner, h := stakingHistoryFixture(t, same)
	s := campaignClaimExecutionSnapshot(solana.MustPublicKeyFromBase58(v.ProgramID), solana.MustPublicKeyFromBase58(v.Sale), owner)
	s.Slot = h.Slot
	s.ReferenceSlot = h.Slot
	for _, a := range []*signerWENBTCAccountV1{&s.Position, &s.Page, &s.Mint, &s.Destination, &s.Windows[0].Window, &s.Windows[0].Vault} {
		a.Slot = h.Slot
	}
	custody, _, _ := solana.FindProgramAddress([][]byte{[]byte("wen-stake-custody-v1"), s.Economy[:]}, s.Program)
	s.Destination.Address = custody
	copy(s.Destination.Data[32:], h.Pool.Address[:])
	binary.LittleEndian.PutUint64(s.Destination.Data[64:], 100)
	v.TokenAccount = s.Windows[0].Vault.Address.String()
	v.Amount = "1000"
	return v, s, h
}
func TestWENCampaignClaimStakeParityV1(t *testing.T) {
	for _, same := range []bool{false, true} {
		v, s, h := directCampaignStakeFixture(t, same)
		if same {
			s.Windows[0].Window.Data[11] = 62
		}
		ix, result, e := buildWENCampaignClaimStakeV1(v, 970, s, h)
		if e != nil {
			t.Fatal(e)
		}
		if result.Amounts.Net != 970 || result.Amounts.Fee != 30 || result.NextPosition != 1070 || result.NextTotal != 1070 || result.NextCustodied != 1070 || result.EffectiveDay != 11 {
			t.Fatal("wrong direct stake accounting", result)
		}
		wantRent := 2
		if same {
			wantRent = 0
		}
		if len(result.RentBytes) != wantRent {
			t.Fatal("wrong account rent")
		}
		hash := solana.Hash(solana.NewWallet().PublicKey())
		message, e := compileWENCampaignClaimStakeV1(ix, s.Owner, hash, 100, 200)
		if e != nil {
			t.Fatal(e)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		cmd := exec.CommandContext(ctx, "node", "--input-type=module", "-e", `
import {compileClaimToStake} from './client/claim-to-stake-builder.mjs';
import * as sdk from '../../../wen/node_modules/@solana/kit/dist/index.node.mjs';
let raw='';for await(const b of process.stdin)raw+=b;const x=JSON.parse(raw),v=x.v,s=x.s;
const issuer=Buffer.from(s.Position.Data,'base64').subarray(48,80);const asAddress=sdk.getAddressDecoder().decode(issuer);
const p=await compileClaimToStake(sdk,{kind:'campaign',input:{program:s.Program,owner:s.Owner,sale:s.Economy,issuer:asAddress,minimumNet:970n,day:BigInt(v.day),last:BigInt(v.last),aggregateFrom:BigInt(v.aggregateFrom),page:0n,mask:s.Mask,windows:s.Windows.map(w=>({window:w.Window.Address,vault:w.Vault.Address}))},lifetime:{blockhash:x.hash,currentBlockHeight:100n,lastValidBlockHeight:200n}});
console.log(JSON.stringify({data:Buffer.from(p.instruction.data).toString('hex'),accounts:p.instruction.accounts,message:Buffer.from(p.transaction.messageBytes).toString('hex')}));`)
		cmd.Dir, _ = filepath.Abs("../../../token/sat/wen-genesis")
		raw, _ := json.Marshal(map[string]any{"v": v, "s": s, "hash": hash.String()})
		cmd.Stdin = bytes.NewReader(raw)
		out, e := cmd.CombinedOutput()
		cancel()
		if e != nil {
			t.Fatalf("direct SDK %v %s", e, out)
		}
		var expected struct {
			Data, Message string
			Accounts      []struct {
				Address              solana.PublicKey
				IsWritable, IsSigner bool
			}
		}
		if e = json.Unmarshal(out, &expected); e != nil {
			t.Fatal(e)
		}
		data, _ := ix.Data()
		if expected.Data != hex.EncodeToString(data) || len(expected.Accounts) != len(ix.Accounts()) {
			t.Fatal("direct instruction parity")
		}
		sdkMessage, e := hex.DecodeString(expected.Message)
		if e != nil {
			t.Fatal(e)
		}
		decode := func(message []byte) *solana.Transaction {
			wire := make([]byte, 65+len(message))
			wire[0] = 1
			copy(wire[65:], message)
			tx, e := solana.TransactionFromBytes(wire)
			if e != nil {
				t.Fatal(e)
			}
			return tx
		}
		goTx, sdkTx := decode(message), decode(sdkMessage)
		if goTx.Message.Header != sdkTx.Message.Header || goTx.Message.RecentBlockhash != sdkTx.Message.RecentBlockhash || len(goTx.Message.Instructions) != 2 || len(sdkTx.Message.Instructions) != 2 {
			t.Fatal("direct envelope mismatch")
		}
		// Libraries order equal-role keys differently. Compare resolved accounts,
		// permissions, instruction data and lifetime rather than table indices.
		for i, g := range goTx.Message.Instructions {
			k := sdkTx.Message.Instructions[i]
			if goTx.Message.AccountKeys[g.ProgramIDIndex] != sdkTx.Message.AccountKeys[k.ProgramIDIndex] || !bytes.Equal(g.Data, k.Data) || len(g.Accounts) != len(k.Accounts) {
				t.Fatal("compiled instruction mismatch")
			}
			for j, n := range g.Accounts {
				if goTx.Message.AccountKeys[n] != sdkTx.Message.AccountKeys[k.Accounts[j]] {
					t.Fatal("compiled account mismatch")
				}
			}
		}

		for i, k := range ix.Accounts() {
			a := expected.Accounts[i]
			if k.PublicKey != a.Address || k.IsSigner != a.IsSigner || k.IsWritable != a.IsWritable {
				t.Fatal("direct account parity")
			}
		}
		if _, e = compileWENCampaignClaimStakeV1(ix, s.Owner, hash, 200, 200); e == nil {
			t.Fatal("expired direct envelope")
		}
		if _, _, e = buildWENCampaignClaimStakeV1(v, 971, s, h); e == nil {
			t.Fatal("minimum net ignored")
		}
		if _, _, e = buildWENCampaignClaimV1(s); e == nil {
			t.Fatal("staking custody accepted as wallet claim")
		}
	}
	changes := map[string]func(*signerWENStakingIntentV1, *wenCampaignClaimSnapshotV1, *wenStakingHistorySnapshotV1){
		"pending-exit": func(v *signerWENStakingIntentV1, s *wenCampaignClaimSnapshotV1, h *wenStakingHistorySnapshotV1) {
			h.Position.Data[88] = 1
		},
		"wrong-day": func(v *signerWENStakingIntentV1, s *wenCampaignClaimSnapshotV1, h *wenStakingHistorySnapshotV1) {
			h.Now += 86400
		},
		"mixed-slot": func(v *signerWENStakingIntentV1, s *wenCampaignClaimSnapshotV1, h *wenStakingHistorySnapshotV1) {
			s.Slot++
		},
		"wrong-custody": func(v *signerWENStakingIntentV1, s *wenCampaignClaimSnapshotV1, h *wenStakingHistorySnapshotV1) {
			s.Destination.Address = s.Owner
		},
		"wrong-authority": func(v *signerWENStakingIntentV1, s *wenCampaignClaimSnapshotV1, h *wenStakingHistorySnapshotV1) {
			s.Destination.Data[32] ^= 1
		},
		"underfunded-pool": func(v *signerWENStakingIntentV1, s *wenCampaignClaimSnapshotV1, h *wenStakingHistorySnapshotV1) {
			binary.LittleEndian.PutUint64(s.Destination.Data[64:], 99)
		},
		"changed-gross": func(v *signerWENStakingIntentV1, s *wenCampaignClaimSnapshotV1, h *wenStakingHistorySnapshotV1) {
			v.Amount = "999"
		},
		"wrong-launch": func(v *signerWENStakingIntentV1, s *wenCampaignClaimSnapshotV1, h *wenStakingHistorySnapshotV1) {
			v.Sale = s.Owner.String()
		},
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			v, s, h := directCampaignStakeFixture(t, false)
			change(&v, &s, &h)
			if _, _, e := buildWENCampaignClaimStakeV1(v, 970, s, h); e == nil {
				t.Fatal("bad direct stake accepted")
			}
		})
	}
	v, s, h := directCampaignStakeFixture(t, false)
	v.Last = "0"
	h.Position = nil
	h.History = nil
	_, a, e := buildWENCampaignClaimStakeV1(v, 970, s, h)
	if e != nil || a.NextPosition != 970 || len(a.RentBytes) != 3 {
		t.Fatal("first stake", e)
	}
}
