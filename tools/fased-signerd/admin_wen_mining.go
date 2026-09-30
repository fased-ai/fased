package main

import (
	"encoding/json"
	"errors"
	solana "github.com/gagliardetto/solana-go"
	"io"
)

func runSignerAdminMiningReviewV1(args []string, stdin io.Reader, stdout io.Writer) error {
	fs, common := newSignerAdminFlagSet("wen-mining install-reveal-review")
	wallet := fs.String("wallet-id", "", "normalized wallet identifier")
	if e := parseSignerAdminFlags(fs, args); e != nil {
		return e
	}
	if common.operatorSocket != "" {
		return errors.New("mining review requires control socket")
	}
	if _, e := requireSignerAdminControlSocket(common.controlSocket); e != nil {
		return e
	}
	id, e := validateSignerAdminWalletID(*wallet)
	if e != nil {
		return e
	}
	raw, e := io.ReadAll(io.LimitReader(stdin, 16385))
	if e != nil || len(raw) == 0 || len(raw) > 16384 {
		return errors.New("mining review requires one JSON object within 16 KiB")
	}
	var body wenMiningReviewInstallV1
	if e = decodeSignerAdminStrictJSON(raw, &body); e != nil {
		return e
	}
	if e = validateWENMiningIntentV1(body.Intent); e != nil {
		return e
	}
	if body.Intent.Operation != "reveal" || !wenReservationHashV1(body.BaseReviewSHA256) {
		return errors.New("invalid mining review request")
	}
	if _, e = validateRequestIDV2(body.CommitRequest); e != nil {
		return e
	}
	result, e := callSignerAdmin(common.controlSocket, "v2.wenMining.review.install", id, body)
	if e != nil {
		return e
	}
	var receipt wenMiningReviewReceiptV1
	intent, _ := json.Marshal(body.Intent)
	if decodeSignerAdminStrictJSON(result, &receipt) != nil || receipt.Status != "review-installed" || receipt.SigningEnabled || receipt.WalletID != id || receipt.BaseReviewSHA256 != body.BaseReviewSHA256 || receipt.IntentSHA256 != wenHashV1(intent) || !wenReservationHashV1(receipt.ReviewSHA256) {
		return errors.New("mining review receipt mismatch; reconcile before retry")
	}
	normalized, e := json.Marshal(receipt)
	if e != nil {
		return e
	}
	return writeSignerAdminResult(normalized, stdout)
}

func runSignerAdminMiningBootstrapV1(args []string, stdin io.Reader, stdout io.Writer) error {
	fs, common := newSignerAdminFlagSet("wen-mining install-commit-review")
	wallet := fs.String("wallet-id", "", "normalized wallet identifier")
	if e := parseSignerAdminFlags(fs, args); e != nil {
		return e
	}
	if common.operatorSocket != "" {
		return errors.New("mining bootstrap requires control socket")
	}
	if _, e := requireSignerAdminControlSocket(common.controlSocket); e != nil {
		return e
	}
	id, e := validateSignerAdminWalletID(*wallet)
	if e != nil {
		return e
	}
	raw, e := io.ReadAll(io.LimitReader(stdin, 65537))
	if e != nil || len(raw) == 0 || len(raw) > 65536 {
		return errors.New("mining bootstrap requires JSON within 64 KiB")
	}
	var body wenMiningBootstrapV1
	if e = decodeSignerAdminStrictJSON(raw, &body); e != nil {
		return e
	}
	r := body.Review
	if r.Version != 2 || r.WalletID != id || r.Intent.Operation != "commit" || validateWENMiningIntentV1(r.Intent) != nil {
		return errors.New("invalid commit review")
	}
	if e = validateWENMiningDescriptorV1(body.Descriptor, r.Pins); e != nil {
		return e
	}
	result, e := callSignerAdmin(common.controlSocket, "v2.wenMining.bootstrap.install", id, body)
	if e != nil {
		return e
	}
	var receipt wenMiningReviewReceiptV1
	intent, _ := json.Marshal(r.Intent)
	review, _ := json.Marshal(r)
	if decodeSignerAdminStrictJSON(result, &receipt) != nil || receipt.Status != "review-installed" || receipt.SigningEnabled || receipt.WalletID != id || receipt.BaseReviewSHA256 != "" || receipt.IntentSHA256 != wenHashV1(intent) || receipt.ReviewSHA256 != wenHashV1(review) {
		return errors.New("mining bootstrap receipt mismatch; reconcile before retry")
	}
	normalized, e := json.Marshal(receipt)
	if e != nil {
		return e
	}
	return writeSignerAdminResult(normalized, stdout)
}

func runSignerAdminMiningPreimageV1(args []string, stdin io.Reader, stdout io.Writer) error {
	fs, common := newSignerAdminFlagSet("wen-mining install-preimage")
	wallet := fs.String("wallet-id", "", "normalized wallet identifier")
	if e := parseSignerAdminFlags(fs, args); e != nil {
		return e
	}
	if common.operatorSocket != "" {
		return errors.New("mining preimage requires control socket")
	}
	if _, e := requireSignerAdminControlSocket(common.controlSocket); e != nil {
		return e
	}
	id, e := validateSignerAdminWalletID(*wallet)
	if e != nil {
		return e
	}
	raw, e := io.ReadAll(io.LimitReader(stdin, 8193))
	defer zeroBytes(raw)
	if e != nil || len(raw) == 0 || len(raw) > 8192 {
		return errors.New("mining preimage requires JSON within 8 KiB")
	}
	var body wenMiningPreimageInstallV1
	if decodeSignerAdminStrictJSON(raw, &body) != nil {
		return errors.New("invalid mining preimage request")
	}
	if body.Intent.Operation != "commit" || validateWENMiningIntentV1(body.Intent) != nil {
		return errors.New("invalid mining preimage intent")
	}
	w, e := solana.PublicKeyFromBase58(body.Preimage.Scope.Owner)
	if e != nil {
		return errors.New("invalid mining preimage owner")
	}
	secret, e := json.Marshal(body.Preimage)
	if e != nil {
		return errors.New("invalid mining preimage")
	}
	defer zeroBytes(secret)
	material, e := validateWENMiningPreimageV1(secret, body.Intent, w)
	if e != nil {
		return e
	}
	zeroBytes(material)
	result, e := callSignerAdmin(common.controlSocket, "v2.wenMining.preimage.install", id, body)
	if e != nil {
		return e
	}
	var receipt wenMiningPreimageReceiptV1
	if decodeSignerAdminStrictJSON(result, &receipt) != nil || receipt.Status != "preimage-installed" || receipt.SigningEnabled || receipt.WalletID != id || receipt.PreimageKey != wenMiningPreimageKeyV1(body.Intent, w) || receipt.CommitmentSHA256 != body.Intent.CommitmentSHA256 {
		return errors.New("mining preimage receipt mismatch; reconcile before retry")
	}
	normalized, e := json.Marshal(receipt)
	if e != nil {
		return e
	}
	return writeSignerAdminResult(normalized, stdout)
}
