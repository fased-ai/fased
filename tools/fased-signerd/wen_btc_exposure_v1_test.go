package main

import (
	"strconv"
	"testing"
)

func TestWENBTCExposure(t *testing.T) {
	for _, name := range []string{"acceptance", "acquisition", "cash-cap", "cost-cap", "offer", "wallet", "fees"} {
		t.Run(name, func(t *testing.T) {
			root, pins, intent, wallet, _ := wenArtifactCase(t)
			a, err := loadWENBTCAcceptanceV1(root, pins, intent, wallet, 100, 1)
			if err != nil {
				t.Fatal(err)
			}
			if name != "acceptance" {
				a, wallet, _, _, _ = wenAcquisitionFixture(t)
				intent.Operation = "acquisition"
				intent.ProgramID = a.program.String()
				intent.OfferSHA256 = wenHashV1(a.offer[:])
				intent.MaxCashRaw = strconv.FormatUint(a.numbers[10], 10)
				intent.MaxCostRaw = strconv.FormatUint(a.numbers[12], 10)
			}
			switch name {
			case "cash-cap":
				intent.MaxCashRaw = "1"
			case "cost-cap":
				intent.MaxCostRaw = "0"
			case "offer":
				intent.OfferSHA256 = wenHashV1([]byte("wrong"))
			case "wallet":
				wallet = [32]byte{}
			case "fees":
				intent.MaxRentLamports = "18446744073709551615"
			}
			result, err := wenBTCExposureV1(a, intent, wallet)
			if name != "acceptance" && name != "acquisition" {
				if err == nil {
					t.Fatal("invalid funding admitted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			fee, _ := strconv.ParseUint(intent.MaxFeeLamports, 10, 64)
			rent, _ := strconv.ParseUint(intent.MaxRentLamports, 10, 64)
			if result.NativeLamports != fee+rent || result.CashMint != a.keys[3] {
				t.Fatal("fee or asset binding lost")
			}
			if name == "acceptance" {
				if result.WalletCashRaw != a.numbers[4] || result.CustodyCashRaw != 0 {
					t.Fatal("acceptance exposure")
				}
			} else if result.WalletCashRaw != 0 || result.CustodyCashRaw != a.numbers[10]+a.numbers[12] || result.CustodyAccount != a.keys[6] {
				t.Fatal("acquisition double charged wallet")
			}
		})
	}
}
