package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"fased-lifecycled/trust"
)

func main() {
	if err := run(os.Args[1:], os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "fased-release-index:", err)
		os.Exit(1)
	}
}

func run(args []string, stderr io.Writer) error {
	flags := flag.NewFlagSet("fased-release-index", flag.ContinueOnError)
	flags.SetOutput(stderr)
	var input, output string
	flags.StringVar(&input, "input", "", "release-index JSON")
	flags.StringVar(&output, "output", "", "canonical release-index artifact")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || input == "" || output == "" {
		return errors.New("--input and --output are required")
	}
	indexJSON, err := os.ReadFile(input)
	if err != nil {
		return err
	}
	index, err := trust.DecodeReleaseIndex(indexJSON)
	if err != nil {
		return fmt.Errorf("release index: %w", err)
	}
	canonical, err := trust.EncodeReleaseIndex(index)
	if err != nil {
		return err
	}
	return writeAtomic(output, canonical)
}

func writeAtomic(path string, data []byte) error {
	directoryPath := filepath.Dir(path)
	temp, err := os.CreateTemp(directoryPath, ".release-index-*")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0o644); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		return err
	}
	directory, err := os.Open(directoryPath)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
