package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"syscall"

	solana "github.com/gagliardetto/solana-go"
)

// Internal owner-authorized installation primitive; no wallet socket dispatch.
// All cooperating installers use the same lock. Administrative edits outside
// that lock are not an atomic compare-and-swap participant.
func installWENBTCRouteV1(ctx context.Context, client signerWENBTCSimulationRPCV1, state, walletID string, intent signerWENBTCIntentV1, wallet solana.PublicKey, preview signerWENBTCRoutePreviewV1, now uint64) (string, error) {
	bad := errors.New("WEN BTC route installation review mismatch")
	if preview.Status != "requires-route-review" || preview.Installed || preview.SigningEnabled || preview.Operation != "acquisition" || preview.DescriptorSHA256 != intent.DescriptorSHA256 || preview.OfferSHA256 != intent.OfferSHA256 || len(preview.RouteBytes) == 0 || len(preview.RouteBytes) > 32768 || wenHashV1(preview.RouteBytes) != preview.RouteSHA256 {
		return "", bad
	}
	root, err := wenBTCReviewDirectoryV1(state, walletID)
	if err != nil {
		return "", err
	}
	lock, err := acquireSignerEnrollmentLock(filepath.Join(root, ".route-install.lock"))
	if err != nil {
		return "", errors.New("WEN BTC route installation locked or lock invalid")
	}
	defer func() { syscall.Flock(int(lock.Fd()), syscall.LOCK_UN); lock.Close() }()
	_, review, _, err := loadWENBTCReviewV1(state, walletID, intent)
	if err != nil {
		return "", err
	}
	path := filepath.Join(root, "admission.json")
	original, err := readSignerAdminJSONFile(path, 32768)
	if err != nil {
		return "", err
	}
	if wenHashV1(original) != preview.BaseReviewSHA256 || wallet.String() != review.WalletPublicKey {
		return "", bad
	}
	var bound signerWENBTCReviewV1
	if decodeSignerAdminStrictJSON(original, &bound) != nil || !reflect.DeepEqual(bound, review) {
		return "", bad
	}
	// Use exactly the bytes whose digest the owner reviewed.
	review = bound
	if review.Provider == nil || preview.Validity.ExpiresSlot > review.Provider.ExpiresSlot {
		return "", bad
	}
	if _, err = review.providerRefreshWindow(preview.Validity.ObservedSlot); err != nil {
		return "", err
	}
	review.RouteValidity = &preview.Validity
	if err = review.checkRouteSlot(preview.Validity.ObservedSlot); err != nil {
		return "", err
	}
	var route signerWENBTCRouteV1
	if err = decodeSignerAdminStrictJSON(preview.RouteBytes, &route); err != nil {
		return "", err
	}
	lookups, err := review.preparationPins()
	if err != nil {
		return "", err
	}
	observation, err := simulateWENBTCFromRPCV1(ctx, client, root, review.Pins, intent, wallet, now, review.MaxSlotLag, review.Preparation.ComputeUnits, lookups, &route)
	if err != nil {
		return "", err
	}
	at := 13 + 4*int(binary.LittleEndian.Uint32(route.Data[9:13]))
	if uint64(binary.LittleEndian.Uint16(route.Data[at+16:])) > review.Provider.SlippageBPS {
		return "", bad
	}
	if err = review.checkRouteSlot(observation.slot); err != nil {
		return "", err
	}
	review.RouteSHA256 = preview.RouteSHA256
	next, err := json.Marshal(review)
	if err != nil {
		return "", err
	}
	// Durable immutable dependencies precede active-pointer replacement. A crash
	// here may leave an unused artifact, never a review referencing missing bytes.
	if err = writeWENBTCImmutableV1(root, preview.RouteSHA256, preview.RouteBytes); err != nil {
		return "", err
	}
	if err = writeWENBTCImmutableV1(root, preview.BaseReviewSHA256, original); err != nil {
		return "", err
	}
	latest, err := readSignerAdminJSONFile(path, 32768)
	if err != nil {
		return "", err
	}
	if wenHashV1(latest) != preview.BaseReviewSHA256 {
		return "", errors.New("WEN BTC active review changed before installation")
	}
	stage, err := os.CreateTemp(root, ".route-review-*.tmp")
	if err != nil {
		return "", err
	}
	defer os.Remove(stage.Name())
	if _, err = stage.Write(next); err == nil {
		err = stage.Sync()
	}
	closeErr := stage.Close()
	if err != nil {
		return "", err
	}
	if closeErr != nil {
		return "", closeErr
	}
	if err = os.Rename(stage.Name(), path); err != nil {
		return "", err
	}
	if err = syncWENBTCDirectoryV1(root); err != nil {
		return "", errors.New("WEN BTC review replaced but durability uncertain; reconcile")
	}
	installed, err := readSignerAdminJSONFile(path, 32768)
	if err != nil || wenHashV1(installed) != wenHashV1(next) {
		return "", errors.New("WEN BTC installation readback uncertain; reconcile")
	}
	return wenHashV1(next), nil
}
func syncWENBTCDirectoryV1(root string) error {
	d, err := os.Open(root)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
func writeWENBTCImmutableV1(root, digest string, raw []byte) error {
	if wenHashV1(raw) != digest {
		return errors.New("WEN immutable artifact digest mismatch")
	}
	path := filepath.Join(root, digest)
	if _, err := os.Lstat(path); err == nil {
		_, err = readWENBTCObjectV1(root, digest, 32768)
		return err
	} else if !os.IsNotExist(err) {
		return err
	}
	f, err := os.CreateTemp(root, ".route-object-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(raw); err == nil {
		err = f.Sync()
	}
	closed := f.Close()
	if err != nil {
		return err
	}
	if closed != nil {
		return closed
	}
	if err = os.Link(f.Name(), path); err != nil {
		if !os.IsExist(err) {
			return err
		}
		_, err = readWENBTCObjectV1(root, digest, 32768)
		if err != nil {
			return err
		}
	}
	return syncWENBTCDirectoryV1(root)
}
