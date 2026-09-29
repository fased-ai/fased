package main

// Both ceilings cover only the owner's fee, never the claim rewards.
func wenMiningClaimSettlementScopesValidV1(r wenBudgetReservationV1) bool {
	if r.MiningClaimIntent == nil || r.MiningClaimPrepared == nil || len(r.Scopes) != 2 || validateWENMiningClaimFenceV1(r, r.MessageSHA256, r.AccountKeys, []uint64{r.MinExecutionSlot}) != nil {
		return false
	}
	n := r.WalletClaims["solana:native"]
	return n == r.MiningClaimPrepared.Fee && r.OutcomeFee <= n && r.Scopes[wenMiningNativeScopeV1(r.WalletID, r.Genesis)] == n && r.Scopes[wenMiningClaimLaunchScopeV1(r.WalletID, *r.MiningClaimIntent)] == n
}
