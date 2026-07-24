package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/term"
)

func validateSignerAdminRecoveryPasswordV1(raw []byte) ([]byte, error) {
	raw = bytes.TrimSuffix(raw, []byte{'\n'})
	raw = bytes.TrimSuffix(raw, []byte{'\r'})
	if len(raw) < 12 || len(raw) > maxSignerRecoveryPasswordBytes || bytes.IndexByte(raw, 0) >= 0 {
		zeroBytes(raw)
		return nil, errors.New("recovery password must contain 12 to 1024 bytes")
	}
	return raw, nil
}

func readSignerAdminRecoveryPasswordV1(stdin io.Reader, confirm bool) ([]byte, error) {
	if file, ok := stdin.(*os.File); ok && term.IsTerminal(int(file.Fd())) {
		_, _ = fmt.Fprint(os.Stderr, "Recovery password: ")
		first, err := term.ReadPassword(int(file.Fd()))
		_, _ = fmt.Fprintln(os.Stderr)
		if err != nil {
			return nil, errors.New("read recovery password from terminal")
		}
		first, err = validateSignerAdminRecoveryPasswordV1(first)
		if err != nil {
			return nil, err
		}
		if !confirm {
			return first, nil
		}
		_, _ = fmt.Fprint(os.Stderr, "Confirm recovery password: ")
		second, secondErr := term.ReadPassword(int(file.Fd()))
		_, _ = fmt.Fprintln(os.Stderr)
		if secondErr != nil {
			zeroBytes(first)
			return nil, errors.New("read recovery password confirmation from terminal")
		}
		second, secondErr = validateSignerAdminRecoveryPasswordV1(second)
		if secondErr != nil {
			zeroBytes(first)
			return nil, secondErr
		}
		matches := bytes.Equal(first, second)
		zeroBytes(second)
		if !matches {
			zeroBytes(first)
			return nil, errors.New("recovery password confirmation does not match")
		}
		return first, nil
	}
	raw, err := io.ReadAll(io.LimitReader(stdin, maxSignerRecoveryPasswordBytes+3))
	if err != nil {
		return nil, errors.New("read recovery password from stdin")
	}
	return validateSignerAdminRecoveryPasswordV1(raw)
}

func stageSignerAdminRecoveryInputV1(socket signerAdminSocketInfo, data []byte) (string, error) {
	return writeSignerAdminImportFile(socket, data)
}

func validateSignerAdminOutputPathV1(raw string) (string, error) {
	path := strings.TrimSpace(raw)
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return "", errors.New("--output must be an absolute clean path")
	}
	parent := filepath.Dir(path)
	info, err := os.Lstat(parent)
	if err != nil {
		return "", errors.New("inspect output directory")
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() || info.Mode().Perm()&0o002 != 0 {
		return "", errors.New("output directory must be a non-symlink directory not writable by others")
	}
	if _, err := os.Lstat(path); err == nil {
		return "", errors.New("output file already exists; choose a new path")
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", errors.New("inspect output file")
	}
	return path, nil
}

func writeSignerAdminOwnerFileV1(path string, data []byte) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return errors.New("create owner-only output file")
	}
	if err := writeAndSyncSignerAdminFile(file, data); err != nil {
		_ = os.Remove(path)
		return err
	}
	if err := syncSignerAdminDirectory(filepath.Dir(path)); err != nil {
		_ = os.Remove(path)
		return err
	}
	return nil
}

func runSignerAdminWalletRecoveryExportV1(args []string, stdin io.Reader, stdout io.Writer) error {
	fs, common := newSignerAdminFlagSet("wallet recovery-export")
	var walletID, expectedPublicKey, outputPath string
	fs.StringVar(&walletID, "wallet-id", "", "normalized wallet identifier")
	fs.StringVar(&expectedPublicKey, "expected-public-key", "", "exact current wallet public key")
	fs.StringVar(&outputPath, "output", "", "new absolute owner-only recovery package path")
	if err := parseSignerAdminFlags(fs, args); err != nil {
		return err
	}
	socket, operator, err := requireSignerAdminLifecycleSocket(common)
	if err != nil {
		return err
	}
	if operator {
		return errors.New("recovery export is unavailable on the operator socket; use a root-authorized signer-owner ceremony")
	}
	if socket.ownerUID >= 0 && socket.ownerUID != os.Geteuid() {
		return errors.New("recovery export must run as the signer control socket owner")
	}
	if walletID, err = validateSignerAdminWalletID(walletID); err != nil {
		return err
	}
	if expectedPublicKey, err = validateSignerAdminPublicKeyV2(expectedPublicKey, "--expected-public-key"); err != nil {
		return err
	}
	if outputPath, err = validateSignerAdminOutputPathV1(outputPath); err != nil {
		return err
	}
	password, err := readSignerAdminRecoveryPasswordV1(stdin, true)
	if err != nil {
		return err
	}
	defer zeroBytes(password)
	passwordPath, err := stageSignerAdminRecoveryInputV1(socket, password)
	if err != nil {
		return err
	}
	body := signerWalletRecoveryExportRequestV2{ExpectedPublicKey: expectedPublicKey, PasswordPath: passwordPath}
	resultRaw, callErr := callSignerAdminSensitiveV2(common.controlSocket, "v2.wallet.recovery.export", walletID, body)
	cleanupErr := cleanupSignerAdminImportFile(passwordPath)
	if cleanupErr != nil {
		return errors.New("recovery password staging cleanup failed; inspect the signer-only import directory")
	}
	if callErr != nil {
		return callErr
	}
	var result signerWalletRecoveryExportResultV2
	if err := decodeSignerAdminStrictJSON(resultRaw, &result); err != nil || result.WalletID != walletID || result.PublicKey != expectedPublicKey {
		return errors.New("signer returned an invalid recovery export result")
	}
	if err := validateSignerRecoveryPackageV1(result.Package); err != nil {
		return errors.New("signer returned an invalid recovery package")
	}
	encoded, err := json.MarshalIndent(result.Package, "", "  ")
	if err != nil {
		return errors.New("encode recovery package")
	}
	encoded = append(encoded, '\n')
	if err := writeSignerAdminOwnerFileV1(outputPath, encoded); err != nil {
		return err
	}
	return writeSignerAdminResult(mustMarshalSignerAdminPublicResultV1(map[string]any{
		"walletId": result.WalletID, "role": result.Role, "publicKey": result.PublicKey, "output": outputPath,
	}), stdout)
}

func runSignerAdminWalletRecoveryImportV1(args []string, stdin io.Reader, stdout io.Writer) error {
	fs, common := newSignerAdminFlagSet("wallet recovery-import")
	var walletID, policyFile, lockedRole, baselineRole, recoveryFile string
	fs.StringVar(&walletID, "wallet-id", "", "new normalized wallet identifier")
	fs.StringVar(&policyFile, "policy-file", "", "absolute strict policy JSON path")
	fs.StringVar(&lockedRole, "locked-role", "", "agent, mining, or vault deny-all policy")
	fs.StringVar(&baselineRole, "baseline-role", "", "agent, mining, or vault signer-owned role baseline")
	fs.StringVar(&recoveryFile, "recovery-file", "", "absolute owner-only recovery package path")
	if err := parseSignerAdminFlags(fs, args); err != nil {
		return err
	}
	socket, operator, err := requireSignerAdminLifecycleSocket(common)
	if err != nil {
		return err
	}
	if operator {
		return errors.New("recovery import is unavailable on the operator socket; use a root-authorized signer-owner ceremony")
	}
	if socket.ownerUID >= 0 && socket.ownerUID != os.Geteuid() {
		return errors.New("recovery import must run as the signer control socket owner")
	}
	if walletID, err = validateSignerAdminWalletID(walletID); err != nil {
		return err
	}
	useBaseline := strings.TrimSpace(baselineRole) != ""
	if useBaseline && (strings.TrimSpace(policyFile) != "" || strings.TrimSpace(lockedRole) != "") {
		return errors.New("--baseline-role cannot be combined with --policy-file or --locked-role")
	}
	var policy signerPolicyV2
	if useBaseline {
		baseline, baselineErr := normalizeRoleBaselineRequestV1(signerRoleBaselineRequestV1{
			Version: signerRoleBaselineVersionV1,
			Role:    baselineRole,
		})
		if baselineErr != nil {
			return fmt.Errorf("invalid --baseline-role: %w", baselineErr)
		}
		baselineRole = baseline.Role
	} else {
		policy, err = resolveSignerAdminCreationPolicy(walletID, policyFile, lockedRole)
		if err != nil {
			return err
		}
	}
	recoveryRaw, err := readSignerAdminJSONFile(recoveryFile, maxSignerRecoveryPackageBytes)
	if err != nil {
		return fmt.Errorf("read recovery package: %w", err)
	}
	defer zeroBytes(recoveryRaw)
	var pkg signerWalletRecoveryPackageV1
	if err := decodeSignerAdminStrictJSON(recoveryRaw, &pkg); err != nil || validateSignerRecoveryPackageV1(pkg) != nil {
		return errors.New("recovery file must contain one supported strict recovery package")
	}
	requestedRole := policy.Role
	if useBaseline {
		requestedRole = baselineRole
	}
	if pkg.Role != requestedRole {
		return errors.New("recovery package role does not match the requested baseline or policy role")
	}
	password, err := readSignerAdminRecoveryPasswordV1(stdin, false)
	if err != nil {
		return err
	}
	defer zeroBytes(password)
	recoveryPath, err := stageSignerAdminRecoveryInputV1(socket, recoveryRaw)
	if err != nil {
		return err
	}
	passwordPath, err := stageSignerAdminRecoveryInputV1(socket, password)
	if err != nil {
		_ = cleanupSignerAdminImportFile(recoveryPath)
		return err
	}
	body := signerWalletRecoveryImportRequestV2{
		ExpectedVersion: 0, Policy: policy, RecoveryPath: recoveryPath, PasswordPath: passwordPath,
	}
	if useBaseline {
		body.Baseline = &signerRoleBaselineRequestV1{Version: signerRoleBaselineVersionV1, Role: baselineRole}
	}
	result, callErr := callSignerAdminSensitiveV2(common.controlSocket, "v2.wallet.recovery.import", walletID, body)
	cleanupRecoveryErr := cleanupSignerAdminImportFile(recoveryPath)
	cleanupPasswordErr := cleanupSignerAdminImportFile(passwordPath)
	if cleanupRecoveryErr != nil || cleanupPasswordErr != nil {
		return errors.New("recovery import staging cleanup failed; inspect the signer-only import directory")
	}
	if callErr != nil {
		return callErr
	}
	return writeSignerAdminResult(result, stdout)
}

func createSignerAdminRawExportStageV2(socket signerAdminSocketInfo) (string, error) {
	directory := filepath.Join(filepath.Dir(socket.path), ".admin-export")
	if err := os.Mkdir(directory, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return "", errors.New("create signer raw-export directory")
	}
	info, err := os.Lstat(directory)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
		return "", errors.New("signer raw-export directory must be an owner-only non-symlink directory")
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Geteuid() {
		return "", errors.New("signer raw-export directory must be owned by the signer admin user")
	}
	for attempt := 0; attempt < 8; attempt++ {
		random := make([]byte, 16)
		if _, err := rand.Read(random); err != nil {
			return "", errors.New("generate raw-export filename")
		}
		name := ".wallet-export-" + hex.EncodeToString(random) + ".json"
		zeroBytes(random)
		path := filepath.Join(directory, name)
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return "", errors.New("create signer raw-export staging file")
		}
		if err := file.Close(); err != nil {
			_ = os.Remove(path)
			return "", errors.New("close signer raw-export staging file")
		}
		return path, nil
	}
	return "", errors.New("could not allocate an exclusive signer raw-export file")
}

func runSignerAdminWalletRawExportV2(args []string, stdout io.Writer) error {
	fs, common := newSignerAdminFlagSet("wallet export-raw")
	var walletID, expectedPublicKey, outputPath string
	var acknowledge bool
	fs.StringVar(&walletID, "wallet-id", "", "normalized wallet identifier")
	fs.StringVar(&expectedPublicKey, "expected-public-key", "", "exact current wallet public key")
	fs.StringVar(&outputPath, "output", "", "new absolute owner-only raw keypair path")
	fs.BoolVar(&acknowledge, "acknowledge-custody-reduction", false, "confirm that raw export reduces signer custody protection")
	if err := parseSignerAdminFlags(fs, args); err != nil {
		return err
	}
	if !acknowledge {
		return errors.New("--acknowledge-custody-reduction is required")
	}
	socket, operator, err := requireSignerAdminLifecycleSocket(common)
	if err != nil {
		return err
	}
	if operator {
		return errors.New("raw wallet export is unavailable on the operator socket; use a root-authorized signer-owner ceremony")
	}
	if socket.ownerUID >= 0 && socket.ownerUID != os.Geteuid() {
		return errors.New("raw wallet export must run as the signer control socket owner")
	}
	if walletID, err = validateSignerAdminWalletID(walletID); err != nil {
		return err
	}
	if expectedPublicKey, err = validateSignerAdminPublicKeyV2(expectedPublicKey, "--expected-public-key"); err != nil {
		return err
	}
	if outputPath, err = validateSignerAdminOutputPathV1(outputPath); err != nil {
		return err
	}
	stagePath, err := createSignerAdminRawExportStageV2(socket)
	if err != nil {
		return err
	}
	body := signerWalletRawExportRequestV2{ExpectedPublicKey: expectedPublicKey, Path: stagePath}
	resultRaw, callErr := callSignerAdminSensitiveV2(common.controlSocket, "v2.wallet.exportRaw", walletID, body)
	if callErr != nil {
		_ = cleanupSignerAdminImportFile(stagePath)
		return callErr
	}
	var result signerWalletRawExportResultV2
	if err := decodeSignerAdminStrictJSON(resultRaw, &result); err != nil || !result.Written || result.WalletID != walletID || result.PublicKey != expectedPublicKey {
		_ = cleanupSignerAdminImportFile(stagePath)
		return errors.New("signer returned an invalid raw-export result")
	}
	raw, err := readSignerAdminJSONFile(stagePath, maxSignerImportBytesV2)
	if err != nil {
		_ = cleanupSignerAdminImportFile(stagePath)
		return errors.New("read signer raw-export staging file")
	}
	defer zeroBytes(raw)
	canonical, err := readSignerAdminSolanaKeypair(bytes.NewReader(raw))
	if err != nil {
		_ = cleanupSignerAdminImportFile(stagePath)
		return errors.New("signer raw-export staging file is invalid")
	}
	defer zeroBytes(canonical)
	canonical = append(canonical, '\n')
	if err := writeSignerAdminOwnerFileV1(outputPath, canonical); err != nil {
		_ = cleanupSignerAdminImportFile(stagePath)
		return err
	}
	if err := cleanupSignerAdminImportFile(stagePath); err != nil {
		return errors.New("raw-export staging cleanup failed; remove the signer-only staged file")
	}
	return writeSignerAdminResult(mustMarshalSignerAdminPublicResultV1(map[string]any{
		"walletId": result.WalletID, "publicKey": result.PublicKey, "output": outputPath, "custodyReduced": true,
	}), stdout)
}

func mustMarshalSignerAdminPublicResultV1(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic("encode signer admin public result")
	}
	return encoded
}
