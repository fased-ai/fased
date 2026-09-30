package main

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	solana "github.com/gagliardetto/solana-go"
	"reflect"
	"strconv"
	"testing"
)

func TestWENBTCProviderRouteCandidate(t *testing.T) {
	for _, name := range []string{"valid", "authority-ata", "wallet-ata", "ata-alias", "ata-bad-flags", "mint", "input", "output", "floor", "mode", "slippage", "fee", "old", "future", "expired", "program", "account", "signer", "data", "transaction", "unknown-instruction", "wallet", "offer", "oversize"} {
		t.Run(name, func(t *testing.T) {
			a, wallet, route, _, _ := wenAcquisitionFixture(t)
			at := 13 + 4*int(binary.LittleEndian.Uint32(route.Data[9:13]))
			out := binary.LittleEndian.Uint64(route.Data[at+8:])
			slip := uint64(binary.LittleEndian.Uint16(route.Data[at+16:]))
			floor := (out/10000)*(10000-slip) + (out%10000)*(10000-slip)/10000
			q := map[string]any{"inputMint": a.keys[3].String(), "outputMint": a.keys[4].String(), "inAmount": strconv.FormatUint(a.numbers[10], 10), "outAmount": strconv.FormatUint(out, 10), "otherAmountThreshold": strconv.FormatUint(floor, 10), "swapMode": "ExactIn", "slippageBps": slip, "contextSlot": 150}
			ix := signerWENBTCProviderInstructionV1{ProgramID: route.Program.String(), Accounts: append([]signerSATAccountV2(nil), route.Accounts...), Data: base64.StdEncoding.EncodeToString(route.Data)}
			r := signerWENBTCReviewV1{WalletPublicKey: wallet.String(), Pins: signerWENBTCPinsV1{ProgramID: a.program.String(), OfferSHA256: wenHashV1(a.offer[:])}, Intent: signerWENBTCIntentV1{Operation: "acquisition", MinFinalizedSlot: "100", ExpiresSlot: "200"}, MaxSlotLag: 5, RouteValidity: &signerWENBTCRouteValidityV1{ObservedSlot: 150, ExpiresSlot: 156}}
			switch name {
			case "authority-ata", "ata-alias", "ata-bad-flags":
				authority := solana.MustPublicKeyFromBase58(route.Accounts[2].Pubkey)
				ata, _, e := solana.FindAssociatedTokenAddress(authority, a.keys[3])
				if e != nil {
					t.Fatal(e)
				}
				ix.Accounts[3].Pubkey = ata.String()
				if name == "ata-alias" {
					ix.Accounts[13].Pubkey = ata.String()
				}
				if name == "ata-bad-flags" {
					ix.Accounts[3].IsSigner = true
				}
			case "wallet-ata":
				ata, _, e := solana.FindAssociatedTokenAddress(wallet, a.keys[3])
				if e != nil {
					t.Fatal(e)
				}
				ix.Accounts[3].Pubkey = ata.String()
			case "mint":
				q["outputMint"] = a.keys[3].String()
			case "input":
				q["inAmount"] = "0"
			case "output":
				q["outAmount"] = "18446744073709551615"
			case "floor":
				q["otherAmountThreshold"] = "0"
			case "mode":
				q["swapMode"] = "ExactOut"
			case "slippage":
				q["slippageBps"] = 51
			case "fee":
				q["platformFee"] = map[string]any{"amount": "1", "feeBps": 0}
			case "old":
				q["contextSlot"] = 140
			case "future":
				q["contextSlot"] = 155
			case "expired":
				r.RouteValidity.ExpiresSlot = 154
			case "program":
				ix.ProgramID = wallet.String()
			case "account":
				ix.Accounts[3].Pubkey = wallet.String()
			case "signer":
				ix.Accounts[3].IsSigner = true
			case "data":
				ix.Data = "AA=="
			case "wallet":
				r.WalletPublicKey = "invalid"
			case "offer":
				r.Pins.OfferSHA256 = "bad"
			}
			qb, _ := json.Marshal(q)
			ib, _ := json.Marshal(ix)
			if name == "transaction" {
				ib = []byte(`{"transaction":"AA=="}`)
			}
			if name == "unknown-instruction" {
				ib = append([]byte(`{"extra":true,`), ib[1:]...)
			}
			if name == "oversize" {
				qb = make([]byte, 65537)
			}
			candidate, err := buildWENBTCRouteCandidateV1(a, wallet, r, qb, ib, 154, a.numbers[14])
			if name != "valid" && name != "authority-ata" {
				if err == nil || candidate != nil {
					t.Fatal("bad candidate admitted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var decoded signerWENBTCRouteV1
			if json.Unmarshal(candidate.routeBytes, &decoded) != nil || !reflect.DeepEqual(decoded, route) || candidate.providerInstructionSHA256 != wenHashV1(ib) || candidate.routeSHA256 != wenHashV1(candidate.routeBytes) || candidate.validity.ObservedSlot != 150 {
				t.Fatal("candidate binding lost")
			}
			if r.RouteValidity.ObservedSlot != 150 {
				t.Fatal("mutated owner review")
			}
		})
	}
}
