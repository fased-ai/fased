package main

import (
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"strconv"
)

// Produce the existing bootstrap wire format for explicit review. Construction
// is pure: it grants no authority and performs no installation or signing.
func draftWENMiningClaimReviewV1(walletID, owner, entry string, proposal wenMiningDiscoveredClaimV1, pins wenStakingPinsV1, descriptor []byte, total, lag uint64) (wenMiningClaimBootstrapV1, error) {
	var zero wenMiningClaimBootstrapV1
	bad := errors.New("mining claim review draft rejected")
	if walletID == "" || normalizeWalletID(walletID) != walletID || proposal.SigningEnabled || proposal.Status != "requires-review" || lag == 0 || lag > 32 {
		return zero, bad
	}
	wallet, err := solana.PublicKeyFromBase58(owner)
	if err != nil || wallet.IsZero() || wallet.String() != owner {
		return zero, bad
	}
	v := proposal.Intent
	ix, err := buildWENMiningClaimInstructionV1(v, wallet)
	if err != nil {
		return zero, err
	}
	if ix.Accounts()[5].PublicKey.String() != entry {
		return zero, bad
	}
	if err := validateWENMiningClaimDescriptorV1(descriptor, pins); err != nil {
		return zero, err
	}
	minimum, _ := strconv.ParseUint(v.MinFinalizedSlot, 10, 64)
	expiry, _ := strconv.ParseUint(v.ExpiresSlot, 10, 64)
	fee, _ := strconv.ParseUint(v.MaxFeeLamports, 10, 64)
	if proposal.ObservedSlot < minimum || proposal.ObservedSlot > expiry || total < fee || total > signerNativeFeeReservationV2 || pins.DeploymentSlot == 0 || pins.DeploymentSlot > minimum || pins.ProgramID != v.ProgramID || pins.Genesis != v.Genesis || pins.DescriptorSHA256 != v.DescriptorSHA256 || pins.CapabilitySHA256 != v.CapabilitySHA256 {
		return zero, bad
	}
	// Copy transport values: callers cannot mutate the draft via shared pointers.
	copyPins := pins
	if pins.UpgradeAuthority != nil {
		authority := *pins.UpgradeAuthority
		copyPins.UpgradeAuthority = &authority
	}
	if v.Destination != nil {
		destination := *v.Destination
		v.Destination = &destination
	}
	return wenMiningClaimBootstrapV1{Review: wenMiningClaimReviewV1{Version: 1, WalletID: walletID, WalletPublicKey: owner, Intent: v, Pins: copyPins, MaxTotalCostLamports: total, MaxSlotLag: lag}, Descriptor: append([]byte(nil), descriptor...)}, nil
}
