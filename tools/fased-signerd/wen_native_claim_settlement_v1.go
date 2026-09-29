package main

// Fee and rent are the same SOL liability under wallet and launch ceilings.
func wenNativeClaimSettlementScopesValidV1(r wenBudgetReservationV1) bool {
	if r.NativeClaimIntent == nil || r.NativeClaimPrepared == nil || r.BTCClaimIntent != nil || r.BTCClaimPrepared != nil || r.WithdrawalIntent != nil || r.MiningIntent != nil || r.StakingIntent != nil || validateWENNativeClaimIntentV1(*r.NativeClaimIntent) != nil || r.Genesis != r.NativeClaimIntent.Genesis || len(r.Scopes) != 2 || len(r.WalletClaims) != 1 {
		return false
	}
	n := r.WalletClaims["solana:native"]
	b := r.NativeClaimPrepared
	return n > 0 && b.Fee > 0 && b.Rent > 0 && b.Fee <= ^uint64(0)-b.Rent && b.Fee+b.Rent == n && r.OutcomeFee <= b.Fee && r.Scopes[wenMiningNativeScopeV1(r.WalletID, r.Genesis)] == n && r.Scopes[wenNativeClaimLaunchScopeV1(r.WalletID, *r.NativeClaimIntent)] == n
}
