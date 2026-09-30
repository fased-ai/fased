package main

import (
	"encoding/json"
	"errors"
	"io"
)

func runSignerAdminMiningClaimBootstrapV1(args []string, stdin io.Reader, stdout io.Writer) error {
	fs, common := newSignerAdminFlagSet("wen-mining install-claim-review")
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
	var body wenMiningClaimBootstrapV1
	if e = decodeSignerAdminStrictJSON(raw, &body); e != nil {
		return e
	}
	r := body.Review
	if r.Version != 1 || r.WalletID != id || validateWENMiningClaimIntentV1(r.Intent) != nil {
		return errors.New("invalid commit review")
	}
	if e = validateWENMiningClaimDescriptorV1(body.Descriptor, r.Pins); e != nil {
		return e
	}
	result, e := callSignerAdmin(common.controlSocket, "v2.wenMining.claimReview.install", id, body)
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
