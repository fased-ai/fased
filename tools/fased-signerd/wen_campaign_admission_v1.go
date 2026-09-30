package main

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

type wenCampaignAdmissionV1 struct {
	Version        int    `json:"version"`
	WalletID       string `json:"walletId"`
	ArtifactDigest string `json:"artifactDigest"`
}

// Local protected operator admission is separate from owner transaction approval.
// It binds the entire prepared artifact, including deployment, wallet and limits.
// This file cannot be installed by the application execution request.
func loadWENCampaignAdmissionV1(dbPath string, a wenCampaignReviewArtifactV1) error {
	digest, e := a.digest()
	if e != nil {
		return e
	}
	return loadWENCampaignDigestAdmissionV1(dbPath, a.WalletID, digest)
}

func loadWENCampaignDigestAdmissionV1(dbPath, wallet, digest string) error {
	bad := errors.New("protected campaign admission unavailable or changed")
	if !wenReservationHashV1(digest) {
		return bad
	}
	root, e := wenCampaignProtectedRootV1(dbPath, wallet)
	if e != nil {
		return e
	}
	raw, e := readSignerAdminJSONFile(filepath.Join(root, digest+".json"), 4096)
	if e != nil {
		return bad
	}
	var record wenCampaignAdmissionV1
	if decodeStrictJSONV2(raw, &record) != nil || record.Version != 1 || record.WalletID != wallet || record.ArtifactDigest != digest {
		return bad
	}
	return nil
}

func wenCampaignProtectedRootV1(dbPath, walletID string) (string, error) {
	bad := errors.New("unsafe campaign configuration root")
	if walletID == "" || normalizeWalletID(walletID) != walletID {
		return "", bad
	}
	if !filepath.IsAbs(dbPath) || filepath.Clean(dbPath) != dbPath {
		return "", bad
	}
	root := filepath.Join(filepath.Dir(dbPath), "wen-campaign", wenHashV1([]byte(walletID)))
	for dir := root; ; dir = filepath.Dir(dir) {
		info, e := os.Lstat(dir)
		if e != nil {
			return "", bad
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0022 != 0 || (stat.Uid != 0 && stat.Uid != uint32(os.Geteuid())) {
			return "", bad
		}
		if dir == filepath.Dir(dbPath) {
			break
		}
	}
	return root, nil
}
