package main

// Both ceilings cover only the owner's fee, never the vault's transferred capital.
func wenMiningFundingSettlementScopesValidV1(r wenBudgetReservationV1) bool {
	if r.MiningFundingIntent == nil || r.MiningFundingPrepared == nil || len(r.Scopes) != 2 || validateWENMiningFundingFenceV1(r, r.MessageSHA256, r.AccountKeys, []uint64{r.MinExecutionSlot}) != nil {
		return false
	}
	n := r.WalletClaims["solana:native"]
	return n == r.MiningFundingPrepared.Fee && r.OutcomeFee <= n && r.Scopes[wenMiningNativeScopeV1(r.WalletID, r.Genesis)] == n && r.Scopes[wenMiningFundingLaunchScopeV1(r.WalletID, *r.MiningFundingIntent)] == n
}
