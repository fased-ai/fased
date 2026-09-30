package main

import "testing"

func TestWENMiningClaimReviewDraft(t *testing.T) {
	_, _, pins, _ := miningClaimRPCFixture(t, "sol")
	raw, pins := miningClaimReviewDescriptor(t, pins)
	for _, op := range []string{"sol", "sat"} {
		for _, mode := range []string{"ok", "owner", "entry", "status", "signing", "slot", "budget", "lag", "descriptor", "pins"} {
			t.Run(op+"/"+mode, func(t *testing.T) {
				_, _, v, _, client := miningClaimExecutionFixture(t, raw, pins, op, "success")
				owner := client.expectedOwner
				ix, err := buildWENMiningClaimInstructionV1(v, owner)
				if err != nil {
					t.Fatal(err)
				}
				entry := ix.Accounts()[5].PublicKey.String()
				proposal := wenMiningDiscoveredClaimV1{Intent: v, ObservedSlot: 101, Status: "requires-review"}
				data := append([]byte(nil), raw...)
				p := pins
				total, lag := uint64(5000), uint64(2)
				wallet := owner.String()
				switch mode {
				case "owner":
					wallet = v.ProgramID
				case "entry":
					entry = v.ProgramID
				case "status":
					proposal.Status = "readback-rejected"
				case "signing":
					proposal.SigningEnabled = true
				case "slot":
					proposal.ObservedSlot = 0
				case "budget":
					total = 1
				case "lag":
					lag = 0
				case "descriptor":
					data[0] ^= 1
				case "pins":
					p.CodeSHA256 = wenHashV1([]byte("other"))
				}
				draft, err := draftWENMiningClaimReviewV1("miner", wallet, entry, proposal, p, data, total, lag)
				if (err == nil) != (mode == "ok") {
					t.Fatal(mode, err)
				}
				if err != nil {
					return
				}
				data[0] ^= 1
				if draft.Descriptor[0] != raw[0] || !equalWENMiningClaimIntentV1(draft.Review.Intent, v) || draft.Review.MaxTotalCostLamports != total {
					t.Fatal("draft binding")
				}
				if proposal.Intent.Destination != nil {
					original := *draft.Review.Intent.Destination
					*proposal.Intent.Destination = "changed"
					if *draft.Review.Intent.Destination != original {
						t.Fatal("aliased destination")
					}
				}
			})
		}
	}
}
