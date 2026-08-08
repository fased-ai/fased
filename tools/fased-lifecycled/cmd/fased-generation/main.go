package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"fased-lifecycled/bundle"
	"fased-lifecycled/model"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "fased-generation: %s\n", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	flags := flag.NewFlagSet("fased-generation", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	var root, version, commit, tree, output string
	flags.StringVar(&root, "root", "", "generation payload root")
	flags.StringVar(&version, "version", "", "release version")
	flags.StringVar(&commit, "commit", "", "full source commit")
	flags.StringVar(&tree, "tree", "", "full source tree")
	flags.StringVar(&output, "output", "", "inventory output path")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || root == "" || version == "" || commit == "" || tree == "" || output == "" {
		return errors.New("root, version, commit, tree, and output are required")
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	inventory, generation, err := bundle.Inspect(absRoot, version, commit, tree, map[string]uint32{
		"federation":     2,
		"managedInstall": 2,
		"mining":         1,
		"signer":         2,
		"walletRegistry": 1,
	}, model.CapabilityRanges{
		Supervisor: model.CapabilityRange{Min: 1, Max: 1},
		Controller: model.CapabilityRange{Min: 1, Max: 1},
		Migrator:   model.CapabilityRange{Min: 1, Max: 1},
		Signer:     model.CapabilityRange{Min: 2, Max: 2},
	})
	if err != nil {
		return err
	}
	data, err := bundle.CanonicalInventoryJSON(inventory)
	if err != nil {
		return err
	}
	absOutput, err := filepath.Abs(output)
	if err != nil {
		return err
	}
	if filepath.Dir(absOutput) == absRoot || filepath.Dir(absOutput) == filepath.Join(absRoot, "payload") {
		return errors.New("inventory output must be outside the inventoried payload")
	}
	if err := os.WriteFile(absOutput, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(generation)
}
