package main

import (
	"encoding/binary"
	solana "github.com/gagliardetto/solana-go"
	"testing"
)

func TestWENBTCDeploymentReadback(t *testing.T) {
	for _, change := range []string{"valid", "authority", "wrong-authority", "missing", "program-key", "data-key", "owner", "executable", "slot", "pointer", "program-tag", "data-tag", "deployment-slot", "future-deployment", "code", "truncated"} {
		t.Run(change, func(t *testing.T) {
			_, pins, _, _, _ := wenArtifactCase(t)
			key := solana.MustPublicKeyFromBase58(pins.ProgramID)
			loader := solana.MustPublicKeyFromBase58("BPFLoaderUpgradeab1e11111111111111111111111")
			address, _, _ := solana.FindProgramAddress([][]byte{key[:]}, loader)
			p := &signerWENBTCAccountV1{Address: key, Owner: loader, Slot: 150, Executable: true, Data: make([]byte, 36)}
			d := &signerWENBTCAccountV1{Address: address, Owner: loader, Slot: 150, Data: make([]byte, 48)}
			binary.LittleEndian.PutUint32(p.Data, 2)
			copy(p.Data[4:], address[:])
			binary.LittleEndian.PutUint32(d.Data, 3)
			binary.LittleEndian.PutUint64(d.Data[4:], 1)
			copy(d.Data[45:], []byte{1, 2, 3})
			pins.CodeSHA256 = wenHashV1(d.Data[45:])
			switch change {
			case "authority", "wrong-authority":
				pins.UpgradeAuthority = &key
				d.Data[12] = 1
				copy(d.Data[13:45], key[:])
				if change == "wrong-authority" {
					d.Data[13] ^= 1
				}
			case "missing":
				d = nil
			case "program-key":
				p.Address = address
			case "data-key":
				d.Address = key
			case "owner":
				d.Owner = key
			case "executable":
				d.Executable = true
			case "slot":
				d.Slot++
			case "pointer":
				p.Data[4] ^= 1
			case "program-tag":
				p.Data[0] = 3
			case "data-tag":
				d.Data[0] = 2
			case "deployment-slot":
				d.Data[4]++
			case "future-deployment":
				pins.DeploymentSlot = 151
			case "code":
				d.Data[45] ^= 1
			case "truncated":
				d.Data = d.Data[:44]
			}
			err := verifyWENBTCDeploymentV1(pins, 150, p, d)
			want := change == "valid" || change == "authority"
			if (err == nil) != want {
				t.Fatalf("accepted=%v want=%v: %v", err == nil, want, err)
			}
		})
	}
}

func TestWENBTCAcceptanceFundingReadback(t *testing.T) {
	for _, change := range []string{"valid", "surplus", "missing", "address", "owner", "executable", "slot", "length", "mint", "wallet", "balance", "frozen", "delegate", "close", "native"} {
		t.Run(change, func(t *testing.T) {
			root, pins, intent, wallet, _ := wenArtifactCase(t)
			a, err := loadWENBTCAcceptanceV1(root, pins, intent, wallet, 150, 1)
			if err != nil {
				t.Fatal(err)
			}
			s := &signerWENBTCAccountV1{Address: a.source, Owner: solana.MustPublicKeyFromBase58("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), Slot: 150, Data: make([]byte, 165)}
			copy(s.Data[:32], a.keys[3][:])
			copy(s.Data[32:64], wallet[:])
			binary.LittleEndian.PutUint64(s.Data[64:], a.numbers[4])
			s.Data[108] = 1
			switch change {
			case "surplus":
				binary.LittleEndian.PutUint64(s.Data[64:], a.numbers[4]+1)
			case "missing":
				s = nil
			case "address":
				s.Address = wallet
			case "owner":
				s.Owner = wallet
			case "executable":
				s.Executable = true
			case "slot":
				s.Slot++
			case "length":
				s.Data = s.Data[:164]
			case "mint":
				s.Data[0] ^= 1
			case "wallet":
				s.Data[32] ^= 1
			case "balance":
				binary.LittleEndian.PutUint64(s.Data[64:], a.numbers[4]-1)
			case "frozen":
				s.Data[108] = 2
			case "delegate":
				s.Data[72] = 1
			case "close":
				s.Data[129] = 1
			case "native":
				s.Data[109] = 1
			}
			err = a.verifyAcceptanceSourceV1(150, s)
			want := change == "valid" || change == "surplus"
			if (err == nil) != want {
				t.Fatalf("accepted=%v want=%v: %v", err == nil, want, err)
			}
		})
	}
}
