package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const wenMiningAdmissionDirectoryLimitV1 = 4096

func wenMiningAdmissionFilenameV1(name string) bool {
	return name == "admission.json" || strings.HasPrefix(name, "admission-") && strings.HasSuffix(name, ".json") && wenReservationHashV1(strings.TrimSuffix(strings.TrimPrefix(name, "admission-"), ".json"))
}

// Cursor is a filename, not a global snapshot. Restart after each complete pass
// to see insertions before the cursor. Directory size and per-page work are
// bounded; over-capacity directories fail explicitly rather than silently omit.
// Candidates are locators only and must pass the configured claim host again.
func discoverWENMiningAdmissionsV1(ctx context.Context, dbPath, walletID, owner, cursor string, limit int) (wenMiningClaimDiscoveryV1, error) {
	var zero wenMiningClaimDiscoveryV1
	bad := errors.New("mining admission discovery rejected")
	if !filepath.IsAbs(dbPath) || filepath.Clean(dbPath) != dbPath || walletID == "" || normalizeWalletID(walletID) != walletID || limit < 1 || limit > 100 || cursor != "" && !wenMiningAdmissionFilenameV1(cursor) {
		return zero, bad
	}
	if err := ctx.Err(); err != nil {
		return zero, err
	}
	root := filepath.Join(filepath.Dir(dbPath), "wen-mining", wenHashV1([]byte(walletID)))
	if err := checkWENMiningRootV1(root, filepath.Dir(dbPath)); err != nil {
		return zero, err
	}
	dir, err := os.Open(root)
	if err != nil {
		return zero, err
	}
	defer dir.Close()
	original, err := dir.Stat()
	if err != nil {
		return zero, err
	}
	entries, err := dir.ReadDir(wenMiningAdmissionDirectoryLimitV1 + 1)
	if err != nil && err != io.EOF {
		return zero, err
	}
	if len(entries) > wenMiningAdmissionDirectoryLimitV1 {
		return zero, bad
	}
	names := []string{}
	for _, entry := range entries {
		name := entry.Name()
		if name == "admission.json" || strings.HasPrefix(name, "admission-") {
			if !wenMiningAdmissionFilenameV1(name) {
				return zero, bad
			}
			names = append(names, name)
		}
	}
	sort.Strings(names)
	out := wenMiningClaimDiscoveryV1{Candidates: []wenMiningClaimCandidateV1{}}
	for _, name := range names {
		if name <= cursor {
			continue
		}
		if out.Scanned == limit {
			break
		}
		if err := ctx.Err(); err != nil {
			return zero, err
		}
		raw, err := readSignerAdminJSONFile(filepath.Join(root, name), 16384)
		if err != nil {
			return zero, err
		}
		var review wenMiningReviewV1
		if decodeStrictJSONV2(raw, &review) != nil {
			return zero, bad
		}
		scoped := wenMiningAdmissionNameV2(review.Intent)
		if name != "admission.json" && name != scoped {
			return zero, bad
		}
		out.Scanned++
		out.Cursor = name
		if name == "admission.json" {
			if _, err := os.Lstat(filepath.Join(root, scoped)); err == nil {
				continue
			} else if !os.IsNotExist(err) {
				return zero, err
			}
		}
		config, wallet, err := loadWENMiningAdmissionV1(dbPath, walletID, review.Intent)
		canonical, _ := json.Marshal(review)
		if err != nil || wallet.String() != owner || config.reviewSHA != wenHashV1(canonical) {
			return zero, bad
		}
		if review.Intent.Operation == "commit" {
			out.Candidates = append(out.Candidates, wenMiningClaimCandidateV1{Intent: review.Intent, Source: "protected-admission", Status: "requires-settlement-readback"})
		}
	}
	out.Complete = len(names) == 0 || out.Cursor == names[len(names)-1] || cursor >= names[len(names)-1]
	latest, err := os.Lstat(root)
	if err != nil || !os.SameFile(original, latest) {
		return zero, bad
	}
	if err := checkWENMiningRootV1(root, filepath.Dir(dbPath)); err != nil {
		return zero, err
	}
	if err := ctx.Err(); err != nil {
		return zero, err
	}
	return out, nil
}

func (s *signerServiceV2) discoverConfiguredWENMiningAdmissionsV1(ctx context.Context, cfg signerConfig, walletID, cursor string, limit int) (wenMiningClaimDiscoveryV1, error) {
	var zero wenMiningClaimDiscoveryV1
	bad := errors.New("admission discovery configuration rejected")
	if s == nil || s.store == nil || s.keys == nil || cfg.stateDBPath != s.store.db.Path() {
		return zero, bad
	}
	if err := cfg.ensureChainAllowed("solana"); err != nil {
		return zero, err
	}
	record, err := s.keys.PublicRecord(walletID)
	if err != nil {
		return zero, err
	}
	out, err := discoverWENMiningAdmissionsV1(ctx, cfg.stateDBPath, walletID, record.PublicKey, cursor, limit)
	if err != nil {
		return zero, err
	}
	latest, err := s.keys.PublicRecord(walletID)
	if err != nil || latest.PublicKey != record.PublicKey {
		return zero, bad
	}
	return out, nil
}
