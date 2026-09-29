package main

import (
	"context"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"syscall"
	"time"
)

// Read-only service admission. This is not transaction execution approval.
// The directory is derived from protected signer state, never request paths.
type signerWENBTCReviewV1 struct {
	Provider        *signerWENBTCProviderReviewV1    `json:"provider,omitempty"`
	Version         int                              `json:"version"`
	WalletID        string                           `json:"walletId"`
	WalletPublicKey string                           `json:"walletPublicKey"`
	Pins            signerWENBTCPinsV1               `json:"pins"`
	Intent          signerWENBTCIntentV1             `json:"intent"`
	MaxSlotLag      uint64                           `json:"maxSlotLag"`
	RouteValidity   *signerWENBTCRouteValidityV1     `json:"routeValidity,omitempty"`
	RouteSHA256     string                           `json:"routeSha256,omitempty"`
	Preparation     *signerWENBTCPreparationReviewV1 `json:"preparation,omitempty"`
}

type signerWENBTCInspectionV1 struct {
	Status           string                   `json:"status"`
	Operation        string                   `json:"operation"`
	DescriptorSHA256 string                   `json:"descriptorSha256"`
	OfferSHA256      string                   `json:"offerSha256"`
	SigningEnabled   bool                     `json:"signingEnabled"`
	Readback         signerWENBTCReadResultV1 `json:"readback"`
}

func wenBTCReviewDirectoryV1(stateDBPath, walletID string) (string, error) {
	if stateDBPath == "" || !filepath.IsAbs(stateDBPath) || filepath.Clean(stateDBPath) != stateDBPath || walletID == "" || normalizeWalletID(walletID) != walletID {
		return "", errors.New("invalid WEN BTC review binding")
	}
	root := filepath.Join(filepath.Dir(stateDBPath), "wen-btc", wenHashV1([]byte(walletID)))
	// Check the parent chain too: protecting only the leaf would permit a
	// replaceable/symlinked parent to redirect the reviewed artifact store.
	for dir := root; ; dir = filepath.Dir(dir) {
		info, err := os.Lstat(dir)
		if err != nil {
			return "", errors.New("WEN BTC reviewed configuration unavailable")
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0022 != 0 || !ok || (stat.Uid != 0 && stat.Uid != uint32(os.Geteuid())) {
			return "", errors.New("WEN BTC review directory is not protected")
		}
		if dir == filepath.Dir(stateDBPath) {
			break
		}
	}
	return root, nil
}

func loadWENBTCReviewV1(stateDBPath, walletID string, intent signerWENBTCIntentV1) (string, signerWENBTCReviewV1, *signerWENBTCRouteV1, error) {
	var review signerWENBTCReviewV1
	root, err := wenBTCReviewDirectoryV1(stateDBPath, walletID)
	if err != nil {
		return "", review, nil, err
	}
	raw, err := readSignerAdminJSONFile(filepath.Join(root, "admission.json"), 32768)
	if err != nil {
		return "", review, nil, err
	}
	if err = decodeSignerAdminStrictJSON(raw, &review); err != nil {
		return "", review, nil, err
	}
	if review.Version != 1 || review.WalletID != walletID || !reflect.DeepEqual(intent, review.Intent) {
		return "", review, nil, errors.New("WEN BTC request differs from reviewed intent")
	}
	if err = validateWENBTCIntentV1(review.Intent); err != nil {
		return "", review, nil, err
	}
	wallet, err := solana.PublicKeyFromBase58(review.WalletPublicKey)
	if err != nil || wallet.IsZero() || wallet.String() != review.WalletPublicKey {
		return "", review, nil, errors.New("invalid WEN BTC reviewed wallet")
	}
	if err = review.validateRouteValidity(); err != nil {
		return "", review, nil, err
	}
	var route *signerWENBTCRouteV1
	if intent.Operation == "acquisition" {
		raw, err = readWENBTCObjectV1(root, review.RouteSHA256, 32768)
		if err != nil {
			return "", review, nil, err
		}
		route = &signerWENBTCRouteV1{}
		if err = decodeSignerAdminStrictJSON(raw, route); err != nil {
			return "", review, nil, err
		}
	} else if review.RouteSHA256 != "" {
		return "", review, nil, errors.New("acceptance must not bind an acquisition route")
	}
	return root, review, route, nil
}

func inspectReviewedWENBTCV1(ctx context.Context, client signerWENBTCReadRPCV1, root string, review signerWENBTCReviewV1, wallet solana.PublicKey, now uint64, route *signerWENBTCRouteV1) (signerWENBTCInspectionV1, error) {
	var out signerWENBTCInspectionV1
	if wallet.String() != review.WalletPublicKey {
		return out, errors.New("WEN BTC signer wallet differs from review")
	}
	if (route != nil) != (review.Intent.Operation == "acquisition") {
		return out, errors.New("WEN BTC reviewed route operation mismatch")
	}
	readback, err := readWENBTCSubscriptionRPCV1(ctx, client, root, review.Pins, review.Intent, wallet, now, review.MaxSlotLag, route)
	if err != nil {
		return out, err
	}
	if err = review.checkRouteSlot(readback.ReferenceSlot); err != nil {
		return out, err
	}
	return signerWENBTCInspectionV1{Status: "requires-transaction-verification", Operation: review.Intent.Operation, DescriptorSHA256: review.Pins.DescriptorSHA256, OfferSHA256: review.Pins.OfferSHA256, SigningEnabled: false, Readback: readback}, nil
}

func (s *signerServiceV2) inspectWENBTCV1(req request, cfg signerConfig) ([]byte, error) {
	if err := cfg.ensureChainAllowed("solana"); err != nil {
		return nil, err
	}
	var intent signerWENBTCIntentV1
	if err := decodeSignerAdminStrictJSON(req.Request, &intent); err != nil {
		return nil, err
	}
	root, review, route, err := loadWENBTCReviewV1(cfg.stateDBPath, req.WalletID, intent)
	if err != nil {
		return nil, err
	}
	if req.Op == "v2.wenBtc.route.preview" {
		if _, err = review.providerRefreshWindow(mustWENBTCMinSlot(intent)); err != nil {
			return nil, err
		}
	}
	var lookupPins []signerWENBTCLookupPinV1
	if req.Op == "v2.wenBtc.prepare" {
		lookupPins, err = review.preparationPins()
		if err != nil {
			return nil, err
		}
	}
	wallet, err := s.keys.PublicRecord(req.WalletID)
	if err != nil {
		return nil, err
	}
	address, err := solana.PublicKeyFromBase58(wallet.PublicKey)
	if err != nil {
		return nil, err
	}
	if address.String() != review.WalletPublicKey {
		return nil, errors.New("WEN BTC signer wallet differs from review")
	}
	urls, err := s.keys.SolanaRPCURLsV2(req.WalletID)
	if err != nil || len(urls) == 0 {
		return nil, errSignerNetworkPendingV2
	}
	endpoint, err := normalizeSignerRPCURLV2(urls[0], "WEN BTC configured RPC")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
	defer cancel()
	now := time.Now().Unix()
	if now < 0 {
		return nil, errors.New("invalid signer clock")
	}
	if req.Op == "v2.wenBtc.route.preview" {
		provider, err := loadWENBTCProviderV1(root)
		if err != nil {
			return nil, err
		}
		result, err := previewWENBTCRouteV1(ctx, newSignerOwnedSolanaRPCClientV2(endpoint), provider, cfg.stateDBPath, req.WalletID, intent, address, uint64(now))
		if err != nil {
			return nil, err
		}
		return marshalSignerResultV2(result)
	}
	if req.Op == "v2.wenBtc.prepare" {
		client := newSignerOwnedSolanaRPCClientV2(endpoint)
		prepared, err := prepareWENBTCFromRPCV1(ctx, client, root, review.Pins, review.Intent, address, uint64(now), review.MaxSlotLag, review.Preparation.ComputeUnits, lookupPins, route)
		if err != nil {
			return nil, err
		}
		if err = review.checkRouteSlot(prepared.referenceSlot); err != nil {
			return nil, err
		}
		fee, _ := strconv.ParseUint(intent.MaxFeeLamports, 10, 64)
		rent, _ := strconv.ParseUint(intent.MaxRentLamports, 10, 64)
		observed, err := simulateWENBTCPreparedV1(ctx, client, prepared, review.Pins.Genesis, fee, rent)
		if err != nil {
			return nil, err
		}
		if err = review.checkRouteSlot(observed.slot); err != nil {
			return nil, err
		}
		return marshalSignerResultV2(signerWENBTCPreparationResultV1{Status: "requires-signing-revalidation", SimulationSlot: observed.slot, ComputeUnits: observed.units, NetworkFee: observed.fee, Rent: observed.rent, RefundableRent: observed.refundableRent, TotalCost: observed.total, Operation: intent.Operation, DescriptorSHA256: review.Pins.DescriptorSHA256, OfferSHA256: review.Pins.OfferSHA256, Message: append([]byte(nil), prepared.message...), Blockhash: prepared.intent.blockhash.String(), MinimumSlot: prepared.life.minimumSlot, CurrentHeight: observed.height, LastValidHeight: prepared.life.lastValidHeight})
	}
	result, err := inspectReviewedWENBTCV1(ctx, newSignerOwnedSolanaRPCClientV2(endpoint), root, review, address, uint64(now), route)
	if err != nil {
		return nil, err
	}
	return marshalSignerResultV2(result)
}
