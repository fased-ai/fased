package platform

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"syscall"
)

var aclEntryPattern = regexp.MustCompile(`^(?:default:)?(?:user|group|mask|other):(?:[0-9]+)?:[rwx-]{3}$`)

func (acl *LinuxACL) HasExactTraversal(snapshot ACLSnapshot, gatewayUID uint32) (bool, error) {
	if gatewayUID == 0 || len(snapshot.entries) == 0 {
		return false, errors.New("ACL traversal inspection inputs are invalid")
	}
	permissions, exists := snapshot.entries["user:"+strconv.FormatUint(uint64(gatewayUID), 10)+":"]
	if !exists {
		return false, nil
	}
	if permissions != "--x" {
		return false, errors.New("existing Gateway owner-home ACL is broader than traversal")
	}
	return true, nil
}

type LinuxACL struct {
	getfacl, setfacl string
	runner           ACLCommandRunner
}

func NewLinuxACL() (*LinuxACL, error) {
	commands := map[string]string{}
	for name, candidates := range map[string][]string{
		"getfacl": {"/usr/bin/getfacl", "/bin/getfacl"},
		"setfacl": {"/usr/bin/setfacl", "/bin/setfacl"},
	} {
		for _, path := range candidates {
			info, err := os.Lstat(path)
			if err != nil {
				continue
			}
			stat, ok := info.Sys().(*syscall.Stat_t)
			if !ok || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o022 != 0 || info.Mode().Perm()&0o111 == 0 || stat.Uid != 0 {
				return nil, fmt.Errorf("ACL command %s is unsafe", path)
			}
			commands[name] = path
			break
		}
		if commands[name] == "" {
			return nil, fmt.Errorf("ACL support is unavailable: required %s command is missing", name)
		}
	}
	return &LinuxACL{getfacl: commands["getfacl"], setfacl: commands["setfacl"], runner: execACLRunner{}}, nil
}

func (acl *LinuxACL) Capture(ctx context.Context, directory string) (ACLSnapshot, error) {
	if acl == nil || acl.runner == nil || acl.getfacl == "" {
		return ACLSnapshot{}, errors.New("ACL support is unavailable before mutation")
	}
	output, err := acl.runner.Run(ctx, acl.getfacl, []string{"--absolute-names", "--numeric", "--", directory}, nil)
	if err != nil {
		return ACLSnapshot{}, err
	}
	entries, err := parseACL(output)
	if err != nil {
		return ACLSnapshot{}, err
	}
	return ACLSnapshot{raw: append([]byte(nil), output...), entries: entries}, nil
}

func (acl *LinuxACL) GrantTraversal(ctx context.Context, directory string, gatewayUID uint32, original ACLSnapshot) error {
	if gatewayUID == 0 || len(original.entries) == 0 {
		return errors.New("ACL traversal grant inputs are invalid")
	}
	key := "user:" + strconv.FormatUint(uint64(gatewayUID), 10) + ":"
	if _, exists := original.entries[key]; exists {
		return errors.New("Gateway UID collides with an existing owner-home ACL entry")
	}
	mask, hasMask := original.entries["mask::"]
	if hasMask && !strings.HasSuffix(mask, "x") {
		return errors.New("owner-home ACL mask blocks isolated Gateway traversal")
	}
	arguments := []string{}
	if hasMask {
		arguments = append(arguments, "--no-mask")
	}
	arguments = append(arguments, "--modify", key+"--x", "--", directory)
	if _, err := acl.runner.Run(ctx, acl.setfacl, arguments, nil); err != nil {
		return err
	}
	current, err := acl.Capture(ctx, directory)
	if err != nil {
		return err
	}
	if current.entries[key] != "--x" {
		return errors.New("Gateway did not receive exact owner-home traversal")
	}
	for originalKey, permissions := range original.entries {
		if current.entries[originalKey] != permissions {
			return errors.New("owner-home ACL changed an existing entry")
		}
	}
	for currentKey := range current.entries {
		if _, existed := original.entries[currentKey]; existed || currentKey == key || (!hasMask && currentKey == "mask::") {
			continue
		}
		return errors.New("owner-home ACL gained an unexpected entry")
	}
	return nil
}

func (acl *LinuxACL) Restore(ctx context.Context, directory string, snapshot ACLSnapshot) error {
	if len(snapshot.raw) == 0 || len(snapshot.entries) == 0 {
		return errors.New("ACL rollback snapshot is invalid")
	}
	if _, err := acl.runner.Run(ctx, acl.setfacl, []string{"--restore=-"}, snapshot.raw); err != nil {
		return err
	}
	current, err := acl.Capture(ctx, directory)
	if err != nil {
		return err
	}
	if !sameACL(current.entries, snapshot.entries) {
		return errors.New("owner-home ACL was not restored exactly")
	}
	return nil
}

func parseACL(data []byte) (map[string]string, error) {
	entries := map[string]string{}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if index := strings.Index(line, "\t#effective:"); index >= 0 {
			line = line[:index]
		}
		if !aclEntryPattern.MatchString(line) {
			return nil, errors.New("owner-home ACL contains an unsupported entry")
		}
		separator := strings.LastIndex(line, ":")
		key, permissions := line[:separator+1], line[separator+1:]
		if _, exists := entries[key]; exists {
			return nil, errors.New("owner-home ACL contains a duplicate entry")
		}
		entries[key] = permissions
		if len(entries) > 512 {
			return nil, errors.New("owner-home ACL is unexpectedly large")
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	for _, required := range []string{"user::", "group::", "other::"} {
		if _, exists := entries[required]; !exists {
			return nil, errors.New("owner-home ACL is incomplete")
		}
	}
	return entries, nil
}
