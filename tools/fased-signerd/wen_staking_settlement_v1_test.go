package main

import "testing"

func TestWENStakingSettlementScopesV1(t *testing.T) {
	v := stakingReviewFixture(t).Intent
	makeRecord := func() wenBudgetReservationV1 {
		return wenBudgetReservationV1{WalletID: "staker", Genesis: v.Genesis, StakingIntent: &v, Scopes: map[string]uint64{wenMiningNativeScopeV1("staker", v.Genesis): 7000, wenStakingLaunchScopeV1("staker", v): 7000}, WalletClaims: map[string]uint64{"solana:native": 7000, "solana:spl:" + v.Mint: 1}}
	}
	if !wenStakingSettlementScopesValidV1(makeRecord()) {
		t.Fatal("valid deposit rejected")
	}
	for _, change := range []func(*wenBudgetReservationV1){func(r *wenBudgetReservationV1) { r.Scopes["other"] = 7000 }, func(r *wenBudgetReservationV1) { delete(r.Scopes, wenStakingLaunchScopeV1("staker", v)) }, func(r *wenBudgetReservationV1) { r.Scopes[wenStakingLaunchScopeV1("staker", v)] = 6999 }, func(r *wenBudgetReservationV1) { r.WalletClaims["solana:spl:"+v.Mint] = 2 }, func(r *wenBudgetReservationV1) { r.Genesis = "other" }, func(r *wenBudgetReservationV1) { r.WalletClaims["other"] = 1 }} {
		r := makeRecord()
		change(&r)
		if wenStakingSettlementScopesValidV1(r) {
			t.Fatal("malformed scopes accepted")
		}
	}
	exit := v
	exit.Operation = "requestExit"
	exit.Amount = "0"
	r := makeRecord()
	r.StakingIntent = &exit
	delete(r.WalletClaims, "solana:spl:"+v.Mint)
	if !wenStakingSettlementScopesValidV1(r) {
		t.Fatal("valid exit rejected")
	}
}
