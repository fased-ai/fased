package main

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strconv"
)

func validWENReviewDigestV1(s string) bool {
	b, e := hex.DecodeString(s)
	return e == nil && len(b) == 32 && hex.EncodeToString(b) == s
}
func validateWENRouteInstallInputV1(body signerWENBTCRouteInstallRequestV1) error {
	bad := errors.New("invalid reviewed WEN route installation input")
	if err := validateWENBTCIntentV1(body.Intent); err != nil {
		return err
	}
	p := body.Preview
	if body.Intent.Operation != "acquisition" || p.Operation != "acquisition" || p.Status != "requires-route-review" || p.Installed || p.SigningEnabled || p.DescriptorSHA256 != body.Intent.DescriptorSHA256 || p.OfferSHA256 != body.Intent.OfferSHA256 || !validWENReviewDigestV1(p.BaseReviewSHA256) || !validWENReviewDigestV1(p.ProviderInstructionSHA256) || len(p.RouteBytes) == 0 || len(p.RouteBytes) > 32768 || wenHashV1(p.RouteBytes) != p.RouteSHA256 {
		return bad
	}
	min, _ := strconv.ParseUint(body.Intent.MinFinalizedSlot, 10, 64)
	expiry, _ := strconv.ParseUint(body.Intent.ExpiresSlot, 10, 64)
	if p.Validity.ObservedSlot < min || p.Validity.ExpiresSlot <= p.Validity.ObservedSlot || p.Validity.ExpiresSlot > expiry {
		return bad
	}
	var route signerWENBTCRouteV1
	if decodeSignerAdminStrictJSON(p.RouteBytes, &route) != nil || route.Program.IsZero() || len(route.Data) < 36 || len(route.Data) > 44 || len(route.Accounts) < 14 || len(route.Accounts) > 64 {
		return bad
	}
	return nil
}

func runSignerAdminWENRouteInstallV1(args []string, stdin io.Reader, stdout io.Writer) error {
	fs, common := newSignerAdminFlagSet("wen-btc install-route")
	wallet := fs.String("wallet-id", "", "normalized wallet identifier")
	if err := parseSignerAdminFlags(fs, args); err != nil {
		return err
	}
	if common.operatorSocket != "" {
		return errors.New("WEN route installation requires only the control socket")
	}
	if _, err := requireSignerAdminControlSocket(common.controlSocket); err != nil {
		return err
	}
	id, err := validateSignerAdminWalletID(*wallet)
	if err != nil {
		return err
	}
	raw, err := io.ReadAll(io.LimitReader(stdin, 65537))
	if err != nil || len(raw) == 0 || len(raw) > 65536 {
		return errors.New("WEN route stdin must contain one reviewed JSON object within 64 KiB")
	}
	var body signerWENBTCRouteInstallRequestV1
	if err = decodeSignerAdminStrictJSON(raw, &body); err != nil {
		return err
	}
	if err = validateWENRouteInstallInputV1(body); err != nil {
		return err
	}
	result, err := callSignerAdmin(common.controlSocket, "v2.wenBtc.route.install", id, body)
	if err != nil {
		return err
	}
	var receipt signerWENBTCRouteInstallReceiptV1
	if decodeSignerAdminStrictJSON(result, &receipt) != nil || receipt.Status != "route-installed" || receipt.SigningEnabled || receipt.WalletID != id || receipt.BaseReviewSHA256 != body.Preview.BaseReviewSHA256 || receipt.RouteSHA256 != body.Preview.RouteSHA256 || !validWENReviewDigestV1(receipt.InstalledReviewSHA256) {
		return errors.New("WEN installation receipt mismatch; reconcile active review before retry")
	}
	normalized, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	return writeSignerAdminResult(normalized, stdout)
}
