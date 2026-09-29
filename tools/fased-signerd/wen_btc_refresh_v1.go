package main

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strconv"

	solana "github.com/gagliardetto/solana-go"
)

type signerWENBTCProviderReviewV1 struct {
	SlippageBPS uint64 `json:"slippageBps"`
	ExpiresSlot uint64 `json:"expiresSlot,string"`
}
type signerWENBTCProviderV1 interface {
	candidate(context.Context, signerWENBTCArtifactsV1, solana.PublicKey, signerWENBTCReviewV1, uint64, uint64, uint64) (*signerWENBTCRouteCandidateV1, error)
}

// Owner-configured refresh permission is independent of the expiring old quote.
func (r signerWENBTCReviewV1) providerRefreshWindow(slot uint64) (signerWENBTCReviewV1, error) {
	bad := errors.New("WEN BTC provider refresh is not admitted")
	expiry, err := strconv.ParseUint(r.Intent.ExpiresSlot, 10, 64)
	if err != nil || r.Intent.Operation != "acquisition" || r.Provider == nil || r.Provider.SlippageBPS > 50 || r.Provider.ExpiresSlot > expiry || r.Provider.ExpiresSlot <= slot || slot == 0 {
		return r, bad
	}
	r.RouteValidity = &signerWENBTCRouteValidityV1{ObservedSlot: slot, ExpiresSlot: r.Provider.ExpiresSlot}
	if err = r.checkRouteSlot(slot); err != nil {
		return r, err
	}
	return r, nil
}

// Uses a fixed credential filename under the already protected wallet review
// directory. The request cannot select a key file or provider URL.
func loadWENBTCProviderV1(root string) (*signerWENBTCProviderHTTPV1, error) {
	key, err := readSignerJupiterAPIKeyFileV2(filepath.Join(root, "provider-api.key"))
	if err != nil {
		return nil, err
	}
	defer func() {
		for i := range key {
			key[i] = 0
		}
	}()
	return newWENBTCProviderHTTPV1(string(key))
}

// Internal refresh only. Returns a candidate after independent before/after
// custody reads; never replaces admission.json or enables signing.
func refreshWENBTCRouteRPCV1(ctx context.Context, client signerWENBTCReadRPCV1, provider signerWENBTCProviderV1, root string, review signerWENBTCReviewV1, wallet solana.PublicKey, nowHint uint64, oldRoute signerWENBTCRouteV1) (*signerWENBTCRouteCandidateV1, error) {
	ctx, cancel := context.WithTimeout(ctx, solanaWriteRPCRequestTimeout())
	defer cancel()
	if _, err := review.providerRefreshWindow(mustWENBTCMinSlot(review.Intent)); err != nil {
		return nil, err
	}
	if wallet.String() != review.WalletPublicKey || provider == nil {
		return nil, errors.New("WEN BTC refresh wallet/provider mismatch")
	}
	before, err := readWENBTCSubscriptionRPCV1(ctx, client, root, review.Pins, review.Intent, wallet, nowHint, review.MaxSlotLag, &oldRoute)
	if err != nil {
		return nil, err
	}
	fresh, err := review.providerRefreshWindow(before.ReferenceSlot)
	if err != nil {
		return nil, err
	}
	a, err := loadWENBTCAcquisitionV1(root, review.Pins, review.Intent, wallet, before.Slot, before.Now)
	if err != nil {
		return nil, err
	}
	candidate, err := provider.candidate(ctx, a, wallet, fresh, before.ReferenceSlot, before.Now, fresh.Provider.SlippageBPS)
	if err != nil {
		return nil, err
	}
	if candidate == nil || wenHashV1(candidate.routeBytes) != candidate.routeSHA256 || candidate.validity.ExpiresSlot != fresh.Provider.ExpiresSlot {
		return nil, errors.New("WEN BTC refresh candidate mismatch")
	}
	var route signerWENBTCRouteV1
	if err = decodeSignerAdminStrictJSON(candidate.routeBytes, &route); err != nil {
		return nil, err
	}
	// Do not trust a provider implementation to bypass economic/account checks.
	if _, _, err = a.acquisitionInstruction(wallet, route, before.Now); err != nil {
		return nil, err
	}
	after, err := readWENBTCSubscriptionRPCV1(ctx, client, root, review.Pins, review.Intent, wallet, before.Now, review.MaxSlotLag, &route)
	if err != nil {
		return nil, err
	}
	if after.Slot < before.Slot || after.ReferenceSlot < before.ReferenceSlot || after.Now < before.Now {
		return nil, errors.New("WEN BTC refresh chain regressed")
	}
	fresh.RouteValidity = &candidate.validity
	if err = fresh.checkRouteSlot(after.ReferenceSlot); err != nil {
		return nil, err
	}
	// Round trip produces an owned output, detached from the provider's buffers.
	raw, err := json.Marshal(route)
	if err != nil {
		return nil, err
	}
	copy := *candidate
	copy.routeBytes = raw
	return &copy, nil
}
func mustWENBTCMinSlot(intent signerWENBTCIntentV1) uint64 {
	n, _ := strconv.ParseUint(intent.MinFinalizedSlot, 10, 64)
	return n
}

// Entry point for a future protected service operation. Configuration and keys
// are loaded locally; request data cannot supply a provider, route or endpoint.
func refreshConfiguredWENBTCRouteV1(ctx context.Context, client signerWENBTCReadRPCV1, stateDBPath, walletID string, intent signerWENBTCIntentV1, wallet solana.PublicKey, nowHint uint64) (*signerWENBTCRouteCandidateV1, error) {
	root, review, route, err := loadWENBTCReviewV1(stateDBPath, walletID, intent)
	if err != nil {
		return nil, err
	}
	if _, err = review.providerRefreshWindow(mustWENBTCMinSlot(intent)); err != nil {
		return nil, err
	}
	if route == nil || wallet.String() != review.WalletPublicKey {
		return nil, errors.New("WEN BTC configured refresh mismatch")
	}
	provider, err := loadWENBTCProviderV1(root)
	if err != nil {
		return nil, err
	}
	return refreshWENBTCRouteRPCV1(ctx, client, provider, root, review, wallet, nowHint, *route)
}
