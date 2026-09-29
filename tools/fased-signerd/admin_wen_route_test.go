package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func wenAdminRouteInput(t *testing.T) signerWENBTCRouteInstallRequestV1 {
	_, _, intent, _, _ := wenArtifactCase(t)
	intent.Operation = "acquisition"
	_, _, route, _, _ := wenAcquisitionFixture(t)
	raw, _ := json.Marshal(route)
	return signerWENBTCRouteInstallRequestV1{Intent: intent, Preview: signerWENBTCRoutePreviewV1{Operation: "acquisition", Status: "requires-route-review", DescriptorSHA256: intent.DescriptorSHA256, OfferSHA256: intent.OfferSHA256, BaseReviewSHA256: strings.Repeat("1", 64), ProviderInstructionSHA256: strings.Repeat("2", 64), RouteBytes: raw, RouteSHA256: wenHashV1(raw), Validity: signerWENBTCRouteValidityV1{ObservedSlot: 150, ExpiresSlot: 160}}}
}
func TestWENAdminInstallInput(t *testing.T) {
	for _, name := range []string{"valid", "signed", "installed", "hash", "provider", "offer", "expired", "route", "operation"} {
		t.Run(name, func(t *testing.T) {
			b := wenAdminRouteInput(t)
			switch name {
			case "signed":
				b.Preview.SigningEnabled = true
			case "installed":
				b.Preview.Installed = true
			case "hash":
				b.Preview.BaseReviewSHA256 = "x"
			case "provider":
				b.Preview.ProviderInstructionSHA256 = ""
			case "offer":
				b.Preview.OfferSHA256 = strings.Repeat("0", 64)
			case "expired":
				b.Preview.Validity.ExpiresSlot = 150
			case "route":
				b.Preview.RouteBytes = []byte("{}")
				b.Preview.RouteSHA256 = wenHashV1(b.Preview.RouteBytes)
			case "operation":
				b.Intent.Operation = "acceptance"
			}
			err := validateWENRouteInstallInputV1(b)
			if (err == nil) != (name == "valid") {
				t.Fatal("unexpected validation", err)
			}
		})
	}
}
func TestWENAdminInstallSocket(t *testing.T) {
	for _, name := range []string{"valid", "wallet", "base", "route", "signed", "status", "installed-hash"} {
		t.Run(name, func(t *testing.T) {
			body := wenAdminRouteInput(t)
			raw, _ := json.Marshal(body)
			r := signerWENBTCRouteInstallReceiptV1{Status: "route-installed", WalletID: "buyer", BaseReviewSHA256: body.Preview.BaseReviewSHA256, RouteSHA256: body.Preview.RouteSHA256, InstalledReviewSHA256: strings.Repeat("3", 64)}
			switch name {
			case "wallet":
				r.WalletID = "other"
			case "base":
				r.BaseReviewSHA256 = strings.Repeat("4", 64)
			case "route":
				r.RouteSHA256 = strings.Repeat("4", 64)
			case "signed":
				r.SigningEnabled = true
			case "status":
				r.Status = "pending"
			case "installed-hash":
				r.InstalledReviewSHA256 = "bad"
			}
			receipt, _ := json.Marshal(r)
			server := startSignerAdminTestServer(t, signerAdminTestSuccess(t, string(receipt)))
			var stdout bytes.Buffer
			err := runSignerAdminCLI([]string{"wen-btc", "install-route", "--control-socket", server.path, "--wallet-id", "buyer"}, bytes.NewReader(raw), &stdout, nil)
			req := waitSignerAdminTestServer(t, server)
			if req.Op != "v2.wenBtc.route.install" || req.WalletID != "buyer" {
				t.Fatal("wrong request")
			}
			var sent signerWENBTCRouteInstallRequestV1
			decodeSignerAdminTestBody(t, req, &sent)
			if sent.Preview.BaseReviewSHA256 != body.Preview.BaseReviewSHA256 || !bytes.Equal(sent.Preview.RouteBytes, body.Preview.RouteBytes) {
				t.Fatal("review changed in transit")
			}
			if name == "valid" {
				if err != nil || !strings.Contains(stdout.String(), r.InstalledReviewSHA256) {
					t.Fatal("missing receipt", err)
				}
			} else {
				if err == nil || stdout.Len() != 0 {
					t.Fatal("unbound receipt accepted")
				}
			}
		})
	}
}
