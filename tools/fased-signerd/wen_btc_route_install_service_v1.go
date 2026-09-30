package main

import (
	"context"
	"errors"
	"path/filepath"
	"time"

	solana "github.com/gagliardetto/solana-go"
)

type signerWENBTCRouteInstallRequestV1 struct {
	Intent  signerWENBTCIntentV1       `json:"intent"`
	Preview signerWENBTCRoutePreviewV1 `json:"preview"`
}
type signerWENBTCRouteInstallReceiptV1 struct {
	Status                string `json:"status"`
	WalletID              string `json:"walletId"`
	BaseReviewSHA256      string `json:"baseReviewSha256"`
	InstalledReviewSHA256 string `json:"installedReviewSha256"`
	RouteSHA256           string `json:"routeSha256"`
	SigningEnabled        bool   `json:"signingEnabled"`
}

func (s *signerServiceV2) installWENBTCRouteServiceV1(req request, cfg signerConfig, control bool) ([]byte, error) {
	if err := requireControlSocketV2(control); err != nil {
		return nil, err
	}
	if cfg.readOnly {
		return nil, errors.New("read-only signer mode")
	}
	if err := cfg.ensureChainAllowed("solana"); err != nil {
		return nil, err
	}
	var body signerWENBTCRouteInstallRequestV1
	if err := decodeSignerAdminStrictJSON(req.Request, &body); err != nil {
		return nil, err
	}
	if err := validateWENBTCIntentV1(body.Intent); err != nil {
		return nil, err
	}
	root, err := wenBTCReviewDirectoryV1(cfg.stateDBPath, req.WalletID)
	if err != nil {
		return nil, err
	}
	current, err := readSignerAdminJSONFile(filepath.Join(root, "admission.json"), 32768)
	if err != nil {
		return nil, err
	}
	if wenHashV1(current) != body.Preview.BaseReviewSHA256 {
		return nil, errors.New("WEN BTC route installation review mismatch")
	}
	wallet, err := s.keys.PublicRecord(req.WalletID)
	if err != nil {
		return nil, err
	}
	address, err := solana.PublicKeyFromBase58(wallet.PublicKey)
	if err != nil {
		return nil, err
	}
	urls, err := s.keys.SolanaRPCURLsV2(req.WalletID)
	if err != nil || len(urls) == 0 {
		return nil, errSignerNetworkPendingV2
	}
	endpoint, err := normalizeSignerRPCURLV2(urls[0], "WEN BTC configured RPC")
	if err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	if now < 0 {
		return nil, errors.New("invalid signer clock")
	}
	ctx, cancel := context.WithTimeout(context.Background(), solanaWriteRPCRequestTimeout())
	defer cancel()
	hash, err := installWENBTCRouteV1(ctx, newSignerOwnedSolanaRPCClientV2(endpoint), cfg.stateDBPath, req.WalletID, body.Intent, address, body.Preview, uint64(now))
	if err != nil {
		return nil, err
	}
	return marshalSignerResultV2(signerWENBTCRouteInstallReceiptV1{Status: "route-installed", WalletID: req.WalletID, BaseReviewSHA256: body.Preview.BaseReviewSHA256, InstalledReviewSHA256: hash, RouteSHA256: body.Preview.RouteSHA256})
}
