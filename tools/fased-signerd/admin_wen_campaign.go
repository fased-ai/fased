package main

import (
	"encoding/json"
	"errors"
	"io"
	"reflect"
)

func runSignerAdminCampaignV1(action string, args []string, stdin io.Reader, stdout io.Writer) error {
	fs, common := newSignerAdminFlagSet("wen-campaign " + action)
	wallet := fs.String("wallet-id", "", "normalized wallet identifier")
	if e := parseSignerAdminFlags(fs, args); e != nil {
		return e
	}
	if common.operatorSocket != "" {
		return errors.New("campaign installation requires control socket")
	}
	if _, e := requireSignerAdminControlSocket(common.controlSocket); e != nil {
		return e
	}
	id, e := validateSignerAdminWalletID(*wallet)
	if e != nil {
		return e
	}
	raw, e := io.ReadAll(io.LimitReader(stdin, 16385))
	if e != nil {
		return e
	}
	if len(raw) == 0 || len(raw) > 16384 {
		return errors.New("campaign installation requires JSON within 16 KiB")
	}
	var body any
	op := ""
	expected := map[string]string{"walletId": id}
	switch action {
	case "install-draft":
		var v wenCampaignDraftInstallRequestV1
		if e = decodeSignerAdminStrictJSON(raw, &v); e != nil {
			return e
		}
		encoded, e := json.Marshal(v.Draft)
		if e != nil {
			return e
		}
		if v.Draft.Version != 1 || v.Draft.WalletID != id || !wenReservationHashV1(v.ExpectedSHA256) || wenHashV1(encoded) != v.ExpectedSHA256 {
			return errors.New("campaign draft preview mismatch")
		}
		body = v
		op = "v2.wenCampaign.draft.install"
		expected["draftSha256"] = v.ExpectedSHA256
		expected["status"] = "draft-installed"
	case "install-admission":
		var v wenCampaignAdmissionInstallRequestV1
		if e = decodeSignerAdminStrictJSON(raw, &v); e != nil {
			return e
		}
		if _, e = validateRequestIDV2(v.RequestID); e != nil {
			return e
		}
		if !wenReservationHashV1(v.ExpectedSHA256) {
			return errors.New("invalid campaign artifact digest")
		}
		body = v
		op = "v2.wenCampaign.admission.install"
		expected["requestId"] = v.RequestID
		expected["artifactDigest"] = v.ExpectedSHA256
		expected["status"] = "admission-installed"
	default:
		return errors.New("unsupported campaign admin command")
	}
	result, e := callSignerAdmin(common.controlSocket, op, id, body)
	if e != nil {
		return e
	}
	var receipt map[string]string
	if e = decodeSignerAdminStrictJSON(result, &receipt); e != nil || !reflect.DeepEqual(receipt, expected) {
		return errors.New("campaign installation receipt mismatch; reconcile before retry")
	}
	normalized, e := json.Marshal(receipt)
	if e != nil {
		return e
	}
	return writeSignerAdminResult(normalized, stdout)
}
