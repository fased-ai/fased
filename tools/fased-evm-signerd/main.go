package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "fased-evm-signerd:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return errors.New("command is required: init, create, import, list, revoke, recovery-export, recovery-import, raw-export, or serve")
	}
	switch args[0] {
	case "init":
		flags, state, master := commonFlags("init")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		return initializeStore(*state, *master)
	case "create":
		flags, state, master := commonFlags("create")
		role := flags.String("role", "", "agent-service or strategy")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		secret, err := generatePrivateKey()
		if err != nil {
			return err
		}
		defer zeroBytes(secret)
		return withStore(*state, *master, func(store *walletStore) error {
			wallet, err := store.create(*role, secret)
			return printJSON(wallet, err)
		})
	case "import":
		flags, state, master := commonFlags("import")
		role := flags.String("role", "", "agent-service or strategy")
		input := flags.String("private-key-file", "", "owner-only 0x-prefixed 32-byte private-key file")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		secret, err := readHexPrivateKey(*input)
		if err != nil {
			return err
		}
		defer zeroBytes(secret)
		return withStore(*state, *master, func(store *walletStore) error {
			wallet, err := store.create(*role, secret)
			return printJSON(wallet, err)
		})
	case "list":
		flags, state, master := commonFlags("list")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		return withStore(*state, *master, func(store *walletStore) error {
			wallets, err := store.list()
			return printJSON(wallets, err)
		})
	case "revoke":
		flags, state, master := commonFlags("revoke")
		role := flags.String("role", "", "agent-service or strategy")
		generation := flags.Uint64("expected-generation", 0, "exact current generation")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		return withStore(*state, *master, func(store *walletStore) error {
			wallet, err := store.revoke(*role, *generation)
			return printJSON(wallet, err)
		})
	case "recovery-export":
		return runRecoveryExport(args[1:])
	case "recovery-import":
		return runRecoveryImport(args[1:])
	case "raw-export":
		return runRawExport(args[1:])
	case "serve":
		flags, state, master := commonFlags("serve")
		socket := flags.String("socket", "", "absolute application socket path")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if !filepath.IsAbs(*socket) {
			return errors.New("application socket path must be absolute")
		}
		return withStore(*state, *master, func(store *walletStore) error { return serveSocket(store, *socket) })
	default:
		return errors.New("unknown command")
	}
}

func commonFlags(name string) (*flag.FlagSet, *string, *string) {
	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	state := flags.String("state", "", "absolute EVM signer state database path")
	master := flags.String("master-key", "", "absolute EVM signer master-key path")
	return flags, state, master
}

func withStore(state, master string, operation func(*walletStore) error) error {
	if !filepath.IsAbs(state) || !filepath.IsAbs(master) {
		return errors.New("state and master-key paths must be absolute")
	}
	store, err := openStore(state, master)
	if err != nil {
		return err
	}
	defer store.close()
	return operation(store)
}

func printJSON(value any, err error) error {
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}

func readHexPrivateKey(path string) ([]byte, error) {
	info, err := os.Lstat(filepath.Clean(path))
	if err != nil {
		return nil, err
	}
	if err := requireOwnerRegularFile(info, "EVM private-key import"); err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		return nil, err
	}
	defer zeroBytes(raw)
	value := bytes.TrimSpace(raw)
	if !bytes.HasPrefix(value, []byte("0x")) || len(value) != 66 {
		return nil, errors.New("EVM private-key import must be exact 0x-prefixed hex")
	}
	secret := make([]byte, privateKeyBytes)
	_, err = hex.Decode(secret, value[2:])
	if err != nil || validatePrivateKey(secret) != nil {
		zeroBytes(secret)
		return nil, errors.New("EVM private-key import is invalid")
	}
	return secret, nil
}

func runRecoveryExport(args []string) error {
	flags, state, master := commonFlags("recovery-export")
	role := flags.String("role", "", "agent-service or strategy")
	generation := flags.Uint64("expected-generation", 0, "exact current generation")
	passwordFile := flags.String("password-file", "", "owner-only password file")
	output := flags.String("output", "", "new owner-only recovery package")
	if err := flags.Parse(args); err != nil {
		return err
	}
	password, err := readPassword(*passwordFile)
	if err != nil {
		return err
	}
	defer zeroBytes(password)
	return withStore(*state, *master, func(store *walletStore) error {
		record, err := store.get(*role)
		if err != nil || record.RevokedAt != "" {
			return errors.New("active EVM wallet is unavailable")
		}
		if *generation == 0 || record.Generation != *generation {
			return errors.New("EVM wallet generation changed")
		}
		secret, err := decryptSecret(store.masterKey, record)
		if err != nil {
			return err
		}
		defer zeroBytes(secret)
		pkg, err := makeRecoveryPackage(record, secret, password)
		if err != nil {
			return err
		}
		return writeOwnerJSON(*output, pkg)
	})
}

func runRecoveryImport(args []string) error {
	flags, state, master := commonFlags("recovery-import")
	passwordFile := flags.String("password-file", "", "owner-only password file")
	input := flags.String("recovery-file", "", "owner-only recovery package")
	if err := flags.Parse(args); err != nil {
		return err
	}
	password, err := readPassword(*passwordFile)
	if err != nil {
		return err
	}
	defer zeroBytes(password)
	raw, err := readOwnerBoundedFile(*input, 16<<10)
	if err != nil {
		return errors.New("read bounded EVM recovery package")
	}
	defer zeroBytes(raw)
	pkg, err := decodeRecoveryPackage(raw)
	if err != nil {
		return err
	}
	secret, err := openRecoveryPackage(pkg, password)
	if err != nil {
		return err
	}
	defer zeroBytes(secret)
	return withStore(*state, *master, func(store *walletStore) error {
		wallet, err := store.restore(pkg, secret)
		return printJSON(wallet, err)
	})
}

func runRawExport(args []string) error {
	flags, state, master := commonFlags("raw-export")
	role := flags.String("role", "", "agent-service or strategy")
	generation := flags.Uint64("expected-generation", 0, "exact current generation")
	output := flags.String("output", "", "new owner-only raw private-key file")
	acknowledge := flags.Bool("acknowledge-custody-reduction", false, "acknowledge creation of a portable hot-wallet secret")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if !*acknowledge {
		return errors.New("raw export requires --acknowledge-custody-reduction")
	}
	return withStore(*state, *master, func(store *walletStore) error {
		record, err := store.get(*role)
		if err != nil || record.RevokedAt != "" {
			return errors.New("active EVM wallet is unavailable")
		}
		if *generation == 0 || record.Generation != *generation {
			return errors.New("EVM wallet generation changed")
		}
		secret, err := decryptSecret(store.masterKey, record)
		if err != nil {
			return err
		}
		defer zeroBytes(secret)
		raw := make([]byte, 2+hex.EncodedLen(len(secret))+1)
		copy(raw, "0x")
		hex.Encode(raw[2:len(raw)-1], secret)
		raw[len(raw)-1] = '\n'
		defer zeroBytes(raw)
		return writeOwnerFile(*output, raw)
	})
}

func readPassword(path string) ([]byte, error) {
	raw, err := readOwnerBoundedFile(path, 1026)
	if err != nil {
		return nil, err
	}
	password := bytes.TrimRight(raw, "\r\n")
	if len(password) < 12 || len(password) > 1024 {
		zeroBytes(password)
		return nil, errors.New("recovery password must contain 12 to 1024 bytes")
	}
	return password, nil
}

func writeOwnerJSON(path string, value any) error {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	defer zeroBytes(raw)
	return writeOwnerFile(path, raw)
}

func writeOwnerFile(path string, raw []byte) error {
	if !filepath.IsAbs(path) {
		return errors.New("output path must be absolute")
	}
	if err := validateNewPath(path); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(filepath.Clean(path)), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(filepath.Clean(path), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(raw); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}
