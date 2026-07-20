package main

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	maxSignerAdminPolicyBytes   = 64 << 10
	maxSignerAdminResponseBytes = 1 << 20
	signerAdminSocketTimeout    = 15 * time.Second
)

type signerAdminRequiredUint64 struct {
	value uint64
	set   bool
}

func (v *signerAdminRequiredUint64) String() string {
	return fmt.Sprintf("%d", v.value)
}

func (v *signerAdminRequiredUint64) Set(raw string) error {
	parsed, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		return errors.New("expected an unsigned integer")
	}
	v.value = parsed
	v.set = true
	return nil
}

type signerAdminCommonFlags struct {
	controlSocket string
}

type signerAdminSocketInfo struct {
	path     string
	ownerUID int
}

type signerAdminResponse struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

func runSignerAdminCLI(args []string, stdin io.Reader, stdout io.Writer, environ []string) error {
	if err := rejectSignerAdminSecretInputs(args, environ); err != nil {
		return err
	}
	if len(args) >= 2 && args[0] == "network" && args[1] == "put" {
		if err := rejectSignerAdminNetworkEnvironmentV2(environ); err != nil {
			return err
		}
	}
	if len(args) < 2 {
		return signerAdminUsageError()
	}

	switch args[0] {
	case "wallet":
		switch args[1] {
		case "create":
			return runSignerAdminWalletCreate(args[2:], stdout)
		case "import":
			return runSignerAdminWalletImport(args[2:], stdin, stdout)
		case "import-legacy":
			return runSignerAdminWalletImportLegacy(args[2:], stdout)
		case "recovery-export":
			return runSignerAdminWalletRecoveryExportV1(args[2:], stdin, stdout)
		case "recovery-import":
			return runSignerAdminWalletRecoveryImportV1(args[2:], stdin, stdout)
		case "export-raw":
			return runSignerAdminWalletRawExportV2(args[2:], stdout)
		case "reencrypt":
			return runSignerAdminWalletReencrypt(args[2:], stdout)
		case "rotate-successor":
			return runSignerAdminWalletRotateSuccessor(args[2:], stdout)
		case "rotation-status":
			return runSignerAdminWalletRotationStatus(args[2:], stdout)
		case "rotation-commit":
			return runSignerAdminWalletRotationCommit(args[2:], stdout)
		default:
			return errors.New("unknown signer admin wallet command")
		}
	case "policy":
		switch args[1] {
		case "get":
			return runSignerAdminPolicyGet(args[2:], stdout)
		case "put":
			return runSignerAdminPolicyPut(args[2:], stdout)
		default:
			return errors.New("unknown signer admin policy command")
		}
	case "network":
		switch args[1] {
		case "get":
			return runSignerAdminNetworkGet(args[2:], stdout)
		case "put":
			return runSignerAdminNetworkPut(args[2:], stdin, stdout)
		default:
			return errors.New("unknown signer admin network command")
		}
	case "jupiter":
		switch args[1] {
		case "api-key-install":
			return runSignerAdminJupiterAPIKeyInstallV2(args[2:], stdin, stdout)
		case "api-key-status":
			return runSignerAdminJupiterAPIKeyStatusV2(args[2:], stdout)
		case "api-key-remove":
			return runSignerAdminJupiterAPIKeyRemoveV2(args[2:], stdout)
		default:
			return errors.New("unknown signer admin jupiter command")
		}
	case "webauthn":
		if len(args) < 3 {
			return errors.New("signer admin webauthn requires registration, credentials, or enrollment command")
		}
		switch args[1] + " " + args[2] {
		case "registration begin":
			return runSignerAdminWebAuthnRegistrationBegin(args[3:], stdout)
		case "registration finish":
			return runSignerAdminWebAuthnRegistrationFinish(args[3:], stdout)
		case "credentials list":
			return runSignerAdminWebAuthnCredentialsList(args[3:], stdout)
		case "credentials revoke":
			return runSignerAdminWebAuthnCredentialsRevoke(args[3:], stdout)
		case "enrollment serve":
			return runSignerAdminWebAuthnEnrollmentServe(args[3:], stdout)
		default:
			return errors.New("unknown signer admin webauthn command")
		}
	case "migration":
		if args[1] != "hosted-v1" {
			return errors.New("unknown signer admin migration command")
		}
		return runSignerAdminHostedMigrationV1(args[2:], stdout)
	default:
		return errors.New("unknown signer admin command")
	}
}

func signerAdminUsageError() error {
	return errors.New("usage: fased-signerd admin {wallet|policy|network|jupiter|webauthn|migration} <command> [flags]")
}

func rejectSignerAdminNetworkEnvironmentV2(environ []string) error {
	for _, entry := range environ {
		name, _, found := strings.Cut(entry, "=")
		upper := strings.ToUpper(name)
		if !found || !strings.HasPrefix(upper, "FASED_") {
			continue
		}
		if strings.Contains(upper, "RPC") || strings.Contains(upper, "ENDPOINT") {
			return errors.New("Fased RPC environment variables are not accepted by signer admin network put; provide strict JSON on stdin")
		}
	}
	return nil
}

func rejectSignerAdminSecretInputs(args, environ []string) error {
	for _, arg := range args {
		if !strings.HasPrefix(arg, "-") {
			continue
		}
		name := strings.ToUpper(strings.TrimLeft(strings.SplitN(arg, "=", 2)[0], "-"))
		if name == "PASSPHRASE_PATH" || name == "PASSPHRASE-PATH" {
			// A path to an owner-only file is migration metadata, not the passphrase value.
			// The native signer reads and consumes the file through its control socket.
			continue
		}
		for _, marker := range []string{"PRIVATE_KEY", "PRIVATE-KEY", "SECRET_KEY", "SECRET-KEY", "API_KEY", "API-KEY", "KEYPAIR", "MNEMONIC", "PASSPHRASE", "SEED"} {
			if strings.Contains(name, marker) {
				return errors.New("secret material is not accepted in signer admin command arguments; supported secret-install commands read only stdin")
			}
		}
	}
	for _, entry := range environ {
		name, _, found := strings.Cut(entry, "=")
		upper := strings.ToUpper(name)
		if !found || (!strings.HasPrefix(upper, "FASED_") && upper != "JUPITER_API_KEY") {
			continue
		}
		if upper == "FASED_WALLET_JUPITER_API_KEY_FILE" {
			// This contains only a signer-owned file path, never the credential.
			continue
		}
		for _, marker := range []string{"PRIVATE_KEY", "SECRET_KEY", "API_KEY", "KEYPAIR", "MNEMONIC", "PASSPHRASE", "SEED"} {
			if strings.Contains(upper, marker) {
				return errors.New("secret-bearing environment variables are not accepted by signer admin; unset them and use stdin for the supported secret-install command")
			}
		}
	}
	return nil
}

func newSignerAdminFlagSet(name string) (*flag.FlagSet, *signerAdminCommonFlags) {
	fs := flag.NewFlagSet("fased-signerd admin "+name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	common := &signerAdminCommonFlags{}
	fs.StringVar(&common.controlSocket, "control-socket", "", "absolute signer control socket path")
	return fs, common
}

func parseSignerAdminFlags(fs *flag.FlagSet, args []string) error {
	if err := fs.Parse(args); err != nil {
		return errors.New("invalid or unknown signer admin flag")
	}
	if fs.NArg() != 0 {
		return errors.New("unexpected signer admin positional arguments")
	}
	return nil
}

func requireSignerAdminControlSocket(raw string) (signerAdminSocketInfo, error) {
	path := strings.TrimSpace(raw)
	if path == "" {
		return signerAdminSocketInfo{}, errors.New("--control-socket is required")
	}
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return signerAdminSocketInfo{}, errors.New("signer admin control socket path must be absolute and clean")
	}
	parent := filepath.Dir(path)
	parentInfo, err := os.Lstat(parent)
	if err != nil {
		return signerAdminSocketInfo{}, fmt.Errorf("inspect signer control socket directory: %w", err)
	}
	if parentInfo.Mode()&os.ModeSymlink != 0 || !parentInfo.IsDir() {
		return signerAdminSocketInfo{}, errors.New("signer control socket directory must be a non-symlink directory")
	}
	if parentInfo.Mode().Perm()&0o022 != 0 {
		return signerAdminSocketInfo{}, errors.New("signer control socket directory must not be group/world writable")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return signerAdminSocketInfo{}, fmt.Errorf("inspect signer control socket: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || info.Mode()&os.ModeSocket == 0 {
		return signerAdminSocketInfo{}, errors.New("signer admin control socket must be a non-symlink Unix socket")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return signerAdminSocketInfo{}, errors.New("signer admin control socket must not be group/world accessible")
	}
	ownerUID := -1
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		ownerUID = int(stat.Uid)
		if os.Geteuid() != 0 && ownerUID != os.Geteuid() {
			return signerAdminSocketInfo{}, errors.New("signer admin control socket must be owned by the current user")
		}
	}
	return signerAdminSocketInfo{path: path, ownerUID: ownerUID}, nil
}

func validateSignerAdminWalletID(raw string) (string, error) {
	walletID := strings.TrimSpace(raw)
	if walletID == "" || len(walletID) > 64 {
		return "", errors.New("--wallet-id must contain 1 to 64 characters")
	}
	normalized := normalizeWalletID(walletID)
	if normalized != walletID {
		return "", errors.New("--wallet-id must already be normalized lowercase letters, numbers, or underscores")
	}
	return walletID, nil
}

func loadSignerAdminPolicy(path, walletID string) (signerPolicyV2, error) {
	raw, err := readSignerAdminJSONFile(path, maxSignerAdminPolicyBytes)
	if err != nil {
		return signerPolicyV2{}, fmt.Errorf("read signer policy file: %w", err)
	}
	defer zeroBytes(raw)
	var policy signerPolicyV2
	if err := decodeSignerAdminStrictJSON(raw, &policy); err != nil {
		return signerPolicyV2{}, errors.New("signer policy file must contain one strict policy JSON object")
	}
	if strings.TrimSpace(policy.WalletID) != "" && normalizeWalletID(policy.WalletID) != walletID {
		return signerPolicyV2{}, errors.New("signer policy walletId does not match --wallet-id")
	}
	policy.WalletID = walletID
	policy.Version = 0
	policy.Hash = ""
	normalized, err := normalizeSignerPolicyV2(policy)
	if err != nil {
		return signerPolicyV2{}, fmt.Errorf("invalid signer policy: %w", err)
	}
	return normalized, nil
}

func lockedSignerAdminPolicy(walletID, role string) (signerPolicyV2, error) {
	role = strings.TrimSpace(strings.ToLower(role))
	policy := signerPolicyV2{
		WalletID:   walletID,
		Role:       role,
		Operations: []string{},
		Programs:   []string{},
		Assets:     []signerPolicyAssetV2{},
	}
	normalized, err := normalizeSignerPolicyV2(policy)
	if err != nil {
		return signerPolicyV2{}, fmt.Errorf("invalid --locked-role: %w", err)
	}
	return normalized, nil
}

func resolveSignerAdminCreationPolicy(walletID, policyFile, lockedRole string) (signerPolicyV2, error) {
	hasPolicyFile := strings.TrimSpace(policyFile) != ""
	hasLockedRole := strings.TrimSpace(lockedRole) != ""
	if hasPolicyFile == hasLockedRole {
		return signerPolicyV2{}, errors.New("exactly one of --policy-file or --locked-role is required")
	}
	if hasPolicyFile {
		return loadSignerAdminPolicy(policyFile, walletID)
	}
	return lockedSignerAdminPolicy(walletID, lockedRole)
}

func runSignerAdminWalletCreate(args []string, stdout io.Writer) error {
	fs, common := newSignerAdminFlagSet("wallet create")
	var walletID, policyFile, lockedRole string
	fs.StringVar(&walletID, "wallet-id", "", "normalized wallet identifier")
	fs.StringVar(&policyFile, "policy-file", "", "absolute strict policy JSON path")
	fs.StringVar(&lockedRole, "locked-role", "", "agent, mining, or vault deny-all policy")
	if err := parseSignerAdminFlags(fs, args); err != nil {
		return err
	}
	if _, err := requireSignerAdminControlSocket(common.controlSocket); err != nil {
		return err
	}
	walletID, err := validateSignerAdminWalletID(walletID)
	if err != nil {
		return err
	}
	policy, err := resolveSignerAdminCreationPolicy(walletID, policyFile, lockedRole)
	if err != nil {
		return err
	}
	body := signerWalletCreateRequestV2{ExpectedVersion: 0, Policy: policy}
	return callAndWriteSignerAdmin(common.controlSocket, "v2.wallet.create", walletID, body, stdout)
}

func runSignerAdminWalletImport(args []string, stdin io.Reader, stdout io.Writer) error {
	fs, common := newSignerAdminFlagSet("wallet import")
	var walletID, policyFile, lockedRole, baselineRole string
	fs.StringVar(&walletID, "wallet-id", "", "normalized wallet identifier")
	fs.StringVar(&policyFile, "policy-file", "", "absolute strict policy JSON path")
	fs.StringVar(&lockedRole, "locked-role", "", "agent, mining, or vault deny-all policy")
	fs.StringVar(&baselineRole, "baseline-role", "", "agent, mining, or vault signer-owned role baseline")
	if err := parseSignerAdminFlags(fs, args); err != nil {
		return err
	}
	socketInfo, err := requireSignerAdminControlSocket(common.controlSocket)
	if err != nil {
		return err
	}
	if socketInfo.ownerUID >= 0 && socketInfo.ownerUID != os.Geteuid() {
		return errors.New("wallet import must run as the signer control socket owner so the staged key is signer-owned")
	}
	walletID, err = validateSignerAdminWalletID(walletID)
	if err != nil {
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
	canonicalKeypair, err := readSignerAdminSolanaKeypair(stdin)
	if err != nil {
		return err
	}
	defer zeroBytes(canonicalKeypair)
	importPath, err := writeSignerAdminImportFile(socketInfo, canonicalKeypair)
	if err != nil {
		return err
	}
	body := signerWalletImportRequestV2{ExpectedVersion: 0, Policy: policy, Path: importPath}
	if useBaseline {
		body.Baseline = &signerRoleBaselineRequestV1{Version: signerRoleBaselineVersionV1, Role: baselineRole}
	}
	result, callErr := callSignerAdmin(common.controlSocket, "v2.wallet.import", walletID, body)
	cleanupErr := cleanupSignerAdminImportFile(importPath)
	if cleanupErr != nil {
		return errors.New("signer wallet import staging cleanup failed; inspect the signer-only import directory before continuing")
	}
	if callErr != nil {
		return callErr
	}
	return writeSignerAdminResult(result, stdout)
}

func runSignerAdminWalletImportLegacy(args []string, stdout io.Writer) error {
	fs, common := newSignerAdminFlagSet("wallet import-legacy")
	var walletID, policyFile, lockedRole, keystorePath, passphrasePath string
	fs.StringVar(&walletID, "wallet-id", "", "normalized wallet identifier")
	fs.StringVar(&policyFile, "policy-file", "", "absolute strict policy JSON path")
	fs.StringVar(&lockedRole, "locked-role", "", "agent, mining, or vault deny-all policy")
	fs.StringVar(&keystorePath, "keystore-path", "", "absolute owner-only legacy encrypted keystore path")
	fs.StringVar(&passphrasePath, "passphrase-path", "", "absolute owner-only passphrase file path")
	if err := parseSignerAdminFlags(fs, args); err != nil {
		return err
	}
	socketInfo, err := requireSignerAdminControlSocket(common.controlSocket)
	if err != nil {
		return err
	}
	if socketInfo.ownerUID >= 0 && socketInfo.ownerUID != os.Geteuid() {
		return errors.New("legacy wallet import must run as the signer control socket owner")
	}
	walletID, err = validateSignerAdminWalletID(walletID)
	if err != nil {
		return err
	}
	policy, err := resolveSignerAdminCreationPolicy(walletID, policyFile, lockedRole)
	if err != nil {
		return err
	}
	keystorePath = strings.TrimSpace(keystorePath)
	passphrasePath = strings.TrimSpace(passphrasePath)
	if !filepath.IsAbs(keystorePath) || filepath.Clean(keystorePath) != keystorePath {
		return errors.New("--keystore-path must be an absolute clean path")
	}
	if !filepath.IsAbs(passphrasePath) || filepath.Clean(passphrasePath) != passphrasePath {
		return errors.New("--passphrase-path must be an absolute clean path")
	}
	body := signerWalletLegacyImportRequestV2{
		ExpectedVersion: 0,
		Policy:          policy,
		Path:            keystorePath,
		PassphrasePath:  passphrasePath,
	}
	result, err := callSignerAdminSensitiveV2(common.controlSocket, "v2.wallet.importLegacy", walletID, body)
	if err != nil {
		return err
	}
	return writeSignerAdminResult(result, stdout)
}

func runSignerAdminWalletReencrypt(args []string, stdout io.Writer) error {
	fs, common := newSignerAdminFlagSet("wallet reencrypt")
	var walletID string
	fs.StringVar(&walletID, "wallet-id", "", "normalized wallet identifier")
	if err := parseSignerAdminFlags(fs, args); err != nil {
		return err
	}
	if _, err := requireSignerAdminControlSocket(common.controlSocket); err != nil {
		return err
	}
	walletID, err := validateSignerAdminWalletID(walletID)
	if err != nil {
		return err
	}
	return callAndWriteSignerAdmin(common.controlSocket, "v2.wallet.reencrypt", walletID, nil, stdout)
}

func validateSignerAdminPublicKeyV2(raw, flagName string) (string, error) {
	value, err := normalizeRotationPublicKeyV2(raw, strings.TrimPrefix(flagName, "--"))
	if err != nil {
		return "", fmt.Errorf("%s must be a canonical Solana public key", flagName)
	}
	return value, nil
}

func runSignerAdminWalletRotateSuccessor(args []string, stdout io.Writer) error {
	fs, common := newSignerAdminFlagSet("wallet rotate-successor")
	var sourceWalletID, successorWalletID, sourcePublicKey string
	var sourceWalletVersion, sourcePolicyVersion signerAdminRequiredUint64
	fs.StringVar(&sourceWalletID, "wallet-id", "", "normalized source wallet identifier")
	fs.StringVar(&successorWalletID, "successor-wallet-id", "", "new normalized successor wallet identifier")
	fs.StringVar(&sourcePublicKey, "expected-source-public-key", "", "exact current source public key")
	fs.Var(&sourceWalletVersion, "expected-source-wallet-version", "required current source wallet version")
	fs.Var(&sourcePolicyVersion, "expected-source-policy-version", "required current source policy version")
	if err := parseSignerAdminFlags(fs, args); err != nil {
		return err
	}
	if !sourceWalletVersion.set || !sourcePolicyVersion.set {
		return errors.New("--expected-source-wallet-version and --expected-source-policy-version are required")
	}
	if _, err := requireSignerAdminControlSocket(common.controlSocket); err != nil {
		return err
	}
	var err error
	if sourceWalletID, err = validateSignerAdminWalletID(sourceWalletID); err != nil {
		return err
	}
	if successorWalletID, err = validateSignerAdminWalletID(successorWalletID); err != nil {
		return fmt.Errorf("invalid --successor-wallet-id: %w", err)
	}
	if sourceWalletID == successorWalletID {
		return errors.New("--successor-wallet-id must differ from --wallet-id")
	}
	if sourcePublicKey, err = validateSignerAdminPublicKeyV2(sourcePublicKey, "--expected-source-public-key"); err != nil {
		return err
	}
	body := signerWalletRotationCreateRequestV2{
		SuccessorWalletID:           successorWalletID,
		ExpectedSourcePublicKey:     sourcePublicKey,
		ExpectedSourceWalletVersion: sourceWalletVersion.value,
		ExpectedSourcePolicyVersion: sourcePolicyVersion.value,
	}
	return callAndWriteSignerAdmin(common.controlSocket, "v2.wallet.rotation.create", sourceWalletID, body, stdout)
}

func runSignerAdminWalletRotationStatus(args []string, stdout io.Writer) error {
	fs, common := newSignerAdminFlagSet("wallet rotation-status")
	var sourceWalletID string
	fs.StringVar(&sourceWalletID, "wallet-id", "", "normalized source wallet identifier")
	if err := parseSignerAdminFlags(fs, args); err != nil {
		return err
	}
	if _, err := requireSignerAdminControlSocket(common.controlSocket); err != nil {
		return err
	}
	var err error
	if sourceWalletID, err = validateSignerAdminWalletID(sourceWalletID); err != nil {
		return err
	}
	return callAndWriteSignerAdmin(common.controlSocket, "v2.wallet.rotation.status", sourceWalletID, nil, stdout)
}

func runSignerAdminWalletRotationCommit(args []string, stdout io.Writer) error {
	fs, common := newSignerAdminFlagSet("wallet rotation-commit")
	var sourceWalletID, successorWalletID, rotationID, sourcePublicKey, successorPublicKey string
	var sourceWalletVersion, sourcePolicyVersion signerAdminRequiredUint64
	var successorWalletVersion, successorPolicyVersion, rotationVersion signerAdminRequiredUint64
	fs.StringVar(&sourceWalletID, "wallet-id", "", "normalized source wallet identifier")
	fs.StringVar(&successorWalletID, "successor-wallet-id", "", "exact successor wallet identifier")
	fs.StringVar(&rotationID, "rotation-id", "", "exact prepared rotation digest")
	fs.StringVar(&sourcePublicKey, "expected-source-public-key", "", "exact current source public key")
	fs.StringVar(&successorPublicKey, "expected-successor-public-key", "", "exact current successor public key")
	fs.Var(&sourceWalletVersion, "expected-source-wallet-version", "required current source wallet version")
	fs.Var(&sourcePolicyVersion, "expected-source-policy-version", "required current source policy version")
	fs.Var(&successorWalletVersion, "expected-successor-wallet-version", "required current successor wallet version")
	fs.Var(&successorPolicyVersion, "expected-successor-policy-version", "required current successor policy version")
	fs.Var(&rotationVersion, "expected-rotation-version", "required current rotation version")
	if err := parseSignerAdminFlags(fs, args); err != nil {
		return err
	}
	if !sourceWalletVersion.set || !sourcePolicyVersion.set || !successorWalletVersion.set ||
		!successorPolicyVersion.set || !rotationVersion.set {
		return errors.New("all expected source, successor, policy, and rotation version flags are required")
	}
	if _, err := requireSignerAdminControlSocket(common.controlSocket); err != nil {
		return err
	}
	var err error
	if sourceWalletID, err = validateSignerAdminWalletID(sourceWalletID); err != nil {
		return err
	}
	if successorWalletID, err = validateSignerAdminWalletID(successorWalletID); err != nil {
		return fmt.Errorf("invalid --successor-wallet-id: %w", err)
	}
	if sourcePublicKey, err = validateSignerAdminPublicKeyV2(sourcePublicKey, "--expected-source-public-key"); err != nil {
		return err
	}
	if successorPublicKey, err = validateSignerAdminPublicKeyV2(successorPublicKey, "--expected-successor-public-key"); err != nil {
		return err
	}
	if rotationID, err = normalizeSHA256DigestV2(rotationID, "--rotation-id"); err != nil {
		return err
	}
	body := signerWalletRotationCommitRequestV2{
		RotationID:                     rotationID,
		SuccessorWalletID:              successorWalletID,
		ExpectedSourcePublicKey:        sourcePublicKey,
		ExpectedSuccessorPublicKey:     successorPublicKey,
		ExpectedSourceWalletVersion:    sourceWalletVersion.value,
		ExpectedSourcePolicyVersion:    sourcePolicyVersion.value,
		ExpectedSuccessorWalletVersion: successorWalletVersion.value,
		ExpectedSuccessorPolicyVersion: successorPolicyVersion.value,
		ExpectedRotationVersion:        rotationVersion.value,
	}
	return callAndWriteSignerAdmin(common.controlSocket, "v2.wallet.rotation.commit", sourceWalletID, body, stdout)
}

func runSignerAdminPolicyGet(args []string, stdout io.Writer) error {
	fs, common := newSignerAdminFlagSet("policy get")
	var walletID string
	fs.StringVar(&walletID, "wallet-id", "", "normalized wallet identifier")
	if err := parseSignerAdminFlags(fs, args); err != nil {
		return err
	}
	if _, err := requireSignerAdminControlSocket(common.controlSocket); err != nil {
		return err
	}
	walletID, err := validateSignerAdminWalletID(walletID)
	if err != nil {
		return err
	}
	return callAndWriteSignerAdmin(common.controlSocket, "v2.policy.get", walletID, nil, stdout)
}

func runSignerAdminPolicyPut(args []string, stdout io.Writer) error {
	fs, common := newSignerAdminFlagSet("policy put")
	var walletID, policyFile string
	var expected signerAdminRequiredUint64
	fs.StringVar(&walletID, "wallet-id", "", "normalized wallet identifier")
	fs.StringVar(&policyFile, "policy-file", "", "absolute strict policy JSON path")
	fs.Var(&expected, "expected-version", "required current policy version")
	if err := parseSignerAdminFlags(fs, args); err != nil {
		return err
	}
	if !expected.set {
		return errors.New("--expected-version is required")
	}
	if _, err := requireSignerAdminControlSocket(common.controlSocket); err != nil {
		return err
	}
	walletID, err := validateSignerAdminWalletID(walletID)
	if err != nil {
		return err
	}
	policy, err := loadSignerAdminPolicy(policyFile, walletID)
	if err != nil {
		return err
	}
	body := signerPolicyPutRequestV2{ExpectedVersion: expected.value, Policy: policy}
	return callAndWriteSignerAdmin(common.controlSocket, "v2.policy.put", walletID, body, stdout)
}

func runSignerAdminNetworkGet(args []string, stdout io.Writer) error {
	fs, common := newSignerAdminFlagSet("network get")
	var walletID string
	fs.StringVar(&walletID, "wallet-id", "", "normalized wallet identifier")
	if err := parseSignerAdminFlags(fs, args); err != nil {
		return err
	}
	if _, err := requireSignerAdminControlSocket(common.controlSocket); err != nil {
		return err
	}
	walletID, err := validateSignerAdminWalletID(walletID)
	if err != nil {
		return err
	}
	result, err := callSignerAdmin(common.controlSocket, "v2.network.get", walletID, nil)
	if err != nil {
		return err
	}
	return writeSignerAdminNetworkSummaryV2(result, walletID, stdout)
}

func runSignerAdminNetworkPut(args []string, stdin io.Reader, stdout io.Writer) error {
	fs, common := newSignerAdminFlagSet("network put")
	var walletID string
	fs.StringVar(&walletID, "wallet-id", "", "normalized wallet identifier")
	if err := parseSignerAdminFlags(fs, args); err != nil {
		return err
	}
	if _, err := requireSignerAdminControlSocket(common.controlSocket); err != nil {
		return err
	}
	walletID, err := validateSignerAdminWalletID(walletID)
	if err != nil {
		return err
	}
	raw, err := io.ReadAll(io.LimitReader(stdin, maxSignerNetworkInputBytesV2+1))
	if err != nil {
		return errors.New("read signer network configuration from stdin")
	}
	defer zeroBytes(raw)
	if len(raw) == 0 || len(raw) > maxSignerNetworkInputBytesV2 {
		return errors.New("stdin must contain one strict signer network JSON object within the size limit")
	}
	var body signerNetworkPutRequestV2
	if err := decodeSignerNetworkPutRequestV2(raw, &body); err != nil {
		return errors.New("stdin must contain one strict signer network JSON object")
	}
	if body.ExpectedVersion == nil {
		return errors.New("signer network expectedVersion is required on stdin")
	}
	normalized, err := normalizeSignerNetworkInputV2(body)
	if err != nil {
		return err
	}
	body.PrimaryRPCURL = normalized.PrimaryRPCURL
	body.ExecutionFallbackRPCURL = normalized.ExecutionFallbackRPCURL
	body.VerificationRPCURL = normalized.VerificationRPCURL
	body.LegacyFallbackRPCURL = ""
	defer func() {
		body.PrimaryRPCURL = ""
		body.ExecutionFallbackRPCURL = ""
		body.VerificationRPCURL = ""
		body.LegacyFallbackRPCURL = ""
	}()
	result, err := callSignerAdminSensitiveV2(common.controlSocket, "v2.network.put", walletID, body)
	if err != nil {
		return err
	}
	return writeSignerAdminNetworkSummaryV2(result, walletID, stdout)
}

func writeSignerAdminNetworkSummaryV2(result json.RawMessage, walletID string, stdout io.Writer) error {
	var summary signerNetworkSummaryV2
	if err := decodeSignerAdminStrictJSON(result, &summary); err != nil {
		return errors.New("signer returned an invalid network summary")
	}
	if err := validateSignerNetworkSummaryV2(summary, walletID); err != nil {
		return errors.New("signer returned an invalid network summary")
	}
	encoded, err := json.Marshal(summary)
	if err != nil {
		return errors.New("encode signer network summary")
	}
	return writeSignerAdminResult(encoded, stdout)
}

func runSignerAdminWebAuthnRegistrationBegin(args []string, stdout io.Writer) error {
	fs, common := newSignerAdminFlagSet("webauthn registration begin")
	var label string
	fs.StringVar(&label, "label", "", "human-readable authenticator label")
	if err := parseSignerAdminFlags(fs, args); err != nil {
		return err
	}
	if _, err := requireSignerAdminControlSocket(common.controlSocket); err != nil {
		return err
	}
	body := signerWebAuthnRegistrationBeginRequestV2{Label: label}
	return callAndWriteSignerAdmin(common.controlSocket, "v2.webauthn.registration.begin", "", body, stdout)
}

func runSignerAdminWebAuthnRegistrationFinish(args []string, stdout io.Writer) error {
	fs, common := newSignerAdminFlagSet("webauthn registration finish")
	var requestFile string
	fs.StringVar(&requestFile, "request-file", "", "absolute registration response JSON path")
	if err := parseSignerAdminFlags(fs, args); err != nil {
		return err
	}
	if _, err := requireSignerAdminControlSocket(common.controlSocket); err != nil {
		return err
	}
	raw, err := readSignerAdminJSONFile(requestFile, maxSignerAdminResponseBytes)
	if err != nil {
		return fmt.Errorf("read WebAuthn registration response file: %w", err)
	}
	defer zeroBytes(raw)
	var body signerWebAuthnRegistrationFinishRequestV2
	if err := decodeSignerAdminStrictJSON(raw, &body); err != nil {
		return errors.New("WebAuthn registration response must be one strict JSON object")
	}
	if strings.TrimSpace(body.ChallengeID) == "" || len(body.Credential) == 0 || !json.Valid(body.Credential) {
		return errors.New("WebAuthn registration response requires challengeId and credential")
	}
	return callAndWriteSignerAdmin(common.controlSocket, "v2.webauthn.registration.finish", "", body, stdout)
}

func runSignerAdminWebAuthnCredentialsList(args []string, stdout io.Writer) error {
	fs, common := newSignerAdminFlagSet("webauthn credentials list")
	if err := parseSignerAdminFlags(fs, args); err != nil {
		return err
	}
	if _, err := requireSignerAdminControlSocket(common.controlSocket); err != nil {
		return err
	}
	return callAndWriteSignerAdmin(common.controlSocket, "v2.webauthn.credentials.list", "", nil, stdout)
}

func runSignerAdminWebAuthnCredentialsRevoke(args []string, stdout io.Writer) error {
	fs, common := newSignerAdminFlagSet("webauthn credentials revoke")
	var credentialID string
	var expectedCount, expectedVersion signerAdminRequiredUint64
	var confirmLastCredential bool
	fs.StringVar(&credentialID, "credential-id", "", "exact public credential identifier from credentials list")
	fs.Var(&expectedCount, "expected-count", "required current credential count")
	fs.Var(&expectedVersion, "expected-version", "required current credential-set version")
	fs.BoolVar(&confirmLastCredential, "confirm-last-credential", false, "explicitly allow removal of the final credential")
	if err := parseSignerAdminFlags(fs, args); err != nil {
		return err
	}
	if !expectedCount.set || !expectedVersion.set {
		return errors.New("--expected-count and --expected-version are required")
	}
	if _, err := requireSignerAdminControlSocket(common.controlSocket); err != nil {
		return err
	}
	credentialID, decoded, err := normalizeSignerWebAuthnCredentialIDV2(credentialID)
	if err != nil {
		return err
	}
	zeroBytes(decoded)
	body := signerWebAuthnCredentialRevokeRequestV2{
		CredentialID:          credentialID,
		ExpectedCount:         expectedCount.value,
		ExpectedVersion:       expectedVersion.value,
		ConfirmLastCredential: confirmLastCredential,
	}
	return callAndWriteSignerAdmin(common.controlSocket, "v2.webauthn.credentials.revoke", "", body, stdout)
}

func readSignerAdminJSONFile(path string, maxBytes int64) ([]byte, error) {
	path = strings.TrimSpace(path)
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("JSON file path must be absolute and clean")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, errors.New("JSON file must be a regular non-symlink file")
	}
	if info.Mode().Perm()&0o022 != 0 {
		return nil, errors.New("JSON file must not be group/world writable")
	}
	if info.Size() <= 0 || info.Size() > maxBytes {
		return nil, errors.New("JSON file has invalid size")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !os.SameFile(info, openedInfo) || !openedInfo.Mode().IsRegular() {
		return nil, errors.New("JSON file changed while opening")
	}
	if stat, ok := openedInfo.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != 0 && int(stat.Uid) != os.Geteuid() {
		return nil, errors.New("JSON file must be owned by root or the signer admin user")
	}
	raw, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > maxBytes {
		zeroBytes(raw)
		return nil, errors.New("JSON file is too large")
	}
	return raw, nil
}

func decodeSignerAdminStrictJSON(raw []byte, out any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON data")
	}
	return nil
}

func readSignerAdminSolanaKeypair(stdin io.Reader) ([]byte, error) {
	raw, err := io.ReadAll(io.LimitReader(stdin, maxSignerImportBytesV2+1))
	if err != nil {
		return nil, errors.New("read Solana keypair from stdin")
	}
	defer zeroBytes(raw)
	if len(raw) == 0 || len(raw) > maxSignerImportBytesV2 {
		return nil, errors.New("stdin must contain one 64-byte Solana CLI keypair JSON array")
	}
	var values []int
	if err := decodeSignerAdminStrictJSON(raw, &values); err != nil || len(values) != ed25519.PrivateKeySize {
		return nil, errors.New("stdin must contain one 64-byte Solana CLI keypair JSON array")
	}
	defer func() {
		for i := range values {
			values[i] = 0
		}
	}()
	secret := make([]byte, ed25519.PrivateKeySize)
	for i, value := range values {
		if value < 0 || value > 255 {
			zeroBytes(secret)
			return nil, errors.New("stdin Solana keypair contains an invalid byte")
		}
		secret[i] = byte(value)
	}
	if !validateSolanaCLIPrivateKeyV2(secret) {
		zeroBytes(secret)
		return nil, errors.New("stdin Solana keypair public key does not match its private seed")
	}
	canonical, err := json.Marshal(values)
	zeroBytes(secret)
	if err != nil {
		return nil, errors.New("encode staged Solana keypair")
	}
	return canonical, nil
}

func writeSignerAdminImportFile(socket signerAdminSocketInfo, canonical []byte) (string, error) {
	directory := filepath.Join(filepath.Dir(socket.path), ".admin-import")
	if err := os.Mkdir(directory, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return "", fmt.Errorf("create signer import directory: %w", err)
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return "", fmt.Errorf("inspect signer import directory: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", errors.New("signer import directory must be a non-symlink directory")
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Geteuid() {
		return "", errors.New("signer import directory must be owned by the signer admin user")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return "", errors.New("signer import directory must not be group/world accessible")
	}
	for attempt := 0; attempt < 8; attempt++ {
		random := make([]byte, 16)
		if _, err := rand.Read(random); err != nil {
			return "", errors.New("generate signer import filename")
		}
		name := ".wallet-import-" + hex.EncodeToString(random) + ".json"
		zeroBytes(random)
		path := filepath.Join(directory, name)
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return "", fmt.Errorf("create signer-owned import file: %w", err)
		}
		writeErr := writeAndSyncSignerAdminFile(file, canonical)
		if writeErr == nil {
			writeErr = syncSignerAdminDirectory(directory)
		}
		if writeErr != nil {
			_ = os.Remove(path)
			return "", writeErr
		}
		return path, nil
	}
	return "", errors.New("could not allocate an exclusive signer import file")
}

func writeAndSyncSignerAdminFile(file *os.File, data []byte) error {
	written := 0
	for written < len(data) {
		n, err := file.Write(data[written:])
		if err != nil {
			_ = file.Close()
			return errors.New("write signer-owned import file")
		}
		if n == 0 {
			_ = file.Close()
			return io.ErrShortWrite
		}
		written += n
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return errors.New("sync signer-owned import file")
	}
	if err := file.Close(); err != nil {
		return errors.New("close signer-owned import file")
	}
	return nil
}

func syncSignerAdminDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return errors.New("open signer import directory for sync")
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return errors.New("sync signer import directory")
	}
	return nil
}

func cleanupSignerAdminImportFile(path string) error {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	err := os.Remove(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.New("remove signer-owned import file")
	}
	return syncSignerAdminDirectory(filepath.Dir(path))
}

func callAndWriteSignerAdmin(controlSocket, op, walletID string, body any, stdout io.Writer) error {
	result, err := callSignerAdmin(controlSocket, op, walletID, body)
	if err != nil {
		return err
	}
	return writeSignerAdminResult(result, stdout)
}

func writeSignerAdminResult(result json.RawMessage, stdout io.Writer) error {
	var formatted bytes.Buffer
	if err := json.Indent(&formatted, result, "", "  "); err != nil {
		return errors.New("signer returned an invalid result")
	}
	formatted.WriteByte('\n')
	if err := writeSignerAdminAll(stdout, formatted.Bytes()); err != nil {
		return errors.New("write signer admin result")
	}
	return nil
}

func callSignerAdmin(controlSocket, op, walletID string, body any) (json.RawMessage, error) {
	return callSignerAdminWithSensitivityV2(controlSocket, op, walletID, body, false)
}

func callSignerAdminSensitiveV2(controlSocket, op, walletID string, body any) (json.RawMessage, error) {
	return callSignerAdminWithSensitivityV2(controlSocket, op, walletID, body, true)
}

func callSignerAdminWithSensitivityV2(controlSocket, op, walletID string, body any, sensitive bool) (json.RawMessage, error) {
	socket, err := requireSignerAdminControlSocket(controlSocket)
	if err != nil {
		return nil, err
	}
	req := request{Op: op, WalletID: walletID}
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, errors.New("encode signer admin request")
		}
		if sensitive {
			defer zeroBytes(encoded)
		}
		req.Request = encoded
	}
	encoded, err := json.Marshal(req)
	if err != nil {
		return nil, errors.New("encode signer admin envelope")
	}
	if len(encoded) > maxSignerRequestBytes {
		return nil, errors.New("signer admin request is too large")
	}
	if sensitive {
		defer zeroBytes(encoded)
	}

	dialer := net.Dialer{Timeout: signerAdminSocketTimeout}
	conn, err := dialer.Dial("unix", socket.path)
	if err != nil {
		return nil, errors.New("connect to signer control socket")
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(signerAdminSocketTimeout))
	payload := append(encoded, '\n')
	if sensitive {
		defer zeroBytes(payload)
	}
	if err := writeSignerAdminAll(conn, payload); err != nil {
		return nil, errors.New("write signer control request")
	}
	line, err := readRequestLine(bufio.NewReader(conn), maxSignerAdminResponseBytes)
	if err != nil {
		return nil, errors.New("read signer control response; query state before retrying any mutating command")
	}
	var response signerAdminResponse
	if err := decodeSignerAdminStrictJSON(bytesTrimNewline(line), &response); err != nil {
		return nil, errors.New("signer control response was not a strict protocol envelope")
	}
	if !response.OK {
		message := strings.TrimSpace(response.Error)
		if message == "" {
			message = "signer rejected the administrative request"
		}
		return nil, errors.New(message)
	}
	if len(response.Result) == 0 || !json.Valid(response.Result) {
		return nil, errors.New("signer control response did not include a valid result")
	}
	return response.Result, nil
}

func writeSignerAdminAll(writer io.Writer, data []byte) error {
	written := 0
	for written < len(data) {
		n, err := writer.Write(data[written:])
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		written += n
	}
	return nil
}
