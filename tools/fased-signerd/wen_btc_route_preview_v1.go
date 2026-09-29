package main

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"

	solana "github.com/gagliardetto/solana-go"
)

type signerWENBTCRoutePreviewV1 struct {
	Operation                 string                      `json:"operation"`
	DescriptorSHA256          string                      `json:"descriptorSha256"`
	OfferSHA256               string                      `json:"offerSha256"`
	Status                    string                      `json:"status"`
	SigningEnabled            bool                        `json:"signingEnabled"`
	Installed                 bool                        `json:"installed"`
	BaseReviewSHA256          string                      `json:"baseReviewSha256"`
	RouteSHA256               string                      `json:"routeSha256"`
	ProviderInstructionSHA256 string                      `json:"providerInstructionSha256"`
	RouteBytes                []byte                      `json:"routeBase64"`
	Validity                  signerWENBTCRouteValidityV1 `json:"validity"`
}

func previewWENBTCRouteV1(ctx context.Context, client signerWENBTCReadRPCV1, provider signerWENBTCProviderV1, state, walletID string, intent signerWENBTCIntentV1, wallet solana.PublicKey, now uint64) (signerWENBTCRoutePreviewV1, error) {
	var out signerWENBTCRoutePreviewV1
	root, review, route, err := loadWENBTCReviewV1(state, walletID, intent)
	if err != nil {
		return out, err
	}
	path := filepath.Join(root, "admission.json")
	before, err := readSignerAdminJSONFile(path, 32768)
	if err != nil {
		return out, err
	}
	var bound signerWENBTCReviewV1
	if err = decodeSignerAdminStrictJSON(before, &bound); err != nil {
		return out, err
	}
	if !reflect.DeepEqual(bound, review) || route == nil {
		return out, errors.New("WEN BTC review changed before refresh")
	}
	candidate, err := refreshWENBTCRouteRPCV1(ctx, client, provider, root, review, wallet, now, *route)
	if err != nil {
		return out, err
	}
	after, err := readSignerAdminJSONFile(path, 32768)
	if err != nil {
		return out, err
	}
	if wenHashV1(before) != wenHashV1(after) {
		return out, errors.New("WEN BTC review changed during refresh; retry")
	}
	return signerWENBTCRoutePreviewV1{Operation: intent.Operation, DescriptorSHA256: intent.DescriptorSHA256, OfferSHA256: intent.OfferSHA256, Status: "requires-route-review", BaseReviewSHA256: wenHashV1(before), RouteSHA256: candidate.routeSHA256, ProviderInstructionSHA256: candidate.providerInstructionSHA256, RouteBytes: append([]byte(nil), candidate.routeBytes...), Validity: candidate.validity}, nil
}
